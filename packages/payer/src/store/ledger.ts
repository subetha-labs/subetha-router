/**
 * 台帳（設計 §3.4、要件 FR-A19〜A21・SR-A3）。append-only の ndjson、hash 連鎖、封印した欄、fsync、途切れた末尾の切り詰め、head の巻き戻りの検知、version。
 *
 * 1 行 = `{ v: 1, seq, prev, ts, ref, state, data, sealed?, hash }`。`hash = sha256(prev ‖ canonical({ v, seq, ts, ref, state, data, sealed }))`。
 * 書き込みは「行を書いて fsync してから次へ」。fsync が失敗したら `store_write_failed` で以後の append を拒む（再起動で再検査）。
 * 同じ利用者による再起動をまたぐ書き換えは検知しない（要件 T4′ の残る危険）。
 */

import { createHash } from "node:crypto";

import { StoreError, type StoreFs } from "./fs.js";
import { open, seal, type SealedBox } from "./keys.js";

export const LEDGER_VERSION = 1;
export const GENESIS_HASH = "0".repeat(64);

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** JSON の**データ**だけ（有限の数、plain な object、深さ 64）。NaN や Date を黙って null や文字列にしない。 */
export function isPlainJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.keys(value as object).every((key) => key !== "__proto__" && key !== "toJSON" && isPlainJson((value as Record<string, unknown>)[key], depth + 1));
  }
  return false;
}

/** 全バイトを書く（`writeSync` は短い書き込みを返し得る）。 */
function writeAll(fs: StoreFs, fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fd, data.subarray(offset));
    if (written <= 0) throw new StoreError("store_write_failed");
    offset += written;
  }
}

export interface LedgerRow {
  readonly v: number;
  readonly seq: number;
  readonly prev: string;
  readonly ts: number;
  readonly ref: string;
  readonly state: string;
  readonly data: JsonValue;
  readonly sealed?: SealedBox;
  readonly hash: string;
}

/** 鍵の順を固定した JSON（hash の入力）。 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k]!)}`).join(",")}}`;
}

export function rowHash(row: Omit<LedgerRow, "hash">): string {
  const body: JsonValue = { v: row.v, seq: row.seq, ts: row.ts, ref: row.ref, state: row.state, data: row.data, ...(row.sealed === undefined ? {} : { sealed: { ...row.sealed } }) };
  return createHash("sha256").update(row.prev).update(canonicalJson(body)).digest("hex");
}

export interface Ledger {
  readonly rows: readonly LedgerRow[];
  readonly head: string;
  /** 行を追加して fsync する。`sealedPlain` は `lek` で封印する（AAD は ref と state）。 */
  append(input: { readonly ref: string; readonly state: string; readonly data: JsonValue; readonly sealedPlain?: Buffer; readonly ts?: number }): LedgerRow;
  /** 封印した欄を開く。 */
  openSealed(row: LedgerRow): Buffer | undefined;
  readonly writeFailed: boolean;
  close(): void;
}

function parseRow(line: string): LedgerRow | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const r = parsed as Record<string, unknown>;
  if (r["v"] !== LEDGER_VERSION) throw new StoreError("store_unsupported_version");
  if (typeof r["seq"] !== "number" || !Number.isSafeInteger(r["seq"]) || r["seq"] < 1) return undefined;
  if (typeof r["prev"] !== "string" || !/^[0-9a-f]{64}$/.test(r["prev"])) return undefined;
  if (typeof r["ts"] !== "number" || !Number.isSafeInteger(r["ts"]) || r["ts"] < 0) return undefined;
  if (typeof r["ref"] !== "string" || typeof r["state"] !== "string" || typeof r["hash"] !== "string" || !/^[0-9a-f]{64}$/.test(r["hash"])) return undefined;
  if (!isPlainJson(r["data"])) return undefined;
  if (r["sealed"] !== undefined) {
    const s = r["sealed"] as Record<string, unknown> | null;
    if (s === null || typeof s !== "object" || s["cipher"] !== "aes-256-gcm" || typeof s["iv"] !== "string" || typeof s["tag"] !== "string" || typeof s["ciphertext"] !== "string") return undefined;
  }
  return r as unknown as LedgerRow;
}

function chains(row: LedgerRow, head: string, seq: number): boolean {
  const expected = rowHash({ v: row.v, seq: row.seq, prev: row.prev, ts: row.ts, ref: row.ref, state: row.state, data: row.data, ...(row.sealed === undefined ? {} : { sealed: row.sealed }) });
  return row.prev === head && row.hash === expected && row.seq === seq;
}

