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
 * 出すのは結果の分類・応答の形・tx の参照だけ（応答の本文は出さない・保存しない）。
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

function shapeOf(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [depth > 2 ? "…" : shapeOf(value[0], depth + 1)];
  if (value !== null && typeof value === "object") {
    if (depth > 2) return "{…}";
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 12).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
  }
  return value === null ? "null" : typeof value;
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
        row["contentType"] = result.contentType;
        row["bodyShape"] = shapeOf(result.body);
        row["bodyBytes"] = JSON.stringify(result.body ?? null).length;
        row["txRef"] = result.txRef;
      } else {
        row["reason"] = result.reason;
        if ("receiptRef" in result && result.receiptRef !== undefined) row["hasReceipt"] = true;
      }
    } catch (error) {
      // 例外の文字列は固定の接頭辞だけ（URL や鍵が混ざり得る）。
      row["result"] = "error";
      row["error"] = error instanceof Error ? error.message.slice(0, 80) : "unknown";
    }
  }
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), pay, payer: payer.address, payments, spentBaseUnits: spent.toString(), transportEvents, rows }, null, 1)}\n`);
}

main().catch(() => {
  process.stderr.write("trial failed\n");
  process.exit(1);
});
