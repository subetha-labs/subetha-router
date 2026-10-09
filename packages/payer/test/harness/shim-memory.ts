import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createShim } from "../../src/shim/server.js";
import { createDaemonHandler } from "../../src/daemon/handler.js";
import { dispatchLine } from "../../src/daemon/server.js";
import { openLedger } from "../../src/store/ledger.js";
import { realFs } from "../../src/store/fs.js";
import { Session } from "../../src/daemon/session.js";
import { recordHash } from "../../src/daemon/record.js";
import type { DaemonContext } from "../../src/daemon/interfaces.js";
import { h1Quote } from "./router.js";

export async function shimMemory(body = { value: "x".repeat(2036) }) {
  const dir = mkdtempSync(path.join(tmpdir(), "shim-memory-")), key = randomBytes(32);
  const ledger = openLedger(path.join(dir, "ledger.ndjson"), key, realFs);
  const session = new Session(randomBytes(32)); const quote = h1Quote();
  const counts = { ui: 0, sign: 0, purchase: 0 };
  const context: DaemonContext = { session, ledger, address: `0x${"33".repeat(20)}`, phrase: "fixture-only", assertHeld() {},
    purchase: { routerUrl: "https://fixture.invalid/mcp", canonicalResource: { ...quote.quote.resource, method: "GET" }, generateRef: () => "p_aaaaaaaaaaaaa",
      ui: { available: async () => true, confirm: async r => { counts.ui++; return { approved: true, recordHash: recordHash(r), uiKind: "native" }; } },
      signer: { sign: async () => { counts.sign++; return "fixture-credential"; } } },
    router: { listRoutes: async () => ({ ok: true, routes: [{ routeId: quote.quote.routeId, source: quote.quote.source, destination: quote.quote.destination }] }),
      quote: async () => quote, status: async () => ({ kind: "not_found", reason: "not_found" }),
      purchase: async () => { counts.purchase++; return { ok: true, outcome: "delivered", paymentId: quote.quote.paymentId, snapshot: body, contentType: "application/json" }; } },
  };
  const handler = createDaemonHandler(context); let id = 0;
  const shim = createShim({ request: async (method, params) => {
    const response: any = await dispatchLine(JSON.stringify({ id: ++id, method, params }), handler);
    return response.ok ? response.result : { ok: false, error: response.error.code };
  }, async close() {} });
  const client = new Client({ name: "fixture", version: "1.0.0" });
  const [a,b] = InMemoryTransport.createLinkedPair(); await shim.connect(a); await client.connect(b); await client.listTools();
  return { client, context, counts, async close() { await client.close(); await shim.close(); session.close(); ledger.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); } };
}
export function modelBytes(results: any[]): number {
  return results.reduce((sum, r) => sum + r.content.reduce((n: number, c: any) => n + (c.type === "text" ? Buffer.byteLength(c.text, "utf8") : 0), 0) + Buffer.byteLength(JSON.stringify(r.structuredContent), "utf8"), 0);
}
