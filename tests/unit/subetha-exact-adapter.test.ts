/**
 * adapter `subetha-exact` の単体試験（fixture 相手。`docs/subetha-exact-inbound-design.md` §3・§10、タスク T-4）。
 * 作成・上限と照会・preflight・verify・settle・release（D／D′）・complete・ledger の失敗・salt・transport の境界・秘密の不在。鍵は使い捨て（資金は無い）。
 */
import { mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { createSubethaExactInbound, type SubethaExactInbound } from "../../src/adapters/inbound/subetha-exact.js";
import { ConfigError } from "../../src/config.js";
import { createGuardedTransport, type TransportEvent } from "../../src/net/guarded-fetch.js";
import { InboundOfferError, type InboundOffer, type PaymentCredential } from "../../src/ports/inbound.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { createSubethaExactFacilitator, type FacilitatorFixture } from "../fixtures/subetha-exact-facilitator.js";

const PROVIDER = "router-test";
const TOKEN = "canary-provider-token-7f3c";
const CHAIN_ID = 84532;
const NETWORK = `eip155:${CHAIN_ID}`;
const ASSET = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const DOMAIN = { name: "zERC20 USD Coin", version: "1" };
const ROUTE_ID = "md-zusdc-exact";
const BINDING = `${ROUTE_ID}|GET|%2Fv1%2Froutes%2F${ROUTE_ID}%2Fresource`;
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const payer = createX402Payer(generatePrivateKey());

let fixture: FacilitatorFixture;
let workDir: string;
let clockMs = 1_800_000_000_000;
let notes: string[];
let events: TransportEvent[];
let adapter: SubethaExactInbound | undefined;

async function makeAdapter(overrides: Partial<Parameters<typeof createSubethaExactInbound>[0]> = {}): Promise<SubethaExactInbound> {
  const transport = createGuardedTransport({ allowLoopback: true, report: (event) => events.push(event) });
  const created = createSubethaExactInbound({
    facilitatorUrl: `${fixture.baseUrl}/p/${PROVIDER}`,
    token: () => TOKEN,
    transport,
    asset: { network: NETWORK, id: ASSET, decimals: 6, domain: DOMAIN },
    ledgerDir: path.join(workDir, "subetha-exact"),
    limits: { maxRequestsTotal: 100, maxUnresolved: 3, requestsPerMinute: 60 },
    now: () => clockMs,
    note: (m) => notes.push(m),
    timeouts: { createMs: 2_000, verifyMs: 2_000, settleMs: 2_000, statusMs: 2_000, releaseMs: 2_000, completeMs: 2_000, releaseRetryWaitMs: 30, completeRetryWaitMs: 30, releaseBudgetMs: 5_000, completeBudgetMs: 5_000, lookupBudgetMs: 5_000 },
    ...overrides,
  });
  await created.startup();
  adapter = created;
  return created;
}
const request = (requestId = "req-1", principalId = "alice", amount = "2000") => ({ routeId: ROUTE_ID, amount, asset: ASSET, network: NETWORK, routeBinding: BINDING, nowMs: clockMs, requester: { principalId, requestId } });
async function credentialFor(offer: InboundOffer, patch: (offer: InboundOffer) => InboundOffer = (o) => o): Promise<PaymentCredential> {
  return JSON.parse(Buffer.from(await payer.credentialFor(patch(offer), CHAIN_ID), "base64").toString("utf8")) as PaymentCredential;
}
async function ledgerRows(): Promise<{ paymentId: string; event: string; patch: Record<string, unknown> }[]> {
  const text = await readFile(path.join(workDir, "subetha-exact", "orders.ndjson"), "utf8").catch(() => "");
  return text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { paymentId: string; event: string; patch: Record<string, unknown> });
}
async function failQuote(fn: () => Promise<unknown>): Promise<InboundOfferError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof InboundOfferError) return error;
    throw error;
  }
  throw new Error("expected InboundOfferError");
}
/** 注文を払って release の手前まで進める。 */
async function settledOffer(requestId = "req-1"): Promise<{ offer: InboundOffer; credential: PaymentCredential; txRef: string }> {
  const offer = await adapter!.createOffer(request(requestId));
  const credential = await credentialFor(offer);
  const settled = await adapter!.settle(offer, credential, { routeId: ROUTE_ID });
  if (settled.outcome !== "settled") throw new Error(`settle: ${settled.outcome}`);
  return { offer, credential, txRef: settled.txRef };
}

beforeEach(async () => {
  clockMs = 1_800_000_000_000;
  notes = [];
  events = [];
  workDir = await mkdtemp(path.join(runtimeRoot, "t4-adapter-"));
  fixture = createSubethaExactFacilitator({ providerId: PROVIDER, bearer: TOKEN, chainId: CHAIN_ID, asset: ASSET, domainName: DOMAIN.name, domainVersion: DOMAIN.version, ttlSeconds: 300, now: () => Math.floor(clockMs / 1000) });
  await fixture.listen();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await adapter?.close().catch(() => undefined);
  adapter = undefined;
  await fixture.close();
  await rm(workDir, { recursive: true, force: true });
});

describe("createOffer（§3.4、表 A）", () => {
  test("201: offer の形（scheme exact、payTo は注文の burn address、extra は 6 つの鍵、expiresAt = min(注文, now + 120)）、ledger に requested → created（tenant 付き）", async () => {
    await makeAdapter();
    const offer = await adapter!.createOffer(request());
    expect(offer).toMatchObject({ scheme: "exact", network: NETWORK, asset: ASSET, amount: "2000", maxTimeoutSeconds: 150 });
    expect(Object.keys(offer.extra).sort()).toEqual(["challengeNonce", "expiresAt", "fundsMoveOnCredential", "name", "routeBinding", "version"]);
    expect(offer.extra).toMatchObject({ name: DOMAIN.name, version: DOMAIN.version, routeBinding: BINDING, fundsMoveOnCredential: false, expiresAt: 1_800_000_120 });
    expect(offer.extra.challengeNonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(fixture.orders.get(offer.extra.challengeNonce)?.saleId).toBe(offer.payTo);
    const rows = await ledgerRows();
    expect(rows.map((r) => r.event)).toEqual(["requested", "created"]);
    expect(rows[0]!.patch).toMatchObject({ routeId: ROUTE_ID, amount: "2000", atMs: clockMs });
    expect(rows[0]!.patch).not.toHaveProperty("principalId");
    expect(rows[1]!.patch).toMatchObject({ orderId: offer.extra.challengeNonce, payTo: offer.payTo, existing: false, tenant: `/p/${PROVIDER}`, httpStatus: 201, binding: { requesterDigest: rows[0]!.patch["requesterDigest"] } });
    expect(adapter!.settleWindowOf!(offer)).toBe(offer.extra.expiresAt);
    expect(adapter!.ownsOffer!(offer)).toBe(true);
    expect(adapter!.ownsOffer!({ ...offer, network: "eip155:1" })).toBe(false);
  });
  test("同じ (principal, requestId) は existing（同じ注文、別の attempt）。別の requestId は別の注文。requester 無しは refused requester_missing（POST 0）", async () => {
    await makeAdapter();
    const first = await adapter!.createOffer(request());
    const again = await adapter!.createOffer(request());
    expect(again.extra.challengeNonce).toBe(first.extra.challengeNonce);
    const other = await adapter!.createOffer(request("req-2"));
    expect(other.extra.challengeNonce).not.toBe(first.extra.challengeNonce);
    expect((await ledgerRows()).filter((r) => r.event === "created").map((r) => r.patch["existing"])).toEqual([false, true, false]);
    expect(adapter!.ledger!.attemptsForOrder(first.extra.challengeNonce)).toHaveLength(2);
    const { requester: _dropped, ...withoutRequester } = request();
    const missing = await failQuote(() => adapter!.createOffer(withoutRequester));
    expect(missing).toMatchObject({ code: "source_offer_refused", detail: "requester_missing" });
    expect(fixture.calls.byRoute["create"]).toBe(3);
  });
  test("existing の照合: 別の id → order_reused_other_id、期限切れ → order_reused_expired、額違い → order_reused_mismatch（refused の行）", async () => {
    await makeAdapter();
    await adapter!.createOffer(request());
    for (const [mode, detail] of [["existing-mismatch:id", "order_reused_other_id"], ["existing-mismatch:expired", "order_reused_expired"], ["existing-mismatch:amount", "order_reused_mismatch"]] as const) {
      fixture.setMode("create", mode);
      expect(await failQuote(() => adapter!.createOffer(request())), mode).toMatchObject({ code: "source_offer_refused", detail });
    }
    expect((await ledgerRows()).filter((r) => r.event === "refused").map((r) => r.patch["detail"])).toEqual(["order_reused_other_id", "order_reused_expired", "order_reused_mismatch"]);
  });
  test.each<[string, string, string, number | undefined, string]>([
    ["busy", "source_offer_unavailable", "facilitator_busy", 30_000, "create_failed"],
    ["rate-limited", "source_offer_unavailable", "rate_limited", 2_000, "create_failed"],
    ["unreadable", "source_offer_unavailable", "response_unreadable", undefined, "create_failed"],
    ["lose-response", "source_offer_unavailable", "response_unreadable", undefined, "create_failed"],
    ["huge-body", "source_offer_unavailable", "response_unreadable", undefined, "create_failed"],
    ["redirect", "source_offer_unavailable", "response_unreadable", undefined, "create_failed"],
    ["stall-body", "source_offer_unavailable", "response_unreadable", undefined, "create_failed"],
  ])("%s → %s %s（行 %s）", async (mode, code, detail, retryAfterMs, row) => {
    await makeAdapter({ timeouts: { createMs: 300 } });
    fixture.setMode("create", mode);
    const error = await failQuote(() => adapter!.createOffer(request()));
    expect(error).toMatchObject({ code, detail });
    expect(error.retryAfterMs).toBe(retryAfterMs);
    expect((await ledgerRows()).at(-1)).toMatchObject({ event: row, patch: { detail } });
    expect(error.message).not.toContain(TOKEN);
  });
  test("401 → unauthorized（note）、tenant 無し 404 → unknown_tenant、403 → amount_refused、400 → requirements_mismatch（refused の行、未解決から外れる）", async () => {
    await makeAdapter();
    fixture.setMode("create", "raw", { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "unauthorized" }) });
    expect(await failQuote(() => adapter!.createOffer(request("a")))).toMatchObject({ code: "source_offer_refused", detail: "unauthorized" });
    expect(notes.some((n) => n.includes("401"))).toBe(true);
    fixture.setMode("create", "raw", { status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "unknown" }) });
    expect(await failQuote(() => adapter!.createOffer(request("b")))).toMatchObject({ detail: "unknown_tenant" });
    expect(await failQuote(() => adapter!.createOffer(request("c", "alice", "1000001")))).toMatchObject({ detail: "amount_refused" });
    fixture.setMode("create", "raw", { status: 400, headers: {}, body: "" });
    expect(await failQuote(() => adapter!.createOffer(request("d")))).toMatchObject({ detail: "requirements_mismatch" });
    expect(adapter!.ledger!.unresolvedCount(Math.floor(clockMs / 1000))).toBe(0);
  });
  test("同時の 2 つ目は limit_concurrency（POST は 1 回）", async () => {
    await makeAdapter();
    fixture.setMode("create", "slow:200");
    const first = adapter!.createOffer(request("a"));
    const second = await failQuote(() => adapter!.createOffer(request("b")));
    expect(second).toMatchObject({ detail: "limit_concurrency" });
    await first;
    expect(fixture.calls.byRoute["create"]).toBe(1);
  });
});

