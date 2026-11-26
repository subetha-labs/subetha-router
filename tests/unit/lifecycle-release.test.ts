/**
 * 受信レールの release／complete を持つ rail のライフサイクルと復旧（`docs/subetha-exact-inbound-design.md` §2・§4.3〜§4.6・§6、タスク T-2a）。
 * **ライフサイクルと復旧だけ**（開示の表と閉じた quote は T-2b）。鍵も署名も送金もない同一プロセンの合成 rail。
 *
 * - 行の順序: created → source_pending → source_settled → source_released → destination_pending → delivered → source_completed
 * - release／complete を持たない rail と wrapper の `none` は既存どおり（行が増えない）
 * - 契約外の値・throw は `unknown`、refused／unknown → `paid_undelivered` と上流 0
 * - complete の行（恒久／一時）、`unknown` の終端では complete 無し
 * - 同じ quote の並行・連続の purchase で settle／release／complete が各 1 回（AC-2 (h)）
 * - 再起動の表（§6 の全行。`destination_submitted` は行を直接書く）、起動時の掃き出しと `close()` の待ち、行なしなら掃き出し無し
 * - 停止点、報告の行の append の失敗の注入（2 つの event）で応答が変わらない、route を消した後の起動時の complete（`ownsOffer`）
 * - `quoteLocked` の `InboundOfferError` → `QuoteOutcome`
 */
import { mkdir, mkdtemp, open, readFile, rm, appendFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { RouterConfig } from "../../src/config.js";
import { stableJson } from "../../src/core/intent.js";
import { createRouterCore, type CoreStopPoint, type RouterCore, type RouterCoreOptions } from "../../src/core/orchestrator.js";
import { inboundByRoute } from "../../src/main.js";
import {
  InboundOfferError,
  type CompleteResult,
  type CreateOfferRequest,
  type InboundCallContext,
  type InboundOffer,
  type InboundRail,
  type PaymentCredential,
  type PreflightResult,
  type ReleaseResult,
  type SettleResult,
} from "../../src/ports/inbound.js";
import type { DestinationOffer, OutboundRail, PayRequest, PayResult } from "../../src/ports/outbound.js";

const ROUTE_ID = "md-zusdc-exact";
const SOURCE_NETWORK = "eip155:84532";
const SOURCE_ASSET = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const DEST_NETWORK = "eip155:84532";
const DEST_ASSET = "0xde57";
const UPSTREAM_BODY = { providerId: "provider-a", market: "ETH", data: { price: "3000" } };
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

function baseConfig(): RouterConfig {
  return {
    approvalTtlMs: 60_000,
    routes: {
      [ROUTE_ID]: {
        routeId: ROUTE_ID,
        canonicalPath: `/v1/routes/${ROUTE_ID}/resource`,
        source: { amount: "2000", asset: SOURCE_ASSET, decimals: 6, network: SOURCE_NETWORK },
        destination: { scheme: "exact", network: DEST_NETWORK, asset: DEST_ASSET, payTo: "0xprovidera" },
      },
    },
    budget: {
      maxPurchases: 8,
      buckets: [
        { network: SOURCE_NETWORK, asset: SOURCE_ASSET, maxTotal: "100000", maxPerPurchase: "5000" },
        { network: DEST_NETWORK, asset: DEST_ASSET, maxTotal: "100000", maxPerPurchase: "5000" },
      ],
    },
  };
}

type ReleaseScript = ReleaseResult | "throw" | "garbage" | { outcome: "released"; deliveryKey: string; txRef: string; eventId: string };
type CompleteScript = CompleteResult | "throw" | "garbage";

/** release／complete を持つ合成受信 rail（`subetha-exact` の core から見た形）。 */
class ReleasingInbound implements InboundRail {
  verifyCalls = 0;
  settleCalls = 0;
  releaseCalls: InboundCallContext[] = [];
  completeCalls: { deliveryKey: string; outcome: "delivered" | "failed"; routeId: string }[] = [];
  settleResult: SettleResult = { outcome: "settled", txRef: "src-tx-1", eventId: "0xnonce" };
  releaseScript: ReleaseScript = { outcome: "released", deliveryKey: "", txRef: "src-tx-1", eventId: "84532:src-tx-1:0" };
  completeScript: CompleteScript = { outcome: "completed" };
  completeDelayMs = 0;
  requesters: CreateOfferRequest["requester"][] = [];
  createImpl?: () => Promise<InboundOffer>;
  #issued = 0;

  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.requesters.push(request.requester);
    if (this.createImpl !== undefined) return this.createImpl();
    this.#issued += 1;
    return {
      scheme: "exact",
      network: request.network,
      asset: request.asset,
      amount: request.amount,
      payTo: `0xburn${this.#issued}`,
      maxTimeoutSeconds: 150,
      extra: { challengeNonce: `0x${String(this.#issued).padStart(64, "0")}`, expiresAt: Math.floor(request.nowMs / 1000) + 120, routeBinding: request.routeBinding, name: "zERC20 USD Coin", version: "1", fundsMoveOnCredential: false },
    };
  }
  preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
    if (credential.payload.challengeNonce !== offer.extra.challengeNonce) return { ok: false, reason: "nonce_mismatch" };
    if (offer.extra.expiresAt * 1000 <= nowMs) return { ok: false, reason: "offer_expired" };
    if (stableJson(credential.accepted) !== stableJson(offer)) return { ok: false, reason: "offer_mismatch" };
    return { ok: true };
  }
  async verify(offer: InboundOffer): Promise<{ isValid: boolean; mayStillSettleUntil?: number }> {
    this.verifyCalls += 1;
    return { isValid: true, mayStillSettleUntil: offer.extra.expiresAt - 1 };
  }
  async settle(): Promise<SettleResult> {
    this.settleCalls += 1;
    return this.settleResult;
  }
  settleWindowOf(offer: InboundOffer): number | undefined {
    return offer.extra.expiresAt;
  }
  ownsOffer(offer: InboundOffer): boolean {
    return offer.scheme === "exact" && offer.network === SOURCE_NETWORK && offer.asset === SOURCE_ASSET;
  }
  async release(offer: InboundOffer, context: InboundCallContext): Promise<ReleaseResult> {
    this.releaseCalls.push(context);
    if (this.releaseScript === "throw") throw new Error("boom");
    if (this.releaseScript === "garbage") return { outcome: "whatever" } as unknown as ReleaseResult;
    const script = this.releaseScript;
    return script.outcome === "released" && script.deliveryKey === "" ? { ...script, deliveryKey: offer.extra.challengeNonce } : script;
  }
  async complete(_offer: InboundOffer, deliveryKey: string, outcome: "delivered" | "failed", context: InboundCallContext): Promise<CompleteResult> {
    this.completeCalls.push({ deliveryKey, outcome, routeId: context.routeId });
    if (this.completeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.completeDelayMs));
    if (this.completeScript === "throw") throw new Error("boom");
    if (this.completeScript === "garbage") return { outcome: "nope" } as unknown as CompleteResult;
    return this.completeScript;
  }
  credentialFor(offer: InboundOffer): PaymentCredential {
    return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce } };
  }
}

