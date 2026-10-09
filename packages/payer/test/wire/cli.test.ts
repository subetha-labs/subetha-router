/** Retained P-5a parent gate: NOT executed by the bounded author. Owns every file/child/server. */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, lstatSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { runWallet, publicBalance } from "../../src/cli/wallet.js";
import { runStatus } from "../../src/cli/status.js";
import { runInspect } from "../../src/cli/inspect.js";
import { runConfig } from "../../src/cli/config.js";
import { createDaemonHandler } from "../../src/daemon/handler.js";
import { listenSocket } from "../../src/daemon/server.js";
import { startDaemon } from "../../src/daemon/startup.js";
import { createPurchaseCore } from "../../src/daemon/purchase.js";
import { fixtureStore } from "../harness/store.js";
import { fakeRouter } from "../harness/router.js";
import { ptyFailure } from "../harness/cli-pty-result.js";
import { createDaemonClient } from "../../src/shim/client.js";
import { privateKeyToAddress } from "viem/accounts";
import { cliEvidence } from "../harness/cli-evidence.js";
import { ownedChild, within } from "../harness/children.js";
import { events } from "../harness/durable.js";
import { statusProjection } from "../harness/recovery.js";
import { InspectionSummary, PurchaseSummary } from "../../src/protocol/summary.js";
import { inspectLock } from "../../src/store/lock.js";
import { realFs } from "../../src/store/fs.js";
import { parseConfig } from "../../src/config.js";
import { statusOf } from "../../src/router/client.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const loader = createRequire(import.meta.url).resolve("tsx");
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function home() { const value = realpathSync(mkdtempSync(path.join(tmpdir(), "payer-cli-wire-"))); homes.push(value); return value; }
async function child(file: string, args: string[], input: unknown, env: NodeJS.ProcessEnv) {
  const p = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  let launchError = false, timedOut = false, outputOverflow = false;
  const bounded = (old: string, chunk: string) => {
    if (old.length + chunk.length > 1_048_576) outputOverflow = true;
    return (old + chunk).slice(0, 1_048_576);
  };
  p.stdout.setEncoding("utf8").on("data", c => { stdout = bounded(stdout, c); }); p.stderr.setEncoding("utf8").on("data", c => { stderr = bounded(stderr, c); });
  const timer = setTimeout(() => { timedOut = true; if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); }, 25_000);
  try {
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      p.once("error", () => { launchError = true; });
      p.once("close", (code, signal) => resolve({ code, signal }));
    });
    p.stdin.on("error", () => { launchError = true; });
    p.stdin.end(input === undefined ? "" : JSON.stringify(input));
    return { ...await exit, stdout, stderr, launchError, timedOut, outputOverflow };
  } finally { clearTimeout(timer); }
}
test("owned subprocess wallet encryption, exact secrecy and overwrite refusal", async () => {
  const h = home(), key = randomBytes(32), passphrase = randomBytes(20).toString("base64"), address = privateKeyToAddress(`0x${key.toString("hex")}`);
  const run = (args: string[]) => child(process.execPath, ["--disable-sigusr1", "--import", loader, path.join(root, "test/harness/cli-entry.ts")], { home: h, command: "wallet", args, key: key.toString("hex"), answers: [passphrase, passphrase], tty: true, alive: false }, { PATH: "/usr/bin:/bin", HOME: h });
  const created = await run(["new"]); expect(created.code).toBe(0); expect(created.stdout).toBe(address + "\n"); expect(created.stderr).toBe("");
  for (const secret of [passphrase, key.toString("hex"), key.toString("base64")]) expect(created.stdout + created.stderr).not.toContain(secret);
  expect((await run(["address"])).stdout).toBe(address + "\n");
  const file = path.join(h, ".config/subetha-payer/keys.json"), before = readFileSync(file);
  expect((await run(["new"])).code).toBe(2); expect(readFileSync(file)).toEqual(before); key.fill(0);
});
test("compiled real bin dispatch refuses argument consent and non-TTY close/reclaim", async () => {
  const h = home();
  for (const args of [["wallet", "new"], ["inspect", "p_aaaaaaaaaaaaa", "--close"], ["lock", "reclaim"], ["ui-check"]]) {
    const result = await child(process.execPath, ["--disable-sigusr1", path.join(root, "dist/bin.js"), ...args], undefined, { PATH: "/usr/bin:/bin", HOME: h });
    expect(result.code).toBe(2); expect(result.stdout).toBe(""); expect(result.stderr).toBe("cli_refused: no_tty\n");
  }
});
test("compiled real wallet new through an owned PTY hides passphrase and returns address", async () => {
  const h = home(), passphrase = randomBytes(20).toString("base64");
  const result = await child("python3", [path.join(root, "test/fixtures/cli-pty.py")], { node: process.execPath, bin: path.join(root, "dist/bin.js"), home: h, passphrase }, { PATH: process.env.PATH, HOME: h });
  expect(result.launchError || result.timedOut, ptyFailure(result)).toBe(false);
  expect(result.code, ptyFailure(result)).toBe(0); const value = JSON.parse(result.stdout); expect(value.exit).toBe(0); expect(value.prompts).toBe(2); expect(value.addresses).toHaveLength(1); expect(value.addresses[0]).toMatch(/^0x[0-9a-fA-F]{40}$/); expect(result.stderr).toBe("");
});
test("balance production RPC protocol over owned TCP fixture only", async () => {
  const store = fixtureStore(), requests: any[] = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const request = JSON.parse(text); requests.push(request);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: request.method === "eth_chainId" ? "0x14a34" : "0x" + (1234567).toString(16).padStart(64, "0") }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw 0;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  try {
    expect(await runWallet(["balance"], { env: { HOME: store.home }, lockDeps: { startedAtOf: () => "fixture", isAlive: () => false }, balance: (rpc, wallet) => publicBalance(rpc, wallet, (_url, init) => fetch(`http://127.0.0.1:${address.port}/`, init)) })).toBe(0);
    expect(stdout.mock.calls.map(c => c[0]).join("")).toBe("1234567\n"); expect(requests.map(r => r.method)).toEqual(["eth_chainId", "eth_call"]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.cleanup(); }
});
test("CLI status/inspect use actual daemon socket and durable saved quote, config refuses active daemon", async () => {
  const router = await fakeRouter(), store = fixtureStore(router.url.href), mask = process.umask();
  const lockDeps = { startedAtOf: () => "fixture-start", isAlive: () => true };
  const daemon = await startDaemon({ env: { HOME: store.home }, execArgv: ["--disable-sigusr1"], installRoot: store.installRoot, lockDeps,
    hooks: { ui: { available: async () => true }, tty: { available: true, read: async label => label === "Passphrase" ? store.passphrase : store.phrase }, handler: createDaemonHandler, listen: listenSocket, recover: async () => {} } });
  if (!daemon) throw 0;
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true), error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const deps = { env: { HOME: store.home }, lockDeps, tty: { available: true, read: async () => { throw 0; } } };
  try {
    const core = createPurchaseCore(daemon.context), quoted = await core.quote() as { ref: string }; expect(quoted.ref).toMatch(/^p_/);
    expect(await runStatus([quoted.ref], deps)).toBe(0); expect(JSON.parse(String(output.mock.calls.at(-1)![0])).state).toBe("quoted");
    expect(await runInspect([quoted.ref], deps)).toBe(0); expect(JSON.parse(String(output.mock.calls.at(-1)![0])).inspections[0].rows).toHaveLength(1);
    expect(await runConfig(["set", "session.ttlMs", "60000"], deps)).toBe(2); expect(error.mock.calls.flat().join("")).toContain("daemon_already_running"); expect(router.state.calls.purchase).toBe(0);
    const client = createDaemonClient({ HOME: store.home }); try { expect(await client.request("ping", {})).toMatchObject({ ok: true, state: "unlocked" }); } finally { await client.close(); }
  } finally { await daemon.close(); process.umask(mask); store.cleanup(); await router.close(); }
});

