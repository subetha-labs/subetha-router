/**
 * 入口の graceful drain（`docs/rejection-reasons-design.md` §13.3・§15.2、タスク R-0）を、入口と 2 つの子を **実際に spawn して** 確かめる wire 試験。
 * 入口は `tests/fixtures/evm-hosted-host.ts`（`startHost` と同じ計画。子は偽物）。鍵は毎回の乱数で、署名・送出はしない。外へは接続しない。
 * - 進行中の要求（本文を送りかけの POST /mcp）が終わるまで子は止まらず、終わってから子を止めて `drain: complete`（最後の行）
 * - drain の間の新しい接続は受けない
 * - 上限に達すると子を止めて `drain: timeout`（exit 1）
 * - drain の間に子が落ちたら今までどおり両方を止めて exit 1（drain の行は出さない）
 * - MCP の要求の後に Router の子を drain する: SIGTERM を送り、子の drain を残りの時間まで待つ（5 秒の SIGKILL ではない）。
 *   `drain: complete` は子が `router drain: complete` を出して exit 0 のときだけ。facilitator は Router の子の終了の後に止める（順を記録で確かめる）
 * - ready の前の signal は今までどおり（drain の行を出さない）
 * - 合図の届き方: イメージの `CMD`（`npx --no-install tsx <entry>`）と同じ起動の鎖の一番上の pid に SIGTERM を送ると、入口の drain が走り、
 *   一番上の process は入口が終わるまで残る（コンテナの PID 1 が先に終わると、残りは drain の途中で殺される）
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const runtimeRoot = path.join(repoRoot, "runtime");
const HOST = "tests/fixtures/evm-hosted-host.ts";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const PROVIDER = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
/** 入口の作業領域（`runtime/remote-*`）のうち、この試験の token（`r0-drain-`）を含むものだけを消す。 */
let createdBefore: Set<string>;
beforeAll(() => {
  mkdirSync(runtimeRoot, { recursive: true });
  createdBefore = new Set(readdirSync(runtimeRoot).filter((name) => name.startsWith("remote-")));
});
afterAll(() => {
  for (const name of readdirSync(runtimeRoot).filter((entry) => entry.startsWith("remote-") && !createdBefore.has(entry))) {
    let ours = false;
    try {
      ours = readFileSync(path.join(runtimeRoot, name, "router.config.json"), "utf8").includes("r0-drain-");
    } catch {
      ours = false;
    }
    if (ours) rmSync(path.join(runtimeRoot, name), { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return address.port;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await delay(50);
  }
  return check();
}

interface Fixture {
  readonly dir: string;
  readonly events: string;
  readonly env: Record<string, string>;
  readonly token: string;
  readonly facilitatorPort: number;
  readonly facilitatorPidFile: string;
}

async function fixture(extra: Record<string, string> = {}): Promise<Fixture> {
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = mkdtempSync(path.join(runtimeRoot, "r0-drain-"));
  dirs.push(dir);
  const facilitatorPort = await freePort();
  const token = `r0-drain-${crypto.randomUUID().replaceAll("-", "")}`;
  const facilitatorPidFile = path.join(dir, "facilitator.pid");
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  const events = path.join(dir, "events.log");
  return {
    dir,
    events,
    token,
    facilitatorPort,
    facilitatorPidFile,
    env: {
      ...env,
      SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(),
      SUBETHA_ROUTER_RECEIVER: RECEIVER,
      SUBETHA_EVM_FACILITATOR_KEY: generatePrivateKey(),
      SUBETHA_EVM_FACILITATOR_TOKEN: token,
      SUBETHA_EVM_FACILITATOR_GAS_CAP_46630: "1000000000000000",
      SUBETHA_EVM_FACILITATOR_GAS_CAP_421614: "1000000000000000",
      SUBETHA_EVM_FACILITATOR_GAS_CAP_998: "1000000000000000",
      SUBETHA_EVM_PROVIDER_PAYTO: PROVIDER,
      SUBETHA_JOURNAL_PATH: path.join(dir, "public", "journal.ndjson"),
      SUBETHA_ACCEPTANCE_JOURNAL_PATH: path.join(dir, "acceptance", "journal.ndjson"),
      SUBETHA_ACCEPTANCE_PORT: "0",
      SUBETHA_TEST_FACILITATOR_PORT: String(facilitatorPort),
      SUBETHA_TEST_PID_FILE: facilitatorPidFile,
      SUBETHA_TEST_EVENT_LOG: events,
      ...extra,
    },
  };
}

interface Running {
  /** spawn した一番上の process の pid（`node --import tsx` なら入口そのもの、`npx` なら launcher）。 */
  readonly topPid: number;
  readonly announcement: { port: number; routerPort: number; facilitatorPort: number | null; pid: number };
  readonly stderr: () => string;
  readonly done: Promise<{ code: number | null; signal: string | null }>;
}

/** 入口を `launcher` で spawn し、listening の行（入口の pid と port）を待つ。 */
async function startEntry(f: Fixture, launcher: "node" | "npx"): Promise<Running> {
  const command = launcher === "node" ? process.execPath : "npx";
  const args = launcher === "node" ? ["--import", "tsx", HOST, "--rails", "arbsep-out"] : ["--no-install", "tsx", HOST, "--rails", "arbsep-out"];
  const child = spawn(command, args, { cwd: repoRoot, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const done = once(child, "close").then(([code, signal]) => ({ code: code as number | null, signal: signal as string | null }));
  let innerPid: number | undefined;
  closers.push(async () => {
    if (innerPid !== undefined && alive(innerPid)) process.kill(innerPid, "SIGKILL");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await done;
  });
  const listening = await waitFor(() => stdout.includes('"pid"'), 60_000);
  if (!listening) throw new Error(`the entry did not listen: ${stderr}`);
  const announcement = JSON.parse(stdout.split("\n").find((line) => line.includes('"pid"'))!) as Running["announcement"];
  innerPid = announcement.pid;
  return { topPid: child.pid!, announcement, stderr: () => stderr, done };
}

const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

/** 本文を途中まで送った POST /mcp（進行中の要求）。`finish` で残りを送り、応答の status 行を返す。 */
async function slowRequest(port: number): Promise<{ socket: Socket; finish: () => Promise<string> }> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  let received = "";
  socket.setEncoding("utf8").on("data", (chunk: string) => (received += chunk));
  socket.on("error", () => {});
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(BODY)}\r\n\r\n${BODY.slice(0, 10)}`,
  );
  closers.push(async () => void socket.destroy());
  return {
    socket,
    finish: async () => {
      socket.write(BODY.slice(10));
      await waitFor(() => /\r\n\r\n/.test(received), 10_000);
      return received.split("\r\n")[0] ?? "";
    },
  };
}

async function connectRefused(port: number): Promise<boolean> {
  const socket = connect(port, "127.0.0.1");
  try {
    await once(socket, "connect");
    return false;
  } catch {
    return true;
  } finally {
    socket.destroy();
  }
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1) ?? "";
}

describe("入口の drain（SIGTERM の後）", () => {
  test("進行中の要求が終わるまで子は止まらず、新しい接続は受けない。終わってから子を止め、最後に drain: complete（exit 0）", async () => {
    const f = await fixture();
    const entry = await startEntry(f, "node");
    const routerPid = ((await (await fetch(`http://127.0.0.1:${entry.announcement.routerPort}/env`)).json()) as { pid: number }).pid;
    const facilitatorPid = Number(readFileSync(f.facilitatorPidFile, "utf8"));
    const inFlight = await slowRequest(entry.announcement.port);
    await delay(200);
    process.kill(entry.announcement.pid, "SIGTERM");
    await delay(1_500);
    // drain の間: 入口も子も残り、新しい接続は受けない。
    expect(alive(entry.announcement.pid)).toBe(true);
    expect(alive(routerPid)).toBe(true);
    expect(alive(facilitatorPid)).toBe(true);
    expect(await connectRefused(entry.announcement.port)).toBe(true);
    expect(entry.stderr()).not.toMatch(/drain:/);
    // 進行中の要求は最後まで処理される。
    expect(await inFlight.finish()).toBe("HTTP/1.1 200 OK");
    const exit = await Promise.race([entry.done, delay(20_000).then(() => undefined)]);
    expect(exit?.code, entry.stderr()).toBe(0);
    expect(lastLine(entry.stderr())).toBe("drain: complete");
    expect(entry.stderr().match(/^drain: /gm)).toHaveLength(1);
    expect(alive(routerPid)).toBe(false);
    expect(alive(facilitatorPid)).toBe(false);
  }, 90_000);

  test("進行中の要求が無ければすぐ drain: complete", async () => {
    const f = await fixture();
    const entry = await startEntry(f, "node");
    process.kill(entry.announcement.pid, "SIGTERM");
    const exit = await Promise.race([entry.done, delay(20_000).then(() => undefined)]);
    expect(exit?.code, entry.stderr()).toBe(0);
    expect(lastLine(entry.stderr())).toBe("drain: complete");
  }, 90_000);

  test("上限（試験は 1.5 秒）に達すると子を止めて drain: timeout（exit 1。complete は出ない）。止める順は Router の子の終了 → facilitator", async () => {
    const f = await fixture({ SUBETHA_TEST_DRAIN_TIMEOUT_MS: "1500", SUBETHA_TEST_ROUTER_DRAIN: "delay:1000" });
    const entry = await startEntry(f, "node");
    const routerPid = ((await (await fetch(`http://127.0.0.1:${entry.announcement.routerPort}/env`)).json()) as { pid: number }).pid;
    const facilitatorPid = Number(readFileSync(f.facilitatorPidFile, "utf8"));
    await slowRequest(entry.announcement.port);
    await delay(200);
    const sentAt = Date.now();
    process.kill(entry.announcement.pid, "SIGTERM");
    const exit = await Promise.race([entry.done, delay(20_000).then(() => undefined)]);
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(1_400);
    expect(exit?.code, entry.stderr()).toBe(1);
    expect(lastLine(entry.stderr())).toBe("drain: timeout");
    expect(entry.stderr()).not.toContain("drain: complete");
    expect(alive(routerPid)).toBe(false);
    expect(alive(facilitatorPid)).toBe(false);
    expect(eventsOf(f)).toEqual(["router-sigterm", "router-exit", "facilitator-sigterm"]);
  }, 90_000);

  test("drain の間に facilitator の子が落ちる → 今までどおり両方を止めて exit 1。drain の行は出さない", async () => {
    const f = await fixture();
    const entry = await startEntry(f, "node");
    const routerPid = ((await (await fetch(`http://127.0.0.1:${entry.announcement.routerPort}/env`)).json()) as { pid: number }).pid;
    const facilitatorPid = Number(readFileSync(f.facilitatorPidFile, "utf8"));
    await slowRequest(entry.announcement.port);
    await delay(200);
    process.kill(entry.announcement.pid, "SIGTERM");
    await delay(500);
    process.kill(facilitatorPid, "SIGKILL");
    const exit = await Promise.race([entry.done, delay(20_000).then(() => undefined)]);
    expect(exit?.code, entry.stderr()).toBe(1);
    expect(entry.stderr()).toContain("the EVM facilitator exited: stopping the entry");
    expect(entry.stderr()).not.toMatch(/^drain: /m);
    expect(alive(routerPid)).toBe(false);
  }, 90_000);
});

