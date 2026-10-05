/**
 * 未払いの動的 quote の控え（設計 `docs/dynamic-upstream-design.md` §6.1〜§6.3、タスク T5）。
 * 実ファイル（一時ディレクトリ）に書く。時計は注入する。
 */

import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import {
  credentialDigestOf,
  LedgerDuplicateError,
  LedgerLifetimeError,
  LedgerRecordTooLargeError,
  MAX_ATTEMPT_LINE_BYTES,
  MAX_QUOTE_LINE_BYTES,
  QuoteLedger,
  type LedgerQuote,
} from "../../src/core/quote-ledger.js";

const DAY = 86_400_000;
/** 2026-10-05T12:00:00Z。 */
const NOON = Date.UTC(2026, 9, 5, 12, 0, 0);

let dir: string;
let clock: number;
const opened: QuoteLedger[] = [];

beforeEach(async () => {
  const root = path.resolve("runtime");
  await mkdir(root, { recursive: true });
  dir = path.join(await mkdtemp(path.join(root, "t5-ledger-")), "dynamic-quotes");
  clock = NOON;
});

afterEach(async () => {
  for (const ledger of opened.splice(0)) await ledger.close().catch(() => undefined);
  await rm(path.dirname(dir), { recursive: true, force: true });
});

async function open(options: { retentionDays?: number; isPromoted?: (quoteId: string) => boolean } = {}): Promise<QuoteLedger> {
  const ledger = await QuoteLedger.open({ dir, now: () => clock, retentionDays: options.retentionDays ?? 7, ...(options.isPromoted === undefined ? {} : { isPromoted: options.isPromoted }) });
  opened.push(ledger);
  return ledger;
}

function quote(n: number, overrides: Partial<LedgerQuote> = {}): LedgerQuote {
  return {
    quoteId: `q-${n}`,
    paymentId: `pay-${n}`,
    principalId: "judge",
    requestId: `req-${n}`,
    deadlineMs: clock + 600_000,
    record: { upstream: { url: `https://provider.test/v1/${n}`, method: "GET" }, note: "x".repeat(100) },
    ...overrides,
  };
}

async function lines(file: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path.join(dir, file), "utf8")).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("put は当日のファイルに 1 行を書き、書き終えてから読める。再起動後も期限内なら戻る", async () => {
  const ledger = await open();
  await ledger.put(quote(1));
  expect(await readdir(dir)).toEqual(["2026-10-05.ndjson"]);
  expect((await lines("2026-10-05.ndjson")).map((line) => [line["kind"], line["quoteId"]])).toEqual([["quote", "q-1"]]);
  expect(ledger.get("q-1")?.paymentId).toBe("pay-1");
  expect(ledger.byPaymentId("pay-1")?.quoteId).toBe("q-1");
  expect(ledger.byRequest("judge", "req-1")?.quoteId).toBe("q-1");
  expect(ledger.byRequest("other", "req-1")).toBeUndefined();
  expect(ledger.outstanding()).toBe(1);
  await ledger.close();

  const reopened = await open();
  expect(reopened.get("q-1")?.record).toEqual(quote(1).record);
  expect(reopened.outstanding()).toBe(1);
  expect(reopened.loadStats).toEqual({ linesRead: 1, skipped: 0, loaded: 1 });
});

test("メモリに載る値は書いた行そのもの（呼び出し側が後から書き換えても変わらない）", async () => {
  const ledger = await open();
  const mutable = { upstream: { url: "https://provider.test/a", method: "GET" } };
  await ledger.put(quote(1, { record: mutable }));
  mutable.upstream.url = "https://attacker.test/";
  expect((ledger.get("q-1")?.record["upstream"] as { url: string }).url).toBe("https://provider.test/a");
});

