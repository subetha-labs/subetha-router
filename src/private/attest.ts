/**
 * attest（FR-Z08）の Router 側の検査: 期待する公開 prefix・要求長・支払いヘッダの構文・record の欄・応答ヘッダの解析・bundle と record の束縛
 * （設計 `docs/zktls-router-design.md` §3.4・§5.3・§5.4）。すべて純関数（I/O なし）。lab の `request.rs`・`tls.rs`・`types.rs` の規則を TypeScript で再現する。
 * 失敗の理由は固定語だけ（Payer・Provider の値は含めない）。
 */

import { sha256Hex, type IntentOrder, type IntentTarget, type PaymentHeader } from "./intent.js";
import { FRAMING_GET_PUBLIC, FRAMING_POST_CANONICAL } from "./intent.js";

/** Rust `request.rs`: 私的 POST のヘッダ値の上限、公開 GET のヘッダ値の上限、MPC-TLS の送信予算。 */
export const MAX_PAYMENT_VALUE_POST = 2048;
export const MAX_PAYMENT_VALUE_GET = 3072;
export const MAX_SENT_BYTES = 4096;
export const MAX_CRED = 64;
export const SEP_LEN = 4;
export const HTTP_FRAMING = "content-length-identity-single-response";
export const TRUST_MOZILLA = "mozilla-webpki-roots";
export const TRUST_LAB_FIXTURE = "lab-fixture-ca";
export const CHECK_DELIVERY_PROOF = "UltraHonk delivery proof verified against verifier-derived VK";
export const CHECK_REQUEST_PROOF = "UltraHonk request-binding proof verified against verifier-derived VK";
export const PAYMENT_HEADER_NAMES = ["PAYMENT-SIGNATURE", "Authorization"] as const;

export type HeaderRejection = "header_name" | "header_value_length" | "header_value_chars" | "header_authorization_scheme";

/** Rust `validate_payment_header_max` と同じ規則。通れば `undefined`。 */
export function validatePaymentHeader(header: PaymentHeader, maxLen: number): HeaderRejection | undefined {
  if (!(PAYMENT_HEADER_NAMES as readonly string[]).includes(header.name)) return "header_name";
  const value = header.value;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes === 0 || bytes > maxLen || bytes !== value.length) return "header_value_length";
  // VCHAR / SP のみ。先頭・末尾・連続の SP は不可（CR・LF・HTAB・CTL・非 ASCII を含まない）。
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return "header_value_chars";
  }
  if (value.startsWith(" ") || value.endsWith(" ") || value.includes("  ")) return "header_value_chars";
  if (header.name === "Authorization" && !(value.startsWith("Payment ") && value.length > "Payment ".length)) return "header_authorization_scheme";
  return undefined;
}

export function maxPaymentValueOf(method: "GET" | "POST"): number {
  return method === "GET" ? MAX_PAYMENT_VALUE_GET : MAX_PAYMENT_VALUE_POST;
}

/**
 * 公開 prefix（Rust `request::public_prefix`／`get_request`）。POST（canonical）は `X-Lab-Credential: ` で終わり、GET は要求全体（末尾 CRLFCRLF を含む）。
 */
export function expectedPrefixOf(target: IntentTarget, request: IntentOrder["request"], header: PaymentHeader): string {
  if (request.framing === FRAMING_GET_PUBLIC) {
    return `GET ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n${header.name}: ${header.value}\r\n\r\n`;
  }
  if (request.framing !== FRAMING_POST_CANONICAL) throw new Error("unsupported framing");
  return `${request.method} ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\nContent-Type: ${request.content_type}\r\nContent-Length: ${request.body_len}\r\nConnection: close\r\n${header.name}: ${header.value}\r\n${request.executor_header}: `;
}

/** 最終要求の全長の上限値（発行前の見積り: POST は穴を最大 64 B とみなす）。`MAX_SENT_BYTES` を超えると executor が送れない。 */
export function requestLengthBoundOf(target: IntentTarget, request: IntentOrder["request"], header: PaymentHeader): number {
  const prefix = Buffer.byteLength(expectedPrefixOf(target, request, header), "utf8");
  return request.framing === FRAMING_GET_PUBLIC ? prefix : prefix + MAX_CRED + SEP_LEN + request.body_len;
}