describe("合図の届き方: イメージの CMD と同じ起動の鎖（npx --no-install tsx <entry>）", () => {
  test("一番上の pid（npx）への SIGTERM で入口の drain が走り、一番上の process は入口が drain: complete で終わるまで残る", async () => {
    const f = await fixture();
    const entry = await startEntry(f, "npx");
    // 鎖になっている（一番上は入口そのものではない）ことの確認。
    expect(entry.topPid).not.toBe(entry.announcement.pid);
    const inFlight = await slowRequest(entry.announcement.port);
    await delay(200);
    process.kill(entry.topPid, "SIGTERM");
    await delay(1_500);
    expect(alive(entry.announcement.pid)).toBe(true);
    expect(alive(entry.topPid)).toBe(true);
    expect(await connectRefused(entry.announcement.port)).toBe(true);
    expect(await inFlight.finish()).toBe("HTTP/1.1 200 OK");
    const exit = await Promise.race([entry.done, delay(20_000).then(() => undefined)]);
    expect(exit, entry.stderr()).toBeDefined();
    expect(entry.stderr()).toMatch(/^drain: complete$/m);
    expect(alive(entry.announcement.pid)).toBe(false);
  }, 120_000);
});

function eventsOf(f: Fixture): string[] {
  return existsSync(f.events) ? readFileSync(f.events, "utf8").trim().split("\n").filter((line) => line !== "") : [];
}

