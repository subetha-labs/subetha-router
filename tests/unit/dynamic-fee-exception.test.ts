/**
 * Solana 宛 MPP の手数料の例外（`docs/mpp-solana-design.md` §1、要件 FR-41・FR-44。タスク M1）。
 *
 * Tempo 宛の MPP 送信は gas-indexed の cap（`feeAsset`・`maxFee`・`feeMargin`、quote ごとの見積り）を要求する。Solana 宛の MPP 送信は
 * pull（相手が fee payer）なので Router は手数料を払わず、cap の欄を**持たないことを要求**する。設定・権威の欄・store の復元の 3 か所と、
 * 合成の「まだ配線していない」guard を見る。core の quote／purchase は `dynamic-core.test.ts` に。
 */
import { describe, expect, test } from "vitest";

import { ConfigError, dynamicAuthoritativeTermsOf, KNOWN_NETWORKS, MPP_SOLANA_SCHEME, parseRouterConfig, usesGasIndexedFee, type DynamicProfile } from "../../src/config.js";
import { capCoversFee } from "../../src/core/store.js";
import { dynamicListingOf } from "../../src/http/projection.js";
import { gasIndexedMppProfilesOf } from "../../src/main.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SOL_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOL_OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";

type Json = Record<string, unknown>;

function solMppProfile(destination: Json = {}, overrides: Json = {}): Json {
  return {
    profileId: "dyn-x402-to-solmpp",
    sourceRail: "x402",
    source: { network: "eip155:84532", asset: USDC, decimals: 6, payTo: RECEIVER },
    rail: "mpp",
    destination: { scheme: MPP_SOLANA_SCHEME, network: SOL, asset: SOL_USDC, decimals: 6, ...destination },
    par: true,
    maxUpstreamAmount: "10000",
    fee: { flat: "1000", bps: 0, min: "1000" },
    ...overrides,
  };
}

function tempoMppProfile(): Json {
  return {
    profileId: "dyn-x402-to-mpp",
    sourceRail: "x402",
    source: { network: "eip155:84532", asset: USDC, decimals: 6, payTo: RECEIVER },
    rail: "mpp",
    destination: { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, decimals: 6, feeAsset: PATHUSD, maxFee: "50000" },
    par: true,
    maxUpstreamAmount: "10000",
    fee: { flat: "1000", bps: 0, min: "1000" },
  };
}

function config(profiles: Json[], routes: Json[] = []): Json {
  return {
    approvalTtlMs: 60_000,
    routes: Object.fromEntries([
      ["r", { routeId: "r", canonicalPath: "/v1/routes/r/resource", rail: "x402", sourceRail: "x402", source: { amount: "10000", asset: USDC, decimals: 6, network: "eip155:84532", payTo: RECEIVER }, destination: { scheme: "exact", network: "eip155:84532", asset: USDC, payTo: RECEIVER } }],
      ...routes.map((route) => [route["routeId"] as string, route]),
    ]),
    budget: { maxPurchases: 10, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "100000", maxPerPurchase: "10000" }] },
    ...(profiles.length === 0
      ? {}
      : { dynamic: { enabled: true, profiles: Object.fromEntries(profiles.map((p) => [p["profileId"] as string, p])), budget: { maxPurchases: 10, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "100000", maxPerPurchase: "10000" }] } } }),
  };
}

function expectInvalid(raw: Json, pattern: RegExp): void {
  expect(() => parseRouterConfig(raw, { networks: KNOWN_NETWORKS })).toThrow(ConfigError);
  expect(() => parseRouterConfig(raw, { networks: KNOWN_NETWORKS })).toThrow(pattern);
}

