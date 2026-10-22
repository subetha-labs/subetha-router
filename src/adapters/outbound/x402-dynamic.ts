/**
 * x402 送信の**動的経路**（設計 `docs/dynamic-upstream-design.md` §3.2〜§3.4、タスク T8）。
 *
 * 静的経路（`x402.ts` の `createX402Outbound`）との違い:
 *
 * - 接続先は起動時の設定ではなく、呼び出しごとに渡された URL（`parseUpstreamUrl` を通ったもの）。
 * - 上流は信頼しない第三者。offer は**許可した欄だけ**を持つものに限り、上流の順で検査を通ったものだけを返す。
 * - **署名器に渡す typed data は Router が組み直す。** SDK が渡したものから引き継ぐのは `validAfter`・`validBefore`・
 *   `nonce` の 3 つだけで、それも範囲を確かめる。domain はプロファイルの `tokenDomain`、型定義は固定。
 * - 402 の本文は**読まない**（`PAYMENT-REQUIRED` ヘッダが権威）。有料応答は receipt を先に判定し、本文は上限つきで読む。
 */

import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme, type ClientEvmSigner } from "@x402/evm";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import type { Network, PaymentRequired } from "@x402/fetch";
import { getAddress } from "viem";

import type { DynamicProfile } from "../../config.js";
import { stableJson } from "../../core/intent.js";
import { DYNAMIC_RESPONSE_LIMITS, readJsonObjectBody } from "../../net/bounded-body.js";
import { discardBody, type GuardedTransport } from "../../net/guarded-fetch.js";
import { parseUpstreamUrl } from "../../net/upstream-url.js";
import { base58ByteLength, EVM_RECEIPT_FORM, receiptClassOfHeader, type ReceiptClassResult, type ReceiptForm } from "../../shared/x402-receipt.js";
import type { DestinationOffer, EvmSigningCapability, PayRequest, PayResult, UpstreamTarget } from "../../ports/outbound.js";
import type { DiagnosticsSink } from "../../shared/diagnostics.js";
import { diagStart, evmCidInputOf, outboundDiagnosticsEnabled, recordChallengeFailure, recordPaid, recordPayTransportFailure, recordSignNotSent, type PayDiagnostics } from "./outbound-diagnostics.js";

// 領収の形は診断の後回しの処理と共有する（`src/shared/x402-receipt.ts`。値は従来と同じ）。
export type { ReceiptForm } from "../../shared/x402-receipt.js";
export { EVM_RECEIPT_FORM, SVM_RECEIPT_FORM } from "../../shared/x402-receipt.js";

export type Receipt =
  | { readonly kind: "none" }
  | { readonly kind: "payer_mismatch" }
  | { readonly kind: "settled"; readonly header: string; readonly transaction: string };

/**
 * receipt ヘッダを本文より先に判定する（SDK の `processResponse` は本文を先に読むので使わない）。送信の設計 §5 の 1 枚の表の入口。
 * 動的 EVM・静的 Arc・SVM が共有する（Base の静的は従来の処理のまま）。
 */
export function receiptOf(response: Response, approved: DestinationOffer, form: ReceiptForm): Receipt {
  const header = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  if (header === null || header === "") return { kind: "none" };
  let decoded: unknown;
  try {
    decoded = decodePaymentResponseHeader(header);
  } catch {
    return { kind: "none" };
  }
  if (!isRecord(decoded) || decoded["success"] !== true || decoded["network"] !== approved.network) {
    return { kind: "none" };
  }
  const transaction = decoded["transaction"];
  // 取引の参照は form の形に限る（上流の任意の文字列を記録に入れない）。SVM は復号したバイト数まで見る（文字数では 64 バイトを保証しない）。
  if (typeof transaction !== "string" || !form.transactionPattern.test(transaction)) {
    return { kind: "none" };
  }
  if (form.transactionBytes !== undefined && base58ByteLength(transaction) !== form.transactionBytes) {
    return { kind: "none" };
  }
  // receipt が購入者を名乗るなら、それはこの Router の署名者でなければならない（形ごとの比較。SVM は 32 バイトに復号できる base58）。
  const payer = decoded["payer"];
  if (payer !== undefined) {
    const matches =
      typeof payer === "string" &&
      (form.payerForm === "evm"
        ? ADDRESS_PATTERN.test(payer) && sameAddress(payer, form.signerAddress)
        : SVM_ADDRESS_PATTERN.test(payer) && base58ByteLength(payer) === 32 && payer === form.signerAddress);
    if (!matches) return { kind: "payer_mismatch" };
  }
  return { kind: "settled", header, transaction };
}

