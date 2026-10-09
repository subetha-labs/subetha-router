/**
 * `npm run sign` の分類のうち、**x402 の EVM（scheme `exact` ＋ `eip155:`）だけ**を扱う純粋な判定（P-0。`docs/agent-payer-design.md` §3.8）。
 * `mppx`・`@solana/*`・他の tools を import しない: payer のパッケージ（第 1 slice）はこの module と `src/shared/networks.ts` だけを vendor する。
 * 全レールの振り分けは `sign-dispatch.ts` の `classifyOffer`（共通の検査 `parseOfferCommon` をここから使う）。
 */

import { assetKeyOf, evmChainIdOf, isWellFormedPayTo, KNOWN_NETWORKS, knownAssetOf, knownNetworkOf, networkFamilyOf, type KnownAsset, type KnownNetwork } from "./networks.js";

/** 1 回の受信レグで払ってよい上限（base units）。D-7（2026-10-06）: 動的 quote の「上流額＋手数料」を賄う。 */
export const SIGN_MAX_AMOUNT = 20_000n;

export type SignDispatch =
  | { readonly kind: "mpp"; readonly chainId: number; readonly asset: string; readonly payTo: string; readonly amount: string }
  | { readonly kind: "x402-evm"; readonly chainId: number; readonly domain: { readonly name: string; readonly version: string }; readonly asset: string; readonly payTo: string; readonly amount: string }
  | { readonly kind: "x402-svm"; readonly mint: string; readonly decimals: number; readonly tokenProgram: string; readonly payTo: string; readonly feePayer: string; readonly memo: string; readonly amount: string }
  | { readonly kind: "mpp-svm"; readonly mint: string; readonly decimals: number; readonly tokenProgram: string; readonly payTo: string; readonly amount: string; readonly externalId: string }
  | { readonly kind: "refuse"; readonly reason: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,29})$/;
const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
/** mppx が生成する challenge の id（HMAC-SHA256 の base64url、43 文字）。MPP（Tempo・Solana）の offer の nonce はこの形。 */
const MPPX_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 共通の検査を通った offer の欄（レールの分岐の前）。 */
export interface ParsedOffer {
  readonly scheme: unknown;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly extra: Record<string, unknown> | undefined;
  readonly entry: KnownNetwork;
  readonly known: KnownAsset;
}

/**
 * どのレールにも共通の検査（形・額・上限・期限・nonce・表の network と資産・payTo の形）。順序と文言は分離前の `classifyOffer` と同じ。
 */
export function parseOfferCommon(offer: unknown, nowMs: number, networks: readonly KnownNetwork[] = KNOWN_NETWORKS, maxAmount: bigint = SIGN_MAX_AMOUNT): ParsedOffer | { readonly kind: "refuse"; readonly reason: string } {
  if (!isRecord(offer)) return { kind: "refuse", reason: "the quote has no readable source.offer" };
  const scheme = offer["scheme"];
  const network = typeof offer["network"] === "string" ? offer["network"] : "";
  const asset = typeof offer["asset"] === "string" ? offer["asset"] : "";
  const amount = typeof offer["amount"] === "string" ? offer["amount"] : "";
  const payTo = typeof offer["payTo"] === "string" ? offer["payTo"] : "";
  const extra = isRecord(offer["extra"]) ? offer["extra"] : undefined;
  if (!AMOUNT_PATTERN.test(amount)) return { kind: "refuse", reason: "the offer amount is not a base-unit integer" };
  if (BigInt(amount) > maxAmount) return { kind: "refuse", reason: `the offer amount exceeds the cap (${amount} > ${maxAmount})` };
  const expiresAt = extra?.["expiresAt"];
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return { kind: "refuse", reason: "the offer has no expiresAt" };
  if (expiresAt * 1000 <= nowMs) return { kind: "refuse", reason: "the offer has expired; take a new quote and ask for approval again" };
  // 共通の欄: nonce（Router の封筒の `challengeNonce`）。無ければ、どのレールでも Router の preflight が落とす（MPP なら送金した後に）。
  // x402 の nonce は 0x の hex 32 バイト。**MPP（Tempo・Solana）の nonce は mppx が生成した challenge の id**（HMAC の base64url 43 文字。`src/adapters/inbound/mpp.ts`・`mpp-solana.ts` が
  // `challenge.id` をそのまま nonce にする）で、0x の hex ではない。T5（2026-10-07）から M6 までこの判定は hex だけを通していたので、Tempo の MPP の offer は `npm run sign` で
  // 「no well-formed challengeNonce」になっていた（M6 で修正。`docs/mpp-solana-design.md` §13）。MPP の Solana は分岐で中身の `id` との一致も確かめる。
  const isMpp = scheme === "tempo/charge" || scheme === "solana/charge";
  const nonce = extra?.["challengeNonce"];
  if (typeof nonce !== "string" || !(NONCE_PATTERN.test(nonce) || (isMpp && MPPX_ID_PATTERN.test(nonce)))) return { kind: "refuse", reason: "the offer has no well-formed challengeNonce" };
  const entry = knownNetworkOf(networks, network);
  if (entry === undefined) return { kind: "refuse", reason: "the offer network is not in the table of known networks" };
  const known = knownAssetOf(entry, asset);
  if (known === undefined) return { kind: "refuse", reason: "the offer asset is not a known asset on that network" };
  if (!isWellFormedPayTo(network, payTo)) return { kind: "refuse", reason: "the offer payTo is not a well-formed address for that network" };
  return { scheme, network, asset, amount, payTo, extra, entry, known };
}

