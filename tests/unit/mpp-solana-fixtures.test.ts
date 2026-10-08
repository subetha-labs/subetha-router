/**
 * fixture の自己試験と U-10（`docs/mpp-solana-design.md` §8.1・§10、要件 §1.1 F-12。タスク M3-a）:
 * - Router の mppx **0.11.0** が serialize した challenge を、本物の pay-kit（mppx 0.13.2 を同梱）の client が読んで credential を作り、
 *   0.11.0 の `Credential.deserialize` と `validateCredential`（HMAC・期限・scope）が通る（**最初に確かめる互換。違えば止めて owner に D-25 を諮る**）
 * - その credential（`transaction` 型）を Router の純粋な検査が通す（pay-kit の client は compute budget を price → limit の順で付ける）
 * - `signature` 型（fixture が送出して包み直す）も通す
 * - RPC の fixture が pay-kit の **server** の verify（両型）を満たす（simulate・send・statuses・getTransaction の jsonParsed）= M4-b の Provider D の fixture の準備
 * - `npm ls` の二重解決: Router の mppx は 0.11.0、pay-kit の下は 0.13.2
 */
import { execFileSync } from "node:child_process";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { address, generateKeyPairSigner, getAddressEncoder, getBase58Decoder, getTransactionEncoder, partiallySignTransactionMessageWithSigners } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { createPayKit, Signer, usd } from "@solana/pay-kit";
import { Challenge, Credential, Method } from "mppx";
import { Mppx as ClientMppx } from "mppx/client";
import { Mppx } from "mppx/server";

import { buildSvmTransactionMessage } from "../../src/adapters/inbound/x402-svm.js";
import {
  checkMppSolanaTransaction,
  isSvmPublicKeyString,
  mppSolanaChargeMethod,
  mppSolanaPayloadOf,
  newExternalId,
  preflightMppSolana,
  signerOf,
  MPP_SOLANA_SCHEME,
  type MppSolanaPolicy,
} from "../../src/adapters/inbound/mpp-solana.js";
import type { InboundOffer } from "../../src/ports/inbound.js";
import { createMppSolanaTestPayer, transactionOfWire, type MppSolanaTestPayer } from "../fixtures/mpp-solana-payer.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);
const SECRET = "mpp-solana-fixture-secret-0123456789abcdef0123456789";
const ROUTE_BINDING = ["md-solmpp", "GET", "/v1/routes/md-solmpp/resource"].map(encodeURIComponent).join("|");

let rpc: SolanaRpcFixture;
let payer: MppSolanaTestPayer;
let owner: string;
let ownerAta: string;
let policy: MppSolanaPolicy;

async function ataOf(o: string): Promise<string> {
  return String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(o), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
}

/** Router 側（M3-b の adapter が行うこと）: 0.11.0 の server で challenge を発行し、offer に写す。 */
function routerServer() {
  const server = Method.toServer(mppSolanaChargeMethod, {
    validate: async ({ credential }) => ({ challenge: credential.challenge, credential, details: {}, intent: "charge" as const, method: "solana" as const, request: credential.challenge.request }),
    broadcast: async () => {
      throw new Error("broadcast must never be called");
    },
  });
  return Mppx.create({ secretKey: SECRET, realm: "router-test", methods: [server] });
}
type RouterMppx = ReturnType<typeof routerServer>;

async function issue(mppx: RouterMppx, overrides: { amount?: string; externalId?: string; expiresInMs?: number } = {}): Promise<{ offer: InboundOffer; challenge: Record<string, unknown>; externalId: string }> {
  const externalId = overrides.externalId ?? newExternalId();
  const amount = overrides.amount ?? "10000";
  const expires = new Date(Date.now() + (overrides.expiresInMs ?? 600_000)).toISOString();
  const challenge = (await mppx.challenge.solana.charge({
    amount,
    currency: MINT,
    recipient: owner,
    externalId,
    methodDetails: { network: "devnet", decimals: 6, tokenProgram: TOKEN_PROGRAM, feePayer: false },
    expires,
    scope: ROUTE_BINDING,
    meta: { routeBinding: ROUTE_BINDING, paymentId: `p-${Date.now()}` },
  } as never)) as unknown as Record<string, unknown>;
  const offer: InboundOffer = {
    scheme: MPP_SOLANA_SCHEME,
    network: SOL,
    asset: MINT,
    amount,
    payTo: owner,
    maxTimeoutSeconds: 600,
    extra: { challengeNonce: String(challenge["id"]), expiresAt: Math.floor(Date.parse(expires) / 1000), routeBinding: ROUTE_BINDING, fundsMoveOnCredential: true, challenge: Challenge.serialize(challenge as never), externalId, decimals: 6, tokenProgram: TOKEN_PROGRAM },
  };
  return { offer, challenge, externalId };
}