/**
 * 領収の 7 分類（診断。設計 `docs/rejection-reasons-design.md` §4.3）。`receiptOf` と同じヘッダを同じ順に読み、同じ decoder で分ける（純粋）。
 * 不変条件（試験で固定）: `ok` ⇔ `receiptOf` が `settled`、`payer_mismatch` ⇔ `payer_mismatch`、それ以外 ⇔ `none`。
 * **判断の経路では呼ばない**（hook はヘッダの文字列を写すだけで、分類は後回しの処理が同じ `receiptClassOfHeader` でする）。
 */
export function receiptClassOf(response: Response, approved: DestinationOffer, form: ReceiptForm): ReceiptClassResult {
  return receiptClassOfHeader(response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE"), approved.network, form);
}

/** 送出の後の判断に渡す依存。`diagnostics` があれば結果を決めた後で `dest_sign`・`dest_pay_request` を積む（タスク R-4）。 */
export interface PaidOutcomeDeps {
  readonly maxBodyBytes: number;
  readonly report: (error: unknown, ctx: { routeId: string; operation: string }) => void;
  readonly ctx: { routeId: string; operation: string };
  readonly diagnostics?: PayDiagnostics | undefined;
}

/** receipt が整合した 200 の本文。対応するのは `application/json` の JSON object だけ（設計 §3.4）。 */
export async function deliveredBodyOf(
  response: Response,
  receipt: { readonly header: string; readonly transaction: string },
  deps: {
    readonly maxBodyBytes: number;
    readonly report: (error: unknown, ctx: { routeId: string; operation: string }) => void;
    readonly ctx: { routeId: string; operation: string };
    /** 本文の読み取りの失敗を診断に渡す（`report` の後。結果は変えない）。 */
    readonly onReadError?: (error: unknown) => void;
  },
): Promise<PayResult> {
  const noData = (reason: string): PayResult => ({ outcome: "paid_no_data", reason, receiptRef: receipt.header });
  let delivered;
  try {
    delivered = await readJsonObjectBody(response, deps.maxBodyBytes);
  } catch (error) {
    // 支払いは receipt で確かめてある。取れなかったのはデータだけ。
    deps.report(error, deps.ctx);
    deps.onReadError?.(error);
    return noData("paid_data_unavailable");
  }
  if (delivered.kind === "too_large") {
    return noData("response_too_large");
  }
  if (delivered.kind === "unsupported") {
    return noData("unsupported_response");
  }
  return { outcome: "paid", body: delivered.body, contentType: "application/json", txRef: receipt.transaction, receiptRef: receipt.header };
}

/**
 * 送出した後の応答から結果を決める（送信の設計 §5 の 1 枚の表。動的 EVM・静的 Arc・SVM が共有する）。
 * 整合した領収 ∧ 200 → 本文（`deliveredBodyOf`）、整合 ∧ 200 以外 → `paid_no_data`、`payer` だけ違う → `unknown`、
 * 領収なし: 2xx → `unknown`、≥ 500 → `unknown`、それ以外 → `rejected`。本文は整合した 200 のときだけ読む。
 */
export async function paidOutcomeOf(response: Response, approved: DestinationOffer, form: ReceiptForm, deps: PaidOutcomeDeps): Promise<PayResult> {
  const receipt = receiptOf(response, approved, form);
  const diagnostics = deps.diagnostics;
  if (diagnostics === undefined || !outboundDiagnosticsEnabled(diagnostics.sink)) {
    return paidOutcomeDecisionOf(response, receipt, deps, undefined);
  }
  let bodyReadError: { error: unknown; code: string } | undefined;
  const result = await paidOutcomeDecisionOf(response, receipt, deps, (error) => {
    bodyReadError = { error, code: "paid_data_unavailable" };
  });
  // 結果を決めた後（本文の読み取り・discardBody の後）に積む。ヘッダの文字列を写すだけで、分類は後回しの処理（§13.1）。
  recordPaid(diagnostics, { response, approved, form, receiptNotOk: receipt.kind !== "settled", ...(bodyReadError === undefined ? {} : { bodyReadError }) });
  return result;
}

/** `paidOutcomeOf` の判断（sink の有無で同じ道）。 */
async function paidOutcomeDecisionOf(response: Response, receipt: Receipt, deps: PaidOutcomeDeps, onReadError: ((error: unknown) => void) | undefined): Promise<PayResult> {
  if (receipt.kind === "settled") {
    if (response.status === 200) {
      return deliveredBodyOf(response, receipt, { maxBodyBytes: deps.maxBodyBytes, report: deps.report, ctx: deps.ctx, ...(onReadError === undefined ? {} : { onReadError }) });
    }
    // 整合した receipt があるのに 200 でない。支払いは成立していて、データは無い。
    discardBody(response);
    return { outcome: "paid_no_data", reason: "paid_data_unavailable", receiptRef: receipt.header };
  }
  // receipt が無い・不整合。本文は読まない。
  discardBody(response);
  if (receipt.kind === "payer_mismatch") {
    return { outcome: "unknown", reason: "destination_receipt_payer_mismatch" };
  }
  if (response.status >= 200 && response.status < 300) {
    return { outcome: "unknown", reason: "destination_receipt_unverified" };
  }
  if (response.status >= 500) {
    return { outcome: "unknown", reason: "destination_pay_unknown" };
  }
  // 402 を含む 4xx: 上流は「受け付けなかった」と答えた。再署名はしない。
  // **未決済の証明ではない**（署名済みの authorization は `validBefore` まで有効で、上流は後から決済できる）。
  return { outcome: "rejected", reason: "destination_rejected" };
}


export interface X402DynamicOptions {
  /**
   * 運用者の集合（送信の設計 §2.3、FR-38）: 受信の受取先・送信の署名者・それらの ATA。ここへ払う offer は候補にしない。
   * EVM は小文字化して比較する。無ければ「この能力の署名者と、プロファイルの受信の受取先」だけ（従来）。
   */
  readonly operatorAddresses?: readonly string[];
  /** `profileId` → プロファイル。送信レールが x402 のものだけを使う。 */
  readonly profiles: Readonly<Record<string, DynamicProfile>>;
  /** 動的経路の transport。**loopback を許すものは受け取らない**（設計 §3.1）。 */
  readonly transport: GuardedTransport;
  /** 動的 URL の宛先にできないホスト名（core と同じ検査をここでもう一度掛ける）。 */
  readonly denyHosts?: readonly string[];
  /** 未払いの読取の期限。既定 5 秒。 */
  readonly unpaidTimeoutMs?: number;
  /** 支払いヘッダを付けた要求の期限。既定 30 秒（暫定の方針。設計 §3.3）。 */
  readonly paidTimeoutMs?: number;
  readonly now?: () => number;
  /** 診断の記録（設計 `docs/rejection-reasons-design.md` §4.3、タスク R-4）。無ければ何も記録しない（結果・要求は同じ）。 */
  readonly diagnostics?: DiagnosticsSink;
}

/** 署名してから `validBefore` までの長さの上限（秒）。`maxTimeoutSeconds` の上限 600 ＋余裕。 */
const MAX_VALIDITY_SECONDS = 660;
const MAX_TIMEOUT_SECONDS = 600;

const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,29})$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SVM_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** offer のトップレベルに必ず要る欄。 */
const REQUIRED_KEYS = ["scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds", "extra"] as const;
/** 説明だけの欄（署名の内容に影響しない。文字列に限る）。 */
const DESCRIPTIVE_KEYS = ["description", "mimeType", "resource"] as const;
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([...REQUIRED_KEYS, ...DESCRIPTIVE_KEYS, "maxAmountRequired"]);
// `breakdown`・`totalUsd`・`acceptId` は説明だけの欄（Exa などが付ける。値は読まない。`docs/dynamic-upstream-post-design.md` FR-P4）。
const EXTRA_KEYS: ReadonlySet<string> = new Set(["name", "version", "bazaar", "decimals", "breakdown", "totalUsd", "acceptId"]);

