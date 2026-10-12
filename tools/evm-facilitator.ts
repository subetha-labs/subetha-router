/**
 * 自前の x402 v2 facilitator（EVM testnet 4 つ。設計 `docs/evm-testnets-x402-design.md` §3.3）。**製品コードではない**（運用者の道具）。
 *
 * - `GET /<token>/supported`・`POST /<token>/verify`・`POST /<token>/settle`。bind は 127.0.0.1 だけ。`Origin` つき・`Host` 違いは拒む。
 * - verify は SDK（`@x402/evm/exact/facilitator` の `ExactEvmScheme`）の **verify だけ** を使う。settle は SDK に任せない
 *   （固定版 2.28.0 の settle は receipt の失敗を `success: false` で返し、Router が `rejected` に写す。設計 §1.2）。
 * - 原則: settle の 400（= Router の `rejected`）は「その authorization が chain で未使用で、この facilitator が一度も送出していない」と
 *   確かめたときだけ。それ以外の失敗は 5xx（Router の `unknown`）。
 * - 送出の意図は永続の journal（ndjson、追記と fsync）に書いてから送出する。未解決の送出がある network は保留（再起動後も）。
 *
 * 核（`createEvmFacilitator`）は chain の I/O・journal・時計を注入で受け、網なしで試験できる（`tests/unit/evm-facilitator.test.ts`）。
 * CLI（`main`）だけが viem と SDK の verify を配線する。
 *
 * 鍵・署名・token は log・応答・例外の文言に出さない。
 *
 * usage: EVM_FACILITATOR_KEY=0x... EVM_FACILITATOR_TOKEN=<32 文字以上> EVM_FACILITATOR_NETWORKS=eip155:46630,eip155:998 \
 *        EVM_FACILITATOR_PAYTO_ALLOWLIST=0x... EVM_FACILITATOR_GAS_CAP_46630=<wei> EVM_FACILITATOR_GAS_CAP_998=<wei> \
 *        EVM_FACILITATOR_JOURNAL=.claude_workflow/local/evm-testnets/run-<UTC>/facilitator-journal.ndjson tsx tools/evm-facilitator.ts
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { stableJson } from "../src/core/intent.js";
import { assetKeyOf, EVM_TESTNET_NETWORKS, evmChainIdOf, KNOWN_NETWORKS, knownAssetOf, knownNetworkOf, type KnownNetwork } from "../src/shared/networks.js";

/* ──────────────────────────────────────────────────────────────────────────────
 * 定数（設計 §3.3・§3.6・§3.8）
 * ────────────────────────────────────────────────────────────────────────────── */

export const DEFAULT_PORT = 8611;
/** 要求の本文の上限（バイト）。 */
export const MAX_BODY_BYTES = 64 * 1024;
/** 1 回の settle の gas 上限（設計 §3.8）。 */
export const SETTLE_GAS_LIMIT = 200_000n;
/** 金額の上限（最小単位。設計 §3.3 の前段の検査）。 */
export const MAX_AMOUNT = 20_000n;
/** network ごとの待ち行列（処理中の 1 件の外に待てる数。満杯は 503）。 */
export const MAX_WAITING_PER_NETWORK = 2;
/**
 * 使用済みの authorization の照合で `AuthorizationUsed` を探す時間の幅の上限（秒）。範囲は `validAfter`〜`validBefore` だが、
 * `validAfter` が 0 の authorization（Router の payer）で genesis から引かないよう、`validBefore` から遡る幅をこれで抑える。
 * この幅の外で使われた authorization は見つからず 5xx（安全側。未払いとは読まない）。
 */
export const RECONCILE_LOOKBACK_SECONDS = 3_600;
/** 照合の block の探索の反復の上限（時刻 → block の推定）。 */
const BLOCK_SEARCH_MAX_STEPS = 12;

/** 既定の公開 RPC（設計 §1.1）。`EVM_FACILITATOR_RPC_<chainId>` で上書き。 */
export const DEFAULT_RPC_URLS: Readonly<Record<string, string>> = Object.freeze({
  "eip155:46630": "https://rpc.testnet.chain.robinhood.com",
  "eip155:421614": "https://sepolia-rollup.arbitrum.io/rpc",
  "eip155:998": "https://rpc.hyperliquid-testnet.xyz/evm",
  "eip155:11155111": "https://ethereum-sepolia-rpc.publicnode.com",
});

/**
 * `eth_getLogs` 1 回の block の幅の既定（`EVM_FACILITATOR_LOG_RANGE_<chainId>` で上書き）。小さく保つ。
 * HyperEVM の公開 RPC は幅に応じて `rate limited`（-32005）を返す（E-2 の実測。報告に記録）。
 */
export const DEFAULT_LOG_RANGES: Readonly<Record<string, bigint>> = Object.freeze({
  "eip155:46630": 5_000n,
  "eip155:421614": 5_000n,
  "eip155:998": 500n,
  "eip155:11155111": 1_000n,
});

/** `maxFeePerGas` の network ごとの上限（wei。`EVM_FACILITATOR_MAX_FEE_PER_GAS_<chainId>` で上書き）。見積りがこれを超えれば送出しない。 */
export const DEFAULT_MAX_FEE_PER_GAS: Readonly<Record<string, bigint>> = Object.freeze({
  "eip155:46630": 1_000_000_000n,
  "eip155:421614": 1_000_000_000n,
  "eip155:998": 10_000_000_000n,
  "eip155:11155111": 20_000_000_000n,
});

/** 期限（ms。設計 §3.6）。 */
export interface NetworkDeadlines {
  /** facilitator の締め切り（要求の受付から。待ち行列を含む）。 */
  readonly facilitatorMs: number;
  /** 送出の直前に要る残り（手順 9・10）。 */
  readonly preBroadcastMs: number;
  /** `validBefore` が今からこれ以上先であること（確定の見込み。前段の検査と手順 9）。 */
  readonly validBeforeMarginMs: number;
}

export function defaultDeadlinesOf(network: string): NetworkDeadlines {
  return network === "eip155:11155111"
    ? { facilitatorMs: 40_000, preBroadcastMs: 28_000, validBeforeMarginMs: 28_000 }
    : { facilitatorMs: 10_000, preBroadcastMs: 6_000, validBeforeMarginMs: 6_000 };
}

/** topic0。`keccak256("AuthorizationUsed(address,bytes32)")`・`keccak256("Transfer(address,address,uint256)")`（試験で viem の値と照合）。 */
export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** `Router`・`Provider` が出す `extra` の鍵（設計 §3.3）。 */
const ALLOWED_EXTRA_KEYS: ReadonlySet<string> = new Set(["name", "version", "challengeNonce", "expiresAt", "routeBinding", "fundsMoveOnCredential", "assetTransferMethod"]);
/**
 * `paymentPayload.payload` の鍵。設計は `{ authorization, signature }` だけだが、Router の受信の封筒（`tools/x402-payer.ts`・`npm run sign`）は
 * `challengeNonce` を同じ所に入れる（Router の preflight が読む）。これは `requirements.extra.challengeNonce` と一致するときだけ許す（報告に記録）。
 */
const ALLOWED_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["authorization", "signature", "challengeNonce"]);
/** `paymentPayload` のトップレベル（Router は `scheme`・`network` を補い、SDK の client は `resource` を付ける）。 */
const ALLOWED_PAYMENT_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["x402Version", "scheme", "network", "accepted", "payload", "resource", "extensions"]);
const AUTHORIZATION_KEYS = ["from", "to", "value", "validAfter", "validBefore", "nonce"] as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
/** 65 バイトの ECDSA だけ（EIP-6492 の包み・EIP-1271 の長い署名は拒む）。 */
const SIGNATURE_65 = /^0x[0-9a-fA-F]{130}$/;
const CANONICAL_UINT = /^(0|[1-9][0-9]{0,77})$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

/* ──────────────────────────────────────────────────────────────────────────────
 * 注入する I/O
 * ────────────────────────────────────────────────────────────────────────────── */

export type Hex = `0x${string}`;

