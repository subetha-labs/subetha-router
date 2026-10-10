import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { shimWire, stdioShim } from "../harness/shim-wire.js";
import { QuoteSummary, PurchaseSummary, PurchaseBodySummary } from "../../src/protocol/summary.js";

test("compiled bin mcp: missing daemon still initializes/lists tool5 and gives static guidance for every tool", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "p4b-absent-")); const f = await stdioShim(home);
  try {
    const { tools } = await f.client.listTools(); expect(tools).toHaveLength(5);
    expect(tools.map(x => x.name)).toEqual(["find_routes", "quote", "purchase", "status", "wallet"].map(x => `subetha_payer_${x}`));
    for (const t of tools) { expect(t.outputSchema).toBeDefined(); expect(t.inputSchema.additionalProperties).toBe(false); }
    expect(tools[2]!._meta).toEqual({ "anthropic/requiresUserInteraction": true });
    expect(f.client.getInstructions()).toMatch(/own terminal/); expect(f.client.getInstructions()).toMatch(/unknown means possibly paid/);
    for (const [name, args] of [["find_routes", {}], ["quote", { routeId: "md-mpp-eth-snapshot" }], ["purchase", { ref: "p_aaaaaaaaaaaaa" }], ["status", { ref: "p_aaaaaaaaaaaaa" }], ["wallet", {}]] as const) {
      const r = await f.call(name, args); expect(r.structuredContent).toEqual({ ok: false, error: "daemon_unavailable", nextStep: "daemon_unavailable" });
      expect((r.content as { text: string }[])[0]!.text).toMatch(/ Payer summary: \{"ok":false,"error":"daemon_unavailable","nextStep":"daemon_unavailable"\}$/);
      expect(JSON.stringify(r.content)).toContain("own terminal"); expect(JSON.stringify(r)).not.toContain(home);
    }
    expect(readdirSync(home)).toEqual([]); expect(f.stderr).toBe("");
  } finally { await f.close(); rmSync(home, { recursive: true, force: true }); }
});
test.each(["accept", "cancel", undefined] as const)("actual SDK display %s reaches daemon with exactly ref, daemon cancel/UI1/sign0", async answer => {
  const f = await shimWire("cancel", answer, true); try {
    const q: any = (await f.shim.call("quote", { routeId: "md-mpp-eth-snapshot" })).structuredContent;
    expect(QuoteSummary.safeParse(q).success).toBe(true);
    const purchase = await f.shim.call("purchase", { ref: q.ref });
    expect(f.requests().filter(x => x.method === "purchase").map(x => x.params)).toEqual([{ ref: q.ref }]);
    expect(purchase.structuredContent).toEqual({ ok: false, error: "approval_rejected" });
    expect(f.shim.displays).toHaveLength(answer ? 1 : 0);
    expect(JSON.stringify(f.shim.displays)).not.toMatch(/credential|ownerKey|challenge|passphrase/);
    expect(f.counts()).toEqual({ daemonUi: 1, shimUi: 0, signer: 0 }); expect(f.rows().some(x => x.state === "sign_intent")).toBe(false);
  } finally { await f.close(); }
});
test("compiled shim → separate daemon → real socket → TCP MCP fixture, one purchase, saved/full status", async () => {
  const f = await shimWire(); f.router.state.body = { value: "あ😀".repeat(400) };
  try {
    const q: any = (await f.shim.call("quote", { routeId: "md-mpp-eth-snapshot" })).structuredContent;
    const p: any = (await f.shim.call("purchase", { ref: q.ref })).structuredContent;
    expect(PurchaseSummary.safeParse(p).success).toBe(true); expect(p.outcome).toBe("delivered");
    expect(p.result.bytes).toBe(Buffer.byteLength(JSON.stringify(f.router.state.body))); expect(Buffer.byteLength(p.result.preview)).toBeLessThanOrEqual(512); expect(p.result.preview).not.toContain("�");
    expect(p.result.body).toBeUndefined(); expect((await f.shim.call("status", { ref: q.ref })).structuredContent).toEqual(p);
    const full = (await f.shim.call("status", { ref: q.ref, includeBody: true })).structuredContent;
    expect(PurchaseBodySummary.safeParse(full).success).toBe(true); expect(full).toMatchObject({ result: { body: f.router.state.body } });
    expect((await f.shim.call("purchase", { ref: q.ref })).structuredContent).toEqual(p);
    expect(f.router.state.calls.purchase).toBe(1); expect(f.counts()).toEqual({ daemonUi: 1, shimUi: 0, signer: 1 });
    expect(f.rows().map(x => x.state)).toEqual(["quoted", "approved", "sign_intent", "signed", "submit_intent", "submitted", "result"]);
  } finally { await f.close(); }
});
