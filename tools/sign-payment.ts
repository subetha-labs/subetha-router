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
import { classifyOffer, SIGN_MAX_AMOUNT } from "./sign-dispatch.js";
import { createSvmPayer } from "./svm-payer.js";
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

function payerKey(): string {
  const key = envValue("SUBETHA_PAYER_PRIVATE_KEY");
  if (key !== undefined) return key;
  process.stderr.write("SUBETHA_PAYER_PRIVATE_KEY is not set. Run `npm run wallet:new` to create one.\n");
  process.exit(2);
}

function solanaKey(): string {
  const key = envValue("SOLANA_PAYER_PRIVATE_KEY");
  if (key !== undefined) return key;
  process.stderr.write("SOLANA_PAYER_PRIVATE_KEY is not set. Run `npm run wallet:new:solana` to create one.\n");
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

let quote: Record<string, unknown>;
try {
  quote = JSON.parse(raw) as Record<string, unknown>;
} catch {
  process.stderr.write("The argument is not readable as JSON. Pass the quote unchanged.\n");
  process.exit(2);
}

const source = quote["source"] as Record<string, unknown> | undefined;
const offer = source?.["offer"];
if (offer === undefined) {
  process.stderr.write(
    "The quote has no source.offer. Pass the `quote` field from the subetha_router_quote response.\n",
  );
  process.exit(2);
}

/**
 * 振り分けと署名前の拒否は `sign-dispatch.ts`（表に無い network・資産・domain・mint、失効、形の違い、上限 20,000）。
 * **鍵を読むのは振り分けが決まった後**（拒む offer では鍵に触れない）。
 */
const dispatch = classifyOffer(offer, Date.now());
if (dispatch.kind === "refuse") {
  process.stderr.write(`Refusing to sign: ${dispatch.reason}\n`);
  process.exit(2);
}
const offerRecord = offer as Record<string, unknown>;

if (dispatch.kind === "mpp") {
  // ---- MPP 受信。**ここで実際に送金する。** ----
  const payer = createMppPayer(payerKey(), {
    chainId: dispatch.chainId,
    asset: dispatch.asset,
    payTo: dispatch.payTo,
    maxAmount: SIGN_MAX_AMOUNT,
  });
  process.stderr.write(
    `MPP: about to send ${dispatch.amount} to ${dispatch.payTo} on eip155:${dispatch.chainId}.\n` +
      "     **This transfer cannot be undone.** Only run this after a human has approved.\n",
  );
  const { credential, txRef } = await payer.payAndCredential(offerRecord as never);
  /**
   * **両レールで出力の形を揃える。** x402 側は payer が Router の封筒
   * （`x402Version` / `accepted` / `payload.challengeNonce`）まで組んで base64 を返すが、
   * MPP 側が返すのは mppx の wire 文字列なので、ここで同じ封筒に入れる。
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
  process.stderr.write(`paid by ${payer.address} / tx ${txRef} (your key is never sent)\n`);
  process.stdout.write(`${envelope}\n`);
} else if (dispatch.kind === "x402-evm") {
  // ---- x402 受信（EVM）。署名するだけで、資金はまだ動かない。chainId は表から。 ----
  const payer = createX402Payer(payerKey());
  const credential = await payer.credentialFor(offerRecord as never, dispatch.chainId);
  process.stderr.write(`signed by ${payer.address} for eip155:${dispatch.chainId} (your key is never sent)\n`);
  process.stdout.write(`${credential}\n`);
} else {
  // ---- x402 受信（Solana）。部分署名するだけで、資金はまだ動かない（送信は facilitator の fee payer）。 ----
  const payer = await createSvmPayer(solanaKey(), { ...(envValue("SOLANA_RPC_URL") === undefined ? {} : { rpcUrl: envValue("SOLANA_RPC_URL")! }) });
  const credential = await payer.credentialFor(offerRecord as never, { mint: dispatch.mint, decimals: dispatch.decimals, tokenProgram: dispatch.tokenProgram });
  process.stderr.write(`signed by ${payer.address} on Solana (your key is never sent; the facilitator broadcasts)\n`);
  process.stdout.write(`${credential}\n`);
}
