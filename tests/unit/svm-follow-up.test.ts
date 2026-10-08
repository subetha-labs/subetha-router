/**
 * Solana の署名の追跡の helper（`src/adapters/inbound/svm-follow-up.ts`。`docs/mpp-solana-design.md` §5.2、要件 SR-M1。タスク M2）。
 * transport は偽物（応答の列を返すだけ。接続しない）、時計は決定的。x402 受信の読み方（`errTerminalAt: "any"`）と MPP Solana の読み方（`"confirmed"`、回数の上限）の両方。
 */
import { describe, expect, test } from "vitest";

import { followSvmSignature, svmFollowUpRequestTimeoutOf, svmSignatureStatusOf, type FollowSvmSignatureOptions } from "../../src/adapters/inbound/svm-follow-up.js";
import type { GuardedTransport } from "../../src/net/guarded-fetch.js";

type StatusKind = "null" | "processed" | "confirmed" | "finalized" | "err-processed" | "err-confirmed" | "malformed" | "http500" | "throw";

function statusJson(kind: StatusKind): unknown {
  switch (kind) {
    case "null": return { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [null] } };
    case "processed": return { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [{ slot: 1, confirmations: 0, err: null, confirmationStatus: "processed" }] } };
    case "confirmed": return { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }] } };
    case "finalized": return { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [{ slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" }] } };
    case "err-processed": return { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [{ slot: 1, confirmations: 0, err: { InstructionError: [2, "Custom"] }, confirmationStatus: "processed" }] } };
    case "err-confirmed": return { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [{ slot: 1, confirmations: 1, err: { InstructionError: [2, "Custom"] }, confirmationStatus: "confirmed" }] } };
    case "malformed": return { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [{}] } };
    default: return undefined;
  }
}

/** 偽の transport: 応答の列を順に返し（最後の値を繰り返す）、要求の本文と signal の有無を記録する。 */
function fakeTransport(queue: StatusKind[]): { transport: GuardedTransport; bodies: string[]; reported: unknown[]; calls: () => number } {
  const bodies: string[] = [];
  const reported: unknown[] = [];
  const transport: GuardedTransport = {
    allowLoopback: false,
    boundsDns: true,
    report: (error) => { reported.push(error); },
    fetch: (async (_url: unknown, init: RequestInit) => {
      bodies.push(String(init.body));
      const kind = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (kind === "throw") throw new Error("transport failed");
      if (kind === "http500") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(statusJson(kind)), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as GuardedTransport["fetch"],
  };
  return { transport, bodies, reported, calls: () => bodies.length };
}

function fakeTime(): { clock: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[]; now: () => number } {
  let t = 0;
  const sleeps: number[] = [];
  return { clock: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, sleeps, now: () => t };
}

function follow(queue: StatusKind[], overrides: Partial<FollowSvmSignatureOptions> = {}) {
  const fake = fakeTransport(queue);
  const time = fakeTime();
  const options: FollowSvmSignatureOptions = {
    rpc: { url: "https://rpc.test/", transport: fake.transport },
    signature: "5".repeat(87),
    routeId: "r",
    operation: "test_follow_up",
    deadlineAt: 30_000,
    intervalMs: 2_000,
    requestTimeoutMs: 10_000,
    clock: time.clock,
    sleep: time.sleep,
    errTerminalAt: "any",
    searchTransactionHistory: true,
    ...overrides,
  };
  return { run: () => followSvmSignature(options), fake, time };
}

describe("svmSignatureStatusOf（判定）", () => {
  test("any: err を見たら failed（確定度を問わない）。confirmed: processed + err は pending、confirmed/finalized + err は failed", () => {
    expect(svmSignatureStatusOf(statusJson("err-processed"), "any")).toBe("failed");
    expect(svmSignatureStatusOf(statusJson("err-processed"), "confirmed")).toBe("pending");
    expect(svmSignatureStatusOf(statusJson("err-confirmed"), "any")).toBe("failed");
    expect(svmSignatureStatusOf(statusJson("err-confirmed"), "confirmed")).toBe("failed");
    expect(svmSignatureStatusOf(statusJson("confirmed"), "confirmed")).toBe("settled");
    expect(svmSignatureStatusOf(statusJson("finalized"), "any")).toBe("settled");
    expect(svmSignatureStatusOf(statusJson("processed"), "any")).toBe("pending");
    expect(svmSignatureStatusOf(statusJson("null"), "any")).toBe("pending");
    expect(svmSignatureStatusOf(statusJson("malformed"), "confirmed")).toBe("pending");
    expect(svmSignatureStatusOf("x", "any")).toBe("pending");
  });
  test("1 要求の期限は min(上限, 残り) を整数に切り下げ", () => {
    expect(svmFollowUpRequestTimeoutOf(10_500.7, 10_000)).toBe(10_000);
    expect(svmFollowUpRequestTimeoutOf(1_234.9, 10_000)).toBe(1_234);
    expect(svmFollowUpRequestTimeoutOf(-5, 10_000)).toBe(0);
  });
});

describe("followSvmSignature", () => {
  test("confirmed で settled。間隔ごとに 1 要求、本文は getSignatureStatuses と searchTransactionHistory の指定", async () => {
    const f = follow(["null", "processed", "confirmed"]);
    expect(await f.run()).toBe("settled");
    expect(f.fake.calls()).toBe(3);
    expect(f.time.sleeps).toEqual([2_000, 2_000]);
    expect(JSON.parse(f.fake.bodies[0]!)).toMatchObject({ method: "getSignatureStatuses", params: [[expect.any(String)], { searchTransactionHistory: true }] });
    const g = follow(["confirmed"], { searchTransactionHistory: false });
    expect(await g.run()).toBe("settled");
    expect(JSON.parse(g.fake.bodies[0]!).params[1]).toEqual({ searchTransactionHistory: false });
  });

  test("maxPolls で回数を打ち切る（期限の前でも）: 15 回で timeout、経過は 15 間隔分", async () => {
    const f = follow(["null"], { deadlineAt: 1_000_000, maxPolls: 15 });
    expect(await f.run()).toBe("timeout");
    expect(f.fake.calls()).toBe(15);
    expect(f.time.now()).toBe(15 * 2_000);
    // 上限が無ければ期限まで（30 秒 / 2 秒 = 15 回 + 期限で終わり）。
    const g = follow(["null"], { deadlineAt: 30_000 });
    expect(await g.run()).toBe("timeout");
    expect(g.fake.calls()).toBe(15);
  });

  test("errTerminalAt=confirmed: processed + err は続行し、confirmed + err で failed。any なら processed + err で即 failed", async () => {
    const f = follow(["err-processed", "err-processed", "err-confirmed"], { errTerminalAt: "confirmed" });
    expect(await f.run()).toBe("failed");
    expect(f.fake.calls()).toBe(3);
    const g = follow(["err-processed"], { errTerminalAt: "any" });
    expect(await g.run()).toBe("failed");
    expect(g.fake.calls()).toBe(1);
    // processed + err の後に確定したら settled（err が消えた = 別の slot で成功した場合の読み方）。
    const h = follow(["err-processed", "confirmed"], { errTerminalAt: "confirmed" });
    expect(await h.run()).toBe("settled");
  });

  test("transport の失敗・HTTP 500・形違いは報告して次の間隔へ。期限で timeout", async () => {
    const f = follow(["throw", "http500", "malformed", "null"], { deadlineAt: 8_000 });
    expect(await f.run()).toBe("timeout");
    expect(f.fake.calls()).toBe(4);
    expect(f.fake.reported).toHaveLength(1);
  });
});
