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

import { realFs, type StoreFs } from "../../src/store/fs.js";
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

  test("reclaim: refuses a live pid, recovers a dead daemon, reports a free lock, and fails closed on an existing reclaim guard", () => {
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
    // 回収者自身が落ちた guard は自動で消さない（check → unlink は原子的ではない）。
    expect(() => reclaimLock(dir, { ...deps, isAlive: () => false })).toThrow(/reclaim_busy/);
    expect(existsSync(lockPath)).toBe(true);
    // 他の process が無い試験内で残骸を取り除く。普通の daemon crash は引き続き回収できる。
    unlinkSync(path.join(dir, RECLAIM_LOCK_FILE));
    expect(reclaimLock(dir, { ...deps, isAlive: () => false })).toMatchObject({ removed: true, content: { pid: 424242 } });
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(path.join(dir, RECLAIM_LOCK_FILE)), "the reclaim guard is released").toBe(false);
    // 回収の lock を取った後の再検査: 検査の前に新しい daemon が取っていれば消さない（取った後は EEXIST で誰も取れないので、この順序で十分）。
    const handle = acquireLock(dir, deps);
    expect(() => reclaimLock(dir, deps)).toThrow(/daemon_already_running/);
    expect(handle.stillHeld()).toBe(true);
    handle.release();
  });

  test("reclaim sees A, then A releases, read fails ENOENT, and B acquires: B remains the sole owner", () => {
    const dir = fresh();
    const lockPath = path.join(dir, LOCK_FILE);
    const a = acquireLock(dir, deps);
    let b: ReturnType<typeof acquireLock> | undefined;
    const events: string[] = [];
    const interleaved: StoreFs = {
      ...realFs,
      lstatSync: (file) => {
        const stat = realFs.lstatSync(file);
        if (file === lockPath) {
          expect(stat.ino).toBe(a.ino);
          events.push("lstat A");
          a.release();
          events.push("A released");
        }
        return stat;
      },
      readFileSync: (file) => {
        try {
          return realFs.readFileSync(file);
        } catch (error) {
          expect(file).toBe(lockPath);
          expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
          events.push("read ENOENT");
          b = acquireLock(dir, deps);
          events.push("B acquired");
          throw error;
        }
      },
    };
    expect.soft(() => reclaimLock(dir, { ...deps, fs: interleaved })).toThrow(/lock_unreadable/);
    expect(events).toEqual(["lstat A", "A released", "read ENOENT", "B acquired"]);
    expect.soft(a.stillHeld()).toBe(false);
    a.release();
    expect.soft(b?.stillHeld()).toBe(true);
    expect.soft(() => acquireLock(dir, deps)).toThrow(/daemon_already_running/);
    expect.soft(readdirSync(dir)).toEqual([LOCK_FILE]);
    b?.release();
  });

  test("reclaim reads A successfully, A releases/exits, B acquires, then A is reported dead: B remains the sole owner", () => {
    const dir = fresh();
    const lockPath = path.join(dir, LOCK_FILE);
    const a = acquireLock(dir, { ...deps, pid: 424242 });
    let b: ReturnType<typeof acquireLock> | undefined;
    const events: string[] = [];
    const interleaved: StoreFs = {
      ...realFs,
      readFileSync: (file) => {
        const snapshot = realFs.readFileSync(file);
        if (file === lockPath) events.push(b === undefined ? "read A" : "read B");
        return snapshot;
      },
    };
    expect.soft(() => reclaimLock(dir, {
      ...deps,
      fs: interleaved,
      isAlive: (pid) => {
        expect(pid).toBe(a.content.pid);
        expect(events).toEqual(["read A"]);
        a.release();
        events.push("A released/exited");
        b = acquireLock(dir, deps);
        events.push("B acquired", "A dead result");
        // The injected liveness result models A exiting after its successful read.
        return false;
      },
    })).toThrow(/lock_unreadable/);
    expect.soft(events).toEqual(["read A", "A released/exited", "B acquired", "A dead result", "read B"]);
    expect.soft(a.stillHeld()).toBe(false);
    a.release();
    expect.soft(b?.stillHeld()).toBe(true);
    expect.soft(() => acquireLock(dir, deps)).toThrow(/daemon_already_running/);
    expect.soft(readdirSync(dir)).toEqual([LOCK_FILE]);
    b?.release();
  });

  test.each(["absent", "read error", "malformed", "pid", "startedAt", "hostname", "token"] as const)("reclaim rechecks the stale snapshot: %s refuses without unlinking the current path", (change) => {
    const dir = fresh();
    const lockPath = path.join(dir, LOCK_FILE);
    const recorded = { pid: 424242, startedAt: "T0", hostname: "h", token: TOKEN };
    writeFileSync(lockPath, JSON.stringify(recorded));
    let reads = 0;
    let unlinks = 0;
    const interleaved: StoreFs = {
      ...realFs,
      readFileSync: (file) => {
        if (file === lockPath && ++reads === 2 && change === "read error") {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        }
        return realFs.readFileSync(file);
      },
      unlinkSync: (file) => {
        if (file === lockPath) unlinks++;
        realFs.unlinkSync(file);
      },
    };
    let expected = JSON.stringify(recorded);
    expect.soft(() => reclaimLock(dir, {
      ...deps,
      fs: interleaved,
      isAlive: (pid) => {
        expect(pid).toBe(recorded.pid);
        expect(reads).toBe(1);
        if (change === "absent") unlinkSync(lockPath);
        else if (change !== "read error") {
          const replacements = { pid: process.pid, startedAt: "T1", hostname: "other", token: "fedcba9876543210" };
          expected = change === "malformed" ? "garbage" : JSON.stringify({ ...recorded, [change]: replacements[change] });
          writeFileSync(lockPath, expected);
        }
        return false;
      },
    })).toThrow(/lock_unreadable/);
    expect.soft(reads).toBe(2);
    expect.soft(unlinks).toBe(0);
    expect.soft(existsSync(path.join(dir, RECLAIM_LOCK_FILE))).toBe(false);
    if (change === "absent") expect(existsSync(lockPath)).toBe(false);
    else expect(readFileSync(lockPath, "utf8")).toBe(expected);
  });

  test("reclaim refuses a transient read error on a live lock and cleans up only its guard", () => {
    const dir = fresh();
    const lockPath = path.join(dir, LOCK_FILE);
    const handle = acquireLock(dir, deps);
    const before = readFileSync(lockPath);
    let failedReads = 0;
    const flaky: StoreFs = {
      ...realFs,
      readFileSync: (file) => {
        if (file === lockPath && failedReads++ === 0) throw Object.assign(new Error("EIO"), { code: "EIO" });
        return realFs.readFileSync(file);
      },
    };
    expect.soft(() => reclaimLock(dir, { ...deps, fs: flaky })).toThrow(/lock_unreadable/);
    expect(failedReads).toBe(1);
    expect.soft(handle.stillHeld()).toBe(true);
    expect.soft(readdirSync(dir)).toEqual([LOCK_FILE]);
    expect(readFileSync(lockPath)).toEqual(before);
    expect(() => acquireLock(dir, deps)).toThrow(/daemon_already_running/);
    handle.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("reclaim preserves an unreadable malformed lock and releases its guard", () => {
    const dir = fresh();
    const lockPath = path.join(dir, LOCK_FILE);
    writeFileSync(lockPath, "garbage");
    expect.soft(() => reclaimLock(dir, deps)).toThrow(/lock_unreadable/);
    expect.soft(readdirSync(dir)).toEqual([LOCK_FILE]);
    expect(readFileSync(lockPath, "utf8")).toBe("garbage");
  });

  test.each(["after read", "before unlink"])("stale-guard interleaving %s: a delayed reclaimer must not unlink a successor's live guard", (pause) => {
    const dir = fresh();
    const guardPath = path.join(dir, RECLAIM_LOCK_FILE);
    const lockPath = path.join(dir, LOCK_FILE);
    const dead = JSON.stringify({ pid: 424242, startedAt: "T0", hostname: "h", token: TOKEN });
    writeFileSync(guardPath, dead);
    writeFileSync(lockPath, dead);
    let expectedGuard = dead;
    let removedLiveGuard = false;
    const replaceGuard = () => {
      // B has observed the dead guard. A replaces it before B resumes.
      const temp = path.join(dir, "successor-guard");
      expectedGuard = JSON.stringify({ pid: process.pid, startedAt: "T0", hostname: "h", token: "fedcba9876543210" });
      writeFileSync(temp, expectedGuard);
      realFs.unlinkSync(guardPath);
      realFs.linkSync(temp, guardPath);
      realFs.unlinkSync(temp);
    };
    const interleaved: StoreFs = {
      ...realFs,
      readFileSync: (file) => {
        const snapshot = realFs.readFileSync(file);
        if (file === guardPath && expectedGuard === dead && pause === "after read") replaceGuard();
        return snapshot;
      },
      unlinkSync: (file) => {
        // This schedule occurs AFTER any inode/token re-check, immediately
        // before the syscall: check-then-unlink cannot fix the race.
        if (file === guardPath && expectedGuard === dead && pause === "before unlink") replaceGuard();
        if (file === guardPath && expectedGuard !== dead) removedLiveGuard = true;
        realFs.unlinkSync(file);
      },
    };
    // A safe implementation refuses at EEXIST, before even reaching the
    // stale-read schedule. The old implementation deletes A's live guard.
    expect.soft(() => reclaimLock(dir, { ...deps, fs: interleaved })).toThrow(/reclaim_busy/);
    expect.soft(removedLiveGuard).toBe(false);
    expect.soft(existsSync(guardPath)).toBe(true);
    if (existsSync(guardPath)) expect(readFileSync(guardPath, "utf8")).toBe(expectedGuard);
    expect.soft(existsSync(lockPath)).toBe(true);
    if (existsSync(lockPath)) expect(readFileSync(lockPath, "utf8")).toBe(dead);
  });

  test("the live reclaim owner alone cleans up its guard; a nested contender cannot enter or remove it", () => {
    const dir = fresh();
    const lockPath = path.join(dir, LOCK_FILE);
    const guardPath = path.join(dir, RECLAIM_LOCK_FILE);
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, startedAt: "T0", hostname: "h", token: TOKEN }));
    let contenders = 0;
    const interleaved: StoreFs = {
      ...realFs,
      unlinkSync: (file) => {
        if (file === lockPath || file === guardPath) {
          const before = readFileSync(guardPath, "utf8");
          expect(() => reclaimLock(dir, deps)).toThrow(/reclaim_busy/);
          expect(readFileSync(guardPath, "utf8")).toBe(before);
          contenders++;
        }
        realFs.unlinkSync(file);
      },
    };
    expect(reclaimLock(dir, { ...deps, fs: interleaved }).removed).toBe(true);
    expect(contenders).toBe(2);
    expect(existsSync(guardPath)).toBe(false);
    const handle = acquireLock(dir, deps);
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
    const tsxLoader = import.meta.resolve("tsx");
    const start = Date.now() + 1500;
    const run = (): Promise<{ out: string; err: string; code: number | null }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", tsxLoader, scriptPath, dir, String(start)], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ out: out.trim(), err, code }));
      });
    const results = await Promise.all([run(), run(), run()]);
    for (const result of results) expect(result.code, result.err).toBe(0);
    const outputs = results.map((result) => result.out);
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
