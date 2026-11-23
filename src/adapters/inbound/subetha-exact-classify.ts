/**
 * 受信レール `subetha-exact` の分類の純粋関数（`docs/subetha-exact-inbound-design.md` §3.3・§3.4 の 6・§3.8 の表 A〜E・D／D′）。
 * I/O も時計も持たない。表の行は上から順に最初に合うもの。facilitator の自由な文（`error` の文章・`invalidMessage`）は結果に写さない: 結果は固定の token だけ。
 */
import { createHash } from "node:crypto";
import { getAddress } from "viem";

import type { OfferRefusalDetail, SettleResult } from "../../ports/inbound.js";
import { classifyReason, type ReasonClass } from "../../shared/payment-reasons.js";

export const SUBETHA_EXACT_RESPONSE_MAX_BYTES = 64 * 1024;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `call` の結果（§3.9）。`threw` は transport の例外・timeout・本文の読み取りの期限切れ。 */
export type CallOutcome =
  | { readonly kind: "threw" }
  | { readonly kind: "response"; readonly status: number; readonly json: unknown; readonly retryAfter: string | null; readonly unreadable: boolean };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const lower = (value: string): string => value.toLowerCase();

// ---- digest（§3.3） -------------------------------------------------------------------------------------------------

const sha256Hex = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");
const lengthPrefixed = (value: string): string => `${String(Buffer.byteLength(value, "utf8"))}:${value}`;

export function resourceDigestOf(routeBinding: string): string {
  return `0x${sha256Hex(`subetha-exact|resource|${routeBinding}`)}`;
}
export function requesterDigestOf(salt: string, principalId: string, requestId: string): string {
  return `0x${sha256Hex(`subetha-exact|requester|${salt}|${lengthPrefixed(principalId)}|${lengthPrefixed(requestId)}`)}`;
}
export function pairKeyOf(requesterDigest: string, resourceDigest: string): string {
  return `${lower(requesterDigest)}|${lower(resourceDigest)}`;
}

// ---- Retry-After ------------------------------------------------------------------------------------------------------

/** `Retry-After`（秒の整数だけ。日付の形・負・非数は無視）を ms に。無ければ `fallbackMs`。 */
export function retryAfterMsOf(header: string | null, fallbackMs: number): number {
  if (header === null) return fallbackMs;
  const trimmed = header.trim();
  if (!/^[0-9]{1,6}$/.test(trimmed)) return fallbackMs;
  return Number(trimmed) * 1000;
}

// ---- orderView の読み取り（§3.4 の 6） ---------------------------------------------------------------------------------

export interface ParsedRequirements {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: { readonly name: string; readonly version: string };
}
export interface ParsedRelease {
  readonly state: string;
  readonly deliveryKey?: string;
  readonly txRef?: string;
  readonly eventId?: string;
  readonly afterRelease?: string;
}
export interface ParsedOrderView {
  readonly orderId: string;
  readonly existing?: boolean;
  readonly requirements: ParsedRequirements;
  readonly status: { readonly state: string; readonly expiresAt: number; readonly release?: ParsedRelease };
  readonly binding: { readonly requesterDigest: string; readonly resourceDigest: string };
}

