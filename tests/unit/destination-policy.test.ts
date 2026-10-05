/**
 * SSRF 防御 A の宛先ポリシー（設計 T-A1 / T-A2）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  classifyAddress,
  DENY4,
  DENY6,
  parseAddress,
  POLICY_VERSION,
} from "../../src/net/destination-policy.js";

const noInterfaces = (): readonly string[] => [];
const strict = { allowLoopback: false, interfaces: noInterfaces };
const fixture = { allowLoopback: true, interfaces: noInterfaces };

/** B のスクリプトから `DENY4` / `DENY6` を読む（表は B が正。T-A1）。 */
function tableFromEgressScript(name: "DENY4" | "DENY6"): string[] {
  const script = readFileSync("deploy/egress/subetha-egress", "utf8");
  const match = new RegExp(`^${name}="([^"]+)"`, "ms").exec(script);
  if (match === null) throw new Error(`${name} not found in deploy/egress/subetha-egress`);
  return match[1]!.split(/\s+/).filter((entry) => entry !== "");
}

describe("destination policy table (T-A1)", () => {
  it("A の表は B の DENY4 / DENY6 と集合として一致する（::ffff:0:0/96 だけは意味が違う: A は埋め込み IPv4 を分類する）", () => {
    expect(new Set(DENY4)).toEqual(new Set(tableFromEgressScript("DENY4")));
    expect(new Set(DENY6)).toEqual(new Set(tableFromEgressScript("DENY6")));
    expect(POLICY_VERSION).toMatch(/^a1\/iana-2025-10-09$/);
  });
});

describe("address classification (T-A2)", () => {
  const denied = (address: string, reason: string, options = strict): void => {
    const verdict = classifyAddress(address, options);
    expect(verdict, address).toEqual({ allowed: false, reason });
  };
  const allowed = (address: string, options = strict): void => {
    const verdict = classifyAddress(address, options);
    expect(verdict.allowed, address).toBe(true);
  };

  it("loopback は allowLoopback だけが許し、自アドレスより先に判定される", () => {
    denied("127.0.0.1", "loopback");
    denied("127.0.0.11", "loopback");
    denied("127.255.255.254", "loopback");
    denied("::1", "loopback");
    denied("[::1]", "loopback");
    allowed("127.0.0.1", fixture);
    allowed("::1", fixture);
    // loopback が interfaces に含まれていても own_address にはならない。
    const withLoopback = { allowLoopback: true, interfaces: () => ["127.0.0.1", "::1"] };
    allowed("127.0.0.1", withLoopback);
    denied("127.0.0.1", "loopback", { allowLoopback: false, interfaces: () => ["127.0.0.1"] });
  });

  it("自アドレスは公開 IP でも拒否され、fixture 例外でも許されない", () => {
    const own = { allowLoopback: true, interfaces: () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "172.30.0.2"] };
    denied("93.184.216.34", "own_address", own);
    denied("2606:2800:220:1:248:1893:25c8:1946", "own_address", own);
    denied("::ffff:93.184.216.34", "own_address", own); // mapped は埋め込みを分類
    allowed("93.184.216.35", own);
  });

  it("IANA special-purpose の各範囲（代表値と境界）", () => {
    const cases: Array<[string, string]> = [
      ["0.0.0.0", "unspecified"],
      ["0.255.255.255", "special_purpose"],
      ["10.0.0.1", "special_purpose"],
      ["10.255.255.255", "special_purpose"],
      ["11.0.0.0", "allowed"],
      ["100.64.0.1", "special_purpose"],
      ["100.127.255.255", "special_purpose"],
      ["100.128.0.0", "allowed"],
      ["169.254.169.254", "special_purpose"],
      ["172.16.0.1", "special_purpose"],
      ["172.31.255.255", "special_purpose"],
      ["172.32.0.0", "allowed"],
      ["192.0.0.9", "special_purpose"],
      ["192.0.2.1", "special_purpose"],
      ["192.88.99.1", "special_purpose"],
      ["192.168.1.1", "special_purpose"],
      ["198.18.0.1", "special_purpose"],
      ["198.19.255.255", "special_purpose"],
      ["198.20.0.0", "allowed"],
      ["198.51.100.7", "special_purpose"],
      ["203.0.113.7", "special_purpose"],
      ["224.0.0.1", "special_purpose"],
      ["239.255.255.255", "special_purpose"],
      ["240.0.0.1", "special_purpose"],
      ["255.255.255.255", "special_purpose"],
      ["8.8.8.8", "allowed"],
      ["1.1.1.1", "allowed"],
      ["::", "unspecified"],
      ["64:ff9b::808:808", "special_purpose"],
      ["64:ff9b:1::1", "special_purpose"],
      ["100::1", "special_purpose"],
      ["100:0:0:1::1", "special_purpose"],
      ["2001::1", "special_purpose"],
      ["2001:db8::1", "special_purpose"],
      ["2001:200::1", "allowed"],
      ["2002::1", "special_purpose"],
      ["3fff::1", "special_purpose"],
      ["5f00::1", "special_purpose"],
      ["fc00::1", "special_purpose"],
      ["fdff:ffff::1", "special_purpose"],
      ["fe80::1", "special_purpose"],
      ["fe80::1%eth0", "special_purpose"],
      ["fec0::1", "special_purpose"],
      ["ff02::1", "special_purpose"],
      ["2606:4700:4700::1111", "allowed"],
    ];
    for (const [address, expected] of cases) {
      const verdict = classifyAddress(address, strict);
      if (expected === "allowed") expect(verdict.allowed, address).toBe(true);
      else expect(verdict, address).toEqual({ allowed: false, reason: expected });
    }
  });

  it("IPv4-mapped IPv6 は埋め込みの IPv4 を分類する（B の一括拒否とは違う）", () => {
    denied("::ffff:127.0.0.1", "loopback");
    allowed("::ffff:127.0.0.1", fixture);
    denied("::ffff:10.0.0.1", "special_purpose");
    denied("::ffff:169.254.169.254", "special_purpose");
    allowed("::ffff:8.8.8.8");
    expect(parseAddress("::ffff:8.8.8.8")).toMatchObject({ family: 4, text: "8.8.8.8" });
    expect(parseAddress("::ffff:808:808")).toMatchObject({ family: 4, text: "8.8.8.8" });
  });

  it("不正な文字列は invalid", () => {
    for (const bad of ["", "localhost", "8.8.8", "8.8.8.256", "08.8.8.8", "1:2:3:4:5:6:7:8:9", ":::", "fe80:::1", "::ffff:1.2.3", "example.com"]) {
      denied(bad, "invalid");
      denied(bad, "invalid", fixture);
    }
  });
});
