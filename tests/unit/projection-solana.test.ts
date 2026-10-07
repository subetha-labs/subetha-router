/**
 * 公開射影は network の族に依らず、設定どおりの受取先（SVM は base58 の owner）と桁を出す（AC-6、タスク T2）。
 * 表示は文字列を写すだけで、EVM の形（`0x`）を前提にしない。
 */
import { describe, expect, test } from "vitest";

import { KNOWN_NETWORKS, parseRouterConfig } from "../../src/config.js";
import type { QuoteDocument } from "../../src/core/orchestrator.js";
import { quoteBody, routeListBody } from "../../src/http/projection.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const BASE = "https://router.test";

const config = parseRouterConfig(
  {
    approvalTtlMs: 60_000,
    routes: {
      sol: {
        routeId: "sol",
        canonicalPath: "/v1/routes/sol/resource",
        rail: "mpp",
        sourceRail: "x402",
        source: { amount: "10000", asset: MINT, decimals: 6, network: SOL, payTo: OWNER },
        destination: { scheme: "tempo/charge", network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1" },
      },
    },
    budget: { maxPurchases: 10, buckets: [{ network: SOL, asset: MINT, maxTotal: "100000", maxPerPurchase: "10000" }] },
  },
  { networks: KNOWN_NETWORKS },
);

describe("Solana の受信 route の公開射影", () => {
  test("一覧に network・mint・桁がそのまま出る", () => {
    const body = routeListBody(config, BASE) as { routes: { source: Record<string, unknown> }[] };
    expect(body.routes[0]?.source).toEqual({ amount: "10000", asset: MINT, decimals: 6, network: SOL, payTo: OWNER });
  });

  test("quote の subject に base58 の受取先と 6 桁が出る（0x に書き換えない）", () => {
    const route = config.routes["sol"]!;
    const quote: QuoteDocument = {
      quoteId: "0xabc",
      paymentId: "p1",
      routeId: "sol",
      source: {
        amount: "10000",
        asset: MINT,
        network: SOL,
        offer: { scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: OWNER, maxTimeoutSeconds: 40, extra: { challengeNonce: "0xabc", expiresAt: 1, routeBinding: "r", fundsMoveOnCredential: false, feePayer: "F", memo: "0xabc" } },
      },
      destination: { quoted: "10000", asset: "0x20c0000000000000000000000000000000000000", network: "eip155:42431", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1", quoteFingerprint: "sha256:x" },
      approval: { required: true, boundTo: "0xabc", deadlineMs: 2 },
    };
    const body = quoteBody(quote, route, BASE) as { source: Record<string, unknown> };
    expect(body.source).toMatchObject({ rail: "x402", amount: "10000", asset: MINT, decimals: 6, network: SOL, payTo: OWNER });
    expect(body.source["payTo"]).toBe(OWNER);
  });
});
