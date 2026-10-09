import { createHash } from "node:crypto";
import { z } from "zod";
import { PurchaseRef, SubjectSummary } from "../protocol/summary.js";
import { canonicalJson, isPlainJson, type JsonValue } from "../store/ledger.js";
import { StoreError } from "../store/fs.js";
import { routerIdentity, ROUTE_BINDING, type ResourceIdentity } from "../router/identity.js";
import { STATIC_ROUTE } from "../router/client.js";
import { classifyEvmOffer } from "../vendor/sign-classify-evm.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const amount = z.string().regex(/^[1-9][0-9]{0,29}$/);
const nonce = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const epoch = z.number().int().min(1).max(4_102_444_800_000);
const offerSchema = z.object({
  scheme: z.literal("exact"), network: z.literal("eip155:84532"),
  asset: z.literal("0x036CbD53842c5426634e7929541eC2318f3dCF7e"), amount, payTo: address,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.object({ name: z.literal("USDC"), version: z.literal("2"), expiresAt: epoch,
    challengeNonce: nonce, routeBinding: z.string().min(1).max(256), fundsMoveOnCredential: z.literal(false),
  }).strict(),
}).strict();
const sourceSchema = z.object({ rail: z.literal("x402"), amount, asset: offerSchema.shape.asset,
  decimals: z.literal(6), network: offerSchema.shape.network, payTo: address, expiresAt: epoch, offer: offerSchema }).strict();
