/**
 * 偽の burn の reader（`tools/private-payer.ts` の `BurnReader`、`docs/zktls-router-burn-sale-hardening.md` FR-H3）。ネットワーク無しで receipt の判定を試す。
 * 既定は「宛先が payTo の Transfer 1 つ、額一致、status 0x1、block hash 一致」= transferred。
 */
import type { BurnReader } from "../../tools/private-payer.js";

export const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const BLOCK_HASH = `0x${"bb".repeat(32)}`;
const topicAddress = (address: string): string => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const word = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;

export function transferLog(token: string, to: string, amount: bigint, logIndex: number, from = "0x000000000000000000000000000000000000a11c"): Record<string, unknown> {
  return { address: token, topics: [TOPIC_TRANSFER, topicAddress(from), topicAddress(to)], data: word(amount), logIndex: `0x${logIndex.toString(16)}` };
}

export interface FakeBurnOptions {
  readonly txHash: string;
  readonly token: string;
  readonly payTo: string;
  readonly amount: bigint;
  readonly chainId?: unknown;
  readonly status?: unknown;
  readonly logs?: unknown;
  /** `null` = receipt 無し（未 mine）。関数なら呼ぶたびに値を返す。 */
  readonly receipt?: unknown;
  readonly blockHash?: unknown;
  readonly throws?: "chainId" | "receipt" | "block";
}

export function fakeBurnReader(options: FakeBurnOptions): BurnReader & { readonly calls: { receipt: number } } {
  const calls = { receipt: 0 };
  return {
    calls,
    chainId: async () => {
      if (options.throws === "chainId") throw new Error("down");
      return options.chainId ?? "0xaa36a7";
    },
    receipt: async () => {
      calls.receipt += 1;
      if (options.throws === "receipt") throw new Error("down");
      if (options.receipt !== undefined) return options.receipt;
      return { transactionHash: options.txHash, status: options.status ?? "0x1", blockNumber: "0xb69b88", blockHash: BLOCK_HASH, logs: options.logs ?? [transferLog(options.token, options.payTo, options.amount, 151)] };
    },
    blockByNumber: async () => {
      if (options.throws === "block") throw new Error("down");
      return { number: "0xb69b88", hash: options.blockHash ?? BLOCK_HASH };
    },
  };
}
