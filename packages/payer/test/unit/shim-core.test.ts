import { expect, test } from "vitest";
import { shimMemory, modelBytes } from "../harness/shim-memory.js";
import { QuoteSummary } from "../../src/protocol/summary.js";

test("actual SDK results through existing durable core: static route/hold1, body2048, AC-A6 <=4096", async () => {
  const f = await shimMemory(); try {
    const call = (name: string, args: any = {}) => f.client.callTool({ name: `subetha_payer_${name}`, arguments: args });
    const routes = await call("find_routes", { hold: [{ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }] });
    expect((routes.structuredContent as any).routes).toHaveLength(1);
    expect((await call("find_routes", { hold: [] })).structuredContent).toEqual({ ok: true, routes: [] });
    const q = await call("quote", { routeId: "md-mpp-eth-snapshot" });
    expect(QuoteSummary.safeParse(q.structuredContent).success).toBe(true);
    const ref = (q.structuredContent as any).ref;
    const p = await call("purchase", { ref }); const s = await call("status", { ref });
    expect(s.structuredContent).toEqual(p.structuredContent); expect((p.structuredContent as any).result.bytes).toBe(2048);
    expect((p.structuredContent as any).result.body).toBeUndefined();
    const bytes = modelBytes([routes, q, p, s]); console.log(`AC-A6 actual SDK content+structuredContent UTF-8: ${bytes}`);
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(f.counts).toEqual({ ui: 1, sign: 1, purchase: 1 });
    expect((await call("status", { ref, includeBody: true })).structuredContent).toMatchObject({ result: { body: { value: "x".repeat(2036) } } });
  } finally { await f.close(); }
});
test("UTF-8 preview stops at codepoint boundary, full body retained only on includeBody", async () => {
  const body = { value: "あ😀".repeat(400) }; const f = await shimMemory(body);
  try {
    await f.client.callTool({ name: "subetha_payer_quote", arguments: { routeId: "md-mpp-eth-snapshot" } });
    const p: any = (await f.client.callTool({ name: "subetha_payer_purchase", arguments: { ref: "p_aaaaaaaaaaaaa" } })).structuredContent;
    expect(p.result.bytes).toBe(Buffer.byteLength(JSON.stringify(body))); expect(Buffer.byteLength(p.result.preview)).toBeLessThanOrEqual(512);
    expect(p.result.preview).not.toContain("�"); expect(JSON.stringify(body).startsWith(p.result.preview)).toBe(true);
    expect(p.result.body).toBeUndefined();
    expect((await f.client.callTool({ name: "subetha_payer_status", arguments: { ref: p.ref, includeBody: true } })).structuredContent).toMatchObject({ result: { body } });
  } finally { await f.close(); }
});
