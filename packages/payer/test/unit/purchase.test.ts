import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { openLedger, rowHash } from "../../src/store/ledger.js";
import { realFs, type StoreFs } from "../../src/store/fs.js";
import { Session } from "../../src/daemon/session.js";
import { createDaemonHandler } from "../../src/daemon/handler.js";
import { recordHash } from "../../src/daemon/record.js";
import { createPurchaseCore } from "../../src/daemon/purchase.js";
import type { DaemonContext } from "../../src/daemon/interfaces.js";
import { h1Quote } from "../harness/router.js";
import { containsSecret, encodeSecret, encodings, secretBody } from "../harness/secret-cases.js";

function fixture(fs: StoreFs = realFs, phrase = "fixture-only") {
  const dir = mkdtempSync(path.join(tmpdir(), "p3b-")); const key = randomBytes(32);
  const ledger = openLedger(path.join(dir, "ledger.ndjson"), key, fs);
  const session = new Session(randomBytes(32)); const response = h1Quote();
  const counts = { ui: 0, sign: 0, purchase: 0 }; let approve = true;
  const context: DaemonContext = { session, ledger, address: `0x${"33".repeat(20)}`, phrase, assertHeld() {},
    purchase: { routerUrl: "https://fixture.invalid/mcp", canonicalResource: { url: "http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource", method: "GET" as const }, generateRef: () => "p_aaaaaaaaaaaaa",
      ui: { available: async () => true, confirm: async (r) => { counts.ui++; expect(ledger.rows.map(x => x.state)).toEqual(["quoted"]); return approve ? { approved: true, recordHash: recordHash(r), uiKind: "native" } : { approved: false }; } },
      signer: { sign: async () => { counts.sign++; expect(ledger.rows.at(-1)?.state).toBe("sign_intent"); return "fixture-credential"; } } },
    router: { listRoutes: async () => ({}), quote: async () => response, status: async () => ({ kind: "not_found", reason: "not_found" }),
      purchase: async () => { counts.purchase++; expect(ledger.rows.at(-1)?.state).toBe("submit_intent"); return { ok: true, outcome: "delivered", paymentId: response.quote.paymentId, snapshot: { value: "fixture" }, contentType: "application/json" }; } },
  };
  return { context, response, counts, reopen() { ledger.close(); return openLedger(path.join(dir, "ledger.ndjson"), key, realFs); }, cancel() { approve = false; }, close() { session.close(); ledger.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); } };
}
for (const source of ["challenge", "quoted-phrase", "backslash-phrase"] as const)
for (const encoding of encodings)
for (const location of ["key", "value"] as const) test(`initial body refuses ${source}/${encoding}/${location}, including restart`, async () => {
  const f = fixture(realFs, source === "quoted-phrase" ? 'alpha"beta' : "alpha\\beta"); let reopened;
  try {
    const secret = source === "challenge" ? JSON.stringify(f.response.quote.source.offer) : f.context.phrase;
    const encoded = encodeSecret(secret, encoding);
    if (source === "challenge" && encoding === "base64") expect(encoded.includes(Buffer.from(f.response.quote.source.offer.extra.challengeNonce).toString("base64"))).toBe(false);
    f.context.router.purchase = async () => { f.counts.purchase++; return { ok: true, outcome: "delivered", paymentId: f.response.quote.paymentId, contentType: "application/json", snapshot: secretBody(encoded, location) }; };
    const core = createPurchaseCore(f.context); await core.quote();
    const reply = await core.purchase("p_aaaaaaaaaaaaa");
    expect(containsSecret(reply, secret)).toBe(false);
    expect(reply).toMatchObject({ state: "unknown" });
    reopened = f.reopen();
    const next = createPurchaseCore({ ...f.context, ledger: reopened });
    const replay = await next.status("p_aaaaaaaaaaaaa", true);
    expect(containsSecret(replay, secret)).toBe(false); expect(replay).toMatchObject({ state: "unknown" });
    await next.purchase("p_aaaaaaaaaaaaa"); expect(f.counts.purchase).toBe(1);
  } finally { reopened?.close(); f.close(); }
});
test("actual handler connects durable seven states; concurrent duplicate signs and purchases once", async () => {
  const f = fixture(); try {
    const h = createDaemonHandler(f.context);
    const q: any = await h({ id: 1, method: "quote", params: { routeId: "md-mpp-eth-snapshot" } });
    expect(q.ok).toBe(true);
    const req = { id: 2, method: "purchase" as const, params: { ref: q.ref } };
    const [a,b] = await Promise.all([h(req), h(req)]); expect(a).toEqual(b);
    expect(a).toMatchObject({ state: "result", outcome: "delivered" });
    expect(f.counts).toEqual({ ui: 1, sign: 1, purchase: 1 });
    const rows = f.context.ledger.rows;
    expect(rows.map(r => r.state)).toEqual(["quoted", "approved", "sign_intent", "signed", "submit_intent", "submitted", "result"]);
    rows.slice(1).forEach((r,i) => expect(r.prev).toBe(rows[i]!.hash));
    rows.forEach(({ hash, ...row }) => expect(rowHash(row)).toBe(hash));
    expect(JSON.stringify(rows)).not.toContain("fixture-credential");
    expect(f.context.ledger.openSealed(rows[3]!)?.toString()).toContain("fixture-credential");
    expect(await h({ id: 3, method: "status", params: { ref: q.ref } })).toEqual(a);
  } finally { f.close(); }
});
test("cancel has no approved row and no signer", async () => { const f = fixture(); try {
  f.cancel(); const core = createPurchaseCore(f.context); await core.quote();
  expect(await core.purchase("p_aaaaaaaaaaaaa")).toMatchObject({ error: "approval_rejected" });
  expect(f.counts).toEqual({ ui: 1, sign: 0, purchase: 0 }); expect(f.context.ledger.rows).toHaveLength(1);
} finally { f.close(); } });

