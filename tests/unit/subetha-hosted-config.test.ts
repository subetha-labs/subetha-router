/**
 * hosted の受信レグの SubEtha（zUSDC）の設定生成（設計 `docs/subetha-hosted-inbound-design.md` §4.1・§4.2・§6.1、タスク T1）。
 * 切り替えは `RailsActivation.subetha.inbound` の 1 つ。無効なら route も env も無く、facilitator のホスト名は有効化に関係なく動的上流の拒否に入る（FR-3.4）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { KNOWN_NETWORKS, loadRuntimeConfig, parseRouterConfig, type RouterConfig } from "../../src/config.js";
import { routeListBody, sourceRailListingOf } from "../../src/http/projection.js";
import { SUBETHA_ZERC20_ASSETS } from "../../src/shared/networks.js";
import {
  INBOUND,
  INBOUND_ZUSDC,
  RAILS_ACTIVATION,
  RAILS_DISABLED,
  RAILS_NONE,
  ROUTE_ZUSDC_TO_MPP,
  ROUTE_ZUSDC_TO_X402,
  routerConfigOf,
  SUBETHA_FACILITATOR_HOSTNAME,
  SUBETHA_FACILITATOR_URL_ENV,
  subethaOf,
  UPSTREAM,
  UPSTREAM_X402,
  type RailsOptions,
} from "../../tools/remote-mcp-config.js";
import { generatePrivateKey } from "viem/accounts";

import { acceptanceOptionsOf } from "../../tools/rails-acceptance-run.js";
import { activationFromEnv, activationToEnv, RAILS_ACTIVATION_ENV } from "../../tools/rails-entry.js";
import { HostPlanError, hostPlanOf, publicJournalPathOf } from "../../tools/remote-mcp.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const FACILITATOR_URL = "https://zerc20-facilitator.subethalabs.com";
const ON: RailsOptions = { activation: { ...RAILS_NONE, subetha: { inbound: true } }, receivers: {} };
const ENV_ON = { [SUBETHA_FACILITATOR_URL_ENV]: FACILITATOR_URL };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function routerOf(document: Record<string, unknown>): RouterConfig {
  return parseRouterConfig(document["router"], { networks: KNOWN_NETWORKS });
}

/** 本番と同じ読み方（real、`KNOWN_NETWORKS`）で読めること。SubEtha の facilitator の URL は生成した env の値を渡す。 */
function loadAsProduction(document: Record<string, unknown>, subethaUrl: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "t1-subetha-"));
  dirs.push(dir);
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  return loadRuntimeConfig(
    {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: subethaUrl,
      ROUTER_X402_INBOUND_FACILITATOR_URL: "https://www.x402.org/facilitator",
      ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-t1",
      ROUTER_CANONICAL_BASE_URL: "https://router.test",
      ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
    },
    (file) => (file === configPath ? JSON.stringify(document) : ""),
  );
}

function denyHostsOf(document: Record<string, unknown>): readonly string[] {
  const router = document["router"] as { dynamic?: { denyHosts?: string[] } };
  return router.dynamic?.denyHosts ?? [];
}

