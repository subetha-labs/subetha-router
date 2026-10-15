/**
 * 診断の記録の共有の部品（設計 `docs/rejection-reasons-design.md` §2.2・§3、§12〜§15 が優先。要件 FR-R1〜R8・SR-R1〜R5）。
 *
 * - 記録の形（版 1）は閉じた値の集合だけ（literal の union と実行時の `validateDiagRecord` の両方で縛る）。相手の自由な文字列・本文・
 *   ヘッダの値・URL・例外の message は置き場が無い（SR-R1）。秘密（鍵・署名・credential・nonce・quoteId）は hash にしてからでないと残らない（SR-R2）。
 * - **hook が同期で行うのは 1 回の push だけ**（§13.1・§15.1）: 呼び出し側は手元の値を `DiagCapture` に写して `emit` する。sink は
 *   `snapshotCapture` で凍結した写しと、その時点の scope の参照を有界の環に積むだけ。分類（理由の表）・hash・検査・JSON 化は
 *   後回しの処理（`buildDiagRecord`）で行う。生の値は環の中のメモリにだけあり、処理・捨てる・失敗のどの経路でも手放す。
 * - scope は `AsyncLocalStorage`（§2.3 D-2、§12.6）。購入の入口で作り、段ごとに入れ子にする。**積む時点** の scope を写す（後の処理で今の scope を読まない）。
 *
 * 純粋（`node:fs` を使わない。`node:crypto` の hash・`node:async_hooks`・viem の keccak256 だけ）。ファイルの sink は `diagnostics-file.ts`。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { keccak256 } from "viem";

import { assetKeyOf, KNOWN_NETWORKS } from "./networks.js";
import { classifyReason, REASON_MANIFEST, REASON_TABLE_VERSION, REASON_TOKENS, type ReasonClass } from "./payment-reasons.js";

/* ──────────────────────────────────────────────────────────────────────────────
 * 閉じた値の集合
 * ────────────────────────────────────────────────────────────────────────────── */

export const DIAG_COMPONENTS = ["router", "facilitator", "signer", "driver", "sink"] as const;
export type DiagComponent = (typeof DIAG_COMPONENTS)[number];

/** Router の段（§3。§12.2 で `dest_reject_body` はやめた）。 */
export const ROUTER_STAGES = [
  "source_verify",
  "source_settle",
  "dynamic_precheck",
  "dest_challenge",
  "dest_sign",
  "dest_pay_request",
  "dest_outcome",
  "transport_event",
] as const;
export const FACILITATOR_STAGES = ["verify", "settle", "rpc"] as const;
/** 署名の道具と driver の段（同じ集合）。 */
export const SIGNER_STAGES_OF_RECORD = ["sign", "purchase_call", "status_call"] as const;
export const SINK_STAGES = ["counters"] as const;
export type DiagStage =
  | (typeof ROUTER_STAGES)[number]
  | (typeof FACILITATOR_STAGES)[number]
  | (typeof SIGNER_STAGES_OF_RECORD)[number]
  | (typeof SINK_STAGES)[number];

/** component ごとに許す段。 */
export const STAGES_OF_COMPONENT: Readonly<Record<DiagComponent, readonly DiagStage[]>> = Object.freeze({
  router: ROUTER_STAGES,
  facilitator: FACILITATOR_STAGES,
  signer: SIGNER_STAGES_OF_RECORD,
  driver: SIGNER_STAGES_OF_RECORD,
  sink: SINK_STAGES,
});

/** `TransportCode`（`src/net/guarded-fetch.ts`）の 7 つ。同じであることは試験が型で固定する。 */
export const DIAG_TRANSPORT_CODES = [
  "destination_blocked",
  "dns_failed",
  "connect_failed",
  "upstream_timeout",
  "aborted",
  "admission_refused",
  "transport_failed",
] as const;
export type DiagTransportCode = (typeof DIAG_TRANSPORT_CODES)[number];

/** transport の operation の閉じた集合（`src/`・`tools/` の literal）。集合の外は `other` に読み替える。 */
export const DIAG_OPS = [
  "facilitator_verify",
  "facilitator_settle",
  "facilitator_challenge",
  "facilitator_supported",
  "challenge",
  "pay_challenge",
  "pay",
  "rpc",
  "estimate_rpc",
  "read_challenge",
  "svm_settle_follow_up",
  "mpp_solana_follow_up",
  "mpp_solana_send",
  "mpp_solana_send_recovery",
  "mpp_solana_ata",
  "mpp_solana_blockhash",
  "mpp_solana_get_transaction",
  "mpp_solana_receipt",
  "mpp_solana_startup",
  "solana_rpc_ata",
  "solana_rpc_balance",
  "solana_rpc_blockhash",
  "other",
] as const;
export type DiagOp = (typeof DIAG_OPS)[number];

