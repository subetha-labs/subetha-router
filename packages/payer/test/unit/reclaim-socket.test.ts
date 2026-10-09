/** Pure file tests: socket metadata and process identity are injected; no socket or child is opened. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { realFs, type StoreFs } from "../../src/store/fs.js";
import { acquireLock, reclaimLock, type LockDeps } from "../../src/store/lock.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "payer-reclaim-socket-")); dirs.push(dir);
  const lock = path.join(dir, "daemon.lock"), socket = path.join(dir, "daemon.sock"), guard = path.join(dir, "daemon.lock.reclaim");
  const content = { pid: 424242, startedAt: "T0", hostname: hostname(), token: "0123456789abcdef" };
  writeFileSync(lock, JSON.stringify(content), { mode: 0o600 });
  writeFileSync(socket, "injected socket", { mode: 0o600 });
  let socketStat = Object.assign(Object.create(realFs.lstatSync(socket)), { isSocket: () => true, isFile: () => false });
  const removed: string[] = [];
  const fs: StoreFs = { ...realFs,
    lstatSync: file => file === socket && realFs.existsSync(file) ? socketStat : realFs.lstatSync(file),
    unlinkSync: file => { if (file === lock || file === socket) removed.push(path.basename(file)); realFs.unlinkSync(file); },
  };
  const deps: LockDeps = { fs, isAlive: () => false, startedAtOf: () => "T0", hostname: hostname() };
  return { dir, lock, socket, guard, content, fs, deps, removed,
    changeSocket: (props: object) => { socketStat = Object.assign(Object.create(socketStat), props); },
  };
}

test("human reclaim removes only the fixed stale socket before releasing its matching lock; three contenders stay excluded", () => {
  const f = fixture();
  const other = path.join(f.dir, "other.sock"); writeFileSync(other, "preserve");
  const fs: StoreFs = { ...f.fs, unlinkSync: file => {
    if (file === f.socket) {
      expect(realFs.existsSync(f.lock)).toBe(true);
      expect(realFs.existsSync(f.guard)).toBe(true);
      for (let i = 0; i < 3; i++) {
        expect(() => acquireLock(f.dir, f.deps)).toThrow("daemon_lock_stale");
        expect(() => reclaimLock(f.dir, f.deps)).toThrow("reclaim_busy");
      }
    }
    if (file === f.lock) expect(realFs.existsSync(f.socket)).toBe(false);
    f.fs.unlinkSync(file);
  } };
  expect(reclaimLock(f.dir, { ...f.deps, fs })).toEqual({ removed: true, content: f.content });
  expect(f.removed).toEqual(["daemon.sock", "daemon.lock"]);
  expect(realFs.existsSync(other)).toBe(true);
  const next = acquireLock(f.dir, f.deps); expect(next.stillHeld()).toBe(true); next.release();
});

test("graceful-close / pre-listen crash with no socket still reclaims the dead lock", () => {
  const f = fixture(); realFs.unlinkSync(f.socket);
  expect(reclaimLock(f.dir, f.deps).removed).toBe(true);
  expect(f.removed).toEqual(["daemon.lock"]);
});

test.each(["regular", "symlink", "owner", "mode", "special mode", "unreadable"])("hostile socket %s preserves socket and stale lock", kind => {
  const f = fixture();
  if (kind === "regular") f.changeSocket({ isSocket: () => false, isFile: () => true });
  if (kind === "symlink") f.changeSocket({ isSymbolicLink: () => true });
  if (kind === "owner") f.changeSocket({ uid: process.getuid!() + 1 });
  if (kind === "mode") f.changeSocket({ mode: 0o100666 });
  if (kind === "special mode") f.changeSocket({ mode: 0o102600 });
  const fs: StoreFs = { ...f.fs, lstatSync: file => {
    if (file === f.socket && kind === "unreadable") throw Object.assign(new Error("injected"), { code: "EIO" });
    return f.fs.lstatSync(file);
  } };
  expect(() => reclaimLock(f.dir, { ...f.deps, fs })).toThrow();
  expect(f.removed).toEqual([]); expect(realFs.existsSync(f.socket)).toBe(true); expect(realFs.existsSync(f.lock)).toBe(true);
});

test.each(["absent", "live", "unknown start", "foreign host", "malformed", "dead guard"])("no socket authority from %s owner", kind => {
  const f = fixture();
  if (kind === "absent") realFs.unlinkSync(f.lock);
  if (kind === "malformed") writeFileSync(f.lock, "garbage");
  if (kind === "foreign host") writeFileSync(f.lock, JSON.stringify({ ...f.content, hostname: "other-host" }));
  if (kind === "dead guard") writeFileSync(f.guard, JSON.stringify(f.content), { mode: 0o600 });
  const deps = { ...f.deps, isAlive: () => kind === "live" || kind === "unknown start", startedAtOf: () => kind === "unknown start" ? undefined : "T0" };
  if (kind === "absent") expect(reclaimLock(f.dir, deps)).toEqual({ removed: false });
  else expect(() => reclaimLock(f.dir, deps)).toThrow();
  expect(f.removed).toEqual([]); expect(realFs.existsSync(f.socket)).toBe(true);
  if (kind === "dead guard") expect(realFs.existsSync(f.guard)).toBe(true);
});

test.each(["symlink", "owner", "mode", "not directory"])("invalid store %s does not authorize socket cleanup", kind => {
  const f = fixture();
  const fs: StoreFs = { ...f.fs, lstatSync: file => {
    const stat = f.fs.lstatSync(file);
    if (file !== f.dir) return stat;
    return Object.assign(Object.create(stat), kind === "symlink" ? { isSymbolicLink: () => true } : kind === "owner" ? { uid: stat.uid + 1 } : kind === "mode" ? { mode: 0o40777 } : { isDirectory: () => false });
  } };
  expect(() => reclaimLock(f.dir, { ...f.deps, fs })).toThrow(); expect(f.removed).toEqual([]);
});

test.each(["socket inode", "socket owner", "socket missing", "socket unreadable", "lock inode", "lock token", "lock unreadable", "store inode", "owner live"])("rechecks %s at the socket side-effect boundary", change => {
  const f = fixture(); let socketReads = 0; let changed = false;
  const fs: StoreFs = { ...f.fs,
    lstatSync: file => {
      const stat = f.fs.lstatSync(file);
      if (file === f.socket && ++socketReads === 1) changed = true;
      if (changed && file === f.lock && change === "lock inode") return Object.assign(Object.create(stat), { ino: stat.ino + 1 });
      if (changed && file === f.dir && change === "store inode") return Object.assign(Object.create(stat), { ino: stat.ino + 1 });
      if (file === f.socket && socketReads > 1) {
        if (change === "socket missing" || change === "socket unreadable") throw Object.assign(new Error("injected"), { code: change === "socket missing" ? "ENOENT" : "EIO" });
        if (change === "socket inode") return Object.assign(Object.create(stat), { ino: stat.ino + 1 });
        if (change === "socket owner") return Object.assign(Object.create(stat), { uid: stat.uid + 1 });
      }
      return stat;
    },
    readFileSync: file => {
      if (changed && file === f.lock && change === "lock unreadable") throw new Error("injected");
      if (changed && file === f.lock && change === "lock token") return Buffer.from(JSON.stringify({ ...f.content, token: "fedcba9876543210" }));
      return f.fs.readFileSync(file);
    },
  };
  expect(() => reclaimLock(f.dir, { ...f.deps, fs, isAlive: () => changed && change === "owner live" })).toThrow();
  expect(f.removed).toEqual([]); expect(realFs.existsSync(f.socket)).toBe(true); expect(realFs.existsSync(f.lock)).toBe(true);
});

test("socket unlink failure retains the matched stale lock and allows a later human reclaim", () => {
  const f = fixture();
  const fs: StoreFs = { ...f.fs, unlinkSync: file => { if (file === f.socket) throw new Error("injected"); f.fs.unlinkSync(file); } };
  expect(() => reclaimLock(f.dir, { ...f.deps, fs })).toThrow();
  expect(f.removed).toEqual([]); expect(realFs.existsSync(f.guard)).toBe(false);
  expect(reclaimLock(f.dir, f.deps).removed).toBe(true); expect(f.removed).toEqual(["daemon.sock", "daemon.lock"]);
});

test.each(["symlink", "owner", "mode"])("unsafe lock %s never authorizes socket deletion", kind => {
  const f = fixture();
  const fs: StoreFs = { ...f.fs, lstatSync: file => {
    const stat = f.fs.lstatSync(file);
    if (file !== f.lock) return stat;
    return Object.assign(Object.create(stat), kind === "symlink" ? { isSymbolicLink: () => true } : kind === "owner" ? { uid: stat.uid + 1 } : { mode: 0o100644 });
  } };
  expect(() => reclaimLock(f.dir, { ...f.deps, fs })).toThrow(); expect(f.removed).toEqual([]);
});

test("daemon acquisition never auto-reclaims a dead owner's socket", () => {
  const f = fixture();
  expect(() => acquireLock(f.dir, f.deps)).toThrow("daemon_lock_stale");
  expect(f.removed).toEqual([]); expect(realFs.existsSync(f.socket)).toBe(true);
});

test("a reused live pid with a different start time still cannot authorize socket removal", () => {
  const f = fixture();
  expect(() => reclaimLock(f.dir, { ...f.deps, isAlive: () => true, startedAtOf: () => "T1" })).toThrow("daemon_already_running");
  expect(f.removed).toEqual([]);
});

test.each(["ESRCH", "EPERM", "EIO", "EINVAL", undefined])("default liveness probe accepts only positive death: %s (injected, no OS signal)", code => {
  const f = fixture();
  const probe = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("injected probe"), { code }); });
  const { isAlive: _isAlive, ...deps } = f.deps;
  try {
    if (code === "ESRCH") expect(reclaimLock(f.dir, deps).removed).toBe(true);
    else { expect(() => reclaimLock(f.dir, deps)).toThrow("daemon_already_running"); expect(f.removed).toEqual([]); }
    expect(probe).toHaveBeenCalledWith(f.content.pid, 0);
  } finally { probe.mockRestore(); }
});
