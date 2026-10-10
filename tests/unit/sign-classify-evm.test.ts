/**
 * P-0（`docs/agent-payer-tasks.md`、設計 §3.8）: `tools/sign-classify-evm.ts` は x402 の EVM だけを分類し、`mppx`・`@solana/*`・他の tools を import しない。
 * EVM の行は `sign-dispatch.test.ts` と同じ結果。MPP・Solana の offer は署名せず拒む（共通の検査で拒まれるものは同じ理由、それ以外は「範囲外」）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, test } from "vitest";

import { KNOWN_NETWORKS, type KnownNetwork } from "../../src/shared/networks.js";
import { classifyEvmOffer, SIGN_MAX_AMOUNT } from "../../tools/sign-classify-evm.js";
import { classifyOffer } from "../../tools/sign-dispatch.js";

const NOW = 1_800_000_000_000;
const EXPIRES = 1_800_000_000 + 600;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const NONCE = `0x${"ab".repeat(32)}`;
const MPPX_ID = "uGQwVTWXtw6jO8_MDh3chilAsnDGQ2G8fxaHCMWlfGQ";

function evm(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600, extra: { name: "USDC", version: "2", challengeNonce: NONCE, expiresAt: EXPIRES, routeBinding: "b", fundsMoveOnCredential: false, ...extra }, ...overrides };
}
function svm(): Record<string, unknown> {
  return { scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: OWNER, maxTimeoutSeconds: 40, extra: { feePayer: OWNER, memo: NONCE, challengeNonce: NONCE, expiresAt: EXPIRES, routeBinding: "b", fundsMoveOnCredential: false } };
}
function tempo(): Record<string, unknown> {
  return { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600, extra: { challengeNonce: MPPX_ID, expiresAt: EXPIRES, routeBinding: "b", fundsMoveOnCredential: true, challenge: 'Payment id="x"' } };
}

describe("classifyEvmOffer: x402 の EVM だけ", () => {
  test("Base Sepolia → x402-evm（chainId 84532、domain USDC/2）。Arc → 5042002。classifyOffer と同じ結果", () => {
    const base = classifyEvmOffer(evm(), NOW);
    expect(base).toEqual({ kind: "x402-evm", chainId: 84532, domain: { name: "USDC", version: "2" }, asset: USDC, payTo: RECEIVER, amount: "10000" });
    expect(base).toEqual(classifyOffer(evm(), NOW));
    const arc = evm({ network: "eip155:5042002", asset: ARC_USDC }, { assetTransferMethod: "eip3009" });
    expect(classifyEvmOffer(arc, NOW)).toMatchObject({ kind: "x402-evm", chainId: 5042002 });
    expect(classifyEvmOffer(arc, NOW)).toEqual(classifyOffer(arc, NOW));
  });

  test("Base mainnet の x402（docs/mainnet-first-route.md）: domain は USD Coin/2（CoinGecko の 402 と同じ）。testnet の USDC/2 では拒む", () => {
    const main = evm({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, { name: "USD Coin" });
    expect(classifyEvmOffer(main, NOW)).toMatchObject({ kind: "x402-evm", chainId: 8453, domain: { name: "USD Coin", version: "2" } });
    expect(classifyEvmOffer(evm({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/EIP-712 domain does not match/) });
  });

  test("上限は 20,000（ちょうどは通る、20,001 は拒む）", () => {
    expect(SIGN_MAX_AMOUNT).toBe(20_000n);
    expect(classifyEvmOffer(evm({ amount: "20000" }), NOW).kind).toBe("x402-evm");
    expect(classifyEvmOffer(evm({ amount: "20001" }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/exceeds the cap/) });
  });

  test("署名の前に拒む（EVM の行。理由は classifyOffer と同じ文言）", () => {
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["表に無い network", evm({ network: "eip155:1" }), /not in the table/],
      ["表に無い資産", evm({ asset: "0x000000000000000000000000000000000000beef" }), /not a known asset/],
      ["domain が表と違う", evm({}, { name: "USD Coin" }), /EIP-712 domain does not match/],
      ["domain の version が違う", evm({}, { version: "3" }), /EIP-712 domain does not match/],
      ["失効", evm({}, { expiresAt: 1_800_000_000 - 1 }), /expired/],
      ["expiresAt 無し", evm({}, { expiresAt: undefined }), /no expiresAt/],
      ["payTo の形違い", evm({ payTo: "0x1234" }), /payTo is not a well-formed/],
      ["exact で fundsMoveOnCredential true", evm({}, { fundsMoveOnCredential: true }), /must not move funds/],
      ["scheme が不明", evm({ scheme: "upto" }), /neither exact nor tempo/],
      ["x402 を Tempo に", evm({ network: "eip155:42431", asset: PATHUSD }), /not accepted on that network/],
      ["額が整数でない", evm({ amount: "1.5" }), /not a base-unit integer/],
      ["nonce が無い", evm({}, { challengeNonce: undefined }), /challengeNonce/],
      ["nonce の形違い", evm({}, { challengeNonce: "abc" }), /challengeNonce/],
      ["offer でない", "x" as unknown as Record<string, unknown>, /no readable/],
    ];
    for (const [name, offer, pattern] of cases) {
      const mine = classifyEvmOffer(offer, NOW);
      expect(mine.kind, name).toBe("refuse");
      expect((mine as { reason: string }).reason, name).toMatch(pattern);
      expect(mine, name).toEqual(classifyOffer(offer, NOW));
    }
  });

  test("MPP（Tempo・Solana）と x402 の Solana は範囲外として拒む（署名しない。全レールは classifyOffer）", () => {
    expect(classifyEvmOffer(tempo(), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/only x402 EVM offers \(MPP/) });
    expect(classifyEvmOffer(svm(), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/only x402 EVM offers \(Solana/) });
    // 全レールの振り分けは変わらない（Solana の x402 は x402-svm）。
    expect(classifyOffer(svm(), NOW)).toMatchObject({ kind: "x402-svm", mint: MINT });
  });

  test("表を差し替えられる（domain の無い資産には署名しない）", () => {
    const networks: KnownNetwork[] = KNOWN_NETWORKS.map((n) => (n.network === "eip155:84532" ? { ...n, assets: n.assets.map((a) => ({ id: a.id, decimals: a.decimals })) } : n));
    expect(classifyEvmOffer(evm(), NOW, networks)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/no EIP-712 domain/) });
  });
});

/**
 * 1 つの TypeScript の source から module の指定子を全部取り出す（TypeScript の compiler API で AST を辿る。コメント・文字列の中は構文上の import ではないので拾わない）。
 * 拾うもの: `import … from`、副作用の `import "x"`、`export … from`、`import x = require("x")`、`import("x")`、`require("x")`（どの引用符でも。補間の無い backtick も）。
 * **指定子がリテラルでない `import(…)` / `require(…)`（識別子・補間つきテンプレート）は検査できないので例外**にする。型だけの import も数える（保守的）。
 */
