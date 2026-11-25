/**
 * 式の価格の core（`docs/exact-pricing-{requirements,design}.md` §4〜§6。AC-3・AC-4・AC-6・AC-8・AC-13 の予約の額）。合成 rail（鍵も署名も送金もない）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createHash } from "node:crypto";

import { createExactPricing } from "../../src/adapters/inbound/exact-pricing.js";
import { createSettleCosts } from "../../src/adapters/inbound/settle-costs.js";
import { authoritativeTermsOf, parseRouterConfig, type RouterConfig } from "../../src/config.js";
import { fingerprintOf } from "../../src/core/intent.js";
import { quoteBody, routeListBody } from "../../src/http/projection.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import { createSubethaExactFacilitator } from "../fixtures/subetha-exact-facilitator.js";
import { createRouterCore, type RouterCore, type RouterCoreOptions, type StandardPresented } from "../../src/core/orchestrator.js";
import type { CreateOfferRequest, InboundOffer, InboundRail, InboundVerifyResult, PaymentCredential, PreflightResult, SettleResult } from "../../src/ports/inbound.js";
import type { DestinationOffer, OutboundRail, PayResult } from "../../src/ports/outbound.js";
import type { ExactPricing } from "../../src/ports/exact-pricing.js";
import { computeExactPrice, type ExactPrice, type ExactPricingConfig } from "../../src/shared/exact-pricing.js";
import { HOSTED_EXACT_PRICING } from "../../tools/remote-mcp-config.js";

const ROUTE_ID = "md-zusdc-exact";
const NETWORK = "eip155:84532";
const ASSET = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = `0x${"a1".repeat(20)}`;
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const DAY = 86_400_000;

function config(pricing: Partial<ExactPricingConfig> | null = {}, maxCommitted = 50): RouterConfig {
  return {
    approvalTtlMs: 60_000,
    routes: {
      [ROUTE_ID]: {
        routeId: ROUTE_ID, canonicalPath: `/v1/routes/${ROUTE_ID}/resource`, rail: "x402", sourceRail: "subetha-exact", offerCap: { maxCommitted },
        ...(pricing === null ? {} : { pricing: { ...HOSTED_EXACT_PRICING, ...pricing } }),
        source: { amount: pricing === null ? "12000" : "20000", asset: ASSET, decimals: 6, network: NETWORK },
        destination: { scheme: "exact", network: NETWORK, asset: USDC, payTo: "0xprovidera" },
      },
    },
    budget: { maxPurchases: 100, buckets: [{ network: NETWORK, asset: ASSET, maxTotal: "10000000", maxPerPurchase: "20000" }, { network: NETWORK, asset: USDC, maxTotal: "10000000", maxPerPurchase: "20000" }] },
  } as unknown as RouterConfig;
}

class Rail implements InboundRail {
  createCalls: CreateOfferRequest[] = [];
  verifyCalls = 0;
  settleCalls = 0;
  verifyResult: InboundVerifyResult = { isValid: true };
  settleResult: SettleResult = { outcome: "settled", txRef: "src-tx", eventId: "0xnonce" };
  offerAmount: string | undefined;
  onCreate: (() => Promise<void> | void) | undefined;
  onVerify: (() => Promise<void>) | undefined;
  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.createCalls.push(request);
    const n = this.createCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 2));
    await this.onCreate?.();
    return {
      scheme: "exact", network: request.network, asset: request.asset, amount: this.offerAmount ?? request.amount, payTo: `0x${String(n).padStart(40, "0")}`, maxTimeoutSeconds: 150,
      extra: { challengeNonce: `0x${String(n).padStart(64, "0")}`, expiresAt: Math.floor(request.nowMs / 1000) + 300, routeBinding: request.routeBinding, name: "zERC20 USD Coin", version: "1", fundsMoveOnCredential: false, ...(request.entry === "x402" ? { entry: "x402" } : {}) },
    };
  }
  preflight(): PreflightResult {
    return { ok: true };
  }
  async checkSignature(): Promise<boolean> {
    return true;
  }
  async verify(): Promise<InboundVerifyResult> {
    this.verifyCalls += 1;
    await this.onVerify?.();
    return this.verifyResult;
  }
  async settle(): Promise<SettleResult> {
    this.settleCalls += 1;
    return this.settleResult;
  }
}
class Outbound implements OutboundRail {
  payCalls = 0;
  amount = "10000";
  async readChallenge(): Promise<readonly DestinationOffer[]> {
    return [{ scheme: "exact", network: NETWORK, asset: USDC, amount: this.amount, payTo: "0xprovidera" }];
  }
  async pay(): Promise<PayResult> {
    this.payCalls += 1;
    return { outcome: "paid", body: { data: 1 }, contentType: "application/json", txRef: "dst-tx" };
  }
}

let workDir: string;
let journalPath: string;
let rail: Rail;
let outbound: Outbound;
let clockMs: number;
let baseFee: bigint;
let priceCalls: number;
let answer: ((price: ExactPrice) => unknown) | undefined;
let ids = 0;
const opened: RouterCore[] = [];
const exactPricing: ExactPricing = {
  async price(_routeId, pricing, upstream) {
    priceCalls += 1;
    const computed = computeExactPrice(pricing, upstream, { p90Wei: 0n, baseFeePerGas: baseFee, l1FeeMax: 0n, overheadPpm: 1n, readAtMs: clockMs }, 3_000_000_000n);
    if (answer !== undefined && computed.ok) return answer(computed.price) as Awaited<ReturnType<ExactPricing["price"]>>;
    return computed;
  },
};
async function boot(overrides: Partial<RouterCoreOptions> = {}): Promise<RouterCore> {
  const core = await createRouterCore({ journalPath, config: config(), inbound: rail, outbound, now: () => clockMs, nextPaymentId: () => `pay-${(ids += 1)}`, exactPricing, ...overrides });
  opened.push(core);
  return core;
}
type Row = { seq: number; paymentId: string; event: string; patch: Record<string, unknown> };
const rows = async (): Promise<Row[]> => (await readFile(journalPath, "utf8").catch(() => "")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Row);
const quote = (core: RouterCore, requestId: string) => core.quote({ principalId: "alice", requestId, routeId: ROUTE_ID });
async function okQuote(core: RouterCore, requestId: string) {
  const q = await quote(core, requestId);
  if (!q.ok) throw new Error(`${q.code} ${String(q.reason)}`);
  return q;
}
const credentialOf = (offer: InboundOffer): PaymentCredential => ({ x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce } }) as unknown as PaymentCredential;
const purchase = (core: RouterCore, q: Awaited<ReturnType<typeof okQuote>>, requestId: string) =>
  core.purchase({ principalId: "alice", requestId, quoteId: q.quoteId, routeId: ROUTE_ID, approval: q.quoteId, credential: credentialOf(q.source.offer) });
function presentedFor(offer: InboundOffer): StandardPresented {
  return {
    accepted: { scheme: offer.scheme, network: offer.network, asset: offer.asset, amount: offer.amount, payTo: offer.payTo, maxTimeoutSeconds: offer.maxTimeoutSeconds, extra: { name: offer.extra["name"], version: offer.extra["version"] } },
    authorization: { from: PAYER, to: offer.payTo, value: offer.amount, validAfter: "0", validBefore: String(Math.floor(clockMs / 1000) + 150), nonce: `0x${"5a".repeat(32)}` },
    signature: `0x${"ab".repeat(65)}`,
  };
}
const refused = (reason: string) => ({ ok: false, code: "source_offer_unavailable", reason });

beforeEach(async () => {
  await mkdir(runtimeRoot, { recursive: true });
  workDir = await mkdtemp(path.join(runtimeRoot, "ep-core-"));
  journalPath = path.join(workDir, "journal.ndjson");
  rail = new Rail();
  outbound = new Outbound();
  clockMs = Date.parse("2026-11-24T12:00:00Z");
  baseFee = 5_000_000n;
  priceCalls = 0;
  answer = undefined;
  ids = 0;
});
afterEach(async () => {
  for (const core of opened.splice(0)) await core.close().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
});

test("AC-9（core）・AC-13: 式の額で注文・記録・予約をし、delivered。予約の額は注文ごとの額", async () => {
  const core = await boot();
  const first = await okQuote(core, "a");
  expect(first.source).toMatchObject({ amount: first.source.offer.amount, pricing: { kind: "settle-cost-v1", upstream: "10000", total: first.source.amount, issuedAtMs: clockMs } });
  expect(Number(first.source.amount)).toBeGreaterThan(16_000);
  expect(rail.createCalls[0]!.amount).toBe(first.source.amount);
  expect(await purchase(core, first, "a")).toMatchObject({ status: "delivered" });
  baseFee = 7_000_000n;
  const second = await okQuote(core, "b");
  expect(second.source.amount).not.toBe(first.source.amount);
  expect(await purchase(core, second, "b")).toMatchObject({ status: "delivered" });
  const reserved = (await rows()).filter((r) => r.event === "budget_reserved").map((r) => (r.patch["source"] as { amount: string }).amount);
  expect(reserved).toEqual([first.source.amount, second.source.amount]);
  expect(core.status(second.paymentId, "alice")!.source.amount).toBe(second.source.amount);
});

test("AC-9（core）: 標準入口も式の額。購入は delivered で、予約も同じ額", async () => {
  const core = await boot();
  const challenge = await core.quoteStandard({ principalId: "alice", routeId: ROUTE_ID });
  if (!challenge.ok) throw new Error(challenge.code);
  expect(challenge.offer.amount).toBe(rail.createCalls[0]!.amount);
  expect(await core.purchaseStandard({ principalId: "alice", routeId: ROUTE_ID, presented: presentedFor(challenge.offer) })).toMatchObject({ kind: "outcome", outcome: { status: "delivered" } });
  expect(((await rows()).find((r) => r.event === "budget_reserved")!.patch["source"] as { amount: string }).amount).toBe(challenge.offer.amount);
});

test("AC-3: 価格が出ない・上限・port が無い・投げる・内訳が壊れている → 注文の作成 0。発行済みの支払いは完了する", async () => {
  const core = await boot();
  const issued = await okQuote(core, "issued");
  const before = rail.createCalls.length;
  const broken: ((p: ExactPrice) => unknown)[] = [
    () => ({ ok: false, reason: "pricing_unavailable" }),
    () => ({ ok: false, reason: "https://leak.example/?token=x" }),
    () => { throw new Error("leak-me"); },
    () => undefined,
    (p) => ({ ok: true, price: { ...p, total: String(Number(p.total) - 1) } }),
    (p) => ({ ok: true, price: { ...p, upstream: "9999" } }),
    (p) => ({ ok: true, price: { ...p, share: "0" } }),
    (p) => ({ ok: true, price: { ...p, kind: "x" } }),
  ];
  for (const [i, fn] of broken.entries()) {
    answer = fn;
    expect(await quote(core, `broken-${String(i)}`), String(i)).toEqual(refused("pricing_unavailable"));
    expect(await core.quoteStandard({ principalId: "alice", routeId: ROUTE_ID }), String(i)).toEqual(refused("pricing_unavailable"));
  }
  answer = undefined;
  baseFee = 50_000_000n;
  expect(await quote(core, "over")).toEqual(refused("pricing_over_limit"));
  outbound.amount = "19000";
  baseFee = 5_000_000n;
  expect(await quote(core, "over-total")).toEqual(refused("pricing_over_limit"));
  outbound.amount = "0";
  expect((await quote(core, "bad-upstream")).ok).toBe(false);
  expect(rail.createCalls.length).toBe(before);
  outbound.amount = "10000";
  answer = () => ({ ok: false, reason: "pricing_unavailable" });
  expect(await purchase(core, issued, "issued")).toMatchObject({ status: "delivered" });
  await core.close();
  const noPort = await boot({ exactPricing: undefined } as never);
  expect(await quote(noPort, "no-port")).toEqual(refused("pricing_unavailable"));
  expect(JSON.stringify(await rows())).not.toMatch(/leak/);
});

test("AC-3: 応答した offer の額が違えば quote は成立しない（記録しない）", async () => {
  const core = await boot();
  rail.offerAmount = "1";
  expect(await quote(core, "x")).toEqual({ ok: false, code: "source_terms_mismatch" });
  expect(await rows()).toEqual([]);
});

test("AC-4: 同じ requestId の再取得・再起動のあとも同じ額。費用が変わっても発行済みの額で買え、計算し直さない", async () => {
  let core = await boot();
  const first = await okQuote(core, "a");
  expect(priceCalls).toBe(1);
  baseFee = 9_000_000n;
  expect((await okQuote(core, "a")).source.amount).toBe(first.source.amount);
  await core.close();
  core = await boot();
  const again = await okQuote(core, "a");
  expect([again.source.amount, again.source.pricing]).toEqual([first.source.amount, first.source.pricing]);
  expect(await purchase(core, again, "a")).toMatchObject({ status: "delivered" });
  expect(priceCalls).toBe(1);
  // 使用済みの quote は閉じる。
  expect(await quote(core, "a")).toMatchObject({ ok: true, closed: true });
});

test("AC-6: 1 日の件数。両方の入口の同時の発行で越えず、注文も作らない。期限切れの未払いは戻り、settle の前に失敗した分も戻り、結果の分からない購入は残る", async () => {
  const core = await boot({ config: config({ maxPerDay: 2 }) });
  const std = () => core.quoteStandard({ principalId: "alice", routeId: ROUTE_ID });
  const results = await Promise.all([std(), quote(core, "a"), std(), quote(core, "b"), std()]);
  expect(results.filter((r) => r.ok)).toHaveLength(2);
  expect(results.filter((r) => !r.ok)).toEqual([refused("offer_daily_cap_reached"), refused("offer_daily_cap_reached"), refused("offer_daily_cap_reached")]);
  expect(rail.createCalls).toHaveLength(2);
  clockMs += 61_000;
  const c = await okQuote(core, "c");
  // settle の前の失敗（verify の拒否）は戻る。
  rail.verifyResult = { isValid: false };
  expect(await purchase(core, c, "c")).toMatchObject({ status: "awaiting_payment" });
  rail.verifyResult = { isValid: true };
  const d = await okQuote(core, "d");
  // 結果の分からない購入は残る。
  rail.settleResult = { outcome: "unknown", reason: "source_settle_unknown" };
  expect(await purchase(core, d, "d")).toMatchObject({ status: "unknown" });
  clockMs += 61_000;
  await okQuote(core, "e");
  expect(await quote(core, "f")).toEqual(refused("offer_daily_cap_reached"));
});

test("AC-6: 上限で失敗した発行・発行の失敗は予約を残さない。offerCap は日をまたいで残り、日の数は戻る。再起動で戻らない", async () => {
  let core = await boot({ config: config({ maxPerDay: 1 }, 2) });
  answer = () => ({ ok: false, reason: "pricing_unavailable" });
  for (let i = 0; i < 3; i += 1) expect((await quote(core, `x${String(i)}`)).ok).toBe(false);
  answer = undefined;
  rail.onCreate = () => { throw new Error("facilitator down"); };
  await expect(quote(core, "down")).rejects.toThrow();
  rail.onCreate = undefined;
  expect(await purchase(core, await okQuote(core, "a"), "a")).toMatchObject({ status: "delivered" });
  expect(await quote(core, "b")).toEqual(refused("offer_daily_cap_reached"));
  await core.close();
  core = await boot({ config: config({ maxPerDay: 1 }, 2) });
  expect(await quote(core, "b")).toEqual(refused("offer_daily_cap_reached"));
  clockMs += DAY;
  expect(await purchase(core, await okQuote(core, "b"), "b")).toMatchObject({ status: "delivered" });
  clockMs += DAY;
  expect(await quote(core, "c")).toEqual(refused("offer_cap_reached"));
});

test("AC-6: 発行の途中で日が変わっても予約した日の 1 件。新しい日の枠は使わない。処理中の購入は承認の期限を越えても残る", async () => {
  clockMs = Date.parse("2026-11-24T23:59:59.900Z");
  const core = await boot({ config: config({ maxPerDay: 1 }) });
  rail.onCreate = () => { clockMs = Date.parse("2026-11-25T00:00:01Z"); };
  const late = await okQuote(core, "late");
  rail.onCreate = undefined;
  expect((late.source.pricing as { issuedAtMs: number }).issuedAtMs).toBe(Date.parse("2026-11-24T23:59:59.900Z"));
  const today = await okQuote(core, "today");
  expect(await quote(core, "more")).toEqual(refused("offer_daily_cap_reached"));
  expect(await quote(core, "more-2")).toEqual(refused("offer_daily_cap_reached"));
  void today;
});

test("AC-6: 上流の読み直しの途中（`created` のまま）で承認の期限を越えた購入も、その日の数に残る。終われば戻る", async () => {
  const core = await boot({ config: config({ maxPerDay: 1 }) });
  const q = await okQuote(core, "a");
  let midway: unknown;
  const read = outbound.readChallenge.bind(outbound);
  outbound.readChallenge = async () => {
    // 購入の中の読み直しの 1 回だけ（中で呼ぶ quote は、件数の検査で上流を読む前に断られる）。
    outbound.readChallenge = read;
    clockMs += 61_000;
    midway = await quote(core, "midway");
    return read();
  };
  await purchase(core, q, "a");
  expect(midway).toEqual(refused("offer_daily_cap_reached"));
});

test("AC-8: 記録の内訳・額・offer・時刻・上流のどれかを書き換えた復元は、支払いに使えず、再提示もしない（状態は読める）。時刻の書き換えは枠を戻さない", async () => {
  const seed = await boot({ config: config({ maxPerDay: 1 }) });
  const q = await okQuote(seed, "a");
  await seed.close();
  const original = await readFile(journalPath, "utf8");
  type Created = { source: { amount: string; offer: { amount: string }; pricing?: Record<string, unknown> }; destination: { quoted: string; selectedOffer: { amount: string } } };
  const cases: [string, (p: Created) => void][] = [
    ["settle", (p) => { p.source.pricing!["settle"] = "1"; }],
    ["take", (p) => { p.source.pricing!["take"] = "501"; }],
    ["share", (p) => { p.source.pricing!["share"] = "1"; }],
    ["total", (p) => { p.source.pricing!["total"] = "1"; }],
    ["amount", (p) => { p.source.amount = "1"; }],
    ["offer", (p) => { p.source.offer.amount = "1"; }],
    ["quoted", (p) => { p.destination.quoted = "1"; }],
    ["selected", (p) => { p.destination.selectedOffer.amount = "1"; }],
    ["issuedAt", (p) => { p.source.pricing!["issuedAtMs"] = clockMs - DAY; }],
    ["kind", (p) => { p.source.pricing!["kind"] = "x"; }],
    ["not-object", (p) => { p.source.pricing = "x" as never; }],
    ["removed", (p) => { delete p.source.pricing; }],
    ["issuedAt-1ms", (p) => { p.source.pricing!["issuedAtMs"] = clockMs - 1; }],
    ["fingerprint", (p) => { (p as unknown as Record<string, unknown>)["pricingFingerprint"] = `sha256:${"00".repeat(32)}`; }],
    ["fingerprint-removed", (p) => { delete (p as unknown as Record<string, unknown>)["pricingFingerprint"]; }],
  ];
  for (const [name, mutate] of cases) {
    const lines = original.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Row);
    mutate(lines[0]!.patch as unknown as Created);
    journalPath = path.join(workDir, `${name}.ndjson`);
    await writeFile(journalPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const core = await boot({ config: config({ maxPerDay: 1 }) });
    const calls = [rail.verifyCalls, rail.settleCalls, outbound.payCalls];
    expect((await purchase(core, q, "a")).status, name).not.toBe("delivered");
    expect([rail.verifyCalls, rail.settleCalls, outbound.payCalls], name).toEqual(calls);
    expect(core.offerFor(q.quoteId, "alice", ROUTE_ID), name).toBeUndefined();
    expect((await quote(core, "a")).ok, name).toBe(false);
    expect(core.status(q.paymentId, "alice"), name).toBeDefined();
    // どの書き換えでも、その日の枠は戻らない。
    expect(await quote(core, "new"), name).toEqual(refused("offer_daily_cap_reached"));
    await core.close();
  }
});

test("AC-6・AC-8: 日の境目の直後の予約を前日に書き換えても、結果の分からない購入の内訳を消しても、枠は戻らない（offerCap にも残る）", async () => {
  clockMs = Date.parse("2026-11-25T00:00:10Z");
  const seed = await boot({ config: config({ maxPerDay: 1 }) });
  const q = await okQuote(seed, "a");
  rail.settleResult = { outcome: "unknown", reason: "source_settle_unknown" };
  expect(await purchase(seed, q, "a")).toMatchObject({ status: "unknown" });
  await seed.close();
  const original = await readFile(journalPath, "utf8");
  for (const [name, mutate] of [
    ["previous-day", (p: { source: { pricing?: Record<string, unknown> } }) => { p.source.pricing!["issuedAtMs"] = Date.parse("2026-11-24T23:59:59Z"); }],
    ["deleted", (p: { source: { pricing?: Record<string, unknown> } }) => { delete p.source.pricing; }],
  ] as const) {
    const lines = original.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Row);
    mutate(lines[0]!.patch as never);
    journalPath = path.join(workDir, `midnight-${name}.ndjson`);
    await writeFile(journalPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const core = await boot({ config: config({ maxPerDay: 1 }) });
    clockMs += 3_600_000;
    expect(await quote(core, "new"), name).toEqual(refused("offer_daily_cap_reached"));
    await core.close();
    const capped = await boot({ config: config({ maxPerDay: 1 }, 1) });
    expect(await quote(capped, "new"), name).toEqual(refused("offer_cap_reached"));
    await capped.close();
  }
});

test("AC-5: 100 件の同時の quote で `/costs` の呼び出しは 1 回（実際の読み取りを通す）", async () => {
  const fixture = createSubethaExactFacilitator({ providerId: "p", bearer: "fixture-provider-token-0123", settleBearer: "5e".repeat(32), chainId: 84532, asset: ASSET, domainName: "zERC20 USD Coin", domainVersion: "1" });
  await fixture.listen();
  try {
    const costs = createSettleCosts({ baseUrl: `${fixture.baseUrl!}/xfac`, token: () => "5e".repeat(32), transport: createGuardedTransport({ allowLoopback: true, report: () => undefined }), chainId: 84532, asset: ASSET, tenant: "p", now: () => clockMs });
    const core = await boot({ config: config({ maxPerDay: 1000 }, 200), exactPricing: createExactPricing({ costs, ethPrice: { price: 3_000_000_000n, atMs: clockMs }, now: () => clockMs }) });
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => quote(core, `c-${String(i)}`)));
    expect(results.filter((r) => r.ok)).toHaveLength(100);
    expect(fixture.calls.byRoute["costs"]).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("AC-7: 固定の route の指紋・created の行・一覧・quote の文書は、変更の前（`9e6f74e`）と byte 一致", async () => {
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
  const cfg = parseRouterConfig({
    approvalTtlMs: 60000,
    routes: { z: { routeId: "z", canonicalPath: "/v1/routes/z/resource", rail: "x402", sourceRail: "subetha-exact", offerCap: { maxCommitted: 5 }, source: { amount: "12000", asset: ASSET, decimals: 6, network: NETWORK }, destination: { scheme: "exact", network: NETWORK, asset: USDC, payTo: "0x0000000000000000000000000000000000000a11" } } },
    budget: { maxPurchases: 4, buckets: [{ network: NETWORK, asset: ASSET, maxTotal: "100000", maxPerPurchase: "20000" }, { network: NETWORK, asset: USDC, maxTotal: "100000", maxPerPurchase: "20000" }] },
  });
  clockMs = 1_800_000_000_000;
  const core = await boot({
    config: cfg, nextPaymentId: () => "pay-1",
    inbound: { createOffer: async (r: CreateOfferRequest) => ({ scheme: "exact", network: r.network, asset: r.asset, amount: r.amount, payTo: "0x0000000000000000000000000000000000000001", maxTimeoutSeconds: 150, extra: { challengeNonce: `0x${"01".repeat(32)}`, expiresAt: 1_800_000_300, routeBinding: r.routeBinding, name: "zERC20 USD Coin", version: "1", fundsMoveOnCredential: false } }), preflight: () => ({ ok: true }), verify: async () => ({ isValid: true }), settle: async () => ({ outcome: "settled", txRef: "t", eventId: "e" }) } as unknown as InboundRail,
    outbound: { readChallenge: async () => [{ scheme: "exact", network: NETWORK, asset: USDC, amount: "10000", payTo: "0x0000000000000000000000000000000000000a11" }], pay: async () => ({ outcome: "paid", body: {}, contentType: "application/json" }) } as unknown as OutboundRail,
  });
  const q = await core.quote({ principalId: "alice", requestId: "r", routeId: "z" });
  if (!q.ok) throw new Error(q.code);
  const row = (await rows())[0]!;
  expect({ fp: fingerprintOf(authoritativeTermsOf(cfg.routes["z"]!)), row: sha(JSON.stringify(row.patch)), list: sha(JSON.stringify(routeListBody(cfg, "http://x"))), quote: sha(JSON.stringify(quoteBody(q, cfg.routes["z"]!, "http://x"))) }).toEqual({
    fp: "sha256:082ce2962aa66076767992e6f0f80087a84845b41717d93e158efa7301ec55b8",
    row: "de1f23fdd470f7d6bfe2345e8c02face6435a98a1a891eed9dd0851b7c03c4d6",
    list: "ff235f921ac4b47aa76ffa8a03b9ea6a5626246c2e9cb7d1a29cc012176c46a3",
    quote: "74c046cf958af3f738e91cedd349734df1296fa2d40da0611237fc6592846d34",
  });
});

test("AC-8: 標準入口でも、書き換えた記録の credential は受け付けない（結び付けの行も書かない）", async () => {
  const seed = await boot();
  const challenge = await seed.quoteStandard({ principalId: "alice", routeId: ROUTE_ID });
  if (!challenge.ok) throw new Error(challenge.code);
  await seed.close();
  const lines = await rows();
  ((lines[0]!.patch as { source: { pricing: Record<string, unknown> } }).source.pricing)["take"] = "501";
  await writeFile(journalPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const core = await boot();
  expect(await core.purchaseStandard({ principalId: "alice", routeId: ROUTE_ID, presented: presentedFor(challenge.offer) })).toMatchObject({ kind: "not_accepted" });
  expect((await rows()).map((r) => r.event)).toEqual(["created"]);
});

test("AC-7（core）: 条件の設定・固定への切り替えの前の quote では払えない。maxPerDay の変更では払える", async () => {
  for (const [i, next] of [config({ take: "501" }), config({ maxAmount: "19999" }), config(null)].entries()) {
    journalPath = path.join(workDir, `change-${String(i)}.ndjson`);
    let core = await boot();
    const q = await okQuote(core, "a");
    await core.close();
    core = await boot({ config: next });
    expect(await purchase(core, q, "a")).toMatchObject({ status: "awaiting_payment", code: "quote_changed" });
    expect(rail.settleCalls).toBe(0);
    await core.close();
  }
  journalPath = path.join(workDir, "ok.ndjson");
  let core = await boot();
  const q = await okQuote(core, "a");
  await core.close();
  core = await boot({ config: config({ maxPerDay: 3, ethPriceMaxAgeDays: 1 }) });
  expect(await purchase(core, q, "a")).toMatchObject({ status: "delivered" });
});

test("R1: 固定の route は価格を求めず、記録に pricing が無い（created の欄は今までどおり）", async () => {
  const core = await boot({ config: config(null) });
  const q = await okQuote(core, "a");
  expect([q.source.amount, "pricing" in q.source, priceCalls]).toEqual(["12000", false, 0]);
  const created = (await rows())[0]!.patch as { source: Record<string, unknown> };
  expect(Object.keys(created.source)).toEqual(["amount", "asset", "network", "offer"]);
  expect(await purchase(core, q, "a")).toMatchObject({ status: "delivered" });
});
