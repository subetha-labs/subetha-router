/**
 * 増分 v1.5（proxy 型）T-X6: core の配線（`docs/zktls-router-proxy-design.md` §4〜§10、要件 FR-X00〜FR-X13）。
 * 合成の受信 rail・偽の私的送信 rail・偽の宛先の固定・偽バイナリ（`fake-delivery.mjs`）で、quote → purchase（pin → verify → settle → 予約 → 発行 →
 * serve）→ session → attest → record の proxy 型の全経路、pin の失敗、型の照合、失敗通知、record の型の束縛、宛先の枠の寿命、移行を確かめる。資金は動かない。
 * 有効化（T-X8）の後: 既定は proxy 型、`mpcProfiles` に載せたプロファイルだけ MPC 型。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { open as openFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_DYNAMIC_LIMITS, DEFAULT_PRIVATE_CONFIG, type DynamicProfile, type RouterConfig } from "../../src/config.js";
import { stableJson } from "../../src/core/intent.js";
import { createRouterCore, type PrivateQuoteOutcome, type RouterCore } from "../../src/core/orchestrator.js";
import type { StopPoint } from "../../src/core/private.js";
import { parseAddress } from "../../src/net/destination-policy.js";
import { TransportError, type GuardedTransport, type TransportContext } from "../../src/net/guarded-fetch.js";
import type { PinnedDestination } from "../../src/net/pinned-destination.js";
import type { CreateOfferRequest, InboundOffer, InboundRail, PaymentCredential, PreflightResult, SettleResult } from "../../src/ports/inbound.js";
import type { DestinationOffer, OutboundRail, PayResult, UpstreamTarget } from "../../src/ports/outbound.js";
import type { IssueCredentialArgs, IssueOutcome, PrivateOutboundRail, ReceiptCheck } from "../../src/ports/private-outbound.js";
import { PROXY_RELAY_LIMITS } from "../../src/private/proxy.js";
import type { DiagCapture, DiagnosticsSink } from "../../src/shared/diagnostics.js";
import { createVerifierRunner, sha256File } from "../../src/private/verifier.js";

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
const HEADER_VALUE = "eyJ4NDAyVmVyc2lvbiI6MiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweGRlYWRiZWVmIn19";
const RECEIPT_VALUE = "eyJzdWNjZXNzIjp0cnVlLCJ0cmFuc2FjdGlvbiI6IjB4MTEifQ";
const DST_TX = `0x${"11".repeat(32)}`;
const PROVIDER_ADDR = "203.0.113.10:443";
const VETTED = "203.0.113.10";
const CIPHERTEXT_CANARY = "c1f3e2d4a5b6c7d8e9f0a1b2c3d4e5f6-proxy-ciphertext-canary";

const LAB_ORDER = (JSON.parse(readFileSync(path.join(goldenDir, "post-intent.json"), "utf8")) as { order: Record<string, unknown> }).order;
function envelopeFor(orderId = LAB_ORDER["order_id"] as string): { b64: string; order: Record<string, unknown> } {
  const order = { ...LAB_ORDER, order_id: orderId };
  const doc = { version: "phase5-intent-v1", order, outbound: { protocol: "x402", network: NETWORK, asset: USDC, payTo: PAY_TO, maxAmount: "10000" }, inbound: { network: NETWORK, asset: USDC, maxTotal: "11000" } };
  const bytes = Buffer.from(JSON.stringify(doc), "utf8");
  return { b64: bytes.toString("base64"), order };
}
const HOST = (LAB_ORDER["target"] as { host: string }).host;

function config(overrides: Partial<RouterConfig["private"] & {}> = {}): RouterConfig {
  return {
    approvalTtlMs: 120_000,
    routes: {},
    budget: { maxPurchases: 10, buckets: [{ network: NETWORK, asset: USDC, maxTotal: "10000000", maxPerPurchase: "200000" }] },
    dynamic: {
      enabled: true,
      profiles: { [PROFILE_ID]: PROFILE },
      budget: { maxPurchases: 20, buckets: [{ network: NETWORK, asset: USDC, maxTotal: "10000000", maxPerPurchase: "200000" }] },
      limits: { ...DEFAULT_DYNAMIC_LIMITS, quotesPerMinuteGlobal: 1000, quotesPerMinutePerSource: 1000, purchasesPerMinuteGlobal: 1000, purchasesPerMinutePerSource: 1000, perHostPerMinute: 1000, concurrentGlobal: 64, concurrentPerSource: 64, perHostConcurrent: 64 },
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
      mpcProfiles: [PROFILE_ID],
      ...overrides,
    },
  };
}
/** proxy 型の設定（既定 = `mpcProfiles` に載せない）。 */
const proxyConfig = (overrides: Partial<RouterConfig["private"] & {}> = {}): RouterConfig => config({ mpcProfiles: [], ...overrides });

