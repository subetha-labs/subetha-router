/**
 * 受信の adapter（x402 の kind `x402`・`circle`、SVM）の診断の hook の部品（設計 `docs/rejection-reasons-design.md` §4.2、§12.2・§12.3・§12.6・
 * §13.1・§15.1 が優先。タスク R-3）。
 *
 * - **本文は新しく読まない**（§12.2）: 使うのは `post` が既に読んで parse した JSON と HTTP の status だけ。
 * - **hook は固定の欄の写しを 1 回 push するだけ**（§13.1・§15.1）: 理由の生の値（`invalidReason`・`errorReason` の参照）を `rawReason` に置き、
 *   表の分類・hash は後回しの処理（`buildDiagRecord`）に任せる。`invalidMessage`・`errorMessage`・`error` など自由な文の欄は読まない（SR-R1）。
 * - **cid の入力は facilitator を呼ぶ前に**、要求の 1 度だけの直列化の中で写して段の scope に入れる（§12.6。2 回目の parse はしない）。throw の経路（transport の出来事）も
 *   facilitator の記録と結びつく。形が違えば入れない（欄を書かない）。
 * - sink が無い（`undefined`・`NOOP`）なら何もしない: scope を作らず、時刻も読まず、直列化も今までどおり replacer 無し（§8.2 の比較）。credential は有効でも読み直さない。
 * - `post` が throw したとき adapter は記録しない（core が `transport` の分類を残す。§4.2）。
 */
import { NOOP_DIAGNOSTICS, safeEmit, withDiagnosticScope, type DiagCapture, type DiagCidInput, type DiagnosticsSink } from "../../shared/diagnostics.js";

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

// 自前の facilitator の `diagCidInputOf`（`tools/evm-facilitator.ts`）と同じ形の検査（同じ入力なら同じ cid）。
// hot path で使うのは **長さを先に確かめた後** だけ（正規表現は高々 66 文字に対して動く。上限の無い入力には当てない）。
const DIAG_NETWORK_SHAPE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
/** network の id の長さの上限（`DIAG_NETWORK_SHAPE` の 8 + 1 + 32）。 */
const NETWORK_MAX_LENGTH = 41;

/** 長さ（O(1)）を見てから形を見る。文字列でない・長さが違えば `false`。 */
function boundedMatch(value: string | undefined, min: number, max: number, shape: RegExp): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && shape.test(value);
}

/** 直列化の中で写した値（primitive の文字列だけ。形の検査は直列化の後に O(1) で）。 */
interface CidCapture {
  network?: string;
  asset?: string;
  from?: string;
  nonce?: string;
}

/**
 * EVM の受信の要求を **1 度だけ** 直列化し、同じ走査の中で cid の入力（§5.2）を写す（診断が有効なときだけ呼ぶ。無効なら呼び出し側は
 * 今までどおり `JSON.stringify(request)` だけ）。
 *
 * - replacer は `value` をそのまま返す（bytes は replacer 無しと同じ。`toJSON` と getter の意味もそのまま: 写すのは書かれる値そのもの）。
 * - 写すのは `paymentRequirements`（Router 発行の offer から組んだ object。`holder` の同一性で見分ける）の `network`・`asset` と、
 *   `paymentPayload` の `payload` の位置の値の `authorization` の位置の値の `from`・`nonce`。自前の facilitator の `diagCidInputOf` が
 *   受け取った本文から読む位置と同じ。**2 回目の parse も credential の読み直しもしない**。
 * - 最初に写した値だけを使う（同じ object が後でもう一度走査されても上書きしない。最初の走査が `authorization` の位置のもの）。
 * - 写した後の検査は長さ（O(1)）と、長さの上限のある文字列への形の検査だけ。文字列でない・長さや形が違えば cid を作らない。
 */
export function serializeEvmInboundRequest(
  request: { readonly paymentPayload: object; readonly paymentRequirements: object },
): { readonly requestText: string; readonly cidInput: DiagCidInput | undefined } {
  const paymentPayload = request.paymentPayload;
  const requirements = request.paymentRequirements;
  const captured: CidCapture = {};
  let payloadValue: unknown;
  let authorizationValue: unknown;
  const replacer = function (this: unknown, key: string, value: unknown): unknown {
    if (this === paymentPayload && key === "payload" && payloadValue === undefined) {
      payloadValue = value;
    } else if (payloadValue !== undefined && this === payloadValue && key === "authorization" && authorizationValue === undefined) {
      authorizationValue = value;
    } else if (authorizationValue !== undefined && this === authorizationValue && typeof value === "string") {
      if (key === "from" && captured.from === undefined) captured.from = value;
      else if (key === "nonce" && captured.nonce === undefined) captured.nonce = value;
    } else if (this === requirements && typeof value === "string") {
      if (key === "network" && captured.network === undefined) captured.network = value;
      else if (key === "asset" && captured.asset === undefined) captured.asset = value;
    }
    return value;
  };
  const requestText = JSON.stringify(request, replacer);
  const { network, asset, from, nonce } = captured;
  const wellFormed =
    boundedMatch(network, 3, NETWORK_MAX_LENGTH, DIAG_NETWORK_SHAPE) &&
    boundedMatch(asset, 42, 42, ADDRESS) &&
    boundedMatch(from, 42, 42, ADDRESS) &&
    boundedMatch(nonce, 66, 66, BYTES32);
  return { requestText, cidInput: wellFormed ? { network: network!, asset: asset!, from: from!, nonce: nonce! } : undefined };
}

/**
 * 段の scope（cid の入力つき）で `fn` を動かす。無効なら `fn` をそのまま（scope を作らない）。返り値と例外はそのまま。
 */
export function withInboundDiagScope<T>(sink: DiagnosticsSink | undefined, cidInput: DiagCidInput | undefined, fn: () => Promise<T>): Promise<T> {
  if (!inboundDiagnosticsOn(sink) || cidInput === undefined) return fn();
  return withDiagnosticScope({ cidInput }, fn);
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
