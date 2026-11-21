/**
 * 標準の x402 クライアント用の入口の core（`docs/x402-standard-entry-design.md` §4〜§7。実装レビューが求めた安全側の分岐）。
 * 合成 rail（鍵も署名も送金もない）で、wire の試験が届かない分岐を確かめる: 期限を過ぎた同じ credential の再送、結び付け後の早い拒否の記録、
 * 曖昧な `payTo`、壊れた結び付けの行、別の principal、quote 入口の注文を標準入口に持ち込む、署名が本物でない／受け付けられない credential。
 */
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import type { RouterConfig } from "../../src/config.js";
import { createRouterCore, standardCredentialDigest, type RouterCore, type RouterCoreOptions, type StandardPresented } from "../../src/core/orchestrator.js";
import type { CreateOfferRequest, InboundOffer, InboundRail, InboundVerifyResult, PaymentCredential, PreflightResult, SettleResult } from "../../src/ports/inbound.js";
import type { DestinationOffer, OutboundRail, PayResult } from "../../src/ports/outbound.js";

const ROUTE_ID = "md-zusdc-exact";
const NETWORK = "eip155:84532";
const ASSET = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const DEST_ASSET = "0xde57";
const PAYER = `0x${"a1".repeat(20)}`;
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

function config(): RouterConfig {
  return {
    approvalTtlMs: 60_000,
    routes: {
      [ROUTE_ID]: {
        routeId: ROUTE_ID,
        canonicalPath: `/v1/routes/${ROUTE_ID}/resource`,
        sourceRail: "subetha-exact",
        source: { amount: "2000", asset: ASSET, decimals: 6, network: NETWORK },
        destination: { scheme: "exact", network: NETWORK, asset: DEST_ASSET, payTo: "0xprovidera" },
      },
    },
    budget: { maxPurchases: 8, buckets: [{ network: NETWORK, asset: ASSET, maxTotal: "100000", maxPerPurchase: "5000" }, { network: NETWORK, asset: DEST_ASSET, maxTotal: "100000", maxPerPurchase: "5000" }] },
  } as unknown as RouterConfig;
}

class Rail implements InboundRail {
  verifyCalls = 0;
  settleCalls = 0;
  createCalls = 0;
  sourceTags: (string | undefined)[] = [];
  settleResult: SettleResult = { outcome: "settled", txRef: "src-tx-1", eventId: "0xnonce" };
  genuine = true;
  verifyResult: InboundVerifyResult | "throw" = { isValid: true };
  fixedPayTo: string | undefined;
  #issued = 0;
  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.createCalls += 1;
    this.sourceTags.push(request.requester?.sourceTag);
    // 発行の途中に時間を空ける（同時の発行の試験で、予約が await をまたいで効くことを見る）。
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.#issued += 1;
    return {
      scheme: "exact",
      network: request.network,
      asset: request.asset,
      amount: request.amount,
      payTo: this.fixedPayTo ?? `0x${String(this.#issued).padStart(40, "0")}`,
      maxTimeoutSeconds: 150,
      extra: { challengeNonce: `0x${String(this.#issued).padStart(64, "0")}`, expiresAt: Math.floor(request.nowMs / 1000) + 300, routeBinding: request.routeBinding, name: "zERC20 USD Coin", version: "1", fundsMoveOnCredential: false, ...(request.entry === "x402" ? { entry: "x402" } : {}) },
    };
  }
  preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
    if (offer.extra.expiresAt * 1000 <= nowMs) return { ok: false, reason: "offer_expired" };
    const authorization = (credential.payload as unknown as { authorization?: { validBefore: string } }).authorization;
    if (authorization !== undefined && Number(authorization.validBefore) > offer.extra.expiresAt) return { ok: false, reason: "credential_mismatch" };
    return { ok: true };
  }
  async checkSignature(): Promise<boolean> {
    return this.genuine;
  }
  async verify(): Promise<InboundVerifyResult> {
    this.verifyCalls += 1;
    if (this.verifyResult === "throw") throw new Error("unanswered");
    return this.verifyResult;
  }
  async settle(): Promise<SettleResult> {
    this.settleCalls += 1;
    return this.settleResult;
  }
  settleWindowOf(offer: InboundOffer): number | undefined {
    return offer.extra.expiresAt;
  }
}
class Outbound implements OutboundRail {
  payCalls = 0;
  offer: DestinationOffer = { scheme: "exact", network: NETWORK, asset: DEST_ASSET, amount: "900", payTo: "0xprovidera" };
  async readChallenge(): Promise<readonly DestinationOffer[]> {
    return [this.offer];
  }
  async pay(): Promise<PayResult> {
    this.payCalls += 1;
    return { outcome: "paid", body: { data: 1 }, contentType: "application/json", txRef: "dst-tx-1" };
  }
}

