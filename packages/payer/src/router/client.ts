import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { failure, knownCodeOf, type FailureSummary } from "../protocol/summary.js";

export const ROUTER_TIMEOUT_MS = 30_000;
export const STATIC_ROUTE = "md-mpp-eth-snapshot";
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

export function statusOf(value: unknown): RouterStatus {
  if (!record(value)) return { kind: "unreadable", reason: "projection_malformed" };
  if (value["found"] === true) {
    const projection = value["projection"];
    if (record(projection) && ["paymentId", "routeId", "status", "updatedAt", "quoteFingerprint"].every((key) => typeof projection[key] === "string" && projection[key] !== "") && record(projection["source"]) && record(projection["destination"])) {
      return { kind: "found", projection };
    }
    return { kind: "unreadable", reason: "projection_malformed" };
  }
  if (value["found"] === false && value["reason"] === "not_found") return { kind: "not_found", reason: "not_found" };
  return { kind: "unreadable", reason: knownCodeOf(value["reason"] ?? value["error"] ?? "projection_malformed") };
}

export interface Router {
  listRoutes(): Promise<Record<string, unknown>>;
  quote(routeId: string, requestId: string): Promise<Record<string, unknown>>;
  status(paymentId: string): Promise<RouterStatus>;
}

/** One SDK client/transport per request, including initialization in the absolute deadline. No payment method in P-3a. */
export class RouterClient implements Router {
  constructor(private readonly url: URL) {
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) {
      throw new Error("router_config_invalid");
    }
  }
  private async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const client = new Client({ name: "subetha-payer", version: "0.1.0" });
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
    if (routeId !== STATIC_ROUTE) return Promise.resolve({ ok: false, error: "unknown_route" });
    return this.call("subetha_router_quote", { routeId, requestId });
  }
  async status(paymentId: string): Promise<RouterStatus> {
    const value = statusOf(await this.call("subetha_router_status", { paymentId }));
    if (value.kind === "found" && value.projection["paymentId"] !== paymentId) return { kind: "unreadable", reason: "payment_id_mismatch" };
    return value;
  }
}
