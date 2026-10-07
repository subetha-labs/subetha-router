/**
 * 動的上流 URL の試験用の x402 v2 上流（TLS、プロセス内）。**試験基盤であり製品の Provider ではない。**
 *
 * 既存の `tests/fixtures/x402-upstream.ts` は「起動時に決まった 1 本の URL・クエリなし・HTTP」の静的経路用。
 * こちらは**任意のパスとクエリ**を受け、`resource.url` に「要求された URL そのもの」を返す（動的経路の束縛の試験用）。
 * 署名は検証しない（検証は `verifying-facilitator.ts` の役目）。返す `transaction` は合成値。
 */
import type { ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";

import type { TlsMaterial } from "../tls/generate.js";

export interface X402Accept {
  [key: string]: unknown;
}

export interface X402UpstreamState {
  /** 402 に載せる `accepts`。試験の途中で差し替えられる。 */
  accepts: X402Accept[];
  /** `PAYMENT-REQUIRED` のトップレベルに足す欄。 */
  topLevel: Record<string, unknown>;
  /** `resource.url` を作る。既定は要求された URL そのもの。 */
  resourceUrl: (requestedUrl: string) => string;
  /** 本文にも `accepts` を載せるか（ヘッダと食い違う内容を載せる試験用）。 */
  bodyAccepts: X402Accept[] | undefined;
  /** 支払いつきの要求への応答。 */
  pay: (context: { payment: unknown; requestedUrl: string }) => PayResponse;
  /** 402 の本文に足すバイト数（上限の試験用）。 */
  challengeBodyPadding: number;
  /** 402 の本文を、この総量になるまで少しずつ送る（「読まれた量」を測る試験用）。 */
  challengeStreamBytes: number | undefined;
  /** 402 の応答に足すヘッダ（ヘッダの上限の試験用）。 */
  challengeHeaders: Record<string, string>;
  /** 402 の代わりに返す状態コード（リダイレクトなどの試験用）。 */
  challengeStatus: number;
  /** 402 を返すまでの待ち（ミリ秒）。 */
  challengeDelayMs: number;
}

export interface PayResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string;
  /** `PAYMENT-RESPONSE` に載せる内容。`undefined` ならヘッダを付けない。 */
  readonly receipt?: Record<string, unknown> | undefined;
  /** 応答を返すまでの待ち（ミリ秒）。 */
  readonly delayMs?: number;
  /** 追加のヘッダ。 */
  readonly headers?: Record<string, string>;
  /** `body` の代わりに、この総量になるまで本文を少しずつ送る（「読まれた量」を測る試験用）。 */
  readonly streamBytes?: number;
  /** `streamBytes` と併用: この量を送ったところで**何も送らずに止まる**（本文の途中で固まる上流）。 */
  readonly stallAfterBytes?: number;
  /** `streamBytes` と併用: この量を送ったところで**接続を切る**。 */
  readonly resetAfterBytes?: number;
}

export interface X402Upstream {
  readonly port: number;
  readonly host: string;
  readonly state: X402UpstreamState;
  readonly seen: { challenges: number; payments: unknown[]; urls: string[]; connections: number; streams: StreamRecord[] };
  close(): Promise<void>;
}

/** 少しずつ送った本文 1 本の記録。`written` は相手が受け取りを止めるまでにソケットへ渡せた量。 */
export interface StreamRecord {
  readonly total: number;
  written: number;
  completed: boolean;
  closed: boolean;
}

/**
 * 本文を 16 KiB ずつ、**相手が読んだ分だけ**送る（`write` が詰まったら `drain` を待つ）。相手が読むのをやめれば、
 * 送れる量はソケットのバッファの分で止まる。総量よりずっと少ない `written` は「読み切られなかった」ことを示す。
 */
function streamBody(response: ServerResponse, total: number, records: StreamRecord[], cut: { stallAfter?: number | undefined; resetAfter?: number | undefined } = {}): void {
  const record: StreamRecord = { total, written: 0, completed: false, closed: false };
  records.push(record);
  const chunk = Buffer.alloc(16 * 1024, 0x20);
  response.on("close", () => {
    record.closed = true;
  });
  const pump = (): void => {
    while (!record.closed && record.written < total) {
      if (cut.stallAfter !== undefined && record.written >= cut.stallAfter) return;
      if (cut.resetAfter !== undefined && record.written >= cut.resetAfter) {
        // 送った分（ヘッダと本文の先頭）が相手に届いてから切る。すぐ切ると、ヘッダごと失われる。
        setTimeout(() => response.socket?.destroy(), 100);
        return;
      }
      const size = Math.min(chunk.length, total - record.written);
      const flowing = response.write(size === chunk.length ? chunk : chunk.subarray(0, size));
      record.written += size;
      if (!flowing) {
        response.once("drain", pump);
        return;
      }
    }
    if (!record.closed) {
      record.completed = true;
      response.end();
    }
  };
  pump();
}