describe("上限と照会（§3.6）", () => {
  test("累積の上限と 1 分の上限は POST を出さない。再起動で累積は戻らない", async () => {
    await makeAdapter({ limits: { maxRequestsTotal: 2, maxUnresolved: 10, requestsPerMinute: 1 } });
    await adapter!.createOffer(request("a"));
    expect(await failQuote(() => adapter!.createOffer(request("b")))).toMatchObject({ detail: "limit_rate", retryAfterMs: 60_000 });
    clockMs += 61_000;
    await adapter!.createOffer(request("b"));
    clockMs += 61_000;
    expect(await failQuote(() => adapter!.createOffer(request("c")))).toMatchObject({ detail: "limit_total" });
    await adapter!.close();
    await makeAdapter({ limits: { maxRequestsTotal: 2, maxUnresolved: 10, requestsPerMinute: 1 } });
    expect(await failQuote(() => adapter!.createOffer(request("c")))).toMatchObject({ detail: "limit_total" });
    expect(fixture.calls.byRoute["create"]).toBe(2);
  });
  test("未解決の集計: 応答を失った attempt は時間でも照会でも外れず、discovered は注文の期限 + 60 s で外れ、abandoned は attempt ごと（3 → 2 → 1）。上限で照会が走り POST は出ない", async () => {
    await makeAdapter({ limits: { maxRequestsTotal: 100, maxUnresolved: 3, requestsPerMinute: 60 } });
    fixture.setMode("create", "busy-then-create");
    // 同じ pair で 2 回失う（遅れた割当）。
    expect(await failQuote(() => adapter!.createOffer(request("a")))).toMatchObject({ detail: "facilitator_busy" });
    expect(await failQuote(() => adapter!.createOffer(request("a")))).toMatchObject({ detail: "facilitator_busy" });
    const requested = (await ledgerRows()).filter((r) => r.event === "requested");
    expect(requested).toHaveLength(2);
    const nowSec = () => Math.floor(clockMs / 1000);
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(2);
    // 1 時間後に facilitator 側で割当が終わる（adapter の時計に合わせた createdAt・expiresAt）。
    clockMs += 3_600_000;
    fixture.allocate({ requesterDigest: requested[0]!.patch["requesterDigest"] as string, resourceDigest: requested[0]!.patch["resourceDigest"] as string, createdAt: nowSec(), expiresAt: nowSec() + 300 });
    fixture.setMode("create", "ok");
    // 3 つ目の要求（別の pair）: 未解決 2 < 3 なので通る → 未解決は attempt 2 のまま（成立した要求は created + 後で settle されるまで未解決）。
    const third = await adapter!.createOffer(request("b"));
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(3);
    // 4 つ目: 上限 → 照会が走る（GET 1 回、同じ pair は 1 回だけ）→ discovered が 1 つ増えて 4 → まだ上限 → limit_unresolved、POST 無し。
    const createsBefore = fixture.calls.byRoute["create"] ?? 0;
    expect(await failQuote(() => adapter!.createOffer(request("c")))).toMatchObject({ detail: "limit_unresolved" });
    expect(fixture.calls.byRoute["create"]).toBe(createsBefore);
    expect(fixture.calls.byRoute["requesters"]).toBe(1);
    const rows = await ledgerRows();
    expect(rows.filter((r) => r.event === "discovered")).toHaveLength(1);
    expect(rows.filter((r) => r.event === "lookup").map((r) => r.patch["outcome"])).toEqual(["found"]);
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(4);
    expect(notes).toContain("subetha-exact: unresolved requests at the limit; inspect with the operator tool");
    // 3 つ目を settle すると attempt は外れる（4 → 3）。
    const credential = await credentialFor(third);
    expect((await adapter!.settle(third, credential, { routeId: ROUTE_ID })).outcome).toBe("settled");
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(3);
    // 運用者の abandon で片方の attempt を外す（3 → 2）。adapter は自分では書かない行。
    await adapter!.ledger!.append(requested[0]!.paymentId, "abandoned", { by: "operator", reason: "operator_timeout" });
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(2);
    // discovered の期限 + 猶予 → 1（残る attempt は時間では外れない）。
    clockMs += (300 + 61) * 1000;
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(1);
    clockMs += 10 * 3_600_000;
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(1);
    // 再起動後も同じ（index は ledger から）。startup の 1 巡で GET がもう 1 回。
    await adapter!.close();
    await makeAdapter({ limits: { maxRequestsTotal: 100, maxUnresolved: 3, requestsPerMinute: 60 } });
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(1);
    expect(fixture.calls.byRoute["requesters"]).toBe(2);
  });
  test("照会の 5xx は 2 試行して lookup failed。empty は empty。attempt は未解決のまま", async () => {
    await makeAdapter({ limits: { maxRequestsTotal: 100, maxUnresolved: 1, requestsPerMinute: 60 } });
    fixture.setMode("create", "busy");
    await failQuote(() => adapter!.createOffer(request("a")));
    fixture.setMode("requesters", "error");
    expect(await failQuote(() => adapter!.createOffer(request("b")))).toMatchObject({ detail: "limit_unresolved" });
    expect(fixture.calls.byRoute["requesters"]).toBe(2);
    expect((await ledgerRows()).at(-1)).toMatchObject({ event: "lookup", patch: { outcome: "failed", httpStatus: 500 } });
    fixture.setMode("requesters", "empty");
    expect(await failQuote(() => adapter!.createOffer(request("b")))).toMatchObject({ detail: "limit_unresolved" });
    expect((await ledgerRows()).at(-1)).toMatchObject({ event: "lookup", patch: { outcome: "empty" } });
  });
});