let workDir: string;
let journalPath: string;
let rail: Rail;
let outbound: Outbound;
let clockMs: number;
let ids = 0;
const opened: RouterCore[] = [];
async function boot(overrides: Partial<RouterCoreOptions> = {}): Promise<RouterCore> {
  const core = await createRouterCore({ journalPath, config: config(), inbound: rail, outbound, now: () => clockMs, nextPaymentId: () => `pay-${(ids += 1)}`, ...overrides });
  opened.push(core);
  return core;
}
const rows = async () => (await readFile(journalPath, "utf8").catch(() => "")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { seq: number; paymentId: string; event: string; patch: Record<string, unknown> });
const eventsOf = async (paymentId: string) => (await rows()).filter((r) => r.paymentId === paymentId).map((r) => r.event);
function presentedFor(offer: InboundOffer, over: Partial<StandardPresented["authorization"]> & { signature?: string } = {}): StandardPresented {
  const { signature, ...authorization } = over;
  return {
    accepted: { scheme: offer.scheme, network: offer.network, asset: offer.asset, amount: offer.amount, payTo: offer.payTo, maxTimeoutSeconds: offer.maxTimeoutSeconds, extra: { name: offer.extra["name"], version: offer.extra["version"] } },
    authorization: { from: PAYER, to: offer.payTo, value: offer.amount, validAfter: "0", validBefore: String(Math.floor(clockMs / 1000) + 150), nonce: `0x${"5a".repeat(32)}`, ...authorization },
    signature: signature ?? `0x${"ab".repeat(65)}`,
  };
}
async function challenge(core: RouterCore, principalId = "alice") {
  const outcome = await core.quoteStandard({ principalId, routeId: ROUTE_ID });
  if (!outcome.ok) throw new Error(`quoteStandard failed: ${outcome.code}`);
  return outcome;
}
const buy = (core: RouterCore, presented: StandardPresented, principalId = "alice") => core.purchaseStandard({ principalId, routeId: ROUTE_ID, presented });

beforeEach(async () => {
  await mkdir(runtimeRoot, { recursive: true });
  workDir = await mkdtemp(path.join(runtimeRoot, "x402e-core-"));
  journalPath = path.join(workDir, "journal.ndjson");
  rail = new Rail();
  outbound = new Outbound();
  clockMs = 1_800_000_000_000;
  ids = 0;
});
afterEach(async () => {
  for (const core of opened.splice(0)) await core.close().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
});

