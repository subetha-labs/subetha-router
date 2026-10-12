/**
 * `subetha-payer` の入口（サブコマンドの振り分けだけ）。設計 `docs/agent-payer-design.md` §2・§3.1。
 *
 * - 起動は `bin/subetha-payer`（`exec node --disable-sigusr1 …`）経由だけを認める。`node dist/bin.js` は `--disable-sigusr1` が無いので拒む
 *   （同じ利用者の別 process が `SIGUSR1` で inspector を開き、メモリの鍵を読める。設計 §1 U-A1）。
 * - CLI は既存 daemon/client/core/store に振り分ける。
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { preflight } from "./daemon/preflight.js";
import { StoreError } from "./store/fs.js";

const USAGE = [
  "usage: subetha-payer <command>",
  "  wallet new|address|balance   create or inspect the keys: EVM and Solana (never prints secrets)",
  "  wallet add solana            add a Solana key to a 0.1.x store (asks for the passphrase here)",
  "  daemon                       run the payer in this terminal (asks for the passphrase and the security phrase here)",
  "  mcp                          stdio MCP shim for an agent (no key, no UI; talks to the daemon)",
  "  status [ref] | inspect <ref> [--close] | config get|set | lock reclaim | ui-check",
  "  install accept               after a verified upgrade only: seal the new installation (human, in this terminal)",
].join("\n");

/** 起動の不変条件: inspector の signal 経路が閉じていること（launcher 以外からの起動は拒む）。 */
export function refusesWithoutSigusr1Guard(execArgv: readonly string[]): boolean {
  return !execArgv.includes("--disable-sigusr1");
}

export async function main(argv: readonly string[], execArgv: readonly string[] = process.execArgv): Promise<number> {
  try { preflight(execArgv, process.env); }
  catch (error) {
    const code = error instanceof StoreError && ["sigusr1_enabled", "forbidden_env", "forbidden_flag"].includes(error.code) ? error.code : "internal_error";
    process.stderr.write(`startup_refused: ${code}\n`); return 2;
  }
  const command = argv[0];
  switch (command) {
    case "daemon":
      return (await import("./daemon/run.js")).runDaemon(argv.slice(1), execArgv);
    case "mcp":
      return (await import("./shim/run.js")).runShim(argv.slice(1));
    case "wallet": return (await import("./cli/wallet.js")).runWallet(argv.slice(1));
    case "status": return (await import("./cli/status.js")).runStatus(argv.slice(1));
    case "inspect": return (await import("./cli/inspect.js")).runInspect(argv.slice(1));
    case "config": return (await import("./cli/config.js")).runConfig(argv.slice(1));
    case "lock": return (await import("./cli/lock.js")).runLock(argv.slice(1));
    case "install": return (await import("./cli/install.js")).runInstall(argv.slice(1));
    case "ui-check": return (await import("./cli/ui-check.js")).runUiCheck(argv.slice(1));
    default:
      process.stderr.write(`${USAGE}\n`);
      return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
}

/** 入口の判定: `import.meta.url` は realpath（symlink を解決した絶対 path）なので、`argv[1]` も realpath にしてから `pathToFileURL` で比べる（`#`・`%`・symlink・`..` を含む path でも壊れない）。 */
function invokedAsEntry(argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (invokedAsEntry(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(2));
}
