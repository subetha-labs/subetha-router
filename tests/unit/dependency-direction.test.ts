/**
 * 依存の向き（multirail 設計 §9、SR-1）:
 * - `@x402/svm` は試験の fixture（facilitator の本物の verify の論理）と互換の試験だけが使う。`src/`・`tools/` には**文字列としても**現れない
 *   （import の形——静的・動的・template literal・require・re-export・subpath——を数え上げる代わりに、名前そのものを禁じる。コメントにも書かない）
 * - `src/` は `@solana/kit` の codec・compile（純粋）だけを使い、RPC client・transport・subscription を作らない。
 *   起動時の ATA の検査は guarded transport で JSON-RPC を POST する（設計 §5.1）。下位 package（`@solana/rpc*`）の直接 import も禁じる
 * - `src/` は `tests/` から import しない（fixture 経由の抜け道を塞ぐ。`tools/` の e2e runner は loopback の fixture を使うので対象外）
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

/** 行頭のコメント（`//`・JSDoc の `*`）だけを除く。文字列の中の `//` を誤ってコメント扱いしない（行末コメントは除かない）。 */
function offendersOf(dirs: readonly string[], pattern: RegExp): string[] {
  const offenders: string[] = [];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (pattern.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  return offenders;
}

describe("dependency direction", () => {
  it("src/ と tools/ に @x402/svm は現れない（import のどの形でも）", () => {
    expect(offendersOf(["src", "tools"], /@x402\/svm/)).toEqual([]);
  });

  it("src/ は @solana/kit の RPC client・transport・subscription を作らず、下位の rpc package を import しない", () => {
    const names = /\b(createSolanaRpc|createSolanaRpcFromTransport|createSolanaRpcSubscriptions|createSolanaRpcSubscriptionsFromTransport|createRpc|createRpcSubscriptions|createDefaultRpcTransport|createDefaultRpcSubscriptionsTransport|createHttpTransport|createHttpTransportForSolanaRpc|createWebSocketTransport|sendAndConfirmTransactionFactory|sendTransactionWithoutConfirmingFactory)\b/;
    const packages = /["'`]@solana\/(rpc|rpc-api|rpc-spec|rpc-spec-types|rpc-transport-http|rpc-subscriptions|rpc-subscriptions-channel-websocket|rpc-transformers|rpc-types|transaction-confirmation)(\/|["'`])/;
    expect(offendersOf(["src"], names)).toEqual([]);
    expect(offendersOf(["src"], packages)).toEqual([]);
  });

  it("src/ は tests/ から import しない", () => {
    expect(offendersOf(["src"], /(import|export)[^;]*from\s*["'`][^"'`]*\/tests\//)).toEqual([]);
    expect(offendersOf(["src"], /import\(\s*["'`][^"'`]*\/tests\//)).toEqual([]);
  });
});