describe("preflight・verify（§3.5）", () => {
  test("preflight: nonce・束縛・offer の欄・extra の未知キー・authorization の to/value/validBefore/validAfter・署名の形", async () => {
    await makeAdapter();
    const offer = await adapter!.createOffer(request());
    const good = await credentialFor(offer);
    const nowMs = clockMs;
    expect(adapter!.preflight(offer, good, nowMs)).toEqual({ ok: true });
    expect(adapter!.preflight(offer, { ...good, payload: { ...good.payload, challengeNonce: "0xother" } }, nowMs)).toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(adapter!.preflight(offer, good, offer.extra.expiresAt * 1000)).toEqual({ ok: false, reason: "offer_expired" });
    expect(adapter!.preflight(offer, { ...good, accepted: { ...offer, extra: { ...offer.extra, routeBinding: "x" } } }, nowMs)).toEqual({ ok: false, reason: "route_binding_mismatch" });
    expect(adapter!.preflight(offer, { ...good, accepted: { ...offer, amount: "1" } }, nowMs)).toEqual({ ok: false, reason: "offer_mismatch" });
    expect(adapter!.preflight(offer, { ...good, accepted: { ...offer, extra: { ...offer.extra, extraKey: 1 } } }, nowMs)).toEqual({ ok: false, reason: "offer_mismatch" });
    expect(adapter!.preflight(offer, { ...good, accepted: { ...offer, resource: "allowed" } as unknown as InboundOffer }, nowMs)).toEqual({ ok: true });
    const authorization = good.payload["authorization"] as Record<string, string>;
    expect(adapter!.preflight(offer, { ...good, payload: { ...good.payload, authorization: { ...authorization, value: "1" } } }, nowMs)).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(adapter!.preflight(offer, { ...good, payload: { ...good.payload, authorization: { ...authorization, validBefore: String(offer.extra.expiresAt + 1) } } }, nowMs)).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(adapter!.preflight(offer, { ...good, payload: { ...good.payload, authorization: { ...authorization, validAfter: String(Math.floor(nowMs / 1000) + 1) } } }, nowMs)).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(adapter!.preflight(offer, { ...good, payload: { ...good.payload, authorization: { ...authorization, nonce: `0x${"11".repeat(32)}` } } }, nowMs)).toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(adapter!.preflight(offer, { ...good, payload: { ...good.payload, signature: "sig" } }, nowMs)).toEqual({ ok: false, reason: "credential_mismatch" });
  });
  test("verify: 手元の拒否は欄なし、facilitator の拒否・transport の失敗は isValid false + 正確な validBefore（throw しない）、通れば true。ledger の verify の行", async () => {
    await makeAdapter({ timeouts: { verifyMs: 300 } });
    const offer = await adapter!.createOffer(request());
    const good = await credentialFor(offer);
    const forged = { ...good, payload: { ...good.payload, signature: `0x${"11".repeat(65)}` } };
    expect(await adapter!.verify(offer, forged, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    expect(fixture.calls.byRoute["verify"]).toBeUndefined();
    expect(await adapter!.verify(offer, good, { routeId: ROUTE_ID })).toEqual({ isValid: true, mayStillSettleUntil: offer.extra.expiresAt });
    fixture.setMode("verify", "invalid");
    expect(await adapter!.verify(offer, good, { routeId: ROUTE_ID })).toEqual({ isValid: false, mayStillSettleUntil: offer.extra.expiresAt });
    fixture.setMode("verify", "stall-body");
    expect(await adapter!.verify(offer, good, { routeId: ROUTE_ID })).toEqual({ isValid: false, mayStillSettleUntil: offer.extra.expiresAt });
    fixture.setMode("verify", "raw", { status: 500, headers: {}, body: "boom" });
    expect(await adapter!.verify(offer, good, { routeId: ROUTE_ID })).toEqual({ isValid: false, mayStillSettleUntil: offer.extra.expiresAt });
    const verifies = (await ledgerRows()).filter((r) => r.event === "verify").map((r) => [r.patch["local"], r.patch["remote"]]);
    expect(verifies).toEqual([["invalid", undefined], ["ok", "valid"], ["ok", "invalid"], ["ok", "not_json"], ["ok", "http_error"]]);
  });
});

describe("settle（表 B）", () => {
  test("accepted → settled（txRef・eventId は小文字）。pending・rejected・5xx・読めない・timeout・lose-response → unknown（throw しない、再試行しない）。ledger の settle の行", async () => {
    await makeAdapter({ timeouts: { settleMs: 300 }, limits: { maxRequestsTotal: 100, maxUnresolved: 20, requestsPerMinute: 60 } });
    const offer = await adapter!.createOffer(request());
    const good = await credentialFor(offer);
    for (const mode of ["pending", "rejected:send-limit-reached", "error", "unreadable", "timeout", "lose-response"]) {
      const fresh = await adapter!.createOffer(request(mode));
      const credential = await credentialFor(fresh);
      fixture.setMode("settle", mode);
      const result = await adapter!.settle(fresh, credential, { routeId: ROUTE_ID });
      expect(result, mode).toEqual({ outcome: "unknown", reason: "source_settle_unknown", mayStillSettleUntil: fresh.extra.expiresAt });
      expect((await ledgerRows()).at(-1), mode).toMatchObject({ event: "settle", patch: { outcome: "unknown", mayStillSettleUntil: fresh.extra.expiresAt } });
    }
    fixture.setMode("settle", "accepted");
    const settled = await adapter!.settle(offer, good, { routeId: ROUTE_ID });
    expect(settled).toEqual({ outcome: "settled", txRef: fixture.orders.get(offer.extra.challengeNonce)!.exact!.txHash, eventId: offer.extra.challengeNonce });
    expect((await ledgerRows()).at(-1)).toMatchObject({ event: "settle", patch: { outcome: "settled", txRef: settled.outcome === "settled" ? settled.txRef : "" } });
    expect(fixture.calls.byOrder[offer.extra.challengeNonce]).toMatchObject({ settle: 1 });
  });
  test("ledger に attempt の無い注文（消失）: settle は要求を出す前に rejected、release は unknown、note", async () => {
    await makeAdapter();
    const offer = await adapter!.createOffer(request());
    await adapter!.close();
    await rm(path.join(workDir, "subetha-exact"), { recursive: true, force: true });
    await makeAdapter();
    expect(await adapter!.settle(offer, await credentialFor(offer), { routeId: ROUTE_ID })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    expect(await adapter!.release!(offer, { routeId: ROUTE_ID, sourceTxRef: "0xabc" })).toEqual({ outcome: "unknown", reason: "source_release_unknown" });
    expect(fixture.calls.byRoute["settle"]).toBeUndefined();
    expect(notes.some((n) => n.includes("no ledger attempt"))).toBe(true);
  });
});

describe("release（表 C・D・D′）", () => {
  test("ok → released（deliveryKey = orderId、txRef = settle、eventId の形）、ledger の release の行。already-* / incident / requester-mismatch → refused", async () => {
    await makeAdapter();
    const { offer, txRef } = await settledOffer();
    const context = { routeId: ROUTE_ID, deadlineMs: clockMs + 60_000, sourceTxRef: txRef };
    const released = await adapter!.release!(offer, context);
    expect(released).toEqual({ outcome: "released", deliveryKey: offer.extra.challengeNonce, txRef, eventId: `${CHAIN_ID}:${txRef}:0` });
    expect((await ledgerRows()).at(-1)).toMatchObject({ event: "release", patch: { outcome: "released", attempts: 1, httpStatus: 200 } });
    // 2 回目（復元の条件が揃うので released。表 D）。完了の後は refused。
    expect((await adapter!.release!(offer, context)).outcome).toBe("released");
    expect((await ledgerRows()).at(-1)).toMatchObject({ event: "release", patch: { outcome: "released", reconstructed: true } });
    expect(await adapter!.complete!(offer, offer.extra.challengeNonce, "delivered", { routeId: ROUTE_ID })).toEqual({ outcome: "completed" });
    expect(await adapter!.release!(offer, context)).toEqual({ outcome: "refused", reason: "source_release_refused" });
    const b = await settledOffer("b");
    fixture.setMode("release", "incident");
    expect(await adapter!.release!(b.offer, { ...context, sourceTxRef: b.txRef })).toEqual({ outcome: "refused", reason: "source_release_refused" });
  });
  test("425 は予算の内で再試行（not-ready-once → released、not-ready-always → 3 試行で unknown）。Retry-After が予算を超えれば試行せず unknown", async () => {
    await makeAdapter();
    const a = await settledOffer("a");
    fixture.setMode("release", "not-ready-once");
    expect((await adapter!.release!(a.offer, { routeId: ROUTE_ID, deadlineMs: clockMs + 60_000, sourceTxRef: a.txRef })).outcome).toBe("released");
    expect(fixture.calls.byOrder[a.offer.extra.challengeNonce]).toMatchObject({ release: 2 });
    const b = await settledOffer("b");
    fixture.setMode("release", "not-ready-always");
    expect(await adapter!.release!(b.offer, { routeId: ROUTE_ID, deadlineMs: clockMs + 60_000, sourceTxRef: b.txRef })).toEqual({ outcome: "unknown", reason: "source_release_unknown" });
    expect(fixture.calls.byOrder[b.offer.extra.challengeNonce]).toMatchObject({ release: 3 });
    expect((await ledgerRows()).at(-1)).toMatchObject({ event: "release", patch: { outcome: "unknown", attempts: 3, httpStatus: 425 } });
    const c = await settledOffer("c");
    fixture.setMode("release", "raw", { status: 425, headers: { "retry-after": "30" }, body: JSON.stringify({ error: "not-ready" }) });
    expect((await adapter!.release!(c.offer, { routeId: ROUTE_ID, deadlineMs: clockMs + 60_000, sourceTxRef: c.txRef })).outcome).toBe("unknown");
    expect(fixture.calls.byOrder[c.offer.extra.challengeNonce]).toMatchObject({ release: 1 });
  });
  test("D: claimed-before → GET で復元して released（reconstructed）。corrupt の 7 欄と after-release:reorged → refused。GET の 5xx → unknown", async () => {
    await makeAdapter();
    const context = (txRef: string) => ({ routeId: ROUTE_ID, deadlineMs: clockMs + 60_000, sourceTxRef: txRef });
    const a = await settledOffer("a");
    fixture.setMode("release", "claimed-before");
    const released = await adapter!.release!(a.offer, context(a.txRef));
    expect(released).toMatchObject({ outcome: "released", deliveryKey: a.offer.extra.challengeNonce, txRef: a.txRef });
    expect((await ledgerRows()).at(-1)).toMatchObject({ event: "release", patch: { outcome: "released", reconstructed: true, httpStatus: 200 } });
    for (const mode of ["corrupt:binding.requesterDigest", "corrupt:binding.resourceDigest", "corrupt:release.deliveryKey", "corrupt:release.txRef", "corrupt:release.eventId", "corrupt:release.state", "corrupt:state", "after-release:reorged"]) {
      const x = await settledOffer(mode);
      fixture.setMode("release", "claimed-before");
      fixture.setMode("status", mode);
      expect(await adapter!.release!(x.offer, context(x.txRef)), mode).toEqual({ outcome: "refused", reason: "source_release_refused" });
      fixture.setMode("status", "ok");
    }
    const y = await settledOffer("y");
    fixture.setMode("release", "claimed-before");
    fixture.setMode("status", "error");
    expect(await adapter!.release!(y.offer, context(y.txRef))).toEqual({ outcome: "unknown", reason: "source_release_unknown" });
    expect(fixture.calls.byOrder[y.offer.extra.challengeNonce]).toMatchObject({ status: 2 });
  });
  test("D′: lose-response → GET → released。lose-response + corrupt → unknown（refused にしない）。error-once → GET が none → 再試行 → released。rate-limited-once（Retry-After 1）→ 待って released", async () => {
    await makeAdapter();
    const context = (txRef: string) => ({ routeId: ROUTE_ID, deadlineMs: clockMs + 60_000, sourceTxRef: txRef });
    const a = await settledOffer("a");
    fixture.setMode("release", "lose-response");
    expect((await adapter!.release!(a.offer, context(a.txRef))).outcome).toBe("released");
    expect((await ledgerRows()).at(-1)).toMatchObject({ event: "release", patch: { reconstructed: true } });
    fixture.setMode("release", "ok");
    const b = await settledOffer("b");
    fixture.setMode("release", "lose-response");
    fixture.setMode("status", "corrupt:release.txRef");
    expect(await adapter!.release!(b.offer, context(b.txRef))).toEqual({ outcome: "unknown", reason: "source_release_unknown" });
    fixture.setMode("status", "ok");
    const c = await settledOffer("c");
    fixture.setMode("release", "error-once");
    expect((await adapter!.release!(c.offer, context(c.txRef))).outcome).toBe("released");
    expect(fixture.calls.byOrder[c.offer.extra.challengeNonce]).toMatchObject({ release: 2, status: 1 });
    const d = await settledOffer("d");
    fixture.setMode("release", "rate-limited-once");
    expect((await adapter!.release!(d.offer, context(d.txRef))).outcome).toBe("released");
  });
  test("試験の停止点 after_release_remote は released のときだけ、ledger の行の後に呼ばれる", async () => {
    const points: string[] = [];
    await makeAdapter({ hooksForTest: { stop: async (point, orderId) => void points.push(`${point}:${orderId}`) } });
    const a = await settledOffer("a");
    await adapter!.release!(a.offer, { routeId: ROUTE_ID, deadlineMs: clockMs + 60_000, sourceTxRef: a.txRef });
    expect(points).toEqual([`after_release_remote:${a.offer.extra.challengeNonce}`]);
  });
});

describe("complete（表 E）", () => {
  test("ok → completed。preset → conflicting_outcome（恒久）。error-once → completed。lose-response（全部）→ unavailable。tenant 404 → unknown_tenant。401 → unauthorized。別 tenant の注文は呼ばない", async () => {
    await makeAdapter();
    const ctx = { routeId: ROUTE_ID };
    const done = async (requestId: string) => {
      const x = await settledOffer(requestId);
      await adapter!.release!(x.offer, { ...ctx, deadlineMs: clockMs + 60_000, sourceTxRef: x.txRef });
      return x.offer;
    };
    const a = await done("a");
    expect(await adapter!.complete!(a, a.extra.challengeNonce, "delivered", ctx)).toEqual({ outcome: "completed" });
    expect((await ledgerRows()).at(-1)).toMatchObject({ event: "complete", patch: { outcome: "completed", reported: "delivered", attempts: 1 } });
    const b = await done("b");
    fixture.setMode("complete", "preset:failed");
    expect(await adapter!.complete!(b, b.extra.challengeNonce, "delivered", ctx)).toEqual({ outcome: "unreported", reason: "conflicting_outcome" });
    fixture.setMode("complete", "error-once");
    const c = await done("c");
    expect(await adapter!.complete!(c, c.extra.challengeNonce, "failed", ctx)).toEqual({ outcome: "completed" });
    expect(fixture.calls.byOrder[c.extra.challengeNonce]).toMatchObject({ complete: 2 });
    const d = await done("d");
    fixture.setMode("complete", "lose-response");
    expect(await adapter!.complete!(d, d.extra.challengeNonce, "delivered", ctx)).toEqual({ outcome: "unreported", reason: "unavailable" });
    expect(fixture.calls.byOrder[d.extra.challengeNonce]).toMatchObject({ complete: 2 });
    fixture.setMode("complete", "raw", { status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "unknown" }) });
    expect(await adapter!.complete!(d, d.extra.challengeNonce, "delivered", ctx)).toEqual({ outcome: "unreported", reason: "unknown_tenant" });
    fixture.setMode("complete", "raw", { status: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "unauthorized" }) });
    expect(await adapter!.complete!(d, d.extra.challengeNonce, "delivered", ctx)).toEqual({ outcome: "unreported", reason: "unauthorized" });
    // 別 tenant の注文: ledger の created.tenant が違えば呼ばずに unknown_tenant。
    const rows = await ledgerRows();
    const created = rows.find((r) => r.event === "created" && r.patch["orderId"] === d.extra.challengeNonce)!;
    await adapter!.close();
    await writeFile(path.join(workDir, "subetha-exact", "orders.ndjson"), (await readFile(path.join(workDir, "subetha-exact", "orders.ndjson"), "utf8")).replaceAll(JSON.stringify(created.patch["tenant"]), JSON.stringify("/p/other-tenant")));
    await makeAdapter();
    const completesBefore = fixture.calls.byRoute["complete"];
    expect(await adapter!.complete!(d, d.extra.challengeNonce, "delivered", ctx)).toEqual({ outcome: "unreported", reason: "unknown_tenant" });
    expect(fixture.calls.byRoute["complete"]).toBe(completesBefore);
  });
});

