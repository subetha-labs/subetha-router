import { expect, test, vi } from "vitest";
import * as startup from "../../src/daemon/startup.js";
import { runDaemon } from "../../src/daemon/run.js";
import { RouterClient } from "../../src/router/client.js";
import { createDaemonHandler } from "../../src/daemon/handler.js";
import { fixtureStore } from "../harness/store.js";
import { fakeUiHelper } from "../harness/ui-helper.js";
import { h1Quote } from "../harness/router.js";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

test("production composition supplies both availability and document-bound confirmation factory", async () => {
  const capture = vi.spyOn(startup, "startDaemon").mockResolvedValue(undefined);
  try {
    expect(await runDaemon(["--check"], ["--disable-sigusr1"])).toBe(0);
    const hooks = capture.mock.calls[0]![0].hooks;
    expect(typeof (hooks as unknown as Record<string, unknown>).createConfirmUi).toBe("function");
    expect(typeof hooks.ui.confirm).toBe("function");
  } finally { capture.mockRestore(); }
});

test.each(["approved", "bad_passphrase", "cancelled", "locked", "expired", "document_replaced"])("real run/startup/core with owned helper: %s", async scenario => {
  const store = fixtureStore();
  const response = scenario === "cancelled" ? "Cancel\nfalse\n\n" : `Approve\nfalse\n${scenario === "bad_passphrase" ? "valid-different-passphrase" : store.passphrase}\n`;
  const f = fakeUiHelper(`process.stdout.write(${JSON.stringify(response)});`);
  const quote = h1Quote();
  vi.spyOn(RouterClient.prototype, "quote").mockResolvedValue(quote);
  const purchase = vi.spyOn(RouterClient.prototype, "purchase").mockResolvedValue({ ok: true, outcome: "delivered", paymentId: quote.quote.paymentId, snapshot: { synthetic: true }, contentType: "application/json" });
  const sign = vi.fn(async () => ({ credential: "synthetic-credential" }));
  // Observe the real startup result; the wrapper does not replace startup behavior.
  const original = startup.startDaemon;
  let resolve!: (daemon: startup.RunningDaemon) => void;
  const ready = new Promise<startup.RunningDaemon>(r => { resolve = r; });
  vi.spyOn(startup, "startDaemon").mockImplementation(async options => { const daemon = await original(options); resolve(daemon!); return daemon; });
  const output = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const oldUmask = process.umask();
  let daemon: startup.RunningDaemon | undefined;
  const running = runDaemon([], ["--disable-sigusr1"], {
    env: { HOME: store.home }, installRoot: store.installRoot, ui: f.deps,
    lockDeps: { startedAtOf: () => "fixture-start", isAlive: () => true },
    tty: { available: true, read: async label => label === "Passphrase" ? store.passphrase : store.phrase },
    listen: async () => ({ close: async () => undefined }),
    configurePurchase: base => ({ ...base, signer: { sign }, ui: { ...base.ui, confirm: async (record, phrase) => {
      const approved = await base.ui.confirm!(record, phrase);
      if (scenario === "locked") daemon!.context.session.close();
      if (scenario === "expired") vi.spyOn(Date, "now").mockReturnValue(record.approvalDeadlineMs);
      return approved;
    } } }),
  });
  try {
    daemon = await Promise.race([ready, running.then(code => { throw new Error(`fixture_start_failed_${code}`); })]);
    if (scenario === "document_replaced") {
      // Valid alternate document is not an authority for this already-unlocked daemon.
      const alternate = fixtureStore();
      try { writeFileSync(path.join(store.dir, "keys.json"), readFileSync(path.join(alternate.dir, "keys.json"))); }
      finally { alternate.cleanup(); }
    }
    const handler = createDaemonHandler(daemon.context);
    const quoted: any = await handler({ id: 1, method: "quote", params: { routeId: "md-mpp-eth-snapshot" } });
    expect(quoted.ok).toBe(true);
    const result = await handler({ id: 2, method: "purchase", params: { ref: quoted.ref } });
    const success = ["approved", "document_replaced"].includes(scenario);
    expect(result).toMatchObject(success ? { outcome: "delivered" } : { error: scenario === "locked" ? "locked" : scenario === "expired" ? "approval_expired" : "approval_rejected" });
    expect(sign).toHaveBeenCalledTimes(success ? 1 : 0); expect(purchase).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(daemon.context.ledger.rows.filter(row => row.state === "approved")).toHaveLength(success ? 1 : 0);
    expect(daemon.context.ledger.rows.filter(row => row.state === "sign_intent")).toHaveLength(success ? 1 : 0);
    expect(f.captures()).toHaveLength(3); // startup probe, purchase probe, single dialog
    expect(f.captures()[2]!.input).toContain(store.phrase);
    expect(JSON.stringify(daemon.context.ledger.rows)).not.toContain(store.passphrase);
    expect(JSON.stringify(output.mock.calls)).not.toContain(store.passphrase);
    await daemon.close(); expect(await running).toBe(0);
  } finally { await daemon?.close(); await running; vi.restoreAllMocks(); process.umask(oldUmask); f.cleanup(); store.cleanup(); }
});
