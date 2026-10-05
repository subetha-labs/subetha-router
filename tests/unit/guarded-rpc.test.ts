/**
 * SSRF 防御 A の RPC transport（設計 §3.5 経路 11・12、実装レビュー #3 の指摘 1）: 内部の期限は transport だけが持つ。
 */
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGuardedTransport, type TransportEvent } from "../../src/net/guarded-fetch.js";
import { guardedRpcTransport } from "../../src/net/guarded-rpc.js";

const servers: http.Server[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type TransportObject = {
  config: { timeout: number; retryCount: number; type: string; key: string };
  value: { url: string; fetchOptions?: { headers?: Record<string, string> } };
  request: (args: { method: string; params?: unknown }) => Promise<unknown>;
};

describe("guardedRpcTransport", () => {
  it("viem 自身の timeout は 0（無効）で、期限は transport だけが持つ。retryCount 0、URL と fetchOptions（認証ヘッダ）を引き継ぐ", () => {
    const transport = createGuardedTransport({ allowLoopback: true, report: () => {} });
    const factory = guardedRpcTransport(transport, "http://127.0.0.1:1/rpc", () => ({ operation: "rpc" }), {
      timeout: 123,
      fetchOptions: { headers: { authorization: "Bearer test" } },
    });
    const t = factory({} as never) as unknown as TransportObject;
    expect(t.config.timeout).toBe(0);
    expect(t.config.retryCount).toBe(0);
    expect([t.config.type, t.config.key]).toEqual(["http", "http"]);
    expect(t.value.url).toBe("http://127.0.0.1:1/rpc");
    expect(t.value.fetchOptions?.headers).toEqual({ authorization: "Bearer test" });
  });

  it("headers が来ない停滞は transport の期限で終わり upstream_timeout（viem の AbortError に化けない）。要求は 1 本、認証ヘッダ付き", async () => {
    let connections = 0;
    const seenAuth: string[] = [];
    const server = http.createServer((request) => {
      seenAuth.push(request.headers.authorization ?? "");
      // 応答しない（headers の停滞）
    });
    servers.push(server);
    server.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const events: TransportEvent[] = [];
    const transport = createGuardedTransport({ allowLoopback: true, report: (event) => events.push(event) });
    const factory = guardedRpcTransport(transport, `http://127.0.0.1:${port}/`, () => ({ operation: "rpc", routeId: "r" }), {
      timeout: 200,
      fetchOptions: { headers: { authorization: "Bearer test" } },
    });
    const t = factory({} as never) as unknown as TransportObject;
    const t0 = Date.now();
    await expect(t.request({ method: "eth_chainId" })).rejects.toBeDefined();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(events).toEqual([{ code: "upstream_timeout", operation: "rpc", routeId: "r", policy: expect.any(String) }]);
    expect(connections).toBe(1);
    expect(seenAuth).toEqual(["Bearer test"]);
  });
});
