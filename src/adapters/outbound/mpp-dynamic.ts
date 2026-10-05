/**
 * MPP 送信（Tempo charge）の**動的経路**（設計 `docs/dynamic-upstream-design.md` §3.2〜§3.4、タスク T9）。
 *
 * 静的経路（`mpp.ts` の `createMppOutbound`）との違い:
 *
 * - 接続先は呼び出しごとに渡された URL。上流は信頼しない第三者。
 * - challenge は**許可した欄だけ**を持つものに限り、上流の順で検査を通ったものだけを返す。scope は「あれば照合・無ければ不問」。
 * - **元の account は SDK に渡さない。** SDK に見せるのは `address`・`type`・`signTransaction` だけの facade で、
 *   `signTransaction` は渡された transaction を検査し、**確かめた欄だけで組み直したもの**に、Router が選んだ Tempo の
 *   serializer で署名する（渡された serializer は使わない）。
 * - 送信の境界（RPC）は、送金系のうち raw の送信 2 メソッドだけを 1 回通し、raw を復号して同じ欄をもう一度確かめる。
 * - mode は push に固定（こちらで送金して hash を渡す）。challenge の `feePayer` は読まない。
 */

import { Challenge, Constants, Credential, PaymentRequest, Receipt } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { TxEnvelopeTempo } from "ox/tempo";
import { createClient as createViemClient, custom, decodeFunctionData, encodeFunctionData, keccak256, maxUint256, type Account, type Client, type Hex } from "viem";
import { Abis, Transaction as TempoTransaction } from "viem/tempo";
import { tempo as tempoMainnet, tempoModerato } from "viem/tempo/chains";

import type { DynamicProfile } from "../../config.js";
import { stableJson } from "../../core/intent.js";
import { DYNAMIC_RESPONSE_LIMITS, readJsonObjectBody } from "../../net/bounded-body.js";
import { discardBody, type GuardedTransport } from "../../net/guarded-fetch.js";
import { guardedRpcTransport } from "../../net/guarded-rpc.js";
import { parseUpstreamUrl } from "../../net/upstream-url.js";
import type { DestinationOffer, MppTempoCapability, PayRequest, PayResult } from "../../ports/outbound.js";

export interface MppDynamicOptions {
  /** `profileId` → プロファイル。送信レールが mpp のものだけを使う。 */
  readonly profiles: Readonly<Record<string, DynamicProfile>>;
  /** 動的経路の transport（上流と RPC の両方）。**loopback を許すものは受け取らない**（設計 §3.1）。 */
  readonly transport: GuardedTransport;
  readonly denyHosts?: readonly string[];
  /** 未払いの読取の期限。既定 5 秒。 */
  readonly unpaidTimeoutMs?: number;
  /** credential を付けた要求の期限。既定 30 秒。 */
  readonly paidTimeoutMs?: number;
  /** RPC 1 回の期限の上限。既定 5 秒（能力の設定がこれより短ければそちら）。RPC は再試行しない。 */
  readonly rpcTimeoutMs?: number;
  /** 1 件の支払いで RPC に使える時間の合計。過ぎたら次の RPC を出さない。既定 20 秒。 */
  readonly rpcBudgetMs?: number;
  readonly now?: () => number;
}

const SCOPE_META_KEY = "_mppx_scope";
const DYNAMIC_SCHEME = "tempo/charge";
/** 署名してから `validBefore` までの長さの上限（秒）。SDK は 25 秒を使う。 */
const MAX_VALIDITY_SECONDS = 60;

const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,29})$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const CHALLENGE_KEYS: ReadonlySet<string> = new Set(["id", "realm", "method", "intent", "request", "expires", "opaque", "description", "digest"]);
const REQUEST_REQUIRED = ["amount", "currency", "recipient", "methodDetails"] as const;
const REQUEST_KEYS: ReadonlySet<string> = new Set([...REQUEST_REQUIRED, "description"]);
const METHOD_DETAILS_KEYS: ReadonlySet<string> = new Set(["chainId", "supportedModes", "feePayer"]);