describe("ledger の失敗・salt・秘密の不在（§3.2・§3.9、NFR-3）", () => {
  async function failNextAppend(): Promise<void> {
    const probe = await open(path.join(workDir, "probe"), "a");
    const proto = Object.getPrototypeOf(probe) as { appendFile: (...args: unknown[]) => Promise<void> };
    await probe.close();
    vi.spyOn(proto, "appendFile").mockImplementationOnce(() => Promise.reject(new Error("EIO")));
  }
  test("requested の append の失敗: facilitator を呼ばず ledger_unavailable、以後の作成も止まる（再起動まで）", async () => {
    await makeAdapter();
    await failNextAppend();
    expect(await failQuote(() => adapter!.createOffer(request("a")))).toMatchObject({ code: "source_offer_unavailable", detail: "ledger_unavailable" });
    expect(await failQuote(() => adapter!.createOffer(request("b")))).toMatchObject({ detail: "ledger_unavailable" });
    expect(fixture.calls.byRoute["create"]).toBeUndefined();
    expect(adapter!.ledger!.broken).toBe(true);
    await adapter!.close();
    await makeAdapter();
    expect((await adapter!.createOffer(request("a"))).scheme).toBe("exact");
  });
  test("created の append の失敗: 注文は作られるが offer は返さない（ledger_unavailable）。遠隔の後の行（settle）の失敗は結果を保つ", async () => {
    await makeAdapter();
    const offer = await adapter!.createOffer(request("a"));
    const credential = await credentialFor(offer);
    await failNextAppend();
    const settled = await adapter!.settle(offer, credential, { routeId: ROUTE_ID });
    expect(settled.outcome).toBe("settled");
    expect(notes).toContain("subetha-exact: ledger row could not be written (event=settle)");
    await adapter!.close();
    await makeAdapter();
    // created だけを落とす: requested は通し、2 回目の append を落とす（前の spy は戻してから本物を捕まえる）。
    vi.restoreAllMocks();
    const probe = await open(path.join(workDir, "probe3"), "a");
    const proto = Object.getPrototypeOf(probe) as { appendFile: (...a: unknown[]) => Promise<void> };
    await probe.close();
    const original = proto.appendFile;
    let calls = 0;
    vi.spyOn(proto, "appendFile").mockImplementation(function (this: unknown, ...args: unknown[]) {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error("EIO")) : original.apply(this, args);
    });
    expect(await failQuote(() => adapter!.createOffer(request("b")))).toMatchObject({ detail: "ledger_unavailable" });
    expect(fixture.orders.size).toBe(2);
    expect(notes).toContain("subetha-exact: ledger unavailable after order creation; offer withheld");
  });
  test("salt: 行があるのに salt が無ければ ConfigError で startup が失敗し、lock は解放される。salt が壊れていても ConfigError", async () => {
    await makeAdapter();
    await adapter!.createOffer(request("a"));
    await adapter!.close();
    await unlink(path.join(workDir, "subetha-exact", "requester.salt"));
    await expect(createSubethaExactInbound({ facilitatorUrl: `${fixture.baseUrl}/p/${PROVIDER}`, token: () => TOKEN, transport: createGuardedTransport({ allowLoopback: true, report: () => {} }), asset: { network: NETWORK, id: ASSET, decimals: 6, domain: DOMAIN }, ledgerDir: path.join(workDir, "subetha-exact"), limits: { maxRequestsTotal: 100, maxUnresolved: 3, requestsPerMinute: 60 } }).startup()).rejects.toBeInstanceOf(ConfigError);
    await writeFile(path.join(workDir, "subetha-exact", "requester.salt"), "not-hex\n");
    await expect(createSubethaExactInbound({ facilitatorUrl: `${fixture.baseUrl}/p/${PROVIDER}`, token: () => TOKEN, transport: createGuardedTransport({ allowLoopback: true, report: () => {} }), asset: { network: NETWORK, id: ASSET, decimals: 6, domain: DOMAIN }, ledgerDir: path.join(workDir, "subetha-exact"), limits: { maxRequestsTotal: 100, maxUnresolved: 3, requestsPerMinute: 60 } }).startup()).rejects.toBeInstanceOf(ConfigError);
    // lock が解けているので、salt を戻せば開ける。
    await writeFile(path.join(workDir, "subetha-exact", "requester.salt"), `${"ab".repeat(32)}\n`);
    await makeAdapter();
    expect(adapter!.ledger!.salt).toBe("ab".repeat(32));
  });
  test("秘密の不在: token・署名・credential・facilitator の自由な文が ledger・note・例外の message に無い", async () => {
    await makeAdapter();
    const offer = await adapter!.createOffer(request("a"));
    const credential = await credentialFor(offer);
    await adapter!.verify(offer, credential, { routeId: ROUTE_ID });
    const settled = await adapter!.settle(offer, credential, { routeId: ROUTE_ID });
    await adapter!.release!(offer, { routeId: ROUTE_ID, deadlineMs: clockMs + 60_000, sourceTxRef: settled.outcome === "settled" ? settled.txRef : "" });
    fixture.setMode("complete", "raw", { status: 409, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "weird: https://leak.example/secret?token=abc" }) });
    await adapter!.complete!(offer, offer.extra.challengeNonce, "delivered", { routeId: ROUTE_ID });
    fixture.setMode("create", "raw", { status: 403, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "free text SECRET-CANARY" }) });
    const error = await failQuote(() => adapter!.createOffer(request("b")));
    const ledgerText = await readFile(path.join(workDir, "subetha-exact", "orders.ndjson"), "utf8");
    const signature = String((credential.payload as Record<string, unknown>)["signature"]);
    for (const canary of [TOKEN, signature, "leak.example", "SECRET-CANARY", fixture.baseUrl!, "alice"]) {
      expect(ledgerText, canary).not.toContain(canary);
      expect(notes.join("\n"), canary).not.toContain(canary);
      expect(error.message, canary).not.toContain(canary);
    }
    expect(ledgerText).not.toContain("principalId");
  });
});

