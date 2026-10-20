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
import { paymentRequiredErrorOf, receiptClassOfHeader, receiptFormOf } from "./x402-receipt.js";

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
  // 秘匿購入の探り（未払いの 402 の読み取り）と Tempo の読取 RPC（`src/adapters/outbound/private-*.ts`）
  "private_probe",
  "private_rpc",
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
  // 自前の facilitator の RPC（`tools/evm-facilitator.ts` の `FacilitatorRpcOp`。§5.3、タスク R-5）
  "authorization_state",
  "block_number",
  "block_timestamp",
  "authorization_used_logs",
  "receipt",
  "wait_for_receipt",
  "fees_per_gas",
  "estimate_transfer_gas",
  "transfer_with_authorization",
  "reconcile",
  "sdk_verify",
  "sdk_read_contract",
  "sdk_verify_typed_data",
  "sdk_get_code",
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
  // 秘匿購入（`docs/zktls-router-design.md` §7・§8。SAFE_REASONS の追加分、core/private.ts の code・終端理由）
  "attest_closed",
  "attest_expired",
  "attest_foreign",
  "attest_in_progress",
  "attest_not_ready",
  "bundle_too_large",
  "intent_mismatch",
  "intent_too_large",
  "interrupted_after_release",
  "interrupted_before_handover",
  "interrupted_before_release",
  "invalid_bundle",
  "invalid_intent",
  "not_found",
  "private_attest_invalid",
  "private_attest_timeout",
  "private_capacity",
  "private_credential_lifetime",
  "private_disabled",
  "private_handover_unknown",
  "private_header_invalid",
  "private_inbound_identity_missing",
  "private_issuance_duplicate",
  "private_issuance_unknown",
  "private_issue_failed",
  "private_receipt_mismatch",
  "private_record_unknown",
  "private_release_unknown",
  "private_session_timeout",
  "private_unavailable",
  "private_verifier_unavailable",
  "private_verify_timeout",
  "record_corrupt",
  "record_expired",
  "record_mismatch",
  "record_not_available",
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
  /**
   * RPC の例外の写し（`DiagRpcErrorSnapshot`。§5.3、タスク R-5）。後回しの処理で `classifyRpcSnapshot` が `rpc`・`rpcHttpStatus`・`rpcCode`・
   * `code`（`deadline`）にする（hook では分類しない: §13.1・§15.1）。明示の `rpc` などの欄があればそちらが優先。
   */
  readonly rawRpc?: DiagRpcErrorSnapshot;
  /**
   * 送信の領収の分類の入力（§4.3、タスク R-4）。hook はヘッダの文字列（`PAYMENT-RESPONSE` → `X-PAYMENT-RESPONSE` の順に選んだもの）を写すだけで、
   * decode と 7 つの分類（`receiptClassOfHeader`）は後回しの処理でする。`receiptForm` があるときだけ `receipt` を書く（ヘッダが無ければ `absent`）。
   * 8 KiB を超えたら写さず印だけ（`receipt` を書かない）。比べる network は `network` の欄（生の値）、署名者は `receiptSigner`。
   */
  readonly rawReceiptHeader?: string;
  /** 領収の形（`"evm"`・`"svm"`）。記録の欄にはならない。 */
  readonly receiptForm?: "evm" | "svm";
  /** 領収の `payer` と比べる署名者のアドレス（公開の値。記録の欄にはならない）。 */
  readonly receiptSigner?: string;
  /**
   * `PAYMENT-REQUIRED` のヘッダの文字列（§12.2: 402 以外の状態でも）。後回しの処理で decode して最上位の `error` だけを理由の表で分類する
   * （`reasonSource: "payment_required_header"`）。8 KiB を超えた・decode できない → `malformed`。
   */
  readonly rawPaymentRequired?: string;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * RPC の例外の写しと分類（§5.3。分類は後回しの処理で）
 * ────────────────────────────────────────────────────────────────────────────── */

