/**
 * hosted の入口の全体（`docs/hosted-exact-enable-design.md` §13 の 5、要件 AC-2〜AC-4）: **本物の `startHost`** を process として起動し（`tests/fixtures/hosted-exact-host.ts`）、
 * その子の Router（実 `startRouter`）・合成 facilitator・x402 上流を相手に、公開の ingress だけを通して確かめる。
 * - 標準の x402 クライアントと MCP（quote → 署名 → purchase）の両方で購入
 * - 接続元を末尾に足す proxy（Caddy に当たる）の後ろでは、買い手が `X-Forwarded-For` を偽っても送信元ごとの枠は増えない
 * - 購入の途中で買い手が切れる → SIGTERM → drain の完了 → 同じ journal で再起動 → 同じ credential の再送が結果を返す（settle・上流への支払いは 1 回）
 * - drain の上限を過ぎる → `drain: timeout` → 再起動 → 結果は unknown のまま（402 にしない・settle をやり直さない）
 */
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

vi.setConfig({ testTimeout: 180_000 });

import { HOSTED_EXACT, OUTBOUND_X402 } from "../../tools/remote-mcp-config.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { startListening, type Listening } from "../fixtures/loopback.js";

const PROVIDER = "router-test";
const BEARER = "fixture-provider-token-hosted-01";
const CHAIN_ID = 84532;
const NETWORK = `eip155:${CHAIN_ID}`;
const ZUSDC = HOSTED_EXACT.source.asset;
const PATH = `/x402/v1/routes/${HOSTED_EXACT.routeId}/resource`;
const ORIGIN = "https://router.example.test";
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

