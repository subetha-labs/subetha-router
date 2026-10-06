/**
 * 受信の支払いを quote に束縛する（設計 `docs/dynamic-upstream-design.md` §4、タスク T7。AC-5 の adapter 部分）。
 *
 * **検証は実物の経路を通す**: x402 は EIP-3009 の署名と nonce を検証する facilitator の fixture、
 * MPP は実 `mppx`（Router の受信 adapter の中）と、実形の receipt を返す RPC の fixture。
 * 支払う側も、呼び出し側が実際に使うツール（`tools/x402-payer.ts`・`tools/mpp-payer.ts`）で作る。鍵は毎回の乱数。
 *
 * 「1 回の受信支払いで送信は高々 1 回」（静的↔動的・並行・journal の再オープン）は T14 で確かめる。
 */
import { Challenge, Credential } from "mppx";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, expect, test } from "vitest";

import { createMppInbound } from "../../src/adapters/inbound/mpp.js";
import { createX402Inbound } from "../../src/adapters/inbound/x402.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { InboundOffer, InboundRail, PaymentCredential } from "../../src/ports/inbound.js";
import { createMppPayer } from "../../tools/mpp-payer.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { startTempoRpc, type TempoRpc } from "../fixtures/dynamic/tempo-rpc.js";
import { startVerifyingFacilitator, type VerifyingFacilitator } from "../fixtures/dynamic/verifying-facilitator.js";

const LOOPBACK = createGuardedTransport({ allowLoopback: true, report: () => {} });
const PAY_TO = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_SEPOLIA = "eip155:84532";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const TEMPO_TESTNET = 42_431;
const ROUTE_ID = "dyn-profile";
const BINDING = [ROUTE_ID, "GET", `/v1/routes/${ROUTE_ID}/resource`].map(encodeURIComponent).join("|");

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  // 1 つが失敗しても残りを片付ける。
  const failures: unknown[] = [];
  while (closers.length > 0) {
    try {
      await closers.pop()!();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
});

/* ------------------------------------------------------------------ x402 */

async function x402Harness(bind: boolean): Promise<{ rail: InboundRail; facilitator: VerifyingFacilitator }> {
  const facilitator = await startVerifyingFacilitator();
  closers.push(facilitator.close);
  const rail = createX402Inbound({ transport: LOOPBACK, facilitatorUrl: facilitator.baseUrl, payTo: PAY_TO, maxTimeoutSeconds: 600, ...(bind ? { bindAuthorizationNonce: true } : {}) });
  return { rail, facilitator };
}

function issueX402(rail: InboundRail, amount = "10000"): Promise<InboundOffer> {
  return rail.createOffer({ routeId: ROUTE_ID, amount, asset: USDC, network: BASE_SEPOLIA, routeBinding: BINDING, nowMs: Date.now() });
}

/** 呼び出し側のツールが作る credential（base64）を、Router が受け取る形に戻す。 */
async function signX402(offer: InboundOffer): Promise<PaymentCredential> {
  const payer = createX402Payer(generatePrivateKey());
  const encoded = await payer.credentialFor(offer as never, 84532);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as PaymentCredential;
}

/** quote `into` の封筒（`challengeNonce`・`accepted`）に、別の credential の署名と authorization を入れる。 */
function rewrap(into: InboundOffer, from: PaymentCredential, authorizationPatch: Record<string, unknown> = {}): PaymentCredential {
  return {
    x402Version: 2,
    accepted: into,
    payload: {
      challengeNonce: into.extra.challengeNonce,
      signature: from.payload["signature"],
      authorization: { ...(from.payload["authorization"] as Record<string, unknown>), ...authorizationPatch },
    },
  } as PaymentCredential;
}

