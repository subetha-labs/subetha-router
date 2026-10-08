/**
 * lock（設計 §3.7）: `link` 方式の原子的な取得、**自動の回収はしない**（stale は起動せず、人間の `lock reclaim` だけが `unlink` する）、保持者の自己検査。
 *
 * - 取得: 自分だけの一時ファイル `daemon.lock.<pid>.<token>` に `{ pid, startedAt, hostname, token }` を全部書いて fsync し、`link(temp, daemon.lock)`（既にあれば `EEXIST`）。
 *   所有の identity は **一時ファイルの fd の inode と token の組**（inode 番号は unlink の後に再利用されるので inode だけでは足りない。Linux で実測）。
 * - `EEXIST`: 中を読んで pid が生きていれば `daemon_already_running`、死んでいれば `daemon_lock_stale`（起動しない）。rename も unlink もしない。
 * - 保持者は副作用の前に `stillHeld()`（path の inode と中身の token が自分のもの）を確かめる。
 * - `reclaim`: 人間の CLI だけが呼ぶ。**回収は専用の lock（`daemon.lock.reclaim`）で直列化**し、取った後にもう一度検査してから `unlink` する
 *   （2 人の回収者が同じ stale を見て、片方が消した後に新しい daemon が取り、もう片方が新しい lock を消す交錯を防ぐ）。生きている pid は拒む。
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname as osHostname } from "node:os";
import path from "node:path";

import { StoreError, type StoreFs } from "./fs.js";

export const LOCK_FILE = "daemon.lock";
export const RECLAIM_LOCK_FILE = "daemon.lock.reclaim";

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
  /** 保持者の自己検査: lock の path が自分の inode を指し、中身の token が自分のものか。 */
  stillHeld(): boolean;
  release(): void;
}

export interface LockDeps {
  readonly fs: StoreFs;
  /** pid が生きているか（既定は `process.kill(pid, 0)`。EPERM も生きている扱い）。 */
  readonly isAlive?: (pid: number) => boolean;
  /** pid の起動時刻の文字列（既定は `ps -o lstart=`、locale と TZ を固定。取れなければ undefined = pid だけで判定）。 */
  readonly startedAtOf?: (pid: number) => string | undefined;
  readonly pid?: number;
  readonly hostname?: string;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function psStartedAtOf(pid: number): string | undefined {
  try {
    // 同期で ps を呼ぶ（起動時の 1 回）。引数は固定（shell を経由しない）。locale・TZ を固定して文字列を安定させる。
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

function parseLock(text: string): LockContent | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed["pid"] !== "number" || !Number.isSafeInteger(parsed["pid"]) || parsed["pid"] <= 0) return undefined;
    if (typeof parsed["startedAt"] !== "string" || typeof parsed["hostname"] !== "string" || typeof parsed["token"] !== "string" || !/^[0-9a-f]{16}$/.test(parsed["token"])) return undefined;
    return parsed as unknown as LockContent;
  } catch {
    return undefined;
  }
}

