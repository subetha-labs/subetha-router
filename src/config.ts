/**
 * allowlist と上限（設計 §3 / §5）。秘密は保持せず、上流 URL も core には出さない。
 */

export interface SourceTerms {
  readonly amount: string;
  readonly asset: string;
  readonly decimals: number;
  readonly network: string;
}

/** 送信レグとして受け入れてよい offer の集合（field 単位の一致に使う）。 */
export interface DestinationAllow {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
}

export interface RouteConfig {
  readonly routeId: string;
  /** Router canonical resource のパス（クエリなし・GET のみ）。 */
  readonly canonicalPath: string;
  /** 受信額は Router のローカル設定が権威（上流額から導出しない／U-03）。 */
  readonly source: SourceTerms;
  readonly destination: DestinationAllow;
}

export interface BucketLimit {
  readonly network: string;
  readonly asset: string;
  /** 全購入を通算した累計上限。 */
  readonly maxTotal: string;
  /** 1 件の購入がこのバケットで使える上限。 */
  readonly maxPerPurchase: string;
}

export interface BudgetLimits {
  /** 全購入を通算する件数上限（全体で 1 本）。 */
  readonly maxPurchases: number;
  /** `(network, asset)` ごとの累計上限。異資産の生数値は足さない。 */
  readonly buckets: readonly BucketLimit[];
}

export interface RouterConfig {
  readonly routes: Readonly<Record<string, RouteConfig>>;
  readonly budget: BudgetLimits;
  readonly approvalTtlMs: number;
}

export function resolveRoute(config: RouterConfig, routeId: string): RouteConfig | undefined {
  return Object.hasOwn(config.routes, routeId) ? config.routes[routeId] : undefined;
}

/** `routeId|GET|<canonical path>` を encodeURIComponent して `|` 連結した 1 本の束縛文字列。 */
export function routeBindingOf(route: RouteConfig): string {
  return [route.routeId, "GET", route.canonicalPath].map(encodeURIComponent).join("|");
}
