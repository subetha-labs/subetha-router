/**
 * 秘匿購入の intent（Payer が作る `phase5-intent-v1` 封筒）の検査と、最終注文の直列化（設計 `docs/zktls-router-design.md` §5.1、要件 FR-Z20・FR-Z22・FR-Z28）。
 *
 * - 封筒は **Payer が送った正確なバイト列**として扱う。Router は正規化も再直列化もせず、そのバイト列を保存・配布し、sha256 を `intentSha256` とする
 *   （Payer の executor と Router の Verifier が同じバイト列・同じダイジェストを見る）。
 * - 受け付ける形は compact な JSON（`JSON.stringify(JSON.parse(bytes)) === bytes`）だけ: 鍵の重複・余分な空白・別の数値表記を持つバイト列は拒否する
 *   （Rust 側の serde は重複鍵を拒否するので、Router が通して Verifier が落とす食い違いを作らない）。
 * - `order` の検査は lab の `request.rs`（`validate_post_spec`・`validate_get_skeleton`）と同じか、より厳しい。`outbound`・`inbound` は Router の封筒の欄で、
 *   Rust は読まない（core が quote の結果と照合する）。
 * - 失敗の理由は固定語（Payer の値は含めない）。
 */

import { createHash } from "node:crypto";

export const INTENT_VERSION = "phase5-intent-v1";
export const FRAMING_POST_CANONICAL = "phase5-post-json-canonical-v1";
export const FRAMING_GET_PUBLIC = "phase5-get-public-v1";
export const EXECUTOR_HEADER = "X-Lab-Credential";
export const MAX_EXECUTOR_VALUE_LEN = 64;
export const MAX_BODY_BYTES = 512;
export const CANONICAL_POST_PATH = "/select";
/** 封筒の復号後の上限の既定（設定 `maxIntentBytes`）。控え（QuoteLedger）の 1 行 8 KiB に収めるため。 */
export const DEFAULT_MAX_INTENT_BYTES = 2048;
const MAX_PATH_BYTES = 256;

export interface IntentTarget {
  readonly host: string;
  readonly port: 443;
  readonly path: string;
}

/** Rust の `RequestSpec`（`payment_header` 無し）。 */
export interface IntentRequestSpec {
  readonly framing: string;
  readonly method: "GET" | "POST";
  readonly content_type: string;
  readonly body_len: number;
  readonly body_commitment_hex: string;
  readonly executor_header: string;
  readonly max_executor_value_len: number;
}

/** Rust の `Order`（骨格: 支払いヘッダ無し）。 */
export interface IntentOrder {
  readonly order_id: string;
  readonly payer_pk: { readonly x: string; readonly y: string };
  readonly curve: "grumpkin";
  readonly target: IntentTarget;
  readonly request: IntentRequestSpec;
}

export interface IntentOutbound {
  readonly protocol: "x402" | "mpp";
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxAmount: string;
}

export interface IntentInbound {
  readonly network: string;
  readonly asset: string;
  readonly maxTotal: string;
}

export interface ParsedIntent {
  /** 正確なバイト列（保存・配布・ダイジェストの対象）。 */
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly order: IntentOrder;
  readonly method: "GET" | "POST";
  readonly framing: string;
  readonly outbound: IntentOutbound;
  readonly inbound: IntentInbound;
  /** `https://<host><path>`（port 443 は書かない）。 */
  readonly url: string;
}

export type IntentRejection =
  | "intent_too_large"
  | "intent_not_utf8"
  | "intent_not_json"
  | "intent_not_compact"
  | "intent_shape"
  | "intent_version"
  | "order_shape"
  | "order_id"
  | "payer_pk"
  | "curve"
  | "target_host"
  | "target_port"
  | "target_path"
  | "request_shape"
  | "request_payment_header"
  | "request_framing"
  | "request_method"
  | "request_content_type"
  | "request_body_len"
  | "request_body_commitment"
  | "request_executor_header"
  | "request_max_executor_value_len"
  | "request_path"
  | "outbound_shape"
  | "inbound_shape";

export type IntentParse = { readonly ok: true; readonly intent: ParsedIntent } | { readonly ok: false; readonly reason: IntentRejection };

const HEX64 = /^[0-9a-f]{64}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,29})$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CAIP2 = /^[a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,64}$/;
/** 小文字の DNS 名（最後のラベルは数字で始まらない = IPv4 リテラルを除く。`parseUpstreamUrl` の規則に合わせる）。 */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** 絶対 path: `/` で始まる VCHAR の列、クエリ（`?`）・フラグメント（`#`）・空白・制御文字を含まない。 */
const PATH = /^\/[\x21-\x22\x24-\x3e\x40-\x7e]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  const want = [...keys].sort();
  return own.length === want.length && own.every((key, index) => key === want[index]);
}

