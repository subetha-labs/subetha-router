/**
 * 自前の x402 v2 facilitator（EVM testnet 4 つ。設計 `docs/evm-testnets-x402-design.md` §3.3）。**製品コードではない**（運用者の道具）。
 *
 * - `GET /<token>/supported`・`POST /<token>/verify`・`POST /<token>/settle`。bind は env `EVM_FACILITATOR_BIND`（`127.0.0.1` 既定か `0.0.0.0`。
 *   hosted 設計 `docs/evm-testnets-hosted-design.md` §2.1）。`Origin` つき・`Host` 違い（`127.0.0.1:<port>` の完全一致でない）は拒む。
 * - verify は SDK（`@x402/evm/exact/facilitator` の `ExactEvmScheme`）の **verify だけ** を使う。settle は SDK に任せない
 *   （固定版 2.28.0 の settle は receipt の失敗を `success: false` で返し、Router が `rejected` に写す。設計 §1.2）。
 * - 原則: settle の 400（= Router の `rejected`）は「その authorization が chain で未使用で、この facilitator が一度も送出していない」と
 *   確かめたときだけ。それ以外の失敗は 5xx（Router の `unknown`）。
 * - 送出の意図は永続の journal（ndjson、追記と fsync）に書いてから送出する。未解決の送出がある network は保留（再起動後も）。
 * - gas の累計と上限は journal から復元する（hosted 設計 §2.2）。上限は最初の起動で env の値を `gas_cap_init` に書き、以後は
 *   journal の記録（`gas_cap_init` + `gas_cap_raise`）だけで決まる。補充は運用者の `raise-cap`（facilitator が止まっているときだけ）。
 * - 実行者は 1 つ: journal の隣の常設の `facilitator.lock` に OS の `flock` を process の寿命の間かける（hosted 設計 §2.3）。
 *
 * 核（`createEvmFacilitator`）は chain の I/O・journal・時計を注入で受け、網なしで試験できる（`tests/unit/evm-facilitator.test.ts`）。
 * CLI（`main`）だけが viem と SDK の verify を配線する。
 *
 * 鍵・署名・token は log・応答・例外の文言に出さない。
 *
 * usage: EVM_FACILITATOR_KEY=0x... EVM_FACILITATOR_TOKEN=<32 文字以上> EVM_FACILITATOR_NETWORKS=eip155:46630,eip155:998 \
 *        EVM_FACILITATOR_PAYTO_ALLOWLIST=0x... EVM_FACILITATOR_GAS_CAP_46630=<wei> EVM_FACILITATOR_GAS_CAP_998=<wei> \
 *        EVM_FACILITATOR_JOURNAL=.claude_workflow/local/evm-testnets/run-<UTC>/facilitator-journal.ndjson tsx tools/evm-facilitator.ts
 *        補充: EVM_FACILITATOR_JOURNAL=<同じ journal> tsx tools/evm-facilitator.ts raise-cap --network <eip155:id> --add-wei <wei> --reason <文>
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import fsExt from "fs-ext";

import { stableJson } from "../src/core/intent.js";
import { assetKeyOf, EVM_TESTNET_NETWORKS, evmChainIdOf, KNOWN_NETWORKS, knownAssetOf, knownNetworkOf, type KnownNetwork } from "../src/shared/networks.js";

/* ──────────────────────────────────────────────────────────────────────────────
 * 定数（設計 §3.3・§3.6・§3.8）
 * ────────────────────────────────────────────────────────────────────────────── */

export const DEFAULT_PORT = 8611;
/** 要求の本文の上限（バイト）。 */
export const MAX_BODY_BYTES = 64 * 1024;
/**
 * 設計 §3.8 の当初の 1 回の settle の gas 上限。facilitator の送出はもう使わない（見積り × 1.25、上限は `DEFAULT_MAX_SETTLE_GAS`）。
 * E2E の driver（`tools/evm-testnets-e2e.ts`）の資金の表がまだ参照するので残す。
 */
export const SETTLE_GAS_LIMIT = 200_000n;
/**
 * 1 回の settle の gas 上限の network ごとの既定（`EVM_FACILITATOR_MAX_GAS_<chainId>` で上書き）。送出の gas は見積り × 1.25（切り上げ）で、
 * これを超えれば送出しない。Ethereum Sepolia は 200,000 で out of gas になった（2026-10-13 の live。gasUsed 197,313、estimateGas 288,251）。
 */
export const DEFAULT_MAX_SETTLE_GAS: Readonly<Record<string, bigint>> = Object.freeze({
  "eip155:46630": 200_000n,
  "eip155:421614": 200_000n,
  "eip155:998": 200_000n,
  "eip155:11155111": 400_000n,
});

