/**
 * Circle の Facilitator Service を**loopback で模した**合成 facilitator（multirail 設計 §4.3）。
 * **テスト基盤であり製品の facilitator ではない。** 鍵・実決済は無い。
 *
 * 本物に合わせて検査するもの:
 * - `Facilitator-Seller-Proof` header（base64url の封筒）を読み、EIP-712 `SellerRequest` の署名を recover して `payTo` と一致、
 *   `bodyHash` が受けた **body の bytes そのもの**の keccak256 と一致、`purpose` が endpoint と一致、`method` が POST、
 *   `issuedAt` が現在＋30 秒以内、`expiresAt` が現在より後かつ `issuedAt`＋300 秒以内、nonce が `(network, payTo, purpose)` で未使用、
 *   `network`・`payTo` が `paymentRequirements` と一致。違えば 401
 * - `paymentRequirements.extra.assetTransferMethod === "eip3009"`。無ければ 400
 *
 * usage: circle-facilitator.ts [--verify ok|invalid] [--settle ok|reject|pending|registration-required|conflict|bad-tx|bad-network|unknown]
 *        [--settle-delay-ms N] [--redirect] [--port N]
 */
import { randomBytes } from "node:crypto";
import http from "node:http";

import { keccak256, recoverTypedDataAddress } from "viem";

import { decodeSellerProofHeader, SELLER_REQUEST_TYPES, sellerProofDomainOf } from "../../src/adapters/inbound/seller-proof.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const verifyMode = arg("verify", "ok");
const settleMode = arg("settle", "ok");
const settleDelayMs = Number(arg("settle-delay-ms", "0"));
const redirect = process.argv.includes("--redirect");

let connections = 0;
let verifyCalls = 0;
let settleCalls = 0;
let elsewhereCalls = 0;
const proofFailures: string[] = [];
const usedNonces = new Set<string>();
let lastRequirements: unknown;
let lastPayload: unknown;
let lastProof: unknown;

function send(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  response.end(text);
}

