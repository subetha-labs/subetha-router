import { createServer } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { Challenge } from "mppx";
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

/* ────────────────────────────────────────────────────────────────────────────
 * 0.2.0 rail fixtures (docs/payer-rails-design.md AC-R2/AC-R4): the hosted Router's quote shapes as observed on 2026-10-12, one per
 * inbound rail, static and dynamic. Amounts/recipients are synthetic; MPP challenges are real mppx documents whose `request` matches
 * the offer (the payer's dispatcher checks the contents; the HMAC is the Router's and is not checked by a payer).
 * ──────────────────────────────────────────────────────────────────────────── */
export const USDC_BASE = asset;
export const USDC_ARC = "0x3600000000000000000000000000000000000000";
export const PATHUSD = "0x20c0000000000000000000000000000000000000";
export const SOL_NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const USDC_SOL = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Router-side receivers of the hosted listing (public addresses). */
export const RECEIVER_EVM = "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2";
export const RECEIVER_ARC = "0xAF42CFfe4B35A05098613d962aF43CDc43fBb4Ea";
export const RECEIVER_SOL = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
export const UPSTREAM_PAYTO_EVM = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";
export const UPSTREAM_PAYTO_SOL = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const BASE_URL = "http://127.0.0.1:8500";
/** mppx-shaped ids (32 random bytes, base64url). */
export function mppxId(): string { return Buffer.from(randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "").slice(0, 32), "hex").toString("base64url"); }
const hexNonce = (): string => `0x${Buffer.from(randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), "hex").toString("hex")}`;

export type RailFixture = "base" | "tempo" | "arc" | "sol" | "solmpp" | "dyn-x402-to-mpp" | "dyn-mpp-to-x402" | "dyn-sol-to-x402" | "dyn-solmpp-to-x402" | "dyn-arc-to-x402";
interface Leg { rail: "x402" | "mpp"; scheme: "exact" | "tempo/charge" | "solana/charge"; network: string; asset: string; payTo: string }
const SOURCES: Record<string, Leg> = {
  x402: { rail: "x402", scheme: "exact", network: "eip155:84532", asset: USDC_BASE, payTo: RECEIVER_EVM },
  arc: { rail: "x402", scheme: "exact", network: "eip155:5042002", asset: USDC_ARC, payTo: RECEIVER_ARC },
  mpp: { rail: "mpp", scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, payTo: RECEIVER_EVM },
  sol: { rail: "x402", scheme: "exact", network: SOL_NET, asset: USDC_SOL, payTo: RECEIVER_SOL },
  solmpp: { rail: "mpp", scheme: "solana/charge", network: SOL_NET, asset: USDC_SOL, payTo: RECEIVER_SOL },
};
const DESTINATIONS: Record<string, Leg> = {
  x402: { rail: "x402", scheme: "exact", network: "eip155:84532", asset: USDC_BASE, payTo: UPSTREAM_PAYTO_EVM },
  arc: { rail: "x402", scheme: "exact", network: "eip155:5042002", asset: USDC_ARC, payTo: UPSTREAM_PAYTO_EVM },
  mpp: { rail: "mpp", scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, payTo: UPSTREAM_PAYTO_EVM },
  sol: { rail: "x402", scheme: "exact", network: SOL_NET, asset: USDC_SOL, payTo: UPSTREAM_PAYTO_SOL },
  solmpp: { rail: "mpp", scheme: "solana/charge", network: SOL_NET, asset: USDC_SOL, payTo: UPSTREAM_PAYTO_SOL },
};
const FIXTURES: Record<RailFixture, { routeId: string; source: string; destination: string; upstream?: string }> = {
  base: { routeId: "md-mpp-eth-snapshot", source: "x402", destination: "mpp" },
  tempo: { routeId: "md-x402-eth-snapshot", source: "mpp", destination: "x402" },
  arc: { routeId: "md-mpp-eth-snapshot-arc", source: "arc", destination: "mpp" },
  sol: { routeId: "md-x402-eth-snapshot-sol", source: "sol", destination: "x402" },
  solmpp: { routeId: "md-mpp-eth-snapshot-solmpp", source: "solmpp", destination: "mpp" },
  "dyn-x402-to-mpp": { routeId: "dyn-x402-to-mpp", source: "x402", destination: "mpp", upstream: "https://provider-mpp.subethalabs.com/v1/eth/snapshot" },
  "dyn-mpp-to-x402": { routeId: "dyn-mpp-to-x402", source: "mpp", destination: "x402", upstream: "https://x402.vercel.app/protected" },
  "dyn-sol-to-x402": { routeId: "dyn-sol-to-x402", source: "sol", destination: "x402", upstream: "https://x402.vercel.app/protected" },
  "dyn-solmpp-to-x402": { routeId: "dyn-solmpp-to-x402", source: "solmpp", destination: "x402", upstream: "https://x402.vercel.app/protected" },
  "dyn-arc-to-x402": { routeId: "dyn-arc-to-x402", source: "arc", destination: "x402", upstream: "https://x402.vercel.app/protected" },
};
export const UPSTREAM_OF = (fixture: RailFixture): string | undefined => FIXTURES[fixture].upstream;

