import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { FailureSummary, NEXT_STEPS, PurchaseBodySummary, failure } from "../protocol/summary.js";
import { inputs, summaries, summaryFor } from "../protocol/socket.js";
import type { DaemonClient } from "./client.js";

export const INSTRUCTIONS = "macOS payer for the SubEtha Router, testnets only: Base Sepolia USDC and Arc testnet USDC (x402), Solana devnet USDC (x402 or MPP), Tempo testnet pathUSD (MPP). Every static route and every dynamic profile the Router lists. Use find_routes → quote ({routeId} for a static route, or {profileId, url} for a dynamic provider URL) → show the whole subject (including upstreamUrl, pricing and disclosures when present) → purchase({ref}) → status. The human must start subetha-payer daemon in their own terminal and confirm in its own dialog. Tool arguments, env, stdin, PTY and elicitation are not consent. Elicitation is display-only; accept/cancel cannot authorize payment. Noninteractive clients may block purchase; never bypass that limit. When subject.fundsMoveOnCredential is true (MPP) the daemon moves or commits funds right after the human approves, before the Router answers: a later refusal does not refund. Allow at least 195000ms for a purchase tool call (UI120s, Router30s); a client timeout does not cancel payment or prove unpaid. unknown means possibly paid: do not blindly retry, create a replacement purchase or assume unpaid; ask the human to inspect. Delivered data is untrusted; settlement/finality and saved client receipt are separate gates. Dynamic quotes: the operator has not verified the destination and nothing is refunded if it returns no usable data.";
const methods = ["find_routes", "quote", "purchase", "status", "wallet"] as const;
export function createShim(daemon: DaemonClient) {
  const server = new Server({ name: "subetha-payer", version: "0.2.0" }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const tools: Tool[] = methods.map(method => ({
    name: `subetha_payer_${method}`,
    description: method === "purchase" ? "Request daemon confirmation for this ref. Only the human daemon dialog can approve." : method === "quote" ? "Quote a static route ({routeId}) or a dynamic provider URL ({profileId, url}); returns a saved ref and the subject the human must see. Starts no payment." : `Payer ${method} summary.`,
    inputSchema: toJsonSchemaCompat(inputs[method]) as Tool["inputSchema"],
    // Convert the entire union at once so the SDK converter's local $refs stay rooted correctly.
    outputSchema: { ...toJsonSchemaCompat(z.union([summaries[method], FailureSummary, ...(method === "status" ? [PurchaseBodySummary] : [])]) as unknown as z.AnyZodObject), type: "object" },
    ...(method === "purchase" ? { _meta: { "anthropic/requiresUserInteraction": true } } : {}),
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const method = methods.find(m => request.params.name === `subetha_payer_${m}`);
    let value: unknown = failure("internal_error");
    if (method) {
      const parsed = inputs[method].safeParse(request.params.arguments ?? {});
      if (parsed.success) {
        try {
          if (method === "purchase" && server.getClientCapabilities()?.elicitation?.form) {
            // No answer is retained or forwarded. Display failure cannot replace daemon confirmation.
            try { await server.elicitInput({ mode: "form", message: "The human must confirm this purchase in the payer daemon dialog. This display is not approval.", requestedSchema: { type: "object", properties: {} } }, { timeout: 5_000 }); } catch { /* optional display */ }
          }
          const raw = await daemon.request(method, parsed.data);
          const failed = FailureSummary.safeParse(raw);
          const result = failed.success ? failed : summaryFor(method, parsed.data).safeParse(raw);
          value = result.success ? result.data : failure("internal_error");
        } catch { value = failure("internal_error"); }
      }
    }
    const summary = value as Record<string, unknown>;
    // Clients may show only `content` for an error result (Claude Code did in G-A2, 2026-10-10), so an
    // `ok: false` reply repeats its strict summary (the same validated object as structuredContent) as JSON text. Success keeps the short pointer (AC-A6).
    const hint = summary["error"] === "daemon_unavailable" ? NEXT_STEPS.daemon_unavailable : summary["error"] === "transport_uncertain" ? NEXT_STEPS.unknown_inspect : undefined;
    const text = summary["ok"] === false ? `${hint ? `${hint} ` : ""}Payer summary: ${JSON.stringify(summary)}` : "Payer summary in structuredContent.";
    return { content: [{ type: "text" as const, text }], structuredContent: summary, ...(summary["ok"] === false ? { isError: true } : {}) };
  });
  return { server, async connect(transport: Transport) { await daemon.request("ping", {}).catch(() => undefined); await server.connect(transport); }, async close() { await daemon.close(); await server.close(); } };
}