export function intentSha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `path` が URL として自分自身に正規化されること（`/a/../b`・`/./x`・`%2F` の崩れなどを拒否）。 */
function pathIsCanonical(host: string, path: string): boolean {
  let url: URL;
  try {
    url = new URL(`https://${host}${path}`);
  } catch {
    return false;
  }
  return url.pathname === path && url.search === "" && url.hash === "" && url.hostname === host && url.port === "";
}

/**
 * target の host と path の規則（§5.1。FR-Z28）。`parseIntent` が使うのと同じ判定を、I/O の前に単独で当てたい道具（事前検査）にも公開する。
 * host は小文字の DNS 名（IP リテラル不可）、path は `/` 始まりの VCHAR 列でクエリ・`#`・空白・制御文字を含まず ≤ 256 B、URL として自分自身に正規化される。
 */
export function checkTarget(host: unknown, path: unknown): { readonly ok: true; readonly host: string; readonly path: string } | { readonly ok: false; readonly reason: "target_host" | "target_path" } {
  if (!checkHost(host)) return { ok: false, reason: "target_host" };
  if (!checkPath(host, path)) return { ok: false, reason: "target_path" };
  return { ok: true, host, path };
}
export function checkHost(host: unknown): host is string {
  return typeof host === "string" && HOSTNAME.test(host);
}
export function checkPath(host: string, path: unknown): path is string {
  return typeof path === "string" && path !== "" && Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES && PATH.test(path) && pathIsCanonical(host, path);
}

function checkOrder(raw: unknown): { readonly ok: true; readonly order: IntentOrder; readonly method: "GET" | "POST" } | { readonly ok: false; readonly reason: IntentRejection } {
  const no = (reason: IntentRejection) => ({ ok: false as const, reason });
  if (!isRecord(raw) || !hasExactlyKeys(raw, ["order_id", "payer_pk", "curve", "target", "request"])) return no("order_shape");
  const orderId = raw["order_id"];
  if (typeof orderId !== "string" || !HEX64.test(orderId)) return no("order_id");
  const pk = raw["payer_pk"];
  if (!isRecord(pk) || !hasExactlyKeys(pk, ["x", "y"]) || typeof pk["x"] !== "string" || typeof pk["y"] !== "string" || !HEX64.test(pk["x"]) || !HEX64.test(pk["y"])) return no("payer_pk");
  if (raw["curve"] !== "grumpkin") return no("curve");
  const target = raw["target"];
  if (!isRecord(target) || !hasExactlyKeys(target, ["host", "port", "path"])) return no("target_host");
  const host = target["host"];
  if (!checkHost(host)) return no("target_host");
  // FR-Z28: 試験でも 443 以外は拒否（loopback へは dial の差し替えで届かせる）。
  if (target["port"] !== 443) return no("target_port");
  const path = target["path"];
  if (!checkPath(host, path)) return no("target_path");
  const request = raw["request"];
  if (!isRecord(request)) return no("request_shape");
  if (Object.hasOwn(request, "payment_header")) return no("request_payment_header");
  if (!hasExactlyKeys(request, ["framing", "method", "content_type", "body_len", "body_commitment_hex", "executor_header", "max_executor_value_len"])) return no("request_shape");
  const framing = request["framing"];
  const bodyLen = request["body_len"];
  if (framing === FRAMING_POST_CANONICAL) {
    if (request["method"] !== "POST") return no("request_method");
    if (request["content_type"] !== "application/json") return no("request_content_type");
    if (typeof bodyLen !== "number" || !Number.isInteger(bodyLen) || bodyLen < 1 || bodyLen > MAX_BODY_BYTES) return no("request_body_len");
    if (typeof request["body_commitment_hex"] !== "string" || !HEX64.test(request["body_commitment_hex"])) return no("request_body_commitment");
    if (request["executor_header"] !== EXECUTOR_HEADER) return no("request_executor_header");
    if (request["max_executor_value_len"] !== MAX_EXECUTOR_VALUE_LEN) return no("request_max_executor_value_len");
    // canonical の秘匿 POST は lab の Provider 契約どおり `/select` だけ（Provider C/F）。
    if (path !== CANONICAL_POST_PATH) return no("request_path");
  } else if (framing === FRAMING_GET_PUBLIC) {
    if (request["method"] !== "GET") return no("request_method");
    if (request["content_type"] !== "") return no("request_content_type");
    if (bodyLen !== 0) return no("request_body_len");
    if (request["body_commitment_hex"] !== "") return no("request_body_commitment");
    if (request["executor_header"] !== "") return no("request_executor_header");
    if (request["max_executor_value_len"] !== 0) return no("request_max_executor_value_len");
  } else {
    return no("request_framing");
  }
  const method = request["method"] as "GET" | "POST";
  return {
    ok: true,
    method,
    order: {
      order_id: orderId,
      payer_pk: { x: pk["x"], y: pk["y"] },
      curve: "grumpkin",
      target: { host, port: 443, path },
      request: {
        framing,
        method,
        content_type: request["content_type"] as string,
        body_len: bodyLen as number,
        body_commitment_hex: request["body_commitment_hex"] as string,
        executor_header: request["executor_header"] as string,
        max_executor_value_len: request["max_executor_value_len"] as number,
      },
    },
  };
}

