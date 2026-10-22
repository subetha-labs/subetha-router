/**
 * 秘匿購入の **Payer 側**の手順（`docs/zktls-router-design.md` §2・§11、`docs/zktls-router-acceptance.md`）。**製品コードではない**（鍵を扱う Payer の起動側）。
 *
 * 2 回の起動で 1 件の購入:
 * 1. `--approve` なし: 封筒（lab の `payer-keygen` の注文 + 両レグの承認）→ quote。承認対象を `<out>/quote.json` に、再開に要る全部（quote 文書・ownerKey・requestId・注文）を
 *    `<out>/checkpoint.json`（0600）に書いて止まる。支払いも署名も無い。
 * 2. 同じ `--out` に `--approve`: checkpoint を**再開**する（keygen も quote もやり直さない）。`quote.json` が書き換えられていた・quote の期限が過ぎた・引数が違うときは拒む。
 *    受信 credential（EIP-3009、自分の鍵）→ purchase（引き渡し）→ `payer-finalize-order` → `executor-session`（実 MPC-TLS）→ `executor-prove` → attest → record（2 回・同一）→ `payer-decrypt`。
 * - `--recover`: checkpoint の ownerKey で status と record を読み直し、手元に bundle があれば復号する（応答を失ったとき・別プロセスから）。
 *   `--recover --chain [--rpc-url …] [--payer-address 0x…]`: さらに EIP-3009 `authorizationState` を 1 つの block で読み、両レグの「決済済み / 未使用で期限切れ / 未使用で期限前」を証跡に写す
 *   （`docs/zktls-router-thirdparty.md` §10.1。読取だけ。鍵は要らない。再実行はしない）。
 * - `--trust mozilla`（実 Provider）では **支払い範囲の記録**（`--scope-file`、AGENTS.md）が無いと走らない。`lab-fixture-ca` の証跡は synthetic。
 * - 鍵は env `SUBETHA_PAYER_PRIVATE_KEY` だけから読み、出力・証跡・例外に出さない。bearer は 0600 のファイル（`payment_header.json`・`order_final.json`）にだけ。
 * - 証跡 `evidence.json` は **5 つのゲートを別々に**、分かった時点で記録する（受信決済は引き渡し直後の status から。失敗しても分かっている分は残し、不明は `uncertain`）。
 *   既にある証跡は**単調に**しか更新しない（分かったことを消さない。`--recover` も同じ `evidence.json` に併合する）。承認が拒否された起動は証跡を触らず `refusals.json` に、
 *   回復・再復号の失敗は `recovery-log.json` に追記する。
 * - 署名・提出の**前**に再開点へ `purchaseAttempted` を書く（耐久の latch: 一時ファイルに書いて fsync → rename → ディレクトリを fsync。途中で止まっても前の再開点が残る）。
 *   以後の `--approve` は拒み、`--recover` に回す（応答を失っても二度署名しない）。
 *
 * usage: SUBETHA_PAYER_PRIVATE_KEY=0x… PRIVATE_PAYER_TOKEN=… npx tsx tools/private-payer.ts --router http://127.0.0.1:<port> --principal <id> --profile <profileId> \
 *          --method POST --host provider-x402-post.subethalabs.com --path /select --body-file body.json \
 *          --outbound-protocol x402 --outbound-network eip155:84532 --outbound-asset 0x036C… --outbound-pay-to 0x9014… --outbound-max-amount 10000 \
 *          --inbound-max-total 11000 --trust mozilla --scope-file runtime/private-live/<run>/scope.json --out runtime/private-live/<run> [--approve | --recover] [--connect 127.0.0.1:<port>]
 *
 * SubEtha V2 burn-sale の受信（`docs/zktls-router-v2-inbound.md` §4）: `--inbound-network eip155:11155111 --inbound-asset <zUSDC>` で quote すると、承認対象の
 *   `private.inbound.payTo` は注文別の burn address。人が別の道具（V2 harness）でその address に `total` を transfer してから、同じ --out で
 *   `--approve --burn-tx-hash 0x…` を実行する。credential は `{challengeNonce, burnTxHash}`（鍵も署名も要らない。資金は burn で既に動いている）。
 *   x402 受信（既定）に `--burn-tx-hash` を渡すと拒む。subetha 受信に `--burn-tx-hash` が無ければ拒む（latch の前なので何も起きない）。
 * 第三者 Provider（公開 GET、`docs/zktls-router-thirdparty.md` §4.2）: `--provider-file <provider.json>`（`tools/private-provider-precheck.ts` の出力）が
 * `--method/--host/--path/--outbound-*` の代わりになる（**排他**: 両方あれば拒否。転記しない）。ファイルの sha256 は証跡の `providerFileSha256` に入る。
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { encodeFunctionData, parseAbi } from "viem";

import { createRouterClient } from "../src/client/index.js";
import type { PrivateHandoverView, PrivateQuoteView, RouterClient } from "../src/client/types.js";
import type { PrivateRouterClient } from "../src/client/types.js";
import { parseProviderFile } from "./private-provider-precheck.js";
import { createX402Payer } from "./x402-payer.js";

export const PRIVATE_INBOUND_NETWORK = "eip155:84532";
export const PRIVATE_INBOUND_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** SubEtha V2 burn-sale の受信（`src/adapters/inbound/subetha.ts`）の offer scheme。credential は `{challengeNonce, burnTxHash}`。 */
const SUBETHA_SCHEME = "subetha-zerc20";
/** x402（EIP-3009）の受信 offer の scheme。この 2 つ以外の scheme の再開点は承認しない（署名にも latch にも進まない）。 */
const X402_SCHEME = "exact";
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const CHECKPOINT_FILE = "checkpoint.json";
const CHECKPOINT_VERSION = "private-payer-checkpoint-v1";

export interface PrivatePayerOptions {
  readonly routerBaseUrl: string;
  readonly principalId: string;
  readonly token: string;
  readonly profileId: string;
  readonly labDir?: string;
  readonly srsPath?: string;
  readonly method: "GET" | "POST";
  readonly host: string;
  readonly path: string;
  /** POST の承認済み本文（そのままのバイト列。Router には渡らない）。 */
  readonly bodyFile?: string;
  readonly outbound: { readonly protocol: "x402" | "mpp"; readonly network: string; readonly asset: string; readonly payTo: string; readonly maxAmount: string };
  /** `withProviderFile` が入れる: 事前互換検査の `provider.json` の sha256（証跡と再開点の `args` に写す。値の出所の記録。承認・回復で違えば拒む）。 */
  readonly providerFileSha256?: string;
  /** `withProviderFile` が入れる: `provider.json` が試験の差し替え（`--ca`/`--connect`）で得た synthetic な観測なら true（`mozilla` では拒む）。 */
  readonly providerSynthetic?: boolean;
  /** `withProviderFile` が入れる: 事前検査の `warnings`（不適合の兆候。固定文）。quote のときにログに出す。合否は変えない。 */
  readonly providerWarnings?: readonly string[];
  /** 受信（既定は Base Sepolia USDC、x402）。SubEtha V2 burn-sale は `{ network: "eip155:11155111", asset: <zUSDC>, maxTotal }`。 */
  readonly inbound?: { readonly network: string; readonly asset: string; readonly maxTotal: string };
  readonly trust: "mozilla" | "lab-fixture-ca";
  /** 試験だけ: executor の TCP の行き先（loopback の fixture）。`mozilla` では使えない。 */
  readonly connect?: string;
  readonly outDir: string;
  /** x402 受信（EIP-3009）の署名鍵。subetha 受信では要らない（credential は burn の tx hash）。x402 受信で無ければ承認の前に拒む。 */
  readonly payerPrivateKey?: string;
  /** subetha 受信の承認だけ: 人が注文別 burn address へ払った transfer の tx hash（0x + 64 hex）。credential に載せる。x402 受信では拒む。 */
  readonly burnTxHash?: string;
  /** false: quote で止まる（checkpoint を書く）。true: 同じ `outDir` の checkpoint を再開して最後まで。 */
  readonly approve: boolean;
  /** 実 Provider（`mozilla`）で必須: 支払い範囲の記録（JSON）。sha256 を証跡に書く。 */
  readonly scopeFile?: string;
  readonly requestId?: string;
  readonly sessionTimeoutSecs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** **診断専用**: 引き渡しで止める（executor を走らせない。Router 側はその購入を期限で `unknown` にする）。Provider の応答を直接観察するときだけ。 */
  readonly stopAfterHandover?: boolean;
  /** **試験専用**: 耐久書き込みの故障注入（段ごと）と、latch の後で止める（割り込みの再現）。 */
  readonly hooksForTest?: DurableHooksForTest & { readonly afterLatch?: () => void };
}

/** **試験専用**: `writeDurable` の各段で失敗させる。`true` を返した段で例外になる。 */
export interface DurableHooksForTest {
  readonly durableFail?: (stage: "write" | "fsync" | "rename" | "dirfsync", file: string) => boolean;
}

export interface PrivatePayerEvidence {
  readonly runId: string;
  readonly startedAt: string;
  readonly trust: "mozilla" | "lab-fixture-ca";
  /** fixture CA の証跡は synthetic（公開 PKI の受入の代わりにならない）。 */
  readonly synthetic: boolean;
  readonly provider: { readonly method: string; readonly host: string; readonly path: string };
  scopeFileSha256?: string;
  /** 第三者 Provider: 封筒の値の出所（`provider.json` の sha256）。 */
  providerFileSha256?: string;
  /** `--recover --chain`（thirdparty §10.1）: 1 つの block で読んだ EIP-3009 `authorizationState` の事実だけ（推定しない）。 */
  chain?: ChainEvidence;
  intentSha256?: string;
  orderId?: string;
  paymentId?: string;
  /** どこまで進んだか（失敗したときはその段）。 */
  stage?: string;
  /** Router の最後に読めた状態（best effort）。 */
  routerStatus?: { status?: string; terminalReason?: string };
  /** 5 つのゲート（別々）。`uncertain: true` は「分からない」（払ったかもしれない）。 */
  readonly gates: {
    inbound_settlement: { settled: boolean; txRef?: string; eventId?: string; uncertain?: true; chain?: ChainLegVerdict; chainTxRef?: string; /** subetha 受信: credential に載せた burn の tx hash（小文字。facilitator が確定した `txRef` とは別の欄）。 */ claimedTxRef?: string };
    outbound_settlement: { issued: boolean; txRef?: string; receipt: boolean; uncertain?: true; chain?: ChainLegVerdict; chainTxRef?: string };
    private_delivery: { status?: string; terminalReason?: string; proof?: unknown; recordSha256?: string; recordRepeatable?: boolean };
    payer_receipt: { ok: boolean; verifiedBundleBeforeDecrypt?: boolean; decryptedSha256?: string; payloadLen?: number; failedStage?: string };
    finality: { checked: false; note: string };
  };
}