test("通し: 結び付けの行が verify の前。settle 済み・配達済みの購入には開示を出さない。同じ credential の再送は settle を増やさない", async () => {
  const core = await boot();
  const quote = await challenge(core);
  const presented = presentedFor(quote.offer);
  const first = await buy(core, presented);
  expect(first).toMatchObject({ kind: "outcome", outcome: { status: "delivered", paymentId: quote.paymentId }, payer: PAYER });
  expect((await eventsOf(quote.paymentId)).slice(0, 3)).toEqual(["created", "source_credential_bound", "source_pending"]);
  expect(core.status(quote.paymentId, "alice")!.source).not.toHaveProperty("mayStillSettleUntil");
  // 大小と数の表記が違うだけの同じ credential。
  const same: StandardPresented = { ...presented, authorization: { ...presented.authorization, from: PAYER.toUpperCase().replace("0X", "0x"), value: "002000" }, signature: presented.signature.toUpperCase().replace("0X", "0x") };
  expect(standardCredentialDigest(same)).toBe(standardCredentialDigest(presented));
  expect(await buy(core, same)).toMatchObject({ kind: "outcome", outcome: { status: "delivered" } });
  expect([rail.verifyCalls, rail.settleCalls, outbound.payCalls]).toEqual([1, 1, 1]);
});

test("期限を過ぎた同じ credential の再送は、時刻の検査より先に記録を返す（verify を呼び直さない）。違う credential は conflict", async () => {
  const core = await boot();
  const quote = await challenge(core);
  rail.verifyResult = { isValid: false };
  const presented = presentedFor(quote.offer);
  const first = await buy(core, presented);
  expect(first).toMatchObject({ kind: "outcome", outcome: { status: "awaiting_payment", mayStillSettleUntil: Number(presented.authorization.validBefore) } });
  // 注文の期限も承認の期限も過ぎた後。
  clockMs += 3_600_000;
  rail.verifyResult = { isValid: true };
  expect(await buy(core, presented)).toMatchObject({ kind: "outcome", outcome: { status: "awaiting_payment", paymentId: quote.paymentId } });
  expect(await buy(core, presentedFor(quote.offer, { nonce: `0x${"6b".repeat(32)}` }))).toEqual({ kind: "conflict", paymentId: quote.paymentId });
  expect([rail.verifyCalls, rail.settleCalls]).toEqual([1, 0]);
});

test("結び付けた後に行を書かずに戻る拒否は source_failed not_sent として残り、再送は実行をやり直さない（verify 0）。開示は結び付いた credential の validBefore", async () => {
  // 結び付けの直後に時計を進め、承認の期限を過ぎさせる（結び付けの前の検査は通っている）。
  const core = await boot({ hooksForTest: { stop: async (point) => { if (point === "after_credential_bound") clockMs += 120_000; } } });
  const quote = await challenge(core);
  const presented = presentedFor(quote.offer);
  const first = await buy(core, presented);
  expect(first).toMatchObject({ kind: "outcome", outcome: { status: "awaiting_payment", paymentId: quote.paymentId, terminalReason: "approval_expired", mayStillSettleUntil: Number(presented.authorization.validBefore) } });
  expect(await eventsOf(quote.paymentId)).toEqual(["created", "source_credential_bound", "source_failed"]);
  expect((await rows()).at(-1)!.patch).toEqual({ settleStarted: false, outcome: "not_sent", reason: "approval_expired" });
  // 時計を戻しても（期限の中に戻っても）実行は始まらない。再起動の後も同じ。
  clockMs -= 120_000;
  expect(await buy(core, presented)).toMatchObject({ kind: "outcome", outcome: { status: "awaiting_payment", terminalReason: "approval_expired" } });
  await core.close();
  const restarted = await boot();
  expect(await buy(restarted, presented)).toMatchObject({ kind: "outcome", outcome: { status: "awaiting_payment", terminalReason: "approval_expired" } });
  expect(restarted.status(quote.paymentId, "alice")!.source).toMatchObject({ mayStillSettleUntil: Number(presented.authorization.validBefore) });
  expect([rail.verifyCalls, rail.settleCalls, outbound.payCalls]).toEqual([0, 0, 0]);
});

