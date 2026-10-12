/**
 * Router 公開契約（R1–R4）の**型付き薄いクライアント**（T4）。
 *
 * 方針:
 * - 要求は**設定した `baseUrl` の origin にだけ**出す。quote が返す canonical URL の origin が
 *   違っても、principal トークンや支払い資格情報をそこへは送らない（誘導先漏れを作らない）。
 * - 承認は `quoteId` に束縛された明示的な値のみ。未承認・拒否・対象違いでは**要求を出さない**。
 * - credential は呼び出し側が渡す既存値だけを使い、生成も署名もしない。
 * - 自動再試行・自動再 quote・`requestId` の作り直しをしない。`unknown` は `unknown` のまま返し、
 *   `paid_data_unavailable` と混ぜない。送信の成否が不明でも `paymentId` を残す。
 * - トークン・例外文字列・上流 URL を結果に載せない。
 */

import type {
  ApprovalDecision,
  ExecuteInput,
  ExecutionResult,
  ProjectionView,
  QuoteResult,
  QuoteView,
  RouteListing,
  RouterClient,
  RouterClientOptions,
} from "./types.js";

export type {
  ApprovalDecision,
  ExecuteInput,
  ExecutionResult,
  ProjectionView,
  QuoteResult,
  QuoteView,
  RouteListing,
  RouterClient,
  RouterClientOptions,
  StatusResult,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 呼び出し側・callback からの実行時の書き換えを防ぐため、複製してから凍結する
 * （`readonly` は型だけの保護で、実行時には効かない）。
 */
function frozenClone<T>(value: T): T {
  const copy = structuredClone(value) as unknown;
  const freeze = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Object.isFrozen(node)) {
      return;
    }
    Object.freeze(node);
    for (const child of Object.values(node as Record<string, unknown>)) {
      freeze(child);
    }
  };
  freeze(copy);
  return copy as T;
}

/** 束縛として比較する固定フィールド（発行時の値と 1 文字でも違えば実行しない）。 */
function bindingOf(quote: QuoteView): string {
  return JSON.stringify({
    quoteId: quote.quoteId,
    paymentId: quote.paymentId,
    routeId: quote.routeId,
    resource: { url: quote.resource.url, method: quote.resource.method },
    source: quote.source,
    destination: quote.destination,
    approval: quote.approval,
    ...(quote.upstream === undefined ? {} : { upstream: quote.upstream, pricing: quote.pricing, ownerKey: quote.ownerKey }),
  });
}

function requireString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `quoteId` を含む固定フィールドが揃っていない応答は quote として扱わない。 */
function quoteViewOf(body: unknown): QuoteView | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const quoteId = requireString(body, "quoteId");
  const paymentId = requireString(body, "paymentId");
  const routeId = requireString(body, "routeId");
  const resource = body["resource"];
  const source = body["source"];
  const destination = body["destination"];
  const approval = body["approval"];
  if (
    quoteId === undefined ||
    paymentId === undefined ||
    routeId === undefined ||
    !isRecord(resource) ||
    !isRecord(source) ||
    !isRecord(destination) ||
    !isRecord(approval)
  ) {
    return undefined;
  }
  const url = requireString(resource, "url");
  const method = requireString(resource, "method");
  const boundTo = requireString(approval, "boundTo");
  if (url === undefined || method === undefined || boundTo === undefined) {
    return undefined;
  }
  const upstream = body["upstream"];
  const ownerKey = body["ownerKey"];
  const dynamic: Partial<QuoteView> = {};
  if (upstream !== undefined) {
    // 動的 quote: `upstream.url`・`ownerKey` が揃っていなければ quote として扱わない。
    if (!isRecord(upstream) || requireString(upstream, "url") === undefined || requireString(upstream, "method") === undefined || typeof ownerKey !== "string" || ownerKey === "") {
      return undefined;
    }
    Object.assign(dynamic, {
      upstream: { url: upstream["url"] as string, method: upstream["method"] as string, ...(typeof upstream["body"] === "string" ? { body: upstream["body"] } : {}), ...(typeof upstream["bodySha256"] === "string" ? { bodySha256: upstream["bodySha256"] } : {}) },
      ...(isRecord(body["pricing"]) ? { pricing: body["pricing"] } : {}),
      ...(isRecord(body["disclosures"]) ? { disclosures: body["disclosures"] } : {}),
      ownerKey,
    });
  }
  return {
    quoteId,
    paymentId,
    routeId,
    resource: { url, method },
    source: source as QuoteView["source"],
    destination: destination as QuoteView["destination"],
    approval: {
      required: approval["required"] === true,
      boundTo,
      deadlineMs: typeof approval["deadlineMs"] === "number" ? approval["deadlineMs"] : 0,
    },
    ...dynamic,
  };
}

