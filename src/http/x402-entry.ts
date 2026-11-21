/**
 * 標準の x402 v2 クライアント用の入口（`docs/x402-standard-entry-design.md`）。
 *
 * `GET /x402/v1/routes/{routeId}/resource`。credential の無い要求には新しい注文の offer を 402（`PAYMENT-REQUIRED`）で返し、`PAYMENT-SIGNATURE` 付きの要求を購入として扱う。
 * **`PAYMENT-SIGNATURE`／`X-PAYMENT` を持つ要求への応答は、どの場合も 402 にせず、`PAYMENT-REQUIRED` も署名できる offer も付けない**（同じ注文に 2 つ目の署名を誘わない）。
 * 対象は `sourceRail: "subetha-exact"` の静的 route だけ。認証（Bearer の principal）は呼び出し側（`app.ts`）が済ませている。
 */
import type http from "node:http";

import { resolveRoute, type RouterConfig } from "../config.js";
import type { PurchaseOutcome, RouterCore, StandardPresented } from "../core/orchestrator.js";
import type { InboundOffer } from "../ports/inbound.js";
import { projectionBody } from "./projection.js";

/** 標準入口のパスの接頭辞と形。 */
export const X402_ENTRY_PREFIX = "x402";
export function x402EntryPathOf(routeId: string): string {
  return `/${X402_ENTRY_PREFIX}/v1/routes/${encodeURIComponent(routeId)}/resource`;
}
/** 標準入口を持つ route か（一覧と入口で同じ判定）。 */
export function hasX402Entry(route: { readonly sourceRail?: string } | undefined): boolean {
  return route !== undefined && route.sourceRail === "subetha-exact";
}

/** `PAYMENT-SIGNATURE` の値の上限（標準の `exact` の payload は 1 KiB 前後）。 */
const MAX_PAYMENT_HEADER_BYTES = 8 * 1024;
/** offer の発行が一時的に断られ、目安が無いときの `Retry-After`。 */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

const NOTE_NOT_FORWARDED = "This request did not forward this credential and did not start settlement. This is not a statement that nothing was paid.";
const NOTE_NOT_PROOF = "A refused, failed or unanswered verification or settlement is not proof that nothing was paid. The signed authorization can be used on chain until mayStillSettleUntil.";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[0-9]{1,78}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2}){1,2048}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface X402EntryContext {
  readonly core: RouterCore;
  readonly config: RouterConfig;
  readonly canonicalBaseUrl: string;
  readonly principalId: string;
  /** 送信元の識別（`x-router-source`。無ければ principal）。`subetha-exact` の送信元ごとの上限に使う。 */
  readonly source?: string;
  readonly segments: readonly string[];
  readonly beforeDeliveredResponse?: (paymentId: string) => Promise<void>;
}

function send(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body ?? null);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store", ...headers });
  response.end(text);
}

const encodeHeader = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

/** 生のヘッダーから名前（大小無視）の値を全て取る（重複を数えるため。Node は一部のヘッダーを黙って結合・破棄する）。 */
function rawValuesOf(request: http.IncomingMessage, name: string): string[] {
  const out: string[] = [];
  const raw = request.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (raw[index]!.toLowerCase() === name) out.push(raw[index + 1]!);
  }
  return out;
}

/** `PAYMENT-SIGNATURE` の値を読む。形が満たせないものは `undefined`（復号結果を外に出さない）。 */
export function decodePaymentSignature(raw: string): StandardPresented | undefined {
  if (raw === "" || raw.length > MAX_PAYMENT_HEADER_BYTES || !BASE64.test(raw)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(parsed) || parsed["x402Version"] !== 2) return undefined;
  const accepted = parsed["accepted"];
  const payload = parsed["payload"];
  if (!isRecord(accepted) || !isRecord(payload)) return undefined;
  const authorization = payload["authorization"];
  const signature = payload["signature"];
  if (!isRecord(authorization) || typeof signature !== "string" || !SIGNATURE.test(signature)) return undefined;
  const text = (key: string, shape: RegExp): string | undefined => {
    const value = authorization[key];
    return typeof value === "string" && shape.test(value) ? value : undefined;
  };
  const from = text("from", ADDRESS);
  const to = text("to", ADDRESS);
  const value = text("value", DECIMAL);
  const validAfter = text("validAfter", DECIMAL);
  const validBefore = text("validBefore", DECIMAL);
  const nonce = text("nonce", HEX32);
  if (from === undefined || to === undefined || value === undefined || validAfter === undefined || validBefore === undefined || nonce === undefined) return undefined;
  return { accepted, authorization: { from, to, value, validAfter, validBefore, nonce }, signature };
}

/** 402 に載せる requirements: facilitator の注文の 8 項目だけ（Router の `extra` の項目は出さない）。 */
export function standardRequirementsOf(offer: InboundOffer): Record<string, unknown> {
  return {
    scheme: offer.scheme,
    network: offer.network,
    asset: offer.asset,
    amount: offer.amount,
    payTo: offer.payTo,
    maxTimeoutSeconds: offer.maxTimeoutSeconds,
    extra: { name: offer.extra["name"], version: offer.extra["version"] },
  };
}

