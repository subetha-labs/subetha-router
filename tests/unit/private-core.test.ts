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
import { createVerifierRunner, sha256File, type VerifierRunner } from "../../src/private/verifier.js";
import { open as openFile } from "node:fs/promises";
import { vi } from "vitest";
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
  /** v1.3 の試験用: offer の受取先と `extra` の追加欄（subetha の `settlementKind` など）、settle が返す txRef の固定値（同じ burn tx の再利用の試験）。 */
  payTo = "0xrouter";
  extra: Record<string, unknown> = {};
  txRef: string | undefined;
  /** v1.3.2 の試験用: offer の `asset` を要求と別の綴り・別の token で返す。 */
  assetOverride: string | undefined;
  #issued = 0;
  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.#issued += 1;
    return { scheme: "exact", network: request.network, asset: this.assetOverride ?? request.asset, amount: request.amount, payTo: this.payTo, maxTimeoutSeconds: 120, extra: { challengeNonce: `0xnonce${this.#issued}`, expiresAt: Math.floor(Date.now() / 1000) + 600, routeBinding: request.routeBinding, name: "USDC", version: "2", ...this.extra } };
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
    return { outcome: "settled", txRef: this.txRef ?? `0xsrc${this.settleCalls}`, ...(this.eventId === undefined ? {} : { eventId: this.eventId }) };
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

async function boot(cfg: RouterConfig = config(), extra: { stop?: (point: StopPoint, paymentId: string) => Promise<void>; trust?: "mozilla" | "lab-fixture-ca"; now?: () => number; runner?: (base: VerifierRunner) => VerifierRunner } = {}): Promise<RouterCore> {
  const base = createVerifierRunner({ deliveryBin: FAKE, srsPath: cfg.private!.srsPath, trust: extra.trust ?? "lab-fixture-ca", maxChildOutputBytes: cfg.private!.maxChildOutputBytes });
  const runner = extra.runner === undefined ? base : extra.runner(base);
  const core = await createRouterCore({
    journalPath,
    config: cfg,
    inbound,
    outbound,
    nextPaymentId: () => `pay-${(ids += 1)}`,
    ...(extra.now === undefined ? {} : { now: extra.now }),
    dynamic: { ledgerDir: path.join(workDir, "dynamic-quotes") },
    private: { rails: { [PROFILE_ID]: rail }, runner, trust: extra.trust ?? "lab-fixture-ca", workDir: privateDir, ...(extra.stop === undefined ? {} : { hooksForTest: { stop: extra.stop } }) },
  });
  opened.push(core);
  return core;
}

