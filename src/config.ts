/**
 * allowlist と上限（設計 §3 / §5）。秘密は保持せず、上流 URL も core には出さない。
 */

/** 受信レグの受取先アドレス形式（x402 受信で使う）。 */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export interface SourceTerms {
  readonly amount: string;
  readonly asset: string;
  readonly decimals: number;
  readonly network: string;
  /**
   * 受信レグの受取先（Router 自身のアドレス）。**`sourceRail: "x402"` のときだけ必須**。
   * SubEtha 受信では facilitator が challenge で `payTo` を返すので構成には持たない。
   */
  readonly payTo?: string;
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
  /** 送信レールの表示名（`x402` / `mpp`）。core は rail 名で分岐しない。 */
  readonly rail?: string;
  /**
   * 受信レールの表示名（`subetha` / `x402`）。**未指定は `subetha`**（既存構成を壊さない）。
   * core は rail 名で分岐せず、合成側（`src/main.ts`）が adapter を選ぶ。
   */
  readonly sourceRail?: string;
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

/**
 * 動的上流 URL のプロファイル（設計 `docs/dynamic-upstream-design.md` §1）。
 * 運用者が宣言する「**宛先だけが空いた route**」。額と受取先（送信側）は quote ごとに上流が決め、
 * それ以外（レール・資産・受信の受取先・手数料・上限）はここが権威。
 */
export interface DynamicProfile {
  /** `routeId` と同じ文字種・同じ名前空間（route と重複したら起動しない）。 */
  readonly profileId: string;
  /** 受信レール。SubEtha 受信は対象外。 */
  readonly sourceRail: "x402" | "mpp";
  /** 受信条件。**額は持たない**（上流額＋手数料で quote ごとに決まる）。 */
  readonly source: {
    readonly network: string;
    readonly asset: string;
    readonly decimals: number;
    readonly payTo: string;
  };
  /** 送信レール。 */
  readonly rail: "x402" | "mpp";
  readonly destination: {
    readonly scheme: string;
    readonly network: string;
    readonly asset: string;
    readonly decimals: number;
    /** x402 送信: EIP-712 domain の権威（上流の offer ではなくここ）。 */
    readonly tokenDomain?: { readonly name: string; readonly version: string };
    /** mpp 送信: 手数料に使ってよい資産。 */
    readonly feeAsset?: string;
    /** mpp 送信: 1 件の手数料の上限（`feeAsset` の base units）。 */
    readonly maxFee?: string;
  };
  /** 受信資産と送信資産を 1:1 とみなす宣言。`true` 以外は起動しない。 */
  readonly par: true;
  /** 上流額の上限（送信資産の base units）。 */
  readonly maxUpstreamAmount: string;
  /** 手数料規則（受信資産の base units）。`max(min, flat + ceil(額 × bps / 10000))`。 */
  readonly fee: { readonly flat: string; readonly bps: number; readonly min: string };
}

/** 匿名利用の上限（設計 §7.3）。頻度は 1 分あたり。 */
export interface DynamicLimits {
  readonly quotesPerMinuteGlobal: number;
  readonly quotesPerMinutePerSource: number;
  readonly purchasesPerMinuteGlobal: number;
  readonly purchasesPerMinutePerSource: number;
  readonly concurrentGlobal: number;
  readonly concurrentPerSource: number;
  readonly maxOutstandingQuotes: number;
  readonly perHostPerMinute: number;
  readonly perHostConcurrent: number;
  readonly perAddressPerMinute: number;
  readonly perAddressConcurrent: number;
  /** quote 控えの保持日数。 */
  readonly ledgerRetentionDays: number;
}

export const DEFAULT_DYNAMIC_LIMITS: DynamicLimits = Object.freeze({
  quotesPerMinuteGlobal: 10,
  quotesPerMinutePerSource: 3,
  purchasesPerMinuteGlobal: 10,
  purchasesPerMinutePerSource: 3,
  concurrentGlobal: 8,
  concurrentPerSource: 2,
  maxOutstandingQuotes: 200,
  perHostPerMinute: 10,
  perHostConcurrent: 2,
  perAddressPerMinute: 60,
  perAddressConcurrent: 4,
  ledgerRetentionDays: 7,
});

export interface DynamicConfig {
  /** 既定は無効。**設定ファイルでだけ**有効にできる（env・呼び出し側の入力からは変わらない）。 */
  readonly enabled: boolean;
  readonly profiles: Readonly<Record<string, DynamicProfile>>;
  /** 静的 route とは別に数える通算の上限。 */
  readonly budget: BudgetLimits;
  readonly limits: DynamicLimits;
  /** 動的 URL の宛先にできないホスト名（サブドメインを含む）。 */
  readonly denyHosts: readonly string[];
}

export interface RouterConfig {
  readonly routes: Readonly<Record<string, RouteConfig>>;
  readonly budget: BudgetLimits;
  readonly approvalTtlMs: number;
  /** 動的上流 URL。**省略時は機能そのものが無い。** */
  readonly dynamic?: DynamicConfig;
}

/**
 * プロファイルを引く。**`enabled` に関わらず解決できる**（無効化した後も、発行済みの quote と
 * journal の記録がどのプロファイルのものかを判定するため）。有効かどうかは呼び出し側が見る。
 */
export function resolveProfile(config: RouterConfig, profileId: string): DynamicProfile | undefined {
  const profiles = config.dynamic?.profiles;
  return profiles !== undefined && Object.hasOwn(profiles, profileId) ? profiles[profileId] : undefined;
}

/**
 * プロファイルの**支払いの権威**にあたる部分（静的 route の `authoritativeTermsOf` に対応）。
 * 「変わったら、変更前の quote で払ってはいけない」欄をすべて含める: プロファイルの全欄と `enabled`。
 * 頻度の上限・拒否ホスト・動的予算は支払いの条件ではないので含めない。
 */
export function dynamicAuthoritativeTermsOf(dynamic: DynamicConfig, profile: DynamicProfile): unknown {
  return {
    dynamic: true,
    enabled: dynamic.enabled,
    profileId: profile.profileId,
    sourceRail: profile.sourceRail,
    source: { ...profile.source },
    rail: profile.rail,
    destination: {
      scheme: profile.destination.scheme,
      network: profile.destination.network,
      asset: profile.destination.asset,
      decimals: profile.destination.decimals,
      tokenDomain: profile.destination.tokenDomain,
      feeAsset: profile.destination.feeAsset,
      maxFee: profile.destination.maxFee,
    },
    par: profile.par,
    maxUpstreamAmount: profile.maxUpstreamAmount,
    fee: { ...profile.fee },
  };
}

export function resolveRoute(config: RouterConfig, routeId: string): RouteConfig | undefined {
  return Object.hasOwn(config.routes, routeId) ? config.routes[routeId] : undefined;
}

/**
 * `routeId` として許す形（パス安全）。`/`・`%`・`.` を含む値はパスの別名や
 * 正規化の差を作り得るので受け付けない。
 */
const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Router が実際に提供する唯一の購入パス。設定の `canonicalPath` はこれと一致していなければ
 * ならない（承認対象として提示したパスと、実際に購入が走るパスを同一にする）。
 */
export function canonicalPathOf(routeId: string): string {
  return `/v1/routes/${routeId}/resource`;
}

/** `routeId|GET|<canonical path>` を encodeURIComponent して `|` 連結した 1 本の束縛文字列。 */
export function routeBindingOf(route: RouteConfig): string {
  return [route.routeId, "GET", route.canonicalPath].map(encodeURIComponent).join("|");
}

/**
 * route 設定のうち**支払いの権威**にあたる部分だけを取り出す（設計 §9.2）。
 *
 * 含めるのは「変わったら、その quote で払ってはいけない」欄:
 * 宛先の scheme/network/asset/**payTo**、受信の金額・資産・network・payTo、両レール名。
 *
 * **含めないもの**:
 * - `canonicalPath` — `routeId` から導出される（`canonicalPathOf`）ので独立した情報を持たない
 * - `decimals` — 表示用。決済は base unit の `amount` で行う
 * - 上流 URL — 宛先条件の保護には不要（同一 offer なら受取先も額も同じ）。
 *   **「Provider 差し替えの検出」ではない**ことを設計 §8.4 に記録した
 *
 * `source.payTo` は SubEtha では存在しない。`stableJson` が **undefined の欄を除外**する
 * （`core/intent.ts`）ので、欄の有無で指紋がぶれることはない。
 */
export function authoritativeTermsOf(route: RouteConfig): unknown {
  return {
    destination: {
      scheme: route.destination.scheme,
      network: route.destination.network,
      asset: route.destination.asset,
      payTo: route.destination.payTo,
    },
    source: {
      amount: route.source.amount,
      asset: route.source.asset,
      network: route.source.network,
      payTo: route.source.payTo,
    },
    rail: route.rail,
    sourceRail: route.sourceRail,
  };
}

/* ------------------------------------------------------------------------- *
 * 起動時のランタイム構成（CLI が読む。秘密は env からのみ受け取り、出力しない）
 * ------------------------------------------------------------------------- */

/**
 * adapter の解決方式。`real` が**既定**で、合成レールは `synthetic` を
 * 明示したときだけ選ばれる（未設定時に synthetic へ落とさない）。
 */
export type AdapterMode = "real" | "synthetic";

/** 合成レールの接続先。いずれも loopback に限る（無課金 fixture 用）。 */
export interface SyntheticRailsConfig {
  readonly facilitatorUrl: string;
  /** `routeId` → 上流 canonical URL。**公開応答には出さない。** */
  readonly upstreams: Readonly<Record<string, string>>;
  /**
   * 合成専用の試験用シーム。指定すると R3 の応答バイトを出す**直前**で停止し、
   * このパスに到達の合図を書く（応答前クラッシュの再現用）。`synthetic` セクション
   * にしか書けないので、既定の `real` 構成では**読まれることすらない**。
   */
  readonly crashBarrierPath?: string;
}

export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  /** canonical URL の基点。リクエストの `Host` からは導かない。 */
  readonly canonicalBaseUrl: string;
}

