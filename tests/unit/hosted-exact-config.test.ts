/**
 * hosted の `subetha-exact` の実証の設定生成（`docs/hosted-exact-enable-design.md` §6、§9 T-d、要件 AC-1）。
 * スイッチ（`RailsActivation.subethaExact.inbound`）が無効なら生成物は今と同じ。有効なら route 1 本・予算の区分・adapter の上限・子の env が出る。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { loadRuntimeConfig } from "../../src/config.js";
import { routeListBody } from "../../src/http/projection.js";
import {
  HOSTED_EXACT,
  HOSTED_EXACT_FACILITATOR_URL_ENV,
  HOSTED_EXACT_TOKEN_FILE_ENV,
  hostedExactOf,
  OUTBOUND_X402,
  RAILS_ACTIVATION,
  RAILS_NONE,
  routerConfigOf,
  subethaExactOf,
  UPSTREAM_X402,
  type RailsOptions,
} from "../../tools/remote-mcp-config.js";
import { HostPlanError, hostPlanOf, publicJournalPathOf } from "../../tools/remote-mcp.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const TENANT = "https://facilitator-testnet.subethalabs.com/p/router-hosted";
const TOKEN_FILE = "/app/runtime/secrets/subetha-exact.token";
const ENV_ON = { [HOSTED_EXACT_FACILITATOR_URL_ENV]: TENANT, [HOSTED_EXACT_TOKEN_FILE_ENV]: TOKEN_FILE };
const ON: RailsOptions = { activation: { ...RAILS_NONE, subethaExact: { inbound: true } }, receivers: {} };
const OFF: RailsOptions = { activation: RAILS_NONE, receivers: {} };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
/** 本番と同じ読み方（real、既定の表）で読めること。 */
function loadAsProduction(document: Record<string, unknown>, extraEnv: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "hx-config-"));
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
      ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-hx",
      ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
      ...extraEnv,
    },
    (file) => (file === configPath ? JSON.stringify(document) : ""),
  );
}