/** adapter が待つのをやめる期限。相手（能力・RPC）が応答しなくても、ここから先へは進む。 */
class AdapterDeadlineError extends Error {
  constructor() {
    super("dynamic mpp adapter deadline exceeded");
    this.name = "AdapterDeadlineError";
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AdapterDeadlineError()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("rejected"));
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function chainIdOf(network: string): number {
  const match = /^eip155:([1-9][0-9]{0,15})$/.exec(network);
  if (match === null) {
    throw new Error("dynamic mpp profile network is not eip155:<chainId>");
  }
  return Number(match[1]);
}

/** challenge を候補にしない理由。運用者向けの分類で、上流の文字列は入らない。 */
export type ChallengeRejection =
  | "not_an_object"
  | "unknown_field"
  | "missing_field"
  | "method"
  | "currency"
  | "chain"
  | "amount"
  | "amount_over_limit"
  | "recipient"
  | "method_details"
  | "pull_only"
  | "expired"
  | "opaque_undecodable"
  | "scope";

export type ChallengeCheck =
  | { readonly ok: true; readonly offer: DestinationOffer; readonly expiresAt: number | undefined }
  | { readonly ok: false; readonly reason: ChallengeRejection };

/**
 * challenge の検査（設計 §3.3 (i)、キーは T0-c の 4）。入力は**実 SDK が解析した** challenge。
 * `operatorAddresses` は「運用者自身」（支払い元・受信の受取先）。そこへ払う challenge は候補にしない。
 */
export function checkDynamicMppChallenge(
  challenge: unknown,
  profile: DynamicProfile,
  operatorAddresses: readonly string[],
  url: string,
  nowMs: number,
): ChallengeCheck {
  const no = (reason: ChallengeRejection): ChallengeCheck => ({ ok: false, reason });
  if (!isRecord(challenge)) return no("not_an_object");
  for (const key of Object.keys(challenge)) {
    // `header` は credential の送り先のヘッダを変える欄。SDK が認識するが、ここでは許さない。
    if (!CHALLENGE_KEYS.has(key)) return no("unknown_field");
  }
  const { id, realm, method, intent, request, expires, opaque } = challenge;
  if (typeof id !== "string" || id === "" || typeof realm !== "string" || !isRecord(request)) return no("missing_field");
  const destination = profile.destination;
  if (method !== "tempo" || intent !== "charge" || destination.scheme !== DYNAMIC_SCHEME) return no("method");
  for (const key of Object.keys(request)) {
    // `externalId`・`expires`・`extra` など。
    if (!REQUEST_KEYS.has(key)) return no("unknown_field");
  }
  for (const key of REQUEST_REQUIRED) {
    if (!Object.hasOwn(request, key)) return no("missing_field");
  }
  if (Object.hasOwn(request, "description") && typeof request["description"] !== "string") return no("unknown_field");
  const details = request["methodDetails"];
  if (!isRecord(details)) return no("method_details");
  for (const key of Object.keys(details)) {
    // `splits`（受取先を増やす）・`machineTokenEnabled`（別経路の送金）・`memo` など。
    if (!METHOD_DETAILS_KEYS.has(key)) return no("method_details");
  }
  if (details["chainId"] !== chainIdOf(destination.network)) return no("chain");
  const modes = details["supportedModes"];
  if (modes !== undefined) {
    if (!Array.isArray(modes) || !modes.every((mode) => typeof mode === "string")) return no("method_details");
    if (!modes.includes("push")) return no("pull_only");
  }
  // 申し出としては許すが、Router は使わない（push で自分で手数料を払う）。
  if (Object.hasOwn(details, "feePayer") && typeof details["feePayer"] !== "boolean") return no("method_details");
  const currency = request["currency"];
  if (typeof currency !== "string" || !ADDRESS_PATTERN.test(currency) || !sameAddress(currency, destination.asset)) return no("currency");
  const amount = request["amount"];
  // 0 は送金ではなく proof の署名になる。
  if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount) || amount === "0") return no("amount");
  if (BigInt(amount) > BigInt(profile.maxUpstreamAmount)) return no("amount_over_limit");
  const recipient = request["recipient"];
  if (
    typeof recipient !== "string" ||
    !ADDRESS_PATTERN.test(recipient) ||
    sameAddress(recipient, ZERO_ADDRESS) ||
    sameAddress(recipient, destination.asset) ||
    operatorAddresses.some((own) => sameAddress(recipient, own))
  ) {
    return no("recipient");
  }
  let expiresAt: number | undefined;
  if (expires !== undefined) {
    expiresAt = typeof expires === "string" ? Date.parse(expires) : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return no("expired");
  }
  // scope: 「あれば照合・無ければ不問」。`opaque` は中身を変えずに保つ。
  let meta: Record<string, unknown> | null = null;
  if (opaque !== undefined) {
    if (typeof opaque !== "string" || opaque === "") return no("opaque_undecodable");
    try {
      const decoded: unknown = PaymentRequest.deserialize(opaque);
      if (!isRecord(decoded)) return no("opaque_undecodable");
      meta = decoded;
    } catch {
      // 中身を確かめられないものは送り返さない。
      return no("opaque_undecodable");
    }
    if (Object.hasOwn(meta, SCOPE_META_KEY) && meta[SCOPE_META_KEY] !== `GET ${url}`) return no("scope");
  }
  return {
    ok: true,
    expiresAt,
    offer: {
      scheme: DYNAMIC_SCHEME,
      network: destination.network,
      asset: currency,
      amount,
      payTo: recipient,
      // 条件の全文。`id`・`expires`・`digest` は発行ごとに変わるので入れない（設計 §3.2）。
      extra: { realm, terms: stableJson({ realm, method, intent, request, meta }) },
    },
  };
}

/** 署名・送信の境界で止めた。 */
export class TempoSigningRefusedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "TempoSigningRefusedError";
  }
}

/** 署名に使ってよい transaction の欄。**これ以外の欄に値があれば署名しない。** */
const TX_CARRIED_KEYS = ["calls", "chainId", "gas", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "nonceKey", "validBefore", "type", "feeToken", "from"] as const;
/** SDK・viem が付けるが、直列化に使われない欄。値は見ずに捨てる。 */
const TX_DROPPED_KEYS = ["account", "chain", "nonceManager"] as const;
const TX_KNOWN_KEYS: ReadonlySet<string> = new Set([...TX_CARRIED_KEYS, ...TX_DROPPED_KEYS]);

