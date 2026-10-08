/**
 * P-0: `src/shared/` への抽出は挙動を変えない。`src/config.ts` と `src/adapters/inbound/x402-svm.ts` は同じ値・同じ関数を re-export する
 * （import 先を変えていない既存コードと、vendor する payer が同じものを見る）。
 */
import { describe, expect, test } from "vitest";

import { getBase58Encoder } from "@solana/kit";

import * as config from "../../src/config.js";
import * as x402Svm from "../../src/adapters/inbound/x402-svm.js";
import * as networks from "../../src/shared/networks.js";
import * as svmMessage from "../../src/shared/svm-message.js";

describe("P-0: shared extraction re-exports the same objects", () => {
  test("network table and helpers: identical references through src/config.ts", () => {
    expect(config.KNOWN_NETWORKS).toBe(networks.KNOWN_NETWORKS);
    expect(config.knownNetworkOf).toBe(networks.knownNetworkOf);
    expect(config.knownAssetOf).toBe(networks.knownAssetOf);
    expect(config.evmChainIdOf).toBe(networks.evmChainIdOf);
    expect(config.assetKeyOf).toBe(networks.assetKeyOf);
    expect(config.isWellFormedPayTo).toBe(networks.isWellFormedPayTo);
    expect(config.networkFamilyOf).toBe(networks.networkFamilyOf);
    expect(config.isCaip2Network).toBe(networks.isCaip2Network);
    expect(config.MPP_SOLANA_SCHEME).toBe(networks.MPP_SOLANA_SCHEME);
    expect(Object.isFrozen(networks.KNOWN_NETWORKS)).toBe(true);
    expect(networks.KNOWN_NETWORKS.map((n) => n.network)).toEqual(["eip155:84532", "eip155:42431", "eip155:5042002", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"]);
  });

  test("base58DecodedLength agrees with @solana/kit's decoder (32-byte keys, shorter and longer values, leading ones, invalid characters)", () => {
    const samples = [
      "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5",
      "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d",
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "11111111111111111111111111111111",
      "1111111111111111111111111111111112",
      "2",
      "z",
      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    ];
    for (const sample of samples) {
      expect(networks.base58DecodedLength(sample), sample).toBe(getBase58Encoder().encode(sample).length);
    }
    expect(networks.base58DecodedLength("0OIl")).toBeUndefined();
    expect(networks.isWellFormedPayTo("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5")).toBe(true);
    expect(networks.isWellFormedPayTo("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "1111111111111111111111111111111112")).toBe(false);
    // 文字を削った・足した値は、kit の復号の長さが 32 かどうかと同じ判定になる（固定の真偽ではなく等価性を見る）。
    for (const variant of ["CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp", "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5z", "2CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"]) {
      expect(networks.isWellFormedPayTo("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", variant), variant).toBe(getBase58Encoder().encode(variant).length === 32);
    }
  });

  test("SVM message builder and constants: identical references through x402-svm.ts", () => {
    expect(x402Svm.buildSvmTransactionMessage).toBe(svmMessage.buildSvmTransactionMessage);
    expect(x402Svm.MEMO_PROGRAM_ADDRESS).toBe(svmMessage.MEMO_PROGRAM_ADDRESS);
    expect(x402Svm.SVM_DEFAULT_COMPUTE_UNITS).toBe(svmMessage.SVM_DEFAULT_COMPUTE_UNITS);
    expect(x402Svm.SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT).toBe(svmMessage.SVM_DEFAULT_MICRO_LAMPORTS_PER_UNIT);
    expect(x402Svm.SVM_INSTRUCTION_COUNT).toBe(svmMessage.SVM_INSTRUCTION_COUNT);
    expect(x402Svm.SVM_MAX_COMPUTE_UNITS).toBe(svmMessage.SVM_MAX_COMPUTE_UNITS);
    expect(x402Svm.SVM_MAX_MICRO_LAMPORTS_PER_UNIT).toBe(svmMessage.SVM_MAX_MICRO_LAMPORTS_PER_UNIT);
    expect(x402Svm.SVM_TRANSACTION_MAX_BYTES).toBe(svmMessage.SVM_TRANSACTION_MAX_BYTES);
    expect(x402Svm.SVM_TRANSACTION_MAX_BASE64_CHARS).toBe(svmMessage.SVM_TRANSACTION_MAX_BASE64_CHARS);
  });
});
