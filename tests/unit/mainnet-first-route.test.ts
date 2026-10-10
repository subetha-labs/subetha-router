/**
 * mainnet の最初の 1 経路（`docs/mainnet-first-route.md` FR-M2・FR-M3）: mainnet 専用の生成と process の chain。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, expect, test } from "vitest";
import { KNOWN_NETWORKS, loadRuntimeConfig } from "../../src/config.js";
import { hostPlanOf, HostPlanError } from "../../tools/remote-mcp.js";
import { MAINNET_FIRST_ROUTE, mainnetFirstRouteConfigOf, RAILS_NONE } from "../../tools/remote-mcp-config.js";
import { ProcessEntryError, RAILS_ACTIVATION_ENV, routerProcessCapabilitiesOf, TEMPO_CHAIN_ID_ENV } from "../../tools/rails-entry.js";

const CID = "Qmc5UM1ZBbb9ZNvsk8sqYxNxqEyXtrve2zRUGbuwBYkGeS";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function loadAsProduction(document: Record<string, unknown>, childEnv: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "mainnet-route-")); dirs.push(dir);
  const configPath = path.join(dir, "router.config.json"); writeFileSync(configPath, JSON.stringify(document));
  return loadRuntimeConfig({ ...childEnv, ROUTER_CONFIG_PATH: configPath, ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson") }, (file) => (file === configPath ? JSON.stringify(document) : ""));
}
const env = { SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(), SUBETHA_ROUTER_RECEIVER: RECEIVER };

test("mainnet 専用の生成: 静的 route 1 本・動的プロファイル 1 本・予算の区分・PayAI の facilitator・Pinata の上流。本番の読み込み（real + KNOWN_NETWORKS）を通る", () => {
  const plan = hostPlanOf({ activation: RAILS_NONE, bind: "127.0.0.1", port: 0, journalPath: "/tmp/m.ndjson", mainnetFirstRoute: { cid: CID } }, env);
  const config = loadAsProduction(plan.config, plan.childEnv);
  expect(Object.keys(config.router.routes)).toEqual([MAINNET_FIRST_ROUTE.routeId]);
  const route = config.router.routes[MAINNET_FIRST_ROUTE.routeId]!;
  expect(route.source).toMatchObject({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, payTo: RECEIVER, amount: "10000" });
  expect(route.destination).toMatchObject({ network: "eip155:4217", asset: "0x20C000000000000000000000b9537d11c60E8b50", decimals: 6 });
  expect(Object.keys(config.router.dynamic!.profiles)).toEqual([MAINNET_FIRST_ROUTE.profileId]);
  const profile = config.router.dynamic!.profiles[MAINNET_FIRST_ROUTE.profileId]!;
  expect(profile.source).toMatchObject({ network: "eip155:8453", payTo: RECEIVER });
  expect(profile.destination).toMatchObject({ scheme: "tempo/charge", network: "eip155:4217", asset: "0x20C000000000000000000000b9537d11c60E8b50", feeAsset: "0x20C000000000000000000000b9537d11c60E8b50" });
  expect(profile.maxUpstreamAmount).toBe("10000");
  expect(config.router.budget.buckets.map((b) => `${b.network}|${b.maxTotal}|${b.maxPerPurchase}`)).toEqual(["eip155:8453|30000|10000", "eip155:4217|30000|10000"]);
  expect(config.router.dynamic!.budget.buckets.map((b) => `${b.network}|${b.maxTotal}|${b.maxPerPurchase}`)).toEqual(["eip155:8453|60000|20000", "eip155:4217|60000|20000"]);
  expect((plan.config as any).x402.upstreams).toEqual({ [MAINNET_FIRST_ROUTE.routeId]: `https://mpp.pinata.cloud/v1/pin/public/${CID}` });
  expect((plan.config as any).x402.inboundFacilitators).toEqual({ "eip155:8453": { kind: "x402", url: "https://facilitator.payai.network" } });
  // 子の env: mainnet の chain と RPC、MPP 受信の RPC・秘密は無し、多レールは none。
  expect(plan.childEnv).toMatchObject({ SUBETHA_TEMPO_CHAIN_ID: "4217", SUBETHA_TEMPO_RPC_URL: "https://rpc.tempo.xyz", ROUTER_ADAPTER_MODE: "real", [RAILS_ACTIVATION_ENV]: "" });
  for (const absent of ["ROUTER_MPP_INBOUND_RPC_URL", "ROUTER_MPP_INBOUND_SECRET", "SUBETHA_OUTBOUND_X402_KEY", "SUBETHA_ARC_RECEIVER_KEY", "SUBETHA_OUTBOUND_SOLANA_KEY"]) expect(plan.childEnv[absent]).toBeUndefined();
  expect(JSON.stringify(plan.config)).not.toMatch(/84532|42431|5042002|solana:/);
});

test("mainnet 専用の生成は loopback 以外の bind を拒み、CID の形を検査し、認証付き RPC を子に渡す", () => {
  expect(() => hostPlanOf({ activation: RAILS_NONE, bind: "0.0.0.0", port: 0, journalPath: "/tmp/m.ndjson", mainnetFirstRoute: { cid: CID } }, env)).toThrow(HostPlanError);
  expect(() => hostPlanOf({ activation: RAILS_NONE, bind: "127.0.0.1", port: 0, journalPath: "/tmp/m.ndjson", mainnetFirstRoute: { cid: "../etc" } }, env)).toThrow(HostPlanError);
  expect(() => mainnetFirstRouteConfigOf(env, RECEIVER, "Qmc5UM1ZBbb9ZNvsk8sqYxNxqEyXtrve2zRUGbuwBYkGeS?x=1")).toThrow(/cid/);
  const plan = hostPlanOf({ activation: RAILS_NONE, bind: "127.0.0.1", port: 0, journalPath: "/tmp/m.ndjson", mainnetFirstRoute: { cid: CID } }, { ...env, SUBETHA_TEMPO_MAINNET_RPC_URL: "https://tempo-main.example/v1/SECRET" });
  expect(plan.childEnv["SUBETHA_TEMPO_RPC_URL"]).toBe("https://tempo-main.example/v1/SECRET");
  expect(JSON.stringify(plan.config)).not.toContain("SECRET");
});

test("process の Tempo の chain: 省略時 42431（公開 RPC）、4217 なら mainnet の能力と mainnet の公開 RPC が依存先、他 chain の client は拒む、不正な値は起動しない", () => {
  const keys = { SUBETHA_OUTBOUND_MPP_KEY: generatePrivateKey() };
  const testnet = routerProcessCapabilitiesOf(keys);
  expect(testnet.mppTempo!.chainId).toBe(42431);
  expect(testnet.dependencyUrls).toContain("https://rpc.moderato.tempo.xyz");
  const mainnet = routerProcessCapabilitiesOf({ ...keys, [TEMPO_CHAIN_ID_ENV]: "4217" });
  expect(mainnet.mppTempo!.chainId).toBe(4217);
  expect(mainnet.mppTempo!.kind).toBe("real-key");
  expect(mainnet.dependencyUrls).toContain("https://rpc.tempo.xyz");
  expect(mainnet.dependencyUrls).not.toContain("https://rpc.moderato.tempo.xyz");
  expect(() => mainnet.mppTempo!.getClient({ chainId: 42431 })).toThrow(/refusing/);
  expect(() => testnet.mppTempo!.getClient({ chainId: 4217 })).toThrow(/refusing/);
  const configured = routerProcessCapabilitiesOf({ ...keys, [TEMPO_CHAIN_ID_ENV]: "4217", SUBETHA_TEMPO_RPC_URL: "https://tempo-main.example/v1/SECRET" });
  expect(configured.dependencyUrls![0]).toBe("https://tempo-main.example/v1/SECRET");
  for (const bad of ["", "abc", "0", "-1", "4217.5", "1e3"]) {
    if (bad === "") { expect(routerProcessCapabilitiesOf({ ...keys, [TEMPO_CHAIN_ID_ENV]: bad }).mppTempo!.chainId).toBe(42431); continue; }
    expect(() => routerProcessCapabilitiesOf({ ...keys, [TEMPO_CHAIN_ID_ENV]: bad })).toThrow(ProcessEntryError);
    try { routerProcessCapabilitiesOf({ ...keys, [TEMPO_CHAIN_ID_ENV]: bad }); } catch (error) { expect((error as ProcessEntryError).code).toBe("tempo_chain"); }
  }
});
