/**
 * 署名の道具（`npm run sign` と行列の driver）の診断の観測（設計 `docs/rejection-reasons-design.md` §6、§12.3・§12.4・§12.7・§13.2 が優先。D-11）。
 * **製品コードではない**（鍵を扱う側の補助）。**観測だけ**: 署名・送金の判断・保留はここを一切読まない。
 *
 * - `observedRpcFetch`: Tempo の payer（`tools/mpp-payer.ts`）の RPC の HTTP（既存の `fetchFn` の差し替え口）を包む。要求は **そのまま** 渡す。
 *   送金の method（`eth_sendRawTransaction`・`eth_sendRawTransactionSync`）なら **送る前に** 要求の本文の raw tx から `localTxRefOf` で
 *   hash を作り、`attempted` を知らせる（raw の tx は手放す）。送った後は応答の HTTP の status か、例外の分類（`timeout`・`other`）だけ。
 *   **応答の本文は読まない・clone しない**（§12.3: 大きさを偽る応答・止まる本文で待ちが生じ得る）。RPC の結果（tx hash）も残さない（§12.4）。
 * - `createSignTracker`: 段（`SignDeps.onStage`）と RPC の観測を、最後の段・`broadcast`・`rpc`・手元で計算した `txRef` に畳む。
 *
 * `tools/mpp-payer.ts` は変えない: payer の package（`packages/payer/src/vendor/mpp-payer.ts`）がバイト一致で写しているため、
 * 観測は既存の `fetchFn` に渡す（要求は変わらない）。
 */
import { localTxRefOf, type DiagSignerStage, type LocalTxRef } from "../src/shared/diagnostics.js";

import type { SignStageEvent } from "./sign-run.js";

export type SignBroadcast = "not_observed" | "attempted" | "accepted" | "http_error" | "timeout";
export type RpcFailureClass = "timeout" | "other";

/** 送金の method（Tempo の local account は viem の `sendTransactionSync` → `eth_sendRawTransactionSync`）。 */
const SEND_METHODS: ReadonlySet<string> = new Set(["eth_sendRawTransaction", "eth_sendRawTransactionSync"]);
const RAW_TX = /^0x(?:[0-9a-fA-F]{2})+$/;

export interface SignRpcObserver {
  /** 送る直前（同期）。値は手元で計算した hash だけ。 */
  sendAttempted(txRef: LocalTxRef): void;
  /** 送金の要求に HTTP の応答（headers）が来た。本文は読まない。 */
  sendAnswered(httpStatus: number): void;
  /** 送金の要求が例外で終わった。 */
  sendThrew(error: RpcFailureClass): void;
}

/** 要求の本文（viem の JSON-RPC の文字列。1 件か配列）から、送金の method の raw tx を読む。要求の側だけを見る。無い・読めなければ `undefined`。 */
export function sentRawTxOf(init: RequestInit | undefined): `0x${string}` | undefined {
  const body = init?.body;
  if (typeof body !== "string") return undefined;
  const parsed: unknown = JSON.parse(body);
  for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
    if (typeof call !== "object" || call === null) continue;
    const { method, params } = call as { method?: unknown; params?: unknown };
    if (typeof method !== "string" || !SEND_METHODS.has(method) || !Array.isArray(params)) continue;
    const raw: unknown = params[0];
    if (typeof raw === "string" && RAW_TX.test(raw)) return raw as `0x${string}`;
  }
  return undefined;
}

/** fetch の例外の分類（名前だけ。文言・原因は読まない）。viem の期限は AbortController の中断（`AbortError`）。 */
export function rpcFailureClassOf(error: unknown): RpcFailureClass {
  try {
    const name = (error as { name?: unknown } | null)?.name;
    return name === "AbortError" || name === "TimeoutError" ? "timeout" : "other";
  } catch {
    return "other";
  }
}

function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // 観測の失敗は無視する（SR-R3・SR-R4）。
  }
}

/**
 * `fetchFn` を包む。要求（`input`・`init`）は同じ値をそのまま渡し、返す応答も同じ object（本文に触れない）。
 * `async` にしない（例外の stack に包みの枠を足さない）。`base` が無ければ呼ぶ時点の `globalThis.fetch`。
 */
export function observedRpcFetch(observer: SignRpcObserver, base?: typeof fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    let sending = false;
    quietly(() => {
      const raw = sentRawTxOf(init);
      if (raw === undefined) return;
      const txRef = localTxRefOf(raw);
      sending = true;
      observer.sendAttempted(txRef);
    });
    const pending = base === undefined ? globalThis.fetch(input, init) : base(input, init);
    if (!sending) return pending;
    return pending.then(
      (response) => {
        quietly(() => observer.sendAnswered(response.status));
        return response;
      },
      (error: unknown) => {
        quietly(() => observer.sendThrew(rpcFailureClassOf(error)));
        throw error;
      },
    );
  }) as typeof fetch;
}

/** 最後に観測した状態（記録・証跡に写す値。`txRef` は `localTxRefOf` の値だけ）。 */
export interface SignDiagnosticState {
  readonly signerStage?: DiagSignerStage;
  readonly broadcast: SignBroadcast;
  readonly rpc?: "timeout" | "rate_limited" | "other";
  readonly rpcHttpStatus?: number;
  readonly txRef?: LocalTxRef;
}

export interface SignTracker {
  readonly onStage: (event: SignStageEvent) => void;
  readonly observer: SignRpcObserver;
  snapshot(): SignDiagnosticState;
}

/**
 * 段と RPC の観測を畳む。`onChange` は状態が変わるたびに（同期で）呼ぶ（`npm run sign` は 1 行ずつ記録する）。
 * 送金の分類: 送る前 `attempted` → 2xx `accepted`（本文は読まないので JSON-RPC の成否は分からない）・それ以外 `http_error`（429 は `rate_limited`）・
 * 期限 `timeout`・ほかの例外は `attempted` のまま `rpc:"other"`。送る前に止まれば `not_observed` のまま。
 */
export function createSignTracker(onChange?: (state: SignDiagnosticState) => void): SignTracker {
  let state: SignDiagnosticState = { broadcast: "not_observed" };
  const set = (next: SignDiagnosticState): void => {
    state = Object.freeze(next);
    if (onChange !== undefined) quietly(() => onChange(state));
  };
  const withoutRpc = (s: SignDiagnosticState): SignDiagnosticState => {
    const { rpc: _rpc, rpcHttpStatus: _status, ...rest } = s;
    return rest;
  };
  return {
    onStage: (event) => {
      const stage = event.stage;
      set({ ...state, signerStage: stage });
    },
    observer: {
      sendAttempted: (txRef) => set({ ...withoutRpc(state), broadcast: "attempted", txRef }),
      sendAnswered: (httpStatus) => {
        const status = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : undefined;
        if (status !== undefined && status >= 200 && status < 300) set({ ...withoutRpc(state), broadcast: "accepted", rpcHttpStatus: status });
        else set({ ...withoutRpc(state), broadcast: "http_error", rpc: status === 429 ? "rate_limited" : "other", ...(status === undefined ? {} : { rpcHttpStatus: status }) });
      },
      sendThrew: (error) => set(error === "timeout" ? { ...withoutRpc(state), broadcast: "timeout", rpc: "timeout" } : { ...withoutRpc(state), rpc: "other" }),
    },
    snapshot: () => state,
  };
}
