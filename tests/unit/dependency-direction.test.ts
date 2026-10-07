/**
 * 依存の向き（multirail 設計 §9、SR-1）:
 * - `@x402/svm` は試験の fixture（facilitator の本物の verify の論理）と互換の試験だけが使う。`src/`・`tools/` は import しない
 * - `src/` は `@solana/kit` の codec・compile（純粋）だけを使い、RPC client（`createSolanaRpc` 等）を作らない。
 *   起動時の ATA の検査は guarded transport で JSON-RPC を POST する（設計 §5.1）
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

function offendersOf(dirs: readonly string[], pattern: RegExp): string[] {
  const offenders: string[] = [];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "");
        if (/^\s*\*/.test(code)) return; // JSDoc の中
        if (pattern.test(code)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  return offenders;
}

describe("dependency direction", () => {
  it("src/ と tools/ は @x402/svm を import しない", () => {
    expect(offendersOf(["src", "tools"], /["']@x402\/svm(\/|["'])/)).toEqual([]);
  });

  it("src/ は @solana/kit の RPC client・subscription を作らない", () => {
    expect(offendersOf(["src"], /\b(createSolanaRpc|createSolanaRpcSubscriptions|createDefaultRpcTransport|createHttpTransport|sendAndConfirmTransactionFactory)\b/)).toEqual([]);
  });
});
