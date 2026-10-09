// Fixture-only projection. Never echo arbitrary stderr, environment, IPC or argv values.
const STDERR_MARKERS = [
  "startup_refused: sigusr1_enabled", "startup_refused: forbidden_env", "startup_refused: forbidden_flag",
  "startup_refused: no_confirmation_ui", "startup_refused: internal_error", "startup_refused: path_invalid",
  "startup_refused: bad_passphrase", "startup_refused: install_changed", "startup_refused: daemon_lock_stale",
  "dyld", "Library not loaded", "Reason: tried", "no such file", "image not found",
  "Debugger listening", "Passphrase:", "Security phrase:",
  "socket_errno: ENAMETOOLONG", "socket_errno: EINVAL", "socket_errno: EPERM", "socket_errno: EACCES",
  "socket_errno: EADDRINUSE", "socket_errno: ENOENT", "socket_errno: ENOTDIR", "socket_errno: EROFS",
  "socket_errno: EMFILE", "socket_errno: ENFILE", "socket_errno: ENOBUFS", "socket_errno: ENOMEM",
  "socket_errno: ERR_INVALID_ARG_VALUE", "socket_errno: UNKNOWN",
] as const;
const FIXTURE_ARGS = new Set(["--disable-sigusr1", "--inspect=0", "--import", "daemon", "--check"]);

/** Callers provide static row/event names and fixture argv only; output is bounded and paths are omitted. */
export function fixtureExitDiagnostic(row: string, exit: { code: number | null; signal: NodeJS.Signals | null }, stderr: string, args: readonly string[] = []): string {
  const sample = stderr.slice(0, 8192);
  const markers = STDERR_MARKERS.filter((marker) => sample.includes(marker));
  return JSON.stringify({
    row: row.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 64),
    code: exit.code, signal: exit.signal,
    argv: args.slice(0, 8).map((arg) => FIXTURE_ARGS.has(arg) ? arg : "<fixture-path-or-redacted>"),
    stderr: sample.length === 0 ? "<empty>" : markers.length ? markers.join("; ") : "<redacted>",
    truncated: stderr.length > sample.length,
  });
}