function projectionViewOf(body: unknown): ProjectionView | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const paymentId = requireString(body, "paymentId");
  const routeId = requireString(body, "routeId");
  const status = requireString(body, "status");
  const updatedAt = requireString(body, "updatedAt");
  const quoteFingerprint = requireString(body, "quoteFingerprint");
  if (
    paymentId === undefined ||
    routeId === undefined ||
    status === undefined ||
    updatedAt === undefined ||
    quoteFingerprint === undefined ||
    !isRecord(body["source"]) ||
    !isRecord(body["destination"])
  ) {
    return undefined;
  }
  const terminalReason = requireString(body, "terminalReason");
  return {
    paymentId,
    routeId,
    status,
    source: body["source"],
    destination: body["destination"],
    quoteFingerprint,
    ...(terminalReason === undefined ? {} : { terminalReason }),
    updatedAt,
    ...(Object.hasOwn(body, "result") ? { result: body["result"] } : {}),
    ...(isRecord(body["upstream"]) ? { upstream: body["upstream"] } : {}),
    ...(isRecord(body["dynamic"]) ? { dynamic: body["dynamic"] } : {}),
  };
}

/** 固定の理由コードだけを外に出す（サーバ由来の文字列も安全な短いコードに限る）。 */
/** Router が返した固定の `reason`（形式に合うものだけ。自由文・例外文字列は通さない）。 */
function reasonOf(body: unknown): { reason?: string } {
  if (isRecord(body)) {
    const reason = body["reason"];
    if (typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason)) {
      return { reason };
    }
  }
  return {};
}

/** `Retry-After` の上限（1 時間）。それより長い値は目安として意味が無いので丸める。 */
const RETRY_AFTER_MAX_MS = 3_600_000;
/** RFC 7231 の IMF-fixdate だけ（例 `Sun, 06 Nov 1994 08:49:37 GMT`）。`Date.parse` の寛容さに頼らない。 */
const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * `Retry-After`（delay-seconds か HTTP-date）を ms に。delay-seconds は 10 進の整数だけ（負・小数・指数・桁あふれは無し扱い）、
 * HTTP-date は IMF-fixdate だけで、過去なら 0。どちらも上限 1 時間。読めなければ欄ごと無し。
 */
function retryAfterMsOf(header: string | null): { retryAfterMs?: number } {
  if (header === null) return {};
  const text = header.trim();
  if (text === "") return {};
  if (/^\d{1,10}$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds)) return {};
    return { retryAfterMs: Math.min(seconds * 1000, RETRY_AFTER_MAX_MS) };
  }
  if (!IMF_FIXDATE.test(text)) return {};
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return {};
  // `Date.parse` は存在しない暦日（31 Feb）を繰り上げて読むので、戻した文字列が元と一致するものだけ受ける（曜日の誤りも拒む）。
  if (new Date(at).toUTCString() !== text) return {};
  return { retryAfterMs: Math.min(Math.max(0, at - Date.now()), RETRY_AFTER_MAX_MS) };
}

