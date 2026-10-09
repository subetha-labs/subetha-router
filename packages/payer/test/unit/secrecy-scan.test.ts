import { randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { seal } from "../../src/store/keys.js";
import { plaintextRows } from "../harness/secrecy.js";
import { containsSecret } from "../harness/secret-cases.js";

test("plaintext scanner exempts only an authenticated exact row envelope; invalid/nested sealed stays visible", () => {
  const lek = randomBytes(32), secret = "synthetic-scanner-secret";
  const base = { ref: "p_aaaaaaaaaaaaa", state: "quoted", data: {} };
  const box = seal(lek, Buffer.from(secret), `${base.ref}:${base.state}`);
  try {
    expect(containsSecret(plaintextRows([{ ...base, sealed: box }], lek), secret)).toBe(false);
    for (const sealed of [secret, { value: secret }, { ...box, plaintext: secret }, { ...box, ciphertext: Buffer.from(secret).toString("base64") }]) {
      expect(containsSecret(plaintextRows([{ ...base, sealed }], lek), secret)).toBe(true);
    }
    expect(containsSecret(plaintextRows([{ ...base, data: { sealed: secret }, sealed: box }], lek), secret)).toBe(true);
    const wrongAad = { ...base, ref: "p_bbbbbbbbbbbba", sealed: box };
    expect(Object.hasOwn(plaintextRows([wrongAad], lek)[0]!, "sealed")).toBe(true);
  } finally { lek.fill(0); }
});
