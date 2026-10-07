/**
 * `tools/svm-payer.ts`（multirail 設計 §5.6、FR-17。タスク T5）: 固定値だけで組み、RPC は blockhash の 1 回だけ、署名だけで資金は動かない。
 * 組んだ transaction を Router の検査（T4-a）が受ける。鍵は乱数。
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { address, getBase58Decoder, generateKeyPairSigner } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { checkSvmTransaction, type SvmInboundPolicy } from "../../src/adapters/inbound/x402-svm.js";
import { createSvmPayer, svmSignerFromKey } from "../../tools/svm-payer.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const FEE_PAYER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const NONCE = `0x${"ab".repeat(32)}`;
const SCOPE = { mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS };

let rpc: SolanaRpcFixture;
let owner: string;
let policy: SvmInboundPolicy;
beforeAll(async () => {
  rpc = await startSolanaRpc({ mint: MINT, decimals: 6 });
  const keypair = await generateKeyPairSigner();
  owner = String(keypair.address);
  const [ata] = await findAssociatedTokenPda({ mint: address(MINT), owner: keypair.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  policy = { feePayer: FEE_PAYER, payTo: owner, destinationAta: String(ata), mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS };
});
afterAll(() => rpc.close());

function seedKey(): string {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return getBase58Decoder().decode(seed);
}

function offerOf(extra: Record<string, unknown> = {}) {
  return { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: MINT, amount: "10000", payTo: owner, maxTimeoutSeconds: 40, extra: { feePayer: FEE_PAYER, memo: NONCE, challengeNonce: NONCE, expiresAt: Math.floor(Date.now() / 1000) + 600, routeBinding: "r", fundsMoveOnCredential: false, ...extra } };
}

describe("svm payer", () => {
  test("組んだ transaction を Router の検査が受ける。RPC は getLatestBlockhash の 1 回だけ、封筒は x402 と同じ形", async () => {
    const payer = await createSvmPayer(seedKey(), { rpcUrl: rpc.url });
    const before = rpc.calls.length;
    const credential = await payer.credentialFor(offerOf(), SCOPE);
    expect(rpc.calls.slice(before).map((c) => c.method)).toEqual(["getLatestBlockhash"]);
    const decoded = JSON.parse(Buffer.from(credential, "base64").toString("utf8")) as { x402Version: number; accepted: unknown; payload: { challengeNonce: string; transaction: string } };
    expect(decoded.x402Version).toBe(2);
    expect(decoded.payload.challengeNonce).toBe(NONCE);
    expect(decoded.payload).not.toHaveProperty("txHash");
    const result = checkSvmTransaction(decoded.payload.transaction, policy, "10000", NONCE);
    expect(result).toMatchObject({ ok: true, authority: payer.address, units: 60_000, microLamports: 1n });
  });

  test("memo ≠ nonce・feePayer 無しは RPC の前に拒む（要求 0）", async () => {
    const payer = await createSvmPayer(seedKey(), { rpcUrl: rpc.url });
    const before = rpc.calls.length;
    await expect(payer.credentialFor(offerOf({ memo: `0x${"cd".repeat(32)}` }) as never, SCOPE)).rejects.toThrow(/memo/);
    await expect(payer.credentialFor(offerOf({ feePayer: undefined }) as never, SCOPE)).rejects.toThrow(/feePayer/);
    expect(rpc.calls.length).toBe(before);
  });

  test("RPC が blockhash を返さなければ署名しない", async () => {
    const payer = await createSvmPayer(seedKey(), { rpcUrl: rpc.url, fetch: (async () => new Response('{"jsonrpc":"2.0","id":1,"result":{"value":{}}}', { headers: { "content-type": "application/json" } })) as typeof fetch });
    await expect(payer.credentialFor(offerOf(), SCOPE)).rejects.toThrow(/blockhash/);
  });

  test("鍵の形: base58 の 32 バイトの seed・hex の seed・base58 の 64 バイト", async () => {
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    const fromBase58 = await svmSignerFromKey(getBase58Decoder().decode(seed));
    const fromHex = await svmSignerFromKey(`0x${Buffer.from(seed).toString("hex")}`);
    expect(String(fromHex.address)).toBe(String(fromBase58.address));
    const sixtyFour = new Uint8Array(64);
    sixtyFour.set(seed, 0);
    expect(String((await svmSignerFromKey(getBase58Decoder().decode(sixtyFour))).address)).toBe(String(fromBase58.address));
    await expect(svmSignerFromKey("abc")).rejects.toThrow(/Solana key/);
    // 形の違う鍵（引用符つき等）の失敗の文言に、入力の値を写さない。
    const quoted = `"${getBase58Decoder().decode(seed)}"`;
    let message = "";
    await svmSignerFromKey(quoted).catch((error: Error) => { message = error.message; });
    expect(message).toMatch(/Solana key/);
    expect(message).not.toContain(quoted.slice(1, 10));
  });
});
