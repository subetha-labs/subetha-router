import { afterEach, expect, test, vi } from "vitest";
import { RouterClient, ROUTER_TIMEOUT_MS } from "../../src/router/client.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const input = { quoteId: "fixture-quote", requestId: "fixture-request", approval: "fixture-quote", credential: "fixture-only", quote: { fixture: true } };
test("H-1 purchase sends exact arguments once to copied configured URL without network", async () => {
  const messages: any[] = []; const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: URL, options: RequestInit) => {
    urls.push(String(url));
    const message = JSON.parse(String(options.body)); messages.push(message);
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } : { content: [{ type: "text", text: '{"ok":true,"outcome":"delivered"}' }], structuredContent: { ok: true, outcome: "delivered" } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "application/json" } });
  });
  const url = new URL("https://fixture.invalid/mcp"); const router = new RouterClient(url); url.hostname = "hostile.invalid";
  expect(await router.purchase(input)).toEqual({ ok: true, outcome: "delivered" });
  expect(urls.every(url => url === "https://fixture.invalid/mcp")).toBe(true);
  expect(messages.filter(m => m.method === "initialize")).toHaveLength(1);
  expect(messages.filter(m => m.method === "tools/call")).toEqual([expect.objectContaining({ params: { name: "subetha_router_purchase", arguments: input } })]);
});
test("absolute 30s deadline includes initialization and never retries purchase", async () => {
  vi.useFakeTimers(); let initializes = 0; let purchases = 0;
  vi.stubGlobal("fetch", async (_url: URL, options: RequestInit) => {
    const m = JSON.parse(String(options.body));
    if (m.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (m.method === "initialize") {
      initializes++; await new Promise(resolve => setTimeout(resolve, 20_000));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }), { headers: { "content-type": "application/json" } });
    }
    if (m.method !== "tools/call") return new Response(null, { status: 202 });
    purchases++; return new Promise((_resolve, reject) => { options.signal!.addEventListener("abort", () => reject(new Error("fixture abort")), { once: true }); });
  });
  const pending = new RouterClient(new URL("https://fixture.invalid/mcp")).purchase(input);
  await vi.advanceTimersByTimeAsync(ROUTER_TIMEOUT_MS);
  expect(await pending).toEqual({ ok: false, error: "router_unavailable" });
  expect(initializes).toBe(1); expect(purchases).toBe(1);
});
