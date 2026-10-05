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
import { Addresses } from "viem/tempo";

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

/** 数値の欄が無い・形が違うものを 0 として扱わない（黙って「上限は守られた」にしない）。 */
function big(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`missing or malformed ${name}`);
  return BigInt(value);
}
const addressOf = (topic: unknown): string => (typeof topic === "string" ? `0x${topic.slice(26)}`.toLowerCase() : "");
const FEE_MANAGER = Addresses.feeManager.toLowerCase();
const SCALE = 10n ** 12n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

const hashes = (process.argv.length > 2 ? process.argv.slice(2) : readFileSync(0, "utf8").split("\n"))
  .map((line) => line.trim())
  .filter((line) => /^0x[0-9a-fA-F]{64}$/.test(line));

const rows: Record<string, unknown>[] = [];
for (const hash of hashes) {
  const short = `${hash.slice(0, 10)}…`;
  try {
    const [tx, receipt] = await Promise.all([rpc("eth_getTransactionByHash", [hash]), rpc("eth_getTransactionReceipt", [hash])]);
    if (tx === null || receipt === null) throw new Error("transaction or receipt not found");
    const from = String(tx["from"]).toLowerCase();
    const feeToken = String(receipt["feeToken"] ?? "").toLowerCase();
    const feePayer = String(receipt["feePayer"] ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(feeToken)) throw new Error("receipt has no feeToken");
    // 本書が扱うのは「送信者が自分で手数料を払う」形だけ。fee payer が別なら対象外として失敗させる。
    if (feePayer !== from) throw new Error("fee payer is not the sender");
    const gas = big(tx["gas"], "tx.gas");
    const maxFeePerGas = big(tx["maxFeePerGas"], "tx.maxFeePerGas");
    const gasUsed = big(receipt["gasUsed"], "receipt.gasUsed");
    const effectiveGasPrice = big(receipt["effectiveGasPrice"], "receipt.effectiveGasPrice");
    const transfers = ((receipt["logs"] as Record<string, unknown>[] | undefined) ?? [])
      .filter((log) => (log["topics"] as string[] | undefined)?.[0] === TRANSFER_TOPIC)
      .map((log) => ({
        token: String(log["address"]).toLowerCase(),
        from: addressOf((log["topics"] as string[])[1]),
        to: addressOf((log["topics"] as string[])[2]),
        amount: big(String(log["data"]).slice(0, 66), "log.data"),
      }));
    /**
     * 手数料の徴収: **fee manager の正確なアドレス**宛て・**receipt の feeToken**・**送信者から**の Transfer。
     * 1 件ちょうどでなければ（返金や分割があれば）曖昧として失敗させる。fee manager から送信者への戻りも数える。
     */
    const charged = transfers.filter((t) => t.to === FEE_MANAGER && t.from === from && t.token === feeToken);
    const refunded = transfers.filter((t) => t.from === FEE_MANAGER && t.to === from);
    if (charged.length !== 1 || refunded.length !== 0) {
      throw new Error(`ambiguous fee accounting (charges=${charged.length}, refunds=${refunded.length})`);
    }
    const paid = charged[0]!.amount;
    const predicted = ceilDiv(gasUsed * effectiveGasPrice, SCALE);
    const bound = ceilDiv(gas * maxFeePerGas, SCALE);
    rows.push({
      hash: short,
      ok: true,
      type: tx["type"],
      feePaid: paid.toString(),
      predictedFromUsed: predicted.toString(),
      boundBeforeSigning: bound.toString(),
      predictionExact: paid === predicted,
      boundHolds: paid <= bound,
      txFeeToken: tx["feeToken"] ?? null,
      receiptFeeToken: feeToken,
      gas: gas.toString(),
      gasUsed: gasUsed.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      effectiveGasPrice: effectiveGasPrice.toString(),
      transfers: transfers.length,
    });
  } catch (cause) {
    rows.push({ hash: short, ok: false, reason: cause instanceof Error ? cause.message : "unknown" });
  }
}
const allRead = rows.length > 0 && rows.every((row) => row["ok"] === true);
console.log(
  JSON.stringify(
    {
      rpc: RPC,
      feeManager: FEE_MANAGER,
      count: rows.length,
      // 1 件でも読めない・曖昧なものがあれば、全体を成功として報告しない。
      allRead,
      allPredictionsExact: allRead && rows.every((row) => row["predictionExact"] === true),
      allBoundsHold: allRead && rows.every((row) => row["boundHolds"] === true),
      rows,
    },
    null,
    1,
  ),
);
if (!allRead) process.exitCode = 1;