/** 既存の rail の形（release・complete・settleWindowOf・ownsOffer を持たない）。 */
function plainRail(rail: ReleasingInbound): InboundRail {
  return {
    createOffer: (request) => rail.createOffer(request),
    preflight: (offer, credential, nowMs) => rail.preflight(offer, credential, nowMs),
    verify: async () => {
      rail.verifyCalls += 1;
      return { isValid: true };
    },
    settle: () => rail.settle(),
  };
}

class SyntheticOutbound implements OutboundRail {
  payCalls = 0;
  readChallengeCalls = 0;
  offer: DestinationOffer = { scheme: "exact", network: DEST_NETWORK, asset: DEST_ASSET, amount: "900", payTo: "0xprovidera" };
  payResult: PayResult = { outcome: "paid", body: UPSTREAM_BODY, contentType: "application/json", txRef: "dst-tx-1" };
  readChallengeImpl?: (call: number) => readonly DestinationOffer[];
  payImpl?: (request: PayRequest) => Promise<PayResult>;
  async readChallenge(): Promise<readonly DestinationOffer[]> {
    this.readChallengeCalls += 1;
    return this.readChallengeImpl?.(this.readChallengeCalls) ?? [this.offer];
  }
  async pay(request: PayRequest): Promise<PayResult> {
    this.payCalls += 1;
    return this.payImpl?.(request) ?? this.payResult;
  }
}

let workDir: string;
let journalPath: string;
let issuedIds = 0;
let inbound: ReleasingInbound;
let outbound: SyntheticOutbound;
const opened: RouterCore[] = [];
const notes: string[] = [];

async function boot(overrides: Partial<RouterCoreOptions> = {}): Promise<RouterCore> {
  const core = await createRouterCore({ journalPath, config: baseConfig(), inbound, outbound, nextPaymentId: () => `pay-${(issuedIds += 1)}`, note: (m) => notes.push(m), ...overrides });
  opened.push(core);
  return core;
}

async function events(): Promise<{ event: string; paymentId: string; patch: Record<string, unknown> }[]> {
  const text = await readFile(journalPath, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { event: string; paymentId: string; patch: Record<string, unknown> });
}
async function eventNames(): Promise<string[]> {
  return (await events()).map((record) => record.event);
}

function purchaseArgs(quote: { quoteId: string; source: { offer: InboundOffer } }, requestId = "req-1") {
  return { principalId: "alice", requestId, quoteId: quote.quoteId, approval: quote.quoteId, credential: inbound.credentialFor(quote.source.offer) };
}

async function quoteOf(core: RouterCore, requestId = "req-1") {
  const quote = await core.quote({ principalId: "alice", requestId, routeId: ROUTE_ID });
  if (!quote.ok) throw new Error(`quote failed: ${quote.code}`);
  return quote;
}

type Hooks = NonNullable<RouterCoreOptions["hooksForTest"]>;

/**
 * 停止点で「プロセスが落ちた」を再現する: journal を閉じ（以後の行を書けない）、hook を失敗させて purchase をそこで終える（以後の遠隔の呼び出しも起きない。
 * `lifecycle.test.ts` の中断の試験と同じ手で、停止点が同期に効く形）。
 */
function crashAt(point: CoreStopPoint, coreRef: { core?: RouterCore }): Hooks {
  return {
    stop: async (at) => {
      if (at === point) {
        void coreRef.core?.close();
        throw new Error("crashed");
      }
    },
  };
}

beforeEach(async () => {
  await mkdir(runtimeRoot, { recursive: true });
  workDir = await mkdtemp(path.join(runtimeRoot, "t2a-release-"));
  journalPath = path.join(workDir, "journal.ndjson");
  issuedIds = 0;
  inbound = new ReleasingInbound();
  outbound = new SyntheticOutbound();
  notes.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const core of opened.splice(0)) await core.close().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
});

