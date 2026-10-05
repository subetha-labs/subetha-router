/**
 * リモート MCP の入口の資源上限（設計 `docs/dynamic-upstream-design.md` §7.1、タスク T12）。
 * 実 TCP（loopback）で確かめる。MCP の処理本体は stub。
 */

import { once } from "node:events";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";

import { createMcpIngress, DEFAULT_MCP_INGRESS_LIMITS, type McpIngressLimits } from "../../src/mcp/ingress.js";

interface Harness {
  readonly port: number;
  readonly handled: unknown[];
  readonly notes: string[];
}

const servers: Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function start(
  limits: Partial<McpIngressLimits> = {},
  handle?: (body: unknown) => Promise<void>,
): Promise<Harness> {
  const handled: unknown[] = [];
  const notes: string[] = [];
  const server = createMcpIngress({
    limits: { ...DEFAULT_MCP_INGRESS_LIMITS, ...limits },
    note: (message) => notes.push(message),
    handle: async (_request, response, body) => {
      handled.push(body);
      if (handle !== undefined) await handle(body);
      const text = JSON.stringify({ handled: true });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      response.end(text);
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, handled, notes };
}

/** 生の TCP で要求を書き、応答の全文（接続が閉じるか `until` を満たすまで）を返す。 */
async function raw(
  port: number,
  write: (socket: net.Socket) => unknown,
  waitMs = 3_000,
): Promise<{ text: string; closed: boolean; elapsedMs: number }> {
  const socket = net.connect(port, "127.0.0.1");
  sockets.push(socket);
  await once(socket, "connect");
  const startedAt = Date.now();
  let text = "";
  let closed = false;
  socket.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  socket.on("error", () => {});
  const done = new Promise<void>((resolve) => {
    socket.on("close", () => {
      closed = true;
      resolve();
    });
  });
  void Promise.resolve(write(socket)).catch(() => {});
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, waitMs))]);
  return { text, closed, elapsedMs: Date.now() - startedAt };
}

function statusOf(text: string): number {
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? "0");
}

function post(body: string, extra = ""): string {
  return `POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}Connection: close\r\n\r\n${body}`;
}

test("通常の要求は JSON として処理に渡る。JSON でない本文と空の本文は undefined", async () => {
  const harness = await start();
  expect(statusOf((await raw(harness.port, (s) => s.write(post('{"jsonrpc":"2.0","id":1}')))).text)).toBe(200);
  expect(statusOf((await raw(harness.port, (s) => s.write(post("not json")))).text)).toBe(200);
  expect(statusOf((await raw(harness.port, (s) => s.write(post("")))).text)).toBe(200);
  expect(harness.handled).toEqual([{ jsonrpc: "2.0", id: 1 }, undefined, undefined]);
});