// FIX2: all rows below are retained for the parent's real-process gate, UNRUN by author.
const bin = path.join(root, "dist/bin.js");
const daemonEntry = path.join(root, "test/harness/daemon-test-entry.ts");
type Evidence = ReturnType<typeof cliEvidence>;
type WireFixture = {
  e: Evidence; router: Awaited<ReturnType<typeof fakeRouter>>;
  boot(): Promise<ReturnType<typeof ownedChild>>;
};
async function withCliFixture(last: "signed" | "unknown", action: (f: WireFixture) => Promise<void>) {
  const router = await fakeRouter();
  let e: Evidence | undefined, daemon: ReturnType<typeof ownedChild> | undefined;
  let failed = false;
  try {
    e = cliEvidence(router.url.href, last);
    const evidence = e;
    await action({ e, router, async boot() {
      if (daemon) throw new Error("fixture_duplicate_boot");
      daemon = ownedChild(["--disable-sigusr1", "--import", loader, daemonEntry], evidence.store.home);
      daemon.child.send({ home: evidence.store.home, installRoot: evidence.store.installRoot,
        passphrase: evidence.store.passphrase, phrase: evidence.store.phrase, purchase: true });
      await daemon.waitFor("listening");
      expect(daemon.outputOverflow).toBe(false);
      return daemon;
    } });
  } catch (error) { failed = true; throw error; }
  finally {
    // Preserve the primary assertion; do not remove a store until its owned child is closed.
    let cleanupFailed = false, childClosed = false;
    try { await daemon?.close(); childClosed = true; } catch { cleanupFailed = true; }
    try { await router.close(); } catch { cleanupFailed = true; }
    if (childClosed) { try { e?.store.cleanup(); } catch { cleanupFailed = true; } }
    if (cleanupFailed && !failed) throw new Error("fixture_cleanup_incomplete");
  }
}
function compiled(home: string, args: string[]) {
  return child(process.execPath, ["--disable-sigusr1", bin, ...args], undefined, { PATH: "/usr/bin:/bin", HOME: home });
}
function healthy(result: Awaited<ReturnType<typeof child>>) {
  expect(result.launchError || result.timedOut || result.outputOverflow, ptyFailure(result)).toBe(false);
  expect(result.signal).toBeNull();
}
type PtyResult = { exit: number; prompts: number; outputs: unknown[]; refusals: string[] };
async function terminal(e: Evidence, args: string[], interactions: { prompt: string; answer: string }[] = [], extraSecrets: string[] = [], observeReclaim = false): Promise<PtyResult> {
  const result = await child("python3", [path.join(root, "test/fixtures/cli-pty.py")], {
    node: process.execPath, bin: observeReclaim ? path.join(root, "test/harness/cli-lock-entry.ts") : bin,
    ...(observeReclaim ? { loader } : {}), home: e.store.home, args, interactions, secrets: [...e.secrets, ...extraSecrets],
  }, { PATH: process.env.PATH, HOME: e.store.home });
  healthy(result); expect(result.code, ptyFailure(result)).toBe(0);
  // Boolean oracle before parsing/assertion prevents secret-bearing diffs on failure.
  expect(e.safe([result.stdout, result.stderr], extraSecrets)).toBe(true);
  expect(result.stderr === "").toBe(true);
  let value: PtyResult;
  try { value = JSON.parse(result.stdout) as PtyResult; } catch { throw new Error("fixture_pty_invalid_json"); }
  expect(e.safe(value, extraSecrets)).toBe(true);
  expect(value.prompts).toBe(interactions.length);
  return value;
}
const unlock = (e: Evidence) => [{ prompt: "Passphrase: ", answer: e.store.passphrase }];
function savedStates(e: Evidence) { return e.rows().map(row => row.state); }
function assertNoSideEffects(f: WireFixture) {
  expect(f.router.state.calls.purchase).toBe(0);
  expect(f.router.state.calls.quote).toBe(0);
  expect(events(path.join(f.e.store.home, "events.ndjson")).filter(event => ["sign", "confirm"].includes(event.event))).toEqual([]);
}

