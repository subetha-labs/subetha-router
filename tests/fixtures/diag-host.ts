/**
 * 試験用の入口（AC-R4、タスク R-2）。**製品コードではない。**
 * 受け入れ用の起動 `tools/rails-acceptance-run.ts` と同じ `acceptanceOptionsOf`・`startHost`（同じ計画 `hostPlanOf`・同じ子の env・同じ MCP の入口）で動かし、
 * 違いは Router の子の script（`tests/fixtures/router-diag-child.ts`）と、子に足す試験の env（`SUBETHA_TEST_SYNTHETIC_CONFIG`。計画の env を上書きしない）だけ。
 * 起動したら stdout に 1 行（listening・port・自分の pid）を書く。
 */
import { acceptanceOptionsOf } from "../../tools/rails-acceptance-run.js";
import { startHost } from "../../tools/remote-mcp.js";

const options = acceptanceOptionsOf(process.env, process.argv.slice(2));
const host = await startHost(options, {
  childScriptForTest: "tests/fixtures/router-diag-child.ts",
  childEnvExtraForTest: { SUBETHA_TEST_SYNTHETIC_CONFIG: process.env["SUBETHA_TEST_SYNTHETIC_CONFIG"] ?? "" },
});
process.stdout.write(`${JSON.stringify({ event: "listening", port: host.mcpPort, routerPort: host.routerPort, pid: process.pid })}\n`);
