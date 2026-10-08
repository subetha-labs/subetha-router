/**
 * Solana の署名の追跡（`getSignatureStatuses` を間隔ごとに、期限まで）。x402 SVM 受信の settle の後の追跡（multirail 設計 §5.8）から括り出した helper で、
 * MPP Solana 受信の `transaction` 型の送出の後の確定（`docs/mpp-solana-design.md` §3.5・§5.2）も使う。
 *
 * - 期限は **経過時間**（`deadlineAt`。`clock` の単位）。`maxPolls` があれば回数でも打ち切る（MPP Solana は 15。要件 SR-M1）
 * - `errTerminalAt`: `"any"` = chain 上の `err` を見たら終端（x402 受信の今までの読み方）、`"confirmed"` = `confirmed`／`finalized` で `err` のときだけ終端
 *   （`processed` + `err` は続行。MPP Solana）
 * - 1 要求の期限は `min(requestTimeoutMs, 残り)`（整数に切り下げ）。transport の失敗・形違い・RPC の error は報告して次の間隔へ
 * - 戻り値は 3 値。`settled`／`failed` 以外は `timeout`（呼び出し側が `unknown` に写す）
 */
import { readBoundedBody } from "../../net/bounded-body.js";
import type { GuardedTransport } from "../../net/guarded-fetch.js";

export const SVM_FOLLOW_UP_RESPONSE_MAX_BYTES = 64 * 1024;

const SVM_COMMITMENTS: ReadonlySet<unknown> = new Set(["processed", "confirmed", "finalized"]);

export type SvmFollowUpStatus = "settled" | "failed" | "pending";

/**
 * `getSignatureStatuses` の 1 件の判定。**形の正しい status**（object で `err` の欄を持ち、`confirmationStatus` が processed／confirmed／finalized）だけを
 * 判定に使う。`null`（知らない署名）・形の違うもの（`{}`、`err` の欄の無いもの）は `pending`。
 */
export function svmSignatureStatusOf(json: unknown, errTerminalAt: "any" | "confirmed" = "any"): SvmFollowUpStatus {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return "pending";
  const result = (json as Record<string, unknown>)["result"];
  if (typeof result !== "object" || result === null) return "pending";
  const value = (result as Record<string, unknown>)["value"];
  if (!Array.isArray(value)) return "pending";
  const entry = value[0];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "pending";
  const status = entry as Record<string, unknown>;
  if (!Object.hasOwn(status, "err") || !SVM_COMMITMENTS.has(status["confirmationStatus"])) return "pending";
  const confirmation = status["confirmationStatus"];
  const confirmed = confirmation === "confirmed" || confirmation === "finalized";
  if (status["err"] !== null) return errTerminalAt === "any" || confirmed ? "failed" : "pending";
  return confirmed ? "settled" : "pending";
}

/** 1 要求の期限: 要求ごとの上限と残りの小さい方。整数に切り下げる（`AbortSignal.timeout` は整数だけ）。 */
export function svmFollowUpRequestTimeoutOf(remainingMs: number, requestTimeoutMs: number): number {
  return Math.max(0, Math.floor(Math.min(requestTimeoutMs, remainingMs)));
}

export interface FollowSvmSignatureOptions {
  readonly rpc: { readonly url: string; readonly transport: GuardedTransport };
  readonly signature: string;
  readonly routeId: string;
  readonly operation: string;
  /** 完了の期限（`clock` の単位の絶対値）。 */
  readonly deadlineAt: number;
  readonly intervalMs: number;
  readonly requestTimeoutMs: number;
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly errTerminalAt: "any" | "confirmed";
  readonly searchTransactionHistory: boolean;
  /** 要求の回数の上限（任意）。超えれば `timeout`。 */
  readonly maxPolls?: number;
}

export async function followSvmSignature(options: FollowSvmSignatureOptions): Promise<"settled" | "failed" | "timeout"> {
  const { rpc, clock, sleep } = options;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[options.signature], { searchTransactionHistory: options.searchTransactionHistory }] });
  let polls = 0;
  for (;;) {
    const remaining = options.deadlineAt - clock();
    if (remaining <= 0) break;
    if (options.maxPolls !== undefined && polls >= options.maxPolls) break;
    polls += 1;
    let status: SvmFollowUpStatus = "pending";
    try {
      const response = await rpc.transport.fetch(
        rpc.url,
        { method: "POST", headers: { "content-type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(svmFollowUpRequestTimeoutOf(remaining, options.requestTimeoutMs)) },
        { routeId: options.routeId, operation: options.operation },
      );
      const read = await readBoundedBody(response, SVM_FOLLOW_UP_RESPONSE_MAX_BYTES);
      if (response.status === 200 && read.ok) {
        let json: unknown;
        try {
          json = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(read.bytes));
        } catch {
          json = undefined;
        }
        status = svmSignatureStatusOf(json, options.errTerminalAt);
      }
    } catch (error) {
      // transport の失敗（timeout・切断・上限超過）は報告して次の間隔へ（期限が守る）。
      rpc.transport.report(error, { routeId: options.routeId, operation: options.operation });
    }
    // 完了の期限は応答を読んだ後にも見る（要求の期限は取り消しを予約するだけで、続きが期限の前に走ることを保証しない）。
    if (clock() > options.deadlineAt) break;
    if (status === "settled") return "settled";
    if (status === "failed") return "failed";
    const wait = Math.min(options.intervalMs, options.deadlineAt - clock());
    if (wait <= 0) break;
    await sleep(wait);
  }
  return "timeout";
}
