/**
 * イメージの段の drain の証拠（`docs/rejection-reasons-design.md` §13.3、タスク R-0、Codex R-0 #4）。**既定では走らない**:
 * `SUBETHA_IMAGE_DRAIN_TEST=1` と `SUBETHA_IMAGE_TAG=<本番のイメージの tag>`、docker が要る（コンテナは 1 つだけ、試験の後に消す。イメージは消さない:
 * 渡された tag は運用者のもの）。
 *
 * 起動の命令は worktree の `Dockerfile` の `CMD` を読み、入口の script（`tools/remote-mcp.ts`）だけを `tests/fixtures/evm-hosted-host.ts --rails arbsep-out` に替える
 * （本物の入口は実鍵と外の RPC が無いと起動しない。launcher・PID 1 の形は CMD のまま、入口の `startHost`・drain の code は同じ。子は偽物）。
 * 渡す tag のイメージの CMD が古くても、`docker run` の引数で worktree の CMD の形を使う。この worktree の `src`・`tools`・`tests/fixtures` を読み取り専用で重ねる（イメージの node_modules・node・user をそのまま使う）。
 * network は無し（`--network none`）。進行中の要求はコンテナの中の client（`docker exec`）が持つ。
 *
 * 確かめること: `docker stop -t 30` の SIGTERM が PID 1（CMD の命令 = 入口）に届き、入口は進行中の要求の終わりと Router の子の drain（2 秒）を待ってから
 * `drain: complete <id>`（id は `entry run: <id>` と同じ）を出して exit 0。要求は 200 で終わる。止める順は Router の子 → facilitator。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { generatePrivateKey } from "viem/accounts";
import { afterAll, expect, test } from "vitest";

const enabled = process.env["SUBETHA_IMAGE_DRAIN_TEST"] === "1";
const tag = process.env["SUBETHA_IMAGE_TAG"] ?? "";
const hasDocker = enabled && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
const repoRoot = path.resolve(import.meta.dirname, "../..");
const name = `r0-image-drain-${process.pid}`;
let outDir: string | undefined;

afterAll(() => {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
});

const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const logsOf = (): string => {
  const result = spawnSync("docker", ["logs", name], { encoding: "utf8" });
  return `${result.stdout}${result.stderr}`;
};

const CLIENT = `
import net from "node:net";
import { writeFileSync } from "node:fs";
const port = Number(process.argv[2]);
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
const socket = net.connect(port, "127.0.0.1");
let received = "";
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  received += chunk;
  if (received.includes("\\r\\n")) writeFileSync("/out/result", received.split("\\r\\n")[0]);
});
socket.on("connect", () => {
  socket.write("POST /mcp HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nContent-Type: application/json\\r\\nAccept: application/json, text/event-stream\\r\\nContent-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body.slice(0, 10));
  writeFileSync("/out/started", "1");
  setTimeout(() => socket.write(body.slice(10)), 4000);
});
`;

test.skipIf(!hasDocker || tag === "")("docker stop -t 30（本番のイメージ・Dockerfile の CMD の形）: SIGTERM が入口に届き、進行中の要求と Router の子の drain を待ってから drain: complete <id>", async () => {
  mkdirSync(path.join(repoRoot, "runtime"), { recursive: true });
  outDir = mkdtempSync(path.join(repoRoot, "runtime", "r0-image-drain-"));
  chmodSync(outDir, 0o777);
  writeFileSync(path.join(outDir, "client.mjs"), CLIENT);
  const env = {
    SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(),
    SUBETHA_ROUTER_RECEIVER: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405",
    SUBETHA_EVM_FACILITATOR_KEY: generatePrivateKey(),
    SUBETHA_EVM_FACILITATOR_TOKEN: `r0-image-${crypto.randomUUID().replaceAll("-", "")}`,
    SUBETHA_EVM_FACILITATOR_GAS_CAP_46630: "1000000000000000",
    SUBETHA_EVM_FACILITATOR_GAS_CAP_421614: "1000000000000000",
    SUBETHA_EVM_FACILITATOR_GAS_CAP_998: "1000000000000000",
    SUBETHA_EVM_PROVIDER_PAYTO: "0xf8243d93F339807CA9846Aa31155A2B2262D08db",
    SUBETHA_JOURNAL_PATH: "/app/runtime/r0/public/journal.ndjson",
    SUBETHA_ACCEPTANCE_JOURNAL_PATH: "/app/runtime/r0/acceptance/journal.ndjson",
    SUBETHA_ACCEPTANCE_PORT: "0",
    SUBETHA_TEST_FACILITATOR_PORT: "8611",
    SUBETHA_TEST_PID_FILE: "/app/runtime/r0/facilitator.pid",
    SUBETHA_TEST_EVENT_LOG: "/out/events.log",
    SUBETHA_TEST_ROUTER_DRAIN: "delay:2000",
  };
  const mounts = ["src", "tools", "tests/fixtures"].flatMap((dir) => ["-v", `${path.join(repoRoot, dir)}:/app/${dir}:ro`]);
  const cmd = JSON.parse(/^CMD (\[.*\])$/m.exec(readFileSync(path.join(repoRoot, "Dockerfile"), "utf8"))![1]!) as string[];
  expect(cmd.at(-1)).toBe("tools/remote-mcp.ts");
  const command = [...cmd.slice(0, -1), "tests/fixtures/evm-hosted-host.ts", "--rails", "arbsep-out"];
  docker("run", "-d", "--name", name, "--network", "none", ...mounts, "-v", `${outDir}:/out`, ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), tag, ...command);
  let announcement: { port: number; pid: number } | undefined;
  for (let i = 0; i < 240 && announcement === undefined; i += 1) {
    const line = logsOf().split("\n").find((l) => l.includes('"pid"'));
    if (line !== undefined) announcement = JSON.parse(line) as { port: number; pid: number };
    else await delay(500);
  }
  expect(announcement, logsOf()).toBeDefined();
  // PID 1 は CMD の命令そのもの（入口）。
  const pid1 = docker("exec", name, "cat", "/proc/1/cmdline").split("\0").join(" ").trim();
  expect(pid1).toBe(command.join(" "));
  expect(announcement!.pid).toBe(1);
  docker("exec", "-d", name, "node", "/out/client.mjs", String(announcement!.port));
  for (let i = 0; i < 40 && !existsSync(path.join(outDir, "started")); i += 1) await delay(100);
  expect(existsSync(path.join(outDir, "started"))).toBe(true);
  await delay(500);
  const startedAt = Date.now();
  docker("stop", "-t", "30", name);
  const elapsed = Date.now() - startedAt;
  const logs = logsOf();
  const runIds = [...logs.matchAll(/^entry run: ([0-9a-f]{16})$/gm)].map((m) => m[1]);
  expect(runIds, logs).toHaveLength(1);
  // `deploy/swap-image.sh` と同じ照合: 最後の `entry run:` の id と同じ id の `drain: complete` の行。
  expect(logs.split("\n"), logs).toContain(`drain: complete ${runIds[0]}`);
  expect(JSON.parse(docker("inspect", "-f", "{{json .State}}", name)) as { ExitCode: number; OOMKilled: boolean }).toMatchObject({ ExitCode: 0, OOMKilled: false });
  // 要求は最後まで処理され、stop は要求（約 3.5 秒）と Router の子の drain（2 秒）を待った（grace の 30 秒より前に終わった）。
  expect(readFileSync(path.join(outDir, "result"), "utf8")).toBe("HTTP/1.1 200 OK");
  expect(elapsed).toBeGreaterThanOrEqual(4_500);
  expect(elapsed).toBeLessThan(30_000);
  expect(readFileSync(path.join(outDir, "events.log"), "utf8").trim().split("\n")).toEqual(["router-sigterm", "router-exit", "facilitator-sigterm", "facilitator-exit"]);
  console.info(`image-drain: image ${tag}; PID 1 cmdline "${pid1}"; entry pid ${announcement!.pid}; docker stop took ${elapsed} ms`);
}, 240_000);