async function readRaw(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function chainIdOf(network: unknown): number | undefined {
  const match = typeof network === "string" ? /^eip155:(\d+)$/.exec(network) : null;
  return match === null ? undefined : Number(match[1]);
}

/** 証明の検査。失敗の理由（固定文）を返す。`undefined` なら合格。 */
async function checkProof(header: string | undefined, purpose: "verify" | "settle", raw: Buffer, requirements: Record<string, unknown> | undefined): Promise<string | undefined> {
  if (header === undefined) return "proof_missing";
  const envelope = decodeSellerProofHeader(header);
  if (envelope === undefined) return "proof_malformed";
  const chainId = chainIdOf(requirements?.["network"]);
  if (chainId === undefined) return "requirements_network";
  if (envelope.network !== requirements?.["network"]) return "network_mismatch";
  if (typeof requirements?.["payTo"] !== "string" || envelope.payTo.toLowerCase() !== (requirements["payTo"] as string).toLowerCase()) return "payto_mismatch";
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(envelope.issuedAt) || !Number.isInteger(envelope.expiresAt)) return "time_not_integer";
  if (envelope.issuedAt > now + 30) return "issued_in_future";
  if (envelope.expiresAt <= now) return "expired";
  if (envelope.expiresAt > envelope.issuedAt + 300) return "lifetime_too_long";
  if (envelope.expiresAt <= envelope.issuedAt) return "lifetime_inverted";
  const nonceKey = `${envelope.network}|${envelope.payTo.toLowerCase()}|${purpose}|${envelope.nonce.toLowerCase()}`;
  if (usedNonces.has(nonceKey)) return "nonce_reused";
  let recovered: string;
  try {
    recovered = await recoverTypedDataAddress({
      domain: sellerProofDomainOf(chainId),
      types: SELLER_REQUEST_TYPES,
      primaryType: "SellerRequest",
      message: {
        purpose,
        method: "POST",
        bodyHash: keccak256(new Uint8Array(raw)),
        network: envelope.network,
        payTo: envelope.payTo,
        nonce: envelope.nonce,
        issuedAt: BigInt(envelope.issuedAt),
        expiresAt: BigInt(envelope.expiresAt),
      },
      signature: envelope.signature,
    });
  } catch {
    return "signature_unrecoverable";
  }
  if (recovered.toLowerCase() !== envelope.payTo.toLowerCase()) return "signer_mismatch";
  usedNonces.add(nonceKey);
  return undefined;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/calls") {
    send(response, 200, { connections, verifyCalls, settleCalls, elsewhereCalls, proofFailures, lastRequirements, lastPayload, lastProof });
    return;
  }
  if (url.pathname === "/elsewhere") {
    elsewhereCalls += 1;
    send(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || (url.pathname !== "/verify" && url.pathname !== "/settle")) {
    send(response, 404, { error: "not_found" });
    return;
  }
  const purpose = url.pathname === "/verify" ? "verify" : "settle";
  void (async () => {
    const raw = await readRaw(request);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      /* 形が違えば下で落ちる */
    }
    const requirements = body["paymentRequirements"] as Record<string, unknown> | undefined;
    lastRequirements = requirements;
    lastPayload = body["paymentPayload"];
    const header = request.headers["facilitator-seller-proof"];
    const headerValue = Array.isArray(header) ? header[0] : header;
    lastProof = headerValue === undefined ? undefined : decodeSellerProofHeader(headerValue);
    if (purpose === "verify") verifyCalls += 1;
    else settleCalls += 1;

    if (redirect) {
      send(response, 302, { moved: true }, { location: `http://127.0.0.1:${(server.address() as { port: number }).port}/elsewhere` });
      return;
    }
    const failure = await checkProof(headerValue, purpose, raw, requirements);
    if (failure !== undefined) {
      proofFailures.push(failure);
      send(response, 401, { error: "unauthorized", reason: failure });
      return;
    }
    const extra = requirements?.["extra"] as Record<string, unknown> | undefined;
    if (extra?.["assetTransferMethod"] !== "eip3009") {
      send(response, 400, { error: "invalid_request", errorReason: "asset_transfer_method_required" });
      return;
    }

    if (purpose === "verify") {
      send(response, 200, verifyMode === "ok" ? { isValid: true, payer: "0x0000000000000000000000000000000000000501" } : { isValid: false, invalidReason: "invalid_exact_evm_signature", invalidMessage: "SECRET_INTERNAL_DETAIL" });
      return;
    }
    if (settleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
    const network = requirements?.["network"];
    const tx = `0x${randomBytes(32).toString("hex")}`;
    switch (settleMode) {
      case "reject":
        send(response, 200, { success: false, errorReason: "insufficient_funds", transaction: "", network, payer: "0x0000000000000000000000000000000000000501" });
        return;
      case "pending":
        send(response, 200, { success: false, errorReason: "settlement_pending", transaction: "", network, payer: "0x0000000000000000000000000000000000000501", extensions: { "settlement-status": { status: "pending", paymentId: "pay_1", statusUrl: "/status/pay_1" } } });
        return;
      case "registration-required":
        send(response, 403, { error: "forbidden", errorReason: "registration_required", message: "SECRET_INTERNAL_DETAIL" });
        return;
      case "conflict":
        send(response, 409, { error: "conflict", errorReason: "payment_identifier_in_use" });
        return;
      case "bad-tx":
        send(response, 200, { success: true, transaction: "not-a-hash", network, payer: "0x0000000000000000000000000000000000000501" });
        return;
      case "bad-network":
        send(response, 200, { success: true, transaction: tx, network: "eip155:5042", payer: "0x0000000000000000000000000000000000000501" });
        return;
      case "unknown":
        send(response, 500, { error: "internal", message: "SECRET_INTERNAL_DETAIL" });
        return;
      default:
        send(response, 200, { success: true, transaction: tx, network, payer: "0x0000000000000000000000000000000000000501", amount: "10000", extensions: { "settlement-status": { status: "confirmed", paymentId: "pay_1", statusUrl: "/status/pay_1" } } });
    }
  })();
});

server.on("connection", () => {
  connections += 1;
});
server.listen(Number(arg("port", "0")), "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(`${JSON.stringify({ event: "listening", port, role: "circle-facilitator" })}\n`);
});
