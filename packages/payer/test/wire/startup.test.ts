import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, test } from "vitest";
import { ownedChild, tsxLoader, within } from "../harness/children.js";
import { fixtureStore, type FixtureStore } from "../harness/store.js";
import { fixtureExitDiagnostic } from "../harness/diagnostics.js";

const bin = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));
const entry = fileURLToPath(new URL("../harness/daemon-test-entry.ts", import.meta.url));
const preload = fileURLToPath(new URL("../fixtures/inert-preload.cjs", import.meta.url));
function fixtureChild(store: FixtureStore, extra: Record<string, unknown> = {}) {
  const child = ownedChild(["--disable-sigusr1", "--import", tsxLoader, entry], store.home);
  child.child.send({ home: store.home, installRoot: store.installRoot, passphrase: store.passphrase, phrase: store.phrase, ...extra });
  return child;
}

// Include every entry, bytes and metadata (except read-induced atime), not just seal/lock absence.
function snapshotStore(dir: string): unknown[] {
  const entries: unknown[] = [];
  function visit(relative: string): void {
    const file = path.join(dir, relative);
    const st = lstatSync(file);
    const content = st.isFile() ? createHash("sha256").update(readFileSync(file)).digest("hex") : st.isSymbolicLink() ? readlinkSync(file) : null;
    entries.push({ relative, mode: st.mode, uid: st.uid, gid: st.gid, ino: st.ino, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, content });
    if (st.isDirectory()) for (const name of readdirSync(file).sort()) visit(path.join(relative, name));
  }
  visit("");
  return entries;
}

const refusalRows: { id: string; args: string[]; env: Record<string, string>; reason: string; darwinLoader?: boolean }[] = [
  { id: "unguarded", args: [bin, "daemon"], env: {}, reason: "sigusr1_enabled" },
  { id: "node-options-preload", args: ["--disable-sigusr1", bin, "daemon"], env: { NODE_OPTIONS: `--require ${preload}` }, reason: "forbidden_env" },
  { id: "dyld-nonexistent-loader-on-darwin", args: ["--disable-sigusr1", bin, "daemon"], env: { DYLD_INSERT_LIBRARIES: "/nonexistent.dylib" }, reason: "forbidden_env", darwinLoader: true },
  { id: "dyld-empty-application-guard", args: ["--disable-sigusr1", bin, "daemon"], env: { DYLD_INSERT_LIBRARIES: "" }, reason: "forbidden_env" },
  { id: "inspect", args: ["--disable-sigusr1", "--inspect=0", bin, "daemon"], env: {}, reason: "forbidden_flag" },
  { id: "heapsnapshot-underscore", args: ["--disable-sigusr1", "--heapsnapshot_signal=SIGUSR2", bin, "daemon"], env: {}, reason: "forbidden_flag" },
  { id: "report-underscore", args: ["--disable-sigusr1", "--report_on_signal", bin, "daemon"], env: {}, reason: "forbidden_flag" },
  // Reuse the owned inert fixture as a loader with no hooks. Unsupported flags must fail, never skip/pass.
  { id: "loader-underscore", args: ["--disable-sigusr1", `--experimental_loader=${preload}`, bin, "daemon"], env: {}, reason: "forbidden_flag" },
  { id: "passphrase-env", args: ["--disable-sigusr1", bin, "daemon"], env: { SUBETHA_PAYER_PASSPHRASE: "fixture-only" }, reason: "forbidden_env" },
  { id: "check-ui", args: ["--disable-sigusr1", bin, "daemon", "--check"], env: {}, reason: "no_confirmation_ui" },
];
for (const guard of ["--disable-sigusr1", "--disable_sigusr1"]) {
  for (const negation of ["--no-disable-sigusr1", "--no_disable_sigusr1", "--no-disable_sigusr1", "--no_disable-sigusr1"]) {
    for (const flags of [[guard, negation], [negation, guard]]) {
      refusalRows.push({ id: flags.join(" "), args: [...flags, bin, "daemon"], env: {}, reason: "sigusr1_enabled" });
    }
  }
}

test.each(refusalRows)("actual compiled bin: $id; exact early refusal, no prompt or store mutation", async (row) => {
  const store = fixtureStore();
  try {
    const before = snapshotStore(store.dir);
    const child = ownedChild(row.args, store.home, row.env);
    try {
      const exit = await within(child.exited);
      const diagnostic = fixtureExitDiagnostic(row.id, exit, child.stderr, row.args);
      if (row.darwinLoader && process.platform === "darwin") {
        // Observed pre-main loader refusal is not evidence of the application env guard.
        expect(exit.code, diagnostic).toBeNull();
        expect(exit.signal, diagnostic).toBe("SIGABRT");
        expect(/dyld\[\d+\]:/.test(child.stderr), diagnostic).toBe(true);
        expect(child.stderr.includes("/nonexistent.dylib"), diagnostic).toBe(true);
        expect(child.stderr.includes("no such file"), diagnostic).toBe(true);
        expect(child.stderr.includes("startup_refused:"), diagnostic).toBe(false);
      } else {
        expect(exit.code, diagnostic).toBe(2);
        expect(exit.signal, diagnostic).toBeNull();
        expect(child.stderr.split("\n").filter((line) => line.startsWith("startup_refused:")), diagnostic).toEqual([`startup_refused: ${row.reason}`]);
      }
      expect(child.stderr.includes("Passphrase:"), diagnostic).toBe(false);
      expect(child.stderr.includes("Security phrase:"), diagnostic).toBe(false);
      expect(child.stdout.length, diagnostic).toBe(0);
      expect(snapshotStore(store.dir), diagnostic).toEqual(before);
    } finally { await child.close(); }
  } finally { store.cleanup(); }
});