test("x402: その quote のために作った署名は、preflight・verify・settle を通る（正の対照）", async () => {
  const { rail, facilitator } = await x402Harness(true);
  const offer = await issueX402(rail);
  const credential = await signX402(offer);
  expect(rail.preflight(offer, credential, Date.now())).toEqual({ ok: true });
  expect(await rail.verify(offer, credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
  expect(await rail.settle(offer, credential, { routeId: ROUTE_ID })).toMatchObject({ outcome: "settled" });
  expect(facilitator.calls).toMatchObject({ verify: 1, settle: 1, reasons: [] });
});

test.each([["同額", "10000", "10000"], ["異額", "10000", "20000"]])(
  "x402: 別の quote の署名をそのまま持ち込むと preflight で落ちる（%s の quote 間）",
  async (_name, amountA, amountB) => {
    const { rail, facilitator } = await x402Harness(true);
    const a = await issueX402(rail, amountA);
    const b = await issueX402(rail, amountB);
    const credentialA = await signX402(a);
    // 封筒（未署名の欄）だけを B のものに差し替える。署名と authorization は A のまま。
    const wrapped = rewrap(b, credentialA);
    expect(wrapped.payload.challengeNonce).toBe(b.extra.challengeNonce);
    expect(rail.preflight(b, wrapped, Date.now())).toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(facilitator.calls.verify).toBe(0);
    // A の credential は A にはそのまま使える。
    expect(rail.preflight(a, credentialA, Date.now())).toEqual({ ok: true });
  },
);

test("x402: 別の quote の署名の nonce 欄だけを書き換えると、preflight は通るが verify で落ち、settle もされない", async () => {
  const { rail, facilitator } = await x402Harness(true);
  const a = await issueX402(rail);
  const b = await issueX402(rail);
  const credentialA = await signX402(a);
  const forged = rewrap(b, credentialA, { nonce: b.extra.challengeNonce });
  // 未署名の欄はすべて B と一致している。束縛を成立させるのは署名の検証。
  expect(rail.preflight(b, forged, Date.now())).toEqual({ ok: true });
  expect(await rail.verify(b, forged, { routeId: ROUTE_ID })).toEqual({ isValid: false });
  expect(await rail.settle(b, forged, { routeId: ROUTE_ID })).toMatchObject({ outcome: "rejected" });
  expect(facilitator.calls.reasons).toEqual(["invalid_signature", "invalid_signature"]);
  expect(facilitator.used.size).toBe(0);
});

test("x402: 別の quote（別の額）の署名の nonce と額を両方書き換えても、verify で落ちる", async () => {
  const { rail, facilitator } = await x402Harness(true);
  const a = await issueX402(rail, "10000");
  const b = await issueX402(rail, "20000");
  const forged = rewrap(b, await signX402(a), { nonce: b.extra.challengeNonce, value: "20000" });
  expect(rail.preflight(b, forged, Date.now())).toEqual({ ok: true });
  expect(await rail.verify(b, forged, { routeId: ROUTE_ID })).toEqual({ isValid: false });
  expect(facilitator.calls.reasons).toEqual(["invalid_signature"]);
  // nonce の大文字小文字を変えただけの本物の署名は、verify まで通る（同じ値として署名されている）。
  const real = await signX402(b);
  const upper = rewrap(b, real, { nonce: `0x${b.extra.challengeNonce.slice(2).toUpperCase()}` });
  expect(rail.preflight(b, upper, Date.now())).toEqual({ ok: true });
  expect(await rail.verify(b, upper, { routeId: ROUTE_ID })).toEqual({ isValid: true });
});

test("x402: 署名した額・受取先・期限が quote と違う authorization は preflight で落ちる", async () => {
  const { rail } = await x402Harness(true);
  const offer = await issueX402(rail);
  const credential = await signX402(offer);
  const cases: Array<[string, Record<string, unknown>]> = [
    ["額が少ない", { value: "9999" }],
    ["額が多い", { value: "10001" }],
    ["受取先が違う", { to: "0x000000000000000000000000000000000000dEaD" }],
    ["期限が quote より後", { validBefore: String(offer.extra.expiresAt + 1) }],
    ["期限が数値でない", { validBefore: "soon" }],
    ["額に先頭ゼロ", { value: "010000" }],
    ["額が数値型", { value: 10000 }],
    ["nonce が文字列でない", { nonce: 1 }],
    ["受取先が文字列でない", { to: null }],
    ["期限が数値型", { validBefore: offer.extra.expiresAt }],
  ];
  for (const [name, patch] of cases) {
    const result = rail.preflight(offer, rewrap(offer, credential, patch), Date.now());
    expect(result.ok, name).toBe(false);
    expect(result, name).toEqual({ ok: false, reason: "nonce" in patch ? "nonce_mismatch" : "credential_mismatch" });
  }
  // authorization が無い credential。
  const bare = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, signature: "0x00" } } as PaymentCredential;
  expect(rail.preflight(offer, bare, Date.now())).toEqual({ ok: false, reason: "credential_mismatch" });
  // nonce の大文字小文字の違いは同じ値として扱う。
  const upper = rewrap(offer, credential, { nonce: `0x${offer.extra.challengeNonce.slice(2).toUpperCase()}` });
  expect(rail.preflight(offer, upper, Date.now())).toEqual({ ok: true });
});

