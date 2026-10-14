/**
 * EVM testnet 3 つを hosted に出す設定生成と公開の子の能力（`docs/evm-testnets-hosted-design.md` §3 の最後・§5、FR-H3〜FR-H6、SR-H2、AC-H1・AC-H2、タスク H-3）。
 * - 有効化 `RAILS_ACTIVATION.evm` が無い・全部 false: 公開の設定・子の env・一覧は今と byte 一致（golden）
 * - 全部 true: golden との差分は追加だけ（既存の値は 1 つも変わらない）。足されるのは 36 本のプロファイル・3 つの区分・3 つの受信の facilitator
 * - 1 件の上限の境界は本物の予約の計算（`src/core/dynamic.ts`）で。公開の子の能力（`localCounterparties`・`evmSigningByNetwork`）、配線（composeRails）
 * 鍵は固定の合成値か乱数。外へは接続しない（loopback の相手は試験の中の HTTP の server）。
 */
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { getBase58Decoder } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { evmTestnetDeadlinesOf, KNOWN_NETWORKS, knownNetworkOf, loadRuntimeConfig, type RouterConfig, type RuntimeConfig } from "../../src/config.js";
import { perPurchaseLimitOf, priceOf, reservationOf } from "../../src/core/dynamic.js";
import { routeListBody } from "../../src/http/projection.js";
import { composeRails } from "../../src/main.js";
import type { TransportEvent } from "../../src/net/guarded-fetch.js";
import { activationFromEnv, activationToEnv, evmFacilitatorOriginOf, ProcessEntryError, RAILS_ACTIVATION_ENV, routerProcessCapabilitiesOf } from "../../tools/rails-entry.js";
import {
  EVM_NONE,
  EVM_TESTNETS,
  evmOf,
  HOSTED_EVM_CHAINS,
  INBOUND,
  INBOUND_ARC,
  INBOUND_MPP,
  INBOUND_SOL,
  OUTBOUND_SOL,
  RAILS_ACTIVATION,
  RAILS_NONE,
  routerConfigOf,
  type EvmRailsActivation,
  type RailsActivation,
} from "../../tools/remote-mcp-config.js";
import { HostPlanError, hostPlanOf } from "../../tools/remote-mcp.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const ARC_KEY = ("0x" + "22".repeat(32)) as `0x${string}`;
const ARC_RECEIVER = privateKeyToAccount(ARC_KEY).address;
const SOL_OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const TOKEN = "hosted-h3-test-token_0123456789abcdefABCDEF";
const FACILITATOR_URL = `http://127.0.0.1:8611/${TOKEN}`;
/** golden と同じ env（`tests/unit/config-golden.test.ts`）。 */
const goldenEnv = { SUBETHA_OUTBOUND_PRIVATE_KEY: "0x" + "11".repeat(32), SUBETHA_ROUTER_RECEIVER: RECEIVER, SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-golden", SUBETHA_TEMPO_RPC_URL: "https://tempo.example/v1/TOKEN", SUBETHA_ARC_RECEIVER_KEY: ARC_KEY, SUBETHA_SOLANA_RECEIVER: SOL_OWNER, SUBETHA_OUTBOUND_SOLANA_KEY: "2Lo8Y9kVf2iN4z3e5ZQ9k3nQJc7wq6yQx8k2mF9sP4tHc5uW1bX7aN3dR6gT9jK2", SUBETHA_ARC_PROVIDER_PAYTO: "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1", SUBETHA_SOLANA_PROVIDER_PAYTO: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d", SUBETHA_SOLANA_MPP_PROVIDER_PAYTO: "26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc" };
const golden = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/config-golden", `${name}.json`), "utf8"));
const planOf = (activation: RailsActivation, env: Record<string, string | undefined> = goldenEnv, facilitatorPort?: number) => hostPlanOf({ activation, bind: "127.0.0.1", port: 0, journalPath: "/tmp/golden.ndjson", ...(facilitatorPort === undefined ? {} : { evmFacilitatorPortForTest: facilitatorPort }) }, env);

const ON = { inbound: true, outbound: true } as const;
const OFF = { inbound: false, outbound: false } as const;
const EVM_ALL: EvmRailsActivation = { rh: ON, arbsep: ON, hyperevm: ON };
const withEvm = (activation: RailsActivation, evm: EvmRailsActivation): RailsActivation => ({ ...activation, evm });
const PUBLIC_ALL = withEvm(RAILS_ACTIVATION, EVM_ALL);
/**
 * 有効時の env: H-4 から、入口は facilitator の子を計画し、URL（`http://127.0.0.1:8611/<token>`）を token と port から作る（親の env の URL は使わない）。
 * gas 鍵・token・各 chain の gas の上限・Provider の受取先が要る（`tests/unit/evm-hosted-entry.test.ts`）。
 */
const FAC_KEY = "0x" + "44".repeat(32);
const evmEnv = { ...goldenEnv, SUBETHA_EVM_FACILITATOR_KEY: FAC_KEY, SUBETHA_EVM_FACILITATOR_TOKEN: TOKEN, SUBETHA_EVM_FACILITATOR_GAS_CAP_46630: "1000000000000000", SUBETHA_EVM_FACILITATOR_GAS_CAP_421614: "1000000000000000", SUBETHA_EVM_FACILITATOR_GAS_CAP_998: "1000000000000000", SUBETHA_EVM_PROVIDER_PAYTO: "0xf8243d93F339807CA9846Aa31155A2B2262D08db" };

const NET = { rh: EVM_TESTNETS.rh.network, arbsep: EVM_TESTNETS.arbsep.network, hyperevm: EVM_TESTNETS.hyperevm.network } as const;
const BASE = INBOUND.network;
const TEMPO = INBOUND_MPP.network;

/** 期待する 36 の id（実装の組み立てを写さず、文字で書く: 新 3 → 既存 5 の 15、既存 5 → 新 3 の 15、新 × 新（同じ chain を除く）の 6）。 */
const EXPECTED_36 = [
  "dyn-rh-to-x402", "dyn-rh-to-mpp", "dyn-rh-to-arc", "dyn-rh-to-sol", "dyn-rh-to-solmpp",
  "dyn-arbsep-to-x402", "dyn-arbsep-to-mpp", "dyn-arbsep-to-arc", "dyn-arbsep-to-sol", "dyn-arbsep-to-solmpp",
  "dyn-hyperevm-to-x402", "dyn-hyperevm-to-mpp", "dyn-hyperevm-to-arc", "dyn-hyperevm-to-sol", "dyn-hyperevm-to-solmpp",
  "dyn-x402-to-rh", "dyn-mpp-to-rh", "dyn-arc-to-rh", "dyn-sol-to-rh", "dyn-solmpp-to-rh",
  "dyn-x402-to-arbsep", "dyn-mpp-to-arbsep", "dyn-arc-to-arbsep", "dyn-sol-to-arbsep", "dyn-solmpp-to-arbsep",
  "dyn-x402-to-hyperevm", "dyn-mpp-to-hyperevm", "dyn-arc-to-hyperevm", "dyn-sol-to-hyperevm", "dyn-solmpp-to-hyperevm",
  "dyn-rh-to-arbsep", "dyn-rh-to-hyperevm", "dyn-arbsep-to-rh", "dyn-arbsep-to-hyperevm", "dyn-hyperevm-to-rh", "dyn-hyperevm-to-arbsep",
].sort();

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 計画の設定を、子と同じ env（real モード = `KNOWN_NETWORKS`）で読む。 */
function loadPlan(plan: { config: Record<string, unknown>; childEnv: Record<string, string> }): RuntimeConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "evm-hosted-"));
  dirs.push(dir);
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(plan.config, null, 2));
  return loadRuntimeConfig({ ...plan.childEnv, ROUTER_CONFIG_PATH: configPath, ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson") }, (file) => readFileSync(file, "utf8"));
}

/**
 * 差分が追加だけか（構造で見る）: `before` のどの鍵も `after` にあり、値（葉）は同じ。配列は `before` が `after` の先頭と同じ（後ろへの追加だけ）。
 * 追加された場所（パス）を返す。
 */
function additionsOf(before: unknown, after: unknown, at = "$"): string[] {
  if (Array.isArray(before)) {
    expect(Array.isArray(after), at).toBe(true);
    const list = after as unknown[];
    expect(list.length, at).toBeGreaterThanOrEqual(before.length);
    const added: string[] = [];
    before.forEach((item, index) => added.push(...additionsOf(item, list[index], `${at}[${index}]`)));
    for (let index = before.length; index < list.length; index += 1) added.push(`${at}[${index}]`);
    return added;
  }
  if (before !== null && typeof before === "object") {
    expect(after !== null && typeof after === "object" && !Array.isArray(after), at).toBe(true);
    const target = after as Record<string, unknown>;
    const added: string[] = [];
    for (const [key, value] of Object.entries(before)) {
      expect(Object.hasOwn(target, key), `${at}.${key} が消えた`).toBe(true);
      added.push(...additionsOf(value, target[key], `${at}.${key}`));
    }
    for (const key of Object.keys(target)) if (!Object.hasOwn(before, key)) added.push(`${at}.${key}`);
    return added;
  }
  expect(after, `${at} の値が変わった`).toStrictEqual(before);
  return [];
}

describe("AC-H1: evm が無い・全部 false なら公開の生成は byte 一致", () => {
  test.each([["public", RAILS_ACTIVATION], ["none", RAILS_NONE]] as const)("%s: evm 無し・全部 false・facilitator の env あり（無効なので読まない）のどれでも、書き出す設定の文字列・子の env・一覧が golden と同じ", (name, activation) => {
    const expected = golden(name);
    const { evm: _evm, ...withoutEvm } = activation as RailsActivation;
    const variants: [RailsActivation, Record<string, string | undefined>][] = [
      [withoutEvm, goldenEnv],
      [withEvm(withoutEvm, EVM_NONE), goldenEnv],
      [withEvm(withoutEvm, { rh: OFF, arbsep: OFF, hyperevm: OFF }), evmEnv],
    ];
    for (const [variant, env] of variants) {
      const plan = planOf(variant, env);
      // 入口が `router.config.json` に書く文字列（`JSON.stringify(plan.config, null, 2)`）で比べる。
      expect(JSON.stringify(plan.config, null, 2)).toBe(JSON.stringify(expected.config, null, 2));
      expect(JSON.stringify(plan.childEnv)).toBe(JSON.stringify(expected.childEnv));
      expect(JSON.stringify(plan.config)).not.toMatch(/eip155:46630|eip155:421614|eip155:998"|127\.0\.0\.1:8611|dyn-(rh|arbsep|hyperevm)-|-to-(rh|arbsep|hyperevm)"/);
    }
    // 一覧（`subetha_router_list_routes` の本体）も同じ。
    const listed = (activationValue: RailsActivation) => JSON.stringify(routeListBody(loadPlan(planOf(activationValue)).router, "https://router.test"));
    expect(listed(withEvm(withoutEvm, EVM_NONE))).toBe(listed(withoutEvm));
  });

  test("公開の定数 RAILS_ACTIVATION.evm は全部 false（凍結）。evmOf は無ければ全部 false", () => {
    expect(RAILS_ACTIVATION.evm).toEqual({ rh: OFF, arbsep: OFF, hyperevm: OFF });
    expect(Object.isFrozen(RAILS_ACTIVATION.evm)).toBe(true);
    expect(evmOf(RAILS_NONE)).toBe(EVM_NONE);
    expect(Object.keys(EVM_NONE)).toEqual(["rh", "arbsep", "hyperevm"]);
    expect(HOSTED_EVM_CHAINS).toEqual(["rh", "arbsep", "hyperevm"]);
    // Ethereum Sepolia は hosted の対象外。
    expect(Object.keys(RAILS_ACTIVATION.evm!)).not.toContain("sepolia");
  });
});

describe("全部 true: golden との差分は追加だけ（SR-H2）", () => {
  test("既存の値は 1 つも変わらない。追加は 36 本のプロファイル・動的の区分 3 つ・受信の facilitator 3 つだけ。子の env は有効化の値に 6 語が後ろに付くだけ", () => {
    const expected = golden("public");
    const plan = planOf(PUBLIC_ALL, evmEnv);
    const added = additionsOf(expected.config, plan.config);
    expect(added.filter((p) => p.startsWith("$.router.dynamic.profiles.")).map((p) => p.slice("$.router.dynamic.profiles.".length)).sort()).toEqual(EXPECTED_36);
    expect(added.filter((p) => !p.startsWith("$.router.dynamic.profiles.")).sort()).toEqual(
      ["$.router.dynamic.budget.buckets[4]", "$.router.dynamic.budget.buckets[5]", "$.router.dynamic.budget.buckets[6]", `$.x402.inboundFacilitators.${NET.rh}`, `$.x402.inboundFacilitators.${NET.arbsep}`, `$.x402.inboundFacilitators.${NET.hyperevm}`].sort(),
    );
    // 既存の 20 本の順も変わらない（新しい 36 本は後ろ）。
    const ids = Object.keys((plan.config as any).router.dynamic.profiles);
    expect(ids.slice(0, 20)).toEqual(Object.keys(expected.config.router.dynamic.profiles));
    expect(ids).toHaveLength(56);
    // 静的 route・静的の予算は足さない（動的だけ。FR-H5）。
    expect((plan.config as any).router.routes).toEqual(expected.config.router.routes);
    expect((plan.config as any).router.budget).toEqual(expected.config.router.budget);
    // 子の env: 有効化の値が変わり、facilitator の URL（H-4。token を含む）が足されるだけ。gas 鍵は渡さない。
    const { [RAILS_ACTIVATION_ENV]: activationValue, SUBETHA_EVM_FACILITATOR_URL: urlValue, ...rest } = plan.childEnv;
    const { [RAILS_ACTIVATION_ENV]: goldenValue, ...goldenRest } = expected.childEnv as Record<string, string>;
    expect(rest).toEqual(goldenRest);
    expect(activationValue).toBe(`${goldenValue},rh-in,rh-out,arbsep-in,arbsep-out,hyperevm-in,hyperevm-out`);
    expect(urlValue).toBe(FACILITATOR_URL);
    expect(JSON.stringify(plan.childEnv)).not.toContain(FAC_KEY.slice(2));
  });

  test("本番と同じ読み込み（KNOWN_NETWORKS の検証）を通り、一覧に 56 本が出る。新 3 の受信の facilitator は env の URL（kind x402）で、HTTP の期限は表のチェーン別（20 秒）", () => {
    const plan = planOf(PUBLIC_ALL, evmEnv);
    const loaded = loadPlan(plan);
    const body = routeListBody(loaded.router, "https://router.test") as { routes: unknown[]; dynamic: { profiles: { profileId: string }[] } };
    expect(body.routes).toHaveLength(10);
    expect(body.dynamic.profiles.map((p) => p.profileId).filter((id) => EXPECTED_36.includes(id)).sort()).toEqual(EXPECTED_36);
    expect(body.dynamic.profiles).toHaveLength(56);
    for (const chain of HOSTED_EVM_CHAINS) {
      expect(loaded.real!.x402InboundFacilitators?.[NET[chain]]).toEqual({ kind: "x402", url: FACILITATOR_URL });
      // 期限は設定ではなく Router の表（`src/main.ts` の `evmRail` が `evmTestnetDeadlinesOf` で付ける。ローカル版 §3.6）。
      expect(evmTestnetDeadlinesOf(NET[chain])).toEqual({ inboundFacilitatorMs: 20_000, outboundPaidMs: 30_000 });
    }
  });
});

describe("36 本の値（宛先の種類・源の種類ごと）", () => {
  const profilesOf = () => loadPlan(planOf(PUBLIC_ALL, evmEnv)).router.dynamic!.profiles;
  const fee = { flat: "1000", bps: 0, min: "1000" };

  test("新 3 宛: rail x402、exact、表の資産・桁・EIP-712 domain、手数料 定額 1,000、上流 10,000、par。maxFee・tokenProgram は無い", () => {
    const profiles = profilesOf();
    for (const chain of HOSTED_EVM_CHAINS) {
      const table = knownNetworkOf(KNOWN_NETWORKS, NET[chain])!.assets.find((asset) => asset.id === EVM_TESTNETS[chain].asset)!;
      expect(table.domain).toEqual(EVM_TESTNETS[chain].domain);
      expect(profiles[`dyn-x402-to-${chain}`]).toEqual({
        profileId: `dyn-x402-to-${chain}`,
        sourceRail: "x402",
        source: { network: BASE, asset: INBOUND.asset, decimals: 6, payTo: RECEIVER },
        rail: "x402",
        destination: { scheme: "exact", network: NET[chain], asset: EVM_TESTNETS[chain].asset, decimals: 6, tokenDomain: { name: table.domain!.name, version: table.domain!.version } },
        par: true,
        maxUpstreamAmount: "10000",
        fee,
      });
    }
  });

  test("源の種類: Tempo（mpp・受取先 receiver）・Arc（受取鍵の address）・Solana x402（受取 owner）・Solana MPP（sourceRail mpp・受取 owner）・新 3（receiver）", () => {
    const profiles = profilesOf();
    expect(profiles["dyn-mpp-to-arbsep"]).toMatchObject({ sourceRail: "mpp", source: { network: TEMPO, asset: INBOUND_MPP.asset, decimals: 6, payTo: RECEIVER }, destination: { network: NET.arbsep } });
    expect(profiles["dyn-arc-to-hyperevm"]).toMatchObject({ sourceRail: "x402", source: { network: INBOUND_ARC.network, asset: INBOUND_ARC.asset, decimals: 6, payTo: ARC_RECEIVER }, destination: { network: NET.hyperevm } });
    expect(profiles["dyn-sol-to-rh"]).toMatchObject({ sourceRail: "x402", source: { network: INBOUND_SOL.network, asset: INBOUND_SOL.asset, decimals: 6, payTo: SOL_OWNER }, destination: { network: NET.rh } });
    expect(profiles["dyn-solmpp-to-arbsep"]).toMatchObject({ sourceRail: "mpp", source: { network: INBOUND_SOL.network, asset: INBOUND_SOL.asset, decimals: 6, payTo: SOL_OWNER }, destination: { network: NET.arbsep } });
    expect(profiles["dyn-rh-to-hyperevm"]).toMatchObject({ sourceRail: "x402", source: { network: NET.rh, asset: EVM_TESTNETS.rh.asset, decimals: 6, payTo: RECEIVER }, rail: "x402", destination: { scheme: "exact", network: NET.hyperevm, tokenDomain: { ...EVM_TESTNETS.hyperevm.domain } } });
    for (const id of EXPECTED_36) expect(profiles[id]!.profileId).toBe(id);
  });

  test("新 3 からの既存宛: 既存のビルダーと同じ値（Base・Tempo・Arc・Solana x402・Solana MPP）に源だけが違う", () => {
    const profiles = profilesOf();
    const source = { network: NET.rh, asset: EVM_TESTNETS.rh.asset, decimals: 6, payTo: RECEIVER };
    // 既存のプロファイル（Arc の源）から、源と id だけを差し替えたものと一致する。
    const sameAs = (newId: string, existingId: string) => {
      const { profileId: _a, source: _s, sourceRail: _r, ...existing } = profiles[existingId]!;
      const { profileId: _b, source: s, sourceRail: r, ...made } = profiles[newId]!;
      expect(made, newId).toEqual(existing);
      expect(s, newId).toEqual(source);
      expect(r, newId).toBe("x402");
    };
    sameAs("dyn-rh-to-x402", "dyn-arc-to-x402");
    sameAs("dyn-rh-to-mpp", "dyn-arc-to-mpp");
    sameAs("dyn-rh-to-sol", "dyn-arc-to-sol");
    sameAs("dyn-rh-to-solmpp", "dyn-arc-to-solmpp");
    sameAs("dyn-rh-to-arc", "dyn-sol-to-arc");
    expect(profiles["dyn-rh-to-x402"]).toMatchObject({ rail: "x402", destination: { scheme: "exact", network: BASE, tokenDomain: { name: "USDC", version: "2" } } });
    expect(profiles["dyn-rh-to-mpp"]).toMatchObject({ rail: "mpp", destination: { scheme: "tempo/charge", network: TEMPO, feeAsset: INBOUND_MPP.asset, maxFee: "50000", feeMargin: 20_000 } });
    expect(profiles["dyn-rh-to-arc"]).toMatchObject({ rail: "x402", destination: { scheme: "exact", network: INBOUND_ARC.network, tokenDomain: { name: "USDC", version: "2" } } });
    expect(profiles["dyn-rh-to-sol"]).toMatchObject({ rail: "x402", destination: { scheme: "exact", network: OUTBOUND_SOL.network, tokenProgram: OUTBOUND_SOL.tokenProgram } });
    expect(profiles["dyn-rh-to-solmpp"]).toMatchObject({ rail: "mpp", destination: { scheme: "solana/charge", network: OUTBOUND_SOL.network, tokenProgram: OUTBOUND_SOL.tokenProgram } });
    expect(profiles["dyn-rh-to-solmpp"]!.destination).not.toHaveProperty("maxFee");
  });
});

describe("出す条件（チェーン × 方向、既存の宛先・源の条件）", () => {
  const idsOf = (activation: RailsActivation, mppInbound = true, env: Record<string, string> = { SUBETHA_EVM_FACILITATOR_URL: FACILITATOR_URL }) => {
    const receivers = { ...(activation.arc.inbound ? { arc: ARC_RECEIVER } : {}), ...(activation.solana.inbound || activation.solanaMpp.inbound ? { solana: SOL_OWNER } : {}) };
    // 静的 route の Provider の受取先は見ない（URL を空にして静的 route を出さない。動的プロファイルの条件だけを見る）。
    const document = routerConfigOf(env, RECEIVER, mppInbound, { activation, receivers, upstreams: { arc: "", solana: "", solanaMpp: "" } }) as any;
    return Object.keys(document.router.dynamic?.profiles ?? {}).filter((id) => /(^dyn-(rh|arbsep|hyperevm)-)|(-to-(rh|arbsep|hyperevm)$)/.test(id)).sort();
  };

  test("rh の受信だけ: rh → 既存の宛先 5 本。rh の送信だけ: 既存の源 5 → rh。送信だけなら facilitator の env は要らない", () => {
    expect(idsOf(withEvm(RAILS_ACTIVATION, { rh: { inbound: true, outbound: false }, arbsep: OFF, hyperevm: OFF }))).toEqual(["dyn-rh-to-arc", "dyn-rh-to-mpp", "dyn-rh-to-sol", "dyn-rh-to-solmpp", "dyn-rh-to-x402"]);
    expect(idsOf(withEvm(RAILS_ACTIVATION, { rh: { inbound: false, outbound: true }, arbsep: OFF, hyperevm: OFF }), true, {})).toEqual(["dyn-arc-to-rh", "dyn-mpp-to-rh", "dyn-sol-to-rh", "dyn-solmpp-to-rh", "dyn-x402-to-rh"]);
  });

  test("既存のレールが無効なら、その端点の組は出ない（MPP 受信なし・Arc/Solana なし）。新 × 新は方向の分だけ", () => {
    // 源 = Base・rh、宛先 = Base・Tempo（MPP 送信のプロファイルは常に）・rh・arbsep。
    expect(idsOf(withEvm(RAILS_NONE, { rh: ON, arbsep: { inbound: false, outbound: true }, hyperevm: OFF }), false)).toEqual(["dyn-rh-to-arbsep", "dyn-rh-to-mpp", "dyn-rh-to-x402", "dyn-x402-to-arbsep", "dyn-x402-to-rh"]);
    // MPP 受信があれば Tempo の源が足される。
    expect(idsOf(withEvm(RAILS_NONE, { rh: { inbound: false, outbound: true }, arbsep: OFF, hyperevm: OFF }), true)).toEqual(["dyn-mpp-to-rh", "dyn-x402-to-rh"]);
  });

  test("既存 × 既存は新 3 の有効化で増えも変わりもしない（組 pairs が false なら dyn-arc-to-sol・dyn-sol-to-arc は出ないまま。レールの片方向だけでも）", () => {
    const existingOf = (activation: RailsActivation, mppInbound: boolean) => {
      const receivers = { ...(activation.arc.inbound ? { arc: ARC_RECEIVER } : {}), ...(activation.solana.inbound || activation.solanaMpp.inbound ? { solana: SOL_OWNER } : {}) };
      const document = routerConfigOf({ SUBETHA_EVM_FACILITATOR_URL: FACILITATOR_URL }, RECEIVER, mppInbound, { activation, receivers, upstreams: { arc: "", solana: "", solanaMpp: "" } }) as any;
      return Object.fromEntries(Object.entries(document.router.dynamic?.profiles ?? {}).filter(([id]) => !/(^dyn-(rh|arbsep|hyperevm)-)|(-to-(rh|arbsep|hyperevm)$)/.test(id)));
    };
    const { pairs: _pairs, ...noPairs } = RAILS_ACTIVATION;
    const shapes: RailsActivation[] = [RAILS_NONE, noPairs, RAILS_ACTIVATION, { ...RAILS_NONE, arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: true } }, { ...RAILS_NONE, solanaMpp: { inbound: true, outbound: false }, arc: { inbound: false, outbound: true } }];
    for (const shape of shapes) {
      for (const mppInbound of [true, false]) {
        expect(existingOf(withEvm(shape, EVM_ALL), mppInbound)).toStrictEqual(existingOf(shape, mppInbound));
      }
    }
    expect(Object.keys(existingOf(withEvm(noPairs, EVM_ALL), true))).not.toContain("dyn-arc-to-sol");
  });

  test("受信が有効で SUBETHA_EVM_FACILITATOR_URL が無い・空 → 固定文で止まる（値は出さない）。入口は facilitator の env が無ければ HostPlanError(evm_facilitator)（H-4: URL は入口が作る）", () => {
    for (const env of [{}, { SUBETHA_EVM_FACILITATOR_URL: "" }]) {
      expect(() => routerConfigOf(env, RECEIVER, true, { activation: withEvm(RAILS_NONE, { rh: OFF, arbsep: OFF, hyperevm: { inbound: true, outbound: false } }), receivers: {} })).toThrow(/^SUBETHA_EVM_FACILITATOR_URL is required when an EVM testnet inbound rail is activated$/);
    }
    let caught: unknown;
    try {
      planOf(PUBLIC_ALL, goldenEnv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostPlanError);
    expect((caught as HostPlanError).code).toBe("evm_facilitator");
  });

  test("区分: 受信か送信が有効な chain の (network, asset) を 1 件 20,000、総額は SUBETHA_DYNAMIC_MAX_TOTAL（既定 100,000,000）。静的の予算には足さない", () => {
    const bucketsOf = (activation: RailsActivation, env: Record<string, string>) => (routerConfigOf({ SUBETHA_EVM_FACILITATOR_URL: FACILITATOR_URL, ...env }, RECEIVER, true, { activation, receivers: {} }) as any).router;
    const router = bucketsOf(withEvm(RAILS_NONE, { rh: { inbound: true, outbound: false }, arbsep: { inbound: false, outbound: true }, hyperevm: OFF }), {});
    expect(router.dynamic.budget.buckets.slice(2)).toEqual([
      { network: NET.rh, asset: EVM_TESTNETS.rh.asset, maxTotal: "100000000", maxPerPurchase: "20000" },
      { network: NET.arbsep, asset: EVM_TESTNETS.arbsep.asset, maxTotal: "100000000", maxPerPurchase: "20000" },
    ]);
    expect(JSON.stringify(router.budget)).not.toMatch(/eip155:46630|eip155:421614|eip155:998"/);
    const custom = bucketsOf(withEvm(RAILS_NONE, EVM_ALL), { SUBETHA_DYNAMIC_MAX_TOTAL: "5000000" });
    expect(custom.dynamic.budget.buckets.map((b: { network: string; maxTotal: string }) => [b.network, b.maxTotal])).toEqual([[BASE, "5000000"], [TEMPO, "5000000"], [NET.rh, "5000000"], [NET.arbsep, "5000000"], [NET.hyperevm, "5000000"]]);
  });
});

describe("1 件の上限の境界（hosted 設計 §5、AC-H2。本物の予約の計算）", () => {
  const M = 20_000n;
  let router: RouterConfig;
  beforeAll(() => {
    router = loadPlan(planOf(PUBLIC_ALL, evmEnv)).router;
  });
  const estimate = { gas: "1", maxFeePerGas: "1", bound: "1", atMs: 0 };
  /** 予約（区分ごとの合算）と判定。 */
  const verdictOf = (config: RouterConfig, profileId: string, u: bigint, c?: bigint) => {
    const profile = config.dynamic!.profiles[profileId]!;
    const pricing = priceOf(profile, u.toString(), c === undefined ? undefined : { maxFee: c.toString(), estimate });
    expect(pricing, profileId).toBeDefined();
    const reservation = reservationOf(profile, pricing!);
    const sums = new Map<string, bigint>();
    for (const leg of reservation.legs) sums.set(leg.network, (sums.get(leg.network) ?? 0n) + BigInt(leg.amount));
    return { sums, verdict: perPurchaseLimitOf(config, reservation) };
  };
  /** 1 つの区分の 1 件の上限だけを大きくした写し（もう片方の不等式だけで拒まれることを確かめる）。 */
  const relaxed = (network: string): RouterConfig => ({
    ...router,
    dynamic: { ...router.dynamic!, budget: { ...router.dynamic!.budget, buckets: router.dynamic!.budget.buckets.map((bucket) => (bucket.network === network ? { ...bucket, maxPerPurchase: "1000000000" } : bucket)) } },
  });

  test.each([1n, 9_999n, 10_000n])("x402 の宛先（新・Base・Arc・Solana）・既存 → 新: u = %s は源 u + 1,000、宛先 u で受理", (u) => {
    const cases: [string, string, string][] = [
      ["dyn-rh-to-x402", NET.rh, BASE],
      ["dyn-arbsep-to-arc", NET.arbsep, INBOUND_ARC.network],
      ["dyn-hyperevm-to-sol", NET.hyperevm, INBOUND_SOL.network],
      ["dyn-rh-to-hyperevm", NET.rh, NET.hyperevm],
      ["dyn-x402-to-rh", BASE, NET.rh],
      ["dyn-sol-to-arbsep", INBOUND_SOL.network, NET.arbsep],
      ["dyn-solmpp-to-hyperevm", INBOUND_SOL.network, NET.hyperevm],
      ["dyn-mpp-to-rh", TEMPO, NET.rh],
      ["dyn-rh-to-solmpp", NET.rh, INBOUND_SOL.network],
    ];
    for (const [id, source, destination] of cases) {
      const { sums, verdict } = verdictOf(router, id, u);
      expect(sums.get(source), id).toBe(u + 1_000n);
      expect(sums.get(destination), id).toBe(u);
      expect(verdict, id).toBeUndefined();
    }
  });

  test("新 → Tempo: 源（新）u + max(1,000, c) ≤ M と宛先（Tempo）u + c ≤ M。等号は受理、1 超過は per_purchase_limit（既存の dyn-x402-to-mpp と同じ）", () => {
    for (const id of ["dyn-rh-to-mpp", "dyn-arbsep-to-mpp", "dyn-hyperevm-to-mpp", "dyn-x402-to-mpp"]) {
      for (const u of [1n, 9_999n, 10_000n]) {
        const c = M - u;
        const equal = verdictOf(router, id, u, c);
        expect(equal.sums.get(TEMPO), id).toBe(M);
        expect(equal.verdict, `${id} u=${u} c=${c}`).toBeUndefined();
        expect(verdictOf(router, id, u, c + 1n).verdict, `${id} u=${u} c=${c + 1n}`).toBe("per_purchase_limit");
      }
      // 実測の cap（79〜706）では u = 10,000 で両方とも ≤ 11,000。
      const measured = verdictOf(router, id, 10_000n, 706n);
      expect([...measured.sums.values()].every((sum) => sum <= 11_000n), id).toBe(true);
      expect(measured.verdict).toBeUndefined();
    }
  });

  test("新 → Tempo: 両方の不等式がそれぞれ効く（片方の区分の上限を外しても、もう片方で 1 超過が拒まれる）", () => {
    const sourceOnly = relaxed(TEMPO); // 宛先（Tempo）の上限を外す → 源（rh）の u + c = M + 1 で拒む
    const destinationOnly = relaxed(NET.rh); // 源（rh）の上限を外す → 宛先（Tempo）の u + c = M + 1 で拒む
    for (const config of [sourceOnly, destinationOnly]) {
      expect(verdictOf(config, "dyn-rh-to-mpp", 10_000n, 10_000n).verdict).toBeUndefined();
      expect(verdictOf(config, "dyn-rh-to-mpp", 10_000n, 10_001n).verdict).toBe("per_purchase_limit");
    }
    // c < 1,000 のとき源は u + 1,000、宛先は u + c（別の値）。
    const small = verdictOf(router, "dyn-rh-to-mpp", 10_000n, 79n);
    expect(small.sums.get(NET.rh)).toBe(11_000n);
    expect(small.sums.get(TEMPO)).toBe(10_079n);
    // 両方外すと通る（拒否が区分の上限から来ていることの対照）。
    const both: RouterConfig = { ...sourceOnly, dynamic: { ...sourceOnly.dynamic!, budget: { ...sourceOnly.dynamic!.budget, buckets: sourceOnly.dynamic!.budget.buckets.map((bucket) => (bucket.network === NET.rh ? { ...bucket, maxPerPurchase: "1000000000" } : bucket)) } } };
    expect(verdictOf(both, "dyn-rh-to-mpp", 10_000n, 10_001n).verdict).toBeUndefined();
  });

  test("新 3 の区分が無ければ bucket_not_allowed（区分を足すことが要る）", () => {
    const without: RouterConfig = { ...router, dynamic: { ...router.dynamic!, budget: { ...router.dynamic!.budget, buckets: router.dynamic!.budget.buckets.filter((bucket) => bucket.network !== NET.arbsep) } } };
    expect(verdictOf(without, "dyn-arbsep-to-x402", 1n).verdict).toBe("bucket_not_allowed");
    expect(verdictOf(without, "dyn-x402-to-arbsep", 1n).verdict).toBe("bucket_not_allowed");
  });
});

describe("有効化の往復（ホスト → 子の内部 env SUBETHA_RAILS_ACTIVATION）", () => {
  test("6 語（<chain>-in・<chain>-out）を組の後ろに。全部 false なら 1 語も出ず、復元した値に evm の欄は無い。部分の往復", () => {
    expect(activationToEnv(withEvm(RAILS_NONE, EVM_ALL))).toBe("rh-in,rh-out,arbsep-in,arbsep-out,hyperevm-in,hyperevm-out");
    expect(activationFromEnv(activationToEnv(PUBLIC_ALL))).toEqual(PUBLIC_ALL);
    expect(activationToEnv(withEvm(RAILS_ACTIVATION, EVM_NONE))).toBe(activationToEnv(RAILS_ACTIVATION));
    expect(activationFromEnv(activationToEnv(RAILS_ACTIVATION))).not.toHaveProperty("evm");
    const partial = withEvm(RAILS_NONE, { rh: { inbound: true, outbound: false }, arbsep: OFF, hyperevm: { inbound: false, outbound: true } });
    expect(activationToEnv(partial)).toBe("rh-in,hyperevm-out");
    expect(activationFromEnv(activationToEnv(partial))).toEqual(partial);
    expect(activationFromEnv(" hyperevm-out , rh-in ")).toEqual(partial);
    // 計画の子の env からも同じ値に戻る。
    expect(activationFromEnv(planOf(PUBLIC_ALL, evmEnv).childEnv[RAILS_ACTIVATION_ENV])).toEqual(PUBLIC_ALL);
  });

  test("知らない語・重複・大文字・sepolia は起動しない", () => {
    for (const bad of ["rh", "rh-in,rh-in", "sepolia-in", "RH-IN", "eth-in", "rh-in,", "evm-in", "arbsep-inbound"]) {
      expect(() => activationFromEnv(bad), bad).toThrow(/SUBETHA_RAILS_ACTIVATION must be a comma-separated subset/);
    }
  });
});

describe("公開の子の能力（routerProcessCapabilitiesOf。hosted 設計 §3 の最後）", () => {
  const x402Key = generatePrivateKey();
  const childEnv = (activation: RailsActivation, extra: Record<string, string | undefined> = {}) => ({ SUBETHA_OUTBOUND_X402_KEY: x402Key, SUBETHA_OUTBOUND_MPP_KEY: generatePrivateKey(), [RAILS_ACTIVATION_ENV]: activationToEnv(activation), ...extra });

  test("env が無ければ今と同じ（localCounterparties も新 3 の evmSigningByNetwork も無い）。正確な形の URL ならその origin 1 つだけを足し、ほかの欄は変わらない", () => {
    const base = routerProcessCapabilitiesOf(childEnv(RAILS_NONE));
    expect(base).not.toHaveProperty("localCounterparties");
    expect(base).not.toHaveProperty("evmSigningByNetwork");
    for (const empty of [{}, { SUBETHA_EVM_FACILITATOR_URL: "" }]) expect(Object.keys(routerProcessCapabilitiesOf(childEnv(RAILS_NONE, empty))).sort()).toEqual(Object.keys(base).sort());
    const withUrl = routerProcessCapabilitiesOf(childEnv(RAILS_NONE, { SUBETHA_EVM_FACILITATOR_URL: FACILITATOR_URL }));
    expect(withUrl.localCounterparties).toEqual({ origins: ["http://127.0.0.1:8611"] });
    const { localCounterparties: _l, ...rest } = withUrl;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(base).sort());
    expect(rest.dependencyUrls).toEqual(base.dependencyUrls);
    expect(rest.evmSigning?.signer.address).toBe(base.evmSigning?.signer.address);
    expect(evmFacilitatorOriginOf(`http://127.0.0.1:65535/${"a".repeat(32)}`)).toBe("http://127.0.0.1:65535");
    expect(evmFacilitatorOriginOf(`http://127.0.0.1:1/${"a".repeat(256)}`)).toBe("http://127.0.0.1:1");
  });

  test.each([
    "http://127.0.0.1:8611",
    "http://127.0.0.1:8611/",
    `http://127.0.0.1:8611/${"a".repeat(31)}`,
    `http://127.0.0.1:8611/${"a".repeat(257)}`,
    `http://127.0.0.1:8611/${TOKEN}/`,
    `http://127.0.0.1:8611/${TOKEN}/verify`,
    `http://127.0.0.1:8611/${TOKEN}?x=1`,
    `http://127.0.0.1:8611/${TOKEN}#f`,
    `http://127.0.0.1:8611/${TOKEN}.x`,
    `http://localhost:8611/${TOKEN}`,
    `https://127.0.0.1:8611/${TOKEN}`,
    `http://127.0.0.2:8611/${TOKEN}`,
    `http://[::1]:8611/${TOKEN}`,
    `http://127.1:8611/${TOKEN}`,
    `http://127.0.0.1/${TOKEN}`,
    `http://127.0.0.1:80/${TOKEN}`,
    `http://127.0.0.1:0/${TOKEN}`,
    `http://127.0.0.1:08611/${TOKEN}`,
    `http://127.0.0.1:65536/${TOKEN}`,
    `http://u@127.0.0.1:8611/${TOKEN}`,
    `HTTP://127.0.0.1:8611/${TOKEN}`,
    ` http://127.0.0.1:8611/${TOKEN}`,
    `http://router.subethalabs.com/evm-facilitator/${TOKEN}`,
    "not a url",
  ])("形の違う URL（%s）は固定文で止まる（値は出さない）", (url) => {
    let caught: unknown;
    try {
      routerProcessCapabilitiesOf(childEnv(RAILS_NONE, { SUBETHA_EVM_FACILITATOR_URL: url }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProcessEntryError);
    expect((caught as ProcessEntryError).code).toBe("evm_facilitator");
    expect((caught as Error).message).toBe("SUBETHA_EVM_FACILITATOR_URL must be exactly http://127.0.0.1:<port>/<token>");
    expect((caught as Error).message).not.toContain(TOKEN);
  });

  test("evmSigningByNetwork は送信が有効な chain だけ（同じ x402 の鍵、Arc と並ぶ）。受信だけの chain は足さない。鍵が無ければ outbound_keys", () => {
    const address = privateKeyToAccount(x402Key).address;
    const activation = withEvm(RAILS_NONE, { rh: { inbound: true, outbound: true }, arbsep: { inbound: true, outbound: false }, hyperevm: { inbound: false, outbound: true } });
    const capabilities = routerProcessCapabilitiesOf(childEnv(activation));
    expect(Object.keys(capabilities.evmSigningByNetwork ?? {})).toEqual([NET.rh, NET.hyperevm]);
    for (const [network, capability] of Object.entries(capabilities.evmSigningByNetwork!)) {
      expect(capability.network).toBe(network);
      expect(capability.signer.address).toBe(address);
    }
    // Arc の送信と一緒なら Arc の network も（既存のまま）。
    const withArc = routerProcessCapabilitiesOf(childEnv(withEvm({ ...RAILS_NONE, arc: { inbound: false, outbound: true } }, { rh: OFF, arbsep: { inbound: false, outbound: true }, hyperevm: OFF })));
    expect(Object.keys(withArc.evmSigningByNetwork ?? {})).toEqual([INBOUND_ARC.network, NET.arbsep]);
    // 受信だけ: 足さない。
    expect(routerProcessCapabilitiesOf(childEnv(withEvm(RAILS_NONE, { rh: { inbound: true, outbound: false }, arbsep: OFF, hyperevm: OFF })))).not.toHaveProperty("evmSigningByNetwork");
    // x402 の鍵が無い（MPP の鍵だけ）で送信が有効 → 止まる。
    let caught: unknown;
    try {
      routerProcessCapabilitiesOf({ ...childEnv(withEvm(RAILS_NONE, { rh: { inbound: false, outbound: true }, arbsep: OFF, hyperevm: OFF })), SUBETHA_OUTBOUND_X402_KEY: "" });
    } catch (error) {
      caught = error;
    }
    expect((caught as ProcessEntryError).code).toBe("outbound_keys");
  });

  test("静的検査: URL の token の形は facilitator（tools/evm-facilitator.ts の TOKEN_PATTERN）と同じ", () => {
    const facilitator = readFileSync("tools/evm-facilitator.ts", "utf8");
    const entry = readFileSync("tools/rails-entry.ts", "utf8");
    const token = /const TOKEN_PATTERN = \/\^(\[[^\]]+\]\{\d+,\d+\})\$\//.exec(facilitator)?.[1];
    expect(token).toBe("[A-Za-z0-9_-]{32,256}");
    expect(entry).toContain(`\\/(${token})$/;`);
  });
});

/* ------------------------------------------------------------------ 配線（composeRails）: 公開の生成 + 公開の子の能力 */

/** 接続と要求を数える loopback の facilitator・上流の相手。 */
interface Counterparty {
  readonly origin: string;
  connections: number;
  requests: string[];
  close(): Promise<void>;
}
async function startCounterparty(): Promise<Counterparty> {
  const state = { connections: 0, requests: [] as string[] };
  const server = http.createServer((request, response) => {
    state.requests.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ isValid: true }));
    });
  });
  server.on("connection", () => {
    state.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, {
    origin: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  }) as Counterparty;
}

