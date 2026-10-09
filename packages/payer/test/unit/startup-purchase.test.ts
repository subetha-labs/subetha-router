/** File/in-process startup coverage: no socket, subprocess, native UI or real signer. */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import * as startup from "../../src/daemon/startup.js";
import { runDaemon } from "../../src/daemon/run.js";
import { createDaemonHandler } from "../../src/daemon/handler.js";
import { generateRef } from "../../src/daemon/ref.js";
import { RouterClient } from "../../src/router/client.js";
import { HOSTED_ROUTER_URL, HOSTED_RESOURCE_URL } from "../../src/router/identity.js";
import { dispatchLine } from "../../src/daemon/server.js";
import type { DaemonHooks } from "../../src/daemon/interfaces.js";
import { fixtureStore } from "../harness/store.js";
import { h1Quote } from "../harness/router.js";

const lockDeps = { startedAtOf: () => "fixture-start", isAlive: () => true };
function hooks(store: ReturnType<typeof fixtureStore>): DaemonHooks {
  return {
    ui: { available: async () => true },
    tty: { available: true, read: async label => label === "Passphrase" ? store.passphrase : store.phrase },
    handler: createDaemonHandler, listen: async () => ({ close: async () => undefined }), recover: async () => undefined,
  };
}

test("default startup wires trusted hosted identity and production generator into real core", async () => {
  const store = fixtureStore(); unlinkSync(path.join(store.dir, "config.json"));
  const quote = vi.spyOn(RouterClient.prototype, "quote").mockResolvedValue(h1Quote());
  const purchase = vi.spyOn(RouterClient.prototype, "purchase");
  const oldUmask = process.umask();
  const daemon = await startup.startDaemon({ env: { HOME: store.home, SUBETHA_PAYER_ROUTER_URL: "https://hostile.invalid/mcp" }, execArgv: ["--disable-sigusr1"], installRoot: store.installRoot, hooks: hooks(store), lockDeps });
  try {
    expect(daemon!.context.purchase!.routerUrl).toBe(HOSTED_ROUTER_URL);
    expect(daemon!.context.purchase!.canonicalResource).toEqual({ url: HOSTED_RESOURCE_URL, method: "GET" });
    expect(daemon!.context.purchase!.generateRef).toBe(generateRef);
    const handler = createDaemonHandler(daemon!.context);
    const q: any = await handler({ id: 1, method: "quote", params: { routeId: "md-mpp-eth-snapshot" } });
    expect(q.ok).toBe(true); expect(q.ref).toMatch(/^p_[a-z2-7]{12}[acegikmoqsuwy246]$/);
    expect(daemon!.context.ledger.rows[0]!.ref).toBe(q.ref);
    expect(await handler({ id: 2, method: "purchase", params: { ref: q.ref } })).toMatchObject({ error: "approval_unavailable" });
    expect(quote).toHaveBeenCalledTimes(1); expect(purchase).not.toHaveBeenCalled();
  } finally { await daemon?.close(); vi.restoreAllMocks(); process.umask(oldUmask); store.cleanup(); }
});

test("custom transport without trusted resource refuses before secrets/quote", async () => {
  const store = fixtureStore(); const h = hooks(store); const read = vi.spyOn(h.tty, "read");
  const quote = vi.spyOn(RouterClient.prototype, "quote");
  writeFileSync(path.join(store.dir, "config.json"), JSON.stringify({ version: 1, router: { url: "http://127.0.0.1:9999/mcp" } }));
  try {
    await expect(startup.startDaemon({ env: { HOME: store.home }, execArgv: ["--disable-sigusr1"], installRoot: store.installRoot, hooks: h, lockDeps })).rejects.toThrow("config_invalid");
    expect(read).not.toHaveBeenCalled(); expect(quote).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); store.cleanup(); }
});

test("disposable legacy ledger keeps exact bytes; protocol purchase and actual production recovery refuse", async () => {
  // Capture the unchanged production recovery callback without starting a daemon or accessing HOME.
  let recover!: DaemonHooks["recover"];
  const capture = vi.spyOn(startup, "startDaemon").mockImplementation(async options => { recover = options.hooks.recover; return undefined; });
  expect(await runDaemon(["--check"], ["--disable-sigusr1"])).toBe(0); capture.mockRestore();
  const store = fixtureStore(); const oldUmask = process.umask();
  const options = { env: { HOME: store.home }, execArgv: ["--disable-sigusr1"], installRoot: store.installRoot, hooks: hooks(store), lockDeps };
  const daemon = await startup.startDaemon(options);
  const legacy = "p_aaaaaaaaaaa";
  try {
    daemon!.context.ledger.append({ ref: legacy, state: "signed", data: { legacy: true } });
    const bytes = readFileSync(path.join(store.dir, "ledger.ndjson"));
    const handler = createDaemonHandler(daemon!.context);
    expect(await dispatchLine(JSON.stringify({ id: 1, method: "purchase", params: { ref: legacy } }), handler)).toMatchObject({ error: { code: "invalid_request" } });
    expect(await handler({ id: 2, method: "purchase", params: { ref: legacy } })).toMatchObject({ error: "unknown_ref" });
    await expect(recover(daemon!.context)).rejects.toThrow("recovery_unavailable");
    await daemon!.close();
    const purchase = vi.spyOn(RouterClient.prototype, "purchase"); const quote = vi.spyOn(RouterClient.prototype, "quote");
    await expect(startup.startDaemon({ ...options, hooks: { ...options.hooks, recover } })).rejects.toThrow("recovery_unavailable");
    expect(readFileSync(path.join(store.dir, "ledger.ndjson"))).toEqual(bytes);
    expect(purchase).not.toHaveBeenCalled(); expect(quote).not.toHaveBeenCalled();
  } finally { await daemon?.close(); vi.restoreAllMocks(); process.umask(oldUmask); store.cleanup(); }
});
