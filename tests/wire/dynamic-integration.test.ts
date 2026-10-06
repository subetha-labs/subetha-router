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
import { generatePrivateKey } from "viem/accounts";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { createRouterClient } from "../../src/client/index.js";
import type { QuoteView, RouterClient } from "../../src/client/types.js";
import { DEFAULT_DYNAMIC_LIMITS, loadRuntimeConfig, type RuntimeConfig } from "../../src/config.js";
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
const X402_URL = "https://provider.test/v1/price?symbol=ETH";
const MPP_URL = "https://mpp.provider.test/v1/price";
const HOSTS = { x402: "provider.test", mpp: "mpp.provider.test", facilitator: "facilitator.other.test", rpc: "rpc.other.test" } as const;

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
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
  client(source?: string): RouterClient;
  close(): Promise<void>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
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
  const ports = new Map<string, number>([[HOSTS.x402, x402.port], [HOSTS.mpp, mpp.port], [HOSTS.facilitator, facilitator.port], [HOSTS.rpc, rpc.port]]);
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
            destination: { scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: PATHUSD, decimals: 6, feeAsset: PATHUSD, maxFee: "5000" },
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
    x402: { upstreams: { [STATIC_ROUTE]: "https://static.provider.test/v1/x" } },
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
  );
  const keys = options.keys ?? { x402: generatePrivateKey(), mpp: generatePrivateKey() };
  const evm = createRealEvmCapability(keys.x402);
  const mppCapability = createRealMppCapability(keys.mpp, { rpcUrl: `https://${HOSTS.rpc}` });
  const capabilities: RouterCapabilities = {
    evmSigning: evm.capability(FIXTURE_NETWORK),
    mppTempo: mppCapability.capability(),
    dependencyUrls: [`https://${HOSTS.rpc}/`],
    dynamicTransportHooksForTest: hooksOf(fixtures),
  };
  const events: TransportEvent[] = [];
  const rails = composeRails(config, capabilities, (event) => events.push(event));
  await rails.dynamic!.verify();
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
  if (quote.routeId === MPP_PROFILE || quote.routeId === STATIC_ROUTE) {
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
    const payment = fixtures.x402.seen.payments[0] as { accepted: unknown; payload: { authorization: { from: string } } };
    expect(payment.accepted).toEqual(standardAccept());
    expect(payment.payload.authorization.from.toLowerCase()).toBe(router.payerAddress.x402.toLowerCase());
    // 受信の照合（MPP の RPC）は動的用 transport を通った（RPC のホストに接続した）。
    expect(fixtures.dialed).toContain(HOSTS.rpc);
    expect(new Set(fixtures.dialed)).toEqual(new Set([HOSTS.x402, HOSTS.rpc]));
  });
});

/* ------------------------------------------------------------------ AC-5 */

