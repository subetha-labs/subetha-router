/**
 * P-1a: 公開物に test-only のコードが入らない。`npm pack --dry-run --json` の一覧に `test/` が無く、`bin/subetha-payer` と `dist/bin.js` がある。
 * `dist/` のどの file も `test/` を import しない。`bin` の launcher は `exec node --disable-sigusr1` で `dist/bin.js` を起動する。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
let workspace: string;
let packageRoot: string;
let packEnv: NodeJS.ProcessEnv;
function sharedDistSnapshot() {
  return walk(path.join(root, "dist")).sort().map((file) => {
    const st = statSync(file);
    return { file: path.relative(root, file), sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
      ino: st.ino, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs };
  });
}
let sharedDistBefore: ReturnType<typeof sharedDistSnapshot>;
beforeAll(() => {
  sharedDistBefore = sharedDistSnapshot();
  workspace = mkdtempSync(path.join(root, ".npm-pack-fixture-"));
  packageRoot = path.join(workspace, "package");
  mkdirSync(packageRoot);
  // Copy current package inputs, including tests/scripts so exclusion checks are real.
  // Never copy an existing dist: every reader below uses this one fresh build.
  for (const entry of ["src", "test", "scripts", "bin", "package.json", "npm-shrinkwrap.json", "tsconfig.json", "tsconfig.build.json"]) {
    cpSync(path.join(root, entry), path.join(packageRoot, entry), { recursive: true });
  }
  for (const entry of ["README.md", "LICENSE", ".npmignore", ".gitignore", "package-lock.json"]) {
    if (existsSync(path.join(root, entry))) cpSync(path.join(root, entry), path.join(packageRoot, entry));
  }
  // Resolve the existing pinned dependencies normally; no install or registry access.
  symlinkSync(path.join(root, "node_modules"), path.join(packageRoot, "node_modules"), "dir");
  packEnv = { ...process.env, npm_config_cache: path.join(workspace, "cache"), npm_config_offline: "true" };
  expect(existsSync(path.join(packageRoot, "dist"))).toBe(false);
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: packageRoot, env: packEnv, stdio: "pipe" });
  expect(existsSync(path.join(packageRoot, "dist/bin.js"))).toBe(true);
});
afterAll(() => {
  try {
    // Metadata catches same-byte rewrites too; atime is deliberately excluded.
    expect(sharedDistSnapshot()).toEqual(sharedDistBefore);
  } finally {
    if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
  }
});

/** JS の source から module の指定子を AST で取り出す（static / re-export / import() / require()）。リテラルでない指定子は例外。 */
function specifiersOf(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const found = new Set<string>();
  const literalOf = (node: ts.Node | undefined): string | undefined => (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      const spec = literalOf(node.moduleSpecifier);
      if (spec === undefined) throw new Error("non-literal module specifier in " + fileName);
      found.add(spec);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const spec = literalOf(node.arguments[0]);
      if (spec === undefined) throw new Error("non-literal dynamic import in " + fileName);
      found.add(spec);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...found];
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("P-1a: packaging boundary", () => {
  test("npm pack lists bin and dist only (no test/, no scripts/, no fixtures)", () => {
    // Keep npm's temporary writes inside this workspace, without registry access.
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageRoot, env: packEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const files = (JSON.parse(output) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path);
    expect(files).toContain("bin/subetha-payer");
    expect(files).toContain("dist/bin.js");
    expect(files).toContain("package.json");
    // 利用者側で依存を固定するのは npm-shrinkwrap.json（package-lock.json は pack に入らない）。
    expect(files).toContain("npm-shrinkwrap.json");
    expect(files).not.toContain("package-lock.json");
    expect(files.filter((f) => f.startsWith("test/") || f.startsWith("scripts/") || f.includes("fixture"))).toEqual([]);
    expect(files.filter((f) => f.endsWith(".test.js") || f.endsWith(".test.ts"))).toEqual([]);
  });

  test("dist/ never imports test/ (AST over every import form) and never contains a test-only entry", () => {
    const distFiles = walk(path.join(packageRoot, "dist")).filter((f) => f.endsWith(".js"));
    expect(distFiles.length).toBeGreaterThan(0);
    for (const file of distFiles) {
      const specs = specifiersOf(readFileSync(file, "utf8"), file);
      expect(specs.filter((s) => /(^|\/)test(\/|$)/.test(s) || s.includes("test-entry") || s.includes("fixture")), file).toEqual([]);
      expect(path.basename(file), file).not.toMatch(/test-entry/);
    }
  });

  test("installed layout: the launcher works through a symlink (as npm installs it) and from a directory whose name has # and %", () => {
    const base = path.join(workspace, "installed");
    const pkg = path.join(base, "lib", "node_modules", "@subetha", "pay#er %1");
    cpSync(path.join(packageRoot, "bin"), path.join(pkg, "bin"), { recursive: true });
    cpSync(path.join(packageRoot, "dist"), path.join(pkg, "dist"), { recursive: true });
    cpSync(path.join(root, "node_modules"), path.join(pkg, "node_modules"), { recursive: true });
    cpSync(path.join(packageRoot, "package.json"), path.join(pkg, "package.json"));
    const binDir = path.join(base, "bin");
    cpSync(path.join(packageRoot, "bin"), binDir, { recursive: true }); // placeholder so the dir exists
    rmSync(path.join(binDir, "subetha-payer"));
    symlinkSync(path.relative(binDir, path.join(pkg, "bin", "subetha-payer")), path.join(binDir, "subetha-payer"));
    const viaSymlink = spawnSync("sh", [path.join(binDir, "subetha-payer"), "help"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    expect(viaSymlink.stderr).not.toMatch(/Cannot find module/);
    expect(viaSymlink.status).toBe(0);
    expect(viaSymlink.stderr).toMatch(/usage: subetha-payer/);
    const viaOddPath = spawnSync("sh", [path.join(pkg, "bin", "subetha-payer"), "wallet", "address"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    expect(viaOddPath.status).toBe(2);
    expect(viaOddPath.stderr).toMatch(/cli_refused: home_unavailable/);
    // Resolve the packaged signer's runtime dependencies; never invoke signing.
    const signerUrl = pathToFileURL(path.join(pkg, "dist/sign/index.js")).href;
    const signerImport = spawnSync(process.execPath, ["--input-type=module", "--eval",
      `const { sign } = await import(${JSON.stringify(signerUrl)}); if (typeof sign !== "function") throw new Error("missing sign export");`,
    ], { cwd: base, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    expect(signerImport.stderr).toBe("");
    expect(signerImport.status).toBe(0);
  });

  test("the launcher execs node with --disable-sigusr1 and points at dist/bin.js", () => {
    const launcher = readFileSync(path.join(packageRoot, "bin/subetha-payer"), "utf8");
    expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
    expect(launcher).toMatch(/^exec node --disable-sigusr1 "\$here\/\.\.\/dist\/bin\.js" "\$@"$/m);
    expect(launcher).toMatch(/while \[ -L "\$self" \]; do/); // symlink の解決
    expect((statSync(path.join(packageRoot, "bin/subetha-payer")).mode & 0o111) !== 0).toBe(true);
  });

  test("package.json: files, bin, engines, pinned dependencies (no ranges)", () => {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { files: string[]; bin: Record<string, string>; engines: { node: string }; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.files).toEqual(["bin", "dist", "npm-shrinkwrap.json"]);
    expect(pkg.bin).toEqual({ "subetha-payer": "bin/subetha-payer" });
    expect(pkg.engines.node).toBe(">=22");
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(Object.keys(pkg.dependencies).some((d) => d === "mppx" || d.startsWith("@solana/") || d.startsWith("@solana-program/"))).toBe(false);
  });

  test("node dist/bin.js is refused without the launcher's flag (exit 2, sigusr1_enabled); through the launcher the CLI requires a fixed HOME (exit 2, home_unavailable)", () => {
    const run = (file: string, args: string[]) => spawnSync(file, args, { cwd: packageRoot, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    const direct = run("node", ["dist/bin.js", "wallet", "address"]);
    expect(direct.status).toBe(2);
    expect(direct.stderr).toMatch(/startup_refused: sigusr1_enabled/);
    const launched = run("sh", ["bin/subetha-payer", "wallet", "address"]);
    expect(launched.status).toBe(2);
    expect(launched.stderr).toMatch(/cli_refused: home_unavailable/);
    expect(launched.stderr).not.toMatch(/sigusr1_enabled/);
    const help = run("sh", ["bin/subetha-payer", "help"]);
    expect(help.status).toBe(0);
    expect(help.stderr).toMatch(/usage: subetha-payer/);
  });

  test("building and packing leave the shared dist bytes and write metadata unchanged", () => {
    expect(JSON.stringify(sharedDistSnapshot()) === JSON.stringify(sharedDistBefore), "shared dist bytes or write metadata changed").toBe(true);
  });
});
