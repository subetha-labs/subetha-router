/**
 * 秘匿購入の容量（`docs/zktls-router-design.md` §3.7、要件 FR-Z12・FR-Z27）: 受信 verify の**前**に、セッションの枠・作業ディレクトリ・保持成果物の量を
 * **不可分に**予約し、義務は成果物を消すまで保つ。判定はプロセス内の 1 つの状態で同期的に行う。再起動時は再構成（`open`）が済むまで `reserve` は失敗する。
 */

import { mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

export interface CapacityLimits {
  readonly maxConcurrentSessions: number;
  readonly maxRetainedPurchases: number;
  readonly maxRetainedBytes: number;
  /** 1 購入が占め得る上限（record + bundle + verify_result + 子出力 ×4 + 最終注文 + intent/release/addr/pid）。 */
  readonly purchaseAllowance: number;
  readonly maxConcurrentVerifications: number;
  readonly maxQueuedVerifications: number;
}

export interface CapacityLease {
  readonly paymentId: string;
  readonly dir: string;
  /** settle 前の失敗・未発行の終端: ディレクトリを消し、枠・件数・量を全部返す。 */
  release(): void;
  /** セッションの終わり: **セッション枠だけ**を返す（保存の予約は保つ）。 */
  sessionEnded(): void;
  /**
   * attest の完了・期限切れ・取得専用の record の確定: record 以外の全ファイルを削除した**後にだけ**予約を record の実測に縮める。
   * 掃除に失敗したら予約は縮めない（`false`）。record が無ければ量と件数を全部返す。
   */
  attestSettled(): boolean;
  /** record の期限切れ・削除: 残りの量と件数を返す（ディレクトリも消す）。 */
  retire(): void;
}

export interface VerificationSlot {
  release(): void;
}

export const RECORD_FILE = "record.json";

/** 購入ディレクトリの record 以外のファイルを消す。1 つでも消せなければ `false`。 */
export function deleteNonRecordFiles(dir: string): boolean {
  let ok = true;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name === RECORD_FILE) continue;
    try {
      rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      ok = false;
    }
  }
  return ok;
}

export function recordBytesOf(dir: string): number | undefined {
  try {
    return statSync(path.join(dir, RECORD_FILE)).size;
  } catch {
    return undefined;
  }
}

export class PrivateCapacity {
  readonly #limits: CapacityLimits;
  readonly #workDir: string;
  #opened = false;
  #activeSessions = 0;
  #committedPurchases = 0;
  #committedBytes = 0;
  readonly #leases = new Map<string, { bytes: number; session: boolean }>();
  #runningVerifications = 0;
  readonly #queue: Array<{ readonly start: () => void; readonly cancel: (error: Error) => void }> = [];
  #closing = false;

  constructor(limits: CapacityLimits, workDir: string) {
    this.#limits = limits;
    this.#workDir = workDir;
  }

  get workDir(): string {
    return this.#workDir;
  }

  /** 再構成（§3.6 5）の後に開く: 残った record のバイト数と件数を義務として載せる。 */
  open(retained: { readonly purchases: number; readonly bytes: number }): void {
    this.#committedPurchases = retained.purchases;
    this.#committedBytes = retained.bytes;
    this.#opened = true;
  }

  get opened(): boolean {
    return this.#opened;
  }

