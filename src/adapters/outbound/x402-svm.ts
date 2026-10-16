/**
 * SVM の送信（Solana の Provider に払う）の**純粋な部分**（送信の設計 §4.2・§4.5 の 5〜7・10〜11、FR-24・FR-34・FR-35・FR-37。タスク U6-a）。
 * 前半は純粋関数（ネットワークにも鍵にも触れない）。後半の adapter `createX402SvmOutbound`（タスク U7。設計 §4.1・§4.3〜§4.6）は、
 * ここで組んだ期待値だけから message を組み、署名の前に `checkSvmOutboundMessage` で**builder と独立に**検査し、署名の後に
 * `recheckSvmWire` で wire を snapshot と照合してから 1 回だけ送出する。
 */
import { createHash } from "node:crypto";

import { ed25519 } from "@noble/curves/ed25519";
import {
  address,
  compileTransactionMessage,
  getAddressComparator,
  getAddressEncoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  type Address,
} from "@solana/kit";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";

import { decodePaymentRequiredHeader } from "@x402/core/http";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { findAssociatedTokenPda } from "@solana-program/token";

import type { DynamicProfile } from "../../config.js";
import { stableJson } from "../../core/intent.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../../net/bounded-body.js";
import { discardBody, type GuardedTransport } from "../../net/guarded-fetch.js";
import { parseUpstreamUrl } from "../../net/upstream-url.js";
import { DynamicTargetUnsupportedError, UpstreamMethodUnsupportedError, type DestinationOffer, type OutboundRail, type PayRequest, type PayResult, type SvmSigningCapability, type UpstreamTarget } from "../../ports/outbound.js";
import { buildSvmTransactionMessage, checkSvmTransaction, MEMO_PROGRAM_ADDRESS, SVM_DEFAULT_COMPUTE_UNITS, SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT, SVM_TRANSACTION_MAX_BYTES, type SvmInboundPolicy } from "../inbound/x402-svm.js";
import { assertAtaAccount, svmFetchJson } from "../inbound/x402-svm-startup.js";
import { createSvmOutboundCommon, type SvmStaticDestination } from "./svm-outbound-common.js";
import { readX402Challenge, type X402Challenge } from "./x402-challenge.js";
import { paidOutcomeOf, SVM_RECEIPT_FORM } from "./x402-dynamic.js";
import { diagStart, outboundDiagnosticsEnabled, recordChallengeFailure, recordPayTransportFailure, recordSignNotSent, type PayDiagnostics } from "./outbound-diagnostics.js";
import type { DiagnosticsSink } from "../../shared/diagnostics.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** System program（`@solana-program/system` は直接の依存にしないので定数で持つ）。 */
export const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";
const AMOUNT_PATTERN = /^(0|[1-9][0-9]*)$/;
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;
/** Memo の上限（SDK の client・facilitator と同じ 256 バイト）。 */
export const SVM_MEMO_MAX_BYTES = 256;
const MAX_TIMEOUT_SECONDS = 600;
const REQUIRED_KEYS = ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds", "extra"] as const;
const DESCRIPTIVE_KEYS = ["description", "mimeType", "resource"] as const;
const TOP_LEVEL_KEYS = new Set<string>([...REQUIRED_KEYS, ...DESCRIPTIVE_KEYS, "maxAmountRequired"]);
const EXTRA_KEYS = new Set<string>(["feePayer", "memo", "decimals"]);

/** base58 で 32 バイトに復号できる公開鍵か。 */
export function isSvmPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !BASE58_PATTERN.test(value) || value.length < 32 || value.length > 44) return false;
  try {
    return getBase58Encoder().encode(value).length === 32;
  } catch {
    return false;
  }
}

/** Memo の検査（送信の設計 §4.2 の 8、FR-37）: 文字列、UTF-8 で 1..256 バイト、制御文字無し。 */
export function isValidSvmMemo(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > SVM_MEMO_MAX_BYTES) return false;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** この adapter（1 つの network・1 つの mint）の固定値。`routerAta` は startup で導く。 */
export interface SvmOutboundScope {
  readonly network: string;
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: string;
  readonly routerAddress: string;
  readonly routerAta: string;
  /** 動的のときだけ（静的は承認済み offer の額をそのまま）。 */
  readonly maxUpstreamAmount?: string;
}

export type SvmOfferRejection =
  | "not_an_object"
  | "unknown_field"
  | "missing_field"
  | "scheme"
  | "network"
  | "asset"
  | "amount"
  | "amount_over_limit"
  | "pay_to"
  | "max_timeout"
  | "extra"
  | "fee_payer"
  | "memo"
  | "decimals"
  | "max_amount_required"
  | "descriptive_field";

/** `feePayer` が決して取ってはいけない固定の口座（Router の公開鍵・ATA、mint、program）。 */
function reservedAddressesOf(scope: SvmOutboundScope): readonly string[] {
  return [scope.routerAddress, scope.routerAta, scope.mint, scope.tokenProgram, String(MEMO_PROGRAM_ADDRESS), String(COMPUTE_BUDGET_PROGRAM_ADDRESS), SYSTEM_PROGRAM_ADDRESS];
}