test("healthz は従来どおり。それ以外のパスは 404 で、処理に渡らない", async () => {
  const harness = await start();
  const health = await raw(harness.port, (s) => s.write("GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
  expect(statusOf(health.text)).toBe(200);
  expect(health.text).toContain('{"status":"ok","router":"up"}');
  const other = await raw(harness.port, (s) => s.write(post("{}").replace("/mcp", "/other")));
  expect(statusOf(other.text)).toBe(404);
  expect(harness.handled).toEqual([]);
});

test("申告された長さが上限を超える要求は、本文を 1 バイトも待たずに 413", async () => {
  const harness = await start({ maxBodyBytes: 1024, receiveTimeoutMs: 5_000 });
  // 本文は送らない。長さの申告だけで拒否されること（待っていれば 5 秒かかる）。
  const result = await raw(harness.port, (s) =>
    s.write("POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1025\r\n\r\n"),
  );
  expect(statusOf(result.text)).toBe(413);
  expect(result.text).toContain('{"error":"body_too_large"}');
  expect(result.elapsedMs).toBeLessThan(2_000);
  expect(result.closed).toBe(true);
  expect(harness.handled).toEqual([]);
});

test("ちょうど上限の本文は通り、1 バイト超えると 413", async () => {
  const harness = await start({ maxBodyBytes: 1024 });
  const exact = JSON.stringify({ pad: "a".repeat(1024 - 10) });
  expect(Buffer.byteLength(exact)).toBe(1024);
  expect(statusOf((await raw(harness.port, (s) => s.write(post(exact)))).text)).toBe(200);
  const over = JSON.stringify({ pad: "a".repeat(1024 - 9) });
  expect(statusOf((await raw(harness.port, (s) => s.write(post(over)))).text)).toBe(413);
  expect(harness.handled).toHaveLength(1);
});

test("長さを申告しない（chunked）本文も、上限を超えた時点で読み切らずに 413", async () => {
  const harness = await start({ maxBodyBytes: 1024, receiveTimeoutMs: 5_000 });
  let written = 0;
  const result = await raw(harness.port, async (socket) => {
    socket.write("POST /mcp HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n");
    const chunk = "a".repeat(256);
    // 上限の 100 倍を送ろうとする。途中で切られるはず。
    for (let i = 0; i < 400 && !socket.destroyed; i += 1) {
      socket.write(`${chunk.length.toString(16)}\r\n${chunk}\r\n`);
      written += chunk.length;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  });
  expect(statusOf(result.text)).toBe(413);
  expect(result.closed).toBe(true);
  // 全部（102400 バイト）を受け取る前に切れている。
  expect(written).toBeLessThan(400 * 256);
  expect(harness.handled).toEqual([]);
});

test("本文が期限までに届かない要求は 408 で切る", async () => {
  const harness = await start({ receiveTimeoutMs: 300 });
  const result = await raw(harness.port, (s) =>
    // 10 バイト申告して 3 バイトだけ送り、止まる。
    s.write("POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{\"a"),
  );
  expect(statusOf(result.text)).toBe(408);
  expect(result.text).toContain('{"error":"request_timeout"}');
  expect(result.closed).toBe(true);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(250);
  expect(result.elapsedMs).toBeLessThan(2_500);
  expect(harness.handled).toEqual([]);
});

test("ヘッダが期限までに届かない接続も切られる", async () => {
  const harness = await start({ receiveTimeoutMs: 300 });
  const result = await raw(harness.port, (s) => s.write("POST /mcp HTTP/1.1\r\nHost: x\r\n"), 5_000);
  expect(result.closed).toBe(true);
  expect(result.elapsedMs).toBeLessThan(4_000);
  expect(harness.handled).toEqual([]);
});

test("同時接続数の上限を超えた接続は受け付けない", async () => {
  const harness = await start({ maxConnections: 2, receiveTimeoutMs: 5_000 });
  const hold = async (): Promise<net.Socket> => {
    const socket = net.connect(harness.port, "127.0.0.1");
    sockets.push(socket);
    socket.on("error", () => {});
    await once(socket, "connect");
    // ヘッダの途中で止めて接続を持ち続ける。
    socket.write("POST /mcp HTTP/1.1\r\nHost: x\r\n");
    return socket;
  };
  await hold();
  await hold();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const third = await raw(harness.port, (s) => s.write(post("{}")), 1_500);
  expect(third.closed).toBe(true);
  expect(statusOf(third.text)).toBe(0);
  expect(harness.handled).toEqual([]);
});

test("処理が例外を投げても、応答とログに例外の文字列を出さない", async () => {
  const secret = "https://internal.example/secret?token=abc123";
  const harness = await start({}, async () => {
    throw new Error(`upstream ${secret} failed`);
  });
  const result = await raw(harness.port, (s) => s.write(post("{}")));
  expect(statusOf(result.text)).toBe(500);
  expect(result.text).toContain('{"error":"internal_error"}');
  expect(result.text).not.toContain("internal.example");
  expect(harness.notes).toEqual(["mcp ingress: request failed"]);
  expect(harness.notes.join("\n")).not.toContain("abc123");
});

test("既存の正当な要求（purchase が最大）は既定の上限に十分収まる", async () => {
  // 本番で実際に通った MPP 経路の purchase と同じ形・同じ大きさ（quote 文書 約 3.3 KiB、credential 約 3.5 KiB）。
  // MPP の quote は challenge 全文を持つので、x402 経路より大きい。
  const challenge = `Payment id="${"q".repeat(43)}", realm="MPP Payment", method="tempo", intent="charge", request="${"r".repeat(240)}", expires="2026-10-05T08:19:11.992Z", opaque="${"o".repeat(380)}"`;
  const offer = {
    scheme: "tempo/charge",
    network: "eip155:42431",
    asset: `0x${"20c0".padEnd(40, "0")}`,
    amount: "10000",
    payTo: `0x${"9b".repeat(20)}`,
    maxTimeoutSeconds: 600,
    extra: { challengeNonce: "q".repeat(43), expiresAt: 1791188351, routeBinding: "md-x402-eth-snapshot|GET|%2Fv1%2Froutes%2Fmd-x402-eth-snapshot%2Fresource", fundsMoveOnCredential: true, challenge },
  };
  const quote = {
    quoteId: "q".repeat(43),
    paymentId: "f8ac1789-445e-45d4-a313-853683e4c09c",
    routeId: "md-x402-eth-snapshot",
    resource: { url: "http://127.0.0.1:8500/v1/routes/md-x402-eth-snapshot/resource", method: "GET" },
    source: { rail: "mpp", amount: "10000", asset: offer.asset, decimals: 6, network: offer.network, payTo: offer.payTo, expiresAt: 1791188351, offer },
    destination: { rail: "x402", quoted: "10000", asset: `0x${"03".repeat(20)}`, network: "eip155:84532", quoteFingerprint: `sha256:${"1".repeat(64)}` },
    approval: { required: true, boundTo: "q".repeat(43), deadlineMs: 1791188351000 },
  };
  const request = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "subetha_router_purchase",
      arguments: { quoteId: quote.quoteId, requestId: "purpose-20261005T0810", approval: quote.quoteId, quote, credential: "c".repeat(3600) },
    },
  });
  const bytes = Buffer.byteLength(request);
  // 実測の記録: 約 6 KiB。上限 64 KiB の 1/8 以下。
  expect(bytes).toBeGreaterThan(5_000);
  expect(bytes).toBeLessThan(DEFAULT_MCP_INGRESS_LIMITS.maxBodyBytes / 8);
  const harness = await start();
  expect(statusOf((await raw(harness.port, (s) => s.write(post(request)))).text)).toBe(200);
  expect(harness.handled).toHaveLength(1);
});