test("x402: 一度決済した署名は、同じ quote にもう一度出しても facilitator が nonce で落とす", async () => {
  const { rail } = await x402Harness(true);
  const offer = await issueX402(rail);
  const credential = await signX402(offer);
  expect(await rail.settle(offer, credential, { routeId: ROUTE_ID })).toMatchObject({ outcome: "settled" });
  expect(await rail.verify(offer, credential, { routeId: ROUTE_ID })).toEqual({ isValid: false });
  expect(await rail.settle(offer, credential, { routeId: ROUTE_ID })).toMatchObject({ outcome: "rejected" });
});

test("x402: 束縛を有効にしない adapter（静的 route）は、従来どおり乱数の nonce の署名を受け付ける", async () => {
  const { rail, facilitator } = await x402Harness(false);
  const a = await issueX402(rail);
  const b = await issueX402(rail);
  // A のための署名（nonce は A の challengeNonce）を B の封筒で出す。静的の preflight は authorization を見ない。
  const wrapped = rewrap(b, await signX402(a));
  expect(rail.preflight(b, wrapped, Date.now())).toEqual({ ok: true });
  // 署名は有効で、額と受取先も合っているので、facilitator も通す（静的 route の従来の性質）。
  expect(await rail.verify(b, wrapped, { routeId: ROUTE_ID })).toEqual({ isValid: true });
  expect(facilitator.calls.verify).toBe(1);
});

/* ------------------------------------------------------------------ MPP */

async function mppHarness(): Promise<{ rail: InboundRail; rpc: TempoRpc; pay: (offer: InboundOffer) => Promise<{ wire: string; credential: PaymentCredential }> }> {
  const rpc = await startTempoRpc();
  closers.push(rpc.close);
  const rail = createMppInbound({ transport: LOOPBACK, rpcUrl: rpc.url, secretKey: "0123456789abcdef0123456789abcdef0123456789abcdef", recipient: PAY_TO, currency: PATHUSD, chainId: TEMPO_TESTNET, maxTimeoutSeconds: 600, realm: "router-test" });
  const payer = createMppPayer(generatePrivateKey(), { chainId: TEMPO_TESTNET, asset: PATHUSD, payTo: PAY_TO, maxAmount: 1_000_000n }, { rpcUrl: rpc.url });
  const pay = async (offer: InboundOffer): Promise<{ wire: string; credential: PaymentCredential }> => {
    const paid = await payer.payAndCredential(offer as never);
    return { wire: paid.credential, credential: envelopeFor(offer, paid.credential) };
  };
  return { rail, rpc, pay };
}

function issueMpp(rail: InboundRail, amount = "10000"): Promise<InboundOffer> {
  return rail.createOffer({ routeId: ROUTE_ID, amount, asset: PATHUSD, network: `eip155:${TEMPO_TESTNET}`, routeBinding: BINDING, nowMs: Date.now() });
}

function envelopeFor(offer: InboundOffer, wire: string): PaymentCredential {
  return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, credential: wire } } as PaymentCredential;
}

