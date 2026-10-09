import { chmodSync, lstatSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { FailureSummary } from "../protocol/summary.js";
import { ACTIVE_REQUEST_MS, Request, summaryFor } from "../protocol/socket.js";
export { Request } from "../protocol/socket.js";
export type Handler = (request: Request) => Promise<unknown>;
const error = (id: Request["id"] | null, code: string) => ({ id, ok: false as const, error: { code } });

/** Only validated, reconstructed summaries cross this boundary. Never serialize a caught exception. */
export async function dispatchLine(line: string, handler: Handler): Promise<unknown> {
  let id: Request["id"] | null = null;
  try {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return error(id, "invalid_request"); }
    const parsed = Request.safeParse(raw);
    if (!parsed.success) return error(id, "invalid_request");
    const request = parsed.data;
    id = request.id;
    const value = await handler(request);
    const failed = FailureSummary.safeParse(value);
    if (failed.success) {
      const { error: code, reason, retryAfterMs } = failed.data;
      return { id, ok: false, error: { code, ...(reason === undefined ? {} : { reason }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } };
    }
    const schema = summaryFor(request.method, request.params);
    const result = schema.safeParse(value);
    return result.success ? { id, ok: true, result: result.data } : error(id, "internal_error");
  } catch { return error(id, "internal_error"); }
}

export class RefMutex {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(ref: string, run: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(ref) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(ref, tail);
    await prior;
    try { return await run(); }
    finally { release(); if (this.tails.get(ref) === tail) this.tails.delete(ref); }
  }
}

export interface Listener { close(): Promise<void> }

const SOCKET_ERROR_CODES = new Set(["ENAMETOOLONG", "EINVAL", "EPERM", "EACCES", "EADDRINUSE", "ENOENT", "ENOTDIR", "EROFS", "EMFILE", "ENFILE", "ENOBUFS", "ENOMEM", "ERR_INVALID_ARG_VALUE"]);
/** Internal diagnostic only: retain a known code, never the original message, path or exception. */
export class SocketListenError extends Error {
  override readonly cause: { readonly code: string };
  constructor(error: unknown) {
    super("socket_unavailable");
    const code: unknown = typeof error === "object" && error !== null ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
    this.cause = { code: typeof code === "string" && SOCKET_ERROR_CODES.has(code) ? code : "UNKNOWN" };
  }
}

/** No stale socket unlink: acquiring the stable daemon lock is not permission to reclaim other files. */
export async function listenSocket(socketPath: string, handler: Handler): Promise<Listener> {
  const sockets = new Set<Socket>();
  let accepting = false;
  const server = createServer((socket) => {
    if (!accepting) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serveSocket(socket, handler);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    chmodSync(socketPath, 0o600);
    const st = lstatSync(socketPath);
    if (!st.isSocket() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) throw new Error("socket_invalid");
    accepting = true;
    server.on("error", () => { accepting = false; for (const socket of sockets) socket.destroy(); });
  } catch (error) {
    server.close();
    throw new SocketListenError(error);
  }
  return { async close() {
    accepting = false;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

/** Per-connection lifecycle, separated so fake-clock tests need no listener. */
export function serveSocket(socket: Socket, handler: Handler): void {
    socket.on("error", () => socket.destroy());
    socket.setTimeout(35_000, () => socket.destroy());
    let pending = Buffer.alloc(0);
    let queued = 0;
    let tail = Promise.resolve();
    let activeTimer: ReturnType<typeof setTimeout> | undefined;
    socket.once("close", () => clearTimeout(activeTimer));
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 65_536) { socket.destroy(); return; }
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        let line: string;
        try { line = new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, newline)); }
        catch { socket.destroy(); return; }
        pending = pending.subarray(newline + 1);
        if (++queued > 32) { socket.destroy(); return; }
        tail = tail.then(async () => {
          if (socket.destroyed) return;
          socket.setTimeout(0);
          activeTimer = setTimeout(() => socket.destroy(), ACTIVE_REQUEST_MS);
          try {
            const response = await dispatchLine(line, handler);
            if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
          } finally {
            clearTimeout(activeTimer);
            if (!socket.destroyed) socket.setTimeout(35_000);
          }
        }).catch(() => { socket.destroy(); }).finally(() => { queued--; });
      }
    });
}
