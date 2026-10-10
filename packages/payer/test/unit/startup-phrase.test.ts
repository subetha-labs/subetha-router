/**
 * Follow-up FR-F1 / AC-F1: the security phrase is separated from the wallet passphrase.
 * Rejection re-reads only the phrase (max 3), never decrypts the wallet, and prints no value or length.
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return { ...actual, zero: vi.fn((...buffers: Buffer[]) => actual.zero(...buffers)) };
});
import { createKeysDocument, zero } from "../../src/store/keys.js";
import { StoreError } from "../../src/store/fs.js";
import { PHRASE_NOTICE, startDaemon, type StartupOptions } from "../../src/daemon/startup.js";
import { fixtureStore, type FixtureStore } from "../harness/store.js";

const SAME = "Security phrase rejected: it must differ from the passphrase and not contain it.";
const SHAPE = "Security phrase rejected: empty, too long or contains control characters.";
const fullWidth = (text: string): string => [...text].map(c => { const code = c.codePointAt(0)!; return code >= 0x21 && code <= 0x7e ? String.fromCodePoint(code + 0xfee0) : c; }).join("");

const stores: FixtureStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.cleanup(); vi.mocked(zero).mockClear(); });

/** `phrases` is built from the wallet passphrase actually used by this store. `passphrase` replaces the wallet's. */
function setup(phrases: (pass: string, store: FixtureStore) => (string | Error)[], passphrase?: string) {
  const store = fixtureStore(); stores.push(store);
  const pass = passphrase ?? store.passphrase;
  if (passphrase !== undefined) writeFileSync(path.join(store.dir, "keys.json"), JSON.stringify(createKeysDocument(passphrase, { eip155: { address: `0x${"12".repeat(20)}`, secret: Buffer.alloc(32, 7) } })), { mode: 0o600 });
  const events: string[] = [];
  const queue = [...phrases(pass, store)];
  const options: StartupOptions = {
    env: { HOME: store.home }, execArgv: ["--disable-sigusr1"], installRoot: store.installRoot,
    lockDeps: { startedAtOf: () => "fixture-start", isAlive: () => false },
    hooks: {
      ui: { available: async () => { events.push("ui"); return true; } },
      tty: {
        available: true,
        notice: (text) => { events.push(`notice:${text}`); },
        read: async (label) => {
          events.push(label);
          if (label === "Passphrase") return pass;
          const next = queue.shift();
          if (next instanceof Error) throw next;
          if (next === undefined) throw new Error("fixture: unexpected phrase read");
          return next;
        },
      },
      faults: { hit: async (point) => { events.push(point); } },
      // Confirmation UI creation is observable: it must not happen before the phrase is accepted.
      createConfirmUi: () => { events.push("create-ui"); return { available: async () => true }; },
      handler: () => async () => ({ ok: true, state: "unlocked", version: "0.1.2" }),
      listen: async () => { events.push("listen"); return { close: async () => { events.push("close"); } }; },
      recover: async () => { events.push("recover"); },
    },
  };
  return { store, options, events, pass };
}

/** Output must be exactly the fixed notices: no phrase, passphrase or length. */
function expectOnlyFixedNotices(events: string[], secrets: string[]) {
  for (const event of events.filter(e => e.startsWith("notice:"))) {
    expect([PHRASE_NOTICE, SAME, SHAPE]).toContain(event.slice("notice:".length));
    for (const secret of secrets.filter(Boolean)) expect(event).not.toContain(secret);
  }
}

const rejected: [string, (pass: string) => string, string][] = [
  ["equal", pass => pass, SAME],
  ["full-width equal (NFKC)", pass => fullWidth(pass), SAME],
  ["surrounding whitespace", pass => `  ${pass} `, SAME],
  ["contains", pass => `x${pass}y`, SAME],
  ["contains after normalization", pass => `my ${fullWidth(pass)} phrase`, SAME],
  ["whitespace only", () => "   ", SHAPE],
  ["over 256", () => "a".repeat(257), SHAPE],
  ["control character", () => "ab\u0007cd", SHAPE],
];
for (const [name, bad, notice] of rejected) test(`phrase rejected (${name}) then a different phrase starts; only the phrase is re-read`, async () => {
  const { options, events, store, pass } = setup((p, st) => [bad(p), st.phrase]);
  const daemon = await startDaemon(options);
  expect(events.filter(e => e === "Passphrase")).toHaveLength(1);
  expect(events.filter(e => e === "Security phrase")).toHaveLength(2);
  // The explanation precedes the first phrase prompt, and the rejection notice precedes the second.
  expect(events.indexOf(`notice:${PHRASE_NOTICE}`)).toBeLessThan(events.indexOf("Security phrase"));
  expect(events.indexOf(`notice:${notice}`)).toBeLessThan(events.lastIndexOf("Security phrase"));
  expect(events).toContain("listen");
  expect(events.indexOf("create-ui")).toBeGreaterThan(events.lastIndexOf("Security phrase"));
  expect(daemon?.context.phrase).toBe(store.phrase);
  expectOnlyFixedNotices(events, [pass, bad(pass).trim()]);
  await daemon?.close();
});

function expectRefusedBeforeWallet(events: string[], store: FixtureStore) {
  for (const effect of ["before:seal", "after:seal", "before:key-decrypt", "create-ui", "listen", "recover"]) expect(events).not.toContain(effect);
  expect(existsSync(path.join(store.dir, "install.seal"))).toBe(false);
  expect(existsSync(path.join(store.dir, "daemon.lock"))).toBe(false);
  // kek and lek (32 bytes each) were zeroed by close().
  const zeroed = vi.mocked(zero).mock.calls.flat();
  expect(zeroed.filter(b => b.length === 32).length).toBeGreaterThanOrEqual(2);
  for (const buffer of zeroed) expect(buffer.every(byte => byte === 0)).toBe(true);
}

test("three rejected phrases end with phrase_invalid: no seal, wallet decrypt, session, listener or UI; keys zeroed; lock released", async () => {
  const { options, events, store, pass } = setup(p => [p, fullWidth(p), `a${p}`]);
  await expect(startDaemon(options)).rejects.toThrow("phrase_invalid");
  expect(events.filter(e => e === "Security phrase")).toHaveLength(3);
  expect(events.filter(e => e === "Passphrase")).toHaveLength(1);
  expectRefusedBeforeWallet(events, store);
  expectOnlyFixedNotices(events, [pass]);
});

test("cancelling the phrase prompt ends with tty_cancelled and the same no-effect guarantees", async () => {
  const { options, events, store } = setup(() => [new StoreError("tty_cancelled")]);
  await expect(startDaemon(options)).rejects.toThrow("tty_cancelled");
  expectRefusedBeforeWallet(events, store);
});

test("wallet authentication is not normalized: a full-width passphrase wallet opens only with the exact full-width input", async () => {
  const fullPass = fullWidth("wallet-pass-0123");
  const ok = setup(() => ["a different phrase"], fullPass);
  const daemon = await startDaemon(ok.options);
  expect(ok.events).toContain("listen");
  await daemon?.close();
  // Same full-width wallet, but the human types the ASCII (NFKC-equal) form: authentication must fail.
  const ascii = setup(() => [], fullPass);
  const hooks = { ...ascii.options.hooks, tty: { ...ascii.options.hooks.tty, read: async () => "wallet-pass-0123" } };
  await expect(startDaemon({ ...ascii.options, hooks })).rejects.toThrow("bad_passphrase");
});
