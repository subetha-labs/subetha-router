/**
 * x402.org の SVM facilitator を loopback（TLS、プロセス内）で模した fixture（multirail 設計 §5.7）。
 * verify・settle の判定は **本物の `@x402/svm` 2.28.0 の facilitator クラス**（`@x402/svm/exact/facilitator`）をそのまま使い、
 * signer だけ fixture（fee payer の鍵で署名、simulate・send・confirm は記録して成功・失敗を切り替える。chain には出ない）。
 * `/supported` は T4-b の形。**テスト基盤であり製品ではない。**
 */
import https from "node:https";

import {
  address,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64Decoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
  type Address,
} from "@solana/kit";
import { ExactSvmScheme as ExactSvmFacilitator } from "@x402/svm/exact/facilitator";
import { TransactionOnchainFailureError } from "@x402/svm";

import type { TlsMaterial } from "./tls/generate.js";

export interface SvmFacilitatorState {
  /** `/supported` の `kinds`。試験が差し替える。 */
  kinds: Record<string, unknown>[];
  /** 応答の形: `ok`、`not-json`、`huge`（正しい kinds に padding）、`redirect`、`error`（正しい kinds を 500 で）。 */
  supportedReply: "ok" | "not-json" | "huge" | "redirect" | "error";
  supportedDelayMs: number;
  redirectTo: string | undefined;
  /** simulate の結果（verify の最後の段）。 */
  simulate: "ok" | "fail";
  /** send の結果。 */
  send: "ok" | "fail";
  /** confirm の結果: `ok`・`onchain-failure`・`timeout`（pending）。 */
  confirm: "ok" | "onchain-failure" | "timeout";
  /** settle の応答を書き換える（§6 の表の各行）。`undefined` なら本物の応答。 */
  settleOverride: ((body: Record<string, unknown>) => { status: number; body: unknown } | { raw: string }) | undefined;
  /** verify の応答を書き換える（形の検査用）。`undefined` なら本物の応答。 */
  verifyOverride: ((body: Record<string, unknown>) => { status: number; body: unknown } | { raw: string }) | undefined;
  settleDelayMs: number;
  /** verify・settle を 302 にする。 */
  redirectCalls: boolean;
  /** settle の応答を返さず接続を切る。 */
  dropSettle: boolean;
}

export interface SvmFacilitatorSeen {
  connections: number;
  supportedCalls: number;
  verifyCalls: number;
  settleCalls: number;
  simulateCalls: number;
  sendCalls: number;
  confirmCalls: number;
  lastVerify: unknown;
  lastSettle: unknown;
  lastRequirements: unknown;
  lastPayload: unknown;
}

export interface SvmFacilitator {
  readonly port: number;
  readonly host: string;
  readonly feePayer: string;
  readonly state: SvmFacilitatorState;
  readonly seen: SvmFacilitatorSeen;
  close(): Promise<void>;
}

export function supportedKind(network: string, feePayer: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { x402Version: 2, scheme: "exact", network, extra: { feePayer, ...extra } };
}

/** fee payer の鍵を毎回の乱数で作る（返すのはアドレスと、署名の closure）。 */
async function feePayerKeys(): Promise<{ address: Address; keyPair: Awaited<ReturnType<typeof generateKeyPair>> }> {
  const keyPair = await generateKeyPair();
  return { address: await getAddressFromPublicKey(keyPair.publicKey), keyPair };
}

