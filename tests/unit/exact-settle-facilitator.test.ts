/**
 * SubEtha 自前の settle facilitator に向ける準備（`docs/exact-settle-facilitator-{requirements,design}.md`）の unit。
 * 分類（AC-2〜AC-6・AC-13）と、adapter + fixture（AC-1〜AC-7・AC-9・AC-12・AC-13・AC-14）。設定は `subetha-exact-table.test.ts`、hosted は `hosted-exact-config.test.ts`。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { createSubethaExactInbound, SUBETHA_EXACT_DEFAULT_TIMEOUTS, type SubethaExactInbound } from "../../src/adapters/inbound/subetha-exact.js";
import { classifySubethaSettle, classifySubmit, type CallOutcome } from "../../src/adapters/inbound/subetha-exact-classify.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import { classifySettleReason, SETTLE_FAILED_REASONS, SETTLE_NOT_ACCEPTED_REASONS, SETTLE_PENDING_REASON, settleReasonWaits } from "../../src/shared/settle-reasons.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { createSubethaExactFacilitator, type FacilitatorFixture } from "../fixtures/subetha-exact-facilitator.js";

const PROVIDER = "router-test";
const TOKEN = "fixture-provider-token-0123";
const SETTLE_TOKEN = "5e".repeat(32);
const CHAIN_ID = 84532;
const NETWORK = `eip155:${CHAIN_ID}`;
const ASSET = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const DOMAIN = { name: "zERC20 USD Coin", version: "1" };
const ROUTE_ID = "md-zusdc-exact";
const BINDING = `${ROUTE_ID}|GET|%2Fv1%2Froutes%2F${ROUTE_ID}%2Fresource`;
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const TX = `0x${"c3".repeat(32)}`;

/** 要件 R8 の一覧（実装の配列とは別に書き下す）。 */
const PENDING = ["settle_pending"];
const NOT_ACCEPTED = ["out_of_scope", "stopping", "conflict", "verify_unavailable", "invalid_payment", "bound_unreachable", "not_bound", "blocked", "unavailable"].map((r) => `settle_not_accepted:${r}`);
const FAILED = ["already-used", "simulation-failed", "no-transfer-in-settlement-transaction", "transaction-failed-twice", "cancelled", "expired-in-queue", "order-expired-in-queue", "not-bound", "oversized", "cancelled-by-operator"].map((r) => `settle_failed:${r}`);
const NEAR_MISSES = ["settle_pending ", " settle_pending", "SETTLE_PENDING", "settle_pending:x", "settle_failed", "settle_failed:", "settle_failed:already-used:x", "settle_failed:already_used", "settle_not_accepted", "settle_not_accepted:secret-text"];

