/**
 * 購入の診断の記録（設計 `docs/rejection-reasons-design.md` §4.1、§12.3・§12.6・§13.1・§15.1 が優先。タスク R-2）。
 *
 * - **購入の全体の scope**（§12.6）: 静的・動的の purchase の入口で、変えない値（`paymentId`・`quoteId`（記録には hash）・`principalId`＋`requestId`
 *   （記録には hash）・`routeId`・`promoted`）の scope を作る。adapter を呼ぶ段は入れ子の scope（`attempt`・`promoted`）で包む。
 *   adapter の hook と transport の出来事（`composeRails` が包む `report`）は、push の時点の scope を sink が写す。
 * - **core の記録は控えるだけ**（§12.3・§13.1）: 判断の経路では `performance.now()` と参照を控えるだけで、記録の object は作らない。
 *   控えた記録は **購入の終わり**（journal の追記・応答の値・期限の判定がすべて済んだ後）に、購入の scope の中で 1 回ずつ push する。
 *   期限の判定の前に push する経路は無い（記録の位置で期限を越えさせない）。
 * - sink が無い（`NOOP`）なら何もしない: scope も作らず、時刻も読まない（a/b/c の比較で結果・journal・要求が同じであることを試験が確かめる。§8.2）。
 * - 返り値と例外はそのまま（`flush` は `finally` で、throw しない）。
 */
import { performance } from "node:perf_hooks";

import { NOOP_DIAGNOSTICS, safeEmit, withDiagnosticScope, type DiagCapture, type DiagnosticsSink, type DiagScope } from "../shared/diagnostics.js";

export interface PurchaseDiagnostics {
  /** sink が有効か（無効なら下のどれも何もしない）。 */
  readonly enabled: boolean;
  /** 段の始まり（無効なら 0。時刻を読まない）。 */
  start(): number;
  /** `start` からの経過（ms。無効なら `undefined`）。 */
  elapsedSince(startedAt: number): number | undefined;
  /** 記録を控える。`build` は購入の終わりの push のときに呼ぶ（値は呼び出し側が先に写しておく）。 */
  note(build: () => DiagCapture): void;
  /** adapter を呼ぶ段の入れ子の scope（無効なら `fn` をそのまま）。 */
  stage<T>(scope: DiagScope, fn: () => Promise<T>): Promise<T>;
}

/** 無効の値（sink が無いとき）。 */
export const DISABLED_PURCHASE_DIAGNOSTICS: PurchaseDiagnostics = Object.freeze({
  enabled: false,
  start: () => 0,
  elapsedSince: () => undefined,
  note: () => {},
  stage: <T>(_scope: DiagScope, fn: () => Promise<T>): Promise<T> => fn(),
});

/** sink が有効か（`undefined`・`NOOP` は無効）。 */
export function diagnosticsEnabled(sink: DiagnosticsSink | undefined): sink is DiagnosticsSink {
  return sink !== undefined && sink !== NOOP_DIAGNOSTICS;
}

/**
 * 購入の全体の scope で `body` を動かし、終わり（成功・失敗・throw のどれでも）に控えた記録を push する。
 * sink が無効なら scope を作らず `body(DISABLED)` をそのまま返す。
 */
export function withPurchaseDiagnostics<T>(sink: DiagnosticsSink | undefined, scope: DiagScope, body: (diag: PurchaseDiagnostics) => Promise<T>): Promise<T> {
  if (!diagnosticsEnabled(sink)) return body(DISABLED_PURCHASE_DIAGNOSTICS);
  const pending: Array<() => DiagCapture> = [];
  const diag: PurchaseDiagnostics = {
    enabled: true,
    start: () => performance.now(),
    elapsedSince: (startedAt) => Math.max(0, performance.now() - startedAt),
    note: (build) => {
      try {
        pending.push(build);
      } catch {
        // 控えられなければ捨てる（支払いの経路に出さない）。
      }
    },
    stage: (stageScope, fn) => withDiagnosticScope(stageScope, fn),
  };
  return withDiagnosticScope(scope, async () => {
    try {
      return await body(diag);
    } finally {
      // 購入の終わり: 控えた順に 1 件ずつ push（build・emit の例外は `safeEmit` が握る）。積む時点の scope は購入の scope。
      for (const build of pending.splice(0, pending.length)) safeEmit(sink, build);
    }
  });
}
