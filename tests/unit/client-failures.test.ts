/**
 * H-1（`docs/agent-payer-tasks.md`、要件 FR-A25）: client は失敗の `reason`・HTTP status・`Retry-After` を落とさない。
 * `status` の失敗は `not_found` / `unauthorized` / `projection_malformed` / `payment_id_mismatch` / `transport_failed` に分かれる。
 * 既存の欄（`error`・`status`）は変えない（加算だけ）。
 */
import { describe, expect, test } from "vitest";

import { createRouterClient } from "../../src/client/index.js";

function clientWith(responder: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return createRouterClient({
    baseUrl: "https://router.test",
    principalId: "a",
    token: "b",
    allowUnissuedQuotes: true,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => responder(new URL(String(input)), init ?? {})) as typeof fetch,
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("client failures keep reason, status and Retry-After", () => {
  test("quote: 502 with reason → error, reason, status (reason must match ^[a-z_]{1,64}$)", async () => {
    const client = clientWith(() => json(502, { error: "quote_failed", reason: "per_purchase_limit" }));
    const result = await client.quote({ routeId: "r", requestId: "x" });
    expect(result).toMatchObject({ ok: false, error: "quote_failed", status: 502, reason: "per_purchase_limit" });
  });

  test("quote: a reason outside the pattern is dropped, the error code stays", async () => {
    const client = clientWith(() => json(502, { error: "quote_failed", reason: "Bad Reason: <script>" }));
    const result = await client.quote({ routeId: "r", requestId: "x" });
    expect(result).toMatchObject({ ok: false, error: "quote_failed", status: 502 });
    expect(result).not.toHaveProperty("reason");
  });

  test("quote: 429 with Retry-After seconds → retryAfterMs", async () => {
    const client = clientWith(() => json(429, { error: "rate_limited", reason: "per_source" }, { "retry-after": "30" }));
    const result = await client.quote({ routeId: "r", requestId: "x" });
    expect(result).toMatchObject({ ok: false, error: "rate_limited", status: 429, reason: "per_source", retryAfterMs: 30_000 });
  });

  test("quoteUrl: 429 with an HTTP-date Retry-After → the difference to now (clamped at 0)", async () => {
    const date = new Date(Date.now() + 45_000).toUTCString();
    const client = clientWith(() => json(429, { error: "rate_limited" }, { "retry-after": date }));
    const result = await client.quoteUrl({ profileId: "p", url: "https://u.test/x", requestId: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryAfterMs).toBeGreaterThan(40_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(45_000);
  });

  test("quote: 429 without Retry-After → no retryAfterMs from the client (the MCP layer applies the default)", async () => {
    const client = clientWith(() => json(429, { error: "rate_limited" }));
    const result = await client.quote({ routeId: "r", requestId: "x" });
    expect(result).toMatchObject({ ok: false, error: "rate_limited", status: 429 });
    expect(result).not.toHaveProperty("retryAfterMs");
  });

  test("quote: Retry-After parser boundaries — malformed, negative, fractional, exponent and oversized numbers are ignored; a past date is 0; huge values are capped at 1 hour", async () => {
    for (const header of ["soon", "-5", "1.5", "1e3", "99999999999", "Mon, 32 Jan 2026 00:00:00 GMT", "2026-10-08T00:00:00Z", "Tue, 08 Oct 2026 00:00:00 UTC"]) {
      const client = clientWith(() => json(429, { error: "rate_limited" }, { "retry-after": header }));
      const result = await client.quote({ routeId: "r", requestId: "x" });
      expect(result, header).not.toHaveProperty("retryAfterMs");
    }
    const past = clientWith(() => json(429, { error: "rate_limited" }, { "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT" }));
    expect(await past.quote({ routeId: "r", requestId: "x" })).toMatchObject({ retryAfterMs: 0 });
    const huge = clientWith(() => json(429, { error: "rate_limited" }, { "retry-after": "9999999" }));
    expect(await huge.quote({ routeId: "r", requestId: "x" })).toMatchObject({ retryAfterMs: 3_600_000 });
  });

  test("status: 404 → found:false, reason not_found (absent OR inaccessible: a wrong ownerKey also looks like this); 401/403 → unauthorized; other → http_error", async () => {
    for (const [status, reason] of [[404, "not_found"], [401, "unauthorized"], [403, "unauthorized"], [500, "http_error"]] as const) {
      const client = clientWith(() => json(status, { error: "x" }));
      expect(await client.status("p1")).toEqual({ found: false, status, reason });
    }
  });

  test("status: transport failure and malformed projections keep their existing reasons", async () => {
    const failing = clientWith(() => { throw new Error("boom"); });
    expect(await failing.status("p1")).toEqual({ found: false, status: 0, reason: "transport_failed" });
    const malformed = clientWith(() => json(200, { paymentId: "p1" }));
    expect(await malformed.status("p1")).toMatchObject({ found: false, status: 200, reason: "projection_malformed" });
  });

  test("execute: a rejected purchase carries the Router's reason when it matches the pattern", async () => {
    const client = clientWith((url) => (url.pathname.endsWith("/resource") ? json(409, { error: "approval_required", reason: "approval_bound_to_other_quote" }) : json(404, {})));
    const quote = {
      quoteId: "q1", paymentId: "p1", routeId: "r",
      resource: { url: "https://router.test/v1/routes/r/resource", method: "GET" },
      approval: { required: true, boundTo: "q1", deadlineMs: Date.now() + 60_000 },
      source: { rail: "x402", amount: "1", asset: "A", decimals: 6, network: "eip155:84532", payTo: "P", expiresAt: 1, offer: {} },
      destination: { rail: "mpp", quoted: "1", asset: "B", network: "eip155:42431", quoteFingerprint: "sha256:x" },
    };
    const result = await client.execute({ quote: quote as never, requestId: "x", approval: { approved: true, quoteId: "q1" }, credential: "c" });
    expect(result).toMatchObject({ outcome: "rejected", error: "approval_required", status: 409, reason: "approval_bound_to_other_quote" });
  });
});