describe("理由の一覧と分類", () => {
  const response = (status: number, json: unknown, unreadable = false): CallOutcome => ({ kind: "response", status, json, retryAfter: null, unreadable });

  test("一覧は要件 R8 の 20 個。完全一致だけ。待つのは settle_pending と settle_failed の 10 個", () => {
    expect([SETTLE_PENDING_REASON, ...SETTLE_NOT_ACCEPTED_REASONS, ...SETTLE_FAILED_REASONS].sort()).toEqual([...PENDING, ...NOT_ACCEPTED, ...FAILED].sort());
    for (const reason of [...PENDING, ...FAILED]) expect([classifySettleReason(reason), settleReasonWaits(classifySettleReason(reason))], reason).toEqual([reason, true]);
    for (const reason of NOT_ACCEPTED) expect([classifySettleReason(reason), settleReasonWaits(classifySettleReason(reason))], reason).toEqual([reason, false]);
    for (const reason of NEAR_MISSES) expect([classifySettleReason(reason), settleReasonWaits(classifySettleReason(reason))], reason).toEqual(["unrecognized", false]);
    for (const raw of [undefined, null]) expect(classifySettleReason(raw)).toBe("absent");
    for (const raw of ["", 7, true, [], {}, ["settle_pending"]]) expect(classifySettleReason(raw)).toBe("malformed");
    for (const other of ["absent", "malformed", "unrecognized"] as const) expect(settleReasonWaits(other)).toBe(false);
  });

  test("答えの読み方: 4xx は待たず理由なし、読めない・5xx・例外は待つ、success は待つ、断りは理由で決まる", () => {
    expect(classifySubethaSettle({ kind: "threw" })).toEqual({ wait: true });
    for (const status of [400, 401, 404, 413, 418, 429]) for (const json of [undefined, { error: "unauthorized" }, { success: false, errorReason: "settle_pending" }, { success: true, transaction: TX }]) expect(classifySubethaSettle(response(status, json)), String(status)).toEqual({ wait: false });
    for (const call of [response(500, {}), response(503, { success: false, errorReason: "settle_not_accepted:blocked" }), response(200, undefined, true), response(200, {}), response(200, { success: "false" }), response(204, undefined), response(302, undefined)]) expect(classifySubethaSettle(call)).toEqual({ wait: true });
    expect(classifySubethaSettle(response(200, { success: true, transaction: TX.toUpperCase().replace("0X", "0x"), errorReason: "settle_not_accepted:blocked" }))).toEqual({ wait: true, success: true, transaction: TX });
    expect(classifySubethaSettle(response(200, { success: true, transaction: "Bearer x" }))).toEqual({ wait: true, success: true });
    expect(classifySubethaSettle(response(200, { success: false, transaction: TX, errorReason: "settle_pending" }))).toEqual({ wait: true, success: false, transaction: TX, reason: "settle_pending" });
    expect(classifySubethaSettle(response(200, { success: false, transaction: "", errorReason: "settle_pending" }))).toEqual({ wait: true, success: false, reason: "settle_pending" });
    expect(classifySubethaSettle(response(200, { success: false }))).toEqual({ wait: false, success: false, reason: "absent" });
    expect(classifySubethaSettle(response(200, JSON.parse('{"success":false,"__proto__":{"errorReason":"settle_pending"}}')))).toEqual({ wait: false, success: false, reason: "absent" });
  });

  test("AC-7: token の無い構成の分類は、settle_* の語を知らない（待たない・unrecognized）", () => {
    for (const reason of [...PENDING, ...NOT_ACCEPTED, ...FAILED]) expect(classifySubmit(response(200, { success: false, errorReason: reason })), reason).toEqual({ wait: false, success: false, reason: "unrecognized" });
  });
});

