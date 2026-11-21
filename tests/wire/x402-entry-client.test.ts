/**
 * 標準の x402 v2 クライアント用の入口（`docs/x402-standard-entry-design.md` §9 T-d。要件 AC-1〜AC-7、AC-10）。
 * **手を加えていない `@x402/fetch` の `wrapFetchWithPayment` + `@x402/evm` の `exact` client** が、URL と Bearer だけで買えること。
 * 相手は実 `startRouter` の child と合成 facilitator・x402 上流（前スライスの harness）。試験は authorization を書き換えない（signer を包んで数えるだけ）。
 */
import http from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

vi.setConfig({ testTimeout: 90_000 });

import { ALICE, CANONICAL_BASE_URL, CHAIN_ID, NETWORK, principalHeaders, ROUTE_ID, startExactHarness, statusOf, ZUSDC, type ExactHarness } from "../fixtures/subetha-exact-harness.js";

const started: ExactHarness[] = [];
afterEach(async () => {
  for (const h of started.splice(0)) await h.stopAll();
});
async function boot(options: Parameters<typeof startExactHarness>[0] = {}): Promise<ExactHarness> {
  const h = await startExactHarness(options);
  started.push(h);
  return h;
}
const entryUrl = (h: ExactHarness, routeId = ROUTE_ID): string => `${h.router.baseUrl}/x402/v1/routes/${routeId}/resource`;

interface Exchange { readonly status: number; readonly sent: Record<string, string>; readonly received: Record<string, string> }
/** 実物のクライアント: 普通の signer と network の登録、zUSDC を払ってよい資産に足す設定だけ（hook・fetch の書き換え・payload の加工なし）。署名の回数と通信を記録する。 */
function standardClient() {
  const account = privateKeyToAccount(generatePrivateKey());
  const signed: Record<string, unknown>[] = [];
  const signer = {
    address: account.address,
    signTypedData: async (args: Parameters<typeof account.signTypedData>[0]) => {
      signed.push((args as { message: Record<string, unknown> }).message);
      return account.signTypedData(args);
    },
  };
  // 標準クライアントは既定で「既定の資産」（USDC など）にしか払わない（spendControls）。zUSDC は既定の資産ではないので、買い手が明示して許す。
  // これは library の普通の設定であり、hook でも Router 向けの加工でもない。
  const client = x402Client.fromConfig({
    schemes: [{ network: NETWORK as `${string}:${string}`, client: new ExactEvmScheme(signer as never) }],
    spendControls: { allowedAssets: [{ network: NETWORK as `${string}:${string}`, asset: ZUSDC, maxAmountPerPayment: "20000" }] },
  });
  const exchanges: Exchange[] = [];
  const recording: typeof fetch = async (input, init) => {
    const request = new Request(input as Parameters<typeof fetch>[0] as string, init);
    const response = await fetch(request.clone());
    exchanges.push({ status: response.status, sent: Object.fromEntries(request.headers.entries()), received: Object.fromEntries(response.headers.entries()) });
    return response;
  };
  return { account, signed, exchanges, fetchWithPayment: wrapFetchWithPayment(recording, client) };
}

