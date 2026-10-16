/**
 * x402 の送信の adapter の診断の hook（設計 `docs/rejection-reasons-design.md` §4.3、§12.2・§12.3・§13.1・§15.1 が優先。タスク R-4）。
 *
 * - **push だけ**（§13.1・§15.1）: hook は手元の値（状態コード・ヘッダの文字列の参照・結果の code・経過時間・署名した authorization の 4 つの値）を
 *   固定の欄に写して `safeEmit` するだけ。decode（`PAYMENT-RESPONSE`・`PAYMENT-REQUIRED`）・理由の表・hash（`cid`）は後回しの処理でする。
 * - **本文は新しく読まない**（§12.2）: 断った応答は今どおり `discardBody`。理由はヘッダと、既に読まれた本文（静的の Base）からだけ。
 * - **記録は結果が決まった後**（§12.3）: `dest_sign` は送出の前の期限の判定と送出の後に、`dest_pay_request` と一緒に積む（署名の直後には置かない）。
 * - sink が無い（`undefined`・`NOOP`）なら時刻も読まない。結果・要求の数・順序・期限は sink の有無で変わらない（§8.2）。
 * - 例外の message・URL・ヘッダの値は記録の欄に置き場が無い（生の文字列は後回しの処理で分類してから捨てる。SR-R1）。
 */
import { performance } from "node:perf_hooks";

import { classifyTransportError, TransportError } from "../../net/guarded-fetch.js";
import type { DestinationOffer } from "../../ports/outbound.js";
import { NOOP_DIAGNOSTICS, safeEmit, type DiagCapture, type DiagCidInput, type DiagnosticsSink } from "../../shared/diagnostics.js";
import type { ReceiptForm } from "../../shared/x402-receipt.js";

/** sink が有効か（`undefined`・`NOOP` は無効）。 */
export function outboundDiagnosticsEnabled(sink: DiagnosticsSink | undefined): sink is DiagnosticsSink {
  return sink !== undefined && sink !== NOOP_DIAGNOSTICS;
}

/** 段の始まり（無効なら `undefined`。時刻を読まない）。 */
export function diagStart(sink: DiagnosticsSink | undefined): number | undefined {
  return outboundDiagnosticsEnabled(sink) ? performance.now() : undefined;
}

/** `start` からの経過（ms。無効なら `undefined`）。 */
export function diagElapsed(start: number | undefined): number | undefined {
  return start === undefined ? undefined : Math.max(0, performance.now() - start);
}

/** 送信の 1 回の診断の文脈（`paidOutcomeOf` と静的の Base が受け取る）。 */
export interface PayDiagnostics {
  readonly sink: DiagnosticsSink;
  /** 有料の要求を送る直前の時刻（`diagStart`）。 */
  readonly startedAt: number | undefined;
  /** 署名した EIP-3009 の authorization の `cid` の入力（EVM だけ。SVM は無し）。 */
  readonly cid?: DiagCidInput | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 署名した payload（`createPaymentPayload` の返り値）の `payload.authorization` の `from`・`nonce` と、承認した offer の `network`・`asset` から
 * `cid` の入力を作る（§4.3・§5.2。hash は後回しの処理で）。形が違えば `undefined`（記録に `cid` が付かないだけ）。
 */
export function evmCidInputOf(payload: unknown, approved: DestinationOffer): DiagCidInput | undefined {
  try {
    if (!isRecord(payload)) return undefined;
    const inner = payload["payload"];
    if (!isRecord(inner)) return undefined;
    const authorization = inner["authorization"];
    if (!isRecord(authorization)) return undefined;
    const from = authorization["from"];
    const nonce = authorization["nonce"];
    if (typeof from !== "string" || typeof nonce !== "string") return undefined;
    return { network: approved.network, asset: approved.asset, from, nonce };
  } catch {
    return undefined;
  }
}

const cidFieldOf = (cid: DiagCidInput | undefined): { rawCid?: DiagCidInput } => (cid === undefined ? {} : { rawCid: cid });
const elapsedFieldOf = (elapsedMs: number | undefined): { elapsedMs?: number } => (elapsedMs === undefined ? {} : { elapsedMs });

/** `dest_sign` の写し（署名して送った）。 */
function signedCaptureOf(cid: DiagCidInput | undefined): DiagCapture {
  return { stage: "dest_sign", outcome: "signed", ...cidFieldOf(cid) };
}

/** 署名の段で送らずに終えた（`not_sent` の固定の code）。結果を返す直前に積む。 */
export function recordSignNotSent(sink: DiagnosticsSink | undefined, code: string, cid?: DiagCidInput): void {
  if (!outboundDiagnosticsEnabled(sink)) return;
  safeEmit(sink, () => ({ stage: "dest_sign", outcome: "not_sent", code, ...cidFieldOf(cid) }));
}

/** 領収のヘッダの選び方（`receiptOf` と同じ: `PAYMENT-RESPONSE` が null でなければそれ、無ければ `X-PAYMENT-RESPONSE`）。 */
function receiptHeaderOf(response: Response): { readonly name: "payment-response" | "x-payment-response" | "none"; readonly value: string | null } {
  const primary = response.headers.get("PAYMENT-RESPONSE");
  if (primary !== null) return { name: "payment-response", value: primary };
  const legacy = response.headers.get("X-PAYMENT-RESPONSE");
  if (legacy !== null) return { name: "x-payment-response", value: legacy };
  return { name: "none", value: null };
}

export interface PayRequestFacts {
  readonly response: Response;
  readonly approved: DestinationOffer;
  readonly form: ReceiptForm;
  /** 判断の結果で領収が整合しなかった（`PAYMENT-REQUIRED` と本文の理由を写す）。 */
  readonly receiptNotOk: boolean;
  /** 本文の読み取りの失敗（`deliveredBodyOf`・SDK の `processResponse`）。 */
  readonly bodyReadError?: { readonly error: unknown; readonly code?: string };
  /** 既に読まれた本文（静的の Base の SDK の `processResponse`）。最上位の `error`・`errorReason`・`invalidReason` だけを見る。 */
  readonly readBody?: unknown;
}

/** 既に読まれた本文の最上位の理由の欄（最初にある 1 つ）。値は写すだけ（分類は後回し）。 */
const BODY_REASON_FIELDS = ["error", "errorReason", "invalidReason"] as const;

function bodyReasonOf(body: unknown): { reasonField: (typeof BODY_REASON_FIELDS)[number]; rawReason: unknown } | undefined {
  if (!isRecord(body)) return undefined;
  for (const field of BODY_REASON_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) return { reasonField: field, rawReason: body[field] };
  }
  return undefined;
}