  /** 試験と診断のための現在値。 */
  snapshot(): { activeSessions: number; committedPurchases: number; committedBytes: number; runningVerifications: number; queuedVerifications: number } {
    return { activeSessions: this.#activeSessions, committedPurchases: this.#committedPurchases, committedBytes: this.#committedBytes, runningVerifications: this.#runningVerifications, queuedVerifications: this.#queue.length };
  }

  /** 不等式を全部満たすときだけ、ディレクトリを作って予約する（同期）。 */
  reserve(paymentId: string): CapacityLease | undefined {
    if (!this.#opened || this.#closing) return undefined;
    const allowance = this.#limits.purchaseAllowance;
    if (this.#activeSessions + 1 > this.#limits.maxConcurrentSessions) return undefined;
    if (this.#committedPurchases + 1 > this.#limits.maxRetainedPurchases) return undefined;
    if (this.#committedBytes + allowance > this.#limits.maxRetainedBytes) return undefined;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(paymentId) || this.#leases.has(paymentId)) return undefined;
    const dir = path.join(this.#workDir, paymentId);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      return undefined;
    }
    this.#activeSessions += 1;
    this.#committedPurchases += 1;
    this.#committedBytes += allowance;
    const state = { bytes: allowance, session: true };
    this.#leases.set(paymentId, state);
    const endSession = (): void => {
      if (state.session) {
        state.session = false;
        this.#activeSessions -= 1;
      }
    };
    const returnAll = (): void => {
      endSession();
      if (this.#leases.delete(paymentId)) {
        this.#committedPurchases -= 1;
        this.#committedBytes -= state.bytes;
        state.bytes = 0;
      }
    };
    return {
      paymentId,
      dir,
      release: () => {
        rmSync(dir, { recursive: true, force: true });
        returnAll();
      },
      sessionEnded: endSession,
      attestSettled: () => {
        endSession();
        if (!deleteNonRecordFiles(dir)) return false;
        const record = recordBytesOf(dir);
        if (record === undefined) {
          rmSync(dir, { recursive: true, force: true });
          returnAll();
          return true;
        }
        if (this.#leases.has(paymentId)) {
          this.#committedBytes += record - state.bytes;
          state.bytes = record;
        }
        return true;
      },
      retire: () => {
        rmSync(dir, { recursive: true, force: true });
        returnAll();
      },
    };
  }

  /** 再構成で見つかった保持中の record（終端の購入）を義務に載せ直し、`retire` できる lease を返す。 */
  adoptRetained(paymentId: string, bytes: number): CapacityLease {
    const dir = path.join(this.#workDir, paymentId);
    const state = { bytes, session: false };
    this.#leases.set(paymentId, state);
    const returnAll = (): void => {
      if (this.#leases.delete(paymentId)) {
        this.#committedPurchases -= 1;
        this.#committedBytes -= state.bytes;
        state.bytes = 0;
      }
    };
    return {
      paymentId,
      dir,
      release: returnAll,
      sessionEnded: () => {},
      attestSettled: () => true,
      retire: () => {
        rmSync(dir, { recursive: true, force: true });
        returnAll();
      },
    };
  }

  /** 検証ジョブの枠: 実行中が上限未満ならすぐ、待ち行列に空きがあれば待つ、どちらも無ければ `undefined`。 */
  enqueueVerification(): Promise<VerificationSlot> | undefined {
    const slot = (): VerificationSlot => {
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          this.#runningVerifications -= 1;
          const next = this.#queue.shift();
          if (next !== undefined) {
            this.#runningVerifications += 1;
            next.start();
          }
        },
      };
    };
    if (this.#closing) return undefined;
    if (this.#runningVerifications < this.#limits.maxConcurrentVerifications) {
      this.#runningVerifications += 1;
      return Promise.resolve(slot());
    }
    if (this.#queue.length >= this.#limits.maxQueuedVerifications) return undefined;
    return new Promise<VerificationSlot>((resolve, reject) => {
      this.#queue.push({ start: () => resolve(slot()), cancel: reject });
    });
  }

  /** drain（設計 §3.7 `close`）: 待ち行列のジョブを取り消し、以後の受理を止める。実行中のジョブは呼び出し側が子を止めて待つ。 */
  closeQueue(): void {
    this.#closing = true;
    for (const waiter of this.#queue.splice(0)) waiter.cancel(new Error("private capacity is closing"));
  }

  get closing(): boolean {
    return this.#closing;
  }
}

/** 記録・レール・子出力の上限から 1 購入の許容量を決める（設計 §3.7）。 */
export function purchaseAllowanceOf(limits: { readonly maxRecordBytes: number; readonly maxBundleBytes: number; readonly maxChildOutputBytes: number }): number {
  const verifyResult = 64 * 1024;
  const finalOrder = 8 * 1024;
  const misc = 8 * 1024;
  return limits.maxRecordBytes + limits.maxBundleBytes + verifyResult + 4 * limits.maxChildOutputBytes + finalOrder + misc;
}

/** 試験のための補助: ディレクトリ内の pid・門などの一時ファイルを数える。 */
export function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export { unlinkSync as _unlinkSyncForTest };
