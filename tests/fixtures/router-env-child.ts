/**
 * 試験用の偽の Router の子（hosted 設計 §4、タスク H-4）。**製品コードではない。** 入口（`startHost`）が本物の子と同じ env で起動する。
 * - 起動時に env `SUBETHA_EVM_FACILITATOR_URL` があれば `<url>/supported` を 1 回読み、答えたかを覚える（facilitator が先に起動していることの確認）
 * - `SUBETHA_TEST_ROUTER_MARK`: 起動したらこのファイルに pid を書く（Router の子が起動しなかったことを試験が確かめる）
 * - 127.0.0.1 の使い捨ての port に listen し、listening の行を書く。`GET /env`: 受け取った env・pid・ppid・設定ファイルの mode
 */
import { statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

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
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ event: "listening", port: typeof address === "object" && address !== null ? address.port : 0 })}\n`);
});
