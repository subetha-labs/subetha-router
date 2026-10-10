/**
 * Follow-up FR-F2 / AC-F2: `subetha-payer install accept` (unit, in process).
 * Crash, PTY and compiled-bin rows are in test/wire/install-accept.test.ts.
 */
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return { ...actual, openWallet: vi.fn(actual.openWallet) };
});
import { openWallet, parseKeysDocument, unlockKeys, zero } from "../../src/store/keys.js";
import { checkInstallSeal, InstallChanged, installHashes, readSealManifest } from "../../src/daemon/seal.js";
import { INSTALL_CHANGED_GUIDANCE, startupMessage } from "../../src/daemon/run.js";
import { startDaemon } from "../../src/daemon/startup.js";
import { runInstall } from "../../src/cli/install.js";
import { realFs, type StoreFs } from "../../src/store/fs.js";
import { Request } from "../../src/protocol/socket.js";
import type { CliDeps } from "../../src/cli/common.js";
import { fixtureStore, type FixtureStore } from "../harness/store.js";

const stores: FixtureStore[] = [];
let out = "", err = "";
beforeEach(() => {
  out = ""; err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { err += String(chunk); return true; });
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(openWallet).mockClear(); for (const s of stores.splice(0)) s.cleanup(); });

/** A store whose seal matches the fixture install, plus a package.json with a version. */
function sealed(version = "0.1.2") {
  const store = fixtureStore(); stores.push(store);
  writeFileSync(path.join(store.installRoot, "package.json"), JSON.stringify({ name: "@subetha/payer", version }));
  const keys = unlockKeys(parseKeysDocument(readFileSync(path.join(store.dir, "keys.json"), "utf8")), store.passphrase);
  try { checkInstallSeal(path.join(store.dir, "install.seal"), installHashes(store.installRoot, realFs), keys.lek, realFs, () => {}); }
  finally { zero(keys.kek, keys.lek); }
  return store;
}
const sealFile = (s: FixtureStore) => path.join(s.dir, "install.seal");
const prevFile = (s: FixtureStore) => path.join(s.dir, "install.seal.prev");
function upgrade(s: FixtureStore) {
  writeFileSync(path.join(s.installRoot, "dist", "entry.js"), "upgraded bytes\n");
  writeFileSync(path.join(s.installRoot, "dist", "added.js"), "new file\n");
  unlinkSync(path.join(s.installRoot, "node_modules", "dependency.js"));
}
function deps(s: FixtureStore, answers: string[], extra: Partial<CliDeps> = {}): CliDeps & { reads: string[] } {
  const reads: string[] = [];
  return { env: { HOME: s.home }, installRoot: s.installRoot,
    lockDeps: { startedAtOf: () => "fixture-start", isAlive: () => false },
    tty: { available: true, read: async (label) => { reads.push(label); return answers.shift() ?? ""; } }, reads, ...extra };
}
const lek = (s: FixtureStore) => unlockKeys(parseKeysDocument(readFileSync(path.join(s.dir, "keys.json"), "utf8")), s.passphrase).lek;
const tempLeft = (s: FixtureStore) => readdirSync(s.dir).filter(name => name.endsWith(".new"));

test("success: lists added/removed/changed and version on stderr, one JSON line on stdout, keeps the previous seal, daemon then starts", async () => {
  const s = sealed(); const before = readFileSync(sealFile(s)); upgrade(s);
  const d = deps(s, [s.passphrase, "ACCEPT"]);
  expect(await runInstall(["accept"], d)).toBe(0);
  expect(d.reads).toEqual(["Passphrase", "Type ACCEPT to seal this installation"]);
  expect(out).toBe('{"ok":true,"changed":3,"version":"0.1.2"}\n');
  expect(err).toContain("Installed @subetha/payer version: 0.1.2");
  expect(err).toContain('Added: ["dist/added.js"]');
  expect(err).toContain('Removed: ["node_modules/dependency.js"]');
  expect(err).toContain('Changed: ["dist/entry.js"]');
  expect(err).not.toContain(s.passphrase);
  expect(readFileSync(prevFile(s)).equals(before)).toBe(true);
  expect(readSealManifest(sealFile(s), lek(s), realFs)).toEqual(installHashes(s.installRoot, realFs));
  expect((readFileSync(prevFile(s)).length > 0) && (statMode(prevFile(s)) === 0o600) && (statMode(sealFile(s)) === 0o600)).toBe(true);
  expect(tempLeft(s)).toEqual([]);
  expect(openWallet).not.toHaveBeenCalled();
  // The daemon accepts the new installation.
  const events: string[] = [];
  const daemon = await startDaemon({ env: { HOME: s.home }, execArgv: ["--disable-sigusr1"], installRoot: s.installRoot,
    lockDeps: { startedAtOf: () => "fixture-start", isAlive: () => false },
    hooks: { ui: { available: async () => true }, tty: { available: true, read: async (label) => label === "Passphrase" ? s.passphrase : s.phrase },
      handler: () => async () => ({ ok: true, state: "unlocked", version: "0.1.2" }),
      listen: async () => { events.push("listen"); return { close: async () => {} }; }, recover: async () => {} } });
  expect(events).toEqual(["listen"]);
  await daemon?.close();
});
function statMode(file: string): number { return realFs.lstatSync(file).mode & 0o777; }

