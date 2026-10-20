/**
 * 秘匿購入の **Payer 側**の手順（`docs/zktls-router-design.md` §2・§11、`docs/zktls-router-acceptance.md`）。**製品コードではない**（鍵を扱う Payer の起動側）。
 *
 * 封筒（lab の `payer-keygen` の注文 + 両レグの承認）→ quote → [承認] → 受信 credential（EIP-3009、自分の鍵）→ purchase（引き渡し）→ `payer-finalize-order`
 * → `executor-session`（実 MPC-TLS。Verifier は Router が起動した loopback）→ `executor-prove` → attest → record（2 回・同一）→ `payer-decrypt` → 平文。
 *
 * - `--approve` が無ければ **quote だけ**で止まる（承認対象を `quote.json` に書く。支払いも署名もしない）。
 * - `--trust mozilla`（実 Provider）では **支払い範囲の記録**（`--scope-file`、AGENTS.md）が無いと走らない。`lab-fixture-ca` の証跡は synthetic。
 * - 鍵は env `SUBETHA_PAYER_PRIVATE_KEY` だけから読み、出力・証跡・例外に出さない。bearer（発行ヘッダ）は 0600 のファイル（`payment_header.json`・`order_final.json`）にだけ置く。
 * - 証跡 `evidence.json` は **5 つのゲートを別々に**記録する: 受信決済・送信決済・秘匿配送・Payer 受領（復号）・finality（本 v1 は未確認と明記）。
 *
 * usage: SUBETHA_PAYER_PRIVATE_KEY=0x… PRIVATE_PAYER_TOKEN=… npx tsx tools/private-payer.ts --router http://127.0.0.1:<port> --principal <id> --profile <profileId> \
 *          --method POST --host provider-x402-post.subethalabs.com --path /select --body-file body.json \
 *          --outbound-protocol x402 --outbound-network eip155:84532 --outbound-asset 0x036C… --outbound-pay-to 0x9014… --outbound-max-amount 10000 \
 *          --inbound-max-total 11000 --trust mozilla --scope-file runtime/private-live/<run>/scope.json --out runtime/private-live/<run> [--approve] [--connect 127.0.0.1:<port>]
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createRouterClient } from "../src/client/index.js";
import type { PrivateHandoverView, PrivateQuoteView } from "../src/client/types.js";
import { createX402Payer } from "./x402-payer.js";

export const PRIVATE_INBOUND_NETWORK = "eip155:84532";
export const PRIVATE_INBOUND_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

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
  readonly approve: boolean;
  /** 実 Provider（`mozilla`）で必須: 支払い範囲の記録（JSON）。sha256 を証跡に書く。 */
  readonly scopeFile?: string;
  readonly requestId?: string;
  readonly sessionTimeoutSecs?: number;
  readonly log?: (line: string) => void;
}

export interface PrivatePayerEvidence {
  readonly runId: string;
  readonly startedAt: string;
  readonly trust: "mozilla" | "lab-fixture-ca";
  /** fixture CA の証跡は synthetic（公開 PKI の受入の代わりにならない）。 */
  readonly synthetic: boolean;
  readonly provider: { readonly method: string; readonly host: string; readonly path: string };
  readonly scopeFileSha256?: string;
  intentSha256?: string;
  orderId?: string;
  paymentId?: string;
  /** 5 つのゲート（別々）。 */
  readonly gates: {
    inbound_settlement: { settled: boolean; txRef?: string; eventId?: string };
    outbound_settlement: { issued: boolean; txRef?: string; receipt: boolean };
    private_delivery: { status?: string; terminalReason?: string; proof?: unknown; recordSha256?: string; recordRepeatable?: boolean };
    payer_receipt: { ok: boolean; verifiedBundleBeforeDecrypt?: boolean; decryptedSha256?: string; payloadLen?: number; failedStage?: string };
    finality: { checked: false; note: string };
  };
}

export type PrivatePayerRun =
  | { readonly ok: true; readonly stage: "quoted"; readonly quote: PrivateQuoteView; readonly evidence: PrivatePayerEvidence }
  | { readonly ok: true; readonly stage: "delivered"; readonly paymentId: string; readonly plaintext: Buffer; readonly evidence: PrivatePayerEvidence; readonly files: { readonly outDir: string; readonly decrypt: string } }
  | { readonly ok: false; readonly stage: string; readonly reason: string; readonly evidence: PrivatePayerEvidence };

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

