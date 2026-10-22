/**
 * SubEtha V2 burn-sale 受信の結合試験用 Router プロセス（`docs/zktls-router-v2-inbound.md` §4・§11。**製品コードではない**。実鍵を扱う起動側）。
 *
 * `tools/remote-router-process.ts` と同じ実能力（`routerProcessCapabilitiesOf(env)`: 送信の鍵・診断）に、**試験専用の能力 `fixtureFacilitators: true` だけ**を足す:
 * SubEtha 受信の transport が loopback を許し、同一マシンで動く V2 facilitator（`ROUTER_SUBETHA_FACILITATOR_URL=http://127.0.0.1:<port>`）に
 * `/challenge → /verify → /settle` を叩ける。ほかは実合成のまま（送信 x402 は公開 DNS・公開 PKI・実 facilitator、秘匿配送の trust は mozilla）。
 * この起動で得た証跡は「受信 transport が synthetic（loopback 許可）」と記録する（owner の判断 2026-10-22、§4）。hosted には使わない。
 */

import { reportStartupFailure, startRouter, type RouterCapabilities } from "../src/main.js";
import { ProcessEntryError, routerProcessCapabilitiesOf } from "./rails-entry.js";
import { routerDiagnosticsSinkOf } from "./router-diagnostics.js";

let capabilities: RouterCapabilities;
try {
  capabilities = routerProcessCapabilitiesOf(process.env);
} catch (error) {
  const code = error instanceof ProcessEntryError ? error.code : undefined;
  process.stderr.write(code === "outbound_keys" ? "SUBETHA_OUTBOUND_X402_KEY is required\n" : "router process capabilities could not be created\n");
  process.exit(2);
}
const diagnostics = routerDiagnosticsSinkOf(process.env);
process.stderr.write("v2 joint router: subetha inbound transport allows loopback (fixtureFacilitators); everything else is the real composition\n");
startRouter({ ...capabilities, ...(diagnostics === undefined ? {} : { diagnostics }), fixtureFacilitators: true }).catch(reportStartupFailure);
