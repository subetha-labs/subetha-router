/**
 * hosted の `subetha-exact` の実証（`docs/hosted-exact-enable-design.md` §9 T-e、要件 AC-2〜AC-4）: 公開の入口（MCP の ingress + 標準 x402 の proxy）を
 * 実 `startRouter` の child と合成 facilitator・x402 上流の前に置き、**実物の `@x402/fetch` が ingress の URL だけで買える**（Router の principal を知らない）ことを確かめる。
 * 設定は hosted の生成と同じ形（`offerCap`、送信元ごとの上限、`unansweredVerifyIsUnknown`、公開の基点）。
 * この試験は Caddy を持たない: `X-Forwarded-For` の末尾を買い手が決められる構成なので、「偽の値で枠が増えない」ことは本番の Caddy の設定の確認（要件 AC-6）で見る。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

vi.setConfig({ testTimeout: 120_000 });

import { createMcpIngress } from "../../src/mcp/ingress.js";
import { sourceOfRequest } from "../../src/mcp/server.js";
import { createX402Proxy } from "../../src/mcp/x402-proxy.js";
import { ALICE, CHAIN_ID, configDocument, DEST_PAY_TO, NETWORK, principalHeaders, ROUTE_ID, startExactHarness, USDC, ZUSDC, type ExactHarness } from "../fixtures/subetha-exact-harness.js";

const PUBLIC_ORIGIN = "https://router.example.test";
const PATH = `/x402/v1/routes/${ROUTE_ID}/resource`;
const started: ExactHarness[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const h of started.splice(0)) await h.stopAll();
});

function hostedConfig(upstreamBaseUrl: string, maxCommitted: number): Record<string, unknown> {
  const routes = {
    [ROUTE_ID]: {
      routeId: ROUTE_ID,
      canonicalPath: `/v1/routes/${ROUTE_ID}/resource`,
      rail: "x402",
      sourceRail: "subetha-exact",
      offerCap: { maxCommitted },
      source: { amount: "2000", asset: ZUSDC, decimals: 6, network: NETWORK },
      destination: { scheme: "exact", network: NETWORK, asset: USDC, payTo: DEST_PAY_TO },
    },
  };
  return { ...configDocument(upstreamBaseUrl, routes), subethaExact: { limits: { maxRequestsTotal: 300, maxUnresolved: 6, requestsPerMinute: 60, maxUnresolvedPerSource: 3, requestsPerMinutePerSource: 30 }, unansweredVerifyIsUnknown: true } };
}
/** harness（Router の child・合成 facilitator・上流）を hosted の形の設定で起動し、その前に公開の入口を置く。 */
async function boot(maxCommitted = 10): Promise<{ h: ExactHarness; publicUrl: string; restart: (cap: number) => Promise<void> }> {
  const h = await startExactHarness({ skipRouter: true });
  started.push(h);
  const env = { ROUTER_X402_ENTRY_BASE_URL: PUBLIC_ORIGIN };
  await h.restartRouter({ config: hostedConfig(h.upstream.baseUrl, maxCommitted), env });
  let proxy = createX402Proxy({ routeIds: [ROUTE_ID], childBaseUrl: h.router.baseUrl, principalId: ALICE.id, token: ALICE.token, sourceOf: (request) => sourceOfRequest(request.headers, request.socket.remoteAddress) });
  const ingress = createMcpIngress({ handle: async (_request, response) => void response.writeHead(404).end(), x402Proxy: (request, response) => proxy(request, response) });
  servers.push(ingress);
  await new Promise<void>((resolve) => ingress.listen(0, "127.0.0.1", () => resolve()));
  const publicUrl = `http://127.0.0.1:${(ingress.address() as AddressInfo).port}`;
  return {
    h,
    publicUrl,
    async restart(cap) {
      await h.restartRouter({ config: hostedConfig(h.upstream.baseUrl, cap), env });
      proxy = createX402Proxy({ routeIds: [ROUTE_ID], childBaseUrl: h.router.baseUrl, principalId: ALICE.id, token: ALICE.token, sourceOf: (request) => sourceOfRequest(request.headers, request.socket.remoteAddress) });
    },
  };
}
/** 実物のクライアント: signer・network・zUSDC を払ってよい資産に足す設定だけ。Router の principal も独自のヘッダーも持たない。 */
function standardClient() {
  const account = privateKeyToAccount(generatePrivateKey());
  let signatures = 0;
  const signer = { address: account.address, signTypedData: async (args: Parameters<typeof account.signTypedData>[0]) => { signatures += 1; return account.signTypedData(args); } };
  const client = x402Client.fromConfig({
    schemes: [{ network: NETWORK as `${string}:${string}`, client: new ExactEvmScheme(signer as never) }],
    spendControls: { allowedAssets: [{ network: NETWORK as `${string}:${string}`, asset: ZUSDC, maxAmountPerPayment: "20000" }] },
  });
  const exchanges: { status: number; sent: Record<string, string>; received: Record<string, string> }[] = [];
  const recording: typeof fetch = async (input, init) => {
    const request = new Request(input as Parameters<typeof fetch>[0] as string, init);
    const response = await fetch(request.clone());
    exchanges.push({ status: response.status, sent: Object.fromEntries(request.headers.entries()), received: Object.fromEntries(response.headers.entries()) });
    return response;
  };
  return { account, exchanges, signatures: () => signatures, fetchWithPayment: wrapFetchWithPayment(recording, client) };
}
/** 上流（x402 の合成 Provider）が受けた支払いつきの要求の数。 */
const upstreamPays = async (h: ExactHarness): Promise<number> => ((await (await fetch(`${h.upstream.baseUrl}/calls`)).json()) as { payCalls: number }).payCalls;
const unpaid = (publicUrl: string, forwardedFor?: string, extra: Record<string, string> = {}) => fetch(`${publicUrl}${PATH}`, { headers: { ...(forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor }), ...extra } });

