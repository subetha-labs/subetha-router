/**
 * 診断の記録のファイルの sink（`src/shared/diagnostics-file.ts`。設計 §2.2 の上限の表、§13.1・§13.2・§14.2・§15.1）。
 * - 各上限の境界と 1 つ超え（1 行・1 つの鍵・鍵の数・頻度・環の件数・1 件の量・環の総量・文字列の欄・ファイルの大きさ）
 * - fs の失敗（ENOSPC・EACCES・rename の失敗・遅い・止まる）: push は即座に返り throw せず、メモリは環と待ちの上限で止まる
 * - flush は後回しの待ちと書き込みの両方を空にする、数の行は最大 1 分に 1 回と close で 1 回、回すのは 1 世代
 * - 時間の上限（§15.1）: push 1 回の中央値 < 20 µs、後回しの 1 回（16 件）の中央値 < 1 ms
 *
 * fs はメモリの差し替え（`tests/fixtures/diagnostics.ts`）。実際の fs は最後の 1 つ（0600・0700）だけ。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, test } from "vitest";

import {
  DIAG_ENTRY_OVERHEAD,
  DIAG_MAX_STRING_CHARS,
  validateDiagRecord,
  withDiagnosticScope,
  type DiagCapture,
  type DiagRecord,
} from "../../src/shared/diagnostics.js";
import { createFileDiagnosticsSink, DEFAULT_DIAG_LIMITS, type DiagLimits, type FileDiagnosticsSink } from "../../src/shared/diagnostics-file.js";
import { REASON_TABLE_VERSION } from "../../src/shared/payment-reasons.js";
import { errnoError, manualDefer, memoryDiagFs, type MemoryDiagFs } from "../fixtures/diagnostics.js";

const FILE = "/runtime/diagnostics/router.ndjson";
const T0 = Date.UTC(2026, 9, 15, 0, 0, 0);

function pid(i: number): string {
  return `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
}

interface Harness {
  sink: FileDiagnosticsSink;
  mem: MemoryDiagFs;
  clock: { t: number; now(): number };
  timers: Array<{ fn: () => void; ms: number; unref: boolean; cancelled: boolean }>;
  /** 後回しを手で回すときだけ。 */
  defer?: ReturnType<typeof manualDefer>;
  records(file?: string): DiagRecord[];
}

function harness(o: { limits?: Partial<DiagLimits>; manual?: boolean; realTimers?: boolean } = {}): Harness {
  const mem = memoryDiagFs();
  const clock = { t: T0, now(): number { return this.t; } };
  const timers: Harness["timers"] = [];
  const defer = o.manual === true ? manualDefer() : undefined;
  const sink = createFileDiagnosticsSink({
    path: FILE,
    component: "router",
    clock,
    fs: mem.fs,
    ...(o.limits === undefined ? {} : { limits: o.limits }),
    ...(defer === undefined ? {} : { defer: defer.defer }),
    ...(o.realTimers === true
      ? {}
      : {
          setTimer: (fn: () => void, ms: number, unref: boolean) => {
            const entry = { fn, ms, unref, cancelled: false };
            timers.push(entry);
            // flush の時間切れは実時間で（試験が止まらないように）。数の行の再試行は手で。
            if (!unref) {
              const t = setTimeout(() => {
                if (!entry.cancelled) fn();
              }, ms);
              return () => {
                entry.cancelled = true;
                clearTimeout(t);
              };
            }
            return () => {
              entry.cancelled = true;
            };
          },
        }),
  });
  return {
    sink,
    mem,
    clock,
    timers,
    ...(defer === undefined ? {} : { defer }),
    records(file = FILE) {
      return mem.lines(file).map((line) => {
        const record = validateDiagRecord(JSON.parse(line));
        expect(record, line).toBeDefined();
        return record!;
      });
    },
  };
}

