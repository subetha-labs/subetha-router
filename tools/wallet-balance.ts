/**
 * 支払い用ウォレットの Base Sepolia USDC 残高を見る。**製品コードではない。**
 * 出力は審査員の画面に出るので**英語**。コメントは日本語のままでよい。
 *
 *   npm run wallet:balance
 *
 * `SUBETHA_PAYER_PRIVATE_KEY`（`.env.local` か env）から**アドレスだけ**を導く。
 * 鍵そのものは表示しない。
 */

import { readFileSync } from "node:fs";

import { privateKeyToAccount } from "viem/accounts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC = "https://sepolia.base.org";

function payerKey(): string {
  const fromEnv = process.env["SUBETHA_PAYER_PRIVATE_KEY"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    const text = readFileSync(".env.local", "utf8");
    const line = text.split("\n").find((l) => l.startsWith("SUBETHA_PAYER_PRIVATE_KEY="));
    if (line !== undefined) return line.slice("SUBETHA_PAYER_PRIVATE_KEY=".length).trim();
  } catch {
    // .env.local が無いだけ。
  }
  process.stderr.write(
    "SUBETHA_PAYER_PRIVATE_KEY がありません。`npm run wallet:new` で作ってください。\n",
  );
  process.exit(2);
}

const address = privateKeyToAccount(payerKey() as `0x${string}`).address;
const data = `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}`;
const response = await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC, data }, "latest"] }),
});
const json = (await response.json()) as { result?: string };
const units = BigInt(json.result ?? "0x0");

process.stdout.write(`address : ${address}\n`);
process.stdout.write(`USDC    : ${units} base units (${Number(units) / 1e6} USDC)\n`);
if (units < 10_000n) {
  process.stdout.write(
    "\nNot enough for one purchase (10000 base units).\n" +
      "Get Base Sepolia USDC at https://faucet.circle.com\n",
  );
} else {
  process.stdout.write(`\nEnough for about ${units / 10_000n} purchases.\n`);
}
