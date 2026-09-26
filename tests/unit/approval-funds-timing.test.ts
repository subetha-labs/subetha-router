/**
 * 承認者に「**いつ資金が動くか**」が伝わるかを固定する。**無課金**。
 *
 * なぜ必要か: MPP 受信は `credential` を作った時点で payer 自身が broadcast するので、
 * **purchase を呼ぶ前に送金が済んでいて、取り消せない**。x402 受信は署名するだけで、
 * 送金は後段で facilitator が行う。
 *
 * この違いを伝えないと、承認者は署名を「準備の工程」と読んで承認し、
 * **実際には支払いを承認していた**ことになる。文面は読み飛ばされ得るので、
 * 構造化フィールド（`subject.fundsMoveOnCredential`）でも返す。
 */

import { describe, expect, it } from "vitest";

import { createToolHandlers, type Evidence } from "../../src/mcp/tools.js";
import type { QuoteView, RouterClient } from "../../src/client/types.js";

const EVIDENCE: Evidence = { label: "test", source: "operator_asserted", verified: false };

/** 受信レールだけ差し替えた quote を作る。他の欄は両者で同じにする。 */
function quoteWithScheme(scheme: string): QuoteView {
  return {
    quoteId: "q1",
    paymentId: "p1",
    routeId: "r1",
    resource: { url: "http://127.0.0.1:8500/v1/routes/r1/resource", method: "GET" },
    source: {
      amount: "10000",
      decimals: 6,
      asset: "0xasset",
      network: "eip155:42431",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      offer: { scheme, extra: { challengeNonce: "n1" } },
    },
    destination: { quoted: "10000", asset: "0xdest", network: "eip155:84532" },
    approval: { required: true, boundTo: "q1", deadlineMs: Date.now() + 60_000 },
  } as unknown as QuoteView;
}

function handlersFor(scheme: string) {
  const client = {
    async quote() {
      return { ok: true as const, quote: quoteWithScheme(scheme) };
    },
  } as unknown as RouterClient;
  return createToolHandlers({ client, mode: "synthetic", evidence: EVIDENCE });
}

describe("approval must say when funds move", () => {
  it("flags the MPP rail, where the credential itself sends the money", async () => {
    const body = await handlersFor("tempo/charge").quote({ routeId: "r1", requestId: "x" });
    const subject = body["subject"] as Record<string, unknown>;

    expect(subject["fundsMoveOnCredential"]).toBe(true);
    // 文面にも「取り消せない」ことと、purchase より前だということが出る。
    expect(String(body["nextStep"])).toMatch(/cannot be undone/);
    expect(String(body["nextStep"])).toMatch(/Funds leave before/);
  });

  it("does not flag the x402 rail, where signing moves nothing", async () => {
    const body = await handlersFor("exact").quote({ routeId: "r1", requestId: "x" });
    const subject = body["subject"] as Record<string, unknown>;

    expect(subject["fundsMoveOnCredential"]).toBe(false);
    // x402 の文面に取り消し不可の警告を出さない（出すと狼少年になる）。
    expect(String(body["nextStep"])).not.toMatch(/cannot be undone/);
  });

  it("still requires human approval on both rails", async () => {
    for (const scheme of ["tempo/charge", "exact"]) {
      const body = await handlersFor(scheme).quote({ routeId: "r1", requestId: "x" });
      expect(body["approvalRequired"], scheme).toBe(true);
      expect(String(body["nextStep"]), scheme).toMatch(/Explicit human approval is required/);
    }
  });
});
