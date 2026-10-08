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

import { createHash, randomBytes, randomUUID } from "node:crypto";

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

/* ──────────────────────────────────────────────────────────────────────────────
 * adapter（`docs/mpp-solana-design.md` §3.1・§3.5・§3.6。タスク M3-b）
 * ────────────────────────────────────────────────────────────────────────────── */

import { Challenge } from "mppx";
import { Mppx } from "mppx/server";
import { findAssociatedTokenPda } from "@solana-program/token";

import type { GuardedTransport } from "../../net/guarded-fetch.js";
import type { CreateOfferRequest, InboundCallContext, InboundRail, SettleResult } from "../../ports/inbound.js";
import { followSvmSignature, svmSignatureStatusOf as followUpStatusOf } from "./svm-follow-up.js";
import { assertAtaAccount, svmFetchJson } from "./x402-svm-startup.js";

/** journal の消費済み署名の読み口（`docs/mpp-solana-design.md` §2.3）。合成が渡し、`startRouter` が store の load の後に bind する。bind の前の `has` は throw。 */
export interface ConsumedSignatures {
  has(txRef: string): boolean;
}

export class ConsumedSignaturesHolder implements ConsumedSignatures {
  #view: ReadonlySet<string> | undefined;
  bind(view: ReadonlySet<string>): void {
    this.#view = view;
  }
  has(txRef: string): boolean {
    if (this.#view === undefined) throw new Error("mpp solana inbound: the consumed-signature set is not bound yet (startRouter binds it after the store loads)");
    return this.#view.has(txRef);
  }
}

export interface MppSolanaInboundOptions {
  /** challenge の HMAC 束縛鍵（32 バイト以上。Tempo 受信と同じ注入）。 */
  readonly secretKey: string;
  /** 受取 owner（base58 32 バイト）。 */
  readonly recipient: string;
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: string;
  /** CAIP-2（`solana:…`。表の network）。 */
  readonly network: string;
  readonly maxTimeoutSeconds: number;
  readonly rpc: { readonly url: string; readonly transport: GuardedTransport };
  readonly consumed: ConsumedSignatures;
  readonly realm?: string;
  /** 単調な時計（ms。既定 `performance.now`）と `sleep`（試験の注入口）。 */
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** `transaction` 型の settle 全体の期限（経過時間、ms。既定 50,000）。 */
  readonly settleDeadlineMs?: number;
  /** 追跡（§3.5 の 4）: 開始からの期限（既定 30,000）、間隔（既定 2,000）、回数（既定 15）。 */
  readonly followUp?: { readonly totalMs?: number; readonly intervalMs?: number; readonly maxPolls?: number };
  /** RPC の 1 要求の期限（既定 10,000）。 */
  readonly rpcTimeoutMs?: number;
  readonly onDiagnostic?: (code: string) => void;
  /** 時刻（ms。verify の証拠の保持の期限の掃除に）。既定 `Date.now`。 */
  readonly now?: () => number;
}

export type MppSolanaInbound = InboundRail & { startup(): Promise<void> };

export const MPP_SOLANA_SETTLE_DEADLINE_MS = 50_000;
export const MPP_SOLANA_FOLLOW_UP_DEFAULTS = Object.freeze({ totalMs: 30_000, intervalMs: 2_000, maxPolls: 15 });
export const MPP_SOLANA_RPC_TIMEOUT_MS = 10_000;
/**
 * verify が残す証拠の保持: offer の期限の後、さらにこの猶予（1 時間）まで。**数では捨てない**（進行中の purchase の証拠を他の purchase の verify が
 * 押し出してはいけない）。core は settle の**直前**に offer の期限を再検査し（`orchestrator.ts` の `approval_expired`、`dynamic.ts` の「期限の再検査」）、
 * 期限の後は settle を呼ばない。期限の前に再検査を通った purchase が settle に至るまでにあるのは予算の予約（journal の追記）だけなので、
 * 猶予はその追記が止まり得る時間の上界として取る（1 時間止まった journal は Router 全体が止まっている）。再起動で証拠は消えるが、
 * 再起動をまたぐ purchase は core が `interrupted_at_restart` で終え、settle を再開しない。
 */
export const MPP_SOLANA_EVIDENCE_GRACE_MS = 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `getTransaction`（base64）の応答を読む。`null` = 無い。形違いは `undefined`。 */
function transactionResultOf(reply: Record<string, unknown> | undefined): { readonly bytes: Uint8Array; readonly err: unknown; readonly slot: number; readonly blockTime: number | null } | null | undefined {
  if (reply === undefined) return undefined;
  const result = reply["result"];
  if (result === null) return null;
  if (!isRecord(result)) return undefined;
  const transaction = result["transaction"];
  const meta = result["meta"];
  const slot = result["slot"];
  const blockTime = result["blockTime"];
  if (!Array.isArray(transaction) || typeof transaction[0] !== "string" || transaction[1] !== "base64") return undefined;
  if (!isRecord(meta) || !Object.hasOwn(meta, "err")) return undefined;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) return undefined;
  if (blockTime !== null && (typeof blockTime !== "number" || !Number.isSafeInteger(blockTime))) return undefined;
  const bytes = decodeBase64Strict(transaction[0]);
  if (bytes === undefined || bytes.length > SVM_TRANSACTION_MAX_BYTES) return undefined;
  return { bytes, err: meta["err"], slot, blockTime: blockTime as number | null };
}

