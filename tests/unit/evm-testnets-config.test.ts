/**
 * EVM testnet 4 つの専用の設定生成・入口・子 process の能力（`docs/evm-testnets-x402-design.md` §3.5・§3.7、FR-E5・FR-E6、AC-E5、タスク E-4）。
 * 公開の生成・子・能力に EVM testnet のものが混ざらないこと（golden の補い。`tests/unit/config-golden.test.ts` は変えない）。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";

import { EVM_TESTNET_NETWORKS, KNOWN_NETWORKS, knownNetworkOf, loadRuntimeConfig } from "../../src/config.js";
import { evmTestnetsAnnouncementOf, evmTestnetsOptionsOf } from "../../tools/evm-testnets-run.js";
import { EvmTestnetsProcessError, evmTestnetsCapabilitiesOf } from "../../tools/evm-testnets-router-process.js";
import { RAILS_ACTIVATION_ENV, routerProcessCapabilitiesOf } from "../../tools/rails-entry.js";
import {
  EVM_TESTNET_CHAINS,
  EVM_TESTNETS,
  evmTestnetChainsOf,
  evmTestnetsConfigOf,
  INBOUND,
  RAILS_ACTIVATION,
  RAILS_NONE,
  UPSTREAM_X402,
} from "../../tools/remote-mcp-config.js";
import { EVM_TESTNETS_ROUTER_PROCESS, hostPlanOf, HostPlanError, PUBLIC_ROUTER_PROCESS } from "../../tools/remote-mcp.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const PROVIDER = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
const PROVIDER_A = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FACILITATOR = "http://127.0.0.1:8611/0123456789abcdef-token";
const PROVIDER_URLS = {
  SUBETHA_EVM_PROVIDER_URL_RH: "http://127.0.0.1:8621/v1/eth/snapshot",
  SUBETHA_EVM_PROVIDER_URL_ARBSEP: "http://127.0.0.1:8622/v1/eth/snapshot",
  SUBETHA_EVM_PROVIDER_URL_HYPEREVM: "http://127.0.0.1:8623/v1/eth/snapshot",
  SUBETHA_EVM_PROVIDER_URL_SEPOLIA: "http://127.0.0.1:8624/v1/eth/snapshot",
};
const evmEnv = { SUBETHA_EVM_FACILITATOR_URL: FACILITATOR, SUBETHA_EVM_PROVIDER_PAYTO: PROVIDER, ...PROVIDER_URLS };
const outboundKey = generatePrivateKey();
const hostEnv = { SUBETHA_OUTBOUND_PRIVATE_KEY: outboundKey, SUBETHA_ROUTER_RECEIVER: RECEIVER, ...evmEnv };
const ALL = EVM_TESTNET_CHAINS;
const evmOptions = { activation: RAILS_NONE, bind: "127.0.0.1", port: 0, journalPath: "/tmp/evm-testnets.ndjson", evmTestnets: { chains: ALL } };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 本番と同じ読み込み（real モード、表は `KNOWN_NETWORKS`）。 */
function loadAsProduction(document: Record<string, unknown>, childEnv: Readonly<Record<string, string>>) {
  const dir = mkdtempSync(path.join(tmpdir(), "evm-testnets-config-"));
  dirs.push(dir);
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  return loadRuntimeConfig({ ...childEnv, ROUTER_CONFIG_PATH: configPath, ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson") }, (file) => readFileSync(file, "utf8"));
}

describe("EVM_TESTNETS（短縮名の定数）", () => {
  test("4 つの値は表（KNOWN_NETWORKS）と完全に一致する（network・資産の表記・桁・domain）", () => {
    expect(Object.keys(EVM_TESTNETS)).toEqual(["rh", "arbsep", "hyperevm", "sepolia"]);
    expect(new Set(Object.values(EVM_TESTNETS).map((c) => c.network))).toEqual(EVM_TESTNET_NETWORKS);
    for (const chain of ALL) {
      const c = EVM_TESTNETS[chain];
      const entry = knownNetworkOf(KNOWN_NETWORKS, c.network)!;
      expect(entry.assets).toHaveLength(1);
      const known = entry.assets[0]!;
      expect(c.asset).toBe(known.id); // 大文字小文字まで同じ（予算の区分の鍵）
      expect(c.decimals).toBe(known.decimals);
      expect(c.domain).toEqual(known.domain);
      expect(entry.inbound).toContain("x402");
      expect(entry.outbound).toContain("x402");
      expect(entry.x402Facilitator).toBe("x402");
    }
  });

  test("chain の一覧: 部分集合・表の順・空/知らない語/重複は拒む", () => {
    expect(evmTestnetChainsOf("sepolia,rh")).toEqual(["rh", "sepolia"]);
    expect(evmTestnetChainsOf(" rh , arbsep ")).toEqual(["rh", "arbsep"]);
    for (const bad of [undefined, "", "rh,rh", "base", "rh,", "RH"]) expect(() => evmTestnetChainsOf(bad)).toThrow();
  });
});

describe("evmTestnetsConfigOf", () => {
  test("4 chain: route 8 本・上流・facilitator・予算（§3.7）。本番の読み込み（real + KNOWN_NETWORKS）を通る", () => {
    const plan = hostPlanOf(evmOptions, hostEnv);
    const document = plan.config as { router: { routes: Record<string, any>; budget: any; approvalTtlMs: number }; x402: { upstreams: Record<string, string>; inboundFacilitators: Record<string, unknown> } };
    const ids = Object.keys(document.router.routes);
    expect(ids).toEqual([
      "md-x402-eth-snapshot-rh", "md-rh-eth-snapshot",
      "md-x402-eth-snapshot-arbsep", "md-arbsep-eth-snapshot",
      "md-x402-eth-snapshot-hyperevm", "md-hyperevm-eth-snapshot",
      "md-x402-eth-snapshot-sepolia", "md-sepolia-eth-snapshot",
    ]);
    for (const chain of ALL) {
      const c = EVM_TESTNETS[chain];
      const inbound = document.router.routes[`md-x402-eth-snapshot-${chain}`];
      expect(inbound).toEqual({
        routeId: `md-x402-eth-snapshot-${chain}`,
        canonicalPath: `/v1/routes/md-x402-eth-snapshot-${chain}/resource`,
        rail: "x402",
        sourceRail: "x402",
        source: { amount: "10000", asset: c.asset, decimals: 6, network: c.network, payTo: RECEIVER },
        destination: { scheme: "exact", network: "eip155:84532", asset: BASE_USDC, payTo: PROVIDER_A },
      });
      const outbound = document.router.routes[`md-${chain}-eth-snapshot`];
      expect(outbound).toEqual({
        routeId: `md-${chain}-eth-snapshot`,
        canonicalPath: `/v1/routes/md-${chain}-eth-snapshot/resource`,
        rail: "x402",
        sourceRail: "x402",
        source: { amount: "10000", asset: BASE_USDC, decimals: 6, network: "eip155:84532", payTo: RECEIVER },
        destination: { scheme: "exact", network: c.network, asset: c.asset, payTo: PROVIDER },
      });
      expect(document.x402.upstreams[`md-x402-eth-snapshot-${chain}`]).toBe(UPSTREAM_X402);
      expect(document.x402.upstreams[`md-${chain}-eth-snapshot`]).toBe(PROVIDER_URLS[`SUBETHA_EVM_PROVIDER_URL_${chain.toUpperCase()}` as keyof typeof PROVIDER_URLS]);
      expect(document.x402.inboundFacilitators[c.network]).toEqual({ kind: "x402", url: FACILITATOR });
    }
    expect(Object.keys(document.x402.inboundFacilitators)).toHaveLength(4);
    expect(document.router.approvalTtlMs).toBe(600_000);
    expect(document.router.budget).toEqual({
      maxPurchases: 32,
      buckets: [
        { network: "eip155:84532", asset: BASE_USDC, maxTotal: "200000", maxPerPurchase: "10000" },
        ...ALL.map((chain) => ({ network: EVM_TESTNETS[chain].network, asset: EVM_TESTNETS[chain].asset, maxTotal: "50000", maxPerPurchase: "10000" })),
      ],
    });
    const config = loadAsProduction(plan.config, plan.childEnv);
    expect(Object.keys(config.router.routes)).toHaveLength(8);
    expect(config.real!.x402InboundFacilitators).toEqual(Object.fromEntries(ALL.map((chain) => [EVM_TESTNETS[chain].network, { kind: "x402", url: FACILITATOR }])));
    expect(config.real!.x402InboundFacilitatorUrl).toBe(INBOUND.facilitator.replace(/\/$/, ""));
    expect(config.router.dynamic).toBeUndefined();
  });

  test("部分集合（rh だけ）: その chain の 2 本と区分だけ。ほかの chain の Provider の URL は要らない", () => {
    const document = evmTestnetsConfigOf({ SUBETHA_EVM_FACILITATOR_URL: FACILITATOR, SUBETHA_EVM_PROVIDER_PAYTO: PROVIDER, SUBETHA_EVM_PROVIDER_URL_RH: PROVIDER_URLS.SUBETHA_EVM_PROVIDER_URL_RH }, RECEIVER, ["rh"]) as any;
    expect(Object.keys(document.router.routes)).toEqual(["md-x402-eth-snapshot-rh", "md-rh-eth-snapshot"]);
    expect(document.router.budget.buckets.map((b: any) => b.network)).toEqual(["eip155:84532", "eip155:46630"]);
    expect(Object.keys(document.x402.inboundFacilitators)).toEqual(["eip155:46630"]);
  });

  test("env の欠落・形の誤り・chain の誤りは例外（値は出さない）", () => {
    const run = (env: Record<string, string | undefined>, chains: any = ALL) => () => evmTestnetsConfigOf(env, RECEIVER, chains);
    expect(run({ ...evmEnv, SUBETHA_EVM_FACILITATOR_URL: "" })).toThrow(/SUBETHA_EVM_FACILITATOR_URL is required/);
    expect(run({ ...evmEnv, SUBETHA_EVM_PROVIDER_PAYTO: undefined })).toThrow(/SUBETHA_EVM_PROVIDER_PAYTO/);
    expect(run({ ...evmEnv, SUBETHA_EVM_PROVIDER_PAYTO: "0x1234" })).toThrow(/SUBETHA_EVM_PROVIDER_PAYTO/);
    expect(run({ ...evmEnv, SUBETHA_EVM_PROVIDER_URL_SEPOLIA: undefined })).toThrow(/SUBETHA_EVM_PROVIDER_URL_SEPOLIA is required/);
    expect(run(evmEnv, [])).toThrow();
    expect(run(evmEnv, ["rh", "rh"])).toThrow();
    expect(run(evmEnv, ["base"])).toThrow();
    try {
      evmTestnetsConfigOf({ ...evmEnv, SUBETHA_EVM_PROVIDER_PAYTO: "0xSECRETISH" }, RECEIVER, ALL);
    } catch (error) {
      expect(String(error)).not.toContain("SECRETISH");
    }
  });
});

describe("hostPlanOf の EVM testnet の分岐", () => {
  test("専用の子・子の env は allowlist（x402 の鍵・Base の facilitator・SubEtha の URL・EVM の URL と受取先・chain）。MPP・多レールの鍵は無い", () => {
    const plan = hostPlanOf(evmOptions, { ...hostEnv, SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-x", SUBETHA_TEMPO_RPC_URL: "https://tempo.example/TOKEN", SUBETHA_ARC_RECEIVER_KEY: generatePrivateKey(), SUBETHA_OUTBOUND_SOLANA_KEY: "x" });
    expect(plan.childScript).toBe(EVM_TESTNETS_ROUTER_PROCESS);
    expect(plan.journalPath).toBe("/tmp/evm-testnets.ndjson");
    expect(Object.keys(plan.childEnv).sort()).toEqual([
      "ROUTER_ADAPTER_MODE", "ROUTER_CANONICAL_BASE_URL", "ROUTER_HTTP_PORT", "ROUTER_JOURNAL_PATH", "ROUTER_PRINCIPAL_TOKENS",
      "ROUTER_SUBETHA_FACILITATOR_URL", "ROUTER_X402_INBOUND_FACILITATOR_URL", "ROUTER_X402_INBOUND_OFFER_SECONDS",
      "SUBETHA_EVM_CHAINS", "SUBETHA_EVM_FACILITATOR_URL", "SUBETHA_EVM_PROVIDER_PAYTO",
      "SUBETHA_EVM_PROVIDER_URL_ARBSEP", "SUBETHA_EVM_PROVIDER_URL_HYPEREVM", "SUBETHA_EVM_PROVIDER_URL_RH", "SUBETHA_EVM_PROVIDER_URL_SEPOLIA",
      "SUBETHA_OUTBOUND_X402_KEY", "SUBETHA_RAILS_ACTIVATION",
    ].sort());
    expect(plan.childEnv).toMatchObject({
      SUBETHA_OUTBOUND_X402_KEY: outboundKey,
      ROUTER_X402_INBOUND_FACILITATOR_URL: "https://www.x402.org/facilitator",
      ROUTER_SUBETHA_FACILITATOR_URL: "https://www.x402.org/facilitator",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_JOURNAL_PATH: "/tmp/evm-testnets.ndjson",
      SUBETHA_EVM_CHAINS: "rh,arbsep,hyperevm,sepolia",
      SUBETHA_EVM_FACILITATOR_URL: FACILITATOR,
      SUBETHA_EVM_PROVIDER_PAYTO: PROVIDER,
      [RAILS_ACTIVATION_ENV]: "",
      ...PROVIDER_URLS,
    });
    // 別の x402 の鍵があればそれを渡す（公開の分岐と同じ規則）。
    const other = generatePrivateKey();
    expect(hostPlanOf(evmOptions, { ...hostEnv, SUBETHA_OUTBOUND_X402_KEY: other }).childEnv["SUBETHA_OUTBOUND_X402_KEY"]).toBe(other);
    // 選んだ chain の URL だけを渡す。
    const rhOnly = hostPlanOf({ ...evmOptions, evmTestnets: { chains: ["rh"] } }, hostEnv);
    expect(Object.keys(rhOnly.childEnv).filter((key) => key.startsWith("SUBETHA_EVM_PROVIDER_URL_"))).toEqual(["SUBETHA_EVM_PROVIDER_URL_RH"]);
    expect(rhOnly.childEnv["SUBETHA_EVM_CHAINS"]).toBe("rh");
  });

  test("loopback 以外の bind・mainnet との併用・env の欠落・空の chain は計画を作らない", () => {
    expect(() => hostPlanOf({ ...evmOptions, bind: "0.0.0.0" }, hostEnv)).toThrow(HostPlanError);
    expect(() => hostPlanOf({ ...evmOptions, mainnetFirstRoute: true }, hostEnv)).toThrow(HostPlanError);
    expect(() => hostPlanOf({ ...evmOptions, evmTestnets: { chains: [] } }, hostEnv)).toThrow(HostPlanError);
    expect(() => hostPlanOf(evmOptions, { ...hostEnv, SUBETHA_EVM_FACILITATOR_URL: undefined } as any)).toThrow(HostPlanError);
    expect(() => hostPlanOf(evmOptions, { ...hostEnv, SUBETHA_ROUTER_RECEIVER: undefined } as any)).toThrow(HostPlanError);
  });

  test("入口の選択肢: 既定は 4 chain・port 0・専用の journal。公開の journal・127.0.0.1 以外の bind・壊れた port・知らない chain は拒む。告知は鍵・URL を含まない", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "evm-testnets-options-"));
    dirs.push(dir);
    const journal = path.join(dir, "evm.ndjson");
    const options = evmTestnetsOptionsOf({ SUBETHA_EVM_TESTNETS_JOURNAL_PATH: journal, SUBETHA_JOURNAL_PATH: path.join(dir, "public.ndjson") });
    expect(options).toMatchObject({ bind: "127.0.0.1", port: 0, journalPath: journal, evmTestnets: { chains: ALL } });
    expect(evmTestnetsOptionsOf({ SUBETHA_EVM_TESTNETS_JOURNAL_PATH: journal }, ["--chains", "sepolia,rh"]).evmTestnets.chains).toEqual(["rh", "sepolia"]);
    expect(() => evmTestnetsOptionsOf({ SUBETHA_EVM_TESTNETS_JOURNAL_PATH: journal, SUBETHA_JOURNAL_PATH: journal })).toThrow(/public journal/);
    expect(() => evmTestnetsOptionsOf({ SUBETHA_EVM_TESTNETS_JOURNAL_PATH: journal, SUBETHA_EVM_TESTNETS_BIND: "0.0.0.0" })).toThrow();
    expect(() => evmTestnetsOptionsOf({ SUBETHA_EVM_TESTNETS_JOURNAL_PATH: journal, SUBETHA_EVM_TESTNETS_PORT: "70000" })).toThrow();
    expect(() => evmTestnetsOptionsOf({ SUBETHA_EVM_TESTNETS_JOURNAL_PATH: journal }, ["--chains", "base"])).toThrow();
    expect(JSON.parse(evmTestnetsAnnouncementOf({ mcpPort: 8610, mcpAddress: "127.0.0.1", routerPort: 40000 }, ALL))).toEqual({ event: "listening", port: 8610, address: "127.0.0.1", routerPort: 40000, mode: "evm-testnets", chains: "rh,arbsep,hyperevm,sepolia" });
  });
});

describe("専用の子の能力（evmTestnetsCapabilitiesOf）", () => {
  const childEnvOf = (extra: Record<string, string | undefined> = {}) => ({ ...hostPlanOf(evmOptions, hostEnv).childEnv, ...extra });

  test("公開の子と同じ能力に、選んだ chain の evmSigningByNetwork（同じ鍵）と loopback の origin（facilitator・Provider）だけを足す", () => {
    const env = childEnvOf();
    // 公開の子の能力は `SUBETHA_EVM_FACILITATOR_URL` を hosted の規則で読む（hosted 設計 §3）。この子はそれを通さずに渡す（`evmTestnetsCapabilitiesOf`）ので、比べる相手も同じ env を除いたもの。
    const { SUBETHA_EVM_FACILITATOR_URL: _url, ...publicEnv } = env;
    const base = routerProcessCapabilitiesOf(publicEnv);
    const capabilities = evmTestnetsCapabilitiesOf(env);
    const address = privateKeyToAccount(outboundKey).address;
    expect(capabilities.evmSigning?.network).toBe("eip155:84532");
    expect(capabilities.evmSigning?.signer.address).toBe(address);
    expect(Object.keys(capabilities.evmSigningByNetwork ?? {})).toEqual(ALL.map((chain) => EVM_TESTNETS[chain].network));
    for (const [network, capability] of Object.entries(capabilities.evmSigningByNetwork ?? {})) {
      expect(capability.network).toBe(network);
      expect(capability.signer.address).toBe(address);
      expect(capability.kind).toBe("real-key");
    }
    expect(capabilities.localCounterparties).toEqual({ origins: ["http://127.0.0.1:8611", "http://127.0.0.1:8621", "http://127.0.0.1:8622", "http://127.0.0.1:8623", "http://127.0.0.1:8624"] });
    // それ以外の欄は公開の子と同じ。
    const { evmSigningByNetwork: _a, localCounterparties: _b, evmSigning: _c, ...rest } = capabilities;
    const { evmSigning: _d, ...baseRest } = base;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(baseRest).sort());
    expect(rest.dependencyUrls).toEqual(baseRest.dependencyUrls);
    expect(rest.mppTempo).toBeUndefined();
  });

  test("127.0.0.1 の literal でない URL（名前・https）は allowlist に入れない（その URL は今の transport のまま。loopback の名前は起動時に拒まれる）", () => {
    const capabilities = evmTestnetsCapabilitiesOf(childEnvOf({ SUBETHA_EVM_FACILITATOR_URL: "http://localhost:8611/tok", SUBETHA_EVM_PROVIDER_URL_RH: "https://provider.example/v1/eth/snapshot" }));
    expect(capabilities.localCounterparties?.origins).toEqual(["http://127.0.0.1:8622", "http://127.0.0.1:8623", "http://127.0.0.1:8624"]);
  });

  test("鍵・chain・URL の欠落は固定文で止まる（値は出さない）", () => {
    const failure = (env: Record<string, string | undefined>) => {
      try {
        evmTestnetsCapabilitiesOf(env);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(failure(childEnvOf({ SUBETHA_OUTBOUND_X402_KEY: "" }))).toMatchObject({ code: "outbound_keys" });
    expect(failure(childEnvOf({ SUBETHA_EVM_CHAINS: "rh,base" }))).toMatchObject({ code: "chains" });
    expect(failure(childEnvOf({ SUBETHA_EVM_PROVIDER_URL_RH: "" }))).toMatchObject({ code: "urls" });
    expect(failure(childEnvOf({ SUBETHA_EVM_FACILITATOR_URL: "not a url" }))).toMatchObject({ code: "urls" });
    expect(failure(childEnvOf({ SUBETHA_EVM_FACILITATOR_URL: "not a url" }))).toBeInstanceOf(EvmTestnetsProcessError);
  });
});

describe("公開の入口には EVM testnet のものが無い（FR-E6・AC-E5。golden の補い）", () => {
  const goldenEnv = { SUBETHA_OUTBOUND_PRIVATE_KEY: "0x" + "11".repeat(32), SUBETHA_ROUTER_RECEIVER: RECEIVER, SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-golden", SUBETHA_TEMPO_RPC_URL: "https://tempo.example/v1/TOKEN", SUBETHA_ARC_RECEIVER_KEY: "0x" + "22".repeat(32), SUBETHA_SOLANA_RECEIVER: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5", SUBETHA_OUTBOUND_SOLANA_KEY: "2Lo8Y9kVf2iN4z3e5ZQ9k3nQJc7wq6yQx8k2mF9sP4tHc5uW1bX7aN3dR6gT9jK2", SUBETHA_ARC_PROVIDER_PAYTO: "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1", SUBETHA_SOLANA_PROVIDER_PAYTO: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d", SUBETHA_SOLANA_MPP_PROVIDER_PAYTO: "26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc" };
  const golden = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/config-golden", `${name}.json`), "utf8"));

  test.each([["public", RAILS_ACTIVATION], ["none", RAILS_NONE]] as const)("公開の計画（%s）: EVM の env を与えても golden と一致し、子は公開の子、子の env・能力に localCounterparties・SUBETHA_EVM_* が無い", (name, activation) => {
    const plan = hostPlanOf({ activation, bind: "127.0.0.1", port: 0, journalPath: "/tmp/golden.ndjson" }, { ...goldenEnv, ...evmEnv, SUBETHA_EVM_CHAINS: "rh,arbsep" });
    const expected = golden(name);
    expect(plan.config).toEqual(expected.config);
    expect(plan.childEnv).toEqual(expected.childEnv);
    expect(plan.childScript).toBe(PUBLIC_ROUTER_PROCESS);
    const text = JSON.stringify({ config: plan.config, childEnv: plan.childEnv, childScript: plan.childScript });
    expect(text).not.toMatch(/localCounterparties|SUBETHA_EVM_|evm-testnets-router-process|eip155:46630|eip155:421614|eip155:998"|eip155:11155111|127\.0\.0\.1:86/);
    // 公開の子の能力（同じ関数）にも無い。子の env にローカル版の EVM の値（Provider の URL・受取先・chain）を足しても読まれない。
    // hosted の内部の env `SUBETHA_EVM_FACILITATOR_URL` だけは公開の子が読む（hosted 設計 §3。`tests/unit/evm-hosted-config.test.ts`）ので、ここでは足さない。
    const seed = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
    const { SUBETHA_EVM_FACILITATOR_URL: _url, ...localOnlyEnv } = evmEnv;
    const capabilities = routerProcessCapabilitiesOf({ ...plan.childEnv, ...localOnlyEnv, SUBETHA_EVM_CHAINS: "rh,arbsep", ...(plan.childEnv["SUBETHA_OUTBOUND_SOLANA_KEY"] === undefined ? {} : { SUBETHA_OUTBOUND_SOLANA_KEY: seed }) });
    expect(Object.keys(capabilities)).not.toContain("localCounterparties");
    expect(Object.keys(capabilities.evmSigningByNetwork ?? {}).filter((network) => EVM_TESTNET_NETWORKS.has(network))).toEqual([]);
  });

  test("mainnet の計画も公開の子のまま", () => {
    const plan = hostPlanOf({ activation: RAILS_NONE, bind: "127.0.0.1", port: 0, journalPath: "/tmp/m.ndjson", mainnetFirstRoute: true }, { ...goldenEnv, ...evmEnv });
    expect(plan.childScript).toBe(PUBLIC_ROUTER_PROCESS);
    expect(JSON.stringify(plan)).not.toMatch(/SUBETHA_EVM_|localCounterparties/);
  });

  test("静的検査: 公開の子・能力の組み立て・公開の生成はローカル版の EVM testnet の env（Provider の URL・受取先・chain）と専用の子を参照しない。本番の入口は試験用の上書きを渡さない", () => {
    // hosted 設計 §3・§5（H-3）: 公開の側が読む EVM の env は facilitator の URL（`SUBETHA_EVM_FACILITATOR_URL`、定数 `EVM_FACILITATOR_URL_ENV`）だけ。
    for (const file of ["tools/remote-router-process.ts", "tools/rails-entry.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source.replaceAll("SUBETHA_EVM_FACILITATOR_URL", "")).not.toMatch(/SUBETHA_EVM_|evm-testnets|EVM_PROVIDER|EVM_CHAINS_ENV|evmTestnetChainsOf|evmProviderUrlEnvOf/);
    }
    expect(readFileSync("tools/remote-router-process.ts", "utf8")).not.toMatch(/localCounterparties/);
    // 公開の生成（`routerConfigOf`）の本体はローカル版の生成・env を使わない（EVM testnet の定数と facilitator の URL の env は hosted の有効化の分だけ）。
    const config = readFileSync("tools/remote-mcp-config.ts", "utf8");
    const publicPart = config.slice(config.indexOf("export function routerConfigOf"), config.indexOf("/* ------------------------------------------------------------------ mainnet"));
    expect(publicPart).not.toMatch(/evmTestnets|SUBETHA_EVM_|EVM_PROVIDER|EVM_CHAINS_ENV/);
    // 試験用の上書き（子の script・env）を渡すのは試験の fixture だけ。
    for (const file of readdirSync("tools").filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join("tools", file), "utf8");
      if (file === "remote-mcp.ts") continue;
      expect(source, file).not.toMatch(/childScriptForTest|childEnvExtraForTest/);
    }
    // `src/**` で localCounterparties を渡す（作る）場所は無い（能力は起動側だけが作る）。
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).not.toMatch(/localCounterparties:\s*\{/);
  });
});
