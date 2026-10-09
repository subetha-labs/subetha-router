import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDaemonClient } from "./client.js";
import { createShim } from "./server.js";

export async function runShim(args: readonly string[]): Promise<number> {
  if (args.length) { process.stderr.write("mcp: invalid_arguments\n"); return 2; }
  const shim = createShim(createDaemonClient({ HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }));
  let resolve!: () => void;
  const ended = new Promise<void>(done => { resolve = done; });
  const stop = () => resolve();
  process.once("SIGINT", stop); process.once("SIGTERM", stop); process.stdin.once("end", stop);
  shim.server.onclose = stop;
  try { await shim.connect(new StdioServerTransport()); await ended; return 0; }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); process.stdin.off("end", stop); await shim.close(); }
}