test("期限切れの quote は読めなくなり、数にも入らない。再起動しても戻らない", async () => {
  const ledger = await open();
  await ledger.put(quote(1));
  await ledger.put(quote(2, { deadlineMs: clock + 1_200_000 }));
  clock += 600_000; // q-1 の期限ちょうど（期限と等しい時刻は期限切れ）
  expect(ledger.get("q-1")).toBeUndefined();
  expect(ledger.byRequest("judge", "req-1")).toBeUndefined();
  expect(ledger.outstanding()).toBe(1);
  await ledger.close();
  const reopened = await open();
  expect(reopened.get("q-1")).toBeUndefined();
  expect(reopened.get("q-2")?.quoteId).toBe("q-2");
  // 期限切れの requestId はもう一度使える（未払いの quote は何も消費していない）。
  await reopened.put(quote(3, { requestId: "req-1" }));
});

test("既に期限切れ・24 時間を超える寿命の quote は書かない", async () => {
  const ledger = await open();
  await expect(ledger.put(quote(1, { deadlineMs: clock }))).rejects.toBeInstanceOf(LedgerLifetimeError);
  await expect(ledger.put(quote(2, { deadlineMs: clock + DAY + 1 }))).rejects.toBeInstanceOf(LedgerLifetimeError);
  await ledger.put(quote(3, { deadlineMs: clock + DAY }));
  expect(await lines("2026-10-05.ndjson")).toHaveLength(1);
});

test("同じ quoteId・paymentId・(principal, requestId) の 2 つ目は 1 バイトも書かずに拒否する", async () => {
  const ledger = await open();
  await ledger.put(quote(1));
  const before = (await stat(path.join(dir, "2026-10-05.ndjson"))).size;
  await expect(ledger.put(quote(9, { quoteId: "q-1" }))).rejects.toBeInstanceOf(LedgerDuplicateError);
  await expect(ledger.put(quote(9, { paymentId: "pay-1" }))).rejects.toBeInstanceOf(LedgerDuplicateError);
  await expect(ledger.put(quote(9, { requestId: "req-1" }))).rejects.toBeInstanceOf(LedgerDuplicateError);
  expect((await stat(path.join(dir, "2026-10-05.ndjson"))).size).toBe(before);
  // principal が違えば同じ requestId を使える。
  await ledger.put(quote(9, { principalId: "other", requestId: "req-1" }));
});

test("1 行の上限: ちょうど 8 KiB は書け、1 バイト超えると何も書かずに拒否する", async () => {
  const ledger = await open();
  const sizeOf = (pad: number): number =>
    Buffer.byteLength(JSON.stringify({ kind: "quote", at: new Date(clock).toISOString(), ...quote(1, { record: { pad: "a".repeat(pad) } }) })) + 1;
  const base = sizeOf(0);
  const exact = MAX_QUOTE_LINE_BYTES - base;
  expect(sizeOf(exact)).toBe(MAX_QUOTE_LINE_BYTES);
  await expect(ledger.put(quote(1, { record: { pad: "a".repeat(exact + 1) } }))).rejects.toBeInstanceOf(LedgerRecordTooLargeError);
  expect(await readdir(dir)).toEqual([]);
  expect(ledger.get("q-1")).toBeUndefined();
  await ledger.put(quote(1, { record: { pad: "a".repeat(exact) } }));
  expect((await stat(path.join(dir, "2026-10-05.ndjson"))).size).toBe(MAX_QUOTE_LINE_BYTES);
});

test("attempt は 1 quote につき最初の 1 行だけ。512 バイト以下で、credential そのものは残らない", async () => {
  const ledger = await open();
  await ledger.put(quote(1));
  const credential = { payload: { credential: "Payment secret-wire-credential" } };
  expect(await ledger.recordAttempt("q-1", credentialDigestOf(credential))).toBe(true);
  expect(await ledger.recordAttempt("q-1", credentialDigestOf({ other: true }))).toBe(false);
  expect(await ledger.recordAttempt("unknown", credentialDigestOf(credential))).toBe(false);
  const written = await lines("2026-10-05.ndjson");
  expect(written.map((line) => line["kind"])).toEqual(["quote", "attempt"]);
  expect(written[1]!["credentialDigest"]).toBe(credentialDigestOf(credential));
  const text = await readFile(path.join(dir, "2026-10-05.ndjson"), "utf8");
  expect(text).not.toContain("secret-wire-credential");
  expect(Buffer.byteLength(text.split("\n")[1]!) + 1).toBeLessThanOrEqual(MAX_ATTEMPT_LINE_BYTES);
  // 大きすぎる要約は書かない。
  await ledger.put(quote(2));
  await expect(ledger.recordAttempt("q-2", "x".repeat(600))).rejects.toBeInstanceOf(LedgerRecordTooLargeError);
  expect(ledger.attemptOf("q-2")).toBeUndefined();
});

