/** Parent only: unchanged npm-installed launcher, synthetic wallet, no product seams. */
import { createDecipheriv, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { cpSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { expect, test } from "vitest";
import { assertLockedTree, buildCopy, executable, files, installLocked, isolated, json, pack, packageRoot, run, sha256, snapshot, success, type Fixture } from "../harness/install.js";

/** SDK framing over the installed process, with an exact environment (no SDK default env merge).
 * Cleanup waits for exit AND stdio close, and signals only its own unreaped child. */
function installedTransport(bin: string, f: Fixture): Transport {
  let child: ReturnType<typeof spawn> | undefined, closed: Promise<void> | undefined;
  let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null, failed = false;
  let ended = false, timer: ReturnType<typeof setTimeout> | undefined;
  const transport: Transport = {
    async start() {
      child = spawn(bin, ["mcp"], { cwd: f.root, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
      const buffer = new ReadBuffer(); let bytes = 0;
      closed = new Promise(resolve => {
        child!.once("exit", (code, signal) => { ended = true; exitCode = code; exitSignal = signal; });
        child!.once("close", () => { clearTimeout(timer); transport.onclose?.(); resolve(); });
      });
      const fail = () => { failed = true; transport.onerror?.(new Error("installed_mcp_process_failed")); if (!ended) child!.kill("SIGKILL"); };
      child.once("error", fail); child.stdin!.on("error", fail);
      child.stderr!.on("data", () => fail());
      child.stdout!.on("data", (chunk: Buffer) => {
        bytes += chunk.length; if (bytes > 1024 * 1024) { fail(); return; }
        try { buffer.append(chunk); for (;;) { const message = buffer.readMessage(); if (!message) break; transport.onmessage?.(message); } } catch { fail(); }
      });
      timer = setTimeout(fail, 25_000);
    },
    async send(message: JSONRPCMessage) {
      if (!child?.stdin) throw new Error("installed_mcp_not_started");
      await new Promise<void>((resolve, reject) => child!.stdin!.write(serializeMessage(message), error => error ? reject(new Error("installed_mcp_write_failed")) : resolve()));
    },
    async close() {
      child?.stdin?.end();
      const kill = setTimeout(() => { if (!ended) child?.kill("SIGKILL"); }, 2000);
      try { await closed; if (failed || exitCode !== 0 || exitSignal !== null) throw new Error("installed_mcp_close_failed"); } finally { clearTimeout(kill); }
    },
  };
  return transport;
}
async function mcp(bin: string, f: Fixture) {
  const client = new Client({ name: "payer-clean-install", version: "1" });
  const transport = installedTransport(bin, f);
  let primary: unknown;
  try {
    await client.connect(transport, { timeout: 10_000 });
    const listing = await client.listTools();
    expect(listing.tools.map(tool => tool.name).sort()).toEqual([
      "subetha_payer_find_routes", "subetha_payer_purchase", "subetha_payer_quote", "subetha_payer_status", "subetha_payer_wallet",
    ]);
    for (const tool of listing.tools) expect(tool.outputSchema?.type).toBe("object");
    expect(listing.tools.find(tool => tool.name === "subetha_payer_purchase")?._meta?.["anthropic/requiresUserInteraction"]).toBe(true);
    for (const [name, args] of [
      ["find_routes", {}], ["wallet", {}], ["quote", { routeId: "md-mpp-eth-snapshot" }],
      ["purchase", { ref: "p_aaaaaaaaaaaaa" }], ["status", { ref: "p_aaaaaaaaaaaaa" }],
    ] as const) {
      const result = await client.callTool({ name: `subetha_payer_${name}`, arguments: args }, undefined, { timeout: 10_000 });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, error: "daemon_unavailable" });
    }
  } catch (error) { primary = error; throw error; }
  finally {
    try { await client.close(); } catch (error) { if (!primary) primary = error; }
    try { await transport.close(); } catch (error) { if (!primary) primary = error; }
    if (primary) throw primary;
  }
}
function noSecret(bytes: Buffer, secrets: Buffer[]) {
  for (const secret of secrets) {
    for (const needle of [secret, Buffer.from(secret.toString("base64")), Buffer.from(secret.toString("hex"))]) {
      if (bytes.includes(needle)) throw new Error("installed_wallet_secret_leak");
    }
  }
}
async function wallet(bin: string, f: Fixture) {
  const passphrase = randomBytes(24).toString("base64"), stdoutFile = path.join(f.root, "wallet.stdout");
  const result = await run(executable("python3"), [path.join(packageRoot, "test/fixtures/cli-pty.py")], f.root, f.env, 30_000,
    JSON.stringify({ installedBin: bin, stdoutFile, env: f.env, passphrase }));
  success(result, "installed_wallet_pty");
  const value = JSON.parse(result.stdout);
  expect(JSON.stringify(value) === JSON.stringify({ exit: 0, prompts: 2, addresses: [] }), "installed PTY result").toBe(true); expect(result.stderr === "").toBe(true);
  const output = readFileSync(stdoutFile);
  // Boolean assertions prevent any future secret-output mutation entering Vitest diagnostics.
  expect(/^0x[0-9a-fA-F]{40}\n$/.test(output.toString("utf8")), "wallet stdout address only").toBe(true);
  const store = path.join(f.env.HOME!, ".config/subetha-payer"), file = path.join(store, "keys.json");
  const doc = json(file), entry = doc.wallets.eip155;
  expect(doc.version).toBe(1); expect(doc.kdf).toMatchObject({ name: "scrypt", N: 131072, r: 8, p: 1 });
  expect(entry.cipher).toBe("aes-256-gcm");
  expect(lstatSync(store).mode & 0o777).toBe(0o700); expect(lstatSync(file).mode & 0o777).toBe(0o600);
  expect(output.toString("utf8") === entry.address + "\n").toBe(true);
  // Authenticate only this fresh synthetic store, without importing the product wallet implementation.
  const master = scryptSync(passphrase, Buffer.from(doc.kdf.salt, "base64"), 32, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const kek = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "subetha-payer/kek/v1", 32));
  let key: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", kek, Buffer.from(entry.iv, "base64"));
    decipher.setAAD(Buffer.from(`wallet:eip155:${entry.address}`)); decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    key = Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, "base64")), decipher.final()]);
    expect(key.length).toBe(32);
    const secrets = [Buffer.from(passphrase), key];
    noSecret(output, secrets); noSecret(Buffer.from(result.stdout + result.stderr), secrets); noSecret(readFileSync(file), secrets);
    const address = await run(bin, ["wallet", "address"], f.root, f.env);
    success(address, "installed_wallet_address"); noSecret(Buffer.from(address.stdout + address.stderr), secrets);
    expect(address.stdout === output.toString("utf8")).toBe(true); expect(address.stderr === "").toBe(true);
  } finally { master.fill(0); kek.fill(0); key?.fill(0); rmSync(stdoutFile, { force: true }); }
}

