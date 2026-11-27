/**
 * 式の価格（`docs/exact-pricing-{requirements,design}.md`）の純粋な部分と費用の読み取り（AC-1・AC-2・AC-5・AC-10・AC-12）、設定と指紋（AC-7・AC-12）。
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import { createExactPricing } from "../../src/adapters/inbound/exact-pricing.js";
import { createSettleCosts, parseSettleCosts, SETTLE_COSTS_MAX_BYTES } from "../../src/adapters/inbound/settle-costs.js";
import { authoritativeTermsOf, parseRouterConfig, type RouteConfig } from "../../src/config.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import {
  computeExactPrice,
  ethPriceUsable,
  parseEthPrice,
  parseExactPricing,
  priceConsistent,
  PRICING_ISSUE_WINDOW_MS,
  pricingMatches,
  roundingOf,
  utcDayOf,
  type ExactPricingConfig,
  type SettleCosts,
} from "../../src/shared/exact-pricing.js";
import { HOSTED_EXACT_PRICING } from "../../tools/remote-mcp-config.js";
import { createSubethaExactFacilitator, defaultCosts, type FacilitatorFixture } from "../fixtures/subetha-exact-facilitator.js";

const ASSET = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532";
/** 要件 v3 §3.1 の値（上限なし）。§3 の例と範囲の試験はこれで行う。hosted の今の値は `HOSTED`。 */
const PRICING: ExactPricingConfig = { kind: "settle-cost-v1", factorBps: 15_000, take: "500", withdrawCost: "18000", withdrawBatch: 8, tipWei: "1000000", l1FloorWei: "2000", maxSettle: "8000", maxAmount: "20000", maxPerDay: 20, ethPriceMaxAgeDays: 7 };
const HOSTED = { ...HOSTED_EXACT_PRICING } as unknown as ExactPricingConfig;
const COSTS: SettleCosts = { p90Wei: 939_798_001_041n, baseFeePerGas: 5_000_000n, l1FeeMax: 1_041n, overheadPpm: 0n, readAtMs: 1_800_000_000_000 };
const ETH = 3_000_000_000n;
const priceOf = (pricing = PRICING, upstream = "10000", costs = COSTS, eth = ETH) => computeExactPrice(pricing, upstream, costs, eth);
const okOf = (...args: Parameters<typeof priceOf>) => {
  const r = priceOf(...args);
  if (!r.ok) throw new Error(r.reason);
  return r.price;
};