export const DIAG_FACILITATORS = ["x402", "circle", "self"] as const;
export const DIAG_RESPONSES = [
  // verify
  "valid",
  "invalid",
  // settle
  "ok",
  "success_false",
  "network_mismatch",
  "tx_malformed",
  // 共通
  "not_json",
  "http_error",
  "proof_refused",
] as const;
export const DIAG_RECEIPTS = ["absent", "malformed", "failed", "network_mismatch", "tx_malformed", "payer_mismatch", "ok"] as const;
export const DIAG_RECEIPT_HEADERS = ["payment-response", "x-payment-response", "none"] as const;
export const DIAG_REASON_FIELDS = ["invalidReason", "errorReason", "error"] as const;
export const DIAG_REASON_SOURCES = ["facilitator_body", "payment_required_header", "payment_response_header", "response_body"] as const;
/** 決まった結果の写し（§3、§12.7 で `signed` を足した）。 */
export const DIAG_OUTCOMES = ["settled", "rejected", "unknown", "valid", "invalid", "paid", "paid_no_data", "not_sent", "awaiting", "threw", "signed"] as const;
export const DIAG_RPC_CLASSES = ["timeout", "rate_limited", "other"] as const;
/** §12.4: 手元で計算した tx の hash と RPC の結果の一致（RPC の結果そのものは残さない）。 */
export const DIAG_TX_REF_CHECKS = ["match", "mismatch", "absent"] as const;
export const DIAG_BROADCASTS = ["not_observed", "attempted", "accepted", "rpc_error", "http_error", "timeout"] as const;
/** 署名の道具の段（§6、§12.7 の `signerStage`）。 */
export const DIAG_SIGNER_STAGES = ["dispatch", "refused", "key_read", "payer_create", "disclosure_written", "pay_and_credential", "credential_for", "envelope", "done"] as const;
export type DiagSignerStage = (typeof DIAG_SIGNER_STAGES)[number];

/** `KNOWN_NETWORKS` の id と `unrecognized`。 */
export const DIAG_NETWORKS: readonly string[] = Object.freeze([...KNOWN_NETWORKS.map((entry) => entry.network), "unrecognized"]);

/**
 * Router の固定の code（§3）: 公開の理由（`SAFE_REASONS`）・動的の awaiting・`not_sent`・core と adapter の固定の理由・
 * `DynamicChallengeError` の 9 つ・challenge の既定（`challenge_invalid`）・facilitator の期限（`deadline`）。集合の外は `unrecognized` に読み替える。
 * 集合が元の literal を含むことは試験（`tests/unit/diagnostics.test.ts`）がソースから抜き出して確かめる。
 */
const ROUTER_CODES = [
  // SAFE_REASONS（src/core/orchestrator.ts）
  "quote_changed",
  "offer_changed",
  "offer_unavailable",
  "verify_failed",
  "source_rejected",
  "source_settle_unknown",
  "source_verify_unavailable",
  "source_paid_unsettled",
  "destination_rejected",
  "destination_pay_unknown",
  "paid_data_unavailable",
  "interrupted_at_restart",
  "purchase_count_limit",
  "per_purchase_limit",
  "bucket_limit",
  "bucket_not_allowed",
  "invalid_amount",
  "invalid_budget_limit",
  "approval_expired",
  "unsupported_response",
  "response_too_large",
  "destination_fee_cap_invalid",
  "destination_send_refused_before_dispatch",
  "destination_deadline",
  "destination_offer_changed",
  "destination_offer_not_allowed",
  "destination_challenge_unreadable",
  "destination_signer_network_mismatch",
  "destination_reservation_unsupported",
  "destination_ata_missing",
  "destination_blockhash_unavailable",
  "destination_blockhash_stale",
  "destination_memo_invalid",
  "destination_message_mismatch",
  "destination_message_collision",
  "destination_message_record_unavailable",
  "destination_not_signed",
  "destination_payload_mismatch",
  "destination_receipt_unverified",
  "destination_receipt_payer_mismatch",
  // 動的の awaiting・昇格・quote の code（src/core/dynamic.ts ほか）
  "operator_funds_unavailable",
  "fee_estimate_unavailable",
  "fee_too_high",
  "budget_unavailable",
  "dynamic_unavailable",
  "dynamic_disabled",
  // 購入・quote の拒否の code（src/core/*.ts の `code: "…"`）
  "approval_required",
  "in_progress",
  "invalid_upstream_body",
  "invalid_upstream_url",
  "payment_required",
  "preflight_unavailable",
  "quote_failed",
  "quote_unreadable",
  "rate_limited",
  "request_id_conflict",
  "route_mismatch",
  "source_terms_mismatch",
  "unknown_quote",
  "unknown_route",
  // not_sent の手元の理由（src/adapters/outbound/*）
  "destination_capability_unsupported",
  "destination_network_unsupported",
  "destination_offer_expired",
  "destination_offer_unbound",
  "destination_resource_mismatch",
  "destination_selected_offer_mismatch",
  "destination_unsupported_mode",
  "upstream_method_unsupported",
  // preflight（SAFE_PREFLIGHT_REASONS）
  "nonce_mismatch",
  "offer_expired",
  "offer_mismatch",
  "route_binding_mismatch",
  "credential_mismatch",
  // DynamicChallengeError.reason（src/adapters/outbound/x402-dynamic.ts）
  "url",
  "status",
  "no_header",
  "undecodable",
  "version",
  "no_offers",
  "too_many_offers",
  "resource_mismatch",
  "method",
  // challenge の読み直しの既定・facilitator の期限（§4.3・§5.3）
  "challenge_invalid",
  "deadline",
] as const;

