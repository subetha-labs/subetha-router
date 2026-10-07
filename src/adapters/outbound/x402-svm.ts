/**
 * SVM の送信（Solana の Provider に払う）の**純粋な部分**（送信の設計 §4.2・§4.5 の 5〜7・10〜11、FR-24・FR-34・FR-35・FR-37。タスク U6-a）。
 * ネットワークにも鍵にも触れない。adapter（U7）は、ここで組んだ期待値だけから message を組み、署名の前に `checkSvmOutboundMessage` で
 * **builder と独立に**検査し、署名の後に `recheckWire` で wire を snapshot と照合する。
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

import { buildSvmTransactionMessage, checkSvmTransaction, MEMO_PROGRAM_ADDRESS, SVM_DEFAULT_COMPUTE_UNITS, SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT, SVM_TRANSACTION_MAX_BYTES, type SvmInboundPolicy } from "../inbound/x402-svm.js";
import type { DestinationOffer } from "../../ports/outbound.js";

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
  readonly memo: string;
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
  const nonSignerReadonly = sortAddresses([expected.mint, expected.tokenProgram, String(COMPUTE_BUDGET_PROGRAM_ADDRESS), String(MEMO_PROGRAM_ADDRESS)]);
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
  if (header.numSignerAccounts !== 2 || header.numReadonlySignerAccounts !== 1 || header.numReadonlyNonSignerAccounts !== 4) return fail("header");
  const accounts = compiled.staticAccounts.map((value) => String(value));
  const expectedAccounts = expectedStaticAccountsOf(expected);
  if (accounts.length !== expectedAccounts.length || accounts.some((value, index) => value !== expectedAccounts[index])) return fail("accounts");
  if (String(compiled.lifetimeToken) !== expected.blockhash) return fail("blockhash");
  const instructions = compiled.instructions;
  if (instructions.length !== 4) return fail("instruction_count");
  const indexOf = (value: string): number => accounts.indexOf(value);
  const dataOf = (ix: { readonly data?: ArrayLike<number> }): Uint8Array => new Uint8Array(ix.data ?? []);
  const accountIndicesOf = (ix: { readonly accountIndices?: readonly number[] }): readonly number[] => ix.accountIndices ?? [];
  const [limitIx, priceIx, transferIx, memoIx] = instructions as [typeof instructions[number], typeof instructions[number], typeof instructions[number], typeof instructions[number]];
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
  // (iv) Memo: 口座 0、data が memo の UTF-8 と byte 一致。
  const memoData = dataOf(memoIx);
  const expectedMemo = new TextEncoder().encode(expected.memo);
  if (memoIx.programAddressIndex !== indexOf(String(MEMO_PROGRAM_ADDRESS)) || accountIndicesOf(memoIx).length !== 0) return fail("memo");
  if (memoData.length !== expectedMemo.length || Buffer.compare(Buffer.from(memoData), Buffer.from(expectedMemo)) !== 0) return fail("memo_value");
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
