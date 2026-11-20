/**
 * 受信レール `subetha-exact` の縦貫（実 `startRouter` の child + 合成 facilitator + x402 上流。`docs/subetha-exact-inbound-design.md` §10、タスク T-5）。
 * AC-1 の通し（実 EIP-712 の署名 = `createX402Payer`）、R1 の一覧、AC-2 (a)(b)(i)(m)、(l′) の開示、token の canary の不在。
 */
import { readFile } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";

// 実 process を何度も起動し直す（全体の試験の負荷の下では 5 秒を越える）。
vi.setConfig({ testTimeout: 90_000 });

import { ALICE, BEARER, CHAIN_ID, credentialOf, DEST_PAY_TO, NETWORK, principalHeaders, purchaseOf, quoteOf, ROUTE_ID, startExactHarness, statusOf, USDC, ZUSDC, type ExactHarness } from "../fixtures/subetha-exact-harness.js";

const started: ExactHarness[] = [];
afterEach(async () => {
  for (const h of started.splice(0)) await h.stopAll();
});
async function boot(options: Parameters<typeof startExactHarness>[0] = {}): Promise<ExactHarness> {
  const h = await startExactHarness(options);
  started.push(h);
  return h;
}

test("AC-1: R1 の一覧 → quote（facilitator の注文）→ 署名 → purchase: verify → settle → release → 上流 1 回 → delivered → complete。journal・ledger・fixture の順序", async () => {
  const h = await boot();
  expect(h.router.stdout()).toContain('"mode":"real"');
  // R1: 一覧に rail・scheme・fundsMoveOnCredential false。
  const listing = (await (await fetch(`${h.router.baseUrl}/v1/routes`, { headers: principalHeaders() })).json()) as { routes: Record<string, unknown>[] };
  const row = listing.routes.find((r) => r["routeId"] === ROUTE_ID)!;
  expect(row["source"]).toMatchObject({ rail: "subetha-exact", scheme: "exact", fundsMoveOnCredential: false, network: NETWORK, asset: ZUSDC, amount: "2000", decimals: 6 });
  expect(row["source"]).not.toHaveProperty("payTo");
  // quote: offer は facilitator の注文（payTo = burn address、nonce = orderId、domain は表の値）。
  const quote = await quoteOf(h, "req-1");
  expect(quote.status).toBe(200);
  const offer = quote.body.source.offer;
  expect(quote.body.source).toMatchObject({ rail: "subetha-exact", amount: "2000", asset: ZUSDC, network: NETWORK });
  expect(offer).toMatchObject({ scheme: "exact", amount: "2000", maxTimeoutSeconds: 150, extra: { name: "zERC20 USD Coin", version: "1", fundsMoveOnCredential: false } });
  const orderId = offer.extra.challengeNonce;
  expect(quote.body.quoteId).toBe(orderId);
  const order = await h.order(orderId);
  expect(order["saleId"]).toBe(quote.body.source.payTo);
  expect(JSON.stringify(quote.body)).not.toContain(BEARER);
  // 同じ requestId の再 quote は同じ文書（facilitator の existing）。
  const again = await quoteOf(h, "req-1");
  expect(again.body.quoteId).toBe(orderId);
  expect((await h.calls()).byRoute["create"]).toBe(1);
  // purchase: 実 EIP-712 の署名（npm run sign と同じ封筒）。
  const credential = await credentialOf(h, offer);
  const delivered = await purchaseOf(h, quote.body, "req-1", credential);
  expect(delivered.status).toBe(200);
  expect((delivered.body as { data: { price: string } }).data.price).toBe("3000.12");
  expect(delivered.raw.headers.get("x-router-payment-id")).toBe(quote.body.paymentId);
  const calls = await h.calls();
  expect(calls.byOrder[orderId]).toEqual({ create: 1, verify: 1, settle: 1, release: 1, complete: 1 });
  expect((await h.order(orderId))["release"]).toMatchObject({ deliveryKey: orderId, completed: { outcome: "delivered" } });
  expect(((await (await fetch(`${h.upstream.baseUrl}/calls`)).json()) as { payCalls: number }).payCalls).toBe(1);
  // journal の行の順序と ledger の行。
  const events = (await h.journal()).filter((r) => r.paymentId === quote.body.paymentId).map((r) => r.event);
  expect(events).toEqual(["created", "source_pending", "budget_reserved", "source_settled", "source_released", "destination_pending", "delivered", "source_completed"]);
  const created = (await h.journal()).find((r) => r.event === "created")!;
  expect((created.patch["source"] as Record<string, unknown>)["settleWindow"]).toBe(offer.extra.expiresAt);
  // 同じ requestId の再 quote は core が文書を返す（createOffer を呼ばない）ので ledger の attempt は 1 つ。
  expect((await h.ledger()).map((r) => r.event)).toEqual(["requested", "created", "verify", "settle", "release", "complete"]);
  // status: delivered、release の欄は射影に無い、開示の欄も無い（settle 済み）。
  const status = await statusOf(h, quote.body.paymentId);
  expect(status.body).toMatchObject({ status: "delivered", source: { txRef: expect.stringMatching(/^0x[0-9a-f]{64}$/) } });
  expect(JSON.stringify(status.body)).not.toContain("deliveryKey");
  expect(status.body["source"]).not.toHaveProperty("mayStillSettleUntil");
  // 再提出は現在の終端（facilitator を呼ばない）。
  const resent = await purchaseOf(h, quote.body, "req-1", credential);
  expect(resent.status).toBe(200);
  expect((await h.calls()).byOrder[orderId]).toEqual(calls.byOrder[orderId]);
  // token・署名の canary が応答・起動ログに無い。
  for (const text of [h.router.stdout(), h.router.stderr(), JSON.stringify(status.body)]) {
    expect(text).not.toContain(BEARER);
    expect(text).not.toContain(String((JSON.parse(Buffer.from(credential, "base64").toString("utf8")) as { payload: { signature: string } }).payload.signature));
  }
});

