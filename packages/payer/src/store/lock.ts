/**
 * lock（設計 §3.7）: `link` 方式の原子的な取得、**自動の回収はしない**（stale は起動せず、人間の `lock reclaim` だけが `unlink` する）、保持者の inode の自己検査。
 *
 * - 取得: 自分だけの一時ファイル `daemon.lock.<pid>.<random>` に `{ pid, startedAt, hostname, token }` を書いて fsync し、`link(temp, daemon.lock)`（既にあれば `EEXIST`）。
 * - `EEXIST`: 中を読んで pid が生きていれば `daemon_already_running`、死んでいれば `daemon_lock_stale`（起動しない）。rename も unlink もしない。
 * - 保持者は副作用の前に `stat(daemon.lock).ino === 自分の inode` を確かめる（人間の誤った reclaim への補助）。
 * - `reclaim`: 人間の CLI だけが呼ぶ。pid が生きていれば拒む。確認は呼び出し側（TTY）。
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";
import path from "node:path";

import { StoreError, type StoreFs } from "./fs.js";

export const LOCK_FILE = "daemon.lock";

export interface LockContent {
  readonly pid: number;
  readonly startedAt: string;
  readonly hostname: string;
  readonly token: string;
}

export interface LockHandle {
  readonly path: string;
  readonly ino: number | bigint;
  readonly content: LockContent;
  /** 保持者の自己検査: lock の path が自分の inode を指しているか。 */
  stillHeld(): boolean;
  release(): void;
}

export interface LockDeps {
  readonly fs: StoreFs;
  /** pid が生きているか（既定は `process.kill(pid, 0)`）。 */
  readonly isAlive?: (pid: number) => boolean;
  /** pid の起動時刻の文字列（既定は `ps -o lstart=`。取れなければ undefined = pid だけで判定）。 */
  readonly startedAtOf?: (pid: number) => string | undefined;
  readonly pid?: number;
  readonly hostname?: string;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 生きているが signal を送れない（別 user）。それも「生きている」。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function psStartedAtOf(pid: number): string | undefined {
  try {
    // 同期で ps を呼ぶ（lock の取得は起動時の 1 回）。引数は固定（shell を経由しない）。
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

function parseLock(text: string): LockContent | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed["pid"] !== "number" || typeof parsed["startedAt"] !== "string" || typeof parsed["hostname"] !== "string" || typeof parsed["token"] !== "string") return undefined;
    return parsed as unknown as LockContent;
  } catch {
    return undefined;
  }
}

/** lock の状態を読む（取得も回収もしない）。 */
export function inspectLock(dir: string, deps: LockDeps): { readonly state: "free" | "held" | "stale" | "unreadable"; readonly content?: LockContent } {
  const lockPath = path.join(dir, LOCK_FILE);
  if (!deps.fs.existsSync(lockPath)) return { state: "free" };
  const content = parseLock(deps.fs.readFileSync(lockPath).toString("utf8"));
  if (content === undefined) return { state: "unreadable" };
  const isAlive = deps.isAlive ?? defaultIsAlive;
  if (!isAlive(content.pid)) return { state: "stale", content };
  const startedAtOf = deps.startedAtOf ?? psStartedAtOf;
  const now = startedAtOf(content.pid);
  // 起動時刻が取れて違えば pid の再利用 = stale。取れなければ pid だけで判定（生きている扱い）。
  if (now !== undefined && content.startedAt !== "" && now !== content.startedAt) return { state: "stale", content };
  return { state: "held", content };
}

/**
 * 取得。失敗は `daemon_already_running` / `daemon_lock_stale` / `lock_unreadable`（どれも起動しない）。
 */
export function acquireLock(dir: string, deps: LockDeps): LockHandle {
  const fs = deps.fs;
  const lockPath = path.join(dir, LOCK_FILE);
  const pid = deps.pid ?? process.pid;
  const startedAtOf = deps.startedAtOf ?? psStartedAtOf;
  const content: LockContent = { pid, startedAt: startedAtOf(pid) ?? "", hostname: deps.hostname ?? osHostname(), token: randomBytes(8).toString("hex") };
  const temp = path.join(dir, `${LOCK_FILE}.${pid}.${content.token}`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeSync(fd, Buffer.from(JSON.stringify(content), "utf8"));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temp, lockPath);
  } catch (error) {
    fs.unlinkSync(temp);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new StoreError("lock_failed");
    const state = inspectLock(dir, deps).state;
    throw new StoreError(state === "held" ? "daemon_already_running" : state === "stale" ? "daemon_lock_stale" : "lock_unreadable");
  }
  fs.unlinkSync(temp);
  const ino = fs.statSync(lockPath).ino;
  return {
    path: lockPath,
    ino,
    content,
    stillHeld() {
      try {
        return fs.statSync(lockPath).ino === ino;
      } catch {
        return false;
      }
    },
    release() {
      try {
        if (fs.statSync(lockPath).ino === ino) fs.unlinkSync(lockPath);
      } catch {
        // 既に無い。
      }
    },
  };
}

/**
 * 人間の回収（CLI `lock reclaim`）。生きている pid は拒む（`daemon_already_running`）。確認（y/N）は呼び出し側の TTY。
 */
export function reclaimLock(dir: string, deps: LockDeps): { readonly removed: boolean; readonly content?: LockContent } {
  const state = inspectLock(dir, deps);
  if (state.state === "free") return { removed: false };
  if (state.state === "held") throw new StoreError("daemon_already_running");
  deps.fs.unlinkSync(path.join(dir, LOCK_FILE));
  return { removed: true, ...(state.content === undefined ? {} : { content: state.content }) };
}