class SyntheticInbound implements InboundRail {
  verifyCalls = 0;
  settleCalls = 0;
  #issued = 0;
  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.#issued += 1;
    return { scheme: "exact", network: request.network, asset: request.asset, amount: request.amount, payTo: "0xrouter", maxTimeoutSeconds: 120, extra: { challengeNonce: `0xnonce${this.#issued}`, expiresAt: Math.floor(request.nowMs / 1000) + 600, routeBinding: request.routeBinding, name: "USDC", version: "2" } };
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
    return { outcome: "settled", txRef: `0xsrc${this.settleCalls}`, eventId: `0xnonce-auth-${this.settleCalls}` };
  }
  credentialFor(offer: InboundOffer): PaymentCredential {
    return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, authorization: { nonce: "0x01" } } };
  }
}

class NeverOutbound implements OutboundRail {
  async readChallenge(): Promise<readonly DestinationOffer[]> {
    throw new Error("the static/dynamic outbound must not be used for private purchases");
  }
  async pay(): Promise<PayResult> {
    throw new Error("pay must not be called");
  }
}

class FakePrivateRail implements PrivateOutboundRail {
  readonly rail = "x402" as const;
  issueCalls = 0;
  offers: DestinationOffer[] = [OFFER];
  /** 探りごとに渡された transport（固定の宛先のものか、無し）。 */
  readonly probeTransports: (GuardedTransport | undefined)[] = [];
  /** 呼ばれた探りの番号で offer を変える（再照合の失敗の試験）。 */
  offersAt: (call: number) => DestinationOffer[] = () => this.offers;
  async discover(_profileId: string, _target: UpstreamTarget, options?: { readonly transport?: GuardedTransport }) {
    this.probeTransports.push(options?.transport);
    const offers = this.offersAt(this.probeTransports.length);
    return { offers, challenge: { accepts: offers } };
  }
  async issueCredential(_args: IssueCredentialArgs): Promise<IssueOutcome> {
    this.issueCalls += 1;
    return { ok: true, issued: { name: "PAYMENT-SIGNATURE", value: HEADER_VALUE, expiresAtMs: Date.now() + 120_000 } };
  }
  checkReceipt(headerValue: string): ReceiptCheck {
    return headerValue === RECEIPT_VALUE ? { ok: true, txRef: DST_TX, receiptRef: headerValue } : { ok: false, reason: "destination_receipt_unverified" };
  }
}

/** 偽の宛先の固定: 呼ばれた回数・枠の使用数・返却の回数を数える。`fail` で拒否。 */
class FakePinner {
  calls: { host: string; context: TransportContext }[] = [];
  inUse = 0;
  releases = 0;
  fail: TransportError | undefined;
  readonly transport: GuardedTransport = { allowLoopback: false, boundsDns: true, report: () => {}, fetch: async () => { throw new Error("the fake pinned transport is not used for HTTP"); } };
  pinDestination = async (host: string, context: TransportContext): Promise<PinnedDestination> => {
    this.calls.push({ host, context });
    if (this.fail !== undefined) throw this.fail;
    this.inUse += 1;
    let released = false;
    return {
      pin: { host, address: parseAddress(VETTED)! },
      vettedAddress: VETTED,
      dialAddr: PROVIDER_ADDR,
      transport: this.transport,
      release: () => {
        if (released) return;
        released = true;
        this.inUse -= 1;
        this.releases += 1;
      },
    };
  };
}

let workDir: string;
let journalPath: string;
let privateDir: string;
let inbound: SyntheticInbound;
let rail: FakePrivateRail;
let pinner: FakePinner;
let ids = 0;
const opened: RouterCore[] = [];