beforeAll(async () => {
  const keypair = await generateKeyPairSigner();
  owner = String(keypair.address);
  ownerAta = await ataOf(owner);
  rpc = await startSolanaRpc({ mint: MINT, decimals: 6, ata: { address: ownerAta, owner } });
  payer = await createMppSolanaTestPayer({ rpcUrl: rpc.url });
  policy = { recipient: owner, destinationAta: ownerAta, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM };
});
afterAll(async () => {
  await payer.close();
  await rpc.close();
});

describe("U-10: Router の mppx 0.11.0 と pay-kit（0.13.x）の互換", () => {
  test("npm の解決: Router の mppx は 0.11.0、pay-kit の下は 0.13.2（overrides）", () => {
    const tree = JSON.parse(execFileSync("npm", ["ls", "mppx", "--depth=2", "--json"], { encoding: "utf8" })) as { dependencies: Record<string, { version: string; dependencies?: Record<string, { version: string }> }> };
    expect(tree.dependencies["mppx"]?.version).toBe("0.11.0");
    expect(tree.dependencies["@solana/pay-kit"]?.version).toBe("0.13.1");
    expect(tree.dependencies["@solana/pay-kit"]?.dependencies?.["mppx"]?.version).toBe("0.13.2");
  });

  test("0.11.0 の challenge → pay-kit の client（既定）→ transaction 型の credential。0.11.0 の deserialize と validateCredential（HMAC・scope）が通り、Router の検査も通る", async () => {
    const mppx = routerServer();
    const { offer, challenge, externalId } = await issue(mppx);
    const credential = await payer.credentialFor(offer);
    const wire = credential.payload["credential"] as string;
    const decoded = Credential.deserialize(wire);
    expect(decoded.challenge.id).toBe(challenge["id"]);
    expect((decoded.payload as { type: unknown }).type).toBe("transaction");
    await expect(mppx.validateCredential(wire, { scope: ROUTE_BINDING })).resolves.toMatchObject({ method: "solana", intent: "charge" });
    await expect(mppx.validateCredential(wire, { scope: "other|GET|/x" })).rejects.toThrow();
    expect(preflightMppSolana(offer, credential, Date.now())).toEqual({ ok: true });
    const payload = mppSolanaPayloadOf(wire);
    expect(payload?.type).toBe("transaction");
    const bytes = (payload as { bytes: Uint8Array }).bytes;
    const signer = signerOf(bytes);
    expect(signer).toBe(payer.address);
    const check = checkMppSolanaTransaction(bytes, policy, "10000", externalId, await ataOf(payer.address));
    expect(check).toMatchObject({ ok: true, signer: payer.address, units: 200_000, microLamports: 1n });
    // pay-kit の client の既定の compute budget は price → limit の順（§1.1 F-4）: 組み直しが順序を観測していることの証拠は `mpp-solana-check.test.ts`。
    expect(checkMppSolanaTransaction(bytes, policy, "10001", externalId, await ataOf(payer.address))).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(checkMppSolanaTransaction(bytes, policy, "10000", newExternalId(), await ataOf(payer.address))).toEqual({ ok: false, reason: "nonce_mismatch" });
    // RPC: pay-kit の client は blockhash を 1 回読むだけ（送出しない）。
    expect(rpc.calls.filter((c) => c.method === "sendTransaction")).toEqual([]);
  });

  test("signature 型: fixture が同じ transaction を RPC の fixture に送出して包み直す。署名は送出した tx の [0]", async () => {
    const mppx = routerServer();
    const { offer } = await issue(mppx);
    const before = rpc.state.sent.length;
    const credential = await payer.credentialFor(offer, "signature");
    const wire = credential.payload["credential"] as string;
    const payload = mppSolanaPayloadOf(wire);
    expect(payload?.type).toBe("signature");
    expect(rpc.state.sent.length).toBe(before + 1);
    expect(rpc.state.transactions.has((payload as { signature: string }).signature)).toBe(true);
    await expect(mppx.validateCredential(wire, { scope: ROUTE_BINDING })).resolves.toMatchObject({ method: "solana" });
    expect(preflightMppSolana(offer, credential, Date.now())).toEqual({ ok: true });
  });

  test("改竄した challenge（HMAC）は 0.11.0 の validateCredential が落とす。期限切れも", async () => {
    const mppx = routerServer();
    const { offer, challenge } = await issue(mppx);
    const credential = await payer.credentialFor(offer);
    const wire = credential.payload["credential"] as string;
    const decoded = Credential.deserialize(wire);
    const tampered = Credential.serialize({ ...decoded, challenge: { ...decoded.challenge, request: { ...(decoded.challenge.request as Record<string, unknown>), amount: "1" } } } as never);
    await expect(mppx.validateCredential(tampered, { scope: ROUTE_BINDING })).rejects.toThrow();
    const expired = await issue(mppx, { expiresInMs: 1_000 });
    const expiredCredential = await payer.credentialFor(expired.offer);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(mppx.validateCredential(expiredCredential.payload["credential"] as string, { scope: ROUTE_BINDING })).rejects.toThrow();
    void challenge;
  });
});

