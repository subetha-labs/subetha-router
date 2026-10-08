/**
 * Provider（x402 v2 `exact` の資源サーバ。Cloudflare Workers）の固定値と env の検査（`docs/provider-x402-workers.md` §2.1・§2.4）。
 * network ごとの表はここだけ。env から変えられるのは受取先・鍵・facilitator の URL。**鍵の値は config に入れない**（`index.ts` が
 * 署名の closure を作るときに env から 1 度だけ読む）。例外の文言に値を出さない。
 */
import { getBase58Encoder } from "@solana/kit";

export type ProviderNetwork = "arc" | "solana";

export interface NetworkTable {
  readonly network: string;
  readonly asset: string;
  readonly decimals: number;
  readonly amount: string;
  /** Arc: EIP-712 domain と Circle の要求する `assetTransferMethod`。Solana: 無し（`feePayer` は facilitator の `/supported` から SDK が足す）。 */
  readonly extra: Readonly<Record<string, string>>;
  readonly facilitatorUrl: string;
  readonly facilitatorKind: "circle" | "x402";
  readonly chainId?: number;
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
    chainId: 5042002,
  }),
  solana: Object.freeze({
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    decimals: 6,
    amount: "10000",
    extra: Object.freeze({}),
    facilitatorUrl: "https://www.x402.org/facilitator",
    facilitatorKind: "x402",
  }),
});

export const RESOURCE_PATH = "/v1/eth/snapshot";
export const DESCRIPTION = "ETH perpetual snapshot (Hyperliquid mark price, 24h change)";
/** wire の窓（Circle の窓と同じ 30 秒。設計 §2.1）。 */
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
  if (network !== "arc" && network !== "solana") throw new Error("PROVIDER_NETWORK must be arc or solana");
  const table = TABLE[network];
  const payTo = env.PAY_TO ?? "";
  if (network === "arc" ? !EVM_ADDRESS.test(payTo) : !isBase58PublicKey(payTo)) throw new Error("PAY_TO is missing or malformed for the network");
  const key = env.SELLER_PROOF_KEY;
  if (network === "arc") {
    if (key === undefined || !EVM_KEY.test(key)) throw new Error("SELLER_PROOF_KEY is required for arc and must be a 0x-prefixed 32-byte hex key");
  } else if (key !== undefined && key !== "") {
    throw new Error("SELLER_PROOF_KEY must not be set for solana");
  }
  const facilitatorUrl = env.FACILITATOR_URL === undefined || env.FACILITATOR_URL === "" ? table.facilitatorUrl : env.FACILITATOR_URL;
  if (!/^https:\/\//.test(facilitatorUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(facilitatorUrl)) throw new Error("FACILITATOR_URL must be https (or loopback http for tests)");
  const dataUrl = env.DATA_URL === undefined || env.DATA_URL === "" ? DEFAULT_DATA_URL : env.DATA_URL;
  return { network, table, payTo, facilitatorUrl: facilitatorUrl.replace(/\/$/, ""), dataUrl };
}

/** 鍵の形（`index.ts` が closure を作る直前に使う。値は返さない）。 */
export function isEvmKey(value: unknown): value is `0x${string}` {
  return typeof value === "string" && EVM_KEY.test(value);
}
