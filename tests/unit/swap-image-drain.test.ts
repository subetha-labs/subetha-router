/**
 * `deploy/swap-image.sh` の入れ替えの前の静止（`docs/rejection-reasons-design.md` §13.3・§14.4・§15.2・§15.3、タスク R-0）を、偽の docker で実際に走らせて確かめる
 * （harness は `tests/fixtures/swap-image-harness.ts`）。
 * - 古いコンテナの stop だけ `docker stop -t 315` を外側の上限 345 秒で包む（ほかの変更操作は 30 秒のまま）
 * - 停止が確定した後、今回の停止の log（停止の直前の時刻から）に `drain: complete` が無ければ入れ替えをやめ、旧コンテナを戻して exit 1
 * - 停止の操作が未確定なら、後で /healthz が戻っても exit 2。復旧を確かめられなければ exit 2
 */
import { readFileSync, rmSync } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { hasTimeout, runSwap as runSwapIn } from "../fixtures/swap-image-harness.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const runSwap = (scenario: string, timeoutMs?: number) => runSwapIn(scenario, dirs, timeoutMs);
const OLD_RESTORED = { oldid0001: "subetha-router true subetha-router:b-old 127.0.0.1:8787:8787" };

describe("swap-image.sh: 古いコンテナの停止と静止の確認（R-0）", () => {
  test("静的: 古いコンテナの stop は -t STOP_GRACE_S を STOP_BOUND_S で包む。値は 315 / 345、STOP_SETTLE_S 345。ほかの変更操作は 30 秒の mutate", () => {
    const script = readFileSync("deploy/swap-image.sh", "utf8");
    expect(script).toMatch(/^STOP_GRACE_S=315 /m);
    expect(script).toMatch(/^STOP_BOUND_S=345 /m);
    expect(script).toMatch(/^STOP_SETTLE_S=345 /m);
    const stops = script.split("\n").filter((line) => /^\s*mutate(_within)? \S+ stop\b|^\s*mutate(_within)? "\$STOP_BOUND_S" stop\b/.test(line));
    expect(stops).toEqual(['mutate_within "$STOP_BOUND_S" stop stop -t "$STOP_GRACE_S" "$OLD_ID" >/dev/null']);
    expect(script.split("\n").filter((line) => /^mutate_within /.test(line))).toHaveLength(1);
    expect(script).toMatch(/^mutate\(\) \{ mutate_within 30 "\$@"; \}$/m);
    // 時刻は stop の直前の行で記録し、log はその時刻から読む。
    const lines = script.split("\n");
    const stopLine = lines.findIndex((line) => line.startsWith('mutate_within "$STOP_BOUND_S" stop'));
    expect(lines[stopLine - 1]).toBe("STOP_SINCE=$(date -u +%s)");
    expect(script).toContain('logs --since "$STOP_SINCE" "$OLD_ID"');
    expect(script).toContain("grep -qx 'drain: complete'");
  });

  test.skipIf(!hasTimeout)("drain の成功: 今回の停止の log に drain: complete → 入れ替えは swap ok（exit 0）。stop は timeout -k 5 345 docker stop -t 315", () => {
    const { result, calls } = runSwap("ok");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/previous container drained/);
    expect(result.stdout).toMatch(/swap ok: subetha-router = subetha-router:b-new/);
    expect(calls).toContain("timeout -k 5 345 docker stop -t 315 oldid0001");
    expect(calls).toContain("docker stop -t 315 oldid0001");
    // log は stop の直前の時刻から（unix 秒）。
    expect(calls.some((c) => /^docker logs --since [0-9]+ oldid0001$/.test(c))).toBe(true);
    // ほかの変更操作は 30 秒のまま。
    expect(calls.some((c) => /^timeout -k 5 30 docker rename oldid0001 subetha-router-prev-/.test(c))).toBe(true);
    expect(calls.some((c) => /^timeout -k 5 30 docker run /.test(c))).toBe(true);
  }, 90_000);

  test.skipIf(!hasTimeout).each([
    ["drain の時間切れ（drain: timeout）", "drain_timeout"],
    ["drain の行が無い（SIGKILL・古いイメージ）", "no_drain_line"],
    ["古い log にだけ drain: complete（今回の停止には無い）", "old_drain_only"],
  ])("%s → 新しいコンテナを作らず、旧コンテナを元の名前で戻して入口を開け直し exit 1", (_name, scenario) => {
    const { result, containers, calls, caddy } = runSwap(scenario);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/did not report 'drain: complete' for this stop \(not quiescent\): not swapping/);
    expect(result.stderr).toMatch(/restored: subetha-router = oldid0001, ingress reopened/);
    expect(result.stderr).not.toMatch(/STATE UNKNOWN/);
    expect(result.stdout).not.toMatch(/previous container drained|swap ok/);
    expect(calls.filter((c) => c.startsWith("docker run "))).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith("docker rename "))).toHaveLength(0);
    expect(calls).toContain("docker start oldid0001");
    expect(containers).toEqual(OLD_RESTORED);
    expect(caddy).toBe("active");
    // log の中身は出さない。
    expect(result.stdout + result.stderr).not.toMatch(/^drain: /m);
  }, 90_000);

  test.skipIf(!hasTimeout)("stop が外側の上限 345 秒に当たる（未確定）→ その後に旧コンテナの /healthz が戻っても exit 2（状態不明）。静止の確認には進まない", () => {
    const { result, containers, calls } = runSwap("stop_bound");
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/docker stop failed \(rc=124\): its outcome is unconfirmed/);
    expect(result.stderr).toMatch(/a docker 'stop' was submitted and did not confirm success/);
    expect(result.stderr).toMatch(/previous container answers \/healthz as subetha-router/);
    expect(result.stderr).toMatch(/STATE UNKNOWN/);
    expect(result.stderr).not.toMatch(/restored: /);
    expect(calls.some((c) => c.startsWith("docker logs --since"))).toBe(false);
    expect(calls.filter((c) => c.startsWith("docker run "))).toHaveLength(0);
    expect(containers).toEqual(OLD_RESTORED);
  }, 90_000);

  test.skipIf(!hasTimeout)("静止できず、復旧の旧コンテナの start が失敗（復旧を確かめられない）→ exit 2", () => {
    const { result, calls } = runSwap("restore_unconfirmed", 150_000);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/did not report 'drain: complete' for this stop/);
    expect(result.stderr).toMatch(/could not start the previous container oldid0001/);
    expect(result.stderr).toMatch(/STATE UNKNOWN/);
    expect(result.stderr).not.toMatch(/restored: /);
    expect(calls.filter((c) => c.startsWith("docker run "))).toHaveLength(0);
  }, 180_000);
});
