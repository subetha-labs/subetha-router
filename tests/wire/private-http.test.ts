/**
 * 秘匿購入の HTTP の口（設計 §2・§8.1、T-Z6）: 実 TCP の HTTP サーバ + core（合成の受信 rail・偽の私的送信 rail・偽バイナリ）で、4 経路の状態コード、所有者違いの 404、
 * サイズ上限の 413、既存経路の不変、応答の形。資金は動かない。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createRouterClient } from "../../src/client/index.js";
import { DEFAULT_DYNAMIC_LIMITS, DEFAULT_PRIVATE_CONFIG, type DynamicProfile, type RouterConfig } from "../../src/config.js";
import { createRouterCore, type RouterCore } from "../../src/core/orchestrator.js";
import { stableJson } from "../../src/core/intent.js";
import { startHttpServer, type RunningServer } from "../../src/http/app.js";
import { createVerifierRunner, sha256File } from "../../src/private/verifier.js";
import type { CreateOfferRequest, InboundOffer, InboundRail, PaymentCredential, PreflightResult, SettleResult } from "../../src/ports/inbound.js";
import type { DestinationOffer, OutboundRail, PayResult, UpstreamTarget } from "../../src/ports/outbound.js";
import type { IssueCredentialArgs, IssueOutcome, PrivateOutboundRail, ReceiptCheck } from "../../src/ports/private-outbound.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const FAKE = path.resolve(import.meta.dirname, "../fixtures/private/fake-delivery.mjs");
const PROFILE_ID = "priv-x402";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532";
const PAY_TO = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";
const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "x402",
  source: { network: NETWORK, asset: USDC, decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" },
  rail: "x402",
  destination: { scheme: "exact", network: NETWORK, asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "1000", bps: 0, min: "1000" },
};
const OFFER: DestinationOffer = { scheme: "exact", network: NETWORK, asset: USDC, amount: "10000", payTo: PAY_TO, extra: { name: "USDC", version: "2" } };
const HEADER_VALUE = "eyJ4NDAyVmVyc2lvbiI6MiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweGRlYWRiZWVmIn19";
const RECEIPT_VALUE = "eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4MTEifQ";
const LAB_ORDER = (JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/private/golden/post-intent.json"), "utf8")) as { order: Record<string, unknown> }).order;
function envelope(): { b64: string; order: Record<string, unknown>; sha: string } {
  const doc = { version: "phase5-intent-v1", order: LAB_ORDER, outbound: { protocol: "x402", network: NETWORK, asset: USDC, payTo: PAY_TO, maxAmount: "10000" }, inbound: { network: NETWORK, asset: USDC, maxTotal: "11000" } };
  const bytes = Buffer.from(JSON.stringify(doc), "utf8");
  return { b64: bytes.toString("base64"), order: LAB_ORDER, sha: createHash("sha256").update(bytes).digest("hex") };
}

class SyntheticInbound implements InboundRail {
  #issued = 0;
  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.#issued += 1;
    return { scheme: "exact", network: request.network, asset: request.asset, amount: request.amount, payTo: "0xrouter", maxTimeoutSeconds: 120, extra: { challengeNonce: `0xnonce${this.#issued}`, expiresAt: Math.floor(Date.now() / 1000) + 600, routeBinding: request.routeBinding, name: "USDC", version: "2" } };
  }
  preflight(offer: InboundOffer, credential: PaymentCredential): PreflightResult {
    if (credential.payload.challengeNonce !== offer.extra.challengeNonce) return { ok: false, reason: "nonce_mismatch" };
    if (stableJson(credential.accepted) !== stableJson(offer)) return { ok: false, reason: "offer_mismatch" };
    return { ok: true };
  }
  async verify(): Promise<{ isValid: boolean }> {
    return { isValid: true };
  }
  async settle(): Promise<SettleResult> {
    return { outcome: "settled", txRef: "0xsrc1", eventId: "0xnonce-auth" };
  }
}
class NeverOutbound implements OutboundRail {
  async readChallenge(): Promise<readonly DestinationOffer[]> {
    throw new Error("not used");
  }
  async pay(): Promise<PayResult> {
    throw new Error("not used");
  }
}
class FakePrivateRail implements PrivateOutboundRail {
  readonly rail = "x402" as const;
  async discover(_profileId: string, _target: UpstreamTarget) {
    return { offers: [OFFER], challenge: { accepts: [OFFER] } };
  }
  async issueCredential(_args: IssueCredentialArgs): Promise<IssueOutcome> {
    return { ok: true, issued: { name: "PAYMENT-SIGNATURE", value: HEADER_VALUE, expiresAtMs: Date.now() + 120_000 } };
  }
  checkReceipt(headerValue: string): ReceiptCheck {
    return headerValue === RECEIPT_VALUE ? { ok: true, txRef: `0x${"11".repeat(32)}`, receiptRef: headerValue } : { ok: false, reason: "destination_receipt_unverified" };
  }
}

let workDir: string;
let core: RouterCore;
let server: RunningServer;
let baseUrl: string;

beforeEach(async () => {
  mkdirSync(runtimeRoot, { recursive: true });
  workDir = mkdtempSync(path.join(runtimeRoot, "private-http-"));
  const privateDir = path.join(workDir, "private");
  mkdirSync(privateDir, { mode: 0o700 });
  writeFileSync(path.join(privateDir, "fake-control.json"), JSON.stringify({ receiptHeader: { name: "PAYMENT-RESPONSE", value: RECEIPT_VALUE }, delayMs: 100 }));
  const config: RouterConfig = {
    approvalTtlMs: 120_000,
    routes: {},
    budget: { maxPurchases: 10, buckets: [{ network: NETWORK, asset: USDC, maxTotal: "10000000", maxPerPurchase: "200000" }] },
    dynamic: { enabled: true, profiles: { [PROFILE_ID]: PROFILE }, budget: { maxPurchases: 20, buckets: [{ network: NETWORK, asset: USDC, maxTotal: "10000000", maxPerPurchase: "200000" }] }, limits: { ...DEFAULT_DYNAMIC_LIMITS, quotesPerMinuteGlobal: 1000, quotesPerMinutePerSource: 1000, purchasesPerMinuteGlobal: 1000, purchasesPerMinutePerSource: 1000, perHostPerMinute: 1000 }, denyHosts: [] },
    private: { ...DEFAULT_PRIVATE_CONFIG, deliveryBin: FAKE, deliveryBinSha256: sha256File(FAKE), srsPath: FAKE, srsSha256: sha256File(FAKE), profiles: [PROFILE_ID], mpcProfiles: [PROFILE_ID], maxBundleBytes: 4096, maxChildOutputBytes: 4096 },
  };
  const runner = createVerifierRunner({ deliveryBin: FAKE, srsPath: FAKE, trust: "lab-fixture-ca", maxChildOutputBytes: 4096 });
  core = await createRouterCore({ journalPath: path.join(workDir, "journal.ndjson"), config, inbound: new SyntheticInbound(), outbound: new NeverOutbound(), dynamic: { ledgerDir: path.join(workDir, "dynamic-quotes") }, private: { rails: { [PROFILE_ID]: new FakePrivateRail() }, runner, trust: "lab-fixture-ca", workDir: privateDir } });
  server = await startHttpServer({ core, config, canonicalBaseUrl: "https://router.test", principals: new Map([["alice", "tok-alice"], ["bob", "tok-bob"]]), host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterEach(async () => {
  await server.close();
  await core.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function http(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}, token = "tok-alice", principal = "alice"): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { "x-router-principal": principal, authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
}
function credentialFor(offer: InboundOffer): string {
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, authorization: { nonce: "0xnonce-auth" } } }), "utf8").toString("base64");
}
async function waitFor(predicate: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("POST /v1/private/quotes", () => {
  test("秘匿 quote の文書: resource は POST /v1/private/purchases、upstream 無し、private 欄と ownerKey", async () => {
    const env = envelope();
    const { status, body } = await http("POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "r1", intentB64: env.b64 });
    expect(status).toBe(200);
    expect(body["resource"]).toEqual({ url: "https://router.test/v1/private/purchases", method: "POST" });
    expect(body["upstream"]).toBeUndefined();
    expect(body["private"]).toMatchObject({ intentSha256: env.sha, method: "POST", target: { host: "test-server.io", port: 443, path: "/select" } });
    expect(typeof body["ownerKey"]).toBe("string");
    expect(body["disclosures"]).toMatchObject({ privatePurchase: true, routerSeesRequestBody: false });
  });
  test("拒否の写像: 欠落 400、unknown_route 404、invalid_intent 400、intent_too_large 413、request_id_conflict 409", async () => {
    expect((await http("POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "r1" })).status).toBe(400);
    expect((await http("POST", "/v1/private/quotes", { profileId: "nope", requestId: "r1", intentB64: envelope().b64 })).status).toBe(404);
    expect(await http("POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "r1", intentB64: Buffer.from("{}").toString("base64") })).toMatchObject({ status: 400, body: { error: "invalid_intent" } });
    expect((await http("POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "r1", intentB64: Buffer.from("x".repeat(3000)).toString("base64") })).status).toBe(413);
    await http("POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "r1", intentB64: envelope().b64 });
    expect((await http("POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "r1", intentB64: envelope().b64 })).status).toBe(409);
    expect((await http("GET", "/v1/private/quotes")).status).toBe(405);
  });
});

describe("purchase → attest → record（HTTP）", () => {
  test("200 の引き渡し、attest 200、record 200（繰り返し）、所有者違い 404、別購入の bundle 409、既存の status に private 欄", async () => {
    const env = envelope();
    const q = (await http("POST", "/v1/private/quotes", { profileId: PROFILE_ID, requestId: "r1", intentB64: env.b64 })).body;
    const offer = (q["source"] as { offer: InboundOffer }).offer;
    const purchase = await http("POST", "/v1/private/purchases", { quoteId: q["quoteId"], requestId: "r1", approval: q["quoteId"], credential: credentialFor(offer), ownerKey: q["ownerKey"] });
    expect(purchase.status).toBe(200);
    expect(purchase.body).toMatchObject({ paymentId: q["paymentId"], status: "awaiting_session", verifier: { address: "127.0.0.1:40001" }, releasedHeader: { name: "PAYMENT-SIGNATURE", value: HEADER_VALUE }, headerFile: { intent_sha256: env.sha } });
    expect(typeof purchase.body["releaseB64"]).toBe("string");
    const paymentId = String(q["paymentId"]);
    // 進行中の再提出は 409。
    expect((await http("POST", "/v1/private/purchases", { quoteId: q["quoteId"], requestId: "r1", approval: q["quoteId"], credential: credentialFor(offer), ownerKey: q["ownerKey"] })).status).toBe(409);
    await waitFor(async () => (await http("GET", `/v1/purchases/${paymentId}`, undefined, { "x-router-owner-key": String(q["ownerKey"]) })).body["status"] === "attesting");
    const statusBody = (await http("GET", `/v1/purchases/${paymentId}`, undefined, { "x-router-owner-key": String(q["ownerKey"]) })).body;
    expect(statusBody["private"]).toMatchObject({ intentSha256: env.sha, outbound: { issued: true }, artifacts: { record: "available" } });
    expect(JSON.stringify(statusBody)).not.toContain(HEADER_VALUE);
    // record: 何度でも。所有者違い・鍵無しは 404。
    const record1 = await http("GET", `/v1/private/purchases/${paymentId}/record`, undefined, { "x-router-owner-key": String(q["ownerKey"]) });
    const record2 = await http("GET", `/v1/private/purchases/${paymentId}/record`, undefined, { "x-router-owner-key": String(q["ownerKey"]) });
    expect(record1.status).toBe(200);
    expect(record1.body["recordB64"]).toBe(record2.body["recordB64"]);
    expect((await http("GET", `/v1/private/purchases/${paymentId}/record`)).status).toBe(404);
    expect((await http("GET", `/v1/private/purchases/${paymentId}/record`, undefined, { "x-router-owner-key": String(q["ownerKey"]) }, "tok-bob", "bob")).status).toBe(404);
    // attest: 別購入の bundle は 409 attest_foreign、本物は 200 delivered_private。
    const bundle = (orderId: string): string => Buffer.from(JSON.stringify({ public: { order_id: orderId, payer_pk: env.order["payer_pk"], committed_hash_hex: "b".repeat(64), payload_len: 196 }, proof_hex: "00", request: { public: { tls_body_hash_hex: "d".repeat(64), tls_cred_hash_hex: "c".repeat(64), payer_commitment_hex: (env.order["request"] as Record<string, unknown>)["body_commitment_hex"], body_len: 88, cred_len: 39 }, proof_hex: "00" } })).toString("base64");
    expect(await http("POST", `/v1/private/purchases/${paymentId}/attest`, { bundleB64: bundle("0".repeat(64)), ownerKey: q["ownerKey"] })).toMatchObject({ status: 409, body: { error: "attest_foreign" } });
    expect((await http("POST", `/v1/private/purchases/${paymentId}/attest`, { bundleB64: bundle(String(env.order["order_id"])), ownerKey: "wrong" })).status).toBe(404);
    expect((await http("POST", `/v1/private/purchases/${paymentId}/attest`, { bundleB64: "x".repeat(10_000), ownerKey: q["ownerKey"] })).status).toBe(413);
    const attested = await http("POST", `/v1/private/purchases/${paymentId}/attest`, { bundleB64: bundle(String(env.order["order_id"])), ownerKey: q["ownerKey"] });
    expect(attested).toMatchObject({ status: 200, body: { paymentId, status: "delivered_private", private: { proof: { delivery: true } } } });
    expect(JSON.stringify(attested.body)).not.toContain(HEADER_VALUE);
    // 完了後の purchase 再提出は 200（本文に credential 無し）。
    const again = await http("POST", "/v1/private/purchases", { quoteId: q["quoteId"], requestId: "r1", approval: q["quoteId"], credential: credentialFor(offer), ownerKey: q["ownerKey"] });
    expect(again.status).toBe(200);
    expect(JSON.stringify(again.body)).not.toContain(HEADER_VALUE);
    // 既存の経路は不変: 動的の購入口（GET resource）は秘匿 quote を知らない（404 quote_required の 402 ではなく、canonical path の判定どおり）。
    const legacy = await http("GET", `/v1/routes/${PROFILE_ID}/resource`, undefined, { "x-router-quote-id": String(q["quoteId"]), "x-router-owner-key": String(q["ownerKey"]) });
    expect(legacy.status).toBe(402);
    expect(existsSync(path.join(workDir, "private", paymentId, "record.json"))).toBe(true);
  });
  test("client（製品の typed client）で同じ経路が通る", async () => {
    const client = createRouterClient({ baseUrl, principalId: "alice", token: "tok-alice" });
    const env = envelope();
    const quoted = await client.privateQuote({ profileId: PROFILE_ID, requestId: "r1", intentB64: env.b64 });
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    const offer = quoted.quote.source.offer as InboundOffer;
    const purchased = await client.privatePurchase({ quote: quoted.quote, requestId: "r1", approval: { approved: true, quoteId: quoted.quote.quoteId }, credential: credentialFor(offer) });
    expect(purchased.outcome).toBe("awaiting_session");
    if (purchased.outcome !== "awaiting_session") return;
    expect(purchased.handover.releasedHeader.value).toBe(HEADER_VALUE);
    await waitFor(async () => (await client.status(quoted.quote.paymentId, quoted.quote.ownerKey)).found && ((await client.status(quoted.quote.paymentId, quoted.quote.ownerKey)) as { projection: { status: string } }).projection.status === "attesting");
    const record = await client.privateRecord({ paymentId: quoted.quote.paymentId, ownerKey: quoted.quote.ownerKey });
    expect(record.ok).toBe(true);
  });
});
