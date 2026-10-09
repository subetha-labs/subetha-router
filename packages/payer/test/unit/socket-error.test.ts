import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { createServer } from "node:net";
import { listenSocket, dispatchLine } from "../../src/daemon/server.js";
import { startupMessage } from "../../src/daemon/run.js";

// No actual sockets: drive the listener's error path with an EventEmitter.
vi.mock("node:net", () => ({ createServer: vi.fn() }));

test.each(["ENAMETOOLONG", "EINVAL", "EPERM", "EACCES", "EADDRINUSE", "ENOENT", "private-value"])("listen failure retains only known errno: %s", async (code) => {
  const server = new EventEmitter();
  const close = vi.fn();
  Object.assign(server, { close, listen: () => {
    server.emit("error", Object.assign(new Error("private-message /private-path"), { code, path: "/private-path" }));
  } });
  vi.mocked(createServer).mockReturnValue(server as unknown as ReturnType<typeof createServer>);
  const error = await listenSocket("/fixture-only", async () => undefined).catch((caught: unknown) => caught);
  expect(close).toHaveBeenCalledOnce();
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("socket_unavailable");
  expect((error as Error).cause).toEqual({ code: code === "private-value" ? "UNKNOWN" : code });
  expect(JSON.stringify(error)).not.toMatch(/private-message|private-path|private-value/);
  expect(startupMessage(error)).toBe("startup_refused: internal_error\n");
  expect(await dispatchLine('{"id":1,"method":"ping","params":{}}', async () => { throw error; }))
    .toEqual({ id: 1, ok: false, error: { code: "internal_error" } });
});