/** x402 の `exact` の共通の検査（EVM・SVM の分岐の前）。 */
export function checkExactCommon(parsed: ParsedOffer): { readonly kind: "refuse"; readonly reason: string } | undefined {
  if (parsed.scheme !== "exact") return { kind: "refuse", reason: "the offer scheme is neither exact nor tempo/charge nor solana/charge" };
  if (!parsed.entry.inbound.includes("x402")) return { kind: "refuse", reason: "x402 offers are not accepted on that network" };
  if (parsed.extra?.["fundsMoveOnCredential"] === true) return { kind: "refuse", reason: "an exact offer must not move funds on signing" };
  return undefined;
}

/** x402 の EVM（EIP-3009）の分岐。chainId・domain は表から。 */
export function classifyExactEvm(parsed: ParsedOffer): SignDispatch {
  const chainId = evmChainIdOf(parsed.network);
  if (chainId === undefined) return { kind: "refuse", reason: "the offer network has no chain id" };
  if (parsed.known.domain === undefined) return { kind: "refuse", reason: "the table has no EIP-712 domain for that asset" };
  if (parsed.extra?.["name"] !== parsed.known.domain.name || parsed.extra?.["version"] !== parsed.known.domain.version) {
    return { kind: "refuse", reason: "the offer's EIP-712 domain does not match the table (refusing to sign an unexpected domain)" };
  }
  if (assetKeyOf(parsed.network, parsed.asset) !== assetKeyOf(parsed.network, parsed.known.id)) return { kind: "refuse", reason: "asset mismatch" };
  return { kind: "x402-evm", chainId, domain: parsed.known.domain, asset: parsed.asset, payTo: parsed.payTo, amount: parsed.amount };
}

/**
 * **x402 の EVM だけ**を分類する入口（payer の第 1 slice）。MPP（Tempo・Solana）と x402 の SVM の offer は、分離前の `classifyOffer` が
 * 共通の検査で拒む理由はそのまま返し、それ以外は「この分類器の範囲外」として拒む（署名はしない）。
 */
export function classifyEvmOffer(offer: unknown, nowMs: number, networks: readonly KnownNetwork[] = KNOWN_NETWORKS, maxAmount: bigint = SIGN_MAX_AMOUNT): SignDispatch {
  const parsed = parseOfferCommon(offer, nowMs, networks, maxAmount);
  if ("kind" in parsed) return parsed;
  if (parsed.scheme === "tempo/charge" || parsed.scheme === "solana/charge") return { kind: "refuse", reason: "this signer handles only x402 EVM offers (MPP offers need the full dispatcher)" };
  const exact = checkExactCommon(parsed);
  if (exact !== undefined) return exact;
  if (networkFamilyOf(parsed.network) !== "evm") return { kind: "refuse", reason: "this signer handles only x402 EVM offers (Solana offers need the full dispatcher)" };
  return classifyExactEvm(parsed);
}