test("AC-2: 実物の標準クライアントが公開の入口の URL だけで買える（principal を知らない）。`resource.url` と一覧の `x402Url` は公開の origin。記録に生の送信元は残らない", async () => {
  const { h, publicUrl } = await boot();
  const c = standardClient();
  const response = await c.fetchWithPayment(`${publicUrl}${PATH}`);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { data: { price: string } }).data.price).toBe("3000.12");
  expect([c.exchanges.map((e) => e.status), c.signatures()]).toEqual([[402, 200], 1]);
  // クライアントは Router の認証も独自のヘッダーも送っていない。
  for (const e of c.exchanges) expect(Object.keys(e.sent).filter((k) => k.startsWith("x-router") || k === "authorization")).toEqual([]);
  const required = decodePaymentRequiredHeader(c.exchanges[0]!.received["payment-required"]!) as unknown as { resource: { url: string }; accepts: Record<string, unknown>[] };
  expect(required.resource.url).toBe(`${PUBLIC_ORIGIN}${PATH}`);
  expect(decodePaymentResponseHeader(c.exchanges[1]!.received["payment-response"]!)).toMatchObject({ success: true, network: NETWORK, payer: c.account.address });
  expect(Object.keys(c.exchanges[1]!.received).filter((k) => k.startsWith("x-router"))).toEqual(["x-router-payment-id"]);
  // 一覧（Router の本体。MCP の list_routes が読むもの）: 公開の URL と、実証の注記。
  const listing = (await (await fetch(`${h.router.baseUrl}/v1/routes`, { headers: principalHeaders() })).json()) as { routes: Record<string, unknown>[] };
  expect(listing.routes[0]).toMatchObject({ routeId: ROUTE_ID, x402Url: `${PUBLIC_ORIGIN}${PATH}`, demonstration: { capped: true, acceptingNewOffers: true } });
  // ledger の requested に送信元の tag（16 hex）。生の address は journal にも ledger にも無い。
  const requested = (await h.ledger()).find((r) => r.event === "requested")!;
  expect(String(requested.patch["sourceTag"])).toMatch(/^[0-9a-f]{16}$/);
  const text = JSON.stringify(await h.journal()) + JSON.stringify(await h.ledger());
  expect(text).not.toContain("addr:127.0.0.1");
  expect(text).not.toContain("fwd:");
});