for (const command of ["status", "inspect"] as const)
for (const kind of ["matched", "identity-mismatch", "unreadable", "not_found"] as const)
test(`compiled CLI ${command} saved unknown -> socket -> Router TCP: ${kind}`, async () => {
  await withCliFixture("unknown", async f => {
    const { e, router } = f, saved = readFileSync(e.file);
    expect(savedStates(e).at(-1)).toBe("unknown");
    const daemon = await f.boot();
    // Production startup recovery ran against true not_found before CLI-specific evidence appears.
    expect(router.state.calls.status).toBe(1);
    expect(router.state.statusPaymentIds).toEqual([e.record.paymentId]);
    expect(readFileSync(e.file).equals(saved)).toBe(true);
    const matching = statusProjection(e.raw.quote);
    router.state.status = kind === "matched" ? matching : kind === "identity-mismatch"
      ? { ...matching, projection: { ...matching.projection, quoteFingerprint: `sha256:${"ef".repeat(32)}` } }
      : kind === "unreadable" ? { found: true, projection: { paymentId: e.record.paymentId } }
      : { found: false, reason: "not_found", status: 404 };
    expect(statusOf(router.state.status).kind).toBe(["matched", "identity-mismatch"].includes(kind) ? "found" : kind === "not_found" ? "not_found" : "unreadable");
    const before = { ...router.state.calls }, requestsBefore = events(path.join(e.store.home, "socket-requests.ndjson")).length;
    const result = await compiled(e.store.home, [command, e.ref]);
    healthy(result); expect(e.safe([result.stdout, result.stderr, daemon.stdout, daemon.stderr])).toBe(true);
    expect(result.code).toBe(0); expect(result.stderr === "").toBe(true);
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("fixture_cli_invalid_json"); }
    expect(e.safe(parsed)).toBe(true);
    const valid = command === "status" ? PurchaseSummary.safeParse(parsed) : InspectionSummary.safeParse(parsed);
    expect(valid.success).toBe(true);
    const summary = command === "status" ? PurchaseSummary.parse(parsed) : InspectionSummary.parse(parsed).inspections[0]!.summary;
    expect(summary).toMatchObject({ ref: e.ref, paymentId: e.record.paymentId,
      state: kind === "matched" ? "result" : "unknown", fundsMoved: kind === "matched" ? "yes" : "maybe" });
    if (kind === "matched") expect(summary).toMatchObject({ outcome: "delivered", result: { untrusted: true, bytes: 2060 }, proof: { onChainFinality: "not_checked" } });
    else expect(summary).toMatchObject({ outcome: "unknown", nextStep: "unknown_inspect" });
    expect(router.state.calls.status - before.status).toBe(1);
    expect(router.state.statusPaymentIds.slice(before.status)).toEqual([e.record.paymentId]);
    expect(router.state.calls.purchase - before.purchase).toBe(0);
    const requests = events(path.join(e.store.home, "socket-requests.ndjson")).slice(requestsBefore);
    expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([{ method: "inspect", params: { ref: e.ref } }]);
    expect(savedStates(e).at(-1)).toBe(kind === "matched" ? "result" : "unknown");
    assertNoSideEffects(f);
  });
}, 45_000);

