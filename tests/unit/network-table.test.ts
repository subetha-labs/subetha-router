/**
 * network の表と設定の照合（multirail 設計 §1・§2、FR-1・FR-3・FR-7。タスク T1）。
 * - 照合は `networks` を渡したときだけ（渡さない既存の試験は変わらない）
 * - 範囲は x402／mpp の受信と x402／mpp の送信。`subetha` 受信は照合しない
 * - 表に無い network・向き・レール・資産・桁・domain・feeAsset、受取先の形違いは `config_invalid`
 * - `x402.inboundFacilitators` の規則（kind・URL・env との衝突・network ごとの必須）
 * - 本番の設定生成が `KNOWN_NETWORKS` で通る
 */
import { describe, expect, test } from "vitest";

import { getBase58Decoder } from "@solana/kit";
import {
  ConfigError,
  KNOWN_NETWORKS,
  assetKeyOf,
  isCaip2Network,
  isWellFormedPayTo,
  loadRuntimeConfig,
  parseRouterConfig,
  type KnownNetwork,
} from "../../src/config.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";
import { routerConfigOf } from "../../tools/remote-mcp-config.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const SOL_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SOL_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOL_OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";

type Json = Record<string, unknown>;

function route(overrides: Json = {}, source: Json = {}, destination: Json = {}): Json {
  return {
    routeId: "r",
    canonicalPath: "/v1/routes/r/resource",
    rail: "mpp",
    sourceRail: "x402",
    source: { amount: "10000", asset: USDC, decimals: 6, network: "eip155:84532", payTo: RECEIVER, ...source },
    destination: { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1", ...destination },
    ...overrides,
  };
}

function profile(overrides: Json = {}, source: Json = {}, destination: Json = {}): Json {
  return {
    profileId: "p",
    sourceRail: "x402",
    source: { network: "eip155:84532", asset: USDC, decimals: 6, payTo: RECEIVER, ...source },
    rail: "mpp",
    destination: { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, decimals: 6, feeAsset: PATHUSD, maxFee: "50000", ...destination },
    par: true,
    maxUpstreamAmount: "100000",
    fee: { flat: "1000", bps: 0, min: "0" },
    ...overrides,
  };
}

function config(routes: Json[], profiles: Json[] = []): Json {
  return {
    approvalTtlMs: 60_000,
    routes: Object.fromEntries(routes.map((r) => [r["routeId"] as string, r])),
    budget: { maxPurchases: 10, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "100000", maxPerPurchase: "10000" }] },
    ...(profiles.length === 0
      ? {}
      : {
          dynamic: {
            enabled: true,
            profiles: Object.fromEntries(profiles.map((p) => [p["profileId"] as string, p])),
            budget: { maxPurchases: 10, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "100000", maxPerPurchase: "10000" }] },
          },
        }),
  };
}

