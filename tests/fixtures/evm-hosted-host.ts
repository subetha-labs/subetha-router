/**
 * 試験用の入口（hosted 設計 §4、タスク H-4）。**製品コードではない。**
 * 受け入れ用の起動 `tools/rails-acceptance-run.ts` と同じ `acceptanceOptionsOf`・`startHost`（同じ計画 `hostPlanOf`・同じ facilitator の子の起動）で動かし、違いは試験の口だけ:
 * - facilitator の port（`SUBETHA_TEST_FACILITATOR_PORT`。固定の 8611 は並列の試験で衝突する）
 * - Router の子の script を偽の子 `tests/fixtures/router-env-child.ts` に（本物の子は起動時に外の RPC を読むので接続の無い試験では listen しない）
 * - facilitator の子の script を偽の `tests/fixtures/evm-facilitator-fake.ts` に（`SUBETHA_TEST_REAL_FACILITATOR=1` なら差し替えない: 本物の CLI）
 * - 子に足す試験の env（`SUBETHA_TEST_*`。計画の env を上書きしない）
 * 起動したら stdout に 1 行（listening・各 port・自分の pid）を書く。
 */
import { acceptanceOptionsOf } from "../../tools/rails-acceptance-run.js";
import { startHost } from "../../tools/remote-mcp.js";

const env = process.env;
const test = (name: string): string => env[name] ?? "";
const options = { ...acceptanceOptionsOf(env, process.argv.slice(2)), evmFacilitatorPortForTest: Number(test("SUBETHA_TEST_FACILITATOR_PORT")) };
const host = await startHost(options, {
  childScriptForTest: "tests/fixtures/router-env-child.ts",
  childEnvExtraForTest: { SUBETHA_TEST_ROUTER_MARK: test("SUBETHA_TEST_ROUTER_MARK") },
  ...(test("SUBETHA_TEST_REAL_FACILITATOR") === "1" ? {} : { facilitatorScriptForTest: "tests/fixtures/evm-facilitator-fake.ts" }),
  facilitatorEnvExtraForTest: {
    SUBETHA_TEST_PID_FILE: test("SUBETHA_TEST_PID_FILE"),
    ...(env["SUBETHA_TEST_FAKE_SUPPORTED"] === undefined ? {} : { SUBETHA_TEST_FAKE_SUPPORTED: test("SUBETHA_TEST_FAKE_SUPPORTED") }),
  },
});
process.stdout.write(`${JSON.stringify({ event: "listening", port: host.mcpPort, routerPort: host.routerPort, facilitatorPort: host.facilitatorPort ?? null, pid: process.pid })}\n`);
