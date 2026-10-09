import { appendFileSync } from "node:fs";
import path from "node:path";
import { startDaemon } from "../../src/daemon/startup.js";
import { startupMessage } from "../../src/daemon/run.js";
import { SocketListenError } from "../../src/daemon/server.js";
import { fixtureHooks } from "./daemon.js";
import type { FixtureStore } from "./store.js";

interface Bootstrap { home: string; installRoot: string; passphrase: string; phrase: string; point?: string; wrong?: boolean; noUi?: boolean }
// This entire entry is excluded from the package. Fixture secrets travel over owned IPC, never production flags/env.
const watchdog = setTimeout(() => process.exit(3), 45_000);
process.once("disconnect", () => process.exit(3));
process.once("message", async (input: Bootstrap) => {
  const store: FixtureStore = { ...input, dir: path.join(input.home, ".config", "subetha-payer"), cleanup: () => undefined };
  const event = (name: string): void => {
    appendFileSync(path.join(input.home, "events.ndjson"), `${JSON.stringify({ event: name })}\n`, { mode: 0o600 });
    process.send?.({ event: name });
  };
  const hooks = fixtureHooks(store, event);
  // The test runner needs an installed loader. Only this test entry supplies simulated guarded execArgv;
  // production bin tests below use real argv and never bypass preflight.
  try {
    const daemon = await startDaemon({
      env: process.env, execArgv: ["--disable-sigusr1"], installRoot: store.installRoot,
      hooks: { ...hooks,
        ...(input.noUi ? { ui: { available: async () => false } } : {}),
        ...(input.wrong ? { tty: { available: true, read: async () => { event("Passphrase"); return "incorrect-fixture-passphrase"; } } } : {}),
        faults: { hit: async (point) => { event(point); if (point === input.point) await new Promise<void>(() => undefined); } },
      },
    });
    if (!daemon) throw new Error("fixture_missing_daemon");
    event("listening");
    process.send?.({ event: "scrubbed", forbiddenPresent: Object.keys(process.env).some((key) => key === "NODE_OPTIONS" || key.startsWith("DYLD_") || key === "SUBETHA_PAYER_PASSPHRASE") });
    const stop = (): void => { void daemon.close(); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await daemon.closed;
    clearTimeout(watchdog);
    process.exit(0);
  } catch (error) {
    process.stderr.write(startupMessage(error));
    if (error instanceof SocketListenError) process.stderr.write(`socket_errno: ${error.cause.code}\n`);
    clearTimeout(watchdog);
    process.exit(2);
  }
});
