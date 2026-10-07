/**
 * 動的上流 URL の統合試験（タスク T14。要件 §6 の AC のうち複数の部品をまたぐもの）。
 *
 * **製品の配線（`composeRails`）をそのまま使う**: 実 adapter（x402・MPP の送信と受信）、実鍵（毎回の乱数）、実 SDK、
 * SSRF 防御 A の transport（loopback 不可・DNS 期限・門）に、試験の差し替え（名前解決と接続先）だけを足す。
 * 相手は T6 の fixture（TLS の上流 2 つ・署名を検証する facilitator・実形の receipt を返す Tempo RPC）。資金は動かない。
 * 呼び出し側は製品の client と、呼び出し側が実際に使う支払いツール（`tools/x402-payer.ts`・`tools/mpp-payer.ts`）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress, verifyTypedData } from "viem";
import { TxEnvelopeTempo } from "ox/tempo";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createRouterClient } from "../../src/client/index.js";
import type { QuoteView, RouterClient } from "../../src/client/types.js";
import { DEFAULT_DYNAMIC_LIMITS, loadRuntimeConfig, type RuntimeConfig } from "../../src/config.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";
import { createRouterCore, type RouterCore } from "../../src/core/orchestrator.js";
import { startHttpServer, type RunningServer } from "../../src/http/app.js";
import { composeRails, dynamicCoreOptionsOf, type DynamicTransportHooks, type RouterCapabilities } from "../../src/main.js";
import type { TransportEvent } from "../../src/net/guarded-fetch.js";
import { createMppPayer } from "../../tools/mpp-payer.js";
import { createRealEvmCapability } from "../../tools/real-evm-capability.js";
import { createRealMppCapability } from "../../tools/real-mpp-capability.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { FIXTURE_PUBLIC_ADDRESS, UnmappedFixtureHostError } from "../fixtures/dynamic/dial.js";
import { MPP_FIXTURE_CHAIN_ID, MPP_FIXTURE_CURRENCY, MPP_FIXTURE_RECIPIENT, startMppUpstream, type MppUpstream } from "../fixtures/dynamic/mpp-upstream.js";
import { startTempoRpc, type TempoRpc } from "../fixtures/dynamic/tempo-rpc.js";
import { startVerifyingFacilitator, type VerifyingFacilitator } from "../fixtures/dynamic/verifying-facilitator.js";
import { FIXTURE_ASSET, FIXTURE_NETWORK, paidOk, standardAccept, startX402Upstream, type X402Upstream } from "../fixtures/dynamic/x402-upstream.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const PATHUSD = MPP_FIXTURE_CURRENCY;
const USDC = FIXTURE_ASSET;
const X402_PROFILE = "dyn-mpp-to-x402";
const MPP_PROFILE = "dyn-x402-to-mpp";
const STATIC_ROUTE = "r-static";
/** 動的 quote と同額（2000）の静的 route（AC-5 の静的↔動的の同額の対照用）。 */
const STATIC_SMALL_ROUTE = "r-static-small";
const X402_URL = "https://provider.test/v1/price?symbol=ETH";
const MPP_URL = "https://mpp.provider.test/v1/price";
const HOSTS = { x402: "provider.test", mpp: "mpp.provider.test", facilitator: "facilitator.other.test", rpc: "rpc.other.test", static: "static.provider.test" } as const;
const STATIC_URL = `https://${HOSTS.static}/v1/x`;

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => {
  TLS.cleanup();
});

interface Fixtures {
  readonly x402: X402Upstream;
  readonly mpp: MppUpstream;
  readonly facilitator: VerifyingFacilitator;
  readonly rpc: TempoRpc;
  /** 名前 → アドレス（試験が変えられる。既定は公開アドレス）。 */
  readonly resolve: Map<string, string[]>;
  /** 接続先の差し替え表（名前 → port）。 */
  readonly ports: Map<string, number>;
  /** 接続しようとしたホスト名（順）。 */
  readonly dialed: string[];
}