/**
 * offer の**同期の検査**（送信の設計 §4.2 の 1〜9。ATA を要する不等式 `payTo` の ATA ≠ Router の ATA、`feePayer` ≠ 宛先 ATA は `checkSvmOfferAtas`）。
 * 純粋関数。通れば `undefined`。`operatorAddresses` は運用者の集合（FR-38。SVM の文字列はそのまま比較）。
 */
export function checkSvmOffer(raw: unknown, scope: SvmOutboundScope, operatorAddresses: ReadonlySet<string> | readonly string[]): SvmOfferRejection | undefined {
  if (!isRecord(raw)) return "not_an_object";
  const operators = operatorAddresses instanceof Set ? operatorAddresses : new Set(operatorAddresses);
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) return "unknown_field";
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(raw, key)) return "missing_field";
  }
  if (raw["scheme"] !== "exact") return "scheme";
  if (raw["network"] !== scope.network) return "network";
  // mint は大文字小文字を区別する（base58）。
  if (raw["asset"] !== scope.mint) return "asset";
  const amount = raw["amount"];
  if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount) || amount === "0") return "amount";
  if (scope.maxUpstreamAmount !== undefined && BigInt(amount) > BigInt(scope.maxUpstreamAmount)) return "amount_over_limit";
  const payTo = raw["payTo"];
  if (!isSvmPublicKey(payTo) || operators.has(payTo) || payTo === scope.mint || payTo === scope.tokenProgram) return "pay_to";
  const maxTimeoutSeconds = raw["maxTimeoutSeconds"];
  if (typeof maxTimeoutSeconds !== "number" || !Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds < 1 || maxTimeoutSeconds > MAX_TIMEOUT_SECONDS) return "max_timeout";
  const extra = raw["extra"];
  if (!isRecord(extra)) return "extra";
  for (const key of Object.keys(extra)) {
    // `recentBlockhash`・`lastValidBlockHeight`・`recentSlot`・`lighthouse`・`assetTransferMethod` 等は未知の鍵として拒む。
    if (!EXTRA_KEYS.has(key)) return "extra";
  }
  const feePayer = extra["feePayer"];
  if (!isSvmPublicKey(feePayer) || operators.has(feePayer) || feePayer === payTo || reservedAddressesOf(scope).includes(feePayer)) return "fee_payer";
  if (Object.hasOwn(extra, "memo") && !isValidSvmMemo(extra["memo"])) return "memo";
  if (Object.hasOwn(extra, "decimals") && extra["decimals"] !== scope.decimals) return "decimals";
  if (Object.hasOwn(raw, "maxAmountRequired") && raw["maxAmountRequired"] !== amount) return "max_amount_required";
  for (const key of DESCRIPTIVE_KEYS) {
    if (Object.hasOwn(raw, key) && typeof raw[key] !== "string") return "descriptive_field";
  }
  return undefined;
}

/** ATA を要する不等式（送信の設計 §4.2 の 4・7、FR-35）: 宛先 ATA ≠ Router の ATA、`feePayer` ≠ 宛先 ATA。 */
export function checkSvmOfferAtas(offer: DestinationOffer, scope: SvmOutboundScope, destinationAta: string): SvmOfferRejection | undefined {
  if (destinationAta === scope.routerAta) return "pay_to";
  if (offer.extra?.["feePayer"] === destinationAta) return "fee_payer";
  return undefined;
}

/** 署名する transaction の**期待値**（原始値だけの凍結した object。builder には写しを渡し、検査はこれと照合する）。 */
export interface SvmExpected {
  readonly feePayer: string;
  readonly source: string;
  readonly authority: string;
  readonly destination: string;
  readonly mint: string;
  readonly amount: bigint;
  readonly decimals: number;
  /** Memo。`undefined` なら Memo 命令の無い 3 命令の形（MPP Solana 送信で challenge に `externalId` が無いとき）。x402 は常に文字列。 */
  readonly memo: string | undefined;
  readonly units: number;
  readonly microLamports: bigint;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
  readonly tokenProgram: string;
}

/** Memo の既定（offer に無いとき）: 購入ごとに一意な Router の値。 */
export function defaultMemoOf(paymentId: string): string {
  return `subetha:${paymentId}`;
}

/**
 * 期待値を固める（送信の設計 §4.5 の 5）。offer から取るのは `feePayer`・`payTo`（→ 宛先 ATA は呼び出し側が導く）・`amount`・`memo` だけ。
 * Memo は offer の `extra.memo` か、無ければ `paymentId` からの既定——**どちらも実行時に検査する**（`paymentId` は任意の文字列）。
 */
export function expectedOf(args: {
  readonly offer: DestinationOffer;
  readonly scope: SvmOutboundScope;
  readonly destinationAta: string;
  readonly paymentId: string;
  readonly blockhash: string;
  readonly lastValidBlockHeight: bigint;
}): { readonly ok: true; readonly expected: SvmExpected } | { readonly ok: false; readonly reason: "destination_memo_invalid" | "destination_offer_not_allowed" } {
  const { offer, scope } = args;
  const feePayer = offer.extra?.["feePayer"];
  if (!isSvmPublicKey(feePayer) || !AMOUNT_PATTERN.test(offer.amount)) return { ok: false, reason: "destination_offer_not_allowed" };
  const memo = offer.extra !== undefined && Object.hasOwn(offer.extra, "memo") ? offer.extra["memo"] : defaultMemoOf(args.paymentId);
  if (!isValidSvmMemo(memo)) return { ok: false, reason: "destination_memo_invalid" };
  const expected: SvmExpected = Object.freeze({
    feePayer,
    source: scope.routerAta,
    authority: scope.routerAddress,
    destination: args.destinationAta,
    mint: scope.mint,
    amount: BigInt(offer.amount),
    decimals: scope.decimals,
    memo,
    units: SVM_DEFAULT_COMPUTE_UNITS,
    microLamports: SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT,
    blockhash: args.blockhash,
    lastValidBlockHeight: args.lastValidBlockHeight,
    tokenProgram: scope.tokenProgram,
  });
  return { ok: true, expected };
}

