/**
 * 受信レール `subetha-exact` の耐久の記録（`docs/subetha-exact-inbound-design.md` §3.2・§3.6）。既存の `openJournal` をそのまま使う
 * （`<dir>/orders.ndjson` + `<dir>/journal.lock`）。行は `{ seq, at, paymentId: <attemptId | pair>, event, patch }`。
 *
 * - 鍵は **attempt**（要求ごとの 16 バイトの乱数の hex）。`discovered` だけは pair（`requester|resource` の小文字）が鍵。
 * - index は replay と追記で更新する耐久の索引だけ（process の map を別に持たない）: `attempts`・`byPair`・`byOrderId`・`discoveredByPair`。
 * - 残さないもの: token、署名、credential、URL、principalId、`payTo`・requirements 以外の応答の本文。
 * - `requester.salt`（32 バイトの hex）: 無ければ tmp → fsync → rename → ディレクトリの fsync。ledger に行があるのに salt が無い・読めなければ `ConfigError`。
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import path from "node:path";

import { ConfigError } from "../../config.js";
import { openJournal, type Journal, type JournalRecord } from "../../core/journal.js";
import type { ParsedRequirements } from "./subetha-exact-classify.js";
import { pairKeyOf } from "./subetha-exact-classify.js";

export type LedgerEvent = "requested" | "create_failed" | "created" | "lookup" | "discovered" | "refused" | "verify" | "settle" | "release" | "complete" | "abandoned";

export interface AttemptView {
  readonly attemptId: string;
  readonly requesterDigest: string;
  readonly resourceDigest: string;
  readonly routeId: string;
  readonly amount: string;
  readonly atMs: number;
  readonly createFailed?: { readonly detail: string; readonly httpStatus?: number };
  readonly created?: { readonly orderId: string; readonly payTo: string; readonly expiresAt: number; readonly existing: boolean; readonly tenant: string; readonly requirements: ParsedRequirements; readonly atMs: number; readonly elapsedMs?: number };
  readonly refused?: { readonly detail: string; readonly httpStatus?: number };
  readonly settle?: { readonly outcome: "settled" | "unknown"; readonly txRef?: string; readonly mayStillSettleUntil?: number; readonly elapsedMs?: number };
  readonly release?: { readonly outcome: string; readonly reconstructed?: boolean; readonly elapsedMs?: number };
  readonly complete?: { readonly outcome: string; readonly reported: "delivered" | "failed"; readonly reason?: string; readonly elapsedMs?: number };
  readonly abandoned?: { readonly reason: string };
  readonly verifyCount: number;
}

export interface DiscoveredOrder {
  readonly pair: string;
  readonly orderId: string;
  readonly payTo: string;
  readonly expiresAt: number;
  readonly tenant: string;
  readonly requirements: ParsedRequirements;
  readonly requesterDigest: string;
  readonly resourceDigest: string;
}

/** 未解決の猶予（注文の TTL の後、facilitator 側の遅れを見込む秒数。§3.6）。 */
export const UNRESOLVED_GRACE_SECONDS = 60;

export interface SubethaExactLedger {
  readonly salt: string;
  /** 追記に失敗した後は真（以後の `requested` は fail closed。§3.9）。 */
  readonly broken: boolean;
  append(key: string, event: LedgerEvent, patch: Record<string, unknown>): Promise<void>;
  attempts(): readonly AttemptView[];
  attempt(attemptId: string): AttemptView | undefined;
  /** 同じ pair の attempt（要求の順）。 */
  attemptsForPair(requesterDigest: string, resourceDigest: string): readonly AttemptView[];
  /** 同じ pair の最新の `created` の attempt。 */
  latestCreatedForPair(requesterDigest: string, resourceDigest: string): AttemptView | undefined;
  /** その orderId を `created` に持つ attempt（古い順）。 */
  attemptsForOrder(orderId: string): readonly AttemptView[];
  discoveredForPair(requesterDigest: string, resourceDigest: string): readonly DiscoveredOrder[];
  hasOrder(orderId: string): boolean;
  /** 累積の要求数（`requested` の行の数）。 */
  totalRequests(): number;
  requestsSince(sinceMs: number): number;
  /** 未解決の attempt（§3.6 の (a)(b)(c) のどれでもないもの）。 */
  unresolvedAttempts(nowSec: number): readonly AttemptView[];
  /** 結び付かない `discovered`（どの attempt も `created` に持たない注文）で、期限 + 猶予の内のもの。 */
  unresolvedDiscovered(nowSec: number): readonly DiscoveredOrder[];
  unresolvedCount(nowSec: number): number;
  close(): Promise<void>;
}

