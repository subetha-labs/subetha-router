/**
 * 試験用の SVM 署名器（送信の設計 §7.1、タスク U6-b）: 乱数の seed で**本当に署名**し（`ed25519.verify` を通る成功の経路）、
 * `sign` の回数と渡された bytes（写し）を記録する。`kind: "fixture-key"`。改変の試験用に「壊れた署名を返す」モード（`mode`）。
 */
import { ed25519 } from "@noble/curves/ed25519";
import { getAddressDecoder } from "@solana/kit";

import type { SvmSigningCapability } from "../../src/ports/outbound.js";

export type SvmSignerMode = "ok" | "broken" | "short" | "throw";

export interface SvmSignerFixture {
  readonly address: string;
  readonly seed: Uint8Array;
  readonly capability: SvmSigningCapability;
  /** `sign` が受けた bytes の写し（呼ばれた順）。 */
  readonly signed: Uint8Array[];
  readonly signCount: () => number;
  /** `ok`（既定）、`broken`（正しい長さで 1 bit 壊す）、`short`（63 バイト）、`throw`（例外）。 */
  mode: SvmSignerMode;
}

export function createSvmSignerFixture(network: string, seedSource?: Uint8Array): SvmSignerFixture {
  const seed = seedSource === undefined ? crypto.getRandomValues(new Uint8Array(32)) : Uint8Array.from(seedSource);
  const address = getAddressDecoder().decode(ed25519.getPublicKey(seed));
  const signed: Uint8Array[] = [];
  const fixture: SvmSignerFixture = {
    address,
    seed,
    signed,
    signCount: () => signed.length,
    mode: "ok",
    capability: {
      network,
      address,
      kind: "fixture-key",
      sign(messageBytes: Uint8Array): Uint8Array {
        signed.push(Uint8Array.from(messageBytes));
        if (fixture.mode === "throw") throw new Error("fixture signer refused");
        const signature = Uint8Array.from(ed25519.sign(Uint8Array.from(messageBytes), seed));
        if (fixture.mode === "broken") signature[10] = (signature[10] ?? 0) ^ 1;
        if (fixture.mode === "short") return signature.subarray(0, 63);
        return signature;
      },
    },
  };
  return fixture;
}
