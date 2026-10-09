import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ptyFailure } from "../harness/cli-pty-result.js";

test("pure Python PTY lifecycle regression (all OS operations injected)", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("../fixtures/cli-pty-lifecycle.py", import.meta.url))], { encoding: "utf8", timeout: 5000 });
  // The unittest diagnostics contain only synthetic public address/fixed labels.
  expect(result.error === undefined).toBe(true);
  expect(result.status, result.stderr).toBe(0);
});

test("PTY failure diagnostics allow fixed classes only and retain code/signal", () => {
  const base = { code: 1, signal: null, launchError: false, timedOut: false };
  for (const code of ["owned_pty_deadline", "owned_pty_secret_leak", "owned_pty_launch_error", "owned_pty_child_lost", "owned_pty_error"]) {
    expect(ptyFailure({ ...base, stderr: code + "\n" })).toBe(`${code}; code=1; signal=null`);
  }
  for (const stderr of ["synthetic-secret", "owned_pty_deadline\nsynthetic-secret", ""]) {
    expect(ptyFailure({ ...base, stderr })).toBe("helper_unrecognized_failure; code=1; signal=null");
  }
  expect(ptyFailure({ ...base, stderr: "synthetic-secret", launchError: true, code: null })).toBe("helper_launch_error; code=null; signal=null");
  expect(ptyFailure({ ...base, stderr: "synthetic-secret", timedOut: true, code: null, signal: "SIGKILL" })).toBe("helper_outer_deadline; code=null; signal=SIGKILL");
});
