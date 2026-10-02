/**
 * SSRF 防御 A: viem の JSON-RPC `http` transport を guarded transport に通す（設計 §3.5 の経路 11・12）。
 * `src/` で viem の `http()` を作ってよいのは**ここだけ**（`tests/unit/no-direct-fetch.test.ts` が検査する）。
 */
import { http, type HttpTransport } from "viem";

import type { GuardedTransport, TransportContext } from "./guarded-fetch.js";

export interface GuardedRpcOptions {
  /** 既定 0（RPC の自動再送をしない。送金系は adapter 側でも 1 回に制限している）。 */
  readonly retryCount?: number | undefined;
  readonly retryDelay?: number | undefined;
  readonly timeout?: number | undefined;
}

/** `context` は要求ごとに読む（受信は AsyncLocalStorage、送信は request-local ctx から route を引く）。 */
export function guardedRpcTransport(
  transport: GuardedTransport,
  url: string,
  context: () => TransportContext,
  options: GuardedRpcOptions = {},
): HttpTransport {
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
    transport.fetch(input instanceof Request ? input.url : input, init, context())) as typeof globalThis.fetch;
  return http(url, {
    fetchFn,
    retryCount: options.retryCount ?? 0,
    ...(options.retryDelay === undefined ? {} : { retryDelay: options.retryDelay }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
}
