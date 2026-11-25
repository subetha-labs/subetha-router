/**
 * SubEtha の settle facilitator が `POST /settle` の断った答え（`success: false`）の `errorReason` に返す値の固定の一覧
 * （`docs/exact-settle-facilitator-requirements.md` R8、`docs/exact-settle-facilitator-design.md` §2.5）。
 *
 * - 出どころ: SubEtha protocol `71deb50` の `apps/settle-facilitator/src/http.ts`（`settle_pending`・`settle_not_accepted:*`）と
 *   `engine.ts`・`state.ts`（`settle_failed:*` の理由）。相手の版が上がったら見直す。
 * - **完全一致だけ**。前方一致・大文字小文字の読み替え・前後の空白の除去はしない。生の文字列は残さない（一覧に無ければ `unrecognized`）。
 * - x402 の SDK に由来する理由の表（`payment-reasons.ts`）とは別（意味と版を混ぜない）。
 * - どの値も支払いの結果の証拠ではない。待つ長さと記録にだけ使う（要件 R6）。
 *
 * 純粋（I/O なし）。
 */

/** 受け付けたが結果がまだ。 */
export const SETTLE_PENDING_REASON = "settle_pending" as const;

/** 受け付けていない（この要求では何も送られない）。 */
export const SETTLE_NOT_ACCEPTED_REASONS = [
  "settle_not_accepted:out_of_scope",
  "settle_not_accepted:stopping",
  "settle_not_accepted:conflict",
  "settle_not_accepted:verify_unavailable",
  "settle_not_accepted:invalid_payment",
  "settle_not_accepted:bound_unreachable",
  "settle_not_accepted:not_bound",
  "settle_not_accepted:blocked",
  "settle_not_accepted:unavailable",
  // 次の release の 2 つ（`docs/exact-costs-reader-design.md` C8）。
  "settle_not_accepted:tenant_budget",
  "settle_not_accepted:tenant_capacity",
] as const;

/** この facilitator の最後の答え。支払いが成立しないことの証拠ではない（ほかの送信者・reorg。要件 §1.1）。 */
export const SETTLE_FAILED_REASONS = [
  "settle_failed:already-used",
  "settle_failed:simulation-failed",
  "settle_failed:no-transfer-in-settlement-transaction",
  "settle_failed:transaction-failed-twice",
  "settle_failed:cancelled",
  "settle_failed:expired-in-queue",
  "settle_failed:order-expired-in-queue",
  "settle_failed:not-bound",
  "settle_failed:oversized",
  "settle_failed:cancelled-by-operator",
] as const;

export type SettleReasonToken = typeof SETTLE_PENDING_REASON | (typeof SETTLE_NOT_ACCEPTED_REASONS)[number] | (typeof SETTLE_FAILED_REASONS)[number];
/** 分類の結果。`absent`（欄が無い・null）・`malformed`（文字列でない・空）・`unrecognized`（一覧に無い）は `payment-reasons.ts` と同じ意味。 */
export type SettleReasonClass = SettleReasonToken | "absent" | "malformed" | "unrecognized";

const KNOWN: ReadonlyMap<string, SettleReasonToken> = new Map([SETTLE_PENDING_REASON, ...SETTLE_NOT_ACCEPTED_REASONS, ...SETTLE_FAILED_REASONS].map((reason) => [reason, reason] as const));
const WAIT: ReadonlySet<SettleReasonClass> = new Set<SettleReasonClass>([SETTLE_PENDING_REASON, ...SETTLE_FAILED_REASONS]);

export function classifySettleReason(raw: unknown): SettleReasonClass {
  if (raw === undefined || raw === null) return "absent";
  if (typeof raw !== "string" || raw === "") return "malformed";
  return KNOWN.get(raw) ?? "unrecognized";
}

/** reconcile を待つ理由か（要件 R5）。 */
export function settleReasonWaits(reason: SettleReasonClass): boolean {
  return WAIT.has(reason);
}
