/**
 * 受信レール **MPP の Solana charge**（`method="solana"`、`intent="charge"`）の**純粋な部分**（`docs/mpp-solana-design.md` §3.2〜§3.4、要件 FR-45〜FR-48。タスク M3-a）。
 * adapter（`createMppSolanaInbound`。設計 §3.5）はタスク M3-b でこのファイルの末尾に足す。
 *
 * - `mppSolanaChargeMethod`: `mppx` 0.11.0 の `Method.from` で challenge の request と credential の payload の **schema だけ**を定義する（検証・replay・RPC は含まない）
 * - `checkMppSolanaTransaction`: payer が全署名した transaction（bytes）を、承認済みの値（policy・amount・externalId）に対して**同期で**検査する。
 *   x402 SVM 受信の `checkSvmTransaction` と同じ手順（復号 → 署名の欄 → 構造 → 命令 → **組み直して byte 一致** → ed25519）だが形が違う:
 *   署名 1 つ（fee payer = payer = 転送の authority）、compute budget は各高々 1 つで順序は問わない、Memo = challenge の `request.externalId`
 * - `preflightMppSolana`: Tempo 受信と同じ 5 点（nonce・期限・accepted の完全一致・route binding・wire の中の challenge id）に、credential の型と形を足す。
 *   **構造の検査はここでは走らせない**（journal に残る `verify_failed` で落とす。設計 §3.4）
 *
 * 復号・compile・比較の例外はすべて `credential_mismatch`。Memo の不一致だけ `nonce_mismatch`。例外の文言は出さない。
 */

import { randomBytes } from "node:crypto";

import { ed25519 } from "@noble/curves/ed25519";
import { address, compileTransactionMessage, getAddressEncoder, getBase58Decoder, getBase58Encoder, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder, getTransactionDecoder, type Instruction } from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, parseSetComputeUnitLimitInstruction, parseSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { parseTransferCheckedInstruction } from "@solana-program/token";
import { Credential, Method, z } from "mppx";

import { MPP_SOLANA_SCHEME } from "../../config.js";
import { stableJson } from "../../core/intent.js";
import type { InboundOffer, PaymentCredential, PreflightResult } from "../../ports/inbound.js";
import { embeddedChallengeIdOf } from "./mpp.js";
import {
  buildSvmTransactionMessage,
  decodeBase64Strict,
  instructionOf,
  MEMO_PROGRAM_ADDRESS,
  SVM_DEFAULT_COMPUTE_UNITS,
  SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT,
  SVM_MAX_COMPUTE_UNITS,
  SVM_MAX_MICRO_LAMPORTS_PER_UNIT,
  SVM_TRANSACTION_MAX_BYTES,
} from "./x402-svm.js";

export { MPP_SOLANA_SCHEME };
export const MPP_SOLANA_METHOD = "solana";
export const MPP_SOLANA_INTENT = "charge";
/** challenge の `methodDetails.network` の値（draft: `"mainnet" | "devnet" | "localnet"`）。表の Solana devnet（CAIP-2）に対応する語。 */
export const MPP_SOLANA_NETWORK_LABELS: Readonly<Record<string, string>> = Object.freeze({ "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "devnet" });
/** `request.externalId`（Memo の束縛の値）の上限（bytes）。Memo の上限（256）と同じ。 */
export const MPP_SOLANA_EXTERNAL_ID_MAX_BYTES = 256;
/** base58 の署名（64 バイト）の文字数の範囲。 */
const BASE58_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * schema だけ（設計 §3.2）。`request` は draft の charge の欄のうち Router が出す／読むもの。`methodDetails` の余分な欄（`feePayerKey`・`recentBlockhash`・`splits`）は
 * zod mini の既定（strip）で落ちる: Router が発行する側なので出さない。credential の `payload.type` は 2 つ。形の検査（base64・base58）は Router の関数で。
 */
export const mppSolanaChargeMethod = Method.from({
  name: MPP_SOLANA_METHOD,
  intent: MPP_SOLANA_INTENT,
  schema: {
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      externalId: z.string(),
      methodDetails: z.object({
        network: z.string(),
        decimals: z.number(),
        tokenProgram: z.string(),
        feePayer: z.boolean(),
      }),
    }),
    credential: {
      payload: z.object({
        type: z.enum(["transaction", "signature"]),
        transaction: z.optional(z.string()),
        signature: z.optional(z.string()),
      }),
    },
  },
});

/** challenge ごとの `externalId`（16 バイトの乱数を base58。HMAC の入力に入る。Memo の照合の値）。 */
export function newExternalId(): string {
  return getBase58Decoder().decode(randomBytes(16));
}

/** 起動時に固定される値（受取 owner と、導いて検査した ATA。設計 §3.1）。 */
export interface MppSolanaPolicy {
  readonly recipient: string;
  readonly destinationAta: string;
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: string;
}

export type MppSolanaCheckReason = "credential_mismatch" | "nonce_mismatch";

