/**
 * 受信レール x402 の **SVM（Solana）版**の純粋な部分（multirail 設計 §5.2〜5.4、要件 FR-16。タスク T4-a）。
 *
 * - `buildSvmTransactionMessage`: Router が受け取る**唯一の形**の message を組む（呼び出し側の道具 `tools/svm-payer.ts` と
 *   Router の組み直しが同じ関数を使う）: version 0、命令はちょうど 4 つ——SetComputeUnitLimit・SetComputeUnitPrice・
 *   SPL `TransferChecked`（legacy token program）・Memo——の順
 * - `checkSvmTransaction`: 提出された部分署名の transaction を**ネットワークに出ずに同期で**検査する。復号 → 署名の欄 →
 *   message の構造 → 命令の parse と範囲 → **固定値＋提出値から組み直した message と byte 単位で一致** → authority の
 *   ed25519 署名（`@noble/curves`、同期）
 * - `preflightSvm`: 既存の x402 preflight と同じ封筒の検査（nonce・期限・束縛・`accepted` の完全一致・未知キー）に上の検査を足す
 *
 * 復号・compile・比較の例外はすべて `credential_mismatch`。例外の文言は出さない。memo の不一致だけ `nonce_mismatch`。
 */

import { ed25519 } from "@noble/curves/ed25519";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  createNoopSigner,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction, parseSetComputeUnitLimitInstruction, parseSetComputeUnitPriceInstruction, COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { getTransferCheckedInstruction, parseTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import type { InboundOffer, PaymentCredential, PreflightResult } from "../../ports/inbound.js";

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

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** 起動時に固定される値（T4-b が `/supported` と ATA の検査で確定する）。 */
export interface SvmInboundPolicy {
  /** facilitator の fee payer（`/supported` の値）。 */
  readonly feePayer: string;
  /** 受取 owner（offer の `payTo`）。 */
  readonly payTo: string;
  /** owner の ATA（起動時に導いて検査した値）。 */
  readonly destinationAta: string;
  readonly mint: string;
  readonly decimals: number;
  /** legacy SPL token program だけ。 */
  readonly tokenProgram: string;
}

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
  readonly memo: string;
  readonly units: number;
  readonly microLamports: bigint;
  readonly blockhash: string;
  readonly tokenProgram?: string;
}

/** Router が受け取る唯一の形の message（version 0、命令 4 つ）。 */
export function buildSvmTransactionMessage(params: SvmMessageParams) {
  const authority = typeof params.authority === "string" ? createNoopSigner(address(params.authority)) : params.authority;
  const programAddress = address(params.tokenProgram ?? TOKEN_PROGRAM_ADDRESS);
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(params.feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: params.blockhash as never, lastValidBlockHeight: 0n }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: params.units }),
          getSetComputeUnitPriceInstruction({ microLamports: params.microLamports }),
          getTransferCheckedInstruction(
            { source: address(params.source), mint: address(params.mint), destination: address(params.destination), authority, amount: params.amount, decimals: params.decimals },
            { programAddress },
          ),
          { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [], data: new TextEncoder().encode(params.memo) },
        ],
        m,
      ),
  );
}

export type SvmCheckReason = "credential_mismatch" | "nonce_mismatch";

export type SvmCheckResult =
  | { readonly ok: true; readonly authority: string; readonly source: string; readonly units: number; readonly microLamports: bigint }
  | { readonly ok: false; readonly reason: SvmCheckReason };

const MISMATCH: SvmCheckResult = Object.freeze({ ok: false, reason: "credential_mismatch" });
const NONCE_MISMATCH: SvmCheckResult = Object.freeze({ ok: false, reason: "nonce_mismatch" });

function decodeBase64Strict(text: string): Uint8Array | undefined {
  if (text.length === 0 || text.length > SVM_TRANSACTION_MAX_BASE64_CHARS || !BASE64_PATTERN.test(text) || text.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(text, "base64");
  // 正準な base64 だけ（読み直して同じ文字列になること）。
  if (bytes.toString("base64") !== text) return undefined;
  return new Uint8Array(bytes);
}

function isAllZero(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b !== 0) return false;
  return true;
}

