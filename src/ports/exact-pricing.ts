/** 式の価格の供給（`docs/exact-pricing-design.md` §1）。core は base units の内訳だけを受け取る（wei・ETH の価格・token は知らない）。投げてもよい（core が断る）。 */
import type { ExactPrice, ExactPriceFailure, ExactPricingConfig } from "../shared/exact-pricing.js";

export interface ExactPricing {
  price(routeId: string, pricing: ExactPricingConfig, upstreamAmount: string): Promise<{ readonly ok: true; readonly price: ExactPrice } | { readonly ok: false; readonly reason: ExactPriceFailure }>;
}