/**
 * 実レールの接続先（設計 §4.1 / §4.2）。**値の差し替えだけで実 facilitator・実上流へ届く**
 * 形にし、コード側に URL・資産を埋め込まない。署名能力はここではなく注入で渡す。
 */
export interface RealRailsConfig {
  /** 実 SubEtha facilitator の base URL（設定 1 本だけ）。 */
  readonly subethaFacilitatorUrl: string;
  /** `routeId` → 上流 canonical URL（クエリ無しの GET 1 本）。公開応答には出さない。 */
  readonly upstreams: Readonly<Record<string, string>>;
  /**
   * x402 **受信**レグの facilitator（`ROUTER_X402_INBOUND_FACILITATOR_URL`）。
   * SubEtha 受信の facilitator とは**別のキー**（専用名を流用しない）。
   * `sourceRail: "x402"` の route があるときだけ必須。
   */
  readonly x402InboundFacilitatorUrl?: string;
  /**
   * x402 受信 offer の有効期間（秒）。`ROUTER_X402_INBOUND_OFFER_SECONDS`。
   * 承認期限は `min(approvalTtlMs, offerExpiry)` なので、**ここが実効的な上限**になる。
   * 人間が承認に関与する運用では、その所要時間を賄う値にする。
   */
  readonly x402InboundOfferSeconds?: number;
  /**
   * MPP **受信**レグの challenge HMAC 束縛鍵（`ROUTER_MPP_INBOUND_SECRET`、32 バイト以上）。
   * **署名鍵ではない**（受信側の Router は受取人なので署名しない）が秘密。
   * `sourceRail: "mpp"` の route があるときだけ必須。
   */
  readonly mppInboundSecret?: string;
  /**
   * MPP 受信 offer の有効期間（秒）。`ROUTER_MPP_INBOUND_OFFER_SECONDS`。
   * **必ず adapter に渡す**: mppx の challenge は `expires` が任意で、
   * 渡さないと `expiresAt` が埋まらず失効検査が発火しない。
   */
  readonly mppInboundOfferSeconds?: number;
  /**
   * MPP 受信の JSON-RPC（`ROUTER_MPP_INBOUND_RPC_URL`、任意）。無ければ adapter が chain の既知の公開 RPC を使う。
   * 動的上流 URL の拒否ホストにもこのホストを入れる（自分の依存先には向けない）。
   */
  readonly mppInboundRpcUrl?: string;
}

