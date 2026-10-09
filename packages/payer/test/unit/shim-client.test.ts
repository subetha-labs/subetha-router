import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createDaemonClient } from "../../src/shim/client.js";
import { socketPathOf } from "../../src/shim/paths.js";
import { MAX_RESPONSE_BYTES, SHIM_REQUEST_MS } from "../../src/protocol/socket.js";

class SocketFake extends EventEmitter {
  writes: any[] = []; destroyed = false;
  write(text: string) { this.writes.push(JSON.parse(text)); return true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); } return this; }
}
test.each(["valid", "mismatch", "extra", "secret", "error-secret", "utf8", "eof", "oversize", "malformed", "timeout", "split"])("bounded correlated socket response: %s, one request only", async mode => {
  vi.useFakeTimers(); const socket = new SocketFake(); let connects = 0;
  const client = createDaemonClient({}, () => { connects++; return socket as unknown as Socket; }, () => "owned-fixture");
  try {
    const pending = client.request("wallet", {}); socket.emit("connect");
    const id = socket.writes[0].id;
    const valid = { id, ok: true, result: { ok: true, wallets: [] } };
    const response = mode === "mismatch" ? { ...valid, id: "other" } : mode === "extra" ? { ...valid, secret: "hidden" } : mode === "secret" ? { ...valid, result: { ...valid.result, ownerKey: "hidden" } } : mode === "error-secret" ? { id, ok: false, error: { code: "hidden", reason: "hidden" } } : valid;
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(SHIM_REQUEST_MS);
    else if (mode === "eof") socket.emit("end");
    else if (mode === "utf8") socket.emit("data", Buffer.from([0xff, 10]));
    else if (mode === "oversize") socket.emit("data", Buffer.alloc(MAX_RESPONSE_BYTES + 1));
    else if (mode === "malformed") socket.emit("data", Buffer.from("{\n"));
    else if (mode === "split") { const bytes = Buffer.from(JSON.stringify(response) + "\n"); socket.emit("data", bytes.subarray(0, 12)); socket.emit("data", bytes.subarray(12)); }
    else socket.emit("data", Buffer.from(JSON.stringify(response) + "\n"));
    expect(await pending).toEqual(["valid", "split"].includes(mode) ? valid.result : { ok: false, error: "transport_uncertain", nextStep: "unknown_inspect" });
    expect(connects).toBe(1); expect(socket.writes).toHaveLength(1); expect(socket.destroyed).toBe(true);
  } finally { await client.close(); vi.useRealTimers(); }
});
test("empty synthetic HOME stays empty; outside home, regular file and symlink sockets refuse", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "shim-empty-"));
  try {
    const client = createDaemonClient({ HOME: home }, () => { throw new Error("must not connect"); });
    expect(await client.request("ping", {})).toEqual({ ok: false, error: "daemon_unavailable", nextStep: "daemon_unavailable" });
    expect(existsSync(path.join(home, ".config"))).toBe(false); await client.close();
    expect(() => socketPathOf({ HOME: home, XDG_CONFIG_HOME: tmpdir() })).toThrow();
    const dir = path.join(home, ".config", "subetha-payer"); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const socket = path.join(dir, "daemon.sock"); writeFileSync(socket, "fixture", { mode: 0o600 });
    expect(() => socketPathOf({ HOME: home })).toThrow(); rmSync(socket);
    symlinkSync(path.join(home, "absent"), socket); expect(() => socketPathOf({ HOME: home })).toThrow();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