describe("AC-1: 式", () => {
  test("要件 §3 の例と同じ値（n = 8 で 17,040、n = 40 で 15,234。share 60、端数 0 以上）", () => {
    // l1 の下限（2,000）は例の 1,041 より大きいので、例と同じ settleWei にするため下限を 0 にする。
    const p = { ...PRICING, l1FloorWei: "0" };
    expect(okOf(p)).toEqual({ kind: "settle-cost-v1", upstream: "10000", settle: "4230", withdraw: "2250", take: "500", share: "60", total: "17040", costsAtMs: COSTS.readAtMs });
    expect(okOf({ ...p, withdrawBatch: 40 })).toMatchObject({ withdraw: "450", total: "15234" });
    expect(roundingOf(okOf(p))).toBe("0");
  });
  test("settleWei は p90 と「今の gas で 1 件」の大きい方。l1 は item の最大と下限の大きい方。overheadPpm で割る", () => {
    const base = Number(okOf().settle);
    expect(Number(okOf(PRICING, "10000", { ...COSTS, p90Wei: 1n }).settle)).toBe(base);
    expect(Number(okOf(PRICING, "10000", { ...COSTS, baseFeePerGas: 0n, p90Wei: 939_798_001_041n }).settle)).toBe(4230);
    expect(Number(okOf(PRICING, "10000", { ...COSTS, baseFeePerGas: 8_000_000n }).settle)).toBe(6344);
    expect(Number(okOf({ ...PRICING, l1FloorWei: "100000000000" }).settle)).toBeGreaterThan(base);
    expect(Number(okOf(PRICING, "10000", { ...COSTS, l1FeeMax: 100_000_000_000n }).settle)).toBeGreaterThan(base);
    // 20% の無駄 = 1/0.8 倍。+1 ppm は切り上げ側。
    expect(Number(okOf(PRICING, "10000", { ...COSTS, overheadPpm: 200_000n }).settle)).toBe(5287);
    expect(BigInt(okOf(PRICING, "10000", { ...COSTS, overheadPpm: 200_001n }).settle)).toBeGreaterThanOrEqual(5287n);
  });
  test("性質: total − share ≥ upstream + settle + withdraw + take（範囲の中）。total は最小", () => {
    let seed = 12345;
    const rand = (n: number): number => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let i = 0; i < 3000; i += 1) {
      const pricing = { ...PRICING, take: String(rand(2000)), withdrawCost: String(rand(20000)), withdrawBatch: 1 + rand(100), maxSettle: "10000", maxAmount: "20000", factorBps: 10_000 + rand(20_000) };
      const r = computeExactPrice(pricing, String(1 + rand(12000)), { ...COSTS, p90Wei: BigInt(rand(2_000_000_000)) * 1000n, baseFeePerGas: BigInt(rand(8_000_000)), overheadPpm: BigInt(rand(400_000)) }, ETH);
      if (!r.ok) {
        expect(r.reason).toBe("pricing_over_limit");
        continue;
      }
      const { upstream, settle, withdraw, take, share, total } = r.price;
      const covered = BigInt(upstream) + BigInt(settle) + BigInt(withdraw) + BigInt(take);
      expect(BigInt(total) - BigInt(share)).toBeGreaterThanOrEqual(covered);
      expect((BigInt(total) - 1n) * 9965n).toBeLessThan(covered * 10000n);
      expect(BigInt(roundingOf(r.price))).toBeGreaterThanOrEqual(0n);
      expect(priceConsistent(r.price, upstream, pricing)).toBe(true);
    }
  });
  test("上限: settle と total のちょうどは売り、1 越えたら断る。上流の額の形が違う・率が 100% 以上は使えない", () => {
    const p = okOf();
    expect(priceOf({ ...PRICING, maxSettle: p.settle }).ok).toBe(true);
    expect(priceOf({ ...PRICING, maxSettle: String(Number(p.settle) - 1) })).toEqual({ ok: false, reason: "pricing_over_limit" });
    expect(priceOf({ ...PRICING, maxAmount: p.total }).ok).toBe(true);
    expect(priceOf({ ...PRICING, maxAmount: String(Number(p.total) - 1) })).toEqual({ ok: false, reason: "pricing_over_limit" });
    expect(priceOf(PRICING, "9".repeat(30))).toEqual({ ok: false, reason: "pricing_over_limit" });
    for (const bad of ["0", "", "-1", "01", "1.5", "1e3", "9".repeat(31)]) expect(priceOf(PRICING, bad), bad).toEqual({ ok: false, reason: "pricing_unavailable" });
    expect(priceOf(PRICING, "10000", { ...COSTS, overheadPpm: 1_000_000n })).toEqual({ ok: false, reason: "pricing_unavailable" });
  });
});

