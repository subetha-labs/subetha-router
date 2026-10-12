import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { openLedger } from "../../src/store/ledger.js";
import { realFs, type StoreFs } from "../../src/store/fs.js";
import { Session } from "../../src/daemon/session.js";
import { createPurchaseCore } from "../../src/daemon/purchase.js";
import { buildRecord, jsonCopy, recordHash } from "../../src/daemon/record.js";
import type { DaemonContext } from "../../src/daemon/interfaces.js";
import { statusOf, type RouterStatus } from "../../src/router/client.js";
import { h1Quote } from "../harness/router.js";
import { containsSecret, encodeSecret, encodings, secretBody } from "../harness/secret-cases.js";

function fixture(last = "signed", fs: StoreFs = realFs, phrase = "fixture-phrase") {
  const dir = mkdtempSync(path.join(tmpdir(), "p3c-unit-")), file = path.join(dir, "ledger.ndjson"), key = randomBytes(32);
  let ledger = openLedger(file, key, realFs);
  const raw = h1Quote(), ref = "p_aaaaaaaaaaaaa", address = `0x${"33".repeat(20)}`;
  const r = buildRecord(raw, { routerUrl: "https://fixture.invalid/mcp", canonicalResource: raw.quote.resource as any, address, ref, requestId: randomUUID() });
  const hash = recordHash(r);
  const states = ["quoted", "approved", "sign_intent", "signed", "submit_intent"];
  for (const state of states.slice(0, states.indexOf(last) + 1)) {
    const data = state === "quoted" ? jsonCopy(r) : state === "approved" ? { recordHash: hash, shownAt: Date.now(), uiKind: "native" } : { recordHash: hash };
    const sealed = state === "quoted" ? raw : state === "signed" ? { credential: "fixture-credential" } : undefined;
    ledger.append({ ref, state, data: jsonCopy(data), ...(sealed ? { sealedPlain: Buffer.from(JSON.stringify(sealed)) } : {}) });
  }
  ledger.close(); ledger = openLedger(file, key, fs);
  const counts = { sign: 0, purchase: 0, ui: 0, status: 0, quote: 0 };
  const session = new Session(randomBytes(32)); let status: RouterStatus = { kind: "not_found", reason: "not_found" };
  const context: DaemonContext = { ledger, session, address, wallets: { eip155: address }, phrase, assertHeld() {}, purchase: {
    routerUrl: r.routerUrl, canonicalResource: r.resource, ui: { available: async () => true, confirm: async rec => { counts.ui++; return { approved: true, recordHash: recordHash(rec), uiKind: "native" }; } },
    signer: { sign: async () => { counts.sign++; return { credential: "fixture-credential" }; } },
  }, router: { listRoutes: async () => ({}), quote: async () => { counts.quote++; return raw; }, quoteUrl: async () => ({ ok: false, error: "unknown_route" }), status: async () => { counts.status++; return status; }, purchase: async input => { counts.purchase++; expect(input.credential === "fixture-credential").toBe(true); expect(ledger.rows.at(-1)?.state).toBe("submit_intent"); return { ok: true, outcome: "delivered", paymentId: r.paymentId, snapshot: { value: "retained" }, contentType: "application/json" }; } } };
  return { context, counts, raw, r, ref, file, setStatus(s: RouterStatus) { status = s; }, reopen() { ledger.close(); ledger = openLedger(file, key, realFs); return { ...context, ledger }; }, close() { ledger.close(); session.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); } };
}
for (const source of ["challenge", "quoted-phrase", "backslash-phrase"] as const)
for (const encoding of encodings)
for (const location of ["key", "value"] as const)
for (const path of ["status", "saved"] as const) test(`${path} body refuses ${source}/${encoding}/${location}`, async () => {
  const f = fixture("submit_intent", realFs, source === "quoted-phrase" ? 'alpha"beta' : "alpha\\beta");
  try {
    const secret = source === "challenge" ? JSON.stringify(f.raw.quote.source.offer) : f.context.phrase;
    const encoded = encodeSecret(secret, encoding), body = secretBody(encoded, location);
    if (source === "challenge" && encoding === "base64") expect(encoded.includes(Buffer.from(f.r.source.challengeNonce).toString("base64"))).toBe(false);
    if (path === "saved") {
      // Authenticated legacy result with the exact response/body shape; no production guard mutation.
      const text = JSON.stringify(body);
      const result = { ok: true, ref: f.ref, state: "result", outcome: "delivered", paymentId: f.r.paymentId, fundsMoved: "yes", result: { untrusted: true, source: "upstream", contentType: "application/json", body, preview: text.slice(0, 512), bytes: Buffer.byteLength(text) }, proof: { upstreamReceipt: "none", onChainFinality: "not_checked" }, nextStep: "delivered" };
      const response = { ok: true, outcome: "delivered", paymentId: f.r.paymentId, snapshot: body, contentType: "application/json" };
      for (const state of ["submitted", "result"]) f.context.ledger.append({ ref: f.ref, state, data: { paymentId: f.r.paymentId, outcome: "delivered" }, sealedPlain: Buffer.from(JSON.stringify(state === "submitted" ? { response, result } : { result })) });
      const before = readFileSync(f.file), core = createPurchaseCore(f.reopen());
      await expect(core.recover()).rejects.toThrow("store_corrupt");
      await expect(core.status(f.ref, true)).rejects.toThrow("store_corrupt");
      expect(readFileSync(f.file).equals(before)).toBe(true);
      expect(f.counts.status).toBe(0);
    } else {
      const status = found(f); if (status.kind !== "found") throw new Error("fixture_status"); status.projection["result"] = body; f.setStatus(status);
      const core = createPurchaseCore(f.context); await core.recover();
      const reply = await core.status(f.ref, true);
      expect(containsSecret(reply, secret)).toBe(false); expect(reply).toMatchObject({ state: "unknown" });
      const next = createPurchaseCore(f.reopen()); await next.recover();
      const replay = await next.status(f.ref, true);
      expect(containsSecret(replay, secret)).toBe(false); expect(replay).toMatchObject({ state: "unknown" });
      await next.purchase(f.ref);
    }
    expect(f.counts).toMatchObject({ purchase: 0, sign: 0 });
  } finally { f.close(); }
});