beforeEach(() => {
  mkdirSync(runtimeRoot, { recursive: true });
  workDir = mkdtempSync(path.join(runtimeRoot, "private-proxy-core-"));
  journalPath = path.join(workDir, "journal.ndjson");
  privateDir = path.join(workDir, "private");
  inbound = new SyntheticInbound();
  rail = new FakePrivateRail();
  pinner = new FakePinner();
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

async function boot(cfg: RouterConfig = proxyConfig(), extra: { stop?: (point: StopPoint, paymentId: string) => Promise<void>; withPinner?: boolean; diagnostics?: DiagnosticsSink } = {}): Promise<RouterCore> {
  const runner = createVerifierRunner({ deliveryBin: FAKE, srsPath: cfg.private!.srsPath, trust: "lab-fixture-ca", maxChildOutputBytes: cfg.private!.maxChildOutputBytes });
  const core = await createRouterCore({
    journalPath,
    config: cfg,
    inbound,
    outbound: new NeverOutbound(),
    nextPaymentId: () => `pay-${(ids += 1)}`,
    dynamic: { ledgerDir: path.join(workDir, "dynamic-quotes") },
    ...(extra.diagnostics === undefined ? {} : { diagnostics: extra.diagnostics }),
    private: {
      rails: { [PROFILE_ID]: rail },
      runner,
      trust: "lab-fixture-ca",
      workDir: privateDir,
      ...(extra.withPinner === false ? {} : { pinDestination: pinner.pinDestination }),
      ...(extra.stop === undefined ? {} : { hooksForTest: { stop: extra.stop } }),
    },
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
function rows(): { paymentId: string; event: string; patch: Record<string, unknown> }[] {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { paymentId: string; event: string; patch: Record<string, unknown> });
}
function events(): string[] {
  return rows().map((row) => row.event);
}
async function waitFor(predicate: () => boolean, ms = 8_000): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("timeout waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function serveArgs(paymentId: string): Record<string, string> {
  return (JSON.parse(readFileSync(path.join(privateDir, paymentId, "fake-args.verifier-serve.json"), "utf8")) as { kv: Record<string, string> }).kv;
}
function bundleFor(order: Record<string, unknown>): string {
  const request = order["request"] as Record<string, unknown>;
  const bundle = {
    public: { order_id: order["order_id"], payer_pk: order["payer_pk"], committed_hash_hex: "b".repeat(64), payload_len: 196 },
    proof_hex: "00",
    request: { public: { tls_body_hash_hex: "d".repeat(64), tls_cred_hash_hex: "c".repeat(64), payer_commitment_hex: request["body_commitment_hex"], body_len: request["body_len"], cred_len: 39 }, proof_hex: "00" },
  };
  return Buffer.from(JSON.stringify(bundle), "utf8").toString("base64");
}

describe("quote（FR-X02・FR-X03）", () => {
  test("proxy 型の quote は tls と開示 3 つを持ち、記録に tlsMode を写す。MPC 型の quote は今と同じ（欄が増えない）", async () => {
    const core = await boot();
    const q = await quote(core);
    expect(q.private).toMatchObject({ tls: { mode: "proxy", relay: { maxSentBytes: PROXY_RELAY_LIMITS.maxSentBytes, maxRecvBytes: PROXY_RELAY_LIMITS.maxRecvBytes } }, disclosures: { routerConnectsToProvider: true, providerSeesRouterAddress: true, trustsRouterProviderPath: true } });
    expect(core.status(q.paymentId, "alice", q.ownerKey)?.private).toMatchObject({ tls: { mode: "proxy", disclosures: { routerConnectsToProvider: true, providerSeesRouterAddress: true, trustsRouterProviderPath: true } } });
    // 予約の前は providerAddr を出さない（型と開示は出す）。
    expect(Object.hasOwn((core.status(q.paymentId, "alice", q.ownerKey)!.private as { tls: object }).tls, "providerAddr")).toBe(false);
    await opened.pop()!.close();

    const mpc = await boot(config());
    const m = await quote(mpc, "r-mpc");
    expect(Object.hasOwn(m.private, "tls")).toBe(false);
    for (const key of ["routerConnectsToProvider", "providerSeesRouterAddress", "trustsRouterProviderPath"]) expect(Object.hasOwn(m.private["disclosures"] as object, key)).toBe(false);
    expect(Object.hasOwn(mpc.status(m.paymentId, "alice", m.ownerKey)!.private!, "tls")).toBe(false);
  });
  test("proxy 型のプロファイルがあるのに宛先の固定が無ければ core は作れない（構成の誤り）", async () => {
    await expect(boot(proxyConfig(), { withPinner: false })).rejects.toThrow(/proxy-mode profiles require pinDestination/);
  });
});

describe("purchase の全経路（proxy 型）", () => {
  test("pin → 探り 2 回は固定の transport → 予約の行に宛先 → serve に proxy の引数 → record → attest で delivered_private。枠は子が生きている間 1、終了で 0、返却は 1 回", async () => {
    const core = await boot();
    const q = await quote(core);
    control({ delayMs: 600 });
    const p = await purchase(core, q);
    expect(p, JSON.stringify(p)).toMatchObject({ status: "awaiting_session" });
    expect(pinner.calls).toEqual([{ host: HOST, context: { operation: "private_proxy_pin", routeId: PROFILE_ID } }]);
    // quote の探り（固定の前）は transport 無し、purchase の探り 2 回（verify の前・発行の前）は固定の transport。
    expect(rail.probeTransports).toEqual([undefined, pinner.transport, pinner.transport]);
    const reserved = rows().find((row) => row.event === "private_issuance_reserved")!;
    expect(reserved.patch["proxy"]).toEqual({ providerAddr: PROVIDER_ADDR, vettedAddress: VETTED });
    const args = serveArgs(q.paymentId);
    expect(args).toMatchObject({ "tls-mode": "proxy", "provider-addr": PROVIDER_ADDR, "max-relay-sent": String(PROXY_RELAY_LIMITS.maxSentBytes), "max-relay-recv": String(PROXY_RELAY_LIMITS.maxRecvBytes) });
    expect(pinner.inUse).toBe(1); // 子が生きている間は持つ。
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "attesting");
    expect(pinner.inUse).toBe(0);
    expect(pinner.releases).toBe(1);
    expect(core.status(q.paymentId, "alice", q.ownerKey)?.private).toMatchObject({ tls: { mode: "proxy", providerAddr: PROVIDER_ADDR } });
    const attested = await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(envelopeFor().order));
    expect(attested, JSON.stringify(attested)).toMatchObject({ ok: true, status: "delivered_private" });
    expect(rail.issueCalls).toBe(1);
    expect([inbound.verifyCalls, inbound.settleCalls]).toEqual([1, 1]);
    expect(pinner.releases).toBe(1);
  });
  test("MPC 型の購入は pin を呼ばず、serve の引数に proxy が無く、予約の行も今と同じ", async () => {
    const core = await boot(config());
    const q = await quote(core);
    control({});
    expect(await purchase(core, q)).toMatchObject({ status: "awaiting_session" });
    expect(pinner.calls).toEqual([]);
    expect(rail.probeTransports).toEqual([undefined, undefined, undefined]);
    expect(Object.hasOwn(rows().find((row) => row.event === "private_issuance_reserved")!.patch, "proxy")).toBe(false);
    const args = serveArgs(q.paymentId);
    for (const key of ["tls-mode", "provider-addr", "max-relay-sent", "max-relay-recv"]) expect(Object.hasOwn(args, key)).toBe(false);
  });
});

describe("pin の失敗（FR-X06）", () => {
  test.each(["destination_blocked", "dns_failed", "admission_refused", "connect_failed"] as const)("%s: 受信 verify・settle 0 回、予約 0 行、発行 0 回で awaiting_payment（private_proxy_dial_refused）", async (code) => {
    const core = await boot();
    const q = await quote(core);
    pinner.fail = new TransportError(code, { operation: "private_proxy_pin" });
    const p = await purchase(core, q);
    expect(p).toMatchObject({ status: "awaiting_payment", code: "private_proxy_dial_refused" });
    expect([inbound.verifyCalls, inbound.settleCalls, rail.issueCalls]).toEqual([0, 0, 0]);
    expect(events()).not.toContain("private_issuance_reserved");
    expect(events()).not.toContain("source_settled");
    expect(pinner.inUse).toBe(0);
  });
});

describe("宛先の枠の返却（設計 §4.3）", () => {
  test("settle の前の出口（探りの offer が変わった）: 容量と同じく dynamic core の finally で返す", async () => {
    const core = await boot();
    const q = await quote(core);
    rail.offersAt = (call) => (call === 2 ? [{ ...OFFER, amount: "9999" }] : [OFFER]);
    const p = await purchase(core, q);
    expect(p).toMatchObject({ status: "awaiting_payment", code: "offer_changed" });
    expect(inbound.settleCalls).toBe(0);
    expect([pinner.inUse, pinner.releases]).toEqual([0, 1]);
  });
  test("settle の後・予約の前の出口（2 回目の再照合で offer が変わった）: deliver の出口で返す（paid_undelivered、発行なし）", async () => {
    const core = await boot();
    const q = await quote(core);
    rail.offersAt = (call) => (call === 3 ? [{ ...OFFER, amount: "9999" }] : [OFFER]);
    const p = await purchase(core, q);
    expect(p).toMatchObject({ status: "paid_data_unavailable", terminalReason: "offer_changed" });
    expect(rail.issueCalls).toBe(0);
    expect([pinner.inUse, pinner.releases]).toEqual([0, 1]);
  });
  test("予約の後の出口（Verifier が addr を出さずに終わる）: unknown で返す", async () => {
    const core = await boot();
    const q = await quote(core);
    control({ mode: "fail-before-addr" });
    const p = await purchase(core, q);
    expect(p.status).toBe("unknown");
    expect([pinner.inUse, pinner.releases]).toEqual([0, 1]);
  });
  test("close（drain）: 子が生きている購入の枠も、子を止めた後に返す", async () => {
    const core = await boot();
    const q = await quote(core);
    control({ mode: "hang" });
    expect(await purchase(core, q)).toMatchObject({ status: "awaiting_session" });
    expect(pinner.inUse).toBe(1);
    await opened.pop()!.close();
    expect([pinner.inUse, pinner.releases]).toEqual([0, 1]);
  });
});

describe("失敗通知（FR-X08、LX-7）", () => {
  test.each<[string, Record<string, unknown>, string]>([
    ["接続の失敗", { mode: "failure-notice", failureReason: "proxy_dial_failed" }, "private_proxy_dial_failed"],
    ["サーバー名の不一致", { mode: "failure-notice", failureReason: "proxy_server_name_mismatch" }, "private_proxy_server_name_mismatch"],
    ["中継の上限", { mode: "failure-notice", failureReason: "proxy_limit" }, "private_proxy_limit"],
    ["未知の語", { mode: "failure-notice", failureReason: "proxy_other" }, "private_session_timeout"],
    ["他のキー", { mode: "failure-notice", failureBody: '{"reason":"proxy_limit","detail":"x"}' }, "private_session_timeout"],
    ["JSON でない", { mode: "failure-notice", failureBody: "proxy_limit" }, "private_session_timeout"],
    ["大きすぎる", { mode: "failure-notice", failureBody: JSON.stringify({ reason: "proxy_limit" }).padEnd(300, " ") }, "private_session_timeout"],
    ["record と両方（排他が破られた）", { mode: "failure-and-record", failureReason: "proxy_limit" }, "private_session_timeout"],
  ])("%s → %s。発行は 1 回のまま、record は残さない", async (_name, ctl, reason) => {
    const core = await boot();
    const q = await quote(core);
    control(ctl);
    expect(await purchase(core, q)).toMatchObject({ status: "awaiting_session" });
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "unknown");
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ status: "unknown", terminalReason: reason });
    expect(rail.issueCalls).toBe(1);
    expect(events()).not.toContain("private_recorded");
    expect(pinner.calls).toHaveLength(1);
    expect([pinner.inUse, pinner.releases]).toEqual([0, 1]);
  });
  test("MPC 型の購入の失敗通知は読まない（private_session_timeout）", async () => {
    const core = await boot(config());
    const q = await quote(core);
    control({ mode: "failure-notice", failureReason: "proxy_limit" });
    await purchase(core, q);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "unknown");
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ terminalReason: "private_session_timeout" });
  });
  test("Router の期限で止めた後に書かれた通知は読まない（private_session_timeout）", async () => {
    const core = await boot(proxyConfig({ sessionTimeoutMs: 1_600, minSessionRemainingMs: 500 }));
    const q = await quote(core);
    control({ mode: "failure-after-delay-hang", delayMs: 400 });
    await purchase(core, q);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "unknown");
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ terminalReason: "private_session_timeout" });
    expect([pinner.inUse, pinner.releases]).toEqual([0, 1]);
  });
});