describe("行の順序と呼び出し", () => {
  test("delivered: created → source_pending → source_settled → source_released → destination_pending → delivered → source_completed。release は settle の txRef と承認期限を受け、complete は deliveryKey と delivered", async () => {
    const core = await boot();
    const quote = await quoteOf(core);
    const outcome = await core.purchase(purchaseArgs(quote));
    expect(outcome).toMatchObject({ status: "delivered", body: UPSTREAM_BODY });
    expect(await eventNames()).toEqual(["created", "source_pending", "budget_reserved", "source_settled", "source_released", "destination_pending", "delivered", "source_completed"]);
    expect(inbound.releaseCalls).toEqual([{ routeId: ROUTE_ID, deadlineMs: quote.approval.deadlineMs, sourceTxRef: "src-tx-1" }]);
    expect(inbound.completeCalls).toEqual([{ deliveryKey: quote.quoteId, outcome: "delivered", routeId: ROUTE_ID }]);
    const rows = await events();
    expect(rows.find((r) => r.event === "source_released")?.patch).toEqual({ deliveryKey: quote.quoteId, txRef: "src-tx-1", eventId: "84532:src-tx-1:0" });
    expect(rows.find((r) => r.event === "source_completed")?.patch).toEqual({ outcome: "delivered" });
    // `created` の行には rail の settleWindow が写る（この rail だけ）。requester は 3 箇所の 1 つ目（静的）から届く。
    expect((rows[0]!.patch["source"] as Record<string, unknown>)["settleWindow"]).toBe(quote.source.offer.extra.expiresAt);
    expect(inbound.requesters).toEqual([{ principalId: "alice", requestId: "req-1" }]);
    // 射影に release は出ない。
    expect(JSON.stringify(core.status(quote.paymentId, "alice"))).not.toContain("deliveryKey");
  });

  test("release／complete を持たない rail は 1 行も変わらない（既存の順序のまま。settleWindow の欄も無い）", async () => {
    const core = await boot({ inbound: plainRail(inbound) });
    const quote = await quoteOf(core);
    await core.purchase(purchaseArgs(quote));
    expect(await eventNames()).toEqual(["created", "source_pending", "budget_reserved", "source_settled", "destination_pending", "delivered"]);
    expect((await events())[0]!.patch["source"]).not.toHaveProperty("settleWindow");
    expect(inbound.releaseCalls).toHaveLength(0);
    expect(inbound.completeCalls).toHaveLength(0);
  });

  test("wrapper の `none`（下の rail が持たない）も同じ（inboundByRoute 越し）", async () => {
    const wrapped = inboundByRoute(baseConfig().routes, { subetha: plainRail(inbound) });
    expect(typeof wrapped.release).toBe("function");
    const core = await boot({ inbound: wrapped });
    const quote = await quoteOf(core);
    await core.purchase(purchaseArgs(quote));
    expect(await eventNames()).toEqual(["created", "source_pending", "budget_reserved", "source_settled", "destination_pending", "delivered"]);
  });

  test("wrapper は下の rail が持てば転送する（settleWindowOf・release・complete）。束縛の無い offer は verify／settle／release では投げ、complete だけ ownsOffer で届く", async () => {
    const wrapped = inboundByRoute(baseConfig().routes, { subetha: inbound });
    const core = await boot({ inbound: wrapped });
    const quote = await quoteOf(core);
    await core.purchase(purchaseArgs(quote));
    expect(await eventNames()).toContain("source_released");
    expect(inbound.completeCalls).toHaveLength(1);
    const foreign: InboundOffer = { ...quote.source.offer, extra: { ...quote.source.offer.extra, routeBinding: "gone|GET|%2Fx" } };
    const credential = inbound.credentialFor(foreign);
    expect(() => wrapped.verify(foreign, credential)).toThrow(/no inbound rail/);
    expect(() => wrapped.settle(foreign, credential)).toThrow(/no inbound rail/);
    await expect(wrapped.release!(foreign, { routeId: "gone" })).rejects.toThrow(/no inbound rail/);
    expect(() => wrapped.settleWindowOf!(foreign)).toThrow(/no inbound rail/);
    expect(wrapped.ownsOffer!(foreign)).toBe(true);
    await expect(wrapped.complete!(foreign, "k", "failed", { routeId: "gone" })).resolves.toEqual({ outcome: "completed" });
    // ownsOffer が偽なら complete も `none`。
    const alien: InboundOffer = { ...foreign, network: "eip155:1" };
    expect(wrapped.ownsOffer!(alien)).toBe(false);
    await expect(wrapped.complete!(alien, "k", "failed", { routeId: "gone" })).resolves.toEqual({ outcome: "none" });
  });
});

describe("release の失敗", () => {
  test.each<[string, ReleaseScript, string]>([
    ["refused", { outcome: "refused", reason: "source_release_refused" }, "source_release_refused"],
    ["unknown", { outcome: "unknown", reason: "source_release_unknown" }, "source_release_unknown"],
    ["throw", "throw", "source_release_unknown"],
    ["契約外の形", "garbage", "source_release_unknown"],
    ["released だが txRef が settle と違う", { outcome: "released", deliveryKey: "k", txRef: "other", eventId: "84532:other:0" }, "source_release_unknown"],
    ["released だが eventId が空", { outcome: "released", deliveryKey: "k", txRef: "src-tx-1", eventId: "" }, "source_release_unknown"],
  ])("%s → paid_undelivered（not_sent）、上流 0、complete 無し、再提出で同じ終端", async (_name, script, reason) => {
    inbound.releaseScript = script;
    const core = await boot();
    const quote = await quoteOf(core);
    const outcome = await core.purchase(purchaseArgs(quote));
    expect(outcome).toMatchObject({ status: "paid_data_unavailable", terminalReason: reason });
    expect(outbound.payCalls).toBe(0);
    expect(inbound.releaseCalls).toHaveLength(1);
    expect(inbound.completeCalls).toHaveLength(0);
    expect(await eventNames()).toEqual(["created", "source_pending", "budget_reserved", "source_settled", "paid_undelivered"]);
    expect((await events()).at(-1)?.patch).toEqual({ outcome: "not_sent", reason });
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "paid_data_unavailable", terminalReason: reason });
    expect(inbound.releaseCalls).toHaveLength(1);
    expect(inbound.settleCalls).toBe(1);
  });
});

