/**
 * 設計の実測（`docs/dynamic-gas-fee-design.md` §2・§4、`DEPLOY.md` §2b 条件 6 の残り）。**製品コードではない。**
 *
 * 問い: quote から purchase までの最大 10 分の間に、署名前の bound（`ceil(gas × maxFeePerGas / 10^12)`）はどれだけ上がり得るか。
 * `feeMargin` 2 倍（仮の値）が足りるかを見る材料。
 *
 * `observe`: 一定間隔で Router の見積りと同じ経路（最新ブロックの baseFee を読み、Router の単価 `feePerGasOf(baseFee)`・priority 1 を渡して
 * viem の `prepareTransactionRequest`。同じ transaction の形）で bound を読み、1 行 1 サンプルの JSON（ts・gas・maxFeePerGas・baseFee・bound）を
 * ファイルに追記する。**署名も送金もしない。** `--node-policy` を付けると手数料を渡さず、ノードの提案（priority を含む）をそのまま記録する（設計 §8.1 ②の
 * 第 1 版の観測はこの形だった）。
 * `report`: 記録を読み、Δ ∈ {1, 2, 5, 10 分} ごとに bound(t+Δ) / bound(t) の分布（最大・p99・2 倍超の件数）を出す。
 *
 * `history`: `eth_feeHistory` でブロックごとの baseFee を過去に遡って読み（1 回 1,024 ブロック、ページの境界のブロックの timestamp を読んで補間）、
 * 同じ形の 1 行 1 ブロックの JSON を書く。bound は `ceil(gas × maxFeePerGas / 10^12)` で、`maxFeePerGas` は Router の単価 `feePerGasOf(baseFee)`
 * （設計 §8.2。priority は 1 固定なのでノードの提案は入らない）。gas は `--gas`（既定 48,945。`observe` の実測）。
 *
 * usage:
 *   T7_PAYER_PRIVATE_KEY=0x… npx tsx tools/dyn-mpp-bound-observe.ts observe <file> [--interval 30] [--hours 6] [--to 0x…] [--amount 10000]
 *   npx tsx tools/dyn-mpp-bound-observe.ts history <file> [--hours 72] [--gas 48945]
 *   npx tsx tools/dyn-mpp-bound-observe.ts report <file>
 */
import { appendFileSync, readFileSync } from "node:fs";

import { createClient, encodeFunctionData, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prepareTransactionRequest } from "viem/actions";
import { Abis } from "viem/tempo";
import { tempoModerato } from "viem/tempo/chains";

const PATHUSD = "0x20c0000000000000000000000000000000000000" as Hex;
const RPC = tempoModerato.rpcUrls.default.http[0]!;
const SCALE = 10n ** 12n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