/** EIP-3009 の型定義。**上流と SDK のどちらが何を渡しても、署名に使うのはこれ。** */
const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;
const EIP712_DOMAIN = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;
const SDK_TYPES_JSON = stableJson({ TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION });
const DOMAIN_KEYS = ["chainId", "name", "verifyingContract", "version"] as const;
const MESSAGE_KEYS = ["from", "nonce", "to", "validAfter", "validBefore", "value"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys[index]);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function evmChainIdOf(network: string): number {
  const match = /^eip155:([1-9][0-9]{0,15})$/.exec(network);
  if (match === null) {
    throw new Error("dynamic x402 profile network is not eip155:<chainId>");
  }
  return Number(match[1]);
}

/** offer を候補にしない理由。運用者向けの分類で、上流の文字列は入らない。 */
export type OfferRejection =
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
  | "token_domain"
  | "decimals"
  | "max_amount_required"
  | "descriptive_field";

/**
 * offer の検査（設計 §3.3 (i)、キーは T0-c の 3）。**純粋関数**。通れば `undefined`。
 * `operatorAddresses` は「運用者自身」（署名者・受信の受取先）。そこへ払う offer は候補にしない。
 */
export function checkDynamicX402Offer(
  raw: unknown,
  profile: DynamicProfile,
  operatorAddresses: readonly string[],
): OfferRejection | undefined {
  if (!isRecord(raw)) return "not_an_object";
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) return "unknown_field";
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.hasOwn(raw, key)) return "missing_field";
  }
  const destination = profile.destination;
  if (raw["scheme"] !== "exact" || destination.scheme !== "exact") return "scheme";
  if (raw["network"] !== destination.network) return "network";
  const asset = raw["asset"];
  // アドレスは大文字小文字を区別しない同一性で比べる（保存した offer との一致は別で、そちらは綴りまで見る）。
  if (typeof asset !== "string" || !ADDRESS_PATTERN.test(asset) || !sameAddress(asset, destination.asset)) return "asset";
  const amount = raw["amount"];
  if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount) || amount === "0") return "amount";
  if (BigInt(amount) > BigInt(profile.maxUpstreamAmount)) return "amount_over_limit";
  const payTo = raw["payTo"];
  if (
    typeof payTo !== "string" ||
    !ADDRESS_PATTERN.test(payTo) ||
    sameAddress(payTo, ZERO_ADDRESS) ||
    sameAddress(payTo, destination.asset) ||
    operatorAddresses.some((own) => sameAddress(payTo, own))
  ) {
    return "pay_to";
  }
  const maxTimeoutSeconds = raw["maxTimeoutSeconds"];
  if (
    typeof maxTimeoutSeconds !== "number" ||
    !Number.isInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds < 1 ||
    maxTimeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    return "max_timeout";
  }
  const extra = raw["extra"];
  if (!isRecord(extra)) return "extra";
  for (const key of Object.keys(extra)) {
    // `assetTransferMethod` は SDK が支払いの仕方そのものを変える欄。許すのは **`"eip3009"` だけ**（Circle の facilitator が Arc の
    // 受取側に要求する値で、SDK の client の既定の経路。組み直しの署名器は domain・宛先・額・型を自分で固定するので署名の内容は変わらない。
    // `docs/provider-x402-workers.md` §3.5、V-6）。`permit2` など他の値、`paymentFlow`・`feePayer` などの他の鍵は候補外。
    if (key === "assetTransferMethod") {
      if (extra[key] !== "eip3009") return "extra";
      continue;
    }
    if (!EXTRA_KEYS.has(key)) return "extra";
  }
  const tokenDomain = destination.tokenDomain;
  if (tokenDomain === undefined || extra["name"] !== tokenDomain.name || extra["version"] !== tokenDomain.version) {
    return "token_domain";
  }
  if (Object.hasOwn(extra, "decimals") && extra["decimals"] !== destination.decimals) return "decimals";
  // v1 の欄。v2 では意味を持たないので、`amount` と同じ値のときだけ許す。
  if (Object.hasOwn(raw, "maxAmountRequired") && raw["maxAmountRequired"] !== amount) return "max_amount_required";
  for (const key of DESCRIPTIVE_KEYS) {
    if (Object.hasOwn(raw, key) && typeof raw[key] !== "string") return "descriptive_field";
  }
  return undefined;
}

