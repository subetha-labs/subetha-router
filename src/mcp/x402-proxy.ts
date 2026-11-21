/**
 * 公開の入口（MCP の ingress）に足す、標準の x402 クライアント用の経路（`docs/hosted-exact-enable-design.md` §5）。
 *
 * `GET /x402/v1/routes/{routeId}/resource` だけを、ingress が持っている**子の Router の address**の同じパスへ 1 回渡す。
 * - 照合は要求の**生の** `request.url` と、設定にある routeId から組んだパスの**完全一致**。一致しなければ何もしない（ingress の今の 404 に落ちる）。
 * - 子へ渡すヘッダーは、ここで組み立てる 3〜4 個だけ（principal・その認証・導いた送信元・`PAYMENT-SIGNATURE`）。買い手のヘッダーは渡さない。
 * - 返すヘッダーは allowlist だけ。子の応答は全部を読み終えてから書き始める。
 * - **転送を始めた後の失敗はここで処理する**: 公開の応答をまだ書いていなければ、署名付きは 502 `result_unknown`（未払いの証明ではない・署名し直さない）、
 *   署名なしは 503。書き始めていれば接続を切る。どれも 402 でなく、`PAYMENT-REQUIRED` を持たない。
 * - 返す Promise は、子の応答を読み終えるか期限が来るまで解決しない（買い手が切っても子の購入は続き、ingress の drain の数に残る）。
 * - ログは固定文だけ（署名・送信元の値を出さない）。
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";

export interface X402ProxyLimits {
  /** 子の応答を待つ上限（ミリ秒）。ingress の要求の寿命より短くする。 */
  readonly upstreamTimeoutMs: number;
  /** 子の応答の本文の上限。 */
  readonly maxResponseBytes: number;
  /** `PAYMENT-SIGNATURE` の値の上限。 */
  readonly maxSignatureBytes: number;
  /** 同時に転送中の要求の数。 */
  readonly maxConcurrent: number;
  /** 送信元ごとの毎分の数（署名なし／署名付き）。子の ledger の制限より緩い外側の守り。 */
  readonly unsignedPerMinutePerSource: number;
  readonly signedPerMinutePerSource: number;
  readonly maxSources: number;
}

export const DEFAULT_X402_PROXY_LIMITS: X402ProxyLimits = Object.freeze({
  upstreamTimeoutMs: 170_000,
  maxResponseBytes: 300 * 1024,
  maxSignatureBytes: 8 * 1024,
  maxConcurrent: 16,
  unsignedPerMinutePerSource: 12,
  signedPerMinutePerSource: 30,
  maxSources: 10_000,
});

export interface X402ProxyOptions {
  /** 対象の routeId（設定にあるものだけ）。 */
  readonly routeIds: readonly string[];
  /** 子の Router の address（`http://127.0.0.1:<port>`）。要求からは決めない。 */
  readonly childBaseUrl: string;
  readonly principalId: string;
  readonly token: string;
  /** 送信元の導き方（信頼する proxy が足した接続元。`sourceOfRequest`）。 */
  readonly sourceOf: (request: IncomingMessage) => string;
  readonly limits?: X402ProxyLimits;
  readonly now?: () => number;
  readonly note?: (message: string) => void;
}

/** 自分の経路なら処理して `true`、違えば何もせず `false`。 */
export type X402Proxy = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

const RESPONSE_HEADERS = ["content-type", "cache-control", "payment-required", "payment-response", "x-router-payment-id", "retry-after", "allow"] as const;
const NOTE_UNKNOWN = "The Router did not answer. This is not proof that nothing was paid. Do not sign again; read the result later by sending the same PAYMENT-SIGNATURE again.";
const NOTE_NOT_STARTED = "This request did not start a payment.";

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), "cache-control": "no-store", ...headers });
  response.end(text);
}

function rawValuesOf(request: IncomingMessage, name: string): string[] {
  const out: string[] = [];
  const raw = request.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    if (raw[index]!.toLowerCase() === name) out.push(raw[index + 1]!);
  }
  return out;
}