describe("配線: 公開の生成（全部 true）と公開の子の能力で、受信の facilitator だけが loopback に届く", () => {
  let facilitator: Counterparty;
  let other: Counterparty;
  beforeAll(async () => {
    facilitator = await startCounterparty();
    other = await startCounterparty();
  });
  afterAll(async () => {
    await facilitator.close();
    await other.close();
  });

  /** 入口と同じ計画 → 子の env（+ H-4 が渡す facilitator の URL）→ 本番の読み込み → 公開の子の能力 → composeRails。 */
  const composed = (withFacilitatorEnv: boolean) => {
    const url = `${facilitator.origin}/${TOKEN}`;
    const plan = planOf(PUBLIC_ALL, evmEnv, Number(new URL(facilitator.origin).port));
    expect(plan.childEnv["SUBETHA_EVM_FACILITATOR_URL"]).toBe(url);
    const config = loadPlan(plan);
    const seed = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
    // 子の env は計画のもの（H-4 で URL を含む）。`false` は URL を抜いた形（能力が無い場合の対照）。
    const { SUBETHA_EVM_FACILITATOR_URL: _url, ...withoutUrl } = plan.childEnv;
    const capabilities = routerProcessCapabilitiesOf({ ...(withFacilitatorEnv ? plan.childEnv : withoutUrl), SUBETHA_OUTBOUND_SOLANA_KEY: seed });
    const events: TransportEvent[] = [];
    return { rails: composeRails(config, capabilities, (event) => events.push(event), () => {}), events, capabilities };
  };

  const verifyRh = async (rails: ReturnType<typeof composeRails>) => {
    const binding = `dynamic|dyn-rh-to-x402|GET|${encodeURIComponent("https://provider.example/v1/x")}`;
    const offer = await rails.inbound.createOffer({ routeId: "dyn-rh-to-x402", amount: "11000", asset: EVM_TESTNETS.rh.asset, network: NET.rh, routeBinding: binding, nowMs: Date.now() });
    const credential = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, signature: "0x00", authorization: {} } };
    return rails.inbound.verify(offer, credential, { routeId: "dyn-rh-to-x402" });
  };

  test("dyn-rh-to-x402 の受信の verify は facilitator（token は path の接頭辞）に届く。子に URL が無ければ（能力が無い = 今の hosted）動的の transport のまま送出の前に拒む（接続 0）", async () => {
    const { rails, capabilities } = composed(true);
    expect(capabilities.localCounterparties).toEqual({ origins: [facilitator.origin] });
    expect(Object.keys(capabilities.evmSigningByNetwork ?? {})).toEqual([INBOUND_ARC.network, NET.rh, NET.arbsep, NET.hyperevm]);
    const before = facilitator.requests.length;
    expect(await verifyRh(rails)).toEqual({ isValid: true });
    expect(facilitator.requests.slice(before)).toEqual([`POST /${TOKEN}/verify`]);
    // H-4 が URL を子に渡さなければ、能力 `localCounterparties` が無いので動的の transport（loopback 不可）のまま: 送出の前に拒む。
    const { rails: without, capabilities: none } = composed(false);
    expect(none).not.toHaveProperty("localCounterparties");
    const connections = facilitator.connections;
    await expect(verifyRh(without)).rejects.toMatchObject({ code: "destination_blocked" });
    expect(facilitator.connections).toBe(connections);
  });

  test("dyn-x402-to-rh の送信（呼び出し側の URL）は loopback に接続しない: facilitator の origin・別の loopback のどちらも challenge・支払いつきの要求とも接続 0", async () => {
    const { rails } = composed(true);
    const rh = EVM_TESTNETS.rh;
    for (const target of [{ url: `${other.origin}/v1/eth/snapshot`, method: "GET" as const }, { url: `${facilitator.origin}/${TOKEN}/supported`, method: "GET" as const }]) {
      const before = { other: other.connections, facilitator: facilitator.connections };
      await expect(rails.outbound.readChallenge("dyn-x402-to-rh", target)).rejects.toBeDefined();
      const offer = { scheme: "exact", network: rh.network, asset: rh.asset, amount: "10000", payTo: "0xf8243d93F339807CA9846Aa31155A2B2262D08db", maxTimeoutSeconds: 60, extra: { name: rh.domain.name, version: rh.domain.version } };
      const paid = await rails.outbound.pay({ routeId: "dyn-x402-to-rh", offer: offer as never, paymentId: "p-h3-loopback", attempt: 1, deadlineMs: Date.now() + 60_000, target }).catch((error: unknown) => error);
      expect(paid).not.toMatchObject({ outcome: "paid" });
      expect(other.connections, target.url).toBe(before.other);
      expect(facilitator.connections, target.url).toBe(before.facilitator);
    }
  });
});
