/**
 * R-1 / AC-R6b (docs/payer-rails-design.md SR-R5): the daemon's Tempo RPC transport is the Router's guarded transport
 * (vendored) wrapped as `typeof fetch`, with a 64 KiB body bound of its own. Production refuses loopback; the fixture
 * server below is reached only through an injected transport built with `allowLoopback: true` (never a product switch).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";

import { createGuardedFetch, productionTransport, RPC_RESPONSE_MAX_BYTES } from "../../src/sign/transport.js";
import { createGuardedTransport, TransportError, type TransportEvent } from "../../src/vendor/guarded-fetch.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}
function fixtureFetch(events: TransportEvent[] = []): typeof fetch {
  return createGuardedFetch(createGuardedTransport({ allowLoopback: true, report: (event) => events.push(event), dns: { timeoutMs: 1_000, maxInFlight: 2 } }));
}

describe("createGuardedFetch", () => {
  test("passes method, headers and body through; returns the original status and headers with the bounded body (viem reads JSON)", async () => {
    const seen: { method: string | undefined; contentType: string | undefined; body: string }[] = [];
    const url = await serve(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk;
      seen.push({ method: request.method, contentType: request.headers["content-type"], body });
      response.writeHead(200, { "content-type": "application/json", "x-fixture": "yes" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 7, result: "0xa5bf" }));
    });
    const response = await fixtureFetch()(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-fixture")).toBe("yes");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: "0xa5bf" });
    expect(seen).toEqual([{ method: "POST", contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "eth_chainId", params: [] }) }]);
  });

  test("a body over 64 KiB fails the call (never truncated), whether declared by content-length or streamed; exactly 64 KiB passes", async () => {
    expect(RPC_RESPONSE_MAX_BYTES).toBe(65_536);
    let mode: "declared" | "streamed" | "exact" = "declared";
    const url = await serve((_request, response) => {
      if (mode === "declared") { response.writeHead(200, { "content-length": String(RPC_RESPONSE_MAX_BYTES + 1) }); response.end(Buffer.alloc(RPC_RESPONSE_MAX_BYTES + 1, 0x61)); return; }
      if (mode === "exact") { response.writeHead(200); response.end(Buffer.alloc(RPC_RESPONSE_MAX_BYTES, 0x61)); return; }
      // chunked, no content-length: the bound must come from reading, not from the header
      response.writeHead(200, { "transfer-encoding": "chunked" });
      response.write(Buffer.alloc(RPC_RESPONSE_MAX_BYTES, 0x61));
      response.write(Buffer.alloc(1, 0x61));
      response.end();
    });
    const fetchFn = fixtureFetch();
    await expect(fetchFn(url, { method: "POST", body: "{}" })).rejects.toThrow(/^rpc_response_too_large$/);
    mode = "streamed";
    await expect(fetchFn(url, { method: "POST", body: "{}" })).rejects.toThrow(/^rpc_response_too_large$/);
    mode = "exact";
    const ok = await fetchFn(url, { method: "POST", body: "{}" });
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(RPC_RESPONSE_MAX_BYTES);
  });

  test("redirects are refused (no second destination), and a stalled server ends at the caller's deadline", async () => {
    const events: TransportEvent[] = [];
    let stall = false;
    const url = await serve((_request, response) => {
      if (stall) return; // never answers
      response.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
      response.end();
    });
    const fetchFn = fixtureFetch(events);
    await expect(fetchFn(url, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(TransportError);
    stall = true;
    const t0 = Date.now();
    await expect(fetchFn(url, { method: "POST", body: "{}", signal: AbortSignal.timeout(300) })).rejects.toBeInstanceOf(TransportError);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(events.map((event) => event.operation)).toEqual(["rpc", "rpc"]);
    expect(events.map((event) => event.routeId)).toEqual(["tempo", "tempo"]);
    // undici surfaces a refused redirect as a generic fetch failure; the transport classifies it as transport_failed (no code of its own).
    expect(events.map((event) => event.code)).toEqual(["transport_failed", "upstream_timeout"]);
  });

  test("production transport: loopback, private and own-address destinations are refused before any connection; non-http schemes too", async () => {
    const url = await serve((_request, response) => { response.writeHead(200); response.end("reached"); });
    let connections = 0;
    servers[0]!.on("connection", () => { connections += 1; });
    const fetchFn = createGuardedFetch();
    await expect(fetchFn(url, { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "destination_blocked" });
    await expect(fetchFn("http://localhost:1/", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(TransportError);
    await expect(fetchFn("http://10.0.0.1:1/", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "destination_blocked" });
    await expect(fetchFn("http://[::1]:1/", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "destination_blocked" });
    await expect(fetchFn("ftp://rpc.example/", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "destination_blocked" });
    await expect(fetchFn("https://user:pw@rpc.example/", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "destination_blocked" });
    expect(connections).toBe(0);
    // A name resolving to loopback is refused as well (the DNS answer is what is vetted, not the spelling).
    const pinned = createGuardedFetch(createGuardedTransport({ allowLoopback: false, report: () => {}, dns: { timeoutMs: 1_000, maxInFlight: 2 },
      lookup: (_hostname, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]) }));
    await expect(pinned("http://rpc.example/", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "destination_blocked" });
    expect(connections).toBe(0);
    expect(productionTransport()).toMatchObject({ allowLoopback: false, boundsDns: true });
  });

  test("the production entry never enables loopback: `createGuardedFetch()` is the only form the daemon uses", async () => {
    const { readFileSync } = await import("node:fs");
    const startup = readFileSync(new URL("../../src/daemon/startup.ts", import.meta.url), "utf8");
    expect(startup).toContain("fetchFn: createGuardedFetch()");
    expect(startup).not.toContain("allowLoopback");
    const transport = readFileSync(new URL("../../src/sign/transport.ts", import.meta.url), "utf8");
    const code = transport.split("\n").filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("/")).join("\n");
    expect(code.match(/allowLoopback: (true|false)/g)).toEqual(["allowLoopback: false"]);
  });
});