const HEX64 = /^[0-9a-f]{64}$/;

function readSaltOrCreate(dir: string, hasRows: boolean): string {
  const file = path.join(dir, "requester.salt");
  let existing: string | undefined;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new ConfigError("subetha-exact ledger: requester.salt is not a regular file");
    existing = readFileSync(file, "utf8").trim();
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    existing = undefined;
  }
  if (existing !== undefined) {
    if (!HEX64.test(existing)) throw new ConfigError("subetha-exact ledger: requester.salt is malformed");
    return existing;
  }
  if (hasRows) throw new ConfigError("subetha-exact ledger: orders exist but requester.salt is missing (cannot derive the reserved requester digests)");
  const salt = randomBytes(32).toString("hex");
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${salt}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return salt;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function requirementsOf(value: unknown): ParsedRequirements | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const extra = r["extra"];
  const name = typeof extra === "object" && extra !== null ? (extra as Record<string, unknown>)["name"] : undefined;
  const version = typeof extra === "object" && extra !== null ? (extra as Record<string, unknown>)["version"] : undefined;
  if (typeof r["scheme"] !== "string" || typeof r["network"] !== "string" || typeof r["asset"] !== "string" || typeof r["amount"] !== "string" || typeof r["payTo"] !== "string" || typeof r["maxTimeoutSeconds"] !== "number" || typeof name !== "string" || typeof version !== "string") return undefined;
  return { scheme: r["scheme"], network: r["network"], asset: r["asset"], amount: r["amount"], payTo: r["payTo"], maxTimeoutSeconds: r["maxTimeoutSeconds"], extra: { name, version } };
}

/** 読取だけの索引（`startup()` の replay と、運用者の確認の lock を取らない replay が共有する）。 */
export interface LedgerIndex {
  readonly attempts: Map<string, AttemptView>;
  readonly byPair: Map<string, string[]>;
  readonly byOrderId: Map<string, string[]>;
  readonly discoveredByPair: Map<string, DiscoveredOrder[]>;
  readonly knownDiscovered: Set<string>;
  apply(record: Pick<JournalRecord, "paymentId" | "event" | "patch">): void;
  unresolvedAttempts(nowSec: number): AttemptView[];
  unresolvedDiscovered(nowSec: number): DiscoveredOrder[];
}

/** NDJSON の行（`{ paymentId, event, patch }` の形のもの）から索引を組む。形の違う行は無視する（lock は取らない）。 */
export function replayLedgerRecords(records: readonly Pick<JournalRecord, "paymentId" | "event" | "patch">[]): LedgerIndex {
  const index = createLedgerIndex();
  for (const record of records) index.apply(record);
  return index;
}

