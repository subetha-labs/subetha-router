/**
 * Base Sepolia の決済を自前の facilitator に移す有効化（`docs/base-sepolia-facilitator-design.md` §3・§4、AC-B1・B2・B7）:
 * - 欄なし・両方 false: 公開の設定・子の env・一覧・facilitator の計画が今と完全に一致
 * - provider だけ・inbound だけ・両方: 変わるのは設計の値だけ
 * - 受信の loopback の例外は有効化したときの Base の受信だけ（送信・動的上流には広がらない）、期限は 20 秒
 * 鍵は固定の合成値か乱数。外へは接続しない（loopback の相手は試験の中の HTTP の server）。
 */
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { loadRuntimeConfig, routeBindingOf, type RuntimeConfig } from "../../src/config.js";
import { routeListBody } from "../../src/http/projection.js";
import { composeRails, localCounterpartyPlanOf } from "../../src/main.js";
import { BASE_SELF_FACILITATOR_TIMEOUT_MS, SELF_FACILITATOR_NETWORKS } from "../../src/shared/self-facilitator.js";
import { createEvmFacilitator, defaultDeadlinesOf, listenFacilitator, TRANSFER_TOPIC, type ChainIo, type Hex, type JournalRecord } from "../../tools/evm-facilitator.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { acceptanceOptionsOf } from "../../tools/rails-acceptance-run.js";
import { activationFromEnv, activationToEnv, RAILS_ACTIVATION_ENV, routerProcessCapabilitiesOf } from "../../tools/rails-entry.js";
import { baseFacilitatorOf, HOSTED_EXACT, INBOUND, OUTBOUND_X402, RAILS_ACTIVATION as RAILS_ACTIVATION_PUBLIC, RAILS_ACTIVATION_BEFORE_BASE as RAILS_ACTIVATION, RAILS_NONE, UPSTREAM_X402, UPSTREAM_X402_BASE, type RailsActivation } from "../../tools/remote-mcp-config.js";
import { HostPlanError, hostPlanOf } from "../../tools/remote-mcp.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const TOKEN = "base-facilitator-test-token_0123456789abcdef";
const BASE = "eip155:84532";
const FAC_URL = `http://127.0.0.1:8611/${TOKEN}`;
const FAC_KEY = "0x" + "44".repeat(32);
const env: Record<string, string | undefined> = {
  SUBETHA_OUTBOUND_PRIVATE_KEY: "0x" + "11".repeat(32), SUBETHA_ROUTER_RECEIVER: RECEIVER, SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-golden", SUBETHA_TEMPO_RPC_URL: "https://tempo.example/v1/TOKEN",
  SUBETHA_ARC_RECEIVER_KEY: "0x" + "22".repeat(32), SUBETHA_SOLANA_RECEIVER: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5", SUBETHA_OUTBOUND_SOLANA_KEY: getBase58Decoder().decode(new Uint8Array(32).fill(7)),
  SUBETHA_ARC_PROVIDER_PAYTO: "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1", SUBETHA_SOLANA_PROVIDER_PAYTO: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d", SUBETHA_SOLANA_MPP_PROVIDER_PAYTO: "26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc",
  SUBETHA_EVM_FACILITATOR_KEY: FAC_KEY, SUBETHA_EVM_FACILITATOR_TOKEN: TOKEN, SUBETHA_EVM_FACILITATOR_GAS_CAP_46630: "1", SUBETHA_EVM_FACILITATOR_GAS_CAP_421614: "2", SUBETHA_EVM_FACILITATOR_GAS_CAP_998: "3",
  SUBETHA_EVM_PROVIDER_PAYTO: "0xf8243d93F339807CA9846Aa31155A2B2262D08db",
  SUBETHA_EXACT_FACILITATOR_URL: "https://facilitator-testnet.subethalabs.com/p/router-hosted", SUBETHA_EXACT_TOKEN_FILE: "/app/runtime/secrets/x.token",
};
const envBase: Record<string, string | undefined> = { ...env, SUBETHA_EVM_FACILITATOR_GAS_CAP_84532: "4" };
const planOf = (activation: RailsActivation, e: Record<string, string | undefined> = env, port?: number) => hostPlanOf({ activation, bind: "0.0.0.0", port: 0, journalPath: "/tmp/golden.ndjson", ...(port === undefined ? {} : { evmFacilitatorPortForTest: port }) }, e);
const withBase = (provider: boolean, inbound: boolean, activation: RailsActivation = RAILS_ACTIVATION): RailsActivation => ({ ...activation, baseFacilitator: { provider, inbound } });

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function loadPlan(plan: { config: Record<string, unknown>; childEnv: Record<string, string> }): RuntimeConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "base-fac-"));
  dirs.push(dir);
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(plan.config));
  return loadRuntimeConfig({ ...plan.childEnv, ROUTER_CONFIG_PATH: configPath, ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson") }, (file) => readFileSync(file, "utf8"));
}
const listed = (activation: RailsActivation, e: Record<string, string | undefined>) => JSON.stringify(routeListBody(loadPlan(planOf(activation, e)).router, "https://router.test"));

describe("AC-B1: 無効なら今と完全に一致", () => {
  test("G-B4 の前の公開の定数（RAILS_ACTIVATION_BEFORE_BASE）に欄は無い（baseFacilitatorOf は両方 false）。今の公開の定数はそれに provider だけ true を足した形（2026-11-26 の G-B4）", () => {
    expect(RAILS_ACTIVATION).not.toHaveProperty("baseFacilitator");
    expect(baseFacilitatorOf(RAILS_ACTIVATION)).toEqual({ provider: false, inbound: false });
    expect(RAILS_ACTIVATION_PUBLIC).toEqual(withBase(true, false));
    expect(JSON.stringify(planOf(RAILS_ACTIVATION_PUBLIC, envBase))).toBe(JSON.stringify(planOf(withBase(true, false), envBase)));
  });

  test.each([["公開の定数", RAILS_ACTIVATION], ["全部無効", RAILS_NONE]] as const)("%s: 欄なしと両方 false で、設定・子の env・facilitator の計画・一覧が文字列で一致（Base の env があっても読まない）", (_n, activation) => {
    const { baseFacilitator: _b, ...none } = activation as RailsActivation;
    const expected = planOf(none, env);
    for (const [variant, e] of [[withBase(false, false, none), env], [none, envBase], [withBase(false, false, none), envBase]] as const) {
      const plan = planOf(variant, e);
      expect(JSON.stringify(plan)).toBe(JSON.stringify(expected));
      expect(activationToEnv(variant)).toBe(activationToEnv(none));
      expect(listed(variant, e)).toBe(listed(none, env));
    }
    expect(expected.childEnv["ROUTER_X402_INBOUND_FACILITATOR_URL"]).toBe(INBOUND.facilitator);
    // 変更前の code（origin/main e24bd6f）が書いた計画の全部（設定・子の env・facilitator の計画）と一覧（`pre-base-facilitator.json`。作り方はその env と同じ入力）。
    const golden = JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/config-golden/pre-base-facilitator.json"), "utf8"));
    const before = golden[activation === RAILS_NONE ? "none" : "public"];
    for (const variant of [none, withBase(false, false, none)]) {
      for (const e of [golden.env, { ...golden.env, SUBETHA_EVM_FACILITATOR_GAS_CAP_84532: "4" }]) {
        expect(JSON.stringify(planOf(variant, e)).replaceAll(`"${process.cwd()}/runtime/`, '"<cwd>/runtime/')).toBe(JSON.stringify(before.plan));
        expect(listed(variant, e)).toBe(JSON.stringify(before.listing));
      }
    }
    expect(JSON.stringify(expected)).not.toMatch(/provider-x402-base|_84532/);
  });
});

describe("AC-B2: 変わるのは設計の値だけ", () => {
  const PROVIDER_ROUTES = ["md-x402-eth-snapshot", "md-x402-eth-snapshot-sol", "md-x402-eth-snapshot-solmpp", HOSTED_EXACT.routeId];

  test.each([[true, false], [false, true], [true, true]])("provider %s・inbound %s", (provider, inbound) => {
    const before = planOf(RAILS_ACTIVATION, env);
    const after = planOf(withBase(provider, inbound), envBase);
    // 設定: Provider A の上流だけ。
    const expected = structuredClone(before.config) as any;
    if (provider) {
      for (const id of PROVIDER_ROUTES) {
        expect(expected.x402.upstreams[id]).toBe(UPSTREAM_X402);
        expected.x402.upstreams[id] = UPSTREAM_X402_BASE;
      }
    }
    expect(after.config).toEqual(expected);
    expect(Object.values(expected.x402.upstreams).filter((u) => u === UPSTREAM_X402)).toHaveLength(provider ? 0 : PROVIDER_ROUTES.length);
    // 子の env: 有効化の語と、inbound のときの facilitator だけ。
    const words = [...(provider ? ["base-provider"] : []), ...(inbound ? ["base-in"] : [])].join(",");
    expect(after.childEnv).toEqual({ ...before.childEnv, [RAILS_ACTIVATION_ENV]: `${before.childEnv[RAILS_ACTIVATION_ENV]},${words}`, ...(inbound ? { ROUTER_X402_INBOUND_FACILITATOR_URL: FAC_URL } : {}) });
    expect(JSON.stringify(after.childEnv)).not.toContain(FAC_KEY.slice(2));
    // facilitator: network・上限・Base だけの allowlist が足されるだけ。共通の allowlist は同じ。
    expect(after.facilitator!.networks).toEqual([...before.facilitator!.networks, BASE]);
    expect(after.facilitator!.env).toEqual({
      ...before.facilitator!.env,
      EVM_FACILITATOR_NETWORKS: `${before.facilitator!.env["EVM_FACILITATOR_NETWORKS"]},${BASE}`,
      EVM_FACILITATOR_GAS_CAP_84532: "4",
      EVM_FACILITATOR_PAYTO_ALLOWLIST_84532: `${RECEIVER},${OUTBOUND_X402.payTo}`,
    });
    // 一覧（route・プロファイル・価格・受取先）と指紋は同じ。
    expect(listed(withBase(provider, inbound), envBase)).toBe(listed(RAILS_ACTIVATION, env));
    const [a, b] = [loadPlan(before), loadPlan(after)];
    expect(b.router).toEqual(a.router);
    // 拒否ホストの元（x402.org）は残る。
    expect(b.real!.subethaFacilitatorUrl).toBe(a.real!.subethaFacilitatorUrl);
    expect(b.real!.x402InboundFacilitators).toEqual(a.real!.x402InboundFacilitators);
  });

  test("Base の RPC の上書きは渡る。上限が無ければ HostPlanError(evm_facilitator)", () => {
    expect(planOf(withBase(true, false), { ...envBase, SUBETHA_EVM_FACILITATOR_RPC_84532: "https://base.example/KEY" }).facilitator!.env["EVM_FACILITATOR_RPC_84532"]).toBe("https://base.example/KEY");
    for (const activation of [withBase(true, false), withBase(false, true)]) expect(() => planOf(activation, env)).toThrow(HostPlanError);
  });

  test("新 3 が全部無効でも Base だけで計画を作る（共通の allowlist は Router の受取先だけ、新 3 の受取先・上限の env は要らない）", () => {
    const { SUBETHA_EVM_PROVIDER_PAYTO: _p, SUBETHA_EVM_FACILITATOR_GAS_CAP_46630: _1, SUBETHA_EVM_FACILITATOR_GAS_CAP_421614: _2, SUBETHA_EVM_FACILITATOR_GAS_CAP_998: _3, ...onlyBase } = envBase;
    const plan = planOf(withBase(false, true, RAILS_NONE), onlyBase);
    expect(plan.facilitator!.networks).toEqual([BASE]);
    expect(plan.facilitator!.env).toMatchObject({ EVM_FACILITATOR_NETWORKS: BASE, EVM_FACILITATOR_PAYTO_ALLOWLIST: RECEIVER, EVM_FACILITATOR_PAYTO_ALLOWLIST_84532: `${RECEIVER},${OUTBOUND_X402.payTo}` });
    expect(plan.childEnv["ROUTER_X402_INBOUND_FACILITATOR_URL"]).toBe(FAC_URL);
  });

  test("有効化の語の往復・受け入れの --rails", () => {
    for (const [provider, inbound] of [[true, false], [false, true], [true, true]] as const) {
      const a = withBase(provider, inbound, RAILS_NONE);
      expect(activationFromEnv(activationToEnv(a))).toEqual(a);
    }
    expect(activationFromEnv("")).not.toHaveProperty("baseFacilitator");
    for (const bad of ["base", "base-out", "base-in,base-in"]) expect(() => activationFromEnv(bad)).toThrow();
    expect(acceptanceOptionsOf({}, ["--rails", "base-provider"]).activation.baseFacilitator).toEqual({ provider: true, inbound: false });
    expect(acceptanceOptionsOf({}, ["--rails", "base-in"]).activation.baseFacilitator).toEqual({ provider: false, inbound: true });
  });
});

describe("AC-B7: 受信の loopback の例外と期限", () => {
  let server: http.Server;
  let other: http.Server;
  let port: number;
  let otherPort: number;
  let requests: string[] = [];
  let connections = 0;
  let redirectTo: string | undefined;
  beforeAll(async () => {
    const make = (count: boolean) =>
      http.createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        req.resume();
        req.on("end", () => {
          if (redirectTo !== undefined) {
            res.writeHead(302, { location: redirectTo });
            res.end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ isValid: true }));
        });
      }).on("connection", () => {
        if (count) connections += 1;
      });
    server = make(true);
    other = make(true);
    for (const s of [server, other]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
    otherPort = (other.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const s of [server, other]) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
  afterEach(() => {
    requests = [];
    redirectTo = undefined;
  });

  function composed(provider: boolean, inbound: boolean) {
    const plan = planOf(withBase(provider, inbound), envBase, port);
    const config = loadPlan(plan);
    const { subethaExact: _e, ...real } = config.real!;
    // `subetha-exact` の route は token のファイルを読むので外す（この試験の対象ではない）。
    const { [HOSTED_EXACT.routeId]: _route, ...routes } = config.router.routes;
    const capabilities = routerProcessCapabilitiesOf({ ...plan.childEnv, SUBETHA_OUTBOUND_SOLANA_KEY: env["SUBETHA_OUTBOUND_SOLANA_KEY"] });
    const trimmed = { ...config, router: { ...config.router, routes }, real } as RuntimeConfig;
    return { capabilities, config: trimmed, rails: composeRails(trimmed, capabilities, () => {}, () => {}) };
  }
  async function verify(c: ReturnType<typeof composed>, routeId: string): Promise<unknown> {
    const dynamic = routeId.startsWith("dyn-");
    const binding = dynamic ? `dynamic|${routeId}|GET|${encodeURIComponent("https://provider.example/v1/x")}` : routeBindingOf(c.config.router.routes[routeId]!);
    const offer = await c.rails.inbound.createOffer({ routeId, amount: dynamic ? "11000" : "10000", asset: INBOUND.asset, network: BASE, routeBinding: binding, nowMs: Date.now() });
    expect(offer.extra).toMatchObject({ name: "USDC", version: "2" });
    return c.rails.inbound.verify(offer, { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, signature: "0x00", authorization: {} } } as never, { routeId });
  }

  test.each(["md-mpp-eth-snapshot", "md-arc-eth-snapshot", "dyn-x402-to-mpp", "dyn-x402-to-rh"])("inbound true: %s の受信の verify が facilitator（token は path）に届き、期限は 20 秒", async (routeId) => {
    const c = composed(false, true);
    expect(c.capabilities.localCounterparties).toEqual({ origins: [`http://127.0.0.1:${port}`], baseSepoliaInbound: true });
    const spy = vi.spyOn(AbortSignal, "timeout");
    expect(await verify(c, routeId)).toEqual({ isValid: true });
    expect(requests).toEqual([`POST /${TOKEN}/verify`]);
    expect(spy.mock.calls.map(([ms]) => ms)).toContain(BASE_SELF_FACILITATOR_TIMEOUT_MS);
    expect(BASE_SELF_FACILITATOR_TIMEOUT_MS).toBe(20_000);
    expect(BASE_SELF_FACILITATOR_TIMEOUT_MS).toBeGreaterThan(defaultDeadlinesOf(BASE).facilitatorMs);
  });

  test("provider だけ: 能力は今と同じ形（baseSepoliaInbound 無し）、受信の facilitator は x402.org のまま", () => {
    const c = composed(true, false);
    expect(c.capabilities.localCounterparties).toEqual({ origins: [`http://127.0.0.1:${port}`] });
    expect(c.config.real!.x402InboundFacilitatorUrl).toBe(INBOUND.facilitator);
  });

  test("facilitator の 302 は別の loopback に辿らない", async () => {
    const c = composed(false, true);
    redirectTo = `http://127.0.0.1:${otherPort}/elsewhere`;
    for (const id of ["md-mpp-eth-snapshot", "dyn-x402-to-mpp"]) await expect(verify(c, id)).rejects.toBeDefined();
    expect(requests.every((r) => r === `POST /${TOKEN}/verify`)).toBe(true);
  });

  test("Base の送信は loopback に届かない: 静的の上流（loopback に差し替え）・動的上流とも接続 0", async () => {
    const c = composed(true, true);
    const poisoned = { ...c.config, real: { ...c.config.real!, upstreams: { ...c.config.real!.upstreams, "md-x402-eth-snapshot": `http://127.0.0.1:${port}/${TOKEN}/supported` } } } as RuntimeConfig;
    const rails = composeRails(poisoned, c.capabilities, () => {}, () => {});
    const before = connections;
    await expect(rails.outbound.readChallenge("md-x402-eth-snapshot")).rejects.toBeDefined();
    for (const url of [`http://127.0.0.1:${port}/${TOKEN}/supported`, `http://127.0.0.1:${otherPort}/x`]) await expect(rails.outbound.readChallenge("dyn-mpp-to-x402", { url, method: "GET" })).rejects.toBeDefined();
    expect(connections).toBe(before);
  });

  test("allowlist に無い loopback の Base の facilitator → 起動しない（静的・動的）。送信の組は EVM testnet のまま", () => {
    const c = composed(false, true);
    const bad = { ...c.capabilities, localCounterparties: { origins: [`http://127.0.0.1:${otherPort}`], baseSepoliaInbound: true } };
    expect(() => composeRails(c.config, bad, () => {}, () => {})).toThrow(/the inbound facilitator is a loopback address/);
    const url = (network: string) => (network === BASE ? `http://127.0.0.1:${port}/${TOKEN}` : undefined);
    const origins = new Set([`http://127.0.0.1:${port}`]);
    const profiles = c.config.router.dynamic!.profiles;
    expect(() => localCounterpartyPlanOf({}, {}, url, new Set(["http://127.0.0.1:1"]), profiles, SELF_FACILITATOR_NETWORKS)).toThrow(/dynamic\.profiles\.dyn-x402-/);
    const plan = localCounterpartyPlanOf(c.config.router.routes, { ...c.config.real!.upstreams, "md-x402-eth-snapshot": `http://127.0.0.1:${port}/x` }, url, origins, profiles, SELF_FACILITATOR_NETWORKS);
    expect(plan.outbound.size).toBe(0);
    expect([...plan.inboundDynamic.keys()].every((id) => id.startsWith("dyn-x402-"))).toBe(true);
    // 旗が無ければ Base には効かない（今までどおり）。
    const without = localCounterpartyPlanOf(c.config.router.routes, c.config.real!.upstreams, url, origins, profiles);
    expect(without.inbound.size + without.inboundDynamic.size).toBe(0);
  });

  test("npm run sign と同じ payer の credential を、Router の受信の adapter から実際の facilitator の層（chain は偽物）に verify・settle する。accepted に余分な鍵があると verify で断る", async () => {
    const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
    const writes: Array<{ from: string; to: string; value: bigint }> = [];
    const hash = `0x${"ab".repeat(32)}` as Hex;
    const io: ChainIo = {
      maxLogRange: 5_000n, maxFeePerGas: 10n ** 9n, gasCap: 10n ** 16n, maxSettleGas: 200_000n,
      reader: {
        authorizationState: async () => false, blockNumber: async () => 1n, blockTimestamp: async () => 1, authorizationUsedLogs: async () => [], receipt: async () => undefined,
        waitForReceipt: async () => ({ status: "success", blockNumber: 1n, gasUsed: 86_000n, effectiveGasPrice: 7_000_000n, l1FeeWei: 1n, logs: [{ address: INBOUND.asset, topics: [TRANSFER_TOPIC, topic(writes[0]!.from), topic(writes[0]!.to)], data: `0x${writes[0]!.value.toString(16).padStart(64, "0")}` }] }),
        feesPerGas: async () => ({ maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1n }), estimateTransferGas: async () => 88_000n, nativeBalance: async () => 10n ** 18n,
      },
      writer: { address: "0x54633d372d7316435891EEBBaAB90861F8c1Dadc", transferWithAuthorization: async (a) => (writes.push(a), hash) },
      verify: async () => ({ isValid: true }),
    };
    const records: JournalRecord[] = [];
    const facilitator = createEvmFacilitator({ networks: [BASE], chains: new Map([[BASE, io]]), journal: { load: async () => records, append: async (r) => void records.push(r) }, payToAllowlist: [RECEIVER], payToAllowlistByNetwork: new Map([[BASE, [RECEIVER, OUTBOUND_X402.payTo]]]) });
    await facilitator.start();
    const listening = await listenFacilitator(facilitator, TOKEN, 0);
    try {
      const plan = planOf(withBase(false, true), envBase, listening.port);
      const config = loadPlan(plan);
      const { subethaExact: _e, ...real } = config.real!;
      const { [HOSTED_EXACT.routeId]: _route, ...routes } = config.router.routes;
      const capabilities = routerProcessCapabilitiesOf({ ...plan.childEnv, SUBETHA_OUTBOUND_SOLANA_KEY: env["SUBETHA_OUTBOUND_SOLANA_KEY"] });
      const rails = composeRails({ ...config, router: { ...config.router, routes }, real } as RuntimeConfig, capabilities, () => {}, () => {});
      const payer = createX402Payer(generatePrivateKey());
      const route = config.router.routes["md-mpp-eth-snapshot"]!;
      const offer = await rails.inbound.createOffer({ routeId: route.routeId, amount: route.source.amount, asset: route.source.asset, network: BASE, routeBinding: routeBindingOf(route), nowMs: Date.now() });
      const credential = JSON.parse(Buffer.from(await payer.credentialFor(offer as never, 84532), "base64").toString("utf8"));
      expect(rails.inbound.preflight(offer, credential, Date.now())).toEqual({ ok: true });
      const extra = { ...credential, accepted: { ...credential.accepted, resource: "https://x.example" } };
      expect(rails.inbound.preflight(offer, extra, Date.now())).toEqual({ ok: true });
      expect(await rails.inbound.verify(offer, extra, { routeId: route.routeId })).toEqual({ isValid: false });
      expect(await rails.inbound.verify(offer, credential, { routeId: route.routeId })).toEqual({ isValid: true });
      expect(await rails.inbound.settle(offer, credential, { routeId: route.routeId })).toMatchObject({ outcome: "settled", txRef: hash });
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ from: payer.address, to: RECEIVER, value: 10_000n });
      expect(records.map((r) => r.type)).toEqual(["gas_cap_init", "submit_intent", "submitted", "settled"]);
    } finally {
      listening.server.closeAllConnections();
      await new Promise<void>((r) => listening.server.close(() => r()));
    }
  });

  test("鍵の無い乱数の送信鍵でも、Base の受信の例外は有効化の語だけで決まる", () => {
    for (const [words, expected] of [["base-in", true], ["base-provider", false], ["rh-in", false]] as const) {
      const capability = routerProcessCapabilitiesOf({ SUBETHA_OUTBOUND_X402_KEY: generatePrivateKey(), [RAILS_ACTIVATION_ENV]: words, SUBETHA_EVM_FACILITATOR_URL: FAC_URL }).localCounterparties!;
      expect("baseSepoliaInbound" in capability).toBe(expected);
    }
  });
});
