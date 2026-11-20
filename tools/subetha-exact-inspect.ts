/**
 * 運用者の確認（`docs/subetha-exact-inbound-design.md` §8、要件 FR-11、タスク T-6）。**製品の経路ではなく運用者の道具。**
 *
 *   npm run subetha-exact:inspect -- [--remote] [--abandon <attemptId> --reason <token> [--confirm <attemptId>]] [--journal <path>]
 *
 * - journal（env `ROUTER_JOURNAL_PATH`、既定 `runtime/journal.ndjson`）と `<dir>/subetha-exact/orders.ndjson` を**読み取りだけ**で開く（lock は取らない:
 *   `readFileSync` で replay だけ。Router が動いていても読める）。attempt ごとに 1 行（JSON Lines）、見つかった注文（`discovered`）ごとに 1 行、最後に `summary`。
 * - `--remote` のときだけ `ROUTER_SUBETHA_EXACT_FACILITATOR_URL`・`ROUTER_SUBETHA_EXACT_TOKEN_FILE` を読み、注文ごとに `GET /exact/orders/:id`、注文の分からない
 *   attempt ごとに `GET /exact/requesters/:digest/orders?resourceDigest=` を 1 回（同時 1、`Retry-After` を守る）。**POST は 1 つも無い。**
 *   remote の欄は閉じた集合で写す（それ以外は `"other"`）。token・URL・本文・自由な文は出さない。
 * - `--abandon <attemptId> --reason <token>`: adapter の ledger に `abandoned` の 1 行を書く**だけ**（Router が動いていれば ledger の lock で失敗する = Router を
 *   止めてから）。`--reason` は `operator_timeout`／`operator_facilitator_reset`／`operator_other`。TTY なら attemptId の打ち直しで確認、TTY で無ければ `--confirm <attemptId>`。
 * - 試験だけ: `SUBETHA_EXACT_INSPECT_ALLOW_LOOPBACK=1` で loopback の facilitator（fixture）を許す。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { replayLedgerRecords, openSubethaExactLedger, type AttemptView, type DiscoveredOrder } from "../src/adapters/inbound/subetha-exact-ledger.js";
import { parseOrderView, type ParsedOrderView } from "../src/adapters/inbound/subetha-exact-classify.js";
import { JournalLockedError } from "../src/core/journal.js";
import { readSecretFile } from "../src/main.js";
import { createGuardedTransport } from "../src/net/guarded-fetch.js";
import { readBoundedBody } from "../src/net/bounded-body.js";
import { parseSubethaExactFacilitatorUrl, SUBETHA_EXACT_FACILITATOR_URL_ENV, SUBETHA_EXACT_TOKEN_FILE_ENV } from "../src/shared/subetha-exact.js";

const ORDER_STATES = new Set(["open", "accepted", "settled", "expired", "rejected", "uncertain", "settled-unknown", "late-paid", "late-unattributed", "late-transfer", "closed-unpaid", "final", "authorized", "delivered", "failed"]);
const RELEASE_STATES = new Set(["none", "authorized", "delivered", "failed"]);
const AFTER_RELEASE = new Set(["reorged", "screening-rejected"]);
const EXACT_STATES = new Set(["reserved", "signed", "observed", "paid", "canceled", "failed", "relaying", "relayed"]);
const EXACT_ORIGINS = new Set(["facilitator", "external-broadcast", "facilitator-relay"]);
export const ABANDON_REASONS = new Set(["operator_timeout", "operator_facilitator_reset", "operator_other"]);

const closed = (set: ReadonlySet<string>, value: unknown): string => (typeof value === "string" && set.has(value) ? value : "other");

interface JournalRow {
  readonly paymentId: string;
  readonly event: string;
  readonly at?: string;
  readonly patch: Record<string, unknown>;
}
interface IntentSummary {
  readonly paymentId: string;
  readonly quoteId: string;
  readonly routeId: string;
  readonly terminal: string;
  readonly sourceTxRef?: string;
  readonly released: boolean;
  readonly completed?: string;
  readonly unreported?: string;
  readonly mayStillSettleUntil?: number;
}

function readRows(file: string): JournalRow[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: JournalRow[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed["paymentId"] === "string" && typeof parsed["event"] === "string" && typeof parsed["patch"] === "object" && parsed["patch"] !== null) {
        rows.push({ paymentId: parsed["paymentId"], event: parsed["event"], ...(typeof parsed["at"] === "string" ? { at: parsed["at"] } : {}), patch: parsed["patch"] as Record<string, unknown> });
      }
    } catch {
      // 壊れた行は無視（読取だけ。書き換えない）。
    }
  }
  return rows;
}

/** journal の行の畳み込み（状態の遷移は `src/core/store.ts` の reduce と同じ写像だけを使う。read-only の snapshot なので再起動の確定はしない）。 */
export function summarizeIntents(rows: readonly JournalRow[]): Map<string, IntentSummary> {
  const out = new Map<string, IntentSummary>();
  for (const row of rows) {
    const current = out.get(row.paymentId);
    if (row.event === "created") {
      const source = row.patch["source"] as Record<string, unknown> | undefined;
      const window = source?.["settleWindow"];
      out.set(row.paymentId, { paymentId: row.paymentId, quoteId: String(row.patch["quoteId"] ?? ""), routeId: String(row.patch["routeId"] ?? ""), terminal: "created", released: false, ...(typeof window === "number" ? { mayStillSettleUntil: window } : {}) });
      continue;
    }
    if (current === undefined) continue;
    const until = row.patch["mayStillSettleUntil"];
    const withUntil = typeof until === "number" ? { mayStillSettleUntil: until } : {};
    switch (row.event) {
      case "source_pending":
      case "source_failed":
      case "destination_pending":
      case "destination_submitted":
      case "delivered":
      case "paid_undelivered":
      case "dest_failed":
      case "unknown":
        out.set(row.paymentId, { ...current, terminal: row.event, ...withUntil });
        break;
      case "source_settled":
        out.set(row.paymentId, { ...current, terminal: "source_settled", ...(typeof row.patch["txRef"] === "string" ? { sourceTxRef: String(row.patch["txRef"]).toLowerCase() } : {}) });
        break;
      case "source_released":
        out.set(row.paymentId, { ...current, released: true });
        break;
      case "source_completed":
        out.set(row.paymentId, { ...current, completed: String(row.patch["outcome"] ?? "") });
        break;
      case "source_complete_unreported":
        out.set(row.paymentId, { ...current, unreported: String(row.patch["reason"] ?? "") });
        break;
      default:
        break;
    }
  }
  return out;
}

