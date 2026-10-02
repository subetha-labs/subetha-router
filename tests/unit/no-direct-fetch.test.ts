/**
 * SSRF 防御 A（設計 I-6）: 上流へ出る HTTP は `src/net/guarded-fetch.ts` の transport だけが行う。
 * `src/` のそれ以外で `fetch(` を直接呼ぶコードが増えたら、ここで落とす。
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

describe("no direct fetch outside src/net", () => {
  it("src/ の fetch 呼び出しは transport 経由だけ", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      // transport 本体と、Router を**呼ぶ側**の typed client（既存チャット向け。Router の上流経路ではない）は対象外。
      if (file.startsWith(path.join("src", "net") + path.sep) || file.startsWith(path.join("src", "client") + path.sep)) continue;
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        if (/^\s*\*/.test(code)) return; // JSDoc の中
        // `transport.fetch(`、`mppx.rawFetch(`、`@x402/fetch` の import、型参照 `typeof globalThis.fetch` は許す。
        // 裸の `fetch(` と値としての `globalThis.fetch` は禁止。
        const withoutTypeRef = code.replace(/typeof globalThis\.fetch/g, "");
        if (/(^|[^.\w])fetch\(/.test(withoutTypeRef) || /globalThis\.fetch/.test(withoutTypeRef)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("src/ で viem の http() transport（JSON-RPC の HTTP）を作るのは src/net/guarded-rpc.ts だけ", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      if (file.startsWith(path.join("src", "net") + path.sep)) continue;
      const source = readFileSync(file, "utf8");
      if (/import\s*\{[^}]*\bhttp\b[^}]*\}\s*from\s*"viem"/.test(source) || /from\s*"viem\/clients\/transports\/http"/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
