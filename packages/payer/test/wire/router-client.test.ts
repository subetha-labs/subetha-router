import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { RouterClient, routerFailure, STATIC_ROUTE } from "../../src/router/client.js";
import { fakeRouter, destination } from "../harness/router.js";

test("actual SDK MCP: one initialized connection/request; H-1 success, text fallback, reason/retryAfterMs and four status classes", async () => {
  const fake = await fakeRouter();
  try {
    const client = new RouterClient(fake.url);
    expect(await client.listRoutes()).toMatchObject({ ok: true, routes: [{ routeId: STATIC_ROUTE }] });
    for (const textOnly of [false, true]) {
      fake.state.textOnly = textOnly;
      expect(await client.quote(STATIC_ROUTE, randomUUID())).toMatchObject({ ok: true, quote: { destination: { payTo: destination.payTo } }, subject: { source: { amount: "10000" } } });
    }
    fake.state.quote = { ok: false, error: "rate_limited", reason: "rate_host", retryAfterMs: 3500, httpStatus: 429 };
    expect(routerFailure(await client.quote(STATIC_ROUTE, randomUUID()))).toEqual({ ok: false, error: "rate_limited", reason: "rate_host", retryAfterMs: 3500 });
    fake.state.quote = { ok: false, error: "quote_failed", reason: "per_purchase_limit", httpStatus: 502 };
    expect(routerFailure(await client.quote(STATIC_ROUTE, randomUUID()))).toEqual({ ok: false, error: "quote_failed", reason: "per_purchase_limit" });
    const paymentId = randomUUID();
    fake.state.status = { found: true, projection: { paymentId, routeId: STATIC_ROUTE, status: "awaiting_payment", source: {}, destination: {}, quoteFingerprint: "fixture", updatedAt: new Date().toISOString() } };
    expect(await client.status(paymentId)).toMatchObject({ kind: "found", projection: { status: "awaiting_payment" } });
    fake.state.status = { found: false, reason: "not_found", status: 404 };
    expect(await client.status(paymentId)).toEqual({ kind: "not_found", reason: "not_found" });
    fake.state.status = { found: false, reason: "unauthorized", status: 401 };
    expect(await client.status(paymentId)).toEqual({ kind: "unreadable", reason: "unauthorized" });
    fake.state.status = { found: false, reason: "projection_malformed", status: 200 };
    expect(await client.status(paymentId)).toEqual({ kind: "unreadable", reason: "projection_malformed" });
    expect(fake.state.calls).toEqual({ initialize: 9, listRoutes: 1, quote: 4, status: 4, purchase: 0 });
    expect(new Set(fake.state.requestIds).size).toBe(4);
  } finally { await fake.close(); }
});

test("real 30 second absolute timeout aborts the HTTP operation; exactly one call, no retry", async () => {
  const fake = await fakeRouter();
  try {
    fake.state.hang = true;
    const started = performance.now();
    expect(await new RouterClient(fake.url).quote(STATIC_ROUTE, randomUUID())).toEqual({ ok: false, error: "router_unavailable" });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(29_000);
    expect(elapsed).toBeLessThan(33_000);
    expect(fake.state.calls.quote).toBe(1);
    expect(fake.state.calls.initialize).toBe(1);
    expect(fake.state.calls.purchase).toBe(0);
  } finally { await fake.close(); }
}, 36_000);