function argOf(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

interface Sample {
  readonly ts: number;
  readonly gas: string;
  readonly maxFeePerGas: string;
  readonly baseFeePerGas: string;
  readonly bound: string;
  readonly error?: string;
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (json.error !== undefined) throw new Error(json.error.message);
  return json.result;
}

async function observe(file: string): Promise<void> {
  const key = process.env["T7_PAYER_PRIVATE_KEY"];
  const fromArg = argOf("--from");
  let from: Hex | undefined = fromArg as Hex | undefined;
  if (from === undefined && key !== undefined) {
    try {
      from = privateKeyToAccount(key as Hex).address;
    } catch {
      // 鍵の値を例外の文字列に出さない。
      console.error("T7_PAYER_PRIVATE_KEY could not be turned into an address; pass --from 0x… instead");
      process.exit(2);
    }
  }
  if (from === undefined) {
    console.error("set T7_PAYER_PRIVATE_KEY (only the address is used) or pass --from 0x…");
    process.exit(2);
  }
  const to = (argOf("--to") ?? from) as Hex;
  const amount = BigInt(argOf("--amount", "10000")!);
  const intervalMs = Number(argOf("--interval", "30")) * 1000;
  const untilMs = Date.now() + Number(argOf("--hours", "6")) * 3_600_000;
  const memo: Hex = `0x${"01".repeat(32)}`;
  const data = encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [to, amount, memo] });
  const client = createClient({ chain: tempoModerato, transport: http(RPC, { retryCount: 0 }) });
  const facade = { address: from, type: "local" as const };
  console.error(`observing bound every ${intervalMs / 1000}s until ${new Date(untilMs).toISOString()} → ${file}`);
  while (Date.now() < untilMs) {
    const started = Date.now();
    let sample: Sample;
    try {
      const block = (await rpc("eth_getBlockByNumber", ["latest", false])) as { baseFeePerGas?: string };
      const baseFee = BigInt(block.baseFeePerGas ?? "0x0");
      const nodePolicy = process.argv.includes("--node-policy");
      const prepared = (await prepareTransactionRequest(client as never, {
        account: facade as never,
        calls: [{ to: PATHUSD, data, value: 0n }],
        feeToken: PATHUSD,
        nonceKey: "expiring",
        validBefore: Math.floor(Date.now() / 1000) + 25,
        ...(nodePolicy ? {} : { maxFeePerGas: feePerGasOf(baseFee), maxPriorityFeePerGas: 1n }),
      } as never)) as { gas?: bigint; maxFeePerGas?: bigint };
      const gas = prepared.gas ?? 0n;
      const maxFeePerGas = prepared.maxFeePerGas ?? 0n;
      sample = {
        ts: started,
        gas: gas.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        baseFeePerGas: baseFee.toString(),
        bound: ceilDiv(gas * maxFeePerGas, SCALE).toString(),
      };
    } catch (error) {
      sample = { ts: started, gas: "0", maxFeePerGas: "0", baseFeePerGas: "0", bound: "0", error: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
    }
    appendFileSync(file, `${JSON.stringify(sample)}\n`);
    const elapsed = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, intervalMs - elapsed)));
  }
}

/** Router の単価（`src/adapters/outbound/mpp-dynamic.ts` の `feePerGasOf` と同じ式）。 */
function feePerGasOf(baseFee: bigint): bigint {
  return (baseFee * 24n + 9n) / 10n + 1n;
}
function boundFromBaseFee(gas: bigint, baseFee: bigint): bigint {
  return ceilDiv(gas * feePerGasOf(baseFee), SCALE);
}

