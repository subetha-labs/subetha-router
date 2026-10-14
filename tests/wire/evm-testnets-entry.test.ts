/**
 * EVM testnet 4 つの専用の入口と子 process を**実際に spawn する** wire 試験（`docs/evm-testnets-x402-design.md` §3.5・§3.6、AC-E5、タスク E-4）。
 * 資金は動かない: facilitator・Provider は loopback の fixture、鍵は毎回の乱数。外部へは出ない。
 *
 * 1. 本番の入口 `tools/evm-testnets-run.ts` → `startHost` の分岐 → 本番の子 `tools/evm-testnets-router-process.ts`（transport の差し替えなし）:
 *    8 route が一覧に出て、送信 route（C の Provider は allowlist の loopback）の quote が通る。allowlist に入らない loopback（`localhost`）の
 *    facilitator では Router が起動しない。受信 route の quote は Provider A（公開のホスト名）に出るのでここでは呼ばない。
 * 2. 試験用の入口 `tests/fixtures/evm-testnets-host.ts`（同じ `evmTestnetsOptionsOf`・`startHost`・計画）→ 試験用の子（同じ `evmTestnetsCapabilitiesOf`
 *    ＋公開のホスト名 `provider-x402.subethalabs.com` だけを TLS の fixture に向ける transport の差し替え）: 受信 route の quote と購入。
 *    §3.6 の期限: facilitator が Router の受信の期限（rh は 20 秒）の内に settle を返せば `delivered`、越えれば `unknown`。Router を同じ journal で
 *    再起動しても `unknown` のまま、facilitator への settle は 2 回目の購入の 1 回だけ（再送しない）。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createX402Payer } from "../../tools/x402-payer.js";
import { EVM_TESTNET_CHAINS, EVM_TESTNETS, type EvmTestnetChain } from "../../tools/remote-mcp-config.js";
import { paidOk, standardAccept, startX402Upstream, type X402Upstream } from "../fixtures/dynamic/x402-upstream.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const PROVIDER = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
const PROVIDER_A = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";
const PROVIDER_A_HOST = "provider-x402.subethalabs.com";
const TOKEN = "e4-wire-token-0123456789abcdef";
const ALL_ROUTES = EVM_TESTNET_CHAINS.flatMap((chain) => [`md-x402-eth-snapshot-${chain}`, `md-${chain}-eth-snapshot`]);

const closers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
let createdBefore: Set<string>;
beforeAll(() => {
  mkdirSync(runtimeRoot, { recursive: true });
  createdBefore = new Set(readdirSync(runtimeRoot).filter((name) => name.startsWith("remote-")));
});
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});
afterAll(() => {
  // 入口が作った使い捨ての作業領域（config に facilitator の token を含む）を残さない。並列に走るほかの試験の作業領域には触れない（この試験の token を含むものだけ）。
  for (const name of readdirSync(runtimeRoot).filter((entry) => entry.startsWith("remote-") && !createdBefore.has(entry))) {
    let ours = false;
    try {
      ours = readFileSync(path.join(runtimeRoot, name, "router.config.json"), "utf8").includes(TOKEN);
    } catch {
      ours = false;
    }
    if (ours) dirs.push(path.join(runtimeRoot, name));
  }
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function workDir(prefix: string): string {
  const dir = mkdtempSync(path.join(runtimeRoot, prefix));
  dirs.push(dir);
  return dir;
}

async function listening(script: string, args: string[], env: Record<string, string> = {}, listenTimeoutMs?: number): Promise<Listening> {
  const child = await startListening(script, args, env, listenTimeoutMs === undefined ? {} : { listenTimeoutMs });
  closers.push(() => child.stop());
  return child;
}

/**
 * ファイル全体で共有する fixture（起動の数を抑える。全試験の並列実行で他の時間に敏感な試験を圧迫しないように、順に起動する）:
 * - 受信の facilitator（token の接頭辞つき）。settle は 1 回目 1 秒後、2 回目 22 秒後に答える（settle を呼ぶのは最後の試験だけ）
 * - C の Provider 4 つ（x402 の合成上流。network・資産・domain・受取先は表と設定に合わせる）
 */
