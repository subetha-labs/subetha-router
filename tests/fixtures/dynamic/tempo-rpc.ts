/**
 * Tempo の JSON-RPC の fixture（プロセス内）。**実際の形の receipt を返す。** 試験基盤。
 *
 * 既存の `rpc-server.ts` は `eth_getTransactionReceipt` に常に null を返すので、MPP の SDK の検証を通る
 * 「正の対照」を作れない。こちらは:
 *   - `eth_sendRawTransactionSync`／`eth_sendRawTransaction`: 送られてきた raw を**復号**し、中の token 送金
 *     （`transfer`／`transferWithMemo`）から Transfer・TransferWithMemo のログを作って receipt を登録する
 *   - `eth_getTransactionReceipt`: 登録済みの receipt を返す（無ければ null）
 *   - `register()`: raw を送らずに receipt を直接登録する（別の支払いを装う試験用）
 *
 * `eth_fillTransaction` は持たない（-32601）。viem は見積りの RPC に落ちる。チェーンも鍵も無い。
 */
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

import { TxEnvelopeTempo } from "ox/tempo";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress, keccak256, type Hex } from "viem";
import { Abis } from "viem/tempo";

import type { TlsMaterial } from "../tls/generate.js";

export interface TransferSpec {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  /** あれば TransferWithMemo も付く。 */
  readonly memo?: Hex | undefined;
}

export interface TempoRpc {
  readonly url: string;
  readonly port: number;
  /** 受けた RPC の method（順に）。 */
  readonly methods: string[];
  /** 送金の RPC で受けた raw transaction。 */
  readonly sentRaw: Hex[];
  /** raw の送り主として扱うアドレス（署名からは復元しない。試験が設定する）。 */
  sender: string;
  /** `balanceOf` の応答（token → 残高）。既定は十分な額。 */
  readonly balances: Map<string, bigint>;
  /** 送金の RPC を失敗させる（成否不明の再現）。 */
  failSend: boolean;
  /** receipt を直接登録する。 */
  register(hash: Hex, transfers: readonly TransferSpec[], options?: { status?: "0x1" | "0x0"; from?: string }): void;
  close(): Promise<void>;
}

function logsOf(hash: Hex, transfers: readonly TransferSpec[]): unknown[] {
  const logs: unknown[] = [];
  const push = (address: string, topics: readonly Hex[], data: Hex): void => {
    logs.push({
      address,
      topics,
      data,
      logIndex: `0x${logs.length.toString(16)}`,
      blockNumber: "0x1",
      blockHash: `0x${"11".repeat(32)}`,
      transactionHash: hash,
      transactionIndex: "0x0",
      removed: false,
    });
  };
  for (const transfer of transfers) {
    const from = getAddress(transfer.from);
    const to = getAddress(transfer.to);
    const amount = encodeAbiParameters([{ type: "uint256" }], [transfer.amount]);
    push(transfer.token, encodeEventTopics({ abi: Abis.tip20, eventName: "Transfer", args: { from, to } }) as Hex[], amount);
    if (transfer.memo !== undefined) {
      push(transfer.token, encodeEventTopics({ abi: Abis.tip20, eventName: "TransferWithMemo", args: { from, to, memo: transfer.memo } }) as Hex[], amount);
    }
  }
  return logs;
}

