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
  evmChainIdOf,
  isCaip2Network,
  isWellFormedPayTo,
  loadRuntimeConfig,
  parseRouterConfig,
  validateRouterConfigAgainstTable,
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

  test("mainnet の最初の 1 経路（docs/mainnet-first-route.md）: Base mainnet USDC の x402 受信 → Tempo mainnet USDC.e の MPP 送信が本番の表で通る。向きが違えば拒む", () => {
    const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", TEMPO_USDCE = "0x20C000000000000000000000b9537d11c60E8b50";
    const parsed = parseRouterConfig(
      config([route()], [profile({ profileId: "m" }, { network: "eip155:8453", asset: BASE_MAINNET_USDC }, { network: "eip155:4217", asset: TEMPO_USDCE, feeAsset: TEMPO_USDCE })]),
      { networks: KNOWN_NETWORKS },
    );
    expect(Object.keys(parsed.dynamic?.profiles ?? {})).toEqual(["m"]);
    // Tempo mainnet で x402 受信、Base mainnet へ MPP 送信はどちらも表に無い。
    expectInvalid(config([route()], [profile({ profileId: "m" }, { network: "eip155:4217", asset: TEMPO_USDCE }, { network: "eip155:4217", asset: TEMPO_USDCE, feeAsset: TEMPO_USDCE })]), /inbound rail "x402" is not allowed/);
    expectInvalid(config([route()], [profile({ profileId: "m", rail: "x402" }, { network: "eip155:8453", asset: BASE_MAINNET_USDC }, { scheme: "exact", network: "eip155:8453", asset: BASE_MAINNET_USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" }, feeAsset: undefined, maxFee: undefined })]), /tokenDomain does not match|domain/);
  });

  test("subetha 受信（既定）と rail 未指定は照合しない", () => {
    const parsed = parseRouterConfig(config([route({ rail: undefined, sourceRail: undefined }, { network: "eip155:1", asset: "0x000000000000000000000000000000000000beef", payTo: undefined }, { network: "eip155:1", asset: "0x000000000000000000000000000000000000beef" })]), { networks: KNOWN_NETWORKS });
    expect(parsed.routes["r"]?.sourceRail).toBeUndefined();
  });
});

describe("否定（static route）", () => {
  test("表に無い network", () => expectInvalid(config([route({}, { network: "eip155:1" })]), /source\.network is not a known network/));
  test("向きとレールが表に無い（Tempo で x402 受信）", () => expectInvalid(config([route({}, { network: "eip155:42431", asset: PATHUSD })]), /inbound rail "x402" is not allowed/));
  test("送信の向きが表に無い（Tempo へ x402 送信）", () => expectInvalid(config([route({ rail: "x402" }, {}, { scheme: "exact", network: "eip155:42431", asset: PATHUSD })]), /outbound rail "x402" is not allowed/));
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
  test("Solana の受信は owner の公開鍵で通り、mpp 送信も表で通る（mpp-solana 設計 §1.1、M1。scheme は solana/charge）", () => {
    const parsed = parseRouterConfig(config([route({}, { network: SOL_DEVNET, asset: SOL_USDC, payTo: SOL_OWNER })]), { networks: KNOWN_NETWORKS });
    expect(parsed.routes["r"]?.source.payTo).toBe(SOL_OWNER);
    const mpp = parseRouterConfig(config([route({ rail: "mpp" }, {}, { scheme: "solana/charge", network: SOL_DEVNET, asset: SOL_USDC, payTo: SOL_OWNER })]), { networks: KNOWN_NETWORKS });
    expect(mpp.routes["r"]?.destination.network).toBe(SOL_DEVNET);
  });
});

/** 送信の表（送信の設計 §1、FR-26・FR-28。タスク U1）: Arc・Solana 宛の x402 送信を表で許し、SVM の宛先は mint（= asset）・桁・token program で照合する。 */
describe("送信の表（Arc・Solana 宛。U1）", () => {
  const SOL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const ARC_PROVIDER = "0xAF42CFfe4B35A05098613d962aF43CDc43fBb4Ea";
  const arcRoute = route({ routeId: "arc", canonicalPath: "/v1/routes/arc/resource", rail: "x402" }, {}, { scheme: "exact", network: "eip155:5042002", asset: ARC_USDC, payTo: ARC_PROVIDER });
  const solRoute = route({ routeId: "sol", canonicalPath: "/v1/routes/sol/resource", rail: "x402" }, {}, { scheme: "exact", network: SOL_DEVNET, asset: SOL_USDC, payTo: SOL_OWNER });
  const arcProfile = (destination: Json = {}): Json =>
    profile({ profileId: "pa", rail: "x402" }, {}, { scheme: "exact", network: "eip155:5042002", asset: ARC_USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" }, feeAsset: undefined, maxFee: undefined, ...destination });
  const solProfile = (destination: Json = {}): Json =>
    profile({ profileId: "ps", rail: "x402" }, {}, { scheme: "exact", network: SOL_DEVNET, asset: SOL_USDC, decimals: 6, feeAsset: undefined, maxFee: undefined, ...destination });

  test("表: Arc 宛・Solana 宛の静的 x402 送信が本番の表で通る（payTo は EVM の 0x／SVM の owner の公開鍵）", () => {
    const parsed = parseRouterConfig(config([arcRoute, solRoute]), { networks: KNOWN_NETWORKS });
    expect(parsed.routes["arc"]?.destination.network).toBe("eip155:5042002");
    expect(parsed.routes["sol"]?.destination.payTo).toBe(SOL_OWNER);
    expect(KNOWN_NETWORKS.find((entry) => entry.network === "eip155:5042002")?.outbound).toEqual(["x402"]);
    // Solana は MPP も（mpp-solana 設計 §1.1、M1）。
    expect(KNOWN_NETWORKS.find((entry) => entry.network === SOL_DEVNET)?.outbound).toEqual(["x402", "mpp"]);
  });
  test("表: 試験の表も Arc・Solana の送信を許す（本番の項目をそのまま保つ）", () => {
    expect(TEST_NETWORKS.find((entry) => entry.network === SOL_DEVNET)?.outbound).toEqual(["x402", "mpp"]);
    expect(TEST_NETWORKS.find((entry) => entry.network === "eip155:5042002")?.outbound).toEqual(["x402"]);
  });
  test("動的: Arc 宛は tokenDomain（USDC/2）で通る。Solana 宛は tokenDomain 無し・decimals ありで通り、asset が mint", () => {
    const parsed = parseRouterConfig(config([route()], [arcProfile(), solProfile()]), { networks: KNOWN_NETWORKS });
    expect(parsed.dynamic?.profiles["pa"]?.destination.tokenDomain).toEqual({ name: "USDC", version: "2" });
    expect(parsed.dynamic?.profiles["ps"]?.destination.tokenDomain).toBeUndefined();
    expect(parsed.dynamic?.profiles["ps"]?.destination.asset).toBe(SOL_USDC);
    expect(parsed.dynamic?.profiles["ps"]?.destination.tokenProgram).toBeUndefined();
  });
  test("動的: Solana 宛の tokenProgram は任意で、表と一致すれば保たれ、違えば config_invalid", () => {
    const parsed = parseRouterConfig(config([route()], [solProfile({ tokenProgram: SOL_TOKEN_PROGRAM })]), { networks: KNOWN_NETWORKS });
    expect(parsed.dynamic?.profiles["ps"]?.destination.tokenProgram).toBe(SOL_TOKEN_PROGRAM);
    expectInvalid(config([route()], [solProfile({ tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" })]), /profiles\.ps\.destination\.tokenProgram does not match the known asset/);
    expectInvalid(config([route()], [solProfile({ tokenProgram: "" })]), /profiles\.ps\.destination\.tokenProgram must be a non-empty string/);
  });
  test("動的: Solana 宛に tokenDomain があれば拒否、decimals が無ければ拒否（parse の段で）", () => {
    expectInvalid(config([route()], [solProfile({ tokenDomain: { name: "USDC", version: "2" } })]), /profiles\.ps\.destination\.tokenDomain is not allowed for an svm destination/);
    expectInvalid(config([route()], [solProfile({ decimals: undefined })]), /profiles\.ps\.destination\.decimals/);
  });
  test("動的: EVM 宛に tokenProgram があれば拒否、`mint` の欄は受けない（mint は asset）", () => {
    expectInvalid(config([route()], [arcProfile({ tokenProgram: SOL_TOKEN_PROGRAM })]), /profiles\.pa\.destination\.tokenProgram is only for an svm destination/);
    expectInvalid(config([route()], [solProfile({ mint: SOL_USDC })]), /profiles\.ps\.destination\.mint is not a field/);
  });
  test("表の照合そのもの（parse を通さずに）: svm の宛先に tokenDomain、evm の宛先に tokenProgram があれば表の段で拒む", () => {
    const parsed = parseRouterConfig(config([route()], [arcProfile(), solProfile()]));
    const withDomainOnSvm = {
      ...parsed,
      dynamic: { ...parsed.dynamic!, profiles: { ...parsed.dynamic!.profiles, ps: { ...parsed.dynamic!.profiles["ps"]!, destination: { ...parsed.dynamic!.profiles["ps"]!.destination, tokenDomain: { name: "USDC", version: "2" } } } } },
    };
    expect(() => validateRouterConfigAgainstTable(withDomainOnSvm, KNOWN_NETWORKS)).toThrow(/profiles\.ps\.destination\.tokenDomain is not allowed on an svm network/);
    const withProgramOnEvm = {
      ...parsed,
      dynamic: { ...parsed.dynamic!, profiles: { ...parsed.dynamic!.profiles, pa: { ...parsed.dynamic!.profiles["pa"]!, destination: { ...parsed.dynamic!.profiles["pa"]!.destination, tokenProgram: SOL_TOKEN_PROGRAM } } } },
    };
    expect(() => validateRouterConfigAgainstTable(withProgramOnEvm, KNOWN_NETWORKS)).toThrow(/profiles\.pa\.destination\.tokenProgram is only allowed on an svm network/);
    const withWrongProgram = {
      ...parsed,
      dynamic: { ...parsed.dynamic!, profiles: { ...parsed.dynamic!.profiles, ps: { ...parsed.dynamic!.profiles["ps"]!, destination: { ...parsed.dynamic!.profiles["ps"]!.destination, tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" } } } },
    };
    expect(() => validateRouterConfigAgainstTable(withWrongProgram, KNOWN_NETWORKS)).toThrow(/profiles\.ps\.destination\.tokenProgram does not match the known asset/);
    expect(() => validateRouterConfigAgainstTable(parsed, KNOWN_NETWORKS)).not.toThrow();
  });
  test("parse の契約（networks 無し）: Solana 宛の x402 プロファイルは表無しでも parse でき、tokenDomain・mint・EVM の tokenProgram は parse の段で落ちる", () => {
    const parsed = parseRouterConfig(config([route()], [solProfile({ tokenProgram: SOL_TOKEN_PROGRAM })]));
    expect(parsed.dynamic?.profiles["ps"]?.destination.tokenProgram).toBe(SOL_TOKEN_PROGRAM);
    expect(() => parseRouterConfig(config([route()], [solProfile({ tokenDomain: { name: "USDC", version: "2" } })]))).toThrow(/tokenDomain is not allowed for an svm destination/);
    expect(() => parseRouterConfig(config([route()], [solProfile({ mint: SOL_USDC })]))).toThrow(/destination\.mint is not a field/);
    expect(() => parseRouterConfig(config([route()], [arcProfile({ tokenProgram: SOL_TOKEN_PROGRAM })]))).toThrow(/tokenProgram is only for an svm destination/);
  });
  test("動的: Solana 宛の桁が表と違う・資産が表に無い", () => {
    expectInvalid(config([route()], [solProfile({ decimals: 9 })]), /profiles\.ps\.destination\.decimals does not match/);
    expectInvalid(config([route()], [solProfile({ asset: SOL_OWNER })]), /profiles\.ps\.destination\.asset is not a known asset/);
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
    // 本番が拒む向きは試験の表でも拒む（Base への mpp 送信、Tempo での x402 受信）。
    expectInvalid(config([route({ rail: "mpp" }, {}, { scheme: "tempo/charge", network: "eip155:84532", asset: USDC, payTo: RECEIVER })]), /outbound rail "mpp" is not allowed/, TEST_NETWORKS);
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

describe("evmChainIdOf", () => {
  test("eip155 の数値だけを返し、安全な整数の外と EVM 以外は undefined", () => {
    expect(evmChainIdOf("eip155:84532")).toBe(84532);
    expect(evmChainIdOf("eip155:5042002")).toBe(5042002);
    expect(evmChainIdOf("eip155:9007199254740991")).toBe(9007199254740991);
    expect(evmChainIdOf("eip155:9007199254740993")).toBeUndefined();
    expect(evmChainIdOf("eip155:0")).toBeUndefined();
    expect(evmChainIdOf("eip155:084532")).toBeUndefined();
    expect(evmChainIdOf("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")).toBeUndefined();
    expect(evmChainIdOf("eip155:")).toBeUndefined();
  });
});
