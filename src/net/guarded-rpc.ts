/**
 * SSRF 防御 A: viem の JSON-RPC `http` transport を guarded transport に通す（設計 §3.5 の経路 11・12）。
 * 内部の期限はこの transport だけが持つ（viem の timeout は 0 = 無効）。
 * `src/` で viem の `http()` を作ってよいのは**ここだけ**（`tests/unit/no-direct-fetch.test.ts` が検査する）。
 *
 * body の所有: viem は `fetchFn` が返した応答の body を自分で読むが、その読み取りは viem の timeout（headers で解除）の外にあり、
 * 失敗は viem の例外に包まれて adapter の catch で固定の結果に変わる（報告 0）。そこで **body はここで読み切り**、
 * 応答全体（headers + body）に 1 つの期限を掛け、headers 後の失敗は `transport.report` で 1 回報告してから投げる。
 * viem には読み切った body を持つ新しい `Response` を渡す（viem はネットワークに触れない）。
 */
import { http, type HttpTransport } from "viem";

import type { GuardedTransport, TransportContext } from "./guarded-fetch.js";

export interface GuardedRpcOptions {
  /** 既定 0（RPC の自動再送をしない。送金系は adapter 側でも 1 回に制限している）。 */
  readonly retryCount?: number | undefined;
  readonly retryDelay?: number | undefined;
  /**
   * 応答全体（headers + body）の期限。既定 10 s（viem の既定と同じ）。関数なら**要求ごとに**読む（残りの予算を期限にする用。
   * 0 以下なら要求を出さずに失敗する）。
   */
  readonly timeout?: number | (() => number) | undefined;
  /** 能力の http transport が持っていた `fetchOptions`（認証ヘッダ等）。そのまま引き継ぐ。 */
  readonly fetchOptions?: RequestInit | undefined;
  /** body の上限。既定 10 MiB（viem の既定と同じ）。超えたら切って失敗（`transport_failed`）。 */
  readonly maxResponseBytes?: number | undefined;
}

/** 1 要求の応答全体の期限の既定（`timeout` を渡さないとき）。drain の上限の試験（タスク R-0）が読む。 */
export const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** 要求ごとの期限が尽きている（`timeout` が 0 以下を返した）。要求は出していない。 */
export class RpcBudgetExhaustedError extends Error {
  override readonly name = "RpcBudgetExhaustedError";
  constructor() {
    super("rpc budget exhausted before the request");
  }
}

export class RpcResponseTooLargeError extends Error {
  override readonly name = "RpcResponseTooLargeError";
  constructor(maxBytes: number) {
    super(`rpc response exceeded ${maxBytes} bytes`);
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new RpcResponseTooLargeError(maxBytes);
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** `context` は要求ごとに読む（受信は AsyncLocalStorage、送信は request-local ctx から route を引く）。 */
export function guardedRpcTransport(
  transport: GuardedTransport,
  url: string,
  context: () => TransportContext,
  options: GuardedRpcOptions = {},
): HttpTransport {
  const timeoutOf = typeof options.timeout === "function" ? options.timeout : (): number => (options.timeout as number | undefined) ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = context();
    const timeoutMs = timeoutOf();
    if (!(timeoutMs > 0)) {
      throw new RpcBudgetExhaustedError();
    }
    // 応答全体の期限。viem の timeout は headers で解除されるので、body の読み取りまでここで覆う。
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const response = await transport.fetch(input instanceof Request ? input.url : input, { ...init, signal }, ctx);
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(response, maxBytes);
    } catch (error) {
      // headers 後の失敗（停滞 → upstream_timeout、切断 → transport_failed、上限超過 → transport_failed）。報告者はここ。
      transport.report(error, ctx);
      throw error;
    }
    return new Response(NULL_BODY_STATUS.has(response.status) ? null : bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof globalThis.fetch;
  return http(url, {
    fetchFn,
    ...(options.fetchOptions === undefined ? {} : { fetchOptions: options.fetchOptions }),
    retryCount: options.retryCount ?? 0,
    ...(options.retryDelay === undefined ? {} : { retryDelay: options.retryDelay }),
    // viem 自身の timeout は**無効**（0 なら viem はタイマーを置かず signal も渡さない）。viem のタイマーは `fetchFn` より前に始まるので
    // 「transport の期限 + 余白」では順序を保証できず、viem の AbortError が `aborted` に化ける。期限は transport だけが持つ
    // （実装レビュー #3 の指摘 1）。呼び出し側が渡した signal は `AbortSignal.any` で保つ。
    timeout: 0,
  });
}