/** compiled の命令を parse できる `Instruction` に写す（口座は静的な表から）。 */
function instructionOf(compiled: { readonly staticAccounts: readonly Address[] }, ix: { readonly programAddressIndex: number; readonly accountIndices?: readonly number[]; readonly data?: ArrayLike<number> }): Instruction | undefined {
  const programAddress = compiled.staticAccounts[ix.programAddressIndex];
  if (programAddress === undefined) return undefined;
  const accounts: { address: Address; role: 0 }[] = [];
  for (const index of ix.accountIndices ?? []) {
    const account = compiled.staticAccounts[index];
    if (account === undefined) return undefined;
    accounts.push({ address: account, role: 0 });
  }
  return { programAddress, accounts, data: new Uint8Array(ix.data ?? []) } as Instruction;
}

/**
 * 提出された transaction（base64）を、承認済みの値（policy・amount・memo）に対して同期で検査する。
 * 通れば提出値（authority・source・compute）を返す。
 */
export function checkSvmTransaction(transaction: unknown, policy: SvmInboundPolicy, amount: string, memo: string): SvmCheckResult {
  try {
    if (typeof transaction !== "string") return MISMATCH;
    const bytes = decodeBase64Strict(transaction);
    if (bytes === undefined || bytes.length > SVM_TRANSACTION_MAX_BYTES) return MISMATCH;

    // 1. transaction の復号。読み残しは拒否。
    const [tx, next] = getTransactionDecoder().read(bytes, 0);
    if (next !== bytes.length) return MISMATCH;
    // 署名の数（compact-u16 の 1 バイト）: ちょうど 2。[0] fee payer は wire で全ゼロ、[1] authority は 64 バイト。
    if (bytes[0] !== 2 || bytes.length < 1 + 128) return MISMATCH;
    const sig0 = bytes.subarray(1, 65);
    const sig1 = bytes.subarray(65, 129);
    if (!isAllZero(sig0) || isAllZero(sig1)) return MISMATCH;

    // 2. message の構造。
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (compiled.version !== 0) return MISMATCH;
    const lookups = (compiled as { addressTableLookups?: readonly unknown[] }).addressTableLookups;
    if (lookups !== undefined && lookups.length > 0) return MISMATCH;
    if (compiled.header.numSignerAccounts !== 2) return MISMATCH;
    const feePayer = compiled.staticAccounts[0];
    const authority = compiled.staticAccounts[1];
    if (feePayer === undefined || authority === undefined) return MISMATCH;
    if (String(feePayer) !== policy.feePayer) return MISMATCH;
    if (compiled.instructions.length !== SVM_INSTRUCTION_COUNT) return MISMATCH;

    // 3. 命令の parse と範囲。program の照合は組み直しでも決まるが、parse の前に見る。
    const ix = compiled.instructions.map((c) => instructionOf(compiled, c));
    if (ix.some((i) => i === undefined)) return MISMATCH;
    const [limitIx, priceIx, transferIx, memoIx] = ix as [Instruction, Instruction, Instruction, Instruction];
    if (String(limitIx.programAddress) !== COMPUTE_BUDGET_PROGRAM_ADDRESS || String(priceIx.programAddress) !== COMPUTE_BUDGET_PROGRAM_ADDRESS) return MISMATCH;
    if (String(transferIx.programAddress) !== policy.tokenProgram || String(memoIx.programAddress) !== String(MEMO_PROGRAM_ADDRESS)) return MISMATCH;
    const units = parseSetComputeUnitLimitInstruction(limitIx as never).data.units;
    const microLamports = parseSetComputeUnitPriceInstruction(priceIx as never).data.microLamports;
    const transfer = parseTransferCheckedInstruction(transferIx as never);
    // memo はこの quote の nonce。違えば `nonce_mismatch`（署名の検査より先）。
    const memoText = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(memoIx.data ?? []));
    if ((memoIx.accounts ?? []).length !== 0 || memoText !== memo) return NONCE_MISMATCH;
    if (!Number.isSafeInteger(units) || units <= 0 || units > SVM_MAX_COMPUTE_UNITS) return MISMATCH;
    if (microLamports < 0n || microLamports > SVM_MAX_MICRO_LAMPORTS_PER_UNIT) return MISMATCH;
    const source = String(transfer.accounts.source.address);
    const destination = String(transfer.accounts.destination.address);
    const mint = String(transfer.accounts.mint.address);
    const transferAuthority = String(transfer.accounts.authority.address);
    if (destination !== policy.destinationAta || mint !== policy.mint) return MISMATCH;
    if (transfer.data.amount !== BigInt(amount) || transfer.data.decimals !== policy.decimals) return MISMATCH;
    if (transferAuthority !== String(authority)) return MISMATCH;
    if (source === policy.feePayer || source === policy.destinationAta || String(authority) === policy.feePayer || String(authority) === policy.payTo) return MISMATCH;

    // 4. 組み直して byte 一致（命令の数・順・program・口座と役割・data・header・version・lookup table 無し、がここで一度に決まる）。
    const rebuilt = buildSvmTransactionMessage({
      feePayer: policy.feePayer,
      source,
      authority: String(authority),
      destination: policy.destinationAta,
      mint: policy.mint,
      amount: BigInt(amount),
      decimals: policy.decimals,
      memo,
      units,
      microLamports,
      blockhash: String(compiled.lifetimeToken),
      tokenProgram: policy.tokenProgram,
    });
    const rebuiltBytes = getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(rebuilt));
    if (rebuiltBytes.length !== tx.messageBytes.length || Buffer.compare(Buffer.from(rebuiltBytes), Buffer.from(new Uint8Array(tx.messageBytes))) !== 0) return MISMATCH;

    // 5. authority の署名（同期）。
    const publicKey = getAddressEncoder().encode(authority);
    if (!ed25519.verify(sig1, new Uint8Array(tx.messageBytes), new Uint8Array(publicKey))) return MISMATCH;

    return { ok: true, authority: String(authority), source, units, microLamports };
  } catch {
    return MISMATCH;
  }
}

