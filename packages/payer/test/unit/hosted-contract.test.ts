/** Real producer contract, in process only. Root typechecking covers the cross-package imports; both Vitest collectors include this file. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { hostPlanOf } from "../../../../tools/remote-mcp.js";
import { RAILS_NONE } from "../../../../tools/remote-mcp-config.js";
import { parseRouterConfig, routeBindingOf } from "../../../../src/config.js";
import { quoteBody, projectionBody } from "../../../../src/http/projection.js";
import { createRouterClient } from "../../../../src/client/index.js";
import { createToolHandlers } from "../../../../src/mcp/tools.js";
import type { QuoteDocument } from "../../../../src/core/orchestrator.js";
import { HOSTED_ROUTER_URL, HOSTED_RESOURCE_URL, routerIdentity } from "../../src/router/identity.js";
import { STATIC_ROUTE, statusOf } from "../../src/router/client.js";
import { createPurchaseCore } from "../../src/daemon/purchase.js";
import { buildRecord, recordHash, render } from "../../src/daemon/record.js";
import { Session } from "../../src/daemon/session.js";
import { realFs } from "../../src/store/fs.js";
import { openLedger } from "../../src/store/ledger.js";

async function produced() {
  const plan = hostPlanOf({ activation: RAILS_NONE, bind: "127.0.0.1", port: 0, journalPath: "unused-fixture.ndjson" }, {
    SUBETHA_OUTBOUND_PRIVATE_KEY: `0x${randomBytes(32).toString("hex")}`,
    SUBETHA_ROUTER_RECEIVER: `0x${randomBytes(20).toString("hex")}`,
  });
  const config = parseRouterConfig(plan.config["router"]);
  const route = config.routes[STATIC_ROUTE]!;
  const expiresAt = Math.floor(Date.now() / 1000) + 120;
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  const doc: QuoteDocument = {
    quoteId: nonce, paymentId: randomUUID(), routeId: route.routeId,
    source: { amount: route.source.amount, asset: route.source.asset, network: route.source.network,
      offer: { scheme: "exact", network: route.source.network, asset: route.source.asset, amount: route.source.amount,
        payTo: route.source.payTo!, maxTimeoutSeconds: 120,
        extra: { name: "USDC", version: "2", challengeNonce: nonce, expiresAt, routeBinding: routeBindingOf(route), fundsMoveOnCredential: false } } },
    destination: { quoted: "10000", asset: route.destination.asset, network: route.destination.network,
      payTo: route.destination.payTo, quoteFingerprint: `sha256:${"cd".repeat(32)}` },
    approval: { required: true, boundTo: nonce, deadlineMs: expiresAt * 1000 },
  };
  const projection = quoteBody(doc, route, plan.childEnv["ROUTER_CANONICAL_BASE_URL"]!);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(projection), { status: 200 }));
  const client = createRouterClient({ baseUrl: "http://127.0.0.1:8500", principalId: "fixture", token: "fixture", fetch });
  const tools = createToolHandlers({ client, mode: "synthetic", evidence: { label: "local-only", source: "operator_asserted", verified: false } });
  const response = await tools.quote({ routeId: route.routeId, requestId: randomUUID() });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(response["ok"]).toBe(true);
  return response;
}
const identity = () => ({ routerUrl: HOSTED_ROUTER_URL, ref: "p_aaaaaaaaaaaaa", requestId: randomUUID(), address: `0x${"33".repeat(20)}` });

test("actual hostPlan → quoteBody → client → MCP subject accepts HTTPS transport / loopback canonical pair", async () => {
  const response = await produced();
  const q: any = response["quote"];
  expect(q.destination.rail).toBe("mpp");
  expect(q.destination.decimals).toBeUndefined();
  expect(response["approvalRequired"]).toBe(true);
  const r = buildRecord(response, identity());
  expect(r.resource).toEqual({ url: HOSTED_RESOURCE_URL, method: "GET" });
  expect(new URL(r.routerUrl).origin).not.toBe(new URL(r.resource.url).origin);
  expect(Object.isFrozen(r.resource)).toBe(true);
  // FR-F4: the producer still omits destination decimals (until the Router fix is deployed); new records carry pathUSD's 6.
  expect(r.destination.decimals).toBe(6);
  expect(render(r)).toContain("Destination amount: 10000 base units (decimals 6)");
  // Legacy 0.1.0/0.1.1 records without destination decimals keep their display.
  const { decimals: _legacy, ...legacyDestination } = r.destination;
  expect(render({ ...r, destination: legacyDestination })).toContain("decimals not supplied");
  expect(recordHash({ ...r, resource: { ...r.resource, url: `https://hostile.invalid${new URL(r.resource.url).pathname}` } })).not.toBe(recordHash(r));
});

const substitutions: [string, (v: any) => void][] = [
  ...["https://hostile.invalid", "https://router.subethalabs.com", "http://localhost:8500", "http://127.0.0.1:8501"].map(origin => [origin, (v: any) => { v.quote.resource.url = `${origin}/v1/routes/${STATIC_ROUTE}/resource`; }] as [string, (v: any) => void]),
  ["credentials", v => { v.quote.resource.url = HOSTED_RESOURCE_URL.replace("//", "//user:pass@"); }],
  ["query", v => { v.quote.resource.url += "?x=1"; }], ["fragment", v => { v.quote.resource.url += "#x"; }],
  ["dot alias", v => { v.quote.resource.url = HOSTED_RESOURCE_URL.replace("/v1/", "/alias/../v1/"); }],
  ["encoded alias", v => { v.quote.resource.url = HOSTED_RESOURCE_URL.replace("/v1/", "/%76%31/"); }],
  ["different path", v => { v.quote.resource.url += "/other"; }],
  ["method", v => { v.quote.resource.method = "POST"; }],
  ["routeBinding", v => { v.quote.source.offer.extra.routeBinding = "valid-but-different"; }],
];
for (const [name, change] of substitutions) test(`producer hostile substitution ${name}: no UI/sign/purchase/ledger effects`, async () => {
  const response: any = structuredClone(await produced());
  // Baseline must pass before each hostile substitution.
  expect(() => buildRecord(response, identity())).not.toThrow();
  change(response);
  // Mutate both projections so subject equality alone cannot hide a missing identity guard.
  response.subject.resource = structuredClone(response.quote.resource);
  response.subject.source.offer = structuredClone(response.quote.source.offer);
  const dir = mkdtempSync(path.join(tmpdir(), "p3b-contract-")); const key = randomBytes(32);
  const ledger = openLedger(path.join(dir, "ledger.ndjson"), key, realFs); const session = new Session(randomBytes(32));
  const ui = vi.fn(); const sign = vi.fn(); const purchase = vi.fn(); const quote = vi.fn(async () => response);
  try {
    const core = createPurchaseCore({ ledger, session, address: identity().address, phrase: "fixture", assertHeld() {},
      purchase: { routerUrl: HOSTED_ROUTER_URL, ui: { available: ui }, signer: { sign } },
      router: { quote, purchase, listRoutes: async () => ({}), status: async () => ({ kind: "not_found", reason: "not_found" }) } });
    expect(await core.quote()).toMatchObject({ error: "quote_inconsistent" });
    expect(quote).toHaveBeenCalledTimes(1); expect(ledger.rows).toHaveLength(0);
    expect(ui).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled(); expect(purchase).not.toHaveBeenCalled();
  } finally { session.close(); ledger.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); }
});

test("custom endpoints require explicit canonical config; aliases and unsafe config fail before quote", () => {
  for (const url of ["https://custom.invalid/mcp", "http://127.0.0.1:9999/mcp"]) {
    expect(() => routerIdentity(url)).toThrow("config_invalid");
    expect(routerIdentity(url, { url: HOSTED_RESOURCE_URL, method: "GET" }).resource.url).toBe(HOSTED_RESOURCE_URL);
  }
  for (const url of ["https://ROUTER.subethalabs.com/mcp", `${HOSTED_ROUTER_URL}?`, `${HOSTED_ROUTER_URL}#`, "https://user@router.subethalabs.com/mcp", "https://router.subethalabs.com/a/../mcp"]) {
    expect(() => routerIdentity(url)).toThrow("config_invalid");
  }
});

test("real producer quote reaches durable core purchase with omitted optional destination decimals", async () => {
  const response: any = await produced();
  const dir = mkdtempSync(path.join(tmpdir(), "p3b-contract-")); const key = randomBytes(32);
  const ledger = openLedger(path.join(dir, "ledger.ndjson"), key, realFs); const session = new Session(randomBytes(32));
  const sign = vi.fn(async () => "fixture-credential");
  const purchase = vi.fn(async () => ({ ok: true, paymentId: response.quote.paymentId, outcome: "delivered", snapshot: { synthetic: true }, contentType: "application/json" }));
  const confirm = vi.fn(async (r: Parameters<typeof recordHash>[0]) => ({ approved: true as const, recordHash: recordHash(r), uiKind: "native" as const }));
  try {
    const core = createPurchaseCore({ ledger, session, address: identity().address, phrase: "fixture", assertHeld() {},
      purchase: { routerUrl: HOSTED_ROUTER_URL, ui: { available: async () => true, confirm }, signer: { sign } },
      router: { quote: async () => response, purchase, listRoutes: async () => ({}), status: async () => ({ kind: "not_found", reason: "not_found" }) } });
    const q: any = await core.quote(); expect(q.ok).toBe(true);
    expect(response.quote.destination.decimals).toBeUndefined();
    expect(q.subject.reaches.decimals).toBe(6);
    const result = await core.purchase(q.ref); expect(result).toMatchObject({ state: "result", outcome: "delivered" });
    expect(await core.purchase(q.ref)).toEqual(result);
    expect(ledger.rows.map(row => row.state)).toEqual(["quoted", "approved", "sign_intent", "signed", "submit_intent", "submitted", "result"]);
    expect(confirm).toHaveBeenCalledTimes(1); expect(sign).toHaveBeenCalledTimes(1); expect(purchase).toHaveBeenCalledTimes(1);
  } finally { session.close(); ledger.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); }
});


test("actual projectionBody → client → MCP status preserves recovery identity and learned txRef", async () => {
  const response: any = await produced(); const q = response.quote, r = buildRecord(response, identity());
  const body = projectionBody({ paymentId: q.paymentId, routeId: q.routeId, status: "delivered", source: { amount: q.source.amount, asset: q.source.asset, network: q.source.network, txRef: "learned-after-settlement" }, destination: { quoted: q.destination.quoted, asset: q.destination.asset, network: q.destination.network, attempt: 1, outcome: "paid" }, quoteFingerprint: q.destination.quoteFingerprint, updatedAt: new Date().toISOString(), result: { synthetic: true } });
  const client = createRouterClient({ baseUrl: "http://127.0.0.1:8500", principalId: "fixture", token: "fixture", fetch: async () => new Response(JSON.stringify(body), { status: 200 }) });
  const tools = createToolHandlers({ client, mode: "synthetic", evidence: { label: "local-only", source: "operator_asserted", verified: false } });
  const status = statusOf(await tools.status({ paymentId: q.paymentId }));
  expect(status.kind).toBe("found");
  if (status.kind !== "found") throw new Error("fixture_status");
  const { matchingProjection } = await import("../../src/daemon/recover.js");
  expect(matchingProjection(r, status.projection)).toBe(true);
  expect(status.projection["quoteFingerprint"]).toBe(r.destination.quoteFingerprint);
  expect((status.projection["source"] as any).txRef).toBe("learned-after-settlement");
  expect(status.projection["result"]).toEqual({ synthetic: true });
  expect(status.projection["quoteId"]).toBeUndefined(); expect(status.projection["requestId"]).toBeUndefined();
});
