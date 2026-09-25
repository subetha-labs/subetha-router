import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { openJournal, type Journal, type JournalRecord } from "../../src/core/journal.js";

/** 使い捨てディレクトリは `runtime/` 配下にのみ作り、自分が作ったパスだけ消す。 */
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const tsxCli = path.resolve(import.meta.dirname, "../../node_modules/tsx/dist/cli.mjs");
const lockChild = path.resolve(import.meta.dirname, "../fixtures/journal-lock-child.ts");

const execFileAsync = promisify(execFile);

/** 別プロセスの writer を 1 つだけ起動する（ロック挙動の実測用）。 */
async function runLockChild(
  mode: "try-lock" | "hold-and-exit",
  journalPath: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      tsxCli,
      lockChild,
      mode,
      journalPath,
    ]);
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

/** 破損ケース用に生の NDJSON 行を組み立てる（テスト基盤）。 */
function rawLine(seq: number, event: string): string {
  return `${JSON.stringify({
    seq,
    at: "2026-09-25T00:00:00.000Z",
    paymentId: "pay-raw",
    event,
    patch: {},
  })}\n`;
}

/** openJournal が fail closed で失敗することを前提に、その error を返す。 */
async function openFailure(
  journalPath: string,
): Promise<{ code?: unknown; reason?: unknown; byteOffset?: unknown }> {
  let opened: Journal | undefined;
  try {
    opened = await openJournal({ journalPath });
  } catch (error) {
    return error as { code?: unknown; reason?: unknown; byteOffset?: unknown };
  } finally {
    await opened?.close();
  }
  throw new Error("openJournal が成功した（fail closed ではない）");
}

let workDir: string;