test("attempt は再起動後も読め、期限内の quote はメモリに戻る（MPP で払った後の証拠）", async () => {
  const ledger = await open();
  await ledger.put(quote(1));
  await ledger.recordAttempt("q-1", "sha256:first");
  await ledger.close();
  clock += 60_000;
  const reopened = await open();
  expect(reopened.get("q-1")?.quoteId).toBe("q-1");
  expect(reopened.attemptOf("q-1")).toMatchObject({ quoteId: "q-1", credentialDigest: "sha256:first" });
  // 再起動後も 2 行目は書かない。
  expect(await reopened.recordAttempt("q-1", "sha256:second")).toBe(false);
  expect((await lines("2026-10-05.ndjson")).filter((line) => line["kind"] === "attempt")).toHaveLength(1);
});

test("昇格済みの quote は、メモリから外れ、再起動時にも読み飛ばす（journal が正）", async () => {
  const ledger = await open();
  await ledger.put(quote(1));
  await ledger.put(quote(2));
  await ledger.recordAttempt("q-1", "sha256:a");
  ledger.markPromoted("q-1");
  expect(ledger.get("q-1")).toBeUndefined();
  expect(ledger.attemptOf("q-1")).toBeUndefined();
  expect(ledger.outstanding()).toBe(1);
  await ledger.close();
  const reopened = await open({ isPromoted: (quoteId) => quoteId === "q-1" });
  expect(reopened.get("q-1")).toBeUndefined();
  expect(reopened.byRequest("judge", "req-1")).toBeUndefined();
  expect(reopened.get("q-2")?.quoteId).toBe("q-2");
  // `isPromoted` を渡さなければ戻ってしまう（渡すことが呼び出し側の契約）。
  await reopened.close();
  expect((await open()).get("q-1")?.quoteId).toBe("q-1");
});

test("日付が替わるとファイルが替わり、保持期間より古いファイルは削除される", async () => {
  await mkdir(dir, { recursive: true });
  for (const date of ["2026-09-27", "2026-09-28", "2026-09-29", "2026-10-04"]) {
    await writeFile(path.join(dir, `${date}.ndjson`), "");
  }
  await writeFile(path.join(dir, "notes.txt"), "keep me");
  // 保持 7 日: 10-05 を含めて 09-29 まで残る。
  const ledger = await open({ retentionDays: 7 });
  expect((await readdir(dir)).sort()).toEqual(["2026-09-29.ndjson", "2026-10-04.ndjson", "notes.txt"]);
  await ledger.put(quote(1));
  clock += DAY; // 10-06
  await ledger.put(quote(2));
  expect((await readdir(dir)).sort()).toEqual(["2026-10-04.ndjson", "2026-10-05.ndjson", "2026-10-06.ndjson", "notes.txt"]);
  expect((await lines("2026-10-06.ndjson")).map((line) => line["quoteId"])).toEqual(["q-2"]);
});

test("起動時に読むのは当日と前日のファイルだけ。期限内の quote しかメモリに載らない", async () => {
  await mkdir(dir, { recursive: true });
  const row = (n: number, deadlineMs: number): string =>
    `${JSON.stringify({ kind: "quote", at: "x", ...quote(n, { deadlineMs }) })}\n`;
  // 3 日前のファイルに「期限内」と書かれた行があっても読まない（寿命 24 時間の規則から、あり得ない行）。
  await writeFile(path.join(dir, "2026-10-02.ndjson"), row(1, clock + 600_000));
  await writeFile(path.join(dir, "2026-10-04.ndjson"), Array.from({ length: 300 }, (_, i) => row(100 + i, clock - 1)).join("") + row(2, clock + 600_000));
  await writeFile(path.join(dir, "2026-10-05.ndjson"), Array.from({ length: 300 }, (_, i) => row(500 + i, clock - 1)).join("") + row(3, clock + 600_000));
  const ledger = await open();
  // 602 行を読むが、メモリに載せるのは期限内の 2 件だけ（期限切れの 600 件は載せない）。
  expect(ledger.loadStats).toEqual({ linesRead: 602, skipped: 0, loaded: 2 });
  expect(ledger.outstanding()).toBe(2);
  expect(ledger.get("q-1")).toBeUndefined();
  expect(ledger.get("q-2")?.quoteId).toBe("q-2");
  expect(ledger.get("q-3")?.quoteId).toBe("q-3");
});