function createLedgerIndex(): LedgerIndex {
  const attempts = new Map<string, AttemptView>();
  const byPair = new Map<string, string[]>();
  const byOrderId = new Map<string, string[]>();
  const discoveredByPair = new Map<string, DiscoveredOrder[]>();
  const knownDiscovered = new Set<string>();

  const apply = (record: Pick<JournalRecord, "paymentId" | "event" | "patch">): void => {
    const key = record.paymentId;
    const patch = record.patch;
    if (record.event === "discovered") {
      const requirements = requirementsOf(patch["requirements"]);
      const pair = typeof patch["pair"] === "object" && patch["pair"] !== null ? (patch["pair"] as Record<string, unknown>) : undefined;
      const orderId = asString(patch["orderId"]);
      if (requirements === undefined || pair === undefined || orderId === undefined) return;
      const requesterDigest = asString(pair["requesterDigest"]);
      const resourceDigest = asString(pair["resourceDigest"]);
      if (requesterDigest === undefined || resourceDigest === undefined || knownDiscovered.has(orderId.toLowerCase())) return;
      knownDiscovered.add(orderId.toLowerCase());
      const list = discoveredByPair.get(key) ?? [];
      list.push({ pair: key, orderId: orderId.toLowerCase(), payTo: asString(patch["payTo"]) ?? "", expiresAt: asNumber(patch["expiresAt"]) ?? 0, tenant: asString(patch["tenant"]) ?? "", requirements, requesterDigest, resourceDigest });
      discoveredByPair.set(key, list);
      return;
    }
    if (record.event === "requested") {
      const requesterDigest = asString(patch["requesterDigest"]);
      const resourceDigest = asString(patch["resourceDigest"]);
      if (requesterDigest === undefined || resourceDigest === undefined || attempts.has(key)) return;
      attempts.set(key, { attemptId: key, requesterDigest, resourceDigest, routeId: asString(patch["routeId"]) ?? "", amount: asString(patch["amount"]) ?? "", atMs: asNumber(patch["atMs"]) ?? 0, verifyCount: 0 });
      const pair = pairKeyOf(requesterDigest, resourceDigest);
      const list = byPair.get(pair) ?? [];
      list.push(key);
      byPair.set(pair, list);
      return;
    }
    const current = attempts.get(key);
    if (current === undefined) return;
    switch (record.event) {
      case "create_failed":
        attempts.set(key, { ...current, createFailed: { detail: asString(patch["detail"]) ?? "", ...(asNumber(patch["httpStatus"]) === undefined ? {} : { httpStatus: asNumber(patch["httpStatus"])! }) } });
        return;
      case "created": {
        const orderId = asString(patch["orderId"]);
        const requirements = requirementsOf(patch["requirements"]);
        if (orderId === undefined || requirements === undefined) return;
        attempts.set(key, { ...current, created: { orderId: orderId.toLowerCase(), payTo: asString(patch["payTo"]) ?? "", expiresAt: asNumber(patch["expiresAt"]) ?? 0, existing: patch["existing"] === true, tenant: asString(patch["tenant"]) ?? "", requirements, atMs: asNumber(patch["atMs"]) ?? current.atMs, ...(asNumber(patch["elapsedMs"]) === undefined ? {} : { elapsedMs: asNumber(patch["elapsedMs"])! }) } });
        const list = byOrderId.get(orderId.toLowerCase()) ?? [];
        list.push(key);
        byOrderId.set(orderId.toLowerCase(), list);
        return;
      }
      case "refused":
        attempts.set(key, { ...current, refused: { detail: asString(patch["detail"]) ?? "", ...(asNumber(patch["httpStatus"]) === undefined ? {} : { httpStatus: asNumber(patch["httpStatus"])! }) } });
        return;
      case "verify":
        attempts.set(key, { ...current, verifyCount: current.verifyCount + 1 });
        return;
      case "settle": {
        const outcome = patch["outcome"] === "settled" ? "settled" : "unknown";
        // `settled` は上書きしない（同じ注文への 2 つ目の settle は無いが、読み戻しで弱い側に落とさない）。
        if (current.settle?.outcome === "settled") return;
        attempts.set(key, { ...current, settle: { outcome, ...(asString(patch["txRef"]) === undefined ? {} : { txRef: asString(patch["txRef"])! }), ...(asNumber(patch["mayStillSettleUntil"]) === undefined ? {} : { mayStillSettleUntil: asNumber(patch["mayStillSettleUntil"])! }), ...(asNumber(patch["elapsedMs"]) === undefined ? {} : { elapsedMs: asNumber(patch["elapsedMs"])! }) } });
        return;
      }
      case "release":
        attempts.set(key, { ...current, release: { outcome: asString(patch["outcome"]) ?? "", ...(patch["reconstructed"] === true ? { reconstructed: true } : {}), ...(asNumber(patch["elapsedMs"]) === undefined ? {} : { elapsedMs: asNumber(patch["elapsedMs"])! }) } });
        return;
      case "complete":
        attempts.set(key, { ...current, complete: { outcome: asString(patch["outcome"]) ?? "", reported: patch["reported"] === "failed" ? "failed" : "delivered", ...(asString(patch["reason"]) === undefined ? {} : { reason: asString(patch["reason"])! }), ...(asNumber(patch["elapsedMs"]) === undefined ? {} : { elapsedMs: asNumber(patch["elapsedMs"])! }) } });
        return;
      case "abandoned":
        attempts.set(key, { ...current, abandoned: { reason: asString(patch["reason"]) ?? "" } });
        return;
      default:
        return;
    }
  };
  const unresolvedAttempts = (nowSec: number): AttemptView[] =>
    [...attempts.values()].filter((attempt) => {
      if (attempt.refused !== undefined || attempt.abandoned !== undefined) return false;
      if (attempt.created !== undefined) {
        if (attempt.settle?.outcome === "settled") return false;
        if (nowSec > attempt.created.expiresAt + UNRESOLVED_GRACE_SECONDS) return false;
        return true;
      }
      // `created` の無い attempt（`create_failed`・行なし）は時間でも照会でも外れない（§3.2 の不変条件）。
      return true;
    });
  const unresolvedDiscovered = (nowSec: number): DiscoveredOrder[] =>
    [...discoveredByPair.values()].flat().filter((order) => !byOrderId.has(order.orderId) && nowSec <= order.expiresAt + UNRESOLVED_GRACE_SECONDS);
  return { attempts, byPair, byOrderId, discoveredByPair, knownDiscovered, apply, unresolvedAttempts, unresolvedDiscovered };
}

