import { expect, test } from "vitest";
import { shimWire } from "../harness/shim-wire.js";
import { modelBytes } from "../harness/shim-memory.js";
import { QuoteSummary } from "../../src/protocol/summary.js";

test("AC-A6 real SDK/stdio/socket: static route1 hold1 body2048, both representations <=4096", async () => {
  const f = await shimWire(); try {
    const routes = await f.shim.call("find_routes", { hold: [{ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }] });
    expect((routes.structuredContent as any).routes).toHaveLength(1);
    const q = await f.shim.call("quote", { routeId: "md-mpp-eth-snapshot" });
    expect(QuoteSummary.safeParse(q.structuredContent).success).toBe(true);
    const ref = (q.structuredContent as any).ref;
    const p = await f.shim.call("purchase", { ref }), s = await f.shim.call("status", { ref });
    expect((p.structuredContent as any).result.bytes).toBe(2048);
    const bytes = modelBytes([routes, q, p, s]); console.log(`AC-A6 wire actual SDK UTF-8 bytes=${bytes}`); expect(bytes).toBeLessThanOrEqual(4096);
    expect(JSON.stringify([routes, q, p, s])).not.toContain("fixture-credential");
  } finally { await f.close(); }
});
