/**
 * Circle の Facilitator Service を**loopback（TLS、プロセス内）で模した**合成 facilitator（multirail 設計 §4.3）。
 * **テスト基盤であり製品の facilitator ではない。** 鍵・実決済は無い。
 *
 * 製品コードの定数・decoder は**使わない**（producer と verifier が同じ思い込みを共有しないため）。仕様（Circle の
 * "Seller Proof Specification"）をここで独立に書き下す:
 * - domain `{ name: "Circle Facilitator Seller Request", version: "1", chainId }`、型 `SellerRequest`（issuedAt/expiresAt は uint64）
 * - header は base64url（`A-Za-z0-9_-`、padding 無し）の JSON 封筒 `{ version: 1, signature, network, payTo, nonce, issuedAt, expiresAt }`
 * - `bodyHash = keccak256(受けた body の bytes)`、purpose = endpoint、method = POST、issuedAt ≤ now+30、now < expiresAt ≤ issuedAt+300、
 *   nonce は (network, payTo, purpose) で一意、network・payTo は paymentRequirements と一致、署名者 = payTo
 * - `paymentRequirements.extra.assetTransferMethod === "eip3009"` を要求（違えば 400）
 */
import { randomBytes } from "node:crypto";
import https from "node:https";

import { keccak256, recoverTypedDataAddress, type Hex } from "viem";

import type { TlsMaterial } from "./tls/generate.js";

const DOMAIN_NAME = "Circle Facilitator Seller Request";
const DOMAIN_VERSION = "1";
const TYPES = {
  SellerRequest: [
    { name: "purpose", type: "string" },
    { name: "method", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "network", type: "string" },
    { name: "payTo", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type CircleSettleMode = "ok" | "minimal" | "reject" | "pending" | "registration-required" | "conflict" | "bad-tx" | "no-tx" | "bad-network" | "wrong-payer" | "unknown" | "malformed" | "drop" | "huge" | "huge-chunked" | "exact-64k";

export interface CircleFacilitatorState {
  verify: "ok" | "invalid";
  settle: CircleSettleMode;
  settleDelayMs: number;
  /** すべての証明を 401 にする（adapter 側の写像を見る）。 */
  rejectProofs: boolean;
  /** verify・settle を 302 で `redirectTo` に送る。 */
  redirectTo: string | undefined;
}

export interface CircleSeen {
  connections: number;
  verifyCalls: number;
  settleCalls: number;
  proofFailures: string[];
  lastRequirements: unknown;
  lastPayload: unknown;
  lastRawBody: string | undefined;
  lastProof: Record<string, unknown> | undefined;
}

export interface CircleFacilitator {
  readonly port: number;
  readonly host: string;
  readonly state: CircleFacilitatorState;
  readonly seen: CircleSeen;
  close(): Promise<void>;
}

function chainIdOf(network: unknown): number | undefined {
  const match = typeof network === "string" ? /^eip155:(\d+)$/.exec(network) : null;
  return match === null ? undefined : Number(match[1]);
}

function decodeEnvelope(header: string): Record<string, unknown> | string {
  if (!BASE64URL.test(header)) return "proof_not_base64url";
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    return "proof_not_json";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "proof_not_object";
  return parsed as Record<string, unknown>;
}

/** 証明の検査。失敗の理由（固定文）を返す。`undefined` なら合格。 */
async function checkProof(header: string | undefined, purpose: "verify" | "settle", raw: Buffer, requirements: Record<string, unknown> | undefined, usedNonces: Set<string>): Promise<{ failure?: string; envelope?: Record<string, unknown> }> {
  if (header === undefined) return { failure: "proof_missing" };
  const envelope = decodeEnvelope(header);
  if (typeof envelope === "string") return { failure: envelope };
  const { version, signature, network, payTo, nonce, issuedAt, expiresAt } = envelope;
  if (version !== 1) return { failure: "proof_version", envelope };
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return { failure: "signature_malformed", envelope };
  if (typeof network !== "string" || typeof payTo !== "string" || !ADDRESS.test(payTo) || typeof nonce !== "string" || !HEX32.test(nonce)) return { failure: "envelope_fields", envelope };
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expiresAt)) return { failure: "time_not_integer", envelope };
  const chainId = chainIdOf(requirements?.["network"]);
  if (chainId === undefined) return { failure: "requirements_network", envelope };
  if (network !== requirements?.["network"]) return { failure: "network_mismatch", envelope };
  if (typeof requirements?.["payTo"] !== "string" || payTo.toLowerCase() !== (requirements["payTo"] as string).toLowerCase()) return { failure: "payto_mismatch", envelope };
  const now = Math.floor(Date.now() / 1000);
  const issued = issuedAt as number;
  const expires = expiresAt as number;
  if (issued > now + 30) return { failure: "issued_in_future", envelope };
  if (expires <= now) return { failure: "expired", envelope };
  if (expires > issued + 300) return { failure: "lifetime_too_long", envelope };
  if (expires <= issued) return { failure: "lifetime_inverted", envelope };
  const nonceKey = `${network}|${payTo.toLowerCase()}|${purpose}|${nonce.toLowerCase()}`;
  if (usedNonces.has(nonceKey)) return { failure: "nonce_reused", envelope };
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId },
      types: TYPES,
      primaryType: "SellerRequest",
      message: { purpose, method: "POST", bodyHash: keccak256(new Uint8Array(raw)), network, payTo: payTo as Hex, nonce: nonce as Hex, issuedAt: BigInt(issued), expiresAt: BigInt(expires) },
      signature: signature as Hex,
    });
  } catch {
    return { failure: "signature_unrecoverable", envelope };
  }
  if (recovered.toLowerCase() !== payTo.toLowerCase()) return { failure: "signer_mismatch", envelope };
  usedNonces.add(nonceKey);
  return { envelope };
}

