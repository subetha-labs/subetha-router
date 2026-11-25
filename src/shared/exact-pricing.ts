/**
 * `subetha-exact` の静的 route の受け取り額を費用の式で決める（`docs/exact-pricing-requirements.md`、`docs/exact-pricing-design.md`）。
 * 純粋（I/O も時計も持たない）。額は base units（6 桁、1 USD = 1,000,000）、gas の費用は wei。整数だけで計算し、割り算は全て切り上げる（受け取りが不足しない側）。
 */

export const EXACT_PRICING_KIND = "settle-cost-v1" as const;
/** 1 件だけの settle の gas（本番の 2 件の実測。SubEtha の担当の見積もりと同じ）。 */
export const SINGLE_SETTLE_GAS = 156_633n;
/** 受け取り額にかかる protocol の分（戻す額の 0.35%）。 */
const SHARE_PER_10K = 35n;
const ETH_PRICE_MIN = 100_000_000n;
const ETH_PRICE_MAX = 100_000_000_000n;
/** ETH の価格の時刻が今より先でも許す幅（時計のずれ）。 */
export const ETH_PRICE_FUTURE_MS = 5 * 60_000;
/** 記録の `issuedAtMs` が承認の期限より前で、この幅の中にあること（設計 §5）。 */
export const PRICING_ISSUE_WINDOW_MS = 20 * 60_000;
const DAY_MS = 86_400_000;
/** 上流の額（base units）の形。 */
export const UPSTREAM_AMOUNT = /^[1-9][0-9]{0,29}$/;
const DIGITS = /^(0|[1-9][0-9]{0,29})$/;

/** route の設定の `pricing`（検査済み）。額と wei は 10 進の文字列。 */
export interface ExactPricingConfig {
  readonly kind: typeof EXACT_PRICING_KIND;
  readonly factorBps: number;
  readonly take: string;
  readonly withdrawCost: string;
  readonly withdrawBatch: number;
  readonly tipWei: string;
  readonly l1FloorWei: string;
  readonly maxSettle: string;
  readonly maxAmount: string;
  /** 1 日（UTC）に出せる件数。指紋に入れない。 */
  readonly maxPerDay: number;
  /** ETH の価格の有効期間（日）。指紋に入れない。 */
  readonly ethPriceMaxAgeDays: number;
}

const INTEGERS: readonly (readonly [keyof ExactPricingConfig & string, number, number])[] = [
  ["factorBps", 10_000, 100_000],
  ["withdrawBatch", 1, 100],
  ["maxPerDay", 1, 1_000],
  ["ethPriceMaxAgeDays", 1, 30],
];
const AMOUNTS: readonly (readonly [keyof ExactPricingConfig & string, bigint, bigint])[] = [
  ["take", 0n, 10_000n],
  ["withdrawCost", 0n, 1_000_000n],
  ["tipWei", 0n, 10_000_000_000n],
  ["l1FloorWei", 0n, 1_000_000_000_000_000n],
  ["maxSettle", 1n, 10_000n],
  ["maxAmount", 1n, 20_000n],
];
const KEYS: ReadonlySet<string> = new Set<string>(["kind", ...INTEGERS.map(([key]) => key), ...AMOUNTS.map(([key]) => key)]);

/** 設定の検査。違えば欄の名前だけの文（値は出さない）。 */
export function parseExactPricing(raw: unknown): { readonly ok: true; readonly pricing: ExactPricingConfig } | { readonly ok: false; readonly problem: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, problem: "must be an object" };
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!KEYS.has(key)) return { ok: false, problem: "has an unknown field" };
  if (record["kind"] !== EXACT_PRICING_KIND) return { ok: false, problem: `kind must be "${EXACT_PRICING_KIND}"` };
  for (const [key, min, max] of INTEGERS) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return { ok: false, problem: `${key} must be an integer from ${String(min)} to ${String(max)}` };
  }
  for (const [key, min, max] of AMOUNTS) {
    const value = record[key];
    if (typeof value !== "string" || !DIGITS.test(value) || BigInt(value) < min || BigInt(value) > max) return { ok: false, problem: `${key} must be a decimal string from ${min.toString()} to ${max.toString()}` };
  }
  return { ok: true, pricing: { ...(record as unknown as ExactPricingConfig) } };
}

