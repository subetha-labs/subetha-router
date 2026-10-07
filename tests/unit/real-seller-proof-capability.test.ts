/**
 * `tools/real-seller-proof-capability.ts`（multirail 設計 §3。タスク T5）: env の鍵から能力を作る。鍵は乱数（実鍵ではない）。
 */
import { describe, expect, test } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { bodyHashOf, decodeSellerProofHeader, SELLER_REQUEST_TYPES, sellerProofDomainOf } from "../../src/adapters/inbound/seller-proof.js";
import { ARC_RECEIVER_KEY_ENV, createRealSellerProofCapability } from "../../tools/real-seller-proof-capability.js";

const ARC = "eip155:5042002";

describe("real seller proof capability", () => {
  test("env の鍵のアドレスが payTo になり、証明はその鍵で署名される。能力は proofFor だけ", async () => {
    const key = generatePrivateKey();
    const capability = createRealSellerProofCapability(ARC, { [ARC_RECEIVER_KEY_ENV]: key }, () => 1_800_000_000_000);
    expect(capability.address).toBe(privateKeyToAccount(key).address);
    expect(capability.network).toBe(ARC);
    expect(Object.keys(capability).sort()).toEqual(["address", "network", "proofFor"]);
    const hash = bodyHashOf("{}");
    const envelope = decodeSellerProofHeader(await capability.proofFor("settle", hash))!;
    const recovered = await recoverTypedDataAddress({
      domain: sellerProofDomainOf(5042002),
      types: SELLER_REQUEST_TYPES,
      primaryType: "SellerRequest",
      message: { purpose: "settle", method: "POST", bodyHash: hash, network: ARC, payTo: envelope.payTo, nonce: envelope.nonce, issuedAt: BigInt(envelope.issuedAt), expiresAt: BigInt(envelope.expiresAt) },
      signature: envelope.signature,
    });
    expect(recovered).toBe(capability.address);
    expect(envelope.expiresAt - envelope.issuedAt).toBe(60);
  });

  test("env が無い・形が違う・network が EVM でない → 作れない", () => {
    expect(() => createRealSellerProofCapability(ARC, {})).toThrow(/SUBETHA_ARC_RECEIVER_KEY/);
    expect(() => createRealSellerProofCapability(ARC, { [ARC_RECEIVER_KEY_ENV]: "0x12" })).toThrow(/SUBETHA_ARC_RECEIVER_KEY/);
    expect(() => createRealSellerProofCapability("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", { [ARC_RECEIVER_KEY_ENV]: generatePrivateKey() })).toThrow(/eip155/);
  });
});