/** canary の行列（設計 §11、タスク文書）: Router が触れる成果物のうち、面ごとに許されない値が無いこと。 */
function scanArtifacts(core: RouterCore, paymentId: string, ownerKey: string): { journal: string; projection: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const dir = path.join(privateDir, paymentId);
  if (existsSync(dir)) for (const name of readdirSync(dir)) files[name] = readFileSync(path.join(dir, name), "latin1");
  return { journal: readFileSync(journalPath, "utf8"), projection: JSON.stringify(core.status(paymentId, "alice", ownerKey)), files };
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

describe("v1.3: subetha 受信（V2 burn-sale）の秘匿購入（`docs/zktls-router-v2-inbound.md`）", () => {
  const SUBETHA_ID = "priv-subetha";
  const ZUSDC = "0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF";
  const SEPOLIA = "eip155:11155111";
  function subethaConfig(destinationOnSepolia = false): RouterConfig {
    const cfg = JSON.parse(JSON.stringify(config())) as RouterConfig;
    const profile: DynamicProfile = { ...PROFILE, profileId: SUBETHA_ID, sourceRail: "subetha", source: { network: SEPOLIA, asset: ZUSDC, decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" }, ...(destinationOnSepolia ? { destination: { ...PROFILE.destination, network: SEPOLIA, asset: ZUSDC } } : {}) };
    (cfg.dynamic!.profiles as Record<string, DynamicProfile>)[SUBETHA_ID] = profile;
    (cfg.private!.profiles as string[]).push(SUBETHA_ID);
    // 受信資産（Sepolia zUSDC）の予算 bucket。
    (cfg.dynamic!.budget.buckets as { network: string; asset: string; maxTotal: string; maxPerPurchase: string }[]).push({ network: SEPOLIA, asset: ZUSDC, maxTotal: "100000000", maxPerPurchase: "200000" });
    return cfg;
  }
  let orderSeq = 0;
  /** 呼ぶたびに別の intent（order_id を変える）: 受信 identity の二重一意性を intent の一意性と混同しない。 */
  function subethaEnvelope(): string {
    orderSeq += 1;
    const doc = JSON.parse(envelopeFor(`${"0".repeat(48)}${orderSeq.toString(16).padStart(16, "0")}`).bytes.toString("utf8")) as { inbound: Record<string, unknown> };
    doc.inbound = { network: SEPOLIA, asset: ZUSDC, maxTotal: "11000" };
    return Buffer.from(JSON.stringify(doc)).toString("base64");
  }
  async function bootSubetha(destinationOnSepolia = false): Promise<RouterCore> {
    const cfg = subethaConfig(destinationOnSepolia);
    const base = createVerifierRunner({ deliveryBin: FAKE, srsPath: cfg.private!.srsPath, trust: "lab-fixture-ca", maxChildOutputBytes: cfg.private!.maxChildOutputBytes });
    const core = await createRouterCore({ journalPath, config: cfg, inbound, outbound, nextPaymentId: () => `pay-${(ids += 1)}`, dynamic: { ledgerDir: path.join(workDir, "dynamic-quotes") }, private: { rails: { [PROFILE_ID]: rail, [SUBETHA_ID]: rail }, runner: base, trust: "lab-fixture-ca", workDir: privateDir } });
    opened.push(core);
    return core;
  }
  test("quote: challenge が V2（settlementKind）でなければ source_terms_mismatch。V2 なら承認対象の受信は burn address と payer_burn_before_credential、射影は fundsMoveOnCredential", async () => {
    const core = await bootSubetha();
    inbound.payTo = "0x000000000000000000000000000000000000b0a7";
    const notV2 = await core.privateQuote({ principalId: "alice", requestId: "r1", profileId: SUBETHA_ID, intentB64: subethaEnvelope() });
    expect(notV2, JSON.stringify(notV2)).toEqual({ ok: false, code: "source_terms_mismatch", reason: "settlement_kind" });
    inbound.extra = { settlementKind: "zerc20-v2-burn-sale", fundsMoveOnCredential: true };
    const q = await core.privateQuote({ principalId: "alice", requestId: "r2", profileId: SUBETHA_ID, intentB64: subethaEnvelope() });
    if (!q.ok) throw new Error(`quote failed: ${q.code} ${q.reason ?? ""}`);
    expect(q.private).toMatchObject({ inbound: { rail: "subetha", network: SEPOLIA, asset: ZUSDC, payTo: "0x000000000000000000000000000000000000b0a7", total: "11000", fundsMoveAt: "payer_burn_before_credential" }, outbound: { rail: "x402", payTo: PAY_TO } });
    expect(core.status(q.paymentId, "alice", q.ownerKey)?.dynamic).toMatchObject({ fundsMoveOnCredential: true });
    // 通常の動的 quote は I/O の前に拒む（SR-V1）。
    expect(await core.quote({ principalId: "alice", requestId: "r3", routeId: SUBETHA_ID, upstream: { url: "https://test-server.io/select" }, source: "alice" })).toMatchObject({ ok: false, code: "private_only_profile" });
  });
  test("quote: challenge の token の綴り（小文字）が設定（checksum）と違っても同じ資産なら通り、承認対象の資産は challenge の綴り。別の token は source_terms_mismatch", async () => {
    const core = await bootSubetha();
    inbound.extra = { settlementKind: "zerc20-v2-burn-sale", fundsMoveOnCredential: true };
    inbound.assetOverride = ZUSDC.toLowerCase();
    const lower = await core.privateQuote({ principalId: "alice", requestId: "r-lower", profileId: SUBETHA_ID, intentB64: subethaEnvelope() });
    if (!lower.ok) throw new Error(`quote failed: ${lower.code} ${lower.reason ?? ""}`);
    expect((lower.source.offer as { asset: string }).asset).toBe(ZUSDC.toLowerCase());
    inbound.assetOverride = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
    expect(await core.privateQuote({ principalId: "alice", requestId: "r-other", profileId: SUBETHA_ID, intentB64: subethaEnvelope() })).toEqual({ ok: false, code: "source_terms_mismatch" });
    inbound.assetOverride = undefined;
  });
  test("quote: 注文ごとの burn address が同じ network・資産の Provider の受取先と同じなら pay_to_conflict", async () => {
    // 送信も Sepolia zUSDC（同じ network・資産）のプロファイルで、Provider の受取先 = 注文の burn address にする。
    const core = await bootSubetha(true);
    inbound.extra = { settlementKind: "zerc20-v2-burn-sale", fundsMoveOnCredential: true };
    rail.offers = [{ ...OFFER, network: SEPOLIA, asset: ZUSDC, payTo: "0x000000000000000000000000000000000000b0a7" }];
    inbound.payTo = "0x000000000000000000000000000000000000B0A7";
    const doc = JSON.parse(Buffer.from(subethaEnvelope(), "base64").toString("utf8")) as { outbound: Record<string, unknown> };
    doc.outbound = { ...doc.outbound, network: SEPOLIA, asset: ZUSDC, payTo: "0x000000000000000000000000000000000000b0a7" };
    const conflict = await core.privateQuote({ principalId: "alice", requestId: "r1", profileId: SUBETHA_ID, intentB64: Buffer.from(JSON.stringify(doc)).toString("base64") });
    expect(conflict, JSON.stringify(conflict)).toEqual({ ok: false, code: "quote_failed", reason: "pay_to_conflict" });
  });
  test("purchase: settle が eventId を返さなければ発行しない（paid_undelivered/private_inbound_identity_missing）。返せば identity は subetha|<network>|<tx>|<eventId> で発行", async () => {
    const core = await bootSubetha();
    inbound.extra = { settlementKind: "zerc20-v2-burn-sale", fundsMoveOnCredential: true };
    inbound.eventId = undefined;
    const q1 = await core.privateQuote({ principalId: "alice", requestId: "r1", profileId: SUBETHA_ID, intentB64: subethaEnvelope() });
    if (!q1.ok) throw new Error(`${q1.code} ${q1.reason ?? ""}`);
    const p1 = await core.purchase({ principalId: "alice", requestId: "r1", quoteId: q1.quoteId, approval: q1.quoteId, credential: inbound.credentialFor(q1.source.offer), ownerKey: q1.ownerKey });
    expect(p1, JSON.stringify(p1)).toMatchObject({ status: "paid_data_unavailable", terminalReason: "private_inbound_identity_missing" });
    expect(rail.issueCalls).toBe(0);
    inbound.eventId = "11155111:0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef:121";
    const q2 = await core.privateQuote({ principalId: "alice", requestId: "r2", profileId: SUBETHA_ID, intentB64: subethaEnvelope() });
    if (!q2.ok) throw new Error(q2.code);
    control({});
    const p2 = await core.purchase({ principalId: "alice", requestId: "r2", quoteId: q2.quoteId, approval: q2.quoteId, credential: inbound.credentialFor(q2.source.offer), ownerKey: q2.ownerKey });
    expect(p2).toMatchObject({ status: "awaiting_session" });
    expect(rail.issueCalls).toBe(1);
    const reserved = readFileSync(journalPath, "utf8").split("\n").map((l) => (l === "" ? undefined : (JSON.parse(l) as { event?: string; patch?: Record<string, unknown> }))).find((e) => e?.event === "private_issuance_reserved");
    expect(reserved?.patch?.["inboundIdentity"]).toBe(`subetha|${SEPOLIA}|0xsrc2|${inbound.eventId}`);
    // 再起動後、別の intent が同じ burn tx（同じ txRef・同じ eventId）で来ても発行しない（受信 identity の二重一意性は journal から復元される）。
    inbound.txRef = "0xsrc2";
    await core.close();
    opened.splice(opened.indexOf(core), 1);
    const reopened = await bootSubetha();
    const q3 = await reopened.privateQuote({ principalId: "alice", requestId: "r3", profileId: SUBETHA_ID, intentB64: subethaEnvelope() });
    if (!q3.ok) throw new Error(`${q3.code} ${q3.reason ?? ""}`);
    const p3 = await reopened.purchase({ principalId: "alice", requestId: "r3", quoteId: q3.quoteId, approval: q3.quoteId, credential: inbound.credentialFor(q3.source.offer), ownerKey: q3.ownerKey });
    expect(p3, JSON.stringify(p3)).toMatchObject({ status: "unknown", terminalReason: "private_issuance_duplicate" });
    expect(rail.issueCalls).toBe(1);
    // 再起動後も、元の購入の開示（受信は credential の時点で資金が動く）は射影に残る。
    expect(reopened.status(q2.paymentId, "alice", q2.ownerKey)?.dynamic).toMatchObject({ fundsMoveOnCredential: true });
    // 同時: 同じ burn tx を申告する 2 つの intent を同時に purchase → 発行は合計 1 回のまま、もう片方は duplicate。
    const q4 = await reopened.privateQuote({ principalId: "alice", requestId: "r4", profileId: SUBETHA_ID, intentB64: subethaEnvelope() });
    const q5 = await reopened.privateQuote({ principalId: "alice", requestId: "r5", profileId: SUBETHA_ID, intentB64: subethaEnvelope() });
    if (!q4.ok || !q5.ok) throw new Error("quote failed");
    inbound.txRef = "0xsrc9";
    inbound.eventId = "11155111:0x9999999999999999999999999999999999999999999999999999999999999999:7";
    const [p4, p5] = await Promise.all([
      reopened.purchase({ principalId: "alice", requestId: "r4", quoteId: q4.quoteId, approval: q4.quoteId, credential: inbound.credentialFor(q4.source.offer), ownerKey: q4.ownerKey }),
      reopened.purchase({ principalId: "alice", requestId: "r5", quoteId: q5.quoteId, approval: q5.quoteId, credential: inbound.credentialFor(q5.source.offer), ownerKey: q5.ownerKey }),
    ]);
    const outcomes = [p4, p5].map((p) => ("terminalReason" in p ? p.terminalReason : p.status)).sort();
    expect(outcomes, JSON.stringify([p4, p5])).toEqual(["awaiting_session", "private_issuance_duplicate"]);
    expect(rail.issueCalls).toBe(2);
  });
});

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
    // 領収は tx 参照と digest だけ（生のヘッダは journal・射影に無い。原本は record）。
    expect(final.destination).toMatchObject({ outcome: "paid", txRef: DST_TX });
    expect(final.destination).not.toHaveProperty("receiptRef");
    expect(final.private).toMatchObject({ outbound: { receiptSha256: createHash("sha256").update(RECEIPT_VALUE).digest("hex") } });
    expect(await journalText()).not.toContain(RECEIPT_VALUE);
    expect(JSON.stringify(final)).not.toContain(RECEIPT_VALUE);
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
    // `unknown` の行と `private_recorded {late}` の行は 2 行: 両方が揃うのを待つ。
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "unknown" && core.status(q.paymentId, "alice", q.ownerKey)?.private?.artifacts.record === "available");
    const status = core.status(q.paymentId, "alice", q.ownerKey)!;
    expect(status).toMatchObject({ terminalReason: "private_session_timeout", private: { artifacts: { record: "available", late: true } } });
    expect(status.private?.deadlines.attestBy).toBeUndefined();
    expect(core.privateRecord(q.paymentId, "alice", q.ownerKey).ok).toBe(true);
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(envelopeFor().order))).toEqual({ ok: false, code: "attest_closed" });
    expect(readdirSync(path.join(privateDir, q.paymentId))).toEqual(["record.json"]);
  });
});