for (const mode of ["locked", "expired", "hash", "unavailable", "lock_lost", "store_failed"] as const) test(`UI boundary refuses ${mode} with signer zero`, async () => {
  const f = fixture(); try {
    const p = f.context.purchase!; const confirm = p.ui.confirm!;
    if (mode === "unavailable") p.ui.available = async () => false;
    else p.ui.confirm = async (r, phrase) => {
      const answer = await confirm(r, phrase);
      if (mode === "locked") f.context.session.close();
      if (mode === "expired") clockSpy = vi.spyOn(Date, "now").mockReturnValue(r.approvalDeadlineMs);
      if (mode === "lock_lost") f.context.assertHeld = () => { throw new StoreError("lock_lost"); };
      if (mode === "store_failed") Object.defineProperty(f.context.ledger, "writeFailed", { get: () => true });
      return mode === "hash" ? { approved: true, recordHash: "0".repeat(64), uiKind: "native" } : answer;
    };
    const core = createPurchaseCore(f.context); await core.quote();
    expect(await core.purchase("p_aaaaaaaaaaaaa")).toMatchObject({ ok: false });
    expect(f.counts.sign).toBe(0); expect(f.counts.purchase).toBe(0);
    expect(f.context.ledger.rows).toHaveLength(1);
  } finally { clockSpy?.mockRestore(); clockSpy = undefined; f.close(); }
});
import { vi } from "vitest";
import { StoreError } from "../../src/store/fs.js";
let clockSpy: ReturnType<typeof vi.spyOn> | undefined;

