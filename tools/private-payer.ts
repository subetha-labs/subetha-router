/**
 * 秘匿購入の **Payer 側**の手順（`docs/zktls-router-design.md` §2・§11、`docs/zktls-router-acceptance.md`）。**製品コードではない**（鍵を扱う Payer の起動側）。
 *
 * 2 回の起動で 1 件の購入:
 * 1. `--approve` なし: 封筒（lab の `payer-keygen` の注文 + 両レグの承認）→ quote。承認対象を `<out>/quote.json` に、再開に要る全部（quote 文書・ownerKey・requestId・注文）を
 *    `<out>/checkpoint.json`（0600）に書いて止まる。支払いも署名も無い。
 * 2. 同じ `--out` に `--approve`: checkpoint を**再開**する（keygen も quote もやり直さない）。`quote.json` が書き換えられていた・quote の期限が過ぎた・引数が違うときは拒む。
 *    受信 credential（EIP-3009、自分の鍵）→ purchase（引き渡し）→ `payer-finalize-order` → `executor-session`（実 MPC-TLS）→ `executor-prove` → attest → record（2 回・同一）→ `payer-decrypt`。
 * - `--recover`: checkpoint の ownerKey で status と record を読み直し、手元に bundle があれば復号する（応答を失ったとき・別プロセスから）。
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
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createRouterClient } from "../src/client/index.js";
import type { PrivateHandoverView, PrivateQuoteView, RouterClient } from "../src/client/types.js";
import type { PrivateRouterClient } from "../src/client/types.js";
import { createX402Payer } from "./x402-payer.js";

export const PRIVATE_INBOUND_NETWORK = "eip155:84532";
export const PRIVATE_INBOUND_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
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
  readonly inbound?: { readonly network: string; readonly asset: string; readonly maxTotal: string };
  readonly trust: "mozilla" | "lab-fixture-ca";
  /** 試験だけ: executor の TCP の行き先（loopback の fixture）。`mozilla` では使えない。 */
  readonly connect?: string;
  readonly outDir: string;
  readonly payerPrivateKey: string;
  /** false: quote で止まる（checkpoint を書く）。true: 同じ `outDir` の checkpoint を再開して最後まで。 */
  readonly approve: boolean;
  /** 実 Provider（`mozilla`）で必須: 支払い範囲の記録（JSON）。sha256 を証跡に書く。 */
  readonly scopeFile?: string;
  readonly requestId?: string;
  readonly sessionTimeoutSecs?: number;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
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
  intentSha256?: string;
  orderId?: string;
  paymentId?: string;
  /** どこまで進んだか（失敗したときはその段）。 */
  stage?: string;
  /** Router の最後に読めた状態（best effort）。 */
  routerStatus?: { status?: string; terminalReason?: string };
  /** 5 つのゲート（別々）。`uncertain: true` は「分からない」（払ったかもしれない）。 */
  readonly gates: {
    inbound_settlement: { settled: boolean; txRef?: string; eventId?: string; uncertain?: true };
    outbound_settlement: { issued: boolean; txRef?: string; receipt: boolean; uncertain?: true };
    private_delivery: { status?: string; terminalReason?: string; proof?: unknown; recordSha256?: string; recordRepeatable?: boolean };
    payer_receipt: { ok: boolean; verifiedBundleBeforeDecrypt?: boolean; decryptedSha256?: string; payloadLen?: number; failedStage?: string };
    finality: { checked: false; note: string };
  };
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
  readonly args: { readonly routerBaseUrl: string; readonly principalId: string; readonly profileId: string; readonly method: string; readonly host: string; readonly path: string; readonly outbound: PrivatePayerOptions["outbound"]; readonly inbound: NonNullable<PrivatePayerOptions["inbound"]>; readonly trust: string };
  /** 進んだ段（再開・回復の判断用）。 */
  progress?: { paymentId?: string; purchaseAttempted?: boolean; handedOver?: boolean; sessionDone?: boolean; attested?: boolean };
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
function runBinary(bin: string, srs: string, args: readonly string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bin, [...args], { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", DELIVERY_SRS_DAT: srs, RUST_LOG: "warn" }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
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
async function fillFromStatus(client: RouterClient & PrivateRouterClient, paymentId: string, ownerKey: string, evidence: PrivatePayerEvidence): Promise<void> {
  try {
    const status = await client.status(paymentId, ownerKey);
    if (!status.found) return;
    const projection = status.projection as unknown as { status?: string; terminalReason?: string; source?: { txRef?: string; eventId?: string }; destination?: { txRef?: string }; private?: { outbound?: { issued?: boolean } } };
    evidence.routerStatus = { ...(projection.status === undefined ? {} : { status: projection.status }), ...(projection.terminalReason === undefined ? {} : { terminalReason: projection.terminalReason }) };
    if (projection.source?.txRef !== undefined) {
      evidence.gates.inbound_settlement = { settled: true, txRef: projection.source.txRef, ...(projection.source.eventId === undefined ? {} : { eventId: projection.source.eventId }) };
    }
    if (projection.private?.outbound?.issued === true) {
      const { uncertain: _u, ...rest } = evidence.gates.outbound_settlement;
      evidence.gates.outbound_settlement = { ...rest, issued: true };
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
  return { routerBaseUrl: options.routerBaseUrl, principalId: options.principalId, profileId: options.profileId, method: options.method, host: options.host, path: options.path, outbound: options.outbound, inbound, trust: options.trust };
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
  if (!/^0x[0-9a-fA-F]{64}$/.test(options.payerPrivateKey)) return fail("prerequisites", "SUBETHA_PAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
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
    mkdirSync(path.join(exec, "private_inbox"), { recursive: true, mode: 0o700 });
    const orderId = `${"0".repeat(32)}${randomBytes(16).toString("hex")}`;
    const keygenArgs = ["payer-keygen", "--payer-dir", keys, "--order-id", orderId, "--host", options.host, "--port", "443", "--path", options.path];
    if (options.method === "POST") {
      if (options.bodyFile === undefined) return fail("keygen", "--body-file is required for POST");
      keygenArgs.push("--post-profile", "canonical", "--body-file", options.bodyFile);
    } else {
      keygenArgs.push("--method", "GET");
    }
    const keygen = await runBinary(bin, srs, keygenArgs, 60_000);
    if (keygen.code !== 0) return fail("keygen", "payer-keygen failed (see lab binary stderr; not recorded)");
    const order = JSON.parse(readFileSync(path.join(keys, "order.json"), "utf8")) as unknown;
    const intentBytes = envelopeBytesOf(order, options.outbound, inbound);
    evidence.intentSha256 = sha256Hex(intentBytes);
    evidence.orderId = orderId;
    writePrivate(intentFile, intentBytes);
    const requestId = options.requestId ?? `pp-${evidence.runId}`;
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
    log(`private-payer: quoted paymentId=${quote.paymentId} intentSha256=${evidence.intentSha256} total=${String((quote.pricing as Record<string, unknown>)["total"])} (review ${quoteFile}, then re-run with --approve)`);
    return { ok: true, stage: "quoted", quote, evidence };
  }

  // 2. 承認: 同じ --out の checkpoint を再開する（keygen・quote はやり直さない）。
  const found = readCheckpoint(options.outDir);
  if (found === undefined) return fail("approve", "no reviewed quote in --out (run once without --approve, review quote.json, then re-run with --approve in the same --out)");
  checkpoint = found;
  if (stableJson(checkpoint.args) !== stableJson(argsOf(options, inbound))) return fail("approve", "the arguments differ from the reviewed quote (router/principal/profile/method/host/path/outbound/inbound/trust); quote again in a new --out");
  if (!existsSync(quoteFile) || sha256Hex(readFileSync(quoteFile)) !== checkpoint.quoteFileSha256) return fail("approve", "quote.json was modified or removed after the review; quote again in a new --out");
  if (checkpoint.progress?.handedOver === true) return fail("approve", "this purchase was already handed over; use --recover to read its status/record");
  if (checkpoint.progress?.purchaseAttempted === true) return fail("approve", "a purchase was already attempted for this quote (its outcome may be unknown); never re-sign — use --recover to read status/record");
  const quote = checkpoint.quote;
  if (now() >= quote.approval.deadlineMs) return fail("approve", "the reviewed quote has expired; quote again in a new --out and review it again");
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
  // 受信 credential（自分の鍵。EIP-3009。資金はこの後の Router の settle で動く）。
  const offer = quote.source.offer as { network: string; extra: Record<string, unknown> } & Record<string, unknown>;
  const chainId = Number(String(offer.network).replace(/^eip155:/, ""));
  const credential = await createX402Payer(options.payerPrivateKey).credentialFor(offer as never, chainId);

  // 4. purchase → 引き渡し。応答を失ったら「払ったかもしれない」。
  let purchased: Awaited<ReturnType<typeof client.privatePurchase>>;
  try {
    purchased = await client.privatePurchase({ quote, requestId, approval: { approved: true, quoteId: quote.quoteId }, credential });
  } catch {
    evidence.gates.inbound_settlement = { settled: false, uncertain: true };
    evidence.gates.outbound_settlement = { issued: false, receipt: false, uncertain: true };
    await fillFromStatus(client, quote.paymentId, quote.ownerKey, evidence);
    return fail("purchase", "the purchase response was lost (transport); the Router may have settled the inbound leg — read status with --recover, do not re-pay");
  }
  if (purchased.outcome !== "awaiting_session") {
    const detail = "reason" in purchased ? purchased.reason : "error" in purchased ? purchased.error : purchased.outcome;
    if (purchased.outcome === "unknown") {
      evidence.gates.inbound_settlement = { settled: false, uncertain: true };
      evidence.gates.outbound_settlement = { issued: false, receipt: false, uncertain: true };
    }
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
  const failAfterHandover = async (stage: string, reason: string): Promise<PrivatePayerRun> => {
    await fillFromStatus(client, paymentId, quote.ownerKey, evidence);
    return fail(stage, `${reason} (the inbound leg is settled and the credential was released: the outbound outcome is unknown until the Router's deadlines; do not re-pay; use --recover to read status/record)`);
  };

  // 5. finalize → session → prove（Payer の executor。Router は本文を見ない）。
  const finalize = await runBinary(bin, srs, ["payer-finalize-order", "--intent", intentFile, "--payment-header-file", headerFile, "--out", orderFinal], 60_000);
  if (finalize.code !== 0) return failAfterHandover("finalize", "payer-finalize-order failed");
  const requestPrivate = path.join(exec, "private_inbox", "request_private.json");
  if (options.method === "POST") copyFileSync(path.join(keys, "request_private.json"), requestPrivate);
  const timeoutSecs = options.sessionTimeoutSecs ?? Math.max(30, Math.floor((handover.deadlines.sessionBy - now()) / 1000));
  const sessionArgs = ["executor-session", "--executor-dir", exec, "--order", orderFinal, "--verifier-addr", handover.verifier.address, "--host", options.host, "--port", "443", "--path", options.path, "--trust", options.trust, "--timeout-secs", String(timeoutSecs)];
  if (options.method === "POST") sessionArgs.push("--request-private", requestPrivate);
  if (options.connect !== undefined) sessionArgs.push("--connect", options.connect);
  const session = await runBinary(bin, srs, sessionArgs, (timeoutSecs + 60) * 1000);
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
  const prove = await runBinary(bin, srs, proveArgs, 900_000);
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
  const run = await runBinary(bin, srs, ["payer-decrypt", "--payer-dir", keys, "--order", orderFinal, "--record", recordFile, "--bundle", bundleFile, "--expect-host", options.host, "--expect-port", "443", "--expect-path", options.path, "--intent", intentFile, "--release", releaseFile, "--result-name", resultName], 600_000);
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
}
export type PrivatePayerRecovery =
  | { readonly ok: true; readonly paymentId: string; readonly status: Record<string, unknown> | undefined; readonly recordAvailable: boolean; readonly decrypted: boolean; readonly evidence: PrivatePayerEvidence }
  | { readonly ok: false; readonly reason: string };

/** 応答を失ったとき・別プロセスから: checkpoint の ownerKey で status と record を読み直し、手元に bundle があれば復号する。何も払わない。 */
export async function recoverPrivatePayer(options: PrivatePayerRecoverOptions): Promise<PrivatePayerRecovery> {
  const checkpoint = readCheckpoint(options.outDir);
  if (checkpoint === undefined) return { ok: false, reason: "no checkpoint in --out" };
  if (checkpoint.args.routerBaseUrl !== options.routerBaseUrl || checkpoint.args.principalId !== options.principalId) return { ok: false, reason: "the checkpoint belongs to another Router/principal" };
  const client = createRouterClient({ baseUrl: options.routerBaseUrl, principalId: options.principalId, token: options.token, allowUnissuedQuotes: true });
  const paymentId = checkpoint.progress?.paymentId ?? checkpoint.quote.paymentId;
  // 既にある証跡を引き継ぐ（分かったことを消さない）。提出したが結果が分からない購入は、status が読めるまで両決済を uncertain とする。
  const evidence = loadEvidence(options.outDir, newEvidence({ trust: checkpoint.args.trust as "mozilla" | "lab-fixture-ca", method: checkpoint.args.method, host: checkpoint.args.host, path: checkpoint.args.path }));
  evidence.paymentId = paymentId;
  evidence.intentSha256 = checkpoint.intentSha256;
  evidence.orderId = checkpoint.orderId;
  evidence.stage = "recover";
  if (checkpoint.progress?.handedOver === true) {
    evidence.gates.inbound_settlement = { ...evidence.gates.inbound_settlement, settled: true };
    evidence.gates.outbound_settlement.issued = true;
  } else if (checkpoint.progress?.purchaseAttempted === true && !evidence.gates.inbound_settlement.settled) {
    evidence.gates.inbound_settlement = { ...evidence.gates.inbound_settlement, uncertain: true };
    evidence.gates.outbound_settlement = { ...evidence.gates.outbound_settlement, uncertain: true };
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
    if (existsSync(bundleFile) && existsSync(orderFinal) && existsSync(bin) && existsSync(srs)) {
      const result = await decryptLocally(bin, srs, { host: checkpoint.args.host, path: checkpoint.args.path }, path.join(options.outDir, "keys"), orderFinal, recordFile, bundleFile, path.join(options.outDir, "intent.json"), path.join(options.outDir, "release.json"));
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
    const recovered = await recoverPrivatePayer({ routerBaseUrl: requireArg("router"), principalId: requireArg("principal"), token, outDir: requireArg("out"), ...(argOf("lab-dir") === undefined ? {} : { labDir: argOf("lab-dir")! }) });
    process.stdout.write(`${JSON.stringify(recovered.ok ? { ok: true, paymentId: recovered.paymentId, status: recovered.status?.["status"], terminalReason: recovered.status?.["terminalReason"], recordAvailable: recovered.recordAvailable, decrypted: recovered.decrypted, evidence: recovered.evidence } : recovered)}\n`);
    if (!recovered.ok) process.exit(1);
    return;
  }
  const key = process.env["SUBETHA_PAYER_PRIVATE_KEY"];
  if (key === undefined || key === "") {
    process.stderr.write("SUBETHA_PAYER_PRIVATE_KEY is required (env only)\n");
    process.exit(2);
  }
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
  const trust = argOf("trust") ?? "mozilla";
  if (trust !== "mozilla" && trust !== "lab-fixture-ca") {
    process.stderr.write("--trust must be mozilla or lab-fixture-ca\n");
    process.exit(2);
  }
  const inboundMaxTotal = argOf("inbound-max-total");
  const outDir = requireArg("out");
  const run = await runPrivatePayer({
    routerBaseUrl: requireArg("router"),
    principalId: requireArg("principal"),
    token,
    profileId: requireArg("profile"),
    ...(argOf("lab-dir") === undefined ? {} : { labDir: argOf("lab-dir")! }),
    method,
    host: requireArg("host"),
    path: requireArg("path"),
    ...(argOf("body-file") === undefined ? {} : { bodyFile: argOf("body-file")! }),
    outbound: { protocol, network: requireArg("outbound-network"), asset: requireArg("outbound-asset"), payTo: requireArg("outbound-pay-to"), maxAmount: requireArg("outbound-max-amount") },
    ...(inboundMaxTotal === undefined ? {} : { inbound: { network: PRIVATE_INBOUND_NETWORK, asset: PRIVATE_INBOUND_ASSET, maxTotal: inboundMaxTotal } }),
    trust,
    ...(argOf("connect") === undefined ? {} : { connect: argOf("connect")! }),
    outDir,
    payerPrivateKey: key,
    approve: process.argv.includes("--approve"),
    ...(argOf("scope-file") === undefined ? {} : { scopeFile: argOf("scope-file")! }),
  });
  if (run.ok && run.stage === "quoted") {
    process.stdout.write(`${JSON.stringify({ stage: "quoted", paymentId: run.quote.paymentId, approvalSubjectFile: path.join(outDir, "quote.json"), note: "no payment was made; review quote.json, then re-run the same command with --approve (same --out)" })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(run.ok ? { stage: run.stage, paymentId: run.paymentId, evidence: run.evidence } : { stage: run.stage, reason: run.reason, evidence: run.evidence })}\n`);
  if (!run.ok) process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // 例外の文字列は鍵・URL を含み得るので固定文だけ。
    process.stderr.write(`private-payer: failed (${error instanceof Error ? error.name : "error"})\n`);
    process.exit(1);
  });
}