describe("complete", () => {
  test("paid_no_data と dest_failed の終端は failed で報告する。unknown の終端では報告しない", async () => {
    const core = await boot();
    outbound.payResult = { outcome: "paid_no_data", reason: "unsupported_response" };
    const q1 = await quoteOf(core, "r1");
    expect(await core.purchase(purchaseArgs(q1, "r1"))).toMatchObject({ status: "paid_data_unavailable" });
    outbound.payResult = { outcome: "rejected", reason: "destination_rejected" };
    const q2 = await quoteOf(core, "r2");
    expect(await core.purchase(purchaseArgs(q2, "r2"))).toMatchObject({ status: "paid_data_unavailable" });
    outbound.payImpl = async () => {
      throw new Error("pay threw");
    };
    const q3 = await quoteOf(core, "r3");
    expect(await core.purchase(purchaseArgs(q3, "r3"))).toMatchObject({ status: "unknown", terminalReason: "destination_pay_unknown" });
    expect(inbound.completeCalls.map((c) => [c.deliveryKey, c.outcome])).toEqual([[q1.quoteId, "failed"], [q2.quoteId, "failed"]]);
    const rows = await events();
    expect(rows.filter((r) => r.event === "source_completed").map((r) => r.patch)).toEqual([{ outcome: "failed" }, { outcome: "failed" }]);
    expect(rows.filter((r) => r.paymentId === q3.paymentId).map((r) => r.event)).toEqual(["created", "source_pending", "budget_reserved", "source_settled", "source_released", "destination_pending", "unknown"]);
  });

  test.each<[string, CompleteScript, string]>([
    ["一時（unavailable）", { outcome: "unreported", reason: "unavailable" }, "unavailable"],
    ["throw は unavailable", "throw", "unavailable"],
    ["契約外の形は unavailable", "garbage", "unavailable"],
    ["恒久（conflicting_outcome）", { outcome: "unreported", reason: "conflicting_outcome" }, "conflicting_outcome"],
    ["知らない理由は unavailable に丸める", { outcome: "unreported", reason: "https://leak" as never }, "unavailable"],
  ])("%s → source_complete_unreported の行。応答は delivered のまま", async (_name, script, reason) => {
    inbound.completeScript = script;
    const core = await boot();
    const quote = await quoteOf(core);
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "delivered", body: UPSTREAM_BODY });
    expect((await events()).at(-1)).toMatchObject({ event: "source_complete_unreported", patch: { outcome: "delivered", reason } });
    expect(core.status(quote.paymentId, "alice")?.status).toBe("delivered");
  });

  test("再起動の掃き出し: 一時の理由なら 1 回だけ再試行して source_completed、恒久なら呼ばない。完了済みも呼ばない", async () => {
    inbound.completeScript = { outcome: "unreported", reason: "unavailable" };
    const core = await boot();
    const transient = await quoteOf(core, "t");
    await core.purchase(purchaseArgs(transient, "t"));
    inbound.completeScript = { outcome: "unreported", reason: "not_authorized" };
    const permanent = await quoteOf(core, "p");
    await core.purchase(purchaseArgs(permanent, "p"));
    inbound.completeScript = { outcome: "completed" };
    const done = await quoteOf(core, "d");
    await core.purchase(purchaseArgs(done, "d"));
    await core.close();
    inbound.completeCalls.length = 0;
    const restarted = await boot();
    await restarted.close();
    expect(inbound.completeCalls).toEqual([{ deliveryKey: transient.quoteId, outcome: "delivered", routeId: ROUTE_ID }]);
    const rows = await events();
    expect(rows.filter((r) => r.paymentId === transient.paymentId).map((r) => r.event).slice(-2)).toEqual(["source_complete_unreported", "source_completed"]);
    expect(rows.filter((r) => r.paymentId === permanent.paymentId).map((r) => r.event).at(-1)).toBe("source_complete_unreported");
    // もう一度起動しても何も呼ばない（completed が揃った）。
    inbound.completeCalls.length = 0;
    const again = await boot();
    await again.close();
    expect(inbound.completeCalls).toEqual([]);
  });

  test("同じ quote の並行・連続の purchase で settle／release／complete／pay は各 1 回（AC-2 (h)）", async () => {
    const core = await boot();
    const quote = await quoteOf(core);
    const [a, b, c] = await Promise.all([core.purchase(purchaseArgs(quote)), core.purchase(purchaseArgs(quote)), core.purchase(purchaseArgs(quote))]);
    expect([a.status, b.status, c.status]).toContain("delivered");
    await core.purchase(purchaseArgs(quote));
    expect(inbound.settleCalls).toBe(1);
    expect(inbound.releaseCalls).toHaveLength(1);
    expect(inbound.completeCalls).toHaveLength(1);
    expect(outbound.payCalls).toBe(1);
    expect(await eventNames()).toEqual(["created", "source_pending", "budget_reserved", "source_settled", "source_released", "destination_pending", "delivered", "source_completed"]);
  });

  test("route を消した後の起動でも、complete は ownsOffer の rail に届く（wrapper の fallback）", async () => {
    inbound.completeScript = { outcome: "unreported", reason: "unavailable" };
    const core = await boot({ inbound: inboundByRoute(baseConfig().routes, { subetha: inbound }) });
    const quote = await quoteOf(core);
    await core.purchase(purchaseArgs(quote));
    await core.close();
    inbound.completeScript = { outcome: "completed" };
    inbound.completeCalls.length = 0;
    const noRoutes: RouterConfig = { ...baseConfig(), routes: {} };
    const restarted = await boot({ config: noRoutes, inbound: inboundByRoute(noRoutes.routes, { subetha: inbound }) });
    await restarted.close();
    expect(inbound.completeCalls).toEqual([{ deliveryKey: quote.quoteId, outcome: "delivered", routeId: ROUTE_ID }]);
    expect((await events()).at(-1)?.event).toBe("source_completed");
  });
});

describe("再起動の表（§6）", () => {
  test("before_source_settle で落ちる → unknown、settle 0、release 0、complete 0、上流 0", async () => {
    const ref: { core?: RouterCore } = {};
    ref.core = await boot({ hooksForTest: crashAt("before_source_settle", ref) });
    const quote = await quoteOf(ref.core);
    await expect(ref.core.purchase(purchaseArgs(quote))).rejects.toBeTruthy();
    await ref.core.close();
    expect(inbound.settleCalls).toBe(0);
    const restarted = await boot();
    expect(restarted.status(quote.paymentId, "alice")).toMatchObject({ status: "unknown", terminalReason: "interrupted_at_restart" });
    expect(inbound.releaseCalls).toHaveLength(0);
    expect(inbound.completeCalls).toHaveLength(0);
    expect(outbound.payCalls).toBe(0);
  });

  test("after_source_settled で落ちる → paid_undelivered（interrupted_at_restart）、release 0、complete 0、上流 0", async () => {
    const ref: { core?: RouterCore } = {};
    ref.core = await boot({ hooksForTest: crashAt("after_source_settled", ref) });
    const quote = await quoteOf(ref.core);
    await expect(ref.core.purchase(purchaseArgs(quote))).rejects.toBeTruthy();
    await ref.core.close();
    expect(inbound.settleCalls).toBe(1);
    expect(inbound.releaseCalls).toHaveLength(0);
    const restarted = await boot();
    expect(restarted.status(quote.paymentId, "alice")).toMatchObject({ status: "paid_data_unavailable", terminalReason: "interrupted_at_restart" });
    expect(await restarted.purchase(purchaseArgs(quote))).toMatchObject({ status: "paid_data_unavailable", terminalReason: "interrupted_at_restart" });
    expect(inbound.releaseCalls).toHaveLength(0);
    expect(inbound.completeCalls).toHaveLength(0);
    expect(outbound.payCalls).toBe(0);
    expect(inbound.settleCalls).toBe(1);
  });

  test("after_source_released で落ちる → paid_undelivered、起動時に complete(failed) が 1 回、上流 0", async () => {
    const ref: { core?: RouterCore } = {};
    ref.core = await boot({ hooksForTest: crashAt("after_source_released", ref) });
    const quote = await quoteOf(ref.core);
    await expect(ref.core.purchase(purchaseArgs(quote))).rejects.toBeTruthy();
    await ref.core.close();
    expect((await eventNames()).at(-1)).toBe("source_released");
    const restarted = await boot();
    await restarted.close();
    expect(restarted.status(quote.paymentId, "alice")).toMatchObject({ status: "paid_data_unavailable", terminalReason: "interrupted_at_restart" });
    expect(inbound.completeCalls).toEqual([{ deliveryKey: quote.quoteId, outcome: "failed", routeId: ROUTE_ID }]);
    expect(await eventNames()).toEqual(["created", "source_pending", "budget_reserved", "source_settled", "source_released", "paid_undelivered", "source_completed"]);
    expect(outbound.payCalls).toBe(0);
    expect(inbound.releaseCalls).toHaveLength(1);
  });

  test("destination_submitted の行（直接書く）→ 再起動で unknown、complete 無し", async () => {
    const core = await boot();
    const quote = await quoteOf(core);
    outbound.payImpl = async () => {
      // 送出の途中で落ちる: journal を閉じてから失敗させる（`unknown` の行は書けない）。
      await core.close();
      throw new Error("crashed");
    };
    await expect(core.purchase(purchaseArgs(quote))).rejects.toBeTruthy();
    expect((await eventNames()).at(-1)).toBe("destination_pending");
    const seq = (await events()).length + 1;
    await appendFile(journalPath, `${JSON.stringify({ seq, at: new Date().toISOString(), paymentId: quote.paymentId, event: "destination_submitted", patch: {} })}\n`);
    const restarted = await boot();
    await restarted.close();
    expect(restarted.status(quote.paymentId, "alice")).toMatchObject({ status: "unknown", terminalReason: "interrupted_at_restart" });
    expect(inbound.completeCalls).toHaveLength(0);
  });

  test("after_terminal で落ちる（complete の前）→ 終端は変わらず、起動時に同じ outcome で complete。それ以降の起動では呼ばない", async () => {
    const ref: { core?: RouterCore } = {};
    ref.core = await boot({
      hooksForTest: {
        stop: async (at) => {
          // 終端の後・complete の呼び出しの前に落ちる: journal を閉じ、hook 自体も失敗させる（complete は呼ばれない）。
          if (at === "after_terminal") {
            void ref.core?.close();
            throw new Error("crashed");
          }
        },
      },
    });
    const quote = await quoteOf(ref.core);
    const outcome = await ref.core.purchase(purchaseArgs(quote));
    expect(outcome).toMatchObject({ status: "delivered", body: UPSTREAM_BODY });
    expect(inbound.completeCalls).toHaveLength(0);
    await ref.core.close();
    expect((await eventNames()).at(-1)).toBe("delivered");
    const restarted = await boot();
    await restarted.close();
    expect(inbound.completeCalls).toEqual([{ deliveryKey: quote.quoteId, outcome: "delivered", routeId: ROUTE_ID }]);
    expect((await eventNames()).at(-1)).toBe("source_completed");
    expect(restarted.status(quote.paymentId, "alice")?.status).toBe("delivered");
  });
});