async function history(file: string): Promise<void> {
  const hours = Number(argOf("--hours", "72"));
  const gas = BigInt(argOf("--gas", "48945")!);
  const head = Number(BigInt((await rpc("eth_blockNumber", [])) as string));
  const headBlock = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
  const headTs = Number(BigInt(headBlock.timestamp));
  const untilTs = headTs - hours * 3600;
  let newest = head;
  let newestTs = headTs;
  let pages = 0;
  console.error(`reading fee history back to ${new Date(untilTs * 1000).toISOString()} from block ${head}`);
  while (newestTs > untilTs && newest > 0) {
    const count = Math.min(1024, newest);
    const result = (await rpc("eth_feeHistory", [`0x${count.toString(16)}`, `0x${newest.toString(16)}`, []])) as { oldestBlock: string; baseFeePerGas: string[] };
    const oldest = Number(BigInt(result.oldestBlock));
    const oldestBlock = (await rpc("eth_getBlockByNumber", [result.oldestBlock, false])) as { timestamp: string };
    const oldestTs = Number(BigInt(oldestBlock.timestamp));
    // baseFeePerGas は count + 1 要素（最後は次のブロックの予測）。count 要素だけ使う。timestamp はページの両端から線形に補間する。
    const fees = result.baseFeePerGas.slice(0, count);
    const lines: string[] = [];
    for (let k = 0; k < fees.length; k += 1) {
      const number = oldest + k;
      const ts = Math.round(oldestTs + ((newestTs - oldestTs) * k) / Math.max(1, count - 1));
      const baseFee = BigInt(fees[k]!);
      const bound = boundFromBaseFee(gas, baseFee);
      lines.push(JSON.stringify({ ts: ts * 1000, block: number, gas: gas.toString(), maxFeePerGas: feePerGasOf(baseFee).toString(), baseFeePerGas: baseFee.toString(), bound: bound.toString() }));
    }
    // ファイルは古い順に読めるよう、ページごとに先頭へ積む代わりに、最後に並べ替える（report はソートする）。
    appendFileSync(file, `${lines.join("\n")}\n`);
    pages += 1;
    newest = oldest - 1;
    newestTs = oldestTs;
    if (pages % 20 === 0) console.error(`… ${pages} pages, at ${new Date(newestTs * 1000).toISOString()}`);
  }
  console.error(`done: ${pages} pages → ${file}`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function report(file: string): void {
  const samples = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Sample)
    .sort((a, b) => a.ts - b.ts);
  const ok = samples.filter((s) => s.error === undefined && s.bound !== "0");
  const bounds = ok.map((s) => Number(s.bound)).sort((a, b) => a - b);
  const baseFees = ok.map((s) => Number(s.baseFeePerGas)).sort((a, b) => a - b);
  const out: Record<string, unknown> = {
    file,
    samples: samples.length,
    errors: samples.length - ok.length,
    from: ok.length > 0 ? new Date(ok[0]!.ts).toISOString() : null,
    to: ok.length > 0 ? new Date(ok.at(-1)!.ts).toISOString() : null,
    bound: { min: bounds[0], median: percentile(bounds, 0.5), p99: percentile(bounds, 0.99), max: bounds.at(-1) },
    baseFeePerGas: { min: baseFees[0], median: percentile(baseFees, 0.5), max: baseFees.at(-1) },
    gas: [...new Set(ok.map((s) => s.gas))],
    deltas: {} as Record<string, unknown>,
  };
  for (const minutes of [1, 2, 5, 10]) {
    const deltaMs = minutes * 60_000;
    const ratios: number[] = [];
    let j = 0;
    for (let i = 0; i < ok.length; i += 1) {
      while (j < ok.length && ok[j]!.ts < ok[i]!.ts + deltaMs) j += 1;
      if (j >= ok.length) break;
      ratios.push(Number(ok[j]!.bound) / Number(ok[i]!.bound));
    }
    // 窓の中の最大（quote の後 Δ 以内のどこで purchase が来ても、の最悪）。
    const worst: number[] = [];
    let hi = 0;
    for (let i = 0; i < ok.length; i += 1) {
      if (hi < i) hi = i;
      let maxBound = Number(ok[i]!.bound);
      while (hi + 1 < ok.length && ok[hi + 1]!.ts <= ok[i]!.ts + deltaMs) {
        hi += 1;
        maxBound = Math.max(maxBound, Number(ok[hi]!.bound));
      }
      // すでに通過した hi までの最大を再計算（単調でないので素朴に）。
      let m = Number(ok[i]!.bound);
      for (let k = i + 1; k <= hi; k += 1) m = Math.max(m, Number(ok[k]!.bound));
      worst.push(m / Number(ok[i]!.bound));
    }
    const worstSorted = [...worst].sort((a, b) => a - b);
    const sorted = [...ratios].sort((a, b) => a - b);
    (out["deltas"] as Record<string, unknown>)[`${minutes}m`] = {
      worstInWindow: { max: worstSorted.at(-1), p99: percentile(worstSorted, 0.99), over2: worst.filter((r) => r > 2).length, over1_5: worst.filter((r) => r > 1.5).length },
      pairs: ratios.length,
      max: sorted.at(-1),
      p99: percentile(sorted, 0.99),
      p95: percentile(sorted, 0.95),
      over1: ratios.filter((r) => r > 1).length,
      over1_5: ratios.filter((r) => r > 1.5).length,
      over2: ratios.filter((r) => r > 2).length,
    };
  }
  console.log(JSON.stringify(out, null, 2));
}

const mode = process.argv[2];
const file = process.argv[3];
if ((mode !== "observe" && mode !== "report" && mode !== "history") || file === undefined) {
  console.error("usage: observe <file> [--interval 30] [--hours 6] | history <file> [--hours 72] | report <file>");
  process.exit(2);
}
if (mode === "observe") await observe(file);
else if (mode === "history") await history(file);
else report(file);
