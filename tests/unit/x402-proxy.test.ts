/**
 * 公開の入口の標準 x402 の経路（`src/mcp/x402-proxy.ts`。`docs/hosted-exact-enable-design.md` §5、§9 T-c）。
 * 偽の子（loopback の HTTP server）を相手に、照合・ヘッダーの転送と除去・応答の allowlist・拒否・子が答えない各場合・買い手の切断を確かめる。
 */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";

import { createMcpIngress } from "../../src/mcp/ingress.js";
import { createX402Proxy, DEFAULT_X402_PROXY_LIMITS, type X402ProxyLimits } from "../../src/mcp/x402-proxy.js";

const PATH = "/x402/v1/routes/r1/resource";
type ChildHandler = (request: http.IncomingMessage, response: http.ServerResponse) => void;
interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders }

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(server: http.Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function setup(handler: ChildHandler, limits: Partial<X402ProxyLimits> = {}, withProxy = true) {
  const seen: Seen[] = [];
  const child = http.createServer((request, response) => {
    seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers });
    handler(request, response);
  });
  const childBaseUrl = await listen(child);
  let resolved = 0;
  const proxy = createX402Proxy({ routeIds: ["r1"], childBaseUrl, principalId: "judge", token: "public", sourceOf: (request) => `addr:${request.socket.remoteAddress ?? ""}`, limits: { ...DEFAULT_X402_PROXY_LIMITS, ...limits } });
  const mcpCalls: string[] = [];
  const ingress = createMcpIngress({
    handle: async (request, response) => {
      mcpCalls.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    },
    ...(withProxy
      ? {
          x402Proxy: async (request: http.IncomingMessage, response: http.ServerResponse) => {
            const handled = await proxy(request, response);
            if (handled) resolved += 1;
            return handled;
          },
        }
      : {}),
  });
  const baseUrl = await listen(ingress);
  return { baseUrl, seen, mcpCalls, resolvedCount: () => resolved };
}
function get(baseUrl: string, path: string, headers: http.OutgoingHttpHeaders = {}, method = "GET", body?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}${path}`, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(body);
  });
}
/** 生の request line（fetch・http.request は正規化するので、細工したパスは socket で送る）。 */
function raw(baseUrl: string, requestLine: string): Promise<string> {
  const { port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => socket.write(`${requestLine}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`));
    let text = "";
    socket.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
  });
}
const ok402: ChildHandler = (_request, response) => {
  response.writeHead(402, { "content-type": "application/json", "payment-required": "cmVxdWlyZWQ=", "set-cookie": "a=b", "x-secret": "leak", "retry-after": "7" });
  response.end(JSON.stringify({ x402Version: 2, accepts: [] }));
};

test("転送: 子へは ingress が組んだヘッダーだけが届き、買い手のヘッダーは届かない。応答は allowlist のヘッダーだけ", async () => {
  const h = await setup(ok402);
  const response = await get(h.baseUrl, PATH, { authorization: "Bearer attacker", "x-router-principal": "admin", "x-router-source": "fwd:1.2.3.4", "x-router-owner-key": "k", cookie: "c=1", "x-forwarded-for": "9.9.9.9" });
  expect(response.status).toBe(402);
  expect(response.headers["payment-required"]).toBe("cmVxdWlyZWQ=");
  expect(response.headers["retry-after"]).toBe("7");
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(response.headers["x-secret"]).toBeUndefined();
  expect(JSON.parse(response.body)).toEqual({ x402Version: 2, accepts: [] });
  expect(h.seen).toHaveLength(1);
  const forwarded = h.seen[0]!;
  expect([forwarded.method, forwarded.url]).toEqual(["GET", PATH]);
  expect(Object.keys(forwarded.headers).sort()).toEqual(["authorization", "connection", "host", "x-router-principal", "x-router-source"]);
  expect(forwarded.headers).toMatchObject({ authorization: "Bearer public", "x-router-principal": "judge", "x-router-source": "addr:127.0.0.1" });
  expect(h.mcpCalls).toEqual([]);
});

test("署名付き: `PAYMENT-SIGNATURE` だけが足されて届き、200 と `PAYMENT-RESPONSE`・`X-Router-Payment-Id` が返る", async () => {
  const h = await setup((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "payment-response": "c2V0dGxlZA==", "x-router-payment-id": "pay-1", "cache-control": "no-store" });
    response.end(JSON.stringify({ data: 1 }));
  });
  const response = await get(h.baseUrl, PATH, { "PAYMENT-SIGNATURE": "c2ln" });
  expect([response.status, response.headers["payment-response"], response.headers["x-router-payment-id"], response.body]).toEqual([200, "c2V0dGxlZA==", "pay-1", JSON.stringify({ data: 1 })]);
  expect(h.seen[0]!.headers["payment-signature"]).toBe("c2ln");
});

test("照合は生の URL の完全一致: クエリ・末尾の `/`・別の routeId・符号化・dot segment・二重の `/`・絶対 URL は ingress の 404 のままで、子に届かない", async () => {
  const h = await setup(ok402);
  for (const path of [`${PATH}?a=1`, `${PATH}/`, "/x402/v1/routes/r2/resource", "/x402/v1/routes/r1", "/x402", "/X402/v1/routes/r1/resource"]) {
    const response = await get(h.baseUrl, path);
    expect([path, response.status, response.body]).toEqual([path, 404, JSON.stringify({ error: "not_found" })]);
  }
  for (const line of [
    "GET /x402/v1/routes/r1%2Fresource HTTP/1.1",
    "GET /x402/v1/routes/%72%31/resource HTTP/1.1",
    "GET /x402/v1/routes/../routes/r1/resource HTTP/1.1",
    "GET //x402/v1/routes/r1/resource HTTP/1.1",
    "GET /x402/v1/routes/r1/resource#f HTTP/1.1",
    `GET http://evil.example${PATH} HTTP/1.1`,
  ]) {
    expect([line, (await raw(h.baseUrl, line)).split("\r\n")[0]]).toEqual([line, "HTTP/1.1 404 Not Found"]);
  }
  // 別の `Host` でも、パスが一致すれば自分の経路（`Host` は見ない。転送先は固定）。
  expect((await raw(h.baseUrl, `GET ${PATH} HTTP/1.1`)).split("\r\n")[0]).toBe("HTTP/1.1 402 Payment Required");
  expect(h.seen).toHaveLength(1);
  expect(h.seen[0]!.headers["host"]).not.toContain("evil");
});

