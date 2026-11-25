/**
 * 受信レール `subetha-exact`（Router = SubEtha v2 facilitator の Provider）の設定の定数と検査（`docs/subetha-exact-inbound-design.md` §3.6・§5.2）。
 * 純粋（I/O なし）。`src/config.ts` と adapter の両方が使う。payer には vendor しない。
 */

export const SUBETHA_EXACT_RAIL = "subetha-exact" as const;

/**
 * この rail の route の額の上限（base units）。買い手の `npm run sign` の cap（`tools/sign-classify-evm.ts` の `SIGN_MAX_AMOUNT`）と同じ値。
 * 要件 §3-9: route の額はこの cap 以下（設定で超えれば `ConfigError`）。
 */
export const SUBETHA_EXACT_MAX_AMOUNT = 20_000n;

/** env の名前（`docs/subetha-exact-inbound-design.md` §5.2）。 */
export const SUBETHA_EXACT_FACILITATOR_URL_ENV = "ROUTER_SUBETHA_EXACT_FACILITATOR_URL";
export const SUBETHA_EXACT_TOKEN_FILE_ENV = "ROUTER_SUBETHA_EXACT_TOKEN_FILE";
export const SUBETHA_EXACT_OFFER_SECONDS_ENV = "ROUTER_SUBETHA_EXACT_OFFER_SECONDS";
/** Router が買い手の authorization を送る先の x402 facilitator（`docs/subetha-exact-provider-settle-design.md` §3.7）。任意。 */
export const SUBETHA_EXACT_SETTLE_FACILITATOR_URL_ENV = "ROUTER_SUBETHA_EXACT_SETTLE_FACILITATOR_URL";
/** 既定（オーナーの決定、2026-11-22: 第三者の無料のサービス、認証情報なし）。 */
export const SUBETHA_EXACT_SETTLE_FACILITATOR_DEFAULT_URL = "https://www.x402.org/facilitator";
/** 送る先の host の allowlist（loopback は fixture だけ）。 */
export const SUBETHA_EXACT_SETTLE_FACILITATOR_HOSTS: ReadonlySet<string> = Object.freeze(new Set(["www.x402.org", "x402.org"]));
/** SubEtha 自前の settle facilitator の host（`docs/exact-settle-facilitator-design.md` §1）。この host だけは settle 先の token が要り、URL は origin だけ。 */
export const SUBETHA_EXACT_OWN_SETTLE_HOSTS: ReadonlySet<string> = Object.freeze(new Set(["settle-testnet.subethalabs.com"]));
/** settle 先の token のファイル（`docs/exact-settle-facilitator-design.md` §2.1）。値は小文字の hex 64 桁。 */
export const SUBETHA_EXACT_SETTLE_TOKEN_FILE_ENV = "ROUTER_SUBETHA_EXACT_SETTLE_TOKEN_FILE";
/** 運用者が設定する ETH の価格（1 ETH あたりの base units）と、その時刻（ISO 8601、UTC）。`docs/exact-pricing-design.md` §2。 */
export const SUBETHA_EXACT_ETH_PRICE_ENV = "ROUTER_SUBETHA_EXACT_ETH_PRICE";
export const SUBETHA_EXACT_ETH_PRICE_AT_ENV = "ROUTER_SUBETHA_EXACT_ETH_PRICE_AT";
export const SUBETHA_EXACT_SETTLE_TOKEN_FORM = /^[0-9a-f]{64}$/;

/** facilitator の host の allowlist（hosted のテストネット）と、試験の fixture だけに許す loopback。 */
export const SUBETHA_EXACT_FACILITATOR_HOSTS: ReadonlySet<string> = Object.freeze(new Set(["facilitator-testnet.subethalabs.com"]));
const LOOPBACK_HOSTS: ReadonlySet<string> = Object.freeze(new Set(["127.0.0.1", "localhost", "[::1]"]));
/** tenant の path（`/p/<id>`。id は facilitator の `PROVIDER_ID_RE` と同じ字種）。 */
const TENANT_PATH = /^\/p\/[a-z0-9-]+$/;