describe("表（設計 §1.1）", () => {
  test("Solana は受信・送信とも x402 と mpp。Arc・Base・Tempo は変えない", () => {
    const sol = KNOWN_NETWORKS.find((entry) => entry.network === SOL)!;
    expect(sol.inbound).toEqual(["x402", "mpp"]);
    expect(sol.outbound).toEqual(["x402", "mpp"]);
    expect(KNOWN_NETWORKS.find((entry) => entry.network === "eip155:5042002")?.outbound).toEqual(["x402"]);
    expect(KNOWN_NETWORKS.find((entry) => entry.network === "eip155:84532")?.inbound).toEqual(["x402"]);
    expect(KNOWN_NETWORKS.find((entry) => entry.network === "eip155:42431")?.outbound).toEqual(["mpp"]);
  });
});

describe("動的プロファイル（設計 §1.2・§1.4 (a)）", () => {
  test("Solana 宛の mpp: decimals 必須・tokenProgram 任意（表と一致）・scheme は solana/charge。cap の欄は持たない", () => {
    const parsed = parseRouterConfig(config([solMppProfile({ tokenProgram: TOKEN_PROGRAM })]), { networks: KNOWN_NETWORKS });
    const profile = parsed.dynamic!.profiles["dyn-x402-to-solmpp"]!;
    expect(profile.destination).toEqual({ scheme: MPP_SOLANA_SCHEME, network: SOL, asset: SOL_USDC, decimals: 6, tokenProgram: TOKEN_PROGRAM });
    expect(profile.destination.feeAsset).toBeUndefined();
    expect(profile.destination.maxFee).toBeUndefined();
    expect(profile.destination.feeMargin).toBeUndefined();
    // tokenProgram を省いても通る（表が権威）。
    expect(parseRouterConfig(config([solMppProfile()]), { networks: KNOWN_NETWORKS }).dynamic!.profiles["dyn-x402-to-solmpp"]!.destination.tokenProgram).toBeUndefined();
  });

  test("Solana 宛の mpp に feeAsset・maxFee・feeMargin・tokenDomain があれば ConfigError（無視しない）", () => {
    expectInvalid(config([solMppProfile({ feeAsset: SOL_USDC })]), /destination\.feeAsset is not allowed/);
    expectInvalid(config([solMppProfile({ maxFee: "1000" })]), /destination\.maxFee is not allowed/);
    expectInvalid(config([solMppProfile({ feeMargin: 20_000 })]), /destination\.feeMargin is not allowed/);
    expectInvalid(config([solMppProfile({ tokenDomain: { name: "USDC", version: "2" } })]), /destination\.tokenDomain is not allowed/);
  });

  test("Solana 宛の mpp の scheme は solana/charge だけ。decimals・tokenProgram は表と照合", () => {
    expectInvalid(config([solMppProfile({ scheme: "tempo/charge" })]), /destination\.scheme must be "solana\/charge"/);
    expectInvalid(config([solMppProfile({ scheme: "exact" })]), /destination\.scheme must be "solana\/charge"/);
    expectInvalid(config([solMppProfile({ decimals: 5 })]), /destination\.decimals does not match/);
    expectInvalid(config([solMppProfile({ tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" })]), /destination\.tokenProgram does not match/);
    expectInvalid(config([solMppProfile({ tokenProgram: "" })]), /destination\.tokenProgram must be a non-empty string/);
  });

  test("Tempo 宛の mpp は今までどおり feeAsset・maxFee 必須（例外は Solana 宛だけ）", () => {
    const { feeAsset: _f, ...noFeeAsset } = tempoMppProfile()["destination"] as Json;
    expectInvalid(config([{ ...tempoMppProfile(), destination: noFeeAsset }]), /destination\.feeAsset/);
    expect(parseRouterConfig(config([tempoMppProfile(), solMppProfile()]), { networks: KNOWN_NETWORKS }).dynamic!.profiles["dyn-x402-to-mpp"]!.destination.maxFee).toBe("50000");
  });

  test("静的 route: Solana 宛の mpp は scheme solana/charge と owner の公開鍵で表を通る", () => {
    const route = { routeId: "s", canonicalPath: "/v1/routes/s/resource", rail: "mpp", sourceRail: "x402", source: { amount: "10000", asset: USDC, decimals: 6, network: "eip155:84532", payTo: RECEIVER }, destination: { scheme: MPP_SOLANA_SCHEME, network: SOL, asset: SOL_USDC, payTo: SOL_OWNER } };
    const parsed = parseRouterConfig(config([], [route]), { networks: KNOWN_NETWORKS });
    expect(parsed.routes["s"]?.destination.payTo).toBe(SOL_OWNER);
    // 受信（sourceRail mpp）も Solana で通る。
    const inbound = { routeId: "i", canonicalPath: "/v1/routes/i/resource", rail: "x402", sourceRail: "mpp", source: { amount: "10000", asset: SOL_USDC, decimals: 6, network: SOL, payTo: SOL_OWNER }, destination: { scheme: "exact", network: "eip155:84532", asset: USDC, payTo: RECEIVER } };
    expect(parseRouterConfig(config([], [inbound]), { networks: KNOWN_NETWORKS }).routes["i"]?.source.network).toBe(SOL);
  });

  test("権威の欄: Solana 宛の mpp は feeMargin も pricingPolicy も持たない。Tempo 宛は今までどおり両方持つ", () => {
    const parsed = parseRouterConfig(config([tempoMppProfile(), solMppProfile()]), { networks: KNOWN_NETWORKS });
    const sol = dynamicAuthoritativeTermsOf(parsed.dynamic!, parsed.dynamic!.profiles["dyn-x402-to-solmpp"]!) as Json;
    const tempo = dynamicAuthoritativeTermsOf(parsed.dynamic!, parsed.dynamic!.profiles["dyn-x402-to-mpp"]!) as Json;
    expect(Object.keys(sol)).not.toContain("pricingPolicy");
    expect(Object.keys(sol["destination"] as Json)).not.toContain("feeMargin");
    expect(tempo["pricingPolicy"]).toBe("gas-indexed-v2");
    expect((tempo["destination"] as Json)["feeMargin"]).toBe(20_000);
  });

  test("公開の一覧（projection）: Solana 宛の mpp は feePolicy を持たず、開示に fee_too_high の項目が無い。Tempo 宛は今までどおり", () => {
    const parsed = parseRouterConfig(config([tempoMppProfile(), solMppProfile()]), { networks: KNOWN_NETWORKS });
    const listing = dynamicListingOf(parsed)! as { profiles: Json[] };
    const sol = listing.profiles.find((p) => p["profileId"] === "dyn-x402-to-solmpp")!;
    const tempo = listing.profiles.find((p) => p["profileId"] === "dyn-x402-to-mpp")!;
    expect(sol).not.toHaveProperty("feePolicy");
    expect(sol["disclosures"]).not.toHaveProperty("feeEstimateIsNotADeliveryGuarantee");
    expect(sol["disclosures"]).not.toHaveProperty("routerMayRejectAfterSettle");
    expect(tempo["feePolicy"]).toEqual({ kind: "gas-indexed", feeMargin: 20_000, maxFeeCeiling: "50000" });
    expect((tempo["disclosures"] as Json)["routerMayRejectAfterSettle"]).toEqual(["fee_too_high"]);
  });

  test("usesGasIndexedFee: Tempo 宛の mpp だけ true", () => {
    const parsed = parseRouterConfig(config([tempoMppProfile(), solMppProfile()]), { networks: KNOWN_NETWORKS });
    expect(usesGasIndexedFee(parsed.dynamic!.profiles["dyn-x402-to-mpp"]!)).toBe(true);
    expect(usesGasIndexedFee(parsed.dynamic!.profiles["dyn-x402-to-solmpp"]!)).toBe(false);
    expect(usesGasIndexedFee({ rail: "x402", destination: { network: "eip155:84532" } })).toBe(false);
    expect(usesGasIndexedFee({ rail: "mpp", destination: { network: "eip155:42431" } })).toBe(true);
    const all = Object.fromEntries(Object.entries(parsed.dynamic!.profiles));
    expect(Object.keys(gasIndexedMppProfilesOf(all))).toEqual(["dyn-x402-to-mpp"]);
  });
});

describe("capCoversFee: Solana 宛の mpp の記録は cap を持たない（設計 §1.4 (c)、store）", () => {
  const solProfile: DynamicProfile = {
    profileId: "dyn-x402-to-solmpp",
    sourceRail: "x402",
    source: { network: "eip155:84532", asset: USDC, decimals: 6, payTo: RECEIVER },
    rail: "mpp",
    destination: { scheme: MPP_SOLANA_SCHEME, network: SOL, asset: SOL_USDC, decimals: 6 },
    par: true,
    maxUpstreamAmount: "10000",
    fee: { flat: "1000", bps: 0, min: "1000" },
  };
  const base = {
    profileId: solProfile.profileId,
    profile: JSON.parse(JSON.stringify(solProfile)) as Record<string, unknown>,
    pricing: { upstreamAmount: "5000", converted: "5000", fee: "1000", total: "6000" },
    ownerKeyHash: "sha256:" + "0".repeat(64),
  };
  const bound = { sourceAmount: "6000", upstreamOfferAmount: "5000" };

  test("cap 無しで通る。額の整合は今までどおり見る。cap を名乗る Solana 宛の記録は不可", () => {
    expect(capCoversFee(base, bound)).toBe(true);
    expect(capCoversFee({ ...base, pricing: { ...base.pricing, total: "6001" } }, bound)).toBe(false);
    expect(capCoversFee({ ...base, pricing: { ...base.pricing, converted: "4000", fee: "2000" } }, bound)).toBe(false);
    expect(capCoversFee(base, { ...bound, sourceAmount: "5999" })).toBe(false);
    expect(capCoversFee(base, { ...bound, upstreamOfferAmount: "4999" })).toBe(false);
    expect(capCoversFee({ ...base, pricing: { ...base.pricing, maxFee: "1", estimate: { gas: "1", maxFeePerGas: "1", bound: "1", atMs: 1 } } }, bound)).toBe(false);
  });

  test("予約: 無ければ requireReservation のときだけ不可。あれば宛先の資産の区分の合計 >= upstreamAmount（手数料の leg は無い）", () => {
    expect(capCoversFee(base, { ...bound, requireReservation: true })).toBe(false);
    const legs = [{ network: "eip155:84532", asset: USDC, amount: "6000" }, { network: SOL, asset: SOL_USDC, amount: "5000" }];
    expect(capCoversFee({ ...base, reservation: { legs } }, { ...bound, requireReservation: true })).toBe(true);
    expect(capCoversFee({ ...base, reservation: { legs: [legs[0]!, { ...legs[1]!, amount: "4999" }] } }, bound)).toBe(false);
    // 再開: 設定のプロファイルの宛先で引く。記録の写しが別の family を名乗っていれば不可。
    expect(capCoversFee({ ...base, reservation: { legs } }, { ...bound, destination: { network: SOL, asset: SOL_USDC, feeAsset: undefined } })).toBe(true);
    const relabeled = { ...base, profile: { ...base.profile, destination: { ...(base.profile["destination"] as object), network: "eip155:42431", asset: PATHUSD, feeAsset: PATHUSD } } };
    expect(capCoversFee({ ...relabeled, reservation: { legs } }, { ...bound, destination: { network: SOL, asset: SOL_USDC, feeAsset: undefined } })).toBe(false);
  });

  test("Tempo 宛の記録は今までどおり cap が無ければ不可", () => {
    const tempo = { ...base, profile: { ...base.profile, destination: { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, decimals: 6, feeAsset: PATHUSD, maxFee: "50000", feeMargin: 20_000 } } };
    expect(capCoversFee(tempo, bound)).toBe(false);
  });
});
