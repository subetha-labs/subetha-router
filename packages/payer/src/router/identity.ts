import { StoreError } from "../store/fs.js";
import { STATIC_ROUTE } from "./client.js";

export const HOSTED_ROUTER_URL = "https://router.subethalabs.com/mcp";
export const RESOURCE_PATH = `/v1/routes/${STATIC_ROUTE}/resource`;
export const HOSTED_RESOURCE_URL = `http://127.0.0.1:8500${RESOURCE_PATH}`;
export const ROUTE_BINDING = [STATIC_ROUTE, "GET", RESOURCE_PATH].map(encodeURIComponent).join("|");
export interface ResourceIdentity { readonly url: string; readonly method: "GET" }

/** Trusted startup configuration only: never infer canonical identity from a Router response. */
export function routerIdentity(routerUrl: string, canonicalResource?: ResourceIdentity) {
  function exactUrl(value: string): URL {
    const url = new URL(value);
    if (url.href !== value || url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#") ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) throw 0;
    return url;
  }
  try {
    exactUrl(routerUrl);
    const resource = canonicalResource ?? (routerUrl === HOSTED_ROUTER_URL ? { url: HOSTED_RESOURCE_URL, method: "GET" as const } : undefined);
    if (!resource || resource.method !== "GET" || exactUrl(resource.url).pathname !== RESOURCE_PATH) throw 0;
    return Object.freeze({ routerUrl, resource: Object.freeze({ url: resource.url, method: resource.method }) });
  } catch { throw new StoreError("config_invalid"); }
}
