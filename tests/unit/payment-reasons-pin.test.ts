/**
 * 理由の表の照合（`src/shared/payment-reasons.ts`。設計 `docs/rejection-reasons-design.md` §7、§12.5 が優先。要件 FR-R1）。
 * (1) SDK の 3 つの package の版が 2.28.0、manifest・除外の一覧が引く dist のファイルの sha256 が記録した値と一致（版や中身が変われば落ちる → 表を見直す）
 * (2) manifest の各値が、その出どころのファイルに文字列の literal として現れる（SDK は記録した行に。リポジトリのファイルは行が動くのでファイルの中に）
 * (3) 抜き出しの規則で見つかる値のうち manifest に無いものは、明示の除外の一覧に載っている（除外の各値も記録した行に現れる = 古い除外が残らない）
 * (4) `self_facilitator` は `tools/evm-facilitator.ts`、`provider_worker` は `providers/x402-workers/src` に現れ、同じ規則で抜き出した値が manifest ∪ 除外に入る
 *
 * SVM の SDK の package 名は `src/`・`tools/` に書けない（`dependency-direction.test.ts`）ので、節 `x402_svm` → package の対応はこの試験だけが持つ。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  classifyReason,
  REASON_EXCLUSIONS,
  REASON_MANIFEST,
  REASON_TABLE,
  REASON_TABLE_VERSION,
  SDK_VERSION,
  type ReasonSection,
} from "../../src/shared/payment-reasons.js";

const SDK_PACKAGES: Readonly<Record<"x402_core" | "x402_evm" | "x402_svm", string>> = {
  x402_core: "@x402/core",
  x402_evm: "@x402/evm",
  x402_svm: "@x402/svm",
};
type SdkSection = keyof typeof SDK_PACKAGES;
const isSdk = (section: ReasonSection): section is SdkSection => section in SDK_PACKAGES;

/** 出どころのファイルの実際のパス。 */
function sourcePathOf(section: ReasonSection, file: string): string {
  return isSdk(section) ? path.join("node_modules", SDK_PACKAGES[section], file) : file;
}

/** 記録した dist のファイルの sha256（`r1/x402-2.28.0` を作ったときの値）。 */
const DIST_SHA256: Readonly<Record<string, string>> = {
  "x402_core:dist/esm/chunk-FV2JN4FK.mjs": "967de1544225f21efc8e513bd015a3c499f4fbe7a3f2dc580779c4fb82b80a55",
  "x402_evm:dist/esm/batch-settlement/server/index.mjs": "77f56eb9b4318ae96024596ad7bf3a396110af7b5eb6938cabd1fcad492e72f1",
  "x402_evm:dist/esm/chunk-5XX3PMSD.mjs": "26c94a9d0aa670dec391115f948393355cd730657b64ea70b04a29b507fb5db8",
  "x402_evm:dist/esm/chunk-QJHO4KEV.mjs": "42200dadd9f8625d3c8aac4bfb20b942a52a86e08127b697bce39ab581b9a778",
  "x402_evm:dist/esm/chunk-VEDHRFNU.mjs": "7ade6613dc87eaa22e6bbabbb3a988625c9c6b7cee17d07b101a2540e08a8bc4",
  "x402_evm:dist/esm/chunk-XP6HEYCL.mjs": "0c3f23d239ab3492e4956c0edaaabf7c559f9e2c89c26a77d766edf419d03830",
  "x402_evm:dist/esm/upto/facilitator/index.mjs": "13136bf78e6e1ffd9423200f51527be769db8e6aaad2c7c444e60b2a5c11d2f7",
  "x402_svm:dist/esm/batch-settlement/facilitator/index.mjs": "4f316465c38b4e0343970961d987c84f5a3f1ea56098a3fdbf83bab157acfc91",
  "x402_svm:dist/esm/chunk-3F2QC6NG.mjs": "20143e7773abbc64d96ed8bb2b280c34ddd050e9c808618392aace60a3f1318e",
  "x402_svm:dist/esm/chunk-RXPBSPMZ.mjs": "519324fc52029dd5d2f88be4a4b0a2b5e80b64675048d79abbe298ef0f2e2c8b",
  "x402_svm:dist/esm/chunk-UMK65UDR.mjs": "9148bca17f471ee44fe5b786fe102071d2df953a4f60f5e10c43feb27ac16484",
  "x402_svm:dist/esm/chunk-XUXHO7LW.mjs": "ea5012b6474d8a99098333019d0605168c826f3a933d3dea23d3a85500a977e5",
  "x402_svm:dist/esm/upto/facilitator/index.mjs": "1ffcddeb25a8f3029b68601a8d46163c03f13b61b11d775db066259a37b79290",
  "x402_svm:dist/esm/upto/server/index.mjs": "2e9636322325cddc85cf102ed46dc6787f9d358d8e307e0d3daa43ca083b58be",
};