/** 標準 offer を 1 つ取る（credential なしの GET）。 */
async function challengeOf(h: ExactHarness, routeId = ROUTE_ID, headers: Record<string, string> = principalHeaders()) {
  const response = await fetch(entryUrl(h, routeId), { headers });
  const header = response.headers.get("payment-required");
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body, required: header === null ? undefined : (decodePaymentRequiredHeader(header) as unknown as { x402Version: number; accepts: Record<string, unknown>[]; resource: { url: string } }) };
}
const AUTH_TYPES = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] } as const;
/** 手で作る credential（境界の試験用。標準クライアントと同じ形）。 */
async function handSigned(account: ReturnType<typeof privateKeyToAccount>, accepted: Record<string, unknown>, over: { validBefore?: number; nonce?: `0x${string}`; from?: string; reorder?: boolean } = {}) {
  const extra = accepted["extra"] as { name: string; version: string };
  const authorization = {
    from: account.address,
    to: accepted["payTo"] as `0x${string}`,
    value: String(accepted["amount"]),
    validAfter: "0",
    validBefore: String(over.validBefore ?? Math.floor(Date.now() / 1000) + Number(accepted["maxTimeoutSeconds"])),
    nonce: over.nonce ?? (`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`),
  };
  const signature = await account.signTypedData({
    domain: { name: extra.name, version: extra.version, chainId: CHAIN_ID, verifyingContract: ZUSDC as `0x${string}` },
    types: AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  });
  const sent = { ...authorization, ...(over.from === undefined ? {} : { from: over.from }) };
  const payload = over.reorder === true
    ? { payload: { signature: signature.toUpperCase().replace("0X", "0x"), authorization: { nonce: sent.nonce, validBefore: sent.validBefore, validAfter: sent.validAfter, value: sent.value, to: sent.to.toLowerCase(), from: sent.from } }, accepted, x402Version: 2 }
    : { x402Version: 2, accepted, payload: { authorization: sent, signature } };
  return { header: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"), authorization: sent };
}
const pay = (h: ExactHarness, header: string) => fetch(entryUrl(h), { headers: { ...principalHeaders(), "PAYMENT-SIGNATURE": header } });
const noChallenge = (response: Response): void => {
  expect(response.status).not.toBe(402);
  expect(response.headers.get("payment-required")).toBeNull();
};

test("AC-1／AC-2: 標準クライアントが URL と Bearer だけで 402 → 署名 1 回 → 再送 → 200。署名はクライアントが作ったまま。journal・fixture・R4・一覧・同じ credential の再送・入口をまたがない", async () => {
  const h = await boot();
  const c = standardClient();
  const before = Math.floor(Date.now() / 1000);
  const response = await c.fetchWithPayment(entryUrl(h), { headers: principalHeaders() });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { data: { price: string } }).data.price).toBe("3000.12");
  // 通信: 402 → Bearer 付きの再送 → 200。署名は 1 回。
  expect(c.exchanges.map((e) => e.status)).toEqual([402, 200]);
  expect(c.signed).toHaveLength(1);
  expect(c.exchanges[1]!.sent["authorization"]).toBe(`Bearer ${ALICE.token}`);
  expect(c.exchanges[0]!.sent["payment-signature"]).toBeUndefined();
  // 402: 実物の library で decode できる。requirements は facilitator の 8 項目だけ。Router の項目を出さない。
  const required = decodePaymentRequiredHeader(c.exchanges[0]!.received["payment-required"]!) as unknown as { x402Version: number; resource: { url: string }; accepts: Record<string, unknown>[] };
  expect(required.x402Version).toBe(2);
  expect(required.resource.url).toBe(`${CANONICAL_BASE_URL}/x402/v1/routes/${ROUTE_ID}/resource`);
  expect(required.accepts).toHaveLength(1);
  const accepted = required.accepts[0]!;
  expect(Object.keys(accepted).sort()).toEqual(["amount", "asset", "extra", "maxTimeoutSeconds", "network", "payTo", "scheme"]);
  expect(accepted).toMatchObject({ scheme: "exact", network: NETWORK, asset: ZUSDC, amount: "2000", maxTimeoutSeconds: 150, extra: { name: "zERC20 USD Coin", version: "1" } });
  expect(Object.keys(accepted["extra"] as object).sort()).toEqual(["name", "version"]);
  expect(JSON.stringify(required)).not.toMatch(/quoteId|paymentId|requestId|challengeNonce|routeBinding/);
  // 署名（AC-2）: validAfter 0、validBefore = now + maxTimeoutSeconds、乱数の nonce（注文 id ではない）。再送の payload はその写し。
  const sent = decodePaymentSignatureHeader(c.exchanges[1]!.sent["payment-signature"]!) as unknown as { x402Version: number; accepted: Record<string, unknown>; payload: { authorization: Record<string, string> } };
  const auth = sent.payload.authorization;
  expect(sent.x402Version).toBe(2);
  expect(auth["validAfter"]).toBe("0");
  expect(Number(auth["validBefore"])).toBeGreaterThanOrEqual(before + 150);
  expect(Number(auth["validBefore"])).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 150);
  expect(auth["to"]).toBe(accepted["payTo"]);
  expect(auth["from"]).toBe(c.account.address);
  expect(String(c.signed[0]!["nonce"])).toBe(auth["nonce"]);
  // 200: PAYMENT-RESPONSE を実物の library で decode。transaction・network・payer。
  const paymentId = c.exchanges[1]!.received["x-router-payment-id"]!;
  const settled = decodePaymentResponseHeader(c.exchanges[1]!.received["payment-response"]!) as unknown as Record<string, unknown>;
  const status = await statusOf(h, paymentId);
  expect(status.body).toMatchObject({ status: "delivered" });
  expect(status.body["source"]).not.toHaveProperty("mayStillSettleUntil");
  expect(settled).toEqual({ success: true, transaction: (status.body["source"] as { txRef: string }).txRef, network: NETWORK, payer: c.account.address });
  // journal: 前スライスの AC-1 の順に、結び付けの行が verify の前に入る。fixture の注文は release 済み・delivered。
  const journal = await h.journal();
  const events = journal.filter((r) => r.paymentId === paymentId).map((r) => r.event);
  expect(events).toEqual(["created", "source_credential_bound", "source_pending", "budget_reserved", "source_settled", "source_released", "destination_pending", "delivered", "source_completed"]);
  const created = journal.find((r) => r.paymentId === paymentId && r.event === "created")!;
  const offer = (created.patch["source"] as { offer: { payTo: string; extra: Record<string, unknown> } }).offer;
  const orderId = String(offer.extra["challengeNonce"]);
  expect(auth["nonce"]).not.toBe(orderId);
  expect(offer.extra["entry"]).toBe("x402");
  expect(String(created.patch["requestId"])).toMatch(/^x402e:[0-9a-f]{32}$/);
  const order = await h.order(orderId);
  expect(offer.extra["expiresAt"]).toBe(order["expiresAt"]);
  expect(order["release"]).toMatchObject({ completed: { outcome: "delivered" } });
  const calls = await h.calls();
  expect(calls.byOrder[orderId]).toEqual({ create: 1, verify: 1, settle: 1, release: 1, complete: 1 });
  const bound = journal.find((r) => r.paymentId === paymentId && r.event === "source_credential_bound")!;
  expect(bound.patch).toMatchObject({ payer: c.account.address, validBefore: Number(auth["validBefore"]) });
  // 同じ credential の再送（そのままと、JSON の順序・大小を変えたもの）: 同じ本文、facilitator の呼び出しは増えない。
  const header = c.exchanges[1]!.sent["payment-signature"]!;
  const again = await pay(h, header);
  expect(again.status).toBe(200);
  expect(((await again.json()) as { data: { price: string } }).data.price).toBe("3000.12");
  const p = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepted: unknown; payload: { authorization: Record<string, string>; signature: string } };
  const reordered = Buffer.from(JSON.stringify({ payload: { signature: p.payload.signature, authorization: Object.fromEntries(Object.entries(p.payload.authorization).reverse().map(([k, v]) => [k, k === "from" || k === "to" ? v.toLowerCase() : v])) }, accepted: p.accepted, x402Version: 2 }), "utf8").toString("base64");
  expect(reordered).not.toBe(header);
  expect((await pay(h, reordered)).status).toBe(200);
  expect((await h.calls()).byOrder[orderId]).toEqual(calls.byOrder[orderId]);
  // 入口をまたがない: 標準 offer の quoteId は R3 では存在しない（再提示もしない）。一覧は標準入口の URL を示す。
  const r3 = await fetch(`${h.router.baseUrl}/v1/routes/${ROUTE_ID}/resource`, { headers: { ...principalHeaders(), "x-router-quote-id": orderId } });
  expect(((await r3.json()) as { accepts: unknown[] }).accepts).toEqual([]);
  const r3Paid = await fetch(`${h.router.baseUrl}/v1/routes/${ROUTE_ID}/resource`, { headers: { ...principalHeaders(), "x-router-quote-id": orderId, "x-payment": Buffer.from(JSON.stringify({ x402Version: 2, accepted: p.accepted, payload: { ...p.payload, challengeNonce: orderId } })).toString("base64") } });
  expect([200, 402]).not.toContain(r3Paid.status);
  expect((await h.calls()).byOrder[orderId]).toEqual(calls.byOrder[orderId]);
  const listing = (await (await fetch(`${h.router.baseUrl}/v1/routes`, { headers: principalHeaders() })).json()) as { routes: Record<string, unknown>[] };
  expect(listing.routes.find((r) => r["routeId"] === ROUTE_ID)!["x402Url"]).toBe(`${CANONICAL_BASE_URL}/x402/v1/routes/${ROUTE_ID}/resource`);
  // 秘密と署名が起動ログに無い。
  for (const text of [h.router.stdout(), h.router.stderr()]) expect(text).not.toContain(p.payload.signature);
});

