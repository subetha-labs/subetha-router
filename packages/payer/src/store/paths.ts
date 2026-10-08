/**
 * 設定ディレクトリと store の file の置き場と検査（設計 §3.1 の 4、要件 FR-A3・SR-A6）。
 *
 * - 置き場: `$XDG_CONFIG_HOME/subetha-payer`（既定 `~/.config/subetha-payer`）。project の cwd からは何も読まない。
 * - 検査: `realpath` が `$HOME` の中、owner が自分、ディレクトリは `0700`、file は `0600`、symlink でない。違えば固定のコードで拒む。
 * - agent から渡す引数で path を変えられない（env と home だけ）。
 */

import path from "node:path";

import { StoreError, type StoreFs } from "./fs.js";

export const STORE_FILES = Object.freeze({ keys: "keys.json", ledger: "ledger.ndjson", installSeal: "install.seal", config: "config.json", lock: "daemon.lock", socket: "daemon.sock" });

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
  readonly code: "outside_home" | "symlink" | "owner" | "mode" | "not_directory" | "not_file";
}

/**
 * 設定ディレクトリを検査する（無ければ `0700` で作る）。issue があれば拒む（起動しない）。
 */
export function ensureStoreDir(dir: string, home: string, uid: number, fs: StoreFs): PathIssue[] {
  const issues: PathIssue[] = [];
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const real = fs.realpathSync(dir);
  const realHome = fs.realpathSync(home);
  if (real !== realHome && !real.startsWith(`${realHome}${path.sep}`)) issues.push({ path: dir, code: "outside_home" });
  const lst = fs.lstatSync(dir);
  if (lst.isSymbolicLink()) issues.push({ path: dir, code: "symlink" });
  const st = fs.statSync(dir);
  if (!st.isDirectory()) issues.push({ path: dir, code: "not_directory" });
  if (st.uid !== uid) issues.push({ path: dir, code: "owner" });
  if ((st.mode & 0o077) !== 0) issues.push({ path: dir, code: "mode" });
  for (const name of Object.values(STORE_FILES)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const fl = fs.lstatSync(file);
    if (fl.isSymbolicLink()) {
      issues.push({ path: file, code: "symlink" });
      continue;
    }
    if (fl.uid !== uid) issues.push({ path: file, code: "owner" });
    if ((fl.mode & 0o077) !== 0) issues.push({ path: file, code: "mode" });
    if (name !== STORE_FILES.socket && !fl.isFile()) issues.push({ path: file, code: "not_file" });
  }
  return issues;
}