interface RemoteView {
  readonly state: string;
  readonly release: { readonly state: string; readonly afterRelease?: string };
  readonly exact?: { readonly state: string; readonly origin: string };
}
function remoteOf(view: ParsedOrderView, raw: unknown): RemoteView {
  const status = typeof raw === "object" && raw !== null ? ((raw as Record<string, unknown>)["status"] as Record<string, unknown> | undefined) : undefined;
  const exact = status?.["exact"] as Record<string, unknown> | undefined;
  return {
    state: closed(ORDER_STATES, view.status.state),
    release: { state: closed(RELEASE_STATES, view.status.release?.state), ...(view.status.release?.afterRelease === undefined ? {} : { afterRelease: closed(AFTER_RELEASE, view.status.release.afterRelease) }) },
    ...(exact === undefined ? {} : { exact: { state: closed(EXACT_STATES, exact["state"]), origin: closed(EXACT_ORIGINS, exact["origin"]) } }),
  };
}

export interface InspectLine {
  readonly kind: "attempt" | "discovered" | "summary";
  readonly [key: string]: unknown;
}

export interface InspectOptions {
  readonly journalPath: string;
  readonly remote?: { readonly facilitatorUrl: string; readonly token: () => string; readonly allowLoopback: boolean };
  readonly nowSec?: number;
}