describe("掃き出しと close()", () => {
  test("close() は進行中の complete を待ってから journal を閉じる。候補が無ければ何も呼ばない", async () => {
    inbound.completeScript = { outcome: "unreported", reason: "unavailable" };
    const core = await boot();
    const quote = await quoteOf(core);
    await core.purchase(purchaseArgs(quote));
    await core.close();
    inbound.completeScript = { outcome: "completed" };
    inbound.completeDelayMs = 150;
    inbound.completeCalls.length = 0;
    const started = Date.now();
    const restarted = await boot();
    await restarted.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(inbound.completeCalls).toHaveLength(1);
    expect((await eventNames()).at(-1)).toBe("source_completed");
    // 行なし（release の無い既存の形の購入）なら掃き出しの候補にならない。
    inbound.completeCalls.length = 0;
    const plain = await boot({ inbound: plainRail(inbound) });
    const q2 = await quoteOf(plain, "r2");
    await plain.purchase(purchaseArgs(q2, "r2"));
    await plain.close();
    const again = await boot();
    await again.close();
    expect(inbound.completeCalls).toEqual([]);
  });

  test("停止点は 4 つの順で呼ばれる（settle の前・settle の後・release の後・終端の後）", async () => {
    const points: string[] = [];
    const core = await boot({ hooksForTest: { stop: async (at, paymentId) => void points.push(`${at}:${paymentId}`) } });
    const quote = await quoteOf(core);
    await core.purchase(purchaseArgs(quote));
    expect(points).toEqual([`before_source_settle:${quote.paymentId}`, `after_source_settled:${quote.paymentId}`, `after_source_released:${quote.paymentId}`, `after_terminal:${quote.paymentId}`]);
  });
});

describe("報告の行の append の失敗（注入）", () => {
  /** 終端の行の後、complete の報告の行の append だけを失敗させる（FileHandle の appendFile を 1 回だけ落とす）。 */
  async function failNextAppendAt(point: CoreStopPoint): Promise<Hooks> {
    const probe = await open(path.join(workDir, "probe"), "a");
    const proto = Object.getPrototypeOf(probe) as { appendFile: (...args: unknown[]) => Promise<void> };
    await probe.close();
    return {
      stop: async (at) => {
        if (at === point) vi.spyOn(proto, "appendFile").mockImplementationOnce(() => Promise.reject(new Error("EIO")));
      },
    };
  }

  test("source_completed の append が失敗しても応答は delivered のまま（note だけ）。次の起動の掃き出しが再試行して行が付く", async () => {
    const core = await boot({ hooksForTest: await failNextAppendAt("after_terminal") });
    const quote = await quoteOf(core);
    const outcome = await core.purchase(purchaseArgs(quote));
    expect(outcome).toMatchObject({ status: "delivered", body: UPSTREAM_BODY });
    expect(inbound.completeCalls).toHaveLength(1);
    expect((await eventNames()).at(-1)).toBe("delivered");
    expect(notes).toContain(`complete report could not be journaled (paymentId=${quote.paymentId})`);
    await core.close().catch(() => undefined);
    const restarted = await boot();
    await restarted.close();
    expect(inbound.completeCalls).toHaveLength(2);
    expect((await eventNames()).at(-1)).toBe("source_completed");
  });

  test("source_complete_unreported の append が失敗しても応答は変わらない。次の起動で再試行する", async () => {
    inbound.completeScript = { outcome: "unreported", reason: "unavailable" };
    const core = await boot({ hooksForTest: await failNextAppendAt("after_terminal") });
    const quote = await quoteOf(core);
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "delivered", body: UPSTREAM_BODY });
    expect((await eventNames()).at(-1)).toBe("delivered");
    expect(notes).toContain(`complete report could not be journaled (paymentId=${quote.paymentId})`);
    await core.close().catch(() => undefined);
    inbound.completeScript = { outcome: "completed" };
    const restarted = await boot();
    await restarted.close();
    expect(inbound.completeCalls).toHaveLength(2);
    expect((await eventNames()).at(-1)).toBe("source_completed");
  });
});

