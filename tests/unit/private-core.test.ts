/**
 * 秘匿購入の core（設計 §3、T-Z4c）: 合成の受信 rail・偽の私的送信 rail・偽バイナリ（`fake-delivery.mjs`）で、quote → purchase → session → attest → record の全経路と、
 * 各段の失敗の終端、容量、attest の受付手順、再起動の再構成、canary の行列を確かめる。資金は動かない。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DEFAULT_DYNAMIC_LIMITS, DEFAULT_PRIVATE_CONFIG, type DynamicProfile, type RouterConfig } from "../../src/config.js";
import { createRouterCore, type PrivateQuoteOutcome, type RouterCore } from "../../src/core/orchestrator.js";
import { stableJson } from "../../src/core/intent.js";
import type { StopPoint } from "../../src/core/private.js";
import { createVerifierRunner, sha256File } from "../../src/private/verifier.js";
import type { CreateOfferRequest, InboundOffer, InboundRail, PaymentCredential, PreflightResult, SettleResult } from "../../src/ports/inbound.js";
import type { DestinationOffer, OutboundRail, PayResult, UpstreamTarget } from "../../src/ports/outbound.js";
import type { IssueCredentialArgs, IssueOutcome, PrivateOutboundRail, ReceiptCheck } from "../../src/ports/private-outbound.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const FAKE = path.resolve(import.meta.dirname, "../fixtures/private/fake-delivery.mjs");
const goldenDir = path.join(import.meta.dirname, "../fixtures/private/golden");

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
const HEADER_VALUE = "eyJ4NDAyVmVyc2lvbiI6MiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweGRlYWRiZWVmIn19"; // bearer（偽）。canary の対象。
const RECEIPT_VALUE = "eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4MTEifQ";
const DST_TX = `0x${"11".repeat(32)}`;

const LAB_ORDER = (JSON.parse(readFileSync(path.join(goldenDir, "post-intent.json"), "utf8")) as { order: Record<string, unknown> }).order;
function envelopeFor(orderId = LAB_ORDER["order_id"] as string): { bytes: Buffer; b64: string; sha: string; order: Record<string, unknown> } {
  const order = { ...LAB_ORDER, order_id: orderId };
  const doc = { version: "phase5-intent-v1", order, outbound: { protocol: "x402", network: NETWORK, asset: USDC, payTo: PAY_TO, maxAmount: "10000" }, inbound: { network: NETWORK, asset: USDC, maxTotal: "11000" } };
  const bytes = Buffer.from(JSON.stringify(doc), "utf8");
  return { bytes, b64: bytes.toString("base64"), sha: createHash("sha256").update(bytes).digest("hex"), order };
}

function config(overrides: Partial<RouterConfig["private"] & {}> = {}, dynamicLimits: Partial<typeof DEFAULT_DYNAMIC_LIMITS> = {}): RouterConfig {
  return {
    approvalTtlMs: 120_000,
    routes: {},
    budget: { maxPurchases: 10, buckets: [{ network: NETWORK, asset: USDC, maxTotal: "10000000", maxPerPurchase: "200000" }] },
    dynamic: {
      enabled: true,
      profiles: { [PROFILE_ID]: PROFILE },
      budget: { maxPurchases: 20, buckets: [{ network: NETWORK, asset: USDC, maxTotal: "10000000", maxPerPurchase: "200000" }] },
      limits: { ...DEFAULT_DYNAMIC_LIMITS, quotesPerMinuteGlobal: 1000, quotesPerMinutePerSource: 1000, purchasesPerMinuteGlobal: 1000, purchasesPerMinutePerSource: 1000, perHostPerMinute: 1000, concurrentGlobal: 64, concurrentPerSource: 64, perHostConcurrent: 64, ...dynamicLimits },
      denyHosts: [],
    },
    private: {
      ...DEFAULT_PRIVATE_CONFIG,
      deliveryBin: FAKE,
      deliveryBinSha256: sha256File(FAKE),
      srsPath: FAKE,
      srsSha256: sha256File(FAKE),
      profiles: [PROFILE_ID],
      sessionTimeoutMs: 20_000,
      minSessionRemainingMs: 1_000,
      attestTimeoutMs: 20_000,
      verifyTimeoutMs: 5_000,
      retentionMs: 60_000,
      maxChildOutputBytes: 4096,
      ...overrides,
    },
  };
}

class SyntheticInbound implements InboundRail {
  verifyCalls = 0;
  settleCalls = 0;
  eventId: string | undefined = "0xnonce-auth";
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
    this.verifyCalls += 1;
    return { isValid: true };
  }
  async settle(): Promise<SettleResult> {
    this.settleCalls += 1;
    return { outcome: "settled", txRef: `0xsrc${this.settleCalls}`, ...(this.eventId === undefined ? {} : { eventId: this.eventId }) };
  }
  credentialFor(offer: InboundOffer): PaymentCredential {
    return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, authorization: { nonce: this.eventId ?? "0x00" } } };
  }
}

class NeverOutbound implements OutboundRail {
  readChallengeCalls = 0;
  async readChallenge(): Promise<readonly DestinationOffer[]> {
    this.readChallengeCalls += 1;
    throw new Error("the static/dynamic outbound must not be used for private purchases");
  }
  async pay(): Promise<PayResult> {
    throw new Error("pay must not be called");
  }
}

class FakePrivateRail implements PrivateOutboundRail {
  readonly rail = "x402" as const;
  discoverCalls = 0;
  issueCalls = 0;
  offers: DestinationOffer[] = [OFFER];
  issue: (args: IssueCredentialArgs) => IssueOutcome = () => ({ ok: true, issued: { name: "PAYMENT-SIGNATURE", value: HEADER_VALUE, expiresAtMs: Date.now() + 120_000 } });
  readonly probes: UpstreamTarget[] = [];
  async discover(_profileId: string, target: UpstreamTarget) {
    this.discoverCalls += 1;
    this.probes.push(target);
    return { offers: this.offers, challenge: { accepts: this.offers } };
  }
  async issueCredential(args: IssueCredentialArgs): Promise<IssueOutcome> {
    this.issueCalls += 1;
    return this.issue(args);
  }
  checkReceipt(headerValue: string): ReceiptCheck {
    return headerValue === RECEIPT_VALUE ? { ok: true, txRef: DST_TX, receiptRef: headerValue } : { ok: false, reason: "destination_receipt_unverified" };
  }
}

let workDir: string;
let journalPath: string;
let privateDir: string;
let inbound: SyntheticInbound;
let outbound: NeverOutbound;
let rail: FakePrivateRail;
let ids = 0;
const opened: RouterCore[] = [];

beforeEach(() => {
  mkdirSync(runtimeRoot, { recursive: true });
  workDir = mkdtempSync(path.join(runtimeRoot, "private-core-"));
  journalPath = path.join(workDir, "journal.ndjson");
  privateDir = path.join(workDir, "private");
  inbound = new SyntheticInbound();
  outbound = new NeverOutbound();
  rail = new FakePrivateRail();
  ids = 0;
});
afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.close();
  rmSync(workDir, { recursive: true, force: true });
});

function control(value: Record<string, unknown>): void {
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(privateDir, "fake-control.json"), JSON.stringify({ receiptHeader: { name: "PAYMENT-RESPONSE", value: RECEIPT_VALUE }, delayMs: 150, ...value }));
}

async function boot(cfg: RouterConfig = config(), extra: { stop?: (point: StopPoint, paymentId: string) => Promise<void>; trust?: "mozilla" | "lab-fixture-ca" } = {}): Promise<RouterCore> {
  const runner = createVerifierRunner({ deliveryBin: FAKE, srsPath: cfg.private!.srsPath, trust: extra.trust ?? "lab-fixture-ca", maxChildOutputBytes: cfg.private!.maxChildOutputBytes });
  const core = await createRouterCore({
    journalPath,
    config: cfg,
    inbound,
    outbound,
    nextPaymentId: () => `pay-${(ids += 1)}`,
    dynamic: { ledgerDir: path.join(workDir, "dynamic-quotes") },
    private: { rails: { [PROFILE_ID]: rail }, runner, trust: extra.trust ?? "lab-fixture-ca", workDir: privateDir, ...(extra.stop === undefined ? {} : { hooksForTest: { stop: extra.stop } }) },
  });
  opened.push(core);
  return core;
}

async function quote(core: RouterCore, requestId = "r1", b64 = envelopeFor().b64): Promise<Extract<PrivateQuoteOutcome, { ok: true }>> {
  const outcome = await core.privateQuote({ principalId: "alice", requestId, profileId: PROFILE_ID, intentB64: b64 });
  if (!outcome.ok) throw new Error(`quote failed: ${outcome.code} ${outcome.reason ?? ""}`);
  return outcome;
}

async function purchase(core: RouterCore, q: Extract<PrivateQuoteOutcome, { ok: true }>, requestId = "r1") {
  return core.purchase({ principalId: "alice", requestId, quoteId: q.quoteId, approval: q.quoteId, credential: inbound.credentialFor(q.source.offer), ownerKey: q.ownerKey });
}

async function journalText(): Promise<string> {
  return readFileSync(journalPath, "utf8");
}
function events(): string[] {
  return readFileSync(journalPath, "utf8").split("\n").filter((line) => line !== "").map((line) => (JSON.parse(line) as { event: string }).event);
}
async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("timeout waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function bundleFor(order: Record<string, unknown>, patch: Record<string, unknown> = {}, requestPatch: Record<string, unknown> = {}): string {
  const request = order["request"] as Record<string, unknown>;
  const bundle = {
    public: { order_id: order["order_id"], payer_pk: order["payer_pk"], committed_hash_hex: "b".repeat(64), payload_len: 196, ...patch },
    proof_hex: "00",
    request: { public: { tls_body_hash_hex: "d".repeat(64), tls_cred_hash_hex: "c".repeat(64), payer_commitment_hex: request["body_commitment_hex"], body_len: request["body_len"], cred_len: 39, ...requestPatch }, proof_hex: "00" },
  };
  return Buffer.from(JSON.stringify(bundle), "utf8").toString("base64");
}

describe("quote（§3.1）", () => {
  test("封筒を検査し、探りは `{}` の POST、承認対象に方針と上限、記録に封筒と方針の写し。ownerKey はこの応答にしか無い", async () => {
    const core = await boot();
    const env = envelopeFor();
    const q = await quote(core, "r1", env.b64);
    expect(rail.probes).toEqual([{ url: "https://test-server.io/select", method: "POST", body: "{}" }]);
    expect(outbound.readChallengeCalls).toBe(0);
    expect(q.pricing).toEqual({ upstreamAmount: "10000", converted: "10000", fee: "1000", total: "11000" });
    expect(q.private).toMatchObject({ intentSha256: env.sha, method: "POST", target: { host: "test-server.io", port: 443, path: "/select" }, body: { len: 88 }, outbound: { rail: "x402", mode: "sign-only", payTo: PAY_TO, amount: "10000" }, inbound: { total: "11000" }, policy: { sessionTimeoutMs: 20_000 }, limits: { maxSentBytes: 4096, maxHeaderValueBytes: 2048 } });
    expect(typeof q.ownerKey).toBe("string");
    expect(q.source.offer.extra.routeBinding).toBe(["private", PROFILE_ID, "POST", "https://test-server.io/select", env.sha].map(encodeURIComponent).join("|"));
    // 状態（控え）は ownerKey が無いと読めない。
    expect(core.status(q.paymentId, "alice")).toBeUndefined();
    expect(core.status(q.paymentId, "alice", q.ownerKey)?.private).toMatchObject({ intentSha256: env.sha, outbound: { issued: false }, artifacts: { record: "none" } });
  });
  test("拒否: 封筒の形・allowlist 外・profile との不一致・requestId の衝突", async () => {
    const core = await boot();
    expect(await core.privateQuote({ principalId: "alice", requestId: "r1", profileId: "other", intentB64: envelopeFor().b64 })).toEqual({ ok: false, code: "unknown_route" });
    expect(await core.privateQuote({ principalId: "alice", requestId: "r1", profileId: PROFILE_ID, intentB64: "!!!" })).toMatchObject({ ok: false, code: "invalid_intent" });
    expect(await core.privateQuote({ principalId: "alice", requestId: "r1", profileId: PROFILE_ID, intentB64: Buffer.from("x".repeat(3000)).toString("base64") })).toMatchObject({ ok: false, code: "intent_too_large" });
    const wrongPayTo = JSON.parse(envelopeFor().bytes.toString("utf8")) as { outbound: Record<string, unknown> };
    wrongPayTo.outbound["payTo"] = "0x" + "9".repeat(40);
    expect(await core.privateQuote({ principalId: "alice", requestId: "r1", profileId: PROFILE_ID, intentB64: Buffer.from(JSON.stringify(wrongPayTo)).toString("base64") })).toEqual({ ok: false, code: "intent_mismatch", reason: "outbound_offer" });
    const smallTotal = JSON.parse(envelopeFor().bytes.toString("utf8")) as { inbound: Record<string, unknown> };
    smallTotal.inbound["maxTotal"] = "10999";
    expect(await core.privateQuote({ principalId: "alice", requestId: "r1", profileId: PROFILE_ID, intentB64: Buffer.from(JSON.stringify(smallTotal)).toString("base64") })).toEqual({ ok: false, code: "intent_mismatch", reason: "inbound_total" });
    await quote(core, "r1");
    expect(await core.privateQuote({ principalId: "alice", requestId: "r1", profileId: PROFILE_ID, intentB64: envelopeFor().b64 })).toEqual({ ok: false, code: "request_id_conflict" });
    expect(rail.issueCalls).toBe(0);
  });
  test("設定に private が無ければ private_disabled", async () => {
    const { private: _p, ...withoutPrivate } = config();
    const core = await createRouterCore({ journalPath, config: withoutPrivate, inbound, outbound, dynamic: { ledgerDir: path.join(workDir, "dynamic-quotes") } });
    opened.push(core);
    expect(await core.privateQuote({ principalId: "alice", requestId: "r1", profileId: PROFILE_ID, intentB64: envelopeFor().b64 })).toEqual({ ok: false, code: "private_disabled" });
  });
});

describe("purchase → session → attest → record（全経路）", () => {
  test("成立: handover の応答に credential、journal・射影に無い。record は何度でも取得でき、attest 成立で delivered_private", async () => {
    control({});
    const core = await boot();
    const env = envelopeFor();
    const q = await quote(core, "r1", env.b64);
    const result = await purchase(core, q);
    expect(result.status).toBe("awaiting_session");
    expect(result.handover).toMatchObject({ verifier: { address: "127.0.0.1:40001" }, releasedHeader: { name: "PAYMENT-SIGNATURE", value: HEADER_VALUE }, headerFile: { order_id: env.order["order_id"], intent_sha256: env.sha, name: "PAYMENT-SIGNATURE", value: HEADER_VALUE } });
    const release = JSON.parse(Buffer.from(result.handover!.releaseB64, "base64").toString("utf8")) as Record<string, unknown>;
    expect(release).toMatchObject({ version: "phase5-release-v1", intent_sha256: env.sha, header_name: "PAYMENT-SIGNATURE", header_sha256: createHash("sha256").update(HEADER_VALUE).digest("hex"), inbound: { tx: "0xsrc1" } });
    expect(result.handover!.deadlines.sessionBy).toBeGreaterThan(Date.now());
    expect(inbound.verifyCalls).toBe(1);
    expect(inbound.settleCalls).toBe(1);
    expect(rail.issueCalls).toBe(1);
    // 再照合は探りで（settle の前と発行の前）。
    expect(rail.discoverCalls).toBe(3);
    // 作業ディレクトリ: 0700、bearer は最終注文（0600）にだけ。
    const dir = path.join(privateDir, q.paymentId);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "order_final.json")).mode & 0o777).toBe(0o600);
    // record ができるのを待つ（偽バイナリが束縛された record を書く）。
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "attesting");
    const attesting = core.status(q.paymentId, "alice", q.ownerKey)!;
    expect(attesting.private).toMatchObject({ outbound: { issued: true }, artifacts: { record: "available" }, verifier: { requestLine: "POST /select HTTP/1.1", statusLine: "HTTP/1.1 200 OK", credLen: 39 } });
    expect(attesting.private!.deadlines.attestBy).toBeGreaterThan(Date.now());
    expect(statSync(path.join(dir, "record.json")).mode & 0o777).toBe(0o600);
    // canary: journal と射影に credential の値・封筒が無い（journal の封筒は created の private 欄に**ある**のが設計。値は無い）。
    const journal = await journalText();
    expect(journal).not.toContain(HEADER_VALUE);
    expect(JSON.stringify(attesting)).not.toContain(HEADER_VALUE);
    expect(JSON.stringify(attesting)).not.toContain(env.b64.slice(0, 24));
    // record の取得は何度でも同じ。
    const first = core.privateRecord(q.paymentId, "alice", q.ownerKey);
    const second = core.privateRecord(q.paymentId, "alice", q.ownerKey);
    expect(first.ok && second.ok && first.recordB64 === second.recordB64).toBe(true);
    if (first.ok) expect(JSON.parse(Buffer.from(first.recordB64, "base64").toString("utf8"))).toMatchObject({ order_id: env.order["order_id"], intent_binding: { intent_sha256: env.sha } });
    expect(core.privateRecord(q.paymentId, "alice", undefined)).toEqual({ ok: false, code: "not_found" });
    expect(core.privateRecord(q.paymentId, "bob", q.ownerKey)).toEqual({ ok: false, code: "not_found" });
    // attest。
    const attested = await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order));
    expect(attested).toEqual({ ok: true, status: "delivered_private" });
    const final = core.status(q.paymentId, "alice", q.ownerKey)!;
    expect(final.status).toBe("delivered_private");
    expect(final.destination).toMatchObject({ outcome: "paid", txRef: DST_TX, receiptRef: RECEIPT_VALUE });
    expect(final.private).toMatchObject({ proof: { delivery: true, requestBinding: true, onChainFinality: "not_checked" }, attest: { result: "delivered_private" } });
    // attest 完了で record 以外のファイルが消える（bearer の最終注文も）。
    expect(readdirSync(dir)).toEqual(["record.json"]);
    expect(await journalText()).not.toContain(HEADER_VALUE);
    expect(events()).toEqual(["created", "source_pending", "source_settled", "private_issuance_reserved", "private_released", "private_handed_over", "private_recorded", "private_attested"]);
    // 同じ bundle の再送は同じ結果、別の bundle は閉じている。
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order))).toEqual({ ok: true, status: "delivered_private" });
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order, { payload_len: 1 }))).toEqual({ ok: false, code: "attest_closed" });
    // 再提出の purchase は現在の終端。
    expect(await purchase(core, q)).toMatchObject({ status: "delivered_private" });
  });

  test("別購入の bundle は attest_foreign で状態・ファイル・検証の枠が不変。領収不一致は unknown/private_receipt_mismatch", async () => {
    control({ receiptHeader: { name: "PAYMENT-RESPONSE", value: "eyJvdGhlciI6dHJ1ZX0" } });
    const core = await boot();
    const env = envelopeFor();
    const q = await quote(core, "r1", env.b64);
    await purchase(core, q);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "attesting");
    const dir = path.join(privateDir, q.paymentId);
    const before = readdirSync(dir);
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(envelopeFor("0".repeat(32) + "e".repeat(32)).order))).toEqual({ ok: false, code: "attest_foreign" });
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order, {}, { tls_body_hash_hex: "0".repeat(64) }))).toEqual({ ok: false, code: "attest_foreign" });
    expect(core.status(q.paymentId, "alice", q.ownerKey)?.status).toBe("attesting");
    expect(readdirSync(dir)).toEqual(before);
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, "not-base64!!")).toEqual({ ok: false, code: "invalid_bundle" });
    expect(await core.privateAttest(q.paymentId, "bob", q.ownerKey, bundleFor(env.order))).toEqual({ ok: false, code: "not_found" });
    // 束縛は通るが領収ヘッダが発行に合わない → unknown（送信レグ unknown）。record は残る。
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order))).toEqual({ ok: true, status: "unknown", terminalReason: "private_receipt_mismatch" });
    const final = core.status(q.paymentId, "alice", q.ownerKey)!;
    expect(final).toMatchObject({ status: "unknown", terminalReason: "private_receipt_mismatch", destination: { outcome: "unknown" } });
    expect(final.private?.artifacts.record).toBe("available");
    expect(core.privateRecord(q.paymentId, "alice", q.ownerKey).ok).toBe(true);
    expect(readdirSync(dir)).toEqual(["record.json"]);
  });

  test("容量: 同時セッション 1 なら 2 件目は受信 verify の前に private_capacity で止まる（資金を動かさない）", async () => {
    control({ mode: "hang" });
    const core = await boot(config({ maxConcurrentSessions: 1 }));
    const q1 = await quote(core, "r1", envelopeFor().b64);
    const q2 = await quote(core, "r2", envelopeFor("0".repeat(32) + "a".repeat(32)).b64);
    expect((await purchase(core, q1, "r1")).status).toBe("awaiting_session");
    const verifyBefore = inbound.verifyCalls;
    const second = await purchase(core, q2, "r2");
    expect(second).toMatchObject({ status: "awaiting_payment", code: "private_capacity" });
    expect(inbound.verifyCalls).toBe(verifyBefore);
    expect(inbound.settleCalls).toBe(1);
    expect(existsSync(path.join(privateDir, q2.paymentId))).toBe(false);
  });

  test("再照合で offer が消えれば paid_undelivered（未発行、ディレクトリ削除）。eventId が無ければ private_inbound_identity_missing", async () => {
    const core = await boot();
    const q = await quote(core, "r1");
    // settle の後の再照合で消える: 3 回目の discover から空にする。
    let calls = 0;
    const original = rail.discover.bind(rail);
    rail.discover = async (profileId, target) => {
      calls += 1;
      const found = await original(profileId, target);
      return calls >= 2 ? { offers: [], challenge: { accepts: [] } } : found;
    };
    const result = await purchase(core, q);
    expect(result).toMatchObject({ status: "paid_data_unavailable", terminalReason: "offer_changed" });
    expect(rail.issueCalls).toBe(0);
    expect(existsSync(path.join(privateDir, q.paymentId))).toBe(false);
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ status: "paid_data_unavailable", destination: { outcome: "not_sent" } });
    rail.discover = original;
    inbound.eventId = undefined;
    const q2 = await quote(core, "r2", envelopeFor("0".repeat(32) + "a".repeat(32)).b64);
    expect(await purchase(core, q2, "r2")).toMatchObject({ status: "paid_data_unavailable", terminalReason: "private_inbound_identity_missing" });
    expect(rail.issueCalls).toBe(0);
  });

  test("予約の後の失敗は unknown: 発行の失敗・寿命不足・ヘッダの構文", async () => {
    const core = await boot();
    const envA = envelopeFor();
    const q1 = await quote(core, "r1", envA.b64);
    rail.issue = () => ({ ok: false, reason: "destination_not_signed", signed: false });
    expect(await purchase(core, q1, "r1")).toMatchObject({ status: "unknown", terminalReason: "private_issue_failed" });
    expect(core.status(q1.paymentId, "alice", q1.ownerKey)).toMatchObject({ status: "unknown", destination: { outcome: "unknown" }, private: { outbound: { issued: false } } });
    // 同じ intent は予約済み: 2 件目は collision → unknown/private_issuance_duplicate。
    const q2 = await quote(core, "r2", envA.b64);
    rail.issue = () => ({ ok: true, issued: { name: "PAYMENT-SIGNATURE", value: HEADER_VALUE, expiresAtMs: Date.now() + 120_000 } });
    expect(await purchase(core, q2, "r2")).toMatchObject({ status: "unknown", terminalReason: "private_issuance_duplicate" });
    const q3 = await quote(core, "r3", envelopeFor("0".repeat(32) + "a".repeat(32)).b64);
    rail.issue = () => ({ ok: true, issued: { name: "PAYMENT-SIGNATURE", value: HEADER_VALUE, expiresAtMs: Date.now() + 1_000 } });
    expect(await purchase(core, q3, "r3")).toMatchObject({ status: "unknown", terminalReason: "private_credential_lifetime" });
    const q4 = await quote(core, "r4", envelopeFor("0".repeat(32) + "b".repeat(32)).b64);
    rail.issue = () => ({ ok: true, issued: { name: "PAYMENT-SIGNATURE", value: "double  space", expiresAtMs: Date.now() + 120_000 } });
    expect(await purchase(core, q4, "r4")).toMatchObject({ status: "unknown", terminalReason: "private_header_invalid" });
    expect(await journalText()).not.toContain(HEADER_VALUE);
    for (const q of [q1, q2, q3, q4]) expect(existsSync(path.join(privateDir, q.paymentId))).toBe(false);
  });

  test("セッション期限: Verifier が record を作らずに居座れば unknown/private_session_timeout（子は終了）", async () => {
    control({ mode: "hang" });
    const core = await boot(config({ sessionTimeoutMs: 2_500, minSessionRemainingMs: 500 }));
    const q = await quote(core, "r1");
    const result = await purchase(core, q);
    expect(result.status).toBe("awaiting_session");
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "unknown", 8_000);
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ status: "unknown", terminalReason: "private_session_timeout", private: { artifacts: { record: "none" } } });
    expect(existsSync(path.join(privateDir, q.paymentId))).toBe(false);
  }, 15_000);

  test("期限の後に完成した record は late: unknown のまま取得だけできる", async () => {
    control({ tlsAcceptUnixMs: Date.now() + 10 * 60_000 });
    const core = await boot();
    const q = await quote(core, "r1");
    await purchase(core, q);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "unknown");
    const status = core.status(q.paymentId, "alice", q.ownerKey)!;
    expect(status).toMatchObject({ terminalReason: "private_session_timeout", private: { artifacts: { record: "available", late: true } } });
    expect(status.private?.deadlines.attestBy).toBeUndefined();
    expect(core.privateRecord(q.paymentId, "alice", q.ownerKey).ok).toBe(true);
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(envelopeFor().order))).toEqual({ ok: false, code: "attest_closed" });
    expect(readdirSync(path.join(privateDir, q.paymentId))).toEqual(["record.json"]);
  });
});

describe("再起動（§3.6）", () => {
  test("handover の後に止まれば unknown/interrupted_after_release。クラッシュ前に完成した record は回収され、取得だけできる", async () => {
    control({ delayMs: 50 });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const core = await boot(config(), { stop: async (point) => (point === "afterRecordPublish" ? blocked : undefined) });
    const env = envelopeFor();
    const q = await quote(core, "r1", env.b64);
    await purchase(core, q);
    // record が書かれ、journal に届く前（stop）で止まっている間に「クラッシュ」= core を閉じる。
    await waitFor(() => existsSync(path.join(privateDir, q.paymentId, "record.json")));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(core.status(q.paymentId, "alice", q.ownerKey)?.status).toBe("awaiting_session");
    await core.close();
    opened.pop();
    release!();
    const reopened = await boot();
    const status = reopened.status(q.paymentId, "alice", q.ownerKey)!;
    expect(status).toMatchObject({ status: "unknown", terminalReason: "interrupted_after_release", private: { artifacts: { record: "available" } } });
    expect(events()).toContain("private_recorded");
    const recovered = JSON.parse(readFileSync(journalPath, "utf8").split("\n").filter((line) => line.includes('"private_recorded"'))[0]!) as { patch: Record<string, unknown> };
    expect(recovered.patch).toMatchObject({ recoveredAtRestart: true, late: false });
    expect(reopened.privateRecord(q.paymentId, "alice", q.ownerKey).ok).toBe(true);
    expect(await reopened.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order))).toEqual({ ok: false, code: "attest_closed" });
    expect(readdirSync(path.join(privateDir, q.paymentId))).toEqual(["record.json"]);
    expect(await journalText()).not.toContain(HEADER_VALUE);
  });
  test("release の後・handover の前に止まれば interrupted_before_handover で、作業成果物は消える", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const core = await boot(config(), { stop: async (point) => (point === "afterRelease" ? blocked : undefined) });
    const q = await quote(core, "r1");
    const pending = purchase(core, q);
    await waitFor(() => events().includes("private_released"));
    await core.close();
    opened.pop();
    release!();
    await pending.catch(() => {});
    const reopened = await boot();
    expect(reopened.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ status: "unknown", terminalReason: "interrupted_before_handover" });
    expect(existsSync(path.join(privateDir, q.paymentId))).toBe(false);
  });
});