/** 送出の gas = 見積り × 1.25 の切り上げ。 */
export function settleGasLimitOf(estimate: bigint): bigint {
  return (estimate * 125n + 99n) / 100n;
}
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
  /** 送出と同じ `transferWithAuthorization` の呼び出し（facilitator のアドレスから）の gas の見積り。再試行しない。 */
  estimateTransferGas(args: TransferAuthorizationCall): Promise<bigint>;
}

/** `transferWithAuthorization` の引数（gas・手数料を除く）。 */
export interface TransferAuthorizationCall {
  readonly asset: Hex;
  readonly from: Hex;
  readonly to: Hex;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
  readonly signature: Hex;
}

export interface TransferWithAuthorizationArgs extends TransferAuthorizationCall {
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
  /**
   * env の gas の累計の上限（wei。`EVM_FACILITATOR_GAS_CAP_<chainId>`）。最初の起動で journal の `gas_cap_init` に書くか、
   * 既にある `gas_cap_init` と照合するだけ（違えば起動しない）。有効な上限は journal の記録で決まる（hosted 設計 §2.2）。
   */
  readonly gasCap: bigint;
  /** 1 回の settle の gas 上限（見積り × 1.25 がこれを超えれば送出しない）。 */
  readonly maxSettleGas: bigint;
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
      /** gas の予約（wei の 10 進。= 送る gas 上限 × `maxFeePerGas`。送出の最悪値）。 */
      readonly gasReservedWei: string;
      readonly at: number;
    }
  | { readonly type: "aborted_before_send"; readonly key: string; readonly reason: string; readonly at: number }
  | { readonly type: "submitted"; readonly key: string; readonly hash: string; readonly at: number }
  /** `gasUsedWei`: 数える gas（wei の 10 進）。receipt の `gasUsed × effectiveGasPrice`（hash の分からない起動時の照合は予約の値。`resolveAtStartup`）。 */
  | { readonly type: "settled"; readonly key: string; readonly hash: string; readonly blockNumber: string; readonly via: "receipt" | "startup"; readonly gasUsedWei: string; readonly at: number }
  | { readonly type: "reverted"; readonly key: string; readonly hash: string; readonly via: "receipt" | "startup"; readonly gasUsedWei: string; readonly at: number }
  | { readonly type: "resolved_by_operator"; readonly key: string; readonly reason: string; readonly at: number }
  /** network ごとに 1 つ。最初の起動で env の上限を書く（hosted 設計 §2.2）。 */
  | { readonly type: "gas_cap_init"; readonly network: string; readonly capWei: string; readonly at: number }
  /** 運用者の補充（`raise-cap`）。理由は必須。 */
  | { readonly type: "gas_cap_raise"; readonly network: string; readonly addWei: string; readonly reason: string; readonly at: number };