/** 署名の境界で止めた（元の署名器は呼んでいない）。 */
/** `cause` を辿って、指定の理由の `SigningRefusedError` かを見る（SDK は元の例外を包むことがある）。 */
export function isSigningRefusal(error: unknown, reason: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof SigningRefusedError && current.reason === reason) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export class SigningRefusedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SigningRefusedError";
  }
}

export interface RebuildingSigner {
  /** SDK に渡す署名者。持つのは `address` と `signTypedData` だけ。 */
  readonly signer: ClientEvmSigner;
  /** 次の 1 回だけ署名を許す。 */
  arm(): void;
  /** 元の署名器を呼んだ回数。 */
  signatures(): number;
}

/**
 * 署名の境界（設計 §3.3 (ii)、AC-16）。SDK が渡した typed data が**承認済みの値とプロファイルから組んだものと
 * 1 欄ずつ一致する**ことを確かめ、そのうえで**Router が組み直したもの**を元の署名器に渡す。
 * SDK が渡した `domain`・`types`・`primaryType` のオブジェクトは署名器に届かない。
 */
export function createRebuildingSigner(args: {
  readonly signer: ClientEvmSigner;
  /** 宛先の権威（プロファイルの `destination`、または静的 route の `destination`＋表の domain。送信の設計 §3.2）。 */
  readonly destination: { readonly network: string; readonly asset: string; readonly tokenDomain?: { readonly name: string; readonly version: string } };
  readonly offer: DestinationOffer;
  readonly now: () => number;
  /** 承認の絶対期限（FR-36）。**実際の署名の委譲の直前**に見る。無ければ期限なし（試験用）。 */
  readonly deadlineMs?: number;
}): RebuildingSigner {
  const { destination, offer } = args;
  const tokenDomain = destination.tokenDomain;
  if (tokenDomain === undefined) {
    throw new Error("x402 destination has no tokenDomain");
  }
  const chainId = evmChainIdOf(destination.network);
  const verifyingContract = getAddress(destination.asset);
  const from = getAddress(args.signer.address);
  const to = getAddress(offer.payTo);
  const value = BigInt(offer.amount);
  let armed = false;
  let signatures = 0;

  const signer = {
    address: args.signer.address,
    async signTypedData(message: {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    }): Promise<`0x${string}`> {
      if (!armed) {
        throw new SigningRefusedError("destination_signer_not_armed");
      }
      armed = false;
      // 承認の期限は署名口の入口（実際の署名の委譲の前。arm の後に SDK が待っても期限後には署名しない。送信の設計 §2.4）。
      if (args.deadlineMs !== undefined && !(args.now() < args.deadlineMs)) {
        throw new SigningRefusedError("destination_deadline");
      }
      if (!isRecord(message) || message.primaryType !== "TransferWithAuthorization") {
        throw new SigningRefusedError("destination_unsupported_asset_transfer_method");
      }
      // 型定義: SDK の定義と同じであること。`EIP712Domain` を足されたら、それだけで拒否する。
      if (!isRecord(message.types) || stableJson(message.types) !== SDK_TYPES_JSON) {
        throw new SigningRefusedError("destination_signing_args_mismatch");
      }
      const domain = message.domain;
      if (
        !isRecord(domain) ||
        !hasExactlyKeys(domain, DOMAIN_KEYS) ||
        domain["name"] !== tokenDomain.name ||
        domain["version"] !== tokenDomain.version ||
        domain["chainId"] !== chainId ||
        domain["verifyingContract"] !== verifyingContract
      ) {
        throw new SigningRefusedError("destination_signing_args_mismatch");
      }
      const inner = message.message;
      if (
        !isRecord(inner) ||
        !hasExactlyKeys(inner, MESSAGE_KEYS) ||
        inner["from"] !== from ||
        inner["to"] !== to ||
        inner["value"] !== value
      ) {
        throw new SigningRefusedError("destination_signing_args_mismatch");
      }
      // 引き継ぐのはこの 3 つだけ。範囲を確かめる。
      const validAfter = inner["validAfter"];
      const validBefore = inner["validBefore"];
      const nonce = inner["nonce"];
      const nowSeconds = BigInt(Math.floor(args.now() / 1000));
      if (
        typeof validAfter !== "bigint" ||
        typeof validBefore !== "bigint" ||
        validAfter < 0n ||
        validAfter > nowSeconds ||
        validBefore <= nowSeconds ||
        validBefore > nowSeconds + BigInt(MAX_VALIDITY_SECONDS) ||
        typeof nonce !== "string" ||
        !BYTES32_PATTERN.test(nonce)
      ) {
        throw new SigningRefusedError("destination_signing_validity_out_of_range");
      }
      // 検査の間に期限を越えたかもしれない。**実際の委譲の直前**にもう一度（送信の設計 §2.4）。
      if (args.deadlineMs !== undefined && !(args.now() < args.deadlineMs)) {
        throw new SigningRefusedError("destination_deadline");
      }
      signatures += 1;
      return args.signer.signTypedData({
        domain: { name: tokenDomain.name, version: tokenDomain.version, chainId, verifyingContract },
        types: {
          EIP712Domain: EIP712_DOMAIN.map((field) => ({ ...field })),
          TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION.map((field) => ({ ...field })),
        },
        primaryType: "TransferWithAuthorization",
        message: { from, to, value, validAfter, validBefore, nonce: nonce as `0x${string}` },
      });
    },
  };
  return {
    signer,
    arm: () => {
      armed = true;
    },
    signatures: () => signatures,
  };
}

