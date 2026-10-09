import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { durableEvent } from "./durable.js";
import { main } from "../../src/bin.js";
import "../../src/shim/run.js";

// Owned test process only. Observe any attempted native UI launch, fail closed, never launch a helper.
const eventFile = path.join(process.env.HOME!, "shim-ui.ndjson");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"] as const) {
  (childProcess as any)[name] = () => { durableEvent(eventFile, { event: "shim-ui-attempt" }); throw new Error("fixture_shim_subprocess_forbidden"); };
}
syncBuiltinESMExports();
// Real bin dispatch and production stdio entry; only the installed test loader is excluded from guarded argv.
process.exitCode = await main(["mcp"], ["--disable-sigusr1"]);
