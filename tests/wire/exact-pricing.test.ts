/**
 * 式の価格の wire（`docs/exact-pricing-{requirements,design}.md` AC-9・AC-10・AC-11 の子・AC-13）: 実 `startRouter` の child、settle facilitator の模型（`/costs` と `/settle`）。
 * quote の入口（`npm run sign` の道具と同じ封筒）・MCP の tool・手を加えていない標準の x402 client で、式の額で買う。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

vi.setConfig({ testTimeout: 120_000 });

import { createRouterClient } from "../../src/client/index.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import { routeRowsOf } from "../../packages/payer/src/daemon/handler.js";
import { HOSTED_EXACT_PRICING } from "../../tools/remote-mcp-config.js";
import { ALICE, BEARER, configDocument, credentialOf, DEST_PAY_TO, NETWORK, principalHeaders, purchaseOf, quoteOf, ROUTE_ID, startExactHarness, statusOf, USDC, ZUSDC, type ExactHarness } from "../fixtures/subetha-exact-harness.js";

const SETTLE_TOKEN = "5e".repeat(32);
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const ROUTES = {
  [ROUTE_ID]: {
    routeId: ROUTE_ID, canonicalPath: `/v1/routes/${ROUTE_ID}/resource`, rail: "x402", sourceRail: "subetha-exact", offerCap: { maxCommitted: 20 }, pricing: { ...HOSTED_EXACT_PRICING },
    source: { amount: "20000", asset: ZUSDC, decimals: 6, network: NETWORK },
    destination: { scheme: "exact", network: NETWORK, asset: USDC, payTo: DEST_PAY_TO },
  },
};
/** 固定の額の route（同じ rail・同じ facilitator）。ETH の価格が無くても売れること。 */
const FIXED_ID = "md-zusdc-fixed";
const MIXED = { ...ROUTES, [FIXED_ID]: { ...ROUTES[ROUTE_ID]!, routeId: FIXED_ID, canonicalPath: `/v1/routes/${FIXED_ID}/resource`, pricing: undefined, source: { ...ROUTES[ROUTE_ID]!.source, amount: "12000" } } };
const started: { h: ExactHarness; dir: string }[] = [];
afterEach(async () => {
  for (const { h } of started.splice(0)) await h.stopAll();
});
const iso = (ms: number): string => new Date(ms).toISOString();
async function boot(env: Record<string, string> = {}): Promise<{ h: ExactHarness; dir: string }> {
  await mkdir(runtimeRoot, { recursive: true });
  const dir = await mkdtemp(path.join(runtimeRoot, "ep-wire-"));
  const file = path.join(dir, "settle.token");
  await writeFile(file, `${SETTLE_TOKEN}\n`, { mode: 0o600 });
  const h = await startExactHarness({
    routes: MIXED,
    facilitatorArgs: ["--settle-bearer", SETTLE_TOKEN],
    env: { ROUTER_SUBETHA_EXACT_SETTLE_TOKEN_FILE: file, ROUTER_SUBETHA_EXACT_ETH_PRICE: "3000000000", ROUTER_SUBETHA_EXACT_ETH_PRICE_AT: iso(Date.now()), SUBETHA_DIAGNOSTICS_PATH: path.join(dir, "diagnostics.ndjson"), ...env },
  });
  const entry = { h, dir };
  started.push(entry);
  return entry;
}
const setCosts = async (h: ExactHarness, body: Record<string, unknown>) => {
  const r = await fetch(`${h.facilitator.baseUrl}/_fixture/costs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
};
async function expectNoTokens(h: ExactHarness, dir: string): Promise<void> {
  let text = h.router.stderr();
  for (const root of [h.workDir, dir]) {
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile() && !entry.name.endsWith(".token")) text += await readFile(path.join(entry.parentPath, entry.name), "utf8");
  }
  expect(text.length).toBeGreaterThan(500);
  for (const secret of [BEARER, SETTLE_TOKEN, "939798001041"]) expect(text.includes(secret), secret.slice(0, 6)).toBe(false);
}

test("AC-9・AC-10・AC-13: 一覧は上限と pricing、quote は式の額と内訳、`npm run sign` の道具で署名でき、delivered。token は settle 先にだけ届き、記録に出ない。再起動のあとも同じ額", async () => {
  const { h, dir } = await boot();
  const list = (await (await fetch(`${h.router.baseUrl}/v1/routes`, { headers: principalHeaders() })).json()) as { routes: Record<string, unknown>[] };
  expect(list.routes[0]).toMatchObject({ source: { amount: "20000" }, pricing: { kind: "settle-cost-v1", maxAmount: "20000", amountIs: "per_quote" } });
  // `@subetha/payer` は zUSDC の route を扱わない: 式の route の入った一覧を読んでも壊れず、行に出さない。
  expect(routeRowsOf(list as unknown as Record<string, unknown>)).toEqual([]);
  const quote = await quoteOf(h, "req-1");
  expect(quote.status).toBe(200);
  const body = quote.body as unknown as { source: { amount: string; offer: { amount: string } }; pricing: Record<string, string> };
  expect(body.pricing).toMatchObject({ kind: "settle-cost-v1", withdraw: "2250", take: "500", total: body.source.amount });
  expect(Object.keys(body.pricing).sort()).toEqual(["costsAtMs", "kind", "rounding", "settle", "share", "take", "total", "upstream", "withdraw"]);
  expect([body.source.offer.amount, Number(body.source.amount) > Number(body.pricing["upstream"])]).toEqual([body.source.amount, true]);
  await h.restartRouter();
  const again = (await quoteOf(h, "req-1")).body as unknown as typeof body;
  expect([again.source.amount, again.pricing]).toEqual([body.source.amount, body.pricing]);
  // 署名の道具そのもの（`npm run sign`）。
  const signed = await promisify(execFile)("npx", ["tsx", "tools/sign-payment.ts", JSON.stringify(quote.body)], { env: { ...process.env, SUBETHA_PAYER_PRIVATE_KEY: generatePrivateKey() } });
  expect((await purchaseOf(h, quote.body, "req-1", signed.stdout.trim())).status).toBe(200);
  expect((await statusOf(h, quote.body.paymentId)).body).toMatchObject({ status: "delivered", source: { amount: body.source.amount } });
  const calls = (await h.calls()) as unknown as { byRoute: Record<string, number>; submitWithProviderToken: number; tenantWithSettleToken: number };
  expect([calls.byRoute["costs"], calls.byRoute["submit"], calls.submitWithProviderToken, calls.tenantWithSettleToken]).toEqual([1, 1, 0, 0]);
  await expectNoTokens(h, dir);
});

test("AC-9: 手を加えていない標準の x402 client が、402 の式の額で買える", async () => {
  const { h } = await boot();
  const account = privateKeyToAccount(generatePrivateKey());
  const paid: string[] = [];
  const signer = { address: account.address, signTypedData: async (args: Parameters<typeof account.signTypedData>[0]) => { paid.push(String((args as unknown as { message: { value: bigint } }).message.value)); return account.signTypedData(args); } };
  const client = x402Client.fromConfig({ schemes: [{ network: NETWORK as `${string}:${string}`, client: new ExactEvmScheme(signer as never) }], spendControls: { allowedAssets: [{ network: NETWORK as `${string}:${string}`, asset: ZUSDC, maxAmountPerPayment: "20000" }] } });
  const response = await wrapFetchWithPayment(fetch, client)(`${h.router.baseUrl}/x402/v1/routes/${ROUTE_ID}/resource`, { headers: principalHeaders() });
  expect(response.status).toBe(200);
  const created = (await h.journal()).find((r) => r.event === "created")!.patch as { source: { amount: string; pricing: { total: string } } };
  expect([paid, created.source.pricing.total]).toEqual([[created.source.amount], created.source.amount]);
});

test("AC-13: MCP の tool: 一覧の説明、`subject` の内訳、断りの理由", async () => {
  const { h } = await boot();
  const client = createRouterClient({ baseUrl: h.router.baseUrl, principalId: ALICE.id, token: ALICE.token, canonicalBaseUrl: "http://127.0.0.1:8500" } as never);
  const tools = createToolHandlers({ client, mode: "real", evidence: { label: "real", source: "router_listening_line", verified: true } } as never);
  const listing = await tools.listRoutes();
  expect(String(listing["demonstrationNote"])).toContain("priced per quote");
  const quoted = (await tools.quote({ routeId: ROUTE_ID, requestId: "mcp-1" })) as { ok: boolean; subject: { source: { amount: string }; pricing: Record<string, string> } };
  expect(quoted.subject.pricing).toMatchObject({ total: quoted.subject.source.amount, take: "500" });
});

test("AC-3・AC-11（子の Router）: ETH の価格が無い・片方だけ・期限切れ・形違い・未来でも起動し、新しい offer だけ 503。費用が読めなければ 503 で、注文の作成は 0", async () => {
  for (const env of [
    { ROUTER_SUBETHA_EXACT_ETH_PRICE: "" },
    { ROUTER_SUBETHA_EXACT_ETH_PRICE_AT: "" },
    { ROUTER_SUBETHA_EXACT_ETH_PRICE_AT: iso(Date.now() - 8 * 86_400_000) },
    { ROUTER_SUBETHA_EXACT_ETH_PRICE: "nope" },
    { ROUTER_SUBETHA_EXACT_ETH_PRICE_AT: iso(Date.now() + 3_600_000) },
  ]) {
    const { h } = await boot(env);
    const quote = await quoteOf(h, "req-1");
    expect([quote.status, quote.body]).toMatchObject([503, { error: "source_offer_unavailable", reason: "pricing_unavailable" }]);
    const entry = await fetch(`${h.router.baseUrl}/x402/v1/routes/${ROUTE_ID}/resource`, { headers: principalHeaders() });
    expect([entry.status, await entry.json()]).toEqual([503, { error: "source_offer_unavailable", reason: "pricing_unavailable" }]);
    const calls = await h.calls();
    expect([calls.byRoute["create"] ?? 0, calls.byRoute["costs"] ?? 0]).toEqual([0, 0]);
    const fixed = await fetch(`${h.router.baseUrl}/v1/quotes`, { method: "POST", headers: { ...principalHeaders(), "content-type": "application/json" }, body: JSON.stringify({ routeId: FIXED_ID, requestId: "fixed-1" }) });
    expect([fixed.status, ((await fixed.json()) as { source: { amount: string } }).source.amount]).toEqual([200, "12000"]);
    started.splice(started.findIndex((s) => s.h === h), 1);
    await h.stopAll();
  }
  const { h } = await boot();
  await setCosts(h, { status: 500 });
  expect((await quoteOf(h, "req-1")).status).toBe(503);
  expect((await h.calls()).byRoute["create"] ?? 0).toBe(0);
});

test("AC-12: settle 先の token が無い・上限が足りない設定は起動しない（固定文）", async () => {
  const base = configDocument("http://127.0.0.1:1", ROUTES) as { router: { budget: { buckets: { asset: string; maxPerPurchase: string }[] } } };
  const { h } = await boot();
  await expect(h.restartRouter({ env: { ROUTER_SUBETHA_EXACT_SETTLE_TOKEN_FILE: "" } })).rejects.toThrow(/SETTLE_TOKEN_FILE is required when a route uses pricing/);
  const small = structuredClone(base);
  small.router.budget.buckets[0]!.maxPerPurchase = "19999";
  await expect(h.restartRouter({ config: { ...configDocument(h.upstream.baseUrl, ROUTES), router: small.router } })).rejects.toThrow(/source budget bucket/);
});