interface World {
  readonly dir: string;
  readonly facilitator: Listening;
  readonly upstream: Listening;
  host: Listening;
  readonly hostEnv: Record<string, string>;
  restart(extra?: Record<string, string>): Promise<void>;
  journal(): Promise<{ paymentId: string; event: string; patch: Record<string, unknown> }[]>;
  calls(): Promise<{ byRoute: Record<string, number> }>;
  upstreamPays(): Promise<number>;
  setMode(route: string, mode: string): Promise<void>;
}
const worlds: World[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const w of worlds.splice(0)) {
    await w.host.stop().catch(() => undefined);
    await Promise.all([w.facilitator.stop(), w.upstream.stop()]);
    await rm(w.dir, { recursive: true, force: true });
  }
});
async function boot(extraEnv: Record<string, string> = {}): Promise<World> {
  await mkdir(runtimeRoot, { recursive: true });
  const dir = await mkdtemp(path.join(runtimeRoot, "hx-host-"));
  const tokenFile = path.join(dir, "provider.token");
  await writeFile(tokenFile, `${BEARER}\n`, { mode: 0o600 });
  const facilitator = await startListening("tests/fixtures/subetha-exact-facilitator.ts", ["--provider-id", PROVIDER, "--bearer", BEARER, "--chain-id", String(CHAIN_ID), "--asset", ZUSDC, "--ttl-seconds", "300"]);
  const upstream = await startListening("tests/fixtures/x402-upstream.ts", ["--pay", "ok", "--asset", OUTBOUND_X402.asset, "--pay-to", OUTBOUND_X402.payTo]);
  const journalPath = path.join(dir, "journal.ndjson");
  const hostEnv: Record<string, string> = {
    SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(),
    SUBETHA_ROUTER_RECEIVER: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405",
    SUBETHA_EXACT_FACILITATOR_URL: `${facilitator.baseUrl}/p/${PROVIDER}`,
    SUBETHA_EXACT_TOKEN_FILE: tokenFile,
    SUBETHA_DIAGNOSTICS: "off",
    HX_JOURNAL: journalPath,
    HX_ORIGIN: ORIGIN,
    HX_TEST_UPSTREAM: `${upstream.baseUrl}/v1/eth/snapshot`,
    ...extraEnv,
  };
  const start = (extra: Record<string, string> = {}) => startListening("tests/fixtures/hosted-exact-host.ts", [], { ...hostEnv, ...extra }, { listenTimeoutMs: 60_000 });
  const rows = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { paymentId: string; event: string; patch: Record<string, unknown> });
  const world: World = {
    dir,
    facilitator,
    upstream,
    host: await start(),
    hostEnv,
    async restart(extra = {}) {
      world.host = await start(extra);
    },
    journal: () => rows(journalPath),
    calls: async () => (await (await fetch(`${facilitator.baseUrl}/_fixture/calls`)).json()) as { byRoute: Record<string, number> },
    upstreamPays: async () => ((await (await fetch(`${upstream.baseUrl}/calls`)).json()) as { payCalls: number }).payCalls,
    async setMode(route, mode) {
      const response = await fetch(`${facilitator.baseUrl}/_fixture/mode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route, mode }) });
      if (response.status !== 200) throw new Error("setMode failed");
    },
  };
  worlds.push(world);
  return world;
}
/** MCP の tool を公開の ingress から呼ぶ（ステートレスの JSON-RPC）。 */
async function mcp(baseUrl: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const raw = await response.text();
  const envelope = JSON.parse(raw.match(/\{"result".*\}|\{"jsonrpc".*\}/s)![0]) as { result: { content: { text: string }[] } };
  return JSON.parse(envelope.result.content[0]!.text) as Record<string, unknown>;
}
const AUTH_TYPES = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] } as const;
/** 標準クライアントと同じ形の credential を、402 の requirements から作る。 */
async function signedHeader(required: Response): Promise<string> {
  const accepted = (decodePaymentRequiredHeader(required.headers.get("payment-required")!) as unknown as { accepts: Record<string, unknown>[] }).accepts[0]!;
  const account = privateKeyToAccount(generatePrivateKey());
  const extra = accepted["extra"] as { name: string; version: string };
  const authorization = { from: account.address, to: accepted["payTo"] as `0x${string}`, value: String(accepted["amount"]), validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + Number(accepted["maxTimeoutSeconds"])), nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}` };
  const signature = await account.signTypedData({ domain: { name: extra.name, version: extra.version, chainId: CHAIN_ID, verifyingContract: ZUSDC as `0x${string}` }, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) } });
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { authorization, signature } }), "utf8").toString("base64");
}
/** 購入の途中（verify が保留）で買い手の socket を切る。 */
async function disconnectDuringVerify(w: World, header: string): Promise<void> {
  const { port } = new URL(w.host.baseUrl);
  const socket = net.connect(Number(port), "127.0.0.1", () => socket.write(`GET ${PATH} HTTP/1.1\r\nHost: x\r\nPAYMENT-SIGNATURE: ${header}\r\n\r\n`));
  const until = Date.now() + 15_000;
  while (((await w.calls()).byRoute["verify"] ?? 0) === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  socket.destroy();
}
async function terminate(w: World): Promise<string> {
  await w.host.kill("SIGTERM");
  return w.host.stderr();
}

test("本物の入口: 標準の x402 クライアントが公開の URL だけで買え、MCP（list → quote → 署名 → purchase）でも買える。一覧は公開の URL と実証の注記を出す", async () => {
  const w = await boot();
  // 標準クライアント: signer・network・zUSDC を払ってよい資産に足す設定だけ。
  const account = privateKeyToAccount(generatePrivateKey());
  let signatures = 0;
  const signer = { address: account.address, signTypedData: async (args: Parameters<typeof account.signTypedData>[0]) => { signatures += 1; return account.signTypedData(args); } };
  const client = x402Client.fromConfig({
    schemes: [{ network: NETWORK as `${string}:${string}`, client: new ExactEvmScheme(signer as never) }],
    spendControls: { allowedAssets: [{ network: NETWORK as `${string}:${string}`, asset: ZUSDC, maxAmountPerPayment: "20000" }] },
  });
  const statuses: number[] = [];
  let resourceUrl = "";
  const recording: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    statuses.push(response.status);
    const required = response.headers.get("payment-required");
    if (required !== null) resourceUrl = (decodePaymentRequiredHeader(required) as unknown as { resource: { url: string } }).resource.url;
    return response;
  };
  const response = await wrapFetchWithPayment(recording, client)(`${w.host.baseUrl}${PATH}`);
  expect([response.status, statuses, signatures, resourceUrl]).toEqual([200, [402, 200], 1, `${ORIGIN}${PATH}`]);
  expect(((await response.json()) as { data: { price: string } }).data.price).toBe("3000.12");

  // MCP: 一覧 → quote → 署名（`npm run sign` と同じ封筒）→ purchase。
  const listing = await mcp(w.host.baseUrl, "subetha_router_list_routes", {});
  const row = (listing["routes"] as Record<string, unknown>[]).find((r) => r["routeId"] === HOSTED_EXACT.routeId)!;
  expect(row).toMatchObject({ x402Url: `${ORIGIN}${PATH}`, demonstration: { capped: true, acceptingNewOffers: true } });
  expect(String(listing["demonstrationNote"])).toContain("capped demonstration");
  const quoted = await mcp(w.host.baseUrl, "subetha_router_quote", { routeId: HOSTED_EXACT.routeId, requestId: "mcp-1" });
  expect(String(quoted["nextStep"])).toContain("SubEtha v2 facilitator order");
  const quote = quoted["quote"] as { quoteId: string; source: { offer: Parameters<ReturnType<typeof createX402Payer>["credentialFor"]>[0] } };
  const credential = await createX402Payer(generatePrivateKey()).credentialFor(quote.source.offer, CHAIN_ID);
  const purchased = await mcp(w.host.baseUrl, "subetha_router_purchase", { quoteId: quote.quoteId, requestId: "mcp-1", approval: quote.quoteId, quote, credential });
  expect(purchased).toMatchObject({ ok: true, outcome: "delivered" });
  const calls = await w.calls();
  expect([calls.byRoute["create"], calls.byRoute["settle"], await w.upstreamPays()]).toEqual([2, 2, 2]);
  // 標準入口の購入は結び付けの行を持つ。MCP の購入は持たない（入口が違う）。
  const events = (await w.journal()).map((r) => r.event);
  expect(events.filter((e) => e === "source_credential_bound")).toHaveLength(1);
  expect(events.filter((e) => e === "delivered")).toHaveLength(2);
});