describe("attest の受付（同時提出・待ち行列・期限）", () => {
  test("検証中: 同じ digest は合流（検証 1 回）、別の digest は即 attest_in_progress。待ち行列の受理は期限内なら attestBy を越えても検証する。タイマは受理済みを壊さない", async () => {
    control({});
    let releaseVerify: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    let stops = 0;
    const core = await boot(config({ maxConcurrentVerifications: 1, maxQueuedVerifications: 1, attestTimeoutMs: 1_500 }), {
      stop: async (point) => {
        if (point === "afterAttestAdmission") {
          stops += 1;
          if (stops === 1) await blocked;
        }
      },
    });
    const envA = envelopeFor();
    const envB = envelopeFor("0".repeat(32) + "a".repeat(32));
    const qA = await quote(core, "r1", envA.b64);
    const qB = await quote(core, "r2", envB.b64);
    await purchase(core, qA, "r1");
    await purchase(core, qB, "r2");
    await waitFor(() => core.status(qA.paymentId, "alice", qA.ownerKey)?.status === "attesting" && core.status(qB.paymentId, "alice", qB.ownerKey)?.status === "attesting");
    // A: 1 件目の検証は hook で止まる。
    const first = core.privateAttest(qA.paymentId, "alice", qA.ownerKey, bundleFor(envA.order));
    await waitFor(() => stops === 1);
    const same = core.privateAttest(qA.paymentId, "alice", qA.ownerKey, bundleFor(envA.order));
    const different = await core.privateAttest(qA.paymentId, "alice", qA.ownerKey, bundleFor(envA.order, { payload_len: 197 }));
    expect(different).toEqual({ ok: false, code: "attest_in_progress" });
    // B: 枠（実行 1）が塞がっているので待ち行列へ。期限（1.5 s）を越えても受理済みなので検証される。
    const queued = core.privateAttest(qB.paymentId, "alice", qB.ownerKey, bundleFor(envB.order));
    const overflow = await core.privateAttest(qB.paymentId, "alice", qB.ownerKey, bundleFor(envB.order, { payload_len: 197 }));
    expect(overflow).toEqual({ ok: false, code: "attest_in_progress" });
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    // attestBy を過ぎたが、A は検証中・B は受理済み: タイマは unknown を書かない。
    expect(core.status(qA.paymentId, "alice", qA.ownerKey)?.status).toBe("attesting");
    expect(core.status(qB.paymentId, "alice", qB.ownerKey)?.status).toBe("attesting");
    releaseVerify!();
    expect(await first).toEqual({ ok: true, status: "delivered_private" });
    expect(await same).toEqual({ ok: true, status: "delivered_private" });
    expect(await queued).toEqual({ ok: true, status: "delivered_private" });
    expect(stops).toBe(2);
    // 期限切れの 3 件目の購入: 受理されない。
    const envC = envelopeFor("0".repeat(32) + "c".repeat(32));
    const qC = await quote(core, "r3", envC.b64);
    await purchase(core, qC, "r3");
    await waitFor(() => core.status(qC.paymentId, "alice", qC.ownerKey)?.status === "attesting");
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(core.status(qC.paymentId, "alice", qC.ownerKey)).toMatchObject({ status: "unknown", terminalReason: "private_attest_timeout" });
    expect(await core.privateAttest(qC.paymentId, "alice", qC.ownerKey, bundleFor(envC.order))).toEqual({ ok: false, code: "attest_closed" });
    expect(readdirSync(path.join(privateDir, qC.paymentId))).toEqual(["record.json"]);
  }, 20_000);

  test("検証の枠が無ければ private_capacity（状態不変）。drain 中の受理は private_unavailable で、待ち行列は取り消される", async () => {
    control({});
    let releaseVerify: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    const core = await boot(config({ maxConcurrentVerifications: 1, maxQueuedVerifications: 0 }), { stop: async (point) => (point === "afterAttestAdmission" ? blocked : undefined) });
    const envA = envelopeFor();
    const envB = envelopeFor("0".repeat(32) + "a".repeat(32));
    const qA = await quote(core, "r1", envA.b64);
    const qB = await quote(core, "r2", envB.b64);
    await purchase(core, qA, "r1");
    await purchase(core, qB, "r2");
    await waitFor(() => core.status(qA.paymentId, "alice", qA.ownerKey)?.status === "attesting" && core.status(qB.paymentId, "alice", qB.ownerKey)?.status === "attesting");
    const first = core.privateAttest(qA.paymentId, "alice", qA.ownerKey, bundleFor(envA.order));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await core.privateAttest(qB.paymentId, "alice", qB.ownerKey, bundleFor(envB.order))).toEqual({ ok: false, code: "private_capacity" });
    expect(core.status(qB.paymentId, "alice", qB.ownerKey)?.status).toBe("attesting");
    // drain: 実行中の検証は永続化せずに終わる（record は残り、再起動で unknown）。
    const closing = core.close();
    opened.pop();
    releaseVerify!();
    expect(await first).toEqual({ ok: false, code: "private_unavailable" });
    await closing;
    expect(events().filter((event) => event === "private_attested" || event === "unknown")).toEqual([]);
    const reopened = await boot();
    expect(reopened.status(qA.paymentId, "alice", qA.ownerKey)).toMatchObject({ status: "unknown", terminalReason: "interrupted_after_release", private: { artifacts: { record: "available" } } });
  }, 20_000);
});