test("拒否（子に届かない）: GET 以外は 405、本文付きは 400、`X-PAYMENT`・署名の重複・空・過大は 400。どれも 402 でない", async () => {
  const h = await setup(ok402);
  const post = await get(h.baseUrl, PATH, {}, "POST");
  expect([post.status, post.headers["allow"]]).toEqual([405, "GET"]);
  expect((await get(h.baseUrl, PATH, { "content-length": "2" }, "GET", "{}")).status).toBe(400);
  for (const headers of [{ "X-PAYMENT": "eA==" }, { "X-PAYMENT": "eA==", "PAYMENT-SIGNATURE": "eA==" }, { "PAYMENT-SIGNATURE": ["eA==", "eQ=="] }, { "PAYMENT-SIGNATURE": "" }, { "PAYMENT-SIGNATURE": "A".repeat(9000) }] as http.OutgoingHttpHeaders[]) {
    const response = await get(h.baseUrl, PATH, headers);
    expect([JSON.stringify(Object.keys(headers)), response.status, response.body]).toEqual([JSON.stringify(Object.keys(headers)), 400, JSON.stringify({ error: "invalid_payment" })]);
    expect(response.headers["payment-required"]).toBeUndefined();
  }
  expect(h.seen).toEqual([]);
});

test("頻度と同時の数: 送信元ごとの毎分の数を超えると 429（署名なしと署名付きは別に数える）。同時に転送中の数を超えると 503", async () => {
  const h = await setup(ok402, { unsignedPerMinutePerSource: 2, signedPerMinutePerSource: 1 });
  expect([(await get(h.baseUrl, PATH)).status, (await get(h.baseUrl, PATH)).status]).toEqual([402, 402]);
  const limited = await get(h.baseUrl, PATH);
  expect([limited.status, limited.headers["retry-after"], limited.body]).toEqual([429, "60", JSON.stringify({ error: "rate_limited" })]);
  expect(h.seen).toHaveLength(2);
  // 署名付きの要求は、署名なしの数では止まらない（払おうとしている買い手を止めない）が、自分の上限はある。
  expect((await get(h.baseUrl, PATH, { "PAYMENT-SIGNATURE": "c2ln" })).status).not.toBe(429);
  expect((await get(h.baseUrl, PATH, { "PAYMENT-SIGNATURE": "c2ln" })).status).toBe(429);

  let release: (() => void) | undefined;
  const slow = await setup((_request, response) => {
    release = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    };
  }, { maxConcurrent: 1 });
  const first = get(slow.baseUrl, PATH);
  while (release === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await get(slow.baseUrl, PATH);
  expect([second.status, JSON.parse(second.body).error]).toEqual([503, "unavailable"]);
  release();
  expect((await first).status).toBe(200);
});

