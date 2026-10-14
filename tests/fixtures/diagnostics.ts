/**
 * 診断の記録の試験の差し替え（設計 `docs/rejection-reasons-design.md` §2.2）。**製品コードではない。**
 * - `recordingDiagnostics()`: push の時点の写しと scope を覚え、ファイルの sink と同じ `buildDiagRecord` で記録にする
 * - `throwingDiagnostics()`: `emit` が必ず投げる（hook の `safeEmit` が握ることを確かめる）
 * - `memoryDiagFs()`: メモリの fs。開く・書く・回すの失敗（`EACCES`・`ENOSPC`）、遅い書き込み、止まる書き込みを差し込める
 */
import {
  buildDiagRecord,
  currentDiagnosticScopeFrame,
  snapshotCapture,
  type DiagCapture,
  type DiagComponent,
  type DiagEntry,
  type DiagnosticsSink,
  type DiagRecord,
} from "../../src/shared/diagnostics.js";
import type { DiagFileHandle, DiagFs } from "../../src/shared/diagnostics-file.js";

export interface RecordingDiagnostics extends DiagnosticsSink {
  readonly entries: DiagEntry[];
  /** 全部の写しを記録にする（検査を通らなかった分は除く）。 */
  records(): DiagRecord[];
  /** 検査を通らなかった件数。 */
  rejected(): number;
}

export function recordingDiagnostics(component: Exclude<DiagComponent, "sink"> = "router", now: () => number = () => Date.now()): RecordingDiagnostics {
  const entries: DiagEntry[] = [];
  let seq = 0;
  const build = (): { records: DiagRecord[]; rejected: number } => {
    const records: DiagRecord[] = [];
    let rejected = 0;
    for (const entry of entries) {
      const record = buildDiagRecord(entry, component);
      if (record === undefined) rejected += 1;
      else records.push(record);
    }
    return { records, rejected };
  };
  return {
    entries,
    emit(capture: DiagCapture): void {
      entries.push({ capture: snapshotCapture(capture).value, scope: currentDiagnosticScopeFrame(), at: now(), seq: seq++ });
    },
    records: () => build().records,
    rejected: () => build().rejected,
  };
}

export function throwingDiagnostics(): DiagnosticsSink & { calls: number } {
  const sink = {
    calls: 0,
    emit(): void {
      sink.calls += 1;
      throw new Error("diagnostics sink failure (test)");
    },
  };
  return sink;
}

export function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code} (test)`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

export interface MemoryDiagFs {
  readonly fs: DiagFs;
  /** path → 中身（UTF-8）。 */
  readonly files: Map<string, string>;
  /** path → 作ったときの mode。 */
  readonly modes: Map<string, number>;
  readonly dirs: Map<string, number>;
  readonly calls: string[];
  /** 次の開くを失敗させる（`undefined` で戻す）。 */
  openError: NodeJS.ErrnoException | undefined;
  /** 書くを失敗させる。 */
  writeError: NodeJS.ErrnoException | undefined;
  renameError: NodeJS.ErrnoException | undefined;
  /** 書くの前に待つ（遅い fs）。 */
  writeDelay: (() => Promise<void>) | undefined;
  /** 書くを永遠に止める。 */
  hang: boolean;
  /** 1 回の書くで書けるバイト数の上限（途中までの書き込み）。 */
  partialWrite: number | undefined;
  lines(file: string): string[];
}

export function memoryDiagFs(): MemoryDiagFs {
  const self: MemoryDiagFs = {
    files: new Map(),
    modes: new Map(),
    dirs: new Map(),
    calls: [],
    openError: undefined,
    writeError: undefined,
    renameError: undefined,
    writeDelay: undefined,
    hang: false,
    partialWrite: undefined,
    lines(file) {
      const text = self.files.get(file) ?? "";
      return text === "" ? [] : text.replace(/\n$/, "").split("\n");
    },
    fs: {
      async mkdir(dir, mode) {
        self.calls.push(`mkdir ${dir}`);
        if (!self.dirs.has(dir)) self.dirs.set(dir, mode);
      },
      async open(file, mode): Promise<DiagFileHandle> {
        self.calls.push(`open ${file}`);
        if (self.openError !== undefined) throw self.openError;
        if (!self.files.has(file)) {
          self.files.set(file, "");
          self.modes.set(file, mode);
        }
        let closed = false;
        return {
          async write(data) {
            if (closed) throw new Error("closed handle (test)");
            if (self.hang) await new Promise<never>(() => {});
            if (self.writeDelay !== undefined) await self.writeDelay();
            if (self.writeError !== undefined) throw self.writeError;
            const n = self.partialWrite === undefined ? data.byteLength : Math.min(self.partialWrite, data.byteLength);
            self.files.set(file, (self.files.get(file) ?? "") + Buffer.from(data.subarray(0, n)).toString("utf8"));
            return n;
          },
          async size() {
            return Buffer.byteLength(self.files.get(file) ?? "", "utf8");
          },
          async close() {
            closed = true;
          },
        };
      },
      async rename(from, to) {
        self.calls.push(`rename ${from} ${to}`);
        if (self.renameError !== undefined) throw self.renameError;
        self.files.set(to, self.files.get(from) ?? "");
        self.files.delete(from);
        const mode = self.modes.get(from);
        if (mode !== undefined) self.modes.set(to, mode);
        self.modes.delete(from);
      },
    },
  };
  return self;
}

/** 後回しの処理を手で回す予約（`defer` の差し替え）。 */
export function manualDefer(): { defer: (fn: () => void) => void; queue: Array<() => void>; runOne(): boolean; runAll(max?: number): number } {
  const queue: Array<() => void> = [];
  return {
    queue,
    defer: (fn) => {
      queue.push(fn);
    },
    runOne() {
      const fn = queue.shift();
      if (fn === undefined) return false;
      fn();
      return true;
    },
    runAll(max = 100_000) {
      let n = 0;
      while (n < max && queue.length > 0) {
        queue.shift()!();
        n += 1;
      }
      return n;
    },
  };
}