describe("AC-8: 記録の検査", () => {
  const price = okOf();
  const record = { ...price, issuedAtMs: 1_800_000_000_000 };
  const bound = { upstreamOfferAmount: "10000", quoted: "10000", sourceAmount: price.total, offerAmount: price.total, approvalDeadlineMs: 1_800_000_120_000 };
  test("どれか 1 つを変えると落ちる", () => {
    expect(pricingMatches(record, bound)).toBe(true);
    for (const key of ["upstream", "settle", "withdraw", "take", "share", "total"] as const) {
      for (const delta of [1n, -1n]) expect(pricingMatches({ ...record, [key]: (BigInt(record[key]) + delta).toString() }, bound), key).toBe(false);
      for (const bad of [undefined, 1, "", "01", "x"]) expect(pricingMatches({ ...record, [key]: bad }, bound), key).toBe(false);
    }
    for (const patch of [{ kind: "other" }, { costsAtMs: 0 }, { costsAtMs: "1" }, { issuedAtMs: undefined }, { issuedAtMs: 0 }, { issuedAtMs: bound.approvalDeadlineMs }, { issuedAtMs: bound.approvalDeadlineMs - PRICING_ISSUE_WINDOW_MS - 1 }]) expect(pricingMatches({ ...record, ...patch }, bound)).toBe(false);
    expect(pricingMatches({ ...record, issuedAtMs: bound.approvalDeadlineMs - PRICING_ISSUE_WINDOW_MS }, bound)).toBe(true);
    for (const patch of [{ upstreamOfferAmount: "10001" }, { quoted: "10001" }, { sourceAmount: "1" }, { offerAmount: "1" }, { offerAmount: undefined }]) expect(pricingMatches(record, { ...bound, ...patch }), JSON.stringify(patch)).toBe(false);
    for (const bad of [null, [], "x", undefined]) expect(pricingMatches(bad, bound)).toBe(false);
  });
});

