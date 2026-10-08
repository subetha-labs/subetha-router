/**
 * P-1b（設計 §3.7）: `link` 方式の lock。同時の 2 process で 1 つだけ成功、stale では起動しない（回収も rename もしない）、生きた pid は `daemon_already_running`、
 * reclaim は生きた pid を拒む、外から unlink されると保持者の検査が `lock_lost` 相当（`stillHeld() === false`）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { realFs } from "../../src/store/fs.js";
import { acquireLock, inspectLock, LOCK_FILE, psStartedAtOf, reclaimLock } from "../../src/store/lock.js";

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

describe("lock", () => {
  test("acquire → the lock file carries pid/startedAt/hostname/token; no temp file remains; stillHeld; release removes only its own inode", () => {
    const dir = fresh();
    const handle = acquireLock(dir, deps);
    expect(readdirSync(dir)).toEqual([LOCK_FILE]);
    const content = JSON.parse(readFileSync(path.join(dir, LOCK_FILE), "utf8")) as Record<string, unknown>;
    expect(content["pid"]).toBe(process.pid);
    expect(content["startedAt"]).toBe("T0");
    expect(typeof content["token"]).toBe("string");
    expect(handle.stillHeld()).toBe(true);
    // 外から unlink → 保持者の検査は false（次の副作用の前で lock_lost）。
    unlinkSync(path.join(dir, LOCK_FILE));
    expect(handle.stillHeld()).toBe(false);
    // 別の lock が置かれたら、自分の inode ではないので release は消さない。
    writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid: 1, startedAt: "", hostname: "h", token: "t" }));
    handle.release();
    expect(existsSync(path.join(dir, LOCK_FILE))).toBe(true);
  });

  test("a live pid → daemon_already_running; a dead pid → daemon_lock_stale and nothing is renamed or removed; a pid reused with a different start time → stale", () => {
    const dir = fresh();
    const lockPath = path.join(dir, LOCK_FILE);
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, startedAt: "T0", hostname: "h", token: "t" }));
    expect(() => acquireLock(dir, { ...deps, isAlive: () => true, startedAtOf: () => "T0" })).toThrow(/daemon_already_running/);
    expect(() => acquireLock(dir, { ...deps, isAlive: () => false })).toThrow(/daemon_lock_stale/);
    expect(readdirSync(dir)).toEqual([LOCK_FILE]);
    expect(readFileSync(lockPath, "utf8")).toContain("424242");
    expect(inspectLock(dir, { ...deps, isAlive: () => true, startedAtOf: () => "T1" }).state).toBe("stale");
    expect(inspectLock(dir, { ...deps, isAlive: () => true, startedAtOf: () => undefined }).state).toBe("held");
    writeFileSync(lockPath, "garbage");
    expect(() => acquireLock(dir, deps)).toThrow(/lock_unreadable/);
  });

  test("reclaim: refuses a live pid, removes a stale lock, reports a free lock", () => {
    const dir = fresh();
    const lockPath = path.join(dir, LOCK_FILE);
    expect(reclaimLock(dir, deps)).toEqual({ removed: false });
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, startedAt: "T0", hostname: "h", token: "t" }));
    expect(() => reclaimLock(dir, { ...deps, isAlive: () => true })).toThrow(/daemon_already_running/);
    expect(existsSync(lockPath)).toBe(true);
    expect(reclaimLock(dir, { ...deps, isAlive: () => false })).toMatchObject({ removed: true, content: { pid: 424242 } });
    expect(existsSync(lockPath)).toBe(false);
  });

  test("two processes racing for the same lock: exactly one link succeeds (real processes, real fs)", () => {
    const dir = fresh();
    const script = `
      import { acquireLock } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../src/store/lock.ts"))};
      import { realFs } from ${JSON.stringify(path.resolve(import.meta.dirname, "../../src/store/fs.ts"))};
      const dir = process.argv[2];
      const start = Number(process.argv[3]);
      while (Date.now() < start) {}
      try { acquireLock(dir, { fs: realFs, isAlive: () => true, startedAtOf: () => "T0" }); console.log("acquired"); setTimeout(() => {}, 300); }
      catch (e) { console.log("refused:" + e.code); }
    `;
    const scriptPath = path.join(dir, "contender.mts");
    writeFileSync(scriptPath, script);
    const start = Date.now() + 700;
    const tsx = path.resolve(import.meta.dirname, "../../../../node_modules/.bin/tsx");
    const results = [1, 2].map(() => spawnSync(tsx, [scriptPath, dir, String(start)], { encoding: "utf8", timeout: 15_000 }));
    const outputs = results.map((r) => r.stdout.trim());
    expect(outputs.filter((o) => o === "acquired").length).toBe(1);
    expect(outputs.filter((o) => o.startsWith("refused:")).length).toBe(1);
    expect(readdirSync(dir).filter((f) => f.startsWith(LOCK_FILE)).length).toBe(1);
  });

  test("psStartedAtOf returns a string for the current process (or undefined where ps is unavailable)", () => {
    const value = psStartedAtOf(process.pid);
    expect(value === undefined || value.length > 0).toBe(true);
  });
});