function expectInvalid(raw: Json, pattern: RegExp, networks: readonly KnownNetwork[] = KNOWN_NETWORKS): void {
  let caught: unknown;
  try {
    parseRouterConfig(raw, { networks });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  expect((caught as ConfigError).code).toBe("config_invalid");
  expect((caught as Error).message).toMatch(pattern);
}

describe("表の照合は networks を渡したときだけ", () => {
  test("渡さなければ、表に無い network・資産でも従来どおり通る", () => {
    const parsed = parseRouterConfig(config([route({}, { network: "eip155:1", asset: "0x000000000000000000000000000000000000beef" })]));
    expect(parsed.routes["r"]?.source.network).toBe("eip155:1");
  });

  test("本番の表で、既存の 2 経路と 2 プロファイルの形が通る", () => {
    const parsed = parseRouterConfig(
      config(
        [route(), route({ routeId: "s", canonicalPath: "/v1/routes/s/resource", rail: "x402", sourceRail: "mpp" }, { network: "eip155:42431", asset: PATHUSD }, { scheme: "exact", network: "eip155:84532", asset: USDC })],
        [profile(), profile({ profileId: "q", sourceRail: "mpp", rail: "x402" }, { network: "eip155:42431", asset: PATHUSD }, { scheme: "exact", network: "eip155:84532", asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" }, feeAsset: undefined, maxFee: undefined })],
      ),
      { networks: KNOWN_NETWORKS },
    );
    expect(Object.keys(parsed.routes)).toEqual(["r", "s"]);
    expect(Object.keys(parsed.dynamic?.profiles ?? {})).toEqual(["p", "q"]);
  });

  test("subetha 受信（既定）と rail 未指定は照合しない", () => {
    const parsed = parseRouterConfig(config([route({ rail: undefined, sourceRail: undefined }, { network: "eip155:1", asset: "0x000000000000000000000000000000000000beef", payTo: undefined }, { network: "eip155:1", asset: "0x000000000000000000000000000000000000beef" })]), { networks: KNOWN_NETWORKS });
    expect(parsed.routes["r"]?.sourceRail).toBeUndefined();
  });
});

describe("否定（static route）", () => {
  test("表に無い network", () => expectInvalid(config([route({}, { network: "eip155:1" })]), /source\.network is not a known network/));
  test("向きとレールが表に無い（Tempo で x402 受信）", () => expectInvalid(config([route({}, { network: "eip155:42431", asset: PATHUSD })]), /inbound rail "x402" is not allowed/));
  test("送信の向きが表に無い（Arc へ送信は S-3）", () => expectInvalid(config([route({ rail: "x402" }, {}, { scheme: "exact", network: "eip155:5042002", asset: ARC_USDC })]), /outbound rail "x402" is not allowed/));
  test("表に無い資産", () => expectInvalid(config([route({}, { asset: "0x000000000000000000000000000000000000beef" })]), /source\.asset is not a known asset/));
  test("桁が違う（Arc のネイティブ USDC 18 桁は設定できない。FR-7）", () => expectInvalid(config([route({}, { network: "eip155:5042002", asset: ARC_USDC, decimals: 18 })]), /source\.decimals does not match/));
  test("EVM の payTo が 0x＋40 hex でない", () => expectInvalid(config([route({}, { payTo: "0x1234" })]), /source\.payTo must be a well-formed address/));
  test("SVM の payTo が 32 バイトの base58 でない（長さ超過と、字種は正しいが 31 バイトに復号されるもの）", () => {
    expectInvalid(config([route({}, { network: SOL_DEVNET, asset: SOL_USDC, payTo: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDUxx" })]), /source\.payTo must be a well-formed address/);
    const thirtyOne = getBase58Decoder().decode(new Uint8Array(31).fill(0xff));
    expect(thirtyOne.length).toBeGreaterThanOrEqual(32);
    expectInvalid(config([route({}, { network: SOL_DEVNET, asset: SOL_USDC, payTo: thirtyOne })]), /source\.payTo must be a well-formed address/);
  });
  test("送信の payTo の形（EVM）", () => expectInvalid(config([route({}, {}, { payTo: "not-an-address" })]), /destination\.payTo is not a well-formed address/));
  test("Solana は受信だけ（表のとおり）。owner の公開鍵は通る", () => {
    const parsed = parseRouterConfig(config([route({}, { network: SOL_DEVNET, asset: SOL_USDC, payTo: SOL_OWNER })]), { networks: KNOWN_NETWORKS });
    expect(parsed.routes["r"]?.source.payTo).toBe(SOL_OWNER);
    expectInvalid(config([route({ rail: "x402" }, {}, { scheme: "exact", network: SOL_DEVNET, asset: SOL_USDC, payTo: SOL_OWNER })]), /outbound rail "x402" is not allowed/);
  });
});

describe("否定（dynamic profile）", () => {
  test("表に無い network", () => expectInvalid(config([route()], [profile({}, { network: "eip155:1" })]), /profiles\.p\.source\.network is not a known network/));
  test("桁が違う", () => expectInvalid(config([route()], [profile({}, { decimals: 18 }, { decimals: 18 })]), /profiles\.p\.source\.decimals does not match/));
  test("x402 送信の tokenDomain が表と違う", () =>
    expectInvalid(config([route()], [profile({ sourceRail: "mpp", rail: "x402" }, { network: "eip155:42431", asset: PATHUSD }, { scheme: "exact", network: "eip155:84532", asset: USDC, tokenDomain: { name: "USD Coin", version: "2" }, feeAsset: undefined, maxFee: undefined })]), /tokenDomain does not match/));
  test("x402 送信で、表に domain の無い資産", () => {
    const networks: KnownNetwork[] = [...KNOWN_NETWORKS, { network: "eip155:99", family: "evm", inbound: [], outbound: ["x402"], assets: [{ id: "0x000000000000000000000000000000000000beef", decimals: 6 }] }];
    expectInvalid(config([route()], [profile({ rail: "x402" }, {}, { scheme: "exact", network: "eip155:99", asset: "0x000000000000000000000000000000000000beef", tokenDomain: { name: "USDC", version: "2" }, feeAsset: undefined, maxFee: undefined })]), /has no EIP-712 domain/, networks);
  });
  test("mpp 送信の資産（= feeAsset。既存の規則で同じ）が表に無い", () => {
    expectInvalid(config([route()], [profile({}, {}, { asset: "0x000000000000000000000000000000000000cafe", feeAsset: "0x000000000000000000000000000000000000cafe" })]), /destination\.asset is not a known asset/);
  });
  test("SVM の payTo の形（profile）", () => expectInvalid(config([route()], [profile({}, { network: SOL_DEVNET, asset: SOL_USDC, payTo: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405" })]), /profiles\.p\.source\.payTo must be a well-formed/));
});

describe("x402.inboundFacilitators（real モードの読み込み）", () => {
  const SOL_ROUTE = route({ routeId: "sol", canonicalPath: "/v1/routes/sol/resource" }, { network: SOL_DEVNET, asset: SOL_USDC, payTo: SOL_OWNER });
  const ARC_ROUTE = route({ routeId: "arc", canonicalPath: "/v1/routes/arc/resource" }, { network: "eip155:5042002", asset: ARC_USDC });

  function load(x402: Json, routes: Json[], env: Record<string, string | undefined> = {}, networks: readonly KnownNetwork[] | null = KNOWN_NETWORKS) {
    const document = { router: config(routes), x402: { upstreams: Object.fromEntries(routes.map((r) => [r["routeId"] as string, "https://upstream.test/x"])), ...x402 } };
    return loadRuntimeConfig(
      {
        ROUTER_CONFIG_PATH: "/virtual/config.json",
        ROUTER_PRINCIPAL_TOKENS: "a:b",
        ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha.test",
        ROUTER_X402_INBOUND_FACILITATOR_URL: "https://x402.test/facilitator",
        ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-secret",
        ...env,
      },
      () => JSON.stringify(document),
      networks === null ? {} : { networks },
    );
  }

  function expectLoadInvalid(fn: () => unknown, pattern: RegExp): void {
    let caught: unknown;
    try {
      fn();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toMatch(pattern);
  }

  test("network ごとの facilitator が読め、kind・URL が保たれる", () => {
    const loaded = load({ inboundFacilitators: { [SOL_DEVNET]: { kind: "x402", url: "https://sol.test/facilitator/" }, "eip155:5042002": { kind: "circle", url: "https://circle.test/v1/facilitator/x402" } } }, [route(), SOL_ROUTE, ARC_ROUTE]);
    expect(loaded.real?.x402InboundFacilitators).toEqual({ [SOL_DEVNET]: { kind: "x402", url: "https://sol.test/facilitator" }, "eip155:5042002": { kind: "circle", url: "https://circle.test/v1/facilitator/x402" } });
    expect(loaded.real?.x402InboundFacilitatorUrl).toBe("https://x402.test/facilitator");
  });

  test("kind が表と違う（Arc に x402）", () => expectLoadInvalid(() => load({ inboundFacilitators: { "eip155:5042002": { kind: "x402", url: "https://circle.test" } } }, [route(), ARC_ROUTE]), /kind does not match the known network/));
  test("eip155:84532 を env と両方に書く", () => expectLoadInvalid(() => load({ inboundFacilitators: { "eip155:84532": { kind: "x402", url: "https://other.test" } } }, [route()]), /conflicts with ROUTER_X402_INBOUND_FACILITATOR_URL/));
  test("query・userinfo・fragment のある URL", () => {
    for (const url of ["https://sol.test/f?key=1", "https://user:pw@sol.test/f", "https://sol.test/f#x"]) {
      expectLoadInvalid(() => load({ inboundFacilitators: { [SOL_DEVNET]: { kind: "x402", url } } }, [route(), SOL_ROUTE]), /must not carry/);
    }
  });
  test("x402 受信の network に facilitator が無い", () => expectLoadInvalid(() => load({}, [route(), SOL_ROUTE]), /a facilitator is required for every x402 inbound network/));
  test("Base Sepolia の x402 受信で env が無いときは既存の文言（ROUTER_X402_INBOUND_FACILITATOR_URL）", () =>
    expectLoadInvalid(() => load({}, [route()], { ROUTER_X402_INBOUND_FACILITATOR_URL: undefined }), /ROUTER_X402_INBOUND_FACILITATOR_URL is required when a route uses sourceRail "x402"/));
  test("鍵の構文は CAIP-2 そのもので、メッセージに鍵の値を写さない", () => {
    for (const key of ["eip155:", "solana:bad key", "eip155:abc", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "secret-looking-value\nline2"]) {
      let caught: unknown;
      try {
        load({ inboundFacilitators: { [key]: { kind: "x402", url: "https://sol.test" } } }, [route(), SOL_ROUTE]);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as Error).message).toMatch(/must be a CAIP-2 network/);
      // 名前空間だけの鍵（`eip155:`）は文言の例示と重なるので、それ以外で「値を写さない」を見る。
      if (key !== "eip155:") expect((caught as Error).message).not.toContain(key);
      expect(isCaip2Network(key)).toBe(false);
    }
    expect(isCaip2Network(SOL_DEVNET)).toBe(true);
    expect(isCaip2Network("eip155:84532")).toBe(true);
  });
  test("表に無い network の facilitator", () => expectLoadInvalid(() => load({ inboundFacilitators: { "eip155:1": { kind: "x402", url: "https://one.test" } } }, [route()]), /not a known network/));
  test("kind の列挙外・CAIP-2 でない鍵", () => {
    expectLoadInvalid(() => load({ inboundFacilitators: { [SOL_DEVNET]: { kind: "cdp", url: "https://sol.test" } } }, [route(), SOL_ROUTE]), /kind must be "x402" or "circle"/);
    expectLoadInvalid(() => load({ inboundFacilitators: { solana: { kind: "x402", url: "https://sol.test" } } }, [route(), SOL_ROUTE]), /must be a CAIP-2 network/);
  });
  test("networks を渡さなければ real モードの既定は本番の表（facilitator の必須も効く）", () => {
    expectLoadInvalid(() => load({}, [route(), SOL_ROUTE], {}, null), /a facilitator is required for every x402 inbound network/);
    expectLoadInvalid(() => load({}, [route({}, { asset: "0x000000000000000000000000000000000000beef" })], {}, null), /source\.asset is not a known asset/);
  });
  test("synthetic モードでは表を使わない", () => {
    const document = { router: config([route({}, { network: "eip155:1", asset: "0x000000000000000000000000000000000000beef" })]), synthetic: { facilitatorUrl: "http://127.0.0.1:1", upstreams: { r: "http://127.0.0.1:1/x" } } };
    const loaded = loadRuntimeConfig({ ROUTER_CONFIG_PATH: "/virtual/config.json", ROUTER_PRINCIPAL_TOKENS: "a:b", ROUTER_ADAPTER_MODE: "synthetic" }, () => JSON.stringify(document), { networks: KNOWN_NETWORKS });
    expect(loaded.adapterMode).toBe("synthetic");
  });
});

describe("本番と試験の表", () => {
  test("本番の設定生成（両経路・両プロファイル）が KNOWN_NETWORKS で通る", () => {
    const document = routerConfigOf({}, RECEIVER, true);
    const parsed = parseRouterConfig(document["router"], { networks: KNOWN_NETWORKS });
    expect(Object.keys(parsed.routes).length).toBe(2);
    expect(Object.keys(parsed.dynamic?.profiles ?? {}).length).toBe(2);
  });

  test("試験の表は本番の項目の向き・レール・facilitator の種類をそのまま保ち、資産を減らさない", () => {
    for (const entry of KNOWN_NETWORKS) {
      const test = TEST_NETWORKS.find((n) => n.network === entry.network);
      expect(test).toBeDefined();
      expect(test?.family).toBe(entry.family);
      expect(test?.inbound).toEqual(entry.inbound);
      expect(test?.outbound).toEqual(entry.outbound);
      expect(test?.x402Facilitator).toBe(entry.x402Facilitator);
      for (const asset of entry.assets) expect(test?.assets.some((a) => a.id === asset.id && a.decimals === asset.decimals && a.domain?.name === asset.domain?.name && a.tokenProgram === asset.tokenProgram)).toBe(true);
    }
    // 本番が拒む向きは試験の表でも拒む（Arc への送信、Tempo での x402 受信）。
    expectInvalid(config([route({ rail: "x402" }, {}, { scheme: "exact", network: "eip155:5042002", asset: ARC_USDC })]), /outbound rail "x402" is not allowed/, TEST_NETWORKS);
    expectInvalid(config([route({}, { network: "eip155:42431", asset: PATHUSD })]), /inbound rail "x402" is not allowed/, TEST_NETWORKS);
  });

  test("assetKeyOf と受取先の形", () => {
    expect(assetKeyOf("eip155:84532", USDC)).toBe(USDC.toLowerCase());
    expect(assetKeyOf(SOL_DEVNET, SOL_USDC)).toBe(SOL_USDC);
    expect(isWellFormedPayTo(SOL_DEVNET, SOL_OWNER)).toBe(true);
    expect(isWellFormedPayTo(SOL_DEVNET, SOL_OWNER.toLowerCase())).toBe(false);
    expect(isWellFormedPayTo("eip155:84532", RECEIVER)).toBe(true);
    expect(isWellFormedPayTo("eip155:84532", SOL_OWNER)).toBe(false);
  });
});
