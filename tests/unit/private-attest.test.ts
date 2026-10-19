/**
 * attest の検査（設計 §5.3・§5.4、要件 FR-Z08）。lab の live 記録（`tests/fixtures/private/golden/*-record.json`）を golden に、
 * 期待 prefix の直列化・要求長・ヘッダ構文・応答ヘッダの解析・bundle の束縛・各欄のすり替えを確かめる。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  checkAttest,
  checkBundleBinding,
  expectedPrefixOf,
  MAX_PAYMENT_VALUE_GET,
  MAX_PAYMENT_VALUE_POST,
  parseBundlePublic,
  parseRecvHeaders,
  parseVerifierRecord,
  receiptHeaderOf,
  recordCompletedAtMsOf,
  requestLengthBoundOf,
  validatePaymentHeader,
  type AttestExpectation,
  type VerifierRecord,
} from "../../src/private/attest.js";
import { parseIntent, sha256Hex, type IntentOrder } from "../../src/private/intent.js";

const goldenDir = path.join(import.meta.dirname, "../fixtures/private/golden");
const golden = (name: string): unknown => JSON.parse(readFileSync(path.join(goldenDir, name), "utf8"));

function postRecord(): VerifierRecord {
  const record = parseVerifierRecord(golden("post-record.json"));
  if (record === undefined) throw new Error("golden post record unreadable");
  return record;
}
function getRecord(): VerifierRecord {
  const record = parseVerifierRecord(golden("get-record.json"));
  if (record === undefined) throw new Error("golden get record unreadable");
  return record;
}
function postOrder(): IntentOrder {
  const envelope = { version: "phase5-intent-v1", order: (golden("post-intent.json") as { order: unknown }).order, outbound: { protocol: "mpp", network: "eip155:31337", asset: "0xbe9A6A5f3bE5d67B234D22f58d785cfD5a334e22", payTo: "0xCb6e2674116f585f0F688Cf99337b6b8a3fBF63a", maxAmount: "10000" }, inbound: { network: "eip155:31337", asset: "0xbe9A6A5f3bE5d67B234D22f58d785cfD5a334e22", maxTotal: "10000" } };
  const parsed = parseIntent(Buffer.from(JSON.stringify(envelope), "utf8"));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.intent.order;
}
const postHeader = (): { name: string; value: string } => (golden("post-order-final.json") as { request: { payment_header: { name: string; value: string } } }).request.payment_header;
const getHeader = (): { name: string; value: string } => (getRecord().request.spec as { payment_header: { name: string; value: string } }).payment_header;
function getOrder(): IntentOrder {
  const record = getRecord();
  return {
    order_id: record.order_id,
    payer_pk: { x: "1".repeat(64), y: "2".repeat(64) },
    curve: "grumpkin",
    target: { host: record.target.host, port: 443, path: record.target.path },
    request: { framing: "phase5-get-public-v1", method: "GET", content_type: "", body_len: 0, body_commitment_hex: "", executor_header: "", max_executor_value_len: 0 },
  };
}

describe("期待 prefix（lab の request.rs の直列化）", () => {
  test("canonical POST: 発行ヘッダ 1 行の後に穴の名前で終わり、全長 = prefix + cred + 4 + body", () => {
    const record = postRecord();
    const prefix = expectedPrefixOf(postOrder().target, postOrder().request, postHeader());
    expect(prefix).toBe(record.request.revealed_prefix);
    expect(prefix.endsWith("X-Lab-Credential: ")).toBe(true);
    expect(prefix.length + record.request.cred_len + 4 + record.body_len === record.len_sent || Buffer.byteLength(prefix) + record.request.cred_len + 4 + postOrder().request.body_len === record.len_sent).toBe(true);
    expect(requestLengthBoundOf(postOrder().target, postOrder().request, postHeader())).toBe(Buffer.byteLength(prefix) + 64 + 4 + 88);
  });
  test("公開 GET: 要求全体（末尾 CRLFCRLF）が prefix で、len_sent と一致", () => {
    const record = getRecord();
    const prefix = expectedPrefixOf(getOrder().target, getOrder().request, getHeader());
    expect(prefix).toBe(record.request.revealed_prefix);
    expect(Buffer.byteLength(prefix)).toBe(record.len_sent);
    expect(requestLengthBoundOf(getOrder().target, getOrder().request, getHeader())).toBe(record.len_sent);
  });
});

describe("支払いヘッダの構文（Rust validate_payment_header_max）", () => {
  test("名前・長さ・文字・Authorization の scheme", () => {
    expect(validatePaymentHeader({ name: "X-Payment", value: "abc" }, MAX_PAYMENT_VALUE_POST)).toBe("header_name");
    expect(validatePaymentHeader({ name: "PAYMENT-SIGNATURE", value: "" }, MAX_PAYMENT_VALUE_POST)).toBe("header_value_length");
    expect(validatePaymentHeader({ name: "PAYMENT-SIGNATURE", value: "a".repeat(2049) }, MAX_PAYMENT_VALUE_POST)).toBe("header_value_length");
    expect(validatePaymentHeader({ name: "PAYMENT-SIGNATURE", value: "a".repeat(3072) }, MAX_PAYMENT_VALUE_GET)).toBeUndefined();
    expect(validatePaymentHeader({ name: "PAYMENT-SIGNATURE", value: "a\r\nb" }, MAX_PAYMENT_VALUE_POST)).toBe("header_value_chars");
    expect(validatePaymentHeader({ name: "PAYMENT-SIGNATURE", value: "a\tb" }, MAX_PAYMENT_VALUE_POST)).toBe("header_value_chars");
    expect(validatePaymentHeader({ name: "PAYMENT-SIGNATURE", value: " a" }, MAX_PAYMENT_VALUE_POST)).toBe("header_value_chars");
    expect(validatePaymentHeader({ name: "PAYMENT-SIGNATURE", value: "a  b" }, MAX_PAYMENT_VALUE_POST)).toBe("header_value_chars");
    expect(validatePaymentHeader({ name: "PAYMENT-SIGNATURE", value: "é" }, MAX_PAYMENT_VALUE_POST)).toBe("header_value_length");
    expect(validatePaymentHeader({ name: "Authorization", value: "Bearer x" }, MAX_PAYMENT_VALUE_POST)).toBe("header_authorization_scheme");
    expect(validatePaymentHeader({ name: "Authorization", value: "Payment " }, MAX_PAYMENT_VALUE_POST)).toBe("header_value_chars"); // Rust は末尾 SP を先に拒否する
    expect(validatePaymentHeader({ name: "Authorization", value: "Payment x" }, MAX_PAYMENT_VALUE_POST)).toBeUndefined();
    expect(validatePaymentHeader(postHeader(), MAX_PAYMENT_VALUE_POST)).toBeUndefined();
    expect(validatePaymentHeader(getHeader(), MAX_PAYMENT_VALUE_GET)).toBeUndefined();
  });
});

describe("応答ヘッダの解析", () => {
  test("lab の record の revealed_recv_headers を読み、領収ヘッダをちょうど 1 つ見つける", () => {
    const parsed = parseRecvHeaders(getRecord().revealed_recv_headers);
    expect(parsed?.statusLine).toBe("HTTP/1.1 200 OK");
    expect(parsed?.headers.map((h) => h.name)).toEqual(["content-type", "content-length", "payment-response", "cache-control", "date", "connection"]);
    expect(receiptHeaderOf(parsed!, "x402")?.name).toBe("payment-response");
    expect(receiptHeaderOf(parsed!, "mpp")).toBeUndefined();
    const mpp = parseRecvHeaders(postRecord().revealed_recv_headers);
    expect(receiptHeaderOf(mpp!, "mpp")?.name).toBe("payment-receipt");
  });
  test("形の崩れた応答ヘッダは読まない", () => {
    expect(parseRecvHeaders("HTTP/1.1 200 OK\r\nA: b\r\n")).toBeUndefined();
    expect(parseRecvHeaders("HTTP/2 200 OK\r\n\r\n")).toBeUndefined();
    expect(parseRecvHeaders("HTTP/1.1 200 OK\r\n a: b\r\n\r\n")).toBeUndefined();
    expect(parseRecvHeaders("HTTP/1.1 200 OK\r\nA : b\r\n\r\n")).toBeUndefined();
    const two = parseRecvHeaders("HTTP/1.1 200 OK\r\nPAYMENT-RESPONSE: a\r\nX-PAYMENT-RESPONSE: b\r\n\r\n");
    expect(receiptHeaderOf(two!, "x402")).toBeUndefined();
  });
});

function expectation(rail: "x402" | "mpp", order: IntentOrder, header: { name: string; value: string }, record: VerifierRecord): AttestExpectation {
  const binding = record.intent_binding;
  return {
    order,
    header,
    rail,
    trust: "lab-fixture-ca",
    intentSha256: binding?.intent_sha256 ?? "0".repeat(64),
    releaseSha256: binding?.release_sha256 ?? "0".repeat(64),
    inboundTx: binding?.inbound_tx ?? "0x00",
  };
}

const verifyOkPost = { ok: true, checks: ["UltraHonk delivery proof verified", "request-binding proof verified"] };

describe("checkAttest（POST の golden）", () => {
  const bundle = parseBundlePublic({ ...(golden("post-bundle-public.json") as Record<string, unknown>), proof_hex: "00", request: { ...((golden("post-bundle-public.json") as { request: Record<string, unknown> }).request), proof_hex: "00" } });
  if (bundle === undefined) throw new Error("golden bundle unreadable");
  const base = (): AttestExpectation => expectation("mpp", postOrder(), postHeader(), postRecord());
  test("lab の record・bundle・verify_result がそのまま通り、summary に値の無いメタデータだけが載る", () => {
    const result = checkAttest(base(), postRecord(), verifyOkPost, bundle);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.name).toBe("payment-receipt");
    expect(result.summary).toEqual({ trust: "lab-fixture-ca", externalGate: false, serverName: "test-server.io", requestLine: "POST /select HTTP/1.1", lenSent: 1849, bodyLen: 196, statusLine: "HTTP/1.1 200 OK", receiptHeaderName: "payment-receipt", credLen: 39 });
    expect(JSON.stringify(result.summary)).not.toContain(postHeader().value.slice(8, 40));
    expect(recordCompletedAtMsOf(postRecord())).toBe(postRecord().tls_accept_unix_ms + postRecord().session_wall_ms);
  });
  test("実モードの期待（mozilla）では lab-fixture-ca の record を通さない", () => {
    expect(checkAttest({ ...base(), trust: "mozilla" }, postRecord(), verifyOkPost, bundle)).toEqual({ ok: false, reason: "trust" });
  });
  test("各欄のすり替えは fail closed", () => {
    const tweak = (patch: (record: { -readonly [K in keyof VerifierRecord]: VerifierRecord[K] }) => void, expectReason: string): void => {
      const record = JSON.parse(JSON.stringify(postRecord())) as { -readonly [K in keyof VerifierRecord]: VerifierRecord[K] };
      patch(record);
      expect(checkAttest(base(), record, verifyOkPost, bundle)).toEqual({ ok: false, reason: expectReason });
    };
    tweak((r) => { r.target = { ...r.target, path: "/select2" }; }, "target");
    tweak((r) => { r.target = { ...r.target, port: 8443 }; }, "target");
    tweak((r) => { r.server_name = "evil.example"; }, "server_name");
    tweak((r) => { r.order_id = "0".repeat(64); }, "order_id");
    tweak((r) => { r.intent_binding = { ...r.intent_binding!, inbound_tx: "0x01" }; }, "intent_binding");
    tweak((r) => { delete (r as { intent_binding?: unknown }).intent_binding; }, "intent_binding");
    tweak((r) => { r.request = { ...r.request, framing: "phase5-get-public-v1" }; }, "framing");
    tweak((r) => { r.request = { ...r.request, spec: { ...r.request.spec, body_len: 89 } }; }, "spec");
    tweak((r) => { r.request = { ...r.request, revealed_prefix: r.request.revealed_prefix.replace("Connection: close", "Connection: keep-alive") }; }, "revealed_prefix");
    tweak((r) => { r.len_sent += 1; }, "len_sent");
    tweak((r) => { r.request = { ...r.request, cred_len: 0 }; }, "cred_len");
    tweak((r) => { r.http_framing = "chunked"; }, "http_framing");
    tweak((r) => { r.content_length += 1; }, "content_length");
    tweak((r) => { r.revealed_recv_headers = r.revealed_recv_headers.replace("200 OK", "402 Payment Required"); }, "status_line");
    tweak((r) => { r.revealed_recv_headers = r.revealed_recv_headers.replace("payment-receipt:", "x-other:"); }, "receipt_header");
    tweak((r) => { r.revealed_recv_headers = r.revealed_recv_headers.slice(0, -2); }, "recv_headers");
    // 発行ヘッダ・intent・release の違い
    expect(checkAttest({ ...base(), header: { name: "Authorization", value: "Payment other" } }, postRecord(), verifyOkPost, bundle)).toEqual({ ok: false, reason: "intent_binding" });
    expect(checkAttest({ ...base(), intentSha256: "1".repeat(64) }, postRecord(), verifyOkPost, bundle)).toEqual({ ok: false, reason: "intent_binding" });
    expect(checkAttest({ ...base(), releaseSha256: "1".repeat(64) }, postRecord(), verifyOkPost, bundle)).toEqual({ ok: false, reason: "intent_binding" });
    expect(checkAttest({ ...base(), rail: "x402" }, postRecord(), verifyOkPost, bundle)).toEqual({ ok: false, reason: "receipt_header" });
    // verify_result
    expect(checkAttest(base(), postRecord(), { ok: false, checks: [] }, bundle)).toEqual({ ok: false, reason: "verify_result" });
    expect(checkAttest(base(), postRecord(), { ok: true, checks: ["UltraHonk delivery proof verified"] }, bundle)).toEqual({ ok: false, reason: "verify_checks" });
  });
  test("別購入・別セッションの bundle は束縛で止まる（attest_foreign の判定）", () => {
    const order = postOrder();
    const record = postRecord();
    expect(checkBundleBinding(order, record, bundle)).toBeUndefined();
    expect(checkBundleBinding(order, record, { ...bundle, public: { ...bundle.public, order_id: "0".repeat(64) } })).toBe("bundle_order_id");
    expect(checkBundleBinding(order, record, { ...bundle, public: { ...bundle.public, payer_pk: { x: "0".repeat(64), y: bundle.public.payer_pk.y } } })).toBe("bundle_payer_pk");
    expect(checkBundleBinding(order, record, { ...bundle, public: { ...bundle.public, committed_hash_hex: "0".repeat(64) } })).toBe("bundle_committed_hash");
    expect(checkBundleBinding(order, record, { ...bundle, public: { ...bundle.public, payload_len: 1 } })).toBe("bundle_payload_len");
    const { request: _request, ...withoutRequest } = bundle;
    expect(checkBundleBinding(order, record, withoutRequest)).toBe("bundle_request_missing");
    expect(checkBundleBinding(order, record, { ...bundle, request: { public: { ...bundle.request!.public, tls_body_hash_hex: "0".repeat(64) } } })).toBe("bundle_request_hashes");
    expect(checkBundleBinding(order, record, { ...bundle, request: { public: { ...bundle.request!.public, payer_commitment_hex: "0".repeat(64) } } })).toBe("bundle_request_commitment");
    expect(checkBundleBinding(order, record, { ...bundle, request: { public: { ...bundle.request!.public, cred_len: 40 } } })).toBe("bundle_request_lengths");
    expect(checkAttest(base(), record, verifyOkPost, { ...bundle, public: { ...bundle.public, order_id: "0".repeat(64) } })).toEqual({ ok: false, reason: "bundle_order_id" });
  });
});

describe("checkAttest（GET の golden）", () => {
  const verifyOkGet = { ok: true, checks: ["UltraHonk delivery proof verified"] };
  const bundle = { public: { order_id: getRecord().order_id, payer_pk: { x: "1".repeat(64), y: "2".repeat(64) }, committed_hash_hex: getRecord().committed_hash_hex, payload_len: getRecord().body_len } };
  test("GET の record は intent_binding を持たないので実運用の期待では通らず、束縛付きの record だけが通る", () => {
    const record = getRecord();
    const base = expectation("x402", getOrder(), getHeader(), record);
    expect(checkAttest(base, record, verifyOkGet, bundle)).toEqual({ ok: false, reason: "intent_binding" });
    const bound: VerifierRecord = { ...record, intent_binding: { intent_sha256: "a".repeat(64), release_sha256: "b".repeat(64), header_sha256: sha256Hex(getHeader().value), inbound_tx: "0x02" } };
    const result = checkAttest({ ...base, intentSha256: "a".repeat(64), releaseSha256: "b".repeat(64), inboundTx: "0x02" }, bound, verifyOkGet, bundle);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toMatchObject({ requestLine: "GET /v1/paid-snapshot HTTP/1.1", lenSent: 1176, credLen: 0, receiptHeaderName: "payment-response" });
    // GET に要求束縛証明があれば wrong-mode
    expect(checkAttest({ ...base, intentSha256: "a".repeat(64), releaseSha256: "b".repeat(64), inboundTx: "0x02" }, bound, { ok: true, checks: ["UltraHonk delivery proof verified", "request-binding proof verified"] }, bundle)).toEqual({ ok: false, reason: "verify_checks" });
    expect(checkBundleBinding(getOrder(), bound, { ...bundle, request: { public: { tls_body_hash_hex: "", tls_cred_hash_hex: "", payer_commitment_hex: "", body_len: 0, cred_len: 0 } } })).toBe("bundle_request_forbidden");
  });
});
