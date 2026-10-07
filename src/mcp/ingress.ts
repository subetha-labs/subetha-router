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
  /**
   * 1 つの要求が接続を使える時間の上限（受信開始から応答の完了まで、ミリ秒）。
   * 応答をわざと遅く読む相手が接続の枠を持ち続けられないようにする。purchase の所要時間より十分長く取る。
   */
  readonly maxRequestMs: number;
}

export const DEFAULT_MCP_INGRESS_LIMITS: McpIngressLimits = Object.freeze({
  maxBodyBytes: 64 * 1024,
  receiveTimeoutMs: 10_000,
  maxConnections: 64,
  // 要求の寿命（応答を含む）。購入の最悪（動的 142 秒。multirail 設計 §4.4）を超え、client の既定 180 秒と揃える。
  maxRequestMs: 180_000,
});

/** 拒否の応答を書き終えるまで待つ上限。過ぎたら接続を切る。 */
const REJECT_FLUSH_MS = 2_000;
const PROTOCOL_VERSION_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export interface McpIngressOptions {
  readonly limits?: McpIngressLimits;
  /** MCP の処理本体。`body` は JSON として読めた値（本文なし・JSON でないときは `undefined`）。 */
  readonly handle: (request: IncomingMessage, response: ServerResponse, body: unknown) => Promise<void>;
  /** 運用者向けの固定文の出力先（stderr）。**例外の文字列・要求の内容は渡さない。** */
  readonly note?: (message: string) => void;
  /** MCP を受けるパス。 */
  readonly path?: string;
}

function sendJson(
  response: ServerResponse,
  status: number,
  error: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const text = JSON.stringify({ error });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  response.end(text);
}

/**
 * 本文を読み切らずに拒否する。**入力はすぐ止め**（これ以上読まない）、拒否の応答は書き終えるまで待ってから
 * 接続を切る。すぐに切ると、応答が相手に届く前に消える（同じ接続で先に処理中の応答があればそれも巻き込む）。
 * 待つのは `REJECT_FLUSH_MS` まで。
 */
function rejectAndClose(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  error: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  request.pause();
  const socket = request.socket;
  let timer: NodeJS.Timeout | undefined;
  /**
   * 書き終えを待つ時計は、**この応答の番が来てから**動かす。同じ接続で先に処理中の応答がある間、
   * この応答は後ろに並んでいるだけで（Node は `response.socket` をまだ割り当てない）、そこで時計を動かすと
   * 先の正当な応答ごと接続を切ってしまう。先の応答の長さは、それ自身の要求の時間の上限が縛る。
   */
  const arm = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => socket.destroy(), REJECT_FLUSH_MS);
    timer.unref();
  };
  response.once("finish", () => {
    clearTimeout(timer);
    socket.destroy();
  });
  response.once("close", () => clearTimeout(timer));
  if (response.socket === null) response.once("socket", arm);
  else arm();
  sendJson(response, status, error, { ...headers, connection: "close" });
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
 * `GET /healthz` は従来どおり。`path` 以外は 404。`path` は POST と DELETE だけ（GET の stream は出さない）。
 *
 * **この層が固定文にするもの**: 自分で返す拒否（404・405・400・408・413・500）と `note`。
 * MCP の SDK が自分で作るエラー応答（JSON-RPC の形式エラーなど、呼び出し側自身の入力についての説明）は SDK の文面のまま。
 * tool の中の例外を固定文にするのは `src/mcp/server.ts` の役目。
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
    // 要求 1 件が接続を使える時間の上限。応答が終われば解除する。
    const lifetime = setTimeout(() => {
      note("mcp ingress: request exceeded its lifetime");
      request.socket.destroy();
    }, limits.maxRequestMs);
    lifetime.unref();
    response.once("close", () => clearTimeout(lifetime));
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      // 本文を持つ要求を、本文を読まずに終える経路では接続ごと閉じる（読み残しを Node に読ませ続けない）。
      const hasBody = request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined;
      const finishWithoutBody = (status: number, error: string, headers: Readonly<Record<string, string>> = {}): void => {
        if (hasBody) rejectAndClose(request, response, status, error, headers);
        else sendJson(response, status, error, headers);
      };
      if (request.method === "GET" && url.pathname === "/healthz" && !hasBody) {
        const text = JSON.stringify({ status: "ok", router: "up" });
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        response.end(text);
        return;
      }
      if (url.pathname !== mcpPath) {
        finishWithoutBody(404, "not_found");
        return;
      }
      /**
       * ステートレスなので、サーバから送り始める stream（GET）は持たない。受け付けると、応答を返さない接続を
       * 開くだけで接続の枠を埋められる。仕様上、stream を出さないサーバは 405 を返してよい。
       */
      if (request.method !== "POST" && request.method !== "DELETE") {
        finishWithoutBody(405, "method_not_allowed", { allow: "POST, DELETE" });
        return;
      }
      // SDK は未対応の値を**そのまま**エラー本文に写す。日付の形でない値はここで固定文にする。
      const protocolVersion = request.headers["mcp-protocol-version"];
      if (protocolVersion !== undefined && (typeof protocolVersion !== "string" || !PROTOCOL_VERSION_PATTERN.test(protocolVersion))) {
        finishWithoutBody(400, "unsupported_protocol_version");
        return;
      }
      const remaining = Math.max(1, limits.receiveTimeoutMs - (Date.now() - startedAt));
      const body = await readBody(request, limits.maxBodyBytes, remaining);
      if (body.kind === "too_large") {
        rejectAndClose(request, response, 413, "body_too_large");
        return;
      }
      if (body.kind === "timeout") {
        rejectAndClose(request, response, 408, "request_timeout");
        return;
      }
      if (body.kind === "aborted") {
        response.destroy();
        return;
      }
      let parsed: unknown;
      if (body.bytes.length > 0) {
        try {
          parsed = JSON.parse(body.bytes.toString("utf8"));
        } catch {
          // SDK に渡すと、解析エラーの文字列がそのまま応答に載る。ここで固定文にする。
          sendJson(response, 400, "invalid_json");
          return;
        }
      } else if (request.method === "POST") {
        sendJson(response, 400, "invalid_json");
        return;
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
