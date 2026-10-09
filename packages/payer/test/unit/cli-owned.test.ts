/** Owned files only. Every process-identity, TTY, Router, RPC and daemon call is injected. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { privateKeyToAddress } from "viem/accounts";
import { runWallet, publicBalance } from "../../src/cli/wallet.js";
import { runConfig } from "../../src/cli/config.js";
import { runLock } from "../../src/cli/lock.js";
import { runInspect } from "../../src/cli/inspect.js";
import { runStatus } from "../../src/cli/status.js";
import { runUiCheck } from "../../src/cli/ui-check.js";
import { type CliDeps } from "../../src/cli/common.js";
import { createKeysDocument, parseKeysDocument, unlockKeys, openWallet, zero } from "../../src/store/keys.js";
import { openLedger } from "../../src/store/ledger.js";
import { realFs, StoreError } from "../../src/store/fs.js";
import { parseConfig, BASE_RPC, USDC } from "../../src/config.js";
import { buildRecord, recordHash, jsonCopy } from "../../src/daemon/record.js";
import { createDaemonHandler } from "../../src/daemon/handler.js";
import { Session } from "../../src/daemon/session.js";
import { Request } from "../../src/protocol/socket.js";
import { h1Quote } from "../harness/router.js";
import { type RouterStatus } from "../../src/router/client.js";
import { HOSTED_ROUTER_URL } from "../../src/router/identity.js";

const cleanups: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "payer-cli-")));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".config", "subetha-payer"), installRoot = path.join(home, "install");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(installRoot, "dist"), { recursive: true }); mkdirSync(path.join(installRoot, "node_modules"));
  writeFileSync(path.join(installRoot, "dist", "entry.js"), "owned installation");
  const pass = randomBytes(20).toString("base64"), key = randomBytes(32), address = privateKeyToAddress(`0x${key.toString("hex")}`);
  const answers: string[] = [pass, pass];
  const read = vi.fn(async () => answers.shift() ?? "y");
  const deps: CliDeps = { env: { HOME: home }, installRoot,
    lockDeps: { pid: 123456, hostname: "owned-host", isAlive: () => false, startedAtOf: () => "T0" },
    tty: { available: true, read }, randomKey: () => Buffer.from(key),
  };
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true), stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const out = () => stdout.mock.calls.map(c => String(c[0])).join(""), err = () => stderr.mock.calls.map(c => String(c[0])).join("");
  const reset = () => { stdout.mockClear(); stderr.mockClear(); };
  const saveKey = () => writeFileSync(path.join(dir, "keys.json"), JSON.stringify(createKeysDocument(pass, { eip155: { address, secret: key } })), { mode: 0o600 });
  function lock(alive = true, start = "T0") {
    writeFileSync(path.join(dir, "daemon.lock"), JSON.stringify({ pid: 789012, startedAt: "T0", hostname: "owned-host", token: "0123456789abcdef" }), { mode: 0o600 });
    deps.lockDeps = { ...deps.lockDeps, isAlive: () => alive, startedAtOf: () => start };
  }
  return { home, dir, pass, key, address, answers, read, deps, stdout, stderr, out, err, reset, saveKey, lock };
}
function evidence(f: ReturnType<typeof fixture>, last = "signed") {
  f.saveKey();
  const doc = parseKeysDocument(readFileSync(path.join(f.dir, "keys.json"), "utf8")), keys = unlockKeys(doc, f.pass);
  const file = path.join(f.dir, "ledger.ndjson"), ledger = openLedger(file, keys.lek, realFs);
  const raw = h1Quote(), ref = "p_aaaaaaaaaaaaa", requestId = randomUUID();
  const record = buildRecord(raw, { routerUrl: HOSTED_ROUTER_URL, address: f.address, ref, requestId });
  const hash = recordHash(record), credential = randomBytes(40).toString("base64");
  for (const state of ["quoted", "approved", "sign_intent", "signed", "submit_intent", "unknown"]) {
    const data = state === "quoted" ? jsonCopy(record) : state === "approved" ? { recordHash: hash, shownAt: Date.now(), uiKind: "native" } : state === "unknown" ? { paymentId: record.paymentId } : { recordHash: hash };
    const sealed = state === "quoted" ? raw : state === "signed" ? { credential } : undefined;
    ledger.append({ ref, state, data: jsonCopy(data), ...(sealed ? { sealedPlain: Buffer.from(JSON.stringify(sealed)) } : {}) });
    if (state === last) break;
  }
  ledger.close(); zero(keys.kek, keys.lek);
  let status: RouterStatus = { kind: "not_found", reason: "not_found" };
  const statusCall = vi.fn(async () => status), purchase = vi.fn(async () => { throw new Error("must never submit"); });
  f.deps.router = { status: statusCall, purchase, quote: async () => { throw 0; }, listRoutes: async () => { throw 0; } };
  f.answers.splice(0, f.answers.length, f.pass);
  return { file, ref, record, credential, statusCall, purchase, status: (value: RouterStatus) => { status = value; } };
}

test("wallet exact address-only secrecy oracle; encrypted random-key roundtrip; original key bytes zeroed", async () => {
  const f = fixture(), bytes = Buffer.from(f.key); f.deps.randomKey = () => bytes;
  expect(await runWallet(["new"], f.deps)).toBe(0);
  // Future wallet-prints-key mutation MUST fail here, after successful creation.
  expect(f.out()).toBe(f.address + "\n"); expect(f.err()).toBe("");
  for (const secret of [f.pass, f.key.toString("hex"), f.key.toString("base64")]) {
    for (const encoded of [secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("hex")]) expect(f.out() + f.err()).not.toContain(encoded);
  }
  expect(bytes.equals(Buffer.alloc(32))).toBe(true);
  const text = readFileSync(path.join(f.dir, "keys.json"), "utf8");
  expect(text).not.toContain(f.key.toString("hex")); expect(text).not.toContain(f.key.toString("base64")); expect(text).not.toContain(f.pass);
  const doc = parseKeysDocument(text), keys = unlockKeys(doc, f.pass), opened = openWallet(doc, "eip155", keys.kek);
  expect(opened.equals(f.key)).toBe(true); zero(opened, keys.kek, keys.lek);
  f.reset(); expect(await runWallet(["address"], f.deps)).toBe(0); expect(f.out()).toBe(f.address + "\n");
  const before = readFileSync(path.join(f.dir, "keys.json")); f.reset();
  expect(await runWallet(["new"], f.deps)).toBe(2); expect(f.err()).toBe("cli_refused: wallet_exists\n"); expect(readFileSync(path.join(f.dir, "keys.json"))).toEqual(before);
});
test.each(["ledger.ndjson", "install.seal", "config.json", "keys.json.new"])("new wallet preserves existing evidence %s", async name => {
  const f = fixture(); writeFileSync(path.join(f.dir, name), "preserve", { mode: 0o600 });
  expect(await runWallet(["new"], f.deps)).toBe(2); expect(f.read).not.toHaveBeenCalled(); expect(readFileSync(path.join(f.dir, name), "utf8")).toBe("preserve");
});
test("wallet new non-TTY and mismatched passphrases never write key", async () => {
  const f = fixture();
  expect(await runWallet(["new"], { ...f.deps, tty: { available: false, read: f.read } })).toBe(2); expect(f.read).not.toHaveBeenCalled();
  f.answers.splice(0, 2, f.pass, "different"); expect(await runWallet(["new"], f.deps)).toBe(2); expect(existsSync(path.join(f.dir, "keys.json"))).toBe(false);
});
test("wallet balance uses injected RPC and base units, not a purchase", async () => {
  const f = fixture(); f.saveKey(); const balance = vi.fn(async () => "1234567");
  expect(await runWallet(["balance"], { ...f.deps, balance })).toBe(0); expect(balance).toHaveBeenCalledWith(BASE_RPC, f.address); expect(f.out()).toBe("1234567\n");
});
test("production balance request pins chain, contract and selector (fetch fake, no listener)", async () => {
  const f = fixture(); const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x14a34" }))).mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (1234567).toString(16).padStart(64, "0") })));
  expect(await publicBalance(BASE_RPC, f.address)).toBe("1234567");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC, data: "0x70a08231" + f.address.slice(2).toLowerCase().padStart(64, "0") }, "latest"] });
  expect(fetcher.mock.calls[0]![1]!.redirect).toBe("error");
});
test("wrong RPC chain stops before balance", async () => {
  const f = fixture(), fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" })));
  await expect(publicBalance(BASE_RPC, f.address)).rejects.toThrow("rpc_failed"); expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each(["live", "stale", "unreadable"])("config write rejects %s lock without modification", async state => {
  const f = fixture(); f.lock(state === "live"); if (state === "unreadable") writeFileSync(path.join(f.dir, "daemon.lock"), "malformed");
  const before = readFileSync(path.join(f.dir, "daemon.lock"));
  expect(await runConfig(["set", "session.ttlMs", "60000"], f.deps)).toBe(2); expect(existsSync(path.join(f.dir, "config.json"))).toBe(false); expect(readFileSync(path.join(f.dir, "daemon.lock"))).toEqual(before);
});
test("config defaults survive absent file; human set validated and next startup only", async () => {
  const f = fixture(); expect(await runConfig(["get"], f.deps)).toBe(0); expect(JSON.parse(f.out())).toEqual({ version: 1, router: { url: HOSTED_ROUTER_URL } });
  expect(await runConfig(["set", "session.ttlMs", "3600001"], f.deps)).toBe(2); expect(existsSync(path.join(f.dir, "config.json"))).toBe(false);
  f.reset(); expect(await runConfig(["set", "session.ttlMs", "60000"], f.deps)).toBe(0); expect(JSON.parse(f.out()).effective).toBe("next_daemon_start");
  expect(parseConfig(JSON.parse(readFileSync(path.join(f.dir, "config.json"), "utf8"))).session?.ttlMs).toBe(60000);
  expect(await runConfig(["set", "session.ttlMs", "30000"], { ...f.deps, tty: { available: false, read: f.read } })).toBe(2);
});
test.each(["http://public.example/", "https://user:pass@public.example/", "https://127.0.0.1/", "https://rpc.example/?key=secret", "https://rpc.invalid/", "https://rpc.example/#x"])("config refuses unsafe RPC %s", value => {
  expect(() => parseConfig({ version: 1, router: { url: HOSTED_ROUTER_URL }, rpc: { "eip155:84532": value } })).toThrow("config_invalid");
});
test("config cannot infer a new Router canonical resource, expand rails or raise version", () => {
  expect(() => parseConfig({ version: 1, router: { url: "https://other.example/mcp" } })).toThrow("config_invalid");
  expect(() => parseConfig({ version: 1, router: { url: HOSTED_ROUTER_URL }, rails: ["mpp"] })).toThrow("config_invalid");
  expect(() => parseConfig({ version: 2, router: { url: HOSTED_ROUTER_URL } })).toThrow("store_unsupported_version");
});
test("reclaim live-owner causal oracle: valid TTY confirmation reaches liveness guard and preserves lock", async () => {
  const f = fixture(); f.lock(true); f.answers.splice(0, 2, "y"); const file = path.join(f.dir, "daemon.lock"), before = readFileSync(file);
  expect(await runLock(["reclaim"], f.deps)).toBe(2);
  expect(f.read).toHaveBeenCalledTimes(1); expect(f.err()).toBe("cli_refused: daemon_already_running\n"); expect(readFileSync(file)).toEqual(before);
});
test.each(["non-tty", "cancel", "reused-pid", "foreign", "guard"])("reclaim %s refuses without removing evidence", async kind => {
  const f = fixture(); f.lock(kind === "reused-pid", "T1"); f.answers.splice(0, 2, kind === "cancel" ? "n" : "y");
  if (kind === "foreign") { const file = path.join(f.dir, "daemon.lock"); writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), hostname: "foreign" })); }
  if (kind === "guard") writeFileSync(path.join(f.dir, "daemon.lock.reclaim"), "leftover", { mode: 0o600 });
  const before = readFileSync(path.join(f.dir, "daemon.lock"));
  expect(await runLock(["reclaim"], { ...f.deps, ...(kind === "non-tty" ? { tty: { available: false, read: f.read } } : {}) })).toBe(2);
  expect(readFileSync(path.join(f.dir, "daemon.lock"))).toEqual(before);
  if (kind === "guard") { expect(f.err()).toContain("ALL contenders"); expect(f.err()).toContain("offline recovery"); expect(existsSync(path.join(f.dir, "daemon.lock.reclaim"))).toBe(true); }
});
test("reclaim dead owner confirmed by synthetic TTY removes only payer lock", async () => {
  const f = fixture(); f.lock(false); f.answers.splice(0, 2, "y"); writeFileSync(path.join(f.dir, "worker.lock"), "preserve");
  expect(await runLock(["reclaim"], f.deps)).toBe(0); expect(existsSync(path.join(f.dir, "daemon.lock"))).toBe(false); expect(readFileSync(path.join(f.dir, "worker.lock"), "utf8")).toBe("preserve");
});
test("saved signed evidence inspection never submits; not-found becomes durable unknown, reopens safely", async () => {
  const f = fixture(), e = evidence(f);
  expect(await runInspect([e.ref], f.deps)).toBe(0); const result = JSON.parse(f.out());
  expect(result.inspections[0].summary).toMatchObject({ state: "unknown", fundsMoved: "maybe" }); expect(result.inspections[0].rows).toHaveLength(5);
  expect(e.statusCall).toHaveBeenCalledTimes(1); expect(e.purchase).not.toHaveBeenCalled();
  expect(f.out() + f.err()).not.toContain(e.credential); expect(f.out()).not.toMatch(/sealed|ciphertext|challenge|ownerKey|recordHash/);
  f.reset(); f.answers.push(f.pass); expect(await runStatus([e.ref], f.deps)).toBe(0); expect(JSON.parse(f.out()).state).toBe("unknown"); expect(e.purchase).not.toHaveBeenCalled();
});
test.each(["matched", "identity-mismatch", "unavailable"])("saved unknown reconciles %s Router status conservatively", async kind => {
  const f = fixture(), e = evidence(f, "unknown");
  e.status(kind === "unavailable" ? { kind: "unreadable", reason: "router_unavailable" } : { kind: "found", projection: { paymentId: kind === "matched" ? e.record.paymentId : randomUUID(), routeId: e.record.routeId, quoteFingerprint: e.record.destination.quoteFingerprint, source: { amount: e.record.source.amount, asset: e.record.source.asset, network: e.record.source.network }, destination: { quoted: e.record.destination.quoted, asset: e.record.destination.asset, network: e.record.destination.network }, status: "delivered", updatedAt: new Date().toISOString(), result: { safe: "result" } } });
  expect(await runStatus([], f.deps)).toBe(0); expect(JSON.parse(f.out()).purchases[0].state).toBe(kind === "matched" ? "result" : "unknown"); expect(e.purchase).not.toHaveBeenCalled();
});
test("inspect-close non-TTY causal oracle: valid ref/evidence/answers cannot read, close or write", async () => {
  const f = fixture(), e = evidence(f, "unknown"); f.answers.push("operator reviewed evidence", "y");
  const before = readFileSync(e.file), files = readdirSync(f.dir);
  expect(await runInspect([e.ref, "--close"], { ...f.deps, tty: { available: false, read: f.read } })).toBe(2);
  expect(f.err()).toBe("cli_refused: no_tty\n"); expect(f.read).not.toHaveBeenCalled(); expect(readFileSync(e.file)).toEqual(before); expect(readdirSync(f.dir)).toEqual(files); expect(e.statusCall).not.toHaveBeenCalled();
});
test("synthetic human inspect-close persists sealed reason and closed_by_operator, never replaying", async () => {
  const f = fixture(), e = evidence(f, "unknown"), reason = "synthetic operator evidence review"; f.answers.push(reason, "y");
  expect(await runInspect([e.ref, "--close"], f.deps)).toBe(0);
  expect(JSON.parse(f.out().trim().split("\n").at(-1)!).state).toBe("closed_by_operator"); expect(f.out() + f.err() + readFileSync(e.file, "utf8")).not.toContain(reason); expect(e.purchase).not.toHaveBeenCalled();
  f.reset(); f.answers.push(f.pass); expect(await runStatus([e.ref], f.deps)).toBe(0); expect(JSON.parse(f.out()).state).toBe("closed_by_operator");
});
test("live daemon wallet and inspection use validated client Summary and always close client", async () => {
  const f = fixture(); f.lock(true); const request = vi.fn(async (method: string) => method === "wallet" ? { ok: true, wallets: [{ rail: "x402", network: "eip155:84532", address: f.address }] } : { ok: true, inspections: [] }); const close = vi.fn(async () => {}); f.deps.client = () => ({ request, close });
  expect(await runWallet(["address"], f.deps)).toBe(0); expect(f.out()).toBe(f.address + "\n"); f.reset();
  expect(await runStatus([], f.deps)).toBe(0); expect(request.mock.calls).toEqual([["wallet", {}], ["inspect", {}]]); expect(close).toHaveBeenCalledTimes(2); expect(f.read).not.toHaveBeenCalled();
});
test("untrusted client errors are fixed, no fallback to secret store", async () => {
  const f = fixture(); f.lock(true); f.deps.client = () => ({ request: async () => { throw new Error(f.pass); }, close: async () => {} });
  expect(await runStatus([], f.deps)).toBe(2); expect(f.err()).toBe("cli_refused: internal_error\n"); expect(f.read).not.toHaveBeenCalled();
});
test("ui-check runs fixed escaped text using synthetic verifier, classification only", async () => {
  const f = fixture(); const check = vi.fn(async (text: string) => ({ approved: true }));
  f.deps.uiCheck = verify => { expect(verify(f.pass)).toBe(true); expect(verify("wrong-passphrase")).toBe(false); return { available: async () => true, check }; };
  expect(await runUiCheck([], f.deps)).toBe(0); expect(check.mock.calls[0]![0]).toContain('"test"'); expect(check.mock.calls[0]![0]).toContain('\\'); expect(check.mock.calls[0]![0]).toContain('\n'); expect(f.out()).toBe('{"approved":true}\n'); expect(readdirSync(f.dir)).toEqual([]);
});
test("ui-check non-TTY never creates helper; helper errors do not echo secrets", async () => {
  const f = fixture(), helper = vi.fn(() => { throw new Error(f.pass); }); f.deps.uiCheck = helper;
  expect(await runUiCheck([], { ...f.deps, tty: { available: false, read: f.read } })).toBe(2); expect(helper).not.toHaveBeenCalled();
  f.reset(); expect(await runUiCheck([], f.deps)).toBe(2); expect(f.err()).toBe("cli_refused: internal_error\n");
});
test("read-only socket inspection has no forgeable close/approval endpoint", () => {
  for (const params of [{ ref: "p_aaaaaaaaaaaaa", close: true }, { ref: "p_aaaaaaaaaaaaa", approved: true }, { reason: "human" }]) expect(Request.safeParse({ id: 1, method: "inspect", params }).success).toBe(false);
  expect(Request.safeParse({ id: 1, method: "close", params: { ref: "p_aaaaaaaaaaaaa" } }).success).toBe(false);
});

test("daemon reclaim-guard diagnostic requires ALL contenders stopped and human offline recovery", async () => {
  const { startupMessage } = await import("../../src/daemon/run.js");
  const message = startupMessage(new StoreError("reclaim_busy"));
  expect(message).toContain("startup_refused: reclaim_busy\n");
  expect(message).toContain("ALL contenders"); expect(message).toContain("offline recovery");
});

test("leftover reclaim guard without owner lock blocks wallet/config acquisition unchanged", async () => {
  const f = fixture(), guard = path.join(f.dir, "daemon.lock.reclaim"); writeFileSync(guard, "leftover", { mode: 0o600 });
  expect(await runWallet(["new"], f.deps)).toBe(2); expect(f.err()).toContain("cli_refused: reclaim_busy"); expect(f.read).not.toHaveBeenCalled();
  f.reset(); expect(await runConfig(["set", "session.ttlMs", "60000"], f.deps)).toBe(2); expect(f.err()).toContain("ALL contenders"); expect(readFileSync(guard, "utf8")).toBe("leftover"); expect(readdirSync(f.dir)).toEqual(["daemon.lock.reclaim"]);
});

test("real daemon handler inspection projects saved evidence without signing/submission or consent inlet", async () => {
  const f = fixture(), e = evidence(f);
  const doc = parseKeysDocument(readFileSync(path.join(f.dir, "keys.json"), "utf8")), keys = unlockKeys(doc, f.pass);
  const ledger = openLedger(e.file, keys.lek, realFs), session = new Session(Buffer.alloc(32));
  const signer = vi.fn(async () => "must-never-sign");
  const handler = createDaemonHandler({ ledger, session, address: f.address, phrase: "", router: f.deps.router!, assertHeld: () => {}, purchase: { routerUrl: HOSTED_ROUTER_URL, ui: { available: async () => false }, signer: { sign: signer } } });
  const { dispatchLine } = await import("../../src/daemon/server.js");
  try {
    const result = await dispatchLine(JSON.stringify({ id: 1, method: "inspect", params: { ref: e.ref } }), handler);
    expect(result).toMatchObject({ id: 1, ok: true, result: { inspections: [{ summary: { state: "unknown", fundsMoved: "maybe" } }] } });
    expect(signer).not.toHaveBeenCalled(); expect(e.purchase).not.toHaveBeenCalled(); expect(e.statusCall).toHaveBeenCalledTimes(1); expect(JSON.stringify(result)).not.toContain(e.credential);
  } finally { session.close(); ledger.close(); zero(keys.kek, keys.lek); }
});

test("daemon leftover reclaim guard refuses before TTY, wallet or listener", async () => {
  const f = fixture(); writeFileSync(path.join(f.dir, "daemon.lock.reclaim"), "leftover", { mode: 0o600 });
  const { startDaemon } = await import("../../src/daemon/startup.js");
  const listen = vi.fn(async () => ({ close: async () => {} }));
  await expect(startDaemon({ env: { HOME: f.home }, execArgv: ["--disable-sigusr1"], installRoot: f.deps.installRoot!, lockDeps: f.deps.lockDeps!, hooks: { ui: { available: async () => true }, tty: { available: true, read: f.read }, listen, handler: () => async () => ({}), recover: async () => {} } })).rejects.toThrow("reclaim_busy");
  expect(f.read).not.toHaveBeenCalled(); expect(listen).not.toHaveBeenCalled(); expect(readdirSync(f.dir)).toEqual(["daemon.lock.reclaim"]);
});