export interface ParsedRecvHeaders {
  readonly statusLine: string;
  /** 名前は小文字化、値は前後の空白を除いたもの。順は応答どおり。 */
  readonly headers: readonly { readonly name: string; readonly value: string }[];
}

/** record の `revealed_recv_headers`（状態行 + ヘッダ + 空行。CRLF 区切り）を解析する。形が違えば `undefined`。 */
export function parseRecvHeaders(raw: string): ParsedRecvHeaders | undefined {
  if (typeof raw !== "string" || !raw.endsWith("\r\n\r\n")) return undefined;
  const lines = raw.slice(0, -4).split("\r\n");
  const statusLine = lines[0];
  if (statusLine === undefined || !/^HTTP\/1\.1 [0-9]{3} [\x20-\x7e]*$/.test(statusLine)) return undefined;
  const headers: { name: string; value: string }[] = [];
  for (const line of lines.slice(1)) {
    // obs-fold（先頭の空白）・名前と `:` の間の空白は不正。
    const match = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):[ \t]*([\x20-\x7e]*?)[ \t]*$/.exec(line);
    if (match === null) return undefined;
    headers.push({ name: match[1]!.toLowerCase(), value: match[2]! });
  }
  return { statusLine, headers };
}

/** 領収ヘッダ（x402: `PAYMENT-RESPONSE`／`X-PAYMENT-RESPONSE`、MPP: `Payment-Receipt`）。ちょうど 1 つあるときだけ値を返す。 */
export function receiptHeaderOf(parsed: ParsedRecvHeaders, rail: "x402" | "mpp"): { readonly name: string; readonly value: string } | undefined {
  const names = rail === "x402" ? ["payment-response", "x-payment-response"] : ["payment-receipt"];
  const found = parsed.headers.filter((header) => names.includes(header.name));
  return found.length === 1 ? found[0] : undefined;
}

