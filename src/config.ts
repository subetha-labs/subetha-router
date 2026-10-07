/**
 * allowlist と上限（設計 §3 / §5）。秘密は保持せず、上流 URL も core には出さない。
 */

import { getBase58Encoder } from "@solana/kit";

/** 受信レグの受取先アドレス形式（EVM）。 */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
/** base58（Bitcoin alphabet）。SVM の公開鍵は 32 バイトで 32〜44 文字。 */
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ──────────────────────────────────────────────────────────────────────────────
 * network の表（multirail 設計 §1、FR-3）。**コードだけ**が権威で、env・設定ファイルからは変えられない。
 * 本番の入口は `KNOWN_NETWORKS` しか使えない。試験の起動側は `knownNetworksForTest`（`src/main.ts`）で自分の表を渡す。
 * ────────────────────────────────────────────────────────────────────────────── */

export type NetworkFamily = "evm" | "svm";
export type InboundRailName = "x402" | "mpp";
export type OutboundRailName = "x402" | "mpp";
export type X402FacilitatorKind = "x402" | "circle";

export interface KnownAsset {
  /** EVM: `0x` アドレス（比較は小文字化）。SVM: mint（base58。比較はそのまま）。 */
  readonly id: string;
  readonly decimals: number;
  /** EVM/x402 の EIP-712 domain。x402 で使う資産に必須。 */
  readonly domain?: { readonly name: string; readonly version: string };
  /** SVM の token program。 */
  readonly tokenProgram?: string;
}

export interface KnownNetwork {
  /** CAIP-2。 */
  readonly network: string;
  readonly family: NetworkFamily;
  /** この network で許す受信レール（`sourceRail`）。 */
  readonly inbound: readonly InboundRailName[];
  /** この network で許す送信レール（静的の `rail`・動的の `rail`）。 */
  readonly outbound: readonly OutboundRailName[];
  /** x402 受信の facilitator の種類（受信 x402 を許すときだけ）。 */
  readonly x402Facilitator?: X402FacilitatorKind;
  readonly assets: readonly KnownAsset[];
}

export const KNOWN_NETWORKS: readonly KnownNetwork[] = Object.freeze([
  {
    network: "eip155:84532",
    family: "evm",
    inbound: ["x402"],
    outbound: ["x402"],
    x402Facilitator: "x402",
    assets: [{ id: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, domain: { name: "USDC", version: "2" } }],
  },
  {
    network: "eip155:42431",
    family: "evm",
    inbound: ["mpp"],
    outbound: ["mpp"],
    assets: [{ id: "0x20c0000000000000000000000000000000000000", decimals: 6 }],
  },
  {
    // Arc testnet（Circle）。送信（S-3）は別紙で足す。
    network: "eip155:5042002",
    family: "evm",
    inbound: ["x402"],
    outbound: [],
    x402Facilitator: "circle",
    assets: [{ id: "0x3600000000000000000000000000000000000000", decimals: 6, domain: { name: "USDC", version: "2" } }],
  },
  {
    // Solana devnet。送信（S-4）は別紙で足す。
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    family: "svm",
    inbound: ["x402"],
    outbound: [],
    x402Facilitator: "x402",
    assets: [{ id: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }],
  },
]);

/** CAIP-2 の構文そのもの（facilitator の表の鍵に使う。route の network は従来どおり文字列）。 */
const CAIP2_PATTERN = /^(eip155:[1-9][0-9]{0,19}|solana:[1-9A-HJ-NP-Za-km-z]{32})$/;

export function isCaip2Network(network: string): boolean {
  return CAIP2_PATTERN.test(network);
}

/** CAIP-2 の名前空間から族を引く。知らない名前空間は `undefined`（呼び出し側は EVM の規則に落とす: 既存の構成を壊さない）。 */
export function networkFamilyOf(network: string): NetworkFamily | undefined {
  if (network.startsWith("eip155:")) return "evm";
  if (network.startsWith("solana:")) return "svm";
  return undefined;
}

/** `eip155:<id>` の数値 chainId。EVM でなければ `undefined`（呼び出し側は署名を拒む）。 */
export function evmChainIdOf(network: string): number | undefined {
  const match = /^eip155:([1-9][0-9]{0,15})$/.exec(network);
  return match === null ? undefined : Number(match[1]);
}