/** 未払いの読取が成立しなかった理由（上流の文字列は入らない）。 */
export class DynamicChallengeError extends Error {
  constructor(
    readonly reason:
      | "url"
      | "status"
      | "no_header"
      | "undecodable"
      | "version"
      | "no_offers"
      | "too_many_offers"
      | "resource_mismatch"
      | "method",
  ) {
    super(`dynamic x402 challenge rejected: ${reason}`);
    this.name = "DynamicChallengeError";
  }
}

export interface DynamicChallenge {
  readonly accepts: readonly unknown[];
  /** SDK に渡す `resource`（`url` と、文字列の説明だけ）。 */
  readonly resource: { url: string; description?: string; mimeType?: string };
}

/**
 * 未払いの 402 の読取（`getChallenge`）と要求の init（`requestInitOf`）。動的 `pay`/`readChallenge` と、秘匿購入の探り（`docs/zktls-router-design.md` §6.1）が
 * **同じ関数**を使う（切り出しだけで挙動は不変）。
 */
export function createX402ChallengeReader(deps: { readonly transport: GuardedTransport; readonly denyHosts: readonly string[]; readonly unpaidTimeoutMs: number }): {
  requestInitOf(target: UpstreamTarget, headers: Record<string, string>, timeoutMs: number): RequestInit;
  getChallenge(target: UpstreamTarget, ctx: { routeId: string; operation: string }): Promise<DynamicChallenge>;
} {
  const { transport, denyHosts, unpaidTimeoutMs } = deps;
  /** 上流への要求の init（方法・本文・content-type）。POST の本文は target の文字列そのもの（記録が権威。FR-P2）。 */
  function requestInitOf(target: UpstreamTarget, headers: Record<string, string>, timeoutMs: number): RequestInit {
    if (target.method === "POST") {
      if (typeof target.body !== "string") throw new DynamicChallengeError("method");
      return { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: target.body, redirect: "error", signal: AbortSignal.timeout(timeoutMs) };
    }
    // `method` が無い target は GET（従来の呼び出し）。POST は明示したときだけ。GET に本文は付けない。
    if ((target.method ?? "GET") !== "GET" || target.body !== undefined) throw new DynamicChallengeError("method");
    return { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(timeoutMs) };
  }

  /** 未払いの要求（支払いヘッダを付けない。GET、または記録どおりの本文の POST）。本文は読まずに捨てる。 */
  async function getChallenge(target: UpstreamTarget, ctx: { routeId: string; operation: string }): Promise<DynamicChallenge> {
    const url = target.url;
    const parsed = parseUpstreamUrl(url, { denyHosts });
    if (!parsed.ok) {
      throw new DynamicChallengeError("url");
    }
    const response = await transport.fetch(url, requestInitOf(target, {}, unpaidTimeoutMs), ctx);
    const header = response.headers.get("PAYMENT-REQUIRED");
    // ヘッダが権威。本文の `accepts` は見ないので、本文は 1 バイトも読まない。
    discardBody(response);
    if (response.status !== 402) {
      throw new DynamicChallengeError("status");
    }
    if (header === null || header === "") {
      throw new DynamicChallengeError("no_header");
    }
    let raw: unknown;
    try {
      raw = decodePaymentRequiredHeader(header);
    } catch {
      throw new DynamicChallengeError("undecodable");
    }
    if (!isRecord(raw)) {
      throw new DynamicChallengeError("undecodable");
    }
    if (raw["x402Version"] !== 2) {
      throw new DynamicChallengeError("version");
    }
    const accepts = raw["accepts"];
    if (!Array.isArray(accepts) || accepts.length === 0) {
      throw new DynamicChallengeError("no_offers");
    }
    if (accepts.length > DYNAMIC_RESPONSE_LIMITS.maxOffers) {
      throw new DynamicChallengeError("too_many_offers");
    }
    const resource = raw["resource"];
    // 上流が「この URL の支払い条件だ」と言っていること。別の資源の条件を払わない。
    if (!isRecord(resource) || resource["url"] !== url) {
      throw new DynamicChallengeError("resource_mismatch");
    }
    const description = resource["description"];
    const mimeType = resource["mimeType"];
    return {
      accepts,
      resource: {
        url,
        ...(typeof description === "string" ? { description } : {}),
        ...(typeof mimeType === "string" ? { mimeType } : {}),
      },
    };
  }
  return { requestInitOf, getChallenge };
}

