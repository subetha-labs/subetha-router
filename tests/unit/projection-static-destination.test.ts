/**
 * H-1（設計 §6、要件 FR-A14 の記録のため）: 静的 quote の `destination` に `payTo`（route 設定）と `decimals`（表）を**加える**。
 * 動的 quote は変わらない。既存の欄も変わらない。
 */
import { describe, expect, test } from "vitest";

import { KNOWN_NETWORKS, parseRouterConfig } from "../../src/config.js";
import type { QuoteDocument } from "../../src/core/orchestrator.js";
import { quoteBody } from "../../src/http/projection.js";

const BASE = "https://router.test";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const DEST = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";

function configOf(withTable: boolean) {
  return parseRouterConfig(
    {
      approvalTtlMs: 60_000,
      routes: {
        r: {
          routeId: "r",
          canonicalPath: "/v1/routes/r/resource",
          rail: "mpp",
          sourceRail: "x402",
          source: { amount: "10000", asset: USDC, decimals: 6, network: "eip155:84532", payTo: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2" },
          destination: { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, payTo: DEST },
        },
      },
      budget: { maxPurchases: 10, buckets: [{ network: "eip155:84532", asset: USDC, maxTotal: "100000", maxPerPurchase: "10000" }] },
    },
    withTable ? { networks: KNOWN_NETWORKS } : {},
  );
}

const quote = {
  quoteId: "0xq",
  paymentId: "p1",
  routeId: "r",
  source: { amount: "10000", asset: USDC, network: "eip155:84532", offer: { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2", maxTimeoutSeconds: 600, extra: { challengeNonce: "0xq", expiresAt: 1, routeBinding: "b", fundsMoveOnCredential: false } } },
  destination: { quoted: "10000", asset: PATHUSD, network: "eip155:42431", quoteFingerprint: "sha256:x" },
  approval: { boundTo: "0xq", deadlineMs: 1 },
} as unknown as QuoteDocument;

describe("static quote projection: destination payTo and decimals", () => {
  test("with the known-networks table: payTo from the route, decimals from the table; existing fields unchanged", () => {
    const config = configOf(true);
    const body = quoteBody(quote, config.routes["r"]!, BASE) as { destination: Record<string, unknown> };
    expect(body.destination).toEqual({ rail: "mpp", quoted: "10000", asset: PATHUSD, network: "eip155:42431", quoteFingerprint: "sha256:x", payTo: DEST, decimals: 6 });
  });

  test("without a table (synthetic configs): payTo is still there, decimals is omitted rather than guessed", () => {
    const config = configOf(false);
    const body = quoteBody(quote, config.routes["r"]!, BASE) as { destination: Record<string, unknown> };
    expect(body.destination["payTo"]).toBe(DEST);
    expect(body.destination).not.toHaveProperty("decimals");
  });
});
