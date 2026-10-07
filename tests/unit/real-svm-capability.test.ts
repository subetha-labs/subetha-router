/**
 * SVM の鍵の道具・実能力・fixture の署名器（送信の設計 §6.4・§7.1、FR-25、SR-1・SR-2。タスク U6-b）。
 * - `svmSeedFromKey`: base58 64／32 バイト・hex seed を同じ seed に。壊れた形は固定文で拒む（値を出さない）
 * - `createRealSvmCapability`: `wallet:new:solana` の seed から kit と同じ address、署名が `ed25519.verify` を通る、**鍵の文字列を保持しない**、`signCount`
 * - fixture の署名器: 本当に署名して `recheckSvmWire` を通る。壊れたモードで落ちる
 */
import { beforeAll, describe, expect, test } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { address, createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { assembleSvmWire, compileSvmMessage, expectedOf, recheckSvmWire, verifySvmSignature, type SvmExpected } from "../../src/adapters/outbound/x402-svm.js";
import { createRealSvmCapability } from "../../tools/real-svm-capability.js";
import { svmSeedFromKey } from "../../tools/svm-key.js";
import { svmSignerFromKey } from "../../tools/svm-payer.js";
import { createSvmSignerFixture } from "../fixtures/svm-signer-fixture.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const seed = new Uint8Array(32).map((_, i) => (i * 17 + 9) & 0xff);
const base58Seed = getBase58Decoder().decode(seed);
const hexSeed = `0x${Buffer.from(seed).toString("hex")}`;

describe("svmSeedFromKey", () => {
  test("base58 32 バイト・base58 64 バイト（先頭 32）・hex（0x あり/なし）が同じ seed。写しを返す", () => {
    const pub = ed25519.getPublicKey(seed);
    const sixtyFour = getBase58Decoder().decode(new Uint8Array([...seed, ...pub]));
    for (const key of [base58Seed, sixtyFour, hexSeed, hexSeed.slice(2)]) {
      const out = svmSeedFromKey(key);
      expect(Buffer.from(out)).toEqual(Buffer.from(seed));
      out[0] = (out[0] ?? 0) ^ 0xff; // 呼び出し側が壊しても次の呼び出しに影響しない
    }
    expect(Buffer.from(svmSeedFromKey(base58Seed))).toEqual(Buffer.from(seed));
  });

  test("壊れた形は固定文で拒む（値を出さない）", () => {
    for (const key of ["abc", "", "0x" + "ab".repeat(31), getBase58Decoder().decode(new Uint8Array(33)), "O0Il".repeat(10), 42 as never]) {
      let caught: unknown;
      try {
        svmSeedFromKey(key as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("the Solana key must be base58 (64 or 32 bytes) or a 32-byte hex seed");
    }
  });

  test("svm-payer の signer は同じ seed から同じ address", async () => {
    const signer = await svmSignerFromKey(base58Seed);
    expect(String(signer.address)).toBe(createRealSvmCapability(base58Seed).address);
  });
});

describe("createRealSvmCapability", () => {
  test("kit と同じ address。署名は ed25519.verify を通り、64 バイトの写し。signCount。kind real-key・network はそのまま", async () => {
    const real = createRealSvmCapability(base58Seed);
    const kit = await createKeyPairSignerFromPrivateKeyBytes(seed);
    expect(real.address).toBe(String(kit.address));
    expect(createRealSvmCapability(hexSeed).address).toBe(real.address);
    const capability = real.capability(SOL);
    expect(capability).toMatchObject({ network: SOL, address: real.address, kind: "real-key" });
    const message = new TextEncoder().encode("hello");
    const signature = capability.sign(message);
    expect(signature.length).toBe(64);
    expect(verifySvmSignature(signature, message, real.address)).toBe(true);
    expect(ed25519.verify(signature, message, ed25519.getPublicKey(seed))).toBe(true);
    expect(real.signCount()).toBe(1);
    // 入力を写す: 署名の後に message を書き換えても署名は元の message のもの。
    const second = capability.sign(message);
    message[0] = 0;
    expect(verifySvmSignature(second, new TextEncoder().encode("hello"), real.address)).toBe(true);
    expect(real.signCount()).toBe(2);
    // 返した署名は呼び出し側の所有（別の呼び出しの結果と領域を共有しない）。
    second[0] = (second[0] ?? 0) ^ 1;
    expect(verifySvmSignature(capability.sign(new TextEncoder().encode("hello")), new TextEncoder().encode("hello"), real.address)).toBe(true);
  });

  test("鍵の文字列も seed も保持しない（SR-2）: 列挙・JSON 化・プロパティの走査に seed・鍵・hex が出ない", () => {
    const real = createRealSvmCapability(base58Seed);
    const capability = real.capability(SOL);
    const seedHex = Buffer.from(seed).toString("hex");
    const walk = (value: unknown, seen = new Set<unknown>(), depth = 0): string[] => {
      if (depth > 6 || value === null || value === undefined) return [];
      if (typeof value === "string") return [value];
      if (value instanceof Uint8Array) return [Buffer.from(value).toString("hex")];
      if (typeof value === "function") return walk(Object.getOwnPropertyNames(value).map((k) => (value as never)[k]), seen, depth + 1);
      if (typeof value !== "object" || seen.has(value)) return [];
      seen.add(value);
      return Object.getOwnPropertyNames(value).flatMap((k) => walk((value as Record<string, unknown>)[k], seen, depth + 1));
    };
    for (const object of [real, capability]) {
      const strings = [...walk(object), JSON.stringify(object, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v))];
      for (const s of strings) {
        expect(s).not.toContain(base58Seed);
        expect(s).not.toContain(seedHex);
      }
      expect(Object.keys(object)).not.toContain("seed");
      expect(Object.keys(object)).not.toContain("key");
    }
    // 同期（Promise ではない）。
    expect(typeof (real as unknown as { then?: unknown }).then).toBe("undefined");
  });

  test("壊れた鍵は固定文で拒む", () => {
    expect(() => createRealSvmCapability("not-a-key")).toThrow("the Solana key must be base58 (64 or 32 bytes) or a 32-byte hex seed");
  });
});

describe("fixture の署名器: 本当に署名して recheckSvmWire を通る。壊れたモードで落ちる", () => {
  let expected: SvmExpected;
  let provider: string;
  const fixture = createSvmSignerFixture(SOL);

  beforeAll(async () => {
    provider = createSvmSignerFixture(SOL).address;
    const feePayer = createSvmSignerFixture(SOL).address;
    const [routerAta] = await findAssociatedTokenPda({ mint: address(MINT), owner: address(fixture.address), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [providerAta] = await findAssociatedTokenPda({ mint: address(MINT), owner: address(provider), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const result = expectedOf({
      offer: { scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: provider, extra: { feePayer } } as never,
      scope: { network: SOL, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS, routerAddress: fixture.address, routerAta: String(routerAta) },
      destinationAta: String(providerAta),
      paymentId: "p-fixture",
      blockhash: "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD",
      lastValidBlockHeight: 1n,
    });
    if (!result.ok) throw new Error(result.reason);
    expected = result.expected;
  });

  test("ok: 署名が検証を通り、wire の再検査（第 2 層を含む）を通る。回数と bytes を記録", () => {
    const snapshot = compileSvmMessage(expected);
    const signature = fixture.capability.sign(snapshot);
    expect(fixture.capability.kind).toBe("fixture-key");
    expect(verifySvmSignature(signature, snapshot, fixture.address)).toBe(true);
    expect(recheckSvmWire(assembleSvmWire(snapshot, expected, signature), snapshot, signature, expected, provider)).toEqual({ ok: true });
    expect(fixture.signCount()).toBe(1);
    expect(Buffer.from(fixture.signed[0]!)).toEqual(Buffer.from(snapshot));
    // 記録は写し。
    expect(fixture.signed[0]).not.toBe(snapshot);
  });

  test("broken: 正しい長さだが検証に落ち、再検査は第 2 層で落ちる。short: 64 バイトでない。throw: 例外", () => {
    const snapshot = compileSvmMessage(expected);
    fixture.mode = "broken";
    const broken = fixture.capability.sign(snapshot);
    expect(broken.length).toBe(64);
    expect(verifySvmSignature(broken, snapshot, fixture.address)).toBe(false);
    expect(recheckSvmWire(assembleSvmWire(snapshot, expected, broken), snapshot, broken, expected, provider)).toEqual({ ok: false, reason: "second_layer_credential_mismatch" });
    fixture.mode = "short";
    expect(fixture.capability.sign(snapshot).length).toBe(63);
    expect(verifySvmSignature(fixture.capability.sign(snapshot), snapshot, fixture.address)).toBe(false);
    fixture.mode = "throw";
    expect(() => fixture.capability.sign(snapshot)).toThrow(/fixture signer refused/);
    fixture.mode = "ok";
    expect(fixture.signCount()).toBe(5);
  });

  test("seed を渡せば決定的。渡さなければ乱数（2 つの fixture の address が違う）", () => {
    expect(createSvmSignerFixture(SOL, seed).address).toBe(createRealSvmCapability(base58Seed).address);
    expect(createSvmSignerFixture(SOL).address).not.toBe(createSvmSignerFixture(SOL).address);
  });
});
