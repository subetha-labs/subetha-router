/**
 * 試験用の偽の Router の子（hosted 設計 §4、タスク H-4）。**製品コードではない。** 入口（`startHost`）が本物の子と同じ env で起動する。
 * - 起動時に env `SUBETHA_EVM_FACILITATOR_URL` があれば `<url>/supported` を 1 回読み、答えたかを覚える（facilitator が先に起動していることの確認）
 * - `SUBETHA_TEST_ROUTER_MARK`: 起動したらこのファイルに pid を書く（Router の子が起動しなかったことを試験が確かめる）
 * - `SUBETHA_TEST_ROUTER_LISTEN_DELAY_MS`: listen をこの時間だけ遅らせる（入口の「Router の起動待ち」の段）
 * - `SUBETHA_TEST_ROUTER_BLOCK_EVIDENCE=1`: listen の前に入口の証拠のファイルのパス（設定の隣の `router-listening.log`）をディレクトリにする
 *   （入口の書き込みが EISDIR で失敗する。root でも同じ: 権限ではなくファイルの種類で失敗させる）
 * - SIGTERM（タスク R-0 の drain）: 本物の子と同じ固定の行で終わる。`SUBETHA_TEST_ROUTER_DRAIN` で振る舞いを選ぶ:
 *   空 = すぐ `router drain: complete`（exit 0）、`delay:<ms>` = その時間の後に complete、`timeout` = `router drain: timeout`（exit 1）、`hang` = SIGTERM を無視する
 * - `SUBETHA_TEST_EVENT_LOG`: SIGTERM を受けた・終わる直前に 1 行ずつ追記する（facilitator の偽物と同じファイル。止める順を試験が確かめる）
 * - 127.0.0.1 の使い捨ての port に listen し、listening の行を書く。`GET /env`: 受け取った env・pid・ppid・設定ファイルの mode
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const env = process.env;
const mark = env["SUBETHA_TEST_ROUTER_MARK"];
if (mark !== undefined && mark !== "") writeFileSync(mark, String(process.pid));

let facilitatorUpAtStart: boolean | undefined;
const facilitatorUrl = env["SUBETHA_EVM_FACILITATOR_URL"];
if (facilitatorUrl !== undefined && facilitatorUrl !== "") {
  try {
    const response = await fetch(`${facilitatorUrl}/supported`, { signal: AbortSignal.timeout(5_000) });
    facilitatorUpAtStart = response.status === 200;
    await response.body?.cancel();
  } catch {
    facilitatorUpAtStart = false;
  }
}

const configPath = env["ROUTER_CONFIG_PATH"];
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/env") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ pid: process.pid, ppid: process.ppid, env: Object.fromEntries(Object.entries(env)), facilitatorUpAtStart, configMode: configPath === undefined ? undefined : statSync(configPath).mode & 0o777 }));
    return;
  }
  res.writeHead(404);
  res.end();
});
if (env["SUBETHA_TEST_ROUTER_BLOCK_EVIDENCE"] === "1" && configPath !== undefined) mkdirSync(path.join(path.dirname(configPath), "router-listening.log"));
setTimeout(() => {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    // `label`: 入口の MCP が証拠の行から rail の名乗りを読む（無いと MCP の要求が 500 になる。drain の試験が要求を最後まで通す）。
    process.stdout.write(`${JSON.stringify({ event: "listening", port: typeof address === "object" && address !== null ? address.port : 0, label: "fake-router-env-child" })}\n`);
  });
}, Number(env["SUBETHA_TEST_ROUTER_LISTEN_DELAY_MS"] ?? "0"));

const eventLog = env["SUBETHA_TEST_EVENT_LOG"] ?? "";
const event = (name: string): void => {
  if (eventLog !== "") appendFileSync(eventLog, `${name}\n`);
};
const drainMode = env["SUBETHA_TEST_ROUTER_DRAIN"] ?? "";
process.on("SIGTERM", () => {
  event("router-sigterm");
  if (drainMode === "hang") return;
  const finish = (): void => {
    const complete = drainMode !== "timeout";
    event("router-exit");
    process.stderr.write(complete ? "router drain: complete\n" : "router drain: timeout\n");
    process.exit(complete ? 0 : 1);
  };
  if (drainMode.startsWith("delay:")) setTimeout(finish, Number(drainMode.slice("delay:".length)));
  else finish();
});
