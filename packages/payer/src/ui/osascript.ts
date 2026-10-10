import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ConfirmUi } from "../daemon/interfaces.js";
import { frozenCopy, recordHash, sanitize } from "../daemon/record.js";
import { isValidPassphrase, zero } from "../store/keys.js";
import { renderConfirmation } from "./render.js";

type Rejection = { approved: false; reason: "malformed_response" | "cancelled" | "timeout" | "bad_passphrase" | "helper_failed" | "approval_unavailable" };
type Parsed = { approved: true } | Rejection;
export function appleScriptString(text: string): string {
  return text.split("\n").map(line => `"${line.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(" & return & ");
}
export function confirmationScript(text: string): string {
  return `try\nset r to display dialog ${appleScriptString(text)} with title "subetha-payer" buttons {"Cancel", "Approve"} default button "Cancel" default answer "" with hidden answer giving up after 120\nreturn (button returned of r) & linefeed & (gave up of r) & linefeed & (text returned of r)\non error number -128\nreturn "Cancel" & linefeed & "false" & linefeed & ""\nend try\n`;
}
/** No response/secret is returned to the caller, including on verifier errors. */
export function parseConfirmation(text: string, verify: (pass: string) => boolean): Parsed {
  const fields = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  try {
    // macOS reports a give-up as an empty button name with gave-up "true" (observed 2026-10-10, P-4a manual check).
    if (fields.length !== 3 || !["false", "true"].includes(fields[1]!)) return { approved: false, reason: "malformed_response" };
    if (fields[1] === "true") return ["", "Cancel", "Approve"].includes(fields[0]!) ? { approved: false, reason: "timeout" } : { approved: false, reason: "malformed_response" };
    if (!["Cancel", "Approve"].includes(fields[0]!)) return { approved: false, reason: "malformed_response" };
    if (fields[0] === "Cancel") return { approved: false, reason: "cancelled" };
    if (!isValidPassphrase(fields[2]!)) return { approved: false, reason: "malformed_response" };
    try { return verify(fields[2]!) ? { approved: true } : { approved: false, reason: "bad_passphrase" }; }
    catch { return { approved: false, reason: "bad_passphrase" }; }
  } finally { fields.fill(""); text = ""; }
}

export interface UiFilesystem { lstatSync(path: string): { uid: number; mode: number; isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }; realpathSync(path: string): string }
/** Trusted in-process dependencies only; never read overrides from argv or env. */
export interface OsascriptDependencies { platform?: NodeJS.Platform; executable?: string; filesystem?: UiFilesystem; env?: NodeJS.ProcessEnv; timeoutMs?: number }
const PROBE = 'tell application "System Events" to return 1\n';
const MAX_OUTPUT = 4096;

function safeHelper(executable: string, fs: UiFilesystem): boolean {
  try {
    if (!path.isAbsolute(executable) || path.normalize(executable) !== executable || fs.realpathSync(executable) !== executable) return false;
    let current = executable;
    for (;;) {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0) return false;
      if (current === executable ? !st.isFile() || (st.mode & 0o111) === 0 : !st.isDirectory()) return false;
      const parent = path.dirname(current); if (parent === current) return true;
      current = parent;
    }
  } catch { return false; }
}

export function createOsascriptUi(verify?: (pass: string) => boolean, deps: OsascriptDependencies = {}): ConfirmUi & { check(text: string): Promise<Parsed> } {
  const executable = deps.executable ?? "/usr/bin/osascript";
  const platform = deps.platform ?? process.platform;
  const fs = deps.filesystem ?? { lstatSync, realpathSync };
  const sourceEnv = deps.env ?? process.env;
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const key of ["HOME", "LANG", "TMPDIR"]) if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  const safe = () => platform === "darwin" && safeHelper(executable, fs);

  // Resolve only at child close, never at stdout end. Mutable I/O buffers are wiped;
  // V8 strings and OS/runtime copies cannot be reliably erased (T4′ limitation).
  function execute<T>(script: string, consume: (text: string) => T, timeoutMs: number): Promise<{ ok: true; value: T } | { ok: false; reason: "helper_failed" | "timeout" }> {
    return new Promise(resolve => {
      const output = Buffer.alloc(MAX_OUTPUT), input = Buffer.from(script, "utf8");
      script = "";
      let size = 0, failed: "helper_failed" | "timeout" | undefined;
      let child: ReturnType<typeof spawn>;
      try { child = spawn(executable, ["-"], { env, stdio: ["pipe", "pipe", "pipe"], shell: false }); }
      catch { zero(input, output); resolve({ ok: false, reason: "helper_failed" }); return; }
      const fail = (reason: "helper_failed" | "timeout") => {
        failed ??= reason;
        child.kill("SIGKILL");
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      };
      const timer = setTimeout(() => fail("timeout"), timeoutMs);
      child.once("error", () => fail("helper_failed"));
      child.stdin!.on("error", () => fail("helper_failed"));
      child.stdout!.on("error", () => fail("helper_failed"));
      child.stderr!.on("error", () => fail("helper_failed"));
      child.stdout!.on("data", (chunk: Buffer) => {
        if (!failed && size + chunk.length <= MAX_OUTPUT) { chunk.copy(output, size); size += chunk.length; }
        else { zero(chunk); fail("helper_failed"); return; }
        zero(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => zero(chunk));
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        try {
          if (failed || code !== 0 || signal !== null) resolve({ ok: false, reason: failed ?? "helper_failed" });
          else resolve({ ok: true, value: consume(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output.subarray(0, size))) });
        } catch { resolve({ ok: false, reason: "helper_failed" }); }
        finally { zero(input, output); }
      });
      child.stdin!.end(input, () => zero(input));
    });
  }
  return {
    async check(text) {
      if (!verify || !safe()) return { approved: false, reason: "approval_unavailable" };
      const result = await execute(confirmationScript(text), value => parseConfirmation(value, verify), deps.timeoutMs ?? 125_000);
      return result.ok ? result.value : { approved: false, reason: result.reason };
    },
    async available() {
      if (!safe()) return false;
      const result = await execute(PROBE, text => text === "1\n" || text === "1", deps.timeoutMs ?? 5000);
      return result.ok && result.value;
    },
    async confirm(record, phrase) {
      if (!verify || !safe() || !sanitize(phrase) || phrase.length > 256 || /[\r\n]/.test(phrase)) return { approved: false, reason: "approval_unavailable" };
      const copy = frozenCopy(record), hash = recordHash(copy);
      const result = await execute(confirmationScript(renderConfirmation(copy, phrase)), text => parseConfirmation(text, verify), deps.timeoutMs ?? 125_000);
      if (!result.ok) return { approved: false, reason: result.reason };
      return result.value.approved ? { approved: true, recordHash: hash, uiKind: "native" } : result.value;
    },
  };
}