test("(a) 署名の無い購入は 402 + offer の再提示 + 開示（上限）。(b) 別の鍵の署名・改変した offer は preflight／verify で止まり settle 0。(i) 期限の近い quote は facilitator の verify で落ち、開示は正確な validBefore", async () => {
  const h = await boot();
  const quote = await quoteOf(h, "req-a");
  const bare = await purchaseOf(h, quote.body, "req-a");
  expect(bare.status).toBe(402);
  expect(bare.body).toMatchObject({ error: "payment_required", mayStillSettleUntil: quote.body.source.offer.extra.expiresAt, awaitingPaymentDoesNotMeanUnpaid: true });
  expect((bare.body["accepts"] as unknown[])[0]).toMatchObject({ payTo: quote.body.source.payTo });
  // 改変した offer（額）に署名: preflight で offer_mismatch（facilitator を呼ばない）。
  const tampered = await credentialOf(h, { ...quote.body.source.offer, amount: "1" } as never);
  const rejected = await purchaseOf(h, quote.body, "req-a", tampered);
  expect(rejected.status).toBe(402);
  expect(rejected.body).toMatchObject({ error: "offer_mismatch", mayStillSettleUntil: quote.body.source.offer.extra.expiresAt });
  expect((await h.calls()).byRoute["verify"]).toBeUndefined();
  // 正しい封筒だが facilitator が拒む（verify invalid）: awaiting_payment + 正確な validBefore、settle 0。
  await h.setMode("verify", "invalid");
  const credential = await credentialOf(h, quote.body.source.offer);
  const refused = await purchaseOf(h, quote.body, "req-a", credential);
  expect(refused.status).toBe(402);
  expect(refused.body).toMatchObject({ error: "verify_failed", status: "awaiting_payment", mayStillSettleUntil: quote.body.source.offer.extra.expiresAt, awaitingPaymentDoesNotMeanUnpaid: true });
  expect((await h.calls()).byRoute).toMatchObject({ verify: 1 });
  expect((await h.calls()).byRoute["settle"]).toBeUndefined();
  expect((await h.journal()).at(-1)).toMatchObject({ event: "source_failed", patch: { reason: "verify_failed", mayStillSettleUntil: quote.body.source.offer.extra.expiresAt } });
  const status = await statusOf(h, quote.body.paymentId);
  expect(status.body["source"]).toMatchObject({ mayStillSettleUntil: quote.body.source.offer.extra.expiresAt, awaitingPaymentDoesNotMeanUnpaid: true });
  // (m) created を離れた後の再 quote は閉じた quote: closed・status があり、署名の対象（offer・payTo・expiresAt）は無い。facilitator の作成も呼ばない。
  await h.setMode("verify", "ok");
  const createsBefore = (await h.calls()).byRoute["create"];
  const closed = await quoteOf(h, "req-a");
  expect(closed.status).toBe(200);
  expect(closed.body).toMatchObject({ quoteId: quote.body.quoteId, paymentId: quote.body.paymentId, closed: true, status: "awaiting_payment" });
  expect(closed.body.source).not.toHaveProperty("offer");
  expect(closed.body.source).not.toHaveProperty("payTo");
  expect(closed.body.source).not.toHaveProperty("expiresAt");
  expect(JSON.stringify(closed.body)).not.toContain(quote.body.source.payTo);
  expect((await h.calls()).byRoute["create"]).toBe(createsBefore);
  // `npm run sign` はその文書を拒む（鍵を読まない）。
  const { runSign } = await import("../../tools/sign-run.js");
  const signed = await runSign(closed.body, { nowMs: () => Date.now(), readEvmKey: () => { throw new Error("key must not be read"); } } as never);
  expect(signed).toMatchObject({ ok: false, reason: expect.stringMatching(/already used \(status awaiting_payment\)/) });
  // 元の credential での purchase も facilitator を呼ばずに現在の状態。402 の再提示にも offer は無い。
  const once = await purchaseOf(h, quote.body, "req-a", credential);
  expect(once.status).toBe(402);
  expect(once.body["error"]).toBe("verify_failed");
  expect(once.body["accepts"]).toEqual([]);
  expect((await h.calls()).byRoute).toMatchObject({ verify: 1 });
  expect((await h.calls()).byRoute["settle"]).toBeUndefined();
});

