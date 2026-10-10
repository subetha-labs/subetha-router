import { expect, test, vi } from "vitest";
import { createOsascriptUi } from "../../src/ui/osascript.js";
import { recordHash } from "../../src/daemon/record.js";
import { confirmationScript } from "../../src/ui/osascript.js";
import { renderConfirmation } from "../../src/ui/render.js";
import { fakeUiHelper } from "../harness/ui-helper.js";
import { uiRecord } from "../harness/ui-record.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fixtureStore } from "../harness/store.js";

test("actual owned helper: exact stdin probe, argv, env allowlist, private display and verified hash", async () => {
  const f = fakeUiHelper(); const verify = vi.fn(pass => pass === "synthetic-passphrase");
  try {
    const ui = createOsascriptUi(verify, f.deps), record = uiRecord();
    expect(await ui.available()).toBe(true);
    expect(await ui.confirm!(record, 'phrase\\"sentinel')).toEqual({ approved: true, recordHash: recordHash(record), uiKind: "native" });
    expect(verify).toHaveBeenCalledExactlyOnceWith("synthetic-passphrase");
    const captures = f.captures(); expect(captures).toHaveLength(2);
    expect(captures[0]!.input).toBe('tell application "System Events" to return 1\n');
    expect(captures[1]!.input).toBe(confirmationScript(renderConfirmation(record, 'phrase\\"sentinel')));
    for (const captured of captures) {
      expect(captured.argv).toEqual(["-"]);
      expect(captured.env).toEqual({ PATH: "/usr/bin:/bin", HOME: f.dir, LANG: "en_US.UTF-8", TMPDIR: f.dir });
      expect(JSON.stringify({ argv: captured.argv, env: captured.env })).not.toMatch(/phrase|sentinel|10000/);
    }
  } finally { f.cleanup(); }
});
test.each([
  ['process.stdout.write("Approve\\nfalse\\nsynthetic-passphrase\\n"); process.exitCode = 7;', "helper_failed"],
  ['process.stdout.write("Approve\\nfalse\\nsynthetic-passphrase\\n"); process.kill(process.pid, "SIGTERM");', "helper_failed"],
  ['process.stderr.write("private-error-sentinel");', "malformed_response"],
  ['process.stdout.write("Approve\\nfalse\\nsynthetic-passphrase\\nextra\\n");', "malformed_response"],
  ['process.stdout.write("Approve\\nfalse\\nvalid-but-different\\n");', "bad_passphrase"],
  ['process.stdout.write("Cancel\\nfalse\\n\\n");', "cancelled"],
  ['process.stdout.write("Approve\\ntrue\\n\\n");', "timeout"],
  // Real macOS give-up output: empty button name, gave up true, empty text.
  ['process.stdout.write("\\ntrue\\n\\n");', "timeout"],
  ['process.stdout.write("\\nfalse\\nsynthetic-passphrase\\n");', "malformed_response"],
  ['process.stdout.write("Other\\ntrue\\n\\n");', "malformed_response"],
  ['process.stdout.write("x".repeat(100_000));', "helper_failed"],
  ['process.stdout.write(Buffer.from([255, 254]));', "helper_failed"],
  ['process.stdout.write("\\ufeffApprove\\nfalse\\nsynthetic-passphrase\\n");', "malformed_response"],
  ['setInterval(() => {}, 1000);', "timeout"],
])("helper failure rejects with static reason and closed process: %s", async (body, reason) => {
  const f = fakeUiHelper(body); const verify = vi.fn(pass => pass === "synthetic-passphrase");
  try {
    const ui = createOsascriptUi(verify, { ...f.deps, timeoutMs: body!.startsWith("setInterval") ? 500 : 5000 });
    expect(await ui.confirm!(uiRecord(), "phrase")).toEqual({ approved: false, reason });
    expect(verify).toHaveBeenCalledTimes(reason === "bad_passphrase" ? 1 : 0);
  } finally { f.cleanup(); }
});
test.each(['process.stdout.write("2\\n");', 'process.stdout.write("1\\n\\n");', 'process.exitCode = 1;'])("probe fails closed for invalid result: %s", async probe => {
  const f = fakeUiHelper(undefined, probe);
  try { expect(await createOsascriptUi(undefined, f.deps).available()).toBe(false); } finally { f.cleanup(); }
});
test("off macOS and missing verifier do not spawn", async () => {
  const f = fakeUiHelper();
  try {
    expect(await createOsascriptUi(() => true, { ...f.deps, platform: "linux" }).available()).toBe(false);
    expect(await createOsascriptUi(undefined, f.deps).confirm!(uiRecord(), "phrase")).toMatchObject({ approved: false });
    expect(await createOsascriptUi(() => true, f.deps).confirm!(uiRecord(), "\u202e\u200b")).toMatchObject({ approved: false });
    expect(() => f.captures()).toThrow();
  } finally { f.cleanup(); }
});

