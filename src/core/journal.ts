/**
 * 追記専用 journal（設計 §5）。
 *
 * 実装済み: NDJSON の append + fsync 完了**後**にメモリ表を更新する write-ahead、
 * 単一 mutex による追記の直列化、再オープン時の順序保持 replay と seq 連番/JSON
 * 妥当性検査（違反は byte offset 付きで fail closed・自動切り詰めなし）、常設
 * ロックファイルに対する OS 非ブロッキング排他（`flock(2)` の `LOCK_EX|LOCK_NB`）、
 * close 後および書き込み失敗後に writer を継続させないこと。
 */

import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import fsExt from "fs-ext";

/** journal の 1 行（`{seq, at, paymentId, event, patch}`）。 */
export interface JournalRecord {
  readonly seq: number;
  readonly at: string;
  readonly paymentId: string;
  readonly event: string;
  readonly patch: Readonly<Record<string, unknown>>;
}

/** 追記要求。`seq` と `at` は journal 側が確定する。 */
export interface JournalAppend {
  readonly paymentId: string;
  readonly event: string;
  readonly patch?: Readonly<Record<string, unknown>>;
}

export interface Journal {
  /** replay 済み + 追記済みの記録列（追記順）。 */
  readonly records: readonly JournalRecord[];
  /** 1 行を追記する。append + fsync 完了後にメモリ表を更新する。 */
  append(entry: JournalAppend): Promise<void>;
  /** ロックと fd を解放する。 */
  close(): Promise<void>;
}

export interface OpenJournalOptions {
  /** NDJSON 本体のパス（既定の運用値は `runtime/journal.ndjson`）。 */
  readonly journalPath: string;
  /** 常設ロックファイル。既定は journal と同階層の `journal.lock`。 */
  readonly lockPath?: string;
}

/** 別 writer が既に排他ロックを保持している（起動しない／FR-04 の fail closed）。 */
export class JournalLockedError extends Error {
  readonly code = "journal_locked";
  readonly lockPath: string;

  constructor(lockPath: string, cause: unknown) {
    super(`journal lock held by another writer: ${lockPath}`, { cause });
    this.name = "JournalLockedError";
    this.lockPath = lockPath;
  }
}

export type JournalCorruptReason = "truncated_tail" | "invalid_json" | "invalid_record" | "seq_gap";

/**
 * replay が journal の破損を検出した（起動を中止する）。自動切り詰めも自動補完も
 * せず、運用者が判断できるよう破損位置の byte offset を添える。
 */
export class JournalCorruptError extends Error {
  readonly code = "journal_corrupt";
  readonly reason: JournalCorruptReason;
  readonly byteOffset: number;

  constructor(reason: JournalCorruptReason, byteOffset: number, detail: string) {
    super(`journal corrupt (${reason}) at byte offset ${byteOffset}: ${detail}`);
    this.name = "JournalCorruptError";
    this.reason = reason;
    this.byteOffset = byteOffset;
  }
}

/** 追記要求が `JournalRecord` として成立しない（1 バイトも書いていない）。 */
export class JournalInvalidEntryError extends Error {
  readonly code = "journal_invalid_entry";

  constructor(cause: unknown) {
    super("journal entry rejected before any write", { cause });
    this.name = "JournalInvalidEntryError";
  }
}

/** close 済みの journal に追記しようとした。 */
export class JournalClosedError extends Error {
  readonly code = "journal_closed";

  constructor() {
    super("journal is closed");
    this.name = "JournalClosedError";
  }
}

/** 直前の追記が失敗しており、durable 性を保証できないので writer を継続しない。 */
export class JournalUnusableError extends Error {
  readonly code = "journal_unusable";

  constructor(cause: unknown) {
    super("journal writer stopped after a failed append", { cause });
    this.name = "JournalUnusableError";
  }
}

/** 常設ロックファイルの既定位置（設計 §5 の `runtime/journal.lock`）。 */
function defaultLockPath(journalPath: string): string {
  return path.join(path.dirname(journalPath), "journal.lock");
}

/**
 * 常設ロックファイルを open（無ければ作成、切り詰めない）し、その fd に
 * 非ブロッキング排他ロックをかける。取得できなければ起動しない。
 * ロックファイルは**削除しない**——異常終了で残ったファイルが恒久的な偽の排他に
 * なる `O_EXCL` 方式を避けるため、解放は fd のクローズ（プロセス終了を含む）で行う。
 */
async function acquireLock(lockPath: string): Promise<FileHandle> {
  const handle = await open(lockPath, "a");
  try {
    fsExt.flockSync(handle.fd, "exnb");
  } catch (error) {
    await handle.close();
    const code = (error as { code?: unknown }).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EACCES") {
      throw new JournalLockedError(lockPath, error);
    }
    throw error;
  }
  return handle;
}

/**
 * 親ディレクトリを fsync し、新規作成したファイル名（ディレクトリエントリ）を
 * 永続化する。ファイル本体の fsync だけでは名前が残る保証がない。
 */
async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

const NEWLINE = 0x0a;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 保持する記録は凍結し、呼び出し側の参照経由で書き換えられないようにする。 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

/**
 * 1 行を `JournalRecord` として検証する。形が満たせない行は replay で
 * fail closed にする（`{seq:1}` のような部分的な行を記録として受け入れない）。
 */
