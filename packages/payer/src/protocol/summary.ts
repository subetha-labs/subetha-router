/**
 * agent と CLI に返してよい**要約**の型（設計 `docs/agent-payer-design.md` §3.6・§4、要件 FR-A17・FR-A19・SR-A5）。
 *
 * daemon の socket の応答、shim の tool の出力、CLI の表示は、**必ずこの schema を通してから**出す。schema は `strict()` なので、
 * 余計な欄（鍵・passphrase・合言葉・credential・`ownerKey`・challenge の全文・例外の message・quote 文書の全体）は**落ちて** `internal_error` になる。
 * 「秘密を出さない」を型ではなく実行時の検証で担保する（レビュー D-1 の指摘）。
 */

import { z } from "zod";

/** 固定のコード（自由文を入れない）。 */
const code = z.string().regex(/^[a-z_]{1,64}$/);

export const FailureSummary = z
  .object({
    ok: z.literal(false),
    error: code,
    reason: code.optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
    nextStep: z.string().max(2_000).optional(),
  })
  .strict();
export type FailureSummary = z.infer<typeof FailureSummary>;

/** `find_routes` の 1 行（hosted の一覧の射影。上流 URL は含まない）。 */
export const RouteSummary = z
  .object({
    routeId: z.string().min(1),
    kind: z.enum(["static", "dynamic"]),
    pays: z.object({ rail: z.string(), network: z.string(), asset: z.string(), amount: z.string().optional(), decimals: z.number().int() }).strict(),
    reaches: z.object({ rail: z.string(), network: z.string(), asset: z.string() }).strict(),
    fundsMoveOnCredential: z.boolean(),
    needsSol: z.boolean(),
  })
  .strict();

export const RoutesSummary = z.object({ ok: z.literal(true), routes: z.array(RouteSummary).max(200) }).strict();
export type RoutesSummary = z.infer<typeof RoutesSummary>;

/** 人間が承認する内容の要約（承認の記録 `ApprovalRecord` から描画。quote 文書そのものではない）。 */
export const SubjectSummary = z
  .object({
    amount: z.string(),
    decimals: z.number().int(),
    asset: z.string(),
    network: z.string(),
    payTo: z.string(),
    deadlineMs: z.number().int(),
    fundsMoveOnCredential: z.boolean(),
    reaches: z.object({ rail: z.string(), network: z.string(), asset: z.string(), quoted: z.string(), payTo: z.string().optional(), decimals: z.number().int().optional() }).strict(),
    upstreamUrl: z.string().url().optional(),
    pricing: z.object({ upstreamAmount: z.string(), fee: z.string(), total: z.string(), maxFee: z.string().optional() }).strict().optional(),
  })
  .strict();
export type SubjectSummary = z.infer<typeof SubjectSummary>;

/** 購入の参照（`p_` + base32 の 11 文字 = 13 文字）。 */
export const PurchaseRef = z.string().regex(/^p_[a-z2-7]{11}$/);

export const QuoteSummary = z
  .object({
    ok: z.literal(true),
    ref: PurchaseRef,
    subject: SubjectSummary,
    nextStep: z.string().max(2_000),
  })
  .strict();
export type QuoteSummary = z.infer<typeof QuoteSummary>;

export const PurchaseState = z.enum(["quoted", "approved", "sign_intent", "signed", "submit_intent", "submitted", "result", "unknown"]);

/** 上流の本文は**先頭だけ**（512 バイト）。全文は `includeBody` で別に取る。 */
export const ResultSummary = z
  .object({
    untrusted: z.literal(true),
    source: z.literal("upstream"),
    contentType: z.string(),
    preview: z.string().max(512),
    bytes: z.number().int().nonnegative(),
    body: z.unknown().optional(),
  })
  .strict();

export const PurchaseSummary = z
  .object({
    ok: z.boolean(),
    ref: PurchaseRef,
    state: PurchaseState,
    outcome: z.string().optional(),
    reason: code.optional(),
    paymentId: z.string().optional(),
    fundsMoved: z.enum(["no", "maybe", "yes"]),
    result: ResultSummary.optional(),
    proof: z.object({ upstreamReceipt: z.string(), onChainFinality: z.string() }).strict().optional(),
    nextStep: z.string().max(2_000).optional(),
  })
  .strict();
export type PurchaseSummary = z.infer<typeof PurchaseSummary>;

export const WalletSummary = z
  .object({
    ok: z.literal(true),
    wallets: z.array(z.object({ rail: z.string(), network: z.string(), address: z.string(), balance: z.string().optional(), decimals: z.number().int().optional() }).strict()).max(16),
  })
  .strict();
export type WalletSummary = z.infer<typeof WalletSummary>;

export const PingSummary = z.object({ ok: z.literal(true), state: z.enum(["unlocked", "locked"]), version: z.string() }).strict();

/**
 * 出口の検証: 組み立てた応答が schema を通ればそれを、通らなければ**固定の失敗**を返す（中身・例外の文言は出さない）。
 * 失敗の応答自身も `FailureSummary` を通す。
 */
export function toSummary<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> | FailureSummary {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data as z.infer<T>;
  return { ok: false, error: "internal_error" };
}

/** 失敗の応答を作る（code の形に合わないものは `internal_error` に落ちる）。 */
export function failure(error: string, extra: { reason?: string; retryAfterMs?: number; nextStep?: string } = {}): FailureSummary {
  const parsed = FailureSummary.safeParse({ ok: false, error, ...extra });
  return parsed.success ? parsed.data : { ok: false, error: "internal_error" };
}