describe("record の型の束縛（FR-X09）", () => {
  test.each<[string, Record<string, unknown>]>([
    ["tls_mode の欠落", { recordTlsMode: null }],
    ["provider_addr の欠落", { recordProviderAddr: null }],
    ["provider_addr のすり替え", { recordProviderAddr: "198.51.100.1:443" }],
  ])("proxy 型の購入で %s → record を保持せず private_session_timeout", async (_name, ctl) => {
    const core = await boot();
    const q = await quote(core);
    control(ctl);
    await purchase(core, q);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "unknown");
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ terminalReason: "private_session_timeout" });
    expect(events()).not.toContain("private_recorded");
  });
  test("MPC 型の購入に proxy 型の record（tls_mode あり）→ record を保持せず private_session_timeout", async () => {
    const core = await boot(config());
    const q = await quote(core);
    control({ recordTlsMode: "proxy", recordProviderAddr: PROVIDER_ADDR });
    await purchase(core, q);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "unknown");
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ terminalReason: "private_session_timeout" });
  });
});

describe("型の照合（§8.1）と移行（FR-X00）", () => {
  function ledgerFile(): string {
    const dir = path.join(workDir, "dynamic-quotes");
    const name = readdirSync(dir).find((entry) => entry.endsWith(".ndjson"));
    if (name === undefined) throw new Error(`no ledger file in ${readdirSync(dir).join(",")}`);
    return path.join(dir, name);
  }
  function rewriteLedger(edit: (record: Record<string, unknown>) => void): void {
    const file = ledgerFile();
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line !== "").map((line) => {
      const value = JSON.parse(line) as { kind: string; record?: Record<string, unknown> };
      if (value.kind === "quote" && value.record !== undefined) edit(value.record);
      return JSON.stringify(value);
    });
    writeFileSync(file, `${lines.join("\n")}\n`);
  }
  test("proxy 型の quote の記録から tlsMode だけを消すと（指紋は一致のまま）、purchase は quote_changed（受信 verify 0 回）", async () => {
    const first = await boot();
    const q = await quote(first);
    await opened.pop()!.close();
    rewriteLedger((record) => {
      delete (record["private"] as Record<string, unknown>)["tlsMode"];
    });
    const core = await boot();
    const p = await purchase(core, q);
    expect(p).toMatchObject({ status: "awaiting_payment", code: "quote_changed" });
    expect([inbound.verifyCalls, pinner.calls.length]).toEqual([0, 0]);
  });
  test("MPC 型の quote の記録に tlsMode を足すと（MPC 型の設定）、purchase は quote_changed", async () => {
    const first = await boot(config());
    const q = await quote(first);
    await opened.pop()!.close();
    rewriteLedger((record) => {
      (record["private"] as Record<string, unknown>)["tlsMode"] = "proxy";
    });
    const core = await boot(config());
    expect(await purchase(core, q)).toMatchObject({ status: "awaiting_payment", code: "quote_changed" });
    expect(inbound.verifyCalls).toBe(0);
  });
  test("移行: MPC 型の設定で発行した quote は、proxy 既定に変わると quote_changed、mpcProfiles に載せればそのまま買える", async () => {
    const first = await boot(config());
    const q1 = await quote(first, "r1");
    const q2 = await quote(first, "r2", envelopeFor(`${"0".repeat(48)}${"1".padStart(16, "0")}`).b64);
    await opened.pop()!.close();
    const proxyDefault = await boot(proxyConfig());
    expect(await purchase(proxyDefault, q1, "r1")).toMatchObject({ status: "awaiting_payment", code: "quote_changed" });
    expect(inbound.verifyCalls).toBe(0);
    await opened.pop()!.close();
    const listed = await boot(proxyConfig({ mpcProfiles: [PROFILE_ID] }));
    control({});
    expect(await purchase(listed, q2, "r2")).toMatchObject({ status: "awaiting_session" });
    expect(pinner.calls).toEqual([]);
  });
  test("移行: バイナリの sha256 が変われば mpcProfiles に載っていても quote_changed", async () => {
    const first = await boot(config());
    const q = await quote(first);
    await opened.pop()!.close();
    const changed = await boot(proxyConfig({ mpcProfiles: [PROFILE_ID], deliveryBinSha256: "0".repeat(64) }));
    expect(await purchase(changed, q)).toMatchObject({ status: "awaiting_payment", code: "quote_changed" });
    expect(inbound.verifyCalls).toBe(0);
  });
  test("移行: release 済みの MPC 型の購入を proxy 既定の設定で再起動して開くと、MPC 型のまま基礎の規則で unknown、pin・発行は増えない", async () => {
    // release の後で止めて drain する（既存の試験と同じ手口: journal は private_released のまま → 再起動で interrupted_before_handover）。
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await boot(config(), { stop: async (point) => (point === "afterRelease" ? blocked : undefined) });
    const q = await quote(first);
    control({});
    const pending = purchase(first, q);
    await waitFor(() => events().includes("private_released"));
    const closingCore = first.close();
    opened.pop();
    release!();
    await pending;
    await closingCore;
    const issued = rail.issueCalls;
    const core = await boot(proxyConfig());
    const status = core.status(q.paymentId, "alice", q.ownerKey);
    expect(status?.status).toBe("unknown");
    expect(status?.terminalReason).toMatch(/^interrupted_/);
    expect(Object.hasOwn(status!.private!, "tls")).toBe(false);
    expect(pinner.calls).toEqual([]);
    expect(rail.issueCalls).toBe(issued);
  });
});

