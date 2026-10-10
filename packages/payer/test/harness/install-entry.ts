/** Parent-owned crash fixture for `install accept` (not packaged). Fake TTY; SIGKILL at one named fault point. */
import { runInstall } from "../../src/cli/install.js";
import { runLock } from "../../src/cli/lock.js";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const value = JSON.parse(input) as { home: string; installRoot: string; command: "install" | "lock"; answers: string[]; faultAt?: string };
input = "";
const deps = { env: { HOME: value.home }, installRoot: value.installRoot,
  lockDeps: { pid: 424242, startedAtOf: () => "owned-start", isAlive: () => false, hostname: "owned-host" },
  tty: { available: true, read: async () => value.answers.shift() ?? "" },
  faults: { hit: async (point: string) => { if (point === value.faultAt) process.kill(process.pid, "SIGKILL"); } } };
try {
  process.exitCode = value.command === "install" ? await runInstall(["accept"], deps) : await runLock(["reclaim"], deps);
} finally { value.answers.fill(""); }
