/**
 * 秘匿購入の client（設計 §8.2、T-Z6）: `privateQuoteViewOf` は必須欄の欠落で quote と扱わず `upstream` 無しで通る; `privateBindingOf` の全欄を 1 欄ずつ変えた quote は
 * `resource_mismatch` で**購入要求 0 回**; 購入口は `POST <base>/v1/private/purchases`; `allowUnissuedQuotes` の意味; attest・record の形。
 */
import { describe, expect, test } from "vitest";

import { createRouterClient, privateBindingOf, privateQuoteViewOf } from "../../src/client/index.js";
import type { PrivateQuoteView } from "../../src/client/types.js";

const BASE = "https://router.test";
function quoteBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    quoteId: "0xq1",
    paymentId: "pay-1",
    routeId: "priv-x402",
    resource: { url: `${BASE}/v1/private/purchases`, method: "POST" },
    source: { rail: "x402", amount: "11000", asset: "0xusdc", decimals: 6, network: "eip155:84532", payTo: "0xrouter", expiresAt: 1, offer: { scheme: "exact", extra: { challengeNonce: "0xq1" } } },
    destination: { rail: "x402", quoted: "10000", asset: "0xusdc", decimals: 6, network: "eip155:84532", payTo: "0xprov", quoteFingerprint: "sha256:aa" },
    pricing: { upstreamAmount: "10000", fee: "1000", total: "11000" },
    disclosures: { privatePurchase: true, noRefund: true },
    private: { intentSha256: "a".repeat(64), orderId: "b".repeat(64), payerPk: { x: "1", y: "2" }, target: { host: "test-server.io", port: 443, path: "/select" }, method: "POST", framing: "phase5-post-json-canonical-v1", body: { len: 88, commitmentHex: "c".repeat(64) }, outbound: { rail: "x402" }, inbound: { rail: "x402" }, policy: { sessionTimeoutMs: 180000 }, limits: { maxSentBytes: 4096 }, disclosures: { noRefund: true } },
    approval: { required: true, boundTo: "0xq1", deadlineMs: 1_800_000_000_000 },
    ownerKey: "owner-key-1",
    ...patch,
  };
}

interface Seen {
  readonly requests: { url: string; init: RequestInit }[];
}
function clientWith(responder: (url: URL, init: RequestInit) => Response, options: { allowUnissuedQuotes?: boolean } = {}): { client: ReturnType<typeof createRouterClient>; seen: Seen } {
  const seen: Seen = { requests: [] };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    seen.requests.push({ url: url.toString(), init: init ?? {} });
    return responder(url, init ?? {});
  };
  return { client: createRouterClient({ baseUrl: BASE, principalId: "alice", token: "tok", fetch: fetchImpl, ...options }), seen };
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("privateQuoteViewOf", () => {
  test("秘匿 quote の文書（upstream 無し）を読む。必須欄が欠ければ quote と扱わない", () => {
    const view = privateQuoteViewOf(quoteBody());
    expect(view).toBeDefined();
    expect(view!.resource).toEqual({ url: `${BASE}/v1/private/purchases`, method: "POST" });
    expect(view!.private.intentSha256).toBe("a".repeat(64));
    for (const key of ["quoteId", "paymentId", "routeId", "resource", "source", "destination", "pricing", "disclosures", "private", "approval", "ownerKey"]) {
      const body = quoteBody();
      delete body[key];
      expect(privateQuoteViewOf(body), key).toBeUndefined();
    }
    for (const key of ["intentSha256", "orderId", "payerPk", "target", "method", "framing", "body", "outbound", "inbound", "policy", "limits", "disclosures"]) {
      const body = quoteBody();
      const priv = { ...(body["private"] as Record<string, unknown>) };
      delete priv[key];
      expect(privateQuoteViewOf({ ...body, private: priv }), key).toBeUndefined();
    }
    expect(privateQuoteViewOf(quoteBody({ ownerKey: "" }))).toBeUndefined();
    expect(privateQuoteViewOf(quoteBody({ source: { amount: "1" } }))).toBeUndefined();
  });
});

