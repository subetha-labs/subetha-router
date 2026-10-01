/**
 * 上流 URL の設定検証（設計 §3.1 / FR-4''）。**無課金・ネットワーク不使用。**
 *
 * なぜ必要か: 上流 URL は設定値であり、資格情報は**パスに入る**運用
 * （`docs/DEPLOY.md`）。`user:pass@host` 形式は「どこが権威ある host か」を
 * 読み手によって変え得るので受け付けない。`fragment` はサーバへ送られないため、
 * 設定に書かれていれば設定ミスである。
 */

import { describe, expect, it } from "vitest";

import { assertAbsoluteHttpUrl } from "../../src/config.js";

describe("upstream URL rules", () => {
  it("accepts a plain https URL", () => {
    expect(assertAbsoluteHttpUrl("https://example.com/v1/resource", "at")).toContain(
      "example.com",
    );
  });

  it("keeps accepting a credential-bearing PATH (the documented operator pattern)", () => {
    // `docs/DEPLOY.md`: 「URL 自体が資格情報（パスに API キーを含む）」。
    expect(assertAbsoluteHttpUrl("https://rpc.example.com/v2/abc123key", "at")).toContain(
      "abc123key",
    );
  });

  it.each([
    ["userinfo (user only)", "https://user@example.com/x"],
    ["userinfo (user:pass)", "https://user:pass@example.com/x"],
  ])("rejects %s", (_label, raw) => {
    expect(() => assertAbsoluteHttpUrl(raw, "at")).toThrow(/userinfo/);
  });

  it.each([
    ["named fragment", "https://example.com/x#frag"],
    // 末尾 `#` は `URL.hash` が空文字になるので、パース結果だけ見ると漏れる。
    ["empty fragment", "https://example.com/x#"],
  ])("rejects a %s", (_label, raw) => {
    expect(() => assertAbsoluteHttpUrl(raw, "at")).toThrow(/fragment/);
  });

  it("still rejects a query when allowQuery is false", () => {
    expect(() => assertAbsoluteHttpUrl("https://example.com/x?a=1", "at")).toThrow(/query/);
  });

  it("still allows a query when allowQuery is true (SubEtha facilitator)", () => {
    // `config.ts` の SubEtha facilitator は allowQuery=true で呼ばれる。
    expect(assertAbsoluteHttpUrl("https://fac.example.com/x?a=1", "at", true)).toContain("a=1");
  });

  it.each([
    ["non-absolute", "/v1/resource"],
    ["wrong scheme", "ftp://example.com/x"],
  ])("rejects %s", (_label, raw) => {
    expect(() => assertAbsoluteHttpUrl(raw, "at")).toThrow();
  });
});