/** 指紋に入れる欄（支払いの条件。件数と価格の期限は入れない。設計 §2）。 */
export function pricingTermsOf(pricing: ExactPricingConfig): Record<string, unknown> {
  const { maxPerDay: _day, ethPriceMaxAgeDays: _age, ...terms } = pricing;
  return terms;
}

// ---- ETH の価格（運用者が設定する固定値。要件 §3.1） ---------------------------------------------------------------------

export interface EthPrice {
  /** 1 ETH あたりの base units。 */
  readonly price: bigint;
  readonly atMs: number;
}

/** env の値を読む。形が違えば `undefined`（起動は止めない。新しい offer だけ断る）。 */
export function parseEthPrice(priceRaw: string | undefined, atRaw: string | undefined): EthPrice | undefined {
  if (priceRaw === undefined || atRaw === undefined) return undefined;
  if (!/^[1-9][0-9]{0,11}$/.test(priceRaw)) return undefined;
  const price = BigInt(priceRaw);
  if (price < ETH_PRICE_MIN || price > ETH_PRICE_MAX) return undefined;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$/.test(atRaw)) return undefined;
  const atMs = Date.parse(atRaw);
  // `Date.parse` は 2 月 30 日などを繰り上げるので、書き戻して確かめる。
  if (!Number.isSafeInteger(atMs) || atMs <= 0 || new Date(atMs).toISOString() !== (atRaw.includes(".") ? atRaw : atRaw.replace("Z", ".000Z"))) return undefined;
  return { price, atMs };
}

export function ethPriceUsable(price: EthPrice | undefined, nowMs: number, maxAgeDays: number): price is EthPrice {
  return price !== undefined && price.atMs <= nowMs + ETH_PRICE_FUTURE_MS && nowMs < price.atMs + maxAgeDays * DAY_MS;
}

// ---- 費用と式 ---------------------------------------------------------------------------------------------------------

/** 検査済みの `/costs` の値（`src/adapters/inbound/settle-costs.ts`）。 */
export interface SettleCosts {
  readonly p90Wei: bigint;
  readonly baseFeePerGas: bigint;
  /** service 全体の 1 tx の L1 費用の最大（`summary.l1FeeMaxWei`）。 */
  readonly l1FeeMax: bigint;
  /** `overheadRate` × 10^6 を切り上げた整数 + 1（相手が小数 6 桁で切り捨てるため）。 */
  readonly overheadPpm: bigint;
  readonly readAtMs: number;
}

/** 1 件の価格の内訳（記録と quote に残す）。額は base units の 10 進の文字列。 */
export interface ExactPrice {
  readonly kind: typeof EXACT_PRICING_KIND;
  readonly upstream: string;
  readonly settle: string;
  readonly withdraw: string;
  readonly take: string;
  /** 0.35% の分（`total` にかかる）。 */
  readonly share: string;
  readonly total: string;
  readonly costsAtMs: number;
}
/** 記録（`source.pricing`）。`issuedAtMs` は枠を予約した時刻。 */
export interface ExactPriceRecord extends ExactPrice {
  readonly issuedAtMs: number;
}

export type ExactPriceFailure = "pricing_unavailable" | "pricing_over_limit";

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const totalOf = (covered: bigint): bigint => ceilDiv(covered * 10_000n, 10_000n - SHARE_PER_10K);
const shareOf = (total: bigint): bigint => ceilDiv(total * SHARE_PER_10K, 10_000n);