/** 資産の比較の鍵。EVM は小文字化、SVM はそのまま（base58 は大文字小文字を区別する）。予算の鍵には使わない（設定の文字列のまま）。 */
export function assetKeyOf(network: string, asset: string): string {
  return networkFamilyOf(network) === "svm" ? asset : asset.toLowerCase();
}

/** 受取先の形。EVM: `0x`＋40 hex。SVM: base58 を decode して 32 バイト（owner の公開鍵。ATA ではない）。 */
export function isWellFormedPayTo(network: string, payTo: string): boolean {
  if (networkFamilyOf(network) === "svm") {
    if (!BASE58_PATTERN.test(payTo)) return false;
    try {
      return getBase58Encoder().encode(payTo).length === 32;
    } catch {
      return false;
    }
  }
  return ADDRESS_PATTERN.test(payTo);
}

export function knownNetworkOf(networks: readonly KnownNetwork[], network: string): KnownNetwork | undefined {
  return networks.find((entry) => entry.network === network);
}

export function knownAssetOf(entry: KnownNetwork, asset: string): KnownAsset | undefined {
  const key = assetKeyOf(entry.network, asset);
  return entry.assets.find((known) => assetKeyOf(entry.network, known.id) === key);
}

interface TermsToValidate {
  readonly direction: "inbound" | "outbound";
  readonly rail: string;
  readonly network: string;
  readonly asset: string;
  readonly decimals?: number;
  readonly payTo?: string;
  readonly tokenDomain?: { readonly name: string; readonly version: string };
}

/**
 * 表との照合（設計 §1）。network・向きとレール・資産・桁・domain・feeAsset・受取先の形。
 * 違いは `config_invalid`（`ConfigError`）。値はメッセージに出さない（設定の内容を起動ログに写さない）。
 */
function validateTermsAgainstTable(at: string, terms: TermsToValidate, networks: readonly KnownNetwork[]): void {
  const entry = knownNetworkOf(networks, terms.network);
  if (entry === undefined) {
    throw new ConfigError(`${at}.network is not a known network`);
  }
  const allowed: readonly string[] = terms.direction === "inbound" ? entry.inbound : entry.outbound;
  if (!allowed.includes(terms.rail)) {
    throw new ConfigError(`${at}: ${terms.direction} rail "${terms.rail}" is not allowed on this network`);
  }
  const asset = knownAssetOf(entry, terms.asset);
  if (asset === undefined) {
    throw new ConfigError(`${at}.asset is not a known asset on this network`);
  }
  if (terms.decimals !== undefined && terms.decimals !== asset.decimals) {
    throw new ConfigError(`${at}.decimals does not match the known asset`);
  }
  if (terms.payTo !== undefined && !isWellFormedPayTo(terms.network, terms.payTo)) {
    throw new ConfigError(`${at}.payTo is not a well-formed address for this network`);
  }
  if (terms.tokenDomain !== undefined) {
    if (asset.domain === undefined) {
      throw new ConfigError(`${at}.tokenDomain: the known asset has no EIP-712 domain`);
    }
    if (terms.tokenDomain.name !== asset.domain.name || terms.tokenDomain.version !== asset.domain.version) {
      throw new ConfigError(`${at}.tokenDomain does not match the known asset`);
    }
  }
}

/** `parseRouterConfig` の選択肢。`networks` を渡したときだけ表と照合する。 */
export interface RouterConfigOptions {
  readonly networks?: readonly KnownNetwork[];
}

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
    /**
     * mpp 送信: quote が決められる手数料の上限（cap）の**天井**（`feeAsset` の base units）。署名時の上限は quote ごとの cap
     * （`docs/dynamic-gas-fee-design.md` §2）。
     */
    readonly maxFee?: string;
    /**
     * mpp 送信: quote 時の見積り（bound = ceil(gas × maxFeePerGas / 10^12)）に掛ける係数（bps）。cap = ceil(bound × feeMargin / 10000)。
     * 10,000（1 倍）〜1,000,000（100 倍）。既定 20,000。
     */
    readonly feeMargin?: number;
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