test("最初の credential の拒否は結び付けない: 署名が本物でなければ期限を示さず、本物で受け付けられないものは presentedValidBefore を示す。後から正しい credential は買える", async () => {
  const core = await boot();
  const quote = await challenge(core);
  rail.genuine = false;
  expect(await buy(core, presentedFor(quote.offer))).toEqual({ kind: "not_accepted", paymentId: quote.paymentId });
  rail.genuine = true;
  const late = Number(quote.offer.extra.expiresAt) + 1;
  expect(await buy(core, presentedFor(quote.offer, { validBefore: String(late) }))).toEqual({ kind: "not_accepted", paymentId: quote.paymentId, presentedValidBefore: late });
  const tampered = presentedFor(quote.offer);
  expect(await buy(core, { ...tampered, accepted: { ...tampered.accepted, amount: "1" } })).toMatchObject({ kind: "not_accepted", presentedValidBefore: expect.any(Number) });
  expect(await eventsOf(quote.paymentId)).toEqual(["created"]);
  expect(rail.verifyCalls).toBe(0);
  // 結び付けの前の開示は注文の期限。
  expect(core.status(quote.paymentId, "alice")!.source).toMatchObject({ mayStillSettleUntil: quote.offer.extra.expiresAt });
  expect(await buy(core, presentedFor(quote.offer))).toMatchObject({ kind: "outcome", outcome: { status: "delivered" } });
});

test("verify が答えない（例外）と unknown、はっきり拒むと verify_failed。どちらも結び付きの validBefore を開示する", async () => {
  const core = await boot();
  rail.verifyResult = "throw";
  const q1 = await challenge(core);
  const p1 = presentedFor(q1.offer);
  expect(await buy(core, p1)).toMatchObject({ kind: "outcome", outcome: { status: "unknown", terminalReason: "source_verify_unavailable", mayStillSettleUntil: Number(p1.authorization.validBefore) } });
  rail.verifyResult = { isValid: false };
  const q2 = await challenge(core);
  expect(await buy(core, presentedFor(q2.offer))).toMatchObject({ kind: "outcome", outcome: { status: "awaiting_payment", code: "verify_failed" } });
  expect(rail.settleCalls).toBe(0);
});

test("引けないものは全て not_found で、rail を呼ばない: 別の principal、知らない payTo、quote 入口の注文、曖昧な payTo（2 つの quote が同じ payTo）", async () => {
  const core = await boot();
  const quote = await challenge(core);
  const presented = presentedFor(quote.offer);
  expect(await buy(core, presented, "bob")).toEqual({ kind: "not_found" });
  expect(await buy(core, presentedFor({ ...quote.offer, payTo: `0x${"ff".repeat(20)}` }))).toEqual({ kind: "not_found" });
  // quote 入口の注文の payTo を標準入口に持ち込む。
  const legacy = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
  if (!legacy.ok) throw new Error("quote failed");
  expect(await buy(core, presentedFor(legacy.source.offer))).toEqual({ kind: "not_found" });
  // 逆: 標準入口の quote を quote 入口の購入に持ち込む（R3・MCP の経路）。
  const crossed = await core.purchase({ principalId: "alice", requestId: "x", quoteId: quote.quoteId, routeId: ROUTE_ID, approval: quote.quoteId, credential: { x402Version: 2, accepted: quote.offer, payload: { challengeNonce: quote.offer.extra.challengeNonce } } });
  expect(crossed).toMatchObject({ status: "rejected", code: "unknown_quote" });
  expect(core.offerFor(quote.quoteId, "alice", ROUTE_ID)).toBeUndefined();
  expect(core.disclosureFor(quote.quoteId, "alice", ROUTE_ID)).toBeUndefined();
  // `x402e:` で始まる requestId は quote 入口で今までどおり使える（接頭辞では拒まない）。
  expect((await core.quote({ principalId: "alice", requestId: "x402e:mine", routeId: ROUTE_ID })).ok).toBe(true);
  // 曖昧な payTo: 2 つの標準 quote が同じ payTo を持つと、どちらも引かない（再起動の後も）。
  rail.fixedPayTo = `0x${"cc".repeat(20)}`;
  const a = await challenge(core);
  const b = await challenge(core);
  expect(await buy(core, presentedFor(a.offer))).toEqual({ kind: "not_found" });
  expect(await buy(core, presentedFor(b.offer))).toEqual({ kind: "not_found" });
  await core.close();
  const restarted = await boot();
  expect(await buy(restarted, presentedFor(a.offer))).toEqual({ kind: "not_found" });
  // 曖昧でない最初の quote は再起動の後も引ける。
  expect(await buy(restarted, presented)).toMatchObject({ kind: "outcome", outcome: { status: "delivered" } });
  expect([rail.verifyCalls, rail.settleCalls]).toEqual([1, 1]);
});