export interface RuntimeConfig {
  readonly router: RouterConfig;
  readonly http: HttpConfig;
  readonly journalPath: string;
  /** principalId → token。応答・ログ・journal に出さない。 */
  readonly principals: ReadonlyMap<string, string>;
  readonly adapterMode: AdapterMode;
  readonly synthetic?: SyntheticRailsConfig;
  readonly real?: RealRailsConfig;
}

/** 構成が成立しない（起動しない）。メッセージに秘密の値を載せない。 */
export class ConfigError extends Error {
  readonly code = "config_invalid";

  constructor(detail: string) {
    super(`router config invalid: ${detail}`);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string, at: string): string {
  const value = source[key];
  if (typeof value !== "string" || value === "") {
    throw new ConfigError(`${at}.${key} must be a non-empty string`);
  }
  return value;
}

function requireNumber(source: Record<string, unknown>, key: string, at: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${at}.${key} must be a number`);
  }
  return value;
}

function requireRecord(source: Record<string, unknown>, key: string, at: string): Record<string, unknown> {
  const value = source[key];
  if (!isRecord(value)) {
    throw new ConfigError(`${at}.${key} must be an object`);
  }
  return value;
}

/** 合成レールの接続先は loopback のみ。任意のホストへは向けない。 */
export function assertLoopbackUrl(raw: string, at: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${at} must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${at} must use http(s)`);
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new ConfigError(`${at} must target loopback (synthetic fixtures only)`);
  }
  return url.toString().replace(/\/$/, "");
}