const data = (h: Harness, file = FILE): DiagRecord[] => h.records(file).filter((r) => r.component !== "sink");
const countersLines = (h: Harness, file = FILE): DiagRecord[] => h.records(file).filter((r) => r.component === "sink");

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("書き込みの基本", () => {
  test("push は同期で I/O をしない。flush で 1 行、検査を通り、at は push の時刻", async () => {
    const h = harness();
    const ret = h.sink.emit({ stage: "source_verify", paymentId: pid(1), outcome: "invalid", rawReason: "invalid_exact_evm_insufficient_balance", httpStatus: 400, elapsedMs: 12 });
    expect(ret).toBeUndefined();
    expect(h.mem.calls).toEqual([]);
    h.clock.t += 5_000;
    expect(await h.sink.flush()).toBe(true);
    const [r] = data(h);
    expect(r).toEqual({ v: 1, at: new Date(T0).toISOString(), seq: 0, component: "router", stage: "source_verify", paymentId: pid(1), httpStatus: 400, reason: "invalid_exact_evm_insufficient_balance", table: REASON_TABLE_VERSION, outcome: "invalid", elapsedMs: 12 });
    expect(h.mem.modes.get(FILE)).toBe(0o600);
    expect(h.mem.dirs.get("/runtime/diagnostics")).toBe(0o700);
    expect(h.sink.counters().written).toBe(1);
  });

  test("検査を通らない行は捨てて数える（droppedSchema）", async () => {
    const h = harness();
    h.sink.emit({ stage: "source_verify", message: "free text" } as unknown as DiagCapture);
    h.sink.emit({ stage: "source_verify", httpStatus: 7 });
    await h.sink.flush();
    expect(data(h)).toEqual([]);
    expect(h.sink.counters().droppedSchema).toBe(2);
  });

  test("scope は積む時点のもの（後の処理で今の scope を読まない）", async () => {
    const h = harness({ manual: true });
    await withDiagnosticScope({ paymentId: pid(7), quoteId: `0x${"0a".repeat(32)}` }, async () => {
      h.sink.emit({ stage: "dest_outcome", outcome: "rejected" });
    });
    await withDiagnosticScope({ paymentId: pid(8) }, async () => {
      h.defer!.runAll(); // 別の scope の中で処理しても
    });
    await h.sink.flush();
    expect(data(h)[0]).toMatchObject({ paymentId: pid(7) });
    expect(data(h)[0]!.quoteHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("上限: 1 行（2,048 バイト）", () => {
  test("いちばん大きい記録でも既定の 2,048 バイトに収まる", async () => {
    const h = harness();
    const max: DiagCapture = {
      stage: "dest_pay_request",
      paymentId: pid(1),
      attempt: 1000,
      promoted: false,
      routeId: "r".repeat(96),
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      facilitator: "circle",
      op: "mpp_solana_send_recovery",
      httpStatus: 599,
      transport: "destination_blocked",
      response: "proof_refused",
      receipt: "network_mismatch",
      receiptHeader: "x-payment-response",
      reasonField: "invalidReason",
      reasonSource: "payment_response_header",
      rawReason: "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
      outcome: "paid_no_data",
      code: "destination_message_record_unavailable",
      rpc: "rate_limited",
      rpcHttpStatus: 599,
      rpcCode: -(2 ** 31),
      elapsedMs: 3_600_000,
      bytes: 2 ** 31,
      rawTxRef: `0x${"ff".repeat(32)}`,
      txRefCheck: "mismatch",
      broadcast: "not_observed",
      fundsMayHaveMoved: true,
      signerStage: "disclosure_written",
      rawCid: { network: "eip155:84532", asset: "0xa", from: "0xb", nonce: "0xc" },
    };
    await withDiagnosticScope({ quoteId: "q", principalId: "p", requestId: "r" }, async () => h.sink.emit(max));
    await h.sink.flush();
    expect(h.sink.counters().droppedSchema).toBe(0);
    const line = h.mem.lines(FILE)[0]!;
    expect(Buffer.byteLength(`${line}\n`)).toBeLessThanOrEqual(DEFAULT_DIAG_LIMITS.maxLineBytes);
  });

  test("ちょうど上限は書き、1 バイト超えは捨てて数える", async () => {
    const probe = harness();
    probe.sink.emit({ stage: "source_verify", paymentId: pid(1) });
    await probe.sink.flush();
    const size = Buffer.byteLength(`${probe.mem.lines(FILE)[0]!}\n`);
    const at = harness({ limits: { maxLineBytes: size } });
    at.sink.emit({ stage: "source_verify", paymentId: pid(1) });
    await at.sink.flush();
    expect(data(at)).toHaveLength(1);
    const over = harness({ limits: { maxLineBytes: size - 1 } });
    over.sink.emit({ stage: "source_verify", paymentId: pid(1) });
    await over.sink.flush();
    expect(data(over)).toHaveLength(0);
    expect(over.sink.counters().droppedLineTooLarge).toBe(1);
  });
});

describe("上限: 1 つの鍵 32 行・鍵 10,000 個", () => {
  test("paymentId ごとに 32 行まで。33 行目は捨てる。別の鍵は別に数える", async () => {
    const h = harness();
    for (let i = 0; i < 33; i += 1) h.sink.emit({ stage: "transport_event", paymentId: pid(1), transport: "dns_failed" });
    for (let i = 0; i < 32; i += 1) h.sink.emit({ stage: "transport_event", paymentId: pid(2), transport: "dns_failed" });
    await h.sink.flush();
    expect(data(h).filter((r) => r.paymentId === pid(1))).toHaveLength(32);
    expect(data(h).filter((r) => r.paymentId === pid(2))).toHaveLength(32);
    expect(h.sink.counters().droppedPerKey).toBe(1);
  });

  test("鍵は paymentId → quoteHash → cid の順。鍵の無い行は数えない", async () => {
    const h = harness({ limits: { perKeyLines: 1 } });
    const cid = { network: "eip155:84532", asset: "0xa", from: "0xb", nonce: "0xc" };
    await withDiagnosticScope({ quoteId: "q1" }, async () => {
      h.sink.emit({ stage: "source_verify" });
      h.sink.emit({ stage: "source_verify" }); // 同じ quoteHash → 捨てる
      h.sink.emit({ stage: "source_verify", paymentId: pid(3) }); // paymentId が優先 → 別の鍵
    });
    h.sink.emit({ stage: "source_verify", rawCid: cid });
    h.sink.emit({ stage: "source_verify", rawCid: cid }); // 同じ cid → 捨てる
    h.sink.emit({ stage: "source_verify" });
    h.sink.emit({ stage: "source_verify" }); // 鍵なし → 数えない
    await h.sink.flush();
    expect(data(h)).toHaveLength(5);
    expect(h.sink.counters().droppedPerKey).toBe(2);
  });

  test("覚える鍵は上限まで、超えたら古い順に忘れる（既定 10,000 の境界）", async () => {
    const h = harness({ limits: { perKeyLines: 1, linesPerMinute: 1_000_000 } });
    const emitAll = async (from: number, to: number): Promise<void> => {
      for (let i = from; i < to; i += 1) {
        h.sink.emit({ stage: "transport_event", paymentId: pid(i) });
        if (i % 500 === 499) await h.sink.flush();
      }
      await h.sink.flush();
    };
    await emitAll(0, DEFAULT_DIAG_LIMITS.maxKeys); // 10,000 個の鍵
    h.sink.emit({ stage: "transport_event", paymentId: pid(0) }); // まだ覚えている → 捨てる
    await h.sink.flush();
    expect(h.sink.counters().droppedPerKey).toBe(1);
    await emitAll(DEFAULT_DIAG_LIMITS.maxKeys, DEFAULT_DIAG_LIMITS.maxKeys + 1); // 10,001 個目 → いちばん古い（pid(1)。pid(0) は使ったので新しい側）を忘れる
    h.sink.emit({ stage: "transport_event", paymentId: pid(3) }); // まだ覚えている → 捨てる（鍵は増えない）
    h.sink.emit({ stage: "transport_event", paymentId: pid(1) }); // 忘れた → 書く（代わりに pid(2) を忘れる）
    await h.sink.flush();
    expect(data(h).filter((r) => r.paymentId === pid(1))).toHaveLength(2);
    expect(data(h).filter((r) => r.paymentId === pid(3))).toHaveLength(1);
    expect(h.sink.counters().droppedPerKey).toBe(2);
  });
});

describe("上限: 600 行 / 分", () => {
  test("600 行目までは書き、601 行目は捨てる。1 分後に戻る", async () => {
    const h = harness();
    for (let i = 0; i < 601; i += 1) h.sink.emit({ stage: "transport_event", paymentId: pid(i) });
    await h.sink.flush();
    expect(data(h)).toHaveLength(600);
    expect(h.sink.counters().droppedRate).toBe(1);
    h.clock.t += 59_999;
    h.sink.emit({ stage: "transport_event", paymentId: pid(1000) });
    await h.sink.flush();
    expect(h.sink.counters().droppedRate).toBe(2);
    h.clock.t += 1;
    h.sink.emit({ stage: "transport_event", paymentId: pid(1001) });
    await h.sink.flush();
    expect(data(h)).toHaveLength(601);
  });
});

describe("上限: 環（1,000 件・1 件 16 KiB・総量 2 MiB・文字列 8 KiB）", () => {
  test("1,000 件までは積み、1,001 件目は捨てる（処理を止めた状態で）", async () => {
    const h = harness({ manual: true, limits: { linesPerMinute: 10_000, perKeyLines: 10_000 } });
    for (let i = 0; i < 1_001; i += 1) h.sink.emit({ stage: "transport_event" });
    expect(h.sink.inspect().ringEntries).toBe(1_000);
    expect(h.sink.counters().droppedQueueFull).toBe(1);
    h.defer!.runAll();
    await h.sink.flush();
    expect(data(h)).toHaveLength(1_000);
  });

  test("文字列の欄は 8,192 文字まで写す。超えたら写さず malformed", async () => {
    const h = harness();
    h.sink.emit({ stage: "source_verify", paymentId: pid(1), rawReason: "x".repeat(DIAG_MAX_STRING_CHARS) });
    h.sink.emit({ stage: "source_verify", paymentId: pid(2), rawReason: "x".repeat(DIAG_MAX_STRING_CHARS + 1) });
    await h.sink.flush();
    expect(data(h).map((r) => r.reason)).toEqual(["unrecognized", "malformed"]);
  });

  test("1 件の量はちょうど 16 KiB まで、1 超えは捨てる", async () => {
    const h = harness({ manual: true });
    // 量 = 固定の見積り ＋ 文字列の欄の長さの和（`stage` の文字列も数える）。
    const rest = DEFAULT_DIAG_LIMITS.maxEntryCost - DIAG_ENTRY_OVERHEAD - DIAG_MAX_STRING_CHARS - "source_verify".length; // 7,923
    const cid = (n: number) => ({ network: "n".repeat(n - 3), asset: "a", from: "f", nonce: "o" });
    h.sink.emit({ stage: "source_verify", rawReason: "x".repeat(DIAG_MAX_STRING_CHARS), rawCid: cid(rest) });
    expect(h.sink.inspect()).toMatchObject({ ringEntries: 1, ringCost: DEFAULT_DIAG_LIMITS.maxEntryCost });
    h.sink.emit({ stage: "source_verify", rawReason: "x".repeat(DIAG_MAX_STRING_CHARS), rawCid: cid(rest + 1) });
    expect(h.sink.inspect().ringEntries).toBe(1);
    expect(h.sink.counters().droppedEntryTooLarge).toBe(1);
  });

  test("scope の量も 1 件に数える", () => {
    const h = harness({ manual: true });
    return withDiagnosticScope({ requestId: "r".repeat(DIAG_MAX_STRING_CHARS), principalId: "p".repeat(DIAG_MAX_STRING_CHARS) }, async () => {
      h.sink.emit({ stage: "source_verify" }); // 256 + 13 + 16,384 > 16 KiB
      expect(h.sink.counters().droppedEntryTooLarge).toBe(1);
    });
  });

  test("環の総量はちょうど 2 MiB まで、超えたら捨てる", () => {
    const h = harness({ manual: true });
    const stage = "source_verify".length;
    const big = DIAG_ENTRY_OVERHEAD + DIAG_MAX_STRING_CHARS + stage; // 8,461
    const n = Math.floor(DEFAULT_DIAG_LIMITS.maxRingCost / big); // 247
    for (let i = 0; i < n; i += 1) h.sink.emit({ stage: "source_verify", rawReason: "x".repeat(DIAG_MAX_STRING_CHARS) });
    const remaining = DEFAULT_DIAG_LIMITS.maxRingCost - n * big; // 7,285
    h.sink.emit({ stage: "source_verify", rawReason: "y".repeat(remaining - DIAG_ENTRY_OVERHEAD - stage) });
    expect(h.sink.inspect()).toMatchObject({ ringEntries: n + 1, ringCost: DEFAULT_DIAG_LIMITS.maxRingCost });
    h.sink.emit({ stage: "source_verify" }); // 269 でも超える
    expect(h.sink.counters().droppedRingBytes).toBe(1);
    expect(h.sink.inspect().ringEntries).toBe(n + 1);
  });

  test("後回しの 1 回は 16 件まで、残りは次の予約に譲る。処理した分は環から外れる", () => {
    const h = harness({ manual: true });
    for (let i = 0; i < 40; i += 1) h.sink.emit({ stage: "transport_event" });
    expect(h.defer!.queue).toHaveLength(1);
    h.defer!.runOne();
    expect(h.sink.inspect().ringEntries).toBe(24);
    expect(h.defer!.queue).toHaveLength(1);
    h.defer!.runOne();
    h.defer!.runOne();
    expect(h.sink.inspect()).toMatchObject({ ringEntries: 0, ringCost: 0 });
  });
});

describe("上限: ファイルの大きさと 1 世代の回し", () => {
  async function lineSize(): Promise<number> {
    const probe = harness();
    probe.sink.emit({ stage: "transport_event", paymentId: pid(1) });
    await probe.sink.flush();
    return Buffer.byteLength(`${probe.mem.lines(FILE)[0]!}\n`);
  }

  test("ちょうど上限まで書き、次の行の前に .1 に回す。回すのは 1 世代（.1 は上書き）", async () => {
    const size = await lineSize();
    const h = harness({ limits: { maxFileBytes: size * 3 } });
    for (let i = 0; i < 3; i += 1) h.sink.emit({ stage: "transport_event", paymentId: pid(i) });
    await h.sink.flush();
    expect(h.mem.lines(FILE)).toHaveLength(3);
    expect(h.mem.files.has(`${FILE}.1`)).toBe(false);
    h.sink.emit({ stage: "transport_event", paymentId: pid(3) });
    await h.sink.flush();
    expect(data(h, `${FILE}.1`).map((r) => r.paymentId)).toEqual([pid(0), pid(1), pid(2)]);
    expect(data(h).map((r) => r.paymentId)).toEqual([pid(3)]);
    for (let i = 4; i < 7; i += 1) h.sink.emit({ stage: "transport_event", paymentId: pid(i) });
    await h.sink.flush();
    expect(data(h, `${FILE}.1`).map((r) => r.paymentId)).toEqual([pid(3), pid(4), pid(5)]);
    expect(data(h).map((r) => r.paymentId)).toEqual([pid(6)]);
    expect([...h.mem.files.keys()].sort()).toEqual([FILE, `${FILE}.1`]);
    expect(h.mem.modes.get(FILE)).toBe(0o600);
  });

  test("既存のファイルの大きさから数える（開いた時点の大きさ）", async () => {
    const size = await lineSize();
    const h = harness({ limits: { maxFileBytes: size * 2 } });
    h.mem.files.set(FILE, "x".repeat(size * 2 - 1));
    h.sink.emit({ stage: "transport_event", paymentId: pid(1) });
    await h.sink.flush();
    expect(h.mem.files.get(`${FILE}.1`)).toBe("x".repeat(size * 2 - 1));
    expect(data(h)).toHaveLength(1);
  });

  test("rename の失敗は rotateFailed、以後は書かずに数えるだけ。push は throw しない", async () => {
    const size = await lineSize();
    const h = harness({ limits: { maxFileBytes: size * 2 } });
    h.mem.renameError = errnoError("EACCES");
    for (let i = 0; i < 5; i += 1) h.sink.emit({ stage: "transport_event", paymentId: pid(i) });
    await h.sink.flush();
    expect(h.mem.lines(FILE)).toHaveLength(2);
    expect(h.sink.counters()).toMatchObject({ written: 2, rotateFailed: 1, droppedAfterRotateFailure: 3 });
    h.mem.renameError = undefined;
    h.sink.emit({ stage: "transport_event", paymentId: pid(9) });
    await h.sink.flush();
    expect(h.mem.lines(FILE)).toHaveLength(2);
    // 書かなかった行（数の行を含む）は数えるだけ
    expect(h.sink.counters().droppedAfterRotateFailure).toBeGreaterThanOrEqual(4);
    expect(h.mem.calls.filter((c) => c.startsWith("rename"))).toHaveLength(1);
  });
});

describe("fs の失敗: push は即座に返り、throw しない", () => {
  test("ENOSPC: 書けない行は writeFailed、直れば続きを書く", async () => {
    const h = harness();
    h.mem.writeError = errnoError("ENOSPC");
    for (let i = 0; i < 3; i += 1) expect(() => h.sink.emit({ stage: "transport_event", paymentId: pid(i) })).not.toThrow();
    expect(await h.sink.flush()).toBe(true);
    expect(h.sink.counters().writeFailed).toBe(3);
    h.mem.writeError = undefined;
    h.sink.emit({ stage: "transport_event", paymentId: pid(9) });
    await h.sink.flush();
    expect(data(h).map((r) => r.paymentId)).toEqual([pid(9)]);
  });

  test("EACCES（開けない）: writeFailed、次の書き込みで開き直す", async () => {
    const h = harness();
    h.mem.openError = errnoError("EACCES");
    h.sink.emit({ stage: "transport_event", paymentId: pid(1) });
    await h.sink.flush();
    expect(h.sink.counters().writeFailed).toBe(1);
    h.mem.openError = undefined;
    h.sink.emit({ stage: "transport_event", paymentId: pid(2) });
    await h.sink.flush();
    expect(data(h).map((r) => r.paymentId)).toEqual([pid(2)]);
  });

  test("途中までの書き込みは残りを書き足す", async () => {
    const h = harness();
    h.mem.partialWrite = 7;
    for (let i = 0; i < 3; i += 1) h.sink.emit({ stage: "transport_event", paymentId: pid(i) });
    await h.sink.flush();
    expect(data(h)).toHaveLength(3);
  });

  test("遅い fs: push は待たない。flush は書き込みの後に返る", async () => {
    const h = harness();
    h.mem.writeDelay = () => new Promise((r) => setTimeout(r, 30));
    const started = performance.now();
    for (let i = 0; i < 200; i += 1) h.sink.emit({ stage: "transport_event", paymentId: pid(i) });
    expect(performance.now() - started).toBeLessThan(200);
    expect(await h.sink.flush({ timeoutMs: 5_000 })).toBe(true);
    expect(data(h)).toHaveLength(200);
  });

  test.each([
    ["既定の上限", {}],
    ["頻度・鍵の上限なし（書き込みの待ちが詰まり、環から取り出さなくなる）", { linesPerMinute: 1e9, perKeyLines: 1e9 }],
  ] as Array<[string, Partial<DiagLimits>]>)("止まる fs（%s）: 大量の push でもメモリは環と書き込みの待ちの上限で止まる。flush は時間切れで false", async (_name, limits) => {
    const h = harness({ realTimers: true, limits });
    h.mem.hang = true;
    let threw = 0;
    const started = performance.now();
    for (let round = 0; round < 50; round += 1) {
      for (let i = 0; i < 2_000; i += 1) {
        try {
          h.sink.emit({ stage: "source_verify", paymentId: pid(round * 2_000 + i), rawReason: "x".repeat(1_000) });
        } catch {
          threw += 1;
        }
      }
      await new Promise<void>((r) => setImmediate(r));
      const state = h.sink.inspect();
      expect(state.ringEntries).toBeLessThanOrEqual(DEFAULT_DIAG_LIMITS.maxEntries);
      expect(state.ringCost).toBeLessThanOrEqual(DEFAULT_DIAG_LIMITS.maxRingCost);
      expect(state.pendingBytes).toBeLessThanOrEqual(DEFAULT_DIAG_LIMITS.maxWriteBacklogBytes + DEFAULT_DIAG_LIMITS.perTick * DEFAULT_DIAG_LIMITS.maxLineBytes);
    }
    expect(threw).toBe(0);
    expect(performance.now() - started).toBeLessThan(10_000);
    const c = h.sink.counters();
    expect(c.droppedQueueFull + c.droppedRingBytes + c.droppedRate + c.droppedPerKey).toBeGreaterThan(90_000);
    const f0 = performance.now();
    expect(await h.sink.flush({ timeoutMs: 50 })).toBe(false);
    expect(performance.now() - f0).toBeLessThan(1_000);
  });

  test("時計・予約・capture の getter が投げても push は throw しない（pushFailed）", () => {
    const mem = memoryDiagFs();
    const sink = createFileDiagnosticsSink({ path: FILE, component: "router", fs: mem.fs, clock: { now: () => { throw new Error("clock"); } }, defer: () => { throw new Error("defer"); } });
    expect(() => sink.emit({ stage: "source_verify" })).not.toThrow();
    const evil = Object.defineProperty({ stage: "source_verify" }, "httpStatus", { enumerable: true, get() { throw new Error("getter"); } }) as DiagCapture;
    expect(() => sink.emit(evil)).not.toThrow();
    expect(sink.counters().pushFailed).toBe(2);
  });
});

describe("flush・close・数の行", () => {
  test("flush は後回しの待ちと書き込みの両方を空にする", async () => {
    const h = harness();
    h.mem.writeDelay = () => new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 100; i += 1) h.sink.emit({ stage: "transport_event", paymentId: pid(i) });
    expect(h.sink.inspect().ringEntries).toBe(100);
    expect(await h.sink.flush({ timeoutMs: 5_000 })).toBe(true);
    expect(h.sink.inspect()).toEqual({ ringEntries: 0, ringCost: 0, pendingBytes: 0, writing: false });
    expect(data(h)).toHaveLength(100);
  });

  test("数の行: 捨てた数が増えたときだけ、最大 1 分に 1 回（後の分は timer で）、close で 1 回", async () => {
    const h = harness();
    h.sink.emit({ stage: "source_verify", httpStatus: 1 }); // droppedSchema
    await h.sink.flush();
    expect(countersLines(h)).toHaveLength(1);
    expect(countersLines(h)[0]!.counters).toMatchObject({ droppedSchema: 1 });
    h.clock.t += 10_000;
    h.sink.emit({ stage: "source_verify", httpStatus: 1 });
    await h.sink.flush();
    expect(countersLines(h)).toHaveLength(1);
    const retry = h.timers.filter((t) => t.unref && !t.cancelled);
    expect(retry).toHaveLength(1);
    expect(retry[0]!.ms).toBe(50_000);
    h.clock.t += 50_000;
    retry[0]!.fn();
    await h.sink.flush();
    expect(countersLines(h)).toHaveLength(2);
    expect(countersLines(h)[1]!.counters).toMatchObject({ droppedSchema: 2 });
    h.clock.t += 120_000;
    h.sink.emit({ stage: "transport_event" }); // 捨てていない → 数の行は増えない
    await h.sink.flush();
    expect(countersLines(h)).toHaveLength(2);
    await h.sink.close();
    expect(countersLines(h)).toHaveLength(3);
    // 数の行は自分を書く前の数（数の行 2 つ ＋ transport_event 1 つ）
    expect(countersLines(h)[2]!.counters).toMatchObject({ written: 3, droppedSchema: 2 });
    // close の後の push は数えるだけ
    expect(() => h.sink.emit({ stage: "transport_event" })).not.toThrow();
    expect(h.sink.counters().droppedClosed).toBe(1);
    await h.sink.close();
    expect(countersLines(h)).toHaveLength(3);
  });

  test("close は止まる fs でも時間切れで返る（reject しない）", async () => {
    const h = harness({ realTimers: true });
    h.mem.hang = true;
    h.sink.emit({ stage: "transport_event" });
    const started = performance.now();
    await expect(h.sink.close({ timeoutMs: 30 })).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("実際の fs: ディレクトリ 0700・ファイル 0600、追記", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "diag-sink-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "diagnostics", "router.ndjson");
    const sink = createFileDiagnosticsSink({ path: file, component: "router" });
    sink.emit({ stage: "source_verify", paymentId: pid(1) });
    await sink.close();
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as { stage: string }).stage)).toEqual(["source_verify", "counters"]);
    const again = createFileDiagnosticsSink({ path: file, component: "router" });
    again.emit({ stage: "source_settle", paymentId: pid(1) });
    await again.flush();
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(3);
    await again.close();
  });
});

describe("時間の上限（§15.1）", () => {
  /**
   * 閾値は設計の値（push の中央値 < 20 µs、16 件の後回しの 1 回の中央値 < 1 ms）。CI の揺れに備えて中央値を使い、
   * 3 回まで測り直して最良の回で判定する（GC・他の試験の負荷の山を 1 回だけ拾って落ちないように）。skip はしない。
   */
  const typical = (i: number): DiagCapture => ({
    stage: "dest_pay_request",
    httpStatus: 402,
    receipt: "absent",
    receiptHeader: "none",
    reasonField: "error",
    reasonSource: "payment_required_header",
    rawReason: "invalid_exact_evm_insufficient_balance",
    elapsedMs: 123.4 + i,
    rawCid: { network: "eip155:46630", asset: "0x7E955252E15c84f5768B83c41a71F9eba181802F", from: "0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1", nonce: `0x${"aB".repeat(32)}` },
    op: "pay",
  });
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const scope = { paymentId: pid(1), quoteId: `0x${"0a".repeat(32)}`, principalId: "principal", requestId: "request-1", routeId: "dyn-x402-to-mpp", attempt: 1 };

  test("push 1 回の中央値 < 20 µs", async () => {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3 && best >= 0.02; run += 1) {
      const samples: number[] = [];
      await withDiagnosticScope(scope, async () => {
        for (let batch = 0; batch < 4; batch += 1) {
          const h = harness({ manual: true });
          for (let i = 0; i < 900; i += 1) {
            const capture = typical(i);
            const t = performance.now();
            h.sink.emit(capture);
            samples.push(performance.now() - t);
          }
        }
      });
      best = Math.min(best, median(samples.slice(200)));
    }
    expect(best).toBeLessThan(0.02);
  });

  test("後回しの 1 回（16 件: 分類・hash・検査・JSON 化）の中央値 < 1 ms", async () => {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3 && best >= 1; run += 1) {
      const samples: number[] = [];
      const h = harness({ manual: true, limits: { linesPerMinute: 1_000_000, perKeyLines: 1_000_000 } });
      await withDiagnosticScope(scope, async () => {
        for (let round = 0; round < 60; round += 1) {
          for (let i = 0; i < 16; i += 1) h.sink.emit(typical(i));
          const t = performance.now();
          h.defer!.runOne();
          samples.push(performance.now() - t);
          await h.sink.flush();
        }
      });
      expect(h.sink.counters().droppedSchema).toBe(0);
      best = Math.min(best, median(samples.slice(10)));
    }
    expect(best).toBeLessThan(1);
  });
});
