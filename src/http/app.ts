/**
 * Router 公開契約（設計 §3）。支払い SDK を知らず、core へはポート越しにのみ触る。
 * canonical は設定値から組み立て、リクエストの `Host` からは導かない。
 */

import http from "node:http";
import { once } from "node:events";

import { canonicalPathOf, resolveProfile, resolveRoute, type RouterConfig } from "../config.js";
import type { PurchaseOutcome, RouterCore } from "../core/orchestrator.js";
import { MAX_ATTEST_BODY_BYTES_OF } from "./private-limits.js";
import type { InboundOffer, PaymentCredential } from "../ports/inbound.js";
import type { DrainGate } from "../shared/drain.js";
import { authenticate, singleHeader } from "./auth.js";
import { dynamicQuoteBody, paymentRequiredBody, privateQuoteBody, projectionBody, quoteBody, routeListBody } from "./projection.js";

export interface AppOptions {
  readonly core: RouterCore;
  readonly config: RouterConfig;
  /** canonical URL の基点（設定値）。 */
  readonly canonicalBaseUrl: string;
  readonly principals: ReadonlyMap<string, string>;
  /**
   * 結果を durable 化した**後**、応答バイトを出す**前**に呼ばれる合成専用のシーム。
   * 合成構成からのみ渡され、既定では `undefined`（通常経路に分岐は残らない）。
   */
  readonly beforeDeliveredResponse?: (paymentId: string) => Promise<void>;
  /**
   * graceful drain（`src/shared/drain.ts`、タスク R-0）。渡せば要求を数え（処理の終わりと応答の close の両方で外す。相手が切っても
   * 購入・settle・宛先への支払いが続く間は数に残る）、drain の始まりの後の要求は 503 `draining` で断る（core に触れない）。
   */
  readonly drain?: DrainGate;
}

/** R2 の body 上限。これを超える要求は読み切らずに切る。 */
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response: http.ServerResponse, status: number, body: unknown, headers = {}): void {
  const text = JSON.stringify(body ?? null);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(text);
}

/**
 * `Retry-After`（秒）を付けるのは**時間で解ける 429 = `rate_limited` だけ**（動的の門の窓は 60 秒。`src/core/dynamic-gate.ts`）。
 * 予算の拒否（`per_purchase_limit`・`bucket_limit`・`bucket_not_allowed`・`purchase_count_limit`）も 429 だが 1 分では解けないので付けない（H-1、レビュー #1）。
 * quote の再試行の目安で、purchase の再試行の許可ではない。
 */
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

function sendError(
  response: http.ServerResponse,
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): void {
  sendJson(response, status, { error, ...extra }, status === 429 && error === "rate_limited" ? { "retry-after": String(RATE_LIMIT_RETRY_AFTER_SECONDS), ...headers } : headers);
}