describe("RPC の fixture は pay-kit の server の verify を満たす（M4-b の Provider D の fixture の準備）", () => {
  async function providerD(feePayer: boolean) {
    const operator = await Signer.generate();
    const pay = await createPayKit({ network: "devnet", rpcUrl: rpc.url, accept: ["mpp"], operator: { signer: operator, feePayer, recipient: owner }, mpp: { challengeBindingSecret: SECRET, realm: "provider-d-fixture" } } as never);
    const handler = pay.fetch(usd("0.01"), async () => Response.json({ ok: true }));
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(key, value);
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${request.url}`;
      const out = await handler(new Request(url, { method: request.method ?? "GET", headers, ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}) }));
      response.writeHead(out.status, Object.fromEntries(out.headers.entries()));
      response.end(Buffer.from(await out.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  test("transaction 型（feePayer: false = server が送出）: simulate → send → statuses → getTransaction(jsonParsed) → 200 と Payment-Receipt", async () => {
    const d = await providerD(false);
    try {
      rpc.state.signatureStatuses = ["confirmed"];
      const client = await (await import("@solana/pay-kit/client")).createPayKitClient({ signer: (await Signer.generate()).signer as never, rpcUrl: rpc.url, network: "devnet", accept: ["mpp"] });
      const sentBefore = rpc.state.sent.length;
      const response = await client.fetch(`${d.base}/paid`, { method: "GET" }, "mpp");
      expect(response.status).toBe(200);
      const receipt = response.headers.get("payment-receipt");
      expect(receipt).toBeTruthy();
      const decoded = JSON.parse(Buffer.from(receipt!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(decoded).toMatchObject({ method: "solana", status: "success" });
      expect(rpc.state.sent.length).toBe(sentBefore + 1);
      const methods = rpc.calls.map((c) => c.method);
      for (const m of ["simulateTransaction", "sendTransaction", "getSignatureStatuses", "getTransaction"]) expect(methods).toContain(m);
    } finally {
      rpc.state.signatureStatuses = undefined;
      await d.close();
    }
  });

  test("signature 型（0.11.0 で包み直した credential）: pay-kit の server は getTransaction(jsonParsed) で検証して 200", async () => {
    const d = await providerD(false);
    try {
      // challenge は pay-kit の server から取る（402）。credential は fixture の経路（pay-kit client → 送出 → 包み直し）で作る。
      const first = await fetch(`${d.base}/paid`);
      expect(first.status).toBe(402);
      const header = first.headers.get("www-authenticate")!;
      const offer: InboundOffer = { scheme: MPP_SOLANA_SCHEME, network: SOL, asset: MINT, amount: "10000", payTo: owner, maxTimeoutSeconds: 600, extra: { challengeNonce: "n", expiresAt: 0, routeBinding: "", fundsMoveOnCredential: true, challenge: header } };
      const credential = await payer.credentialFor(offer, "signature");
      const paid = await fetch(`${d.base}/paid`, { headers: { authorization: credential.payload["credential"] as string } });
      expect(paid.status).toBe(200);
      expect(paid.headers.get("payment-receipt")).toBeTruthy();
    } finally {
      await d.close();
    }
  });

  test("U-10 の送信の向き: 0.11.0 の client（preparePayment）が pay-kit の server の challenge（feePayer: true、feePayerKey あり）を読み、Router の builder の pull の transaction を 0.11.0 が serialize した credential を pay-kit の server が共同署名して settle する", async () => {
    const d = await providerD(true);
    try {
      rpc.state.signatureStatuses = ["confirmed"];
      const payerKey = await generateKeyPairSigner();
      const payerAta = await ataOf(String(payerKey.address));
      let seen: Record<string, unknown> | undefined;
      let produced: Uint8Array | undefined;
      let feePayerKey: string | undefined;
      const method = Method.toClient(mppSolanaChargeMethod, {
        async createCredential({ challenge }) {
          seen = challenge as unknown as Record<string, unknown>;
          const request = challenge.request as { amount: string; currency: string; recipient: string; externalId?: string; methodDetails: { feePayer?: boolean; feePayerKey?: string; decimals: number; tokenProgram?: string } };
          expect(request.methodDetails.feePayer).toBe(true);
          expect(isSvmPublicKeyString(request.methodDetails.feePayerKey)).toBe(true);
          // Router の builder（送信の設計 §4.3 の形: [0] fee payer = feePayerKey は空、[1] = payer）。Memo は externalId があるときだけ。
          const message = buildSvmTransactionMessage({
            feePayer: request.methodDetails.feePayerKey!,
            source: payerAta,
            authority: payerKey,
            destination: await ataOf(request.recipient),
            mint: request.currency,
            amount: BigInt(request.amount),
            decimals: request.methodDetails.decimals,
            memo: request.externalId,
            units: 60_000,
            microLamports: 1n,
            blockhash: "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD",
            tokenProgram: request.methodDetails.tokenProgram ?? TOKEN_PROGRAM,
          });
          const signed = await partiallySignTransactionMessageWithSigners(message);
          produced = Uint8Array.from(getTransactionEncoder().encode(signed));
          feePayerKey = request.methodDetails.feePayerKey;
          return Credential.serialize({ challenge, payload: { type: "transaction", transaction: Buffer.from(produced).toString("base64") } } as never);
        },
      });
      const client = ClientMppx.create({ methods: [method], polyfill: false, maxPaymentRetries: 0 } as never) as unknown as { rawFetch: typeof fetch; preparePayment: (response: Response, options: { request: RequestInit }) => Promise<{ challenge: Record<string, unknown>; createCredential: () => Promise<string>; setCredential: (init: RequestInit, credential: string) => RequestInit }> };
      const init: RequestInit = { method: "GET" };
      const first = await client.rawFetch(`${d.base}/paid`, init);
      expect(first.status).toBe(402);
      const prepared = await client.preparePayment(first, { request: init });
      expect(prepared.challenge).toMatchObject({ method: "solana", intent: "charge" });
      const credential = await prepared.createCredential();
      expect(seen).toBeDefined();
      const sentBefore = rpc.state.sent.length;
      const paid = await client.rawFetch(`${d.base}/paid`, { ...prepared.setCredential(init, credential), method: "GET" });
      expect(paid.status).toBe(200);
      const receipt = JSON.parse(Buffer.from(paid.headers.get("payment-receipt")!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(receipt).toMatchObject({ method: "solana", status: "success" });
      // server が共同署名して送出した: 送った wire は [0] が空・[1] が payer の署名。受けた wire は同じ message・同じ [1] で、[0] が feePayerKey で検証できる署名。
      expect(rpc.state.sent.length).toBe(sentBefore + 1);
      const sentBytes = new Uint8Array(Buffer.from(rpc.state.sent.at(-1)!, "base64"));
      expect(produced![0]).toBe(2);
      expect(produced!.subarray(1, 65).every((b) => b === 0)).toBe(true);
      expect(sentBytes[0]).toBe(2);
      const message = sentBytes.subarray(129);
      expect(Buffer.compare(Buffer.from(message), Buffer.from(produced!.subarray(129)))).toBe(0);
      expect(Buffer.compare(Buffer.from(sentBytes.subarray(65, 129)), Buffer.from(produced!.subarray(65, 129)))).toBe(0);
      const feePayerSignature = sentBytes.subarray(1, 65);
      expect(feePayerSignature.some((b) => b !== 0)).toBe(true);
      expect(ed25519.verify(feePayerSignature, message, new Uint8Array(getAddressEncoder().encode(address(feePayerKey!))))).toBe(true);
      expect(ed25519.verify(sentBytes.subarray(65, 129), message, new Uint8Array(getAddressEncoder().encode(payerKey.address)))).toBe(true);
      // 領収の reference は共同署名後の [0]。
      expect(receipt["reference"]).toBe(getBase58Decoder().decode(feePayerSignature));
    } finally {
      rpc.state.signatureStatuses = undefined;
      await d.close();
    }
  });

  test("transactionOfWire: transaction 型以外は throw", async () => {
    const mppx = routerServer();
    const { offer } = await issue(mppx);
    const credential = await payer.credentialFor(offer, "signature");
    expect(() => transactionOfWire(credential.payload["credential"] as string)).toThrow(/not a transaction-type/);
  });
});