test("読めない行は起動を止めずに飛ばし、数える（途中で切れた最後の行・JSON でない行・形の違う行・重複）", async () => {
  await mkdir(dir, { recursive: true });
  const good = JSON.stringify({ kind: "quote", at: "x", ...quote(1) });
  const duplicate = JSON.stringify({ kind: "quote", at: "x", ...quote(9, { quoteId: "q-1" }) });
  await writeFile(
    path.join(dir, "2026-10-05.ndjson"),
    [good, "not json", JSON.stringify({ kind: "quote", quoteId: 5 }), JSON.stringify({ kind: "mystery" }), JSON.stringify([1]), duplicate, JSON.stringify({ kind: "attempt", quoteId: "q-1" })].join("\n") +
      "\n" +
      good.slice(0, 40),
  );
  const ledger = await open();
  expect(ledger.get("q-1")?.paymentId).toBe("pay-1");
  expect(ledger.loadStats).toEqual({ linesRead: 8, skipped: 7, loaded: 1 });
  // 切れた行の後ろにも書き続けられる。
  await appendFile(path.join(dir, "2026-10-05.ndjson"), "\n");
  await ledger.put(quote(2));
  expect(ledger.get("q-2")?.quoteId).toBe("q-2");
});

test("容量: 上限（200 件）まで発行しても、メモリは期限内の件数だけ。期限が切れれば 0 に戻る", async () => {
  const ledger = await open();
  for (let n = 0; n < 200; n += 1) {
    await ledger.put(quote(n));
  }
  expect(ledger.outstanding()).toBe(200);
  const size = (await stat(path.join(dir, "2026-10-05.ndjson"))).size;
  expect(size).toBeLessThanOrEqual(200 * MAX_QUOTE_LINE_BYTES);
  clock += 600_000;
  expect(ledger.outstanding()).toBe(0);
  await ledger.close();
  const reopened = await open();
  expect(reopened.outstanding()).toBe(0);
  expect(reopened.loadStats).toEqual({ linesRead: 200, skipped: 0, loaded: 0 });
});

test("並行する put は直列に書かれ、行が混ざらない", async () => {
  const ledger = await open();
  await Promise.all(Array.from({ length: 30 }, (_, n) => ledger.put(quote(n))));
  const written = await lines("2026-10-05.ndjson");
  expect(written).toHaveLength(30);
  expect(new Set(written.map((line) => line["quoteId"])).size).toBe(30);
});

test("並行する put が同じ識別子を使ったら、書かれるのは 1 件だけ（検査と書き込みが不可分）", async () => {
  const ledger = await open();
  const results = await Promise.allSettled([
    ledger.put(quote(1)),
    ledger.put(quote(2, { requestId: "req-1" })),
    ledger.put(quote(3, { paymentId: "pay-1" })),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "rejected"]);
  expect(await lines("2026-10-05.ndjson")).toHaveLength(1);
  expect(ledger.outstanding()).toBe(1);
});

test("close の後は書けない", async () => {
  const ledger = await open();
  await ledger.close();
  await expect(ledger.put(quote(1))).rejects.toThrow("closed");
});

test("retentionDays は正の整数でなければ開かない", async () => {
  await expect(QuoteLedger.open({ dir, retentionDays: 0 })).rejects.toThrow();
  await expect(QuoteLedger.open({ dir, retentionDays: 1.5 })).rejects.toThrow();
});