describe("quote の失敗（InboundOfferError）", () => {
  test("source_offer_unavailable は code・reason・retryAfterMs に写り、journal に行は無い。refused も同じ形。ほかの例外は今までどおり投げる", async () => {
    const core = await boot();
    inbound.createImpl = async () => {
      throw new InboundOfferError("source_offer_unavailable", "facilitator_busy", 30_000);
    };
    expect(await core.quote({ principalId: "alice", requestId: "r1", routeId: ROUTE_ID })).toEqual({ ok: false, code: "source_offer_unavailable", reason: "facilitator_busy", retryAfterMs: 30_000 });
    inbound.createImpl = async () => {
      throw new InboundOfferError("source_offer_refused", "order_reused_expired");
    };
    expect(await core.quote({ principalId: "alice", requestId: "r2", routeId: ROUTE_ID })).toEqual({ ok: false, code: "source_offer_refused", reason: "order_reused_expired" });
    inbound.createImpl = async () => {
      throw new Error("other");
    };
    await expect(core.quote({ principalId: "alice", requestId: "r3", routeId: ROUTE_ID })).rejects.toThrow("other");
    expect(await events()).toEqual([]);
    // 失敗の後、同じ requestId で取り直せる（`(principal, requestId)` は確定していない）。
    delete inbound.createImpl;
    expect((await core.quote({ principalId: "alice", requestId: "r1", routeId: ROUTE_ID })).ok).toBe(true);
  });
});

describe("「払われたかもしれない」の開示（設計 §4.2 の表。core の欄だけ。T-2b）", () => {
  const WINDOW = (quote: { source: { offer: InboundOffer } }) => quote.source.offer.extra.expiresAt;
  const PRECISE = (quote: { source: { offer: InboundOffer } }) => quote.source.offer.extra.expiresAt - 1;

  test("(i) credential 無し・承認期限切れ・preflight の拒否・quote_changed: 行なしで、応答と status に上限（settleWindow）", async () => {
    const core = await boot();
    const quote = await quoteOf(core);
    const bare = { principalId: "alice", requestId: "req-1", quoteId: quote.quoteId, approval: quote.quoteId };
    expect(await core.purchase(bare)).toMatchObject({ status: "awaiting_payment", code: "payment_required", mayStillSettleUntil: WINDOW(quote) });
    const wrong = inbound.credentialFor({ ...quote.source.offer, extra: { ...quote.source.offer.extra, challengeNonce: "0xother" } });
    expect(await core.purchase({ ...bare, credential: wrong })).toMatchObject({ status: "rejected", code: "nonce_mismatch", mayStillSettleUntil: WINDOW(quote) });
    expect(core.status(quote.paymentId, "alice")?.source).toMatchObject({ mayStillSettleUntil: WINDOW(quote) });
    expect(await eventNames()).toEqual(["created"]);
    await core.close();
    // quote_changed（設定の変化）と承認期限切れも行なし。
    const changed: RouterConfig = { ...baseConfig(), routes: { [ROUTE_ID]: { ...baseConfig().routes[ROUTE_ID]!, destination: { ...baseConfig().routes[ROUTE_ID]!.destination, payTo: "0xother" } } } };
    const restarted = await boot({ config: changed });
    expect(await restarted.purchase(purchaseArgs(quote))).toMatchObject({ status: "awaiting_payment", code: "quote_changed", mayStillSettleUntil: WINDOW(quote) });
    await restarted.close();
    const late = await boot({ now: () => quote.approval.deadlineMs + 1 });
    expect(await late.purchase(purchaseArgs(quote))).toMatchObject({ status: "rejected", code: "approval_expired", mayStillSettleUntil: WINDOW(quote) });
    expect(await eventNames()).toEqual(["created"]);
  });

  test.each<[string, (core: RouterCore) => void, string]>([
    ["offer_unavailable", () => { outbound.readChallengeImpl = (call) => { if (call >= 2) throw new Error("down"); return [outbound.offer]; }; }, "offer_unavailable"],
    ["offer_changed", () => { outbound.readChallengeImpl = (call) => (call >= 2 ? [] : [outbound.offer]); }, "offer_changed"],
  ])("(i′) %s: source_failed の行に上限、初回・再提出・status に同じ欄", async (_n, arrange, code) => {
    const core = await boot();
    const quote = await quoteOf(core);
    arrange(core);
    const first = await core.purchase(purchaseArgs(quote));
    expect(first).toMatchObject({ status: "awaiting_payment", code, mayStillSettleUntil: WINDOW(quote) });
    expect((await events()).at(-1)).toMatchObject({ event: "source_failed", patch: { outcome: "not_sent", reason: code, mayStillSettleUntil: WINDOW(quote) } });
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "awaiting_payment", mayStillSettleUntil: WINDOW(quote) });
    expect(core.status(quote.paymentId, "alice")?.source).toMatchObject({ mayStillSettleUntil: WINDOW(quote) });
  });

  test("(i′) operator_funds_unavailable も同じ", async () => {
    const core = await boot({ balanceOf: async () => 0n });
    const quote = await quoteOf(core);
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "awaiting_payment", code: "operator_funds_unavailable", mayStillSettleUntil: WINDOW(quote) });
    expect((await events()).at(-1)).toMatchObject({ event: "source_failed", patch: { reason: "operator_funds_unavailable", mayStillSettleUntil: WINDOW(quote) } });
  });

  test("(ii) 手元の検査の後: verify_failed・approval_expired・予算・settle の unknown・rejected の行に正確な validBefore", async () => {
    const core = await boot();
    const q1 = await quoteOf(core, "r1");
    inbound.verify = async (offer) => ({ isValid: false, mayStillSettleUntil: offer.extra.expiresAt - 1 });
    expect(await core.purchase(purchaseArgs(q1, "r1"))).toMatchObject({ status: "awaiting_payment", code: "verify_failed", mayStillSettleUntil: PRECISE(q1) });
    expect((await events()).at(-1)).toMatchObject({ event: "source_failed", patch: { reason: "verify_failed", mayStillSettleUntil: PRECISE(q1) } });
    expect(core.status(q1.paymentId, "alice")?.source).toMatchObject({ mayStillSettleUntil: PRECISE(q1) });
    inbound.verify = async (offer) => ({ isValid: true, mayStillSettleUntil: offer.extra.expiresAt - 1 });
    inbound.settleResult = { outcome: "unknown", reason: "source_settle_unknown" };
    const q2 = await quoteOf(core, "r2");
    expect(await core.purchase(purchaseArgs(q2, "r2"))).toMatchObject({ status: "unknown", terminalReason: "source_settle_unknown", mayStillSettleUntil: PRECISE(q2) });
    expect((await events()).at(-1)).toMatchObject({ event: "unknown", patch: { reason: "source_settle_unknown", mayStillSettleUntil: PRECISE(q2) } });
    inbound.settleResult = { outcome: "rejected", reason: "source_rejected" };
    const q3 = await quoteOf(core, "r3");
    expect(await core.purchase(purchaseArgs(q3, "r3"))).toMatchObject({ status: "awaiting_payment", code: "source_rejected", mayStillSettleUntil: PRECISE(q3) });
    // settle の後に成立した購入には欄が無い（authorization は消費済み）。
    inbound.settleResult = { outcome: "settled", txRef: "src-tx-4" };
    inbound.releaseScript = { outcome: "released", deliveryKey: "", txRef: "src-tx-4", eventId: "84532:src-tx-4:0" };
    const q4 = await quoteOf(core, "r4");
    const ok = await core.purchase(purchaseArgs(q4, "r4"));
    expect(ok.status).toBe("delivered");
    expect(ok).not.toHaveProperty("mayStillSettleUntil");
    expect(core.status(q4.paymentId, "alice")?.source).not.toHaveProperty("mayStillSettleUntil");
    await core.close();
    // 予算の不足（precise）。
    const tight: RouterConfig = { ...baseConfig(), budget: { maxPurchases: 1, buckets: baseConfig().budget.buckets } };
    const t = await boot({ config: tight });
    const q5 = await quoteOf(t, "r5");
    expect(await t.purchase(purchaseArgs(q5, "r5"))).toMatchObject({ status: "awaiting_payment", code: "purchase_count_limit", mayStillSettleUntil: PRECISE(q5) });
    expect((await events()).at(-1)).toMatchObject({ event: "source_failed", patch: { reason: "purchase_count_limit", mayStillSettleUntil: PRECISE(q5) } });
  });

  test("verify が throw する rail（この rail では起きない経路）: unknown の行に上限。再起動の後も journal から出る", async () => {
    const core = await boot();
    const quote = await quoteOf(core);
    inbound.verify = async () => {
      throw new Error("down");
    };
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "unknown", terminalReason: "source_verify_unavailable", mayStillSettleUntil: WINDOW(quote) });
    expect((await events()).at(-1)).toMatchObject({ event: "unknown", patch: { reason: "source_verify_unavailable", mayStillSettleUntil: WINDOW(quote) } });
    await core.close();
    const restarted = await boot({ inbound: plainRail(inbound) });
    expect(restarted.status(quote.paymentId, "alice")?.source).toMatchObject({ mayStillSettleUntil: WINDOW(quote) });
  });

  test("持たない rail: どの経路でも欄が無い（既存の応答・射影は不変）", async () => {
    const core = await boot({ inbound: plainRail(inbound) });
    const quote = await quoteOf(core);
    const bare = await core.purchase({ principalId: "alice", requestId: "req-1", quoteId: quote.quoteId, approval: quote.quoteId });
    expect(bare).not.toHaveProperty("mayStillSettleUntil");
    outbound.readChallengeImpl = (call) => (call >= 2 ? [] : [outbound.offer]);
    expect(await core.purchase(purchaseArgs(quote))).not.toHaveProperty("mayStillSettleUntil");
    expect((await events()).at(-1)?.patch).toEqual({ outcome: "not_sent", reason: "offer_changed" });
    expect(core.status(quote.paymentId, "alice")?.source).not.toHaveProperty("mayStillSettleUntil");
  });
});