export type X402SignOnlyResult =
  | { readonly ok: true; readonly payload: PaymentPayloadLike; readonly headers: Record<string, string>; readonly validBefore: bigint }
  | { readonly ok: false; readonly reason: "destination_deadline" | "destination_not_signed" | "destination_offer_changed" | "destination_payload_mismatch"; readonly payload?: PaymentPayloadLike };

export interface PaymentPayloadLike {
  readonly x402Version: number;
  readonly accepted?: unknown;
  readonly payload: { readonly authorization: { readonly validBefore: string | bigint | number } } & Record<string, unknown>;
}

/**
 * 署名だけ（送らない）。`pay` の署名部分の切り出しで、動的 `pay` と秘匿購入の `issueCredential`（`docs/zktls-router-design.md` §6.1）が**同じ関数**を使う:
 * 組み直しの署名器、SDK の client（選ばれた offer の完全一致・支出制御・`onBeforePaymentCreation` の arm）、`createPaymentPayload`、署名 1 回・`accepted` 一致・v2 の確認、
 * `encodePaymentSignatureHeader`。transport には触れない（`fetch` 0 回）。
 */
export async function signX402PaymentOnly(args: {
  readonly capability: EvmSigningCapability;
  readonly profile: DynamicProfile;
  readonly approved: DestinationOffer;
  readonly challenge: DynamicChallenge;
  readonly now: () => number;
  readonly deadlineMs: number;
}): Promise<X402SignOnlyResult> {
  const { capability, profile, approved, challenge, now } = args;
  const approvedJson = stableJson(approved);
  // 一致の定義（設計 §3.2）: 保存した offer の全体が、今の accepts のどれかと一致すること。
  const current = challenge.accepts.find((entry) => stableJson(entry) === approvedJson);
  if (current === undefined) {
    return { ok: false, reason: "destination_offer_changed" };
  }
  // SDK には写しを渡す（SDK が書き換えても、照合に使う値は変わらない）。
  const selected = JSON.parse(JSON.stringify(current)) as PaymentRequired["accepts"][number];

  const guard = createRebuildingSigner({ signer: capability.signer, destination: profile.destination, offer: approved, now, deadlineMs: args.deadlineMs });
  const client = new x402Client((_version, requirements) => {
    if (requirements.length !== 1 || stableJson(requirements[0]) !== approvedJson) {
      throw new SigningRefusedError("destination_selected_offer_mismatch");
    }
    return requirements[0]!;
  });
  client.setSpendControls({
    maxAmountPerPayment: false,
    allowedAssets: [{ network: approved.network as Network, asset: approved.asset, maxAmountPerPayment: approved.amount }],
  });
  client.register(capability.network as Network, new ExactEvmScheme(guard.signer));
  client.onBeforePaymentCreation(async (context) => {
    if (stableJson(context.selectedRequirements) !== approvedJson || context.paymentRequired.x402Version !== 2) {
      return { abort: true, reason: "destination_selected_offer_mismatch" };
    }
    guard.arm();
    return undefined;
  });
  const httpClient = new x402HTTPClient(client);

  let payload;
  try {
    // 上流のトップレベルの欄（`extensions`・`error` など）は SDK に渡さない。渡すのは確かめた 3 つだけ。
    payload = await httpClient.createPaymentPayload({ x402Version: 2, resource: challenge.resource, accepts: [selected] } as PaymentRequired);
  } catch (error) {
    // payload 生成の失敗は送信前。署名の境界で止めた場合もここに来る。期限の拒否は理由をそのまま出す。
    return { ok: false, reason: isSigningRefusal(error, "destination_deadline") ? "destination_deadline" : "destination_not_signed" };
  }
  const like = payload as unknown as PaymentPayloadLike;
  if (guard.signatures() !== 1 || stableJson((payload as { accepted?: unknown }).accepted) !== approvedJson || payload.x402Version !== 2) {
    return { ok: false, reason: "destination_payload_mismatch", payload: like };
  }
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(payload);
  const validBefore = like.payload.authorization.validBefore;
  return { ok: true, payload: like, headers: paymentHeaders, validBefore: BigInt(validBefore) };
}

