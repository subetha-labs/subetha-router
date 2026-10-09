import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { psStartedAtOf } from "../../src/store/lock.js";
import { fixtureExitDiagnostic } from "./diagnostics.js";

export const tsxLoader = createRequire(import.meta.url).resolve("tsx");
export async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture_deadline")), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Own only the child we spawned. Snapshot its original start identity; never infer it at cleanup time. */
export function ownedChild(args: string[], home: string, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, args, {
    env: { PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: `${home}/.config`, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  let outputOverflow = false;
  const bounded = (previous: string, chunk: string) => {
    if (previous.length + chunk.length > 1_048_576) outputOverflow = true;
    return (previous + chunk).slice(0, 1_048_576);
  };
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout = bounded(stdout, chunk); });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = bounded(stderr, chunk); });
  const messages: unknown[] = [];
  const subscribers = new Set<() => void>();
  child.on("message", (message) => {
    if (messages.length < 4096) messages.push(message); else outputOverflow = true;
    for (const notify of subscribers) notify();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  // Attach a handler immediately; callers still receive the rejection through exited.
  void exited.catch(() => undefined);
  // All stream/exit observers are attached before the synchronous identity lookup.
  const originalStart = child.pid === undefined ? undefined : psStartedAtOf(child.pid);
  function signal(signal: NodeJS.Signals): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid === undefined || originalStart === undefined || psStartedAtOf(child.pid) !== originalStart) throw new Error("fixture_child_identity_unverified");
    child.kill(signal);
  }
  return {
    child, exited, messages, get stdout() { return stdout; }, get stderr() { return stderr; }, get outputOverflow() { return outputOverflow; }, signal,
    async waitFor(event: string) {
      const matches = () => messages.find((value) => typeof value === "object" && value !== null && "event" in value && value.event === event);
      if (matches()) return;
      let notify!: () => void;
      try {
        await within(new Promise<void>((resolve, reject) => {
          notify = () => { if (matches()) resolve(); };
          subscribers.add(notify);
          void exited.then((exit) => reject(new Error(`fixture_child_exited_early: ${fixtureExitDiagnostic(`wait:${event}`, exit, stderr)}`)), reject);
        }));
      } finally { subscribers.delete(notify); }
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) { await within(exited); return; }
      signal("SIGTERM");
      try { await within(exited, 2000); }
      catch { signal("SIGKILL"); await within(exited, 2000); }
    },
  };
}
