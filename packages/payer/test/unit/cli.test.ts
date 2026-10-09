import { afterEach, expect, test, vi } from "vitest";
import { main } from "../../src/bin.js";
afterEach(() => vi.restoreAllMocks());
// Initial RED: real bin dispatch, before any store/process/RPC access.
test.each([
  ["wallet", "new", "--key", "synthetic-secret"],
  ["status", "invalid-ref"], ["inspect", "p_aaaaaaaaaaaaa", "--close", "yes"],
  ["config", "set", "unknown", "value"], ["lock", "reclaim", "yes"], ["ui-check", "--approve"],
])("real dispatch rejects invalid argv without echo: %j", async (...argv) => {
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(await main(argv, ["--disable-sigusr1"])).toBe(2);
  expect(out).not.toHaveBeenCalled();
  expect(err.mock.calls.map(c => c[0]).join("")).toBe("cli_refused: invalid_arguments\n");
});

// Dispatch wiring uses actual command implementations and an owned HOME via module seams.
// No dependency override is accepted by bin argv or environment.
import * as walletModule from "../../src/cli/wallet.js";
import * as configModule from "../../src/cli/config.js";
import * as statusModule from "../../src/cli/status.js";
import * as inspectModule from "../../src/cli/inspect.js";
import * as lockModule from "../../src/cli/lock.js";
import * as uiModule from "../../src/cli/ui-check.js";
import * as daemonModule from "../../src/daemon/run.js";
import * as shimModule from "../../src/shim/run.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliDeps } from "../../src/cli/common.js";

test("bin dispatches real wallet new/address and config get, exact argv/exits", async () => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "payer-bin-unit-")));
  const deps: CliDeps = { env: { HOME: home }, lockDeps: { startedAtOf: () => "fixture", isAlive: () => false }, tty: { available: true, read: async () => "synthetic-only-passphrase" } };
  const wallet = walletModule.runWallet, config = configModule.runConfig;
  const w = vi.spyOn(walletModule, "runWallet").mockImplementation(args => wallet(args, deps));
  const c = vi.spyOn(configModule, "runConfig").mockImplementation(args => config(args, deps));
  const out = vi.spyOn(process.stdout, "write").mockReturnValue(true), err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    expect(await main(["wallet", "new"], ["--disable-sigusr1"])).toBe(0);
    const address = String(out.mock.calls[0]![0]); expect(address).toMatch(/^0x[0-9a-fA-F]{40}\n$/);
    expect(await main(["wallet", "address"], ["--disable-sigusr1"])).toBe(0); expect(out.mock.calls[1]![0]).toBe(address);
    expect(await main(["config", "get"], ["--disable-sigusr1"])).toBe(0);
    expect(w.mock.calls).toEqual([[["new"]], [["address"]]]); expect(c.mock.calls).toEqual([[["get"]]]); expect(err).not.toHaveBeenCalled();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test("bin dispatch maps each human command and keeps daemon/mcp startup separate", async () => {
  const ref = "p_aaaaaaaaaaaaa", exec = ["--disable-sigusr1"];
  const status = vi.spyOn(statusModule, "runStatus").mockResolvedValue(0);
  const inspect = vi.spyOn(inspectModule, "runInspect").mockResolvedValue(2);
  const lock = vi.spyOn(lockModule, "runLock").mockResolvedValue(2);
  const ui = vi.spyOn(uiModule, "runUiCheck").mockResolvedValue(0);
  const daemon = vi.spyOn(daemonModule, "runDaemon").mockResolvedValue(0);
  const shim = vi.spyOn(shimModule, "runShim").mockResolvedValue(0);
  expect(await main(["status", ref], exec)).toBe(0); expect(status).toHaveBeenCalledExactlyOnceWith([ref]);
  expect(await main(["inspect", ref, "--close"], exec)).toBe(2); expect(inspect).toHaveBeenCalledExactlyOnceWith([ref, "--close"]);
  expect(await main(["lock", "reclaim"], exec)).toBe(2); expect(lock).toHaveBeenCalledExactlyOnceWith(["reclaim"]);
  expect(await main(["ui-check"], exec)).toBe(0); expect(ui).toHaveBeenCalledExactlyOnceWith([]);
  expect(await main(["daemon", "--check"], exec)).toBe(0); expect(daemon).toHaveBeenCalledExactlyOnceWith(["--check"], exec);
  expect(await main(["mcp"], exec)).toBe(0); expect(shim).toHaveBeenCalledExactlyOnceWith([]);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  expect(await main(["daemon"], [])).toBe(2); expect(daemon).toHaveBeenCalledTimes(1);
});
