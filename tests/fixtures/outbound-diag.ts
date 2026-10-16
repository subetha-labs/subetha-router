/**
 * 送信の adapter の診断の試験の部品（設計 `docs/rejection-reasons-design.md` §4.3・§8.2、タスク R-4）。**製品コードではない。**
 *
 * - `fakeUpstream()`: メモリの上流と、それを相手にする `GuardedTransport` の差し替え（静的用は loopback 可、動的用は loopback 不可・DNS の期限あり）。
 *   未払いの要求には `PAYMENT-REQUIRED` つきの 402、支払いヘッダつきの要求には `pay` の返す応答を返す。要求の記録（順序・回数・ヘッダの名前）と、
 *   本文の読み取りの回数（`pulls`）・中断（`cancelled`）を数える本文を作れる。
 * - `dynamicRail`・`arcRail`・`baseRail`: 乱数の鍵で実際に署名する 3 つの経路（動的 EVM・静的 Arc の組み直し・静的 Base の SDK の経路）。
 * 鍵・署名は試験の中だけ。外への接続・送金は無い。
 */
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { createX402Outbound } from "../../src/adapters/outbound/x402.js";
import type { DynamicProfile } from "../../src/config.js";
import { TransportError, type GuardedTransport, type TransportCode, type TransportContext } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, OutboundRail, PayRequest, UpstreamTarget } from "../../src/ports/outbound.js";
import type { DiagnosticsSink } from "../../src/shared/diagnostics.js";

export const BASE = "eip155:84532";
export const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const ARC = "eip155:5042002";
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
export const PROVIDER = "0x00000000000000000000000000000000000a1100";
export const OPERATOR_PAY_TO = "0x00000000000000000000000000000000000000b0";
export const TX = `0x${"7a".repeat(32)}`;
export const SVM_SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
export const STATIC_URL = "https://provider.test/v1/eth/snapshot";
export const DYNAMIC_URL = "https://provider.test/v1/price?symbol=ETH";
export const STATIC_ROUTE = "md-diag-eth-snapshot";
export const PROFILE_ID = "dyn-x402-to-x402-diag";

export const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "mpp",
  source: { network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", decimals: 6, payTo: OPERATOR_PAY_TO },
  rail: "x402",
  destination: { scheme: "exact", network: BASE, asset: BASE_USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "0", bps: 0, min: "0" },
};

export function offerOf(network: string, asset: string, overrides: Record<string, unknown> = {}): DestinationOffer {
  return { scheme: "exact", network, asset, amount: "1000", payTo: PROVIDER, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" }, ...overrides } as DestinationOffer;
}

/** 本文の読み取りを数える ReadableStream（highWaterMark 0: 読まれるまで 1 バイトも作らない）。 */
export interface BodyStats {
  pulls: number;
  cancelled: boolean;
}
export function countingBody(text: string, stats: BodyStats, options: { readonly failAfterPulls?: number; readonly error?: unknown } = {}): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        stats.pulls += 1;
        if (options.failAfterPulls !== undefined && stats.pulls > options.failAfterPulls) {
          controller.error(options.error ?? new Error("body stream failed (test)"));
          return;
        }
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 64));
        offset += chunk.length;
        controller.enqueue(chunk);
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
}

/** 支払いつきの要求への応答（`throws` なら fetch が投げる）。 */
export type PayReply =
  | {
      readonly status: number;
      readonly receipt?: Record<string, unknown> | string;
      /** `X-PAYMENT-RESPONSE` に載せる（`PAYMENT-RESPONSE` と別に）。 */
      readonly legacyReceipt?: Record<string, unknown> | string;
      /** `PAYMENT-REQUIRED` に載せる（object なら符号化、文字列ならそのまま）。 */
      readonly paymentRequired?: Record<string, unknown> | string;
      readonly body?: string;
      readonly contentType?: string;
      readonly headers?: Record<string, string>;
      readonly failBodyAfterPulls?: number;
      readonly bodyError?: unknown;
    }
  | { readonly throws: unknown };

export interface FakeUpstream {
  accepts: Record<string, unknown>[];
  resourceUrl: ((url: string) => string) | undefined;
  /** 未払いの要求への応答の差し替え（`undefined` なら 402 + `PAYMENT-REQUIRED`）。 */
  challenge: ((url: string, n: number) => Response | { throws: unknown }) | undefined;
  pay: (payment: unknown) => PayReply;
  /** 要求の記録（`challenge <url>`・`pay <url> <ヘッダの名前>`）。 */
  readonly requests: string[];
  /** 受けた支払い（decode した `PAYMENT-SIGNATURE`）。 */
  readonly payments: unknown[];
  /** 試験の出来事の列（transport・sink が書く）。 */
  readonly events: string[];
  /** 最後の有料応答の本文の読み取り。 */
  readonly body: BodyStats;
  readonly staticTransport: GuardedTransport;
  readonly dynamicTransport: GuardedTransport;
  readonly reports: string[];
}