describe("L1 の上限（docs/exact-pricing-l1-cap.md）", () => {
  // 2026-11-26 の本番の `/costs`（block 63,711,333）。overheadRate 0 → overheadPpm 1。
  const LIVE: SettleCosts = { p90Wei: 982_828_124_044n, baseFeePerGas: 5_000_000n, l1FeeMax: 3_495_157_411_208n, overheadPpm: 1n, readAtMs: 1_800_000_000_000 };
  const ETH_1700 = 1_700_000_000n;
  const CAP = "500000000000";
  const noCap = (pricing: ExactPricingConfig): ExactPricingConfig => {
    const { l1CapWei: _cap, ...rest } = pricing;
    return rest;
  };
  test("AC-1: §1 の費用と ETH 1,700 USD で 16,245（tip 0.001 gwei の時は 16,606）。上限を外すと断る、要件 v3 の値でも断る。ふだんの L1 なら p90 が効く", () => {
    expect(HOSTED.l1CapWei).toBe(CAP);
    // tip 0.0001 gwei（2026-11-27）: 156,633 × 5,100,000 + 上限 5×10¹¹ = 1,298,828,300,000 wei → settle 3,313。
    expect(HOSTED.tipWei).toBe("100000");
    expect(okOf(HOSTED, "10000", LIVE, ETH_1700)).toMatchObject({ settle: "3313", withdraw: "2375", take: "500", total: "16245" });
    // 2026-11-26 に有効にした時の値（tip 0.001 gwei）は変わらない。
    expect(okOf({ ...HOSTED, tipWei: "1000000" }, "10000", LIVE, ETH_1700)).toMatchObject({ settle: "3672", withdraw: "2375", take: "500", total: "16606" });
    expect(priceOf(noCap(HOSTED), "10000", LIVE, ETH_1700)).toEqual({ ok: false, reason: "pricing_over_limit" });
    expect(computeExactPrice({ ...noCap(HOSTED), maxSettle: "10000", maxAmount: "20000" }, "10000", LIVE, ETH_1700)).toEqual({ ok: false, reason: "pricing_over_limit" });
    expect(priceOf(PRICING, "10000", LIVE, ETH_1700)).toEqual({ ok: false, reason: "pricing_over_limit" });
    // ふだんの L1（4.3×10¹⁰）: 1 件の見積もり（下限 1×10¹¹ 込みで 898,828,300,000）より p90（982,828,124,044）が大きいので p90 を使う。tip 0.001 gwei の時は 1 件の見積もりが勝って 15,582。
    expect(okOf(HOSTED, "10000", { ...LIVE, l1FeeMax: 43_030_124_044n }, ETH_1700)).toMatchObject({ settle: "2507", total: "15437" });
    expect(okOf({ ...HOSTED, tipWei: "1000000" }, "10000", { ...LIVE, l1FeeMax: 43_030_124_044n }, ETH_1700)).toMatchObject({ settle: "2652", total: "15582" });
  });
  test("AC-1: 上限より大きい・等しい・小さい L1、下限、欄なし", () => {
    const capped = { ...PRICING, l1CapWei: CAP };
    const at = (l1FeeMax: bigint, pricing: ExactPricingConfig = capped) => okOf(pricing, "10000", { ...LIVE, l1FeeMax }, ETH_1700).settle;
    expect(at(10n ** 15n)).toBe(at(500_000_000_000n));
    expect(at(500_000_000_001n)).toBe(at(500_000_000_000n));
    expect(at(500_000_000_000n)).toBe(at(500_000_000_000n, PRICING));
    expect(at(499_999_999_999n)).toBe(at(499_999_999_999n, PRICING));
    expect(Number(at(499_000_000_000n))).toBeLessThan(Number(at(500_000_000_000n)));
    // 下限が上限と同じなら L1 の項は常にその値。
    const pinned = { ...PRICING, l1FloorWei: CAP, l1CapWei: CAP };
    expect(at(0n, pinned)).toBe(at(10n ** 15n, pinned));
    expect(at(0n, pinned)).toBe(at(500_000_000_000n, PRICING));
    // 欄が無ければ今の式（上限なし）。
    expect(Number(at(10n ** 12n, PRICING))).toBeGreaterThan(Number(at(10n ** 12n)));
  });
  test("AC-3b: p90 は切らない。p90 が上限で切った 1 件より大きければ p90、maxSettle を越えれば断る", () => {
    // 上限で切った 1 件 = 156,633 × 6,000,000 + 5×10^11 ≈ 1.44×10^12（settle 3,672）。
    expect(okOf(HOSTED, "10000", { ...LIVE, p90Wei: 2_000_000_000_000n }, ETH_1700).settle).toBe("5101");
    expect(priceOf(HOSTED, "10000", { ...LIVE, p90Wei: 4_000_000_000_000n }, ETH_1700)).toEqual({ ok: false, reason: "pricing_over_limit" });
  });
  test("AC-2: l1CapWei の範囲と下限との関係。文に値が出ない", () => {
    for (const good of ["2000", "500000000000", "1000000000000000"]) expect(parseExactPricing({ ...PRICING, l1CapWei: good }).ok, good).toBe(true);
    expect(parseExactPricing({ ...PRICING, l1FloorWei: "0", l1CapWei: "1" }).ok).toBe(true);
    expect(parseExactPricing(HOSTED).ok).toBe(true);
    expect(parseExactPricing(PRICING).ok).toBe(true);
    for (const bad of ["0", "1000000000000001", 500_000_000_000, "01", "-1", "", null, undefined]) {
      const r = parseExactPricing({ ...PRICING, l1FloorWei: "0", l1CapWei: bad });
      expect(r, String(bad)).toEqual({ ok: false, problem: "l1CapWei must be a decimal string from 1 to 1000000000000000" });
    }
    expect(parseExactPricing({ ...PRICING, l1CapWei: "1999" })).toEqual({ ok: false, problem: "l1CapWei must not be below l1FloorWei" });
    expect(parseExactPricing({ ...HOSTED, l1CapWei: "99999999999" })).toEqual({ ok: false, problem: "l1CapWei must not be below l1FloorWei" });
    expect(parseExactPricing({ ...HOSTED, l1FloorWei: "500000000001" })).toEqual({ ok: false, problem: "l1CapWei must not be below l1FloorWei" });
  });
});

