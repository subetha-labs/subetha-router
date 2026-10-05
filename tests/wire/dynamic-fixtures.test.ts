/**
 * 動的上流 URL の試験基盤そのものの試験（タスク T6）。fixture が「正しいものを通し、誤ったものを落とす」ことを
 * 先に確かめておく（fixture が何でも通すと、後の試験が何も証明しない）。実 TCP / TLS（loopback）。
 */
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { Challenge, Constants, Credential, Receipt } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { createClient, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/tempo/chains";
import { afterEach, beforeAll, expect, test } from "vitest";

import { createMppOutbound } from "../../src/adapters/outbound/mpp.js";
import { createSyntheticX402Outbound, createX402Outbound } from "../../src/adapters/outbound/x402.js";
import { createGuardedTransport, type GuardedTransport } from "../../src/net/guarded-fetch.js";
import { DynamicTargetUnsupportedError } from "../../src/ports/outbound.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { MPP_FIXTURE_CHAIN_ID, MPP_FIXTURE_CURRENCY, MPP_FIXTURE_RECIPIENT, startMppUpstream } from "../fixtures/dynamic/mpp-upstream.js";
import { startTempoRpc } from "../fixtures/dynamic/tempo-rpc.js";
import { startVerifyingFacilitator } from "../fixtures/dynamic/verifying-facilitator.js";
import { FIXTURE_ASSET, FIXTURE_NETWORK, FIXTURE_PAY_TO, paidOk, standardAccept, startX402Upstream } from "../fixtures/dynamic/x402-upstream.js";
import { createPayerSpy } from "../fixtures/mpp-payer-spy.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";
import { createSignerSpy } from "../fixtures/x402-signer-spy.js";

const CTX = { operation: "test", routeId: "dyn-test" };
let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

/** 本番と同じ宛先の判定（loopback を許さない）＋ fixture への差し替え。 */
function transportTo(routes: Record<string, number>): GuardedTransport {
  return createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: dialTo(routes) });
}

/* ------------------------------------------------------------------ x402 の上流 */

test("x402 の上流: 任意のパスとクエリに 402 を返し、resource.url は要求された URL そのもの", async () => {
  const upstream = await startX402Upstream(TLS);
  closers.push(upstream.close);
  const transport = transportTo({ "provider.test": upstream.port });
  const url = "https://provider.test/v1/price?symbol=ETH&b=2&a=1";
  const response = await transport.fetch(url, { method: "GET" }, CTX);
  expect(response.status).toBe(402);
  const required = decodePaymentRequiredHeader(response.headers.get("payment-required")!);
  await response.text();
  expect(required.x402Version).toBe(2);
  expect(required.resource.url).toBe(url);
  expect(required.accepts).toEqual([standardAccept()]);
  expect(upstream.seen).toMatchObject({ challenges: 1, payments: [], urls: [url] });
});

test("x402 の上流: 支払いつきの要求を記録し、試験が決めた応答と receipt を返す", async () => {
  const upstream = await startX402Upstream(TLS);
  closers.push(upstream.close);
  const payer = "0x00000000000000000000000000000000000000aa";
  upstream.state.pay = () => paidOk(payer, { price: 1 });
  const transport = transportTo({ "provider.test": upstream.port });
  const payment = { x402Version: 2, accepted: standardAccept(), payload: { signature: "0x00" } };
  const response = await transport.fetch("https://provider.test/v1/price", { method: "GET", headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment as never) } }, CTX);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ price: 1 });
  expect(response.headers.get("payment-response")).not.toBeNull();
  expect(upstream.seen.payments).toHaveLength(1);
  expect((upstream.seen.payments[0] as { accepted: unknown }).accepted).toEqual(standardAccept());
});

test("x402 の上流には、差し替えがあっても loopback の名前では届かない（宛先の判定は本番と同じ）", async () => {
  const upstream = await startX402Upstream(TLS);
  closers.push(upstream.close);
  const internal = createGuardedTransport({
    allowLoopback: false,
    report: () => {},
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: publicLookup({ "provider.test": ["127.0.0.1"] }),
    dialForTest: dialTo({ "provider.test": upstream.port }),
  });
  await expect(internal.fetch("https://provider.test/", { method: "GET" }, CTX)).rejects.toMatchObject({ code: "destination_blocked" });
  expect(upstream.seen.connections).toBe(0);
});

