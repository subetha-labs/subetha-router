/**
 * 設定ディレクトリと store の file の置き場と検査（設計 §3.1 の 4、要件 FR-A3・SR-A6）。
 *
 * - 置き場: `$XDG_CONFIG_HOME/subetha-payer`（既定 `~/.config/subetha-payer`）。project の cwd からは何も読まない。
 * - 検査は**作る前に**行う（home の外なら作らない）。`lstat` で見る（dangling な symlink も symlink として拒む。`existsSync` は symlink を辿る）。
 * - ディレクトリは **ちょうど** `0700`、file は **ちょうど** `0600`、socket は socket であること。owner は自分。
 * - 祖先の symlink（例: macOS の `/var` → `/private/var`）は realpath の包含で扱う。同じ uid の agent が path を差し替えることは防げない（要件 T4′）。
 */

import path from "node:path";

import { StoreError, type StoreFs } from "./fs.js";

export const STORE_FILES = Object.freeze({ keys: "keys.json", ledger: "ledger.ndjson", installSeal: "install.seal", installSealPrev: "install.seal.prev", config: "config.json", lock: "daemon.lock", socket: "daemon.sock" });

export interface PathsEnv {
  readonly XDG_CONFIG_HOME?: string | undefined;
  readonly HOME?: string | undefined;
}

export function storeDirOf(env: PathsEnv): string {
  const home = env.HOME;
  if (home === undefined || home === "" || !path.isAbsolute(home)) throw new StoreError("home_unavailable");
  const base = env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== "" && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  return path.join(base, "subetha-payer");
}

export interface PathIssue {
  readonly path: string;
  readonly code: "outside_home" | "symlink" | "owner" | "mode" | "not_directory" | "not_file" | "not_socket";
}

/** 一番深い既存の祖先の realpath に、残りの要素を足したもの（まだ無い path の正準形）。 */
function canonicalOf(fs: StoreFs, target: string): string {
  let current = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      fs.lstatSync(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new StoreError("path_unreadable");
      rest.unshift(path.basename(current));
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return path.join(fs.realpathSync(current), ...rest);
}

function lstatOrAbsent(fs: StoreFs, file: string): ReturnType<StoreFs["lstatSync"]> | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new StoreError("path_unreadable");
  }
}

/**
 * 設定ディレクトリを検査する。home の中でなければ**作らずに**拒む。無ければ `0700` で作る。issue があれば拒む（起動しない）。
 */
export function ensureStoreDir(dir: string, home: string, uid: number, fs: StoreFs): PathIssue[] {
  const issues: PathIssue[] = [];
  const homeStat = lstatOrAbsent(fs, home);
  if (homeStat === undefined) throw new StoreError("home_unavailable");
  const realHome = fs.realpathSync(home);
  const canonical = canonicalOf(fs, dir);
  if (canonical !== realHome && !canonical.startsWith(`${realHome}${path.sep}`)) {
    return [{ path: dir, code: "outside_home" }];
  }
  if (lstatOrAbsent(fs, dir) === undefined) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const lst = fs.lstatSync(dir);
  if (lst.isSymbolicLink()) issues.push({ path: dir, code: "symlink" });
  if (!lst.isDirectory() && !lst.isSymbolicLink()) issues.push({ path: dir, code: "not_directory" });
  if (lst.uid !== uid) issues.push({ path: dir, code: "owner" });
  if ((lst.mode & 0o777) !== 0o700) issues.push({ path: dir, code: "mode" });
  for (const name of Object.values(STORE_FILES)) {
    const file = path.join(dir, name);
    const fl = lstatOrAbsent(fs, file);
    if (fl === undefined) continue;
    if (fl.isSymbolicLink()) {
      issues.push({ path: file, code: "symlink" });
      continue;
    }
    if (fl.uid !== uid) issues.push({ path: file, code: "owner" });
    if ((fl.mode & 0o777) !== 0o600) issues.push({ path: file, code: "mode" });
    if (name === STORE_FILES.socket) {
      if (!fl.isSocket()) issues.push({ path: file, code: "not_socket" });
    } else if (!fl.isFile()) {
      issues.push({ path: file, code: "not_file" });
    }
  }
  return issues;
}
