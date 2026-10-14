/**
 * Provider（x402 v2 `exact` の資源サーバ。Cloudflare Workers）の固定値と env の検査（`docs/provider-x402-workers.md` §2.1・§2.4）。
 * network ごとの表はここだけ（arc・solana と EVM testnet 4 つ: `docs/evm-testnets-x402-design.md` §3.4）。env から変えられるのは受取先・鍵・facilitator の URL。**鍵の値は config に入れない**（`index.ts` が
 * 署名の closure を作るときに env から 1 度だけ読む）。例外の文言に値を出さない。
 */
import { getBase58Encoder } from "@solana/kit";

export type ProviderNetwork = "arc" | "solana" | "rh" | "arbsep" | "hyperevm" | "sepolia";

/**
 * 要求ごとの期限と authorization の窓（ms・秒。`docs/evm-testnets-x402-design.md` §3.6）。既存の `arc`・`solana` は E-3 の前の
 * 定数そのもの（26 s / 5・2・4 s / settle に入るのに要る残り 12 s / settle 20 s / 窓 30 s）。
 */
export interface NetworkDeadlines {
  readonly requestMs: number;
  readonly initMs: number;
  readonly dataMs: number;
  readonly verifyMs: number;
  readonly settleMs: number;
  readonly minRemainingBeforeSettleMs: number;
}

export interface NetworkTable {
  readonly network: string;
  readonly asset: string;
  readonly decimals: number;
  readonly amount: string;
  /** EVM: EIP-712 domain と `assetTransferMethod`。Solana: 無し（`feePayer` は facilitator の `/supported` から SDK が足す）。 */
  readonly extra: Readonly<Record<string, string>>;
  /** 既定の facilitator。空なら `FACILITATOR_URL` が必須（EVM testnet 4 つ: 自前の facilitator。設計 §3.4）。 */
  readonly facilitatorUrl: string;
  /** `circle` のときだけ売り手証明（`SELLER_PROOF_KEY` が必須）。`x402` は鍵を置かない。 */
  readonly facilitatorKind: "circle" | "x402";
  readonly family: "evm" | "svm";
  readonly chainId?: number;
  readonly deadlines: NetworkDeadlines;
  /** 402 の `maxTimeoutSeconds`（authorization の窓）。 */
  readonly maxTimeoutSeconds: number;
}

/** 既存の値（E-3 の前の `deadline.ts` の定数と同じ）。速い EVM testnet も同じ（窓だけ 60 秒）。 */
const STANDARD_DEADLINES: NetworkDeadlines = Object.freeze({ requestMs: 26_000, initMs: 5_000, dataMs: 2_000, verifyMs: 4_000, settleMs: 20_000, minRemainingBeforeSettleMs: 12_000 });
/** Ethereum Sepolia（block ~12 秒。設計 §3.6 の右の列）。 */
const SLOW_DEADLINES: NetworkDeadlines = Object.freeze({ requestMs: 60_000, initMs: 5_000, dataMs: 2_000, verifyMs: 4_000, settleMs: 50_000, minRemainingBeforeSettleMs: 44_000 });

/** EVM testnet 4 つの行（値は Router の `src/shared/networks.ts` の写し。試験 `test/evm-testnets.test.ts` が一致を確かめる）。 */
function evmTestnetRow(chainId: number, asset: string, name: string, version: string, slow: boolean): NetworkTable {
  return Object.freeze({
    network: `eip155:${chainId}`,
    asset,
    decimals: 6,
    amount: "10000",
    extra: Object.freeze({ name, version, assetTransferMethod: "eip3009" }),
    facilitatorUrl: "",
    facilitatorKind: "x402",
    family: "evm",
    chainId,
    deadlines: slow ? SLOW_DEADLINES : STANDARD_DEADLINES,
    maxTimeoutSeconds: slow ? 120 : 60,
  });
}

export const TABLE: Readonly<Record<ProviderNetwork, NetworkTable>> = Object.freeze({
  arc: Object.freeze({
    network: "eip155:5042002",
    asset: "0x3600000000000000000000000000000000000000",
    decimals: 6,
    amount: "10000",
    extra: Object.freeze({ name: "USDC", version: "2", assetTransferMethod: "eip3009" }),
    facilitatorUrl: "https://api.circle.com/v1/facilitator/x402",
    facilitatorKind: "circle",
    family: "evm",
    chainId: 5042002,
    deadlines: STANDARD_DEADLINES,
    maxTimeoutSeconds: 30,
  }),
  solana: Object.freeze({
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    decimals: 6,
    amount: "10000",
    extra: Object.freeze({}),
    facilitatorUrl: "https://www.x402.org/facilitator",
    facilitatorKind: "x402",
    family: "svm",
    deadlines: STANDARD_DEADLINES,
    maxTimeoutSeconds: 30,
  }),
  // Robinhood Chain testnet の USDG（`version()` は無い。domain `Global Dollar`/`1` は `DOMAIN_SEPARATOR` から確かめた値）。
  rh: evmTestnetRow(46630, "0x7E955252E15c84f5768B83c41a71F9eba181802F", "Global Dollar", "1", false),
  // Arbitrum Sepolia の Circle USDC（`name()` は `USD Coin`）。
  arbsep: evmTestnetRow(421614, "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", "USD Coin", "2", false),
  // HyperEVM testnet の Circle の ERC-20 USDC（HyperCore の USDC ではない）。
  hyperevm: evmTestnetRow(998, "0x2B3370eE501B4a559b57D449569354196457D8Ab", "USDC", "2", false),
  // Ethereum Sepolia の Circle USDC（遅いチェーン: 期限と窓は §3.6 の右の列）。
  sepolia: evmTestnetRow(11155111, "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "USDC", "2", true),
});

export function isProviderNetwork(value: unknown): value is ProviderNetwork {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TABLE, value);
}

