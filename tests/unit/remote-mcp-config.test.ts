/**
 * 本番の入口の設定生成（`tools/remote-mcp-config.ts`）の多レール（multirail 設計 §8、タスク T8-a）。
 * 登録は 1 つの値 `activation: { arc, solana }` で決まる。設定生成の既定の引数（`RAILS_DISABLED`）は**どちらも無効**、公開の process の定数
 * `RAILS_ACTIVATION` は G-4（2026-10-07）で両方 `true`。
 * env からは変えられない。有効にしたときだけ route・プロファイル・予算の区分・facilitator が出て、`KNOWN_NETWORKS` の検証を通る。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { ConfigError, KNOWN_NETWORKS, loadRuntimeConfig, parseRouterConfig, type RouterConfig, type RuntimeConfig } from "../../src/config.js";
import { perPurchaseLimitOf, priceOf, reservationOf } from "../../src/core/dynamic.js";
import { routeListBody } from "../../src/http/projection.js";
import {
  dynamicProfilesOf,
  INBOUND,
  INBOUND_ARC,
  INBOUND_SOL,
  RAILS_ACTIVATION,
  RAILS_DISABLED,
  RAILS_NONE,
  ROUTE,
  ROUTE_ARC,
  ROUTE_ARC_OUT,
  ROUTE_MPP_IN,
  ROUTE_SOL,
  OUTBOUND_ARC,
  OUTBOUND_SOL,
  RAIL_UPSTREAMS,
  railActive,
  ROUTE_SOL_OUT,
  ROUTE_SOLMPP_OUT,
  ROUTE_SOLMPP_OUT_MPP,
  ROUTE_SOLMPP_TO_MPP,
  ROUTE_SOLMPP_TO_X402,
  UPSTREAM_SOL,
  UPSTREAM_SOL_MPP,
  routerConfigOf,
  UPSTREAM,
  UPSTREAM_ARC,
  UPSTREAM_X402,
  type RailsOptions,
  type PairsActivation, type RailsActivation,
} from "../../tools/remote-mcp-config.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const ARC_RECEIVER = "0xAF42CFfe4B35A05098613d962aF43CDc43fBb4Ea";
const SOL_OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const BOTH: RailsOptions = { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER } };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 生成した文書を、本番と同じ読み方（real モード = `KNOWN_NETWORKS`、env の facilitator）で読む。 */
function loadAsProduction(document: Record<string, unknown>): RuntimeConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "t8a-config-"));
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
      ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-t8a",
      ROUTER_CANONICAL_BASE_URL: "https://router.test",
      ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
    },
    (file) => (file === configPath ? JSON.stringify(document) : ""),
  );
}

function routerOf(document: Record<string, unknown>): RouterConfig {
  return parseRouterConfig(document["router"], { networks: KNOWN_NETWORKS });
}

function listedIds(router: RouterConfig): { routes: string[]; profiles: string[] } {
  const body = routeListBody(router, "https://router.test") as { routes: { routeId: string }[]; dynamic?: { profiles?: { profileId: string }[] } };
  return { routes: body.routes.map((r) => r.routeId).sort(), profiles: (body.dynamic?.profiles ?? []).map((p) => p.profileId).sort() };
}

function bucketsOf(router: RouterConfig): { static: string[]; dynamic: string[] } {
  const key = (b: { network: string; asset: string; maxPerPurchase: string; maxTotal: string }) => `${b.network}|${b.asset}|${b.maxPerPurchase}|${b.maxTotal}`;
  return { static: router.budget.buckets.map(key).sort(), dynamic: (router.dynamic?.budget.buckets ?? []).map(key).sort() };
}

describe("公開の process の既定: Arc・Solana はどちらも無効", () => {
  test("既定の生成（RAILS_DISABLED = RAILS_NONE）は既存の 2 経路・2 プロファイルだけ。公開の定数 RAILS_ACTIVATION は受信（G-4）も送信（G-4′）も両方 true（凍結）", () => {
    expect(RAILS_NONE).toEqual({ arc: { inbound: false, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } });
    expect(Object.isFrozen(RAILS_NONE)).toBe(true);
    expect(RAILS_DISABLED.activation).toBe(RAILS_NONE);
    expect(RAILS_ACTIVATION).toEqual({ arc: { inbound: true, outbound: true }, solana: { inbound: true, outbound: true }, solanaMpp: { inbound: true, outbound: true }, pairs: { arcToSol: true, solToArc: true } });
    expect(Object.isFrozen(RAILS_ACTIVATION)).toBe(true);
    const document = routerConfigOf({}, RECEIVER, true);
    expect(document).toEqual(routerConfigOf({}, RECEIVER, true, RAILS_DISABLED));
    const router = routerOf(document);
    expect(Object.keys(router.routes).sort()).toEqual([ROUTE, ROUTE_MPP_IN].sort());
    expect(Object.keys(router.dynamic!.profiles).sort()).toEqual(["dyn-mpp-to-x402", "dyn-x402-to-mpp"]);
    // facilitator の表・新しい区分・新しい上流は出ない。
    expect((document["x402"] as Record<string, unknown>)["inboundFacilitators"]).toBeUndefined();
    expect(Object.keys((document["x402"] as { upstreams: Record<string, string> }).upstreams).sort()).toEqual([ROUTE, ROUTE_MPP_IN].sort());
    const buckets = bucketsOf(router);
    expect(buckets.static.some((b) => b.startsWith(INBOUND_ARC.network) || b.startsWith(INBOUND_SOL.network))).toBe(false);
    expect(buckets.dynamic.some((b) => b.startsWith(INBOUND_ARC.network) || b.startsWith(INBOUND_SOL.network))).toBe(false);
    // 公開の一覧にも出ない。
    expect(listedIds(router)).toEqual({ routes: [ROUTE, ROUTE_MPP_IN].sort(), profiles: ["dyn-mpp-to-x402", "dyn-x402-to-mpp"] });
    expect(JSON.stringify(document)).not.toMatch(/5042002|solana:|circle|4zMMC9/);
    // 本番と同じ読み方で通る（env の facilitator だけ。表との照合も通る）。
    const loaded = loadAsProduction(document);
    expect(loaded.real?.x402InboundFacilitators).toBeUndefined();
  });

  test("env からは有効にできない（候補の名前をどれだけ与えても既定と同じ）", () => {
    const envs: Record<string, string>[] = [
      { ARC_PROFILES_ENABLED: "true", SOLANA_PROFILES_ENABLED: "true" },
      { SUBETHA_ARC_ENABLED: "1", SUBETHA_SOLANA_ENABLED: "1", SUBETHA_RAILS: "arc-in,solana-in", RAILS_ACTIVATION: '{"arc":true,"solana":true}' },
      { SUBETHA_ARC_RECEIVER_KEY: `0x${"11".repeat(32)}`, SUBETHA_SOLANA_RECEIVER: SOL_OWNER, SUBETHA_SOLANA_RPC_URL: "https://api.devnet.solana.com" },
    ];
    for (const env of envs) {
      expect(routerConfigOf(env, RECEIVER, true)).toEqual(routerConfigOf({}, RECEIVER, true));
      expect(routerConfigOf(env, RECEIVER, false)).toEqual(routerConfigOf({}, RECEIVER, false));
      expect(dynamicProfilesOf(env, RECEIVER, true)).toEqual(dynamicProfilesOf({}, RECEIVER, true));
    }
  });

  test("受取先だけ渡しても、有効にしていなければ何も出ない（受取先は読まれない）", () => {
    const document = routerConfigOf({}, RECEIVER, true, { activation: RAILS_NONE, receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER } });
    expect(document).toEqual(routerConfigOf({}, RECEIVER, true));
    expect(JSON.stringify(document)).not.toContain(ARC_RECEIVER);
    expect(JSON.stringify(document)).not.toContain(SOL_OWNER);
  });
});

