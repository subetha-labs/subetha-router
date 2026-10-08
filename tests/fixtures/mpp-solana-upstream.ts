/**
 * Provider D の fixture（`docs/mpp-solana-design.md` §8.1、タスク M4-b）: **本物の `@solana/pay-kit` の server**（mppx 0.13.2 を同梱）が challenge を出し、
 * Router の credential（pull: [0] 空・[1] Router の署名）を検証し、fee payer として共同署名して **fixture の RPC** に送出し、確定を待って
 * `Payment-Receipt` を返す。鍵は毎回の乱数。chain には出ない。**テスト基盤であり製品の Provider ではない。**
 *
 * 応答の改変（`state.pay`）は pay-kit の応答を**受け取った後**に施す（pay-kit 自身の検証・送出・確定待ちは常に本物）:
 * `ok` / `no-receipt` / `receipt-wrong-challenge` / `receipt-wrong-reference` / `receipt-bad-reference` / `receipt-method-tempo` / `receipt-payer-mismatch` /
 * `receipt-no-challenge-id` / `status-with-receipt`（503 + 領収）/ `status-no-receipt`（503）/ `reject`（400。領収なし）/ `non-json` / `too-large` / `truncated` /
 * `stall-after-headers`（headers の後で body を止める）。`seen` が challenge・支払い要求・credential・領収を記録する。
 */
import http from "node:http";
import https from "node:https";
import { Gate, Signer, createPayKit, usd } from "@solana/pay-kit";

import type { TlsMaterial } from "./tls/generate.js";

export type MppSolanaUpstreamPayMode =
  | "ok"
  | "no-receipt"
  | "receipt-wrong-challenge"
  | "receipt-wrong-reference"
  | "receipt-bad-reference"
  | "receipt-method-tempo"
  | "receipt-payer-mismatch"
  | "receipt-no-challenge-id"
  | "status-with-receipt"
  | "status-no-receipt"
  | "reject"
  | "non-json"
  | "too-large"
  | "truncated"
  | "stall-after-headers"
  | "hold";

export interface MppSolanaUpstreamState {
  pay: MppSolanaUpstreamPayMode;
  /** 402 を出す前に待つ（ms）。 */
  challengeDelayMs: number;
  /** 402 ではなく 200 を返す（challenge が読めない形）。 */
  noChallenge: boolean;
  /**
   * 402 の `WWW-Authenticate` に **もう 1 つの challenge** を足す（pay-kit の challenge の写し: 額 2 倍、別の id。HMAC は検証しないので Router は候補として読める）。
   * `first` = 足した方を先頭に（SDK はそれを選ぶ）、`last` = 末尾に。
   */
  extraChallenge: "none" | "first" | "last";
  /** `pay: "hold"`: 支払い要求に **headers も出さずに** この時間待ってから普通に答える（Router の有料要求の期限の試験）。 */
  holdMs: number;
}

export interface MppSolanaUpstreamSeen {
  challengeCalls: number;
  payCalls: number;
  /** 支払い要求の `Authorization` の値（順）。 */
  credentials: string[];
  /** pay-kit が出した領収（改変前。順）。 */
  receipts: string[];
  /** 支払い要求のパス（順）。 */
  paths: string[];
}

export interface MppSolanaUpstream {
  readonly port: number;
  readonly base: string;
  /** pay-kit の operator（fee payer）の公開鍵。 */
  readonly operator: string;
  /** 受取 owner。 */
  readonly recipient: string;
  readonly state: MppSolanaUpstreamState;
  readonly seen: MppSolanaUpstreamSeen;
  close(): Promise<void>;
}

export interface MppSolanaUpstreamOptions {
  readonly rpcUrl: string;
  /** pay-kit の `operator.feePayer`（pull = true）。 */
  readonly feePayer: boolean;
  /** 受取 owner（既定: 乱数の鍵）。 */
  readonly recipient?: string;
  /** challenge に載せる `externalId`（Memo。無ければ Memo 無し）。 */
  readonly externalId?: string;
  readonly description?: string;
  /** USD の額（既定 "0.01" = 10000 base units）。 */
  readonly usdAmount?: string;
  readonly realm?: string;
  /** TLS で待つ（動的上流の URL は https だけ。guarded transport の本番方針の試験）。 */
  readonly tls?: TlsMaterial;
}

/** pay-kit の challenge（`Payment id="…", realm="…", …, request="<base64url>"`）の写しを、額 2 倍・別の id で作る。 */
function doubledCopyOf(header: string): string {
  const id = /id="([^"]+)"/.exec(header)?.[1] ?? "";
  const request = /request="([^"]+)"/.exec(header)?.[1] ?? "";
  const decoded = JSON.parse(Buffer.from(request, "base64url").toString("utf8")) as Record<string, unknown>;
  const doubled = { ...decoded, amount: String(BigInt(String(decoded["amount"])) * 2n) };
  const copy = header.replace(`id="${id}"`, `id="${id.slice(0, -2)}zz"`).replace(`request="${request}"`, `request="${Buffer.from(JSON.stringify(doubled), "utf8").toString("base64url")}"`);
  return copy;
}

function rewriteReceipt(header: string, patch: (receipt: Record<string, unknown>) => Record<string, unknown>): string {
  const decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>;
  return Buffer.from(JSON.stringify(patch(decoded)), "utf8").toString("base64url");
}

