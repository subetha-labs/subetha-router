/**
 * 公開射影（設計 §7）。固定のフィールドだけを組み立て、journal の生レコード・
 * 上流 URL・principal トークン・内部ヘッダ・例外文字列は決して載せない。
 */

import { canonicalPathOf, type DynamicProfile, type RouteConfig, type RouterConfig, usesGasIndexedFee } from "../config.js";
import type { Projection, QuoteDocument } from "../core/orchestrator.js";
import type { InboundOffer } from "../ports/inbound.js";
import { networkFamilyOf } from "../shared/networks.js";

export function canonicalUrlOf(canonicalBaseUrl: string, route: RouteConfig): string {
  return `${canonicalBaseUrl}${route.canonicalPath}`;
}

/** R1 の動的プロファイルの一覧（設計 §1.1・§2.1）。呼び出し側が「自分の払えるレールのプロファイル」を選ぶための欄だけ。 */
export function dynamicListingOf(config: RouterConfig): Record<string, unknown> | undefined {
  const dynamic = config.dynamic;
  if (dynamic === undefined) {
    return undefined;
  }
  return {
    enabled: dynamic.enabled,
    profiles: Object.values(dynamic.profiles).map((profile) => ({
      profileId: profile.profileId,
      // 受取先（Router の受取 owner／アドレス）も一覧に出す（AC-6。呼び出し側が quote の前に相手を確かめられる）。
      source: { rail: profile.sourceRail, network: profile.source.network, asset: profile.source.asset, decimals: profile.source.decimals, payTo: profile.source.payTo },
      destination: { rail: profile.rail, scheme: profile.destination.scheme, network: profile.destination.network, asset: profile.destination.asset, decimals: profile.destination.decimals },
      maxUpstreamAmount: profile.maxUpstreamAmount,
      fee: { ...profile.fee },
      // gas-indexed の手数料は Tempo 宛の MPP だけ（Solana 宛の MPP は cap を持たない。`docs/mpp-solana-design.md` §1.4）。
      ...(usesGasIndexedFee(profile) ? { feePolicy: { kind: "gas-indexed", feeMargin: profile.destination.feeMargin, maxFeeCeiling: profile.destination.maxFee } } : {}),
      disclosures: dynamicDisclosuresOf(profile.sourceRail === "mpp", usesGasIndexedFee(profile)),
    })),
  };
}

/** R1: allowlist の `routeId`・canonical URL・資産メタのみ（上流 URL は返さない）。動的プロファイルの一覧は `dynamic` に（設定にあるときだけ）。 */
export function routeListBody(config: RouterConfig, canonicalBaseUrl: string): unknown {
  const dynamic = dynamicListingOf(config);
  return {
    ...(dynamic === undefined
      ? {}
      : {
          dynamic: {
            ...dynamic,
            profiles: (dynamic["profiles"] as Record<string, unknown>[]).map((profile) => ({
              ...profile,
              resource: { url: `${canonicalBaseUrl}${canonicalPathOf(profile["profileId"] as string)}`, method: "GET" },
            })),
          },
        }),
    routes: Object.values(config.routes).map((route) => ({
      routeId: route.routeId,
      resource: { url: canonicalUrlOf(canonicalBaseUrl, route), method: "GET" },
      source: {
        amount: route.source.amount,
        asset: route.source.asset,
        decimals: route.source.decimals,
        network: route.source.network,
        // x402／mpp 受信の受取先（subetha 受信は facilitator が決めるので無い）。
        ...(route.source.payTo === undefined ? {} : { payTo: route.source.payTo }),
        // 受信レールと offer の scheme（加算。payer の `find_routes` が Solana の x402 と MPP を区別するため。`docs/payer-rails-design.md` FR-R13）。
        // `subetha` 受信（既定）は欄を出さない（レールの名前が wire の scheme に対応しない）。
        ...sourceRailListingOf(route),
      },
      destination: {
        rail: route.rail ?? route.destination.scheme,
        scheme: route.destination.scheme,
        network: route.destination.network,
        asset: route.destination.asset,
      },
    })),
  };
}

