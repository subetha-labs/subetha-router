/**
 * P-1b（`docs/agent-payer-tasks.md`、設計 §3.3）: 鍵の store。既知の passphrase と salt で導出が固定、誤った passphrase で verifier 不一致、封の tag、version、改行の拒否。
 */
import { describe, expect, test } from "vitest";

import { StoreError } from "../../src/store/fs.js";
import { createKeysDocument, deriveMaster, isValidPassphrase, open, openWallet, parseKeysDocument, SCRYPT_PARAMS, seal, subkeysOf, unlockKeys } from "../../src/store/keys.js";

const PASS = "correct horse battery staple";
const SECRET = Buffer.from("ab".repeat(32), "hex");

describe("keys: derivation", () => {
  test("known vector: scrypt(N=2^17,r=8,p=1) + HKDF subkeys are deterministic and distinct", () => {
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const master = deriveMaster(Buffer.from(PASS, "utf8"), salt);
    expect(master.toString("hex")).toBe(deriveMaster(Buffer.from(PASS, "utf8"), salt).toString("hex"));
    const a = subkeysOf(master);
    expect(a.kek.length).toBe(32);
    expect(a.lek.length).toBe(32);
    expect(a.verifier.length).toBe(16);
    expect(a.kek.equals(a.lek)).toBe(false);
    expect(a.kek.subarray(0, 16).equals(a.verifier)).toBe(false);
    // 固定のベクトル（2026-10-09 に計算して固定。パラメータ・info・導出を変えると壊れる）。
    expect(master.toString("hex")).toBe("383c0968df8f334694cccb4bbe115d0f1d4df21157c63ab9d7a040ffcaaab7c6");
    expect(a.kek.toString("hex")).toBe("1fe8ed23b9e88ccb72860ce0419775afc664a46ba496d6ba95c6d1ebb247e04a");
    expect(a.lek.toString("hex")).toBe("6584f96ee9fe6289c2b89a461c309bebdd1d89db4a279782064cbf11b789bd20");
    expect(a.verifier.toString("hex")).toBe("e9566c39721c7261f49b66ac0362c8ff");
    expect(SCRYPT_PARAMS).toEqual({ name: "scrypt", N: 131_072, r: 8, p: 1 });
    // 別の passphrase・別の salt は別の鍵。
    expect(deriveMaster(Buffer.from(PASS + "x", "utf8"), salt).equals(master)).toBe(false);
    expect(deriveMaster(Buffer.from(PASS, "utf8"), Buffer.from("ff".repeat(16), "hex")).equals(master)).toBe(false);
  });

  test("passphrase rules: 8..256 chars, no CR/LF", () => {
    expect(isValidPassphrase("short")).toBe(false);
    expect(isValidPassphrase(PASS)).toBe(true);
    expect(isValidPassphrase("with\nnewline passphrase")).toBe(false);
    expect(isValidPassphrase("with\rreturn passphrase")).toBe(false);
    expect(isValidPassphrase("x".repeat(257))).toBe(false);
  });
});

