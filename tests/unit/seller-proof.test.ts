/**
 * 売り手証明の能力の境界（multirail 設計 §3、FR-12・FR-13。タスク T3）:
 * `proofFor` 以外の署名の口が無い、purpose は列挙、bodyHash の形、時計は作るときに注入、network・payTo は固定、寿命の上限。
 */
import { describe, expect, test } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import {
  bodyHashOf,
  createSellerProofCapability,
  decodeSellerProofHeader,
  SELLER_PROOF_ENVELOPE_VERSION,
  SELLER_PROOF_LIFETIME_SECONDS,
  SELLER_REQUEST_TYPES,
  sellerProofDomainOf,
  type SellerProofCapabilityOptions,
} from "../../src/adapters/inbound/seller-proof.js";
import { createTestSellerProof } from "../fixtures/seller-proof-capability.js";

const ARC = "eip155:5042002";
const HASH = bodyHashOf('{"x402Version":2}');

describe("seller proof capability", () => {
  test("verify・settle の証明を作り、封筒の欄と署名者が合う。時刻は注入した時計、寿命は 60 秒、nonce は毎回違う", async () => {
    const now = 1_800_000_000_000;
    const proof = createTestSellerProof({ network: ARC, now: () => now });
    const a = decodeSellerProofHeader(await proof.capability.proofFor("verify", HASH))!;
    const b = decodeSellerProofHeader(await proof.capability.proofFor("settle", HASH))!;
    expect(a.version).toBe(SELLER_PROOF_ENVELOPE_VERSION);
    expect(a.network).toBe(ARC);
    expect(a.payTo).toBe(proof.address);
    expect(a.issuedAt).toBe(1_800_000_000);
    expect(a.expiresAt).toBe(1_800_000_000 + SELLER_PROOF_LIFETIME_SECONDS);
    expect(SELLER_PROOF_LIFETIME_SECONDS).toBe(60);
    expect(a.nonce).not.toBe(b.nonce);
    const recovered = await recoverTypedDataAddress({
      domain: sellerProofDomainOf(5042002),
      types: SELLER_REQUEST_TYPES,
      primaryType: "SellerRequest",
      message: { purpose: "verify", method: "POST", bodyHash: HASH, network: ARC, payTo: a.payTo, nonce: a.nonce, issuedAt: BigInt(a.issuedAt), expiresAt: BigInt(a.expiresAt) },
      signature: a.signature,
    });
    expect(recovered).toBe(proof.address);
    expect(proof.signCalls()).toBe(2);
  });

  test("purpose の列挙外・bodyHash の形違いは署名の前に拒む（closure は呼ばれない）", async () => {
    const proof = createTestSellerProof({ network: ARC });
    await expect(proof.capability.proofFor("status" as never, HASH)).rejects.toThrow(/purpose/);
    await expect(proof.capability.proofFor("verify", "0x1234")).rejects.toThrow(/bodyHash/);
    await expect(proof.capability.proofFor("verify", "not-hex" as never)).rejects.toThrow(/bodyHash/);
    expect(proof.signCalls()).toBe(0);
  });

  test("能力は proofFor 以外の署名の口を持たない（型と実体）。寿命は設定で変えられない（61 秒の証明は作れない）", () => {
    const proof = createTestSellerProof({ network: ARC });
    expect(Object.keys(proof.capability).sort()).toEqual(["address", "network", "proofFor"]);
    expect(Object.isFrozen(proof.capability)).toBe(true);
    // @ts-expect-error 署名の口は型にも無い
    expect(proof.capability.signTypedData).toBeUndefined();
    // @ts-expect-error 署名の口は型にも無い
    expect(proof.capability.signMessage).toBeUndefined();
    // @ts-expect-error 寿命の設定は無い（設計 §3: 60 秒固定）
    expect(() => createTestSellerProof({ network: ARC, lifetimeSeconds: 61 })).not.toThrow();
    expect(Object.isFrozen(SELLER_REQUEST_TYPES)).toBe(true);
    expect(Object.isFrozen(SELLER_REQUEST_TYPES.SellerRequest)).toBe(true);
    expect(Object.isFrozen(SELLER_REQUEST_TYPES.SellerRequest[0])).toBe(true);
  });

  test("設定は作るときに写す: 渡した options を後から変えても署名の network は変わらない", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    // 呼び出し側が持ち続ける可変の options を**そのまま**渡す（fixture の写しを通さない）。
    const options = {
      network: ARC,
      address: account.address,
      now: () => 1_800_000_000_000,
      signSellerRequest: async (typedData: Parameters<SellerProofCapabilityOptions["signSellerRequest"]>[0]) =>
        account.signTypedData({ domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message }),
    };
    const capability = createSellerProofCapability(options);
    options.network = "eip155:84532";
    const envelope = decodeSellerProofHeader(await capability.proofFor("verify", HASH))!;
    expect(envelope.network).toBe(ARC);
    expect(capability.network).toBe(ARC);
    // 署名された message の network も写した値（ARC）: ARC で recover して署名者に戻る。
    const recovered = await recoverTypedDataAddress({
      domain: sellerProofDomainOf(5042002),
      types: SELLER_REQUEST_TYPES,
      primaryType: "SellerRequest",
      message: { purpose: "verify", method: "POST", bodyHash: HASH, network: ARC, payTo: envelope.payTo, nonce: envelope.nonce, issuedAt: BigInt(envelope.issuedAt), expiresAt: BigInt(envelope.expiresAt) },
      signature: envelope.signature,
    });
    expect(recovered).toBe(account.address);
  });

  test("network は eip155 だけ、アドレスの形を要求する", () => {
    expect(() => createTestSellerProof({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" })).toThrow(/eip155/);
    expect(() => createSellerProofCapability({ network: ARC, address: "0x12", signSellerRequest: async () => "0x" })).toThrow(/address/);
  });

  test("closure は能力が組んだ SellerRequest だけを受け取り、形の違う署名は拒む", async () => {
    const seen: unknown[] = [];
    const capability = createSellerProofCapability({
      network: ARC,
      address: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405",
      signSellerRequest: async (typedData) => {
        seen.push(typedData);
        return "0xdead";
      },
    });
    await expect(capability.proofFor("settle", HASH)).rejects.toThrow(/malformed signature/);
    expect(seen).toHaveLength(1);
    const typedData = seen[0] as { primaryType: string; domain: Record<string, unknown>; message: Record<string, unknown> };
    expect(typedData.primaryType).toBe("SellerRequest");
    expect(typedData.domain).toEqual({ name: "Circle Facilitator Seller Request", version: "1", chainId: 5042002 });
    expect(typedData.message["method"]).toBe("POST");
    expect(typedData.message["payTo"]).toBe("0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405");
  });
});