export type MppSolanaCheck =
  | { readonly ok: true; readonly signature: string; readonly signer: string; readonly blockhash: string; readonly units: number | undefined; readonly microLamports: bigint | undefined }
  | { readonly ok: false; readonly reason: MppSolanaCheckReason };

const MISMATCH: MppSolanaCheck = Object.freeze({ ok: false, reason: "credential_mismatch" });
const NONCE_MISMATCH: MppSolanaCheck = Object.freeze({ ok: false, reason: "nonce_mismatch" });

function isAllZero(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0) return false;
  return true;
}

export function isSvmSignatureString(value: unknown): value is string {
  if (typeof value !== "string" || !BASE58_SIGNATURE_PATTERN.test(value)) return false;
  try {
    return getBase58Encoder().encode(value).length === 64;
  } catch {
    return false;
  }
}

export function isSvmPublicKeyString(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 32 || value.length > 44 || !BASE58_PATTERN.test(value)) return false;
  try {
    return getBase58Encoder().encode(value).length === 32;
  } catch {
    return false;
  }
}

/**
 * 共通の形の検査（設計 §3.3 の 7 行）。`signerAta` は呼び出し側が非同期で導く（`findAssociatedTokenPda(mint, 署名者, tokenProgram)`。署名者は
 * `signerOf` で先に読む）。通れば署名（base58）・署名者・blockhash・観測した compute の値。
 */
export function checkMppSolanaTransaction(bytes: Uint8Array, policy: MppSolanaPolicy, amount: string, externalId: string, signerAta: string): MppSolanaCheck {
  try {
    // 1. transaction の復号。読み残しは拒否。署名はちょうど 1 つで、全ゼロでない。
    if (bytes.length === 0 || bytes.length > SVM_TRANSACTION_MAX_BYTES) return MISMATCH;
    const [tx, next] = getTransactionDecoder().read(bytes, 0);
    if (next !== bytes.length) return MISMATCH;
    if (bytes[0] !== 1 || bytes.length < 1 + 64) return MISMATCH;
    const sig0 = bytes.subarray(1, 65);
    if (isAllZero(sig0)) return MISMATCH;

    // 2. message の構造: version 0、lookup table 無し、署名者 1 つ = fee payer = staticAccounts[0]。命令は 2〜4 つ。
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (compiled.version !== 0) return MISMATCH;
    const lookups = (compiled as { addressTableLookups?: readonly unknown[] }).addressTableLookups;
    if (lookups !== undefined && lookups.length > 0) return MISMATCH;
    if (compiled.header.numSignerAccounts !== 1) return MISMATCH;
    const signer = compiled.staticAccounts[0];
    if (signer === undefined) return MISMATCH;
    const signerText = String(signer);
    if (signerText === policy.recipient || signerText === policy.destinationAta || signerText === policy.mint || signerText === policy.tokenProgram) return MISMATCH;
    const count = compiled.instructions.length;
    if (count < 2 || count > 4) return MISMATCH;
    const ix = compiled.instructions.map((c) => instructionOf(compiled, c));
    if (ix.some((i) => i === undefined)) return MISMATCH;
    const parsed = ix as Instruction[];

    // 3. 先頭の compute-budget の命令（0〜2 つ。discriminator 2 = limit、3 = price を各高々 1 つ。順序は問わない。他は不可）。
    let index = 0;
    let units: number | undefined;
    let microLamports: bigint | undefined;
    let order: "limit-first" | "price-first" = "limit-first";
    while (index < count - 2 && String(parsed[index]!.programAddress) === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      const data = new Uint8Array(parsed[index]!.data ?? []);
      if ((parsed[index]!.accounts ?? []).length !== 0) return MISMATCH;
      if (data[0] === 2) {
        if (units !== undefined) return MISMATCH;
        units = parseSetComputeUnitLimitInstruction(parsed[index] as never).data.units;
        if (!Number.isSafeInteger(units) || units <= 0 || units > SVM_MAX_COMPUTE_UNITS) return MISMATCH;
        if (microLamports !== undefined) order = "price-first";
      } else if (data[0] === 3) {
        if (microLamports !== undefined) return MISMATCH;
        microLamports = parseSetComputeUnitPriceInstruction(parsed[index] as never).data.microLamports;
        if (microLamports < 0n || microLamports > SVM_MAX_MICRO_LAMPORTS_PER_UNIT) return MISMATCH;
        if (units === undefined) order = "price-first";
      } else {
        return MISMATCH;
      }
      index += 1;
    }
    if (count - index !== 2) return MISMATCH;
    const transferIx = parsed[index]!;
    const memoIx = parsed[index + 1]!;

    // 4. TransferChecked（program = 表、額・桁、mint、宛先 = recipient の導出 ATA、authority = 署名者、source = 署名者の導出 ATA）。
    if (String(transferIx.programAddress) !== policy.tokenProgram) return MISMATCH;
    const transfer = parseTransferCheckedInstruction(transferIx as never);
    const source = String(transfer.accounts.source.address);
    const destination = String(transfer.accounts.destination.address);
    const mint = String(transfer.accounts.mint.address);
    const authority = String(transfer.accounts.authority.address);
    if (destination !== policy.destinationAta || mint !== policy.mint) return MISMATCH;
    if (transfer.data.amount !== BigInt(amount) || transfer.data.decimals !== policy.decimals) return MISMATCH;
    if (authority !== signerText || source !== signerAta) return MISMATCH;

    // 5. Memo（program、口座 0、data = externalId の UTF-8 と byte 一致）。違えば nonce_mismatch（署名の検査より先）。
    if (String(memoIx.programAddress) !== String(MEMO_PROGRAM_ADDRESS)) return MISMATCH;
    const memoText = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(memoIx.data ?? []));
    if ((memoIx.accounts ?? []).length !== 0 || memoText !== externalId) return NONCE_MISMATCH;

    // 6. 観測した組み合わせで組み直して byte 一致（header・口座の並び・data・lookup table 無しがここで一度に決まる）。
    const rebuilt = buildSvmTransactionMessage({
      feePayer: signerText,
      source: signerAta,
      authority: signerText,
      destination: policy.destinationAta,
      mint: policy.mint,
      amount: BigInt(amount),
      decimals: policy.decimals,
      memo: externalId,
      units: units ?? SVM_DEFAULT_COMPUTE_UNITS,
      microLamports: microLamports ?? SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT,
      computeBudget: { limit: units !== undefined, price: microLamports !== undefined, order },
      blockhash: String(compiled.lifetimeToken),
      tokenProgram: policy.tokenProgram,
    });
    const rebuiltBytes = getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(rebuilt));
    if (rebuiltBytes.length !== tx.messageBytes.length || Buffer.compare(Buffer.from(rebuiltBytes), Buffer.from(new Uint8Array(tx.messageBytes))) !== 0) return MISMATCH;

    // 7. 署名者の ed25519（同期）。
    const publicKey = getAddressEncoder().encode(address(signerText));
    if (!ed25519.verify(sig0, new Uint8Array(tx.messageBytes), new Uint8Array(publicKey))) return MISMATCH;

    return { ok: true, signature: getBase58Decoder().decode(sig0), signer: signerText, blockhash: String(compiled.lifetimeToken), units, microLamports };
  } catch {
    return MISMATCH;
  }
}