describe("AC-12: 設定の範囲と ETH の価格", () => {
  test("pricing の各欄の両端と外、知らない欄。文に値が出ない", () => {
    expect(parseExactPricing(PRICING).ok).toBe(true);
    const cases: [string, unknown[], unknown[]][] = [
      ["factorBps", [10_000, 100_000], [9_999, 100_001, 1.5, "15000"]],
      ["take", ["0", "10000"], ["10001", 500, "-1", "01"]],
      ["withdrawCost", ["0", "1000000"], ["1000001"]],
      ["withdrawBatch", [1, 100], [0, 101]],
      ["tipWei", ["0", "10000000000"], ["10000000001"]],
      ["l1FloorWei", ["0", "1000000000000000"], ["1000000000000001"]],
      ["maxSettle", ["1", "10000"], ["0", "10001"]],
      ["maxAmount", ["1", "20000"], ["0", "20001"]],
      ["maxPerDay", [1, 1000], [0, 1001]],
      ["ethPriceMaxAgeDays", [1, 30], [0, 31]],
      ["kind", ["settle-cost-v1"], ["other", undefined]],
    ];
    for (const [key, good, bad] of cases) {
      for (const value of good) expect(parseExactPricing({ ...PRICING, [key]: value }).ok, `${key}=${String(value)}`).toBe(true);
      for (const value of [...bad, undefined]) expect(parseExactPricing({ ...PRICING, [key]: value }).ok, `${key}=${String(value)}`).toBe(false);
    }
    expect(parseExactPricing({ ...PRICING, extra: 1 })).toEqual({ ok: false, problem: "has an unknown field" });
    for (const bad of [null, [], "x"]) expect(parseExactPricing(bad).ok).toBe(false);
  });
  test("ETH の価格: 無い・片方だけ・形・範囲外は undefined。5 分以内の未来は使え、越えたら使えない。期限ちょうどは使えない", () => {
    const at = "2026-11-24T00:00:00Z";
    const atMs = Date.parse(at);
    expect(parseEthPrice("3000000000", at)).toEqual({ price: 3_000_000_000n, atMs });
    expect(parseEthPrice("3000000000", "2026-11-24T00:00:00.000Z")).toEqual({ price: 3_000_000_000n, atMs });
    expect([parseEthPrice("100000000", at), parseEthPrice("100000000000", at)].every((v) => v !== undefined)).toBe(true);
    for (const [p, a] of [[undefined, at], ["3000000000", undefined], ["", at], ["99999999", at], ["100000000001", at], ["3e9", at], ["03000000000", at], ["3000000000", "2026-11-24"], ["3000000000", "2026-11-24T00:00:00+09:00"], ["3000000000", "2026-02-30T00:00:00Z"], ["3000000000", "nope"]] as const) expect(parseEthPrice(p, a), `${String(p)} ${String(a)}`).toBeUndefined();
    const price = { price: ETH, atMs };
    expect(ethPriceUsable(undefined, atMs, 7)).toBe(false);
    expect([ethPriceUsable(price, atMs - 300_000, 7), ethPriceUsable(price, atMs - 300_001, 7)]).toEqual([true, false]);
    expect([ethPriceUsable(price, atMs + 7 * 86_400_000 - 1, 7), ethPriceUsable(price, atMs + 7 * 86_400_000, 7)]).toEqual([true, false]);
  });
});

