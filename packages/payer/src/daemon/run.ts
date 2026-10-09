import { fileURLToPath } from "node:url";
import { StoreError } from "../store/fs.js";
import { InstallChanged } from "./seal.js";
import { createPurchaseCore } from "./purchase.js";
import { createDaemonHandler } from "./handler.js";
import { listenSocket } from "./server.js";
import { startDaemon } from "./startup.js";
import { TerminalSecrets } from "./tty.js";

const STARTUP_CODES = new Set(["sigusr1_enabled", "forbidden_env", "forbidden_flag", "path_invalid", "no_confirmation_ui", "no_tty", "bad_passphrase", "install_changed", "install_unreadable", "install_seal_corrupt", "store_corrupt", "store_unsupported_version", "lock_lost", "daemon_already_running", "daemon_lock_stale", "lock_unreadable", "lock_failed", "home_unavailable", "path_unreadable", "config_invalid", "wallet_invalid", "wallet_missing", "phrase_invalid", "tty_cancelled"]);
export function startupMessage(error: unknown): string {
  const code = error instanceof StoreError && STARTUP_CODES.has(error.code) ? error.code : "internal_error";
  // JSON escaping prevents filename control characters from acting as terminal commands.
  const files = error instanceof InstallChanged ? ` ${JSON.stringify(error.files)}` : "";
  return `startup_refused: ${code}${files}\n`;
}

export async function runDaemon(args: readonly string[], execArgv: readonly string[]): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    process.stderr.write("startup_refused: invalid_arguments\n");
    return 2;
  }
  try {
    const daemon = await startDaemon({
      env: process.env, execArgv,
      installRoot: fileURLToPath(new URL("../../", import.meta.url)),
      checkOnly: args[0] === "--check",
      hooks: {
        // P-4a supplies the native implementation. No command-line/env approval bypass.
        ui: { available: async () => false },
        tty: new TerminalSecrets(),
        listen: listenSocket,
        handler: createDaemonHandler,
        recover: (context) => createPurchaseCore(context).recover(),
      },
    });
    if (!daemon) return 0;
    const stop = (): void => { void daemon.close(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.stderr.write("listening\n");
    try { await daemon.closed; }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); await daemon.close(); }
    return 0;
  } catch (error) { process.stderr.write(startupMessage(error)); return 2; }
}