function headerValue(value: Record<string, unknown> | string, encode: (v: never) => string): string {
  return typeof value === "string" ? value : encode(value as never);
}

export function payReplyResponse(reply: Exclude<PayReply, { throws: unknown }>, stats: BodyStats): Response {
  const headers: Record<string, string> = { "content-type": reply.contentType ?? "application/json", ...(reply.headers ?? {}) };
  if (reply.receipt !== undefined) headers["PAYMENT-RESPONSE"] = headerValue(reply.receipt, encodePaymentResponseHeader);
  if (reply.legacyReceipt !== undefined) headers["X-PAYMENT-RESPONSE"] = headerValue(reply.legacyReceipt, encodePaymentResponseHeader);
  if (reply.paymentRequired !== undefined) headers["PAYMENT-REQUIRED"] = headerValue(reply.paymentRequired, encodePaymentRequiredHeader);
  const body = countingBody(reply.body ?? "{}", stats, { ...(reply.failBodyAfterPulls === undefined ? {} : { failAfterPulls: reply.failBodyAfterPulls }), ...(reply.bodyError === undefined ? {} : { error: reply.bodyError }) });
  return new Response(body, { status: reply.status, headers });
}

export function fakeUpstream(): FakeUpstream {
  const self: FakeUpstream = {
    accepts: [],
    resourceUrl: undefined,
    challenge: undefined,
    pay: () => ({ status: 200, body: JSON.stringify({ price: 1 }) }),
    requests: [],
    payments: [],
    events: [],
    body: { pulls: 0, cancelled: false },
    reports: [],
    staticTransport: undefined as unknown as GuardedTransport,
    dynamicTransport: undefined as unknown as GuardedTransport,
  };
  let challenges = 0;
  const fetch = async (input: string | URL, init: RequestInit | undefined, context: TransportContext): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const signature = headers["PAYMENT-SIGNATURE"] ?? headers["X-PAYMENT"];
    if (signature === undefined) {
      challenges += 1;
      self.requests.push(`challenge ${init?.method ?? "GET"} ${url} ${context.operation}`);
      const custom = self.challenge?.(url, challenges);
      if (custom !== undefined) {
        if ("throws" in custom) throw custom.throws;
        return custom;
      }
      const required = { x402Version: 2, error: "payment_required", resource: { url: self.resourceUrl === undefined ? url : self.resourceUrl(url) }, accepts: self.accepts };
      return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never) } });
    }
    self.requests.push(`pay ${init?.method ?? "GET"} ${url} ${Object.keys(headers).sort().join(",")} ${context.operation}`);
    let payment: unknown;
    try {
      payment = decodePaymentSignatureHeader(signature);
    } catch {
      payment = undefined;
    }
    self.payments.push(payment);
    self.events.push("pay:sent");
    const reply = self.pay(payment);
    if ("throws" in reply) {
      self.events.push("pay:threw");
      throw reply.throws;
    }
    self.body.pulls = 0;
    self.body.cancelled = false;
    const response = payReplyResponse(reply, self.body);
    self.events.push("pay:headers");
    return response;
  };
  const report = (error: unknown, context: TransportContext): void => {
    self.reports.push(`${error instanceof TransportError ? error.code : "body"} ${context.operation}`);
  };
  (self as { staticTransport: GuardedTransport }).staticTransport = { fetch, report, allowLoopback: true, boundsDns: false };
  (self as { dynamicTransport: GuardedTransport }).dynamicTransport = { fetch, report, allowLoopback: false, boundsDns: true };
  return self;
}

/** transport の失敗（固定の code）。 */
export function transportError(code: TransportCode, operation: string): TransportError {
  return new TransportError(code, { operation }, new Error(`inner failure https://canary-url.test/secret (test)`));
}

export interface RailEnv {
  readonly rail: OutboundRail;
  readonly upstream: FakeUpstream;
  readonly address: string;
  readonly signatures: () => number;
  readonly request: (offer: DestinationOffer, overrides?: Partial<PayRequest>) => PayRequest;
  readonly clock: { now: number; afterSign: number | undefined };
}

export interface RailOptions {
  readonly diagnostics?: DiagnosticsSink;
  readonly signerNetwork?: string;
  readonly signerThrows?: boolean;
  readonly denyHosts?: readonly string[];
  /** 決まった鍵（3 通りの比較で結果の bytes を揃える）。無ければ乱数の鍵。 */
  readonly privateKey?: `0x${string}`;
}

