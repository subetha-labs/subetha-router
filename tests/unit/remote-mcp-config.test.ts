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
import { routeListBody } from "../../src/http/projection.js";
import {
  dynamicProfilesOf,
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
  RAIL_UPSTREAMS,
  railActive,
  routerConfigOf,
  UPSTREAM,
  UPSTREAM_ARC,
  UPSTREAM_X402,
  type RailsOptions,
} from "../../tools/remote-mcp-config.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const ARC_RECEIVER = "0xAF42CFfe4B35A05098613d962aF43CDc43fBb4Ea";
const SOL_OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const BOTH: RailsOptions = { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: true, outbound: false } }, receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER } };

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
  test("既定の生成（RAILS_DISABLED = RAILS_NONE）は既存の 2 経路・2 プロファイルだけ。公開の定数 RAILS_ACTIVATION は G-4 で両方 true（凍結）", () => {
    expect(RAILS_NONE).toEqual({ arc: { inbound: false, outbound: false }, solana: { inbound: false, outbound: false } });
    expect(Object.isFrozen(RAILS_NONE)).toBe(true);
    expect(RAILS_DISABLED.activation).toBe(RAILS_NONE);
    expect(RAILS_ACTIVATION).toEqual({ arc: { inbound: true, outbound: false }, solana: { inbound: true, outbound: false } });
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
    expect(buckets.dynamic).toContain("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1|4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU|20000|100000000");
    expect(buckets.static).toHaveLength(4);
    expect(buckets.dynamic).toHaveLength(4);
    // 通算の上限は既存の env の上書きをそのまま使う（新しい env は増やさない）。
    const overridden = routerOf(routerConfigOf({ SUBETHA_INBOUND_MAX_TOTAL: "777", SUBETHA_DYNAMIC_MAX_TOTAL: "555" }, RECEIVER, true, BOTH));
    expect(bucketsOf(overridden).static.filter((b) => b.endsWith("|10000|777"))).toHaveLength(3);
    expect(bucketsOf(overridden).dynamic.filter((b) => b.endsWith("|20000|555"))).toHaveLength(4);
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
    ["Arc だけ", { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false } }, receivers: { arc: ARC_RECEIVER } }, [ROUTE_ARC], ["dyn-arc-to-mpp", "dyn-arc-to-x402"], INBOUND_ARC.network, INBOUND_SOL.network],
    ["Solana だけ", { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false } }, receivers: { solana: SOL_OWNER } }, [ROUTE_SOL], ["dyn-sol-to-mpp", "dyn-sol-to-x402"], INBOUND_SOL.network, INBOUND_ARC.network],
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
    ["Arc の受取先が無い", { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false } }, receivers: {} }, /arc rail is activated but its receiver address is missing or malformed/],
    ["Arc の受取先の形が違う", { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false } }, receivers: { arc: "0x1234" } }, /arc rail is activated/],
    ["Arc に Solana の address", { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false } }, receivers: { arc: SOL_OWNER } }, /arc rail is activated/],
    ["Solana の受取先が無い", { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false } }, receivers: { arc: ARC_RECEIVER } }, /solana rail is activated but its receiver address is missing or malformed/],
    ["Solana に EVM の address", { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false } }, receivers: { solana: ARC_RECEIVER } }, /solana rail is activated/],
    ["Solana の address に base58 でない文字", { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: true, outbound: false } }, receivers: { solana: `${SOL_OWNER.slice(0, -1)}0` } }, /solana rail is activated/],
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
  const ARC_PROVIDER = "0xAF42CFfe4B35A05098613d962aF43CDc43fBb4Ea";
  const OUT_ONLY: RailsOptions = { activation: { arc: { inbound: false, outbound: true }, solana: { inbound: false, outbound: false } }, receivers: {}, providers: { arc: ARC_PROVIDER } };

  test("公開の定数は受信 true・送信 false（Arc・Solana とも）。railActive は方向のどれかで決まる", () => {
    expect(RAILS_ACTIVATION).toEqual({ arc: { inbound: true, outbound: false }, solana: { inbound: true, outbound: false } });
    expect(Object.isFrozen(RAILS_ACTIVATION) && Object.isFrozen(RAILS_ACTIVATION.arc)).toBe(true);
    expect(railActive(RAILS_NONE)).toBe(false);
    expect(railActive({ arc: { inbound: false, outbound: true }, solana: { inbound: false, outbound: false } })).toBe(true);
  });

  test("公開の設定（定数）に送信の route／プロファイルは出ない: 公開する ID の集合は受信の 6 本だけ（D-12・D-16: O-5・O-6 も無い）", () => {
    const document = routerConfigOf({}, RECEIVER, true, { activation: RAILS_ACTIVATION, receivers: { arc: ARC_RECEIVER, solana: SOL_OWNER } });
    const router = routerOf(document);
    expect(Object.keys(router.routes).sort()).toEqual([ROUTE, ROUTE_MPP_IN, ROUTE_ARC, ROUTE_SOL].sort());
    expect(Object.keys(router.dynamic!.profiles).sort()).toEqual(["dyn-arc-to-mpp", "dyn-arc-to-x402", "dyn-mpp-to-x402", "dyn-sol-to-mpp", "dyn-sol-to-x402", "dyn-x402-to-mpp"]);
    expect(JSON.stringify(document)).not.toMatch(/dyn-x402-to-arc|dyn-mpp-to-arc|dyn-arc-to-sol|dyn-sol-to-arc|md-arc-eth-snapshot|md-sol-eth-snapshot/);
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

  test("静的 route md-arc-eth-snapshot は Provider の URL（定数）と受取先（env）がそろったときだけ。URL が空の今は出ない", () => {
    expect(UPSTREAM_ARC).toBe("");
    expect(RAIL_UPSTREAMS).toEqual({ arc: "" });
    const document = routerConfigOf({}, RECEIVER, true, OUT_ONLY);
    expect(routerOf(document).routes[ROUTE_ARC_OUT]).toBeUndefined();
    expect(Object.keys((document["x402"] as { upstreams: Record<string, string> }).upstreams)).not.toContain(ROUTE_ARC_OUT);
    // 受取先が無くても URL が空なら読まれない（起動する）。
    expect(() => routerConfigOf({}, RECEIVER, true, { ...OUT_ONLY, providers: {} })).not.toThrow();
    // 受取先があっても URL が空なら出ない。
    expect(routerOf(routerConfigOf({}, RECEIVER, true, { ...OUT_ONLY, upstreams: { arc: "" } })).routes[ROUTE_ARC_OUT]).toBeUndefined();
  });

  test("Provider の URL が入ると静的 route md-arc-eth-snapshot が出る: Base USDC 10,000 を Router の受取先に払い、Arc USDC で Provider の受取先に届く。上流はその URL。本番の読み込みを通る", () => {
    const ARC_UPSTREAM = "https://provider-arc.test/v1/eth/snapshot";
    const withUrl: RailsOptions = { ...OUT_ONLY, upstreams: { arc: ARC_UPSTREAM } };
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
    const off: RailsOptions = { activation: RAILS_NONE, receivers: {}, providers: {}, upstreams: { arc: ARC_UPSTREAM } };
    expect(routerOf(routerConfigOf({}, RECEIVER, true, off)).routes[ROUTE_ARC_OUT]).toBeUndefined();
  });

  test("URL があるのに受取先が無い・形が悪いなら起動しない（固定文。値は出ない）", () => {
    const ARC_UPSTREAM = "https://provider-arc.test/v1/eth/snapshot";
    const message = /arc outbound rail is activated with an upstream URL but the provider pay-to address is missing or malformed/;
    for (const providers of [{}, { arc: "" }, { arc: "not-an-address" }, { arc: ARC_PROVIDER.slice(0, 41) }, { arc: SOL_OWNER }]) {
      const rails: RailsOptions = { ...OUT_ONLY, providers, upstreams: { arc: ARC_UPSTREAM } };
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
    const both: RailsOptions = { activation: { arc: { inbound: true, outbound: true }, solana: { inbound: false, outbound: false } }, receivers: { arc: ARC_RECEIVER }, providers: { arc: ARC_PROVIDER } };
    const router = loadAsProduction(routerConfigOf({}, RECEIVER, true, both)).router;
    expect(Object.keys(router.routes).sort()).toEqual([ROUTE, ROUTE_MPP_IN, ROUTE_ARC].sort());
    expect(Object.keys(router.dynamic!.profiles).sort()).toEqual(["dyn-arc-to-mpp", "dyn-arc-to-x402", "dyn-mpp-to-arc", "dyn-mpp-to-x402", "dyn-x402-to-arc", "dyn-x402-to-mpp"]);
    const buckets = bucketsOf(router);
    expect(buckets.static.filter((b) => b.startsWith(OUTBOUND_ARC.network))).toHaveLength(1);
    expect(buckets.dynamic.filter((b) => b.startsWith(OUTBOUND_ARC.network))).toHaveLength(1);
  });
});
