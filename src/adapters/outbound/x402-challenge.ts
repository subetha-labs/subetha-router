/**
 * x402 v2 の 402 challenge（`PAYMENT-REQUIRED`）の読み取り（送信の設計 §3.2・§4.4）。静的 x402（EVM）と SVM の送信が共有する。
 * 実 SDK（`@x402/fetch`）に読ませて検証し、未知の欄を落とさないように生の accepts も保つ。
 */
import { x402Client, x402HTTPClient } from "@x402/fetch";
import type { PaymentRequired } from "@x402/fetch";

import { discardBody, type GuardedTransport } from "../../net/guarded-fetch.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 402 応答の `PAYMENT-REQUIRED` を**生の JSON としても**読む（未知フィールドを落とさない）。 */
export function decodeRawPaymentRequired(header: string): { accepts: readonly unknown[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new Error("upstream PAYMENT-REQUIRED header is not base64 JSON");
  }
  if (!isRecord(raw) || !Array.isArray(raw["accepts"])) {
    throw new Error("upstream PAYMENT-REQUIRED has no accepts[]");
  }
  return { accepts: raw["accepts"] };
}

export interface X402Challenge {
  /**
   * SDK が検証・選択に使う形（公式 decoder が zod 検証した結果）。
   * v2 であることは**実行時に**確かめる（SDK 型の `x402Version` は `number`）。
   */
  readonly parsed: PaymentRequired;
  /** 未知のトップレベル / extra フィールドまで保った生の accepts。 */
  readonly rawAccepts: readonly unknown[];
  /** `PAYMENT-REQUIRED` ヘッダそのもの。 */
  readonly header: string;
}

/** 純粋読取の GET（支払いヘッダを付けない）。canonical URL への束縛（`resource.url` の一致）まで確かめる。 */
export async function readX402Challenge(transport: GuardedTransport, url: string, ctx: { routeId: string; operation: string }, timeoutMs: number): Promise<X402Challenge> {
  const response = await transport.fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  }, ctx);
  if (response.status !== 402) {
    discardBody(response); // 読まない body は捨てて接続を即時に解放する（設計 §3.3-7）
    throw new Error(`upstream challenge returned status ${response.status}`);
  }
  const header = response.headers.get("PAYMENT-REQUIRED");
  let body: unknown;
  try {
    body = await response.text();
  } catch (error) {
    transport.report(error, ctx);
    throw error;
  }
  if (header === null || header === "") {
    throw new Error("upstream challenge has no v2 PAYMENT-REQUIRED header");
  }
  // 実 SDK に読ませて検証する（自前の解釈で置き換えない）。
  const httpClient = new x402HTTPClient(new x402Client());
  const parsed = httpClient.getPaymentRequiredResponse((name) => response.headers.get(name), body);
  if (parsed.x402Version !== 2) {
    throw new Error("upstream challenge is not x402 v2");
  }
  const { accepts } = decodeRawPaymentRequired(header);
  // SDK が読んだ件数と生の件数が違えば、どの要素を承認したのか一致させられない。
  if (accepts.length !== parsed.accepts.length) {
    throw new Error("upstream challenge accepts[] could not be matched to the SDK view");
  }
  // canonical resource の束縛（クエリ無しの GET 1 本）。
  if (parsed.resource.url !== url) {
    throw new Error("upstream challenge resource does not match the canonical URL");
  }
  return { parsed, rawAccepts: accepts, header };
}