test("ordinary nested body survives changed phrase and offline replay; new current phrase is checked without persistence", async () => {
  const f = fixture("submit_intent");
  try {
    const body = secretBody('ordinary"text\\path', "key"), status = found(f);
    if (status.kind !== "found") throw new Error("fixture_status"); status.projection["result"] = body; f.setStatus(status);
    const core = createPurchaseCore(f.context); await core.recover();
    expect(await core.status(f.ref, true)).toMatchObject({ result: { body } });
    const phrase = 'changed"phrase\\safe'; f.setStatus({ kind: "unreadable", reason: "router_unavailable" });
    const next = createPurchaseCore({ ...f.reopen(), phrase }); await next.recover();
    expect(await next.status(f.ref, true)).toMatchObject({ result: { body } });
    const before = readFileSync(f.file);
    expect(containsSecret(before.toString(), phrase)).toBe(false);
    await expect(createPurchaseCore({ ...f.reopen(), phrase: 'ordinary"text\\path' }).recover()).rejects.toThrow("store_corrupt");
    expect(readFileSync(f.file).equals(before)).toBe(true);
    expect(f.counts).toMatchObject({ purchase: 0, sign: 0, status: 1 });
  } finally { f.close(); }
});
function found(f: ReturnType<typeof fixture>, state = "delivered"): RouterStatus {
  return statusOf({ found: true, projection: { paymentId: f.r.paymentId, routeId: f.r.routeId, quoteFingerprint: f.r.destination.quoteFingerprint, source: { amount: f.r.source.amount, asset: f.r.source.asset, network: f.r.source.network, txRef: "learned-after-settlement" }, destination: { quoted: f.r.destination.quoted, asset: f.r.destination.asset, network: f.r.destination.network, attempt: 1, outcome: "paid" }, status: state, updatedAt: new Date().toISOString(), result: { value: "retained" } } });
}
test("signed rehydrates encrypted ledger: concurrent recovery/purchase submits once, result reopens offline", async () => {
  const f = fixture(); try { const core = createPurchaseCore(f.context); await Promise.all([core.recover(), core.purchase(f.ref), core.recover()]); expect(f.counts).toMatchObject({ sign: 0, purchase: 1, ui: 0, quote: 0 }); const reopened = createPurchaseCore(f.reopen()); f.setStatus({ kind: "unreadable", reason: "router_unavailable" }); await reopened.recover(); expect(await reopened.status(f.ref, true)).toMatchObject({ outcome: "delivered", result: { body: { value: "retained" } }, proof: { onChainFinality: "not_checked" } }); await reopened.purchase(f.ref); expect(f.counts.purchase).toBe(1); } finally { f.close(); }
});
for (const state of ["quoted", "approved"]) test(`${state} requires fresh UI and no new quote`, async () => { const f = fixture(state); try { const core = createPurchaseCore(f.context); await core.recover(); expect(f.counts.ui).toBe(0); await core.purchase(f.ref); await core.purchase(f.ref); expect(f.counts).toMatchObject({ ui: 1, sign: 1, purchase: 1, quote: 0 }); } finally { f.close(); } });
for (const state of ["sign_intent", "submit_intent"]) test(`${state} never resends and unknown survives reopen`, async () => { const f = fixture(state); try { let core = createPurchaseCore(f.context); await core.recover(); expect(await core.purchase(f.ref)).toMatchObject({ state: "unknown" }); core = createPurchaseCore(f.reopen()); await core.recover(); expect(await core.status(f.ref, false)).toMatchObject({ state: "unknown" }); expect(f.counts).toMatchObject({ sign: 0, purchase: 0 }); } finally { f.close(); } });
for (const reason of ["unauthorized", "projection_malformed", "transport_failed", "router_unavailable", "unknown_code"]) test(`signed ${reason} is not absence`, async () => { const f = fixture(); try { f.setStatus(statusOf({ found: false, reason })); const core = createPurchaseCore(f.context); await core.recover(); expect(await core.purchase(f.ref)).toMatchObject({ state: "unknown" }); expect(f.counts.purchase).toBe(0); } finally { f.close(); } });
for (const field of ["paymentId", "routeId", "quoteFingerprint", "amount", "asset", "network"]) test(`valid different ${field} fails identity; matching positive control`, async () => {
  const f = fixture("submit_intent"); try { const good = found(f), bad = structuredClone(good) as any; const values: Record<string,string> = { paymentId: randomUUID(), routeId: "md-other", quoteFingerprint: `sha256:${"ef".repeat(32)}`, amount: "10001", asset: `0x${"44".repeat(20)}`, network: "eip155:1" }; if (["amount", "asset", "network"].includes(field)) bad.projection.source[field] = values[field]; else bad.projection[field] = values[field]; f.setStatus(bad); const core = createPurchaseCore(f.context); await core.recover(); expect(await core.purchase(f.ref)).toMatchObject({ state: "unknown" }); f.setStatus(good); expect(await core.status(f.ref, true)).toMatchObject({ outcome: "delivered" }); expect(f.counts.purchase).toBe(0); } finally { f.close(); }
});
for (const outcome of ["delivered", "paid_data_unavailable", "rejected", "awaiting_payment", "settling", "unknown"]) test(`submit_intent found ${outcome}`, async () => { const f = fixture("submit_intent"); try { f.setStatus(found(f, outcome)); const core = createPurchaseCore(f.context); await core.recover(); expect(await core.status(f.ref, true)).toMatchObject({ state: ["delivered", "paid_data_unavailable", "rejected"].includes(outcome) ? "result" : "unknown" }); expect(f.counts.purchase).toBe(0); } finally { f.close(); } });
test("unknown cannot resolve to rejected; internal close is durable and terminal", async () => { const f = fixture("sign_intent"); try { const core = createPurchaseCore(f.context); await core.recover(); f.setStatus(found(f, "rejected")); expect(await core.status(f.ref, false)).toMatchObject({ state: "unknown" }); await core.closeByOperator(f.ref, "owner inspected local evidence"); const reopened = createPurchaseCore(f.reopen()); await reopened.recover(); f.setStatus(found(f)); expect(await reopened.status(f.ref, false)).toMatchObject({ state: "closed_by_operator" }); } finally { f.close(); } });
test("invalid sequence refuses repeat initialization and preserves evidence", async () => { const f = fixture("quoted"); try { f.context.ledger.append({ ref: f.ref, state: "submit_intent", data: { recordHash: recordHash(f.r) } }); const before = readFileSync(f.file), core = createPurchaseCore(f.context); await expect(core.recover()).rejects.toThrow("store_corrupt"); await expect(core.recover()).rejects.toThrow("store_corrupt"); await expect(core.purchase(f.ref)).rejects.toThrow("store_corrupt"); expect(readFileSync(f.file).equals(before)).toBe(true); expect(f.counts.purchase).toBe(0); } finally { f.close(); } });