function errorCodeOf(body: unknown, fallback: string): string {
  if (isRecord(body)) {
    const error = body["error"];
    if (typeof error === "string" && /^[a-z0-9_]{1,64}$/.test(error)) {
      return error;
    }
  }
  return fallback;
}

/**
 * 購入（`execute`）の期限の既定。**静的も動的も同じ**（multirail 設計 §4.4）: Arc（Circle）と Solana の受信は settle に 40〜50 秒掛かり得て、
 * 10 秒で切ると Router が続けているのに `transport_uncertain` になる。動的の最悪（約 102 秒＋ settle の増分 40 秒 = 142 秒）の内側。
 */
export const DEFAULT_EXECUTE_TIMEOUT_MS = 180_000;
/** 互換の別名（以前は動的購入だけに使っていた）。 */
export const DEFAULT_DYNAMIC_EXECUTE_TIMEOUT_MS = DEFAULT_EXECUTE_TIMEOUT_MS;
/** 動的 quote（`quoteUrl`）の期限の既定。Router 側の最悪（上流の読取 5 秒＋見積り 6 秒＋1 回 3 秒 = 14 秒）に余裕を足したもの。 */
export const DEFAULT_DYNAMIC_QUOTE_TIMEOUT_MS = 30_000;

export function createRouterClient(options: RouterClientOptions): RouterClient {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("router client baseUrl must use http(s)");
  }
  const origin = base.origin;
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const executeTimeoutMs = options.executeTimeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS;
  const signalFor = options.signalForTest ?? ((ms: number): AbortSignal => AbortSignal.timeout(ms));
  // 動的 quote の期限: 明示の quoteTimeoutMs → 明示の timeoutMs → 既定 30 秒（明示した timeoutMs は従来どおり効く）。
  const quoteTimeoutMs = options.quoteTimeoutMs ?? options.timeoutMs ?? DEFAULT_DYNAMIC_QUOTE_TIMEOUT_MS;

  /** principal 資格情報は**この origin への要求だけ**に付ける。 */
  function headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      "x-router-principal": options.principalId,
      authorization: `Bearer ${options.token}`,
      ...(options.source === undefined ? {} : { "x-router-source": options.source }),
      ...extra,
    };
  }

  /**
   * この client が発行した quote の束縛スナップショット（`quoteId` → 発行時の値）。
   * 汎用の仕組みは作らず、束縛比較に必要な最小限だけを持つ。
   */
  const issued = new Map<string, { binding: string; requestId: string }>();

  async function call(
    path: string,
    init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; timeoutMs?: number },
  ): Promise<{ status: number; body: unknown; contentType: string; paymentId?: string; retryAfterMs?: number }> {
    const response = await doFetch(new URL(path, origin), {
      method: init.method,
      headers: headers(init.headers ?? {}),
      ...(init.body === undefined ? {} : { body: init.body }),
      // リダイレクトは追わない（資格情報を別の宛先へ運ばない）。
      redirect: "error",
      signal: signalFor(init.timeoutMs ?? timeoutMs),
    });
    let body: unknown;
    try {
      const text = await response.text();
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      // 本文の読み取り・解析の失敗も外へ伝播させない（例外文字列に秘密が混ざり得る）。
      body = undefined;
    }
    const paymentId = response.headers.get("x-router-payment-id");
    return {
      status: response.status,
      body,
      contentType: response.headers.get("content-type") ?? "application/json",
      ...(paymentId === null || paymentId === "" ? {} : { paymentId }),
      ...retryAfterMsOf(response.headers.get("retry-after")),
    };
  }

  return {
    async listRoutes(): Promise<{ ok: boolean; routes: readonly RouteListing[]; dynamic?: Readonly<Record<string, unknown>> }> {
      let result: Awaited<ReturnType<typeof call>>;
      try {
        result = await call("/v1/routes", { method: "GET" });
      } catch {
        // 通信例外はそのまま外へ出さない（自動再試行もしない）。
        return { ok: false, routes: [] };
      }
      if (result.status !== 200 || !isRecord(result.body) || !Array.isArray(result.body["routes"])) {
        return { ok: false, routes: [] };
      }
      const dynamic = result.body["dynamic"];
      return { ok: true, routes: result.body["routes"] as readonly RouteListing[], ...(isRecord(dynamic) ? { dynamic } : {}) };
    },

    async quote(input): Promise<QuoteResult> {
      // **最初の await より前に**入力を控える。呼び出し側が await 中に書き換えても、
      // Router へ送った値と `issued` に残す束縛が食い違わないようにする。
      const routeId = input.routeId;
      const requestId = input.requestId;
      let result: Awaited<ReturnType<typeof call>>;
      try {
        result = await call("/v1/quotes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ routeId, requestId }),
        });
      } catch {
        // 固定の安全な失敗に変換する（例外文字列・秘密を載せない。再試行もしない）。
        return { ok: false, error: "transport_failed", status: 0 };
      }
      if (result.status !== 200) {
        return { ok: false, error: errorCodeOf(result.body, "quote_failed"), status: result.status, ...reasonOf(result.body), ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) };
      }
      const parsed = quoteViewOf(result.body);
      if (parsed === undefined) {
        return { ok: false, error: "quote_malformed", status: result.status };
      }
      // 発行時の値を凍結して渡し、束縛スナップショットを控える（後の改変を検知する）。
      const quote = frozenClone(parsed);
      issued.set(quote.quoteId, { binding: bindingOf(quote), requestId });
      return { ok: true, quote };
    },

    async quoteUrl(input): Promise<QuoteResult> {
      const profileId = input.profileId;
      const url = input.url;
      const requestId = input.requestId;
      let result: Awaited<ReturnType<typeof call>>;
      try {
        result = await call("/v1/quotes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ routeId: profileId, requestId, upstream: { url, ...(input.method === undefined ? {} : { method: input.method }), ...(input.body === undefined ? {} : { body: input.body }) } }),
          // 動的 quote だけ長い（上流の読取＋見積り）。静的 quote は従来どおり `timeoutMs`。
          timeoutMs: quoteTimeoutMs,
        });
      } catch {
        return { ok: false, error: "transport_failed", status: 0 };
      }
      if (result.status !== 200) {
        return { ok: false, error: errorCodeOf(result.body, "quote_failed"), status: result.status, ...reasonOf(result.body), ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) };
      }
      const parsed = quoteViewOf(result.body);
      // 動的 quote の応答として `upstream`・`ownerKey` を持たないもの、頼んだ URL・プロファイルと違うものは受け入れない。
      if (parsed === undefined || parsed.upstream === undefined || parsed.upstream.url !== url || parsed.routeId !== profileId) {
        return { ok: false, error: "quote_malformed", status: result.status };
      }
      const quote = frozenClone(parsed);
      issued.set(quote.quoteId, { binding: bindingOf(quote), requestId });
      return { ok: true, quote };
    },

    async execute(input: ExecuteInput): Promise<ExecutionResult> {
      // 入力は複製して凍結してから使う（呼び出し側が後から書き換えても束縛は動かない）。
      const bound = frozenClone({
        quote: input.quote,
        approval: input.approval,
        credential: input.credential,
        requestId: input.requestId,
      });
      const { quote, approval, credential, requestId } = bound;

      // 1) 明示承認が無ければ要求を出さない（自動承認もしない）。
      if (approval.approved !== true) {
        return {
          outcome: "not_approved",
          reason: approval.reason ?? "approval_required",
          paymentId: quote.paymentId,
        };
      }
      // 2) 承認は quote に束縛される（対象が変わっていれば実行しない）。
      if (approval.quoteId !== quote.quoteId || quote.approval.boundTo !== quote.quoteId) {
        return {
          outcome: "approval_mismatch",
          reason: "approval_bound_to_other_quote",
          paymentId: quote.paymentId,
        };
      }
      // 3) 購入口は承認した canonical path のみ。origin は設定値（`baseUrl`）に固定する。
      //    canonical URL の origin は transport の origin と違っていてよいが、**取得した URL の
      //    改変（origin / query / hash / path）は受理しない**。
      const expectedPath = `/v1/routes/${quote.routeId}/resource`;
      let quoted: URL | undefined;
      try {
        quoted = new URL(quote.resource.url);
      } catch {
        quoted = undefined;
      }
      if (
        quoted === undefined ||
        quoted.pathname !== expectedPath ||
        quoted.search !== "" ||
        quoted.hash !== "" ||
        quote.resource.method !== "GET"
      ) {
        return {
          outcome: "resource_mismatch",
          reason: "resource_not_approved_canonical",
          paymentId: quote.paymentId,
        };
      }
      // 4) 実行できるのは**この client が発行した quote だけ**（fail closed）。発行時の値と
      //    完全一致していなければ実行しない（resource URL・source / destination の条件・
      //    requestId の差し替えを検知する）。client を作り直したあとは `status()` だけが使え、
      //    自動 re-quote も再実行もしない。
      const snapshot = issued.get(quote.quoteId);
      if (snapshot === undefined) {
        // ステートレス運用では quote と purchase が別プロセスになるため、
        // 呼び出し側が持ち回った quote を受け入れる（明示的な opt-in のときだけ）。
        // **Router 側の拒否面は変わらない**: 発行していない nonce・承認不一致・
        // 期限切れ・offer 不一致はすべて core が拒否する。
        if (options.allowUnissuedQuotes !== true) {
          return {
            outcome: "resource_mismatch",
            reason: "quote_not_issued_by_client",
            paymentId: quote.paymentId,
          };
        }
      } else {
        if (bindingOf(quote) !== snapshot.binding) {
          return {
            outcome: "resource_mismatch",
            reason: "quote_binding_changed",
            paymentId: quote.paymentId,
          };
        }
        if (requestId !== snapshot.requestId) {
          return {
            outcome: "resource_mismatch",
            reason: "request_id_changed",
            paymentId: quote.paymentId,
          };
        }
      }
      if (credential === "") {
        return { outcome: "rejected", error: "credential_required", status: 0 };
      }

      let result: Awaited<ReturnType<typeof call>>;
      try {
        // 1 要求 1 回だけ。失敗しても再送・再 quote・requestId 再生成をしない。
        result = await call(expectedPath, {
          method: "GET",
          headers: {
            "x-router-quote-id": quote.quoteId,
            "x-router-request-id": requestId,
            "x-router-approval": approval.quoteId,
            "x-payment": credential,
            // 動的 quote の持ち主の証明（quote 文書から運ぶ）。
            ...(quote.ownerKey === undefined ? {} : { "x-router-owner-key": quote.ownerKey }),
          },
          // 購入は長い（動的は最悪 96 秒ほど、Arc・Solana の静的も settle に 40〜50 秒）。短く切ると Router が続けているのに unknown になる。
          // quote・status・listing の期限（`timeoutMs`）は変えない。
          timeoutMs: executeTimeoutMs,
        });
      } catch {
        // 送金の有無が分からない。paymentId を残して R4 で突き合わせられるようにする。
        return {
          outcome: "unknown",
          paymentId: quote.paymentId,
          reason: "transport_uncertain",
        };
      }

      // 承認済み paymentId が結果の基準。応答が名乗る ID はこれと一致して初めて採用する。
      const paymentId = quote.paymentId;
      /** Router のメタは**ヘッダ**（成功時）と**本文の固定フィールド**（明示結果）だけ。 */
      const headerId = result.paymentId;
      const bodyId = isRecord(result.body) ? requireString(result.body, "paymentId") : undefined;
      const serverStatus = isRecord(result.body) ? result.body["status"] : undefined;
      /** 送金の有無が分からないまま保持する（再送・再 quote はしない）。 */
      const uncertain = (reason: string): ExecutionResult => ({
        outcome: "unknown",
        paymentId,
        reason,
      });
      const idProblem = (claimed: string | undefined): string =>
        claimed === undefined ? "payment_id_missing" : "payment_id_mismatch";

      if (result.status === 200) {
        // 200 だけでは成立にしない。JSON body を取得でき、**Router の paymentId ヘッダが
        // 承認済み ID と完全一致**して初めて delivered。
        // 本文の `paymentId` は上流 snapshot の欄であり得るので、Router のメタとして読まない。
        if (result.body === undefined) {
          return uncertain("response_unreadable");
        }
        if (headerId !== paymentId) {
          return uncertain(idProblem(headerId));
        }
        return {
          outcome: "delivered",
          paymentId,
          snapshot: result.body,
          contentType: result.contentType,
        };
      }

      // 以降は Router の明示結果。ヘッダが別 ID を名乗っていれば矛盾として採用しない。
      if (headerId !== undefined && headerId !== paymentId) {
        return uncertain("payment_id_mismatch");
      }
      if (serverStatus === "paid_data_unavailable" || serverStatus === "unknown") {
        if (bodyId !== paymentId) {
          return uncertain(idProblem(bodyId));
        }
        if (serverStatus === "unknown") {
          return uncertain(errorCodeOf(result.body, "destination_pay_unknown"));
        }
        const terminalReason = isRecord(result.body)
          ? requireString(result.body, "terminalReason")
          : undefined;
        return {
          outcome: "paid_data_unavailable",
          paymentId,
          ...(terminalReason === undefined ? {} : { terminalReason }),
        };
      }
      // 本文を読めない応答は「拒否された」「支払いをやり直せる」と解釈しない
      // （402 の判定より先に置く）。承認済み ID を保ったまま unknown。
      if (result.body === undefined) {
        return uncertain("response_unreadable");
      }
      if (result.status === 402) {
        return {
          outcome: "payment_required",
          error: errorCodeOf(result.body, "payment_required"),
          paymentId,
        };
      }
      // 5xx も同じく確定させない。
      if (result.status >= 500) {
        return uncertain(errorCodeOf(result.body, "response_unreadable"));
      }
      return {
        outcome: "rejected",
        error: errorCodeOf(result.body, `http_${result.status}`),
        status: result.status,
        paymentId,
        ...reasonOf(result.body),
      };
    },

    async status(paymentId: string, ownerKey?: string) {
      let result: Awaited<ReturnType<typeof call>>;
      try {
        result = await call(`/v1/purchases/${encodeURIComponent(paymentId)}`, {
          method: "GET",
          ...(ownerKey === undefined || ownerKey === "" ? {} : { headers: { "x-router-owner-key": ownerKey } }),
        });
      } catch {
        return { found: false as const, status: 0, reason: "transport_failed" };
      }
      if (result.status !== 200) {
        // 404 = **無いか、読めない**（動的の `ownerKey` が無い・違うときも Router は存在を隠して 404 を返す。`src/http/app.ts`）。
        // 401・403 は入口の認可（principal）の失敗。他は http_error。回復の表（payer）では `not_found` だけが「Router に無い」行を適用する。
        const reason = result.status === 404 ? "not_found" : result.status === 401 || result.status === 403 ? "unauthorized" : "http_error";
        return { found: false as const, status: result.status, reason };
      }
      const projection = projectionViewOf(result.body);
      if (projection === undefined) {
        return { found: false as const, status: result.status, reason: "projection_malformed" };
      }
      // 問い合わせた purchase の射影でなければ受理しない（別購入の結果を表示・保存しない）。
      if (projection.paymentId !== paymentId) {
        return { found: false as const, status: result.status, reason: "payment_id_mismatch" };
      }
      return { found: true as const, projection };
    },
  };
}
