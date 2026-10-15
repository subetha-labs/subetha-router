/**
 * 試験用の Router の子（タスク R-0）。**製品コードではない。** `src/main.ts` の CLI と同じ `startRouter` を、drain の上限だけ短くして起動する
 * （`SUBETHA_TEST_ROUTER_DRAIN_TIMEOUT_MS`）。Router の子の drain の時間切れ（`router drain: timeout`・exit 1）の試験が使う。
 */
import { reportStartupFailure, startRouter } from "../../src/main.js";

startRouter({ drainTimeoutMsForTest: Number(process.env["SUBETHA_TEST_ROUTER_DRAIN_TIMEOUT_MS"] ?? "1000") }).catch(reportStartupFailure);
