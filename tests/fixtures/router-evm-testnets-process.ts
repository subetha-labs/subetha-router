/**
 * 試験用の Router の子 process（EVM testnet の**専用の子と同じ能力の組み立て**。タスク E-4、AC-E5）。**製品コードではない。**
 *
 * `tools/evm-testnets-router-process.ts` と同じ `evmTestnetsCapabilitiesOf(process.env)`（鍵・chain・`localCounterparties` は env から）に、
 * 静的の transport の差し替えだけを足して `startRouter` を呼ぶ: 公開のホスト名（Provider A `provider-x402.subethalabs.com`・x402.org）は
 * 公開アドレスに解決したことにして TCP の行き先だけを TLS の fixture に向け、`127.0.0.1` の literal はそのまま（差し替えない）。
 * 方針（loopback の許可は `localCounterparties` の配線だけが決める・origin の完全一致・redirect の拒否）は本番のまま。
 *
 * env: `SUBETHA_TEST_DIAL_MAP`（JSON `{ "<host>": <port> }`）、`SUBETHA_TEST_CA_PATH`（試験用 CA の PEM）。他は専用の子と同じ。
 */
import { readFileSync } from "node:fs";

import { reportStartupFailure, startRouter, type RouterCapabilities } from "../../src/main.js";
import { EvmTestnetsProcessError, evmTestnetsCapabilitiesOf } from "../../tools/evm-testnets-router-process.js";
import { dialTo, publicLookup } from "./dynamic/dial.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    process.stderr.write(`${name} is required\n`);
    process.exit(2);
  }
  return value;
}

let capabilities: RouterCapabilities;
try {
  capabilities = evmTestnetsCapabilitiesOf(process.env);
} catch (error) {
  process.stderr.write(`${error instanceof EvmTestnetsProcessError ? error.message : "router process capabilities could not be created"}\n`);
  process.exit(2);
}

const mapped = dialTo(JSON.parse(required("SUBETHA_TEST_DIAL_MAP")) as Record<string, number>);
const hooks = {
  interfaces: () => [],
  tls: { ca: [readFileSync(required("SUBETHA_TEST_CA_PATH"), "utf8")] },
  lookup: publicLookup(),
  // loopback の literal（allowlist の相手）は差し替えない。それ以外は表にある名前だけ（無ければ接続しない）。
  dialForTest: (target: { readonly hostname: string; readonly port: number }) => (target.hostname === "127.0.0.1" ? undefined : mapped(target)),
};

startRouter({ ...capabilities, transportHooksForTest: hooks }).catch(reportStartupFailure);