/** 入口の期限（runtime を組む前に作るので env の network から引く。知らない network は既存の値: config の検査で 500 になる）。 */
export function requestDeadlineMsOf(network: unknown): number {
  return isProviderNetwork(network) ? TABLE[network].deadlines.requestMs : STANDARD_DEADLINES.requestMs;
}

/** 資源（§2.1・§11）。path ごとに Hyperliquid の銘柄と 402 の `resource.description`。鍵・受取先・価格は資源によらず同じ。 */
export type MarketSymbol = "ETH" | "SOL";
export interface Resource {
  readonly path: string;
  readonly symbol: MarketSymbol;
  readonly description: string;
}
export const RESOURCES: readonly Resource[] = Object.freeze([
  Object.freeze({ path: "/v1/eth/snapshot", symbol: "ETH", description: "ETH perpetual snapshot (Hyperliquid mark price, 24h change)" }),
  Object.freeze({ path: "/v1/sol/snapshot", symbol: "SOL", description: "SOL perpetual snapshot (Hyperliquid mark price, 24h change)" }),
]);
/** path の完全一致だけ（末尾の `/`・大文字小文字・クエリは一致しない）。 */
export function resourceOf(pathname: string): Resource | undefined {
  return RESOURCES.find((resource) => resource.path === pathname);
}
export const RESOURCE_PATH = RESOURCES[0]!.path;
export const DESCRIPTION = RESOURCES[0]!.description;
/** wire の窓の既存の値（arc・solana: Circle の窓と同じ 30 秒。設計 §2.1）。network ごとの値は `TABLE[*].maxTimeoutSeconds`。 */
export const MAX_TIMEOUT_SECONDS = 30;
/** `PAYMENT-SIGNATURE` の長さの上限（Workers のヘッダの上限の内側。正しい payload は数 KiB）。 */
export const MAX_PAYMENT_HEADER_CHARS = 16 * 1024;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_KEY = /^0x[0-9a-fA-F]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** base58 で 32 バイトに復号できる公開鍵か（文字数だけでは決めない）。 */
export function isBase58PublicKey(value: string): boolean {
  if (!BASE58.test(value)) return false;
  try {
    return getBase58Encoder().encode(value).length === 32;
  } catch {
    return false;
  }
}

export interface ProviderEnv {
  readonly PROVIDER_NETWORK?: string;
  readonly PAY_TO?: string;
  readonly SELLER_PROOF_KEY?: string;
  readonly FACILITATOR_URL?: string;
  /** 試験だけ: データ源の URL（既定は Hyperliquid）。 */
  readonly DATA_URL?: string;
}

/** 秘密を含まない設定。 */
export interface ProviderConfig {
  readonly network: ProviderNetwork;
  readonly table: NetworkTable;
  readonly payTo: string;
  readonly facilitatorUrl: string;
  readonly dataUrl: string;
}

export const DEFAULT_DATA_URL = "https://api.hyperliquid.xyz/info";

/** env の検査。鍵は**形だけ**見て値は返さない。失敗は固定文（値を含めない）。 */
export function configOf(env: ProviderEnv): ProviderConfig {
  const network = env.PROVIDER_NETWORK;
  if (!isProviderNetwork(network)) throw new Error("PROVIDER_NETWORK must be one of arc, solana, rh, arbsep, hyperevm, sepolia");
  const table = TABLE[network];
  const payTo = env.PAY_TO ?? "";
  if (table.family === "evm" ? !EVM_ADDRESS.test(payTo) : !isBase58PublicKey(payTo)) throw new Error("PAY_TO is missing or malformed for the network");
  const key = env.SELLER_PROOF_KEY;
  if (table.facilitatorKind === "circle") {
    if (key === undefined || !EVM_KEY.test(key)) throw new Error(`SELLER_PROOF_KEY is required for ${network} and must be a 0x-prefixed 32-byte hex key`);
  } else if (key !== undefined && key !== "") {
    throw new Error(`SELLER_PROOF_KEY must not be set for ${network}`);
  }
  const facilitatorUrl = env.FACILITATOR_URL === undefined || env.FACILITATOR_URL === "" ? table.facilitatorUrl : env.FACILITATOR_URL;
  if (facilitatorUrl === "") throw new Error(`FACILITATOR_URL is required for ${network}`);
  if (!/^https:\/\//.test(facilitatorUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(facilitatorUrl)) throw new Error("FACILITATOR_URL must be https (or loopback http for tests)");
  const dataUrl = env.DATA_URL === undefined || env.DATA_URL === "" ? DEFAULT_DATA_URL : env.DATA_URL;
  return { network, table, payTo, facilitatorUrl: facilitatorUrl.replace(/\/$/, ""), dataUrl };
}

/** 鍵の形（`index.ts` が closure を作る直前に使う。値は返さない）。 */
export function isEvmKey(value: unknown): value is `0x${string}` {
  return typeof value === "string" && EVM_KEY.test(value);
}