test("送信元の表が満杯のとき: 今の窓で数えている相手の数は戻さず、新しい送信元は受けない（古い窓の分だけ捨てる）", async () => {
  const seen: string[] = [];
  const child = http.createServer((_request, response) => {
    seen.push("hit");
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const childBaseUrl = await listen(child);
  let nowMs = 1_800_000_000_000;
  const proxy = createX402Proxy({
    routeIds: ["r1"],
    childBaseUrl,
    principalId: "judge",
    token: "public",
    sourceOf: (request) => String(request.headers["x-test-source"] ?? "none"),
    limits: { ...DEFAULT_X402_PROXY_LIMITS, maxSources: 2, unsignedPerMinutePerSource: 1 },
    now: () => nowMs,
  });
  const ingress = createMcpIngress({ handle: async (_request, response) => void response.writeHead(404).end(), x402Proxy: proxy });
  const baseUrl = await listen(ingress);
  const from = (source: string) => get(baseUrl, PATH, { "x-test-source": source });
  expect([(await from("a")).status, (await from("b")).status]).toEqual([200, 200]);
  // 表は満杯（a・b）。新しい送信元 c は受けない。a・b の数は戻らない（2 回目は自分の上限で 429）。
  expect([(await from("c")).status, (await from("a")).status, (await from("b")).status]).toEqual([429, 429, 429]);
  expect(seen).toHaveLength(2);
  // 次の窓: 古い窓の分は捨てられ、新しい送信元も受ける。
  nowMs += 60_000;
  expect([(await from("c")).status, (await from("a")).status]).toEqual([200, 200]);
});

test("子が答えない・形が悪い: 署名付きは 502 `result_unknown`（未払いの証明ではない・署名し直さない）、署名なしは 503。どれも 402 でなく `PAYMENT-REQUIRED` を持たない", async () => {
  const cases: { name: string; handler: ChildHandler; limits?: Partial<X402ProxyLimits> }[] = [
    { name: "disconnect before headers", handler: (request) => request.socket.destroy() },
    { name: "timeout", handler: () => undefined, limits: { upstreamTimeoutMs: 150 } },
    { name: "disconnect mid body", handler: (_request, response) => { response.writeHead(200, { "content-type": "application/json", "content-length": "100" }); response.write("{"); setTimeout(() => response.socket?.destroy(), 20); } },
    { name: "oversize body", handler: (_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end("x".repeat(5000)); }, limits: { maxResponseBytes: 1000 } },
    { name: "redirect", handler: (_request, response) => { response.writeHead(302, { location: "http://evil.example/" }); response.end(); } },
  ];
  for (const item of cases) {
    const h = await setup(item.handler, item.limits ?? {});
    const signed = await get(h.baseUrl, PATH, { "PAYMENT-SIGNATURE": "c2ln" });
    const signedBody = JSON.parse(signed.body) as { error: string; note: string };
    expect([item.name, signed.status, signedBody.error]).toEqual([item.name, 502, "result_unknown"]);
    expect(signedBody.note).toContain("not proof that nothing was paid");
    expect(signedBody.note).toContain("Do not sign again");
    expect(signed.headers["payment-required"]).toBeUndefined();
    expect(signed.headers["location"]).toBeUndefined();
    const unsigned = await get(h.baseUrl, PATH);
    expect([item.name, unsigned.status, JSON.parse(unsigned.body).error, unsigned.headers["retry-after"]]).toEqual([item.name, 503, "unavailable", "60"]);
    expect(unsigned.headers["payment-required"]).toBeUndefined();
  }
  // 署名付きの要求に子が challenge を返した場合も、そのまま渡さない（再署名を誘わない）。
  const challenged = await setup(ok402);
  const response = await get(challenged.baseUrl, PATH, { "PAYMENT-SIGNATURE": "c2ln" });
  expect([response.status, JSON.parse(response.body).error, response.headers["payment-required"]]).toEqual([502, "result_unknown", undefined]);
});

test("買い手が途中で切っても転送は続き、子の応答を読み終えるまで proxy は終わらない（drain の数に残る）", async () => {
  let childFinished = false;
  const h = await setup((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      childFinished = true;
    }, 300);
  });
  const { port } = new URL(h.baseUrl);
  const socket = net.connect(Number(port), "127.0.0.1", () => socket.write(`GET ${PATH} HTTP/1.1\r\nHost: x\r\nPAYMENT-SIGNATURE: c2ln\r\n\r\n`));
  while (h.seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // 買い手は切れたが、子はまだ処理中で、proxy も終わっていない。
  expect([childFinished, h.resolvedCount()]).toEqual([false, 0]);
  while (h.resolvedCount() === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(childFinished).toBe(true);
  expect(h.seen).toHaveLength(1);
});

test("proxy を渡さない ingress は今までどおり: 同じパスは 404 で、子に届かない。MCP の経路と /healthz は proxy があっても変わらない", async () => {
  const without = await setup(ok402, {}, false);
  expect([(await get(without.baseUrl, PATH)).status, without.seen.length]).toEqual([404, 0]);
  const withProxy = await setup(ok402);
  expect((await get(withProxy.baseUrl, "/healthz")).body).toBe(JSON.stringify({ status: "ok", router: "up" }));
  const mcp = await get(withProxy.baseUrl, "/mcp", { "content-type": "application/json", "content-length": "2" }, "POST", "{}");
  expect([mcp.status, withProxy.mcpCalls, withProxy.seen.length]).toEqual([200, ["/mcp"], 0]);
  expect(() => createX402Proxy({ routeIds: ["r1"], childBaseUrl: "http://example.com:80", principalId: "judge", token: "public", sourceOf: () => "x" })).toThrow("loopback");
});
