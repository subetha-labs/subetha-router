import { createPurchaseCore } from "./purchase.js";
import { failure, type RoutesSummary } from "../protocol/summary.js";
import type { QuoteInput } from "../protocol/socket.js";
import { record, routerFailure, ROUTE_ID_PATTERN } from "../router/client.js";
import { inboundRailsOf, keyRailOf, payerAssetOf, ARC_TESTNET, BASE_SEPOLIA, SOLANA_DEVNET, TEMPO_TESTNET } from "../sign/networks.js";
import type { DaemonContext } from "./interfaces.js";
import type { Handler } from "./server.js";

/** P-3b owns durable quote/ApprovalRecord creation; P-3c owns status reconciliation. */
export interface ReadModels {
  purchase?(ref: string): Promise<unknown>;
  hasRef(ref: string): boolean;
  quote(input: QuoteInput): Promise<unknown>;
  status(ref: string, includeBody: boolean): Promise<unknown>;
}

type Route = RoutesSummary["routes"][number];
type Rail = "x402" | "mpp";

/**
 * Inbound rail of a static route in the hosted listing (docs/payer-rails-design.md FR-R13). `source.rail` when the Router sends it
 * (Routers from R-0 on); otherwise the table's only inbound rail for that network; Solana (x402 and MPP both allowed) falls back to the
 * routeId convention `…-solmpp` = MPP. The quote's offer scheme is authoritative later; this only labels the listing.
 */
export function staticSourceRailOf(routeId: string, source: Record<string, unknown>): Rail | undefined {
  if (source["rail"] === "x402" || source["rail"] === "mpp") return source["rail"];
  const network = typeof source["network"] === "string" ? source["network"] : "";
  const rails = inboundRailsOf(network);
  if (rails.length === 1) return rails[0];
  if (rails.length === 2) return routeId.endsWith("-solmpp") ? "mpp" : "x402";
  return undefined;
}

function payable(network: unknown, asset: unknown, decimals: unknown): network is string {
  return typeof network === "string" && typeof asset === "string" && keyRailOf(network) !== undefined && payerAssetOf(network, asset) !== undefined && payerAssetOf(network, asset)!.decimals === decimals;
}
function reachesOf(destination: Record<string, unknown>): Route["reaches"] | undefined {
  const rail = destination["rail"];
  if ((rail !== "x402" && rail !== "mpp") || typeof destination["network"] !== "string" || typeof destination["asset"] !== "string") return undefined;
  return { rail, network: destination["network"], asset: destination["asset"] };
}

/** Every static route and dynamic profile of the listing this payer can pay, as `RouteSummary` rows (FR-R1). Unpayable rows are dropped. */
export function routeRowsOf(response: Record<string, unknown>): Route[] {
  const rows: Route[] = [];
  for (const route of Array.isArray(response["routes"]) ? response["routes"] : []) {
    if (!record(route) || typeof route["routeId"] !== "string" || !ROUTE_ID_PATTERN.test(route["routeId"]) || !record(route["source"]) || !record(route["destination"])) continue;
    const source = route["source"], reaches = reachesOf(route["destination"]);
    const rail = staticSourceRailOf(route["routeId"], source);
    if (rail === undefined || reaches === undefined || !payable(source["network"], source["asset"], source["decimals"]) || typeof source["amount"] !== "string") continue;
    rows.push({ routeId: route["routeId"], kind: "static", pays: { rail, network: source["network"], asset: source["asset"] as string, amount: source["amount"], decimals: source["decimals"] as number }, reaches,
      fundsMoveOnCredential: rail === "mpp", needsSol: rail === "mpp" && source["network"] === SOLANA_DEVNET });
  }
  const dynamic = response["dynamic"];
  if (record(dynamic) && dynamic["enabled"] === true && Array.isArray(dynamic["profiles"])) {
    for (const profile of dynamic["profiles"]) {
      if (!record(profile) || typeof profile["profileId"] !== "string" || !ROUTE_ID_PATTERN.test(profile["profileId"]) || !record(profile["source"]) || !record(profile["destination"])) continue;
      const source = profile["source"], reaches = reachesOf(profile["destination"]);
      const rail = source["rail"];
      if ((rail !== "x402" && rail !== "mpp") || reaches === undefined || !payable(source["network"], source["asset"], source["decimals"])) continue;
      rows.push({ routeId: profile["profileId"], kind: "dynamic", pays: { rail, network: source["network"], asset: source["asset"] as string, decimals: source["decimals"] as number }, reaches,
        fundsMoveOnCredential: rail === "mpp", needsSol: rail === "mpp" && source["network"] === SOLANA_DEVNET });
    }
  }
  return rows;
}

/** One row per (rail, network) this store can pay on (FR-R11). Public addresses only. */
export function walletRows(context: DaemonContext): { rail: Rail; network: string; address: string }[] {
  const rows: { rail: Rail; network: string; address: string }[] = [];
  const evm = context.wallets.eip155 ?? context.address;
  if (evm) rows.push({ rail: "x402", network: BASE_SEPOLIA, address: evm }, { rail: "x402", network: ARC_TESTNET, address: evm }, { rail: "mpp", network: TEMPO_TESTNET, address: evm });
  const sol = context.wallets.solana;
  if (sol) rows.push({ rail: "x402", network: SOLANA_DEVNET, address: sol }, { rail: "mpp", network: SOLANA_DEVNET, address: sol });
  return rows;
}

export function createDaemonHandler(context: DaemonContext, reads: ReadModels = createPurchaseCore(context)): Handler {
  return async (request) => {
    context.assertHeld();
    switch (request.method) {
      case "inspect": return createPurchaseCore(context).inspect(request.params.ref);
      case "ping": return { ok: true, state: context.session.locked ? "locked" : "unlocked", version: "0.2.1" };
      case "wallet": return { ok: true, wallets: walletRows(context) };
      case "find_routes": {
        const response = await context.router.listRoutes();
        if (response["ok"] === false) return routerFailure(response);
        if (response["ok"] !== true || !Array.isArray(response["routes"])) return failure("response_unreadable");
        const routes = routeRowsOf(response);
        const hold = request.params.hold;
        return { ok: true, routes: hold === undefined ? routes : routes.filter(route => hold.some(h => h.network === route.pays.network && h.asset.toLowerCase() === String(route.pays.asset).toLowerCase())) };
      }
      case "quote": return reads.quote(request.params);
      case "status": return reads.hasRef(request.params.ref) ? reads.status(request.params.ref, request.params.includeBody === true) : failure("unknown_ref");
      case "purchase": {
        context.assertHeld();
        if (!reads.hasRef(request.params.ref)) return failure("unknown_ref");
        if (!reads.purchase && context.session.locked) return failure("locked");
        return reads.purchase ? reads.purchase(request.params.ref) : failure("approval_unavailable");
      }
    }
  };
}