/** 期待値から message を組み、compile した bytes の**写し**を返す（builder には期待値の写しを渡す）。 */
export function compileSvmMessage(expected: SvmExpected): Uint8Array {
  const message = buildSvmTransactionMessage({ ...expected });
  const bytes = getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message));
  return Uint8Array.from(bytes);
}

const COMPUTE_UNIT_LIMIT_DISCRIMINATOR = 2;
const COMPUTE_UNIT_PRICE_DISCRIMINATOR = 3;
const TRANSFER_CHECKED_DISCRIMINATOR = 12;

/** little-endian の整数を読む（data の検査用。parser を信じず自分で読む）。 */
function readUintLE(bytes: Uint8Array, offset: number, size: number): bigint {
  let value = 0n;
  for (let index = size - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[offset + index]!);
  return value;
}

/**
 * kit の規則で口座の並びを**期待値から独立に**算出する（`@solana/transaction-messages` の compile: fee payer、署名・書込、署名・読取、
 * 非署名・書込、非署名・読取。同じ役割の中は `getAddressComparator()` の順）。source と destination の相対順はアドレスで変わる。
 */
export function expectedStaticAccountsOf(expected: SvmExpected): readonly string[] {
  const compare = getAddressComparator();
  const sortAddresses = (values: string[]): string[] => [...values].sort((a, b) => compare(a, b));
  const signerWritable = [expected.feePayer];
  const signerReadonly = [expected.authority];
  const nonSignerWritable = sortAddresses([expected.source, expected.destination]);
  const nonSignerReadonly = sortAddresses([expected.mint, expected.tokenProgram, String(COMPUTE_BUDGET_PROGRAM_ADDRESS), ...(expected.memo === undefined ? [] : [String(MEMO_PROGRAM_ADDRESS)])]);
  return [...signerWritable, ...signerReadonly, ...nonSignerWritable, ...nonSignerReadonly];
}

export type SvmMessageCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * 署名前の検査（送信の設計 §4.5 の 7。**builder と独立**: `buildSvmTransactionMessage` を呼ばず、復号した結果を期待値と 1 欄ずつ照合する）。
 * header 2/1/4、口座の並び（kit の規則から算出）、lifetime、命令 4 つ（program・discriminator・data 長・口座数・値）、Memo の byte 一致、読み残し無し。
 */
