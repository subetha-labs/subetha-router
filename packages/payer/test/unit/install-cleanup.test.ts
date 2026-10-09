/** Pure callback regression: no fixture allocation, filesystem operations or subprocesses. */
import { expect, test, vi } from "vitest";
import { withCleanup } from "../harness/install.js";

test("cleanup failure preserves the primary thrown object", async () => {
  const primary = new Error("synthetic_primary"), cleanup = new Error("synthetic_cleanup");
  const report = vi.fn();
  await expect(withCleanup(() => { throw primary; }, [() => { throw cleanup; }], report)).rejects.toBe(primary);
  expect(report.mock.calls).toEqual([["install_fixture_cleanup_failed"]]);
});

test("successful operation returns its value after all asynchronous cleanup completes", async () => {
  const value = { result: "synthetic_success" }, events: string[] = [], report = vi.fn();
  const result = await withCleanup(async () => {
    events.push("operation_start");
    await Promise.resolve();
    events.push("operation_end");
    return value;
  }, [async () => {
    events.push("cleanup_start");
    await Promise.resolve();
    events.push("cleanup_end");
  }, () => { events.push("second_cleanup"); }], report);
  events.push("returned");
  expect(result).toBe(value);
  expect(events).toEqual(["operation_start", "operation_end", "cleanup_start", "cleanup_end", "second_cleanup", "returned"]);
  expect(report).not.toHaveBeenCalled();
});

test("synchronous success returns normally and cleans up once", async () => {
  const cleanup = vi.fn(), report = vi.fn();
  await expect(withCleanup(() => "synthetic_value", [cleanup], report)).resolves.toBe("synthetic_value");
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
});

test("primary failure alone is preserved and cleanup still runs once", async () => {
  const primary = new Error("synthetic_primary"), cleanup = vi.fn(), report = vi.fn();
  await expect(withCleanup(() => { throw primary; }, [cleanup], report)).rejects.toBe(primary);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
});

test.each([false, true])("all cleanups are attempted once despite failures (primary fails: %s)", async primaryFails => {
  const primary = new Error("synthetic_primary"), first = new Error("synthetic_cleanup_first"), second = new Error("synthetic_cleanup_second");
  const events: string[] = [], report = vi.fn();
  const cleanups = [
    vi.fn(() => { events.push("first"); throw first; }),
    vi.fn(() => { events.push("second"); throw second; }),
    vi.fn(() => { events.push("third"); }),
  ];
  await expect(withCleanup(() => {
    if (primaryFails) throw primary;
    return "synthetic_value";
  }, cleanups, report)).rejects.toBe(primaryFails ? primary : first);
  expect(events).toEqual(["first", "second", "third"]);
  for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledTimes(1);
  expect(report.mock.calls).toEqual([["install_fixture_cleanup_failed"], ["install_fixture_cleanup_failed"]]);
});

test("rejection after await preserves primary and awaits rejecting cleanup and diagnostics", async () => {
  const primary = new Error("synthetic_primary"), cleanup = new Error("synthetic_cleanup"), events: string[] = [];
  const result = withCleanup(async () => {
    await Promise.resolve();
    events.push("operation_reject");
    throw primary;
  }, [async () => {
    await Promise.resolve();
    events.push("cleanup_reject");
    throw cleanup;
  }, async () => {
    await Promise.resolve();
    events.push("second_cleanup");
  }], async message => {
    await Promise.resolve();
    events.push(message);
  });
  await expect(result).rejects.toBe(primary);
  expect(events).toEqual(["operation_reject", "cleanup_reject", "install_fixture_cleanup_failed", "second_cleanup"]);
});

test.each([undefined, null, "synthetic_non_error", { kind: "synthetic_non_error" }])("preserves primary thrown value identity: %j", async primary => {
  const report = vi.fn();
  await expect(withCleanup(() => { throw primary; }, [() => { throw new Error("synthetic_cleanup"); }], report)).rejects.toBe(primary);
  expect(report.mock.calls).toEqual([["install_fixture_cleanup_failed"]]);
});

test.each([undefined, null, "synthetic_non_error", { kind: "synthetic_non_error" }])("propagates cleanup-only thrown value identity: %j", async failure => {
  const report = vi.fn();
  await expect(withCleanup(() => "synthetic_value", [() => { throw failure; }], report)).rejects.toBe(failure);
  expect(report.mock.calls).toEqual([["install_fixture_cleanup_failed"]]);
});

test.each([
  { primaryFails: false, asyncReport: false },
  { primaryFails: true, asyncReport: false },
  { primaryFails: false, asyncReport: true },
  { primaryFails: true, asyncReport: true },
])("diagnostic failure cannot replace operation/cleanup failure: %j", async ({ primaryFails, asyncReport }) => {
  const primary = new Error("synthetic_primary"), cleanup = new Error("synthetic_cleanup"), diagnostic = new Error("synthetic_diagnostic");
  const later = vi.fn(), events: string[] = [];
  const report = vi.fn((message: string) => {
    events.push(message);
    if (asyncReport) return Promise.resolve().then(() => { events.push("diagnostic_reject"); throw diagnostic; });
    throw diagnostic;
  });
  await expect(withCleanup(() => {
    if (primaryFails) throw primary;
    return "synthetic_value";
  }, [() => { throw cleanup; }, later], report)).rejects.toBe(primaryFails ? primary : cleanup);
  expect(report.mock.calls).toEqual([["install_fixture_cleanup_failed"]]);
  expect(later).toHaveBeenCalledTimes(1);
  expect(events).toEqual(asyncReport ? ["install_fixture_cleanup_failed", "diagnostic_reject"] : ["install_fixture_cleanup_failed"]);
});

test("default diagnostic emits only a fixed safe message", async () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const cleanup = new Error("synthetic_cleanup");
  try {
    await expect(withCleanup(() => "synthetic_value", [() => { throw cleanup; }])).rejects.toBe(cleanup);
    expect(report.mock.calls).toEqual([["install_fixture_cleanup_failed"]]);
  } finally { report.mockRestore(); }
});
