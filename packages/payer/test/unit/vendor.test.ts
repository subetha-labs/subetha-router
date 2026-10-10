import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const repo = path.resolve(root, "../..");
const sources = ["src/shared/networks.ts", "tools/sign-classify-evm.ts", "tools/x402-payer.ts"];
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function expected(source: string): Buffer {
  const bytes = readFileSync(path.join(repo, source));
  return source === "tools/sign-classify-evm.ts"
    ? Buffer.from(bytes.toString("utf8").replace('from "../src/shared/networks.js"', 'from "./networks.js"')) : bytes;
}

describe("P-2: vendor and dependency boundary", () => {
  test("exactly the three project sources, byte-identical except the approved import rewrite", () => {
    const dir = path.join(root, "src/vendor");
    expect(readdirSync(dir).sort()).toEqual(sources.map((source) => path.basename(source)).sort());
    for (const source of sources) expect(readFileSync(path.join(dir, path.basename(source))).equals(expected(source)), source).toBe(true);
  });

  test("vendor script is deterministic, independent of cwd, and copies only the allowlist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "payer-vendor-"));
    temps.push(dir);
    // A miniature checkout keeps this test from rewriting production inputs.
    for (const source of sources) cpSync(path.join(repo, source), path.join(dir, source), { recursive: true });
    const script = path.join(dir, "packages/payer/scripts/vendor.ts");
    cpSync(path.join(root, "scripts/vendor.ts"), script, { recursive: true });
    cpSync(path.join(root, "package.json"), path.join(dir, "packages/payer/package.json"));
    const run = () => execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), script], { cwd: tmpdir(), stdio: "pipe" });
    run();
    run();
    const vendor = path.join(dir, "packages/payer/src/vendor");
    expect(readdirSync(vendor).sort()).toEqual(sources.map((source) => path.basename(source)).sort());
    for (const source of sources) expect(readFileSync(path.join(vendor, path.basename(source))).equals(expected(source)), source).toBe(true);
  });

  test("package is publishable (G-A1), with pinned viem and no second-slice or zERC20 dependencies in manifest or lock", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(path.join(root, "npm-shrinkwrap.json"), "utf8"));
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.dependencies.viem).toBe("2.54.2");
    expect(lock.packages[""].dependencies).toEqual(pkg.dependencies);
    expect(lock.packages["node_modules/viem"].version).toBe("2.54.2");
    // Authentic published metadata; no dependency on parent-local receipts.
    expect(lock.packages["node_modules/viem"].resolved).toBe("https://registry.npmjs.org/viem/-/viem-2.54.2.tgz");
    expect(lock.packages["node_modules/viem"].integrity).toBe("sha512-o0+5dEAUekBMTbixXy2mKbSDPnwsCJ+8+mOeMBDjkuS9iM4fcr3yKUWb2zlOy2NKInkg3anl1W11sxYspLiXig==");
    const forbidden = /(?:^|[/"\s])(?:mppx|@solana|@solana-program|@zerc20)(?:[/"\s]|$)/;
    for (const file of ["package.json", "npm-shrinkwrap.json"]) expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(forbidden);
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock.packages[`node_modules/${name}`].version).toBe(version);
    }
  });

  test("signer import graph stays inside the three vendor files, with only viem externally", () => {
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
      "src/sign/index.ts", "src/vendor/networks.ts", "src/vendor/sign-classify-evm.ts", "src/vendor/x402-payer.ts",
    ]);
    expect([...external].sort()).toEqual(["viem", "viem/accounts"]);
  });
});
