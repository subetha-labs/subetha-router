/**
 * Hyperliquid の取得と Provider A の本文（`docs/provider-x402-workers.md` §2.3。記録済みの契約: `docs/t5-design.md` §1.5）。
 * 取得と形の検証は支払いの前（verify の前）。満たさなければ `DataUnavailableError`（Provider は 502、facilitator は呼ばない）。
 */
export const MAX_DATA_BYTES = 1024 * 1024;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

export interface Snapshot {
  readonly providerId: "market-data-a";
  readonly market: { readonly kind: "perpetual"; readonly symbol: "ETH"; readonly quote: "USD" };
  readonly dataSource: { readonly name: "hyperliquid"; readonly network: "hyperliquid-mainnet" };
  readonly payment: { readonly protocol: "x402"; readonly network: string };
  readonly fetchedAt: string;
  readonly data: {
    readonly markPx: string;
    readonly prevDayPx: string;
    readonly dayNtlVlm: string;
    readonly change24h: { readonly absolute: string; readonly percent: string };
    readonly assetIndex: number;
  };
}

export class DataUnavailableError extends Error {
  constructor() {
    super("data_unavailable");
    this.name = "DataUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 契約の「正」: `-` で始まらず `1`〜`9` を含む。 */
export function isPositiveDecimal(value: string): boolean {
  return DECIMAL.test(value) && !value.startsWith("-") && /[1-9]/.test(value);
}
export function isNonNegativeDecimal(value: string): boolean {
  return DECIMAL.test(value) && !value.startsWith("-");
}

function scaledOf(s: string, scale: number): bigint {
  const [whole, frac = ""] = s.split(".");
  const negative = whole!.startsWith("-");
  const digits = (negative ? whole!.slice(1) : whole!) + frac.padEnd(scale, "0").slice(0, scale);
  const value = BigInt(digits);
  return negative ? -value : value;
}

function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const abs = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = abs.slice(0, abs.length - scale);
  const frac = abs.slice(abs.length - scale);
  return `${negative ? "-" : ""}${whole}${scale === 0 ? "" : `.${frac}`}`;
}

/** 10 進文字列の引き算（桁は多い方に合わせる。指数表記を作らない）。 */
export function subtractDecimal(a: string, b: string): string {
  const scale = Math.max((a.split(".")[1] ?? "").length, (b.split(".")[1] ?? "").length);
  return formatScaled(scaledOf(a, scale) - scaledOf(b, scale), scale);
}

/** `absolute / prev × 100` を小数 2 桁（記録済みの fixture と同じく**切り捨て**: 49.72 / 2950.40 → 1.68）。`prev` が 0 なら失敗。 */
export function percentOf(absolute: string, prev: string): string {
  const scale = 8;
  const prevScaled = scaledOf(prev, scale);
  if (prevScaled === 0n) throw new DataUnavailableError();
  const numerator = scaledOf(absolute, scale) * 10_000n; // ×100 ×100（小数 2 桁分）
  const negative = (numerator < 0n) !== (prevScaled < 0n);
  const absNum = numerator < 0n ? -numerator : numerator;
  const absPrev = prevScaled < 0n ? -prevScaled : prevScaled;
  const truncated = absNum / absPrev;
  return formatScaled(negative && truncated !== 0n ? -truncated : truncated, 2);
}

/** Hyperliquid の `metaAndAssetCtxs` の応答から ETH の行を取り出し、契約の形と制約を検証する。 */
export function snapshotOf(json: unknown, paymentNetwork: string, now: () => number = Date.now): Snapshot {
  if (!Array.isArray(json) || json.length !== 2 || !isRecord(json[0]) || !Array.isArray(json[0]["universe"]) || !Array.isArray(json[1])) throw new DataUnavailableError();
  const universe = json[0]["universe"] as unknown[];
  const contexts = json[1] as unknown[];
  const assetIndex = universe.findIndex((asset) => isRecord(asset) && asset["name"] === "ETH");
  const context = contexts[assetIndex];
  if (assetIndex < 0 || !Number.isSafeInteger(assetIndex) || !isRecord(context)) throw new DataUnavailableError();
  const markPx = context["markPx"];
  const prevDayPx = context["prevDayPx"];
  const dayNtlVlm = context["dayNtlVlm"];
  if (typeof markPx !== "string" || !isPositiveDecimal(markPx)) throw new DataUnavailableError();
  if (typeof prevDayPx !== "string" || !isPositiveDecimal(prevDayPx)) throw new DataUnavailableError();
  if (typeof dayNtlVlm !== "string" || !isNonNegativeDecimal(dayNtlVlm)) throw new DataUnavailableError();
  const absolute = subtractDecimal(markPx, prevDayPx);
  const percent = percentOf(absolute, prevDayPx);
  const fetchedAt = new Date(now()).toISOString();
  return {
    providerId: "market-data-a",
    market: { kind: "perpetual", symbol: "ETH", quote: "USD" },
    dataSource: { name: "hyperliquid", network: "hyperliquid-mainnet" },
    payment: { protocol: "x402", network: paymentNetwork },
    fetchedAt,
    data: { markPx, prevDayPx, dayNtlVlm, change24h: { absolute, percent }, assetIndex },
  };
}

export async function fetchSnapshot(dataUrl: string, paymentNetwork: string, timeoutMs: number, doFetch: typeof fetch = fetch, now: () => number = Date.now): Promise<Snapshot> {
  if (timeoutMs <= 0) throw new DataUnavailableError();
  let response: Response;
  try {
    response = await doFetch(dataUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new DataUnavailableError();
  }
  if (response.status !== 200) throw new DataUnavailableError();
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new DataUnavailableError();
  }
  if (text.length > MAX_DATA_BYTES) throw new DataUnavailableError();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DataUnavailableError();
  }
  return snapshotOf(json, paymentNetwork, now);
}
