/**
 * ホスト版 Router の起動プロセス。**製品コードではない**（実鍵を扱う起動側）。
 *
 * `tools/t7-router-process.ts` は**片方のレールだけ**（`--rail a|b`）を注入する。
 * ホスト版は**両方のレールで送信できる**必要があるので、ここで両方を注入する:
 *
 * - `evmSigning`  → x402 送信（Provider A / Base Sepolia USDC）
 * - `mppTempo`    → MPP 送信（Provider B / Tempo pathUSD）
 *
 * 鍵は env から**このツールが**受け取り、能力としてコードから注入する
 * （`src/**` は env から鍵を読まない方針を維持）。
 *
 * 片方の鍵しか無い構成でも起動できるようにする（その route を設定しなければよい）。
 * 能力が無いまま該当レールの route があると `src/main.ts` が fail closed で止める。
 */

import { reportStartupFailure, startRouter, type RouterCapabilities } from "../src/main.js";
import { createRealEvmCapability } from "./real-evm-capability.js";
import { createRealMppCapability } from "./real-mpp-capability.js";

/** x402 送信用の鍵。無ければ x402 送信 route を設定してはいけない。 */
const evmKey = process.env["SUBETHA_OUTBOUND_X402_KEY"];
/** MPP 送信用の鍵。無ければ MPP 送信 route を設定してはいけない。 */
const mppKey = process.env["SUBETHA_OUTBOUND_MPP_KEY"];

if ((evmKey === undefined || evmKey === "") && (mppKey === undefined || mppKey === "")) {
  process.stderr.write(
    "at least one of SUBETHA_OUTBOUND_X402_KEY / SUBETHA_OUTBOUND_MPP_KEY is required\n",
  );
  process.exit(2);
}

const capabilities: RouterCapabilities = {
  ...(evmKey === undefined || evmKey === ""
    ? {}
    : { evmSigning: createRealEvmCapability(evmKey).capability("eip155:84532") }),
  ...(mppKey === undefined || mppKey === ""
    ? {}
    : { mppTempo: createRealMppCapability(mppKey).capability() }),
};

startRouter(capabilities).catch(reportStartupFailure);
