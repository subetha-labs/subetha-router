/**
 * Verifier ランナー（設計 §4、T-Z4a）: 起動手順（起動門 → wrapper は pid 公開 → 門の確認 → exec）、serve は新しい addr を待ち verify は待たない、
 * 監督（kill と exit の待ち、timeout）、出力の上限と 0600、棚卸し（門の取り消し・pid の同一性・確認できない pid）。偽バイナリ（`fake-delivery.mjs`）で実プロセスを起動する。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createVerifierRunner, GATE_FILE, PID_FILE, wrapperOf, sha256File, type VerifierRunner } from "../../src/private/verifier.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const FAKE = path.resolve(import.meta.dirname, "../fixtures/private/fake-delivery.mjs");
const dirs: string[] = [];
const runners: VerifierRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.closeAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 偽バイナリの制御（env ではなく作業ディレクトリのファイル。Router は子に最小の env しか渡さない）。 */
function control(dir: string, value: Record<string, unknown>): void {
  writeFileSync(path.join(dir, "fake-control.json"), JSON.stringify(value));
}

function workDir(): string {
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = mkdtempSync(path.join(runtimeRoot, "private-verifier-"));
  dirs.push(dir);
  return dir;
}

function purchaseDir(work: string, paymentId = "pay-1"): { dir: string; order: string; intent: string; release: string; bundle: string } {
  const dir = path.join(work, paymentId);
  mkdirSync(dir, { mode: 0o700 });
  const order = path.join(dir, "order_final.json");
  const intent = path.join(dir, "intent.json");
  const release = path.join(dir, "release.json");
  const bundle = path.join(dir, "bundle.json");
  for (const file of [order, intent, release, bundle]) writeFileSync(file, "{}", { mode: 0o600 });
  return { dir, order, intent, release, bundle };
}

function runner(extra: Partial<Parameters<typeof createVerifierRunner>[0]> = {}): VerifierRunner {
  const created = createVerifierRunner({ deliveryBin: FAKE, srsPath: "/nonexistent/srs.dat", trust: "lab-fixture-ca", maxChildOutputBytes: 1024, ...extra });
  runners.push(created);
  return created;
}

describe("wrapper", () => {
  test("本番の wrapper は固定文字列で、pid の公開 → 門の確認 → exec の順。hook があるときだけ各段に到着と待ちが入る", () => {
    expect(wrapperOf()).toBe('umask 077 && printf %s "$$" > "$PIDFILE.tmp" && mv -f "$PIDFILE.tmp" "$PIDFILE" && [ -e "$GATE" ] && exec "$0" "$@"');
    const hooked = wrapperOf({ stages: { afterPid: { arrive: "/a", release: "/r" } } });
    expect(hooked.indexOf('"$PIDFILE"')).toBeLessThan(hooked.indexOf("ARRIVE_AFTERPID"));
    expect(hooked.indexOf("ARRIVE_AFTERPID")).toBeLessThan(hooked.indexOf('[ -e "$GATE" ]'));
  });
});

