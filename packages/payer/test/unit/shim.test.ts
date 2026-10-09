import { expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createShim } from "../../src/shim/server.js";
import { Request } from "../../src/daemon/server.js";

async function pair(answer?: "accept" | "cancel") {
  const calls: unknown[] = [];
  const shim = createShim({ async request(method, params) {
    calls.push({ method, params });
    if (method === "ping") return { ok: true, state: "unlocked", version: "0.1.0" };
    return { ok: false, error: "approval_rejected" };
  }, async close() {} });
  const client = new Client({ name: "fixture", version: "1.0.0" }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  let displays = 0;
  if (answer) client.setRequestHandler(ElicitRequestSchema, async request => {
    displays++; expect(JSON.stringify(request)).not.toMatch(/quote|credential|passphrase/);
    return { action: answer };
  });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await shim.connect(a); await client.connect(b);
  return { client, calls, get displays() { return displays; }, async close() { await client.close(); await shim.close(); } };
}
test("SDK lists exactly five strict tools, purchase metadata and initialization instructions", async () => {
  const f = await pair(); try {
    const { tools } = await f.client.listTools();
    expect(tools.map(t => t.name)).toEqual(["find_routes", "quote", "purchase", "status", "wallet"].map(n => `subetha_payer_${n}`));
    for (const tool of tools) { expect(tool.inputSchema.additionalProperties).toBe(false); expect(tool.outputSchema).toBeDefined(); }
    expect(tools[2]!._meta).toEqual({ "anthropic/requiresUserInteraction": true });
    expect(f.client.getInstructions()).toMatch(/unknown.*possibly paid/);
    expect(f.client.getInstructions()).toMatch(/PTY/);
  } finally { await f.close(); }
});
test.each(["accept", "cancel", undefined] as const)("display %s never changes exact daemon purchase params", async answer => {
  const f = await pair(answer); try {
    const result = await f.client.callTool({ name: "subetha_payer_purchase", arguments: { ref: "p_aaaaaaaaaaaaa" } });
    expect(result.structuredContent).toEqual({ ok: false, error: "approval_rejected" });
    expect(f.calls).toEqual([{ method: "ping", params: {} }, { method: "purchase", params: { ref: "p_aaaaaaaaaaaaa" } }]);
    expect(f.displays).toBe(answer ? 1 : 0);
  } finally { await f.close(); }
});
test.each(["approved", "passphrase", "credential", "ownerKey", "routerUrl", "store"])("forged %s rejected before daemon request", async key => {
  const f = await pair(); try {
    const result = await f.client.callTool({ name: "subetha_payer_purchase", arguments: { ref: "p_aaaaaaaaaaaaa", [key]: key === "approved" ? true : "synthetic" } });
    expect(result.isError).toBe(true); expect(f.calls).toHaveLength(1);
  } finally { await f.close(); }
});
test("daemon request accepts optional hold, preserves strict forged purchase rejection", () => {
  expect(Request.safeParse({ id: 1, method: "find_routes", params: { hold: [{ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }] } }).success).toBe(true);
  expect(Request.safeParse({ id: 1, method: "purchase", params: { ref: "p_aaaaaaaaaaaaa", approved: true } }).success).toBe(false);
});
test.each(["p_aaaaaaaa", "p_aaaaaaaaaaaaab", "p_aaaaaaaaaaaab"])("shim retains canonical ref boundary: %s", async ref => {
  const f = await pair(); try {
    expect((await f.client.callTool({ name: "subetha_payer_purchase", arguments: { ref } })).isError).toBe(true);
    expect(f.calls).toHaveLength(1);
  } finally { await f.close(); }
});
test.each([
  { ok: true, wallets: [], ownerKey: "synthetic-secret" },
  { ok: false, error: "internal_error", reason: "synthetic-secret" },
])( "runtime output validation rejects producer extras and unapproved error strings", async raw => {
  const shim = createShim({ async request() { return raw; }, async close() {} });
  const client = new Client({ name: "fixture", version: "1.0.0" });
  const [a,b] = InMemoryTransport.createLinkedPair();
  try {
    await shim.connect(a); await client.connect(b); await client.listTools();
    const reply = await client.callTool({ name: "subetha_payer_wallet", arguments: {} });
    expect(reply.structuredContent).toEqual({ ok: false, error: "internal_error" });
    expect(JSON.stringify(reply)).not.toContain("synthetic-secret");
  } finally { await client.close(); await shim.close(); }
});