/** 静的 route の受信レールと scheme（x402 → `exact`、mpp → network の family で `tempo/charge` / `solana/charge`）。 */
export function sourceRailListingOf(route: RouteConfig): { rail: "x402" | "mpp"; scheme: "exact" | "tempo/charge" | "solana/charge" } | Record<string, never> {
  if (route.sourceRail === "x402") return { rail: "x402", scheme: "exact" };
  if (route.sourceRail === "mpp") return { rail: "mpp", scheme: networkFamilyOf(route.source.network) === "svm" ? "solana/charge" : "tempo/charge" };
  return {};
}

/** R2: quote 文書（`quoteId` は受信 offer の idempotency key）。 */
export function quoteBody(
  quote: QuoteDocument,
  route: RouteConfig,
  canonicalBaseUrl: string,
): unknown {
  return {
    quoteId: quote.quoteId,
    paymentId: quote.paymentId,
    routeId: quote.routeId,
    resource: { url: canonicalUrlOf(canonicalBaseUrl, route), method: "GET" },
    source: {
      // 実レールを名乗る。**既定は `subetha`**（`sourceRail` 未指定の既存 route を壊さない）。
      rail: route.sourceRail ?? "subetha",
      amount: quote.source.amount,
      asset: quote.source.asset,
      decimals: route.source.decimals,
      network: quote.source.network,
      payTo: quote.source.offer.payTo,
      expiresAt: quote.source.offer.extra.expiresAt,
      offer: quote.source.offer,
    },
    destination: {
      rail: route.rail ?? route.destination.scheme,
      quoted: quote.destination.quoted,
      asset: quote.destination.asset,
      network: quote.destination.network,
      quoteFingerprint: quote.destination.quoteFingerprint,
      // H-1（要件 FR-A14）: 静的 route の宛先は運用者が固定している。承認の記録に写せるように受取先と桁を**加える**（動的と同じ欄名）。
      payTo: route.destination.payTo,
      ...(route.destination.decimals === undefined ? {} : { decimals: route.destination.decimals }),
    },
    approval: {
      required: true,
      boundTo: quote.approval.boundTo,
      deadlineMs: quote.approval.deadlineMs,
    },
  };
}

/**
 * 動的 quote の応答で開示する前提（設計 §8）。固定値。`gasIndexedFee`（MPP 送信）では、quote の手数料は quote 時のガス代の見積りから決まり、
 * settle の後・署名の前に単価が上がっていれば Router は止める（返金しない。`docs/dynamic-gas-fee-design.md` §1.4・§4）。
 */
export function dynamicDisclosuresOf(fundsMoveOnCredential: boolean, gasIndexedFee = false): Record<string, unknown> {
  return {
    destinationVerifiedByOperator: false,
    refundOnFailure: false,
    fundsMoveOnCredential,
    ...(fundsMoveOnCredential
      ? {
          routerMayRejectAfterFundsMoved: [
            "expired",
            "upstream_changed",
            "dynamic_disabled",
            "budget_exhausted",
            "operator_funds_unavailable",
            ...(gasIndexedFee ? ["fee_too_high", "fee_estimate_unavailable"] : []),
          ],
        }
      : {}),
    ...(gasIndexedFee ? { feeEstimateIsNotADeliveryGuarantee: true, routerMayRejectAfterSettle: ["fee_too_high"] } : {}),
    awaitingPaymentDoesNotMeanUnpaid: fundsMoveOnCredential,
    unsupportedResponseIsPaidWithoutData: true,
    supportedResponse: "application/json object, <= 256 KiB",
  };
}

/**
 * R2: 動的 quote の文書（設計 §8）。静的の文書に `upstream`・`pricing`・`disclosures`・`ownerKey` を足し、
 * 受信・送信の `decimals`・`payTo` はプロファイルから。**`ownerKey` はこの応答にしか載らない。**
 */
