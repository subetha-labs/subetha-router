/**
 * MCP の静的 quote の `nextStep` にレールの補足（Solana・Arc）が載る（multirail 設計 §7、AC-6。タスク T7-a）。英語。EVM の文面は変えない。
 */
import { describe, expect, test } from "vitest";

import type { RouterClient } from "../../src/client/index.js";
import type { QuoteView } from "../../src/client/types.js";
import { createToolHandlers, type Evidence } from "../../src/mcp/tools.js";

const EVIDENCE: Evidence = { label: "test", source: "operator_asserted", verified: false };

function quoteWith(network: string, fundsMoveOnCredential = false): QuoteView {
  return {
    quoteId: "q1",
    paymentId: "p1",
    routeId: "r",
    resource: { url: "https://router.test/v1/routes/r/resource", method: "GET" },
    approval: { required: true, boundTo: "q1", deadlineMs: Date.now() + 60_000 },
    source: { rail: "x402", amount: "10000", asset: "A", decimals: 6, network, payTo: "P", expiresAt: 1, offer: { scheme: "exact", network, asset: "A", amount: "10000", payTo: "P", maxTimeoutSeconds: 40, extra: { challengeNonce: "0x", expiresAt: 1, routeBinding: "r", fundsMoveOnCredential } } },
    destination: { rail: "mpp", quoted: "10000", asset: "B", network: "eip155:42431", quoteFingerprint: "sha256:x" },
  } as unknown as QuoteView;
}

async function nextStepFor(network: string): Promise<string> {
  const client = { quote: async () => ({ ok: true, quote: quoteWith(network) }) } as unknown as RouterClient;
  const handlers = createToolHandlers({ client, mode: "real", evidence: EVIDENCE });
  const body = await handlers.quote({ routeId: "r", requestId: "x" });
  return String(body["nextStep"]);
}

describe("static quote nextStep rail hint", () => {
  test("Solana: partial signature only, facilitator's fee payer broadcasts, wallet:new:solana", async () => {
    const text = await nextStepFor("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(text).toMatch(/Explicit human approval is required/);
    expect(text).toMatch(/paid on Solana/);
    expect(text).toMatch(/partially signs/);
    expect(text).toMatch(/wallet:new:solana/);
    expect(text).not.toMatch(/cannot be undone/);
  });
  test("Arc: Circle facilitator, settlement may take about a minute", async () => {
    const text = await nextStepFor("eip155:5042002");
    expect(text).toMatch(/Arc testnet/);
    expect(text).toMatch(/Circle/);
  });
  test("Base Sepolia: unchanged wording (no hint)", async () => {
    const text = await nextStepFor("eip155:84532");
    expect(text).toBe("Explicit human approval is required. If the human approves, call subetha_router_purchase with this quoteId as `approval`. If not, do not call it.");
  });
});
