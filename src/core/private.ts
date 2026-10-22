/**
 * 秘匿購入の core（`docs/zktls-router-design.md` §3、要件 FR-Z01〜Z04・Z06〜Z09・Z15・Z25・Z27）。
 *
 * 動的購入（`dynamic.ts`）と同じ構えで、**別の core**。受信レグは dynamic の段をそのまま使い（`createDynamicCore` の `private` 依存として
 * `outboundFor`・`reserveCapacity`・`deliver` を渡す）、受信成立の後の継続（再照合 → 発行予約 → 発行 → release → Verifier 起動 → handover）、
 * セッションの監督と record、attest の受付手順、record の取得と保持、再起動の再構成をここが持つ。
 *
 * Router が見るもの: intent（commitment を含む）、402 ヘッダ、受信 credential、bundle、record。見ないもの: 本文・salt・穴の nonce・Payer 鍵・応答本文。
 * credential の値は作業ディレクトリの `order_final.json`（0600、attest の完了で削除）と `record.json`（0600、保持期限まで）と認証済みの応答にだけ存在する。
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { dynamicAuthoritativeTermsOf, privateAuthoritativeTermsOf, resolveProfile, usesGasIndexedFee, type DynamicProfile, type PrivateConfig, type RouterConfig } from "../config.js";
import { parseUpstreamUrl } from "../net/upstream-url.js";
import type { InboundRail } from "../ports/inbound.js";
import type { DestinationOffer, FeeEstimate, UpstreamTarget } from "../ports/outbound.js";
import type { IssuedCredential, PrivateDiscovery, PrivateOutboundRail } from "../ports/private-outbound.js";
import { checkAttest, checkBundleBinding, maxPaymentValueOf, MAX_SENT_BYTES, parseBundlePublic, parseRecvHeaders, parseVerifierRecord, parseVerifyResult, recordCompletedAtMsOf, requestLengthBoundOf, validatePaymentHeader, type VerifierRecord } from "../private/attest.js";
import { finalOrderBytesOf, headerFileOf, parseIntent, type IntentOrder, type ParsedIntent } from "../private/intent.js";
import { releaseBytesOf } from "../private/release.js";
import { readBounded, type Child, type VerifierRunner } from "../private/verifier.js";
import type { DynamicGate, GateLease } from "./dynamic-gate.js";
import { capOf, ownerKeyHashOf, ownerKeyMatches, perPurchaseLimitOf, priceOf, reservationOf, type DynamicPricing, type DynamicPurchaseOutcome } from "./dynamic.js";
import { fingerprintOf, stableJson, type Intent, type IntentPrivate } from "./intent.js";
import { LedgerDuplicateError, LedgerRecordTooLargeError, type QuoteLedger } from "./quote-ledger.js";
import { PrivateCapacity, purchaseAllowanceOf, RECORD_FILE, type CapacityLease } from "./private-capacity.js";
import type { PurchaseDiagnostics } from "./purchase-diagnostics.js";
import { intentFromCreated, privateBindingOf, type IntentStore } from "./store.js";

const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,29})$/;
const PROBE_BODY = "{}";
const PROBE_BODY_SHA256 = createHash("sha256").update(PROBE_BODY, "utf8").digest("hex");
/** Node の setTimeout の上限（2^31−1 ms ≈ 24.8 日）。 */
const MAX_TIMER_MS = 2_147_483_647;
const INTENT_FILE = "intent.json";
const RELEASE_FILE = "release.json";
const ORDER_FINAL_FILE = "order_final.json";
const BUNDLE_FILE = "bundle.json";
const READY_WAIT_MS = 5_000;

export type StopPoint =
  | "afterReserve"
  | "afterRelease"
  | "afterLaunchGate"
  | "afterSpawn"
  | "afterHandoverJournal"
  | "afterRecordPublish"
  | "afterAttestAdmission"
  | "beforeResultPersist"
  | "duringRecoveryInventory";

/** 試験専用の停止点（`docs/zktls-router-design.md` §11）。本番の入口は渡さない。検査の順序は変えない。 */
export interface PrivateHooksForTest {
  stop?(point: StopPoint, paymentId: string): Promise<void>;
}

export interface PrivateQuoteRequest {
  readonly principalId: string;
  readonly requestId: string;
  readonly profileId: string;
  readonly intentB64: string;
  readonly source: string;
}

export interface PrivateQuoteFields {
  readonly private: Record<string, unknown>;
  readonly pricing: DynamicPricing;
  readonly sourceRail: "x402" | "mpp" | "subetha";
  readonly rail: "x402" | "mpp";
  readonly ownerKey: string;
}

export type PrivateQuoteOutcome = { readonly ok: true; readonly intent: Intent; readonly fields: PrivateQuoteFields } | { readonly ok: false; readonly code: string; readonly reason?: string };

export interface HandoverView {
  readonly verifier: { readonly address: string };
  readonly releasedHeader: { readonly name: string; readonly value: string };
  readonly headerFile: { readonly order_id: string; readonly intent_sha256: string; readonly name: string; readonly value: string };
  readonly releaseB64: string;
  readonly release: unknown;
  readonly deadlines: { readonly credentialExpiresAt: number; readonly sessionBy: number };
}

export type AttestOutcome =
  | { readonly ok: true; readonly status: "delivered_private" | "unknown"; readonly terminalReason?: string }
  | { readonly ok: false; readonly code: "not_found" | "invalid_bundle" | "bundle_too_large" | "attest_closed" | "attest_not_ready" | "attest_in_progress" | "attest_expired" | "attest_foreign" | "private_capacity" | "private_unavailable" };

export type RecordOutcome =
  | { readonly ok: true; readonly recordB64: string; readonly releaseB64: string; readonly recordAvailableUntil: number }
  | { readonly ok: false; readonly code: "not_found" | "record_not_available" | "record_expired" | "record_corrupt" };

export interface OutboundRead {
  readChallenge(profileId: string, target: UpstreamTarget): Promise<readonly DestinationOffer[]>;
  estimateFee?(profileId: string, offer: DestinationOffer, target: UpstreamTarget): Promise<FeeEstimate>;
}

export interface PrivateCoreOptions {
  readonly config: RouterConfig;
  readonly store: IntentStore;
  readonly ledger: QuoteLedger;
  readonly gate: DynamicGate;
  readonly inbound: InboundRail;
  readonly rails: Readonly<Record<string, PrivateOutboundRail>>;
  readonly runner: VerifierRunner;
  readonly trust: "mozilla" | "lab-fixture-ca";
  readonly now: () => number;
  readonly nextPaymentId: () => string;
  readonly note?: ((message: string) => void) | undefined;
  readonly hooksForTest?: PrivateHooksForTest | undefined;
  /** 作業ディレクトリ（既定は設定の `workDir`）。試験が差し替える。 */
  readonly workDir?: string;
}

