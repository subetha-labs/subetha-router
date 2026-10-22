/**
 * 秘匿購入の x402 送信 adapter（設計 §6.1、要件 FR-Z05・TR-1）: 探りは未払いの GET／`{}` の POST だけ、発行は署名 1 回で **fetch 0 回**、領収の照合。
 * transport は spy（実 TCP なし）。鍵は毎回の乱数（実署名）。資金は動かない。
 */
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { getAddress, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, test } from "vitest";

import { createPrivateX402Rail } from "../../src/adapters/outbound/private-x402.js";
import type { DynamicProfile } from "../../src/config.js";
import type { GuardedTransport, TransportContext } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer } from "../../src/ports/outbound.js";
import { createRealEvmCapability } from "../../tools/real-evm-capability.js";
import { FIXTURE_ASSET, FIXTURE_NETWORK, FIXTURE_PAY_TO, standardAccept } from "../fixtures/dynamic/x402-upstream.js";

const PROFILE_ID = "priv-x402";
const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "x402",
  source: { network: FIXTURE_NETWORK, asset: FIXTURE_ASSET, decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" },
  rail: "x402",
  destination: { scheme: "exact", network: FIXTURE_NETWORK, asset: FIXTURE_ASSET, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "0", bps: 0, min: "0" },
};
const URL_POST = "https://test-server.io/select";
const URL_GET = "https://test-server.io/v1/paid-snapshot";

interface Spy {
  readonly transport: GuardedTransport;
  readonly calls: { url: string; init: RequestInit | undefined; context: TransportContext }[];
  respond: (url: string, init: RequestInit | undefined) => Response;
}

function spyTransport(): Spy {
  const calls: Spy["calls"] = [];
  const spy: Spy = {
    calls,
    respond: (url) => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, error: "payment_required", resource: { url }, accepts: [standardAccept()] } as never) } }),
    transport: {
      allowLoopback: false,
      boundsDns: true,
      report: () => {},
      fetch: async (url, init, context) => {
        calls.push({ url: String(url), init, context });
        return spy.respond(String(url), init);
      },
    },
  };
  return spy;
}

function rail(spy: Spy, now: () => number = Date.now) {
  const evm = createRealEvmCapability(generatePrivateKey());
  return { evm, rail: createPrivateX402Rail(evm.capability(FIXTURE_NETWORK), { profiles: { [PROFILE_ID]: PROFILE }, transport: spy.transport, now }) };
}

describe("discover（本文に依存しない未払い探り。FR-Z16）", () => {
  test("POST は `{}` の application/json を 1 回だけ送り、支払いヘッダを付けない。offer は検査を通ったものだけ", async () => {
    const spy = spyTransport();
    const { rail: r } = rail(spy);
    const found = await r.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.url).toBe(URL_POST);
    expect(spy.calls[0]!.init).toMatchObject({ method: "POST", body: "{}", headers: { "content-type": "application/json" }, redirect: "error" });
    expect(Object.keys((spy.calls[0]!.init!.headers as Record<string, string>)).map((key) => key.toLowerCase())).not.toContain("payment-signature");
    expect(found.offers).toEqual([standardAccept()]);
    expect(decodePaymentRequiredHeader(encodePaymentRequiredHeader({ x402Version: 2, error: "x", resource: { url: URL_POST }, accepts: found.offers } as never))).toBeTruthy();
  });
  test("GET は本文無し。resource.url が違う 402 は読まない。operator 宛の offer は候補外", async () => {
    const spy = spyTransport();
    const { rail: r } = rail(spy);
    const found = await r.discover(PROFILE_ID, { url: URL_GET, method: "GET" });
    expect(spy.calls[0]!.init).toMatchObject({ method: "GET" });
    expect(found.offers).toHaveLength(1);
    spy.respond = () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, error: "x", resource: { url: "https://test-server.io/other" }, accepts: [standardAccept()] } as never) } });
    await expect(r.discover(PROFILE_ID, { url: URL_GET, method: "GET" })).rejects.toMatchObject({ reason: "resource_mismatch" });
    spy.respond = (url) => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, error: "x", resource: { url }, accepts: [standardAccept({ payTo: PROFILE.source.payTo })] } as never) } });
    expect((await r.discover(PROFILE_ID, { url: URL_GET, method: "GET" })).offers).toEqual([]);
  });
});

