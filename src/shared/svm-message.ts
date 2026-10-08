/**
 * x402 の SVM（Solana）の message の**組み立て**と固定値（multirail 設計 §5.2）。P-0 で `src/adapters/inbound/x402-svm.ts` から抽出した
 * （x402-svm は同じ名前を re-export する）。Router の他の部分に依存せず、`@solana/kit` と program の client だけを使う
 * （payer のパッケージが vendor する。設計 `docs/agent-payer-design.md` §3.8）。
 */

import {
  address,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

export const MEMO_PROGRAM_ADDRESS = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Solana の packet の上限（bytes）。 */
export const SVM_TRANSACTION_MAX_BYTES = 1232;
/** base64 の文字列としての上限（1232 bytes → 1644 文字）。 */
export const SVM_TRANSACTION_MAX_BASE64_CHARS = 1644;
/** Router の方針（設計 §5.3-5）。SDK の facilitator の既定は上限なし。 */
export const SVM_MAX_COMPUTE_UNITS = 200_000;
/** facilitator の既定の上限と同じ（5 lamports/CU）。 */
export const SVM_MAX_MICRO_LAMPORTS_PER_UNIT = 5_000_000n;
/**
 * `npm run sign`（道具）が組む既定の compute budget。SDK の client の既定 20,000 では **Memo（66 文字の nonce）で尽きる**
 * （devnet の simulate の実測 2026-10-07: 消費 25,332 CU。T6）。上限 200,000 の内側で 2.4 倍の余裕を取る。
 */
export const SVM_DEFAULT_COMPUTE_UNITS = 60_000;
export const SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT = 1n;
export const SVM_INSTRUCTION_COUNT = 4;


export interface SvmMessageParams {
  readonly feePayer: string;
  /** 送り手の token account（提出値。所有・残高は chain と facilitator の simulate が見る）。 */
  readonly source: string;
  /** 署名者（authority）。アドレスか、署名できる signer。 */
  readonly authority: string | TransactionSigner;
  readonly destination: string;
  readonly mint: string;
  readonly amount: bigint;
  readonly decimals: number;
  /** Memo の文字列。`undefined` なら Memo 命令を付けない（MPP Solana 送信で相手の challenge に `externalId` が無いとき。`docs/mpp-solana-design.md` §5.1）。x402 は常に渡す。 */
  readonly memo: string | undefined;
  readonly units: number;
  readonly microLamports: bigint;
  /**
   * compute budget の命令の形（省略時は今までどおり `SetComputeUnitLimit(units)` → `SetComputeUnitPrice(microLamports)` の順で両方）。
   * MPP Solana 受信の組み直しが、観測した組み合わせ（各高々 1 つ・順序は 2 通り）で組むために使う（`docs/mpp-solana-design.md` §3.3・§5.1）。
   */
  readonly computeBudget?: { readonly limit: boolean; readonly price: boolean; readonly order: "limit-first" | "price-first" };
  readonly blockhash: string;
  /** lifetime の高さ（message の bytes には入らない。送信は RPC の値を渡し、受信・道具は省略 = 0n）。 */
  readonly lastValidBlockHeight?: bigint;
  readonly tokenProgram?: string;
}

/**
 * Router が受け取る・組む message（version 0）。x402 の形は命令ちょうど 4 つ = SetComputeUnitLimit・SetComputeUnitPrice・`TransferChecked`・Memo（既定の引数）。
 * MPP Solana（`docs/mpp-solana-design.md` §5.1）は Memo を省けて（命令 3 つ）、compute budget の 2 命令を各高々 1 つ・2 通りの順で組める。
 * 既定の引数では bytes は従来と同じ（x402 の wire 試験が証拠）。
 */
export function buildSvmTransactionMessage(params: SvmMessageParams) {
  const authority = typeof params.authority === "string" ? createNoopSigner(address(params.authority)) : params.authority;
  const programAddress = address(params.tokenProgram ?? TOKEN_PROGRAM_ADDRESS);
  const budget = params.computeBudget ?? { limit: true, price: true, order: "limit-first" };
  const limitIx = budget.limit ? [getSetComputeUnitLimitInstruction({ units: params.units })] : [];
  const priceIx = budget.price ? [getSetComputeUnitPriceInstruction({ microLamports: params.microLamports })] : [];
  const computeIxs = budget.order === "limit-first" ? [...limitIx, ...priceIx] : [...priceIx, ...limitIx];
  const memoIxs = params.memo === undefined ? [] : [{ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [], data: new TextEncoder().encode(params.memo) }];
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(params.feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: params.blockhash as never, lastValidBlockHeight: params.lastValidBlockHeight ?? 0n }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          ...computeIxs,
          getTransferCheckedInstruction(
            { source: address(params.source), mint: address(params.mint), destination: address(params.destination), authority, amount: params.amount, decimals: params.decimals },
            { programAddress },
          ),
          ...memoIxs,
        ],
        m,
      ),
  );
}
