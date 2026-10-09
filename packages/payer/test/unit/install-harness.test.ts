/** Author-safe tests: only owned files/processes; no PTY, sockets, identity lookup or registry. */
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { buildCopy, isolated, pack, packageRoot, run, snapshot, withCleanup } from "../harness/install.js";

test("fresh npm environment contains only explicit fixture paths and no inherited auth/config", async () => {
  const a = isolated("unit"), b = isolated("unit");
  await withCleanup(() => {
    expect(a.root).not.toBe(b.root);
    expect(Object.keys(a.env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR", "npm_config_cache", "npm_config_fetch_retries", "npm_config_fetch_timeout", "npm_config_fund", "npm_config_globalconfig", "npm_config_prefix", "npm_config_registry", "npm_config_update_notifier", "npm_config_userconfig"]);
    for (const key of ["HOME", "TMPDIR", "npm_config_cache", "npm_config_prefix", "npm_config_userconfig", "npm_config_globalconfig"]) expect(a.env[key]!.startsWith(a.root + path.sep)).toBe(true);
    expect(readFileSync(a.env.npm_config_userconfig!, "utf8")).toBe("");
    expect(readFileSync(a.env.npm_config_globalconfig!, "utf8")).toBe("");
    expect(a.env.PATH!.startsWith(a.prefix + "/bin:")).toBe(true);
  }, [a, b].map(f => () => rmSync(f.root, { recursive: true, force: true })));
});

test("owned subprocess drains final stdout/stderr and waits for close", async () => {
  const f = isolated("unit");
  await withCleanup(async () => {
    const result = await run(process.execPath, ["-e", "process.stdout.write('last output'); process.stderr.write('last error'); process.exitCode=7"], f.root, f.env);
    expect(result).toEqual({ code: 7, signal: null, stdout: "last output", stderr: "last error" });
  }, [() => rmSync(f.root, { recursive: true, force: true })]);
});

test("owned subprocess deadline rejects with fixed diagnostic after cleanup", async () => {
  const f = isolated("unit");
  await withCleanup(async () => {
    await expect(run(process.execPath, ["-e", "setInterval(()=>{},1000)"], f.root, f.env, 100)).rejects.toThrow("owned_process_timeout");
  }, [() => rmSync(f.root, { recursive: true, force: true })]);
});


test("clean gate builds and packs current copied source offline without touching shared dist", async () => {
  const f = isolated("unit-pack"), before = snapshot(path.join(packageRoot, "dist"));
  await withCleanup(async () => {
    await buildCopy(f);
    const artifact = await pack(f);
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.files).toContain("dist/bin.js");
    expect(artifact.files).toContain("README.md");
    expect(artifact.files.some(file => file.startsWith("test/") || file.startsWith("scripts/"))).toBe(false);
    expect(snapshot(path.join(packageRoot, "dist"))).toEqual(before);
  }, [() => rmSync(f.root, { recursive: true, force: true })]);
}, 120_000);
