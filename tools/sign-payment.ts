/**
 * 受信レグの `credential`（base64 の `X-Payment`）を**手元で**作る。
 * **製品コードではない**（鍵を扱う側）。
 *
 *   npm run sign -- '<quote tool が返した quote の JSON>'
 *
 * 出力は base64 の 1 行。それを `subetha_router_purchase` の `credential` に渡す。
 *
 * **鍵はこのマシンから出ない。** Router に送るのは**署名済みの credential だけ**で、
 * 秘密鍵そのものは送信されない（Router 側も鍵を保持しない設計）。
 *
 * EIP-712 domain は **Router が発行した offer から読む**（勝手に決めない）。
 */

import { readFileSync } from "node:fs";

import { createX402Payer } from "./x402-payer.js";

const BASE_SEPOLIA = 84532;

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

const raw = process.argv[2];
if (raw === undefined || raw.trim() === "") {
  process.stderr.write(
    "usage: npm run sign -- '<quote tool が返した quote の JSON>'\n" +
      "  quote の応答に含まれる `quote` フィールドをそのまま渡してください。\n",
  );
  process.exit(2);
}

let quote: Record<string, unknown>;
try {
  quote = JSON.parse(raw) as Record<string, unknown>;
} catch {
  process.stderr.write("引数が JSON として読めません。quote をそのまま渡してください。\n");
  process.exit(2);
}

const source = quote["source"] as Record<string, unknown> | undefined;
const offer = source?.["offer"];
if (offer === undefined) {
  process.stderr.write(
    "quote に source.offer がありません。`subetha_router_quote` の応答の `quote` を渡してください。\n",
  );
  process.exit(2);
}

const payer = createX402Payer(payerKey());
const credential = await payer.credentialFor(offer as never, BASE_SEPOLIA);

process.stderr.write(`signed by ${payer.address} (鍵は送信されません)\n`);
process.stdout.write(`${credential}\n`);
