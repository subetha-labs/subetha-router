/**
 * 受信レール `subetha-exact` の表・設定・一覧（`docs/subetha-exact-inbound-design.md` §5.1・§5.2・§5.5、タスク T-1）。
 * - 表: zUSDC@84532 は `subetha-exact` の受信だけ（資産単位の上書き）。USDC の行・`x402` の受信・送信の集合は不変。他の network には無い（NFR-1）
 * - 設定: `sourceRail: "subetha-exact"` の route（`payTo` 禁止、額 ≤ 20 000）、動的プロファイルと synthetic の拒否、env と `subethaExact.limits`、URL の検査
 * - 一覧: `rail`・`scheme`・`fundsMoveOnCredential: false`
 * - 有効化の境界: real の合成は adapter の登録が無いので `ConfigError`（T-5 で置き換える一時の断言）
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  ConfigError,
  KNOWN_NETWORKS,
  inboundRailsOf,
  knownAssetOf,
  knownNetworkOf,
  loadRuntimeConfig,
  outboundRailsOf,
  parseRouterConfig,
  validateRouterConfigAgainstTable,
} from "../../src/config.js";
import { sourceRailListingOf } from "../../src/http/projection.js";
import { composeRails } from "../../src/main.js";
import { parseSubethaExactFacilitatorUrl, SUBETHA_EXACT_DEFAULT_LIMITS } from "../../src/shared/subetha-exact.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";
import { createSignerSpy } from "../fixtures/x402-signer-spy.js";

const BASE = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ZUSDC = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const PROVIDER = "0x0000000000000000000000000000000000000a11";
const URL_OK = "https://facilitator-testnet.subethalabs.com/p/router-test";

type Json = Record<string, unknown>;

function route(overrides: Json = {}, source: Json = {}): Json {
  return {
    routeId: "z",
    canonicalPath: "/v1/routes/z/resource",
    rail: "x402",
    sourceRail: "subetha-exact",
    source: { amount: "2000", asset: ZUSDC, decimals: 6, network: BASE, ...source },
    destination: { scheme: "exact", network: BASE, asset: USDC, payTo: PROVIDER },
    ...overrides,
  };
}

function config(routes: Json[], dynamic?: Json): Json {
  return {
    approvalTtlMs: 60_000,
    routes: Object.fromEntries(routes.map((r) => [r["routeId"], r])),
    budget: { maxPurchases: 4, buckets: [{ network: BASE, asset: ZUSDC, maxTotal: "100000", maxPerPurchase: "20000" }, { network: BASE, asset: USDC, maxTotal: "100000", maxPerPurchase: "20000" }] },
    ...(dynamic === undefined ? {} : { dynamic }),
  };
}

function expectInvalid(fn: () => unknown, pattern: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  expect((caught as Error).message).toMatch(pattern);
}

describe("表: zUSDC@84532 は subetha-exact の受信だけ", () => {
  const base = knownNetworkOf(KNOWN_NETWORKS, BASE)!;
  test("行がある: 6 桁、domain zERC20 USD Coin / 1、rails は inbound [subetha-exact]・outbound []", () => {
    const asset = knownAssetOf(base, ZUSDC)!;
    expect(asset).toMatchObject({ decimals: 6, domain: { name: "zERC20 USD Coin", version: "1" } });
    expect(inboundRailsOf(base, asset)).toEqual(["subetha-exact"]);
    expect(outboundRailsOf(base, asset)).toEqual([]);
    // 大文字小文字を区別しない（EVM）。
    expect(knownAssetOf(base, ZUSDC.toLowerCase())).toBe(asset);
  });
  test("USDC の行と network の列は不変（x402 だけ）", () => {
    const usdc = knownAssetOf(base, USDC)!;
    expect(usdc.rails).toBeUndefined();
    expect(inboundRailsOf(base, usdc)).toEqual(["x402"]);
    expect(outboundRailsOf(base, usdc)).toEqual(["x402"]);
    expect(base.inbound).toEqual(["x402"]);
    expect(base.outbound).toEqual(["x402"]);
  });
  test("同じ address は Sepolia の受信の表には無い（Sepolia の zUSDC は SUBETHA_ZERC20_ASSETS の行で、x402 の表の資産ではない）", () => {
    const sepolia = knownNetworkOf(KNOWN_NETWORKS, "eip155:11155111")!;
    expect(knownAssetOf(sepolia, ZUSDC)).toBeUndefined();
  });
  test("表の network の順は変わらない（shared-extraction の断言と同じ）", () => {
    expect(KNOWN_NETWORKS.map((n) => n.network)).toEqual(["eip155:84532", "eip155:42431", "eip155:5042002", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "eip155:8453", "eip155:4217", "eip155:46630", "eip155:421614", "eip155:998", "eip155:11155111"]);
  });
});

describe("設定: sourceRail subetha-exact の route", () => {
  const parse = (routes: Json[], dynamic?: Json) => parseRouterConfig(config(routes, dynamic), { networks: KNOWN_NETWORKS });
  test("zUSDC@84532・額 2000・payTo 無し → 通る。額 20000 ちょうども通る", () => {
    expect(parse([route()]).routes["z"]?.sourceRail).toBe("subetha-exact");
    expect(parse([route({}, { amount: "20000" })]).routes["z"]?.source.amount).toBe("20000");
  });
  test("額 20001 → ConfigError（買い手の sign の cap と同じ上限）。0・形違いも", () => {
    expectInvalid(() => parse([route({}, { amount: "20001" })]), /source\.amount must be a positive base-unit integer not above 20000/);
    expectInvalid(() => parse([route({}, { amount: "0" })]), /source\.amount must be a positive/);
    expectInvalid(() => parse([route({}, { amount: "1e3" })]), /source\.amount must be a positive/);
  });
  test("payTo があれば ConfigError（受取先は facilitator が注文ごとに決める）", () => {
    expectInvalid(() => parse([route({}, { payTo: RECEIVER })]), /source\.payTo must be absent when sourceRail is "subetha-exact"/);
  });
  test("x402 の受信に zUSDC は設定できない（資産単位の上書き。文言は for this asset）", () => {
    expectInvalid(() => parse([route({ sourceRail: "x402" }, { payTo: RECEIVER })]), /inbound rail "x402" is not allowed for this asset/);
  });
  test("subetha-exact に USDC は設定できない（network の列。文言は on this network）", () => {
    expectInvalid(() => parse([route({}, { asset: USDC })]), /inbound rail "subetha-exact" is not allowed on this network/);
  });
  test("他の network（Sepolia の同じ address、Arc、mainnet）には設定できない（NFR-1）", () => {
    expectInvalid(() => parse([route({}, { network: "eip155:11155111" })]), /source\.asset is not a known asset/);
    expectInvalid(() => parse([route({}, { network: "eip155:5042002" })]), /source\.asset is not a known asset/);
    expectInvalid(() => parse([route({}, { network: "eip155:8453" })]), /source\.asset is not a known asset/);
  });
  test("zUSDC を x402 の送信先にはできない（outbound の上書きは空）", () => {
    expectInvalid(() => parse([route({ destination: { scheme: "exact", network: BASE, asset: ZUSDC, payTo: PROVIDER } })]), /outbound rail "x402" is not allowed for this asset/);
  });
  test("知らない sourceRail の文言に subetha-exact が増えただけ", () => {
    expectInvalid(() => parse([route({ sourceRail: "subetha-exact-2" })]), /sourceRail must be "subetha", "x402", "mpp" or "subetha-exact" when present/);
  });
  test("動的プロファイルの sourceRail subetha-exact は拒む（FR-1.1）", () => {
    const profile = { profileId: "p", sourceRail: "subetha-exact", source: { network: BASE, asset: ZUSDC, decimals: 6, payTo: RECEIVER }, rail: "x402", destination: { scheme: "exact", network: BASE, asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } }, par: true, maxUpstreamAmount: "10000", fee: { flat: "100", bps: 0, min: "0" } };
    const dynamic = { enabled: false, profiles: { p: profile }, budget: { maxPurchases: 1, buckets: [{ network: BASE, asset: USDC, maxTotal: "1000", maxPerPurchase: "1000" }] }, limits: { quotesPerMinuteGlobal: 1, quotesPerMinutePerSource: 1, outstandingQuotesGlobal: 1, outstandingQuotesPerSource: 1, hostsPerMinute: 1, ledgerRetentionDays: 1 } };
    expectInvalid(() => parseRouterConfig(config([route({ sourceRail: "x402", source: { amount: "2000", asset: USDC, decimals: 6, network: BASE, payTo: RECEIVER } })], dynamic)), /sourceRail must be "x402", "mpp" or "subetha"/);
  });
  test("表を渡さない parse でも、payTo 禁止と額の上限は効く（表に依らない形の規則）", () => {
    expectInvalid(() => parseRouterConfig(config([route({}, { amount: "20001" })])), /not above 20000/);
    expect(parseRouterConfig(config([route()])).routes["z"]?.sourceRail).toBe("subetha-exact");
  });
  test("validateRouterConfigAgainstTable を直接: 試験の表でも同じ判定", () => {
    const parsed = parseRouterConfig(config([route()]));
    expect(() => validateRouterConfigAgainstTable(parsed, TEST_NETWORKS)).not.toThrow();
    expectInvalid(() => validateRouterConfigAgainstTable(parseRouterConfig(config([route({}, { asset: USDC })])), TEST_NETWORKS), /not allowed on this network/);
  });
});

describe("一覧（R1）", () => {
  test("subetha-exact は rail・scheme exact・fundsMoveOnCredential false。他の rail は不変", () => {
    const parsed = parseRouterConfig(config([route()]));
    expect(sourceRailListingOf(parsed.routes["z"]!)).toEqual({ rail: "subetha-exact", scheme: "exact", fundsMoveOnCredential: false });
    const x402 = parseRouterConfig(config([route({ sourceRail: "x402", source: { amount: "2000", asset: USDC, decimals: 6, network: BASE, payTo: RECEIVER } })]));
    expect(sourceRailListingOf(x402.routes["z"]!)).toEqual({ rail: "x402", scheme: "exact" });
    const plain = parseRouterConfig(config([route({ sourceRail: undefined, source: { amount: "2000", asset: USDC, decimals: 6, network: BASE } })]));
    expect(sourceRailListingOf(plain.routes["z"]!)).toEqual({});
  });
});

describe("facilitator の URL の検査", () => {
  test("hosted の tenant の URL は通る（末尾の / は落とす）。tenant は /p/<id>", () => {
    expect(parseSubethaExactFacilitatorUrl(URL_OK)).toEqual({ url: URL_OK, host: "facilitator-testnet.subethalabs.com", tenant: "/p/router-test", loopback: false });
    expect(parseSubethaExactFacilitatorUrl(`${URL_OK}/`)?.url).toBe(URL_OK);
  });
  test("loopback は http も通る（fixture）。それ以外の host・http・query・userinfo・fragment・path の形・port は拒む", () => {
    expect(parseSubethaExactFacilitatorUrl("http://127.0.0.1:8572/p/sample")).toMatchObject({ tenant: "/p/sample", loopback: true });
    for (const bad of [
      "http://facilitator-testnet.subethalabs.com/p/router-test",
      "https://facilitator.subethalabs.com/p/router-test",
      "https://facilitator-testnet.subethalabs.com:8443/p/router-test",
      `${URL_OK}?x=1`,
      "https://user@facilitator-testnet.subethalabs.com/p/router-test",
      `${URL_OK}#f`,
      "https://facilitator-testnet.subethalabs.com/p/Router",
      "https://facilitator-testnet.subethalabs.com/p/router-test/exact",
      "https://facilitator-testnet.subethalabs.com/exact",
      "not a url",
    ]) {
      expect(parseSubethaExactFacilitatorUrl(bad), bad).toBeUndefined();
    }
  });
});

describe("env と設定の section（real モード）", () => {
  function load(opts: { routes?: Json[]; env?: Record<string, string | undefined>; section?: unknown; mode?: "real" | "synthetic"; upstream?: string } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "subetha-exact-table-"));
    const routes = opts.routes ?? [route()];
    const file = path.join(dir, "router.config.json");
    const upstreams = Object.fromEntries(routes.map((r) => [r["routeId"], opts.upstream ?? "https://provider.example/v1/eth/snapshot"]));
    const document = { router: config(routes), ...(opts.mode === "synthetic" ? { synthetic: { facilitatorUrl: "http://127.0.0.1:1", upstreams: Object.fromEntries(routes.map((r) => [r["routeId"], "http://127.0.0.1:1/v1"])) } } : { x402: { upstreams } }), ...(opts.section === undefined ? {} : { subethaExact: opts.section }) };
    writeFileSync(file, JSON.stringify(document));
    const env: Record<string, string | undefined> = {
      ROUTER_CONFIG_PATH: file,
      ROUTER_PRINCIPAL_TOKENS: "a:b",
      ROUTER_ADAPTER_MODE: opts.mode ?? "real",
      ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha.test",
      ROUTER_SUBETHA_EXACT_FACILITATOR_URL: URL_OK,
      ROUTER_SUBETHA_EXACT_TOKEN_FILE: path.join(dir, "provider.token"),
      ...opts.env,
    };
    return loadRuntimeConfig(env, (p) => readFileSync(p, "utf8"), { networks: KNOWN_NETWORKS });
  }
  test("route あり・env あり → subethaExact が読め、limits は既定、offerSeconds は env", () => {
    const loaded = load({ env: { ROUTER_SUBETHA_EXACT_OFFER_SECONDS: "90" } });
    expect(loaded.real?.subethaExact).toEqual({ facilitator: { url: URL_OK, host: "facilitator-testnet.subethalabs.com", tenant: "/p/router-test", loopback: false }, tokenFile: expect.stringMatching(/provider\.token$/), offerSeconds: 90, limits: SUBETHA_EXACT_DEFAULT_LIMITS });
    expect(SUBETHA_EXACT_DEFAULT_LIMITS).toEqual({ maxRequestsTotal: 100, maxUnresolved: 3, requestsPerMinute: 6 });
  });
  test("route あり・URL 無し／token 無し → ConfigError（値は出さない）", () => {
    expectInvalid(() => load({ env: { ROUTER_SUBETHA_EXACT_FACILITATOR_URL: undefined } }), /ROUTER_SUBETHA_EXACT_FACILITATOR_URL is required/);
    expectInvalid(() => load({ env: { ROUTER_SUBETHA_EXACT_TOKEN_FILE: "" } }), /ROUTER_SUBETHA_EXACT_TOKEN_FILE is required/);
  });
  test("URL が許可の形でなければ ConfigError で、メッセージに URL の値は無い", () => {
    let message = "";
    try {
      load({ env: { ROUTER_SUBETHA_EXACT_FACILITATOR_URL: "https://evil.example/p/router-test?leak=1" } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/must be https:\/\/facilitator-testnet\.subethalabs\.com\/p\/<id>/);
    expect(message).not.toContain("evil.example");
  });
  test("limits の上書き（部分でもよい）、unknown の欄、正の整数以外は拒む", () => {
    expect(load({ section: { limits: { maxUnresolved: 5 } } }).real?.subethaExact?.limits).toEqual({ maxRequestsTotal: 100, maxUnresolved: 5, requestsPerMinute: 6 });
    expectInvalid(() => load({ section: { limits: { maxUnresolved: 0 } } }), /subethaExact\.limits\.maxUnresolved must be a positive integer/);
    expectInvalid(() => load({ section: { limits: { lookupBatch: 3 } } }), /subethaExact\.limits has an unknown field/);
    expectInvalid(() => load({ section: { facilitatorUrl: URL_OK } }), /subethaExact has an unknown field/);
  });
  test("route 無し: env が両方あれば読む（過去の注文の complete のため）、片方だけなら ConfigError、無ければ undefined で section があれば拒む", () => {
    const x402Route = route({ routeId: "x", canonicalPath: "/v1/routes/x/resource", sourceRail: "x402", source: { amount: "2000", asset: USDC, decimals: 6, network: BASE, payTo: RECEIVER } });
    expect(load({ routes: [x402Route], env: { ROUTER_X402_INBOUND_FACILITATOR_URL: "https://x402.test" } }).real?.subethaExact?.facilitator.tenant).toBe("/p/router-test");
    expectInvalid(() => load({ routes: [x402Route], env: { ROUTER_X402_INBOUND_FACILITATOR_URL: "https://x402.test", ROUTER_SUBETHA_EXACT_TOKEN_FILE: undefined } }), /ROUTER_SUBETHA_EXACT_TOKEN_FILE is required/);
    const none = load({ routes: [x402Route], env: { ROUTER_X402_INBOUND_FACILITATOR_URL: "https://x402.test", ROUTER_SUBETHA_EXACT_FACILITATOR_URL: undefined, ROUTER_SUBETHA_EXACT_TOKEN_FILE: undefined } });
    expect(none.real?.subethaExact).toBeUndefined();
    expectInvalid(() => load({ routes: [x402Route], env: { ROUTER_X402_INBOUND_FACILITATOR_URL: "https://x402.test", ROUTER_SUBETHA_EXACT_FACILITATOR_URL: undefined, ROUTER_SUBETHA_EXACT_TOKEN_FILE: undefined }, section: { limits: {} } }), /subethaExact section is only allowed/);
  });
  test("synthetic モードは subetha-exact の route を拒む（合成レールに無い。表の照合を通らないので明示に）", () => {
    expectInvalid(() => load({ mode: "synthetic" }), /sourceRail "subetha-exact" is not available with the synthetic rails/);
  });
  test("合成（T-5）: token ファイルが無ければ ConfigError（facilitator は呼ばない）。0600 の token があれば adapter が登録され、wrapper は release を転送する", async () => {
    // 署名 spy（非署名 fixture）は上流も loopback を要求する（既存の compose-rails の試験と同じ）。
    const loaded = load({ upstream: "http://127.0.0.1:1/v1/eth/snapshot", env: { ROUTER_SUBETHA_EXACT_FACILITATOR_URL: "http://127.0.0.1:1/p/router-test" } });
    expectInvalid(
      () => composeRails(loaded, { evmSigning: createSignerSpy().capability(BASE), fixtureFacilitators: true, knownNetworksForTest: TEST_NETWORKS }),
      /ROUTER_SUBETHA_EXACT_TOKEN_FILE: the secret file cannot be read/,
    );
    const tokenFile = loaded.real!.subethaExact!.tokenFile;
    writeFileSync(tokenFile, "fixture-provider-token-0123\n", { mode: 0o600 });
    // loopback の facilitator は fixture の能力が無ければ起動時に ConfigError（設計 §5.2）。
    expectInvalid(
      () => composeRails(loaded, { evmSigning: createSignerSpy().capability(BASE), knownNetworksForTest: TEST_NETWORKS }),
      /ROUTER_SUBETHA_EXACT_FACILITATOR_URL: a loopback facilitator is only allowed with fixture capabilities/,
    );
    const rails = composeRails(loaded, { evmSigning: createSignerSpy().capability(BASE), fixtureFacilitators: true, knownNetworksForTest: TEST_NETWORKS });
    expect(typeof rails.inbound.release).toBe("function");
    expect(typeof rails.shutdown).toBe("function");
    expect(typeof rails.startup).toBe("function");
    // 束縛の無い offer の complete は `ownsOffer` の fallback で adapter に届く（startup 前なので ledger は無く、結果は unknown だが adapter が選ばれている）。
    const offer = { scheme: "exact", network: BASE, asset: ZUSDC, amount: "2000", payTo: RECEIVER, maxTimeoutSeconds: 150, extra: { challengeNonce: `0x${"11".repeat(32)}`, expiresAt: 1, routeBinding: "gone|GET|%2Fx" } };
    expect(rails.inbound.ownsOffer!(offer)).toBe(true);
    expect(rails.inbound.ownsOffer!({ ...offer, asset: USDC })).toBe(false);
  });
  test("token ファイルの検査: symlink・0644・短すぎる値・大きすぎる値は ConfigError で、値はメッセージに無い", async () => {
    const { readSecretFile } = await import("../../src/main.js");
    const dir = mkdtempSync(path.join(os.tmpdir(), "subetha-exact-token-"));
    const file = path.join(dir, "token");
    writeFileSync(file, "abcdefghijklmnopqrstuvwxyz", { mode: 0o644 });
    expectInvalid(() => readSecretFile(file, "X"), /must have mode 0600/);
    const { chmodSync, symlinkSync } = await import("node:fs");
    chmodSync(file, 0o600);
    expect(readSecretFile(file, "X")).toBe("abcdefghijklmnopqrstuvwxyz");
    chmodSync(file, 0o400);
    expectInvalid(() => readSecretFile(file, "X"), /must have mode 0600/);
    chmodSync(file, 0o600);
    symlinkSync(file, path.join(dir, "link"));
    expectInvalid(() => readSecretFile(path.join(dir, "link"), "X"), /regular file/);
    writeFileSync(file, "short", { mode: 0o600 });
    let message = "";
    try {
      readSecretFile(file, "X");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/16 to 4096 printable ASCII/);
    expect(message).not.toContain("short");
    writeFileSync(file, "x".repeat(5000), { mode: 0o600 });
    expectInvalid(() => readSecretFile(file, "X"), /too large/);
    writeFileSync(file, "   padded-token-value-0123   \n", { mode: 0o600 });
    expect(readSecretFile(file, "X")).toBe("padded-token-value-0123");
  });
});