function parseRoute(value: unknown, routeId: string): RouteConfig {
  if (!isRecord(value)) {
    throw new ConfigError(`routes.${routeId} must be an object`);
  }
  const at = `routes.${routeId}`;
  if (requireString(value, "routeId", at) !== routeId) {
    throw new ConfigError(`${at}.routeId must match its key`);
  }
  if (!ROUTE_ID_PATTERN.test(routeId)) {
    throw new ConfigError(`${at}.routeId must match ${ROUTE_ID_PATTERN.source} (path-safe)`);
  }
  const canonicalPath = requireString(value, "canonicalPath", at);
  // 提供できないパスを承認対象として提示しない（提示 URL と購入口を必ず同一にする）。
  if (canonicalPath !== canonicalPathOf(routeId)) {
    throw new ConfigError(`${at}.canonicalPath must be exactly ${canonicalPathOf(routeId)}`);
  }
  const source = requireRecord(value, "source", at);
  const destination = requireRecord(value, "destination", at);
  const rail = value["rail"];
  if (rail !== undefined && (typeof rail !== "string" || rail === "")) {
    throw new ConfigError(`${at}.rail must be a non-empty string when present`);
  }
  const sourceRailRaw = value["sourceRail"];
  if (
    sourceRailRaw !== undefined &&
    sourceRailRaw !== "subetha" &&
    sourceRailRaw !== "x402" &&
    sourceRailRaw !== "mpp"
  ) {
    throw new ConfigError(`${at}.sourceRail must be "subetha", "x402" or "mpp" when present`);
  }
  const sourceRail = sourceRailRaw as string | undefined;
  const sourcePayToRaw = source["payTo"];
  if (sourcePayToRaw !== undefined && (typeof sourcePayToRaw !== "string" || !ADDRESS_PATTERN.test(sourcePayToRaw))) {
    throw new ConfigError(`${at}.source.payTo must be a 0x address when present`);
  }
  const sourcePayTo = sourcePayToRaw as string | undefined;
  // 受取先が構成に要るのは Router が自分で offer を作るレール（x402 / mpp）。
  // SubEtha は facilitator が challenge で payTo を返すので持たない。
  if ((sourceRail === "x402" || sourceRail === "mpp") && sourcePayTo === undefined) {
    throw new ConfigError(`${at}.source.payTo is required when sourceRail is "${sourceRail}"`);
  }
  return {
    routeId,
    canonicalPath,
    ...(rail === undefined ? {} : { rail }),
    ...(sourceRail === undefined ? {} : { sourceRail }),
    source: {
      amount: requireString(source, "amount", `${at}.source`),
      asset: requireString(source, "asset", `${at}.source`),
      decimals: requireNumber(source, "decimals", `${at}.source`),
      network: requireString(source, "network", `${at}.source`),
      ...(sourcePayTo === undefined ? {} : { payTo: sourcePayTo }),
    },
    destination: {
      scheme: requireString(destination, "scheme", `${at}.destination`),
      network: requireString(destination, "network", `${at}.destination`),
      asset: requireString(destination, "asset", `${at}.destination`),
      payTo: requireString(destination, "payTo", `${at}.destination`),
    },
  };
}

function parseBudget(value: Record<string, unknown>): BudgetLimits {
  const maxPurchases = requireNumber(value, "maxPurchases", "budget");
  const buckets = value["buckets"];
  if (!Array.isArray(buckets) || buckets.length === 0) {
    throw new ConfigError("budget.buckets must be a non-empty array");
  }
  return {
    maxPurchases,
    buckets: buckets.map((bucket, index) => {
      if (!isRecord(bucket)) {
        throw new ConfigError(`budget.buckets[${index}] must be an object`);
      }
      const at = `budget.buckets[${index}]`;
      return {
        network: requireString(bucket, "network", at),
        asset: requireString(bucket, "asset", at),
        maxTotal: requireString(bucket, "maxTotal", at),
        maxPerPurchase: requireString(bucket, "maxPerPurchase", at),
      };
    }),
  };
}

/** 10 進の非負整数（先頭ゼロ・符号・指数・小数を受け付けない）。30 桁まで。 */
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,29})$/;
/** ホスト名（小文字・数字・ハイフンのラベルをドットでつないだもの）。URL・ポート・末尾ドットは不可。 */
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function requireAmount(source: Record<string, unknown>, key: string, at: string, positive: boolean): string {
  const value = requireString(source, key, at);
  if (!AMOUNT_PATTERN.test(value) || (positive && value === "0")) {
    throw new ConfigError(`${at}.${key} must be a ${positive ? "positive" : "non-negative"} base-unit integer string`);
  }
  return value;
}