/** 支払いの記録（`key` を持つもの）。 */
export type PaymentRecord = Exclude<JournalRecord, { type: "gas_cap_init" } | { type: "gas_cap_raise" }>;

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
  /** この鍵が gas の累計に入れている額（wei）。未解決・運用者の解決 = 予約、確定・revert = `gasUsedWei`、`aborted_before_send` = 0。 */
  counted: bigint;
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
  /** network ごとの有効な gas の上限（wei。`gas_cap_init` + Σ `gas_cap_raise`）。`start` の前・記録の無い network は `undefined`。 */
  gasCap(network: string): bigint | undefined;
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
  /** network → gas の累計（wei）。journal の再生と live の記録の両方を `applyRecord` だけが動かす（再生と同じ値になる）。 */
  const spent = new Map<string, bigint>();
  /** network → `gas_cap_init.capWei`。 */
  const capInit = new Map<string, bigint>();
  /** network → Σ `gas_cap_raise.addWei`。 */
  const capRaised = new Map<string, bigint>();
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

  /** 鍵の数える額を `wei` に置き換える（差分だけ累計を動かす）。 */
  function recount(state: KeyState, wei: bigint): void {
    addSpent(state.intent.network, wei - state.counted);
    state.counted = wei;
  }

  function effectiveCap(network: string): bigint | undefined {
    const init = capInit.get(network);
    return init === undefined ? undefined : init + (capRaised.get(network) ?? 0n);
  }

  /**
   * 1 つの記録を状態に写す（起動の再生と live の追記の共通。gas の累計もここだけで動く: hosted 設計 §2.2）。
   * 累計 = Σ(確定・revert の `gasUsedWei`) + Σ(未解決・運用者の解決の予約)。`aborted_before_send` は 0（送出していない）。
   */
  function applyRecord(record: JournalRecord): void {
    switch (record.type) {
      case "gas_cap_init":
        capInit.set(record.network, BigInt(record.capWei));
        return;
      case "gas_cap_raise":
        capRaised.set(record.network, (capRaised.get(record.network) ?? 0n) + BigInt(record.addWei));
        return;
      case "submit_intent": {
        // 同じ鍵の前の状態（`aborted_before_send` の後の再送）の数えた額はそのまま残す（0 のはず。違っても安全側）。
        const reserved = BigInt(record.gasReservedWei);
        keys.set(record.key, { status: "unresolved", intent: record, counted: reserved });
        addSpent(record.network, reserved);
        return;
      }
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
        recount(state, BigInt(record.gasUsedWei));
        return;
      case "reverted":
        state.status = "reverted";
        state.hash = record.hash;
        recount(state, BigInt(record.gasUsedWei));
        return;
      case "aborted_before_send":
        if (state.status === "unresolved") {
          state.status = "aborted";
          recount(state, 0n);
        }
        return;
      case "resolved_by_operator":
        // 予約の分は戻さない（chain で何が起きたかを facilitator は確かめていない）。
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

    // 手順 8: gas の上限。まず送出と同じ呼び出しの gas を見積もる（固定の gas 上限は Sepolia で out of gas になった）。
    const call: TransferAuthorizationCall = {
      asset: id.asset,
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
      signature: id.signature,
    };
    let gasEstimate: bigint;
    try {
      gasEstimate = await within(io.reader.estimateTransferGas(call), deadlineAt);
    } catch {
      return await refuseIfStillUnused("gas_estimate_unavailable");
    }
    const gasLimit = settleGasLimitOf(gasEstimate);
    if (gasEstimate <= 0n || gasLimit > io.maxSettleGas) {
      log({ event: "gas_limit_too_high", network, key: id.key, gasEstimate: gasEstimate.toString(), gasLimit: gasLimit.toString(), sent: false });
      return await refuseIfStillUnused("gas_limit_too_high");
    }
    let fees: { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint };
    try {
      fees = await within(io.reader.feesPerGas(), deadlineAt);
    } catch {
      return await refuseIfStillUnused("fee_estimate_unavailable");
    }
    if (fees.maxFeePerGas > io.maxFeePerGas) return await refuseIfStillUnused("fee_too_high");
    const worst = gasLimit * fees.maxFeePerGas;
    // 累計は journal から復元した値から始まり、上限は journal の記録の有効な上限（hosted 設計 §2.2。env の値は使わない）。
    const cap = effectiveCap(network);
    if (cap === undefined || (spent.get(network) ?? 0n) + worst > cap) {
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
          // 予約は意図の行と一緒に永続にする（fsync の後に `applyRecord` が累計に足す）。
          gasReservedWei: worst.toString(),
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
    log({ event: "submit_intent", network, key: id.key, gasEstimate: gasEstimate.toString(), gasLimit: gasLimit.toString() });
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
      ...call,
      gas: gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    let hash: Hex;
    try {
      hash = await within(sending, deadlineAt);
    } catch {
      // 予約（意図の行）が累計に入ったまま（未解決）。
      hold(network, id.key, "send_outcome_unknown");
      // 期限の後に hash が返れば journal に残す（運用者の照合のため）。
      sending.then(
        (late) => void append({ type: "submitted", key: id.key, hash: late, at: clock.now() }).catch(() => {}),
        () => {},
      );
      return failure(500, "send_outcome_unknown", network);
    }
    log({ event: "submitted", network, key: id.key, transaction: hash, gasEstimate: gasEstimate.toString(), gasLimit: gasLimit.toString() });
    try {
      await within(append({ type: "submitted", key: id.key, hash, at: clock.now() }), deadlineAt);
    } catch (error) {
      if (error instanceof DeadlineExceeded) {
        // 書き込みは裏で続く。応答は締め切りで返し、network を保留する（予約は累計に入ったまま）。
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
      hold(network, id.key, "receipt_timeout");
      return failure(504, "receipt_timeout", network);
    }
    // 実費は確定・revert の記録（`gasUsedWei`）が載ったときに予約と置き換わる。記録が載らなければ予約のまま（安全側。再生と同じ）。
    // Transfer の不一致は未解決のまま（予約のまま）。
    const gasUsedWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
    if (receipt.status === "reverted") {
      try {
        await within(append({ type: "reverted", key: id.key, hash, via: "receipt", gasUsedWei, at: clock.now() }), deadlineAt);
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
      await within(append({ type: "settled", key: id.key, hash, blockNumber: receipt.blockNumber.toString(), via: "receipt", gasUsedWei, at: clock.now() }), deadlineAt);
    } catch (error) {
      if (error instanceof DeadlineExceeded) {
        // chain では確定しているが journal に載ったか分からない。締め切りで 5xx、保留（再起動の照合で解ける）。
        hold(network, id.key, "journal_settled_timeout");
        return failure(504, "journal_timeout", network);
      }
      // chain では確定している。再起動の照合で解ける（意図と submitted が残る）。累計は予約のまま（再生と同じ）。
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

  /**
   * 起動時: journal を読み、gas の累計と上限を復元し、未解決を chain で照合する。解けないものは保留。
   * 旧形式の journal・env の上限と journal の `gas_cap_init` の違いは `StartupError`（起動しない。hosted 設計 §2.2）。
   */
  async function start(): Promise<void> {
    if (started) throw new Error("already started");
    started = true;
    const records = await options.journal.load();
    checkGasJournal(records);
    for (const record of records) applyRecord(record);
    // 上限: env の値は journal の `gas_cap_init` と照合するだけ（env の書き換えで黙って補充できない）。全部を確かめてから書く。
    const fresh: string[] = [];
    for (const network of enabled) {
      const recorded = capInit.get(network);
      if (recorded === undefined) fresh.push(network);
      else if (recorded !== chainOf(network).gasCap) throw new StartupError(`gas_cap_env_mismatch:${network}`);
    }
    // 最初の起動: env の上限を fsync で書く（listen の前。`append` は fsync まで待つ）。
    for (const network of fresh) await append({ type: "gas_cap_init", network, capWei: chainOf(network).gasCap.toString(), at: clock.now() });
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
    // 値は wei だけ（鍵・token は出さない）。
    for (const network of enabled) log({ event: "gas_budget", network, capWei: (effectiveCap(network) ?? 0n).toString(), spentWei: (spent.get(network) ?? 0n).toString() });
    log({ event: "started", held: [...held.keys()] });
  }

  async function resolveAtStartup(key: string, state: KeyState, io: ChainIo): Promise<boolean> {
    const intent = state.intent;
    const asset = intent.asset as Hex;
    const from = intent.from as Hex;
    const value = BigInt(intent.value);
    const startupDeadline = clock.now() + 60_000;
    let hash = state.hash as Hex | undefined;
    /**
     * 数える gas: hash が journal にある（自分の送出の tx）なら receipt の実費。hash が無く `AuthorizationUsed` から tx を見つけたときは
     * その tx が自分の送出とは限らない（他で使われ、自分の送出は別に revert したかもしれない）ので、予約（自分の送出の最悪値）を書く。
     * どちらの場合も自分の送出の実費は予約を超えない（gasUsed ≤ gas 上限、effectiveGasPrice ≤ maxFeePerGas）ので、再生は安全側になる。
     */
    let ours = true;
    if (hash === undefined) {
      ours = false;
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
    const gasUsedWei = ours ? (receipt.gasUsed * receipt.effectiveGasPrice).toString() : intent.gasReservedWei;
    if (receipt.status === "reverted") {
      await append({ type: "reverted", key, hash, via: "startup", gasUsedWei, at: clock.now() });
      log({ event: "resolved_at_startup", key, outcome: "reverted", transaction: hash });
      return true;
    }
    if (matchingTransfers(receipt, asset, from, intent.to, value) !== 1) return false;
    await append({ type: "settled", key, hash, blockNumber: receipt.blockNumber.toString(), via: "startup", gasUsedWei, at: clock.now() });
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
    gasCap: (network) => effectiveCap(network),
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

/** bind してよいアドレス（hosted 設計 §2.1。コンテナの中は `0.0.0.0`: docker の publish はコンテナの eth0 に届く）。 */
export const BIND_ADDRESSES: ReadonlySet<string> = new Set(["127.0.0.1", "0.0.0.0"]);
export const DEFAULT_BIND = "127.0.0.1";

/**
 * `facilitator` を `<host>:<port>` に bind する（`host` は `BIND_ADDRESSES` だけ、既定 `127.0.0.1`）。`port` 0 は使い捨て（試験）。
 * `Host` の検査は bind によらず `127.0.0.1:<port>` の完全一致のまま（Router は loopback で直接、Worker は Caddy の書き換えで同じ値）。
 */
export async function listenFacilitator(facilitator: EvmFacilitator, token: string, port: number, host: string = DEFAULT_BIND): Promise<{ server: Server; port: number; host: string }> {
  if (!TOKEN_PATTERN.test(token)) throw new Error("EVM_FACILITATOR_TOKEN must be 32+ characters of [A-Za-z0-9_-]");
  if (!BIND_ADDRESSES.has(host)) throw new Error("bind address must be 127.0.0.1 or 0.0.0.0");
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
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no TCP address");
  bound = address.port;
  return { server, port: bound, host: address.address };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 永続の journal（ndjson、追記と fsync）
 * ────────────────────────────────────────────────────────────────────────────── */

const RECORD_TYPES: ReadonlySet<string> = new Set(["submit_intent", "aborted_before_send", "submitted", "settled", "reverted", "resolved_by_operator", "gas_cap_init", "gas_cap_raise"]);
const GAS_CAP_TYPES: ReadonlySet<string> = new Set(["gas_cap_init", "gas_cap_raise"]);
/** 上限・補充の額（正の wei の 10 進、uint256 の桁まで）。 */
const POSITIVE_WEI = /^[1-9][0-9]{0,77}$/;
/** 補充の理由の長さの上限（文字）。 */
export const MAX_REASON_LENGTH = 200;
/** C0・C1 の制御文字と行・段落の区切り。 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** 補充の理由: 空（空白だけ）でなく、制御文字を含まず、`MAX_REASON_LENGTH` 文字まで。 */
export function isValidReason(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_REASON_LENGTH && !CONTROL_CHARACTERS.test(value);
}

/** 旧形式（gas の欄の無い記録・`gas_cap_init` の無い支払い）の journal の拒否の文言（固定）。 */
export const OLD_FORMAT_MESSAGE = "journal_old_format: start with a new journal (gas fields or gas_cap_init missing)";

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

/** 1 行を読む。形が違えば例外（起動しない: 運用者が直す）。`resolved_by_operator` は理由が必須。旧形式の行は `StartupError`（固定の文言）。 */
export function parseJournalLine(line: string, lineNo: number): JournalRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`journal line ${lineNo} is not JSON`);
  }
  if (!isRecord(value) || typeof value["type"] !== "string" || !RECORD_TYPES.has(value["type"])) {
    throw new Error(`journal line ${lineNo} is not a facilitator record`);
  }
  if (GAS_CAP_TYPES.has(value["type"])) {
    // 上限の記録: 欄はちょうど決まったものだけ。
    const init = value["type"] === "gas_cap_init";
    if (!exactKeys(value, init ? ["type", "network", "capWei", "at"] : ["type", "network", "addWei", "reason", "at"])) throw new Error(`journal line ${lineNo}: malformed ${value["type"]}`);
    if (typeof value["network"] !== "string" || !EVM_TESTNET_NETWORKS.has(value["network"])) throw new Error(`journal line ${lineNo}: unknown network`);
    const amount = value[init ? "capWei" : "addWei"];
    if (typeof amount !== "string" || !POSITIVE_WEI.test(amount)) throw new Error(`journal line ${lineNo}: malformed wei amount`);
    if (!init && !isValidReason(value["reason"])) throw new Error(`journal line ${lineNo}: gas_cap_raise needs a reason`);
    if (typeof value["at"] !== "number" || !Number.isSafeInteger(value["at"]) || value["at"] < 0) throw new Error(`journal line ${lineNo}: malformed at`);
    return value as unknown as JournalRecord;
  }
  if (typeof value["key"] !== "string") throw new Error(`journal line ${lineNo} is not a facilitator record`);
  const gasField = value["type"] === "submit_intent" ? "gasReservedWei" : value["type"] === "settled" || value["type"] === "reverted" ? "gasUsedWei" : undefined;
  if (gasField !== undefined) {
    const gas = value[gasField];
    // 欄が無い = 旧形式（ローカル版の journal）。持ち込まない（hosted 設計 §2.2）。
    if (gas === undefined) throw new StartupError(OLD_FORMAT_MESSAGE);
    if (typeof gas !== "string" || !CANONICAL_UINT.test(gas)) throw new Error(`journal line ${lineNo}: malformed ${gasField}`);
  }
  if (value["type"] === "resolved_by_operator" && (typeof value["reason"] !== "string" || value["reason"].trim() === "")) {
    throw new Error(`journal line ${lineNo}: resolved_by_operator needs a reason`);
  }
  if ((value["type"] === "submitted" || value["type"] === "settled" || value["type"] === "reverted") && (typeof value["hash"] !== "string" || !BYTES32.test(value["hash"]))) {
    throw new Error(`journal line ${lineNo}: malformed hash`);
  }
  return value as unknown as JournalRecord;
}

/**
 * 読んだ記録の全体の検査（`start`・`raise-cap` の両方。注入の journal にも効く）。違えば `StartupError`（固定の文言）。
 * - 旧形式: gas の欄の無い `submit_intent`・`settled`・`reverted`、またはその network の `gas_cap_init` より前（無い）の `submit_intent`。
 * - `gas_cap_init` は network ごとに 1 つ。`gas_cap_raise` はその network の `gas_cap_init` の後だけ。
 */
export function checkGasJournal(records: readonly JournalRecord[]): void {
  const inited = new Set<string>();
  const weiOf = (value: unknown, pattern: RegExp): void => {
    if (value === undefined) throw new StartupError(OLD_FORMAT_MESSAGE);
    if (typeof value !== "string" || !pattern.test(value)) throw new StartupError("journal_malformed");
  };
  for (const record of records) {
    const raw = record as unknown as Record<string, unknown>;
    switch (record.type) {
      case "gas_cap_init":
        weiOf(raw["capWei"], POSITIVE_WEI);
        if (inited.has(record.network)) throw new StartupError("journal_gas_cap_invalid");
        inited.add(record.network);
        break;
      case "gas_cap_raise":
        weiOf(raw["addWei"], POSITIVE_WEI);
        if (!inited.has(record.network)) throw new StartupError("journal_gas_cap_invalid");
        break;
      case "submit_intent":
        weiOf(raw["gasReservedWei"], CANONICAL_UINT);
        if (!inited.has(record.network)) throw new StartupError(OLD_FORMAT_MESSAGE);
        break;
      case "settled":
      case "reverted":
        weiOf(raw["gasUsedWei"], CANONICAL_UINT);
        break;
      default:
        break;
    }
  }
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
  /** bind のアドレス（`BIND_ADDRESSES`）。 */
  readonly bind: string;
  readonly networks: readonly string[];
  readonly payToAllowlist: readonly string[];
  readonly rpcUrls: ReadonlyMap<string, string>;
  readonly gasCaps: ReadonlyMap<string, bigint>;
  readonly maxFees: ReadonlyMap<string, bigint>;
  readonly maxGas: ReadonlyMap<string, bigint>;
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
  const bind = env["EVM_FACILITATOR_BIND"] ?? DEFAULT_BIND;
  if (!BIND_ADDRESSES.has(bind)) throw new StartupError("EVM_FACILITATOR_BIND must be 127.0.0.1 or 0.0.0.0");
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
  const maxGas = new Map<string, bigint>();
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
    const gas = env[`EVM_FACILITATOR_MAX_GAS_${chainId}`];
    if (gas !== undefined && !/^[1-9][0-9]{0,8}$/.test(gas)) throw new StartupError(`EVM_FACILITATOR_MAX_GAS_${chainId} must be a positive gas amount`);
    maxGas.set(network, gas === undefined ? (DEFAULT_MAX_SETTLE_GAS[network] ?? SETTLE_GAS_LIMIT) : BigInt(gas));
    const range = env[`EVM_FACILITATOR_LOG_RANGE_${chainId}`];
    if (range !== undefined && !/^[1-9][0-9]{0,6}$/.test(range)) throw new StartupError(`EVM_FACILITATOR_LOG_RANGE_${chainId} must be a positive block count`);
    logRanges.set(network, range === undefined ? (DEFAULT_LOG_RANGES[network] ?? 500n) : BigInt(range));
  }
  const logFile = env["EVM_FACILITATOR_LOG"];
  return { key: key as Hex, token, port: Number(portText), bind, networks, payToAllowlist, rpcUrls, gasCaps, maxFees, maxGas, logRanges, journal, ...(logFile === undefined || logFile === "" ? {} : { logFile }) };
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
  // 見積りと送出で同じ引数（v・r・s に分けた 65 バイトの署名）。
  const transferArgsOf = (call: TransferAuthorizationCall) => {
    const sig = viem.parseSignature(call.signature);
    const v = sig.v ?? BigInt(sig.yParity + 27);
    return [call.from, call.to, call.value, call.validAfter, call.validBefore, call.nonce, Number(v), sig.r, sig.s] as const;
  };
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
    async estimateTransferGas(call) {
      // 送出と同じ abi・引数・送出元（transport は retryCount 0）。
      return await publicClient.estimateContractGas({ address: call.asset, abi: eip3009Abi, functionName: "transferWithAuthorization", args: transferArgsOf(call), account });
    },
  };
  const writer: ChainWriter = {
    address: account.address,
    async transferWithAuthorization(args) {
      return await walletClient.writeContract({
        address: args.asset,
        abi: eip3009Abi,
        functionName: "transferWithAuthorization",
        args: transferArgsOf(args),
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
  const maxSettleGas = config.maxGas.get(network);
  if (maxFeePerGas === undefined || gasCap === undefined || maxLogRange === undefined || maxSettleGas === undefined) throw new Error(`incomplete config for ${network}`);
  // 起動時に chainId を確かめる（別の chain の RPC に送出しない）。
  const actual = await publicClient.getChainId();
  if (actual !== chainId) throw new Error(`RPC for ${network} reports chain id ${actual}`);
  return { reader, writer, verify, maxLogRange, maxFeePerGas, gasCap, maxSettleGas };
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

/* ──────────────────────────────────────────────────────────────────────────────
 * 単一の実行者の lock（hosted 設計 §2.3。`src/core/journal.ts` の `acquireLock` と同じ仕組み）
 * ────────────────────────────────────────────────────────────────────────────── */

/** `flock(2)` の非ブロッキング排他（試験は差し替える）。取れなければ `code` つきの例外。 */
export type FlockFn = (fd: number, flags: "exnb") => void;

export const realFlock: FlockFn = (fd, flags) => fsExt.flockSync(fd, flags);

/** 持っている lock。`release` は fd を閉じる（process の終了でも kernel が解く）。 */
export interface FacilitatorLock {
  release(): void;
}

/** lock が他（動いている facilitator・`raise-cap`）に持たれているときの文言（固定）。 */
export const LOCKED_MESSAGE = "facilitator_locked: another facilitator or raise-cap holds the journal lock";

/** journal の隣の常設の lock ファイル（同じディレクトリの `facilitator.lock`）。 */
export function facilitatorLockPathOf(journal: string): string {
  return path.join(path.dirname(path.resolve(journal)), "facilitator.lock");
}

/**
 * 常設の lock ファイルを open（無ければ 0600 で作る、切り詰めない）し、その fd に非ブロッキングの排他 lock をかける。
 * - 取れなければ `StartupError`（`LOCKED_MESSAGE`）。heartbeat・奪取は **しない**（止まった process も lock を持ったまま: fail closed）。
 * - lock ファイルは **消さない**（解放は fd のクローズ = process の終了）。
 * - fd は数値の fd で持つ（`FileHandle` は GC で閉じられ、lock が黙って解けることがある）。呼び出し側は返り値を process の寿命の間持つ。
 */
export function acquireFacilitatorLock(lockPath: string, flock: FlockFn = realFlock): FacilitatorLock {
  let fd: number;
  try {
    fd = openSync(lockPath, "a", 0o600);
  } catch {
    throw new StartupError("lock_unavailable");
  }
  try {
    flock(fd, "exnb");
  } catch (error) {
    closeSync(fd);
    const code = (error as { code?: unknown }).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EACCES") throw new StartupError(LOCKED_MESSAGE);
    throw new StartupError("lock_unavailable");
  }
  let open = true;
  return {
    release() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

/** 起動の差し替え（試験）。既定は実際の `flock` と viem の I/O。 */
export interface MainDeps {
  readonly lock?: (lockPath: string) => FacilitatorLock;
  readonly chainIoOf?: (network: string, config: CliConfig) => Promise<ChainIo>;
}

/** listen 中の facilitator。`close` は server・journal・lock を閉じる（試験用。本番は process の終了まで持つ）。 */
export interface RunningFacilitator {
  readonly server: Server;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

/** 起動の本体。失敗は `StartupError` だけを投げる（`runCli` が固定の文言で出す）。 */
export async function main(env: NodeJS.ProcessEnv, out: CliOutput, deps: MainDeps = {}): Promise<RunningFacilitator> {
  const config = cliConfigOf(env);
  const lockPath = facilitatorLockPathOf(config.journal);
  // journal の読み書きより前に lock を取る（§2.3）。lock ファイルは journal の隣なので、そのディレクトリは先に作る。
  await orStartupError("lock_unavailable", () => void mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 }));
  const lock = await orStartupError("lock_unavailable", () => (deps.lock ?? ((p: string) => acquireFacilitatorLock(p)))(lockPath));
  const journal = createFileJournal(config.journal);
  try {
    const chains = new Map<string, ChainIo>();
    const chainIoOf = deps.chainIoOf ?? viemChainIo;
    // network は表の 4 つに確かめ済み（code に入れてよい）。RPC の URL・例外の文言は入れない。
    for (const network of config.networks) chains.set(network, await orStartupError(`rpc_check_failed:${network}`, () => chainIoOf(network, config)));
    const log = await orStartupError("log_unavailable", () => fileLogger(config.logFile));
    const facilitator = createEvmFacilitator({
      networks: config.networks,
      chains,
      journal,
      payToAllowlist: config.payToAllowlist,
      log,
    });
    await orStartupError("journal_unavailable", () => facilitator.start());
    const { server, port, host } = await orStartupError("listen_failed", () => listenFacilitator(facilitator, config.token, config.port, config.bind));
    const signer = chains.values().next().value?.writer.address;
    // token は出さない。
    out.stdout(`${JSON.stringify({ event: "listening", host, port, networks: config.networks, signer, held: facilitator.heldNetworks() })}\n`);
    return {
      server,
      port,
      host,
      async close() {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await journal.close().catch(() => {});
        lock.release();
      },
    };
  } catch (error) {
    await journal.close().catch(() => {});
    lock.release();
    throw error;
  }
}

/** CLI の入口。終了 code を返す（0 = listen 中）。失敗の出力は固定の文言だけ。 */
export async function runCli(env: NodeJS.ProcessEnv, out: CliOutput, deps: MainDeps = {}): Promise<number> {
  try {
    await main(env, out, deps);
    return 0;
  } catch (error) {
    out.stderr(`evm-facilitator: ${error instanceof StartupError ? error.message : "startup_failed"}\n`);
    return 1;
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 運用者の補充 `raise-cap`（hosted 設計 §2.2）
 * ────────────────────────────────────────────────────────────────────────────── */

export const RAISE_CAP_USAGE = "usage: raise-cap --network <eip155:id> --add-wei <positive wei> --reason <text>";

export interface RaiseCapArgs {
  readonly network: string;
  readonly addWei: bigint;
  readonly reason: string;
}

/** 引数を読む（各 flag ちょうど 1 回、順不同）。違えば `StartupError`（`RAISE_CAP_USAGE`。値は出さない）。 */
export function raiseCapArgsOf(args: readonly string[]): RaiseCapArgs {
  const usage = (): never => {
    throw new StartupError(RAISE_CAP_USAGE);
  };
  const seen = new Map<string, string>();
  if (args.length !== 6) usage();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] as string;
    const value = args[i + 1] as string;
    if (!["--network", "--add-wei", "--reason"].includes(flag) || seen.has(flag)) usage();
    seen.set(flag, value);
  }
  const network = seen.get("--network");
  const addWei = seen.get("--add-wei");
  const reason = seen.get("--reason");
  if (network === undefined || !EVM_TESTNET_NETWORKS.has(network)) return usage();
  if (addWei === undefined || !POSITIVE_WEI.test(addWei)) return usage();
  if (!isValidReason(reason)) return usage();
  return { network, addWei: BigInt(addWei), reason };
}

/**
 * `raise-cap` の本体。env は `EVM_FACILITATOR_JOURNAL` だけを読む（鍵・token は読まない）。
 * facilitator と同じ lock を取る（= facilitator が止まっているときだけ書ける）。journal に その network の `gas_cap_init` が無ければ拒む。
 * `gas_cap_raise` を fsync で追記し、1 行の JSON を出す。失敗は固定の文言で終了 code 1。
 */
export async function runRaiseCap(args: readonly string[], env: NodeJS.ProcessEnv, out: CliOutput, deps: Pick<MainDeps, "lock"> & { readonly clock?: Clock } = {}): Promise<number> {
  try {
    const parsed = raiseCapArgsOf(args);
    const file = env["EVM_FACILITATOR_JOURNAL"];
    if (file === undefined || file === "") throw new StartupError("EVM_FACILITATOR_JOURNAL must be set");
    const noInit = `raise_cap_refused: the journal has no gas_cap_init for ${parsed.network}`;
    const lockPath = facilitatorLockPathOf(file);
    // journal のディレクトリが無ければ journal も無い（lock ファイルも作らない）。
    if (!existsSync(path.dirname(lockPath))) throw new StartupError(noInit);
    const lock = await orStartupError("lock_unavailable", () => (deps.lock ?? ((p: string) => acquireFacilitatorLock(p)))(lockPath));
    try {
      // lock を取ってから journal を見る（無い journal は作らない）。
      if (!existsSync(path.resolve(file))) throw new StartupError(noInit);
      const journal = createFileJournal(file);
      try {
        const records = await orStartupError("journal_unavailable", () => journal.load());
        checkGasJournal(records);
        let cap: bigint | undefined;
        for (const r of records) {
          if (r.type === "gas_cap_init" && r.network === parsed.network) cap = BigInt(r.capWei);
          if (r.type === "gas_cap_raise" && r.network === parsed.network && cap !== undefined) cap += BigInt(r.addWei);
        }
        if (cap === undefined) throw new StartupError(noInit);
        const at = (deps.clock ?? { now: () => Date.now() }).now();
        await orStartupError("journal_unavailable", () => journal.append({ type: "gas_cap_raise", network: parsed.network, addWei: parsed.addWei.toString(), reason: parsed.reason, at }));
        const effectiveCapWei = (cap + parsed.addWei).toString();
        out.stdout(`${JSON.stringify({ event: "cap_raised", network: parsed.network, addWei: parsed.addWei.toString(), effectiveCapWei })}\n`);
        return 0;
      } finally {
        await journal.close().catch(() => {});
      }
    } finally {
      lock.release();
    }
  } catch (error) {
    out.stderr(`evm-facilitator: ${error instanceof StartupError ? error.message : "raise_cap_failed"}\n`);
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
  if (process.argv[2] === "raise-cap") {
    // lock と journal を閉じた後は自然に終わる（`process.exit` は pipe の stdout を切り詰め得るので使わない）。
    void runRaiseCap(process.argv.slice(3), process.env, out).then((code) => {
      process.exitCode = code;
    });
  } else {
    void runCli(process.env, out).then((code) => {
      if (code !== 0) process.exit(code);
    });
  }
}
