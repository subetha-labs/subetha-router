/**
 * Router 到達回数を**独立に**計数する loopback プロキシ。
 *
 * Router の HTTP 層にはアクセスログ・カウンタが無いため、上流の `payCalls` だけでは
 * 「Router が R3 を受けたが 4xx で弾いた」ケースと「Router に届いていない」ケースを
 * 区別できない。否定系の検証（承認していないのに要求が出ていないか）を chat 側の journal
 * だけに頼らず確かめるために、method + path 別の到達回数をここで数える。
 *
 * **body・ヘッダを書き換えない**（R2 応答を「無改変で」chat の検証に通すため）。
 * 転送先は loopback のみ。
 *
 * usage: router-calls-proxy.ts --target http://127.0.0.1:PORT [--port N]
 */

import http from "node:http";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const target = new URL(arg("target", "http://127.0.0.1:8500"));
if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost") {
  process.stderr.write("router-calls-proxy: target must be loopback\n");
  process.exit(2);
}

/** `METHOD path` → 到達回数。path は `routeId` / `paymentId` を含む生の pathname。 */
const calls = new Map<string, number>();
/** 到達した順の記録（順序に依存する検証のため）。 */
const order: string[] = [];

function note(key: string): void {
  calls.set(key, (calls.get(key) ?? 0) + 1);
  order.push(key);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

/** R1/R2/R3/R4 の到達を要求形から分類する（Router の内部状態は覗かない）。 */
function classify(method: string, pathname: string): string {
  const segments = pathname.split("/").filter((part) => part !== "");
  if (method === "GET" && segments.length === 2 && segments[1] === "routes") return "R1";
  if (method === "POST" && segments.length === 2 && segments[1] === "quotes") return "R2";
  if (
    method === "GET" &&
    segments.length === 4 &&
    segments[1] === "routes" &&
    segments[3] === "resource"
  ) {
    return "R3";
  }
  if (method === "GET" && segments.length === 3 && segments[1] === "purchases") return "R4";
  return "other";
}

const server = http.createServer((request, response) => {
  const method = request.method ?? "GET";
  const raw = request.url ?? "/";
  const url = new URL(raw, "http://127.0.0.1");

  // 計数の取り出し口はプロキシ自身が処理し、Router へは転送しない。
  if (method === "GET" && url.pathname === "/__calls") {
    sendJson(response, 200, {
      byKey: Object.fromEntries(calls),
      order,
      R1: calls.get("R1") ?? 0,
      R2: calls.get("R2") ?? 0,
      R3: calls.get("R3") ?? 0,
      R4: calls.get("R4") ?? 0,
    });
    return;
  }

  note(classify(method, url.pathname));

  const forwarded = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      method,
      path: raw,
      headers: request.headers,
    },
    (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(response);
    },
  );
  forwarded.on("error", () => {
    if (!response.headersSent) {
      sendJson(response, 502, { error: "proxy_upstream_unreachable" });
      return;
    }
    response.destroy();
  });
  request.pipe(forwarded);
});

server.listen(Number(arg("port", "0")), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(`${JSON.stringify({ event: "listening", port, role: "router-proxy" })}\n`);
});
