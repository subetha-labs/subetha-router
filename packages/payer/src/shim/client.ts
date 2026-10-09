import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { failure, FailureSummary } from "../protocol/summary.js";
import { MAX_RESPONSE_BYTES, Request, Response, SHIM_REQUEST_MS, summaryFor } from "../protocol/socket.js";
import { socketPathOf } from "./paths.js";
import type { PathsEnv } from "../store/paths.js";

export interface DaemonClient {
  request(method: Request["method"], params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
/** One connection/request, no retries. No response is never evidence of nonpayment. */
export function createDaemonClient(env: PathsEnv, connect: (path: string) => Socket = createConnection, resolvePath: (env: PathsEnv) => string = socketPathOf): DaemonClient {
  const sockets = new Map<Socket, Promise<void>>();
  let closed = false;
  return {
    async request(method, params) {
      const id = randomUUID();
      const parsed = Request.safeParse({ id, method, params });
      if (!parsed.success) return failure("internal_error");
      let socket: Socket;
      try { if (closed) throw new Error(); socket = connect(resolvePath(env)); }
      catch { return failure("daemon_unavailable", { nextStep: "daemon_unavailable" }); }
      let resolveClosed!: () => void;
      const ended = new Promise<void>(resolve => { resolveClosed = resolve; });
      sockets.set(socket, ended);
      const result = await new Promise<unknown>(resolve => {
        let sent = false, settled = false, bytes = Buffer.alloc(0);
        const uncertain = () => failure(sent ? "transport_uncertain" : "daemon_unavailable", { nextStep: sent ? "unknown_inspect" : "daemon_unavailable" });
        const finish = (value: unknown) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); socket.destroy(); };
        const timer = setTimeout(() => finish(uncertain()), method === "ping" ? 5_000 : SHIM_REQUEST_MS);
        socket.once("connect", () => { if (settled) return; sent = true; socket.write(JSON.stringify(parsed.data) + "\n"); });
        socket.on("data", (chunk: Buffer) => {
          bytes = Buffer.concat([bytes, chunk]);
          if (bytes.length > MAX_RESPONSE_BYTES) { finish(uncertain()); return; }
          const nl = bytes.indexOf(10);
          if (nl < 0) return;
          try {
            if (nl !== bytes.length - 1) throw new Error();
            const response = Response.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, nl))));
            if (response.id !== id) throw new Error();
            if (!response.ok) {
              const { code, ...extra } = response.error;
              finish(FailureSummary.parse({ ok: false, error: code, ...extra }));
            } else finish(summaryFor(method, params).parse(response.result));
          } catch { finish(uncertain()); }
        });
        socket.once("error", () => finish(uncertain()));
        socket.once("end", () => finish(uncertain()));
        socket.once("close", () => { finish(uncertain()); sockets.delete(socket); resolveClosed(); });
      });
      await ended;
      return result;
    },
    async close() { closed = true; const ends = [...sockets.values()]; for (const socket of sockets.keys()) socket.destroy(); await Promise.all(ends); },
  };
}
