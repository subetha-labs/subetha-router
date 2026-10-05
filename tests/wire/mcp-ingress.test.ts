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

import { readFileSync } from "node:fs";

import { createMcpIngress, DEFAULT_MCP_INGRESS_LIMITS, type McpIngressLimits } from "../../src/mcp/ingress.js";
import { guarded } from "../../src/mcp/server.js";

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

test("POST の JSON は処理に渡る。JSON でない本文・空の本文は固定文の 400 で、処理に渡らない", async () => {
  const harness = await start();
  expect(statusOf((await raw(harness.port, (s) => s.write(post('{"jsonrpc":"2.0","id":1}')))).text)).toBe(200);
  for (const body of ["not json {\"secret\":1}", ""]) {
    const result = await raw(harness.port, (s) => s.write(post(body)));
    expect(statusOf(result.text)).toBe(400);
    expect(result.text).toContain('{"error":"invalid_json"}');
    // 解析エラーの文字列（入力の断片を含む）を返さない。
    expect(result.text).not.toContain("secret");
    expect(result.text).not.toContain("Unexpected");
  }
  expect(harness.handled).toEqual([{ jsonrpc: "2.0", id: 1 }]);
});

test("GET の stream は出さない（405）。DELETE は処理に渡る。他の method は 405", async () => {
  const harness = await start();
  const get = await raw(harness.port, (s) =>
    s.write("GET /mcp HTTP/1.1\r\nHost: x\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n"),
  );
  expect(statusOf(get.text)).toBe(405);
  expect(get.text.toLowerCase()).toContain("allow: post, delete");
  expect(statusOf((await raw(harness.port, (s) => s.write("OPTIONS /mcp HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"))).text)).toBe(405);
  expect(statusOf((await raw(harness.port, (s) => s.write("PUT /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}"))).text)).toBe(405);
  expect(harness.handled).toEqual([]);
  expect(statusOf((await raw(harness.port, (s) => s.write("DELETE /mcp HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"))).text)).toBe(200);
  expect(harness.handled).toEqual([undefined]);
});