test("rollback after submit_intent fsync but before transport forbids submission", async () => {
  const f = fixture(); const before = readFileSync(f.file);
  try {
    const context = { ...f.context, purchase: { ...f.context.purchase!, faults: { hit: async (point: string) => { if (point === "after:submit_intent") writeFileSync(f.file, before); } } } };
    await expect(createPurchaseCore(context).recover()).rejects.toThrow("store_rollback");
    expect(f.counts.purchase).toBe(0);
  } finally { f.close(); }
});
for (const state of ["quoted", "approved", "signed"]) test(`${state} expired restart never signs or submits`, async () => {
  const f = fixture(state); const now = vi.spyOn(Date, "now").mockReturnValue(f.r.approvalDeadlineMs + 1);
  try { const core = createPurchaseCore(f.context); await core.recover(); expect(await core.purchase(f.ref)).toMatchObject({ state: state === "signed" ? "expired_after_sign" : "expired" }); expect(f.counts).toMatchObject({ sign: 0, purchase: 0, ui: 0 }); } finally { now.mockRestore(); f.close(); }
});
for (const changed of ["wallet", "transport", "resource"]) test(`configured ${changed} mismatch preserves all bytes and refuses repeat init`, async () => {
  const f = fixture();
  try {
    const context = { ...f.context, purchase: { ...f.context.purchase! } };
    if (changed === "wallet") context.address = `0x${"44".repeat(20)}`;
    if (changed === "transport") context.purchase.routerUrl = "https://other.invalid/mcp";
    if (changed === "resource") context.purchase.canonicalResource = { url: "http://localhost:8500/v1/routes/md-mpp-eth-snapshot/resource", method: "GET" };
    const before = readFileSync(f.file), core = createPurchaseCore(context);
    await expect(core.recover()).rejects.toThrow("store_corrupt"); await expect(core.purchase(f.ref)).rejects.toThrow("store_corrupt");
    expect(readFileSync(f.file).equals(before)).toBe(true); expect(f.counts.purchase).toBe(0);
  } finally { f.close(); }
});

