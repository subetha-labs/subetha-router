import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { listenSocket } from "../../src/daemon/server.js";
import { fixtureDaemon, FIXTURE_REF, socketClient } from "../harness/daemon.js";
import { fixtureStore } from "../harness/store.js";
import { fakeRouter } from "../harness/router.js";
import { within } from "../harness/children.js";

test("real socket modes, unknown ref, strict request and lock loss stop later work", async () => {
  const fake = await fakeRouter();
  const daemon = await fixtureDaemon(fake.url).catch(async (error: unknown) => {
    await fake.close().catch(() => undefined);
    throw error;
  });
  const client = socketClient(daemon.store.dir);
  try {
    expect(lstatSync(daemon.store.dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(daemon.store.dir, "daemon.sock")).mode & 0o777).toBe(0o600);
    expect(await client.send("purchase", { ref: FIXTURE_REF })).toMatchObject({ error: { code: "unknown_ref" } });
    expect(await client.send("purchase", { ref: FIXTURE_REF, approved: true })).toMatchObject({ error: { code: "invalid_request" } });
    expect(await client.send("find_routes")).toMatchObject({ ok: true, result: { routes: [{ routeId: "md-mpp-eth-snapshot" }] } });
    const lockPath = path.join(daemon.store.dir, "daemon.lock");
    const original = JSON.parse(readFileSync(lockPath, "utf8"));
    writeFileSync(lockPath, JSON.stringify({ ...original, token: "0123456789abcdef" }));
    await within(daemon.closed, 2000);
    expect(daemon.context.session.locked).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("0123456789abcdef");
    expect(fake.state.calls.purchase).toBe(0);
  } finally { client.close(); await daemon.cleanup(); await fake.close(); }
});

test("two real connections serialize their own requests; exception and extra secret field never escape", async () => {
  const store = fixtureStore();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let bothEnter!: () => void;
  const bothEntered = new Promise<void>((resolve) => { bothEnter = resolve; });
  let entries = 0;
  const listener = await listenSocket(path.join(store.dir, "daemon.sock"), async (request) => {
    events.push(`start:${request.id}`);
    if (request.id === 1) { enter(); if (++entries === 2) bothEnter(); await gate; }
    events.push(`end:${request.id}`);
    if (request.id === 2) return { ok: true, state: "locked", version: "0.1.0", credential: "secret-fixture" };
    if (request.id === 3) throw new Error("secret-fixture");
    return { ok: true, state: "unlocked", version: "0.1.0" };
  });
  const first = socketClient(store.dir);
  const second = socketClient(store.dir);
  try {
    const a = first.send("ping");
    const b = first.send("ping");
    await within(entered);
    const c = second.send("ping");
    // Both first requests must enter before either connection's second request.
    await within(bothEntered);
    expect(events).toEqual(["start:1", "start:1"]);
    release();
    expect(await a).toMatchObject({ ok: true });
    expect(await c).toMatchObject({ ok: true });
    expect(await b).toEqual({ id: 2, ok: false, error: { code: "internal_error" } });
    expect(await first.send("ping")).toEqual({ id: 3, ok: false, error: { code: "internal_error" } });
    expect(events.indexOf("start:2")).toBeGreaterThan(events.indexOf("end:1"));
  } finally { release(); first.close(); second.close(); await listener.close(); store.cleanup(); }
});