describe("スイッチと定数", () => {
  test("公開の定数は無効（G-4 で true にする）。欄が無ければ false。実証の値は 1 か所", () => {
    expect(subethaExactOf(RAILS_ACTIVATION).inbound).toBe(false);
    expect(subethaExactOf(RAILS_NONE).inbound).toBe(false);
    expect(HOSTED_EXACT).toMatchObject({ routeId: "md-zusdc-eth-snapshot", maxCommitted: 40, publicOrigin: "https://router.subethalabs.com" });
    expect(HOSTED_EXACT.limits).toEqual({ maxRequestsTotal: 300, maxUnresolved: 8, requestsPerMinute: 12, maxUnresolvedPerSource: 4, requestsPerMinutePerSource: 3 });
    // zUSDC の区分は、作成の総数 × 受信額より大きい（予約が戻らなくても先に尽きない）。
    expect(BigInt(HOSTED_EXACT.bucketMaxTotal)).toBeGreaterThan(BigInt(HOSTED_EXACT.limits.maxRequestsTotal) * BigInt(HOSTED_EXACT.source.amount));
    // 1 つの送信元だけでは全体の未解決の枠を埋められない。
    expect(HOSTED_EXACT.limits.maxUnresolvedPerSource).toBeLessThan(HOSTED_EXACT.limits.maxUnresolved);
  });

  test("無効: env を読まず、生成物は欄の無い生成と同じ（env があっても route・区分・節が出ない）", () => {
    const base = JSON.stringify(routerConfigOf({}, RECEIVER, true, OFF));
    expect(JSON.stringify(routerConfigOf(ENV_ON, RECEIVER, true, OFF))).toBe(base);
    expect(JSON.stringify(routerConfigOf(ENV_ON, RECEIVER, true, { activation: { ...RAILS_NONE, subethaExact: { inbound: false } }, receivers: {} }))).toBe(base);
    expect(base).not.toContain("subetha-exact");
    expect(base).not.toContain(HOSTED_EXACT.routeId);
    expect(hostedExactOf({}, RAILS_NONE)).toBeUndefined();
  });

  test("有効: route 1 本（offer の上限つき）、Base Sepolia の zUSDC の区分、adapter の上限と verify の扱い、上流。既存の route と区分は変わらない（足すだけ）", () => {
    const off = routerConfigOf({}, RECEIVER, true, OFF) as { router: { routes: Record<string, unknown>; budget: { buckets: unknown[] } }; x402: { upstreams: Record<string, string> } };
    const on = routerConfigOf(ENV_ON, RECEIVER, true, ON) as typeof off & { subethaExact: unknown };
    expect(on.router.routes[HOSTED_EXACT.routeId]).toEqual({
      routeId: HOSTED_EXACT.routeId,
      canonicalPath: `/v1/routes/${HOSTED_EXACT.routeId}/resource`,
      rail: "x402",
      sourceRail: "subetha-exact",
      offerCap: { maxCommitted: 40 },
      source: { amount: "12000", asset: HOSTED_EXACT.source.asset, decimals: 6, network: "eip155:84532" },
      destination: { scheme: "exact", network: OUTBOUND_X402.network, asset: OUTBOUND_X402.asset, payTo: OUTBOUND_X402.payTo },
    });
    expect(on.subethaExact).toEqual({ limits: HOSTED_EXACT.limits, unansweredVerifyIsUnknown: true });
    expect(on.x402.upstreams[HOSTED_EXACT.routeId]).toBe(UPSTREAM_X402);
    expect(on.router.budget.buckets).toContainEqual({ network: "eip155:84532", asset: HOSTED_EXACT.source.asset, maxTotal: "10000000", maxPerPurchase: "20000" });
    // 足したものを除けば、無効の生成と同じ。
    const { [HOSTED_EXACT.routeId]: _route, ...otherRoutes } = on.router.routes;
    expect(otherRoutes).toEqual(off.router.routes);
    expect(on.router.budget.buckets.slice(0, off.router.budget.buckets.length)).toEqual(off.router.budget.buckets);
    const { [HOSTED_EXACT.routeId]: _upstream, ...otherUpstreams } = on.x402.upstreams;
    expect(otherUpstreams).toEqual(off.x402.upstreams);
  });

  test("有効で host の env が欠けていれば生成しない（固定文に値が無い）", () => {
    for (const env of [{}, { [HOSTED_EXACT_FACILITATOR_URL_ENV]: TENANT }, { [HOSTED_EXACT_TOKEN_FILE_ENV]: TOKEN_FILE }, { [HOSTED_EXACT_FACILITATOR_URL_ENV]: "", [HOSTED_EXACT_TOKEN_FILE_ENV]: TOKEN_FILE }]) {
      let message = "";
      try {
        routerConfigOf(env, RECEIVER, true, ON);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("are required when the subetha-exact inbound rail is activated");
      expect(message).not.toContain(TENANT);
      expect(message).not.toContain(TOKEN_FILE);
    }
  });

  test("有効の生成は本番と同じ読み方で読め、一覧は公開の URL と実証の注記を出す。上限 0 は受付停止の注記", () => {
    const document = routerConfigOf(ENV_ON, RECEIVER, true, ON);
    const env = { ROUTER_SUBETHA_EXACT_FACILITATOR_URL: TENANT, ROUTER_SUBETHA_EXACT_TOKEN_FILE: TOKEN_FILE, ROUTER_X402_ENTRY_BASE_URL: HOSTED_EXACT.publicOrigin };
    const loaded = loadAsProduction(document, env);
    expect(loaded.http.x402EntryBaseUrl).toBe("https://router.subethalabs.com");
    expect(loaded.real?.subethaExact).toMatchObject({ limits: HOSTED_EXACT.limits, unansweredVerifyIsUnknown: true, tokenFile: TOKEN_FILE });
    const listing = routeListBody(loaded.router, loaded.http.canonicalBaseUrl, loaded.http.x402EntryBaseUrl) as { routes: Record<string, unknown>[] };
    const row = listing.routes.find((r) => r["routeId"] === HOSTED_EXACT.routeId)!;
    expect(row).toMatchObject({ x402Url: `https://router.subethalabs.com/x402/v1/routes/${HOSTED_EXACT.routeId}/resource`, demonstration: { capped: true, acceptingNewOffers: true }, source: { rail: "subetha-exact", fundsMoveOnCredential: false } });
    // 既存の route の行には `x402Url` も `demonstration` も無い。
    for (const other of listing.routes.filter((r) => r["routeId"] !== HOSTED_EXACT.routeId)) {
      expect(other).not.toHaveProperty("x402Url");
      expect(other).not.toHaveProperty("demonstration");
    }
    // 受付停止（上限 0）: route は残り、注記が変わる。
    const stopped = structuredClone(document) as { router: { routes: Record<string, { offerCap: { maxCommitted: number } }> } };
    stopped.router.routes[HOSTED_EXACT.routeId]!.offerCap.maxCommitted = 0;
    const loadedStopped = loadAsProduction(stopped as unknown as Record<string, unknown>, env);
    const stoppedRow = (routeListBody(loadedStopped.router, loadedStopped.http.canonicalBaseUrl, loadedStopped.http.x402EntryBaseUrl) as { routes: Record<string, unknown>[] }).routes.find((r) => r["routeId"] === HOSTED_EXACT.routeId)!;
    expect(stoppedRow["demonstration"]).toEqual({ capped: true, acceptingNewOffers: false });
    // 設定の検査: 上限の形、送信元ごとの未解決は 2 以上、公開の基点は origin だけ、他の rail の route に `offerCap` は付けられない。
    const bad = (mutate: (d: Record<string, unknown>) => void, extra: Record<string, string> = env) => {
      const copy = structuredClone(document);
      mutate(copy);
      return () => loadAsProduction(copy, extra);
    };
    expect(bad((d) => void ((d["subethaExact"] as { limits: Record<string, number> }).limits["maxUnresolvedPerSource"] = 1))).toThrow("maxUnresolvedPerSource");
    expect(bad((d) => void ((d["subethaExact"] as Record<string, unknown>)["unansweredVerifyIsUnknown"] = "yes"))).toThrow("unansweredVerifyIsUnknown");
    expect(bad((d) => void ((d["subethaExact"] as Record<string, unknown>)["extra"] = 1))).toThrow("unknown field");
    expect(bad((d) => void (((d["router"] as { routes: Record<string, Record<string, unknown>> }).routes[HOSTED_EXACT.routeId]!)["offerCap"] = { maxCommitted: -1 }))).toThrow("offerCap");
    expect(bad((d) => void (((d["router"] as { routes: Record<string, Record<string, unknown>> }).routes["md-mpp-eth-snapshot"]!)["offerCap"] = { maxCommitted: 1 }))).toThrow("offerCap is only allowed");
    for (const origin of ["http://router.subethalabs.com", "https://router.subethalabs.com/path", "https://user@router.subethalabs.com", "https://router.subethalabs.com?x=1", "not a url"]) {
      expect(bad(() => undefined, { ...env, ROUTER_X402_ENTRY_BASE_URL: origin }), origin).toThrow("ROUTER_X402_ENTRY_BASE_URL");
    }
  });
});

describe("ホストの起動の計画", () => {
  const baseEnv = { SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(), SUBETHA_ROUTER_RECEIVER: RECEIVER, SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-hxplan" };
  const options = (activation: RailsOptions["activation"]) => ({ activation, bind: "0.0.0.0", port: 8787, journalPath: publicJournalPathOf({}) });

  test("有効: 子の env に tenant の URL・token のファイルの path・公開の基点。計画は公開の経路の routeId を持つ", () => {
    const plan = hostPlanOf(options(ON.activation), { ...baseEnv, ...ENV_ON });
    expect(plan.childEnv).toMatchObject({ ROUTER_SUBETHA_EXACT_FACILITATOR_URL: TENANT, ROUTER_SUBETHA_EXACT_TOKEN_FILE: TOKEN_FILE, ROUTER_X402_ENTRY_BASE_URL: "https://router.subethalabs.com" });
    expect(plan.x402EntryRouteIds).toEqual([HOSTED_EXACT.routeId]);
    expect(Object.keys((plan.config["router"] as { routes: Record<string, unknown> }).routes)).toContain(HOSTED_EXACT.routeId);
  });

  test("有効で env が無ければ計画を作らない（固定の理由 `env`）", () => {
    let caught: unknown;
    try {
      hostPlanOf(options(ON.activation), baseEnv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostPlanError);
    expect((caught as HostPlanError).code).toBe("env");
  });

  test("無効: 子の env にも計画にも何も足さない（env があっても）", () => {
    const plan = hostPlanOf(options(RAILS_NONE), { ...baseEnv, ...ENV_ON });
    const keys = Object.keys(plan.childEnv);
    expect(keys.filter((k) => k.includes("SUBETHA_EXACT") || k === "ROUTER_X402_ENTRY_BASE_URL")).toEqual([]);
    expect(plan.x402EntryRouteIds).toBeUndefined();
    expect(JSON.stringify(plan.config)).toBe(JSON.stringify(hostPlanOf(options(RAILS_NONE), baseEnv).config));
  });
});