let facilitator: Listening;
let providers: Record<EvmTestnetChain, Listening>;
const shared: Listening[] = [];
beforeAll(async () => {
  facilitator = await startListening("tests/fixtures/x402-inbound-facilitator.ts", ["--prefix", `/${TOKEN}`, "--settle-delays", "1000,22000"]);
  shared.push(facilitator);
  const entries: Array<readonly [EvmTestnetChain, Listening]> = [];
  for (const chain of EVM_TESTNET_CHAINS) {
    const c = EVM_TESTNETS[chain];
    const provider = await startListening("tests/fixtures/x402-upstream.ts", ["--network", c.network, "--asset", c.asset, "--pay-to", PROVIDER, "--domain-name", c.domain.name, "--domain-version", c.domain.version, "--amount", "10000"]);
    shared.push(provider);
    entries.push([chain, provider]);
  }
  providers = Object.fromEntries(entries) as Record<EvmTestnetChain, Listening>;
}, 60_000);
afterAll(async () => {
  while (shared.length > 0) await shared.pop()!.stop();
});

function hostEnvOf(facilitatorUrl: string, providers: Record<EvmTestnetChain, Listening>, journalPath: string, outboundKey: string): Record<string, string> {
  return {
    SUBETHA_OUTBOUND_PRIVATE_KEY: outboundKey,
    SUBETHA_ROUTER_RECEIVER: RECEIVER,
    SUBETHA_EVM_FACILITATOR_URL: facilitatorUrl,
    SUBETHA_EVM_PROVIDER_PAYTO: PROVIDER,
    ...Object.fromEntries(EVM_TESTNET_CHAINS.map((chain) => [`SUBETHA_EVM_PROVIDER_URL_${chain.toUpperCase()}`, `${providers[chain].baseUrl}/v1/eth/snapshot`])),
    SUBETHA_EVM_TESTNETS_JOURNAL_PATH: journalPath,
    SUBETHA_EVM_TESTNETS_PORT: "0",
  };
}

/** MCP（Streamable HTTP・ステートレス）で入口の tool を 1 回呼ぶ。 */
async function callTool(port: number, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const client = new Client({ name: "evm-testnets-wire", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)) as never);
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    return result.structuredContent as Record<string, any>;
  } finally {
    await client.close();
  }
}

async function calls(fixture: Listening): Promise<Record<string, any>> {
  const response = await fetch(`${fixture.baseUrl}/calls`);
  return (await response.json()) as Record<string, any>;
}

