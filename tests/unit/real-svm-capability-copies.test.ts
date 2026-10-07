/**
 * 実能力の `sign` の境界の写し（送信の設計 §6.4）: noble の `sign` を差し替えて、**渡した buffer と library に届く buffer が別**で、
 * **library が返した buffer と呼び出し側に返る buffer が別**であることを object の同一性で観測する（タスク U6-b、レビュー #1 の指摘）。
 */
import { describe, expect, test, vi } from "vitest";
import { getBase58Decoder } from "@solana/kit";

const observed: { input?: Uint8Array; output?: Uint8Array } = {};
vi.mock("@noble/curves/ed25519", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@noble/curves/ed25519")>();
  return {
    ...actual,
    ed25519: {
      ...actual.ed25519,
      sign: (message: Uint8Array, secret: Uint8Array) => {
        observed.input = message;
        const output = actual.ed25519.sign(message, secret);
        observed.output = output;
        return output;
      },
    },
  };
});

import { createRealSvmCapability } from "../../tools/real-svm-capability.js";
import { verifySvmSignature } from "../../src/adapters/outbound/x402-svm.js";

const seed = new Uint8Array(32).map((_, i) => (i * 23 + 4) & 0xff);

describe("createRealSvmCapability: 写しの境界（noble に届く buffer と返る buffer の同一性）", () => {
  test("入力は写してから library に渡し、library の出力は写してから返す", () => {
    const real = createRealSvmCapability(getBase58Decoder().decode(seed));
    const capability = real.capability("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    const message = new TextEncoder().encode("boundary");
    const signature = capability.sign(message);
    expect(observed.input).toBeDefined();
    expect(observed.output).toBeDefined();
    // 同じ中身、別の object（領域を共有しない）。
    expect(observed.input).not.toBe(message);
    expect(Buffer.from(observed.input!)).toEqual(Buffer.from(message));
    expect(signature).not.toBe(observed.output);
    expect(Buffer.from(signature)).toEqual(Buffer.from(observed.output!));
    expect(observed.input!.buffer).not.toBe(message.buffer);
    expect(signature.buffer).not.toBe(observed.output!.buffer);
    expect(verifySvmSignature(signature, message, real.address)).toBe(true);
    expect(real.signCount()).toBe(1);
  });
});
