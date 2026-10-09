import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createPurchaseCore } from "../../src/daemon/purchase.js";
import { buildRecord, jsonCopy } from "../../src/daemon/record.js";
import { HOSTED_ROUTER_URL } from "../../src/router/identity.js";
import { openLedger } from "../../src/store/ledger.js";
import { realFs } from "../../src/store/fs.js";
import { Session } from "../../src/daemon/session.js";
import { h1Quote } from "../harness/router.js";

const entropy = vi.hoisted(() => ({ octets: [] as number[], sizes: [] as number[] }));
vi.mock("node:crypto", async importOriginal => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomBytes: (size: number) => {
    if (size === 8 && entropy.octets.length) { entropy.sizes.push(size); return Buffer.alloc(8, entropy.octets.shift()!); }
    return original.randomBytes(size);
  } };
});

test("production default generator checks ledger and pending reservations without losing any random bits", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p3b-refs-")); const key = randomBytes(32);
  const ledger = openLedger(path.join(dir, "ledger.ndjson"), key, realFs); const session = new Session(randomBytes(32));
  const quote = vi.fn(async () => { await Promise.resolve(); return h1Quote(); });
  try {
    // Seed a recoverable collision without consuming the two tested quote calls or ref entropy.
    const raw = h1Quote();
    const record = buildRecord(raw, { routerUrl: HOSTED_ROUTER_URL, address: `0x${"33".repeat(20)}`,
      ref: "p_aaaaaaaaaaaaa", requestId: "11111111-1111-4111-8111-111111111111" });
    ledger.append({ ref: record.ref, state: "quoted", data: jsonCopy(record), sealedPlain: Buffer.from(JSON.stringify(raw)) });
    entropy.octets = [0, 255, 255, 1]; entropy.sizes = [];
    const core = createPurchaseCore({ ledger, session, address: `0x${"33".repeat(20)}`, phrase: "fixture", assertHeld() {},
      purchase: { routerUrl: HOSTED_ROUTER_URL, ui: { available: async () => false }, signer: { sign: vi.fn() } },
      router: { quote, listRoutes: async () => ({}), purchase: vi.fn(), status: async () => ({ kind: "not_found", reason: "not_found" }) } });
    const results: any[] = await Promise.all([core.quote(), core.quote()]);
    expect(results).toMatchObject([{ ok: true }, { ok: true }]);
    expect(results.map(r => r.ref)).toEqual(["p_7777777777776", "p_aeaqcaibaeaqc"]);
    expect(ledger.rows.map(r => r.ref)).toEqual(["p_aaaaaaaaaaaaa", "p_7777777777776", "p_aeaqcaibaeaqc"]);
    expect(entropy.sizes).toEqual([8, 8, 8, 8]); expect(entropy.octets).toEqual([]);
    expect(quote).toHaveBeenCalledTimes(2);
  } finally { entropy.octets = []; ledger.close(); session.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); }
});