test("AC-3: 買えなかった場合の応答は 402 でなく、PAYMENT-REQUIRED を持たず、実物のクライアントは 2 つ目の署名を作らない。開示は結び付いた credential の validBefore", async () => {
  const cases: { name: string; arrange: (h: ExactHarness) => Promise<void>; error: string; settled?: boolean; boot?: Parameters<typeof startExactHarness>[0] }[] = [
    { name: "verify refused", arrange: (h) => h.setMode("verify", "invalid"), error: "payment_not_completed" },
    { name: "verify 500", arrange: (h) => h.setMode("verify", "raw", { status: 500, body: "{}" }), error: "payment_unresolved" },
    { name: "verify unreadable", arrange: (h) => h.setMode("verify", "unreadable"), error: "payment_unresolved" },
    { name: "settle error", arrange: (h) => h.setMode("settle", "error"), error: "payment_unresolved" },
    { name: "upstream paid no data", arrange: async () => undefined, error: "paid_no_data", settled: true, boot: { upstreamArgs: ["--pay", "html"] } },
  ];
  for (const item of cases) {
    const h = await boot(item.boot ?? {});
    await item.arrange(h);
    const c = standardClient();
    const response = await c.fetchWithPayment(entryUrl(h), { headers: principalHeaders() });
    const body = (await response.json()) as Record<string, unknown>;
    expect([item.name, response.status, body["error"]]).toEqual([item.name, 409, item.error]);
    noChallenge(response);
    expect(c.signed, item.name).toHaveLength(1);
    expect(c.exchanges.map((e) => e.status), item.name).toEqual([402, 409]);
    expect(typeof body["paymentId"], item.name).toBe("string");
    const auth = (decodePaymentSignatureHeader(c.exchanges[1]!.sent["payment-signature"]!) as unknown as { payload: { authorization: Record<string, string> } }).payload.authorization;
    const source = body["source"] as Record<string, unknown>;
    if (item.settled === true) {
      // settle が確定: 支払いは成立と言い、「まだ払われ得る」は言わない。
      expect(decodePaymentResponseHeader(response.headers.get("payment-response")!), item.name).toMatchObject({ success: true, payer: c.account.address });
      expect(source, item.name).not.toHaveProperty("mayStillSettleUntil");
    } else {
      expect(response.headers.get("payment-response"), item.name).toBeNull();
      expect(source["mayStillSettleUntil"], item.name).toBe(Number(auth["validBefore"]));
      expect(source["awaitingPaymentDoesNotMeanUnpaid"], item.name).toBe(true);
      expect(String(body["note"]), item.name).toContain("not proof that nothing was paid");
      // R4 でも同じ開示。公開の状態は rejected ではない。
      const status = await statusOf(h, String(body["paymentId"]));
      expect((status.body["source"] as Record<string, unknown>)["mayStillSettleUntil"], item.name).toBe(Number(auth["validBefore"]));
      expect(status.body["status"], item.name).not.toBe("rejected");
    }
    // 同じ credential の再送は記録を返し、facilitator の verify／settle は増えない。
    const callsBefore = await h.calls();
    const resent = await pay(h, c.exchanges[1]!.sent["payment-signature"]!);
    expect([item.name, resent.status]).toEqual([item.name, 409]);
    noChallenge(resent);
    const callsAfter = await h.calls();
    expect([callsAfter.byRoute["verify"], callsAfter.byRoute["settle"]], item.name).toEqual([callsBefore.byRoute["verify"], callsBefore.byRoute["settle"]]);
    await h.stopAll();
    started.splice(started.indexOf(h), 1);
  }
});