/** 「読める応答」= object で `orderId` が hex32、`requirements`・`status`・`binding` が object、（あれば）`existing` が boolean。allowlist の欄だけを写す。 */
export function parseOrderView(json: unknown): ParsedOrderView | undefined {
  if (!isRecord(json)) return undefined;
  const orderId = json["orderId"];
  const requirements = json["requirements"];
  const status = json["status"];
  const binding = json["binding"];
  if (typeof orderId !== "string" || !HEX32.test(orderId) || !isRecord(requirements) || !isRecord(status) || !isRecord(binding)) return undefined;
  if (json["existing"] !== undefined && typeof json["existing"] !== "boolean") return undefined;
  const extra = requirements["extra"];
  const name = isRecord(extra) ? extra["name"] : undefined;
  const version = isRecord(extra) ? extra["version"] : undefined;
  const maxTimeoutSeconds = requirements["maxTimeoutSeconds"];
  const expiresAt = status["expiresAt"];
  const requesterDigest = binding["requesterDigest"];
  const resourceDigest = binding["resourceDigest"];
  if (
    typeof requirements["scheme"] !== "string" || typeof requirements["network"] !== "string" || typeof requirements["asset"] !== "string" ||
    typeof requirements["amount"] !== "string" || typeof requirements["payTo"] !== "string" || typeof name !== "string" || typeof version !== "string" ||
    typeof maxTimeoutSeconds !== "number" || typeof expiresAt !== "number" || typeof status["state"] !== "string" ||
    typeof requesterDigest !== "string" || typeof resourceDigest !== "string"
  ) {
    return undefined;
  }
  const releaseRaw = status["release"];
  const release: ParsedRelease | undefined = isRecord(releaseRaw) && typeof releaseRaw["state"] === "string"
    ? {
        state: releaseRaw["state"],
        ...(typeof releaseRaw["deliveryKey"] === "string" ? { deliveryKey: releaseRaw["deliveryKey"] } : {}),
        ...(typeof releaseRaw["txRef"] === "string" ? { txRef: releaseRaw["txRef"] } : {}),
        ...(typeof releaseRaw["eventId"] === "string" ? { eventId: releaseRaw["eventId"] } : {}),
        // `afterRelease` は**有無**が復元の条件（表 D）。文字列で無い値が有るときは「有る」と読む（`malformed`）: 落として「無い」にしない（実装レビュー 3 の #1）。
        ...(releaseRaw["afterRelease"] === undefined ? {} : { afterRelease: typeof releaseRaw["afterRelease"] === "string" ? releaseRaw["afterRelease"] : "malformed" }),
      }
    : undefined;
  return {
    orderId: lower(orderId),
    ...(json["existing"] === undefined ? {} : { existing: json["existing"] as boolean }),
    requirements: { scheme: requirements["scheme"], network: requirements["network"], asset: requirements["asset"], amount: requirements["amount"], payTo: requirements["payTo"], maxTimeoutSeconds, extra: { name, version } },
    status: { state: status["state"], expiresAt, ...(release === undefined ? {} : { release }) },
    binding: { requesterDigest, resourceDigest },
  };
}

// ---- 表 A: 作成 ------------------------------------------------------------------------------------------------------

export interface CreateExpectation {
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly requesterDigest: string;
  readonly resourceDigest: string;
  readonly domain: { readonly name: string; readonly version: string };
  readonly nowSec: number;
  readonly minLeadSeconds: number;
  /** 同じ pair の最新の `created` の attempt の orderId（無ければ undefined = 受け入れる）。 */
  readonly latestCreatedOrderId?: string;
}
export type CreateClassification =
  | { readonly kind: "unavailable"; readonly detail: OfferRefusalDetail; readonly retryAfterMs?: number }
  | { readonly kind: "refused"; readonly detail: OfferRefusalDetail }
  | { readonly kind: "created"; readonly view: ParsedOrderView };

export const CREATE_RETRY_AFTER_DEFAULT_MS = 30_000;

/** 読める view の検査（FR-3）。通れば undefined、違えば detail。`checkExpiry` は照会（§3.6）では偽（期限は見ない）。 */
export function viewMismatchOf(view: ParsedOrderView, expected: CreateExpectation, checkExpiry: boolean): OfferRefusalDetail | undefined {
  const r = view.requirements;
  const bindingOk = lower(view.binding.requesterDigest) === lower(expected.requesterDigest) && lower(view.binding.resourceDigest) === lower(expected.resourceDigest);
  const termsOk =
    r.scheme === "exact" && r.network === expected.network && lower(r.asset) === lower(expected.asset) && r.amount === expected.amount && ADDRESS.test(r.payTo) &&
    r.extra.name === expected.domain.name && r.extra.version === expected.domain.version && Number.isSafeInteger(r.maxTimeoutSeconds) && r.maxTimeoutSeconds > 0;
  const expiryOk = Number.isSafeInteger(view.status.expiresAt) && view.status.expiresAt > 0 && (!checkExpiry || view.status.expiresAt - expected.nowSec >= expected.minLeadSeconds);
  if (view.existing === true) {
    if (expected.latestCreatedOrderId !== undefined && lower(expected.latestCreatedOrderId) !== view.orderId) return "order_reused_other_id";
    if (!expiryOk) return "order_reused_expired";
    if (!termsOk || !bindingOk) return "order_reused_mismatch";
    return undefined;
  }
  return termsOk && bindingOk && expiryOk ? undefined : "requirements_mismatch";
}

