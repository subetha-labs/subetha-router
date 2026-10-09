import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { shimWire } from "../harness/shim-wire.js";
import { socketClient } from "../harness/daemon.js";
import { within } from "../harness/children.js";
import { parseKeysDocument, unlockKeys } from "../../src/store/keys.js";

function rejected(f: Awaited<ReturnType<typeof shimWire>>, daemonUi: number) {
  expect(f.counts()).toEqual({ daemonUi, shimUi: 0, signer: 0 });
  expect(f.rows().some(row => row.state === "sign_intent")).toBe(false);
  expect(f.router.state.calls.purchase).toBe(0);
}
test.each(["approved", "passphrase", "credential", "ownerKey"])("AC-A2(a) valid ref + forged %s is rejected before any daemon purchase", async key => {
  const f = await shimWire("cancel", undefined, true); try {
    const q: any = (await f.shim.call("quote", { routeId: "md-mpp-eth-snapshot" })).structuredContent;
    const r = await f.shim.call("purchase", { ref: q.ref, [key]: key === "approved" ? true : "synthetic" });
    expect(r.isError).toBe(true); expect(f.requests().filter(x => x.method === "purchase")).toEqual([]); rejected(f, 0);
  } finally { await f.close(); }
});
test("AC-A2(h) strict invalid_request/UI0; separate valid forged client still requires daemon UI1", async () => {
  const f = await shimWire("cancel", undefined, true); const socket = socketClient(f.store.dir);
  try {
    const q: any = (await f.shim.call("quote", { routeId: "md-mpp-eth-snapshot" })).structuredContent;
    expect(await socket.send("purchase", { ref: q.ref, approved: true })).toEqual({ id: null, ok: false, error: { code: "invalid_request" } }); rejected(f, 0);
    expect(await socket.send("purchase", { ref: q.ref })).toMatchObject({ ok: false, error: { code: "approval_rejected" } }); rejected(f, 1);
  } finally { socket.close(); await f.close(); }
});
test.each([
  ["unavailable", "approval_unavailable", 0], ["locked", "locked", 0],
  ["session-dialog", "locked", 1], ["expired-dialog", "approval_expired", 1],
  ["binding", "approval_mismatch", 1], ["cancel", "approval_rejected", 1],
] as const)("AC-A2 real daemon %s: exact %s, daemon UI%s, shim UI0, signer0", async (mode, error, ui) => {
  const f = await shimWire(mode, "accept", true); try {
    const q: any = (await f.shim.call("quote", { routeId: "md-mpp-eth-snapshot" })).structuredContent;
    expect((await f.shim.call("purchase", { ref: q.ref })).structuredContent).toEqual({ ok: false, error });
    rejected(f, ui);
  } finally { await f.close(); }
});
test("AC-A2(f) owned ciphertext cannot unlock with wrong phrase, no UI/sign intent", async () => {
  const f = await shimWire("cancel", undefined, true); try {
    const doc = parseKeysDocument(readFileSync(path.join(f.store.dir, "keys.json"), "utf8"));
    expect(() => unlockKeys(doc, "wrong-synthetic-phrase")).toThrow("bad_passphrase"); rejected(f, 0);
  } finally { await f.close(); }
});
test.each([false, true])("AC-A2 stdin yes, PTY=%s: real shim still requests one daemon confirmation, rejection/sign0", async pty => {
  const f = await shimWire("cancel", undefined, true);
  const entry = fileURLToPath(new URL("../harness/shim-observe-entry.ts", import.meta.url));
  const loader = import.meta.resolve("tsx");
  try {
    const q: any = (await f.shim.call("quote", { routeId: "md-mpp-eth-snapshot" })).structuredContent;
    const child = pty ? spawn("python3", [fileURLToPath(new URL("../fixtures/shim-pty.py", import.meta.url)), process.execPath, loader, entry, q.ref], { env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: f.store.home, XDG_CONFIG_HOME: path.join(f.store.home, ".config") }, stdio: ["pipe", "pipe", "pipe"] }) : spawn(process.execPath, ["--disable-sigusr1", "--import", loader, entry], { env: { HOME: f.store.home, XDG_CONFIG_HOME: path.join(f.store.home, ".config") }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", stderr = ""; child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    try {
      const result = new Promise<any>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.on("data", chunk => {
          output += chunk.toString();
          for (const line of output.split("\n")) {
            try { const value = JSON.parse(line); if (pty && value.structuredContent) resolve(value); else if (value.id === 92 && value.result) resolve(value.result); } catch { /* partial line */ }
          }
        });
      });
      if (!pty) {
        child.stdin.write("yes\n");
        for (const message of [
          { jsonrpc: "2.0", id: 91, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "owned-stdin", version: "1" } } },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 92, method: "tools/call", params: { name: "subetha_payer_purchase", arguments: { ref: q.ref } } },
        ]) child.stdin.write(JSON.stringify(message) + "\n");
      }
      expect((await within(result, 20_000)).structuredContent).toEqual({ ok: false, error: "approval_rejected" });
      expect(stderr).toBe(""); rejected(f, 1);
    } finally { child.stdin.end(); if (!pty) child.kill("SIGTERM"); await within(exited, 3000); }
  } finally { await f.close(); }
});
// AC-A2(e)/(i): the exact retained compiled-bin env/preload/inspector oracles live in
// wire/startup.test.ts (refusalRows). Run that file with this suite; do not replace
// pre-main loader refusals by a schema test or count them as approval binding evidence.