describe("adapter + settle facilitator の模型", () => {
  const FAST = { settleMs: 1_500, bindMs: 300, submitMs: 300, reconcileMs: 300, reconcileRetryWaitMs: 20 };
  const payer = createX402Payer(generatePrivateKey());
  let fixture: FacilitatorFixture;
  let workDir: string;
  let notes: string[];
  let reports: unknown[];
  let adapter: SubethaExactInbound | undefined;
  const clockMs = 1_800_000_000_000;

  async function startFixture(settleBearer: string | undefined): Promise<void> {
    fixture = createSubethaExactFacilitator({ providerId: PROVIDER, bearer: TOKEN, ...(settleBearer === undefined ? {} : { settleBearer }), chainId: CHAIN_ID, asset: ASSET, domainName: DOMAIN.name, domainVersion: DOMAIN.version, ttlSeconds: 300, now: () => Math.floor(clockMs / 1000) });
    await fixture.listen();
  }
  async function makeAdapter(overrides: Partial<Parameters<typeof createSubethaExactInbound>[0]> = {}): Promise<SubethaExactInbound> {
    const created = createSubethaExactInbound({
      facilitatorUrl: `${fixture.baseUrl}/p/${PROVIDER}`,
      settleFacilitatorUrl: `${fixture.baseUrl}/xfac`,
      token: () => TOKEN,
      settleToken: () => SETTLE_TOKEN,
      transport: createGuardedTransport({ allowLoopback: true, report: (event) => reports.push(event) }),
      asset: { network: NETWORK, id: ASSET, decimals: 6, domain: DOMAIN },
      ledgerDir: path.join(workDir, "subetha-exact"),
      limits: { maxRequestsTotal: 200, maxUnresolved: 100, requestsPerMinute: 200 },
      now: () => clockMs,
      note: (m) => notes.push(m),
      timeouts: { createMs: 2_000, ...FAST },
      ...overrides,
    });
    await created.startup();
    adapter = created;
    return created;
  }
  async function fresh(requestId: string): Promise<{ offer: InboundOffer; credential: PaymentCredential }> {
    const offer = await adapter!.createOffer({ routeId: ROUTE_ID, amount: "2000", asset: ASSET, network: NETWORK, routeBinding: BINDING, nowMs: clockMs, requester: { principalId: "alice", requestId } });
    return { offer, credential: JSON.parse(Buffer.from(await payer.credentialFor(offer, CHAIN_ID), "base64").toString("utf8")) as PaymentCredential };
  }
  const settle = (p: { offer: InboundOffer; credential: PaymentCredential }) => adapter!.settle(p.offer, p.credential, { routeId: ROUTE_ID });
  const callsOf = (offer: InboundOffer): Record<string, number> => fixture.calls.byOrder[offer.extra.challengeNonce] ?? {};
  const unknownOf = (offer: InboundOffer) => ({ outcome: "unknown", reason: "source_settle_unknown", mayStillSettleUntil: offer.extra.expiresAt });
  const ledgerText = () => readFile(path.join(workDir, "subetha-exact", "orders.ndjson"), "utf8");
  const answered = async (orderId: string): Promise<Record<string, unknown>> =>
    (await ledgerText()).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { event: string; patch: Record<string, unknown> }).filter((r) => r.event === "submit" && r.patch["phase"] === "answered" && r.patch["orderId"] === orderId).at(-1)!.patch;

  beforeEach(async () => {
    notes = [];
    reports = [];
    workDir = await mkdtemp(path.join(runtimeRoot, "sf-adapter-"));
    await startFixture(SETTLE_TOKEN);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await adapter?.close().catch(() => undefined);
    adapter = undefined;
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  });

  test("AC-1・AC-9: 正しい購入は bind 1・送信 1（settle 先の token 付き）・reconcile 1 で settled。token は混ざらず、ledger・note・transport の記録に出ない", async () => {
    await makeAdapter();
    const p = await fresh("ok");
    expect(await settle(p)).toEqual({ outcome: "settled", txRef: fixture.orders.get(p.offer.extra.challengeNonce)!.exact!.txHash, eventId: p.offer.extra.challengeNonce });
    expect(callsOf(p.offer)).toMatchObject({ bind: 1, submit: 1, reconcile: 1 });
    expect([fixture.calls.submitWithAuthorization, fixture.calls.submitWithProviderToken, fixture.calls.tenantWithSettleToken]).toEqual([1, 0, 0]);
    const text = `${await ledgerText()}${JSON.stringify(notes)}${JSON.stringify(reports)}`;
    const signature = (p.credential.payload as unknown as { signature: string }).signature;
    for (const secret of [TOKEN, SETTLE_TOKEN, signature.slice(2), "/xfac"]) expect(text).not.toContain(secret);
  });

  test("AC-2・AC-3・AC-13: settle_pending と settle_failed 10 個のあと、reconcile が pending → accepted なら settled（送信 1）。理由が ledger に残る", async () => {
    await makeAdapter();
    fixture.setMode("reconcile", "pending-first:2");
    for (const reason of [...PENDING, ...FAILED]) {
      const p = await fresh(`paid ${reason}`);
      fixture.setMode("submit", `own-paid:${reason}`);
      expect((await settle(p)).outcome, reason).toBe("settled");
      expect([callsOf(p.offer)["submit"], callsOf(p.offer)["reconcile"]], reason).toEqual([1, 3]);
      const row = await answered(p.offer.extra.challengeNonce);
      expect(row, reason).toMatchObject({ httpStatus: 200, success: false, reason });
      // AC-6 の一部: 相手の hash ではなく chain の hash を使う。
      expect(row["transaction"]).not.toBe(fixture.orders.get(p.offer.extra.challengeNonce)!.exact!.txHash);
    }
  });

  test("AC-2・AC-3・AC-6: 成立しなければ、予算まで待って unknown（送信 1。tx hash が付いていても settled にしない）", async () => {
    await makeAdapter({ timeouts: { createMs: 2_000, ...FAST, settleMs: 250 } });
    for (const reason of [...PENDING, ...FAILED]) {
      const p = await fresh(`unpaid ${reason}`);
      fixture.setMode("submit", `own:${reason}`);
      expect(await settle(p), reason).toEqual(unknownOf(p.offer));
      expect(callsOf(p.offer)["submit"], reason).toBe(1);
      expect(callsOf(p.offer)["reconcile"], reason).toBeGreaterThan(1);
      expect((await answered(p.offer.extra.challengeNonce))["transaction"], reason).toMatch(/^0x[0-9a-f]{64}$/);
    }
    const claimed = await fresh("claims");
    fixture.setMode("submit", "claims-success");
    expect(await settle(claimed)).toEqual(unknownOf(claimed.offer));
  });

  test("AC-4・AC-5・AC-13: settle_not_accepted・似た値・欄の異常は reconcile 1 回で unknown。記録は一覧の値か固定の語で、生の文字列は残らない", async () => {
    await makeAdapter();
    const cases: [string, unknown, string][] = [...NOT_ACCEPTED.map((r): [string, unknown, string] => [r, r, r]), ...NEAR_MISSES.map((r): [string, unknown, string] => [`near ${JSON.stringify(r)}`, r, "unrecognized"]), ["absent", undefined, "absent"], ["null", null, "absent"], ["number", 7, "malformed"], ["object", { leak: "raw-leak-me" }, "malformed"], ["empty", "", "malformed"], ["text", "raw-leak-me Bearer", "unrecognized"]];
    for (const [name, raw, reason] of cases) {
      const p = await fresh(name);
      fixture.setMode("submit", "raw", { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: false, transaction: "", ...(raw === undefined ? {} : { errorReason: raw }) }) });
      expect(await settle(p), name).toEqual(unknownOf(p.offer));
      expect([callsOf(p.offer)["submit"], callsOf(p.offer)["reconcile"]], name).toEqual([1, 1]);
      expect((await answered(p.offer.extra.challengeNonce))["reason"], name).toBe(reason);
    }
    const text = await ledgerText();
    for (const raw of ["raw-leak-me", "secret-text", "SETTLE_PENDING", "settle_failed:already_used"]) expect(text).not.toContain(raw);
  });

  test("AC-4: 401・429（JSON と JSON でないもの）・400・413・418 は reconcile 1 回、理由なし。2 回目の settle も送らない", async () => {
    await makeAdapter();
    const json = { "content-type": "application/json" };
    const cases: [number, Record<string, string>, string][] = [[401, json, '{"error":"unauthorized"}'], [429, { ...json, "retry-after": "10" }, '{"error":"rate-limited"}'], [429, { "content-type": "text/html" }, "<html>error code: 1015</html>"], [400, json, '{"error":"invalid_json"}'], [413, json, '{"error":"too_large"}'], [418, {}, ""], [429, json, '{"success":false,"errorReason":"settle_pending"}']];
    for (const [i, [status, headers, body]] of cases.entries()) {
      const p = await fresh(`4xx ${String(i)}`);
      fixture.setMode("submit", "raw", { status, headers, body });
      expect(await settle(p), String(i)).toEqual(unknownOf(p.offer));
      expect([callsOf(p.offer)["submit"], callsOf(p.offer)["reconcile"]], String(i)).toEqual([1, 1]);
      const row = await answered(p.offer.extra.challengeNonce);
      expect([row["httpStatus"], "reason" in row, "success" in row], String(i)).toEqual([status, false, false]);
      fixture.setMode("submit", "accepted");
      expect(await settle(p), String(i)).toEqual(unknownOf(p.offer));
      expect(callsOf(p.offer)["submit"], String(i)).toBe(1);
    }
  });

  test("AC-4: token が違えば本当に 401（模型の認証の段）で unknown、送信の印が残り、送り直さない", async () => {
    await makeAdapter({ settleToken: () => "ab".repeat(32) });
    const p = await fresh("wrong-token");
    expect(await settle(p)).toEqual(unknownOf(p.offer));
    expect((await answered(p.offer.extra.challengeNonce))["httpStatus"]).toBe(401);
    expect(adapter!.ledger!.submitStarted(p.offer.extra.challengeNonce)).toBe(true);
    expect(await settle(p)).toEqual(unknownOf(p.offer));
    expect(callsOf(p.offer)["submit"]).toBe(1);
  });

  test("AC-7: token の無い構成は Authorization を付けず、settle_pending でも待たない", async () => {
    await fixture.close();
    await startFixture(undefined);
    await makeAdapter({ settleToken: undefined } as never);
    const paid = await fresh("x402");
    expect((await settle(paid)).outcome).toBe("settled");
    const p = await fresh("x402-pending");
    fixture.setMode("submit", "own:settle_pending");
    expect(await settle(p)).toEqual(unknownOf(p.offer));
    expect([callsOf(p.offer)["submit"], callsOf(p.offer)["reconcile"], fixture.calls.submitWithAuthorization]).toEqual([1, 1, 0]);
    expect((await answered(p.offer.extra.challengeNonce))["reason"]).toBe("unrecognized");
  });

  test("AC-12: 遅い settle_pending（予算の大半を使う）を含めて、settle 全体は予算を越えない。本番の期限でも 25 秒の答えのあとに照合の時間が残る", async () => {
    // 60 : 30 : 25 の比の 1/20（予算 3 s・送信 1.5 s・答え 1.25 s）。送信のあとで予算を数え直すと 4 s を越える。
    await makeAdapter({ timeouts: { createMs: 2_000, settleMs: 3_000, bindMs: 500, submitMs: 1_500, reconcileMs: 500, reconcileRetryWaitMs: 100 } });
    const p = await fresh("slow");
    fixture.setMode("submit", "own-slow:1250:settle_pending");
    const startedAt = performance.now();
    expect(await settle(p)).toEqual(unknownOf(p.offer));
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThan(2_500);
    expect(elapsed).toBeLessThan(3_600);
    expect(callsOf(p.offer)["reconcile"]).toBeGreaterThan(5);
    const { bindMs, submitMs, settleMs } = SUBETHA_EXACT_DEFAULT_TIMEOUTS;
    expect(submitMs).toBeGreaterThan(25_000);
    expect(settleMs - bindMs - 25_000).toBeGreaterThanOrEqual(25_000);
  });

  test("AC-14: 自前の host で送った注文は、送り先を別の（認証なしの）facilitator に変えて開き直しても送らない（索引は ledger から戻る）", async () => {
    const hits: string[] = [];
    const other = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true, transaction: TX, network: NETWORK }));
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", () => resolve()));
    const otherUrl = `http://127.0.0.1:${String((other.address() as AddressInfo).port)}/facilitator`;
    try {
    await makeAdapter({ timeouts: { createMs: 2_000, ...FAST, settleMs: 250 } });
    const p = await fresh("switch-back");
    fixture.setMode("submit", "own:settle_pending");
    expect(await settle(p)).toEqual(unknownOf(p.offer));
    await adapter!.close();
    fixture.setMode("submit", "accepted");
    await makeAdapter({ settleToken: undefined, settleFacilitatorUrl: otherUrl } as never);
    expect(adapter!.ledger!.submitStarted(p.offer.extra.challengeNonce)).toBe(true);
    expect(await settle(p)).toEqual(unknownOf(p.offer));
    expect([callsOf(p.offer)["bind"], callsOf(p.offer)["submit"], hits]).toEqual([2, 1, []]);
    // 陽性対照: 新しい注文は、新しい送り先に 1 回送る。
    const next = await fresh("after-switch");
    await settle(next);
    expect([callsOf(next.offer)["submit"] ?? 0, hits]).toEqual([0, ["/facilitator/settle"]]);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});