test("no difference: reports changed 0, asks no confirmation and writes nothing", async () => {
  const s = sealed(); const before = readFileSync(sealFile(s));
  const d = deps(s, [s.passphrase]);
  expect(await runInstall(["accept"], d)).toBe(0);
  expect(out).toBe('{"ok":true,"changed":0,"version":"0.1.2"}\n');
  expect(d.reads).toEqual(["Passphrase"]);
  expect(readFileSync(sealFile(s)).equals(before)).toBe(true); expect(existsSync(prevFile(s))).toBe(false);
});

test.each(["accept", "", "ACCEPT ", "yes"])("confirmation %j other than ACCEPT cancels and writes nothing", async (word) => {
  const s = sealed(); const before = readFileSync(sealFile(s)); upgrade(s);
  expect(await runInstall(["accept"], deps(s, [s.passphrase, word]))).toBe(2);
  expect(err).toContain("cli_refused: operator_cancelled");
  expect(readFileSync(sealFile(s)).equals(before)).toBe(true); expect(existsSync(prevFile(s))).toBe(false);
});

test("an existing valid backup is replaced by the current seal", async () => {
  const s = sealed(); const before = readFileSync(sealFile(s)); upgrade(s);
  writeFileSync(prevFile(s), "older evidence", { mode: 0o600 });
  expect(await runInstall(["accept"], deps(s, [s.passphrase, "ACCEPT"]))).toBe(0);
  expect(readFileSync(prevFile(s)).equals(before)).toBe(true);
});

test.each(["symlink", "mode"] as const)("an unsafe backup (%s) is refused as path_invalid before any prompt; both files unchanged", async (kind) => {
  const s = sealed(); upgrade(s);
  if (kind === "symlink") { writeFileSync(path.join(s.home, "elsewhere"), "x", { mode: 0o600 }); symlinkSync(path.join(s.home, "elsewhere"), prevFile(s)); }
  else { writeFileSync(prevFile(s), "older", { mode: 0o600 }); chmodSync(prevFile(s), 0o644); }
  const seal = readFileSync(sealFile(s)); const d = deps(s, [s.passphrase, "ACCEPT"]);
  expect(await runInstall(["accept"], d)).toBe(2);
  expect(err).toContain("cli_refused: path_invalid");
  expect(d.reads).toEqual([]);
  expect(readFileSync(sealFile(s)).equals(seal)).toBe(true);
  expect(realFs.lstatSync(prevFile(s)).isSymbolicLink()).toBe(kind === "symlink");
});

test("missing seal is install_seal_missing (not internal_error); corrupt seal is install_seal_corrupt; nothing written", async () => {
  const missing = sealed(); rmSync(sealFile(missing));
  expect(await runInstall(["accept"], deps(missing, [missing.passphrase, "ACCEPT"]))).toBe(2);
  expect(err).toContain("cli_refused: install_seal_missing"); expect(existsSync(sealFile(missing))).toBe(false);
  err = "";
  const corrupt = sealed(); writeFileSync(sealFile(corrupt), "{}"); upgrade(corrupt);
  expect(await runInstall(["accept"], deps(corrupt, [corrupt.passphrase, "ACCEPT"]))).toBe(2);
  expect(err).toContain("cli_refused: install_seal_corrupt"); expect(readFileSync(sealFile(corrupt), "utf8")).toBe("{}");
  expect(existsSync(prevFile(corrupt))).toBe(false);
});

