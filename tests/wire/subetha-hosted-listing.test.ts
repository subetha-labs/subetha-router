/**
 * AC-1（`docs/subetha-hosted-inbound-requirements.md` v4、タスク T1）: hosted の設定生成が出す zUSDC（SubEtha）の route を、実の composition で起動した Router が
 * 一覧に出し、quote できる。無効の生成では一覧に無く、quote は `unknown_route`。**無課金**: 相手はすべて loopback の合成 fixture（facilitator・上流）で、
 * 送信レグは署名しない spy（`tests/fixtures/router-rails-process.ts`）。
 *
 * 生成した文書の route・予算の区分は**そのまま**使い、上流の URL だけを loopback の fixture に差し替える（上流の URL は本番の Provider を指すため）。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  INBOUND_ZUSDC,
  OUTBOUND_X402,
  RAILS_DISABLED,
  RAILS_NONE,
  ROUTE_ZUSDC_TO_MPP,
  ROUTE_ZUSDC_TO_X402,
  routerConfigOf,
  SUBETHA_FACILITATOR_URL_ENV,
} from "../../tools/remote-mcp-config.js";
import { startListening, type Listening } from "../fixtures/loopback.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const ALICE = { id: "alice", token: "tok-alice-t1" };
const FILLER_ROUTE = "md-subetha-filler";

const running: Listening[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
});
async function track(listening: Listening): Promise<Listening> {
  running.push(listening);
  return listening;
}

const headers = { "x-router-principal": ALICE.id, authorization: `Bearer ${ALICE.token}`, "content-type": "application/json" };

interface Started {
  readonly router: Listening;
  readonly facilitator: Listening;
}

/**
 * `enabled` の生成から router を起動する。無効の生成には zUSDC の route が無く、Router は route 0 本では起動しないので、
 * 合成の SubEtha の route を 1 本（`FILLER_ROUTE`）だけ足す（無効の生成の route の有無は unit の T1 が見る）。
 */
