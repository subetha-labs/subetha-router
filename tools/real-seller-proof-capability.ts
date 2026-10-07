/**
 * Circle の売り手証明の**実能力**（multirail 設計 §3。タスク T5）。**製品コードではない**（鍵を扱う起動側）。
 *
 * env `SUBETHA_ARC_RECEIVER_KEY`（証明専用の受取鍵。Base Sepolia の受取鍵とは別）から viem の account を作り、
 * `signTypedData` を**この能力の中だけ**に閉じた closure として `createSellerProofCapability` に渡す。
 * `src/` に渡るのは能力（`proofFor`）だけで、鍵も `signTypedData` も渡らない。
 */
import { privateKeyToAccount } from "viem/accounts";

import { createSellerProofCapability } from "../src/adapters/inbound/seller-proof.js";
import type { SellerProofCapability } from "../src/ports/inbound.js";

export const ARC_RECEIVER_KEY_ENV = "SUBETHA_ARC_RECEIVER_KEY";

export function createRealSellerProofCapability(network: string, env: Readonly<Record<string, string | undefined>> = process.env, now: () => number = Date.now): SellerProofCapability {
  const key = env[ARC_RECEIVER_KEY_ENV];
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${ARC_RECEIVER_KEY_ENV} must be a 0x-prefixed 32-byte hex key`);
  }
  const account = privateKeyToAccount(key as `0x${string}`);
  return createSellerProofCapability({
    network,
    address: account.address,
    now,
    signSellerRequest: (typedData) => account.signTypedData({ domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message }),
  });
}