/** 診断の sink（積んだものを全部持つ）。 */
function capturingSink(): { sink: DiagnosticsSink; text: () => string } {
  const captured: DiagCapture[] = [];
  return { sink: { emit: (capture) => void captured.push(capture) }, text: () => JSON.stringify(captured) };
}
function filesIn(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (existsSync(dir)) for (const name of readdirSync(dir)) files[name] = readFileSync(path.join(dir, name), "latin1");
  return files;
}

describe("秘匿（§10）", () => {
  test("成功: 束縛された record と子の出力に暗号文の canary があっても、journal・射影・診断に写さない。attest の後に残るのは record だけ", async () => {
    const diag = capturingSink();
    const core = await boot(proxyConfig(), { diagnostics: diag.sink });
    const q = await quote(core);
    control({ printCanary: CIPHERTEXT_CANARY, recordExtra: { relay_ciphertext_hex: CIPHERTEXT_CANARY } });
    expect((await purchase(core, q)).status).toBe("awaiting_session");
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "attesting");
    const dir = path.join(privateDir, q.paymentId);
    const during = filesIn(dir);
    // canary は lab の出力（子の stdout/stderr の保存先）と lab の record にだけある（そこに書かないのは lab の義務 LX-3。実バイナリは wire で見る）。
    expect(during["record.json"]).toContain(CIPHERTEXT_CANARY);
    expect(during["serve.stdout.log"]).toContain(CIPHERTEXT_CANARY);
    for (const [name, text] of Object.entries(during)) {
      if (!["record.json", "serve.stdout.log", "serve.stderr.log"].includes(name)) expect(text, name).not.toContain(CIPHERTEXT_CANARY);
    }
    const attested = await core.privateAttest(q.paymentId, "alice", q.ownerKey, bundleFor(envelopeFor().order));
    expect(attested).toMatchObject({ ok: true, status: "delivered_private" });
    expect(Object.keys(filesIn(dir))).toEqual(["record.json"]);
    for (const surface of [readFileSync(journalPath, "utf8"), JSON.stringify(core.status(q.paymentId, "alice", q.ownerKey)), diag.text()]) {
      expect(surface).not.toContain(CIPHERTEXT_CANARY);
      expect(surface).not.toContain(HEADER_VALUE);
    }
  });
  test("失敗（失敗通知）: 子の出力に canary があっても journal・射影・診断に写さず、作業ディレクトリは残さない", async () => {
    const diag = capturingSink();
    const core = await boot(proxyConfig(), { diagnostics: diag.sink });
    const q = await quote(core);
    control({ mode: "failure-notice", failureReason: "proxy_limit", printCanary: CIPHERTEXT_CANARY });
    await purchase(core, q);
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "unknown");
    expect(existsSync(path.join(privateDir, q.paymentId))).toBe(false);
    for (const surface of [readFileSync(journalPath, "utf8"), JSON.stringify(core.status(q.paymentId, "alice", q.ownerKey)), diag.text()]) {
      expect(surface).not.toContain(CIPHERTEXT_CANARY);
      expect(surface).not.toContain(HEADER_VALUE);
    }
  });
});

