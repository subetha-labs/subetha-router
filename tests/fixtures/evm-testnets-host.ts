/**
 * 試験用の EVM testnet の入口（タスク E-4、AC-E5）。**製品コードではない。**
 * 本番の入口 `tools/evm-testnets-run.ts` と同じ `evmTestnetsOptionsOf`・`startHost`（同じ計画 `hostPlanOf` の分岐・同じ子の env）で起動し、
 * 子の script だけを `tests/fixtures/router-evm-testnets-process.ts`（同じ能力の組み立て＋公開のホスト名への transport の差し替え）にする。
 * 子に渡る env は計画のものだけ（`startListening` の allowlist）なので、差し替えの対応表と CA は `SUBETHA_TEST_*` を計画の外から渡せない。
 * そこで、この入口は自分の env の `SUBETHA_TEST_DIAL_MAP`・`SUBETHA_TEST_CA_PATH` を `childEnvExtraForTest` で足す（試験専用の口）。
 */
import { evmTestnetsAnnouncementOf, evmTestnetsOptionsOf } from "../../tools/evm-testnets-run.js";
import { startHost } from "../../tools/remote-mcp.js";

const options = evmTestnetsOptionsOf(process.env, process.argv.slice(2));
const host = await startHost(options, {
  childScriptForTest: "tests/fixtures/router-evm-testnets-process.ts",
  childEnvExtraForTest: { SUBETHA_TEST_DIAL_MAP: process.env["SUBETHA_TEST_DIAL_MAP"] ?? "", SUBETHA_TEST_CA_PATH: process.env["SUBETHA_TEST_CA_PATH"] ?? "" },
});
process.stdout.write(`${evmTestnetsAnnouncementOf(host, options.evmTestnets.chains)}\n`);
