/**
 * Solana の JSON-RPC の**最小の fixture**（プロセス内、plain HTTP。multirail 設計 §5.7）。
 * - `getAccountInfo`（base64）: mint の account（`fetchMint` が読む encoded の Mint data）
 * - `getAccountInfo`（jsonParsed）: owner の ATA（起動時の検査、T4-b）
 * - `getLatestBlockhash`
 * それ以外は -32601。要求を数える。**テスト基盤であり chain ではない。**
 */
import http from "node:http";
import https from "node:https";

import type { TlsMaterial } from "./tls/generate.js";

import { address } from "@solana/kit";
import { getMintEncoder, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

export interface SolanaRpcAccounts {
  readonly mint: string;
  readonly decimals: number;
  readonly tokenProgram?: string;
  /** ATA（jsonParsed で返す）。無ければ `null`。`atas` と併用できる（`state.atas` の初期値は `[ata, ...atas]`）。 */
  readonly ata?: SolanaRpcAta;
  /** 複数の ATA（送信: Router の ATA と宛先の ATA。残高は `amount`、既定 0）。 */
  readonly atas?: readonly SolanaRpcAta[];
  readonly blockhash?: string;
  /** TLS で待つ（guarded transport の本番方針の試験）。 */
  readonly tls?: TlsMaterial;
}

export interface SolanaRpcAta {
  readonly address: string;
  readonly owner: string;
  readonly mint?: string;
  readonly program?: string;
  /** base units（既定 "0"）。`getAccountInfo` の `tokenAmount` と `getTokenAccountBalance` の両方に出る。 */
  readonly amount?: string;
}

export interface SolanaRpcState {
  /** 今ある ATA（試験が途中で消す・足す・残高を変える）。`getAccountInfo`・`getTokenAccountBalance` が見る。 */
  atas: SolanaRpcAta[];
  /** 応答を遅らせる（ms）。 */
  delayMs: number;
  /**
   * `ok`、`huge`（**正しい結果**に 64 KiB 超の padding、Content-Length 無し）、`malformed`（JSON でない）、`redirect`（302）、
   * `error`（**正しい結果の本文**を HTTP 500 で）、`rpc-error`（HTTP 200 の JSON-RPC error）。
   */
  reply: "ok" | "huge" | "malformed" | "redirect" | "error" | "rpc-error";
  /**
   * `getSignatureStatuses` の応答の列（設計 §5.8 の試験用）。呼ばれるたびに 1 つ消費し、最後の値を繰り返す。
   * `null` は「知らない署名」、`processed`／`confirmed`／`finalized` はその確定度、`err` はチェーン上の失敗。未設定・空の列なら `null`。
   */
  signatureStatuses: Array<"null" | "processed" | "confirmed" | "finalized" | "err" | "err-confirmed" | "empty" | "no-err-key"> | undefined;
  /** 応答を返す前に待つ合図（試験が順序を固定するための barrier）。`undefined` なら待たない。 */
  gate: (() => Promise<void>) | undefined;
  redirectTo: string | undefined;
}

export interface SolanaRpcFixture {
  readonly url: string;
  readonly port: number;
  readonly calls: { method: string; params: unknown }[];
  readonly connections: () => number;
  readonly state: SolanaRpcState;
  close(): Promise<void>;
}

/** base units の 10 進文字列 → `uiAmountString`（文字列の算術。`Number` を通さないので精度を失わない）。 */
export function uiAmountStringOf(amount: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amount)) throw new Error("fixture: amount must be a decimal string");
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

