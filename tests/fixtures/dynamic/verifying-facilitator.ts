/**
 * **EIP-3009 の署名と nonce を実際に検証する** x402 facilitator の fixture（プロセス内）。試験基盤。
 *
 * 既存の `x402-inbound-facilitator.ts` は署名を見ない。受信の束縛（「この署名はこの quote のもの」）を確かめるには、
 * 署名が `nonce` を含めて検証されることが要る。ここでは公式の facilitator と同じ内容を、チェーンなしで検証する:
 *   - `/verify`: typed data の署名者が `authorization.from` であること、`to`・`value` が requirements と一致すること、
 *     有効期間内であること、nonce が未使用であること
 *   - `/settle`: 同じ検証のうえで nonce を使用済みにし、合成の transaction を返す（同じ署名の 2 度目は失敗する）
 *
 * 資金は動かない。鍵も持たない。
 *
 * **実物との違い（この fixture が示せないこと）**: token の存在・残高・実際の transfer の実行は見ない（決済できるかは分からない）。
 * 署名者は EOA だけ（コントラクトウォレットの署名は検証しない）。nonce の使用済みは `(network, asset, 送り主, nonce)` ごとに
 * この fixture のメモリで持つ（チェーンの状態ではない）。
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

import { getAddress, verifyTypedData, type Hex } from "viem";

import type { TlsMaterial } from "../tls/generate.js";

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

export interface VerifyingFacilitator {
  readonly baseUrl: string;
  readonly port: number;
  readonly calls: { verify: number; settle: number; reasons: string[] };
  /** 使用済みの nonce（`from:nonce`）。 */
  readonly used: Set<string>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function check(body: unknown, used: Set<string>, nowSeconds: number): Promise<{ ok: true; key: string; payer: string; network: string } | { ok: false; reason: string }> {
  if (!isRecord(body)) return { ok: false, reason: "malformed" };
  const payload = body["paymentPayload"];
  const requirements = body["paymentRequirements"];
  if (!isRecord(payload) || !isRecord(requirements)) return { ok: false, reason: "malformed" };
  // v2 の封筒: `accepted` が要る。実物は `accepted.scheme`・`accepted.network` を requirements と突き合わせる。
  const accepted = payload["accepted"];
  if (payload["x402Version"] !== 2 || !isRecord(accepted)) return { ok: false, reason: "not_v2" };
  if (accepted["scheme"] !== "exact" || requirements["scheme"] !== "exact") return { ok: false, reason: "scheme" };
  if (accepted["network"] !== requirements["network"]) return { ok: false, reason: "network_mismatch" };
  const inner = payload["payload"];
  if (!isRecord(inner) || !isRecord(inner["authorization"]) || typeof inner["signature"] !== "string") return { ok: false, reason: "malformed" };
  const authorization = inner["authorization"] as Record<string, unknown>;
  const extra = requirements["extra"];
  if (!isRecord(extra) || typeof extra["name"] !== "string" || typeof extra["version"] !== "string") return { ok: false, reason: "missing_domain" };
  const network = requirements["network"];
  const chainId = typeof network === "string" ? Number(network.replace(/^eip155:/, "")) : Number.NaN;
  if (!Number.isInteger(chainId)) return { ok: false, reason: "network" };
  const fields = ["from", "to", "value", "validAfter", "validBefore", "nonce"];
  if (!fields.every((key) => typeof authorization[key] === "string")) return { ok: false, reason: "malformed" };
  const a = authorization as Record<string, string>;
  let valid: boolean;
  try {
    valid = await verifyTypedData({
      address: getAddress(a["from"]!),
      domain: { name: extra["name"], version: extra["version"], chainId, verifyingContract: getAddress(String(requirements["asset"])) },
      types: TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: getAddress(a["from"]!), to: getAddress(a["to"]!), value: BigInt(a["value"]!), validAfter: BigInt(a["validAfter"]!), validBefore: BigInt(a["validBefore"]!), nonce: a["nonce"] as Hex },
      signature: inner["signature"] as Hex,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "invalid_signature" };
  if (getAddress(a["to"]!) !== getAddress(String(requirements["payTo"]))) return { ok: false, reason: "recipient" };
  if (BigInt(a["value"]!) !== BigInt(String(requirements["amount"]))) return { ok: false, reason: "amount" };
  // 実物と同じ余裕: 6 秒以内に切れる authorization は受け付けない。
  if (BigInt(a["validAfter"]!) > BigInt(nowSeconds) || BigInt(a["validBefore"]!) < BigInt(nowSeconds + 6)) return { ok: false, reason: "validity" };
  // authorization の状態は「あるチェーンの、ある token」のもの。
  const key = `${String(network)}:${getAddress(String(requirements["asset"]))}:${getAddress(a["from"]!)}:${a["nonce"]!.toLowerCase()}`;
  if (used.has(key)) return { ok: false, reason: "nonce_used" };
  return { ok: true, key, payer: getAddress(a["from"]!), network: String(network) };
}

export async function startVerifyingFacilitator(options: { tls?: TlsMaterial; now?: () => number } = {}): Promise<VerifyingFacilitator> {
  const calls = { verify: 0, settle: 0, reasons: [] as string[] };
  const used = new Set<string>();
  const now = options.now ?? (() => Date.now());
  const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = undefined;
        }
        const send = (status: number, json: unknown): void => {
          const text = JSON.stringify(json);
          response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
          response.end(text);
        };
        const result = await check(body, used, Math.floor(now() / 1000));
        if (!result.ok) calls.reasons.push(result.reason);
        if (request.url === "/verify") {
          calls.verify += 1;
          send(200, result.ok ? { isValid: true, payer: result.payer } : { isValid: false, invalidReason: result.reason });
          return;
        }
        if (request.url === "/settle") {
          calls.settle += 1;
          if (!result.ok) {
            send(200, { success: false, errorReason: result.reason });
            return;
          }
          used.add(result.key);
          send(200, { success: true, network: result.network, transaction: `0x${randomBytes(32).toString("hex")}`, payer: result.payer });
          return;
        }
        send(404, { error: "not_found" });
      })();
    });
  };
  const server = options.tls === undefined ? http.createServer(handler) : https.createServer({ key: options.tls.other.key, cert: options.tls.other.cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    // TLS のときは `other.test` の証明書を使う（上流の `provider.test` と別の名前にするため）。
    baseUrl: options.tls === undefined ? `http://127.0.0.1:${port}` : "https://other.test",
    port,
    calls,
    used,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