export async function startSvmFacilitator(tls: TlsMaterial, network: string, feePayerOverride?: string, host = "facilitator.provider.test"): Promise<SvmFacilitator> {
  const keys = await feePayerKeys();
  const feePayer = feePayerOverride ?? String(keys.address);
  const state: SvmFacilitatorState = {
    kinds: [supportedKind(network, feePayer)],
    supportedReply: "ok",
    supportedDelayMs: 0,
    redirectTo: undefined,
    simulate: "ok",
    send: "ok",
    confirm: "ok",
    settleOverride: undefined,
    verifyOverride: undefined,
    settleDelayMs: 0,
    redirectCalls: false,
    dropSettle: false,
  };
  const seen: SvmFacilitatorSeen = { connections: 0, supportedCalls: 0, verifyCalls: 0, settleCalls: 0, simulateCalls: 0, sendCalls: 0, confirmCalls: 0, lastVerify: undefined, lastSettle: undefined, lastRequirements: undefined, lastPayload: undefined };

  const signer = {
    getAddresses: () => [address(feePayer)],
    async signTransaction(transaction: string, _feePayer: Address, _network: string): Promise<string> {
      const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
      const signed = await partiallySignTransaction([keys.keyPair], decoded);
      return getBase64Decoder().decode(getTransactionEncoder().encode(signed));
    },
    async simulateTransaction(): Promise<void> {
      seen.simulateCalls += 1;
      if (state.simulate === "fail") throw new Error("simulation failed: SECRET_INTERNAL_DETAIL");
    },
    async sendTransaction(transaction: string): Promise<string> {
      seen.sendCalls += 1;
      if (state.send === "fail") throw new Error("send failed: SECRET_INTERNAL_DETAIL");
      const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
      return String(getSignatureFromTransaction(decoded as never));
    },
    async confirmTransaction(_signature: string): Promise<{ slot: number }> {
      seen.confirmCalls += 1;
      if (state.confirm === "onchain-failure") throw new TransactionOnchainFailureError("onchain failure: SECRET_INTERNAL_DETAIL");
      if (state.confirm === "timeout") throw new Error("confirmation timed out: SECRET_INTERNAL_DETAIL");
      return { slot: 1 };
    },
  };
  const facilitator = new ExactSvmFacilitator(signer as never);

  const server = https.createServer({ key: tls.provider.key, cert: tls.provider.cert }, (request, response) => {
    const path = request.url ?? "/";
    const sendJson = (status: number, body: unknown): void => {
      const text = JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      response.end(text);
    };
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
            response.write(`{"kinds":${JSON.stringify(state.kinds)},"pad":"`);
            for (let i = 0; i < 70; i += 1) response.write("p".repeat(1024));
            response.end('"}');
            return;
          case "redirect":
            response.writeHead(302, { location: state.redirectTo ?? "https://other.test/supported" });
            response.end();
            return;
          case "error": {
            const text = JSON.stringify({ kinds: state.kinds, note: "SECRET_INTERNAL_DETAIL" });
            response.writeHead(500, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
            response.end(text);
            return;
          }
          default: {
            const signers = state.kinds.map((k) => (typeof k["extra"] === "object" && k["extra"] !== null ? (k["extra"] as Record<string, unknown>)["feePayer"] : undefined)).filter((f) => f !== undefined);
            sendJson(200, { kinds: state.kinds, extensions: [], signers: { [network]: signers } });
          }
        }
      };
      if (state.supportedDelayMs > 0) setTimeout(send, state.supportedDelayMs);
      else send();
      return;
    }
    if (request.method !== "POST" || (path !== "/verify" && path !== "/settle")) {
      sendJson(404, { error: "not_found" });
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      void (async () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        } catch {
          sendJson(400, { error: "bad_json" });
          return;
        }
        seen.lastRequirements = body["paymentRequirements"];
        seen.lastPayload = body["paymentPayload"];
        if (state.redirectCalls) {
          response.writeHead(302, { location: state.redirectTo ?? "https://other.test/" });
          response.end();
          return;
        }
        if (path === "/verify") {
          seen.verifyCalls += 1;
          const result = await facilitator.verify(body["paymentPayload"] as never, body["paymentRequirements"] as never);
          seen.lastVerify = result;
          const override = state.verifyOverride?.(result as unknown as Record<string, unknown>);
          if (override === undefined) sendJson(200, result);
          else if ("raw" in override) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(override.raw);
          } else sendJson(override.status, override.body);
          return;
        }
        seen.settleCalls += 1;
        if (state.dropSettle) {
          response.socket?.destroy();
          return;
        }
        const result = (await facilitator.settle(body["paymentPayload"] as never, body["paymentRequirements"] as never)) as unknown as Record<string, unknown>;
        seen.lastSettle = result;
        const respond = (): void => {
          const override = state.settleOverride?.(result);
          if (override === undefined) {
            sendJson(200, result);
          } else if ("raw" in override) {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(override.raw);
          } else {
            sendJson(override.status, override.body);
          }
        };
        if (state.settleDelayMs > 0) setTimeout(respond, state.settleDelayMs);
        else respond();
      })();
    });
  });
  server.on("connection", () => {
    seen.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return { port, host, feePayer, state, seen, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
