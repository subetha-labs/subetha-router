/**
 * 診断の記録のファイルの sink（設計 `docs/rejection-reasons-design.md` §2.2、§13.1・§13.2・§14.2・§15.1 が優先。要件 SR-R3・SR-R4・SR-R5）。
 *
 * 流れ:
 * 1. **push**（`emit`。hook の同期の部分はこれだけ）: `snapshotCapture` で凍結した写し・その時点の scope の参照・時刻・連番を
 *    有界の環（既定 1,000 件、1 件 16 KiB、総量 2 MiB。量はバイトの見積り: 文字列は 2 × UTF-16 の長さ、object は固定の見積り）に積む。満杯・上限なら捨てて数える。
 *    throw しない・待たない・I/O をしない。
 * 2. **後回しの処理**（`setImmediate`。主の thread、1 回に 16 件まで、残りは次の `setImmediate` に譲る）: 分類・hash・検査
 *    （`buildDiagRecord`）→ JSON 化 → 上限（1 行 2,048 バイト・1 つの鍵 32 行（鍵 10,000 個、古い順に忘れる）・600 行 / 分）→ 書き込みの待ち。
 *    環から外した時点で 1 件を手放す（処理・捨てる・失敗のどの経路でも）。書き込みの待ち（書いている途中の 1 回分を含む）が 256 KiB 以上の間は
 *    環から取り出さない（環が満杯になれば push が捨てて数える = メモリは環と `writeBacklogBoundOf` の上限で止まる）。
 * 3. **書き込み**: 1 本の promise の連鎖。ディレクトリ 0700、`open(path, "a", 0o600)`。上限（既定 32 MiB）を超える前に `path` → `path.1` に
 *    rename して開き直す（1 世代）。rename の失敗は `rotateFailed`、以後は書かずに数えるだけ。書き込み・開く失敗は `writeFailed`（次の書き込みで開き直す）。
 *    fsync はしない（D-1: best effort）。
 * 4. 数: 捨てた数が増えたとき、最大 1 分に 1 回 `component:"sink", stage:"counters"` の行（`close` でも 1 回）。
 * 5. `flush({ timeoutMs })`: 環と書き込みの待ちが空になるまで（または時間切れまで）待つ。`close()`: 受付を止め、数の行を足して flush し、ファイルを閉じる。
 *
 * fs・時計・後回しの予約・timer は差し替えられる（試験）。
 */
import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";

import {
  buildDiagRecord,
  currentDiagnosticScopeFrame,
  DIAG_COUNTER_KEYS,
  snapshotCapture,
  validateDiagRecord,
  zeroCounters,
  type DiagCapture,
  type DiagComponent,
  type DiagCounters,
  type DiagEntry,
  type DiagnosticsSink,
} from "./diagnostics.js";

export interface DiagLimits {
  /** 1 行（JSON ＋ 改行）の UTF-8 のバイト数。 */
  readonly maxLineBytes: number;
  /** 1 つの鍵（`paymentId`、無ければ `quoteHash`、無ければ `cid`）あたりの行数。 */
  readonly perKeyLines: number;
  /** 覚える鍵の数（超えたら古い順に忘れる）。 */
  readonly maxKeys: number;
  /** 全体の行数 / 分（数の行は数えない）。 */
  readonly linesPerMinute: number;
  /** 環の件数。 */
  readonly maxEntries: number;
  /** 1 件の量（バイトの見積り: 固定の見積り ＋ 2 × 文字列の長さ ＋ scope の量）。 */
  readonly maxEntryCost: number;
  /** 環の総量。 */
  readonly maxRingCost: number;
  /** 1 回の後回しの処理の件数。 */
  readonly perTick: number;
  /**
   * 書き込みの待ちの上限（UTF-8 のバイト。待ち行列と **書いている途中の 1 回分** の両方を数える）。これ以上の間は環から取り出さない。
   * 1 回の後回しの処理は判定の後に最大 `perTick` 行と数の行 1 つを足すので、待ちは `writeBacklogBoundOf(limits)` を超えない。
   */
  readonly maxWriteBacklogBytes: number;
  /** ファイルの大きさ（超える前に 1 世代回す）。 */
  readonly maxFileBytes: number;
  /** 数の行の最短の間隔。 */
  readonly countersIntervalMs: number;
}

