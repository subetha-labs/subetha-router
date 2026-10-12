/** docs/dynamic-upstream-post-design.md: body normalization, binding shape, record validation (pure functions). */
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { bodySha256Of, dynamicBindingOf, MAX_UPSTREAM_BODY_BYTES, normalizeUpstreamBody, upstreamFieldsOf, upstreamTargetOf } from "../../src/core/dynamic.js";
import { validUpstreamRequest } from "../../src/core/store.js";

describe("normalizeUpstreamBody (FR-P1)", () => {
  test("object → canonical JSON（鍵は昇順、空白なし）と sha256。入れ子も正規化", () => {
    const r = normalizeUpstreamBody({ type: "fast", query: "q", numResults: 3, nested: { b: 1, a: [2, { z: 1, y: 2 }] } });
    expect(r).toEqual({ ok: true, body: '{"nested":{"a":[2,{"y":2,"z":1}],"b":1},"numResults":3,"query":"q","type":"fast"}', sha256: createHash("sha256").update('{"nested":{"a":[2,{"y":2,"z":1}],"b":1},"numResults":3,"query":"q","type":"fast"}', "utf8").digest("hex") });
    expect(normalizeUpstreamBody({})).toMatchObject({ ok: true, body: "{}" });
  });
  test.each([[undefined, "body_required"], [null, "body_not_object"], ["x", "body_not_object"], [1, "body_not_object"], [[1, 2], "body_not_object"]])("%s → %s", (raw, reason) => {
    expect(normalizeUpstreamBody(raw)).toEqual({ ok: false, reason });
  });
  test("8 KiB ちょうどは通り、1 バイト超は body_too_large（UTF-8 のバイト数で数える）", () => {
    const fit = { p: "p".repeat(MAX_UPSTREAM_BODY_BYTES - '{"p":""}'.length) };
    expect(Buffer.byteLength(JSON.stringify(fit))).toBe(MAX_UPSTREAM_BODY_BYTES);
    expect(normalizeUpstreamBody(fit)).toMatchObject({ ok: true });
    expect(normalizeUpstreamBody({ p: "p".repeat(MAX_UPSTREAM_BODY_BYTES - '{"p":""}'.length + 1) })).toEqual({ ok: false, reason: "body_too_large" });
    const multibyte = { p: "あ".repeat(Math.floor((MAX_UPSTREAM_BODY_BYTES - 8) / 3) + 1) };
    expect(normalizeUpstreamBody(multibyte)).toEqual({ ok: false, reason: "body_too_large" });
  });
  test("undefined の値を持つ鍵は落ちる（JSON に無い）。関数・symbol も落ちる", () => {
    expect(normalizeUpstreamBody({ a: 1, b: undefined, c: () => 1 })).toMatchObject({ ok: true, body: '{"a":1}' });
  });
});

describe("dynamicBindingOf (FR-P2)", () => {
  test("GET は従来の 4 要素、POST は sha256 つきの 5 要素。URL の `|` は符号化される", () => {
    expect(dynamicBindingOf("dyn-x", "https://p.test/v1?a=1|2")).toBe("dynamic|dyn-x|GET|https%3A%2F%2Fp.test%2Fv1%3Fa%3D1%7C2");
    const sha = bodySha256Of("{}");
    expect(dynamicBindingOf("dyn-x", "https://p.test/v1", "POST", sha)).toBe(`dynamic|dyn-x|POST|https%3A%2F%2Fp.test%2Fv1|sha256%3A${sha}`);
    expect(dynamicBindingOf("dyn-x", "https://p.test/v1", "GET")).toBe(dynamicBindingOf("dyn-x", "https://p.test/v1"));
    // 本文が違えば束縛も違う（同じ URL でも別の条件）
    expect(dynamicBindingOf("dyn-x", "https://p.test/v1", "POST", bodySha256Of('{"a":1}'))).not.toBe(dynamicBindingOf("dyn-x", "https://p.test/v1", "POST", bodySha256Of('{"a":2}')));
  });
});

describe("upstream record ↔ target (FR-P2)", () => {
  test("GET の記録は url と method だけ。POST は本文と sha256。target は GET に本文を付けない", () => {
    expect(upstreamFieldsOf({ url: "https://p.test/", method: "GET" })).toEqual({ url: "https://p.test/", method: "GET" });
    expect(upstreamFieldsOf({ url: "https://p.test/", method: "POST", body: "{}" })).toEqual({ url: "https://p.test/", method: "POST", body: "{}", bodySha256: bodySha256Of("{}") });
    expect(upstreamTargetOf({ url: "https://p.test/", method: "GET", body: "{}" })).toEqual({ url: "https://p.test/", method: "GET" });
    expect(upstreamTargetOf({ url: "https://p.test/", method: "POST", body: "{}" })).toEqual({ url: "https://p.test/", method: "POST", body: "{}" });
  });
  test("store の検査: GET に本文は不可、POST は文字列の本文・一致する sha256・8 KiB 以内が要る", () => {
    const sha = bodySha256Of("{}");
    expect(validUpstreamRequest({ url: "https://p.test/", method: "GET" })).toBe(true);
    expect(validUpstreamRequest({ url: "https://p.test/", method: "GET", body: "{}" })).toBe(false);
    expect(validUpstreamRequest({ url: "https://p.test/", method: "POST", body: "{}", bodySha256: sha })).toBe(true);
    expect(validUpstreamRequest({ url: "https://p.test/", method: "POST", body: "{}", bodySha256: "0".repeat(64) })).toBe(false);
    expect(validUpstreamRequest({ url: "https://p.test/", method: "POST", body: "{}" })).toBe(false);
    expect(validUpstreamRequest({ url: "https://p.test/", method: "POST", body: { a: 1 }, bodySha256: sha })).toBe(false);
    expect(validUpstreamRequest({ url: "https://p.test/", method: "PUT", body: "{}", bodySha256: sha })).toBe(false);
    expect(validUpstreamRequest({ url: "", method: "GET" })).toBe(false);
    const big = "p".repeat(8193);
    expect(validUpstreamRequest({ url: "https://p.test/", method: "POST", body: big, bodySha256: bodySha256Of(big) })).toBe(false);
  });
});
