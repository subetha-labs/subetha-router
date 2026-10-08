/**
 * `npm run sign` の**振り分けと署名前の拒否**（multirail 設計 §7、SR-7。タスク T5）。**製品コードではない**（鍵を扱う側の補助）が、
 * 鍵には触れない純粋な判定なので試験できる。
 *
 * - scheme `tempo/charge` → MPP（既存。署名で資金が動く）
 * - scheme `exact` ＋ `eip155:` → x402 の EVM（chainId・domain は**表**から）
 * - scheme `exact` ＋ `solana:` → x402 の SVM（mint・token program・桁は**表**から）
 * - scheme `solana/charge` ＋ `solana:` → MPP の SVM（`docs/mpp-solana-design.md` §7。署名だけ。送出は Router で、fee payer は自分の鍵）
 * - それ以外 → 拒否
 *
 * 表に無い network・資産・domain、失効した offer、形の違う offer、上限を超える額は**署名の前に**拒む。
 */

import { assetKeyOf, evmChainIdOf, isWellFormedPayTo, KNOWN_NETWORKS, knownAssetOf, knownNetworkOf, networkFamilyOf, type KnownNetwork } from "../src/config.js";
import { Challenge } from "mppx";

import { checkSvmMppChallenge } from "./svm-mpp-payer.js";

/** 1 回の受信レグで払ってよい上限（base units）。D-7（2026-10-06）: 動的 quote の「上流額＋手数料」を賄う。 */
export const SIGN_MAX_AMOUNT = 20_000n;

export type SignDispatch =
  | { readonly kind: "mpp"; readonly chainId: number; readonly asset: string; readonly payTo: string; readonly amount: string }
  | { readonly kind: "x402-evm"; readonly chainId: number; readonly domain: { readonly name: string; readonly version: string }; readonly asset: string; readonly payTo: string; readonly amount: string }
  | { readonly kind: "x402-svm"; readonly mint: string; readonly decimals: number; readonly tokenProgram: string; readonly payTo: string; readonly feePayer: string; readonly memo: string; readonly amount: string }
  | { readonly kind: "mpp-svm"; readonly mint: string; readonly decimals: number; readonly tokenProgram: string; readonly payTo: string; readonly amount: string; readonly externalId: string }
  | { readonly kind: "refuse"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,29})$/;
const NONCE_PATTERN = /^0x[0-9a-fA-F]{64}$/;
/** mppx が生成する challenge の id（HMAC-SHA256 の base64url、43 文字）。MPP（Tempo・Solana）の offer の nonce はこの形。 */
const MPPX_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Tempo の MPP の challenge の中身が offer と一致するか（送金の前。`tools/mpp-payer.ts` も払う直前に同じ判定を呼ぶ）。
 * mppx の client は `request.amount`・`currency`・`recipient` から送金を組むので、封筒の offer（人間が承認した値）と中身の一致を確かめる。HMAC は payer 側では照合できない（秘密は Router の側）。
 */
export function checkTempoChallenge(serialized: string, offer: { amount: string; asset: string; payTo: string; extra: Record<string, unknown> }, chainId: number, nowMs: number): { ok: true } | { ok: false; reason: string } {
  let challenge: unknown;
  try {
    challenge = Challenge.deserialize(serialized);
  } catch {
    return { ok: false, reason: "the MPP offer's challenge cannot be read" };
  }
  if (!isRecord(challenge)) return { ok: false, reason: "the MPP offer's challenge cannot be read" };
  if (challenge["id"] !== offer.extra["challengeNonce"]) return { ok: false, reason: "the challenge id is not the offer's challengeNonce" };
  if (challenge["method"] !== "tempo" || challenge["intent"] !== "charge") return { ok: false, reason: "the challenge is not tempo/charge" };
  const expires = challenge["expires"];
  if (typeof expires === "string") {
    const at = Date.parse(expires);
    if (!Number.isFinite(at) || at <= nowMs) return { ok: false, reason: "the challenge has expired; take a new quote and ask for approval again" };
  }
  const request = challenge["request"];
  if (!isRecord(request)) return { ok: false, reason: "the challenge has no request" };
  if (request["amount"] !== offer.amount) return { ok: false, reason: "the challenge amount differs from the offer" };
  if (typeof request["currency"] !== "string" || request["currency"].toLowerCase() !== offer.asset.toLowerCase()) return { ok: false, reason: "the challenge currency differs from the offer's asset" };
  if (typeof request["recipient"] !== "string" || request["recipient"].toLowerCase() !== offer.payTo.toLowerCase()) return { ok: false, reason: "the challenge recipient differs from the offer's payTo" };
  const details = request["methodDetails"];
  if (!isRecord(details) || details["chainId"] !== chainId) return { ok: false, reason: "the challenge chain differs from the offer's network" };
  // `splits` は mppx の形では `methodDetails` の下（SDK はそこを読む）。request の直下にあっても拒む。
  if ("splits" in request || "splits" in details) return { ok: false, reason: "the challenge carries splits (not supported)" };
  return { ok: true };
}

