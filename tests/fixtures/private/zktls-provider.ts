/**
 * 秘匿購入の wire 用の x402 Provider fixture（試験基盤。製品の Provider ではない）: lab の fixture 証明書（`test-server.io`、RSA）で TLS 1.2 を話し、
 * `POST /select`（lab.select.v1 の本文 ≤ 512 B）と `GET /v1/paid-snapshot` に、未払いなら 402（`PAYMENT-REQUIRED` ヘッダが権威）、支払いつきなら EIP-3009 の署名を
 * 実際に検証して 200 + `PAYMENT-RESPONSE`（receipt）を返す。応答は identity framing（`Content-Length` 明示、`Connection: close`、本文 ≤ 704 B）。
 * Provider C（`phase5/providers/x402-post-worker`）の契約に合わせる: 未払い探り（本文 `{}`）の 402 の条件は有料要求と同一、本文の検査は支払い済み要求にだけ。
 * 資金は動かない（受け取った署名を検証し、合成の transaction を領収に書く）。
 */
import { createHash, randomBytes } from "node:crypto";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { getAddress, verifyTypedData, type Hex } from "viem";

export interface ZktlsProviderOptions {
  readonly certPath: string;
  readonly keyPath: string;
  readonly host: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
  readonly tokenDomain: { readonly name: string; readonly version: string };
}

export interface ZktlsProvider {
  readonly port: number;
  readonly seen: { probes: { method: string; path: string; body: string }[]; paid: { method: string; path: string; body: string; payer: string; credentialHeader: string | undefined }[]; rejected: string[]; responses: string[] };
  /** 支払いつき要求の応答本文を差し替える（既定は lab.select.v1 の選択結果）。 */
  respond: (context: { method: string; path: string; body: string }) => string;
  close(): Promise<void>;
}

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function startZktlsProvider(options: ZktlsProviderOptions): Promise<ZktlsProvider> {
  const seen: ZktlsProvider["seen"] = { probes: [], paid: [], rejected: [], responses: [] };
  const accept = { scheme: "exact", network: options.network, asset: options.asset, amount: options.amount, payTo: options.payTo, maxTimeoutSeconds: 600, extra: { name: options.tokenDomain.name, version: options.tokenDomain.version } };
  const chainId = Number(options.network.replace(/^eip155:/, ""));
  const provider: ZktlsProvider = {
    port: 0,
    seen,
    respond: ({ method, path, body }) => {
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      return JSON.stringify({ providerId: method === "POST" ? "select-post-fixture" : "snapshot-fixture", schema: method === "POST" ? "lab.select.v1" : "lab.snapshot.v1", method, path, received_len: Buffer.byteLength(body, "utf8"), received_sha256: digest, selection: method === "POST" ? { selected: ["lab-echo", "lab-sum", "lab-mini"][Number.parseInt(digest.slice(0, 2), 16) % 3], route: "cpu-deterministic" } : undefined, payment: { protocol: "x402", network: options.network } });
    },
    close: async () => {},
  };
  const server = https.createServer({ cert: readFileSync(options.certPath), key: readFileSync(options.keyPath), minVersion: "TLSv1.2", maxVersion: "TLSv1.2" }, (request, response) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total <= 513) chunks.push(chunk);
    });
    request.on("end", () => {
      void (async () => {
        const method = request.method ?? "GET";
        const path = (request.url ?? "/").split("?")[0] ?? "/";
        const body = Buffer.concat(chunks).toString("utf8");
        const send = (status: number, text: string, extra: Record<string, string> = {}): void => {
          response.shouldKeepAlive = false;
          response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(text, "utf8")), connection: "close", ...extra });
          response.end(text);
          seen.responses.push(text);
        };
        const url = `https://${options.host}${path}`;
        const validPath = (method === "POST" && path === "/select") || (method === "GET" && path === "/v1/paid-snapshot");
        if (!validPath || (request.url ?? "").includes("?")) {
          send(404, JSON.stringify({ error: "not_found" }));
          return;
        }
        const signature = request.headers["payment-signature"];
        if (typeof signature !== "string") {
          seen.probes.push({ method, path, body });
          // 未払い: 402（ヘッダが権威）。本文の検査はしない（Provider C の契約）。
          send(402, JSON.stringify({ x402Version: 2, error: "payment_required" }), { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, error: "payment_required", resource: { url, description: "zktls fixture", mimeType: "application/json" }, accepts: [accept] } as never) });
          return;
        }
        let payload: unknown;
        try {
          payload = decodePaymentSignatureHeader(signature);
        } catch {
          payload = undefined;
        }
        const inner = isRecord(payload) ? payload["payload"] : undefined;
        const authorization = isRecord(inner) ? inner["authorization"] : undefined;
        const accepted = isRecord(payload) ? payload["accepted"] : undefined;
        if (!isRecord(authorization) || !isRecord(inner) || typeof inner["signature"] !== "string" || JSON.stringify(accepted) === undefined) {
          seen.rejected.push("malformed");
          send(402, JSON.stringify({ x402Version: 2, error: "invalid_payment" }));
          return;
        }
        const a = authorization as Record<string, string>;
        let valid = false;
        try {
          valid = await verifyTypedData({
            address: getAddress(a["from"]!),
            domain: { name: options.tokenDomain.name, version: options.tokenDomain.version, chainId, verifyingContract: getAddress(options.asset) },
            types: TYPES,
            primaryType: "TransferWithAuthorization",
            message: { from: getAddress(a["from"]!), to: getAddress(a["to"]!), value: BigInt(a["value"]!), validAfter: BigInt(a["validAfter"]!), validBefore: BigInt(a["validBefore"]!), nonce: a["nonce"] as Hex },
            signature: inner["signature"] as Hex,
          });
        } catch {
          valid = false;
        }
        if (!valid || getAddress(a["to"]!) !== getAddress(options.payTo) || BigInt(a["value"]!) !== BigInt(options.amount)) {
          seen.rejected.push(valid ? "terms" : "signature");
          send(402, JSON.stringify({ x402Version: 2, error: "payment_rejected" }));
          return;
        }
        if (method === "POST") {
          // 本文の検査は支払い済み要求にだけ（≤ 512 B の JSON object、schema lab.select.v1）。
          let parsed: unknown;
          try {
            parsed = total <= 512 ? JSON.parse(body) : undefined;
          } catch {
            parsed = undefined;
          }
          if (!isRecord(parsed) || parsed["schema"] !== "lab.select.v1") {
            seen.rejected.push("body");
            send(400, JSON.stringify({ error: "invalid_body" }));
            return;
          }
        }
        const credentialHeader = request.headers["x-lab-credential"];
        seen.paid.push({ method, path, body, payer: getAddress(a["from"]!), credentialHeader: typeof credentialHeader === "string" ? credentialHeader : undefined });
        const text = provider.respond({ method, path, body });
        if (Buffer.byteLength(text, "utf8") > 704) throw new Error("fixture response over the delivery cap");
        const receipt = { success: true, network: options.network, transaction: `0x${randomBytes(32).toString("hex")}`, payer: getAddress(a["from"]!) };
        send(200, text, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(receipt as never) });
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    ...provider,
    port: (server.address() as AddressInfo).port,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
