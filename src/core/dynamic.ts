/**
 * 動的上流 URL の quote／purchase（設計 `docs/dynamic-upstream-design.md` §2・§5・§6、タスク T10）。
 *
 * 静的の流れ（`orchestrator.ts`）と分けて持つ。違いは:
 *
 * - **quote は journal に書かない。** 控え（`QuoteLedger`）に入れ、持ち主の証明（`ownerKey`）のハッシュだけを保存する
 * - **purchase は、受信 verify と期限の再検査が通るまで何も書かない。** 動的予算の検査と journal の `created` 行（予約つき）は
 *   同じ mutex の中で 1 行（昇格）。昇格しなかった試行は journal を増やさない
 * - 持ち主の証明が無い・合わない要求には、**存在しない場合と同じ応答**を返す
 * - 門（頻度・同時実行・宛先ホスト）を通らない要求は、上流・facilitator・RPC のどれにも接続しない
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { assetKeyOf, dynamicAuthoritativeTermsOf, resolveProfile, type DynamicProfile, type RouterConfig, usesGasIndexedFee } from "../config.js";
import { parseUpstreamUrl } from "../net/upstream-url.js";
import type { InboundOffer, InboundRail, PaymentCredential } from "../ports/inbound.js";
import { UpstreamMethodUnsupportedError, type DestinationOffer, type FeeEstimate, type OutboundRail, type UpstreamTarget } from "../ports/outbound.js";
import type { Budget, DynamicReservation } from "./budget.js";
import { PromotionNotWrittenError } from "./budget.js";
import type { DynamicGate, GateLease } from "./dynamic-gate.js";
import { fingerprintOf, isTerminal, stableJson, toPublicStatus, type Intent } from "./intent.js";
import { credentialDigestOf, LedgerDuplicateError, LedgerRecordTooLargeError, type LedgerQuote, type QuoteLedger } from "./quote-ledger.js";
import { capCoversFee, IntentCollisionError, intentFromCreated, type IntentStore } from "./store.js";
import { classifyTransportError } from "../net/guarded-fetch.js";
import type { DiagnosticsSink } from "../shared/diagnostics.js";
import { withPurchaseDiagnostics, type PurchaseDiagnostics } from "./purchase-diagnostics.js";

const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,29})$/;
const MAX_AMOUNT_DIGITS = 30;

export interface DynamicQuoteRequest {
  readonly principalId: string;
  readonly requestId: string;
  /** プロファイル ID（`routeId` と同じ名前空間）。 */
  readonly profileId: string;
  readonly url: string;
  /** 上流への要求の方法（省略時 GET）。POST は `body`（JSON object）を要する（`docs/dynamic-upstream-post-design.md` FR-P1）。 */
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  /** 送信元の識別（門の per-source の鍵）。 */
  readonly source: string;
}

/** 上流の本文の上限（canonical JSON の UTF-8 バイト数。FR-P1）。 */
export const MAX_UPSTREAM_BODY_BYTES = 8192;

/** 記録に載る上流の要求（FR-P2）。`body` は Router が送る canonical JSON の文字列そのもの、`bodySha256` はその sha256（hex）。 */
export interface UpstreamRequestFields {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly body?: string;
  readonly bodySha256?: string;
}