export interface X402DynamicPath {
  readChallenge(profileId: string, target: UpstreamTarget): Promise<readonly DestinationOffer[]>;
  pay(request: PayRequest & { readonly target: UpstreamTarget }): Promise<PayResult>;
}

/** 未払いの読取・有料要求の期限の既定。drain の上限の試験（タスク R-0）が読む。 */
export const X402_DYNAMIC_UNPAID_TIMEOUT_MS = 5_000;
export const X402_DYNAMIC_PAID_TIMEOUT_MS = 30_000;

export function createX402DynamicPath(capability: EvmSigningCapability, options: X402DynamicOptions): X402DynamicPath {
  const transport = options.transport;
  if (transport.allowLoopback) {
    throw new Error("the dynamic x402 path must not use a transport that allows loopback");
  }
  if (!transport.boundsDns) {
    // 名前解決に期限が無いと、未払い 5 秒・有料 30 秒の期限が効かない（止まった解決を待ち続ける）。
    throw new Error("the dynamic x402 path requires a transport with a DNS deadline");
  }
  const unpaidTimeoutMs = options.unpaidTimeoutMs ?? X402_DYNAMIC_UNPAID_TIMEOUT_MS;
  const paidTimeoutMs = options.paidTimeoutMs ?? X402_DYNAMIC_PAID_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const denyHosts = options.denyHosts ?? [];
  const diagnostics = options.diagnostics;

  const profiles = new Map<string, DynamicProfile>();
  for (const [profileId, profile] of Object.entries(options.profiles)) {
    if (profile.rail !== "x402") continue;
    if (profile.destination.scheme !== "exact" || profile.destination.tokenDomain === undefined) {
      throw new Error(`dynamic profile ${profileId} is not an x402 exact profile with a tokenDomain`);
    }
    evmChainIdOf(profile.destination.network);
    profiles.set(profileId, profile);
  }

  function profileFor(profileId: string): DynamicProfile {
    const profile = profiles.get(profileId);
    if (profile === undefined) {
      throw new Error("no dynamic x402 profile for route");
    }
    return profile;
  }

  /** 運用者自身のアドレス（署名者と、受信の受取先、注入された運用者の集合。送信の設計 §2.3）。 */
  function operatorAddressesOf(profile: DynamicProfile): string[] {
    return [capability.signer.address, profile.source.payTo, ...(options.operatorAddresses ?? [])];
  }
  const receiptForm = EVM_RECEIPT_FORM(capability.signer.address);

  // 未払いの読取と要求の init は秘匿購入の探りと共有（切り出しだけで挙動は不変）。
  const { requestInitOf, getChallenge } = createX402ChallengeReader({ transport, denyHosts, unpaidTimeoutMs });

  return {
    /** 検査を通った offer だけを、**上流の順のまま**返す（先頭が §2.3 の「最初の 1 件」）。 */
    async readChallenge(profileId: string, target: UpstreamTarget): Promise<readonly DestinationOffer[]> {
      const profile = profileFor(profileId);
      const challenge = await getChallenge(target, { routeId: profileId, operation: "challenge" });
      const operatorAddresses = operatorAddressesOf(profile);
      const offers: DestinationOffer[] = [];
      for (const entry of challenge.accepts) {
        if (checkDynamicX402Offer(entry, profile, operatorAddresses) === undefined) {
          offers.push(entry as DestinationOffer);
        }
      }
      return offers;
    },

    async pay(request): Promise<PayResult> {
      const profile = profileFor(request.routeId);
      const url = request.target.url;
      const approved = request.offer;
      const approvedJson = stableJson(approved);

      if (capability.network !== profile.destination.network) {
        return { outcome: "not_sent", reason: "destination_signer_network_mismatch" };
      }
      // 保存してあった offer も、今のプロファイルの検査をもう一度通す。
      if (checkDynamicX402Offer(approved, profile, operatorAddressesOf(profile)) !== undefined) {
        return { outcome: "not_sent", reason: "destination_offer_not_allowed" };
      }

      let challenge: DynamicChallenge;
      const challengeStartedAt = diagStart(diagnostics);
      try {
        // 送金直前に読み直す。
        challenge = await getChallenge(request.target, { routeId: request.routeId, operation: "pay_challenge" });
      } catch (error) {
        // 分類は固定の値だけ（`DynamicChallengeError.reason`・`TransportError.code`。message は読まない）。
        recordChallengeFailure(diagnostics, error, error instanceof DynamicChallengeError ? error.reason : undefined, challengeStartedAt);
        return { outcome: "not_sent", reason: "destination_challenge_unreadable" };
      }
      // 署名だけ（送らない）。秘匿購入の `issueCredential` と同じ関数（切り出しだけで挙動は不変）。
      const signed = await signX402PaymentOnly({ capability, profile, approved, challenge, now, deadlineMs: request.deadlineMs });
      if (!signed.ok) {
        if (signed.reason === "destination_offer_changed") {
          return { outcome: "not_sent", reason: "destination_offer_changed" };
        }
        if (signed.reason === "destination_payload_mismatch") {
          // `cid` の入力は署名した authorization の値の参照だけ（hash は後回しの処理で。記録は送出の後、§12.3）。
          recordSignNotSent(diagnostics, "destination_payload_mismatch", outboundDiagnosticsEnabled(diagnostics) && signed.payload !== undefined ? evmCidInputOf(signed.payload as never, approved) : undefined);
          return { outcome: "not_sent", reason: "destination_payload_mismatch" };
        }
        recordSignNotSent(diagnostics, signed.reason);
        return { outcome: "not_sent", reason: signed.reason };
      }
      const payload = signed.payload;
      const cid = outboundDiagnosticsEnabled(diagnostics) ? evmCidInputOf(payload as never, approved) : undefined;

      const payCtx = { routeId: request.routeId, operation: "pay" };
      // 要求を先に組み（ヘッダの符号化）、**送出の委譲の直前**に承認の期限（FR-36）。署名だけでは資金は動かない。
      const paymentHeaders = signed.headers;
      if (!(now() < request.deadlineMs)) {
        recordSignNotSent(diagnostics, "destination_deadline", cid);
        return { outcome: "not_sent", reason: "destination_deadline" };
      }
      const payDiagnostics: PayDiagnostics | undefined = outboundDiagnosticsEnabled(diagnostics) ? { sink: diagnostics, startedAt: diagStart(diagnostics), cid } : undefined;
      let response: Response;
      try {
        // 1 要求 1 回だけ。402 を受けても再署名・再送信をしない。
        // 有料要求も記録の方法・本文そのもので（同じバイト列。FR-P2）。
        response = await transport.fetch(url, requestInitOf(request.target, paymentHeaders, paidTimeoutMs), payCtx);
      } catch (error) {
        // 送ったかどうか分からない（期限・ヘッダの上限超過・リダイレクトを含む）。自動再送しない。結果は変えず、分類だけを積む。
        recordPayTransportFailure(payDiagnostics, error, approved.network);
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }

      return paidOutcomeOf(response, approved, receiptForm, { maxBodyBytes: DYNAMIC_RESPONSE_LIMITS.maxPaidBodyBytes, report: (error, ctx) => transport.report(error, ctx), ctx: payCtx, diagnostics: payDiagnostics });
    },
  };
}
