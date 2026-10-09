import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { storeDirOf, type PathsEnv } from "../store/paths.js";

/** Inspect only directory/socket metadata. Never create a store or read keys/config/ledger. */
export function socketPathOf(env: PathsEnv): string {
  const dir = storeDirOf(env);
  const home = realpathSync(env.HOME!);
  const realDir = realpathSync(dir);
  if (!realDir.startsWith(home + path.sep)) throw new Error("daemon_unavailable");
  const directory = lstatSync(dir);
  if (directory.isSymbolicLink() || !directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) throw new Error("daemon_unavailable");
  const socket = path.join(dir, "daemon.sock");
  const st = lstatSync(socket);
  if (st.isSymbolicLink() || !st.isSocket() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600) throw new Error("daemon_unavailable");
  return socket;
}
