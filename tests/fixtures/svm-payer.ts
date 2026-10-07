/**
 * 試験用の SVM payer（multirail 設計 §5.7）。Router が受け取る形の transaction を **製品と同じ builder** で組み、authority の鍵で
 * 部分署名して base64 にする。**改変の口**（宛先・額・mint・桁・命令の追加と並べ替え・memo・fee payer・version・lookup table・
 * 署名の破壊・fee payer の枠への署名・bytes の追加）を持つ。鍵は毎回の乱数。chain には出ない。
 */
import {
  address,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  signBytes,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { buildSvmTransactionMessage, SVM_DEFAULT_COMPUTE_UNITS, SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT, type SvmInboundPolicy } from "../../src/adapters/inbound/x402-svm.js";

export const TEST_BLOCKHASH = "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD";

export interface SvmPayerBuildOptions {
  readonly amount?: bigint;
  readonly memo?: string;
  readonly destination?: string;
  readonly mint?: string;
  readonly decimals?: number;
  readonly units?: number;
  readonly microLamports?: bigint;
  readonly feePayer?: string;
  readonly source?: string;
  readonly tokenProgram?: string;
  readonly blockhash?: string;
  /** 命令の列を差し替える（追加・並べ替え・data の改変）。 */
  readonly instructions?: (ixs: Instruction[]) => Instruction[];
  readonly version?: 0 | "legacy";
  /** address lookup table を参照する message にする（authority の署名はその message に対して有効。構造だけで落ちることを見る）。 */
  readonly lookupTable?: boolean;
  /** 署名後の bytes を改変する。 */
  readonly mutateBytes?: (bytes: Uint8Array) => Uint8Array;
  /** fee payer の枠にも（authority の）署名を入れる。 */
  readonly signFeePayerSlot?: boolean;
}

export interface SvmTestPayer {
  readonly signer: KeyPairSigner;
  readonly address: string;
  readonly sourceAta: string;
  /** policy・amount・memo から Router の形の transaction を組み、部分署名して base64 を返す。 */
  build(policy: SvmInboundPolicy, amount: string, memo: string, options?: SvmPayerBuildOptions): Promise<string>;
}

export async function createSvmTestPayer(mint: string, tokenProgram: string = TOKEN_PROGRAM_ADDRESS): Promise<SvmTestPayer> {
  const signer = await generateKeyPairSigner();
  const [sourceAta] = await findAssociatedTokenPda({ mint: address(mint), owner: signer.address, tokenProgram: address(tokenProgram) });
  return {
    signer,
    address: String(signer.address),
    sourceAta: String(sourceAta),
    async build(policy, amount, memo, options = {}) {
      const params = {
        feePayer: options.feePayer ?? policy.feePayer,
        source: options.source ?? String(sourceAta),
        authority: signer,
        destination: options.destination ?? policy.destinationAta,
        mint: options.mint ?? policy.mint,
        amount: options.amount ?? BigInt(amount),
        decimals: options.decimals ?? policy.decimals,
        memo: options.memo ?? memo,
        units: options.units ?? SVM_DEFAULT_COMPUTE_UNITS,
        microLamports: options.microLamports ?? SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT,
        blockhash: options.blockhash ?? TEST_BLOCKHASH,
        tokenProgram: options.tokenProgram ?? policy.tokenProgram,
      };
      let message = buildSvmTransactionMessage(params);
      if (options.instructions !== undefined || options.version !== undefined) {
        const instructions = options.instructions === undefined ? [...message.instructions] : options.instructions([...message.instructions] as Instruction[]);
        message = pipe(
          createTransactionMessage({ version: (options.version ?? 0) as 0 }),
          (m) => setTransactionMessageFeePayer(address(params.feePayer), m),
          (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: params.blockhash as never, lastValidBlockHeight: 0n }, m),
          (m) => appendTransactionMessageInstructions(instructions, m),
        ) as typeof message;
      }
      let bytes: Uint8Array;
      if (options.lookupTable === true) {
        const compiled = compileTransactionMessage(message);
        const withLookup = { ...compiled, addressTableLookups: [{ lookupTableAddress: address("AddressLookupTab1e1111111111111111111111111"), writableIndexes: [], readonlyIndexes: [] }] };
        const messageBytes = new Uint8Array(getCompiledTransactionMessageEncoder().encode(withLookup as never));
        // 署名は本物（authority の鍵で、lookup つきの message に対して）。fee payer の枠は空。
        const signature = await signBytes(signer.keyPair.privateKey, messageBytes);
        bytes = new Uint8Array(1 + 128 + messageBytes.length);
        bytes[0] = 2;
        bytes.set(signature, 65);
        bytes.set(messageBytes, 129);
      } else {
        const signed = await partiallySignTransactionMessageWithSigners(message);
        bytes = new Uint8Array(getTransactionEncoder().encode(signed));
      }
      if (options.signFeePayerSlot === true) {
        bytes = new Uint8Array(bytes);
        bytes.set(bytes.subarray(65, 129), 1);
      }
      if (options.mutateBytes !== undefined) bytes = options.mutateBytes(bytes);
      return Buffer.from(bytes).toString("base64");
    },
  };
}
