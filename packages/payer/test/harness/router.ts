import { createServer } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { STATIC_ROUTE } from "../../src/router/client.js";

const asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const recipient = "0x1111111111111111111111111111111111111111";
export const destination = { rail: "mpp", network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", quoted: "10000", decimals: 6, payTo: "0x2222222222222222222222222222222222222222", quoteFingerprint: `sha256:${"cd".repeat(32)}` };

/** Shape from H-1 src/mcp/tools.ts approvalSubject/createToolHandlers, not the payer Summary shape. */
export function h1Quote() {
  const quoteId = `0x${"ab".repeat(32)}`;
  const paymentId = randomUUID();
  const deadlineMs = Math.floor(Date.now() / 1000) * 1000 + 120_000;
  const expiresAt = Math.floor(deadlineMs / 1000);
  const offer = { scheme: "exact", network: "eip155:84532", asset, amount: "10000", payTo: recipient, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2", challengeNonce: `0x${"ab".repeat(32)}`, expiresAt, routeBinding: [STATIC_ROUTE, "GET", `/v1/routes/${STATIC_ROUTE}/resource`].map(encodeURIComponent).join("|"), fundsMoveOnCredential: false } };
  const source = { rail: "x402", network: "eip155:84532", asset, amount: "10000", decimals: 6, payTo: recipient, expiresAt, offer };
  const resource = { url: "http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource", method: "GET" };
  const approval = { required: true, boundTo: quoteId, deadlineMs };
  const quote = { quoteId, paymentId, routeId: STATIC_ROUTE, resource, source, destination, approval };
  const subject = { quoteId, paymentId, routeId: STATIC_ROUTE, resource, source: { amount: source.amount, decimals: 6, asset, network: source.network, expiresAt, offer }, destination: { quoted: destination.quoted, asset: destination.asset, network: destination.network }, approval, fundsMoveOnCredential: false };
  return { ok: true, approvalRequired: true, quote, subject, nextStep: "Explicit human approval is required.", evidence: { label: "P-3a-fixture", source: "fixture", verified: false }, adapterMode: "synthetic" };
}

export async function fakeRouter(options: { observed?: (input: Record<string, unknown>) => void; beforeResponse?: () => Promise<void> } = {}) {
  const response = h1Quote();
  const state = {
    quote: response as Record<string, unknown>,
    status: { found: false, reason: "not_found", status: 404 } as Record<string, unknown>,
    delayMs: 0, textOnly: false, hang: false,
    calls: { initialize: 0, listRoutes: 0, quote: 0, status: 0, purchase: 0 },
    requestIds: [] as string[],
    purchases: [] as Record<string, unknown>[],
    body: { value: "x".repeat(2048) } as Record<string, unknown>,
  };
  const connections = new Set<Socket>();
  const transports = new Set<StreamableHTTPServerTransport>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const delay = () => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(); }, state.delayMs);
    timers.add(timer);
  });
  const http = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const mcp = new McpServer({ name: "h1-fixture", version: "0.1.0" });
    const result = async (value: Record<string, unknown>) => {
      if (state.hang) await new Promise<void>((resolve) => res.once("close", resolve));
      await delay();
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], ...(state.textOnly ? {} : { structuredContent: value }) };
    };
    mcp.registerTool("subetha_router_list_routes", { inputSchema: {} }, async () => {
      state.calls.listRoutes++;
      const source = response.quote.source;
      return result({ ok: true, routes: [{ routeId: STATIC_ROUTE, resource: response.quote.resource, source: { amount: source.amount, asset: source.asset, decimals: source.decimals, network: source.network, payTo: source.payTo }, destination: { rail: destination.rail, scheme: "tempo/charge", network: destination.network, asset: destination.asset } }] });
    });
    mcp.registerTool("subetha_router_quote", { inputSchema: { routeId: z.string(), requestId: z.string() } }, async ({ routeId, requestId }) => {
      state.calls.quote++;
      state.requestIds.push(requestId);
      return result(routeId === STATIC_ROUTE ? state.quote : { ok: false, error: "unknown_route", httpStatus: 404 });
    });
    mcp.registerTool("subetha_router_status", { inputSchema: { paymentId: z.string() } }, async () => { state.calls.status++; return result(state.status); });
    mcp.registerTool("subetha_router_purchase", { inputSchema: { quoteId: z.string(), requestId: z.string(), approval: z.string(), credential: z.string(), quote: z.record(z.unknown()) } }, async (input) => {
      options.observed?.(input);
      state.calls.purchase++; state.purchases.push(input);
      await options.beforeResponse?.();
      if (!state.requestIds.includes(input.requestId) || input.approval !== input.quoteId || input.quoteId !== input.quote["quoteId"] || input.credential !== "fixture-credential") return result({ ok: false, error: "approval_mismatch" });
      return result({ ok: true, outcome: "delivered", paymentId: input.quote["paymentId"], snapshot: state.body, contentType: "application/json" });
    });
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    transports.add(transport);
    try {
      await mcp.connect(transport as Transport);
      // Observe actual initialize messages without inventing a wire protocol.
      const onmessage = transport.onmessage;
      transport.onmessage = (message, extra) => {
        if ("method" in message && message.method === "initialize") state.calls.initialize++;
        onmessage?.(message, extra);
      };
      res.once("close", () => { transports.delete(transport); void mcp.close(); });
      await transport.handleRequest(req, res);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  http.on("connection", (socket) => { connections.add(socket); socket.on("close", () => connections.delete(socket)); });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("fixture_bind_failed");
  return { state, url: new URL(`http://127.0.0.1:${address.port}/mcp`), async close() {
    for (const timer of timers) clearTimeout(timer);
    for (const transport of transports) await transport.close();
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  } };
}