export async function handleX402Entry(request: http.IncomingMessage, response: http.ServerResponse, context: X402EntryContext): Promise<void> {
  const { segments } = context;
  // 形の違うパス・対象外の route は、どれも同じ固定の 404（存在を明かさない）。
  const notFound = (): void => send(response, 404, { error: "not_found" });
  if (segments.length !== 5 || segments[0] !== X402_ENTRY_PREFIX || segments[1] !== "v1" || segments[2] !== "routes" || segments[4] !== "resource") return notFound();
  const routeId = segments[3] ?? "";
  const route = resolveRoute(context.config, routeId);
  if (!hasX402Entry(route) || route === undefined) return notFound();
  if (request.method !== "GET") return send(response, 405, { error: "method_not_allowed" }, { allow: "GET" });

  const signatures = rawValuesOf(request, "payment-signature");
  const legacy = rawValuesOf(request, "x-payment");
  // v1 のヘッダー・重複・空は、何も作らずに拒む（402 にしない）。
  if (legacy.length > 0 || signatures.length > 1) return send(response, 400, { error: "invalid_payment" });

  if (signatures.length === 0) {
    const outcome = await context.core.quoteStandard({ principalId: context.principalId, routeId, ...(context.source === undefined ? {} : { source: context.source }) });
    if (!outcome.ok) {
      if (outcome.code === "unknown_route") return notFound();
      // 送信元ごとの上限（`docs/hosted-exact-enable-design.md` §3）: 429。注文は作られていない。
      if (outcome.code === "source_offer_unavailable" && typeof outcome.reason === "string" && outcome.reason.startsWith("limit_source_")) {
        const seconds = Math.max(1, Math.ceil((outcome.retryAfterMs ?? 60_000) / 1000));
        return send(response, 429, { error: "rate_limited", reason: outcome.reason }, { "retry-after": String(seconds) });
      }
      const body = { error: outcome.code, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) };
      // 枠・facilitator の一時的な不通・内部の requestId の衝突は 503。`Retry-After` は目安で、総数の枠が戻ることは約束しない。
      if (outcome.code === "source_offer_unavailable" || outcome.code === "request_id_conflict") {
        const seconds = outcome.retryAfterMs === undefined ? DEFAULT_RETRY_AFTER_SECONDS : Math.max(1, Math.ceil(outcome.retryAfterMs / 1000));
        return send(response, 503, body, { "retry-after": String(seconds) });
      }
      return send(response, 502, body);
    }
    const required = {
      x402Version: 2,
      error: "payment_required",
      resource: { url: `${context.canonicalBaseUrl}${x402EntryPathOf(routeId)}`, description: routeId, mimeType: "application/json" },
      accepts: [standardRequirementsOf(outcome.offer)],
    };
    return send(response, 402, required, { "payment-required": encodeHeader(required) });
  }

  const presented = decodePaymentSignature(signatures[0] ?? "");
  if (presented === undefined) return send(response, 400, { error: "invalid_payment" });

  const result = await context.core.purchaseStandard({ principalId: context.principalId, routeId, presented });
  if (result.kind === "not_found") return notFound();

  /** 持ち主が確かめられた注文の、今の公開の射影（R4 と同じ形。開示を含む）。 */
  const projectionOf = (paymentId: string): Record<string, unknown> => {
    const projection = context.core.status(paymentId, context.principalId);
    return projection === undefined ? { paymentId } : (projectionBody(projection) as Record<string, unknown>);
  };
  if (result.kind === "conflict") {
    return send(response, 409, { error: "credential_conflict", note: NOTE_NOT_FORWARDED, ...projectionOf(result.paymentId) }, { "x-router-payment-id": result.paymentId });
  }
  if (result.kind === "not_accepted") {
    return send(
      response,
      409,
      { error: "payment_not_accepted", note: NOTE_NOT_FORWARDED, ...(result.presentedValidBefore === undefined ? {} : { presentedValidBefore: result.presentedValidBefore }), ...projectionOf(result.paymentId) },
      { "x-router-payment-id": result.paymentId },
    );
  }

  const outcome: PurchaseOutcome = result.outcome;
  const paymentId = outcome.paymentId;
  if (paymentId === undefined) return notFound();
  const projection = context.core.status(paymentId, context.principalId);
  const txRef = projection?.source.txRef;
  const settled = typeof txRef === "string" && txRef !== "";
  const paymentResponse: Record<string, string> = settled
    ? { "payment-response": encodeHeader({ success: true, transaction: txRef, network: route.source.network, ...(result.payer === undefined ? {} : { payer: result.payer }) }) }
    : {};
  const base = { "x-router-payment-id": paymentId, ...paymentResponse };

  if (outcome.status === "delivered") {
    const text = JSON.stringify(outcome.body ?? null);
    if (context.beforeDeliveredResponse !== undefined) await context.beforeDeliveredResponse(paymentId);
    response.writeHead(200, { "content-type": outcome.contentType ?? "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store", ...base });
    response.end(text);
    return;
  }
  const body = projectionOf(paymentId);
  // settle が確定していれば、状態が unknown でも「支払いは成立、配達は未完」を先に言う。
  if (settled) return send(response, 409, { error: "paid_no_data", ...body }, base);
  const code = outcome.code ?? outcome.terminalReason;
  if (outcome.status === "unknown" || outcome.code === "in_progress") {
    return send(response, 409, { error: "payment_unresolved", note: NOTE_NOT_PROOF, ...(code === undefined ? {} : { code }), ...body }, base);
  }
  return send(response, 409, { error: "payment_not_completed", note: NOTE_NOT_PROOF, ...(code === undefined ? {} : { code }), ...body }, base);
}
