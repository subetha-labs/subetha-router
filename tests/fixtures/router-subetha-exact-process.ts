/**
 * 試験用の Router の**子 process**（受信レール `subetha-exact`。`docs/subetha-exact-inbound-design.md` §4.6・§10、タスク T-5）。**製品コードではない。**
 * `startRouter` を、署名しない spy の送信能力・`fixtureFacilitators: true`（loopback の fixture）・試験の表・停止点の hook で起動する。
 * 設定・adapter の合成・journal の lock・HTTP の listen は製品コードの経路をそのまま通る（`ROUTER_ADAPTER_MODE=real`）。
 *
 * env（親が明示して渡す）:
 * - `ROUTER_*`: 通常の設定（`loadRuntimeConfig`）。`ROUTER_SUBETHA_EXACT_FACILITATOR_URL`・`ROUTER_SUBETHA_EXACT_TOKEN_FILE` を含む
 * - `SUBETHA_EXACT_STOP_AT`: `before_source_settle`／`after_source_settled`／`after_source_released`／`after_terminal`（core）、`after_release_remote`（adapter）の
 *   どれかなら、その停止点で**合図のファイルを書いて永遠に待つ**（応答バイトを出さない）→ 親は合図を待って SIGKILL → 再起動（停止点なし）
 * - `SUBETHA_EXACT_STOP_SIGNAL`: 合図のファイルのパス（`{"point":…,"id":…}` を書く）
 */
import { writeFileSync } from "node:fs";

import { reportStartupFailure, startRouter, type RouterCapabilities } from "../../src/main.js";
import { TEST_NETWORKS } from "./known-networks.js";
import { createSignerSpy } from "./x402-signer-spy.js";

const stopAt = process.env["SUBETHA_EXACT_STOP_AT"] ?? "";
const signalFile = process.env["SUBETHA_EXACT_STOP_SIGNAL"] ?? "";

/** 停止点: 合図を書いて永遠に待つ（この後の行は実行されない。親が SIGKILL する）。 */
async function stop(point: string, id: string): Promise<void> {
  if (stopAt !== point) return;
  if (signalFile !== "") writeFileSync(signalFile, JSON.stringify({ point, id }));
  await new Promise<never>(() => undefined);
}

const capabilities: RouterCapabilities = {
  evmSigning: createSignerSpy().capability("eip155:84532"),
  fixtureFacilitators: true,
  knownNetworksForTest: TEST_NETWORKS,
  coreHooksForTest: { stop: (point, paymentId) => stop(point, paymentId) },
  subethaExactHooksForTest: { stop: (point, orderId) => stop(point, orderId) },
};

startRouter(capabilities).catch(reportStartupFailure);
