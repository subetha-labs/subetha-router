/**
 * 受信レール `subetha-exact` の公開の面（HTTP → client → MCP。`docs/subetha-exact-inbound-design.md` §4.1・§4.2・§5.5、タスク T-2b）。
 * core は台本どおりに答える偽物で、実 TCP の listener・実 client・実 MCP handler を通す:
 * - quote の失敗 `source_offer_unavailable` → 503 + `Retry-After`（既定 30 秒）、`source_offer_refused` → 502、本文に `reason`。MCP の `nextStep`
 * - purchase・status の `mayStillSettleUntil` は常に `awaitingPaymentDoesNotMeanUnpaid: true` と組（402・500・502 の本文、射影、client、MCP の文）
 * - 欄が無ければ本文・射影は今までどおり（キーが増えない）
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import { createRouterClient } from "../../src/client/index.js";
import type { QuoteView } from "../../src/client/types.js";
import type { RouterConfig } from "../../src/config.js";
import type { Projection, PurchaseOutcome, QuoteOutcome, RouterCore } from "../../src/core/orchestrator.js";
import { createRequestListener } from "../../src/http/app.js";
import { createToolHandlers, type Evidence } from "../../src/mcp/tools.js";
import type { InboundOffer } from "../../src/ports/inbound.js";
import { paymentHeader } from "../fixtures/router-harness.js";

const ROUTE_ID = "md-zusdc-exact";
const EVIDENCE: Evidence = { label: "test", source: "operator_asserted", verified: false };
const OFFER: InboundOffer = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f",
  amount: "2000",
  payTo: "0xburn",
  maxTimeoutSeconds: 150,
  extra: { challengeNonce: `0x${"11".repeat(32)}`, expiresAt: 1_800_000_120, routeBinding: `${ROUTE_ID}|GET|%2Fv1%2Froutes%2F${ROUTE_ID}%2Fresource`, name: "zERC20 USD Coin", version: "1", fundsMoveOnCredential: false },
};
const CONFIG: RouterConfig = {
  approvalTtlMs: 60_000,
  routes: {
    [ROUTE_ID]: { routeId: ROUTE_ID, canonicalPath: `/v1/routes/${ROUTE_ID}/resource`, sourceRail: "subetha-exact", source: { amount: "2000", asset: OFFER.asset, decimals: 6, network: OFFER.network }, destination: { scheme: "exact", network: "eip155:84532", asset: "0xde57", payTo: "0xprovidera" } },
  },
  budget: { maxPurchases: 1, buckets: [] },
};

function quoteDocument(): QuoteOutcome {
  return {
    ok: true,
    quoteId: OFFER.extra.challengeNonce,
    paymentId: "pay-1",
    routeId: ROUTE_ID,
    source: { amount: "2000", asset: OFFER.asset, network: OFFER.network, offer: OFFER },
    destination: { quoted: "900", asset: "0xde57", network: "eip155:84532", payTo: "0xprovidera", quoteFingerprint: "sha256:x" },
    approval: { required: true, boundTo: OFFER.extra.challengeNonce, deadlineMs: Date.now() + 60_000 },
  };
}
function projection(extra: Partial<Projection["source"]> = {}): Projection {
  return {
    paymentId: "pay-1",
    routeId: ROUTE_ID,
    status: "awaiting_payment",
    source: { amount: "2000", asset: OFFER.asset, network: OFFER.network, ...extra },
    destination: { quoted: "900", asset: "0xde57", network: "eip155:84532", attempt: 0, outcome: "not_sent" },
    quoteFingerprint: "sha256:x",
    terminalReason: "verify_failed",
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

interface Script {
  quote?: QuoteOutcome;
  purchase?: PurchaseOutcome;
  status?: Projection;
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function serve(script: Script) {
  const core: RouterCore = {
    quote: async () => script.quote ?? quoteDocument(),
    purchase: async () => script.purchase ?? { paymentId: "pay-1", status: "rejected", code: "approval_required" },
    status: () => script.status,
    offerFor: () => OFFER,
    disclosureFor: () => script.status?.source.mayStillSettleUntil,
    privateQuote: async () => ({ ok: false, code: "private_disabled" }),
    privateAttest: async () => ({ ok: false, code: "not_found" }),
    privateRecord: () => ({ ok: false, code: "not_found" }),
    close: async () => undefined,
  };
  const server = http.createServer(createRequestListener({ core, config: CONFIG, canonicalBaseUrl: "http://router.invalid", principals: new Map([["alice", "tok"]]) }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = createRouterClient({ baseUrl, principalId: "alice", token: "tok", allowUnissuedQuotes: true });
  const mcp = createToolHandlers({ client, mode: "real", evidence: EVIDENCE });
  const headers = { "x-router-principal": "alice", authorization: "Bearer tok" };
  return { baseUrl, client, mcp, headers };
}

function quoteView(): QuoteView {
  const document = quoteDocument();
  if (!document.ok) throw new Error("unreachable");
  return {
    quoteId: document.quoteId,
    paymentId: document.paymentId,
    routeId: ROUTE_ID,
    resource: { url: `http://router.invalid/v1/routes/${ROUTE_ID}/resource`, method: "GET" },
    source: { rail: "subetha-exact", amount: "2000", asset: OFFER.asset, decimals: 6, network: OFFER.network, payTo: OFFER.payTo, expiresAt: OFFER.extra.expiresAt, offer: OFFER },
    destination: { quoted: "900", asset: "0xde57", network: "eip155:84532", quoteFingerprint: "sha256:x" },
    approval: document.approval,
  } as unknown as QuoteView;
}

describe("quote の失敗（source_offer_*）", () => {
  test("source_offer_unavailable → 503 + Retry-After（retryAfterMs から切り上げ）、本文に reason。client は retryAfterMs を読み、MCP は quote の取り直しの文", async () => {
    const { baseUrl, client, mcp, headers } = await serve({ quote: { ok: false, code: "source_offer_unavailable", reason: "facilitator_busy", retryAfterMs: 30_000 } });
    const response = await fetch(`${baseUrl}/v1/quotes`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId: "r1" }) });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({ error: "source_offer_unavailable", reason: "facilitator_busy" });
    expect(await client.quote({ routeId: ROUTE_ID, requestId: "r1" })).toEqual({ ok: false, error: "source_offer_unavailable", status: 503, reason: "facilitator_busy", retryAfterMs: 30_000 });
    const tool = await mcp.quote({ routeId: ROUTE_ID, requestId: "r1" });
    expect(tool).toMatchObject({ ok: false, error: "source_offer_unavailable", reason: "facilitator_busy", httpStatus: 503, retryAfterMs: 30_000 });
    expect(String(tool["nextStep"])).toMatch(/no payment was started/);
    expect(String(tool["nextStep"])).toMatch(/retry the quote after about 30 seconds/);
    expect(String(tool["nextStep"])).toMatch(/Never retry a purchase/);
  });

  test("retryAfterMs 無しの unavailable は Retry-After 30 の既定。refused は 502 で Retry-After 無し。order_reused_* は新しい requestId の案内", async () => {
    const a = await serve({ quote: { ok: false, code: "source_offer_unavailable", reason: "response_unreadable" } });
    const r1 = await fetch(`${a.baseUrl}/v1/quotes`, { method: "POST", headers: { ...a.headers, "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId: "r1" }) });
    expect([r1.status, r1.headers.get("retry-after")]).toEqual([503, "30"]);
    const b = await serve({ quote: { ok: false, code: "source_offer_refused", reason: "order_reused_expired" } });
    const r2 = await fetch(`${b.baseUrl}/v1/quotes`, { method: "POST", headers: { ...b.headers, "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId: "r1" }) });
    expect([r2.status, r2.headers.get("retry-after")]).toEqual([502, null]);
    expect(await r2.json()).toEqual({ error: "source_offer_refused", reason: "order_reused_expired" });
    const tool = await b.mcp.quote({ routeId: ROUTE_ID, requestId: "r1" });
    expect(String(tool["nextStep"])).toMatch(/can no longer be quoted on this route; take a new quote with a new requestId/);
    expect(tool).not.toHaveProperty("retryAfterMs");
    // ほかの refused（amount_refused）には案内の文は付かない（既存の形）。
    const c = await serve({ quote: { ok: false, code: "source_offer_refused", reason: "amount_refused" } });
    expect(await c.mcp.quote({ routeId: ROUTE_ID, requestId: "r1" })).not.toHaveProperty("nextStep");
    // 既存の失敗は不変。
    const d = await serve({ quote: { ok: false, code: "request_id_conflict" } });
    const r4 = await fetch(`${d.baseUrl}/v1/quotes`, { method: "POST", headers: { ...d.headers, "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId: "r1" }) });
    expect([r4.status, r4.headers.get("retry-after"), await r4.json()]).toEqual([409, null, { error: "request_id_conflict" }]);
  });
});

describe("purchase の応答の開示", () => {
  const UNTIL = 1_800_000_119;
  async function purchaseVia(script: PurchaseOutcome) {
    const served = await serve({ purchase: script });
    const response = await fetch(`${served.baseUrl}/v1/routes/${ROUTE_ID}/resource`, {
      headers: { ...served.headers, "x-router-quote-id": OFFER.extra.challengeNonce, "x-router-request-id": "r1", "x-router-approval": OFFER.extra.challengeNonce, "x-payment": paymentHeader(OFFER) },
    });
    const body = (await response.json()) as Record<string, unknown>;
    const execution = await served.client.execute({ quote: quoteView(), requestId: "r1", approval: { approved: true, quoteId: OFFER.extra.challengeNonce }, credential: paymentHeader(OFFER) });
    const tool = await served.mcp.purchase({ quoteId: OFFER.extra.challengeNonce, requestId: "r1", approval: OFFER.extra.challengeNonce, quote: quoteView(), credential: paymentHeader(OFFER) });
    return { status: response.status, body, execution, tool };
  }

  test("awaiting_payment（verify_failed, 402）: 本文・client・MCP に mayStillSettleUntil と awaitingPaymentDoesNotMeanUnpaid、MCP に文", async () => {
    const { status, body, execution, tool } = await purchaseVia({ paymentId: "pay-1", status: "awaiting_payment", code: "verify_failed", mayStillSettleUntil: UNTIL });
    expect(status).toBe(402);
    expect(body).toMatchObject({ error: "verify_failed", status: "awaiting_payment", paymentId: "pay-1", mayStillSettleUntil: UNTIL, awaitingPaymentDoesNotMeanUnpaid: true });
    expect(execution).toEqual({ outcome: "payment_required", error: "verify_failed", paymentId: "pay-1", mayStillSettleUntil: UNTIL });
    expect(tool).toMatchObject({ ok: false, outcome: "payment_required", mayStillSettleUntil: UNTIL, awaitingPaymentDoesNotMeanUnpaid: true });
    expect(String(tool["nextStep"])).toContain(new Date(UNTIL * 1000).toISOString());
    expect(String(tool["nextStep"])).toMatch(/NOT proof that nothing was paid/);
    expect(String(tool["nextStep"])).toMatch(/Do not sign again/);
  });

  test("unknown（500）と paid_data_unavailable（502）も同じ欄。rejected（preflight, 402）も", async () => {
    const unknown = await purchaseVia({ paymentId: "pay-1", status: "unknown", terminalReason: "source_settle_unknown", mayStillSettleUntil: UNTIL });
    expect(unknown.status).toBe(500);
    expect(unknown.body).toMatchObject({ error: "source_settle_unknown", mayStillSettleUntil: UNTIL, awaitingPaymentDoesNotMeanUnpaid: true });
    expect(unknown.execution).toEqual({ outcome: "unknown", paymentId: "pay-1", reason: "source_settle_unknown", mayStillSettleUntil: UNTIL });
    expect(unknown.tool).toMatchObject({ outcome: "unknown", awaitingPaymentDoesNotMeanUnpaid: true });
    const undelivered = await purchaseVia({ paymentId: "pay-1", status: "paid_data_unavailable", terminalReason: "source_release_refused", mayStillSettleUntil: UNTIL });
    expect(undelivered.status).toBe(502);
    expect(undelivered.body).toMatchObject({ mayStillSettleUntil: UNTIL, awaitingPaymentDoesNotMeanUnpaid: true });
    expect(undelivered.execution).toEqual({ outcome: "paid_data_unavailable", paymentId: "pay-1", terminalReason: "source_release_refused", mayStillSettleUntil: UNTIL });
    const rejected = await purchaseVia({ paymentId: "pay-1", status: "rejected", code: "nonce_mismatch", mayStillSettleUntil: UNTIL });
    expect(rejected.status).toBe(402);
    expect(rejected.body).toMatchObject({ error: "nonce_mismatch", mayStillSettleUntil: UNTIL, awaitingPaymentDoesNotMeanUnpaid: true });
    expect(rejected.execution).toMatchObject({ outcome: "payment_required", mayStillSettleUntil: UNTIL });
  });

  test("欄が無ければ本文・client・MCP のキーは増えない（既存の rail の形）", async () => {
    const { body, execution, tool } = await purchaseVia({ paymentId: "pay-1", status: "awaiting_payment", code: "verify_failed" });
    expect(Object.keys(body).sort()).toEqual(["accepts", "error", "paymentId", "quoteUrl", "routeId", "status", "x402Version"]);
    expect(execution).toEqual({ outcome: "payment_required", error: "verify_failed", paymentId: "pay-1" });
    expect(tool).not.toHaveProperty("awaitingPaymentDoesNotMeanUnpaid");
    expect(tool).not.toHaveProperty("nextStep");
  });
});

describe("status の射影", () => {
  const UNTIL = 1_800_000_119;
  test("source.mayStillSettleUntil があれば本文に組で出て、client の projection と MCP の文に届く。無ければ不変", async () => {
    const withField = await serve({ status: projection({ mayStillSettleUntil: UNTIL }) });
    const response = await fetch(`${withField.baseUrl}/v1/purchases/pay-1`, { headers: withField.headers });
    const body = (await response.json()) as { source: Record<string, unknown> };
    expect(body.source).toEqual({ amount: "2000", asset: OFFER.asset, network: OFFER.network, mayStillSettleUntil: UNTIL, awaitingPaymentDoesNotMeanUnpaid: true });
    const viaClient = await withField.client.status("pay-1");
    expect(viaClient.found && viaClient.projection.source).toMatchObject({ mayStillSettleUntil: UNTIL, awaitingPaymentDoesNotMeanUnpaid: true });
    const tool = await withField.mcp.status({ paymentId: "pay-1" });
    expect(String(tool["nextStep"])).toContain(new Date(UNTIL * 1000).toISOString());
    const without = await serve({ status: projection() });
    const plain = (await (await fetch(`${without.baseUrl}/v1/purchases/pay-1`, { headers: without.headers })).json()) as { source: Record<string, unknown> };
    expect(plain.source).toEqual({ amount: "2000", asset: OFFER.asset, network: OFFER.network });
    expect(await without.mcp.status({ paymentId: "pay-1" })).not.toHaveProperty("nextStep");
  });
});

describe("実装レビュー 1 の追加（design v5.2 §18）", () => {
  test("既存の quote_failed は内部の reason を本文に出さない（byte 単位で不変）。Retry-After は秒に切り上げる", async () => {
    const a = await serve({ quote: { ok: false, code: "quote_failed", reason: "no_matching_offer" } });
    const r = await fetch(`${a.baseUrl}/v1/quotes`, { method: "POST", headers: { ...a.headers, "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId: "r1" }) });
    expect([r.status, r.headers.get("retry-after"), await r.text()]).toEqual([502, null, JSON.stringify({ error: "quote_failed" })]);
    const b = await serve({ quote: { ok: false, code: "source_offer_unavailable", reason: "facilitator_busy", retryAfterMs: 30_500 } });
    const r2 = await fetch(`${b.baseUrl}/v1/quotes`, { method: "POST", headers: { ...b.headers, "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId: "r1" }) });
    expect(r2.headers.get("retry-after")).toBe("31");
    const c = await serve({ quote: { ok: false, code: "source_offer_unavailable", reason: "facilitator_busy", retryAfterMs: 1 } });
    const r3 = await fetch(`${c.baseUrl}/v1/quotes`, { method: "POST", headers: { ...c.headers, "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId: "r1" }) });
    expect(r3.headers.get("retry-after")).toBe("1");
  });

  test.each<[string, unknown]>([
    ["MAX_SAFE_INTEGER（Date の範囲外）", Number.MAX_SAFE_INTEGER],
    ["負", -1],
    ["小数", 1_800_000_000.5],
    ["文字列", "1800000000"],
    ["0", 0],
  ])("相手の mayStillSettleUntil が %s: purchase・status の client と MCP は投げず、欄も文も出さない", async (_name, value) => {
    // core の型を越える値を HTTP の本文に出す偽物（相手の Router が壊れている状況）。
    const served = await serve({
      purchase: { paymentId: "pay-1", status: "awaiting_payment", code: "verify_failed", mayStillSettleUntil: value as number },
      status: projection({ mayStillSettleUntil: value as number }),
    });
    const execution = await served.client.execute({ quote: quoteView(), requestId: "r1", approval: { approved: true, quoteId: OFFER.extra.challengeNonce }, credential: paymentHeader(OFFER) });
    expect(execution).toEqual({ outcome: "payment_required", error: "verify_failed", paymentId: "pay-1" });
    const tool = await served.mcp.purchase({ quoteId: OFFER.extra.challengeNonce, requestId: "r1", approval: OFFER.extra.challengeNonce, quote: quoteView(), credential: paymentHeader(OFFER) });
    expect(tool).not.toHaveProperty("nextStep");
    expect(tool).not.toHaveProperty("awaitingPaymentDoesNotMeanUnpaid");
    const status = await served.mcp.status({ paymentId: "pay-1" });
    expect(status).toMatchObject({ found: true });
    expect(status).not.toHaveProperty("nextStep");
  });
});

describe("閉じた quote（FR-4.5）: 公開の面は署名の対象を出さない", () => {
  test("HTTP の本文に offer・payTo・expiresAt が無く、closed・status・id・approval はある。client は closed を読み、MCP は署名しない案内（subject 無し）で、purchase は quote_closed", async () => {
    const document = quoteDocument();
    if (!document.ok) throw new Error("unreachable");
    const served = await serve({ quote: { ...document, closed: true, status: "awaiting_payment" } });
    const response = await fetch(`${served.baseUrl}/v1/quotes`, { method: "POST", headers: { ...served.headers, "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId: "r1" }) });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ quoteId: document.quoteId, paymentId: "pay-1", closed: true, status: "awaiting_payment", approval: { boundTo: document.quoteId } });
    expect(body["source"]).toEqual({ rail: "subetha-exact", amount: "2000", asset: OFFER.asset, decimals: 6, network: OFFER.network });
    expect(JSON.stringify(body)).not.toContain(OFFER.payTo);
    // offer の中身（domain の名前・束縛）は本文のどこにも無い（quoteId = nonce は id として出る）。
    expect(JSON.stringify(body)).not.toContain("zERC20 USD Coin");
    expect(JSON.stringify(body)).not.toContain("routeBinding");
    const viaClient = await served.client.quote({ routeId: ROUTE_ID, requestId: "r1" });
    expect(viaClient.ok && viaClient.quote).toMatchObject({ closed: true, status: "awaiting_payment" });
    const tool = await served.mcp.quote({ routeId: ROUTE_ID, requestId: "r1" });
    expect(tool).toMatchObject({ ok: true, closed: true, approvalRequired: false });
    expect(tool).not.toHaveProperty("subject");
    expect(String(tool["nextStep"])).toMatch(/already used \(status: awaiting_payment\)\. Do not sign anything/);
    const purchase = await served.mcp.purchase({ quoteId: document.quoteId, requestId: "r1", approval: document.quoteId, quote: (viaClient.ok ? viaClient.quote : undefined) as never, credential: "x" });
    expect(purchase).toMatchObject({ ok: false, error: "quote_closed" });
  });
  test("closed で無い文書は今までどおり（offer・payTo・expiresAt あり、closed の欄なし）", async () => {
    const served = await serve({});
    const body = (await (await fetch(`${served.baseUrl}/v1/quotes`, { method: "POST", headers: { ...served.headers, "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId: "r1" }) })).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("closed");
    expect(body).not.toHaveProperty("status");
    expect(body["source"]).toMatchObject({ payTo: OFFER.payTo, expiresAt: OFFER.extra.expiresAt, offer: OFFER });
  });
});

describe("閉じた quote: 控えと敵対的な値（実装レビュー 5）", () => {
  test("open の quote → 閉じた再 quote → 控えの文書での purchase は credential を作らず quote_closed（payer の呼び出し 0）。ids だけの purchase も同じ", async () => {
    const document = quoteDocument();
    if (!document.ok) throw new Error("unreachable");
    const script: { quote?: QuoteOutcome } = {};
    const served = await serve(script);
    let payerCalls = 0;
    const mcp = createToolHandlers({ client: served.client, mode: "real", evidence: EVIDENCE, payer: { address: "0xpayer", credentialFor: async () => { payerCalls += 1; return "credential"; } } as never });
    const open = await mcp.quote({ routeId: ROUTE_ID, requestId: "r1" });
    expect(open).toMatchObject({ ok: true, approvalRequired: true });
    script.quote = { ...document, closed: true, status: "unknown" };
    expect(await mcp.quote({ routeId: ROUTE_ID, requestId: "r1" })).toMatchObject({ closed: true });
    expect(await mcp.purchase({ quoteId: document.quoteId, requestId: "r1", approval: document.quoteId })).toMatchObject({ ok: false, error: "quote_closed" });
    expect(await mcp.purchase({ quoteId: document.quoteId, requestId: "r1", approval: document.quoteId, quote: open["quote"] as never })).toMatchObject({ ok: false, error: "quote_closed" });
    expect(payerCalls).toBe(0);
  });
  test("client: 閉じた再 quote は発行の控え（束縛）を上書きしない: 最初の文書での execute は束縛の不一致にならず Router まで届く", async () => {
    const document = quoteDocument();
    if (!document.ok) throw new Error("unreachable");
    const script: { quote?: QuoteOutcome; purchase?: PurchaseOutcome } = { purchase: { paymentId: "pay-1", status: "awaiting_payment", code: "verify_failed" } };
    const served = await serve(script);
    const strict = createRouterClient({ baseUrl: served.baseUrl, principalId: "alice", token: "tok" });
    const first = await strict.quote({ routeId: ROUTE_ID, requestId: "r1" });
    if (!first.ok) throw new Error("quote");
    script.quote = { ...document, closed: true, status: "awaiting_payment" };
    const closed = await strict.quote({ routeId: ROUTE_ID, requestId: "r1" });
    expect(closed.ok && closed.quote.closed).toBe(true);
    // canonical の origin は Router の設定値（router.invalid）なので resource の照合は client の baseUrl とは独立。
    const executed = await strict.execute({ quote: first.quote, requestId: "r1", approval: { approved: true, quoteId: first.quote.quoteId }, credential: paymentHeader(OFFER) });
    expect(executed).toEqual({ outcome: "payment_required", error: "verify_failed", paymentId: "pay-1" });
  });
  test.each<[string, unknown, unknown]>([["closed が文字列", "true", "x"], ["closed が 1", 1, "x"], ["status が自由な文", true, "https://leak.example SECRET"], ["status が数", true, 7]])("相手の値が %s: closed は厳密な true だけ、status は閉じた形の token だけ", async (_n, closedValue, statusValue) => {
    const document = quoteDocument();
    if (!document.ok) throw new Error("unreachable");
    const served = await serve({ quote: { ...document, closed: closedValue as true, status: statusValue as never } });
    const viaClient = await served.client.quote({ routeId: ROUTE_ID, requestId: "r1" });
    if (!viaClient.ok) throw new Error("quote");
    if (closedValue === true) {
      expect(viaClient.quote.closed).toBe(true);
      expect(viaClient.quote).not.toHaveProperty("status");
      const tool = await served.mcp.quote({ routeId: ROUTE_ID, requestId: "r1" });
      expect(String(tool["nextStep"])).toMatch(/status: unknown/);
      expect(JSON.stringify(tool)).not.toContain("leak.example");
    } else {
      expect(viaClient.quote).not.toHaveProperty("closed");
    }
  });
});
