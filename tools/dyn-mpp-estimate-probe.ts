/**
 * 設計の実測（`docs/dynamic-gas-fee-design.md` §1.1、レビュー #1 の指摘 6）。**製品コードではない。**
 *
 * 問い: quote 時の見積り（`transferWithMemo(payTo, amount, memo)` 1 call、`feeToken` 明示、expiring nonce）で、
 * ノードが提案する `gas` は memo の中身に依るか。3 通りの memo（ゼロ・非ゼロのダミー・SDK の帰属 memo と同じ形）で
 * `eth_fillTransaction` と `eth_estimateGas` を**読むだけ**。何も署名せず、何も送らない。
 *
 * 送信者は `T7_PAYER_PRIVATE_KEY` から導いたアドレス（鍵は署名に使わない。アドレスだけ）。鍵が無ければ `--from 0x…` で指定する。
 *
 * usage: T7_PAYER_PRIVATE_KEY=0x… npx tsx tools/dyn-mpp-estimate-probe.ts [--to 0x…] [--amount 10000]
 */
import { createClient, encodeFunctionData, http, maxUint256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { prepareTransactionRequest } from "viem/actions";
import { Abis } from "viem/tempo";
import { tempoModerato } from "viem/tempo/chains";

const PATHUSD = "0x20c0000000000000000000000000000000000000" as Hex;
const RPC = tempoModerato.rpcUrls.default.http[0]!;
const SCALE = 10n ** 12n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

function argOf(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const key = process.env["T7_PAYER_PRIVATE_KEY"];
const fromArg = argOf("--from");
const from = (fromArg ?? (key === undefined ? undefined : privateKeyToAccount(key as Hex).address)) as Hex | undefined;
if (from === undefined) {
  console.error("set T7_PAYER_PRIVATE_KEY (only the address is used) or pass --from 0x…");
  process.exit(2);
}
const to = (argOf("--to") ?? from) as Hex;
const amount = BigInt(argOf("--amount") ?? "10000");

/** SDK の帰属 memo と同じ形（4 バイトの tag + version + 10 バイト ×2 の指紋 + 7 バイトの nonce。値は任意）。 */
const sdkLike = `0x${"6d707001".padEnd(8, "0")}01${"ab".repeat(10)}${"cd".repeat(10)}${"ef".repeat(7)}` as Hex;
const memos: [string, Hex][] = [
  ["zero", `0x${"00".repeat(32)}`],
  ["dummy (0x01 × 32)", `0x${"01".repeat(32)}`],
  ["sdk-like attribution", sdkLike],
];

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

const client = createClient({ chain: tempoModerato, transport: http(RPC, { retryCount: 0 }) });
const facade = { address: from, type: "local" as const };
const rows: Record<string, unknown>[] = [];
for (const [label, memo] of memos) {
  const data = encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [to, amount, memo] });
  const request = {
    account: facade as never,
    calls: [{ to: PATHUSD, data, value: 0n }],
    feeToken: PATHUSD,
    nonceKey: "expiring" as const,
    validBefore: Math.floor(Date.now() / 1000) + 25,
  };
  const row: Record<string, unknown> = { memo: label };
  try {
    // Router の見積りと同じ経路（viem の prepareTransactionRequest。対応ノードでは eth_fillTransaction）。
    const prepared = (await prepareTransactionRequest(client as never, request as never)) as { gas?: bigint; maxFeePerGas?: bigint };
    const gas = prepared.gas ?? 0n;
    const maxFeePerGas = prepared.maxFeePerGas ?? 0n;
    Object.assign(row, { preparedGas: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), bound: ceilDiv(gas * maxFeePerGas, SCALE).toString() });
  } catch (error) {
    row["prepareError"] = error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
  try {
    // 比較のため eth_estimateGas も直接（同じ欄）。
    const estimated = (await rpc("eth_estimateGas", [
      {
        from,
        type: "0x76",
        calls: [{ to: PATHUSD, data, value: "0x0" }],
        feeToken: PATHUSD,
        nonceKey: `0x${maxUint256.toString(16)}`,
        nonce: "0x0",
        validBefore: `0x${request.validBefore.toString(16)}`,
      },
    ])) as string;
    row["estimateGas"] = BigInt(estimated).toString();
  } catch (error) {
    row["estimateError"] = error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
  rows.push(row);
}
console.log(JSON.stringify({ chainId: tempoModerato.id, from, to, amount: amount.toString(), feeToken: PATHUSD, rows }, null, 2));