test("default executable is the absolute system path; environment cannot override it", async () => {
  const seen: string[] = [];
  const ui = createOsascriptUi(undefined, { platform: "darwin", env: { PATH: "/hostile", SUBETHA_PAYER_UI_EXECUTABLE: "/hostile/helper" }, filesystem: {
    realpathSync: value => { seen.push(value); throw new Error("fixture stop before spawn"); },
    lstatSync: () => { throw new Error("unreachable"); },
  } });
  expect(await ui.available()).toBe(false); expect(seen).toEqual(["/usr/bin/osascript"]);
});
test("missing executable spawn error stays private", async () => {
  const f = fakeUiHelper(); f.cleanup();
  expect(await createOsascriptUi(() => true, f.deps).confirm!(uiRecord(), "phrase")).toEqual({ approved: false, reason: "helper_failed" });
});

test("system path owner/mode/symlink/type/absolute path tripwires, positive control first", async () => {
  const f = fakeUiHelper();
  try {
    expect(await createOsascriptUi(undefined, f.deps).available()).toBe(true);
    const fs = f.deps.filesystem!;
    for (const target of [f.executable, path.dirname(f.executable), "/"]) {
      for (const change of [{ uid: 501 }, { mode: 0o777 }, { isSymbolicLink: () => true }, target === f.executable ? { isFile: () => false } : { isDirectory: () => false }]) {
        const filesystem = { ...fs, lstatSync: (p: string) => ({ ...fs.lstatSync(p), ...(p === target ? change : {}) }) };
        expect(await createOsascriptUi(undefined, { ...f.deps, filesystem }).available()).toBe(false);
      }
    }
    for (const executable of ["relative-helper", `${f.dir}/../fake-osascript`]) expect(await createOsascriptUi(undefined, { ...f.deps, executable }).available()).toBe(false);
    for (const filesystem of [{ ...fs, realpathSync: () => "/different" }, { ...fs, lstatSync: () => { throw new Error("private-error"); } }, { ...fs, lstatSync: (p: string) => ({ ...fs.lstatSync(p), ...(p === f.executable ? { mode: 0o644 } : {}) }) }]) {
      expect(await createOsascriptUi(undefined, { ...f.deps, filesystem }).available()).toBe(false);
    }
    expect(f.captures()).toHaveLength(1);
  } finally { f.cleanup(); }
});

// Moved only the old check-ui placeholder row from startup.test.ts. Every other
// SECURITY row remains on dist/bin.js. These are production composition-root
// checks with a fake executable, not installed-bin/native/manual evidence.
function snapshot(dir: string): unknown[] {
  const result: unknown[] = [];
  function visit(relative: string) {
    const file = path.join(dir, relative), st = lstatSync(file);
    const content = st.isFile() ? createHash("sha256").update(readFileSync(file)).digest("hex") : st.isSymbolicLink() ? readlinkSync(file) : null;
    result.push({ relative, mode: st.mode, uid: st.uid, gid: st.gid, ino: st.ino, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, content });
    if (st.isDirectory()) for (const name of readdirSync(file).sort()) visit(path.join(relative, name));
  }
  visit(""); return result;
}
test.each([false, true])("subprocess production --check: available=%s; exact exit, no secret/prompt/store mutation", async available => {
  const store = fixtureStore(); const f = fakeUiHelper(undefined, available ? 'process.stdout.write("1\\n");' : 'process.exitCode = 1;');
  const before = snapshot(store.dir);
  const entry = fileURLToPath(new URL("../harness/ui-check-entry.ts", import.meta.url));
  const child = spawn(process.execPath, ["--disable-sigusr1", "--import", import.meta.resolve("tsx"), entry], { env: { PATH: "/usr/bin:/bin", HOME: store.home }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    child.stdin.end(JSON.stringify({ home: store.home, installRoot: store.installRoot, executable: f.executable }));
    expect(await closed).toEqual({ code: available ? 0 : 2, signal: null });
    expect(stdout).toBe(""); expect(stderr).toBe(available ? "" : "startup_refused: no_confirmation_ui\n");
    for (const secret of [store.passphrase, store.phrase, "Passphrase:", "Security phrase:"]) expect(stdout + stderr).not.toContain(secret);
    expect(snapshot(store.dir)).toEqual(before);
    expect(f.captures().map(c => c.input)).toEqual(['tell application "System Events" to return 1\n']);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; f.cleanup(); store.cleanup(); }
});
