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
  genuine = true;
  verifyResult: InboundVerifyResult | "throw" = { isValid: true };
  fixedPayTo: string | undefined;
  #issued = 0;
  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
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
    return { outcome: "settled", txRef: "src-tx-1", eventId: "0xnonce" };
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
  expect((await rows()).at(-1)!.patch).toEqual({ outcome: "not_sent", reason: "approval_expired" });
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
