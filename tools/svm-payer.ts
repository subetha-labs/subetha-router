/**
 * **payer 側**の SVM（Solana）x402 資格情報の組み立て（multirail 設計 §5.6。タスク T5）。**製品コードではない。**
 *
 * SDK の client（`@x402/svm`）は**使わない**（mint の metadata を RPC から読み、桁と program を RPC の値で決めるため）。
 * transaction は **Router と同じ builder**（`buildSvmTransactionMessage`）で**固定値だけ**から組む: 表の mint・桁・token program、
 * offer の `payTo`（owner）→ 宛先 ATA、額、`feePayer`、memo。RPC は **`getLatestBlockhash` の 1 回だけ**（mint も残高も読まない。simulate しない）。
 *
 * **署名だけで資金は動かない**（送信は facilitator の fee payer）。秘密鍵は引数で受け取り、戻り値・ログには出さない。
 */

import { address, createKeyPairSignerFromPrivateKeyBytes, getBase58Encoder, getTransactionEncoder, partiallySignTransactionMessageWithSigners, type KeyPairSigner } from "@solana/kit";

import { svmSeedFromKey } from "./svm-key.js";
import { findAssociatedTokenPda } from "@solana-program/token";

import { buildSvmTransactionMessage, SVM_DEFAULT_COMPUTE_UNITS, SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT } from "../src/adapters/inbound/x402-svm.js";

export const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

export interface SvmOfferView {
  readonly amount: string;
  readonly payTo: string;
  readonly extra: { readonly challengeNonce: string; readonly feePayer: string; readonly memo: string } & Record<string, unknown>;
}

export interface SvmPayerScope {
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: string;
}

export interface SvmPayer {
  readonly address: string;
  /** 承認済み offer に対する credential（base64 の封筒）。RPC は blockhash の 1 回だけ。 */
  credentialFor(offer: SvmOfferView, scope: SvmPayerScope): Promise<string>;
}

/** 鍵の形: base58 の 64 バイト（secret ‖ public）か 32 バイト、hex の 32 バイトの seed（解析は `tools/svm-key.ts`。能力の道具と同じ 1 箇所）。 */
export async function svmSignerFromKey(key: string): Promise<KeyPairSigner> {
  const seed = svmSeedFromKey(key);
  try {
    return await createKeyPairSignerFromPrivateKeyBytes(seed);
  } catch {
    // 失敗の文言に鍵の値を含めない（依存の例外は入力を文言に写す）。
    throw new Error("the Solana key must be base58 (64 or 32 bytes) or a 32-byte hex seed");
  }
}

interface RpcOptions {
  readonly rpcUrl?: string;
  /** 試験の差し替え（既定は globalThis.fetch）。 */
  readonly fetch?: typeof fetch;
}

export async function createSvmPayer(key: string, options: RpcOptions = {}): Promise<SvmPayer> {
  const signer = await svmSignerFromKey(key);
  const rpcUrl = options.rpcUrl ?? SOLANA_DEVNET_RPC;
  const doFetch = options.fetch ?? globalThis.fetch;

  async function latestBlockhash(): Promise<string> {
    const response = await doFetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await response.json()) as { result?: { value?: { blockhash?: unknown } } };
    const blockhash = json.result?.value?.blockhash;
    if (typeof blockhash !== "string" || getBase58Encoder().encode(blockhash).length !== 32) throw new Error("the RPC did not return a blockhash");
    return blockhash;
  }

  return {
    address: String(signer.address),
    async credentialFor(offer, scope) {
      if (typeof offer.extra.feePayer !== "string" || typeof offer.extra.memo !== "string" || offer.extra.memo !== offer.extra.challengeNonce) {
        throw new Error("the offer must carry feePayer and memo = challengeNonce");
      }
      const [source] = await findAssociatedTokenPda({ mint: address(scope.mint), owner: signer.address, tokenProgram: address(scope.tokenProgram) });
      const [destination] = await findAssociatedTokenPda({ mint: address(scope.mint), owner: address(offer.payTo), tokenProgram: address(scope.tokenProgram) });
      const blockhash = await latestBlockhash();
      const message = buildSvmTransactionMessage({
        feePayer: offer.extra.feePayer,
        source: String(source),
        authority: signer,
        destination: String(destination),
        mint: scope.mint,
        amount: BigInt(offer.amount),
        decimals: scope.decimals,
        memo: offer.extra.memo,
        units: SVM_DEFAULT_COMPUTE_UNITS,
        microLamports: SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT,
        blockhash,
        tokenProgram: scope.tokenProgram,
      });
      const signed = await partiallySignTransactionMessageWithSigners(message);
      const transaction = Buffer.from(getTransactionEncoder().encode(signed)).toString("base64");
      const credential = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, transaction } };
      return Buffer.from(JSON.stringify(credential), "utf8").toString("base64");
    },
  };
}