test("wrong passphrase, non-TTY and a running daemon are refused; nothing written", async () => {
  const s = sealed(); const before = readFileSync(sealFile(s)); upgrade(s);
  expect(await runInstall(["accept"], deps(s, ["wrong-throwaway-passphrase"]))).toBe(2);
  expect(err).toContain("cli_refused: bad_passphrase");
  const noTty = deps(s, [s.passphrase, "ACCEPT"], { tty: { available: false, read: async () => s.passphrase } });
  expect(await runInstall(["accept"], noTty)).toBe(2);
  expect(err).toContain("cli_refused: no_tty"); expect(existsSync(path.join(s.dir, "daemon.lock"))).toBe(false);
  writeFileSync(path.join(s.dir, "daemon.lock"), JSON.stringify({ pid: process.pid, startedAt: "fixture-start", hostname: "h", token: "0123456789abcdef" }), { mode: 0o600 });
  expect(await runInstall(["accept"], deps(s, [s.passphrase, "ACCEPT"], { lockDeps: { startedAtOf: () => "fixture-start", isAlive: () => true } }))).toBe(2);
  expect(err).toContain("cli_refused: daemon_already_running");
  expect(readFileSync(sealFile(s)).equals(before)).toBe(true); expect(existsSync(prevFile(s))).toBe(false);
  expect(await runInstall(["accept", "now"], deps(s, []))).toBe(2); expect(err).toContain("cli_refused: invalid_arguments");
});

test.each(["fail", "partial"] as const)("seal write failure (%s) leaves the previous seal readable and no temp file", async (mode) => {
  const s = sealed(); const before = readFileSync(sealFile(s)); upgrade(s);
  let sealTemp = -1;
  const fs: StoreFs = { ...realFs,
    openSync: ((file: string, flags: string, m?: number) => { const fd = realFs.openSync(file, flags, m); if (/install\.seal\.[0-9a-f]{16}\.new$/.test(file)) sealTemp = fd; return fd; }) as StoreFs["openSync"],
    writeSync: ((fd: number, data: Buffer) => {
      if (fd === sealTemp) { if (mode === "partial") realFs.writeSync(fd, data.subarray(0, 3)); throw Object.assign(new Error("EIO"), { code: "EIO" }); }
      return realFs.writeSync(fd, data);
    }) as StoreFs["writeSync"] };
  expect(await runInstall(["accept"], deps(s, [s.passphrase, "ACCEPT"], { fs }))).toBe(2);
  expect(readFileSync(sealFile(s)).equals(before)).toBe(true);
  expect(() => readSealManifest(sealFile(s), lek(s), realFs)).not.toThrow();
  expect(tempLeft(s)).toEqual([]);
});

test("lock loss before the seal rename stops all writes", async () => {
  const s = sealed(); const before = readFileSync(sealFile(s)); upgrade(s);
  const lock = path.join(s.dir, "daemon.lock");
  const faults = { hit: async (point: string) => { if (point === "before:seal-rename") { const v = JSON.parse(readFileSync(lock, "utf8")); writeFileSync(lock, JSON.stringify({ ...v, token: "fedcba9876543210" })); } } };
  expect(await runInstall(["accept"], deps(s, [s.passphrase, "ACCEPT"], { faults }))).toBe(2);
  expect(err).toContain("cli_refused: lock_lost");
  expect(readFileSync(sealFile(s)).equals(before)).toBe(true);
});

test("daemon install_changed prints the upgrade guidance after the file list", () => {
  expect(startupMessage(new InstallChanged(["dist/entry.js"]))).toBe(`startup_refused: install_changed ["dist/entry.js"]\n${INSTALL_CHANGED_GUIDANCE}\n`);
  expect(INSTALL_CHANGED_GUIDANCE).toContain("subetha-payer install accept");
});

test("no MCP tool or daemon socket method reaches install accept", () => {
  for (const method of ["install", "install_accept", "accept"]) expect(Request.safeParse({ id: 1, method, params: {} }).success).toBe(false);
  const shim = readFileSync(new URL("../../src/shim/server.ts", import.meta.url), "utf8");
  const handler = readFileSync(new URL("../../src/daemon/handler.ts", import.meta.url), "utf8");
  for (const text of [shim, handler]) { expect(text).not.toMatch(/cli\/install|runInstall|install accept/); }
});
