import path from "node:path";
import { expect, test } from "vitest";
import { isolated, json, npm, packageRoot, repoRoot } from "../harness/install.js";
import { cpSync, rmSync } from "node:fs";

// Published viem 2.54.2 registry metadata, verified by the parent for FIX2.
// Keep the contract in source so fresh checkouts do not need ignored receipts.
const payerViemIntegrity = "sha512-o0+5dEAUekBMTbixXy2mKbSDPnwsCJ+8+mOeMBDjkuS9iM4fcr3yKUWb2zlOy2NKInkg3anl1W11sxYspLiXig==";

test("payer direct dependencies are exact pins matching its production shrinkwrap", () => {
  const pkg = json(path.join(packageRoot, "package.json")), lock = json(path.join(packageRoot, "npm-shrinkwrap.json"));
  const rootLock = json(path.join(repoRoot, "package-lock.json"));
  expect(lock.lockfileVersion).toBe(3);
  expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
  expect(lock.packages[""].version).toBe(pkg.version);
  expect(lock.packages[""].bin).toEqual(pkg.bin);
  expect(pkg.private).toBe(true);
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages[`node_modules/${name}`].version).toBe(version);
    if (name === "viem") {
      // Sole shared-dependency divergence: the payer needs the upstream ws fix
      // when installed as a dependency, where its own overrides are ignored.
      expect(version).toBe("2.54.2");
      expect(lock.packages["node_modules/viem"].integrity).toBe(payerViemIntegrity);
      expect(rootLock.packages["node_modules/viem"].version).toBe("2.54.0");
    } else if (rootLock.packages[`node_modules/${name}`]) {
      expect(rootLock.packages[`node_modules/${name}`].version).toBe(version);
      expect(rootLock.packages[`node_modules/${name}`].integrity).toBe(lock.packages[`node_modules/${name}`].integrity);
    }
  }
  for (const [name, entry] of Object.entries(lock.packages) as [string, any][]) {
    if (!name) continue;
    expect(entry.version, name).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
    expect(entry.resolved, name).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    expect(entry.integrity, name).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    expect(entry.link, name).not.toBe(true);
    expect(entry.dev, name).not.toBe(true);
  }
});

test("payer consumer-compatible viem patch pins upstream ws without overrides", () => {
  const pkg = json(path.join(packageRoot, "package.json")), lock = json(path.join(packageRoot, "npm-shrinkwrap.json"));
  const rootPkg = json(path.join(repoRoot, "package.json")), rootLock = json(path.join(repoRoot, "package-lock.json"));
  // Root keeps its existing policy; consumer installs require an upstream pin.
  expect(rootPkg.dependencies.viem).toBe("2.54.0");
  expect(rootPkg.overrides.ws).toBe("8.22.0");
  expect.soft(pkg.dependencies.viem).toBe("2.54.2");
  expect.soft(pkg).not.toHaveProperty("overrides");
  expect.soft(lock).not.toHaveProperty("overrides");
  expect.soft(lock.packages[""]).not.toHaveProperty("overrides");
  expect.soft(lock.packages["node_modules/viem"].version).toBe("2.54.2");
  expect.soft(lock.packages["node_modules/viem"].resolved).toBe("https://registry.npmjs.org/viem/-/viem-2.54.2.tgz");
  expect.soft(lock.packages["node_modules/viem"].integrity).toBe(payerViemIntegrity);
  // All other published viem dependencies remain exactly the root's 2.54.0 pins.
  expect.soft(lock.packages["node_modules/viem"].dependencies).toEqual({
    ...rootLock.packages["node_modules/viem"].dependencies,
    ws: "8.21.0",
  });
  const wsNodes = Object.keys(lock.packages).filter(name => /(?:^|\/)node_modules\/ws$/.test(name));
  expect(wsNodes).toEqual(["node_modules/ws"]);
  expect.soft(lock.packages["node_modules/ws"].version).toBe("8.21.0");
  expect.soft(lock.packages["node_modules/ws"].resolved).toBe("https://registry.npmjs.org/ws/-/ws-8.21.0.tgz");
  expect.soft(lock.packages["node_modules/ws"].integrity).toBe("sha512-Vsp28b7DRcimFQvrqu2Wek3z1iYxDCWqHYB8Qsnk/S4RfaCQzPGPyBNuVjJV3cd6UiKtUtp6sNM77gWvzcCH+g==");
});

test.skipIf(process.env.PAYER_AUDIT !== "1")("PAYER_AUDIT: own locked production tree has high+critical zero (real registry result only)", async () => {
  const f = isolated("audit");
  let primary: unknown;
  const receipt: Record<string, unknown> = { operation: "audit", result: "STARTED", highCritical: "unmeasured" };
  f.receipt(receipt);
  try {
    for (const name of ["package.json", "npm-shrinkwrap.json"]) cpSync(path.join(packageRoot, name), path.join(f.source, name));
    const result = await npm(["audit", "--package-lock-only", "--omit=dev", "--audit-level=high", "--json"], f.source, f.env);
    let data: any;
    try { data = JSON.parse(result.stdout); } catch { throw new Error("audit_unavailable: invalid_json"); }
    const counts = data.metadata?.vulnerabilities;
    if (data.error || !counts || !Number.isInteger(counts.high) || !Number.isInteger(counts.critical)) throw new Error("audit_unavailable: no_vulnerability_counts");
    Object.assign(receipt, { code: result.code, signal: result.signal, vulnerabilities: counts, highCritical: counts.high + counts.critical });
    f.receipt(receipt);
    expect(result.signal).toBeNull(); expect(result.code).toBe(0);
    expect(counts.high + counts.critical).toBe(0);
    receipt.result = "PASS"; f.receipt(receipt);
  } catch (error) {
    // No remote diagnostic body or credentials are emitted; a failure is never reported as zero.
    primary = error;
    receipt.result = "FAILED_OR_UNAVAILABLE";
    try { f.receipt(receipt); } catch { /* keep primary */ }
    throw error;
  } finally {
    try { f.cleanHome(); rmSync(path.join(f.root, "tmp"), { recursive: true, force: true }); }
    catch (error) { if (!primary) throw error; }
  }
}, 200_000);
