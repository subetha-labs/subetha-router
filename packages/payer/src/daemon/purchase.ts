import { generateRef } from "./ref.js";
import { routerIdentity } from "../router/identity.js";
import { randomUUID } from "node:crypto";
import { failure, knownCodeOf, PurchaseRef, QuoteSummary, PurchaseSummary, PurchaseBodySummary } from "../protocol/summary.js";
import { StoreError } from "../store/fs.js";
import type { JsonValue } from "../store/ledger.js";
import { record, routerFailure, STATIC_ROUTE } from "../router/client.js";
import type { DaemonContext } from "./interfaces.js";
import { RefMutex } from "./server.js";
import { assertApproval, buildRecord, frozenCopy, jsonCopy, recordHash, subjectOf, type ApprovalRecord, type StaticQuote } from "./record.js";

type Entry = { record: ApprovalRecord; raw: JsonValue; hash: string; state: string; result?: PurchaseBodySummary; operation?: Promise<unknown> };
/** One instance per daemon; all reads and purchases share this mutex. Restart reconciliation is P-3c. */
export function createPurchaseCore(context: DaemonContext) {
  const entries = new Map<string, Entry>();
  const reservations = new Set<string>();
  const mutex = new RefMutex();
  const config = context.purchase;
  // Copy identity once: later mutation of the configuration cannot redirect an approved operation.
  const identity = config ? routerIdentity(config.routerUrl, config.canonicalResource) : undefined;
  const nextRef = config?.generateRef ?? generateRef;
  const wallet = context.address;
  function held(): void { context.assertHeld(); if (context.ledger.writeFailed) throw new StoreError("store_write_failed"); }
  function guard(e: Entry, hash = e.hash): void {
    held();
    const rebuilt = buildRecord(e.raw, { routerUrl: identity!.routerUrl, canonicalResource: identity!.resource, address: wallet, ref: e.record.ref, requestId: e.record.requestId }, 0);
    if (recordHash(rebuilt) !== e.hash || recordHash(e.record) !== e.hash) throw new StoreError("approval_mismatch");
    assertApproval(e.record, (e.raw as { quote: StaticQuote }).quote.source.offer, hash, context.session.locked);
  }
  async function append(e: Entry, state: string, data: JsonValue, sealed?: unknown, check?: () => void): Promise<void> {
    await config?.faults?.hit(`before:${state}`);
    held(); check?.();
    context.ledger.append({ ref: e.record.ref, state, data,
      ...(sealed === undefined ? {} : { sealedPlain: Buffer.from(JSON.stringify(sealed)) }) });
    e.state = state;
    await config?.faults?.hit(`after:${state}`);
  }
  function current(e: Entry, includeBody = false): unknown {
    if (e.result) {
      const value = structuredClone(e.result);
      if (!includeBody && value.result) {
        const { body: _, ...preview } = value.result;
        return PurchaseSummary.parse({ ...value, result: preview });
      }
      return (includeBody ? PurchaseBodySummary : PurchaseSummary).parse(value);
    }
    return PurchaseSummary.parse({ ok: false, ref: e.record.ref, paymentId: e.record.paymentId,
      state: e.state, fundsMoved: ["quoted", "approved"].includes(e.state) ? "no" : "maybe",
      ...(e.state === "unknown" ? { outcome: "unknown", nextStep: "unknown_inspect" } : {}) });
  }
  async function unknown(e: Entry): Promise<unknown> {
    e.state = "unknown";
    try { await append(e, "unknown", { reason: "transport_uncertain", paymentId: e.record.paymentId }); } catch { /* Durable intent remains the recovery authority. Never retry. */ }
    return current(e);
  }
  async function execute(e: Entry): Promise<unknown> {
    let intent = false;
    try {
      guard(e);
      if (!config?.ui.confirm || !await config.ui.available()) return failure("approval_unavailable");
      guard(e);
      const shownAt = Date.now();
      const approval = frozenCopy(await config.ui.confirm(e.record, context.phrase));
      guard(e);
      if (!approval || approval.approved !== true) return failure("approval_rejected");
      guard(e, approval.recordHash);
      if (approval.uiKind !== "native") throw new StoreError("approval_mismatch");
      await append(e, "approved", { recordHash: e.hash, shownAt, uiKind: approval.uiKind }, undefined, () => guard(e, approval.recordHash));
      await append(e, "sign_intent", { recordHash: e.hash }, undefined, () => guard(e, approval.recordHash));
      intent = true;
      guard(e, approval.recordHash);
      const credential = await config.signer.sign(structuredClone((e.raw as { quote: StaticQuote }).quote.source.offer));
      if (typeof credential !== "string" || !credential.length) throw new StoreError("response_unreadable");
      await append(e, "signed", { recordHash: e.hash }, { credential });
      guard(e, approval.recordHash);
      await append(e, "submit_intent", { recordHash: e.hash }, undefined, () => guard(e, approval.recordHash));
      guard(e, approval.recordHash);
      const quote = structuredClone((e.raw as { quote: StaticQuote }).quote) as StaticQuote;
      const pending = context.router.purchase({ quoteId: e.record.quoteId, requestId: e.record.requestId, approval: e.record.quoteId, credential, quote });
      // A fault hook may stop observation while the request is in flight. Consume rejection without retry.
      void pending.catch(() => undefined);
      await config.faults?.hit("transport:before-response");
      const response = frozenCopy(jsonCopy(await pending));
      await config.faults?.hit("transport:after-response");
      // Only explicitly projected and bounded results are retained for caller delivery.
      const result = projectResult(e.record, response, [credential, context.phrase, e.record.source.challengeNonce]);
      await append(e, "submitted", { paymentId: e.record.paymentId, outcome: result.outcome! }, { response: jsonCopy(response), result });
      if (result.state === "unknown") { e.result = result; await append(e, "unknown", { paymentId: e.record.paymentId }, { result }); }
      else { await append(e, "result", { paymentId: e.record.paymentId, outcome: result.outcome! }, { result }); e.result = frozenCopy(result); }
      return current(e);
    } catch (error) {
      // Includes faults after durable intents, even if the side effect itself had not begun.
      if (intent || !["quoted", "approved"].includes(e.state)) return unknown(e);
      return failure(error instanceof StoreError ? knownCodeOf(error.code) : "internal_error");
    }
  }
  return {
    hasRef(ref: string): boolean { return entries.has(ref) || context.ledger.rows.some(r => r.ref === ref); },
    async quote(): Promise<unknown> {
      let ref: string | undefined;
      try {
        held();
        const requestId = randomUUID();
        // Contexts without purchase configuration remain unavailable.
        if (!identity) {
          const response = await context.router.quote(STATIC_ROUTE, requestId);
          held(); return response["ok"] === false ? routerFailure(response) : failure("approval_unavailable");
        }
        for (let attempt = 0; attempt < 32; attempt++) {
          const candidate = PurchaseRef.parse(nextRef());
          if (!reservations.has(candidate) && !entries.has(candidate) && !context.ledger.rows.some(r => r.ref === candidate)) { ref = candidate; reservations.add(ref); break; }
        }
        if (!ref) return failure("approval_unavailable");
        const response = await context.router.quote(STATIC_ROUTE, requestId);
        held(); if (response["ok"] === false) return routerFailure(response);
        const raw = frozenCopy(jsonCopy(response));
        const r = buildRecord(raw, { routerUrl: identity.routerUrl, canonicalResource: identity.resource, address: wallet, ref, requestId });
        const e: Entry = { record: r, raw, hash: recordHash(r), state: "quoted" };
        await append(e, "quoted", jsonCopy(r), raw);
        entries.set(ref, e);
        return QuoteSummary.parse({ ok: true, ref, subject: subjectOf(r), nextStep: "approve_then_purchase" });
      } catch (error) { return failure(error instanceof StoreError ? knownCodeOf(error.code) : "quote_inconsistent"); }
      finally { if (ref) reservations.delete(ref); }
    },
    purchase(ref: string): Promise<unknown> {
      if (!PurchaseRef.safeParse(ref).success) return Promise.resolve(failure("unknown_ref"));
      return mutex.run(ref, async () => {
        const e = entries.get(ref);
        if (!e) return failure(context.ledger.rows.some(r => r.ref === ref) ? "approval_unavailable" : "unknown_ref");
        if (e.operation) return e.operation;
        e.operation = execute(e); return e.operation;
      });
    },
    status(ref: string, includeBody: boolean): Promise<unknown> {
      return mutex.run(ref, async () => { context.assertHeld(); const e = entries.get(ref); return e ? current(e, includeBody) : failure("approval_unavailable"); });
    },
  };
}
function projectResult(r: ApprovalRecord, response: unknown, secrets: string[]): PurchaseBodySummary {
  const v = jsonCopy(response);
  if (!record(v) || v["paymentId"] !== r.paymentId) throw new StoreError("response_unreadable");
  const outcome = v["outcome"];
  if (!["delivered", "paid_data_unavailable", "rejected", "payment_required", "unknown"].includes(String(outcome))) throw new StoreError("response_unreadable");
  if (v["ok"] !== (outcome === "delivered")) throw new StoreError("response_unreadable");
  let result;
  if (outcome === "delivered") {
    if (!record(v["snapshot"]) || typeof v["contentType"] !== "string" || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(v["contentType"])) throw new StoreError("response_unreadable");
    const body = v["snapshot"];
    const text = JSON.stringify(body);
    if (secrets.filter(Boolean).some(s => [s, Buffer.from(s).toString("base64"), Buffer.from(s).toString("hex")].some(encoded => text.includes(encoded)))) throw new StoreError("response_unreadable");
    let preview = "";
    for (const char of text) { if (Buffer.byteLength(preview + char) > 512) break; preview += char; }
    result = { untrusted: true, source: "upstream", contentType: "application/json", body, preview, bytes: Buffer.byteLength(text) };
  }
  const paid = outcome === "delivered" || outcome === "paid_data_unavailable";
  return PurchaseBodySummary.parse({ ok: outcome === "delivered", ref: r.ref, state: outcome === "unknown" ? "unknown" : "result", outcome,
    paymentId: r.paymentId, fundsMoved: paid ? "yes" : "maybe",
    ...(result ? { result } : {}),
    ...(v["reason"] !== undefined || v["error"] !== undefined || v["terminalReason"] !== undefined ? { reason: knownCodeOf(v["reason"] ?? v["error"] ?? v["terminalReason"]) } : {}),
    proof: { upstreamReceipt: "none", onChainFinality: "not_checked" },
    nextStep: outcome === "delivered" ? "delivered" : outcome === "paid_data_unavailable" ? "paid_no_data" : outcome === "unknown" ? "unknown_inspect" : "rejected" });
}
