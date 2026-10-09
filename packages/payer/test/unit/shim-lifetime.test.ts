import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { serveSocket } from "../../src/daemon/server.js";
import type { Socket } from "node:net";

test("active confirmation survives idle35s and UI120s; restores idle deadline, bounded hung request", async () => {
  vi.useFakeTimers();
  class FakeSocket extends EventEmitter {
    destroyed = false; writes: string[] = []; timer?: ReturnType<typeof setTimeout>;
    setTimeout(ms: number, cb?: () => void) { clearTimeout(this.timer); if (cb) this.on("timeout", cb); if (ms) this.timer = setTimeout(() => this.emit("timeout"), ms); return this; }
    destroy() { this.destroyed = true; clearTimeout(this.timer); this.emit("close"); return this; }
    write(text: string) { this.writes.push(text); return true; }
  }
  const socket = new FakeSocket();
  try {
    serveSocket(socket as unknown as Socket, async request => { expect(request.method).toBe("purchase"); await new Promise(resolve => setTimeout(resolve, 120_000)); return { ok: false, error: "approval_rejected" }; });
    socket.emit("data", Buffer.from('{"id":1,"method":"purchase","params":{"ref":"p_aaaaaaaaaaaaa"}}\n'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.destroyed).toBe(false); expect(socket.writes).toHaveLength(1);
    expect(JSON.parse(socket.writes[0]!)).toEqual({ id: 1, ok: false, error: { code: "approval_rejected" } });
    await vi.advanceTimersByTimeAsync(35_000); expect(socket.destroyed).toBe(true);
    const hung = new FakeSocket();
    serveSocket(hung as unknown as Socket, async () => new Promise(() => {}));
    hung.emit("data", Buffer.from('{"id":1,"method":"ping","params":{}}\n'));
    await vi.advanceTimersByTimeAsync(180_000); expect(hung.destroyed).toBe(true);
  } finally { socket.destroy(); vi.useRealTimers(); }
});
