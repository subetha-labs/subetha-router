import { fileURLToPath } from "node:url";
import { StoreError } from "../store/fs.js";
import { InstallChanged } from "./seal.js";
import { createPurchaseCore } from "./purchase.js";
import { createDaemonHandler } from "./handler.js";
import { listenSocket } from "./server.js";
import { startDaemon } from "./startup.js";
import { TerminalSecrets } from "./tty.js";
import { createOsascriptUi, type OsascriptDependencies } from "../ui/osascript.js";
import type { DaemonHooks, SecretTty } from "./interfaces.js";
import type { StartupOptions } from "./startup.js";

const STARTUP_CODES = new Set(["sigusr1_enabled", "forbidden_env", "forbidden_flag", "path_invalid", "no_confirmation_ui", "no_tty", "bad_passphrase", "install_changed", "install_unreadable", "install_seal_corrupt", "store_corrupt", "store_unsupported_version", "lock_lost", "daemon_already_running", "daemon_lock_stale", "lock_unreadable", "lock_failed", "home_unavailable", "path_unreadable", "config_invalid", "wallet_invalid", "wallet_missing", "phrase_invalid", "tty_cancelled"]);
export function startupMessage(error: unknown): string {
  const code = error instanceof StoreError && STARTUP_CODES.has(error.code) ? error.code : "internal_error";
  // JSON escaping prevents filename control characters from acting as terminal commands.
  const files = error instanceof InstallChanged ? ` ${JSON.stringify(error.files)}` : "";
  return `startup_refused: ${code}${files}\n`;
}

/** Private composition seams for owned fixtures; bin.ts never accepts them. */
interface RunDependencies {
  env?: NodeJS.ProcessEnv;
  installRoot?: string;
  ui?: OsascriptDependencies;
  tty?: SecretTty;
  listen?: DaemonHooks["listen"];
  configurePurchase?: NonNullable<DaemonHooks["configurePurchase"]>;
  lockDeps?: NonNullable<StartupOptions["lockDeps"]>;
}
export async function runDaemon(args: readonly string[], execArgv: readonly string[], deps: RunDependencies = {}): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    process.stderr.write("startup_refused: invalid_arguments\n");
    return 2;
  }
  try {
    const env = deps.env ?? process.env;
    const uiDeps = { ...deps.ui, env };
    const daemon = await startDaemon({
      env, execArgv,
      installRoot: deps.installRoot ?? fileURLToPath(new URL("../../", import.meta.url)),
      checkOnly: args[0] === "--check",
      ...(deps.lockDeps ? { lockDeps: deps.lockDeps } : {}),
      hooks: {
        ui: createOsascriptUi(undefined, uiDeps),
        createConfirmUi: verify => createOsascriptUi(verify, uiDeps),
        tty: deps.tty ?? new TerminalSecrets(),
        listen: deps.listen ?? listenSocket,
        ...(deps.configurePurchase ? { configurePurchase: deps.configurePurchase } : {}),
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