test("AC-3: 送信元ごとの占有（1 つの送信元は未払いの offer 2 つまで → 429、注文は増えない）。買い手が送った `x-router-source` では変えられない。別の送信元は通る。quote の入口も同じ数え方で 429 `rate_limited`", async () => {
  const { h, publicUrl } = await boot();
  expect([(await unpaid(publicUrl)).status, (await unpaid(publicUrl)).status]).toEqual([402, 402]);
  const limited = await unpaid(publicUrl, undefined, { "x-router-source": "fwd:198.51.100.77", "x-router-principal": "someone", authorization: "Bearer nope" });
  expect([limited.status, await limited.json()]).toEqual([429, { error: "rate_limited", reason: "limit_source_unresolved" }]);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(limited.headers.get("payment-required")).toBeNull();
  expect((await h.calls()).byRoute["create"]).toBe(2);
  // 別の送信元（信頼する proxy が足す値が違う）は通る。
  expect((await unpaid(publicUrl, "203.0.113.9")).status).toBe(402);
  // quote の入口（MCP が使う Router の本体の口）も、同じ送信元なら同じ上限で 429 `rate_limited`。別の送信元なら通る。
  const quote = (source: string, requestId: string) =>
    fetch(`${h.router.baseUrl}/v1/quotes`, { method: "POST", headers: { ...principalHeaders(), "content-type": "application/json", "x-router-source": source }, body: JSON.stringify({ routeId: ROUTE_ID, requestId }) });
  const sameSource = await quote("fwd:203.0.113.9", "req-1");
  expect(sameSource.status).toBe(200);
  const third = await quote("fwd:203.0.113.9", "req-2");
  expect([third.status, await third.json()]).toMatchObject([429, { error: "rate_limited", reason: "limit_source_unresolved", retryAfterMs: 300_000 }]);
  expect((await quote("fwd:192.0.2.5", "req-3")).status).toBe(200);
  expect((await h.calls()).byRoute["create"]).toBe(5);
});

