/**
 * 秘匿購入の HTTP の上限（`docs/zktls-router-design.md` §2）: attest の本文は bundle の復号後の上限（`maxBundleBytes`）を base64 で包んだ大きさ + JSON の余白。
 * 符号化長の上限（HTTP）と復号後の上限（core）は別々に検査する。
 */
export function MAX_ATTEST_BODY_BYTES_OF(maxBundleBytes: number): number {
  return 4096 + Math.ceil((maxBundleBytes * 4) / 3);
}