export function specifiersOf(source: string): string[] {
  const sourceFile = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const found = new Set<string>();
  const literalOf = (node: ts.Node | undefined): string | undefined =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      const spec = literalOf(node.moduleSpecifier);
      if (spec === undefined) throw new Error(`module specifier is not a string literal: ${node.getText(sourceFile)}`);
      found.add(spec);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const spec = literalOf(node.moduleReference.expression);
      if (spec === undefined) throw new Error(`dynamic module loading with a non-literal specifier is not allowed: ${node.getText(sourceFile)}`);
      found.add(spec);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isDynamicImport || isRequire) {
        const spec = literalOf(node.arguments[0]);
        if (spec === undefined) throw new Error(`dynamic module loading with a non-literal specifier is not allowed: ${node.getText(sourceFile)}`);
        found.add(spec);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...found];
}

/** 相対 import を辿って、module の集合に外部パッケージ `mppx`・`@solana/*` が無いことを見る（静的な import graph の検査）。 */
function importGraphOf(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    const resolved = path.resolve(file);
    if (files.has(resolved)) return;
    files.add(resolved);
    for (const spec of specifiersOf(readFileSync(resolved, "utf8"))) {
      if (spec.startsWith(".")) {
        visit(path.resolve(path.dirname(resolved), spec.replace(/\.js$/, ".ts")));
      } else {
        packages.add(spec);
      }
    }
  };
  visit(entry);
  return { files: [...files], packages: [...packages] };
}