/** `dest_pay_request` の写し（応答を受けた）。ヘッダは文字列の参照を写すだけ。 */
function payRequestCaptureOf(facts: PayRequestFacts, diag: PayDiagnostics): DiagCapture {
  const { response, approved, form } = facts;
  const receipt = receiptHeaderOf(response);
  const required = facts.receiptNotOk ? response.headers.get("PAYMENT-REQUIRED") : null;
  const body = facts.receiptNotOk && facts.readBody !== undefined ? bodyReasonOf(facts.readBody) : undefined;
  const bodyError = facts.bodyReadError;
  return {
    stage: "dest_pay_request",
    op: "pay",
    network: approved.network,
    httpStatus: response.status,
    receiptHeader: receipt.name,
    receiptForm: form.payerForm,
    receiptSigner: form.signerAddress,
    ...(receipt.value === null ? {} : { rawReceiptHeader: receipt.value }),
    ...(required === null ? {} : { rawPaymentRequired: required }),
    ...(body === undefined ? {} : { reasonField: body.reasonField, reasonSource: "response_body" as const, rawReason: body.rawReason }),
    ...(bodyError === undefined ? {} : { transport: classifyTransportError(bodyError.error), ...(bodyError.code === undefined ? {} : { code: bodyError.code }) }),
    ...elapsedFieldOf(diagElapsed(diag.startedAt)),
    ...cidFieldOf(diag.cid),
  };
}

/** 応答を受けた後（結果を決め終えた後）: `dest_sign`（signed）と `dest_pay_request` を積む。 */
export function recordPaid(diag: PayDiagnostics | undefined, facts: PayRequestFacts, options: { readonly signed: boolean } = { signed: true }): void {
  if (diag === undefined || !outboundDiagnosticsEnabled(diag.sink)) return;
  if (options.signed) safeEmit(diag.sink, () => signedCaptureOf(diag.cid));
  safeEmit(diag.sink, () => payRequestCaptureOf(facts, diag));
}

/** 有料の要求が headers の前に失敗した（送ったかどうか分からない）: `dest_sign`（signed）と `dest_pay_request`（`transport`・経過）。 */
export function recordPayTransportFailure(diag: PayDiagnostics | undefined, error: unknown, network: string): void {
  if (diag === undefined || !outboundDiagnosticsEnabled(diag.sink)) return;
  safeEmit(diag.sink, () => signedCaptureOf(diag.cid));
  safeEmit(diag.sink, () => ({ stage: "dest_pay_request", op: "pay", network, transport: classifyTransportError(error), ...elapsedFieldOf(diagElapsed(diag.startedAt)), ...cidFieldOf(diag.cid) }));
}

/**
 * 送金の直前の challenge の読み直しの失敗（`dest_challenge`）。`knownReason` は adapter の固定の分類（`DynamicChallengeError.reason` など）。
 * それが無く `TransportError` ならその code を `transport` に、どちらでもなければ `challenge_invalid`。message は読まない。
 */
export function recordChallengeFailure(sink: DiagnosticsSink | undefined, error: unknown, knownReason: string | undefined, startedAt: number | undefined): void {
  if (!outboundDiagnosticsEnabled(sink)) return;
  safeEmit(sink, () => ({
    stage: "dest_challenge",
    op: "pay_challenge",
    ...(knownReason !== undefined ? { code: knownReason } : error instanceof TransportError ? { transport: error.code } : { code: "challenge_invalid" }),
    ...elapsedFieldOf(diagElapsed(startedAt)),
  }));
}