test("AC-3: verify の通信失敗は journal で unknown、明示の拒否は verify_failed（rejected にまとめない）", async () => {
  const h = await boot();
  await h.setMode("verify", "raw", { status: 502, body: "bad gateway" });
  const c = standardClient();
  const first = (await (await c.fetchWithPayment(entryUrl(h), { headers: principalHeaders() })).json()) as { paymentId: string; status: string };
  expect(first.status).toBe("unknown");
  const rows = (await h.journal()).filter((r) => r.paymentId === first.paymentId);
  expect(rows.map((r) => r.event)).toEqual(["created", "source_credential_bound", "source_pending", "unknown"]);
  expect(rows.at(-1)!.patch).toMatchObject({ reason: "source_verify_unavailable" });
  await h.setMode("verify", "invalid");
  const c2 = standardClient();
  const second = (await (await c2.fetchWithPayment(entryUrl(h), { headers: principalHeaders() })).json()) as { paymentId: string; status: string; code: string };
  expect([second.status, second.code]).toEqual(["awaiting_payment", "verify_failed"]);
});

test("AC-2／AC-5／AC-7: 遅れた本物の署名と偽の署名は手元で拒む（fixture を呼ばない）。1 注文に 1 credential。引けない payTo は固定の 404", async () => {
  const h = await boot();
  const account = privateKeyToAccount(generatePrivateKey());
  const first = await challengeOf(h);
  expect(first.response.status).toBe(402);
  const accepted = first.required!.accepts[0]!;
  const orderExpiry = Number(((await h.journal()).find((r) => r.event === "created")!.patch["source"] as { offer: { extra: { expiresAt: number } } }).offer.extra.expiresAt);
  // 遅れた本物の署名: validBefore が注文の期限を超える → 409、結び付けない、その credential の validBefore を示す。
  const late = await handSigned(account, accepted, { validBefore: orderExpiry + 1 });
  const lateResponse = await pay(h, late.header);
  const lateBody = (await lateResponse.json()) as Record<string, unknown>;
  expect([lateResponse.status, lateBody["error"], lateBody["presentedValidBefore"]]).toEqual([409, "payment_not_accepted", orderExpiry + 1]);
  expect(String(lateBody["note"])).toContain("did not forward this credential");
  expect((lateBody["source"] as Record<string, unknown>)["mayStillSettleUntil"]).toBe(orderExpiry);
  noChallenge(lateResponse);
  // 偽の署名（from が署名者でない）: 409、期限は示さない。
  const forged = await handSigned(account, accepted, { from: privateKeyToAccount(generatePrivateKey()).address });
  const forgedBody = (await (await pay(h, forged.header)).json()) as Record<string, unknown>;
  expect([forgedBody["error"], forgedBody["presentedValidBefore"]]).toEqual(["payment_not_accepted", undefined]);
  // 写しの 8 項目が違う → 409。
  const tampered = await handSigned(account, { ...accepted, amount: "1" });
  expect(((await (await pay(h, tampered.header)).json()) as Record<string, unknown>)["error"]).toBe("payment_not_accepted");
  expect((await h.calls()).byRoute["verify"] ?? 0).toBe(0);
  expect((await h.journal()).map((r) => r.event)).toEqual(["created"]);
  // 境界: validBefore = 注文の期限ちょうどは受ける。verify を止めておき、同時に違う credential と同じ credential を送る。
  await h.setMode("verify", "slow:400");
  const good = await handSigned(account, accepted, { validBefore: orderExpiry });
  const other = await handSigned(account, accepted, { validBefore: orderExpiry - 1 });
  const same = await handSigned(account, accepted, { validBefore: orderExpiry, nonce: good.authorization.nonce as `0x${string}`, reorder: true });
  const [a, b, d] = await Promise.all([pay(h, good.header), pay(h, other.header), pay(h, same.header)]);
  expect([a.status, d.status]).toEqual([200, 200]);
  const conflict = (await b.json()) as Record<string, unknown>;
  expect([b.status, conflict["error"]]).toEqual([409, "credential_conflict"]);
  expect(String(conflict["note"])).toContain("did not forward this credential");
  expect(typeof conflict["paymentId"]).toBe("string");
  noChallenge(b);
  const calls = await h.calls();
  expect([calls.byRoute["verify"], calls.byRoute["settle"]]).toEqual([1, 1]);
  expect((await h.journal()).filter((r) => r.event === "source_credential_bound")).toHaveLength(1);
  // 引けない: 知らない payTo、別の route、別の principal（存在しない token は 401 が先）。どれも同じ固定の 404。
  const unknownPayTo = await handSigned(account, { ...accepted, payTo: "0x00000000000000000000000000000000000000ff" });
  const miss = await pay(h, unknownPayTo.header);
  const missText = await miss.text();
  const otherRoute = await fetch(entryUrl(h, "no-such-route"), { headers: { ...principalHeaders(), "PAYMENT-SIGNATURE": good.header } });
  expect([miss.status, otherRoute.status]).toEqual([404, 404]);
  expect(await otherRoute.text()).toBe(missText);
  expect(missText).toBe(JSON.stringify({ error: "not_found" }));
  expect((await fetch(entryUrl(h), { headers: { authorization: "Bearer nope" } })).status).toBe(401);
});