describe("実装レビュー 3 の追加", () => {
  test("期限の近い署名（validBefore = now + 5）は facilitator の verify で落ち、isValid false と正確な validBefore（settle 0）", async () => {
    await makeAdapter();
    const offer = await adapter!.createOffer(request("near"));
    const nearSec = Math.floor(clockMs / 1000) + 5;
    const credential = await credentialFor(offer, (o) => ({ ...o, extra: { ...o.extra, expiresAt: nearSec } }));
    expect(adapter!.preflight(offer, { ...credential, accepted: offer }, clockMs)).toEqual({ ok: true });
    expect(await adapter!.verify(offer, { ...credential, accepted: offer }, { routeId: ROUTE_ID })).toEqual({ isValid: false, mayStillSettleUntil: nearSec });
    expect(fixture.calls.byRoute["settle"]).toBeUndefined();
  });
  test("maxUnresolved 5: 上限に当たると注文の分からない全 pair が照会され（同じ pair は 1 回）、期限・abandon の後の遅れた割当でも数は減らない", async () => {
    await makeAdapter({ limits: { maxRequestsTotal: 100, maxUnresolved: 5, requestsPerMinute: 60 } });
    const nowSec = () => Math.floor(clockMs / 1000);
    fixture.setMode("create", "busy-then-create");
    for (const id of ["p1", "p1", "p2", "p3", "p4"]) await failQuote(() => adapter!.createOffer(request(id)));
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(5);
    const requested = (await ledgerRows()).filter((r) => r.event === "requested");
    const pairs = new Set(requested.map((r) => `${r.patch["requesterDigest"]}|${r.patch["resourceDigest"]}`));
    expect(pairs.size).toBe(4);
    fixture.setMode("create", "ok");
    expect(await failQuote(() => adapter!.createOffer(request("p5")))).toMatchObject({ detail: "limit_unresolved" });
    expect(fixture.calls.byRoute["requesters"]).toBe(4);
    expect(fixture.calls.byRoute["create"]).toBe(5);
    // 遅れた割当（p2）→ 照会で discovered（6）→ 期限で discovered は外れる（5）→ p2 の attempt を abandon（4）→ また遅れた割当（p3）→ 照会で 5。
    const p2 = requested[2]!.patch;
    fixture.allocate({ requesterDigest: p2["requesterDigest"] as string, resourceDigest: p2["resourceDigest"] as string, createdAt: nowSec(), expiresAt: nowSec() + 300 });
    expect(await failQuote(() => adapter!.createOffer(request("p5")))).toMatchObject({ detail: "limit_unresolved" });
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(6);
    clockMs += 400_000;
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(5);
    await adapter!.ledger!.append(requested[2]!.paymentId, "abandoned", { by: "operator", reason: "operator_timeout" });
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(4);
    const p3 = requested[3]!.patch;
    fixture.allocate({ requesterDigest: p3["requesterDigest"] as string, resourceDigest: p3["resourceDigest"] as string, createdAt: nowSec(), expiresAt: nowSec() + 300 });
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(4);
    const created = await adapter!.createOffer(request("p6"));
    expect(created.scheme).toBe("exact");
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(5);
    expect(await failQuote(() => adapter!.createOffer(request("p7")))).toMatchObject({ detail: "limit_unresolved" });
    expect(adapter!.ledger!.unresolvedCount(nowSec())).toBe(6);
  });
  test("遠隔の後の行の append の失敗（verify・release・complete・refused・create_failed・discovered・lookup）は結果を保ち note だけ。失敗の後は writer が止まる（再起動で戻る）", async () => {
    const limits = { maxRequestsTotal: 100, maxUnresolved: 1, requestsPerMinute: 60 };
    await makeAdapter({ limits });
    const probe = await open(path.join(workDir, "probe"), "a");
    const proto = Object.getPrototypeOf(probe) as { appendFile: (...a: unknown[]) => Promise<void> };
    await probe.close();
    const original = proto.appendFile;
    /** `skip` 回の append を通した後の 1 回を落とす。 */
    let remaining = -1;
    vi.spyOn(proto, "appendFile").mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (remaining === 0) {
        remaining = -1;
        return Promise.reject(new Error("EIO"));
      }
      if (remaining > 0) remaining -= 1;
      return original.apply(this, args);
    });
    const arm = (skip: number) => {
      remaining = skip;
      notes.length = 0;
    };
    /** journal の writer は最初の失敗で止まる（`src/core/journal.ts`）: 次の事象の前に adapter を開き直す。 */
    const reopen = async () => {
      expect(adapter!.ledger!.broken).toBe(true);
      await adapter!.close();
      await makeAdapter({ limits });
    };
    const { offer, txRef } = await settledOffer("a");
    const credential = await credentialFor(offer);
    arm(0);
    expect(await adapter!.verify(offer, credential, { routeId: ROUTE_ID })).toEqual({ isValid: true, mayStillSettleUntil: offer.extra.expiresAt });
    expect(notes).toContain("subetha-exact: ledger row could not be written (event=verify)");
    await reopen();
    arm(0);
    expect((await adapter!.release!(offer, { routeId: ROUTE_ID, deadlineMs: clockMs + 60_000, sourceTxRef: txRef })).outcome).toBe("released");
    expect(notes).toContain("subetha-exact: ledger row could not be written (event=release)");
    await reopen();
    arm(0);
    expect(await adapter!.complete!(offer, offer.extra.challengeNonce, "delivered", { routeId: ROUTE_ID })).toEqual({ outcome: "completed" });
    expect(notes).toContain("subetha-exact: ledger row could not be written (event=complete)");
    await reopen();
    // refused の行（403）: requested は通し、次を落とす。
    arm(1);
    expect(await failQuote(() => adapter!.createOffer(request("r", "alice", "1000001")))).toMatchObject({ detail: "amount_refused" });
    expect(notes).toContain("subetha-exact: ledger row could not be written (event=refused)");
    await reopen();
    // refused の行が失われた attempt は未解決に数えられたまま（保守的）: 運用者の abandon で外す（道具の経路と同じ 1 行）。
    const lost = adapter!.ledger!.attempts().find((x) => x.created === undefined && x.refused === undefined && x.abandoned === undefined)!;
    await adapter!.ledger!.append(lost.attemptId, "abandoned", { by: "operator", reason: "operator_other" });
    // create_failed の行（503）。
    fixture.setMode("create", "busy-then-create");
    arm(1);
    expect(await failQuote(() => adapter!.createOffer(request("b")))).toMatchObject({ detail: "facilitator_busy" });
    expect(notes).toContain("subetha-exact: ledger row could not be written (event=create_failed)");
    await reopen();
    // discovered の行（上限 1 → 照会 → 遅れた割当が見つかる）。
    const b = (await ledgerRows()).filter((r) => r.event === "requested").at(-1)!.patch;
    fixture.allocate({ requesterDigest: b["requesterDigest"] as string, resourceDigest: b["resourceDigest"] as string });
    fixture.setMode("create", "ok");
    arm(0);
    expect(await failQuote(() => adapter!.createOffer(request("c")))).toMatchObject({ detail: "limit_unresolved" });
    expect(notes).toContain("subetha-exact: ledger row could not be written (event=discovered)");
    await reopen();
    // lookup の行（discovered は startup の 1 巡で記録済みなので、今度の照会は lookup だけ）。
    arm(0);
    expect(await failQuote(() => adapter!.createOffer(request("c")))).toMatchObject({ detail: "limit_unresolved" });
    expect(notes).toContain("subetha-exact: ledger row could not be written (event=lookup)");
    expect(adapter!.ledger!.broken).toBe(true);
    expect(await failQuote(() => adapter!.createOffer(request("d")))).toMatchObject({ detail: "ledger_unavailable" });
  });
  test("診断の sink に token・署名・credential が無い（verify・settle の往復の記録）", async () => {
    const captures: unknown[] = [];
    await makeAdapter({ diagnostics: { emit: (capture) => void captures.push(capture) } });
    const offer = await adapter!.createOffer(request("d"));
    const credential = await credentialFor(offer);
    await adapter!.verify(offer, credential, { routeId: ROUTE_ID });
    await adapter!.settle(offer, credential, { routeId: ROUTE_ID });
    expect(captures.length).toBeGreaterThanOrEqual(2);
    const text = JSON.stringify(captures);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(String((credential.payload as Record<string, unknown>)["signature"]));
    expect(text).not.toContain(fixture.baseUrl!);
  });
});

