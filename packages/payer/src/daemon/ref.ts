import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** RFC 4648, lowercase, unpadded. Every input bit is retained; unused final bits are zero. */
export function base32(bytes: Uint8Array): string {
  let bits = 0; let value = 0; let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += ALPHABET[(value >>> bits) & 31]; }
    value &= (1 << bits) - 1;
  }
  if (bits) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
/** Internal only: no caller/env identifier or entropy input. */
export function generateRef(): string { return `p_${base32(randomBytes(8))}`; }
