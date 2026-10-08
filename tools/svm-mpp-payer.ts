/**
 * **payer 側**の Solana **MPP**（`solana/charge`、pull）の資格情報の組み立て（`docs/mpp-solana-design.md` §7、FR-49。タスク M6）。**製品コードではない。**
 *
 * pay-kit の client は**使わない**（`tools/svm-payer.ts` と同じ理由: RPC から読んだ値で桁・program を決めるため）。transaction は **Router と同じ builder**
 * （`buildSvmTransactionMessage`）で**固定値だけ**から組む: 表の mint・桁・token program、offer の `payTo`（受取 owner）→ 宛先 ATA、額、Memo = challenge の `externalId`。
 * 署名の前に **challenge の `request` の全欄が offer と表に一致すること**を確かめる（封筒の `extra` だけでなく中身も。SR-7 と同じ精神）。
 *
 * RPC は **`getLatestBlockhash` の 1 回だけ**（mint も残高も読まない。simulate しない。**`sendTransaction` は呼ばない**。口は `tools/svm-rpc.ts`:
 * Router と同じ guarded transport、loopback の拒否、10 秒、64 KiB）。
 * **署名だけで資金は動かない**: 送出するのは Router（purchase の settle）で、**fee payer はこの鍵**なので devnet SOL が要る。blockhash の寿命（約 1 分）の中で purchase を呼ぶこと。
 * 秘密鍵は引数で受け取り、戻り値・ログには出さない。
 */

import { address, getTransactionEncoder, signTransactionMessageWithSigners } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { Challenge, Credential } from "mppx";

import { buildSvmTransactionMessage, SVM_DEFAULT_COMPUTE_UNITS, SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT } from "../src/adapters/inbound/x402-svm.js";
import { SOLANA_DEVNET_RPC, svmSignerFromKey, type SvmPayerRpcOptions } from "./svm-payer.js";
import { createSvmRpc } from "./svm-rpc.js";

/** challenge の `request.externalId`（Memo）の上限（bytes）。Memo の上限と同じ（受信 adapter の `MPP_SOLANA_EXTERNAL_ID_MAX_BYTES` と同じ値）。 */
export const SVM_MPP_EXTERNAL_ID_MAX_BYTES = 256;

export interface SvmMppOfferView {
  readonly amount: string;
  readonly payTo: string;
  readonly extra: { readonly challengeNonce: string; readonly challenge: string; readonly externalId: string } & Record<string, unknown>;
}

export interface SvmMppPayerScope {
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: string;
}