describe("標準の x402 クライアント用の入口の offer（`docs/x402-standard-entry-design.md` §3、§4.4、§5）", () => {
  const standard = (requestId: string) => ({ ...request(requestId), entry: "x402" as const });
  const withNonce = (credential: PaymentCredential, nonce: string): PaymentCredential => {
    const payload = credential.payload as unknown as { authorization: Record<string, string> };
    return { ...credential, payload: { ...credential.payload, authorization: { ...payload.authorization, nonce } } };
  };
  const RANDOM_NONCE = `0x${"5a".repeat(32)}`;

  test("印と期限: extra.entry = x402、expiresAt は注文の期限（発行 + 120 秒で切らない）。印の無い offer は今までどおり", async () => {
    await makeAdapter();
    const offer = await adapter!.createOffer(standard("s-1"));
    expect(Object.keys(offer.extra).sort()).toEqual(["challengeNonce", "entry", "expiresAt", "fundsMoveOnCredential", "name", "routeBinding", "version"]);
    expect(offer.extra["entry"]).toBe("x402");
    expect(offer.extra.expiresAt).toBe(Math.floor(clockMs / 1000) + 300);
    expect(adapter!.settleWindowOf!(offer)).toBe(Math.floor(clockMs / 1000) + 300);
    const legacy = await adapter!.createOffer(request("q-1"));
    expect(legacy.extra).not.toHaveProperty("entry");
    expect(legacy.extra.expiresAt).toBe(Math.floor(clockMs / 1000) + 120);
  });

  test("既にある注文（existing）は標準 offer として出さない: order_exists（unavailable）。注文と ledger の行は残る（黙って消さない）", async () => {
    await makeAdapter();
    const first = await adapter!.createOffer(request("same"));
    const error = await adapter!.createOffer(standard("same")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InboundOfferError);
    expect([(error as InboundOfferError).code, (error as InboundOfferError).detail]).toEqual(["source_offer_unavailable", "order_exists"]);
    const created = (await ledgerRows()).filter((r) => r.event === "created");
    expect(created.map((r) => [r.patch["orderId"], r.patch["existing"]])).toEqual([[first.extra.challengeNonce, false], [first.extra.challengeNonce, true]]);
  });

  test("標準クライアントが今すぐ署名しても注文の期限を超える窓では出さない: order_window_short。attempt は未解決の枠に残る", async () => {
    // maxTimeoutSeconds 150 + minLeadSeconds 200 > 注文の残り 300。
    await makeAdapter({ timeouts: { createMs: 2_000, verifyMs: 2_000, settleMs: 2_000, statusMs: 2_000, releaseMs: 2_000, completeMs: 2_000, releaseRetryWaitMs: 30, completeRetryWaitMs: 30, releaseBudgetMs: 5_000, completeBudgetMs: 5_000, lookupBudgetMs: 5_000, minLeadSeconds: 200 } });
    const error = await adapter!.createOffer(standard("s-short")).catch((e: unknown) => e);
    expect([(error as InboundOfferError).code, (error as InboundOfferError).detail]).toEqual(["source_offer_unavailable", "order_window_short"]);
    expect((await ledgerRows()).map((r) => r.event)).toEqual(["requested", "created"]);
    // 同じ窓でも印の無い offer は今までどおり出る。
    await expect(adapter!.createOffer(request("q-short"))).resolves.toMatchObject({ scheme: "exact" });
  });

  test("preflight: 標準 offer は買い手の nonce を受け、validBefore は注文の期限まで。印の無い offer は nonce_mismatch のまま。checkSignature は本物の署名だけ true", async () => {
    await makeAdapter();
    const offer = await adapter!.createOffer(standard("s-2"));
    const credential = await credentialFor(offer);
    expect(adapter!.preflight(offer, withNonce(credential, RANDOM_NONCE), clockMs)).toEqual({ ok: true });
    await expect(adapter!.checkSignature!(offer, credential)).resolves.toBe(true);
    // nonce を差し替えた credential は署名が合わない（preflight は項目だけ、署名は checkSignature）。
    await expect(adapter!.checkSignature!(offer, withNonce(credential, RANDOM_NONCE))).resolves.toBe(false);
    // 期限: validBefore が注文の期限を 1 秒でも超えると拒む。
    const late = { ...credential, payload: { ...credential.payload, authorization: { ...(credential.payload as unknown as { authorization: Record<string, string> }).authorization, validBefore: String(offer.extra.expiresAt + 1) } } };
    expect(adapter!.preflight(offer, late, clockMs).ok).toBe(false);
    // 写しに知らない key があれば拒む（`entry` だけを足して許す）。
    expect(adapter!.preflight(offer, { ...credential, accepted: { ...offer, extra: { ...offer.extra, more: 1 } } as InboundOffer }, clockMs)).toEqual({ ok: false, reason: "offer_mismatch" });
    const legacy = await adapter!.createOffer(request("q-2"));
    const legacyCredential = await credentialFor(legacy);
    expect(adapter!.preflight(legacy, legacyCredential, clockMs)).toEqual({ ok: true });
    expect(adapter!.preflight(legacy, withNonce(legacyCredential, RANDOM_NONCE), clockMs)).toEqual({ ok: false, reason: "nonce_mismatch" });
    // 印の無い offer の写しに `entry` を足しても通らない。
    expect(adapter!.preflight(legacy, { ...legacyCredential, accepted: { ...legacy, extra: { ...legacy.extra, entry: "x402" } } as InboundOffer }, clockMs)).toEqual({ ok: false, reason: "offer_mismatch" });
  });

  test("verify: 標準 offer では、答えでない応答（500・壊れた JSON・{}・isValid が null／文字列）を拒否にせず例外にする。200 の isValid:false だけが拒否。印の無い offer は全て isValid:false のまま", async () => {
    await makeAdapter();
    const offer = await adapter!.createOffer(standard("s-3"));
    const credential = await credentialFor(offer);
    const legacy = await adapter!.createOffer(request("q-3"));
    const legacyCredential = await credentialFor(legacy);
    const json = { "content-type": "application/json" };
    const unanswered: { status: number; headers: Record<string, string>; body: string }[] = [
      { status: 500, headers: json, body: "{}" },
      { status: 200, headers: json, body: "not json" },
      { status: 200, headers: json, body: "{}" },
      { status: 200, headers: json, body: JSON.stringify({ isValid: null }) },
      { status: 200, headers: json, body: JSON.stringify({ isValid: "false" }) },
      { status: 200, headers: json, body: "[]" },
    ];
    for (const raw of unanswered) {
      fixture.setMode("verify", "raw", raw);
      await expect(adapter!.verify(offer, credential), raw.body).rejects.toThrow("verify unanswered");
      fixture.setMode("verify", "raw", raw);
      await expect(adapter!.verify(legacy, legacyCredential), raw.body).resolves.toMatchObject({ isValid: false });
    }
    fixture.setMode("verify", "raw", { status: 200, headers: json, body: JSON.stringify({ isValid: false, invalidReason: "insufficient_funds" }) });
    await expect(adapter!.verify(offer, credential)).resolves.toMatchObject({ isValid: false, mayStillSettleUntil: expect.any(Number) });
    await expect(adapter!.verify(offer, credential)).resolves.toMatchObject({ isValid: true });
  });
});

