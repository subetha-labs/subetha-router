import { z } from "zod";
import { PurchaseBodySummary, PurchaseRef } from "../protocol/summary.js";
import { canonicalJson, type JsonValue, type Ledger } from "../store/ledger.js";
import { StoreError } from "../store/fs.js";
import { normalizeProjection, record } from "../router/client.js";
import { frozenCopy, jsonCopy, kindOf, rebuildRecord, recordHash, recordVersionOf, type ApprovalRecord, type RecordIdentity } from "./record.js";
import { resultSecrets } from "./secrets.js";

export type RecoveredEntry = { record: ApprovalRecord; version: 1 | 2; raw: JsonValue; hash: string; state: string; credential?: string; txRef?: string; result?: PurchaseBodySummary; operation?: Promise<unknown> };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const hashData = z.object({ recordHash: hash }).strict();
const outcome = z.enum(["delivered", "paid_data_unavailable", "rejected", "payment_required", "unknown"]);
const paymentData = z.object({ paymentId: z.string().uuid(), outcome: outcome.optional(), reason: z.literal("transport_uncertain").optional() }).strict();
/** `signed` seal: the credential and, for MPP on Tempo, the hash of the transfer the daemon sent (docs/payer-rails-design.md FR-R6). */
export const SignedSeal = z.object({ credential: z.string().min(1).max(262144), txRef: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional() }).strict();
const transitions: Record<string, readonly string[]> = {
  quoted: ["approved", "expired"], approved: ["approved", "sign_intent", "expired"],
  sign_intent: ["signed", "unknown", "result"], signed: ["submit_intent", "unknown", "result", "expired_after_sign"],
  submit_intent: ["submitted", "unknown", "result"], submitted: ["result", "unknown"],
  unknown: ["unknown", "result", "closed_by_operator"], result: [], expired: [], expired_after_sign: [], closed_by_operator: [],
};
function same(a: unknown, b: unknown): boolean { return canonicalJson(jsonCopy(a)) === canonicalJson(jsonCopy(b)); }
/**
 * A reason code the allowlist learned AFTER a record was written must not invalidate that record (0.2.0 wrote `unknown_code` for the
 * Router's `unsupported_response` / `destination_rejected`; 0.2.1 names them, and 0.2.1 refused every 0.2.0 store with `store_corrupt`
 * on 2026-10-13). Tolerated in one direction only: where the STORED summary says `unknown_code`, today's projection may name the code.
 * Any other difference is still corruption. The stored summary stays authoritative (it is what the human saw).
 */