interface ApprovedTransfer {
  readonly chainId: number;
  readonly asset: string;
  readonly recipient: string;
  readonly amount: bigint;
  readonly feeAsset: string;
  readonly maxFee: bigint;
  readonly sender: string;
}

interface CheckedTransfer {
  readonly data: Hex;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly validBefore: number;
}

/** 手数料の上限（`feeAsset` の base units、6 桁）: ceil(gas × maxFeePerGas / 10^12)。設計 §3.3 の T0-b。 */
function feeBoundOf(gas: bigint, maxFeePerGas: bigint): bigint {
  return (gas * maxFeePerGas + 10n ** 12n - 1n) / 10n ** 12n;
}

/**
 * call の `data` が承認済みの送金そのものであること。復号した値から**組み直した data** を返す
 * （ABI の復号は末尾の余分なバイトを黙って読み飛ばすので、組み直したものと一致することまで見る）。
 */
function checkedTransferData(data: unknown, approved: ApprovedTransfer): Hex {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) {
    throw new TempoSigningRefusedError("destination_signing_args_mismatch");
  }
  let rebuilt: Hex;
  try {
    const decoded = decodeFunctionData({ abi: Abis.tip20, data: data as Hex });
    const args = decoded.args as readonly unknown[];
    if (decoded.functionName !== "transferWithMemo" && decoded.functionName !== "transfer") {
      throw new TempoSigningRefusedError("destination_signing_args_mismatch");
    }
    if (typeof args[0] !== "string" || !sameAddress(args[0], approved.recipient) || args[1] !== approved.amount) {
      throw new TempoSigningRefusedError("destination_signing_args_mismatch");
    }
    rebuilt =
      decoded.functionName === "transferWithMemo"
        ? encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [args[0] as Hex, approved.amount, args[2] as Hex] })
        : encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [args[0] as Hex, approved.amount] });
  } catch {
    throw new TempoSigningRefusedError("destination_signing_args_mismatch");
  }
  if (rebuilt.toLowerCase() !== data.toLowerCase()) {
    throw new TempoSigningRefusedError("destination_signing_args_mismatch");
  }
  return rebuilt;
}