export function computeExactPrice(pricing: ExactPricingConfig, upstreamAmount: string, costs: SettleCosts, ethPrice: bigint): { readonly ok: true; readonly price: ExactPrice } | { readonly ok: false; readonly reason: ExactPriceFailure } {
  if (!UPSTREAM_AMOUNT.test(upstreamAmount) || costs.overheadPpm < 0n || costs.overheadPpm >= 1_000_000n) return { ok: false, reason: "pricing_unavailable" };
  const upstream = BigInt(upstreamAmount);
  const floor = BigInt(pricing.l1FloorWei);
  const l1 = costs.l1FeeMax > floor ? costs.l1FeeMax : floor;
  const single = SINGLE_SETTLE_GAS * (costs.baseFeePerGas + BigInt(pricing.tipWei)) + l1;
  const settleWei = costs.p90Wei > single ? costs.p90Wei : single;
  const settle = ceilDiv(settleWei * ethPrice * BigInt(pricing.factorBps) * 1_000_000n, 10n ** 18n * 10_000n * (1_000_000n - costs.overheadPpm));
  const withdraw = ceilDiv(BigInt(pricing.withdrawCost), BigInt(pricing.withdrawBatch));
  const take = BigInt(pricing.take);
  const total = totalOf(upstream + settle + withdraw + take);
  if (settle > BigInt(pricing.maxSettle) || total > BigInt(pricing.maxAmount)) return { ok: false, reason: "pricing_over_limit" };
  return {
    ok: true,
    price: { kind: EXACT_PRICING_KIND, upstream: upstream.toString(), settle: settle.toString(), withdraw: withdraw.toString(), take: take.toString(), share: shareOf(total).toString(), total: total.toString(), costsAtMs: costs.readAtMs },
  };
}

const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** 内訳の検査 (a)（設計 §7）。`limits` があれば route の上限も見る。 */
export function priceConsistent(price: unknown, upstreamAmount: string, limits?: ExactPricingConfig): price is ExactPrice {
  if (typeof price !== "object" || price === null) return false;
  const p = price as Record<string, unknown>;
  if (p["kind"] !== EXACT_PRICING_KIND || !positiveInt(p["costsAtMs"]) || p["upstream"] !== upstreamAmount || !UPSTREAM_AMOUNT.test(upstreamAmount)) return false;
  const values = ["settle", "withdraw", "take", "share", "total"].map((key) => p[key]);
  if (!values.every((value): value is string => typeof value === "string" && DIGITS.test(value))) return false;
  const [settle, withdraw, take, share, total] = values.map((value) => BigInt(value)) as [bigint, bigint, bigint, bigint, bigint];
  if (total !== totalOf(BigInt(upstreamAmount) + settle + withdraw + take) || share !== shareOf(total)) return false;
  return limits === undefined || (settle <= BigInt(limits.maxSettle) && total <= BigInt(limits.maxAmount));
}

/** 記録の検査 (b)（設計 §7）: (a) に加えて、上流の額・受け取り額・offer の額・予約の時刻に結び付いていること。 */
export function pricingMatches(
  record: unknown,
  bound: { readonly upstreamOfferAmount: unknown; readonly quoted: unknown; readonly sourceAmount: unknown; readonly offerAmount: unknown; readonly approvalDeadlineMs: number },
): record is ExactPriceRecord {
  if (typeof bound.upstreamOfferAmount !== "string" || bound.quoted !== bound.upstreamOfferAmount || !priceConsistent(record, bound.upstreamOfferAmount)) return false;
  const { total, issuedAtMs } = record as unknown as Record<string, unknown>;
  if (bound.sourceAmount !== total || bound.offerAmount !== total) return false;
  return positiveInt(issuedAtMs) && issuedAtMs < bound.approvalDeadlineMs && bound.approvalDeadlineMs - issuedAtMs <= PRICING_ISSUE_WINDOW_MS;
}

/** 端数（記録しない。見せる時に計算する）。 */
export function roundingOf(price: ExactPrice): string {
  return (BigInt(price.total) - BigInt(price.upstream) - BigInt(price.settle) - BigInt(price.withdraw) - BigInt(price.take) - BigInt(price.share)).toString();
}

/** UTC の日。 */
export function utcDayOf(ms: number): number {
  return Math.floor(ms / DAY_MS);
}
