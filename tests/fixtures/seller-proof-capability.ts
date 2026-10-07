/**
 * 試験用の売り手証明の能力。毎回の乱数の鍵（viem）で `createSellerProofCapability` を組む。
 * **製品の鍵ではない。** 署名の closure は能力が組んだ `SellerRequest` だけを受け取る。
 */
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import { createSellerProofCapability, type SellerProofCapabilityOptions } from "../../src/adapters/inbound/seller-proof.js";
import type { SellerProofCapability } from "../../src/ports/inbound.js";

export interface TestSellerProof {
  readonly capability: SellerProofCapability;
  readonly address: `0x${string}`;
  /** 署名の closure が呼ばれた回数（能力の外から署名できないことの確認に使う）。 */
  readonly signCalls: () => number;
}

export function createTestSellerProof(options: Omit<SellerProofCapabilityOptions, "address" | "signSellerRequest"> & { readonly privateKey?: `0x${string}` }): TestSellerProof {
  const account = privateKeyToAccount(options.privateKey ?? generatePrivateKey());
  let calls = 0;
  const capability = createSellerProofCapability({
    ...options,
    address: account.address,
    signSellerRequest: async (typedData) => {
      calls += 1;
      return account.signTypedData({ domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message });
    },
  });
  return { capability, address: account.address, signCalls: () => calls };
}
