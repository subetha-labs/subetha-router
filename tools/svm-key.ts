/**
 * Solana の鍵の文字列 → 32 バイトの seed（同期。送信の設計 §6.4、タスク U6-b）。**製品コードではない**（鍵を扱う起動側の道具）。
 *
 * 受ける形は `tools/svm-payer.ts` の `svmSignerFromKey` と同じ: base58 の 64 バイト（secret ‖ public。先頭 32 が seed）、base58 の 32 バイト、
 * hex の 32 バイト（`0x` 任意）。失敗の文言に鍵の値を含めない。
 */
import { getBase58Encoder } from "@solana/kit";

const HEX_SEED = /^(0x)?[0-9a-fA-F]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

export function svmSeedFromKey(key: string): Uint8Array {
  const refuse = (): never => {
    throw new Error("the Solana key must be base58 (64 or 32 bytes) or a 32-byte hex seed");
  };
  if (typeof key !== "string") return refuse();
  try {
    if (HEX_SEED.test(key)) {
      return new Uint8Array(Buffer.from(key.replace(/^0x/, ""), "hex"));
    }
    if (!BASE58.test(key)) return refuse();
    const bytes = getBase58Encoder().encode(key);
    if (bytes.length !== 64 && bytes.length !== 32) return refuse();
    return Uint8Array.from(bytes.subarray(0, 32));
  } catch {
    return refuse();
  }
}