function requireDecimals(source: Record<string, unknown>, at: string): number {
  const value = requireNumber(source, "decimals", at);
  if (!Number.isInteger(value) || value < 0 || value > 36) {
    throw new ConfigError(`${at}.decimals must be an integer in 0..36`);
  }
  return value;
}

function parseDynamicProfile(value: unknown, profileId: string, routes: Readonly<Record<string, unknown>>): DynamicProfile {
  const at = `dynamic.profiles.${profileId}`;
  if (!isRecord(value)) {
    throw new ConfigError(`${at} must be an object`);
  }
  if (!ROUTE_ID_PATTERN.test(profileId)) {
    throw new ConfigError(`${at}: profileId must match ${ROUTE_ID_PATTERN.source}`);
  }
  if (requireString(value, "profileId", at) !== profileId) {
    throw new ConfigError(`${at}.profileId must match its key`);
  }
  // route と同じ名前空間（購入口のパス・起動時の Map を共有する）。
  if (Object.hasOwn(routes, profileId)) {
    throw new ConfigError(`${at}: profileId collides with a routeId`);
  }
  const sourceRail = value["sourceRail"];
  if (sourceRail !== "x402" && sourceRail !== "mpp") {
    throw new ConfigError(`${at}.sourceRail must be "x402" or "mpp"`);
  }
  const rail = value["rail"];
  if (rail !== "x402" && rail !== "mpp") {
    throw new ConfigError(`${at}.rail must be "x402" or "mpp"`);
  }
  if (value["par"] !== true) {
    throw new ConfigError(`${at}.par must be true (the operator declares the pair as 1:1)`);
  }
  const source = requireRecord(value, "source", at);
  const payTo = requireString(source, "payTo", `${at}.source`);
  if (!ADDRESS_PATTERN.test(payTo)) {
    throw new ConfigError(`${at}.source.payTo must be a 0x address`);
  }
  const destination = requireRecord(value, "destination", at);
  let tokenDomain: { name: string; version: string } | undefined;
  let feeAsset: string | undefined;
  let maxFee: string | undefined;
  if (rail === "x402") {
    const domain = requireRecord(destination, "tokenDomain", `${at}.destination`);
    tokenDomain = {
      name: requireString(domain, "name", `${at}.destination.tokenDomain`),
      version: requireString(domain, "version", `${at}.destination.tokenDomain`),
    };
  } else {
    feeAsset = requireString(destination, "feeAsset", `${at}.destination`);
    maxFee = requireAmount(destination, "maxFee", `${at}.destination`, false);
  }
  const fee = requireRecord(value, "fee", at);
  const bps = requireNumber(fee, "bps", `${at}.fee`);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new ConfigError(`${at}.fee.bps must be an integer in 0..10000`);
  }
  const feeMin = requireAmount(fee, "min", `${at}.fee`, false);
  /**
   * **運営がチェーン手数料を負担しない不変条件**（G-1、owner の決定 2026-10-06）: MPP 送信では Router が Tempo の手数料を払う。
   * 署名前に `ceil(gas × maxFeePerGas / 10^12) <= maxFee` を確かめて超えたら払わないので、実際に払う手数料は必ず `maxFee` 以下。
   * 一方、呼び出し側は quote の手数料（`max(min, flat + ceil(額 × bps / 10000))` ≥ `min`）を先に払う。
   * よって `fee.min >= maxFee` なら、件数や単価に関わらず、運営がガス代で純減することは 1 件ごとに起きない。
   * 設定の値に頼らず、Router がこの不等式を起動時に確かめる。
   */
  if (maxFee !== undefined && BigInt(feeMin) < BigInt(maxFee)) {
    throw new ConfigError(`${at}.fee.min must be at least destination.maxFee for an mpp outbound profile (the operator must not subsidize the chain fee)`);
  }
  return {
    profileId,
    sourceRail,
    source: {
      network: requireString(source, "network", `${at}.source`),
      asset: requireString(source, "asset", `${at}.source`),
      decimals: requireDecimals(source, `${at}.source`),
      payTo,
    },
    rail,
    destination: {
      scheme: requireString(destination, "scheme", `${at}.destination`),
      network: requireString(destination, "network", `${at}.destination`),
      asset: requireString(destination, "asset", `${at}.destination`),
      decimals: requireDecimals(destination, `${at}.destination`),
      ...(tokenDomain === undefined ? {} : { tokenDomain }),
      ...(feeAsset === undefined ? {} : { feeAsset }),
      ...(maxFee === undefined ? {} : { maxFee }),
    },
    par: true,
    maxUpstreamAmount: requireAmount(value, "maxUpstreamAmount", at, true),
    fee: {
      flat: requireAmount(fee, "flat", `${at}.fee`, false),
      bps,
      min: feeMin,
    },
  };
}

