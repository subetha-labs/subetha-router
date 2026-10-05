/**
 * 内部アドレスの上流を**警告する**（止めない）。**無課金・ネットワーク不使用。**
 *
 * これは SSRF 対策ではない: 上流 URL は設定値であり攻撃者は注入できない。
 * 守っているのは運用者の設定ミスで、検出と可視化で足りる（設計 §3.2）。
 */

import { describe, expect, it } from "vitest";

import { warnIfInternalUpstream } from "../../src/main.js";

function warningsFor(upstreams: Record<string, string>): string[] {
  const out: string[] = [];
  warnIfInternalUpstream(upstreams, (m) => out.push(m));
  return out;
}

describe("internal upstream warning", () => {
  it.each([
    ["loopback v4", "http://127.0.0.1:4042/x"],
    ["localhost", "http://localhost:8080/x"],
    ["loopback v6", "http://[::1]:8080/x"],
    ["private 10/8", "http://10.1.2.3/x"],
    ["private 192.168/16", "http://192.168.0.9/x"],
    ["private 172.16/12", "http://172.20.0.5/x"],
    ["link-local / metadata", "http://169.254.169.254/latest/meta-data"],
    ["internal TLD", "http://svc.internal/x"],
  ])("warns for %s", (_label, url) => {
    expect(warningsFor({ r1: url })).toHaveLength(1);
  });

  it.each([
    ["public host", "https://provider-x402.subethalabs.com/v1/eth/snapshot"],
    ["public v4", "http://93.184.216.34/x"],
    ["172.32 is public", "http://172.32.0.1/x"],
    // IPv6 の ULA 判定をホスト名に当てると、これらを**誤検知**する（自己検証で発見）。
    ["public host starting fc", "https://fcm.googleapis.com/x"],
    ["public host starting fd", "https://fd-cdn.example.com/x"],
    // IPv4 の prefix 判定をホスト名に当てると、これらを誤検知する。
    ["public host starting 10.", "https://10.example.com/x"],
    ["public host starting 127.", "https://127.example.org/x"],
    ["public host starting 192.168.", "https://192.168.example.com/x"],
    // ULA は fc00::/7。これらは第 1 ヘクステットが範囲外。
    ["fc::1 is outside fc00::/7", "http://[fc::1]/x"],
    ["fc0::1 is outside fc00::/7", "http://[fc0::1]/x"],
  ])("stays quiet for %s", (_label, url) => {
    expect(warningsFor({ r1: url })).toHaveLength(0);
  });

  it.each([
    ["ULA fd00::/8", "http://[fd00::1]/x"],
    ["link-local fe80::/10", "http://[fe80::1]/x"],
  ])("still warns for %s", (_label, url) => {
    expect(warningsFor({ r1: url })).toHaveLength(1);
  });

  it("names the route but never the URL or host", () => {
    const [warning] = warningsFor({ "md-live": "http://127.0.0.1:4042/secret-path?k=v" });
    expect(warning).toContain("md-live");
    expect(warning).not.toContain("127.0.0.1");
    expect(warning).not.toContain("secret-path");
  });

  it("warns once per offending route and skips malformed URLs", () => {
    expect(
      warningsFor({ a: "http://127.0.0.1/x", b: "https://example.com/x", c: "not-a-url" }),
    ).toHaveLength(1);
  });
});