export function createX402Proxy(options: X402ProxyOptions): X402Proxy {
  const limits = options.limits ?? DEFAULT_X402_PROXY_LIMITS;
  const now = options.now ?? (() => Date.now());
  const note = options.note ?? (() => {});
  const child = new URL(options.childBaseUrl);
  if (child.protocol !== "http:" || (child.hostname !== "127.0.0.1" && child.hostname !== "localhost" && child.hostname !== "[::1]")) {
    throw new Error("x402 proxy: the child Router must be a loopback http address");
  }
  /** 完全一致で照合するパス（routeId は設定の値。要求からは組まない）。 */
  const paths = new Set(options.routeIds.map((routeId) => `/x402/v1/routes/${routeId}/resource`));
  let active = 0;
  const windows = new Map<string, { window: number; unsigned: number; signed: number }>();

  /** 送信元ごとの毎分の数。超えていれば false。 */
  function admit(source: string, signed: boolean): boolean {
    const window = Math.floor(now() / 60_000);
    let entry = windows.get(source);
    if (entry === undefined || entry.window !== window) {
      if (entry === undefined && windows.size >= limits.maxSources) {
        // 古い窓の分だけを捨てる。今の窓の分は残す（新しい送信元が来ても、数えている相手の枠を戻さない）。まだ満杯なら新しい送信元は受けない。
        for (const [key, value] of windows) if (value.window !== window) windows.delete(key);
        if (windows.size >= limits.maxSources) return false;
      }
      entry = { window, unsigned: 0, signed: 0 };
      windows.set(source, entry);
    }
    if (signed) {
      if (entry.signed >= limits.signedPerMinutePerSource) return false;
      entry.signed += 1;
    } else {
      if (entry.unsigned >= limits.unsignedPerMinutePerSource) return false;
      entry.unsigned += 1;
    }
    return true;
  }

  return async (request, response) => {
    const rawUrl = request.url ?? "";
    // 生の文字列の完全一致だけ（正規化しない: 符号化・dot segment・絶対 URL・クエリ・末尾の `/` は一致しない）。`Host` は見ない。
    if (!paths.has(rawUrl)) return false;
    const hasBody = request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined;
    if (request.method !== "GET") {
      send(response, 405, { error: "method_not_allowed" }, { allow: "GET", ...(hasBody ? { connection: "close" } : {}) });
      return true;
    }
    if (hasBody) {
      send(response, 400, { error: "invalid_request" }, { connection: "close" });
      return true;
    }
    const signatures = rawValuesOf(request, "payment-signature");
    if (rawValuesOf(request, "x-payment").length > 0 || signatures.length > 1 || (signatures.length === 1 && (signatures[0] === "" || signatures[0]!.length > limits.maxSignatureBytes))) {
      send(response, 400, { error: "invalid_payment" });
      return true;
    }
    const signature = signatures[0];
    const signed = signature !== undefined;
    const source = options.sourceOf(request);
    if (!admit(source, signed)) {
      send(response, 429, { error: "rate_limited" }, { "retry-after": "60" });
      return true;
    }
    if (active >= limits.maxConcurrent) {
      send(response, 503, { error: "unavailable", ...(signed ? { note: "This request was not forwarded. It did not start settlement. This is not a statement that nothing was paid." } : { note: NOTE_NOT_STARTED }) }, { "retry-after": "5" });
      return true;
    }

    /** 転送の後の失敗: 公開の応答を書く前なら固定の応答、書き始めていれば切断。 */
    const failed = (): void => {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      if (signed) send(response, 502, { error: "result_unknown", note: NOTE_UNKNOWN });
      else send(response, 503, { error: "unavailable", note: NOTE_NOT_STARTED }, { "retry-after": "60" });
    };

    active += 1;
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (ok: boolean, write?: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            if (ok && write !== undefined) write();
            else failed();
          } catch {
            failed();
          }
          resolve();
        };
        const upstream = httpRequest(
          {
            protocol: "http:",
            host: child.hostname.replace(/^\[|\]$/g, ""),
            port: child.port,
            method: "GET",
            // 照合に使った固定のパス（要求の値から組まない）。
            path: rawUrl,
            headers: {
              "x-router-principal": options.principalId,
              authorization: `Bearer ${options.token}`,
              "x-router-source": source,
              ...(signature === undefined ? {} : { "payment-signature": signature }),
            },
            agent: false,
          },
          (upstreamResponse) => {
            const chunks: Buffer[] = [];
            let size = 0;
            upstreamResponse.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > limits.maxResponseBytes) {
                upstream.destroy();
                finish(false);
                return;
              }
              chunks.push(chunk);
            });
            upstreamResponse.on("error", () => finish(false));
            upstreamResponse.on("aborted", () => finish(false));
            upstreamResponse.on("end", () => {
              const status = upstreamResponse.statusCode;
              // 子の応答の形: status は 200〜599 の整数、redirect は返さない（子は redirect を出さない。出たら不正として扱う）。
              if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599 || (status >= 300 && status < 400)) return finish(false);
              // 署名付きの要求への応答に challenge を載せない（子の規則。ここでも守る）。
              if (signed && (status === 402 || upstreamResponse.headers["payment-required"] !== undefined)) return finish(false);
              const body = Buffer.concat(chunks);
              finish(true, () => {
                if (response.destroyed) return;
                const headers: Record<string, string | number> = { "content-length": body.length };
                for (const name of RESPONSE_HEADERS) {
                  const value = upstreamResponse.headers[name];
                  if (typeof value === "string") headers[name] = value;
                }
                response.writeHead(status, headers);
                response.end(body);
              });
            });
          },
        );
        const timer = setTimeout(() => {
          upstream.destroy();
          finish(false);
        }, limits.upstreamTimeoutMs);
        upstream.on("error", () => finish(false));
        upstream.end();
      });
    } catch {
      note("x402 proxy: request failed");
      failed();
    } finally {
      active -= 1;
    }
    return true;
  };
}
