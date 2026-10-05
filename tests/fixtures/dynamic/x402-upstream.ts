/**
 * 動的上流 URL の試験用の x402 v2 上流（TLS、プロセス内）。**試験基盤であり製品の Provider ではない。**
 *
 * 既存の `tests/fixtures/x402-upstream.ts` は「起動時に決まった 1 本の URL・クエリなし・HTTP」の静的経路用。
 * こちらは**任意のパスとクエリ**を受け、`resource.url` に「要求された URL そのもの」を返す（動的経路の束縛の試験用）。
 * 署名は検証しない（検証は `verifying-facilitator.ts` の役目）。返す `transaction` は合成値。
 */
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
}

export interface X402Upstream {
  readonly port: number;
  readonly host: string;
  readonly state: X402UpstreamState;
  readonly seen: { challenges: number; payments: unknown[]; urls: string[]; connections: number };
  close(): Promise<void>;
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
export function paidOk(payer: string, body: unknown = { ok: true }): PayResponse {
  return { status: 200, body: JSON.stringify(body), contentType: "application/json", receipt: { success: true, network: FIXTURE_NETWORK, transaction: FIXTURE_TX, payer } };
}

export async function startX402Upstream(tls: TlsMaterial, host = "provider.test"): Promise<X402Upstream> {
  const seen = { challenges: 0, payments: [] as unknown[], urls: [] as string[], connections: 0 };
  const state: X402UpstreamState = {
    accepts: [standardAccept()],
    topLevel: {},
    resourceUrl: (requestedUrl) => requestedUrl,
    bodyAccepts: undefined,
    pay: () => ({ status: 500, body: "{}" }),
    challengeBodyPadding: 0,
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
      response.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never) });
      response.end(body);
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
      response.end(reply.body);
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
