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

import { address, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
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
  /**
   * 別の fixture と **state を共有する**（`atas`・`transactions`・`signatureStatuses`…）。`calls` はこの fixture の分だけ。
   * MPP Solana 送信: Router の RPC と pay-kit の server の RPC を別の口にして、Router の要求だけを数える。
   */
  readonly shareStateWith?: SolanaRpcFixture;
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
  /** この method だけ JSON-RPC の error を返す（他は `reply` のまま）。 */
  failMethods: string[];
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
  /**
   * `sendTransaction` の応答（MPP Solana 受信の `transaction` 型の送出。`docs/mpp-solana-design.md` §8.1）: `ok` = 署名を返し `transactions` に登録、
   * `rpc-error` = JSON-RPC の error（preflight の失敗の形）、`already-processed` = error だが `transactions` に登録（payer が先に送出していた形）、
   * `no-response` = 応答しない（接続は開いたまま）、`wrong-signature` = 登録はするが**別の署名**を返す（RPC が送った bytes と違うものを受理した形）。
   */
  sendReply: "ok" | "rpc-error" | "already-processed" | "no-response" | "wrong-signature";
  /**
   * `getTransaction` の **base64** の読み（MPP Solana 送信の領収の照合。pay-kit の server は jsonParsed で読むので影響しない）:
   * `ok`、`null`（無い）、`err`（`meta.err` あり）、`no-slot`（`slot` 無し）、`other`（登録済みの**別の**取引を返す。無ければ null）。
   */
  transactionBase64Reply: "ok" | "null" | "err" | "no-slot" | "other" | "tamper-message" | "tamper-sig0" | "tamper-sig1";
  /** 受けた `sendTransaction` の base64（順）。 */
  sent: string[];
  /** `getTransaction` が返す transaction（署名 → 内容）。`sendTransaction` の `ok`／`already-processed` が登録し、試験が直接も置ける。 */
  transactions: Map<string, { base64: string; err: unknown; slot: number; blockTime: number | null }>;
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
  /** この口だけで JSON-RPC の error を返す method（state を共有する別の口には効かない）。 */
  readonly localFailMethods: string[];
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

/** wire（base64）の署名 [0]（base58）。読めなければ `undefined`。 */
export function signatureOfBase64(base64: string): string | undefined {
  try {
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length < 65 || bytes[0] === 0) return undefined;
    return getBase58Decoder().decode(new Uint8Array(bytes.subarray(1, 65)));
  } catch {
    return undefined;
  }
}

/**
 * `getTransaction` の `jsonParsed` の形（pay-kit の server の `verifyOnChain` が読む欄だけ: `message.instructions[].programId`・`program`・`parsed`、
 * `accountKeys`、`signatures`）。`TransferChecked`（discriminator 12）と Memo だけ parse し、他は `programId` と `data` のまま。
 */
export function parsedTransactionOf(base64: string): unknown {
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  const [tx] = getTransactionDecoder().read(bytes, 0);
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as { staticAccounts: readonly string[]; header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number }; instructions: readonly { programAddressIndex: number; accountIndices?: readonly number[]; data?: ArrayLike<number> }[]; lifetimeToken: string };
  const keys = compiled.staticAccounts.map(String);
  const signatureCount = bytes[0] ?? 0;
  const signatures: string[] = [];
  for (let i = 0; i < signatureCount; i += 1) signatures.push(getBase58Decoder().decode(bytes.subarray(1 + i * 64, 65 + i * 64)));
  const instructions = compiled.instructions.map((ix) => {
    const programId = keys[ix.programAddressIndex]!;
    const data = new Uint8Array(ix.data ?? []);
    const accounts = (ix.accountIndices ?? []).map((index) => keys[index]!);
    if ((programId === String(TOKEN_PROGRAM_ADDRESS) || programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") && data[0] === 12 && data.length === 10 && accounts.length >= 4) {
      let amount = 0n;
      for (let i = 7; i >= 0; i -= 1) amount = (amount << 8n) | BigInt(data[1 + i]!);
      const decimals = data[9]!;
      return { programId, program: "spl-token", parsed: { type: "transferChecked", info: { source: accounts[0], mint: accounts[1], destination: accounts[2], authority: accounts[3], tokenAmount: { amount: amount.toString(), decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: (Number(amount) / 10 ** decimals).toString() } } } };
    }
    if (programId === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr") {
      return { programId, program: "spl-memo", parsed: new TextDecoder().decode(data) };
    }
    return { programId, accounts, data: getBase58Decoder().decode(data) };
  });
  const signerCount = compiled.header.numSignerAccounts;
  const readonlySigners = compiled.header.numReadonlySignerAccounts;
  const readonlyNonSigners = compiled.header.numReadonlyNonSignerAccounts;
  const accountKeys = keys.map((pubkey, index) => ({ pubkey, signer: index < signerCount, writable: index < signerCount ? index < signerCount - readonlySigners : index < keys.length - readonlyNonSigners, source: "transaction" }));
  return { signatures, message: { accountKeys, instructions, recentBlockhash: String(compiled.lifetimeToken) } };
}

