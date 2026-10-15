/**
 * 本番の入口の多レール（`tools/rails-entry.ts`・`tools/remote-router-process.ts` の能力・`tools/rails-acceptance-run.ts` の選択肢。
 * multirail 設計 §3・§8、タスク T8-b）。**鍵は乱数**。接続はしない（配線の組み立てと offer の発行まで）。
 */
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";

import { DynamicChallengeError } from "../../src/adapters/outbound/x402-dynamic.js";
import { ConfigError, loadRuntimeConfig, routeBindingOf, type RuntimeConfig } from "../../src/config.js";
import { composeRails, DEFAULT_SOLANA_RPC_URL, type DynamicTransportHooks, type RouterCapabilities } from "../../src/main.js";
import { createMcpIngress } from "../../src/mcp/ingress.js";
import { acceptanceOptionsOf, announcementOf, sameJournal } from "../../tools/rails-acceptance-run.js";
import { activationFromEnv, activationToEnv, ProcessEntryError, RAILS_ACTIVATION_ENV, railsCapabilitiesOf, railsChildEnvOf, railsOptionsOf, railsReceiversOf, routerProcessCapabilitiesOf, SOLANA_RECEIVER_ENV, SOLANA_RPC_ENV, solanaRpcUrlOf,
  ARC_PROVIDER_ENV,
  SOLANA_OUTBOUND_KEY_ENV,
  SOLANA_MPP_PROVIDER_ENV,
  SOLANA_PROVIDER_ENV,
  railsProvidersOf,
} from "../../tools/rails-entry.js";
import { createRealSvmCapability } from "../../tools/real-svm-capability.js";
import { getBase58Decoder } from "@solana/kit";
import { createRealEvmCapability } from "../../tools/real-evm-capability.js";
import { createRealMppCapability } from "../../tools/real-mpp-capability.js";
import { ARC_RECEIVER_KEY_ENV } from "../../tools/real-seller-proof-capability.js";
import { INBOUND_ARC, INBOUND_SOL, OUTBOUND_SOL, RAIL_UPSTREAMS, railActive, RAILS_ACTIVATION, RAILS_NONE, ROUTE_ARC, ROUTE_SOL, routerConfigOf, type RailsActivation } from "../../tools/remote-mcp-config.js";
import { HostPlanError, hostPlanOf, listenMcp, publicJournalPathOf, type HostOptions,
  hasX402Outbound,
} from "../../tools/remote-mcp.js";
import { FIXTURE_PUBLIC_ADDRESS, UnmappedFixtureHostError } from "../fixtures/dynamic/dial.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const SOL_OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const BOTH: RailsActivation = { arc: { inbound: true, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } };
const NONE: RailsActivation = { arc: { inbound: false, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } };
/**
 * 公開の定数 `RAILS_ACTIVATION` の有効化の語: G-4⁗ までの 8 語の後ろに、EVM testnet 3 つの 6 語（hosted 設計 §8.2 の G-4、2026-10-14 に全部 true）。
 */
const PUBLIC_TOKENS = "arc-in,arc-out,solana-in,solana-out,solana-mpp-in,solana-mpp-out,arc-to-sol,sol-to-arc,rh-in,rh-out,arbsep-in,arbsep-out,hyperevm-in,hyperevm-out";
/**
 * G-4 の後の公開の計画は自前の EVM facilitator の子を計画するので、その env が要る（gas 鍵・token・有効な chain ごとの gas の上限・Provider の受取先）。
 * 値は試験用の固定値（本物の鍵ではない）。facilitator の URL は計画が token と既定の port 8611 から作る。
 */
const EVM_FAC_TOKEN = "rails-entry-test-token_0123456789abcdefABCDEF";
const EVM_FACILITATOR_ENV = { SUBETHA_EVM_FACILITATOR_KEY: "0x" + "44".repeat(32), SUBETHA_EVM_FACILITATOR_TOKEN: EVM_FAC_TOKEN, SUBETHA_EVM_FACILITATOR_GAS_CAP_46630: "1000000000000000", SUBETHA_EVM_FACILITATOR_GAS_CAP_421614: "1000000000000000", SUBETHA_EVM_FACILITATOR_GAS_CAP_998: "1000000000000000", SUBETHA_EVM_PROVIDER_PAYTO: "0xf8243d93F339807CA9846Aa31155A2B2262D08db" };
const isEvmProfile = (id: string): boolean => /dyn-(rh|arbsep|hyperevm)-|-to-(rh|arbsep|hyperevm)$/.test(id);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function envWith(extra: Record<string, string> = {}): Record<string, string> {
  return { [ARC_RECEIVER_KEY_ENV]: generatePrivateKey(), [SOLANA_RECEIVER_ENV]: SOL_OWNER, ...extra };
}

/** 本番と同じ読み方（real モード = KNOWN_NETWORKS、env の facilitator）で、生成した設定を読む。 */
function loadAsProduction(document: Record<string, unknown>, extraEnv: Record<string, string> = {}): RuntimeConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "t8b-entry-"));
  dirs.push(dir);
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  return loadRuntimeConfig(
    {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: "https://www.x402.org/facilitator",
      ROUTER_X402_INBOUND_FACILITATOR_URL: "https://www.x402.org/facilitator",
      ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-t8b",
      ROUTER_CANONICAL_BASE_URL: "https://router.test",
      ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
      ...extraEnv,
    },
    (file) => readFileSync(file, "utf8"),
  );
}

/** 接続しない transport の差し替え（名前解決は公開アドレス、接続先は表に無いので失敗する）。 */
const noDial: DynamicTransportHooks = {
  interfaces: () => [],
  lookup: (_hostname, _options, callback) => callback(null, [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }]),
  dialForTest: () => {
    throw new UnmappedFixtureHostError();
  },
};

/** process の入口と同じ組み立て: 送信の能力（乱数の鍵）＋ 多レールの能力。 */
function capabilitiesOf(activation: RailsActivation, env: Record<string, string>): RouterCapabilities {
  const rails = railsCapabilitiesOf(activation, env);
  return {
    evmSigning: createRealEvmCapability(generatePrivateKey()).capability("eip155:84532"),
    mppTempo: createRealMppCapability(generatePrivateKey()).capability(),
    dependencyUrls: ["https://rpc.moderato.tempo.xyz/", ...(rails.dependencyUrls ?? [])],
    ...(rails.sellerProofs === undefined ? {} : { sellerProofs: rails.sellerProofs }),
    transportHooksForTest: noDial,
    dynamicTransportHooksForTest: noDial,
  };
}