/** `code` に許す値: Router の固定の code ∪ 自前の facilitator の code（理由の表の `self_facilitator` 節）∪ 署名の道具の段 ∪ `unrecognized`。 */
export const DIAG_CODES: ReadonlySet<string> = new Set<string>([
  ...ROUTER_CODES,
  ...REASON_MANIFEST.filter((entry) => entry.section === "self_facilitator").map((entry) => entry.raw),
  ...DIAG_SIGNER_STAGES,
  "unrecognized",
]);

/** sink の数（`component:"sink", stage:"counters"` の行の `counters` の鍵。固定）。 */
export const DIAG_COUNTER_KEYS = [
  "written",
  "droppedQueueFull",
  "droppedEntryTooLarge",
  "droppedRingBytes",
  "droppedSchema",
  "droppedLineTooLarge",
  "droppedPerKey",
  "droppedRate",
  "droppedClosed",
  "droppedAfterRotateFailure",
  "writeFailed",
  "rotateFailed",
  "processFailed",
  "pushFailed",
] as const;
export type DiagCounterKey = (typeof DIAG_COUNTER_KEYS)[number];
export type DiagCounters = { readonly [K in DiagCounterKey]: number };

/* ──────────────────────────────────────────────────────────────────────────────
 * 記録の形（版 1、ファイルの 1 行）
 * ────────────────────────────────────────────────────────────────────────────── */

export interface DiagRecord {
  readonly v: 1;
  /** ISO 8601 UTC（ミリ秒、`Z`）。push の時刻。 */
  readonly at: string;
  /** process の中の連番（push の順。捨てた分は欠番になる）。 */
  readonly seq: number;
  readonly component: DiagComponent;
  readonly stage: DiagStage;
  readonly paymentId?: string;
  readonly attempt?: number;
  /** §12.1: `quoteId` の hash（16 hex）。 */
  readonly quoteHash?: string;
  readonly requestHash?: string;
  readonly cid?: string;
  readonly promoted?: boolean;
  readonly routeId?: string;
  readonly network?: string;
  readonly facilitator?: (typeof DIAG_FACILITATORS)[number];
  readonly op?: DiagOp;
  readonly httpStatus?: number;
  readonly transport?: DiagTransportCode;
  readonly response?: (typeof DIAG_RESPONSES)[number];
  readonly receipt?: (typeof DIAG_RECEIPTS)[number];
  readonly receiptHeader?: (typeof DIAG_RECEIPT_HEADERS)[number];
  readonly reasonField?: (typeof DIAG_REASON_FIELDS)[number];
  readonly reasonSource?: (typeof DIAG_REASON_SOURCES)[number];
  readonly reason?: ReasonClass;
  /** `reason` があるときだけ（`REASON_TABLE_VERSION`）。 */
  readonly table?: typeof REASON_TABLE_VERSION;
  readonly outcome?: (typeof DIAG_OUTCOMES)[number];
  readonly code?: string;
  readonly rpc?: (typeof DIAG_RPC_CLASSES)[number];
  readonly rpcHttpStatus?: number;
  readonly rpcCode?: number;
  readonly elapsedMs?: number;
  readonly bytes?: number;
  /** §12.4: 署名の道具が送る raw tx から手元で計算した hash だけ。 */
  readonly txRef?: string;
  readonly txRefCheck?: (typeof DIAG_TX_REF_CHECKS)[number];
  readonly broadcast?: (typeof DIAG_BROADCASTS)[number];
  readonly fundsMayHaveMoved?: boolean;
  readonly signerStage?: DiagSignerStage;
  readonly counters?: DiagCounters;
}

/** EIP-3009 の authorization から `cid` を作る入力（生の値。hash にしてから捨てる）。 */
export interface DiagCidInput {
  readonly network: string;
  readonly asset: string;
  readonly from: string;
  readonly nonce: string;
}

/**
 * hook が積む生の写し（`DiagnosticsSink.emit` の引数）。`component`・`at`・`seq` は sink が付ける。
 * 閉じた値の欄はそのまま記録の欄になり（集合の外なら行ごと捨てる。`network`・`op`・`code` は読み替える）、`raw…` の欄は後回しの処理で
 * 分類・hash にしてから捨てる（ファイルには書かない）。
 */
export interface DiagCapture {
  readonly stage: DiagStage;
  readonly paymentId?: string;
  readonly attempt?: number;
  readonly promoted?: boolean;
  readonly routeId?: string;
  /** 集合の外は `unrecognized`。 */
  readonly network?: string;
  readonly facilitator?: (typeof DIAG_FACILITATORS)[number];
  /** 集合の外は `other`。 */
  readonly op?: string;
  readonly httpStatus?: number;
  readonly transport?: DiagTransportCode;
  readonly response?: (typeof DIAG_RESPONSES)[number];
  readonly receipt?: (typeof DIAG_RECEIPTS)[number];
  readonly receiptHeader?: (typeof DIAG_RECEIPT_HEADERS)[number];
  readonly reasonField?: (typeof DIAG_REASON_FIELDS)[number];
  readonly reasonSource?: (typeof DIAG_REASON_SOURCES)[number];
  readonly outcome?: (typeof DIAG_OUTCOMES)[number];
  /** 集合の外は `unrecognized`。 */
  readonly code?: string;
  readonly rpc?: (typeof DIAG_RPC_CLASSES)[number];
  readonly rpcHttpStatus?: number;
  readonly rpcCode?: number;
  /** `performance.now()` の差（整数のミリ秒に丸める）。 */
  readonly elapsedMs?: number;
  readonly bytes?: number;
  readonly txRefCheck?: (typeof DIAG_TX_REF_CHECKS)[number];
  readonly broadcast?: (typeof DIAG_BROADCASTS)[number];
  readonly fundsMayHaveMoved?: boolean;
  readonly signerStage?: DiagSignerStage;
  /** 相手の理由の生の値（`invalidReason`・`errorReason`・`error`）。表で分類して `reason` にする。欄が無いことを残すなら `null`。 */
  readonly rawReason?: unknown;
  /** `cid` の入力（scope の `cidInput` より優先）。 */
  readonly rawCid?: DiagCidInput;
  /** 手元で計算した tx の hash（`localTxRefOf` の値だけ。component `signer`・`driver` だけが書ける。ほかは行ごと捨てる）。 */
  readonly txRef?: LocalTxRef;
}

