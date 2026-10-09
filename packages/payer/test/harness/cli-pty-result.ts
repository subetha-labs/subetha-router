/** Fixed diagnostics only: never interpolate helper output or exception text. */
export function ptyFailure(result: {
  code: number | null; signal: NodeJS.Signals | null; stderr: string;
  launchError: boolean; timedOut: boolean;
}): string {
  const known = ["owned_pty_deadline", "owned_pty_secret_leak", "owned_pty_launch_error", "owned_pty_child_lost", "owned_pty_error"];
  const classification = result.launchError ? "helper_launch_error" : result.timedOut ? "helper_outer_deadline"
    : known.find(code => result.stderr === code + "\n") ?? "helper_unrecognized_failure";
  return `${classification}; code=${result.code}; signal=${result.signal}`;
}
