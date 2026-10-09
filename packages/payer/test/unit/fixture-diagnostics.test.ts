import { expect, test } from "vitest";
import { fixtureExitDiagnostic } from "../harness/diagnostics.js";

test("fixture exit diagnostics retain row/code/signal and known stderr markers, never paths or secrets", () => {
  const diagnostic = fixtureExitDiagnostic("dyld-insert-libraries", { code: null, signal: "SIGABRT" },
    "dyld[123]: Library not loaded: /private/fixture.dylib\nReason: tried: /private/path (no such file)\nsecret-fixture-value\u001b[31m",
    ["--disable-sigusr1", "/private/fixture/bin.js", "daemon"]);
  expect(JSON.parse(diagnostic)).toMatchObject({ row: "dyld-insert-libraries", code: null, signal: "SIGABRT",
    argv: ["--disable-sigusr1", "<fixture-path-or-redacted>", "daemon"], stderr: "dyld; Library not loaded; Reason: tried; no such file" });
  expect(diagnostic).not.toMatch(/private|secret-fixture-value|123|\u001b/);
});

test("unknown stderr is redacted; oversized fixture diagnostics are bounded", () => {
  expect(JSON.parse(fixtureExitDiagnostic("row", { code: 2, signal: null }, "secret-only"))).toMatchObject({ stderr: "<redacted>" });
  const diagnostic = fixtureExitDiagnostic("row".repeat(100), { code: 2, signal: null }, "x".repeat(100_000), Array(100).fill("private"));
  expect(diagnostic.length).toBeLessThan(1500);
  expect(JSON.parse(diagnostic)).toMatchObject({ truncated: true });
  expect(diagnostic).not.toContain("private");
});

test("early exit diagnosis distinguishes known path and permission errno without arbitrary messages", () => {
  for (const code of ["ENAMETOOLONG", "EINVAL", "EPERM"]) {
    const diagnostic = fixtureExitDiagnostic("wait:listening", { code: 2, signal: null }, `startup_refused: internal_error\nsocket_errno: ${code}\nsecret-only`);
    expect(JSON.parse(diagnostic).stderr).toBe(`startup_refused: internal_error; socket_errno: ${code}`);
    expect(diagnostic).not.toContain("secret-only");
  }
});
