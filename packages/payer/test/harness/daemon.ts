import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createDaemonHandler, type ReadModels } from "../../src/daemon/handler.js";
import { listenSocket } from "../../src/daemon/server.js";
import { startDaemon } from "../../src/daemon/startup.js";
import type { DaemonContext, DaemonHooks } from "../../src/daemon/interfaces.js";
import { record, routerFailure, STATIC_ROUTE } from "../../src/router/client.js";
import { fixtureStore, type FixtureStore } from "./store.js";

export const FIXTURE_REF = "p_aaaaaaaaaaa";

/** Read-model fixture only. Purchase uses the production handler and always refuses. No signer or approval fake. */
export function fixtureReads(context: DaemonContext): ReadModels {
  let issued = false;
  return {
    hasRef: (ref) => issued && ref === FIXTURE_REF,
    async quote() {
      const response = await context.router.quote(STATIC_ROUTE, randomUUID());
      if (response["ok"] !== true) return routerFailure(response);
      // Fixed fixture ref, deliberately not an implementation of P-3b's disputed ref generator or durable records.
      const quote = response["quote"];
      if (!record(quote) || !record(quote["source"]) || !record(quote["destination"]) || !record(quote["approval"])) throw new Error("fixture_quote_malformed");
      const source = quote["source"];
      const destination = quote["destination"];
      issued = true;
      return { ok: true, ref: FIXTURE_REF, subject: { amount: source["amount"], decimals: source["decimals"], asset: source["asset"], network: source["network"], payTo: source["payTo"], deadlineMs: quote["approval"]["deadlineMs"], fundsMoveOnCredential: false, reaches: { rail: destination["rail"], network: destination["network"], asset: destination["asset"], quoted: destination["quoted"], decimals: destination["decimals"], payTo: destination["payTo"] } }, nextStep: "approve_then_purchase" };
    },
    async status(ref) { return { ok: true, ref, state: "quoted", fundsMoved: "no" }; },
  };
}

export function fixtureHooks(store: FixtureStore, event: (name: string) => void = () => undefined): DaemonHooks {
  return {
    ui: { available: async () => { event("ui"); return true; } },
    tty: { available: true, read: async (label) => { event(label); return label === "Passphrase" ? store.passphrase : store.phrase; } },
    handler: (context) => createDaemonHandler(context, fixtureReads(context)),
    listen: listenSocket,
    recover: async (context) => { context.assertHeld(); event("recover"); },
    faults: { hit: async (point) => { event(point); } },
  };
}

export async function fixtureDaemon(url: URL, ttlMs = 3_600_000) {
  const store = fixtureStore(url.href, ttlMs);
  const events: string[] = [];
  try {
    const running = await startDaemon({ env: { HOME: store.home }, execArgv: ["--disable-sigusr1"], installRoot: store.installRoot, hooks: fixtureHooks(store, (event) => events.push(event)) });
    if (!running) throw new Error("fixture_not_running");
    return { ...running, store, events, async cleanup() { await running.close(); store.cleanup(); } };
  } catch (error) { store.cleanup(); throw error; }
}

export function socketClient(dir: string) {
  const socket = createConnection(path.join(dir, "daemon.sock"));
  const waiting: { resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  let buffered = "";
  socket.setEncoding("utf8");
  socket.setTimeout(35_000, () => socket.destroy(new Error("fixture_socket_timeout")));
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let nl: number;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, nl); buffered = buffered.slice(nl + 1);
      const next = waiting.shift();
      try { next?.resolve(JSON.parse(line)); } catch { next?.reject(new Error("fixture_invalid_response")); }
    }
  });
  socket.on("error", (error) => { for (const next of waiting.splice(0)) next.reject(error); });
  socket.on("close", () => { for (const next of waiting.splice(0)) next.reject(new Error("fixture_socket_closed")); });
  let id = 0;
  return {
    send(method: string, params: Record<string, unknown> = {}) {
      return new Promise<any>((resolve, reject) => { waiting.push({ resolve, reject }); socket.write(`${JSON.stringify({ id: ++id, method, params })}\n`); });
    },
    close() { socket.destroy(); },
  };
}