/** mpp 送信の `feeMargin` の範囲（bps）と既定（`docs/dynamic-gas-fee-design.md` §2）。 */
export const DYNAMIC_FEE_MARGIN_MIN_BPS = 10_000;
export const DYNAMIC_FEE_MARGIN_MAX_BPS = 1_000_000;
export const DYNAMIC_FEE_MARGIN_DEFAULT_BPS = 20_000;

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
  // 100: MPP 送信の見積り・再見積り・支払いの RPC（2 + 2 + 3）が quote 10／分・purchase 10／分の飽和で 80 になるため（`docs/dynamic-gas-fee-design.md` §8.2）。
  perAddressPerMinute: 100,
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
      // MPP 送信だけ: 手数料の決め方（quote 時のガス代に連動）も支払いの条件。x402 送信の直列化は変えない（発行済みの quote を無効にしない）。
      ...(profile.rail === "mpp" ? { feeMargin: profile.destination.feeMargin } : {}),
    },
    // v2（2026-10-06）: priority 1 固定・`maxFeePerGas = ceil(2.4 × baseFee) + 1`・capPerGas への clamp（`docs/dynamic-gas-fee-design.md` §8）。
    ...(profile.rail === "mpp" ? { pricingPolicy: "gas-indexed-v2" } : {}),
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
export interface X402InboundFacilitator {
  readonly kind: X402FacilitatorKind;
  readonly url: string;
}

