/** Parent-owned subprocess fixture, not packaged. No ps, real TTY, UI or external network. */
import { runWallet } from "../../src/cli/wallet.js";
import { runConfig } from "../../src/cli/config.js";
import { runLock } from "../../src/cli/lock.js";
import { runInspect } from "../../src/cli/inspect.js";
import type { CliDeps } from "../../src/cli/common.js";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const value = JSON.parse(input) as { home: string; command: string; args: string[]; key?: string; answers: string[]; tty: boolean; alive: boolean };
input = "";
const key = value.key === undefined ? undefined : Buffer.from(value.key, "hex"); delete value.key;
const deps: CliDeps = { env: { HOME: value.home },
  lockDeps: { pid: 424242, startedAtOf: () => "owned-start", isAlive: () => value.alive, hostname: "owned-host" },
  tty: { available: value.tty, read: async () => value.answers.shift() ?? "" },
  ...(key ? { randomKey: () => key } : {}),
};
try {
  const run = value.command === "wallet" ? runWallet : value.command === "config" ? runConfig : value.command === "lock" ? runLock : value.command === "inspect" ? runInspect : undefined;
  process.exitCode = run ? await run(value.args, deps) : 2;
} finally { key?.fill(0); value.answers.fill(""); }