/** 節ごとの数（manifest を見直したらここも直す）。 */
const SECTION_COUNTS: Readonly<Record<ReasonSection, number>> = {
  x402_core: 6,
  x402_evm: 118,
  x402_svm: 83,
  circle: 2,
  self_facilitator: 53,
  provider_worker: 14,
};

const textCache = new Map<string, string>();
function read(file: string): string {
  let text = textCache.get(file);
  if (text === undefined) {
    text = readFileSync(file, "utf8");
    textCache.set(file, text);
  }
  return text;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".mjs")) out.push(full);
  }
  return out;
}

/** 抜き出しの規則（SDK）: dist/esm の全部の `.mjs` の、snake_case（`_` を 1 つ以上含む小文字）の文字列の literal 全部。 */
function sdkLiterals(section: SdkSection): Map<string, string> {
  const found = new Map<string, string>();
  const root = path.join("node_modules", SDK_PACKAGES[section]);
  for (const file of walk(path.join(root, "dist", "esm")).sort()) {
    read(file)
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(/"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"/g)) {
          if (!found.has(m[1]!)) found.set(m[1]!, `${path.relative(root, file)}:${i + 1}`);
        }
      });
  }
  return found;
}

/** 抜き出しの規則（リポジトリ）: 理由を返す形の行の、識別子の形の文字列の literal 全部。 */
const REPO_RULES: ReadonlyArray<{ section: ReasonSection; files: readonly string[]; line: RegExp }> = [
  { section: "self_facilitator", files: ["tools/evm-facilitator.ts"], line: /\b(fail|failure|refuseIfStillUnused)\(|invalidReason:|\berror: "/ },
  {
    section: "provider_worker",
    files: ["index.ts", "facilitator-client.ts", "receipt.ts", "requirements.ts"].map((f) => `providers/x402-workers/src/${f}`),
    line: /\berror: |\breason: |paymentRequired\(|FacilitatorUnavailableError\(|FacilitatorFailure =|cachedError/,
  },
];

function repoLiterals(rule: (typeof REPO_RULES)[number]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of rule.files) {
    read(file)
      .split("\n")
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line) || !rule.line.test(line)) return;
        for (const m of line.matchAll(/"([a-z][a-z0-9_]*)"/g)) if (!found.has(m[1]!)) found.set(m[1]!, `${file}:${i + 1}`);
      });
  }
  return found;
}

const manifestOf = (section: ReasonSection) => REASON_MANIFEST.filter((e) => e.section === section);
const exclusionsOf = (section: ReasonSection) => REASON_EXCLUSIONS.filter((e) => e.section === section);

describe("(1) 版と dist の中身", () => {
  test("SDK の 3 つの package は 2.28.0（package.json も同じ版に固定）", () => {
    expect(SDK_VERSION).toBe("2.28.0");
    expect(REASON_TABLE_VERSION).toBe(`r1/x402-${SDK_VERSION}`);
    const root = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...root.dependencies, ...root.devDependencies };
    for (const pkg of Object.values(SDK_PACKAGES)) {
      expect((JSON.parse(read(path.join("node_modules", pkg, "package.json"))) as { version: string }).version, pkg).toBe(SDK_VERSION);
      expect(deps[pkg], pkg).toBe(SDK_VERSION);
    }
  });

  test("manifest・除外の一覧が引く dist のファイルの sha256 は記録した値", () => {
    const referenced = new Set<string>();
    for (const e of [...REASON_MANIFEST, ...REASON_EXCLUSIONS]) if (isSdk(e.section)) referenced.add(`${e.section}:${e.source.file}`);
    expect([...referenced].sort()).toEqual(Object.keys(DIST_SHA256).sort());
    for (const key of referenced) {
      const [section, file] = key.split(":") as [SdkSection, string];
      const digest = createHash("sha256").update(readFileSync(sourcePathOf(section, file))).digest("hex");
      expect(digest, key).toBe(DIST_SHA256[key]);
    }
  });
});

