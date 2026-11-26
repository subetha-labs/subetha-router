/**
 * Base Sepolia 版の Provider（実際の Worker の handler）・自前の facilitator の核（chain は偽物）・Router（実 process）をつないだ wire 試験
 * （`docs/base-sepolia-facilitator-design.md` §5、AC-B5）: quote の後に facilitator が settle できなくなったら（保留・残高不足・手数料の上限超過）、
 * Router は受信の verify・settle を 1 回も呼ばない。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";

import { createEvmFacilitator, type ChainIo, type EvmFacilitator, type Hex, type JournalRecord } from "../../tools/evm-facilitator.js";
import { configDocument, credentialOf, DEST_PAY_TO, principalHeaders, purchaseOf, quoteOf, ROUTE_ID, startExactHarness, USDC, type ExactHarness } from "../fixtures/subetha-exact-harness.js";

vi.setConfig({ testTimeout: 90_000 });

const BASE = "eip155:84532";
const TOKEN = "t".repeat(40);
const FROM = "0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1";
const FAC = `http://127.0.0.1:8611/${TOKEN}`;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

interface Chain { balance: bigint; fee: bigint }
async function facilitatorOf(chain: Chain): Promise<EvmFacilitator> {
  const io: ChainIo = {
    maxLogRange: 5_000n, maxFeePerGas: 1_000_000_000n, gasCap: 10n ** 18n, maxSettleGas: 200_000n,
    reader: {
      authorizationState: async () => false, blockNumber: async () => 1n, blockTimestamp: async () => 1, authorizationUsedLogs: async () => [], receipt: async () => undefined, waitForReceipt: async () => undefined,
      feesPerGas: async () => ({ maxFeePerGas: chain.fee, maxPriorityFeePerGas: 1n }), estimateTransferGas: async () => 88_000n, nativeBalance: async () => chain.balance,
    },
    writer: { address: "0x54633d372d7316435891EEBBaAB90861F8c1Dadc", transferWithAuthorization: async () => `0x${"ab".repeat(32)}` as Hex },
    verify: async () => ({ isValid: true }),
  };
  const records: JournalRecord[] = [];
  const f = createEvmFacilitator({ networks: [BASE], chains: new Map([[BASE, io]]), journal: { load: async () => records, append: async (r) => void records.push(r) }, payToAllowlist: [DEST_PAY_TO] });
  await f.start();
  closers.push(async () => f.drain.close());
  return f;
}
const guard = { token: TOKEN, port: () => 8611 };
const headers = { host: "127.0.0.1:8611", "content-type": "application/json" };

/** 実際の Worker の handler を HTTP で出す（facilitator への fetch は核へ直接）。 */
async function workerOf(f: EvmFacilitator): Promise<string> {
  // Worker の source は自分の tsconfig を持つ（Cloudflare の型）ので、型検査の外で読む。
  const source = "../../providers/x402-workers/src/index.js";
  const worker: { runtimeOf(env: unknown, hooks: unknown): unknown; handle(r: Request, runtime: unknown, hooks: unknown): Promise<Response> } = await import(source);
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const r = await f.handle({ method: init?.method ?? "GET", url: String(input).slice("http://127.0.0.1:8611".length), headers, body: typeof init?.body === "string" ? init.body : "" }, guard);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
  // 控え（2 秒）は試験の時計で越える。
  let now = 1_000_000;
  const hooks = { fetch: fetchImpl, now: () => (now += 10_000) };
  const runtime = worker.runtimeOf({ PROVIDER_NETWORK: "base", PAY_TO: DEST_PAY_TO, FACILITATOR_URL: FAC, DATA_URL: "http://127.0.0.1:1/" }, hooks);
  const server = http.createServer((req, res) => {
    void (async () => {
      const response = await worker.handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method ?? "GET", headers: Object.entries(req.headers).map(([k, v]) => [k, String(v)] as [string, string]) }), runtime, { fetch: fetchImpl, now: () => now });
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(await response.text());
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  // 控えを越えさせる口: 要求ごとに時計を 10 秒進める。
  server.prependListener("request", () => void (now += 10_000));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function hold(f: EvmFacilitator): Promise<void> {
  const requirements = { scheme: "exact", network: BASE, asset: USDC, amount: "10000", payTo: DEST_PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };
  const authorization = { from: FROM, to: DEST_PAY_TO, value: "10000", validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 60), nonce: `0x${"01".repeat(32)}` };
  const body = JSON.stringify({ x402Version: 2, paymentPayload: { x402Version: 2, accepted: requirements, payload: { authorization, signature: `0x${"11".repeat(65)}` } }, paymentRequirements: requirements });
  expect((await f.handle({ method: "POST", url: `/${TOKEN}/settle`, headers, body }, guard)).status).toBe(504);
  expect(f.heldNetworks()).toEqual([BASE]);
}

async function boot(chain: Chain): Promise<{ h: ExactHarness; f: EvmFacilitator }> {
  const f = await facilitatorOf(chain);
  const upstream = await workerOf(f);
  const h = await startExactHarness({ skipRouter: true });
  closers.push(() => h.stopAll());
  await h.restartRouter({ config: configDocument(upstream) });
  return { h, f };
}

const CONDITIONS: ReadonlyArray<readonly [string, (f: EvmFacilitator, c: Chain) => Promise<void>]> = [
  ["保留", (f) => hold(f)],
  ["残高不足", async (_f, c) => void (c.balance = 0n)],
  ["手数料の上限超過", async (_f, c) => void (c.fee = 1_000_000_001n)],
];
test.each(CONDITIONS)("quote の後に%s: awaiting_payment／offer_unavailable、受信の verify・settle 0。次の quote は注文を作らない", async (_name, arrange) => {
  const chain: Chain = { balance: 10n ** 18n, fee: 7_000_000n };
  const { h, f } = await boot(chain);
  const quote = await quoteOf(h, "req-ready");
  expect(quote.status).toBe(200);
  await arrange(f, chain);
  // facilitator の控え（5 秒）を実時間で越える（保留は控えによらず直ちに効く）。
  await new Promise((r) => setTimeout(r, 5_100));
  const refused = await purchaseOf(h, quote.body, "req-ready", await credentialOf(h, quote.body.source.offer));
  expect(refused.body).toMatchObject({ error: "offer_unavailable", status: "awaiting_payment" });
  expect((await h.journal()).at(-1)).toMatchObject({ event: "source_failed", patch: { outcome: "not_sent", reason: "offer_unavailable" } });
  const calls = (await h.calls()).byRoute;
  for (const route of ["verify", "bind", "submit", "release"]) expect(calls[route], route).toBeUndefined();
  // 標準の x402 入口も、注文（402）の前に断る。
  const entry = await fetch(`${h.router.baseUrl}/x402/v1/routes/${ROUTE_ID}/resource`, { headers: principalHeaders() });
  expect(entry.status).not.toBe(402);
  expect(entry.headers.get("payment-required")).toBeNull();
  expect((await h.calls()).byRoute["create"]).toBe(1);
});
