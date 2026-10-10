/**
 * Follow-up FR-F2 / AC-F2 (wire): crash windows with SIGKILL, human stale-lock reclaim and re-run; real PTY rows.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { checkInstallSeal, installHashes, readSealManifest } from "../../src/daemon/seal.js";
import { parseKeysDocument, unlockKeys, zero } from "../../src/store/keys.js";
import { realFs } from "../../src/store/fs.js";
import { ownedChild, tsxLoader, within } from "../harness/children.js";
import { INSTALL_CHANGED_GUIDANCE } from "../../src/daemon/run.js";
import { fixtureStore, type FixtureStore } from "../harness/store.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const stores: FixtureStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.cleanup(); });

function sealedUpgraded() {
  const s = fixtureStore(); stores.push(s);
  writeFileSync(path.join(s.installRoot, "package.json"), JSON.stringify({ version: "0.1.2" }));
  const keys = unlockKeys(parseKeysDocument(readFileSync(path.join(s.dir, "keys.json"), "utf8")), s.passphrase);
  try { checkInstallSeal(path.join(s.dir, "install.seal"), installHashes(s.installRoot, realFs), keys.lek, realFs, () => {}); }
  finally { zero(keys.kek, keys.lek); }
  const oldManifest = installHashes(s.installRoot, realFs);
  writeFileSync(path.join(s.installRoot, "dist", "entry.js"), "upgraded bytes\n");
  writeFileSync(path.join(s.installRoot, "dist", "added.js"), "new file\n");
  unlinkSync(path.join(s.installRoot, "node_modules", "dependency.js"));
  return { s, oldManifest, newManifest: installHashes(s.installRoot, realFs) };
}
function run(file: string, args: string[], input: unknown, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 25_000);
    p.stdout.setEncoding("utf8").on("data", c => { stdout += c; }); p.stderr.setEncoding("utf8").on("data", c => { stderr += c; });
    p.once("error", reject);
    p.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    p.stdin.end(input === undefined ? "" : JSON.stringify(input));
  });
}
const entry = (s: FixtureStore, command: "install" | "lock", answers: string[], faultAt?: string) =>
  run(process.execPath, ["--disable-sigusr1", "--import", tsxLoader, path.join(root, "test/harness/install-entry.ts")],
    { home: s.home, installRoot: s.installRoot, command, answers, ...(faultAt ? { faultAt } : {}) }, { PATH: "/usr/bin:/bin", HOME: s.home });
const lek = (s: FixtureStore) => unlockKeys(parseKeysDocument(readFileSync(path.join(s.dir, "keys.json"), "utf8")), s.passphrase).lek;

const points = ["before:prev", "before:prev-write", "during:prev-write", "after:prev-rename", "after:prev",
  "before:seal-write", "during:seal-write", "after:seal-write", "before:seal-rename", "after:seal-rename"];
for (const point of points) test(`SIGKILL at ${point}: seal stays old or new, stale lock needs human reclaim, re-run completes`, async () => {
  const { s, oldManifest, newManifest } = sealedUpgraded();
  const crashed = await entry(s, "install", [s.passphrase, "ACCEPT"], point);
  expect(crashed.signal).toBe("SIGKILL");
  // Never corrupt: the seal decrypts to exactly the old or the new manifest.
  const after = readSealManifest(path.join(s.dir, "install.seal"), lek(s), realFs);
  expect([JSON.stringify(oldManifest), JSON.stringify(newManifest)]).toContain(JSON.stringify(after));
  if (point.startsWith("before:") || point.includes("during") || point === "after:seal-write" || point.includes("prev")) expect(after).toEqual(oldManifest);
  // The killed process left its lock: a re-run is refused until a human reclaims it.
  const refused = await entry(s, "install", [s.passphrase, "ACCEPT"]);
  expect(refused.code).toBe(2); expect(refused.stderr).toContain("cli_refused: daemon_lock_stale");
  const reclaim = await entry(s, "lock", ["y"]);
  expect(reclaim.code, reclaim.stderr).toBe(0);
  const rerun = await entry(s, "install", [s.passphrase, "ACCEPT"]);
  expect(rerun.code, rerun.stderr).toBe(0);
  expect(readSealManifest(path.join(s.dir, "install.seal"), lek(s), realFs)).toEqual(newManifest);
}, 60_000);

type PtyResult = { exit: number; prompts: number; outputs: unknown[]; refusals: string[] };
async function pty(s: FixtureStore, passphrase: string, confirm = "ACCEPT"): Promise<PtyResult> {
  const fixedLines = ["Installed @subetha/payer version: 0.1.2", 'Added: ["dist/added.js"]', 'Removed: ["node_modules/dependency.js"]', 'Changed: ["dist/entry.js"]',
    "Accept only an upgrade you started and verified (README: Upgrading). If you did not upgrade, type anything else and stop."];
  const interactions = [{ prompt: "Passphrase: ", answer: passphrase }, ...(passphrase === s.passphrase ? [{ prompt: "Type ACCEPT to seal this installation: ", answer: confirm }] : [])];
  const result = await run("python3", [path.join(root, "test/fixtures/cli-pty.py")], {
    node: process.execPath, bin: path.join(root, "test/harness/install-pty-entry.ts"), loader: tsxLoader, home: s.home,
    args: ["accept"], interactions, secrets: [s.passphrase, passphrase], fixedLines,
  }, { PATH: process.env.PATH, HOME: s.home });
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as PtyResult;
}
test("real PTY: the correct passphrase and ACCEPT seal the upgrade (a PTY is not refused)", async () => {
  const { s, newManifest } = sealedUpgraded();
  const value = await pty(s, s.passphrase);
  expect(value.exit).toBe(0); expect(value.prompts).toBe(2);
  expect(value.outputs).toEqual([{ ok: true, changed: 3, version: "0.1.2" }]);
  expect(readSealManifest(path.join(s.dir, "install.seal"), lek(s), realFs)).toEqual(newManifest);
  expect(readdirSync(s.dir).filter(n => n.endsWith(".new"))).toEqual([]);
}, 60_000);
test("real PTY: a wrong passphrase is bad_passphrase and nothing is written", async () => {
  const { s, oldManifest } = sealedUpgraded();
  const value = await pty(s, "wrong-throwaway-passphrase");
  expect(value.exit).toBe(2); expect(value.refusals).toEqual(["cli_refused: bad_passphrase"]);
  expect(readSealManifest(path.join(s.dir, "install.seal"), lek(s), realFs)).toEqual(oldManifest);
}, 60_000);

// AC-F2 lifecycle with real processes: daemon refuses the upgrade with the file list and guidance, the human accepts,
// and the daemon then reaches `listening`.
test("actual daemon child: install_changed with guidance → install accept → daemon listening", async () => {
  const s = fixtureStore(); stores.push(s);
  writeFileSync(path.join(s.installRoot, "package.json"), JSON.stringify({ version: "0.1.2" }));
  const daemonEntry = fileURLToPath(new URL("../harness/daemon-test-entry.ts", import.meta.url));
  const daemon = () => { const c = ownedChild(["--disable-sigusr1", "--import", tsxLoader, daemonEntry], s.home);
    c.child.send({ home: s.home, installRoot: s.installRoot, passphrase: s.passphrase, phrase: s.phrase }); return c; };
  const first = daemon();
  try { await first.waitFor("listening"); } finally { await first.close(); }
  writeFileSync(path.join(s.installRoot, "dist", "entry.js"), "upgraded bytes\n");
  const refused = daemon();
  try {
    expect((await within(refused.exited)).code).toBe(2);
    expect(refused.stderr).toContain('startup_refused: install_changed ["dist/entry.js"]');
    expect(refused.stderr).toContain(INSTALL_CHANGED_GUIDANCE);
  } finally { await refused.close(); }
  const accepted = await entry(s, "install", [s.passphrase, "ACCEPT"]);
  expect(accepted.code, accepted.stderr).toBe(0);
  expect(JSON.parse(accepted.stdout)).toEqual({ ok: true, changed: 1, version: "0.1.2" });
  const third = daemon();
  try { await third.waitFor("listening"); } finally { await third.close(); }
}, 90_000);