export interface SvmMppPayer {
  readonly address: string;
  /** 承認済み offer に対する mppx の wire（`Payment …`。`transaction` 型、全署名）。RPC は blockhash の 1 回だけ。封筒は呼び出し側（`sign-run.ts`）が組む。 */
  credentialFor(offer: SvmMppOfferView, scope: SvmMppPayerScope): Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * challenge の中身（`request`）が offer と表に一致するか（署名の前。設計 §7）。一致しなければ理由（固定文）。
 * 鍵に触れない純粋な判定なので `classifyOffer` と試験が共有する。
 */
export function checkSvmMppChallenge(serialized: string, offer: { amount: string; payTo: string; extra: Record<string, unknown> }, scope: SvmMppPayerScope, nowMs: number): { ok: true; challenge: Record<string, unknown>; externalId: string } | { ok: false; reason: string } {
  let challenge: unknown;
  try {
    challenge = Challenge.deserialize(serialized);
  } catch {
    return { ok: false, reason: "the MPP Solana offer's challenge cannot be read" };
  }
  if (!isRecord(challenge)) return { ok: false, reason: "the MPP Solana offer's challenge cannot be read" };
  if (challenge["id"] !== offer.extra["challengeNonce"]) return { ok: false, reason: "the challenge id is not the offer's challengeNonce" };
  if (challenge["method"] !== "solana" || challenge["intent"] !== "charge") return { ok: false, reason: "the challenge is not solana/charge" };
  const expires = challenge["expires"];
  if (typeof expires === "string") {
    const at = Date.parse(expires);
    if (!Number.isFinite(at) || at <= nowMs) return { ok: false, reason: "the challenge has expired; take a new quote and ask for approval again" };
  }
  const request = challenge["request"];
  if (!isRecord(request)) return { ok: false, reason: "the challenge has no request" };
  if (request["amount"] !== offer.amount) return { ok: false, reason: "the challenge amount differs from the offer" };
  if (request["currency"] !== scope.mint) return { ok: false, reason: "the challenge currency is not the table's mint" };
  if (request["recipient"] !== offer.payTo) return { ok: false, reason: "the challenge recipient differs from the offer's payTo" };
  const externalId = request["externalId"];
  if (typeof externalId !== "string" || externalId === "" || Buffer.byteLength(externalId, "utf8") > SVM_MPP_EXTERNAL_ID_MAX_BYTES) {
    return { ok: false, reason: "the challenge has no usable externalId (the Memo)" };
  }
  if (externalId !== offer.extra["externalId"]) return { ok: false, reason: "the challenge externalId differs from the offer" };
  if ("splits" in request) return { ok: false, reason: "the challenge carries splits (not supported)" };
  const details = request["methodDetails"];
  if (!isRecord(details)) return { ok: false, reason: "the challenge has no methodDetails" };
  // protocol の欄は request の直下にも methodDetails にも置かれ得る（mppx の形は後者）。どちらにあっても拒む（この builder は読まないが、約束した拒否は完全に）。
  if ("feePayerKey" in request || "recentBlockhash" in request || "feePayerKey" in details || "recentBlockhash" in details) {
    return { ok: false, reason: "the challenge names a fee payer key or a blockhash (not a pull charge)" };
  }
  if (details["network"] !== "devnet") return { ok: false, reason: "the challenge network is not devnet (refusing to sign for another cluster)" };
  if (details["decimals"] !== scope.decimals) return { ok: false, reason: "the challenge decimals conflict with the table" };
  if (details["tokenProgram"] !== scope.tokenProgram) return { ok: false, reason: "the challenge token program conflicts with the table" };
  if (details["feePayer"] !== false) return { ok: false, reason: "the challenge expects the provider to pay the fee (feePayer must be false)" };
  return { ok: true, challenge, externalId };
}

export async function createSvmMppPayer(key: string, options: SvmPayerRpcOptions & { readonly nowMs?: () => number } = {}): Promise<SvmMppPayer> {
  const signer = await svmSignerFromKey(key);
  const rpc = createSvmRpc({ rpcUrl: options.rpcUrl ?? SOLANA_DEVNET_RPC, ...(options.allowLoopback === undefined ? {} : { allowLoopback: options.allowLoopback }) });
  const nowMs = options.nowMs ?? Date.now;

  return {
    address: String(signer.address),
    async credentialFor(offer, scope) {
      // 署名の前に challenge の中身を確かめる（振り分けと同じ判定を、鍵を持つ側でももう一度）。
      const checked = checkSvmMppChallenge(offer.extra.challenge, offer, scope, nowMs());
      if (!checked.ok) throw new Error(checked.reason);
      const [source] = await findAssociatedTokenPda({ mint: address(scope.mint), owner: signer.address, tokenProgram: address(scope.tokenProgram) });
      const [destination] = await findAssociatedTokenPda({ mint: address(scope.mint), owner: address(offer.payTo), tokenProgram: address(scope.tokenProgram) });
      const blockhash = await rpc.latestBlockhash();
      // Router の受信の検査（§3.3）と同じ形: fee payer = 署名者 = 転送の authority、compute budget は limit → price、Memo = externalId。
      const message = buildSvmTransactionMessage({
        feePayer: String(signer.address),
        source: String(source),
        authority: signer,
        destination: String(destination),
        mint: scope.mint,
        amount: BigInt(offer.amount),
        decimals: scope.decimals,
        memo: checked.externalId,
        units: SVM_DEFAULT_COMPUTE_UNITS,
        microLamports: SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT,
        blockhash,
        tokenProgram: scope.tokenProgram,
      });
      // 全署名（fee payer もこの鍵）。送出はしない。
      const signed = await signTransactionMessageWithSigners(message);
      const transaction = Buffer.from(getTransactionEncoder().encode(signed)).toString("base64");
      return Credential.serialize({ challenge: checked.challenge, payload: { type: "transaction", transaction } } as never);
    },
  };
}