describe("期限の検査 3 回（§3.2 8・9）", () => {
  test("起動前・addr 取得後・応答直前で sessionBy を越えていれば unknown/private_session_timeout（credential は返さない）", async () => {
    control({ mode: "hang" });
    for (const point of ["afterRelease", "afterSpawn", "afterHandoverJournal"] as const) {
      inbound = new SyntheticInbound();
      rail = new FakePrivateRail();
      let clock = Date.now();
      const core = await boot(config({ sessionTimeoutMs: 10_000, minSessionRemainingMs: 1_000 }), {
        now: () => clock,
        stop: async (p) => {
          if (p === point) clock += 60_000; // 期限を越える
        },
      });
      const q = await quote(core, "r1");
      const result = await purchase(core, q);
      expect(result, point).toMatchObject({ status: "unknown", terminalReason: "private_session_timeout" });
      expect(result.handover, point).toBeUndefined();
      expect(existsSync(path.join(privateDir, q.paymentId)), point).toBe(false);
      await core.close();
      opened.pop();
      rmSync(journalPath, { force: true });
      rmSync(path.join(workDir, "dynamic-quotes"), { recursive: true, force: true });
      ids = 0;
    }
  }, 30_000);
});

describe("record の保持・取得・壊れた record", () => {
  test("保持期限で削除され 410、再起動で延びない。壊れた record は返さない", async () => {
    control({});
    const core = await boot(config({ retentionMs: 2_000 }));
    const env = envelopeFor();
    const q = await quote(core, "r1", env.b64);
    await purchase(core, q);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "attesting");
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order))).toEqual({ ok: true, status: "delivered_private" });
    const until = core.status(q.paymentId, "alice", q.ownerKey)!.private!.artifacts.recordAvailableUntil!;
    // 壊れた record は配らない。
    const recordFile = path.join(privateDir, q.paymentId, "record.json");
    const original = readFileSync(recordFile);
    writeFileSync(recordFile, Buffer.concat([original, Buffer.from(" ")]));
    expect(core.privateRecord(q.paymentId, "alice", q.ownerKey)).toEqual({ ok: false, code: "record_corrupt" });
    writeFileSync(recordFile, original);
    expect(core.privateRecord(q.paymentId, "alice", q.ownerKey).ok).toBe(true);
    // 再起動しても保持期限は record の完成時刻から（延びない）。
    await core.close();
    opened.pop();
    const reopened = await boot(config({ retentionMs: 2_000 }));
    expect(reopened.status(q.paymentId, "alice", q.ownerKey)!.private!.artifacts.recordAvailableUntil).toBe(until);
    await waitFor(() => reopened.status(q.paymentId, "alice", q.ownerKey)?.private?.artifacts.record === "expired", 6_000);
    expect(reopened.privateRecord(q.paymentId, "alice", q.ownerKey)).toEqual({ ok: false, code: "record_expired" });
    expect(existsSync(path.join(privateDir, q.paymentId))).toBe(false);
    expect(events()).toContain("private_record_expired");
  }, 15_000);
});