/** 外部パッケージの指定子が禁止の集合（`mppx`・`mppx/…`・`@solana/…`・`@solana-program/…`）か。 */
function isForbidden(spec: string): boolean {
  return spec === "mppx" || spec.startsWith("mppx/") || spec.startsWith("@solana/") || spec.startsWith("@solana-program/");
}

describe("P-0: import graph", () => {
  test("sign-classify-evm.ts は mppx・@solana/* を（相対 import を辿っても）引き込まない", () => {
    const graph = importGraphOf(path.resolve(import.meta.dirname, "../../tools/sign-classify-evm.ts"));
    const external = graph.packages.filter(isForbidden);
    expect(external).toEqual([]);
    // 辿った module は shared の表だけ。表は外部パッケージに依存しない（base58 の検査は自前）。
    expect(graph.files.map((f) => path.relative(path.resolve(import.meta.dirname, "../.."), f)).sort()).toEqual(["src/shared/networks.ts", "tools/sign-classify-evm.ts"]);
  });

  test("specifiersOf（AST）: 二重引用符・一重引用符・backtick、副作用 import、import()、require()、import = require、re-export、型だけの import、コメントの中は拾わない、文字列の中のコメント記号は import を隠さない", () => {
    const source = [
      'import { a } from "./a.js";',
      "import b from './b.js';",
      "import c from `./c.js`;",
      "import 'side-effect';",
      'export { d } from "pkg-d";',
      "export * from 'pkg-e';",
      "const f = await import('mppx/client');",
      'const g = require("@solana/kit");',
      "const h = require(`@solana-program/token`);",
      'import i = require("pkg-i");',
      'import type { J } from "type-only";',
      '// import { x } from "commented-out";',
      '/* import { y } from "block-commented"; */',
      'const text = "not an import";',
      'const open = "/*"; import "mppx"; const close = "*/";',
    ].join("\n");
    expect(specifiersOf(source).sort()).toEqual(["./a.js", "./b.js", "./c.js", "@solana-program/token", "@solana/kit", "mppx", "mppx/client", "pkg-d", "pkg-e", "pkg-i", "side-effect", "type-only"].sort());
    expect(["mppx", "mppx/client", "@solana/kit", "@solana-program/token"].every(isForbidden)).toBe(true);
    expect(["viem", "mppxish", "@solanaX/y"].some(isForbidden)).toBe(false);
  });

  test("specifiersOf: リテラルでない import()・require()（識別子・補間つきテンプレート）は検査できないので拒む", () => {
    expect(() => specifiersOf("const m = await import(name);")).toThrow(/non-literal/);
    expect(() => specifiersOf("const m = require(process.env.X);")).toThrow(/non-literal/);
    expect(() => specifiersOf("const n = 'mppx'; const m = await import(`${n}`);")).toThrow(/non-literal/);
    expect(() => specifiersOf("const m = require(`@solana/${'kit'}`);")).toThrow(/non-literal/);
  });

  test("sign-dispatch.ts（全レール）は今までどおり mppx と Solana の検査を持つ", () => {
    const graph = importGraphOf(path.resolve(import.meta.dirname, "../../tools/sign-dispatch.ts"));
    expect(graph.packages).toContain("mppx");
    expect(graph.files.some((f) => f.endsWith("tools/svm-mpp-payer.ts"))).toBe(true);
  });
});