interface Router {
  readonly core: RouterCore;
  readonly server: RunningServer;
  readonly baseUrl: string;
  readonly journalPath: string;
  readonly config: RuntimeConfig;
  readonly events: TransportEvent[];
  readonly payerAddress: { x402: `0x${string}`; mpp: `0x${string}` };
  /** 運用者の鍵が署名した回数（x402: EIP-3009、mpp: Tempo transaction）。 */
  signatures(): { x402: number; mpp: number };
  client(source?: string): RouterClient;
  close(): Promise<void>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  // 1 つが失敗しても残りを片付ける。
  const failures: unknown[] = [];
  while (closers.length > 0) {
    try {
      await closers.pop()!();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
});

async function startFixtures(): Promise<Fixtures> {
  const rpc = await startTempoRpc({ tls: TLS });
  closers.push(rpc.close);
  const x402 = await startX402Upstream(TLS, HOSTS.x402);
  closers.push(x402.close);
  const mpp = await startMppUpstream(TLS, rpc.plainUrl, HOSTS.mpp);
  closers.push(mpp.close);
  const facilitator = await startVerifyingFacilitator({ tls: TLS });
  closers.push(facilitator.close);
  // 静的 route の上流も同じ TLS の x402 fixture（別の名前で）。
  const ports = new Map<string, number>([[HOSTS.x402, x402.port], [HOSTS.mpp, mpp.port], [HOSTS.facilitator, facilitator.port], [HOSTS.rpc, rpc.port], [HOSTS.static, x402.port]]);
  return { x402, mpp, facilitator, rpc, resolve: new Map(), ports, dialed: [] };
}

function hooksOf(fixtures: Fixtures): DynamicTransportHooks {
  return {
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: (hostname, _options, callback) => {
      const addresses = fixtures.resolve.get(hostname) ?? [FIXTURE_PUBLIC_ADDRESS];
      callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
    },
    dialForTest: (target) => {
      fixtures.dialed.push(target.hostname);
      const port = fixtures.ports.get(target.hostname);
      if (port === undefined) throw new UnmappedFixtureHostError();
      return { host: "127.0.0.1", port };
    },
  };
}

interface RouterOptions {
  readonly enabled?: boolean;
  readonly limits?: Partial<typeof DEFAULT_DYNAMIC_LIMITS>;
  readonly maxPurchases?: number;
  readonly dir?: string;
  readonly keys?: { x402: `0x${string}`; mpp: `0x${string}` };
}

async function startRouter(fixtures: Fixtures, options: RouterOptions = {}): Promise<Router> {
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = options.dir ?? mkdtempSync(path.join(runtimeRoot, "t14-dynamic-"));
  if (options.dir === undefined) closers.push(async () => rmSync(dir, { recursive: true, force: true }));
  const document = {
    router: {
      approvalTtlMs: 60_000,
      routes: {
        [STATIC_ROUTE]: {
          routeId: STATIC_ROUTE,
          canonicalPath: `/v1/routes/${STATIC_ROUTE}/resource`,
          rail: "x402",
          sourceRail: "x402",
          source: { amount: "10000", asset: USDC, decimals: 6, network: FIXTURE_NETWORK, payTo: RECEIVER },
          destination: { scheme: "exact", network: FIXTURE_NETWORK, asset: USDC, payTo: "0x0000000000000000000000000000000000000a11" },
        },
        [STATIC_SMALL_ROUTE]: {
          routeId: STATIC_SMALL_ROUTE,
          canonicalPath: `/v1/routes/${STATIC_SMALL_ROUTE}/resource`,
          rail: "x402",
          sourceRail: "x402",
          source: { amount: "2000", asset: USDC, decimals: 6, network: FIXTURE_NETWORK, payTo: RECEIVER },
          destination: { scheme: "exact", network: FIXTURE_NETWORK, asset: USDC, payTo: "0x0000000000000000000000000000000000000a11" },
        },
      },
      budget: { maxPurchases: 8, buckets: [{ network: FIXTURE_NETWORK, asset: USDC, maxTotal: "1000000", maxPerPurchase: "20000" }] },
      dynamic: {
        enabled: options.enabled ?? true,
        profiles: {
          [MPP_PROFILE]: {
            profileId: MPP_PROFILE,
            sourceRail: "x402",
            source: { network: FIXTURE_NETWORK, asset: USDC, decimals: 6, payTo: RECEIVER },
            rail: "mpp",
            // 手数料は quote 時のガス代の見積りで決まる（`docs/dynamic-gas-fee-design.md`）。fixture の RPC の既定（baseFee 6e8）では bound 79 → cap 158（2 倍）。天井 5,000。
            destination: { scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: PATHUSD, decimals: 6, feeAsset: PATHUSD, maxFee: "5000", feeMargin: 20_000 },
            par: true,
            maxUpstreamAmount: "10000",
            fee: { flat: "1000", bps: 0, min: "1000" },
          },
          [X402_PROFILE]: {
            profileId: X402_PROFILE,
            sourceRail: "mpp",
            source: { network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: PATHUSD, decimals: 6, payTo: RECEIVER },
            rail: "x402",
            destination: { scheme: "exact", network: FIXTURE_NETWORK, asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
            par: true,
            maxUpstreamAmount: "10000",
            fee: { flat: "1000", bps: 0, min: "1000" },
          },
        },
        budget: {
          maxPurchases: options.maxPurchases ?? 50,
          buckets: [
            { network: FIXTURE_NETWORK, asset: USDC, maxTotal: "10000000", maxPerPurchase: "20000" },
            { network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: PATHUSD, maxTotal: "10000000", maxPerPurchase: "20000" },
          ],
        },
        limits: { ...DEFAULT_DYNAMIC_LIMITS, quotesPerMinuteGlobal: 1000, quotesPerMinutePerSource: 1000, purchasesPerMinuteGlobal: 1000, purchasesPerMinutePerSource: 1000, perHostPerMinute: 1000, perAddressPerMinute: 1000, perAddressConcurrent: 64, perHostConcurrent: 64, concurrentGlobal: 64, concurrentPerSource: 64, ...options.limits },
        denyHosts: [],
      },
    },
    x402: { upstreams: { [STATIC_ROUTE]: STATIC_URL, [STATIC_SMALL_ROUTE]: `https://${HOSTS.static}/v1/small` } },
  };
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  const journalPath = path.join(dir, "journal.ndjson");
  const config = loadRuntimeConfig(
    {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha.other.test",
      ROUTER_X402_INBOUND_FACILITATOR_URL: `https://${HOSTS.facilitator}`,
      ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-integration",
      ROUTER_MPP_INBOUND_RPC_URL: `https://${HOSTS.rpc}`,
      ROUTER_CANONICAL_BASE_URL: "https://router.test",
      ROUTER_JOURNAL_PATH: journalPath,
    },
    (file) => readFileSync(file, "utf8"),
    { networks: TEST_NETWORKS },
  );
  const keys = options.keys ?? { x402: generatePrivateKey(), mpp: generatePrivateKey() };
  const evm = createRealEvmCapability(keys.x402);
  const mppCapability = createRealMppCapability(keys.mpp, { rpcUrl: `https://${HOSTS.rpc}` });
  // MPP の署名の回数は、能力の account を包んで数える（実装は変えない。署名は実鍵）。
  const mppBase = mppCapability.capability();
  let mppSignatures = 0;
  const countingAccount = {
    ...mppBase.account,
    signTransaction: async (transaction: unknown, options?: unknown) => {
      mppSignatures += 1;
      return (mppBase.account as unknown as { signTransaction(t: unknown, o?: unknown): Promise<`0x${string}`> }).signTransaction(transaction, options);
    },
  };
  const capabilities: RouterCapabilities = {
    evmSigning: evm.capability(FIXTURE_NETWORK),
    mppTempo: { ...mppBase, account: countingAccount as never },
    dependencyUrls: [`https://${HOSTS.rpc}/`],
    dynamicTransportHooksForTest: hooksOf(fixtures),
    // 静的 route の transport も同じ fixture の網に閉じ込める（表に無い宛先には接続しない）。
    transportHooksForTest: hooksOf(fixtures),
  };
  const events: TransportEvent[] = [];
  const rails = composeRails(config, capabilities, (event) => events.push(event));
  const dialedBefore = fixtures.dialed.length;
  const methodsBefore = fixtures.rpc.methods.length;
  const sentBefore = fixtures.rpc.sentRaw.length;
  await rails.dynamic!.verify();
  // 起動時の確認は RPC に読取の probe を 1 回出す（`eth_fillTransaction`。`docs/dynamic-gas-fee-design.md` §4）。要求ごとの接続の数え方に混ぜない。
  // 2 回の RPC（block・fill）はそれぞれ接続する。RPC のホスト以外には出ない。
  const startupDials = fixtures.dialed.splice(dialedBefore);
  expect(startupDials.length).toBeGreaterThanOrEqual(1);
  expect(startupDials.every((host) => host === HOSTS.rpc)).toBe(true);
  // 見積りは baseFee（block）＋ fill の 2 回（設計 §8.2）。
  expect(fixtures.rpc.methods.splice(methodsBefore)).toEqual(["eth_getBlockByNumber", "eth_fillTransaction"]);
  expect(fixtures.rpc.sentRaw).toHaveLength(sentBefore);
  const core = await createRouterCore({
    journalPath,
    config: config.router,
    inbound: rails.inbound,
    outbound: rails.outbound,
    dynamic: { ledgerDir: path.join(dir, "dynamic-quotes"), ...dynamicCoreOptionsOf(rails.dynamic!, capabilities, config) },
  });
  const server = await startHttpServer({ core, config: config.router, canonicalBaseUrl: "https://router.test", principals: config.principals, host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const router: Router = {
    core,
    server,
    baseUrl,
    journalPath,
    config,
    events,
    payerAddress: { x402: evm.address, mpp: mppCapability.address },
    signatures: () => ({ x402: evm.signCount(), mpp: mppSignatures }),
    client: (source = "judge") => createRouterClient({ baseUrl, principalId: "judge", token: "public", allowUnissuedQuotes: true, source }),
    close: async () => {
      await server.close();
      await core.close();
    },
  };
  closers.push(router.close);
  return router;
}

/** 呼び出し側: quote に対する credential（x402 は署名だけ、MPP は fixture の RPC に実際に送金）。 */
async function credentialFor(fixtures: Fixtures, quote: QuoteView): Promise<string> {
  const offer = quote.source.offer as { amount: string; payTo: string; asset: string; network: string; extra: Record<string, unknown> };
  if (quote.routeId === MPP_PROFILE || quote.routeId === STATIC_ROUTE || quote.routeId === STATIC_SMALL_ROUTE) {
    return createX402Payer(generatePrivateKey()).credentialFor(offer as never, 84532);
  }
  const payer = createMppPayer(generatePrivateKey(), { chainId: MPP_FIXTURE_CHAIN_ID, asset: PATHUSD, payTo: RECEIVER, maxAmount: 1_000_000n }, { rpcUrl: fixtures.rpc.plainUrl });
  const paid = await payer.payAndCredential(offer);
  const envelope = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra["challengeNonce"], credential: paid.credential } };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

async function quoteOf(router: Router, profileId: string, url: string, requestId: string, source?: string): Promise<QuoteView> {
  const result = await router.client(source).quoteUrl({ profileId, url, requestId });
  if (!result.ok) throw new Error(`quote failed: ${result.error}`);
  return result.quote;
}

async function purchase(router: Router, quote: QuoteView, credential: string, requestId: string, source?: string) {
  return router.client(source).execute({ quote, requestId, approval: { approved: true, quoteId: quote.quoteId }, credential });
}

/** 送信の呼び出し回数（上流の fixture と RPC の fixture から数える）。 */
function outboundCalls(fixtures: Fixtures): { x402Payments: number; mppSends: number; mppCredentials: number } {
  return { x402Payments: fixtures.x402.seen.payments.length, mppSends: fixtures.rpc.sentRaw.length, mppCredentials: fixtures.mpp.seen.credentials };
}

function journalEvents(router: Router): string[] {
  return readFileSync(router.journalPath, "utf8").split("\n").filter((line) => line !== "").map((line) => (JSON.parse(line) as { event: string }).event);
}

/* ------------------------------------------------------------------ AC-2 */

describe("AC-2: 両方向の quote → purchase → delivered", () => {
  test("x402 で払って MPP の上流（Tempo pathUSD）に届く: 受信は署名を検証する facilitator、送信は実 SDK の push で fixture の RPC へ", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    expect(quote).toMatchObject({ routeId: MPP_PROFILE, upstream: { url: MPP_URL }, pricing: { upstreamAmount: "1000", fee: "1000", total: "2000" }, disclosures: { fundsMoveOnCredential: false } });
    const result = await purchase(router, quote, await credentialFor(fixtures, quote), "r1");
    expect(result).toMatchObject({ outcome: "delivered", snapshot: { ok: true } });
    expect(fixtures.facilitator.calls).toMatchObject({ verify: 1, settle: 1 });
    expect(outboundCalls(fixtures)).toEqual({ x402Payments: 0, mppSends: 1, mppCredentials: 1 });
    expect(fixtures.mpp.seen.verified).toBe(1);
    expect(fixtures.rpc.lastSender?.toLowerCase()).toBe(router.payerAddress.mpp.toLowerCase());
    // 接続先は fixture だけ（上流・facilitator・RPC）。
    expect(new Set(fixtures.dialed)).toEqual(new Set([HOSTS.mpp, HOSTS.facilitator, HOSTS.rpc]));
    const status = await router.client().status(quote.paymentId, quote.ownerKey);
    expect(status).toMatchObject({ found: true, projection: { status: "delivered", dynamic: { promoted: true } } });
  });

  test("MPP で払って x402 の上流（Base Sepolia USDC）に届く: 受信は実 SDK が fixture の RPC で receipt を照合、送信は EIP-3009 の署名", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    const quote = await quoteOf(router, X402_PROFILE, X402_URL, "r1");
    expect(quote).toMatchObject({ routeId: X402_PROFILE, pricing: { upstreamAmount: "1000", total: "2000" }, disclosures: { fundsMoveOnCredential: true, awaitingPaymentDoesNotMeanUnpaid: true } });
    const credential = await credentialFor(fixtures, quote);
    // 呼び出し側の送金は fixture の RPC に届いている（purchase の前に資金が動く）。
    expect(fixtures.rpc.sentRaw).toHaveLength(1);
    const result = await purchase(router, quote, credential, "r1");
    expect(result).toMatchObject({ outcome: "delivered", snapshot: { price: 1 } });
    expect(outboundCalls(fixtures)).toEqual({ x402Payments: 1, mppSends: 1, mppCredentials: 0 });
    const payment = fixtures.x402.seen.payments[0] as { accepted: unknown; payload: { signature: `0x${string}`; authorization: Record<string, string> } };
    expect(payment.accepted).toEqual(standardAccept());
    // 署名は運用者の鍵のもの（住所の申告ではなく、EIP-3009 の typed data に対する署名を検証する）。
    const a = payment.payload.authorization;
    expect(
      await verifyTypedData({
        address: router.payerAddress.x402,
        domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: getAddress(USDC) },
        types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
        primaryType: "TransferWithAuthorization",
        message: { from: getAddress(a["from"]!), to: getAddress(a["to"]!), value: BigInt(a["value"]!), validAfter: BigInt(a["validAfter"]!), validBefore: BigInt(a["validBefore"]!), nonce: a["nonce"] as `0x${string}` },
        signature: payment.payload.signature,
      }),
    ).toBe(true);
    expect(router.signatures()).toEqual({ x402: 1, mpp: 0 });
    // 受信の照合（MPP の RPC）は動的用 transport を通った（RPC のホストに接続した）。
    expect(fixtures.dialed).toContain(HOSTS.rpc);
    expect(new Set(fixtures.dialed)).toEqual(new Set([HOSTS.x402, HOSTS.rpc]));
  });
});

