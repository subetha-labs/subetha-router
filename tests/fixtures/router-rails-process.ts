/**
 * **実 main composition**（`src/main.ts` の `startRouter`）を別プロセスで起動する fixture。
 * 差し替えるのは支払い能力だけで、config 読み込み・adapter 合成（レール A / B の登録と
 * `routeId` による解決）・journal ロック・HTTP listen はすべて製品コードの経路を通る。
 *
 * 注入するのは**署名しない** spy（鍵なし・実 RPC なし・実 broadcast なし）。製品コードには
 * これらを置かず、構成ファイルや env からも読み込めない。
 *
 * usage: node --import tsx tests/fixtures/router-rails-process.ts [--rails a|b|ab]
 */

import { reportStartupFailure, startRouter, type RouterCapabilities } from "../../src/main.js";
import { createPayerSpy } from "./mpp-payer-spy.js";
import { TEST_NETWORKS } from "./known-networks.js";
import { createSignerSpy } from "./x402-signer-spy.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const rails = arg("rails", "ab");
const evmNetwork = arg("evm-network", "eip155:84532");

const capabilities: RouterCapabilities = {
  ...(rails === "b" ? {} : { evmSigning: createSignerSpy().capability(evmNetwork) }),
  ...(rails === "a" ? {} : { mppTempo: createPayerSpy().capability() }),
  // 受信 facilitator は loopback の fixture（SSRF 防御 A の fixture 例外を明示する）。
  fixtureFacilitators: true,
  // 表の外の合成の資産で起動するため（multirail 設計 §1 の注入路）。
  knownNetworksForTest: TEST_NETWORKS,
};

startRouter(capabilities).catch(reportStartupFailure);