/**
 * チェーン読取の結論（レグごと。thirdparty §10.1）。`settled` = `AuthorizationUsed(authorizer, nonce)` の tx に期待どおりの `Transfer(authorizer → payTo, amount)` がある（決済の証明）。
 * `canceled` = `AuthorizationCanceled` が見つかった。`used_unlocated` = `authorizationState` は true（使用または取消）だがログを特定できない（不確実のまま）。
 * `unused` = その block 時点で未使用（期限前。まだ使われ得る）。`unused_expired` = その block 時点で未使用かつ `validBefore` を過ぎた（finality の確認ではない）。
 */
export type ChainLegVerdict = "settled" | "canceled" | "used_unlocated" | "unused" | "unused_expired";
export interface ChainLegEvidence {
  readonly authorizer: string;
  /** 受信: 再開点に署名の前に書いたアドレス（`checkpoint`）か、古い再開点で operator が与えた未検証のもの（`operator_unverified`）。送信: 手元の header の `from`（`header`）。 */
  readonly authorizerSource: "checkpoint" | "operator_unverified" | "header";
  readonly nonce: string;
  readonly state: "unused" | "used_or_canceled";
  readonly verdict: ChainLegVerdict;
  readonly validBefore: number;
  readonly expired: boolean;
  readonly txRef?: string;
  readonly txBlock?: number;
}
export interface ChainEvidence {
  readonly readAt: string;
  readonly rpcHost: string;
  readonly chainId: number;
  readonly block: { readonly number: number; readonly hash: string; readonly time: number };
  inbound?: ChainLegEvidence;
  outbound?: ChainLegEvidence;
  /** 読まなかった理由（固定語）。 */
  skipped?: { inbound?: string; outbound?: string };
}
/** RPC の読取の抽象（試験では差し替える。外部ネットワーク無しで判定を試す）。 */
export interface ChainReader {
  chainId(): Promise<number>;
  latestBlock(): Promise<{ number: number; hash: string; timestamp: number }>;
  /** 読取の後に同じ番号の block を読み直して hash を照合する（reorg の検出）。 */
  blockByNumber(block: number): Promise<{ number: number; hash: string; timestamp: number }>;
  /** `authorizationState(authorizer, nonce)` を **block hash で固定して**（EIP-1898）読む。 */
  authorizationState(asset: string, authorizer: string, nonce: string, blockHash: string): Promise<boolean>;
  /** `AuthorizationUsed` / `AuthorizationCanceled` の (authorizer, nonce) のログ（資産 contract 発）を [fromBlock, toBlock] で探す。 */
  findAuthorization(asset: string, authorizer: string, nonce: string, fromBlock: number, toBlock: number): Promise<readonly { kind: "used" | "canceled"; txHash: string; block: number; blockHash: string }[]>;
  /** その tx の receipt（成功したものだけ）のログ列を**順序どおり**（contract のアドレス・topics・data）。失敗した tx や無い tx は `undefined`。 */
  receiptLogsOf(txHash: string): Promise<{ blockHash: string; logs: readonly { address: string; topics: readonly string[]; data: string }[] } | undefined>;
}
/** 1 レグの読取の入力（quote と手元の header から組む。推定しない）。 */
export interface ChainLegInput {
  readonly authorizer: string;
  readonly authorizerSource: ChainLegEvidence["authorizerSource"];
  readonly nonce: string;
  readonly validBefore: number;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: bigint;
  /** 探索の下限の目安（quote の作成時刻、ms）。 */
  readonly notBeforeMs: number;
}

export type PrivatePayerRun =
  | { readonly ok: true; readonly stage: "quoted"; readonly quote: PrivateQuoteView; readonly evidence: PrivatePayerEvidence }
  | { readonly ok: true; readonly stage: "delivered"; readonly paymentId: string; readonly plaintext: Buffer; readonly evidence: PrivatePayerEvidence; readonly files: { readonly outDir: string; readonly decrypt: string } }
  | { readonly ok: false; readonly stage: string; readonly reason: string; readonly evidence: PrivatePayerEvidence };

/** quote で止まったときに書く再開点（0600）。ownerKey を含む（表示・保存の対象ではないが、再開と回復に要る）。 */
interface Checkpoint {
  readonly version: typeof CHECKPOINT_VERSION;
  readonly createdAt: string;
  readonly requestId: string;
  readonly quote: PrivateQuoteView;
  readonly quoteFileSha256: string;
  readonly intentSha256: string;
  readonly orderId: string;
  readonly args: { readonly routerBaseUrl: string; readonly principalId: string; readonly profileId: string; readonly method: string; readonly host: string; readonly path: string; readonly outbound: PrivatePayerOptions["outbound"]; readonly inbound: NonNullable<PrivatePayerOptions["inbound"]>; readonly trust: string; readonly providerFileSha256?: string };
  /** 進んだ段（再開・回復の判断用）。 */
  progress?: { paymentId?: string; purchaseAttempted?: boolean; handedOver?: boolean; sessionDone?: boolean; attested?: boolean; payerAddress?: string; /** subetha 受信: credential に載せた burn の tx hash（小文字）。 */ burnTxHash?: string };
}

export function defaultLabDir(): string {
  return process.env["SUBETHA_ZKTLS_LAB_DIR"] ?? path.join(os.homedir(), ".worktrees/subetha-zktls-router/private-payment-binding-20261017");
}
export function defaultSrsPath(): string {
  return process.env["SUBETHA_ZKTLS_SRS_DAT"] ?? path.join(os.homedir(), ".hermes/research/subetha-zktls-delivery-spike/tools/srs/bn254_g1.dat");
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function writePrivate(file: string, bytes: Buffer | string): void {
  writeFileSync(file, bytes, { mode: 0o600 });
}
/** 耐久の書き込み（再開点・証跡）: 一時ファイル（0600）に書いて fsync → rename → 親ディレクトリを fsync。rename の前に失敗すれば前のファイルが残り、rename の後（ディレクトリの fsync）で失敗すれば新しい内容が置かれたまま（呼び出し側は保守的に扱う）。 */
function writeDurable(file: string, bytes: Buffer | string, hooks?: DurableHooksForTest): void {
  const tmp = `${file}.tmp`;
  const fail = (stage: "write" | "fsync" | "rename" | "dirfsync"): void => {
    if (hooks?.durableFail?.(stage, file) === true) throw new Error(`durable write failed at ${stage}`);
  };
  const fd = openSync(tmp, "w", 0o600);
  try {
    fail("write");
    writeFileSync(fd, bytes);
    fail("fsync");
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // 残骸は残さない（残っても次回が上書きする）。
    }
    throw error;
  }
  closeSync(fd);
  try {
    fail("rename");
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // 残っても次回の書き込みが上書きする。
    }
    throw error;
  }
  const dir = openSync(path.dirname(file), "r");
  try {
    fail("dirfsync");
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
/**
 * lab バイナリを別プロセスで。stdout/stderr は `<logDir>/lab-<stage>.log`（0600）に残す（原因の調査用。lab のログは固定文だが bearer を含み得る前提で outDir と同じ扱い）。
 */
function runBinary(bin: string, srs: string, args: readonly string[], timeoutMs: number, logFile?: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, [...args], { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", DELIVERY_SRS_DAT: srs, RUST_LOG: "info" }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
      if (logFile !== undefined) {
        try {
          writePrivate(logFile, `# exit ${String(code)}\n# stdout\n${String(stdout)}\n# stderr\n${String(stderr)}\n`);
        } catch {
          // ログが書けなくても結果は返す。
        }
      }
      resolve({ code, stderr: String(stderr) });
    });
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

/** 封筒（設計 §5.1）: compact JSON。`order` は lab の `payer-keygen` が書いた注文そのもの。 */
export function envelopeBytesOf(order: unknown, outbound: PrivatePayerOptions["outbound"], inbound: NonNullable<PrivatePayerOptions["inbound"]>): Buffer {
  return Buffer.from(JSON.stringify({ version: "phase5-intent-v1", order, outbound: { protocol: outbound.protocol, network: outbound.network, asset: outbound.asset, payTo: outbound.payTo, maxAmount: outbound.maxAmount }, inbound: { network: inbound.network, asset: inbound.asset, maxTotal: inbound.maxTotal } }), "utf8");
}

/** 提出したが結果が分からない: 両決済を不確実にする。既にある欄（申告した burn の `claimedTxRef` など）は消さない。 */
function markBothUncertain(evidence: PrivatePayerEvidence): void {
  evidence.gates.inbound_settlement = { ...evidence.gates.inbound_settlement, settled: false, uncertain: true };
  evidence.gates.outbound_settlement = { ...evidence.gates.outbound_settlement, issued: false, receipt: false, uncertain: true };
}

/** subetha burn-sale の受信 credential（`src/adapters/inbound/subetha.ts` の preflight と同じ形: `accepted` は offer の完全一致、`payload.challengeNonce` は offer の nonce）。base64。 */
export function subethaCredentialOf(offer: Record<string, unknown>, burnTxHash: string): string {
  const extra = offer["extra"] as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: offer, payload: { challengeNonce: extra["challengeNonce"], burnTxHash } }), "utf8").toString("base64");
}

/** quote の受信が「credential の前に人が払う」（subetha burn-sale）なら、払う先と額（承認対象 `private.inbound` の写し）。x402 受信では `undefined`。 */
export function payFirstOf(quote: PrivateQuoteView): { payTo: string; amount: string; network: string; asset: string } | undefined {
  const inbound = (quote as unknown as { private?: { inbound?: Record<string, unknown> } }).private?.inbound;
  if (inbound === undefined || inbound["fundsMoveAt"] !== "payer_burn_before_credential") return undefined;
  const payTo = inbound["payTo"];
  const amount = inbound["total"];
  const network = inbound["network"];
  const asset = inbound["asset"];
  if (typeof payTo !== "string" || typeof amount !== "string" || typeof network !== "string" || typeof asset !== "string") return undefined;
  return { payTo, amount, network, asset };
}

/** 第三者 Provider の値を事前互換検査の `provider.json` から**そのまま**取る（手入力の代わり。`docs/zktls-router-thirdparty.md` §4.2）。読めない・形が違えば `undefined`。 */
export function withProviderFile<T extends object>(file: string, options: T): (T & Pick<PrivatePayerOptions, "method" | "host" | "path" | "outbound" | "providerFileSha256" | "providerSynthetic" | "providerWarnings">) | undefined {
  // 1 回だけ読み、**同じバイト列**を検査して sha256 を取る（読み直しの間の差し替えで値と digest が食い違わない）。
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return undefined;
  }
  const provider = parseProviderFile(bytes);
  if (provider === undefined) return undefined;
  return { ...options, method: provider.method, host: provider.host, path: provider.path, outbound: { ...provider.outbound }, providerFileSha256: sha256Hex(bytes), providerSynthetic: provider.observed.synthetic, ...(provider.warnings === undefined || provider.warnings.length === 0 ? {} : { providerWarnings: [...provider.warnings] }) };
}

function newEvidence(options: { readonly trust: "mozilla" | "lab-fixture-ca"; readonly method: string; readonly host: string; readonly path: string }): PrivatePayerEvidence {
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  return {
    runId,
    startedAt: new Date().toISOString(),
    trust: options.trust,
    synthetic: options.trust !== "mozilla",
    provider: { method: options.method, host: options.host, path: options.path },
    gates: {
      inbound_settlement: { settled: false },
      outbound_settlement: { issued: false, receipt: false },
      private_delivery: {},
      payer_receipt: { ok: false },
      finality: { checked: false, note: "on-chain finality is not checked by the Router or this tool (v1); read both chains separately" },
    },
  };
}