/* ------------------------------------------------------------------ 署名を検証する facilitator */

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

async function signedPayment(overrides: { nonce?: Hex; to?: string; value?: string; validBefore?: number } = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const authorization = {
    from: account.address,
    to: overrides.to ?? FIXTURE_PAY_TO,
    value: overrides.value ?? "1000",
    validAfter: "0",
    validBefore: String(overrides.validBefore ?? Math.floor(Date.now() / 1000) + 600),
    nonce: overrides.nonce ?? (`0x${"5a".repeat(32)}` as Hex),
  };
  const signature = await account.signTypedData({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: FIXTURE_ASSET },
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, from: account.address, to: authorization.to as Hex, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
  });
  const requirements = { scheme: "exact", network: FIXTURE_NETWORK, asset: FIXTURE_ASSET, amount: "1000", payTo: FIXTURE_PAY_TO, maxTimeoutSeconds: 600, extra: { name: "USDC", version: "2" } };
  return { account, authorization, signature, requirements };
}

async function post(baseUrl: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await response.json()) as Record<string, unknown>;
}

function envelope(signed: Awaited<ReturnType<typeof signedPayment>>, patch: { authorization?: Record<string, unknown>; signature?: string; requirements?: Record<string, unknown> } = {}) {
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, scheme: "exact", network: FIXTURE_NETWORK, payload: { signature: patch.signature ?? signed.signature, authorization: { ...signed.authorization, ...(patch.authorization ?? {}) } } },
    paymentRequirements: { ...signed.requirements, ...(patch.requirements ?? {}) },
  };
}

test("facilitator: 正しい署名は verify・settle を通る。同じ署名の 2 度目の settle は nonce で落ちる", async () => {
  const facilitator = await startVerifyingFacilitator();
  closers.push(facilitator.close);
  const signed = await signedPayment();
  expect(await post(facilitator.baseUrl, "/verify", envelope(signed))).toMatchObject({ isValid: true, payer: signed.account.address });
  const settled = await post(facilitator.baseUrl, "/settle", envelope(signed));
  expect(settled).toMatchObject({ success: true, network: FIXTURE_NETWORK, payer: signed.account.address });
  expect(settled["transaction"]).toMatch(/^0x[0-9a-f]{64}$/);
  expect(await post(facilitator.baseUrl, "/settle", envelope(signed))).toMatchObject({ success: false, errorReason: "nonce_used" });
  expect(await post(facilitator.baseUrl, "/verify", envelope(signed))).toMatchObject({ isValid: false });
});

test("facilitator: 署名した内容と 1 つでも違えば落ちる（nonce・受取先・額・署名・domain）", async () => {
  const facilitator = await startVerifyingFacilitator();
  closers.push(facilitator.close);
  const signed = await signedPayment();
  const other = await signedPayment({ nonce: `0x${"6b".repeat(32)}` as Hex });
  const cases: Array<[string, unknown, string]> = [
    // 別の quote 用に nonce 欄だけ書き換える（署名はそのまま）。
    ["nonce を書き換え", envelope(signed, { authorization: { nonce: `0x${"6b".repeat(32)}` } }), "invalid_signature"],
    ["額を書き換え", envelope(signed, { authorization: { value: "1" } }), "invalid_signature"],
    ["受取先を書き換え", envelope(signed, { authorization: { to: "0x000000000000000000000000000000000000dEaD" } }), "invalid_signature"],
    ["別の署名", envelope(signed, { signature: other.signature }), "invalid_signature"],
    ["別の domain（version）", envelope(signed, { requirements: { extra: { name: "USDC", version: "3" } } }), "invalid_signature"],
    // 署名は正しいが、requirements と合わない。
    ["requirements の額が違う", envelope(signed, { requirements: { amount: "2000" } }), "amount"],
    ["requirements の受取先が違う", envelope(signed, { requirements: { payTo: "0x000000000000000000000000000000000000dEaD" } }), "recipient"],
  ];
  for (const [name, body, reason] of cases) {
    expect(await post(facilitator.baseUrl, "/verify", body), name).toMatchObject({ isValid: false, invalidReason: reason });
    expect(await post(facilitator.baseUrl, "/settle", body), name).toMatchObject({ success: false });
  }
  // 落としたものは nonce を消費していない。元の署名はまだ通る。
  expect(await post(facilitator.baseUrl, "/settle", envelope(signed))).toMatchObject({ success: true });
});