describe("AC-5: 1 回の受信支払いで送信の呼び出しは高々 1 回", () => {
  test("同じ credential の再提出・別 quote（同額・異額・静的）への持ち込み・再起動後: 送信は 1 回のまま", async () => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t14-ac5-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    let router = await startRouter(fixtures, { dir, keys });
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    const a = await quoteOf(router, MPP_PROFILE, MPP_URL, "a");
    const credential = await credentialFor(fixtures, a);
    expect((await purchase(router, a, credential, "a")).outcome).toBe("delivered");
    expect(outboundCalls(fixtures).mppSends).toBe(1);
    // 同じ quote に同じ credential をもう一度 → 既存の結果（送信は増えない）。
    expect((await purchase(router, a, credential, "a")).outcome).toBe("delivered");
    // 同額の別 quote・異額の別 quote（上流の額を変える）に A の credential → preflight で止まる（facilitator にも出ない）。
    const sameAmount = await quoteOf(router, MPP_PROFILE, MPP_URL, "b");
    expect(await purchase(router, sameAmount, credential, "b")).toMatchObject({ outcome: "payment_required", error: "nonce_mismatch" });
    fixtures.mpp.state.amount = "2000";
    const otherAmount = await quoteOf(router, MPP_PROFILE, MPP_URL, "c");
    expect(await purchase(router, otherAmount, credential, "c")).toMatchObject({ outcome: "payment_required", error: "nonce_mismatch" });
    // 静的 route の offer に署名した credential を動的 quote に持ち込む（静的の上流は到達しないので offer は受信 adapter から直接作る）。
    const staticOffer = await router.core.quote({ principalId: "judge", requestId: "s", routeId: STATIC_ROUTE }).catch(() => undefined);
    void staticOffer;
    const foreign = await createX402Payer(generatePrivateKey()).credentialFor({ ...(sameAmount.source.offer as object), extra: { ...((sameAmount.source.offer as { extra: Record<string, unknown> }).extra), challengeNonce: `0x${"ab".repeat(32)}` } } as never, 84532);
    expect(await purchase(router, sameAmount, foreign, "b")).toMatchObject({ outcome: "payment_required", error: "nonce_mismatch" });
    expect(fixtures.facilitator.calls).toMatchObject({ verify: 1, settle: 1 });
    expect(outboundCalls(fixtures).mppSends).toBe(1);
    // 再起動（journal の再オープン）後も、A の再提出は送信を増やさない。
    await router.close();
    closers.splice(closers.indexOf(router.close), 1);
    router = await startRouter(fixtures, { dir, keys });
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    expect((await purchase(router, a, credential, "a")).outcome).toBe("delivered");
    expect(outboundCalls(fixtures).mppSends).toBe(1);
    expect(fixtures.facilitator.calls.settle).toBe(1);
  });

  test("並行: 同じ quote への 2 つの purchase（A/A）は送信 1 回、別の quote 2 つ（A/B）は各 1 回", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    fixtures.x402.state.pay = () => paidOk(router.payerAddress.x402, { price: 1 });
    const a = await quoteOf(router, MPP_PROFILE, MPP_URL, "a");
    const b = await quoteOf(router, MPP_PROFILE, MPP_URL, "b");
    const ca = await credentialFor(fixtures, a);
    const cb = await credentialFor(fixtures, b);
    const [a1, a2] = await Promise.all([purchase(router, a, ca, "a"), purchase(router, a, ca, "a")]);
    expect([a1.outcome, a2.outcome]).toEqual(["delivered", "delivered"]);
    expect(outboundCalls(fixtures).mppSends).toBe(1);
    expect(fixtures.facilitator.calls.settle).toBe(1);
    const [b1, c1] = await Promise.all([purchase(router, b, cb, "b"), purchase(router, b, cb, "b")]);
    expect([b1.outcome, c1.outcome]).toEqual(["delivered", "delivered"]);
    expect(outboundCalls(fixtures).mppSends).toBe(2);
    // x402 側（MPP で払う）でも同じ。
    const x = await quoteOf(router, X402_PROFILE, X402_URL, "x");
    const y = await quoteOf(router, X402_PROFILE, X402_URL, "y");
    const cx = await credentialFor(fixtures, x);
    const cy = await credentialFor(fixtures, y);
    const results = await Promise.all([purchase(router, x, cx, "x"), purchase(router, x, cx, "x"), purchase(router, y, cy, "y")]);
    expect(results.map((r) => r.outcome)).toEqual(["delivered", "delivered", "delivered"]);
    expect(outboundCalls(fixtures).x402Payments).toBe(2);
  });
});

/* ------------------------------------------------------------------ AC-6 */