test("AC-3／H-9: offer の上限に達したら 503（402 ではない・注文は増えない）。発行済みの offer は払える。上限 0 で起動し直すと新しい offer は出ないが、発行済みの注文への支払いと同じ credential の再送は通る", async () => {
  const { h, publicUrl, restart } = await boot(2);
  // 2 つの送信元から 1 つずつ（送信元ごとの占有に当たらないように）。
  const c = standardClient();
  expect((await unpaid(publicUrl, "203.0.113.1")).status).toBe(402);
  const first = await fetch(`${publicUrl}${PATH}`, { headers: { "x-forwarded-for": "203.0.113.2" } });
  expect(first.status).toBe(402);
  const capped = await unpaid(publicUrl, "203.0.113.3");
  expect([capped.status, await capped.json()]).toEqual([503, { error: "source_offer_unavailable", reason: "offer_cap_reached" }]);
  expect(capped.headers.get("payment-required")).toBeNull();
  expect((await fetch(`${h.router.baseUrl}/v1/quotes`, { method: "POST", headers: { ...principalHeaders(), "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId: "req-cap" }) })).status).toBe(503);
  expect((await h.calls()).byRoute["create"]).toBe(2);
  // 実物のクライアントは、上限に達した入口では署名しない。
  expect((await c.fetchWithPayment(`${publicUrl}${PATH}`, { headers: { "x-forwarded-for": "203.0.113.4" } })).status).toBe(503);
  expect(c.signatures()).toBe(0);

  // 受付停止（上限 0）で起動し直す: 発行済みの offer への支払いは通る。新しい offer は出ない。一覧は受付停止を示す。
  await restart(0);
  const accepted = (decodePaymentRequiredHeader(first.headers.get("payment-required")!) as unknown as { accepts: Record<string, unknown>[] }).accepts[0]!;
  const account = privateKeyToAccount(generatePrivateKey());
  const extra = accepted["extra"] as { name: string; version: string };
  const authorization = { from: account.address, to: accepted["payTo"] as `0x${string}`, value: String(accepted["amount"]), validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + Number(accepted["maxTimeoutSeconds"])), nonce: `0x${"7c".repeat(32)}` as `0x${string}` };
  const signature = await account.signTypedData({
    domain: { name: extra.name, version: extra.version, chainId: CHAIN_ID, verifyingContract: ZUSDC as `0x${string}` },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  });
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { authorization, signature } }), "utf8").toString("base64");
  const paid = await fetch(`${publicUrl}${PATH}`, { headers: { "PAYMENT-SIGNATURE": header } });
  expect(paid.status).toBe(200);
  expect((await fetch(`${publicUrl}${PATH}`, { headers: { "PAYMENT-SIGNATURE": header } })).status).toBe(200);
  const stopped = await unpaid(publicUrl, "203.0.113.5");
  expect([stopped.status, ((await stopped.json()) as { reason: string }).reason]).toEqual([503, "offer_cap_reached"]);
  const listing = (await (await fetch(`${h.router.baseUrl}/v1/routes`, { headers: principalHeaders() })).json()) as { routes: Record<string, unknown>[] };
  expect(listing.routes[0]).toMatchObject({ demonstration: { capped: true, acceptingNewOffers: false } });
  const calls = await h.calls();
  expect([calls.byRoute["create"], calls.byRoute["submit"]]).toEqual([2, 1]);
});

test("AC-4: 購入の途中で買い手の接続が切れても（入れ替えで Caddy が先に止まる場合に当たる）、購入は Router の中で終わりまで進み、同じ credential の再送が結果を返す。settle は 1 回", async () => {
  const { h, publicUrl } = await boot();
  const first = await unpaid(publicUrl);
  const accepted = (decodePaymentRequiredHeader(first.headers.get("payment-required")!) as unknown as { accepts: Record<string, unknown>[] }).accepts[0]!;
  const account = privateKeyToAccount(generatePrivateKey());
  const extra = accepted["extra"] as { name: string; version: string };
  const authorization = { from: account.address, to: accepted["payTo"] as `0x${string}`, value: String(accepted["amount"]), validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + Number(accepted["maxTimeoutSeconds"])), nonce: `0x${"8d".repeat(32)}` as `0x${string}` };
  const signature = await account.signTypedData({
    domain: { name: extra.name, version: extra.version, chainId: CHAIN_ID, verifyingContract: ZUSDC as `0x${string}` },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  });
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { authorization, signature } }), "utf8").toString("base64");
  // verify を遅らせ、その間に買い手の socket を切る。
  await h.setMode("verify", "slow:700");
  const { port } = new URL(publicUrl);
  const socket = net.connect(Number(port), "127.0.0.1", () => socket.write(`GET ${PATH} HTTP/1.1\r\nHost: x\r\nPAYMENT-SIGNATURE: ${header}\r\n\r\n`));
  const until = Date.now() + 10_000;
  while (((await h.calls()).byRoute["verify"] ?? 0) === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  socket.destroy();
  // 購入は進む: journal が delivered になるまで待つ。
  while (!(await h.journal()).some((r) => r.event === "delivered") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  expect((await h.journal()).map((r) => r.event)).toContain("delivered");
  const again = await fetch(`${publicUrl}${PATH}`, { headers: { "PAYMENT-SIGNATURE": header } });
  expect(again.status).toBe(200);
  expect(((await again.json()) as { data: { price: string } }).data.price).toBe("3000.12");
  const calls = await h.calls();
  expect([calls.byRoute["verify"], calls.byRoute["submit"]]).toEqual([1, 1]);
});