function noSecrets(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe("本番の入口と本番の子（tools/evm-testnets-run.ts → tools/evm-testnets-router-process.ts）", () => {
  test("8 route が一覧に出て、送信 route の quote が allowlist の loopback の Provider に届く。告知は mode evm-testnets、鍵・token は出ない", async () => {
    const outboundKey = generatePrivateKey();
    const dir = workDir("e4-entry-");
    const host = await listening("tools/evm-testnets-run.ts", ["--chains", "rh,arbsep,hyperevm,sepolia"], hostEnvOf(`${facilitator.baseUrl}/${TOKEN}`, providers, path.join(dir, "journal.ndjson"), outboundKey), 120_000);
    const announcement = JSON.parse(host.stdout().trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(announcement).toMatchObject({ event: "listening", address: "127.0.0.1", mode: "evm-testnets", chains: "rh,arbsep,hyperevm,sepolia" });
    expect(typeof announcement["routerPort"]).toBe("number");

    const list = await callTool(host.port, "subetha_router_list_routes", {});
    expect(list["ok"]).toBe(true);
    expect((list["routes"] as Array<{ routeId: string }>).map((route) => route.routeId).sort()).toEqual([...ALL_ROUTES].sort());
    expect(list["dynamic"]).toBeUndefined();

    const before = await calls(providers.rh);
    const quote = await callTool(host.port, "subetha_router_quote", { routeId: "md-rh-eth-snapshot", requestId: `e4-entry-out-${Date.now()}` });
    expect(quote["ok"], JSON.stringify(quote)).toBe(true);
    expect(quote["quote"]["source"]["offer"]).toMatchObject({ scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "10000", payTo: RECEIVER });
    expect(JSON.stringify(quote["subject"])).toContain("eip155:46630");
    expect((await calls(providers.rh))["challengeCalls"]).toBe(before["challengeCalls"] + 1);
    // 受信の facilitator には quote では触れない（settle を呼ぶのは最後の試験だけ）。
    expect(await calls(facilitator)).toMatchObject({ verifyCalls: 0, settleCalls: 0 });

    noSecrets(host.stdout() + host.stderr(), [outboundKey.slice(2), TOKEN]);
  }, 180_000);

  test("allowlist に入らない loopback（localhost）の facilitator では子の Router が起動しない（入口は固定文で止まる。token は出ない）", async () => {
    const before = await calls(facilitator);
    const dir = workDir("e4-entry-refuse-");
    const outboundKey = generatePrivateKey();
    // 起動してしまう（拒否が効かない）場合に試験が止まらないよう、期限つきで待つ（期限で子は殺される）。終了の前に listening が出れば失敗。
    let failure: unknown;
    try {
      const unexpected = await startListening("tools/evm-testnets-run.ts", ["--chains", "rh"], hostEnvOf(`http://localhost:${facilitator.port}/${TOKEN}`, providers, path.join(dir, "journal.ndjson"), outboundKey), { listenTimeoutMs: 60_000 });
      await unexpected.stop();
    } catch (error) {
      failure = error;
    }
    const output = String((failure as Error | undefined)?.message);
    expect(output).toMatch(/^exited before listening: tools\/evm-testnets-run\.ts/);
    expect(output).toContain("could not start the Router");
    noSecrets(output, [outboundKey.slice(2), TOKEN]);
    expect(await calls(facilitator)).toMatchObject({ verifyCalls: before["verifyCalls"], settleCalls: before["settleCalls"] });
  }, 120_000);
});

describe("試験用の入口（同じ計画・同じ能力の組み立て＋Provider A への transport の差し替え）: 受信 route の購入と §3.6 の期限", () => {
  let tls: TlsMaterial;
  beforeAll(() => {
    tls = generateTestTls({ extraProviderNames: [PROVIDER_A_HOST] });
  });
  afterAll(() => tls.cleanup());

  test("期限の内の settle は delivered、期限を越えた settle は unknown。同じ journal で再起動しても unknown のまま、settle の再送は無い", async () => {
    const outboundKey = generatePrivateKey();
    const routerAddress = privateKeyToAccount(outboundKey).address;
    // 共有の facilitator: 1 回目の settle は 1 秒後、2 回目は Router の受信の期限（rh: 20 秒。§3.6）を越えて 22 秒後に答える。
    expect(await calls(facilitator)).toMatchObject({ verifyCalls: 0, settleCalls: 0 });
    const providerA: X402Upstream = await startX402Upstream(tls, PROVIDER_A_HOST);
    closers.push(() => providerA.close());
    providerA.state.accepts = [standardAccept({ payTo: PROVIDER_A, amount: "10000" })];
    providerA.state.pay = () => paidOk(routerAddress, { providerId: "synthetic-provider-a", data: { symbol: "ETH" } });
    const dir = workDir("e4-deadline-");
    const journalPath = path.join(dir, "journal.ndjson");
    const env = {
      ...hostEnvOf(`${facilitator.baseUrl}/${TOKEN}`, providers, journalPath, outboundKey),
      SUBETHA_TEST_DIAL_MAP: JSON.stringify({ [PROVIDER_A_HOST]: providerA.port }),
      SUBETHA_TEST_CA_PATH: path.join(tls.dir, "ca.pem"),
    };
    const startTestHost = () => startListening("tests/fixtures/evm-testnets-host.ts", ["--chains", "rh,arbsep,hyperevm,sepolia"], env, { listenTimeoutMs: 120_000 });
    let host = await startTestHost();
    closers.push(() => host.stop());

    const list = await callTool(host.port, "subetha_router_list_routes", {});
    expect((list["routes"] as Array<{ routeId: string }>).map((route) => route.routeId).sort()).toEqual([...ALL_ROUTES].sort());

    const payer = createX402Payer(generatePrivateKey());
    const buy = async (requestId: string) => {
      const quoted = await callTool(host.port, "subetha_router_quote", { routeId: "md-x402-eth-snapshot-rh", requestId });
      expect(quoted["ok"], JSON.stringify(quoted)).toBe(true);
      const quote = quoted["quote"];
      const offer = quote["source"]["offer"];
      // 受信の offer は表の domain（Global Dollar / 1）と rh の network・資産（E-1 の §3.2）。
      expect(offer).toMatchObject({ scheme: "exact", network: EVM_TESTNETS.rh.network, asset: EVM_TESTNETS.rh.asset, amount: "10000", payTo: RECEIVER, extra: { name: "Global Dollar", version: "1", fundsMoveOnCredential: false } });
      const credential = await payer.credentialFor(offer, 46630);
      const started = Date.now();
      const result = await callTool(host.port, "subetha_router_purchase", { quoteId: quote["quoteId"], requestId, approval: quote["quoteId"], quote, credential });
      return { result, quote, elapsedMs: Date.now() - started };
    };

    // 期限の内（1 秒）: settle → Provider A に払う → delivered。
    const first = await buy(`e4-deadline-ok-${Date.now()}`);
    expect(first.result, JSON.stringify(first.result)).toMatchObject({ ok: true, outcome: "delivered" });
    expect(await calls(facilitator)).toMatchObject({ verifyCalls: 1, settleCalls: 1 });
    expect(providerA.seen.payments).toHaveLength(1);
    const firstRequirements = (await calls(facilitator))["lastRequirements"];
    expect(firstRequirements).toMatchObject({ network: EVM_TESTNETS.rh.network, extra: { name: "Global Dollar", version: "1" } });

    // 期限を越える（22 秒 > 20 秒）: Router は待つのをやめて unknown（rejected ではない）。送信は始めない。
    const second = await buy(`e4-deadline-late-${Date.now()}`);
    expect(second.result, JSON.stringify(second.result)).toMatchObject({ outcome: "unknown" });
    expect(second.elapsedMs).toBeGreaterThanOrEqual(19_000);
    expect(second.elapsedMs).toBeLessThan(22_000);
    expect(providerA.seen.payments).toHaveLength(1);
    const paymentId = second.result["paymentId"] as string;
    expect(typeof paymentId).toBe("string");
    const status = await callTool(host.port, "subetha_router_status", { paymentId });
    expect(status["found"]).toBe(true);
    expect(JSON.stringify(status["projection"])).toMatch(/unknown/);
    // facilitator は遅れて答え終える（Router は既に切っている）。settle は 2 回だけ。
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await calls(facilitator)).toMatchObject({ verifyCalls: 2, settleCalls: 2 });

    // 同じ journal で Router を再起動（入口ごと）。unknown のまま、settle の再送は無い。1 件目は delivered のまま。
    await host.stop();
    host = await startTestHost();
    const reopened = await callTool(host.port, "subetha_router_status", { paymentId });
    expect(reopened["found"]).toBe(true);
    expect(reopened["projection"]).toEqual(status["projection"]);
    const firstReopened = await callTool(host.port, "subetha_router_status", { paymentId: first.result["paymentId"] });
    expect(JSON.stringify(firstReopened["projection"])).toMatch(/delivered/);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await calls(facilitator)).toMatchObject({ verifyCalls: 2, settleCalls: 2 });
    expect(providerA.seen.payments).toHaveLength(1);
    noSecrets(host.stdout() + host.stderr(), [outboundKey.slice(2), TOKEN]);
  }, 240_000);
});