/** 既定の上限（§2.2・§14.2）。ファイルの大きさは Router の既定（facilitator 16 MiB・driver と署名の道具 8 MiB は呼び出し側が渡す）。 */
export const DEFAULT_DIAG_LIMITS: DiagLimits = Object.freeze({
  maxLineBytes: 2_048,
  perKeyLines: 32,
  maxKeys: 10_000,
  linesPerMinute: 600,
  maxEntries: 1_000,
  maxEntryCost: 16 * 1024,
  maxRingCost: 2 * 1024 * 1024,
  perTick: 16,
  maxWriteBacklogBytes: 256 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  countersIntervalMs: 60_000,
});

/** 書き込みの待ち（待ち行列 ＋ 書いている途中の 1 回分）の上限: 判定の値 ＋ 1 回の処理の行 ＋ 数の行 1 つ。 */
export function writeBacklogBoundOf(limits: DiagLimits): number {
  return limits.maxWriteBacklogBytes + (limits.perTick + 1) * limits.maxLineBytes;
}

export const DIAG_FILE_BYTES: Readonly<Record<"router" | "facilitator" | "driver" | "signer", number>> = Object.freeze({
  router: 32 * 1024 * 1024,
  facilitator: 16 * 1024 * 1024,
  driver: 8 * 1024 * 1024,
  signer: 8 * 1024 * 1024,
});

export interface DiagFileHandle {
  /** 書けたバイト数（途中までなら残りを呼び直す）。 */
  write(data: Uint8Array): Promise<number>;
  /** 開いた時点の大きさ。 */
  size(): Promise<number>;
  close(): Promise<void>;
}

export interface DiagFs {
  mkdir(dir: string, mode: number): Promise<void>;
  /** 追記で開く（無ければ `mode` で作る）。 */
  open(file: string, mode: number): Promise<DiagFileHandle>;
  rename(from: string, to: string): Promise<void>;
}

export const nodeDiagFs: DiagFs = {
  async mkdir(dir, mode) {
    await mkdir(dir, { recursive: true, mode });
  },
  async open(file, mode) {
    const handle = await open(file, "a", mode);
    return {
      async write(data) {
        const { bytesWritten } = await handle.write(data);
        return bytesWritten;
      },
      async size() {
        return (await handle.stat()).size;
      },
      close: () => handle.close(),
    };
  },
  rename: (from, to) => rename(from, to),
};

export interface FileDiagnosticsSinkOptions {
  readonly path: string;
  readonly component: Exclude<DiagComponent, "sink">;
  readonly limits?: Partial<DiagLimits>;
  /** epoch ms（`at`・頻度の窓・数の行の間隔）。 */
  readonly clock?: { now(): number };
  readonly fs?: DiagFs;
  /** 後回しの処理の予約（既定 `setImmediate`）。 */
  readonly defer?: (fn: () => void) => void;
  /** timer（既定 `setTimeout`）。返り値で取り消す。`unref` は数の行の再試行だけ（flush の時間切れは process を生かしておく）。 */
  readonly setTimer?: (fn: () => void, ms: number, unref: boolean) => () => void;
}

export interface FileDiagnosticsSink extends DiagnosticsSink {
  counters(): DiagCounters;
  /** 環と書き込みの待ちが空になるまで待つ（`true`）。時間切れ・閉じた後の fs の停止は `false`。reject しない。 */
  flush(options?: { readonly timeoutMs?: number }): Promise<boolean>;
  /** 受付を止め、数の行を足して flush し、ファイルを閉じる。reject しない。 */
  close(options?: { readonly timeoutMs?: number }): Promise<void>;
  /** 今の量（試験・運用の表示用）: 環の件数と量（バイトの見積り）、書き込みの待ちのバイト数（書いている途中の 1 回分を含む）。 */
  inspect(): { readonly ringEntries: number; readonly ringCost: number; readonly pendingBytes: number; readonly writing: boolean };
}

const defaultSetTimer = (fn: () => void, ms: number, unref: boolean): (() => void) => {
  const t = setTimeout(fn, ms);
  if (unref) t.unref();
  return () => clearTimeout(t);
};

interface RingItem extends DiagEntry {
  readonly cost: number;
}