export async function startMppSolanaUpstream(options: MppSolanaUpstreamOptions): Promise<MppSolanaUpstream> {
  const operator = await Signer.generate();
  const recipient = options.recipient ?? String((await Signer.generate()).signer.address);
  const pay = await createPayKit({
    network: "devnet",
    rpcUrl: options.rpcUrl,
    accept: ["mpp"],
    operator: { signer: operator, feePayer: options.feePayer, recipient },
    mpp: { challengeBindingSecret: "provider-d-fixture-secret-0123456789abcdef0123456789", realm: options.realm ?? "provider-d-fixture" },
  } as never);
  const gate = Gate.create(
    { amount: usd(options.usdAmount ?? "0.01"), name: "paid", ...(options.externalId === undefined ? {} : { externalId: options.externalId }), ...(options.description === undefined ? {} : { description: options.description }) },
    { accept: ["mpp"], payTo: recipient } as never,
  );
  const handler = pay.fetch(gate, async () => Response.json({ ok: true, source: "mpp-solana-provider" }));
  const state: MppSolanaUpstreamState = { pay: "ok", challengeDelayMs: 0, noChallenge: false, extraChallenge: "none", holdMs: 0 };
  const seen: MppSolanaUpstreamSeen = { challengeCalls: 0, payCalls: 0, credentials: [], receipts: [], paths: [] };

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const authorization = request.headers["authorization"];
    const paying = typeof authorization === "string" && authorization !== "";
    if (paying) {
      seen.payCalls += 1;
      seen.credentials.push(authorization);
      seen.paths.push(request.url ?? "");
    } else {
      seen.challengeCalls += 1;
      if (state.challengeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.challengeDelayMs));
      if (state.noChallenge) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${request.url ?? "/"}`;
    let out: Response;
    try {
      out = await handler(new Request(url, { method: request.method ?? "GET", headers, ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}) }));
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const outHeaders = Object.fromEntries(out.headers.entries());
    if (!paying && state.extraChallenge !== "none" && typeof outHeaders["www-authenticate"] === "string") {
      const original = outHeaders["www-authenticate"];
      const extra = doubledCopyOf(original);
      outHeaders["www-authenticate"] = state.extraChallenge === "first" ? `${extra}, ${original}` : `${original}, ${extra}`;
    }
    let status = out.status;
    let body = Buffer.from(await out.arrayBuffer());
    const receipt = out.headers.get("payment-receipt");
    if (paying && receipt !== null) seen.receipts.push(receipt);
    if (paying && state.pay === "hold") await new Promise((resolve) => setTimeout(resolve, state.holdMs));
    if (paying && receipt !== null) {
      const mode = state.pay;
      const patch = (fn: (r: Record<string, unknown>) => Record<string, unknown>): void => {
        outHeaders["payment-receipt"] = rewriteReceipt(receipt, fn);
      };
      if (mode === "no-receipt" || mode === "status-no-receipt" || mode === "reject") delete outHeaders["payment-receipt"];
      if (mode === "receipt-wrong-challenge") patch((r) => ({ ...r, challengeId: "0".repeat(43) }));
      if (mode === "receipt-no-challenge-id") patch((r) => { const { challengeId: _c, ...rest } = r; return rest; });
      if (mode === "receipt-wrong-reference") patch((r) => ({ ...r, reference: "2".repeat(87) }));
      if (mode === "receipt-bad-reference") patch((r) => ({ ...r, reference: "0xdeadbeef" }));
      if (mode === "receipt-method-tempo") patch((r) => ({ ...r, method: "tempo" }));
      if (mode === "receipt-payer-mismatch") patch((r) => ({ ...r, payer: operator.signer.address }));
      if (mode === "status-with-receipt" || mode === "status-no-receipt") { status = 503; body = Buffer.from("{}"); }
      if (mode === "reject") { status = 400; body = Buffer.from("{}"); }
      if (mode === "non-json") { outHeaders["content-type"] = "text/html"; body = Buffer.from("<html>paid</html>"); }
      if (mode === "too-large") { body = Buffer.from(JSON.stringify({ ok: true, pad: "x".repeat(300 * 1024) })); }
      if (mode === "truncated" || mode === "stall-after-headers") {
        delete outHeaders["content-length"];
        response.writeHead(status, { ...outHeaders, "content-length": String(mode === "truncated" ? body.length + 100 : body.length) });
        response.flushHeaders();
        if (mode === "truncated") {
          response.write(body.subarray(0, Math.floor(body.length / 2)));
          setTimeout(() => response.destroy(), 50);
        }
        // stall: headers だけ書いて待つ（接続は Router の期限で切れる）。
        return;
      }
    }
    delete outHeaders["content-length"];
    response.writeHead(status, { ...outHeaders, "content-length": String(body.length) });
    response.end(body);
  };
  const server = options.tls === undefined ? http.createServer((q, s) => void handle(q, s)) : https.createServer({ key: options.tls.provider.key, cert: options.tls.provider.cert }, (q, s) => void handle(q, s));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    base: `${options.tls === undefined ? "http" : "https"}://127.0.0.1:${port}`,
    operator: String(operator.signer.address),
    recipient,
    state,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
