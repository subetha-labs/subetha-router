/**
 * 入口の drain の数え方と断り方（`docs/rejection-reasons-design.md` §13.3、タスク R-0）。実 TCP（loopback）で、MCP の処理本体は stub。
 * - 1 件は「処理（`handle`）の終わり」と「応答の close」の両方が来るまで数に残る（相手が切っても、処理が続く間は残る）
 * - `close()` の後の要求は数えずに 503 `draining`（接続を閉じる）
 * - `idle(ms)` は 0 になれば true、上限で false
 */
import { once } from "node:events";
import type { Server } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, test } from "vitest";

import { createIngressDrain, createMcpIngress, type IngressDrain } from "../../src/mcp/ingress.js";

const servers: Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** `handle` は `release()` が呼ばれるまで終わらない（その後 200 を書く）。 */
async function start(drain: IngressDrain): Promise<{ port: number; release: () => void; entered: () => number }> {
  let releaseAll: () => void = () => {};
  const gate = new Promise<void>((resolve) => (releaseAll = resolve));
  let entered = 0;
  const server = createMcpIngress({
    drain,
    handle: async (_request, response) => {
      entered += 1;
      await gate;
      if (!response.destroyed) response.writeHead(200, { "content-type": "application/json" }).end("{}");
    },
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { port: (server.address() as AddressInfo).port, release: () => releaseAll(), entered: () => entered };
}

const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

async function send(port: number): Promise<{ socket: net.Socket; text: () => string }> {
  const socket = net.connect(port, "127.0.0.1");
  sockets.push(socket);
  await once(socket, "connect");
  let text = "";
  socket.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  socket.on("error", () => {});
  socket.write(`POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(BODY)}\r\n\r\n${BODY}`);
  return { socket, text: () => text };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await delay(10);
}

test("進行中の要求は handle が終わり応答が閉じるまで数え、終われば idle が true", async () => {
  const drain = createIngressDrain();
  const h = await start(drain);
  const a = await send(h.port);
  await until(() => h.entered() === 1);
  expect(drain.inFlight()).toBe(1);
  drain.close();
  const idle = drain.idle(5_000);
  h.release();
  expect(await idle).toBe(true);
  expect(drain.inFlight()).toBe(0);
  await until(() => a.text().includes("\r\n\r\n"));
  expect(a.text().split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
});

test("相手が切っても handle が続く間は数に残る（idle は上限で false）。handle が終われば 0", async () => {
  const drain = createIngressDrain();
  const h = await start(drain);
  const a = await send(h.port);
  await until(() => h.entered() === 1);
  a.socket.destroy();
  await delay(100);
  expect(drain.inFlight()).toBe(1);
  expect(await drain.idle(300)).toBe(false);
  h.release();
  await until(() => drain.inFlight() === 0);
  expect(drain.inFlight()).toBe(0);
  expect(await drain.idle(10)).toBe(true);
});

test("close() の後の要求は数えずに 503 draining（Connection: close）。handle は呼ばれない", async () => {
  const drain = createIngressDrain();
  const h = await start(drain);
  drain.close();
  const b = await send(h.port);
  await until(() => b.text().includes("draining"));
  expect(b.text().split("\r\n")[0]).toBe("HTTP/1.1 503 Service Unavailable");
  expect(b.text().toLowerCase()).toContain("connection: close");
  expect(b.text()).toContain('{"error":"draining"}');
  expect(h.entered()).toBe(0);
  expect(drain.inFlight()).toBe(0);
  expect(await drain.idle(10)).toBe(true);
});

test("drain を渡さない入口は今までどおり（数えない・断らない）", async () => {
  const server = createMcpIngress({ handle: async (_request, response) => void response.writeHead(200).end("{}") });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const r = await send((server.address() as AddressInfo).port);
  await until(() => r.text().includes("\r\n\r\n"));
  expect(r.text().split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
});