function signerOf(env: { count: number; clock: RailEnv["clock"] }, throws: boolean, privateKey: `0x${string}` | undefined) {
  const account = privateKeyToAccount(privateKey ?? generatePrivateKey());
  return {
    address: account.address,
    signer: {
      address: account.address,
      async signTypedData(message: never): Promise<`0x${string}`> {
        if (throws) throw new Error("signer failed https://canary-url.test/secret (test)");
        env.count += 1;
        const signature = await account.signTypedData(message);
        if (env.clock.afterSign !== undefined) env.clock.now = env.clock.afterSign;
        return signature;
      },
    },
  };
}

let paymentSeq = 0;
function requestFactory(routeId: string, clock: RailEnv["clock"], target: UpstreamTarget | undefined) {
  return (offer: DestinationOffer, overrides: Partial<PayRequest> = {}): PayRequest => {
    paymentSeq += 1;
    return {
      routeId,
      offer,
      paymentId: `00000000-0000-4000-8000-${String(paymentSeq).padStart(12, "0")}`,
      attempt: 1,
      deadlineMs: clock.now + 600_000,
      ...(target === undefined ? {} : { target }),
      ...overrides,
    };
  };
}

/** 動的 EVM（Base Sepolia の USDC、組み直しの署名器）。 */
export function dynamicRail(options: RailOptions = {}): RailEnv {
  const upstream = fakeUpstream();
  upstream.accepts = [offerOf(BASE, BASE_USDC) as unknown as Record<string, unknown>];
  const clock: RailEnv["clock"] = { now: Date.now(), afterSign: undefined };
  const count = { count: 0, clock };
  const { address, signer } = signerOf(count, options.signerThrows === true, options.privateKey);
  const rail = createX402Outbound({
    upstreams: {},
    transport: upstream.staticTransport,
    capability: { network: options.signerNetwork ?? BASE, kind: "real-key", signer },
    dynamic: { profiles: { [PROFILE_ID]: PROFILE }, transport: upstream.dynamicTransport, now: () => clock.now, ...(options.denyHosts === undefined ? {} : { denyHosts: options.denyHosts }) },
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  return { rail, upstream, address, signatures: () => count.count, request: requestFactory(PROFILE_ID, clock, { url: DYNAMIC_URL, method: "GET" }), clock };
}

/** 静的 Arc（組み直しの署名器・共有の領収の表）。 */
export function arcRail(options: RailOptions = {}): RailEnv {
  const upstream = fakeUpstream();
  upstream.accepts = [offerOf(ARC, ARC_USDC) as unknown as Record<string, unknown>];
  const clock: RailEnv["clock"] = { now: Date.now(), afterSign: undefined };
  const count = { count: 0, clock };
  const { address, signer } = signerOf(count, options.signerThrows === true, options.privateKey);
  const rail = createX402Outbound({
    upstreams: { [STATIC_ROUTE]: STATIC_URL },
    transport: upstream.staticTransport,
    capability: { network: options.signerNetwork ?? ARC, kind: "real-key", signer },
    rebuildSignatures: true,
    tokenDomains: { [ARC_USDC.toLowerCase()]: { name: "USDC", version: "2" } },
    now: () => clock.now,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  return { rail, upstream, address, signatures: () => count.count, request: requestFactory(STATIC_ROUTE, clock, undefined), clock };
}

/** 静的 Base（SDK の typed data・SDK の `processResponse`）。 */
export function baseRail(options: RailOptions = {}): RailEnv {
  const upstream = fakeUpstream();
  upstream.accepts = [offerOf(BASE, BASE_USDC) as unknown as Record<string, unknown>];
  const clock: RailEnv["clock"] = { now: Date.now(), afterSign: undefined };
  const count = { count: 0, clock };
  const { address, signer } = signerOf(count, options.signerThrows === true, options.privateKey);
  const rail = createX402Outbound({
    upstreams: { [STATIC_ROUTE]: STATIC_URL },
    transport: upstream.staticTransport,
    capability: { network: options.signerNetwork ?? BASE, kind: "real-key", signer },
    now: () => clock.now,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  return { rail, upstream, address, signatures: () => count.count, request: requestFactory(STATIC_ROUTE, clock, undefined), clock };
}

/** 整合した領収（`payer` は署名者）。 */
export function okReceipt(network: string, payer?: string): Record<string, unknown> {
  return { success: true, network, transaction: TX, ...(payer === undefined ? {} : { payer }) };
}