describe("(2) manifest の各値は出どころに literal として現れる", () => {
  test("節ごとの数", () => {
    for (const [section, count] of Object.entries(SECTION_COUNTS) as Array<[ReasonSection, number]>) {
      expect(manifestOf(section), section).toHaveLength(count);
    }
    expect(REASON_MANIFEST).toHaveLength(Object.values(SECTION_COUNTS).reduce((a, b) => a + b, 0));
  });

  test("SDK の節は記録した行に、リポジトリの節はファイルの中に", () => {
    for (const e of REASON_MANIFEST) {
      const text = read(sourcePathOf(e.section, e.source.file));
      const literal = `"${e.raw}"`;
      if (isSdk(e.section)) {
        expect(text.split("\n")[e.source.line - 1]?.includes(literal), `${e.section} ${e.raw} @ ${e.source.file}:${e.source.line}`).toBe(true);
      } else {
        expect(text.includes(literal), `${e.section} ${e.raw} @ ${e.source.file}`).toBe(true);
      }
    }
  });

  test("節の中で重複なし。同じ生の値は節が違っても同じ token。token の形", () => {
    for (const section of Object.keys(SECTION_COUNTS) as ReasonSection[]) {
      const raws = manifestOf(section).map((e) => e.raw);
      expect(new Set(raws).size, section).toBe(raws.length);
    }
    const tokenOf = new Map<string, string>();
    for (const e of REASON_MANIFEST) {
      const seen = tokenOf.get(e.raw);
      if (seen !== undefined) expect(e.token, e.raw).toBe(seen);
      tokenOf.set(e.raw, e.token);
      expect(e.token).toMatch(/^[a-z][a-z0-9_]{0,95}$/);
      expect(["absent", "malformed", "unrecognized"]).not.toContain(e.token);
      // snake_case の値は生の値と同じ token、文の形だけ sdk_…
      if (/^[a-z][a-z0-9_]*$/.test(e.raw)) expect(e.token).toBe(e.raw);
      else expect(e.token.startsWith("sdk_"), e.raw).toBe(true);
    }
    expect(REASON_TABLE.size).toBe(tokenOf.size);
  });

  test("文の形の SDK の値（core の 4 つ）", () => {
    expect(classifyReason("No matching payment requirements")).toBe("sdk_no_matching_requirements");
    expect(classifyReason("Settlement failed")).toBe("sdk_settlement_failed");
    expect(classifyReason("Payment required")).toBe("sdk_payment_required");
    expect(classifyReason("Payment verification failed")).toBe("sdk_payment_verification_failed");
    expect(classifyReason("No matching payment requirements.")).toBe("unrecognized");
  });

  test("表の全部の値が自分の token に分類される", () => {
    for (const e of REASON_MANIFEST) expect(classifyReason(e.raw)).toBe(e.token);
  });
});

describe("(3)(4) 抜き出した値は manifest か明示の除外にある", () => {
  test.each(Object.keys(SDK_PACKAGES) as SdkSection[])("%s", (section) => {
    const found = sdkLiterals(section);
    const listed = new Set([...manifestOf(section), ...exclusionsOf(section)].map((e) => e.raw));
    const missing = [...found].filter(([raw]) => !listed.has(raw)).map(([raw, at]) => `${raw} @ ${at}`);
    expect(missing).toEqual([]);
    // 除外は manifest と重ならない
    const inManifest = new Set<string>(manifestOf(section).map((e) => e.raw));
    for (const x of exclusionsOf(section)) expect(inManifest.has(x.raw), `${section} ${x.raw}`).toBe(false);
  });

  test.each(REPO_RULES.map((r) => [r.section, r] as const))("%s", (_section, rule) => {
    const found = repoLiterals(rule);
    const listed = new Set([...manifestOf(rule.section), ...exclusionsOf(rule.section)].map((e) => e.raw));
    const missing = [...found].filter(([raw]) => !listed.has(raw)).map(([raw, at]) => `${raw} @ ${at}`);
    expect(missing).toEqual([]);
  });

  test("除外の各値は記録した行に現れる（古い除外を残さない）", () => {
    for (const x of REASON_EXCLUSIONS) {
      const line = read(sourcePathOf(x.section, x.source.file)).split("\n")[x.source.line - 1];
      expect(line?.includes(`"${x.raw}"`), `${x.section} ${x.raw} @ ${x.source.file}:${x.source.line}`).toBe(true);
    }
  });

  test("self_facilitator・provider_worker の値はそれぞれのファイルの中にある", () => {
    for (const e of manifestOf("self_facilitator")) expect(e.source.file).toBe("tools/evm-facilitator.ts");
    for (const e of manifestOf("provider_worker")) expect(e.source.file.startsWith("providers/x402-workers/src/"), e.raw).toBe(true);
    for (const e of manifestOf("circle")) expect(["src/adapters/inbound/x402.ts", "docs/multirail-design.md"].includes(e.source.file), e.raw).toBe(true);
  });
});