test("壊れた結び付けの行（digest・payer・validBefore のどれか）は「結び付きあり・照合不能」: どの credential も conflict、実行しない。settle 済みなら開示も出さない", async () => {
  const presentedOf = (offer: InboundOffer) => presentedFor(offer);
  const good = (offer: InboundOffer) => ({ digest: standardCredentialDigest(presentedOf(offer)), payer: PAYER, validBefore: Number(presentedOf(offer).authorization.validBefore) });
  const broken: ((offer: InboundOffer) => Record<string, unknown>)[] = [
    (o) => ({ ...good(o), digest: "zz" }),
    (o) => ({ ...good(o), payer: "nope" }),
    (o) => ({ ...good(o), validBefore: "soon" }),
    (o) => ({ digest: good(o).digest }),
  ];
  for (const [index, make] of broken.entries()) {
    const core = await boot();
    const quote = await challenge(core);
    await core.close();
    const seq = (await rows()).length + 1;
    await appendFile(journalPath, `${JSON.stringify({ seq, at: new Date().toISOString(), paymentId: quote.paymentId, event: "source_credential_bound", patch: make(quote.offer) })}\n`);
    const restarted = await boot();
    expect([index, await buy(restarted, presentedOf(quote.offer))]).toEqual([index, { kind: "conflict", paymentId: quote.paymentId }]);
    // 照合できない結び付きでも、結び付けの前の保守的な開示（注文の期限）は残る。
    expect(restarted.status(quote.paymentId, "alice")!.source).toMatchObject({ mayStillSettleUntil: quote.offer.extra.expiresAt });
    await restarted.close();
  }
  expect([rail.verifyCalls, rail.settleCalls]).toEqual([0, 0]);
  // 壊れた結び付きの後に、正確な値を持つ失敗の行と settle の行が続いた場合: settle 済みなので、どの値も開示しない（fallback の順序）。
  {
    const core = await boot();
    const quote = await challenge(core);
    await core.close();
    let seq = (await rows()).length;
    const line = (event: string, patch: Record<string, unknown>) => appendFile(journalPath, `${JSON.stringify({ seq: (seq += 1), at: new Date().toISOString(), paymentId: quote.paymentId, event, patch })}\n`);
    await line("source_credential_bound", { digest: "zz" });
    await line("source_failed", { outcome: "rejected", reason: "verify_failed", mayStillSettleUntil: Number(quote.offer.extra.expiresAt) - 5 });
    const unsettled = await boot();
    expect(unsettled.status(quote.paymentId, "alice")!.source).toMatchObject({ mayStillSettleUntil: Number(quote.offer.extra.expiresAt) - 5 });
    await unsettled.close();
    await line("source_settled", { txRef: "src-tx-9", eventId: "0xnonce" });
    const settled = await boot();
    expect(settled.status(quote.paymentId, "alice")!.source).toMatchObject({ txRef: "src-tx-9" });
    expect(settled.status(quote.paymentId, "alice")!.source).not.toHaveProperty("mayStillSettleUntil");
    expect(await buy(settled, presentedOf(quote.offer))).toEqual({ kind: "conflict", paymentId: quote.paymentId });
    await settled.close();
  }
  // 正しい行は再生の後も一致する（同じ credential は続きを実行、2 つ目の行は上書きしない）。
  const core = await boot();
  const quote = await challenge(core);
  await core.close();
  const seq = (await rows()).length + 1;
  await appendFile(journalPath, `${JSON.stringify({ seq, at: new Date().toISOString(), paymentId: quote.paymentId, event: "source_credential_bound", patch: good(quote.offer) })}\n`);
  await appendFile(journalPath, `${JSON.stringify({ seq: seq + 1, at: new Date().toISOString(), paymentId: quote.paymentId, event: "source_credential_bound", patch: { ...good(quote.offer), digest: "0".repeat(64) } })}\n`);
  const restarted = await boot();
  expect(await buy(restarted, presentedOf(quote.offer))).toMatchObject({ kind: "outcome", outcome: { status: "delivered" } });
  expect(restarted.status(quote.paymentId, "alice")!.source).not.toHaveProperty("mayStillSettleUntil");
});