test("AC-4: credential なしの GET は毎回新しい注文（同じ offer を 2 度見せない）。枠が尽きたら 503 + Retry-After で 402 ではない。届かなかった注文は再び見せられない", async () => {
  const h = await boot();
  const payTos: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const { response, required } = await challengeOf(h);
    expect(response.status).toBe(402);
    payTos.push(String(required!.accepts[0]!["payTo"]));
  }
  expect(new Set(payTos).size).toBe(3);
  // 入口をまたがない: まだ買われていない標準 offer を、R3（quoteId 付き・credential なし）は再提示しない。開示も返さない。
  const openOrderId = String(((await h.journal()).find((r) => r.event === "created")!.patch["source"] as { offer: { extra: { challengeNonce: string } } }).offer.extra.challengeNonce);
  const r3 = (await (await fetch(`${h.router.baseUrl}/v1/routes/${ROUTE_ID}/resource`, { headers: { ...principalHeaders(), "x-router-quote-id": openOrderId } })).json()) as Record<string, unknown>;
  expect(r3["accepts"]).toEqual([]);
  expect(r3).not.toHaveProperty("mayStillSettleUntil");
  // 未解決の枠（既定 3）が尽きた: 503、Retry-After、challenge なし。同時の GET でも注文は増えない。
  const blocked = await Promise.all([challengeOf(h), challengeOf(h), challengeOf(h)]);
  for (const { response, body } of blocked) {
    expect(response.status).toBe(503);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(response.headers.get("payment-required")).toBeNull();
    expect(body["error"]).toBe("source_offer_unavailable");
  }
  expect((await h.calls()).byRoute["create"]).toBe(3);
  expect((await h.journal()).filter((r) => r.event === "created")).toHaveLength(3);
  // 実物のクライアントも、署名せずに 503 を受け取る。
  const c = standardClient();
  expect((await c.fetchWithPayment(entryUrl(h), { headers: principalHeaders() })).status).toBe(503);
  expect(c.signed).toHaveLength(0);
});