export interface PrivateCore {
  /** 再構成（起動門の取り消し → 棚卸し → record の回収 → 掃除 → 容量の再構成）。`createRouterCore` が store の load の後・公開の前に 1 回待つ。 */
  start(): Promise<void>;
  /** 棚卸しが確認できなかった等で受付を閉じているか。 */
  readonly unavailable: boolean;
  quote(request: PrivateQuoteRequest): Promise<PrivateQuoteOutcome>;
  /** dynamic core に渡す依存。 */
  readonly dynamicDeps: {
    isPrivate(intent: Intent): boolean;
    outboundFor(intent: Intent): OutboundRead;
    reserveCapacity(intent: Intent): CapacityLease | undefined;
    deliver(paymentId: string, diag: PurchaseDiagnostics, lease: CapacityLease | undefined): Promise<DynamicPurchaseOutcome>;
    routeFingerprintOf(profile: DynamicProfile): string;
  };
  attest(paymentId: string, principalId: string, ownerKey: string | undefined, bundleB64: string): Promise<AttestOutcome>;
  record(paymentId: string, principalId: string, ownerKey: string | undefined): RecordOutcome;
  /** 直近の handover の応答（purchase の応答に載せる。値は保持しない: 応答に写した後に捨てる）。 */
  takeHandover(paymentId: string): HandoverView | undefined;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** ファイルとその親ディレクトリを fsync（record の公開を耐久化してから journal に書く。設計 §3.3）。 */
function fsyncFileAndDir(file: string): void {
  for (const target of [file, path.dirname(file)]) {
    const fd = openSync(target, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

function orderOf(priv: IntentPrivate): IntentOrder {
  return {
    order_id: priv.orderId,
    payer_pk: priv.payerPk,
    curve: "grumpkin",
    target: priv.target,
    request: {
      framing: priv.framing,
      method: priv.method,
      content_type: priv.method === "POST" ? "application/json" : "",
      body_len: priv.bodyLen,
      body_commitment_hex: priv.bodyCommitmentHex,
      executor_header: priv.executorHeader,
      max_executor_value_len: priv.maxExecutorValueLen,
    },
  };
}

function probeTargetOf(priv: Pick<IntentPrivate, "method" | "target">): UpstreamTarget {
  const url = `https://${priv.target.host}${priv.target.path}`;
  return priv.method === "POST" ? { url, method: "POST", body: PROBE_BODY } : { url, method: "GET" };
}

export function createPrivateCore(options: PrivateCoreOptions): PrivateCore {
  const { store, ledger, gate, inbound, rails, runner, now, note } = options;
  const config = options.config.private;
  if (config === undefined) throw new Error("private core requires config.router.private");
  const privateConfig: PrivateConfig = config;
  // 作業ディレクトリは絶対パスに正規化する（子の cwd は購入ディレクトリ: 相対のままだと子の側で別の場所を指す）。
  const workDir = path.resolve(options.workDir ?? privateConfig.workDir);
  const capacity = new PrivateCapacity(
    {
      maxConcurrentSessions: privateConfig.maxConcurrentSessions,
      maxRetainedPurchases: privateConfig.maxRetainedPurchases,
      maxRetainedBytes: privateConfig.maxRetainedBytes,
      purchaseAllowance: purchaseAllowanceOf(privateConfig),
      maxConcurrentVerifications: privateConfig.maxConcurrentVerifications,
      maxQueuedVerifications: privateConfig.maxQueuedVerifications,
    },
    workDir,
  );
  let unavailable = false;
  /** drain（`close`）が始まった。以後、新しい起動・受理・タイマは無く、進行中の継続は永続化せずに終わる（購入は再起動時の規則で終端になる）。 */
  let closing = false;
  /** 進行中の継続（送信レグ・セッションの終わり・検証ジョブ）。`close` は子を止めた後にこれを待ってから掃除する。 */
  const inflight = new Set<Promise<unknown>>();
  function track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    inflight.add(settled);
    void settled.then(() => inflight.delete(settled));
    return work;
  }
  /**
   * journal への追記が失敗した（fsync の失敗など。journal は以後の追記を拒む）。固定の `unknown` の応答は返すが**耐久だとは言わない**。以後の秘匿購入の実行は止め
   * （`unavailable`）、証拠（作業ディレクトリ）は消さずに残す。再起動の再構成が引き継ぐ。
   */
  let persistenceFailed = false;
  function persistenceLost(): void {
    persistenceFailed = true;
    unavailable = true;
    note?.("private: journal append failed; private purchases are closed until restart (artifacts preserved)");
  }
  /** 購入ごとの直列化（session の終わり・attest・期限のタイマ）。 */
  const locks = new Map<string, Promise<void>>();
  function withPayment<T>(paymentId: string, run: () => Promise<T>): Promise<T> {
    const previous = locks.get(paymentId) ?? Promise.resolve();
    const started = previous.then(run, run);
    const settled = started.then(
      () => undefined,
      () => undefined,
    );
    locks.set(paymentId, settled);
    void settled.then(() => {
      if (locks.get(paymentId) === settled) locks.delete(paymentId);
    });
    return started;
  }
  const leases = new Map<string, CapacityLease>();
  const children = new Map<string, Child>();
  const timers = new Set<NodeJS.Timeout>();
  const handovers = new Map<string, HandoverView>();
  /** attest の受理済み（待ち行列か実行中）の digest と結果の約束。 */
  const pendingAttest = new Map<string, { bundleSha256: string; done: Promise<AttestOutcome> }>();
  /** 保持期限が、受理済み（待ち行列か実行中）の検証の最中に来た購入。取得は 410 になるが、入力ファイルと容量の計上は検証ジョブの終わりまで残す（§3.5・§3.7）。 */
  const expiredDuringAttest = new Set<string>();
  const stop = async (point: StopPoint, paymentId: string): Promise<void> => {
    await options.hooksForTest?.stop?.(point, paymentId);
  };
  /**
   * 絶対時刻 `untilMs` に `run` を 1 回。Node の timer は 2^31−1 ms が上限なので、それより先の期限は刻んで待ち、発火のたびに絶対時刻を確かめる
   * （長い保持期限が即座に満了したことにならない）。
   */
  function scheduleAt(untilMs: number, run: () => void): void {
    if (closing) return;
    const delay = Math.min(Math.max(0, untilMs - now()), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (closing) return;
      if (now() < untilMs) {
        scheduleAt(untilMs, run);
        return;
      }
      try {
        run();
      } catch {
        // タイマの中の例外は固定の note だけ（journal・応答には出さない）。
        note?.("private: timer callback failed");
      }
    }, delay);
    timer.unref();
    timers.add(timer);
  }
  function railFor(profile: DynamicProfile): PrivateOutboundRail | undefined {
    return rails[profile.profileId];
  }
  function routeFingerprintOf(profile: DynamicProfile): string {
    return fingerprintOf({ dynamic: dynamicAuthoritativeTermsOf(options.config.dynamic!, profile), private: privateAuthoritativeTermsOf(privateConfig, profile.profileId, profile.rail, options.trust) });
  }
  function dirOf(paymentId: string): string {
    return path.join(workDir, paymentId);
  }
  function unknownReason(paymentId: string, reason: string, extra: Record<string, unknown> = {}): Promise<void> {
    return store.append(paymentId, "unknown", { outcome: "unknown", reason, ...extra });
  }

  /* ------------------------------------------------------------------ quote（§3.1） */

  async function estimateCap(rail: PrivateOutboundRail, profile: DynamicProfile, offer: DestinationOffer, target: UpstreamTarget): Promise<{ ok: true; cap: NonNullable<Parameters<typeof priceOf>[2]> } | { ok: false; reason: string }> {
    if (typeof rail.estimateFee !== "function" || profile.destination.maxFee === undefined) return { ok: false, reason: "fee_estimate_unavailable" };
    let estimate: FeeEstimate;
    try {
      estimate = await rail.estimateFee(profile.profileId, offer, target);
    } catch {
      return { ok: false, reason: "fee_estimate_unavailable" };
    }
    if (!isRecord(estimate) || !AMOUNT_PATTERN.test(String(estimate.bound)) || !AMOUNT_PATTERN.test(String(estimate.gas)) || !AMOUNT_PATTERN.test(String(estimate.maxFeePerGas))) {
      return { ok: false, reason: "fee_estimate_unavailable" };
    }
    const maxFee = capOf(profile, estimate.bound);
    if (maxFee === undefined) return { ok: false, reason: "fee_estimate_unavailable" };
    if (BigInt(maxFee) > BigInt(profile.destination.maxFee)) return { ok: false, reason: "fee_too_high" };
    return { ok: true, cap: { maxFee, estimate: { gas: estimate.gas, maxFeePerGas: estimate.maxFeePerGas, bound: estimate.bound, atMs: now() } } };
  }

  function privateFieldsOf(intent: ParsedIntent, profile: DynamicProfile, pricing: DynamicPricing, offer: DestinationOffer, inboundPayTo: string): Record<string, unknown> {
    const order = intent.order;
    return {
      intentSha256: intent.sha256,
      orderId: order.order_id,
      payerPk: { ...order.payer_pk },
      target: { host: order.target.host, port: 443, path: order.target.path },
      method: intent.method,
      framing: intent.framing,
      body: { len: order.request.body_len, commitmentHex: order.request.body_commitment_hex },
      outbound: {
        rail: profile.rail,
        mode: profile.rail === "x402" ? "sign-only" : "pull",
        network: profile.destination.network,
        asset: offer.asset,
        payTo: offer.payTo,
        amount: offer.amount,
        fundsMoveAt: profile.rail === "x402" ? "provider_paid_request" : "provider_broadcast",
      },
      // 受信で資金が動く時点（FR-Z14、v1.3 FR-V5）: x402 は Router の purchase（facilitator の settle）、SubEtha（burn-sale）は Payer が credential を作る前の burn。
      inbound: { rail: profile.sourceRail, network: profile.source.network, asset: profile.source.asset, payTo: inboundPayTo, total: pricing.total, fee: pricing.fee, fundsMoveAt: profile.sourceRail === "subetha" ? "payer_burn_before_credential" : "router_purchase_settle_before_issuance" },
      policy: { minCredentialLifetimeMs: privateConfig.minCredentialLifetimeMs[profile.rail], sessionTimeoutMs: privateConfig.sessionTimeoutMs, attestTimeoutMs: privateConfig.attestTimeoutMs, retentionMs: privateConfig.retentionMs },
      limits: {
        maxSentBytes: MAX_SENT_BYTES,
        maxBodyBytes: 512,
        maxResponseBytes: 704,
        maxHeaderValueBytes: maxPaymentValueOf(intent.method),
        maxPathBytes: 256,
        tls: { version: "TLSv1.2", cipherSuites: ["TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256", "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"], responseFraming: "content-length-identity-single-response" },
      },
      disclosures: { noRefund: true, unknownPossible: true, verifierLoopbackOnly: true, deliveredPrivateMeaning: "verified delivery to payer_pk, not human receipt", trust: options.trust === "mozilla" ? "mozilla-webpki-roots" : "lab-fixture-ca (synthetic)" },
    };
  }

  async function quote(request: PrivateQuoteRequest): Promise<PrivateQuoteOutcome> {
    if (unavailable) return { ok: false, code: "private_unavailable" };
    const dynamic = options.config.dynamic;
    if (dynamic === undefined || !dynamic.enabled) return { ok: false, code: "private_disabled" };
    if (!privateConfig.profiles.includes(request.profileId)) return { ok: false, code: "unknown_route" };
    const profile = resolveProfile(options.config, request.profileId);
    const rail = profile === undefined ? undefined : railFor(profile);
    if (profile === undefined || rail === undefined) return { ok: false, code: "unknown_route" };
    // 封筒（I/O の前に全欄）。
    if (typeof request.intentB64 !== "string" || request.intentB64 === "" || request.intentB64.length > Math.ceil((privateConfig.maxIntentBytes * 4) / 3) + 4) return { ok: false, code: "intent_too_large" };
    let bytes: Buffer;
    try {
      bytes = Buffer.from(request.intentB64, "base64");
    } catch {
      return { ok: false, code: "invalid_intent", reason: "intent_not_base64" };
    }
    if (bytes.toString("base64") !== request.intentB64) return { ok: false, code: "invalid_intent", reason: "intent_not_base64" };
    const parsed = parseIntent(bytes, { maxBytes: privateConfig.maxIntentBytes });
    if (!parsed.ok) return { ok: false, code: parsed.reason === "intent_too_large" ? "intent_too_large" : "invalid_intent", reason: parsed.reason };
    const intent = parsed.intent;
    const parsedUrl = parseUpstreamUrl(intent.url, { denyHosts: dynamic.denyHosts });
    if (!parsedUrl.ok) return { ok: false, code: "invalid_upstream_url", reason: parsedUrl.reason };
    if (parsedUrl.url !== intent.url) return { ok: false, code: "invalid_upstream_url", reason: "not_canonical" };
    // 封筒の送信・受信の欄とプロファイルの照合（offer に依らない部分を先に）。
    if (intent.outbound.protocol !== profile.rail || intent.outbound.network !== profile.destination.network || intent.outbound.asset.toLowerCase() !== profile.destination.asset.toLowerCase()) {
      return { ok: false, code: "intent_mismatch", reason: "outbound" };
    }
    if (intent.inbound.network !== profile.source.network || intent.inbound.asset.toLowerCase() !== profile.source.asset.toLowerCase()) {
      return { ok: false, code: "intent_mismatch", reason: "inbound" };
    }
    if (store.quoteIdFor(request.principalId, request.requestId) !== undefined || ledger.byRequest(request.principalId, request.requestId) !== undefined) {
      return { ok: false, code: "request_id_conflict" };
    }
    if (ledger.unusable) return { ok: false, code: "dynamic_unavailable" };
    const admitted = gate.admitQuote(request.source, ledger.outstanding());
    if (!admitted.ok) return { ok: false, code: admitted.reason === "outstanding_quotes" ? "dynamic_capacity" : "rate_limited", reason: admitted.reason };
    return withLease(admitted.lease, async () => {
      const host = gate.admitHost(parsedUrl.host);
      if (!host.ok) return { ok: false, code: "rate_limited", reason: host.reason };
      const target = probeTargetOf({ method: intent.method, target: intent.order.target });
      let offers: readonly DestinationOffer[];
      try {
        offers = await withLease(host.lease, async () => (await rail.discover(profile.profileId, target)).offers);
      } catch {
        return { ok: false, code: "quote_failed", reason: "offer_unavailable" };
      }
      const selected = offers.find((offer) => offer.scheme === profile.destination.scheme && offer.network === profile.destination.network && AMOUNT_PATTERN.test(offer.amount) && BigInt(offer.amount) <= BigInt(profile.maxUpstreamAmount) && offer.amount !== "0");
      if (selected === undefined) return { ok: false, code: "quote_failed", reason: "no_matching_offer" };
      if (selected.payTo.toLowerCase() !== intent.outbound.payTo.toLowerCase() || BigInt(selected.amount) > BigInt(intent.outbound.maxAmount)) {
        return { ok: false, code: "intent_mismatch", reason: "outbound_offer" };
      }
      let cap: Parameters<typeof priceOf>[2];
      if (usesGasIndexedFee(profile)) {
        const estimated = await estimateCap(rail, profile, selected, target);
        if (!estimated.ok) return { ok: false, code: "quote_failed", reason: estimated.reason };
        cap = estimated.cap;
      }
      const pricing = priceOf(profile, selected.amount, cap);
      if (pricing === undefined) return { ok: false, code: "quote_failed", reason: "amount_unrepresentable" };
      if (BigInt(pricing.total) > BigInt(intent.inbound.maxTotal)) return { ok: false, code: "intent_mismatch", reason: "inbound_total" };
      const overLimit = perPurchaseLimitOf(options.config, reservationOf(profile, pricing));
      if (overLimit !== undefined) return { ok: false, code: "quote_failed", reason: overLimit };

      const ownerKey = randomBytes(32).toString("base64url");
      const binding = privateBindingOf(profile.profileId, intent.method, intent.url, intent.sha256);
      const sourceOffer = await inbound.createOffer({ routeId: profile.profileId, amount: pricing.total, asset: profile.source.asset, network: profile.source.network, routeBinding: binding, nowMs: now() });
      if (sourceOffer.amount !== pricing.total || sourceOffer.asset !== profile.source.asset || sourceOffer.network !== profile.source.network || sourceOffer.extra.routeBinding !== binding) {
        return { ok: false, code: "source_terms_mismatch" };
      }
      // `subetha` 受信は V2 の burn-sale の challenge だけ（V1 の facilitator は `eventId` を返さないので発行できない。`docs/zktls-router-v2-inbound.md` FR-V2）。
      if (profile.sourceRail === "subetha" && sourceOffer.extra["settlementKind"] !== "zerc20-v2-burn-sale") {
        return { ok: false, code: "source_terms_mismatch", reason: "settlement_kind" };
      }
      // 注文ごとの burn address が、同じ network・資産の Provider の受取先と同じなら拒む（v1.3 設計レビュー 6）。
      if (sourceOffer.network === selected.network && sourceOffer.asset.toLowerCase() === selected.asset.toLowerCase() && sourceOffer.payTo.toLowerCase() === selected.payTo.toLowerCase()) {
        return { ok: false, code: "quote_failed", reason: "pay_to_conflict" };
      }
      const issuedAtMs = now();
      const approvalDeadlineMs = Math.min(issuedAtMs + options.config.approvalTtlMs, sourceOffer.extra.expiresAt * 1000);
      const paymentId = options.nextPaymentId();
      const quoteId = sourceOffer.extra.challengeNonce;
      const privateRecord = {
        intentSha256: intent.sha256,
        intentB64: request.intentB64,
        orderId: intent.order.order_id,
        method: intent.method,
        framing: intent.framing,
        bodyLen: intent.order.request.body_len,
        bodyCommitmentHex: intent.order.request.body_commitment_hex,
        policy: { minCredentialLifetimeMs: privateConfig.minCredentialLifetimeMs[profile.rail], sessionTimeoutMs: privateConfig.sessionTimeoutMs, attestTimeoutMs: privateConfig.attestTimeoutMs, retentionMs: privateConfig.retentionMs },
        limits: { maxIntentBytes: privateConfig.maxIntentBytes, maxBundleBytes: privateConfig.maxBundleBytes, maxRecordBytes: privateConfig.maxRecordBytes },
      };
      const record: Record<string, unknown> = {
        quoteId,
        routeId: profile.profileId,
        principalId: request.principalId,
        requestId: request.requestId,
        source: { amount: pricing.total, asset: profile.source.asset, network: profile.source.network, offer: sourceOffer },
        destination: { quoted: selected.amount, asset: selected.asset, network: selected.network, selectedOffer: selected },
        quoteFingerprint: fingerprintOf(selected),
        routeFingerprint: routeFingerprintOf(profile),
        approvalDeadlineMs,
        upstream: intent.method === "POST" ? { url: intent.url, method: "POST", body: PROBE_BODY, bodySha256: PROBE_BODY_SHA256 } : { url: intent.url, method: "GET" },
        dynamic: { profileId: profile.profileId, profile: JSON.parse(JSON.stringify(profile)) as Record<string, unknown>, pricing, ownerKeyHash: ownerKeyHashOf(ownerKey) },
        private: privateRecord,
      };
      try {
        await ledger.put({ quoteId, paymentId, principalId: request.principalId, requestId: request.requestId, deadlineMs: approvalDeadlineMs, record });
      } catch (error) {
        if (error instanceof LedgerRecordTooLargeError) return { ok: false, code: "quote_failed", reason: "quote_too_large" };
        if (error instanceof LedgerDuplicateError) return { ok: false, code: "request_id_conflict" };
        return { ok: false, code: "dynamic_unavailable" };
      }
      const written = ledger.get(quoteId);
      if (written === undefined) return { ok: false, code: "dynamic_unavailable" };
      const restored = intentFromCreated(written.paymentId, new Date(now()).toISOString(), written.record as Record<string, unknown>, { requireReservation: false });
      if (restored.private === undefined || restored.privateInvalid === true || restored.dynamic === undefined) return { ok: false, code: "dynamic_unavailable" };
      // 承認対象の受信の受取先: x402 は Router の受取先、subetha（burn-sale）は quote ごとの burn address（= 受信 offer の payTo）。
      return { ok: true, intent: restored, fields: { private: privateFieldsOf(intent, profile, pricing, selected, sourceOffer.payTo), pricing, sourceRail: profile.sourceRail, rail: profile.rail, ownerKey } };
    });
  }

  async function withLease<T>(lease: GateLease, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } finally {
      lease.release();
    }
  }

  /* ------------------------------------------------------------------ 送信レグ（§3.2） */

  function deliver(paymentId: string, diag: PurchaseDiagnostics, lease: CapacityLease | undefined): Promise<DynamicPurchaseOutcome> {
    return track(deliverInner(paymentId, diag, lease));
  }

  async function deliverInner(paymentId: string, _diag: PurchaseDiagnostics, lease: CapacityLease | undefined): Promise<DynamicPurchaseOutcome> {
    const intent = store.byPaymentId(paymentId);
    const priv = intent?.private;
    const profile = intent === undefined ? undefined : resolveProfile(options.config, intent.routeId);
    const rail = profile === undefined ? undefined : railFor(profile);
    const releaseLease = (): void => {
      lease?.release();
      if (lease !== undefined) leases.delete(paymentId);
    };
    if (intent === undefined || priv === undefined || profile === undefined || rail === undefined || lease === undefined) {
      releaseLease();
      await store.append(paymentId, "paid_undelivered", { outcome: "not_sent", reason: "quote_changed" });
      return { paymentId, status: "paid_data_unavailable", terminalReason: "quote_changed" };
    }
    leases.set(paymentId, lease);
    const capacityLease: CapacityLease = lease;
    const undelivered = async (reason: string): Promise<DynamicPurchaseOutcome> => {
      releaseLease();
      await store.append(paymentId, "paid_undelivered", { outcome: "not_sent", reason });
      return { paymentId, status: "paid_data_unavailable", terminalReason: reason };
    };
    /**
     * 予約の後の失敗はすべて `unknown`（FR-Z09）。journal に書けなければ、固定の応答は返すが耐久だとは言わず、以後の実行を止めて証拠を残す（掃除しない）。
     */
    const unknown = async (reason: string): Promise<DynamicPurchaseOutcome> => {
      try {
        await unknownReason(paymentId, reason);
      } catch {
        persistenceLost();
        return { paymentId, status: "unknown", terminalReason: reason };
      }
      capacityLease.sessionEnded();
      if (!capacityLease.attestSettled()) note?.("private: cleanup failed after unknown; the reservation stays charged");
      leases.delete(paymentId);
      return { paymentId, status: "unknown", terminalReason: reason };
    };
    if (closing || unavailable) {
      // drain・停止中: 発行を始めない（予約の前なので未発行。再提出は再起動後の規則で）。
      return undelivered("private_unavailable");
    }
    // 1. 再照合（FR-Z18 の 2 回目）。
    const target = probeTargetOf(priv);
    let discovered: PrivateDiscovery | undefined;
    try {
      discovered = await rail.discover(profile.profileId, target);
    } catch {
      return undelivered("offer_unavailable");
    }
    const found: PrivateDiscovery = discovered;
    const approvedJson = stableJson(intent.destination.selectedOffer);
    if (!found.offers.some((offer) => stableJson(offer) === approvedJson)) return undelivered("offer_changed");
    if (now() >= intent.approvalDeadlineMs) return undelivered("approval_expired");
    // 2. 受信支払いの識別子。
    const txRef = intent.source.txRef;
    const eventId = intent.source.eventId;
    if (typeof txRef !== "string" || txRef === "") return undelivered("private_inbound_identity_missing");
    // x402 と subetha（burn-sale）は支払いイベントの識別子が無ければ発行しない（FR-Z06 (b)、v1.3 FR-V4）。
    if ((profile.sourceRail === "x402" || profile.sourceRail === "subetha") && (typeof eventId !== "string" || eventId === "")) return undelivered("private_inbound_identity_missing");
    const inboundIdentity = `${profile.sourceRail}|${intent.source.network}|${txRef}|${eventId ?? ""}`;
    // 3. 発行予約（FR-Z06）。以後の失敗はすべて unknown。
    const reserved = await store.reservePrivateIssuance(paymentId, priv.intentSha256, inboundIdentity);
    if (reserved === "collision") return unknown("private_issuance_duplicate");
    if (reserved !== "reserved") {
      // 予約の追記が失敗した（journal は以後の追記を拒む）: もう一度追記せず、固定の unknown を返して受付を閉じる（耐久だとは言わない。成果物と容量の計上は残す）。
      persistenceLost();
      return { paymentId, status: "unknown", terminalReason: "private_issuance_unknown" };
    }
    const settledTxRef: string = txRef;
    const afterReservation = async (): Promise<DynamicPurchaseOutcome> => {
    await stop("afterReserve", paymentId);
    // 4. 発行（送らない）。
    let issued: IssuedCredential;
    try {
      const outcome = await rail.issueCredential({ profileId: profile.profileId, offer: intent.destination.selectedOffer, target, challenge: found.challenge, deadlineMs: intent.approvalDeadlineMs, ...(intent.dynamic?.pricing.maxFee === undefined ? {} : { maxFee: intent.dynamic.pricing.maxFee }) });
      if (!outcome.ok) return unknown(outcome.reason === "destination_deadline" ? "approval_expired" : "private_issue_failed");
      issued = outcome.issued;
    } catch {
      return unknown("private_issue_failed");
    }
    // 5. ヘッダ検査（Rust と同じ規則を発行側で先に）と要求長。
    const order = orderOf(priv);
    const header = { name: issued.name, value: issued.value };
    if (validatePaymentHeader(header, maxPaymentValueOf(priv.method)) !== undefined || requestLengthBoundOf(order.target, order.request, header) > MAX_SENT_BYTES) {
      return unknown("private_header_invalid");
    }
    // 6. 寿命。
    if (issued.expiresAtMs - now() < priv.policy.minCredentialLifetimeMs) return unknown("private_credential_lifetime");
    // 7. release（sessionBy はここで永続化）。
    const releaseBytes = releaseBytesOf({ intentSha256: priv.intentSha256, orderId: priv.orderId, headerName: header.name, headerValue: header.value, inboundTx: settledTxRef });
    const sessionBy = now() + priv.policy.sessionTimeoutMs;
    try {
      await store.append(paymentId, "private_released", { headerName: header.name, headerSha256: sha256Hex(header.value), expiresAtMs: issued.expiresAtMs, ...(issued.expectedRef === undefined ? {} : { expectedRef: issued.expectedRef }), releaseB64: releaseBytes.toString("base64"), sessionBy });
    } catch {
      persistenceLost();
      return { paymentId, status: "unknown", terminalReason: "private_release_unknown" };
    }
    await stop("afterRelease", paymentId);
    if (closing) {
      // drain 中: 子を起動しない。journal は `private_released` のまま → 再起動で `interrupted_before_handover`。
      return { paymentId, status: "unknown", terminalReason: "private_unavailable" };
    }
    // 8. Verifier 起動。
    const dir = capacityLease.dir;
    const orderBytes = finalOrderBytesOf(order, header);
    try {
      writeFileSync(path.join(dir, INTENT_FILE), Buffer.from(priv.intentB64, "base64"), { mode: 0o600 });
      writeFileSync(path.join(dir, RELEASE_FILE), releaseBytes, { mode: 0o600 });
      writeFileSync(path.join(dir, ORDER_FINAL_FILE), orderBytes, { mode: 0o600 });
    } catch {
      return unknown("private_verifier_unavailable");
    }
    const remaining = sessionBy - now();
    if (remaining < privateConfig.minSessionRemainingMs) return unknown("private_session_timeout");
    await stop("afterLaunchGate", paymentId);
    const served = await runner.serve({
      dir,
      orderPath: path.join(dir, ORDER_FINAL_FILE),
      intentPath: path.join(dir, INTENT_FILE),
      releasePath: path.join(dir, RELEASE_FILE),
      host: priv.target.host,
      path: priv.target.path,
      timeoutSecs: Math.max(1, Math.floor((sessionBy - now()) / 1000)),
      readyByMs: Math.min(sessionBy, now() + READY_WAIT_MS),
    });
    await stop("afterSpawn", paymentId);
    if (!served.ok) return unknown(served.reason === "expired" ? "private_session_timeout" : "private_verifier_unavailable");
    children.set(paymentId, served.child);
    if (now() >= sessionBy) {
      await served.child.kill();
      children.delete(paymentId);
      return unknown("private_session_timeout");
    }
    // 9. handover（応答の前に fsync）。
    const handedOverAtMs = now();
    try {
      await store.append(paymentId, "private_handed_over", { handedOverAtMs, verifierAddress: served.address });
    } catch {
      await served.child.kill();
      children.delete(paymentId);
      persistenceLost();
      return { paymentId, status: "unknown", terminalReason: "private_handover_unknown" };
    }
    await stop("afterHandoverJournal", paymentId);
    if (now() >= sessionBy) {
      await served.child.kill();
      children.delete(paymentId);
      return unknown("private_session_timeout");
    }
    // セッションの監督。
    superviseSession(paymentId, served.child, sessionBy);
    const parsedIntent = parseIntent(Buffer.from(priv.intentB64, "base64"));
    const headerFile = parsedIntent.ok ? headerFileOf(parsedIntent.intent, header) : { order_id: priv.orderId, intent_sha256: priv.intentSha256, name: header.name, value: header.value };
    handovers.set(paymentId, {
      verifier: { address: served.address },
      releasedHeader: header,
      headerFile,
      releaseB64: releaseBytes.toString("base64"),
      release: JSON.parse(releaseBytes.toString("utf8")) as unknown,
      deadlines: { credentialExpiresAt: issued.expiresAtMs, sessionBy },
    });
    return { paymentId, status: "awaiting_session" };
    };
    try {
      return await afterReservation();
    } catch {
      // 予期しない例外（ファイル・プロセス）も固定の unknown に写す。
      return unknown("private_unavailable");
    }
  }

  /* ------------------------------------------------------------------ session と record（§3.3） */

  function superviseSession(paymentId: string, child: Child, sessionBy: number): void {
    scheduleAt(sessionBy, () => {
      void child.kill();
    });
    void track(
      child.exited.then(() =>
        withPayment(paymentId, async () => {
          try {
            await onSessionExit(paymentId, sessionBy);
          } catch {
            note?.("private: session completion handling failed");
          }
        }),
      ),
    );
  }

  async function onSessionExit(paymentId: string, sessionBy: number): Promise<void> {
    children.delete(paymentId);
    if (closing) return; // drain: 永続化しない（再起動の再構成が record を回収する）。
    const intent = store.byPaymentId(paymentId);
    const lease = leases.get(paymentId);
    if (intent === undefined || intent.private === undefined || lease === undefined) return;
    if (intent.status !== "private_awaiting_session") return;
    const priv = intent.private;
    const dir = lease.dir;
    const recordFile = path.join(dir, RECORD_FILE);
    const read = readBounded(recordFile, priv.limits.maxRecordBytes);
    const record = read.ok ? parseRecordBytes(read.bytes) : undefined;
    const bound = record !== undefined && recordIsBound(record, intent);
    if (!bound) {
      // 完成していない・この購入に束縛されていない record は保持しない（ディレクトリごと消し、量と件数を返す）。
      try {
        await unknownReason(paymentId, "private_session_timeout");
      } catch {
        persistenceLost();
        return;
      }
      lease.retire();
      leases.delete(paymentId);
      return;
    }
    const completedAtMs = recordCompletedAtMsOf(record!);
    const qualified = record!.tls_accept_unix_ms <= sessionBy && completedAtMs <= sessionBy;
    try {
      fsyncFileAndDir(recordFile);
    } catch {
      try {
        await unknownReason(paymentId, "private_record_unknown");
      } catch {
        persistenceLost();
      }
      lease.sessionEnded();
      return;
    }
    await stop("afterRecordPublish", paymentId);
    if (closing) return;
    const recordPatch = {
      recordSha256: sha256Hex(read.ok ? read.bytes : Buffer.alloc(0)),
      recordBytes: read.ok ? read.bytes.length : 0,
      recordCompletedAtMs: completedAtMs,
      summary: summaryOf(record!, priv),
      recordAvailableUntil: completedAtMs + priv.policy.retentionMs,
    };
    if (!qualified) {
      try {
        await unknownReason(paymentId, "private_session_timeout");
        await store.append(paymentId, "private_recorded", { ...recordPatch, late: true });
      } catch {
        persistenceLost();
        return;
      }
      lease.sessionEnded();
      if (!lease.attestSettled()) note?.("private: cleanup failed after late record; the reservation stays charged");
      scheduleRetention(paymentId, recordPatch.recordAvailableUntil);
      return;
    }
    try {
      await store.append(paymentId, "private_recorded", { ...recordPatch, attestBy: completedAtMs + priv.policy.attestTimeoutMs });
    } catch {
      persistenceLost();
      return;
    }
    lease.sessionEnded();
    scheduleAttestTimeout(paymentId, completedAtMs + priv.policy.attestTimeoutMs);
    scheduleRetention(paymentId, recordPatch.recordAvailableUntil);
  }

  function parseRecordBytes(bytes: Buffer): VerifierRecord | undefined {
    try {
      return parseVerifierRecord(JSON.parse(bytes.toString("utf8")));
    } catch {
      return undefined;
    }
  }

  /** 完成の認定（§3.3）: この購入の注文・intent・release・発行ヘッダ・受信 tx に束縛された record。 */
  function recordIsBound(record: VerifierRecord, intent: Intent): boolean {
    const priv = intent.private;
    const issuance = priv?.issuance;
    if (priv === undefined || issuance === undefined) return false;
    const binding = record.intent_binding;
    return (
      record.order_id === priv.orderId &&
      record.target.host === priv.target.host &&
      record.target.port === 443 &&
      record.target.path === priv.target.path &&
      binding !== undefined &&
      binding.intent_sha256 === priv.intentSha256 &&
      binding.release_sha256 === sha256Hex(Buffer.from(issuance.releaseB64, "base64")) &&
      binding.header_sha256 === issuance.headerSha256 &&
      typeof intent.source.txRef === "string" &&
      binding.inbound_tx === intent.source.txRef
    );
  }

  /**
   * journal・射影に写す要約（§3.3）。**検証済み・正規化した固定の値だけ**: 要求行は承認した注文から組み、応答の状態行は `HTTP/1.1 200 OK` か `non_200` の 2 値、
   * trust・server_name は期待値と一致すればその値、違えば固定語。Provider が書ける文字列（理由句など）は写さない（canary の境界）。
   */
  function summaryOf(record: VerifierRecord, priv: IntentPrivate): Record<string, unknown> {
    const expectedTrust = options.trust === "mozilla" ? "mozilla-webpki-roots" : "lab-fixture-ca";
    const recv = parseRecvHeaders(record.revealed_recv_headers);
    return {
      trust: record.trust === expectedTrust ? record.trust : "unexpected",
      externalGate: record.external_gate === true,
      serverName: record.server_name === priv.target.host ? priv.target.host : "mismatch",
      target: { host: priv.target.host, port: 443, path: priv.target.path },
      requestLine: `${priv.method} ${priv.target.path} HTTP/1.1`,
      lenSent: Number.isSafeInteger(record.len_sent) ? record.len_sent : 0,
      bodyLen: Number.isSafeInteger(record.body_len) ? record.body_len : 0,
      statusLine: recv?.statusLine === "HTTP/1.1 200 OK" ? "HTTP/1.1 200 OK" : "non_200",
      credLen: Number.isSafeInteger(record.request.cred_len) ? record.request.cred_len : 0,
    };
  }

  function scheduleAttestTimeout(paymentId: string, attestBy: number): void {
    scheduleAt(attestBy, () => {
      void track(
        withPayment(paymentId, async () => {
          if (closing) return;
          const intent = store.byPaymentId(paymentId);
          if (intent === undefined || intent.status !== "private_recorded" || pendingAttest.has(paymentId)) return;
          try {
            await unknownReason(paymentId, "private_attest_timeout");
          } catch {
            persistenceLost();
            return;
          }
          if (leases.get(paymentId)?.attestSettled() === false) note?.("private: cleanup failed after attest timeout; the reservation stays charged");
        }),
      );
    });
  }

  function scheduleRetention(paymentId: string, until: number): void {
    scheduleAt(until, () => {
      void track(
        withPayment(paymentId, async () => {
          if (closing) return;
          const intent = store.byPaymentId(paymentId);
          if (intent?.private?.record === undefined || intent.private.record.expired === true) return;
          // 取得の期限（410）と物理的な掃除を分ける。追記に失敗したら成果物は残す（再構成が引き継ぐ）。
          try {
            await store.append(paymentId, "private_record_expired", {});
          } catch {
            persistenceLost();
            return;
          }
          if (pendingAttest.has(paymentId)) {
            // 受理済みの検証がある: その入力と容量の計上は検証ジョブの終わりまで残す（`runVerification` の finally で掃除）。
            expiredDuringAttest.add(paymentId);
            return;
          }
          retireLease(paymentId);
        }),
      );
    });
  }
  function retireLease(paymentId: string): void {
    leases.get(paymentId)?.retire();
    leases.delete(paymentId);
  }

  /* ------------------------------------------------------------------ attest（§3.4） */

  async function attest(paymentId: string, principalId: string, ownerKey: string | undefined, bundleB64: string): Promise<AttestOutcome> {
    if (unavailable || closing) return { ok: false, code: "private_unavailable" };
    const intent = store.byPaymentId(paymentId);
    if (intent === undefined || intent.private === undefined || intent.dynamic === undefined || intent.principalId !== principalId || !ownerKeyMatches(ownerKey, intent.dynamic.ownerKeyHash)) {
      return { ok: false, code: "not_found" };
    }
    const priv = intent.private;
    if (typeof bundleB64 !== "string" || bundleB64.length > Math.ceil((priv.limits.maxBundleBytes * 4) / 3) + 4) return { ok: false, code: "bundle_too_large" };
    let bytes: Buffer;
    try {
      bytes = Buffer.from(bundleB64, "base64");
    } catch {
      return { ok: false, code: "invalid_bundle" };
    }
    if (bytes.byteLength === 0 || bytes.toString("base64") !== bundleB64) return { ok: false, code: "invalid_bundle" };
    if (bytes.byteLength > priv.limits.maxBundleBytes) return { ok: false, code: "bundle_too_large" };
    let parsedBundle: unknown;
    try {
      parsedBundle = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { ok: false, code: "invalid_bundle" };
    }
    const bundle = parseBundlePublic(parsedBundle);
    if (bundle === undefined) return { ok: false, code: "invalid_bundle" };
    const bundleSha256 = sha256Hex(bytes);
    // 受付（§3.4 3〜6）だけを購入の lock の中で行い、検証そのものは lock の外で待つ（別の提出が `attest_in_progress`／合流をすぐに受けられるように）。
    const admitted = await withPayment(paymentId, async (): Promise<AttestOutcome | { readonly job: Promise<AttestOutcome> }> => {
      const current = store.byPaymentId(paymentId)!;
      const cur = current.private!;
      // 3. 重複: 耐久結果、または進行中のジョブへの合流。
      if (cur.attest !== undefined && cur.attest.bundleSha256 === bundleSha256) {
        return { ok: true, status: cur.attest.result, ...(cur.attest.reason === undefined ? {} : { terminalReason: cur.attest.reason }) };
      }
      const pending = pendingAttest.get(paymentId);
      if (pending !== undefined) {
        if (pending.bundleSha256 === bundleSha256) return { job: pending.done };
        return { ok: false, code: "attest_in_progress" };
      }
      // 4. 拒否（状態不変）。
      if (current.status !== "private_recorded") {
        return { ok: false, code: current.status === "private_awaiting_session" ? "attest_not_ready" : "attest_closed" };
      }
      const record = cur.record;
      const lease = leases.get(paymentId);
      if (record === undefined || record.attestBy === undefined || lease === undefined || record.expired === true) return { ok: false, code: "attest_closed" };
      if (now() >= record.attestBy) {
        try {
          await unknownReason(paymentId, "private_attest_timeout");
        } catch {
          persistenceLost();
          return { ok: false, code: "private_unavailable" };
        }
        lease.attestSettled();
        return { ok: false, code: "attest_expired" };
      }
      // 5. 束縛の事前検査（別購入の bundle は状態不変で拒否）。
      const recordRead = readBounded(path.join(lease.dir, RECORD_FILE), cur.limits.maxRecordBytes);
      const verifierRecord = recordRead.ok ? parseRecordBytes(recordRead.bytes) : undefined;
      if (verifierRecord === undefined || sha256Hex(recordRead.ok ? recordRead.bytes : Buffer.alloc(0)) !== record.sha256) return { ok: false, code: "attest_closed" };
      if (checkBundleBinding(orderOf(cur), verifierRecord, bundle) !== undefined) return { ok: false, code: "attest_foreign" };
      // 6. 受理: 検証ジョブの枠。pending digest を記録。
      const slot = capacity.enqueueVerification();
      if (slot === undefined) return { ok: false, code: "private_capacity" };
      const done = track(runVerification(paymentId, cur, lease, verifierRecord, bundle, bytes, bundleSha256, slot));
      pendingAttest.set(paymentId, { bundleSha256, done });
      return { job: done };
    });
    return "job" in admitted ? admitted.job : admitted;
  }

  async function runVerification(paymentId: string, priv: IntentPrivate, lease: CapacityLease, record: VerifierRecord, bundle: NonNullable<ReturnType<typeof parseBundlePublic>>, bundleBytes: Buffer, bundleSha256: string, slotPromise: Promise<{ release(): void }>): Promise<AttestOutcome> {
    let slot: { release(): void };
    try {
      slot = await slotPromise;
    } catch {
      // 待ち行列が drain で取り消された。状態は変えない。
      pendingAttest.delete(paymentId);
      return { ok: false, code: "private_unavailable" };
    }
    try {
      return await runVerificationInner(paymentId, priv, lease, record, bundle, bundleBytes, bundleSha256);
    } catch {
      // 予期しない例外（ファイル・プロセス）: 受理した digest の結果として固定の unknown を、他の検証失敗と同じ経路で永続化する（`attesting` のまま残さない）。
      try {
        return await persistAttestOutcome(paymentId, priv, lease, bundleSha256, "private_verifier_unavailable", undefined);
      } catch {
        return { ok: false, code: "private_unavailable" };
      }
    } finally {
      slot.release();
      pendingAttest.delete(paymentId);
      // 検証の最中に保持期限が来ていれば、ここで初めて入力と容量を手放す（drain 中は `close` が record を残す）。
      if (!closing && expiredDuringAttest.delete(paymentId)) retireLease(paymentId);
    }
  }

  /** 結果の永続化は購入の lock の中で（期限のタイマと直列化）。drain 中は永続化しない（record は残り、再起動で終端）。 */
  function persistAttestOutcome(paymentId: string, priv: IntentPrivate, lease: CapacityLease, bundleSha256: string, reason: string | undefined, receipt: { txRef?: string; receiptSha256: string } | undefined): Promise<AttestOutcome> {
    return withPayment(paymentId, async (): Promise<AttestOutcome> => {
      if (closing) return { ok: false, code: "private_unavailable" };
      const current = store.byPaymentId(paymentId);
      if (current === undefined || current.status !== "private_recorded") return { ok: false, code: "attest_closed" };
      let outcome: AttestOutcome;
      try {
        if (reason === undefined && receipt !== undefined) {
          // 領収は検証済みの tx 参照と**ヘッダの digest** だけを残す（生のヘッダは Provider が書ける文字列。原本は認証済みの record にある）。
          await store.append(paymentId, "private_attested", { bundleSha256, ...(receipt.txRef === undefined ? {} : { txRef: receipt.txRef }), receiptSha256: receipt.receiptSha256, recordSha256: priv.record?.sha256 ?? "", proof: { delivery: true, requestBinding: priv.method === "POST" } });
          outcome = { ok: true, status: "delivered_private" };
        } else {
          const terminalReason = reason ?? "private_attest_invalid";
          await unknownReason(paymentId, terminalReason, { attest: { bundleSha256 } });
          outcome = { ok: true, status: "unknown", terminalReason };
        }
      } catch {
        persistenceLost();
        return { ok: false, code: "private_unavailable" };
      }
      if (!lease.attestSettled()) note?.("private: cleanup failed after attest; the reservation stays charged");
      return outcome;
    });
  }

  async function runVerificationInner(paymentId: string, priv: IntentPrivate, lease: CapacityLease, record: VerifierRecord, bundle: NonNullable<ReturnType<typeof parseBundlePublic>>, bundleBytes: Buffer, bundleSha256: string): Promise<AttestOutcome> {
    {
      await stop("afterAttestAdmission", paymentId);
      if (closing) return { ok: false, code: "private_unavailable" };
      const dir = lease.dir;
      let reason: string | undefined;
      let receipt: { txRef?: string; receiptSha256: string } | undefined;
      try {
        writeFileSync(path.join(dir, BUNDLE_FILE), bundleBytes, { mode: 0o600 });
      } catch {
        reason = "private_attest_invalid";
      }
      if (reason === undefined) {
        const verified = await runner.verify({
          dir,
          orderPath: path.join(dir, ORDER_FINAL_FILE),
          bundlePath: path.join(dir, BUNDLE_FILE),
          intentPath: path.join(dir, INTENT_FILE),
          releasePath: path.join(dir, RELEASE_FILE),
          host: priv.target.host,
          path: priv.target.path,
          timeoutMs: privateConfig.verifyTimeoutMs,
          requireExternalGate: options.trust === "mozilla",
        });
        if (!verified.ok || verified.exitCode !== 0) {
          // 期限は timeout、起動できない・シグナルで終わった（結果が無い）は verifier の不備、それ以外（非 0 終了・結果の形）は検証の不成立。どれも終端の unknown。
          reason =
            verified.ok === false && verified.reason === "timeout"
              ? "private_verify_timeout"
              : verified.ok === false && (verified.reason === "launch_failed" || (verified.reason === "result_unreadable" && verified.exitCode === null))
                ? "private_verifier_unavailable"
                : "private_attest_invalid";
          // 運用者向けの固定文（値は出さない）: ランナーの失敗の種別か終了コード。
          note?.(`private: verifier-verify did not succeed (${verified.ok ? `exit ${String(verified.exitCode)}` : verified.reason})`);
        } else {
          const result = parseVerifyResult(verified.result);
          const headerValue = headerValueOf(dir);
          const profile = resolveProfile(options.config, store.byPaymentId(paymentId)!.routeId);
          const rail = profile === undefined ? undefined : railFor(profile);
          if (result === undefined || headerValue === undefined || priv.issuance === undefined || rail === undefined || profile === undefined) {
            reason = "private_attest_invalid";
            note?.(`private: attest rejected (${result === undefined ? "verify_result_shape" : headerValue === undefined ? "order_final_missing" : "profile_missing"})`);
          } else {
            const checked = checkAttest(
              {
                order: orderOf(priv),
                header: { name: priv.issuance.headerName, value: headerValue },
                rail: profile.rail,
                intentSha256: priv.intentSha256,
                releaseSha256: sha256Hex(Buffer.from(priv.issuance.releaseB64, "base64")),
                inboundTx: store.byPaymentId(paymentId)!.source.txRef ?? "",
                trust: options.trust,
              },
              record,
              result,
              bundle,
            );
            if (!checked.ok) {
              reason = "private_attest_invalid";
              note?.(`private: attest rejected (${checked.reason})`);
            } else {
              const intent = store.byPaymentId(paymentId)!;
              const issued: IssuedCredential = { name: priv.issuance.headerName as IssuedCredential["name"], value: headerValue, expiresAtMs: priv.issuance.expiresAtMs, ...(priv.issuance.expectedRef === undefined ? {} : { expectedRef: priv.issuance.expectedRef }) };
              const receiptCheck = rail.checkReceipt(checked.receipt.value, intent.destination.selectedOffer, issued);
              if (!receiptCheck.ok) reason = "private_receipt_mismatch";
              else receipt = { ...(receiptCheck.txRef === undefined ? {} : { txRef: receiptCheck.txRef }), receiptSha256: sha256Hex(receiptCheck.receiptRef) };
            }
          }
        }
      }
      await stop("beforeResultPersist", paymentId);
      return persistAttestOutcome(paymentId, priv, lease, bundleSha256, reason, receipt);
    }
  }

  /** 発行ヘッダの値（bearer）は作業ディレクトリの最終注文にだけある（attest の完了で削除）。 */
  function headerValueOf(dir: string): string | undefined {
    const read = readBounded(path.join(dir, ORDER_FINAL_FILE), 8 * 1024);
    if (!read.ok) return undefined;
    try {
      const order = JSON.parse(read.bytes.toString("utf8")) as { request?: { payment_header?: { value?: unknown } } };
      const value = order.request?.payment_header?.value;
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /* ------------------------------------------------------------------ record の取得（§3.5） */

  function record(paymentId: string, principalId: string, ownerKey: string | undefined): RecordOutcome {
    const intent = store.byPaymentId(paymentId);
    if (intent === undefined || intent.private === undefined || intent.dynamic === undefined || intent.principalId !== principalId || !ownerKeyMatches(ownerKey, intent.dynamic.ownerKeyHash)) {
      return { ok: false, code: "not_found" };
    }
    const priv = intent.private;
    if (priv.record === undefined || priv.issuance === undefined) return { ok: false, code: "record_not_available" };
    if (priv.record.expired === true || now() >= priv.record.recordAvailableUntil) return { ok: false, code: "record_expired" };
    const read = readBounded(path.join(dirOf(paymentId), RECORD_FILE), priv.limits.maxRecordBytes);
    if (!read.ok || sha256Hex(read.bytes) !== priv.record.sha256) return { ok: false, code: "record_corrupt" };
    return { ok: true, recordB64: read.bytes.toString("base64"), releaseB64: priv.issuance.releaseB64, recordAvailableUntil: priv.record.recordAvailableUntil };
  }

  /* ------------------------------------------------------------------ 再構成（§3.6） */

  async function start(): Promise<void> {
    try {
      await reconcile();
    } catch {
      unavailable = true;
      note?.("private: reconciliation failed; private purchases stay closed (artifacts preserved)");
    }
  }

  /** 再構成（§3.6）。どこかで失敗したら例外 → 受付を閉じたまま（容量を開かない。保持成果物を計上できないまま開かない）。 */
  async function reconcile(): Promise<void> {
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    // 停止点 `duringRecoveryInventory` は起動門を外した後・pid の棚卸しの前（設計 §11）。
    const inventory = await runner.inventory(workDir, () => stop("duringRecoveryInventory", "-"));
    if (!inventory.ok) {
      unavailable = true;
      note?.(`private: previous-generation children could not be inventoried (${inventory.reason}); private purchases stay closed`);
      return;
    }
    let retainedPurchases = 0;
    let retainedBytes = 0;
    const known = new Set<string>();
    for (const intent of store.interrupted()) {
      const priv = intent.private;
      if (priv === undefined) continue;
      known.add(intent.paymentId);
      const dir = dirOf(intent.paymentId);
      if (!existsSync(dir)) continue;
      const recordFile = path.join(dir, RECORD_FILE);
      const read = readBounded(recordFile, priv.limits.maxRecordBytes);
      if (priv.record !== undefined) {
        if (priv.record.expired === true || !read.ok || sha256Hex(read.bytes) !== priv.record.sha256) {
          rmSync(dir, { recursive: true, force: true });
          if (priv.record.expired !== true) await store.append(intent.paymentId, "private_record_expired", { reason: "record_mismatch" });
          continue;
        }
        if (now() >= priv.record.recordAvailableUntil) {
          rmSync(dir, { recursive: true, force: true });
          await store.append(intent.paymentId, "private_record_expired", {});
          continue;
        }
        deleteNonRecord(dir);
        retainedPurchases += 1;
        retainedBytes += read.bytes.length;
        leases.set(intent.paymentId, capacity.adoptRetained(intent.paymentId, read.bytes.length));
        scheduleRetention(intent.paymentId, priv.record.recordAvailableUntil);
        continue;
      }
      // 発行済みで record の記録が無い: 完成していれば回収（取得専用）。失敗（fsync・journal・掃除）は例外 → 受付を閉じたまま（計上できない成果物のまま開かない）。
      const record = read.ok ? parseRecordBytes(read.bytes) : undefined;
      if (priv.issuance !== undefined && record !== undefined && recordIsBound(record, intent)) {
        const completedAtMs = recordCompletedAtMsOf(record);
        const until = completedAtMs + priv.policy.retentionMs;
        if (now() < until) {
          fsyncFileAndDir(recordFile);
          await store.append(intent.paymentId, "private_recorded", {
            recordSha256: sha256Hex(read.ok ? read.bytes : Buffer.alloc(0)),
            recordBytes: read.ok ? read.bytes.length : 0,
            recordCompletedAtMs: completedAtMs,
            summary: summaryOf(record, priv),
            recordAvailableUntil: until,
            recoveredAtRestart: true,
            late: !(record.tls_accept_unix_ms <= priv.issuance.sessionBy && completedAtMs <= priv.issuance.sessionBy),
          });
          deleteNonRecord(dir);
          retainedPurchases += 1;
          retainedBytes += read.ok ? read.bytes.length : 0;
          leases.set(intent.paymentId, capacity.adoptRetained(intent.paymentId, read.ok ? read.bytes.length : 0));
          scheduleRetention(intent.paymentId, until);
          continue;
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    // intent の無いディレクトリは削除。
    for (const entry of readdirSync(workDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || known.has(entry.name)) continue;
      rmSync(path.join(workDir, entry.name), { recursive: true, force: true });
    }
    capacity.open({ purchases: retainedPurchases, bytes: retainedBytes });
  }

  function deleteNonRecord(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (name === RECORD_FILE) continue;
      rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }

  async function close(): Promise<void> {
    closing = true;
    capacity.closeQueue();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    // 子を止めてから、進行中の継続（送信レグ・セッションの終わり・検証）が終わるのを待つ。永続化はしない（再起動の規則で終端）。
    await runner.closeAll();
    await Promise.allSettled([...inflight]);
    await runner.closeAll();
    // 進行中の作業成果物を消す（購入は再起動時の規則で終端になる）。完成した record（journal に届く前のものを含む）は残し、再構成が回収する。
    for (const [, lease] of leases) {
      try {
        if (existsSync(path.join(lease.dir, RECORD_FILE))) deleteNonRecord(lease.dir);
        else rmSync(lease.dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  return {
    start,
    get unavailable(): boolean {
      return unavailable || persistenceFailed;
    },
    quote,
    dynamicDeps: {
      isPrivate: (intent) => intent.private !== undefined || intent.privateInvalid === true,
      outboundFor: (intent) => {
        const profile = resolveProfile(options.config, intent.routeId);
        const rail = profile === undefined ? undefined : railFor(profile);
        return {
          readChallenge: async (profileId, target) => {
            if (rail === undefined) throw new Error("no private rail");
            return (await rail.discover(profileId, target)).offers;
          },
          ...(rail?.estimateFee === undefined ? {} : { estimateFee: (profileId: string, offer: DestinationOffer, target: UpstreamTarget) => rail.estimateFee!(profileId, offer, target) }),
        };
      },
      reserveCapacity: (intent) => (unavailable || closing ? undefined : capacity.reserve(intent.paymentId)),
      deliver,
      routeFingerprintOf,
    },
    attest,
    record,
    takeHandover: (paymentId) => {
      const view = handovers.get(paymentId);
      handovers.delete(paymentId);
      return view;
    },
    close,
  };
}

export { PROBE_BODY, PROBE_BODY_SHA256 };