export function classifyCreate(call: CallOutcome, expected: CreateExpectation): CreateClassification {
  if (call.kind === "threw") return { kind: "unavailable", detail: "response_unreadable" };
  const { status } = call;
  if (status === 503) return { kind: "unavailable", detail: "facilitator_busy", retryAfterMs: retryAfterMsOf(call.retryAfter, CREATE_RETRY_AFTER_DEFAULT_MS) };
  if (status === 429) return { kind: "unavailable", detail: "rate_limited", retryAfterMs: retryAfterMsOf(call.retryAfter, CREATE_RETRY_AFTER_DEFAULT_MS) };
  if (status >= 500) return { kind: "unavailable", detail: "facilitator_busy" };
  if (status === 401) return { kind: "refused", detail: "unauthorized" };
  if (status === 404) return { kind: "refused", detail: "unknown_tenant" };
  if (status === 403) return { kind: "refused", detail: "amount_refused" };
  if (status >= 400) return { kind: "refused", detail: "requirements_mismatch" };
  if (status !== 200 && status !== 201) return { kind: "unavailable", detail: "response_unreadable" };
  const view = parseOrderView(call.json);
  if (view === undefined || view.existing === undefined) return { kind: "unavailable", detail: "response_unreadable" };
  const mismatch = viewMismatchOf(view, expected, true);
  return mismatch === undefined ? { kind: "created", view } : { kind: "refused", detail: mismatch };
}

// ---- 表 B: settle（bind → 外部の facilitator → reconcile。`docs/subetha-exact-provider-settle-design.md` §3） ----------------

/** 手元の authorization の同一性（署名そのものは持たない）。`sigSha256` は署名の文字列を小文字にしたものの SHA-256（hex）。 */
export interface LocalIdentity {
  readonly from: string;
  readonly nonce: string;
  readonly sigSha256: string;
}
export function sigSha256Of(signature: string): string {
  return sha256Hex(lower(signature));
}
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** bind の 409 の code（固定の一覧だけを記録に残す。相手の文字列はそのまま写さない）。 */
export const BIND_REFUSAL_CODES: readonly string[] = Object.freeze([
  "conflicting-authorization",
  "order-on-other-path",
  "order-not-open",
  "order-expired",
  "valid-before-after-order-expiry",
  "authorization-consumed-before-order",
  "invalid-signature",
  "too-many-unresolved-bindings",
  "payload pays another order",
]);

export type BindClassification =
  /** 送ってよいのはこれだけ: `ack: "bound"` で、ledger から読み直された identity が手元の authorization と一致する。 */
  | { readonly action: "submit" }
  /** 送らない。reconcile を 1 回（`already-used`、409 の拒否）。 */
  | { readonly action: "reconcile"; readonly ack: "already-used" | "refused"; readonly code?: string }
  /** 送らない。reconcile も呼ばない（bind されていない・分からない・identity が違う）。 */
  | { readonly action: "stop"; readonly ack: "bound" | "unknown" };