/** 封筒（設計 §5.1）: compact JSON。`order` は lab の `payer-keygen` が書いた注文そのもの。 */
export function envelopeBytesOf(order: unknown, outbound: PrivatePayerOptions["outbound"], inbound: NonNullable<PrivatePayerOptions["inbound"]>): Buffer {
  return Buffer.from(JSON.stringify({ version: "phase5-intent-v1", order, outbound: { protocol: outbound.protocol, network: outbound.network, asset: outbound.asset, payTo: outbound.payTo, maxAmount: outbound.maxAmount }, inbound: { network: inbound.network, asset: inbound.asset, maxTotal: inbound.maxTotal } }), "utf8");
}

export async function runPrivatePayer(options: PrivatePayerOptions): Promise<PrivatePayerRun> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const labDir = options.labDir ?? defaultLabDir();
  const bin = path.join(labDir, "phase5/runner/target/release/delivery");
  const srs = options.srsPath ?? defaultSrsPath();
  const inbound = options.inbound ?? { network: PRIVATE_INBOUND_NETWORK, asset: PRIVATE_INBOUND_ASSET, maxTotal: String(BigInt(options.outbound.maxAmount) + 1000n) };
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const evidence: PrivatePayerEvidence = {
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
  const fail = (stage: string, reason: string): PrivatePayerRun => {
    log(`private-payer: ${stage}: ${reason}`);
    persistEvidence();
    return { ok: false, stage, reason, evidence };
  };
  mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
  const persistEvidence = (): void => writePrivate(path.join(options.outDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);

  // 0. 前提: バイナリ・SRS、支払い範囲の記録（実 Provider）。
  if (!existsSync(bin) || !existsSync(srs)) return fail("prerequisites", "lab delivery binary or SRS not found (SUBETHA_ZKTLS_LAB_DIR / SUBETHA_ZKTLS_SRS_DAT)");
  if (options.trust === "mozilla") {
    if (options.connect !== undefined) return fail("prerequisites", "--connect is a fixture-only option and cannot be used with --trust mozilla");
    if (options.scopeFile === undefined || !existsSync(options.scopeFile)) return fail("prerequisites", "a payment scope record (--scope-file) is required before any live payment (AGENTS.md)");
    (evidence as { scopeFileSha256?: string }).scopeFileSha256 = sha256Hex(readFileSync(options.scopeFile));
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(options.payerPrivateKey)) return fail("prerequisites", "SUBETHA_PAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");

  // 1. keygen（Payer の鍵・salt・注文の骨格。本文は Payer の手元にだけ）。
  const keys = path.join(options.outDir, "keys");
  const exec = path.join(options.outDir, "executor");
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
  const intentFile = path.join(options.outDir, "intent.json");
  writePrivate(intentFile, intentBytes);

  // 2. quote（Router は封筒だけを見る）。
  const client = createRouterClient({ baseUrl: options.routerBaseUrl, principalId: options.principalId, token: options.token });
  const requestId = options.requestId ?? `pp-${runId}`;
  const quoted = await client.privateQuote({ profileId: options.profileId, requestId, intentB64: intentBytes.toString("base64") });
  if (!quoted.ok) return fail("quote", `${quoted.error}${quoted.reason === undefined ? "" : ` (${quoted.reason})`}`);
  const quote = quoted.quote;
  evidence.paymentId = quote.paymentId;
  // 承認対象（ownerKey は除く: 持ち主の証明は表示・保存の対象ではない）。
  const { ownerKey: _ownerKey, ...subject } = quote;
  writePrivate(path.join(options.outDir, "quote.json"), `${JSON.stringify(subject, null, 2)}\n`);
  log(`private-payer: quoted paymentId=${quote.paymentId} intentSha256=${evidence.intentSha256} total=${String((quote.pricing as Record<string, unknown>)["total"])}`);
  if (!options.approve) {
    persistEvidence();
    return { ok: true, stage: "quoted", quote, evidence };
  }

  // 3. 受信 credential（自分の鍵。EIP-3009。資金はこの後の Router の settle で動く）。
  const offer = quote.source.offer as { network: string; extra: Record<string, unknown> } & Record<string, unknown>;
  const chainId = Number(String(offer.network).replace(/^eip155:/, ""));
  const credential = await createX402Payer(options.payerPrivateKey).credentialFor(offer as never, chainId);

  // 4. purchase → 引き渡し。
  const purchased = await client.privatePurchase({ quote, requestId, approval: { approved: true, quoteId: quote.quoteId }, credential });
  if (purchased.outcome !== "awaiting_session") {
    const detail = "reason" in purchased ? purchased.reason : "error" in purchased ? purchased.error : purchased.outcome;
    // unknown は「払ったかもしれない」。再試行しない。
    return fail("purchase", `${purchased.outcome}: ${String(detail)}`);
  }
  const handover: PrivateHandoverView = purchased.handover;
  const paymentId = handover.paymentId;
  evidence.gates.outbound_settlement.issued = true;
  const headerFile = path.join(options.outDir, "payment_header.json");
  const releaseFile = path.join(options.outDir, "release.json");
  const orderFinal = path.join(options.outDir, "order_final.json");
  writePrivate(headerFile, JSON.stringify(handover.headerFile));
  writePrivate(releaseFile, Buffer.from(handover.releaseB64, "base64"));
  log(`private-payer: handover verifier=${handover.verifier.address} sessionBy=${new Date(handover.deadlines.sessionBy).toISOString()}`);

  // 5. finalize → session → prove（Payer の executor。Router は本文を見ない）。
  const finalize = await runBinary(bin, srs, ["payer-finalize-order", "--intent", intentFile, "--payment-header-file", headerFile, "--out", orderFinal], 60_000);
  if (finalize.code !== 0) return fail("finalize", "payer-finalize-order failed");
  const requestPrivate = path.join(exec, "private_inbox", "request_private.json");
  if (options.method === "POST") copyFileSync(path.join(keys, "request_private.json"), requestPrivate);
  const timeoutSecs = options.sessionTimeoutSecs ?? Math.max(30, Math.floor((handover.deadlines.sessionBy - Date.now()) / 1000));
  const sessionArgs = ["executor-session", "--executor-dir", exec, "--order", orderFinal, "--verifier-addr", handover.verifier.address, "--host", options.host, "--port", "443", "--path", options.path, "--trust", options.trust, "--timeout-secs", String(timeoutSecs)];
  if (options.method === "POST") sessionArgs.push("--request-private", requestPrivate);
  if (options.connect !== undefined) sessionArgs.push("--connect", options.connect);
  const session = await runBinary(bin, srs, sessionArgs, (timeoutSecs + 60) * 1000);
  if (session.code !== 0) return fail("session", "executor-session failed (the Router keeps the outcome as unknown until its session deadline; do not re-pay)");
  const until = handover.deadlines.sessionBy + 60_000;
  for (;;) {
    const status = await client.status(paymentId, quote.ownerKey);
    if (status.found && (status.projection as { status: string }).status === "attesting") break;
    if (Date.now() > until) return fail("session", "the Router did not recognize the record before the session deadline");
    await sleep(500);
  }
  const proveArgs = ["executor-prove", "--executor-dir", exec, "--order", orderFinal];
  if (options.method === "POST") proveArgs.push("--request-private", requestPrivate);
  const prove = await runBinary(bin, srs, proveArgs, 900_000);
  if (prove.code !== 0) return fail("prove", "executor-prove failed");
  const bundle = readFileSync(path.join(exec, "bundle.json"));

  // 6. attest → record ×2 → status（Router の判定。bearer は返ってこない）。
  const attested = await client.privateAttest({ paymentId, ownerKey: quote.ownerKey, bundleB64: bundle.toString("base64") });
  if (!attested.ok) return fail("attest", attested.error);
  evidence.gates.private_delivery.status = attested.status;
  if (attested.terminalReason !== undefined) evidence.gates.private_delivery.terminalReason = attested.terminalReason;
  if (isRecord(attested.private) && attested.private["proof"] !== undefined) evidence.gates.private_delivery.proof = attested.private["proof"];
  const record1 = await client.privateRecord({ paymentId, ownerKey: quote.ownerKey });
  const record2 = await client.privateRecord({ paymentId, ownerKey: quote.ownerKey });
  if (!record1.ok || !record2.ok) return fail("record", record1.ok ? (record2 as { error: string }).error : record1.error);
  const recordBytes = Buffer.from(record1.recordB64, "base64");
  evidence.gates.private_delivery.recordSha256 = sha256Hex(recordBytes);
  evidence.gates.private_delivery.recordRepeatable = record1.recordB64 === record2.recordB64 && record1.releaseB64 === handover.releaseB64;
  const recordFile = path.join(options.outDir, "record.json");
  writePrivate(recordFile, recordBytes);
  const status = await client.status(paymentId, quote.ownerKey);
  if (status.found) {
    const projection = status.projection as unknown as { source?: { txRef?: string; eventId?: string }; destination?: { txRef?: string }; private?: Record<string, unknown> };
    if (projection.source?.txRef !== undefined) evidence.gates.inbound_settlement = { settled: true, txRef: projection.source.txRef, ...(projection.source.eventId === undefined ? {} : { eventId: projection.source.eventId }) };
    if (projection.destination?.txRef !== undefined) evidence.gates.outbound_settlement = { issued: true, txRef: projection.destination.txRef, receipt: true };
  }

  // 7. Payer の復号（手元で bundle を検証してから）。
  const bundleFile = path.join(options.outDir, "bundle.json");
  writePrivate(bundleFile, bundle);
  const decrypt = await runBinary(bin, srs, ["payer-decrypt", "--payer-dir", keys, "--order", orderFinal, "--record", recordFile, "--bundle", bundleFile, "--expect-host", options.host, "--expect-port", "443", "--expect-path", options.path, "--intent", intentFile, "--release", releaseFile], 600_000);
  const resultFile = path.join(keys, "decrypt_result.json");
  const result = existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, "utf8")) as Record<string, unknown>) : undefined;
  evidence.gates.payer_receipt = {
    ok: decrypt.code === 0 && result?.["ok"] === true,
    ...(result === undefined ? {} : { verifiedBundleBeforeDecrypt: result["verified_bundle_before_decrypt"] === true, decryptedSha256: String(result["decrypted_sha256"]), payloadLen: Number(result["payload_len"]) }),
    ...(typeof result?.["failed_stage"] === "string" ? { failedStage: result["failed_stage"] } : {}),
  };
  persistEvidence();
  if (!evidence.gates.payer_receipt.ok) return fail("decrypt", "payer-decrypt did not succeed");
  if (attested.status !== "delivered_private") return fail("attest", `Router outcome ${attested.status}${attested.terminalReason === undefined ? "" : ` (${attested.terminalReason})`}`);
  const decryptFile = path.join(keys, "decrypt.bin");
  log(`private-payer: delivered paymentId=${paymentId} decryptedSha256=${String(result?.["decrypted_sha256"])} inboundTx=${evidence.gates.inbound_settlement.txRef ?? "-"} outboundTx=${evidence.gates.outbound_settlement.txRef ?? "-"}`);
  return { ok: true, stage: "delivered", paymentId, plaintext: readFileSync(decryptFile), evidence, files: { outDir: options.outDir, decrypt: decryptFile } };
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
  const key = process.env["SUBETHA_PAYER_PRIVATE_KEY"];
  const token = process.env["PRIVATE_PAYER_TOKEN"];
  if (key === undefined || key === "" || token === undefined || token === "") {
    process.stderr.write("SUBETHA_PAYER_PRIVATE_KEY and PRIVATE_PAYER_TOKEN are required (env only)\n");
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
    outDir: requireArg("out"),
    payerPrivateKey: key,
    approve: process.argv.includes("--approve"),
    ...(argOf("scope-file") === undefined ? {} : { scopeFile: argOf("scope-file")! }),
  });
  if (run.ok && run.stage === "quoted") {
    process.stdout.write(`${JSON.stringify({ stage: "quoted", paymentId: run.quote.paymentId, approvalSubjectFile: path.join(requireArg("out"), "quote.json"), note: "no payment was made; re-run with --approve after reviewing quote.json" })}\n`);
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
