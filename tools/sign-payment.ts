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
 * | scheme | レール | 性質 |
 * |---|---|---|
 * | `exact` | x402 / Base Sepolia | **署名するだけ**。送信と gas は facilitator 負担 |
 * | `tempo/charge` | MPP / Tempo | **この場でチェーンに送金する**。手数料も自分持ち |
 *
 * **MPP は署名ではなく送金**である点に注意。このコマンドを実行した時点で
 * **資金が動き、失敗しても戻らない**。だから実行前に必ず人間の承認を取ること。
 *
 * **鍵はこのマシンから出ない。** Router に送るのは**署名済みの credential だけ**で、
 * 秘密鍵そのものは送信されない（Router 側も鍵を保持しない設計）。
 *
 * EIP-712 domain は **Router が発行した offer から読む**（勝手に決めない）。
 */

import { readFileSync } from "node:fs";

import { createMppPayer } from "./mpp-payer.js";
import { createX402Payer } from "./x402-payer.js";

const BASE_SEPOLIA = 84532;
/** 1 回の受信レグで払ってよい上限（base units）。これを超える offer には署名・送金しない。 */
const MAX_AMOUNT = 10_000n;

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

const offerRecord = offer as Record<string, unknown>;
const scheme = offerRecord["scheme"];
const network = String(offerRecord["network"] ?? "");
const amount = String(offerRecord["amount"] ?? "0");
const payTo = String(offerRecord["payTo"] ?? "");

if (BigInt(amount) > MAX_AMOUNT) {
  process.stderr.write(`offer の額が上限を超えています: ${amount} > ${MAX_AMOUNT}\n`);
  process.exit(2);
}

if (scheme === "tempo/charge") {
  // ---- MPP 受信。**ここで実際に送金する。** ----
  const chainId = Number(network.replace(/^eip155:/, ""));
  if (!Number.isInteger(chainId) || chainId <= 0) {
    process.stderr.write(`offer の network を読めません: ${network}\n`);
    process.exit(2);
  }
  const asset = String(offerRecord["asset"] ?? "");
  const payer = createMppPayer(payerKey(), {
    chainId,
    asset,
    payTo,
    maxAmount: MAX_AMOUNT,
  });
  process.stderr.write(
    `MPP: これから ${amount} を ${payTo} へ送金します（${network}）。\n` +
      `     **送金は取り消せません。** 人間の承認を得てから実行してください。\n`,
  );
  const { credential, txRef } = await payer.payAndCredential(offerRecord as never);
  /**
   * **両レールで出力の形を揃える。** x402 側は payer が Router の封筒
   * （`x402Version` / `accepted` / `payload.challengeNonce`）まで組んで base64 を返すが、
   * MPP 側が返すのは mppx の wire 文字列なので、ここで同じ封筒に入れる。
   * 揃えておかないと、呼び出し側がレールごとに扱いを変える羽目になる。
   */
  const extra = offerRecord["extra"] as Record<string, unknown> | undefined;
  const envelope = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: offerRecord,
      payload: { challengeNonce: extra?.["challengeNonce"], credential },
    }),
    "utf8",
  ).toString("base64");
  process.stderr.write(`paid by ${payer.address} / tx ${txRef} (鍵は送信されません)\n`);
  process.stdout.write(`${envelope}\n`);
} else {
  // ---- x402 受信。署名するだけで、資金はまだ動かない。 ----
  const payer = createX402Payer(payerKey());
  const credential = await payer.credentialFor(offer as never, BASE_SEPOLIA);
  process.stderr.write(`signed by ${payer.address} (鍵は送信されません)\n`);
  process.stdout.write(`${credential}\n`);
}
