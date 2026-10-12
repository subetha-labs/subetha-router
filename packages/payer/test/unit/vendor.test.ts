import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const repo = path.resolve(root, "../..");

/** Mirror of `scripts/vendor.ts` VENDORED (docs/payer-rails-design.md §2.1): the script runs on import, so the table is restated here. */
const NETWORKS = ['from "../src/shared/networks.js"', 'from "./networks.js"'] as const;
const SVM_MESSAGE = ['from "../src/adapters/inbound/x402-svm.js"', 'from "./svm-message.js"'] as const;
const NET_BODY = ['from "../src/net/bounded-body.js"', 'from "./bounded-body.js"'] as const;
const NET_FETCH = ['from "../src/net/guarded-fetch.js"', 'from "./guarded-fetch.js"'] as const;
const VENDORED: readonly { source: string; name: string; rewrites: readonly (readonly [string, string])[] }[] = [
  { source: "src/shared/networks.ts", name: "networks.ts", rewrites: [] },
  { source: "tools/sign-classify-evm.ts", name: "sign-classify-evm.ts", rewrites: [NETWORKS] },
  { source: "tools/x402-payer.ts", name: "x402-payer.ts", rewrites: [] },
  { source: "tools/sign-dispatch.ts", name: "sign-dispatch.ts", rewrites: [NETWORKS] },
  { source: "tools/sign-check-tempo.ts", name: "sign-check-tempo.ts", rewrites: [] },
  { source: "tools/mpp-payer.ts", name: "mpp-payer.ts", rewrites: [] },
  { source: "tools/svm-key.ts", name: "svm-key.ts", rewrites: [] },
  { source: "tools/svm-payer.ts", name: "svm-payer.ts", rewrites: [SVM_MESSAGE] },
  { source: "tools/svm-mpp-payer.ts", name: "svm-mpp-payer.ts", rewrites: [SVM_MESSAGE] },
  { source: "tools/svm-rpc.ts", name: "svm-rpc.ts", rewrites: [NET_BODY, NET_FETCH] },
  { source: "src/shared/svm-message.ts", name: "svm-message.ts", rewrites: [] },
  { source: "src/net/guarded-fetch.ts", name: "guarded-fetch.ts", rewrites: [] },
  { source: "src/net/destination-policy.ts", name: "destination-policy.ts", rewrites: [] },
  { source: "src/net/bounded-body.ts", name: "bounded-body.ts", rewrites: [] },
];
const names = VENDORED.map(({ name }) => name).sort();
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function expected(entry: (typeof VENDORED)[number]): Buffer {
  let text = readFileSync(path.join(repo, entry.source), "utf8");
  for (const [from, to] of entry.rewrites) {
    expect(text.split(from).length, `${entry.source}: ${from}`).toBe(2);
    text = text.replace(from, to);
  }
  return Buffer.from(text);
}

