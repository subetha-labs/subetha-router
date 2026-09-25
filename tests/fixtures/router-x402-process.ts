/**
 * **実 main composition**（`src/main.ts` の `startRouter`）を別プロセスで起動する fixture。
 * 差し替えるのは署名能力 1 点だけで、config 読み込み・adapter 合成・journal ロック・HTTP listen
 * はすべて製品コードの経路をそのまま通る（`ROUTER_ADAPTER_MODE=real`）。
 *
 * 注入するのは**署名しない** spy（鍵なし・実署名なし・実決済なし）。製品コードにはこの spy を
 * 置かず、構成ファイルや env からも読み込めない（任意のプラグイン読み込みをしない）。
 */

import { reportStartupFailure, startRouter } from "../../src/main.js";
import { createSignerSpy } from "./x402-signer-spy.js";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const network = arg("network", "eip155:84532");

startRouter({ evmSigning: createSignerSpy().capability(network) }).catch(reportStartupFailure);
