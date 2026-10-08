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
 */

import { readFileSync } from "node:fs";

import { createMppPayer } from "./mpp-payer.js";
import { runSign } from "./sign-run.js";
import { createSvmMppPayer } from "./svm-mpp-payer.js";
import { createSvmPayer } from "./svm-payer.js";
import { SVM_RPC_ALLOW_LOOPBACK_ENV } from "./svm-rpc.js";
import { createX402Payer } from "./x402-payer.js";

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

function requireKey(name: string, hint: string): string {
  const key = envValue(name);
  if (key !== undefined) return key;
  process.stderr.write(`${name} is not set. Run \`${hint}\` to create one.\n`);
  process.exit(2);
}

const raw = process.argv[2];
if (raw === undefined || raw.trim() === "") {
  process.stderr.write(
    "usage: npm run sign -- '<the quote JSON returned by the quote tool>'\n" +
      "  Pass the `quote` field from the quote response, unchanged.\n",
  );
  process.exit(2);
}

let quote: unknown;
try {
  quote = JSON.parse(raw);
} catch {
  process.stderr.write("The argument is not readable as JSON. Pass the quote unchanged.\n");
  process.exit(2);
}

const solanaRpcUrl = envValue("SOLANA_RPC_URL");
// loopback の Solana RPC は既定で拒む（Router と同じ transport の方針）。手元の node・fixture に向けるときだけ `SOLANA_RPC_ALLOW_LOOPBACK=1`。
const solanaRpcAllowLoopback = envValue(SVM_RPC_ALLOW_LOOPBACK_ENV) === "1";
const outcome = await runSign(quote, {
  nowMs: Date.now,
  readEvmKey: () => requireKey("SUBETHA_PAYER_PRIVATE_KEY", "npm run wallet:new"),
  readSolanaKey: () => requireKey("SOLANA_PAYER_PRIVATE_KEY", "npm run wallet:new:solana"),
  ...(solanaRpcUrl === undefined ? {} : { solanaRpcUrl }),
  ...(solanaRpcAllowLoopback ? { solanaRpcAllowLoopback } : {}),
  mppPayer: (key, scope) => createMppPayer(key, scope),
  evmPayer: (key) => createX402Payer(key),
  svmPayer: (key, options) => createSvmPayer(key, options),
  svmMppPayer: (key, options) => createSvmMppPayer(key, options),
  stderr: (text) => process.stderr.write(text),
});
if (!outcome.ok) {
  process.stderr.write(`Refusing to sign: ${outcome.reason}\n`);
  process.exit(2);
}
process.stdout.write(outcome.stdout);
