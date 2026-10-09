import { randomUUID } from "node:crypto";
import { failure } from "../protocol/summary.js";
import { record, routerFailure, STATIC_ROUTE } from "../router/client.js";
import type { DaemonContext } from "./interfaces.js";
import { RefMutex, type Handler } from "./server.js";

/** P-3b owns durable quote/ApprovalRecord creation; P-3c owns status reconciliation. */
export interface ReadModels {
  hasRef(ref: string): boolean;
  quote(): Promise<unknown>;
  status(ref: string, includeBody: boolean): Promise<unknown>;
}

function pendingRecords(context: DaemonContext): ReadModels {
  return {
    hasRef: (ref) => context.ledger.rows.some((row) => row.ref === ref),
    async quote() {
      context.assertHeld();
      const response = await context.router.quote(STATIC_ROUTE, randomUUID());
      // No provisional refs/approval claims: the durable record and its binding belong to P-3b.
      return response["ok"] === false ? routerFailure(response) : failure("approval_unavailable");
    },
    async status() { return failure("approval_unavailable"); },
  };
}

export function createDaemonHandler(context: DaemonContext, reads: ReadModels = pendingRecords(context)): Handler {
  const mutex = new RefMutex();
  return async (request) => {
    context.assertHeld();
    switch (request.method) {
      case "ping": return { ok: true, state: context.session.locked ? "locked" : "unlocked", version: "0.1.0" };
      case "wallet": return { ok: true, wallets: [{ rail: "x402", network: "eip155:84532", address: context.address }] };
      case "find_routes": {
        const response = await context.router.listRoutes();
        if (response["ok"] === false) return routerFailure(response);
        if (response["ok"] !== true || !Array.isArray(response["routes"])) return failure("response_unreadable");
        const selected = response["routes"].filter((route: unknown) => record(route) && route["routeId"] === STATIC_ROUTE);
        if (selected.some((route: Record<string, unknown>) => !record(route["source"]) || route["source"]["network"] !== "eip155:84532" || route["source"]["asset"] !== "0x036CbD53842c5426634e7929541eC2318f3dCF7e" || route["source"]["decimals"] !== 6)) return failure("rail_not_enabled");
        const routes = selected.map((route: Record<string, unknown>) => {
          const source = record(route["source"]) ? route["source"] : {};
          const destination = record(route["destination"]) ? route["destination"] : {};
          // H-1 list_routes omits source.rail. This is the single accepted x402/Base Sepolia route,
          // not a generic inference that other EVM routes also use x402.
          return { routeId: STATIC_ROUTE, kind: "static", pays: { rail: "x402", network: source["network"], asset: source["asset"], amount: source["amount"], decimals: source["decimals"] }, reaches: { rail: destination["rail"], network: destination["network"], asset: destination["asset"] }, fundsMoveOnCredential: false, needsSol: false };
        });
        return { ok: true, routes };
      }
      case "quote": return reads.quote();
      case "status": return reads.hasRef(request.params.ref) ? reads.status(request.params.ref, request.params.includeBody === true) : failure("unknown_ref");
      case "purchase": return mutex.run(request.params.ref, async () => {
        context.assertHeld();
        if (!reads.hasRef(request.params.ref)) return failure("unknown_ref");
        if (context.session.locked) return failure("locked");
        // No UI approval, signer, credential or Router purchase exists in this bounded slice.
        return failure("approval_unavailable");
      });
    }
  };
}