export const FIXTURE_NETWORK = "eip155:84532";
export const FIXTURE_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const FIXTURE_PAY_TO = "0x0000000000000000000000000000000000000a11";
export const FIXTURE_TX = `0x${"7a".repeat(32)}`;

/** 標準の 7 欄と `extra.{name,version}` だけの offer。 */
export function standardAccept(overrides: X402Accept = {}): X402Accept {
  return {
    scheme: "exact",
    network: FIXTURE_NETWORK,
    asset: FIXTURE_ASSET,
    amount: "1000",
    payTo: FIXTURE_PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

/** 成功の応答（JSON object ＋ 整合する receipt）。`payer` は支払い元のアドレス。 */
export function paidOk(payer: string, body: unknown = { ok: true }, network: string = FIXTURE_NETWORK): PayResponse {
  return { status: 200, body: JSON.stringify(body), contentType: "application/json", receipt: { success: true, network, transaction: FIXTURE_TX, payer } };
}

export async function startX402Upstream(tls: TlsMaterial, host = "provider.test"): Promise<X402Upstream> {
  const seen = { challenges: 0, payments: [] as unknown[], urls: [] as string[], connections: 0, streams: [] as StreamRecord[] };
  const state: X402UpstreamState = {
    accepts: [standardAccept()],
    topLevel: {},
    resourceUrl: (requestedUrl) => requestedUrl,
    bodyAccepts: undefined,
    pay: () => ({ status: 500, body: "{}" }),
    challengeBodyPadding: 0,
    challengeStreamBytes: undefined,
    challengeHeaders: {},
    challengeStatus: 402,
    challengeDelayMs: 0,
  };
  const server = https.createServer({ key: tls.provider.key, cert: tls.provider.cert }, (request, response) => {
    // 既定のポート（443）として見せる: Router が接続した URL は `https://<host><path>`。
    const requestedUrl = `https://${request.headers.host ?? host}${request.url ?? "/"}`;
    seen.urls.push(requestedUrl);
    const signature = request.headers["payment-signature"];
    if (typeof signature !== "string") {
      seen.challenges += 1;
      const required = { x402Version: 2, error: "payment_required", resource: { url: state.resourceUrl(requestedUrl) }, accepts: state.accepts, ...state.topLevel };
      const body = JSON.stringify({ ...(state.bodyAccepts === undefined ? {} : { x402Version: 2, accepts: state.bodyAccepts }), pad: "p".repeat(state.challengeBodyPadding) });
      const sendChallenge = (): void => {
        response.writeHead(state.challengeStatus, { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never), ...state.challengeHeaders });
        if (state.challengeStreamBytes === undefined) response.end(body);
        else streamBody(response, state.challengeStreamBytes, seen.streams);
      };
      if (state.challengeDelayMs === 0) sendChallenge();
      else setTimeout(sendChallenge, state.challengeDelayMs);
      return;
    }
    let payment: unknown;
    try {
      payment = decodePaymentSignatureHeader(signature);
    } catch {
      payment = undefined;
    }
    seen.payments.push(payment);
    const reply = state.pay({ payment, requestedUrl });
    const send = (): void => {
      response.writeHead(reply.status, {
        "content-type": reply.contentType ?? "application/json",
        ...(reply.receipt === undefined ? {} : { "PAYMENT-RESPONSE": encodePaymentResponseHeader(reply.receipt as never) }),
        ...(reply.headers ?? {}),
      });
      if (reply.streamBytes === undefined) response.end(reply.body);
      else streamBody(response, reply.streamBytes, seen.streams, { stallAfter: reply.stallAfterBytes, resetAfter: reply.resetAfterBytes });
    };
    if (reply.delayMs === undefined) send();
    else setTimeout(send, reply.delayMs);
  });
  server.on("secureConnection", () => {
    seen.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    host,
    state,
    seen,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