export function checkSvmOutboundMessage(messageBytes: Uint8Array, expected: SvmExpected): SvmMessageCheck {
  const fail = (reason: string): SvmMessageCheck => ({ ok: false, reason });
  let compiled;
  try {
    const [decoded, next] = getCompiledTransactionMessageDecoder().read(messageBytes, 0);
    if (next !== messageBytes.length) return fail("trailing_bytes");
    compiled = decoded;
  } catch {
    return fail("undecodable");
  }
  if (compiled.version !== 0) return fail("version");
  const lookups = (compiled as { addressTableLookups?: readonly unknown[] }).addressTableLookups;
  if (lookups !== undefined && lookups.length > 0) return fail("lookup_tables");
  const header = compiled.header;
  const readonlyNonSigners = expected.memo === undefined ? 3 : 4;
  if (header.numSignerAccounts !== 2 || header.numReadonlySignerAccounts !== 1 || header.numReadonlyNonSignerAccounts !== readonlyNonSigners) return fail("header");
  const accounts = compiled.staticAccounts.map((value) => String(value));
  const expectedAccounts = expectedStaticAccountsOf(expected);
  if (accounts.length !== expectedAccounts.length || accounts.some((value, index) => value !== expectedAccounts[index])) return fail("accounts");
  if (String(compiled.lifetimeToken) !== expected.blockhash) return fail("blockhash");
  const instructions = compiled.instructions;
  if (instructions.length !== (expected.memo === undefined ? 3 : 4)) return fail("instruction_count");
  const indexOf = (value: string): number => accounts.indexOf(value);
  const dataOf = (ix: { readonly data?: ArrayLike<number> }): Uint8Array => new Uint8Array(ix.data ?? []);
  const accountIndicesOf = (ix: { readonly accountIndices?: readonly number[] }): readonly number[] => ix.accountIndices ?? [];
  const [limitIx, priceIx, transferIx] = instructions as [typeof instructions[number], typeof instructions[number], typeof instructions[number]];
  const memoIx = expected.memo === undefined ? undefined : instructions[3]!;
  // (i) ComputeBudget SetComputeUnitLimit: discriminator 2、data 5 バイト、口座 0。
  const limitData = dataOf(limitIx);
  if (limitIx.programAddressIndex !== indexOf(String(COMPUTE_BUDGET_PROGRAM_ADDRESS)) || accountIndicesOf(limitIx).length !== 0 || limitData.length !== 5 || limitData[0] !== COMPUTE_UNIT_LIMIT_DISCRIMINATOR) return fail("compute_limit");
  if (readUintLE(limitData, 1, 4) !== BigInt(expected.units)) return fail("compute_limit_value");
  // (ii) SetComputeUnitPrice: discriminator 3、data 9 バイト、口座 0。
  const priceData = dataOf(priceIx);
  if (priceIx.programAddressIndex !== indexOf(String(COMPUTE_BUDGET_PROGRAM_ADDRESS)) || accountIndicesOf(priceIx).length !== 0 || priceData.length !== 9 || priceData[0] !== COMPUTE_UNIT_PRICE_DISCRIMINATOR) return fail("compute_price");
  if (readUintLE(priceData, 1, 8) !== expected.microLamports) return fail("compute_price_value");
  // (iii) TransferChecked: discriminator 12、data 10 バイト（amount u64 LE + decimals u8）、口座ちょうど 4 = [source, mint, destination, authority]。
  const transferData = dataOf(transferIx);
  const transferAccounts = accountIndicesOf(transferIx);
  if (transferIx.programAddressIndex !== indexOf(expected.tokenProgram) || transferData.length !== 10 || transferData[0] !== TRANSFER_CHECKED_DISCRIMINATOR) return fail("transfer");
  if (transferAccounts.length !== 4) return fail("transfer_accounts");
  const [sourceIndex, mintIndex, destinationIndex, authorityIndex] = transferAccounts as [number, number, number, number];
  if (accounts[sourceIndex] !== expected.source || accounts[mintIndex] !== expected.mint || accounts[destinationIndex] !== expected.destination || accounts[authorityIndex] !== expected.authority) return fail("transfer_accounts");
  if (readUintLE(transferData, 1, 8) !== expected.amount || transferData[9] !== expected.decimals) return fail("transfer_value");
  // 役割: source・destination は書込（非署名）、mint は読取、authority は署名・読取。header と並びで決まるが、index でも確かめる。
  const writableNonSignerStart = header.numSignerAccounts;
  const readonlyNonSignerStart = accounts.length - header.numReadonlyNonSignerAccounts;
  if (!(sourceIndex >= writableNonSignerStart && sourceIndex < readonlyNonSignerStart) || !(destinationIndex >= writableNonSignerStart && destinationIndex < readonlyNonSignerStart)) return fail("transfer_roles");
  if (!(mintIndex >= readonlyNonSignerStart) || authorityIndex !== 1) return fail("transfer_roles");
  // (iv) Memo: 口座 0、data が memo の UTF-8 と byte 一致（期待値に memo が無ければ命令も無い = 上の命令数で決まる）。
  if (memoIx !== undefined && expected.memo !== undefined) {
    const memoData = dataOf(memoIx);
    const expectedMemo = new TextEncoder().encode(expected.memo);
    if (memoIx.programAddressIndex !== indexOf(String(MEMO_PROGRAM_ADDRESS)) || accountIndicesOf(memoIx).length !== 0) return fail("memo");
    if (memoData.length !== expectedMemo.length || Buffer.compare(Buffer.from(memoData), Buffer.from(expectedMemo)) !== 0) return fail("memo_value");
  }
  return { ok: true };
}

/** message の bytes の sha256（小文字 hex 64 文字。journal の予約の鍵）。 */
export function messageHashOf(messageBytes: Uint8Array): string {
  return createHash("sha256").update(messageBytes).digest("hex");
}

/** 署名の検証（ed25519。公開鍵は base58 を 32 バイトに復号して渡す）。 */
export function verifySvmSignature(signature: Uint8Array, messageBytes: Uint8Array, publicKey: string): boolean {
  if (signature.length !== 64) return false;
  try {
    return ed25519.verify(signature, messageBytes, new Uint8Array(getAddressEncoder().encode(address(publicKey))));
  } catch {
    return false;
  }
}

/**
 * wire の組み立て（送信の設計 §4.5 の 11）: 署名の map は compile が作る signer の順（[0] fee payer = null → 全ゼロ、[1] authority = 署名）。
 * 返すのは**写し**。
 */
export function assembleSvmWire(messageBytes: Uint8Array, expected: SvmExpected, signature: Uint8Array): Uint8Array {
  const signatures: Record<Address, Uint8Array | null> = {};
  signatures[address(expected.feePayer)] = null;
  signatures[address(expected.authority)] = Uint8Array.from(signature) as never;
  const encoded = getTransactionEncoder().encode({ messageBytes: messageBytes as never, signatures: signatures as never });
  return Uint8Array.from(encoded);
}

/**
 * 送出前の wire の再検査（送信の設計 §4.5 の 11 (i)(ii)）: 復号できて読み残し無し、message が snapshot と byte 一致、全体 ≤ 1,232 バイト、
 * 署名 2 つ（[0] 全ゼロ、[1] = 署名）、そのうえで受信の `checkSvmTransaction`（提出値から再構築し ed25519 を検証する第 2 層）を policy で掛ける。
 */
