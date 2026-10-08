/**
 * H-1（要件 FR-A25・FR-A29）: MCP の tool 層は client の失敗の情報を落とさず、`rate_limited` には `retryAfterMs`
 * （client の値、無ければ 60,000）を付ける。`retryAfterMs` は quote の再試行の目安で purchase の再試行の許可ではない（文面）。
 * Solana の MPP（`solana/charge`）の案内は x402 と区別し、動的の「credential を作った時点で支払い済み」は Tempo だけ。
 */
import { describe, expect, test } from "vitest";

import type { RouterClient } from "../../src/client/index.js";
import type { QuoteView } from "../../src/client/types.js";
import { guarded } from "../../src/mcp/server.js";
import { createToolHandlers, type Evidence } from "../../src/mcp/tools.js";

const EVIDENCE: Evidence = { label: "test", source: "operator_asserted", verified: false };

function quoteWith(scheme: string, network: string, fundsMoveOnCredential: boolean, dynamic = false): QuoteView {
  return {
    quoteId: "q1",
    paymentId: "p1",
    routeId: dynamic ? "dyn-x" : "r",
    resource: { url: "https://router.test/v1/routes/r/resource", method: "GET" },
    approval: { required: true, boundTo: "q1", deadlineMs: Date.now() + 60_000 },
    source: { rail: scheme === "exact" ? "x402" : "mpp", amount: "10000", asset: "A", decimals: 6, network, payTo: "P", expiresAt: 1, offer: { scheme, network, asset: "A", amount: "10000", payTo: "P", maxTimeoutSeconds: 600, extra: { challengeNonce: "n", expiresAt: 1, routeBinding: "b", fundsMoveOnCredential } } },
    destination: { rail: "x402", quoted: "10000", asset: "B", network: "eip155:84532", decimals: 6, payTo: "D", quoteFingerprint: "sha256:x" },
    ...(dynamic ? { upstream: { url: "https://u.test/x", method: "GET" }, pricing: { upstreamAmount: "10000", fee: "1000", total: "11000" }, disclosures: {}, ownerKey: "k" } : {}),
  } as unknown as QuoteView;
}

function handlersWith(client: Partial<RouterClient>) {
  return createToolHandlers({ client: client as RouterClient, mode: "real", evidence: EVIDENCE });
}

describe("MCP failures carry reason / httpStatus / retryAfterMs", () => {
  test("quote failure: reason and httpStatus are added, error stays", async () => {
    const handlers = handlersWith({ quote: async () => ({ ok: false, error: "quote_failed", status: 502, reason: "per_purchase_limit" }) });
    const body = await handlers.quote({ routeId: "r", requestId: "x" });
    expect(body).toMatchObject({ ok: false, error: "quote_failed", reason: "per_purchase_limit", httpStatus: 502 });
    expect(body).not.toHaveProperty("retryAfterMs");
  });

  test("rate_limited: retryAfterMs from the client, default 60,000 without it; the text says quote retry only", async () => {
    const withHeader = handlersWith({ quoteUrl: async () => ({ ok: false, error: "rate_limited", status: 429, retryAfterMs: 30_000 }) });
    const a = await withHeader.quoteUrl({ profileId: "p", url: "https://u.test/x", requestId: "x" });
    expect(a).toMatchObject({ ok: false, error: "rate_limited", httpStatus: 429, retryAfterMs: 30_000 });
    expect(String(a["nextStep"])).toMatch(/retry the quote/i);
    expect(String(a["nextStep"])).toMatch(/never retry a purchase/i);
    const without = handlersWith({ quote: async () => ({ ok: false, error: "rate_limited", status: 429 }) });
    const b = await without.quote({ routeId: "r", requestId: "x" });
    expect(b).toMatchObject({ ok: false, error: "rate_limited", retryAfterMs: 60_000 });
  });

  test("internal_error (guarded) carries no reason and no exception text", async () => {
    const handlers = handlersWith({ quote: async () => { throw new Error("secret detail"); } });
    const result = await guarded(() => handlers.quote({ routeId: "r", requestId: "x" }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ ok: false, error: "internal_error" });
    expect(JSON.stringify(result)).not.toMatch(/secret detail/);
  });

  test("status found:false passes the client's reason through", async () => {
    const handlers = handlersWith({ status: async () => ({ found: false, status: 404, reason: "not_found" }) });
    expect(await handlers.status({ paymentId: "p1" })).toMatchObject({ found: false, reason: "not_found" });
  });
});

describe("Solana MPP guidance", () => {
  test("static quote on solana/charge: the hint says MPP, fully signed, the Router broadcasts at purchase; not the x402 wording", async () => {
    const handlers = handlersWith({ quote: async () => ({ ok: true, quote: quoteWith("solana/charge", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", true) }) });
    const text = String((await handlers.quote({ routeId: "r", requestId: "x" }))["nextStep"]);
    expect(text).toMatch(/MPP on Solana/);
    expect(text).toMatch(/fully signs/);
    expect(text).toMatch(/broadcasts it at purchase/);
    expect(text).not.toMatch(/partially signs/);
  });

  test("static quote on x402 Solana keeps the partial-signature wording", async () => {
    const handlers = handlersWith({ quote: async () => ({ ok: true, quote: quoteWith("exact", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", false) }) });
    const text = String((await handlers.quote({ routeId: "r", requestId: "x" }))["nextStep"]);
    expect(text).toMatch(/partially signs/);
    expect(text).not.toMatch(/MPP on Solana/);
  });

  test("dynamic nextStep: 'already spends' only for tempo/charge; solana/charge says the Router broadcasts at purchase", async () => {
    const tempo = handlersWith({ quoteUrl: async () => ({ ok: true, quote: quoteWith("tempo/charge", "eip155:42431", true, true) }) });
    const t = String((await tempo.quoteUrl({ profileId: "p", url: "https://u.test/x", requestId: "x" }))["nextStep"]);
    expect(t).toMatch(/building the credential already spends the funds/);
    const sol = handlersWith({ quoteUrl: async () => ({ ok: true, quote: quoteWith("solana/charge", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", true, true) }) });
    const s = String((await sol.quoteUrl({ profileId: "p", url: "https://u.test/x", requestId: "x" }))["nextStep"]);
    expect(s).not.toMatch(/already spends the funds/);
    expect(s).toMatch(/Router broadcasts it at purchase/);
    expect(s).toMatch(/approve.*before/i);
    // 申告が無い（保守的に true）が scheme が Tempo でも Solana でもない → 一般の「may spend」で、Tempo と断定しない。
    const other = handlersWith({ quoteUrl: async () => ({ ok: true, quote: quoteWith("exact", "eip155:84532", true, true) }) });
    const o = String((await other.quoteUrl({ profileId: "p", url: "https://u.test/x", requestId: "x" }))["nextStep"]);
    expect(o).toMatch(/may already spend the funds/);
    expect(o).not.toMatch(/MPP on Tempo/);
    expect(o).not.toMatch(/already spends the funds/);
  });
});