/** 固定の大きさの環（取り出しは O(1)。取り出した枠は `undefined` にして参照を手放す）。 */
class Ring {
  private readonly items: Array<RingItem | undefined>;
  private head = 0;
  length = 0;
  cost = 0;
  constructor(private readonly capacity: number) {
    this.items = new Array<RingItem | undefined>(capacity);
  }
  push(item: RingItem): void {
    this.items[(this.head + this.length) % this.capacity] = item;
    this.length += 1;
    this.cost += item.cost;
  }
  shift(): RingItem | undefined {
    if (this.length === 0) return undefined;
    const item = this.items[this.head];
    this.items[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.length -= 1;
    if (item !== undefined) this.cost -= item.cost;
    return item;
  }
}

const NEWLINE = 0x0a;

export function createFileDiagnosticsSink(options: FileDiagnosticsSinkOptions): FileDiagnosticsSink {
  const limits: DiagLimits = { ...DEFAULT_DIAG_LIMITS, maxFileBytes: DIAG_FILE_BYTES[options.component], ...options.limits };
  const clock = options.clock ?? { now: () => Date.now() };
  const fs = options.fs ?? nodeDiagFs;
  const defer = options.defer ?? ((fn: () => void) => void setImmediate(fn));
  const setTimer = options.setTimer ?? defaultSetTimer;
  const file = options.path;
  const rotated = `${file}.1`;
  const component = options.component;

  const counters = zeroCounters();
  const ring = new Ring(Math.max(1, limits.maxEntries));
  let seq = 0;
  let closed = false;
  let scheduled = false;
  /** 書き込みの待ちが空くまで環から取り出さない。 */
  let blockedOnWrites = false;

  // 上限の状態（後回しの処理の中だけで触る）。
  const perKey = new Map<string, number>();
  let rateWindowStart = Number.NEGATIVE_INFINITY;
  let rateCount = 0;
  let lastCountersAt = Number.NEGATIVE_INFINITY;
  let droppedAtLastCounters = 0;
  let countersRetry: (() => void) | undefined;

  // 書き込みの状態。
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let writing = false;
  let handle: DiagFileHandle | undefined;
  let fileSize = 0;
  let stopped = false; // rename に失敗した後は書かない
  let dirReady = false;

  const idleWaiters = new Set<() => void>();

  function droppedTotal(): number {
    let total = 0;
    for (const key of DIAG_COUNTER_KEYS) if (key !== "written") total += counters[key];
    return total;
  }

  function isIdle(): boolean {
    return ring.length === 0 && pending.length === 0 && !writing && !scheduled;
  }

  function notifyIdle(): void {
    if (!isIdle()) return;
    for (const resolve of [...idleWaiters]) resolve();
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    try {
      defer(tick);
    } catch {
      scheduled = false;
    }
  }

  /* ── push ── */

  function emit(capture: DiagCapture): void {
    try {
      if (closed) {
        counters.droppedClosed += 1;
        return;
      }
      if (ring.length >= limits.maxEntries) {
        counters.droppedQueueFull += 1;
        schedule();
        return;
      }
      const snapshot = snapshotCapture(capture);
      const scope = currentDiagnosticScopeFrame();
      const cost = snapshot.cost + (scope?.cost ?? 0);
      if (cost > limits.maxEntryCost) {
        counters.droppedEntryTooLarge += 1;
        schedule();
        return;
      }
      if (ring.cost + cost > limits.maxRingCost) {
        counters.droppedRingBytes += 1;
        schedule();
        return;
      }
      ring.push({ capture: snapshot.value, scope, at: clock.now(), seq: seq++, cost });
      schedule();
    } catch {
      try {
        counters.pushFailed += 1;
      } catch {
        // 数えることもできなければ何もしない。
      }
    }
  }

  /* ── 後回しの処理 ── */

  function keyOf(record: { readonly paymentId?: string; readonly quoteHash?: string; readonly cid?: string }): string | undefined {
    if (record.paymentId !== undefined) return `p:${record.paymentId}`;
    if (record.quoteHash !== undefined) return `q:${record.quoteHash}`;
    if (record.cid !== undefined) return `c:${record.cid}`;
    return undefined;
  }

  const encoder = new TextEncoder();

  function enqueueLine(json: string): void {
    const bytes = encoder.encode(`${json}\n`);
    pending.push(bytes);
    pendingBytes += bytes.byteLength;
    drainWrites();
  }

  function processOne(item: RingItem): void {
    const record = buildDiagRecord(item, component);
    if (record === undefined) {
      counters.droppedSchema += 1;
      return;
    }
    const json = JSON.stringify(record);
    if (Buffer.byteLength(json, "utf8") + 1 > limits.maxLineBytes) {
      counters.droppedLineTooLarge += 1;
      return;
    }
    const key = keyOf(record);
    if (key !== undefined) {
      const seen = perKey.get(key) ?? 0;
      if (seen >= limits.perKeyLines) {
        // 使った鍵を新しい側に動かす（古い順に忘れる）。
        perKey.delete(key);
        perKey.set(key, seen);
        counters.droppedPerKey += 1;
        return;
      }
    }
    const now = clock.now();
    if (now - rateWindowStart >= 60_000 || now < rateWindowStart) {
      rateWindowStart = now;
      rateCount = 0;
    }
    if (rateCount >= limits.linesPerMinute) {
      counters.droppedRate += 1;
      return;
    }
    rateCount += 1;
    if (key !== undefined) {
      const seen = perKey.get(key) ?? 0;
      perKey.delete(key);
      perKey.set(key, seen + 1);
      while (perKey.size > limits.maxKeys) {
        const oldest = perKey.keys().next();
        if (oldest.done === true) break;
        perKey.delete(oldest.value);
      }
    }
    enqueueLine(json);
  }

  function writeCountersLine(force: boolean): void {
    const now = clock.now();
    const total = droppedTotal();
    if (!force && (total === droppedAtLastCounters || now - lastCountersAt < limits.countersIntervalMs)) return;
    lastCountersAt = now;
    droppedAtLastCounters = total;
    const record = validateDiagRecord({
      v: 1,
      at: new Date(now).toISOString(),
      seq: seq++,
      component: "sink",
      stage: "counters",
      counters: { ...counters },
    });
    if (record === undefined) return;
    enqueueLine(JSON.stringify(record));
  }

  function maybeCounters(): void {
    const total = droppedTotal();
    if (total === droppedAtLastCounters) return;
    const wait = lastCountersAt + limits.countersIntervalMs - clock.now();
    if (wait <= 0) {
      writeCountersLine(false);
      return;
    }
    if (countersRetry === undefined && !closed) {
      try {
        countersRetry = setTimer(
          () => {
            countersRetry = undefined;
            try {
              if (!closed) maybeCounters();
            } catch {
              counters.processFailed += 1;
            }
          },
          wait,
          true,
        );
      } catch {
        countersRetry = undefined;
      }
    }
  }

  function tick(): void {
    scheduled = false;
    try {
      if (pendingBytes >= limits.maxWriteBacklogBytes) {
        blockedOnWrites = true;
        return;
      }
      for (let i = 0; i < limits.perTick; i += 1) {
        const item = ring.shift();
        if (item === undefined) break;
        try {
          processOne(item);
        } catch {
          counters.processFailed += 1;
        }
      }
      maybeCounters();
    } catch {
      counters.processFailed += 1;
    } finally {
      if (ring.length > 0 && !blockedOnWrites) schedule();
      notifyIdle();
    }
  }

  /* ── 書き込み（1 本の連鎖） ── */

  async function ensureOpen(): Promise<DiagFileHandle> {
    if (handle !== undefined) return handle;
    if (!dirReady) {
      await fs.mkdir(path.dirname(file), 0o700);
      dirReady = true;
    }
    const opened = await fs.open(file, 0o600);
    try {
      fileSize = await opened.size();
    } catch (error) {
      await opened.close().catch(() => {});
      throw error;
    }
    handle = opened;
    return opened;
  }

  async function closeHandle(): Promise<void> {
    const h = handle;
    handle = undefined;
    if (h !== undefined) await h.close().catch(() => {});
  }

  async function writeAll(h: DiagFileHandle, data: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < data.byteLength) {
      const n = await h.write(data.subarray(offset));
      if (!(n > 0)) throw new Error("diagnostics write made no progress");
      offset += n;
    }
  }

