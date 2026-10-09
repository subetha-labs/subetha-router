import { afterEach, expect, test, vi } from "vitest";
import { preflight } from "../../src/daemon/startup.js";
import { Session } from "../../src/daemon/session.js";
import { dispatchLine, RefMutex } from "../../src/daemon/server.js";
import { decodeToolResult, statusOf } from "../../src/router/client.js";

afterEach(() => vi.useRealTimers());

test.each(["--no-disable-sigusr1", "--no_disable_sigusr1", "--no-disable_sigusr1", "--no_disable-sigusr1"])("SIGUSR1 negation %s refuses in either order, even with the mandatory flag", (negation) => {
  for (const guard of ["--disable-sigusr1", "--disable_sigusr1"]) {
    for (const flags of [[guard, negation], [negation, guard], [negation]]) {
      const argv = Object.freeze(flags);
      expect(() => preflight(argv, {})).toThrow(/^sigusr1_enabled$/);
      expect(argv).toEqual(flags);
    }
  }
});

test.each([
  "--heapsnapshot_signal=SIGUSR2", "--report_on_signal", "--report_on_fatalerror",
  "--experimental_loader=/fixture_under/inert.cjs", "--inspect_brk=0", "--cpu_prof",
  "--heap_prof", "--diagnostic_dir=/fixture_under", "--expose_internals",
  "--require=/fixture_under/inert.cjs", "--import=/fixture_under/inert.mjs", "-r/fixture_under/inert.cjs",
])("forbidden option name %s accepts no underscore bypass", (flag) => {
  const argv = Object.freeze(["--disable-sigusr1", flag]);
  expect(() => preflight(argv, {})).toThrow(/^forbidden_flag$/);
  expect(argv).toEqual(["--disable-sigusr1", flag]);
});

test("mandatory option accepts underscore spelling without changing argv or interpreting values as flags", () => {
  const values = ["--disable_sigusr1", "--expose_gc", "--title=--no_disable_sigusr1", "--title=/fixture_under/file_name", "--title", "/fixture_under/file_name"];
  const argv = Object.freeze([...values]);
  expect(() => preflight(argv, {})).not.toThrow();
  expect(argv).toEqual(values);
  expect(() => preflight(["--title=--disable_sigusr1"], {})).toThrow(/^sigusr1_enabled$/);
});

test("guard is unconditional and precedes forbidden flags/env; tripwires scrub before refusal", () => {
  const env = { NODE_OPTIONS: "--require inert.cjs", HOME: "/isolated" };
  expect(() => preflight([], env)).toThrow("sigusr1_enabled");
  expect(env.NODE_OPTIONS).toBeUndefined();
  for (const key of ["NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "DYLD_INSERT_LIBRARIES", "DYLD_OTHER", "LD_PRELOAD", "LD_LIBRARY_PATH", "SUBETHA_PAYER_PASSPHRASE"]) {
    const candidate = { [key]: "", HOME: "/isolated" };
    expect(() => preflight(["--disable-sigusr1"], candidate)).toThrow("forbidden_env");
    expect(candidate[key]).toBeUndefined();
  }
  for (const flag of ["--require=a", "-r", "--import", "--inspect=0", "--report-on-fatalerror", "--heapsnapshot-signal=SIGUSR2", "--cpu-prof", "--heap-prof", "--diagnostic-dir=x", "--expose-internals", "--experimental-loader=x"]) {
    expect(() => preflight(["--disable-sigusr1", flag], {})).toThrow("forbidden_flag");
  }
  expect(() => preflight(["--disable-sigusr1", "--expose-gc"], {})).not.toThrow();
});

test("TTL is bounded and measured from startup; expiry zeroes the same key buffer", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  for (const ttl of [0, -1, 3_600_001, NaN, 0.5]) expect(() => new Session(Buffer.alloc(32, 1), ttl, 1_000)).toThrow();
  const key = Buffer.alloc(32, 7);
  const session = new Session(key, 100, 950);
  expect(session.locked).toBe(false);
  vi.advanceTimersByTime(50);
  expect(session.locked).toBe(true);
  expect(key.equals(Buffer.alloc(32))).toBe(true);
  session.close();
});

test("JSON boundary rejects additional request/output fields and hides exception messages", async () => {
  const handler = vi.fn(async () => ({ ok: true, state: "unlocked", version: "0.1.0" }));
  expect(await dispatchLine('{"id":1,"method":"ping","params":{},"approved":true}', handler)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  expect(handler).not.toHaveBeenCalled();
  const line = '{"id":1,"method":"ping","params":{}}';
  expect(await dispatchLine(line, handler)).toEqual({ id: 1, ok: true, result: { ok: true, state: "unlocked", version: "0.1.0" } });
  for (const run of [async () => ({ ok: true, state: "locked", version: "0.1.0", secret: "hidden" }), async () => { throw new Error("hidden"); }]) {
    expect(await dispatchLine(line, run)).toEqual({ id: 1, ok: false, error: { code: "internal_error" } });
  }
  expect(await dispatchLine('{"id":2,"method":"purchase","params":{"ref":"p_aaaaaaaaaaaaa","approved":true}}', handler)).toMatchObject({ ok: false });
});

test("ref mutex serializes same ref and releases after exceptions", async () => {
  const mutex = new RefMutex();
  const events: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = mutex.run("ref", async () => { events.push(1); await gate; events.push(2); throw new Error(); });
  const failure = first.catch(() => undefined);
  const second = mutex.run("ref", async () => { events.push(3); });
  await Promise.resolve();
  expect(events).toEqual([1]);
  release();
  await Promise.all([failure, second]);
  expect(events).toEqual([1, 2, 3]);
});

test("H-1 extraction prefers structuredContent; status keeps not-found separate from unreadable", () => {
  const value = { ok: false, error: "rate_limited", retryAfterMs: 3000, reason: "rate_host" };
  expect(decodeToolResult({ structuredContent: value, content: [{ type: "text", text: "invalid" }] })).toEqual(value);
  expect(decodeToolResult({ content: [{ type: "text", text: JSON.stringify(value) }] })).toEqual(value);
  expect(() => decodeToolResult({ content: [{ type: "image", text: "{}" }] })).toThrow();
  expect(statusOf({ found: false, reason: "not_found", status: 404 })).toEqual({ kind: "not_found", reason: "not_found" });
  for (const reason of ["unauthorized", "projection_malformed", "transport_failed"]) {
    expect(statusOf({ found: false, reason })).toEqual({ kind: "unreadable", reason });
  }
  expect(statusOf({ found: true, projection: { paymentId: "p", routeId: "r", status: "awaiting_payment", updatedAt: "2026-10-09T00:00:00Z", quoteFingerprint: "f", source: {}, destination: {} } })).toMatchObject({ kind: "found" });
  expect(statusOf({ found: true, projection: {} })).toEqual({ kind: "unreadable", reason: "projection_malformed" });
  expect(statusOf({ found: true })).toMatchObject({ kind: "unreadable" });
});