describe("有効化の値（ホスト → process の内部 env）", () => {
  test("往復: 定数（どちらも無効）は空文字、arc・solana・両方はその語。知らない語・重複・空の語は起動しない", () => {
    expect(activationToEnv(NONE)).toBe("");
    expect(activationToEnv(RAILS_ACTIVATION)).toBe(PUBLIC_TOKENS);
    expect(activationFromEnv("")).toEqual(NONE);
    expect(activationFromEnv(undefined)).toEqual(NONE);
    for (const activation of [{ arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, { arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, BOTH]) {
      expect(activationFromEnv(activationToEnv(activation))).toEqual(activation);
    }
    expect(activationFromEnv(" solana-in , arc-in ")).toEqual(BOTH);
    for (const bad of ["base", "arc,base", "arc-in,arc-in", "true", "1", "arc-in,", "ARC-IN", "arc", "solana", "arc,solana", "arc-out,arc-out"]) {
      expect(() => activationFromEnv(bad), bad).toThrow(/SUBETHA_RAILS_ACTIVATION must be a comma-separated subset/);
    }
  });
});

describe("能力と受取先は 1 つの有効化の値から（設定生成と同じ値）", () => {
  test("無効なら env を読まない: 壊れた鍵・受取 owner が無くても何も作らず、何も出ない。鍵・受取 owner・RPC の欄は参照もされない", () => {
    const touched: string[] = [];
    const env = new Proxy({ [ARC_RECEIVER_KEY_ENV]: "not-a-key", [SOLANA_RPC_ENV]: "https://rpc.example/v1/SECRETTOKEN", [SOLANA_RECEIVER_ENV]: SOL_OWNER } as Record<string, string>, {
      get(target, property) {
        if (typeof property === "string") touched.push(property);
        return target[property as string];
      },
      has(target, property) {
        if (typeof property === "string") touched.push(property);
        return property in target;
      },
    });
    const rails = [ARC_RECEIVER_KEY_ENV, SOLANA_RECEIVER_ENV, SOLANA_RPC_ENV];
    expect(railsCapabilitiesOf(NONE, env)).toEqual({});
    expect(railsReceiversOf(NONE, env)).toEqual({});
    expect(railsChildEnvOf(NONE, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "" });
    expect(touched.filter((name) => rails.includes(name))).toEqual([]);
    // 片方だけ有効なら、もう片方の欄は参照されない。
    touched.length = 0;
    railsChildEnvOf({ arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, env);
    railsReceiversOf({ arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, env);
    expect(touched.filter((name) => rails.includes(name)).sort()).toEqual([ARC_RECEIVER_KEY_ENV, SOLANA_RECEIVER_ENV]);
    expect(railsCapabilitiesOf(NONE, env)).toEqual({});
    expect(railsReceiversOf(NONE, env)).toEqual({});
    expect(railsChildEnvOf(NONE, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "" });
    // 無効の設定生成にも何も出ない（T8-a）。
    const document = routerConfigOf({}, RECEIVER, true, railsOptionsOf(NONE, env));
    expect(document).toEqual(routerConfigOf({}, RECEIVER, true));
  });

  test("Arc が有効: 能力は env の鍵から作られ、その address が route とプロファイルの両方の payTo になり、配線が束縛を通す（offer の payTo = address）", async () => {
    const env = envWith();
    const expected = privateKeyToAccount(env[ARC_RECEIVER_KEY_ENV] as `0x${string}`).address;
    const activation: RailsActivation = { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } };
    const rails = railsOptionsOf(activation, env);
    expect(rails.receivers).toEqual({ arc: expected });
    const capabilities = capabilitiesOf(activation, env);
    expect(capabilities.sellerProofs?.[INBOUND_ARC.network]).toMatchObject({ network: INBOUND_ARC.network, address: expected });
    const config = loadAsProduction(routerConfigOf({}, RECEIVER, true, rails));
    expect(config.router.routes[ROUTE_ARC]?.source.payTo).toBe(expected);
    expect(config.router.dynamic?.profiles["dyn-arc-to-mpp"]?.source.payTo).toBe(expected);
    expect(config.router.dynamic?.profiles["dyn-arc-to-x402"]?.source.payTo).toBe(expected);
    // 配線は route とプロファイルの両方に束縛する（起動時の照合が通り、offer の payTo は能力の address）。Solana は無効なので起動時の検査は無い。
    const composed = composeRails(config, capabilities, () => {}, () => {});
    expect(composed.startup).toBeUndefined();
    const route = config.router.routes[ROUTE_ARC]!;
    const offer = await composed.inbound.createOffer({ routeId: ROUTE_ARC, amount: route.source.amount, asset: route.source.asset, network: route.source.network, routeBinding: routeBindingOf(route), nowMs: Date.now() });
    expect(offer.payTo).toBe(expected);
    expect(offer.extra["assetTransferMethod"]).toBe("eip3009");
    const profileOffer = await composed.inbound.createOffer({ routeId: "dyn-arc-to-x402", amount: "2000", asset: INBOUND_ARC.asset, network: INBOUND_ARC.network, routeBinding: "dynamic|dyn-arc-to-x402|GET|https%3A%2F%2Fprovider.test%2Fv1%2Fx", nowMs: Date.now() });
    expect(profileOffer.payTo).toBe(expected);
    // 能力の署名は `proofFor` の中だけ（鍵は能力の外に無い）。
    expect(Object.keys(capabilities.sellerProofs![INBOUND_ARC.network]!).sort()).toEqual(["address", "network", "proofFor"]);
  });

  test("鍵と payTo が違えば起動しない: 別の鍵で作った能力（route だけ・プロファイルだけ・両方）は配線が止める", () => {
    const env = envWith();
    const activation: RailsActivation = { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } };
    const rails = railsOptionsOf(activation, env);
    const other = capabilitiesOf(activation, envWith());
    expect(() => composeRails(loadAsProduction(routerConfigOf({}, RECEIVER, true, rails)), other, () => {}, () => {})).toThrow(/seller proof capability is bound to a different network or address/);
    // route だけ別の payTo（プロファイルは能力と一致）。
    const mine = capabilitiesOf(activation, env);
    const document = routerConfigOf({}, RECEIVER, true, rails) as { router: { routes: Record<string, { source: { payTo: string } }>; dynamic: { profiles: Record<string, { source: { payTo: string } }> } } };
    const otherAddress = privateKeyToAccount(generatePrivateKey()).address;
    const routeOnly = structuredClone(document);
    routeOnly.router.routes[ROUTE_ARC]!.source.payTo = otherAddress;
    expect(() => composeRails(loadAsProduction(routeOnly as unknown as Record<string, unknown>), mine, () => {}, () => {})).toThrow(new RegExp(`routes.${ROUTE_ARC}: the seller proof capability is bound to a different network or address`));
    const profileOnly = structuredClone(document);
    profileOnly.router.dynamic.profiles["dyn-arc-to-mpp"]!.source.payTo = otherAddress;
    expect(() => composeRails(loadAsProduction(profileOnly as unknown as Record<string, unknown>), mine, () => {}, () => {})).toThrow(/dynamic.profiles.dyn-arc-to-mpp: the seller proof capability is bound to a different network or address/);
  });

  test.each([
    ["鍵が無い", {}],
    ["鍵の形が違う（短い）", { [ARC_RECEIVER_KEY_ENV]: "0x1234" }],
    ["鍵の形が違う（0x 無し）", { [ARC_RECEIVER_KEY_ENV]: "ab".repeat(32) }],
    ["鍵が address", { [ARC_RECEIVER_KEY_ENV]: RECEIVER }],
  ])("Arc が有効で %s → 能力も受取先も作らず、値はメッセージに出ない", (_name, env) => {
    const activation: RailsActivation = { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } };
    for (const build of [() => railsCapabilitiesOf(activation, env), () => railsReceiversOf(activation, env), () => railsOptionsOf(activation, env)]) {
      let caught: unknown;
      try {
        build();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/SUBETHA_ARC_RECEIVER_KEY must be a 0x-prefixed 32-byte hex key/);
      for (const value of Object.values(env)) expect((caught as Error).message).not.toContain(value);
    }
  });

  test("Solana が有効: 受取 owner は env から（無ければ起動しない）、能力に鍵は要らず、RPC が依存先（拒否ホスト）に入る。既定は公開 devnet", async () => {
    const activation: RailsActivation = { arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } };
    expect(() => railsReceiversOf(activation, {})).toThrow(/SUBETHA_SOLANA_RECEIVER is required when the solana rail is activated/);
    expect(() => railsOptionsOf(activation, { [SOLANA_RECEIVER_ENV]: "" })).toThrow(/SUBETHA_SOLANA_RECEIVER is required/);
    // RPC の URL は鍵を path に持つことがある（query は Router の設定が拒む）。
    const env = { [SOLANA_RECEIVER_ENV]: SOL_OWNER, [SOLANA_RPC_ENV]: "https://rpc.solana.example/v1/SECRETTOKEN" };
    expect(railsReceiversOf(activation, env)).toEqual({ solana: SOL_OWNER });
    expect(railsCapabilitiesOf(activation, env)).toEqual({ dependencyUrls: ["https://rpc.solana.example/v1/SECRETTOKEN"] });
    expect(solanaRpcUrlOf({})).toBe(DEFAULT_SOLANA_RPC_URL);
    expect(railsCapabilitiesOf(activation, { [SOLANA_RECEIVER_ENV]: SOL_OWNER })).toEqual({ dependencyUrls: [DEFAULT_SOLANA_RPC_URL] });
    // 受取 owner の形が違えば設定生成が止める（値は出ない）。
    expect(() => routerConfigOf({}, RECEIVER, true, railsOptionsOf(activation, { [SOLANA_RECEIVER_ENV]: RECEIVER }))).toThrow(/solana rail is activated but its receiver address is missing or malformed/);
    // 配線: RPC のホストは動的の上流に使えない（判定で止まり、接続しない）。env の RPC を Router の設定にも渡す。
    const config = loadAsProduction(routerConfigOf({}, RECEIVER, true, railsOptionsOf(activation, env)), { ROUTER_SOLANA_RPC_URL: env[SOLANA_RPC_ENV]! });
    expect(config.real?.solanaRpcUrl).toBe(env[SOLANA_RPC_ENV]);
    const composed = composeRails(config, capabilitiesOf(activation, env), () => {}, () => {});
    expect(composed.startup).toBeDefined();
    await expect(composed.outbound.readChallenge!("dyn-sol-to-x402", { url: "https://rpc.solana.example/v1/x", method: "GET" })).rejects.toMatchObject({ reason: "url" });
    await expect(composed.outbound.readChallenge!("dyn-sol-to-x402", { url: "https://sub.rpc.solana.example/v1/x", method: "GET" })).rejects.toBeInstanceOf(DynamicChallengeError);
  });

  test("子プロセスの env: 有効化の値と、有効なレールの鍵・RPC だけ（無効なレールの値は渡らない）", () => {
    const env = envWith({ [SOLANA_RPC_ENV]: "https://rpc.solana.example/v1/SECRETTOKEN", SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey() });
    expect(railsChildEnvOf(BOTH, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "arc-in,solana-in", [ARC_RECEIVER_KEY_ENV]: env[ARC_RECEIVER_KEY_ENV], [SOLANA_RPC_ENV]: env[SOLANA_RPC_ENV], ROUTER_SOLANA_RPC_URL: env[SOLANA_RPC_ENV] });
    expect(railsChildEnvOf({ arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "arc-in", [ARC_RECEIVER_KEY_ENV]: env[ARC_RECEIVER_KEY_ENV] });
    expect(railsChildEnvOf({ arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "solana-in", [SOLANA_RPC_ENV]: env[SOLANA_RPC_ENV], ROUTER_SOLANA_RPC_URL: env[SOLANA_RPC_ENV] });
    expect(railsChildEnvOf({ arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, envWith())).toEqual({ [RAILS_ACTIVATION_ENV]: "solana-in" });
    expect(railsChildEnvOf(NONE, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "" });
  });

  test("両方有効: 設定と能力が同じ値から出て、本番の読み方で通り、Arc の束縛も通る（Solana の起動時の検査は呼ばない）", () => {
    const env = envWith();
    const rails = railsOptionsOf(BOTH, env);
    const config = loadAsProduction(routerConfigOf({}, RECEIVER, true, rails));
    expect(Object.keys(config.router.routes).sort()).toContain(ROUTE_SOL);
    expect(config.router.routes[ROUTE_SOL]?.source.payTo).toBe(SOL_OWNER);
    expect(config.real?.x402InboundFacilitators?.[INBOUND_SOL.network]).toEqual({ kind: "x402", url: "https://www.x402.org/facilitator" });
    const capabilities = capabilitiesOf(BOTH, env);
    expect(capabilities.dependencyUrls).toContain(DEFAULT_SOLANA_RPC_URL);
    const composed = composeRails(config, capabilities, () => {}, () => {});
    expect(composed.startup).toBeDefined();
    expect(() => composeRails(config, capabilitiesOf(BOTH, envWith()), () => {}, () => {})).toThrow(ConfigError);
  });
});

describe("Router の process が注入する能力の全部（routerProcessCapabilitiesOf。process に触らない）", () => {
  test("内部の env の有効化から多レールの能力が足され、無効なら鍵の env は読まれない。送信の鍵が両方無ければ止まる", () => {
    const keys = { SUBETHA_OUTBOUND_X402_KEY: generatePrivateKey(), SUBETHA_OUTBOUND_MPP_KEY: generatePrivateKey() };
    const arcKey = generatePrivateKey();
    const on = routerProcessCapabilitiesOf({ ...keys, [RAILS_ACTIVATION_ENV]: "arc-in,solana-in", [ARC_RECEIVER_KEY_ENV]: arcKey, [SOLANA_RPC_ENV]: "https://rpc.solana.example/v1/SECRETTOKEN", SUBETHA_TEMPO_RPC_URL: "https://tempo.example/v1/TEMPOTOKEN" });
    expect(on.sellerProofs?.[INBOUND_ARC.network]?.address).toBe(privateKeyToAccount(arcKey).address);
    expect(on.dependencyUrls).toEqual(["https://tempo.example/v1/TEMPOTOKEN", "https://rpc.solana.example/v1/SECRETTOKEN"]);
    expect(on.evmSigning).toBeDefined();
    expect(on.mppTempo).toBeDefined();
    // 試験専用の能力は注入しない（本番の入口）。
    expect(Object.keys(on).sort()).toEqual(["dependencyUrls", "evmSigning", "mppTempo", "sellerProofs"]);
    const off = routerProcessCapabilitiesOf({ ...keys, [RAILS_ACTIVATION_ENV]: "", [ARC_RECEIVER_KEY_ENV]: "not-a-key" });
    expect(off.sellerProofs).toBeUndefined();
    expect(off.dependencyUrls).toEqual(["https://rpc.moderato.tempo.xyz"]);
    expect(Object.keys(off).sort()).toEqual(["dependencyUrls", "evmSigning", "mppTempo"]);
    // 片方の鍵だけでも起動できる。
    expect(Object.keys(routerProcessCapabilitiesOf({ SUBETHA_OUTBOUND_MPP_KEY: keys.SUBETHA_OUTBOUND_MPP_KEY })).sort()).toEqual(["dependencyUrls", "mppTempo"]);
    for (const [env, code] of [
      [{}, "outbound_keys"],
      [{ ...keys, [RAILS_ACTIVATION_ENV]: "arc" }, "rails"],
      [{ ...keys, [RAILS_ACTIVATION_ENV]: "arc", [ARC_RECEIVER_KEY_ENV]: "0xabc" }, "rails"],
      [{ ...keys, [RAILS_ACTIVATION_ENV]: "arc,base", [ARC_RECEIVER_KEY_ENV]: arcKey }, "rails"],
    ] as const) {
      let caught: unknown;
      try {
        routerProcessCapabilitiesOf(env);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProcessEntryError);
      expect((caught as ProcessEntryError).code).toBe(code);
      expect((caught as Error).message).not.toContain(arcKey.slice(2));
    }
  });
});

describe("ホストの起動の計画（hostPlanOf。公開の入口と受け入れ用の起動が同じ関数）", () => {
  const baseEnv = { SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(), SUBETHA_ROUTER_RECEIVER: RECEIVER, SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-plan" };

  test("無効の有効化: 子の env は従来の欄＋有効化 \"\" だけ。壊れた鍵があっても読まれない。journal は固定の公開パス", () => {
    const options: HostOptions = { activation: NONE, bind: "0.0.0.0", port: 8787, journalPath: publicJournalPathOf({}) };
    const plan = hostPlanOf(options, { ...baseEnv, [ARC_RECEIVER_KEY_ENV]: "not-a-key", SUBETHA_SOLANA_RECEIVER: "" });
    expect(plan.journalPath).toBe(path.resolve("runtime", "journal.ndjson"));
    expect(plan.childEnv).toEqual({
      SUBETHA_OUTBOUND_MPP_KEY: baseEnv.SUBETHA_OUTBOUND_PRIVATE_KEY,
      SUBETHA_OUTBOUND_X402_KEY: baseEnv.SUBETHA_OUTBOUND_PRIVATE_KEY,
      ROUTER_JOURNAL_PATH: plan.journalPath,
      ROUTER_HTTP_PORT: "0",
      ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: "https://www.x402.org/facilitator",
      ROUTER_X402_INBOUND_FACILITATOR_URL: "https://www.x402.org/facilitator",
      ROUTER_X402_INBOUND_OFFER_SECONDS: "600",
      ROUTER_MPP_INBOUND_SECRET: baseEnv.SUBETHA_MPP_INBOUND_SECRET,
      ROUTER_MPP_INBOUND_OFFER_SECONDS: "600",
      [RAILS_ACTIVATION_ENV]: "",
      // 診断の記録（タスク R-2）: journal の隣のファイル。
      SUBETHA_DIAGNOSTICS_PATH: path.join(path.dirname(plan.journalPath), "diagnostics", "router.ndjson"),
    });
    expect(plan.config).toEqual(routerConfigOf(baseEnv, RECEIVER, true));
  });

  test("受け入れ用の起動（Arc だけ）: 同じ関数で、設定は Arc の route・プロファイル、子の env は有効化 \"arc\" と鍵、journal は受け入れのパス", () => {
    const key = generatePrivateKey();
    const options = acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_JOURNAL_PATH: "/tmp/acc/journal.ndjson" }, ["--rails", "arc-in"]);
    const plan = hostPlanOf(options, { ...baseEnv, [ARC_RECEIVER_KEY_ENV]: key });
    expect(plan.journalPath).toBe(path.resolve("/tmp/acc/journal.ndjson"));
    expect(plan.childEnv).toMatchObject({ ROUTER_JOURNAL_PATH: path.resolve("/tmp/acc/journal.ndjson"), [RAILS_ACTIVATION_ENV]: "arc-in", [ARC_RECEIVER_KEY_ENV]: key });
    expect(plan.childEnv["ROUTER_CONFIG_PATH"]).toBeUndefined();
    const config = loadAsProduction(plan.config);
    expect(config.router.routes[ROUTE_ARC]?.source.payTo).toBe(privateKeyToAccount(key).address);
    expect(config.router.routes[ROUTE_SOL]).toBeUndefined();
    // 無効の計画と同じ関数・同じ env で、違うのは有効化と journal だけ。
    const publicPlan = hostPlanOf({ activation: NONE, bind: "0.0.0.0", port: 8787, journalPath: publicJournalPathOf({}) }, { ...baseEnv, [ARC_RECEIVER_KEY_ENV]: key });
    // 診断の記録のファイル（タスク R-2）も journal と同じく違う（それぞれの journal の隣）。
    expect(plan.childEnv["SUBETHA_DIAGNOSTICS_PATH"]).toBe(path.resolve("/tmp/acc/diagnostics/router.ndjson"));
    const { ROUTER_JOURNAL_PATH: _j1, [RAILS_ACTIVATION_ENV]: _a1, [ARC_RECEIVER_KEY_ENV]: _k1, SUBETHA_DIAGNOSTICS_PATH: _d1, ...acceptanceRest } = plan.childEnv;
    const { ROUTER_JOURNAL_PATH: _j2, [RAILS_ACTIVATION_ENV]: _a2, SUBETHA_DIAGNOSTICS_PATH: _d2, ...publicRest } = publicPlan.childEnv;
    expect(acceptanceRest).toEqual(publicRest);
  });

  test("公開の入口（定数 RAILS_ACTIVATION = Arc・Solana・Solana MPP の受信・送信すべて true、G-4″。EVM testnet 3 つも全部 true、G-4 2026-10-14）: 設定に 10 本の route と 56 本のプロファイル（G-4⁗ で O-5・O-6 を含む 20 本 + EVM の 36 本）が出て、子の env に有効化の 14 語と Arc の鍵・facilitator の URL が渡る。受取・facilitator の env はどれが欠けても計画は作れない。親の env の有効化の指定は無視される", () => {
    expect(RAILS_NONE).toEqual(NONE);
    const key = generatePrivateKey();
    const options: HostOptions = { activation: RAILS_ACTIVATION, bind: "0.0.0.0", port: 8787, journalPath: publicJournalPathOf({}) };
    // 送信が有効なので、Provider の受取先と Solana の送信鍵も要る（G-1′〜G-2′ でホストの env に置いた値の形）。
    const fullEnv = { ...baseEnv, [ARC_RECEIVER_KEY_ENV]: key, [SOLANA_RECEIVER_ENV]: SOL_OWNER, [ARC_PROVIDER_ENV]: "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1", [SOLANA_PROVIDER_ENV]: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d", [SOLANA_MPP_PROVIDER_ENV]: "26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc", [SOLANA_OUTBOUND_KEY_ENV]: getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32))), ...EVM_FACILITATOR_ENV };
    const plan = hostPlanOf(options, fullEnv);
    const config = loadAsProduction(plan.config);
    expect(Object.keys(config.router.routes).sort()).toEqual(["md-arc-eth-snapshot", "md-mpp-eth-snapshot", "md-mpp-eth-snapshot-arc", "md-mpp-eth-snapshot-solmpp", "md-sol-eth-snapshot-mpp", "md-solmpp-eth-snapshot", "md-solmpp-eth-snapshot-mpp", "md-x402-eth-snapshot", "md-x402-eth-snapshot-sol", "md-x402-eth-snapshot-solmpp"]);
    expect(Object.keys(config.router.dynamic!.profiles).filter((id) => !isEvmProfile(id)).sort()).toEqual(["dyn-arc-to-mpp", "dyn-arc-to-sol", "dyn-arc-to-solmpp", "dyn-arc-to-x402", "dyn-mpp-to-arc", "dyn-mpp-to-sol", "dyn-mpp-to-solmpp", "dyn-mpp-to-x402", "dyn-sol-to-arc", "dyn-sol-to-mpp", "dyn-sol-to-solmpp", "dyn-sol-to-x402", "dyn-solmpp-to-arc", "dyn-solmpp-to-mpp", "dyn-solmpp-to-sol", "dyn-solmpp-to-x402", "dyn-x402-to-arc", "dyn-x402-to-mpp", "dyn-x402-to-sol", "dyn-x402-to-solmpp"]);
    // G-4: EVM testnet 3 つの 36 本が後ろに足される（中身は tests/unit/evm-hosted-config.test.ts）。
    expect(Object.keys(config.router.dynamic!.profiles).filter(isEvmProfile)).toHaveLength(36);
    expect(Object.keys(config.router.dynamic!.profiles)).toHaveLength(56);
    expect(config.router.routes["md-solmpp-eth-snapshot"]?.destination.payTo).toBe("26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc");
    expect(config.router.routes["md-x402-eth-snapshot-solmpp"]?.source.payTo).toBe(SOL_OWNER);
    expect(config.router.routes[ROUTE_ARC]?.source.payTo).toBe(privateKeyToAccount(key).address);
    expect(config.router.routes[ROUTE_SOL]?.source.payTo).toBe(SOL_OWNER);
    expect(config.router.dynamic!.profiles["dyn-arc-to-x402"]?.source.payTo).toBe(privateKeyToAccount(key).address);
    expect(config.router.dynamic!.profiles["dyn-sol-to-mpp"]?.source.payTo).toBe(SOL_OWNER);
    expect(plan.childEnv).toMatchObject({ [RAILS_ACTIVATION_ENV]: PUBLIC_TOKENS, [ARC_RECEIVER_KEY_ENV]: key, ROUTER_MPP_INBOUND_SECRET: baseEnv.SUBETHA_MPP_INBOUND_SECRET, SUBETHA_EVM_FACILITATOR_URL: `http://127.0.0.1:8611/${EVM_FAC_TOKEN}` });
    expect(plan.childEnv[SOLANA_MPP_PROVIDER_ENV]).toBeUndefined();
    // G-4: facilitator の子が計画され（3 つの chain）、gas 鍵は Router の子には渡らない。
    expect(plan.facilitator?.networks).toEqual(["eip155:46630", "eip155:421614", "eip155:998"]);
    expect(JSON.stringify(plan.childEnv)).not.toContain("44".repeat(32));
    // 受取の env はどちらが欠けても止まる（片方ずつ）。
    const { [SOLANA_RECEIVER_ENV]: _s, ...noSolana } = fullEnv;
    const { [ARC_RECEIVER_KEY_ENV]: _a, ...noArc } = fullEnv;
    for (const env of [noSolana, noArc, baseEnv]) {
      let caught: unknown;
      try { hostPlanOf(options, env); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(HostPlanError);
      expect((caught as HostPlanError).code).toBe("rails");
    }
    // G-4: facilitator の env（gas 鍵・token・gas の上限・Provider の受取先）もどれが欠けても止まる（code evm_facilitator）。
    for (const name of Object.keys(EVM_FACILITATOR_ENV)) {
      const { [name]: _f, ...noFacilitator } = fullEnv as Record<string, string>;
      let caught: unknown;
      try { hostPlanOf(options, noFacilitator); } catch (error) { caught = error; }
      expect(caught, name).toBeInstanceOf(HostPlanError);
      expect((caught as HostPlanError).code, name).toBe("evm_facilitator");
    }
    // 親の env に有効化の指定があっても、定数が決める（無効化も変更もできない）。
    const conflicting = hostPlanOf(options, { ...fullEnv, [RAILS_ACTIVATION_ENV]: "", ARC_PROFILES_ENABLED: "false" });
    expect(conflicting.childEnv[RAILS_ACTIVATION_ENV]).toBe(PUBLIC_TOKENS);
    expect(conflicting.config).toEqual(plan.config);
  });

  test("env が足りない・受取先が導けない・設定が作れない → code つきで止まる（値は出ない）", () => {
    const options = acceptanceOptionsOf({}, ["--rails", "arc-in"]);
    const codes = (env: Record<string, string>) => {
      try {
        hostPlanOf(options, env);
      } catch (error) {
        expect(error).toBeInstanceOf(HostPlanError);
        return (error as HostPlanError).code;
      }
      return "none";
    };
    expect(codes({})).toBe("env");
    expect(codes({ SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey() })).toBe("env");
    expect(codes(baseEnv)).toBe("rails");
    expect(codes({ ...baseEnv, [ARC_RECEIVER_KEY_ENV]: "0xabc" })).toBe("rails");
    const solana = acceptanceOptionsOf({}, ["--rails", "solana-in"]);
    expect(() => hostPlanOf(solana, { ...baseEnv, [SOLANA_RECEIVER_ENV]: RECEIVER })).toThrow(HostPlanError);
    try {
      hostPlanOf(solana, { ...baseEnv, [SOLANA_RECEIVER_ENV]: RECEIVER });
    } catch (error) {
      expect((error as HostPlanError).code).toBe("config");
    }
  });

  test("MCP の入口は options.bind に実際に bind する（受け入れは 127.0.0.1、公開は 0.0.0.0）", async () => {
    const http = createMcpIngress({ handle: async (_req, res) => { res.end(); } });
    const bound = await listenMcp(http, "127.0.0.1", 0);
    expect(bound.address).toBe("127.0.0.1");
    expect(bound.port).toBeGreaterThan(0);
    await new Promise<void>((resolve) => http.close(() => resolve()));
    const open = createMcpIngress({ handle: async (_req, res) => { res.end(); } });
    const any = await listenMcp(open, "0.0.0.0", 0);
    expect(any.address).toBe("0.0.0.0");
    await new Promise<void>((resolve) => open.close(() => resolve()));
    expect(JSON.parse(announcementOf({ mcpPort: bound.port, mcpAddress: bound.address, routerPort: 4242 }, { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }))).toEqual({ event: "listening", port: bound.port, address: "127.0.0.1", routerPort: 4242, mode: "acceptance", rails: "arc-in" });
  });
});

describe("受け入れ用の journal は公開の journal と別のファイル（別名も見る）", () => {
  test("symlink のディレクトリ・symlink のファイル・hard link は同じと判定し、受け入れの選択肢が拒む。別のファイルは通る", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "t8b-journal-"));
    dirs.push(dir);
    const publicDir = path.join(dir, "public");
    mkdirSync(publicDir);
    const publicJournal = path.join(publicDir, "journal.ndjson");
    writeFileSync(publicJournal, "");
    symlinkSync(publicDir, path.join(dir, "alias-dir"));
    symlinkSync(publicJournal, path.join(dir, "alias-file.ndjson"));
    linkSync(publicJournal, path.join(dir, "hard.ndjson"));
    expect(sameJournal(path.join(dir, "alias-dir", "journal.ndjson"), publicJournal)).toBe(true);
    expect(sameJournal(path.join(dir, "alias-file.ndjson"), publicJournal)).toBe(true);
    expect(sameJournal(path.join(dir, "hard.ndjson"), publicJournal)).toBe(true);
    // まだ無いファイルでも、symlink のディレクトリの下なら同じ。
    expect(sameJournal(path.join(dir, "alias-dir", "new.ndjson"), path.join(publicDir, "new.ndjson"))).toBe(true);
    // 先の無い symlink（公開の journal がまだ無い）も、その先で判定する。
    symlinkSync(path.join(publicDir, "later.ndjson"), path.join(dir, "dangling.ndjson"));
    expect(sameJournal(path.join(dir, "dangling.ndjson"), path.join(publicDir, "later.ndjson"))).toBe(true);
    symlinkSync(path.join(dir, "missing-dir"), path.join(dir, "dangling-dir"));
    expect(sameJournal(path.join(dir, "dangling-dir", "journal.ndjson"), path.join(dir, "missing-dir", "journal.ndjson"))).toBe(true);
    expect(sameJournal(path.join(dir, "dangling-dir", "journal.ndjson"), publicJournal)).toBe(false);
    expect(() => acceptanceOptionsOf({ SUBETHA_JOURNAL_PATH: path.join(publicDir, "later.ndjson"), SUBETHA_ACCEPTANCE_JOURNAL_PATH: path.join(dir, "dangling.ndjson") })).toThrow(/must not be the public journal/);
    expect(sameJournal(path.join(dir, "other.ndjson"), publicJournal)).toBe(false);
    expect(sameJournal(path.join(dir, "acceptance", "journal.ndjson"), publicJournal)).toBe(false);
    for (const alias of ["alias-dir/journal.ndjson", "alias-file.ndjson", "hard.ndjson"]) {
      expect(() => acceptanceOptionsOf({ SUBETHA_JOURNAL_PATH: publicJournal, SUBETHA_ACCEPTANCE_JOURNAL_PATH: path.join(dir, alias) }), alias).toThrow(/must not be the public journal/);
    }
    expect(acceptanceOptionsOf({ SUBETHA_JOURNAL_PATH: publicJournal, SUBETHA_ACCEPTANCE_JOURNAL_PATH: path.join(dir, "acceptance", "journal.ndjson") }).journalPath).toBe(path.join(dir, "acceptance", "journal.ndjson"));
  });
});

describe("受け入れ用の起動（tools/rails-acceptance-run.ts）の選択肢", () => {
  test("既定: 両方有効、127.0.0.1、使い捨ての port、公開の journal と別のパス。公開の定数は無効のまま", () => {
    const options = acceptanceOptionsOf({});
    expect(options).toMatchObject({ activation: BOTH, bind: "127.0.0.1", port: 0 });
    expect(options.journalPath).toBe(path.resolve("runtime", "acceptance", "journal.ndjson"));
    expect(options.journalPath).not.toBe(path.resolve(publicJournalPathOf({})));
    // 公開の定数は受信（G-4）も送信（G-4′）も両方 true、EVM testnet 3 つも全部 true（hosted 設計 §8.2 の G-4、2026-10-14）（受け入れ用の起動はそれを読まず、--rails で決める。既定の無効は RAILS_NONE）。
    expect(RAILS_ACTIVATION).toEqual({ arc: { inbound: true, outbound: true }, solana: { inbound: true, outbound: true }, solanaMpp: { inbound: true, outbound: true }, pairs: { arcToSol: true, solToArc: true }, evm: { rh: { inbound: true, outbound: true }, arbsep: { inbound: true, outbound: true }, hyperevm: { inbound: true, outbound: true } } });
    expect(Object.isFrozen(RAILS_ACTIVATION)).toBe(true);
  });

  test("--rails で片方だけ。env で port と journal。公開の journal と同じパス・無効な port・レール無しは拒む", () => {
    expect(acceptanceOptionsOf({}, ["--rails", "arc-in"]).activation).toEqual({ arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } });
    expect(acceptanceOptionsOf({}, ["--rails", "solana-in"]).activation).toEqual({ arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } });
    const custom = acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_PORT: "8788", SUBETHA_ACCEPTANCE_JOURNAL_PATH: "/tmp/acc/journal.ndjson", SUBETHA_JOURNAL_PATH: "/tmp/pub/journal.ndjson" });
    expect(custom).toMatchObject({ port: 8788, journalPath: path.resolve("/tmp/acc/journal.ndjson"), bind: "127.0.0.1" });
    expect(() => acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_JOURNAL_PATH: "/tmp/pub/journal.ndjson", SUBETHA_JOURNAL_PATH: "/tmp/pub/journal.ndjson" })).toThrow(/must not be the public journal/);
    expect(() => acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_JOURNAL_PATH: path.resolve("runtime", "journal.ndjson") })).toThrow(/must not be the public journal/);
    expect(() => acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_PORT: "70000" })).toThrow(/SUBETHA_ACCEPTANCE_PORT must be an integer/);
    expect(() => acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_PORT: "abc" })).toThrow(/SUBETHA_ACCEPTANCE_PORT must be an integer/);
    expect(() => acceptanceOptionsOf({}, ["--rails", ""])).toThrow(/at least one of arc-in, arc-out, solana-in, solana-out/);
    // bind は 127.0.0.1（既定）か 0.0.0.0（コンテナの中で、ホストの loopback に port を公開するとき）だけ。
    expect(acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_BIND: "0.0.0.0" }).bind).toBe("0.0.0.0");
    expect(acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_BIND: "" }).bind).toBe("127.0.0.1");
    for (const bad of ["::", "10.0.0.5", "localhost", "router.subethalabs.com", "0.0.0.0 "]) {
      expect(() => acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_BIND: bad }), bad).toThrow(/SUBETHA_ACCEPTANCE_BIND must be 127.0.0.1/);
    }
    expect(() => acceptanceOptionsOf({}, ["--rails", "base"])).toThrow(/SUBETHA_RAILS_ACTIVATION must be a comma-separated subset/);
  });
});

