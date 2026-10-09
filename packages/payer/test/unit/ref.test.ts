import { expect, test } from "vitest";
import { PurchaseRef } from "../../src/protocol/summary.js";

test("canonical 64-bit base32 ref is 15 characters", () => {
  expect(PurchaseRef.safeParse("p_aaaaaaaaaaaaa").success).toBe(true);
});
test("legacy 13-total ref is rejected without normalization", () => {
  expect(PurchaseRef.safeParse("p_aaaaaaaaaaa").success).toBe(false);
});

import { base32, generateRef } from "../../src/daemon/ref.js";
// RFC 4648 section 10 vectors, independently specified (padding omitted, lowercase).
for (const [plain, encoded] of [["", ""], ["f", "my"], ["fo", "mzxq"], ["foo", "mzxw6"], ["foob", "mzxw6yq"], ["fooba", "mzxw6ytb"], ["foobar", "mzxw6ytboi"]]) {
  test(`RFC 4648 vector ${plain}`, () => expect(base32(Buffer.from(plain!))).toBe(encoded));
}
test("eight-byte known vectors preserve all 64 bits including the last bit", () => {
  expect(base32(Buffer.from("0000000000000000", "hex"))).toBe("aaaaaaaaaaaaa");
  expect(base32(Buffer.from("0000000000000001", "hex"))).toBe("aaaaaaaaaaaac");
  expect(base32(Buffer.from("ffffffffffffffff", "hex"))).toBe("7777777777776");
  expect(base32(Buffer.from("666f6f6261726261", "hex"))).toBe("mzxw6ytbojrgc");
});
for (const ref of ["p_AAAAAAAAAAAAA", "p_aaaaaaaaaaaaa===", "p_aaaaaaaaaaaab", "p_7777777777777", "p_aaaaaaaaaaaa", "p_aaaaaaaaaaaaaa", "p_aaaaaaaaaaaa0", " p_aaaaaaaaaaaaa", "p_aaaaaaaaaaaaa\n"]) {
  test(`noncanonical ref rejected: ${JSON.stringify(ref)}`, () => expect(PurchaseRef.safeParse(ref).success).toBe(false));
}
test("production randomness yields canonical full-length refs", () => {
  const refs = Array.from({ length: 128 }, () => generateRef());
  expect(new Set(refs).size).toBe(128);
  refs.forEach(ref => { expect(PurchaseRef.parse(ref)).toBe(ref); expect(ref).toHaveLength(15); });
});
test("all final symbols are canonical exactly when the unused low bit is zero", () => {
  for (const symbol of "abcdefghijklmnopqrstuvwxyz234567") {
    expect(PurchaseRef.safeParse(`p_aaaaaaaaaaaa${symbol}`).success).toBe("acegikmoqsuwy246".includes(symbol));
  }
});