test.each(["after:lock", "before:seal"])("actual SIGKILL at %s: stable lock remains, seal absent, restart refuses stale lock", async (point) => {
  const store = fixtureStore();
  const child = fixtureChild(store, { point });
  try {
    await child.waitFor(point);
    child.signal("SIGKILL");
    expect((await within(child.exited)).signal).toBe("SIGKILL");
    const lock = readFileSync(path.join(store.dir, "daemon.lock"), "utf8");
    expect(existsSync(path.join(store.dir, "install.seal"))).toBe(false);
    const contender = fixtureChild(store);
    try {
      expect((await within(contender.exited)).code).toBe(2);
      expect(contender.stderr).toContain("daemon_lock_stale");
      expect(readFileSync(path.join(store.dir, "daemon.lock"), "utf8")).toBe(lock);
      expect(existsSync(path.join(store.dir, "install.seal"))).toBe(false);
    } finally { await contender.close(); }
  } finally { await child.close(); store.cleanup(); }
});

test("actual child verifier stops at three attempts before phrase/seal", async () => {
  const store = fixtureStore();
  const child = fixtureChild(store, { wrong: true });
  try {
    expect((await within(child.exited)).code).toBe(2);
    expect(child.stderr).toContain("bad_passphrase");
    const events = readFileSync(path.join(store.home, "events.ndjson"), "utf8");
    expect(events.match(/Passphrase/g)).toHaveLength(3);
    expect(events).not.toContain("Security phrase");
    expect(events).not.toContain("before:key-decrypt");
    expect(existsSync(path.join(store.dir, "install.seal"))).toBe(false);
  } finally { await child.close(); store.cleanup(); }
});

test.each(["mode", "symlink"])("actual startup rejects %s paths before prompting", async (kind) => {
  const store = fixtureStore();
  if (kind === "mode") chmodSync(store.dir, 0o755);
  else {
    const keyPath = path.join(store.dir, "keys.json");
    renameSync(keyPath, `${keyPath}.fixture`);
    symlinkSync(`${keyPath}.fixture`, keyPath);
  }
  const child = fixtureChild(store);
  try {
    expect((await within(child.exited)).code).toBe(2);
    expect(child.stderr).toContain("startup_refused: path_invalid");
    expect(child.messages).not.toContainEqual({ event: "Passphrase" });
    expect(existsSync(path.join(store.dir, "install.seal"))).toBe(false);
  } finally { await child.close(); store.cleanup(); }
});

test("actual child seal detects tampering on restart before key decrypt", async () => {
  const store = fixtureStore();
  const child = fixtureChild(store);
  try {
    await child.waitFor("listening");
    await child.close();
    writeFileSync(path.join(store.installRoot, "dist", "entry.js"), "changed");
    const second = fixtureChild(store);
    try {
      expect((await within(second.exited)).code).toBe(2);
      expect(second.stderr).toContain("install_changed");
      expect(second.stderr).toContain("dist/entry.js");
      expect(second.messages).not.toContainEqual({ event: "before:key-decrypt" });
    } finally { await second.close(); }
  } finally { await child.close(); store.cleanup(); }
});

test("actual --disable-sigusr1 child: inspector 9229 remains closed two seconds after SIGUSR1", async () => {
  // A preoccupied port is an environmental failure, never a skip or a false closed result.
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(9229, "127.0.0.1", resolve); });
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const store = fixtureStore();
  const child = fixtureChild(store);
  try {
    await child.waitFor("listening");
    await child.waitFor("scrubbed");
    expect(child.messages).toContainEqual({ event: "scrubbed", forbiddenPresent: false });
    child.signal("SIGUSR1");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const closed = await within(new Promise<boolean>((resolve) => {
      const probe = createConnection({ host: "127.0.0.1", port: 9229 });
      probe.once("connect", () => { probe.destroy(); resolve(false); });
      probe.once("error", (error: NodeJS.ErrnoException) => { probe.destroy(); resolve(error.code === "ECONNREFUSED"); });
    }), 2000);
    expect(closed).toBe(true);
    expect(child.child.exitCode).toBeNull();
    expect(child.stderr).not.toContain("Debugger listening");
  } finally { await child.close(); store.cleanup(); }
});