/** transaction の bytes から署名者（`staticAccounts[0]`）だけを読む（ATA を導くため。検査は `checkMppSolanaTransaction`）。読めなければ `undefined`。 */
export function signerOf(bytes: Uint8Array): string | undefined {
  try {
    if (bytes.length === 0 || bytes.length > SVM_TRANSACTION_MAX_BYTES) return undefined;
    const [tx, next] = getTransactionDecoder().read(bytes, 0);
    if (next !== bytes.length) return undefined;
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const signer = compiled.staticAccounts[0];
    return signer === undefined ? undefined : String(signer);
  } catch {
    return undefined;
  }
}

/** credential の wire の `payload`（型と、型ごとの値）。読めなければ `undefined`。 */
export function mppSolanaPayloadOf(wire: unknown): { readonly type: "transaction"; readonly bytes: Uint8Array } | { readonly type: "signature"; readonly signature: string } | undefined {
  if (typeof wire !== "string" || wire === "") return undefined;
  let payload: unknown;
  try {
    payload = Credential.deserialize(wire).payload;
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (record["type"] === "transaction") {
    const text = record["transaction"];
    if (typeof text !== "string") return undefined;
    const bytes = decodeBase64Strict(text);
    if (bytes === undefined || bytes.length > SVM_TRANSACTION_MAX_BYTES) return undefined;
    return { type: "transaction", bytes };
  }
  if (record["type"] === "signature") {
    const signature = record["signature"];
    return isSvmSignatureString(signature) ? { type: "signature", signature } : undefined;
  }
  return undefined;
}

/**
 * preflight（同期。設計 §3.4）: Tempo 受信の 5 点 + credential の型と形。構造の検査（§3.3）は verify で。
 */
export function preflightMppSolana(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
  if (credential.payload.challengeNonce !== offer.extra.challengeNonce) {
    return { ok: false, reason: "nonce_mismatch" };
  }
  if (offer.extra.expiresAt * 1000 <= nowMs) {
    return { ok: false, reason: "offer_expired" };
  }
  const accepted = credential.accepted as InboundOffer | undefined;
  if (accepted === undefined || accepted.scheme !== MPP_SOLANA_SCHEME) {
    return { ok: false, reason: "credential_mismatch" };
  }
  if (accepted.extra?.routeBinding !== offer.extra.routeBinding) {
    return { ok: false, reason: "route_binding_mismatch" };
  }
  if (stableJson(accepted) !== stableJson(offer)) {
    return { ok: false, reason: "offer_mismatch" };
  }
  const wire = credential.payload["credential"];
  if (typeof wire !== "string" || embeddedChallengeIdOf(wire) !== offer.extra.challengeNonce) {
    return { ok: false, reason: "nonce_mismatch" };
  }
  if (mppSolanaPayloadOf(wire) === undefined) {
    return { ok: false, reason: "credential_mismatch" };
  }
  return { ok: true };
}