describe("競合と永続化の失敗（設計 §4.3・§6）", () => {
  test("子が先に終わり、payment の lock を握ったまま期限を越えても: 枠は子の終了で即座に 1 回だけ返し、理由は失敗通知のまま", async () => {
    let releaseLock: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let entered = false;
    const core = await boot(proxyConfig({ sessionTimeoutMs: 2_000, minSessionRemainingMs: 500 }), {
      stop: async (point) => {
        if (point !== "sessionExitLocked") return;
        entered = true;
        await held;
      },
    });
    const q = await quote(core);
    control({ mode: "failure-notice", failureReason: "proxy_server_name_mismatch", delayMs: 200 });
    const p = await purchase(core, q);
    expect(p.status).toBe("awaiting_session");
    await waitFor(() => entered);
    // lock の中で止まっている間に、枠は返っている（lock を待たない）。
    expect([pinner.inUse, pinner.releases]).toEqual([0, 1]);
    // 期限（sessionBy）を越えるまで lock を握る: timer は子の終了を見て何もしない。
    const sessionBy = (core.status(q.paymentId, "alice", q.ownerKey)!.private!.deadlines as { sessionBy: number }).sessionBy;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, sessionBy - Date.now()) + 300));
    releaseLock!();
    await waitFor(() => core.status(q.paymentId, "alice", q.ownerKey)?.status === "unknown");
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ terminalReason: "private_proxy_server_name_mismatch" });
    expect([pinner.inUse, pinner.releases]).toEqual([0, 1]);
  });
  test("予約の行の永続化の失敗（固定の unknown・受付を閉じる）でも枠は返す", async () => {
    const core = await boot();
    const q = await quote(core);
    control({});
    const probe = await openFile(path.join(workDir, "fsync-probe"), "a");
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    let failed = false;
    const spy = vi.spyOn(proto, "sync").mockImplementation(async function () {
      if (!failed && existsSync(journalPath) && readFileSync(journalPath, "utf8").includes('"private_issuance_reserved"')) {
        failed = true;
        throw new Error("fsync failed");
      }
    });
    try {
      expect(await purchase(core, q)).toMatchObject({ status: "unknown", terminalReason: "private_issuance_unknown" });
    } finally {
      spy.mockRestore();
    }
    expect(failed).toBe(true);
    expect(rail.issueCalls).toBe(0);
    expect([pinner.inUse, pinner.releases]).toEqual([0, 1]);
  });
});

