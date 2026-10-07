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
  /** ATA（jsonParsed で返す）。無ければ `null`。 */
  readonly ata?: { readonly address: string; readonly owner: string; readonly mint?: string; readonly program?: string };
  readonly blockhash?: string;
  /** TLS で待つ（guarded transport の本番方針の試験）。 */
  readonly tls?: TlsMaterial;
}

export interface SolanaRpcState {
  /** 応答を遅らせる（ms）。 */
  delayMs: number;
  /** `ok`、`huge`（64 KiB 超、Content-Length 無し）、`malformed`（JSON でない）、`redirect`（302）、`error`（500）。 */
  reply: "ok" | "huge" | "malformed" | "redirect" | "error";
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

export async function startSolanaRpc(accounts: SolanaRpcAccounts): Promise<SolanaRpcFixture> {
  const tokenProgram = accounts.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const blockhash = accounts.blockhash ?? "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD";
  const calls: { method: string; params: unknown }[] = [];
  const state: SolanaRpcState = { delayMs: 0, reply: "ok", redirectTo: undefined };
  let connections = 0;
  const mintData = Buffer.from(
    getMintEncoder().encode({ mintAuthority: null, supply: 1_000_000_000_000n, decimals: accounts.decimals, isInitialized: true, freezeAuthority: null }),
  ).toString("base64");

  const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      const reply = (result: unknown, id: unknown, error?: { code: number; message: string }): void => {
        const send = (): void => {
          if (state.reply === "redirect") {
            response.writeHead(302, { location: state.redirectTo ?? "https://other.test/" });
            response.end();
            return;
          }
          if (state.reply === "error") {
            response.writeHead(500, { "content-type": "application/json" });
            response.end('{"error":"SECRET_INTERNAL_DETAIL"}');
            return;
          }
          if (state.reply === "malformed") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end('{"jsonrpc":"2.0","result":');
            return;
          }
          if (state.reply === "huge") {
            response.writeHead(200, { "content-type": "application/json" });
            response.write('{"jsonrpc":"2.0","id":1,"result":{"pad":"');
            for (let i = 0; i < 70; i += 1) response.write("p".repeat(1024));
            response.end('"}}');
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
      if (method === "getLatestBlockhash") {
        reply({ context: { slot: 1 }, value: { blockhash, lastValidBlockHeight: 1000 } }, id);
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
        if (accounts.ata !== undefined && pubkey === accounts.ata.address) {
          const program = accounts.ata.program ?? tokenProgram;
          const mint = accounts.ata.mint ?? accounts.mint;
          const data = encoding === "jsonParsed"
            ? { program: "spl-token", parsed: { type: "account", info: { mint, owner: accounts.ata.owner, state: "initialized", isNative: false, tokenAmount: { amount: "0", decimals: accounts.decimals, uiAmount: 0, uiAmountString: "0" } } }, space: 165 }
            : [Buffer.from(getTokenEncoder().encode({ mint: address(mint), owner: address(accounts.ata.owner), amount: 0n, delegate: null, state: 1, isNative: null, delegatedAmount: 0n, closeAuthority: null })).toString("base64"), "base64"];
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
