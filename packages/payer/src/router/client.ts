import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { failure, knownCodeOf, type FailureSummary } from "../protocol/summary.js";

export const ROUTER_TIMEOUT_MS = 30_000;
export const PAYER_VERSION = "0.2.1";
/** The 0.1.x payer's only route. Still the default static example; the v1 record builder is bound to it (docs/payer-rails-design.md §2.4a). */
export const STATIC_ROUTE = "md-mpp-eth-snapshot";
/** `md-…` static routes and `dyn-…` dynamic profiles share one id namespace. */
export const ROUTE_ID_PATTERN = /^(md|dyn)-[a-z0-9-]{1,60}$/;
/** Upstream URL a dynamic quote may name: https, bounded, printable ASCII, no userinfo or fragment (the Router checks again). */
export function validUpstreamUrl(value: string): boolean {
  if (value.length > 2048 || !/^https:\/\/[\x21-\x7e]{1,2040}$/.test(value)) return false;
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.hash && u.href === value; } catch { return false; }
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Internal H-1 data, never a socket Summary. Do not log this object. */
export function decodeToolResult(result: unknown): Record<string, unknown> {
  if (!record(result)) throw new Error("response_unreadable");
  let value: unknown = result["structuredContent"];
  if (value === undefined) {
    const content = result["content"];
    const first: unknown = Array.isArray(content) ? content[0] : undefined;
    if (!record(first) || first["type"] !== "text" || typeof first["text"] !== "string") throw new Error("response_unreadable");
    value = JSON.parse(first["text"]);
  }
  if (!record(value)) throw new Error("response_unreadable");
  return value;
}

export function routerFailure(value: Record<string, unknown>): FailureSummary {
  return failure(knownCodeOf(value["error"]), {
    ...(value["reason"] === undefined ? {} : { reason: knownCodeOf(value["reason"]) }),
    ...(typeof value["retryAfterMs"] === "number" ? { retryAfterMs: value["retryAfterMs"] } : {}),
  });
}

export type RouterStatus =
  | { readonly kind: "found"; readonly projection: Record<string, unknown> }
  | { readonly kind: "not_found"; readonly reason: "not_found" }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * The hosted MCP wraps a dynamic purchase's body as `result: { untrusted, source, contentType, body }` on status reads; a static
 * projection carries the body at `result` directly. Normalize to the static shape BEFORE anything compares, projects or stores it
 * (docs/payer-rails-design.md §2.5). Idempotent.
 */
export function normalizeProjection(projection: Record<string, unknown>): Record<string, unknown> {
  const result = projection["result"];
  if (record(result) && result["untrusted"] === true && result["source"] === "upstream" && "body" in result) {
    const { result: _, ...rest } = projection;
    return { ...rest, result: result["body"] };
  }
  return projection;
}

export function statusOf(value: unknown): RouterStatus {
  if (!record(value)) return { kind: "unreadable", reason: "projection_malformed" };
  if (value["found"] === true) {
    const projection = value["projection"];
    if (record(projection) && ["paymentId", "routeId", "status", "updatedAt", "quoteFingerprint"].every((key) => typeof projection[key] === "string" && projection[key] !== "") && record(projection["source"]) && record(projection["destination"])) {
      return { kind: "found", projection: normalizeProjection(projection) };
    }
    return { kind: "unreadable", reason: "projection_malformed" };
  }
  if (value["found"] === false && value["reason"] === "not_found") return { kind: "not_found", reason: "not_found" };
  return { kind: "unreadable", reason: knownCodeOf(value["reason"] ?? value["error"] ?? "projection_malformed") };
}

export interface PurchaseInput { quoteId: string; requestId: string; approval: string; credential: string; quote: unknown }

export interface Router {
  purchase(input: PurchaseInput): Promise<Record<string, unknown>>;
  listRoutes(): Promise<Record<string, unknown>>;
  quote(routeId: string, requestId: string): Promise<Record<string, unknown>>;
  /** Dynamic profile + upstream URL (`subetha_router_quote_url`). */
  quoteUrl(profileId: string, url: string, requestId: string): Promise<Record<string, unknown>>;
  /** `ownerKey` is required to read a dynamic purchase; it is taken from the sealed quote, never from a caller. */
  status(paymentId: string, ownerKey?: string): Promise<RouterStatus>;
}

/** One SDK client/transport per request, including initialization in the absolute deadline. No automatic retries. */
export class RouterClient implements Router {
  private readonly url: URL;
  constructor(url: URL) {
    this.url = new URL(url.href);
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) {
      throw new Error("router_config_invalid");
    }
  }
  private async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const client = new Client({ name: "subetha-payer", version: PAYER_VERSION });
    const transport = new StreamableHTTPClientTransport(this.url, {
      requestInit: { redirect: "error" },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
      fetch: (url, init) => fetch(url, { ...init, redirect: "error", signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) }),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("router_unavailable")); }, ROUTER_TIMEOUT_MS);
    });
    try {
      return await Promise.race([deadline, (async () => {
        // SDK 1.32.1 declares concrete sessionId as string|undefined but Transport as sessionId?: string.
        await client.connect(transport as Transport, { timeout: ROUTER_TIMEOUT_MS, signal: controller.signal });
        return decodeToolResult(await client.callTool({ name, arguments: args }, undefined, { timeout: ROUTER_TIMEOUT_MS, signal: controller.signal }));
      })()]);
    } catch { return { ok: false, error: "router_unavailable" }; }
    finally {
      clearTimeout(timer);
      controller.abort();
      // SDK close aborts fetch and closes local streams; no terminateSession DELETE or retry.
      await client.close().catch(() => undefined);
    }
  }
  listRoutes(): Promise<Record<string, unknown>> { return this.call("subetha_router_list_routes", {}); }
  quote(routeId: string, requestId: string): Promise<Record<string, unknown>> {
    if (!ROUTE_ID_PATTERN.test(routeId)) return Promise.resolve({ ok: false, error: "unknown_route" });
    return this.call("subetha_router_quote", { routeId, requestId });
  }
  quoteUrl(profileId: string, url: string, requestId: string): Promise<Record<string, unknown>> {
    if (!ROUTE_ID_PATTERN.test(profileId)) return Promise.resolve({ ok: false, error: "unknown_route" });
    if (!validUpstreamUrl(url)) return Promise.resolve({ ok: false, error: "invalid_upstream_url" });
    return this.call("subetha_router_quote_url", { profileId, url, requestId });
  }
  purchase(input: PurchaseInput): Promise<Record<string, unknown>> {
    return this.call("subetha_router_purchase", { ...input });
  }
  async status(paymentId: string, ownerKey?: string): Promise<RouterStatus> {
    const value = statusOf(await this.call("subetha_router_status", { paymentId, ...(ownerKey === undefined ? {} : { ownerKey }) }));
    if (value.kind === "found" && value.projection["paymentId"] !== paymentId) return { kind: "unreadable", reason: "payment_id_mismatch" };
    return value;
  }
}