test("MPP: その quote のために送金した credential は、preflight・verify・settle を通る（実 SDK と receipt。正の対照）", async () => {
  const { rail, rpc, pay } = await mppHarness();
  const offer = await issueMpp(rail);
  const { credential } = await pay(offer);
  expect(rpc.sentRaw).toHaveLength(1);
  expect(rail.preflight(offer, credential, Date.now())).toEqual({ ok: true });
  expect(await rail.verify(offer, credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
  const settled = await rail.settle(offer, credential, { routeId: ROUTE_ID });
  expect(settled).toMatchObject({ outcome: "settled" });
  expect((settled as { txRef: string }).txRef).toMatch(/^0x[0-9a-f]{64}$/);
});

test.each([["同額", "10000", "10000"], ["異額", "10000", "20000"]])(
  "MPP: A の送金を B の封筒に入れても、B の challenge に付け替えても、B の id に書き換えても通らない（%s の quote 間）",
  async (_name, amountA, amountB) => {
    const { rail, rpc, pay } = await mppHarness();
    const a = await issueMpp(rail, amountA);
    const b = await issueMpp(rail, amountB);
    const paidA = await pay(a);
    const parsedA = Credential.deserialize(paidA.wire) as { challenge: Record<string, unknown>; payload: unknown; source?: unknown };
    const challengeB = Challenge.deserialize(b.extra["challenge"] as string);

    // 1. A の wire を、そのまま B の封筒に入れる（中の challenge は A のまま）。
    const wrapped = envelopeFor(b, paidA.wire);
    expect(rail.preflight(b, wrapped, Date.now())).toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(await rail.verify(b, wrapped, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    expect(await rail.settle(b, wrapped, { routeId: ROUTE_ID })).toMatchObject({ outcome: "rejected" });

    // 2. B の challenge（本物）に、A の送金の hash を付ける。中の id は B なので preflight は通る。
    const swappedWire = Credential.serialize({ challenge: challengeB, payload: parsedA.payload, ...(parsedA.source === undefined ? {} : { source: parsedA.source }) } as never);
    const swapped = envelopeFor(b, swappedWire);
    expect(rail.preflight(b, swapped, Date.now())).toEqual({ ok: true });
    // 送金の memo は A の challenge に束縛されている（異額なら額も合わない）。実 SDK が落とす。
    expect(await rail.verify(b, swapped, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    expect((await rail.settle(b, swapped, { routeId: ROUTE_ID })).outcome).not.toBe("settled");

    // 3. A の challenge の欄のまま、id だけを B のものに書き換える。preflight は通るが、id は欄の HMAC なので SDK が落とす。
    const relabelledWire = Credential.serialize({ challenge: { ...parsedA.challenge, id: (challengeB as unknown as { id: string }).id }, payload: parsedA.payload, ...(parsedA.source === undefined ? {} : { source: parsedA.source }) } as never);
    const relabelled = envelopeFor(b, relabelledWire);
    expect(rail.preflight(b, relabelled, Date.now())).toEqual({ ok: true });
    expect(await rail.verify(b, relabelled, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    expect((await rail.settle(b, relabelled, { routeId: ROUTE_ID })).outcome).not.toBe("settled");

    // A の送金は、どの試みにも消費されていない。本来の quote にはまだ使える。
    expect(await rail.verify(a, paidA.credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
    expect(await rail.settle(a, paidA.credential, { routeId: ROUTE_ID })).toMatchObject({ outcome: "settled" });
    // 送金は 1 回だけ。
    expect(rpc.sentRaw).toHaveLength(1);
  },
);

test("支払い用ツールは、知らない chain では支払わない（別の chain の定義を流用しない）", () => {
  expect(() => createMppPayer(generatePrivateKey(), { chainId: 31337, asset: PATHUSD, payTo: PAY_TO, maxAmount: 1n })).toThrow("unsupported Tempo chain id");
  // 知っている chain は作れる（mainnet の scope は mainnet の定義と RPC になる。ここでは作るだけ）。
  expect(createMppPayer(generatePrivateKey(), { chainId: 4217, asset: PATHUSD, payTo: PAY_TO, maxAmount: 1n }).address).toMatch(/^0x/);
});

test("MPP: 一度受領した送金は、同じ quote にもう一度出しても受領されない", async () => {
  const { rail, pay } = await mppHarness();
  const offer = await issueMpp(rail);
  const { credential } = await pay(offer);
  expect(await rail.settle(offer, credential, { routeId: ROUTE_ID })).toMatchObject({ outcome: "settled" });
  // 成否を断定できない失敗は `unknown`（`rejected` と言わない）。どちらにせよ受領はされない。
  expect((await rail.settle(offer, credential, { routeId: ROUTE_ID })).outcome).not.toBe("settled");
});
