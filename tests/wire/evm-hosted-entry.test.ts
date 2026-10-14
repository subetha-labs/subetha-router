/**
 * 入口の 2 つの子（facilitator と Router）を**実際に spawn する** wire 試験（`docs/evm-testnets-hosted-design.md` §4、FR-H1・FR-H8・SR-H5、タスク H-4）。
 * 入口は `tests/fixtures/evm-hosted-host.ts`（受け入れ用の起動と同じ `acceptanceOptionsOf`・`startHost`・計画）。子は偽物
 * （`tests/fixtures/evm-facilitator-fake.ts`・`tests/fixtures/router-env-child.ts`。env と pid を答える）か、本物の `tools/evm-facilitator.ts`
 * （RPC は閉じた loopback の port: listen の前に固定文で止まる）。鍵は毎回の乱数で、署名・送出はしない。外へは接続しない。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { acceptanceOptionsOf } from "../../tools/rails-acceptance-run.js";
import { hostPlanOf } from "../../tools/remote-mcp.js";
import { runToExit, startListening, type Listening } from "../fixtures/loopback.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const PROVIDER = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
const HOST = "tests/fixtures/evm-hosted-host.ts";

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
/**
 * 入口が作る使い捨ての作業領域（`runtime/remote-*`。設定に facilitator の token を含む）を残さない。並列に走るほかの試験の作業領域には触れない
 * （この試験の token の接頭辞 `h4-wire-` を含むものと、Router の子が答えた設定のパスのディレクトリだけ）。
 */
const configDirs = new Set<string>();
let createdBefore: Set<string>;
beforeAll(() => {
  mkdirSync(runtimeRoot, { recursive: true });
  createdBefore = new Set(readdirSync(runtimeRoot).filter((name) => name.startsWith("remote-")));
});
afterAll(() => {
  for (const name of readdirSync(runtimeRoot).filter((entry) => entry.startsWith("remote-") && !createdBefore.has(entry))) {
    let ours = false;
    try {
      ours = readFileSync(path.join(runtimeRoot, name, "router.config.json"), "utf8").includes("h4-wire-");
    } catch {
      ours = false;
    }
    if (ours) configDirs.add(path.join(runtimeRoot, name));
  }
  for (const dir of configDirs) rmSync(dir, { recursive: true, force: true });
});

function workDir(prefix: string): string {
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = mkdtempSync(path.join(runtimeRoot, prefix));
  dirs.push(dir);
  return dir;
}

/** 使い捨ての空き port（facilitator の URL は起動の前に決まるので、port 0 は使えない）。 */
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
  readonly env: Record<string, string>;
  readonly facilitatorPort: number;
  readonly token: string;
  readonly key: string;
  readonly routerMark: string;
  readonly facilitatorPidFile: string;
}

async function fixture(prefix: string, extra: Record<string, string> = {}): Promise<Fixture> {
  const dir = workDir(prefix);
  const facilitatorPort = await freePort();
  const token = `h4-wire-${crypto.randomUUID().replaceAll("-", "")}`;
  const key = generatePrivateKey();
  const routerMark = path.join(dir, "router.pid");
  const facilitatorPidFile = path.join(dir, "facilitator.pid");
  return {
    dir,
    facilitatorPort,
    token,
    key,
    routerMark,
    facilitatorPidFile,
    env: {
      SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(),
      SUBETHA_ROUTER_RECEIVER: RECEIVER,
      SUBETHA_EVM_FACILITATOR_KEY: key,
      SUBETHA_EVM_FACILITATOR_TOKEN: token,
      SUBETHA_EVM_FACILITATOR_GAS_CAP_46630: "1000000000000000",
      SUBETHA_EVM_FACILITATOR_GAS_CAP_421614: "1000000000000000",
      SUBETHA_EVM_FACILITATOR_GAS_CAP_998: "1000000000000000",
      SUBETHA_EVM_PROVIDER_PAYTO: PROVIDER,
      SUBETHA_JOURNAL_PATH: path.join(dir, "public", "journal.ndjson"),
      SUBETHA_ACCEPTANCE_JOURNAL_PATH: path.join(dir, "acceptance", "journal.ndjson"),
      SUBETHA_ACCEPTANCE_PORT: "0",
      SUBETHA_TEST_FACILITATOR_PORT: String(facilitatorPort),
      SUBETHA_TEST_ROUTER_MARK: routerMark,
      SUBETHA_TEST_PID_FILE: facilitatorPidFile,
      ...extra,
    },
  };
}

interface Started {
  readonly host: Listening;
  readonly announcement: { port: number; routerPort: number; facilitatorPort: number | null; pid: number };
}