/** gas・手数料・nonce・有効期限の範囲（署名の境界と送信の境界で同じものを使う）。 */
function checkFeeAndValidity(
  fields: { gas: unknown; maxFeePerGas: unknown; maxPriorityFeePerGas: unknown; nonce: unknown; nonceKey: unknown; validBefore: unknown },
  approved: ApprovedTransfer,
  nowMs: number,
): Omit<CheckedTransfer, "data"> {
  const { gas, maxFeePerGas, maxPriorityFeePerGas, nonce, nonceKey, validBefore } = fields;
  if (
    typeof gas !== "bigint" ||
    typeof maxFeePerGas !== "bigint" ||
    typeof maxPriorityFeePerGas !== "bigint" ||
    gas <= 0n ||
    maxFeePerGas <= 0n ||
    maxPriorityFeePerGas < 0n ||
    maxPriorityFeePerGas > maxFeePerGas
  ) {
    throw new TempoSigningRefusedError("destination_signing_fee_out_of_range");
  }
  if (feeBoundOf(gas, maxFeePerGas) > approved.maxFee) {
    throw new TempoSigningRefusedError("destination_signing_fee_over_limit");
  }
  // expiring nonce だけ。
  if (nonceKey !== maxUint256 || (nonce !== 0 && nonce !== 0n)) {
    throw new TempoSigningRefusedError("destination_signing_nonce_out_of_range");
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  if (typeof validBefore !== "number" || !Number.isInteger(validBefore) || validBefore <= nowSeconds || validBefore > nowSeconds + MAX_VALIDITY_SECONDS) {
    throw new TempoSigningRefusedError("destination_signing_validity_out_of_range");
  }
  return { gas, maxFeePerGas, maxPriorityFeePerGas, validBefore };
}

export interface GuardedTempoAccount {
  /** SDK に渡す account。自分のプロパティは `address`・`type`・`signTransaction` の 3 つだけ。 */
  readonly account: { readonly address: Hex; readonly type: "local"; signTransaction(transaction: unknown, options?: unknown): Promise<Hex> };
  /** 元の account を呼んだ回数。 */
  signatures(): number;
  /** 署名した raw（まだ無ければ `undefined`）。 */
  signedRaw(): Hex | undefined;
}

/**
 * 署名の境界（設計 §3.3 (ii)、AC-16）。1 支払いにつき署名は 1 回。生の署名口（`sign`・`signMessage`・`signTypedData`・
 * `signAuthorization`）は持たない。
 */
export function createGuardedTempoAccount(args: {
  readonly account: Account;
  readonly profile: DynamicProfile;
  readonly offer: DestinationOffer;
  readonly now: () => number;
}): GuardedTempoAccount {
  const inner = args.account as Account & { signTransaction?: (transaction: unknown, options?: unknown) => Promise<Hex> };
  if (inner.type !== "local" || typeof inner.signTransaction !== "function") {
    throw new Error("dynamic mpp capability must be a local account");
  }
  const approved = approvedTransferOf(args.profile, args.offer, inner.address);
  let used = false;
  let signatures = 0;
  let signedRaw: Hex | undefined;

  const account = {
    address: inner.address,
    type: "local" as const,
    /** 第 2 引数（SDK が渡す serializer）は**使わない**。 */
    async signTransaction(transaction: unknown): Promise<Hex> {
      if (used) {
        throw new TempoSigningRefusedError("destination_second_signature_refused");
      }
      used = true;
      if (!isRecord(transaction)) {
        throw new TempoSigningRefusedError("destination_signing_args_mismatch");
      }
      for (const [key, value] of Object.entries(transaction)) {
        // `feePayer`・`feePayerSignature`・`keyAuthorization`・`authorizationList`・`accessList`・`validAfter`・`to`・`data`・`value` など。
        // 値が `false` や空の配列でも「ある」とみなす。
        if (!TX_KNOWN_KEYS.has(key) && value !== undefined) {
          throw new TempoSigningRefusedError("destination_signing_unsupported_field");
        }
      }
      // 見積りに落ちた経路では SDK が "eip1559" と付けてくる（`calls` があれば Tempo として直列化される）。
      if (transaction["type"] !== "tempo" && transaction["type"] !== "eip1559") {
        throw new TempoSigningRefusedError("destination_signing_unsupported_field");
      }
      if (transaction["chainId"] !== approved.chainId) {
        throw new TempoSigningRefusedError("destination_signing_args_mismatch");
      }
      const from = transaction["from"];
      if (from !== undefined && (typeof from !== "string" || !sameAddress(from, approved.sender))) {
        throw new TempoSigningRefusedError("destination_signing_args_mismatch");
      }
      const calls = transaction["calls"];
      if (!Array.isArray(calls) || calls.length !== 1 || !isRecord(calls[0])) {
        throw new TempoSigningRefusedError("destination_signing_args_mismatch");
      }
      const call = calls[0];
      const to = call["to"];
      const value = call["value"];
      if (typeof to !== "string" || !sameAddress(to, approved.asset) || (value !== undefined && value !== 0n)) {
        throw new TempoSigningRefusedError("destination_signing_args_mismatch");
      }
      const data = checkedTransferData(call["data"], approved);
      const feeToken = transaction["feeToken"];
      // 未指定は拒否（チェーン側の既定に任せない）。
      if (typeof feeToken !== "string" || !sameAddress(feeToken, approved.feeAsset)) {
        throw new TempoSigningRefusedError("destination_signing_fee_token_mismatch");
      }
      const checked = checkFeeAndValidity(
        {
          gas: transaction["gas"],
          maxFeePerGas: transaction["maxFeePerGas"],
          maxPriorityFeePerGas: transaction["maxPriorityFeePerGas"],
          nonce: transaction["nonce"],
          nonceKey: transaction["nonceKey"],
          validBefore: transaction["validBefore"],
        },
        approved,
        args.now(),
      );
      signatures += 1;
      // 確かめた欄だけで組み直す。SDK が call に付ける `abi`・`functionName`・`args`・`address` は写さない。
      const raw = await inner.signTransaction!(
        {
          type: "tempo",
          chainId: approved.chainId,
          calls: [{ to: approved.asset as Hex, data, value: 0n }],
          gas: checked.gas,
          maxFeePerGas: checked.maxFeePerGas,
          maxPriorityFeePerGas: checked.maxPriorityFeePerGas,
          nonce: 0,
          nonceKey: maxUint256,
          validBefore: checked.validBefore,
          feeToken: approved.feeAsset as Hex,
        },
        { serializer: TempoTransaction.serialize },
      );
      signedRaw = raw;
      return raw;
    },
  };
  return { account, signatures: () => signatures, signedRaw: () => signedRaw };
}

function approvedTransferOf(profile: DynamicProfile, offer: DestinationOffer, sender: string): ApprovedTransfer {
  const { feeAsset, maxFee } = profile.destination;
  if (feeAsset === undefined || maxFee === undefined) {
    throw new Error("dynamic mpp profile has no feeAsset/maxFee");
  }
  return {
    chainId: chainIdOf(profile.destination.network),
    asset: profile.destination.asset,
    recipient: offer.payTo,
    amount: BigInt(offer.amount),
    feeAsset,
    maxFee: BigInt(maxFee),
    sender,
  };
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["chainId", "type", "gas", "nonce", "maxFeePerGas", "maxPriorityFeePerGas", "nonceKey", "validBefore", "feeToken", "calls", "signature", "from"]);

/**
 * 送信の境界（設計 §3.3 (iii)）。RPC に出ていく raw を復号し、署名の境界と同じ欄を**もう一度**確かめる。
 * 署名の境界を通らずに作られた raw や、署名後に差し替えられた raw を送らない。
 */
export function checkRawTempoTransfer(raw: unknown, profile: DynamicProfile, offer: DestinationOffer, sender: string, nowMs: number): void {
  const approved = approvedTransferOf(profile, offer, sender);
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new TempoSigningRefusedError("destination_send_not_a_transfer");
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = TxEnvelopeTempo.deserialize(raw as never) as unknown as Record<string, unknown>;
  } catch {
    throw new TempoSigningRefusedError("destination_send_not_a_transfer");
  }
  for (const [key, value] of Object.entries(envelope)) {
    // `feePayerSignature`・`keyAuthorization`・`authorizationList`・`accessList`・`validAfter` など。
    if (!ENVELOPE_KEYS.has(key) && value !== undefined) {
      throw new TempoSigningRefusedError("destination_send_unsupported_field");
    }
  }
  const signature = envelope["signature"];
  if (!isRecord(signature) || signature["type"] !== "secp256k1") {
    throw new TempoSigningRefusedError("destination_send_unsupported_field");
  }
  const from = envelope["from"];
  if (envelope["type"] !== "tempo" || envelope["chainId"] !== approved.chainId || typeof from !== "string" || !sameAddress(from, approved.sender)) {
    throw new TempoSigningRefusedError("destination_send_args_mismatch");
  }
  const calls = envelope["calls"];
  if (!Array.isArray(calls) || calls.length !== 1 || !isRecord(calls[0])) {
    throw new TempoSigningRefusedError("destination_send_args_mismatch");
  }
  const call = calls[0];
  const value = call["value"];
  if (typeof call["to"] !== "string" || !sameAddress(call["to"], approved.asset) || (value !== undefined && value !== 0n)) {
    throw new TempoSigningRefusedError("destination_send_args_mismatch");
  }
  checkedTransferData(call["data"], approved);
  const feeToken = envelope["feeToken"];
  if (typeof feeToken !== "string" || !sameAddress(feeToken, approved.feeAsset)) {
    throw new TempoSigningRefusedError("destination_signing_fee_token_mismatch");
  }
  checkFeeAndValidity(
    {
      gas: envelope["gas"],
      maxFeePerGas: envelope["maxFeePerGas"],
      maxPriorityFeePerGas: envelope["maxPriorityFeePerGas"],
      nonce: envelope["nonce"],
      nonceKey: envelope["nonceKey"],
      validBefore: envelope["validBefore"],
    },
    approved,
    nowMs,
  );
}