async function start(enabled: boolean): Promise<Started> {
  const facilitator = await track(
    await startListening("tests/fixtures/facilitator-server.ts", ["--port", "0", "--token", INBOUND_ZUSDC.asset, "--pay-to", "0x0000000000000000000000000000000000000a0e", "--chain-id", "11155111"]),
  );
  const x402Upstream = await track(
    await startListening("tests/fixtures/x402-upstream.ts", ["--network", OUTBOUND_X402.network, "--asset", OUTBOUND_X402.asset, "--pay-to", OUTBOUND_X402.payTo]),
  );
  const mppUpstream = await track(await startListening("tests/fixtures/mpp-upstream.ts", ["--pay", "ok"]));

  const generated = enabled
    ? routerConfigOf({ [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com" }, RECEIVER, true, { activation: { ...RAILS_NONE, subetha: { inbound: true } }, receivers: {} })
    : routerConfigOf({}, RECEIVER, true, RAILS_DISABLED);
  const generatedRouter = generated["router"] as { approvalTtlMs: number; routes: Record<string, Record<string, unknown>>; budget: { maxPurchases: number; buckets: Record<string, unknown>[] } };
  const zusdcRoutes = Object.fromEntries(Object.entries(generatedRouter.routes).filter(([, route]) => route["sourceRail"] === "subetha"));
  const routes: Record<string, Record<string, unknown>> = {
    ...zusdcRoutes,
    ...(Object.keys(zusdcRoutes).length > 0
      ? {}
      : {
          [FILLER_ROUTE]: {
            routeId: FILLER_ROUTE,
            canonicalPath: `/v1/routes/${FILLER_ROUTE}/resource`,
            rail: "x402",
            sourceRail: "subetha",
            source: { amount: INBOUND_ZUSDC.amount, asset: INBOUND_ZUSDC.asset, decimals: INBOUND_ZUSDC.decimals, network: INBOUND_ZUSDC.network },
            destination: { scheme: "exact", network: OUTBOUND_X402.network, asset: OUTBOUND_X402.asset, payTo: OUTBOUND_X402.payTo },
          },
        }),
  };
  const upstreamOf = (routeId: string): string => (routes[routeId]!["rail"] === "mpp" ? `${mppUpstream.baseUrl}/v1/eth/snapshot` : `${x402Upstream.baseUrl}/v1/eth/snapshot`);
  const buckets = [
    ...generatedRouter.budget.buckets.filter((bucket) => bucket["network"] === OUTBOUND_X402.network || bucket["network"] === "eip155:42431"),
    ...(enabled ? generatedRouter.budget.buckets.filter((bucket) => bucket["asset"] === INBOUND_ZUSDC.asset) : [{ network: INBOUND_ZUSDC.network, asset: INBOUND_ZUSDC.asset, maxTotal: "1000000000", maxPerPurchase: "10000" }]),
  ];

  const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const work = await mkdtemp(path.join(runtimeRoot, "t1-subetha-"));
  const configPath = path.join(work, "router.config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      router: { approvalTtlMs: generatedRouter.approvalTtlMs, routes, budget: { maxPurchases: generatedRouter.budget.maxPurchases, buckets } },
      x402: { upstreams: Object.fromEntries(Object.keys(routes).map((routeId) => [routeId, upstreamOf(routeId)])) },
    }),
    "utf8",
  );
  const router = await track(
    await startListening("tests/fixtures/router-rails-process.ts", ["--rails", "ab"], {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_JOURNAL_PATH: path.join(work, "journal.ndjson"),
      ROUTER_HTTP_PORT: "0",
      ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
      ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: facilitator.baseUrl,
      ROUTER_X402_INBOUND_FACILITATOR_URL: facilitator.baseUrl,
    }),
  );
  return { router, facilitator };
}

async function listed(router: Listening): Promise<{ routeId: string; source: Record<string, unknown> }[]> {
  const response = await fetch(`${router.baseUrl}/v1/routes`, { headers });
  expect(response.status).toBe(200);
  return ((await response.json()) as { routes: { routeId: string; source: Record<string, unknown> }[] }).routes;
}

async function quote(router: Listening, routeId: string, requestId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${router.baseUrl}/v1/quotes`, { method: "POST", headers, body: JSON.stringify({ routeId, requestId }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("AC-1: hosted の生成の zUSDC route（実の composition、無課金）", () => {
  test("有効: 一覧に 2 本（rail subetha・scheme subetha-zerc20、payTo 無し）。Provider A 宛ての quote が成立し、offer は zUSDC・10,000・facilitator の burn address", async () => {
    const { router, facilitator } = await start(true);
    const routes = await listed(router);
    for (const routeId of [ROUTE_ZUSDC_TO_X402, ROUTE_ZUSDC_TO_MPP]) {
      const route = routes.find((candidate) => candidate.routeId === routeId);
      expect(route?.source, routeId).toMatchObject({ rail: "subetha", scheme: "subetha-zerc20", network: INBOUND_ZUSDC.network, asset: INBOUND_ZUSDC.asset, amount: "10000", decimals: 6 });
      expect(route?.source["payTo"], routeId).toBeUndefined();
    }
    const { status, body } = await quote(router, ROUTE_ZUSDC_TO_X402, "t1-on-1");
    expect(status, JSON.stringify(body)).toBe(200);
    const source = body["source"] as Record<string, unknown>;
    expect(source).toMatchObject({ rail: "subetha", amount: "10000", asset: INBOUND_ZUSDC.asset, network: INBOUND_ZUSDC.network, payTo: "0x0000000000000000000000000000000000000a0e" });
    expect((source["offer"] as Record<string, unknown>)["scheme"]).toBe("subetha-zerc20");
    const calls = (await (await fetch(`${facilitator.baseUrl}/calls`)).json()) as Record<string, number>;
    expect(calls["verifyCalls"] ?? 0).toBe(0);
    expect(calls["settleCalls"] ?? 0).toBe(0);
  });

  test("無効: 一覧に無く、quote は unknown_route（facilitator に要求が届かない）", async () => {
    const { router } = await start(false);
    const ids = (await listed(router)).map((route) => route.routeId);
    expect(ids).not.toContain(ROUTE_ZUSDC_TO_X402);
    expect(ids).not.toContain(ROUTE_ZUSDC_TO_MPP);
    for (const routeId of [ROUTE_ZUSDC_TO_X402, ROUTE_ZUSDC_TO_MPP]) {
      const { body } = await quote(router, routeId, `t1-off-${routeId}`);
      expect(JSON.stringify(body), routeId).toContain("unknown_route");
    }
  });
});
