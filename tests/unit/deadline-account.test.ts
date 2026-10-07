/**
 * 静的 MPP の期限の wrapper（送信の設計 §2.4、FR-36。タスク U3）: account の署名口を**実際の委譲の直前**に期限で止める。
 * 署名口の無い account（json-rpc）はそのまま（送金 RPC の委譲の直前の検査が受け持つ）。
 */
import { describe, expect, test } from "vitest";

import { DeadlineRefusedError, wrapAccountWithDeadline, type DeadlineState } from "../../src/adapters/outbound/mpp.js";

describe("wrapAccountWithDeadline", () => {
  test("期限の前は委譲して数え、期限の後は委譲せず DeadlineRefusedError（refused が立つ）", async () => {
    const calls: unknown[] = [];
    const account = { address: "0x00000000000000000000000000000000000000b0", type: "local", signTransaction: async (tx: unknown) => { calls.push(tx); return "0xraw"; } };
    let now = 1_000;
    const state: DeadlineState = { deadlineMs: 2_000, refused: false, signatures: 0 };
    const wrapped = wrapAccountWithDeadline(account, state, () => now);
    expect(await wrapped.signTransaction({ a: 1 })).toBe("0xraw");
    expect(calls).toEqual([{ a: 1 }]);
    expect(state).toMatchObject({ signatures: 1, refused: false });
    now = 2_000;
    await expect(wrapped.signTransaction({ a: 2 })).rejects.toBeInstanceOf(DeadlineRefusedError);
    expect(calls).toHaveLength(1);
    expect(state).toMatchObject({ signatures: 1, refused: true });
    // 他の欄はそのまま（address・type）。
    expect(wrapped.address).toBe(account.address);
    expect(wrapped.type).toBe("local");
  });

  test("署名口の無い account（json-rpc）は署名口を足さない", () => {
    const account = { address: "0x00000000000000000000000000000000000000b0", type: "json-rpc" } as const;
    const state: DeadlineState = { deadlineMs: 0, refused: false, signatures: 0 };
    const wrapped = wrapAccountWithDeadline(account, state, () => 1);
    expect(Object.keys(wrapped).sort()).toEqual(["address", "type"]);
  });

  test("署名口が複数あればすべて包む（signTypedData・signMessage も期限で止まる）", async () => {
    const account = { address: "0x1", type: "local", signTypedData: async () => "0xa", signMessage: async () => "0xb" };
    const state: DeadlineState = { deadlineMs: 10, refused: false, signatures: 0 };
    const wrapped = wrapAccountWithDeadline(account, state, () => 10);
    await expect(wrapped.signTypedData()).rejects.toBeInstanceOf(DeadlineRefusedError);
    await expect(wrapped.signMessage()).rejects.toBeInstanceOf(DeadlineRefusedError);
    expect(state.signatures).toBe(0);
  });
});
