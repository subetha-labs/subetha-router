import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fakeRouter } from "./router.js";
import { fixtureStore } from "./store.js";
import { ownedChild } from "./children.js";
import { events } from "./durable.js";

export async function stdioShim(home: string, answer?: "accept" | "cancel", observed = false) {
  const args = observed ? ["--disable-sigusr1", "--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./shim-observe-entry.ts", import.meta.url))] : ["--disable-sigusr1", fileURLToPath(new URL("../../dist/bin.js", import.meta.url)), "mcp"];
  const transport = new StdioClientTransport({ command: process.execPath, args, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: "/usr/bin:/bin" }, stderr: "pipe" });
  let stderr = ""; transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: "p4b-fixture", version: "1.0.0" }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  const displays: unknown[] = [];
  if (answer) client.setRequestHandler(ElicitRequestSchema, async request => { displays.push(request); return { action: answer }; });
  try { await client.connect(transport); await client.listTools(); }
  catch (error) { await client.close(); await transport.close(); throw error; }
  return { client, transport, displays, get stderr() { return stderr; },
    call(name: string, args: Record<string, unknown> = {}) { return client.callTool({ name: `subetha_payer_${name}`, arguments: args }, undefined, { timeout: 195_000 }); },
    async close() { await client.close(); await transport.close(); } };
}
export async function shimWire(shimCase?: string, answer?: "accept" | "cancel", observed = false) {
  const router = await fakeRouter(); router.state.body = { value: "x".repeat(2036) };
  const store = fixtureStore(router.url.href);
  const child = ownedChild(["--disable-sigusr1", "--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./daemon-test-entry.ts", import.meta.url))], store.home);
  child.child.send({ home: store.home, installRoot: store.installRoot, passphrase: store.passphrase, phrase: store.phrase, purchase: true, shimCase });
  let shim: Awaited<ReturnType<typeof stdioShim>> | undefined;
  try { await child.waitFor("listening"); shim = await stdioShim(store.home, answer, observed); }
  catch (error) { await child.close(); store.cleanup(); await router.close(); throw error; }
  return { store, router, child, shim,
    requests() { return events(path.join(store.home, "socket-requests.ndjson")); },
    rows() { return events(path.join(store.dir, "ledger.ndjson")); },
    counts() { const e = events(path.join(store.home, "events.ndjson")); return { daemonUi: e.filter(x => x.event === "confirm").length, shimUi: events(path.join(store.home, "shim-ui.ndjson")).length, signer: e.filter(x => x.event === "sign").length }; },
    async close() { await shim!.close(); await child.close(); await router.close(); store.cleanup(); },
  };
}