describe("AC-6: 上流が offer を変えたら受信 settle・送信の署名・broadcast が 0", () => {
  test.each([
    ["額", (u: X402Upstream) => { u.state.accepts = [standardAccept({ amount: "1001" })]; }],
    ["受取先", (u: X402Upstream) => { u.state.accepts = [standardAccept({ payTo: "0x0000000000000000000000000000000000000a12" })]; }],
    ["maxTimeoutSeconds", (u: X402Upstream) => { u.state.accepts = [standardAccept({ maxTimeoutSeconds: 61 })]; }],
    ["extra.name", (u: X402Upstream) => { u.state.accepts = [standardAccept({ extra: { name: "USD Coin", version: "2" } })]; }],
    ["説明の欄", (u: X402Upstream) => { u.state.accepts = [standardAccept({ description: "new" })]; }],
  ])("x402 の上流が %s を変えた", async (_name, change) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, X402_PROFILE, X402_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    change(fixtures.x402);
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "rejected", error: "offer_changed", status: 409 });
    expect(outboundCalls(fixtures).x402Payments).toBe(0);
    // 呼び出し側の送金（1 件）以外に RPC への送金は無く、journal も増えていない（昇格前）。
    expect(fixtures.rpc.sentRaw).toHaveLength(1);
    expect(journalEvents(router)).toEqual([]);
  });

  test.each([
    ["額", (u: MppUpstream) => { u.state.amount = "1001"; }],
    ["受取先", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, request: { ...(c["request"] as Record<string, unknown>), recipient: "0x0000000000000000000000000000000000000b23" } }); }],
    ["realm", (u: MppUpstream) => { u.state.mutateChallenge = (c) => ({ ...c, realm: "another" }); }],
  ])("MPP の上流が %s を変えた", async (_name, change) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    change(fixtures.mpp);
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "rejected", error: "offer_changed", status: 409 });
    expect(fixtures.facilitator.calls).toMatchObject({ verify: 0, settle: 0 });
    expect(outboundCalls(fixtures)).toEqual({ x402Payments: 0, mppSends: 0, mppCredentials: 0 });
    expect(journalEvents(router)).toEqual([]);
  });

  test("MPP の challenge の id・expires だけが変わっても成立する", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    // fixture は読むたびに新しい id・expires を発行する（HMAC は実物）。
    expect((await purchase(router, quote, credential, "r1")).outcome).toBe("delivered");
    expect(fixtures.mpp.seen.challenges).toBeGreaterThanOrEqual(3);
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
  test("同じアドレスに解決する 2 つの名前は 1 つの枠（アドレスの同時実行 1）", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures, { limits: { perAddressPerMinute: 1 } });
    fixtures.ports.set("alias.provider.test", fixtures.x402.port);
    const first = await router.client().quoteUrl({ profileId: X402_PROFILE, url: X402_URL, requestId: "a" });
    expect(first.ok).toBe(true);
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

  // 再起動（有効）: 持ち主の証明が無ければ見えず、あれば見える。控えの quote も残っている。
  router = await startRouter(fixtures, { dir, keys, maxPurchases: 2 });
  expect(await router.client().status(a.paymentId)).toMatchObject({ found: false, status: 404 });
  expect(await router.client().status(a.paymentId, a.ownerKey)).toMatchObject({ found: true, projection: { status: "delivered" } });
  expect(await router.client().status(pending.paymentId, pending.ownerKey)).toMatchObject({ found: true, projection: { status: "awaiting_payment" } });
  await router.close();
  closers.splice(closers.indexOf(router.close), 1);

  // 再起動（無効）: journal は再生され、予算は保たれ（1 件使用済み）、動的 quote も控えの quote の購入も実行されない。静的は動く。
  router = await startRouter(fixtures, { dir, keys, maxPurchases: 2, enabled: false });
  expect(await router.client().quoteUrl({ profileId: X402_PROFILE, url: X402_URL, requestId: "z" })).toMatchObject({ ok: false, error: "dynamic_disabled", status: 404 });
  const credential = await credentialFor(fixtures, pending);
  expect(await purchase(router, pending, credential, "p")).toMatchObject({ outcome: "rejected", status: 404 });
  expect(await router.client().status(a.paymentId, a.ownerKey)).toMatchObject({ found: true, projection: { status: "delivered" } });
  expect(outboundCalls(fixtures).x402Payments).toBe(1);
  // 静的 route の quote は受け付けられる（上流は fixture に無いので transport の失敗で終わるが、動的無効の拒否（404 dynamic_disabled）とは別の経路）。
  const staticQuote = await router.client().quote({ routeId: STATIC_ROUTE, requestId: "s" });
  expect(staticQuote.ok).toBe(false);
  expect((staticQuote as { error: string }).error).not.toBe("dynamic_disabled");
  expect(router.events.map((event) => event.code).some((code) => code === "dns_failed" || code === "connect_failed" || code === "destination_blocked")).toBe(true);
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
  test.each([
    ["loopback", "127.0.0.1"],
    ["private 10/8", "10.1.2.3"],
    ["link-local", "169.254.169.254"],
    ["IPv6 loopback", "::1"],
  ])("quote の読取: 上流が %s に解決する", async (_name, address) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    fixtures.resolve.set(HOSTS.x402, [address]);
    expect(await router.client().quoteUrl({ profileId: X402_PROFILE, url: X402_URL, requestId: "r1" })).toMatchObject({ ok: false, error: "quote_failed" });
    expect(fixtures.dialed).toEqual([]);
    expect(router.events.map((event) => event.code)).toContain("destination_blocked");
  });

  test("再読取・有料要求: quote の後に上流が内部に解決するようになったら、署名も送金も無い", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, X402_PROFILE, X402_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    fixtures.resolve.set(HOSTS.x402, ["127.0.0.1"]);
    // Router は 503 offer_unavailable（何も書かない）。client は 5xx を確定させず unknown で保持する（再送しない）。
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "unknown", reason: "offer_unavailable" });
    expect(outboundCalls(fixtures).x402Payments).toBe(0);
    expect(journalEvents(router)).toEqual([]);
    expect(router.events.map((event) => event.code)).toContain("destination_blocked");
  });

  test("MPP 送信の RPC が内部に解決する: 署名しない（not_sent）", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    fixtures.resolve.set(HOSTS.rpc, ["10.0.0.5"]);
    const result = await purchase(router, quote, credential, "r1");
    expect(result).toMatchObject({ outcome: "paid_data_unavailable", terminalReason: "destination_rejected" });
    expect(fixtures.rpc.sentRaw).toHaveLength(0);
    expect(fixtures.mpp.seen.credentials).toBe(0);
  });

  test("受信の facilitator（x402）が内部に解決する: verify に届かず、何も書かない", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, MPP_PROFILE, MPP_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    fixtures.resolve.set(HOSTS.facilitator, ["127.0.0.1"]);
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "unknown", reason: "source_verify_unavailable" });
    expect(fixtures.facilitator.calls.verify).toBe(0);
    expect(journalEvents(router)).toEqual([]);
  });

  test("受信の RPC（MPP）が内部に解決する: verify が成立せず、何も書かない", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await quoteOf(router, X402_PROFILE, X402_URL, "r1");
    const credential = await credentialFor(fixtures, quote);
    fixtures.resolve.set(HOSTS.rpc, ["172.16.0.9"]);
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "payment_required", error: "verify_failed" });
    expect(outboundCalls(fixtures).x402Payments).toBe(0);
    expect(journalEvents(router)).toEqual([]);
  });
});