/** offer を読んで、どの payer で署名するか（または拒む理由）を決める。 */
export function classifyOffer(offer: unknown, nowMs: number, networks: readonly KnownNetwork[] = KNOWN_NETWORKS, maxAmount: bigint = SIGN_MAX_AMOUNT): SignDispatch {
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
  // 「no well-formed challengeNonce」になっていた（M6 で修正。`docs/mpp-solana-design.md` §13）。MPP の Solana は下で中身の `id` との一致も確かめる。
  const isMpp = scheme === "tempo/charge" || scheme === "solana/charge";
  const nonce = extra?.["challengeNonce"];
  if (typeof nonce !== "string" || !(NONCE_PATTERN.test(nonce) || (isMpp && MPPX_ID_PATTERN.test(nonce)))) return { kind: "refuse", reason: "the offer has no well-formed challengeNonce" };
  const entry = knownNetworkOf(networks, network);
  if (entry === undefined) return { kind: "refuse", reason: "the offer network is not in the table of known networks" };
  const known = knownAssetOf(entry, asset);
  if (known === undefined) return { kind: "refuse", reason: "the offer asset is not a known asset on that network" };
  if (!isWellFormedPayTo(network, payTo)) return { kind: "refuse", reason: "the offer payTo is not a well-formed address for that network" };

  if (scheme === "tempo/charge") {
    const chainId = evmChainIdOf(network);
    if (chainId === undefined || !entry.inbound.includes("mpp")) return { kind: "refuse", reason: "MPP offers are only accepted on the table's MPP networks" };
    // MPP の payer は serialized challenge（`extra.challenge`）で払う。無い offer は**送金の前に**拒む。
    if (typeof extra?.["challenge"] !== "string" || extra["challenge"] === "") return { kind: "refuse", reason: "the MPP offer does not carry the mppx challenge" };
    // SDK は **challenge の中身**（`request.amount`・`currency`・`recipient`）から送金を組む。封筒の offer と中身が違えば、承認した額と違う額が動く → 送金の前に拒む（M6 のレビューで指摘）。
    const checked = checkTempoChallenge(extra["challenge"], { amount, asset, payTo, extra }, chainId, nowMs);
    if (!checked.ok) return { kind: "refuse", reason: checked.reason };
    return { kind: "mpp", chainId, asset, payTo, amount };
  }
  if (scheme === "solana/charge") {
    // MPP の SVM（設計 §7）: 表の MPP の Solana にだけ。mint・桁・token program は表から。中身（challenge の request）も署名の前に offer・表と照合する。
    if (networkFamilyOf(network) !== "svm" || !entry.inbound.includes("mpp")) return { kind: "refuse", reason: "MPP Solana offers are only accepted on the table's MPP Solana networks" };
    if (known.tokenProgram === undefined) return { kind: "refuse", reason: "the table has no token program for that mint" };
    if (typeof extra?.["challenge"] !== "string" || extra["challenge"] === "") return { kind: "refuse", reason: "the MPP Solana offer does not carry the mppx challenge" };
    const externalId = extra["externalId"];
    if (typeof externalId !== "string" || externalId === "" || Buffer.byteLength(externalId, "utf8") > 256) return { kind: "refuse", reason: "the MPP Solana offer has no usable externalId (the Memo)" };
    if (extra["decimals"] !== undefined && extra["decimals"] !== known.decimals) return { kind: "refuse", reason: "the offer's decimals conflict with the table" };
    if (extra["tokenProgram"] !== undefined && extra["tokenProgram"] !== known.tokenProgram) return { kind: "refuse", reason: "the offer's token program conflicts with the table" };
    const scope = { mint: known.id, decimals: known.decimals, tokenProgram: known.tokenProgram };
    const checked = checkSvmMppChallenge(extra["challenge"], { amount, payTo, extra }, scope, nowMs);
    if (!checked.ok) return { kind: "refuse", reason: checked.reason };
    return { kind: "mpp-svm", ...scope, payTo, amount, externalId };
  }
  if (scheme !== "exact") return { kind: "refuse", reason: "the offer scheme is neither exact nor tempo/charge nor solana/charge" };
  if (!entry.inbound.includes("x402")) return { kind: "refuse", reason: "x402 offers are not accepted on that network" };
  if (extra?.["fundsMoveOnCredential"] === true) return { kind: "refuse", reason: "an exact offer must not move funds on signing" };

  if (networkFamilyOf(network) === "evm") {
    const chainId = evmChainIdOf(network);
    if (chainId === undefined) return { kind: "refuse", reason: "the offer network has no chain id" };
    if (known.domain === undefined) return { kind: "refuse", reason: "the table has no EIP-712 domain for that asset" };
    if (extra?.["name"] !== known.domain.name || extra?.["version"] !== known.domain.version) {
      return { kind: "refuse", reason: "the offer's EIP-712 domain does not match the table (refusing to sign an unexpected domain)" };
    }
    if (assetKeyOf(network, asset) !== assetKeyOf(network, known.id)) return { kind: "refuse", reason: "asset mismatch" };
    return { kind: "x402-evm", chainId, domain: known.domain, asset, payTo, amount };
  }
  // SVM
  if (known.tokenProgram === undefined) return { kind: "refuse", reason: "the table has no token program for that mint" };
  const feePayer = extra?.["feePayer"];
  const memo = extra?.["memo"];
  const challengeNonce = extra?.["challengeNonce"];
  if (typeof feePayer !== "string" || !isWellFormedPayTo(network, feePayer)) return { kind: "refuse", reason: "the offer has no well-formed feePayer" };
  if (typeof memo !== "string" || memo === "" || memo !== challengeNonce) return { kind: "refuse", reason: "the offer memo must be the challengeNonce" };
  // offer の extra が桁・token program・mint を名乗っていて表と違えば拒む（表が権威。設計 §5.6）。
  if (extra?.["decimals"] !== undefined && extra["decimals"] !== known.decimals) return { kind: "refuse", reason: "the offer's decimals conflict with the table" };
  if (extra?.["tokenProgram"] !== undefined && extra["tokenProgram"] !== known.tokenProgram) return { kind: "refuse", reason: "the offer's token program conflicts with the table" };
  if (extra?.["mint"] !== undefined && extra["mint"] !== known.id) return { kind: "refuse", reason: "the offer's mint conflicts with the table" };
  return { kind: "x402-svm", mint: known.id, decimals: known.decimals, tokenProgram: known.tokenProgram, payTo, feePayer, memo, amount };
}
