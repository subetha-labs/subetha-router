/**
 * `subetha-payer` の入口（サブコマンドの振り分けだけ）。設計 `docs/agent-payer-design.md` §2・§3.1。
 *
 * - 起動は `bin/subetha-payer`（`exec node --disable-sigusr1 …`）経由だけを認める。`node dist/bin.js` は `--disable-sigusr1` が無いので拒む
 *   （同じ利用者の別 process が `SIGUSR1` で inspector を開き、メモリの鍵を読める。設計 §1 U-A1）。
 * - 各サブコマンドの実装は P-3〜P-5 で足す。P-1a では振り分けと拒否だけ。
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { preflight } from "./daemon/preflight.js";
import { StoreError } from "./store/fs.js";

const USAGE = [
  "usage: subetha-payer <command>",
  "  wallet new|address|balance   create or inspect the key (never prints secrets)",
  "  daemon                       run the payer in this terminal (asks for the passphrase and the security phrase here)",
  "  mcp                          stdio MCP shim for an agent (no key, no UI; talks to the daemon)",
  "  status [ref] | inspect <ref> | config get|set | lock reclaim",
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
    case "wallet":
    case "status":
    case "inspect":
    case "config":
    case "lock":
      process.stderr.write(`${command}: not implemented yet (P-1a skeleton)\n`);
      return 2;
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