/** 互換の名前（設計 §2.2 の `DiagRecordInput`）。 */
export type DiagRecordInput = DiagCapture;

/** 購入・段の scope（生の値。hash は後回しの処理で）。 */
export interface DiagScope {
  readonly paymentId?: string;
  /** 生の `quoteId`。記録には `quoteHash` だけ（§12.1）。 */
  readonly quoteId?: string;
  /** `requestHash` の入力（両方あるときだけ）。 */
  readonly principalId?: string;
  readonly requestId?: string;
  readonly routeId?: string;
  readonly promoted?: boolean;
  readonly attempt?: number;
  readonly cidInput?: DiagCidInput;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * sink の interface
 * ────────────────────────────────────────────────────────────────────────────── */

export interface DiagnosticsSink {
  /** 同期・throw しない・待たない。積むだけ（満杯・上限なら捨てて数える）。 */
  emit(capture: DiagCapture): void;
}

export const NOOP_DIAGNOSTICS: DiagnosticsSink = Object.freeze({
  emit(): void {},
});

/** `build` と `emit` の例外を両方握る。hook はこれだけを呼ぶ（結果を作り終えた後に）。 */
export function safeEmit(sink: DiagnosticsSink | undefined, build: () => DiagCapture): void {
  if (sink === undefined || sink === NOOP_DIAGNOSTICS) return;
  try {
    sink.emit(build());
  } catch {
    // 診断の失敗は支払いの経路に出さない（SR-R3・SR-R4）。
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 量の上限（push の入力。§14.2 のうち主の thread の分）
 * ────────────────────────────────────────────────────────────────────────────── */

/**
 * 量は **バイトの見積り** で数える（保守的な上限）: 文字列は `2 × UTF-16 の長さ`（V8 の 2 バイトの表現の大きさ。UTF-8 にしたときの
 * 大きさではなく、メモリに持つ量の上限）、object は固定の見積り。長さを見るだけなので O(1)（大きな文字列を encode しない）。
 */
export const DIAG_BYTES_PER_CODE_UNIT = 2;
/** 文字列の欄の上限（バイトの見積り）。8 KiB = 4,096 code unit。超えたら写さず印だけにする。 */
export const DIAG_MAX_STRING_BYTES = 8 * 1024;
/** 1 件の固定の見積り（凍結した object・固定の欄の数値と参照・環の枠）。 */
export const DIAG_ENTRY_OVERHEAD = 512;
/** 入れ子の object（`rawCid`・`cidInput`）1 つの固定の見積り。 */
export const DIAG_OBJECT_OVERHEAD = 64;
/** scope の 1 枠の固定の見積り。 */
export const DIAG_SCOPE_OVERHEAD = 256;

/** 文字列のバイトの見積り（O(1)）。 */
export function diagStringBytes(value: string): number {
  return DIAG_BYTES_PER_CODE_UNIT * value.length;
}

/** 大きすぎた文字列の印（写さない。分類では `malformed`、hash の入力なら欄を書かない）。 */
export const OVERSIZE: unique symbol = Symbol("diag-oversize");
/** 型の違う値の印（閉じた欄なら後回しの処理で行ごと捨てる。生の理由なら `malformed`）。値そのもの（関数・object）は持たない。 */
export const INVALID: unique symbol = Symbol("diag-invalid");

declare const LOCAL_TX_REF: unique symbol;
/**
 * 手元で計算した tx の hash（§12.4）。`localTxRefOf` だけが作れる（型の brand と、作った object を覚える WeakSet の両方で縛る）。
 * 記録に `txRef` を書けるのは component `signer`・`driver` だけ。
 */
export interface LocalTxRef {
  readonly [LOCAL_TX_REF]: true;
  readonly hash: string;
}
const issuedTxRefs = new WeakSet<object>();
const SIGNED_TX_HEX = /^0x(?:[0-9a-fA-F]{2})+$/;

/** 送る署名済みの raw tx（bytes か `0x` の hex）から keccak256 を計算して、`txRef` に渡せる唯一の値を作る。 */
export function localTxRefOf(signedTransaction: Uint8Array | `0x${string}`): LocalTxRef {
  if (typeof signedTransaction === "string" ? !SIGNED_TX_HEX.test(signedTransaction) : !(signedTransaction instanceof Uint8Array) || signedTransaction.byteLength === 0) {
    throw new TypeError("localTxRefOf needs the signed transaction bytes");
  }
  const ref = Object.freeze({ hash: keccak256(signedTransaction).toLowerCase() }) as unknown as LocalTxRef;
  issuedTxRefs.add(ref);
  return ref;
}

/** 凍結した写し（固定の欄だけ。値は primitive か印か凍結した `rawCid`）。 */
export type CapturedValue = string | number | boolean | null | typeof OVERSIZE | typeof INVALID | Readonly<Record<"network" | "asset" | "from" | "nonce", string>>;
export type CapturedFields = Readonly<Record<string, CapturedValue>>;

/** 凍結した写しと、その見積りの量（バイト）。 */
export interface CaptureSnapshot {
  readonly value: CapturedFields;
  readonly cost: number;
}

type FieldKind = "string" | "number" | "boolean";
/** 写す欄（固定）。これ以外の欄は読まない（列挙もしない）。 */
const CAPTURE_FIELDS: ReadonlyArray<readonly [string, FieldKind]> = [
  ["stage", "string"],
  ["paymentId", "string"],
  ["attempt", "number"],
  ["promoted", "boolean"],
  ["routeId", "string"],
  ["network", "string"],
  ["facilitator", "string"],
  ["op", "string"],
  ["httpStatus", "number"],
  ["transport", "string"],
  ["response", "string"],
  ["receipt", "string"],
  ["receiptHeader", "string"],
  ["reasonField", "string"],
  ["reasonSource", "string"],
  ["outcome", "string"],
  ["code", "string"],
  ["rpc", "string"],
  ["rpcHttpStatus", "number"],
  ["rpcCode", "number"],
  ["elapsedMs", "number"],
  ["bytes", "number"],
  ["txRefCheck", "string"],
  ["broadcast", "string"],
  ["fundsMayHaveMoved", "boolean"],
  ["signerStage", "string"],
];
/** 写す欄の数（固定。`rawReason`・`rawCid`・`txRef` を含む）。push の仕事はこの数の読み取りで上限がある。 */
export const DIAG_CAPTURE_FIELD_COUNT = CAPTURE_FIELDS.length + 3;

/** 4 つの文字列だけを写す（型が違う・大きすぎれば `undefined`）。 */
function cidCopyOf(value: unknown): { copy: Readonly<Record<"network" | "asset" | "from" | "nonce", string>>; bytes: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const network = source["network"];
  const asset = source["asset"];
  const from = source["from"];
  const nonce = source["nonce"];
  if (typeof network !== "string" || typeof asset !== "string" || typeof from !== "string" || typeof nonce !== "string") return undefined;
  const bytes = diagStringBytes(network) + diagStringBytes(asset) + diagStringBytes(from) + diagStringBytes(nonce);
  for (const s of [network, asset, from, nonce]) if (diagStringBytes(s) > DIAG_MAX_STRING_BYTES) return undefined;
  return { copy: Object.freeze({ network, asset, from, nonce }), bytes: bytes + DIAG_OBJECT_OVERHEAD };
}

/**
 * push の時点の写し。**固定の欄だけ** を名前で読み（列挙しない。余分な欄・proxy の余分な鍵は読まない）、期待する primitive の型の値だけを写す。
 * 型の違う値は `INVALID`（関数・object を持たない）、大きすぎる文字列は `OVERSIZE`。生の理由は文字列か `null`（欄なし）だけを写し、
 * それ以外は `INVALID`（分類で `malformed`）。`txRef` は `localTxRefOf` が作った値だけ。読み取りの例外（getter・proxy）はそのまま投げる
 * （sink の push が握って数える）。仕事は `DIAG_CAPTURE_FIELD_COUNT` 回の読み取りと長さの比較だけ。
 */
export function snapshotCapture(capture: DiagCapture): CaptureSnapshot {
  if (typeof capture !== "object" || capture === null) return { value: Object.freeze({ stage: INVALID }), cost: DIAG_ENTRY_OVERHEAD };
  const source = capture as unknown as Record<string, unknown>;
  let cost = DIAG_ENTRY_OVERHEAD;
  const out: Record<string, CapturedValue> = {};
  for (const [key, kind] of CAPTURE_FIELDS) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== kind) {
      out[key] = INVALID;
    } else if (kind === "string") {
      const bytes = diagStringBytes(value as string);
      if (bytes > DIAG_MAX_STRING_BYTES) {
        out[key] = INVALID; // 閉じた欄に大きな文字列は来ない
      } else {
        cost += bytes;
        out[key] = value as string;
      }
    } else {
      out[key] = value as number | boolean;
    }
  }
  const reason = source["rawReason"];
  if (reason !== undefined || Object.prototype.hasOwnProperty.call(source, "rawReason")) {
    if (reason === null || reason === undefined) out["rawReason"] = null;
    else if (typeof reason !== "string") out["rawReason"] = INVALID;
    else if (diagStringBytes(reason) > DIAG_MAX_STRING_BYTES) out["rawReason"] = OVERSIZE;
    else {
      cost += diagStringBytes(reason);
      out["rawReason"] = reason;
    }
  }
  const rawCid = source["rawCid"];
  if (rawCid !== undefined) {
    const cid = cidCopyOf(rawCid);
    if (cid === undefined) out["rawCid"] = OVERSIZE;
    else {
      cost += cid.bytes;
      out["rawCid"] = cid.copy;
    }
  }
  const txRef = source["txRef"];
  if (txRef !== undefined) {
    if (typeof txRef === "object" && txRef !== null && issuedTxRefs.has(txRef)) {
      const hash = (txRef as LocalTxRef).hash;
      cost += diagStringBytes(hash);
      out["txRef"] = hash;
    } else {
      out["txRef"] = INVALID;
    }
  }
  return { value: Object.freeze(out), cost };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * scope（AsyncLocalStorage）
 * ────────────────────────────────────────────────────────────────────────────── */

/** 積む時点の scope（凍結。固定の欄だけ。量の見積りつき）。 */
export interface DiagScopeFrame {
  readonly values: Readonly<DiagScope>;
  readonly cost: number;
}

const scopeStorage = new AsyncLocalStorage<DiagScopeFrame>();

const SCOPE_STRING_FIELDS = ["paymentId", "quoteId", "principalId", "requestId", "routeId"] as const;

/**
 * scope を固定の欄だけにする（型の違う値・大きすぎる文字列・知らない欄は入れない。object は `cidInput` の 4 つの文字列の写しだけ）。
 * `base` は今の scope（既に固定の欄だけ）。
 */
function sanitizeScope(scope: DiagScope, base: Readonly<DiagScope> | undefined): DiagScopeFrame {
  const source = (typeof scope === "object" && scope !== null ? scope : {}) as Record<string, unknown>;
  const prior = (base ?? {}) as Record<string, unknown>;
  let cost = DIAG_SCOPE_OVERHEAD;
  const out: Record<string, unknown> = {};
  for (const key of SCOPE_STRING_FIELDS) {
    const given = source[key];
    const value = typeof given === "string" && diagStringBytes(given) <= DIAG_MAX_STRING_BYTES ? given : given === undefined ? prior[key] : undefined;
    if (typeof value === "string") {
      cost += diagStringBytes(value);
      out[key] = value;
    }
  }
  const promoted = source["promoted"] === undefined ? prior["promoted"] : source["promoted"];
  if (typeof promoted === "boolean") out["promoted"] = promoted;
  const attempt = source["attempt"] === undefined ? prior["attempt"] : source["attempt"];
  if (typeof attempt === "number") out["attempt"] = attempt;
  const givenCid = source["cidInput"];
  const cid = givenCid === undefined ? (prior["cidInput"] === undefined ? undefined : cidCopyOf(prior["cidInput"])) : cidCopyOf(givenCid);
  if (cid !== undefined) {
    cost += cid.bytes;
    out["cidInput"] = cid.copy;
  }
  return Object.freeze({ values: Object.freeze(out) as Readonly<DiagScope>, cost });
}

/**
 * 今の scope に `scope` を重ねて `fn` を動かす（`AsyncLocalStorage.run`）。返り値と例外はそのまま（同期の throw も同期のまま）。
 */
export function withDiagnosticScope<T>(scope: DiagScope, fn: () => Promise<T>): Promise<T> {
  let merged: DiagScopeFrame;
  try {
    merged = sanitizeScope(scope, scopeStorage.getStore()?.values);
  } catch {
    // getter・proxy が投げても支払いの経路は止めない（今の scope のまま動かす）。
    return fn();
  }
  return scopeStorage.run(merged, fn);
}

/** 今の scope（無ければ `undefined`）。 */
export function currentDiagnosticScope(): Readonly<DiagScope> | undefined {
  return scopeStorage.getStore()?.values;
}

/** sink が push の時点で写す scope の参照（凍結済み。O(1)）。 */
export function currentDiagnosticScopeFrame(): DiagScopeFrame | undefined {
  return scopeStorage.getStore();
}

/* ──────────────────────────────────────────────────────────────────────────────
 * hash（domain を分けた sha256 の先頭 16 hex）
 * ────────────────────────────────────────────────────────────────────────────── */

function hash16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * 診断用の id（§5.2）: `sha256("subetha-diag-cid/v1|" + network + "|" + assetKeyOf(network, asset) + "|" + from 小文字 + "|" + nonce 小文字)` の先頭 16 hex。
 * 入力は自前の facilitator の `identify` の `key`（`tools/evm-facilitator.ts`）と同じ 4 つ・同じ正規化（試験で固定）。結びつけの hash で、匿名化の保証ではない。
 */
export function diagCorrelationIdOf(network: string, asset: string, from: string, nonce: string): string {
  return hash16(`subetha-diag-cid/v1|${network}|${assetKeyOf(network, asset)}|${from.toLowerCase()}|${nonce.toLowerCase()}`);
}

/** §12.1: `quoteId` の hash（動的の受信では `quoteId` が authorization の nonce と同じなので、そのままは残さない）。 */
export function quoteHashOf(quoteId: string): string {
  return hash16(`subetha-diag-quote/v1|${quoteId.toLowerCase()}`);
}

/** §3: `requestId` は呼び出し側の自由な文字列なので hash にする。 */
export function requestHashOf(principalId: string, requestId: string): string {
  return hash16(`subetha-diag-req/v1|${principalId}|${requestId}`);
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 検査（閉じた値の集合。知らない鍵・集合の外の値・形の違う文字列が 1 つでもあれば行ごと捨てる）
 * ────────────────────────────────────────────────────────────────────────────── */

const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PAYMENT_ID = /^[0-9a-f-]{36}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const ROUTE_ID = /^[A-Za-z0-9._@:-]{1,96}$/;
const TX_REF = /^0x[0-9a-f]{64}$/;

const inSet =
  (values: readonly string[] | ReadonlySet<string>) =>
  (value: unknown): boolean =>
    typeof value === "string" && (Array.isArray(values) ? values.includes(value) : (values as ReadonlySet<string>).has(value));
const intIn =
  (min: number, max: number) =>
  (value: unknown): boolean =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const matches =
  (pattern: RegExp) =>
  (value: unknown): boolean =>
    typeof value === "string" && pattern.test(value);
const isBool = (value: unknown): boolean => typeof value === "boolean";

const REASON_VALUES: ReadonlySet<string> = new Set<string>([...REASON_TOKENS, "absent", "malformed", "unrecognized"]);

function isCounters(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== DIAG_COUNTER_KEYS.length) return false;
  return DIAG_COUNTER_KEYS.every((k) => intIn(0, Number.MAX_SAFE_INTEGER)((value as Record<string, unknown>)[k]));
}

const FIELD_CHECKS: Readonly<Record<keyof DiagRecord, (value: unknown) => boolean>> = {
  v: (value) => value === 1,
  at: matches(ISO_AT),
  seq: intIn(0, Number.MAX_SAFE_INTEGER),
  component: inSet(DIAG_COMPONENTS),
  stage: () => true, // component との組で下で見る
  paymentId: matches(PAYMENT_ID),
  attempt: intIn(1, 1000),
  quoteHash: matches(HEX16),
  requestHash: matches(HEX16),
  cid: matches(HEX16),
  promoted: isBool,
  routeId: matches(ROUTE_ID),
  network: inSet(DIAG_NETWORKS),
  facilitator: inSet(DIAG_FACILITATORS),
  op: inSet(DIAG_OPS),
  httpStatus: intIn(100, 599),
  transport: inSet(DIAG_TRANSPORT_CODES),
  response: inSet(DIAG_RESPONSES),
  receipt: inSet(DIAG_RECEIPTS),
  receiptHeader: inSet(DIAG_RECEIPT_HEADERS),
  reasonField: inSet(DIAG_REASON_FIELDS),
  reasonSource: inSet(DIAG_REASON_SOURCES),
  reason: inSet(REASON_VALUES),
  table: (value) => value === REASON_TABLE_VERSION,
  outcome: inSet(DIAG_OUTCOMES),
  code: inSet(DIAG_CODES),
  rpc: inSet(DIAG_RPC_CLASSES),
  rpcHttpStatus: intIn(100, 599),
  rpcCode: intIn(-(2 ** 31), 2 ** 31),
  elapsedMs: intIn(0, 3_600_000),
  bytes: intIn(0, 2 ** 31),
  txRef: matches(TX_REF),
  txRefCheck: inSet(DIAG_TX_REF_CHECKS),
  broadcast: inSet(DIAG_BROADCASTS),
  fundsMayHaveMoved: isBool,
  signerStage: inSet(DIAG_SIGNER_STAGES),
  counters: isCounters,
};

/** 記録の欄の順（JSON の鍵の順。検査の鍵の集合でもある）。 */
export const DIAG_RECORD_KEYS = Object.freeze(Object.keys(FIELD_CHECKS) as Array<keyof DiagRecord>);

/**
 * 閉じた値の集合での検査。通れば同じ object（型つき）、1 つでも外れれば `undefined`（読み替えはしない）。
 * 必須: `v`・`at`・`seq`・`component`・`stage`（component に合う段）。`table` は `reason` があるときだけ・必ず。`counters` は sink の行だけ・必ず。
 */
export function validateDiagRecord(value: unknown): DiagRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const check = (FIELD_CHECKS as Record<string, ((v: unknown) => boolean) | undefined>)[key];
    if (check === undefined || !Object.prototype.hasOwnProperty.call(FIELD_CHECKS, key)) return undefined;
    if (!check(record[key])) return undefined;
  }
  for (const required of ["v", "at", "seq", "component", "stage"]) {
    if (!(required in record)) return undefined;
  }
  const component = record["component"] as DiagComponent;
  if (!(STAGES_OF_COMPONENT[component] as readonly string[]).includes(record["stage"] as string)) return undefined;
  if (("reason" in record) !== ("table" in record)) return undefined;
  if ((component === "sink") !== ("counters" in record)) return undefined;
  // §12.4: tx の hash（と RPC の結果との一致）は署名の道具・driver の手元の計算だけ。Router・facilitator の行には置けない。
  if (("txRef" in record || "txRefCheck" in record) && component !== "signer" && component !== "driver") return undefined;
  return record as unknown as DiagRecord;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 後回しの処理（分類・hash・検査）。ファイルの sink と試験の記録の sink が同じ関数を使う。
 * ────────────────────────────────────────────────────────────────────────────── */

/** 環の 1 件（push の時点の写し）。 */
export interface DiagEntry {
  readonly capture: CapturedFields;
  readonly scope: DiagScopeFrame | undefined;
  /** push の時刻（epoch ms）。 */
  readonly at: number;
  readonly seq: number;
}

const DIRECT_KEYS = [
  "facilitator",
  "httpStatus",
  "transport",
  "response",
  "receipt",
  "receiptHeader",
  "reasonField",
  "reasonSource",
] as const;
const DIRECT_KEYS_AFTER_REASON = ["outcome"] as const;
const DIRECT_KEYS_TAIL = ["rpc", "rpcHttpStatus", "rpcCode"] as const;

function cidOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { network, asset, from, nonce } = input as Record<string, unknown>;
  if (typeof network !== "string" || typeof asset !== "string" || typeof from !== "string" || typeof nonce !== "string") return undefined;
  return diagCorrelationIdOf(network, asset, from, nonce);
}

