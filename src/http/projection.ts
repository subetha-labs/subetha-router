/**
 * 公開射影（設計 §7）。固定のフィールドだけを組み立て、journal の生レコード・
 * 上流 URL・principal トークン・内部ヘッダ・例外文字列は決して載せない。
 */

import type { RouteConfig, RouterConfig } from "../config.js";
import type { Projection, QuoteDocument } from "../core/orchestrator.js";
import type { InboundOffer } from "../ports/inbound.js";

export function canonicalUrlOf(canonicalBaseUrl: string, route: RouteConfig): string {
  return `${canonicalBaseUrl}${route.canonicalPath}`;
}

/** R1: allowlist の `routeId`・canonical URL・資産メタのみ（上流 URL は返さない）。 */
export function routeListBody(config: RouterConfig, canonicalBaseUrl: string): unknown {
  return {
    routes: Object.values(config.routes).map((route) => ({
      routeId: route.routeId,
      resource: { url: canonicalUrlOf(canonicalBaseUrl, route), method: "GET" },
      source: {
        amount: route.source.amount,
        asset: route.source.asset,
        decimals: route.source.decimals,
        network: route.source.network,
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
    },
    approval: {
      required: true,
      boundTo: quote.approval.boundTo,
      deadlineMs: quote.approval.deadlineMs,
    },
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
  };
}
