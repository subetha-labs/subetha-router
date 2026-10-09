import { existsSync } from "node:fs";
import { realFs } from "../../src/store/fs.js";
import { durableEvent } from "./durable.js";
import { createDaemonHandler } from "../../src/daemon/handler.js";
import path from "node:path";
import { startDaemon } from "../../src/daemon/startup.js";
import { startupMessage } from "../../src/daemon/run.js";
import { SocketListenError } from "../../src/daemon/server.js";
import { fixturePurchase } from "./purchase.js";
import { fixtureHooks } from "./daemon.js";
import type { FixtureStore } from "./store.js";
import { listenSocket } from "../../src/daemon/server.js";
import { recordHash } from "../../src/daemon/record.js";

interface Bootstrap { home: string; installRoot: string; passphrase: string; phrase: string; point?: string; wrong?: boolean; noUi?: boolean; purchase?: boolean; cancel?: boolean; observedFile?: string; failFs?: "EROFS" | "EIO"; shimCase?: "cancel" | "unavailable" | "locked" | "session-dialog" | "expired-dialog" | "binding" }
// This entire entry is excluded from the package. Fixture secrets travel over owned IPC, never production flags/env.
const watchdog = setTimeout(() => process.exit(3), 45_000);
process.once("disconnect", () => process.exit(3));
process.once("message", async (input: Bootstrap) => {
  const store: FixtureStore = { ...input, dir: path.join(input.home, ".config", "subetha-payer"), cleanup: () => undefined };
  const event = (name: string): void => {
    durableEvent(path.join(input.home, "events.ndjson"), { event: name });
    process.send?.({ event: name });
  };
  const hooks = fixtureHooks(store, event);
  let writeFault = false;
  const fail = (): never => { throw Object.assign(new Error("fixture disk failure"), { code: input.failFs }); };

  // The test runner needs an installed loader. Only this test entry supplies simulated guarded execArgv;
  // production bin tests below use real argv and never bypass preflight.
  try {
    const daemon = await startDaemon({
      fs: { ...realFs,
        writeSync(fd, data) { return writeFault && input.failFs === "EROFS" ? fail() : realFs.writeSync(fd, data); },
        fsyncSync(fd) { if (writeFault && input.failFs === "EIO") fail(); realFs.fsyncSync(fd); },
      },
      env: process.env, execArgv: ["--disable-sigusr1"], installRoot: store.installRoot,
      hooks: { ...hooks,
        ...(input.purchase ? { handler: (context) => {
          const handler = createDaemonHandler(context);
          return async request => {
            if (request.method === "purchase" && input.shimCase === "locked") context.session.close();
            return handler(request);
          };
        }, configurePurchase: (base) => {
          const fixture = fixturePurchase(base, event, input.cancel || input.shimCase === "cancel");
          if (input.shimCase === "unavailable") fixture.ui.available = async () => false;
          if (["session-dialog", "expired-dialog", "binding"].includes(input.shimCase ?? "")) fixture.ui.confirm = async record => {
            event("confirm");
            if (input.shimCase === "session-dialog") { const later = Date.now() + 3_600_001; Date.now = () => later; }
            if (input.shimCase === "expired-dialog") { const later = Date.now() + 130_000; Date.now = () => later; }
            // A real retained record with a different displayed amount: independent hash mismatch, not a schema error.
            const displayed = input.shimCase === "binding" ? { ...record, source: { ...record.source, amount: "10001" } } : record;
            return { approved: true, recordHash: recordHash(displayed), uiKind: "native" };
          };
          return fixture;
        } } : {}),
        listen: (socketPath, handler) => listenSocket(socketPath, async request => {
          // Exact accepted socket envelope, synthetic fixture only. Invalid envelopes never reach this handler.
          durableEvent(path.join(input.home, "socket-requests.ndjson"), request);
          return handler(request);
        }),
        ...(input.noUi ? { ui: { available: async () => false } } : {}),
        ...(input.wrong ? { tty: { available: true, read: async () => { event("Passphrase"); return "incorrect-fixture-passphrase"; } } } : {}),
        faults: { hit: async (point) => {
          if (point === "transport:before-response" && input.point === point && input.observedFile) {
            while (!existsSync(input.observedFile)) await new Promise(resolve => setTimeout(resolve, 5));
          }
          if (point === "before:sign_intent" && input.failFs) writeFault = true;
          event(point); if (point === input.point) await new Promise<void>(() => undefined); } },
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
