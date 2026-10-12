import { createHash } from "node:crypto";
import { z } from "zod";
import { Disclosures, PurchaseRef, SubjectSummary } from "../protocol/summary.js";
import { canonicalJson, isPlainJson, type JsonValue } from "../store/ledger.js";
import { StoreError } from "../store/fs.js";
import { canonicalResourceFor, dynamicRouteBindingOf, HOSTED_CANONICAL_BASE, RESOURCE_PATH, ROUTE_BINDING, ROUTE_ID_PATTERN, routerIdentity, staticRouteBindingOf, type ResourceIdentity } from "../router/identity.js";
import { STATIC_ROUTE } from "../router/client.js";
import { classifyEvmOffer } from "../vendor/sign-classify-evm.js";
import { classifyOffer } from "../vendor/sign-dispatch.js";
import { keyRailOf, payerAssetOf, payerNetworkOf, type KeyRail } from "../sign/networks.js";
import type { WalletAddresses } from "./interfaces.js";

/**
 * The only destination the 0.1.x payer accepted is pathUSD on Tempo testnet (`eip155:42431`), which has 6 decimals.
 * The hosted static quote may omit `decimals` (follow-up FR-F4); records carry this value. Records written by 0.1.0/0.1.1 keep their shape.
 */
export const PATHUSD_DECIMALS = 6;
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const base58Key = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const anyAddress = z.union([evmAddress, base58Key]);
const amount = z.string().regex(/^[1-9][0-9]{0,29}$/);
const hexNonce = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
/** MPP challenge ids are mppx HMAC ids (base64url, 43 chars); x402 nonces are 0x-hex (docs/payer-rails-design.md §2.4). */
const mppxId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const nonceOrId = z.union([hexNonce, mppxId]);
const epoch = z.number().int().min(1).max(4_102_444_800_000);
const network = z.string().regex(/^(eip155:[1-9][0-9]{0,19}|solana:[1-9A-HJ-NP-Za-km-z]{32})$/);
const decimals = z.number().int().min(0).max(18);
const routeIdSchema = z.string().regex(ROUTE_ID_PATTERN);
const resourceSchema = z.object({ url: z.string().url(), method: z.literal("GET") }).strict();
const approvalSchema = (nonce: z.ZodTypeAny) => z.object({ required: z.literal(true), boundTo: nonce, deadlineMs: epoch }).strict();

/* ────────────────────────────────────────────────────────────────────────────
 * v1 (0.1.x): the single static route, Base Sepolia USDC over x402 → pathUSD on Tempo. FROZEN (docs/payer-rails-design.md §2.4a):
 * ledgers written by 0.1.x are rebuilt with exactly this code so their hashes do not change. New quotes never use it.
 * ──────────────────────────────────────────────────────────────────────────── */
const offerSchemaV1 = z.object({
  scheme: z.literal("exact"), network: z.literal("eip155:84532"),
  asset: z.literal("0x036CbD53842c5426634e7929541eC2318f3dCF7e"), amount, payTo: evmAddress,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.object({ name: z.literal("USDC"), version: z.literal("2"), expiresAt: epoch,
    challengeNonce: hexNonce, routeBinding: z.string().min(1).max(256), fundsMoveOnCredential: z.literal(false),
  }).strict(),
}).strict();
const sourceSchemaV1 = z.object({ rail: z.literal("x402"), amount, asset: offerSchemaV1.shape.asset,
  decimals: z.literal(6), network: offerSchemaV1.shape.network, payTo: evmAddress, expiresAt: epoch, offer: offerSchemaV1 }).strict();