/** 既存の env `ROUTER_X402_INBOUND_FACILITATOR_URL` が担当する network。 */
export const LEGACY_X402_INBOUND_NETWORK = "eip155:84532";

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
   * x402 受信の facilitator を **network ごと**に（設定ファイル `x402.inboundFacilitators`。multirail 設計 §2、FR-1）。
   * `eip155:84532` は env（上の欄）が担当で、ここには書けない（優先順位を持たない）。
   * ホストは拒否ホストと `dependencyUrls` に入る（合成側）。
   */
  readonly x402InboundFacilitators?: Readonly<Record<string, X402InboundFacilitator>>;
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
  const sourceNetwork = requireString(source, "network", `${at}.source`);
  const sourcePayToRaw = source["payTo"];
  // 受取先の形は network の族で決める（EVM: 0x、SVM: base58 の 32 バイト）。
  if (sourcePayToRaw !== undefined && (typeof sourcePayToRaw !== "string" || !isWellFormedPayTo(sourceNetwork, sourcePayToRaw))) {
    throw new ConfigError(`${at}.source.payTo must be a well-formed address for its network when present`);
  }
  const sourcePayTo = sourcePayToRaw as string | undefined;
  // 受取先が構成に要るのは Router が自分で offer を作るレール（x402 / mpp）。
  // SubEtha は facilitator が challenge で payTo を返すので持たない。
  if ((sourceRail === "x402" || sourceRail === "mpp") && sourcePayTo === undefined) {
    throw new ConfigError(`${at}.source.payTo is required when sourceRail is "${sourceRail}"`);
  }
  const route: RouteConfig = {
    routeId,
    canonicalPath,
    ...(rail === undefined ? {} : { rail }),
    ...(sourceRail === undefined ? {} : { sourceRail }),
    source: {
      amount: requireString(source, "amount", `${at}.source`),
      asset: requireString(source, "asset", `${at}.source`),
      decimals: requireNumber(source, "decimals", `${at}.source`),
      network: sourceNetwork,
      ...(sourcePayTo === undefined ? {} : { payTo: sourcePayTo }),
    },
    destination: {
      scheme: requireString(destination, "scheme", `${at}.destination`),
      network: requireString(destination, "network", `${at}.destination`),
      asset: requireString(destination, "asset", `${at}.destination`),
      payTo: requireString(destination, "payTo", `${at}.destination`),
    },
  };
  return route;
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
  const sourceNetwork = requireString(source, "network", `${at}.source`);
  const payTo = requireString(source, "payTo", `${at}.source`);
  if (!isWellFormedPayTo(sourceNetwork, payTo)) {
    throw new ConfigError(`${at}.source.payTo must be a well-formed address for its network`);
  }
  const destination = requireRecord(value, "destination", at);
  let tokenDomain: { name: string; version: string } | undefined;
  let feeAsset: string | undefined;
  let maxFee: string | undefined;
  let feeMargin: number | undefined;
  if (rail === "x402") {
    const domain = requireRecord(destination, "tokenDomain", `${at}.destination`);
    tokenDomain = {
      name: requireString(domain, "name", `${at}.destination.tokenDomain`),
      version: requireString(domain, "version", `${at}.destination.tokenDomain`),
    };
  } else {
    feeAsset = requireString(destination, "feeAsset", `${at}.destination`);
    maxFee = requireAmount(destination, "maxFee", `${at}.destination`, false);
    const margin = destination["feeMargin"];
    if (margin === undefined) {
      feeMargin = DYNAMIC_FEE_MARGIN_DEFAULT_BPS;
    } else if (typeof margin !== "number" || !Number.isSafeInteger(margin) || margin < DYNAMIC_FEE_MARGIN_MIN_BPS || margin > DYNAMIC_FEE_MARGIN_MAX_BPS) {
      // 1 倍未満は、署名で必ず止まる quote を出すだけ。
      throw new ConfigError(`${at}.destination.feeMargin must be an integer in ${DYNAMIC_FEE_MARGIN_MIN_BPS}..${DYNAMIC_FEE_MARGIN_MAX_BPS} (bps)`);
    } else {
      feeMargin = margin;
    }
  }
  const fee = requireRecord(value, "fee", at);
  const bps = requireNumber(fee, "bps", `${at}.fee`);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new ConfigError(`${at}.fee.bps must be an integer in 0..10000`);
  }
  const feeMin = requireAmount(fee, "min", `${at}.fee`, false);
  const sourceDecimals = requireDecimals(source, `${at}.source`);
  const destinationDecimals = requireDecimals(destination, `${at}.destination`);
  /**
   * **運営がチェーン手数料を負担しない条件**（G-1、owner の決定 2026-10-06）: MPP 送信では Router が Tempo の手数料を払う。
   * 呼び出し側が先に払う手数料 ≥ 署名時の上限（cap）は、設定ではなく **quote ごとの計算**で保つ（`docs/dynamic-gas-fee-design.md` §2・§3:
   * cap = quote 時のガス代の見積り × feeMargin、手数料 = max(規則の手数料, cap)。記録・復元・再開・adapter がそれぞれ確かめる）。
   *
   * 2 つの額を同じ単位で比べるため、MPP 送信のプロファイルは次に限る:
   * - `feeAsset` が送信資産そのもの（別の資産の価値は `par` では定まらない）
   * - 受信資産と送信資産の桁が同じ（`par: true` は 1:1 の宣言で、桁が違うと base units の比較にならない）
   * 「チェーンが実際に請求する額が署名時の上限以下である」という Tempo 側の前提（設計 §3.3 の T0-b。観測と一致しているが仕様として未確立）は変わらない。
   */
  if (maxFee !== undefined && feeAsset !== undefined) {
    const destinationAsset = requireString(destination, "asset", `${at}.destination`);
    if (feeAsset.toLowerCase() !== destinationAsset.toLowerCase()) {
      throw new ConfigError(`${at}.destination.feeAsset must be the destination asset for an mpp outbound profile (the fee bound is compared at par)`);
    }
    if (sourceDecimals !== destinationDecimals) {
      throw new ConfigError(`${at}: source.decimals must equal destination.decimals for an mpp outbound profile (the fee bound is compared in base units)`);
    }
  }
  const profile: DynamicProfile = {
    profileId,
    sourceRail,
    source: {
      network: sourceNetwork,
      asset: requireString(source, "asset", `${at}.source`),
      decimals: sourceDecimals,
      payTo,
    },
    rail,
    destination: {
      scheme: requireString(destination, "scheme", `${at}.destination`),
      network: requireString(destination, "network", `${at}.destination`),
      asset: requireString(destination, "asset", `${at}.destination`),
      decimals: destinationDecimals,
      ...(tokenDomain === undefined ? {} : { tokenDomain }),
      ...(feeAsset === undefined ? {} : { feeAsset }),
      ...(maxFee === undefined ? {} : { maxFee }),
      ...(feeMargin === undefined ? {} : { feeMargin }),
    },
    par: true,
    maxUpstreamAmount: requireAmount(value, "maxUpstreamAmount", at, true),
    fee: {
      flat: requireAmount(fee, "flat", `${at}.fee`, false),
      bps,
      min: feeMin,
    },
  };
  return profile;
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
export function parseRouterConfig(raw: unknown, options: RouterConfigOptions = {}): RouterConfig {
  const router = parseRouterConfigUnchecked(raw);
  if (options.networks !== undefined) {
    validateRouterConfigAgainstTable(router, options.networks);
  }
  return router;
}

