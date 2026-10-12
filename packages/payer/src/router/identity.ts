import { StoreError } from "../store/fs.js";
import { ROUTE_ID_PATTERN, STATIC_ROUTE } from "./client.js";
export { ROUTE_ID_PATTERN };

export const HOSTED_ROUTER_URL = "https://router.subethalabs.com/mcp";
/** Origin of the hosted Router's canonical resource URLs (Router-internal loopback, fixed by this payer; FR-F3). */
export const HOSTED_CANONICAL_BASE = "http://127.0.0.1:8500";

export function resourcePathFor(routeId: string): string {
  if (!ROUTE_ID_PATTERN.test(routeId)) throw new StoreError("quote_inconsistent");
  return `/v1/routes/${routeId}/resource`;
}
export interface ResourceIdentity { readonly url: string; readonly method: "GET" }
export function canonicalResourceFor(canonicalBase: string, routeId: string): ResourceIdentity {
  return Object.freeze({ url: `${canonicalBase}${resourcePathFor(routeId)}`, method: "GET" as const });
}
/** `routeBinding` the Router puts in a static route's offer: `<routeId>|GET|<path>`, each part URI-encoded. */
export function staticRouteBindingOf(routeId: string): string {
  return [routeId, "GET", resourcePathFor(routeId)].map(encodeURIComponent).join("|");
}
/** `routeBinding` of a dynamic quote: `dynamic|<profileId>|GET|<encoded upstream URL>` (observed on the hosted Router, 2026-10-12). */
export function dynamicRouteBindingOf(profileId: string, upstreamUrl: string): string {
  if (!ROUTE_ID_PATTERN.test(profileId)) throw new StoreError("quote_inconsistent");
  return ["dynamic", profileId, "GET", upstreamUrl].map(encodeURIComponent).join("|");
}

/** 0.1.x constants (the single static route). Kept for the frozen v1 record builder and its tests only. */
export const RESOURCE_PATH = resourcePathFor(STATIC_ROUTE);
export const HOSTED_RESOURCE_URL = `${HOSTED_CANONICAL_BASE}${RESOURCE_PATH}`;
export const ROUTE_BINDING = staticRouteBindingOf(STATIC_ROUTE);

export interface RouterIdentity {
  readonly routerUrl: string;
  /** Origin (no path) every canonical resource URL of this Router starts with. */
  readonly canonicalBase: string;
  /** The static route's resource (0.1.x field; `canonicalResourceFor(canonicalBase, STATIC_ROUTE)`). */
  readonly resource: ResourceIdentity;
}

function exactUrl(value: string): URL {
  const url = new URL(value);
  if (url.href !== value || url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#") ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) throw 0;
  return url;
}

/**
 * Trusted startup configuration only: never infer canonical identity from a Router response.
 * `canonicalResource` (config) is the static route's resource URL; its origin becomes `canonicalBase` for every route.
 */
export function routerIdentity(routerUrl: string, canonicalResource?: ResourceIdentity): RouterIdentity {
  try {
    exactUrl(routerUrl);
    const resource = canonicalResource ?? (routerUrl === HOSTED_ROUTER_URL ? { url: HOSTED_RESOURCE_URL, method: "GET" as const } : undefined);
    if (!resource || resource.method !== "GET") throw 0;
    const url = exactUrl(resource.url);
    if (url.pathname !== RESOURCE_PATH) throw 0;
    const canonicalBase = resource.url.slice(0, resource.url.length - RESOURCE_PATH.length);
    if (`${canonicalBase}${RESOURCE_PATH}` !== resource.url || canonicalBase !== url.origin) throw 0;
    return Object.freeze({ routerUrl, canonicalBase, resource: Object.freeze({ url: resource.url, method: resource.method }) });
  } catch { throw new StoreError("config_invalid"); }
}
