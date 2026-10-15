/**
 * 受信レグの `credential`（base64 の `X-Payment`）を**手元で**作る。
 * **製品コードではない**（鍵を扱う側）。
 *
 *   npm run sign -- '<quote tool が返した quote の JSON>'
 *
 * 出力は base64 の 1 行。それを `subetha_router_purchase` の `credential` に渡す。
 *
 * **受信レールは offer の `scheme` で判定する**（呼び出し側が指定しない）:
 *
 * | scheme ＋ network | レール | 性質 |
 * |---|---|---|
 * | `exact` ＋ `eip155:` | x402 / EVM（Base Sepolia・Arc testnet） | **署名するだけ**。送信と gas は facilitator 負担 |
 * | `exact` ＋ `solana:` | x402 / Solana devnet | **部分署名するだけ**。送信と手数料は facilitator の fee payer |
 * | `tempo/charge` | MPP / Tempo | **この場でチェーンに送金する**。手数料も自分持ち |
 * | `solana/charge` | MPP / Solana devnet | **全署名するだけ**。送出は Router（purchase）。手数料（SOL）は自分持ち。blockhash の寿命の中で purchase を呼ぶ |
 *
 * **MPP は署名ではなく送金**である点に注意。このコマンドを実行した時点で
 * **資金が動き、失敗しても戻らない**。だから実行前に必ず人間の承認を取ること。
 *
 * **鍵はこのマシンから出ない。** Router に送るのは**署名済みの credential だけ**で、
 * 秘密鍵そのものは送信されない（Router 側も鍵を保持しない設計）。
 *
 * EIP-712 の chainId・domain は **network の表**から引き、offer の domain が表と違えば署名しない（SR-7）。
 *
 * 診断（`docs/rejection-reasons-design.md` §12.7・§13.2）: env `SUBETHA_SIGN_DIAGNOSTICS=<path>` があるときだけ file sink
 * （component `signer`、8 MiB）を作り、`runSign` の段と Tempo の payer の RPC の観測（要求の側と HTTP の status・例外の分類だけ）を記録する。
 * 無ければ今と同じ（payer に `fetchFn` も渡さない）。どの終了（成功・拒否・`process.exit(2)`・投げられた失敗）の前にも
 * 上限つき（500 ms）で flush する（best effort。時間切れ・失敗は無視）。stdout・stderr・終了コードは記録の有無で変わらない。
 */

import { readFileSync } from "node:fs";

import { safeEmit, withDiagnosticScope, type DiagCapture, type DiagScope } from "../src/shared/diagnostics.js";
import { createFileDiagnosticsSink, type FileDiagnosticsSink } from "../src/shared/diagnostics-file.js";

import { createMppPayer } from "./mpp-payer.js";
import { createSignTracker, observedRpcFetch, type SignDiagnosticState } from "./sign-diagnostics.js";
import { runSign, type SignOutcome } from "./sign-run.js";
import { createSvmMppPayer } from "./svm-mpp-payer.js";
import { createSvmPayer } from "./svm-payer.js";
import { SVM_RPC_ALLOW_LOOPBACK_ENV } from "./svm-rpc.js";
import { createX402Payer } from "./x402-payer.js";

/** 診断の記録のファイル（無ければ記録しない）。 */
const SIGN_DIAGNOSTICS_ENV = "SUBETHA_SIGN_DIAGNOSTICS";
/** 終了の前の flush の上限（§13.2）。 */
const FLUSH_TIMEOUT_MS = 500;

function envValue(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const text = readFileSync(".env.local", "utf8");
    const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
    if (line !== undefined) return line.slice(name.length + 1).trim();
  } catch {
    // .env.local が無いだけ。
  }
  return undefined;
}

const diagnosticsPath = process.env[SIGN_DIAGNOSTICS_ENV];
const sink: FileDiagnosticsSink | undefined = (() => {
  if (diagnosticsPath === undefined || diagnosticsPath === "") return undefined;
  try {
    return createFileDiagnosticsSink({ path: diagnosticsPath, component: "signer" });
  } catch {
    return undefined;
  }
})();

/** 記録を書き終えるのを上限つきで待つ（reject しない）。 */
async function flushDiagnostics(): Promise<void> {
  if (sink === undefined) return;
  try {
    await sink.flush({ timeoutMs: FLUSH_TIMEOUT_MS });
  } catch {
    // best effort。
  }
}

/** flush してから終わる（`process.exit` の前に必ず通す）。 */
async function exitAfterFlush(code: number): Promise<never> {
  await flushDiagnostics();
  process.exit(code);
}

/** 鍵が無い（固定の文を stderr に書いた後、flush してから exit 2 にするための印）。 */
class KeyMissing extends Error {}

function requireKey(name: string, hint: string): string {
  const key = envValue(name);
  if (key !== undefined) return key;
  process.stderr.write(`${name} is not set. Run \`${hint}\` to create one.\n`);
  throw new KeyMissing();
}