/**
 * MPP の Solana charge の受信 adapter（push = `signature` 型と、Router が送出する `transaction` 型。sponsorship は持たない。D-18・D-28）。
 * challenge の発行と HMAC は `mppx` 0.11.0（`Mppx.create` + `Method.toServer`）、構造の検査と送出・追跡は Router 自身。
 */
export function createMppSolanaInbound(options: MppSolanaInboundOptions): MppSolanaInbound {
  if (options.secretKey.length < 32) {
    throw new Error("MPP inbound secretKey must be at least 32 bytes");
  }
  const networkLabel = MPP_SOLANA_NETWORK_LABELS[options.network];
  if (networkLabel === undefined) {
    throw new Error("mpp solana inbound: the network is not in the table of MPP Solana networks");
  }
  if (!isSvmPublicKeyString(options.recipient)) {
    throw new Error("mpp solana inbound: recipient must be a 32-byte base58 owner address");
  }
  const now = options.now ?? Date.now;
  const clock = options.clock ?? ((): number => performance.now());
  const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const settleDeadlineMs = options.settleDeadlineMs ?? MPP_SOLANA_SETTLE_DEADLINE_MS;
  const followUp = { ...MPP_SOLANA_FOLLOW_UP_DEFAULTS, ...options.followUp };
  const rpcTimeoutMs = options.rpcTimeoutMs ?? MPP_SOLANA_RPC_TIMEOUT_MS;
  const rpc = options.rpc;

  /**
   * verify が通った credential の証拠（offer の nonce と wire の hash に束縛）。settle はこれを使い、**検査をやり直さない**
   * （`signature` 型の payer は送金済み: settle での RPC の失敗や期限の経過を `rejected` = 未払いに写してはいけない。FR-47・SR-M1）。
   * 証拠が無い settle: `transaction` 型は RPC 無しの同じ検査（送出前なので `rejected` は正しい）、`signature` 型は throw（core は `unknown`）。
   */
  type Evidence = { readonly kind: "transaction" | "signature"; readonly check: Extract<MppSolanaCheck, { ok: true }>; readonly bytes: Uint8Array; readonly keepUntilMs: number };
  const evidence = new Map<string, Evidence>();
  /** 鍵は **offer 全体**（`stableJson`。nonce だけでなく額・externalId・routeBinding も）と wire の hash。同じ nonce で欄を変えた offer には使われない。 */
  function evidenceKeyOf(offer: InboundOffer, credential: PaymentCredential): string | undefined {
    const wire = credential.payload["credential"];
    if (typeof wire !== "string" || wire === "") return undefined;
    const hash = createHash("sha256").update(stableJson(offer)).update("\0").update(wire).digest("base64");
    return `${offer.extra.challengeNonce}|${hash}`;
  }
  function remember(key: string, offer: InboundOffer, held: Omit<Evidence, "keepUntilMs">): void {
    const nowMs = now();
    // 期限の過ぎた証拠だけ捨てる（offer の期限 + 猶予）。進行中の purchase の証拠は数に関わらず残る。
    for (const [k, v] of evidence) if (v.keepUntilMs <= nowMs) evidence.delete(k);
    evidence.set(key, { ...held, keepUntilMs: offer.extra.expiresAt * 1000 + MPP_SOLANA_EVIDENCE_GRACE_MS });
  }

  /** `startup()` が埋める（受取 owner の ATA。存在・owner・mint を RPC で確かめた値）。 */
  let policy: MppSolanaPolicy | undefined;
  function ready(): MppSolanaPolicy {
    if (policy === undefined) throw new Error("mpp solana inbound: startup() has not completed");
    return policy;
  }

  const serverMethod = Method.toServer(mppSolanaChargeMethod, {
    // 構造の検査は SDK の外（§3.3）。ここは HMAC・期限・scope の後に SDK が呼ぶ hook で、credential と challenge をそのまま返す。
    validate: async ({ credential }) => ({ challenge: credential.challenge, credential, details: {}, intent: MPP_SOLANA_INTENT, method: MPP_SOLANA_METHOD, request: credential.challenge.request }),
    // Router は `broadcastCredential` を呼ばない（送出は Router 自身。§3.5）。呼ばれたら設計の違反。
    broadcast: async () => {
      options.onDiagnostic?.("mpp_solana_sdk_broadcast_called");
      throw new Error("mpp solana inbound: the SDK broadcast hook must never be called");
    },
  });
  const mppx = Mppx.create({
    secretKey: options.secretKey,
    ...(options.realm === undefined ? {} : { realm: options.realm }),
    methods: [serverMethod],
  });

  async function rpcCall(method: "getAccountInfo" | "getTransaction" | "sendTransaction" | "getSignatureStatuses", params: unknown[], routeId: string, operation: string, timeoutMs: number): Promise<Record<string, unknown> | undefined> {
    return svmFetchJson(rpc.transport, rpc.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, timeoutMs, operation, routeId);
  }

  function offerOf(challenge: Record<string, unknown>, request: CreateOfferRequest, externalId: string): InboundOffer {
    const id = challenge["id"];
    if (typeof id !== "string" || id === "") throw new Error("mppx challenge has no id");
    // SDK が束縛した値と、payer に見せる値の一致（Tempo 受信と同じ: 型では守れない）。
    const bound = challenge["request"];
    if (!isRecord(bound)) throw new Error("mppx challenge has no request to verify against");
    const details = bound["methodDetails"];
    if (
      bound["amount"] !== request.amount ||
      bound["currency"] !== options.mint ||
      bound["recipient"] !== options.recipient ||
      bound["externalId"] !== externalId ||
      !isRecord(details) ||
      details["network"] !== networkLabel ||
      details["decimals"] !== options.decimals ||
      details["tokenProgram"] !== options.tokenProgram ||
      details["feePayer"] !== false
    ) {
      throw new Error("mppx bound a different request than offered");
    }
    const expires = challenge["expires"];
    if (typeof expires !== "string" || expires === "") throw new Error("mppx challenge did not carry an expiry");
    const expiresMs = Date.parse(expires);
    if (!Number.isFinite(expiresMs)) throw new Error("mppx challenge has an unparsable expiry");
    return {
      scheme: MPP_SOLANA_SCHEME,
      network: options.network,
      asset: options.mint,
      amount: request.amount,
      payTo: options.recipient,
      maxTimeoutSeconds: options.maxTimeoutSeconds,
      extra: {
        challengeNonce: id,
        expiresAt: Math.floor(expiresMs / 1000),
        routeBinding: request.routeBinding,
        // D-29: 保守的な開示（`signature` 型の payer は credential の時点で送金済み。`transaction` 型は purchase の送出で動く）。
        fundsMoveOnCredential: true,
        challenge: Challenge.serialize(challenge as never),
        externalId,
        decimals: options.decimals,
        tokenProgram: options.tokenProgram,
      },
    };
  }

  /** verify の共通部分: (1) SDK の HMAC・期限・scope、(2) 型ごとに bytes を得て署名者と ATA を導き、(3) §3.3。 */
  async function checkCredential(offer: InboundOffer, credential: PaymentCredential, context: InboundCallContext | undefined): Promise<{ readonly ok: true; readonly kind: "transaction" | "signature"; readonly check: Extract<MppSolanaCheck, { ok: true }>; readonly bytes: Uint8Array } | { readonly ok: false }> {
    const current = ready();
    const wire = credential.payload["credential"];
    if (typeof wire !== "string" || wire === "") return { ok: false };
    if (embeddedChallengeIdOf(wire) !== offer.extra.challengeNonce) return { ok: false };
    // (1) SDK の HMAC・期限・scope・method。SDK が返した challenge の id も offer の nonce と一致すること（§3.5）。
    let validated: unknown;
    try {
      validated = await mppx.validateCredential(wire, { scope: offer.extra.routeBinding });
    } catch {
      return { ok: false };
    }
    const validatedChallenge = isRecord(validated) ? validated["challenge"] : undefined;
    if (!isRecord(validatedChallenge) || validatedChallenge["id"] !== offer.extra.challengeNonce) return { ok: false };
    const externalId = offer.extra["externalId"];
    if (typeof externalId !== "string" || externalId === "") return { ok: false };
    const payload = mppSolanaPayloadOf(wire);
    if (payload === undefined) return { ok: false };
    const routeId = context?.routeId ?? "-";
    let bytes: Uint8Array;
    if (payload.type === "transaction") {
      bytes = payload.bytes;
    } else {
      // `signature` 型: 設定の RPC で 1 回読む（RPC の失敗・形違いは throw = core の `source_verify_unavailable`）。
      const reply = await rpcCall("getTransaction", [payload.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "base64" }], routeId, "mpp_solana_get_transaction", rpcTimeoutMs);
      const read = transactionResultOf(reply);
      if (read === undefined) throw new Error("mpp solana inbound: the RPC did not answer getTransaction in the expected form");
      if (read === null) return { ok: false };
      if (read.err !== null) return { ok: false };
      // `blockTime` は challenge の発行〜期限の窓（FR-47）。`null` は不正。
      const issuedAt = offer.extra.expiresAt - offer.maxTimeoutSeconds;
      if (read.blockTime === null || read.blockTime < issuedAt || read.blockTime > offer.extra.expiresAt) return { ok: false };
      bytes = read.bytes;
    }
    const signer = signerOf(bytes);
    if (signer === undefined) return { ok: false };
    let signerAta: string;
    try {
      signerAta = String((await findAssociatedTokenPda({ mint: address(current.mint), owner: address(signer), tokenProgram: address(current.tokenProgram) }))[0]);
    } catch {
      return { ok: false };
    }
    const check = checkMppSolanaTransaction(bytes, current, offer.amount, externalId, signerAta);
    if (!check.ok) return { ok: false };
    if (payload.type === "signature" && check.signature !== payload.signature) return { ok: false };
    return { ok: true, kind: payload.type, check, bytes };
  }

  /** `transaction` 型の settle（§3.5）: 消費済み → 送出 1 回 → error なら status 1 回 → 追跡 → 行。 */
  async function settleTransaction(bytes: Uint8Array, signature: string, routeId: string): Promise<SettleResult> {
    if (options.consumed.has(signature)) return { outcome: "rejected", reason: "source_rejected" };
    const deadlineAt = clock() + settleDeadlineMs;
    const remaining = (): number => Math.max(0, Math.floor(deadlineAt - clock()));
    const base64 = Buffer.from(bytes).toString("base64");
    let sent: Record<string, unknown> | undefined;
    let sendFailed = false;
    try {
      sent = await rpcCall("sendTransaction", [base64, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 }], routeId, "mpp_solana_send", Math.min(rpcTimeoutMs, remaining()));
    } catch (error) {
      rpc.transport.report(error, { routeId, operation: "mpp_solana_send" });
      sendFailed = true;
    }
    const followed = async (): Promise<SettleResult> => {
      const start = clock();
      const result = await followSvmSignature({
        rpc,
        signature,
        routeId,
        operation: "mpp_solana_follow_up",
        deadlineAt: Math.min(deadlineAt, start + followUp.totalMs),
        intervalMs: followUp.intervalMs,
        requestTimeoutMs: rpcTimeoutMs,
        clock,
        sleep,
        errTerminalAt: "confirmed",
        searchTransactionHistory: true,
        maxPolls: followUp.maxPolls,
      });
      if (result === "settled") return { outcome: "settled", txRef: signature };
      if (result === "failed") {
        options.onDiagnostic?.("mpp_solana_tx_failed_on_chain");
        return { outcome: "rejected", reason: "source_rejected" };
      }
      return { outcome: "unknown", reason: "source_settle_unknown" };
    };
    if (sendFailed || sent === undefined) return followed();
    if (sent["error"] !== undefined) {
      // RPC の error（preflight の失敗を含む）: 1 回だけ履歴つきで status を読む。既に chain 上なら settled、err なら rejected、見えなければ追跡へ。
      options.onDiagnostic?.("mpp_solana_send_rejected");
      let status: "settled" | "failed" | "pending" = "pending";
      try {
        const reply = await rpcCall("getSignatureStatuses", [[signature], { searchTransactionHistory: true }], routeId, "mpp_solana_send_recovery", Math.min(rpcTimeoutMs, remaining()));
        status = svmSignatureStatusOfReply(reply);
      } catch (error) {
        rpc.transport.report(error, { routeId, operation: "mpp_solana_send_recovery" });
      }
      if (status === "settled") return { outcome: "settled", txRef: signature };
      if (status === "failed") {
        options.onDiagnostic?.("mpp_solana_tx_failed_on_chain");
        return { outcome: "rejected", reason: "source_rejected" };
      }
      return followed();
    }
    // 応答の署名が自分の署名と違えば不明（送った bytes と別のものを受理したことになる）。
    if (sent["result"] !== signature) return { outcome: "unknown", reason: "source_settle_unknown" };
    return followed();
  }

  return {
    async startup(): Promise<void> {
      let destinationAta: string;
      try {
        destinationAta = String((await findAssociatedTokenPda({ mint: address(options.mint), owner: address(options.recipient), tokenProgram: address(options.tokenProgram) }))[0]);
      } catch {
        throw new Error("mpp solana inbound: the receiving ATA could not be derived from the recipient, mint and token program");
      }
      let reply: Record<string, unknown> | undefined;
      try {
        reply = await rpcCall("getAccountInfo", [destinationAta, { encoding: "jsonParsed", commitment: "confirmed" }], "-", "mpp_solana_startup", rpcTimeoutMs);
      } catch {
        throw new Error("mpp solana inbound: the Solana RPC could not be read at startup");
      }
      assertAtaAccount(reply, { owner: options.recipient, mint: options.mint, tokenProgram: options.tokenProgram });
      policy = Object.freeze({ recipient: options.recipient, destinationAta, mint: options.mint, decimals: options.decimals, tokenProgram: options.tokenProgram });
    },

    async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
      ready();
      if (request.asset !== options.mint || request.network !== options.network) {
        throw new Error("mpp solana inbound: the route asset or network is not the fixed mint or network");
      }
      const externalId = newExternalId();
      const expires = new Date(request.nowMs + options.maxTimeoutSeconds * 1000).toISOString();
      const challenge: unknown = await mppx.challenge.solana.charge({
        amount: request.amount,
        currency: options.mint,
        recipient: options.recipient,
        externalId,
        methodDetails: { network: networkLabel, decimals: options.decimals, tokenProgram: options.tokenProgram, feePayer: false },
        expires,
        scope: request.routeBinding,
        meta: { routeBinding: request.routeBinding, paymentId: `${request.routeId}:${request.nowMs}:${randomUUID()}` },
      } as never);
      if (!isRecord(challenge)) throw new Error("mppx did not return a challenge");
      return offerOf(challenge, request, externalId);
    },

    preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
      ready();
      return preflightMppSolana(offer, credential, nowMs);
    },

    async verify(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<{ isValid: boolean }> {
      const checked = await checkCredential(offer, credential, context);
      if (!checked.ok) return { isValid: false };
      const key = evidenceKeyOf(offer, credential);
      if (key !== undefined) remember(key, offer, { kind: checked.kind, check: checked.check, bytes: checked.bytes });
      return { isValid: true };
    },

    async settle(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<SettleResult> {
      ready();
      const routeId = context?.routeId ?? "-";
      const wire = credential.payload["credential"];
      const payload = typeof wire === "string" ? mppSolanaPayloadOf(wire) : undefined;
      if (payload === undefined) return { outcome: "rejected", reason: "source_rejected" };
      // `signature` 型（§3.5）: 消費済みの検査が先（RPC も証拠も要らない。再起動後の replay はここで止まる）。
      if (payload.type === "signature" && options.consumed.has(payload.signature)) return { outcome: "rejected", reason: "source_rejected" };
      const key = evidenceKeyOf(offer, credential);
      let held: Omit<Evidence, "keepUntilMs"> | undefined = key === undefined ? undefined : evidence.get(key);
      // 証拠は 1 回の settle で使い切る（同じ purchase の settle は core の lock で 1 回）。
      if (key !== undefined) evidence.delete(key);
      if (held === undefined) {
        if (payload.type === "signature") {
          // verify の証拠が無い `signature` 型は判定しない（payer は送金済みかもしれない。core は `unknown` に写す）。
          throw new Error("mpp solana inbound: settle of a signature-type credential without a prior verify");
        }
        // `transaction` 型: RPC 無しの同じ検査（まだ送出していないので `rejected` は未払いの宣言として正しい）。
        const checked = await checkCredential(offer, credential, context);
        if (!checked.ok) return { outcome: "rejected", reason: "source_rejected" };
        held = { kind: checked.kind, check: checked.check, bytes: checked.bytes };
      }
      if (held.kind === "signature") {
        return { outcome: "settled", txRef: held.check.signature };
      }
      return settleTransaction(held.bytes, held.check.signature, routeId);
    },
  };
}

/** `getSignatureStatuses` の応答（JSON-RPC の封筒）の 1 件の判定（`errTerminalAt: "confirmed"`）。 */
function svmSignatureStatusOfReply(reply: Record<string, unknown> | undefined): "settled" | "failed" | "pending" {
  return reply === undefined ? "pending" : followUpStatusOf(reply, "confirmed");
}