test("対象外: subetha-exact でない route、checkSignature を持たない rail は標準入口を使えない（unknown_route。注文を作らない）", async () => {
  const plain = await boot({ config: { ...config(), routes: { [ROUTE_ID]: { ...config().routes[ROUTE_ID]!, sourceRail: undefined } } } as unknown as RouterConfig });
  expect(await plain.quoteStandard({ principalId: "alice", routeId: ROUTE_ID })).toEqual({ ok: false, code: "unknown_route" });
  expect(await plain.quoteStandard({ principalId: "alice", routeId: "nope" })).toEqual({ ok: false, code: "unknown_route" });
  await plain.close();
  const noCheck: InboundRail = { createOffer: (r) => rail.createOffer(r), preflight: (o, c, n) => rail.preflight(o, c, n), verify: () => rail.verify(), settle: () => rail.settle() };
  const core = await boot({ inbound: noCheck });
  expect(await core.quoteStandard({ principalId: "alice", routeId: ROUTE_ID })).toEqual({ ok: false, code: "unknown_route" });
  expect(await rows()).toEqual([]);
});

/* ------------------------------------------------------------------ offer の上限（`docs/hosted-exact-enable-design.md` §2） */

function configWithCap(maxCommitted: number): RouterConfig {
  const base = config() as unknown as { routes: Record<string, Record<string, unknown>> };
  return { ...base, routes: { [ROUTE_ID]: { ...base.routes[ROUTE_ID]!, offerCap: { maxCommitted } } } } as unknown as RouterConfig;
}
const CAP_REACHED = { ok: false, code: "source_offer_unavailable", reason: "offer_cap_reached" };
const tryChallenge = (core: RouterCore) => core.quoteStandard({ principalId: "alice", routeId: ROUTE_ID });

test("offer の上限: 未払いの offer は一時的に数に入り、承認の期限を過ぎると外れる。上限 0 は何も出さない（rail を呼ばない）。上限の無い route は数えない", async () => {
  const core = await boot({ config: configWithCap(2) });
  expect((await tryChallenge(core)).ok).toBe(true);
  expect((await tryChallenge(core)).ok).toBe(true);
  expect(await tryChallenge(core)).toEqual(CAP_REACHED);
  // quote の入口も同じ数を共有する。既存の quote の再取得は対象外。
  expect(await core.quote({ principalId: "alice", requestId: "req-new", routeId: ROUTE_ID })).toEqual(CAP_REACHED);
  expect(rail.createCalls).toBe(2);
  // 承認の期限（60 秒）を過ぎた: Router はその offer で settle を始めないので数から外れる（未払いの証明ではない）。
  clockMs += 61_000;
  expect((await tryChallenge(core)).ok).toBe(true);
  await core.close();
  const zero = await boot({ config: configWithCap(0), journalPath: path.join(workDir, "zero.ndjson") });
  const before = rail.createCalls;
  expect(await tryChallenge(zero)).toEqual(CAP_REACHED);
  expect(await zero.quote({ principalId: "alice", requestId: "r", routeId: ROUTE_ID })).toEqual(CAP_REACHED);
  expect(rail.createCalls).toBe(before);
  await zero.close();
  const unlimited = await boot({ journalPath: path.join(workDir, "unlimited.ndjson") });
  for (let index = 0; index < 5; index += 1) expect((await tryChallenge(unlimited)).ok).toBe(true);
});