test("OFFLINE compiled CLI/PTY saved signed + true not_found persists unknown across a NEW CLI; AC-A9", async () => {
  await withCliFixture("signed", async f => {
    const { e, router } = f;
    expect(savedStates(e)).toEqual(["quoted", "approved", "sign_intent", "signed"]);
    // Legitimately absent seal: seed creation never boots a daemon or fabricates install hashes.
    expect(existsSync(path.join(e.store.dir, "install.seal"))).toBe(false);
    expect(router.state.calls.status).toBe(0);
    const first = await terminal(e, ["inspect", e.ref], unlock(e));
    expect(first.exit).toBe(0); expect(first.refusals).toEqual([]); expect(first.outputs).toHaveLength(1);
    const inspection = InspectionSummary.parse(first.outputs[0]);
    expect(inspection.inspections[0]!.summary).toMatchObject({ ref: e.ref, paymentId: e.record.paymentId, state: "unknown", fundsMoved: "maybe" });
    expect(inspection.inspections[0]!.rows.map(row => row.state)).toEqual(["quoted", "approved", "sign_intent", "signed", "unknown"]);
    expect(savedStates(e)).toEqual(["quoted", "approved", "sign_intent", "signed", "unknown"]);
    expect(router.state.calls.status).toBe(1); expect(router.state.statusPaymentIds).toEqual([e.record.paymentId]);
    const saved = readFileSync(e.file), seal = readFileSync(path.join(e.store.dir, "install.seal"));
    const second = await terminal(e, ["status", e.ref], unlock(e));
    expect(second.exit).toBe(0); expect(second.refusals).toEqual([]); expect(second.outputs).toHaveLength(1);
    expect(PurchaseSummary.parse(second.outputs[0])).toEqual(inspection.inspections[0]!.summary);
    expect(readFileSync(e.file).equals(saved)).toBe(true); expect(readFileSync(path.join(e.store.dir, "install.seal")).equals(seal)).toBe(true);
    expect(router.state.calls.status).toBe(2); expect(router.state.statusPaymentIds).toEqual([e.record.paymentId, e.record.paymentId]);
    expect(existsSync(path.join(e.store.dir, "daemon.sock"))).toBe(false);
    expect(existsSync(path.join(e.store.home, "events.ndjson"))).toBe(false);
    expect(e.safe([first, second])).toBe(true); assertNoSideEffects(f);
  });
}, 60_000);