  async function rotate(): Promise<boolean> {
    await closeHandle();
    try {
      await fs.rename(file, rotated);
    } catch {
      counters.rotateFailed += 1;
      stopped = true;
      return false;
    }
    fileSize = 0;
    return true;
  }

  /** 1 回分の行を書く。失敗した行は `writeFailed`。 */
  async function writeBatch(lines: Uint8Array[]): Promise<void> {
    let index = 0;
    while (index < lines.length) {
      if (stopped) {
        counters.droppedAfterRotateFailure += lines.length - index;
        return;
      }
      let h: DiagFileHandle;
      try {
        h = await ensureOpen();
      } catch {
        counters.writeFailed += lines.length - index;
        await closeHandle();
        dirReady = false;
        return;
      }
      // 上限まで行をまとめる（1 行が上限を超えるときは空のファイルにそれだけを書く）。
      const chunk: Uint8Array[] = [];
      let bytes = 0;
      while (index + chunk.length < lines.length) {
        const next = lines[index + chunk.length]!;
        if (fileSize + bytes + next.byteLength > limits.maxFileBytes && !(fileSize === 0 && chunk.length === 0)) break;
        chunk.push(next);
        bytes += next.byteLength;
      }
      if (chunk.length === 0) {
        // 次の行で上限を超える: 1 世代回して開き直す（失敗したら次の周で残りを数えて終わる）。
        await rotate();
        continue;
      }
      const data = chunk.length === 1 ? chunk[0]! : Buffer.concat(chunk);
      try {
        await writeAll(h, data);
        fileSize += bytes;
        counters.written += chunk.length;
      } catch {
        counters.writeFailed += chunk.length;
        // 途中まで書けたかもしれない。次は開き直して大きさを読み直す。
        await closeHandle();
      }
      index += chunk.length;
    }
  }