test("offer の上限: 残り 1 枠に、標準入口と quote の入口が同時に来ても出る offer は 1 つ。既存の quote の再取得は上限に達していても同じ文書を返す", async () => {
  const core = await boot({ config: configWithCap(1) });
  const results = await Promise.all([tryChallenge(core), core.quote({ principalId: "alice", requestId: "req-a", routeId: ROUTE_ID }), tryChallenge(core), core.quote({ principalId: "bob", requestId: "req-b", routeId: ROUTE_ID })]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toEqual([CAP_REACHED, CAP_REACHED, CAP_REACHED]);
  expect(rail.createCalls).toBe(1);
  // 通ったのが quote の入口なら、同じ requestId の再取得は同じ文書（新しい offer ではない）。
  const winner = results[1]!;
  if (winner.ok) {
    const again = await core.quote({ principalId: "alice", requestId: "req-a", routeId: ROUTE_ID });
    expect(again).toMatchObject({ ok: true, quoteId: winner.quoteId });
    expect(rail.createCalls).toBe(1);
  }
});

test("offer の上限の表: delivered・unknown・settle の後の拒否は確定して数に入る（時間が経っても外れない）。settle の前に終わったものだけ外れる。再起動の後も同じ数", async () => {
  // (1) delivered は確定。
  let core = await boot({ config: configWithCap(1) });
  let quote = await challenge(core);
  expect(await buy(core, presentedFor(quote.offer))).toMatchObject({ kind: "outcome", outcome: { status: "delivered" } });
  clockMs += 3_600_000;
  expect(await tryChallenge(core)).toEqual(CAP_REACHED);
  await core.close();
  core = await boot({ config: configWithCap(1) });
  expect(await tryChallenge(core)).toEqual(CAP_REACHED);
  await core.close();

  // (2) verify が答えない → unknown は確定（分からなければ外さない）。
  journalPath = path.join(workDir, "unknown.ndjson");
  core = await boot({ config: configWithCap(1) });
  rail.verifyResult = "throw";
  quote = await challenge(core);
  expect(await buy(core, presentedFor(quote.offer))).toMatchObject({ kind: "outcome", outcome: { status: "unknown" } });
  clockMs += 3_600_000;
  expect(await tryChallenge(core)).toEqual(CAP_REACHED);
  await core.close();

  // (3) verify の明示の拒否 = settle の前に終わった（`settleStarted: false`）→ 外れる。再起動の後も外れたまま。
  journalPath = path.join(workDir, "verify.ndjson");
  core = await boot({ config: configWithCap(1) });
  rail.verifyResult = { isValid: false };
  quote = await challenge(core);
  expect(await buy(core, presentedFor(quote.offer))).toMatchObject({ kind: "outcome", outcome: { status: "awaiting_payment", code: "verify_failed" } });
  expect((await rows()).at(-1)!.patch).toMatchObject({ settleStarted: false, reason: "verify_failed" });
  await core.close();
  core = await boot({ config: configWithCap(1) });
  rail.verifyResult = { isValid: true };
  quote = await challenge(core);

  // (4) settle を呼んだ後の拒否は、理由が「settle の前」のものと同じ文字列でも外れない（行に印が無い）。
  rail.settleResult = { outcome: "rejected", reason: "approval_expired" };
  const refused = await buy(core, presentedFor(quote.offer));
  expect(refused).toMatchObject({ kind: "outcome", outcome: { status: "awaiting_payment" } });
  expect(rail.settleCalls).toBeGreaterThan(0);
  const last = (await rows()).at(-1)!;
  expect([last.event, last.patch["settleStarted"]]).toEqual(["source_failed", undefined]);
  clockMs += 3_600_000;
  expect(await tryChallenge(core)).toEqual(CAP_REACHED);
  await core.close();
  core = await boot({ config: configWithCap(1) });
  expect(await tryChallenge(core)).toEqual(CAP_REACHED);
});

test("offer の上限: 発行済みの offer を全部買っても上限を超えない。印の無い旧い source_failed の行は数に残る。送信元の tag が rail に渡る", async () => {
  const core = await boot({ config: configWithCap(3) });
  const offers = [await challenge(core), await challenge(core), await challenge(core)];
  expect(await tryChallenge(core)).toEqual(CAP_REACHED);
  const outcomes = await Promise.all(offers.map((o, index) => buy(core, presentedFor(o.offer, { nonce: `0x${String(index + 1).padStart(64, "0")}` }))));
  expect(outcomes.map((o) => (o.kind === "outcome" ? o.outcome.status : o.kind))).toEqual(["delivered", "delivered", "delivered"]);
  expect([rail.settleCalls, outbound.payCalls]).toEqual([3, 3]);
  expect(await tryChallenge(core)).toEqual(CAP_REACHED);
  // 送信元: 標準入口は source（無ければ principal）から tag を作る。同じ送信元は同じ tag、別の送信元は別の tag。
  expect(new Set(rail.sourceTags).size).toBe(1);
  expect(rail.sourceTags[0]).toMatch(/^[0-9a-f]{16}$/);
  await core.close();

  journalPath = path.join(workDir, "legacy-row.ndjson");
  const next = await boot({ config: configWithCap(1) });
  rail.sourceTags = [];
  const a = await next.quoteStandard({ principalId: "alice", routeId: ROUTE_ID, source: "fwd:203.0.113.7" });
  if (!a.ok) throw new Error("quote failed");
  await next.close();
  // 旧い形の行（印なし）を足す: settle の前か後か分からないので、数に残る。
  const seq = (await rows()).length + 1;
  await appendFile(journalPath, `${JSON.stringify({ seq, at: new Date().toISOString(), paymentId: a.paymentId, event: "source_failed", patch: { outcome: "not_sent", reason: "approval_expired" } })}\n`);
  const restarted = await boot({ config: configWithCap(1) });
  clockMs += 3_600_000;
  expect(await restarted.quoteStandard({ principalId: "alice", routeId: ROUTE_ID, source: "fwd:198.51.100.9" })).toEqual(CAP_REACHED);
  expect(rail.sourceTags).toHaveLength(1);
});

test("offer の上限: 購入が実行の途中（`created` のまま上流の照合を待っている）なら、承認の期限を過ぎても枠は空かない（後で unknown になっても二重に数えない）", async () => {
  const core = await boot({ config: configWithCap(1) });
  const quote = await challenge(core);
  // 上流の読み直し（購入の最初の await）を止める。quote のときの読み取りは通す。
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const original = outbound.readChallenge.bind(outbound);
  let reads = 0;
  outbound.readChallenge = async () => {
    reads += 1;
    if (reads === 1) await held;
    return original();
  };
  rail.verifyResult = "throw";
  const purchase = buy(core, presentedFor(quote.offer));
  while (reads === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  // 承認の期限を過ぎた。intent はまだ `created` だが、購入は進行中。
  clockMs += 61_000;
  expect(await tryChallenge(core)).toEqual(CAP_REACHED);
  release!();
  // 購入は verify まで進み、verify が答えないので unknown（確定して数に入る）。
  expect(await purchase).toMatchObject({ kind: "outcome", outcome: { status: "unknown" } });
  expect(await tryChallenge(core)).toEqual(CAP_REACHED);
  expect(rail.createCalls).toBe(1);
});
