import path from "node:path";
import { fileURLToPath } from "node:url";
import { realFs, StoreError, type StoreFs } from "../store/fs.js";
import { acquireLock, inspectLock, type LockDeps } from "../store/lock.js";
import { ensureStoreDir, storeDirOf } from "../store/paths.js";
import { TerminalSecrets } from "../daemon/tty.js";
import { createDaemonClient, type DaemonClient } from "../shim/client.js";
import { KNOWN_CODES } from "../protocol/summary.js";
import type { Router } from "../router/client.js";

/** Trusted module composition only. No CLI/env switch accepts any of these dependencies. */
export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  fs?: StoreFs;
  lockDeps?: Omit<LockDeps, "fs">;
  tty?: { readonly available: boolean; read(label: string): Promise<string> };
  client?: () => DaemonClient;
  router?: Router;
  installRoot?: string;
  randomKey?: () => Buffer;
  randomSolanaKey?: () => Buffer;
  /** Owned fixture transport for `wallet balance` (RPC reads only; never a signer or Router path). */
  fetchRpc?: typeof fetch;
  /** Owned crash fixtures only (install accept); bin.ts never supplies it. */
  faults?: { hit(point: string): Promise<void> };
  uiCheck?: (verify: (pass: string) => boolean) => { available(): Promise<boolean>; check(text: string): Promise<unknown> };
}
export function resources(deps: CliDeps) {
  const env = deps.env ?? process.env, fs = deps.fs ?? realFs;
  const dir = storeDirOf({ HOME: env.HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME });
  if (ensureStoreDir(dir, env.HOME!, process.getuid!(), fs).length) throw new StoreError("path_invalid");
  return { env, fs, dir, lockDeps: { fs, ...deps.lockDeps }, tty: deps.tty ?? new TerminalSecrets(),
    installRoot: deps.installRoot ?? fileURLToPath(new URL("../../", import.meta.url)) };
}
export function requireTty(tty: { readonly available: boolean }): void { if (!tty.available) throw new StoreError("no_tty"); }
export function assertFreeSocket(dir: string, fs: StoreFs): void {
  if (fs.existsSync(path.join(dir, "daemon.sock"))) throw new StoreError("daemon_lock_stale");
}
export async function withLock<T>(deps: CliDeps, action: (r: ReturnType<typeof resources>, held: () => void) => Promise<T>): Promise<T> {
  const r = resources(deps);
  // A leftover reclaim guard requires offline recovery before a new human operation.
  try { r.fs.lstatSync(path.join(r.dir, "daemon.lock.reclaim")); throw new StoreError("reclaim_busy"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lock = acquireLock(r.dir, r.lockDeps);
  const held = () => { if (!lock.stillHeld()) throw new StoreError("lock_lost"); };
  try { held(); assertFreeSocket(r.dir, r.fs); return await action(r, held); }
  finally { lock.release(); }
}
export async function daemonRead(deps: CliDeps, method: "wallet" | "inspect", params: Record<string, unknown>): Promise<unknown | undefined> {
  const r = resources(deps), state = inspectLock(r.dir, r.lockDeps).state;
  if (state === "free") { assertFreeSocket(r.dir, r.fs); return undefined; }
  if (state !== "held") throw new StoreError(state === "stale" ? "daemon_lock_stale" : "lock_unreadable");
  const client = deps.client?.() ?? createDaemonClient({ HOME: r.env.HOME, XDG_CONFIG_HOME: r.env.XDG_CONFIG_HOME });
  try { return await client.request(method, params); } finally { await client.close(); }
}
const SAFE_CODES = new Set([...KNOWN_CODES, "invalid_arguments", "path_invalid", "path_unreadable", "home_unavailable", "wallet_invalid", "wallet_missing", "wallet_exists", "passphrase_invalid", "passphrase_mismatch", "tty_cancelled", "config_invalid", "lock_unreadable", "lock_failed", "reclaim_busy", "socket_reclaim_refused", "operator_cancelled", "reason_invalid", "rpc_failed", "install_unreadable", "install_seal_corrupt", "install_seal_missing"]);
export async function cliRun(action: () => Promise<void>): Promise<number> {
  try { await action(); return 0; }
  catch (error) {
    const code = error instanceof StoreError && SAFE_CODES.has(error.code) ? error.code : "internal_error";
    process.stderr.write(`cli_refused: ${code}\n`);
    if (code === "reclaim_busy") process.stderr.write("Stop ALL contenders. Human offline recovery is required for the leftover reclaim guard. It is never automatically deleted.\n");
    return 2;
  }
}
export function invalid(): never { throw new StoreError("invalid_arguments"); }
export function output(value: unknown): void { process.stdout.write(JSON.stringify(value) + "\n"); }
/** Exclusive create or atomic replacement, sync data then directory; caller holds store lock. */
export function writeDocument(dir: string, name: string, value: unknown, fs: StoreFs, held: () => void, replace = false): void {
  const target = path.join(dir, name), temp = replace ? target + ".new" : target;
  held();
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    for (let offset = 0; offset < bytes.length;) {
      const written = fs.writeSync(fd, bytes.subarray(offset));
      if (written <= 0) throw new StoreError("store_write_failed");
      offset += written;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  held(); if (replace) fs.renameSync(temp, target);
  const directory = fs.openSync(dir, "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