/** 例外の 1 段の種類（hook が型・`name` から決める）。 */
export const DIAG_RPC_NODE_KINDS = ["http", "limit", "timeout", "deadline", "plain"] as const;
export type DiagRpcNodeKind = (typeof DIAG_RPC_NODE_KINDS)[number];
/** 辿る段の数（自分を含めて 5 つ）。 */
export const DIAG_RPC_SNAPSHOT_DEPTH = 5;
/**
 * RPC の例外の写し: 段ごとに `[種類, 数値の status か null, 数値の code か null]` を平らに並べた primitive だけの配列（最大 5 段 = 15 要素）。
 * 例外の object・文言は持たない。
 */
export type DiagRpcErrorSnapshot = readonly (DiagRpcNodeKind | number | null)[];

const RPC_RATE_LIMIT_CODE = -32005;
const rpcStatusOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined);
const rpcCodeValueOf = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= -(2 ** 31) && value <= 2 ** 31 ? value : undefined);

/** RPC の失敗の分類（記録の欄）。 */
export interface DiagRpcClass {
  readonly rpc: (typeof DIAG_RPC_CLASSES)[number];
  readonly rpcHttpStatus?: number;
  readonly rpcCode?: number;
  readonly code?: "deadline";
}

/**
 * 写しを分類する（純粋。§5.3 の表）。各段で表の順に最初に当たったもの: `http` の 429 → `rate_limited`（status）、`limit`・code -32005 →
 * `rate_limited`（code）、`timeout` → `timeout`、`deadline` → `timeout`（`code: "deadline"`）、ほかの `http` → `other`（status）、ほかの数値の code →
 * `other`（code）。どの段にも当たらなければ `other`。範囲の外の status・code は写さない。
 */
export function classifyRpcSnapshot(snapshot: DiagRpcErrorSnapshot): DiagRpcClass {
  for (let i = 0; i + 2 < snapshot.length && i < DIAG_RPC_SNAPSHOT_DEPTH * 3; i += 3) {
    const kind = snapshot[i];
    const status = kind === "http" ? rpcStatusOf(snapshot[i + 1]) : undefined;
    const code = rpcCodeValueOf(snapshot[i + 2]);
    if (kind === "http" && status === 429) return { rpc: "rate_limited", rpcHttpStatus: status };
    if (kind === "limit" || code === RPC_RATE_LIMIT_CODE) return { rpc: "rate_limited", ...(code === undefined ? {} : { rpcCode: code }) };
    if (kind === "timeout") return { rpc: "timeout" };
    if (kind === "deadline") return { rpc: "timeout", code: "deadline" };
    if (kind === "http") return { rpc: "other", ...(status === undefined ? {} : { rpcHttpStatus: status }) };
    if (code !== undefined) return { rpc: "other", rpcCode: code };
  }
  return { rpc: "other" };
}

/** 写しの形（push の時点で確かめて凍結した写しを作る。外れれば `undefined`）。 */
function rpcSnapshotCopyOf(value: unknown): DiagRpcErrorSnapshot | undefined {
  if (!Array.isArray(value) || value.length > DIAG_RPC_SNAPSHOT_DEPTH * 3 || value.length % 3 !== 0) return undefined;
  const out: Array<DiagRpcNodeKind | number | null> = [];
  for (let i = 0; i < value.length; i += 1) {
    const item: unknown = value[i];
    if (i % 3 === 0) {
      if (typeof item !== "string" || !(DIAG_RPC_NODE_KINDS as readonly string[]).includes(item)) return undefined;
      out.push(item as DiagRpcNodeKind);
    } else {
      if (item !== null && typeof item !== "number") return undefined;
      out.push(item);
    }
  }
  return Object.freeze(out);
}

/** 写しの量の見積り（15 要素の固定の上限）。 */
const DIAG_RPC_SNAPSHOT_COST = DIAG_RPC_SNAPSHOT_DEPTH * 3 * 16 + 64;

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
  /**
   * `cid` の入力のもう 1 つの形（§12.6・§13.1、タスク R-3）: facilitator に **送った要求の本文の文字列** そのもの（参照。文字列は変わらないので
   * 写しは作らない）。hot path では読まず、後回しの処理で `JSON.parse` して `diagCidInputOf`（自前の facilitator と同じ関数）で cid の入力にする。
   * 上限（`DIAG_CID_REQUEST_MAX_BYTES`）を超える文字列は scope に入れない。同じ scope の `cidInput` と両方は持たない（後から重ねた方が勝つ）。
   */
  readonly cidRequestText?: string;
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
/**
 * scope に入れる要求の本文（`cidRequestText`）の上限（バイトの見積り。文字列の欄と同じ 8 KiB = 4,096 code unit）。1 件の上限（16 KiB）に
 * 収まる量で、後回しの処理の 1 回の parse の量の上限でもある。EIP-3009 の verify・settle の要求は 1〜2 KB。
 */
