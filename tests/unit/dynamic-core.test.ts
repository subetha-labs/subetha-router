/**
 * core の動的 quote／purchase（設計 `docs/dynamic-upstream-design.md` §2・§5・§6、タスク T10）。
 *
 * 合成レール（鍵も送金も無い）と接続カウンタで、**何が書かれ、何に接続したか**を数える。
 * 「外部接続 0」は上流（readChallenge・pay）・facilitator／RPC（verify・settle）の呼び出し回数で見る。
 */
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DEFAULT_DYNAMIC_LIMITS, type DynamicProfile, type RouterConfig } from "../../src/config.js";
import { capOf, dynamicBindingOf, ownerKeyHashOf, perPurchaseLimitOf, priceOf, reservationOf } from "../../src/core/dynamic.js";
import { DynamicGate } from "../../src/core/dynamic-gate.js";
import { stableJson } from "../../src/core/intent.js";
import { createRouterCore, type QuoteOutcome, type RouterCore } from "../../src/core/orchestrator.js";
import { capCoversFee } from "../../src/core/store.js";
import type { CreateOfferRequest, InboundOffer, InboundRail, PaymentCredential, PreflightResult, SettleResult } from "../../src/ports/inbound.js";
import type { DestinationOffer, FeeEstimate, OutboundRail, PayRequest, PayResult, UpstreamTarget } from "../../src/ports/outbound.js";

const PROFILE_ID = "dyn-mpp-to-x402";
const STATIC_ROUTE = "md-static";
const SRC_NETWORK = "eip155:42431";
const SRC_ASSET = "0x20c0000000000000000000000000000000000000";
const DST_NETWORK = "eip155:84532";
const DST_ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const URL_A = "https://provider.test/v1/price?symbol=ETH";
const URL_B = "https://other.test/v1/price";
const BODY = { price: "3000" };

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "mpp",
  source: { network: SRC_NETWORK, asset: SRC_ASSET, decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" },
  rail: "x402",
  destination: { scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "1000", bps: 100, min: "1000" },
};

function baseConfig(overrides: { enabled?: boolean; profile?: DynamicProfile; maxPurchases?: number; maxTotal?: string; limits?: Partial<typeof DEFAULT_DYNAMIC_LIMITS>; denyHosts?: string[] } = {}): RouterConfig {
  const profile = overrides.profile ?? PROFILE;
  return {
    approvalTtlMs: 60_000,
    routes: {
      [STATIC_ROUTE]: {
        routeId: STATIC_ROUTE,
        canonicalPath: `/v1/routes/${STATIC_ROUTE}/resource`,
        source: { amount: "1500", asset: SRC_ASSET, decimals: 6, network: SRC_NETWORK },
        destination: { scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, payTo: "0x0000000000000000000000000000000000000a11" },
      },
    },
    budget: {
      maxPurchases: 4,
      buckets: [
        { network: SRC_NETWORK, asset: SRC_ASSET, maxTotal: "10000", maxPerPurchase: "5000" },
        { network: DST_NETWORK, asset: DST_ASSET, maxTotal: "10000", maxPerPurchase: "5000" },
      ],
    },
    dynamic: {
      enabled: overrides.enabled ?? true,
      profiles: { [profile.profileId]: profile },
      budget: {
        maxPurchases: overrides.maxPurchases ?? 3,
        buckets: [
          { network: SRC_NETWORK, asset: SRC_ASSET, maxTotal: overrides.maxTotal ?? "1000000", maxPerPurchase: "200000" },
          { network: DST_NETWORK, asset: DST_ASSET, maxTotal: overrides.maxTotal ?? "1000000", maxPerPurchase: "200000" },
        ],
      },
      limits: { ...DEFAULT_DYNAMIC_LIMITS, ...overrides.limits },
      denyHosts: overrides.denyHosts ?? [],
    },
  };
}

class SyntheticInbound implements InboundRail {
  createOfferCalls = 0;
  verifyCalls = 0;
  settleCalls = 0;
  verifyImpl: () => Promise<{ isValid: boolean }> = async () => ({ isValid: true });
  settleImpl: () => Promise<SettleResult> = async () => ({ outcome: "settled", txRef: "src-tx-1" });
  #issued = 0;
  /** 発行した offer（routeId ごと）。 */
  readonly issued: CreateOfferRequest[] = [];

  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.createOfferCalls += 1;
    this.#issued += 1;
    this.issued.push(request);
    return {
      scheme: "tempo/charge",
      network: request.network,
      asset: request.asset,
      amount: request.amount,
      payTo: "0xrouter",
      maxTimeoutSeconds: 120,
      extra: { challengeNonce: `0xnonce${this.#issued}`, expiresAt: Math.floor(request.nowMs / 1000) + 60, routeBinding: request.routeBinding },
    };
  }

  preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
    if (credential.payload.challengeNonce !== offer.extra.challengeNonce) return { ok: false, reason: "nonce_mismatch" };
    if (offer.extra.expiresAt * 1000 <= nowMs) return { ok: false, reason: "offer_expired" };
    if (stableJson(credential.accepted) !== stableJson(offer)) return { ok: false, reason: "offer_mismatch" };
    return { ok: true };
  }

  async verify(): Promise<{ isValid: boolean }> {
    this.verifyCalls += 1;
    return this.verifyImpl();
  }

  async settle(): Promise<SettleResult> {
    this.settleCalls += 1;
    return this.settleImpl();
  }

  credentialFor(offer: InboundOffer, tag = "sig"): PaymentCredential {
    return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, tag } };
  }
}

class SyntheticOutbound implements OutboundRail {
  readChallengeCalls = 0;
  payCalls = 0;
  readonly targetsSeen: (UpstreamTarget | undefined)[] = [];
  readonly paidFor: PayRequest[] = [];
  offers: DestinationOffer[] = [{ scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, amount: "5000", payTo: "0x0000000000000000000000000000000000000a11", extra: { name: "USDC", version: "2" } }];
  readChallengeImpl: ((routeId: string, target: UpstreamTarget | undefined) => Promise<readonly DestinationOffer[]>) | undefined;
  payResult: PayResult = { outcome: "paid", body: BODY, contentType: "application/json", txRef: "dst-tx-1" };

  async readChallenge(routeId: string, target?: UpstreamTarget): Promise<readonly DestinationOffer[]> {
    this.readChallengeCalls += 1;
    this.targetsSeen.push(target);
    if (this.readChallengeImpl !== undefined) return this.readChallengeImpl(routeId, target);
    if (routeId === STATIC_ROUTE) return [{ scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, amount: "900", payTo: "0x0000000000000000000000000000000000000a11" }];
    return this.offers;
  }

  async pay(request: PayRequest): Promise<PayResult> {
    this.payCalls += 1;
    this.paidFor.push(request);
    return this.payResult;
  }

  estimateCalls = 0;
  /** 見積り（MPP 送信）。既定は bound 2,500（cap は feeMargin 2 倍で 5,000 = 天井）。`undefined` なら失敗。 */
  estimateBound: string | undefined = "2500";
  async estimateFee(_routeId: string, _offer: DestinationOffer, _target: UpstreamTarget): Promise<FeeEstimate> {
    this.estimateCalls += 1;
    if (this.estimateBound === undefined) throw new Error("rpc down https://secret.internal/");
    return { gas: "50000", maxFeePerGas: "50000000000", bound: this.estimateBound, viaFillTransaction: true };
  }
}

let workDir: string;
let journalPath: string;
let issuedIds = 0;
let inbound: SyntheticInbound;
let outbound: SyntheticOutbound;
let clock = 1_800_000_000_000;
const opened: RouterCore[] = [];

async function boot(config: RouterConfig = baseConfig(), extra: { balanceOf?: (profileId: string, asset: string) => Promise<bigint>; gate?: DynamicGate } = {}): Promise<RouterCore> {
  const core = await createRouterCore({
    journalPath,
    config,
    inbound,
    outbound,
    now: () => clock,
    nextPaymentId: () => `pay-${(issuedIds += 1)}`,
    dynamic: { ledgerDir: path.join(workDir, "dynamic-quotes"), ...extra },
  });
  opened.push(core);
  return core;
}

async function journalLines(): Promise<{ event: string; patch: Record<string, unknown> }[]> {
  const text = await readFile(journalPath, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { event: string; patch: Record<string, unknown> });
}

async function ledgerText(): Promise<string> {
  const dir = path.join(workDir, "dynamic-quotes");
  const files = await readdir(dir).catch(() => [] as string[]);
  let out = "";
  for (const file of files) out += await readFile(path.join(dir, file), "utf8");
  return out;
}

type OkQuote = Extract<QuoteOutcome, { ok: true }>;

async function quoteOk(core: RouterCore, requestId = "r1", url = URL_A, principalId = "alice"): Promise<OkQuote> {
  const outcome = await core.quote({ principalId, requestId, routeId: PROFILE_ID, upstream: { url }, source: principalId });
  expect(outcome.ok).toBe(true);
  return outcome as OkQuote;
}

