import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { recoveryFixture, statusProjection } from "../harness/recovery.js";
import { STATIC_ROUTE } from "../../src/router/client.js";

async function stopped(point: string) {
  const f = await recoveryFixture(point);
  try {
    const q = await f.socket.send("quote", { routeId: STATIC_ROUTE }); expect(q.ok).toBe(true);
    const ref = q.result.ref; const pending = f.socket.send("purchase", { ref }); void pending.catch(() => undefined);
    await f.child.waitFor(point); await f.crash(); await pending.catch(() => undefined);
    return { f, ref };
  } catch (error) { await f.close(); throw error; }
}
for (const reason of ["not_found", "unauthorized", "projection_malformed", "transport_failed", "router_unavailable", "http_error"]) test(`real restart signed status ${reason}`, async () => {
  const { f, ref } = await stopped("after:signed");
  try { f.router.state.status = { found: false, reason }; await f.restart(); expect((await f.socket.send("status", { ref })).result.state).toBe(reason === "not_found" ? "result" : "unknown"); await f.socket.send("purchase", { ref }); expect(f.counts()).toMatchObject({ sign: 1, purchase: reason === "not_found" ? 1 : 0 }); } finally { await f.close(); }
}, 30_000);
for (const field of ["paymentId", "routeId", "quoteFingerprint", "amount", "asset", "network"]) test(`real restart valid-different identity ${field}, then positive evidence`, async () => {
  const { f, ref } = await stopped("after:signed");
  try {
    const good = statusProjection((f.router.state.quote as any).quote); const bad: any = structuredClone(good);
    const replacements: Record<string, string> = { paymentId: randomUUID(), routeId: "md-other", quoteFingerprint: `sha256:${"ef".repeat(32)}`, amount: "10001", asset: `0x${"44".repeat(20)}`, network: "eip155:1" };
    if (["amount", "asset", "network"].includes(field)) bad.projection.source[field] = replacements[field]; else bad.projection[field] = replacements[field];
    f.router.state.status = bad; await f.restart(); expect((await f.socket.send("status", { ref })).result.state).toBe("unknown");
    f.router.state.status = { found: false, reason: "not_found" }; await f.crash(); await f.restart(); expect((await f.socket.send("status", { ref })).result.state).toBe("unknown");
    f.router.state.status = good; expect((await f.socket.send("status", { ref, includeBody: true })).result.outcome).toBe("delivered"); await f.socket.send("purchase", { ref }); expect(f.counts()).toMatchObject({ sign: 1, purchase: 0 });
  } finally { await f.close(); }
}, 30_000);
for (const status of ["delivered", "paid_data_unavailable", "rejected", "awaiting_payment", "settling", "unknown"]) test(`real submitted restart found ${status}`, async () => {
  const { f, ref } = await stopped("after:submitted");
  try { f.router.state.status = statusProjection((f.router.state.quote as any).quote, status); await f.restart(); expect((await f.socket.send("status", { ref })).result.state).toBe(["delivered", "paid_data_unavailable", "rejected"].includes(status) ? "result" : "unknown"); await f.socket.send("purchase", { ref }); expect(f.counts()).toMatchObject({ sign: 1, purchase: 1 }); } finally { await f.close(); }
}, 30_000);
test("saved successful body reopens after real process death even with Router unavailable", async () => {
  const { f, ref } = await stopped("after:result");
  try { f.router.state.status = { found: false, reason: "transport_failed" }; await f.restart(); expect((await f.socket.send("status", { ref, includeBody: true })).result).toMatchObject({ outcome: "delivered", result: { body: { value: "x".repeat(2048) }, untrusted: true }, proof: { onChainFinality: "not_checked" } }); await f.socket.send("purchase", { ref }); expect(f.counts()).toMatchObject({ sign: 1, purchase: 1 }); expect(f.router.state.calls.status).toBe(0); } finally { await f.close(); }
}, 30_000);

for (const point of ["after:quoted", "after:approved", "after:signed"]) test(`real restart ${point} expired without payment`, async () => {
  const f = await recoveryFixture(point); const ref = "p_aaaaaaaaaaaaa";
  try {
    const raw: any = f.router.state.quote; const expiresAt = Math.floor(Date.now() / 1000) + 4;
    raw.quote.approval.deadlineMs = expiresAt * 1000; raw.quote.source.expiresAt = expiresAt;
    raw.quote.source.offer.extra.expiresAt = expiresAt; raw.subject.source.expiresAt = expiresAt;
    const q = f.socket.send("quote", { routeId: STATIC_ROUTE }); void q.catch(() => undefined);
    let pending: Promise<unknown> = q;
    if (point !== "after:quoted") { expect((await q).ok).toBe(true); pending = f.socket.send("purchase", { ref }); void pending.catch(() => undefined); }
    await f.child.waitFor(point); await f.crash(); await pending.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt * 1000 - Date.now() + 10)));
    await f.restart(); expect((await f.socket.send("status", { ref })).result.state).toBe(point === "after:signed" ? "expired_after_sign" : "expired");
    await f.socket.send("purchase", { ref }); expect(f.counts()).toMatchObject({ sign: point === "after:signed" ? 1 : 0, purchase: 0 });
  } finally { await f.close(); }
}, 30_000);

test("socket purchase during startup recovery stays unavailable and cannot duplicate signed replay", async () => {
  const { socketClient } = await import("../harness/daemon.js");
  const { f, ref } = await stopped("after:signed"); let early: ReturnType<typeof socketClient> | undefined;
  let starting: Promise<void> | undefined;
  try {
    f.router.state.delayMs = 200;
    starting = f.restart();
    // Observe immediately while waiting at the recovery milestone; the original Promise is still awaited.
    void starting.catch(() => undefined);
    await f.child.waitFor("after:submit_intent");
    early = socketClient(f.store.dir);
    expect((await early.send("purchase", { ref })).error.code).toBe("daemon_unavailable");
    await starting;
    const [a, b] = await Promise.all([f.socket.send("purchase", { ref }), early.send("purchase", { ref })]);
    expect(a.result.outcome).toBe("delivered"); expect(a.result).toEqual(b.result);
    expect(f.counts()).toMatchObject({ sign: 1, purchase: 1 });
  } finally {
    early?.close();
    try { await f.close(); } finally { await starting; }
  }
}, 30_000);

for (const errno of ["EROFS", "EIO"] as const) test(`real daemon ${errno} at sign intent prevents all subsequent side effects`, async () => {
  const f = await recoveryFixture(undefined, undefined, errno);
  try {
    const q = await f.socket.send("quote", { routeId: STATIC_ROUTE }); expect(q.ok).toBe(true);
    expect((await f.socket.send("purchase", { ref: q.result.ref })).error.code).toBe("store_write_failed");
    await f.socket.send("purchase", { ref: q.result.ref });
    expect((await f.socket.send("quote", { routeId: STATIC_ROUTE })).error.code).toBe("store_write_failed");
    expect(f.counts()).toMatchObject({ sign: 0, purchase: 0 });
  } finally { await f.close(); }
}, 30_000);
