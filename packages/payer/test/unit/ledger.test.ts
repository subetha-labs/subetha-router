/**
 * P-1b（設計 §3.4 の台帳）: hash 連鎖、途中の改変、途切れた末尾の切り詰め、sealed、head の巻き戻り、fsync の失敗、version。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { realFs, type StoreFs } from "../../src/store/fs.js";
import { canonicalJson, GENESIS_HASH, openLedger, rowHash } from "../../src/store/ledger.js";

const LEK = Buffer.alloc(32, 3);
const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});
function fresh(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "payer-ledger-"));
  temps.push(dir);
  return path.join(dir, "ledger.ndjson");
}

describe("ledger", () => {
  test("canonicalJson sorts keys at every level; rowHash chains prev", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 0, y: null }], c: "x" } })).toBe('{"a":{"c":"x","d":[1,{"y":null,"z":0}]},"b":1}');
    const h1 = rowHash({ v: 1, seq: 1, prev: GENESIS_HASH, ts: 1, ref: "p_abcdefghijk", state: "quoted", data: { a: 1 } });
    const h2 = rowHash({ v: 1, seq: 1, prev: "1".repeat(64), ts: 1, ref: "p_abcdefghijk", state: "quoted", data: { a: 1 } });
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("append writes a chained row with fsync; reopening verifies the chain; sealed fields are encrypted and opened with the lek", () => {
    const file = fresh();
    const ledger = openLedger(file, LEK, realFs);
    expect(ledger.rows).toEqual([]);
    expect(ledger.head).toBe(GENESIS_HASH);
    const r1 = ledger.append({ ref: "p_abcdefghijk", state: "quoted", data: { amount: "10000" }, sealedPlain: Buffer.from("credential-secret"), ts: 1 });
    const r2 = ledger.append({ ref: "p_abcdefghijk", state: "approved", data: { hash: "x" }, ts: 2 });
    expect(r1.seq).toBe(1);
    expect(r2.prev).toBe(r1.hash);
    expect(ledger.head).toBe(r2.hash);
    const text = readFileSync(file, "utf8");
    expect(text.split("\n").filter((l) => l !== "").length).toBe(2);
    expect(text).not.toContain("credential-secret");
    expect(text).not.toContain(Buffer.from("credential-secret").toString("base64"));
    ledger.close();
    const reopened = openLedger(file, LEK, realFs);
    expect(reopened.rows.map((r) => r.state)).toEqual(["quoted", "approved"]);
    expect(reopened.openSealed(reopened.rows[0]!)!.toString()).toBe("credential-secret");
    expect(reopened.openSealed(reopened.rows[1]!)).toBeUndefined();
    expect(() => openLedger(file, Buffer.alloc(32, 4), realFs).openSealed(reopened.rows[0]!)).toThrow(/seal_mismatch/);
    reopened.close();
  });

  test("a modified byte in the middle is store_corrupt; a torn tail is truncated and appending continues", () => {
    const file = fresh();
    const ledger = openLedger(file, LEK, realFs);
    ledger.append({ ref: "p_abcdefghijk", state: "quoted", data: { n: 1 }, ts: 1 });
    ledger.append({ ref: "p_abcdefghijk", state: "approved", data: { n: 2 }, ts: 2 });
    ledger.close();
    const good = readFileSync(file, "utf8");
    // 途中の改変（1 行目の data）。
    writeFileSync(file, good.replace('"n":1', '"n":9'));
    expect(() => openLedger(file, LEK, realFs)).toThrow(/store_corrupt/);
    // 途切れた末尾（3 行目の書きかけ）。
    writeFileSync(file, `${good}{"v":1,"seq":3,"prev":"x","ts":3,"ref":"p_abcdefghijk","state":"sign_int`);
    const reopened = openLedger(file, LEK, realFs);
    expect(reopened.rows.length).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(good);
    const r3 = reopened.append({ ref: "p_abcdefghijk", state: "sign_intent", data: {}, ts: 3 });
    expect(r3.seq).toBe(3);
    expect(r3.prev).toBe(reopened.rows[1]!.hash);
    reopened.close();
    const again = openLedger(file, LEK, realFs);
    expect(again.rows.length).toBe(3);
    again.close();
  });

  test("rollback detection: if the file's last row no longer matches the in-memory head, append refuses with store_rollback", () => {
    const file = fresh();
    const ledger = openLedger(file, LEK, realFs);
    ledger.append({ ref: "p_abcdefghijk", state: "quoted", data: {}, ts: 1 });
    const snapshot = readFileSync(file, "utf8");
    ledger.append({ ref: "p_abcdefghijk", state: "approved", data: {}, ts: 2 });
    writeFileSync(file, snapshot); // 複製の差し戻し／別 process の巻き戻し
    expect(() => ledger.append({ ref: "p_abcdefghijk", state: "sign_intent", data: {}, ts: 3 })).toThrow(/store_rollback/);
    ledger.close();
  });

  test("fsync failure (EIO) marks the row as not written and refuses every later append", () => {
    const file = fresh();
    let failNext = false;
    const flaky: StoreFs = { ...realFs, fsyncSync: (fd) => { if (failNext) { failNext = false; const e = new Error("EIO") as NodeJS.ErrnoException; e.code = "EIO"; throw e; } realFs.fsyncSync(fd); } };
    const ledger = openLedger(file, LEK, flaky);
    ledger.append({ ref: "p_abcdefghijk", state: "quoted", data: {}, ts: 1 });
    failNext = true;
    expect(() => ledger.append({ ref: "p_abcdefghijk", state: "approved", data: {}, ts: 2 })).toThrow(/store_write_failed/);
    expect(ledger.writeFailed).toBe(true);
    expect(() => ledger.append({ ref: "p_abcdefghijk", state: "approved", data: {}, ts: 3 })).toThrow(/store_write_failed/);
    expect(ledger.rows.length).toBe(1);
    ledger.close();
  });

  test("an unsupported row version refuses to open; a read-only file system refuses before any side effect", () => {
    const file = fresh();
    writeFileSync(file, `${JSON.stringify({ v: 2, seq: 1, prev: GENESIS_HASH, ts: 1, ref: "p_abcdefghijk", state: "quoted", data: {}, hash: "x" })}\n`);
    expect(() => openLedger(file, LEK, realFs)).toThrow(/store_unsupported_version/);
    const erofs: StoreFs = { ...realFs, openSync: () => { const e = new Error("EROFS") as NodeJS.ErrnoException; e.code = "EROFS"; throw e; } };
    expect(() => openLedger(fresh(), LEK, erofs)).toThrow(/EROFS/);
  });
});