export async function startCircleFacilitator(tls: TlsMaterial, host = "circle.test"): Promise<CircleFacilitator> {
  const state: CircleFacilitatorState = { verify: "ok", settle: "ok", settleDelayMs: 0, rejectProofs: false, redirectTo: undefined };
  const seen: CircleSeen = { connections: 0, verifyCalls: 0, settleCalls: 0, proofFailures: [], lastRequirements: undefined, lastPayload: undefined, lastRawBody: undefined, lastProof: undefined };
  const usedNonces = new Set<string>();
  const FIXED_PAYER = "0x0000000000000000000000000000000000000501";
  const payerOf = (payload: unknown): string | undefined => {
    const inner = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)["payload"] : undefined;
    const authorization = typeof inner === "object" && inner !== null ? (inner as Record<string, unknown>)["authorization"] : undefined;
    const from = typeof authorization === "object" && authorization !== null ? (authorization as Record<string, unknown>)["from"] : undefined;
    return typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from) ? from : undefined;
  };

  const server = https.createServer({ key: tls.provider.key, cert: tls.provider.cert }, (request, response) => {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
      response.end(text);
    };
    const path = request.url ?? "/";
    if (request.method !== "POST" || (path !== "/verify" && path !== "/settle")) {
      send(404, { error: "not_found" });
      return;
    }
    const purpose = path === "/verify" ? "verify" : "settle";
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        const raw = Buffer.concat(chunks);
        seen.lastRawBody = raw.toString("utf8");
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch {
          /* 形が違えば下で落ちる */
        }
        const requirements = body["paymentRequirements"] as Record<string, unknown> | undefined;
        seen.lastRequirements = requirements;
        seen.lastPayload = body["paymentPayload"];
        // 領収の `payer` は payload の `authorization.from`（本物の Circle と同じ）。読めなければ固定値（受信の試験は値を見ない）。
        const PAYER = payerOf(body["paymentPayload"]) ?? FIXED_PAYER;
        if (purpose === "verify") seen.verifyCalls += 1;
        else seen.settleCalls += 1;
        if (state.redirectTo !== undefined) {
          send(302, { moved: true }, { location: state.redirectTo });
          return;
        }
        const header = request.headers["facilitator-seller-proof"];
        const checked = await checkProof(Array.isArray(header) ? header[0] : header, purpose, raw, requirements, usedNonces);
        seen.lastProof = checked.envelope;
        const failure = state.rejectProofs ? "rejected_by_fixture" : checked.failure;
        if (failure !== undefined) {
          seen.proofFailures.push(failure);
          send(401, { error: "unauthorized", reason: failure });
          return;
        }
        const extra = requirements?.["extra"] as Record<string, unknown> | undefined;
        if (extra?.["assetTransferMethod"] !== "eip3009") {
          send(400, { error: "invalid_request", errorReason: "asset_transfer_method_required" });
          return;
        }
        if (purpose === "verify") {
          send(200, state.verify === "ok" ? { isValid: true, payer: PAYER } : { isValid: false, invalidReason: "invalid_exact_evm_signature", invalidMessage: "SECRET_INTERNAL_DETAIL" });
          return;
        }
        if (state.settleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.settleDelayMs));
        const network = requirements?.["network"];
        const tx = `0x${randomBytes(32).toString("hex")}`;
        switch (state.settle) {
          case "minimal":
            send(200, { success: true, transaction: tx, network });
            return;
          case "reject":
            send(200, { success: false, errorReason: "insufficient_funds", transaction: "", network, payer: PAYER });
            return;
          case "pending":
            send(200, { success: false, errorReason: "settlement_pending", transaction: "", network, payer: PAYER, extensions: { "settlement-status": { status: "pending", paymentId: "pay_1", statusUrl: "/status/pay_1" } } });
            return;
          case "registration-required":
            send(403, { error: "forbidden", errorReason: "registration_required", message: "SECRET_INTERNAL_DETAIL" });
            return;
          case "conflict":
            send(409, { error: "conflict", errorReason: "payment_identifier_in_use" });
            return;
          case "bad-tx":
            send(200, { success: true, transaction: "not-a-hash", network, payer: PAYER });
            return;
          case "no-tx":
            send(200, { success: true, network, payer: PAYER, amount: "10000" });
            return;
          case "bad-network":
            send(200, { success: true, transaction: tx, network: "eip155:5042", payer: PAYER });
            return;
          case "wrong-payer":
            // 形は正しいが、payload の署名者と違う payer（Provider は同一性で拒む）。
            send(200, { success: true, transaction: tx, network, payer: "0x00000000000000000000000000000000000000b0" });
            return;
          case "unknown":
            send(500, { error: "internal", message: "SECRET_INTERNAL_DETAIL" });
            return;
          case "malformed":
            send(200, '{"success": true, "transaction": "0x');
            return;
          case "drop":
            response.socket?.destroy();
            return;
          case "huge":
            send(200, JSON.stringify({ success: true, transaction: tx, network, payer: PAYER, pad: "p".repeat(70 * 1024) }));
            return;
          case "huge-chunked": {
            // Content-Length 無し（chunked）で 64 KiB を超える: 読みながらの上限で止まるべき。
            response.writeHead(200, { "content-type": "application/json" });
            const head = `{"success":true,"transaction":"${tx}","network":"${String(network)}","pad":"`;
            response.write(head);
            for (let i = 0; i < 70; i += 1) response.write("p".repeat(1024));
            response.end('"}');
            return;
          }
          case "exact-64k": {
            // ちょうど 64 KiB の本文（Content-Length つき）は通る。
            const prefix = `{"success":true,"transaction":"${tx}","network":"${String(network)}","pad":"`;
            const suffix = '"}';
            send(200, prefix + "p".repeat(64 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix);
            return;
          }
          default:
            send(200, { success: true, transaction: tx, network, payer: PAYER, amount: 10000, extensions: { "settlement-status": { status: "confirmed", paymentId: "pay_1", statusUrl: "/status/pay_1" } } });
        }
      })();
    });
  });
  server.on("connection", () => {
    seen.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    host,
    state,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** redirect の行き先（別の listener）。接続数だけを数える。 */
export async function startSink(tls: TlsMaterial): Promise<{ port: number; connections: () => number; close(): Promise<void> }> {
  let connections = 0;
  const server = https.createServer({ key: tls.provider.key, cert: tls.provider.cert }, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { port: typeof address === "object" && address !== null ? address.port : 0, connections: () => connections, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
