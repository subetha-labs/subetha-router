/**
 * mainnet の最初の 1 経路（`docs/mainnet-first-route.md` 案 B、FR-M2・FR-M3）: mainnet 専用の生成（Tempo mainnet MPP 受信 → Base mainnet x402 送信）と process の能力。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, expect, test } from "vitest";
import { KNOWN_NETWORKS, loadRuntimeConfig } from "../../src/config.js";
import { hostPlanOf, HostPlanError } from "../../tools/remote-mcp.js";
import { MAINNET_FIRST_ROUTE, RAILS_NONE } from "../../tools/remote-mcp-config.js";
import { ProcessEntryError, RAILS_ACTIVATION_ENV, routerProcessCapabilitiesOf, X402_OUTBOUND_NETWORK_ENV } from "../../tools/rails-entry.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const USDCE = "0x20C000000000000000000000b9537d11c60E8b50", BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function loadAsProduction(document: Record<string, unknown>, childEnv: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "mainnet-route-")); dirs.push(dir);
  const configPath = path.join(dir, "router.config.json"); writeFileSync(configPath, JSON.stringify(document));
  return loadRuntimeConfig({ ...childEnv, ROUTER_CONFIG_PATH: configPath, ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson") }, (file) => (file === configPath ? JSON.stringify(document) : ""));
}
const outboundKey = generatePrivateKey();
const env = { SUBETHA_OUTBOUND_PRIVATE_KEY: outboundKey, SUBETHA_ROUTER_RECEIVER: RECEIVER, SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-mainnet-fixture" };
const options = { activation: RAILS_NONE, bind: "127.0.0.1", port: 0, journalPath: "/tmp/m.ndjson", mainnetFirstRoute: true as const };

test("mainnet 専用の生成（案 B）: 静的 route 1 本（placeholder）・動的プロファイル 1 本・予算の区分・CoinGecko の上流。本番の読み込み（real + KNOWN_NETWORKS）を通る", () => {
  const plan = hostPlanOf(options, env);
  const config = loadAsProduction(plan.config, plan.childEnv);
  expect(Object.keys(config.router.routes)).toEqual([MAINNET_FIRST_ROUTE.routeId]);
  const route = config.router.routes[MAINNET_FIRST_ROUTE.routeId]!;
  expect(route).toMatchObject({ rail: "x402", sourceRail: "mpp" });
  expect(route.source).toMatchObject({ network: "eip155:4217", asset: USDCE, decimals: 6, payTo: RECEIVER, amount: "10000" });
  expect(route.destination).toMatchObject({ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, payTo: "0x110cdBba7FE6434Ec4CE3464CC523942ad6Fb784", decimals: 6 });
  expect(Object.keys(config.router.dynamic!.profiles)).toEqual([MAINNET_FIRST_ROUTE.profileId]);
  const profile = config.router.dynamic!.profiles[MAINNET_FIRST_ROUTE.profileId]!;
  expect(profile).toMatchObject({ sourceRail: "mpp", rail: "x402", maxUpstreamAmount: "10000" });
  expect(profile.source).toMatchObject({ network: "eip155:4217", asset: USDCE, payTo: RECEIVER });
  expect(profile.destination).toMatchObject({ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, decimals: 6, tokenDomain: { name: "USD Coin", version: "2" } });
  expect(config.router.budget.buckets.map((b) => `${b.network}|${b.maxTotal}|${b.maxPerPurchase}`)).toEqual(["eip155:4217|30000|10000", "eip155:8453|30000|10000"]);
  expect(config.router.dynamic!.budget.buckets.map((b) => `${b.network}|${b.maxTotal}|${b.maxPerPurchase}`)).toEqual(["eip155:4217|60000|20000", "eip155:8453|60000|20000"]);
  expect((plan.config as any).x402.upstreams).toEqual({ [MAINNET_FIRST_ROUTE.routeId]: "https://pro-api.coingecko.com/api/v3/x402/simple/price" });
  expect((plan.config as any).x402.inboundFacilitators).toBeUndefined();
  // 子の env: x402 送信の鍵と network、MPP 受信の秘密と mainnet の RPC。MPP 送信の鍵・多レールの鍵は無し。
  expect(plan.childEnv).toMatchObject({ SUBETHA_OUTBOUND_X402_KEY: outboundKey, SUBETHA_X402_OUTBOUND_NETWORK: "eip155:8453", ROUTER_MPP_INBOUND_RPC_URL: "https://rpc.tempo.xyz", ROUTER_MPP_INBOUND_SECRET: env.SUBETHA_MPP_INBOUND_SECRET, ROUTER_ADAPTER_MODE: "real", [RAILS_ACTIVATION_ENV]: "" });
  for (const absent of ["SUBETHA_OUTBOUND_MPP_KEY", "SUBETHA_TEMPO_RPC_URL", "ROUTER_X402_INBOUND_FACILITATOR_URL", "SUBETHA_ARC_RECEIVER_KEY", "SUBETHA_OUTBOUND_SOLANA_KEY"]) expect(plan.childEnv[absent]).toBeUndefined();
  expect(JSON.stringify(plan.config)).not.toMatch(/84532|42431|5042002|solana:|pinata/);
});

test("mainnet 専用の生成は loopback 以外の bind と、MPP 受信の秘密の欠落を拒み、認証付き RPC を子に渡す", () => {
  expect(() => hostPlanOf({ ...options, bind: "0.0.0.0" }, env)).toThrow(HostPlanError);
  expect(() => hostPlanOf(options, { ...env, SUBETHA_MPP_INBOUND_SECRET: "" })).toThrow(HostPlanError);
  const plan = hostPlanOf(options, { ...env, SUBETHA_TEMPO_MAINNET_RPC_URL: "https://tempo-main.example/v1/SECRET" });
  expect(plan.childEnv["ROUTER_MPP_INBOUND_RPC_URL"]).toBe("https://tempo-main.example/v1/SECRET");
  expect(JSON.stringify(plan.config)).not.toContain("SECRET");
});

test("process の x402 送信の network: 省略時 Base Sepolia、eip155:8453 で Base mainnet の能力、表に無い・x402 送信の無い network は起動しない", () => {
  const key = generatePrivateKey(), keys = { SUBETHA_OUTBOUND_X402_KEY: key };
  expect(routerProcessCapabilitiesOf(keys).evmSigning!.network).toBe("eip155:84532");
  const mainnet = routerProcessCapabilitiesOf({ ...keys, [X402_OUTBOUND_NETWORK_ENV]: "eip155:8453" });
  expect(mainnet.evmSigning!.network).toBe("eip155:8453");
  expect(mainnet.evmSigning!.signer.address).toBe(privateKeyToAccount(key).address);
  expect(mainnet.mppTempo).toBeUndefined();
  for (const bad of ["eip155:1", "eip155:4217", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "nope"]) {
    try { routerProcessCapabilitiesOf({ ...keys, [X402_OUTBOUND_NETWORK_ENV]: bad }); expect.unreachable(bad); }
    catch (error) { expect((error as ProcessEntryError).code).toBe("x402_network"); }
  }
  expect(KNOWN_NETWORKS.find((n) => n.network === "eip155:8453")?.outbound).toContain("x402");
});
