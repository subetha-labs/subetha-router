/**
 * 秘匿購入の容量（設計 §3.7、T-Z4b）: 新規予約を含む不等式、`reserve` の失敗は mkdir せず、`sessionEnded` はセッション枠だけ、`attestSettled` は record 以外を全部消した後にだけ縮める、
 * 掃除の失敗は予約を保つ、再構成は record のバイト数と件数、再構成前の `reserve` は失敗、検証ジョブの枠。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { PrivateCapacity, purchaseAllowanceOf, type CapacityLimits } from "../../src/core/private-capacity.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      for (const entry of readdirSync(dir)) chmodSync(path.join(dir, entry), 0o700);
    } catch {
      // 無ければよい。
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const LIMITS: CapacityLimits = { maxConcurrentSessions: 2, maxRetainedPurchases: 3, maxRetainedBytes: 10_000, purchaseAllowance: 4_000, maxConcurrentVerifications: 1, maxQueuedVerifications: 2 };

function capacity(limits: Partial<CapacityLimits> = {}): { cap: PrivateCapacity; work: string } {
  mkdirSync(runtimeRoot, { recursive: true });
  const work = mkdtempSync(path.join(runtimeRoot, "private-capacity-"));
  dirs.push(work);
  return { cap: new PrivateCapacity({ ...LIMITS, ...limits }, work), work };
}

describe("reserve", () => {
  test("再構成前は失敗し、開いた後は不等式（新規予約を含む）を満たすときだけ mkdir 0700 して予約する", () => {
    const { cap, work } = capacity();
    expect(cap.reserve("p1")).toBeUndefined();
    expect(existsSync(path.join(work, "p1"))).toBe(false);
    cap.open({ purchases: 0, bytes: 0 });
    const a = cap.reserve("p1")!;
    const b = cap.reserve("p2")!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(cap.snapshot()).toEqual({ activeSessions: 2, committedPurchases: 2, committedBytes: 8_000, runningVerifications: 0, queuedVerifications: 0 });
    // 3 件目: セッション枠（2）が尽きている。
    expect(cap.reserve("p3")).toBeUndefined();
    expect(existsSync(path.join(work, "p3"))).toBe(false);
    a.sessionEnded();
    // セッション枠は空いたが、量（8000 + 4000 > 10000）が足りない。
    expect(cap.reserve("p3")).toBeUndefined();
    b.release();
    expect(existsSync(path.join(work, "p2"))).toBe(false);
    expect(cap.snapshot()).toMatchObject({ activeSessions: 0, committedPurchases: 1, committedBytes: 4_000 });
    expect(cap.reserve("p3")).toBeDefined();
    // 同じ paymentId・不正な id は予約しない。
    expect(cap.reserve("p3")).toBeUndefined();
    expect(cap.reserve("../x")).toBeUndefined();
  });
  test("件数の上限（再構成の件数を含む）", () => {
    const { cap } = capacity({ maxRetainedPurchases: 2, maxRetainedBytes: 100_000 });
    cap.open({ purchases: 1, bytes: 500 });
    expect(cap.reserve("p1")).toBeDefined();
    expect(cap.reserve("p2")).toBeUndefined();
  });
});

describe("attestSettled / retire", () => {
  test("record 以外を全部消した後にだけ record の実測に縮める。record が無ければ全部返す", () => {
    const { cap, work } = capacity();
    cap.open({ purchases: 0, bytes: 0 });
    const lease = cap.reserve("p1")!;
    writeFileSync(path.join(work, "p1", "record.json"), "x".repeat(1234));
    writeFileSync(path.join(work, "p1", "order_final.json"), "secret");
    writeFileSync(path.join(work, "p1", "bundle.json"), "b");
    mkdirSync(path.join(work, "p1", "sub"));
    writeFileSync(path.join(work, "p1", "sub", "x"), "y");
    expect(lease.attestSettled()).toBe(true);
    expect(readdirSync(path.join(work, "p1"))).toEqual(["record.json"]);
    expect(cap.snapshot()).toMatchObject({ activeSessions: 0, committedPurchases: 1, committedBytes: 1234 });
    lease.retire();
    expect(existsSync(path.join(work, "p1"))).toBe(false);
    expect(cap.snapshot()).toMatchObject({ committedPurchases: 0, committedBytes: 0 });
    const none = cap.reserve("p2")!;
    expect(none.attestSettled()).toBe(true);
    expect(existsSync(path.join(work, "p2"))).toBe(false);
    expect(cap.snapshot()).toMatchObject({ committedPurchases: 0, committedBytes: 0 });
  });
  test("掃除に失敗したら予約は縮めない", () => {
    if (process.getuid?.() === 0) return; // root は権限で止まらない
    const { cap, work } = capacity();
    cap.open({ purchases: 0, bytes: 0 });
    const lease = cap.reserve("p1")!;
    writeFileSync(path.join(work, "p1", "record.json"), "x".repeat(10));
    mkdirSync(path.join(work, "p1", "locked"));
    writeFileSync(path.join(work, "p1", "locked", "f"), "y");
    chmodSync(path.join(work, "p1", "locked"), 0o500);
    expect(lease.attestSettled()).toBe(false);
    expect(cap.snapshot()).toMatchObject({ committedBytes: 4_000, committedPurchases: 1 });
    chmodSync(path.join(work, "p1", "locked"), 0o700);
  });
  test("adoptRetained は再構成の record を義務に載せ、retire で返す", () => {
    const { cap, work } = capacity();
    mkdirSync(path.join(work, "old"));
    writeFileSync(path.join(work, "old", "record.json"), "x".repeat(300));
    cap.open({ purchases: 1, bytes: 300 });
    const lease = cap.adoptRetained("old", 300);
    expect(cap.snapshot()).toMatchObject({ committedPurchases: 1, committedBytes: 300 });
    lease.retire();
    expect(existsSync(path.join(work, "old"))).toBe(false);
    expect(cap.snapshot()).toMatchObject({ committedPurchases: 0, committedBytes: 0 });
  });
});

describe("検証ジョブの枠", () => {
  test("実行 1・待ち 2。3 つ目の待ちは undefined。release で次が動く", async () => {
    const { cap } = capacity();
    cap.open({ purchases: 0, bytes: 0 });
    const first = cap.enqueueVerification();
    const second = cap.enqueueVerification();
    const third = cap.enqueueVerification();
    const fourth = cap.enqueueVerification();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    expect(fourth).toBeUndefined();
    expect(cap.snapshot()).toMatchObject({ runningVerifications: 1, queuedVerifications: 2 });
    let secondStarted = false;
    void second!.then(() => {
      secondStarted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondStarted).toBe(false);
    (await first!).release();
    const slot2 = await second!;
    expect(secondStarted).toBe(true);
    expect(cap.snapshot()).toMatchObject({ runningVerifications: 1, queuedVerifications: 1 });
    slot2.release();
    slot2.release();
    (await third!).release();
    expect(cap.snapshot()).toMatchObject({ runningVerifications: 0, queuedVerifications: 0 });
  });
  test("purchaseAllowanceOf", () => {
    expect(purchaseAllowanceOf({ maxRecordBytes: 65_536, maxBundleBytes: 262_144, maxChildOutputBytes: 65_536 })).toBe(65_536 + 262_144 + 65_536 + 4 * 65_536 + 8_192 + 8_192);
  });
});