/**
 * 表との照合（multirail 設計 §1）。範囲は x402／mpp の受信（`sourceRail`）と x402／mpp の送信（`rail`）だけ。
 * `subetha` 受信（既定）と rail 未指定の route は今の検査のまま。静的 route の destination は network・向き・資産・受取先の形、
 * source と動的プロファイルはそれに桁（x402 送信は `tokenDomain`）を足して見る。
 */
export function validateRouterConfigAgainstTable(router: RouterConfig, networks: readonly KnownNetwork[]): void {
  for (const route of Object.values(router.routes)) {
    const at = `routes.${route.routeId}`;
    if (route.sourceRail === "x402" || route.sourceRail === "mpp") {
      validateTermsAgainstTable(`${at}.source`, { direction: "inbound", rail: route.sourceRail, network: route.source.network, asset: route.source.asset, decimals: route.source.decimals, ...(route.source.payTo === undefined ? {} : { payTo: route.source.payTo }) }, networks);
    }
    if (route.rail === "x402" || route.rail === "mpp") {
      validateTermsAgainstTable(`${at}.destination`, { direction: "outbound", rail: route.rail, network: route.destination.network, asset: route.destination.asset, payTo: route.destination.payTo }, networks);
    }
  }
  for (const profile of Object.values(router.dynamic?.profiles ?? {})) {
    const at = `dynamic.profiles.${profile.profileId}`;
    validateTermsAgainstTable(`${at}.source`, { direction: "inbound", rail: profile.sourceRail, network: profile.source.network, asset: profile.source.asset, decimals: profile.source.decimals, payTo: profile.source.payTo }, networks);
    validateTermsAgainstTable(`${at}.destination`, {
      direction: "outbound",
      rail: profile.rail,
      network: profile.destination.network,
      asset: profile.destination.asset,
      decimals: profile.destination.decimals,
      // mpp 送信の `feeAsset` は送信資産そのものに限る（`parseDynamicProfile`）ので、資産の照合で一緒に決まる。
      ...(profile.destination.tokenDomain === undefined ? {} : { tokenDomain: profile.destination.tokenDomain }),
    }, networks);
  }
}

