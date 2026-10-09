import { chmodSync, lstatSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { z } from "zod";
import { FailureSummary, PingSummary, PurchaseBodySummary, PurchaseRef, PurchaseSummary, QuoteSummary, RoutesSummary, WalletSummary } from "../protocol/summary.js";

const empty = z.object({}).strict();
const envelope = { id: z.union([z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)]) };
export const Request = z.discriminatedUnion("method", [
  z.object({ ...envelope, method: z.literal("ping"), params: empty }).strict(),
  z.object({ ...envelope, method: z.literal("wallet"), params: empty }).strict(),
  z.object({ ...envelope, method: z.literal("find_routes"), params: empty }).strict(),
  z.object({ ...envelope, method: z.literal("quote"), params: z.object({ routeId: z.literal("md-mpp-eth-snapshot") }).strict() }).strict(),
  z.object({ ...envelope, method: z.literal("purchase"), params: z.object({ ref: PurchaseRef }).strict() }).strict(),
  z.object({ ...envelope, method: z.literal("status"), params: z.object({ ref: PurchaseRef, includeBody: z.boolean().optional() }).strict() }).strict(),
]);
export type Request = z.infer<typeof Request>;
export type Handler = (request: Request) => Promise<unknown>;
const schemas = { ping: PingSummary, wallet: WalletSummary, find_routes: RoutesSummary, quote: QuoteSummary, purchase: PurchaseSummary, status: PurchaseSummary };
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
    const schema = request.method === "status" && request.params.includeBody ? PurchaseBodySummary : schemas[request.method];
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
    socket.on("error", () => socket.destroy());
    socket.setTimeout(35_000, () => socket.destroy());
    let pending = Buffer.alloc(0);
    let queued = 0;
    let tail = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 65_536) { socket.destroy(); return; }
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        if (++queued > 32) { socket.destroy(); return; }
        tail = tail.then(async () => {
          if (socket.destroyed) return;
          const response = await dispatchLine(line, handler);
          if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
        }).catch(() => { socket.destroy(); }).finally(() => { queued--; });
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // umask is set in startup before this point. chmod occurs before requests are accepted.
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