describe("棚卸しの失敗・journal の失敗（fail closed）", () => {
  test("前世代の子を確認できなければ秘匿購入は閉じたまま（quote は private_unavailable、容量は取れない）", async () => {
    const core = await boot(config(), { runner: (base) => ({ ...base, inventory: async () => ({ ok: false, reason: "unverifiable_pid" }) }) });
    expect(await core.privateQuote({ principalId: "alice", requestId: "r1", profileId: PROFILE_ID, intentB64: envelopeFor().b64 })).toEqual({ ok: false, code: "private_unavailable" });
  });
  test("予約の後の journal の失敗: 固定の unknown を返し、以後の秘匿購入を止め、作業ディレクトリ（証拠）を消さない", async () => {
    control({});
    const core = await boot();
    const q = await quote(core, "r1");
    const probe = await openFile(path.join(workDir, "fsync-probe"), "a");
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    // 予約（private_issuance_reserved）の行の fsync を失敗させる → journal は以後の追記を拒む（毒された writer）。
    let failed = false;
    const spy = vi.spyOn(proto, "sync").mockImplementation(async function (this: { sync: () => Promise<void> }) {
      if (!failed && existsSync(journalPath) && readFileSync(journalPath, "utf8").includes('"private_issuance_reserved"')) {
        failed = true;
        throw new Error("fsync failed");
      }
    });
    try {
      const result = await purchase(core, q);
      expect(result).toMatchObject({ status: "unknown", terminalReason: "private_issuance_unknown" });
      expect(result.handover).toBeUndefined();
      expect(failed).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // 作業ディレクトリ（証拠）は消えていない。
    expect(existsSync(path.join(privateDir, q.paymentId))).toBe(true);
    // 以後は閉じる。証拠は残る。
    expect(await core.privateQuote({ principalId: "alice", requestId: "r2", profileId: PROFILE_ID, intentB64: envelopeFor("0".repeat(32) + "a".repeat(32)).b64 })).toEqual({ ok: false, code: "private_unavailable" });
    expect(rail.issueCalls).toBe(0);
  });
});

describe("canary の行列", () => {
  test("bearer は最終注文・record・引き渡しの応答にだけ、封筒は journal と Verifier の入力にだけ、射影には無い", async () => {
    control({});
    const core = await boot();
    const env = envelopeFor();
    const q = await quote(core, "r1", env.b64);
    const result = await purchase(core, q);
    expect(JSON.stringify(result.handover)).toContain(HEADER_VALUE);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "attesting");
    let scan = scanArtifacts(core, q.paymentId, q.ownerKey);
    expect(scan.journal).not.toContain(HEADER_VALUE);
    expect(scan.projection).not.toContain(HEADER_VALUE);
    expect(scan.projection).not.toContain(env.b64.slice(0, 24));
    expect(Object.keys(scan.files).sort()).toEqual(["fake-args.verifier-serve.json", "intent.json", "order_final.json", "record.json", "release.json", "serve.stderr.log", "serve.stdout.log", "verifier.addr"]);
    for (const [name, text] of Object.entries(scan.files)) {
      if (name === "order_final.json" || name === "record.json") expect(text, name).toContain(HEADER_VALUE);
      else expect(text, name).not.toContain(HEADER_VALUE);
    }
    expect(scan.files["intent.json"]).toBe(env.bytes.toString("latin1"));
    expect(scan.journal).toContain(env.b64); // created の private 欄（権威の保管）
    await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order));
    scan = scanArtifacts(core, q.paymentId, q.ownerKey);
    expect(Object.keys(scan.files)).toEqual(["record.json"]);
    expect(scan.journal).not.toContain(HEADER_VALUE);
    expect(scan.projection).not.toContain(HEADER_VALUE);
    // 要約は固定の値だけ（Provider の文字列を写さない）。
    expect(core.status(q.paymentId, "alice", q.ownerKey)!.private!.verifier).toEqual({ trust: "lab-fixture-ca", externalGate: false, serverName: "test-server.io", target: { host: "test-server.io", port: 443, path: "/select" }, requestLine: "POST /select HTTP/1.1", lenSent: expect.any(Number), bodyLen: 196, statusLine: "HTTP/1.1 200 OK", credLen: 39 });
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
    // 「クラッシュ」= drain: 止まっていた継続は closing を見て永続化せずに終わる（record は残る）。
    const closingCore = core.close();
    opened.pop();
    release!();
    await closingCore;
    expect(events()).not.toContain("private_recorded");
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
    const closingCore = core.close();
    opened.pop();
    release!();
    const outcome = await pending;
    await closingCore;
    // drain 中の継続は子を起動せず、耐久でない固定の unknown を返す（journal は private_released のまま）。
    expect(outcome).toMatchObject({ status: "unknown", terminalReason: "private_unavailable" });
    expect(events().at(-1)).toBe("private_released");
    const reopened = await boot();
    expect(reopened.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ status: "unknown", terminalReason: "interrupted_before_handover" });
    expect(existsSync(path.join(privateDir, q.paymentId))).toBe(false);
  });
});