describe("再起動の移行（FR-X00、要件 TR-X1）", () => {
  test("settle の後・予約の前の MPC 型の購入を proxy 既定の設定で開くと paid_undelivered（interrupted_at_restart）、pin・発行は 0", async () => {
    const first = await boot(config());
    const q = await quote(first);
    control({ mode: "hang" });
    await purchase(first, q);
    await opened.pop()!.close();
    // journal を source_settled の行まで切り詰める（予約の前に止まった状態）。
    const text = readFileSync(journalPath, "utf8").split("\n").filter((line) => line !== "");
    const cut = text.findIndex((line) => (JSON.parse(line) as { event: string }).event === "source_settled");
    writeFileSync(journalPath, `${text.slice(0, cut + 1).join("\n")}\n`);
    const issued = rail.issueCalls;
    const core = await boot(proxyConfig());
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ status: "paid_data_unavailable", terminalReason: "interrupted_at_restart" });
    expect([pinner.calls.length, rail.issueCalls - issued]).toEqual([0, 0]);
  });
  test("record のある MPC 型の購入を proxy 既定の設定で開くと、MPC 型のまま unknown（interrupted_after_release）で record は取得できる", async () => {
    const first = await boot(config());
    const q = await quote(first);
    control({});
    await purchase(first, q);
    await waitFor(() => first.status(q.paymentId, "alice", q.ownerKey)?.status === "attesting");
    await opened.pop()!.close();
    const core = await boot(proxyConfig());
    const status = core.status(q.paymentId, "alice", q.ownerKey)!;
    expect(status).toMatchObject({ status: "unknown", terminalReason: "interrupted_after_release", private: { artifacts: { record: "available" } } });
    expect(Object.hasOwn(status.private!, "tls")).toBe(false);
    expect(core.privateRecord(q.paymentId, "alice", q.ownerKey)).toMatchObject({ ok: true });
    expect(pinner.calls).toEqual([]);
  });
  test("proxy 型の購入を再起動で開くと、型と固定した宛先は射影に残り、pin・発行は増えない", async () => {
    const first = await boot();
    const q = await quote(first);
    control({ mode: "hang" });
    await purchase(first, q);
    await opened.pop()!.close();
    const pins = pinner.calls.length;
    const issued = rail.issueCalls;
    const core = await boot();
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ status: "unknown", terminalReason: "interrupted_after_release", private: { tls: { mode: "proxy", providerAddr: PROVIDER_ADDR } } });
    expect([pinner.calls.length - pins, rail.issueCalls - issued]).toEqual([0, 0]);
  });
  test("再起動は失敗通知を読まない（基礎の規則: interrupted_after_release）", async () => {
    let releaseLock: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let entered = false;
    const first = await boot(proxyConfig(), {
      stop: async (point) => {
        if (point !== "sessionExitLocked") return;
        entered = true;
        await held;
      },
    });
    const q = await quote(first);
    control({ mode: "failure-notice", failureReason: "proxy_limit" });
    await purchase(first, q);
    await waitFor(() => entered);
    // 終了の処理の途中で drain（closing の後の終了の処理は永続化しない）→ 再起動。
    const closing = first.close();
    opened.pop();
    releaseLock!();
    await closing;
    // drain は record の無い作業ディレクトリを消す。クラッシュで成果物が残った状態を作るため、失敗通知を置き直す。
    mkdirSync(path.join(privateDir, q.paymentId), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(privateDir, q.paymentId, "failure.json"), JSON.stringify({ reason: "proxy_limit" }), { mode: 0o600 });
    const core = await boot();
    expect(core.status(q.paymentId, "alice", q.ownerKey)).toMatchObject({ status: "unknown", terminalReason: "interrupted_after_release" });
    expect(existsSync(path.join(privateDir, q.paymentId))).toBe(false);
  });
});