test("既定値は設計どおり: 本文 64 KiB・受信 10 秒・同時接続 64", () => {
  expect(DEFAULT_MCP_INGRESS_LIMITS).toEqual({ maxBodyBytes: 65_536, receiveTimeoutMs: 10_000, maxConnections: 64 });
});

test("実際の MCP（Streamable HTTP・ステートレス）が入口越しに tool を呼べる", async () => {
  // 本番の入口（`tools/remote-mcp.ts`）と同じ配線: 要求ごとに server と transport を作り、入口が読んだ本文を渡す。
  const server = createMcpIngress({
    handle: async (request, response, body) => {
      const mcp = new McpServer({ name: "ingress-test", version: "0.0.1" });
      mcp.registerTool("echo", { description: "echo", inputSchema: { text: z.string() } }, async (args) => ({
        content: [{ type: "text", text: args.text }],
        structuredContent: { text: args.text },
      }));
      // SDK の型は `exactOptionalPropertyTypes` と合わない（本番の入口は `tools/` にあり型検査の対象外）。
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
      response.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport as never);
      await transport.handleRequest(request, response, body);
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const port = (server.address() as AddressInfo).port;

  const call = async (text: string): Promise<unknown> => {
    const client = new Client({ name: "ingress-test-client", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)) as never);
    try {
      return (await client.callTool({ name: "echo", arguments: { text } })).structuredContent;
    } finally {
      await client.close();
    }
  };
  expect(await call("hello")).toEqual({ text: "hello" });
  // 上限に近い大きさの引数も通る（6 KiB の実際の要求の 8 倍）。
  const large = "x".repeat(48 * 1024);
  expect(await call(large)).toEqual({ text: large });
  // 上限を超える引数は tool に届かない。
  await expect(call("x".repeat(70 * 1024))).rejects.toThrow();
});
