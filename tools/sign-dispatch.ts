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
 *
 * P-0（`docs/agent-payer-tasks.md`）: 共通の検査と EVM の分岐は `sign-classify-evm.ts`（`mppx`・Solana を import しない）に、Tempo の challenge の検査は
 * `sign-check-tempo.ts` に分けた。この module は全レールの振り分けで、分離前と同じ結果を返す。
 */

import { evmChainIdOf, isWellFormedPayTo, KNOWN_NETWORKS, networkFamilyOf, type KnownNetwork } from "../src/shared/networks.js";

import { checkTempoChallenge } from "./sign-check-tempo.js";
import { checkExactCommon, classifyExactEvm, parseOfferCommon, SIGN_MAX_AMOUNT, type SignDispatch } from "./sign-classify-evm.js";
import { checkSvmMppChallenge } from "./svm-mpp-payer.js";

export { checkTempoChallenge } from "./sign-check-tempo.js";
export { SIGN_MAX_AMOUNT, type SignDispatch } from "./sign-classify-evm.js";

/** offer を読んで、どの payer で署名するか（または拒む理由）を決める。 */
export function classifyOffer(offer: unknown, nowMs: number, networks: readonly KnownNetwork[] = KNOWN_NETWORKS, maxAmount: bigint = SIGN_MAX_AMOUNT): SignDispatch {
  const parsed = parseOfferCommon(offer, nowMs, networks, maxAmount);
  if ("kind" in parsed) return parsed;
  const { scheme, network, asset, amount, payTo, extra, entry, known } = parsed;

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
  const exact = checkExactCommon(parsed);
  if (exact !== undefined) return exact;

  if (networkFamilyOf(network) === "evm") return classifyExactEvm(parsed);
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
