/**
 * 実 `src/main.ts` を**実鍵の署名能力**で起動する。**製品コードではない。**
 * 鍵は env から**このツールが**受け取り、能力としてコードから注入する
 * （`src/**` は env から鍵を読まない方針を維持）。
 */

import { reportStartupFailure, startRouter } from "../src/main.js";
import { TEST_NETWORKS } from "../tests/fixtures/known-networks.js";
import { createRealEvmCapability } from "./real-evm-capability.js";
import { createRealMppCapability } from "./real-mpp-capability.js";

const key = process.env["T7_PAYER_PRIVATE_KEY"];
if (key === undefined || key === "") {
  process.stderr.write("T7_PAYER_PRIVATE_KEY is required\n");
  process.exit(2);
}
const isB = process.argv.includes("--rail") && process.argv[process.argv.indexOf("--rail") + 1] === "b";
// ローカルの e2e 起動側（本番の入口ではない）。合成の資産（`eip155:11155111` の SOURCE_TOKEN 等）で起動するため試験の表を渡す。
startRouter(
  isB
    ? { mppTempo: createRealMppCapability(key).capability(), knownNetworksForTest: TEST_NETWORKS }
    : { evmSigning: createRealEvmCapability(key).capability("eip155:84532"), knownNetworksForTest: TEST_NETWORKS },
).catch(reportStartupFailure);
