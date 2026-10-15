/**
 * 試験用の入口（hosted 設計 §4、タスク H-4）。**製品コードではない。**
 * 受け入れ用の起動 `tools/rails-acceptance-run.ts` と同じ `acceptanceOptionsOf`・`startHost`（同じ計画 `hostPlanOf`・同じ facilitator の子の起動）で動かし、違いは試験の口だけ:
 * - facilitator の port（`SUBETHA_TEST_FACILITATOR_PORT`。固定の 8611 は並列の試験で衝突する）
 * - Router の子の script を偽の子 `tests/fixtures/router-env-child.ts` に（本物の子は起動時に外の RPC を読むので接続の無い試験では listen しない）
 * - facilitator の子の script を偽の `tests/fixtures/evm-facilitator-fake.ts` に（`SUBETHA_TEST_REAL_FACILITATOR=1` なら差し替えない: 本物の CLI）
 * - 子に足す試験の env（`SUBETHA_TEST_*`: pid・印のファイル、起動の遅れ、作業領域の書き込みの失敗。計画の env を上書きしない）
 * - drain の上限（`SUBETHA_TEST_DRAIN_TIMEOUT_MS`。空なら本番の `DRAIN_TIMEOUT_MS`。タスク R-0）、偽の Router の子・facilitator の SIGTERM の振る舞い（`SUBETHA_TEST_ROUTER_DRAIN`・`SUBETHA_TEST_FACILITATOR_DRAIN`）、
 *   止める順の記録（`SUBETHA_TEST_EVENT_LOG`。両方の子に渡す）
 * 起動したら stdout に 1 行（listening・各 port・自分の pid）を書く。
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { acceptanceOptionsOf } from "../../tools/rails-acceptance-run.js";
import { startHost } from "../../tools/remote-mcp.js";

const env = process.env;
const test = (name: string): string => env[name] ?? "";
/**
 * `SUBETHA_TEST_SPAWN_FAIL=<script の一部>`: その script の子の spawn を、存在しない実行ファイルで失敗させる（'error' ENOENT。EAGAIN などの spawn の失敗の代わり）。
 * `node:child_process` の `spawn` を包み、ESM の名前つきの export にも反映する（`tests/fixtures/loopback.ts` が import した `spawn` も同じものになる）。
 */
const spawnFail = test("SUBETHA_TEST_SPAWN_FAIL");
if (spawnFail !== "") {
  const original = childProcess.spawn;
  childProcess.spawn = ((command: string, args: readonly string[], options: object) =>
    args.some((arg) => arg.includes(spawnFail)) ? original("/nonexistent/h4-spawn-fail", args, options) : original(command, args, options)) as typeof childProcess.spawn;
  syncBuiltinESMExports();
}
const options = { ...acceptanceOptionsOf(env, process.argv.slice(2)), evmFacilitatorPortForTest: Number(test("SUBETHA_TEST_FACILITATOR_PORT")) };
const host = await startHost(options, {
  childScriptForTest: "tests/fixtures/router-env-child.ts",
  childEnvExtraForTest: { SUBETHA_TEST_ROUTER_DRAIN: test("SUBETHA_TEST_ROUTER_DRAIN"), SUBETHA_TEST_EVENT_LOG: test("SUBETHA_TEST_EVENT_LOG"), SUBETHA_TEST_ROUTER_MARK: test("SUBETHA_TEST_ROUTER_MARK"), SUBETHA_TEST_ROUTER_LISTEN_DELAY_MS: test("SUBETHA_TEST_ROUTER_LISTEN_DELAY_MS"), SUBETHA_TEST_ROUTER_BLOCK_EVIDENCE: test("SUBETHA_TEST_ROUTER_BLOCK_EVIDENCE") },
  ...(test("SUBETHA_TEST_DRAIN_TIMEOUT_MS") === "" ? {} : { drainTimeoutMsForTest: Number(test("SUBETHA_TEST_DRAIN_TIMEOUT_MS")) }),
  ...(test("SUBETHA_TEST_REAL_FACILITATOR") === "1" ? {} : { facilitatorScriptForTest: "tests/fixtures/evm-facilitator-fake.ts" }),
  facilitatorEnvExtraForTest: {
    SUBETHA_TEST_EVENT_LOG: test("SUBETHA_TEST_EVENT_LOG"),
    SUBETHA_TEST_FACILITATOR_DRAIN: test("SUBETHA_TEST_FACILITATOR_DRAIN"),
    SUBETHA_TEST_PID_FILE: test("SUBETHA_TEST_PID_FILE"),
    SUBETHA_TEST_FAKE_LISTEN_DELAY_MS: test("SUBETHA_TEST_FAKE_LISTEN_DELAY_MS"),
    SUBETHA_TEST_FAKE_SUPPORTED_DELAY_MS: test("SUBETHA_TEST_FAKE_SUPPORTED_DELAY_MS"),
    SUBETHA_TEST_SUPPORTED_HIT: test("SUBETHA_TEST_SUPPORTED_HIT"),
    ...(env["SUBETHA_TEST_FAKE_SUPPORTED"] === undefined ? {} : { SUBETHA_TEST_FAKE_SUPPORTED: test("SUBETHA_TEST_FAKE_SUPPORTED") }),
  },
});
process.stdout.write(`${JSON.stringify({ event: "listening", port: host.mcpPort, routerPort: host.routerPort, facilitatorPort: host.facilitatorPort ?? null, pid: process.pid })}\n`);