async function startHostProcess(f: Fixture, rails: string): Promise<Started> {
  const host = await startListening(HOST, ["--rails", rails], f.env, { listenTimeoutMs: 60_000 });
  closers.push(() => host.stop());
  const line = host.stdout().split("\n").find((l) => l.includes('"pid"'))!;
  return { host, announcement: JSON.parse(line) };
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  const body = (await response.json()) as any;
  // Router の子が答えた設定のパス（入口の作業領域）を後で消す。
  const configPath = body?.env?.ROUTER_CONFIG_PATH;
  if (typeof configPath === "string" && path.dirname(path.dirname(configPath)) === runtimeRoot) configDirs.add(path.dirname(configPath));
  return body;
}

describe("facilitator の子 → Router の子の順（hosted 設計 §4）", () => {
  test("facilitator が先に listen し（Router の子は起動時に /supported に届く）、Router の子の env には URL があって gas 鍵が無い。facilitator の子は入口の直接の子（node --import tsx）。設定ファイルは 0600", async () => {
    const f = await fixture("h4-order-");
    const { announcement } = await startHostProcess(f, "rh-in,hyperevm-out");
    expect(announcement.facilitatorPort).toBe(f.facilitatorPort);
    const router = await getJson(`http://127.0.0.1:${announcement.routerPort}/env`);
    expect(router.facilitatorUpAtStart).toBe(true);
    expect(router.env.SUBETHA_EVM_FACILITATOR_URL).toBe(`http://127.0.0.1:${f.facilitatorPort}/${f.token}`);
    // gas 鍵はどの名前でも、どの値の中にも無い（SR-H5）。
    expect(Object.keys(router.env).filter((name) => /^EVM_FACILITATOR_|^SUBETHA_EVM_FACILITATOR_(KEY|TOKEN|GAS)/.test(name))).toEqual([]);
    expect(JSON.stringify(router.env)).not.toContain(f.key.slice(2));
    expect(router.env.SUBETHA_RAILS_ACTIVATION).toBe("rh-in,hyperevm-out");
    expect(router.ppid).toBe(announcement.pid);
    expect(router.configMode).toBe(0o600);
    expect(statSync(router.env.ROUTER_CONFIG_PATH).mode & 0o777).toBe(0o600);
    expect(readFileSync(router.env.ROUTER_CONFIG_PATH, "utf8")).toContain(f.token);
    // facilitator の子: 計画の env（gas 鍵・token・network・journal は公開の journal のディレクトリの下）を受け、入口の直接の子（tsx の CLI の孫ではない）。
    const who = await getJson(`http://127.0.0.1:${f.facilitatorPort}/${f.token}/whoami`);
    expect(who.ppid).toBe(announcement.pid);
    expect(who.execArgv).toEqual(["--import", "tsx"]);
    expect(who.env.EVM_FACILITATOR_KEY).toBe(f.key);
    expect(who.env.EVM_FACILITATOR_TOKEN).toBe(f.token);
    expect(who.env.EVM_FACILITATOR_NETWORKS).toBe("eip155:46630,eip155:998");
    expect(who.env.EVM_FACILITATOR_PORT).toBe(String(f.facilitatorPort));
    expect(who.env.EVM_FACILITATOR_BIND).toBe("127.0.0.1");
    expect(who.env.EVM_FACILITATOR_PAYTO_ALLOWLIST).toBe(`${RECEIVER},${PROVIDER}`);
    expect(who.env.EVM_FACILITATOR_JOURNAL).toBe(path.join(f.dir, "public", "evm-facilitator", "journal.ndjson"));
    // facilitator の子には Router の送信の鍵が無い。
    expect(JSON.stringify(who.env)).not.toContain(f.env["SUBETHA_OUTBOUND_PRIVATE_KEY"]!.slice(2));
  }, 90_000);

  test("/supported に有効な network が欠ける → facilitator を止め、Router の子を起動せずに入口が終わる（固定文。token は出ない）", async () => {
    const f = await fixture("h4-supported-", { SUBETHA_TEST_FAKE_SUPPORTED: "eip155:46630" });
    const result = await runToExit(HOST, ["--rails", "rh-in,hyperevm-in"], f.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the EVM facilitator did not list every active network at /supported");
    expect(result.stdout).not.toContain('"pid"');
    expect(existsSync(f.routerMark)).toBe(false);
    const pid = Number(readFileSync(f.facilitatorPidFile, "utf8"));
    expect(await waitFor(() => !alive(pid), 5_000)).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(f.token);
    expect(result.stdout + result.stderr).not.toContain(f.key.slice(2));
  }, 90_000);

  test("EVM が全部無効（--rails arc-in）: facilitator の子は起動しない。Router の子の env に facilitator の URL は無い", async () => {
    const f = await fixture("h4-off-", { SUBETHA_ARC_RECEIVER_KEY: generatePrivateKey() });
    const { announcement } = await startHostProcess(f, "arc-in");
    expect(announcement.facilitatorPort).toBeNull();
    expect(existsSync(f.facilitatorPidFile)).toBe(false);
    const router = await getJson(`http://127.0.0.1:${announcement.routerPort}/env`);
    expect(router.env.SUBETHA_EVM_FACILITATOR_URL).toBeUndefined();
    expect(router.facilitatorUpAtStart).toBeUndefined();
    expect(JSON.stringify(router.env)).not.toContain(f.key.slice(2));
    expect(JSON.stringify(router.env)).not.toContain(f.token);
  }, 90_000);
});

describe("どちらかの子が落ちたら両方を止めて入口も終わる。SIGTERM は両方を止める", () => {
  test.each([["Router の子", "router"], ["facilitator の子", "facilitator"]] as const)("%s を SIGKILL → もう片方も止まり、入口は exit 1", async (_name, victim) => {
    const f = await fixture(`h4-down-${victim}-`);
    const { host, announcement } = await startHostProcess(f, "rh-in");
    const routerPid = (await getJson(`http://127.0.0.1:${announcement.routerPort}/env`)).pid as number;
    const facilitatorPid = (await getJson(`http://127.0.0.1:${f.facilitatorPort}/${f.token}/whoami`)).pid as number;
    process.kill(victim === "router" ? routerPid : facilitatorPid, "SIGKILL");
    await Promise.race([host.exited, delay(15_000)]);
    expect(alive(announcement.pid)).toBe(false);
    expect(alive(routerPid)).toBe(false);
    expect(alive(facilitatorPid)).toBe(false);
    expect(host.stderr()).toContain(victim === "router" ? "the Router exited: stopping the entry" : "the EVM facilitator exited: stopping the entry");
  }, 90_000);

  test("入口に SIGTERM → 両方の子が止まって入口が終わる", async () => {
    const f = await fixture("h4-term-");
    const { host, announcement } = await startHostProcess(f, "arbsep-out");
    const routerPid = (await getJson(`http://127.0.0.1:${announcement.routerPort}/env`)).pid as number;
    const facilitatorPid = Number(readFileSync(f.facilitatorPidFile, "utf8"));
    process.kill(announcement.pid, "SIGTERM");
    await Promise.race([host.exited, delay(15_000)]);
    expect(alive(announcement.pid)).toBe(false);
    expect(await waitFor(() => !alive(routerPid) && !alive(facilitatorPid), 5_000)).toBe(true);
  }, 90_000);
});

describe("本物の facilitator の CLI（tools/evm-facilitator.ts）を計画の env で起動する", () => {
  test("計画の env の名前と値を本物の CLI が受け、chain の確認（閉じた loopback の RPC）で止まる → 入口は facilitator の固定文を出して終わり、Router の子は起動しない", async () => {
    const f = await fixture("h4-real-", { SUBETHA_TEST_REAL_FACILITATOR: "1", SUBETHA_EVM_FACILITATOR_RPC_46630: "https://127.0.0.1:1/" });
    const result = await runToExit(HOST, ["--rails", "rh-in"], f.env);
    expect(result.code).toBe(1);
    // 入口は固定文だけ（facilitator の出力は出さない）。
    expect(result.stderr).toContain("could not start the EVM facilitator");
    expect(result.stderr).not.toContain("evm-facilitator:");
    expect(existsSync(f.routerMark)).toBe(false);
    // 本物の CLI は lock を取った（env の検査を通った）後に止まった。
    expect(existsSync(path.join(f.dir, "public", "evm-facilitator", "facilitator.lock"))).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(f.token);
    expect(result.stdout + result.stderr).not.toContain(f.key.slice(2));
  }, 90_000);

  test("計画の facilitator の env をそのまま本物の CLI に渡すと、env の検査（鍵・token・bind・port・network・payTo・gas の上限・journal）を通り、chain の確認で止まる（固定文）", async () => {
    const f = await fixture("h4-real-env-", { SUBETHA_EVM_FACILITATOR_RPC_46630: "https://127.0.0.1:1/", SUBETHA_EVM_FACILITATOR_RPC_998: "https://127.0.0.1:1/" });
    for (const [rails, network] of [["rh-in", "eip155:46630"], ["hyperevm-out,rh-in", "eip155:46630"]] as const) {
      const plan = hostPlanOf({ ...acceptanceOptionsOf(f.env, ["--rails", rails]), evmFacilitatorPortForTest: f.facilitatorPort }, f.env);
      const result = await runToExit(plan.facilitator!.script, [], plan.facilitator!.env);
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr.trim()).toBe(`evm-facilitator: rpc_check_failed:${network}`);
      expect(result.stdout).toBe("");
    }
    // 対照: 計画の env から 1 つ欠けると env の検査で止まる（同じ CLI が env を読んでいることの確認）。
    const plan = hostPlanOf({ ...acceptanceOptionsOf(f.env, ["--rails", "rh-in"]), evmFacilitatorPortForTest: f.facilitatorPort }, f.env);
    const { EVM_FACILITATOR_GAS_CAP_46630: _cap, ...noCap } = plan.facilitator!.env;
    expect((await runToExit(plan.facilitator!.script, [], noCap)).stderr.trim()).toBe("evm-facilitator: EVM_FACILITATOR_GAS_CAP_46630 must be a positive wei amount");
  }, 90_000);
});
