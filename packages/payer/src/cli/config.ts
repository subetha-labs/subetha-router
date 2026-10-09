import { parseConfig, readConfig } from "../config.js";
import { TerminalSecrets } from "../daemon/tty.js";
import { cliRun, invalid, output, requireTty, resources, withLock, writeDocument, type CliDeps } from "./common.js";
const fields = ["router.url", "router.canonicalResource.url", "session.ttlMs", "rails", "rpc.eip155:84532"];
export function runConfig(args: readonly string[], deps: CliDeps = {}): Promise<number> {
  return cliRun(async () => {
    if (args[0] === "get" && args.length === 1) { const r = resources(deps); output(readConfig(r.dir, r.fs)); return; }
    if (args[0] !== "set" || args.length !== 3 || !fields.includes(args[1]!)) invalid();
    requireTty(deps.tty ?? new TerminalSecrets());
    await withLock(deps, async (r, held) => {
      const current = readConfig(r.dir, r.fs), value = args[2]!;
      const next = structuredClone(current);
      switch (args[1]) {
        case "router.url": next.router.url = value; break;
        case "router.canonicalResource.url": next.router.canonicalResource = { url: value, method: "GET" }; break;
        case "session.ttlMs": next.session = { ttlMs: /^\d+$/.test(value) ? Number(value) : NaN }; break;
        case "rails": next.rails = JSON.parse(value); break;
        case "rpc.eip155:84532": next.rpc = { "eip155:84532": value }; break;
      }
      writeDocument(r.dir, "config.json", parseConfig(next), r.fs, held, true);
      output({ ok: true, effective: "next_daemon_start" });
    });
  });
}