test("AC-10: v1 のヘッダー・両方・重複・空・壊れた値・大きすぎる値は 400 で、402 でなく、注文も journal の行も増えない。GET 以外は 405", async () => {
  const h = await boot();
  const raw = (headers: http.OutgoingHttpHeaders, method = "GET") =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const request = http.request(entryUrl(h), { method, headers: { ...principalHeaders(), ...headers } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
      request.end();
    });
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  const bad: http.OutgoingHttpHeaders[] = [
    { "X-PAYMENT": b64({ x402Version: 1 }) },
    { "X-PAYMENT": b64({ x402Version: 1 }), "PAYMENT-SIGNATURE": b64({ x402Version: 2 }) },
    { "PAYMENT-SIGNATURE": [b64({ x402Version: 2 }), b64({ x402Version: 2 })] },
    { "PAYMENT-SIGNATURE": "" },
    { "PAYMENT-SIGNATURE": "not base64 !!" },
    { "PAYMENT-SIGNATURE": b64({ x402Version: 2, payload: { authorization: {}, signature: "0x00" } }) },
    { "PAYMENT-SIGNATURE": b64({ x402Version: 1, accepted: {}, payload: {} }) },
    { "PAYMENT-SIGNATURE": b64({ x402Version: 2, accepted: {}, payload: { authorization: { from: "0x1", to: "0x2", value: "1", validAfter: "0", validBefore: "1", nonce: "0x3" }, signature: "0x00" } }) },
    { "PAYMENT-SIGNATURE": "A".repeat(9000) },
  ];
  for (const headers of bad) {
    const response = await raw(headers);
    expect([JSON.stringify(Object.keys(headers)), response.status, response.body]).toEqual([JSON.stringify(Object.keys(headers)), 400, JSON.stringify({ error: "invalid_payment" })]);
    expect(response.headers["payment-required"]).toBeUndefined();
  }
  expect((await raw({}, "POST")).status).toBe(405);
  expect(await h.journal()).toEqual([]);
  expect((await h.calls()).byRoute["create"] ?? 0).toBe(0);
});

