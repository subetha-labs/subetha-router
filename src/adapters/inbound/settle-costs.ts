/**
 * SubEtha の settle facilitator の `GET /costs`（`docs/exact-costs-reader-design.md`）。読み取りだけ。投げない（使えなければ欄が無い）。
 * - settle 先の token を `Authorization` に付ける（settle 先の origin にだけ）。redirect は拒否、256 KiB、読み取り全体で 3 秒、再試行なし。
 * - 1 回の答えから、費用（式の価格）と自分の tenant の `accepting` を取る。進行中の読み取りは共有し、`read()` は返す時点の状態から両方を 1 度に取り出す。
 * - 答えの後は 60 秒、失敗の後は 10 秒（429 は `Retry-After`）読みに行かない。`accepting: true` は 60 秒、`false` と費用は 10 分まで使う。
 * - 応答は信用しない: 検査した値だけを返す。生の本文・token・URL は残さない。
 */
import type { GuardedTransport } from "../../net/guarded-fetch.js";
import { readBoundedBody } from "../../net/bounded-body.js";
import type { SettleCosts } from "../../shared/exact-pricing.js";

/** 最大 500 行（相手の上限）の応答が入る大きさ。 */
export const SETTLE_COSTS_MAX_BYTES = 256 * 1024;
export const SETTLE_COSTS_TIMEOUT_MS = 3_000;
export const SETTLE_COSTS_FRESH_MS = 60_000;
export const SETTLE_COSTS_STALE_MS = 600_000;
export const SETTLE_COSTS_BACKOFF_MS = 10_000;
const MAX_ITEMS = 500;
const DIGITS = /^(0|[1-9][0-9]{0,29})$/;