export function dynamicQuoteBody(quote: QuoteDocument, profile: DynamicProfile, canonicalBaseUrl: string): unknown {
  const fundsMoveOnCredential = quote.dynamic?.fundsMoveOnCredential === true;
  const pricing = quote.dynamic?.pricing;
  return {
    quoteId: quote.quoteId,
    paymentId: quote.paymentId,
    routeId: quote.routeId,
    resource: { url: `${canonicalBaseUrl}${canonicalPathOf(profile.profileId)}`, method: "GET" },
    upstream: quote.upstream,
    source: {
      rail: profile.sourceRail,
      amount: quote.source.amount,
      asset: quote.source.asset,
      decimals: profile.source.decimals,
      network: quote.source.network,
      payTo: quote.source.offer.payTo,
      expiresAt: quote.source.offer.extra.expiresAt,
      offer: quote.source.offer,
    },
    destination: {
      rail: profile.rail,
      quoted: quote.destination.quoted,
      asset: quote.destination.asset,
      decimals: profile.destination.decimals,
      network: quote.destination.network,
      payTo: quote.destination.payTo,
      quoteFingerprint: quote.destination.quoteFingerprint,
    },
    pricing: { ...pricing, sourceDecimals: profile.source.decimals, destinationDecimals: profile.destination.decimals },
    disclosures: dynamicDisclosuresOf(fundsMoveOnCredential, usesGasIndexedFee(profile)),
    approval: { required: true, boundTo: quote.approval.boundTo, deadlineMs: quote.approval.deadlineMs },
    ownerKey: quote.ownerKey,
  };
}

/**
 * R3 の 402。既存 quote があればその発行 offer をそのまま再提示し、無ければ
 * 「R2 で quote を取得せよ」という指示（`quoteUrl` と `routeId` のみ）を返す。
 * どちらも新しい quote・intent・孤児レコードを作らない。
 */
export function paymentRequiredBody(
  routeId: string,
  quoteUrl: string,
  offer: InboundOffer | undefined,
  error: string,
): unknown {
  return {
    x402Version: 2,
    error,
    routeId,
    quoteUrl,
    accepts: offer === undefined ? [] : [offer],
  };
}

/** R4: 固定の公開射影。`result` は `delivered` のときだけ現れる。 */
export function projectionBody(projection: Projection): unknown {
  return {
    paymentId: projection.paymentId,
    routeId: projection.routeId,
    status: projection.status,
    source: {
      amount: projection.source.amount,
      asset: projection.source.asset,
      network: projection.source.network,
      ...(projection.source.txRef === undefined ? {} : { txRef: projection.source.txRef }),
    },
    destination: {
      quoted: projection.destination.quoted,
      asset: projection.destination.asset,
      network: projection.destination.network,
      attempt: projection.destination.attempt,
      outcome: projection.destination.outcome,
      ...(projection.destination.txRef === undefined
        ? {}
        : { txRef: projection.destination.txRef }),
      ...(projection.destination.receiptRef === undefined
        ? {}
        : { receiptRef: projection.destination.receiptRef }),
    },
    quoteFingerprint: projection.quoteFingerprint,
    ...(projection.terminalReason === undefined
      ? {}
      : { terminalReason: projection.terminalReason }),
    updatedAt: projection.updatedAt,
    ...(projection.status === "delivered" && projection.result !== undefined
      ? { result: projection.result }
      : {}),
    // 動的購入だけ。昇格前の `awaiting_payment` は、MPP 受信では「未払い」を意味しない（設計 §6.3・§8）。
    ...(projection.upstream === undefined || projection.dynamic === undefined
      ? {}
      : {
          upstream: projection.upstream,
          dynamic: {
            profileId: projection.dynamic.profileId,
            pricing: projection.dynamic.pricing,
            promoted: projection.dynamic.promoted,
            fundsMoveOnCredential: projection.dynamic.fundsMoveOnCredential,
            awaitingPaymentDoesNotMeanUnpaid: projection.dynamic.fundsMoveOnCredential && projection.status === "awaiting_payment",
          },
        }),
  };
}