/* ------------------------------------------------------------------ AC-5 */

/** credential（base64 の封筒）を別の quote の封筒に入れ替える（署名・送金はそのまま）。 */
function rebind(credential: string, into: QuoteView, patch: (payload: Record<string, unknown>) => Record<string, unknown> = (p) => p): string {
  const decoded = JSON.parse(Buffer.from(credential, "base64").toString("utf8")) as { payload: Record<string, unknown> };
  const offer = into.source.offer as { extra: Record<string, unknown> };
  const envelope = { x402Version: 2, accepted: into.source.offer, payload: patch({ ...decoded.payload, challengeNonce: offer.extra["challengeNonce"] }) };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

describe("AC-5: 1 回の受信支払いで送信の呼び出しは高々 1 回", () => {
  test("x402 受信: A の署名を B の封筒に入れ替えても（同額・異額・静的 route・nonce も書き換え）送信は 1 回のまま。再起動後も", async () => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t14-ac5-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    let router = await startRouter(fixtures, { dir, keys });
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    const a = await quoteOf(router, MPP_PROFILE, MPP_URL, "a");
    const credential = await credentialFor(fixtures, a);
    expect((await purchase(router, a, credential, "a")).outcome).toBe("delivered");
    expect(outboundCalls(fixtures)).toMatchObject({ mppSends: 1, mppCredentials: 1 });
    expect(fixtures.facilitator.calls).toMatchObject({ verify: 1, settle: 1 });
    expect(router.signatures()).toEqual({ x402: 0, mpp: 1 });

    // (1) 同じ quote に同じ credential → 既存の結果。
    expect((await purchase(router, a, credential, "a")).outcome).toBe("delivered");
    // (2) 同額の B・(3) 異額の C の封筒に A の署名（authorization は A のまま）→ 署名の nonce が B の nonce と違う（束縛つき preflight）。
    const b = await quoteOf(router, MPP_PROFILE, MPP_URL, "b");
    expect(await purchase(router, b, rebind(credential, b), "b")).toMatchObject({ outcome: "payment_required", error: "nonce_mismatch" });
    fixtures.mpp.state.amount = "2000";
    const c = await quoteOf(router, MPP_PROFILE, MPP_URL, "c");
    expect(await purchase(router, c, rebind(credential, c), "c")).toMatchObject({ outcome: "payment_required", error: "nonce_mismatch" });
    fixtures.mpp.state.amount = "1000";
    // (4) nonce の欄も B のものに書き換える → preflight は通るが、署名が合わないので facilitator が拒否する（verify_failed）。
    const forged = rebind(credential, b, (payload) => ({ ...payload, authorization: { ...(payload["authorization"] as Record<string, unknown>), nonce: (b.source.offer as { extra: { challengeNonce: string } }).extra.challengeNonce } }));
    expect(await purchase(router, b, forged, "b")).toMatchObject({ outcome: "payment_required", error: "verify_failed" });
    expect(fixtures.facilitator.calls).toMatchObject({ verify: 2, settle: 1 });
    expect(fixtures.facilitator.calls.reasons).toContain("invalid_signature");
    // (5) 静的 route（額 10000）: A の署名（額 2000）を静的 quote の封筒に。静的の受信は nonce を束縛しないので preflight は通り、
    //     facilitator が額の不一致で落とす（署名そのものは有効）。
    const s = await router.client().quote({ routeId: STATIC_ROUTE, requestId: "s" });
    expect(s.ok).toBe(true);
    const sq = (s as { quote: QuoteView }).quote;
    expect(await purchase(router, sq, rebind(credential, sq), "s")).toMatchObject({ outcome: "payment_required", error: "verify_failed" });
    expect(fixtures.facilitator.calls.reasons.at(-1)).toBe("amount");
    // (5') 同額の静的 route（額 2000 の動的 quote の署名を、同額の静的 quote の封筒に）: 署名は有効で額も合うので facilitator は通すが、
    //     A の nonce は既に使われている（settle 済み）ので replay として落ちる。静的の受信が nonce を束縛しない限界はここに現れる
    //     （未使用の署名なら通る）。送信は増えない。
    const sameAmountStatic = (await router.client().quote({ routeId: STATIC_SMALL_ROUTE, requestId: "ss" })) as { quote: QuoteView };
    expect(await purchase(router, sameAmountStatic.quote, rebind(credential, sameAmountStatic.quote), "ss")).toMatchObject({ outcome: "payment_required", error: "verify_failed" });
    expect(fixtures.facilitator.calls.reasons.at(-1)).toBe("nonce_used");
    // (6) 静的 quote の署名を動的 quote の封筒に → 束縛つき preflight が止める。
    const staticCredential = await credentialFor(fixtures, sq);
    expect(await purchase(router, b, rebind(staticCredential, b), "b")).toMatchObject({ outcome: "payment_required", error: "nonce_mismatch" });
    // 正の対照: 静的 quote は自分の credential で成立する（静的の送信も 1 回）。静的は verify の失敗で quote が終端になるので、新しい quote で。
    const s2 = (await router.client().quote({ routeId: STATIC_ROUTE, requestId: "s2" })) as { quote: QuoteView };
    expect((await purchase(router, s2.quote, await credentialFor(fixtures, s2.quote), "s2")).outcome).toBe("delivered");
    expect(fixtures.x402.seen.payments).toHaveLength(1);
    expect(outboundCalls(fixtures)).toMatchObject({ mppSends: 1, mppCredentials: 1 });
    expect(fixtures.facilitator.calls.settle).toBe(2);

    // 再起動（journal の再オープン）後も同じ。
    await router.close();
    closers.splice(closers.indexOf(router.close), 1);
    router = await startRouter(fixtures, { dir, keys });
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    expect((await purchase(router, a, credential, "a")).outcome).toBe("delivered");
    expect(await purchase(router, b, rebind(credential, b), "b")).toMatchObject({ outcome: "payment_required", error: "nonce_mismatch" });
    expect(await purchase(router, b, forged, "b")).toMatchObject({ outcome: "payment_required", error: "verify_failed" });
    expect(outboundCalls(fixtures)).toMatchObject({ mppSends: 1, mppCredentials: 1 });
    expect(fixtures.x402.seen.payments).toHaveLength(1);
    expect(fixtures.facilitator.calls.settle).toBe(2);
    expect(router.signatures()).toEqual({ x402: 0, mpp: 0 });
  });

  test("MPP 受信: A の送金（wire credential）を B の封筒に入れ替えても送信は 1 回のまま。再起動後も", async () => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t14-ac5m-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    let router = await startRouter(fixtures, { dir, keys });
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    const a = await quoteOf(router, X402_PROFILE, X402_URL, "a");
    const credential = await credentialFor(fixtures, a);
    expect((await purchase(router, a, credential, "a")).outcome).toBe("delivered");
    expect(fixtures.x402.seen.payments).toHaveLength(1);
    expect(router.signatures().x402).toBe(1);
    const rpcBefore = fixtures.rpc.http.requests;
    // 同額の B に A の wire credential（中の challenge は A のもの）→ 埋め込まれた challenge id の照合で止まる。
    const b = await quoteOf(router, X402_PROFILE, X402_URL, "b");
    expect(await purchase(router, b, rebind(credential, b), "b")).toMatchObject({ outcome: "payment_required", error: "nonce_mismatch" });
    // 同じ quote への再提出 → 既存の結果。
    expect((await purchase(router, a, credential, "a")).outcome).toBe("delivered");
    expect(fixtures.x402.seen.payments).toHaveLength(1);
    expect(fixtures.rpc.http.requests).toBe(rpcBefore);
    await router.close();
    closers.splice(closers.indexOf(router.close), 1);
    router = await startRouter(fixtures, { dir, keys });
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    expect(await purchase(router, b, rebind(credential, b), "b")).toMatchObject({ outcome: "payment_required", error: "nonce_mismatch" });
    expect((await purchase(router, a, credential, "a")).outcome).toBe("delivered");
    expect(fixtures.x402.seen.payments).toHaveLength(1);
    expect(router.signatures().x402).toBe(0);
  });

  test("並行: 同じ quote への 2 つの purchase（A/A）は送信 1 回、別の quote 2 つ（A/B）は各 1 回。A の署名を B に持ち込む並行も送信は増えない", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    const a = await quoteOf(router, MPP_PROFILE, MPP_URL, "a");
    const b = await quoteOf(router, MPP_PROFILE, MPP_URL, "b");
    const ca = await credentialFor(fixtures, a);
    const cb = await credentialFor(fixtures, b);
    const [a1, a2, ab] = await Promise.all([purchase(router, a, ca, "a"), purchase(router, a, ca, "a"), purchase(router, b, rebind(ca, b), "b")]);
    expect([a1.outcome, a2.outcome]).toEqual(["delivered", "delivered"]);
    expect(ab).toMatchObject({ outcome: "payment_required", error: "nonce_mismatch" });
    expect(outboundCalls(fixtures)).toMatchObject({ mppSends: 1, mppCredentials: 1 });
    expect(fixtures.facilitator.calls.settle).toBe(1);
    const [b1, b2] = await Promise.all([purchase(router, b, cb, "b"), purchase(router, b, cb, "b")]);
    expect([b1.outcome, b2.outcome]).toEqual(["delivered", "delivered"]);
    expect(outboundCalls(fixtures)).toMatchObject({ mppSends: 2, mppCredentials: 2 });
    expect(router.signatures().mpp).toBe(2);
    // x402 側（MPP で払う）でも同じ。
    const x = await quoteOf(router, X402_PROFILE, X402_URL, "x");
    const y = await quoteOf(router, X402_PROFILE, X402_URL, "y");
    const cx = await credentialFor(fixtures, x);
    const cy = await credentialFor(fixtures, y);
    const results = await Promise.all([purchase(router, x, cx, "x"), purchase(router, x, cx, "x"), purchase(router, y, cy, "y"), purchase(router, y, rebind(cx, y), "y")]);
    expect(results.slice(0, 3).map((r) => r.outcome)).toEqual(["delivered", "delivered", "delivered"]);
    // 持ち込みは、先に本物が通っていれば既存の結果（delivered）、先なら拒否。どちらでも送信は y の 1 回だけ。
    expect(["delivered", "payment_required"]).toContain(results[3]!.outcome);
    expect(fixtures.x402.seen.payments).toHaveLength(2);
    expect(router.signatures().x402).toBe(2);
  });
});