export function classifyBind(call: CallOutcome, local: LocalIdentity): BindClassification {
  if (call.kind === "threw") return { action: "stop", ack: "unknown" };
  const { status, json } = call;
  if (status === 409) {
    const error = isRecord(json) ? json["error"] : undefined;
    return { action: "reconcile", ack: "refused", code: typeof error === "string" && BIND_REFUSAL_CODES.includes(error) ? error : "other" };
  }
  if (status !== 200 || !isRecord(json)) return { action: "stop", ack: "unknown" };
  if (json["ack"] === "already-used" && typeof json["recorded"] === "boolean") return { action: "reconcile", ack: "already-used" };
  if (json["ack"] !== "bound") return { action: "stop", ack: "unknown" };
  const identity = json["identity"];
  if (!isRecord(identity)) return { action: "stop", ack: "unknown" };
  const { from, nonce, sigSha256 } = identity;
  if (typeof from !== "string" || !ADDRESS.test(from) || typeof nonce !== "string" || !HEX32.test(nonce) || typeof sigSha256 !== "string" || !SHA256_HEX.test(sigSha256)) return { action: "stop", ack: "unknown" };
  const same = lower(from) === lower(local.from) && lower(nonce) === lower(local.nonce) && sigSha256 === local.sigSha256;
  return same ? { action: "submit" } : { action: "stop", ack: "bound" };
}

/**
 * 外部の facilitator の答え。**結果は決めない**: reconcile を待つ長さだけを決める（設計 §3.4）。
 * `refused` は「はっきり断った」（200 で `success === false`、または 4xx）。それ以外は `wait`（成功と言った・答えと読めない）。
 * `reason` は、断った答え（上の 2 つ）の本文が JSON の object のときだけ: `errorReason` の欄を理由の表（`shared/payment-reasons.ts`）で分類した固定の語
 * （表の token・`absent`・`malformed`・`unrecognized`）。生の文字列は残さない。記録のためだけで、結果も待ち方も変えない（設計 §3.12）。
 */
export interface SubmitClassification {
  readonly wait: boolean;
  readonly success?: boolean;
  readonly transaction?: string;
  readonly reason?: ReasonClass;
}

function refusalReasonOf(json: unknown): { readonly reason?: ReasonClass } {
  if (!isRecord(json)) return {};
  return { reason: classifyReason(Object.prototype.hasOwnProperty.call(json, "errorReason") ? json["errorReason"] : undefined) };
}
export function classifySubmit(call: CallOutcome): SubmitClassification {
  if (call.kind === "threw") return { wait: true };
  const { status, json } = call;
  if (status >= 400 && status < 500) return { wait: false, ...refusalReasonOf(json) };
  if (status !== 200 || !isRecord(json) || typeof json["success"] !== "boolean") return { wait: true };
  const transaction = json["transaction"];
  return { wait: json["success"], success: json["success"], ...(typeof transaction === "string" && HEX32.test(transaction) ? { transaction: lower(transaction) } : {}), ...(json["success"] ? {} : refusalReasonOf(json)) };
}

/** reconcile の読み（記録に残す固定の語）。`unanswered` は 200 以外・読めない・例外。 */
export type ReconcileReading = "accepted" | "pending" | "late-paid" | "rejected" | "mismatch" | "other" | "unanswered";
export type ReconcileClassification = { readonly result: SettleResult; readonly reading: ReconcileReading; readonly response: "ok" | "success_false" | "tx_malformed" | "not_json" | "http_error" };

/**
 * `settled` と答えるのは、reconcile が 200 の object で `outcome === "accepted"`、`txHash` が 32 バイトの hex、`order.status.exact` の `from`・`nonce`
 * （あれば `sigSha256` も）が手元の authorization と一致するときだけ（設計 §3.2）。それ以外は全て `unknown`（`rejected` にしない）。
 */
