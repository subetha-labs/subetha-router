/**
 * SVM の送信 adapter が共有する部分（x402 SVM 送信 `x402-svm.ts` から括り出し。挙動は変えない。`docs/mpp-solana-design.md` §4.5・§5.1、タスク M2）:
 * Router の ATA と静的 route の宛先 ATA の起動時の検査、運用者の集合への ATA の追加、残高、Solana RPC の 4 method（`getAccountInfo`・`getLatestBlockhash`・
 * `getTokenAccountBalance`・`getTransaction`）の封筒。鍵には触れない（公開鍵だけ）。
 */
import { address } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";

import type { GuardedTransport } from "../../net/guarded-fetch.js";
import { assertAtaAccount, svmFetchJson } from "../inbound/x402-svm-startup.js";
import { isSvmPublicKey } from "./x402-svm.js";

/** base units の 10 進文字列（括り出す前の `x402-svm.ts` と同じ: 桁数の上限は設けない）。 */
const AMOUNT_PATTERN = /^(0|[1-9][0-9]*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 静的 route の destination（起動時の ATA の検査と候補の照合に使う固定値）。 */
export interface SvmStaticDestination {
  readonly payTo: string;
  readonly asset: string;
  readonly scheme: string;
}

export type SvmRpcMethod = "getAccountInfo" | "getLatestBlockhash" | "getTokenAccountBalance" | "getTransaction";

export interface SvmOutboundCommonOptions {
  /** adapter の名前（起動の失敗の文に出す固定語。値ではない）。 */
  readonly label: string;
  readonly rpc: { readonly url: string; readonly transport: GuardedTransport };
  readonly rpcTimeoutMs: number;
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram: string;
  /** Router の公開鍵（署名の能力の address）。 */
  readonly routerAddress: string;
  /** 運用者の集合（§2.3）。`startup()` が ATA を足すので可変の Set。 */
  readonly operatorAddresses: Set<string>;
  /** 静的 route の destination（`routeId` → payTo・asset・scheme）。 */
  readonly destinations: Readonly<Record<string, SvmStaticDestination>>;
  /** 静的 route の宛先の `scheme` として許す値（x402 は `exact`、MPP Solana は `solana/charge`）。 */
  readonly staticScheme: string;
}

export interface SvmOutboundCommon {
  /** `startup()` の後の Router の ATA（前なら throw）。 */
  ready(): string;
  ataOf(owner: string): Promise<string>;
  rpcResult(method: SvmRpcMethod, params: unknown[], operation: string, routeId: string): Promise<Record<string, unknown> | undefined>;
  ataExists(ata: string, owner: string, operation: string, routeId: string): Promise<boolean>;
  blockhashOf(reply: Record<string, unknown> | undefined): { blockhash: string; lastValidBlockHeight: bigint } | undefined;
  /** 静的 route の宛先 ATA（起動時に導いて検査した値）。 */
  staticAtaOf(routeId: string): string | undefined;
  startup(): Promise<void>;
  balanceOf(routeId: string, asset: string): Promise<bigint>;
}

export function createSvmOutboundCommon(options: SvmOutboundCommonOptions): SvmOutboundCommon {
  const { label, operatorAddresses: operators } = options;
  let routerAta: string | undefined;
  const staticAtas = new Map<string, string>();

  function ready(): string {
    if (routerAta === undefined) throw new Error(`${label}: startup() has not completed`);
    return routerAta;
  }

  async function ataOf(owner: string): Promise<string> {
    const [ata] = await findAssociatedTokenPda({ mint: address(options.mint), owner: address(owner), tokenProgram: address(options.tokenProgram) });
    return String(ata);
  }

  /** JSON-RPC の封筒を組んで `result` を含む応答を返す（method は 4 つだけ。失敗は `undefined`）。 */
  async function rpcResult(method: SvmRpcMethod, params: unknown[], operation: string, routeId: string): Promise<Record<string, unknown> | undefined> {
    let reply: Record<string, unknown> | undefined;
    try {
      reply = await svmFetchJson(options.rpc.transport, options.rpc.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, options.rpcTimeoutMs, operation, routeId);
    } catch {
      return undefined;
    }
    return reply;
  }

  /** 宛先 ATA が表どおりに存在するか（`getAccountInfo` → `assertAtaAccount`）。 */
  async function ataExists(ata: string, owner: string, operation: string, routeId: string): Promise<boolean> {
    const reply = await rpcResult("getAccountInfo", [ata, { encoding: "jsonParsed", commitment: "confirmed" }], operation, routeId);
    try {
      assertAtaAccount(reply, { owner, mint: options.mint, tokenProgram: options.tokenProgram });
      return true;
    } catch {
      return false;
    }
  }

  function blockhashOf(reply: Record<string, unknown> | undefined): { blockhash: string; lastValidBlockHeight: bigint } | undefined {
    const result = reply?.["result"];
    const value = isRecord(result) ? result["value"] : undefined;
    if (!isRecord(value)) return undefined;
    const blockhash = value["blockhash"];
    const height = value["lastValidBlockHeight"];
    if (typeof blockhash !== "string" || !isSvmPublicKey(blockhash)) return undefined;
    let lastValidBlockHeight: bigint;
    if (typeof height === "number" && Number.isSafeInteger(height) && height > 0) lastValidBlockHeight = BigInt(height);
    else if (typeof height === "string" && /^[1-9][0-9]*$/.test(height)) lastValidBlockHeight = BigInt(height);
    else return undefined;
    return { blockhash, lastValidBlockHeight };
  }

  return {
    ready,
    ataOf,
    rpcResult,
    ataExists,
    blockhashOf,
    staticAtaOf: (routeId) => staticAtas.get(routeId),

    async startup(): Promise<void> {
      const ata = await ataOf(options.routerAddress);
      for (const [routeId, destination] of Object.entries(options.destinations)) {
        if (!isSvmPublicKey(destination.payTo) || destination.asset !== options.mint || destination.scheme !== options.staticScheme) {
          throw new Error(`${label}: static route ${routeId} has a destination this adapter cannot pay`);
        }
        const destinationAta = await ataOf(destination.payTo);
        if (destinationAta === ata) throw new Error(`${label}: static route ${routeId} pays the Router's own token account`);
        if (!(await ataExists(destinationAta, destination.payTo, "solana_rpc_startup", routeId))) {
          throw new Error(`${label}: the destination token account of static route ${routeId} does not exist or is not the table's ATA`);
        }
        staticAtas.set(routeId, destinationAta);
      }
      // 運用者の集合に Router の ATA と、集合にある SVM の公開鍵の ATA を足す（§2.3 (c)）。
      operators.add(ata);
      for (const operator of [...operators]) {
        if (isSvmPublicKey(operator) && operator !== ata) {
          try {
            operators.add(await ataOf(operator));
          } catch {
            // ATA を導けない文字列（program 等）はそのまま。
          }
        }
      }
      routerAta = ata;
    },

    async balanceOf(routeId: string, asset: string): Promise<bigint> {
      const ata = ready();
      if (asset !== options.mint) throw new Error(`${label}: balance requested for a different asset`);
      const reply = await rpcResult("getTokenAccountBalance", [ata, { commitment: "confirmed" }], "solana_rpc_balance", routeId);
      const result = reply?.["result"];
      const value = isRecord(result) ? result["value"] : undefined;
      const amount = isRecord(value) ? value["amount"] : undefined;
      if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) throw new Error(`${label}: the RPC did not return a token balance`);
      return BigInt(amount);
    },
  };
}