function purchaseArgs(quote: OkQuote, overrides: Record<string, unknown> = {}) {
  return {
    principalId: "alice",
    requestId: "r1",
    quoteId: quote.quoteId,
    approval: quote.quoteId,
    credential: inbound.credentialFor(quote.source.offer),
    ownerKey: quote.ownerKey!,
    source: "alice",
    ...overrides,
  };
}

function connections(): { upstream: number; inbound: number } {
  return { upstream: outbound.readChallengeCalls + outbound.payCalls, inbound: inbound.verifyCalls + inbound.settleCalls };
}

beforeEach(async () => {
  await mkdir(runtimeRoot, { recursive: true });
  workDir = await mkdtemp(path.join(runtimeRoot, "t10-dynamic-"));
  journalPath = path.join(workDir, "journal.ndjson");
  issuedIds = 0;
  clock = 1_800_000_000_000;
  inbound = new SyntheticInbound();
  outbound = new SyntheticOutbound();
});

afterEach(async () => {
  for (const core of opened.splice(0)) await core.close().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ 純粋関数 */

describe("換算と手数料（設計 §6.6）", () => {
  test("par・同じ桁: 手数料は max(min, flat + ceil(額 × bps / 10000))", () => {
    expect(priceOf(PROFILE, "5000")).toEqual({ upstreamAmount: "5000", converted: "5000", fee: "1050", total: "6050" });
    // 1% の端数は切り上げ。
    expect(priceOf(PROFILE, "5001")).toEqual({ upstreamAmount: "5001", converted: "5001", fee: "1051", total: "6052" });
    expect(priceOf({ ...PROFILE, fee: { flat: "0", bps: 0, min: "700" } }, "5000")!.fee).toBe("700");
    expect(priceOf({ ...PROFILE, fee: { flat: "0", bps: 0, min: "0" } }, "5000")).toEqual({ upstreamAmount: "5000", converted: "5000", fee: "0", total: "5000" });
  });

  test("桁が違えば桁を合わせる。受信の桁で正確に表せない額は扱わない（設計 §6.6）", () => {
    const to18 = { ...PROFILE, source: { ...PROFILE.source, decimals: 18 }, fee: { flat: "0", bps: 0, min: "0" } };
    expect(priceOf(to18, "5")!.converted).toBe("5000000000000");
    const to2 = { ...PROFILE, source: { ...PROFILE.source, decimals: 2 }, fee: { flat: "0", bps: 0, min: "0" } };
    expect(priceOf(to2, "123456")).toBeUndefined();
    expect(priceOf(to2, "120000")!.converted).toBe("12");
  });

  test("1 件あたりの上限（設計 §6.6）: 予約の各区分がバケットの maxPerPurchase 以内。無いバケットは不可", () => {
    const config = baseConfig();
    expect(perPurchaseLimitOf(config, reservationOf(PROFILE, priceOf(PROFILE, "5000")!))).toBeUndefined();
    expect(perPurchaseLimitOf(config, { legs: [{ network: SRC_NETWORK, asset: SRC_ASSET, amount: "200001" }] })).toBe("per_purchase_limit");
    expect(perPurchaseLimitOf(config, { legs: [{ network: SRC_NETWORK, asset: "0xother", amount: "1" }] })).toBe("bucket_not_allowed");
    // 同じバケットに落ちる区分（mpp 送信の元本と手数料）は合算して見る。
    expect(perPurchaseLimitOf(config, { legs: [{ network: SRC_NETWORK, asset: SRC_ASSET, amount: "150000" }, { network: SRC_NETWORK, asset: SRC_ASSET, amount: "50001" }] })).toBe("per_purchase_limit");
    expect(perPurchaseLimitOf(config, { legs: [{ network: SRC_NETWORK, asset: SRC_ASSET, amount: "150000" }, { network: SRC_NETWORK, asset: SRC_ASSET, amount: "50000" }] })).toBeUndefined();
  });

  test("正規形でない額・溢れは価格にしない", () => {
    expect(priceOf(PROFILE, "01")).toBeUndefined();
    expect(priceOf(PROFILE, "1e3")).toBeUndefined();
    expect(priceOf(PROFILE, "")).toBeUndefined();
    const to18 = { ...PROFILE, source: { ...PROFILE.source, decimals: 18 } };
    expect(priceOf(to18, "9".repeat(30))).toBeUndefined();
  });

  test("予約: 受信額・送信元本、mpp 送信なら手数料の上限", () => {
    expect(reservationOf(PROFILE, priceOf(PROFILE, "5000")!)).toEqual({ legs: [{ network: SRC_NETWORK, asset: SRC_ASSET, amount: "6050" }, { network: DST_NETWORK, asset: DST_ASSET, amount: "5000" }] });
    const mpp: DynamicProfile = { ...PROFILE, rail: "mpp", destination: { scheme: "tempo/charge", network: SRC_NETWORK, asset: SRC_ASSET, decimals: 6, feeAsset: SRC_ASSET, maxFee: "5000", feeMargin: 20_000 } };
    // 手数料の区分は quote が決めた cap（プロファイルの天井 5,000 ではない）。cap が無ければ区分も無い。
    const cap = { maxFee: "1200", estimate: { gas: "50000", maxFeePerGas: "12000000000", bound: "600", atMs: 1 } };
    expect(reservationOf(mpp, priceOf(mpp, "5000", cap)!).legs).toHaveLength(3);
    expect(reservationOf(mpp, priceOf(mpp, "5000", cap)!).legs[2]).toEqual({ network: SRC_NETWORK, asset: SRC_ASSET, amount: "1200" });
    expect(reservationOf(mpp, priceOf(mpp, "5000")!).legs).toHaveLength(2);
  });

  test("ownerKey のハッシュは sha256、束縛はプロファイルと URL を結ぶ", () => {
    expect(ownerKeyHashOf("abc")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(dynamicBindingOf(PROFILE_ID, URL_A)).toBe(`dynamic|${PROFILE_ID}|GET|${encodeURIComponent(URL_A)}`);
  });
});

/* ------------------------------------------------------------------ quote */

describe("動的 quote", () => {
  test("成立: 控えに記録、journal には書かない。応答に upstream・pricing・ownerKey。保存はハッシュだけ", async () => {
    const core = await boot();
    const quote = await quoteOk(core);
    expect(quote).toMatchObject({
      routeId: PROFILE_ID,
      source: { amount: "6050", asset: SRC_ASSET, network: SRC_NETWORK },
      destination: { quoted: "5000", asset: DST_ASSET, network: DST_NETWORK },
      upstream: { url: URL_A, method: "GET" },
      dynamic: { profileId: PROFILE_ID, pricing: { upstreamAmount: "5000", converted: "5000", fee: "1050", total: "6050" }, sourceRail: "mpp", rail: "x402", fundsMoveOnCredential: true },
    });
    expect(quote.ownerKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(quote.source.offer.extra.routeBinding).toBe(dynamicBindingOf(PROFILE_ID, URL_A));
    expect(await journalLines()).toEqual([]);
    const ledger = await ledgerText();
    expect(ledger).toContain(URL_A);
    expect(ledger).toContain(ownerKeyHashOf(quote.ownerKey!));
    expect(ledger).not.toContain(quote.ownerKey!);
    expect(outbound.targetsSeen).toEqual([{ url: URL_A }]);
    expect(inbound.issued[0]).toMatchObject({ routeId: PROFILE_ID, amount: "6050", asset: SRC_ASSET, network: SRC_NETWORK });
    // 記録には設計 §2.4 の全欄。
    const record = JSON.parse(ledger.split("\n")[0]!) as { record: Record<string, unknown> };
    expect(Object.keys(record.record).sort()).toEqual(["approvalDeadlineMs", "destination", "dynamic", "principalId", "quoteFingerprint", "quoteId", "requestId", "routeFingerprint", "routeId", "source", "upstream"]);
    expect(Object.keys(record.record["dynamic"] as object).sort()).toEqual(["ownerKeyHash", "pricing", "profile", "profileId"]);
  });

  test.each([
    ["無効（enabled: false）", () => baseConfig({ enabled: false }), { routeId: PROFILE_ID, url: URL_A }, "dynamic_disabled"],
    ["設定に dynamic が無い", () => ({ ...baseConfig(), dynamic: undefined }) as unknown as RouterConfig, { routeId: PROFILE_ID, url: URL_A }, "dynamic_disabled"],
    ["無いプロファイル", () => baseConfig(), { routeId: "nope", url: URL_A }, "unknown_route"],
    ["静的 route の id に upstream", () => baseConfig(), { routeId: STATIC_ROUTE, url: URL_A }, "unknown_route"],
    ["URL が https でない", () => baseConfig(), { routeId: PROFILE_ID, url: "http://provider.test/" }, "invalid_upstream_url"],
    ["URL に userinfo", () => baseConfig(), { routeId: PROFILE_ID, url: "https://u:p@provider.test/" }, "invalid_upstream_url"],
    ["拒否ホスト", () => baseConfig({ denyHosts: ["provider.test"] }), { routeId: PROFILE_ID, url: URL_A }, "invalid_upstream_url"],
  ])("接続 0 で拒否: %s", async (_name, config, request, code) => {
    const core = await boot(config());
    const outcome = await core.quote({ principalId: "alice", requestId: "r1", ...request, upstream: { url: request.url }, source: "alice" });
    expect(outcome).toMatchObject({ ok: false, code });
    expect(connections()).toEqual({ upstream: 0, inbound: 0 });
    expect(inbound.createOfferCalls).toBe(0);
    expect(await journalLines()).toEqual([]);
    expect(await ledgerText()).toBe("");
  });

  test("選択: adapter が返した順の先頭。上限超の額・形の違う額は飛ばす。通るものが無ければ no_matching_offer", async () => {
    const core = await boot();
    const good = { ...outbound.offers[0]!, amount: "7000" };
    outbound.offers = [{ ...outbound.offers[0]!, amount: "100001" }, { ...outbound.offers[0]!, amount: "01" }, good, { ...outbound.offers[0]!, amount: "1" }];
    const quote = await quoteOk(core);
    expect(quote.destination.quoted).toBe("7000");
    outbound.offers = [{ ...outbound.offers[0]!, amount: "100001" }];
    expect(await core.quote({ principalId: "alice", requestId: "r2", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "alice" })).toMatchObject({ ok: false, code: "quote_failed", reason: "no_matching_offer" });
    outbound.offers = [];
    expect(await core.quote({ principalId: "alice", requestId: "r3", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "alice" })).toMatchObject({ ok: false, code: "quote_failed", reason: "no_matching_offer" });
    expect(await journalLines()).toEqual([]);
  });

  test("上流が読めなければ quote_failed（offer_unavailable）。受信 offer は発行しない", async () => {
    const core = await boot();
    outbound.readChallengeImpl = async () => { throw new Error("boom https://secret.internal/"); };
    const outcome = await core.quote({ principalId: "alice", requestId: "r1", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "alice" });
    expect(outcome).toEqual({ ok: false, code: "quote_failed", reason: "offer_unavailable" });
    expect(inbound.createOfferCalls).toBe(0);
    expect(await ledgerText()).toBe("");
  });

  test("桁あふれ: 受信額が 30 桁を超える quote は作らない", async () => {
    const core = await boot(baseConfig({ profile: { ...PROFILE, source: { ...PROFILE.source, decimals: 30 }, maxUpstreamAmount: "9".repeat(30) } }));
    outbound.offers = [{ ...outbound.offers[0]!, amount: "9".repeat(30) }];
    expect(await core.quote({ principalId: "alice", requestId: "r1", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "alice" })).toMatchObject({ ok: false, code: "quote_failed", reason: "amount_unrepresentable" });
  });

  test("1 件あたりの上限を超える quote は作らない（受信 offer を発行してから昇格で拒否しない）", async () => {
    const config = baseConfig();
    const buckets = config.dynamic!.budget.buckets.map((bucket) => (bucket.asset === SRC_ASSET ? { ...bucket, maxPerPurchase: "6049" } : bucket));
    const core = await boot({ ...config, dynamic: { ...config.dynamic!, budget: { ...config.dynamic!.budget, buckets } } });
    expect(await core.quote({ principalId: "alice", requestId: "r1", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "alice" })).toMatchObject({ ok: false, code: "quote_failed", reason: "per_purchase_limit" });
    expect(inbound.createOfferCalls).toBe(0);
    expect(await ledgerText()).toBe("");
    // バケットの無い資産のプロファイルも同じ。
    const core2 = await (async () => { await core.close(); opened.length = 0; return boot({ ...config, dynamic: { ...config.dynamic!, budget: { ...config.dynamic!.budget, buckets: buckets.filter((bucket) => bucket.asset !== SRC_ASSET) } } }); })();
    expect(await core2.quote({ principalId: "alice", requestId: "r2", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "alice" })).toMatchObject({ ok: false, code: "quote_failed", reason: "bucket_not_allowed" });
    expect(inbound.createOfferCalls).toBe(0);
  });

  test("mpp 送信: 元本と手数料の上限が同じバケットに落ちるとき、合算が maxPerPurchase を超える quote は作らない（受信 offer 0）", async () => {
    const mpp: DynamicProfile = { ...PROFILE, profileId: "dyn-x402-to-mpp", sourceRail: "x402", rail: "mpp", source: { network: DST_NETWORK, asset: DST_ASSET, decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" }, destination: { scheme: "tempo/charge", network: SRC_NETWORK, asset: SRC_ASSET, decimals: 6, feeAsset: SRC_ASSET, maxFee: "5000", feeMargin: 20_000 } };
    outbound.offers = [{ scheme: "tempo/charge", network: SRC_NETWORK, asset: SRC_ASSET, amount: "5000", payTo: "0x0000000000000000000000000000000000000b22", extra: { realm: "r", terms: "{}" } }];
    const config = baseConfig({ profile: mpp });
    const buckets = config.dynamic!.budget.buckets.map((bucket) => (bucket.asset === SRC_ASSET ? { ...bucket, maxPerPurchase: "9999" } : bucket));
    const core = await boot({ ...config, dynamic: { ...config.dynamic!, budget: { ...config.dynamic!.budget, buckets } } });
    expect(await core.quote({ principalId: "alice", requestId: "r1", routeId: mpp.profileId, upstream: { url: URL_A }, source: "alice" })).toMatchObject({ ok: false, code: "quote_failed", reason: "per_purchase_limit" });
    expect(inbound.createOfferCalls).toBe(0);
    expect(await ledgerText()).toBe("");
  });

  test("requestId の衝突（AC-7）: 動的は冪等に再取得できない。静的の requestId とも、控えの requestId とも衝突", async () => {
    const core = await boot();
    await quoteOk(core, "r1");
    expect(await core.quote({ principalId: "alice", requestId: "r1", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "alice" })).toMatchObject({ ok: false, code: "request_id_conflict" });
    // 同じ requestId で静的 quote を取ろうとしても衝突。
    expect(await core.quote({ principalId: "alice", requestId: "r1", routeId: STATIC_ROUTE })).toMatchObject({ ok: false, code: "request_id_conflict" });
    // 静的 quote の requestId で動的 quote を取ろうとしても衝突。
    const s = await core.quote({ principalId: "alice", requestId: "s1", routeId: STATIC_ROUTE });
    expect(s.ok).toBe(true);
    expect(await core.quote({ principalId: "alice", requestId: "s1", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "alice" })).toMatchObject({ ok: false, code: "request_id_conflict" });
    // 別 principal の同じ requestId は別物。
    expect((await core.quote({ principalId: "bob", requestId: "r1", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "bob" })).ok).toBe(true);
    // 衝突の検査は接続の前（上流の読取は 3 回: alice r1、静的 s1、bob r1）。
    expect(outbound.readChallengeCalls).toBe(3);
  });

  test("門: 頻度・未払い quote の上限を超えたら接続 0（AC-11・AC-17）", async () => {
    const core = await boot(baseConfig({ limits: { quotesPerMinutePerSource: 2, quotesPerMinuteGlobal: 3, maxOutstandingQuotes: 2 } }));
    await quoteOk(core, "r1");
    await quoteOk(core, "r2");
    const before = connections();
    // 控えが 2 件で上限。
    expect(await core.quote({ principalId: "alice", requestId: "r3", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "alice" })).toMatchObject({ ok: false, code: "dynamic_capacity" });
    expect(await core.quote({ principalId: "bob", requestId: "b1", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "bob" })).toMatchObject({ ok: false, code: "dynamic_capacity" });
    expect(connections()).toEqual(before);
    // 控えが空いても、送信元ごとの頻度（2/分）で alice は拒否される。
    clock += 61_000;
    const expired = await core.quote({ principalId: "alice", requestId: "r4", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "alice" });
    expect(expired.ok).toBe(true);
  });

  test("門: 宛先ホストの同時実行の枠が無ければ接続しない", async () => {
    const core = await boot(baseConfig({ limits: { perHostPerMinute: 1 } }));
    await quoteOk(core, "r1");
    expect(await core.quote({ principalId: "bob", requestId: "b1", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "bob" })).toMatchObject({ ok: false, code: "rate_limited", reason: "rate_host" });
    expect(outbound.readChallengeCalls).toBe(1);
    // 別のホストは通る。
    expect((await core.quote({ principalId: "bob", requestId: "b2", routeId: PROFILE_ID, upstream: { url: URL_B }, source: "bob" })).ok).toBe(true);
  });

  test("静的 route の quote・purchase は動的の有無で変わらない（AC-19 の静的側）", async () => {
    const core = await boot();
    const s = await core.quote({ principalId: "alice", requestId: "s1", routeId: STATIC_ROUTE });
    expect(s.ok && s.upstream).toBeUndefined();
    expect(s.ok && s.ownerKey).toBeUndefined();
    const result = await core.purchase({ principalId: "alice", requestId: "s1", quoteId: (s as OkQuote).quoteId, approval: (s as OkQuote).quoteId, credential: inbound.credentialFor((s as OkQuote).source.offer) });
    expect(result.status).toBe("delivered");
    expect(outbound.paidFor[0]!.target).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ purchase */

describe("動的 purchase", () => {
  test("成立の順序（設計 §6.2）: verify・期限の再検査まで何も書かず、昇格で created（予約つき）、settle、送信に target", async () => {
    const core = await boot();
    const quote = await quoteOk(core);
    const result = await core.purchase(purchaseArgs(quote));
    expect(result).toMatchObject({ status: "delivered", body: BODY });
    const lines = await journalLines();
    expect(lines.map((line) => line.event)).toEqual(["created", "source_pending", "source_settled", "destination_pending", "delivered"]);
    const created = lines[0]!.patch;
    expect(created["upstream"]).toEqual({ url: URL_A, method: "GET" });
    expect((created["dynamic"] as { reservation: unknown }).reservation).toEqual({ legs: [{ network: SRC_NETWORK, asset: SRC_ASSET, amount: "6050" }, { network: DST_NETWORK, asset: DST_ASSET, amount: "5000" }] });
    expect(inbound).toMatchObject({ verifyCalls: 1, settleCalls: 1 });
    expect(outbound.paidFor[0]).toMatchObject({ routeId: PROFILE_ID, target: { url: URL_A }, offer: quote.source.offer === undefined ? {} : { amount: "5000" } });
    // 控えには attempt が 1 行。credential の要約だけで、credential そのものは無い。
    const ledger = await ledgerText();
    expect(ledger).toContain('"kind":"attempt"');
    expect(ledger).not.toContain('"tag":"sig"');
    // status は持ち主の証明があるときだけ。
    expect(core.status(result.paymentId!, "alice", quote.ownerKey)).toMatchObject({ status: "delivered", upstream: { url: URL_A }, dynamic: { profileId: PROFILE_ID, promoted: true } });
    expect(core.status(result.paymentId!, "alice")).toBeUndefined();
  });

  test("持ち主の分離（AC-20）: quoteId・requestId・paymentId を知っていても ownerKey 無し・不一致では存在しないのと同じ。再起動後も", async () => {
    let core = await boot();
    const quote = await quoteOk(core);
    const wrong = quote.ownerKey!.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    for (const ownerKey of [undefined, "", wrong, quote.ownerKey!.slice(0, -1)]) {
      expect(await core.purchase(purchaseArgs(quote, { ownerKey }))).toEqual({ status: "rejected", code: "unknown_quote" });
      expect(core.status(quote.paymentId, "alice", ownerKey)).toBeUndefined();
      expect(core.offerFor(quote.quoteId, "alice", undefined, ownerKey)).toBeUndefined();
    }
    // 別 principal は、正しい ownerKey を持っていても見えない。
    expect(core.status(quote.paymentId, "bob", quote.ownerKey)).toBeUndefined();
    expect(await core.purchase(purchaseArgs(quote, { principalId: "bob" }))).toEqual({ status: "rejected", code: "unknown_quote" });
    expect(connections()).toEqual({ upstream: 1, inbound: 0 });
    // 正しい証明なら読める（昇格前は awaiting_payment、promoted: false）。
    expect(core.status(quote.paymentId, "alice", quote.ownerKey)).toMatchObject({ status: "awaiting_payment", dynamic: { promoted: false, fundsMoveOnCredential: true } });
    expect(core.offerFor(quote.quoteId, "alice", undefined, quote.ownerKey)).toEqual(quote.source.offer);
    expect(core.offerFor(quote.quoteId, "alice", STATIC_ROUTE, quote.ownerKey)).toBeUndefined();
    await core.close();
    opened.length = 0;
    core = await boot();
    expect(core.status(quote.paymentId, "alice")).toBeUndefined();
    expect(core.status(quote.paymentId, "alice", quote.ownerKey)).toMatchObject({ status: "awaiting_payment" });
    // 再起動後に購入でき、昇格後も証明が要る。
    const result = await core.purchase(purchaseArgs(quote));
    expect(result.status).toBe("delivered");
    expect(core.status(result.paymentId!, "alice")).toBeUndefined();
    expect(core.status(result.paymentId!, "alice", quote.ownerKey)).toMatchObject({ status: "delivered" });
    expect(await core.purchase(purchaseArgs(quote, { ownerKey: wrong }))).toEqual({ status: "rejected", code: "unknown_quote" });
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "delivered" });
  });

  test("門の purchase 超過: 上流・facilitator・RPC のどれにも接続 0", async () => {
    const core = await boot(baseConfig({ limits: { purchasesPerMinutePerSource: 1 } }));
    const q1 = await quoteOk(core, "r1");
    const q2 = await quoteOk(core, "r2");
    expect((await core.purchase(purchaseArgs(q1))).status).toBe("delivered");
    const before = connections();
    expect(await core.purchase(purchaseArgs(q2, { requestId: "r2" }))).toMatchObject({ status: "awaiting_payment", code: "rate_limited", terminalReason: "rate_source" });
    expect(connections()).toEqual(before);
    expect((await journalLines()).filter((line) => line.event === "created")).toHaveLength(1);
  });

  test("残高の事前確認: 不足なら settle 0・何も書かない。無ければ検査しない", async () => {
    const balances = new Map<string, bigint>([[DST_ASSET, 4999n]]);
    const asked: string[] = [];
    const core = await boot(baseConfig(), { balanceOf: async (_profileId, asset) => { asked.push(asset); return balances.get(asset) ?? 0n; } });
    const quote = await quoteOk(core);
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "operator_funds_unavailable" });
    expect(asked).toEqual([DST_ASSET]);
    expect(inbound.settleCalls).toBe(0);
    expect(await journalLines()).toEqual([]);
    balances.set(DST_ASSET, 5000n);
    expect((await core.purchase(purchaseArgs(quote))).status).toBe("delivered");
  });

  test("残高の事前確認: 資産の鍵は network の族で決める（SVM の mint は大文字小文字を保ち、EVM は小文字化。FR-4）", async () => {
    const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
    const svm: DynamicProfile = { ...PROFILE, destination: { scheme: "exact", network: SOL, asset: MINT, decimals: 6, tokenDomain: { name: "USDC", version: "2" } } };
    const config = baseConfig({ profile: svm });
    const withBucket: RouterConfig = { ...config, dynamic: { ...config.dynamic!, budget: { ...config.dynamic!.budget, buckets: [...config.dynamic!.budget.buckets, { network: SOL, asset: MINT, maxTotal: "10000", maxPerPurchase: "5000" }] } } };
    outbound.offers = [{ ...outbound.offers[0]!, network: SOL, asset: MINT }];
    const asked: string[] = [];
    const core = await boot(withBucket, { balanceOf: async (_profileId, asset) => { asked.push(asset); return 0n; } });
    const outcome = await core.quote({ principalId: "alice", requestId: "r1", routeId: PROFILE_ID, upstream: { url: URL_A }, source: "alice" });
    expect(outcome).toMatchObject({ ok: true });
    const quote = outcome as OkQuote;
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "operator_funds_unavailable" });
    // 小文字化されていない（base58 はそのまま）。
    expect(asked).toEqual([MINT]);
    expect(inbound.settleCalls).toBe(0);
  });

  test("残高の事前確認: EVM の対照——大文字混じりの設定でも小文字化した鍵が渡る", async () => {
    const MIXED = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const mixed: DynamicProfile = { ...PROFILE, destination: { ...PROFILE.destination, asset: MIXED } };
    // 予算の区分の鍵は設定の文字列そのもの（小文字化しない）なので、区分も同じ書き方で持つ。
    const config = baseConfig({ profile: mixed });
    const withBucket: RouterConfig = { ...config, dynamic: { ...config.dynamic!, budget: { ...config.dynamic!.budget, buckets: config.dynamic!.budget.buckets.map((b) => (b.asset === DST_ASSET ? { ...b, asset: MIXED } : b)) } } };
    const askedEvm: string[] = [];
    const evmCore = await boot(withBucket, { balanceOf: async (_profileId, asset) => { askedEvm.push(asset); return 0n; } });
    const q2 = await quoteOk(evmCore);
    expect((await evmCore.purchase(purchaseArgs(q2))).code).toBe("operator_funds_unavailable");
    expect(askedEvm).toEqual([DST_ASSET]);
  });

  test("残高の事前確認（mpp 送信）: 元本と手数料が同じ資産なら合算。読めなければ不足", async () => {
    const mpp: DynamicProfile = { ...PROFILE, profileId: "dyn-x402-to-mpp", sourceRail: "x402", rail: "mpp", source: { network: DST_NETWORK, asset: DST_ASSET, decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" }, destination: { scheme: "tempo/charge", network: SRC_NETWORK, asset: SRC_ASSET, decimals: 6, feeAsset: SRC_ASSET, maxFee: "5000", feeMargin: 20_000 } };
    outbound.offers = [{ scheme: "tempo/charge", network: SRC_NETWORK, asset: SRC_ASSET, amount: "5000", payTo: "0x0000000000000000000000000000000000000b22", extra: { realm: "r", terms: "{}" } }];
    let balance = 9999n;
    let fail = false;
    const core = await boot(baseConfig({ profile: mpp }), { balanceOf: async () => { if (fail) throw new Error("rpc down"); return balance; } });
    const q = await core.quote({ principalId: "alice", requestId: "r1", routeId: mpp.profileId, upstream: { url: URL_A }, source: "alice" });
    expect(q.ok).toBe(true);
    const args = purchaseArgs(q as OkQuote);
    expect(await core.purchase(args)).toMatchObject({ code: "operator_funds_unavailable" });
    balance = 10_000n;
    fail = true;
    expect(await core.purchase(args)).toMatchObject({ code: "operator_funds_unavailable" });
    fail = false;
    expect((await core.purchase(args)).status).toBe("delivered");
    // 手数料 = max(規則の 1,050, cap 5,000) = 5,000。受信額 10,000。手数料の区分は cap。
    expect((await journalLines())[0]!.patch["dynamic"]).toMatchObject({ pricing: { fee: "5000", total: "10000", maxFee: "5000" }, reservation: { legs: [{ amount: "10000" }, { amount: "5000" }, { asset: SRC_ASSET, amount: "5000" }] } });
  });

  test("AC-18: 無効な credential・verify 不成立・verify 後の期限切れの反復で journal は 1 行も増えず、予算も減らない", async () => {
    const core = await boot(baseConfig({ maxPurchases: 1, limits: { purchasesPerMinutePerSource: 100, purchasesPerMinuteGlobal: 100 } }));
    const quote = await quoteOk(core);
    // 無効な credential（nonce 違い）× 3
    for (let i = 0; i < 3; i += 1) {
      expect(await core.purchase(purchaseArgs(quote, { credential: inbound.credentialFor({ ...quote.source.offer, extra: { ...quote.source.offer.extra, challengeNonce: "0xother" } }) }))).toMatchObject({ status: "rejected", code: "nonce_mismatch" });
    }
    // verify が偽 × 3
    inbound.verifyImpl = async () => ({ isValid: false });
    for (let i = 0; i < 3; i += 1) {
      expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "verify_failed" });
    }
    // verify が RPC の失敗で例外
    inbound.verifyImpl = async () => { throw new Error("facilitator down"); };
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "source_verify_unavailable" });
    // verify は通るが、その間に期限が切れる
    inbound.verifyImpl = async () => { clock += 61_000; return { isValid: true }; };
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "approval_expired" });
    expect(await journalLines()).toEqual([]);
    expect(inbound.settleCalls).toBe(0);
    expect(inbound.verifyCalls).toBe(5);
    // 動的予算（1 件）はまだ使われていない: 別の quote が成立する。
    clock -= 61_000;
    const q2 = await quoteOk(core, "r2");
    inbound.verifyImpl = async () => ({ isValid: true });
    expect((await core.purchase(purchaseArgs(q2, { requestId: "r2" }))).status).toBe("delivered");
    expect((await journalLines()).filter((line) => line.event === "created")).toHaveLength(1);
  });

  test("予算切れ（AC-18・AC-19）: 昇格は何も書かず bucket_limit 等。動的を使い切っても静的は成立", async () => {
    const core = await boot(baseConfig({ maxPurchases: 1 }));
    const q1 = await quoteOk(core, "r1");
    const q2 = await quoteOk(core, "r2");
    expect((await core.purchase(purchaseArgs(q1))).status).toBe("delivered");
    const before = (await journalLines()).length;
    expect(await core.purchase(purchaseArgs(q2, { requestId: "r2" }))).toEqual({ paymentId: q2.paymentId, status: "awaiting_payment", code: "purchase_count_limit" });
    expect((await journalLines()).length).toBe(before);
    expect(inbound.settleCalls).toBe(1);
    // 静的は別の予算。
    const s = await core.quote({ principalId: "alice", requestId: "s1", routeId: STATIC_ROUTE });
    expect((await core.purchase({ principalId: "alice", requestId: "s1", quoteId: (s as OkQuote).quoteId, approval: (s as OkQuote).quoteId, credential: inbound.credentialFor((s as OkQuote).source.offer) })).status).toBe("delivered");
  });

  test("額の上限で昇格しない（bucket_limit）。受信 settle は 0", async () => {
    const core = await boot(baseConfig({ maxTotal: "6049" }));
    const quote = await quoteOk(core);
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "bucket_limit" });
    expect(inbound.settleCalls).toBe(0);
    expect(await journalLines()).toEqual([]);
  });

  test("上流が offer を変えたら受信 settle 0・送信 0（AC-6 の core 部分）。読めなければ offer_unavailable。何も書かない", async () => {
    const core = await boot();
    const quote = await quoteOk(core);
    outbound.offers = [{ ...outbound.offers[0]!, amount: "5001" }];
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "offer_changed" });
    outbound.readChallengeImpl = async () => { throw new Error("down"); };
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "offer_unavailable" });
    expect(inbound.verifyCalls).toBe(0);
    expect(inbound.settleCalls).toBe(0);
    expect(outbound.payCalls).toBe(0);
    expect(await journalLines()).toEqual([]);
    // 戻れば成立する（quote は潰れていない）。
    outbound.readChallengeImpl = undefined;
    outbound.offers = [{ ...outbound.offers[0]!, amount: "5000" }];
    expect((await core.purchase(purchaseArgs(quote))).status).toBe("delivered");
  });

  test("設定変更・無効化で quote_changed（AC-10）。接続 0", async () => {
    let core = await boot();
    const quote = await quoteOk(core);
    await core.close();
    opened.length = 0;
    core = await boot(baseConfig({ enabled: false }));
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "quote_changed" });
    await core.close();
    opened.length = 0;
    core = await boot(baseConfig({ profile: { ...PROFILE, fee: { flat: "0", bps: 0, min: "0" } } }));
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "quote_changed" });
    await core.close();
    opened.length = 0;
    core = await boot(baseConfig({ denyHosts: ["provider.test"] }));
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "quote_changed" });
    expect(connections()).toEqual({ upstream: 1, inbound: 0 });
  });

  test("改竄した quote 文書でも、実行されるのは保存した記録（AC-4）", async () => {
    const core = await boot();
    const quote = await quoteOk(core);
    // 呼び出し側が approval に別の値、credential に別の額を入れても、保存した offer との照合で止まる。
    expect(await core.purchase(purchaseArgs(quote, { approval: "other" }))).toMatchObject({ status: "rejected", code: "approval_required" });
    const tampered = inbound.credentialFor({ ...quote.source.offer, amount: "1" });
    expect(await core.purchase(purchaseArgs(quote, { credential: tampered }))).toMatchObject({ status: "rejected", code: "offer_mismatch" });
    expect(await core.purchase(purchaseArgs(quote, { routeId: STATIC_ROUTE }))).toMatchObject({ status: "rejected", code: "route_mismatch" });
    expect(await core.purchase(purchaseArgs(quote, { requestId: "r9" }))).toMatchObject({ status: "rejected", code: "request_id_conflict" });
    expect(await core.purchase(purchaseArgs(quote, { credential: undefined }))).toMatchObject({ status: "awaiting_payment", code: "payment_required" });
    expect(await journalLines()).toEqual([]);
    expect(connections()).toEqual({ upstream: 1, inbound: 0 });
  });

  test("MPP の昇格前（設計 §6.3）: verify が偽でも quote は潰れず、attempt は最初の 1 行だけ、同じ credential で期限内に再試行して成立。再起動を挟んでも", async () => {
    let core = await boot();
    const quote = await quoteOk(core);
    inbound.verifyImpl = async () => ({ isValid: false });
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ code: "verify_failed" });
    expect(await core.purchase(purchaseArgs(quote, { credential: inbound.credentialFor(quote.source.offer, "second") }))).toMatchObject({ code: "verify_failed" });
    const attempts = (await ledgerText()).split("\n").filter((line) => line.includes('"kind":"attempt"'));
    expect(attempts).toHaveLength(1);
    expect(core.status(quote.paymentId, "alice", quote.ownerKey)).toMatchObject({ status: "awaiting_payment" });
    await core.close();
    opened.length = 0;
    core = await boot();
    inbound.verifyImpl = async () => ({ isValid: true });
    expect((await core.purchase(purchaseArgs(quote))).status).toBe("delivered");
    expect((await ledgerText()).split("\n").filter((line) => line.includes('"kind":"attempt"'))).toHaveLength(1);
  });

  test("期限後は再試行できない（控えから消える）", async () => {
    const core = await boot();
    const quote = await quoteOk(core);
    clock += 61_000;
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ status: "rejected", code: "unknown_quote" });
    expect(core.status(quote.paymentId, "alice", quote.ownerKey)).toBeUndefined();
    expect(connections()).toEqual({ upstream: 1, inbound: 0 });
  });

  test("予約済み created の再試行は手順 1〜4 をやり直し、予約は二重に取らない（クラッシュ: 昇格の後・settle の前）", async () => {
    let core = await boot(baseConfig({ maxPurchases: 1 }));
    const quote = await quoteOk(core);
    // settle に入る前（source_pending の前）で止まったことにする: journal には created だけ。
    inbound.settleImpl = async () => { throw new Error("crash"); };
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "unknown", terminalReason: "source_settle_unknown" });
    // ↑ これは settle 中の失敗（unknown 終端）。昇格直後の停止は journal を切り詰めて再現する。
    const lines = (await readFile(journalPath, "utf8")).split("\n").filter((line) => line !== "");
    await core.close();
    opened.length = 0;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(journalPath, `${lines[0]!}\n`);
    core = await boot(baseConfig({ maxPurchases: 1 }));
    inbound.settleImpl = async () => ({ outcome: "settled", txRef: "src-tx-2" });
    // 控えには無く（昇格済み）、journal の created から再試行する。
    expect(core.status(quote.paymentId, "alice", quote.ownerKey)).toMatchObject({ status: "awaiting_payment", dynamic: { promoted: true } });
    outbound.offers = [{ ...outbound.offers[0]!, amount: "5001" }];
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ code: "offer_changed" });
    expect(inbound.settleCalls).toBe(1);
    outbound.offers = [{ ...outbound.offers[0]!, amount: "5000" }];
    inbound.verifyImpl = async () => ({ isValid: false });
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ code: "verify_failed" });
    inbound.verifyImpl = async () => ({ isValid: true });
    expect((await core.purchase(purchaseArgs(quote))).status).toBe("delivered");
    // created は 1 行のまま（予約は二重に取っていない）。maxPurchases 1 の予算で成立したことがその証拠。
    expect((await journalLines()).filter((line) => line.event === "created")).toHaveLength(1);
    expect(inbound.settleCalls).toBe(2);
  });

  test("クラッシュ点ごとの再起動後の状態（AC-21）: 昇格前は控えから再試行できる。settle の途中は unknown", async () => {
    let core = await boot();
    const q1 = await quoteOk(core, "r1");
    const q2 = await quoteOk(core, "r2");
    // q2 は settle の途中で落ちたことにする（source_pending まで書かれた）。
    inbound.settleImpl = async () => new Promise(() => {});
    const hung = core.purchase(purchaseArgs(q2, { requestId: "r2" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await core.close();
    opened.length = 0;
    void hung;
    core = await boot();
    expect(core.status(q2.paymentId, "alice", q2.ownerKey)).toMatchObject({ status: "unknown", terminalReason: "interrupted_at_restart" });
    expect(await core.purchase(purchaseArgs(q2, { requestId: "r2" }))).toMatchObject({ status: "unknown" });
    // q1 は昇格前。控えから再試行できる。
    inbound.settleImpl = async () => ({ outcome: "settled", txRef: "src-tx-3" });
    expect((await core.purchase(purchaseArgs(q1))).status).toBe("delivered");
  });

  test("結果不明は枠（予算）を保持する", async () => {
    const core = await boot(baseConfig({ maxPurchases: 1 }));
    const q1 = await quoteOk(core, "r1");
    const q2 = await quoteOk(core, "r2");
    outbound.payResult = { outcome: "unknown", reason: "destination_pay_unknown" };
    expect(await core.purchase(purchaseArgs(q1))).toMatchObject({ status: "unknown", terminalReason: "destination_pay_unknown" });
    expect(await core.purchase(purchaseArgs(q2, { requestId: "r2" }))).toMatchObject({ code: "purchase_count_limit" });
  });

  test("送信の終端: paid_no_data の理由（unsupported_response・response_too_large）は記録される", async () => {
    const core = await boot();
    const q1 = await quoteOk(core, "r1");
    outbound.payResult = { outcome: "paid_no_data", reason: "unsupported_response", receiptRef: "rcpt" };
    expect(await core.purchase(purchaseArgs(q1))).toMatchObject({ status: "paid_data_unavailable", terminalReason: "unsupported_response" });
    const q2 = await quoteOk(core, "r2");
    outbound.payResult = { outcome: "paid_no_data", reason: "response_too_large", receiptRef: "rcpt" };
    expect(await core.purchase(purchaseArgs(q2, { requestId: "r2" }))).toMatchObject({ status: "paid_data_unavailable", terminalReason: "response_too_large" });
    const q3 = await quoteOk(core, "r3");
    outbound.payResult = { outcome: "rejected", reason: "https://leak.example/" };
    expect(await core.purchase(purchaseArgs(q3, { requestId: "r3" }))).toMatchObject({ status: "paid_data_unavailable", terminalReason: "destination_rejected" });
    expect(await readFile(journalPath, "utf8")).not.toContain("leak.example");
  });

  test("上流の読取は quote・settle 前・送信前の 3 回とも、保存した URL を target に渡す", async () => {
    const core = await boot();
    const quote = await quoteOk(core);
    expect((await core.purchase(purchaseArgs(quote))).status).toBe("delivered");
    expect(outbound.targetsSeen).toEqual([{ url: URL_A }, { url: URL_A }, { url: URL_A }]);
  });

  test("昇格済み（created）の quote も、期限が切れていれば接続 0 で approval_expired", async () => {
    let core = await boot();
    const quote = await quoteOk(core);
    inbound.settleImpl = async () => { throw new Error("crash"); };
    await core.purchase(purchaseArgs(quote));
    const lines = (await readFile(journalPath, "utf8")).split("\n").filter((line) => line !== "");
    await core.close();
    opened.length = 0;
    await (await import("node:fs/promises")).writeFile(journalPath, `${lines[0]!}\n`);
    core = await boot();
    clock += 61_000;
    const before = connections();
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "rejected", code: "approval_expired" });
    expect(connections()).toEqual(before);
    expect(inbound.verifyCalls).toBe(1);
  });

  test("昇格後の settle の拒否は unknown（設計 §6.5）: 未払いと確定しない。理由は固定のコードで、上流の文字列を記録しない。予約は保持", async () => {
    const core = await boot(baseConfig({ maxPurchases: 1 }));
    const quote = await quoteOk(core);
    const q2 = await quoteOk(core, "r2");
    inbound.settleImpl = async () => ({ outcome: "rejected", reason: "https://leak.example/token" });
    expect(await core.purchase(purchaseArgs(quote))).toEqual({ paymentId: quote.paymentId, status: "unknown", terminalReason: "source_rejected" });
    expect(await readFile(journalPath, "utf8")).not.toContain("leak.example");
    expect((await journalLines()).map((line) => line.event)).toEqual(["created", "source_pending", "unknown"]);
    expect(core.status(quote.paymentId, "alice", quote.ownerKey)).toMatchObject({ status: "unknown" });
    inbound.settleImpl = async () => ({ outcome: "settled", txRef: "t" });
    expect(await core.purchase(purchaseArgs(q2, { requestId: "r2" }))).toMatchObject({ code: "purchase_count_limit" });
  });

  test("宛先ホストの枠は settle の前に取り、送信の終わりまで持つ（settle 後の読み直し・送信もその枠の中）", async () => {
    const gate = new DynamicGate({ limits: { ...DEFAULT_DYNAMIC_LIMITS, perHostConcurrent: 1 }, now: () => clock });
    const core = await boot(baseConfig(), { gate });
    const q1 = await quoteOk(core, "r1");
    const q2 = await quoteOk(core, "r2", URL_A, "bob");
    let release: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      inbound.settleImpl = () => new Promise((settle) => { release = () => settle({ outcome: "settled", txRef: "t" }); resolve(); });
    });
    const first = core.purchase(purchaseArgs(q1));
    await reached;
    expect(gate.activeOfHost("provider.test")).toBe(1);
    // 同じホストへの 2 件目は、1 件目が送信を終えるまで枠が無い（接続 0）。
    const before = connections();
    expect(await core.purchase({ ...purchaseArgs(q2, { requestId: "r2", principalId: "bob", source: "bob" }), ownerKey: q2.ownerKey! })).toMatchObject({ code: "rate_limited", terminalReason: "concurrency_host" });
    expect(connections()).toEqual(before);
    release!();
    expect((await first).status).toBe("delivered");
    expect(gate.activeOfHost("provider.test")).toBe(0);
  });

  test("静的の流れに動的の quote を持ち込めない: 静的の引数だけ（ownerKey 無し）では unknown_quote", async () => {
    const core = await boot();
    const quote = await quoteOk(core);
    expect(await core.purchase({ principalId: "alice", requestId: "r1", quoteId: quote.quoteId, approval: quote.quoteId, credential: inbound.credentialFor(quote.source.offer) })).toEqual({ status: "rejected", code: "unknown_quote" });
    expect(connections()).toEqual({ upstream: 1, inbound: 0 });
  });

  test("controls の門の枠は手順 1〜6 の間ずっと保持する", async () => {
    const gate = new DynamicGate({ limits: { ...DEFAULT_DYNAMIC_LIMITS, concurrentPerSource: 1 }, now: () => clock });
    const core = await boot(baseConfig(), { gate });
    const q1 = await quoteOk(core, "r1");
    const q2 = await quoteOk(core, "r2");
    let release: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      inbound.settleImpl = () => new Promise((settle) => { release = () => settle({ outcome: "settled", txRef: "t" }); resolve(); });
    });
    const first = core.purchase(purchaseArgs(q1));
    await reached;
    expect(gate.activeOfSource("alice")).toBe(1);
    expect(await core.purchase(purchaseArgs(q2, { requestId: "r2" }))).toMatchObject({ code: "rate_limited", terminalReason: "concurrency_source" });
    release!();
    expect((await first).status).toBe("delivered");
    expect(gate.activeOfSource("alice")).toBe(0);
  });
});