test.skipIf(process.env.PAYER_CLEAN_INSTALL !== "1")("clean install: isolated pack → registry dependencies → unchanged installed wallet and SDK MCP", async () => {
  const f = isolated("clean"), before = snapshot(path.join(packageRoot, "dist"));
  const receipt: Record<string, unknown> = { operation: "clean-install", nativeCheck: "UNRUN/owner-only", audit: "UNRUN/separate gate" };
  let primary: unknown;
  try {
    await buildCopy(f);
    const artifact = await pack(f); Object.assign(receipt, artifact); f.receipt(receipt);
    expect(artifact.files).toContain("dist/bin.js"); expect(artifact.files).toContain("bin/subetha-payer"); expect(artifact.files).toContain("README.md");
    expect(artifact.files.every(file => /^(?:bin\/subetha-payer|dist\/.+|package\.json|npm-shrinkwrap\.json|README\.md)$/.test(file))).toBe(true);
    expect(artifact.files.some(file => /(?:test|fixture|scripts)/.test(file))).toBe(false);
    const { installed, bin, result: install } = await installLocked(f, artifact.tarball, f.env, ["--no-audit", "--no-fund", "--foreground-scripts"]);
    receipt.installMethod = "extract + npm ci (shrinkwrap honoured; npm i -g <tarball> ignores it — verified at G-A2 after publication)";
    receipt.installExit = install.code; f.receipt(receipt); success(install, "clean_install");
    expect(/node-gyp|prebuild|binding\.gyp/i.test(install.stdout + install.stderr), "native compilation markers").toBe(false);
    expect(files(installed).some(file => file.endsWith(".node"))).toBe(false);
    receipt.transitivePackages = assertLockedTree(installed, f.source);
    for (const name of artifact.files) expect(sha256(path.join(installed, name)), name).toBe(sha256(path.join(f.source, name)));
    await wallet(bin, f); receipt.wallet = "PASS";
    await mcp(bin, f); receipt.mcp = "PASS";
    if (process.platform === "linux") {
      const check = await run(bin, ["daemon", "--check"], f.root, f.env);
      expect(check).toEqual({ code: 2, signal: null, stdout: "", stderr: "startup_refused: no_confirmation_ui\n" });
      receipt.linuxRefusal = "PASS (not native acceptance or Linux support)";
    }
    for (const name of artifact.files) expect(sha256(path.join(installed, name)), name).toBe(sha256(path.join(f.source, name)));
    receipt.result = "PASS";
  } catch (error) { primary = error; receipt.result = "FAILED"; throw error; }
  finally {
    try {
      f.cleanHome();
      expect(snapshot(path.join(packageRoot, "dist"))).toEqual(before);
      f.receipt(receipt);
    } catch (error) {
      receipt.result = "FAILED_CLEANUP_OR_INVARIANT";
      try { f.receipt(receipt); } catch { /* preserve the primary failure */ }
      if (!primary) throw error;
    }
  }
}, 300_000);