test("facilitator: 期限の切れた authorization は落ちる", async () => {
  let now = Date.now();
  const facilitator = await startVerifyingFacilitator({ now: () => now });
  closers.push(facilitator.close);
  const signed = await signedPayment({ validBefore: Math.floor(now / 1000) + 60 });
  expect(await post(facilitator.baseUrl, "/verify", envelope(signed))).toMatchObject({ isValid: true });
  now += 61_000;
  expect(await post(facilitator.baseUrl, "/verify", envelope(signed))).toMatchObject({ isValid: false, invalidReason: "validity" });
});

test("facilitator: TLS で立てれば、本番と同じ宛先の判定の transport から届く", async () => {
  const facilitator = await startVerifyingFacilitator({ tls: TLS });
  closers.push(facilitator.close);
  expect(facilitator.baseUrl).toBe("https://other.test");
  const transport = transportTo({ "other.test": facilitator.port });
  const signed = await signedPayment();
  const response = await transport.fetch(`${facilitator.baseUrl}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope(signed)) }, CTX);
  expect(await response.json()).toMatchObject({ isValid: true });
});

/* ------------------------------------------------------------------ Tempo の RPC と MPP の上流 */

async function mppHarness() {
  const rpc = await startTempoRpc();
  closers.push(rpc.close);
  const upstream = await startMppUpstream(TLS, rpc.url);
  closers.push(upstream.close);
  const account = privateKeyToAccount(generatePrivateKey());
  rpc.sender = account.address;
  const client = createClient({ account, chain: { ...tempoModerato, feeToken: MPP_FIXTURE_CURRENCY } as never, transport: http(rpc.url, { retryCount: 0 }) });
  const mppx = Mppx.create({
    methods: [tempo.charge({ account, mode: "push", getClient: () => client, autoSwap: false, allowedChainIds: [MPP_FIXTURE_CHAIN_ID], expectedRecipients: [MPP_FIXTURE_RECIPIENT] } as never)],
  });
  const transport = transportTo({ "provider.test": upstream.port });
  const challengeOf = async (url: string): Promise<string> => {
    const response = await transport.fetch(url, { method: "GET" }, CTX);
    await response.text();
    expect(response.status).toBe(402);
    return response.headers.get("www-authenticate")!;
  };
  const credentialFor = (header: string): Promise<string> => mppx.createCredential(new Response(null, { status: 402, headers: { "www-authenticate": header } }));
  const submit = (url: string, wire: string) => transport.fetch(url, { method: "GET", headers: { authorization: wire } }, CTX);
  return { rpc, upstream, account, challengeOf, credentialFor, submit };
}

test("MPP: 実 SDK の client が RPC の fixture に送金し、上流（実 SDK の server）がその receipt を検証して通す", async () => {
  const { rpc, upstream, account, challengeOf, credentialFor, submit } = await mppHarness();
  const url = "https://provider.test/v1/report?id=7";
  const header = await challengeOf(url);
  const challenge = Challenge.deserialize(header) as unknown as { request: { amount: string; methodDetails: { chainId: number } }; opaque?: unknown };
  expect(challenge.request.amount).toBe("1000");
  expect(challenge.request.methodDetails.chainId).toBe(MPP_FIXTURE_CHAIN_ID);
  // 既定では scope を付けない（第三者の Provider の形）。
  expect(challenge.opaque).toBeUndefined();

  const wire = await credentialFor(header);
  expect(rpc.sentRaw).toHaveLength(1);
  expect(rpc.sentRaw[0]!.slice(0, 4)).toBe("0x76");
  const response = await submit(url, wire);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  const receipt = Receipt.deserialize(response.headers.get(Constants.Headers.paymentReceipt)!);
  const hash = (Credential.deserialize(wire).payload as { hash: string }).hash;
  expect(receipt).toMatchObject({ status: "success", method: "tempo", reference: hash });
  expect(upstream.seen).toMatchObject({ challenges: 1, credentials: 1, verified: 1, rejected: 0 });
  expect(rpc.methods).toContain("eth_getTransactionReceipt");
  void account;
});

test("MPP: 同じ支払いの 2 度目、別の challenge に付け替えた支払い、送金の無い hash は、上流が落とす", async () => {
  const { rpc, upstream, challengeOf, credentialFor, submit } = await mppHarness();
  const url = "https://provider.test/v1/report";
  const headerA = await challengeOf(url);
  const wireA = await credentialFor(headerA);
  expect((await submit(url, wireA)).status).toBe(200);

  // 1. 同じ credential をもう一度（hash の使い回し）。
  const again = await submit(url, wireA);
  await again.text();
  expect(again.status).toBe(402);

  // 2. A の送金を、B の challenge の credential として出す（memo が B に束縛されていない）。
  const headerB = await challengeOf(url);
  const payloadA = Credential.deserialize(wireA) as { payload: unknown; source?: unknown };
  const forged = Credential.serialize({ challenge: Challenge.deserialize(headerB), payload: payloadA.payload, ...(payloadA.source === undefined ? {} : { source: payloadA.source }) } as never);
  const swapped = await submit(url, forged);
  await swapped.text();
  expect(swapped.status).toBe(402);

  // 3. 送金していない hash。
  const headerC = await challengeOf(url);
  const phantom = Credential.serialize({ challenge: Challenge.deserialize(headerC), payload: { type: "hash", hash: `0x${"cd".repeat(32)}` }, ...(payloadA.source === undefined ? {} : { source: payloadA.source }) } as never);
  const missing = await submit(url, phantom);
  await missing.text();
  expect(missing.status).toBe(402);

  expect(upstream.seen).toMatchObject({ verified: 1, rejected: 3 });
  // 送金は最初の 1 回だけ。
  expect(rpc.sentRaw).toHaveLength(1);
});

test("MPP: 額の違う送金・失敗した送金の receipt は、上流が落とす（RPC の fixture に直接登録して確かめる）", async () => {
  const { rpc, upstream, account, challengeOf, credentialFor, submit } = await mppHarness();
  const url = "https://provider.test/v1/report";
  // 正の対照として 1 件通し、その memo の作り方を借りる（memo は challenge ごとに違うので、下では使い回せない）。
  const header = await challengeOf(url);
  const wire = await credentialFor(header);
  expect((await submit(url, wire)).status).toBe(200);

  const source = (Credential.deserialize(wire) as { source?: unknown }).source;
  const credentialWith = (challengeHeader: string, hash: string): string =>
    Credential.serialize({ challenge: Challenge.deserialize(challengeHeader), payload: { type: "hash", hash }, ...(source === undefined ? {} : { source }) } as never);

  // 額が 1 少ない送金（memo なし）。
  const underpaidHash = `0x${"a1".repeat(32)}` as Hex;
  rpc.register(underpaidHash, [{ token: MPP_FIXTURE_CURRENCY, from: account.address, to: MPP_FIXTURE_RECIPIENT, amount: 999n }]);
  const underpaid = await submit(url, credentialWith(await challengeOf(url), underpaidHash));
  await underpaid.text();
  expect(underpaid.status).toBe(402);

  // 額と宛先は合っているが memo が無い送金（この challenge に束縛されていない）。
  const unboundHash = `0x${"a2".repeat(32)}` as Hex;
  rpc.register(unboundHash, [{ token: MPP_FIXTURE_CURRENCY, from: account.address, to: MPP_FIXTURE_RECIPIENT, amount: 1000n }]);
  const unbound = await submit(url, credentialWith(await challengeOf(url), unboundHash));
  await unbound.text();
  expect(unbound.status).toBe(402);

  // 失敗した transaction。
  const revertedHash = `0x${"a3".repeat(32)}` as Hex;
  rpc.register(revertedHash, [{ token: MPP_FIXTURE_CURRENCY, from: account.address, to: MPP_FIXTURE_RECIPIENT, amount: 1000n }], { status: "0x0" });
  const reverted = await submit(url, credentialWith(await challengeOf(url), revertedHash));
  await reverted.text();
  expect(reverted.status).toBe(402);

  expect(upstream.seen.verified).toBe(1);
});

test("RPC の fixture: 知らない hash には null を返す。登録した receipt は、その送金のログだけを持つ", async () => {
  const rpc = await startTempoRpc();
  closers.push(rpc.close);
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    const response = await fetch(rpc.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return ((await response.json()) as { result?: unknown; error?: unknown }).result;
  };
  const known = `0x${"b1".repeat(32)}` as Hex;
  const unknown = `0x${"b2".repeat(32)}`;
  rpc.register(known, [{ token: MPP_FIXTURE_CURRENCY, from: MPP_FIXTURE_RECIPIENT, to: MPP_FIXTURE_RECIPIENT, amount: 5n, memo: `0x${"00".repeat(32)}` as Hex }]);
  // 別の支払いの receipt を、知らない hash の答えとして返さない。
  expect(await call("eth_getTransactionReceipt", [unknown])).toBeNull();
  const receipt = (await call("eth_getTransactionReceipt", [known])) as { transactionHash: string; status: string; logs: { transactionHash: string }[] };
  expect(receipt.transactionHash).toBe(known);
  expect(receipt.status).toBe("0x1");
  // Transfer と TransferWithMemo の 2 つ。
  expect(receipt.logs).toHaveLength(2);
  expect(receipt.logs.every((log) => log.transactionHash === known)).toBe(true);
  expect(rpc.methods).toEqual(["eth_getTransactionReceipt", "eth_getTransactionReceipt"]);
  // 持っていない method は「無い」と答える（黙って成功しない）。
  const response = await fetch(rpc.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_fillTransaction", params: [] }) });
  expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32601);
});

test("MPP の上流: scope を付ける設定では、要求された URL（クエリを含む）が scope になる", async () => {
  const { upstream, challengeOf } = await mppHarness();
  upstream.state.scope = "match";
  const url = "https://provider.test/v1/report?id=7";
  const challenge = Challenge.deserialize(await challengeOf(url)) as unknown as { opaque?: unknown };
  // `opaque` は meta の base64url（SDK の形式）。
  const meta = JSON.parse(Buffer.from(String(challenge.opaque), "base64url").toString("utf8")) as Record<string, unknown>;
  expect(meta["_mppx_scope"]).toBe("GET https://provider.test/v1/report?id=7");
});

/* ------------------------------------------------------------------ port */

test("動的経路を持たない adapter は、上流の URL（target）を受け取ると例外にする。受け取らなければ従来どおり", async () => {
  const transport = createGuardedTransport({ allowLoopback: true, report: () => {} });
  const target = { url: "https://provider.test/v1/price" };
  const offer = { scheme: "exact", network: FIXTURE_NETWORK, asset: FIXTURE_ASSET, amount: "1", payTo: FIXTURE_PAY_TO };
  const rails = [
    createX402Outbound({ transport, upstreams: { r: "http://127.0.0.1:1/x" }, capability: createSignerSpy().capability(FIXTURE_NETWORK) }),
    createSyntheticX402Outbound({ transport, upstreams: { r: "http://127.0.0.1:1/x" } }),
    createMppOutbound({ transport, upstreams: { r: "http://127.0.0.1:1/x" }, capability: createPayerSpy().capability() }),
  ];
  for (const rail of rails) {
    await expect(rail.readChallenge("r", target)).rejects.toBeInstanceOf(DynamicTargetUnsupportedError);
    await expect(rail.pay({ routeId: "r", offer, paymentId: "p", attempt: 1, target })).rejects.toBeInstanceOf(DynamicTargetUnsupportedError);
  }
});