test("actual CLI/PTY reclaim preserves live owner, stale cancellation, then removes owned socket before matched lock", async () => {
  await withCliFixture("unknown", async f => {
    const { e } = f, daemon = await f.boot(), dir = e.store.dir;
    const lockFile = path.join(dir, "daemon.lock"), socketFile = path.join(dir, "daemon.sock");
    const lockBytes = readFileSync(lockFile), owner = JSON.parse(lockBytes.toString("utf8"));
    expect(owner.pid).toBe(daemon.child.pid); expect(owner.startedAt.length).toBeGreaterThan(0);
    expect(inspectLock(dir, { fs: realFs })).toMatchObject({ state: "held", content: owner });
    const identity = (file: string) => { const s = lstatSync(file); return { dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode }; };
    const lockIdentity = identity(lockFile), socketIdentity = identity(socketFile);
    // This sentinel is disposable. The actual controller worker.lock is never opened or removed.
    writeFileSync(path.join(dir, "worker.lock"), "fixture sentinel", { mode: 0o600 });
    const snapshot = readdirSync(dir).sort().map(name => ({ name, identity: identity(path.join(dir, name)),
      bytes: lstatSync(path.join(dir, name)).isFile() ? readFileSync(path.join(dir, name)) : undefined }));
    const unchanged = () => {
      expect(readdirSync(dir).sort()).toEqual(snapshot.map(item => item.name));
      for (const item of snapshot) {
        expect(identity(path.join(dir, item.name))).toEqual(item.identity);
        if (item.bytes) expect(readFileSync(path.join(dir, item.name)).equals(item.bytes)).toBe(true);
      }
    };
    const confirm = (answer: string) => [{ prompt: "Confirm no daemon/contender is running; reclaim dead owner lock? (y/N): ", answer }];
    // Compiled bin establishes the real entry/TTY/liveness refusal as well as the observer entry below.
    const live = await terminal(e, ["lock", "reclaim"], confirm("y"));
    expect(live.exit).toBe(2); expect(live.refusals).toEqual(["cli_refused: daemon_already_running"]); expect(live.outputs).toEqual([]); unchanged();
    daemon.signal("SIGKILL"); expect(await within(daemon.exited)).toEqual({ code: null, signal: "SIGKILL" });
    expect(inspectLock(dir, { fs: realFs })).toMatchObject({ state: "stale", content: owner });
    unchanged();
    const cancel = await terminal(e, ["lock", "reclaim"], confirm("n"));
    expect(cancel.exit).toBe(2); expect(cancel.refusals).toEqual(["cli_refused: operator_cancelled"]); expect(cancel.outputs).toEqual([]); unchanged();
    const yes = await terminal(e, ["reclaim"], confirm("y"), [], true);
    expect(yes.exit).toBe(0); expect(yes.refusals).toEqual([]); expect(yes.outputs).toEqual([{ ok: true, removed: true }]);
    const unlinks = events(path.join(e.store.home, "cli-reclaim-unlinks.ndjson"));
    expect(unlinks).toEqual([
      { name: "daemon.sock", dev: socketIdentity.dev, ino: socketIdentity.ino, lockDev: lockIdentity.dev, lockIno: lockIdentity.ino, owner },
      { name: "daemon.lock", dev: lockIdentity.dev, ino: lockIdentity.ino, lockDev: lockIdentity.dev, lockIno: lockIdentity.ino, owner },
    ]);
    const remaining = snapshot.filter(item => !["daemon.sock", "daemon.lock"].includes(item.name));
    expect(readdirSync(dir).sort()).toEqual(remaining.map(item => item.name));
    for (const item of remaining) {
      expect(identity(path.join(dir, item.name))).toEqual(item.identity);
      if (item.bytes) expect(readFileSync(path.join(dir, item.name)).equals(item.bytes)).toBe(true);
    }
    expect(readFileSync(path.join(dir, "worker.lock"), "utf8")).toBe("fixture sentinel");
    expect(existsSync(path.join(dir, "daemon.lock.reclaim"))).toBe(false);
    assertNoSideEffects(f);
  });
}, 60_000);

