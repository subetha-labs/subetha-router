/** 式の価格の供給（`docs/exact-pricing-design.md` §1）: 費用の読み取りと、運用者が設定した ETH の価格から内訳を作る。 */
import type { ExactPricing } from "../../ports/exact-pricing.js";
import { computeExactPrice, ethPriceUsable, type EthPrice } from "../../shared/exact-pricing.js";
import type { SettleCostsReader } from "./settle-costs.js";

/**
 * 固定の額の route の受付の確認（`docs/exact-costs-reader-design.md` C7）。**式の route には読まずに不明を返す**（価格を決める段で受付も見ている。
 * ここでも見ると、価格の後に変わった受付で、決めた価格の注文が断られ得る）。
 */
export function settleAcceptingOf(costs: SettleCostsReader, routes: readonly { readonly routeId: string; readonly pricing?: unknown }[]): (routeId: string) => Promise<boolean | undefined> {
  const fixed = new Set(routes.filter((route) => route.pricing === undefined).map((route) => route.routeId));
  return async (routeId) => (fixed.has(routeId) ? (await costs.read()).accepting : undefined);
}

export function createExactPricing(options: { readonly costs: SettleCostsReader; readonly ethPrice?: EthPrice; readonly now?: () => number }): ExactPricing {
  const now = options.now ?? (() => Date.now());
  return {
    async price(_routeId, pricing, upstreamAmount) {
      // ETH の価格が使えなければ、費用も読みに行かない。
      if (!ethPriceUsable(options.ethPrice, now(), pricing.ethPriceMaxAgeDays)) return { ok: false, reason: "pricing_unavailable" };
      // 費用と受付は 1 回の読み取りの同じ時点の値。受付が true と分からなければ売らない（`docs/exact-costs-reader-design.md` C6）。
      const { costs, accepting } = await options.costs.read();
      const ethPrice = options.ethPrice;
      // 読み取りの間に期限を過ぎた場合も断る。
      if (accepting !== true || costs === undefined || !ethPriceUsable(ethPrice, now(), pricing.ethPriceMaxAgeDays)) return { ok: false, reason: "pricing_unavailable" };
      return computeExactPrice(pricing, upstreamAmount, costs, ethPrice.price);
    },
  };
}
