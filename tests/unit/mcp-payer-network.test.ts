/**
 * MCP の受信 payer には offer の **network（CAIP-2）** を渡す（multirail 設計 §7、FR-4。タスク T2）。
 * 固定の chainId を持たないので、Solana の offer でも Arc の offer でも能力が network ごとに署名の形を決められる。
 * この層は鍵を持たず、能力が拒めば固定の安全な失敗（`inbound_credential_unavailable`）で止まる。
 */
import { describe, expect, test } from "vitest";

import type { RouterClient } from "../../src/client/index.js";
import { createToolHandlers, type Evidence, type InboundPayer } from "../../src/mcp/tools.js";

const EVIDENCE: Evidence = { label: "test", source: "operator_asserted", verified: false };

function quoteWith(network: string): Record<string, unknown> {
  return {
    quoteId: "q1",
    paymentId: "p1",
    routeId: "r",
    approval: { required: true, boundTo: "q1", deadlineMs: Date.now() + 60_000 },
    source: { rail: "x402", network, offer: { scheme: "exact", network, asset: "A", amount: "1", payTo: "P", maxTimeoutSeconds: 1, extra: {} } },
    destination: { network: "eip155:84532" },
  };
}

describe("MCP payer receives the offer's network", () => {
  test("Solana の offer は solana:… を、EVM の offer は eip155:… を渡し、能力が拒めば inbound_credential_unavailable", async () => {
    const seen: string[] = [];
    const payer: InboundPayer = {
      address: "0x0000000000000000000000000000000000000001",
      credentialFor: async (_offer, network) => {
        seen.push(network);
        throw new Error("refused by the capability");
      },
    };
    // credential を作る前に client には触れない（触れれば TypeError で落ち、この試験が失敗する）。
    const handlers = createToolHandlers({ client: {} as RouterClient, mode: "real", evidence: EVIDENCE, payer });
    for (const network of ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "eip155:5042002"]) {
      const result = await handlers.purchase({ quoteId: "q1", requestId: "r1", approval: "q1", quote: quoteWith(network) } as never);
      expect(result).toMatchObject({ ok: false, error: "inbound_credential_unavailable" });
    }
    expect(seen).toEqual(["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "eip155:5042002"]);
  });

  test("offer に network が無ければ能力を呼ばない", async () => {
    let calls = 0;
    const payer: InboundPayer = { address: "0x0000000000000000000000000000000000000001", credentialFor: async () => { calls += 1; return "x"; } };
    const handlers = createToolHandlers({ client: {} as RouterClient, mode: "real", evidence: EVIDENCE, payer });
    const quote = quoteWith("eip155:84532");
    (quote["source"] as Record<string, unknown>)["offer"] = { scheme: "exact" };
    const result = await handlers.purchase({ quoteId: "q1", requestId: "r1", approval: "q1", quote } as never);
    expect(result).toMatchObject({ ok: false, error: "inbound_credential_unavailable" });
    expect(calls).toBe(0);
  });
});