for (const errno of ["EROFS", "EIO"]) test(`${errno} intent write failure latches zero subsequent side effects`, async () => {
  let armed = false;
  const fail = () => { throw Object.assign(new Error("fixture disk failure"), { code: errno }); };
  const f = fixture("quoted", { ...realFs, writeSync(fd, data) { return armed && errno === "EROFS" ? fail() : realFs.writeSync(fd, data); }, fsyncSync(fd) { if (armed && errno === "EIO") fail(); realFs.fsyncSync(fd); } });
  try {
    const core = createPurchaseCore({ ...f.context, purchase: { ...f.context.purchase!, faults: { hit: async point => { if (point === "before:sign_intent") armed = true; } } } });
    await core.recover(); expect(await core.purchase(f.ref)).toMatchObject({ error: "store_write_failed" });
    expect(f.context.ledger.writeFailed).toBe(true); await core.purchase(f.ref); await core.quote({ routeId: "md-mpp-eth-snapshot" });
    expect(f.counts).toMatchObject({ sign: 0, purchase: 0 });
  } finally { f.close(); }
});

for (const changed of ["legacy_ref", "missing_raw", "record_hash", "wallet_record", "missing_credential", "extra_credential_field", "unsafe_sequence"]) test(`durable ${changed} corruption fails before all replay and stays byte-preserved`, async () => {
  const f = fixture();
  const { rowHash, GENESIS_HASH } = await import("../../src/store/ledger.js");
  try {
    const rows = JSON.parse("[" + readFileSync(f.file, "utf8").trim().split("\n").join(",") + "]");
    if (changed === "legacy_ref") rows[0].ref = "p_aaaaaaaaaaa";
    if (changed === "missing_raw") delete rows[0].sealed;
    if (changed === "record_hash") rows[1].data.recordHash = "00".repeat(32);
    if (changed === "wallet_record") rows[0].data.wallet.address = `0x${"44".repeat(20)}`;
    if (changed === "missing_credential") delete rows[3].sealed;
    if (changed === "extra_credential_field") {
      // An extra plaintext field in the signed data is independently forbidden.
      rows[3].data.unexpected = true;
    }
    if (changed === "unsafe_sequence") rows[2].state = "submit_intent";
    let prev = GENESIS_HASH;
    for (const row of rows) { row.prev = prev; row.hash = rowHash(row); prev = row.hash; }
    writeFileSync(f.file, rows.map((row: unknown) => JSON.stringify(row)).join("\n") + "\n");
    const context = f.reopen(), before = readFileSync(f.file), core = createPurchaseCore(context);
    await expect(core.recover()).rejects.toThrow("store_corrupt");
    await expect(core.purchase(f.ref)).rejects.toThrow("store_corrupt");
    expect(readFileSync(f.file).equals(before)).toBe(true); expect(f.counts).toMatchObject({ sign: 0, purchase: 0, status: 0 });
  } finally { f.close(); }
});

test("invalid later ref blocks earlier eligible signed replay atomically", async () => {
  const f = fixture();
  try {
    f.context.ledger.append({ ref: "p_bbbbbbbbbbbba", state: "quoted", data: {} });
    const before = readFileSync(f.file), core = createPurchaseCore(f.context);
    await expect(core.recover()).rejects.toThrow("store_corrupt");
    await expect(core.purchase(f.ref)).rejects.toThrow("store_corrupt");
    expect(f.counts).toMatchObject({ sign: 0, purchase: 0, status: 0 }); expect(readFileSync(f.file).equals(before)).toBe(true);
  } finally { f.close(); }
});