describe("AC-2・AC-5・AC-10: 費用の読み取り", () => {
  const expected = { chainId: 84532, asset: ASSET };
  const good = (): Record<string, unknown> => structuredClone(defaultCosts(84532, ASSET.toLowerCase()));
  test("応答の検査: 使う値の形が 1 つでも違えば使えない。l1 は summary.l1FeeMaxWei だけ（行は読まない）", () => {
    expect(parseSettleCosts(good(), expected, 5)).toEqual({ p90Wei: 939_798_001_041n, baseFeePerGas: 5_000_000n, l1FeeMax: 1_041n, overheadPpm: 1n, readAtMs: 5 });
    const bad = (patch: Record<string, unknown>, summary: Record<string, unknown> = {}): unknown => ({ ...good(), ...patch, summary: { ...(good()["summary"] as object), ...summary } });
    for (const json of [
      null, [], "x", {},
      bad({ chainId: 1 }), bad({ chainId: "84532" }), bad({ token: USDC }), bad({ token: undefined }), bad({ asOfBlock: null }), bad({ asOfBlock: -1 }),
      bad({ baseFeePerGas: null }), bad({ baseFeePerGas: 5 }), bad({ baseFeePerGas: "-5" }), bad({ baseFeePerGas: "9".repeat(31) }),
      bad({ items: undefined }), bad({ items: Array.from({ length: 501 }, () => ({ l1Fee: "1" })) }), bad({ items: {} }),
      bad({}, { l1FeeMaxWei: undefined }), bad({}, { l1FeeMaxWei: null }), bad({}, { l1FeeMaxWei: 5 }), bad({}, { l1FeeMaxWei: "01" }), bad({}, { l1FeeMaxWei: "-1" }), bad({}, { l1FeeMaxWei: "9".repeat(31) }),
      bad({}, { successfulItems: 0 }), bad({}, { successfulItems: undefined }), bad({}, { allocatedP90Wei: null }), bad({}, { allocatedP90Wei: 5 }),
      bad({}, { overheadRate: null }), bad({}, { overheadRate: 0.5 }), bad({}, { overheadRate: -0.1 }), bad({}, { overheadRate: "0" }), bad({}, { overheadRate: Number.NaN }),
    ]) expect(parseSettleCosts(json, expected, 5), JSON.stringify(json)?.slice(0, 80)).toBeUndefined();
    for (const items of [[], [{ l1Fee: "999999999999" }], [null], Array.from({ length: 500 }, () => ({ l1Fee: "7" }))]) expect(parseSettleCosts(bad({ items }), expected, 5)?.l1FeeMax).toBe(1_041n);
    expect(parseSettleCosts(bad({}, { overheadRate: 0.2 }), expected, 5)?.overheadPpm).toBe(200_001n);
    expect(parseSettleCosts(bad({}, { overheadRate: 0.499999 }), expected, 5)?.overheadPpm).toBe(500_000n);
  });

  let fixture: FacilitatorFixture | undefined;
  let clock = 1_800_000_000_000;
  const reports: unknown[] = [];
  const TOKEN = "5e".repeat(32);
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture?.close();
    fixture = undefined;
  });
  async function reader(settleBearer = TOKEN, timeoutMs = 500) {
    clock = 1_800_000_000_000;
    fixture = createSubethaExactFacilitator({ providerId: "p", bearer: "fixture-provider-token-0123", settleBearer, chainId: 84532, asset: ASSET, domainName: "zERC20 USD Coin", domainVersion: "1" });
    await fixture.listen();
    return createSettleCosts({ baseUrl: `${fixture.baseUrl!}/xfac`, token: () => TOKEN, transport: createGuardedTransport({ allowLoopback: true, report: (e) => reports.push(e) }), chainId: 84532, asset: ASSET, tenant: "p", now: () => clock, monotonicNow: () => clock, timeoutMs });
  }
  const calls = () => fixture!.calls.byRoute["costs"] ?? 0;

  test("100 件の同時の読みで呼び出しは 1 回。60 秒の中は 0 回、過ぎたら 1 回", async () => {
    const costs = await reader();
    const all = await Promise.all(Array.from({ length: 100 }, () => costs.read()));
    expect(all.every((c) => c.costs?.p90Wei === 939_798_001_041n && c.accepting === true)).toBe(true);
    expect(calls()).toBe(1);
    clock += 59_999;
    await costs.read();
    expect(calls()).toBe(1);
    clock += 1;
    await Promise.all([costs.read(), costs.read()]);
    expect(calls()).toBe(2);
  });

  test("失敗: 費用は 10 分以内は前の値、過ぎたら使えない。失敗のあと 10 秒は読みに行かない。429 は Retry-After を待つ。時計が戻った値は使わない", async () => {
    const costs = await reader();
    expect((await costs.read()).costs).toBeDefined();
    fixture!.setCosts({ status: 500 });
    clock += 60_000;
    expect((await costs.read()).costs).toBeDefined();
    expect(calls()).toBe(2);
    clock += 9_999;
    await costs.read();
    expect(calls()).toBe(2);
    clock += 1;
    await costs.read();
    expect(calls()).toBe(3);
    fixture!.setCosts({ status: 429, headers: { "retry-after": "120" }, body: "{}" });
    clock += 10_000;
    await costs.read();
    expect(calls()).toBe(4);
    clock += 119_999;
    expect((await costs.read()).costs).toBeDefined();
    expect(calls()).toBe(4);
    fixture!.setCosts({ status: 500 });
    clock = 1_800_000_000_000 + 599_999;
    expect((await costs.read()).costs).toBeDefined();
    clock += 1;
    expect((await costs.read()).costs).toBeUndefined();
    fixture!.setCosts({ status: 200 });
    clock += 60_000;
    expect((await costs.read()).costs).toBeDefined();
    clock -= 1_000_000;
    fixture!.setCosts({ status: 500 });
    expect((await costs.read()).costs).toBeUndefined();
  });

  test("使えない応答: 別の chain・JSON でない・本文の超過・timeout・redirect・401。どれも undefined で投げない。token は記録に出ない", async () => {
    for (const answer of [
      { status: 200, body: JSON.stringify(defaultCosts(1, ASSET)) },
      { status: 200, body: "<html>" },
      { status: 200, body: JSON.stringify({ ...defaultCosts(84532, ASSET), pad: "x".repeat(SETTLE_COSTS_MAX_BYTES) }) },
      { status: 200, delayMs: 1_500 },
      { status: 302, headers: { location: "/xfac/costs" }, body: "" },
      { status: 204 },
    ]) {
      const costs = await reader();
      fixture!.setCosts(answer);
      expect(await costs.read(), JSON.stringify(answer).slice(0, 60)).toEqual({});
      await fixture!.close();
    }
    const wrong = await reader("ab".repeat(32));
    expect(await wrong.read()).toEqual({});
    expect(JSON.stringify(reports)).not.toContain(TOKEN);
  });

  test("供給: ETH の価格が無い・期限切れなら費用を読みに行かない。読めれば内訳", async () => {
    const costs = await reader();
    const off = createExactPricing({ costs, now: () => clock });
    expect(await off.price("r", PRICING, "10000")).toEqual({ ok: false, reason: "pricing_unavailable" });
    const old = createExactPricing({ costs, ethPrice: { price: ETH, atMs: clock - 7 * 86_400_000 }, now: () => clock });
    expect(await old.price("r", PRICING, "10000")).toEqual({ ok: false, reason: "pricing_unavailable" });
    expect(calls()).toBe(0);
    const on = createExactPricing({ costs, ethPrice: { price: ETH, atMs: clock }, now: () => clock });
    expect(await on.price("r", PRICING, "10000")).toMatchObject({ ok: true, price: { upstream: "10000", total: expect.stringMatching(/^[0-9]+$/) } });
    expect(calls()).toBe(1);
  });
});