/* ------------------------------------------------------------------ AC-6 */

describe("AC-6: 上流が offer を変えたら受信 settle・送信の署名・broadcast が 0", () => {
  test.each([
    ["scheme", standardAccept({ scheme: "upto" })],
    ["network", standardAccept({ network: "eip155:8453" })],
    ["asset", standardAccept({ asset: "0x0000000000000000000000000000000000000abc" })],
    ["額", standardAccept({ amount: "1001" })],
    ["受取先", standardAccept({ payTo: "0x0000000000000000000000000000000000000a12" })],
    ["maxTimeoutSeconds", standardAccept({ maxTimeoutSeconds: 61 })],
    ["extra.name", standardAccept({ extra: { name: "USD Coin", version: "2" } })],
    ["extra.version", standardAccept({ extra: { name: "USDC", version: "1" } })],
    ["説明の欄", standardAccept({ description: "new" })],
  ])("x402 の上流が %s を変えた: 受信 settle 0・署名 0・送信 0・journal 0 行", async (_name, changed) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, X402_PROFILE, X402_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    const rpcAfterCallerPayment = fixtures.rpc.http.requests;
    fixtures.x402.state.accepts = [changed];
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "rejected", error: "offer_changed", status: 409 });
    expect(router.signatures()).toEqual({ x402: 0, mpp: 0 });
    expect(fixtures.x402.seen.payments).toHaveLength(0);
    // 受信の照合（RPC）にも進んでいない（読み直しで止まる）。呼び出し側の送金の 1 件以外に RPC への送金は無い。
    expect(fixtures.rpc.http.requests).toBe(rpcAfterCallerPayment);
    expect(fixtures.rpc.sentRaw).toHaveLength(1);
    expect(journalEvents(router)).toEqual([]);
  });

  test.each([
    ["額", (u: MppUpstream) => { u.state.amount = "1001"; }],
    ["受取先", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, request: { ...(c["request"] as Record<string, unknown>), recipient: "0x0000000000000000000000000000000000000b23" } }); }],
    ["realm", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, realm: "another" }); }],
    ["request.description（条件の全文）", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, request: { ...(c["request"] as Record<string, unknown>), description: "new" } }); }],
    ["methodDetails（feePayer の申し出が増えた）", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, request: { ...(c["request"] as Record<string, unknown>), methodDetails: { chainId: MPP_FIXTURE_CHAIN_ID, feePayer: true } } }); }],
    ["meta（scope が付いた）", (u: MppUpstream) => { u.state.scope = "match"; }],
    ["scheme（method/intent）", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, method: "evm" }); }],
    ["network（chainId）", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, request: { ...(c["request"] as Record<string, unknown>), methodDetails: { chainId: 4217 } } }); }],
    ["asset（currency）", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, request: { ...(c["request"] as Record<string, unknown>), currency: "0x0000000000000000000000000000000000000abc" } }); }],
  ])("MPP の上流が %s を変えた: 受信 verify・settle 0・署名 0・送金 0・journal 0 行", async (_name, change) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    change(fixtures.mpp);
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "rejected", error: "offer_changed", status: 409 });
    expect(fixtures.facilitator.calls).toMatchObject({ verify: 0, settle: 0 });
    expect(router.signatures()).toEqual({ x402: 0, mpp: 0 });
    expect(outboundCalls(fixtures)).toEqual({ x402Payments: 0, mppSends: 0, mppCredentials: 0 });
    expect(journalEvents(router)).toEqual([]);
  });

  test("MPP の challenge の id・expires だけが変わっても成立する（発行ごとに実際に変わっていることを記録して確かめる）", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const issued: { id: string; expires: string }[] = [];
    fixtures.mpp.state.mutateChallenge = (c) => {
      issued.push({ id: String(c["id"]), expires: String(c["expires"]) });
      return c;
    };
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await purchase(router, quote, credential, "r1")).outcome).toBe("delivered");
    expect(issued.length).toBeGreaterThanOrEqual(3);
    expect(new Set(issued.map((c) => c.id)).size).toBe(issued.length);
    expect(new Set(issued.map((c) => c.expires)).size).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ 受信成立後の送信の拒否 */

