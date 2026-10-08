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
  if (typeof r["seq"] !== "number" || typeof r["prev"] !== "string" || typeof r["ts"] !== "number" || typeof r["ref"] !== "string" || typeof r["state"] !== "string" || typeof r["hash"] !== "string") return undefined;
  return r as unknown as LedgerRow;
}

/**
 * 台帳を開く: 先頭から hash を検証し、最後の完全な行までを採用。末尾の途切れた行は切り詰める（fsync）。途中の破損は `store_corrupt`。
 */
export function openLedger(path: string, lek: Buffer, fs: StoreFs): Ledger {
  const rows: LedgerRow[] = [];
  let head = GENESIS_HASH;
  let keepBytes = 0;
  let total = 0;
  if (fs.existsSync(path)) {
    const buffer = fs.readFileSync(path);
    total = buffer.length;
    let offset = 0;
    while (offset < buffer.length) {
      const nl = buffer.indexOf(0x0a, offset);
      if (nl === -1) break; // 途切れた末尾（改行で閉じていない）
      const line = buffer.subarray(offset, nl).toString("utf8");
      const row = parseRow(line);
      if (row === undefined) {
        // 閉じているのに読めない行: 最後の行なら途切れ、途中なら破損。
        if (nl === buffer.length - 1) break;
        throw new StoreError("store_corrupt");
      }
      const expected = rowHash({ v: row.v, seq: row.seq, prev: row.prev, ts: row.ts, ref: row.ref, state: row.state, data: row.data, ...(row.sealed === undefined ? {} : { sealed: row.sealed }) });
      if (row.prev !== head || row.hash !== expected || row.seq !== rows.length + 1) {
        if (nl === buffer.length - 1) break; // 最後の行だけが合わない = 途切れ扱い（書きかけ）
        throw new StoreError("store_corrupt");
      }
      rows.push(row);
      head = row.hash;
      offset = nl + 1;
      keepBytes = offset;
    }
  }
  const fd = fs.openSync(path, "a", 0o600);
  if (keepBytes < total) {
    fs.ftruncateSync(fd, keepBytes);
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
      // head の検査: file の最後の完全な行の hash がメモリの head と違えば巻き戻り（別 process の書き込み・複製の差し戻し）。
      const current = fs.readFileSync(path);
      const tailHash = lastHashOf(current);
      if (tailHash !== head) throw new StoreError("store_rollback");
      const sealed = input.sealedPlain === undefined ? undefined : seal(lek, input.sealedPlain, `${input.ref}:${input.state}`);
      const partial = { v: LEDGER_VERSION, seq: rows.length + 1, prev: head, ts: input.ts ?? Date.now(), ref: input.ref, state: input.state, data: input.data, ...(sealed === undefined ? {} : { sealed }) };
      const row: LedgerRow = { ...partial, hash: rowHash(partial) };
      const line = Buffer.from(`${JSON.stringify(row)}\n`, "utf8");
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } catch {
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

/** file の最後の完全な行の hash（無ければ genesis）。append の head の検査に使う。 */
function lastHashOf(buffer: Buffer): string {
  let end = buffer.length;
  if (end === 0) return GENESIS_HASH;
  if (buffer[end - 1] !== 0x0a) {
    const nl = buffer.lastIndexOf(0x0a);
    if (nl === -1) return GENESIS_HASH;
    end = nl + 1;
  }
  const start = buffer.lastIndexOf(0x0a, end - 2) + 1;
  const row = parseRow(buffer.subarray(start, end - 1).toString("utf8"));
  return row === undefined ? GENESIS_HASH : row.hash;
}
