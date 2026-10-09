import { expect, test } from "vitest";
import { createDaemonHandler } from "../../src/daemon/handler.js";
import { Session } from "../../src/daemon/session.js";
import { dispatchLine } from "../../src/daemon/server.js";
import type { DaemonContext } from "../../src/daemon/interfaces.js";

test("H-1 list_routes has no source.rail; bounded Base Sepolia route projects without exposing resource", async () => {
  const session = new Session(Buffer.alloc(32, 1));
  const context: DaemonContext = {
    session, address: `0x${"11".repeat(20)}`, phrase: "fixture", assertHeld() {},
    ledger: { rows: [], head: "", writeFailed: false, append() { throw new Error("no writes"); }, openSealed: () => undefined, close() {} },
    router: {
      async listRoutes() { return { ok: true, routes: [{ routeId: "md-mpp-eth-snapshot", resource: { url: "https://fixture.invalid", method: "GET" }, source: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "10000", decimals: 6 }, destination: { rail: "mpp", scheme: "tempo/charge", network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000" } }] }; },
      async quote() { return { ok: false, error: "rate_limited", reason: "rate_host", retryAfterMs: 3000 }; },
      async status() { return { kind: "not_found", reason: "not_found" }; },
    },
  };
  try {
    const handler = createDaemonHandler(context);
    expect(await dispatchLine('{"id":1,"method":"find_routes","params":{}}', handler)).toMatchObject({ ok: true, result: { routes: [{ pays: { rail: "x402", network: "eip155:84532" } }] } });
    expect(await dispatchLine('{"id":2,"method":"quote","params":{"routeId":"md-mpp-eth-snapshot"}}', handler)).toEqual({ id: 2, ok: false, error: { code: "rate_limited", reason: "rate_host", retryAfterMs: 3000 } });
    expect(await dispatchLine('{"id":3,"method":"purchase","params":{"ref":"p_aaaaaaaaaaa"}}', handler)).toMatchObject({ error: { code: "unknown_ref" } });
    const issued = createDaemonHandler(context, { hasRef: () => true, quote: async () => undefined, status: async () => undefined });
    expect(await dispatchLine('{"id":4,"method":"purchase","params":{"ref":"p_aaaaaaaaaaa"}}', issued)).toMatchObject({ error: { code: "approval_unavailable" } });
    session.close();
    expect(await dispatchLine('{"id":5,"method":"purchase","params":{"ref":"p_aaaaaaaaaaa"}}', issued)).toMatchObject({ error: { code: "locked" } });
  } finally { session.close(); }
});