export interface SettleCostsReading {
  readonly costs?: SettleCosts;
  /** 自分の tenant の受付（無ければ不明）。 */
  readonly accepting?: boolean;
}
export interface SettleCostsReader {
  read(): Promise<SettleCostsReading>;
}
export interface SettleCostsOptions {
  /** settle 先の base URL（末尾 / 無し）。 */
  readonly baseUrl: string;
  readonly token: () => string;
  readonly transport: GuardedTransport;
  readonly chainId: number;
  readonly asset: string;
  /** 自分の tenant（Provider の URL の `/p/<id>` の `<id>`）。 */
  readonly tenant: string;
  /** 壁時計（ms）。 */
  readonly now?: () => number;
  /** 単調な時計（ms）。 */
  readonly monotonicNow?: () => number;
  readonly timeoutMs?: number;
}
interface SettleCostsExpectation {
  readonly chainId: number;
  readonly asset: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 「答え」かどうか: chain id と token が route と一致する object（設計 C5）。 */
function identityOk(json: unknown, expected: SettleCostsExpectation): json is Record<string, unknown> {
  if (!isRecord(json) || json["chainId"] !== expected.chainId) return false;
  const token = json["token"];
  return typeof token === "string" && token.toLowerCase() === expected.asset.toLowerCase();
}

/** 費用の検査（純粋。要件 R4、設計 C1・C2）。`l1` は service 全体の `summary.l1FeeMaxWei` だけ（行の中身は読まない）。 */
export function parseSettleCosts(json: unknown, expected: SettleCostsExpectation, readAtMs: number): SettleCosts | undefined {
  if (!identityOk(json, expected)) return undefined;
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
  const l1 = summary["l1FeeMaxWei"];
  if (typeof l1 !== "string" || !DIGITS.test(l1)) return undefined;
  return { p90Wei: BigInt(p90), baseFeePerGas: BigInt(baseFee), l1FeeMax: BigInt(l1), overheadPpm: BigInt(Math.ceil(rate * 1_000_000)) + 1n, readAtMs };
}

/** 自分の tenant の受付（純粋。設計 C4）。項がちょうど 1 つで `accepting` が boolean の時だけ値。`reason`・残りの数値は使わない。 */
export function parseTenantAccepting(json: unknown, expected: SettleCostsExpectation, tenant: string): boolean | undefined {
  if (!identityOk(json, expected)) return undefined;
  const budget = json["budget"];
  if (!Array.isArray(budget)) return undefined;
  const mine = (budget as unknown[]).filter((entry) => isRecord(entry) && entry["tenant"] === tenant) as Record<string, unknown>[];
  const accepting = mine.length === 1 ? mine[0]!["accepting"] : undefined;
  return typeof accepting === "boolean" ? accepting : undefined;
}

interface Stamped<T> {
  readonly value: T;
  readonly wallMs: number;
  readonly monoMs: number;
}
type FetchResult = { readonly kind: "answer"; readonly json: unknown } | { readonly kind: "failed"; readonly backoffMs: number };

export function createSettleCosts(options: SettleCostsOptions): SettleCostsReader {
  const now = options.now ?? (() => Date.now());
  const mono = options.monotonicNow ?? (() => performance.now());
  const timeoutMs = options.timeoutMs ?? SETTLE_COSTS_TIMEOUT_MS;
  const expected: SettleCostsExpectation = { chainId: options.chainId, asset: options.asset };
  const url = `${options.baseUrl.replace(/\/+$/, "")}/costs?n=100`;
  let costs: Stamped<SettleCosts> | undefined;
  let accepting: Stamped<boolean> | undefined;
  let pending: Promise<void> | undefined;
  let notBeforeMono = Number.NEGATIVE_INFINITY;

  async function request(signal: AbortSignal): Promise<FetchResult> {
    let backoffMs = SETTLE_COSTS_BACKOFF_MS;
    try {
      const response = await options.transport.fetch(url, { method: "GET", headers: { authorization: `Bearer ${options.token()}` }, redirect: "error", signal }, { routeId: "-", operation: "settle_facilitator_costs" });
      // 時間切れの後に届いた応答は使わない（呼び出し側はもう待っていない）。
      if (signal.aborted) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "failed", backoffMs };
      }
      if (response.status === 429) {
        const raw = response.headers.get("retry-after");
        if (raw !== null && /^[0-9]{1,6}$/.test(raw.trim())) backoffMs = Math.min(300, Math.max(1, Number(raw.trim()))) * 1000;
      }
      const aborted = new Promise<"timeout">((resolve) => {
        if (signal.aborted) resolve("timeout");
        else signal.addEventListener("abort", () => resolve("timeout"), { once: true });
      });
      const read = await Promise.race([readBoundedBody(response, SETTLE_COSTS_MAX_BYTES), aborted]);
      if (read === "timeout") {
        await response.body?.cancel().catch(() => undefined);
      } else if (read.ok && response.status === 200) {
        const json: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
        if (identityOk(json, expected)) return { kind: "answer", json };
      }
    } catch {
      // 読めなかった（接続・期限・JSON）。下で待つ。
    }
    return { kind: "failed", backoffMs };
  }

  async function refresh(): Promise<void> {
    const wallMs = now();
    const monoMs = mono();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 読み取り全体（DNS・headers・本文）を打ち切る。transport が中断に応じなくても、待つ側はここで必ず解放される。
    const expired = new Promise<FetchResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "failed", backoffMs: SETTLE_COSTS_BACKOFF_MS });
      }, timeoutMs);
    });
    const result = await Promise.race([request(controller.signal), expired]).finally(() => clearTimeout(timer));
    if (result.kind === "failed") {
      notBeforeMono = mono() + result.backoffMs;
      return;
    }
    const parsed = parseSettleCosts(result.json, expected, wallMs);
    if (parsed !== undefined) costs = { value: parsed, wallMs, monoMs };
    const tenantAccepting = parseTenantAccepting(result.json, expected, options.tenant);
    accepting = tenantAccepting === undefined ? undefined : { value: tenantAccepting, wallMs, monoMs };
    notBeforeMono = monoMs + SETTLE_COSTS_FRESH_MS;
  }

  /** 読み取りの開始からの経過（壁時計と単調な時計の大きい方）。壁時計が戻った値は使わない。 */
  function within(stamped: Stamped<unknown>, maxMs: number): boolean {
    const wall = now() - stamped.wallMs;
    return wall >= 0 && Math.max(wall, mono() - stamped.monoMs) < maxMs;
  }

  return {
    async read(): Promise<SettleCostsReading> {
      if (pending === undefined && mono() >= notBeforeMono) {
        pending = refresh().finally(() => {
          pending = undefined;
        });
      }
      if (pending !== undefined) await pending;
      // 1 度失効した値は捨てる（時計が後で直っても復活しない）。
      if (costs !== undefined && !within(costs, SETTLE_COSTS_STALE_MS)) costs = undefined;
      if (accepting !== undefined && !within(accepting, accepting.value ? SETTLE_COSTS_FRESH_MS : SETTLE_COSTS_STALE_MS)) accepting = undefined;
      return { ...(costs === undefined ? {} : { costs: costs.value }), ...(accepting === undefined ? {} : { accepting: accepting.value }) };
    },
  };
}
