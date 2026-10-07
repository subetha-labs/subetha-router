/**
 * `checkSvmOutboundMessage` は builder（`buildSvmTransactionMessage`）を**呼ばない**（送信の設計 §4.5 の 7、AC-9 (c)。タスク U6-a）。
 * builder を「呼ばれたら throw」に差し替えても、先に compile した snapshot の検査は通る。builder の再構築で置き換えた検査はここで落ちる。
 */
import { beforeAll, describe, expect, test, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { address, getAddressDecoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

const armed = { throwOnBuild: false, calls: 0 };
vi.mock("../../src/adapters/inbound/x402-svm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/adapters/inbound/x402-svm.js")>();
  return {
    ...actual,
    buildSvmTransactionMessage: (params: Parameters<typeof actual.buildSvmTransactionMessage>[0]) => {
      armed.calls += 1;
      if (armed.throwOnBuild) throw new Error("builder must not be called by the check");
      return actual.buildSvmTransactionMessage(params);
    },
  };
});

import { checkSvmOutboundMessage, compileSvmMessage, expectedOf, recheckSvmWire, assembleSvmWire, type SvmExpected } from "../../src/adapters/outbound/x402-svm.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const seed = new Uint8Array(32).map((_, i) => (i * 11 + 7) & 0xff);
let expected: SvmExpected;
let provider: string;

beforeAll(async () => {
  const router = getAddressDecoder().decode(ed25519.getPublicKey(seed));
  provider = getAddressDecoder().decode(ed25519.getPublicKey(new Uint8Array(32).map((_, i) => (i * 5 + 1) & 0xff)));
  const feePayer = getAddressDecoder().decode(ed25519.getPublicKey(new Uint8Array(32).map((_, i) => (i * 3 + 2) & 0xff)));
  const [routerAta] = await findAssociatedTokenPda({ mint: address(MINT), owner: address(router), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [providerAta] = await findAssociatedTokenPda({ mint: address(MINT), owner: address(provider), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const result = expectedOf({
    offer: { scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: provider, extra: { feePayer } } as never,
    scope: { network: SOL, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS, routerAddress: router, routerAta: String(routerAta) },
    destinationAta: String(providerAta),
    paymentId: "p-independence",
    blockhash: "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD",
    lastValidBlockHeight: 1n,
  });
  if (!result.ok) throw new Error(result.reason);
  expected = result.expected;
});

describe("builder からの独立", () => {
  test("builder が throw する状態でも、正しい snapshot の検査は通り、壊れた snapshot は落ちる", () => {
    const snapshot = compileSvmMessage(expected);
    const bad = compileSvmMessage({ ...expected, amount: 10001n });
    const before = armed.calls;
    expect(before).toBeGreaterThanOrEqual(2);
    armed.throwOnBuild = true;
    try {
      expect(() => compileSvmMessage(expected)).toThrow(/must not be called/); // 差し替えが効いている
      expect(checkSvmOutboundMessage(snapshot, expected)).toEqual({ ok: true });
      expect(checkSvmOutboundMessage(bad, expected)).toEqual({ ok: false, reason: "transfer_value" });
      // wire の再検査の第 1 層（snapshot との一致・署名の欄）も builder に触れない。第 2 層（受信の `checkSvmTransaction`）は受信 module の内部で組み直す
      // （module 内部の参照なので差し替えは届かない。それは受信の既存の設計）。
      const signature = ed25519.sign(snapshot, seed);
      const wire = assembleSvmWire(snapshot, expected, signature);
      expect(recheckSvmWire(wire, snapshot, signature, expected, provider)).toEqual({ ok: true });
    } finally {
      armed.throwOnBuild = false;
    }
    // 差し替えた builder は throw の試行 1 回分だけ呼ばれた（検査からは 0 回）。
    expect(armed.calls - before).toBe(1);
  });
});