export async function startSolanaRpc(accounts: SolanaRpcAccounts): Promise<SolanaRpcFixture> {
  const tokenProgram = accounts.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const blockhash = accounts.blockhash ?? "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD";
  const calls: { method: string; params: unknown }[] = [];
  /** この口だけで JSON-RPC の error を返す method（`state.failMethods` は共有の state 全体に効く）。 */
  const localFailMethods: string[] = [];
  const state: SolanaRpcState = accounts.shareStateWith?.state ?? { delayMs: 0, reply: "ok", redirectTo: undefined, signatureStatuses: undefined, gate: undefined, sendReply: "ok", transactionBase64Reply: "ok", sent: [], transactions: new Map(), atas: [...(accounts.ata === undefined ? [] : [accounts.ata]), ...(accounts.atas ?? [])], failMethods: [] };
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
      if (state.failMethods.includes(method) || localFailMethods.includes(method)) {
        reply(undefined, id, { code: -32000, message: "fixture: method failure" });
        return;
      }
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
      if (method === "simulateTransaction") {
        // pay-kit の server が送出の前に呼ぶ（`result.value.err` を見る）。
        reply({ context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 1, accounts: null, returnData: null } }, id);
        return;
      }
      if (method === "sendTransaction") {
        const [base64] = (params as [string] | undefined) ?? [];
        if (typeof base64 !== "string") {
          reply(undefined, id, { code: -32602, message: "invalid params" });
          return;
        }
        state.sent.push(base64);
        const signature = signatureOfBase64(base64);
        if (state.sendReply === "no-response") return; // 応答しない（要求の期限で切れる）
        if (state.sendReply === "rpc-error") {
          reply(undefined, id, { code: -32002, message: "Transaction simulation failed: Blockhash not found" });
          return;
        }
        if (signature !== undefined && !state.transactions.has(signature)) {
          state.transactions.set(signature, { base64, err: null, slot: 1, blockTime: Math.floor(Date.now() / 1000) });
        }
        if (state.sendReply === "already-processed") {
          reply(undefined, id, { code: -32002, message: "Transaction simulation failed: This transaction has already been processed" });
          return;
        }
        reply(state.sendReply === "wrong-signature" ? "1".repeat(87) : (signature ?? ""), id);
        return;
      }
      if (method === "getTransaction") {
        const [signature, config] = (params as [string, { encoding?: string } | undefined] | undefined) ?? [];
        const encoding = config?.encoding ?? "json";
        let known = typeof signature === "string" ? state.transactions.get(signature) : undefined;
        // MPP Solana 送信の領収の照合（base64 の読み）だけを操作する（pay-kit の server の jsonParsed の読みはそのまま）。
        if (encoding === "base64" && state.transactionBase64Reply === "null") known = undefined;
        if (encoding === "base64" && state.transactionBase64Reply === "other") {
          known = [...state.transactions.entries()].find(([sig]) => sig !== signature)?.[1];
        }
        if (known === undefined) {
          reply(null, id);
          return;
        }
        let base64 = known.base64;
        if (encoding === "base64" && state.transactionBase64Reply.startsWith("tamper-")) {
          // 1 バイトだけ変える: message の末尾 / 署名 [0] の先頭 / 署名 [1] の先頭（他は同じ = その 1 点の照合だけを観測する）。
          const bytes = Buffer.from(base64, "base64");
          const at = state.transactionBase64Reply === "tamper-message" ? bytes.length - 1 : state.transactionBase64Reply === "tamper-sig0" ? 1 : 65;
          bytes[at] = (bytes[at] ?? 0) ^ 0x01;
          base64 = bytes.toString("base64");
        }
        const transaction = encoding === "base64" ? [base64, "base64"] : parsedTransactionOf(known.base64);
        const err = encoding === "base64" && state.transactionBase64Reply === "err" ? { InstructionError: [2, "Custom"] } : known.err;
        const result: Record<string, unknown> = { slot: known.slot, blockTime: known.blockTime, version: 0, transaction, meta: { err, fee: 5000, preBalances: [], postBalances: [], innerInstructions: [], logMessages: [], preTokenBalances: [], postTokenBalances: [], rewards: [], computeUnitsConsumed: 1 } };
        if (encoding === "base64" && state.transactionBase64Reply === "no-slot") delete result["slot"];
        reply(result, id);
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
  return { url: `${accounts.tls === undefined ? "http" : "https"}://127.0.0.1:${port}`, port, calls, connections: () => connections, state, localFailMethods, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