test("active real daemon + compiled CLI/PTY config set router.url is refused; valid offline positive control", async () => {
  await withCliFixture("unknown", async f => {
    const { e, router } = f, configFile = path.join(e.store.dir, "config.json");
    const before = readFileSync(configFile), current = parseConfig(JSON.parse(before.toString("utf8")));
    expect(current.router.canonicalResource).toEqual(e.raw.quote.resource);
    // A local syntactically valid transport; config must never connect to it.
    const alternate = `http://127.0.0.1:${router.url.port}/alternate-mcp`;
    expect(parseConfig({ ...current, router: { ...current.router, url: alternate } }).router.url).toBe(alternate);
    const daemon = await f.boot(), owner = readFileSync(path.join(e.store.dir, "daemon.lock"));
    const counters = { ...router.state.calls };
    for (const [field, value] of [["router.url", alternate], ["session.ttlMs", "60000"]]) {
      const result = await terminal(e, ["config", "set", field!, value!]);
      expect(result.exit).toBe(2); expect(result.refusals).toEqual(["cli_refused: daemon_already_running"]); expect(result.outputs).toEqual([]);
      expect(readFileSync(configFile).equals(before)).toBe(true);
      expect(readFileSync(path.join(e.store.dir, "daemon.lock")).equals(owner)).toBe(true);
      const client = createDaemonClient({ HOME: e.store.home });
      try { expect(await client.request("ping", {})).toMatchObject({ ok: true, state: "unlocked" }); } finally { await client.close(); }
      expect(daemon.child.exitCode).toBeNull(); expect(daemon.child.signalCode).toBeNull();
    }
    expect(router.state.calls).toEqual(counters);
    await daemon.close(); expect(await daemon.exited).toEqual({ code: 0, signal: null });
    const positive = await terminal(e, ["config", "set", "router.url", alternate]);
    expect(positive.exit).toBe(0); expect(positive.refusals).toEqual([]); expect(positive.outputs).toEqual([{ ok: true, effective: "next_daemon_start" }]);
    expect(parseConfig(JSON.parse(readFileSync(configFile, "utf8"))).router).toEqual({ ...current.router, url: alternate });
    expect(router.state.calls).toEqual(counters); assertNoSideEffects(f);
  });
}, 60_000);

test("OFFLINE compiled inspect --close real PTY synthetic cancel/confirm and durable NEW CLI reopen", async () => {
  await withCliFixture("unknown", async f => {
    const { e, router } = f, reason = `synthetic review ${randomBytes(24).toString("hex")}`;
    const interactions = (answer: string) => [...unlock(e),
      { prompt: "Reason for closing this unknown outcome (funds may have moved): ", answer: reason },
      { prompt: "Close this ref by operator without retrying payment? (y/N): ", answer }];
    const original = readFileSync(e.file);
    const cancel = await terminal(e, ["inspect", e.ref, "--close"], interactions("n"), [reason]);
    expect(cancel.exit).toBe(2); expect(cancel.refusals).toEqual(["cli_refused: operator_cancelled"]); expect(cancel.outputs).toHaveLength(1);
    expect(InspectionSummary.parse(cancel.outputs[0]).inspections[0]!.summary.state).toBe("unknown");
    expect(readFileSync(e.file).equals(original)).toBe(true); expect(savedStates(e)).not.toContain("closed_by_operator");
    expect(router.state.calls.status).toBe(1); assertNoSideEffects(f);
    const confirmed = await terminal(e, ["inspect", e.ref, "--close"], interactions("y"), [reason]);
    expect(confirmed.exit).toBe(0); expect(confirmed.refusals).toEqual([]); expect(confirmed.outputs).toHaveLength(2);
    expect(InspectionSummary.parse(confirmed.outputs[0]).inspections[0]!.summary.state).toBe("unknown");
    expect(PurchaseSummary.parse(confirmed.outputs[1])).toMatchObject({ ref: e.ref, paymentId: e.record.paymentId, state: "closed_by_operator", reason: "closed_by_operator", fundsMoved: "maybe" });
    expect(savedStates(e).at(-1)).toBe("closed_by_operator"); expect(e.hasSealedReason(reason)).toBe(true);
    expect(router.state.calls.status).toBe(2);
    const saved = readFileSync(e.file), seal = readFileSync(path.join(e.store.dir, "install.seal"));
    const reopened = await terminal(e, ["inspect", e.ref], unlock(e), [reason]);
    expect(reopened.exit).toBe(0); expect(reopened.refusals).toEqual([]); expect(reopened.outputs).toHaveLength(1);
    expect(InspectionSummary.parse(reopened.outputs[0]).inspections[0]!.summary).toEqual(confirmed.outputs[1]);
    expect(readFileSync(e.file).equals(saved)).toBe(true); expect(readFileSync(path.join(e.store.dir, "install.seal")).equals(seal)).toBe(true);
    expect(router.state.calls.status).toBe(2); expect(router.state.statusPaymentIds).toEqual([e.record.paymentId, e.record.paymentId]);
    expect(e.safe([cancel, confirmed, reopened], [reason])).toBe(true); assertNoSideEffects(f);
  });
}, 60_000);
