/**
 * 設計の実測 M-1（`docs/dynamic-upstream-design.md` §3.3・§6.4・§10、タスク T0-b）。**製品コードではない。**
 *
 * 問い: MPP 送信（Tempo）の手数料は実際にいくらで、署名前に分かる上限（`gas × maxFeePerGas`）から
 * 手数料資産の base units にどう換算すれば、実額を**上から抑えられる**か。
 *
 * 既に送られた transaction の hash を引数（または標準入力、1 行 1 つ）で受け取り、公開 RPC から
 * transaction と receipt を**読むだけ**。何も署名せず、何も送らない。
 *
 * usage: npx tsx tools/dyn-mpp-fee-probe.ts 0x<txhash> [0x<txhash> ...]
 */
import { readFileSync } from "node:fs";

import { tempoModerato } from "viem/tempo/chains";

const RPC = tempoModerato.rpcUrls.default.http[0];
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function rpc(method: string, params: unknown[]): Promise<Record<string, unknown> | null> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json()) as { result?: Record<string, unknown> | null; error?: { message: string } };
  if (json.error !== undefined) throw new Error(json.error.message);
  return json.result ?? null;
}

const big = (value: unknown): bigint => (typeof value === "string" && value.startsWith("0x") ? BigInt(value) : 0n);
const addressOf = (topic: unknown): string => (typeof topic === "string" ? `0x${topic.slice(26)}`.toLowerCase() : "");

const hashes = (process.argv.length > 2 ? process.argv.slice(2) : readFileSync(0, "utf8").split("\n"))
  .map((line) => line.trim())
  .filter((line) => /^0x[0-9a-fA-F]{64}$/.test(line));

const rows: Record<string, unknown>[] = [];
for (const hash of hashes) {
  const [tx, receipt] = await Promise.all([rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash])]);
  if (tx === null || receipt === null) {
    rows.push({ hash: `${hash.slice(0, 10)}…`, found: false });
    continue;
  }
  const from = String(tx["from"]).toLowerCase();
  const gas = big(tx["gas"]);
  const maxFeePerGas = big(tx["maxFeePerGas"]);
  const gasUsed = big(receipt["gasUsed"]);
  const effectiveGasPrice = big(receipt["effectiveGasPrice"]);
  // 送信者から出た Transfer を全部拾う（支払い本体と、手数料の徴収）。
  const outgoing = ((receipt["logs"] as Record<string, unknown>[] | undefined) ?? [])
    .filter((log) => (log["topics"] as string[] | undefined)?.[0] === TRANSFER_TOPIC && addressOf((log["topics"] as string[])[1]) === from)
    .map((log) => ({ token: String(log["address"]).toLowerCase(), to: addressOf((log["topics"] as string[])[2]), amount: big(String(log["data"]).slice(0, 66)) }));
  /**
   * 換算の仮説: 手数料（6 桁の資産の base units）= ceil(gasUsed × effectiveGasPrice / 10^12)。
   * 手数料の徴収は、送信者から fee manager（`0xfeec…`）への Transfer として receipt に現れる。
   */
  const SCALE = 10n ** 12n;
  const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
  const feeTransfer = outgoing.find((t) => t.to.startsWith("0xfeec"));
  const predicted = ceilDiv(gasUsed * effectiveGasPrice, SCALE);
  const bound = ceilDiv(gas * maxFeePerGas, SCALE);
  rows.push({
    hash: `${hash.slice(0, 10)}…`,
    type: tx["type"],
    feePaid: feeTransfer?.amount.toString() ?? null,
    predictedFromUsed: predicted.toString(),
    boundBeforeSigning: bound.toString(),
    predictionExact: feeTransfer !== undefined && feeTransfer.amount === predicted,
    boundHolds: feeTransfer !== undefined && feeTransfer.amount <= bound,
    txFeeToken: tx["feeToken"] ?? null,
    receiptFeeToken: receipt["feeToken"] ?? null,
    feePayer: receipt["feePayer"] ?? null,
    gas: gas.toString(),
    gasUsed: gasUsed.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    effectiveGasPrice: effectiveGasPrice.toString(),
    boundRaw: (gas * maxFeePerGas).toString(),
    usedRaw: (gasUsed * effectiveGasPrice).toString(),
    outgoingTransfers: outgoing.map((t) => `${t.amount} -> ${t.to.slice(0, 10)}… (${t.token.slice(0, 10)}…)`),
    receiptKeys: Object.keys(receipt).sort().join(","),
  });
}
const found = rows.filter((row) => row["found"] !== false);
console.log(
  JSON.stringify(
    {
      rpc: RPC,
      count: rows.length,
      allPredictionsExact: found.length > 0 && found.every((row) => row["predictionExact"] === true),
      allBoundsHold: found.length > 0 && found.every((row) => row["boundHolds"] === true),
      rows,
    },
    null,
    1,
  ),
);