beforeEach(async () => {
  await mkdir(runtimeRoot, { recursive: true });
  workDir = await mkdtemp(path.join(runtimeRoot, "t1a-journal-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test("append した記録は close→再オープン後も順序どおり replay される", async () => {
  const journalPath = path.join(workDir, "journal.ndjson");

  const writer = await openJournal({ journalPath });
  await writer.append({
    paymentId: "pay-t1a",
    event: "created",
    patch: { routeId: "md-a-eth-snapshot" },
  });
  await writer.append({
    paymentId: "pay-t1a",
    event: "source_pending",
    patch: { attempt: 1 },
  });
  await writer.close();

  const reopened = await openJournal({ journalPath });
  try {
    expect(reopened.records.map((record) => [record.seq, record.paymentId, record.event])).toEqual([
      [1, "pay-t1a", "created"],
      [2, "pay-t1a", "source_pending"],
    ]);
  } finally {
    await reopened.close();
  }
});

test("保持中は実プロセスの二重 writer を拒否し、ロックファイルを削除しない", { timeout: 30_000 }, async () => {
  const journalPath = path.join(workDir, "journal.ndjson");
  const lockPath = path.join(workDir, "journal.lock");

  const holder = await openJournal({ journalPath });
  try {
    const rejected = await runLockChild("try-lock", journalPath);
    expect(rejected.stdout.trim()).toBe("LOCKED journal_locked");
    expect(rejected.exitCode).toBe(3);
    expect(existsSync(lockPath)).toBe(true);
  } finally {
    await holder.close();
  }

  // close はロックを解放するだけで、常設ロックファイルを unlink しない。
  expect(existsSync(lockPath)).toBe(true);
});

test("並行 append でも seq は 1 からの連番になり、同じ順序でファイルに残る", async () => {
  const journalPath = path.join(workDir, "journal.ndjson");
  const expected = [1, 2, 3, 4, 5, 6, 7, 8];

  const journal = await openJournal({ journalPath });
  try {
    await Promise.all(
      expected.map((n) => journal.append({ paymentId: `pay-${n}`, event: "created" })),
    );
    expect(journal.records.map((record) => record.seq)).toEqual(expected);
  } finally {
    await journal.close();
  }

  const lines = (await readFile(journalPath, "utf8")).split("\n").filter((line) => line !== "");
  expect(lines.map((line) => (JSON.parse(line) as { seq: number }).seq)).toEqual(expected);
});

test("メモリ上の記録は呼び出し側の patch 変更や records 操作から切り離され、fsync 済みバイト列と一致する", async () => {
  const journalPath = path.join(workDir, "journal.ndjson");
  const patch = { routeId: "md-a-eth-snapshot", destination: { quoted: "1000" } };

  const journal = await openJournal({ journalPath });
  try {
    await journal.append({ paymentId: "pay-detach", event: "created", patch });

    // 追記後に呼び出し側が自分のオブジェクトを書き換えても、確定済み記録は動かない。
    patch.routeId = "tampered";
    patch.destination.quoted = "999999";

    // records の返り値への操作も内部表に波及しない。
    (journal.records as JournalRecord[]).push({
      seq: 99,
      at: "2026-09-25T00:00:00.000Z",
      paymentId: "pay-injected",
      event: "delivered",
      patch: {},
    });

    const durable = (await readFile(journalPath, "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as JournalRecord);

    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.patch).toEqual({
      routeId: "md-a-eth-snapshot",
      destination: { quoted: "1000" },
    });
    // メモリ表と fsync 済みバイト列が食い違わない。
    expect(journal.records.map((record) => record.patch)).toEqual(
      durable.map((record) => record.patch),
    );
  } finally {
    await journal.close();
  }
});

test("record の形が不正な行は byte offset 付きで fail closed になる", async () => {
  const nullRecord = path.join(workDir, "null-record.ndjson");
  await writeFile(nullRecord, "null\n", "utf8");
  const nullFailure = await openFailure(nullRecord);
  expect(nullFailure.code).toBe("journal_corrupt");
  expect(nullFailure.reason).toBe("invalid_record");
  expect(nullFailure.byteOffset).toBe(0);

  const partialRecord = path.join(workDir, "partial-record.ndjson");
  await writeFile(partialRecord, '{"seq":1}\n', "utf8");
  const partialFailure = await openFailure(partialRecord);
  expect(partialFailure.code).toBe("journal_corrupt");
  expect(partialFailure.reason).toBe("invalid_record");
  expect(partialFailure.byteOffset).toBe(0);
});

test("末尾が切れた行は byte offset 付きで fail closed になり、切り詰めない", async () => {
  const journalPath = path.join(workDir, "journal.ndjson");
  const intact = rawLine(1, "created");
  const truncated = '{"seq":2,"at":"2026-09-25T00:00:00.000Z","paymentId":"pay-raw","even';
  await writeFile(journalPath, intact + truncated, "utf8");
  const sizeBefore = (await stat(journalPath)).size;

  const failure = await openFailure(journalPath);
  expect(failure.code).toBe("journal_corrupt");
  expect(failure.reason).toBe("truncated_tail");
  expect(failure.byteOffset).toBe(Buffer.byteLength(intact, "utf8"));

  // 自動切り詰めも自動補完もしない。
  expect((await stat(journalPath)).size).toBe(sizeBefore);
  expect(await readFile(journalPath, "utf8")).toBe(intact + truncated);
});

test("中間行の JSON 破損は byte offset 付きで fail closed になる", async () => {
  const journalPath = path.join(workDir, "journal.ndjson");
  const intact = rawLine(1, "created");
  await writeFile(journalPath, `${intact}{"seq":2,"broken"\n${rawLine(3, "delivered")}`, "utf8");

  const failure = await openFailure(journalPath);
  expect(failure.code).toBe("journal_corrupt");
  expect(failure.reason).toBe("invalid_json");
  expect(failure.byteOffset).toBe(Buffer.byteLength(intact, "utf8"));
});

test("seq が連番でない journal は byte offset 付きで fail closed になる", async () => {
  const journalPath = path.join(workDir, "journal.ndjson");
  const intact = rawLine(1, "created");
  await writeFile(journalPath, intact + rawLine(3, "source_pending"), "utf8");

  const failure = await openFailure(journalPath);
  expect(failure.code).toBe("journal_corrupt");
  expect(failure.reason).toBe("seq_gap");
  expect(failure.byteOffset).toBe(Buffer.byteLength(intact, "utf8"));
});

test("close 後の writer は追記を受け付けず、ファイルも増えない", async () => {
  const journalPath = path.join(workDir, "journal.ndjson");
  const journal = await openJournal({ journalPath });
  await journal.append({ paymentId: "pay-closed", event: "created" });
  await journal.close();

  const sizeAfterClose = (await stat(journalPath)).size;
  await expect(journal.append({ paymentId: "pay-closed", event: "source_pending" })).rejects.toMatchObject({
    code: "journal_closed",
  });
  expect((await stat(journalPath)).size).toBe(sizeAfterClose);
});

test("不正な entry は 1 バイトも書かず、後続の追記と再 open を壊さない", async () => {
  const journalPath = path.join(workDir, "journal.ndjson");

  const journal = await openJournal({ journalPath });
  try {
    await expect(journal.append({ paymentId: "", event: "created" })).rejects.toMatchObject({
      code: "journal_invalid_entry",
    });
    // 検証前に書いてしまっていないこと。
    expect((await stat(journalPath)).size).toBe(0);

    // writer は使用可能なままで、seq も汚れていない。
    await journal.append({ paymentId: "pay-ok", event: "created" });
    expect(journal.records.map((record) => [record.seq, record.paymentId])).toEqual([
      [1, "pay-ok"],
    ]);
  } finally {
    await journal.close();
  }

  const reopened = await openJournal({ journalPath });
  try {
    expect(reopened.records.map((record) => [record.seq, record.paymentId])).toEqual([
      [1, "pay-ok"],
    ]);
  } finally {
    await reopened.close();
  }
});

test("open は親ディレクトリを同期してから成功し、append はファイルを同期する", async () => {
  const journalPath = path.join(workDir, "journal.ndjson");

  // どの fd に対する sync かだけを記録する最小の spy（true = ディレクトリ）。
  const probe = await open(path.join(workDir, "sync-order-probe"), "a");
  const fileHandleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const originalSync = fileHandleProto.sync;
  const syncedDirectory: boolean[] = [];
  const syncSpy = vi
    .spyOn(fileHandleProto, "sync")
    .mockImplementation(async function (this: FileHandle) {
      syncedDirectory.push((await this.stat()).isDirectory());
      await originalSync.call(this);
    });

  try {
    const journal = await openJournal({ journalPath });
    try {
      // 成功を返す前に、新規ファイル名を保持する親ディレクトリを同期している。
      expect(syncedDirectory).toEqual([true]);

      await journal.append({ paymentId: "pay-order", event: "created" });
      expect(syncedDirectory).toEqual([true, false]);
    } finally {
      await journal.close();
    }
  } finally {
    syncSpy.mockRestore();
  }
});

test("ディレクトリ同期に失敗した open は成功せず、保持していたロックを解放する", async () => {
  const journalPath = path.join(workDir, "journal.ndjson");

  const probe = await open(path.join(workDir, "dir-sync-probe"), "a");
  const fileHandleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const syncSpy = vi
    .spyOn(fileHandleProto, "sync")
    .mockRejectedValueOnce(new Error("directory fsync failed"));

  try {
    await expect(openJournal({ journalPath })).rejects.toThrow("directory fsync failed");
  } finally {
    syncSpy.mockRestore();
  }

  // 失敗した open がロックを握ったままにしない（再取得できる）。
  const journal = await openJournal({ journalPath });
  await journal.close();
});

test("fsync が失敗した追記はメモリに publish されず、以後の writer も止まる", async () => {
  const journalPath = path.join(workDir, "journal.ndjson");

  const journal = await openJournal({ journalPath });

  // open 時のディレクトリ同期の後に仕掛け、append の fsync だけを 1 回失敗させる。
  // 本番コードに注入口（フレームワーク）を作らないための最小の spy。
  const probe = await open(path.join(workDir, "fsync-probe"), "a");
  const fileHandleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const syncSpy = vi.spyOn(fileHandleProto, "sync").mockRejectedValueOnce(new Error("fsync failed"));

  try {
    await expect(journal.append({ paymentId: "pay-fsync", event: "created" })).rejects.toThrow(
      "fsync failed",
    );
    syncSpy.mockRestore();

    // バイト列は書かれ得るが、fsync が返っていない行をメモリが publish してはいけない。
    expect(journal.records).toEqual([]);
    // 部分書き込みの可能性を排除できないので、同じ writer で書き続けない。
    await expect(
      journal.append({ paymentId: "pay-fsync", event: "source_pending" }),
    ).rejects.toMatchObject({ code: "journal_unusable" });

    const lines = (await readFile(journalPath, "utf8")).split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
  } finally {
    syncSpy.mockRestore();
    await journal.close();
  }
});

test("ロックを保持した子プロセスの終了後は再取得でき、その追記が replay される", { timeout: 30_000 }, async () => {
  const journalPath = path.join(workDir, "journal.ndjson");

  const held = await runLockChild("hold-and-exit", journalPath);
  expect(held.stdout.trim()).toBe("HELD");
  expect(held.exitCode).toBe(0);

  const reopened = await openJournal({ journalPath });
  try {
    expect(reopened.records.map((record) => [record.seq, record.paymentId, record.event])).toEqual([
      [1, "pay-child", "created"],
    ]);
  } finally {
    await reopened.close();
  }
});
