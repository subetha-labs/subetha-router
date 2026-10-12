import { z } from "zod";
import { InspectionSummary, FailureSummary, PingSummary, PurchaseBodySummary, PurchaseRef, PurchaseSummary, QuoteSummary, RouteSummary, RoutesSummary, WalletSummary } from "./summary.js";
import { ROUTE_ID_PATTERN, validUpstreamUrl } from "../router/client.js";

const empty = z.object({}).strict();
const routeId = z.string().regex(ROUTE_ID_PATTERN);
/**
 * A static route (`{routeId}`) or a dynamic profile with the upstream URL (`{profileId, url}`; docs/payer-rails-design.md FR-R2).
 * One object schema (MCP tool input schemas must be objects); exactly one of the two forms is accepted.
 */
export const QuoteInput = z.object({
  routeId: routeId.optional(),
  profileId: routeId.optional(),
  url: z.string().max(2048).refine(validUpstreamUrl, "https URL without userinfo or fragment").optional(),
}).strict().refine((v) => (v.routeId !== undefined && v.profileId === undefined && v.url === undefined) || (v.routeId === undefined && v.profileId !== undefined && v.url !== undefined),
  "pass {routeId} for a static route or {profileId, url} for a dynamic provider URL");
export type QuoteInput = z.infer<typeof QuoteInput>;
export function isStaticQuoteInput(input: QuoteInput): input is QuoteInput & { routeId: string } { return input.routeId !== undefined; }
export const inputs = {
  ping: empty, wallet: empty,
  inspect: z.object({ ref: PurchaseRef.optional() }).strict(),
  find_routes: z.object({ hold: z.array(RouteSummary.shape.pays.pick({ network: true, asset: true }).strict()).max(200).optional() }).strict(),
  quote: QuoteInput,
  purchase: z.object({ ref: PurchaseRef }).strict(),
  status: z.object({ ref: PurchaseRef, includeBody: z.boolean().optional() }).strict(),
};
const id = z.union([z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)]);
export const Request = z.discriminatedUnion("method", [
  z.object({ id, method: z.literal("inspect"), params: inputs.inspect }).strict(),
  z.object({ id, method: z.literal("ping"), params: inputs.ping }).strict(),
  z.object({ id, method: z.literal("wallet"), params: inputs.wallet }).strict(),
  z.object({ id, method: z.literal("find_routes"), params: inputs.find_routes }).strict(),
  z.object({ id, method: z.literal("quote"), params: inputs.quote }).strict(),
  z.object({ id, method: z.literal("purchase"), params: inputs.purchase }).strict(),
  z.object({ id, method: z.literal("status"), params: inputs.status }).strict(),
]);
export type Request = z.infer<typeof Request>;
export const summaries = { inspect: InspectionSummary, ping: PingSummary, wallet: WalletSummary, find_routes: RoutesSummary, quote: QuoteSummary, purchase: PurchaseSummary, status: PurchaseSummary };
export function summaryFor(method: Request["method"], params: Record<string, unknown>) {
  return method === "status" && params["includeBody"] === true ? PurchaseBodySummary : summaries[method];
}
export const Response = z.union([
  z.object({ id, ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({ id: id.nullable(), ok: z.literal(false), error: z.object({ code: z.union([FailureSummary.shape.error, z.literal("invalid_request")]), reason: FailureSummary.shape.reason, retryAfterMs: FailureSummary.shape.retryAfterMs }).strict() }).strict(),
]);
// UI120s + Router30s + bounded scheduling/fs margin; neither extends approval expiry.
export const ACTIVE_REQUEST_MS = 180_000;
export const SHIM_REQUEST_MS = 185_000;
// JSON escaping can expand a 256 KiB body sixfold, plus the bounded preview/envelope.
export const MAX_RESPONSE_BYTES = 6 * 262_144 + 16_384;