async function readBody(request: http.IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      return undefined;
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `X-Payment` は base64 の JSON（`{x402Version, accepted, payload:{challengeNonce}}`）。
 * 形が満たせないものは復号結果を外に出さずに拒否する。
 */
function decodeCredential(raw: string): PaymentCredential | undefined {
  let parsed: unknown;
  try {
    const text = Buffer.from(raw, "base64").toString("utf8");
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  const accepted = candidate["accepted"];
  const payload = candidate["payload"];
  if (typeof candidate["x402Version"] !== "number") {
    return undefined;
  }
  if (typeof accepted !== "object" || accepted === null || Array.isArray(accepted)) {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const nonce = (payload as Record<string, unknown>)["challengeNonce"];
  if (typeof nonce !== "string" || nonce === "") {
    return undefined;
  }
  return parsed as PaymentCredential;
}

/** core の理由コードから HTTP ステータスへの固定の写像（例外文字列は載せない）。 */
const REJECTED_STATUS: Readonly<Record<string, number>> = {
  unknown_quote: 404,
  not_owner: 404,
  route_mismatch: 409,
  request_id_conflict: 409,
  approval_required: 400,
  approval_expired: 409,
  preflight_unavailable: 503,
  payment_id_collision: 409,
  quote_unreadable: 409,
  dynamic_unavailable: 503,
  private_disabled: 404,
};

/** 受信 settle 前に終わった失敗（課金は起きていない）。 */
const AWAITING_STATUS: Readonly<Record<string, number>> = {
  offer_changed: 409,
  offer_unavailable: 503,
  approval_expired: 409,
  purchase_count_limit: 429,
  per_purchase_limit: 429,
  bucket_limit: 429,
  bucket_not_allowed: 429,
  invalid_amount: 400,
  invalid_budget_limit: 503,
  // 動的（設計 §2・§6）。
  rate_limited: 429,
  operator_funds_unavailable: 503,
  source_verify_unavailable: 503,
  // 秘匿（`docs/zktls-router-design.md` §3.7）。
  private_capacity: 429,
};

/** 秘匿 quote の失敗コード → HTTP（動的の表に足す。設計 §8.1）。 */
const PRIVATE_QUOTE_STATUS: Readonly<Record<string, number>> = {
  private_disabled: 404,
  private_unavailable: 503,
  unknown_route: 404,
  invalid_intent: 400,
  intent_too_large: 413,
  intent_mismatch: 409,
  invalid_upstream_url: 400,
  request_id_conflict: 409,
  rate_limited: 429,
  dynamic_capacity: 429,
  dynamic_unavailable: 503,
  source_terms_mismatch: 502,
  quote_failed: 502,
};

/** attest・record の固定コード → HTTP。 */
const PRIVATE_ATTEST_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  invalid_bundle: 400,
  bundle_too_large: 413,
  attest_closed: 409,
  attest_not_ready: 409,
  attest_in_progress: 409,
  attest_expired: 409,
  attest_foreign: 409,
  private_capacity: 429,
  private_unavailable: 503,
};
const PRIVATE_RECORD_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  record_not_available: 409,
  record_expired: 410,
  record_corrupt: 500,
};

/** 動的 quote の失敗コード → HTTP。 */
const DYNAMIC_QUOTE_STATUS: Readonly<Record<string, number>> = {
  dynamic_disabled: 404,
  unknown_route: 404,
  private_only_profile: 404,
  invalid_upstream_url: 400,
  invalid_upstream_body: 400,
  request_id_conflict: 409,
  rate_limited: 429,
  dynamic_capacity: 429,
  dynamic_unavailable: 503,
  source_terms_mismatch: 502,
  quote_failed: 502,
};

/** preflight 由来は「支払いをやり直せる」意味の 402 にまとめる。 */
const PREFLIGHT_CODES: ReadonlySet<string> = new Set([
  "preflight_failed",
  "nonce_mismatch",
  "offer_expired",
  "offer_mismatch",
  "route_binding_mismatch",
  "credential_mismatch",
]);

function statusForOutcome(outcome: PurchaseOutcome): number {
  switch (outcome.status) {
    case "delivered":
      return 200;
    case "paid_data_unavailable":
      return 502;
    case "unknown":
      return 500;
    case "paid":
      return 409;
    // 秘匿購入: 引き渡しの応答は 200（`handover` 付き）、進行中の再提出は 409。
    case "awaiting_session":
      return outcome.handover === undefined ? 409 : 200;
    case "attesting":
      return 409;
    case "delivered_private":
      return 200;
    case "awaiting_payment":
      return AWAITING_STATUS[outcome.code ?? ""] ?? 402;
    case "rejected":
      return (
        REJECTED_STATUS[outcome.code ?? ""] ??
        (PREFLIGHT_CODES.has(outcome.code ?? "") ? 402 : 400)
      );
    default:
      return 500;
  }
}

export function createRequestListener(options: AppOptions): http.RequestListener {
  const quoteUrl = `${options.canonicalBaseUrl}/v1/quotes`;

  const respondPaymentRequired = (
    response: http.ServerResponse,
    routeId: string,
    offer: InboundOffer | undefined,
    error: string,
    status = 402,
  ): void => {
    sendJson(response, status, paymentRequiredBody(routeId, quoteUrl, offer, error));
  };

  return (request, response) => {
    const drain = options.drain;
    if (drain !== undefined && !drain.admit()) {
      // drain の後の要求: 固定の拒否。本文は読まず、接続を閉じる。
      sendError(response, 503, "draining", {}, { connection: "close" });
      return;
    }
    // drain の数: 処理の終わりと応答の close の両方が来たら 1 回だけ外す。
    let open = 2;
    const release = (): void => {
      open -= 1;
      if (open === 0) drain?.finished();
    };
    response.once("close", release);
    void handle(request, response).catch(() => {
      // 例外の文字列は外に出さない（上流 URL・トークンが混ざり得る）。
      if (!response.headersSent) {
        sendError(response, 500, "internal_error");
      } else {
        response.destroy();
      }
    }).finally(release);
  };

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    // canonical は設定値。`Host` ヘッダからは導かないのでダミーの基点で解析する。
    const url = new URL(request.url ?? "/", "http://router.invalid");
    const segments = url.pathname.split("/").filter((segment) => segment !== "");

    // クエリ付きは受け付けない（canonical はクエリ不可）。
    if (url.search !== "") {
      sendError(response, 400, "query_not_allowed");
      return;
    }

    const auth = authenticate(request.headers, options.principals);
    if (!auth.ok) {
      sendError(response, 401, "unauthenticated", {}, { "www-authenticate": "Bearer" });
      return;
    }
    const principalId = auth.principalId;

    // R1: GET /v1/routes
    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "routes") {
      if (request.method !== "GET") {
        sendError(response, 405, "method_not_allowed", {}, { allow: "GET" });
        return;
      }
      sendJson(response, 200, routeListBody(options.config, options.canonicalBaseUrl));
      return;
    }

    // R2: POST /v1/quotes
    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "quotes") {
      if (request.method !== "POST") {
        sendError(response, 405, "method_not_allowed", {}, { allow: "POST" });
        return;
      }
      await handleQuote(request, response, principalId);
      return;
    }

    // R3: GET /v1/routes/{routeId}/resource
    if (
      segments.length === 4 &&
      segments[0] === "v1" &&
      segments[1] === "routes" &&
      segments[3] === "resource"
    ) {
      // 正規化後ではなく**生のリクエストパス**で判定する。dot segment や重複スラッシュの
      // 別名から購入口を選べてしまうと、承認したパスと実際に走るパスがずれる。
      const rawPath = (request.url ?? "").split("?")[0] ?? "";
      await handleResource(request, response, principalId, segments[2] ?? "", rawPath);
      return;
    }

    // 秘匿購入（`docs/zktls-router-design.md` §2）: POST /v1/private/quotes, POST /v1/private/purchases, POST /v1/private/purchases/{id}/attest, GET /v1/private/purchases/{id}/record
    if (segments.length >= 2 && segments[0] === "v1" && segments[1] === "private") {
      await handlePrivate(request, response, principalId, segments.slice(2));
      return;
    }

    // R4: GET /v1/purchases/{paymentId}
    if (segments.length === 3 && segments[0] === "v1" && segments[1] === "purchases") {
      if (request.method !== "GET") {
        sendError(response, 405, "method_not_allowed", {}, { allow: "GET" });
        return;
      }
      const projection = options.core.status(segments[2] ?? "", principalId, singleHeader(request.headers, "x-router-owner-key"));
      // 所有 principal 以外には存在も明かさない。全件ダンプの口は無い。
      if (projection === undefined) {
        sendError(response, 404, "not_found");
        return;
      }
      sendJson(response, 200, projectionBody(projection));
      return;
    }

    sendError(response, 404, "not_found");
  }

  async function handleQuote(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    principalId: string,
  ): Promise<void> {
    const raw = await readBody(request);
    if (raw === undefined) {
      sendError(response, 413, "body_too_large");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw === "" ? "null" : raw);
    } catch {
      sendError(response, 400, "invalid_json");
      return;
    }
    if (typeof parsed !== "object" || parsed === null) {
      sendError(response, 400, "invalid_request");
      return;
    }
    const body = parsed as Record<string, unknown>;
    const routeId = body["routeId"];
    const requestId = body["requestId"];
    if (typeof routeId !== "string" || routeId === "") {
      sendError(response, 400, "route_id_required");
      return;
    }
    if (typeof requestId !== "string" || requestId === "") {
      sendError(response, 400, "request_id_required");
      return;
    }
    const upstream = body["upstream"];
    if (upstream !== undefined) {
      await handleDynamicQuote(request, response, principalId, routeId, requestId, upstream);
      return;
    }
    const route = resolveRoute(options.config, routeId);
    if (route === undefined) {
      sendError(response, 404, "unknown_route");
      return;
    }

    const outcome = await options.core.quote({ principalId, requestId, routeId });
    if (!outcome.ok) {
      const status = outcome.code === "request_id_conflict" ? 409 : 502;
      sendError(response, status, outcome.code);
      return;
    }
    sendJson(response, 200, quoteBody(outcome, route, options.canonicalBaseUrl));
  }

  /** 秘匿購入の 4 経路。既存の経路の挙動は変えない。 */
  async function handlePrivate(request: http.IncomingMessage, response: http.ServerResponse, principalId: string, rest: readonly string[]): Promise<void> {
    const maxBundle = MAX_ATTEST_BODY_BYTES_OF(options.config.private?.maxBundleBytes ?? 262_144);
    // POST /v1/private/quotes
    if (rest.length === 1 && rest[0] === "quotes") {
      if (request.method !== "POST") {
        sendError(response, 405, "method_not_allowed", {}, { allow: "POST" });
        return;
      }
      const body = await readJsonObject(request, response, MAX_BODY_BYTES);
      if (body === undefined) return;
      const profileId = body["profileId"];
      const requestId = body["requestId"];
      const intentB64 = body["intentB64"];
      if (typeof profileId !== "string" || profileId === "") {
        sendError(response, 400, "profile_id_required");
        return;
      }
      if (typeof requestId !== "string" || requestId === "") {
        sendError(response, 400, "request_id_required");
        return;
      }
      if (typeof intentB64 !== "string" || intentB64 === "") {
        sendError(response, 400, "intent_required");
        return;
      }
      const profile = options.config.private !== undefined && options.config.dynamic?.enabled === true && options.config.private.profiles.includes(profileId) ? resolveProfile(options.config, profileId) : undefined;
      if (profile === undefined) {
        sendError(response, 404, options.config.private === undefined ? "private_disabled" : "unknown_route");
        return;
      }
      const outcome = await options.core.privateQuote({ principalId, requestId, profileId, intentB64, source: sourceOf(request, principalId) });
      if (!outcome.ok) {
        sendError(response, PRIVATE_QUOTE_STATUS[outcome.code] ?? 502, outcome.code, outcome.reason === undefined ? {} : { reason: outcome.reason });
        return;
      }
      sendJson(response, 200, privateQuoteBody(outcome, profile, options.canonicalBaseUrl));
      return;
    }
    // POST /v1/private/purchases
    if (rest.length === 1 && rest[0] === "purchases") {
      if (request.method !== "POST") {
        sendError(response, 405, "method_not_allowed", {}, { allow: "POST" });
        return;
      }
      if (options.config.private === undefined) {
        sendError(response, 404, "private_disabled");
        return;
      }
      const body = await readJsonObject(request, response, MAX_BODY_BYTES);
      if (body === undefined) return;
      const quoteId = body["quoteId"];
      const requestId = body["requestId"];
      const approval = body["approval"];
      const rawCredential = body["credential"];
      const ownerKey = body["ownerKey"];
      if (typeof quoteId !== "string" || quoteId === "") {
        sendError(response, 400, "quote_id_required");
        return;
      }
      if (typeof requestId !== "string" || requestId === "") {
        sendError(response, 400, "request_id_required");
        return;
      }
      if (typeof rawCredential !== "string" || rawCredential === "") {
        sendError(response, 400, "credential_required");
        return;
      }
      const credential = decodeCredential(rawCredential);
      if (credential === undefined) {
        sendError(response, 400, "invalid_payment_header");
        return;
      }
      const outcome = await options.core.purchase({
        principalId,
        requestId,
        quoteId,
        ...(typeof approval === "string" ? { approval } : {}),
        credential,
        ...(typeof ownerKey === "string" ? { ownerKey } : {}),
        source: sourceOf(request, principalId),
      });
      if (outcome.status === "awaiting_session" && outcome.handover !== undefined) {
        // 引き渡し（credential の値を含む。認証済みの応答にだけ載せる）。
        sendJson(response, 200, { paymentId: outcome.paymentId, status: "awaiting_session", ...outcome.handover });
        return;
      }
      const status = statusForOutcome(outcome);
      sendError(response, status, outcome.code ?? outcome.terminalReason ?? outcome.status, {
        status: outcome.status,
        ...(outcome.paymentId === undefined ? {} : { paymentId: outcome.paymentId }),
        ...(outcome.terminalReason === undefined ? {} : { terminalReason: outcome.terminalReason }),
      });
      return;
    }
    // POST /v1/private/purchases/{id}/attest
    if (rest.length === 3 && rest[0] === "purchases" && rest[2] === "attest") {
      if (request.method !== "POST") {
        sendError(response, 405, "method_not_allowed", {}, { allow: "POST" });
        return;
      }
      if (options.config.private === undefined) {
        sendError(response, 404, "private_disabled");
        return;
      }
      const body = await readJsonObject(request, response, maxBundle);
      if (body === undefined) return;
      const bundleB64 = body["bundleB64"];
      const ownerKey = body["ownerKey"];
      if (typeof bundleB64 !== "string" || bundleB64 === "") {
        sendError(response, 400, "bundle_required");
        return;
      }
      const outcome = await options.core.privateAttest(rest[1] ?? "", principalId, typeof ownerKey === "string" ? ownerKey : undefined, bundleB64);
      if (!outcome.ok) {
        sendError(response, PRIVATE_ATTEST_STATUS[outcome.code] ?? 500, outcome.code);
        return;
      }
      const projection = options.core.status(rest[1] ?? "", principalId, typeof ownerKey === "string" ? ownerKey : undefined);
      sendJson(response, 200, { paymentId: rest[1], status: outcome.status, ...(outcome.terminalReason === undefined ? {} : { terminalReason: outcome.terminalReason }), ...(projection?.private === undefined ? {} : { private: projection.private }) });
      return;
    }
    // GET /v1/private/purchases/{id}/record
    if (rest.length === 3 && rest[0] === "purchases" && rest[2] === "record") {
      if (request.method !== "GET") {
        sendError(response, 405, "method_not_allowed", {}, { allow: "GET" });
        return;
      }
      if (options.config.private === undefined) {
        sendError(response, 404, "private_disabled");
        return;
      }
      const outcome = options.core.privateRecord(rest[1] ?? "", principalId, singleHeader(request.headers, "x-router-owner-key"));
      if (!outcome.ok) {
        sendError(response, PRIVATE_RECORD_STATUS[outcome.code] ?? 500, outcome.code);
        return;
      }
      sendJson(response, 200, { paymentId: rest[1], recordB64: outcome.recordB64, releaseB64: outcome.releaseB64, recordAvailableUntil: outcome.recordAvailableUntil });
      return;
    }
    sendError(response, 404, "not_found");
  }

  /** JSON object の本文を読む（上限つき）。失敗は応答を書いて `undefined`。 */
  async function readJsonObject(request: http.IncomingMessage, response: http.ServerResponse, maxBytes: number): Promise<Record<string, unknown> | undefined> {
    const raw = await readBody(request, maxBytes);
    if (raw === undefined) {
      sendError(response, 413, "body_too_large");
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw === "" ? "null" : raw);
    } catch {
      sendError(response, 400, "invalid_json");
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sendError(response, 400, "invalid_request");
      return undefined;
    }
    return parsed as Record<string, unknown>;
  }

  /** 送信元の識別（門の鍵）。MCP 層が必ず上書きするヘッダ。無ければ principal。 */
  function sourceOf(request: http.IncomingMessage, principalId: string): string {
    const source = singleHeader(request.headers, "x-router-source");
    return source === undefined || source === "" || source.length > 128 ? principalId : source;
  }

  /** R2（動的）: `upstream.url` を持つ quote。`routeId` はプロファイル ID。 */
  async function handleDynamicQuote(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    principalId: string,
    profileId: string,
    requestId: string,
    upstream: unknown,
  ): Promise<void> {
    const url = typeof upstream === "object" && upstream !== null && !Array.isArray(upstream) ? (upstream as Record<string, unknown>)["url"] : undefined;
    if (typeof url !== "string" || url === "") {
      sendError(response, 400, "upstream_url_required");
      return;
    }
    const profile = options.config.dynamic?.enabled === true ? resolveProfile(options.config, profileId) : undefined;
    if (profile === undefined) {
      // 機能が無い・無効・無いプロファイルは、どれも「無い」と答える（接続 0）。
      sendError(response, 404, options.config.dynamic === undefined || !options.config.dynamic.enabled ? "dynamic_disabled" : "unknown_route");
      return;
    }
    const rawMethod = (upstream as Record<string, unknown>)["method"];
    const rawBody = (upstream as Record<string, unknown>)["body"];
    if (rawMethod !== undefined && rawMethod !== "GET" && rawMethod !== "POST") {
      sendError(response, 400, "invalid_upstream_body", { reason: "method_not_allowed" });
      return;
    }
    const outcome = await options.core.quote({
      principalId, requestId, routeId: profileId,
      upstream: { url, ...(rawMethod === undefined ? {} : { method: rawMethod }), ...(rawBody === undefined ? {} : { body: rawBody }) },
      source: sourceOf(request, principalId),
    });
    if (!outcome.ok) {
      sendError(response, DYNAMIC_QUOTE_STATUS[outcome.code] ?? 502, outcome.code, outcome.reason === undefined ? {} : { reason: outcome.reason });
      return;
    }
    sendJson(response, 200, dynamicQuoteBody(outcome, profile, options.canonicalBaseUrl));
  }

  async function handleResource(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    principalId: string,
    routeId: string,
    rawPath: string,
  ): Promise<void> {
    if (request.method !== "GET") {
      sendError(response, 405, "method_not_allowed", {}, { allow: "GET" });
      return;
    }
    // allowlist 外の routeId は存在しない（動的プロファイルの ID は、機能が有効なときだけ）。
    const route = resolveRoute(options.config, routeId);
    const profile = route === undefined && options.config.dynamic?.enabled === true ? resolveProfile(options.config, routeId) : undefined;
    if (route === undefined && profile === undefined) {
      sendError(response, 404, "unknown_route");
      return;
    }
    // R2 が提示した canonical path そのものでなければ購入口として扱わない。
    if (rawPath !== (route?.canonicalPath ?? canonicalPathOf(routeId))) {
      sendError(response, 404, "not_found");
      return;
    }

    const quoteId = singleHeader(request.headers, "x-router-quote-id");
    const rawCredential = singleHeader(request.headers, "x-payment");
    // 動的 quote の持ち主の証明。静的 route では見ない。ログ・エラー本文には出さない。
    const ownerKey = singleHeader(request.headers, "x-router-owner-key");

    // 資格情報なしは「既存 offer の再提示」か「R2 で quote を取れ」の指示だけ。
    // ここでは core の購入経路に入らないので、journal には 1 行も書かない。
    if (rawCredential === undefined) {
      const offer =
        quoteId === undefined ? undefined : options.core.offerFor(quoteId, principalId, routeId, ownerKey);
      respondPaymentRequired(
        response,
        routeId,
        offer,
        offer === undefined ? "quote_required" : "payment_required",
      );
      return;
    }

    const credential = decodeCredential(rawCredential);
    if (credential === undefined) {
      sendError(response, 400, "invalid_payment_header");
      return;
    }
    if (quoteId === undefined || quoteId === "") {
      sendError(response, 400, "quote_id_required");
      return;
    }
    const requestId = singleHeader(request.headers, "x-router-request-id");
    if (requestId === undefined || requestId === "") {
      sendError(response, 400, "request_id_required");
      return;
    }
    const approval = singleHeader(request.headers, "x-router-approval");

    const outcome = await options.core.purchase({
      principalId,
      requestId,
      quoteId,
      routeId,
      ...(approval === undefined ? {} : { approval }),
      credential,
      ...(ownerKey === undefined ? {} : { ownerKey }),
      source: sourceOf(request, principalId),
    });

    if (outcome.status === "delivered") {
      // 上流 JSON をそのまま body にする（支払いメタは R4 側）。durable 化は core 側で済んでいる。
      const text = JSON.stringify(outcome.body ?? null);
      // 合成構成でのみ渡されるシーム。ここを通る時点で結果は fsync 済み・応答は未送出。
      if (options.beforeDeliveredResponse !== undefined) {
        await options.beforeDeliveredResponse(outcome.paymentId ?? "");
      }
      response.writeHead(200, {
        "content-type": outcome.contentType ?? "application/json",
        "content-length": Buffer.byteLength(text),
        "cache-control": "no-store",
        ...(outcome.paymentId === undefined ? {} : { "x-router-payment-id": outcome.paymentId }),
      });
      response.end(text);
      return;
    }

    const status = statusForOutcome(outcome);
    const code = outcome.code ?? outcome.terminalReason ?? outcome.status;
    const extra = {
      status: outcome.status,
      ...(outcome.paymentId === undefined ? {} : { paymentId: outcome.paymentId }),
      ...(outcome.terminalReason === undefined ? {} : { terminalReason: outcome.terminalReason }),
    };
    // 402 は支払いのやり直しに必要な offer を添える（新しい quote は作らない）。
    if (status === 402) {
      const offer = options.core.offerFor(quoteId, principalId, routeId, ownerKey);
      sendJson(response, 402, {
        ...(paymentRequiredBody(routeId, quoteUrl, offer, code) as Record<string, unknown>),
        ...extra,
      });
      return;
    }
    sendError(response, status, code, extra);
  }
}

/** 入口の受信期限（設計 §7.1）。ヘッダと本文の受信に明示する。 */
export const HTTP_INGRESS_TIMEOUT_MS = 10_000;

export interface RunningServer {
  readonly port: number;
  /** 実際に適用された受信期限（試験で確かめる）。 */
  readonly timeouts: { readonly headersTimeoutMs: number; readonly requestTimeoutMs: number };
  /** listener を閉じる（新しい接続を受けない）。既存の接続の終わりは待たない（drain が数で待つ）。 */
  stopListening(): void;
  close(): Promise<void>;
}

export async function startHttpServer(
  options: AppOptions & { readonly host: string; readonly port: number },
): Promise<RunningServer> {
  const server = http.createServer(createRequestListener(options));
  // 入口の資源上限（設計 §7.1）: ヘッダと本文の受信に期限を明示する。
  server.headersTimeout = HTTP_INGRESS_TIMEOUT_MS;
  server.requestTimeout = HTTP_INGRESS_TIMEOUT_MS;
  server.listen(options.port, options.host);
  await once(server, "listening");
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : options.port,
    timeouts: { headersTimeoutMs: server.headersTimeout, requestTimeoutMs: server.requestTimeout },
    stopListening(): void {
      server.close();
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