describe("有効にしたときだけ出る（設計 §8・D-6・D-7）", () => {
  test("両方有効: route 4・プロファイル 6・facilitator 2 が出て、KNOWN_NETWORKS と env の読み方で通る。予算の区分は既存と同じ桁", () => {
    const document = routerConfigOf({}, RECEIVER, true, BOTH);
    const loaded = loadAsProduction(document);
    const router = loaded.router;
    expect(Object.keys(router.routes).sort()).toEqual([ROUTE, ROUTE_MPP_IN, ROUTE_ARC, ROUTE_SOL].sort());
    expect(Object.keys(router.dynamic!.profiles).sort()).toEqual(["dyn-arc-to-mpp", "dyn-arc-to-x402", "dyn-mpp-to-x402", "dyn-sol-to-mpp", "dyn-sol-to-x402", "dyn-x402-to-mpp"]);
    // 静的 route: Arc USDC → Provider B（MPP）、Solana USDC → Provider A（x402）。受取先は渡した address。
    expect(router.routes[ROUTE_ARC]).toMatchObject({ rail: "mpp", sourceRail: "x402", source: { network: INBOUND_ARC.network, asset: INBOUND_ARC.asset, amount: "10000", decimals: 6, payTo: ARC_RECEIVER }, destination: { scheme: "tempo/charge", network: "eip155:42431" } });
    expect(router.routes[ROUTE_SOL]).toMatchObject({ rail: "x402", sourceRail: "x402", source: { network: INBOUND_SOL.network, asset: INBOUND_SOL.asset, amount: "10000", decimals: 6, payTo: SOL_OWNER }, destination: { scheme: "exact", network: "eip155:84532" } });
    // 動的プロファイル: par 1:1、x402 送信は定額 1,000、MPP 送信はガス代連動（天井 50,000・2 倍）。
    for (const [id, rail] of [["dyn-arc-to-x402", "x402"], ["dyn-sol-to-x402", "x402"], ["dyn-arc-to-mpp", "mpp"], ["dyn-sol-to-mpp", "mpp"]] as const) {
      const profile = router.dynamic!.profiles[id]!;
      const source = id.includes("arc") ? INBOUND_ARC : INBOUND_SOL;
      expect(profile).toMatchObject({ sourceRail: "x402", rail, par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" }, source: { network: source.network, asset: source.asset, decimals: 6, payTo: id.includes("arc") ? ARC_RECEIVER : SOL_OWNER } });
      if (rail === "mpp") expect(profile.destination).toMatchObject({ scheme: "tempo/charge", feeAsset: "0x20c0000000000000000000000000000000000000", maxFee: "50000", feeMargin: 20_000 });
      else expect(profile.destination).toMatchObject({ scheme: "exact", network: "eip155:84532", tokenDomain: { name: "USDC", version: "2" } });
    }
    // 予算の区分: 静的 1 件 10,000、動的 1 件 20,000（D-7）。
    const buckets = bucketsOf(router);
    expect(buckets.static).toContain("eip155:5042002|0x3600000000000000000000000000000000000000|10000|1000000000");
    expect(buckets.static).toContain("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1|4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU|10000|1000000000");
    expect(buckets.dynamic).toContain("eip155:5042002|0x3600000000000000000000000000000000000000|20000|100000000");
    expect(buckets.dynamic).toContain("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1|4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU|21000|100000000"); // 両レグが同じ区分に落ちる組の分（下の行）
    expect(buckets.static).toHaveLength(4);
    expect(buckets.dynamic).toHaveLength(4);
    // 通算の上限は既存の env の上書きをそのまま使う（新しい env は増やさない）。
    const overridden = routerOf(routerConfigOf({ SUBETHA_INBOUND_MAX_TOTAL: "777", SUBETHA_DYNAMIC_MAX_TOTAL: "555" }, RECEIVER, true, BOTH));
    expect(bucketsOf(overridden).static.filter((b) => b.endsWith("|10000|777"))).toHaveLength(3);
    expect(bucketsOf(overridden).dynamic.filter((b) => b.endsWith("|555"))).toHaveLength(4);
    expect(bucketsOf(overridden).dynamic.filter((b) => b.endsWith("|20000|555"))).toHaveLength(3);
    expect(bucketsOf(overridden).dynamic.filter((b) => b.endsWith("|21000|555"))).toHaveLength(1);
    // 文字どおりの id・path・宛先（定数を書き換えても気づけるように、生成側の定数は使わない）。
    expect(ROUTE_ARC).toBe("md-mpp-eth-snapshot-arc");
    expect(ROUTE_SOL).toBe("md-x402-eth-snapshot-sol");
    expect(router.routes[ROUTE_ARC]).toMatchObject({ canonicalPath: "/v1/routes/md-mpp-eth-snapshot-arc/resource", destination: { asset: "0x20c0000000000000000000000000000000000000", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1" } });
    expect(router.routes[ROUTE_SOL]).toMatchObject({ canonicalPath: "/v1/routes/md-x402-eth-snapshot-sol/resource", destination: { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1" } });
    expect(loaded.real?.upstreams[ROUTE_ARC]).toBe("https://provider-mpp.subethalabs.com/v1/eth/snapshot");
    expect(loaded.real?.upstreams[ROUTE_SOL]).toBe("https://provider-x402.subethalabs.com/v1/eth/snapshot");
    // facilitator は network ごと（Arc は Circle の kind、Solana は x402.org）。Base Sepolia は env のまま。
    expect(loaded.real?.x402InboundFacilitators).toEqual({ [INBOUND_ARC.network]: { kind: "circle", url: "https://api.circle.com/v1/facilitator/x402" }, [INBOUND_SOL.network]: { kind: "x402", url: "https://www.x402.org/facilitator" } });
    expect(loaded.real?.x402InboundFacilitatorUrl).toBe("https://www.x402.org/facilitator");
    // 上流は route ごと（Arc は Provider B、Solana は Provider A）。
    expect(loaded.real?.upstreams).toEqual({ [ROUTE]: UPSTREAM, [ROUTE_MPP_IN]: UPSTREAM_X402, [ROUTE_ARC]: UPSTREAM, [ROUTE_SOL]: UPSTREAM_X402 });
    // 公開の一覧に出る。
    expect(listedIds(router)).toEqual({ routes: [ROUTE, ROUTE_MPP_IN, ROUTE_ARC, ROUTE_SOL].sort(), profiles: ["dyn-arc-to-mpp", "dyn-arc-to-x402", "dyn-mpp-to-x402", "dyn-sol-to-mpp", "dyn-sol-to-x402", "dyn-x402-to-mpp"] });
  });

  test.each([
    ["Arc だけ", { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, receivers: { arc: ARC_RECEIVER } }, [ROUTE_ARC], ["dyn-arc-to-mpp", "dyn-arc-to-x402"], INBOUND_ARC.network, INBOUND_SOL.network],
    ["Solana だけ", { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, receivers: { solana: SOL_OWNER } }, [ROUTE_SOL], ["dyn-sol-to-mpp", "dyn-sol-to-x402"], INBOUND_SOL.network, INBOUND_ARC.network],
  ] as const)("%s を有効にすると、そのレールの分だけ出る", (_name, rails, routes, profiles, present, absent) => {
    const document = routerConfigOf({}, RECEIVER, true, rails);
    const loaded = loadAsProduction(document);
    expect(Object.keys(loaded.router.routes).sort()).toEqual([ROUTE, ROUTE_MPP_IN, ...routes].sort());
    expect(Object.keys(loaded.router.dynamic!.profiles).sort()).toEqual(["dyn-mpp-to-x402", "dyn-x402-to-mpp", ...profiles].sort());
    expect(Object.keys(loaded.real?.x402InboundFacilitators ?? {})).toEqual([present]);
    expect(JSON.stringify(document)).not.toContain(absent);
    const buckets = bucketsOf(loaded.router);
    expect(buckets.static.filter((b) => b.startsWith(present))).toHaveLength(1);
    expect(buckets.dynamic.filter((b) => b.startsWith(present))).toHaveLength(1);
    expect(buckets.static.some((b) => b.startsWith(absent))).toBe(false);
  });

  test("MPP 受信の秘密が無い構成でも（経路 2 無し）、有効なレールは出る。x402 送信の鍵は常にある", () => {
    const router = routerOf(routerConfigOf({}, RECEIVER, false, BOTH));
    expect(Object.keys(router.routes).sort()).toEqual([ROUTE, ROUTE_ARC, ROUTE_SOL].sort());
    expect(Object.keys(router.dynamic!.profiles).sort()).toEqual(["dyn-arc-to-mpp", "dyn-arc-to-x402", "dyn-sol-to-mpp", "dyn-sol-to-x402", "dyn-x402-to-mpp"]);
  });

  test("facilitator の kind は表と一致していなければ読み込みで止まる（生成の定数が表とずれたら起動しない）", () => {
    const document = routerConfigOf({}, RECEIVER, true, BOTH);
    const x402 = document["x402"] as { inboundFacilitators: Record<string, { kind: string; url: string }> };
    x402.inboundFacilitators[INBOUND_ARC.network] = { kind: "x402", url: x402.inboundFacilitators[INBOUND_ARC.network]!.url };
    expect(() => loadAsProduction(document)).toThrow(ConfigError);
  });
});

describe("受取先と秘密", () => {
  test.each([
    ["Arc の受取先が無い", { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, receivers: {} }, /arc rail is activated but its receiver address is missing or malformed/],
    ["Arc の受取先の形が違う", { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, receivers: { arc: "0x1234" } }, /arc rail is activated/],
    ["Arc に Solana の address", { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, receivers: { arc: SOL_OWNER } }, /arc rail is activated/],
    ["Solana の受取先が無い", { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, receivers: { arc: ARC_RECEIVER } }, /solana rail is activated but its receiver address is missing or malformed/],
    ["Solana に EVM の address", { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, receivers: { solana: ARC_RECEIVER } }, /solana rail is activated/],
    ["Solana の address に base58 でない文字", { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, receivers: { solana: `${SOL_OWNER.slice(0, -1)}0` } }, /solana rail is activated/],
  ] as const)("%s → 生成しない（値はメッセージに出ない）", (_name, rails, pattern) => {
    let caught: unknown;
    try {
      routerConfigOf({}, RECEIVER, true, rails);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(pattern);
    for (const value of Object.values(rails.receivers)) expect((caught as Error).message).not.toContain(value);
    expect(() => dynamicProfilesOf({}, RECEIVER, true, rails)).toThrow(pattern);
  });

  test("設定に鍵・URL の秘密を埋め込まない（address と公開の facilitator URL だけ）", () => {
    const env = { SUBETHA_ARC_RECEIVER_KEY: `0x${"ab".repeat(32)}`, SUBETHA_OUTBOUND_PRIVATE_KEY: `0x${"cd".repeat(32)}`, SUBETHA_SOLANA_RPC_URL: "https://rpc.example/?api-key=SECRET", SUBETHA_MPP_INBOUND_SECRET: "topsecret" };
    const text = JSON.stringify(routerConfigOf(env, RECEIVER, true, BOTH));
    expect(text).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(text).not.toMatch(/SECRET|topsecret|api-key|rpc\.example/);
    for (const url of text.match(/https?:\/\/[^"]+/g) ?? []) {
      const parsed = new URL(url);
      expect(parsed.username).toBe("");
      expect(parsed.password).toBe("");
      expect(parsed.search).toBe("");
      expect(["https:"]).toContain(parsed.protocol);
    }
  });
});

/** 送信（Arc の Provider へ。送信の設計 §6.1〜§6.3、FR-29・FR-30、D-11〜D-14・D-16。タスク U5）。 */
describe("送信の有効化（Arc）: 方向別の定数と生成", () => {
  // Provider の受取先は受取鍵の address と別の値にする（文書に受取鍵が出ないことを文字列で見るため）。
  const ARC_PROVIDER = "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1";
  const OUT_ONLY: RailsOptions = { activation: { arc: { inbound: false, outbound: true }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, receivers: {}, providers: { arc: ARC_PROVIDER } };

  test("公開の定数は受信 true・送信 true（Arc・Solana とも。G-4′ 2026-10-08）。railActive は方向のどれかで決まる", () => {
    expect(RAILS_ACTIVATION).toEqual({ arc: { inbound: true, outbound: true }, solana: { inbound: true, outbound: true }, solanaMpp: { inbound: true, outbound: true }, pairs: { arcToSol: true, solToArc: true } });
    expect(Object.isFrozen(RAILS_ACTIVATION) && Object.isFrozen(RAILS_ACTIVATION.arc)).toBe(true);
    expect(railActive(RAILS_NONE)).toBe(false);
    expect(railActive({ arc: { inbound: false, outbound: true }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } })).toBe(true);
  });

  test("公開の設定（定数、G-4⁗ の後）: route 10 本（受信 4 + 送信 2 + MPP Solana の受信 2・送信 2）と 20 本のプロファイル（O-5・O-6 の dyn-arc-to-sol・dyn-sol-to-arc を含む。D-17）。送信の受取先が無ければ起動しない", () => {
    const document = routerConfigOf({}, RECEIVER, true, { activation: RAILS_ACTIVATION, receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER }, providers: { arc: ARC_PROVIDER, solana: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d", solanaMpp: "26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc" } });
    const router = routerOf(document);
    expect(Object.keys(router.routes).sort()).toEqual([ROUTE, ROUTE_MPP_IN, ROUTE_ARC, ROUTE_SOL, ROUTE_ARC_OUT, ROUTE_SOL_OUT, ROUTE_SOLMPP_TO_X402, ROUTE_SOLMPP_TO_MPP, ROUTE_SOLMPP_OUT, ROUTE_SOLMPP_OUT_MPP].sort());
    expect(Object.keys(router.dynamic!.profiles).sort()).toEqual(["dyn-arc-to-mpp", "dyn-arc-to-sol", "dyn-arc-to-solmpp", "dyn-arc-to-x402", "dyn-mpp-to-arc", "dyn-mpp-to-sol", "dyn-mpp-to-solmpp", "dyn-mpp-to-x402", "dyn-sol-to-arc", "dyn-sol-to-mpp", "dyn-sol-to-solmpp", "dyn-sol-to-x402", "dyn-solmpp-to-arc", "dyn-solmpp-to-mpp", "dyn-solmpp-to-sol", "dyn-solmpp-to-x402", "dyn-x402-to-arc", "dyn-x402-to-mpp", "dyn-x402-to-sol", "dyn-x402-to-solmpp"]);
    expect(JSON.stringify(document)).toMatch(/dyn-arc-to-sol"/);
    expect(JSON.stringify(document)).toMatch(/dyn-sol-to-arc"/);
    // URL（定数）があるのに受取先が無ければ起動しない（固定文）。Provider D の受取 owner が欠けても同じ。
    expect(() => routerConfigOf({}, RECEIVER, true, { activation: RAILS_ACTIVATION, receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER } })).toThrow();
    expect(() => routerConfigOf({}, RECEIVER, true, { activation: RAILS_ACTIVATION, receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER }, providers: { arc: ARC_PROVIDER, solana: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d" } })).toThrow(/solana mpp outbound rail/);
  });

  test("arc.outbound だけ true（受信は無効）: 動的 dyn-x402-to-arc と（MPP 受信があれば）dyn-mpp-to-arc が出て、受取先の env は読まれず、Arc USDC の区分が静的・動的に出る", () => {
    const document = routerConfigOf({}, RECEIVER, true, OUT_ONLY);
    const loaded = loadAsProduction(document);
    const router = loaded.router;
    expect(Object.keys(router.dynamic!.profiles).sort()).toEqual(["dyn-mpp-to-arc", "dyn-mpp-to-x402", "dyn-x402-to-arc", "dyn-x402-to-mpp"]);
    const toArc = router.dynamic!.profiles["dyn-x402-to-arc"]!;
    expect(toArc).toMatchObject({ sourceRail: "x402", rail: "x402", source: { network: "eip155:84532", payTo: RECEIVER }, destination: { network: OUTBOUND_ARC.network, asset: OUTBOUND_ARC.asset, decimals: 6, tokenDomain: { name: "USDC", version: "2" } }, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } });
    expect(router.dynamic!.profiles["dyn-mpp-to-arc"]).toMatchObject({ sourceRail: "mpp", rail: "x402", source: { network: "eip155:42431", payTo: RECEIVER }, destination: { network: OUTBOUND_ARC.network } });
    // 受信は無効: Arc の受信の route・プロファイル・facilitator は無く、受取先も読まれない。
    expect(router.routes[ROUTE_ARC]).toBeUndefined();
    expect((document["x402"] as Record<string, unknown>)["inboundFacilitators"]).toBeUndefined();
    expect(JSON.stringify(document)).not.toContain(ARC_RECEIVER);
    // 区分は受信か送信のどちらかで出る（FR-29・D-14。静的 1 件 10,000・動的 1 件 20,000）。
    const buckets = bucketsOf(router);
    expect(buckets.static.some((b) => b.startsWith(`${OUTBOUND_ARC.network}|${OUTBOUND_ARC.asset}|10000|`))).toBe(true);
    expect(buckets.dynamic.some((b) => b.startsWith(`${OUTBOUND_ARC.network}|${OUTBOUND_ARC.asset}|20000|`))).toBe(true);
    // MPP 受信が無ければ dyn-mpp-to-arc は出ない。
    expect(Object.keys(routerOf(routerConfigOf({}, RECEIVER, false, OUT_ONLY)).dynamic!.profiles).sort()).toEqual(["dyn-x402-to-arc", "dyn-x402-to-mpp"]);
  });

  test("静的 route md-arc-eth-snapshot は Provider の URL（定数）と受取先（env）がそろったときだけ。定数は配備した Provider の URL（G-1′、2026-10-08）", () => {
    expect(UPSTREAM_ARC).toBe("https://provider-x402-arc.subethalabs.com/v1/eth/snapshot");
    expect(RAIL_UPSTREAMS).toEqual({ arc: UPSTREAM_ARC, solana: "https://provider-x402-sol.subethalabs.com/v1/eth/snapshot", solanaMpp: "https://provider-mpp-sol.subethalabs.com/v1/eth/snapshot" });
    // 本番の定数 + 受取先 → route が出て、上流はその URL。
    const document = routerConfigOf({}, RECEIVER, true, OUT_ONLY);
    expect(routerOf(document).routes[ROUTE_ARC_OUT]).toBeDefined();
    expect((document["x402"] as { upstreams: Record<string, string> }).upstreams[ROUTE_ARC_OUT]).toBe(UPSTREAM_ARC);
    // URL があるのに受取先が無ければ起動しない（固定文。値は出ない）。
    expect(() => routerConfigOf({}, RECEIVER, true, { ...OUT_ONLY, providers: {} })).toThrow();
    // URL が空なら（試験の差し替え）受取先があっても出ないし、受取先が無くても起動する。
    const empty = { arc: "", solana: "", solanaMpp: "" };
    const withoutUrl = routerConfigOf({}, RECEIVER, true, { ...OUT_ONLY, upstreams: empty });
    expect(routerOf(withoutUrl).routes[ROUTE_ARC_OUT]).toBeUndefined();
    expect(Object.keys((withoutUrl["x402"] as { upstreams: Record<string, string> }).upstreams)).not.toContain(ROUTE_ARC_OUT);
    expect(() => routerConfigOf({}, RECEIVER, true, { ...OUT_ONLY, providers: {}, upstreams: empty })).not.toThrow();
  });

  test("Provider の URL が入ると静的 route md-arc-eth-snapshot が出る: Base USDC 10,000 を Router の受取先に払い、Arc USDC で Provider の受取先に届く。上流はその URL。本番の読み込みを通る", () => {
    const ARC_UPSTREAM = "https://provider-arc.test/v1/eth/snapshot";
    const withUrl: RailsOptions = { ...OUT_ONLY, upstreams: { arc: ARC_UPSTREAM, solana: "", solanaMpp: "" } };
    const document = routerConfigOf({}, RECEIVER, true, withUrl);
    const config = loadAsProduction(document);
    const route = config.router.routes[ROUTE_ARC_OUT];
    expect(route).toMatchObject({
      routeId: ROUTE_ARC_OUT,
      canonicalPath: `/v1/routes/${ROUTE_ARC_OUT}/resource`,
      rail: "x402",
      sourceRail: "x402",
      source: { amount: "10000", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, network: "eip155:84532", payTo: RECEIVER },
      destination: { scheme: "exact", network: OUTBOUND_ARC.network, asset: OUTBOUND_ARC.asset, payTo: ARC_PROVIDER },
    });
    expect(config.real?.upstreams[ROUTE_ARC_OUT]).toBe(ARC_UPSTREAM);
    // 既存の route・上流はそのまま。受信は無効なので Arc の受信の route は無い。
    expect(Object.keys(config.router.routes).sort()).toEqual([ROUTE, ROUTE_MPP_IN, ROUTE_ARC_OUT].sort());
    expect(config.real?.upstreams[ROUTE]).toBe(UPSTREAM);
    expect(config.router.routes[ROUTE_ARC]).toBeUndefined();
    // 一覧に出る。
    expect(listedIds(config.router).routes).toContain(ROUTE_ARC_OUT);
    // 区分は静的 1 つ（送信の分。10,000）で、動的と合わせて Arc USDC は各 1 つ。
    const buckets = bucketsOf(config.router);
    expect(buckets.static.filter((b) => b.startsWith(OUTBOUND_ARC.network))).toHaveLength(1);
    // 送信が無効なら URL があっても出ない（受取先も読まない）。
    const off: RailsOptions = { activation: RAILS_NONE, receivers: {}, providers: {}, upstreams: { arc: ARC_UPSTREAM, solana: "", solanaMpp: "" } };
    expect(routerOf(routerConfigOf({}, RECEIVER, true, off)).routes[ROUTE_ARC_OUT]).toBeUndefined();
  });

  test("URL があるのに受取先が無い・形が悪いなら起動しない（固定文。値は出ない）", () => {
    const ARC_UPSTREAM = "https://provider-arc.test/v1/eth/snapshot";
    const message = /arc outbound rail is activated with an upstream URL but the provider pay-to address is missing or malformed/;
    for (const providers of [{}, { arc: "" }, { arc: "not-an-address" }, { arc: ARC_PROVIDER.slice(0, 41) }, { arc: SOL_OWNER }]) {
      const rails: RailsOptions = { ...OUT_ONLY, providers, upstreams: { arc: ARC_UPSTREAM, solana: "", solanaMpp: "" } };
      let caught: unknown;
      try {
        routerConfigOf({}, RECEIVER, true, rails);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(providers)).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(message);
      expect((caught as Error).message).not.toContain("not-an-address");
      expect((caught as Error).message).not.toContain(ARC_UPSTREAM);
    }
  });

  test("受信と送信が両方有効: 受信の route・プロファイルと送信のプロファイルが共存し、Arc USDC の区分は 1 つ（合算）", () => {
    const both: RailsOptions = { activation: { arc: { inbound: true, outbound: true }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, receivers: { arc: ARC_RECEIVER }, providers: { arc: ARC_PROVIDER } };
    const router = loadAsProduction(routerConfigOf({}, RECEIVER, true, both)).router;
    // 静的 route md-arc-eth-snapshot は URL（定数）と受取先がそろったので出る（G-1′）。
    expect(Object.keys(router.routes).sort()).toEqual([ROUTE, ROUTE_MPP_IN, ROUTE_ARC, ROUTE_ARC_OUT].sort());
    expect(Object.keys(router.dynamic!.profiles).sort()).toEqual(["dyn-arc-to-mpp", "dyn-arc-to-x402", "dyn-mpp-to-arc", "dyn-mpp-to-x402", "dyn-x402-to-arc", "dyn-x402-to-mpp"]);
    const buckets = bucketsOf(router);
    expect(buckets.static.filter((b) => b.startsWith(OUTBOUND_ARC.network))).toHaveLength(1);
    expect(buckets.dynamic.filter((b) => b.startsWith(OUTBOUND_ARC.network))).toHaveLength(1);
  });
});

describe("送信の有効化（Solana）: 生成（送信の設計 §6.3、D-12・D-14・D-16。タスク U9）", () => {
  const SOL_PROVIDER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
  const SOL_OUT: RailsOptions = { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: false, outbound: true }, solanaMpp: { inbound: false, outbound: false } }, receivers: {}, providers: { solana: SOL_PROVIDER } };
  const SOL_URL = "https://provider-sol.test/v1/eth/snapshot";

  test("公開の定数は solana.outbound true（G-4′）。URL の定数は配備した Provider（G-1′）。公開の ID は route 10・プロファイル 18（G-4″ の後）で重複なし", () => {
    expect(RAILS_ACTIVATION.solana.outbound).toBe(true);
    expect(UPSTREAM_SOL).toBe("https://provider-x402-sol.subethalabs.com/v1/eth/snapshot");
    expect(RAIL_UPSTREAMS.solana).toBe(UPSTREAM_SOL);
    const router = routerOf(routerConfigOf({}, RECEIVER, true, { activation: RAILS_ACTIVATION, receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER }, providers: { arc: "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1", solana: SOL_PROVIDER, solanaMpp: "26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc" } }));
    const ids = listedIds(router);
    expect(ids.routes).toContain(ROUTE_SOL_OUT);
    expect(ids.profiles).toContain("dyn-x402-to-sol");
    expect(ids.profiles).toContain("dyn-mpp-to-sol");
    expect(ids.routes).toHaveLength(10);
    expect(ids.profiles).toHaveLength(20);
    expect(new Set([...ids.routes, ...ids.profiles]).size).toBe(ids.routes.length + ids.profiles.length);
  });

  test("solana.outbound だけ true: dyn-x402-to-sol と（MPP 受信があれば）dyn-mpp-to-sol が出て、宛先は表の mint・桁・token program（tokenDomain は無い）。Solana USDC の区分が静的・動的に出る。受取 owner は読まれない", () => {
    const document = routerConfigOf({}, RECEIVER, true, SOL_OUT);
    const router = loadAsProduction(document).router;
    const toSol = router.dynamic!.profiles["dyn-x402-to-sol"]!;
    expect(toSol).toMatchObject({ sourceRail: "x402", rail: "x402", source: { network: "eip155:84532", payTo: RECEIVER }, destination: { network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, decimals: 6, tokenProgram: OUTBOUND_SOL.tokenProgram }, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } });
    expect(toSol.destination.tokenDomain).toBeUndefined();
    expect(router.dynamic!.profiles["dyn-mpp-to-sol"]).toMatchObject({ sourceRail: "mpp", rail: "x402", source: { network: "eip155:42431", payTo: RECEIVER }, destination: { network: OUTBOUND_SOL.network } });
    expect(router.routes[ROUTE_SOL]).toBeUndefined();
    expect(router.routes[ROUTE_SOL_OUT]).toBeDefined(); // MPP 受信 ∧ URL（定数。G-1′）∧ 受取先
    expect(routerOf(routerConfigOf({}, RECEIVER, true, { ...SOL_OUT, upstreams: { arc: "", solana: "", solanaMpp: "" } })).routes[ROUTE_SOL_OUT]).toBeUndefined(); // URL が空なら出ない
    expect(JSON.stringify(document)).not.toContain(SOL_OWNER);
    const buckets = bucketsOf(router);
    expect(buckets.static.some((b) => b.startsWith(`${OUTBOUND_SOL.network}|${OUTBOUND_SOL.asset}|10000|`))).toBe(true);
    expect(buckets.dynamic.some((b) => b.startsWith(`${OUTBOUND_SOL.network}|${OUTBOUND_SOL.asset}|21000|`))).toBe(true);
    expect(Object.keys(routerOf(routerConfigOf({}, RECEIVER, false, SOL_OUT)).dynamic!.profiles).sort()).toEqual(["dyn-x402-to-mpp", "dyn-x402-to-sol"]);
  });

  test("静的 route md-sol-eth-snapshot-mpp は MPP 受信 ∧ URL ∧ 受取先（base58 32 バイト）がそろったときだけ: Tempo pathUSD 10,000 を Router の受取先に払い、Solana USDC で Provider の owner に届く。本番の読み込みを通る", () => {
    const withUrl: RailsOptions = { ...SOL_OUT, upstreams: { arc: "", solana: SOL_URL, solanaMpp: "" } };
    const config = loadAsProduction(routerConfigOf({}, RECEIVER, true, withUrl));
    expect(config.router.routes[ROUTE_SOL_OUT]).toMatchObject({
      routeId: ROUTE_SOL_OUT,
      rail: "x402",
      sourceRail: "mpp",
      source: { amount: "10000", network: "eip155:42431", decimals: 6, payTo: RECEIVER },
      destination: { scheme: "exact", network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, payTo: SOL_PROVIDER },
    });
    expect(config.real?.upstreams[ROUTE_SOL_OUT]).toBe(SOL_URL);
    expect(listedIds(config.router).routes).toContain(ROUTE_SOL_OUT);
    // MPP 受信が無ければ URL と受取先があっても出ない（源が無い）。
    expect(routerOf(routerConfigOf({}, RECEIVER, false, withUrl)).routes[ROUTE_SOL_OUT]).toBeUndefined();
    // URL があるのに受取先が無い・形が悪い（0x、33 個の 1）なら起動しない（固定文）。
    for (const providers of [{}, { solana: "" }, { solana: RECEIVER }, { solana: "1".repeat(33) }]) {
      expect(() => routerConfigOf({}, RECEIVER, true, { ...withUrl, providers }), JSON.stringify(providers)).toThrow(/solana outbound rail is activated with an upstream URL but the provider pay-to address is missing or malformed/);
    }
    // 送信が無効なら出ない。
    expect(routerOf(routerConfigOf({}, RECEIVER, true, { activation: RAILS_NONE, receivers: {}, providers: { solana: SOL_PROVIDER }, upstreams: { arc: "", solana: SOL_URL, solanaMpp: "" } })).routes[ROUTE_SOL_OUT]).toBeUndefined();
  });

  test("受信と送信が両方有効（Solana）: 受信の route・プロファイルと送信のプロファイルが共存し、Solana USDC の区分は 1 つ（合算）。4 本の送信が同時に出ても公開 ID は 6 + 6", () => {
    // URL の定数が入ったので（G-1′）、送信が有効なら両レールの受取先が要る。
    const both: RailsOptions = { activation: { arc: { inbound: true, outbound: true }, solana: { inbound: true, outbound: true }, solanaMpp: { inbound: false, outbound: false } }, receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER }, providers: { arc: "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1", solana: SOL_PROVIDER } };
    const router = loadAsProduction(routerConfigOf({}, RECEIVER, true, both)).router;
    expect(listedIds(router).profiles).toEqual(["dyn-arc-to-mpp", "dyn-arc-to-x402", "dyn-mpp-to-arc", "dyn-mpp-to-sol", "dyn-mpp-to-x402", "dyn-sol-to-mpp", "dyn-sol-to-x402", "dyn-x402-to-arc", "dyn-x402-to-mpp", "dyn-x402-to-sol"]);
    const buckets = bucketsOf(router);
    expect(buckets.static.filter((b) => b.startsWith(OUTBOUND_SOL.network))).toHaveLength(1);
    expect(buckets.dynamic.filter((b) => b.startsWith(OUTBOUND_SOL.network))).toHaveLength(1);
  });
});

/** Solana の MPP（受信・送信）の生成（`docs/mpp-solana-design.md` §6.1・§6.3、FR-40・FR-42・FR-43。タスク M6）。 */
describe("Solana の MPP の有効化（solanaMpp）: 生成（設計 §6.3）", () => {
  const SOL_PROVIDER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
  const SOL_MPP_PROVIDER = "4LrBc1whdzuLzk7qgo6y5JEgHtyhgNoPpzPpHebaJ5oM";
  const ARC_PROVIDER = "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1";
  const OFF = { inbound: false, outbound: false };
  const IN = { inbound: true, outbound: false };
  const OUT = { inbound: false, outbound: true };
  const SOL_MPP_URL = "https://provider-solmpp.test/v1/eth/snapshot";
  const SOLMPP_DEST = { scheme: "solana/charge", network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, decimals: 6, tokenProgram: OUTBOUND_SOL.tokenProgram };

  test("公開の定数: solanaMpp は両方 true（G-4″、2026-10-08）、UPSTREAM_SOL_MPP は配備した Provider D の URL（G-1″）。railActive は solanaMpp だけでも true。公開の設定は route 10・プロファイル 18 で、solmpp の 4 本と 8 本を含む", () => {
    expect(RAILS_ACTIVATION.solanaMpp).toEqual({ inbound: true, outbound: true });
    expect(Object.isFrozen(RAILS_ACTIVATION.solanaMpp)).toBe(true);
    expect(RAILS_NONE.solanaMpp).toEqual(OFF);
    expect(UPSTREAM_SOL_MPP).toBe("https://provider-mpp-sol.subethalabs.com/v1/eth/snapshot");
    expect(RAIL_UPSTREAMS.solanaMpp).toBe(UPSTREAM_SOL_MPP);
    expect(railActive({ arc: OFF, solana: OFF, solanaMpp: IN })).toBe(true);
    expect(railActive({ arc: OFF, solana: OFF, solanaMpp: OUT })).toBe(true);
    expect(railActive(RAILS_NONE)).toBe(false);
    const router = routerOf(routerConfigOf({}, RECEIVER, true, { activation: RAILS_ACTIVATION, receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER }, providers: { arc: ARC_PROVIDER, solana: SOL_PROVIDER, solanaMpp: SOL_MPP_PROVIDER } }));
    const ids = listedIds(router);
    expect(ids.routes).toHaveLength(10);
    expect(ids.profiles).toHaveLength(20);
    expect(ids.routes.filter((r) => r.includes("solmpp"))).toEqual(["md-mpp-eth-snapshot-solmpp", "md-solmpp-eth-snapshot", "md-solmpp-eth-snapshot-mpp", "md-x402-eth-snapshot-solmpp"]);
    expect(ids.profiles.filter((p) => p.includes("solmpp"))).toHaveLength(8);
    expect(router.routes[ROUTE_SOLMPP_OUT]?.destination.payTo).toBe(SOL_MPP_PROVIDER);
  });

  test("solanaMpp.inbound だけ: 静的 md-x402-eth-snapshot-solmpp・md-mpp-eth-snapshot-solmpp（source は solana の受取 owner、sourceRail mpp）、動的 dyn-solmpp-to-x402・dyn-solmpp-to-mpp。x402 の Solana 受信（md-x402-eth-snapshot-sol・dyn-sol-to-*・facilitator）は出ない。Solana USDC の区分が出る。本番の読み込みを通る", () => {
    const rails: RailsOptions = { activation: { arc: OFF, solana: OFF, solanaMpp: IN }, receivers: { solana: SOL_OWNER } };
    const document = routerConfigOf({}, RECEIVER, true, rails);
    const loaded = loadAsProduction(document);
    const router = loaded.router;
    expect(Object.keys(router.routes).sort()).toEqual([ROUTE, ROUTE_MPP_IN, ROUTE_SOLMPP_TO_MPP, ROUTE_SOLMPP_TO_X402].sort());
    expect(Object.keys(router.dynamic!.profiles).sort()).toEqual(["dyn-mpp-to-x402", "dyn-solmpp-to-mpp", "dyn-solmpp-to-x402", "dyn-x402-to-mpp"]);
    expect(ROUTE_SOLMPP_TO_X402).toBe("md-x402-eth-snapshot-solmpp");
    expect(ROUTE_SOLMPP_TO_MPP).toBe("md-mpp-eth-snapshot-solmpp");
    expect(router.routes[ROUTE_SOLMPP_TO_X402]).toMatchObject({
      rail: "x402",
      sourceRail: "mpp",
      canonicalPath: "/v1/routes/md-x402-eth-snapshot-solmpp/resource",
      source: { amount: "10000", asset: INBOUND_SOL.asset, decimals: 6, network: INBOUND_SOL.network, payTo: SOL_OWNER },
      destination: { scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1" },
    });
    expect(router.routes[ROUTE_SOLMPP_TO_MPP]).toMatchObject({
      rail: "mpp",
      sourceRail: "mpp",
      canonicalPath: "/v1/routes/md-mpp-eth-snapshot-solmpp/resource",
      source: { amount: "10000", asset: INBOUND_SOL.asset, decimals: 6, network: INBOUND_SOL.network, payTo: SOL_OWNER },
      destination: { scheme: "tempo/charge", network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1" },
    });
    expect(router.dynamic!.profiles["dyn-solmpp-to-x402"]).toMatchObject({ sourceRail: "mpp", rail: "x402", par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" }, source: { network: INBOUND_SOL.network, asset: INBOUND_SOL.asset, decimals: 6, payTo: SOL_OWNER }, destination: { scheme: "exact", network: "eip155:84532", tokenDomain: { name: "USDC", version: "2" } } });
    expect(router.dynamic!.profiles["dyn-solmpp-to-mpp"]).toMatchObject({ sourceRail: "mpp", rail: "mpp", source: { network: INBOUND_SOL.network, payTo: SOL_OWNER }, destination: { scheme: "tempo/charge", feeAsset: "0x20c0000000000000000000000000000000000000", maxFee: "50000", feeMargin: 20_000 } });
    // x402 の Solana 受信は出ない（受取 owner があるだけでは出ない: 述語が別）。
    expect(router.routes[ROUTE_SOL]).toBeUndefined();
    expect(router.dynamic!.profiles["dyn-sol-to-x402"]).toBeUndefined();
    expect(router.dynamic!.profiles["dyn-sol-to-mpp"]).toBeUndefined();
    expect(loaded.real?.x402InboundFacilitators).toBeUndefined();
    // 上流: 受信 2 本は Provider A・B の URL。
    expect(loaded.real?.upstreams[ROUTE_SOLMPP_TO_X402]).toBe(UPSTREAM_X402);
    expect(loaded.real?.upstreams[ROUTE_SOLMPP_TO_MPP]).toBe(UPSTREAM);
    // Solana USDC の区分（静的 10,000・動的 20,000）が 1 つずつ。
    const buckets = bucketsOf(router);
    expect(buckets.static.filter((b) => b.startsWith(`${INBOUND_SOL.network}|${INBOUND_SOL.asset}|10000|`))).toHaveLength(1);
    expect(buckets.dynamic.filter((b) => b.startsWith(`${INBOUND_SOL.network}|${INBOUND_SOL.asset}|21000|`))).toHaveLength(1);
    expect(buckets.static.some((b) => b.startsWith(INBOUND_ARC.network))).toBe(false);
    // 公開の一覧に出る。
    expect(listedIds(router).routes).toContain(ROUTE_SOLMPP_TO_X402);
    expect(listedIds(router).routes).toContain(ROUTE_SOLMPP_TO_MPP);
    // 受取 owner が無い・形が悪ければ起動しない（固定文。値は出ない）。
    for (const receivers of [{}, { solana: "" }, { solana: RECEIVER }, { solana: "1".repeat(33) }]) {
      expect(() => routerConfigOf({}, RECEIVER, true, { ...rails, receivers }), JSON.stringify(receivers)).toThrow(/solana mpp rail is activated but its receiver address is missing or malformed/);
    }
    // MPP 受信（Tempo）の秘密が無い構成: Tempo 宛の静的 route は出るが（Provider B は Tempo の送信）、動的の Tempo 宛は MPP_OUTBOUND_PROFILE_ENABLED だけで決まる。
    const noTempo = routerOf(routerConfigOf({}, RECEIVER, false, rails));
    expect(Object.keys(noTempo.routes).sort()).toEqual([ROUTE, ROUTE_SOLMPP_TO_MPP, ROUTE_SOLMPP_TO_X402].sort());
    expect(Object.keys(noTempo.dynamic!.profiles).sort()).toEqual(["dyn-solmpp-to-mpp", "dyn-solmpp-to-x402", "dyn-x402-to-mpp"]);
  });

  test("solanaMpp.inbound と Arc・Solana の送信: dyn-solmpp-to-arc は arc.outbound、dyn-solmpp-to-sol は solana.outbound のときだけ", () => {
    const base: RailsOptions = { activation: { arc: OFF, solana: OFF, solanaMpp: IN }, receivers: { solana: SOL_OWNER }, upstreams: { arc: "", solana: "", solanaMpp: "" } };
    expect(Object.keys(routerOf(routerConfigOf({}, RECEIVER, true, base)).dynamic!.profiles)).not.toContain("dyn-solmpp-to-arc");
    const withArc = routerOf(routerConfigOf({}, RECEIVER, true, { ...base, activation: { arc: OUT, solana: OFF, solanaMpp: IN } }));
    expect(withArc.dynamic!.profiles["dyn-solmpp-to-arc"]).toMatchObject({ sourceRail: "mpp", rail: "x402", source: { network: INBOUND_SOL.network, payTo: SOL_OWNER }, destination: { scheme: "exact", network: OUTBOUND_ARC.network, asset: OUTBOUND_ARC.asset, tokenDomain: { name: "USDC", version: "2" } } });
    expect(withArc.dynamic!.profiles["dyn-solmpp-to-sol"]).toBeUndefined();
    const withSol = routerOf(routerConfigOf({}, RECEIVER, true, { ...base, activation: { arc: OFF, solana: OUT, solanaMpp: IN } }));
    expect(withSol.dynamic!.profiles["dyn-solmpp-to-sol"]).toMatchObject({ sourceRail: "mpp", rail: "x402", source: { network: INBOUND_SOL.network, payTo: SOL_OWNER }, destination: { scheme: "exact", network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, tokenProgram: OUTBOUND_SOL.tokenProgram } });
    expect(withSol.dynamic!.profiles["dyn-solmpp-to-arc"]).toBeUndefined();
    // 同じ Solana USDC の区分は 1 つ（受信の MPP と送信の x402 が合算）。
    expect(bucketsOf(withSol).static.filter((b) => b.startsWith(INBOUND_SOL.network))).toHaveLength(1);
    expect(bucketsOf(withSol).dynamic.filter((b) => b.startsWith(INBOUND_SOL.network))).toHaveLength(1);
  });

  test("solanaMpp.outbound だけ: dyn-x402-to-solmpp と（MPP 受信があれば）dyn-mpp-to-solmpp。宛先は solana/charge・表の mint・桁・token program、feeAsset・maxFee・feeMargin は無い。手数料は MPP 送信の規則。静的 route は URL が空（定数）なので出ず、受取 owner は読まれない。Solana USDC の区分が出る", () => {
    // URL は空にして動的プロファイルだけを見る（本番の定数は G-1″ で Provider D の URL に入ったので、既定のままだと静的 route も出る: 次の行）。
    const rails: RailsOptions = { activation: { arc: OFF, solana: OFF, solanaMpp: OUT }, receivers: {}, providers: { solanaMpp: SOL_MPP_PROVIDER }, upstreams: { arc: "", solana: "", solanaMpp: "" } };
    const document = routerConfigOf({}, RECEIVER, true, rails);
    const router = loadAsProduction(document).router;
    expect(Object.keys(router.routes).sort()).toEqual([ROUTE, ROUTE_MPP_IN].sort());
    expect(Object.keys(router.dynamic!.profiles).sort()).toEqual(["dyn-mpp-to-solmpp", "dyn-mpp-to-x402", "dyn-x402-to-mpp", "dyn-x402-to-solmpp"]);
    const toSolMpp = router.dynamic!.profiles["dyn-x402-to-solmpp"]!;
    expect(toSolMpp).toMatchObject({ sourceRail: "x402", rail: "mpp", par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" }, source: { network: "eip155:84532", asset: INBOUND.asset, decimals: 6, payTo: RECEIVER }, destination: SOLMPP_DEST });
    expect(toSolMpp.destination.feeAsset).toBeUndefined();
    expect(toSolMpp.destination.maxFee).toBeUndefined();
    expect(toSolMpp.destination.feeMargin).toBeUndefined();
    expect(toSolMpp.destination.tokenDomain).toBeUndefined();
    expect(router.dynamic!.profiles["dyn-mpp-to-solmpp"]).toMatchObject({ sourceRail: "mpp", rail: "mpp", source: { network: "eip155:42431", payTo: RECEIVER }, destination: SOLMPP_DEST });
    expect(JSON.stringify(document)).not.toContain(SOL_OWNER);
    expect(JSON.stringify(document)).not.toContain(SOL_MPP_PROVIDER); // URL が空なので Provider D の受取 owner は設定に入らない
    const buckets = bucketsOf(router);
    expect(buckets.static.filter((b) => b.startsWith(`${OUTBOUND_SOL.network}|${OUTBOUND_SOL.asset}|10000|`))).toHaveLength(1);
    expect(buckets.dynamic.filter((b) => b.startsWith(`${OUTBOUND_SOL.network}|${OUTBOUND_SOL.asset}|21000|`))).toHaveLength(1);
    expect(Object.keys(routerOf(routerConfigOf({}, RECEIVER, false, rails)).dynamic!.profiles).sort()).toEqual(["dyn-x402-to-mpp", "dyn-x402-to-solmpp"]);
    // Arc・Solana の x402 受信があれば dyn-arc-to-solmpp・dyn-sol-to-solmpp も（source はそのレールの受取先）。
    const withInbound = routerOf(routerConfigOf({}, RECEIVER, true, { ...rails, activation: { arc: IN, solana: IN, solanaMpp: OUT }, receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER } }));
    expect(withInbound.dynamic!.profiles["dyn-arc-to-solmpp"]).toMatchObject({ sourceRail: "x402", rail: "mpp", source: { network: INBOUND_ARC.network, asset: INBOUND_ARC.asset, payTo: ARC_RECEIVER }, destination: SOLMPP_DEST });
    expect(withInbound.dynamic!.profiles["dyn-sol-to-solmpp"]).toMatchObject({ sourceRail: "x402", rail: "mpp", source: { network: INBOUND_SOL.network, asset: INBOUND_SOL.asset, payTo: SOL_OWNER }, destination: SOLMPP_DEST });
    expect(bucketsOf(withInbound).static.filter((b) => b.startsWith(INBOUND_SOL.network))).toHaveLength(1);
  });

  test("静的 route md-solmpp-eth-snapshot（Base x402 → Provider D）と md-solmpp-eth-snapshot-mpp（Tempo MPP → Provider D。MPP 受信があるとき）は URL ∧ 受取 owner（base58 32 バイト）がそろったときだけ。上流は Provider D の URL。本番の読み込みを通る", () => {
    const withUrl: RailsOptions = { activation: { arc: OFF, solana: OFF, solanaMpp: OUT }, receivers: {}, providers: { solanaMpp: SOL_MPP_PROVIDER }, upstreams: { arc: "", solana: "", solanaMpp: SOL_MPP_URL } };
    const config = loadAsProduction(routerConfigOf({}, RECEIVER, true, withUrl));
    expect(ROUTE_SOLMPP_OUT).toBe("md-solmpp-eth-snapshot");
    expect(ROUTE_SOLMPP_OUT_MPP).toBe("md-solmpp-eth-snapshot-mpp");
    expect(config.router.routes[ROUTE_SOLMPP_OUT]).toMatchObject({
      routeId: ROUTE_SOLMPP_OUT,
      canonicalPath: "/v1/routes/md-solmpp-eth-snapshot/resource",
      rail: "mpp",
      sourceRail: "x402",
      source: { amount: "10000", network: "eip155:84532", asset: INBOUND.asset, decimals: 6, payTo: RECEIVER },
      destination: { scheme: "solana/charge", network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, payTo: SOL_MPP_PROVIDER },
    });
    expect(config.router.routes[ROUTE_SOLMPP_OUT_MPP]).toMatchObject({
      routeId: ROUTE_SOLMPP_OUT_MPP,
      canonicalPath: "/v1/routes/md-solmpp-eth-snapshot-mpp/resource",
      rail: "mpp",
      sourceRail: "mpp",
      source: { amount: "10000", network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", decimals: 6, payTo: RECEIVER },
      destination: { scheme: "solana/charge", network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, payTo: SOL_MPP_PROVIDER },
    });
    expect(config.real?.upstreams[ROUTE_SOLMPP_OUT]).toBe(SOL_MPP_URL);
    expect(config.real?.upstreams[ROUTE_SOLMPP_OUT_MPP]).toBe(SOL_MPP_URL);
    expect(listedIds(config.router).routes).toEqual(expect.arrayContaining([ROUTE_SOLMPP_OUT, ROUTE_SOLMPP_OUT_MPP]));
    // MPP 受信が無ければ Tempo → Provider D は出ない（源が無い）。Base → Provider D は出る。
    const noTempo = routerOf(routerConfigOf({}, RECEIVER, false, withUrl));
    expect(noTempo.routes[ROUTE_SOLMPP_OUT]).toBeDefined();
    expect(noTempo.routes[ROUTE_SOLMPP_OUT_MPP]).toBeUndefined();
    expect(Object.keys(routerConfigOf({}, RECEIVER, false, withUrl)["x402"] as Record<string, unknown>)).toEqual(["upstreams"]);
    expect(((routerConfigOf({}, RECEIVER, false, withUrl)["x402"] as { upstreams: Record<string, string> }).upstreams)[ROUTE_SOLMPP_OUT_MPP]).toBeUndefined();
    // URL があるのに受取 owner が無い・形が悪い（0x、33 個の 1）なら起動しない（固定文）。
    for (const providers of [{}, { solanaMpp: "" }, { solanaMpp: RECEIVER }, { solanaMpp: "1".repeat(33) }, { solana: SOL_PROVIDER }]) {
      expect(() => routerConfigOf({}, RECEIVER, true, { ...withUrl, providers }), JSON.stringify(providers)).toThrow(/solana mpp outbound rail is activated with an upstream URL but the provider pay-to address is missing or malformed/);
    }
    // 送信が無効なら URL と受取 owner があっても出ない。
    expect(routerOf(routerConfigOf({}, RECEIVER, true, { ...withUrl, activation: RAILS_NONE })).routes[ROUTE_SOLMPP_OUT]).toBeUndefined();
    // x402 の Solana 送信（solana.outbound）の受取先は別の欄（Provider D の受取 owner で x402 の静的 route は出ない）。
    const x402Sol = routerOf(routerConfigOf({}, RECEIVER, true, { ...withUrl, activation: { arc: OFF, solana: OUT, solanaMpp: OFF }, upstreams: { arc: "", solana: "", solanaMpp: SOL_MPP_URL } }));
    expect(x402Sol.routes[ROUTE_SOLMPP_OUT]).toBeUndefined();
    expect(x402Sol.routes[ROUTE_SOL_OUT]).toBeUndefined();
  });

  test("4 方向すべて有効（x402 と MPP の Solana、Arc も）: 公開 ID は route 6 + 4、プロファイル 10 + 8 で重複なし。Solana USDC の区分は 1 つ（4 つの向きが合算）。Provider D の URL が空なら静的の送信 2 本は無い", () => {
    const all: RailsOptions = {
      activation: { arc: { inbound: true, outbound: true }, solana: { inbound: true, outbound: true }, solanaMpp: { inbound: true, outbound: true } },
      receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER },
      providers: { arc: ARC_PROVIDER, solana: SOL_PROVIDER, solanaMpp: SOL_MPP_PROVIDER },
      upstreams: { arc: UPSTREAM_ARC, solana: UPSTREAM_SOL, solanaMpp: SOL_MPP_URL },
    };
    const router = loadAsProduction(routerConfigOf({}, RECEIVER, true, all)).router;
    const ids = listedIds(router);
    expect(ids.routes).toEqual(["md-arc-eth-snapshot", "md-mpp-eth-snapshot", "md-mpp-eth-snapshot-arc", "md-mpp-eth-snapshot-solmpp", "md-sol-eth-snapshot-mpp", "md-solmpp-eth-snapshot", "md-solmpp-eth-snapshot-mpp", "md-x402-eth-snapshot", "md-x402-eth-snapshot-sol", "md-x402-eth-snapshot-solmpp"]);
    expect(ids.profiles).toEqual([
      "dyn-arc-to-mpp", "dyn-arc-to-solmpp", "dyn-arc-to-x402",
      "dyn-mpp-to-arc", "dyn-mpp-to-sol", "dyn-mpp-to-solmpp", "dyn-mpp-to-x402",
      "dyn-sol-to-mpp", "dyn-sol-to-solmpp", "dyn-sol-to-x402",
      "dyn-solmpp-to-arc", "dyn-solmpp-to-mpp", "dyn-solmpp-to-sol", "dyn-solmpp-to-x402",
      "dyn-x402-to-arc", "dyn-x402-to-mpp", "dyn-x402-to-sol", "dyn-x402-to-solmpp",
    ]);
    expect(new Set([...ids.routes, ...ids.profiles]).size).toBe(ids.routes.length + ids.profiles.length);
    const buckets = bucketsOf(router);
    expect(buckets.static.filter((b) => b.startsWith(OUTBOUND_SOL.network))).toHaveLength(1);
    expect(buckets.dynamic.filter((b) => b.startsWith(OUTBOUND_SOL.network))).toHaveLength(1);
    // 公開の定数の URL（G-1″ で Provider D の URL が入った）: 受取 owner があれば静的の送信 2 本も出て 10 本、無ければ起動しない。
    const production = routerOf(routerConfigOf({}, RECEIVER, true, { ...all, upstreams: RAIL_UPSTREAMS }));
    expect(Object.keys(production.routes)).toHaveLength(10);
    expect(production.routes[ROUTE_SOLMPP_OUT]?.destination.payTo).toBe(SOL_MPP_PROVIDER);
    expect(Object.keys(production.dynamic!.profiles)).toHaveLength(18);
    expect(() => routerConfigOf({}, RECEIVER, true, { ...all, providers: { arc: ARC_PROVIDER, solana: SOL_PROVIDER }, upstreams: RAIL_UPSTREAMS })).toThrow(/solana mpp outbound rail is activated with an upstream URL/);
  });

  test("動的予算の 1 件の上限: 本番の 20 プロファイル（組 O-5・O-6 を含む）すべてで上限額（上流 10,000）の quote が区分の上限に収まる。両レグが同じ Solana USDC の区分に落ちる dyn-solmpp-to-sol・dyn-sol-to-solmpp は 21,000 ちょうど（1 base unit 上回ると per_purchase_limit）。他の区分は 20,000 のまま", () => {
    const all: RailsOptions = {
      activation: { arc: { inbound: true, outbound: true }, solana: { inbound: true, outbound: true }, solanaMpp: { inbound: true, outbound: true }, pairs: { arcToSol: true, solToArc: true } },
      receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER },
      providers: { arc: ARC_PROVIDER, solana: SOL_PROVIDER, solanaMpp: SOL_MPP_PROVIDER },
      upstreams: RAIL_UPSTREAMS,
    };
    const router = routerOf(routerConfigOf({}, RECEIVER, true, all));
    const profiles = Object.values(router.dynamic!.profiles);
    expect(profiles).toHaveLength(20);
    expect(profiles.map((profile) => profile.profileId)).toEqual(expect.arrayContaining(["dyn-arc-to-sol", "dyn-sol-to-arc"]));
    // 上限額の quote の予約が、どのプロファイルでも 1 件の上限に収まる。Tempo 宛の MPP は gas の見積りが cap になる
    // （G-3″ の実測は 158 base unit。規則の手数料 1,000 以下なら手数料はそのまま）。cap が規則の手数料を超えれば源のレグがその分増え、
    // 上流 10,000 のとき cap が 10,000 を超えると Tempo の区分の 20,000 を超えて `per_purchase_limit`（天井 50,000 の `fee_too_high` より先）。
    // 本行は cap = 規則の手数料の前提での収まりを見る（gas の cap の範囲は本行の対象ではない）。
    const reservationAt = (profile: (typeof profiles)[number], upstreamAmount: string) => {
      const cap = profile.destination.maxFee === undefined ? undefined : { maxFee: profile.fee.flat, estimate: { gas: "1", maxFeePerGas: "1", bound: "1", atMs: 0 } };
      const pricing = priceOf(profile, upstreamAmount, cap);
      expect(pricing, profile.profileId).toBeDefined();
      return reservationOf(profile, pricing!);
    };
    for (const profile of profiles) {
      expect(perPurchaseLimitOf(router, reservationAt(profile, profile.maxUpstreamAmount)), profile.profileId).toBeUndefined();
    }
    // 同じ区分を両レグで使う 2 組: 源 11,000 + 宛先 10,000 = 21,000 が上限ちょうど。上流が 1 base unit 増えると両レグで 2 増えて止まる。
    const sameBucket = profiles.filter((profile) => profile.source.network === profile.destination.network && profile.source.asset === profile.destination.asset);
    expect(sameBucket.map((profile) => profile.profileId).sort()).toEqual(["dyn-sol-to-solmpp", "dyn-solmpp-to-sol"]);
    for (const profile of sameBucket) {
      const legs = reservationAt(profile, profile.maxUpstreamAmount).legs;
      expect(legs.reduce((sum, leg) => sum + BigInt(leg.amount), 0n)).toBe(21_000n);
      expect(perPurchaseLimitOf(router, reservationAt(profile, "10001")), profile.profileId).toBe("per_purchase_limit");
    }
    const dynamicBuckets = router.dynamic!.budget.buckets;
    expect(dynamicBuckets.find((bucket) => bucket.network === INBOUND_SOL.network && bucket.asset === INBOUND_SOL.asset)?.maxPerPurchase).toBe("21000");
    for (const bucket of dynamicBuckets.filter((bucket) => bucket.network !== INBOUND_SOL.network)) expect(bucket.maxPerPurchase, bucket.network).toBe("20000");
    // 静的の予算は変えない（静的 route は片レグ 10,000 のまま）。
    for (const bucket of router.budget.buckets) expect(bucket.maxPerPurchase, bucket.network).toBe("10000");
  });
});

/** O-5・O-6（Arc x402 ↔ Solana x402）の組（送信の要件 §11 FR-39〜FR-43・AC-19、設計 §13。D-17 の決定 2026-10-09）。 */
describe("O-5・O-6: 組の切り替え pairs と dyn-arc-to-sol・dyn-sol-to-arc の生成", () => {
  const ARC_PROVIDER = "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1";
  const SOL_PROVIDER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
  const SOL_MPP_PROVIDER = "4LrBc1whdzuLzk7qgo6y5JEgHtyhgNoPpzPpHebaJ5oM";
  const FULL: RailsActivation = { arc: { inbound: true, outbound: true }, solana: { inbound: true, outbound: true }, solanaMpp: { inbound: true, outbound: true } };
  const optionsOf = (pairs: PairsActivation | undefined, activation: RailsActivation = FULL, receivers: RailsOptions["receivers"] = { arc: ARC_RECEIVER, solana: SOL_OWNER }): RailsOptions => ({
    activation: { ...activation, ...(pairs === undefined ? {} : { pairs }) },
    receivers,
    providers: { arc: ARC_PROVIDER, solana: SOL_PROVIDER, solanaMpp: SOL_MPP_PROVIDER },
    upstreams: RAIL_UPSTREAMS,
  });
  const EIGHTEEN = ["dyn-arc-to-mpp", "dyn-arc-to-solmpp", "dyn-arc-to-x402", "dyn-mpp-to-arc", "dyn-mpp-to-sol", "dyn-mpp-to-solmpp", "dyn-mpp-to-x402", "dyn-sol-to-mpp", "dyn-sol-to-solmpp", "dyn-sol-to-x402", "dyn-solmpp-to-arc", "dyn-solmpp-to-mpp", "dyn-solmpp-to-sol", "dyn-solmpp-to-x402", "dyn-x402-to-arc", "dyn-x402-to-mpp", "dyn-x402-to-sol", "dyn-x402-to-solmpp"];

  test("pairs 両方 true: 20 本（18 本 + dyn-arc-to-sol + dyn-sol-to-arc）。route は 10 本のまま。本番の読み込みを通り、一覧に出る", () => {
    const document = routerConfigOf({}, RECEIVER, true, optionsOf({ arcToSol: true, solToArc: true }));
    const loaded = loadAsProduction(document);
    expect(Object.keys(loaded.router.dynamic!.profiles).sort()).toEqual([...EIGHTEEN, "dyn-arc-to-sol", "dyn-sol-to-arc"].sort());
    expect(Object.keys(loaded.router.routes)).toHaveLength(10);
    const ids = listedIds(loaded.router);
    expect(ids.profiles).toHaveLength(20);
    expect(ids.profiles).toEqual(expect.arrayContaining(["dyn-arc-to-sol", "dyn-sol-to-arc"]));
    expect(new Set([...ids.routes, ...ids.profiles]).size).toBe(30);
  });

  test.each([
    ["arcToSol だけ", { arcToSol: true, solToArc: false }, "dyn-arc-to-sol", "dyn-sol-to-arc"],
    ["solToArc だけ", { arcToSol: false, solToArc: true }, "dyn-sol-to-arc", "dyn-arc-to-sol"],
  ] as const)("%s true: 19 本で、足されるのはその 1 本だけ（方向は結合していない）", (_name, pairs, present, absent) => {
    const document = routerConfigOf({}, RECEIVER, true, optionsOf(pairs));
    const ids = Object.keys(routerOf(document).dynamic!.profiles).sort();
    expect(ids).toEqual([...EIGHTEEN, present].sort());
    expect(JSON.stringify(document)).not.toContain(`${absent}"`);
  });

  test("pairs 両方 false、または無し（G-2⁗ の配備の形）: 18 本のまま。ID は文書に出ない。公開の定数（G-4⁗）は 20 本", () => {
    for (const pairs of [{ arcToSol: false, solToArc: false }, undefined]) {
      const document = routerConfigOf({}, RECEIVER, true, optionsOf(pairs));
      expect(Object.keys(routerOf(document).dynamic!.profiles).sort()).toEqual(EIGHTEEN);
      expect(JSON.stringify(document)).not.toMatch(/dyn-arc-to-sol"|dyn-sol-to-arc"/);
    }
    // 公開の定数は G-4⁗ で両方 true → 20 本。false の固定の構成（上）が 18 本の対照。
    expect(Object.keys(routerOf(routerConfigOf({}, RECEIVER, true, optionsOf(RAILS_ACTIVATION.pairs, RAILS_ACTIVATION))).dynamic!.profiles)).toHaveLength(20);
  });

  test.each([
    ["arc-to-sol で arc.inbound が無い（受取先無し）", { arcToSol: true, solToArc: false }, { ...FULL, arc: { inbound: false, outbound: true } }, { solana: SOL_OWNER }, /pair arc-to-sol requires arc\.inbound/],
    ["arc-to-sol で solana.outbound が無い", { arcToSol: true, solToArc: false }, { ...FULL, solana: { inbound: true, outbound: false } }, { arc: ARC_RECEIVER, solana: SOL_OWNER }, /pair arc-to-sol requires/],
    ["sol-to-arc で solana.inbound が無い（受取 owner 無し）", { arcToSol: false, solToArc: true }, { ...FULL, solana: { inbound: false, outbound: true }, solanaMpp: { inbound: false, outbound: true } }, { arc: ARC_RECEIVER }, /pair sol-to-arc requires solana\.inbound/],
    ["sol-to-arc で arc.outbound が無い", { arcToSol: false, solToArc: true }, { ...FULL, arc: { inbound: true, outbound: false } }, { arc: ARC_RECEIVER, solana: SOL_OWNER }, /pair sol-to-arc requires/],
  ] as const)("%s → 固定文で止まる（黙って出さない、はしない。値は出ない）", (_name, pairs, activation, receivers, pattern) => {
    let caught: unknown;
    try {
      routerConfigOf({}, RECEIVER, true, optionsOf(pairs, activation, receivers));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(pattern);
    expect((caught as Error).message).not.toContain(ARC_RECEIVER);
    expect((caught as Error).message).not.toContain(SOL_OWNER);
    expect(() => dynamicProfilesOf({}, RECEIVER, true, optionsOf(pairs, activation, receivers))).toThrow(pattern);
  });

  test("生成の中身: dyn-arc-to-sol は Arc USDC（受取鍵の address）→ Solana の表の mint・桁・token program（tokenDomain は無い）、dyn-sol-to-arc は Solana USDC（受取 owner）→ Arc の表の asset と tokenDomain。par 1:1、上流 10,000、手数料 定額 1,000、sourceRail x402", () => {
    const router = routerOf(routerConfigOf({}, RECEIVER, true, optionsOf({ arcToSol: true, solToArc: true })));
    const arcToSol = router.dynamic!.profiles["dyn-arc-to-sol"]!;
    const solToArc = router.dynamic!.profiles["dyn-sol-to-arc"]!;
    expect(arcToSol).toMatchObject({ profileId: "dyn-arc-to-sol", sourceRail: "x402", rail: "x402", par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" }, source: { network: INBOUND_ARC.network, asset: INBOUND_ARC.asset, decimals: 6, payTo: ARC_RECEIVER }, destination: { scheme: "exact", network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, decimals: 6, tokenProgram: OUTBOUND_SOL.tokenProgram } });
    expect(arcToSol.destination).not.toHaveProperty("tokenDomain");
    expect(arcToSol.destination).not.toHaveProperty("maxFee");
    expect(solToArc).toMatchObject({ profileId: "dyn-sol-to-arc", sourceRail: "x402", rail: "x402", par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" }, source: { network: INBOUND_SOL.network, asset: INBOUND_SOL.asset, decimals: 6, payTo: SOL_OWNER }, destination: { scheme: "exact", network: INBOUND_ARC.network, asset: INBOUND_ARC.asset, decimals: 6, tokenDomain: { name: "USDC", version: "2" } } });
    expect(solToArc.destination).not.toHaveProperty("tokenProgram");
    // 予算（FR-42）: 新しい区分は無い。O-5 の予約は Arc 11,000 + Solana 10,000、O-6 はその逆。どちらも 1 件の上限の内側で、両レグが同じ区分ではない。
    for (const [profile, sourceNetwork, destinationNetwork] of [[arcToSol, INBOUND_ARC.network, OUTBOUND_SOL.network], [solToArc, INBOUND_SOL.network, INBOUND_ARC.network]] as const) {
      const pricing = priceOf(profile, profile.maxUpstreamAmount, undefined);
      expect(pricing).toBeDefined();
      const reservation = reservationOf(profile, pricing!);
      expect(reservation.legs.map((leg) => [leg.network, leg.amount])).toEqual([[sourceNetwork, "11000"], [destinationNetwork, "10000"]]);
      expect(perPurchaseLimitOf(router, reservation), profile.profileId).toBeUndefined();
    }
    expect(bucketsOf(router).dynamic).toHaveLength(4);
  });
});