test("AC-6／AC-7（HTTP）: 別の認証済み principal と、quote 入口の注文の持ち込みは、知らない payTo と同じ固定の 404。verify・settle は増えない", async () => {
  const BOB = { id: "bob", token: "tok-bob-synthetic" };
  const h = await boot({ env: { ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token},${BOB.id}:${BOB.token}` } });
  const bobHeaders = { "x-router-principal": BOB.id, authorization: `Bearer ${BOB.token}` };
  const account = privateKeyToAccount(generatePrivateKey());
  // alice の標準 offer に、bob が正しい署名の credential を送る。
  const mine = await challengeOf(h);
  const good = await handSigned(account, mine.required!.accepts[0]!);
  const asBob = await fetch(entryUrl(h), { headers: { ...bobHeaders, "PAYMENT-SIGNATURE": good.header } });
  // quote 入口（POST /v1/quotes）で作った注文の payTo を、標準入口に持ち込む。
  const quoted = await fetch(`${h.router.baseUrl}/v1/quotes`, { method: "POST", headers: { ...principalHeaders(), "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_ID, requestId: "req-cross" }) });
  expect(quoted.status).toBe(200);
  const legacyOffer = ((await quoted.json()) as { source: { offer: Record<string, unknown> & { extra: Record<string, unknown> } } }).source.offer;
  const crossed = await handSigned(account, { ...legacyOffer, extra: { name: legacyOffer.extra["name"], version: legacyOffer.extra["version"] } });
  const asCrossed = await pay(h, crossed.header);
  const unknown = await pay(h, (await handSigned(account, { ...mine.required!.accepts[0]!, payTo: "0x00000000000000000000000000000000000000ff" })).header);
  const responses = [asBob, asCrossed, unknown];
  const texts = await Promise.all(responses.map((r) => r.text()));
  expect(responses.map((r) => r.status)).toEqual([404, 404, 404]);
  expect(new Set(texts)).toEqual(new Set([JSON.stringify({ error: "not_found" })]));
  for (const r of responses) {
    expect(r.headers.get("payment-required")).toBeNull();
    expect(r.headers.get("x-router-payment-id")).toBeNull();
  }
  const calls = await h.calls();
  expect([calls.byRoute["verify"] ?? 0, calls.byRoute["settle"] ?? 0]).toEqual([0, 0]);
  expect((await h.journal()).map((r) => r.event)).toEqual(["created", "created"]);
  // bob は自分の標準 offer を普通に取れ、alice の credential はそのまま買える（bob の試みで結び付いていない）。
  expect((await challengeOf(h, ROUTE_ID, bobHeaders)).response.status).toBe(402);
  expect((await pay(h, good.header)).status).toBe(200);
});

test("AC-4（HTTP）: 標準クライアントの署名が注文の期限に収まらない窓では 402 を出さない（503 order_window_short、challenge なし）。作った注文は枠に残り、黙って消えない", async () => {
  // 注文の TTL 50 秒: maxTimeoutSeconds 25 + 余裕 30 > 50。
  const h = await boot({ facilitatorArgs: ["--ttl-seconds", "50"] });
  for (let index = 0; index < 3; index += 1) {
    const { response, body } = await challengeOf(h);
    expect([response.status, body["error"], body["reason"]]).toEqual([503, "source_offer_unavailable", "order_window_short"]);
    expect(response.headers.get("payment-required")).toBeNull();
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  }
  // 3 つの注文は facilitator と ledger に残り（requested → created）、未解決の枠を使っている: 4 回目は枠で止まり、注文は増えない。
  expect((await h.calls()).byRoute["create"]).toBe(3);
  expect((await h.ledger()).map((r) => r.event)).toEqual(["requested", "created", "requested", "created", "requested", "created"]);
  const fourth = await challengeOf(h);
  expect([fourth.response.status, fourth.body["reason"]]).toEqual([503, "limit_unresolved"]);
  expect((await h.calls()).byRoute["create"]).toBe(3);
  expect(await h.journal()).toEqual([]);
  // 実物のクライアントは署名しない。
  const c = standardClient();
  expect((await c.fetchWithPayment(entryUrl(h), { headers: principalHeaders() })).status).toBe(503);
  expect(c.signed).toHaveLength(0);
});
