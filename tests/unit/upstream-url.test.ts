/**
 * 動的上流 URL の検査（設計 `docs/dynamic-upstream-design.md` §2.2・§7.4、タスク T2）。
 * 純粋関数。**ネットワークに出る前に**拒否し、通ったものは呼び出し側が渡した文字列そのもの。
 */

import { expect, test } from "vitest";

import { denyHostsOf, MAX_UPSTREAM_URL_LENGTH, parseUpstreamUrl } from "../../src/net/upstream-url.js";

const NONE = { denyHosts: [] as string[] };

test("通る URL は、渡した文字列がそのまま唯一の表現になる（クエリは並べ替えない）", () => {
  for (const raw of [
    "https://api.example.com/v1/price",
    "https://api.example.com/",
    "https://api.example.com/v1/price?symbol=ETH&b=2&a=1",
    "https://api.example.com/a%2Fb/c?q=%E3%81%82",
    "https://xn--r8jz45g.example/path",
  ]) {
    const parsed = parseUpstreamUrl(raw, NONE);
    expect(parsed, raw).toEqual({ ok: true, url: raw, host: new URL(raw).hostname });
  }
});

test.each<[string, unknown, string]>([
  ["文字列でない", 42, "not_a_string"],
  ["空", "", "not_absolute"],
  ["相対", "/v1/price", "not_absolute"],
  ["長すぎる", `https://api.example.com/${"a".repeat(MAX_UPSTREAM_URL_LENGTH)}`, "too_long"],
  ["http", "http://api.example.com/v1", "scheme"],
  ["別の scheme", "ftp://api.example.com/v1", "scheme"],
  ["userinfo", "https://user:pass@api.example.com/v1", "userinfo"],
  ["userinfo（名前だけ）", "https://user@api.example.com/v1", "userinfo"],
  ["fragment", "https://api.example.com/v1#frag", "fragment"],
  ["空の fragment", "https://api.example.com/v1#", "fragment"],
  ["既定以外のポート", "https://api.example.com:8443/v1", "port"],
  ["IPv4 リテラル", "https://93.184.216.34/v1", "ip_literal"],
  ["IPv6 リテラル", "https://[2606:2800:220:1::1]/v1", "ip_literal"],
  ["loopback リテラル", "https://127.0.0.1/v1", "ip_literal"],
  ["10 進表記の IPv4", "https://2130706433/v1", "ip_literal"],
  ["16 進表記の IPv4", "https://0x7f.0.0.1/v1", "ip_literal"],
  ["末尾ドット", "https://api.example.com./v1", "trailing_dot"],
  ["大文字のホスト", "https://API.example.com/v1", "not_canonical"],
  ["既定ポートの明示", "https://api.example.com:443/v1", "not_canonical"],
  ["パスなし", "https://api.example.com", "not_canonical"],
  ["dot segment", "https://api.example.com/a/../b", "not_canonical"],
  ["エンコードされていない空白", "https://api.example.com/a b", "not_canonical"],
  ["前後の空白", " https://api.example.com/v1", "not_canonical"],
  ["Unicode のホスト", "https://例え.example/v1", "not_canonical"],
  ["バックスラッシュ", "https://api.example.com\\v1", "not_canonical"],
  ["タブ", "https://api.example.com/v\t1", "not_canonical"],
])("拒否: %s", (_name, raw, reason) => {
  expect(parseUpstreamUrl(raw, NONE)).toEqual({ ok: false, reason });
});

test("拒否ホストはそのホストとサブドメインを拒否し、接尾辞が同じだけの別ホストは通す", () => {
  const options = { denyHosts: ["router.example.com", "x402.org"] };
  for (const raw of [
    "https://router.example.com/mcp",
    "https://a.router.example.com/mcp",
    "https://a.b.router.example.com/",
    "https://x402.org/facilitator/verify",
    "https://www.x402.org/facilitator/verify",
  ]) {
    expect(parseUpstreamUrl(raw, options), raw).toEqual({ ok: false, reason: "denied_host" });
  }
  for (const raw of [
    "https://notrouter.example.com/",
    "https://router.example.com.evil.test/",
    "https://example.com/",
    "https://notx402.org/",
    "https://x402.org.example/",
  ]) {
    expect(parseUpstreamUrl(raw, options).ok, raw).toBe(true);
  }
});

test("denyHostsOf は設定の URL からホスト名を集める（重複・大文字・ポート・パスを落とす）", () => {
  expect(
    denyHostsOf(["router.example.com"], [
      "https://www.x402.org/facilitator",
      "https://RPC.Moderato.tempo.xyz:443/",
      "http://127.0.0.1:8500",
      "https://www.x402.org/other",
      undefined,
      "not a url",
    ]),
  ).toEqual(["router.example.com", "www.x402.org", "rpc.moderato.tempo.xyz", "127.0.0.1"]);
});
