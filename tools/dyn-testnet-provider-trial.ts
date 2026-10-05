/**
 * 第三者の **testnet** Provider に、Router の送信レール（x402）と同じコードで実際に支払ってみる試行。
 * **製品コードではない。** 動的上流 URL の互換性の計測（設計 `docs/dynamic-upstream-design.md` §10 の M-4 と G-3 の前段）。
 *
 * 使うのは製品の `createX402Outbound`（署名前の照合つき）と SSRF 防御 A の transport。Router 本体・journal・本番は通らない。
 *
 * 範囲はコードで強制する:
 *   - network は Base Sepolia、asset は testnet USDC だけ
 *   - 1 件 `PER_PAYMENT_CAP` 以下、合計 `TOTAL_CAP` 以下、最大 `MAX_PAYMENTS` 件
 *   - `--pay` が無ければ 402 を読むだけ（署名も支払いもしない）
 *
 * 出すのは結果の分類と、**形を確かめた値だけ**: 応答は「最上位の型と欄の数・大きさ」、content type は media type、
 * tx の参照は 32 バイトの hex のときだけ。応答の本文・欄の名前・例外の文字列は出さない・保存しない。
 *
 * usage: T7_PAYER_PRIVATE_KEY=0x… npx tsx tools/dyn-testnet-provider-trial.ts [--pay] https://… [https://… ...]
 */
import { createX402Outbound } from "../src/adapters/outbound/x402.js";
import { createGuardedTransport } from "../src/net/guarded-fetch.js";
import { createRealEvmCapability } from "./real-evm-capability.js";

const NETWORK = "eip155:84532";
const ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const PER_PAYMENT_CAP = 10_000n;
const TOTAL_CAP = 30_000n;
const MAX_PAYMENTS = 8;

/** 応答の大まかな形（欄の名前は出さない。上流が決める文字列なので）。 */
function summaryOf(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value !== null && typeof value === "object") return `object(${Object.keys(value).length} fields)`;
  return value === null ? "null" : typeof value;
}

function mediaTypeOf(raw: string): string {
  const media = raw.split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60}$/.test(media) ? media : "other";
}

async function main(): Promise<void> {
  const pay = process.argv.includes("--pay");
  const urls = process.argv.slice(2).filter((arg) => /^https:\/\//.test(arg));
  const key = process.env["T7_PAYER_PRIVATE_KEY"];
  if (key === undefined || key === "") {
    process.stderr.write("T7_PAYER_PRIVATE_KEY is not set\n");
    process.exit(2);
  }
  const payer = createRealEvmCapability(key);
  const transportEvents: string[] = [];
  const transport = createGuardedTransport({ allowLoopback: false, report: (event) => transportEvents.push(`${event.code}:${event.operation}`) });

  let spent = 0n;
  let payments = 0;
  const rows: Record<string, unknown>[] = [];
  for (const [index, url] of urls.entries()) {
    const routeId = `trial-${index}`;
    const row: Record<string, unknown> = { host: new URL(url).host };
    rows.push(row);
    try {
      const rail = createX402Outbound({ transport, upstreams: { [routeId]: url }, capability: payer.capability(NETWORK) });
      const offers = await rail.readChallenge(routeId);
      row["offers"] = offers.length;
      // 範囲内の最初の offer（network・asset・額）。
      const offer = offers.find(
        (candidate) =>
          candidate.scheme === "exact" &&
          candidate.network === NETWORK &&
          candidate.asset.toLowerCase() === ASSET &&
          /^[1-9][0-9]*$/.test(candidate.amount) &&
          BigInt(candidate.amount) <= PER_PAYMENT_CAP,
      );
      if (offer === undefined) {
        row["result"] = "no offer within the trial scope";
        continue;
      }
      row["amount"] = offer.amount;
      row["offerKeys"] = Object.keys(offer).sort().join(",");
      row["extraKeys"] = Object.keys(offer.extra ?? {}).sort().join(",");
      if (!pay) {
        row["result"] = "dry-run (402 read only)";
        continue;
      }
      if (payments >= MAX_PAYMENTS || spent + BigInt(offer.amount) > TOTAL_CAP) {
        row["result"] = "skipped (trial cap reached)";
        continue;
      }
      payments += 1;
      spent += BigInt(offer.amount);
      const signsBefore = payer.signCount();
      const started = Date.now();
      const result = await rail.pay({ routeId, offer, paymentId: `trial-${Date.now()}-${index}`, attempt: 1 });
      row["ms"] = Date.now() - started;
      row["signs"] = payer.signCount() - signsBefore;
      row["result"] = result.outcome;
      if (result.outcome === "paid") {
        row["contentType"] = mediaTypeOf(result.contentType);
        row["body"] = summaryOf(result.body);
        row["bodyBytes"] = JSON.stringify(result.body ?? null).length;
        row["txRef"] = typeof result.txRef === "string" && /^0x[0-9a-fA-F]{64}$/.test(result.txRef) ? result.txRef : "not a transaction hash";
      } else {
        // adapter の理由コードは固定の集合（上流の文字列ではない）。
        row["reason"] = /^[a-z_]{1,48}$/.test(result.reason) ? result.reason : "other";
        if ("receiptRef" in result && result.receiptRef !== undefined) row["hasReceipt"] = true;
      }
    } catch (error) {
      // 例外の文字列は出さない（URL や上流の値が混ざり得る）。種類の名前だけ。
      row["result"] = "error";
      const name = error instanceof Error ? error.name : "";
      row["error"] = /^[A-Za-z]{1,40}$/.test(name) ? name : "Error";
    }
  }
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), pay, payer: payer.address, payments, spentBaseUnits: spent.toString(), transportEvents, rows }, null, 1)}\n`);
}

main().catch(() => {
  process.stderr.write("trial failed\n");
  process.exit(1);
});
