/**
 * 秘匿購入の intent 封筒の検査（設計 `docs/zktls-router-design.md` §5.1、要件 FR-Z20・FR-Z22・FR-Z28）。
 * lab の live 記録の `order`（`tests/fixtures/private/golden/post-intent.json`）を Router の封筒に包み直して golden に使う。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { finalOrderBytesOf, finalOrderOf, headerFileOf, intentSha256Of, parseIntent, type IntentOrder } from "../../src/private/intent.js";
import { releaseBytesOf, releaseDocumentOf, parseReleaseBytes } from "../../src/private/release.js";

const golden = (name: string): unknown => JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/private/golden", name), "utf8"));

const OUTBOUND = { protocol: "x402", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1", maxAmount: "10000" };
const INBOUND = { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", maxTotal: "20000" };

function labOrder(): Record<string, unknown> {
  return (golden("post-intent.json") as { order: Record<string, unknown> }).order;
}

function envelope(overrides: { order?: unknown; outbound?: unknown; inbound?: unknown; version?: unknown } = {}): Record<string, unknown> {
  return {
    version: overrides.version ?? "phase5-intent-v1",
    order: overrides.order ?? labOrder(),
    outbound: overrides.outbound ?? OUTBOUND,
    inbound: overrides.inbound ?? INBOUND,
  };
}

const bytesOf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), "utf8");

function getOrder(): Record<string, unknown> {
  return {
    ...labOrder(),
    target: { host: "test-server.io", port: 443, path: "/v1/paid-snapshot" },
    request: { framing: "phase5-get-public-v1", method: "GET", content_type: "", body_len: 0, body_commitment_hex: "", executor_header: "", max_executor_value_len: 0 },
  };
}

describe("parseIntent: lab の canonical POST の order を包んだ封筒", () => {
  test("通り、バイト列・sha256・URL・方法を返す", () => {
    const bytes = bytesOf(envelope());
    const parsed = parseIntent(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.intent.sha256).toBe(intentSha256Of(bytes));
    expect(parsed.intent.bytes.equals(bytes)).toBe(true);
    expect(parsed.intent.method).toBe("POST");
    expect(parsed.intent.url).toBe("https://test-server.io/select");
    expect(parsed.intent.order.request.body_len).toBe(88);
    expect(parsed.intent.outbound).toEqual(OUTBOUND);
    expect(parsed.intent.inbound).toEqual(INBOUND);
  });

  test("公開 GET の骨格も通る", () => {
    const parsed = parseIntent(bytesOf(envelope({ order: getOrder() })));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.intent.method).toBe("GET");
  });

  test("lab の封筒そのもの（outbound/inbound が lab の形）は Router の封筒ではないので拒否する", () => {
    const parsed = parseIntent(readFileSync(path.join(import.meta.dirname, "../fixtures/private/golden/post-intent.json")));
    expect(parsed).toEqual({ ok: false, reason: "outbound_shape" });
  });
});

describe("parseIntent: バイト列の形", () => {
  test("空・上限超過は intent_too_large", () => {
    expect(parseIntent(Buffer.alloc(0))).toEqual({ ok: false, reason: "intent_too_large" });
    expect(parseIntent(bytesOf(envelope()), { maxBytes: 10 })).toEqual({ ok: false, reason: "intent_too_large" });
  });
  test("UTF-8 でない・JSON でない・object でない", () => {
    expect(parseIntent(Buffer.from([0xff, 0xfe, 0x7b]))).toEqual({ ok: false, reason: "intent_not_utf8" });
    expect(parseIntent(Buffer.from("{nope", "utf8"))).toEqual({ ok: false, reason: "intent_not_json" });
    expect(parseIntent(Buffer.from("[1]", "utf8"))).toEqual({ ok: false, reason: "intent_shape" });
  });
  test("compact でない（空白・改行・鍵の重複・数値表記）は intent_not_compact", () => {
    const text = JSON.stringify(envelope());
    expect(parseIntent(Buffer.from(JSON.stringify(envelope(), null, 1), "utf8"))).toEqual({ ok: false, reason: "intent_not_compact" });
    expect(parseIntent(Buffer.from(`${text}\n`, "utf8"))).toEqual({ ok: false, reason: "intent_not_compact" });
    // 鍵の重複（後勝ちで消えるので再直列化が一致しない）
    const duplicated = text.replace('"version":"phase5-intent-v1"', '"version":"phase5-intent-v0","version":"phase5-intent-v1"');
    expect(parseIntent(Buffer.from(duplicated, "utf8"))).toEqual({ ok: false, reason: "intent_not_compact" });
    expect(parseIntent(Buffer.from(text.replace('"port":443', '"port":443.0'), "utf8"))).toEqual({ ok: false, reason: "intent_not_compact" });
  });
  test("トップレベルの鍵と version", () => {
    expect(parseIntent(bytesOf({ ...envelope(), extra: 1 }))).toEqual({ ok: false, reason: "intent_shape" });
    const { inbound: _inbound, ...missing } = envelope();
    expect(parseIntent(bytesOf(missing))).toEqual({ ok: false, reason: "intent_shape" });
    expect(parseIntent(bytesOf(envelope({ version: "phase5-intent-v0" })))).toEqual({ ok: false, reason: "intent_version" });
  });
});

describe("parseIntent: order の各欄（Rust の骨格の規則と同じか、より厳しい）", () => {
  const withOrder = (patch: (order: Record<string, unknown>) => void): ReturnType<typeof parseIntent> => {
    const order = labOrder();
    patch(order);
    return parseIntent(bytesOf(envelope({ order })));
  };
  const reasonOf = (patch: (order: Record<string, unknown>) => void): string | undefined => {
    const result = withOrder(patch);
    return result.ok ? undefined : result.reason;
  };
  test("鍵の過不足・order_id・payer_pk・curve", () => {
    expect(reasonOf((o) => { o["extra"] = 1; })).toBe("order_shape");
    expect(reasonOf((o) => { delete o["curve"]; })).toBe("order_shape");
    expect(reasonOf((o) => { o["order_id"] = "ZZ".repeat(32); })).toBe("order_id");
    expect(reasonOf((o) => { o["order_id"] = "ab".repeat(31); })).toBe("order_id");
    expect(reasonOf((o) => { o["payer_pk"] = { x: "0".repeat(64) }; })).toBe("payer_pk");
    expect(reasonOf((o) => { o["payer_pk"] = { x: "0".repeat(64), y: "G".repeat(64) }; })).toBe("payer_pk");
    expect(reasonOf((o) => { o["curve"] = "secp256k1"; })).toBe("curve");
  });
  test("target: host は小文字 DNS 名（IP 不可）、port は 443 だけ、path は 256 B 以下の VCHAR でクエリ・フラグメント無し・正規形", () => {
    expect(reasonOf((o) => { (o["target"] as Record<string, unknown>)["host"] = "Test-Server.io"; })).toBe("target_host");
    expect(reasonOf((o) => { (o["target"] as Record<string, unknown>)["host"] = "127.0.0.1"; })).toBe("target_host");
    expect(reasonOf((o) => { (o["target"] as Record<string, unknown>)["host"] = "localhost"; })).toBe("target_host");
    expect(reasonOf((o) => { (o["target"] as Record<string, unknown>)["port"] = 8443; })).toBe("target_port");
    expect(reasonOf((o) => { (o["target"] as Record<string, unknown>)["port"] = "443"; })).toBe("target_port");
    // 秘匿 POST の path は `/select` 固定（Provider 契約）。GET で path の規則を見る。
    const get = (patch: (target: Record<string, unknown>) => void): string | undefined => {
      const order = getOrder();
      patch(order["target"] as Record<string, unknown>);
      const result = parseIntent(bytesOf(envelope({ order })));
      return result.ok ? undefined : result.reason;
    };
    expect(get((t) => { t["path"] = "/v1/x?y=1"; })).toBe("target_path");
    expect(get((t) => { t["path"] = "/v1/x#frag"; })).toBe("target_path");
    expect(get((t) => { t["path"] = "/v1/a b"; })).toBe("target_path");
    expect(get((t) => { t["path"] = "v1/x"; })).toBe("target_path");
    expect(get((t) => { t["path"] = "/v1/../x"; })).toBe("target_path");
    expect(get((t) => { t["path"] = `/${"a".repeat(256)}`; })).toBe("target_path");
    expect(get((t) => { t["path"] = `/${"a".repeat(255)}`; })).toBeUndefined();
  });
  test("request: 支払いヘッダ入り・鍵の過不足・framing・POST の規則", () => {
    const req = (o: Record<string, unknown>): Record<string, unknown> => o["request"] as Record<string, unknown>;
    expect(reasonOf((o) => { req(o)["payment_header"] = { name: "PAYMENT-SIGNATURE", value: "x" }; })).toBe("request_payment_header");
    expect(reasonOf((o) => { delete req(o)["executor_header"]; })).toBe("request_shape");
    expect(reasonOf((o) => { req(o)["framing"] = "phase3-post-json-v1"; })).toBe("request_framing");
    expect(reasonOf((o) => { req(o)["method"] = "GET"; })).toBe("request_method");
    expect(reasonOf((o) => { req(o)["content_type"] = "text/plain"; })).toBe("request_content_type");
    expect(reasonOf((o) => { req(o)["body_len"] = 0; })).toBe("request_body_len");
    expect(reasonOf((o) => { req(o)["body_len"] = 513; })).toBe("request_body_len");
    expect(reasonOf((o) => { req(o)["body_len"] = 88.5; })).toBe("request_body_len");
    expect(reasonOf((o) => { req(o)["body_commitment_hex"] = "ab".repeat(31); })).toBe("request_body_commitment");
    expect(reasonOf((o) => { req(o)["executor_header"] = "Authorization"; })).toBe("request_executor_header");
    expect(reasonOf((o) => { req(o)["max_executor_value_len"] = 65; })).toBe("request_max_executor_value_len");
    expect(reasonOf((o) => { (o["target"] as Record<string, unknown>)["path"] = "/select2"; })).toBe("request_path");
  });
  test("request: GET の規則（本文・commitment・穴は空）", () => {
    const get = (patch: (request: Record<string, unknown>) => void): string | undefined => {
      const order = getOrder();
      patch(order["request"] as Record<string, unknown>);
      const result = parseIntent(bytesOf(envelope({ order })));
      return result.ok ? undefined : result.reason;
    };
    expect(get((r) => { r["method"] = "POST"; })).toBe("request_method");
    expect(get((r) => { r["content_type"] = "application/json"; })).toBe("request_content_type");
    expect(get((r) => { r["body_len"] = 1; })).toBe("request_body_len");
    expect(get((r) => { r["body_commitment_hex"] = "ab".repeat(32); })).toBe("request_body_commitment");
    expect(get((r) => { r["executor_header"] = "X-Lab-Credential"; })).toBe("request_executor_header");
    expect(get((r) => { r["max_executor_value_len"] = 64; })).toBe("request_max_executor_value_len");
  });
});

describe("parseIntent: outbound / inbound の必須欄", () => {
  test("鍵の過不足・値の形", () => {
    const out = (patch: Record<string, unknown>): string | undefined => {
      const result = parseIntent(bytesOf(envelope({ outbound: { ...OUTBOUND, ...patch } })));
      return result.ok ? undefined : result.reason;
    };
    expect(out({ amount: "1" })).toBe("outbound_shape");
    expect(out({ protocol: "solana" })).toBe("outbound_shape");
    expect(out({ network: "base-sepolia" })).toBe("outbound_shape");
    expect(out({ asset: "USDC" })).toBe("outbound_shape");
    expect(out({ payTo: "0x12" })).toBe("outbound_shape");
    expect(out({ maxAmount: "0" })).toBe("outbound_shape");
    expect(out({ maxAmount: "1e4" })).toBe("outbound_shape");
    const inb = (patch: Record<string, unknown>): string | undefined => {
      const result = parseIntent(bytesOf(envelope({ inbound: { ...INBOUND, ...patch } })));
      return result.ok ? undefined : result.reason;
    };
    expect(inb({ payTo: "0x" + "1".repeat(40) })).toBe("inbound_shape");
    expect(inb({ maxTotal: "-1" })).toBe("inbound_shape");
  });
});

describe("最終注文・ヘッダファイル・release", () => {
  const header = { name: "Authorization", value: "Payment abc" };
  test("finalOrderOf は Rust の Order のフィールド順で、payment_header を足した以外は骨格と同じ", () => {
    const parsed = parseIntent(bytesOf(envelope()));
    if (!parsed.ok) throw new Error(parsed.reason);
    const order: IntentOrder = parsed.intent.order;
    const final = finalOrderOf(order, header);
    expect(Object.keys(final)).toEqual(["order_id", "payer_pk", "curve", "target", "request"]);
    expect(Object.keys(final["request"] as Record<string, unknown>)).toEqual(["framing", "method", "content_type", "body_len", "body_commitment_hex", "executor_header", "max_executor_value_len", "payment_header"]);
    const stripped = JSON.parse(finalOrderBytesOf(order, header).toString("utf8")) as Record<string, unknown>;
    delete (stripped["request"] as Record<string, unknown>)["payment_header"];
    expect(stripped).toEqual(labOrder());
    // lab の verifier が読んだ最終注文（golden）と、同じヘッダで組み直したものが値として一致する。
    const labFinal = golden("post-order-final.json") as { request: { payment_header: { name: string; value: string } } };
    expect(JSON.parse(finalOrderBytesOf(order, labFinal.request.payment_header).toString("utf8"))).toEqual(labFinal);
  });
  test("headerFileOf は payer-finalize-order が読む 4 欄", () => {
    const parsed = parseIntent(bytesOf(envelope()));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(headerFileOf(parsed.intent, header)).toEqual({ order_id: parsed.intent.order.order_id, intent_sha256: parsed.intent.sha256, name: "Authorization", value: "Payment abc" });
  });
  test("releaseBytesOf は固定の鍵順の compact JSON で、lab の record が固定した sha256 と同じ計算になる", () => {
    const labRelease = golden("post-release.json") as { intent_sha256: string; order_id: string; header_name: string; header_sha256: string; inbound: { tx: string } };
    const doc = releaseDocumentOf({ intentSha256: labRelease.intent_sha256, orderId: labRelease.order_id, headerName: labRelease.header_name, headerValue: "unused-here", inboundTx: labRelease.inbound.tx });
    expect(Object.keys(doc)).toEqual(["version", "intent_sha256", "order_id", "header_name", "header_sha256", "inbound"]);
    const bytes = releaseBytesOf({ intentSha256: "a".repeat(64), orderId: "b".repeat(64), headerName: "PAYMENT-SIGNATURE", headerValue: "eyJ4", inboundTx: "0x01" });
    expect(bytes.toString("utf8")).toBe('{"version":"phase5-release-v1","intent_sha256":"' + "a".repeat(64) + '","order_id":"' + "b".repeat(64) + '","header_name":"PAYMENT-SIGNATURE","header_sha256":"' + intentSha256Of(Buffer.from("eyJ4")) + '","inbound":{"tx":"0x01"}}');
    expect(parseReleaseBytes(bytes)).toEqual(JSON.parse(bytes.toString("utf8")));
    expect(() => releaseBytesOf({ intentSha256: "a".repeat(64), orderId: "b".repeat(64), headerName: "PAYMENT-SIGNATURE", headerValue: "x", inboundTx: "" })).toThrow();
    // lab の release は余分な欄を持つが Rust は無視する。Router の読み戻しも最小の欄だけを見る。
    expect(parseReleaseBytes(readFileSync(path.join(import.meta.dirname, "../fixtures/private/golden/post-release.json")))).toMatchObject({ version: "phase5-release-v1", inbound: { tx: labRelease.inbound.tx } });
  });
});