describe("serve", () => {
  test("起動門 → pid（spawn の pid と一致） → 新しい addr を待ち、record は 0600 で生まれ、終了で pid と門が片付く", async () => {
    const work = workDir();
    const p = purchaseDir(work);
    control(p.dir, { mode: "record", delayMs: 150 });
    const r = runner();
    const served = await r.serve({ dir: p.dir, orderPath: p.order, intentPath: p.intent, releasePath: p.release, host: "test-server.io", path: "/select", timeoutSecs: 5, readyByMs: Date.now() + 5_000 });
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    expect(served.address).toBe("127.0.0.1:40001");
    expect(readFileSync(path.join(p.dir, PID_FILE.serve), "utf8").trim()).toBe(String(served.child.pid));
    expect(existsSync(path.join(p.dir, GATE_FILE.serve))).toBe(true);
    const exit = await served.child.exited;
    const stderr = existsSync(path.join(p.dir, "serve.stderr.log")) ? readFileSync(path.join(p.dir, "serve.stderr.log"), "utf8") : "(no stderr log)";
    expect(exit.code, `fake exited ${String(exit.code)}/${String(exit.signal)}: ${stderr}`).toBe(0);
    const args = JSON.parse(readFileSync(path.join(p.dir, "fake-args.verifier-serve.json"), "utf8")) as { kv: Record<string, string>; env: Record<string, string>; pid: number };
    expect(args.pid).toBe(served.child.pid);
    expect(args.kv).toMatchObject({ "verifier-dir": p.dir, order: p.order, listen: "127.0.0.1:0", "expect-host": "test-server.io", "expect-port": "443", "expect-path": "/select", trust: "lab-fixture-ca", "timeout-secs": "5", intent: p.intent, release: p.release });
    expect(args.env).toMatchObject({ DELIVERY_SRS_DAT: "/nonexistent/srs.dat", RUST_LOG: "info", umask: "77" });
    // 子の env は最小（PATH・DELIVERY_SRS_DAT・RUST_LOG・PIDFILE・GATE だけ。親の秘密は渡さない）。
    expect((args.env as unknown as { keys: string[] }).keys.filter((key) => !["PATH", "DELIVERY_SRS_DAT", "RUST_LOG", "PIDFILE", "GATE", "PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"].includes(key))).toEqual([]);
    // umask 077: バイナリが 0644 で作るファイルは 0600。
    expect(statSync(path.join(p.dir, "record.json")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(p.dir, "serve.stdout.log")).mode & 0o777).toBe(0o600);
    // 終了の後は pid ファイルと起動門が無い。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(path.join(p.dir, PID_FILE.serve))).toBe(false);
    expect(existsSync(path.join(p.dir, GATE_FILE.serve))).toBe(false);
  });
  test("古い addr-file や record.json があれば起動しない。期限が無ければ expired。addr の前に死ねば launch_failed", async () => {
    const work = workDir();
    const p = purchaseDir(work);
    const r = runner();
    const base = { dir: p.dir, orderPath: p.order, intentPath: p.intent, releasePath: p.release, host: "test-server.io", path: "/select", timeoutSecs: 5 };
    writeFileSync(path.join(p.dir, "verifier.addr"), "127.0.0.1:1");
    expect(await r.serve({ ...base, readyByMs: Date.now() + 1_000 })).toEqual({ ok: false, reason: "launch_failed" });
    rmSync(path.join(p.dir, "verifier.addr"));
    expect(await r.serve({ ...base, readyByMs: Date.now() - 1 })).toEqual({ ok: false, reason: "expired" });
    expect(await r.serve({ ...base, timeoutSecs: 0, readyByMs: Date.now() + 1_000 })).toEqual({ ok: false, reason: "expired" });
    control(p.dir, { mode: "fail-before-addr" });
    expect(await r.serve({ ...base, readyByMs: Date.now() + 2_000 })).toEqual({ ok: false, reason: "launch_failed" });
  });
  test("監督: 止まった子は kill() で SIGTERM → exit を待つ。stderr は上限で切れる", async () => {
    const work = workDir();
    const p = purchaseDir(work);
    control(p.dir, { mode: "hang", spamBytes: 5000 });
    const r = runner();
    const served = await r.serve({ dir: p.dir, orderPath: p.order, intentPath: p.intent, releasePath: p.release, host: "test-server.io", path: "/select", timeoutSecs: 5, readyByMs: Date.now() + 5_000 });
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await served.child.kill(500);
    const exit = await served.child.exited;
    expect(exit.signal === "SIGTERM" || exit.signal === "SIGKILL" || exit.code !== null).toBe(true);
    expect(statSync(path.join(p.dir, "serve.stderr.log")).size).toBeLessThanOrEqual(1024);
  });
});

describe("fd を漏らさない", () => {
  test("起動を繰り返しても開いている fd の数は増えない", async () => {
    const work = workDir();
    const r = runner();
    const countFds = (): number => readdirSync("/dev/fd").length;
    const warm = async (): Promise<void> => {
      const p = purchaseDir(work, `pay-warm-${Math.random().toString(16).slice(2)}`);
      control(p.dir, { mode: "record", delayMs: 20 });
      const served = await r.serve({ dir: p.dir, orderPath: p.order, intentPath: p.intent, releasePath: p.release, host: "test-server.io", path: "/select", timeoutSecs: 5, readyByMs: Date.now() + 5_000 });
      if (served.ok) await served.child.exited;
    };
    await warm();
    await warm();
    const before = countFds();
    for (let i = 0; i < 6; i += 1) await warm();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(countFds()).toBeLessThanOrEqual(before + 1);
  }, 20_000);
});

describe("verify", () => {
  test("verify は addr を見ず完了を待ち、verify_result.json を上限つきで読む。timeout は kill", async () => {
    const work = workDir();
    const p = purchaseDir(work);
    writeFileSync(path.join(p.dir, "verifier.addr"), "127.0.0.1:40001"); // serve の残り: verify はこれを見ない
    control(p.dir, { mode: "record" });
    const r = runner();
    const base = { dir: p.dir, orderPath: p.order, bundlePath: p.bundle, intentPath: p.intent, releasePath: p.release, host: "test-server.io", path: "/select", timeoutMs: 5_000, requireExternalGate: false };
    const verified = await r.verify(base);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.result).toMatchObject({ ok: true, checks: ["UltraHonk delivery proof verified", "request-binding proof verified"] });
    const args = JSON.parse(readFileSync(path.join(p.dir, "fake-args.verifier-verify.json"), "utf8")) as { kv: Record<string, string>; flags: string[] };
    expect(args.kv).toMatchObject({ bundle: p.bundle, "expect-port": "443" });
    expect(args.flags).toEqual([]);
    control(p.dir, { mode: "verify-fail" });
    const failed = await r.verify({ ...base, requireExternalGate: true });
    expect(failed.ok).toBe(true);
    if (failed.ok) expect(failed.result).toMatchObject({ ok: false });
    expect((JSON.parse(readFileSync(path.join(p.dir, "fake-args.verifier-verify.json"), "utf8")) as { flags: string[] }).flags).toEqual(["--require-external-gate"]);
    control(p.dir, { mode: "hang" });
    const timedOut = await r.verify({ ...base, timeoutMs: 400 });
    expect(timedOut).toEqual({ ok: false, reason: "timeout" });
    expect(existsSync(path.join(p.dir, PID_FILE.verify))).toBe(false);
  });
});

