/**
 * MCP の秘匿購入ツール（設計 §8.3、T-Z6）: 承認対象の欄と nextStep、purchase は Payer のファイル契約（`releasedHeader`・`headerFile`・`releaseB64`）を**返す**が、
 * quote・status の応答と nextStep の文面に credential の値が無い。client は偽物（Router に触れない）。
 */
import { describe, expect, test } from "vitest";

import type { PrivateQuoteView, PrivateRouterClient, RouterClient } from "../../src/client/types.js";
import { createToolHandlers, TOOL_NAMES, type Evidence } from "../../src/mcp/tools.js";

const EVIDENCE: Evidence = { label: "unit", source: "operator_asserted", verified: false };
const HEADER_VALUE = "eyJ4NDAyVmVyc2lvbiI6MiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweGRlYWRiZWVmIn19";

function quote(): PrivateQuoteView {
  return {
    quoteId: "0xq1",
    paymentId: "pay-1",
    routeId: "priv-x402",
    resource: { url: "https://router.test/v1/private/purchases", method: "POST" },
    source: { rail: "x402", amount: "11000", asset: "0xusdc", decimals: 6, network: "eip155:84532", payTo: "0xrouter", offer: { scheme: "exact" } },
    destination: { rail: "x402", quoted: "10000", asset: "0xusdc", network: "eip155:84532", payTo: "0xprov", quoteFingerprint: "sha256:aa" },
    pricing: { upstreamAmount: "10000", fee: "1000", total: "11000" },
    disclosures: { privatePurchase: true, noRefund: true },
    private: { intentSha256: "a".repeat(64), orderId: "b".repeat(64), payerPk: { x: "1", y: "2" }, target: { host: "test-server.io", port: 443, path: "/select" }, method: "POST", framing: "phase5-post-json-canonical-v1", body: { len: 88, commitmentHex: "c".repeat(64) }, outbound: { rail: "x402", amount: "10000", payTo: "0xprov" }, inbound: { rail: "x402", total: "11000" }, policy: { sessionTimeoutMs: 180000, attestTimeoutMs: 600000, retentionMs: 3600000 }, limits: { maxSentBytes: 4096 }, disclosures: { noRefund: true } },
    approval: { required: true, boundTo: "0xq1", deadlineMs: 1_800_000_000_000 },
    ownerKey: "owner-key-1",
  };
}

function handlers(client: Partial<RouterClient & PrivateRouterClient>) {
  return createToolHandlers({ client: client as RouterClient & PrivateRouterClient, mode: "real", evidence: EVIDENCE });
}

describe("subetha_router_private_quote", () => {
  test("承認対象に両レグ・target・commitment・鍵・方針・上限が載り、credential の値は無い", async () => {
    const h = handlers({ privateQuote: async () => ({ ok: true, quote: quote() }) });
    const out = await h.privateQuote({ profileId: "priv-x402", requestId: "r1", intentB64: "AAAA" });
    expect(out).toMatchObject({ ok: true, approvalRequired: true, subject: { privatePurchase: true, fundsMoveOnCredential: false, private: { intentSha256: "a".repeat(64), target: { host: "test-server.io" }, body: { len: 88 }, policy: { sessionTimeoutMs: 180000 } }, pricing: { total: "11000" } } });
    const text = JSON.stringify(out);
    expect(text).toContain("never sees the request body");
    expect(text).toContain("payer-finalize-order");
    expect(text).toContain(TOOL_NAMES.privatePurchase);
    expect(text).not.toContain(HEADER_VALUE);
  });
  test("client に秘匿操作が無ければ private_disabled、Router の拒否は固定コードで", async () => {
    expect(await handlers({}).privateQuote({ profileId: "p", requestId: "r", intentB64: "AAAA" })).toMatchObject({ ok: false, error: "private_disabled" });
    const h = handlers({ privateQuote: async () => ({ ok: false, error: "intent_mismatch", status: 409, reason: "outbound_offer" }) });
    expect(await h.privateQuote({ profileId: "p", requestId: "r", intentB64: "AAAA" })).toMatchObject({ ok: false, error: "intent_mismatch", reason: "outbound_offer", httpStatus: 409 });
  });
});

