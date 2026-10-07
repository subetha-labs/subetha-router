/**
 * AC-9 (c): **builder の変異**は署名前の検査（builder と独立）で止まる（送信の設計 §4.5 の 7・§4.6。タスク U7、SR-3 レビュー #1 の指摘）。
 * 共有の builder `buildSvmTransactionMessage` を差し替えて、承認済みの正しい offer のまま message を壊す（額・宛先・命令の追加・fee payer・Memo・入力の書き換え）
 * → `not_sent destination_message_mismatch`、**signer 0・支払い要求 0**。署名前の検査を外す変異では signer が 1 回呼ばれるので、この試験は signer の回数で落ちる。
 * 差し替えが効いていること自体は、壊さないモードで delivered になることと、builder の呼び出しの記録で確かめる。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { address } from "@solana/kit";

const builder = vi.hoisted(() => ({
  mode: "ok" as "ok" | "amount" | "destination" | "extra-instruction" | "fee-payer" | "memo" | "rewrite-input",
  calls: 0,
}));
vi.mock("../../src/adapters/inbound/x402-svm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/adapters/inbound/x402-svm.js")>();
  const corrupted = (params: Parameters<typeof actual.buildSvmTransactionMessage>[0]) => {
    builder.calls += 1;
    switch (builder.mode) {
      case "amount":
        return actual.buildSvmTransactionMessage({ ...params, amount: params.amount + 1n });
      case "destination":
        // 宛先を source（Router の ATA）に（自分宛て）。
        return actual.buildSvmTransactionMessage({ ...params, destination: params.source });
      case "fee-payer":
        return actual.buildSvmTransactionMessage({ ...params, feePayer: typeof params.authority === "string" ? params.authority : params.feePayer });
      case "memo":
        return actual.buildSvmTransactionMessage({ ...params, memo: `${params.memo}!` });
      case "rewrite-input": {
        // builder が入力を書き換える変異: 期待値は凍結した別の object なので検査には届かず、書き換えた値で組んだ message が検査で落ちる。
        (params as { amount: bigint }).amount = params.amount + 1n;
        return actual.buildSvmTransactionMessage(params);
      }
      case "extra-instruction": {
        const message = actual.buildSvmTransactionMessage(params);
        const instructions = [...message.instructions, { programAddress: actual.MEMO_PROGRAM_ADDRESS, accounts: [], data: new TextEncoder().encode("extra") }];
        return { ...message, instructions } as unknown as typeof message;
      }
      default:
        return actual.buildSvmTransactionMessage(params);
    }
  };
  return { ...actual, buildSvmTransactionMessage: corrupted };
});

import { harness as harnessIn, paidTransactionOk, requestOf, ROUTE, type Harness } from "../fixtures/svm-outbound-harness.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => TLS.cleanup());

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  builder.mode = "ok";
  while (closers.length > 0) await closers.pop()!();
});

const harness = (): Promise<Harness> => harnessIn({ TLS, closers });

describe("AC-9 (c): builder の変異は署名前の検査で止まる（signer 0・支払い 0）", () => {
  test("差し替えた builder は呼ばれ、壊さなければ delivered（対照）", async () => {
    const h = await harness();
    const offers = await h.rail.readChallenge(ROUTE);
    const before = builder.calls;
    const request = requestOf(h, offers[0]!);
    expect(await h.rail.pay(request)).toMatchObject({ outcome: "paid" });
    expect(builder.calls).toBeGreaterThan(before);
    expect(h.signer.signCount()).toBe(1);
    expect(paidTransactionOk(h, 0, "10000", `subetha:${request.paymentId}`)).toBe(true);
  });

  for (const mode of ["amount", "destination", "extra-instruction", "fee-payer", "memo", "rewrite-input"] as const) {
    test(`builder が ${mode} を変える → not_sent destination_message_mismatch、signer 0、支払い 0`, async () => {
      const h = await harness();
      const offers = await h.rail.readChallenge(ROUTE);
      expect(offers).toHaveLength(1);
      builder.mode = mode;
      const before = builder.calls;
      const result = await h.rail.pay(requestOf(h, offers[0]!));
      expect(builder.calls).toBeGreaterThan(before); // 壊れた builder が本当に使われた
      expect(result).toEqual({ outcome: "not_sent", reason: "destination_message_mismatch" });
      expect(h.signer.signCount()).toBe(0);
      expect(h.signer.signed).toEqual([]);
      expect(h.upstream.seen.paid).toHaveLength(0);
      expect(h.fac.seen.verifyCalls).toBe(0);
      // 予約（hash）にも達しない（検査は予約の前）。
      expect(h.reservations.size).toBe(0);
      void address;
    });
  }
});