/**
 * 台帳を開く: 先頭から hash を検証する。改行で閉じた行が読めない・繋がらない → `store_corrupt`（最後の行でも。**fail closed**: 完全な記録を黙って捨てない）。
 * 改行で閉じていない末尾は「書きかけ」: 読めて繋がるなら採用して改行を補い、読めなければ切り詰める（fsync）。
 */
export function openLedger(path: string, lek: Buffer, fs: StoreFs): Ledger {
  const rows: LedgerRow[] = [];
  let head = GENESIS_HASH;
  let keepBytes = 0;
  let total = 0;
  let repairNewline = false;
  if (fs.existsSync(path)) {
    const buffer = fs.readFileSync(path);
    total = buffer.length;
    let offset = 0;
    while (offset < buffer.length) {
      const nl = buffer.indexOf(0x0a, offset);
      const terminated = nl !== -1;
      const end = terminated ? nl : buffer.length;
      const row = parseRow(buffer.subarray(offset, end).toString("utf8"));
      const ok = row !== undefined && chains(row, head, rows.length + 1);
      if (!ok) {
        if (terminated) throw new StoreError("store_corrupt");
        break; // 改行の無い読めない末尾 = 書きかけ → 切り詰め
      }
      rows.push(row!);
      head = row!.hash;
      if (!terminated) {
        // 読めて繋がるが改行が無い（改行の直前で落ちた）: 採用して改行を補う。
        keepBytes = end;
        repairNewline = true;
        break;
      }
      offset = nl + 1;
      keepBytes = offset;
    }
  }
  const fd = fs.openSync(path, "a", 0o600);
  if (keepBytes < total) {
    fs.ftruncateSync(fd, keepBytes);
    fs.fsyncSync(fd);
  }
  if (repairNewline) {
    writeAll(fs, fd, Buffer.from("\n", "utf8"));
    fs.fsyncSync(fd);
  }
  let writeFailed = false;
  let closed = false;
  const ledger: Ledger = {
    rows,
    get head() {
      return head;
    },
    get writeFailed() {
      return writeFailed;
    },
    append(input) {
      if (closed) throw new StoreError("store_closed");
      if (writeFailed) throw new StoreError("store_write_failed");
      if (!isPlainJson(input.data)) throw new StoreError("ledger_data_invalid");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.ref) || !/^[a-z_]{1,32}$/.test(input.state)) throw new StoreError("ledger_data_invalid");
      // head の検査: file の最後の完全な行を**中身まで検証して**、メモリの head と違えば巻き戻り（別 process の書き込み・複製の差し戻し）。
      const current = fs.readFileSync(path);
      if (lastRowHashOf(current, rows.length === 0 ? GENESIS_HASH : rows[rows.length - 2]?.hash ?? GENESIS_HASH, rows.length) !== head) throw new StoreError("store_rollback");
      const sealed = input.sealedPlain === undefined ? undefined : seal(lek, input.sealedPlain, `${input.ref}:${input.state}`);
      const partial = { v: LEDGER_VERSION, seq: rows.length + 1, prev: head, ts: input.ts ?? Date.now(), ref: input.ref, state: input.state, data: input.data, ...(sealed === undefined ? {} : { sealed }) };
      const row: LedgerRow = { ...partial, hash: rowHash(partial) };
      const line = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
      try {
        writeAll(fs, fd, line);
        fs.fsyncSync(fd);
      } catch {
        // 書けたかどうか分からない（短い write・fsync の失敗）。durable かは不明なので、以後の副作用を止める。
        writeFailed = true;
        throw new StoreError("store_write_failed");
      }
      rows.push(row);
      head = row.hash;
      return row;
    },
    openSealed(row) {
      return row.sealed === undefined ? undefined : open(lek, row.sealed, `${row.ref}:${row.state}`);
    },
    close() {
      if (!closed) {
        closed = true;
        fs.closeSync(fd);
      }
    },
  };
  return ledger;
}

/**
 * file の最後の完全な行の hash（無ければ genesis）。**中身を再計算して**検証する（保存された hash を信じない）。
 * 末尾に改行の無い書きかけがあれば巻き戻りとみなす（自分の append は常に改行で閉じる）。
 */
function lastRowHashOf(buffer: Buffer, expectedPrev: string, expectedSeq: number): string {
  if (buffer.length === 0) return GENESIS_HASH;
  if (buffer[buffer.length - 1] !== 0x0a) return "partial";
  const end = buffer.length;
  const start = buffer.lastIndexOf(0x0a, end - 2) + 1;
  const row = parseRow(buffer.subarray(start, end - 1).toString("utf8"));
  if (row === undefined || !chains(row, expectedPrev, expectedSeq)) return "invalid";
  return row.hash;
}