export interface LogView {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface ReceiptView {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly logs: readonly LogView[];
}

export interface AuthorizationUsedLog {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
}

/** chain の読み取り（network ごと）。 */
export interface ChainReader {
  authorizationState(asset: Hex, from: Hex, nonce: Hex): Promise<boolean>;
  blockNumber(): Promise<bigint>;
  /** block の時刻（秒）。 */
  blockTimestamp(blockNumber: bigint): Promise<number>;
  /** `AuthorizationUsed(authorizer = from, nonce = nonce)` を `fromBlock..toBlock`（両端を含む）で引く。 */
  authorizationUsedLogs(asset: Hex, from: Hex, nonce: Hex, fromBlock: bigint, toBlock: bigint): Promise<readonly AuthorizationUsedLog[]>;
  /** 待たない receipt の取得（無ければ `undefined`）。 */
  receipt(hash: Hex): Promise<ReceiptView | undefined>;
  /** receipt を `timeoutMs` まで待つ（期限切れは `undefined`）。 */
  waitForReceipt(hash: Hex, timeoutMs: number): Promise<ReceiptView | undefined>;
  feesPerGas(): Promise<{ readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }>;
}

export interface TransferWithAuthorizationArgs {
  readonly asset: Hex;
  readonly from: Hex;
  readonly to: Hex;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
  readonly signature: Hex;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/** 送出（network ごと。`transferWithAuthorization` を 1 回だけ書く）。 */
export interface ChainWriter {
  readonly address: Hex;
  transferWithAuthorization(args: TransferWithAuthorizationArgs): Promise<Hex>;
}

export interface VerifyResult {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly payer?: string;
}

/** SDK の verify（simulate あり）。資金は動かない。 */
export type SdkVerify = (paymentPayload: Record<string, unknown>, paymentRequirements: Record<string, unknown>) => Promise<VerifyResult>;

export interface ChainIo {
  readonly reader: ChainReader;
  readonly writer: ChainWriter;
  readonly verify: SdkVerify;
  /** `eth_getLogs` 1 回の block の幅。 */
  readonly maxLogRange: bigint;
  /** `maxFeePerGas` の上限（wei）。 */
  readonly maxFeePerGas: bigint;
  /** process の寿命での gas の累計の上限（wei）。 */
  readonly gasCap: bigint;
}

export type JournalRecord =
  | {
      readonly type: "submit_intent";
      readonly key: string;
      readonly fingerprint: string;
      readonly network: string;
      readonly asset: string;
      readonly from: string;
      readonly to: string;
      readonly value: string;
      readonly nonce: string;
      readonly validAfter: string;
      readonly validBefore: string;
      readonly at: number;
    }
  | { readonly type: "aborted_before_send"; readonly key: string; readonly reason: string; readonly at: number }
  | { readonly type: "submitted"; readonly key: string; readonly hash: string; readonly at: number }
  | { readonly type: "settled"; readonly key: string; readonly hash: string; readonly blockNumber: string; readonly via: "receipt" | "startup"; readonly at: number }
  | { readonly type: "reverted"; readonly key: string; readonly hash: string; readonly via: "receipt" | "startup"; readonly at: number }
  | { readonly type: "resolved_by_operator"; readonly key: string; readonly reason: string; readonly at: number };

/** 追記と fsync。`append` は fsync まで終えてから resolve する（失敗は reject）。 */
export interface FacilitatorJournal {
  load(): Promise<readonly JournalRecord[]>;
  append(record: JournalRecord): Promise<void>;
}

export interface Clock {
  now(): number;
}

export type Logger = (event: Readonly<Record<string, unknown>>) => void;

export interface EvmFacilitatorOptions {
  /** 有効な network（`EVM_TESTNET_NETWORKS` の部分集合）。 */
  readonly networks: readonly string[];
  readonly chains: ReadonlyMap<string, ChainIo>;
  readonly journal: FacilitatorJournal;
  /** 受取先の allowlist（EVM アドレス。小文字化で比較）。 */
  readonly payToAllowlist: readonly string[];
  readonly clock?: Clock;
  /** 期限の timer（既定は `setTimeout`）。試験は偽の時計と組で渡す。 */
  readonly timer?: SetTimer;
  readonly deadlinesOf?: (network: string) => NetworkDeadlines;
  readonly log?: Logger;
  /** 表（試験は自分の表を渡せる）。既定は `KNOWN_NETWORKS`。 */
  readonly knownNetworks?: readonly KnownNetwork[];
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 要求・応答
 * ────────────────────────────────────────────────────────────────────────────── */

export interface FacilitatorRequest {
  readonly method: string;
  /** path（query を含んでよい。query は拒む）。 */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: string;
  /** 呼び出し元の取り消し（接続の切断）。 */
  readonly signal?: AbortSignal;
}

export interface FacilitatorResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface HttpGuard {
  readonly token: string;
  /** bind した port（`Host` は `127.0.0.1:<port>` だけ）。 */
  readonly port: () => number;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 形の検査
 * ────────────────────────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** EIP-3009 の authorization（形だけ確かめたもの）。 */
interface Authorization {
  readonly from: Hex;
  readonly to: Hex;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
}

/** 手順 1 を通った要求（どの authorization か特定できる）。 */
interface Identified {
  readonly paymentPayload: Record<string, unknown>;
  readonly requirements: Record<string, unknown>;
  readonly network: string;
  readonly asset: Hex;
  readonly authorization: Authorization;
  readonly signature: Hex;
  readonly key: string;
  readonly fingerprint: string;
}

type Check<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function fail<T>(reason: string): Check<T> {
  return { ok: false, reason };
}

/** 手順 1: JSON の形・network・資産・EIP-3009 の authorization が読めること（SDK・RPC の前）。 */
function identify(bodyJson: unknown, enabled: ReadonlySet<string>, table: readonly KnownNetwork[]): Check<Identified> {
  if (!isRecord(bodyJson)) return fail("malformed_request");
  if (bodyJson["x402Version"] !== 2) return fail("unsupported_x402_version");
  const paymentPayload = bodyJson["paymentPayload"];
  const requirements = bodyJson["paymentRequirements"];
  if (!isRecord(paymentPayload) || !isRecord(requirements)) return fail("malformed_request");
  if (paymentPayload["x402Version"] !== 2) return fail("unsupported_x402_version");
  const network = requirements["network"];
  if (typeof network !== "string" || !enabled.has(network)) return fail("network_not_enabled");
  const entry = knownNetworkOf(table, network);
  const asset = requirements["asset"];
  if (entry === undefined || typeof asset !== "string" || !ADDRESS.test(asset) || knownAssetOf(entry, asset) === undefined) return fail("asset_not_in_table");
  const inner = paymentPayload["payload"];
  if (!isRecord(inner)) return fail("malformed_payload");
  const authorization = inner["authorization"];
  const signature = inner["signature"];
  if (!isRecord(authorization) || typeof signature !== "string") return fail("malformed_payload");
  const keys = Object.keys(authorization);
  if (keys.length !== AUTHORIZATION_KEYS.length || !AUTHORIZATION_KEYS.every((k) => keys.includes(k))) return fail("malformed_authorization");
  const { from, to, value, validAfter, validBefore, nonce } = authorization;
  if (typeof from !== "string" || !ADDRESS.test(from) || typeof to !== "string" || !ADDRESS.test(to) || typeof nonce !== "string" || !BYTES32.test(nonce)) {
    return fail("malformed_authorization");
  }
  for (const n of [value, validAfter, validBefore]) {
    if (typeof n !== "string" || !CANONICAL_UINT.test(n)) return fail("malformed_authorization");
  }
  const parsed: Authorization = {
    from: from as Hex,
    to: to as Hex,
    value: BigInt(value as string),
    validAfter: BigInt(validAfter as string),
    validBefore: BigInt(validBefore as string),
    nonce: nonce as Hex,
  };
  const key = [network, assetKeyOf(network, asset), from.toLowerCase(), nonce.toLowerCase()].join("|");
  const fingerprint = `sha256:${createHash("sha256").update(stableJson({ paymentPayload, paymentRequirements: requirements }), "utf8").digest("hex")}`;
  return { ok: true, value: { paymentPayload, requirements, network, asset: asset as Hex, authorization: parsed, signature: signature as Hex, key, fingerprint } };
}

/** 手順 5（と verify の前段）: 束縛・時間の検査。`nowMs` は呼び出し側の時計。 */
function checkBinding(id: Identified, table: readonly KnownNetwork[], allowlist: ReadonlySet<string>, nowMs: number, marginMs: number): Check<undefined> {
  const { requirements, paymentPayload, authorization } = id;
  if (requirements["scheme"] !== "exact") return fail("unsupported_scheme");
  const entry = knownNetworkOf(table, id.network);
  const known = entry === undefined ? undefined : knownAssetOf(entry, id.asset);
  if (known?.domain === undefined) return fail("asset_not_in_table");
  const extra = requirements["extra"];
  if (!isRecord(extra)) return fail("missing_eip712_domain");
  if (extra["name"] !== known.domain.name || extra["version"] !== known.domain.version) return fail("eip712_domain_mismatch");
  for (const k of Object.keys(extra)) if (!ALLOWED_EXTRA_KEYS.has(k)) return fail("unexpected_extra_key");
  if (extra["assetTransferMethod"] !== undefined && extra["assetTransferMethod"] !== "eip3009") return fail("unsupported_transfer_method");
  // payload の形: EIP-3009 の authorization と 65 バイトの署名だけ（Permit2・EIP-6492・extensions は拒む）。
  for (const k of Object.keys(paymentPayload)) if (!ALLOWED_PAYMENT_PAYLOAD_KEYS.has(k)) return fail("unexpected_payload_key");
  const extensions = paymentPayload["extensions"];
  if (extensions !== undefined && !(isRecord(extensions) && Object.keys(extensions).length === 0)) return fail("extensions_not_supported");
  if (paymentPayload["scheme"] !== undefined && paymentPayload["scheme"] !== "exact") return fail("unsupported_scheme");
  if (paymentPayload["network"] !== undefined && paymentPayload["network"] !== id.network) return fail("network_mismatch");
  const inner = paymentPayload["payload"] as Record<string, unknown>;
  for (const k of Object.keys(inner)) if (!ALLOWED_PAYLOAD_KEYS.has(k)) return fail("unexpected_payload_key");
  if (inner["challengeNonce"] !== undefined && inner["challengeNonce"] !== extra["challengeNonce"]) return fail("challenge_nonce_mismatch");
  if (!SIGNATURE_65.test(id.signature)) return fail("unsupported_signature");
  const amount = requirements["amount"];
  if (typeof amount !== "string" || !CANONICAL_UINT.test(amount) || BigInt(amount) === 0n || BigInt(amount) > MAX_AMOUNT) return fail("amount_out_of_range");
  if (authorization.value !== BigInt(amount)) return fail("value_mismatch");
  const payTo = requirements["payTo"];
  if (typeof payTo !== "string" || !ADDRESS.test(payTo) || authorization.to.toLowerCase() !== payTo.toLowerCase()) return fail("recipient_mismatch");
  if (!allowlist.has(payTo.toLowerCase())) return fail("recipient_not_allowed");
  if (stableJson(paymentPayload["accepted"]) !== stableJson(requirements)) return fail("accepted_mismatch");
  if (authorization.validBefore * 1000n < BigInt(nowMs + marginMs)) return fail("valid_before_too_soon");
  return { ok: true, value: undefined };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 直列の待ち行列（network ごと）
 * ────────────────────────────────────────────────────────────────────────────── */

interface Waiter {
  readonly resolve: (entered: boolean) => void;
}

/** 時計の timer（試験は偽の時計で進める）。返り値は取り消し。 */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export const realTimer: SetTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/** 処理中 1 件 + 待ち `maxWaiting` 件。満杯は `undefined`。 */
export class SerialQueue {
  #busy = false;
  readonly #waiting: Waiter[] = [];
  constructor(
    readonly maxWaiting: number,
    readonly timer: SetTimer = realTimer,
  ) {}

  get waiting(): number {
    return this.#waiting.length;
  }

  /** 入れたら `true` で resolve。`cancelAfterMs` で待ちを諦めると `false`（順番が来ても入らない）。満杯なら `undefined`。 */
  enter(cancelAfterMs: number): Promise<boolean> | undefined {
    if (!this.#busy) {
      this.#busy = true;
      return Promise.resolve(true);
    }
    if (this.#waiting.length >= this.maxWaiting) return undefined;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const waiter: Waiter = {
        resolve: (entered) => {
          if (settled) return;
          settled = true;
          cancel();
          resolve(entered);
        },
      };
      const cancel = this.timer(() => {
        const index = this.#waiting.indexOf(waiter);
        if (index >= 0) this.#waiting.splice(index, 1);
        waiter.resolve(false);
      }, Math.max(0, cancelAfterMs));
      this.#waiting.push(waiter);
    });
  }