describe("T1: zUSDC の表と定数", () => {
  test("表 SUBETHA_ZERC20_ASSETS は Sepolia の zUSDC 2 行（V1 と V2 testnet-v2。6 桁、sign の上限 20,000）。凍結", () => {
    expect(SUBETHA_ZERC20_ASSETS).toEqual([
      { network: "eip155:11155111", token: "0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF", decimals: 6, maxAmount: 20_000n },
      { network: "eip155:11155111", token: "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f", decimals: 6, maxAmount: 20_000n },
    ]);
    for (const entry of SUBETHA_ZERC20_ASSETS) expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(SUBETHA_ZERC20_ASSETS)).toBe(true);
  });

  test("定数: 額 10,000（0.01 zUSDC）、route id 2 つ、ホスト名、env の名前", () => {
    expect(INBOUND_ZUSDC).toEqual({ network: "eip155:11155111", asset: "0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF", decimals: 6, amount: "10000" });
    expect(INBOUND_ZUSDC.amount).toBe(INBOUND.amount);
    expect(ROUTE_ZUSDC_TO_X402).toBe("md-x402-eth-snapshot-zusdc");
    expect(ROUTE_ZUSDC_TO_MPP).toBe("md-mpp-eth-snapshot-zusdc");
    expect(SUBETHA_FACILITATOR_HOSTNAME).toBe("zerc20-facilitator.subethalabs.com");
    expect(SUBETHA_FACILITATOR_URL_ENV).toBe("SUBETHA_ZERC20_FACILITATOR_URL");
  });

  test("公開の定数は subetha の欄を持たない = false（G-4 まで）。無ければ false（subethaOf）", () => {
    expect(RAILS_ACTIVATION.subetha).toBeUndefined();
    expect(subethaOf(RAILS_ACTIVATION)).toEqual({ inbound: false });
    expect(subethaOf(RAILS_NONE)).toEqual({ inbound: false });
    expect(subethaOf(ON.activation)).toEqual({ inbound: true });
  });
});

