/**
 * SubEtha の settle facilitator の `GET /costs`（`docs/exact-pricing-design.md` §3）。読み取りだけ。投げない（使えなければ `undefined`）。
 * - settle 先の token を `Authorization` に付ける（settle 先の origin にだけ）。redirect は拒否、256 KiB、3 秒、再試行なし。
 * - 読めた値は 60 秒使い回し、進行中の読み取りは共有する。失敗したらしばらく読みに行かず、その間は 10 分以内の前の値を使う。
 * - 応答は信用しない: 検査した数だけを返す。生の本文・token・URL は残さない。
 */
import type { GuardedTransport } from "../../net/guarded-fetch.js";
import { readBoundedBody } from "../../net/bounded-body.js";
import type { SettleCosts } from "../../shared/exact-pricing.js";

/** 20 tx × まとめ送りの上限 20 件 = 400 item（1 item 約 330 byte）が入る大きさ。 */
export const SETTLE_COSTS_MAX_BYTES = 256 * 1024;
export const SETTLE_COSTS_TIMEOUT_MS = 3_000;
export const SETTLE_COSTS_FRESH_MS = 60_000;
export const SETTLE_COSTS_STALE_MS = 600_000;
export const SETTLE_COSTS_BACKOFF_MS = 10_000;
const MAX_ITEMS = 500;
const DIGITS = /^(0|[1-9][0-9]{0,29})$/;

export interface SettleCostsReader {
  read(): Promise<SettleCosts | undefined>;
}
export interface SettleCostsOptions {
  /** settle 先の base URL（末尾 / 無し）。 */
  readonly baseUrl: string;
  readonly token: () => string;
  readonly transport: GuardedTransport;
  readonly chainId: number;
  readonly asset: string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 応答の検査（純粋。要件 R4）。 */
export function parseSettleCosts(json: unknown, expected: { readonly chainId: number; readonly asset: string }, readAtMs: number): SettleCosts | undefined {
  if (!isRecord(json) || json["chainId"] !== expected.chainId) return undefined;
  const token = json["token"];
  if (typeof token !== "string" || token.toLowerCase() !== expected.asset.toLowerCase()) return undefined;
  const asOfBlock = json["asOfBlock"];
  if (typeof asOfBlock !== "number" || !Number.isSafeInteger(asOfBlock) || asOfBlock < 0) return undefined;
  const baseFee = json["baseFeePerGas"];
  const summary = json["summary"];
  const items = json["items"];
  if (typeof baseFee !== "string" || !DIGITS.test(baseFee) || !isRecord(summary) || !Array.isArray(items) || items.length > MAX_ITEMS) return undefined;
  const successful = summary["successfulItems"];
  if (typeof successful !== "number" || !Number.isSafeInteger(successful) || successful < 1) return undefined;
  const p90 = summary["allocatedP90Wei"];
  if (typeof p90 !== "string" || !DIGITS.test(p90)) return undefined;
  const rate = summary["overheadRate"];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate >= 0.5) return undefined;
  let l1FeeMax = 0n;
  for (const item of items as unknown[]) {
    if (!isRecord(item)) return undefined;
    const l1 = item["l1Fee"];
    if (l1 === null) continue;
    if (typeof l1 !== "string" || !DIGITS.test(l1)) return undefined;
    if (BigInt(l1) > l1FeeMax) l1FeeMax = BigInt(l1);
  }
  return { p90Wei: BigInt(p90), baseFeePerGas: BigInt(baseFee), l1FeeMax, overheadPpm: BigInt(Math.ceil(rate * 1_000_000)) + 1n, readAtMs };
}

export function createSettleCosts(options: SettleCostsOptions): SettleCostsReader {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? SETTLE_COSTS_TIMEOUT_MS;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/costs?n=20`;
  let last: SettleCosts | undefined;
  let pending: Promise<void> | undefined;
  let notBeforeMs = 0;

  async function fetchOnce(): Promise<void> {
    const readAtMs = now();
    const context = { routeId: "-", operation: "settle_facilitator_costs" };
    const signal = AbortSignal.timeout(timeoutMs);
    let backoff = SETTLE_COSTS_BACKOFF_MS;
    try {
      const response = await options.transport.fetch(url, { method: "GET", headers: { authorization: `Bearer ${options.token()}` }, redirect: "error", signal }, context);
      if (response.status === 429) {
        const raw = response.headers.get("retry-after");
        if (raw !== null && /^[0-9]{1,6}$/.test(raw.trim())) backoff = Math.min(300, Math.max(1, Number(raw.trim()))) * 1000;
      }
      const aborted = new Promise<"timeout">((resolve) => {
        if (signal.aborted) resolve("timeout");
        else signal.addEventListener("abort", () => resolve("timeout"), { once: true });
      });
      const read = await Promise.race([readBoundedBody(response, SETTLE_COSTS_MAX_BYTES), aborted]);
      if (read === "timeout") {
        await response.body?.cancel().catch(() => undefined);
      } else if (read.ok && response.status === 200) {
        const parsed = parseSettleCosts(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)), { chainId: options.chainId, asset: options.asset }, readAtMs);
        if (parsed !== undefined) {
          last = parsed;
          notBeforeMs = 0;
          return;
        }
      }
    } catch {
      // 読めなかった（接続・期限・JSON）。下で待つ。
    }
    notBeforeMs = now() + backoff;
  }

  return {
    async read(): Promise<SettleCosts | undefined> {
      const startMs = now();
      const age = last === undefined ? Number.POSITIVE_INFINITY : startMs - last.readAtMs;
      // 時計が戻った（age < 0）値は使わない。
      if (!(age >= 0 && age < SETTLE_COSTS_FRESH_MS)) {
        if (pending !== undefined) await pending;
        else if (startMs >= notBeforeMs) {
          pending = fetchOnce().finally(() => {
            pending = undefined;
          });
          await pending;
        }
      }
      const current = last;
      if (current === undefined) return undefined;
      const ageNow = now() - current.readAtMs;
      return ageNow >= 0 && ageNow < SETTLE_COSTS_STALE_MS ? current : undefined;
    },
  };
}