/** raw の送信に使ってよい RPC メソッド（1 支払い 1 回）。 */
const RAW_SEND_METHODS: ReadonlySet<string> = new Set(["eth_sendRawTransactionSync", "eth_sendRawTransaction"]);

/**
 * 送金・署名にあたる RPC メソッドか。raw の送信 2 つ以外は通さない（`eth_sendTransaction`・`wallet_sendCalls`・
 * `eth_signTransaction`・`eth_sign`・`personal_sign` など）。読取はそのまま通す。
 */
function isSendOrSignMethod(method: string): boolean {
  return method.startsWith("eth_send") || method.startsWith("eth_sign") || method.startsWith("wallet_") || method.startsWith("personal_");
}

type RpcRequest = (args: { method: string; params?: unknown }, options?: Record<string, unknown>) => Promise<unknown>;

/** 能力の client が、SSRF 防御 A に乗せ直せる viem の素の `http` transport か。 */
function plainHttpTransportOf(client: Client): { url: string; fetchOptions?: RequestInit; retryCount?: number; retryDelay?: number; timeout?: number } | undefined {
  const t = client.transport as { type?: unknown; key?: unknown; url?: unknown; fetchOptions?: RequestInit; retryCount?: number; retryDelay?: number; timeout?: number };
  if (t.type !== "http" || t.key !== "http" || typeof t.url !== "string") return undefined;
  return {
    url: t.url,
    ...(t.fetchOptions === undefined ? {} : { fetchOptions: t.fetchOptions }),
    ...(t.retryCount === undefined ? {} : { retryCount: t.retryCount }),
    ...(t.retryDelay === undefined ? {} : { retryDelay: t.retryDelay }),
    ...(t.timeout === undefined ? {} : { timeout: t.timeout }),
  };
}

/**
 * SDK に渡す client の chain。能力の client が chain を持てばそれ（ID が一致すること）、無ければ viem の既知の Tempo chain
 * （serializer・formatter が要る。受信 adapter と同じ選び方）。どちらも無ければ `undefined`（動的経路は使えない）。
 */
function chainFor(client: Client, chainId: number): Client["chain"] | undefined {
  if (client.chain !== undefined) {
    return client.chain.id === chainId ? client.chain : undefined;
  }
  return [tempoMainnet, tempoModerato].find((candidate) => candidate.id === chainId) as Client["chain"] | undefined;
}

/**
 * 起動時の確認（設計 §3.3 の「能力」）。動的プロファイルの MPP 能力は、push を明示し、local account で、
 * 各プロファイルの chain について viem の素の `http` transport の client を返すこと。違えば例外。
 */
export async function assertDynamicMppCapability(capability: MppTempoCapability, profiles: Readonly<Record<string, DynamicProfile>>): Promise<void> {
  assertCapabilityShape(capability);
  for (const profile of Object.values(profiles)) {
    if (profile.rail !== "mpp") continue;
    const chainId = chainIdOf(profile.destination.network);
    if (capability.chainId !== chainId) {
      throw new Error(`dynamic profile ${profile.profileId}: the MPP capability is for another chain`);
    }
    const client = await capability.getClient({ chainId });
    if (plainHttpTransportOf(client) === undefined || chainFor(client, chainId) === undefined) {
      throw new Error(`dynamic profile ${profile.profileId}: the MPP capability client must use viem's plain http transport on the profile's chain`);
    }
  }
}

