/**
 * リモート MCP の入口（HTTP）の資源上限（設計 `docs/dynamic-upstream-design.md` §7.1、要件 FR-31）。
 *
 * 匿名の相手が、巨大な本文や遅い送信で Router のメモリと接続を占有できないようにする。
 * **本文を読む前・読みながら**効く上限なので、どの tool 宛ての要求かを区別できない。
 * したがって静的 route の呼び出しにも掛かる（要件 FR-35 の例外）。
 *
 * 鍵も Router の状態も持たない。MCP の処理は `handle` として渡される。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface McpIngressLimits {
  /** 要求本文の上限（バイト）。超過は読み切らずに 413。 */
  readonly maxBodyBytes: number;
  /** 要求（ヘッダ＋本文）を受け取り終えるまでの期限（ミリ秒）。超過は 408。 */
  readonly receiveTimeoutMs: number;
  /** 同時に受け付ける接続数。超えた接続は Node が受け付けずに閉じる。 */
  readonly maxConnections: number;
}

export const DEFAULT_MCP_INGRESS_LIMITS: McpIngressLimits = Object.freeze({
  maxBodyBytes: 64 * 1024,
  receiveTimeoutMs: 10_000,
  maxConnections: 64,
});

export interface McpIngressOptions {
  readonly limits?: McpIngressLimits;
  /** MCP の処理本体。`body` は JSON として読めた値（本文なし・JSON でないときは `undefined`）。 */
  readonly handle: (request: IncomingMessage, response: ServerResponse, body: unknown) => Promise<void>;
  /** 運用者向けの固定文の出力先（stderr）。**例外の文字列・要求の内容は渡さない。** */
  readonly note?: (message: string) => void;
  /** MCP を受けるパス。 */
  readonly path?: string;
}

function sendJson(response: ServerResponse, status: number, error: string, close = false): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const text = JSON.stringify({ error });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...(close ? { connection: "close" } : {}),
  });
  response.end(text);
}

type BodyResult =
  | { readonly kind: "ok"; readonly bytes: Buffer }
  | { readonly kind: "too_large" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

/** 本文を上限と期限つきで読む。上限・期限に達したら残りは読まない。 */
function readBody(request: IncomingMessage, maxBytes: number, deadlineMs: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    // 申告された長さが上限を超えていれば、1 バイトも読まない。
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      resolve({ kind: "too_large" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("close", onClose);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        finish({ kind: "too_large" });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish({ kind: "ok", bytes: Buffer.concat(chunks) });
    const onError = (): void => finish({ kind: "aborted" });
    const onClose = (): void => finish({ kind: "aborted" });
    const timer = setTimeout(() => finish({ kind: "timeout" }), deadlineMs);
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("close", onClose);
  });
}

/**
 * 入口の HTTP サーバを作る（listen は呼び出し側）。
 * `GET /healthz` は従来どおり。`path` 以外は 404。
 */
export function createMcpIngress(options: McpIngressOptions): Server {
  const limits = options.limits ?? DEFAULT_MCP_INGRESS_LIMITS;
  const mcpPath = options.path ?? "/mcp";
  const note = options.note ?? (() => {});

  const server = createServer(
    {
      // Node は `headersTimeout`／`requestTimeout` をこの間隔でしか検査しない（既定 30 秒）。
      // 期限より粗いと、ヘッダを送らない接続が期限を大きく超えて残る。
      connectionsCheckingInterval: Math.max(100, Math.min(1_000, Math.floor(limits.receiveTimeoutMs / 2))),
    },
    (request, response) => {
    const startedAt = Date.now();
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/healthz") {
        const text = JSON.stringify({ status: "ok", router: "up" });
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        response.end(text);
        return;
      }
      if (url.pathname !== mcpPath) {
        sendJson(response, 404, "not_found");
        return;
      }
      const remaining = Math.max(1, limits.receiveTimeoutMs - (Date.now() - startedAt));
      const body = await readBody(request, limits.maxBodyBytes, remaining);
      if (body.kind === "too_large") {
        // 残りは読まずに接続ごと閉じる（読み続けると上限の意味が無い）。
        sendJson(response, 413, "body_too_large", true);
        request.destroy();
        return;
      }
      if (body.kind === "timeout") {
        sendJson(response, 408, "request_timeout", true);
        request.destroy();
        return;
      }
      if (body.kind === "aborted") {
        response.destroy();
        return;
      }
      let parsed: unknown;
      try {
        parsed = body.bytes.length === 0 ? undefined : JSON.parse(body.bytes.toString("utf8"));
      } catch {
        parsed = undefined;
      }
      await options.handle(request, response, parsed);
    })().catch(() => {
      // 例外の文字列は出さない（上流 URL・トークン・要求の内容が混ざり得る）。
      note("mcp ingress: request failed");
      sendJson(response, 500, "internal_error");
    });
    },
  );

  // ヘッダの受信にも同じ期限を掛ける（本文の期限は上の `readBody`）。
  server.headersTimeout = limits.receiveTimeoutMs;
  server.requestTimeout = limits.receiveTimeoutMs;
  server.maxConnections = limits.maxConnections;
  return server;
}