describe("keys: document", () => {
  test("create → the document carries no secret; unlock with the right passphrase opens the wallet; the wrong one fails before any key is derived into the result", () => {
    const doc = createKeysDocument(PASS, { eip155: { address: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2", secret: Buffer.from(SECRET) } });
    const text = JSON.stringify(doc);
    expect(text).not.toContain(SECRET.toString("hex"));
    expect(text).not.toContain(SECRET.toString("base64"));
    expect(text).not.toContain(PASS);
    expect(doc.version).toBe(1);
    expect(doc.wallets["eip155"]!.address).toBe("0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2");
    const parsed = parseKeysDocument(text);
    const { kek, lek } = unlockKeys(parsed, PASS);
    expect(openWallet(parsed, "eip155", kek).equals(SECRET)).toBe(true);
    expect(() => openWallet(parsed, "solana", kek)).toThrow(/wallet_missing/);
    expect(lek.length).toBe(32);
    expect(() => unlockKeys(parsed, PASS + "!")).toThrow(/bad_passphrase/);
    expect(() => unlockKeys(parsed, "short")).toThrow(/bad_passphrase/);
  });

  test("the sealed box fails on a tampered tag, ciphertext or AAD (no plaintext leaks)", () => {
    const key = Buffer.alloc(32, 7);
    const box = seal(key, SECRET, "wallet:eip155:0xabc");
    expect(open(key, box, "wallet:eip155:0xabc").equals(SECRET)).toBe(true);
    const flip = (b64: string) => Buffer.from(Buffer.from(b64, "base64").map((b) => b ^ 1)).toString("base64");
    expect(() => open(key, { ...box, tag: flip(box.tag) }, "wallet:eip155:0xabc")).toThrow(/seal_mismatch/);
    expect(() => open(key, { ...box, ciphertext: flip(box.ciphertext) }, "wallet:eip155:0xabc")).toThrow(/seal_mismatch/);
    expect(() => open(key, box, "wallet:eip155:0xdef")).toThrow(/seal_mismatch/);
    expect(() => open(Buffer.alloc(32, 8), box, "wallet:eip155:0xabc")).toThrow(/seal_mismatch/);
    expect(() => open(key, { ...box, cipher: "aes-128-gcm" as never }, "x")).toThrow(/seal_unsupported/);
  });

  test("unsupported version and malformed documents are refused with fixed codes", () => {
    const doc = createKeysDocument(PASS, { eip155: { address: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2", secret: Buffer.from(SECRET) } });
    expect(() => parseKeysDocument(JSON.stringify({ ...doc, version: 2 }))).toThrow(/store_unsupported_version/);
    expect(() => parseKeysDocument("not json")).toThrow(/store_corrupt/);
    expect(() => parseKeysDocument(JSON.stringify({ ...doc, kdf: { name: "pbkdf2" } }))).toThrow(/store_corrupt/);
    // KDF のパラメータの境界、salt・verifier・iv・tag の長さ、wallet の形、rail と address の文法（AAD の区切りと曖昧にならない）。
    for (const kdf of [{ ...doc.kdf, N: 1 << 13 }, { ...doc.kdf, N: 1 << 23 }, { ...doc.kdf, N: 100_000 }, { ...doc.kdf, r: 0 }, { ...doc.kdf, p: 17 }, { ...doc.kdf, salt: "AAAA" }, { ...doc.kdf, salt: "not base64!" }]) {
      expect(() => parseKeysDocument(JSON.stringify({ ...doc, kdf })), JSON.stringify(kdf)).toThrow(/store_corrupt/);
    }
    expect(() => parseKeysDocument(JSON.stringify({ ...doc, verifier: "AAAA" }))).toThrow(/store_corrupt/);
    const wallet = doc.wallets["eip155"]!;
    for (const bad of [{ ...wallet, iv: "AAAA" }, { ...wallet, tag: "AAAA" }, { ...wallet, ciphertext: "" }, { ...wallet, address: "0x:injected" }, { ...wallet, cipher: "aes-128-gcm" }]) {
      expect(() => parseKeysDocument(JSON.stringify({ ...doc, wallets: { eip155: bad } })), JSON.stringify(bad).slice(0, 40)).toThrow(/store_corrupt/);
    }
    expect(() => parseKeysDocument(JSON.stringify({ ...doc, wallets: { "eip:155": wallet } }))).toThrow(/store_corrupt/);
    expect(() => parseKeysDocument(JSON.stringify({ ...doc, kdf: null }))).toThrow(/store_corrupt/);
    expect(() => createKeysDocument("short", {})).toThrow(/passphrase_invalid/);
    expect(() => createKeysDocument(PASS, { "eip:155": { address: "0xabc", secret: Buffer.from("x") } })).toThrow(/wallet_invalid/);
    expect(() => createKeysDocument(PASS, { eip155: { address: "0x:abc", secret: Buffer.from("x") } })).toThrow(/wallet_invalid/);
    expect(() => createKeysDocument(PASS, { eip155: { address: "0xabc", secret: Buffer.alloc(0) } })).toThrow(/wallet_invalid/);
    const e = (() => { try { parseKeysDocument("x"); return undefined; } catch (err) { return err; } })();
    expect(e).toBeInstanceOf(StoreError);
  });
});