test("受信が成立した後に送信が上流に拒否されたら、終端は耐久的に記録され、自動の再試行は起きない（送信の呼び出しは 1 回）", async () => {
  const fixtures = await startFixtures();
  const dir = mkdtempSync(path.join(runtimeRoot, "t14-reject-"));
  closers.push(async () => rmSync(dir, { recursive: true, force: true }));
  const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
  let router = await startRouter(fixtures, { dir, keys });
  fixtures.x402.state.pay = () => ({ status: 402, body: "{}" });
  const quote = await quoteOf(router, X402_PROFILE, X402_URL, "r1");
  const credential = await credentialFor(fixtures, quote);
  expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "paid_data_unavailable", terminalReason: "destination_rejected" });
  expect(outboundCalls(fixtures).x402Payments).toBe(1);
  expect(journalEvents(router)).toEqual(["created", "source_pending", "source_settled", "destination_pending", "dest_failed"]);
  // 再提出しても再試行しない。再起動後も同じ。
  fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
  expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "paid_data_unavailable" });
  await router.close();
  closers.splice(closers.indexOf(router.close), 1);
  router = await startRouter(fixtures, { dir, keys });
  expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "paid_data_unavailable", terminalReason: "destination_rejected" });
  expect(outboundCalls(fixtures).x402Payments).toBe(1);
  expect(await router.client().status(quote.paymentId, quote.ownerKey)).toMatchObject({ found: true, projection: { status: "paid_data_unavailable", terminalReason: "destination_rejected" } });
});

/* ------------------------------------------------------------------ AC-15 */

