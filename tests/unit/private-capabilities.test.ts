/**
 * 増分 v1.5（proxy 型）T-X2: 能力の門（`docs/zktls-router-proxy-design.md` §3、要件 FR-X14・LX-6）。
 * `readCapabilities` は試験が一時ディレクトリに 1 つずつ書く小さな実行ファイルで試す（Router は子に最小の env しか渡さないので、env では切り替えない）。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { CAPABILITIES_MAX_BYTES, parseCapabilities, readCapabilities } from "../../src/private/verifier.js";

const FAKE = path.resolve(import.meta.dirname, "../fixtures/private/fake-delivery.mjs");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function script(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "caps-"));
  dirs.push(dir);
  const file = path.join(dir, "delivery");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("parseCapabilities（厳密な形）", () => {
  test.each<[string, string, readonly string[] | undefined]>([
    ["両方", '{"tls_modes":["mpc","proxy"]}', ["mpc", "proxy"]],
    ["MPC だけ", '{"tls_modes":["mpc"]}', ["mpc"]],
    ["空の配列", '{"tls_modes":[]}', []],
    ["他のキー", '{"tls_modes":["proxy"],"x":1}', undefined],
    ["未知の型", '{"tls_modes":["proxy","quic"]}', undefined],
    ["重複", '{"tls_modes":["proxy","proxy"]}', undefined],
    ["文字列でない要素", '{"tls_modes":[1]}', undefined],
    ["配列でない", '{"tls_modes":"proxy"}', undefined],
    ["キーの名前違い", '{"modes":["proxy"]}', undefined],
    ["配列そのもの", '["proxy"]', undefined],
    ["JSON でない", "proxy", undefined],
    ["空", "", undefined],
  ])("%s", (_name, text, expected) => {
    const parsed = parseCapabilities(text);
    if (expected === undefined) expect(parsed).toBeUndefined();
    else expect(parsed?.tlsModes).toEqual(expected);
  });
});

describe("readCapabilities（子プロセス）", () => {
  test("偽の delivery は両方の型を宣言する", async () => {
    expect((await readCapabilities(FAKE))?.tlsModes).toEqual(["mpc", "proxy"]);
  });
  test("引数は capabilities の 1 つだけ、env は PATH だけ", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "caps-args-"));
    dirs.push(dir);
    const out = path.join(dir, "seen");
    const bin = script(`printf '%s|' "$@" > ${JSON.stringify(out)}; env | cut -d= -f1 | sort | tr '\\n' ',' >> ${JSON.stringify(out)}; printf '{"tls_modes":["proxy"]}'`);
    expect((await readCapabilities(bin))?.tlsModes).toEqual(["proxy"]);
    const { readFileSync } = await import("node:fs");
    const seen = readFileSync(out, "utf8");
    expect(seen.startsWith("capabilities|")).toBe(true);
    const keys = seen.slice("capabilities|".length).split(",").filter((key) => key !== "" && key !== "PWD" && key !== "SHLVL" && key !== "_" && key !== "OLDPWD");
    expect(keys).toEqual(["PATH"]);
  });
  test.each<[string, string]>([
    ["非 0 で終わる", `printf '{"tls_modes":["proxy"]}'; exit 3`],
    ["形違い", `printf '{"tls_modes":["proxy"],"extra":true}'`],
    ["上限を超える出力", `printf '{"tls_modes":["proxy"]}'; head -c ${String(CAPABILITIES_MAX_BYTES)} /dev/zero`],
    ["今の lab のように capabilities を知らない", `echo "unknown subcommand $1" >&2; exit 2`],
    ["signal で終わる", `kill -9 $$`],
  ])("undefined: %s", async (_name, body) => {
    expect(await readCapabilities(script(body))).toBeUndefined();
  });
  test("stderr が大量でも stdout が正しければ読める（stderr は捨てる）", async () => {
    expect((await readCapabilities(script(`head -c 100000 /dev/zero >&2; printf '{"tls_modes":["mpc","proxy"]}'`)))?.tlsModes).toEqual(["mpc", "proxy"]);
  });
  test("期限で止める", async () => {
    const started = Date.now();
    expect(await readCapabilities(script("sleep 5"), { timeoutMs: 200 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
  test("期限で止めるとき、孫プロセスまで止める（stdout を握ったまま残らない）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "caps-grand-"));
    dirs.push(dir);
    const pidFile = path.join(dir, "grandchild.pid");
    // 負荷の下でもシェルが pid を書き終える余裕のある期限（孫は 30 s 眠るので、期限で止めない限り残る）。
    expect(await readCapabilities(script(`sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`), { timeoutMs: 1_500 })).toBeUndefined();
    const { readFileSync } = await import("node:fs");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    // SIGKILL はグループに届いている。回収まで待って生存を確かめる（ESRCH = 居ない。最大 5 s）。
    const until = Date.now() + 5_000;
    let alive = true;
    while (alive && Date.now() < until) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    }
    expect(alive).toBe(false);
  });
  test("起動できないパス", async () => {
    expect(await readCapabilities("/nonexistent/delivery")).toBeUndefined();
  });
});
