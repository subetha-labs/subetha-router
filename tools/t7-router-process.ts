/**
 * 実 `src/main.ts` を**実鍵の署名能力**で起動する。**製品コードではない。**
 * 鍵は env から**このツールが**受け取り、能力としてコードから注入する
 * （`src/**` は env から鍵を読まない方針を維持）。
 */

import { reportStartupFailure, startRouter } from "../src/main.js";
import { createRealEvmCapability } from "./real-evm-capability.js";
import { createRealMppCapability } from "./real-mpp-capability.js";

const key = process.env["T7_PAYER_PRIVATE_KEY"];
if (key === undefined || key === "") {
  process.stderr.write("T7_PAYER_PRIVATE_KEY is required\n");
  process.exit(2);
}
const isB = process.argv.includes("--rail") && process.argv[process.argv.indexOf("--rail") + 1] === "b";
startRouter(
  isB
    ? { mppTempo: createRealMppCapability(key).capability() }
    : { evmSigning: createRealEvmCapability(key).capability("eip155:84532") },
).catch(reportStartupFailure);