const raw = process.argv[2];
if (raw === undefined || raw.trim() === "") {
  process.stderr.write(
    "usage: npm run sign -- '<the quote JSON returned by the quote tool>'\n" +
      "  Pass the `quote` field from the quote response, unchanged.\n",
  );
  await exitAfterFlush(2);
}

let quote: unknown;
try {
  quote = JSON.parse(raw as string);
} catch {
  process.stderr.write("The argument is not readable as JSON. Pass the quote unchanged.\n");
  await exitAfterFlush(2);
}

/**
 * 1 行の記録（`stage:"sign"`）。値は観測した状態の写しだけ。scope は積む時点に重ねる（`runSign` を scope で包まない:
 * 包むと投げられた失敗の stack に枠が 1 つ増え、stderr が今と変わる）。
 */
function record(state: SignDiagnosticState, outcome?: "signed" | "threw"): void {
  if (sink === undefined) return;
  try {
    void withDiagnosticScope(recordScope, async () => emitRecord(state, outcome)).catch(() => {});
  } catch {
    // 診断の失敗は署名の経路に出さない。
  }
}
function emitRecord(state: SignDiagnosticState, outcome?: "signed" | "threw"): void {
  safeEmit(sink, (): DiagCapture => ({
    stage: "sign",
    broadcast: state.broadcast,
    ...(state.signerStage === undefined ? {} : { signerStage: state.signerStage }),
    ...(state.rpc === undefined ? {} : { rpc: state.rpc }),
    ...(state.rpcHttpStatus === undefined ? {} : { rpcHttpStatus: state.rpcHttpStatus }),
    ...(state.txRef === undefined ? {} : { txRef: state.txRef }),
    ...(outcome === undefined ? {} : { outcome }),
  }));
}

/** 記録の scope（quote 文書の `quoteId` は hash にして残る。`paymentId` は Router の形のときだけ）。 */
function scopeOf(value: unknown): DiagScope {
  if (sink === undefined || typeof value !== "object" || value === null) return {};
  const doc = value as Record<string, unknown>;
  const quoteId = doc["quoteId"];
  const paymentId = doc["paymentId"];
  return {
    ...(typeof quoteId === "string" && quoteId !== "" ? { quoteId } : {}),
    ...(typeof paymentId === "string" && /^[0-9a-f-]{36}$/.test(paymentId) ? { paymentId } : {}),
  };
}

const recordScope = scopeOf(quote);
const tracker = createSignTracker(sink === undefined ? undefined : (state) => record(state));
const solanaRpcUrl = envValue("SOLANA_RPC_URL");
// loopback の Solana RPC は既定で拒む（Router と同じ transport の方針）。手元の node・fixture に向けるときだけ `SOLANA_RPC_ALLOW_LOOPBACK=1`。
const solanaRpcAllowLoopback = envValue(SVM_RPC_ALLOW_LOOPBACK_ENV) === "1";
let outcome: SignOutcome;
try {
  outcome = await runSign(quote, {
    nowMs: Date.now,
    readEvmKey: () => requireKey("SUBETHA_PAYER_PRIVATE_KEY", "npm run wallet:new"),
    readSolanaKey: () => requireKey("SOLANA_PAYER_PRIVATE_KEY", "npm run wallet:new:solana"),
    ...(solanaRpcUrl === undefined ? {} : { solanaRpcUrl }),
    ...(solanaRpcAllowLoopback ? { solanaRpcAllowLoopback } : {}),
    // 記録するときだけ RPC の HTTP を観測で包む（要求は同じ。記録しなければ今と同じく `fetchFn` を渡さない）。
    mppPayer: (key, scope) => createMppPayer(key, scope, sink === undefined ? {} : { fetchFn: observedRpcFetch(tracker.observer) }),
    evmPayer: (key) => createX402Payer(key),
    svmPayer: (key, options) => createSvmPayer(key, options),
    svmMppPayer: (key, options) => createSvmMppPayer(key, options),
    stderr: (text) => process.stderr.write(text),
    ...(sink === undefined ? {} : { onStage: tracker.onStage }),
  });
  if (outcome.ok) record(tracker.snapshot(), "signed");
} catch (error) {
  if (error instanceof KeyMissing) await exitAfterFlush(2);
  record(tracker.snapshot(), "threw");
  // 投げられた失敗: 記録を flush してから、同じ例外をそのまま投げる（終了コードと stderr は今と同じ）。
  await flushDiagnostics();
  throw error;
}
if (!outcome.ok) {
  process.stderr.write(`Refusing to sign: ${outcome.reason}\n`);
  await exitAfterFlush(2);
}
process.stdout.write((outcome as Extract<SignOutcome, { ok: true }>).stdout);
await flushDiagnostics();
