/**
 * x402.org の SVM facilitator を loopback（TLS、プロセス内）で模した fixture（multirail 設計 §5.7）。
 * T4-b: `/supported` だけ（fee payer の固定と起動時の検査）。verify・settle（本物の `@x402/svm` の facilitator クラス）は T4-c で足す。
 * **テスト基盤であり製品ではない。**
 */
import https from "node:https";

import type { TlsMaterial } from "./tls/generate.js";

export interface SvmFacilitatorState {
  /** `/supported` の `kinds`。試験が差し替える。 */
  kinds: Record<string, unknown>[];
  /** 応答の形: `ok`、`not-json`、`huge`、`redirect`、`error`、`delay`。 */
  supportedReply: "ok" | "not-json" | "huge" | "redirect" | "error";
  supportedDelayMs: number;
  redirectTo: string | undefined;
}

export interface SvmFacilitatorSeen {
  connections: number;
  supportedCalls: number;
  verifyCalls: number;
  settleCalls: number;
}

export interface SvmFacilitator {
  readonly port: number;
  readonly host: string;
  readonly state: SvmFacilitatorState;
  readonly seen: SvmFacilitatorSeen;
  close(): Promise<void>;
}

export function supportedKind(network: string, feePayer: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { x402Version: 2, scheme: "exact", network, extra: { feePayer, ...extra } };
}

export async function startSvmFacilitator(tls: TlsMaterial, network: string, feePayer: string, host = "facilitator.provider.test"): Promise<SvmFacilitator> {
  const state: SvmFacilitatorState = { kinds: [supportedKind(network, feePayer)], supportedReply: "ok", supportedDelayMs: 0, redirectTo: undefined };
  const seen: SvmFacilitatorSeen = { connections: 0, supportedCalls: 0, verifyCalls: 0, settleCalls: 0 };
  const server = https.createServer({ key: tls.provider.key, cert: tls.provider.cert }, (request, response) => {
    const path = request.url ?? "/";
    if (request.method === "GET" && path === "/supported") {
      seen.supportedCalls += 1;
      const send = (): void => {
        switch (state.supportedReply) {
          case "not-json":
            response.writeHead(200, { "content-type": "text/plain" });
            response.end("hello");
            return;
          case "huge":
            response.writeHead(200, { "content-type": "application/json" });
            response.write('{"kinds":[],"pad":"');
            for (let i = 0; i < 70; i += 1) response.write("p".repeat(1024));
            response.end('"}');
            return;
          case "redirect":
            response.writeHead(302, { location: state.redirectTo ?? "https://other.test/supported" });
            response.end();
            return;
          case "error":
            response.writeHead(500, { "content-type": "application/json" });
            response.end('{"error":"SECRET_INTERNAL_DETAIL"}');
            return;
          default: {
            const text = JSON.stringify({ kinds: state.kinds, extensions: [], signers: { [network]: state.kinds.map((k) => (k["extra"] as Record<string, unknown>)["feePayer"]) } });
            response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
            response.end(text);
          }
        }
      };
      if (state.supportedDelayMs > 0) setTimeout(send, state.supportedDelayMs);
      else send();
      return;
    }
    if (request.method === "POST" && path === "/verify") seen.verifyCalls += 1;
    if (request.method === "POST" && path === "/settle") seen.settleCalls += 1;
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not_found"}');
  });
  server.on("connection", () => {
    seen.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, host, state, seen, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