describe("Codex 実装レビュー 2 回目の指摘（保持期限と検証の競合・領収の生ヘッダ・検証の例外・待ち行列の取り消し）", () => {
  test("保持期限が検証の最中（実行中・待ち行列）に来ても、入力と容量は検証の終わりまで残る。取得は 410、結果は永続化され、その後に掃除", async () => {
    // 検証（偽バイナリ）は 2.5 s、保持期限は record 完成から 1.2 s。1 枠なので 2 件目は待ち行列。
    control({ delayMs: 2_500 });
    const core = await boot(config({ retentionMs: 1_200, attestTimeoutMs: 20_000, verifyTimeoutMs: 10_000, maxConcurrentVerifications: 1, maxQueuedVerifications: 2 }));
    const envA = envelopeFor();
    const envB = envelopeFor("0".repeat(32) + "a".repeat(32));
    const qA = await quote(core, "r1", envA.b64);
    const qB = await quote(core, "r2", envB.b64);
    await purchase(core, qA, "r1");
    await purchase(core, qB, "r2");
    await waitFor(() => core.status(qA.paymentId, "alice", qA.ownerKey)?.status === "attesting" && core.status(qB.paymentId, "alice", qB.ownerKey)?.status === "attesting", 10_000);
    const attestA = core.privateAttest(qA.paymentId, "alice", qA.ownerKey, bundleFor(envA.order));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const attestB = core.privateAttest(qB.paymentId, "alice", qB.ownerKey, bundleFor(envB.order));
    // 保持期限が来る: 取得は 410（expired）になるが、ディレクトリと入力は残っている（検証が使う）。
    await waitFor(() => core.status(qA.paymentId, "alice", qA.ownerKey)?.private?.artifacts.record === "expired" && core.status(qB.paymentId, "alice", qB.ownerKey)?.private?.artifacts.record === "expired", 5_000);
    expect(core.privateRecord(qA.paymentId, "alice", qA.ownerKey)).toEqual({ ok: false, code: "record_expired" });
    expect(existsSync(path.join(privateDir, qA.paymentId, "bundle.json"))).toBe(true);
    expect(existsSync(path.join(privateDir, qB.paymentId, "record.json"))).toBe(true);
    expect(await attestA).toEqual({ ok: true, status: "delivered_private" });
    expect(await attestB).toEqual({ ok: true, status: "delivered_private" });
    // 検証の終わりで初めて掃除（ディレクトリごと）。容量も戻る（3 件目の購入が通る）。
    await waitFor(() => !existsSync(path.join(privateDir, qA.paymentId)) && !existsSync(path.join(privateDir, qB.paymentId)), 5_000);
    expect(core.status(qA.paymentId, "alice", qA.ownerKey)).toMatchObject({ status: "delivered_private", private: { artifacts: { record: "expired" } } });
    expect(events().filter((event) => event === "private_attested")).toHaveLength(2);
    const envC = envelopeFor("0".repeat(32) + "c".repeat(32));
    const qC = await quote(core, "r3", envC.b64);
    expect((await purchase(core, qC, "r3")).status).toBe("awaiting_session");
  }, 30_000);

  test("期限切れの record には attest できない（attest_closed、状態不変）", async () => {
    control({});
    const core = await boot(config({ retentionMs: 1_000, attestTimeoutMs: 20_000, verifyTimeoutMs: 5_000 }));
    const env = envelopeFor();
    const q = await quote(core, "r1", env.b64);
    await purchase(core, q);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.private?.artifacts.record === "expired", 5_000);
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order))).toEqual({ ok: false, code: "attest_closed" });
    expect(existsSync(path.join(privateDir, q.paymentId))).toBe(false);
  }, 15_000);

  test("Provider の領収ヘッダに反射された値は journal・射影に写らない（digest だけ）", async () => {
    const canary = "reflected-plaintext-canary-7f3a9c";
    const reflected = Buffer.from(JSON.stringify({ success: true, transaction: DST_TX, network: NETWORK, payer: "0xpayer", note: canary }), "utf8").toString("base64url");
    control({ receiptHeader: { name: "PAYMENT-RESPONSE", value: reflected } });
    rail.checkReceipt = (headerValue: string) => ({ ok: true, txRef: DST_TX, receiptRef: headerValue });
    const core = await boot();
    const env = envelopeFor();
    const q = await quote(core, "r1", env.b64);
    await purchase(core, q);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "attesting");
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order))).toEqual({ ok: true, status: "delivered_private" });
    const scan = scanArtifacts(core, q.paymentId, q.ownerKey);
    for (const text of [scan.journal, scan.projection]) {
      expect(text).not.toContain(reflected);
      expect(text).not.toContain(canary);
      // 符号化を解いても無い。
      for (const token of text.match(/[A-Za-z0-9_-]{40,}/g) ?? []) expect(Buffer.from(token, "base64url").toString("latin1")).not.toContain(canary);
    }
    expect(core.status(q.paymentId, "alice", q.ownerKey)?.private?.outbound).toMatchObject({ receiptSha256: createHash("sha256").update(reflected).digest("hex") });
    expect(core.status(q.paymentId, "alice", q.ownerKey)?.destination).not.toHaveProperty("receiptRef");
    // 原本は認証済みの record にだけ。
    expect(Buffer.from((core.privateRecord(q.paymentId, "alice", q.ownerKey) as { recordB64: string }).recordB64, "base64").toString("utf8")).toContain(reflected);
  });

  test("ランナーの verify が例外を投げても、受理した digest の結果として固定の unknown（private_verifier_unavailable）が永続化され、attesting のまま残らない（attestBy の前・後）", async () => {
    control({});
    for (const after of [false, true]) {
      inbound = new SyntheticInbound();
      rail = new FakePrivateRail();
      ids = 0;
      const core = await boot(config({ attestTimeoutMs: after ? 1_000 : 20_000, retentionMs: 60_000 }), {
        runner: (base) => ({
          ...base,
          verify: async () => {
            if (after) await new Promise((resolve) => setTimeout(resolve, 1_500));
            throw new Error("boom");
          },
        }),
      });
      const env = envelopeFor();
      const q = await quote(core, "r1", env.b64);
      await purchase(core, q);
      await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "attesting");
      const first = await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order));
      expect(first, `after=${after}`).toEqual({ ok: true, status: "unknown", terminalReason: "private_verifier_unavailable" });
      expect(core.status(q.paymentId, "alice", q.ownerKey), `after=${after}`).toMatchObject({ status: "unknown", terminalReason: "private_verifier_unavailable", private: { attest: { result: "unknown" }, artifacts: { record: "available" } } });
      // 同じ digest の再提出は耐久結果、別の digest は閉じている。record は取得できる。
      expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order))).toEqual({ ok: true, status: "unknown", terminalReason: "private_verifier_unavailable" });
      expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order, { payload_len: 197 }))).toEqual({ ok: false, code: "attest_closed" });
      expect(core.privateRecord(q.paymentId, "alice", q.ownerKey).ok).toBe(true);
      expect(readdirSync(path.join(privateDir, q.paymentId))).toEqual(["record.json"]);
      await core.close();
      opened.pop();
      rmSync(journalPath, { force: true });
      rmSync(path.join(workDir, "dynamic-quotes"), { recursive: true, force: true });
    }
  }, 30_000);

  test("drain は待ち行列の検証も取り消す（容量 1、待ち 1）: どちらも永続化せず、再起動で unknown/interrupted_after_release と record の取得", async () => {
    control({ delayMs: 3_000 });
    const core = await boot(config({ maxConcurrentVerifications: 1, maxQueuedVerifications: 1, verifyTimeoutMs: 10_000 }));
    const envA = envelopeFor();
    const envB = envelopeFor("0".repeat(32) + "a".repeat(32));
    const qA = await quote(core, "r1", envA.b64);
    const qB = await quote(core, "r2", envB.b64);
    await purchase(core, qA, "r1");
    await purchase(core, qB, "r2");
    await waitFor(() => core.status(qA.paymentId, "alice", qA.ownerKey)?.status === "attesting" && core.status(qB.paymentId, "alice", qB.ownerKey)?.status === "attesting", 10_000);
    const first = core.privateAttest(qA.paymentId, "alice", qA.ownerKey, bundleFor(envA.order));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = core.privateAttest(qB.paymentId, "alice", qB.ownerKey, bundleFor(envB.order));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const closing = core.close();
    opened.pop();
    expect(await second).toEqual({ ok: false, code: "private_unavailable" });
    expect(await first).toEqual({ ok: false, code: "private_unavailable" });
    await closing;
    expect(events()).not.toContain("private_attested");
    const reopened = await boot();
    for (const q of [qA, qB]) {
      expect(reopened.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ status: "unknown", terminalReason: "interrupted_after_release", private: { artifacts: { record: "available" } } });
      expect(reopened.privateRecord(q.paymentId, "alice", q.ownerKey).ok).toBe(true);
    }
  }, 30_000);
});

describe("Codex 実装レビュー 3 回目の指摘（timer の上限）", () => {
  test("Node の timer の上限（2^31−1 ms）を越える保持期限でも record は即座に満了しない（刻んで待ち、絶対時刻で判定する）", async () => {
    control({});
    const core = await boot(config({ retentionMs: 30 * 24 * 3_600_000, attestTimeoutMs: 20_000, verifyTimeoutMs: 5_000 }));
    const env = envelopeFor();
    const q = await quote(core, "r1", env.b64);
    await purchase(core, q);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "attesting");
    expect(await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(env.order))).toEqual({ ok: true, status: "delivered_private" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ status: "delivered_private", private: { artifacts: { record: "available" } } });
    expect(core.privateRecord(q.paymentId, "alice", q.ownerKey).ok).toBe(true);
    expect(existsSync(path.join(privateDir, q.paymentId, "record.json"))).toBe(true);
  });
});