/** 既にある証跡を読む（無ければ新規）。ゲートは単調にしか進めない（分かったことを消さない）。 */
function loadEvidence(outDir: string, fresh: PrivatePayerEvidence): PrivatePayerEvidence {
  const file = path.join(outDir, "evidence.json");
  if (!existsSync(file)) return fresh;
  try {
    const previous = JSON.parse(readFileSync(file, "utf8")) as PrivatePayerEvidence;
    return { ...previous, runId: fresh.runId, startedAt: fresh.startedAt, gates: { ...fresh.gates, ...previous.gates } };
  } catch {
    return fresh;
  }
}
/** 復号の結果を単調に併合する: 既に `ok: true` なら失敗で上書きしない（失敗は `recovery-log.json` へ）。 */
function mergePayerReceipt(evidence: PrivatePayerEvidence, result: PrivatePayerEvidence["gates"]["payer_receipt"], outDir: string): void {
  if (evidence.gates.payer_receipt.ok && !result.ok) {
    recordLog(outDir, "recovery-log.json", "decrypt", `repeat decryption failed (${result.failedStage ?? "unknown"}); established receipt kept`);
    return;
  }
  evidence.gates.payer_receipt = result;
}
/** 追記の記録（拒否・回復の失敗）。証跡を上書きしない。 */
function recordLog(outDir: string, name: string, stage: string, reason: string): void {
  const file = path.join(outDir, name);
  let entries: unknown[] = [];
  try {
    if (existsSync(file)) entries = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  } catch {
    entries = [];
  }
  entries.push({ at: new Date().toISOString(), stage, reason });
  writeDurable(file, `${JSON.stringify(entries, null, 2)}\n`);
}
/** 承認が拒否された起動の記録（証跡とは別。証跡を上書きしない）。 */
function recordRefusal(outDir: string, stage: string, reason: string): void {
  recordLog(outDir, "refusals.json", stage, reason);
}

/** Router の status（読み取り専用）から分かるゲートを証跡に写す。失敗しても投げない。 */
async function fillFromStatus(client: Pick<RouterClient & PrivateRouterClient, "status">, paymentId: string, ownerKey: string, evidence: PrivatePayerEvidence): Promise<void> {
  try {
    const status = await client.status(paymentId, ownerKey);
    if (!status.found) return;
    const projection = status.projection as unknown as { status?: string; terminalReason?: string; source?: { txRef?: string; eventId?: string }; destination?: { txRef?: string }; private?: { outbound?: { issued?: boolean } } };
    evidence.routerStatus = { ...(projection.status === undefined ? {} : { status: projection.status }), ...(projection.terminalReason === undefined ? {} : { terminalReason: projection.terminalReason }) };
    if (projection.source?.txRef !== undefined) {
      // 既存の欄（chain の結論など）を保って併合する。
      const { uncertain: _u, ...rest } = evidence.gates.inbound_settlement;
      evidence.gates.inbound_settlement = { ...rest, settled: true, txRef: projection.source.txRef, ...(projection.source.eventId === undefined ? {} : { eventId: projection.source.eventId }) };
    }
    if (projection.private?.outbound?.issued === true) {
      // 発行済みは決済の確立ではない: `uncertain` は外さない（外すのは領収の txRef か chain の settled だけ）。
      evidence.gates.outbound_settlement = { ...evidence.gates.outbound_settlement, issued: true };
    }
    if (projection.destination?.txRef !== undefined) {
      const { uncertain: _u, ...rest } = evidence.gates.outbound_settlement;
      evidence.gates.outbound_settlement = { ...rest, issued: true, txRef: projection.destination.txRef, receipt: true };
    }
  } catch {
    // 読めない: 証跡はそのまま（分からないものは分からないまま）。
  }
}

