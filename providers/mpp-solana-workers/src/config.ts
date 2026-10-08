/**
 * Provider D（MPP `solana/charge` の資源サーバ。Cloudflare Workers）の固定値と env の検査（`docs/provider-mpp-solana-workers.md` §2.1・§2.4）。
 * 秘密（`FEE_PAYER_KEY`・`MPP_SECRET`・`SOLANA_RPC_URL`）の**値は config に入れない**（`paykit.ts` が runtime を組むときに env から 1 度だけ読む）。例外の文言に値を出さない。
 */
import { getBase58Encoder } from "@solana/kit";

/** Solana devnet（CAIP-2）と devnet USDC（Router の表と同じ）。 */
export const NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const DECIMALS = 6;
/** 額（base units）= `usd("0.01")`。 */
export const AMOUNT = "10000";
export const USD_AMOUNT = "0.01";
export const RESOURCE_PATH = "/v1/eth/snapshot";
export const DESCRIPTION = "ETH perpetual snapshot (Hyperliquid mark price, 24h change)";
export const REALM = "subetha-provider-mpp-sol";
export const GATE_NAME = "eth-snapshot";
/** challenge の期限（秒）。pay-kit の既定は 120。 */
export const EXPIRES_IN_SECONDS = 300;
export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
export const DEFAULT_DATA_URL = "https://api.hyperliquid.xyz/info";
/** `MPP_SECRET` の最小の長さ（bytes）。 */
export const MIN_SECRET_BYTES = 32;

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

/** 鍵の形: base58 の 32 バイトの seed だけ（`wallet:new:solana`・`keygen-fee-payer.mjs` の形）。失敗の文言に値を含めない。 */
export function seedFromKey(key: string): Uint8Array {
  if (!BASE58.test(key)) throw new Error("FEE_PAYER_KEY must be a base58 32-byte seed");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(getBase58Encoder().encode(key));
  } catch {
    throw new Error("FEE_PAYER_KEY must be a base58 32-byte seed");
  }
  if (bytes.length !== 32) throw new Error("FEE_PAYER_KEY must be a base58 32-byte seed");
  return bytes;
}

export interface ProviderEnv {
  readonly PAY_TO?: string;
  readonly FEE_PAYER_PUBKEY?: string;
  /** secret: fee payer の seed（base58 32 バイト）。 */
  readonly FEE_PAYER_KEY?: string;
  /** secret: challenge の HMAC の秘密（32 バイト以上）。 */
  readonly MPP_SECRET?: string;
  /** secret（任意）: devnet の RPC。無ければ公開 devnet。 */
  readonly SOLANA_RPC_URL?: string;
  /** 試験だけ: データ源の URL（既定は Hyperliquid）。 */
  readonly DATA_URL?: string;
}

/**
 * 鍵・HMAC の秘密を含まない設定。`rpcUrl` は owner の RPC の URL で、鍵を path に埋めた形があり得る: log には出さない（`log.ts` の伏せ字）、応答にも出さない。
 */
export interface ProviderConfig {
  readonly payTo: string;
  readonly feePayerPubkey: string;
  readonly rpcUrl: string;
  readonly dataUrl: string;
}

/** `http(s)` の URL で、userinfo を持たない。 */
export function isPlainHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "";
}

/** env の検査（秘密の値は読まない: `FEE_PAYER_KEY`・`MPP_SECRET` は `paykit.ts`）。失敗の文言は固定。 */
export function configOf(env: ProviderEnv): ProviderConfig {
  const payTo = env.PAY_TO;
  if (typeof payTo !== "string" || !isBase58PublicKey(payTo)) throw new Error("PAY_TO must be a base58 32-byte public key");
  const feePayerPubkey = env.FEE_PAYER_PUBKEY;
  if (typeof feePayerPubkey !== "string" || !isBase58PublicKey(feePayerPubkey)) throw new Error("FEE_PAYER_PUBKEY must be a base58 32-byte public key");
  if (feePayerPubkey === payTo) throw new Error("FEE_PAYER_PUBKEY must differ from PAY_TO");
  const rpcUrl = env.SOLANA_RPC_URL === undefined || env.SOLANA_RPC_URL === "" ? DEFAULT_RPC_URL : env.SOLANA_RPC_URL;
  if (!isPlainHttpUrl(rpcUrl)) throw new Error("SOLANA_RPC_URL must be an http(s) URL without credentials in the authority");
  const dataUrl = env.DATA_URL === undefined || env.DATA_URL === "" ? DEFAULT_DATA_URL : env.DATA_URL;
  if (!isPlainHttpUrl(dataUrl)) throw new Error("DATA_URL must be an http(s) URL");
  return Object.freeze({ payTo, feePayerPubkey, rpcUrl, dataUrl });
}