/**
 * 1 件を記録にする（純粋。生の値はここで分類・hash にして、返す記録には入らない）。検査を通らなければ `undefined`。
 * 欄の値は capture が scope に優先する。
 */
export function buildDiagRecord(entry: DiagEntry, component: DiagComponent): DiagRecord | undefined {
  const c = entry.capture as Record<string, unknown>;
  // 写しは固定の欄だけ（`snapshotCapture`）。型の違った欄（`INVALID`）・大きすぎた閉じた欄があれば行ごと捨てる（読み替えない）。
  // 知らない鍵は写しに入らないので、記録の欄の名前（`cid`・`quoteHash`・`table` など）で hash・分類を迂回することもできない。
  for (const key of Object.keys(c)) {
    if (!CAPTURE_KEYS.has(key)) return undefined;
    if (c[key] === INVALID && key !== "rawReason") return undefined;
  }
  const s = (entry.scope?.values ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { v: 1, at: new Date(entry.at).toISOString(), seq: entry.seq, component, stage: c["stage"] };
  const pick = (key: string): unknown => (c[key] !== undefined ? c[key] : s[key]);
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  put("paymentId", pick("paymentId"));
  put("attempt", pick("attempt"));
  const quoteId = s["quoteId"];
  if (typeof quoteId === "string") out["quoteHash"] = quoteHashOf(quoteId);
  const principalId = s["principalId"];
  const requestId = s["requestId"];
  if (typeof principalId === "string" && typeof requestId === "string") out["requestHash"] = requestHashOf(principalId, requestId);
  put("cid", c["rawCid"] !== undefined ? cidOf(c["rawCid"]) : cidOf(s["cidInput"]));
  put("promoted", pick("promoted"));
  put("routeId", pick("routeId"));
  const network = c["network"];
  if (network !== undefined) out["network"] = typeof network === "string" && DIAG_NETWORKS.includes(network) ? network : "unrecognized";
  const op = c["op"];
  if (op !== undefined) out["op"] = typeof op === "string" && (DIAG_OPS as readonly string[]).includes(op) ? op : "other";
  for (const key of DIRECT_KEYS) put(key, c[key]);
  if ("rawReason" in c) {
    const raw = c["rawReason"];
    out["reason"] = raw === OVERSIZE || raw === INVALID ? "malformed" : classifyReason(raw);
    out["table"] = REASON_TABLE_VERSION;
  }
  for (const key of DIRECT_KEYS_AFTER_REASON) put(key, c[key]);
  const code = c["code"];
  if (code !== undefined) out["code"] = typeof code === "string" && DIAG_CODES.has(code) ? code : "unrecognized";
  for (const key of DIRECT_KEYS_TAIL) put(key, c[key]);
  const elapsed = c["elapsedMs"];
  if (elapsed !== undefined) out["elapsedMs"] = typeof elapsed === "number" && Number.isFinite(elapsed) ? Math.round(elapsed) : elapsed;
  put("bytes", c["bytes"]);
  // txRef は `localTxRefOf` が作った値の hash だけ（写しの時点で確かめた）。component の縛りは検査で。
  put("txRef", c["txRef"]);
  put("txRefCheck", c["txRefCheck"]);
  put("broadcast", c["broadcast"]);
  put("fundsMayHaveMoved", c["fundsMayHaveMoved"]);
  put("signerStage", c["signerStage"]);
  return validateDiagRecord(out);
}

const CAPTURE_KEYS: ReadonlySet<string> = new Set([
  "stage",
  "paymentId",
  "attempt",
  "promoted",
  "routeId",
  "network",
  "facilitator",
  "op",
  "httpStatus",
  "transport",
  "response",
  "receipt",
  "receiptHeader",
  "reasonField",
  "reasonSource",
  "outcome",
  "code",
  "rpc",
  "rpcHttpStatus",
  "rpcCode",
  "elapsedMs",
  "bytes",
  "txRefCheck",
  "broadcast",
  "fundsMayHaveMoved",
  "signerStage",
  "rawReason",
  "rawCid",
  "txRef",
]);

/** 数の初期値（全部 0）。 */
export function zeroCounters(): { -readonly [K in DiagCounterKey]: number } {
  const out = {} as { -readonly [K in DiagCounterKey]: number };
  for (const key of DIAG_COUNTER_KEYS) out[key] = 0;
  return out;
}