function offerExtra(src: Leg, nonce: string, expiresAt: number, routeBinding: string, amount: string): Record<string, unknown> {
  const common = { challengeNonce: nonce, expiresAt, routeBinding, fundsMoveOnCredential: src.rail === "mpp" };
  // Circle-facilitated Arc offers carry assetTransferMethod (Router x402 adapter, facilitator kind `circle`).
  if (src.scheme === "exact" && src.network.startsWith("eip155:")) return { name: "USDC", version: "2", ...(src.network === "eip155:5042002" ? { assetTransferMethod: "eip3009" } : {}), ...common };
  if (src.scheme === "exact") return { feePayer: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", memo: nonce, ...common };
  const expires = new Date((expiresAt - 1) * 1000).toISOString();
  if (src.scheme === "tempo/charge") {
    const challenge = Challenge.serialize(Challenge.from({ id: nonce, realm: "MPP Payment", method: "tempo", intent: "charge", expires, request: { amount, currency: src.asset, recipient: src.payTo, methodDetails: { chainId: 42431, supportedModes: ["push"] } } } as never) as never);
    return { ...common, challenge };
  }
  const externalId = `pay-${nonce.slice(0, 22)}`;
  const challenge = Challenge.serialize(Challenge.from({ id: nonce, realm: "MPP Payment", method: "solana", intent: "charge", expires, request: { amount, currency: src.asset, recipient: src.payTo, externalId, methodDetails: { network: "devnet", decimals: 6, tokenProgram: TOKEN_PROGRAM, feePayer: false } } } as never) as never);
  return { ...common, challenge, externalId, decimals: 6, tokenProgram: TOKEN_PROGRAM };
}

const DISCLOSURES = (mpp: boolean, gasIndexed: boolean) => ({
  destinationVerifiedByOperator: false, refundOnFailure: false, fundsMoveOnCredential: mpp,
  ...(mpp ? { routerMayRejectAfterFundsMoved: ["expired", "upstream_changed", "dynamic_disabled", "budget_exhausted", "operator_funds_unavailable", ...(gasIndexed ? ["fee_too_high", "fee_estimate_unavailable"] : [])] } : {}),
  ...(gasIndexed ? { feeEstimateIsNotADeliveryGuarantee: true, routerMayRejectAfterSettle: ["fee_too_high"] } : {}),
  awaitingPaymentDoesNotMeanUnpaid: mpp, unsupportedResponseIsPaidWithoutData: true, supportedResponse: "application/json object, <= 256 KiB",
});

/** A hosted-shaped quote response for one rail fixture (static or dynamic), fresh ids and deadlines per call. */
export function railQuote(fixture: RailFixture, overrides: { upstreamAmount?: string; fee?: string } = {}) {
  const f = FIXTURES[fixture]; const src = SOURCES[f.source]!; const dst = DESTINATIONS[f.destination]!;
  const dynamic = f.upstream !== undefined;
  const nonce = src.rail === "mpp" ? mppxId() : hexNonce();
  const paymentId = randomUUID();
  const deadlineMs = Math.floor(Date.now() / 1000) * 1000 + 600_000;
  const expiresAt = Math.floor(deadlineMs / 1000);
  const routeBinding = dynamic ? ["dynamic", f.routeId, "GET", f.upstream!].map(encodeURIComponent).join("|") : [f.routeId, "GET", `/v1/routes/${f.routeId}/resource`].map(encodeURIComponent).join("|");
  const upstreamAmount = overrides.upstreamAmount ?? "10000", fee = overrides.fee ?? "1000";
  const amount = dynamic ? String(BigInt(upstreamAmount) + BigInt(fee)) : "10000";
  const offer = { scheme: src.scheme, network: src.network, asset: src.asset, amount, payTo: src.payTo, maxTimeoutSeconds: 600, extra: offerExtra(src, nonce, expiresAt, routeBinding, amount) };
  const source = { rail: src.rail, amount, asset: src.asset, decimals: 6, network: src.network, payTo: src.payTo, expiresAt, offer };
  const destinationLeg = { rail: dst.rail, quoted: upstreamAmount, asset: dst.asset, decimals: 6, network: dst.network, payTo: dst.payTo, quoteFingerprint: `sha256:${Buffer.from(randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""), "hex").toString("hex")}` };
  const resource = { url: `${BASE_URL}/v1/routes/${f.routeId}/resource`, method: "GET" };
  const approval = { required: true, boundTo: nonce, deadlineMs };
  const gasIndexed = dynamic && dst.scheme === "tempo/charge";
  const pricing = dynamic ? { upstreamAmount, converted: upstreamAmount, fee, total: amount, ...(gasIndexed ? { maxFee: "158", estimate: { gas: "54399", maxFeePerGas: "1440000001", bound: "79", atMs: Date.now() } } : {}), sourceDecimals: 6, destinationDecimals: 6 } : undefined;
  const disclosures = dynamic ? DISCLOSURES(src.rail === "mpp", gasIndexed) : undefined;
  const ownerKey = dynamic ? mppxId() : undefined;
  const quote = { quoteId: nonce, paymentId, routeId: f.routeId, resource, source, destination: destinationLeg, approval,
    ...(dynamic ? { upstream: { url: f.upstream!, method: "GET" }, pricing, disclosures, ownerKey } : {}) };
  const subject = { quoteId: nonce, paymentId, routeId: f.routeId, resource, source: { amount, decimals: 6, asset: src.asset, network: src.network, expiresAt, offer },
    destination: { quoted: upstreamAmount, asset: dst.asset, network: dst.network }, approval, fundsMoveOnCredential: src.rail === "mpp",
    ...(dynamic ? { upstream: { url: f.upstream!, method: "GET" }, destinationPayTo: dst.payTo, destinationDecimals: 6, pricing, disclosures } : {}) };
  return { ok: true, approvalRequired: true, quote, subject, nextStep: "Explicit human approval is required.", evidence: { label: "rails-fixture", source: "fixture", verified: false }, adapterMode: "synthetic" };
}
export type RailQuoteResponse = ReturnType<typeof railQuote>;

/** The hosted listing (10 static routes + the dynamic profiles the fixtures use). `withRail` adds `source.rail`/`scheme` (Routers from R-0 on). */
export function railListing(withRail: boolean) {
  const statics = ["base", "tempo", "arc", "sol", "solmpp"] as const;
  const routes = statics.map((name) => { const f = FIXTURES[name]; const src = SOURCES[f.source]!; const dst = DESTINATIONS[f.destination]!;
    return { routeId: f.routeId, resource: { url: `${BASE_URL}/v1/routes/${f.routeId}/resource`, method: "GET" },
      source: { amount: "10000", asset: src.asset, decimals: 6, network: src.network, payTo: src.payTo, ...(withRail ? { rail: src.rail, scheme: src.scheme } : {}) },
      destination: { rail: dst.rail, scheme: dst.scheme, network: dst.network, asset: dst.asset } }; });
  // The x402-on-Solana static route exists next to the MPP-on-Solana one with an identical source leg (FR-R13).
  const profiles = (["dyn-x402-to-mpp", "dyn-mpp-to-x402", "dyn-sol-to-x402", "dyn-solmpp-to-x402", "dyn-arc-to-x402"] as const).map((name) => { const f = FIXTURES[name]; const src = SOURCES[f.source]!; const dst = DESTINATIONS[f.destination]!;
    return { profileId: f.routeId, source: { rail: src.rail, network: src.network, asset: src.asset, decimals: 6, payTo: src.payTo }, destination: { rail: dst.rail, scheme: dst.scheme, network: dst.network, asset: dst.asset, decimals: 6 },
      maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" }, disclosures: DISCLOSURES(src.rail === "mpp", dst.scheme === "tempo/charge"), resource: { url: `${BASE_URL}/v1/routes/${f.routeId}/resource`, method: "GET" } }; });
  return { ok: true, routes, dynamic: { enabled: true, profiles } };
}

export async function fakeRouter(options: { observed?: (input: Record<string, unknown>) => void; beforeResponse?: () => Promise<void> } = {}) {
  const response = h1Quote();
  const state = {
    quote: response as Record<string, unknown>,
    /** Per-routeId / profileId fixtures for `quote` / `quote_url` (falls back to `quote` for the static route). */
    quotes: new Map<string, Record<string, unknown>>(),
    /** `quote_url` answers only when the URL matches the fixture's upstream (any other URL: offer_unavailable). */
    upstreams: new Map<string, string>(),
    status: { found: false, reason: "not_found", status: 404 } as Record<string, unknown>,
    /** Per-paymentId status answers; `ownerKey` (when set) must match or the Router answers not_found (dynamic ownership). */
    statuses: new Map<string, { ownerKey?: string; value: Record<string, unknown> }>(),
    /** Whether the hosted listing carries `source.rail`/`scheme` on static routes (R-0). */
    listingWithRail: false, listing: undefined as Record<string, unknown> | undefined,
    /** Wrap a dynamic purchase's body like the hosted MCP (`result: { untrusted, source, contentType, body }`). */
    wrapDynamicResult: true,
    delayMs: 0, textOnly: false, hang: false,
    calls: { initialize: 0, listRoutes: 0, quote: 0, quoteUrl: 0, status: 0, purchase: 0 },
    requestIds: [] as string[],
    statusPaymentIds: [] as string[],
    statusOwnerKeys: [] as (string | undefined)[],
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
  const quoteFor = (id: string): Record<string, unknown> | undefined => state.quotes.get(id) ?? (id === STATIC_ROUTE ? state.quote : undefined);
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
      if (state.listing) return result(state.listing);
      const source = response.quote.source;
      return result({ ok: true, routes: [{ routeId: STATIC_ROUTE, resource: response.quote.resource, source: { amount: source.amount, asset: source.asset, decimals: source.decimals, network: source.network, payTo: source.payTo, ...(state.listingWithRail ? { rail: "x402", scheme: "exact" } : {}) }, destination: { rail: destination.rail, scheme: "tempo/charge", network: destination.network, asset: destination.asset } }] });
    });
    mcp.registerTool("subetha_router_quote", { inputSchema: { routeId: z.string(), requestId: z.string() } }, async ({ routeId, requestId }) => {
      state.calls.quote++;
      state.requestIds.push(requestId);
      const value = routeId.startsWith("dyn-") ? undefined : quoteFor(routeId);
      return result(value ?? { ok: false, error: "unknown_route", httpStatus: 404 });
    });
    mcp.registerTool("subetha_router_quote_url", { inputSchema: { profileId: z.string(), url: z.string(), requestId: z.string() } }, async ({ profileId, url, requestId }) => {
      state.calls.quoteUrl++;
      state.requestIds.push(requestId);
      const value = quoteFor(profileId);
      if (!value || !profileId.startsWith("dyn-")) return result({ ok: false, error: "unknown_route", httpStatus: 404 });
      if (state.upstreams.get(profileId) !== url) return result({ ok: false, error: "quote_failed", reason: "offer_unavailable", httpStatus: 502 });
      return result(value);
    });
    mcp.registerTool("subetha_router_status", { inputSchema: { paymentId: z.string(), ownerKey: z.string().optional() } }, async ({ paymentId, ownerKey }) => {
      state.calls.status++; state.statusPaymentIds.push(paymentId); state.statusOwnerKeys.push(ownerKey);
      const entry = state.statuses.get(paymentId);
      if (entry) return result(entry.ownerKey !== undefined && entry.ownerKey !== ownerKey ? { found: false, reason: "not_found", status: 404 } : entry.value);
      return result(state.status);
    });
    mcp.registerTool("subetha_router_purchase", { inputSchema: { quoteId: z.string(), requestId: z.string(), approval: z.string(), credential: z.string(), quote: z.record(z.unknown()) } }, async (input) => {
      options.observed?.(input);
      state.calls.purchase++; state.purchases.push(input);
      await options.beforeResponse?.();
      if (!state.requestIds.includes(input.requestId) || input.approval !== input.quoteId || input.quoteId !== input.quote["quoteId"] || input.credential !== "fixture-credential") return result({ ok: false, error: "approval_mismatch" });
      const dynamic = typeof input.quote["routeId"] === "string" && (input.quote["routeId"] as string).startsWith("dyn-");
      if (dynamic && state.wrapDynamicResult) return result({ ok: true, outcome: "delivered", paymentId: input.quote["paymentId"], result: { untrusted: true, source: "upstream", contentType: "application/json", body: state.body }, proof: { upstreamReceipt: "claimed", onChainFinality: "not_checked" } });
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
  /** Register a rail fixture so `quote`/`quote_url` serve it (dynamic: also its upstream URL). */
  const useFixture = (fixture: RailFixture, value: RailQuoteResponse = railQuote(fixture)) => {
    state.quotes.set(value.quote.routeId, value as unknown as Record<string, unknown>);
    const upstream = UPSTREAM_OF(fixture); if (upstream) state.upstreams.set(value.quote.routeId, upstream);
    return value;
  };
  return { state, useFixture, url: new URL(`http://127.0.0.1:${address.port}/mcp`), async close() {
    for (const timer of timers) clearTimeout(timer);
    for (const transport of transports) await transport.close();
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  } };
}
