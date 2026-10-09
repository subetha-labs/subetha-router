/**
 * P-1b（設計 §3.4 の台帳）: hash 連鎖、途中・末尾の改変（fail closed）、改行の無い末尾（読めれば採用、読めなければ切り詰め）、sealed、head の巻き戻り、
 * 短い write と fsync の失敗、version、seq の飛び、close 後の append、データの検証。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { realFs, type StoreFs } from "../../src/store/fs.js";
import { canonicalJson, GENESIS_HASH, isPlainJson, openLedger, rowHash, type JsonValue, type Ledger } from "../../src/store/ledger.js";

const LEK = Buffer.alloc(32, 3);
const REF = "p_abcdefghijk";
const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});
function fresh(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "payer-ledger-"));
  temps.push(dir);
  return path.join(dir, "ledger.ndjson");
}
function twoRows(file: string): string {
  const ledger = openLedger(file, LEK, realFs);
  ledger.append({ ref: REF, state: "quoted", data: { n: 1 }, ts: 1 });
  ledger.append({ ref: REF, state: "approved", data: { n: 2 }, ts: 2 });
  ledger.close();
  return readFileSync(file, "utf8");
}

// Each rejected input must leave an existing durable chain usable, including after reopen.
function rejectsWithoutChange(input: Parameters<Ledger["append"]>[0]): void {
  const file = fresh();
  const ledger = openLedger(file, LEK, realFs);
  try {
    ledger.append({ ref: REF, state: "quoted", data: { n: 1 }, ts: 0 });
    const before = readFileSync(file);
    const head = ledger.head;
    expect.soft(() => ledger.append(input)).toThrow(/ledger_data_invalid/);
    expect.soft(readFileSync(file)).toEqual(before);
    expect.soft(ledger.head).toBe(head);
    expect.soft(ledger.rows.length).toBe(1);
    expect.soft(ledger.writeFailed).toBe(false);
    ledger.append({ ref: REF, state: "approved", data: { n: 2 }, ts: 2 });
  } finally {
    ledger.close();
  }
  const reopened = openLedger(file, LEK, realFs);
  try {
    expect(reopened.rows.map((row) => row.data)).toEqual([{ n: 1 }, { n: 2 }]);
  } finally {
    reopened.close();
  }
}

describe("ledger", () => {
  test.each([false, true])("rejects non-enumerable object toJSON (nested in array: %s)", (nested) => {
    const object = Object.defineProperty({ n: 1 }, "toJSON", { value: () => ({ n: 2 }) });
    const data = nested ? [object] : object;
    expect.soft(isPlainJson(data)).toBe(false);
    rejectsWithoutChange({ ref: REF, state: "quoted", data, ts: 1 });
  });

  test.each([false, true])("rejects inherited object toJSON regardless of enumerability (%s), including in an array", (enumerable) => {
    const file = fresh();
    const ledger = openLedger(file, LEK, realFs);
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    let calls = 0;
    try {
      ledger.append({ ref: REF, state: "quoted", data: {}, ts: 0 });
      const before = readFileSync(file);
      const head = ledger.head;
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, enumerable, value: () => { calls++; return { changed: true }; } });
      // Ordinary objects still have Object.prototype; a custom prototype would
      // already be rejected and would not discriminate this regression.
      let plainObject: boolean;
      let plainArray: boolean;
      let error: unknown;
      try {
        plainObject = isPlainJson({ n: 1 });
        plainArray = isPlainJson([{ n: 1 }]);
        try { ledger.append({ ref: REF, state: "approved", data: { n: 1 }, ts: 1 }); } catch (caught) { error = caught; }
      } finally {
        if (previous === undefined) Reflect.deleteProperty(Object.prototype, "toJSON");
        else Object.defineProperty(Object.prototype, "toJSON", previous);
      }
      expect.soft(plainObject).toBe(false);
      expect.soft(plainArray).toBe(false);
      expect.soft(error).toMatchObject({ code: "ledger_data_invalid" });
      expect.soft(calls).toBe(0);
      expect.soft(readFileSync(file)).toEqual(before);
      expect.soft(ledger.head).toBe(head);
      expect.soft(ledger.rows.length).toBe(1);
      expect.soft(ledger.writeFailed).toBe(false);
      ledger.append({ ref: REF, state: "approved", data: [{ n: 2 }], ts: 2 });
    } finally {
      ledger.close();
    }
    const reopened = openLedger(file, LEK, realFs);
    try { expect(reopened.rows.map((row) => row.data)).toEqual([{}, [{ n: 2 }]]); } finally { reopened.close(); }
  });

  test.each(["object", "hidden object", "object in array", "array index", "setter only"])("rejects accessor data without executing it: %s", (kind) => {
    let reads = 0;
    const descriptor = kind === "setter only"
      ? { enumerable: true, set: (_value: unknown) => { reads++; } }
      : { enumerable: kind !== "hidden object", get: () => ++reads };
    const object = Object.defineProperty({}, "n", descriptor);
    const data = kind === "array index" ? Object.defineProperty([0], "0", descriptor) : kind === "object in array" ? [object] : object;
    expect.soft(isPlainJson(data)).toBe(false);
    rejectsWithoutChange({ ref: REF, state: "quoted", data, ts: 1 });
    expect(reads).toBe(0);
  });

  test.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects timestamp %s without changing bytes/head", (ts) => {
    rejectsWithoutChange({ ref: REF, state: "quoted", data: {}, ts });
  });

  test.each([
    { ref: 123, state: "quoted" },
    { ref: null, state: "quoted" },
    { ref: [REF], state: "quoted" },
    { ref: REF, state: true },
    { ref: REF, state: null },
    { ref: REF, state: ["quoted"] },
  ])("rejects coercible non-string ids: %j", (ids) => {
    rejectsWithoutChange({ ...ids, data: {}, ts: 1 } as unknown as Parameters<Ledger["append"]>[0]);
  });

  test("zero and default timestamps survive reopen; timestamp input and default clock are each read once", () => {
    const file = fresh();
    const ledger = openLedger(file, LEK, realFs);
    let reads = 0;
    const now = vi.spyOn(Date, "now").mockReturnValue(123456789);
    try {
      expect(ledger.append({ ref: REF, state: "quoted", data: {}, get ts() { reads++; return reads === 1 ? 0 : -1; } }).ts).toBe(0);
      expect(reads).toBe(1);
      expect(now).not.toHaveBeenCalled();
      expect(ledger.append({ ref: REF, state: "approved", data: {} }).ts).toBe(123456789);
      expect(now).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
      ledger.close();
    }
    const reopened = openLedger(file, LEK, realFs);
    try { expect(reopened.rows.map((row) => row.ts)).toEqual([0, 123456789]); } finally { reopened.close(); }
  });

  test("the existing depth limit accepts depth 64 and refuses depth 65 without durable changes", () => {
    let data: JsonValue = null;
    for (let i = 0; i < 64; i++) data = [data];
    expect(isPlainJson(data)).toBe(true);
    expect(isPlainJson([data])).toBe(false);
    rejectsWithoutChange({ ref: REF, state: "quoted", data: [data], ts: 1 });
  });

  test.each([
    ["one hole", () => Array(1)],
    ["interior hole", () => [1, , 3]],
    ["inherited element instead of an own element", () => Object.setPrototypeOf(Array(1), { 0: 1, __proto__: Array.prototype })],
    ["array toJSON", () => Object.assign([1], { toJSON: () => [] })],
    ["non-enumerable array toJSON", () => Object.defineProperty([1], "toJSON", { value: () => [] })],
    ["inherited array toJSON", () => Object.setPrototypeOf([1], { toJSON: () => [], __proto__: Array.prototype })],
  ])("rejects %s before append; subsequent valid data survives reopen", (_name, makeData) => {
    const data = { nested: makeData() };
    const file = fresh();
    const ledger = openLedger(file, LEK, realFs);
    try {
      expect.soft(isPlainJson(data)).toBe(false);
      expect(() => ledger.append({ ref: REF, state: "quoted", data, ts: 1 })).toThrow(/ledger_data_invalid/);
      expect(readFileSync(file, "utf8")).toBe("");
      expect(ledger.head).toBe(GENESIS_HASH);
      expect(ledger.writeFailed).toBe(false);
      ledger.append({ ref: REF, state: "quoted", data: { nested: [null, 1, []] }, ts: 2 });
    } finally {
      ledger.close();
    }
    const reopened = openLedger(file, LEK, realFs);
    expect(reopened.rows.map((row) => row.data)).toEqual([{ nested: [null, 1, []] }]);
    reopened.close();
  });

  test("canonicalJson sorts keys at every level; rowHash chains prev; isPlainJson rejects NaN, Date, toJSON", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 0, y: null }], c: "x" } })).toBe('{"a":{"c":"x","d":[1,{"y":null,"z":0}]},"b":1}');
    const h1 = rowHash({ v: 1, seq: 1, prev: GENESIS_HASH, ts: 1, ref: REF, state: "quoted", data: { a: 1 } });
    const h2 = rowHash({ v: 1, seq: 1, prev: "1".repeat(64), ts: 1, ref: REF, state: "quoted", data: { a: 1 } });
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(isPlainJson({ a: [1, "x", null, true, { b: 2 }] })).toBe(true);
    const bads: [string, unknown][] = [["NaN", { n: NaN }], ["Date", { d: new Date() }], ["toJSON", { t: { toJSON: () => 1 } }], ["undefined", { u: undefined }], ["BigInt", [1n]], ["Infinity", { i: Infinity }]];
    for (const [name, bad] of bads) expect(isPlainJson(bad), name).toBe(false);
  });

  test("append writes a chained row with fsync; reopening verifies the chain; sealed fields are encrypted and opened with the lek", () => {
    const file = fresh();
    const ledger = openLedger(file, LEK, realFs);
    expect(ledger.rows).toEqual([]);
    expect(ledger.head).toBe(GENESIS_HASH);
    const r1 = ledger.append({ ref: REF, state: "quoted", data: { amount: "10000" }, sealedPlain: Buffer.from("credential-secret"), ts: 1 });
    const r2 = ledger.append({ ref: REF, state: "approved", data: { hash: "x" }, ts: 2 });
    expect(r1.seq).toBe(1);
    expect(r2.prev).toBe(r1.hash);
    expect(ledger.head).toBe(r2.hash);
    const text = readFileSync(file, "utf8");
    expect(text.split("\n").filter((l) => l !== "").length).toBe(2);
    expect(text).not.toContain("credential-secret");
    expect(text).not.toContain(Buffer.from("credential-secret").toString("base64"));
    ledger.close();
    expect(() => ledger.append({ ref: REF, state: "sign_intent", data: {}, ts: 3 })).toThrow(/store_closed/);
    const reopened = openLedger(file, LEK, realFs);
    expect(reopened.rows.map((r) => r.state)).toEqual(["quoted", "approved"]);
    expect(reopened.openSealed(reopened.rows[0]!)!.toString()).toBe("credential-secret");
    expect(reopened.openSealed(reopened.rows[1]!)).toBeUndefined();
    expect(() => openLedger(file, Buffer.alloc(32, 4), realFs).openSealed(reopened.rows[0]!)).toThrow(/seal_mismatch/);
    reopened.close();
  });

  test("tampering anywhere in a complete (newline-terminated) row is store_corrupt — middle, last, sealed field, sequence gap", () => {
    const file = fresh();
    const good = twoRows(file);
    const [line1, line2] = good.split("\n");
    writeFileSync(file, good.replace('"n":1', '"n":9'));
    expect(() => openLedger(file, LEK, realFs)).toThrow(/store_corrupt/);
    writeFileSync(file, good.replace('"n":2', '"n":9'));
    expect(() => openLedger(file, LEK, realFs), "last complete row tampered is NOT silently dropped").toThrow(/store_corrupt/);
    // sealed の欄の改変（hash が合わなくなる）。
    const sealedLedger = openLedger(fresh(), LEK, realFs);
    const sealedFile = sealedLedger.append({ ref: REF, state: "signed", data: {}, sealedPlain: Buffer.from("x"), ts: 1 });
    sealedLedger.close();
    void sealedFile;
    const sealedPath = temps[temps.length - 1]! + "/ledger.ndjson";
    const sealedText = readFileSync(sealedPath, "utf8");
    const row = JSON.parse(sealedText.trim()) as { sealed: { ciphertext: string } };
    const flipped = Buffer.from(Buffer.from(row.sealed.ciphertext, "base64").map((b) => b ^ 1)).toString("base64");
    writeFileSync(sealedPath, sealedText.replace(row.sealed.ciphertext, flipped));
    expect(() => openLedger(sealedPath, LEK, realFs)).toThrow(/store_corrupt/);
    // seq の飛び（2 行目を seq 3 に書き換え、hash も計算し直す = 連鎖は正しいが番号が飛ぶ）。
    const second = JSON.parse(line2!) as Record<string, unknown>;
    const partial: Record<string, unknown> = { ...second, seq: 3 };
    delete partial["hash"];
    const rehashed = { ...partial, hash: rowHash(partial as never) };
    writeFileSync(file, `${line1}\n${JSON.stringify(rehashed)}\n`);
    expect(() => openLedger(file, LEK, realFs)).toThrow(/store_corrupt/);
  });

  test("an unterminated tail that does not parse is truncated and appending continues; an unterminated tail that parses and chains is kept and its newline repaired", () => {
    const file = fresh();
    const good = twoRows(file);
    writeFileSync(file, `${good}{"v":1,"seq":3,"prev":"x","ts":3,"ref":"${REF}","state":"sign_int`);
    const reopened = openLedger(file, LEK, realFs);
    expect(reopened.rows.length).toBe(2);
    expect(readFileSync(file, "utf8")).toBe(good);
    const r3 = reopened.append({ ref: REF, state: "sign_intent", data: {}, ts: 3 });
    expect(r3.seq).toBe(3);
    reopened.close();
    const withThird = readFileSync(file, "utf8");
    // 3 行目の改行だけを落とす（改行の直前で落ちた形）。
    writeFileSync(file, withThird.replace(/\n$/, ""));
    const again = openLedger(file, LEK, realFs);
    expect(again.rows.length).toBe(3);
    expect(readFileSync(file, "utf8")).toBe(withThird);
    again.close();
  });

  test("rollback detection: if the file's last row no longer matches the in-memory head (snapshot restored, or a partial tail appeared), append refuses with store_rollback", () => {
    const file = fresh();
    const ledger = openLedger(file, LEK, realFs);
    ledger.append({ ref: REF, state: "quoted", data: {}, ts: 1 });
    const snapshot = readFileSync(file, "utf8");
    ledger.append({ ref: REF, state: "approved", data: {}, ts: 2 });
    const full = readFileSync(file, "utf8");
    writeFileSync(file, snapshot);
    expect(() => ledger.append({ ref: REF, state: "sign_intent", data: {}, ts: 3 })).toThrow(/store_rollback/);
    writeFileSync(file, `${full}{"partial`);
    expect(() => ledger.append({ ref: REF, state: "sign_intent", data: {}, ts: 3 })).toThrow(/store_rollback/);
    // 保存された hash を書き換えても中身から再計算するので通らない。
    writeFileSync(file, full.replace(/"hash":"[0-9a-f]{64}"\}\n$/, `"hash":"${"f".repeat(64)}"}\n`));
    expect(() => ledger.append({ ref: REF, state: "sign_intent", data: {}, ts: 3 })).toThrow(/store_rollback/);
    // 逆に、中身だけ変えて保存された hash（= head）を据え置いても、再計算が合わないので通らない（hash を信じる実装はここで落ちる）。
    expect(full).toContain('"ts":2');
    writeFileSync(file, full.replace('"ts":2', '"ts":3'));
    expect(() => ledger.append({ ref: REF, state: "sign_intent", data: {}, ts: 3 })).toThrow(/store_rollback/);
    ledger.close();
  });

  test("a short write or an fsync failure marks the row as not written and refuses every later append", () => {
    const file = fresh();
    let shortNext = false;
    let failNext = false;
    const flaky: StoreFs = {
      ...realFs,
      writeSync: (fd, data) => { if (shortNext) { shortNext = false; return 0; } return realFs.writeSync(fd, data); },
      fsyncSync: (fd) => { if (failNext) { failNext = false; const e = new Error("EIO") as NodeJS.ErrnoException; e.code = "EIO"; throw e; } realFs.fsyncSync(fd); },
    };
    const ledger = openLedger(file, LEK, flaky);
    ledger.append({ ref: REF, state: "quoted", data: {}, ts: 1 });
    shortNext = true;
    expect(() => ledger.append({ ref: REF, state: "approved", data: {}, ts: 2 })).toThrow(/store_write_failed/);
    expect(ledger.writeFailed).toBe(true);
    expect(() => ledger.append({ ref: REF, state: "approved", data: {}, ts: 3 })).toThrow(/store_write_failed/);
    ledger.close();
    const second = openLedger(fresh(), LEK, flaky);
    second.append({ ref: REF, state: "quoted", data: {}, ts: 1 });
    failNext = true;
    expect(() => second.append({ ref: REF, state: "approved", data: {}, ts: 2 })).toThrow(/store_write_failed/);
    expect(second.writeFailed).toBe(true);
    second.close();
  });

  test("data and ids are validated before anything is written; unsupported versions refuse to open; a read-only file system refuses before any side effect", () => {
    const file = fresh();
    const ledger = openLedger(file, LEK, realFs);
    expect(() => ledger.append({ ref: REF, state: "quoted", data: { n: NaN } as never, ts: 1 })).toThrow(/ledger_data_invalid/);
    expect(() => ledger.append({ ref: "bad ref", state: "quoted", data: {}, ts: 1 })).toThrow(/ledger_data_invalid/);
    expect(() => ledger.append({ ref: REF, state: "Quoted!", data: {}, ts: 1 })).toThrow(/ledger_data_invalid/);
    expect(readFileSync(file, "utf8")).toBe("");
    ledger.close();
    writeFileSync(file, `${JSON.stringify({ v: 2, seq: 1, prev: GENESIS_HASH, ts: 1, ref: REF, state: "quoted", data: {}, hash: "x" })}\n`);
    expect(() => openLedger(file, LEK, realFs)).toThrow(/store_unsupported_version/);
    const erofs: StoreFs = { ...realFs, openSync: () => { const e = new Error("EROFS") as NodeJS.ErrnoException; e.code = "EROFS"; throw e; } };
    expect(() => openLedger(fresh(), LEK, erofs)).toThrow(/EROFS/);
  });
});