describe("T1: 無効（off）", () => {
  test("route は出ない。env を読まない（未設定・不正でも生成が通る）。拒否ホストに facilitator のホスト名", () => {
    for (const env of [{}, { [SUBETHA_FACILITATOR_URL_ENV]: "not a url" }]) {
      const document = routerConfigOf(env, RECEIVER, true, RAILS_DISABLED);
      const router = routerOf(document);
      expect(Object.keys(router.routes)).not.toContain(ROUTE_ZUSDC_TO_X402);
      expect(Object.keys(router.routes)).not.toContain(ROUTE_ZUSDC_TO_MPP);
      expect(router.budget.buckets.some((bucket) => bucket.asset === INBOUND_ZUSDC.asset)).toBe(false);
      expect(denyHostsOf(document)).toContain(SUBETHA_FACILITATOR_HOSTNAME);
    }
  });

  test("無効なら facilitator の env を 1 度も読まない（getter で読み取りを数える）", () => {
    let reads = 0;
    const env = new Proxy({} as Record<string, string | undefined>, {
      get(_target, key) {
        if (key === SUBETHA_FACILITATOR_URL_ENV) reads += 1;
        return undefined;
      },
    });
    routerConfigOf(env, RECEIVER, true, RAILS_DISABLED);
    expect(reads).toBe(0);
    expect(() => routerConfigOf(env, RECEIVER, true, ON)).toThrow();
    expect(reads).toBeGreaterThan(0);
  });

  test("公開の定数（RAILS_ACTIVATION）の生成にも zUSDC の route は無く、拒否ホストには入る", () => {
    const document = routerConfigOf({ SUBETHA_EVM_FACILITATOR_URL: "http://127.0.0.1:8611/t1-subetha-test-token_0123456789abcdef" }, RECEIVER, true, {
      activation: RAILS_ACTIVATION,
      receivers: { arc: "0xAF42CFfe4B35A05098613d962aF43CDc43fBb4Ea", solana: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" },
      providers: { arc: "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1", solana: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d", solanaMpp: "4LrBc1whdzuLzk7qgo6y5JEgHtyhgNoPpzPpHebaJ5oM" },
    });
    expect(Object.keys((document["router"] as { routes: Record<string, unknown> }).routes)).toHaveLength(10);
    expect(denyHostsOf(document)).toContain(SUBETHA_FACILITATOR_HOSTNAME);
  });
});

describe("T1: 有効（on）", () => {
  test("route 2 本（sourceRail subetha、source は zUSDC、payTo 無し）、上流、予算の区分、本番の読み込みを通る", () => {
    const document = routerConfigOf(ENV_ON, RECEIVER, true, ON);
    const router = routerOf(document);
    for (const [routeId, scheme] of [[ROUTE_ZUSDC_TO_X402, "exact"], [ROUTE_ZUSDC_TO_MPP, "tempo/charge"]] as const) {
      const route = router.routes[routeId];
      expect(route, routeId).toBeDefined();
      expect(route!.sourceRail).toBe("subetha");
      expect(route!.source).toEqual({ amount: "10000", asset: INBOUND_ZUSDC.asset, decimals: 6, network: "eip155:11155111" });
      expect(route!.source.payTo).toBeUndefined();
      expect(route!.destination.scheme).toBe(scheme);
    }
    const upstreams = (document["x402"] as { upstreams: Record<string, string> }).upstreams;
    expect(upstreams[ROUTE_ZUSDC_TO_X402]).toBe(UPSTREAM_X402);
    expect(upstreams[ROUTE_ZUSDC_TO_MPP]).toBe(UPSTREAM);
    const bucket = router.budget.buckets.filter((b) => b.network === INBOUND_ZUSDC.network && b.asset === INBOUND_ZUSDC.asset);
    expect(bucket).toEqual([{ network: INBOUND_ZUSDC.network, asset: INBOUND_ZUSDC.asset, maxTotal: "1000000000", maxPerPurchase: "10000" }]);
    expect(denyHostsOf(document)).toContain(SUBETHA_FACILITATOR_HOSTNAME);
    const loaded = loadAsProduction(document, FACILITATOR_URL);
    expect(Object.keys(loaded.router.routes)).toEqual(expect.arrayContaining([ROUTE_ZUSDC_TO_X402, ROUTE_ZUSDC_TO_MPP]));
  });

  test("一覧: 2 本が rail subetha・scheme subetha-zerc20 で出る。sourceRail 未指定の route は今までどおり rail を出さない", () => {
    const router = routerOf(routerConfigOf(ENV_ON, RECEIVER, true, ON));
    const body = routeListBody(router, "https://router.test") as { routes: { routeId: string; source: Record<string, unknown> }[] };
    for (const routeId of [ROUTE_ZUSDC_TO_X402, ROUTE_ZUSDC_TO_MPP]) {
      const listed = body.routes.find((route) => route.routeId === routeId);
      expect(listed?.source["rail"], routeId).toBe("subetha");
      expect(listed?.source["scheme"], routeId).toBe("subetha-zerc20");
      expect(listed?.source["payTo"], routeId).toBeUndefined();
    }
    const unspecified = { ...router.routes[ROUTE_ZUSDC_TO_X402]! };
    delete (unspecified as { sourceRail?: string }).sourceRail;
    expect(sourceRailListingOf(unspecified)).toEqual({});
  });

  test.each([
    ["無い", {}],
    ["空", { [SUBETHA_FACILITATOR_URL_ENV]: "" }],
    ["https でない", { [SUBETHA_FACILITATOR_URL_ENV]: "http://zerc20-facilitator.subethalabs.com" }],
    ["host が違う", { [SUBETHA_FACILITATOR_URL_ENV]: "https://evil.example.com" }],
    ["path 付き", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com/admin" }],
    ["query 付き", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com/?x=1" }],
    ["userinfo 付き", { [SUBETHA_FACILITATOR_URL_ENV]: "https://user:pw@zerc20-facilitator.subethalabs.com" }],
    ["port 付き", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com:8443" }],
    ["既定の port を明示", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com:443" }],
    ["fragment 付き", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com/#x" }],
    ["空の query", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com/?" }],
    ["空の fragment", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com/#" }],
    ["username だけ", { [SUBETHA_FACILITATOR_URL_ENV]: "https://user@zerc20-facilitator.subethalabs.com" }],
    ["password だけ", { [SUBETHA_FACILITATOR_URL_ENV]: "https://:pw@zerc20-facilitator.subethalabs.com" }],
    ["dot segment", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com/admin/.." }],
    ["percent-encoded の dot", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com/%2e" }],
    ["大文字の host", { [SUBETHA_FACILITATOR_URL_ENV]: "https://ZERC20-facilitator.subethalabs.com" }],
    ["percent-encoded の host", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.c%6Fm" }],
    ["全角の文字を含む host", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.ｃom" }],
    ["末尾の dot の host", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com." }],
    ["末尾の / が 2 つ", { [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com//" }],
    ["前後の空白", { [SUBETHA_FACILITATOR_URL_ENV]: " https://zerc20-facilitator.subethalabs.com" }],
    ["URL でない", { [SUBETHA_FACILITATOR_URL_ENV]: "not a url" }],
  ])("env が %s なら固定文で止まる（値を含まない）", (_name, env) => {
    let message = "";
    try {
      routerConfigOf(env, RECEIVER, true, ON);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`${SUBETHA_FACILITATOR_URL_ENV} must be exactly https://${SUBETHA_FACILITATOR_HOSTNAME} when the SubEtha inbound rail is activated`);
    expect(message).not.toContain("443");
    expect(message).not.toContain("evil");
    expect(message).not.toContain("pw");
  });

  test("末尾の / は受け付ける（URL の正規化で同じ origin）", () => {
    expect(() => routerConfigOf({ [SUBETHA_FACILITATOR_URL_ENV]: `${FACILITATOR_URL}/` }, RECEIVER, true, ON)).not.toThrow();
  });
});

describe("T1: 内部の env の token（受け入れの起動）", () => {
  test("subetha-in は末尾に付き、往復する。無ければ欄を持たない（既存の値は変わらない）", () => {
    expect(activationToEnv({ ...RAILS_NONE, subetha: { inbound: true } })).toBe("subetha-in");
    expect(activationFromEnv("subetha-in")).toEqual({ ...RAILS_NONE, subetha: { inbound: true } });
    expect(activationFromEnv("arc-in")).not.toHaveProperty("subetha");
    expect(activationToEnv({ ...RAILS_NONE, subetha: { inbound: false } })).toBe("");
    expect(() => activationFromEnv("subetha-in,subetha-in")).toThrow();
    expect(() => activationFromEnv("subetha-out")).toThrow();
  });
});

describe("T1: ホストの起動の計画（子の env）", () => {
  const baseEnv = { SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(), SUBETHA_ROUTER_RECEIVER: RECEIVER, SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-t1plan" };

  test("受け入れの起動（--rails subetha-in）: 子に facilitator の origin と有効化の token、設定に 2 本", () => {
    const options = acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_JOURNAL_PATH: path.join(tmpdir(), "t1-acc", "journal.ndjson") }, ["--rails", "subetha-in"]);
    const plan = hostPlanOf(options, { ...baseEnv, ...ENV_ON });
    expect(plan.childEnv["ROUTER_SUBETHA_FACILITATOR_URL"]).toBe(FACILITATOR_URL);
    expect(plan.childEnv[RAILS_ACTIVATION_ENV]).toBe("subetha-in");
    expect(Object.keys((plan.config["router"] as { routes: Record<string, unknown> }).routes)).toEqual(expect.arrayContaining([ROUTE_ZUSDC_TO_X402, ROUTE_ZUSDC_TO_MPP]));
  });

  test("受け入れの起動で env が無ければ計画を作らない（固定の理由）", () => {
    const options = acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_JOURNAL_PATH: path.join(tmpdir(), "t1-acc2", "journal.ndjson") }, ["--rails", "subetha-in"]);
    expect(() => hostPlanOf(options, baseEnv)).toThrow(HostPlanError);
  });

  test("無効（公開の定数の subetha は false）: 子の facilitator は今までどおりの埋め草で、env があっても使わない", () => {
    const plan = hostPlanOf({ activation: RAILS_NONE, bind: "0.0.0.0", port: 8787, journalPath: publicJournalPathOf({}) }, { ...baseEnv, ...ENV_ON });
    expect(plan.childEnv["ROUTER_SUBETHA_FACILITATOR_URL"]).toBe(INBOUND.facilitator);
    expect(Object.keys((plan.config["router"] as { routes: Record<string, unknown> }).routes)).not.toContain(ROUTE_ZUSDC_TO_X402);
  });
});