async function routerPidOf(entry: Running): Promise<number> {
  return ((await (await fetch(`http://127.0.0.1:${entry.announcement.routerPort}/env`)).json()) as { pid: number }).pid;
}

describe("Router の子の drain（MCP の要求の後）と止める順", () => {
  test("Router の子の drain が 5 秒より長くても残りの時間まで待ち、子が router drain: complete で終わってから facilitator を止めて drain: complete", async () => {
    const f = await fixture({ SUBETHA_TEST_ROUTER_DRAIN: "delay:6000" });
    const entry = await startEntry(f, "node");
    const sentAt = Date.now();
    process.kill(entry.announcement.pid, "SIGTERM");
    const exit = await Promise.race([entry.done, delay(30_000).then(() => undefined)]);
    expect(Date.now() - sentAt).toBeGreaterThanOrEqual(5_900);
    expect(exit?.code, entry.stderr()).toBe(0);
    expect(lastLine(entry.stderr())).toBe("drain: complete");
    expect(eventsOf(f)).toEqual(["router-sigterm", "router-exit", "facilitator-sigterm"]);
  }, 90_000);

  test("Router の子が router drain: timeout（exit 1）→ 入口は drain: timeout（exit 1）。facilitator はその後に止める", async () => {
    const f = await fixture({ SUBETHA_TEST_ROUTER_DRAIN: "timeout" });
    const entry = await startEntry(f, "node");
    process.kill(entry.announcement.pid, "SIGTERM");
    const exit = await Promise.race([entry.done, delay(20_000).then(() => undefined)]);
    expect(exit?.code, entry.stderr()).toBe(1);
    expect(lastLine(entry.stderr())).toBe("drain: timeout");
    expect(entry.stderr()).not.toContain("drain: complete");
    expect(eventsOf(f)).toEqual(["router-sigterm", "router-exit", "facilitator-sigterm"]);
  }, 90_000);

  test("Router の子が終わらない → 残りの時間（試験は 2 秒）で SIGKILL し drain: timeout。facilitator はその後に止める", async () => {
    const f = await fixture({ SUBETHA_TEST_ROUTER_DRAIN: "hang", SUBETHA_TEST_DRAIN_TIMEOUT_MS: "2000" });
    const entry = await startEntry(f, "node");
    const routerPid = await routerPidOf(entry);
    const sentAt = Date.now();
    process.kill(entry.announcement.pid, "SIGTERM");
    const exit = await Promise.race([entry.done, delay(20_000).then(() => undefined)]);
    const elapsed = Date.now() - sentAt;
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
    expect(elapsed).toBeLessThan(4_500);
    expect(exit?.code, entry.stderr()).toBe(1);
    expect(lastLine(entry.stderr())).toBe("drain: timeout");
    expect(alive(routerPid)).toBe(false);
    expect(eventsOf(f)).toEqual(["router-sigterm", "facilitator-sigterm"]);
  }, 90_000);

  test("Router の子の drain の間に facilitator が落ちる → 今までどおり両方を止めて exit 1。drain の行は出さない", async () => {
    const f = await fixture({ SUBETHA_TEST_ROUTER_DRAIN: "hang" });
    const entry = await startEntry(f, "node");
    const routerPid = await routerPidOf(entry);
    const facilitatorPid = Number(readFileSync(f.facilitatorPidFile, "utf8"));
    process.kill(entry.announcement.pid, "SIGTERM");
    expect(await waitFor(() => eventsOf(f).includes("router-sigterm"), 10_000)).toBe(true);
    process.kill(facilitatorPid, "SIGKILL");
    const exit = await Promise.race([entry.done, delay(20_000).then(() => undefined)]);
    expect(exit?.code, entry.stderr()).toBe(1);
    expect(entry.stderr()).toContain("the EVM facilitator exited: stopping the entry");
    expect(entry.stderr()).not.toMatch(/^drain: /m);
    expect(await waitFor(() => !alive(routerPid), 10_000)).toBe(true);
  }, 90_000);

  test("ready の前（Router の子の起動待ち）の SIGTERM は今までどおり: 子を止めて exit 0、drain の行は出さない", async () => {
    const f = await fixture({ SUBETHA_TEST_ROUTER_LISTEN_DELAY_MS: "5000" });
    const child = spawn(process.execPath, ["--import", "tsx", HOST, "--rails", "arbsep-out"], { cwd: repoRoot, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const done = once(child, "close");
    closers.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done;
    });
    expect(await waitFor(() => existsSync(f.facilitatorPidFile), 30_000)).toBe(true);
    const facilitatorPid = Number(readFileSync(f.facilitatorPidFile, "utf8"));
    await delay(1_000);
    child.kill("SIGTERM");
    const [code] = (await Promise.race([done, delay(20_000).then(() => [undefined])])) as [number | null | undefined];
    expect(code, stderr).toBe(0);
    expect(stderr).not.toMatch(/drain: /);
    expect(await waitFor(() => !alive(facilitatorPid), 5_000)).toBe(true);
  }, 90_000);
});