// Switch alone is not permission: owner must separately authorize macOS/System Events.
test.skipIf(process.env.PAYER_OWNER_NATIVE_CHECK !== "1")("OWNER ONLY: installed macOS daemon --check native availability", async () => {
  expect(process.platform).toBe("darwin");
  const bin = process.env.PAYER_INSTALLED_BIN;
  if (!bin || !path.isAbsolute(bin) || !existsSync(bin)) throw new Error("owner_native_requires_installed_bin");
  const f = isolated("owner-native");
  try {
    const result = await run(bin, ["daemon", "--check"], f.root, f.env);
    const unavailable = process.env.PAYER_OWNER_NATIVE_EXPECT === "no_confirmation_ui";
    expect(result).toEqual({ code: unavailable ? 2 : 0, signal: null, stdout: "", stderr: unavailable ? "startup_refused: no_confirmation_ui\n" : "" });
    f.receipt({ operation: "owner-native-check", code: result.code, available: !unavailable });
  } finally { f.cleanHome(); }
}, 60_000);

// Checkpoint FIRST. Parent supplies a copied package with exactly one mutation.
// Repack and install into a fresh prefix, reusing ONLY the baseline fixture's registry cache.
// This code never changes the candidate source and never enables native UI.
test.skipIf(!process.env.PAYER_MUTATION_EXPECT)("checkpoint-only copied package installs and has the exact causal refusal", async () => {
  const expected = process.env.PAYER_MUTATION_EXPECT;
  const candidate = process.env.PAYER_MUTATION_SOURCE, baselinePath = process.env.PAYER_BASELINE_RECEIPT;
  if (!candidate || !baselinePath || !path.isAbsolute(candidate) || !path.isAbsolute(baselinePath)) throw new Error("mutation_requires_copy_and_baseline_receipt");
  if (expected !== "sigusr1_enabled" && expected !== "missing_dist") throw new Error("mutation_expect_invalid");
  const baseline = json(baselinePath), base = path.dirname(baselinePath);
  if (baseline.operation !== "clean-install" || baseline.result !== "PASS" || sha256(baseline.tarball) !== baseline.sha256) throw new Error("mutation_baseline_invalid");
  if (realpathSync(candidate) === realpathSync(path.join(base, "package")) || realpathSync(candidate) === realpathSync(packageRoot)) throw new Error("mutation_requires_separate_copy");
  const f = isolated("mutation");
  try {
    for (const name of ["bin", "dist", "package.json", "npm-shrinkwrap.json", "README.md"]) cpSync(path.join(candidate, name), path.join(f.source, name), { recursive: true });
    // Prove the negative cannot reach a native helper before executing daemon --check.
    // All runtime bytes must still equal the clean installed artifact except the named mutation.
    const original = path.join(base, "prefix/lib/node_modules/@subetha/payer");
    for (const name of baseline.files as string[]) {
      if (name === (expected === "sigusr1_enabled" ? "bin/subetha-payer" : "package.json")) continue;
      expect(sha256(path.join(f.source, name))).toBe(sha256(path.join(original, name)));
    }
    if (expected === "sigusr1_enabled") {
      const clean = readFileSync(path.join(original, "bin/subetha-payer"), "utf8");
      expect(readFileSync(path.join(f.source, "bin/subetha-payer"), "utf8")).toBe(clean.replace(/^exec node --disable-sigusr1 /m, "exec node "));
    } else {
      const clean = json(path.join(original, "package.json"));
      expect(json(path.join(f.source, "package.json"))).toEqual({ ...clean, files: clean.files.filter((name: string) => name !== "dist") });
    }
    const artifact = await pack(f);
    const env = { ...f.env, npm_config_cache: path.join(base, "cache"), npm_config_offline: "true" };
    const { installed, bin, result: install } = await installLocked(f, artifact.tarball, env, ["--offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
    success(install, "mutation_offline_install");
    for (const name of artifact.files) expect(sha256(path.join(installed, name))).toBe(sha256(path.join(f.source, name)));
    if (expected === "missing_dist") expect(existsSync(path.join(installed, "dist"))).toBe(false);
    else expect(readFileSync(path.join(installed, "bin/subetha-payer"), "utf8")).toBe(readFileSync(path.join(f.source, "bin/subetha-payer"), "utf8"));
    const result = await run(bin, ["daemon", "--check"], f.root, f.env);
    if (expected === "sigusr1_enabled") {
      expect(result).toEqual({ code: 2, signal: null, stdout: "", stderr: "startup_refused: sigusr1_enabled\n" });
    } else {
      expect(result.code).toBe(1); expect(result.signal).toBeNull(); expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/Cannot find module .*dist\/bin\.js/); expect(result.stderr).toContain("MODULE_NOT_FOUND");
    }
    f.receipt({ operation: "checkpoint-mutation", expected, ...artifact, code: result.code });
  } finally { f.cleanHome(); }
}, 240_000);
