/**
 * 試験用の入口（`docs/hosted-exact-enable-design.md` §13 の 5）。**製品コードではない。**
 * 本物の `startHost`（同じ計画 `hostPlanOf`・同じ ingress・同じ proxy の配線・同じ drain）を、`subethaExact` を有効にして loopback で起動する。違いは試験の口だけ:
 * - Router の子を `tests/fixtures/hosted-exact-child.ts` に（生成した設定から実証の route だけを残し、上流を fixture に向けてから、実 `startRouter` を起動する）
 * - 標準入口を買い手に示す基点（`HX_ORIGIN`）、drain の上限（`HX_DRAIN_TIMEOUT_MS`）、journal の場所（`HX_JOURNAL`）
 * 起動したら stdout に 1 行（listening・port・pid）を書く。
 */
import { RAILS_NONE } from "../../tools/remote-mcp-config.js";
import { startHost } from "../../tools/remote-mcp.js";

const env = process.env;
const host = await startHost(
  { activation: { ...RAILS_NONE, subethaExact: { inbound: true } }, bind: "127.0.0.1", port: 0, journalPath: env["HX_JOURNAL"] ?? "", x402EntryOriginForTest: env["HX_ORIGIN"] ?? "https://router.example.test" },
  {
    childScriptForTest: "tests/fixtures/hosted-exact-child.ts",
    childEnvExtraForTest: { HX_TEST_UPSTREAM: env["HX_TEST_UPSTREAM"] ?? "", ...(env["HX_MAX_COMMITTED"] === undefined ? {} : { HX_MAX_COMMITTED: env["HX_MAX_COMMITTED"] }) },
    ...(env["HX_DRAIN_TIMEOUT_MS"] === undefined ? {} : { drainTimeoutMsForTest: Number(env["HX_DRAIN_TIMEOUT_MS"]) }),
  },
);
process.stdout.write(`${JSON.stringify({ event: "listening", port: host.mcpPort, routerPort: host.routerPort, pid: process.pid })}\n`);