describe("R-1: vendor and dependency boundary", () => {
  test("the script's table is restated here exactly (14 entries)", () => {
    const script = readFileSync(path.join(root, "scripts/vendor.ts"), "utf8");
    expect(VENDORED).toHaveLength(14);
    for (const { source, name } of VENDORED) expect(script, name).toContain(`{ source: "${source}", name: "${name}"`);
    expect(script.match(/\{ source: "/g)).toHaveLength(14);
  });

  test("exactly the fourteen project sources, byte-identical except the approved import rewrites", () => {
    const dir = path.join(root, "src/vendor");
    expect(readdirSync(dir).sort()).toEqual(names);
    for (const entry of VENDORED) expect(readFileSync(path.join(dir, entry.name)).equals(expected(entry)), entry.source).toBe(true);
  });

  test("vendor script is deterministic, independent of cwd, and copies only the allowlist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "payer-vendor-"));
    temps.push(dir);
    // A miniature checkout keeps this test from rewriting production inputs.
    for (const { source } of VENDORED) cpSync(path.join(repo, source), path.join(dir, source), { recursive: true });
    const script = path.join(dir, "packages/payer/scripts/vendor.ts");
    cpSync(path.join(root, "scripts/vendor.ts"), script, { recursive: true });
    cpSync(path.join(root, "package.json"), path.join(dir, "packages/payer/package.json"));
    const run = () => execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), script], { cwd: tmpdir(), stdio: "pipe" });
    run();
    run();
    const vendor = path.join(dir, "packages/payer/src/vendor");
    expect(readdirSync(vendor).sort()).toEqual(names);
    for (const entry of VENDORED) expect(readFileSync(path.join(vendor, entry.name)).equals(expected(entry)), entry.source).toBe(true);
  });

  test("package is publishable (G-A1), with pinned viem and the Router's payer dependencies at the root lock's versions; no zERC20", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(path.join(root, "npm-shrinkwrap.json"), "utf8"));
    const rootLock = JSON.parse(readFileSync(path.join(repo, "package-lock.json"), "utf8"));
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.version).toBe("0.2.1");
    expect(pkg.dependencies.viem).toBe("2.54.2");
    expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
    expect(lock.packages["node_modules/viem"].version).toBe("2.54.2");
    // Authentic published metadata; no dependency on parent-local receipts.
    expect(lock.packages["node_modules/viem"].resolved).toBe("https://registry.npmjs.org/viem/-/viem-2.54.2.tgz");
    expect(lock.packages["node_modules/viem"].integrity).toBe("sha512-o0+5dEAUekBMTbixXy2mKbSDPnwsCJ+8+mOeMBDjkuS9iM4fcr3yKUWb2zlOy2NKInkg3anl1W11sxYspLiXig==");
    const forbidden = /(?:^|[/"\s])@zerc20(?:[/"\s]|$)/;
    for (const file of ["package.json", "npm-shrinkwrap.json"]) expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(forbidden);
    // docs/payer-rails-design.md §2.1: the same versions the Router itself locks.
    const added = { mppx: "0.11.0", "@solana/kit": "8.4.0", "@solana-program/token": "0.17.0", "@solana-program/compute-budget": "0.19.0", undici: "8.11.2" };
    for (const [name, version] of Object.entries(added)) {
      expect(pkg.dependencies[name], name).toBe(version);
      expect(rootLock.packages[`node_modules/${name}`].version, name).toBe(version);
      expect(lock.packages[`node_modules/${name}`].integrity, name).toBe(rootLock.packages[`node_modules/${name}`].integrity);
    }
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock.packages[`node_modules/${name}`].version).toBe(version);
    }
  });

  test("signer import graph: the payer's network table, the fourteen vendor files, and only the Router's payer dependencies externally", () => {
    const files = new Set<string>();
    const external = new Set<string>();
    const visitFile = (file: string): void => {
      if (files.has(file)) return;
      files.add(file);
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2023, true);
      const record = (node: ts.Node | undefined): void => {
        if (node === undefined || !(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) throw new Error("non-literal module load");
        const spec = node.text;
        if (spec.startsWith(".")) visitFile(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
        else external.add(spec);
      };
      const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) record(node.moduleSpecifier);
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) record(node.moduleReference.expression);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) record(node.arguments[0]);
        ts.forEachChild(node, visit);
      };
      visit(source);
    };
    visitFile(path.join(root, "src/sign/index.ts"));
    expect([...files].map((file) => path.relative(root, file)).sort()).toEqual([
      "src/sign/index.ts", "src/sign/networks.ts", ...names.map((name) => `src/vendor/${name}`),
    ].sort());
    const packages = [...external].filter((spec) => !spec.startsWith("node:")).sort();
    expect(packages).toEqual(["@solana-program/compute-budget", "@solana-program/token", "@solana/kit", "mppx", "mppx/client", "undici", "viem", "viem/accounts", "viem/tempo/chains"]);
    // Node built-ins: the guarded transport's name resolution and own-address policy only. No file, env or child process.
    const builtins = [...external].filter((spec) => spec.startsWith("node:")).sort();
    expect(builtins).toEqual(["node:dns", "node:net", "node:os"]);
  });
});