export function recheckSvmWire(wire: Uint8Array, snapshot: Uint8Array, signature: Uint8Array, expected: SvmExpected, payTo: string): SvmMessageCheck {
  const fail = (reason: string): SvmMessageCheck => ({ ok: false, reason });
  if (wire.length > SVM_TRANSACTION_MAX_BYTES) return fail("too_large");
  // kit の decoder は message を「残り全部」として読むので、読み残しは長さで見る（署名 2 つ = 1 + 128 バイト + snapshot）。
  if (wire.length > 1 + 128 + snapshot.length) return fail("trailing_bytes");
  let decoded;
  try {
    const [tx, next] = getTransactionDecoder().read(wire, 0);
    if (next !== wire.length) return fail("trailing_bytes");
    decoded = tx;
  } catch {
    return fail("undecodable");
  }
  const message = new Uint8Array(decoded.messageBytes);
  if (message.length !== snapshot.length || Buffer.compare(Buffer.from(message), Buffer.from(snapshot)) !== 0) return fail("message_mismatch");
  if (wire[0] !== 2 || wire.length < 1 + 128) return fail("signatures");
  const sig0 = wire.subarray(1, 65);
  const sig1 = wire.subarray(65, 129);
  if (sig0.some((byte) => byte !== 0)) return fail("fee_payer_signature");
  if (sig1.length !== signature.length || Buffer.compare(Buffer.from(sig1), Buffer.from(signature)) !== 0) return fail("signature_mismatch");
  const policy: SvmInboundPolicy = { feePayer: expected.feePayer, payTo, destinationAta: expected.destination, mint: expected.mint, decimals: expected.decimals, tokenProgram: expected.tokenProgram };
  const second = checkSvmTransaction(Buffer.from(wire).toString("base64"), policy, expected.amount.toString(), expected.memo);
  if (!second.ok) return fail(`second_layer_${second.reason}`);
  return { ok: true };
}

// ---- U7: adapter（送信の設計 §4.1・§4.3〜§4.6、FR-24・FR-32〜FR-37。`src/adapters/outbound/x402-svm.ts` の末尾に足す） ----

export type { SvmStaticDestination } from "./svm-outbound-common.js";

export interface X402SvmOutboundOptions {
  readonly network: string;
  /** 静的 route の上流（`routeId` → canonical URL）。 */
  readonly upstreams: Readonly<Record<string, string>>;
  /** 静的 route の destination（`routeId` → payTo・asset・scheme）。`upstreams` と同じ鍵の集合。 */
  readonly destinations: Readonly<Record<string, SvmStaticDestination>>;
  readonly capability: SvmSigningCapability;
  /** 上流への HTTP（静的。既存の静的と同じ transport）。 */
  readonly transport: GuardedTransport;
  /** Solana RPC（§2.2。受信の起動時の検査と同じ作りの guarded transport）。 */
  readonly rpc: { readonly url: string; readonly transport: GuardedTransport };
  /** 運用者の集合（§2.3）。`startup()` が ATA を足すので可変の Set。 */
  readonly operatorAddresses: Set<string>;
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: string;
  /** 動的（`profileId` → プロファイル。送信が x402 かつ SVM のものだけを使う）。 */
  readonly dynamic?: {
    readonly profiles: Readonly<Record<string, DynamicProfile>>;
    readonly transport: GuardedTransport;
    readonly denyHosts: readonly string[];
  };
  readonly now?: () => number;
  readonly unpaidTimeoutMs?: number;
  readonly paidTimeoutMs?: number;
  /** blockhash を取ってから署名するまでの上限（FR-34）。既定 5,000。 */
  readonly fetchToSignMs?: number;
  readonly rpcTimeoutMs?: number;
  /** 診断の記録（設計 `docs/rejection-reasons-design.md` §4.3、タスク R-4。`cid` は書かない: EIP-3009 ではない）。無ければ何も記録しない。 */
  readonly diagnostics?: DiagnosticsSink;
  /** 試験だけ（§7 の停止点・改変）。 */
  readonly hooksForTest?: {
    afterReserve?(): void;
    afterSign?(): void;
    beforeSend?(): void;
    wire?(bytes: Uint8Array): Uint8Array;
  };
}

export type X402SvmOutbound = OutboundRail & {
  startup(): Promise<void>;
  balanceOf(routeId: string, asset: string): Promise<bigint>;
};

/** RPC の応答の上限（受信の起動時の検査と同じ 64 KiB・10 秒）。 */
export const SVM_OUTBOUND_RPC_TIMEOUT_MS = 10_000;
export const SVM_OUTBOUND_FETCH_TO_SIGN_MS = 5_000;
/** 未払いの読取・有料要求の期限の既定。drain の上限の試験（タスク R-0）が読む。 */
export const SVM_OUTBOUND_UNPAID_TIMEOUT_MS = 5_000;
export const SVM_OUTBOUND_PAID_TIMEOUT_MS = 30_000;

class SvmChallengeError extends Error {
  constructor(readonly reason: "url" | "status" | "no_header" | "undecodable" | "version" | "no_offers" | "too_many_offers" | "resource_mismatch" | "unreadable") {
    super(`svm outbound challenge rejected: ${reason}`);
    this.name = "SvmChallengeError";
  }
}