function checkOutbound(raw: unknown): IntentOutbound | undefined {
  if (!isRecord(raw) || !hasExactlyKeys(raw, ["protocol", "network", "asset", "payTo", "maxAmount"])) return undefined;
  const { protocol, network, asset, payTo, maxAmount } = raw;
  if (protocol !== "x402" && protocol !== "mpp") return undefined;
  if (typeof network !== "string" || !CAIP2.test(network)) return undefined;
  if (typeof asset !== "string" || !EVM_ADDRESS.test(asset)) return undefined;
  if (typeof payTo !== "string" || !EVM_ADDRESS.test(payTo)) return undefined;
  if (typeof maxAmount !== "string" || !AMOUNT.test(maxAmount) || maxAmount === "0") return undefined;
  return { protocol, network, asset, payTo, maxAmount };
}

function checkInbound(raw: unknown): IntentInbound | undefined {
  if (!isRecord(raw) || !hasExactlyKeys(raw, ["network", "asset", "maxTotal"])) return undefined;
  const { network, asset, maxTotal } = raw;
  if (typeof network !== "string" || !CAIP2.test(network)) return undefined;
  if (typeof asset !== "string" || !EVM_ADDRESS.test(asset)) return undefined;
  if (typeof maxTotal !== "string" || !AMOUNT.test(maxTotal) || maxTotal === "0") return undefined;
  return { network, asset, maxTotal };
}

/**
 * 封筒のバイト列を検査する（I/O なし）。通れば `ParsedIntent`（バイト列・ダイジェスト・読んだ値）。
 */
export function parseIntent(bytes: Uint8Array, options: { readonly maxBytes?: number } = {}): IntentParse {
  const no = (reason: IntentRejection): IntentParse => ({ ok: false, reason });
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_INTENT_BYTES;
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return no("intent_too_large");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return no("intent_not_utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return no("intent_not_json");
  }
  if (!isRecord(parsed)) return no("intent_shape");
  // compact で鍵の重複が無いことを、再直列化との一致で確かめる（重複鍵は後勝ちで消えるので一致しない）。
  if (JSON.stringify(parsed) !== text) return no("intent_not_compact");
  if (!hasExactlyKeys(parsed, ["version", "order", "outbound", "inbound"])) return no("intent_shape");
  if (parsed["version"] !== INTENT_VERSION) return no("intent_version");
  const order = checkOrder(parsed["order"]);
  if (!order.ok) return no(order.reason);
  const outbound = checkOutbound(parsed["outbound"]);
  if (outbound === undefined) return no("outbound_shape");
  const inbound = checkInbound(parsed["inbound"]);
  if (inbound === undefined) return no("inbound_shape");
  const copy = Buffer.from(bytes);
  return {
    ok: true,
    intent: {
      bytes: copy,
      sha256: intentSha256Of(copy),
      order: order.order,
      method: order.method,
      framing: order.order.request.framing,
      outbound,
      inbound,
      url: `https://${order.order.target.host}${order.order.target.path}`,
    },
  };
}

export interface PaymentHeader {
  readonly name: string;
  readonly value: string;
}

/** 最終注文 = 骨格注文 + 発行ヘッダ（FR-Z22）。Rust の `Order` 構造体のフィールド順で組む。 */
export function finalOrderOf(order: IntentOrder, header: PaymentHeader): Record<string, unknown> {
  return {
    order_id: order.order_id,
    payer_pk: { x: order.payer_pk.x, y: order.payer_pk.y },
    curve: order.curve,
    target: { host: order.target.host, port: order.target.port, path: order.target.path },
    request: {
      framing: order.request.framing,
      method: order.request.method,
      content_type: order.request.content_type,
      body_len: order.request.body_len,
      body_commitment_hex: order.request.body_commitment_hex,
      executor_header: order.request.executor_header,
      max_executor_value_len: order.request.max_executor_value_len,
      payment_header: { name: header.name, value: header.value },
    },
  };
}

/** 最終注文のバイト列（compact JSON。Verifier の `--order` と Payer の `payer-finalize-order` の出力が同じ値になる）。 */
export function finalOrderBytesOf(order: IntentOrder, header: PaymentHeader): Buffer {
  return Buffer.from(JSON.stringify(finalOrderOf(order, header)), "utf8");
}

/** `payer-finalize-order --payment-header-file` の内容（`main.rs`: `order_id`・`intent_sha256`・`name`・`value`）。 */
export function headerFileOf(intent: Pick<ParsedIntent, "sha256" | "order">, header: PaymentHeader): { order_id: string; intent_sha256: string; name: string; value: string } {
  return { order_id: intent.order.order_id, intent_sha256: intent.sha256, name: header.name, value: header.value };
}