function readCheckpoint(outDir: string): Checkpoint | undefined {
  const file = path.join(outDir, CHECKPOINT_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Checkpoint;
  return parsed.version === CHECKPOINT_VERSION ? parsed : undefined;
}
function writeCheckpoint(outDir: string, checkpoint: Checkpoint, hooks?: DurableHooksForTest): void {
  writeDurable(path.join(outDir, CHECKPOINT_FILE), `${JSON.stringify(checkpoint, null, 2)}\n`, hooks);
}
function argsOf(options: PrivatePayerOptions, inbound: NonNullable<PrivatePayerOptions["inbound"]>): Checkpoint["args"] {
  return { routerBaseUrl: options.routerBaseUrl, principalId: options.principalId, profileId: options.profileId, method: options.method, host: options.host, path: options.path, outbound: options.outbound, inbound, trust: options.trust, ...(options.providerFileSha256 === undefined ? {} : { providerFileSha256: options.providerFileSha256 }) };
}

export async function runPrivatePayer(options: PrivatePayerOptions): Promise<PrivatePayerRun> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const labDir = options.labDir ?? defaultLabDir();
  const bin = path.join(labDir, "phase5/runner/target/release/delivery");
  const srs = options.srsPath ?? defaultSrsPath();
  const inbound = options.inbound ?? { network: PRIVATE_INBOUND_NETWORK, asset: PRIVATE_INBOUND_ASSET, maxTotal: String(BigInt(options.outbound.maxAmount) + 1000n) };
  mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
  const evidence = loadEvidence(options.outDir, newEvidence(options));
  const persistEvidence = (): void => writeDurable(path.join(options.outDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  /** 購入に触れる前の拒否（前提・再開点の検査）は証跡を上書きしない。 */
  const REFUSAL_STAGES = new Set(["prerequisites", "review", "approve", "keygen", "quote"]);
  const fail = (stage: string, reason: string): PrivatePayerRun => {
    log(`private-payer: ${stage}: ${reason}`);
    if (REFUSAL_STAGES.has(stage) && existsSync(path.join(options.outDir, "evidence.json"))) {
      recordRefusal(options.outDir, stage, reason);
      return { ok: false, stage, reason, evidence };
    }
    evidence.stage = stage;
    persistEvidence();
    return { ok: false, stage, reason, evidence };
  };

  // 0. 前提: バイナリ・SRS、支払い範囲の記録（実 Provider）。
  if (!existsSync(bin) || !existsSync(srs)) return fail("prerequisites", "lab delivery binary or SRS not found (SUBETHA_ZKTLS_LAB_DIR / SUBETHA_ZKTLS_SRS_DAT)");
  if (options.trust === "mozilla") {
    if (options.connect !== undefined) return fail("prerequisites", "--connect is a fixture-only option and cannot be used with --trust mozilla");
    if (options.scopeFile === undefined || !existsSync(options.scopeFile)) return fail("prerequisites", "a payment scope record (--scope-file) is required before any live payment (AGENTS.md)");
    evidence.scopeFileSha256 = sha256Hex(readFileSync(options.scopeFile));
  }
  const inboundIsSubetha = inbound.network !== PRIVATE_INBOUND_NETWORK || inbound.asset.toLowerCase() !== PRIVATE_INBOUND_ASSET.toLowerCase();
  if (options.payerPrivateKey !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(options.payerPrivateKey)) return fail("prerequisites", "SUBETHA_PAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
  if (!inboundIsSubetha && options.payerPrivateKey === undefined) return fail("prerequisites", "SUBETHA_PAYER_PRIVATE_KEY is required for an x402 inbound (env only)");
  if (!inboundIsSubetha && options.burnTxHash !== undefined) return fail("prerequisites", "--burn-tx-hash applies only to a SubEtha burn-sale inbound (--inbound-network/--inbound-asset)");
  if (options.burnTxHash !== undefined && !TX_HASH_RE.test(options.burnTxHash)) return fail("prerequisites", "--burn-tx-hash must be a 0x-prefixed 32-byte transaction hash");
  if (options.trust === "mozilla" && options.providerSynthetic === true) return fail("prerequisites", "the provider file holds a synthetic pre-check (test CA / loopback override); re-run tools/private-provider-precheck.ts against the public host before a live purchase");
  // 承認は別の起動で再開するので、client が自分で発行した quote でなくても受け付ける（`allowUnissuedQuotes`: client は自分の控えとの照合を飛ばす。
  // 読んだ quote が買われることの保証は、この道具の再開点（0600 のローカルの権威。`quote.json` の sha256 で改変を検出）と Router 側の束縛の検査による）。
  const client = createRouterClient({ baseUrl: options.routerBaseUrl, principalId: options.principalId, token: options.token, allowUnissuedQuotes: true });
  const keys = path.join(options.outDir, "keys");
  const exec = path.join(options.outDir, "executor");
  const intentFile = path.join(options.outDir, "intent.json");
  const quoteFile = path.join(options.outDir, "quote.json");

  let checkpoint: Checkpoint;
  if (!options.approve) {
    // 1. keygen（Payer の鍵・salt・注文の骨格。本文は Payer の手元にだけ）→ 封筒 → quote → checkpoint。何も払わない。
    if (existsSync(path.join(options.outDir, CHECKPOINT_FILE))) return fail("review", "this --out already holds a reviewed quote; use --approve to continue it or a new --out to quote again");
    // 事前検査の不適合の兆候（例: 402 が chunked / 非 identity の encoding）は keygen・quote の前に人に見せる。止めはしない（合否は払うまで分からない。open-items §A-4）。
    for (const warning of options.providerWarnings ?? []) log(`private-payer: provider warning: ${warning}`);
    mkdirSync(path.join(exec, "private_inbox"), { recursive: true, mode: 0o700 });
    const orderId = `${"0".repeat(32)}${randomBytes(16).toString("hex")}`;
    const keygenArgs = ["payer-keygen", "--payer-dir", keys, "--order-id", orderId, "--host", options.host, "--port", "443", "--path", options.path];
    if (options.method === "POST") {
      if (options.bodyFile === undefined) return fail("keygen", "--body-file is required for POST");
      keygenArgs.push("--post-profile", "canonical", "--body-file", options.bodyFile);
    } else {
      keygenArgs.push("--method", "GET");
    }
    const keygen = await runBinary(bin, srs, keygenArgs, 60_000, path.join(options.outDir, "lab-keygen.log"));
    if (keygen.code !== 0) return fail("keygen", "payer-keygen failed (see lab binary stderr; not recorded)");
    const order = JSON.parse(readFileSync(path.join(keys, "order.json"), "utf8")) as unknown;
    const intentBytes = envelopeBytesOf(order, options.outbound, inbound);
    evidence.intentSha256 = sha256Hex(intentBytes);
    evidence.orderId = orderId;
    writePrivate(intentFile, intentBytes);
    const requestId = options.requestId ?? `pp-${evidence.runId}`;
    // 出所の記録（provider.json の sha256）は quote のときに証跡へ。承認では再開点の args と一致したときだけ（拒否の応答に別の digest を載せない）。
    if (options.providerFileSha256 !== undefined) evidence.providerFileSha256 = options.providerFileSha256;
    const quoted = await client.privateQuote({ profileId: options.profileId, requestId, intentB64: intentBytes.toString("base64") });
    if (!quoted.ok) return fail("quote", `${quoted.error}${quoted.reason === undefined ? "" : ` (${quoted.reason})`}`);
    const quote = quoted.quote;
    evidence.paymentId = quote.paymentId;
    // 承認対象（ownerKey は除く: 持ち主の証明は表示の対象ではない。再開・回復のために checkpoint にだけ持つ）。
    const { ownerKey: _ownerKey, ...subject } = quote;
    const quoteText = `${JSON.stringify(subject, null, 2)}\n`;
    writePrivate(quoteFile, quoteText);
    checkpoint = { version: CHECKPOINT_VERSION, createdAt: new Date().toISOString(), requestId, quote, quoteFileSha256: sha256Hex(quoteText), intentSha256: evidence.intentSha256, orderId, args: argsOf(options, inbound), progress: { paymentId: quote.paymentId } };
    writeCheckpoint(options.outDir, checkpoint);
    evidence.stage = "quoted";
    persistEvidence();
    const payFirst = payFirstOf(quote);
    log(`private-payer: quoted paymentId=${quote.paymentId} intentSha256=${evidence.intentSha256} total=${String((quote.pricing as Record<string, unknown>)["total"])}${payFirst === undefined ? "" : ` payFirst=${payFirst.amount} ${payFirst.asset}@${payFirst.network} to ${payFirst.payTo} (burn-sale: transfer first, then --approve --burn-tx-hash)`} (review ${quoteFile}, then re-run with --approve)`);
    return { ok: true, stage: "quoted", quote, evidence };
  }

  // 2. 承認: 同じ --out の checkpoint を再開する（keygen・quote はやり直さない）。
  const found = readCheckpoint(options.outDir);
  if (found === undefined) return fail("approve", "no reviewed quote in --out (run once without --approve, review quote.json, then re-run with --approve in the same --out)");
  checkpoint = found;
  // burn の tx hash が渡された承認の拒否は「新しい --out で quote し直せ」と言わない: その transfer は拒否で戻らない。先に照合（quote の burn address・V2 の台帳・Sepolia の receipt）。
  const burnNote = options.burnTxHash === undefined ? "" : "; a burn tx hash was supplied: this refusal does not reverse that transfer and the old order's burn address cannot be reused — reconcile it against the reviewed quote's burn address (quote.json private.inbound.payTo, V2 ledger, Sepolia receipt) with the operator before any new payment, and never pay again on this refusal alone";
  const requote = options.burnTxHash === undefined ? "; quote again in a new --out" : "";
  if (stableJson(checkpoint.args) !== stableJson(argsOf(options, inbound))) return fail("approve", `the arguments differ from the reviewed quote (router/principal/profile/method/host/path/outbound/inbound/trust)${requote}${burnNote}`);
  if (!existsSync(quoteFile) || sha256Hex(readFileSync(quoteFile)) !== checkpoint.quoteFileSha256) return fail("approve", `quote.json was modified or removed after the review${requote}${burnNote}`);
  if (checkpoint.progress?.handedOver === true) return fail("approve", "this purchase was already handed over; use --recover to read its status/record");
  if (checkpoint.progress?.purchaseAttempted === true) return fail("approve", "a purchase was already attempted for this quote (its outcome may be unknown); never re-sign — use --recover to read status/record");
  const quote = checkpoint.quote;
  if (now() >= quote.approval.deadlineMs) return fail("approve", `the reviewed quote has expired${options.burnTxHash === undefined ? "; quote again in a new --out and review it again" : burnNote}`);
  // 受信レールと入力の整合（latch の前。ここで拒んでも何も起きていない）。再開点の offer の scheme が権威: subetha-zerc20 と exact（x402）だけ。ほかは署名にも latch にも進まない。
  const offer = (isRecord(quote.source) && isRecord(quote.source["offer"]) ? quote.source["offer"] : undefined) as ({ scheme?: unknown; network?: unknown; extra?: unknown } & Record<string, unknown>) | undefined;
  const offerExtra = offer !== undefined && isRecord(offer.extra) ? offer.extra : undefined;
  if (offer === undefined || offerExtra === undefined || typeof offer.network !== "string") return fail("approve", `the reviewed quote's offer is malformed (no offer, extra or network); nothing was signed or submitted${burnNote}`);
  const offerIsSubetha = offer.scheme === SUBETHA_SCHEME;
  if (!offerIsSubetha && offer.scheme !== X402_SCHEME) return fail("approve", `the reviewed quote's inbound scheme is not supported by this tool (expected ${X402_SCHEME} or ${SUBETHA_SCHEME}); nothing was signed or submitted${burnNote}`);
  if (offerIsSubetha && options.burnTxHash === undefined) return fail("approve", "this quote's inbound is a SubEtha burn-sale: transfer the quoted amount to the per-quote burn address (quote.json private.inbound.payTo) first, then re-run with --approve --burn-tx-hash 0x…");
  if (offerIsSubetha && typeof offerExtra["challengeNonce"] !== "string") return fail("approve", `the reviewed quote's offer has no challengeNonce; nothing was signed or submitted${burnNote}`);
  if (!offerIsSubetha && options.burnTxHash !== undefined) return fail("approve", "--burn-tx-hash applies only to a SubEtha burn-sale inbound; this quote's inbound is x402 (nothing was signed or submitted)");
  if (!offerIsSubetha && options.payerPrivateKey === undefined) return fail("approve", "SUBETHA_PAYER_PRIVATE_KEY is required for an x402 inbound (env only)");
  if (checkpoint.args.providerFileSha256 !== undefined) evidence.providerFileSha256 = checkpoint.args.providerFileSha256;
  evidence.intentSha256 = checkpoint.intentSha256;
  evidence.orderId = checkpoint.orderId;
  evidence.paymentId = quote.paymentId;
  const requestId = checkpoint.requestId;
  mkdirSync(path.join(exec, "private_inbox"), { recursive: true, mode: 0o700 });

  // 3. 署名・提出の前に耐久の latch（応答を失っても、以後の承認は拒み --recover に回す）。latch が耐久に書けなければ署名しない（前の再開点はそのまま残る）。
  checkpoint.progress = { ...checkpoint.progress, paymentId: quote.paymentId, purchaseAttempted: true };
  try {
    writeCheckpoint(options.outDir, checkpoint, options.hooksForTest);
  } catch {
    return fail("approve", "the purchase-attempt latch could not be written durably; nothing was signed or submitted (if the latched checkpoint was installed before the failure, later --approve is refused: use --recover; otherwise retry when the disk is writable)");
  }
  evidence.stage = "purchase";
  persistEvidence();
  options.hooksForTest?.afterLatch?.();
  let credential: string;
  if (offerIsSubetha) {
    // 受信 credential（subetha burn-sale）: 承認した offer そのもの + {challengeNonce, burnTxHash}。資金は人の burn で既に動いている（Router の settle は facilitator の確認）。
    const burnTxHash = options.burnTxHash!.toLowerCase();
    checkpoint.progress = { ...checkpoint.progress, burnTxHash };
    writeCheckpoint(options.outDir, checkpoint);
    evidence.gates.inbound_settlement = { ...evidence.gates.inbound_settlement, claimedTxRef: burnTxHash };
    credential = subethaCredentialOf(offer as Record<string, unknown>, burnTxHash);
  } else {
    // 受信 credential（自分の鍵。EIP-3009。資金はこの後の Router の settle で動く）。
    const chainId = Number(String(offer.network).replace(/^eip155:/, ""));
    const payer = createX402Payer(options.payerPrivateKey!);
    // 回復時のチェーン読取（§10.1）のために **アドレスだけ** を再開点に残す（鍵は残さない）。
    checkpoint.progress = { ...checkpoint.progress, payerAddress: payer.address };
    writeCheckpoint(options.outDir, checkpoint);
    credential = await payer.credentialFor(offer as never, chainId);
  }

  // 4. purchase → 引き渡し。応答を失ったら「払ったかもしれない」。
  let purchased: Awaited<ReturnType<typeof client.privatePurchase>>;
  try {
    purchased = await client.privatePurchase({ quote, requestId, approval: { approved: true, quoteId: quote.quoteId }, credential });
  } catch {
    markBothUncertain(evidence);
    await fillFromStatus(client, quote.paymentId, quote.ownerKey, evidence);
    return fail("purchase", "the purchase response was lost (transport); the Router may have settled the inbound leg — read status with --recover, do not re-pay");
  }
  if (purchased.outcome !== "awaiting_session") {
    const detail = "reason" in purchased ? purchased.reason : "error" in purchased ? purchased.error : purchased.outcome;
    if (purchased.outcome === "unknown") markBothUncertain(evidence);
    await fillFromStatus(client, quote.paymentId, quote.ownerKey, evidence);
    // unknown は「払ったかもしれない」。再試行しない。
    return fail("purchase", `${purchased.outcome}: ${String(detail)}`);
  }
  const handover: PrivateHandoverView = purchased.handover;
  const paymentId = handover.paymentId;
  checkpoint.progress = { ...checkpoint.progress, paymentId, handedOver: true };
  writeCheckpoint(options.outDir, checkpoint);
  // 引き渡し = 受信決済は済み（Router は決済の後にだけ発行する）、送信 credential は発行済み。tx は status から（読めなければ `settled: true` だけ残る）。
  evidence.gates.inbound_settlement = { ...evidence.gates.inbound_settlement, settled: true };
  evidence.gates.outbound_settlement.issued = true;
  await fillFromStatus(client, paymentId, quote.ownerKey, evidence);
  evidence.stage = "handover";
  persistEvidence();
  const headerFile = path.join(options.outDir, "payment_header.json");
  const releaseFile = path.join(options.outDir, "release.json");
  const orderFinal = path.join(options.outDir, "order_final.json");
  writePrivate(headerFile, JSON.stringify(handover.headerFile));
  writePrivate(releaseFile, Buffer.from(handover.releaseB64, "base64"));
  log(`private-payer: handover verifier=${handover.verifier.address} sessionBy=${new Date(handover.deadlines.sessionBy).toISOString()}`);
  if (options.stopAfterHandover === true) return fail("handover", "stopped after handover (--stop-after-handover, diagnostics only); the Router will time this purchase out as unknown");
  const failAfterHandover = async (stage: string, reason: string): Promise<PrivatePayerRun> => {
    await fillFromStatus(client, paymentId, quote.ownerKey, evidence);
    return fail(stage, `${reason} (the inbound leg is settled and the credential was released: the outbound outcome is unknown until the Router's deadlines; do not re-pay; use --recover to read status/record)`);
  };

  // 5. finalize → session → prove（Payer の executor。Router は本文を見ない）。
  const finalize = await runBinary(bin, srs, ["payer-finalize-order", "--intent", intentFile, "--payment-header-file", headerFile, "--out", orderFinal], 60_000, path.join(options.outDir, "lab-finalize.log"));
  if (finalize.code !== 0) return failAfterHandover("finalize", "payer-finalize-order failed");
  const requestPrivate = path.join(exec, "private_inbox", "request_private.json");
  if (options.method === "POST") copyFileSync(path.join(keys, "request_private.json"), requestPrivate);
  const timeoutSecs = options.sessionTimeoutSecs ?? Math.max(30, Math.floor((handover.deadlines.sessionBy - now()) / 1000));
  const sessionArgs = ["executor-session", "--executor-dir", exec, "--order", orderFinal, "--verifier-addr", handover.verifier.address, "--host", options.host, "--port", "443", "--path", options.path, "--trust", options.trust, "--timeout-secs", String(timeoutSecs)];
  if (options.method === "POST") sessionArgs.push("--request-private", requestPrivate);
  if (options.connect !== undefined) sessionArgs.push("--connect", options.connect);
  const session = await runBinary(bin, srs, sessionArgs, (timeoutSecs + 60) * 1000, path.join(options.outDir, "lab-session.log"));
  if (session.code !== 0) return failAfterHandover("session", "executor-session failed");
  const until = handover.deadlines.sessionBy + 60_000;
  for (;;) {
    const status = await client.status(paymentId, quote.ownerKey);
    if (status.found && (status.projection as { status: string }).status === "attesting") break;
    if (now() > until) return failAfterHandover("session", "the Router did not recognize the record before the session deadline");
    await sleep(500);
  }
  checkpoint.progress = { ...checkpoint.progress, sessionDone: true };
  writeCheckpoint(options.outDir, checkpoint);
  evidence.stage = "session";
  persistEvidence();
  const proveArgs = ["executor-prove", "--executor-dir", exec, "--order", orderFinal];
  if (options.method === "POST") proveArgs.push("--request-private", requestPrivate);
  const prove = await runBinary(bin, srs, proveArgs, 900_000, path.join(options.outDir, "lab-prove.log"));
  if (prove.code !== 0) return failAfterHandover("prove", "executor-prove failed");
  const bundle = readFileSync(path.join(exec, "bundle.json"));
  writePrivate(path.join(options.outDir, "bundle.json"), bundle);

  // 6. attest → record ×2 → status（Router の判定。bearer は返ってこない）。
  let attested: Awaited<ReturnType<typeof client.privateAttest>>;
  try {
    attested = await client.privateAttest({ paymentId, ownerKey: quote.ownerKey, bundleB64: bundle.toString("base64") });
  } catch {
    return failAfterHandover("attest", "the attest response was lost (transport); the Router may have recorded the result");
  }
  if (!attested.ok) return failAfterHandover("attest", attested.error);
  checkpoint.progress = { ...checkpoint.progress, attested: true };
  writeCheckpoint(options.outDir, checkpoint);
  evidence.gates.private_delivery.status = attested.status;
  if (attested.terminalReason !== undefined) evidence.gates.private_delivery.terminalReason = attested.terminalReason;
  if (isRecord(attested.private) && attested.private["proof"] !== undefined) evidence.gates.private_delivery.proof = attested.private["proof"];
  evidence.stage = "attest";
  await fillFromStatus(client, paymentId, quote.ownerKey, evidence);
  persistEvidence();
  const record1 = await client.privateRecord({ paymentId, ownerKey: quote.ownerKey });
  const record2 = await client.privateRecord({ paymentId, ownerKey: quote.ownerKey });
  if (!record1.ok || !record2.ok) return failAfterHandover("record", record1.ok ? (record2 as { error: string }).error : record1.error);
  const recordBytes = Buffer.from(record1.recordB64, "base64");
  evidence.gates.private_delivery.recordSha256 = sha256Hex(recordBytes);
  evidence.gates.private_delivery.recordRepeatable = record1.recordB64 === record2.recordB64 && record1.releaseB64 === handover.releaseB64;
  const recordFile = path.join(options.outDir, "record.json");
  writePrivate(recordFile, recordBytes);

  // 7. Payer の復号（手元で bundle を検証してから）。
  const decrypted = await decryptLocally(bin, srs, options, keys, orderFinal, recordFile, path.join(options.outDir, "bundle.json"), intentFile, releaseFile);
  mergePayerReceipt(evidence, decrypted.gate, options.outDir);
  evidence.stage = "decrypt";
  persistEvidence();
  if (!decrypted.gate.ok) return fail("decrypt", "payer-decrypt did not succeed");
  if (attested.status !== "delivered_private") return fail("attest", `Router outcome ${attested.status}${attested.terminalReason === undefined ? "" : ` (${attested.terminalReason})`}`);
  evidence.stage = "delivered";
  persistEvidence();
  log(`private-payer: delivered paymentId=${paymentId} decryptedSha256=${decrypted.gate.decryptedSha256 ?? "-"} inboundTx=${evidence.gates.inbound_settlement.txRef ?? "-"} outboundTx=${evidence.gates.outbound_settlement.txRef ?? "-"}`);
  return { ok: true, stage: "delivered", paymentId, plaintext: readFileSync(decrypted.plaintextFile), evidence, files: { outDir: options.outDir, decrypt: decrypted.plaintextFile } };
}

async function decryptLocally(bin: string, srs: string, options: Pick<PrivatePayerOptions, "host" | "path">, keys: string, orderFinal: string, recordFile: string, bundleFile: string, intentFile: string, releaseFile: string, resultName = `decrypt-${randomBytes(3).toString("hex")}`): Promise<{ gate: PrivatePayerEvidence["gates"]["payer_receipt"]; plaintextFile: string }> {
  const run = await runBinary(bin, srs, ["payer-decrypt", "--payer-dir", keys, "--order", orderFinal, "--record", recordFile, "--bundle", bundleFile, "--expect-host", options.host, "--expect-port", "443", "--expect-path", options.path, "--intent", intentFile, "--release", releaseFile, "--result-name", resultName], 600_000, path.join(path.dirname(keys), `lab-${resultName}.log`));
  const resultFile = path.join(keys, `${resultName}_result.json`);
  const result = existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, "utf8")) as Record<string, unknown>) : undefined;
  return {
    gate: {
      ok: run.code === 0 && result?.["ok"] === true,
      ...(result === undefined ? {} : { verifiedBundleBeforeDecrypt: result["verified_bundle_before_decrypt"] === true, decryptedSha256: String(result["decrypted_sha256"]), payloadLen: Number(result["payload_len"]) }),
      ...(typeof result?.["failed_stage"] === "string" ? { failedStage: result["failed_stage"] } : {}),
    },
    plaintextFile: path.join(keys, `${resultName}.bin`),
  };
}