describe("棚卸し（inventory）", () => {
  test("起動門を外すと、門の確認の前で止まっていた wrapper は exec しない", async () => {
    const work = workDir();
    const p = purchaseDir(work);
    const arrive = path.join(work, "arrive");
    const release = path.join(work, "release");
    control(p.dir, { mode: "record" });
    const r = runner({ launchHooksForTest: { stages: { afterPid: { arrive, release } } } });
    const pending = r.serve({ dir: p.dir, orderPath: p.order, intentPath: p.intent, releasePath: p.release, host: "test-server.io", path: "/select", timeoutSecs: 5, readyByMs: Date.now() + 3_000 });
    // wrapper が pid を公開して止まるまで待つ。
    while (!existsSync(arrive)) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(path.join(p.dir, PID_FILE.serve))).toBe(true);
    // 「前世代」として棚卸し: 門を外し、公開済みの pid を終了させる。
    const other = runner();
    const inventory = await other.inventory(work);
    expect(inventory).toEqual({ ok: true, terminated: 1 });
    expect(existsSync(path.join(p.dir, `${GATE_FILE.serve}.cancelled`))).toBe(true);
    writeFileSync(release, "1");
    const served = await pending;
    expect(served.ok).toBe(false);
    // バイナリは実行されていない（引数の記録が無い）。
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(path.join(p.dir, "fake-args.verifier-serve.json"))).toBe(false);
    expect(existsSync(path.join(p.dir, "record.json"))).toBe(false);
  });
  test("門を確認した後で止まっていた wrapper も、公開済みの pid で見つかって終了させられる", async () => {
    const work = workDir();
    const p = purchaseDir(work);
    const arrive = path.join(work, "arrive");
    const release = path.join(work, "release");
    control(p.dir, { mode: "record" });
    const r = runner({ launchHooksForTest: { stages: { afterGate: { arrive, release } } } });
    const pending = r.serve({ dir: p.dir, orderPath: p.order, intentPath: p.intent, releasePath: p.release, host: "test-server.io", path: "/select", timeoutSecs: 5, readyByMs: Date.now() + 3_000 });
    while (!existsSync(arrive)) await new Promise((resolve) => setTimeout(resolve, 20));
    const other = runner();
    expect(await other.inventory(work)).toEqual({ ok: true, terminated: 1 });
    writeFileSync(release, "1");
    const served = await pending;
    expect(served.ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(path.join(p.dir, "record.json"))).toBe(false);
  });
  test("pid が tmp のまま・壊れている・命令行が読めなければ確認できない。別のプロセス（再利用）は触らずファイルだけ消す。死んだ pid は消す", async () => {
    const work = workDir();
    const p = purchaseDir(work);
    writeFileSync(path.join(p.dir, `${PID_FILE.serve}.tmp`), "123");
    expect(await runner().inventory(work)).toEqual({ ok: false, reason: "unverifiable_pid" });
    rmSync(path.join(p.dir, `${PID_FILE.serve}.tmp`));
    writeFileSync(path.join(p.dir, PID_FILE.serve), "not-a-pid");
    expect(await runner().inventory(work)).toEqual({ ok: false, reason: "unverifiable_pid" });
    // 生きている別のプロセス（このテストプロセスの親など）: 命令行が deliveryBin を含まない → 自分の子ではない → ファイルだけ消す。
    writeFileSync(path.join(p.dir, PID_FILE.serve), String(process.ppid));
    expect(await runner({ commandLineOfForTest: async () => "/usr/bin/something-else" }).inventory(work)).toEqual({ ok: true, terminated: 0 });
    expect(existsSync(path.join(p.dir, PID_FILE.serve))).toBe(false);
    writeFileSync(path.join(p.dir, PID_FILE.serve), String(process.ppid));
    expect(await runner({ commandLineOfForTest: async () => undefined }).inventory(work)).toEqual({ ok: false, reason: "unverifiable_pid" });
    // 死んだ pid（2^22 近辺の大きな値は普通使われていない）
    writeFileSync(path.join(p.dir, PID_FILE.serve), "4194000");
    expect(await runner().inventory(work)).toEqual({ ok: true, terminated: 0 });
    expect(existsSync(path.join(p.dir, PID_FILE.serve))).toBe(false);
  });
  test("deliveryBinSha256 はバイナリの sha256", () => {
    expect(runner().deliveryBinSha256).toBe(sha256File(FAKE));
  });
});
