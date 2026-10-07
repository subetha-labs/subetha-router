/**
 * client の要求の期限（multirail 設計 §4.4。タスク T7-a）: 購入は静的も動的も `executeTimeoutMs`（既定 180,000 ms）、
 * 静的 quote・status・一覧は `timeoutMs`（既定 10,000 ms）、動的 quote は 30,000 ms。signal を差し替えて期限の値を観測する。
 */
import { describe, expect, test } from "vitest";

import { createRouterClient, DEFAULT_DYNAMIC_EXECUTE_TIMEOUT_MS, DEFAULT_EXECUTE_TIMEOUT_MS } from "../../src/client/index.js";
import type { QuoteView } from "../../src/client/types.js";

function quoteOf(dynamic = false): QuoteView {
  return {
    quoteId: "q1",
    paymentId: "p1",
    routeId: "r",
    resource: { url: "https://router.test/v1/routes/r/resource", method: "GET" },
    approval: { required: true, boundTo: "q1", deadlineMs: Date.now() + 60_000 },
    source: { rail: "x402", amount: "1", asset: "A", decimals: 6, network: "eip155:84532", payTo: "P", expiresAt: 1, offer: {} },
    destination: { rail: "mpp", quoted: "1", asset: "B", network: "eip155:42431", quoteFingerprint: "sha256:x" },
    ...(dynamic ? { upstream: { url: "https://u.test/x" }, ownerKey: "k" } : {}),
  } as unknown as QuoteView;
}

function clientWith(options: { timeoutMs?: number; executeTimeoutMs?: number } = {}) {
  const deadlines: number[] = [];
  const client = createRouterClient({
    baseUrl: "https://router.test",
    principalId: "a",
    token: "b",
    allowUnissuedQuotes: true,
    ...options,
    signalForTest: (ms) => { deadlines.push(ms); return new AbortController().signal; },
    fetch: (async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  return { client, deadlines };
}

describe("client request deadlines", () => {
  test("購入の既定は 180,000 ms（静的も動的も）。別名の定数も同じ値", async () => {
    expect(DEFAULT_EXECUTE_TIMEOUT_MS).toBe(180_000);
    expect(DEFAULT_DYNAMIC_EXECUTE_TIMEOUT_MS).toBe(180_000);
    const { client, deadlines } = clientWith();
    await client.execute({ quote: quoteOf(false), requestId: "r", approval: { approved: true, quoteId: "q1" }, credential: "c" });
    await client.execute({ quote: quoteOf(true), requestId: "r", approval: { approved: true, quoteId: "q1" }, credential: "c" });
    expect(deadlines).toEqual([180_000, 180_000]);
  });

  test("明示の executeTimeoutMs は購入にだけ効き、timeoutMs は購入に効かない", async () => {
    const { client, deadlines } = clientWith({ timeoutMs: 2_000, executeTimeoutMs: 7_000 });
    await client.execute({ quote: quoteOf(false), requestId: "r", approval: { approved: true, quoteId: "q1" }, credential: "c" });
    await client.quote({ routeId: "r", requestId: "x" });
    await client.status("p1");
    await client.listRoutes();
    expect(deadlines).toEqual([7_000, 2_000, 2_000, 2_000]);
  });

  test("既定: 静的 quote・status・一覧は 10,000 ms、動的 quote は 30,000 ms", async () => {
    const { client, deadlines } = clientWith();
    await client.quote({ routeId: "r", requestId: "x" });
    await client.status("p1");
    await client.listRoutes();
    await client.quoteUrl({ profileId: "p", url: "https://u.test/x", requestId: "y" });
    expect(deadlines).toEqual([10_000, 10_000, 10_000, 30_000]);
  });
});
