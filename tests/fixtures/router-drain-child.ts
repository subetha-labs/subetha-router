/**
 * 試験用の Router の子（タスク R-0）。**製品コードではない。** `src/main.ts` の CLI と同じ `startRouter` を、drain の上限だけ短くして起動する
 * （`SUBETHA_TEST_ROUTER_DRAIN_TIMEOUT_MS`）。Router の子の drain の時間切れ（`router drain: timeout`・exit 1）の試験が使う。
 * `SUBETHA_TEST_DIAG_CLOSE=accessor-throws`（タスク R-2、Codex R-2 #3）: `close` の accessor が投げる診断の sink を注入する（drain の行と exit code が変わらないこと）。
 */
import { reportStartupFailure, startRouter, type ClosableDiagnosticsSink } from "../../src/main.js";

function brokenCloseSink(): ClosableDiagnosticsSink {
  const sink = { emit(): void {} };
  Object.defineProperty(sink, "close", {
    get() {
      throw new Error("diagnostics close accessor (test)");
    },
  });
  return sink as ClosableDiagnosticsSink;
}

const diagnostics = process.env["SUBETHA_TEST_DIAG_CLOSE"] === "accessor-throws" ? brokenCloseSink() : undefined;
startRouter({ drainTimeoutMsForTest: Number(process.env["SUBETHA_TEST_ROUTER_DRAIN_TIMEOUT_MS"] ?? "1000"), ...(diagnostics === undefined ? {} : { diagnostics }) }).catch(reportStartupFailure);
