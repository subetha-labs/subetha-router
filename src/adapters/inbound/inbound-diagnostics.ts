/**
 * 受信の adapter（x402 の kind `x402`・`circle`、SVM）の診断の hook の部品（設計 `docs/rejection-reasons-design.md` §4.2、§12.2・§12.3・§12.6・
 * §13.1・§15.1 が優先。タスク R-3）。
 *
 * - **本文は新しく読まない**（§12.2）: 使うのは `post` が既に読んで parse した JSON と HTTP の status だけ。
 * - **hook は固定の欄の写しを 1 回 push するだけ**（§13.1・§15.1）: 理由の生の値（`invalidReason`・`errorReason` の参照）を `rawReason` に置き、
 *   表の分類・hash は後回しの処理（`buildDiagRecord`）に任せる。`invalidMessage`・`errorMessage`・`error` など自由な文の欄は読まない（SR-R1）。
 * - **cid は facilitator を呼ぶ前に** 段の scope に結びつける（§12.6）: 送る要求の本文の文字列の参照を入れるだけで、取り出し（parse と
 *   `diagCidInputOf`）は後回しの処理。hot path の直列化は診断の有無で同じ（replacer 無しの `JSON.stringify` 1 回）。throw の経路（transport の出来事）も
 *   facilitator の記録と結びつく。形が違えば入れない（欄を書かない）。
 * - sink が無い（`undefined`・`NOOP`）なら何もしない: scope を作らず、時刻も読まず、直列化は有効でも無効でも同じ（§8.2 の比較）。credential は読み直さない。
 * - `post` が throw したとき adapter は記録しない（core が `transport` の分類を残す。§4.2）。
 */
import { DIAG_CID_REQUEST_MAX_BYTES, diagStringBytes, NOOP_DIAGNOSTICS, safeEmit, withDiagnosticScope, type DiagCapture, type DiagnosticsSink } from "../../shared/diagnostics.js";

/** 診断が有効か（`undefined`・`NOOP` は無効）。 */
export function inboundDiagnosticsOn(sink: DiagnosticsSink | undefined): sink is DiagnosticsSink {
  return sink !== undefined && sink !== NOOP_DIAGNOSTICS;
}

/** facilitator の種類（記録の `facilitator`）。 */
export type InboundDiagFacilitator = "x402" | "circle";

/** verify の応答の分類（§3 の `response`）。 */
export type VerifyResponseClass = "valid" | "invalid" | "not_json" | "http_error" | "proof_refused";
/** settle の応答の分類（§3 の `response`）。 */
export type SettleResponseClass = "ok" | "success_false" | "network_mismatch" | "tx_malformed" | "not_json" | "http_error" | "proof_refused";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 段の scope で `fn` を動かす（§12.6）。EVM の受信は **送る要求の本文の文字列の参照** を `cidRequestText` に入れるだけ（写し・parse・
 * 正規表現・credential の読み取りは無い。長さの比較だけ）。cid の入力は後回しの処理が自前の facilitator と同じ `diagCidInputOf` で取り出す。
 * 上限（`DIAG_CID_REQUEST_MAX_BYTES`）を超える本文は入れない（cid が付かないだけ）。無効・本文が無いなら `fn` をそのまま（scope を作らない）。
 * 返り値と例外はそのまま。
 */
export function withInboundDiagScope<T>(sink: DiagnosticsSink | undefined, requestText: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!inboundDiagnosticsOn(sink) || requestText === undefined || diagStringBytes(requestText) > DIAG_CID_REQUEST_MAX_BYTES) return fn();
  return withDiagnosticScope({ cidRequestText: requestText }, fn);
}

/**
 * 既に parse した本文から理由の欄の生の値だけを取る（`rawReason`）。本文が JSON の object でなければ `undefined`（欄を書かない = 見ていない）、
 * object に欄が無ければ `null`（記録は `absent`）。値の分類（表・`malformed`）は後回しの処理。
 */
export function rawReasonOf(json: unknown, field: "invalidReason" | "errorReason"): unknown {
  if (!isRecord(json)) return undefined;
  return Object.prototype.hasOwnProperty.call(json, field) ? json[field] : null;
}

/** 1 回の facilitator の往復の写し（hook の入力）。値は呼び出し側が既に持っているものだけ。 */
export interface InboundRoundTrip {
  readonly stage: "source_verify" | "source_settle";
  readonly facilitator: InboundDiagFacilitator;
  readonly network: string;
  readonly response: VerifyResponseClass | SettleResponseClass;
  /** 要求を出したときだけ（`proof_refused` は無し）。 */
  readonly httpStatus?: number;
  readonly json?: unknown;
  readonly elapsedMs?: number | undefined;
}

/**
 * 往復の記録を 1 回 push する（結果を作った後に呼ぶ）。`safeEmit` が build と emit の例外を握る。無効なら何もしない。
 */
export function emitInboundRoundTrip(sink: DiagnosticsSink | undefined, trip: InboundRoundTrip): void {
  if (!inboundDiagnosticsOn(sink)) return;
  safeEmit(sink, (): DiagCapture => {
    const field = trip.stage === "source_verify" ? "invalidReason" : "errorReason";
    const sent = trip.httpStatus !== undefined;
    const raw = sent ? rawReasonOf(trip.json, field) : undefined;
    return {
      stage: trip.stage,
      facilitator: trip.facilitator,
      network: trip.network,
      response: trip.response,
      ...(sent ? { httpStatus: trip.httpStatus } : {}),
      ...(trip.elapsedMs === undefined ? {} : { elapsedMs: trip.elapsedMs }),
      ...(raw === undefined ? {} : { rawReason: raw, reasonField: field, reasonSource: "facilitator_body" as const }),
    };
  });
}

/** verify の応答の分類（x402・SVM の verify の判定と同じ順: 200 でない → `http_error`、object でない → `not_json`、`isValid`）。 */
export function verifyResponseClassOf(status: number, json: unknown): VerifyResponseClass {
  if (status !== 200) return "http_error";
  if (!isRecord(json)) return "not_json";
  return json["isValid"] === true ? "valid" : "invalid";
}