describe("AC-7・AC-12: route の設定と指紋", () => {
  const route = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
    routeId: "z", canonicalPath: "/v1/routes/z/resource", rail: "x402", sourceRail: "subetha-exact", offerCap: { maxCommitted: 5 }, pricing: { ...PRICING },
    source: { amount: "20000", asset: ASSET, decimals: 6, network: NETWORK },
    destination: { scheme: "exact", network: NETWORK, asset: USDC, payTo: "0x0000000000000000000000000000000000000a11" },
    ...patch,
  });
  const parse = (r: Record<string, unknown>, maxPerPurchase = "20000") =>
    parseRouterConfig({ approvalTtlMs: 60_000, routes: { z: r }, budget: { maxPurchases: 4, buckets: [{ network: NETWORK, asset: ASSET, maxTotal: "100000", maxPerPurchase }, { network: NETWORK, asset: USDC, maxTotal: "100000", maxPerPurchase: "20000" }] } }).routes["z"]!;
  test("R2 の各条件で落ちる（値は出さない）", () => {
    expect(parse(route()).pricing).toEqual(PRICING);
    for (const [patch, match] of [
      [{ sourceRail: "x402", offerCap: undefined, source: { ...(route()["source"] as object), payTo: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405" } }, /pricing is only allowed/],
      [{ offerCap: undefined }, /requires offerCap/],
      [{ source: { ...(route()["source"] as object), amount: "12000" } }, /must equal pricing\.maxAmount/],
      [{ source: { ...(route()["source"] as object), decimals: 18 } }, /zUSDC source/],
      [{ source: { ...(route()["source"] as object), asset: USDC } }, /zUSDC source/],
      [{ source: { ...(route()["source"] as object), network: "eip155:1" } }, /zUSDC source/],
      [{ rail: "mpp" }, /x402 destination/],
      [{ destination: { ...(route()["destination"] as object), asset: ASSET } }, /x402 destination/],
      [{ destination: { ...(route()["destination"] as object), network: "eip155:5042002" } }, /x402 destination/],
      [{ pricing: { ...PRICING, factorBps: 1 } }, /factorBps must be an integer/],
    ] as const) expect(() => parse(route(patch as Record<string, unknown>)), JSON.stringify(patch)).toThrow(match);
    expect(() => parse(route(), "19999")).toThrow(/source budget bucket/);
  });
  test("指紋: 条件の欄が変われば変わり、maxPerDay・ethPriceMaxAgeDays・offerCap では変わらない。固定の route の直列化に pricing は無い", () => {
    const terms = (r: RouteConfig): string => JSON.stringify(authoritativeTermsOf(r));
    const base = terms(parse(route()));
    for (const patch of [{ factorBps: 15_001 }, { take: "501" }, { withdrawCost: "18001" }, { withdrawBatch: 9 }, { tipWei: "1000001" }, { l1FloorWei: "2001" }, { maxSettle: "8001" }]) expect(terms(parse(route({ pricing: { ...PRICING, ...patch } }))), JSON.stringify(patch)).not.toBe(base);
    for (const patch of [{ maxPerDay: 21 }, { ethPriceMaxAgeDays: 8 }]) expect(terms(parse(route({ pricing: { ...PRICING, ...patch } })))).toBe(base);
    // L1 の上限（docs/exact-pricing-l1-cap.md AC-3）: 足す・変える・外すと変わる。欄の無い式の route は変更前の main で取った値と同じ。
    const withCap = terms(parse(route({ pricing: { ...PRICING, l1CapWei: "500000000000" } })));
    expect(withCap).not.toBe(base);
    expect(terms(parse(route({ pricing: { ...PRICING, l1CapWei: "500000000001" } })))).not.toBe(withCap);
    expect(base).toBe(
      '{"destination":{"scheme":"exact","network":"eip155:84532","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","payTo":"0x0000000000000000000000000000000000000a11"},"source":{"amount":"20000","asset":"0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f","network":"eip155:84532"},"rail":"x402","sourceRail":"subetha-exact","pricing":{"kind":"settle-cost-v1","factorBps":15000,"take":"500","withdrawCost":"18000","withdrawBatch":8,"tipWei":"1000000","l1FloorWei":"2000","maxSettle":"8000","maxAmount":"20000"}}',
    );
    expect(() => parse(route({ pricing: { ...PRICING, l1CapWei: "1999" } }))).toThrow(/l1CapWei must not be below l1FloorWei/);
    expect(terms(parse(route({ offerCap: { maxCommitted: 6 } })))).toBe(base);
    const fixed = parse(route({ pricing: undefined, source: { amount: "12000", asset: ASSET, decimals: 6, network: NETWORK } }));
    expect(Object.keys(authoritativeTermsOf(fixed) as object)).toEqual(["destination", "source", "rail", "sourceRail"]);
    expect("pricing" in fixed).toBe(false);
  });
  test("UTC の日", () => {
    expect(utcDayOf(Date.parse("2026-11-24T23:59:59.999Z")) + 1).toBe(utcDayOf(Date.parse("2026-11-25T00:00:00Z")));
  });
});