test("接続元を末尾に足す proxy の後ろ: 買い手が `X-Forwarded-For` を偽っても、送信元ごとの枠は増えない（4 回目は 429、注文は 3 つ）", async () => {
  const w = await boot();
  // Caddy に当たる最小の proxy: 受けた `X-Forwarded-For` の**末尾に**接続元を足して入口に渡す。
  const target = new URL(w.host.baseUrl);
  const proxy = http.createServer((request, response) => {
    const incoming = request.headers["x-forwarded-for"];
    const chain = [...(typeof incoming === "string" ? [incoming] : []), request.socket.remoteAddress ?? ""].join(", ");
    const forward = http.request({ host: target.hostname, port: target.port, path: request.url, method: request.method, headers: { ...request.headers, "x-forwarded-for": chain } }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    request.pipe(forward);
  });
  servers.push(proxy);
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
  const publicUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const statuses: number[] = [];
  for (const spoofed of ["203.0.113.1", "203.0.113.2", "198.51.100.3", "192.0.2.4, 192.0.2.5"]) {
    statuses.push((await fetch(`${publicUrl}${PATH}`, { headers: { "x-forwarded-for": spoofed } })).status);
  }
  expect(statuses).toEqual([402, 402, 402, 429]);
  expect((await w.calls()).byRoute["create"]).toBe(3);
});

test("購入の途中で買い手が切れる → SIGTERM → drain の完了 → 同じ journal で再起動 → 同じ credential の再送が結果を返す。settle と上流への支払いは 1 回", async () => {
  const w = await boot();
  const header = await signedHeader(await fetch(`${w.host.baseUrl}${PATH}`));
  await w.setMode("verify", "slow:1500");
  await disconnectDuringVerify(w, header);
  // 入れ替えに当たる停止: 入口は進行中の購入の終わりを待ってから子を止める。
  const log = await terminate(w);
  expect(log).toMatch(/drain: complete [0-9a-f]{16}/);
  expect(log).not.toContain("drain: timeout");
  expect((await w.journal()).map((r) => r.event)).toContain("delivered");
  await w.setMode("verify", "ok");
  await w.restart();
  const again = await fetch(`${w.host.baseUrl}${PATH}`, { headers: { "PAYMENT-SIGNATURE": header } });
  expect(again.status).toBe(200);
  expect(((await again.json()) as { data: { price: string } }).data.price).toBe("3000.12");
  const calls = await w.calls();
  expect([calls.byRoute["verify"], calls.byRoute["settle"], await w.upstreamPays()]).toEqual([1, 1, 1]);
  // 受付停止（上限 0）で起動し直しても、同じ credential の再送は結果を返し、新しい offer は 503。
  await w.host.kill("SIGTERM");
  await w.restart({ HX_MAX_COMMITTED: "0" });
  expect((await fetch(`${w.host.baseUrl}${PATH}`, { headers: { "PAYMENT-SIGNATURE": header } })).status).toBe(200);
  const stopped = await fetch(`${w.host.baseUrl}${PATH}`);
  expect([stopped.status, ((await stopped.json()) as { reason: string }).reason, stopped.headers.get("payment-required")]).toEqual([503, "offer_cap_reached", null]);
  expect((await w.calls()).byRoute["settle"]).toBe(1);
});

test("drain の上限を過ぎる → `drain: timeout`。再起動の後、結果は unknown のまま: 同じ credential の再送は 409（402 ではない）、verify・settle をやり直さない", async () => {
  const w = await boot({ HX_DRAIN_TIMEOUT_MS: "1500" });
  const header = await signedHeader(await fetch(`${w.host.baseUrl}${PATH}`));
  await w.setMode("verify", "slow:60000");
  await disconnectDuringVerify(w, header);
  const log = await terminate(w);
  expect(log).toMatch(/drain: timeout [0-9a-f]{16}/);
  expect(log).not.toContain("drain: complete");
  await w.setMode("verify", "ok");
  await w.restart();
  const before = await w.calls();
  const again = await fetch(`${w.host.baseUrl}${PATH}`, { headers: { "PAYMENT-SIGNATURE": header } });
  const body = (await again.json()) as Record<string, unknown>;
  expect([again.status, body["error"], body["status"], again.headers.get("payment-required")]).toEqual([409, "payment_unresolved", "unknown", null]);
  expect((body["source"] as Record<string, unknown>)["awaitingPaymentDoesNotMeanUnpaid"]).toBe(true);
  const after = await w.calls();
  expect([after.byRoute["verify"], after.byRoute["settle"] ?? 0, await w.upstreamPays()]).toEqual([before.byRoute["verify"], 0, 0]);
});
