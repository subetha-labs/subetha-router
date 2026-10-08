/**
 * P-1b（設計 §3.7）: `link` 方式の lock。同時の 2 process で 1 つだけ成功（本物の並行）、stale では起動しない（回収も rename もしない）、生きた pid は
 * `daemon_already_running`、reclaim は生きた pid を拒み・直列化され・取った後にもう一度検査する、所有の identity は (inode, token)（inode の再利用に耐える）、
 * 一時ファイルの残骸は取得を妨げない。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { realFs } from "../../src/store/fs.js";
import { acquireLock, inspectLock, LOCK_FILE, psStartedAtOf, RECLAIM_LOCK_FILE, reclaimLock } from "../../src/store/lock.js";

const temps: string[] = [];
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});
function fresh(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "payer-lock-"));
  temps.push(dir);
  return dir;
}
const deps = { fs: realFs, isAlive: (pid: number) => pid === process.pid, startedAtOf: () => "T0" };
const TOKEN = "0123456789abcdef";

describe("lock", () => {
  test("acquire → the lock carries pid/startedAt/hostname/token; no temp file remains; stillHeld; identity is (inode, token): a rewritten token or a replaced file is not ours; release removes only ours", () => {
    const dir = fresh();
    const lockPath = path.join(dir, LOCK_FILE);
    const handle = acquireLock(dir, deps);
    expect(readdirSync(dir)).toEqual([LOCK_FILE]);
    const content = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    expect(content["pid"]).toBe(process.pid);
    expect(content["startedAt"]).toBe("T0");
    expect(content["token"]).toBe(handle.content.token);
    expect(handle.stillHeld()).toBe(true);
    // 同じ inode のまま token を書き換えられたら、自分のものではない。
    writeFileSync(lockPath, JSON.stringify({ ...content, token: TOKEN }));
    expect(handle.stillHeld()).toBe(false);
    handle.release();
    expect(existsSync(lockPath), "release must not remove a lock whose token is not ours").toBe(true);
    // 外から unlink → false。
    unlinkSync(lockPath);
    expect(handle.stillHeld()).toBe(false);
    // 別の lock が置かれたら（inode が再利用されても token が違う）消さない。
    writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt: "", hostname: "h", token: TOKEN }));
    handle.release();
    expect(existsSync(lockPath)).toBe(true);
  });

  test("a live pid → daemon_already_running; a dead pid → daemon_lock_stale and nothing is renamed or removed; a pid reused with a different start time → stale; garbage → lock_unreadable", () => {
    const dir = fresh();
    const lockPath = path.join(dir, LOCK_FILE);
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, startedAt: "T0", hostname: "h", token: TOKEN }));
    expect(() => acquireLock(dir, { ...deps, isAlive: () => true, startedAtOf: () => "T0" })).toThrow(/daemon_already_running/);
    expect(() => acquireLock(dir, { ...deps, isAlive: () => false })).toThrow(/daemon_lock_stale/);
    expect(readdirSync(dir)).toEqual([LOCK_FILE]);
    expect(readFileSync(lockPath, "utf8")).toContain("424242");
    expect(inspectLock(dir, { ...deps, isAlive: () => true, startedAtOf: () => "T1" }).state).toBe("stale");
    expect(inspectLock(dir, { ...deps, isAlive: () => true, startedAtOf: () => undefined }).state).toBe("held");
    writeFileSync(lockPath, "garbage");
    expect(() => acquireLock(dir, deps)).toThrow(/lock_unreadable/);
    expect(inspectLock(dir, deps).state).toBe("unreadable");
  });

  test("reclaim: refuses a live pid, removes a stale lock, reports a free lock, re-checks after taking the reclaim lock, and is serialized (reclaim_busy while another live reclaimer holds it; a dead reclaimer's guard is cleared)", () => {
    const dir = fresh();
    const lockPath = path.join(dir, LOCK_FILE);
    expect(reclaimLock(dir, deps)).toEqual({ removed: false });
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, startedAt: "T0", hostname: "h", token: TOKEN }));
    expect(() => reclaimLock(dir, { ...deps, isAlive: () => true })).toThrow(/daemon_already_running/);
    expect(existsSync(lockPath)).toBe(true);
    // 別の生きた回収者が回収の lock を持っている → busy、何も消さない。
    writeFileSync(path.join(dir, RECLAIM_LOCK_FILE), JSON.stringify({ pid: 424243, startedAt: "", hostname: "h", token: TOKEN }));
    expect(() => reclaimLock(dir, { ...deps, isAlive: (pid) => pid === 424243 })).toThrow(/reclaim_busy/);
    expect(existsSync(lockPath)).toBe(true);
    // 死んだ回収者の guard は片づけて続ける。
    expect(reclaimLock(dir, { ...deps, isAlive: () => false })).toMatchObject({ removed: true, content: { pid: 424242 } });
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(path.join(dir, RECLAIM_LOCK_FILE)), "the reclaim guard is released").toBe(false);
    // 回収の lock を取った後の再検査: 検査の前に新しい daemon が取っていれば消さない（取った後は EEXIST で誰も取れないので、この順序で十分）。
    const handle = acquireLock(dir, deps);
    expect(() => reclaimLock(dir, deps)).toThrow(/daemon_already_running/);
    expect(handle.stillHeld()).toBe(true);
    handle.release();
  });

  test("two processes racing for the same lock concurrently: exactly one link succeeds (real processes, real fs)", async () => {
    const dir = fresh();
    const script = `
      import { acquireLock } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../src/store/lock.ts"))};
      import { realFs } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../src/store/fs.ts"))};
      const dir = process.argv[2];
      const start = Number(process.argv[3]);
      while (Date.now() < start) {}
      try { acquireLock(dir, { fs: realFs, isAlive: () => true, startedAtOf: () => "T0" }); console.log("acquired"); setTimeout(() => {}, 500); }
      catch (e) { console.log("refused:" + e.code); }
    `;
    const scriptPath = path.join(dir, "contender.mts");
    writeFileSync(scriptPath, script);
    const tsx = path.resolve(import.meta.dirname, "../../../../node_modules/.bin/tsx");
    const start = Date.now() + 1500;
    const run = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn(tsx, [scriptPath, dir, String(start)], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        child.on("error", reject);
        child.on("close", () => resolve(out.trim()));
      });
    const outputs = await Promise.all([run(), run(), run()]);
    expect(outputs.filter((o) => o === "acquired").length).toBe(1);
    expect(outputs.filter((o) => o.startsWith("refused:daemon_already_running")).length).toBe(2);
    expect(readdirSync(dir).filter((f) => f.startsWith(LOCK_FILE)).length).toBe(1);
  });

  test("a leftover temp file from a crash between open and link does not block acquisition and is not mistaken for the lock", () => {
    const dir = fresh();
    writeFileSync(path.join(dir, `${LOCK_FILE}.99999.deadbeefdeadbeef`), JSON.stringify({ pid: 99999, startedAt: "", hostname: "h", token: "deadbeefdeadbeef" }));
    expect(inspectLock(dir, deps).state).toBe("free");
    const handle = acquireLock(dir, deps);
    expect(handle.stillHeld()).toBe(true);
    handle.release();
    expect(readdirSync(dir)).toEqual([`${LOCK_FILE}.99999.deadbeefdeadbeef`]);
  });

  test("psStartedAtOf returns a string for the current process (or undefined where ps is unavailable), stable across two calls", () => {
    const a = psStartedAtOf(process.pid);
    const b = psStartedAtOf(process.pid);
    expect(a === undefined || a.length > 0).toBe(true);
    expect(a).toBe(b);
  });
});
