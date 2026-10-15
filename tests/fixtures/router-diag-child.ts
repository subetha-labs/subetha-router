/**
 * 試験用の Router の子（AC-R4、タスク R-2）。**製品コードではない。**
 * 入口（`startHost`）が計画どおりに渡した env をそのまま受け、診断の sink は本番の子（`tools/remote-router-process.ts`）と同じ
 * `routerDiagnosticsSinkOf(process.env)` で作る（`SUBETHA_DIAGNOSTICS_PATH` は計画の値）。違いは rail だけ: 本番の子は起動時に外の RPC・facilitator を
 * 読むので接続の無い試験では listen しない。ここでは試験の env `SUBETHA_TEST_SYNTHETIC_CONFIG` の合成の設定（loopback の fixture の facilitator・上流）で
 * `startRouter` を呼ぶ。journal（`ROUTER_JOURNAL_PATH`）・principal・port は計画の値のまま。
 */
import { reportStartupFailure, startRouter } from "../../src/main.js";
import { routerDiagnosticsSinkOf } from "../../tools/router-diagnostics.js";

const syntheticConfig = process.env["SUBETHA_TEST_SYNTHETIC_CONFIG"];
if (syntheticConfig === undefined || syntheticConfig === "") {
  process.stderr.write("SUBETHA_TEST_SYNTHETIC_CONFIG is required\n");
  process.exit(2);
}
process.env["ROUTER_CONFIG_PATH"] = syntheticConfig;
process.env["ROUTER_ADAPTER_MODE"] = "synthetic";

const diagnostics = routerDiagnosticsSinkOf(process.env);
startRouter(diagnostics === undefined ? {} : { diagnostics }).catch(reportStartupFailure);