interface SvmChallenge {
  readonly accepts: readonly unknown[];
  /** SDK の封筒に載せる `resource`（`url` と文字列の説明だけ）。 */
  readonly resource: { url: string; description?: string; mimeType?: string };
}

export function createX402SvmOutbound(options: X402SvmOutboundOptions): X402SvmOutbound {
  const now = options.now ?? Date.now;
  const unpaidTimeoutMs = options.unpaidTimeoutMs ?? SVM_OUTBOUND_UNPAID_TIMEOUT_MS;
  const paidTimeoutMs = options.paidTimeoutMs ?? SVM_OUTBOUND_PAID_TIMEOUT_MS;
  const fetchToSignMs = options.fetchToSignMs ?? SVM_OUTBOUND_FETCH_TO_SIGN_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? SVM_OUTBOUND_RPC_TIMEOUT_MS;
  const hooks = options.hooksForTest ?? {};
  const diagnostics = options.diagnostics;
  const capability = options.capability;
  const operators = options.operatorAddresses;
  if (capability.network !== options.network) throw new Error("svm outbound: the signing capability is for a different network");
  if (!isSvmPublicKey(capability.address)) throw new Error("svm outbound: the signing capability address is not a 32-byte base58 key");
  for (const [routeId, raw] of Object.entries(options.upstreams)) {
    if (options.destinations[routeId] === undefined) throw new Error("svm outbound: every static route needs a destination");
    // 接続先は起動時に固定する（要求ごとに URL を組み立てない）。クエリ無しの GET 1 本。
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`x402.upstreams.${routeId} must be an absolute URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`x402.upstreams.${routeId} must use http(s)`);
    if (url.search !== "") throw new Error(`x402.upstreams.${routeId} must not carry a query`);
  }
  const dynamic = options.dynamic;
  if (dynamic !== undefined) {
    if (dynamic.transport.allowLoopback) throw new Error("the dynamic svm path must not use a transport that allows loopback");
    if (!dynamic.transport.boundsDns) throw new Error("the dynamic svm path requires a transport with a DNS deadline");
  }
  const profiles = new Map<string, DynamicProfile>();
  for (const [profileId, profile] of Object.entries(dynamic?.profiles ?? {})) {
    if (profile.rail !== "x402" || profile.destination.network !== options.network) continue;
    if (profile.destination.scheme !== "exact" || profile.destination.asset !== options.mint || profile.destination.decimals !== options.decimals) {
      throw new Error(`dynamic profile ${profileId} is not an svm exact profile for this adapter's mint`);
    }
    if (profile.destination.tokenProgram !== undefined && profile.destination.tokenProgram !== options.tokenProgram) {
      throw new Error(`dynamic profile ${profileId} names a different token program`);
    }
    profiles.set(profileId, profile);
  }
  const receiptForm = SVM_RECEIPT_FORM(capability.address);

  // 起動時の検査・ATA・RPC・残高は共有の部品（`svm-outbound-common.ts`。挙動は括り出す前と同じ）。
  const common = createSvmOutboundCommon({
    label: "svm outbound",
    rpc: options.rpc,
    rpcTimeoutMs,
    mint: options.mint,
    decimals: options.decimals,
    tokenProgram: options.tokenProgram,
    routerAddress: capability.address,
    operatorAddresses: operators,
    destinations: options.destinations,
    staticScheme: "exact",
  });
  const { ready, ataOf, rpcResult, ataExists, blockhashOf } = common;

  function scopeOf(routeId: string): SvmOutboundScope {
    const ata = ready();
    const profile = profiles.get(routeId);
    return {
      network: options.network,
      mint: options.mint,
      decimals: options.decimals,
      tokenProgram: options.tokenProgram,
      routerAddress: capability.address,
      routerAta: ata,
      ...(profile === undefined ? {} : { maxUpstreamAmount: profile.maxUpstreamAmount }),
    };
  }

  /** 静的の destination との照合（payTo・asset・scheme の完全一致）。 */
  function matchesStatic(routeId: string, offer: DestinationOffer): boolean {
    const destination = options.destinations[routeId];
    return destination !== undefined && offer.payTo === destination.payTo && offer.asset === destination.asset && offer.scheme === destination.scheme;
  }

  /**
   * 候補の検査（§4.2: 同期の形 → 静的の照合 → ATA の不等式。`checkExistence` なら動的は ATA の存在も）。通れば宛先 ATA。
   * `pay` の 1 は存在を見ない（存在は 3 で、送る直前にもう一度）。
   */
  async function candidateAtaOf(routeId: string, raw: unknown, operation: string, checkExistence: boolean): Promise<string | undefined> {
    if (checkSvmOffer(raw, scopeOf(routeId), operators) !== undefined) return undefined;
    const offer = raw as DestinationOffer;
    const isStatic = options.upstreams[routeId] !== undefined;
    if (isStatic) {
      if (!matchesStatic(routeId, offer)) return undefined;
      const ata = common.staticAtaOf(routeId);
      if (ata === undefined) return undefined;
      return checkSvmOfferAtas(offer, scopeOf(routeId), ata) === undefined ? ata : undefined;
    }
    let ata: string;
    try {
      ata = await ataOf(offer.payTo);
    } catch {
      return undefined;
    }
    if (checkSvmOfferAtas(offer, scopeOf(routeId), ata) !== undefined) return undefined;
    if (checkExistence && !(await ataExists(ata, offer.payTo, operation, routeId))) return undefined;
    return ata;
  }

  /** 静的の 402（共有の読取。本文も SDK に読ませる）。 */
  async function staticChallenge(routeId: string, ctx: { routeId: string; operation: string }): Promise<SvmChallenge> {
    const url = options.upstreams[routeId];
    if (url === undefined) throw new Error("no svm upstream for route");
    let challenge: X402Challenge;
    try {
      challenge = await readX402Challenge(options.transport, url, ctx, unpaidTimeoutMs);
    } catch {
      throw new SvmChallengeError("unreadable");
    }
    const resource = challenge.parsed.resource as { url: string; description?: string; mimeType?: string };
    return { accepts: challenge.rawAccepts, resource: { url: resource.url, ...(typeof resource.description === "string" ? { description: resource.description } : {}), ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}) } };
  }

  /** 動的の 402（ヘッダが権威。本文は読まない。動的 EVM と同じ検査）。 */
  async function dynamicChallenge(url: string, ctx: { routeId: string; operation: string }): Promise<SvmChallenge> {
    if (dynamic === undefined) throw new DynamicTargetUnsupportedError();
    if (!parseUpstreamUrl(url, { denyHosts: dynamic.denyHosts }).ok) throw new SvmChallengeError("url");
    const response = await dynamic.transport.fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(unpaidTimeoutMs) }, ctx);
    const header = response.headers.get("PAYMENT-REQUIRED");
    discardBody(response);
    if (response.status !== 402) throw new SvmChallengeError("status");
    if (header === null || header === "") throw new SvmChallengeError("no_header");
    let raw: unknown;
    try {
      raw = decodePaymentRequiredHeader(header);
    } catch {
      throw new SvmChallengeError("undecodable");
    }
    if (!isRecord(raw)) throw new SvmChallengeError("undecodable");
    if (raw["x402Version"] !== 2) throw new SvmChallengeError("version");
    const accepts = raw["accepts"];
    if (!Array.isArray(accepts) || accepts.length === 0) throw new SvmChallengeError("no_offers");
    if (accepts.length > DYNAMIC_RESPONSE_LIMITS.maxOffers) throw new SvmChallengeError("too_many_offers");
    const resource = raw["resource"];
    if (!isRecord(resource) || resource["url"] !== url) throw new SvmChallengeError("resource_mismatch");
    const description = resource["description"];
    const mimeType = resource["mimeType"];
    return { accepts, resource: { url, ...(typeof description === "string" ? { description } : {}), ...(typeof mimeType === "string" ? { mimeType } : {}) } };
  }

  async function challengeOf(routeId: string, target: UpstreamTarget | undefined, operation: string): Promise<SvmChallenge> {
    const ctx = { routeId, operation };
    if (target !== undefined) {
      if (!profiles.has(routeId)) throw new Error("no dynamic svm profile for route");
      if ((target.method ?? "GET") !== "GET") throw new UpstreamMethodUnsupportedError(); // POST は x402 EVM の動的経路だけ（FR-P3）
      return dynamicChallenge(target.url, ctx);
    }
    if (options.upstreams[routeId] === undefined) throw new Error("no svm upstream for route");
    return staticChallenge(routeId, ctx);
  }

  return {
    async startup(): Promise<void> {
      await common.startup();
    },

    async balanceOf(routeId: string, asset: string): Promise<bigint> {
      return common.balanceOf(routeId, asset);
    },

    async readChallenge(routeId: string, target?: UpstreamTarget): Promise<readonly DestinationOffer[]> {
      ready();
      const challenge = await challengeOf(routeId, target, "challenge");
      const offers: DestinationOffer[] = [];
      for (const entry of challenge.accepts) {
        if ((await candidateAtaOf(routeId, entry, "solana_rpc_ata", true)) !== undefined) offers.push(entry as DestinationOffer);
      }
      return offers;
    },

    async pay(request: PayRequest): Promise<PayResult> {
      const routerAtaNow = ready();
      const routeId = request.routeId;
      const approved = request.offer;
      const approvedJson = stableJson(approved);
      const notSent = (reason: string): PayResult => ({ outcome: "not_sent", reason });

      // 1. 能力の network、保存した offer の再検査、期限、予約の口。
      if (capability.network !== approved.network || approved.network !== options.network) return notSent("destination_signer_network_mismatch");
      const destinationAta = await candidateAtaOf(routeId, approved, "solana_rpc_ata", false).catch(() => undefined);
      if (destinationAta === undefined) return notSent("destination_offer_not_allowed");
      if (!(now() < request.deadlineMs)) return notSent("destination_deadline");
      if (request.reserveMessage === undefined) return notSent("destination_reservation_unsupported");

      // 2. 読み直して、保存した offer と完全一致する accepts があること。
      let challenge: SvmChallenge;
      const challengeStartedAt = diagStart(diagnostics);
      try {
        challenge = await challengeOf(routeId, request.target, "pay_challenge");
      } catch (error) {
        // 固定の分類だけ（`SvmChallengeError.reason` のうち動的の 9 つと同じ名前のもの、`TransportError.code`、ほかは `challenge_invalid`）。
        recordChallengeFailure(diagnostics, error, error instanceof SvmChallengeError && error.reason !== "unreadable" ? error.reason : undefined, challengeStartedAt);
        return notSent("destination_challenge_unreadable");
      }
      const current = challenge.accepts.find((entry) => stableJson(entry) === approvedJson);
      if (current === undefined) return notSent("destination_offer_changed");

      // 3. 宛先 ATA の再確認（送る直前にもう一度）。
      if (!(await ataExists(destinationAta, approved.payTo, "solana_rpc_ata", routeId))) return notSent("destination_ata_missing");

      // 4. blockhash。
      const lifetime = blockhashOf(await rpcResult("getLatestBlockhash", [{ commitment: "confirmed" }], "solana_rpc_blockhash", routeId));
      if (lifetime === undefined) return notSent("destination_blockhash_unavailable");
      const fetchedAt = now();

      // 5. 期待値（原始値だけ）。
      const expectedResult = expectedOf({ offer: approved, scope: scopeOf(routeId), destinationAta, paymentId: request.paymentId, blockhash: lifetime.blockhash, lastValidBlockHeight: lifetime.lastValidBlockHeight });
      if (!expectedResult.ok) return notSent(expectedResult.reason);
      const expected = expectedResult.expected;
      if (expected.source !== routerAtaNow || expected.authority !== capability.address) return notSent("destination_message_mismatch");

      // 6. 組み立て（snapshot）。7. 署名前の検査（builder と独立）。
      let snapshot: Uint8Array;
      try {
        snapshot = compileSvmMessage(expected);
      } catch {
        return notSent("destination_message_mismatch");
      }
      const check = checkSvmOutboundMessage(snapshot, expected);
      if (!check.ok) return notSent("destination_message_mismatch");

      // 8. hash の予約（署名の前。同じ message には二度と署名しない）。
      const reservation = await request.reserveMessage(messageHashOf(snapshot)).catch(() => "unavailable" as const);
      if (reservation === "collision") return notSent("destination_message_collision");
      if (reservation !== "reserved") return notSent("destination_message_record_unavailable");
      hooks.afterReserve?.();

      // 9. 期限と blockhash の鮮度（署名の直前）。
      if (!(now() < request.deadlineMs)) return notSent("destination_deadline");
      if (now() - fetchedAt > fetchToSignMs) return notSent("destination_blockhash_stale");

      // 10. 署名（写しを渡し、写しを保つ）と検証。
      let signature: Uint8Array;
      try {
        signature = Uint8Array.from(capability.sign(Uint8Array.from(snapshot)));
      } catch {
        recordSignNotSent(diagnostics, "destination_not_signed");
        return notSent("destination_not_signed");
      }
      if (!verifySvmSignature(signature, snapshot, capability.address)) {
        recordSignNotSent(diagnostics, "destination_not_signed");
        return notSent("destination_not_signed");
      }
      hooks.afterSign?.();

      // 11. wire の組み立てと再検査（snapshot との一致＋受信の検査）。
      let wire = assembleSvmWire(snapshot, expected, signature);
      if (hooks.wire !== undefined) wire = hooks.wire(wire);
      const recheck = recheckSvmWire(wire, snapshot, signature, expected, approved.payTo);
      if (!recheck.ok) {
        recordSignNotSent(diagnostics, "destination_payload_mismatch");
        return notSent("destination_payload_mismatch");
      }

      // 13 の封筒を先に組み（ヘッダの符号化）、12. **送出の委譲の直前**に承認の期限（FR-36）。署名だけでは資金は動かない。
      const accepted = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
      const payload = { x402Version: 2, resource: challenge.resource, accepted, payload: { transaction: Buffer.from(wire).toString("base64") } };
      const paymentHeaders = new x402HTTPClient(new x402Client()).encodePaymentSignatureHeader(payload as never);
      if (!(now() < request.deadlineMs)) {
        recordSignNotSent(diagnostics, "destination_deadline");
        return notSent("destination_deadline");
      }
      hooks.beforeSend?.();

      // 13. 送出（1 回だけ）。
      const payCtx = { routeId, operation: "pay" };
      const transport = request.target === undefined ? options.transport : dynamic!.transport;
      const url = request.target === undefined ? options.upstreams[routeId]! : request.target.url;
      const payDiagnostics: PayDiagnostics | undefined = outboundDiagnosticsEnabled(diagnostics) ? { sink: diagnostics, startedAt: diagStart(diagnostics) } : undefined;
      let response: Response;
      try {
        response = await transport.fetch(url, { method: "GET", headers: paymentHeaders, redirect: "error", signal: AbortSignal.timeout(paidTimeoutMs) }, payCtx);
      } catch (error) {
        // 結果は変えず、分類だけを積む（送出の後。§12.3）。
        recordPayTransportFailure(payDiagnostics, error, approved.network);
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }

      // 14. 領収（共有の表、SVM の form）。`dest_sign`・`dest_pay_request` は結果を決めた後で積む。
      return paidOutcomeOf(response, approved, receiptForm, { maxBodyBytes: DYNAMIC_RESPONSE_LIMITS.maxPaidBodyBytes, report: (error, ctx) => transport.report(error, ctx), ctx: payCtx, diagnostics: payDiagnostics });
    },
  };
}
