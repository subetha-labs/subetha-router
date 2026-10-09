import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { RouterClient, STATIC_ROUTE } from "../../src/router/client.js";
import { fixtureStore } from "../harness/store.js";
import { ownedChild, tsxLoader } from "../harness/children.js";
import { socketClient } from "../harness/daemon.js";
import { fakeRouter } from "../harness/router.js";

const entry = fileURLToPath(new URL("../harness/daemon-test-entry.ts", import.meta.url));
async function setup(cancel = false) {
  const fake = await fakeRouter(); const store = fixtureStore(fake.url.href);
  const child = ownedChild(["--disable-sigusr1", "--import", tsxLoader, entry], store.home);
  child.child.send({ home: store.home, installRoot: store.installRoot, passphrase: store.passphrase, phrase: store.phrase, purchase: true, cancel });
  try { await child.waitFor("listening"); }
  catch (error) { await child.close(); store.cleanup(); await fake.close(); throw error; }
  const socket = socketClient(store.dir);
  return { fake, store, child, socket, async close() { socket.close(); await child.close(); store.cleanup(); await fake.close(); } };
}
test("daemon process/socket → H-1 MCP: durable purchase once, saved status, cancel zero", async () => {
  for (const cancel of [false, true]) {
    const f = await setup(cancel);
    const second = socketClient(f.store.dir);
    try {
      expect(new URL((f.fake.state.quote as any).quote.resource.url).origin).not.toBe(f.fake.url.origin);
      const q = await f.socket.send("quote", { routeId: STATIC_ROUTE }); expect(q.ok).toBe(true);
      const ref = q.result.ref;
      const [a,b] = await Promise.all([f.socket.send("purchase", { ref }), second.send("purchase", { ref })]);
      if (cancel) { expect(a.error.code).toBe("approval_rejected"); expect(b.error.code).toBe("approval_rejected"); }
      else {
        expect(a.result).toMatchObject({ state: "result", outcome: "delivered" }); expect(b.result).toEqual(a.result);
        expect((await f.socket.send("status", { ref })).result).toEqual(a.result);
        expect((await f.socket.send("status", { ref, includeBody: true })).result.result.body).toEqual({ value: "x".repeat(2048) });
      }
      const rows = readFileSync(path.join(f.store.dir, "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(rows.map(r => r.state)).toEqual(cancel ? ["quoted"] : ["quoted", "approved", "sign_intent", "signed", "submit_intent", "submitted", "result"]);
      expect(f.fake.state.calls.purchase).toBe(cancel ? 0 : 1);
      expect(f.child.messages.filter((m: any) => m.event === "confirm")).toHaveLength(1);
      expect(f.child.messages.filter((m: any) => m.event === "sign")).toHaveLength(cancel ? 0 : 1);
      const exposed = JSON.stringify(rows) + f.child.stdout + f.child.stderr + JSON.stringify(a);
      for (const secret of [f.store.passphrase, f.store.phrase, "fixture-credential"]) expect(exposed).not.toContain(secret);
    } finally { second.close(); await f.close(); }
  }
});
test("NF-A2: successful quote+purchase, five-sample median overhead <=1000ms, 300ms fixture delay", async () => {
  const f = await setup(); f.fake.state.delayMs = 300; const direct = new RouterClient(f.fake.url); const deltas: number[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      let start = performance.now(); const requestId = randomUUID();
      const q: any = await direct.quote(STATIC_ROUTE, requestId);
      expect(await direct.purchase({ quoteId: q.quote.quoteId, requestId, approval: q.quote.quoteId, credential: "fixture-credential", quote: q.quote })).toMatchObject({ outcome: "delivered" });
      const baseline = performance.now() - start;
      start = performance.now(); const local = await f.socket.send("quote", { routeId: STATIC_ROUTE }); expect(local.ok).toBe(true);
      expect((await f.socket.send("purchase", { ref: local.result.ref })).result.outcome).toBe("delivered");
      deltas.push(performance.now() - start - baseline);
    }
    expect(deltas.sort((a,b) => a-b)[2]).toBeLessThanOrEqual(1000);
    expect(f.fake.state.calls.purchase).toBe(10);
    expect(f.child.messages.filter((m: any) => m.event === "sign")).toHaveLength(5);
  } finally { await f.close(); }
});