/** SVM 受信の offer が発行する `extra` のキー。 */
export const SVM_ISSUED_EXTRA_KEYS = ["feePayer", "memo", "challengeNonce", "expiresAt", "routeBinding", "fundsMoveOnCredential"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * SVM 受信の preflight（同期）。既存の x402 preflight と同じ封筒の検査（`src/adapters/inbound/x402.ts`）に、transaction の検査を足す。
 */
export function preflightSvm(offer: InboundOffer, credential: PaymentCredential, nowMs: number, policy: SvmInboundPolicy): PreflightResult {
  if (credential.payload["challengeNonce"] !== offer.extra.challengeNonce) {
    return { ok: false, reason: "nonce_mismatch" };
  }
  if (offer.extra.expiresAt * 1000 <= nowMs) {
    return { ok: false, reason: "offer_expired" };
  }
  const accepted = credential.accepted as Partial<InboundOffer> | undefined;
  if (accepted === undefined || accepted.scheme !== "exact") {
    return { ok: false, reason: "credential_mismatch" };
  }
  if (accepted.extra?.routeBinding !== offer.extra.routeBinding) {
    return { ok: false, reason: "route_binding_mismatch" };
  }
  if (
    accepted.network !== offer.network ||
    accepted.asset !== offer.asset ||
    accepted.amount !== offer.amount ||
    accepted.payTo !== offer.payTo ||
    accepted.maxTimeoutSeconds !== offer.maxTimeoutSeconds
  ) {
    return { ok: false, reason: "offer_mismatch" };
  }
  const acceptedExtra = accepted.extra;
  if (!isRecord(acceptedExtra)) {
    return { ok: false, reason: "offer_mismatch" };
  }
  for (const key of Object.keys(acceptedExtra)) {
    if (!(SVM_ISSUED_EXTRA_KEYS as readonly string[]).includes(key)) {
      return { ok: false, reason: "offer_mismatch" };
    }
  }
  for (const key of SVM_ISSUED_EXTRA_KEYS) {
    if (acceptedExtra[key] !== offer.extra[key]) {
      return { ok: false, reason: "offer_mismatch" };
    }
  }
  const memo = offer.extra["memo"];
  if (typeof memo !== "string" || memo !== offer.extra.challengeNonce) {
    return { ok: false, reason: "offer_mismatch" };
  }
  const checked = checkSvmTransaction(credential.payload["transaction"], policy, offer.amount, memo);
  return checked.ok ? { ok: true } : { ok: false, reason: checked.reason };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * adapter（multirail 設計 §5.1・§5.5・§6。タスク T4-c）
 * ────────────────────────────────────────────────────────────────────────────── */

import { randomBytes } from "node:crypto";

import { readBoundedBody } from "../../net/bounded-body.js";
import type { GuardedTransport, TransportContext } from "../../net/guarded-fetch.js";
import type { CreateOfferRequest, InboundCallContext, InboundRail, SettleResult } from "../../ports/inbound.js";

/** wire の `maxTimeoutSeconds`（facilitator が settle を待つ窓）の既定。settle の HTTP 期限はこれ＋10 秒。 */
export const SVM_DEFAULT_WIRE_TIMEOUT_SECONDS = 40;
/** offer の有効期間（承認期限）の既定（秒）。 */
export const SVM_DEFAULT_OFFER_SECONDS = 120;
/** facilitator の応答の上限（バイト）。 */
export const SVM_RESPONSE_MAX_BYTES = 64 * 1024;

export interface X402SvmInboundOptions {
  readonly facilitatorUrl: string;
  readonly transport: GuardedTransport;
  /** 起動時の検査で固定した値（`resolveSvmInboundPolicy`）。 */
  readonly policy: SvmInboundPolicy;
  /** wire の `maxTimeoutSeconds`。既定 40。 */
  readonly maxTimeoutSeconds?: number;
  /** offer の有効期間（秒）。既定 120。 */
  readonly offerSeconds?: number;
  /** verify の HTTP 期限（ms）。既定 10 秒。settle は `(maxTimeoutSeconds + 10) * 1000`。 */
  readonly timeoutMs?: number;
}

const BASE58_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** settle の `transaction` が SVM の signature の形（base58 で 64 バイト）か。 */
export function isSvmSignature(value: unknown): value is string {
  if (typeof value !== "string" || !BASE58_SIGNATURE_PATTERN.test(value)) return false;
  try {
    return getBase58Encoder().encode(value).length === 64;
  } catch {
    return false;
  }
}

/**
 * SVM 受信レール。Router が payee として offer を発行し（`payTo` は owner）、credential を自分で検査してから facilitator で verify → settle する。
 * 決済の結果は設計 §6 の表: 要求を出した後の失敗はすべて `unknown`、`success: true`・network 一致・64 バイトの signature だけが `settled`。
 */
/** HTTP の期限（設計 §4.4・§5.5）: verify は `timeoutMs`（既定 10 秒）、settle は wire の `maxTimeoutSeconds` ＋ 10 秒。 */
export function svmDeadlinesOf(options: Pick<X402SvmInboundOptions, "maxTimeoutSeconds" | "timeoutMs">): { readonly wireSeconds: number; readonly verifyMs: number; readonly settleMs: number } {
  const wireSeconds = options.maxTimeoutSeconds ?? SVM_DEFAULT_WIRE_TIMEOUT_SECONDS;
  return { wireSeconds, verifyMs: options.timeoutMs ?? 10_000, settleMs: (wireSeconds + 10) * 1000 };
}

export function createX402SvmInbound(options: X402SvmInboundOptions): InboundRail {
  const base = options.facilitatorUrl.replace(/\/$/, "");
  const transport = options.transport;
  const policy = options.policy;
  const deadlines = svmDeadlinesOf(options);
  const maxTimeoutSeconds = deadlines.wireSeconds;
  const offerSeconds = options.offerSeconds ?? SVM_DEFAULT_OFFER_SECONDS;
  const verifyTimeoutMs = deadlines.verifyMs;
  const settleTimeoutMs = deadlines.settleMs;

  async function post(path: string, requestText: string, context: TransportContext, deadlineMs: number): Promise<{ status: number; json: unknown }> {
    const response = await transport.fetch(
      `${base}${path}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: requestText, redirect: "error", signal: AbortSignal.timeout(deadlineMs) },
      context,
    );
    let text = "";
    try {
      const read = await readBoundedBody(response, SVM_RESPONSE_MAX_BYTES);
      text = read.ok ? new TextDecoder("utf-8", { fatal: false }).decode(read.bytes) : "";
    } catch (error) {
      transport.report(error, context);
      throw error;
    }
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json };
  }

  /** facilitator へ送る requirements。**Router 発行の offer からのみ組む。** */
  function requirementsOf(offer: InboundOffer): unknown {
    return { scheme: offer.scheme, network: offer.network, asset: offer.asset, amount: offer.amount, payTo: offer.payTo, maxTimeoutSeconds: offer.maxTimeoutSeconds, extra: offer.extra };
  }

  /** payload は `transaction` だけ（`challengeNonce` は送らない。設計 §5.5）。 */
  function requestTextOf(offer: InboundOffer, credential: PaymentCredential): string {
    return JSON.stringify({
      x402Version: 2,
      paymentPayload: { x402Version: credential.x402Version, scheme: offer.scheme, network: offer.network, accepted: credential.accepted, payload: { transaction: credential.payload["transaction"] } },
      paymentRequirements: requirementsOf(offer),
    });
  }

  return {
    async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
      if (request.asset !== policy.mint) {
        // 起動時に固定した mint 以外の route では offer を出さない（fail closed）。
        throw new Error("svm inbound: the route asset is not the fixed mint");
      }
      const challengeNonce = `0x${randomBytes(32).toString("hex")}`;
      return {
        scheme: "exact",
        network: request.network,
        asset: request.asset,
        amount: request.amount,
        payTo: policy.payTo,
        maxTimeoutSeconds,
        extra: {
          feePayer: policy.feePayer,
          // facilitator も照合する memo。この quote の nonce そのもの。
          memo: challengeNonce,
          challengeNonce,
          expiresAt: Math.floor(request.nowMs / 1000) + offerSeconds,
          routeBinding: request.routeBinding,
          // 部分署名だけでは資金は動かない（送信は fee payer）。
          fundsMoveOnCredential: false,
        },
      };
    },

    preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
      return preflightSvm(offer, credential, nowMs, policy);
    },

    async verify(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<{ isValid: boolean }> {
      const { status, json } = await post("/verify", requestTextOf(offer, credential), { routeId: context?.routeId ?? "-", operation: "facilitator_verify" }, verifyTimeoutMs);
      if (status !== 200 || typeof json !== "object" || json === null || Array.isArray(json)) {
        return { isValid: false };
      }
      // `invalidReason` 等は読まない（転送しない）。
      return { isValid: (json as Record<string, unknown>)["isValid"] === true };
    },

    async settle(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<SettleResult> {
      // 例外・タイムアウトは core が `unknown` にする。自動再 settle はしない。
      const { status, json } = await post("/settle", requestTextOf(offer, credential), { routeId: context?.routeId ?? "-", operation: "facilitator_settle" }, settleTimeoutMs);
      if (status !== 200 || typeof json !== "object" || json === null || Array.isArray(json)) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      const record = json as Record<string, unknown>;
      if (record["success"] !== true || record["network"] !== offer.network) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      const txRef = record["transaction"];
      if (!isSvmSignature(txRef)) {
        return { outcome: "unknown", reason: "source_settle_unknown" };
      }
      return { outcome: "settled", txRef };
    },
  };
}