describe("送信元ごとの上限と verify の無応答（`docs/hosted-exact-enable-design.md` §3、§3.1）", () => {
  const TAG_A = "aaaaaaaaaaaaaaaa";
  const TAG_B = "bbbbbbbbbbbbbbbb";
  const from = (tag: string, requestId: string) => ({ ...request(requestId), requester: { principalId: "judge", requestId, sourceTag: tag } });
  // 送信元ごとの占有の上限 3: 作成のたびに 2 つ分の余裕を求めるので、未払いの offer は同時に 2 つまで（0+2 ≤ 3、1+2 ≤ 3、2+2 > 3）。
  const PER_SOURCE = { maxRequestsTotal: 100, maxUnresolved: 6, requestsPerMinute: 60, maxUnresolvedPerSource: 3, requestsPerMinutePerSource: 30 };
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InboundOfferError);
    return [(error as InboundOfferError).code, (error as InboundOfferError).detail, (error as InboundOfferError).retryAfterMs];
  };

  test("1 つの送信元は未解決 2 つまで。3 つ目は facilitator を呼ばずに止まり、別の送信元は通る。ledger の requested に tag が残り、再起動の後も同じ", async () => {
    await makeAdapter({ limits: PER_SOURCE });
    await adapter!.createOffer(from(TAG_A, "a-1"));
    await adapter!.createOffer(from(TAG_A, "a-2"));
    expect(await refusal(adapter!.createOffer(from(TAG_A, "a-3")))).toEqual(["source_offer_unavailable", "limit_source_unresolved", 300_000]);
    expect(fixture.calls.byRoute["create"]).toBe(2);
    await expect(adapter!.createOffer(from(TAG_B, "b-1"))).resolves.toMatchObject({ scheme: "exact" });
    expect((await ledgerRows()).filter((r) => r.event === "requested").map((r) => r.patch["sourceTag"])).toEqual([TAG_A, TAG_A, TAG_B]);
    await adapter!.close();
    await makeAdapter({ limits: PER_SOURCE });
    expect((await refusal(adapter!.createOffer(from(TAG_A, "a-4"))))[1]).toBe("limit_source_unresolved");
    await expect(adapter!.createOffer(from(TAG_B, "b-2"))).resolves.toMatchObject({ scheme: "exact" });
    // 注文の期限 + 猶予を過ぎると外れる。
    clockMs += (300 + 61) * 1000;
    await expect(adapter!.createOffer(from(TAG_A, "a-5"))).resolves.toMatchObject({ scheme: "exact" });
  });

  test("tag を渡さない呼び出しも 1 つの送信元として数える（上限をすり抜けない）。成功 1 + 応答の喪失 1 の後は、注文が後から見つかっても上限を超えない数で止まる", async () => {
    await makeAdapter({ limits: PER_SOURCE });
    // tag なし・形の違う tag は、同じ固定の tag として数える。
    await adapter!.createOffer(request("n-1"));
    await adapter!.createOffer({ ...request("n-2"), requester: { principalId: "alice", requestId: "n-2", sourceTag: "not-hex" } });
    expect((await refusal(adapter!.createOffer(request("n-3"))))[1]).toBe("limit_source_unresolved");
    expect((await ledgerRows()).filter((r) => r.event === "requested").map((r) => r.patch["sourceTag"])).toEqual(["0000000000000000", "0000000000000000"]);
    // 別の送信元: 1 つ成功（占有 1）、2 つ目は応答を失う（占有 2。注文が見つかれば 3 = 上限ちょうど）。3 つ目は作成の前に止まる。
    await adapter!.createOffer(from(TAG_A, "a-1"));
    fixture.setMode("create", "lose-response");
    expect((await refusal(adapter!.createOffer(from(TAG_A, "a-2"))))[0]).toBe("source_offer_unavailable");
    fixture.setMode("create", "ok");
    const creates = fixture.calls.byRoute["create"];
    expect((await refusal(adapter!.createOffer(from(TAG_A, "a-3"))))[1]).toBe("limit_source_unresolved");
    expect(fixture.calls.byRoute["create"]).toBe(creates);
    await adapter!.close();
    await makeAdapter({ limits: PER_SOURCE });
    expect((await refusal(adapter!.createOffer(from(TAG_A, "a-4"))))[1]).toBe("limit_source_unresolved");
    expect((await refusal(adapter!.createOffer(request("n-4"))))[1]).toBe("limit_source_unresolved");
  });

  test("送信元ごとの毎分の数。上限の欄が無い設定では送信元ごとに数えない（今までどおり）", async () => {
    await makeAdapter({ limits: { ...PER_SOURCE, maxUnresolved: 20, maxUnresolvedPerSource: 10, requestsPerMinutePerSource: 2 } });
    await adapter!.createOffer(from(TAG_A, "a-1"));
    await adapter!.createOffer(from(TAG_A, "a-2"));
    expect(await refusal(adapter!.createOffer(from(TAG_A, "a-3")))).toEqual(["source_offer_unavailable", "limit_source_rate", 60_000]);
    await expect(adapter!.createOffer(from(TAG_B, "b-1"))).resolves.toMatchObject({ scheme: "exact" });
    clockMs += 61_000;
    await expect(adapter!.createOffer(from(TAG_A, "a-4"))).resolves.toMatchObject({ scheme: "exact" });
    await adapter!.close();
    adapter = undefined;
    await rm(path.join(workDir, "subetha-exact"), { recursive: true, force: true });
    await makeAdapter({ limits: { maxRequestsTotal: 100, maxUnresolved: 20, requestsPerMinute: 60 } });
    for (let index = 0; index < 4; index += 1) await adapter!.createOffer(from(TAG_A, `p-${index}`));
    expect((await ledgerRows()).filter((r) => r.event === "created")).toHaveLength(4);
  });

  test("作成の応答を失った送信元は、それが片付くまで作れない（2 回続けて失えない）。別の送信元は通る。再起動の後も同じ", async () => {
    await makeAdapter({ limits: PER_SOURCE });
    fixture.setMode("create", "lose-response");
    expect((await refusal(adapter!.createOffer(from(TAG_A, "a-lost"))))[0]).toBe("source_offer_unavailable");
    fixture.setMode("create", "ok");
    const creates = fixture.calls.byRoute["create"];
    expect((await refusal(adapter!.createOffer(from(TAG_A, "a-next"))))[1]).toBe("limit_source_unresolved");
    expect(fixture.calls.byRoute["create"]).toBe(creates);
    await expect(adapter!.createOffer(from(TAG_B, "b-1"))).resolves.toMatchObject({ scheme: "exact" });
    await adapter!.close();
    await makeAdapter({ limits: PER_SOURCE });
    expect((await refusal(adapter!.createOffer(from(TAG_A, "a-again"))))[1]).toBe("limit_source_unresolved");
  });

  test("ledger の送信元ごとの占有: `discovered` の注文は、同じ pair の tag がちょうど 1 種類のときだけその送信元に帰属し、曖昧なもの（2 種類・tag なし）は全ての送信元に数える", async () => {
    const { openSubethaExactLedger } = await import("../../src/adapters/inbound/subetha-exact-ledger.js");
    const ledger = await openSubethaExactLedger({ dir: path.join(workDir, "ledger-only") });
    const nowSec = Math.floor(clockMs / 1000);
    const digest = (byte: string) => `0x${byte.repeat(32)}`;
    const requirements = { scheme: "exact", network: NETWORK, asset: ASSET, amount: "2000", payTo: `0x${"11".repeat(20)}`, maxTimeoutSeconds: 150, extra: { name: DOMAIN.name, version: DOMAIN.version } };
    const requested = (id: string, requester: string, tag?: string) => ledger.append(id, "requested", { requesterDigest: digest(requester), resourceDigest: digest("ee"), routeId: ROUTE_ID, amount: "2000", atMs: clockMs, ...(tag === undefined ? {} : { sourceTag: tag }) });
    const discovered = (key: string, requester: string, order: string) =>
      ledger.append(key, "discovered", { pair: { requesterDigest: digest(requester), resourceDigest: digest("ee") }, orderId: digest(order), payTo: requirements.payTo, expiresAt: nowSec + 300, tenant: `/p/${PROVIDER}`, requirements });
    const usage = (tag: string) => ledger.sourceUsage(tag, nowSec, clockMs - 60_000);
    // pair 1: A だけが作成を試み、応答を失い、後で注文が見つかった → A の占有は attempt 1 + 注文 1 = 2。B は 0。
    await requested("att-1", "01", TAG_A);
    expect(usage(TAG_A)).toEqual({ unresolved: 1, unknownCreation: true, recent: 1 });
    await discovered("pair-1", "01", "a1");
    expect(usage(TAG_A).unresolved).toBe(2);
    expect(usage(TAG_B).unresolved).toBe(0);
    // pair 2: A と B の両方が同じ pair を試みた（同じ principal・requestId を別の送信元から）→ 見つかった注文は曖昧 = 両方に数える。
    await requested("att-2", "02", TAG_A);
    await requested("att-3", "02", TAG_B);
    await discovered("pair-2", "02", "a2");
    expect(usage(TAG_A).unresolved).toBe(4);
    expect(usage(TAG_B)).toMatchObject({ unresolved: 2, unknownCreation: true });
    // pair 3: tag の無い行（旧い行）の pair で見つかった注文も、全ての送信元に数える。行の無い pair の注文も同じ。
    await requested("att-4", "03");
    await discovered("pair-3", "03", "a3");
    await discovered("pair-4", "04", "a4");
    expect(usage(TAG_A).unresolved).toBe(6);
    expect(usage(TAG_B).unresolved).toBe(4);
    expect(usage("cccccccccccccccc")).toEqual({ unresolved: 3, unknownCreation: false, recent: 0 });
    // 全体の数は今までの定義のまま（attempt 4 + 結び付かない注文 4）。再起動の後も同じ。
    expect(ledger.unresolvedCount(nowSec)).toBe(8);
    await ledger.close();
    const reopened = await openSubethaExactLedger({ dir: path.join(workDir, "ledger-only") });
    expect(reopened.sourceUsage(TAG_A, nowSec, clockMs - 60_000).unresolved).toBe(6);
    // 注文の期限 + 猶予の後: 見つかった注文は外れ、結果の分からない attempt は残る。
    expect(reopened.sourceUsage(TAG_B, nowSec + 361, clockMs).unresolved).toBe(1);
    await reopened.close();
  });

  test("`unansweredVerifyIsUnknown: true`: quote の入口の offer でも、答えでない verify は例外（core が unknown と記録）。200 の isValid:false だけが拒否", async () => {
    await makeAdapter({ unansweredVerifyIsUnknown: true });
    const legacy = await adapter!.createOffer(request("q-1"));
    const credential = await credentialFor(legacy);
    const json = { "content-type": "application/json" };
    for (const raw of [{ status: 500, headers: json, body: "{}" }, { status: 200, headers: json, body: "{}" }, { status: 200, headers: json, body: JSON.stringify({ isValid: "false" }) }]) {
      fixture.setMode("verify", "raw", raw);
      await expect(adapter!.verify(legacy, credential), raw.body).rejects.toThrow("verify unanswered");
    }
    // 時間切れ（verify の期限 2 秒を超える応答）も答えではない。
    fixture.setMode("verify", "slow:2600");
    await expect(adapter!.verify(legacy, credential)).rejects.toThrow("verify unanswered");
    fixture.setMode("verify", "raw", { status: 200, headers: json, body: JSON.stringify({ isValid: false, invalidReason: "insufficient_funds" }) });
    await expect(adapter!.verify(legacy, credential)).resolves.toMatchObject({ isValid: false });
    fixture.setMode("verify", "ok");
    await expect(adapter!.verify(legacy, credential)).resolves.toMatchObject({ isValid: true });
  });
});