test("release の再試行 AC-8: facilitator の release と照会が 3 秒間 502（daemon の再起動）でも、公開の入口から買った標準クライアントに delivered が届く（proxy の期限の内）。settle は 1 回、上流への支払いは 1 回", async () => {
  const { h, publicUrl } = await boot();
  const c = standardClient();
  const until = Math.floor(Date.now() / 1000) + 3;
  await h.setMode("release", `down-until:${until}`);
  await h.setMode("status", `down-until:${until}`);
  const startedAt = performance.now();
  const response = await c.fetchWithPayment(`${publicUrl}${PATH}`);
  const elapsed = performance.now() - startedAt;
  expect(response.status).toBe(200);
  expect(elapsed).toBeLessThan(170_000);
  const calls = await h.calls();
  expect(calls.byRoute["submit"]).toBe(1);
  expect(calls.byRoute["release"]).toBeGreaterThanOrEqual(2);
  const journal = await h.journal();
  expect(journal.filter((r) => r.event === "delivered")).toHaveLength(1);
  expect(journal.filter((r) => r.event === "source_released")).toHaveLength(1);
  expect(journal.filter((r) => r.event === "paid_undelivered")).toHaveLength(0);
  const release = (await h.ledger()).filter((r) => r.event === "release").at(-1)!.patch;
  expect(release).toMatchObject({ outcome: "released" });
  expect(Number(release["attempts"])).toBeGreaterThanOrEqual(2);
  expect(Number(release["wallMs"])).toBeGreaterThanOrEqual(1_000);
  expect(await upstreamPays(h)).toBe(1);
});

test("release の再試行 AC-4: 1 回目の release が facilitator で通って応答を失い、照会も 1 回 502 → 2 回目の release が 409 already-claimed → 復元で delivered。settle も上流への支払いも 1 回", async () => {
  const { h, publicUrl } = await boot();
  const c = standardClient();
  await h.setMode("release", "lose-response");
  await h.setMode("status", "error-n:1");
  const response = await c.fetchWithPayment(`${publicUrl}${PATH}`);
  expect(response.status).toBe(200);
  const calls = await h.calls();
  expect([calls.byRoute["submit"], calls.byRoute["release"], calls.byRoute["status"]]).toEqual([1, 2, 2]);
  expect((await h.ledger()).filter((r) => r.event === "release").at(-1)!.patch).toMatchObject({ outcome: "released", reconstructed: true, attempts: 2, probes: 2 });
  expect(await upstreamPays(h)).toBe(1);
});

test("release の再試行 AC-6: 照会が決まった答え（401）なら続けず、上流へは送らない（paid_undelivered・source_release_unknown）。settle は 1 回", async () => {
  const { h, publicUrl } = await boot();
  const c = standardClient();
  await h.setMode("release", "raw", { status: 502, body: {} });
  await h.setMode("status", "raw", { status: 401, body: { error: "unauthorized" } });
  const response = await c.fetchWithPayment(`${publicUrl}${PATH}`);
  expect(response.status).not.toBe(200);
  const calls = await h.calls();
  expect([calls.byRoute["submit"], calls.byRoute["release"], calls.byRoute["status"]]).toEqual([1, 1, 1]);
  const journal = await h.journal();
  expect(journal.filter((r) => r.event === "delivered")).toHaveLength(0);
  expect(journal.find((r) => r.event === "paid_undelivered")?.patch).toMatchObject({ outcome: "not_sent", reason: "source_release_unknown" });
  expect(await upstreamPays(h)).toBe(0);
});