describe("privatePurchase の束縛", () => {
  async function issued(): Promise<{ client: ReturnType<typeof createRouterClient>; seen: Seen; quote: PrivateQuoteView }> {
    const { client, seen } = clientWith((url) => (url.pathname === "/v1/private/quotes" ? json(200, quoteBody()) : json(500, { error: "unexpected" })));
    const result = await client.privateQuote({ profileId: "priv-x402", requestId: "r1", intentB64: "AAAA" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("quote failed");
    expect(seen.requests[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(seen.requests[0]!.init.body))).toEqual({ profileId: "priv-x402", requestId: "r1", intentB64: "AAAA" });
    return { client, seen, quote: result.quote };
  }
  test("発行された quote そのものは購入口に 1 回だけ POST し、ownerKey と approval を運ぶ", async () => {
    const { client, seen, quote } = await issued();
    (client as unknown as { fetchOverride?: unknown }).fetchOverride = undefined;
    const { client: client2, seen: seen2 } = clientWith((url) => (url.pathname === "/v1/private/quotes" ? json(200, quoteBody()) : json(200, { paymentId: "pay-1", status: "awaiting_session", verifier: { address: "127.0.0.1:1" }, releasedHeader: { name: "PAYMENT-SIGNATURE", value: "v" }, headerFile: { order_id: "b".repeat(64), intent_sha256: "a".repeat(64), name: "PAYMENT-SIGNATURE", value: "v" }, releaseB64: "e30=", deadlines: { credentialExpiresAt: 1, sessionBy: 2 } })));
    const q2 = await client2.privateQuote({ profileId: "priv-x402", requestId: "r1", intentB64: "AAAA" });
    if (!q2.ok) throw new Error("quote failed");
    const result = await client2.privatePurchase({ quote: q2.quote, requestId: "r1", approval: { approved: true, quoteId: "0xq1" }, credential: "cred" });
    expect(result).toMatchObject({ outcome: "awaiting_session", handover: { paymentId: "pay-1", verifier: { address: "127.0.0.1:1" }, releasedHeader: { name: "PAYMENT-SIGNATURE", value: "v" } } });
    expect(seen2.requests).toHaveLength(2);
    expect(seen2.requests[1]!.url).toBe(`${BASE}/v1/private/purchases`);
    expect(JSON.parse(String(seen2.requests[1]!.init.body))).toEqual({ quoteId: "0xq1", requestId: "r1", approval: "0xq1", credential: "cred", ownerKey: "owner-key-1" });
    expect(seen.requests).toHaveLength(1);
    expect(quote.quoteId).toBe("0xq1");
  });
  test.each<[string, (quote: PrivateQuoteView) => PrivateQuoteView]>([
    ["ownerKey", (q) => ({ ...q, ownerKey: "other" })],
    ["policy", (q) => ({ ...q, private: { ...q.private, policy: { sessionTimeoutMs: 1 } } })],
    ["limits", (q) => ({ ...q, private: { ...q.private, limits: { maxSentBytes: 1 } } })],
    ["disclosures（private）", (q) => ({ ...q, private: { ...q.private, disclosures: { noRefund: false } } })],
    ["disclosures（quote）", (q) => ({ ...q, disclosures: { privatePurchase: false } })],
    ["resource の method", (q) => ({ ...q, resource: { ...q.resource, method: "GET" } })],
    ["source", (q) => ({ ...q, source: { ...q.source, amount: "1" } })],
    ["destination", (q) => ({ ...q, destination: { ...q.destination, payTo: "0xevil" } })],
    ["pricing", (q) => ({ ...q, pricing: { ...q.pricing, total: "1" } })],
    ["approval の期限", (q) => ({ ...q, approval: { ...q.approval, deadlineMs: 1 } })],
    ["intentSha256", (q) => ({ ...q, private: { ...q.private, intentSha256: "0".repeat(64) } })],
    ["target", (q) => ({ ...q, private: { ...q.private, target: { host: "evil.example", port: 443, path: "/select" } } })],
    ["payerPk", (q) => ({ ...q, private: { ...q.private, payerPk: { x: "9", y: "9" } } })],
    ["body の commitment", (q) => ({ ...q, private: { ...q.private, body: { len: 88, commitmentHex: "0".repeat(64) } } })],
    ["paymentId", (q) => ({ ...q, paymentId: "pay-2" })],
  ])("1 欄でも変わった quote は resource_mismatch で購入要求を出さない: %s", async (_name, mutate) => {
    const { client, seen, quote } = await issued();
    const result = await client.privatePurchase({ quote: mutate(quote), requestId: "r1", approval: { approved: true, quoteId: "0xq1" }, credential: "cred" });
    expect(result).toMatchObject({ outcome: "resource_mismatch" });
    expect(["quote_binding_changed", "resource_not_approved_private"]).toContain((result as { reason: string }).reason);
    expect(seen.requests).toHaveLength(1);
    expect(privateBindingOf(mutate(quote))).not.toBe(privateBindingOf(quote));
  });
  test("購入口が秘匿購入の口でなければ出さない（動的の購入口の URL でも）。承認の欠落・不一致・requestId の変更も出さない", async () => {
    const { client, seen, quote } = await issued();
    expect(await client.privatePurchase({ quote: { ...quote, resource: { url: `${BASE}/v1/routes/priv-x402/resource`, method: "GET" } }, requestId: "r1", approval: { approved: true, quoteId: "0xq1" }, credential: "c" })).toMatchObject({ outcome: "resource_mismatch" });
    expect(await client.privatePurchase({ quote, requestId: "r1", approval: { approved: false }, credential: "c" })).toMatchObject({ outcome: "not_approved" });
    expect(await client.privatePurchase({ quote, requestId: "r1", approval: { approved: true, quoteId: "0xq2" }, credential: "c" })).toMatchObject({ outcome: "approval_mismatch" });
    expect(await client.privatePurchase({ quote, requestId: "r2", approval: { approved: true, quoteId: "0xq1" }, credential: "c" })).toMatchObject({ outcome: "resource_mismatch", reason: "request_id_changed" });
    expect(seen.requests).toHaveLength(1);
  });
  test("allowUnissuedQuotes: 発行していない quote は既定で出さず、opt-in なら Router の拒否面に任せる", async () => {
    const view = privateQuoteViewOf(quoteBody())!;
    const strict = clientWith(() => json(404, { error: "unknown_quote", status: "rejected" }));
    expect(await strict.client.privatePurchase({ quote: view, requestId: "r1", approval: { approved: true, quoteId: "0xq1" }, credential: "c" })).toMatchObject({ outcome: "resource_mismatch", reason: "quote_not_issued_by_client" });
    expect(strict.seen.requests).toHaveLength(0);
    const relaxed = clientWith(() => json(404, { error: "unknown_quote", status: "rejected" }), { allowUnissuedQuotes: true });
    expect(await relaxed.client.privatePurchase({ quote: view, requestId: "r1", approval: { approved: true, quoteId: "0xq1" }, credential: "c" })).toMatchObject({ outcome: "rejected", error: "unknown_quote", status: 404 });
    expect(relaxed.seen.requests).toHaveLength(1);
  });
  test("応答の写像: unknown・paid_data_unavailable・402・5xx・paymentId の不一致", async () => {
    const view = privateQuoteViewOf(quoteBody())!;
    const run = async (response: Response) => clientWith(() => response, { allowUnissuedQuotes: true }).client.privatePurchase({ quote: view, requestId: "r1", approval: { approved: true, quoteId: "0xq1" }, credential: "c" });
    expect(await run(json(500, { error: "private_issue_failed", status: "unknown", paymentId: "pay-1", terminalReason: "private_issue_failed" }))).toEqual({ outcome: "unknown", paymentId: "pay-1", reason: "private_issue_failed" });
    expect(await run(json(502, { error: "offer_changed", status: "paid_data_unavailable", paymentId: "pay-1", terminalReason: "offer_changed" }))).toEqual({ outcome: "paid_data_unavailable", paymentId: "pay-1", terminalReason: "offer_changed" });
    expect(await run(json(402, { error: "verify_failed", status: "awaiting_payment" }))).toMatchObject({ outcome: "payment_required", error: "verify_failed" });
    expect(await run(json(503, { error: "private_capacity", status: "awaiting_payment" }))).toMatchObject({ outcome: "unknown", reason: "private_capacity" });
    expect(await run(json(200, { paymentId: "pay-9", status: "awaiting_session" }))).toEqual({ outcome: "unknown", paymentId: "pay-1", reason: "payment_id_mismatch" });
  });
});

describe("privateAttest / privateRecord", () => {
  test("attest は bundleB64 と ownerKey を本文で送り、record は ownerKey をヘッダで送る", async () => {
    const { client, seen } = clientWith((url, init) => {
      if (url.pathname.endsWith("/attest")) return json(200, { paymentId: "pay-1", status: "delivered_private", private: { attest: { result: "delivered_private" } } });
      if (url.pathname.endsWith("/record")) return json(200, { paymentId: "pay-1", recordB64: "e30=", releaseB64: "e30=", recordAvailableUntil: 5, headers: (init.headers as Record<string, string>)["x-router-owner-key"] });
      return json(404, { error: "not_found" });
    });
    expect(await client.privateAttest({ paymentId: "pay-1", ownerKey: "k", bundleB64: "e30=" })).toEqual({ ok: true, paymentId: "pay-1", status: "delivered_private", private: { attest: { result: "delivered_private" } } });
    expect(JSON.parse(String(seen.requests[0]!.init.body))).toEqual({ bundleB64: "e30=", ownerKey: "k" });
    expect(await client.privateRecord({ paymentId: "pay-1", ownerKey: "k" })).toEqual({ ok: true, paymentId: "pay-1", recordB64: "e30=", releaseB64: "e30=", recordAvailableUntil: 5 });
    expect((seen.requests[1]!.init.headers as Record<string, string>)["x-router-owner-key"]).toBe("k");
    const denied = clientWith(() => json(409, { error: "attest_foreign" }));
    expect(await denied.client.privateAttest({ paymentId: "pay-1", ownerKey: "k", bundleB64: "e30=" })).toEqual({ ok: false, error: "attest_foreign", status: 409 });
    expect(await denied.client.privateRecord({ paymentId: "pay-1", ownerKey: "k" })).toEqual({ ok: false, error: "attest_foreign", status: 409 });
  });
});