test("source_offer_unavailable: facilitator が busy なら 503 + Retry-After 30、本文に reason、journal に行なし。注文が無いので quote を取り直せる", async () => {
  const h = await boot();
  await h.setMode("create", "busy");
  const busy = await quoteOf(h, "req-b");
  expect([busy.status, busy.headers.get("retry-after")]).toEqual([503, "30"]);
  expect(busy.body).toEqual({ error: "source_offer_unavailable", reason: "facilitator_busy" });
  expect(await h.journal()).toEqual([]);
  expect((await h.ledger()).map((r) => r.event)).toEqual(["requested", "create_failed"]);
  await h.setMode("create", "ok");
  expect((await quoteOf(h, "req-b")).status).toBe(200);
  // 403（額の方針）は 502 + reason。
  await h.setMode("create", "raw", { status: 403, headers: { "content-type": "application/json" }, body: { error: "amount not allowed by the run policy" } });
  const refused = await quoteOf(h, "req-c");
  expect([refused.status, refused.body]).toEqual([502, { error: "source_offer_refused", reason: "amount_refused" }]);
});

test("(l′) 外部の支払い: Router の経路の外で accepted になった注文は、Router の status では awaiting_payment + 開示のまま（Router は資金を主張しない）。release の refused は paid_undelivered と上流 0", async () => {
  const h = await boot();
  const quote = await quoteOf(h, "req-l");
  const orderId = quote.body.source.offer.extra.challengeNonce;
  await fetch(`${h.facilitator.baseUrl}/_fixture/orders/${orderId}/paid-external`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect((await h.order(orderId))["state"]).toBe("accepted");
  const status = await statusOf(h, quote.body.paymentId);
  expect(status.body).toMatchObject({ status: "awaiting_payment", source: { mayStillSettleUntil: quote.body.source.offer.extra.expiresAt, awaitingPaymentDoesNotMeanUnpaid: true } });
  // 別の quote: settle の後で release が incident → paid_undelivered（source_release_refused）、上流 0、complete 無し。
  const q2 = await quoteOf(h, "req-r");
  await h.setMode("release", "incident");
  const credential = await credentialOf(h, q2.body.source.offer);
  const outcome = await purchaseOf(h, q2.body, "req-r", credential);
  expect(outcome.status).toBe(502);
  expect(outcome.body).toMatchObject({ status: "paid_data_unavailable", terminalReason: "source_release_refused" });
  expect(outcome.body).not.toHaveProperty("mayStillSettleUntil");
  const calls = await h.calls();
  expect(calls.byOrder[q2.body.source.offer.extra.challengeNonce]).toEqual({ create: 1, verify: 1, settle: 1, release: 1 });
  expect(((await (await fetch(`${h.upstream.baseUrl}/calls`)).json()) as { payCalls: number }).payCalls).toBe(0);
  expect((await h.journal()).filter((r) => r.paymentId === q2.body.paymentId).map((r) => r.event)).toEqual(["created", "source_pending", "budget_reserved", "source_settled", "paid_undelivered"]);
});

test("復元 D／D′: claimed-before（最初の POST が already-claimed）と lose-response は GET で復元して delivered に至り、上流の支払いは 1 回。corrupt なら paid_undelivered と上流 0", async () => {
  const h = await boot();
  for (const [mode, requestId] of [["claimed-before", "req-d"], ["lose-response", "req-dd"]] as const) {
    await h.setMode("release", mode);
    const quote = await quoteOf(h, requestId);
    const delivered = await purchaseOf(h, quote.body, requestId, await credentialOf(h, quote.body.source.offer));
    expect(delivered.status, mode).toBe(200);
    const orderId = quote.body.source.offer.extra.challengeNonce;
    expect((await h.calls()).byOrder[orderId], mode).toMatchObject({ release: 1, status: 1, complete: 1 });
    expect((await h.order(orderId))["release"], mode).toMatchObject({ completed: { outcome: "delivered" } });
    expect((await h.ledger()).filter((r) => r.event === "release").at(-1)?.patch, mode).toMatchObject({ outcome: "released", reconstructed: true });
    await h.setMode("release", "ok");
  }
  expect(((await (await fetch(`${h.upstream.baseUrl}/calls`)).json()) as { payCalls: number }).payCalls).toBe(2);
  await h.setMode("release", "claimed-before");
  await h.setMode("status", "corrupt:release.txRef");
  const quote = await quoteOf(h, "req-x");
  const outcome = await purchaseOf(h, quote.body, "req-x", await credentialOf(h, quote.body.source.offer));
  expect(outcome.status).toBe(502);
  expect(outcome.body).toMatchObject({ terminalReason: "source_release_refused" });
  expect(((await (await fetch(`${h.upstream.baseUrl}/calls`)).json()) as { payCalls: number }).payCalls).toBe(2);
});

test("quote の文書の rail と束縛: source.rail は subetha-exact、destination は route の受取先、routeBinding は canonical path。一覧と quote の offer は同じ domain", async () => {
  const h = await boot();
  const quote = await quoteOf(h, "req-m");
  expect(quote.body.source).toMatchObject({ rail: "subetha-exact", decimals: 6 });
  expect(quote.body.destination).toMatchObject({ rail: "x402", payTo: DEST_PAY_TO, asset: USDC, network: NETWORK });
  expect(quote.body.source.offer.extra.routeBinding).toBe(`${ROUTE_ID}|GET|%2Fv1%2Froutes%2F${ROUTE_ID}%2Fresource`);
  expect(quote.body.source.offer).toMatchObject({ extra: { name: "zERC20 USD Coin", version: "1" }, network: `eip155:${CHAIN_ID}` });
  // 一覧の row と quote の source は同じ network・資産（payer の `routeRowsOf` が読む欄）。
  const listing = (await (await fetch(`${h.router.baseUrl}/v1/routes`, { headers: principalHeaders() })).json()) as { routes: Record<string, unknown>[] };
  const row = listing.routes.find((r) => r["routeId"] === ROUTE_ID)!;
  expect(row["source"]).toMatchObject({ network: quote.body.source["network"], asset: quote.body.source["asset"], rail: "subetha-exact" });
  // 文書に principal・token は無い。
  expect(JSON.stringify(quote.body)).not.toContain(ALICE.token);
});

test("AC-5: inspect の読み取りは fixture を呼ばず（--remote は GET だけ）、journal・ledger の byte を変えない。(l′) の食い違いは mismatch に出る", async () => {
  const { inspect } = await import("../../tools/subetha-exact-inspect.js");
  const h = await boot();
  const good = await quoteOf(h, "req-ok");
  expect((await purchaseOf(h, good.body, "req-ok", await credentialOf(h, good.body.source.offer))).status).toBe(200);
  // (l′): verify が拒んだ後に外から払われる。
  await h.setMode("verify", "invalid");
  const q = await quoteOf(h, "req-ext");
  expect((await purchaseOf(h, q.body, "req-ext", await credentialOf(h, q.body.source.offer))).status).toBe(402);
  await h.setMode("verify", "ok");
  const orderId = q.body.source.offer.extra.challengeNonce;
  await fetch(`${h.facilitator.baseUrl}/_fixture/orders/${orderId}/paid-external`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const before = { journal: await readFile(h.journalPath, "utf8"), ledger: await readFile(h.ledgerPath, "utf8"), calls: JSON.parse(JSON.stringify(await h.calls())) as { byRoute: Record<string, number> } };
  // Router は動いたまま（読取は lock を取らない）。
  const local = await inspect({ journalPath: h.journalPath });
  expect(local.at(-1)).toMatchObject({ kind: "summary", attempts: 2, remote: false });
  expect(await h.calls()).toEqual(before.calls);
  const remote = await inspect({ journalPath: h.journalPath, remote: { facilitatorUrl: h.env["ROUTER_SUBETHA_EXACT_FACILITATOR_URL"]!, token: () => BEARER, allowLoopback: true } });
  const line = remote.find((l) => l.kind === "attempt" && l["orderId"] === orderId)!;
  expect(line).toMatchObject({ terminal: "source_failed", remote: { state: "accepted", release: { state: "none" }, exact: { origin: "external-broadcast" } }, mismatch: true, mayStillSettleUntil: q.body.source.offer.extra.expiresAt });
  expect(remote.find((l) => l.kind === "attempt" && l["orderId"] === good.body.source.offer.extra.challengeNonce)).toMatchObject({ terminal: "delivered", remote: { release: { state: "delivered" } }, mismatch: false });
  const after = await h.calls();
  expect(after.byRoute["status"]).toBe((before.calls.byRoute["status"] ?? 0) + 2);
  for (const route of ["create", "verify", "settle", "release", "complete", "requesters"]) expect(after.byRoute[route] ?? 0, route).toBe(before.calls.byRoute[route] ?? 0);
  expect(await readFile(h.journalPath, "utf8")).toBe(before.journal);
  expect(await readFile(h.ledgerPath, "utf8")).toBe(before.ledger);
  expect(JSON.stringify(remote)).not.toContain(BEARER);
});
