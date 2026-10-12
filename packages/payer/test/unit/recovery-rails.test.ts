/**
 * AC-R4 / AC-R4c / SR-R7 (docs/payer-rails-design.md): dynamic ownership on status reads, first submission after a crash in `signed`
 * when the Router answers `awaiting_payment`, the hosted MCP's wrapped dynamic result normalized through reconcile and reopen, the
 * Tempo `txRef` retained, and 0.1.x ledgers rebuilt by the frozen v1 builder.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { openLedger } from "../../src/store/ledger.js";
import { realFs } from "../../src/store/fs.js";
import { Session } from "../../src/daemon/session.js";
import { createPurchaseCore } from "../../src/daemon/purchase.js";
import { buildRecord, buildRecordV1, jsonCopy, recordHash, type ApprovalRecord } from "../../src/daemon/record.js";
import type { DaemonContext } from "../../src/daemon/interfaces.js";
import { statusOf, type RouterStatus } from "../../src/router/client.js";
import { HOSTED_ROUTER_URL } from "../../src/router/identity.js";
import { h1Quote, railQuote, type RailFixture, type RailQuoteResponse } from "../harness/router.js";

const EVM = `0x${"33".repeat(20)}`, SOLANA = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5", REF = "p_aaaaaaaaaaaaa";
const STATES = ["quoted", "approved", "sign_intent", "signed", "submit_intent"];

function fixture(response: RailQuoteResponse | ReturnType<typeof h1Quote>, last: string, options: { v1?: boolean; txRef?: string } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "rails-unit-")), file = path.join(dir, "ledger.ndjson"), key = randomBytes(32);
  let ledger = openLedger(file, key, realFs);
  const identity = { routerUrl: HOSTED_ROUTER_URL, address: EVM, wallets: { eip155: EVM, solana: SOLANA }, ref: REF, requestId: randomUUID() };
  const r: ApprovalRecord = options.v1 ? buildRecordV1(response, identity) : buildRecord(response, identity);
  const hash = recordHash(r);
  for (const state of STATES.slice(0, STATES.indexOf(last) + 1)) {
    const data = state === "quoted" ? jsonCopy(r) : state === "approved" ? { recordHash: hash, shownAt: Date.now(), uiKind: "native" } : { recordHash: hash };
    const sealed = state === "quoted" ? response : state === "signed" ? { credential: "fixture-credential", ...(options.txRef ? { txRef: options.txRef } : {}) } : undefined;
    ledger.append({ ref: REF, state, data: jsonCopy(data), ...(sealed ? { sealedPlain: Buffer.from(JSON.stringify(sealed)) } : {}) });
  }
  ledger.close(); ledger = openLedger(file, key, realFs);
  const counts = { sign: 0, purchase: 0, ui: 0, status: 0 }; const ownerKeys: (string | undefined)[] = [];
  const session = new Session(randomBytes(32)); let status: RouterStatus = { kind: "not_found", reason: "not_found" };
  const body = { value: "retained" };
  const dynamic = r.kind === "dynamic";
  const context: DaemonContext = { ledger, session, address: EVM, wallets: { eip155: EVM, solana: SOLANA }, phrase: "fixture-phrase", assertHeld() {}, purchase: {
    routerUrl: HOSTED_ROUTER_URL, ui: { available: async () => true, confirm: async rec => { counts.ui++; return { approved: true, recordHash: recordHash(rec), uiKind: "native" }; } },
    signer: { sign: async (offer) => { counts.sign++; return { credential: "fixture-credential", ...((offer as { scheme: string }).scheme === "tempo/charge" ? { txRef: `0x${"cd".repeat(32)}` } : {}) }; } },
  }, router: { listRoutes: async () => ({}), quote: async () => response, quoteUrl: async () => response,
    status: async (_paymentId, ownerKey) => { counts.status++; ownerKeys.push(ownerKey); return status; },
    purchase: async input => { counts.purchase++; expect(input.credential).toBe("fixture-credential"); expect((input.quote as { ownerKey?: string }).ownerKey).toBe((response.quote as { ownerKey?: string }).ownerKey);
      return dynamic ? { ok: true, outcome: "delivered", paymentId: r.paymentId, result: { untrusted: true, source: "upstream", contentType: "application/json", body }, proof: { upstreamReceipt: "claimed", onChainFinality: "not_checked" } }
        : { ok: true, outcome: "delivered", paymentId: r.paymentId, snapshot: body, contentType: "application/json" }; } } };
  const projection = (state: string, wrapped = dynamic) => statusOf({ found: true, projection: { paymentId: r.paymentId, routeId: r.routeId, quoteFingerprint: r.destination.quoteFingerprint, status: state, updatedAt: new Date().toISOString(),
    source: { amount: r.source.amount, asset: r.source.asset, network: r.source.network }, destination: { quoted: r.destination.quoted, asset: r.destination.asset, network: r.destination.network },
    ...(dynamic ? { dynamic: { upstreamHost: "x" } } : {}), ...(state === "delivered" ? { result: wrapped ? { untrusted: true, source: "upstream", contentType: "application/json", body } : body } : {}) } });
  return { context, counts, ownerKeys, r, body, file, projection, setStatus(s: RouterStatus) { status = s; }, reopen() { ledger.close(); ledger = openLedger(file, key, realFs); return { ...context, ledger }; }, close() { ledger.close(); session.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); } };
}

test("dynamic: status reads carry the sealed ownerKey; the Router's wrapped result is normalized, retained and reopened as a plain body", async () => {
  const response = railQuote("dyn-x402-to-mpp"); const f = fixture(response, "submit_intent");
  try {
    f.setStatus(f.projection("delivered"));
    const core = createPurchaseCore(f.context); await core.recover();
    expect(f.ownerKeys).toEqual([(response.quote as { ownerKey: string }).ownerKey]);
    const reply: any = await core.status(REF, true);
    expect(reply).toMatchObject({ state: "result", outcome: "delivered", result: { body: f.body }, proof: { upstreamReceipt: "claimed", onChainFinality: "not_checked" } });
    // Reopen: the stored projection compares equal to the body (normalized once, normalized again on replay).
    const next = createPurchaseCore(f.reopen()); await next.recover();
    expect(await next.status(REF, true)).toMatchObject({ state: "result", result: { body: f.body } });
    expect(f.counts).toMatchObject({ purchase: 0, sign: 0 });
    expect(readFileSync(f.file, "utf8")).not.toContain((response.quote as { ownerKey: string }).ownerKey);
  } finally { f.close(); }
});

test("dynamic: wrong ownerKey is not_found for the Router; from signed with not_found the payer submits ONCE and the purchase reply is unwrapped", async () => {
  const response = railQuote("dyn-sol-to-x402"); const f = fixture(response, "signed");
  try {
    const core = createPurchaseCore(f.context); await Promise.all([core.recover(), core.purchase(REF), core.recover()]);
    expect(f.counts).toMatchObject({ purchase: 1, sign: 0, ui: 0 });
    expect(await core.status(REF, true)).toMatchObject({ state: "result", outcome: "delivered", result: { body: f.body }, proof: { upstreamReceipt: "claimed" } });
    expect(f.context.ledger.rows.map(row => row.state)).toEqual(["quoted", "approved", "sign_intent", "signed", "submit_intent", "submitted", "result"]);
    const next = createPurchaseCore(f.reopen()); await next.recover();
    expect(await next.status(REF, true)).toMatchObject({ state: "result", result: { body: f.body } });
  } finally { f.close(); }
});

for (const fixtureName of ["tempo", "dyn-mpp-to-x402"] as RailFixture[]) test(`${fixtureName}: signed + awaiting_payment (MPP already sent) submits once; submit_intent + awaiting_payment never resends`, async () => {
  const response = railQuote(fixtureName);
  const f = fixture(response, "signed", { txRef: `0x${"ab".repeat(32)}` });
  try {
    f.setStatus(f.projection("awaiting_payment"));
    const core = createPurchaseCore(f.context); await core.recover();
    expect(f.counts.purchase).toBe(1);
    const reply: any = await core.status(REF, false);
    expect(reply).toMatchObject({ state: "result", outcome: "delivered", txRef: `0x${"ab".repeat(32)}`, fundsMoved: "yes" });
    // inspect never submits (allowSubmit false): a second fixture in `signed` reads awaiting_payment and stays unknown with fundsMoved maybe.
  } finally { f.close(); }
  const g = fixture(response, "submit_intent", { txRef: `0x${"ab".repeat(32)}` });
  try {
    g.setStatus(g.projection("awaiting_payment"));
    const core = createPurchaseCore(g.context); await core.recover();
    expect(g.counts.purchase).toBe(0);
    expect(await core.purchase(REF)).toMatchObject({ state: "unknown", fundsMoved: "maybe", txRef: `0x${"ab".repeat(32)}` });
    const inspection: any = await core.inspect(REF);
    expect(inspection.inspections[0].summary).toMatchObject({ state: "unknown", txRef: `0x${"ab".repeat(32)}` });
  } finally { g.close(); }
});

test("tempo: a fresh purchase records the signer's txRef in the signed seal and shows it from signed on, including after reopen", async () => {
  const response = railQuote("tempo"); const f = fixture(response, "quoted");
  try {
    const core = createPurchaseCore(f.context); await core.recover();
    const q: any = await core.purchase(REF);
    expect(q).toMatchObject({ state: "result", outcome: "delivered", txRef: `0x${"cd".repeat(32)}` });
    expect(f.counts).toMatchObject({ sign: 1, purchase: 1, ui: 1 });
    const next = createPurchaseCore(f.reopen()); await next.recover();
    expect(await next.status(REF, false)).toMatchObject({ state: "result", txRef: `0x${"cd".repeat(32)}` });
    // The plaintext ledger never carries the txRef or the credential (both sealed).
    const plain = f.context.ledger.rows.map(row => JSON.stringify(row.data)).join("\n");
    expect(plain).not.toContain("cd".repeat(32)); expect(plain).not.toContain("fixture-credential");
  } finally { f.close(); }
});

test("0.1.x ledger (v1 records, no kind): rebuilt by the frozen builder, pending purchase continues, result reopens", async () => {
  const response = h1Quote(); const f = fixture(response, "signed", { v1: true });
  try {
    expect((f.context.ledger.rows[0]!.data as { kind?: unknown }).kind).toBeUndefined();
    const core = createPurchaseCore(f.context); await core.recover();
    expect(f.counts).toMatchObject({ purchase: 1, sign: 0, ui: 0 });
    const reply: any = await core.status(REF, true);
    expect(reply).toMatchObject({ state: "result", outcome: "delivered", result: { body: f.body }, proof: { upstreamReceipt: "none" } });
    expect(reply.txRef).toBeUndefined();
    const next = createPurchaseCore(f.reopen()); await next.recover();
    expect(await next.status(REF, true)).toMatchObject({ state: "result", result: { body: f.body } });
    // A v1 `quoted` record that is still pending is approved and signed through the v2 core.
    const g = fixture(h1Quote(), "quoted", { v1: true });
    try {
      const pending = createPurchaseCore(g.context); await pending.recover();
      expect(await pending.purchase(REF)).toMatchObject({ state: "result", outcome: "delivered" });
      expect(g.counts).toMatchObject({ sign: 1, purchase: 1, ui: 1 });
    } finally { g.close(); }
  } finally { f.close(); }
});

test("tempo: a signer failure after sign_intent (the transfer may or may not have been sent) is a durable unknown with no second signing and no submission", async () => {
  const response = railQuote("tempo"); const f = fixture(response, "quoted");
  try {
    f.context.purchase!.signer.sign = async () => { f.counts.sign++; throw new Error("rpc transport refused (guarded)"); };
    const core = createPurchaseCore(f.context); await core.recover();
    expect(await core.purchase(REF)).toMatchObject({ state: "unknown", fundsMoved: "maybe", nextStep: "unknown_inspect" });
    expect(await core.purchase(REF)).toMatchObject({ state: "unknown" });
    expect(f.counts).toMatchObject({ sign: 1, purchase: 0, ui: 1 });
    expect(f.context.ledger.rows.map(row => row.state)).toEqual(["quoted", "approved", "sign_intent", "unknown"]);
    const next = createPurchaseCore(f.reopen()); await next.recover();
    expect(await next.purchase(REF)).toMatchObject({ state: "unknown", fundsMoved: "maybe" });
    expect(f.counts).toMatchObject({ sign: 1, purchase: 0 });
  } finally { f.close(); }
});