const destinationSchemaV1 = z.object({ rail: z.literal("mpp"), network: z.literal("eip155:42431"),
  asset: z.literal("0x20c0000000000000000000000000000000000000"), quoted: amount,
  decimals: z.literal(6).optional(), payTo: evmAddress, quoteFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();
const quoteSchemaV1 = z.object({ quoteId: hexNonce, paymentId: z.string().uuid(), routeId: z.literal(STATIC_ROUTE),
  resource: resourceSchema, source: sourceSchemaV1, destination: destinationSchemaV1, approval: approvalSchema(hexNonce) }).strict();
export type StaticQuote = z.infer<typeof quoteSchemaV1>;

/* ────────────────────────────────────────────────────────────────────────────
 * v2 (0.2.0): every inbound rail of the four testnets, every static route and dynamic profile.
 * ──────────────────────────────────────────────────────────────────────────── */
/** The offer's shape before the rail-specific checks (`classifyOffer`, the same dispatcher `npm run sign` uses). */
const offerBase = z.object({
  scheme: z.enum(["exact", "tempo/charge", "solana/charge"]), network, asset: anyAddress, amount, payTo: anyAddress,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.object({ challengeNonce: nonceOrId, expiresAt: epoch, routeBinding: z.string().min(1).max(4096), fundsMoveOnCredential: z.boolean() }).passthrough(),
}).strict();
/** Keys the Router issues in `extra` per rail. Anything else in a quote is `quote_inconsistent` (strict, as in v1). */
const EXTRA_KEYS: Record<"x402-evm" | "x402-svm" | "mpp" | "mpp-svm", { required: readonly string[]; optional: readonly string[] }> = {
  // Circle-facilitated networks (Arc) also carry `assetTransferMethod: "eip3009"` (Router `src/adapters/inbound/x402.ts`).
  "x402-evm": { required: ["name", "version", "challengeNonce", "expiresAt", "routeBinding", "fundsMoveOnCredential"], optional: ["assetTransferMethod"] },
  "x402-svm": { required: ["feePayer", "memo", "challengeNonce", "expiresAt", "routeBinding", "fundsMoveOnCredential"], optional: [] },
  "mpp": { required: ["challenge", "challengeNonce", "expiresAt", "routeBinding", "fundsMoveOnCredential"], optional: [] },
  "mpp-svm": { required: ["challenge", "externalId", "challengeNonce", "expiresAt", "routeBinding", "fundsMoveOnCredential"], optional: ["decimals", "tokenProgram"] },
};
const MAX_CHALLENGE_CHARS = 8192;
const sourceSchema = z.object({ rail: z.enum(["x402", "mpp"]), amount, asset: anyAddress, decimals, network, payTo: anyAddress, expiresAt: epoch, offer: offerBase }).strict();
const destinationSchema = z.object({ rail: z.enum(["x402", "mpp"]), scheme: z.enum(["exact", "tempo/charge", "solana/charge"]).optional(), network, asset: anyAddress, quoted: amount,
  decimals: decimals.optional(), payTo: anyAddress, quoteFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict();
/** Printable ASCII https URL, bounded (also what `render` prints; `sanitize` would otherwise silently drop characters). */
const upstreamUrl = z.string().max(2048).regex(/^https:\/\/[\x21-\x7e]{1,2040}$/).refine((value) => { try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.hash && u.href === value; } catch { return false; } });
const estimateSchema = z.object({ gas: z.string().regex(/^(0|[1-9][0-9]{0,29})$/), maxFeePerGas: z.string().regex(/^(0|[1-9][0-9]{0,29})$/), bound: z.string().regex(/^(0|[1-9][0-9]{0,29})$/), atMs: epoch }).strict();
const pricingSchema = z.object({ upstreamAmount: amount, converted: amount, fee: z.string().regex(/^(0|[1-9][0-9]{0,29})$/), total: amount, maxFee: amount.optional(), estimate: estimateSchema.optional(), sourceDecimals: decimals, destinationDecimals: decimals }).strict();
const ownerKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const quoteSchema = z.object({ quoteId: nonceOrId, paymentId: z.string().uuid(), routeId: routeIdSchema, resource: resourceSchema,
  source: sourceSchema, destination: destinationSchema, approval: approvalSchema(nonceOrId),
  upstream: z.object({ url: upstreamUrl, method: z.literal("GET") }).strict().optional(), pricing: pricingSchema.optional(), disclosures: Disclosures.optional(), ownerKey: ownerKeySchema.optional() }).strict();
export type RailQuote = z.infer<typeof quoteSchema>;
/** The v2 quote document schema (exported for tests and diagnostics; `buildRecord` is the only production entry). */
export const RailQuoteSchema = quoteSchema;

export interface RecordIdentity {
  routerUrl: string; canonicalResource?: ResourceIdentity;
  /** EVM address (0.1.x field; the v1 builder uses only this). */
  address: string;
  /** Addresses per key rail; the v2 builder picks the one the offer's network needs (missing ⇒ `rail_not_enabled`). */
  wallets?: WalletAddresses;
  ref: string; requestId: string;
}
export type RecordKind = "static" | "dynamic";
export type ApprovalRecord = Readonly<{
  routerUrl: string; resource: ResourceIdentity;
  wallet: Readonly<{ rail: "x402" | "mpp"; network: string; address: string }>;
  ref: string; requestId: string; paymentId: string; quoteId: string; routeId: string;
  source: Readonly<{ rail: "x402" | "mpp"; amount: string; asset: string; decimals: number; network: string; payTo: string; expiresAt: number;
    scheme: "exact" | "tempo/charge" | "solana/charge"; challengeNonce: string; routeBinding: string; fundsMoveOnCredential: boolean;
    /** v2 only: sha256 of the canonical JSON of the whole offer (binds every transaction-affecting field; SR-R2). */
    offerSha256?: string }>;
  destination: Readonly<{ rail: "x402" | "mpp"; scheme?: "exact" | "tempo/charge" | "solana/charge"; network: string; asset: string; quoted: string; decimals?: number; payTo: string; quoteFingerprint: string }>;
  approvalDeadlineMs: number;
  /** v2 only (absent in 0.1.x records, which are always static). */
  kind?: RecordKind;
  upstream?: Readonly<{ url: string; method: "GET" }>;
  pricing?: Readonly<z.infer<typeof pricingSchema>>;
  disclosures?: Readonly<Disclosures>;
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
export function offerDigest(offer: unknown): string {
  return createHash("sha256").update(canonicalJson(jsonCopy(offer))).digest("hex");
}
/** Which builder wrote a record (ledger `quoted` row data): 0.1.x records have no `kind`. */
export function recordVersionOf(record: { kind?: unknown } | Record<string, unknown>): 1 | 2 {
  return (record as { kind?: unknown }).kind === undefined ? 1 : 2;
}
/** Rebuild with the builder that wrote the record (recovery and the pre-sign guard; §2.4a). */
export function rebuildRecord(version: 1 | 2, response: unknown, identity: RecordIdentity, now = Date.now()): ApprovalRecord {
  return version === 1 ? buildRecordV1(response, identity, now) : buildRecord(response, identity, now);
}

/** FROZEN 0.1.x builder (§2.4a). Do not extend; new quotes go through `buildRecord`. */
export function buildRecordV1(response: unknown, identity: RecordIdentity, now = Date.now()): ApprovalRecord {
  try {
    const raw = jsonCopy(response) as Record<string, JsonValue>;
    if (raw["ok"] !== true || raw["approvalRequired"] !== true) throw 0;
    const q = quoteSchemaV1.parse(raw["quote"]);
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
    return frozenCopy({ routerUrl: trusted.routerUrl, resource: trusted.resource, wallet: { rail: "x402" as const, network: "eip155:84532", address: evmAddress.parse(identity.address) },
      ref: PurchaseRef.parse(identity.ref), requestId: z.string().uuid().parse(identity.requestId), paymentId: q.paymentId, quoteId: q.quoteId, routeId: q.routeId,
      source: { ...source, scheme: o.scheme, challengeNonce: o.extra.challengeNonce, routeBinding: o.extra.routeBinding, fundsMoveOnCredential: false as const },
      destination: { ...d, decimals: d.decimals ?? PATHUSD_DECIMALS }, approvalDeadlineMs: a.deadlineMs });
  } catch { throw new StoreError("quote_inconsistent"); }
}

function extraKeysMatch(kind: keyof typeof EXTRA_KEYS, extra: Record<string, unknown>): boolean {
  const keys = Object.keys(extra);
  const allowed = new Set([...EXTRA_KEYS[kind].required, ...EXTRA_KEYS[kind].optional]);
  return EXTRA_KEYS[kind].required.every((key) => key in extra) && keys.every((key) => allowed.has(key));
}

/**
 * 0.2.0 builder (docs/payer-rails-design.md §2.4): one strict document for every rail, static and dynamic. The offer's rail-specific
 * checks are the dispatcher `npm run sign` uses (`classifyOffer`: table membership, EIP-712 domain, Solana fee payer/memo, the MPP
 * challenge's contents, expiry, the signing cap), restricted to the payer's testnets. Everything else is compared field by field and
 * the Router's `subject` must equal what this record implies. `ownerKey` is validated but NEVER copied into the record.
 */
export function buildRecord(response: unknown, identity: RecordIdentity, now = Date.now()): ApprovalRecord {
  let railRefused = false;
  try {
    const raw = jsonCopy(response) as Record<string, JsonValue>;
    if (raw["ok"] !== true || raw["approvalRequired"] !== true) throw 0;
    const q = quoteSchema.parse(raw["quote"]);
    const { source: s, destination: d, approval: a } = q;
    const o = s.offer;
    const kind: RecordKind = q.routeId.startsWith("dyn-") ? "dynamic" : "static";
    const trusted = routerIdentity(identity.routerUrl, identity.canonicalResource);
    const resource = canonicalResourceFor(trusted.canonicalBase, q.routeId);
    if (q.resource.url !== resource.url || q.resource.method !== resource.method) throw 0;
    // Rail-specific validity, before anything else is trusted. A refusal here is "this payer cannot pay this offer", not a malformed quote.
    const dispatch = classifyOffer(o, now);
    if (dispatch.kind === "refuse") { railRefused = true; throw 0; }
    const keyRail: KeyRail | undefined = keyRailOf(o.network);
    if (keyRail === undefined) { railRefused = true; throw 0; }
    if (!extraKeysMatch(dispatch.kind, o.extra)) throw 0;
    if ("assetTransferMethod" in o.extra && o.extra["assetTransferMethod"] !== "eip3009") throw 0;
    const extraChallenge = o.extra["challenge"];
    if ((dispatch.kind === "mpp" || dispatch.kind === "mpp-svm") && (typeof extraChallenge !== "string" || extraChallenge.length > MAX_CHALLENGE_CHARS)) throw 0;
    const rail = dispatch.kind === "mpp" || dispatch.kind === "mpp-svm" ? "mpp" : "x402";
    if (s.rail !== rail) throw 0;
    if ((dispatch.kind === "x402-evm" || dispatch.kind === "x402-svm") !== (o.extra.fundsMoveOnCredential === false)) throw 0;
    const known = payerAssetOf(o.network, o.asset);
    if (known === undefined || s.decimals !== known.decimals) throw 0;
    for (const key of ["amount", "asset", "network", "payTo"] as const) if (s[key] !== o[key]) throw 0;
    if (s.expiresAt !== o.extra.expiresAt) throw 0;
    if (q.quoteId !== o.extra.challengeNonce || a.boundTo !== q.quoteId || a.deadlineMs > s.expiresAt * 1000 || a.deadlineMs <= now) throw 0;
    // Dynamic quotes carry all four extra documents; static ones none of them.
    const dynamicFields = [q.upstream, q.pricing, q.disclosures, q.ownerKey].filter((v) => v !== undefined).length;
    if (kind === "dynamic" ? dynamicFields !== 4 : dynamicFields !== 0) throw 0;
    if (kind === "static") { if (o.extra.routeBinding !== staticRouteBindingOf(q.routeId)) throw 0; }
    else {
      if (o.extra.routeBinding !== dynamicRouteBindingOf(q.routeId, q.upstream!.url)) throw 0;
      if (q.pricing!.total !== s.amount || q.pricing!.upstreamAmount !== d.quoted || q.pricing!.sourceDecimals !== s.decimals) throw 0;
      if (d.decimals !== undefined && q.pricing!.destinationDecimals !== d.decimals) throw 0;
      if (q.disclosures!.fundsMoveOnCredential !== o.extra.fundsMoveOnCredential) throw 0;
    }
    const expectedSubject = { quoteId: q.quoteId, paymentId: q.paymentId, routeId: q.routeId, resource: q.resource,
      source: { amount: s.amount, decimals: s.decimals, asset: s.asset, network: s.network, expiresAt: s.expiresAt, offer: o },
      destination: { quoted: d.quoted, asset: d.asset, network: d.network }, approval: a, fundsMoveOnCredential: o.extra.fundsMoveOnCredential,
      ...(kind === "dynamic" ? { upstream: q.upstream, destinationPayTo: d.payTo, destinationDecimals: d.decimals ?? q.pricing!.destinationDecimals, pricing: q.pricing, disclosures: q.disclosures } : {}) };
    if (canonicalJson(jsonCopy(raw["subject"])) !== canonicalJson(jsonCopy(expectedSubject))) throw 0;
    // A 0.1.x-shaped identity (no `wallets`) names only the EVM key.
    const address = (identity.wallets ?? { eip155: identity.address })[keyRail];
    if (address === undefined) { railRefused = true; throw 0; }
    if (keyRail === "eip155" ? !evmAddress.safeParse(address).success : !base58Key.safeParse(address).success) throw 0;
    const { offer: _, ...source } = s;
    // The destination leg is the Router's; when it names an asset of this payer's table, its rail and decimals must agree with the table.
    const destinationKnown = payerAssetOf(d.network, d.asset);
    const destinationNetwork = payerNetworkOf(d.network);
    if (destinationNetwork !== undefined && (destinationKnown === undefined || !destinationNetwork.outbound.includes(d.rail) || (d.decimals !== undefined && d.decimals !== destinationKnown.decimals))) throw 0;
    const destinationDecimals = d.decimals ?? destinationKnown?.decimals ?? q.pricing?.destinationDecimals;
    return frozenCopy({ routerUrl: trusted.routerUrl, resource, wallet: { rail, network: o.network, address },
      ref: PurchaseRef.parse(identity.ref), requestId: z.string().uuid().parse(identity.requestId), paymentId: q.paymentId, quoteId: q.quoteId, routeId: q.routeId,
      source: { ...source, scheme: o.scheme, challengeNonce: o.extra.challengeNonce, routeBinding: o.extra.routeBinding, fundsMoveOnCredential: o.extra.fundsMoveOnCredential, offerSha256: offerDigest(o) },
      destination: { rail: d.rail, network: d.network, asset: d.asset, quoted: d.quoted, payTo: d.payTo, quoteFingerprint: d.quoteFingerprint,
        ...(d.scheme === undefined ? {} : { scheme: d.scheme }), ...(destinationDecimals === undefined ? {} : { decimals: destinationDecimals }) }, approvalDeadlineMs: a.deadlineMs, kind,
      ...(kind === "dynamic" ? { upstream: q.upstream!, pricing: q.pricing!, disclosures: q.disclosures! } : {}) });
  } catch { throw new StoreError(railRefused ? "rail_not_enabled" : "quote_inconsistent"); }
}

export function assertApproval(r: ApprovalRecord, offer: unknown, approvedHash: string, locked: boolean, now = Date.now()): void {
  if (locked) throw new StoreError("locked");
  if (r.approvalDeadlineMs <= now || r.source.expiresAt * 1000 <= now) throw new StoreError("approval_expired");
  if (approvedHash !== recordHash(r)) throw new StoreError("approval_mismatch");
  if (recordVersionOf(r) === 1) {
    const parsed = offerSchemaV1.safeParse(offer);
    if (!parsed.success) throw new StoreError("approval_mismatch");
    const o = parsed.data;
    for (const k of ["scheme", "network", "asset", "amount", "payTo"] as const) if (o[k] !== r.source[k]) throw new StoreError("approval_mismatch");
    for (const k of ["expiresAt", "challengeNonce", "routeBinding", "fundsMoveOnCredential"] as const) if (o.extra[k] !== r.source[k]) throw new StoreError("approval_mismatch");
    return;
  }
  const parsed = offerBase.safeParse(offer);
  if (!parsed.success || r.source.offerSha256 === undefined) throw new StoreError("approval_mismatch");
  const o = parsed.data;
  for (const k of ["scheme", "network", "asset", "amount", "payTo"] as const) if (o[k] !== r.source[k]) throw new StoreError("approval_mismatch");
  for (const k of ["expiresAt", "challengeNonce", "routeBinding", "fundsMoveOnCredential"] as const) if (o.extra[k] !== r.source[k]) throw new StoreError("approval_mismatch");
  // Every transaction-affecting field (fee payer, memo, EIP-712 domain, the MPP challenge's full text, externalId, …): the whole offer, canonically.
  let digest: string;
  try { digest = offerDigest(offer); } catch { throw new StoreError("approval_mismatch"); }
  if (digest !== r.source.offerSha256) throw new StoreError("approval_mismatch");
}

export function kindOf(r: ApprovalRecord): RecordKind { return r.kind ?? "static"; }
export function subjectOf(r: ApprovalRecord): SubjectSummary {
  const s = r.source; const { quoteFingerprint: _, scheme: __, ...reaches } = r.destination;
  const kind = kindOf(r);
  return SubjectSummary.parse({ amount: s.amount, decimals: s.decimals, asset: s.asset, network: s.network, payTo: s.payTo,
    deadlineMs: r.approvalDeadlineMs, fundsMoveOnCredential: s.fundsMoveOnCredential, reaches,
    routeId: r.routeId, kind, scheme: s.scheme, needsSol: s.scheme === "solana/charge",
    ...(r.upstream ? { upstreamUrl: r.upstream.url } : {}),
    ...(r.pricing ? { pricing: { upstreamAmount: r.pricing.upstreamAmount, fee: r.pricing.fee, total: r.pricing.total, ...(r.pricing.maxFee === undefined ? {} : { maxFee: r.pricing.maxFee }) } } : {}),
    ...(r.disclosures ? { disclosures: r.disclosures } : {}) });
}
/** Strip controls/format characters and all whitespace except LF from values, before adding trusted labels. */
export function sanitize(text: string): string { return text.replace(/[^\S\n]|[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, (c) => c === "\n" ? c : ""); }
/** Fixed, rail-specific statement of WHEN funds move (docs/payer-rails-design.md §2.6). Never from the quote. */
export function fundsLineOf(scheme: ApprovalRecord["source"]["scheme"]): string {
  switch (scheme) {
    case "tempo/charge": return "Funds: the daemon SENDS this transfer right after you approve; it cannot be undone and nothing is refunded if the Router later refuses.";
    case "solana/charge": return "Funds: signing only; the Router broadcasts at purchase. Your Solana key pays the network fee (devnet SOL).";
    default: return "Funds: signing only; the facilitator broadcasts and pays gas at purchase.";
  }
}
export function render(r: ApprovalRecord): string {
  const s = r.source; const d = r.destination; const kind = kindOf(r);
  const resourcePath = (() => { try { return new URL(r.resource.url).pathname; } catch { return RESOURCE_PATH; } })();
  const lines = [
    `Router: ${sanitize(r.routerUrl)}`, `Resource: ${r.resource.method} ${sanitize(resourcePath)} (Router-internal, fixed by this payer)`, `Wallet: ${sanitize(r.wallet.address)}`,
    `${kind === "dynamic" ? "Profile" : "Route"}: ${sanitize(r.routeId)}`,
    `Pay: ${sanitize(s.amount)} base units (decimals ${s.decimals}) ${sanitize(s.asset)} on ${sanitize(s.network)}`,
    `Recipient: ${sanitize(s.payTo)}`,
    `Rail: ${sanitize(s.rail)} (${sanitize(s.scheme)}) on ${sanitize(s.network)}`,
    fundsLineOf(s.scheme),
  ];
  if (kind === "dynamic" && r.upstream && r.pricing && r.disclosures) {
    lines.push(
      `Upstream (NOT verified by the operator): ${r.upstream.method} ${sanitize(r.upstream.url)}`,
      `Upstream recipient: ${sanitize(d.payTo)} (${sanitize(d.rail)} ${sanitize(d.network)} ${sanitize(d.asset)}, decimals ${d.decimals ?? "not supplied"})`,
      `Price: upstream ${sanitize(r.pricing.upstreamAmount)} + Router fee ${sanitize(r.pricing.fee)} = total ${sanitize(r.pricing.total)} base units (decimals ${s.decimals})` +
        (r.pricing.maxFee === undefined ? "" : `; chain-fee cap ${sanitize(r.pricing.maxFee)}${r.pricing.estimate ? ` (estimated ${new Date(r.pricing.estimate.atMs).toISOString()})` : ""}`),
      "Disclosures: no refund if the upstream takes the payment and returns no usable data, or if the Router refuses after your funds moved; only an application/json object <= 256 KiB is delivered.",
    );
  } else {
    lines.push(
      `Destination (operator fixed): ${sanitize(d.rail)} ${sanitize(d.network)} ${sanitize(d.asset)}`,
      `Destination amount: ${sanitize(d.quoted)} base units (decimals ${d.decimals ?? "not supplied"}); recipient: ${sanitize(d.payTo)}`,
      "Fee breakdown: not supplied for this static route.",
    );
  }
  lines.push(`Deadline: ${new Date(r.approvalDeadlineMs).toISOString()}`);
  lines.push(s.scheme === "tempo/charge" ? "Approving sends the transfer. The Router then pays the destination on purchase." : "Signing creates a credential only. The Router may move funds on purchase.");
  return lines.join("\n");
}
export { HOSTED_CANONICAL_BASE };