export const DIAG_CID_REQUEST_MAX_BYTES = DIAG_MAX_STRING_BYTES;

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
export type CapturedValue = string | number | boolean | null | typeof OVERSIZE | typeof INVALID | Readonly<Record<"network" | "asset" | "from" | "nonce", string>> | DiagRpcErrorSnapshot;
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
  ["receiptForm", "string"],
  ["receiptSigner", "string"],
];
/** 生の文字列の欄（型の違う値は `INVALID`、8 KiB を超えたら `OVERSIZE`。分類は後回しの処理で）。 */
const RAW_STRING_FIELDS = ["rawReceiptHeader", "rawPaymentRequired"] as const;
/** 写す欄の数（固定。`rawReason`・`rawCid`・`txRef`・`rawRpc`・`rawReceiptHeader`・`rawPaymentRequired` を含む）。push の仕事はこの数の読み取りで上限がある。 */
export const DIAG_CAPTURE_FIELD_COUNT = CAPTURE_FIELDS.length + 4 + RAW_STRING_FIELDS.length;

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
  for (const key of RAW_STRING_FIELDS) {
    const raw = source[key];
    if (raw === undefined) continue;
    if (typeof raw !== "string") out[key] = INVALID;
    else if (diagStringBytes(raw) > DIAG_MAX_STRING_BYTES) out[key] = OVERSIZE;
    else {
      cost += diagStringBytes(raw);
      out[key] = raw;
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
  const rawRpc = source["rawRpc"];
  if (rawRpc !== undefined) {
    const copy = rpcSnapshotCopyOf(rawRpc);
    if (copy === undefined) out["rawRpc"] = INVALID;
    else {
      cost += DIAG_RPC_SNAPSHOT_COST;
      out["rawRpc"] = copy;
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
  const givenText = source["cidRequestText"];
  // 後から重ねた方が勝つ（`cidInput` と `cidRequestText` は片方だけ）。
  const textGiven = givenText !== undefined;
  const cid = givenCid !== undefined ? cidCopyOf(givenCid) : textGiven || prior["cidInput"] === undefined ? undefined : cidCopyOf(prior["cidInput"]);
  if (cid !== undefined) {
    cost += cid.bytes;
    out["cidInput"] = cid.copy;
  } else {
    const text = textGiven ? givenText : givenCid === undefined ? prior["cidRequestText"] : undefined;
    // 長さを見るだけ（O(1)）。上限を超える・文字列でないなら入れない（cid が付かないだけ）。
    if (typeof text === "string" && diagStringBytes(text) <= DIAG_CID_REQUEST_MAX_BYTES) {
      cost += diagStringBytes(text);
      out["cidRequestText"] = text;
    }
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
/** CAIP-2 の形（長さの上限つき）。`diagCidInputOf` と自前の facilitator の記録の `network` が使う。 */
export const DIAG_NETWORK_SHAPE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const DIAG_CID_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DIAG_CID_BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 要求の本文から `cid` の入力を読む（§5.2。`identify` とは別の純粋関数）。形どおり（network が CAIP-2、asset・from が EVM アドレス、
 * nonce が bytes32）のときだけ値を返し、ほかは `undefined`（記録に `cid` が付かないだけ）。読むのは 4 つの欄だけで、値はそのまま
 * （正規化は `diagCorrelationIdOf` が後回しの処理でする）。
 * **自前の facilitator（受け取った本文）と Router の受信（送った本文、後回しの処理）が同じこの関数を使う**（タスク R-5 から移した。振る舞いは同じ）。
 */
export function diagCidInputOf(bodyJson: unknown): DiagCidInput | undefined {
  if (!isPlainRecord(bodyJson)) return undefined;
  const requirements = bodyJson["paymentRequirements"];
  const paymentPayload = bodyJson["paymentPayload"];
  if (!isPlainRecord(requirements) || !isPlainRecord(paymentPayload)) return undefined;
  const inner = paymentPayload["payload"];
  if (!isPlainRecord(inner)) return undefined;
  const authorization = inner["authorization"];
  if (!isPlainRecord(authorization)) return undefined;
  const network = requirements["network"];
  const asset = requirements["asset"];
  const from = authorization["from"];
  const nonce = authorization["nonce"];
  if (typeof network !== "string" || !DIAG_NETWORK_SHAPE.test(network)) return undefined;
  if (typeof asset !== "string" || !DIAG_CID_ADDRESS.test(asset) || typeof from !== "string" || !DIAG_CID_ADDRESS.test(from) || typeof nonce !== "string" || !DIAG_CID_BYTES32.test(nonce)) return undefined;
  return { network, asset, from, nonce };
}

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

/**
 * 後回しの処理: scope の要求の本文（`cidRequestText`）から cid の入力を読む。上限の中の文字列だけを parse し、自前の facilitator と同じ
 * `diagCidInputOf` で取り出す（同じ bytes なら同じ cid）。parse の失敗・形の違いは `undefined`（cid が付かないだけ。投げない）。
 */
function cidInputOfRequestText(text: unknown): DiagCidInput | undefined {
  if (typeof text !== "string" || diagStringBytes(text) > DIAG_CID_REQUEST_MAX_BYTES) return undefined;
  try {
    return diagCidInputOf(JSON.parse(text));
  } catch {
    return undefined;
  }
}

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
    if (c[key] === INVALID && !MALFORMED_WHEN_INVALID.has(key)) return undefined;
  }
  const derived = derivedDestinationFieldsOf(c);
  if (derived === undefined) return undefined;
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
  put("cid", c["rawCid"] !== undefined ? cidOf(c["rawCid"]) : s["cidInput"] !== undefined ? cidOf(s["cidInput"]) : cidOf(cidInputOfRequestText(s["cidRequestText"])));
  put("promoted", pick("promoted"));
  put("routeId", pick("routeId"));
  const network = c["network"];
  if (network !== undefined) out["network"] = typeof network === "string" && DIAG_NETWORKS.includes(network) ? network : "unrecognized";
  const op = c["op"];
  if (op !== undefined) out["op"] = typeof op === "string" && (DIAG_OPS as readonly string[]).includes(op) ? op : "other";
  for (const key of DIRECT_KEYS) put(key, key in derived ? derived[key as keyof DerivedDestinationFields] : c[key]);
  const reasonRaw = derived.hasReason ? derived.rawReason : c["rawReason"];
  if (derived.hasReason || "rawReason" in c) {
    out["reason"] = reasonRaw === OVERSIZE || reasonRaw === INVALID ? "malformed" : classifyReason(reasonRaw);
    out["table"] = REASON_TABLE_VERSION;
  }
  for (const key of DIRECT_KEYS_AFTER_REASON) put(key, c[key]);
  // RPC の例外の写しはここで分類する（§13.1: hook は写すだけ）。明示の欄が優先。
  const rpcClass = c["rawRpc"] !== undefined ? (classifyRpcSnapshot(c["rawRpc"] as DiagRpcErrorSnapshot) as unknown as Record<string, unknown>) : {};
  const code = c["code"] !== undefined ? c["code"] : rpcClass["code"];
  if (code !== undefined) out["code"] = typeof code === "string" && DIAG_CODES.has(code) ? code : "unrecognized";
  for (const key of DIRECT_KEYS_TAIL) put(key, c[key] !== undefined ? c[key] : rpcClass[key]);
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

/** 型の違う値でも行を捨てず、`malformed` として分類する生の欄。 */
const MALFORMED_WHEN_INVALID: ReadonlySet<string> = new Set(["rawReason", "rawReceiptHeader", "rawPaymentRequired"]);

/** 送信の領収・理由の後回しの分類の結果（記録の欄。`hasReason` なら `rawReason` を理由の表に掛ける）。 */
interface DerivedDestinationFields {
  receipt?: string;
  reasonField?: string;
  reasonSource?: string;
  hasReason?: boolean;
  rawReason?: unknown;
}

/**
 * 送信の領収と理由を、写した生の値から分類する（§4.3、§12.2。後回しの処理だけで呼ぶ）。
 * - `receiptForm` があれば `receipt`: ヘッダが無ければ `absent`、8 KiB を超えていれば（§14.2 の印 `OVERSIZE`。写していない・decode しない）
 *   `malformed`、ほかは `receiptClassOfHeader`（`receiptOf` と同じ decoder・順）。大きすぎたヘッダは `ok` にも `payer_mismatch` にもならない。
 * - 理由は 1 つだけ。値のある理由を優先する: (1) 領収が `failed` で `errorReason` に値がある → それ（`payment_response_header`）、
 *   (2) `PAYMENT-REQUIRED` の `error` に値がある → それ（`payment_required_header`）、(3) 写した `rawReason`（静的の Base の既に読んだ本文など。
 *   欄・出どころは hook が書いたもの）。どれにも値が無ければ、(4) 領収が `failed` なら `errorReason` の `absent`、(5) `PAYMENT-REQUIRED` を
 *   写していればその `absent`・`malformed`。
 * 形の外（`receiptForm` が集合の外・署名者が無い）なら `undefined`（行ごと捨てる）。
 */
function derivedDestinationFieldsOf(c: Record<string, unknown>): DerivedDestinationFields | undefined {
  const out: DerivedDestinationFields = {};
  let failedReason: { raw: unknown } | undefined;
  if (c["receiptForm"] !== undefined) {
    const form = receiptFormOf(c["receiptForm"], c["receiptSigner"]);
    const network = c["network"];
    if (form === undefined || typeof network !== "string") return undefined;
    const header = c["rawReceiptHeader"];
    if (header === undefined) out.receipt = "absent";
    else if (header === INVALID || header === OVERSIZE) out.receipt = "malformed"; // §14.2: 大きすぎたヘッダは写さず印だけ（decode しない）
    else if (typeof header === "string") {
      const result = receiptClassOfHeader(header, network, form);
      out.receipt = result.receipt;
      if (result.receipt === "failed") failedReason = { raw: result.errorReason };
    } else return undefined;
  } else if (c["rawReceiptHeader"] !== undefined || c["receiptSigner"] !== undefined) {
    return undefined;
  }
  const hasValue = (value: unknown): boolean => value !== undefined && value !== null;
  const fromReceipt = (raw: unknown): DerivedDestinationFields => ({ ...out, reasonField: "errorReason", reasonSource: "payment_response_header", hasReason: true, rawReason: raw });
  // (1) 値のある領収の errorReason
  if (failedReason !== undefined && hasValue(failedReason.raw)) return fromReceipt(failedReason.raw);
  const required = c["rawPaymentRequired"];
  const decoded =
    required === undefined ? undefined : typeof required === "string" ? paymentRequiredErrorOf(required) : ({ kind: "malformed" } as const); // OVERSIZE・INVALID は decode しない
  const fromRequired = (raw: unknown): DerivedDestinationFields => ({ ...out, reasonField: "error", reasonSource: "payment_required_header", hasReason: true, rawReason: raw });
  // (2) 値のある PAYMENT-REQUIRED.error
  if (decoded !== undefined && decoded.kind === "decoded" && decoded.present && hasValue(decoded.value)) return fromRequired(decoded.value);
  // (3) 既に読んだ本文の理由（欄・出どころは hook が書いたもの）
  if ("rawReason" in c && hasValue(c["rawReason"])) return out;
  // (4)・(5) 値のある理由が無い: 見た欄の absent・malformed
  if (failedReason !== undefined) return fromReceipt(failedReason.raw);
  if (decoded !== undefined) return fromRequired(decoded.kind === "malformed" ? INVALID : decoded.value);
  return out;
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
  "rawRpc",
  "receiptForm",
  "receiptSigner",
  "rawReceiptHeader",
  "rawPaymentRequired",
]);

/** 数の初期値（全部 0）。 */
export function zeroCounters(): { -readonly [K in DiagCounterKey]: number } {
  const out = {} as { -readonly [K in DiagCounterKey]: number };
  for (const key of DIAG_COUNTER_KEYS) out[key] = 0;
  return out;
}