export function sameUpToLearnedCodes(stored: unknown, projected: unknown): boolean {
  if (same(stored, projected)) return true;
  const a = jsonCopy(stored), b = jsonCopy(projected);
  const walk = (x: unknown, y: unknown): void => {
    if (record(x) && record(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (k === "reason" && x[k] === "unknown_code" && typeof y[k] === "string") { y[k] = "unknown_code"; continue; }
        walk(x[k], y[k]);
      }
    } else if (Array.isArray(x) && Array.isArray(y)) x.forEach((v, i) => walk(v, y[i]));
  };
  walk(a, b);
  return same(a, b);
}
/** What the Router may claim about the upstream for this record's kind (static: nothing; dynamic: the upstream's own receipt). */
export function upstreamReceiptOf(r: ApprovalRecord): "none" | "claimed" { return kindOf(r) === "dynamic" ? "claimed" : "none"; }
/** Validate the WHOLE history before making any entry available to replay. No migration or writes. */
export function rehydrate(ledger: Ledger, identity: Omit<RecordIdentity, "ref" | "requestId">, phrase: string,
  project: (r: ApprovalRecord, response: unknown, secrets: string[]) => PurchaseBodySummary): Map<string, RecoveredEntry> {
  const entries = new Map<string, RecoveredEntry>();
  try {
    for (const row of ledger.rows) {
      PurchaseRef.parse(row.ref);
      const bytes = ledger.openSealed(row);
      let sealed: unknown;
      try { sealed = bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8")); } finally { bytes?.fill(0); }
      let e = entries.get(row.ref);
      if (!e) {
        if (row.state !== "quoted" || !record(row.data) || typeof row.data["requestId"] !== "string" || sealed === undefined) throw 0;
        // 0.1.x rows (no `kind`) are rebuilt by the frozen v1 builder so their hashes do not change (§2.4a).
        const version = recordVersionOf(row.data);
        const r = rebuildRecord(version, sealed, { ...identity, ref: row.ref, requestId: row.data["requestId"] }, 0);
        if (!same(r, row.data)) throw 0;
        e = { record: r, version, raw: frozenCopy(jsonCopy(sealed)), hash: recordHash(r), state: "quoted" };
        entries.set(row.ref, e); continue;
      }
      const previous = e.state;
      if (!transitions[previous]?.includes(row.state)) throw 0;
      if (["approved", "sign_intent", "signed", "submit_intent"].includes(row.state)) {
        const data = row.state === "approved" ? z.object({ recordHash: hash, shownAt: z.number().int().nonnegative(), uiKind: z.literal("native") }).strict().parse(row.data) : hashData.parse(row.data);
        if (data.recordHash !== e.hash) throw 0;
        if (row.state === "signed") { const seal = SignedSeal.parse(sealed); e.credential = seal.credential; if (seal.txRef !== undefined) e.txRef = seal.txRef; }
        else if (sealed !== undefined) throw 0;
      } else if (row.state === "closed_by_operator") {
        z.object({ reason: z.literal("closed_by_operator") }).strict().parse(row.data);
        z.object({ reason: z.string().trim().min(1).max(512) }).strict().parse(sealed);
        delete e.result;
      } else if (["expired", "expired_after_sign"].includes(row.state)) {
        if (!same(row.data, { recordHash: e.hash }) || sealed !== undefined) throw 0;
      } else {
        const data = paymentData.parse(row.data);
        if (data.paymentId !== e.record.paymentId) throw 0;
        if (sealed !== undefined) {
          const fields = row.state === "submitted" ? z.object({ response: z.unknown(), result: PurchaseBodySummary }).strict().parse(sealed) : z.object({ result: PurchaseBodySummary, projection: z.record(z.unknown()).optional() }).strict().parse(sealed);
          const result = fields.result;
          if (result.ref !== row.ref || result.paymentId !== e.record.paymentId || result.proof?.onChainFinality !== "not_checked" || result.proof.upstreamReceipt !== upstreamReceiptOf(e.record)) throw 0;
          const response = "response" in fields ? fields.response : { ok: result.ok, outcome: result.outcome, paymentId: result.paymentId, ...(result.result ? { snapshot: result.result.body, contentType: result.result.contentType } : {}), ...(result.reason ? { reason: result.reason } : {}) };
          if (!sameUpToLearnedCodes(result, project(e.record, response, resultSecrets(e.raw, e.credential, phrase, e.txRef)))) throw 0;
          if (data.outcome !== undefined && data.outcome !== result.outcome) throw 0;
          if (row.state === "result" && (result.state !== "result" || (previous === "unknown" && !["delivered", "paid_data_unavailable"].includes(result.outcome!)))) throw 0;
          if (row.state === "unknown" && result.state !== "unknown") throw 0;
          if (row.state === "result" && previous !== "submitted" && !("projection" in fields && fields.projection)) throw 0;
          if ("projection" in fields && fields.projection) {
            // Projections are stored normalized (§2.5); normalize again so a wrapped dynamic body never compares unequal.
            const projection = normalizeProjection(fields.projection);
            if (!matchingProjection(e.record, projection) || projection["status"] !== result.outcome) throw 0;
            if (result.outcome === "delivered" && !same(projection["result"], result.result?.body)) throw 0;
          }
          if (row.state === "result") e.result = frozenCopy(result);
        } else if (row.state !== "unknown") throw 0;
      }
      e.state = row.state;
    }
    return entries;
  } catch { throw new StoreError("store_corrupt"); }
}
/** Hosted projection uses top-level quoteFingerprint; no requestId/quoteId or pre-settlement txRef. */
export function matchingProjection(r: ApprovalRecord, p: Record<string, unknown>): boolean {
  const source = p["source"], destination = p["destination"];
  return p["paymentId"] === r.paymentId && p["routeId"] === r.routeId && p["quoteFingerprint"] === r.destination.quoteFingerprint &&
    record(source) && ["amount", "asset", "network"].every(k => source[k] === r.source[k as keyof typeof r.source]) &&
    record(destination) && ["quoted", "asset", "network"].every(k => destination[k] === r.destination[k as keyof typeof r.destination]) &&
    typeof p["status"] === "string" && typeof p["updatedAt"] === "string";
}