export interface PrivatePayerRecoverOptions {
  readonly routerBaseUrl: string;
  readonly principalId: string;
  readonly token: string;
  readonly outDir: string;
  readonly labDir?: string;
  readonly srsPath?: string;
  readonly log?: (line: string) => void;
  /** `--chain`: 読取専用のチェーン照合（thirdparty §10.1）。`rpcUrl` の既定は `SUBETHA_BASE_SEPOLIA_RPC_URL` か公開 RPC。`payerAddress` は古い再開点（`progress.payerAddress` 無し）のため。 */
  readonly chain?: { readonly rpcUrl?: string; readonly payerAddress?: string; readonly readerForTest?: ChainReader };
  /** **試験専用**: Router の client と手元の復号の差し替え（Router も lab も無しで回復の論理を試す）。 */
  readonly clientForTest?: Pick<RouterClient & PrivateRouterClient, "status" | "privateRecord">;
  readonly decryptForTest?: () => Promise<{ gate: PrivatePayerEvidence["gates"]["payer_receipt"]; plaintextFile: string }>;
}
export const DEFAULT_BASE_SEPOLIA_RPC_URL = "https://sepolia.base.org";
export const BASE_SEPOLIA_CHAIN_ID = 84532;
const AUTHORIZATION_STATE_ABI = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const TOPIC_AUTHORIZATION_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TOPIC_AUTHORIZATION_CANCELED = "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81";
const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** 公開 RPC の `eth_getLogs` の 1 回の上限（Base Sepolia の公開 RPC は 200 block）。 */
const LOG_CHUNK_BLOCKS = 200;
/** 探索区間の余裕（block）。区間の両端は block の timestamp の二分探索で決める（block 時間を仮定しない: Base Sepolia は約 0.2 s/block）。 */
const SEARCH_MARGIN_BLOCKS = 200;
/** 二分探索の上限（header の読取回数）と、遡る block 数の上限（公開 RPC は古い block を返さないことがある。これより古い決済は `used_unlocated` になる = 限界として文書化）。 */
const MAX_BISECT_STEPS = 48;
const MAX_LOOKBACK_BLOCKS = 1_000_000;