describe("subetha_router_private_purchase", () => {
  test("quote 文書と credential を要し、引き渡し（bearer を含む）をそのまま返す。nextStep は期限と手順", async () => {
    const h = handlers({
      privateQuote: async () => ({ ok: true, quote: quote() }),
      privatePurchase: async () => ({ outcome: "awaiting_session", handover: { paymentId: "pay-1", verifier: { address: "127.0.0.1:40001" }, releasedHeader: { name: "PAYMENT-SIGNATURE", value: HEADER_VALUE }, headerFile: { order_id: "b".repeat(64), intent_sha256: "a".repeat(64), name: "PAYMENT-SIGNATURE", value: HEADER_VALUE }, releaseB64: "e30=", deadlines: { credentialExpiresAt: 1, sessionBy: 1_800_000_000_000 } } }),
    });
    expect(await h.privatePurchase({ quoteId: "0xq1", requestId: "r1", approval: "0xq1", credential: "cred" })).toMatchObject({ ok: false, error: "quote_required" });
    await h.privateQuote({ profileId: "priv-x402", requestId: "r1", intentB64: "AAAA" });
    expect(await h.privatePurchase({ quoteId: "0xq1", requestId: "r1", approval: "0xq1" })).toMatchObject({ ok: false, error: "credential_required" });
    const out = await h.privatePurchase({ quoteId: "0xq1", requestId: "r1", approval: "0xq1", credential: "cred" });
    expect(out).toMatchObject({ ok: true, outcome: "awaiting_session", paymentId: "pay-1", handover: { verifier: { address: "127.0.0.1:40001" }, releasedHeader: { value: HEADER_VALUE }, headerFile: { value: HEADER_VALUE }, releaseB64: "e30=" } });
    const nextStep = String(out["nextStep"]);
    expect(nextStep).toContain("payer-finalize-order");
    expect(nextStep).toContain("127.0.0.1:40001");
    expect(nextStep).not.toContain(HEADER_VALUE);
    // ステートレス: quote 文書を渡せば保持が無くても呼べる。
    const stateless = handlers({ privatePurchase: async () => ({ outcome: "unknown", paymentId: "pay-1", reason: "private_issue_failed" }) });
    expect(await stateless.privatePurchase({ quoteId: "0xq1", requestId: "r1", approval: "0xq1", credential: "cred", quote: quote() })).toMatchObject({ ok: false, outcome: "unknown", reason: "private_issue_failed" });
  });
});

describe("subetha_router_private_attest / record", () => {
  test("attest の成否と proof の欄、record の注意書き。失敗は固定コード", async () => {
    const h = handlers({
      privateAttest: async () => ({ ok: true, paymentId: "pay-1", status: "delivered_private", private: { proof: { delivery: true } } }),
      privateRecord: async () => ({ ok: true, paymentId: "pay-1", recordB64: "e30=", releaseB64: "e30=", recordAvailableUntil: 5 }),
    });
    expect(await h.privateAttest({ paymentId: "pay-1", ownerKey: "k", bundleB64: "e30=" })).toMatchObject({ ok: true, status: "delivered_private", proof: { verifiedDelivery: true, onChainFinality: "not_checked" } });
    expect(await h.privateRecord({ paymentId: "pay-1", ownerKey: "k" })).toMatchObject({ ok: true, recordB64: "e30=", releaseB64: "e30=", recordAvailableUntil: 5 });
    const failing = handlers({
      privateAttest: async () => ({ ok: true, paymentId: "pay-1", status: "unknown", terminalReason: "private_attest_invalid" }),
      privateRecord: async () => ({ ok: false, error: "record_expired", status: 410 }),
    });
    const attest = await failing.privateAttest({ paymentId: "pay-1", ownerKey: "k", bundleB64: "e30=" });
    expect(attest).toMatchObject({ ok: false, status: "unknown", terminalReason: "private_attest_invalid", proof: { verifiedDelivery: false } });
    expect(String(attest["nextStep"])).toContain("Do not retry");
    expect(await failing.privateRecord({ paymentId: "pay-1", ownerKey: "k" })).toMatchObject({ ok: false, error: "record_expired", httpStatus: 410 });
  });
});