function parseDynamicLimits(value: unknown): DynamicLimits {
  if (value === undefined) {
    return DEFAULT_DYNAMIC_LIMITS;
  }
  if (!isRecord(value)) {
    throw new ConfigError("dynamic.limits must be an object when present");
  }
  const limits: Record<string, number> = { ...DEFAULT_DYNAMIC_LIMITS };
  for (const [key, raw] of Object.entries(value)) {
    // 綴りを間違えた上限が黙って既定値になるのを防ぐ。
    if (!Object.hasOwn(DEFAULT_DYNAMIC_LIMITS, key)) {
      throw new ConfigError(`dynamic.limits.${key} is not a known limit`);
    }
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
      throw new ConfigError(`dynamic.limits.${key} must be a positive integer`);
    }
    limits[key] = raw;
  }
  return limits as unknown as DynamicLimits;
}

/**
 * 動的側の予算。形は静的と同じだが、**起動時に**額と件数を検査する
 * （静的の `parseBudget` は空でない文字列しか見ず、不正な額は予約のときに初めて落ちる。静的の挙動は変えない）。
 */
function parseDynamicBudget(value: Record<string, unknown>): BudgetLimits {
  const budget = parseBudget(value);
  if (!Number.isSafeInteger(budget.maxPurchases) || budget.maxPurchases < 1) {
    throw new ConfigError("dynamic.budget.maxPurchases must be a positive integer");
  }
  budget.buckets.forEach((bucket, index) => {
    for (const key of ["maxTotal", "maxPerPurchase"] as const) {
      if (!AMOUNT_PATTERN.test(bucket[key]) || bucket[key] === "0") {
        throw new ConfigError(`dynamic.budget.buckets[${index}].${key} must be a positive base-unit integer string`);
      }
    }
  });
  return budget;
}

function parseDynamic(value: unknown, routes: Readonly<Record<string, unknown>>): DynamicConfig {
  if (!isRecord(value)) {
    throw new ConfigError("dynamic must be an object when present");
  }
  if (typeof value["enabled"] !== "boolean") {
    throw new ConfigError("dynamic.enabled must be a boolean");
  }
  const profiles = Object.entries(requireRecord(value, "profiles", "dynamic"));
  if (profiles.length === 0) {
    throw new ConfigError("dynamic.profiles must not be empty");
  }
  // 既定にするのは**省略したときだけ**（`null` で拒否リストが黙って空になるのを防ぐ）。
  const denyHosts = value["denyHosts"] === undefined ? [] : value["denyHosts"];
  if (!Array.isArray(denyHosts) || denyHosts.some((host) => typeof host !== "string" || !HOSTNAME_PATTERN.test(host))) {
    throw new ConfigError("dynamic.denyHosts must be an array of lowercase hostnames");
  }
  return {
    enabled: value["enabled"],
    profiles: Object.fromEntries(profiles.map(([profileId, profile]) => [profileId, parseDynamicProfile(profile, profileId, routes)])),
    budget: parseDynamicBudget(requireRecord(value, "budget", "dynamic")),
    limits: parseDynamicLimits(value["limits"]),
    denyHosts: denyHosts as string[],
  };
}

/** allowlist・上限・canonical だけを持つ非秘密の構成ファイル。 */
export function parseRouterConfig(raw: unknown): RouterConfig {
  if (!isRecord(raw)) {
    throw new ConfigError("router must be an object");
  }
  const routes = requireRecord(raw, "routes", "router");
  const entries = Object.entries(routes);
  if (entries.length === 0) {
    throw new ConfigError("router.routes must not be empty");
  }
  return {
    approvalTtlMs: requireNumber(raw, "approvalTtlMs", "router"),
    routes: Object.fromEntries(entries.map(([routeId, route]) => [routeId, parseRoute(route, routeId)])),
    budget: parseBudget(requireRecord(raw, "budget", "router")),
    ...(raw["dynamic"] === undefined ? {} : { dynamic: parseDynamic(raw["dynamic"], routes) }),
  };
}

