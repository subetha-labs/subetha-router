/**
 * `/costs` の読み取りの配線（`docs/exact-costs-reader-design.md` A-4・A-8・A-9）: 実 `startRouter` の child と settle facilitator の模型。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import { HOSTED_EXACT_PRICING } from "../../tools/remote-mcp-config.js";
import { defaultCosts } from "../fixtures/subetha-exact-facilitator.js";
import { credentialOf, DEST_PAY_TO, NETWORK, principalHeaders, purchaseOf, quoteOf, ROUTE_ID, startExactHarness, statusOf, USDC, ZUSDC, type ExactHarness } from "../fixtures/subetha-exact-harness.js";

const SETTLE_TOKEN = "5e".repeat(32);
const FORMULA_ID = "md-zusdc-formula";
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const fixedRoute = {
  routeId: ROUTE_ID, canonicalPath: `/v1/routes/${ROUTE_ID}/resource`, rail: "x402", sourceRail: "subetha-exact", offerCap: { maxCommitted: 20 },
  source: { amount: "12000", asset: ZUSDC, decimals: 6, network: NETWORK },
  destination: { scheme: "exact", network: NETWORK, asset: USDC, payTo: DEST_PAY_TO },
};
const formulaRoute = { ...fixedRoute, routeId: FORMULA_ID, canonicalPath: `/v1/routes/${FORMULA_ID}/resource`, pricing: { ...HOSTED_EXACT_PRICING }, source: { ...fixedRoute.source, amount: "20000" } };
const started: ExactHarness[] = [];
afterEach(async () => {
  for (const h of started.splice(0)) await h.stopAll();
});

async function boot(routes: Record<string, unknown>, section: Record<string, unknown> | undefined): Promise<ExactHarness> {
  await mkdir(runtimeRoot, { recursive: true });
  const dir = await mkdtemp(path.join(runtimeRoot, "cr-wire-"));
  const file = path.join(dir, "settle.token");
  await writeFile(file, `${SETTLE_TOKEN}\n`, { mode: 0o600 });
  const h = await startExactHarness({
    routes,
    ...(section === undefined ? {} : { section }),
    facilitatorArgs: ["--settle-bearer", SETTLE_TOKEN],
    env: { ROUTER_SUBETHA_EXACT_SETTLE_TOKEN_FILE: file, ROUTER_SUBETHA_EXACT_ETH_PRICE: "3000000000", ROUTER_SUBETHA_EXACT_ETH_PRICE_AT: new Date().toISOString() },
  });
  started.push(h);
  return h;
}
async function setAccepting(h: ExactHarness, accepting: boolean): Promise<void> {
  // tenant は模型の既定の答えと同じもの（Provider の URL の `/p/<id>`）。
  const tenant = /\/p\/([a-z0-9-]+)/.exec(h.env["ROUTER_SUBETHA_EXACT_FACILITATOR_URL"]!)![1]!;
  const body = JSON.stringify({ ...defaultCosts(84532, ZUSDC, tenant), budget: [{ tenant, accepting }] });
  const r = await fetch(`${h.facilitator.baseUrl}/_fixture/costs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: 200, body }) });
  expect(r.status).toBe(200);
}
const quote = async (h: ExactHarness, routeId: string, requestId: string): Promise<[number, unknown]> => {
  const r = await fetch(`${h.router.baseUrl}/v1/quotes`, { method: "POST", headers: { ...principalHeaders(), "content-type": "application/json" }, body: JSON.stringify({ routeId, requestId }) });
  return [r.status, ((await r.json()) as { reason?: string }).reason];
};
const FIXED = { [ROUTE_ID]: fixedRoute };
const FORMULA = { [FORMULA_ID]: formulaRoute };
const MIXED = { ...FIXED, ...FORMULA };

test("A-8: 固定だけ・式だけ・混在 × 省略・false・true。false の応答で、固定は true の時だけ settle_budget、式は常に pricing_unavailable", async () => {
  for (const [name, routes] of [["fixed", FIXED], ["formula", FORMULA], ["mixed", MIXED]] as const) {
    for (const section of [undefined, { budgetGate: false }, { budgetGate: true }]) {
      const label = `${name} ${JSON.stringify(section ?? null)}`;
      const h = await boot(routes, section);
      await setAccepting(h, false);
      const gate = section?.budgetGate === true;
      let reads = 0;
      if (ROUTE_ID in routes) {
        expect(await quote(h, ROUTE_ID, "a"), label).toEqual(gate ? [503, "settle_budget"] : [200, undefined]);
        if (gate) reads = 1;
        expect((await h.calls()).byRoute["costs"] ?? 0, label).toBe(reads);
      }
      if (FORMULA_ID in routes) {
        expect(await quote(h, FORMULA_ID, "b"), label).toEqual([503, "pricing_unavailable"]);
        reads = 1;
        expect((await h.calls()).byRoute["costs"] ?? 0, label).toBe(reads);
      }
      expect((await h.calls()).byRoute["create"] ?? 0, label).toBe(ROUTE_ID in routes && !gate ? 1 : 0);
      started.splice(started.indexOf(h), 1);
      await h.stopAll();
    }
  }
});

test("A-4・A-9: 固定の route で断っている間も、発行済みの注文は払えて届く。標準の入口も断る", async () => {
  const h = await boot(FIXED, { budgetGate: true });
  const issued = await quoteOf(h, "kept");
  expect(issued.status).toBe(200);
  await setAccepting(h, false);
  await h.restartRouter(); // 読み取りの記憶を消す（60 秒を待たない）。
  expect(await quote(h, ROUTE_ID, "new")).toEqual([503, "settle_budget"]);
  const standard = await fetch(`${h.router.baseUrl}/x402/v1/routes/${ROUTE_ID}/resource`, { headers: principalHeaders() });
  expect([standard.status, await standard.json()]).toMatchObject([503, { error: "source_offer_unavailable", reason: "settle_budget" }]);
  expect((await h.calls()).byRoute["create"]).toBe(1);
  expect((await purchaseOf(h, issued.body, "kept", await credentialOf(h, issued.body.source.offer))).status).toBe(200);
  expect((await statusOf(h, issued.body.paymentId)).body).toMatchObject({ status: "delivered" });
});