const destinationSchema = z.object({ rail: z.literal("mpp"), network: z.literal("eip155:42431"),
  asset: z.literal("0x20c0000000000000000000000000000000000000"), quoted: amount,
  decimals: z.literal(6).optional(), payTo: address, quoteFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
const quoteSchema = z.object({ quoteId: nonce, paymentId: z.string().uuid(), routeId: z.literal(STATIC_ROUTE),
  resource: z.object({ url: z.string().url(), method: z.literal("GET") }).strict(),
  source: sourceSchema, destination: destinationSchema,
  approval: z.object({ required: z.literal(true), boundTo: nonce, deadlineMs: epoch }).strict(),
}).strict();
export type StaticQuote = z.infer<typeof quoteSchema>;
export interface RecordIdentity { routerUrl: string; canonicalResource?: ResourceIdentity; address: string; ref: string; requestId: string }
export type ApprovalRecord = Readonly<{
  routerUrl: string; resource: ResourceIdentity; wallet: Readonly<{ rail: "x402"; network: "eip155:84532"; address: string }>;
  ref: string; requestId: string; paymentId: string; quoteId: string; routeId: string;
  source: Readonly<Omit<StaticQuote["source"], "offer"> & { scheme: "exact"; challengeNonce: string; routeBinding: string; fundsMoveOnCredential: false }>;
  destination: Readonly<StaticQuote["destination"]>; approvalDeadlineMs: number;
}>;
export function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(v: unknown): void { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } }
  freeze(copy); return copy;
}
export function jsonCopy(value: unknown): JsonValue {
  if (!isPlainJson(value)) throw new StoreError("quote_inconsistent");
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
export function recordHash(record: ApprovalRecord): string {
  return createHash("sha256").update(canonicalJson(jsonCopy(record))).digest("hex");
}
export function buildRecord(response: unknown, identity: RecordIdentity, now = Date.now()): ApprovalRecord {
  try {
    const raw = jsonCopy(response) as Record<string, JsonValue>;
    if (raw["ok"] !== true || raw["approvalRequired"] !== true) throw 0;
    const q = quoteSchema.parse(raw["quote"]);
    const { source: s, destination: d, approval: a } = q;
    const o = s.offer;
    const trusted = routerIdentity(identity.routerUrl, identity.canonicalResource);
    if (q.resource.url !== trusted.resource.url || q.resource.method !== trusted.resource.method) throw 0;
    if (o.extra.routeBinding !== ROUTE_BINDING) throw 0;
    if (q.quoteId !== o.extra.challengeNonce || a.boundTo !== q.quoteId || a.deadlineMs > s.expiresAt * 1000 || a.deadlineMs <= now) throw 0;
    if (classifyEvmOffer(o, now).kind !== "x402-evm") throw 0;
    for (const key of ["amount", "asset", "network", "payTo"] as const) if (s[key] !== o[key]) throw 0;
    if (s.expiresAt !== o.extra.expiresAt) throw 0;
    const expectedSubject = { quoteId: q.quoteId, paymentId: q.paymentId, routeId: q.routeId, resource: q.resource,
      source: { amount: s.amount, decimals: s.decimals, asset: s.asset, network: s.network, expiresAt: s.expiresAt, offer: o },
      destination: { quoted: d.quoted, asset: d.asset, network: d.network }, approval: a, fundsMoveOnCredential: false };
    if (canonicalJson(jsonCopy(raw["subject"])) !== canonicalJson(jsonCopy(expectedSubject))) throw 0;
    const { offer: _, ...source } = s;
    return frozenCopy({ routerUrl: trusted.routerUrl, resource: trusted.resource, wallet: { rail: "x402", network: "eip155:84532", address: address.parse(identity.address) },
      ref: PurchaseRef.parse(identity.ref), requestId: z.string().uuid().parse(identity.requestId), paymentId: q.paymentId, quoteId: q.quoteId, routeId: q.routeId,
      source: { ...source, scheme: o.scheme, challengeNonce: o.extra.challengeNonce, routeBinding: o.extra.routeBinding, fundsMoveOnCredential: false },
      destination: d, approvalDeadlineMs: a.deadlineMs });
  } catch { throw new StoreError("quote_inconsistent"); }
}
export function assertApproval(r: ApprovalRecord, offer: unknown, approvedHash: string, locked: boolean, now = Date.now()): void {
  if (locked) throw new StoreError("locked");
  if (r.approvalDeadlineMs <= now || r.source.expiresAt * 1000 <= now) throw new StoreError("approval_expired");
  const parsed = offerSchema.safeParse(offer);
  if (!parsed.success || approvedHash !== recordHash(r)) throw new StoreError("approval_mismatch");
  const o = parsed.data;
  for (const k of ["scheme", "network", "asset", "amount", "payTo"] as const) if (o[k] !== r.source[k]) throw new StoreError("approval_mismatch");
  for (const k of ["expiresAt", "challengeNonce", "routeBinding", "fundsMoveOnCredential"] as const) if (o.extra[k] !== r.source[k]) throw new StoreError("approval_mismatch");
}
export function subjectOf(r: ApprovalRecord): SubjectSummary {
  const s = r.source; const { quoteFingerprint: _, ...reaches } = r.destination;
  return SubjectSummary.parse({ amount: s.amount, decimals: s.decimals, asset: s.asset, network: s.network, payTo: s.payTo,
    deadlineMs: r.approvalDeadlineMs, fundsMoveOnCredential: s.fundsMoveOnCredential, reaches });
}
/** Strip controls/format characters and all whitespace except LF from values, before adding trusted labels. */
export function sanitize(text: string): string { return text.replace(/[^\S\n]|[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, (c) => c === "\n" ? c : ""); }
export function render(r: ApprovalRecord): string {
  const s = r.source; const d = r.destination;
  return [
    `Router: ${sanitize(r.routerUrl)}`, `Resource: ${r.resource.method} ${sanitize(r.resource.url)}`, `Wallet: ${sanitize(r.wallet.address)}`, `Route: ${sanitize(r.routeId)}`,
    `Pay: ${sanitize(s.amount)} base units (decimals ${s.decimals}) ${sanitize(s.asset)} on ${sanitize(s.network)}`,
    `Recipient: ${sanitize(s.payTo)}`, `Destination (operator fixed): ${sanitize(d.rail)} ${sanitize(d.network)} ${sanitize(d.asset)}`,
    `Destination amount: ${sanitize(d.quoted)} base units (decimals ${d.decimals ?? "not supplied"}); recipient: ${sanitize(d.payTo)}`,
    "Fee breakdown: not supplied for this static route.", `Deadline: ${new Date(r.approvalDeadlineMs).toISOString()}`,
    "Signing creates a credential only. The Router may move funds on purchase.",
  ].join("\n");
}
