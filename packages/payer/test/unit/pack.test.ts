/**
 * P-1a: 公開物に test-only のコードが入らない。`npm pack --dry-run --json` の一覧に `test/` が無く、`bin/subetha-payer` と `dist/bin.js` がある。
 * `dist/` のどの file も `test/` を import しない。`bin` の launcher は `exec node --disable-sigusr1` で `dist/bin.js` を起動する。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("P-1a: packaging boundary", () => {
  test("npm pack lists bin and dist only (no test/, no scripts/, no fixtures)", () => {
    // build so that dist exists for the listing
    execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: root, stdio: "pipe" });
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const files = (JSON.parse(output) as { files: { path: string }[] }[])[0]!.files.map((f) => f.path);
    expect(files).toContain("bin/subetha-payer");
    expect(files).toContain("dist/bin.js");
    expect(files).toContain("package.json");
    expect(files.filter((f) => f.startsWith("test/") || f.startsWith("scripts/") || f.includes("fixture"))).toEqual([]);
    expect(files.filter((f) => f.endsWith(".test.js") || f.endsWith(".test.ts"))).toEqual([]);
  });

  test("dist/ never imports test/ and never contains a test-only entry", () => {
    const distFiles = walk(path.join(root, "dist")).filter((f) => f.endsWith(".js"));
    expect(distFiles.length).toBeGreaterThan(0);
    for (const file of distFiles) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/from\s+["'][^"']*\/test\//);
      expect(text, file).not.toMatch(/import\(\s*["'][^"']*\/test\//);
      expect(path.basename(file), file).not.toMatch(/test-entry/);
    }
  });

  test("the launcher execs node with --disable-sigusr1 and points at dist/bin.js", () => {
    const launcher = readFileSync(path.join(root, "bin/subetha-payer"), "utf8");
    expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
    expect(launcher).toMatch(/^exec node --disable-sigusr1 "\$\(dirname "\$0"\)\/\.\.\/dist\/bin\.js" "\$@"$/m);
    expect((statSync(path.join(root, "bin/subetha-payer")).mode & 0o111) !== 0).toBe(true);
  });

  test("package.json: files, bin, engines, pinned dependencies (no ranges)", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { files: string[]; bin: Record<string, string>; engines: { node: string }; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.files).toEqual(["bin", "dist"]);
    expect(pkg.bin).toEqual({ "subetha-payer": "bin/subetha-payer" });
    expect(pkg.engines.node).toBe(">=22");
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(Object.keys(pkg.dependencies).some((d) => d === "mppx" || d.startsWith("@solana/") || d.startsWith("@solana-program/"))).toBe(false);
  });

  test("node dist/bin.js is refused without the launcher's flag (exit 2, sigusr1_enabled); through the launcher the skeleton answers (exit 2, not implemented)", () => {
    const run = (file: string, args: string[]) => spawnSync(file, args, { cwd: root, encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } });
    const direct = run("node", ["dist/bin.js", "wallet", "address"]);
    expect(direct.status).toBe(2);
    expect(direct.stderr).toMatch(/startup_refused: sigusr1_enabled/);
    const launched = run("sh", ["bin/subetha-payer", "wallet", "address"]);
    expect(launched.status).toBe(2);
    expect(launched.stderr).toMatch(/not implemented/);
    expect(launched.stderr).not.toMatch(/sigusr1_enabled/);
    const help = run("sh", ["bin/subetha-payer", "help"]);
    expect(help.status).toBe(0);
    expect(help.stderr).toMatch(/usage: subetha-payer/);
  });
});