/** `id:token,id:token` 形式。token は解析するだけで、どこにも出力しない。 */
function parsePrincipals(raw: string | undefined): ReadonlyMap<string, string> {
  const principals = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") {
      continue;
    }
    const separator = trimmed.indexOf(":");
    const id = separator === -1 ? "" : trimmed.slice(0, separator).trim();
    const token = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
    if (id === "" || token === "") {
      throw new ConfigError("ROUTER_PRINCIPAL_TOKENS entries must be <principalId>:<token>");
    }
    if (principals.has(id)) {
      throw new ConfigError("ROUTER_PRINCIPAL_TOKENS has a duplicate principalId");
    }
    principals.set(id, token);
  }
  if (principals.size === 0) {
    throw new ConfigError("ROUTER_PRINCIPAL_TOKENS must define at least one principal");
  }
  return principals;
}

function parseSynthetic(raw: unknown, router: RouterConfig): SyntheticRailsConfig {
  if (!isRecord(raw)) {
    throw new ConfigError("synthetic section is required when ROUTER_ADAPTER_MODE=synthetic");
  }
  const upstreams = requireRecord(raw, "upstreams", "synthetic");
  const resolved: Record<string, string> = {};
  for (const routeId of Object.keys(router.routes)) {
    const upstream = upstreams[routeId];
    if (typeof upstream !== "string" || upstream === "") {
      throw new ConfigError(`synthetic.upstreams.${routeId} is required for every route`);
    }
    resolved[routeId] = assertLoopbackUrl(upstream, `synthetic.upstreams.${routeId}`);
  }
  const crashBarrierPath = raw["crashBarrierPath"];
  if (crashBarrierPath !== undefined && (typeof crashBarrierPath !== "string" || crashBarrierPath === "")) {
    throw new ConfigError("synthetic.crashBarrierPath must be a non-empty string when present");
  }
  return {
    facilitatorUrl: assertLoopbackUrl(
      requireString(raw, "facilitatorUrl", "synthetic"),
      "synthetic.facilitatorUrl",
    ),
    upstreams: resolved,
    ...(crashBarrierPath === undefined ? {} : { crashBarrierPath }),
  };
}

/** 実レールの接続先は絶対 http(s) URL。上流 canonical はクエリを持たない。 */
export function assertAbsoluteHttpUrl(raw: string, at: string, allowQuery = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${at} must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${at} must use http(s)`);
  }
  if (!allowQuery && url.search !== "") {
    throw new ConfigError(`${at} must not carry a query`);
  }
  // `user:pass@host` は曖昧さを持ち込む（どこが権威ある host か読み手で変わる）。
  // 既存運用の資格情報は**パスに入る**（`docs/DEPLOY.md`）ので、ここを拒否しても壊れない。
  if (url.username !== "" || url.password !== "") {
    throw new ConfigError(`${at} must not carry userinfo`);
  }
  // fragment はサーバへ送られないので、設定値に書かれていれば設定ミス。
  // **空の fragment（末尾 `#`）は `url.hash` が空文字**になるため、
  // パース結果ではなく**生の文字列に区切り子があるか**で見る（レビュー指摘4）。
  if (url.hash !== "" || raw.includes("#")) {
    throw new ConfigError(`${at} must not carry a fragment`);
  }
  return url.toString();
}

/**
 * 実レールの構成（`ROUTER_ADAPTER_MODE=real`）。合成セクションは読まない。
 * 署名能力は構成ファイルからは読み込まない（任意のプラグイン読み込みをしない）。
 */