function validateRecord(value: unknown, byteOffset: number): JournalRecord {
  if (!isPlainObject(value)) {
    throw new JournalCorruptError("invalid_record", byteOffset, "line is not a JSON object");
  }

  const { seq, at, paymentId, event, patch } = value;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw new JournalCorruptError("invalid_record", byteOffset, "seq must be a positive integer");
  }
  if (typeof at !== "string" || at === "") {
    throw new JournalCorruptError("invalid_record", byteOffset, "at must be a non-empty string");
  }
  if (typeof paymentId !== "string" || paymentId === "") {
    throw new JournalCorruptError("invalid_record", byteOffset, "paymentId must be a non-empty string");
  }
  if (typeof event !== "string" || event === "") {
    throw new JournalCorruptError("invalid_record", byteOffset, "event must be a non-empty string");
  }
  if (!isPlainObject(patch)) {
    throw new JournalCorruptError("invalid_record", byteOffset, "patch must be a JSON object");
  }

  return deepFreeze({ seq, at, paymentId, event, patch });
}

/**
 * 既存行を replay する。各行の JSON 妥当性と `seq` の 1 始まり連番を検査し、
 * 末尾行に改行がなければ「未適用の書き込み」として fail closed にする。
 * いずれの場合もファイルには手を触れない。
 */
function replay(buffer: Buffer): JournalRecord[] {
  const records: JournalRecord[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const newline = buffer.indexOf(NEWLINE, offset);
    if (newline === -1) {
      throw new JournalCorruptError("truncated_tail", offset, "last line has no terminating newline");
    }

    const line = buffer.toString("utf8", offset, newline);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new JournalCorruptError("invalid_json", offset, (error as Error).message);
    }

    const record = validateRecord(parsed, offset);
    const expectedSeq = records.length + 1;
    if (record.seq !== expectedSeq) {
      throw new JournalCorruptError(
        "seq_gap",
        offset,
        `expected seq ${expectedSeq}, found ${JSON.stringify(record.seq)}`,
      );
    }

    records.push(record);
    offset = newline + 1;
  }

  return records;
}

class FileJournal implements Journal {
  readonly #handle: FileHandle;
  readonly #lock: FileHandle;
  readonly #records: JournalRecord[];
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #failure: unknown;

  constructor(handle: FileHandle, lock: FileHandle, records: JournalRecord[]) {
    this.#handle = handle;
    this.#lock = lock;
    this.#records = records;
  }

  get records(): readonly JournalRecord[] {
    // 内部表そのものは渡さない（呼び出し側の操作が durable 判断を汚さないように）。
    return [...this.#records];
  }

  /** 追記は単一 mutex で直列化する（seq の確定と書き込み順序を一致させる）。 */
  append(entry: JournalAppend): Promise<void> {
    const appended = this.#queue.then(() => this.#appendLocked(entry));
    this.#queue = appended.then(
      () => undefined,
      () => undefined,
    );
    return appended;
  }

  async #appendLocked(entry: JournalAppend): Promise<void> {
    if (this.#closed) {
      throw new JournalClosedError();
    }
    if (this.#failure !== undefined) {
      throw new JournalUnusableError(this.#failure);
    }

    // 呼び出し側の patch を保持せず、実際に書くバイト列だけを記録の出所にする。
    // 書く前に serialize → parse → validate → freeze まで済ませ、成立しない要求は
    // 1 バイトも書かずに拒否する（不正行を永続化してから拒否しない）。
    let line: string;
    let record: JournalRecord;
    try {
      line = `${JSON.stringify({
        seq: this.#records.length + 1,
        at: new Date().toISOString(),
        paymentId: entry.paymentId,
        event: entry.event,
        patch: entry.patch ?? {},
      })}\n`;
      record = validateRecord(JSON.parse(line), 0);
    } catch (error) {
      throw new JournalInvalidEntryError(error);
    }

    try {
      // write-ahead: 先に append し、fsync が返ってからメモリ表を更新する。
      await this.#handle.appendFile(line, "utf8");
      await this.#handle.sync();
    } catch (error) {
      // 書き込みが途中で終わった可能性を排除できないので writer を継続しない。
      this.#failure = error;
      throw error;
    }

    // fsync が返ってから、書いたバイト列と同一の検証済み記録だけを publish する。
    this.#records.push(record);
  }

  async close(): Promise<void> {
    const closing = this.#queue.then(() => {
      this.#closed = true;
    });
    this.#queue = closing;
    await closing;

    try {
      await this.#handle.close();
    } finally {
      // fd のクローズでロックが解放される。ロックファイル自体は unlink しない。
      await this.#lock.close();
    }
  }
}

/** journal を開き、既存行を replay して書き込み可能なハンドルを返す。 */
export async function openJournal(options: OpenJournalOptions): Promise<Journal> {
  const lock = await acquireLock(options.lockPath ?? defaultLockPath(options.journalPath));
  let handle: FileHandle | undefined;
  try {
    handle = await open(options.journalPath, "a+");
    // 成功を返す前に、作成したファイル名を親ディレクトリ側にも永続化する。
    // ここが失敗した open は成功扱いにせず、保持したロックも解放する。
    await syncDirectory(path.dirname(options.journalPath));
    const existing = await handle.readFile();
    return new FileJournal(handle, lock, replay(existing));
  } catch (error) {
    await handle?.close();
    await lock.close();
    throw error;
  }
}