  /** 書き終えた（または失敗した）1 回分を待ちの量から外す。 */
  function settleBatch(lines: readonly Uint8Array[]): void {
    let bytes = 0;
    for (const line of lines) bytes += line.byteLength;
    pendingBytes = Math.max(0, pendingBytes - bytes);
  }

  function drainWrites(): void {
    if (writing) return;
    writing = true;
    void (async () => {
      try {
        while (pending.length > 0) {
          // 取り出した 1 回分も、書き終えるまで `pendingBytes` に数えたまま（止まる fs でも待ちの量が上限で止まる）。
          const lines = pending.splice(0, pending.length);
          try {
            await writeBatch(lines);
          } catch {
            counters.writeFailed += lines.length;
          } finally {
            settleBatch(lines);
          }
        }
      } finally {
        writing = false;
        if (blockedOnWrites) {
          blockedOnWrites = false;
          if (ring.length > 0) schedule();
        }
        notifyIdle();
      }
    })();
  }

  /* ── flush・close ── */

  function flush(flushOptions: { readonly timeoutMs?: number } = {}): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        if (isIdle()) {
          resolve(true);
          return;
        }
        let cancelTimer: (() => void) | undefined;
        const done = (value: boolean): void => {
          idleWaiters.delete(onIdle);
          cancelTimer?.();
          resolve(value);
        };
        const onIdle = (): void => done(true);
        idleWaiters.add(onIdle);
        if (ring.length > 0 && !blockedOnWrites) schedule();
        const timeoutMs = flushOptions.timeoutMs ?? 1_000;
        cancelTimer = setTimer(() => done(false), Math.max(0, timeoutMs), false);
      } catch {
        resolve(false);
      }
    });
  }

  async function close(closeOptions: { readonly timeoutMs?: number } = {}): Promise<void> {
    try {
      if (closed) return;
      closed = true;
      countersRetry?.();
      countersRetry = undefined;
      // 環に残った分を処理してから数の行を書く（数の行に最後の数が載る）。
      const drained = await flush(closeOptions);
      writeCountersLine(true);
      const written = await flush(closeOptions);
      if (drained && written && !writing) await closeHandle();
    } catch {
      // close は reject しない。
    }
  }

  return {
    emit,
    counters: () => Object.freeze({ ...counters }),
    flush,
    close,
    inspect: () => ({ ringEntries: ring.length, ringCost: ring.cost, pendingBytes, writing }),
  };
}