describe("実装レビュー 1 の追加（design v5.2 §18）", () => {
  test("k2: verify の間に承認期限を越える → settle 0、source_failed（approval_expired）に正確な validBefore、応答にも", async () => {
    let clock = 1_800_000_000_000;
    const core = await boot({ now: () => clock });
    const quote = await quoteOf(core);
    inbound.verify = async (offer) => {
      clock = quote.approval.deadlineMs + 1;
      return { isValid: true, mayStillSettleUntil: offer.extra.expiresAt - 1 };
    };
    const outcome = await core.purchase(purchaseArgs(quote));
    expect(outcome).toMatchObject({ status: "awaiting_payment", code: "approval_expired", mayStillSettleUntil: quote.source.offer.extra.expiresAt - 1 });
    expect(inbound.settleCalls).toBe(0);
    expect(inbound.releaseCalls).toHaveLength(0);
    expect((await events()).at(-1)).toMatchObject({ event: "source_failed", patch: { outcome: "not_sent", reason: "approval_expired", mayStillSettleUntil: quote.source.offer.extra.expiresAt - 1 } });
    expect(core.status(quote.paymentId, "alice")?.source).toMatchObject({ mayStillSettleUntil: quote.source.offer.extra.expiresAt - 1 });
  });

  test("destination_pending のまま落ちる（行を足さない）→ 再起動で unknown、complete 無し、上流は再送しない", async () => {
    const core = await boot();
    const quote = await quoteOf(core);
    outbound.payImpl = async () => {
      await core.close();
      throw new Error("crashed");
    };
    await expect(core.purchase(purchaseArgs(quote))).rejects.toBeTruthy();
    expect((await eventNames()).at(-1)).toBe("destination_pending");
    const restarted = await boot();
    await restarted.close();
    expect(restarted.status(quote.paymentId, "alice")).toMatchObject({ status: "unknown", terminalReason: "interrupted_at_restart" });
    expect(inbound.completeCalls).toHaveLength(0);
    expect(outbound.payCalls).toBe(1);
    expect((await eventNames()).at(-1)).toBe("unknown");
  });

  test("route を消し adapter も無い構成で再起動: 開示は journal の settleWindow から出る（status と quote_changed の purchase）", async () => {
    const core = await boot();
    const quote = await quoteOf(core);
    await core.close();
    const noRoutes: RouterConfig = { ...baseConfig(), routes: {} };
    const restarted = await boot({ config: noRoutes, inbound: plainRail(inbound) });
    expect(restarted.status(quote.paymentId, "alice")?.source).toMatchObject({ mayStillSettleUntil: quote.source.offer.extra.expiresAt });
    expect(await restarted.purchase(purchaseArgs(quote))).toMatchObject({ status: "awaiting_payment", code: "quote_changed", mayStillSettleUntil: quote.source.offer.extra.expiresAt });
    expect(await eventNames()).toEqual(["created"]);
  });

  test("settle 済みの失敗（release refused → paid_undelivered）には上限の欄が無く、再起動の後も無い（v5.2 の範囲）", async () => {
    inbound.releaseScript = { outcome: "refused", reason: "source_release_refused" };
    const core = await boot();
    const quote = await quoteOf(core);
    const outcome = await core.purchase(purchaseArgs(quote));
    expect(outcome).toMatchObject({ status: "paid_data_unavailable", terminalReason: "source_release_refused" });
    expect(outcome).not.toHaveProperty("mayStillSettleUntil");
    expect(core.status(quote.paymentId, "alice")?.source).not.toHaveProperty("mayStillSettleUntil");
    await core.close();
    const restarted = await boot();
    expect(restarted.status(quote.paymentId, "alice")?.source).not.toHaveProperty("mayStillSettleUntil");
    expect(await restarted.purchase(purchaseArgs(quote))).not.toHaveProperty("mayStillSettleUntil");
  });

  test("InboundOfferError の敵対的な値: 知らない code・detail・retryAfterMs は閉じた集合と有限の値に落ちる", async () => {
    const core = await boot();
    const hostile = (code: string, detail: string, retry: unknown) => {
      inbound.createImpl = async () => {
        const error = new InboundOfferError("source_offer_unavailable", "facilitator_busy");
        Object.assign(error, { code, detail, retryAfterMs: retry });
        throw error;
      };
    };
    hostile("https://leak.example", "token=secret", Number.POSITIVE_INFINITY);
    expect(await core.quote({ principalId: "alice", requestId: "h1", routeId: ROUTE_ID })).toEqual({ ok: false, code: "source_offer_unavailable" });
    hostile("source_offer_refused", "order_reused_expired", Number.NaN);
    expect(await core.quote({ principalId: "alice", requestId: "h2", routeId: ROUTE_ID })).toEqual({ ok: false, code: "source_offer_refused", reason: "order_reused_expired" });
    hostile("source_offer_unavailable", "facilitator_busy", 10 * 3_600_000);
    expect(await core.quote({ principalId: "alice", requestId: "h3", routeId: ROUTE_ID })).toEqual({ ok: false, code: "source_offer_unavailable", reason: "facilitator_busy", retryAfterMs: 3_600_000 });
    hostile("source_offer_unavailable", "facilitator_busy", -5);
    expect(await core.quote({ principalId: "alice", requestId: "h4", routeId: ROUTE_ID })).toEqual({ ok: false, code: "source_offer_unavailable", reason: "facilitator_busy" });
    hostile("source_offer_unavailable", "facilitator_busy", 1500.5);
    expect(await core.quote({ principalId: "alice", requestId: "h5", routeId: ROUTE_ID })).toEqual({ ok: false, code: "source_offer_unavailable", reason: "facilitator_busy" });
  });
});