function parseRouterConfigUnchecked(raw: unknown): RouterConfig {
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
  networks?: readonly KnownNetwork[],
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
  const inboundFacilitators = parseInboundFacilitators(raw["inboundFacilitators"], router, inboundFacilitatorUrl, networks);
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
    ...(inboundFacilitators === undefined ? {} : { x402InboundFacilitators: inboundFacilitators }),
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

/**
 * `x402.inboundFacilitators`（multirail 設計 §2）。`network` → `{ kind, url }`。
 * - URL は絶対 http(s)、query・userinfo・fragment 不可（`assertAbsoluteHttpUrl`）
 * - `eip155:84532` は env の担当なので、両方に書けば `config_invalid`
 * - 表（`networks`）があれば、network が表にあり `kind` が表の種類と一致すること、そして x402 受信を使う network ごとに
 *   facilitator があること（`eip155:84532` は env）を要求する
 */
function parseInboundFacilitators(
  raw: unknown,
  router: RouterConfig,
  legacyUrl: string | undefined,
  networks?: readonly KnownNetwork[],
): Readonly<Record<string, X402InboundFacilitator>> | undefined {
  const at = "x402.inboundFacilitators";
  let parsed: Record<string, X402InboundFacilitator> | undefined;
  if (raw !== undefined) {
    if (!isRecord(raw)) {
      throw new ConfigError(`${at} must be an object when present`);
    }
    const table: Record<string, X402InboundFacilitator> = {};
    // 鍵（network）はメッセージに**写さない**（設定の値を起動ログに出さない）。位置は何番目かで示す。
    Object.entries(raw).forEach(([network, value], index) => {
      const here = `${at}[#${index + 1}]`;
      if (!isCaip2Network(network)) {
        throw new ConfigError(`${here}: the key must be a CAIP-2 network (eip155:<id> or solana:<32-char genesis>)`);
      }
      if (!isRecord(value)) {
        throw new ConfigError(`${here} must be an object`);
      }
      const kind = value["kind"];
      if (kind !== "x402" && kind !== "circle") {
        throw new ConfigError(`${here}.kind must be "x402" or "circle"`);
      }
      const url = assertAbsoluteHttpUrl(requireString(value, "url", here), `${here}.url`).replace(/\/$/, "");
      if (network === LEGACY_X402_INBOUND_NETWORK && legacyUrl !== undefined && legacyUrl !== "") {
        throw new ConfigError(`${here} conflicts with ROUTER_X402_INBOUND_FACILITATOR_URL (that env owns ${LEGACY_X402_INBOUND_NETWORK})`);
      }
      if (networks !== undefined) {
        const entry = knownNetworkOf(networks, network);
        if (entry === undefined) {
          throw new ConfigError(`${here}: not a known network`);
        }
        if (entry.x402Facilitator !== kind) {
          throw new ConfigError(`${here}.kind does not match the known network's facilitator kind`);
        }
      }
      table[network] = { kind, url };
    });
    parsed = table;
  }
  if (networks !== undefined) {
    const inboundNetworks = new Set<string>();
    for (const route of Object.values(router.routes)) {
      if (route.sourceRail === "x402") inboundNetworks.add(route.source.network);
    }
    for (const profile of Object.values(router.dynamic?.profiles ?? {})) {
      if (profile.sourceRail === "x402") inboundNetworks.add(profile.source.network);
    }
    for (const network of inboundNetworks) {
      if (parsed?.[network] !== undefined) continue;
      if (network === LEGACY_X402_INBOUND_NETWORK) {
        if (legacyUrl !== undefined && legacyUrl !== "") continue;
        // 既存の起動失敗の文言を保つ（`src/main.ts` と同じ）。
        throw new ConfigError('ROUTER_X402_INBOUND_FACILITATOR_URL is required when a route uses sourceRail "x402"');
      }
      throw new ConfigError(`${at}: a facilitator is required for every x402 inbound network (missing one)`);
    }
  }
  return parsed;
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
/**
 * `loadRuntimeConfig` の選択肢。`networks` は **real モードのときだけ**使う（synthetic の harness は表の外の network・資産で起動する）。
 * 渡さなければ real モードは `KNOWN_NETWORKS`（本番の表）。試験の起動側は `knownNetworksForTest`（`src/main.ts`）で差し替える。
 */
export interface RuntimeConfigOptions {
  readonly networks?: readonly KnownNetwork[];
}

export function loadRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
  readConfigFile: (path: string) => string,
  options: RuntimeConfigOptions = {},
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

  const mode = env["ROUTER_ADAPTER_MODE"] ?? "real";
  if (mode !== "real" && mode !== "synthetic") {
    throw new ConfigError("ROUTER_ADAPTER_MODE must be 'real' or 'synthetic'");
  }
  // real モードの既定は本番の表（設計 §1）。試験の起動側は `knownNetworksForTest`（`src/main.ts`）で差し替える。
  const networks = mode === "real" ? (options.networks ?? KNOWN_NETWORKS) : undefined;
  // 表との照合は、実レールの env・設定（facilitator の URL 等）の不足を先に報告してから行う（既存の起動失敗の文言を変えない）。
  const router = parseRouterConfig(document["router"]);
  const canonicalBaseUrl = (env["ROUTER_CANONICAL_BASE_URL"] ?? "http://127.0.0.1:8500").replace(
    /\/$/,
    "",
  );
  try {
    new URL(canonicalBaseUrl);
  } catch {
    throw new ConfigError("ROUTER_CANONICAL_BASE_URL must be an absolute URL");
  }

  const rails = mode === "synthetic"
    ? { synthetic: parseSynthetic(document["synthetic"], router) }
    : { real: parseReal(document["x402"], router, env, networks) };
  if (networks !== undefined) {
    validateRouterConfigAgainstTable(router, networks);
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
    ...rails,
  };
}