/** 一覧（読取だけ）。 */
export async function inspect(options: InspectOptions): Promise<InspectLine[]> {
  const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
  const journal = readRows(options.journalPath);
  const ledgerDir = path.join(path.dirname(path.resolve(options.journalPath)), "subetha-exact");
  const ledger = replayLedgerRecords(readRows(path.join(ledgerDir, "orders.ndjson")));
  const intents = summarizeIntents(journal);
  const byQuote = new Map<string, IntentSummary>();
  for (const intent of intents.values()) byQuote.set(intent.quoteId.toLowerCase(), intent);

  const remoteOrders = new Map<string, RemoteView | "unavailable">();
  const foundByLookup = new Map<string, DiscoveredOrder[]>();
  if (options.remote !== undefined) {
    const transport = createGuardedTransport({ allowLoopback: options.remote.allowLoopback, report: () => undefined });
    const base = options.remote.facilitatorUrl.replace(/\/$/, "");
    const get = async (pathname: string): Promise<{ status: number; json: unknown } | undefined> => {
      for (let tryNo = 1; tryNo <= 2; tryNo += 1) {
        let response: Response;
        try {
          response = await transport.fetch(`${base}${pathname}`, { method: "GET", headers: { authorization: `Bearer ${options.remote!.token()}` }, redirect: "error", signal: AbortSignal.timeout(15_000) }, { routeId: "-", operation: "facilitator_order_status" });
        } catch {
          return undefined;
        }
        if (response.status === 429 && tryNo === 1) {
          // `Retry-After` は守る（切り詰めない）。60 秒を超える待ちなら、この照会は諦める（短くして叩き直さない）。
          const header = response.headers.get("retry-after");
          const wait = header !== null && /^[0-9]{1,6}$/.test(header.trim()) ? Number(header.trim()) : 1;
          await response.body?.cancel().catch(() => undefined);
          if (wait > 60) return undefined;
          await new Promise((resolve) => setTimeout(resolve, wait * 1000));
          continue;
        }
        let json: unknown;
        try {
          const read = await readBoundedBody(response, 64 * 1024);
          json = read.ok ? JSON.parse(new TextDecoder().decode(read.bytes)) : undefined;
        } catch {
          json = undefined;
        }
        return { status: response.status, json };
      }
      return undefined;
    };
    const orderIds = new Set<string>([...ledger.byOrderId.keys(), ...ledger.knownDiscovered]);
    for (const orderId of orderIds) {
      const got = await get(`/exact/orders/${orderId}`);
      const view = got?.status === 200 ? parseOrderView(got.json) : undefined;
      remoteOrders.set(orderId, view === undefined ? "unavailable" : remoteOf(view, got!.json));
    }
    const seenPairs = new Set<string>();
    for (const attempt of ledger.attempts.values()) {
      // 注文の分からない attempt（abandon 済みも含む: 読取だけの発見は続ける。FR-9.2 (e)）。
      if (attempt.created !== undefined || attempt.refused !== undefined) continue;
      const pair = `${attempt.requesterDigest.toLowerCase()}|${attempt.resourceDigest.toLowerCase()}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      const got = await get(`/exact/requesters/${attempt.requesterDigest}/orders?resourceDigest=${attempt.resourceDigest}`);
      const orders = got?.status === 200 && typeof got.json === "object" && got.json !== null && Array.isArray((got.json as Record<string, unknown>)["orders"]) ? ((got.json as Record<string, unknown>)["orders"] as unknown[]) : [];
      const found: DiscoveredOrder[] = [];
      for (const raw of orders) {
        const view = parseOrderView(raw);
        if (view === undefined) continue;
        found.push({ pair, orderId: view.orderId, payTo: view.requirements.payTo, expiresAt: view.status.expiresAt, tenant: "", requirements: view.requirements, requesterDigest: attempt.requesterDigest, resourceDigest: attempt.resourceDigest });
        if (!remoteOrders.has(view.orderId)) remoteOrders.set(view.orderId, remoteOf(view, raw));
      }
      foundByLookup.set(pair, found);
    }
  }

  const lines: InspectLine[] = [];
  let mismatches = 0;
  const attempts = [...ledger.attempts.values()].sort((a, b) => a.atMs - b.atMs);
  for (const attempt of attempts) {
    const orderId = attempt.created?.orderId;
    const intent = orderId === undefined ? undefined : byQuote.get(orderId);
    const pair = `${attempt.requesterDigest.toLowerCase()}|${attempt.resourceDigest.toLowerCase()}`;
    const remote = orderId === undefined ? undefined : remoteOrders.get(orderId);
    const lookupHit = orderId === undefined && (foundByLookup.get(pair)?.length ?? 0) > 0;
    const routerUnpaid = intent !== undefined && (intent.terminal === "source_failed" || (intent.terminal === "unknown" && intent.sourceTxRef === undefined));
    const mismatch =
      (routerUnpaid && typeof remote === "object" && (remote.state === "accepted" || remote.state === "settled")) ||
      (intent !== undefined && !intent.released && typeof remote === "object" && remote.release.state === "authorized") ||
      lookupHit;
    if (mismatch) mismatches += 1;
    lines.push({
      kind: "attempt",
      attemptId: attempt.attemptId,
      requesterDigest: attempt.requesterDigest,
      ...(orderId === undefined ? {} : { orderId }),
      routeId: attempt.routeId,
      ...(intent === undefined ? {} : { paymentId: intent.paymentId }),
      quotedAt: new Date(attempt.atMs).toISOString(),
      ...(attempt.created === undefined ? {} : { existing: attempt.created.existing, ...(attempt.created.elapsedMs === undefined ? {} : { createMs: attempt.created.elapsedMs }) }),
      ...(attempt.createFailed === undefined ? {} : { createFailed: attempt.createFailed.detail }),
      ...(attempt.refused === undefined ? {} : { refused: attempt.refused.detail }),
      ...(attempt.settle === undefined ? {} : { settle: attempt.settle.outcome, ...(attempt.settle.elapsedMs === undefined ? {} : { settleMs: attempt.settle.elapsedMs }) }),
      ...(attempt.settle?.txRef === undefined ? {} : { sourceTxRef: attempt.settle.txRef }),
      ...(attempt.release === undefined ? {} : { release: attempt.release.outcome, ...(attempt.release.reconstructed === true ? { reconstructed: true } : {}), ...(attempt.release.elapsedMs === undefined ? {} : { releaseMs: attempt.release.elapsedMs }) }),
      ...(attempt.complete === undefined ? {} : { complete: attempt.complete.outcome, ...(attempt.complete.reason === undefined ? {} : { completeReason: attempt.complete.reason }), ...(attempt.complete.elapsedMs === undefined ? {} : { completeMs: attempt.complete.elapsedMs }) }),
      ...(attempt.abandoned === undefined ? {} : { abandoned: attempt.abandoned.reason }),
      ...(intent === undefined ? {} : { terminal: intent.terminal, ...(intent.mayStillSettleUntil === undefined ? {} : { mayStillSettleUntil: intent.mayStillSettleUntil }) }),
      unresolved: ledger.unresolvedAttempts(nowSec).some((a) => a.attemptId === attempt.attemptId),
      ...(remote === undefined ? {} : { remote }),
      ...(lookupHit ? { foundByLookup: true } : {}),
      mismatch,
    });
  }
  const shown = new Set<string>();
  for (const list of ledger.discoveredByPair.values()) {
    for (const order of list) {
      shown.add(order.orderId);
      const remote = remoteOrders.get(order.orderId);
      lines.push({ kind: "discovered", orderId: order.orderId, requesterDigest: order.requesterDigest, expiresAt: order.expiresAt, unresolved: ledger.unresolvedDiscovered(nowSec).some((d) => d.orderId === order.orderId), ...(remote === undefined ? {} : { remote }) });
    }
  }
  // この実行の照会で見つかった注文（ledger に無いもの）も同じ形で出す（attempt には結び付けない。FR-11）。
  let foundNow = 0;
  for (const list of foundByLookup.values()) {
    for (const order of list) {
      if (shown.has(order.orderId) || ledger.byOrderId.has(order.orderId)) continue;
      shown.add(order.orderId);
      foundNow += 1;
      const remote = remoteOrders.get(order.orderId);
      lines.push({ kind: "discovered", orderId: order.orderId, requesterDigest: order.requesterDigest, expiresAt: order.expiresAt, unresolved: nowSec <= order.expiresAt + 60, foundByLookup: true, ...(remote === undefined ? {} : { remote }) });
    }
  }
  lines.push({ kind: "summary", attempts: attempts.length, unresolved: ledger.unresolvedAttempts(nowSec).length + ledger.unresolvedDiscovered(nowSec).length, discovered: [...ledger.knownDiscovered].length, ...(options.remote === undefined ? {} : { foundByLookup: foundNow }), mismatches, remote: options.remote !== undefined });
  return lines;
}

/** `--abandon`: ledger（lock を取る）に `abandoned` の 1 行。Router が動いていれば `locked`。attempt が無ければ `unknown_attempt`。 */
export async function abandon(journalPath: string, attemptId: string, reason: string): Promise<"ok" | "locked" | "unknown_attempt" | "bad_reason" | "already"> {
  if (!ABANDON_REASONS.has(reason)) return "bad_reason";
  const ledgerDir = path.join(path.dirname(path.resolve(journalPath)), "subetha-exact");
  let ledger;
  try {
    ledger = await openSubethaExactLedger({ dir: ledgerDir });
  } catch (error) {
    if (error instanceof JournalLockedError) return "locked";
    throw error;
  }
  try {
    const attempt: AttemptView | undefined = ledger.attempt(attemptId);
    if (attempt === undefined) return "unknown_attempt";
    if (attempt.abandoned !== undefined) return "already";
    await ledger.append(attemptId, "abandoned", { by: "operator", reason });
    return "ok";
  } finally {
    await ledger.close();
  }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const journalPath = arg("journal") ?? process.env["ROUTER_JOURNAL_PATH"] ?? "runtime/journal.ndjson";
  const abandonId = arg("abandon");
  if (abandonId !== undefined) {
    const reason = arg("reason") ?? "";
    if (!ABANDON_REASONS.has(reason)) {
      process.stderr.write("--reason must be one of operator_timeout, operator_facilitator_reset, operator_other\n");
      process.exit(2);
    }
    let confirmed = arg("confirm") === abandonId;
    if (!confirmed && process.stdin.isTTY === true) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const typed = await new Promise<string>((resolve) => rl.question(`Abandon attempt ${abandonId} (reason ${reason})? Type the attemptId to confirm: `, resolve));
      rl.close();
      confirmed = typed.trim() === abandonId;
    }
    if (!confirmed) {
      process.stderr.write("not confirmed (type the attemptId at the prompt, or pass --confirm <attemptId> when there is no TTY)\n");
      process.exit(2);
    }
    const result = await abandon(journalPath, abandonId, reason);
    process.stdout.write(`${JSON.stringify({ kind: "abandon", attemptId: abandonId, reason, result })}\n`);
    process.exit(result === "ok" ? 0 : 2);
  }
  let remote: InspectOptions["remote"];
  if (process.argv.includes("--remote")) {
    const url = parseSubethaExactFacilitatorUrl(process.env[SUBETHA_EXACT_FACILITATOR_URL_ENV] ?? "");
    const tokenFile = process.env[SUBETHA_EXACT_TOKEN_FILE_ENV];
    if (url === undefined || tokenFile === undefined || tokenFile === "") {
      process.stderr.write(`--remote needs ${SUBETHA_EXACT_FACILITATOR_URL_ENV} and ${SUBETHA_EXACT_TOKEN_FILE_ENV}\n`);
      process.exit(2);
    }
    const token = readSecretFile(tokenFile, SUBETHA_EXACT_TOKEN_FILE_ENV);
    remote = { facilitatorUrl: url.url, token: () => token, allowLoopback: process.env["SUBETHA_EXACT_INSPECT_ALLOW_LOOPBACK"] === "1" };
  }
  const lines = await inspect({ journalPath, ...(remote === undefined ? {} : { remote }) });
  for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`);
}

if (process.argv[1] !== undefined && /subetha-exact-inspect\.ts$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    // 固定文だけ（例外の文章に URL・token が混ざり得る）。
    process.stderr.write(`subetha-exact inspect failed: ${error instanceof JournalLockedError ? "ledger is locked (stop the Router first)" : "error"}\n`);
    process.exit(1);
  });
}