export async function startTempoRpc(options: { chainId?: number; tls?: TlsMaterial } = {}): Promise<TempoRpc> {
  const chainId = options.chainId ?? 42_431;
  const receipts = new Map<string, unknown>();
  const methods: string[] = [];
  const sentRaw: Hex[] = [];
  const balances = new Map<string, bigint>();

  const state = {
    sender: "0x0000000000000000000000000000000000000B0b",
    failSend: false,
  };

  const register: TempoRpc["register"] = (hash, transfers, registerOptions = {}) => {
    receipts.set(hash.toLowerCase(), {
      status: registerOptions.status ?? "0x1",
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash: `0x${"11".repeat(32)}`,
      blockNumber: "0x1",
      from: getAddress(registerOptions.from ?? transfers[0]?.from ?? state.sender),
      to: transfers[0]?.token ?? null,
      contractAddress: null,
      cumulativeGasUsed: "0xb65b",
      gasUsed: "0xb65b",
      effectiveGasPrice: "0x23c34601",
      logs: logsOf(hash, transfers),
      logsBloom: `0x${"00".repeat(256)}`,
      type: "0x76",
    });
  };

  /** raw の Tempo transaction を復号し、token 送金の call を取り出す。 */
  const transfersOf = (raw: Hex): TransferSpec[] => {
    const envelope = TxEnvelopeTempo.deserialize(raw as never);
    const out: TransferSpec[] = [];
    for (const call of envelope.calls ?? []) {
      if (call.to === undefined || call.data === undefined) continue;
      try {
        const fn = decodeFunctionData({ abi: Abis.tip20, data: call.data });
        if (fn.functionName === "transfer" || fn.functionName === "transferWithMemo") {
          const args = fn.args as readonly unknown[];
          out.push({ token: call.to, from: state.sender, to: args[0] as string, amount: args[1] as bigint, memo: fn.functionName === "transferWithMemo" ? (args[2] as Hex) : undefined });
        }
      } catch {
        // token 送金でない call はログを作らない。
      }
    }
    return out;
  };

  const answer = (method: string, params: unknown[]): unknown => {
    switch (method) {
      case "eth_chainId":
        return `0x${chainId.toString(16)}`;
      case "eth_getTransactionCount":
        return "0x0";
      case "eth_estimateGas":
        return "0xd412";
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_gasPrice":
        return "0x23c34601";
      case "eth_getBlockByNumber":
        return { number: "0x1", baseFeePerGas: "0x23c34600", timestamp: "0x1", gasLimit: "0x1c9c380", transactions: [] };
      case "eth_call": {
        // `balanceOf(address)` だけに答える。
        const to = String((params[0] as { to?: string } | undefined)?.to ?? "").toLowerCase();
        return encodeAbiParameters([{ type: "uint256" }], [balances.get(to) ?? 10n ** 12n]);
      }
      case "eth_sendRawTransactionSync":
      case "eth_sendRawTransaction": {
        const raw = params[0] as Hex;
        sentRaw.push(raw);
        if (state.failSend) throw new Error("fixture send failure");
        const hash = keccak256(raw);
        register(hash, transfersOf(raw), { from: state.sender });
        return method === "eth_sendRawTransaction" ? hash : receipts.get(hash.toLowerCase());
      }
      case "eth_getTransactionReceipt":
        return receipts.get(String(params[0]).toLowerCase()) ?? null;
      default:
        throw Object.assign(new Error("method not found"), { code: -32601 });
    }
  };

  const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let id: unknown = null;
      let payload: unknown;
      try {
        const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown; method?: string; params?: unknown[] };
        id = call.id ?? null;
        methods.push(String(call.method));
        payload = { jsonrpc: "2.0", id, result: answer(String(call.method), call.params ?? []) };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        payload = { jsonrpc: "2.0", id, error: { code: typeof code === "number" ? code : -32000, message: error instanceof Error ? error.message : "error" } };
      }
      const text = JSON.stringify(payload);
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      response.end(text);
    });
  };
  const server = options.tls === undefined ? http.createServer(handler) : https.createServer({ key: options.tls.other.key, cert: options.tls.other.cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: options.tls === undefined ? `http://127.0.0.1:${port}` : "https://other.test",
    port,
    methods,
    sentRaw,
    balances,
    get sender(): string {
      return state.sender;
    },
    set sender(value: string) {
      state.sender = value;
    },
    get failSend(): boolean {
      return state.failSend;
    },
    set failSend(value: boolean) {
      state.failSend = value;
    },
    register,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