export function bodySha256Of(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * caller の本文を正規化する: JSON の object だけ（配列・スカラー・null は拒否）、`stableJson` で鍵順を固定、UTF-8 で 8 KiB 以内。
 * 失敗の理由は固定語（caller の値は含めない）。
 */
export function normalizeUpstreamBody(raw: unknown): { readonly ok: true; readonly body: string; readonly sha256: string } | { readonly ok: false; readonly reason: "body_required" | "body_not_object" | "body_too_large" | "body_not_json" } {
  if (raw === undefined) return { ok: false, reason: "body_required" };
  if (!isRecord(raw) || Array.isArray(raw)) return { ok: false, reason: "body_not_object" };
  let text: string;
  try {
    text = stableJson(JSON.parse(JSON.stringify(raw)));
  } catch {
    return { ok: false, reason: "body_not_json" };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_UPSTREAM_BODY_BYTES) return { ok: false, reason: "body_too_large" };
  return { ok: true, body: text, sha256: bodySha256Of(text) };
}

/** 記録の `upstream` から adapter に渡す target を作る（記録が権威。GET には本文を付けない）。 */
export function upstreamTargetOf(upstream: { readonly url: string; readonly method: "GET" | "POST"; readonly body?: string }): UpstreamTarget {
  return upstream.method === "POST" ? { url: upstream.url, method: "POST", body: upstream.body ?? "" } : { url: upstream.url, method: "GET" };
}

/** 記録・応答に載せる形（本文は見せる: 人が承認する条件の一部。FR-P2）。 */
export function upstreamFieldsOf(upstream: { readonly url: string; readonly method: "GET" | "POST"; readonly body?: string; readonly bodySha256?: string }): UpstreamRequestFields {
  return upstream.method === "POST"
    ? { url: upstream.url, method: "POST", body: upstream.body ?? "", bodySha256: upstream.bodySha256 ?? bodySha256Of(upstream.body ?? "") }
    : { url: upstream.url, method: "GET" };
}

export interface DynamicPricing {
  readonly upstreamAmount: string;
  readonly converted: string;
  readonly fee: string;
  readonly total: string;
  /** MPP 送信だけ: quote が決めた署名時の手数料の上限（cap。`docs/dynamic-gas-fee-design.md` §2）。 */
  readonly maxFee?: string;
  /** MPP 送信だけ: quote 時の見積りの証跡。 */
  readonly estimate?: { readonly gas: string; readonly maxFeePerGas: string; readonly bound: string; readonly atMs: number };
}

/** 見積り（bound）から cap を決める: ceil(bound × feeMargin / 10000)。桁あふれは `undefined`。 */
export function capOf(profile: DynamicProfile, bound: string): string | undefined {
  if (!AMOUNT_PATTERN.test(bound)) return undefined;
  const margin = profile.destination.feeMargin;
  if (margin === undefined) return undefined;
  const cap = (BigInt(bound) * BigInt(margin) + 9_999n) / 10_000n;
  return cap.toString().length > MAX_AMOUNT_DIGITS ? undefined : cap.toString();
}

/** 動的 quote の応答に足す欄。`ownerKey` は**この応答にしか載らない**。 */
export interface DynamicQuoteFields {
  readonly upstream: UpstreamRequestFields;
  readonly dynamic: {
    readonly profileId: string;
    readonly pricing: DynamicPricing;
    readonly sourceRail: "x402" | "mpp";
    readonly rail: "x402" | "mpp";
    /** 受信レールで credential を作った時点で資金が動く（MPP）。 */
    readonly fundsMoveOnCredential: boolean;
  };
  readonly ownerKey: string;
}

export interface DynamicPurchaseRequest {
  readonly principalId: string;
  readonly requestId: string;
  readonly quoteId: string;
  readonly routeId?: string;
  readonly approval?: string;
  readonly credential?: PaymentCredential;
  readonly ownerKey?: string;
  readonly source: string;
}

export interface DynamicCoreOptions {
  readonly config: RouterConfig;
  readonly store: IntentStore;
  readonly ledger: QuoteLedger;
  readonly budget: Budget;
  readonly gate: DynamicGate;
  readonly inbound: InboundRail;
  readonly outbound: OutboundRail;
  readonly now: () => number;
  readonly nextPaymentId: () => string;
  readonly note?: ((message: string) => void) | undefined;
  /** 支払い元の残高（base units）。省略時は検査しない。`undefined` を返した資産は「検査なし」（送信の設計 §2.6）。 */
  readonly balanceOf?: ((profileId: string, asset: string) => Promise<bigint | undefined>) | undefined;
  /** 受信 settle が成立した後の送信レグ（静的と共通）。診断の記録は同じ購入の控え（`diag`）に足す。 */
  readonly deliver: (paymentId: string, diag?: PurchaseDiagnostics) => Promise<DynamicPurchaseOutcome>;
  /** 診断の記録（`docs/rejection-reasons-design.md` §4.1、タスク R-2）。省略時は何もしない。 */
  readonly diagnostics?: DiagnosticsSink;
}

export interface DynamicPurchaseOutcome {
  readonly paymentId?: string;
  readonly status: ReturnType<typeof toPublicStatus> | "rejected";
  readonly code?: string;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly terminalReason?: string;
}

export type DynamicQuoteOutcome =
  | { readonly ok: true; readonly intent: Intent; readonly fields: DynamicQuoteFields }
  | { readonly ok: false; readonly code: string; readonly reason?: string };

export function ownerKeyHashOf(ownerKey: string): string {
  return `sha256:${createHash("sha256").update(ownerKey, "utf8").digest("hex")}`;
}

/** `ownerKey` の照合。無い・形が違う・合わない → 偽。比較は一定時間。 */
export function ownerKeyMatches(ownerKey: unknown, ownerKeyHash: string): boolean {
  if (typeof ownerKey !== "string" || ownerKey === "" || ownerKey.length > 256) return false;
  const a = Buffer.from(ownerKeyHashOf(ownerKey), "utf8");
  const b = Buffer.from(ownerKeyHash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 受信額（元本の換算＋手数料）。設計 §6.6。溢れ（30 桁超）と、受信の桁で**正確に表せない**額は `undefined`
 * （切り上げ・切り捨てで額を変えない）。
 */
export function priceOf(
  profile: DynamicProfile,
  upstreamAmount: string,
  /** MPP 送信: quote が決めた cap と見積りの証跡。手数料は `max(規則の手数料, cap)`。 */
  cap?: { readonly maxFee: string; readonly estimate: NonNullable<DynamicPricing["estimate"]> },
): DynamicPricing | undefined {
  if (!AMOUNT_PATTERN.test(upstreamAmount)) return undefined;
  if (cap !== undefined && !AMOUNT_PATTERN.test(cap.maxFee)) return undefined;
  const amount = BigInt(upstreamAmount);
  const sourceDecimals = BigInt(profile.source.decimals);
  const destinationDecimals = BigInt(profile.destination.decimals);
  // par（1:1）。桁が違えば桁を合わせる。割り切れない額は扱わない。
  let converted: bigint;
  if (sourceDecimals >= destinationDecimals) {
    converted = amount * 10n ** (sourceDecimals - destinationDecimals);
  } else {
    const divisor = 10n ** (destinationDecimals - sourceDecimals);
    if (amount % divisor !== 0n) return undefined;
    converted = amount / divisor;
  }
  const bps = BigInt(profile.fee.bps);
  const proportional = (converted * bps + 9_999n) / 10_000n;
  const computed = BigInt(profile.fee.flat) + proportional;
  const min = BigInt(profile.fee.min);
  let fee = computed > min ? computed : min;
  // 呼び出し側が先に払う手数料 ≥ Router が署名する transaction の手数料の上限（cap）。quote ごとに保つ。
  if (cap !== undefined && BigInt(cap.maxFee) > fee) fee = BigInt(cap.maxFee);
  const total = converted + fee;
  if (total.toString().length > MAX_AMOUNT_DIGITS) return undefined;
  return {
    upstreamAmount,
    converted: converted.toString(),
    fee: fee.toString(),
    total: total.toString(),
    ...(cap === undefined ? {} : { maxFee: cap.maxFee, estimate: { ...cap.estimate } }),
  };
}

/** 受信 offer の束縛（静的の `routeBindingOf` に対応）。プロファイルと URL を結ぶ。 */
export function dynamicBindingOf(profileId: string, url: string, method: "GET" | "POST" = "GET", bodySha256?: string): string {
  // GET は従来どおり 4 要素（既存の束縛と一致）。POST は本文の sha256 を 5 要素目に持つ（`docs/dynamic-upstream-post-design.md` FR-P2）。
  const parts = method === "POST" ? ["dynamic", profileId, "POST", url, `sha256:${bodySha256 ?? ""}`] : ["dynamic", profileId, "GET", url];
  return parts.map(encodeURIComponent).join("|");
}

/** 昇格のときに journal に書く予約（設計 §6.4）。 */
export function reservationOf(profile: DynamicProfile, pricing: DynamicPricing): DynamicReservation {
  const legs = [
    { network: profile.source.network, asset: profile.source.asset, amount: pricing.total },
    { network: profile.destination.network, asset: profile.destination.asset, amount: pricing.upstreamAmount },
  ];
  // 手数料の区分は quote が決めた cap（プロファイルの天井ではない）。
  if (profile.rail === "mpp" && profile.destination.feeAsset !== undefined && pricing.maxFee !== undefined && pricing.maxFee !== "0") {
    legs.push({ network: profile.destination.network, asset: profile.destination.feeAsset, amount: pricing.maxFee });
  }
  return { legs };
}

/**
 * 1 件あたりの固定の上限（設計 §6.6）: 予約の各区分が、動的予算のバケットの `maxPerPurchase` 以内であること。
 * quote の時点で見る（受信 offer を発行してから、昇格で拒否するのでは、MPP 受信の呼び出し側は払った後になる）。
 */
export function perPurchaseLimitOf(config: RouterConfig, reservation: DynamicReservation): string | undefined {
  const buckets = config.dynamic?.budget.buckets ?? [];
  // 同じバケットに落ちる区分は合算する（昇格の検査と同じ見方。`budget.ts`）。
  const requested = new Map<string, { network: string; asset: string; amount: bigint }>();
  for (const leg of reservation.legs) {
    const key = `${leg.network}\u0000${leg.asset}`;
    const entry = requested.get(key) ?? { network: leg.network, asset: leg.asset, amount: 0n };
    entry.amount += BigInt(leg.amount);
    requested.set(key, entry);
  }
  for (const entry of requested.values()) {
    const bucket = buckets.find((candidate) => candidate.network === entry.network && candidate.asset === entry.asset);
    if (bucket === undefined) return "bucket_not_allowed";
    if (!AMOUNT_PATTERN.test(bucket.maxPerPurchase) || entry.amount > BigInt(bucket.maxPerPurchase)) return "per_purchase_limit";
  }
  return undefined;
}

function profileCopyOf(profile: DynamicProfile): Record<string, unknown> {
  return JSON.parse(JSON.stringify(profile)) as Record<string, unknown>;
}

function fieldsOf(intent: Intent, ownerKey: string): DynamicQuoteFields {
  const dynamic = intent.dynamic!;
  const profile = dynamic.profile as unknown as DynamicProfile;
  return {
    upstream: upstreamFieldsOf(intent.upstream!),
    dynamic: {
      profileId: dynamic.profileId,
      pricing: dynamic.pricing,
      sourceRail: profile.sourceRail,
      rail: profile.rail,
      fundsMoveOnCredential: profile.sourceRail === "mpp",
    },
    ownerKey,
  };
}

export interface DynamicCore {
  quote(request: DynamicQuoteRequest): Promise<DynamicQuoteOutcome>;
  purchase(request: DynamicPurchaseRequest): Promise<DynamicPurchaseOutcome>;
  /** 控え（昇格前）の quote を intent の形で読む。期限切れ・無いものは `undefined`。 */
  ledgerIntent(quoteId: string): Intent | undefined;
  ledgerIntentByPaymentId(paymentId: string): Intent | undefined;
  /** `(principal, requestId)` が動的 quote に使われているか（控え・journal のどちらでも）。 */
  requestInUse(principalId: string, requestId: string): boolean;
}

export function createDynamicCore(options: DynamicCoreOptions): DynamicCore {
  const { config, store, ledger, budget, gate, inbound, outbound, now, note } = options;

  function intentOfLedger(quote: LedgerQuote): Intent {
    return intentFromCreated(quote.paymentId, new Date(now()).toISOString(), quote.record as Record<string, unknown>, { requireReservation: false });
  }

  async function withLease<T>(lease: GateLease, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } finally {
      lease.release();
    }
  }

  /** 上流を読む。**呼び出し側が宛先ホストの枠を持っていること。** */
  async function readOffers(profileId: string, target: UpstreamTarget): Promise<{ readonly ok: true; readonly offers: readonly DestinationOffer[] } | { readonly ok: false; readonly code: string }> {
    try {
      return { ok: true, offers: await outbound.readChallenge(profileId, target) };
    } catch (error) {
      return { ok: false, code: error instanceof UpstreamMethodUnsupportedError ? "method_not_supported" : "offer_unavailable" };
    }
  }

  /**
   * MPP 送信の見積り（署名も送金もしない読取）。失敗は quote の不成立（`fee_estimate_unavailable`）、cap が天井を超えれば `fee_too_high`。
   */
  async function estimateFor(
    profile: DynamicProfile,
    offer: DestinationOffer,
    target: UpstreamTarget,
  ): Promise<{ ok: true; cap: NonNullable<Parameters<typeof priceOf>[2]>; estimate: FeeEstimate } | { ok: false; reason: string }> {
    if (typeof outbound.estimateFee !== "function" || profile.destination.maxFee === undefined) {
      return { ok: false, reason: "fee_estimate_unavailable" };
    }
    let estimate: FeeEstimate;
    try {
      estimate = await outbound.estimateFee(profile.profileId, offer, target);
    } catch {
      return { ok: false, reason: "fee_estimate_unavailable" };
    }
    if (!isRecord(estimate) || !AMOUNT_PATTERN.test(String(estimate.bound)) || !AMOUNT_PATTERN.test(String(estimate.gas)) || !AMOUNT_PATTERN.test(String(estimate.maxFeePerGas))) {
      return { ok: false, reason: "fee_estimate_unavailable" };
    }
    const maxFee = capOf(profile, estimate.bound);
    if (maxFee === undefined) {
      return { ok: false, reason: "fee_estimate_unavailable" };
    }
    // 天井は quote の時に見る。purchase の再見積りは記録の cap と比べる（呼び出し側が天井を使う）。
    const cap = { maxFee, estimate: { gas: estimate.gas, maxFeePerGas: estimate.maxFeePerGas, bound: estimate.bound, atMs: now() } };
    return { ok: true, estimate, cap };
  }

  async function quote(request: DynamicQuoteRequest): Promise<DynamicQuoteOutcome> {
    const dynamic = config.dynamic;
    if (dynamic === undefined || !dynamic.enabled) {
      return { ok: false, code: "dynamic_disabled" };
    }
    const profile = resolveProfile(config, request.profileId);
    if (profile === undefined) {
      return { ok: false, code: "unknown_route" };
    }
    const parsed = parseUpstreamUrl(request.url, { denyHosts: dynamic.denyHosts });
    if (!parsed.ok) {
      return { ok: false, code: "invalid_upstream_url", reason: parsed.reason };
    }
    // 要求の方法と本文（FR-P1）。I/O の前に確定し、以後は記録のこの値だけを使う。
    const method: "GET" | "POST" = request.method ?? "GET";
    if (method !== "GET" && method !== "POST") {
      return { ok: false, code: "invalid_upstream_body", reason: "method_not_allowed" };
    }
    let upstreamFields: UpstreamRequestFields = { url: parsed.url, method: "GET" };
    if (method === "POST") {
      const normalized = normalizeUpstreamBody(request.body);
      if (!normalized.ok) {
        return { ok: false, code: "invalid_upstream_body", reason: normalized.reason };
      }
      upstreamFields = { url: parsed.url, method: "POST", body: normalized.body, bodySha256: normalized.sha256 };
    } else if (request.body !== undefined) {
      return { ok: false, code: "invalid_upstream_body", reason: "body_without_post" };
    }
    const target = upstreamTargetOf(upstreamFields);
    // 動的 quote は冪等に再取得できない（持ち主の証明が要る）。使われている `(principal, requestId)` は衝突。
    if (store.quoteIdFor(request.principalId, request.requestId) !== undefined || ledger.byRequest(request.principalId, request.requestId) !== undefined) {
      return { ok: false, code: "request_id_conflict" };
    }
    if (ledger.unusable || budget.blocked !== undefined) {
      return { ok: false, code: "dynamic_unavailable" };
    }
    const admitted = gate.admitQuote(request.source, ledger.outstanding());
    if (!admitted.ok) {
      return { ok: false, code: admitted.reason === "outstanding_quotes" ? "dynamic_capacity" : "rate_limited", reason: admitted.reason };
    }
    return withLease(admitted.lease, async () => {
      // 宛先ホストの枠（名前解決の前に取る）。無ければ接続しない。
      const host = gate.admitHost(parsed.host);
      if (!host.ok) {
        return { ok: false, code: "rate_limited", reason: host.reason };
      }
      const read = await withLease(host.lease, () => readOffers(profile.profileId, target));
      if (!read.ok) {
        return { ok: false, code: "quote_failed", reason: read.code };
      }
      // adapter が検査を通したものだけを返す。core はその先頭を取り、支払いの欄だけもう一度見る。
      const selected = read.offers.find(
        (offer) =>
          offer.scheme === profile.destination.scheme &&
          offer.network === profile.destination.network &&
          AMOUNT_PATTERN.test(offer.amount) &&
          BigInt(offer.amount) <= BigInt(profile.maxUpstreamAmount) &&
          offer.amount !== "0",
      );
      if (selected === undefined) {
        return { ok: false, code: "quote_failed", reason: "no_matching_offer" };
      }
      // Tempo 宛の MPP 送信: その送金のガス代を今見積もり、cap と手数料を決める（`docs/dynamic-gas-fee-design.md` §1・§2）。定額には落とさない。
      // Solana 宛の MPP は cap を持たない（`usesGasIndexedFee` が false。`docs/mpp-solana-design.md` §1.4 (b)）: 規則の手数料だけ。
      let cap: Parameters<typeof priceOf>[2];
      if (usesGasIndexedFee(profile)) {
        const estimated = await estimateFor(profile, selected, target);
        if (!estimated.ok) {
          return { ok: false, code: "quote_failed", reason: estimated.reason };
        }
        if (BigInt(estimated.cap.maxFee) > BigInt(profile.destination.maxFee!)) {
          return { ok: false, code: "quote_failed", reason: "fee_too_high" };
        }
        cap = estimated.cap;
      }
      const pricing = priceOf(profile, selected.amount, cap);
      if (pricing === undefined) {
        return { ok: false, code: "quote_failed", reason: "amount_unrepresentable" };
      }
      // 1 件あたりの上限は quote の時点で見る（払ってから拒否しない）。
      const overLimit = perPurchaseLimitOf(config, reservationOf(profile, pricing));
      if (overLimit !== undefined) {
        return { ok: false, code: "quote_failed", reason: overLimit };
      }

      const ownerKey = randomBytes(32).toString("base64url");
      const ownerKeyHash = ownerKeyHashOf(ownerKey);
      const binding = dynamicBindingOf(profile.profileId, parsed.url, upstreamFields.method, upstreamFields.bodySha256);
      const sourceOffer = await inbound.createOffer({
        routeId: profile.profileId,
        amount: pricing.total,
        asset: profile.source.asset,
        network: profile.source.network,
        routeBinding: binding,
        nowMs: now(),
      });
      if (
        sourceOffer.amount !== pricing.total ||
        sourceOffer.asset !== profile.source.asset ||
        sourceOffer.network !== profile.source.network ||
        sourceOffer.extra.routeBinding !== binding
      ) {
        return { ok: false, code: "source_terms_mismatch" };
      }
      const issuedAtMs = now();
      const approvalDeadlineMs = Math.min(issuedAtMs + config.approvalTtlMs, sourceOffer.extra.expiresAt * 1000);
      const paymentId = options.nextPaymentId();
      const quoteId = sourceOffer.extra.challengeNonce;
      const record: Record<string, unknown> = {
        quoteId,
        routeId: profile.profileId,
        principalId: request.principalId,
        requestId: request.requestId,
        source: { amount: pricing.total, asset: profile.source.asset, network: profile.source.network, offer: sourceOffer },
        destination: { quoted: selected.amount, asset: selected.asset, network: selected.network, selectedOffer: selected },
        quoteFingerprint: fingerprintOf(selected),
        routeFingerprint: fingerprintOf(dynamicAuthoritativeTermsOf(dynamic, profile)),
        approvalDeadlineMs,
        upstream: upstreamFields,
        dynamic: { profileId: profile.profileId, profile: profileCopyOf(profile), pricing, ownerKeyHash },
      };
      try {
        await ledger.put({ quoteId, paymentId, principalId: request.principalId, requestId: request.requestId, deadlineMs: approvalDeadlineMs, record });
      } catch (error) {
        if (error instanceof LedgerRecordTooLargeError) return { ok: false, code: "quote_failed", reason: "quote_too_large" };
        if (error instanceof LedgerDuplicateError) return { ok: false, code: "request_id_conflict" };
        // 書けたかどうか分からない控えは使わない（控えは以後 `unusable`）。
        return { ok: false, code: "dynamic_unavailable" };
      }
      const written = ledger.get(quoteId);
      if (written === undefined) {
        return { ok: false, code: "dynamic_unavailable" };
      }
      const intent = intentOfLedger(written);
      if (intent.dynamic === undefined || intent.dynamicInvalid === true || intent.dynamicCapInvalid === true) {
        return { ok: false, code: "dynamic_unavailable" };
      }
      return { ok: true, intent, fields: fieldsOf(intent, ownerKey) };
    });
  }

  function missing(): DynamicPurchaseOutcome {
    return { status: "rejected", code: "unknown_quote" };
  }

  function currentOutcome(intent: Intent): DynamicPurchaseOutcome {
    return {
      paymentId: intent.paymentId,
      status: toPublicStatus(intent.status),
      ...(intent.status === "delivered" && intent.result !== undefined ? { body: intent.result.body, contentType: intent.result.contentType } : {}),
      ...(intent.terminalReason === undefined ? {} : { terminalReason: intent.terminalReason }),
      ...(isTerminal(intent.status) ? {} : { code: "in_progress" }),
    };
  }

  async function purchase(request: DynamicPurchaseRequest): Promise<DynamicPurchaseOutcome> {
    // 昇格済み（journal）か、控えか。
    const promoted = store.byQuoteId(request.quoteId);
    const fromLedger = promoted === undefined ? ledger.get(request.quoteId) : undefined;
    const intent = promoted ?? (fromLedger === undefined ? undefined : intentOfLedger(fromLedger));
    if (intent === undefined) {
      return missing();
    }
    /**
     * 購入の全体の診断の scope（§12.6）。`requestId` は記録では `principalId` と合わせた hash、`quoteId` も hash（§12.1）。
     * `promoted` は昇格の前か後か（昇格の後の段は入れ子の scope と記録の欄で `true`）。
     */
    return withPurchaseDiagnostics(
      options.diagnostics,
      { paymentId: intent.paymentId, quoteId: intent.quoteId, principalId: intent.principalId, requestId: intent.requestId, routeId: intent.routeId, promoted: promoted !== undefined },
      (diag) => purchaseOfIntent(request, intent, promoted !== undefined, diag),
    );
  }

  async function purchaseOfIntent(request: DynamicPurchaseRequest, intent: Intent, isPromoted: boolean, diag: PurchaseDiagnostics): Promise<DynamicPurchaseOutcome> {
    /** 事前の検査で `awaiting_payment` に終わった記録（`dynamic_precheck`。§4.1）。控えるだけ。 */
    const precheck = (code: string): void => diag.note(() => ({ stage: "dynamic_precheck", outcome: "awaiting", code }));
    // 持ち主の証明。合わなければ存在しない場合と同じ応答（principal の違いも同じ）。
    if (intent.dynamic === undefined || intent.principalId !== request.principalId || !ownerKeyMatches(request.ownerKey, intent.dynamic.ownerKeyHash)) {
      return missing();
    }
    if (intent.dynamicInvalid === true || intent.dynamicCapInvalid === true) {
      return { paymentId: intent.paymentId, status: "rejected", code: "quote_unreadable" };
    }
    if (request.routeId !== undefined && request.routeId !== intent.routeId) {
      return { paymentId: intent.paymentId, status: "rejected", code: "route_mismatch" };
    }
    if (intent.requestId !== request.requestId) {
      return { paymentId: intent.paymentId, status: "rejected", code: "request_id_conflict" };
    }
    if (intent.status !== "created") {
      return currentOutcome(intent);
    }
    if (request.approval !== intent.quoteId) {
      return { paymentId: intent.paymentId, status: "rejected", code: "approval_required" };
    }
    // 設定変更・無効化の検出（指紋には `enabled` も入る）。
    const dynamic = config.dynamic;
    const profile = resolveProfile(config, intent.routeId);
    if (dynamic === undefined || profile === undefined || intent.routeFingerprint !== fingerprintOf(dynamicAuthoritativeTermsOf(dynamic, profile))) {
      note?.(`dynamic profile mismatch (profileId=${intent.routeId})`);
      return { paymentId: intent.paymentId, status: "awaiting_payment", code: "quote_changed" };
    }
    if (intent.approvalDeadlineMs <= 0 || now() >= intent.approvalDeadlineMs) {
      return { paymentId: intent.paymentId, status: "rejected", code: "approval_expired" };
    }
    const credential = request.credential;
    if (credential === undefined) {
      return { paymentId: intent.paymentId, status: "awaiting_payment", code: "payment_required" };
    }
    if (typeof inbound.preflight !== "function") {
      return { paymentId: intent.paymentId, status: "rejected", code: "preflight_unavailable" };
    }
    // 門: ここから settle・送信まで枠を持つ。通らなければ、上流・facilitator・RPC のどれにも接続しない。
    const admitted = gate.admitPurchase(request.source);
    if (!admitted.ok) {
      precheck("rate_limited");
      return { paymentId: intent.paymentId, status: "awaiting_payment", code: "rate_limited", terminalReason: admitted.reason };
    }
    return withLease(admitted.lease, () => purchaseAdmitted(intent, profile, credential, isPromoted, diag, precheck));
  }

  async function purchaseAdmitted(intent: Intent, profile: DynamicProfile, credential: PaymentCredential, isPromoted: boolean, diag: PurchaseDiagnostics, precheck: (code: string) => void): Promise<DynamicPurchaseOutcome> {
    const paymentId = intent.paymentId;
    const awaiting = (code: string): DynamicPurchaseOutcome => {
      precheck(code);
      return { paymentId, status: "awaiting_payment", code };
    };
    const url = intent.upstream!.url;
    const parsed = parseUpstreamUrl(url, { denyHosts: config.dynamic?.denyHosts ?? [] });
    if (!parsed.ok) {
      // 拒否ホストが後から増えた等。接続しない。
      return awaiting("quote_changed");
    }

    // 1. preflight（何も書かない）
    const preflight = inbound.preflight(intent.source.offer, credential, now());
    if (!preflight.ok) {
      const code = typeof preflight.reason === "string" && SAFE_PREFLIGHT_REASONS.has(preflight.reason) ? preflight.reason : "preflight_failed";
      return { paymentId, status: "rejected", code };
    }

    // 2. 控えに attempt（その quote で初めてのときだけ）。昇格済みなら控えには無い。
    if (!isPromoted) {
      try {
        await ledger.recordAttempt(intent.quoteId, credentialDigestOf(credential));
      } catch {
        return { paymentId, status: "rejected", code: "dynamic_unavailable" };
      }
    }

    // 3. 残高の事前確認 → 上流の読み直しと照合 → 受信 verify（何も書かない）
    if (options.balanceOf !== undefined) {
      const enough = await fundsAvailable(profile, intent);
      if (!enough) {
        return awaiting("operator_funds_unavailable");
      }
    }
    // 宛先ホストの枠は、ここから送信の終わりまで持つ（settle 後の読み直し・送信もこの枠の中。設計 §7.3）。
    const host = gate.admitHost(parsed.host);
    if (!host.ok) {
      precheck("rate_limited");
      return { paymentId, status: "awaiting_payment", code: "rate_limited", terminalReason: host.reason };
    }
    return withLease(host.lease, () => purchaseWithHost(intent, profile, credential, isPromoted, upstreamTargetOf(intent.upstream!), diag, precheck));
  }

  async function purchaseWithHost(intent: Intent, profile: DynamicProfile, credential: PaymentCredential, isPromoted: boolean, target: UpstreamTarget, diag: PurchaseDiagnostics, precheck: (code: string) => void): Promise<DynamicPurchaseOutcome> {
    const paymentId = intent.paymentId;
    const awaiting = (code: string): DynamicPurchaseOutcome => {
      precheck(code);
      return { paymentId, status: "awaiting_payment", code };
    };
    const plainAwaiting = (code: string): DynamicPurchaseOutcome => ({ paymentId, status: "awaiting_payment", code });
    // 読み直しは記録の要求（URL・方法・本文）そのもので行う（FR-P2）。
    const read = await readOffers(profile.profileId, target);
    if (!read.ok) {
      return awaiting("offer_unavailable");
    }
    const approvedJson = stableJson(intent.destination.selectedOffer);
    if (!read.offers.some((offer) => stableJson(offer) === approvedJson)) {
      return awaiting("offer_changed");
    }
    if (profile.rail === "mpp") {
      // 昇格済みの再開: 記録の cap・手数料・予約を復元に頼らず見る（`docs/dynamic-gas-fee-design.md` §3.3）。
      // 予約の区分は**設定のプロファイル**の宛先で引く（記録の写しは書き換えられ得る。設定は指紋で quote 時のものと一致を確かめ済み）。
      const bound = {
        sourceAmount: intent.source.offer.amount,
        upstreamOfferAmount: intent.destination.selectedOffer.amount,
        requireReservation: isPromoted,
        destination: { network: profile.destination.network, feeAsset: profile.destination.feeAsset, asset: profile.destination.asset },
      };
      if (!capCoversFee(intent.dynamic!, bound)) {
        return { paymentId, status: "rejected", code: "quote_unreadable" };
      }
      // 再見積り（§1.4）: 今の bound が記録の cap を超えていれば verify に進まない。cap は上げない。記録にも書かない。
      // Solana 宛の MPP は cap を持たないので見積もらない（`docs/mpp-solana-design.md` §1.4 (b)。上の `capCoversFee` の検査は残す）。
      if (usesGasIndexedFee(profile)) {
        const current = await estimateFor(profile, intent.destination.selectedOffer, target);
        if (!current.ok) {
          return awaiting("fee_estimate_unavailable");
        }
        if (BigInt(current.estimate.bound) > BigInt(intent.dynamic!.pricing.maxFee!)) {
          return awaiting("fee_too_high");
        }
      }
    }
    let verified: { isValid: boolean; fundsMoved?: boolean };
    const verifyStartedAt = diag.start();
    try {
      verified = await diag.stage({ promoted: isPromoted }, () => inbound.verify(intent.source.offer, credential, { routeId: intent.routeId }));
    } catch (error) {
      // 昇格の前なら journal・予算・ledger の予約には何も書かない（記録は診断の控えだけ。AC-R3）。
      const elapsedMs = diag.elapsedSince(verifyStartedAt);
      diag.note(() => ({ stage: "source_verify", outcome: "threw", promoted: isPromoted, transport: classifyTransportError(error), code: "source_verify_unavailable", ...(elapsedMs === undefined ? {} : { elapsedMs }) }));
      return plainAwaiting("source_verify_unavailable");
    }
    const verifyElapsedMs = diag.elapsedSince(verifyStartedAt);
    if (verified === null || typeof verified !== "object" || verified.isValid !== true) {
      diag.note(() => ({ stage: "source_verify", outcome: "invalid", promoted: isPromoted, code: "verify_failed", ...(verifyElapsedMs === undefined ? {} : { elapsedMs: verifyElapsedMs }) }));
      return plainAwaiting("verify_failed");
    }
    // 成立の記録も控えるだけ（push は購入の終わり = 昇格・settle の期限の判定の後。§12.3）。
    diag.note(() => ({ stage: "source_verify", outcome: "valid", promoted: isPromoted, ...(verifyElapsedMs === undefined ? {} : { elapsedMs: verifyElapsedMs }) }));

    // 4. 期限の再検査
    const beforeSettleMs = now();
    if (beforeSettleMs >= intent.approvalDeadlineMs || beforeSettleMs >= intent.source.offer.extra.expiresAt * 1000) {
      return awaiting("approval_expired");
    }

    // 5. 昇格（予約の検査と journal の 1 行を同じ mutex で）。昇格済みなら予約は取り直さない。
    if (!isPromoted) {
      const reservation = reservationOf(profile, intent.dynamic!.pricing);
      const quote = ledger.get(intent.quoteId);
      if (quote === undefined) {
        return { paymentId, status: "rejected", code: "approval_expired" };
      }
      let result;
      try {
        result = await budget.promote(reservation, async (frozen) => {
          const record = quote.record as Record<string, unknown>;
          const dynamicRecord = record["dynamic"] as Record<string, unknown>;
          try {
            await store.append(paymentId, "created", { ...record, dynamic: { ...dynamicRecord, reservation: frozen } });
          } catch (error) {
            // 衝突は 1 バイトも書かずに拒否される。それ以外は成否不明。
            if (error instanceof IntentCollisionError) throw new PromotionNotWrittenError(error);
            throw error;
          }
        });
      } catch {
        return { paymentId, status: "rejected", code: "dynamic_unavailable" };
      }
      if (!result.ok) {
        return result.reason === "budget_unavailable" ? { paymentId, status: "rejected", code: "dynamic_unavailable" } : awaiting(result.reason);
      }
      ledger.markPromoted(intent.quoteId);
    }
    const current = store.byPaymentId(paymentId);
    if (current === undefined || current.dynamic === undefined || current.dynamicInvalid === true || current.dynamicCapInvalid === true || current.status !== "created") {
      return { paymentId, status: "rejected", code: "dynamic_unavailable" };
    }

    // 6. 受信 settle → 送信（静的と同じ）
    await store.append(paymentId, "source_pending", {});
    // 昇格と `source_pending` の追記（journal への待ち）の後、settle を呼ぶ直前にもう一度期限を見る（静的と同じ。受信 adapter の証拠の保持の根拠）。
    const settleAtMs = now();
    if (settleAtMs >= intent.approvalDeadlineMs || settleAtMs >= current.source.offer.extra.expiresAt * 1000) {
      // 資金が既に動いた credential（adapter の `fundsMoved`、無ければ offer の `fundsMoveOnCredential`）は `not_sent` にしない: 耐久的な `unknown`。
      const fundsMoved = verified.fundsMoved ?? current.source.offer.extra["fundsMoveOnCredential"] === true;
      if (fundsMoved) {
        await store.append(paymentId, "unknown", { outcome: "none", reason: "source_paid_unsettled" });
        diag.note(() => ({ stage: "dynamic_precheck", outcome: "unknown", promoted: true, code: "source_paid_unsettled" }));
        return { paymentId, status: "unknown", terminalReason: "source_paid_unsettled" };
      }
      await store.append(paymentId, "source_failed", { outcome: "not_sent", reason: "approval_expired" });
      // 昇格の後の期限切れ（記録の欄で `promoted:true`。push は購入の scope の値なので明示する）。
      diag.note(() => ({ stage: "dynamic_precheck", outcome: "awaiting", promoted: true, code: "approval_expired" }));
      return plainAwaiting("approval_expired");
    }
    let settled: unknown;
    const settleStartedAt = diag.start();
    try {
      settled = await diag.stage({ promoted: true }, () => inbound.settle(current.source.offer, credential, { routeId: current.routeId }));
    } catch (error) {
      await store.append(paymentId, "unknown", { outcome: "none", reason: "source_settle_unknown" });
      const elapsedMs = diag.elapsedSince(settleStartedAt);
      diag.note(() => ({ stage: "source_settle", outcome: "threw", promoted: true, transport: classifyTransportError(error), code: "source_settle_unknown", ...(elapsedMs === undefined ? {} : { elapsedMs }) }));
      return { paymentId, status: "unknown", terminalReason: "source_settle_unknown" };
    }
    const settleElapsedMs = diag.elapsedSince(settleStartedAt);
    const settleNote = (outcome: "settled" | "rejected" | "unknown", code?: string): void =>
      diag.note(() => ({ stage: "source_settle", outcome, promoted: true, ...(code === undefined ? {} : { code }), ...(settleElapsedMs === undefined ? {} : { elapsedMs: settleElapsedMs }) }));
    const outcome = isRecord(settled) ? settled["outcome"] : undefined;
    const txRef = isRecord(settled) ? settled["txRef"] : undefined;
    if (outcome === "settled" && typeof txRef === "string" && txRef !== "") {
      try {
        await store.append(paymentId, "source_settled", { txRef });
      } catch {
        // 静的と同じ（`orchestrator.ts` の settle）: 記録できなければ `unknown` を返し、別の行を書かず、送信を始めない。
        note?.(`source_settled could not be journaled (paymentId=${paymentId}); answering unknown`);
        settleNote("settled", "source_settle_unknown");
        return { paymentId, status: "unknown", terminalReason: "source_settle_unknown" };
      }
      settleNote("settled");
      // 昇格の後の送信（読み直し・支払い・遅れて届く callback を含む）は `promoted:true` の scope の中（購入の scope は昇格の前の値を持ち得る）。
      return diag.stage({ promoted: true }, () => options.deliver(paymentId, diag));
    }
    /**
     * 昇格後の settle の失敗は**すべて `unknown`**（設計 §6.5）。facilitator・RPC は、送金の前に拒否したのか後に拒否したのかを
     * 応答で確実には区別できないので、`rejected` を「未払い」と確定しない。予約は保持する。
     */
    const reason = outcome === "rejected" ? safeSettleReason(isRecord(settled) ? settled["reason"] : undefined) : "source_settle_unknown";
    await store.append(paymentId, "unknown", { outcome: "none", reason });
    settleNote(outcome === "rejected" ? "rejected" : "unknown", reason);
    return { paymentId, status: "unknown", terminalReason: reason };
  }

  /** 残高の事前確認（設計 §6.6）。元本の資産と手数料の資産を別々に（同じなら合算で）。読めなければ不足とみなす。 */
  async function fundsAvailable(profile: DynamicProfile, intent: Intent): Promise<boolean> {
    const needed = new Map<string, bigint>();
    // 資産の鍵は network の族で決める（EVM は小文字化、SVM の mint は大文字小文字を保つ。multirail 設計 §1、FR-4）。能力にはこの鍵を渡す。
    const add = (asset: string, amount: bigint): void => {
      const key = assetKeyOf(profile.destination.network, asset);
      needed.set(key, (needed.get(key) ?? 0n) + amount);
    };
    add(profile.destination.asset, BigInt(intent.dynamic!.pricing.upstreamAmount));
    const cap = intent.dynamic!.pricing.maxFee;
    if (profile.rail === "mpp" && profile.destination.feeAsset !== undefined && cap !== undefined) {
      add(profile.destination.feeAsset, BigInt(cap));
    }
    for (const [asset, amount] of needed) {
      let balance: bigint | undefined;
      try {
        balance = await options.balanceOf!(profile.profileId, asset);
      } catch {
        return false;
      }
      // `undefined` = この経路の rail／能力は残高を持たない（検査なし）。それ以外は bigint で足りることを要求する。
      if (balance === undefined) continue;
      if (typeof balance !== "bigint" || balance < amount) return false;
    }
    return true;
  }

  return {
    quote,
    purchase,
    ledgerIntent(quoteId: string): Intent | undefined {
      const quote = ledger.get(quoteId);
      return quote === undefined ? undefined : intentOfLedger(quote);
    },
    ledgerIntentByPaymentId(paymentId: string): Intent | undefined {
      const quote = ledger.byPaymentId(paymentId);
      return quote === undefined ? undefined : intentOfLedger(quote);
    },
    requestInUse(principalId: string, requestId: string): boolean {
      return ledger.byRequest(principalId, requestId) !== undefined;
    },
  };
}

const SAFE_PREFLIGHT_REASONS: ReadonlySet<string> = new Set(["nonce_mismatch", "offer_expired", "offer_mismatch", "route_binding_mismatch", "credential_mismatch"]);
const SAFE_SETTLE_REASONS: ReadonlySet<string> = new Set(["source_rejected", "verify_failed"]);

function safeSettleReason(value: unknown): string {
  return typeof value === "string" && SAFE_SETTLE_REASONS.has(value) ? value : "source_rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type { InboundOffer };