  leave(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#busy = false;
      return;
    }
    next.resolve(true);
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 補助
 * ────────────────────────────────────────────────────────────────────────────── */

class DeadlineExceeded extends Error {
  constructor() {
    super("deadline exceeded");
    this.name = "DeadlineExceeded";
  }
}

/** `deadlineAt`（時計の ms）までに終わらなければ reject（下の呼び出しは止められないが、応答は期限の内に返す）。 */
function withDeadline<T>(promise: Promise<T>, clock: Clock, deadlineAt: number, timer: SetTimer = realTimer): Promise<T> {
  const remaining = deadlineAt - clock.now();
  if (remaining <= 0) {
    promise.catch(() => {});
    return Promise.reject(new DeadlineExceeded());
  }
  return new Promise<T>((resolve, reject) => {
    const cancel = timer(() => reject(new DeadlineExceeded()), remaining);
    promise.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (error: unknown) => {
        cancel();
        reject(error);
      },
    );
  });
}

function topicAddressOf(topic: string | undefined): string | undefined {
  if (topic === undefined || !/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) return undefined;
  return `0x${topic.slice(26).toLowerCase()}`;
}

/** receipt の中で `Transfer(asset, from, to, value)` に一致する log の数。 */
export function matchingTransfers(receipt: ReceiptView, asset: string, from: string, to: string, value: bigint): number {
  let count = 0;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== asset.toLowerCase()) continue;
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (topicAddressOf(log.topics[1]) !== from.toLowerCase() || topicAddressOf(log.topics[2]) !== to.toLowerCase()) continue;
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(log.data) || BigInt(log.data) !== value) continue;
    count += 1;
  }
  return count;
}

function successBody(hash: string, network: string, from: string): Record<string, unknown> {
  return { success: true, transaction: hash, network, payer: from };
}

function failure(status: number, errorReason: string, network?: string): FacilitatorResponse {
  return { status, body: { success: false, errorReason, ...(network === undefined ? {} : { network }) } };
}

function headerOf(headers: FacilitatorRequest["headers"], name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : value.join(",");
}