function readLock(fs: StoreFs, lockPath: string): LockContent | undefined {
  try {
    return parseLock(fs.readFileSync(lockPath).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** 全バイトを書く（`writeSync` は短い書き込みを返し得る）。 */
function writeAll(fs: StoreFs, fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = fs.writeSync(fd, data.subarray(offset));
    if (written <= 0) throw new StoreError("lock_failed");
    offset += written;
  }
}

/** lock の状態を読む（取得も回収もしない）。読めない・壊れている → `unreadable`。 */
export function inspectLock(dir: string, deps: LockDeps): { readonly state: "free" | "held" | "stale" | "unreadable"; readonly content?: LockContent } {
  const lockPath = path.join(dir, LOCK_FILE);
  let exists: boolean;
  try {
    deps.fs.lstatSync(lockPath);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
    else return { state: "unreadable" };
  }
  if (!exists) return { state: "free" };
  const content = readLock(deps.fs, lockPath);
  if (content === undefined) return { state: "unreadable" };
  const isAlive = deps.isAlive ?? defaultIsAlive;
  if (!isAlive(content.pid)) return { state: "stale", content };
  const startedAtOf = deps.startedAtOf ?? psStartedAtOf;
  const now = startedAtOf(content.pid);
  if (now !== undefined && content.startedAt !== "" && now !== content.startedAt) return { state: "stale", content };
  return { state: "held", content };
}

/** 自分だけの一時ファイルを書いて `link` で `target` を作る。identity（inode・token）を返す。 */
function linkFresh(fs: StoreFs, dir: string, target: string, content: LockContent): { readonly ino: number | bigint } {
  const temp = path.join(dir, `${path.basename(target)}.${content.pid}.${content.token}`);
  const fd = fs.openSync(temp, "wx", 0o600);
  let ino: number | bigint;
  try {
    writeAll(fs, fd, Buffer.from(JSON.stringify(content), "utf8"));
    fs.fsyncSync(fd);
    ino = fs.fstatSync(fd).ino;
  } catch (error) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {
      // 残骸は secret を含まない。次の取得で同じ名前は使わない（token が違う）。
    }
    throw error instanceof StoreError ? error : new StoreError("lock_failed");
  }
  fs.closeSync(fd);
  try {
    fs.linkSync(temp, target);
  } catch (error) {
    fs.unlinkSync(temp);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StoreError("lock_exists");
    throw new StoreError("lock_failed");
  }
  fs.unlinkSync(temp);
  return { ino };
}

function contentOf(deps: LockDeps): LockContent {
  const pid = deps.pid ?? process.pid;
  const startedAtOf = deps.startedAtOf ?? psStartedAtOf;
  return { pid, startedAt: startedAtOf(pid) ?? "", hostname: deps.hostname ?? osHostname(), token: randomBytes(8).toString("hex") };
}

/**
 * 取得。失敗は `daemon_already_running` / `daemon_lock_stale` / `lock_unreadable`（どれも起動しない）。
 */
export function acquireLock(dir: string, deps: LockDeps): LockHandle {
  const fs = deps.fs;
  const lockPath = path.join(dir, LOCK_FILE);
  const content = contentOf(deps);
  let ino: number | bigint;
  try {
    ino = linkFresh(fs, dir, lockPath, content).ino;
  } catch (error) {
    if (error instanceof StoreError && error.code === "lock_exists") {
      const state = inspectLock(dir, deps).state;
      throw new StoreError(state === "held" ? "daemon_already_running" : state === "stale" ? "daemon_lock_stale" : "lock_unreadable");
    }
    throw error;
  }
  const mine = (): boolean => {
    try {
      if (fs.lstatSync(lockPath).ino !== ino) return false;
      return readLock(fs, lockPath)?.token === content.token;
    } catch {
      return false;
    }
  };
  return {
    path: lockPath,
    ino,
    content,
    stillHeld: mine,
    release() {
      // 自分の (inode, token) のときだけ消す。回収者は生きている pid の lock を消さない（reclaim は live を拒む）ので、ここで競合する相手はいない。
      if (mine()) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // 既に無い。
        }
      }
    },
  };
}

/**
 * 人間の回収（CLI `lock reclaim`）。回収の lock を取って直列化し、取った後にもう一度検査してから消す。生きている pid は拒む。
 * 同時にもう 1 人が回収中なら `reclaim_busy`。確認（y/N）は呼び出し側の TTY。
 */
export function reclaimLock(dir: string, deps: LockDeps): { readonly removed: boolean; readonly content?: LockContent } {
  const fs = deps.fs;
  const reclaimPath = path.join(dir, RECLAIM_LOCK_FILE);
  const guard = contentOf(deps);
  try {
    linkFresh(fs, dir, reclaimPath, guard);
  } catch (error) {
    if (error instanceof StoreError && error.code === "lock_exists") {
      // 回収の lock が残っている: 回収者が生きていれば busy、死んでいれば（回収の途中で落ちた）その lock だけを片づけて続ける。
      const holder = readLock(fs, reclaimPath);
      const isAlive = deps.isAlive ?? defaultIsAlive;
      if (holder !== undefined && isAlive(holder.pid)) throw new StoreError("reclaim_busy");
      fs.unlinkSync(reclaimPath);
      linkFresh(fs, dir, reclaimPath, guard);
    } else {
      throw error;
    }
  }
  try {
    const state = inspectLock(dir, deps);
    if (state.state === "free") return { removed: false };
    if (state.state === "held") throw new StoreError("daemon_already_running");
    // stale か unreadable: ここから unlink までの間に lock を作れるのは daemon の取得だけだが、それは file が存在する間は EEXIST で失敗する。
    fs.unlinkSync(path.join(dir, LOCK_FILE));
    return { removed: true, ...(state.content === undefined ? {} : { content: state.content }) };
  } finally {
    try {
      fs.unlinkSync(reclaimPath);
    } catch {
      // 既に無い。
    }
  }
}