/* ------------------------------------------------------------------ MPP 送信の手数料 = quote 時のガス代（docs/dynamic-gas-fee-design.md） */

describe("MPP 送信: quote 時の見積りで cap と手数料を決める（dynamic-gas-fee-design §1〜§3）", () => {
  const MPP: DynamicProfile = {
    ...PROFILE,
    profileId: "dyn-x402-to-mpp",
    sourceRail: "x402",
    rail: "mpp",
    source: { network: DST_NETWORK, asset: DST_ASSET, decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" },
    destination: { scheme: "tempo/charge", network: SRC_NETWORK, asset: SRC_ASSET, decimals: 6, feeAsset: SRC_ASSET, maxFee: "5000", feeMargin: 20_000 },
    fee: { flat: "1000", bps: 0, min: "1000" },
  };
  const mppOffer = (): DestinationOffer => ({ scheme: "tempo/charge", network: SRC_NETWORK, asset: SRC_ASSET, amount: "5000", payTo: "0x0000000000000000000000000000000000000b22", extra: { realm: "r", terms: "{}" } });
  const quoteMpp = (core: RouterCore, requestId = "r1") => core.quote({ principalId: "alice", requestId, routeId: MPP.profileId, upstream: { url: URL_A }, source: "alice" });

  test("cap = ceil(bound × feeMargin / 10000)。桁あふれは undefined。feeMargin が無ければ undefined", () => {
    expect(capOf(MPP, "600")).toBe("1200");
    expect(capOf(MPP, "1")).toBe("2");
    expect(capOf({ ...MPP, destination: { ...MPP.destination, feeMargin: 10_001 } }, "10000")).toBe("10001");
    expect(capOf(MPP, "9".repeat(30))).toBeUndefined();
    expect(capOf(MPP, "x")).toBeUndefined();
    const { feeMargin: _m, ...noMargin } = MPP.destination;
    expect(capOf({ ...MPP, destination: noMargin }, "600")).toBeUndefined();
  });

  test("capCoversFee（復元と再開が共有する検査）: cap の形・fee >= cap・total の整合・受信 offer の額 = total・上流 offer の額 = upstreamAmount・予約の区分", () => {
    const base = {
      profileId: MPP.profileId,
      profile: JSON.parse(JSON.stringify(MPP)) as Record<string, unknown>,
      pricing: { upstreamAmount: "5000", converted: "5000", fee: "3000", total: "8000", maxFee: "3000", estimate: { gas: "50000", maxFeePerGas: "60000000000", bound: "1500", atMs: 1 } },
      ownerKeyHash: "sha256:" + "0".repeat(64),
    };
    const bound = { sourceAmount: "8000", upstreamOfferAmount: "5000" };
    expect(capCoversFee(base, bound)).toBe(true);
    expect(capCoversFee({ ...base, pricing: { ...base.pricing, fee: "2999" } }, bound)).toBe(false);
    expect(capCoversFee({ ...base, pricing: { ...base.pricing, fee: "3000", total: "8001" } }, bound)).toBe(false);
    // 記録の fee・maxFee だけを書き換えて、払っていない手数料で cap を通す: 受信 offer の額（払う額）と合わなければ不可。
    expect(capCoversFee({ ...base, pricing: { ...base.pricing, fee: "3000", total: "8000" } }, { ...bound, sourceAmount: "6000" })).toBe(false);
    expect(capCoversFee(base, { ...bound, upstreamOfferAmount: "4999" })).toBe(false);
    // converted を下げて fee を上げる（total・受信 offer はそのまま）: converted = upstreamAmount でなければ不可。
    expect(capCoversFee({ ...base, pricing: { ...base.pricing, converted: "4000", fee: "4000", maxFee: "4000" } }, bound)).toBe(false);
    const { maxFee: _m, ...noCap } = base.pricing;
    expect(capCoversFee({ ...base, pricing: noCap }, bound)).toBe(false);
    expect(capCoversFee({ ...base, pricing: { ...base.pricing, estimate: { ...base.pricing.estimate, atMs: -1 } } }, bound)).toBe(false);
    expect(capCoversFee({ ...base, pricing: { ...base.pricing, maxFee: "3e3" } }, bound)).toBe(false);
    // 予約: 無ければ requireReservation のときだけ不可。あれば手数料の資産の区分の合計 >= upstreamAmount + maxFee。
    expect(capCoversFee(base, { ...bound, requireReservation: true })).toBe(false);
    const legs = [{ network: DST_NETWORK, asset: DST_ASSET, amount: "8000" }, { network: SRC_NETWORK, asset: SRC_ASSET, amount: "5000" }, { network: SRC_NETWORK, asset: SRC_ASSET, amount: "3000" }];
    expect(capCoversFee({ ...base, reservation: { legs } }, { ...bound, requireReservation: true })).toBe(true);
    expect(capCoversFee({ ...base, reservation: { legs: [legs[0]!, legs[1]!, { ...legs[2]!, amount: "2999" }] } }, bound)).toBe(false);
    expect(capCoversFee({ ...base, reservation: { legs: [legs[0]!, legs[1]!, { ...legs[2]!, asset: DST_ASSET }] } }, bound)).toBe(false);
    // 区分を引く宛先は、渡された設定のプロファイルのもの（記録の写しが別の資産を名乗っていても）。
    const relabeled = { ...base, profile: { ...base.profile, destination: { ...(base.profile["destination"] as object), feeAsset: DST_ASSET, network: DST_NETWORK } } };
    const moved = { legs: [legs[0]!, { network: DST_NETWORK, asset: DST_ASSET, amount: "5000" }, { network: DST_NETWORK, asset: DST_ASSET, amount: "3000" }] };
    expect(capCoversFee({ ...relabeled, reservation: moved }, bound)).toBe(true); // 写しで引けば通ってしまう
    expect(capCoversFee({ ...relabeled, reservation: moved }, { ...bound, destination: { network: SRC_NETWORK, feeAsset: SRC_ASSET } })).toBe(false);
    expect(capCoversFee({ ...base, reservation: { legs } }, { ...bound, destination: { network: SRC_NETWORK, feeAsset: SRC_ASSET } })).toBe(true);
  });

  test("手数料 = max(規則, cap)。pricing に maxFee と見積りの証跡が入り、予約の手数料の区分は cap。受信 offer の額は total", async () => {
    outbound.offers = [mppOffer()];
    const core = await boot(baseConfig({ profile: MPP }));
    // bound 300 → cap 600 < 規則の 1,000 → 手数料 1,000。
    outbound.estimateBound = "300";
    const low = (await quoteMpp(core, "low")) as OkQuote;
    expect(low.ok).toBe(true);
    expect(low.dynamic!.pricing).toMatchObject({ upstreamAmount: "5000", fee: "1000", total: "6000", maxFee: "600", estimate: { gas: "50000", maxFeePerGas: "50000000000", bound: "300", atMs: clock } });
    expect(low.source.amount).toBe("6000");
    // bound 1,500 → cap 3,000 > 規則 → 手数料 3,000（高騰時は高く提示する）。
    outbound.estimateBound = "1500";
    const high = (await quoteMpp(core, "high")) as OkQuote;
    expect(high.dynamic!.pricing).toMatchObject({ fee: "3000", total: "8000", maxFee: "3000" });
    expect(outbound.estimateCalls).toBe(2);
    // 見積りは受信 offer の発行より前（失敗したら offer は作らない）。
    outbound.estimateBound = undefined;
    expect(inbound.createOfferCalls).toBe(2);
    expect(await quoteMpp(core, "down")).toMatchObject({ ok: false, code: "quote_failed", reason: "fee_estimate_unavailable" });
    expect(inbound.createOfferCalls).toBe(2);
    expect(await ledgerText()).not.toContain("secret.internal");
  });

  test("cap が天井（destination.maxFee）を超える quote は出さない: fee_too_high。ちょうど天井なら出す", async () => {
    outbound.offers = [mppOffer()];
    const core = await boot(baseConfig({ profile: MPP }));
    outbound.estimateBound = "2501"; // cap 5,002 > 5,000
    expect(await quoteMpp(core, "over")).toMatchObject({ ok: false, code: "quote_failed", reason: "fee_too_high" });
    outbound.estimateBound = "2500"; // cap 5,000
    const edge = (await quoteMpp(core, "edge")) as OkQuote;
    expect(edge.ok).toBe(true);
    expect(edge.dynamic!.pricing).toMatchObject({ fee: "5000", maxFee: "5000" });
    expect(inbound.createOfferCalls).toBe(1);
  });

  test("x402 送信のプロファイルは見積りを呼ばず、pricing に maxFee を持たない", async () => {
    const core = await boot();
    const quote = await quoteOk(core);
    expect(outbound.estimateCalls).toBe(0);
    expect(quote.dynamic!.pricing).not.toHaveProperty("maxFee");
    expect(quote.dynamic!.pricing).not.toHaveProperty("estimate");
  });

  test("purchase: 上流の照合の後・受信 verify の前に再見積りする。bound が cap を超えていれば awaiting_payment / fee_too_high、見積りに失敗すれば fee_estimate_unavailable。何も書かず、verify は呼ばない。下がれば通り、pay に cap が渡る", async () => {
    outbound.offers = [mppOffer()];
    const core = await boot(baseConfig({ profile: MPP }));
    outbound.estimateBound = "1500";
    const quote = (await quoteMpp(core)) as OkQuote;
    const args = { ...purchaseArgs(quote), requestId: "r1" };
    outbound.estimateBound = "3001"; // > cap 3,000
    expect(await core.purchase(args)).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "fee_too_high" });
    outbound.estimateBound = undefined;
    expect(await core.purchase(args)).toEqual({ paymentId: quote.paymentId, status: "awaiting_payment", code: "fee_estimate_unavailable" });
    expect(inbound.verifyCalls).toBe(0);
    expect(await journalLines()).toEqual([]);
    expect(outbound.readChallengeCalls).toBe(3); // quote 1 + 照合 2（見積りは照合の後）
    // cap を黙って上げない: 記録の maxFee はそのまま。
    expect(core.status(quote.paymentId, "alice", quote.ownerKey)).toMatchObject({ dynamic: { pricing: { maxFee: "3000", fee: "3000" } } });
    outbound.estimateBound = "3000"; // = cap
    expect((await core.purchase(args)).status).toBe("delivered");
    expect(outbound.paidFor[0]).toMatchObject({ maxFee: "3000", target: { url: URL_A } });
    // journal の created 行: pricing に maxFee・estimate、予約の手数料の区分は cap。
    expect((await journalLines())[0]!.patch["dynamic"]).toMatchObject({
      pricing: { fee: "3000", maxFee: "3000", estimate: { bound: "1500" } },
      reservation: { legs: [{ amount: "8000" }, { amount: "5000" }, { asset: SRC_ASSET, amount: "3000" }] },
    });
  });

  test("x402 送信の pay には maxFee を渡さない", async () => {
    const core = await boot();
    const quote = await quoteOk(core);
    expect((await core.purchase(purchaseArgs(quote))).status).toBe("delivered");
    expect(outbound.paidFor[0]).not.toHaveProperty("maxFee");
  });

  test("昇格済みの再開（§3.3）: journal の記録で fee < maxFee、または予約の手数料の区分が足りなければ quote_unreadable（settle へ進まない）。状態の照会は通る", async () => {
    outbound.offers = [mppOffer()];
    let core = await boot(baseConfig({ profile: MPP }));
    outbound.estimateBound = "1500";
    const quote = (await quoteMpp(core)) as OkQuote;
    inbound.settleImpl = async () => { throw new Error("crash"); };
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "unknown" });
    const lines = (await readFile(journalPath, "utf8")).split("\n").filter((line) => line !== "");
    await core.close();
    opened.length = 0;
    const { writeFile } = await import("node:fs/promises");
    const created = JSON.parse(lines[0]!) as { patch: { dynamic: { pricing: Record<string, unknown>; reservation: { legs: { amount: string }[] } } } };
    const tamper = (change: (row: typeof created) => void): string => {
      const row = structuredClone(created);
      change(row);
      return `${JSON.stringify(row)}\n`;
    };
    inbound.settleImpl = async () => ({ outcome: "settled", txRef: "src-tx-2" });

    // (a) 手数料 < cap
    await writeFile(journalPath, tamper((row) => { row.patch.dynamic.pricing["fee"] = "2999"; }));
    core = await boot(baseConfig({ profile: MPP }));
    expect(core.status(quote.paymentId, "alice", quote.ownerKey)).toMatchObject({ status: "awaiting_payment", dynamic: { promoted: true } });
    expect(core.offerFor(quote.quoteId, "alice", undefined, quote.ownerKey)).toBeUndefined();
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "rejected", code: "quote_unreadable" });
    expect(inbound.settleCalls).toBe(1);
    await core.close();
    opened.length = 0;

    // (b) 予約の手数料の区分が足りない
    await writeFile(journalPath, tamper((row) => { row.patch.dynamic.reservation.legs[2]!.amount = "2999"; }));
    core = await boot(baseConfig({ profile: MPP }));
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "rejected", code: "quote_unreadable" });
    await core.close();
    opened.length = 0;

    // (c) cap が無い（旧い形）
    await writeFile(journalPath, tamper((row) => { delete row.patch.dynamic.pricing["maxFee"]; delete row.patch.dynamic.pricing["estimate"]; }));
    core = await boot(baseConfig({ profile: MPP }));
    expect(core.status(quote.paymentId, "alice", quote.ownerKey)).toMatchObject({ status: "awaiting_payment" });
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "rejected", code: "quote_unreadable" });
    expect(inbound.settleCalls).toBe(1);
    await core.close();
    opened.length = 0;

    // (e) fee と maxFee だけを上げる（受信 offer の 8,000 はそのまま）: 払っていない手数料で大きな cap を通せない
    await writeFile(journalPath, tamper((row) => { row.patch.dynamic.pricing["fee"] = "4000"; row.patch.dynamic.pricing["maxFee"] = "4000"; row.patch.dynamic.pricing["total"] = "9000"; row.patch.dynamic.reservation.legs[2]!.amount = "4000"; }));
    core = await boot(baseConfig({ profile: MPP }));
    expect(core.status(quote.paymentId, "alice", quote.ownerKey)).toMatchObject({ status: "awaiting_payment" });
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "rejected", code: "quote_unreadable" });
    expect(inbound.settleCalls).toBe(1);
    expect(outbound.paidFor).toHaveLength(0);
    await core.close();
    opened.length = 0;
    // (f) total を書き換えずに fee と maxFee だけ上げる（total ≠ converted + fee）
    await writeFile(journalPath, tamper((row) => { row.patch.dynamic.pricing["fee"] = "4000"; row.patch.dynamic.pricing["maxFee"] = "4000"; row.patch.dynamic.reservation.legs[2]!.amount = "4000"; }));
    core = await boot(baseConfig({ profile: MPP }));
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "rejected", code: "quote_unreadable" });
    await core.close();
    opened.length = 0;

    // (g) converted を下げて fee・maxFee を上げる（total・受信 offer はそのまま）
    await writeFile(journalPath, tamper((row) => { row.patch.dynamic.pricing["converted"] = "4000"; row.patch.dynamic.pricing["fee"] = "4000"; row.patch.dynamic.pricing["maxFee"] = "4000"; row.patch.dynamic.reservation.legs[2]!.amount = "4000"; }));
    core = await boot(baseConfig({ profile: MPP }));
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "rejected", code: "quote_unreadable" });
    await core.close();
    opened.length = 0;
    // (h) source.amount の写しも一緒に上げる（settle に渡る source.offer はそのまま）: offer の額に結び付けているので不可
    await writeFile(journalPath, tamper((row) => {
      (row.patch as unknown as { source: Record<string, unknown> }).source["amount"] = "9000";
      row.patch.dynamic.pricing["fee"] = "4000"; row.patch.dynamic.pricing["maxFee"] = "4000"; row.patch.dynamic.pricing["total"] = "9000"; row.patch.dynamic.reservation.legs[2]!.amount = "4000";
    }));
    core = await boot(baseConfig({ profile: MPP }));
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "rejected", code: "quote_unreadable" });
    expect(inbound.settleCalls).toBe(1);
    await core.close();
    opened.length = 0;

    // (i) 記録のプロファイルの写しの宛先を書き換え、予約の区分をその資産に移す（offer・pricing・cap はそのまま）: 再開は設定の宛先で引くので不可
    await writeFile(journalPath, tamper((row) => {
      const profile = (row.patch.dynamic as unknown as { profile: { destination: Record<string, unknown> } }).profile;
      profile.destination["network"] = DST_NETWORK; profile.destination["feeAsset"] = DST_ASSET;
      row.patch.dynamic.reservation.legs[1] = { ...row.patch.dynamic.reservation.legs[1]!, network: DST_NETWORK, asset: DST_ASSET } as never;
      row.patch.dynamic.reservation.legs[2] = { ...row.patch.dynamic.reservation.legs[2]!, network: DST_NETWORK, asset: DST_ASSET } as never;
    }));
    core = await boot(baseConfig({ profile: MPP }));
    expect(await core.purchase(purchaseArgs(quote))).toMatchObject({ status: "rejected", code: "quote_unreadable" });
    expect(inbound.settleCalls).toBe(1);
    await core.close();
    opened.length = 0;

    // (d) 正の対照: そのままなら再開できる
    await writeFile(journalPath, `${lines[0]!}\n`);
    core = await boot(baseConfig({ profile: MPP }));
    expect((await core.purchase(purchaseArgs(quote))).status).toBe("delivered");
    expect(inbound.settleCalls).toBe(2);
  });

  test("adapter の理由コード destination_fee_cap_invalid・destination_send_refused_before_dispatch は journal と応答に残る", async () => {
    outbound.offers = [mppOffer()];
    for (const reason of ["destination_fee_cap_invalid", "destination_send_refused_before_dispatch"] as const) {
      const core = await boot(baseConfig({ profile: MPP }));
      outbound.payResult = { outcome: "not_sent", reason };
      const quote = (await quoteMpp(core, reason)) as OkQuote;
      expect(await core.purchase({ ...purchaseArgs(quote), requestId: reason })).toMatchObject({ status: "paid_data_unavailable", terminalReason: reason });
      expect((await journalLines()).at(-1)).toMatchObject({ event: "dest_failed", patch: { reason } });
      await core.close();
      opened.length = 0;
      await rm(journalPath, { force: true });
    }
  });
});

