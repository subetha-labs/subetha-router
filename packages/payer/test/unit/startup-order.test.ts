import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { realFs, StoreError } from "../../src/store/fs.js";
import { startDaemon, type StartupOptions } from "../../src/daemon/startup.js";
import { installHashes } from "../../src/daemon/seal.js";
import { fixtureStore, type FixtureStore } from "../harness/store.js";

const stores: FixtureStore[] = [];
const initialMask = process.umask();
afterEach(() => { for (const store of stores.splice(0)) store.cleanup(); process.umask(initialMask); });
function setup() {
  const store = fixtureStore(); stores.push(store);
  const events: string[] = [];
  const options: StartupOptions = {
    env: { HOME: store.home }, execArgv: ["--disable-sigusr1"], installRoot: store.installRoot,
    // Pure tests must never invoke ps/process liveness, sockets or real TTY/UI.
    lockDeps: { startedAtOf: () => "fixture-start", isAlive: () => false },
    hooks: {
      ui: { available: async () => { events.push("ui"); return true; } },
      tty: { available: true, read: async (label) => { events.push(label); return label === "Passphrase" ? store.passphrase : store.phrase; } },
      faults: { hit: async (point) => { events.push(point); } },
      handler: () => async () => ({ ok: true, state: "unlocked", version: "0.1.0" }),
      listen: async () => { events.push("listen"); return { close: async () => { events.push("close"); } }; },
      recover: async () => { events.push("recover"); },
    },
  };
  return { store, options, events };
}

test("startup order: UI → stable lock → TTY/verifier → encrypted seal → key → listener → recovery", async () => {
  const { store, options, events } = setup();
  const daemon = await startDaemon(options);
  expect(events).toEqual(["ui", "after:lock", "Passphrase", "Security phrase", "before:seal", "after:seal", "before:key-decrypt", "listen", "recover"]);
  const seal = readFileSync(path.join(store.dir, "install.seal"), "utf8");
  expect(seal).not.toContain("entry.js");
  expect(seal).not.toContain(store.passphrase);
  expect(daemon?.context.session.locked).toBe(false);
  await daemon?.close();
  expect(existsSync(path.join(store.dir, "daemon.lock"))).toBe(false);
  expect(daemon?.context.session.locked).toBe(true);
});

test("wrong passphrase is limited to three attempts, with no phrase, seal, decrypt or listener", async () => {
  const { store, options, events } = setup();
  const hooks = { ...options.hooks, tty: { available: true, read: async () => { events.push("wrong-pass"); return "wrong-throwaway-passphrase"; } } };
  await expect(startDaemon({ ...options, hooks })).rejects.toThrow("bad_passphrase");
  expect(events).toEqual(["ui", "after:lock", "wrong-pass", "wrong-pass", "wrong-pass"]);
  expect(existsSync(path.join(store.dir, "install.seal"))).toBe(false);
});

test("tripwires, invalid paths and unavailable UI refuse before secret prompt or store writes", async () => {
  const { options, store, events } = setup();
  await expect(startDaemon({ ...options, env: { HOME: store.home, NODE_OPTIONS: "" } })).rejects.toThrow("forbidden_env");
  expect(events).toEqual([]);
  chmodSync(store.dir, 0o755);
  await expect(startDaemon(options)).rejects.toThrow("path_invalid");
  expect(events).toEqual([]);
  chmodSync(store.dir, 0o700);
  await expect(startDaemon({ ...options, hooks: { ...options.hooks, ui: { available: async () => false } } })).rejects.toThrow("no_confirmation_ui");
  expect(events).toEqual([]);
  expect(existsSync(path.join(store.dir, "daemon.lock"))).toBe(false);
  expect(existsSync(path.join(store.dir, "install.seal"))).toBe(false);
});

test("stale lock errors are preserved and stable contents are never reclaimed", async () => {
  const { options, store, events } = setup();
  const file = path.join(store.dir, "daemon.lock");
  const original = JSON.stringify({ pid: 999999, startedAt: "old", hostname: "fixture", token: "0123456789abcdef" });
  writeFileSync(file, original, { mode: 0o600 });
  await expect(startDaemon(options)).rejects.toThrow("daemon_lock_stale");
  expect(events).toEqual(["ui"]);
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(existsSync(path.join(store.dir, "install.seal"))).toBe(false);
});

test("install modifications refuse before key decrypt, including added/removed dependencies", async () => {
  const { options, store, events } = setup();
  await (await startDaemon(options))?.close();
  events.length = 0;
  writeFileSync(path.join(store.installRoot, "node_modules", "dependency.js"), "modified");
  // A broken wallet tag would fail if key decryption were moved before the seal check.
  const keyPath = path.join(store.dir, "keys.json");
  const document = JSON.parse(readFileSync(keyPath, "utf8"));
  document.wallets.eip155.tag = Buffer.alloc(16).toString("base64");
  writeFileSync(keyPath, JSON.stringify(document));
  await expect(startDaemon(options)).rejects.toMatchObject({ code: "install_changed", files: ["node_modules/dependency.js"] });
  expect(events).not.toContain("before:key-decrypt");
  expect(events).not.toContain("listen");
  expect(Object.keys(installHashes(store.installRoot, realFs))).toEqual(["dist/entry.js", "node_modules/dependency.js"]);
});

test.each(["after:lock", "before:seal"] as const)("fault at %s cannot leave a seal; retained wire counterpart uses SIGKILL", async (point) => {
  const { options, store } = setup();
  const hooks = { ...options.hooks, faults: { hit: async (current: string) => {
    if (current === point) {
      expect(existsSync(path.join(store.dir, "daemon.lock"))).toBe(true);
      expect(existsSync(path.join(store.dir, "install.seal"))).toBe(false);
      throw new StoreError("fixture_fault");
    }
  } } };
  await expect(startDaemon({ ...options, hooks })).rejects.toThrow("fixture_fault");
  expect(existsSync(path.join(store.dir, "install.seal"))).toBe(false);
});

test("lock loss at seal boundary prevents seal and all subsequent effects", async () => {
  const { options, store, events } = setup();
  const lock = path.join(store.dir, "daemon.lock");
  const hooks = { ...options.hooks, faults: { hit: async (point: string) => {
    events.push(point);
    if (point === "before:seal") {
      const content = JSON.parse(readFileSync(lock, "utf8"));
      writeFileSync(lock, JSON.stringify({ ...content, token: "fedcba9876543210" }));
    }
  } } };
  await expect(startDaemon({ ...options, hooks })).rejects.toThrow("lock_lost");
  expect(existsSync(lock)).toBe(true);
  expect(existsSync(path.join(store.dir, "install.seal"))).toBe(false);
  expect(events).not.toContain("before:key-decrypt");
  expect(events).not.toContain("listen");
});
