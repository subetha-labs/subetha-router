/**
 * AC-1（`docs/subetha-hosted-inbound-requirements.md` v4、タスク T1）: hosted の設定生成が出す zUSDC（SubEtha）の route を、実の composition で起動した Router が
 * 一覧に出し、quote できる。無効の生成では一覧に無く、quote は `unknown_route`。**無課金**: 相手はすべて loopback の合成 fixture（facilitator・上流）で、
 * 送信レグは署名しない spy（`tests/fixtures/router-rails-process.ts`）。
 *
 * 生成した文書は全体をそのまま使い、外の宛先（上流・facilitator・RPC）だけを loopback の fixture に差し替える（本番の Provider・facilitator を指すため）。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  INBOUND_ZUSDC,
  OUTBOUND,
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
const BURN_ADDRESS = "0x0000000000000000000000000000000000000a0e";

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
 * `enabled` の生成から router を起動する。生成した文書は、**動的の節（`router.dynamic`）を除いて全体をそのまま**使い（既存の静的の route・予算の区分・上流の節）、
 * 外の宛先だけを loopback の fixture に差し替える: 各 route の上流の URL（rail で x402 と MPP の fixture に分ける。受取先は生成した route の宛先の `payTo`）、
 * 受信の facilitator（SubEtha・x402）、MPP 受信の RPC。
 *
 * 動的の節を除く理由: 動的の MPP のプロファイルは起動時に Tempo の RPC へ読取の見積りを guarded な動的 transport で出し、その transport は loopback を拒む
 * （別 process の fixture では DNS・TLS の hook を渡せない）。T1 が動的の節で変えたのは拒否ホストの 1 語だけで、それは golden（`tests/unit/config-golden.test.ts`）と
 * unit（`tests/unit/subetha-hosted-config.test.ts`）が byte と値で固定している。
 */
async function start(enabled: boolean): Promise<Started> {
  const facilitator = await track(
    await startListening("tests/fixtures/facilitator-server.ts", ["--port", "0", "--token", INBOUND_ZUSDC.asset, "--pay-to", BURN_ADDRESS, "--chain-id", "11155111"]),
  );
  const x402Facilitator = await track(await startListening("tests/fixtures/x402-inbound-facilitator.ts", []));
  const x402Upstream = await track(
    await startListening("tests/fixtures/x402-upstream.ts", ["--network", OUTBOUND_X402.network, "--asset", OUTBOUND_X402.asset, "--pay-to", OUTBOUND_X402.payTo]),
  );
  const mppUpstream = await track(await startListening("tests/fixtures/mpp-upstream.ts", ["--pay", "ok", "--recipient", OUTBOUND.payTo]));

  const generated = enabled
    ? routerConfigOf({ [SUBETHA_FACILITATOR_URL_ENV]: "https://zerc20-facilitator.subethalabs.com" }, RECEIVER, true, { activation: { ...RAILS_NONE, subetha: { inbound: true } }, receivers: {} })
    : routerConfigOf({}, RECEIVER, true, RAILS_DISABLED);
  const routes = (generated["router"] as { routes: Record<string, Record<string, unknown>> }).routes;
  const x402Section = generated["x402"] as { upstreams: Record<string, string> };
  const { dynamic: _dynamic, ...staticRouter } = generated["router"] as Record<string, unknown>;
  const document = {
    ...generated,
    router: staticRouter,
    x402: {
      ...x402Section,
      upstreams: Object.fromEntries(
        Object.keys(x402Section.upstreams).map((routeId) => [routeId, `${routes[routeId]!["rail"] === "mpp" ? mppUpstream.baseUrl : x402Upstream.baseUrl}/v1/eth/snapshot`]),
      ),
    },
  };

  const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const work = await mkdtemp(path.join(runtimeRoot, "t1-subetha-"));
  const configPath = path.join(work, "router.config.json");
  await writeFile(configPath, JSON.stringify(document), "utf8");
  const router = await track(
    await startListening("tests/fixtures/router-rails-process.ts", ["--rails", "ab"], {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_JOURNAL_PATH: path.join(work, "journal.ndjson"),
      ROUTER_HTTP_PORT: "0",
      ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
      ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: facilitator.baseUrl,
      ROUTER_X402_INBOUND_FACILITATOR_URL: x402Facilitator.baseUrl,
      ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-t1wire",
      ROUTER_MPP_INBOUND_RPC_URL: `${x402Facilitator.baseUrl}/no-rpc`,
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
  test("有効: 一覧に 2 本（rail subetha・scheme subetha-zerc20、payTo 無し）と既存の route。2 本とも quote が成立し、offer は zUSDC・10,000・facilitator の burn address", async () => {
    const { router, facilitator } = await start(true);
    const routes = await listed(router);
    for (const routeId of [ROUTE_ZUSDC_TO_X402, ROUTE_ZUSDC_TO_MPP]) {
      const route = routes.find((candidate) => candidate.routeId === routeId);
      expect(route?.source, routeId).toMatchObject({ rail: "subetha", scheme: "subetha-zerc20", network: INBOUND_ZUSDC.network, asset: INBOUND_ZUSDC.asset, amount: "10000", decimals: 6 });
      expect(route?.source["payTo"], routeId).toBeUndefined();
    }
    for (const routeId of [ROUTE_ZUSDC_TO_X402, ROUTE_ZUSDC_TO_MPP]) {
      const { status, body } = await quote(router, routeId, `t1-on-${routeId}`);
      expect(status, JSON.stringify(body)).toBe(200);
      const source = body["source"] as Record<string, unknown>;
      expect(source, routeId).toMatchObject({ rail: "subetha", amount: "10000", asset: INBOUND_ZUSDC.asset, network: INBOUND_ZUSDC.network, payTo: BURN_ADDRESS });
      expect((source["offer"] as Record<string, unknown>)["scheme"], routeId).toBe("subetha-zerc20");
    }
    // 既存の route も同じ起動で一覧に残る（生成した文書の全体で起動している）。
    expect(routes.map((route) => route.routeId)).toEqual(expect.arrayContaining(["md-mpp-eth-snapshot", "md-x402-eth-snapshot"]));
    const calls = (await (await fetch(`${facilitator.baseUrl}/calls`)).json()) as Record<string, number>;
    expect(calls["verifyCalls"] ?? 0).toBe(0);
    expect(calls["settleCalls"] ?? 0).toBe(0);
  });

  test("無効: 一覧に無く、quote は unknown_route（facilitator に要求が届かない）", async () => {
    const { router } = await start(false);
    const ids = (await listed(router)).map((route) => route.routeId);
    expect(ids).toEqual(expect.arrayContaining(["md-mpp-eth-snapshot", "md-x402-eth-snapshot"]));
    expect(ids).not.toContain(ROUTE_ZUSDC_TO_X402);
    expect(ids).not.toContain(ROUTE_ZUSDC_TO_MPP);
    for (const routeId of [ROUTE_ZUSDC_TO_X402, ROUTE_ZUSDC_TO_MPP]) {
      const { body } = await quote(router, routeId, `t1-off-${routeId}`);
      expect(JSON.stringify(body), routeId).toContain("unknown_route");
    }
  });
});