describe("閉じた quote の再 quote（FR-4.5、全 rail。設計 §4.1）", () => {
  test("created のままの再 quote は同じ文書（closed 無し）。created を離れた後は closed: true と公開の status が付き、createOffer は呼ばれない", async () => {
    const core = await boot();
    const quote = await quoteOf(core);
    const same = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
    expect(same).toEqual(quote);
    expect(same).not.toHaveProperty("closed");
    inbound.verify = async (offer) => ({ isValid: false, mayStillSettleUntil: offer.extra.expiresAt - 1 });
    await core.purchase(purchaseArgs(quote));
    const closed = await core.quote({ principalId: "alice", requestId: "req-1", routeId: ROUTE_ID });
    expect(closed).toMatchObject({ ok: true, quoteId: quote.quoteId, paymentId: quote.paymentId, closed: true, status: "awaiting_payment" });
    expect(inbound.requesters).toHaveLength(1);
    // その quote への purchase（元の credential でも）は rail を呼ばずに現在の状態。
    const verifyCalls = inbound.verifyCalls;
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "awaiting_payment" });
    expect(inbound.verifyCalls).toBe(verifyCalls);
    expect(inbound.settleCalls).toBe(0);
  });
  test("delivered・unknown の後も closed（status はその状態）。release を持たない既存の rail でも同じ", async () => {
    const core = await boot({ inbound: plainRail(inbound) });
    const q1 = await quoteOf(core, "r1");
    await core.purchase(purchaseArgs(q1, "r1"));
    expect(await core.quote({ principalId: "alice", requestId: "r1", routeId: ROUTE_ID })).toMatchObject({ closed: true, status: "delivered" });
    inbound.settleResult = { outcome: "unknown", reason: "source_settle_unknown" };
    const q2 = await quoteOf(core, "r2");
    await core.purchase(purchaseArgs(q2, "r2"));
    expect(await core.quote({ principalId: "alice", requestId: "r2", routeId: ROUTE_ID })).toMatchObject({ closed: true, status: "unknown" });
    await core.close();
    const restarted = await boot({ inbound: plainRail(inbound) });
    expect(await restarted.quote({ principalId: "alice", requestId: "r2", routeId: ROUTE_ID })).toMatchObject({ closed: true, status: "unknown" });
  });
});

describe("断られた支払いの authorization の記録（docs/outbound-rejected-unused-check.md U-1・AC-2・AC-2b）", () => {
  const SENT = { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", from: "0x5d78CBD6fFA81a5dBe435ccfC79271a0F6a42274", nonce: `0x${"ab".repeat(32)}`, validBefore: "1795676232" };
  test("rejected の形どおりの authorization は dest_failed の行に写る。形違い・知らない欄・not_sent では写らない。再起動しても状態は同じ", async () => {
    const core = await boot();
    const cases: [string, unknown, unknown][] = [
      ["r1", { outcome: "rejected", reason: "destination_rejected", authorization: { ...SENT, signature: "0xdead" } }, SENT],
      ["r2", { outcome: "rejected", reason: "destination_rejected", authorization: { ...SENT, nonce: "0x12" } }, undefined],
      ["r3", { outcome: "rejected", reason: "destination_rejected", authorization: { ...SENT, validBefore: 1795676232 } }, undefined],
      ["r4", { outcome: "rejected", reason: "destination_rejected", authorization: { ...SENT, network: "solana:devnet" } }, undefined],
      ["r5", { outcome: "not_sent", reason: "destination_deadline", authorization: SENT }, undefined],
      ["r6", { outcome: "rejected", reason: "destination_rejected" }, undefined],
    ];
    const ids: string[] = [];
    for (const [requestId, payResult] of cases) {
      outbound.payResult = payResult as typeof outbound.payResult;
      const q = await quoteOf(core, requestId);
      ids.push(q.paymentId);
      expect(await core.purchase(purchaseArgs(q, requestId))).toMatchObject({ status: "paid_data_unavailable" });
    }
    const rows = await events();
    for (const [i, [, , expected]] of cases.entries()) {
      const row = rows.find((r) => r.paymentId === ids[i] && r.event === "dest_failed")!;
      expect(row.patch["authorization"], String(i)).toEqual(expected);
    }
    expect(JSON.stringify(rows)).not.toContain("0xdead");
    const before = ids.map((id) => core.status(id, "alice"));
    await core.close();
    const restarted = await boot();
    expect(ids.map((id) => restarted.status(id, "alice"))).toEqual(before);
  });
});
