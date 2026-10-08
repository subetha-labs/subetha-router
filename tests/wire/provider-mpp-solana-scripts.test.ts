/**
 * Provider D の鍵・秘密の script（`providers/mpp-solana-workers/scripts/*.mjs`。`docs/provider-mpp-solana-workers.md` §2.4）: 標準出力に出るのは公開鍵だけ、
 * `--dry-run` は wrangler を呼ばない、受取 owner の seed はリポジトリの外の file にだけ（既存は上書きしない、中は拒む）。wrangler は呼ばない（dry-run と file の経路だけ）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getBase58Encoder } from "@solana/kit";

const PACKAGE_DIR = path.resolve(import.meta.dirname, "../../providers/mpp-solana-workers");

function run(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PACKAGE_DIR, "scripts", script), ...args], { cwd: PACKAGE_DIR, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const BASE58_32 = (value: string): boolean => {
  try {
    return getBase58Encoder().encode(value).length === 32;
  } catch {
    return false;
  }
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("Provider D の script", () => {
  test("keygen-fee-payer --dry-run: 公開鍵だけ（1 行、base58 32 バイト）。seed は出ない", async () => {
    const result = await run("keygen-fee-payer.mjs", ["--dry-run"]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const match = /^FEE_PAYER_PUBKEY=([1-9A-HJ-NP-Za-km-z]+)$/.exec(lines[0]!);
    expect(match).not.toBeNull();
    expect(BASE58_32(match![1]!)).toBe(true);
    expect(result.stderr).toBe("");
  });

  test("secret-new --dry-run: 値は出ない（長さだけ）", async () => {
    const result = await run("secret-new.mjs", ["--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^MPP_SECRET: 64 characters \(not stored\)\n$/);
  });

  test("keygen-recipient: リポジトリの外の file にだけ seed を書く（0600、既存は上書きしない、リポジトリの中は拒む、引数無しは usage）。標準出力は公開鍵だけ", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "provider-d-recipient-"));
    dirs.push(dir);
    const file = path.join(dir, "nested", "recipient.seed");
    const ok = await run("keygen-recipient.mjs", [file]);
    expect(ok.code, ok.stderr).toBe(0);
    const match = /^PAY_TO=([1-9A-HJ-NP-Za-km-z]+)\n$/.exec(ok.stdout);
    expect(match).not.toBeNull();
    expect(BASE58_32(match![1]!)).toBe(true);
    const seed = readFileSync(file, "utf8").trim();
    expect(BASE58_32(seed)).toBe(true);
    expect(ok.stdout).not.toContain(seed);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    // 既存は上書きしない。
    const again = await run("keygen-recipient.mjs", [file]);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/refusing to overwrite/);
    expect(readFileSync(file, "utf8").trim()).toBe(seed);
    // リポジトリの中は拒む（相対・絶対）。
    for (const inside of ["./recipient.seed", path.join(PACKAGE_DIR, "x.seed"), path.resolve(PACKAGE_DIR, "../../runtime/x.seed")]) {
      const refused = await run("keygen-recipient.mjs", [inside]);
      expect(refused.code, inside).toBe(1);
      expect(refused.stderr, inside).toMatch(/inside the repository/);
    }
    const usage = await run("keygen-recipient.mjs", []);
    expect(usage.code).toBe(2);
  });
});