function topicAddress(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

/** 公開 RPC の読取（JSON-RPC。失敗は例外 = 呼び出し側が recovery-log に固定文を書く。URL は出力しない）。 */
export function rpcChainReader(rpcUrl: string): ChainReader {
  async function call(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("rpc_http");
    const body = (await response.json()) as { result?: unknown; error?: unknown };
    if (body.error !== undefined || body.result === undefined) throw new Error("rpc_error");
    return body.result;
  }
  const hex = (n: number): string => `0x${n.toString(16)}`;
  return {
    chainId: async () => Number(BigInt(String(await call("eth_chainId", [])))),
    latestBlock: async () => {
      const block = (await call("eth_getBlockByNumber", ["latest", false])) as { number?: string; hash?: string; timestamp?: string };
      if (typeof block.number !== "string" || typeof block.hash !== "string" || typeof block.timestamp !== "string") throw new Error("rpc_shape");
      return { number: Number(BigInt(block.number)), hash: block.hash, timestamp: Number(BigInt(block.timestamp)) };
    },
    blockByNumber: async (block) => {
      const b = (await call("eth_getBlockByNumber", [hex(block), false])) as { number?: string; hash?: string; timestamp?: string } | null;
      if (b === null || typeof b.number !== "string" || typeof b.hash !== "string" || typeof b.timestamp !== "string") throw new Error("rpc_shape");
      return { number: Number(BigInt(b.number)), hash: b.hash, timestamp: Number(BigInt(b.timestamp)) };
    },
    authorizationState: async (asset, authorizer, nonce, blockHash) => {
      const data = encodeFunctionData({ abi: AUTHORIZATION_STATE_ABI, functionName: "authorizationState", args: [authorizer as `0x${string}`, nonce as `0x${string}`] });
      // EIP-1898: block を hash で固定する。
      const result = await call("eth_call", [{ to: asset, data }, { blockHash }]);
      if (typeof result !== "string" || !BYTES32.test(result)) throw new Error("rpc_shape");
      const value = BigInt(result);
      // 正準な bool（0 / 1）だけを受ける。他の値は形違い（証跡を変えない）。
      if (value !== 0n && value !== 1n) throw new Error("rpc_shape");
      return value === 1n;
    },
    findAuthorization: async (asset, authorizer, nonce, fromBlock, toBlock) => {
      const found: { kind: "used" | "canceled"; txHash: string; block: number; blockHash: string }[] = [];
      for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK_BLOCKS) {
        const to = Math.min(toBlock, from + LOG_CHUNK_BLOCKS - 1);
        for (const [kind, topic] of [["used", TOPIC_AUTHORIZATION_USED], ["canceled", TOPIC_AUTHORIZATION_CANCELED]] as const) {
          const logs = (await call("eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(to), address: asset, topics: [topic, topicAddress(authorizer), nonce] }])) as { transactionHash?: string; blockNumber?: string; blockHash?: string; topics?: string[] }[];
          for (const log of logs) {
            if (typeof log.transactionHash !== "string" || typeof log.blockNumber !== "string" || typeof log.blockHash !== "string") throw new Error("rpc_shape");
            found.push({ kind, txHash: log.transactionHash, block: Number(BigInt(log.blockNumber)), blockHash: log.blockHash });
          }
        }
      }
      return found;
    },
    receiptLogsOf: async (txHash) => {
      const receipt = (await call("eth_getTransactionReceipt", [txHash])) as { status?: string; blockHash?: string; logs?: { address?: string; topics?: string[]; data?: string }[] } | null;
      if (receipt === null) return undefined;
      if (typeof receipt !== "object" || !Array.isArray(receipt.logs) || typeof receipt.blockHash !== "string") throw new Error("rpc_shape");
      if (receipt.status !== "0x1") return undefined;
      const logs = receipt.logs.map((log) => {
        if (typeof log.address !== "string" || !Array.isArray(log.topics) || typeof log.data !== "string") throw new Error("rpc_shape");
        return { address: log.address, topics: log.topics, data: log.data };
      });
      return { blockHash: receipt.blockHash, logs };
    },
  };
}

/** 1 レグの読取（§10.1 3〜5）。例外は呼び出し側へ。 */
/**
 * receipt のログ列（資産 contract 発だけ）で、(authorizer, nonce) の `AuthorizationUsed` の**直後**が `Transfer(authorizer → payTo, amount)` か（Circle の EIP-3009 は
 * `AuthorizationUsed` を出した直後に transfer を実行する。同じ receipt にあるだけでは束縛にならない）。
 */
export function settlementBoundInReceipt(logs: readonly { address: string; topics: readonly string[]; data: string }[], leg: Pick<ChainLegInput, "asset" | "authorizer" | "nonce" | "payTo" | "amount">): boolean {
  const own = logs.filter((log) => log.address.toLowerCase() === leg.asset.toLowerCase());
  for (let index = 0; index < own.length - 1; index += 1) {
    const used = own[index]!;
    if (used.topics[0] !== TOPIC_AUTHORIZATION_USED || used.topics.length !== 3 || used.topics[1]!.toLowerCase() !== topicAddress(leg.authorizer) || used.topics[2]!.toLowerCase() !== leg.nonce.toLowerCase()) continue;
    const next = own[index + 1]!;
    if (next.topics[0] !== TOPIC_TRANSFER || next.topics.length !== 3) continue;
    const from = `0x${next.topics[1]!.slice(-40)}`;
    const to = `0x${next.topics[2]!.slice(-40)}`;
    let value: bigint;
    try {
      value = BigInt(next.data);
    } catch {
      continue;
    }
    if (from.toLowerCase() === leg.authorizer.toLowerCase() && to.toLowerCase() === leg.payTo.toLowerCase() && value === leg.amount) return true;
  }
  return false;
}

/** timestamp が `atOrAfter` 以上になる最初の block 番号（head 以下。二分探索。block 時間を仮定しない）。 */
async function firstBlockAtOrAfter(reader: ChainReader, head: { number: number; timestamp: number }, atOrAfter: number): Promise<number> {
  if (head.timestamp < atOrAfter) return head.number;
  let low = Math.max(0, head.number - MAX_LOOKBACK_BLOCKS);
  let high = head.number;
  if (low > 0) {
    // 遡る上限より古い時刻なら、上限の block から探す（それより前は探さない）。
    const oldest = await reader.blockByNumber(low);
    if (oldest.timestamp >= atOrAfter) return low;
  }
  for (let step = 0; step < MAX_BISECT_STEPS && low < high; step += 1) {
    const mid = Math.floor((low + high) / 2);
    const block = await reader.blockByNumber(mid);
    if (block.timestamp >= atOrAfter) high = mid;
    else low = mid + 1;
  }
  return low;
}

async function readLeg(reader: ChainReader, leg: ChainLegInput, head: { number: number; hash: string; timestamp: number }): Promise<ChainLegEvidence> {
  const used = await reader.authorizationState(leg.asset, leg.authorizer, leg.nonce, head.hash);
  const expired = head.timestamp > leg.validBefore;
  const base = { authorizer: leg.authorizer, authorizerSource: leg.authorizerSource, nonce: leg.nonce, validBefore: leg.validBefore, expired };
  if (!used) return { ...base, state: "unused", verdict: expired ? "unused_expired" : "unused" };
  // true は「使用または取消」: ログで決済を確かめる。区間は timestamp の二分探索で [quote の作成時刻, validBefore] に対応する block を求め、前後に余裕。
  const fromBlock = Math.max(0, (await firstBlockAtOrAfter(reader, head, Math.floor(leg.notBeforeMs / 1000))) - SEARCH_MARGIN_BLOCKS);
  const toBlock = Math.min(head.number, Math.max(fromBlock, (await firstBlockAtOrAfter(reader, head, leg.validBefore + 1)) + SEARCH_MARGIN_BLOCKS));
  const found = await reader.findAuthorization(leg.asset, leg.authorizer, leg.nonce, fromBlock, toBlock);
  if (found.some((entry) => entry.kind === "canceled") && !found.some((entry) => entry.kind === "used")) return { ...base, state: "used_or_canceled", verdict: "canceled" };
  for (const entry of found.filter((entry) => entry.kind === "used")) {
    const receipt = await reader.receiptLogsOf(entry.txHash);
    if (receipt === undefined) continue;
    // receipt とログの block hash が一致しなければ観測が不整合（reorg）: この tx は使わない。
    if (receipt.blockHash.toLowerCase() !== entry.blockHash.toLowerCase()) throw new ChainInconsistentError();
    if (settlementBoundInReceipt(receipt.logs, leg)) return { ...base, state: "used_or_canceled", verdict: "settled", txRef: entry.txHash, txBlock: entry.block };
  }
  return { ...base, state: "used_or_canceled", verdict: "used_unlocated" };
}

class ChainInconsistentError extends Error {}

/** 読取（§10.1 1〜5）。失敗は固定語の `error`（証跡は呼び出し側で不変）。 */
export async function readChain(reader: ChainReader, rpcHost: string, legs: { readonly inbound?: ChainLegInput; readonly outbound?: ChainLegInput; readonly skipped?: { inbound?: string; outbound?: string } }): Promise<{ ok: true; chain: ChainEvidence } | { ok: false; error: string }> {
  let chainId: number;
  let head: { number: number; hash: string; timestamp: number };
  try {
    chainId = await reader.chainId();
    head = await reader.latestBlock();
  } catch {
    return { ok: false, error: "chain_unreadable" };
  }
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) return { ok: false, error: "chain_mismatch" };
  const chain: ChainEvidence = { readAt: new Date().toISOString(), rpcHost, chainId, block: { number: head.number, hash: head.hash, time: head.timestamp }, ...(legs.skipped === undefined ? {} : { skipped: { ...legs.skipped } }) };
  for (const [name, leg] of [["inbound", legs.inbound], ["outbound", legs.outbound]] as const) {
    if (leg === undefined) continue;
    if (leg.network !== `eip155:${BASE_SEPOLIA_CHAIN_ID}`) {
      chain.skipped = { ...chain.skipped, [name]: "network" };
      continue;
    }
    try {
      chain[name] = await readLeg(reader, leg, head);
    } catch (error) {
      return { ok: false, error: error instanceof ChainInconsistentError ? "chain_inconsistent" : `${name}_unreadable` };
    }
  }
  // 読取の後に同じ番号の block を読み直す: hash が違えば reorg（結果を捨てる）。
  try {
    const again = await reader.blockByNumber(head.number);
    if (again.hash.toLowerCase() !== head.hash.toLowerCase()) return { ok: false, error: "chain_reorg_detected" };
  } catch {
    return { ok: false, error: "chain_unreadable" };
  }
  return { ok: true, chain };
}

/**
 * 証跡への写し（§10.1。**単調**: 確立した事実は下げない。純関数ではないが I/O は無い）。戻り値は recovery-log に書く固定語の列。
 * `routerTerminal` = Router の公開状態が終端（unknown / paid_data_unavailable / delivered / delivered_private）。
 */
export function mergeChainEvidence(evidence: PrivatePayerEvidence, chain: ChainEvidence, routerTerminal: boolean, attempted = true): string[] {
  const notes: string[] = [];
  // 前回の chain 読取の tx 参照はゲートの `chainTxRef` に写してあるものだけが残る（`evidence.chain` は今回の読取で上書き）。
  evidence.chain = chain;
  const inbound = chain.inbound;
  if (inbound !== undefined) {
    const leg = evidence.gates.inbound_settlement;
    const established = leg.settled;
    if (established && inbound.state === "unused") notes.push("contradiction: inbound settled (established) but authorizationState unused at the read block; evidence kept");
    if (inbound.authorizerSource === "operator_unverified") {
      // 未検証のアドレスの観測は診断だけ（ゲートの settled / uncertain を変えない）。
      evidence.gates.inbound_settlement = { ...leg, chain: inbound.verdict };
      notes.push("inbound chain read used an operator-supplied, unverified payer address: diagnostic only");
    } else if (established) {
      // 確立した事実は下げない（txRef の有無によらず）。一致する観測（settled）は参照を足し、不確実の印は外す。
      if (inbound.verdict === "settled") {
        const { uncertain: _u, ...rest } = leg;
        evidence.gates.inbound_settlement = { ...rest, chain: "settled", ...(rest.txRef === undefined && rest.chainTxRef === undefined ? { chainTxRef: inbound.txRef! } : {}) };
      }
    } else if (inbound.verdict === "settled") {
      const { uncertain: _u, ...rest } = leg;
      evidence.gates.inbound_settlement = { ...rest, settled: true, chain: "settled", ...(rest.txRef === undefined ? { chainTxRef: inbound.txRef! } : {}) };
    } else if (inbound.verdict === "unused_expired" && routerTerminal) {
      const { uncertain: _u, ...rest } = leg;
      evidence.gates.inbound_settlement = { ...rest, settled: false, chain: "unused_expired" };
    } else {
      // 未解決（期限前・取消・特定不能・Router が終端でない）: 提出済みなら不確実の印を**戻す**（過去の「未使用」の観測で今の結果を確定させない）。
      evidence.gates.inbound_settlement = { ...leg, ...(attempted ? { uncertain: true as const } : {}), chain: inbound.verdict };
    }
  }
  const outbound = chain.outbound;
  if (outbound !== undefined) {
    const leg = evidence.gates.outbound_settlement;
    const established = leg.txRef !== undefined || leg.chainTxRef !== undefined;
    if (established && outbound.state === "unused") notes.push("contradiction: outbound settlement established (txRef/chainTxRef) but authorizationState unused at the read block; evidence kept");
    if (established) {
      if (outbound.verdict === "settled") {
        const { uncertain: _u, ...rest } = leg;
        evidence.gates.outbound_settlement = { ...rest, chain: "settled" };
      }
    } else if (outbound.verdict === "settled") {
      const { uncertain: _u, ...rest } = leg;
      evidence.gates.outbound_settlement = { ...rest, issued: true, chain: "settled", chainTxRef: outbound.txRef! };
    } else if (outbound.verdict === "unused_expired" && routerTerminal) {
      const { uncertain: _u, ...rest } = leg;
      evidence.gates.outbound_settlement = { ...rest, chain: "unused_expired" };
    } else {
      evidence.gates.outbound_settlement = { ...leg, ...(attempted ? { uncertain: true as const } : {}), chain: outbound.verdict };
    }
  }
  return notes;
}

/** quote と手元の header から読取の入力を組む（§10.1。推定しない。形が違えば `skipped` に固定語）。 */
export function chainLegInputsOf(checkpoint: Checkpoint, outDir: string, payerAddressOverride: string | undefined): { ok: true; inbound?: ChainLegInput; outbound?: ChainLegInput; skipped?: { inbound?: string; outbound?: string } } | { ok: false; reason: string } {
  const quote = checkpoint.quote as unknown as { source?: { offer?: Record<string, unknown>; payTo?: unknown; amount?: unknown }; destination?: { network?: unknown; asset?: unknown; payTo?: unknown; quoted?: unknown } };
  const offer = quote.source?.offer;
  const skipped: { inbound?: string; outbound?: string } = {};
  const result: { ok: true; inbound?: ChainLegInput; outbound?: ChainLegInput; skipped?: typeof skipped } = { ok: true };
  const notBeforeMs = Date.parse(checkpoint.createdAt);
  // 受信。
  const recorded = checkpoint.progress?.payerAddress;
  if (recorded !== undefined && payerAddressOverride !== undefined && recorded.toLowerCase() !== payerAddressOverride.toLowerCase()) return { ok: false, reason: "payer_address_conflict" };
  const authorizer = recorded ?? payerAddressOverride;
  const extra = offer?.["extra"] as Record<string, unknown> | undefined;
  const nonce = extra?.["challengeNonce"];
  const expiresAt = extra?.["expiresAt"];
  if (offer !== undefined && offer["scheme"] !== "exact") skipped.inbound = "protocol";
  else if (authorizer === undefined || !EVM_ADDRESS_RE.test(authorizer)) skipped.inbound = "payer_address_unknown";
  else if (offer === undefined || typeof offer["network"] !== "string" || typeof offer["asset"] !== "string" || typeof offer["payTo"] !== "string" || typeof offer["amount"] !== "string" || !/^[0-9]+$/.test(offer["amount"]) || typeof nonce !== "string" || !BYTES32.test(nonce) || typeof expiresAt !== "number") skipped.inbound = "offer_shape";
  else if (offer["scheme"] !== "exact") skipped.inbound = "protocol";
  else if (offer["network"] !== PRIVATE_INBOUND_NETWORK) skipped.inbound = "network";
  else if (offer["asset"].toLowerCase() !== PRIVATE_INBOUND_ASSET.toLowerCase()) skipped.inbound = "asset";
  else result.inbound = { authorizer, authorizerSource: recorded !== undefined ? "checkpoint" : "operator_unverified", nonce, validBefore: expiresAt, network: offer["network"], asset: offer["asset"], payTo: offer["payTo"], amount: BigInt(offer["amount"]), notBeforeMs };
  // 送信（header がある = 発行済み）。
  const headerFile = path.join(outDir, "payment_header.json");
  if (existsSync(headerFile)) {
    try {
      const header = JSON.parse(readFileSync(headerFile, "utf8")) as { value?: unknown };
      const decoded = typeof header.value === "string" ? (JSON.parse(Buffer.from(header.value, "base64").toString("utf8")) as { payload?: { authorization?: Record<string, unknown> } }) : undefined;
      const auth = decoded?.payload?.authorization ?? {};
      const from = auth["from"];
      const outNonce = auth["nonce"];
      const validBefore = auth["validBefore"];
      const to = auth["to"];
      const value = auth["value"];
      const destination = quote.destination;
      if (typeof from !== "string" || !EVM_ADDRESS_RE.test(from) || typeof outNonce !== "string" || !BYTES32.test(outNonce) || (typeof validBefore !== "string" && typeof validBefore !== "number") || typeof to !== "string" || (typeof value !== "string" && typeof value !== "number")) {
        skipped.outbound = "header_shape";
      } else if (destination === undefined || typeof destination.network !== "string" || typeof destination.asset !== "string" || typeof destination.payTo !== "string" || typeof destination.quoted !== "string" || !/^[0-9]+$/.test(destination.quoted)) {
        skipped.outbound = "quote_shape";
      } else if (destination.network !== PRIVATE_INBOUND_NETWORK) {
        skipped.outbound = "network";
      } else if (destination.asset.toLowerCase() !== PRIVATE_INBOUND_ASSET.toLowerCase()) {
        skipped.outbound = "asset";
      } else if (to.toLowerCase() !== destination.payTo.toLowerCase() || BigInt(value) !== BigInt(destination.quoted)) {
        skipped.outbound = "header_mismatch";
      } else {
        result.outbound = { authorizer: from, authorizerSource: "header", nonce: outNonce, validBefore: Number(validBefore), network: destination.network, asset: destination.asset, payTo: destination.payTo, amount: BigInt(destination.quoted), notBeforeMs };
      }
    } catch {
      skipped.outbound = "header_shape";
    }
  }
  if (Object.keys(skipped).length > 0) result.skipped = skipped;
  return result;
}

/** `--recover` の stdout 向けの射影: chain は要約だけ、各レグの tx 参照（`txRef`・`chainTxRef`）と `eventId`（authorization nonce を含み得る）は出さない。証跡ファイルにはすべてある。 */
export function consoleProjectionOf(evidence: PrivatePayerEvidence): Record<string, unknown> {
  const strip = <T extends Record<string, unknown>>(leg: T): Omit<T, "txRef" | "chainTxRef" | "eventId" | "claimedTxRef"> => {
    const { txRef: _t, chainTxRef: _c, eventId: _e, claimedTxRef: _b, ...rest } = leg as T & { txRef?: unknown; chainTxRef?: unknown; eventId?: unknown; claimedTxRef?: unknown };
    return rest;
  };
  return { ...evidence, chain: chainSummaryOf(evidence.chain), gates: { ...evidence.gates, inbound_settlement: strip(evidence.gates.inbound_settlement), outbound_settlement: strip(evidence.gates.outbound_settlement) } };
}

/** コンソール向けの要約（nonce・authorizer・tx hash・RPC は出さない。§10.1 出力の方針）。 */
export function chainSummaryOf(chain: ChainEvidence | undefined): { block: number; inbound?: ChainLegVerdict; outbound?: ChainLegVerdict; skipped?: ChainEvidence["skipped"] } | undefined {
  if (chain === undefined) return undefined;
  return { block: chain.block.number, ...(chain.inbound === undefined ? {} : { inbound: chain.inbound.verdict }), ...(chain.outbound === undefined ? {} : { outbound: chain.outbound.verdict }), ...(chain.skipped === undefined ? {} : { skipped: chain.skipped }) };
}

export type PrivatePayerRecovery =
  | { readonly ok: true; readonly paymentId: string; readonly status: Record<string, unknown> | undefined; readonly recordAvailable: boolean; readonly decrypted: boolean; readonly evidence: PrivatePayerEvidence }
  | { readonly ok: false; readonly reason: string };

/** 応答を失ったとき・別プロセスから: checkpoint の ownerKey で status と record を読み直し、手元に bundle があれば復号する。何も払わない。 */
export async function recoverPrivatePayer(options: PrivatePayerRecoverOptions): Promise<PrivatePayerRecovery> {
  const checkpoint = readCheckpoint(options.outDir);
  if (checkpoint === undefined) return { ok: false, reason: "no checkpoint in --out" };
  if (checkpoint.args.routerBaseUrl !== options.routerBaseUrl || checkpoint.args.principalId !== options.principalId) return { ok: false, reason: "the checkpoint belongs to another Router/principal" };
  const client = options.clientForTest ?? createRouterClient({ baseUrl: options.routerBaseUrl, principalId: options.principalId, token: options.token, allowUnissuedQuotes: true });
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const paymentId = checkpoint.progress?.paymentId ?? checkpoint.quote.paymentId;
  // 既にある証跡を引き継ぐ（分かったことを消さない）。提出したが結果が分からない購入は、status が読めるまで両決済を uncertain とする。
  const evidence = loadEvidence(options.outDir, newEvidence({ trust: checkpoint.args.trust as "mozilla" | "lab-fixture-ca", method: checkpoint.args.method, host: checkpoint.args.host, path: checkpoint.args.path }));
  evidence.paymentId = paymentId;
  evidence.intentSha256 = checkpoint.intentSha256;
  evidence.orderId = checkpoint.orderId;
  // 出所の記録は再開点の args が権威（証跡が無い・失われた回復でも復元する）。
  if (checkpoint.args.providerFileSha256 !== undefined) evidence.providerFileSha256 = checkpoint.args.providerFileSha256;
  evidence.stage = "recover";
  if (checkpoint.progress?.burnTxHash !== undefined) evidence.gates.inbound_settlement = { ...evidence.gates.inbound_settlement, claimedTxRef: checkpoint.progress.burnTxHash };
  if (checkpoint.progress?.handedOver === true) {
    evidence.gates.inbound_settlement = { ...evidence.gates.inbound_settlement, settled: true };
    evidence.gates.outbound_settlement.issued = true;
  }
  if (checkpoint.progress?.purchaseAttempted === true) {
    // 提出済みで確立していないレグは、レグごとに独立して不確実にする（引き渡し済みでも送信の決済は確立していない）。過去の chain 読取の
    // 「未使用で期限切れ」は履歴（`chain` 欄）として残るが、今の結果は今回の読取（--chain）だけが決める。
    const inbound = evidence.gates.inbound_settlement;
    if (!inbound.settled && inbound.txRef === undefined && inbound.chainTxRef === undefined) evidence.gates.inbound_settlement = { ...inbound, uncertain: true };
    const outbound = evidence.gates.outbound_settlement;
    if (outbound.txRef === undefined && outbound.chainTxRef === undefined) evidence.gates.outbound_settlement = { ...outbound, uncertain: true };
  }
  await fillFromStatus(client, paymentId, checkpoint.quote.ownerKey, evidence);
  let status: Awaited<ReturnType<typeof client.status>>;
  try {
    status = await client.status(paymentId, checkpoint.quote.ownerKey);
  } catch {
    status = { found: false, status: 0, reason: "transport_failed" };
  }
  const projection = status.found ? (status.projection as unknown as Record<string, unknown>) : undefined;
  if (projection !== undefined && evidence.gates.inbound_settlement.txRef !== undefined) delete (evidence.gates.inbound_settlement as { uncertain?: true }).uncertain;
  let record: Awaited<ReturnType<typeof client.privateRecord>>;
  try {
    record = await client.privateRecord({ paymentId, ownerKey: checkpoint.quote.ownerKey });
  } catch {
    record = { ok: false, error: "transport_failed", status: 0 };
  }
  let decrypted = false;
  if (record.ok) {
    const recordBytes = Buffer.from(record.recordB64, "base64");
    evidence.gates.private_delivery.recordSha256 = sha256Hex(recordBytes);
    const recordFile = path.join(options.outDir, "record.json");
    writePrivate(recordFile, recordBytes);
    const bundleFile = path.join(options.outDir, "bundle.json");
    const orderFinal = path.join(options.outDir, "order_final.json");
    const labDir = options.labDir ?? defaultLabDir();
    const bin = path.join(labDir, "phase5/runner/target/release/delivery");
    const srs = options.srsPath ?? defaultSrsPath();
    if (options.decryptForTest !== undefined || (existsSync(bundleFile) && existsSync(orderFinal) && existsSync(bin) && existsSync(srs))) {
      const result = options.decryptForTest !== undefined ? await options.decryptForTest() : await decryptLocally(bin, srs, { host: checkpoint.args.host, path: checkpoint.args.path }, path.join(options.outDir, "keys"), orderFinal, recordFile, bundleFile, path.join(options.outDir, "intent.json"), path.join(options.outDir, "release.json"));
      mergePayerReceipt(evidence, result.gate, options.outDir);
      decrypted = result.gate.ok;
    }
  } else {
    recordLog(options.outDir, "recovery-log.json", "record", `record not available (${record.error}); established gates kept`);
  }
  if (!status.found) recordLog(options.outDir, "recovery-log.json", "status", `status not readable (${status.reason}); established gates kept`);
  if (projection !== undefined) {
    const priv = projection["private"] as Record<string, unknown> | undefined;
    if (typeof projection["status"] === "string") evidence.gates.private_delivery.status = projection["status"];
    if (typeof projection["terminalReason"] === "string") evidence.gates.private_delivery.terminalReason = projection["terminalReason"];
    if (priv !== undefined && priv["proof"] !== undefined) evidence.gates.private_delivery.proof = priv["proof"];
  }
  // --chain: 読取専用のチェーン照合（§10.1）。Router の公開状態が終端（unknown / paid_data_unavailable / delivered / delivered_private）のときだけ「未使用で期限切れ」が不確実を外せる。
  if (options.chain !== undefined) {
    const routerStatus = typeof projection?.["status"] === "string" ? (projection["status"] as string) : undefined;
    // Router の公開状態（`src/core/intent.ts` PublicStatus）のうち終端: unknown / paid_data_unavailable / delivered / delivered_private。`awaiting_payment` は進行中とも終端（source_failed）とも読めるので終端にしない。
    const routerTerminal = routerStatus !== undefined && ["unknown", "paid_data_unavailable", "delivered_private", "delivered"].includes(routerStatus);
    const inputs = chainLegInputsOf(checkpoint, options.outDir, options.chain.payerAddress);
    if (!inputs.ok) return { ok: false, reason: inputs.reason };
    const rpcUrl = options.chain.rpcUrl ?? process.env["SUBETHA_BASE_SEPOLIA_RPC_URL"] ?? DEFAULT_BASE_SEPOLIA_RPC_URL;
    const reader = options.chain.readerForTest ?? rpcChainReader(rpcUrl);
    const read = await readChain(reader, options.chain.readerForTest !== undefined ? "test" : new URL(rpcUrl).host, inputs);
    if (!read.ok) {
      recordLog(options.outDir, "recovery-log.json", "chain", `chain check not applied (${read.error}); evidence unchanged`);
    } else {
      for (const note of mergeChainEvidence(evidence, read.chain, routerTerminal, checkpoint.progress?.purchaseAttempted === true)) recordLog(options.outDir, "recovery-log.json", "chain", note);
      log(`private-payer: chain ${JSON.stringify(chainSummaryOf(read.chain))}`);
    }
  }
  // 証跡は 1 つ（`evidence.json`）に単調に併合する（回復で分かったことも、次の回復で消えない）。
  writeDurable(path.join(options.outDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return { ok: true, paymentId, status: projection, recordAvailable: record.ok, decrypted, evidence };
}

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
function requireArg(name: string): string {
  const value = argOf(name);
  if (value === undefined || value === "") {
    process.stderr.write(`--${name} is required\n`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const token = process.env["PRIVATE_PAYER_TOKEN"];
  if (token === undefined || token === "") {
    process.stderr.write("PRIVATE_PAYER_TOKEN is required (env only)\n");
    process.exit(2);
  }
  if (process.argv.includes("--recover")) {
    const chain = process.argv.includes("--chain") ? { ...(argOf("rpc-url") === undefined ? {} : { rpcUrl: argOf("rpc-url")! }), ...(argOf("payer-address") === undefined ? {} : { payerAddress: argOf("payer-address")! }) } : undefined;
    const recovered = await recoverPrivatePayer({ routerBaseUrl: requireArg("router"), principalId: requireArg("principal"), token, outDir: requireArg("out"), ...(argOf("lab-dir") === undefined ? {} : { labDir: argOf("lab-dir")! }), ...(chain === undefined ? {} : { chain }) });
    // コンソールには chain の要約（verdict と block）だけ。nonce・authorizer・tx hash は証跡ファイルに。
    const printable = recovered.ok ? consoleProjectionOf(recovered.evidence) : undefined;
    process.stdout.write(`${JSON.stringify(recovered.ok ? { ok: true, paymentId: recovered.paymentId, status: recovered.status?.["status"], terminalReason: recovered.status?.["terminalReason"], recordAvailable: recovered.recordAvailable, decrypted: recovered.decrypted, evidence: printable } : recovered)}\n`);
    if (!recovered.ok) process.exit(1);
    return;
  }
  const inboundNetwork = argOf("inbound-network");
  const inboundAsset = argOf("inbound-asset");
  if ((inboundNetwork === undefined) !== (inboundAsset === undefined)) {
    process.stderr.write("--inbound-network and --inbound-asset go together\n");
    process.exit(2);
  }
  const inboundIsDefault = inboundNetwork === undefined || (inboundNetwork === PRIVATE_INBOUND_NETWORK && inboundAsset!.toLowerCase() === PRIVATE_INBOUND_ASSET.toLowerCase());
  const key = process.env["SUBETHA_PAYER_PRIVATE_KEY"];
  if (inboundIsDefault && (key === undefined || key === "")) {
    process.stderr.write("SUBETHA_PAYER_PRIVATE_KEY is required for an x402 inbound (env only)\n");
    process.exit(2);
  }
  const burnTxHash = argOf("burn-tx-hash");
  if (burnTxHash !== undefined && !process.argv.includes("--approve")) {
    process.stderr.write("--burn-tx-hash goes with --approve (quote first, pay the burn address, then approve)\n");
    process.exit(2);
  }
  const providerFile = argOf("provider-file");
  const manualArgs = ["method", "host", "path", "outbound-protocol", "outbound-network", "outbound-asset", "outbound-pay-to", "outbound-max-amount"];
  if (providerFile !== undefined && manualArgs.some((name) => argOf(name) !== undefined)) {
    process.stderr.write("--provider-file replaces --method/--host/--path/--outbound-* (give one or the other, not both)\n");
    process.exit(2);
  }
  let target: Pick<PrivatePayerOptions, "method" | "host" | "path" | "outbound" | "providerFileSha256">;
  if (providerFile !== undefined) {
    const fromFile = withProviderFile(providerFile, {});
    if (fromFile === undefined) {
      process.stderr.write("--provider-file is not a readable provider.json from tools/private-provider-precheck.ts\n");
      process.exit(2);
    }
    target = fromFile;
  } else {
    const method = requireArg("method");
    if (method !== "GET" && method !== "POST") {
      process.stderr.write("--method must be GET or POST\n");
      process.exit(2);
    }
    const protocol = requireArg("outbound-protocol");
    if (protocol !== "x402" && protocol !== "mpp") {
      process.stderr.write("--outbound-protocol must be x402 or mpp\n");
      process.exit(2);
    }
    target = { method, host: requireArg("host"), path: requireArg("path"), outbound: { protocol, network: requireArg("outbound-network"), asset: requireArg("outbound-asset"), payTo: requireArg("outbound-pay-to"), maxAmount: requireArg("outbound-max-amount") } };
  }
  const trust = argOf("trust") ?? "mozilla";
  if (trust !== "mozilla" && trust !== "lab-fixture-ca") {
    process.stderr.write("--trust must be mozilla or lab-fixture-ca\n");
    process.exit(2);
  }
  const inboundMaxTotal = argOf("inbound-max-total");
  if (inboundNetwork !== undefined && inboundMaxTotal === undefined) {
    process.stderr.write("--inbound-max-total is required with --inbound-network/--inbound-asset\n");
    process.exit(2);
  }
  const outDir = requireArg("out");
  const run = await runPrivatePayer({
    routerBaseUrl: requireArg("router"),
    principalId: requireArg("principal"),
    token,
    profileId: requireArg("profile"),
    ...(argOf("lab-dir") === undefined ? {} : { labDir: argOf("lab-dir")! }),
    ...target,
    ...(argOf("body-file") === undefined ? {} : { bodyFile: argOf("body-file")! }),
    ...(inboundMaxTotal === undefined ? {} : { inbound: { network: inboundNetwork ?? PRIVATE_INBOUND_NETWORK, asset: inboundAsset ?? PRIVATE_INBOUND_ASSET, maxTotal: inboundMaxTotal } }),
    trust,
    ...(argOf("connect") === undefined ? {} : { connect: argOf("connect")! }),
    outDir,
    ...(key === undefined || key === "" ? {} : { payerPrivateKey: key }),
    ...(burnTxHash === undefined ? {} : { burnTxHash }),
    approve: process.argv.includes("--approve"),
    ...(process.argv.includes("--stop-after-handover") ? { stopAfterHandover: true } : {}),
    ...(argOf("scope-file") === undefined ? {} : { scopeFile: argOf("scope-file")! }),
  });
  if (run.ok && run.stage === "quoted") {
    const payFirst = payFirstOf(run.quote);
    process.stdout.write(`${JSON.stringify({ stage: "quoted", paymentId: run.quote.paymentId, approvalSubjectFile: path.join(outDir, "quote.json"), ...(payFirst === undefined ? {} : { payFirst }), note: payFirst === undefined ? "no payment was made; review quote.json, then re-run the same command with --approve (same --out)" : "no payment was made; review quote.json; the inbound is a burn-sale: transfer exactly payFirst.amount of payFirst.asset to payFirst.payTo before the quote deadline, then re-run the same command with --approve --burn-tx-hash <that tx hash> (same --out)" })}\n`);
    return;
  }
  // コンソールには tx 参照を出さない射影（`--recover` と同じ方針）。全部は evidence.json に。
  process.stdout.write(`${JSON.stringify(run.ok ? { stage: run.stage, paymentId: run.paymentId, evidence: consoleProjectionOf(run.evidence) } : { stage: run.stage, reason: run.reason, evidence: consoleProjectionOf(run.evidence) })}\n`);
  if (!run.ok) process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // 例外の文字列は鍵・URL を含み得るので固定文だけ。
    process.stderr.write(`private-payer: failed (${error instanceof Error ? error.name : "error"})\n`);
    process.exit(1);
  });
}