export function classifyReconcile(call: CallOutcome, local: LocalIdentity | undefined, mayStillSettleUntil: number | undefined): ReconcileClassification {
  const unknown: SettleResult = { outcome: "unknown", reason: "source_settle_unknown", ...(mayStillSettleUntil === undefined ? {} : { mayStillSettleUntil }) };
  if (call.kind === "threw" || call.status !== 200) return { result: unknown, reading: "unanswered", response: "http_error" };
  const json = call.json;
  if (!isRecord(json)) return { result: unknown, reading: "unanswered", response: "not_json" };
  const outcome = json["outcome"];
  if (outcome === "pending" || outcome === "late-paid" || outcome === "rejected") return { result: unknown, reading: outcome, response: "success_false" };
  if (outcome !== "accepted") return { result: unknown, reading: "other", response: "success_false" };
  const txHash = json["txHash"];
  if (typeof txHash !== "string" || !HEX32.test(txHash)) return { result: unknown, reading: "mismatch", response: "tx_malformed" };
  const order = json["order"];
  const status = isRecord(order) ? order["status"] : undefined;
  const exact = isRecord(status) ? status["exact"] : undefined;
  if (local === undefined || !isRecord(exact)) return { result: unknown, reading: "mismatch", response: "tx_malformed" };
  const { from, nonce, sigSha256 } = exact;
  const same = typeof from === "string" && lower(from) === lower(local.from) && typeof nonce === "string" && lower(nonce) === lower(local.nonce) && (sigSha256 === undefined || sigSha256 === local.sigSha256);
  if (!same) return { result: unknown, reading: "mismatch", response: "tx_malformed" };
  return { result: { outcome: "settled", txRef: lower(txHash), eventId: lower(local.nonce) }, reading: "accepted", response: "ok" };
}

// ---- 表 C・D・D′: release --------------------------------------------------------------------------------------------

export interface ReleaseContext {
  readonly orderId: string;
  readonly sourceTxRef: string;
  readonly chainId: number;
  readonly requesterDigest: string;
  readonly resourceDigest: string;
}
export interface ReleaseTicket {
  readonly deliveryKey: string;
  readonly txRef: string;
  readonly eventId: string;
}
export type ReleasePostClassification =
  | { readonly action: "released"; readonly ticket: ReleaseTicket }
  | { readonly action: "retry" }
  | { readonly action: "reconstruct" }
  | { readonly action: "probe" }
  | { readonly action: "refused" }
  | { readonly action: "unknown"; readonly note?: "unauthorized" };

export function eventIdMatches(eventId: unknown, chainId: number, txRef: string): eventId is string {
  return typeof eventId === "string" && new RegExp(`^${String(chainId)}:${lower(txRef)}:[0-9]+$`).test(lower(eventId));
}

export function classifyReleasePost(call: CallOutcome, context: ReleaseContext): ReleasePostClassification {
  if (call.kind === "threw") return { action: "probe" };
  const { status, json } = call;
  if (status === 200) {
    if (!isRecord(json)) return { action: "unknown" };
    const deliveryKey = json["deliveryKey"];
    const txRef = json["txRef"];
    const eventId = json["eventId"];
    if (typeof deliveryKey === "string" && lower(deliveryKey) === lower(context.orderId) && typeof txRef === "string" && lower(txRef) === lower(context.sourceTxRef) && eventIdMatches(eventId, context.chainId, context.sourceTxRef)) {
      return { action: "released", ticket: { deliveryKey: lower(deliveryKey), txRef: lower(txRef), eventId } };
    }
    return { action: "unknown" };
  }
  if (status === 425) return { action: "retry" };
  const code = isRecord(json) && typeof json["error"] === "string" ? json["error"] : undefined;
  if (status === 409) {
    if (code === "already-claimed") return { action: "reconstruct" };
    if (code === "incident" || code === "late-after-reinclusion" || code === "already-delivered" || code === "already-failed") return { action: "refused" };
    return { action: "unknown" };
  }
  if (status === 403 && code === "requester-mismatch") return { action: "refused" };
  if (status === 404 && code === "unknown-order") return { action: "refused" };
  if (status === 429 || status >= 500) return { action: "probe" };
  if (status === 401) return { action: "unknown", note: "unauthorized" };
  return { action: "unknown" };
}

export type ReconstructClassification =
  | { readonly action: "released"; readonly ticket: ReleaseTicket }
  | { readonly action: "refused" }
  | { readonly action: "retry" }
  | { readonly action: "unknown" };

/**
 * 復元（表 D: `already-claimed` の後）と D′（transport の失敗の後）。view の条件: binding が自分の値、`status.state ∈ {accepted, settled}`、
 * `release.state === "authorized"`、`deliveryKey === orderId`、`txRef === sourceTxRef`、`eventId` の形、`afterRelease` 無し。
 */