export async function openSubethaExactLedger(options: { readonly dir: string }): Promise<SubethaExactLedger> {
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const journal: Journal = await openJournal({ journalPath: path.join(options.dir, "orders.ndjson") });
  const index = replayLedgerRecords(journal.records);
  const { attempts, byPair, byOrderId, discoveredByPair, knownDiscovered, apply, unresolvedAttempts, unresolvedDiscovered } = index;
  let broken = false;
  let salt: string;
  try {
    salt = readSaltOrCreate(options.dir, journal.records.length > 0);
  } catch (error) {
    await journal.close();
    throw error;
  }

  return {
    salt,
    get broken() {
      return broken;
    },
    async append(key, event, patch) {
      try {
        await journal.append({ paymentId: key, event, patch });
      } catch (error) {
        broken = true;
        throw error;
      }
      const written = journal.records.at(-1);
      if (written !== undefined && written.paymentId === key && written.event === event) apply(written);
    },
    attempts: () => [...attempts.values()],
    attempt: (attemptId) => attempts.get(attemptId),
    attemptsForPair: (requesterDigest, resourceDigest) => (byPair.get(pairKeyOf(requesterDigest, resourceDigest)) ?? []).map((id) => attempts.get(id)!).filter((a) => a !== undefined),
    latestCreatedForPair(requesterDigest, resourceDigest) {
      const list = (byPair.get(pairKeyOf(requesterDigest, resourceDigest)) ?? []).map((id) => attempts.get(id)!).filter((a) => a?.created !== undefined);
      return list.at(-1);
    },
    attemptsForOrder: (orderId) => (byOrderId.get(orderId.toLowerCase()) ?? []).map((id) => attempts.get(id)!).filter((a) => a !== undefined),
    discoveredForPair: (requesterDigest, resourceDigest) => discoveredByPair.get(pairKeyOf(requesterDigest, resourceDigest)) ?? [],
    hasOrder: (orderId) => byOrderId.has(orderId.toLowerCase()) || knownDiscovered.has(orderId.toLowerCase()),
    totalRequests: () => attempts.size,
    requestsSince: (sinceMs) => [...attempts.values()].filter((a) => a.atMs >= sinceMs).length,
    unresolvedAttempts,
    unresolvedDiscovered,
    unresolvedCount: (nowSec) => unresolvedAttempts(nowSec).length + unresolvedDiscovered(nowSec).length,
    close: () => journal.close(),
  };
}