describe("issueCredential（送らない。FR-Z05）", () => {
  test("署名 1 回・fetch 0 回で PAYMENT-SIGNATURE の値と validBefore を返し、値は EIP-3009 の authorization として検証できる", async () => {
    const spy = spyTransport();
    const { evm, rail: r } = rail(spy);
    const found = await r.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" });
    const callsBefore = spy.calls.length;
    const offer = found.offers[0]!;
    const result = await r.issueCredential({ profileId: PROFILE_ID, offer, target: { url: URL_POST, method: "POST", body: "{}" }, challenge: found.challenge, deadlineMs: Date.now() + 60_000 });
    expect(spy.calls).toHaveLength(callsBefore);
    expect(evm.signCount()).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issued.name).toBe("PAYMENT-SIGNATURE");
    expect(result.issued.expectedRef).toBeUndefined();
    const payload = decodePaymentSignatureHeader(result.issued.value) as unknown as { payload: { authorization: Record<string, string>; signature: Hex }; accepted: unknown };
    const a = payload.payload.authorization;
    expect(getAddress(a["from"]!)).toBe(evm.address);
    expect(getAddress(a["to"]!)).toBe(getAddress(FIXTURE_PAY_TO));
    expect(a["value"]).toBe(offer.amount);
    expect(result.issued.expiresAtMs).toBe(Number(a["validBefore"]) * 1000);
    expect(result.issued.expiresAtMs).toBeGreaterThan(Date.now());
    expect(payload.accepted).toEqual(offer);
    const valid = await verifyTypedData({
      address: evm.address,
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: getAddress(FIXTURE_ASSET) },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: getAddress(a["from"]!), to: getAddress(a["to"]!), value: BigInt(a["value"]!), validAfter: BigInt(a["validAfter"]!), validBefore: BigInt(a["validBefore"]!), nonce: a["nonce"] as Hex },
      signature: payload.payload.signature,
    });
    expect(valid).toBe(true);
  });
  test("期限切れは署名の前に止まる（destination_deadline、署名 0 回）。再照合で消えた offer は destination_offer_changed", async () => {
    const spy = spyTransport();
    const start = Date.now();
    let clock = start;
    const { evm, rail: r } = rail(spy, () => clock);
    const found = await r.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" });
    const deadlineMs = start + 60_000;
    clock = deadlineMs;
    const late = await r.issueCredential({ profileId: PROFILE_ID, offer: found.offers[0]!, target: { url: URL_POST, method: "POST", body: "{}" }, challenge: found.challenge, deadlineMs });
    expect(late).toEqual({ ok: false, reason: "destination_deadline", signed: false });
    expect(evm.signCount()).toBe(0);
    clock = start;
    const other: DestinationOffer = { ...found.offers[0]!, amount: "2000" };
    const changed = await r.issueCredential({ profileId: PROFILE_ID, offer: other, target: { url: URL_POST, method: "POST", body: "{}" }, challenge: found.challenge, deadlineMs });
    expect(changed).toEqual({ ok: false, reason: "destination_offer_changed", signed: false });
    const otherUrl = await r.issueCredential({ profileId: PROFILE_ID, offer: found.offers[0]!, target: { url: URL_GET, method: "GET" }, challenge: found.challenge, deadlineMs });
    expect(otherUrl).toEqual({ ok: false, reason: "destination_offer_changed", signed: false });
    expect(evm.signCount()).toBe(0);
    expect(spy.calls).toHaveLength(1);
  });
});

describe("checkReceipt（Verifier の record に現れた PAYMENT-RESPONSE）", () => {
  test("success・network・bytes32・payer = 署名者 のときだけ ok", async () => {
    const spy = spyTransport();
    const { evm, rail: r } = rail(spy);
    const offer = standardAccept() as unknown as DestinationOffer;
    const issued = { name: "PAYMENT-SIGNATURE" as const, value: "x", expiresAtMs: 0 };
    const tx = `0x${"7a".repeat(32)}`;
    const header = (receipt: Record<string, unknown>): string => encodePaymentResponseHeader(receipt as never);
    expect(r.checkReceipt(header({ success: true, network: FIXTURE_NETWORK, transaction: tx, payer: evm.address }), offer, issued)).toEqual({ ok: true, txRef: tx, receiptRef: header({ success: true, network: FIXTURE_NETWORK, transaction: tx, payer: evm.address }) });
    // payer の欄が無い・null・別のアドレスはどれも不一致（秘匿購入は署名者の名乗りを要求する。FR-Z08）。
    expect(r.checkReceipt(header({ success: true, network: FIXTURE_NETWORK, transaction: tx }), offer, issued)).toEqual({ ok: false, reason: "destination_receipt_payer_mismatch" });
    expect(r.checkReceipt(header({ success: true, network: FIXTURE_NETWORK, transaction: tx, payer: null }), offer, issued)).toEqual({ ok: false, reason: "destination_receipt_payer_mismatch" });
    expect(r.checkReceipt(header({ success: true, network: FIXTURE_NETWORK, transaction: tx, payer: evm.address.toUpperCase().replace("0X", "0x") }), offer, issued)).toMatchObject({ ok: true, txRef: tx });
    expect(r.checkReceipt(header({ success: false, network: FIXTURE_NETWORK, transaction: tx, payer: evm.address }), offer, issued)).toEqual({ ok: false, reason: "destination_receipt_unverified" });
    expect(r.checkReceipt(header({ success: true, network: "eip155:1", transaction: tx, payer: evm.address }), offer, issued)).toEqual({ ok: false, reason: "destination_receipt_unverified" });
    expect(r.checkReceipt(header({ success: true, network: FIXTURE_NETWORK, transaction: "0x12", payer: evm.address }), offer, issued)).toEqual({ ok: false, reason: "destination_receipt_unverified" });
    expect(r.checkReceipt(header({ success: true, network: FIXTURE_NETWORK, transaction: tx, payer: "0x" + "9".repeat(40) }), offer, issued)).toEqual({ ok: false, reason: "destination_receipt_payer_mismatch" });
    expect(r.checkReceipt("not-base64-json", offer, issued)).toEqual({ ok: false, reason: "destination_receipt_unverified" });
    expect(decodePaymentResponseHeader(header({ success: true, network: FIXTURE_NETWORK, transaction: tx }))).toMatchObject({ success: true });
  });
});