export function classifyReconstruct(call: CallOutcome, context: ReleaseContext, after: "claimed" | "transport"): ReconstructClassification {
  if (call.kind === "threw" || call.status !== 200) return { action: "unknown" };
  const view = parseOrderView(call.json);
  const release = view?.status.release;
  if (view === undefined || release === undefined) return { action: "unknown" };
  if (after === "transport" && release.state === "none") return { action: "retry" };
  const ok =
    lower(view.binding.requesterDigest) === lower(context.requesterDigest) && lower(view.binding.resourceDigest) === lower(context.resourceDigest) &&
    (view.status.state === "accepted" || view.status.state === "settled") && release.state === "authorized" &&
    typeof release.deliveryKey === "string" && lower(release.deliveryKey) === lower(context.orderId) &&
    typeof release.txRef === "string" && lower(release.txRef) === lower(context.sourceTxRef) &&
    eventIdMatches(release.eventId, context.chainId, context.sourceTxRef) && release.afterRelease === undefined;
  if (ok) return { action: "released", ticket: { deliveryKey: lower(release.deliveryKey!), txRef: lower(release.txRef!), eventId: release.eventId! } };
  return after === "claimed" ? { action: "refused" } : { action: "unknown" };
}

// ---- 表 E: complete --------------------------------------------------------------------------------------------------

export type CompleteClassification =
  | { readonly action: "completed" }
  | { readonly action: "retry" }
  | { readonly action: "unreported"; readonly reason: "conflicting_outcome" | "not_authorized" | "delivery_key_mismatch" | "unknown_order" | "unknown_tenant" | "unauthorized" | "invalid_request" | "refused" | "unavailable" };

export function classifyComplete(call: CallOutcome, outcome: "delivered" | "failed"): CompleteClassification {
  if (call.kind === "threw") return { action: "retry" };
  const { status, json } = call;
  if (status === 429 || status >= 500) return { action: "retry" };
  if (status === 200) return isRecord(json) && json["state"] === outcome ? { action: "completed" } : { action: "unreported", reason: "unavailable" };
  if (status >= 200 && status < 300) return { action: "unreported", reason: "unavailable" };
  const code = isRecord(json) && typeof json["error"] === "string" ? json["error"] : undefined;
  if (status === 409) {
    if (code === "conflicting-outcome") return { action: "unreported", reason: "conflicting_outcome" };
    if (code === "not-authorized") return { action: "unreported", reason: "not_authorized" };
    if (code === "delivery-key-mismatch") return { action: "unreported", reason: "delivery_key_mismatch" };
    return { action: "unreported", reason: "refused" };
  }
  if (status === 400) return { action: "unreported", reason: "invalid_request" };
  if (status === 401) return { action: "unreported", reason: "unauthorized" };
  if (status === 404) return code === "unknown-challenge" || code === "unknown-order" ? { action: "unreported", reason: "unknown_order" } : { action: "unreported", reason: "unknown_tenant" };
  return { action: "unreported", reason: "refused" };
}

// ---- 予算（§3.7） ----------------------------------------------------------------------------------------------------

/** 1 回の試行の期限 = `min(perTryMs, 残り)`。残りが 1 秒未満なら試行しない（`undefined`）。 */
export function tryDeadlineOf(perTryMs: number, budgetEndMs: number, nowMs: number): number | undefined {
  const remaining = budgetEndMs - nowMs;
  if (remaining < 1000) return undefined;
  return Math.min(perTryMs, remaining);
}
/** 待ちの判定: `Retry-After` があればその値（切り詰めない）。待った後に 1 秒以上残らなければ試行しない。 */
export function waitFits(waitMs: number, budgetEndMs: number, nowMs: number): boolean {
  return nowMs + waitMs + 1000 <= budgetEndMs;
}

/** 表の既定の address 化（`payTo` を EIP-55 に。読める形は `viewMismatchOf` で見ている）。 */
export function checksummed(address: string): string {
  return getAddress(address);
}