describe("AC-15: 購入 1 件が journal に足すバイト数", () => {
  const FIXED_OVERHEAD = 16 * 1024;
  test.each([
    ["上限内の成功応答", (payer: string) => paidOk(payer, { pad: "x".repeat(100_000) }), "delivered"],
    ["上限超の応答", (payer: string) => ({ ...paidOk(payer), body: JSON.stringify({ pad: "x".repeat(300_000) }) }), "paid_data_unavailable"],
    ["対応外の形の応答", (payer: string) => ({ ...paidOk(payer), body: "<html>", contentType: "text/html" }), "paid_data_unavailable"],
  ])("%s", async (_name, respond, outcome) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    fixtures.x402.state.pay = () => respond(router.payerAddress.x402);
    const quote = await quoteOf(router, X402_PROFILE, X402_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    const before = statSync(router.journalPath, { throwIfNoEntry: false })?.size ?? 0;
    expect((await purchase(router, quote, credential, "r1")).outcome).toBe(outcome);
    const delta = statSync(router.journalPath).size - before;
    expect(delta).toBeLessThanOrEqual(256 * 1024 + FIXED_OVERHEAD);
    expect(delta).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ AC-17 */

describe("AC-17: 別名は同じアドレスの枠を共有し、超過分は外部接続 0", () => {
  test("同じアドレスに解決する 2 つの名前は 1 つの枠（アドレスの頻度 1/分）", async () => {
    const fixtures = await startFixtures();
    // 起動時の probe（RPC）が同じアドレスの 1 枠を使わないよう、RPC だけ別のアドレスに解決する。
    fixtures.resolve.set(HOSTS.rpc, ["93.184.216.35"]);
    // 起動時の probe は RPC のアドレスに 2 回接続する（block ＋ fill）ので、枠は 2。上流のアドレスは同じ名前で 2 回使い切ってから別名で試す。
    const router = await startRouter(fixtures, { limits: { perAddressPerMinute: 2 } });
    fixtures.ports.set("alias.provider.test", fixtures.x402.port);
    const first = await router.client().quoteUrl({ profileId: X402_PROFILE, url: X402_URL, requestId: "a" });
    expect(first.ok).toBe(true);
    expect((await router.client().quoteUrl({ profileId: X402_PROFILE, url: X402_URL, requestId: "a2" })).ok).toBe(true);
    const dialedBefore = fixtures.dialed.length;
    const second = await router.client().quoteUrl({ profileId: X402_PROFILE, url: "https://alias.provider.test/v1/price", requestId: "b" });
    expect(second).toMatchObject({ ok: false, error: "quote_failed" });
    expect(fixtures.dialed.length).toBe(dialedBefore);
    expect(router.events.map((event) => event.code)).toContain("admission_refused");
  });

  test.each([
    ["送信元", { quotesPerMinutePerSource: 1 }, "s1", X402_URL, "rate_source"],
    ["全体", { quotesPerMinuteGlobal: 1 }, "s2", X402_URL, "rate_global"],
    ["宛先ホスト", { perHostPerMinute: 1 }, "s2", "https://provider.test/v1/other", "rate_host"],
  ])("%s の上限で、超過分は接続しない", async (_name, limits, secondSource, secondUrl, reason) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures, { limits });
    expect((await router.client("s1").quoteUrl({ profileId: X402_PROFILE, url: X402_URL, requestId: "a" })).ok).toBe(true);
    const dialed = fixtures.dialed.length;
    const second = await router.client(secondSource).quoteUrl({ profileId: X402_PROFILE, url: secondUrl, requestId: "b" });
    expect(second).toMatchObject({ ok: false, error: "rate_limited", status: 429 });
    expect(fixtures.dialed.length).toBe(dialed);
    // 別のホスト（宛先の上限のとき）・別の送信元（送信元の上限のとき）は通る。
    if (reason === "rate_host" || reason === "rate_source") {
      expect((await router.client("s3").quoteUrl({ profileId: MPP_PROFILE, url: MPP_URL, requestId: "c" })).ok).toBe(true);
    }
  });
});

describe("AC-17: purchase の上限でも超過分は外部接続 0", () => {
  test.each([
    ["送信元", { purchasesPerMinutePerSource: 1 }, "judge"],
    ["全体", { purchasesPerMinuteGlobal: 1 }, "other"],
  ])("%s の purchase の上限", async (_name, limits, secondSource) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures, { limits });
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    const a = await quoteOf(router, X402_PROFILE, X402_URL, "a", "judge");
    const b = await quoteOf(router, X402_PROFILE, X402_URL, "b", secondSource);
    const ca = await credentialFor(fixtures, a);
    const cb = await credentialFor(fixtures, b);
    expect((await purchase(router, a, ca, "a", "judge")).outcome).toBe("delivered");
    const dialed = fixtures.dialed.length;
    const payments = fixtures.x402.seen.payments.length;
    const rpc = fixtures.rpc.http.requests;
    expect(await purchase(router, b, cb, "b", secondSource)).toMatchObject({ outcome: "rejected", error: "rate_limited", status: 429 });
    expect(fixtures.dialed.length).toBe(dialed);
    expect(fixtures.x402.seen.payments.length).toBe(payments);
    expect(fixtures.rpc.http.requests).toBe(rpc);
    expect(journalEvents(router).filter((event) => event === "created")).toHaveLength(1);
  });

  test("宛先ホストの同時実行の上限: 同じホストへの 2 件目の purchase は、1 件目が終わるまで接続しない", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures, { limits: { perHostConcurrent: 1 } });
    // 1 件目の有料要求が上流に届いたことを待ってから、2 件目を出す（応答は少し遅らせて、1 件目が枠を持ち続ける間に 2 件目が来るようにする）。
    const reached = new Promise<void>((resolve) => {
      fixtures.x402.state.pay = () => {
        resolve();
        return { ...paidOk(router.payerAddress.x402, { price: 1 }), delayMs: 600 };
      };
    });
    const a = await quoteOf(router, X402_PROFILE, X402_URL, "a", "s1");
    const b = await quoteOf(router, X402_PROFILE, X402_URL, "b", "s2");
    const ca = await credentialFor(fixtures, a);
    const cb = await credentialFor(fixtures, b);
    const first = purchase(router, a, ca, "a", "s1");
    await reached;
    const dialed = fixtures.dialed.length;
    expect(await purchase(router, b, cb, "b", "s2")).toMatchObject({ outcome: "rejected", error: "rate_limited", status: 429 });
    expect(fixtures.dialed.length).toBe(dialed);
    expect((await first).outcome).toBe("delivered");
    expect(fixtures.x402.seen.payments).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ AC-20・AC-22 */

test("AC-20・AC-22: 再起動をまたぐ持ち主の分離。動的購入を含む journal を動的無効の Router が再生し、予算が保たれ、動的 quote は実行されない", async () => {
  const fixtures = await startFixtures();
  const dir = mkdtempSync(path.join(runtimeRoot, "t14-restart-"));
  closers.push(async () => rmSync(dir, { recursive: true, force: true }));
  const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
  let router = await startRouter(fixtures, { dir, keys, maxPurchases: 2 });
  fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
  const a = await quoteOf(router, X402_PROFILE, X402_URL, "a");
  expect((await purchase(router, a, await credentialFor(fixtures, a), "a")).outcome).toBe("delivered");
  const pending = await quoteOf(router, X402_PROFILE, X402_URL, "p");
  await router.close();
  closers.splice(closers.indexOf(router.close), 1);

  // 再起動（有効）: 持ち主の証明が無ければ見えず・買えず、別の持ち主の証明でも同じ。あれば見える。控えの quote も残っている。
  router = await startRouter(fixtures, { dir, keys, maxPurchases: 2 });
  fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
  const stolen = { ...pending, ownerKey: a.ownerKey } as QuoteView;
  const { ownerKey: _dropped, ...noKey } = pending;
  const pendingCredential = await credentialFor(fixtures, pending);
  expect(await purchase(router, noKey as QuoteView, pendingCredential, "p")).toMatchObject({ outcome: "rejected", error: "unknown_quote", status: 404 });
  expect(await purchase(router, stolen, pendingCredential, "p")).toMatchObject({ outcome: "rejected", error: "unknown_quote", status: 404 });
  expect(await router.client().status(pending.paymentId, a.ownerKey)).toMatchObject({ found: false, status: 404 });
  expect(outboundCalls(fixtures).x402Payments).toBe(1);
  expect(await router.client().status(a.paymentId)).toMatchObject({ found: false, status: 404 });
  expect(await router.client().status(a.paymentId, a.ownerKey)).toMatchObject({ found: true, projection: { status: "delivered" } });
  expect(await router.client().status(pending.paymentId, pending.ownerKey)).toMatchObject({ found: true, projection: { status: "awaiting_payment" } });
  await router.close();
  closers.splice(closers.indexOf(router.close), 1);

  // 再起動（無効）: journal は再生され、予算は保たれ（1 件使用済み）、動的 quote も控えの quote の購入も実行されない。静的は動く。
  router = await startRouter(fixtures, { dir, keys, maxPurchases: 2, enabled: false });
  expect(await router.client().quoteUrl({ profileId: X402_PROFILE, url: X402_URL, requestId: "z" })).toMatchObject({ ok: false, error: "dynamic_disabled", status: 404 });
  expect(await purchase(router, pending, pendingCredential, "p")).toMatchObject({ outcome: "rejected", status: 404 });
  expect(await router.client().status(a.paymentId, a.ownerKey)).toMatchObject({ found: true, projection: { status: "delivered" } });
  expect(outboundCalls(fixtures).x402Payments).toBe(1);
  // 静的 route は動的が無効でも成立する（quote → purchase → delivered）。
  fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
  const staticQuote = await router.client().quote({ routeId: STATIC_ROUTE, requestId: "s" });
  expect(staticQuote.ok).toBe(true);
  const sq = (staticQuote as { quote: QuoteView }).quote;
  expect((await purchase(router, sq, await credentialFor(fixtures, sq), "s")).outcome).toBe("delivered");
  expect(fixtures.x402.seen.payments).toHaveLength(2);
  await router.close();
  closers.splice(closers.indexOf(router.close), 1);

  // 再び有効: 予算の残りは 1 件（a の分は再生で数えられている）。
  router = await startRouter(fixtures, { dir, keys, maxPurchases: 2 });
  fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
  const b = await quoteOf(router, X402_PROFILE, X402_URL, "b");
  expect((await purchase(router, b, await credentialFor(fixtures, b), "b")).outcome).toBe("delivered");
  const c = await quoteOf(router, X402_PROFILE, X402_URL, "c");
  expect(await purchase(router, c, await credentialFor(fixtures, c), "c")).toMatchObject({ outcome: "rejected", error: "purchase_count_limit", status: 429 });
});

/* ------------------------------------------------------------------ AC-12 */

describe("AC-12: 各接続点に loopback・内部に解決する公開名を当てると拒否される（名前解決の fixture で内部アドレスを返す）", () => {
  const blocked = (router: Router, operation: string): number => router.events.filter((event) => event.code === "destination_blocked" && event.operation === operation).length;

  test.each([
    ["loopback", "127.0.0.1"],
    ["private 10/8", "10.1.2.3"],
    ["link-local", "169.254.169.254"],
    ["IPv6 loopback", "::1"],
    ["private 172.16/12", "172.16.0.9"],
  ])("quote の読取: 上流が %s に解決する → 接続 0", async (_name, address) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    fixtures.resolve.set(HOSTS.x402, [address]);
    expect(await router.client().quoteUrl({ profileId: X402_PROFILE, url: X402_URL, requestId: "r1" })).toMatchObject({ ok: false, error: "quote_failed" });
    expect(fixtures.dialed).toEqual([]);
    expect(blocked(router, "challenge")).toBe(1);
  });

  test("再読取: quote の後に上流が内部に解決するようになったら、接続 0・署名 0・journal 0 行", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, X402_PROFILE, X402_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    const dialed = fixtures.dialed.length;
    fixtures.resolve.set(HOSTS.x402, ["127.0.0.1"]);
    // Router は 503 offer_unavailable（何も書かない）。client は 5xx を確定させず unknown で保持する（再送しない）。
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "unknown", reason: "offer_unavailable" });
    expect(fixtures.dialed.length).toBe(dialed);
    expect(blocked(router, "challenge")).toBe(1);
    expect(router.signatures()).toEqual({ x402: 0, mpp: 0 });
    expect(journalEvents(router)).toEqual([]);
  });

  test("有料要求: 読み直しまで通った後、有料要求の時点で上流が内部に解決するようになったら、接続 0 で unknown（署名は 1 回、送信 0）", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    // 4 回目の challenge（送信 adapter 自身の読み直し）の後、つまり有料要求の名前解決の前に、上流を内部アドレスに向ける。
    let challenges = 0;
    fixtures.x402.state.resourceUrl = (url) => {
      challenges += 1;
      if (challenges === 4) fixtures.resolve.set(HOSTS.x402, ["127.0.0.1"]);
      return url;
    };
    const quote = await quoteOf(router, X402_PROFILE, X402_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    const result = await purchase(router, quote, credential, "r1");
    expect(result).toMatchObject({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(challenges).toBe(4);
    expect(fixtures.x402.seen.payments).toHaveLength(0);
    expect(blocked(router, "pay")).toBe(1);
    expect(fixtures.dialed.filter((host) => host === HOSTS.x402)).toHaveLength(4);
    expect(router.signatures().x402).toBe(1);
    expect(journalEvents(router)).toEqual(["created", "source_pending", "source_settled", "destination_pending", "unknown"]);
  });

  test("MPP 送信の RPC が内部に解決する（quote の後）: 再見積りが verify の前に止める。接続 0・署名 0・journal 0 行（受信は成立しない）", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    fixtures.resolve.set(HOSTS.rpc, ["10.0.0.5"]);
    const rpcDials = fixtures.dialed.filter((host) => host === HOSTS.rpc).length;
    // 再見積り（`docs/dynamic-gas-fee-design.md` §1.4）は受信 verify の前。RPC に届かなければ `fee_estimate_unavailable` で、何も書かない。
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "payment_required", error: "fee_estimate_unavailable" });
    expect(fixtures.dialed.filter((host) => host === HOSTS.rpc)).toHaveLength(rpcDials);
    expect(blocked(router, "estimate_rpc")).toBeGreaterThanOrEqual(1);
    expect(fixtures.facilitator.calls).toMatchObject({ verify: 0, settle: 0 });
    expect(router.signatures()).toEqual({ x402: 0, mpp: 0 });
    expect(fixtures.rpc.sentRaw).toHaveLength(0);
    expect(fixtures.mpp.seen.credentials).toBe(0);
    expect(journalEvents(router)).toEqual([]);
  });

  test("MPP 送信の RPC が内部に解決する（settle の後）: 接続 0・署名 0・終端は dest_failed（受信は成立済み）", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    // 再見積りは通し、settle の直前に RPC の解決先を内部にする。
    fixtures.facilitator.onSettle = () => fixtures.resolve.set(HOSTS.rpc, ["10.0.0.5"]);
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "paid_data_unavailable", terminalReason: "destination_rejected" });
    expect(blocked(router, "rpc")).toBeGreaterThanOrEqual(1);
    expect(router.signatures()).toEqual({ x402: 0, mpp: 0 });
    expect(fixtures.rpc.sentRaw).toHaveLength(0);
    expect(fixtures.mpp.seen.credentials).toBe(0);
    expect(journalEvents(router)).toEqual(["created", "source_pending", "source_settled", "destination_pending", "dest_failed"]);
  });

  test("受信の facilitator（x402）が内部に解決する: 接続 0・verify に届かず・何も書かない", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    fixtures.resolve.set(HOSTS.facilitator, ["127.0.0.1"]);
    const dialed = fixtures.dialed.length;
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "unknown", reason: "source_verify_unavailable" });
    // 読み直し（上流）と再見積り（RPC: block ＋ fill）には出るが、facilitator には接続しない。
    expect(fixtures.dialed.slice(dialed)).toEqual([HOSTS.mpp, HOSTS.rpc, HOSTS.rpc]);
    expect(blocked(router, "facilitator_verify")).toBe(1);
    expect(fixtures.facilitator.calls.verify).toBe(0);
    expect(journalEvents(router)).toEqual([]);
  });

  test("受信の RPC（MPP）が内部に解決する: 接続 0・verify が成立せず・何も書かない", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, X402_PROFILE, X402_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    fixtures.resolve.set(HOSTS.rpc, ["172.16.0.9"]);
    const dialed = fixtures.dialed.length;
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "payment_required", error: "verify_failed" });
    expect(fixtures.dialed.slice(dialed)).toEqual([HOSTS.x402]);
    expect(blocked(router, "rpc")).toBeGreaterThanOrEqual(1);
    expect(router.signatures()).toEqual({ x402: 0, mpp: 0 });
    expect(fixtures.x402.seen.payments).toHaveLength(0);
    expect(journalEvents(router)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ MPP 送信の手数料 = quote 時のガス代（docs/dynamic-gas-fee-design.md） */

describe("MPP 送信: 手数料は quote 時のガス代の見積りから（dynamic-gas-fee-design）", () => {
  const BASE_FEE = 0x23c34600n;

  test("単価が上がると cap と手数料が上がり、天井を超えると quote は出ない（fee_too_high）。見積りは署名も送金もしない", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const normal = await quoteOf(router, MPP_PROFILE, MPP_URL, "normal");
    // fixture: gas 54,290、単価は Router の feePerGasOf(6e8) = 1,440,000,001 → bound 79 → cap 158 < 定額 1,000。
    expect(normal.pricing).toMatchObject({ upstreamAmount: "1000", fee: "1000", total: "2000", maxFee: "158", estimate: { gas: "54290", bound: "79" } });
    expect(fixtures.rpc.methods).toEqual(["eth_getBlockByNumber", "eth_fillTransaction"]);
    expect(fixtures.rpc.sentRaw).toHaveLength(0);
    expect(router.signatures()).toEqual({ x402: 0, mpp: 0 });
    // ノードの提案（priority）が跳ねても quote は変わらない（設計 §8.2）。
    fixtures.rpc.quote.priority = 24_400_000_000n;
    expect((await quoteOf(router, MPP_PROFILE, MPP_URL, "spike")).pricing).toMatchObject({ fee: "1000", maxFee: "158" });
    fixtures.rpc.quote.priority = 1n;
    fixtures.rpc.quote.baseFeePerGas = BASE_FEE * 15n; // feePerGasOf(9e9) → bound 1,173 → cap 2,346 > 定額
    const high = await quoteOf(router, MPP_PROFILE, MPP_URL, "high");
    expect(high.pricing).toMatchObject({ fee: "2346", total: "3346", maxFee: "2346" });
    expect((high.source as { amount: string }).amount).toBe("3346");
    fixtures.rpc.quote.baseFeePerGas = BASE_FEE * 100n; // bound 7,818 → cap 15,636 > 天井 5,000
    expect(await router.client().quoteUrl({ profileId: MPP_PROFILE, url: MPP_URL, requestId: "over" })).toMatchObject({ ok: false, error: "quote_failed" });
    expect((high.disclosures as Record<string, unknown>)["routerMayRejectAfterSettle"]).toEqual(["fee_too_high"]);
    expect((high.disclosures as Record<string, unknown>)["feeEstimateIsNotADeliveryGuarantee"]).toBe(true);
    // RPC が止まれば quote は出ない（定額に落とさない）。
    fixtures.rpc.quote.baseFeePerGas = BASE_FEE;
    fixtures.rpc.http.status = 503;
    expect(await router.client().quoteUrl({ profileId: MPP_PROFILE, url: MPP_URL, requestId: "down" })).toMatchObject({ ok: false, error: "quote_failed" });
  });

  test("purchase: quote の後に単価が cap を超えて上がっていれば、verify の前に fee_too_high（何も書かない）。下がれば通る", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    fixtures.rpc.quote.baseFeePerGas = BASE_FEE * 3n; // bound 235 > cap 158
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "payment_required", error: "fee_too_high" });
    expect(fixtures.facilitator.calls).toMatchObject({ verify: 0, settle: 0 });
    expect(journalEvents(router)).toEqual([]);
    fixtures.rpc.quote.baseFeePerGas = BASE_FEE;
    expect((await purchase(router, quote, credential, "r1")).outcome).toBe("delivered");
    expect(router.signatures()).toEqual({ x402: 0, mpp: 1 });
  });

  test("署名前: settle の後に baseFee が上がると、capPerGas まで clamp して払う（bound ≤ cap）。capPerGas を超えれば署名せず dest_failed（天井の内側でも）", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    // cap 158 → capPerGas = floor(158e12 / 54290) = 2,910,296,555。baseFee × 3 = 1.8e9 → feePerGasOf = 4.32e9 > capPerGas ≥ baseFee → clamp。
    fixtures.facilitator.onSettle = () => { fixtures.rpc.quote.baseFeePerGas = BASE_FEE * 3n; };
    expect((await purchase(router, quote, credential, "r1")).outcome).toBe("delivered");
    const raw = fixtures.rpc.sentRaw[0]!;
    const envelope = TxEnvelopeTempo.deserialize(raw as never) as unknown as { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    expect(envelope.maxFeePerGas).toBe((158n * 10n ** 12n) / 54_290n);
    expect(envelope.maxPriorityFeePerGas).toBe(1n);
    expect((envelope.gas * envelope.maxFeePerGas + 10n ** 12n - 1n) / 10n ** 12n).toBeLessThanOrEqual(158n);

    // baseFee × 5 = 3e9 > capPerGas → 署名しない。
    fixtures.rpc.quote.baseFeePerGas = BASE_FEE;
    const second = await quoteOf(router, MPP_PROFILE, MPP_URL, "r2");
    const credential2 = await credentialFor(fixtures, second);
    fixtures.facilitator.onSettle = () => { fixtures.rpc.quote.baseFeePerGas = BASE_FEE * 5n; };
    expect(await purchase(router, second, credential2, "r2")).toMatchObject({ outcome: "paid_data_unavailable", terminalReason: "destination_rejected" });
    expect(router.signatures()).toEqual({ x402: 0, mpp: 1 });
    expect(fixtures.rpc.sentRaw).toHaveLength(1);
    expect(journalEvents(router).slice(-5)).toEqual(["created", "source_pending", "source_settled", "destination_pending", "dest_failed"]);
  });

  test("quote が全体の上限まで出た直後でも purchase は通る（eth_fillTransaction 対応ノード。宛先アドレスの枠 60/分の内側）", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures, { limits: { quotesPerMinuteGlobal: 10, quotesPerMinutePerSource: 10, perAddressPerMinute: 60 } });
    const quotes: QuoteView[] = [];
    for (let i = 0; i < 10; i += 1) quotes.push(await quoteOf(router, MPP_PROFILE, MPP_URL, `q${i}`));
    expect(await router.client().quoteUrl({ profileId: MPP_PROFILE, url: MPP_URL, requestId: "q10" })).toMatchObject({ ok: false, error: "rate_limited" });
    const quote = quotes[0]!;
    expect((await purchase(router, quote, await credentialFor(fixtures, quote), "q0")).outcome).toBe("delivered");
  });
});

