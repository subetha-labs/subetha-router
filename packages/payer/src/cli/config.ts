import { parseConfig, readConfig } from "../config.js";
import { TerminalSecrets } from "../daemon/tty.js";
import { cliRun, invalid, output, requireTty, resources, withLock, writeDocument, type CliDeps } from "./common.js";
/** `rpc.<CAIP-2>`: the four payer networks (docs/payer-rails-design.md FR-R12). Public https only (`validRpc`). */
const RPC_NETWORKS = ["eip155:84532", "eip155:42431", "eip155:5042002", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"] as const;
const fields = ["router.url", "router.canonicalResource.url", "session.ttlMs", "rails", ...RPC_NETWORKS.map(network => `rpc.${network}`)];
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
        default: {
          const network = RPC_NETWORKS.find(candidate => args[1] === `rpc.${candidate}`);
          if (network === undefined) invalid();
          next.rpc = { ...next.rpc, [network]: value };
        }
      }
      writeDocument(r.dir, "config.json", parseConfig(next), r.fs, held, true);
      output({ ok: true, effective: "next_daemon_start" });
    });
  });
}