/** Rust `VerifierRecord` のうち Router が読む欄。 */
export interface VerifierRecord {
  readonly order_id: string;
  readonly target: { readonly host: string; readonly port: number; readonly path: string };
  readonly trust: string;
  readonly external_gate: boolean;
  readonly server_name: string;
  readonly committed_hash_hex: string;
  readonly body_len: number;
  readonly len_sent: number;
  readonly revealed_recv_headers: string;
  readonly http_framing: string;
  readonly content_length: number;
  readonly tls_accept_unix_ms: number;
  readonly session_wall_ms: number;
  readonly request: {
    readonly framing: string;
    readonly spec: Record<string, unknown>;
    readonly revealed_prefix: string;
    readonly cred_len: number;
    readonly sent_cred_hash_hex: string;
    readonly sent_body_hash_hex: string;
  };
  readonly intent_binding?: { readonly intent_sha256: string; readonly release_sha256: string; readonly header_sha256: string; readonly inbound_tx: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUint(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** record.json の形の検査（値の正しさは `checkAttest`）。 */
export function parseVerifierRecord(raw: unknown): VerifierRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const target = raw["target"];
  const request = raw["request"];
  if (!isRecord(target) || typeof target["host"] !== "string" || !isUint(target["port"]) || typeof target["path"] !== "string") return undefined;
  if (!isRecord(request) || typeof request["framing"] !== "string" || !isRecord(request["spec"]) || typeof request["revealed_prefix"] !== "string" || !isUint(request["cred_len"])) return undefined;
  if (typeof request["sent_cred_hash_hex"] !== "string" || typeof request["sent_body_hash_hex"] !== "string") return undefined;
  if (
    typeof raw["order_id"] !== "string" ||
    typeof raw["trust"] !== "string" ||
    typeof raw["external_gate"] !== "boolean" ||
    typeof raw["server_name"] !== "string" ||
    typeof raw["committed_hash_hex"] !== "string" ||
    !isUint(raw["body_len"]) ||
    !isUint(raw["len_sent"]) ||
    typeof raw["revealed_recv_headers"] !== "string" ||
    typeof raw["http_framing"] !== "string" ||
    !isUint(raw["content_length"]) ||
    !isUint(raw["tls_accept_unix_ms"]) ||
    !isUint(raw["session_wall_ms"])
  ) {
    return undefined;
  }
  let intentBinding: VerifierRecord["intent_binding"];
  if (raw["intent_binding"] !== undefined) {
    const binding = raw["intent_binding"];
    if (!isRecord(binding) || ["intent_sha256", "release_sha256", "header_sha256", "inbound_tx"].some((key) => typeof binding[key] !== "string")) return undefined;
    intentBinding = { intent_sha256: binding["intent_sha256"] as string, release_sha256: binding["release_sha256"] as string, header_sha256: binding["header_sha256"] as string, inbound_tx: binding["inbound_tx"] as string };
  }
  return {
    order_id: raw["order_id"],
    target: { host: target["host"], port: target["port"], path: target["path"] },
    trust: raw["trust"],
    external_gate: raw["external_gate"],
    server_name: raw["server_name"],
    committed_hash_hex: raw["committed_hash_hex"],
    body_len: raw["body_len"],
    len_sent: raw["len_sent"],
    revealed_recv_headers: raw["revealed_recv_headers"],
    http_framing: raw["http_framing"],
    content_length: raw["content_length"],
    tls_accept_unix_ms: raw["tls_accept_unix_ms"],
    session_wall_ms: raw["session_wall_ms"],
    request: {
      framing: request["framing"],
      spec: request["spec"],
      revealed_prefix: request["revealed_prefix"],
      cred_len: request["cred_len"],
      sent_cred_hash_hex: request["sent_cred_hash_hex"],
      sent_body_hash_hex: request["sent_body_hash_hex"],
    },
    ...(intentBinding === undefined ? {} : { intent_binding: intentBinding }),
  };
}

/** executor の bundle のうち Router が読む欄（証明そのものは Rust が検証する）。 */
export interface BundlePublic {
  readonly public: { readonly order_id: string; readonly payer_pk: { readonly x: string; readonly y: string }; readonly committed_hash_hex: string; readonly payload_len: number };
  readonly request?: { readonly public: { readonly tls_body_hash_hex: string; readonly tls_cred_hash_hex: string; readonly payer_commitment_hex: string; readonly body_len: number; readonly cred_len: number } };
}

export function parseBundlePublic(raw: unknown): BundlePublic | undefined {
  if (!isRecord(raw) || !isRecord(raw["public"]) || typeof raw["proof_hex"] !== "string") return undefined;
  const pub = raw["public"];
  const pk = pub["payer_pk"];
  if (typeof pub["order_id"] !== "string" || !isRecord(pk) || typeof pk["x"] !== "string" || typeof pk["y"] !== "string" || typeof pub["committed_hash_hex"] !== "string" || !isUint(pub["payload_len"])) return undefined;
  let request: BundlePublic["request"];
  if (raw["request"] !== undefined) {
    const req = raw["request"];
    if (!isRecord(req) || !isRecord(req["public"]) || typeof req["proof_hex"] !== "string") return undefined;
    const rp = req["public"];
    if (typeof rp["tls_body_hash_hex"] !== "string" || typeof rp["tls_cred_hash_hex"] !== "string" || typeof rp["payer_commitment_hex"] !== "string" || !isUint(rp["body_len"]) || !isUint(rp["cred_len"])) return undefined;
    request = { public: { tls_body_hash_hex: rp["tls_body_hash_hex"], tls_cred_hash_hex: rp["tls_cred_hash_hex"], payer_commitment_hex: rp["payer_commitment_hex"], body_len: rp["body_len"], cred_len: rp["cred_len"] } };
  }
  return { public: { order_id: pub["order_id"], payer_pk: { x: pk["x"], y: pk["y"] }, committed_hash_hex: pub["committed_hash_hex"], payload_len: pub["payload_len"] }, ...(request === undefined ? {} : { request }) };
}

export type BindingRejection =
  | "bundle_order_id"
  | "bundle_payer_pk"
  | "bundle_committed_hash"
  | "bundle_payload_len"
  | "bundle_request_missing"
  | "bundle_request_forbidden"
  | "bundle_request_hashes"
  | "bundle_request_commitment"
  | "bundle_request_lengths";

/**
 * 受理の前の束縛（設計 §3.4 5）: この購入の intent と record に属する bundle か。外れれば別購入・別セッションの bundle（`attest_foreign`。状態は変えない）。
 */
export function checkBundleBinding(order: IntentOrder, record: VerifierRecord, bundle: BundlePublic): BindingRejection | undefined {
  if (bundle.public.order_id !== order.order_id) return "bundle_order_id";
  if (bundle.public.payer_pk.x !== order.payer_pk.x || bundle.public.payer_pk.y !== order.payer_pk.y) return "bundle_payer_pk";
  if (bundle.public.committed_hash_hex !== record.committed_hash_hex) return "bundle_committed_hash";
  if (bundle.public.payload_len !== record.body_len) return "bundle_payload_len";
  if (order.request.framing === FRAMING_GET_PUBLIC) {
    return bundle.request === undefined ? undefined : "bundle_request_forbidden";
  }
  if (bundle.request === undefined) return "bundle_request_missing";
  const rp = bundle.request.public;
  if (rp.tls_body_hash_hex !== record.request.sent_body_hash_hex || rp.tls_cred_hash_hex !== record.request.sent_cred_hash_hex) return "bundle_request_hashes";
  if (rp.payer_commitment_hex !== order.request.body_commitment_hex) return "bundle_request_commitment";
  if (rp.body_len !== order.request.body_len || rp.cred_len !== record.request.cred_len) return "bundle_request_lengths";
  return undefined;
}

export interface AttestExpectation {
  readonly order: IntentOrder;
  readonly header: PaymentHeader;
  readonly rail: "x402" | "mpp";
  readonly intentSha256: string;
  readonly releaseSha256: string;
  readonly inboundTx: string;
  /** 実モードは `mozilla-webpki-roots` + external_gate。試験 trust は `lab-fixture-ca`（external_gate false）。 */
  readonly trust: "mozilla" | "lab-fixture-ca";
}

export interface VerifyResultView {
  readonly ok: boolean;
  readonly checks: readonly string[];
}

export function parseVerifyResult(raw: unknown): VerifyResultView | undefined {
  if (!isRecord(raw) || typeof raw["ok"] !== "boolean" || !Array.isArray(raw["checks"]) || !raw["checks"].every((check) => typeof check === "string")) return undefined;
  return { ok: raw["ok"], checks: raw["checks"] as string[] };
}

export type AttestRejection =
  | "trust"
  | "target"
  | "server_name"
  | "order_id"
  | "intent_binding"
  | "framing"
  | "spec"
  | "revealed_prefix"
  | "len_sent"
  | "cred_len"
  | "http_framing"
  | "content_length"
  | "recv_headers"
  | "status_line"
  | "receipt_header"
  | "verify_result"
  | "verify_checks"
  | BindingRejection;

export interface AttestSummary {
  readonly trust: string;
  readonly externalGate: boolean;
  readonly serverName: string;
  readonly requestLine: string;
  readonly lenSent: number;
  readonly bodyLen: number;
  readonly statusLine: string;
  readonly receiptHeaderName: string;
  readonly credLen: number;
}

export type AttestCheck = { readonly ok: true; readonly receipt: { readonly name: string; readonly value: string }; readonly summary: AttestSummary } | { readonly ok: false; readonly reason: AttestRejection };

/** 最終注文の `request`（`payment_header` 付き）を record の `spec` と比べるための形。 */
function specOf(order: IntentOrder, header: PaymentHeader): Record<string, unknown> {
  return {
    framing: order.request.framing,
    method: order.request.method,
    content_type: order.request.content_type,
    body_len: order.request.body_len,
    body_commitment_hex: order.request.body_commitment_hex,
    executor_header: order.request.executor_header,
    max_executor_value_len: order.request.max_executor_value_len,
    payment_header: { name: header.name, value: header.value },
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

/**
 * FR-Z08 の Router 側の検査（設計 §5.4）。Rust の `verifier-verify` が通った後に、record・verify_result・bundle を intent と発行ヘッダに対して確かめる。
 */
export function checkAttest(expect: AttestExpectation, record: VerifierRecord, verify: VerifyResultView, bundle: BundlePublic): AttestCheck {
  const no = (reason: AttestRejection): AttestCheck => ({ ok: false, reason });
  const { order, header } = expect;
  const isGet = order.request.framing === FRAMING_GET_PUBLIC;
  if (expect.trust === "mozilla" ? record.trust !== TRUST_MOZILLA || record.external_gate !== true : record.trust !== TRUST_LAB_FIXTURE || record.external_gate !== false) return no("trust");
  if (record.target.host !== order.target.host || record.target.port !== 443 || record.target.path !== order.target.path) return no("target");
  if (record.server_name !== order.target.host) return no("server_name");
  if (record.order_id !== order.order_id) return no("order_id");
  const binding = record.intent_binding;
  if (
    binding === undefined ||
    binding.intent_sha256 !== expect.intentSha256 ||
    binding.release_sha256 !== expect.releaseSha256 ||
    binding.header_sha256 !== sha256Hex(header.value) ||
    binding.inbound_tx !== expect.inboundTx
  ) {
    return no("intent_binding");
  }
  if (record.request.framing !== order.request.framing) return no("framing");
  if (stableJson(record.request.spec) !== stableJson(specOf(order, header))) return no("spec");
  const prefix = expectedPrefixOf(order.target, order.request, header);
  if (record.request.revealed_prefix !== prefix) return no("revealed_prefix");
  if (isGet) {
    if (record.len_sent !== Buffer.byteLength(prefix, "utf8")) return no("len_sent");
    if (record.request.cred_len !== 0) return no("cred_len");
  } else {
    if (record.request.cred_len < 1 || record.request.cred_len > MAX_CRED) return no("cred_len");
    if (record.len_sent !== Buffer.byteLength(prefix, "utf8") + record.request.cred_len + SEP_LEN + order.request.body_len) return no("len_sent");
    if (!HEX64.test(record.request.sent_body_hash_hex) || !HEX64.test(record.request.sent_cred_hash_hex)) return no("cred_len");
  }
  if (record.http_framing !== HTTP_FRAMING) return no("http_framing");
  if (record.content_length !== record.body_len || record.body_len < 1) return no("content_length");
  const recv = parseRecvHeaders(record.revealed_recv_headers);
  if (recv === undefined) return no("recv_headers");
  if (recv.statusLine !== "HTTP/1.1 200 OK") return no("status_line");
  const receipt = receiptHeaderOf(recv, expect.rail);
  if (receipt === undefined || receipt.value === "") return no("receipt_header");
  if (verify.ok !== true) return no("verify_result");
  if (!verify.checks.includes(CHECK_DELIVERY_PROOF) || (!isGet && !verify.checks.includes(CHECK_REQUEST_PROOF)) || (isGet && verify.checks.includes(CHECK_REQUEST_PROOF))) return no("verify_checks");
  const boundTo = checkBundleBinding(order, record, bundle);
  if (boundTo !== undefined) return no(boundTo);
  const requestLine = prefix.slice(0, prefix.indexOf("\r\n"));
  return {
    ok: true,
    receipt,
    summary: {
      trust: record.trust,
      externalGate: record.external_gate,
      serverName: record.server_name,
      requestLine,
      lenSent: record.len_sent,
      bodyLen: record.body_len,
      statusLine: recv.statusLine,
      receiptHeaderName: receipt.name,
      credLen: record.request.cred_len,
    },
  };
}

/** record の完成時刻（Verifier が書いた安定な値。再起動で動かない。設計 §3.3）。 */
export function recordCompletedAtMsOf(record: VerifierRecord): number {
  return record.tls_accept_unix_ms + record.session_wall_ms;
}