/** 枠の上限（要件 FR-9、設計 §3.6）。 */
export interface SubethaExactLimits {
  /** 累積の要求数（adapter の記録の `requested` の行。再起動で戻らない）。 */
  readonly maxRequestsTotal: number;
  /** 未解決の要求 + 結び付かない `discovered` の注文の数。 */
  readonly maxUnresolved: number;
  /** 1 分あたりの要求数。 */
  readonly requestsPerMinute: number;
  /**
   * 送信元ごとの上限（`docs/hosted-exact-enable-design.md` §3。任意。無ければ送信元ごとには数えない = 今までどおり）。
   * `maxUnresolvedPerSource` は 2 以上（結果の分からない作成 1 つ + 後から見つかるその注文 1 つを覆う）。
   */
  readonly maxUnresolvedPerSource?: number;
  readonly requestsPerMinutePerSource?: number;
}

/** AC-7 の既定（段 4 の計画で確定する。`docs/subetha-exact-inbound-acceptance.md`）。 */
export const SUBETHA_EXACT_DEFAULT_LIMITS: SubethaExactLimits = Object.freeze({ maxRequestsTotal: 100, maxUnresolved: 3, requestsPerMinute: 6 });

/** 検査済みの facilitator の URL。`tenant` は `/p/<id>`（adapter の記録の `created.tenant` と complete の照合に使う）。 */
export interface SubethaExactFacilitatorUrl {
  /** 末尾の `/` 無し。 */
  readonly url: string;
  readonly host: string;
  readonly tenant: string;
  readonly loopback: boolean;
}

/**
 * `ROUTER_SUBETHA_EXACT_FACILITATOR_URL` の検査（設計 §5.2）: 絶対 URL、https（loopback だけ http も可）、host は allowlist か loopback、
 * path は `/p/<id>`、query・userinfo・fragment・port（loopback 以外）は不可。違えば `undefined`（呼び出し側が `ConfigError` にする。値はメッセージに出さない）。
 */
export function parseSubethaExactFacilitatorUrl(raw: string): SubethaExactFacilitatorUrl | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return undefined;
  if (!loopback && !SUBETHA_EXACT_FACILITATOR_HOSTS.has(url.hostname)) return undefined;
  if (!loopback && url.port !== "") return undefined;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
  const path = url.pathname.replace(/\/$/, "");
  if (!TENANT_PATH.test(path)) return undefined;
  return { url: `${url.protocol}//${url.host}${path}`, host: url.hostname, tenant: path, loopback };
}

/** 検査済みの settle 用の facilitator の URL（末尾の `/` 無し）。 */
export interface SubethaExactSettleFacilitatorUrl {
  readonly url: string;
  readonly host: string;
  readonly loopback: boolean;
}

/**
 * `ROUTER_SUBETHA_EXACT_SETTLE_FACILITATOR_URL` の検査（`docs/subetha-exact-provider-settle-design.md` §3.7）: 絶対 URL、https（loopback だけ http も可）、
 * host は allowlist か loopback、query・userinfo・fragment・port（loopback 以外）は不可。違えば `undefined`（値はメッセージに出さない）。
 */
export function parseSubethaExactSettleFacilitatorUrl(raw: string): SubethaExactSettleFacilitatorUrl | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return undefined;
  const own = SUBETHA_EXACT_OWN_SETTLE_HOSTS.has(url.hostname);
  if (!loopback && !own && !SUBETHA_EXACT_SETTLE_FACILITATOR_HOSTS.has(url.hostname)) return undefined;
  if (own && url.pathname !== "/") return undefined;
  if (!loopback && url.port !== "") return undefined;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
  return { url: `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`, host: url.hostname, loopback };
}