export async function startSolanaRpc(accounts: SolanaRpcAccounts): Promise<SolanaRpcFixture> {
  const tokenProgram = accounts.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const blockhash = accounts.blockhash ?? "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD";
  const calls: { method: string; params: unknown }[] = [];
  const state: SolanaRpcState = { delayMs: 0, reply: "ok", redirectTo: undefined, signatureStatuses: undefined, gate: undefined, atas: [...(accounts.ata === undefined ? [] : [accounts.ata]), ...(accounts.atas ?? [])] };
  let connections = 0;
  const mintData = Buffer.from(
    getMintEncoder().encode({ mintAuthority: null, supply: 1_000_000_000_000n, decimals: accounts.decimals, isInitialized: true, freezeAuthority: null }),
  ).toString("base64");

  const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      const reply = (result: unknown, id: unknown, error?: { code: number; message: string }): void => {
        const gate = state.gate;
        if (gate !== undefined) {
          void gate().then(() => replyNow(result, id, error));
          return;
        }
        replyNow(result, id, error);
      };
      const replyNow = (result: unknown, id: unknown, error?: { code: number; message: string }): void => {
        const send = (): void => {
          if (state.reply === "redirect") {
            response.writeHead(302, { location: state.redirectTo ?? "https://other.test/" });
            response.end();
            return;
          }
          if (state.reply === "error") {
            // 本文は正しい結果（status だけが 500）: status の検査が無ければ通ってしまう形。
            const text = JSON.stringify({ jsonrpc: "2.0", id, result, note: "SECRET_INTERNAL_DETAIL" });
            response.writeHead(500, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
            response.end(text);
            return;
          }
          if (state.reply === "rpc-error") {
            const text = JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "SECRET_INTERNAL_DETAIL" } });
            response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
            response.end(text);
            return;
          }
          if (state.reply === "malformed") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"jsonrpc":"2.0","result":');
            return;
          }
          if (state.reply === "huge") {
            // 正しい結果に 64 KiB 超の padding（Content-Length 無し）: 上限が無ければ通ってしまう形。
            response.writeHead(200, { "content-type": "application/json" });
            response.write(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${JSON.stringify(result)},"pad":"`);
            for (let i = 0; i < 70; i += 1) response.write("p".repeat(1024));
            response.end('"}');
            return;
          }
          const text = JSON.stringify({ jsonrpc: "2.0", id, ...(error === undefined ? { result } : { error }) });
          response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
          response.end(text);
        };
        if (state.delayMs > 0) setTimeout(send, state.delayMs);
        else send();
      };
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        reply(undefined, null, { code: -32700, message: "parse error" });
        return;
      }
      const method = String(body["method"]);
      const params = body["params"];
      calls.push({ method, params });
      const id = body["id"];
      if (method === "getSignatureStatuses") {
        const queue = state.signatureStatuses === undefined || state.signatureStatuses.length === 0 ? ["null"] : state.signatureStatuses;
        const kind = queue.length > 1 ? queue.shift()! : queue[0]!;
        const entry =
          kind === "null" ? null
          : kind === "empty" ? {}
          : kind === "no-err-key" ? { slot: 1, confirmations: 1, confirmationStatus: "confirmed" }
          : kind === "err" ? { slot: 1, confirmations: 0, err: { InstructionError: [2, "Custom"] }, confirmationStatus: "processed" }
          : kind === "err-confirmed" ? { slot: 1, confirmations: 1, err: { InstructionError: [2, "Custom"] }, confirmationStatus: "confirmed" }
          : { slot: 1, confirmations: kind === "finalized" ? null : 1, err: null, confirmationStatus: kind };
        reply({ context: { slot: 1 }, value: [entry] }, id);
        return;
      }
      if (method === "getLatestBlockhash") {
        reply({ context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 1000 } }, id);
        return;
      }
      if (method === "getTokenAccountBalance") {
        const [pubkey] = (params as [string] | undefined) ?? [];
        const ata = state.atas.find((entry) => entry.address === pubkey);
        if (ata === undefined) {
          reply(undefined, id, { code: -32602, message: "Invalid param: could not find account" });
          return;
        }
        const amount = ata.amount ?? "0";
        reply({ context: { slot: 1 }, value: { amount, decimals: accounts.decimals, uiAmount: Number(uiAmountStringOf(amount, accounts.decimals)), uiAmountString: uiAmountStringOf(amount, accounts.decimals) } }, id);
        return;
      }
      if (method === "getAccountInfo") {
        const [pubkey, config] = (params as [string, { encoding?: string } | undefined]) ?? [];
        const encoding = config?.encoding ?? "base64";
        if (pubkey === accounts.mint) {
          const data = encoding === "jsonParsed"
            ? { program: "spl-token", parsed: { type: "mint", info: { decimals: accounts.decimals, isInitialized: true, mintAuthority: null, freezeAuthority: null, supply: "1000000000000" } }, space: 82 }
            : [mintData, "base64"];
          reply({ context: { slot: 1 }, value: { data, executable: false, lamports: 1_461_600, owner: tokenProgram, rentEpoch: 0, space: 82 } }, id);
          return;
        }
        const ata = state.atas.find((entry) => entry.address === pubkey);
        if (ata !== undefined) {
          const program = ata.program ?? tokenProgram;
          const mint = ata.mint ?? accounts.mint;
          const amount = ata.amount ?? "0";
          const data = encoding === "jsonParsed"
            ? { program: "spl-token", parsed: { type: "account", info: { mint, owner: ata.owner, state: "initialized", isNative: false, tokenAmount: { amount, decimals: accounts.decimals, uiAmount: Number(uiAmountStringOf(amount, accounts.decimals)), uiAmountString: uiAmountStringOf(amount, accounts.decimals) } } }, space: 165 }
            : [Buffer.from(getTokenEncoder().encode({ mint: address(mint), owner: address(ata.owner), amount: BigInt(amount), delegate: null, state: 1, isNative: null, delegatedAmount: 0n, closeAuthority: null })).toString("base64"), "base64"];
          reply({ context: { slot: 1 }, value: { data, executable: false, lamports: 2_039_280, owner: program, rentEpoch: 0, space: 165 } }, id);
          return;
        }
        reply({ context: { slot: 1 }, value: null }, id);
        return;
      }
      reply(undefined, id, { code: -32601, message: "method not found" });
    });
  };
  const server = accounts.tls === undefined ? http.createServer(handler) : https.createServer({ key: accounts.tls.provider.key, cert: accounts.tls.provider.cert }, handler);
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { url: `${accounts.tls === undefined ? "http" : "https"}://127.0.0.1:${port}`, port, calls, connections: () => connections, state, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