function sameToken(given: string, expected: string): boolean {
  // 長さを漏らさないよう hash 同士を比べる。
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 核
 * ────────────────────────────────────────────────────────────────────────────── */

type KeyStatus = "unresolved" | "settled" | "reverted" | "aborted" | "operator";

interface KeyState {
  status: KeyStatus;
  intent: Extract<JournalRecord, { type: "submit_intent" }>;
  hash?: string;
}

export interface EvmFacilitator {
  /** 起動時の journal の読み込みと未解決の照合。`handle` の前に 1 度だけ。 */
  start(): Promise<void>;
  /** HTTP の層を除いた要求の処理（認証・`Host`/`Origin` も見る）。 */
  handle(request: FacilitatorRequest, guard: HttpGuard): Promise<FacilitatorResponse>;
  /** 保留中の network（試験・運用の表示用）。 */
  heldNetworks(): readonly string[];
  /** network ごとの gas の累計（wei）。 */
  gasSpent(network: string): bigint;
}

export function createEvmFacilitator(options: EvmFacilitatorOptions): EvmFacilitator {
  const clock = options.clock ?? { now: () => Date.now() };
  const timer = options.timer ?? realTimer;
  const within = <T>(promise: Promise<T>, deadlineAt: number): Promise<T> => withDeadline(promise, clock, deadlineAt, timer);
  const deadlinesOf = options.deadlinesOf ?? defaultDeadlinesOf;
  const log: Logger = options.log ?? (() => {});
  const table = options.knownNetworks ?? KNOWN_NETWORKS;
  const enabled = new Set(options.networks);
  for (const network of enabled) {
    if (!EVM_TESTNET_NETWORKS.has(network)) throw new Error(`network ${network} is not one of the EVM testnets`);
    if (!options.chains.has(network)) throw new Error(`no chain I/O for ${network}`);
  }
  const allowlist = new Set(options.payToAllowlist.map((a) => a.toLowerCase()));
  if (allowlist.size === 0) throw new Error("payTo allowlist is empty");
  for (const a of allowlist) if (!ADDRESS.test(a)) throw new Error("payTo allowlist has a malformed address");

  const queues = new Map<string, SerialQueue>();
  for (const network of enabled) queues.set(network, new SerialQueue(MAX_WAITING_PER_NETWORK, timer));
  const spent = new Map<string, bigint>();
  const keys = new Map<string, KeyState>();
  /** network → 未解決の鍵（処理中のものは含めない）。1 つでもあれば保留。 */
  const held = new Map<string, Set<string>>();
  const inFlight = new Map<string, { readonly fingerprint: string; readonly response: Promise<FacilitatorResponse> }>();
  let started = false;

  function chainOf(network: string): ChainIo {
    const io = options.chains.get(network);
    if (io === undefined) throw new Error(`no chain I/O for ${network}`);
    return io;
  }

  function hold(network: string, key: string, reason: string): void {
    let set = held.get(network);
    if (set === undefined) {
      set = new Set();
      held.set(network, set);
    }
    set.add(key);
    log({ event: "network_held", network, key, reason });
  }

  function release(network: string, key: string): void {
    const set = held.get(network);
    if (set === undefined) return;
    set.delete(key);
    if (set.size === 0) held.delete(network);
  }

  function isHeld(network: string): boolean {
    return (held.get(network)?.size ?? 0) > 0;
  }

  function addSpent(network: string, wei: bigint): void {
    spent.set(network, (spent.get(network) ?? 0n) + wei);
  }

  function applyRecord(record: JournalRecord): void {
    if (record.type === "submit_intent") {
      keys.set(record.key, { status: "unresolved", intent: record });
      return;
    }
    const state = keys.get(record.key);
    if (state === undefined) return;
    switch (record.type) {
      case "submitted":
        state.hash = record.hash;
        return;
      case "settled":
        state.status = "settled";
        state.hash = record.hash;
        return;
      case "reverted":
        state.status = "reverted";
        state.hash = record.hash;
        return;
      case "aborted_before_send":
        if (state.status === "unresolved") state.status = "aborted";
        return;
      case "resolved_by_operator":
        if (state.status === "unresolved") state.status = "operator";
        return;
    }
  }

  async function append(record: JournalRecord): Promise<void> {
    await options.journal.append(record);
    applyRecord(record);
  }

  /**
   * 使用済みの authorization の照合（手順 4）。`AuthorizationUsed` を `validAfter`〜`validBefore` に当たる block の範囲だけで狭く引き、
   * その tx の receipt に `Transfer`(asset, from, to, value) が 1 つ一致し成功していれば、その tx。
   */
  async function reconcile(id: Pick<Identified, "network" | "asset" | "authorization">, deadlineAt: number): Promise<{ hash: Hex; blockNumber: bigint } | undefined> {
    const io = chainOf(id.network);
    const r = io.reader;
    const auth = id.authorization;
    const call = <T>(p: Promise<T>): Promise<T> => within(p, deadlineAt);
    const latest = await call(r.blockNumber());
    const latestTs = await call(r.blockTimestamp(latest));
    const validBefore = Number(auth.validBefore > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : auth.validBefore);
    const validAfter = Number(auth.validAfter > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : auth.validAfter);
    const startTs = Math.max(validAfter, validBefore - RECONCILE_LOOKBACK_SECONDS);
    if (startTs > latestTs) return undefined;
    // 下端: 時刻 ≤ startTs の block（早めに外れるのは構わない: 範囲が広がるだけ）。
    const startBlock = await blockAtOrBefore(r, latest, latestTs, startTs, call);
    if (startBlock === undefined) return undefined;
    // 上端: `block.timestamp < validBefore` の block だけが使える。時刻 ≥ validBefore の block（または最新）。
    const endBlock = validBefore >= latestTs ? latest : await blockAtOrAfter(r, startBlock, latest, validBefore, call);
    // 新しい方から狭い幅で引く（使われたのは最近のことが多い）。
    let to = endBlock;
    while (to >= startBlock) {
      const from = to - io.maxLogRange + 1n > startBlock ? to - io.maxLogRange + 1n : startBlock;
      const logs = await call(r.authorizationUsedLogs(id.asset, auth.from, auth.nonce, from, to));
      for (const found of logs) {
        const receipt = await call(r.receipt(found.transactionHash));
        // 確認数 1: receipt がある（block に入った）こと。成功でなければ一致としない。
        if (receipt === undefined || receipt.status !== "success") continue;
        if (matchingTransfers(receipt, id.asset, auth.from, auth.to, auth.value) === 1) return { hash: found.transactionHash, blockNumber: receipt.blockNumber };
      }
      if (logs.length > 0) return undefined; // 使われたが一致しない（別の宛先・金額）。
      if (from === 0n) break;
      to = from - 1n;
    }
    return undefined;
  }

  async function blockAtOrBefore(r: ChainReader, latest: bigint, latestTs: number, targetTs: number, call: <T>(p: Promise<T>) => Promise<T>): Promise<bigint | undefined> {
    let hiBlock = latest;
    let hiTs = latestTs;
    // 平均の block 時間を 1 回だけ測る（最新とその 100 前）。
    const probe = latest > 100n ? latest - 100n : 0n;
    const probeTs = probe === latest ? latestTs : await call(r.blockTimestamp(probe));
    if (probeTs <= targetTs) {
      // 100 block の内側: その中で狭める必要はない（範囲が少し広がるだけ）。
      return probe;
    }
    let perBlock = Math.max((latestTs - probeTs) / Number(latest - probe || 1n), 0.05);
    hiBlock = probe;
    hiTs = probeTs;
    for (let step = 0; step < BLOCK_SEARCH_MAX_STEPS; step += 1) {
      const back = BigInt(Math.ceil(((hiTs - targetTs) / perBlock) * 1.2) + 1);
      const guess = hiBlock > back ? hiBlock - back : 0n;
      const guessTs = await call(r.blockTimestamp(guess));
      if (guessTs <= targetTs) return guess;
      if (guess === 0n) return 0n;
      perBlock = Math.max((hiTs - guessTs) / Number(hiBlock - guess), 0.05);
      hiBlock = guess;
      hiTs = guessTs;
    }
    return undefined;
  }

  async function blockAtOrAfter(r: ChainReader, low: bigint, latest: bigint, targetTs: number, call: <T>(p: Promise<T>) => Promise<T>): Promise<bigint> {
    let lo = low;
    let hi = latest;
    // 二分探索（時刻 ≥ targetTs の最小の block。見つからなければ最新）。
    for (let step = 0; step < 40 && lo < hi; step += 1) {
      const mid = lo + (hi - lo) / 2n;
      const ts = await call(r.blockTimestamp(mid));
      if (ts >= targetTs) hi = mid;
      else lo = mid + 1n;
    }
    return hi;
  }

  /** 手順 2: journal に同じ鍵（処理中のものは手順 3 で扱う）。返り値があればそれで答える。 */
  function journalAnswer(id: Identified): FacilitatorResponse | undefined {
    if (inFlight.has(id.key)) return undefined;
    const state = keys.get(id.key);
    return state === undefined ? undefined : answerFromState(id, state);
  }

  /** 手順 4: chain の `authorizationState`。使用済みなら照合の結果で答える。未使用なら `undefined`。 */
  async function usedAnswer(id: Identified, deadlineAt: number): Promise<FacilitatorResponse | undefined> {
    const io = chainOf(id.network);
    let used: boolean;
    try {
      used = await within(io.reader.authorizationState(id.asset, id.authorization.from, id.authorization.nonce), deadlineAt);
    } catch {
      return failure(502, "rpc_unavailable", id.network);
    }
    if (!used) return undefined;
    return await reconcileAnswer(id, deadlineAt);
  }

  async function reconcileAnswer(id: Identified, deadlineAt: number): Promise<FacilitatorResponse> {
    try {
      const found = await reconcile(id, deadlineAt);
      if (found !== undefined) {
        log({ event: "reconciled_used_authorization", network: id.network, key: id.key, transaction: found.hash });
        return { status: 200, body: successBody(found.hash, id.network, id.authorization.from) };
      }
      log({ event: "used_authorization_unmatched", network: id.network, key: id.key });
      return failure(500, "authorization_used_unmatched", id.network);
    } catch {
      return failure(502, "rpc_unavailable", id.network);
    }
  }

  async function settle(id: Identified, receivedAt: number, signal: AbortSignal | undefined): Promise<FacilitatorResponse> {
    const network = id.network;
    const io = chainOf(network);
    const deadlines = deadlinesOf(network);
    const deadlineAt = receivedAt + deadlines.facilitatorMs;

    // 手順 4（時間・束縛の検査より前）。
    const used = await usedAnswer(id, deadlineAt);
    if (used !== undefined) return used;

    // 手順 5。
    const binding = checkBinding(id, table, allowlist, clock.now(), deadlines.validBeforeMarginMs);
    if (!binding.ok) return failure(400, binding.reason, network);

    // 手順 6: 直列の待ち行列。
    const queue = queues.get(network);
    if (queue === undefined) return failure(400, "network_not_enabled", network);
    const entering = queue.enter(deadlineAt - deadlines.preBroadcastMs - clock.now());
    if (entering === undefined) {
      log({ event: "queue_full", network, key: id.key, sent: false });
      return failure(503, "queue_full", network);
    }
    const entered = await entering;
    if (!entered) {
      log({ event: "queue_timeout", network, key: id.key, sent: false });
      return failure(503, "queue_timeout", network);
    }
    try {
      return await settleInLine(id, io, deadlines, deadlineAt, signal);
    } finally {
      queue.leave();
    }
  }

  /** 手順 6 の後半〜11（network の直列の内側）。 */
  async function settleInLine(id: Identified, io: ChainIo, deadlines: NetworkDeadlines, deadlineAt: number, signal: AbortSignal | undefined): Promise<FacilitatorResponse> {
    const network = id.network;
    const auth = id.authorization;
    if (isHeld(network)) return failure(503, "network_held", network);
    // 待っている間に変わったかもしれないので 2 と 4 をもう一度。
    const state = keys.get(id.key);
    const again = state === undefined ? undefined : answerFromState(id, state);
    if (again !== undefined) return again;
    const usedAgain = await usedAnswer(id, deadlineAt);
    if (usedAgain !== undefined) return usedAgain;

    /**
     * 手順 4 の後の 400（未払いの断定）は、**その時点で** `authorizationState` を読み直して未使用を確かめてから返す（Codex I-1 #1）。
     * 手順 4 の読み取りの後の await（verify・手数料の見積り・journal）の間に他で使われていれば照合（200 か 5xx）、読めなければ 5xx。
     * `holdOnReadFailure`: 意図を journal に書いた後（`aborted_before_send` の後）の読み直しの失敗は network を保留する。
     */
    const refuseIfStillUnused = async (reason: string, holdOnReadFailure = false): Promise<FacilitatorResponse> => {
      let usedNow: boolean;
      try {
        usedNow = await within(io.reader.authorizationState(id.asset, auth.from, auth.nonce), deadlineAt);
      } catch {
        if (holdOnReadFailure) hold(network, id.key, "state_unreadable_after_intent");
        return failure(502, "rpc_unavailable", network);
      }
      if (usedNow) return await reconcileAnswer(id, deadlineAt);
      return failure(400, reason, network);
    };

    // 手順 7: SDK の verify（simulate あり）。失敗したら state を読み直す。
    let verified: VerifyResult | undefined;
    try {
      verified = await within(io.verify(id.paymentPayload, id.requirements), deadlineAt);
    } catch {
      verified = undefined;
    }
    if (verified?.isValid !== true) return await refuseIfStillUnused(verified === undefined ? "verify_unavailable" : "invalid_payment");

    // 手順 8: gas の上限。
    let fees: { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint };
    try {
      fees = await within(io.reader.feesPerGas(), deadlineAt);
    } catch {
      return await refuseIfStillUnused("fee_estimate_unavailable");
    }
    if (fees.maxFeePerGas > io.maxFeePerGas) return await refuseIfStillUnused("fee_too_high");
    const worst = SETTLE_GAS_LIMIT * fees.maxFeePerGas;
    if ((spent.get(network) ?? 0n) + worst > io.gasCap) {
      log({ event: "gas_cap_reached", network, key: id.key, sent: false });
      return await refuseIfStillUnused("gas_cap_reached");
    }

    // 手順 9: 送出の直前の残り時間・validBefore・取り消し。
    const timeProblem = (): string | undefined => {
      const now = clock.now();
      if (signal?.aborted === true) return "request_cancelled";
      if (deadlineAt - now < deadlines.preBroadcastMs) return "insufficient_time_before_broadcast";
      if (auth.validBefore * 1000n < BigInt(now + deadlines.validBeforeMarginMs)) return "valid_before_too_soon";
      return undefined;
    };
    const before = timeProblem();
    if (before !== undefined) return await refuseIfStillUnused(before);

    // 手順 10: 送出の意図を fsync してから、もう一度検査して送出。
    // journal の書き込みは締め切りで打ち切る（Codex I-1 #2）。打ち切った後に書き込みが終わっても、この続きは既に return しているので
    // 送出には決して進まない（送出は下の `await` が成功したときの同じ続きの中だけ）。遅れて意図の行が載るかもしれないので保留する。
    try {
      await within(
        append({
          type: "submit_intent",
          key: id.key,
          fingerprint: id.fingerprint,
          network,
          asset: id.asset,
          from: auth.from,
          to: auth.to,
          value: auth.value.toString(),
          nonce: auth.nonce,
          validAfter: auth.validAfter.toString(),
          validBefore: auth.validBefore.toString(),
          at: clock.now(),
        }),
        deadlineAt,
      );
    } catch (error) {
      // 意図の行が途中まで（または遅れて）残るかもしれない（再起動後は未解決として保留）。送出はしていない。
      const timedOut = error instanceof DeadlineExceeded;
      hold(network, id.key, timedOut ? "journal_intent_timeout" : "journal_write_failed");
      return failure(timedOut ? 504 : 500, timedOut ? "journal_timeout" : "journal_unavailable", network);
    }
    const after = timeProblem();
    if (after !== undefined) {
      try {
        await within(append({ type: "aborted_before_send", key: id.key, reason: after, at: clock.now() }), deadlineAt);
      } catch {
        hold(network, id.key, "journal_write_failed");
        return failure(500, "journal_unavailable", network);
      }
      log({ event: "aborted_before_send", network, key: id.key, reason: after });
      return await refuseIfStillUnused(after, true);
    }
    // ここから先の失敗は全部 5xx（送出したかもしれない）。検査と送出の間に await を挟まない。
    const sending = io.writer.transferWithAuthorization({
      asset: id.asset,
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
      signature: id.signature,
      gas: SETTLE_GAS_LIMIT,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    let hash: Hex;
    try {
      hash = await within(sending, deadlineAt);
    } catch {
      addSpent(network, worst);
      hold(network, id.key, "send_outcome_unknown");
      // 期限の後に hash が返れば journal に残す（運用者の照合のため）。
      sending.then(
        (late) => void append({ type: "submitted", key: id.key, hash: late, at: clock.now() }).catch(() => {}),
        () => {},
      );
      return failure(500, "send_outcome_unknown", network);
    }
    log({ event: "submitted", network, key: id.key, transaction: hash });
    try {
      await within(append({ type: "submitted", key: id.key, hash, at: clock.now() }), deadlineAt);
    } catch (error) {
      if (error instanceof DeadlineExceeded) {
        // 書き込みは裏で続く。応答は締め切りで返し、network を保留する。
        addSpent(network, worst);
        hold(network, id.key, "journal_submitted_timeout");
        return failure(504, "journal_timeout", network);
      }
      // hash は失われる（意図の行は残る）。結果の待ちは続ける。
      log({ event: "journal_write_failed", network, key: id.key, stage: "submitted" });
    }

    // 手順 11: receipt を締め切りまで待つ。
    let receipt: ReceiptView | undefined;
    try {
      receipt = await within(io.reader.waitForReceipt(hash, Math.max(0, deadlineAt - clock.now())), deadlineAt);
    } catch {
      receipt = undefined;
    }
    if (receipt === undefined) {
      addSpent(network, worst);
      hold(network, id.key, "receipt_timeout");
      return failure(504, "receipt_timeout", network);
    }
    addSpent(network, receipt.gasUsed * receipt.effectiveGasPrice);
    if (receipt.status === "reverted") {
      try {
        await within(append({ type: "reverted", key: id.key, hash, via: "receipt", at: clock.now() }), deadlineAt);
      } catch {
        hold(network, id.key, "journal_write_failed");
      }
      log({ event: "reverted", network, key: id.key, transaction: hash });
      return failure(502, "transaction_reverted", network);
    }
    if (matchingTransfers(receipt, id.asset, auth.from, auth.to, auth.value) !== 1) {
      hold(network, id.key, "transfer_mismatch");
      return failure(502, "transfer_mismatch", network);
    }
    try {
      await within(append({ type: "settled", key: id.key, hash, blockNumber: receipt.blockNumber.toString(), via: "receipt", at: clock.now() }), deadlineAt);
    } catch (error) {
      if (error instanceof DeadlineExceeded) {
        // chain では確定しているが journal に載ったか分からない。締め切りで 5xx、保留（再起動の照合で解ける）。
        hold(network, id.key, "journal_settled_timeout");
        return failure(504, "journal_timeout", network);
      }
      // chain では確定している。再起動の照合で解ける（意図と submitted が残る）。
      log({ event: "journal_write_failed", network, key: id.key, stage: "settled" });
      const s = keys.get(id.key);
      if (s !== undefined) {
        s.status = "settled";
        s.hash = hash;
      }
    }
    log({ event: "settled", network, key: id.key, transaction: hash });
    return { status: 200, body: successBody(hash, network, auth.from) };
  }

  function answerFromState(id: Identified, state: KeyState): FacilitatorResponse | undefined {
    switch (state.status) {
      case "settled":
        if (state.intent.fingerprint !== id.fingerprint) return failure(500, "fingerprint_conflict", id.network);
        return { status: 200, body: successBody(state.hash ?? "", id.network, state.intent.from) };
      case "aborted":
        // 送出していない（`aborted_before_send` を fsync 済み）。続けて処理してよい。
        return undefined;
      case "unresolved":
        return failure(500, "submission_unresolved", id.network);
      case "reverted":
        return failure(500, "submission_reverted", id.network);
      case "operator":
        return failure(500, "resolved_by_operator", id.network);
    }
  }

  async function handleSettle(bodyJson: unknown, receivedAt: number, signal: AbortSignal | undefined): Promise<FacilitatorResponse> {
    // 手順 1。
    const identified = identify(bodyJson, enabled, table);
    if (!identified.ok) return failure(400, identified.reason);
    const id = identified.value;
    if (isHeld(id.network)) return failure(503, "network_held", id.network);
    // 手順 2（処理中のものは 3 で扱う）。
    const recorded = journalAnswer(id);
    if (recorded !== undefined) return recorded;
    // 手順 3: 処理中の同じ鍵。指紋が同じなら合流、違えば 5xx。
    const running = inFlight.get(id.key);
    if (running !== undefined) {
      if (running.fingerprint !== id.fingerprint) return failure(500, "fingerprint_conflict", id.network);
      log({ event: "coalesced", network: id.network, key: id.key });
      return await running.response;
    }
    const response = settle(id, receivedAt, signal).catch((): FacilitatorResponse => failure(500, "internal_error", id.network));
    inFlight.set(id.key, { fingerprint: id.fingerprint, response });
    try {
      return await response;
    } finally {
      inFlight.delete(id.key);
    }
  }

  async function handleVerify(bodyJson: unknown, receivedAt: number): Promise<FacilitatorResponse> {
    const identified = identify(bodyJson, enabled, table);
    if (!identified.ok) return { status: 400, body: { isValid: false, invalidReason: identified.reason } };
    const id = identified.value;
    const deadlines = deadlinesOf(id.network);
    const binding = checkBinding(id, table, allowlist, clock.now(), deadlines.validBeforeMarginMs);
    if (!binding.ok) return { status: 400, body: { isValid: false, invalidReason: binding.reason } };
    try {
      const result = await within(chainOf(id.network).verify(id.paymentPayload, id.requirements), receivedAt + deadlines.facilitatorMs);
      // 判定と固定の理由だけ返す（SDK の `invalidMessage` は RPC の生の文言を含み得るので出さない）。
      return {
        status: 200,
        body: { isValid: result.isValid === true, ...(result.isValid !== true && typeof result.invalidReason === "string" ? { invalidReason: result.invalidReason } : {}), payer: id.authorization.from },
      };
    } catch {
      return { status: 502, body: { isValid: false, invalidReason: "verify_unavailable" } };
    }
  }

  function supported(): FacilitatorResponse {
    const kinds = [...enabled].map((network) => ({ x402Version: 2, scheme: "exact", network }));
    const signers = [...new Set([...enabled].map((n) => chainOf(n).writer.address))];
    return { status: 200, body: { kinds, extensions: [], signers: { "eip155:*": signers } } };
  }

  /** 起動時: journal を読み、未解決を chain で照合する。解けないものは保留。 */
  async function start(): Promise<void> {
    if (started) throw new Error("already started");
    started = true;
    const records = await options.journal.load();
    for (const record of records) applyRecord(record);
    for (const [key, state] of keys) {
      if (state.status !== "unresolved") continue;
      const network = state.intent.network;
      const io = options.chains.get(network);
      if (io === undefined || !enabled.has(network)) {
        // 有効でない network の未解決: その network は使わないが、記録として残す。
        log({ event: "unresolved_on_disabled_network", network, key });
        continue;
      }
      const resolved = await resolveAtStartup(key, state, io).catch(() => false);
      if (!resolved) hold(network, key, "unresolved_at_startup");
    }
    log({ event: "started", held: [...held.keys()] });
  }

  async function resolveAtStartup(key: string, state: KeyState, io: ChainIo): Promise<boolean> {
    const intent = state.intent;
    const asset = intent.asset as Hex;
    const from = intent.from as Hex;
    const value = BigInt(intent.value);
    const startupDeadline = clock.now() + 60_000;
    let hash = state.hash as Hex | undefined;
    if (hash === undefined) {
      const used = await within(io.reader.authorizationState(asset, from, intent.nonce as Hex), startupDeadline);
      if (!used) return false; // 送出中かもしれない（hash 無し）。運用者の判断。
      const found = await reconcile(
        {
          network: intent.network,
          asset,
          authorization: { from, to: intent.to as Hex, value, validAfter: BigInt(intent.validAfter), validBefore: BigInt(intent.validBefore), nonce: intent.nonce as Hex },
        },
        startupDeadline,
      );
      if (found === undefined) return false;
      hash = found.hash;
    }
    const receipt = await within(io.reader.receipt(hash), startupDeadline);
    if (receipt === undefined) return false;
    if (receipt.status === "reverted") {
      await append({ type: "reverted", key, hash, via: "startup", at: clock.now() });
      log({ event: "resolved_at_startup", key, outcome: "reverted", transaction: hash });
      return true;
    }
    if (matchingTransfers(receipt, asset, from, intent.to, value) !== 1) return false;
    await append({ type: "settled", key, hash, blockNumber: receipt.blockNumber.toString(), via: "startup", at: clock.now() });
    log({ event: "resolved_at_startup", key, outcome: "settled", transaction: hash });
    return true;
  }

  async function handle(request: FacilitatorRequest, guard: HttpGuard): Promise<FacilitatorResponse> {
    const receivedAt = clock.now();
    if (!started) return { status: 503, body: { error: "starting" } };
    if (headerOf(request.headers, "origin") !== undefined) return { status: 403, body: { error: "forbidden" } };
    if (headerOf(request.headers, "host") !== `127.0.0.1:${guard.port()}`) return { status: 403, body: { error: "forbidden" } };
    const segments = request.url.split("/");
    // `/<token>/<op>` だけ（query・余分な段は拒む）。
    if (segments.length !== 3 || segments[0] !== "" || request.url.includes("?")) return { status: 404, body: { error: "not_found" } };
    const [, token, op] = segments as [string, string, string];
    if (!sameToken(token, guard.token)) return { status: 404, body: { error: "not_found" } };
    if (op === "supported") {
      if (request.method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
      return supported();
    }
    if (op !== "verify" && op !== "settle") return { status: 404, body: { error: "not_found" } };
    if (request.method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
    const contentType = headerOf(request.headers, "content-type") ?? "";
    if (!/^application\/json(\s*;.*)?$/i.test(contentType)) return { status: 415, body: { error: "unsupported_media_type" } };
    if (Buffer.byteLength(request.body, "utf8") > MAX_BODY_BYTES) return { status: 413, body: { error: "payload_too_large" } };
    let bodyJson: unknown;
    try {
      bodyJson = JSON.parse(request.body);
    } catch {
      return op === "verify" ? { status: 400, body: { isValid: false, invalidReason: "malformed_request" } } : failure(400, "malformed_request");
    }
    if (op === "verify") return await handleVerify(bodyJson, receivedAt);
    return await handleSettle(bodyJson, receivedAt, request.signal);
  }

  return {
    start,
    handle,
    heldNetworks: () => [...held.keys()],
    gasSpent: (network) => spent.get(network) ?? 0n,
  };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * node:http の層
 * ────────────────────────────────────────────────────────────────────────────── */

/** 本文を上限まで読む（超えれば `undefined`）。 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        over = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? undefined : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** `facilitator` を `127.0.0.1:<port>` に bind する。`port` 0 は使い捨て（試験）。 */
export async function listenFacilitator(facilitator: EvmFacilitator, token: string, port: number): Promise<{ server: Server; port: number }> {
  if (!TOKEN_PATTERN.test(token)) throw new Error("EVM_FACILITATOR_TOKEN must be 32+ characters of [A-Za-z0-9_-]");
  let bound = port;
  const guard: HttpGuard = { token, port: () => bound };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    void (async () => {
      let response: FacilitatorResponse;
      try {
        const declared = req.headers["content-length"];
        const body = declared !== undefined && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES ? undefined : await readBody(req, MAX_BODY_BYTES);
        response =
          body === undefined
            ? { status: 413, body: { error: "payload_too_large" } }
            : await facilitator.handle({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, signal: controller.signal }, guard);
      } catch {
        response = { status: 500, body: { error: "internal_error" } };
      }
      const text = JSON.stringify(response.body);
      res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
      res.end(text);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no TCP address");
  bound = address.port;
  return { server, port: bound };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 永続の journal（ndjson、追記と fsync）
 * ────────────────────────────────────────────────────────────────────────────── */

const RECORD_TYPES: ReadonlySet<string> = new Set(["submit_intent", "aborted_before_send", "submitted", "settled", "reverted", "resolved_by_operator"]);

/** 1 行を読む。形が違えば例外（起動しない: 運用者が直す）。`resolved_by_operator` は理由が必須。 */
export function parseJournalLine(line: string, lineNo: number): JournalRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`journal line ${lineNo} is not JSON`);
  }
  if (!isRecord(value) || typeof value["type"] !== "string" || !RECORD_TYPES.has(value["type"]) || typeof value["key"] !== "string") {
    throw new Error(`journal line ${lineNo} is not a facilitator record`);
  }
  if (value["type"] === "resolved_by_operator" && (typeof value["reason"] !== "string" || value["reason"].trim() === "")) {
    throw new Error(`journal line ${lineNo}: resolved_by_operator needs a reason`);
  }
  if ((value["type"] === "submitted" || value["type"] === "settled" || value["type"] === "reverted") && (typeof value["hash"] !== "string" || !BYTES32.test(value["hash"]))) {
    throw new Error(`journal line ${lineNo}: malformed hash`);
  }
  return value as unknown as JournalRecord;
}

/** journal のファイル（追記と fsync）。 */
export interface JournalFile {
  write(text: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** journal が使うファイル系の操作（試験は差し替える）。 */
export interface JournalFs {
  exists(target: string): boolean;
  /** 1 段だけ作る（0700）。既にあれば何もしない。 */
  mkdir(target: string): void;
  /** 無ければ `undefined`。 */
  readText(target: string): string | undefined;
  /** 追記で開く（無ければ 0600 で作る）。 */
  openAppend(target: string): Promise<JournalFile>;
  /** ディレクトリを開いて fsync する（中の項目の作成を永続にする）。 */
  fsyncDir(target: string): Promise<void>;
}

export const nodeJournalFs: JournalFs = {
  exists(target) {
    return existsSync(target);
  },
  mkdir(target) {
    try {
      mkdirSync(target, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  },
  readText(target) {
    try {
      return readFileSync(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  async openAppend(target) {
    const handle: FileHandle = await open(target, "a", 0o600);
    return {
      write: async (text) => {
        await handle.write(text);
      },
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  async fsyncDir(target) {
    const handle = await open(target, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

/**
 * ndjson の journal。`load` が終わるまで使わない（`start` の前、server の listen の前に呼ばれる）。
 * ファイルと、その親から root までのディレクトリを（新しく作ったかによらず）fsync してから受け入れる（Codex I-1 #3・I-2 #5）:
 * 電源断でファイルの中身だけ fsync され、ディレクトリの項目が消えて journal ごと無くなることを防ぐ。
 */
export function createFileJournal(file: string, fs: JournalFs = nodeJournalFs): FacilitatorJournal & { close(): Promise<void> } {
  const target = path.resolve(file);
  let handle: JournalFile | undefined;
  let chain: Promise<void> = Promise.resolve();
  return {
    async load(): Promise<readonly JournalRecord[]> {
      const dir = path.dirname(target);
      // 無い祖先を上から作る。
      const created: string[] = [];
      for (let current = dir; !fs.exists(current); ) {
        created.unshift(current);
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      for (const d of created) fs.mkdir(d);
      const records = (fs.readText(target) ?? "")
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.trim() !== "")
        .map(({ line, index }) => parseJournalLine(line, index + 1));
      const opened = await fs.openAppend(target);
      try {
        // **起動のたびに**ファイルと、その親から root までの全ディレクトリを深い方から fsync する（Codex I-2 #5）。
        // 「既にある」だけでは前回の起動がディレクトリの fsync の途中で失敗した場合を区別できないので、存在で省かない。
        await opened.sync();
        for (let d = dir; ; d = path.dirname(d)) {
          await fs.fsyncDir(d);
          if (path.dirname(d) === d) break;
        }
      } catch (error) {
        await opened.close().catch(() => {});
        throw error;
      }
      handle = opened;
      return records;
    },
    append(record: JournalRecord): Promise<void> {
      const next = chain.then(async () => {
        if (handle === undefined) throw new Error("journal is not open");
        await handle.write(`${JSON.stringify(record)}\n`);
        await handle.sync();
      });
      chain = next.catch(() => {});
      return next;
    },
    async close(): Promise<void> {
      await chain;
      await handle?.close();
      handle = undefined;
    },
  };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * CLI（viem と SDK の verify の配線）
 * ────────────────────────────────────────────────────────────────────────────── */

export interface CliConfig {
  readonly key: Hex;
  readonly token: string;
  readonly port: number;
  readonly networks: readonly string[];
  readonly payToAllowlist: readonly string[];
  readonly rpcUrls: ReadonlyMap<string, string>;
  readonly gasCaps: ReadonlyMap<string, bigint>;
  readonly maxFees: ReadonlyMap<string, bigint>;
  readonly logRanges: ReadonlyMap<string, bigint>;
  readonly journal: string;
  readonly logFile?: string;
}

/**
 * 起動の失敗。`message` は**このファイルで書いた固定の文言**だけ（env の名前・有効な network の CAIP-2 は可）。
 * 下の層の例外の文言（viem は RPC の URL を、fs はパスを埋め込む。URL には API key が入り得る）・鍵・token は決して載せない（Codex I-1 #4）。
 */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

/** 下の層の例外を固定の code に置き換える（元の文言は捨てる）。 */
async function orStartupError<T>(code: string, work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StartupError) throw error;
    throw new StartupError(code);
  }
}

/** env を読む（値は出さない）。足りなければ `StartupError`。 */
export function cliConfigOf(env: NodeJS.ProcessEnv): CliConfig {
  const key = env["EVM_FACILITATOR_KEY"];
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new StartupError("EVM_FACILITATOR_KEY must be a 0x-prefixed 32-byte hex string");
  const token = env["EVM_FACILITATOR_TOKEN"];
  if (token === undefined || !TOKEN_PATTERN.test(token)) throw new StartupError("EVM_FACILITATOR_TOKEN must be set (32+ characters of [A-Za-z0-9_-])");
  const portText = env["EVM_FACILITATOR_PORT"] ?? String(DEFAULT_PORT);
  if (!/^[1-9][0-9]{0,4}$/.test(portText) || Number(portText) > 65535) throw new StartupError("EVM_FACILITATOR_PORT must be a TCP port");
  const networks = (env["EVM_FACILITATOR_NETWORKS"] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (networks.length === 0) throw new StartupError("EVM_FACILITATOR_NETWORKS must list at least one of the EVM testnets");
  for (const n of networks) if (!EVM_TESTNET_NETWORKS.has(n)) throw new StartupError(`EVM_FACILITATOR_NETWORKS must list only ${[...EVM_TESTNET_NETWORKS].join(", ")}`);
  const payToAllowlist = (env["EVM_FACILITATOR_PAYTO_ALLOWLIST"] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (payToAllowlist.length === 0 || payToAllowlist.some((a) => !ADDRESS.test(a))) throw new StartupError("EVM_FACILITATOR_PAYTO_ALLOWLIST must list EVM addresses");
  const journal = env["EVM_FACILITATOR_JOURNAL"];
  if (journal === undefined || journal === "") throw new StartupError("EVM_FACILITATOR_JOURNAL must be set");
  const rpcUrls = new Map<string, string>();
  const gasCaps = new Map<string, bigint>();
  const maxFees = new Map<string, bigint>();
  const logRanges = new Map<string, bigint>();
  for (const network of networks) {
    const chainId = evmChainIdOf(network);
    if (chainId === undefined) throw new StartupError("EVM_FACILITATOR_NETWORKS has a network without a chain id");
    const rpc = env[`EVM_FACILITATOR_RPC_${chainId}`] ?? DEFAULT_RPC_URLS[network];
    if (rpc === undefined || !/^https:\/\//.test(rpc)) throw new StartupError(`EVM_FACILITATOR_RPC_${chainId} must be an https URL`);
    rpcUrls.set(network, rpc);
    const cap = env[`EVM_FACILITATOR_GAS_CAP_${chainId}`];
    if (cap === undefined || !/^[1-9][0-9]{0,30}$/.test(cap)) throw new StartupError(`EVM_FACILITATOR_GAS_CAP_${chainId} must be a positive wei amount`);
    gasCaps.set(network, BigInt(cap));
    const fee = env[`EVM_FACILITATOR_MAX_FEE_PER_GAS_${chainId}`];
    if (fee !== undefined && !/^[1-9][0-9]{0,30}$/.test(fee)) throw new StartupError(`EVM_FACILITATOR_MAX_FEE_PER_GAS_${chainId} must be a positive wei amount`);
    maxFees.set(network, fee === undefined ? (DEFAULT_MAX_FEE_PER_GAS[network] ?? 1_000_000_000n) : BigInt(fee));
    const range = env[`EVM_FACILITATOR_LOG_RANGE_${chainId}`];
    if (range !== undefined && !/^[1-9][0-9]{0,6}$/.test(range)) throw new StartupError(`EVM_FACILITATOR_LOG_RANGE_${chainId} must be a positive block count`);
    logRanges.set(network, range === undefined ? (DEFAULT_LOG_RANGES[network] ?? 500n) : BigInt(range));
  }
  const logFile = env["EVM_FACILITATOR_LOG"];
  return { key: key as Hex, token, port: Number(portText), networks, payToAllowlist, rpcUrls, gasCaps, maxFees, logRanges, journal, ...(logFile === undefined || logFile === "" ? {} : { logFile }) };
}

/** viem の client で 1 network の I/O を作る（鍵は account にだけ渡す）。 */
async function viemChainIo(network: string, config: CliConfig): Promise<ChainIo> {
  const viem = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { ExactEvmScheme } = await import("@x402/evm/exact/facilitator");
  const { toFacilitatorEvmSigner } = await import("@x402/evm");
  const chainId = evmChainIdOf(network);
  const rpc = config.rpcUrls.get(network);
  if (chainId === undefined || rpc === undefined) throw new Error(`no RPC for ${network}`);
  const chain = viem.defineChain({ id: chainId, name: network, nativeCurrency: { name: "native", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  // 隠れた再試行をしない（送出の要求を transport が繰り返さない）。
  const transport = viem.http(rpc, { retryCount: 0, timeout: 15_000 });
  const publicClient = viem.createPublicClient({ chain, transport });
  const account = privateKeyToAccount(config.key);
  const walletClient = viem.createWalletClient({ chain, transport, account });
  const eip3009Abi = viem.parseAbi([
    "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
    "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  ]);
  const authorizationUsed = viem.parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
  const toReceipt = (r: { status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint; logs: readonly { address: string; topics: readonly string[]; data: string }[] }): ReceiptView => ({
    status: r.status,
    blockNumber: r.blockNumber,
    gasUsed: r.gasUsed,
    effectiveGasPrice: r.effectiveGasPrice,
    logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })),
  });
  const reader: ChainReader = {
    async authorizationState(asset, from, nonce) {
      return (await publicClient.readContract({ address: asset, abi: eip3009Abi, functionName: "authorizationState", args: [from, nonce] })) === true;
    },
    async blockNumber() {
      return await publicClient.getBlockNumber({ cacheTime: 0 });
    },
    async blockTimestamp(blockNumber) {
      return Number((await publicClient.getBlock({ blockNumber })).timestamp);
    },
    async authorizationUsedLogs(asset, from, nonce, fromBlock, toBlock) {
      const logs = await publicClient.getLogs({ address: asset, event: authorizationUsed, args: { authorizer: from, nonce }, fromBlock, toBlock, strict: true });
      return logs.filter((l) => l.transactionHash !== null && l.blockNumber !== null).map((l) => ({ transactionHash: l.transactionHash as Hex, blockNumber: l.blockNumber as bigint }));
    },
    async receipt(hash) {
      try {
        return toReceipt(await publicClient.getTransactionReceipt({ hash }));
      } catch (error) {
        if (error instanceof viem.TransactionReceiptNotFoundError) return undefined;
        throw error;
      }
    },
    async waitForReceipt(hash, timeoutMs) {
      try {
        return toReceipt(await publicClient.waitForTransactionReceipt({ hash, timeout: Math.max(1, timeoutMs), confirmations: 1, pollingInterval: 500, retryCount: 0 }));
      } catch (error) {
        if (error instanceof viem.WaitForTransactionReceiptTimeoutError) return undefined;
        throw error;
      }
    },
    async feesPerGas() {
      const fees = await publicClient.estimateFeesPerGas({ type: "eip1559" });
      return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
    },
  };
  const writer: ChainWriter = {
    address: account.address,
    async transferWithAuthorization(args) {
      const sig = viem.parseSignature(args.signature);
      const v = sig.v ?? BigInt(sig.yParity + 27);
      return await walletClient.writeContract({
        address: args.asset,
        abi: eip3009Abi,
        functionName: "transferWithAuthorization",
        args: [args.from, args.to, args.value, args.validAfter, args.validBefore, args.nonce, Number(v), sig.r, sig.s],
        gas: args.gas,
        maxFeePerGas: args.maxFeePerGas,
        maxPriorityFeePerGas: args.maxPriorityFeePerGas,
        chain,
        account,
      });
    },
  };
  // SDK の verify だけに使う signer。送出の関数は呼ばれたら落とす（verify は送出しない）。
  const refuse = (): never => {
    throw new Error("the verify-only signer never sends transactions");
  };
  const signer = toFacilitatorEvmSigner({
    address: account.address,
    readContract: (args) => publicClient.readContract(args as never) as Promise<unknown>,
    verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
    writeContract: async () => refuse(),
    sendTransaction: async () => refuse(),
    waitForTransactionReceipt: async () => refuse(),
    getCode: (args) => publicClient.getCode(args),
  });
  const scheme = new ExactEvmScheme(signer);
  const verify: SdkVerify = async (paymentPayload, paymentRequirements) => {
    const result = await scheme.verify(paymentPayload as never, paymentRequirements as never);
    return { isValid: result.isValid, ...(result.invalidReason === undefined ? {} : { invalidReason: result.invalidReason }), ...(result.payer === undefined ? {} : { payer: result.payer }) };
  };
  const maxFeePerGas = config.maxFees.get(network);
  const gasCap = config.gasCaps.get(network);
  const maxLogRange = config.logRanges.get(network);
  if (maxFeePerGas === undefined || gasCap === undefined || maxLogRange === undefined) throw new Error(`incomplete config for ${network}`);
  // 起動時に chainId を確かめる（別の chain の RPC に送出しない）。
  const actual = await publicClient.getChainId();
  if (actual !== chainId) throw new Error(`RPC for ${network} reports chain id ${actual}`);
  return { reader, writer, verify, maxLogRange, maxFeePerGas, gasCap };
}

function fileLogger(file: string | undefined): Logger {
  if (file === undefined) {
    return (event) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let chain: Promise<void> = Promise.resolve();
  const handle = open(file, "a", 0o600);
  // 開けなければ log は捨てる（未処理の reject でパスを含む文言を出さない）。
  handle.catch(() => {});
  return (event) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    chain = chain.then(async () => {
      await (await handle).write(line);
    }).catch(() => {});
  };
}

export interface CliOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** 起動の本体。失敗は `StartupError` だけを投げる（`runCli` が固定の文言で出す）。 */
export async function main(env: NodeJS.ProcessEnv, out: CliOutput): Promise<void> {
  const config = cliConfigOf(env);
  const chains = new Map<string, ChainIo>();
  // network は表の 4 つに確かめ済み（code に入れてよい）。RPC の URL・例外の文言は入れない。
  for (const network of config.networks) chains.set(network, await orStartupError(`rpc_check_failed:${network}`, () => viemChainIo(network, config)));
  const log = await orStartupError("log_unavailable", () => fileLogger(config.logFile));
  const facilitator = createEvmFacilitator({
    networks: config.networks,
    chains,
    journal: createFileJournal(config.journal),
    payToAllowlist: config.payToAllowlist,
    log,
  });
  await orStartupError("journal_unavailable", () => facilitator.start());
  const { port } = await orStartupError("listen_failed", () => listenFacilitator(facilitator, config.token, config.port));
  const signer = chains.values().next().value?.writer.address;
  // token は出さない。
  out.stdout(`${JSON.stringify({ event: "listening", host: "127.0.0.1", port, networks: config.networks, signer, held: facilitator.heldNetworks() })}\n`);
}

/** CLI の入口。終了 code を返す（0 = listen 中）。失敗の出力は固定の文言だけ。 */
export async function runCli(env: NodeJS.ProcessEnv, out: CliOutput): Promise<number> {
  try {
    await main(env, out);
    return 0;
  } catch (error) {
    out.stderr(`evm-facilitator: ${error instanceof StartupError ? error.message : "startup_failed"}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out: CliOutput = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) };
  // 下の層の想定外の例外も文言を出さない（Node の既定は例外の全文を出す）。
  const fatal = (): void => {
    process.stderr.write("evm-facilitator: internal_error\n");
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  void runCli(process.env, out).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