test("mcp-protocol-version が日付の形でなければ、値を写さずに固定文の 400", async () => {
  const harness = await start();
  const marker = "<script>reflect-me</script>";
  const result = await raw(harness.port, (s) => s.write(post("{}", `MCP-Protocol-Version: ${marker}\r\n`)));
  expect(statusOf(result.text)).toBe(400);
  expect(result.text).toContain('{"error":"unsupported_protocol_version"}');
  expect(result.text).not.toContain("reflect-me");
  expect(harness.handled).toEqual([]);
  // 日付の形なら処理に渡す（対応しているかどうかは SDK が決める）。
  expect(statusOf((await raw(harness.port, (s) => s.write(post("{}", "MCP-Protocol-Version: 2025-06-18\r\n")))).text)).toBe(200);
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

test("本文を読まずに終える経路（別のパス・GET）に巨大な本文を付けても、読まずに閉じる", async () => {
  const harness = await start({ maxBodyBytes: 1024, receiveTimeoutMs: 5_000 });
  for (const head of [
    "POST /other HTTP/1.1\r\nHost: x\r\nContent-Length: 10000000\r\n\r\n",
    "GET /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 10000000\r\n\r\n",
    "GET /healthz HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n",
  ]) {
    const result = await raw(harness.port, (s) => s.write(head));
    expect([404, 405]).toContain(statusOf(result.text));
    expect(result.text.toLowerCase()).toContain("connection: close");
    expect(result.closed, head).toBe(true);
    expect(result.elapsedMs).toBeLessThan(2_500);
  }
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

test("拒否の応答は、同じ接続で先に処理中の応答の後ろに正しく届く（すぐ切って消さない）", async () => {
  let release: (() => void) | undefined;
  const harness = await start({ maxBodyBytes: 1024 }, async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const result = await raw(harness.port, async (socket) => {
    // 1 件目（処理に 300 ms かかる）に続けて、上限を超える 2 件目を同じ接続で送る。
    socket.write(post('{"first":true}').replace("Connection: close\r\n", ""));
    socket.write("POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 999999\r\n\r\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    release?.();
  });
  const statuses = [...result.text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]));
  expect(statuses).toEqual([200, 413]);
  expect(result.text).toContain('{"handled":true}');
  expect(result.text).toContain('{"error":"body_too_large"}');
  expect(result.closed).toBe(true);
});

test("少しずつ送り続けても、期限は延びない（受信全体の期限）", async () => {
  const harness = await start({ receiveTimeoutMs: 400 });
  const result = await raw(harness.port, async (socket) => {
    socket.write("POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n");
    for (let i = 0; i < 100 && !socket.destroyed; i += 1) {
      socket.write("a");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 4_000);
  expect(statusOf(result.text)).toBe(408);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(350);
  expect(result.elapsedMs).toBeLessThan(1_500);
  expect(harness.handled).toEqual([]);
});

test("1 バイトも送らない接続も切られる", async () => {
  const harness = await start({ receiveTimeoutMs: 300 });
  const result = await raw(harness.port, () => {}, 5_000);
  expect(result.closed).toBe(true);
  expect(result.elapsedMs).toBeLessThan(4_000);
  expect(harness.handled).toEqual([]);
});

test("受信の期限は応答の時間を縛らない。接続の使い回しも期限を超えて続けられる", async () => {
  const harness = await start({ receiveTimeoutMs: 300 }, async (body) => {
    if ((body as { slow?: boolean }).slow === true) await new Promise((resolve) => setTimeout(resolve, 900));
  });
  // 応答に 900 ms かかる要求（受信の期限 300 ms の 3 倍）。
  const slow = await raw(harness.port, (s) => s.write(post('{"slow":true}')), 4_000);
  expect(statusOf(slow.text)).toBe(200);
  expect(slow.elapsedMs).toBeGreaterThanOrEqual(850);
  // 同じ接続で、期限より長い間隔を空けて 3 回。
  const reused = await raw(harness.port, async (socket) => {
    const keepAlive = post('{"n":1}').replace("Connection: close\r\n", "");
    for (let i = 0; i < 3; i += 1) {
      socket.write(keepAlive);
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    socket.end();
  }, 4_000);
  expect([...reused.text.matchAll(/HTTP\/1\.1 200/g)]).toHaveLength(3);
});

test("要求 1 件が接続を使える時間に上限がある（応答を待たせ続ける処理・読まない相手で枠を持ち続けられない）", async () => {
  const harness = await start({ maxRequestMs: 400 }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  });
  const result = await raw(harness.port, (s) => s.write(post("{}")), 4_000);
  expect(result.closed).toBe(true);
  expect(result.elapsedMs).toBeGreaterThanOrEqual(350);
  expect(result.elapsedMs).toBeLessThan(2_000);
  expect(harness.notes).toEqual(["mcp ingress: request exceeded its lifetime"]);
});

test("Expect: 100-continue の正当な要求は通る", async () => {
  const harness = await start();
  const body = '{"jsonrpc":"2.0","id":7}';
  const result = await raw(harness.port, async (socket) => {
    socket.write(`POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.write(body);
  });
  expect(result.text).toContain("HTTP/1.1 100 Continue");
  expect(result.text).toContain("HTTP/1.1 200");
  expect(harness.handled).toEqual([{ jsonrpc: "2.0", id: 7 }]);
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
  expect(result.elapsedMs).toBeLessThan(1_000);
  expect(harness.handled).toEqual([]);
});

test("ヘッダが期限までに届かない接続も切られる", async () => {
  const harness = await start({ receiveTimeoutMs: 300 });
  const result = await raw(harness.port, (s) => s.write("POST /mcp HTTP/1.1\r\nHost: x\r\n"), 5_000);
  expect(result.closed).toBe(true);
  // 期限 300 ms ＋ Node の検査間隔（ここでは 150 ms）の範囲。
  expect(result.elapsedMs).toBeLessThan(1_500);
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

test("既存の正当な要求の大きさ（実測）: quote・purchase・status は既定の上限に十分収まる", async () => {
  /**
   * 実際の MCP クライアントが送る要求の本文の大きさを、入口で数える。
   * quote 文書は**本番で実際に発行された** MPP 経路のもの（`tests/fixtures/data/static-mpp-quote.json`。
   * challenge の全文を持つので x402 経路より大きい）。credential は本番で通ったものと同じ長さ（3537 文字）の詰め物。
   */
  const quote = JSON.parse(readFileSync("tests/fixtures/data/static-mpp-quote.json", "utf8")) as Record<string, unknown>;
  const sizes = new Map<string, number>();
  const server = createMcpIngress({
    handle: async (request, response, body) => {
      const call = body as { method?: string; params?: { name?: string } };
      if (call.method === "tools/call" && typeof call.params?.name === "string") {
        sizes.set(call.params.name, Number(request.headers["content-length"]));
      }
      const mcp = new McpServer({ name: "size-test", version: "0.0.1" });
      const ok = async (): Promise<{ content: { type: "text"; text: string }[] }> => ({ content: [{ type: "text", text: "ok" }] });
      // 本番の tool と同じ名前・同じ引数の形（`src/mcp/server.ts`）。
      mcp.registerTool("subetha_router_quote", { description: "q", inputSchema: { routeId: z.string(), requestId: z.string() } }, ok);
      mcp.registerTool(
        "subetha_router_purchase",
        { description: "p", inputSchema: { quoteId: z.string(), requestId: z.string(), approval: z.string().optional(), quote: z.unknown().optional(), credential: z.string().optional() } },
        ok,
      );
      mcp.registerTool("subetha_router_status", { description: "s", inputSchema: { paymentId: z.string() } }, ok);
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
  const call = async (name: string, args: Record<string, unknown>): Promise<void> => {
    const client = new Client({ name: "size-test-client", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)) as never);
    try {
      await client.callTool({ name, arguments: args });
    } finally {
      await client.close();
    }
  };
  const requestId = "purpose-of-this-purchase-20261005T081000Z";
  await call("subetha_router_quote", { routeId: quote["routeId"], requestId });
  await call("subetha_router_purchase", { quoteId: quote["quoteId"], requestId, approval: quote["quoteId"], quote, credential: "c".repeat(3537) });
  await call("subetha_router_status", { paymentId: quote["paymentId"] });

  const measured = Object.fromEntries(sizes);
  // 実測の記録（バイト）。変わったら、上限に対する余裕を見直す。
  expect(measured).toEqual({ subetha_router_quote: 190, subetha_router_purchase: 5845, subetha_router_status: 153 });
  for (const bytes of sizes.values()) {
    expect(bytes).toBeLessThan(DEFAULT_MCP_INGRESS_LIMITS.maxBodyBytes / 8);
  }
});

test("tool の処理が例外を投げても、結果とログに例外の文字列を出さない", async () => {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let result: Awaited<ReturnType<typeof guarded>>;
  try {
    result = await guarded(async () => {
      throw new Error("upstream https://internal.example/secret?token=abc123 failed");
    });
  } finally {
    process.stderr.write = original;
  }
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toEqual({ ok: false, error: "internal_error" });
  expect(JSON.stringify(result)).not.toContain("internal.example");
  expect(written.join("")).toBe("subetha-router MCP tool failed\n");
  // 正常な結果はそのまま通る。
  expect((await guarded(async () => ({ ok: true }))).structuredContent).toEqual({ ok: true });
});

test("本番の入口（tools/remote-mcp.ts）は例外の文字列をログに出さない（静的検査）", () => {
  const source = readFileSync("tools/remote-mcp.ts", "utf8");
  expect(source).not.toMatch(/error\.message/);
  expect(source).not.toMatch(/\$\{\s*error\b/);
  expect(source).not.toMatch(/String\(error\)/);
  // 入口は `createMcpIngress` を通る（自前の HTTP サーバを作らない）。
  expect(source).toContain("createMcpIngress(");
  expect(source).not.toMatch(/createServer\(/);
});

test("既定値は設計どおり: 本文 64 KiB・受信 10 秒・同時接続 64・要求 1 件 120 秒", () => {
  expect(DEFAULT_MCP_INGRESS_LIMITS).toEqual({ maxBodyBytes: 65_536, receiveTimeoutMs: 10_000, maxConnections: 64, maxRequestMs: 120_000 });
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