test("caller mutation during UI cannot replace sealed quote, record or subject", async () => {
  const f = fixture(); try {
    const confirm = f.context.purchase!.ui.confirm!;
    f.context.purchase!.ui.confirm = async (r, phrase) => {
      expect(() => { (r.source as any).amount = "1"; }).toThrow();
      f.response.quote.source.offer.amount = "1"; f.response.subject.source.amount = "2";
      return confirm(r, phrase);
    };
    f.context.purchase!.signer.sign = async (offer: any) => { f.counts.sign++; expect(offer.amount).toBe("10000"); return "fixture-credential"; };
    const core = createPurchaseCore(f.context); await core.quote();
    expect(await core.purchase("p_aaaaaaaaaaaaa")).toMatchObject({ outcome: "delivered" });
    const raw = JSON.parse(f.context.ledger.openSealed(f.context.ledger.rows[0]!)!.toString());
    expect(raw.quote.source.offer.amount).toBe("10000");
  } finally { f.close(); }
});
for (const stage of ["sign", "send", "malformed", "secret-result"] as const) test(`uncertain ${stage} is durable unknown without retries`, async () => {
  const f = fixture(); try {
    if (stage === "sign") f.context.purchase!.signer.sign = async () => { f.counts.sign++; throw new Error("secret-credential"); };
    else f.context.router.purchase = async () => { f.counts.purchase++; if (stage === "send") throw new Error("secret-credential"); return stage === "malformed" ? { ok: true, outcome: "delivered", paymentId: "wrong" } : { ok: true, outcome: "delivered", paymentId: f.response.quote.paymentId, contentType: "application/json", snapshot: { leak: "fixture-credential" } }; };
    const core = createPurchaseCore(f.context); await core.quote();
    const a = await core.purchase("p_aaaaaaaaaaaaa"); expect(a).toMatchObject({ state: "unknown", fundsMoved: "maybe" });
    expect(await core.purchase("p_aaaaaaaaaaaaa")).toEqual(a);
    expect(f.context.ledger.rows.at(-1)?.state).toBe("unknown");
    expect(f.counts.sign).toBe(1); expect(f.counts.purchase).toBe(stage === "sign" ? 0 : 1);
    expect(JSON.stringify(a)).not.toContain("secret");
  } finally { f.close(); }
});
for (const point of ["before:sign_intent", "after:sign_intent", "before:submit_intent", "after:submit_intent"]) test(`guard rechecked at ${point}`, async () => {
  const f = fixture(); try {
    const c = { ...f.context, purchase: { ...f.context.purchase!, faults: { hit: async (p: string) => { if (p === point) f.context.session.close(); } } } };
    const core = createPurchaseCore(c); await core.quote(); await core.purchase("p_aaaaaaaaaaaaa");
    expect(f.counts.sign).toBe(point.includes("submit") ? 1 : 0); expect(f.counts.purchase).toBe(0);
  } finally { f.close(); }
});
test("ledger write failure before sign has zero subsequent side effects", async () => {
  const f = fixture(); try {
    const append = f.context.ledger.append;
    f.context.ledger.append = input => { if (input.state === "sign_intent") throw new StoreError("store_write_failed"); return append(input); };
    const core = createPurchaseCore(f.context); await core.quote();
    expect(await core.purchase("p_aaaaaaaaaaaaa")).toMatchObject({ error: "store_write_failed" });
    expect(f.counts.sign).toBe(0); expect(f.counts.purchase).toBe(0);
  } finally { f.close(); }
});
test("ref reservation checks ledger and concurrent requests, requestId is daemon UUID", async () => {
  const f = fixture(); try {
    // Retain an actual durable quote; malformed placeholder records now correctly refuse startup.
    expect(await createPurchaseCore(f.context).quote()).toMatchObject({ ref: "p_aaaaaaaaaaaaa" });
    const refs = ["p_aaaaaaaaaaaaa", "p_bbbbbbbbbbbba", "p_bbbbbbbbbbbba", "p_cccccccccccca"];
    const requestIds: string[] = [];
    f.context.router.quote = async (_, requestId) => { requestIds.push(requestId); await Promise.resolve(); return h1Quote(); };
    const core = createPurchaseCore({ ...f.context, purchase: { ...f.context.purchase!, generateRef: () => refs.shift()! } });
    const responses: any[] = await Promise.all([core.quote(), core.quote()]);
    expect(responses.map(r => r.ref)).toEqual(["p_bbbbbbbbbbbba", "p_cccccccccccca"]);
    expect(responses.every(r => r.ref.length === 15)).toBe(true);
    expect(new Set(requestIds).size).toBe(2); requestIds.forEach(id => expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
  } finally { f.close(); }
});
test("production default generates canonical refs; fixed generator cannot overwrite ledger", async () => {
  const f = fixture(); try {
    const { generateRef: _, ...config } = f.context.purchase!;
    const generated: any = await createPurchaseCore({ ...f.context, purchase: config }).quote();
    expect(generated).toMatchObject({ ok: true });
    expect(generated.ref).toMatch(/^p_[a-z2-7]{12}[acegikmoqsuwy246]$/);
    expect(f.context.ledger.rows).toHaveLength(1);
    const core = createPurchaseCore(f.context); expect(await core.quote()).toMatchObject({ ok: true });
    expect(await core.quote()).toMatchObject({ error: "approval_unavailable" }); expect(f.context.ledger.rows).toHaveLength(2);
  } finally { f.close(); }
});
test("status shares mutex and returns sealed saved full result only when requested", async () => {
  const f = fixture(); try {
    const core = createPurchaseCore(f.context); await core.quote();
    const [purchase, status] = await Promise.all([core.purchase("p_aaaaaaaaaaaaa"), core.status("p_aaaaaaaaaaaaa", false)]);
    expect(status).toEqual(purchase);
    expect(await core.status("p_aaaaaaaaaaaaa", true)).toMatchObject({ result: { body: { value: "fixture" } } });
    f.context.session.close(); expect(await core.purchase("p_aaaaaaaaaaaaa")).toEqual(purchase);
    expect(f.context.ledger.openSealed(f.context.ledger.rows.at(-1)!)?.toString()).toContain('"body":{"value":"fixture"}');
  } finally { f.close(); }
});

test("handler status cannot overtake an already requested purchase", async () => {
  const f = fixture(); try {
    const h = createDaemonHandler(f.context); await h({ id: 1, method: "quote", params: { routeId: "md-mpp-eth-snapshot" } });
    const [a,b] = await Promise.all([
      h({ id: 2, method: "purchase", params: { ref: "p_aaaaaaaaaaaaa" } }),
      h({ id: 3, method: "status", params: { ref: "p_aaaaaaaaaaaaa" } }),
    ]);
    expect(a).toMatchObject({ outcome: "delivered" }); expect(b).toEqual(a);
  } finally { f.close(); }
});

test("closed/reopened ledger verifies the seven rows and decrypts saved full result", async () => {
  const f = fixture(); try {
    const core = createPurchaseCore(f.context); await core.quote(); await core.purchase("p_aaaaaaaaaaaaa");
    const head = f.context.ledger.head; const reopened = f.reopen();
    try {
      expect(reopened.head).toBe(head); expect(reopened.rows).toHaveLength(7);
      const saved = JSON.parse(reopened.openSealed(reopened.rows[6]!)!.toString());
      expect(saved.result).toEqual(await core.status("p_aaaaaaaaaaaaa", true));
    } finally { reopened.close(); }
  } finally { f.close(); }
});
test("real ledger fsync EIO latches store failure before signer; no later operation signs", async () => {
  let failed = false;
  const f = fixture({ ...realFs, fsyncSync(fd) { if (failed) throw Object.assign(new Error("fixture EIO"), { code: "EIO" }); realFs.fsyncSync(fd); } });
  try {
    const confirm = f.context.purchase!.ui.confirm!;
    f.context.purchase!.ui.confirm = async (r, phrase) => { const answer = await confirm(r, phrase); failed = true; return answer; };
    const core = createPurchaseCore(f.context); await core.quote();
    expect(await core.purchase("p_aaaaaaaaaaaaa")).toMatchObject({ error: "store_write_failed" });
    expect(f.context.ledger.writeFailed).toBe(true);
    expect(await core.quote()).toMatchObject({ error: "store_write_failed" });
    expect(f.counts.sign).toBe(0); expect(f.counts.purchase).toBe(0);
  } finally { f.close(); }
});
test("separate quote requires its own record hash; old approval cannot authorize it", async () => {
  const f = fixture(); try {
    let next = 0; let oldHash = "";
    f.context.purchase!.ui.confirm = async record => { f.counts.ui++; return { approved: true, recordHash: oldHash, uiKind: "native" }; };
    const core = createPurchaseCore({ ...f.context, purchase: { ...f.context.purchase!, generateRef: () => next++ ? "p_bbbbbbbbbbbba" : "p_aaaaaaaaaaaaa" } });
    await core.quote(); oldHash = recordHash(f.context.ledger.rows[0]!.data as any);
    await core.quote(); expect(await core.purchase("p_bbbbbbbbbbbba")).toMatchObject({ error: "approval_mismatch" });
    expect(f.counts.sign).toBe(0); expect(f.counts.purchase).toBe(0);
  } finally { f.close(); }
});

test("Router receives the exact retained quote and daemon requestId/approval, once", async () => {
  const f = fixture(); try {
    let issuedRequestId = "";
    f.context.router.quote = async (_, id) => { issuedRequestId = id; return f.response; };
    const original = structuredClone(f.response.quote);
    f.context.router.purchase = async input => {
      expect(input).toEqual({ quoteId: original.quoteId, requestId: issuedRequestId, approval: original.quoteId, credential: "fixture-credential", quote: original });
      f.counts.purchase++; return { ok: true, outcome: "delivered", paymentId: original.paymentId, snapshot: { data: true }, contentType: "application/json; charset=utf-8" };
    };
    const core = createPurchaseCore(f.context); await core.quote();
    expect(await core.purchase("p_aaaaaaaaaaaaa")).toMatchObject({ state: "result", proof: { upstreamReceipt: "none", onChainFinality: "not_checked" } });
    expect(f.counts.purchase).toBe(1);
  } finally { f.close(); }
});

test("trusted resource config is copied before awaits and retained in approval hash", async () => {
  const f = fixture(); try {
    const core = createPurchaseCore(f.context);
    const resource = f.context.purchase!.canonicalResource!;
    (resource as { url: string }).url = "https://hostile.invalid/v1/routes/md-mpp-eth-snapshot/resource";
    expect(await core.quote()).toMatchObject({ ok: true });
    expect((f.context.ledger.rows[0]!.data as any).resource.url).toBe("http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource");
    expect(await core.purchase("p_aaaaaaaaaaaaa")).toMatchObject({ outcome: "delivered" });
    expect(f.counts).toEqual({ ui: 1, sign: 1, purchase: 1 });
  } finally { f.close(); }
});