function parseReal(
  raw: unknown,
  router: RouterConfig,
  env: Readonly<Record<string, string | undefined>>,
): RealRailsConfig {
  const inboundFacilitatorUrl = env["ROUTER_X402_INBOUND_FACILITATOR_URL"];
  const inboundOfferSeconds = parseOfferSeconds(
    env["ROUTER_X402_INBOUND_OFFER_SECONDS"],
    "ROUTER_X402_INBOUND_OFFER_SECONDS",
  );
  const mppInboundOfferSeconds = parseOfferSeconds(
    env["ROUTER_MPP_INBOUND_OFFER_SECONDS"],
    "ROUTER_MPP_INBOUND_OFFER_SECONDS",
  );
  const mppInboundSecretRaw = env["ROUTER_MPP_INBOUND_SECRET"];
  let mppInboundSecret: string | undefined;
  if (mppInboundSecretRaw !== undefined && mppInboundSecretRaw !== "") {
    // SDK の要求。短い鍵で HMAC 束縛が弱いまま起動させない。
    if (mppInboundSecretRaw.length < 32) {
      throw new ConfigError("ROUTER_MPP_INBOUND_SECRET must be at least 32 bytes");
    }
    mppInboundSecret = mppInboundSecretRaw;
  }
  const mppInboundRpcRaw = env["ROUTER_MPP_INBOUND_RPC_URL"];
  const mppInboundRpcUrl = mppInboundRpcRaw === undefined || mppInboundRpcRaw === "" ? undefined : assertAbsoluteHttpUrl(mppInboundRpcRaw, "ROUTER_MPP_INBOUND_RPC_URL");
  const facilitatorUrl = env["ROUTER_SUBETHA_FACILITATOR_URL"];
  if (facilitatorUrl === undefined || facilitatorUrl === "") {
    throw new ConfigError("ROUTER_SUBETHA_FACILITATOR_URL is required when ROUTER_ADAPTER_MODE=real");
  }
  if (!isRecord(raw)) {
    throw new ConfigError("x402 section is required when ROUTER_ADAPTER_MODE=real");
  }
  const upstreams = requireRecord(raw, "upstreams", "x402");
  const resolved: Record<string, string> = {};
  for (const routeId of Object.keys(router.routes)) {
    const upstream = upstreams[routeId];
    if (typeof upstream !== "string" || upstream === "") {
      throw new ConfigError(`x402.upstreams.${routeId} is required for every route`);
    }
    resolved[routeId] = assertAbsoluteHttpUrl(upstream, `x402.upstreams.${routeId}`);
  }
  return {
    ...(inboundOfferSeconds === undefined ? {} : { x402InboundOfferSeconds: inboundOfferSeconds }),
    ...(mppInboundOfferSeconds === undefined ? {} : { mppInboundOfferSeconds }),
    ...(mppInboundRpcUrl === undefined ? {} : { mppInboundRpcUrl }),
    ...(mppInboundSecret === undefined ? {} : { mppInboundSecret }),
    ...(inboundFacilitatorUrl === undefined
      ? {}
      : {
          x402InboundFacilitatorUrl: assertAbsoluteHttpUrl(
            inboundFacilitatorUrl,
            "ROUTER_X402_INBOUND_FACILITATOR_URL",
          ),
        }),
    subethaFacilitatorUrl: assertAbsoluteHttpUrl(
      facilitatorUrl,
      "ROUTER_SUBETHA_FACILITATOR_URL",
      true,
    ).replace(/\/$/, ""),
    upstreams: resolved,
  };
}

/** 受信 offer の有効期間（秒）。1..3600 の整数だけを受ける。 */
function parseOfferSeconds(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 3600) {
    throw new ConfigError(`${name} must be an integer in 1..3600`);
  }
  return parsed;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError("ROUTER_HTTP_PORT must be an integer in 0..65535");
  }
  return port;
}

/**
 * env と非秘密の構成ファイルからランタイム構成を組む。
 * 既定の `ROUTER_ADAPTER_MODE` は `real` で、合成レールへは**落とさない**。
 */
export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
  readConfigFile: (path: string) => string,
): RuntimeConfig {
  const configPath = env["ROUTER_CONFIG_PATH"];
  if (configPath === undefined || configPath === "") {
    throw new ConfigError("ROUTER_CONFIG_PATH is required");
  }
  let document: unknown;
  try {
    document = JSON.parse(readConfigFile(configPath));
  } catch (error) {
    throw new ConfigError(`ROUTER_CONFIG_PATH could not be read as JSON (${(error as Error).name})`);
  }
  if (!isRecord(document)) {
    throw new ConfigError("config file must contain a JSON object");
  }

  const router = parseRouterConfig(document["router"]);
  const mode = env["ROUTER_ADAPTER_MODE"] ?? "real";
  if (mode !== "real" && mode !== "synthetic") {
    throw new ConfigError("ROUTER_ADAPTER_MODE must be 'real' or 'synthetic'");
  }
  const canonicalBaseUrl = (env["ROUTER_CANONICAL_BASE_URL"] ?? "http://127.0.0.1:8500").replace(
    /\/$/,
    "",
  );
  try {
    new URL(canonicalBaseUrl);
  } catch {
    throw new ConfigError("ROUTER_CANONICAL_BASE_URL must be an absolute URL");
  }

  return {
    router,
    http: {
      host: env["ROUTER_HTTP_HOST"] ?? "127.0.0.1",
      port: parsePort(env["ROUTER_HTTP_PORT"], 8500),
      canonicalBaseUrl,
    },
    journalPath: env["ROUTER_JOURNAL_PATH"] ?? "runtime/journal.ndjson",
    principals: parsePrincipals(env["ROUTER_PRINCIPAL_TOKENS"]),
    adapterMode: mode,
    ...(mode === "synthetic"
      ? { synthetic: parseSynthetic(document["synthetic"], router) }
      : { real: parseReal(document["x402"], router, env) }),
  };
}
