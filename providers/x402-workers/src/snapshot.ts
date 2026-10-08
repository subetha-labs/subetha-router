/**
 * Hyperliquid の取得と Provider A の本文（`docs/provider-x402-workers.md` §2.3。記録済みの契約: `docs/t5-design.md` §1.5）。
 * 取得と形の検証は支払いの前（verify の前）。応答は **byte の上限まで**読み、組んだ本文は **直列化して 64 KiB 以内**であることを
 * verify の前に確かめる。満たさなければ `DataUnavailableError`（Provider は 502、facilitator は呼ばない）。
 */
import { DeadlineError, withSignal } from "./deadline.js";

/** Hyperliquid の応答（数十 KiB）の読取の上限。 */
export const MAX_DATA_BYTES = 256 * 1024;
/** 組んだ本文の上限（Router の受け取りの上限 256 KiB の内側。契約の本文は数百バイト）。 */
export const MAX_SNAPSHOT_BYTES = 64 * 1024;
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

function scaleOf(s: string): number {
  return (s.split(".")[1] ?? "").length;
}

/** 10 進文字列を `scale` 桁の整数に（桁が足りなければ 0 を補う。多ければ呼び出し側が scale を合わせる）。 */
function scaledOf(s: string, scale: number): bigint {
  const [whole, frac = ""] = s.split(".");
  const negative = whole!.startsWith("-");
  if (frac.length > scale) throw new DataUnavailableError();
  const digits = (negative ? whole!.slice(1) : whole!) + frac.padEnd(scale, "0");
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

/** `a − b` を**正確に**（両方の桁の大きい方で）。 */
export function subtractDecimal(a: string, b: string): string {
  const scale = Math.max(scaleOf(a), scaleOf(b));
  return formatScaled(scaledOf(a, scale) - scaledOf(b, scale), scale);
}

/** 10 進文字列を `scale` 桁へ 0 方向に切り詰める（桁が足りなければ 0 を補う）。`-0.0` は `0.0`。 */
export function truncateToScale(value: string, scale: number): string {
  const own = scaleOf(value);
  if (own <= scale) return formatScaled(scaledOf(value, scale), scale);
  const exact = scaledOf(value, own);
  const pow = 10n ** BigInt(own - scale);
  const truncated = exact < 0n ? -((-exact) / pow) : exact / pow;
  return formatScaled(truncated, scale);
}

/** `absolute / prev × 100` を小数 2 桁（**最後に 1 度だけ** 0 方向に切り詰め: 49.72 / 2950.40 → 1.68）。`prev` が 0 なら失敗。入力の桁は保つ。 */
export function percentOf(absolute: string, prev: string): string {
  const sa = scaleOf(absolute);
  const sp = scaleOf(prev);
  const a = scaledOf(absolute, sa);
  const p = scaledOf(prev, sp);
  if (p === 0n) throw new DataUnavailableError();
  // percent×100（小数 2 桁分の整数）= a/10^sa ÷ p/10^sp × 100 × 100 = a × 10^sp × 10000 / (p × 10^sa)
  const numerator = a * 10n ** BigInt(sp) * 10_000n;
  const denominator = p * 10n ** BigInt(sa);
  const negative = (numerator < 0n) !== (denominator < 0n);
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;
  const truncated = absNum / absDen;
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
  // 差は正確に取り、本文の `absolute` は markPx の桁へ切り詰める。percent は**切り詰める前の差**から（最後に 1 度だけ丸める）。
  const exactDifference = subtractDecimal(markPx, prevDayPx);
  const absolute = truncateToScale(exactDifference, scaleOf(markPx));
  const percent = percentOf(exactDifference, prevDayPx);
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

/** 本文の直列化（verify の前に 1 度だけ。大きさの上限を確かめる）。 */
export function serializeSnapshot(snapshot: Snapshot): { readonly text: string; readonly bytes: number } {
  const text = JSON.stringify(snapshot);
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_SNAPSHOT_BYTES) throw new DataUnavailableError();
  return { text, bytes };
}

/** 応答の本文を byte の上限まで読む（超えれば失敗。signal が切れれば `DeadlineError`）。 */
async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new DataUnavailableError();
  }
  if (response.body === null) throw new DataUnavailableError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new DeadlineError();
      const { done, value } = await withSignal(signal, reader.read());
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new DataUnavailableError();
      chunks.push(value);
    }
  } catch (error) {
    // cancel は待たない（相手が応じなくても戻る）。
    void reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchSnapshot(dataUrl: string, paymentNetwork: string, signal: AbortSignal, doFetch: typeof fetch | undefined = undefined, now: () => number = Date.now): Promise<Snapshot> {
  if (signal.aborted) throw new DeadlineError();
  let response: Response;
  try {
    // global の fetch は `this` を付けずに呼ぶ（workerd）。
    response = await (doFetch === undefined ? fetch : doFetch)(dataUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      redirect: "manual",
      signal,
    });
  } catch {
    if (signal.aborted) throw new DeadlineError();
    throw new DataUnavailableError();
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    throw new DataUnavailableError();
  }
  const bytes = await readBounded(response, MAX_DATA_BYTES, signal);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new DataUnavailableError();
  }
  return snapshotOf(json, paymentNetwork, now);
}
