/** P-5b owned-file/process helpers. No inherited npm/auth environment; no process inventory. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Preserve even undefined/non-Error failures, and attempt each cleanup once. */
export async function withCleanup<T>(
  operation: () => T | Promise<T>,
  cleanups: readonly (() => void | Promise<void>)[],
  report: (message: string) => void | Promise<void> = message => console.error(message),
): Promise<T> {
  let value!: T, primary: unknown, firstCleanup: unknown;
  let primaryFailed = false, cleanupFailed = false;
  try {
    value = await operation();
  } catch (error) {
    primaryFailed = true;
    primary = error;
  }
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) {
      if (!cleanupFailed) firstCleanup = error;
      cleanupFailed = true;
      // Never include arbitrary error payloads or fixture paths in diagnostics.
      try { await report("install_fixture_cleanup_failed"); } catch { /* diagnostics cannot replace the failure */ }
    }
  }
  if (primaryFailed) throw primary;
  if (cleanupFailed) throw firstCleanup;
  return value;
}

export const packageRoot = path.resolve(import.meta.dirname, "../..");
export const repoRoot = path.resolve(packageRoot, "../..");
export const json = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
export const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
export function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap(name => {
    const file = path.join(dir, name), stat = lstatSync(file);
    return stat.isDirectory() ? files(file) : [file];
  });
}
export function snapshot(dir: string) {
  return files(dir).map(file => {
    const st = lstatSync(file);
    return { file: path.relative(dir, file), hash: st.isSymbolicLink() ? realpathSync(file) : sha256(file), ino: st.ino, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs };
  });
}
export function executable(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    try { accessSync(file, constants.X_OK); return realpathSync(file); } catch { /* next explicit executable */ }
  }
  throw new Error(`required executable unavailable: ${name}`);
}
export function isolated(label: string) {
  const parent = path.join(repoRoot, ".claude_workflow/local/p5b-install");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(parent, `${label}-`));
  for (const name of ["home", "cache", "prefix", "tmp", "tools", "package", "tarballs"]) mkdirSync(path.join(root, name), { mode: 0o700 });
  for (const name of ["user.npmrc", "global.npmrc"]) writeFileSync(path.join(root, name), "", { mode: 0o600 });
  symlinkSync(process.execPath, path.join(root, "tools/node"));
  const env: Record<string, string> = {
    PATH: `${path.join(root, "prefix/bin")}:${path.join(root, "tools")}:/usr/bin:/bin`,
    HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), LANG: "en_US.UTF-8",
    npm_config_cache: path.join(root, "cache"), npm_config_prefix: path.join(root, "prefix"),
    npm_config_userconfig: path.join(root, "user.npmrc"), npm_config_globalconfig: path.join(root, "global.npmrc"),
    npm_config_registry: "https://registry.npmjs.org/", npm_config_update_notifier: "false",
    npm_config_fetch_retries: "0", npm_config_fetch_timeout: "60000", npm_config_fund: "false",
  };
  return { root, env, source: path.join(root, "package"), prefix: path.join(root, "prefix"),
    receipt(value: object) { writeFileSync(path.join(root, "receipt.json"), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); },
    // Only our synthetic HOME is removed. Tarball/cache/receipt remain private for parent readback/mutations.
    cleanHome() { rmSync(path.join(root, "home"), { recursive: true, force: true }); rmSync(path.join(root, "wallet.stdout"), { force: true }); },
  };
}
export type Fixture = ReturnType<typeof isolated>;
export interface Result { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
export function run(command: string, args: string[], cwd: string, env: Record<string, string>, timeout = 60_000, input?: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure: string | undefined, exited = false;
    const closePipes = () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); };
    const stop = (reason: string) => { failure ??= reason; if (!exited) child.kill("SIGKILL"); else closePipes(); };
    const timer = setTimeout(() => stop("owned_process_timeout"), timeout);
    child.once("error", () => { failure ??= "owned_process_launch_failed"; });
    child.once("exit", () => { exited = true; if (failure) closePipes(); });
    const collect = (which: "stdout" | "stderr", chunk: Buffer) => {
      if (stdout.length + stderr.length + chunk.length > 8 * 1024 * 1024) { stop("owned_process_output_limit"); return; }
      if (which === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", chunk => collect("stdout", chunk)); child.stderr.on("data", chunk => collect("stderr", chunk));
    child.stdin.on("error", () => { failure ??= "owned_process_stdin_failed"; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(new Error(failure)); else resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
export function success(result: Result, label: string): void {
  if (result.code !== 0 || result.signal !== null) throw new Error(`${label}: exit=${result.code}, signal=${result.signal}`);
}
export const npm = (args: string[], cwd: string, env: Record<string, string>, timeout = 180_000) =>
  run(process.execPath, [executable("npm"), ...args], cwd, env, timeout);
export async function buildCopy(f: Fixture): Promise<void> {
  for (const name of ["src", "test", "scripts", "bin", "package.json", "npm-shrinkwrap.json", "tsconfig.json", "tsconfig.build.json", "README.md"]) {
    cpSync(path.join(packageRoot, name), path.join(f.source, name), { recursive: true });
  }
  symlinkSync(path.join(packageRoot, "node_modules"), path.join(f.source, "node_modules"), "dir");
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  success(await run(process.execPath, [tsc, "-p", "tsconfig.build.json"], f.source, f.env), "isolated_build");
}
export async function pack(f: Fixture) {
  const result = await npm(["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", path.join(f.root, "tarballs")], f.source, f.env);
  success(result, "pack");
  const info = JSON.parse(result.stdout)[0];
  if (!/^[a-zA-Z0-9_.-]+\.tgz$/.test(info.filename)) throw new Error("pack_filename_invalid");
  const tarball = path.join(f.root, "tarballs", info.filename);
  return { tarball, sha256: sha256(tarball), files: info.files.map((file: { path: string }) => file.path) as string[] };
}
/**
 * Pre-publication install of the packed artifact with the shrinkwrap honoured exactly.
 *
 * `npm install --global <tarball>` does NOT read a tarball's npm-shrinkwrap.json: npm's arborist only honours a
 * package's shrinkwrap when its manifest carries `_hasShrinkwrap`, which the registry sets on publication. A local
 * tarball never has it, so global installs resolve the newest matching versions (observed 2026-10-10: express 5.3.0
 * instead of the locked 5.2.1). Owner decision 2026-10-10 (option 1): before publication, extract the tarball into the
 * global layout and run `npm ci` there (the shrinkwrap is the lockfile), then link the bin exactly as npm does. The
 * registry path (`npm i -g @subetha/payer` after G-A1) is verified against the shrinkwrap at G-A2.
 */
export async function installLocked(f: Fixture, tarball: string, env: Record<string, string>, npmArgs: string[]): Promise<{ installed: string; bin: string; result: Result }> {
  const installed = path.join(f.prefix, "lib/node_modules/@subetha/payer");
  const bin = path.join(f.prefix, "bin/subetha-payer");
  mkdirSync(installed, { recursive: true, mode: 0o755 });
  mkdirSync(path.dirname(bin), { recursive: true, mode: 0o755 });
  success(await run("/usr/bin/tar", ["-xzf", tarball, "-C", installed, "--strip-components=1"], f.root, env), "extract_tarball");
  // `--prefix` pins npm ci to the extracted package (npm_config_prefix in env is the global prefix).
  const result = await npm(["ci", "--prefix", installed, "--omit=dev", ...npmArgs], installed, env);
  if (result.code === 0) {
    const launcher = path.join(installed, "bin/subetha-payer");
    if (existsSync(launcher)) symlinkSync(path.relative(path.dirname(bin), launcher), bin);
  }
  return { installed, bin, result };
}

export function assertLockedTree(install: string, source = packageRoot): number {
  const lock = json(path.join(source, "npm-shrinkwrap.json"));
  if (sha256(path.join(install, "npm-shrinkwrap.json")) !== sha256(path.join(source, "npm-shrinkwrap.json"))) throw new Error("installed_shrinkwrap_changed");
  const expected = Object.keys(lock.packages).filter(key => key !== "").sort();
  // Match physical package roots, including nested version duplicates, not just direct deps.
  const actual: string[] = [];
  function scan(modules: string) {
    if (!existsSync(modules)) return;
    for (const name of readdirSync(modules)) {
      if (name.startsWith(".")) continue;
      if (name.startsWith("@")) {
        for (const child of readdirSync(path.join(modules, name))) visit(path.join(modules, name, child));
      } else visit(path.join(modules, name));
    }
  }
  function visit(dir: string) {
    if (lstatSync(dir).isSymbolicLink()) throw new Error("installed_dependency_symlink");
    const key = path.relative(install, dir).split(path.sep).join("/"); actual.push(key);
    const identity = json(path.join(dir, "package.json")), pinned = lock.packages[key];
    if (!pinned || identity.version !== pinned.version || identity.name !== key.split("node_modules/").at(-1)) throw new Error("installed_dependency_identity_mismatch");
    scan(path.join(dir, "node_modules"));
  }
  scan(path.join(install, "node_modules"));
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) throw new Error("installed_transitive_tree_mismatch");
  return expected.length;
}
