/**
 * 試験用の偽の EVM facilitator（hosted 設計 §4、タスク H-4）。**製品コードではない。** 鍵は使わない（署名・送出をしない）。
 * 入口（`startHost`）が本物の `tools/evm-facilitator.ts` と同じ env（`EVM_FACILITATOR_*`）で起動する。127.0.0.1 の `EVM_FACILITATOR_PORT` に listen し、
 * 本物と同じ形の listening の行を stdout に書く。
 * - `GET /<token>/supported`: `EVM_FACILITATOR_NETWORKS`（`SUBETHA_TEST_FAKE_SUPPORTED` があればその値）の kinds
 * - `GET /<token>/whoami`: pid・ppid・execArgv・受け取った env（試験が子の env と spawn の形を確かめる）
 * - `SUBETHA_TEST_PID_FILE`: 起動したら pid を書く（listen の後に止められた場合も試験が process の終了を確かめられる）
 */
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const env = process.env;
const pidFile = env["SUBETHA_TEST_PID_FILE"];
if (pidFile !== undefined && pidFile !== "") writeFileSync(pidFile, String(process.pid));
const token = env["EVM_FACILITATOR_TOKEN"] ?? "";
const port = Number(env["EVM_FACILITATOR_PORT"] ?? "0");
const supported = (env["SUBETHA_TEST_FAKE_SUPPORTED"] ?? env["EVM_FACILITATOR_NETWORKS"] ?? "").split(",").filter((s) => s !== "");

const server = createServer((req, res) => {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === `/${token}/supported`) {
    send(200, { kinds: supported.map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} });
    return;
  }
  if (req.method === "GET" && req.url === `/${token}/whoami`) {
    send(200, { pid: process.pid, ppid: process.ppid, execArgv: process.execArgv, env: Object.fromEntries(Object.entries(env)) });
    return;
  }
  send(404, { error: "not_found" });
});
// 試験の中は常に loopback（計画の bind は whoami の env で確かめる）。
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ event: "listening", host: "127.0.0.1", port, networks: (env["EVM_FACILITATOR_NETWORKS"] ?? "").split(","), held: [] })}\n`);
});
