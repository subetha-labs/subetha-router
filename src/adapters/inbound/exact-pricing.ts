/** 式の価格の供給（`docs/exact-pricing-design.md` §1）: 費用の読み取りと、運用者が設定した ETH の価格から内訳を作る。 */
import type { ExactPricing } from "../../ports/exact-pricing.js";
import { computeExactPrice, ethPriceUsable, type EthPrice } from "../../shared/exact-pricing.js";
import type { SettleCostsReader } from "./settle-costs.js";

export function createExactPricing(options: { readonly costs: SettleCostsReader; readonly ethPrice?: EthPrice; readonly now?: () => number }): ExactPricing {
  const now = options.now ?? (() => Date.now());
  return {
    async price(_routeId, pricing, upstreamAmount) {
      // ETH の価格が使えなければ、費用も読みに行かない。
      if (!ethPriceUsable(options.ethPrice, now(), pricing.ethPriceMaxAgeDays)) return { ok: false, reason: "pricing_unavailable" };
      const costs = await options.costs.read();
      const ethPrice = options.ethPrice;
      // 読み取りの間に期限を過ぎた場合も断る。
      if (costs === undefined || !ethPriceUsable(ethPrice, now(), pricing.ethPriceMaxAgeDays)) return { ok: false, reason: "pricing_unavailable" };
      return computeExactPrice(pricing, upstreamAmount, costs, ethPrice.price);
    },
  };
}