function assertCapabilityShape(capability: MppTempoCapability): void {
  if (capability.mode !== "push") {
    throw new Error("the dynamic mpp path requires a capability with mode \"push\"");
  }
  if (capability.account.type !== "local") {
    throw new Error("the dynamic mpp path requires a local account (the signing boundary cannot be held for a JSON-RPC account)");
  }
  if (capability.kind !== "real-key") {
    throw new Error("the dynamic mpp path does not accept a non-signing fixture capability (its transport bypasses the guarded transport)");
  }
}

export interface MppDynamicPath {
  readChallenge(profileId: string, url: string): Promise<readonly DestinationOffer[]>;
  pay(request: PayRequest & { readonly target: { readonly url: string } }): Promise<PayResult>;
}

/** receipt が payer を名乗る場合の厳密照合（静的経路と同じ形）。 */
function payerMatches(payer: unknown, chainId: number, address: string): boolean {
  if (payer === undefined) return true;
  if (typeof payer !== "string") return false;
  const claimed = payer.trim().toLowerCase();
  const account = address.toLowerCase();
  return claimed === account || claimed === `eip155:${chainId}:${account}` || claimed === `did:pkh:eip155:${chainId}:${account}`;
}

export function createMppDynamicPath(capability: MppTempoCapability, options: MppDynamicOptions): MppDynamicPath {
  const transport = options.transport;
  if (transport.allowLoopback) {
    throw new Error("the dynamic mpp path must not use a transport that allows loopback");
  }
  if (!transport.boundsDns) {
    // 名前解決に期限が無いと、上流と RPC の期限が効かない（止まった解決を待ち続ける）。
    throw new Error("the dynamic mpp path requires a transport with a DNS deadline");
  }
  assertCapabilityShape(capability);
  const unpaidTimeoutMs = options.unpaidTimeoutMs ?? 5_000;
  const paidTimeoutMs = options.paidTimeoutMs ?? 30_000;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? 5_000;
  const rpcBudgetMs = options.rpcBudgetMs ?? 20_000;
  const now = options.now ?? Date.now;
  const denyHosts = options.denyHosts ?? [];

  const profiles = new Map<string, DynamicProfile>();
  for (const [profileId, profile] of Object.entries(options.profiles)) {
    if (profile.rail !== "mpp") continue;
    const { feeAsset, maxFee } = profile.destination;
    if (profile.destination.scheme !== DYNAMIC_SCHEME || feeAsset === undefined || maxFee === undefined) {
      throw new Error(`dynamic profile ${profileId} is not a tempo/charge profile with feeAsset and maxFee`);
    }
    if (capability.chainId !== chainIdOf(profile.destination.network)) {
      throw new Error(`dynamic profile ${profileId}: the MPP capability is for another chain`);
    }
    profiles.set(profileId, profile);
  }

  function profileFor(profileId: string): DynamicProfile {
    const profile = profiles.get(profileId);
    if (profile === undefined) {
      throw new Error("no dynamic mpp profile for route");
    }
    return profile;
  }

  function operatorAddressesOf(profile: DynamicProfile): string[] {
    return [capability.account.address, profile.source.payTo];
  }

  interface Candidate {
    readonly challenge: Challenge.Challenge;
    readonly offer: DestinationOffer;
  }

  /** 未払いの GET。本文は読まずに捨てる（challenge は `WWW-Authenticate` ヘッダにある）。 */
  async function readCandidates(profile: DynamicProfile, url: string, ctx: { routeId: string; operation: string }): Promise<Candidate[]> {
    const parsed = parseUpstreamUrl(url, { denyHosts });
    if (!parsed.ok) {
      throw new Error("dynamic mpp challenge rejected: url");
    }
    const response = await transport.fetch(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(unpaidTimeoutMs) }, ctx);
    const header = response.headers.get(Constants.Headers.wwwAuthenticate);
    discardBody(response);
    if (response.status !== 402) {
      throw new Error("dynamic mpp challenge rejected: status");
    }
    if (header === null || header === "") {
      throw new Error("dynamic mpp challenge rejected: no_header");
    }
    let challenges: readonly Challenge.Challenge[];
    try {
      // 実 SDK に解析させる（自前の解釈で置き換えない）。1 つでも形が壊れていれば全体を使わない。
      challenges = Challenge.deserializeList(header);
    } catch {
      throw new Error("dynamic mpp challenge rejected: undecodable");
    }
    if (challenges.length > DYNAMIC_RESPONSE_LIMITS.maxOffers) {
      throw new Error("dynamic mpp challenge rejected: too_many_offers");
    }
    const operatorAddresses = operatorAddressesOf(profile);
    const candidates: Candidate[] = [];
    for (const challenge of challenges) {
      const check = checkDynamicMppChallenge(challenge, profile, operatorAddresses, url, now());
      if (check.ok) {
        candidates.push({ challenge, offer: check.offer });
      }
    }
    return candidates;
  }

  return {
    /** 検査を通った challenge だけを、**上流の順のまま** offer にして返す。credential は作らない。 */
    async readChallenge(profileId: string, url: string): Promise<readonly DestinationOffer[]> {
      const profile = profileFor(profileId);
      return (await readCandidates(profile, url, { routeId: profileId, operation: "challenge" })).map((candidate) => candidate.offer);
    },

    async pay(request): Promise<PayResult> {
      const profile = profileFor(request.routeId);
      const url = request.target.url;
      const approved = request.offer;
      const approvedJson = stableJson(approved);
      const chainId = chainIdOf(profile.destination.network);
      const ctx = { routeId: request.routeId, operation: "pay_challenge" };

      // 送金直前に読み直す。一致の定義（設計 §3.2）: 保存した offer の全体が、検査を通った今の challenge のどれかと一致すること。
      let selected: Candidate | undefined;
      try {
        selected = (await readCandidates(profile, url, ctx)).find((candidate) => stableJson(candidate.offer) === approvedJson);
      } catch {
        return { outcome: "not_sent", reason: "destination_challenge_unreadable" };
      }
      if (selected === undefined) {
        return { outcome: "not_sent", reason: "destination_offer_changed" };
      }

      // 能力の client。素の http transport でなければ、どこへ出るか保証できないので使わない。
      let rpcRequest: RpcRequest;
      let chain: Client["chain"];
      try {
        // 能力が client を返すのを待つのにも期限を付ける（まだ何も署名していない）。
        const client = await withDeadline(Promise.resolve(capability.getClient({ chainId })), rpcTimeoutMs);
        const plain = plainHttpTransportOf(client);
        const resolved = chainFor(client, chainId);
        if (plain === undefined || resolved === undefined) {
          return { outcome: "not_sent", reason: "destination_capability_unsupported" };
        }
        chain = resolved;
        // 能力側の account は載せない。RPC は動的経路の transport（loopback を許さない）に乗せ直す。
        const guarded = createViemClient({
          chain: resolved,
          transport: guardedRpcTransport(transport, plain.url, () => ({ routeId: request.routeId, operation: "rpc" }), {
            fetchOptions: plain.fetchOptions,
            // 能力側の再試行は引き継がない（読取も含めて 1 回ずつ。所要時間を数えられる形にする）。
            retryCount: 0,
            timeout: Math.min(plain.timeout ?? rpcTimeoutMs, rpcTimeoutMs),
          }),
        });
        const guardedSend = guarded.request.bind(guarded) as RpcRequest;
        // transport の期限（abort）に加えて、adapter 自身も 1 回ごとに待つのをやめる（少しの余裕つき）。
        rpcRequest = (args, requestOptions) => withDeadline(guardedSend(args, requestOptions), rpcTimeoutMs + 1_000);
      } catch {
        return { outcome: "not_sent", reason: "destination_capability_unsupported" };
      }

      const guard = createGuardedTempoAccount({ account: capability.account, profile, offer: approved, now });
      let sends = 0;
      const rpcDeadline = Date.now() + rpcBudgetMs;
      /**
       * SDK・viem からの RPC。**検査した値と、実際に送る値を同じものにする**: `method` は文字列の原始値として 1 度だけ読み、
       * `params` は JSON の写し（getter・`toJSON`・Proxy を持たない素の値）にしてから分類・検査し、その写しだけを送る。
       */
      const guardedRequest = async (args: unknown): Promise<unknown> => {
        const method: unknown = isRecord(args) ? args["method"] : undefined;
        if (typeof method !== "string") {
          throw new TempoSigningRefusedError("destination_rpc_request_refused");
        }
        if (Date.now() >= rpcDeadline) {
          throw new TempoSigningRefusedError("destination_rpc_budget_exhausted");
        }
        if (!isSendOrSignMethod(method)) {
          let params: unknown;
          try {
            const raw: unknown = (args as Record<string, unknown>)["params"];
            params = raw === undefined ? undefined : (JSON.parse(JSON.stringify(raw)) as unknown);
          } catch {
            throw new TempoSigningRefusedError("destination_rpc_request_refused");
          }
          return rpcRequest(params === undefined ? { method } : { method, params }, { retryCount: 0 });
        }
        if (!RAW_SEND_METHODS.has(method)) {
          throw new TempoSigningRefusedError("destination_send_method_refused");
        }
        if (sends >= 1) {
          // 1 度目の成否が不明でも、2 度目は出さない。
          throw new TempoSigningRefusedError("destination_duplicate_send_refused");
        }
        const params: unknown = (args as Record<string, unknown>)["params"];
        const raw: unknown = Array.isArray(params) ? params[0] : undefined;
        /**
         * **この支払いで署名の境界が返した raw そのもの**であること（文字列の原始値どうしの比較）。送り主の照合だけでは足りない:
         * 以前の支払いで署名された、まだ有効な raw も送り主は同じである。そのうえで中身をもう一度確かめる。
         */
        const signed = guard.signedRaw();
        if (typeof raw !== "string" || signed === undefined || raw !== signed) {
          throw new TempoSigningRefusedError("destination_send_not_the_signed_transaction");
        }
        checkRawTempoTransfer(signed, profile, approved, capability.account.address, now());
        sends += 1;
        // 送るのは、検査した raw だけを持つ新しい要求。
        return rpcRequest({ method, params: [signed] }, { retryCount: 0 });
      };
      const sdkClient = createViemClient({
        // fee token を固定する（viem は未指定のとき chain の値を入れる）。入らなければ署名の境界が拒否する。
        chain: { ...chain!, feeToken: profile.destination.feeAsset as Hex } as never,
        account: guard.account as never,
        transport: custom({ request: guardedRequest as never }, { retryCount: 0 }),
      });
      const mppx = Mppx.create({
        methods: [
          tempo.charge({
            account: guard.account as never,
            getClient: () => sdkClient as never,
            mode: "push",
            autoSwap: false,
            expectedChainId: chainId,
            allowedChainIds: [chainId],
            expectedRecipients: [approved.payTo as Hex],
          }),
        ],
        // SDK には HTTP をさせない（上流への要求は adapter が自分で 1 回ずつ出す）。
        fetch: (async () => {
          throw new TempoSigningRefusedError("destination_sdk_fetch_refused");
        }) as unknown as typeof globalThis.fetch,
        polyfill: false,
        maxPaymentRetries: 0,
      });

      let credential: string;
      try {
        // 選んだ challenge 1 件だけを SDK に見せる。
        credential = await mppx.createCredential(
          new Response(null, { status: 402, headers: { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(selected.challenge) } }),
        );
      } catch {
        if (guard.signatures() === 0) {
          return { outcome: "not_sent", reason: "destination_not_signed" };
        }
        // 署名した後の失敗。送金が届いたかどうかは分からない。再作成・再送はしない。
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }
      const raw = guard.signedRaw();
      if (guard.signatures() !== 1 || sends !== 1 || raw === undefined) {
        // 送金していないのに credential ができた（proof など、送金でない経路）。上流には送らない。
        return guard.signatures() === 0 ? { outcome: "not_sent", reason: "destination_not_signed" } : { outcome: "unknown", reason: "destination_pay_unknown" };
      }
      // receipt を束縛する材料は、**自分が署名して送った raw** から取る（SDK の申告ではなく）。
      const txHash = keccak256(raw);
      let payload: unknown;
      try {
        payload = (Credential.deserialize(credential) as { payload?: unknown }).payload;
      } catch {
        payload = undefined;
      }
      if (!isRecord(payload) || payload["type"] !== "hash" || typeof payload["hash"] !== "string" || payload["hash"].toLowerCase() !== txHash.toLowerCase()) {
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }

      const payCtx = { routeId: request.routeId, operation: "pay" };
      let response: Response;
      try {
        // 1 要求 1 回だけ。402 を受けても再作成・再送信をしない。
        response = await transport.fetch(url, {
          method: "GET",
          headers: { [Constants.Headers.authorization]: credential },
          redirect: "error",
          signal: AbortSignal.timeout(paidTimeoutMs),
        }, payCtx);
      } catch {
        return { outcome: "unknown", reason: "destination_pay_unknown" };
      }

      // receipt を本文より先に判定する。
      const receiptHeader = response.headers.get(Constants.Headers.paymentReceipt);
      let receipt: Receipt.Receipt | undefined;
      if (receiptHeader !== null && receiptHeader !== "") {
        try {
          receipt = Receipt.deserialize(receiptHeader);
        } catch {
          receipt = undefined;
        }
      }
      const receiptOk =
        receipt !== undefined &&
        receiptHeader !== null &&
        receipt.status === "success" &&
        receipt.method === "tempo" &&
        typeof receipt.reference === "string" &&
        BYTES32_PATTERN.test(receipt.reference) &&
        // 今回の送金への束縛。別の取引の receipt を自分の支払いの証拠にしない。
        receipt.reference.toLowerCase() === txHash.toLowerCase() &&
        payerMatches((receipt as unknown as Record<string, unknown>)["payer"], chainId, capability.account.address);
      if (!receiptOk) {
        // 送金は既に出している。上流が何を返しても、課金の有無は断定しない。本文は読まない。
        discardBody(response);
        return { outcome: "unknown", reason: response.status === 200 ? "destination_receipt_unverified" : "destination_pay_unknown" };
      }
      const noData = (reason: string): PayResult => ({ outcome: "paid_no_data", reason, receiptRef: receiptHeader! });
      if (response.status !== 200) {
        discardBody(response);
        return noData("paid_data_unavailable");
      }
      let delivered;
      try {
        delivered = await readJsonObjectBody(response, DYNAMIC_RESPONSE_LIMITS.maxPaidBodyBytes);
      } catch (error) {
        transport.report(error, payCtx);
        return noData("paid_data_unavailable");
      }
      if (delivered.kind === "too_large") return noData("response_too_large");
      if (delivered.kind === "unsupported") return noData("unsupported_response");
      return { outcome: "paid", body: delivered.body, contentType: "application/json", txRef: txHash, receiptRef: receiptHeader! };
    },
  };
}