describe("入口のソースは鍵・例外の文字列を出さない（静的検査）", () => {
  test.each(["tools/rails-entry.ts", "tools/rails-acceptance-run.ts", "tools/remote-router-process.ts", "tools/remote-mcp.ts"])("%s", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/error\.message/);
    expect(source).not.toMatch(/\$\{\s*error\b/);
    expect(source).not.toMatch(/String\(error\)/);
    expect(source).not.toMatch(/console\.(log|error)\(/);
  });
});

/** 送信の有効化（Arc）の入口（送信の設計 §6.1・§6.2、FR-30、D-11。タスク U5）。 */
describe("送信の有効化（Arc）: token・Provider の受取先・能力・子の env", () => {
  const OUT_ONLY = { arc: { inbound: false, outbound: true }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } };
  const ARC_PROVIDER = "0xAF42CFfe4B35A05098613d962aF43CDc43fBb4Ea";

  test("token の往復: 方向別の 4 語。旧い arc・solana は拒む", () => {
    expect(activationToEnv(OUT_ONLY)).toBe("arc-out");
    expect(activationToEnv({ arc: { inbound: true, outbound: true }, solana: { inbound: true, outbound: true }, solanaMpp: { inbound: false, outbound: false } })).toBe("arc-in,arc-out,solana-in,solana-out");
    expect(activationFromEnv("arc-out")).toEqual(OUT_ONLY);
    expect(activationFromEnv("solana-out,arc-in")).toEqual({ arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: true }, solanaMpp: { inbound: false, outbound: false } });
    for (const old of ["arc", "solana", "arc,solana"]) expect(() => activationFromEnv(old), old).toThrow(/must be a comma-separated subset/);
  });

  test("送信だけ有効: 受取鍵・受取 owner は読まれない（壊れた値があっても通る）。Provider の受取先は送信が有効で URL が空でないときだけ読む（本番の定数は配備した URL → 読む。空なら読まない）", () => {
    const ARC_UPSTREAMS = { arc: "https://provider-arc.test/v1/eth/snapshot", solana: "", solanaMpp: "" };
    const env = envWith({ [ARC_RECEIVER_KEY_ENV]: "0xbroken", [SOLANA_RECEIVER_ENV]: "", [ARC_PROVIDER_ENV]: ARC_PROVIDER });
    expect(railsReceiversOf(OUT_ONLY, env)).toEqual({});
    // 本番の定数（URL あり。G-1′）: 送信が有効なら Arc の受取先を読む。Solana は送信が無効なので読まない。
    expect(RAIL_UPSTREAMS.arc).toBe("https://provider-x402-arc.subethalabs.com/v1/eth/snapshot");
    expect(railsProvidersOf(OUT_ONLY, env)).toEqual({ arc: ARC_PROVIDER });
    expect(railsOptionsOf(OUT_ONLY, env)).toEqual({ activation: OUT_ONLY, receivers: {}, providers: { arc: ARC_PROVIDER }, upstreams: RAIL_UPSTREAMS });
    // URL が空（試験の差し替え）なら送信が有効でも読まない。
    expect(railsProvidersOf(OUT_ONLY, env, { arc: "", solana: "", solanaMpp: "" })).toEqual({});
    // URL が入れば読む。無ければ欄ごと無し（有無の判定は設定生成）。
    expect(railsProvidersOf(OUT_ONLY, env, ARC_UPSTREAMS)).toEqual({ arc: ARC_PROVIDER });
    expect(railsProvidersOf(OUT_ONLY, envWith({ [ARC_PROVIDER_ENV]: "" }), ARC_UPSTREAMS)).toEqual({});
    expect(railsOptionsOf(OUT_ONLY, env, ARC_UPSTREAMS)).toEqual({ activation: OUT_ONLY, receivers: {}, providers: { arc: ARC_PROVIDER }, upstreams: ARC_UPSTREAMS });
    // 受信だけ有効・すべて無効なら URL があっても読まない。
    expect(railsProvidersOf({ arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, env, ARC_UPSTREAMS)).toEqual({});
    expect(railsProvidersOf(NONE, env, ARC_UPSTREAMS)).toEqual({});
  });

  test("Provider の受取先の env は、送信が有効で URL が空でないときにしか**触れない**（getter で観測）", () => {
    const ARC_UPSTREAMS = { arc: "https://provider-arc.test/v1/eth/snapshot", solana: "", solanaMpp: "" };
    const reads: string[] = [];
    const observed = (): Record<string, string | undefined> => {
      const target: Record<string, string | undefined> = {};
      Object.defineProperty(target, ARC_PROVIDER_ENV, { enumerable: true, get: () => { reads.push(ARC_PROVIDER_ENV); return ARC_PROVIDER; } });
      return target;
    };
    // 送信有効・URL 空（試験の差し替え）: 読まない。
    const EMPTY = { arc: "", solana: "", solanaMpp: "" };
    railsProvidersOf(OUT_ONLY, observed(), EMPTY);
    railsOptionsOf(OUT_ONLY, observed(), EMPTY);
    // 送信無効・URL あり: 読まない。
    railsProvidersOf(NONE, observed(), ARC_UPSTREAMS);
    railsProvidersOf({ arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: true }, solanaMpp: { inbound: false, outbound: false } }, observed(), ARC_UPSTREAMS);
    expect(reads).toEqual([]);
    // 送信有効・URL あり: 読む（1 回）。
    expect(railsProvidersOf(OUT_ONLY, observed(), ARC_UPSTREAMS)).toEqual({ arc: ARC_PROVIDER });
    expect(reads).toEqual([ARC_PROVIDER_ENV]);
  });

  test("能力: arc-out で evmSigningByNetwork[Arc] が同じ鍵（同じ address）から出る。鍵が無ければ outbound_keys で止まる。売り手証明は受信だけ", () => {
    const key = generatePrivateKey();
    const env = envWith({ SUBETHA_OUTBOUND_X402_KEY: key, SUBETHA_OUTBOUND_MPP_KEY: key, [RAILS_ACTIVATION_ENV]: "arc-out" });
    const capabilities = routerProcessCapabilitiesOf(env);
    expect(capabilities.evmSigning?.network).toBe("eip155:84532");
    expect(capabilities.evmSigningByNetwork?.["eip155:5042002"]?.network).toBe("eip155:5042002");
    expect(capabilities.evmSigningByNetwork?.["eip155:5042002"]?.signer.address).toBe(capabilities.evmSigning?.signer.address);
    expect(capabilities.sellerProofs).toBeUndefined();
    expect(() => routerProcessCapabilitiesOf(envWith({ SUBETHA_OUTBOUND_MPP_KEY: key, [RAILS_ACTIVATION_ENV]: "arc-out" }))).toThrow(/SUBETHA_OUTBOUND_X402_KEY/);
    // 受信だけなら Arc の送信の能力は無い。
    const inboundOnly = routerProcessCapabilitiesOf(envWith({ SUBETHA_OUTBOUND_X402_KEY: key, [RAILS_ACTIVATION_ENV]: "arc-in" }));
    expect(inboundOnly.evmSigningByNetwork).toBeUndefined();
    expect(inboundOnly.sellerProofs).toBeDefined();
  });

  test("子の env: arc-out は有効化の token だけ（受取鍵は渡さない）。solana-out は RPC を渡す（受信と同じ）", () => {
    const env = envWith({ [SOLANA_RPC_ENV]: "https://rpc.solana.example/v1/SECRETTOKEN" });
    expect(railsChildEnvOf(OUT_ONLY, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "arc-out" });
    expect(railsChildEnvOf({ arc: { inbound: false, outbound: false }, solana: { inbound: false, outbound: true }, solanaMpp: { inbound: false, outbound: false } }, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "solana-out", [SOLANA_RPC_ENV]: env[SOLANA_RPC_ENV], ROUTER_SOLANA_RPC_URL: env[SOLANA_RPC_ENV] });
  });

  test("x402 送信の鍵の転送は「生成した設定に x402 の送信があるとき」: MPP 受信が無くても Solana 受信 → Base 送信の動的プロファイルがあれば渡る（hasX402Outbound）", () => {
    expect(hasX402Outbound({ router: { routes: { r: { rail: "mpp" } } } })).toBe(false);
    expect(hasX402Outbound({ router: { routes: { r: { rail: "mpp" } }, dynamic: { profiles: { p: { rail: "x402" } } } } })).toBe(true);
    expect(hasX402Outbound({ router: { routes: { r: {} } } })).toBe(true);
    // MPP 受信の秘密を持たない env（経路 2 無し）。
    const planEnv = { SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(), SUBETHA_ROUTER_RECEIVER: RECEIVER };
    const plan = hostPlanOf({ activation: { arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, bind: "127.0.0.1", port: 0, journalPath: "/tmp/acc/journal.ndjson" }, { ...planEnv, [SOLANA_RECEIVER_ENV]: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" });
    // dyn-sol-to-x402 が x402 送信なので鍵が渡る（以前の「MPP 受信のときだけ」では漏れていた）。
    expect(plan.childEnv["SUBETHA_OUTBOUND_X402_KEY"]).toBeDefined();
    const none = hostPlanOf({ activation: NONE, bind: "127.0.0.1", port: 0, journalPath: "/tmp/acc/journal.ndjson" }, planEnv);
    // 既存の経路 1 だけ（MPP 送信）: x402 の送信は無いので渡らない。
    expect(none.childEnv["SUBETHA_OUTBOUND_X402_KEY"]).toBeUndefined();
  });
});

/** 送信の有効化（Solana）の入口（送信の設計 §6.2、FR-30、D-11。タスク U9）。 */
describe("送信の有効化（Solana）: 鍵は solana-out のときだけ読む・svmSigning の注入・Provider の受取先・子の env", () => {
  const SOL_OUT = { arc: { inbound: false, outbound: false }, solana: { inbound: false, outbound: true }, solanaMpp: { inbound: false, outbound: false } };
  const SOL_SEED = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
  const SOL_PROVIDER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";

  test("solana-out: SUBETHA_OUTBOUND_SOLANA_KEY から svmSigning[SOL]（同じ address）が出る。無い・形が違えば solana_key で止まる（値は出ない）", () => {
    const seed = SOL_SEED();
    const key = generatePrivateKey();
    const env = envWith({ SUBETHA_OUTBOUND_X402_KEY: key, [RAILS_ACTIVATION_ENV]: "solana-out", [SOLANA_OUTBOUND_KEY_ENV]: seed });
    const capabilities = routerProcessCapabilitiesOf(env);
    expect(capabilities.svmSigning?.[OUTBOUND_SOL.network]).toMatchObject({ network: OUTBOUND_SOL.network, kind: "real-key", address: createRealSvmCapability(seed).address });
    expect(capabilities.dependencyUrls).toContain(DEFAULT_SOLANA_RPC_URL);
    expect(capabilities.evmSigningByNetwork).toBeUndefined();
    for (const bad of [undefined, "", "not-a-key", "0xabc"]) {
      let caught: unknown;
      try {
        routerProcessCapabilitiesOf(envWith({ SUBETHA_OUTBOUND_X402_KEY: key, [RAILS_ACTIVATION_ENV]: "solana-out", ...(bad === undefined ? {} : { [SOLANA_OUTBOUND_KEY_ENV]: bad }) }));
      } catch (error) {
        caught = error;
      }
      expect(caught, String(bad)).toBeInstanceOf(ProcessEntryError);
      expect((caught as ProcessEntryError).code).toBe("solana_key");
      expect((caught as Error).message).not.toContain("not-a-key");
    }
  });

  test("solana-out でなければ鍵の env は読まれない（壊れた値があっても通る。getter で観測）", () => {
    const key = generatePrivateKey();
    for (const activation of ["", "solana-in", "arc-in,arc-out"]) {
      const reads: string[] = [];
      const env: Record<string, string | undefined> = envWith({ SUBETHA_OUTBOUND_X402_KEY: key, [RAILS_ACTIVATION_ENV]: activation });
      Object.defineProperty(env, SOLANA_OUTBOUND_KEY_ENV, { enumerable: true, get: () => { reads.push(SOLANA_OUTBOUND_KEY_ENV); return "broken"; } });
      const capabilities = routerProcessCapabilitiesOf(env);
      expect(capabilities.svmSigning, activation).toBeUndefined();
      expect(reads, activation).toEqual([]);
      expect(railsChildEnvOf(activationFromEnv(activation), env)[SOLANA_OUTBOUND_KEY_ENV]).toBeUndefined();
      expect(reads, activation).toEqual([]);
    }
  });

  test("子の env: solana-out は鍵と（設定があれば）RPC を渡す。受取 owner は渡さない", () => {
    const seed = SOL_SEED();
    const env = envWith({ [SOLANA_OUTBOUND_KEY_ENV]: seed, [SOLANA_RPC_ENV]: "https://rpc.solana.example/v1/SECRETTOKEN", [SOLANA_RECEIVER_ENV]: "broken-owner" });
    expect(railsChildEnvOf(SOL_OUT, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "solana-out", [SOLANA_OUTBOUND_KEY_ENV]: seed, [SOLANA_RPC_ENV]: "https://rpc.solana.example/v1/SECRETTOKEN", ROUTER_SOLANA_RPC_URL: "https://rpc.solana.example/v1/SECRETTOKEN" });
    expect(railsReceiversOf(SOL_OUT, env)).toEqual({});
  });

  test("Provider の受取先 SUBETHA_SOLANA_PROVIDER_PAYTO は solana-out かつ URL が空でないときだけ読む（getter で観測。本番の定数は配備した URL → solana-out なら読む）", () => {
    const reads: string[] = [];
    const observed = (): Record<string, string | undefined> => {
      const target: Record<string, string | undefined> = {};
      Object.defineProperty(target, SOLANA_PROVIDER_ENV, { enumerable: true, get: () => { reads.push(SOLANA_PROVIDER_ENV); return SOL_PROVIDER; } });
      return target;
    };
    expect(RAIL_UPSTREAMS.solana).toBe("https://provider-x402-sol.subethalabs.com/v1/eth/snapshot");
    // solana-out が無効なら、URL があっても読まない。
    expect(railsProvidersOf({ arc: { inbound: false, outbound: true }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, observed(), { arc: "", solana: "https://provider-sol.test/v1", solanaMpp: "" })).toEqual({});
    // URL が空（試験の差し替え）なら solana-out でも読まない。
    expect(railsProvidersOf(SOL_OUT, observed(), { arc: "", solana: "", solanaMpp: "" })).toEqual({});
    expect(reads).toEqual([]);
    // 本番の定数 + solana-out → 読む。
    expect(railsProvidersOf(SOL_OUT, observed())).toEqual({ solana: SOL_PROVIDER });
    expect(reads).toEqual([SOLANA_PROVIDER_ENV]);
    expect(railsProvidersOf(SOL_OUT, observed(), { arc: "", solana: "https://provider-sol.test/v1", solanaMpp: "" })).toEqual({ solana: SOL_PROVIDER });
    expect(reads).toEqual([SOLANA_PROVIDER_ENV, SOLANA_PROVIDER_ENV]);
  });
});

/** Solana の MPP の有効化の入口（`docs/mpp-solana-design.md` §6.1・§6.2、FR-40・FR-42。タスク M6）: token・受取 owner・鍵・RPC・秘密・Provider D の受取 owner の条件。 */
describe("Solana の MPP の有効化（solanaMpp）: token・受取 owner・鍵・子の env・ホストの計画", () => {
  const OFF = { inbound: false, outbound: false };
  const MPP_IN: RailsActivation = { arc: OFF, solana: OFF, solanaMpp: { inbound: true, outbound: false } };
  const MPP_OUT: RailsActivation = { arc: OFF, solana: OFF, solanaMpp: { inbound: false, outbound: true } };
  const X402_OUT: RailsActivation = { arc: OFF, solana: { inbound: false, outbound: true }, solanaMpp: OFF };
  const SOL_SEED = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
  const SOL_MPP_PROVIDER = "4LrBc1whdzuLzk7qgo6y5JEgHtyhgNoPpzPpHebaJ5oM";
  const SOL_MPP_URL = "https://provider-solmpp.test/v1/eth/snapshot";

  test("token の往復: solana-mpp-in・solana-mpp-out。6 語の全部、順序は arc → solana → solana-mpp。旧い語・重複は拒む（文言に 6 語）", () => {
    expect(activationToEnv(MPP_IN)).toBe("solana-mpp-in");
    expect(activationToEnv(MPP_OUT)).toBe("solana-mpp-out");
    const all: RailsActivation = { arc: { inbound: true, outbound: true }, solana: { inbound: true, outbound: true }, solanaMpp: { inbound: true, outbound: true } };
    expect(activationToEnv(all)).toBe("arc-in,arc-out,solana-in,solana-out,solana-mpp-in,solana-mpp-out");
    expect(activationFromEnv("arc-in,arc-out,solana-in,solana-out,solana-mpp-in,solana-mpp-out")).toEqual(all);
    expect(activationFromEnv("solana-mpp-in")).toEqual(MPP_IN);
    expect(activationFromEnv(" solana-mpp-out , arc-in ")).toEqual({ arc: { inbound: true, outbound: false }, solana: OFF, solanaMpp: { inbound: false, outbound: true } });
    // 公開の定数（G-4″ で solanaMpp も有効、G-4⁗ で組も有効）は 8 語、EVM testnet の G-4（2026-10-14）の後は 6 語が後ろに付いて 14 語。
    expect(activationToEnv(RAILS_ACTIVATION)).toBe(PUBLIC_TOKENS);
    expect(activationFromEnv("")).toEqual(RAILS_NONE);
    for (const bad of ["solana-mpp", "solanampp-in", "solana-mpp-in,solana-mpp-in", "mpp-in"]) {
      expect(() => activationFromEnv(bad), bad).toThrow(/must be a comma-separated subset of "arc-in,arc-out,solana-in,solana-out,solana-mpp-in,solana-mpp-out,arc-to-sol,sol-to-arc,rh-in,rh-out,arbsep-in,arbsep-out,hyperevm-in,hyperevm-out"/);
    }
  });

  test("受取 owner: solana-mpp-in は x402 の受信と同じ env（SUBETHA_SOLANA_RECEIVER）を読む（無ければ起動しない）。設定生成では MPP の route だけが出て x402 の route は出ない。solana-mpp-out だけなら読まない", () => {
    const env = envWith();
    expect(railsReceiversOf(MPP_IN, env)).toEqual({ solana: SOL_OWNER });
    expect(() => railsReceiversOf(MPP_IN, { [SOLANA_RECEIVER_ENV]: "" })).toThrow(/SUBETHA_SOLANA_RECEIVER is required/);
    expect(() => railsReceiversOf(MPP_IN, {})).toThrow(/SUBETHA_SOLANA_RECEIVER is required/);
    const config = loadAsProduction(routerConfigOf({}, RECEIVER, true, railsOptionsOf(MPP_IN, env)));
    expect(config.router.routes["md-x402-eth-snapshot-solmpp"]?.source.payTo).toBe(SOL_OWNER);
    expect(config.router.routes["md-mpp-eth-snapshot-solmpp"]?.source.payTo).toBe(SOL_OWNER);
    expect(config.router.routes[ROUTE_SOL]).toBeUndefined();
    expect(config.router.dynamic?.profiles["dyn-solmpp-to-x402"]?.source.payTo).toBe(SOL_OWNER);
    expect(config.router.dynamic?.profiles["dyn-sol-to-x402"]).toBeUndefined();
    // 送信だけ有効: 受取 owner は参照もされない。
    const reads: string[] = [];
    const observed: Record<string, string | undefined> = {};
    Object.defineProperty(observed, SOLANA_RECEIVER_ENV, { enumerable: true, get: () => { reads.push(SOLANA_RECEIVER_ENV); return "broken"; } });
    expect(railsReceiversOf(MPP_OUT, observed)).toEqual({});
    expect(reads).toEqual([]);
  });

  test("Provider D の受取 owner SUBETHA_SOLANA_MPP_PROVIDER_PAYTO は solana-mpp-out かつ URL が空でないときだけ読む（本番の定数は空 → 読まない。getter で観測）。x402 の Provider の欄とは別", () => {
    const reads: string[] = [];
    const observed = (): Record<string, string | undefined> => {
      const target: Record<string, string | undefined> = {};
      Object.defineProperty(target, SOLANA_MPP_PROVIDER_ENV, { enumerable: true, get: () => { reads.push(SOLANA_MPP_PROVIDER_ENV); return SOL_MPP_PROVIDER; } });
      Object.defineProperty(target, SOLANA_PROVIDER_ENV, { enumerable: true, get: () => { reads.push(SOLANA_PROVIDER_ENV); return "x402-provider"; } });
      return target;
    };
    expect(RAIL_UPSTREAMS.solanaMpp).toBe("https://provider-mpp-sol.subethalabs.com/v1/eth/snapshot");
    // 本番の定数（G-1″ で URL が入った）: solana-mpp-out なら読む（1 回）。x402 の Provider の欄は読まない（solana-out ではない）。
    expect(railsProvidersOf(MPP_OUT, observed())).toEqual({ solanaMpp: SOL_MPP_PROVIDER });
    expect(reads).toEqual([SOLANA_MPP_PROVIDER_ENV]);
    reads.length = 0;
    // URL が空（試験の差し替え）なら solana-mpp-out でも読まない。
    expect(railsProvidersOf(MPP_OUT, observed(), { arc: "", solana: "", solanaMpp: "" })).toEqual({});
    // URL があっても送信が無効なら読まない。
    expect(railsProvidersOf(MPP_IN, observed(), { arc: "", solana: "", solanaMpp: SOL_MPP_URL })).toEqual({});
    expect(railsProvidersOf(X402_OUT, observed(), { arc: "", solana: "", solanaMpp: SOL_MPP_URL })).toEqual({});
    expect(reads).toEqual([]);
    // solana-mpp-out ∧ URL → 読む（1 回。x402 の欄は読まない）。
    expect(railsProvidersOf(MPP_OUT, observed(), { arc: "", solana: "", solanaMpp: SOL_MPP_URL })).toEqual({ solanaMpp: SOL_MPP_PROVIDER });
    expect(reads).toEqual([SOLANA_MPP_PROVIDER_ENV]);
    expect(railsOptionsOf(MPP_OUT, observed(), { arc: "", solana: "", solanaMpp: SOL_MPP_URL })).toEqual({ activation: MPP_OUT, receivers: {}, providers: { solanaMpp: SOL_MPP_PROVIDER }, upstreams: { arc: "", solana: "", solanaMpp: SOL_MPP_URL } });
    // 空なら欄ごと無し。
    expect(railsProvidersOf(MPP_OUT, { [SOLANA_MPP_PROVIDER_ENV]: "" }, { arc: "", solana: "", solanaMpp: SOL_MPP_URL })).toEqual({});
  });

  test("能力: 鍵の転送と svmSigning[SOL] は solana.outbound ∨ solanaMpp.outbound（どちらも無効なら読まない、片方だけなら読む、両方でも 1 つ）。RPC は Solana のどの方向でも依存先に", () => {
    const key = generatePrivateKey();
    const seed = SOL_SEED();
    const expectedAddress = createRealSvmCapability(seed).address;
    for (const activation of ["solana-mpp-out", "solana-out", "solana-out,solana-mpp-out", "solana-mpp-in,solana-mpp-out"]) {
      const capabilities = routerProcessCapabilitiesOf(envWith({ SUBETHA_OUTBOUND_X402_KEY: key, [RAILS_ACTIVATION_ENV]: activation, [SOLANA_OUTBOUND_KEY_ENV]: seed }));
      expect(Object.keys(capabilities.svmSigning ?? {}), activation).toEqual([OUTBOUND_SOL.network]);
      expect(capabilities.svmSigning?.[OUTBOUND_SOL.network]?.address, activation).toBe(expectedAddress);
      expect(capabilities.dependencyUrls, activation).toContain(DEFAULT_SOLANA_RPC_URL);
      // 鍵が無ければ solana_key で止まる（値は出ない）。
      let caught: unknown;
      try {
        routerProcessCapabilitiesOf(envWith({ SUBETHA_OUTBOUND_X402_KEY: key, [RAILS_ACTIVATION_ENV]: activation }));
      } catch (error) {
        caught = error;
      }
      expect((caught as ProcessEntryError).code, activation).toBe("solana_key");
    }
    // 受信だけ（MPP）: 鍵は参照もされない。RPC は依存先に入る。
    for (const activation of ["solana-mpp-in", "solana-in,solana-mpp-in", ""]) {
      const reads: string[] = [];
      const env: Record<string, string | undefined> = envWith({ SUBETHA_OUTBOUND_X402_KEY: key, [RAILS_ACTIVATION_ENV]: activation });
      Object.defineProperty(env, SOLANA_OUTBOUND_KEY_ENV, { enumerable: true, get: () => { reads.push(SOLANA_OUTBOUND_KEY_ENV); return "broken"; } });
      const capabilities = routerProcessCapabilitiesOf(env);
      expect(capabilities.svmSigning, activation).toBeUndefined();
      expect(reads, activation).toEqual([]);
      if (activation === "") expect(capabilities.dependencyUrls).not.toContain(DEFAULT_SOLANA_RPC_URL);
      else expect(capabilities.dependencyUrls, activation).toContain(DEFAULT_SOLANA_RPC_URL);
    }
    expect(railsCapabilitiesOf(MPP_IN, envWith({ [SOLANA_RPC_ENV]: "https://rpc.solana.example/v1/SECRETTOKEN" }))).toEqual({ dependencyUrls: ["https://rpc.solana.example/v1/SECRETTOKEN"] });
  });

  test("子の env: solana-mpp-in は有効化の token と RPC だけ（受取 owner も鍵も渡さない）。solana-mpp-out は鍵と RPC。鍵は solana-out でも solana-mpp-out でも無ければ参照しない", () => {
    const seed = SOL_SEED();
    const env = envWith({ [SOLANA_OUTBOUND_KEY_ENV]: seed, [SOLANA_RPC_ENV]: "https://rpc.solana.example/v1/SECRETTOKEN" });
    expect(railsChildEnvOf(MPP_IN, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "solana-mpp-in", [SOLANA_RPC_ENV]: env[SOLANA_RPC_ENV], ROUTER_SOLANA_RPC_URL: env[SOLANA_RPC_ENV] });
    expect(railsChildEnvOf(MPP_OUT, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "solana-mpp-out", [SOLANA_OUTBOUND_KEY_ENV]: seed, [SOLANA_RPC_ENV]: env[SOLANA_RPC_ENV], ROUTER_SOLANA_RPC_URL: env[SOLANA_RPC_ENV] });
    expect(railsChildEnvOf({ arc: OFF, solana: { inbound: false, outbound: true }, solanaMpp: { inbound: false, outbound: true } }, env)).toEqual({ [RAILS_ACTIVATION_ENV]: "solana-out,solana-mpp-out", [SOLANA_OUTBOUND_KEY_ENV]: seed, [SOLANA_RPC_ENV]: env[SOLANA_RPC_ENV], ROUTER_SOLANA_RPC_URL: env[SOLANA_RPC_ENV] });
    expect(railsChildEnvOf(MPP_IN, envWith())).toEqual({ [RAILS_ACTIVATION_ENV]: "solana-mpp-in" });
    const reads: string[] = [];
    const observed: Record<string, string | undefined> = envWith();
    Object.defineProperty(observed, SOLANA_OUTBOUND_KEY_ENV, { enumerable: true, get: () => { reads.push(SOLANA_OUTBOUND_KEY_ENV); return "broken"; } });
    railsChildEnvOf(MPP_IN, observed);
    railsChildEnvOf({ arc: OFF, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: true, outbound: false } }, observed);
    expect(reads).toEqual([]);
  });

  test("ホストの計画: solanaMpp.inbound は MPP 受信の秘密を要求し（無ければ env の固定文で止まる）、子に ROUTER_MPP_INBOUND_SECRET を渡す。solanaMpp.outbound は Solana の鍵を渡し、x402 の鍵（静的の Base 受信 route）も渡る", () => {
    const baseEnv = { SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(), SUBETHA_ROUTER_RECEIVER: RECEIVER, [SOLANA_RECEIVER_ENV]: SOL_OWNER };
    const secret = "0123456789abcdef0123456789abcdef-solmpp";
    const options: HostOptions = { activation: MPP_IN, bind: "127.0.0.1", port: 0, journalPath: "/tmp/acc/journal.ndjson" };
    // 秘密が無い → 計画を作らない（code env）。
    let caught: unknown;
    try {
      hostPlanOf(options, baseEnv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostPlanError);
    expect((caught as HostPlanError).code).toBe("env");
    // 秘密があれば、子に秘密と有効化が渡り、設定に MPP Solana の受信の route が出る。
    const plan = hostPlanOf(options, { ...baseEnv, SUBETHA_MPP_INBOUND_SECRET: secret });
    expect(plan.childEnv).toMatchObject({ ROUTER_MPP_INBOUND_SECRET: secret, ROUTER_MPP_INBOUND_OFFER_SECONDS: "600", [RAILS_ACTIVATION_ENV]: "solana-mpp-in" });
    expect(plan.childEnv[SOLANA_OUTBOUND_KEY_ENV]).toBeUndefined();
    const config = loadAsProduction(plan.config);
    expect(Object.keys(config.router.routes).sort()).toEqual(["md-mpp-eth-snapshot", "md-mpp-eth-snapshot-solmpp", "md-x402-eth-snapshot", "md-x402-eth-snapshot-solmpp"]);
    expect(Object.keys(config.router.dynamic!.profiles).sort()).toEqual(["dyn-mpp-to-x402", "dyn-solmpp-to-mpp", "dyn-solmpp-to-x402", "dyn-x402-to-mpp"]);
    // 送信（G-1″ で Provider D の URL が定数に入った → 受取 owner を読み、静的 route 2 本が出る）: Solana の鍵が渡る。受取 owner が壊れていれば config の固定文で止まる。
    const seed = SOL_SEED();
    const outPlan = hostPlanOf({ ...options, activation: MPP_OUT }, { ...baseEnv, SUBETHA_MPP_INBOUND_SECRET: secret, [SOLANA_OUTBOUND_KEY_ENV]: seed, [SOLANA_MPP_PROVIDER_ENV]: SOL_MPP_PROVIDER });
    expect(outPlan.childEnv).toMatchObject({ [RAILS_ACTIVATION_ENV]: "solana-mpp-out", [SOLANA_OUTBOUND_KEY_ENV]: seed, SUBETHA_OUTBOUND_X402_KEY: baseEnv.SUBETHA_OUTBOUND_PRIVATE_KEY });
    const outConfig = loadAsProduction(outPlan.config);
    expect(Object.keys(outConfig.router.dynamic!.profiles).sort()).toEqual(["dyn-mpp-to-solmpp", "dyn-mpp-to-x402", "dyn-x402-to-mpp", "dyn-x402-to-solmpp"]);
    expect(Object.keys(outConfig.router.routes).sort()).toEqual(["md-mpp-eth-snapshot", "md-solmpp-eth-snapshot", "md-solmpp-eth-snapshot-mpp", "md-x402-eth-snapshot"]);
    expect(outConfig.router.routes["md-solmpp-eth-snapshot"]?.destination.payTo).toBe(SOL_MPP_PROVIDER);
    expect(outConfig.real?.upstreams["md-solmpp-eth-snapshot"]).toBe("https://provider-mpp-sol.subethalabs.com/v1/eth/snapshot");
    let brokenCaught: unknown;
    try { hostPlanOf({ ...options, activation: MPP_OUT }, { ...baseEnv, SUBETHA_MPP_INBOUND_SECRET: secret, [SOLANA_OUTBOUND_KEY_ENV]: seed, [SOLANA_MPP_PROVIDER_ENV]: "broken" }); } catch (error) { brokenCaught = error; }
    expect((brokenCaught as HostPlanError).code).toBe("config");
    // 受け入れ用の起動は同じ語で選べる。
    expect(acceptanceOptionsOf({}, ["--rails", "solana-mpp-in"]).activation).toEqual(MPP_IN);
    expect(acceptanceOptionsOf({}, ["--rails", "arc-in,solana-in,solana-mpp-in,solana-mpp-out"]).activation).toEqual({ arc: { inbound: true, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: true, outbound: true } });
    expect(() => acceptanceOptionsOf({}, ["--rails", ""])).toThrow(/solana-mpp-in, solana-mpp-out/);
  });
});

/** O-5・O-6 の組の token と入口（送信の設計 §13.1、要件 FR-40・FR-41・FR-43、AC-19）。 */
describe("組の token arc-to-sol・sol-to-arc（設計 §13.1）", () => {
  const base: RailsActivation = { arc: { inbound: true, outbound: true }, solana: { inbound: true, outbound: true }, solanaMpp: { inbound: false, outbound: false } };
  const baseEnv = { SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(), SUBETHA_ROUTER_RECEIVER: RECEIVER, SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-pairs" };

  test("往復: 組の語は末尾、片方・両方はその語だけ、両方 false は語が無い（= 欄も無い）。重複・似た語は拒否。組だけでは railActive は false", () => {
    expect(activationToEnv({ ...base, pairs: { arcToSol: true, solToArc: false } })).toBe("arc-in,arc-out,solana-in,solana-out,arc-to-sol");
    expect(activationToEnv({ ...base, pairs: { arcToSol: false, solToArc: true } })).toBe("arc-in,arc-out,solana-in,solana-out,sol-to-arc");
    expect(activationToEnv({ ...base, pairs: { arcToSol: true, solToArc: true } })).toBe("arc-in,arc-out,solana-in,solana-out,arc-to-sol,sol-to-arc");
    expect(activationToEnv({ ...base, pairs: { arcToSol: false, solToArc: false } })).toBe("arc-in,arc-out,solana-in,solana-out");
    expect(activationToEnv(RAILS_ACTIVATION)).toBe(PUBLIC_TOKENS);
    for (const pairs of [{ arcToSol: true, solToArc: false }, { arcToSol: false, solToArc: true }, { arcToSol: true, solToArc: true }]) {
      expect(activationFromEnv(activationToEnv({ ...base, pairs }))).toEqual({ ...base, pairs });
    }
    expect(activationFromEnv("arc-in,arc-out,solana-in,solana-out")).toEqual(base);
    expect(activationFromEnv("sol-to-arc, arc-in")).toEqual({ arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false }, pairs: { arcToSol: false, solToArc: true } });
    for (const bad of ["arc-to-sol,arc-to-sol", "sol-to-arc,sol-to-arc", "arc-in,sol-to-arc,sol-to-arc", "arc-sol", "arc_to_sol", "ARC-TO-SOL", "sol-to-arc,"]) {
      expect(() => activationFromEnv(bad), bad).toThrow(/SUBETHA_RAILS_ACTIVATION must be a comma-separated subset/);
    }
    expect(railActive({ ...NONE, pairs: { arcToSol: true, solToArc: true } })).toBe(false);
  });

  test("hostPlanOf: 全レール true + pairs 両方 true → 20 本と子の env の 8 語（能力・鍵の転送は変わらない）。片方だけ → 19 本。pairs だけ true（レールの方向無し）→ 固定文（config）で計画は作れない。G-4（2026-10-14）の後の公開の定数は EVM testnet 3 つの 36 本と 6 語が足される（56・54・55 本、14 語）", () => {
    const key = generatePrivateKey();
    const seed = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
    const fullEnv = { ...baseEnv, [ARC_RECEIVER_KEY_ENV]: key, [SOLANA_RECEIVER_ENV]: SOL_OWNER, [ARC_PROVIDER_ENV]: "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1", [SOLANA_PROVIDER_ENV]: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d", [SOLANA_MPP_PROVIDER_ENV]: "26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc", [SOLANA_OUTBOUND_KEY_ENV]: seed, ...EVM_FACILITATOR_ENV };
    const both: RailsActivation = { ...RAILS_ACTIVATION, pairs: { arcToSol: true, solToArc: true } };
    const plan = hostPlanOf({ activation: both, bind: "0.0.0.0", port: 8787, journalPath: publicJournalPathOf({}) }, fullEnv);
    const config = loadAsProduction(plan.config);
    // G-4 の後: 20 本 + EVM testnet 3 つの 36 本。
    expect(Object.keys(config.router.dynamic!.profiles)).toHaveLength(56);
    expect(Object.keys(config.router.dynamic!.profiles).filter((id) => !isEvmProfile(id))).toHaveLength(20);
    expect(config.router.dynamic!.profiles["dyn-arc-to-sol"]?.source.payTo).toBe(privateKeyToAccount(key).address);
    expect(config.router.dynamic!.profiles["dyn-sol-to-arc"]?.source.payTo).toBe(SOL_OWNER);
    expect(plan.childEnv[RAILS_ACTIVATION_ENV]).toBe(PUBLIC_TOKENS);
    // 子の env は pairs 無しの計画と、有効化の語以外は同じ（FR-43: 鍵・能力は組を見ない）。
    const plain = hostPlanOf({ activation: { ...RAILS_ACTIVATION, pairs: { arcToSol: false, solToArc: false } }, bind: "0.0.0.0", port: 8787, journalPath: publicJournalPathOf({}) }, fullEnv);
    const { [RAILS_ACTIVATION_ENV]: _a, ...withPairs } = plan.childEnv;
    const { [RAILS_ACTIVATION_ENV]: _b, ...without } = plain.childEnv;
    expect(withPairs).toEqual(without);
    expect(Object.keys(loadAsProduction(plain.config).router.dynamic!.profiles)).toHaveLength(18 + 36);
    for (const [pairs, present] of [[{ arcToSol: true, solToArc: false }, "dyn-arc-to-sol"], [{ arcToSol: false, solToArc: true }, "dyn-sol-to-arc"]] as const) {
      const one = hostPlanOf({ activation: { ...RAILS_ACTIVATION, pairs }, bind: "0.0.0.0", port: 8787, journalPath: publicJournalPathOf({}) }, fullEnv);
      const ids = Object.keys(loadAsProduction(one.config).router.dynamic!.profiles);
      expect(ids).toHaveLength(19 + 36);
      expect(ids).toContain(present);
    }
    // 組だけ true: 受取先も送信の方向も無いので固定文で止まる（code は config。値は出ない）。
    let caught: unknown;
    try {
      hostPlanOf({ activation: { ...NONE, pairs: { arcToSol: true, solToArc: true } }, bind: "0.0.0.0", port: 8787, journalPath: publicJournalPathOf({}) }, fullEnv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostPlanError);
    expect((caught as HostPlanError).code).toBe("config");
    expect(String((caught as Error).message)).not.toContain(key.slice(2));
    // 子（process）側の復元も同じ語を受け付け、能力は組を見ない: pairs の有無で routerProcessCapabilitiesOf の形は変わらない。
    const childEnvWithPairs = { ...plan.childEnv, [RAILS_ACTIVATION_ENV]: "arc-in,arc-out,solana-in,solana-out,arc-to-sol,sol-to-arc" };
    const childEnvPlain = { ...plan.childEnv, [RAILS_ACTIVATION_ENV]: "arc-in,arc-out,solana-in,solana-out" };
    expect(Object.keys(routerProcessCapabilitiesOf(childEnvWithPairs)).sort()).toEqual(Object.keys(routerProcessCapabilitiesOf(childEnvPlain)).sort());
  });
});
