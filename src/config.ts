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
  /** 送信レールの表示名（`x402` / `mpp`）。core は rail 名で分岐しない。 */
  readonly rail?: string;
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

export interface RuntimeConfig {
  readonly router: RouterConfig;
  readonly http: HttpConfig;
  readonly journalPath: string;
  /** principalId → token。応答・ログ・journal に出さない。 */
  readonly principals: ReadonlyMap<string, string>;
  readonly adapterMode: AdapterMode;
  readonly synthetic?: SyntheticRailsConfig;
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
  return {
    routeId,
    canonicalPath,
    ...(rail === undefined ? {} : { rail }),
    source: {
      amount: requireString(source, "amount", `${at}.source`),
      asset: requireString(source, "asset", `${at}.source`),
      decimals: requireNumber(source, "decimals", `${at}.source`),
      network: requireString(source, "network", `${at}.source`),
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
    ...(mode === "synthetic" ? { synthetic: parseSynthetic(document["synthetic"], router) } : {}),
  };
}
