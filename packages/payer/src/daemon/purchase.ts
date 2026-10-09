import { generateRef } from "./ref.js";
import { routerIdentity } from "../router/identity.js";
import { randomUUID } from "node:crypto";
import { InspectionSummary, failure, knownCodeOf, PurchaseRef, QuoteSummary, PurchaseSummary, PurchaseBodySummary } from "../protocol/summary.js";
import { StoreError } from "../store/fs.js";
import type { JsonValue } from "../store/ledger.js";
import { record, routerFailure, STATIC_ROUTE } from "../router/client.js";
import type { DaemonContext } from "./interfaces.js";
import { RefMutex } from "./server.js";
import { assertApproval, buildRecord, frozenCopy, jsonCopy, recordHash, subjectOf, type ApprovalRecord, type StaticQuote } from "./record.js";

import { rehydrate, matchingProjection, type RecoveredEntry as Entry } from "./recover.js";
import { containsResultSecret, resultSecrets } from "./secrets.js";

export type PurchaseCore = ReturnType<typeof newPurchaseCore>;
const cores = new WeakMap<DaemonContext, PurchaseCore>();
export function createPurchaseCore(context: DaemonContext): PurchaseCore {
  let core = cores.get(context);
  if (!core) { core = newPurchaseCore(context); cores.set(context, core); }
  return core;
}
/** One instance per daemon; all reads and purchases share this mutex. Startup recovery uses the same instance. */
function newPurchaseCore(context: DaemonContext) {
  const entries = new Map<string, Entry>();
  const reservations = new Set<string>();
  const mutex = new RefMutex();
  const config = context.purchase;
  // Copy identity once: later mutation of the configuration cannot redirect an approved operation.
  const identity = config ? routerIdentity(config.routerUrl, config.canonicalResource) : undefined;
  const nextRef = config?.generateRef ?? generateRef;
  const wallet = context.address;
  function held(): void { context.assertHeld(); if (context.ledger.writeFailed) throw new StoreError("store_write_failed"); context.ledger.assertCurrent(); }
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
      state: e.state, fundsMoved: ["quoted", "approved", "expired"].includes(e.state) ? "no" : "maybe",
      ...(e.state === "closed_by_operator" ? { reason: "closed_by_operator" } : {}),
      ...(e.state === "unknown" ? { outcome: "unknown", nextStep: "unknown_inspect" } : {}) });
  }
  async function unknown(e: Entry): Promise<unknown> {
    if (e.state === "unknown") return current(e);
    delete e.result;
    try { await append(e, "unknown", { reason: "transport_uncertain", paymentId: e.record.paymentId }); } catch { e.state = "unknown"; /* Durable intent remains the recovery authority. Never retry. */ }
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
      e.credential = credential;
      return await submit(e, credential);
    } catch (error) {
      // Includes faults after durable intents, even if the side effect itself had not begun.
      if (intent || !["quoted", "approved"].includes(e.state)) return unknown(e);
      return failure(error instanceof StoreError ? knownCodeOf(error.code) : "internal_error");
    }
  }
  async function submit(e: Entry, credential: string): Promise<unknown> {
      guard(e);
      await append(e, "submit_intent", { recordHash: e.hash }, undefined, () => guard(e));
      guard(e);
      const quote = structuredClone((e.raw as { quote: StaticQuote }).quote) as StaticQuote;
      const pending = context.router.purchase({ quoteId: e.record.quoteId, requestId: e.record.requestId, approval: e.record.quoteId, credential, quote });
      // A fault hook may stop observation while the request is in flight. Consume rejection without retry.
      void pending.catch(() => undefined);
      await config?.faults?.hit("transport:before-response");
      const response = frozenCopy(jsonCopy(await pending));
      await config?.faults?.hit("transport:after-response");
      // Only explicitly projected and bounded results are retained for caller delivery.
      const result = projectResult(e.record, response, resultSecrets(e.raw, credential, context.phrase));
      await append(e, "submitted", { paymentId: e.record.paymentId, outcome: result.outcome! }, { response: jsonCopy(response), result });
      if (result.state === "unknown") { e.result = result; await append(e, "unknown", { paymentId: e.record.paymentId }, { result }); }
      else { await append(e, "result", { paymentId: e.record.paymentId, outcome: result.outcome! }, { result }); e.result = frozenCopy(result); }
      return current(e);
  }
  let initialization: Promise<void> | undefined;
  function load(): Promise<void> {
    // Validate ALL retained evidence before exposing any ref, without submission.
    return initialization ??= (async () => {
      held();
      if (context.ledger.rows.length) {
        if (!identity) throw new StoreError("store_corrupt");
        const retained = rehydrate(context.ledger, { routerUrl: identity.routerUrl, canonicalResource: identity.resource, address: wallet }, context.phrase, projectResult);
        for (const [ref, e] of retained) entries.set(ref, e);
      }
    })();
  }
  let recovery: Promise<void> | undefined;
  function recover(): Promise<void> {
    return recovery ??= (async () => {
      await load();
      for (const [ref, e] of entries) await mutex.run(ref, () => reconcile(e));
    })();
  }
  async function reconcile(e: Entry, allowSubmit = true): Promise<unknown> {
    held();
    if (["result", "expired", "expired_after_sign", "closed_by_operator"].includes(e.state)) return current(e);
    if (["quoted", "approved"].includes(e.state)) {
      if (e.record.approvalDeadlineMs <= Date.now() || e.record.source.expiresAt * 1000 <= Date.now()) await append(e, "expired", { recordHash: e.hash });
      return current(e);
    }
    try {
      const status = frozenCopy(await context.router.status(e.record.paymentId));
      held();
      if (status.kind === "found" && matchingProjection(e.record, status.projection)) {
        const p = status.projection, outcome = p["status"];
        if (["delivered", "paid_data_unavailable", "rejected"].includes(String(outcome)) && (e.state !== "unknown" || outcome !== "rejected")) {
          const result = projectResult(e.record, { ok: outcome === "delivered", outcome, paymentId: e.record.paymentId,
            ...(outcome === "delivered" ? { snapshot: p["result"], contentType: "application/json" } : {}),
            ...(p["terminalReason"] !== undefined ? { reason: p["terminalReason"] } : {}) }, resultSecrets(e.raw, e.credential, context.phrase));
          await append(e, "result", { paymentId: e.record.paymentId, outcome: result.outcome! }, { result, projection: p });
          e.result = frozenCopy(result); return current(e);
        }
      }
      if (e.state === "signed" && status.kind === "not_found") {
        if (e.record.approvalDeadlineMs <= Date.now() || e.record.source.expiresAt * 1000 <= Date.now()) {
          await append(e, "expired_after_sign", { recordHash: e.hash }); return current(e);
        }
        if (!allowSubmit) return unknown(e);
        guard(e);
        if (!e.credential) throw new StoreError("store_corrupt");
        return await submit(e, e.credential);
      }
    } catch (error) {
      if (error instanceof StoreError && (error.code.startsWith("store_") || error.code === "lock_lost")) throw error;
      // Any other uncertain read or submission forbids another attempt.
    }
    return unknown(e);
  }
  return {
    recover,
    async inspect(ref?: string): Promise<unknown> {
      await load();
      if (ref !== undefined && !entries.has(ref)) return failure("unknown_ref");
      const selected = ref === undefined ? [...entries.keys()] : [ref];
      const inspections = [];
      for (const key of selected) inspections.push(await mutex.run(key, async () => {
        const e = entries.get(key)!;
        await reconcile(e, false);
        return { summary: current(e), rows: context.ledger.rows.filter(row => row.ref === key).map(row => ({ seq: row.seq, ts: row.ts, state: row.state })) };
      }));
      return InspectionSummary.parse({ ok: true, inspections });
    },
    async closeByOperator(ref: string, reason: string): Promise<unknown> {
      await load();
      return mutex.run(ref, async () => {
        held(); const e = entries.get(ref);
        if (!e || e.state !== "unknown" || typeof reason !== "string" || !reason.trim() || reason.length > 512) throw new StoreError("approval_mismatch");
        await append(e, "closed_by_operator", { reason: "closed_by_operator" }, { reason });
        delete e.result; return current(e);
      });
    },
    hasRef(ref: string): boolean { return entries.has(ref) || context.ledger.rows.some(r => r.ref === ref); },
    async quote(): Promise<unknown> {
      let ref: string | undefined;
      try {
        await recover(); held();
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
    async purchase(ref: string): Promise<unknown> {
      await recover();
      if (!PurchaseRef.safeParse(ref).success) return Promise.resolve(failure("unknown_ref"));
      return mutex.run(ref, async () => {
        const e = entries.get(ref);
        if (!e) return failure(context.ledger.rows.some(r => r.ref === ref) ? "approval_unavailable" : "unknown_ref");
        if (e.result && e.state === "result") return current(e);
        if (e.operation) return e.operation;
        if (!["quoted", "approved"].includes(e.state)) return current(e);
        e.operation = execute(e); return e.operation;
      });
    },
    async status(ref: string, includeBody: boolean): Promise<unknown> {
      await recover();
      return mutex.run(ref, async () => { context.assertHeld(); const e = entries.get(ref); if (!e) return failure("unknown_ref"); if (!context.ledger.writeFailed && !["result", "expired", "expired_after_sign", "closed_by_operator"].includes(e.state)) await reconcile(e); return current(e, includeBody); });
    },
  };
}
export function projectResult(r: ApprovalRecord, response: unknown, secrets: string[]): PurchaseBodySummary {
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
    if (containsResultSecret(body, secrets)) throw new StoreError("response_unreadable");
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
