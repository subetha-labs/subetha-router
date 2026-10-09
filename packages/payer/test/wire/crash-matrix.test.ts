import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { recoveryFixture, statusProjection } from "../harness/recovery.js";
import { events } from "../harness/durable.js";
import { STATIC_ROUTE } from "../../src/router/client.js";

const rows: [string, string | undefined, number, number, string, number, number, "not_found"?][] = [
  ["before:quoted", undefined, 0, 0, "absent", 0, 0],
  ["after:quoted", "quoted", 0, 0, "result", 1, 1],
  ["after:approved", "approved", 0, 0, "result", 1, 1],
  ["after:sign_intent", "sign_intent", 0, 0, "unknown", 0, 0],
  ["before:signed", "sign_intent", 1, 0, "unknown", 1, 0],
  ["after:signed", "signed", 1, 0, "result", 1, 1],
  ["after:submit_intent", "submit_intent", 1, 0, "unknown", 1, 0],
  ["transport:before-response", "submit_intent", 1, 1, "unknown", 1, 1],
  ["transport:after-response", "submit_intent", 1, 1, "result", 1, 1],
  ["transport:after-response", "submit_intent", 1, 1, "unknown", 1, 1, "not_found"],
  ["before:submitted", "submit_intent", 1, 1, "result", 1, 1],
  ["after:submitted", "submitted", 1, 1, "result", 1, 1],
  ["before:result", "submitted", 1, 1, "result", 1, 1],
  ["after:result", "result", 1, 1, "result", 1, 1],
];
for (const [point, last, signAtCrash, purchaseAtCrash, final, signAfter, purchaseAfter, status] of rows) test(`real SIGKILL matrix ${point}${status ? " + " + status : ""}`, async () => {
  const f = await recoveryFixture(point); const ref = "p_aaaaaaaaaaaaa";
  try {
    const q = f.socket.send("quote", { routeId: STATIC_ROUTE }); void q.catch(() => undefined);
    let pending: Promise<unknown> = q;
    if (!point.endsWith(":quoted")) { expect((await q).ok).toBe(true); pending = f.socket.send("purchase", { ref }); void pending.catch(() => undefined); }
    await f.child.waitFor(point);
    expect(f.rows().at(-1)?.state).toBe(last);
    expect(f.counts()).toMatchObject({ sign: signAtCrash, purchase: purchaseAtCrash });
    const seal = readFileSync(path.join(f.store.dir, "install.seal"));
    const uiBefore = f.counts().ui;
    await f.crash(); await pending.catch(() => undefined);
    const credentialHash = point === "after:signed" ? f.savedCredentialHash() : undefined;
    if (status === "not_found") f.router.state.status = { found: false, reason: "not_found", status: 404 };
    else if (["transport:after-response", "before:submitted", "after:submitted", "before:result"].includes(point)) f.router.state.status = statusProjection((f.router.state.quote as any).quote);
    await f.restart();
    expect(readFileSync(path.join(f.store.dir, "install.seal")).equals(seal)).toBe(true);
    expect(f.counts().ui).toBe(uiBefore);
    if (status === "not_found") expect(f.counts()).toMatchObject({ sign: 1, purchase: 1 });
    if (last === "quoted" || last === "approved") {
      expect(f.counts()).toMatchObject({ sign: 0, purchase: 0 });
      expect((await f.socket.send("purchase", { ref })).result.outcome).toBe("delivered");
      expect(f.counts().ui).toBe(uiBefore + 1);
    }
    if (final === "absent") expect((await f.socket.send("status", { ref })).error.code).toBe("unknown_ref");
    else expect((await f.socket.send("status", { ref, includeBody: true })).result.state).toBe(final);
    await f.socket.send("purchase", { ref }); await f.socket.send("purchase", { ref });
    expect(f.counts()).toMatchObject({ sign: signAfter, purchase: purchaseAfter });
    if (point === "after:signed") expect(events(path.join(f.store.home, "router-counter.ndjson")).map(x => x.credentialHash)).toEqual([credentialHash]);
  } finally { await f.close(); }
}, 30_000);
