/**
 * 動的上流 URL の HTTP・client・MCP（設計 §1.1・§2.1・§5・§8、タスク T11。AC-3・AC-24）。
 *
 * プロセス内の core（合成レール。鍵も送金も無い）を実 HTTP サーバに載せ、実 TCP 越しに**製品の client** と
 * **製品の MCP tool handlers** で叩く。配線（`src/main.ts`）は T13 なので、ここでは core を直接組む。
 */
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createRouterClient, DEFAULT_DYNAMIC_EXECUTE_TIMEOUT_MS, DEFAULT_DYNAMIC_QUOTE_TIMEOUT_MS } from "../../src/client/index.js";
import type { QuoteView, RouterClient } from "../../src/client/types.js";
import { DEFAULT_DYNAMIC_LIMITS, type DynamicProfile, type RouterConfig } from "../../src/config.js";
import { createRouterCore, type RouterCore } from "../../src/core/orchestrator.js";
import { HTTP_INGRESS_TIMEOUT_MS, startHttpServer, type RunningServer } from "../../src/http/app.js";
import { sourceOfRequest } from "../../src/mcp/server.js";
import { createToolHandlers, TOOL_NAMES } from "../../src/mcp/tools.js";
import type { CreateOfferRequest, InboundOffer, InboundRail, PaymentCredential, PreflightResult, SettleResult } from "../../src/ports/inbound.js";
import type { DestinationOffer, FeeEstimate, OutboundRail, PayRequest, PayResult, UpstreamTarget } from "../../src/ports/outbound.js";

const PROFILE_ID = "dyn-mpp-to-x402";
const STATIC_ROUTE = "md-static";
const SRC_NETWORK = "eip155:42431";
const SRC_ASSET = "0x20c0000000000000000000000000000000000000";
const DST_NETWORK = "eip155:84532";
const DST_ASSET = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const DST_PAY_TO = "0x0000000000000000000000000000000000000a11";
const URL_A = "https://provider.test/v1/price?symbol=ETH";
const BODY = { price: "3000" };
const CANONICAL = "http://127.0.0.1:8500";
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

/** MPP 送信のプロファイル（x402 受信）。手数料は quote 時のガス代の見積りから（`docs/dynamic-gas-fee-design.md`）。 */
const MPP_OUT_PROFILE_ID = "dyn-x402-to-mpp";
const MPP_OUT_PROFILE: DynamicProfile = {
  profileId: MPP_OUT_PROFILE_ID,
  sourceRail: "x402",
  source: { network: DST_NETWORK, asset: DST_ASSET, decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" },
  rail: "mpp",
  destination: { scheme: "tempo/charge", network: SRC_NETWORK, asset: SRC_ASSET, decimals: 6, feeAsset: SRC_ASSET, maxFee: "5000", feeMargin: 20_000 },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "1000", bps: 0, min: "1000" },
};

const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "mpp",
  source: { network: SRC_NETWORK, asset: SRC_ASSET, decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" },
  rail: "x402",
  destination: { scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "1000", bps: 0, min: "1000" },
};

function config(overrides: { enabled?: boolean; limits?: Partial<typeof DEFAULT_DYNAMIC_LIMITS>; noDynamic?: boolean; mppOut?: boolean } = {}): RouterConfig {
  return {
    approvalTtlMs: 60_000,
    routes: {
      [STATIC_ROUTE]: {
        routeId: STATIC_ROUTE,
        canonicalPath: `/v1/routes/${STATIC_ROUTE}/resource`,
        source: { amount: "1500", asset: SRC_ASSET, decimals: 6, network: SRC_NETWORK },
        destination: { scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, payTo: DST_PAY_TO },
      },
    },
    budget: { maxPurchases: 4, buckets: [{ network: SRC_NETWORK, asset: SRC_ASSET, maxTotal: "10000", maxPerPurchase: "5000" }, { network: DST_NETWORK, asset: DST_ASSET, maxTotal: "10000", maxPerPurchase: "5000" }] },
    ...(overrides.noDynamic === true
      ? {}
      : {
          dynamic: {
            enabled: overrides.enabled ?? true,
            profiles: { [PROFILE_ID]: PROFILE, ...(overrides.mppOut === true ? { [MPP_OUT_PROFILE_ID]: MPP_OUT_PROFILE } : {}) },
            budget: { maxPurchases: 3, buckets: [{ network: SRC_NETWORK, asset: SRC_ASSET, maxTotal: "1000000", maxPerPurchase: "200000" }, { network: DST_NETWORK, asset: DST_ASSET, maxTotal: "1000000", maxPerPurchase: "200000" }] },
            limits: { ...DEFAULT_DYNAMIC_LIMITS, ...overrides.limits },
            denyHosts: [],
          },
        }),
  };
}

class SyntheticInbound implements InboundRail {
  #issued = 0;
  async createOffer(request: CreateOfferRequest): Promise<InboundOffer> {
    this.#issued += 1;
    return { scheme: "tempo/charge", network: request.network, asset: request.asset, amount: request.amount, payTo: "0xrouter", maxTimeoutSeconds: 120, extra: { challengeNonce: `0xnonce${this.#issued}`, expiresAt: Math.floor(request.nowMs / 1000) + 60, routeBinding: request.routeBinding } };
  }
  preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult {
    if (credential.payload.challengeNonce !== offer.extra.challengeNonce) return { ok: false, reason: "nonce_mismatch" };
    if (offer.extra.expiresAt * 1000 <= nowMs) return { ok: false, reason: "offer_expired" };
    return { ok: true };
  }
  async verify(): Promise<{ isValid: boolean }> { return { isValid: true }; }
  async settle(): Promise<SettleResult> { return { outcome: "settled", txRef: "src-tx-1" }; }
}

class SyntheticOutbound implements OutboundRail {
  readonly targetsSeen: (UpstreamTarget | undefined)[] = [];
  readonly paidFor: PayRequest[] = [];
  payDelayMs = 0;
  /** MPP 送信のプロファイル用（quote 時の見積り）。 */
  estimateDelayMs = 0;
  estimateBound = "300";
  async readChallenge(routeId: string, target?: UpstreamTarget): Promise<readonly DestinationOffer[]> {
    this.targetsSeen.push(target);
    if (routeId === STATIC_ROUTE) return [{ scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, amount: "900", payTo: DST_PAY_TO }];
    if (routeId === MPP_OUT_PROFILE_ID) return [{ scheme: "tempo/charge", network: SRC_NETWORK, asset: SRC_ASSET, amount: "5000", payTo: DST_PAY_TO, extra: { realm: "r", terms: "{}" } }];
    return [{ scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, amount: "5000", payTo: DST_PAY_TO, extra: { name: "USDC", version: "2" } }];
  }
  async estimateFee(): Promise<FeeEstimate> {
    if (this.estimateDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.estimateDelayMs));
    return { gas: "50000", maxFeePerGas: "6000000000", bound: this.estimateBound, viaFillTransaction: true };
  }
  async pay(request: PayRequest): Promise<PayResult> {
    this.paidFor.push(request);
    if (this.payDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.payDelayMs));
    return { outcome: "paid", body: BODY, contentType: "application/json", txRef: "dst-tx-1" };
  }
}

function credentialFor(offer: unknown): string {
  const o = offer as InboundOffer;
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: o, payload: { challengeNonce: o.extra.challengeNonce } }), "utf8").toString("base64");
}

let workDir: string;
let core: RouterCore;
let server: RunningServer;
let outbound: SyntheticOutbound;
let ids = 0;

async function boot(cfg: RouterConfig = config()): Promise<{ baseUrl: string; client: (source?: string, timeouts?: { timeoutMs?: number; executeTimeoutMs?: number; quoteTimeoutMs?: number }) => RouterClient }> {
  outbound = new SyntheticOutbound();
  core = await createRouterCore({ journalPath: path.join(workDir, "journal.ndjson"), config: cfg, inbound: new SyntheticInbound(), outbound, nextPaymentId: () => `pay-${(ids += 1)}`, dynamic: { ledgerDir: path.join(workDir, "dynamic-quotes") } });
  server = await startHttpServer({ core, config: cfg, canonicalBaseUrl: CANONICAL, principals: new Map([["alice", "tok-alice"], ["bob", "tok-bob"]]), host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return { baseUrl, client: (source, timeouts = {}) => createRouterClient({ baseUrl, principalId: "alice", token: "tok-alice", allowUnissuedQuotes: true, ...(source === undefined ? {} : { source }), ...timeouts }) };
}

async function raw(baseUrl: string, method: string, pathname: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await fetch(`${baseUrl}${pathname}`, { method, headers: { authorization: "Bearer tok-alice", "x-router-principal": "alice", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual" });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>, text };
}

async function filesText(): Promise<string> {
  let out = await readFile(path.join(workDir, "journal.ndjson"), "utf8").catch(() => "");
  const dir = path.join(workDir, "dynamic-quotes");
  for (const file of await readdir(dir).catch(() => [] as string[])) out += await readFile(path.join(dir, file), "utf8");
  return out;
}

beforeEach(async () => {
  await mkdir(runtimeRoot, { recursive: true });
  workDir = await mkdtemp(path.join(runtimeRoot, "t11-dynamic-http-"));
  ids = 0;
});

afterEach(async () => {
  await server?.close();
  await core?.close().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
});

describe("HTTP: R2 の動的 quote", () => {
  test("upstream.url を持つ R2 は、FR-9・FR-10 の全項目を持つ quote 文書を返す。ownerKey は応答だけ（記録はハッシュ）", async () => {
    const { baseUrl } = await boot();
    const r = await raw(baseUrl, "POST", "/v1/quotes", {}, { routeId: PROFILE_ID, requestId: "r1", upstream: { url: URL_A } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      routeId: PROFILE_ID,
      resource: { url: `${CANONICAL}/v1/routes/${PROFILE_ID}/resource`, method: "GET" },
      upstream: { url: URL_A, method: "GET" },
      source: { rail: "mpp", amount: "6000", decimals: 6, asset: SRC_ASSET, network: SRC_NETWORK },
      destination: { rail: "x402", quoted: "5000", decimals: 6, payTo: DST_PAY_TO, asset: DST_ASSET, network: DST_NETWORK },
      pricing: { upstreamAmount: "5000", converted: "5000", fee: "1000", total: "6000", sourceDecimals: 6, destinationDecimals: 6 },
      disclosures: { destinationVerifiedByOperator: false, refundOnFailure: false, fundsMoveOnCredential: true, awaitingPaymentDoesNotMeanUnpaid: true, unsupportedResponseIsPaidWithoutData: true, supportedResponse: "application/json object, <= 256 KiB" },
      approval: { required: true, boundTo: r.body["quoteId"] },
    });
    expect((r.body["disclosures"] as Record<string, unknown>)["routerMayRejectAfterFundsMoved"]).toEqual(["expired", "upstream_changed", "dynamic_disabled", "budget_exhausted", "operator_funds_unavailable"]);
    const ownerKey = r.body["ownerKey"] as string;
    expect(ownerKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await filesText()).not.toContain(ownerKey);
    expect(outbound.targetsSeen).toEqual([{ url: URL_A }]);
    // 記録と一致: status（持ち主の証明つき）が同じ値を返す。
    const s = await raw(baseUrl, "GET", `/v1/purchases/${String(r.body["paymentId"])}`, { "x-router-owner-key": ownerKey });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ status: "awaiting_payment", upstream: { url: URL_A }, dynamic: { profileId: PROFILE_ID, pricing: { total: "6000" }, promoted: false, fundsMoveOnCredential: true, awaitingPaymentDoesNotMeanUnpaid: true } });
  });

  test("upstream が無い R2 は従来どおり（動的の欄が無い）", async () => {
    const { baseUrl } = await boot();
    const r = await raw(baseUrl, "POST", "/v1/quotes", {}, { routeId: STATIC_ROUTE, requestId: "s1" });
    expect(r.status).toBe(200);
    for (const key of ["upstream", "pricing", "disclosures", "ownerKey"]) expect(r.body).not.toHaveProperty(key);
    expect(outbound.targetsSeen).toEqual([undefined]);
  });

  test.each([
    ["静的 route の id に upstream", () => config(), { routeId: STATIC_ROUTE, requestId: "r1", upstream: { url: URL_A } }, 404, "unknown_route"],
    ["無効（enabled: false）", () => config({ enabled: false }), { routeId: PROFILE_ID, requestId: "r1", upstream: { url: URL_A } }, 404, "dynamic_disabled"],
    ["設定に dynamic が無い", () => config({ noDynamic: true }), { routeId: PROFILE_ID, requestId: "r1", upstream: { url: URL_A } }, 404, "dynamic_disabled"],
    ["upstream.url が無い", () => config(), { routeId: PROFILE_ID, requestId: "r1", upstream: {} }, 400, "upstream_url_required"],
    ["URL が https でない", () => config(), { routeId: PROFILE_ID, requestId: "r1", upstream: { url: "http://provider.test/" } }, 400, "invalid_upstream_url"],
  ])("拒否: %s", async (_name, cfg, body, status, error) => {
    const { baseUrl } = await boot(cfg());
    const r = await raw(baseUrl, "POST", "/v1/quotes", {}, body);
    expect(r.status).toBe(status);
    expect(r.body["error"]).toBe(error);
    expect(outbound.targetsSeen).toEqual([]);
  });

  test("requestId の衝突は 409、門の超過は 429", async () => {
    const { baseUrl } = await boot(config({ limits: { quotesPerMinutePerSource: 1 } }));
    expect((await raw(baseUrl, "POST", "/v1/quotes", {}, { routeId: PROFILE_ID, requestId: "r1", upstream: { url: URL_A } })).status).toBe(200);
    const conflict = await raw(baseUrl, "POST", "/v1/quotes", {}, { routeId: PROFILE_ID, requestId: "r1", upstream: { url: URL_A } });
    expect([conflict.status, conflict.body["error"]]).toEqual([409, "request_id_conflict"]);
    const limited = await raw(baseUrl, "POST", "/v1/quotes", {}, { routeId: PROFILE_ID, requestId: "r2", upstream: { url: URL_A } });
    expect([limited.status, limited.body["error"], limited.body["reason"]]).toEqual([429, "rate_limited", "rate_source"]);
  });

  test("x-router-source が門の鍵: 別の送信元なら通り、同じ送信元は数えられる", async () => {
    const { baseUrl } = await boot(config({ limits: { quotesPerMinutePerSource: 1 } }));
    expect((await raw(baseUrl, "POST", "/v1/quotes", { "x-router-source": "fwd:1.1.1.1" }, { routeId: PROFILE_ID, requestId: "r1", upstream: { url: URL_A } })).status).toBe(200);
    expect((await raw(baseUrl, "POST", "/v1/quotes", { "x-router-source": "fwd:2.2.2.2" }, { routeId: PROFILE_ID, requestId: "r2", upstream: { url: URL_A } })).status).toBe(200);
    expect((await raw(baseUrl, "POST", "/v1/quotes", { "x-router-source": "fwd:1.1.1.1" }, { routeId: PROFILE_ID, requestId: "r3", upstream: { url: URL_A } })).status).toBe(429);
  });

  test("R1: 動的プロファイルの一覧（enabled と、払うレール・払われるレール・資産・上限・手数料・開示）。無効でも一覧は出る", async () => {
    const { baseUrl } = await boot(config({ enabled: false }));
    const r = await raw(baseUrl, "GET", "/v1/routes");
    expect(r.status).toBe(200);
    expect((r.body["routes"] as unknown[]).length).toBe(1);
    expect(r.body["dynamic"]).toEqual({
      enabled: false,
      profiles: [{
        profileId: PROFILE_ID,
        resource: { url: `${CANONICAL}/v1/routes/${PROFILE_ID}/resource`, method: "GET" },
        source: { rail: "mpp", network: SRC_NETWORK, asset: SRC_ASSET, decimals: 6 },
        destination: { rail: "x402", scheme: "exact", network: DST_NETWORK, asset: DST_ASSET, decimals: 6 },
        maxUpstreamAmount: "100000",
        fee: { flat: "1000", bps: 0, min: "1000" },
        disclosures: expect.objectContaining({ fundsMoveOnCredential: true, refundOnFailure: false }),
      }],
    });
    expect(r.text).not.toContain("payTo");
    expect(r.text).not.toContain("tokenDomain");
    await server.close();
    await core.close();
    const none = await boot(config({ noDynamic: true }));
    expect((await raw(none.baseUrl, "GET", "/v1/routes")).body).not.toHaveProperty("dynamic");
  });

  test("入口の受信期限が明示されている", async () => {
    await boot();
    expect(server.timeouts).toEqual({ headersTimeoutMs: HTTP_INGRESS_TIMEOUT_MS, requestTimeoutMs: HTTP_INGRESS_TIMEOUT_MS });
    expect(HTTP_INGRESS_TIMEOUT_MS).toBe(10_000);
  });
});

describe("HTTP: R3・R4 と持ち主の証明", () => {
  test("R3: ownerKey 無しは quote が無いのと同じ（402 quote_required／404 unknown_quote）。あれば offer の再提示・購入ができる", async () => {
    const { baseUrl } = await boot();
    const q = (await raw(baseUrl, "POST", "/v1/quotes", {}, { routeId: PROFILE_ID, requestId: "r1", upstream: { url: URL_A } })).body;
    const quoteId = q["quoteId"] as string;
    const ownerKey = q["ownerKey"] as string;
    const pathname = `/v1/routes/${PROFILE_ID}/resource`;
    const none = await raw(baseUrl, "GET", pathname, { "x-router-quote-id": quoteId });
    expect([none.status, none.body["error"], none.body["accepts"]]).toEqual([402, "quote_required", []]);
    const re = await raw(baseUrl, "GET", pathname, { "x-router-quote-id": quoteId, "x-router-owner-key": ownerKey });
    expect([re.status, re.body["error"]]).toEqual([402, "payment_required"]);
    expect((re.body["accepts"] as unknown[]).length).toBe(1);
    const credential = credentialFor((q["source"] as Record<string, unknown>)["offer"]);
    const wrong = await raw(baseUrl, "GET", pathname, { "x-router-quote-id": quoteId, "x-router-request-id": "r1", "x-router-approval": quoteId, "x-payment": credential, "x-router-owner-key": `${ownerKey.slice(0, -1)}${ownerKey.endsWith("A") ? "B" : "A"}` });
    expect([wrong.status, wrong.body["error"]]).toEqual([404, "unknown_quote"]);
    expect(wrong.text).not.toContain(ownerKey);
    const missing = await raw(baseUrl, "GET", pathname, { "x-router-quote-id": quoteId, "x-router-request-id": "r1", "x-router-approval": quoteId, "x-payment": credential });
    expect([missing.status, missing.body["error"]]).toEqual([404, "unknown_quote"]);
    const paid = await raw(baseUrl, "GET", pathname, { "x-router-quote-id": quoteId, "x-router-request-id": "r1", "x-router-approval": quoteId, "x-payment": credential, "x-router-owner-key": ownerKey });
    expect(paid.status).toBe(200);
    expect(paid.body).toEqual(BODY);
    expect(outbound.paidFor[0]).toMatchObject({ routeId: PROFILE_ID, target: { url: URL_A } });
    // R4 も同じ。
    const paymentId = q["paymentId"] as string;
    expect((await raw(baseUrl, "GET", `/v1/purchases/${paymentId}`)).status).toBe(404);
    const s = await raw(baseUrl, "GET", `/v1/purchases/${paymentId}`, { "x-router-owner-key": ownerKey });
    expect(s.body).toMatchObject({ status: "delivered", result: BODY, dynamic: { promoted: true, awaitingPaymentDoesNotMeanUnpaid: false } });
    // ownerKey は journal・控え・応答本文（quote 以外）に出ない。
    expect(await filesText()).not.toContain(ownerKey);
    expect(s.text).not.toContain(ownerKey);
  });

  test("R3: 動的プロファイルの購入口は機能が有効なときだけ存在し、canonical path そのものだけ", async () => {
    const { baseUrl } = await boot(config({ enabled: false }));
    expect((await raw(baseUrl, "GET", `/v1/routes/${PROFILE_ID}/resource`)).status).toBe(404);
    await server.close();
    await core.close();
    const second = await boot();
    expect((await raw(second.baseUrl, "GET", `/v1/routes/${PROFILE_ID}/resource`, { "x-router-quote-id": "x" })).status).toBe(402);
    expect((await raw(second.baseUrl, "GET", `/v1/routes/${PROFILE_ID}//resource`)).status).toBe(404);
  });
});

describe("client", () => {
  test("quoteUrl → execute（ownerKey を運ぶ）→ status（ownerKey が要る）", async () => {
    const { client } = await boot();
    const c = client("fwd:9.9.9.9");
    const quoted = await c.quoteUrl({ profileId: PROFILE_ID, url: URL_A, requestId: "r1" });
    expect(quoted.ok).toBe(true);
    const quote = (quoted as { quote: QuoteView }).quote;
    expect(quote).toMatchObject({ routeId: PROFILE_ID, upstream: { url: URL_A, method: "GET" }, pricing: { total: "6000" }, disclosures: { fundsMoveOnCredential: true } });
    expect(quote.ownerKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 持ち主の証明を落とした quote 文書では実行できない。発行した client は束縛の変化として止め、
    // 持ち回りの client（別プロセス）では Router が「存在しない」として止める。
    const { ownerKey: _dropped, ...withoutKey } = quote;
    const execute = (via: RouterClient) => via.execute({ quote: withoutKey as QuoteView, requestId: "r1", approval: { approved: true, quoteId: quote.quoteId }, credential: credentialFor(quote.source.offer) });
    expect(await execute(c)).toMatchObject({ outcome: "resource_mismatch", reason: "quote_binding_changed" });
    expect(await execute(client())).toMatchObject({ outcome: "rejected", error: "unknown_quote", status: 404 });
    const result = await c.execute({ quote, requestId: "r1", approval: { approved: true, quoteId: quote.quoteId }, credential: credentialFor(quote.source.offer) });
    expect(result).toMatchObject({ outcome: "delivered", paymentId: quote.paymentId, snapshot: BODY });
    expect(await c.status(quote.paymentId)).toMatchObject({ found: false, status: 404 });
    const status = await c.status(quote.paymentId, quote.ownerKey);
    expect(status).toMatchObject({ found: true, projection: { status: "delivered", upstream: { url: URL_A }, dynamic: { promoted: true } } });
  });

  test("quoteUrl は頼んだ URL・プロファイルの quote だけを受け入れる（ownerKey の無い応答は quote にしない）", async () => {
    const { baseUrl } = await boot();
    const tampered = createRouterClient({
      baseUrl,
      principalId: "alice",
      token: "tok-alice",
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const body = (await response.json()) as Record<string, unknown>;
        delete body["ownerKey"];
        return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
      },
    });
    expect(await tampered.quoteUrl({ profileId: PROFILE_ID, url: URL_A, requestId: "r1" })).toEqual({ ok: false, error: "quote_malformed", status: 200 });
  });

  test("listRoutes は dynamic を落とさない", async () => {
    const { client } = await boot();
    const listed = await client().listRoutes();
    expect(listed.ok).toBe(true);
    expect(listed.dynamic).toMatchObject({ enabled: true, profiles: [{ profileId: PROFILE_ID }] });
  });

  test("動的購入の期限は quote の期限と別（既定 120 秒）: 上流の支払いが長くても delivered。静的の購入は従来どおり timeoutMs", async () => {
    expect(DEFAULT_DYNAMIC_EXECUTE_TIMEOUT_MS).toBe(120_000);
    const { client } = await boot();
    // 既定（executeTimeoutMs 未指定）でも、quote の期限 400 ms より長い支払いが通る。
    const c = client(undefined, { timeoutMs: 400 });
    const quoted = await c.quoteUrl({ profileId: PROFILE_ID, url: URL_A, requestId: "r1" });
    const quote = (quoted as { quote: QuoteView }).quote;
    outbound.payDelayMs = 1_200;
    const result = await c.execute({ quote, requestId: "r1", approval: { approved: true, quoteId: quote.quoteId }, credential: credentialFor(quote.source.offer) });
    expect(result).toMatchObject({ outcome: "delivered", snapshot: BODY });
    // 静的 route の購入は timeoutMs のまま（同じ遅さなら unknown になる）。
    const s = await c.quote({ routeId: STATIC_ROUTE, requestId: "s1" });
    const sq = (s as { quote: QuoteView }).quote;
    expect(await c.execute({ quote: sq, requestId: "s1", approval: { approved: true, quoteId: sq.quoteId }, credential: credentialFor(sq.source.offer) })).toMatchObject({ outcome: "unknown", reason: "transport_uncertain" });
  });

  test("動的 quote の期限: quoteTimeoutMs → 明示の timeoutMs → 既定 30 秒。明示した timeoutMs は従来どおり効く", async () => {
    expect(DEFAULT_DYNAMIC_QUOTE_TIMEOUT_MS).toBe(30_000);
    const { client } = await boot(config({ mppOut: true }));
    outbound.estimateDelayMs = 900;
    // 既定（どちらも未指定）: 見積りの長い quote が通る（10 秒の旧既定より長い期限）。
    // 送信元ごとの枠（3/分）に掛からないよう、送信元を分ける。
    const quoted = await client("fwd:10.0.0.1").quoteUrl({ profileId: MPP_OUT_PROFILE_ID, url: URL_A, requestId: "r1" });
    expect(quoted.ok).toBe(true);
    expect((quoted as { quote: QuoteView }).quote.pricing).toMatchObject({ fee: "1000", maxFee: "600", estimate: { bound: "300" } });
    // 明示した timeoutMs（quoteTimeoutMs 無し）はそのまま効く。
    expect(await client("fwd:10.0.0.2", { timeoutMs: 400 }).quoteUrl({ profileId: MPP_OUT_PROFILE_ID, url: URL_A, requestId: "r2" })).toMatchObject({ ok: false, error: "transport_failed" });
    // 明示した quoteTimeoutMs は timeoutMs より優先。
    expect((await client("fwd:10.0.0.3", { timeoutMs: 400, quoteTimeoutMs: 5_000 }).quoteUrl({ profileId: MPP_OUT_PROFILE_ID, url: URL_A, requestId: "r3" })).ok).toBe(true);
    expect(await client("fwd:10.0.0.4", { quoteTimeoutMs: 300 }).quoteUrl({ profileId: MPP_OUT_PROFILE_ID, url: URL_A, requestId: "r4" })).toMatchObject({ ok: false, error: "transport_failed" });
  });

  test("quoteUrl は応答の upstream.url が頼んだ URL と違えば受け入れない", async () => {
    const { baseUrl } = await boot();
    const tampered = createRouterClient({
      baseUrl,
      principalId: "alice",
      token: "tok-alice",
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const body = (await response.json()) as Record<string, unknown>;
        body["upstream"] = { url: "https://other.test/", method: "GET" };
        return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
      },
    });
    expect(await tampered.quoteUrl({ profileId: PROFILE_ID, url: URL_A, requestId: "r1" })).toEqual({ ok: false, error: "quote_malformed", status: 200 });
  });

  test("client の source は門の鍵として Router に届く", async () => {
    const { client } = await boot(config({ limits: { quotesPerMinutePerSource: 1 } }));
    expect((await client("fwd:1.1.1.1").quoteUrl({ profileId: PROFILE_ID, url: URL_A, requestId: "r1" })).ok).toBe(true);
    expect((await client("fwd:2.2.2.2").quoteUrl({ profileId: PROFILE_ID, url: URL_A, requestId: "r2" })).ok).toBe(true);
    expect(await client("fwd:1.1.1.1").quoteUrl({ profileId: PROFILE_ID, url: URL_A, requestId: "r3" })).toMatchObject({ ok: false, error: "rate_limited", status: 429 });
  });

  test("静的 quote の client の形は変わらない", async () => {
    const { client } = await boot();
    const quoted = await client().quote({ routeId: STATIC_ROUTE, requestId: "s1" });
    expect(quoted.ok).toBe(true);
    const quote = (quoted as { quote: QuoteView }).quote;
    for (const key of ["upstream", "pricing", "disclosures", "ownerKey"]) expect(quote).not.toHaveProperty(key);
  });
});

describe("MCP tool handlers", () => {
  const deps = (client: RouterClient) => createToolHandlers({ client, mode: "synthetic", evidence: { label: "test", source: "operator_asserted", verified: false } });

  test("quote_url の subject と nextStep は FR-9・FR-10 の項目を含み、purchase は quote 文書の ownerKey を運び、結果は untrusted で包む", async () => {
    const { client } = await boot();
    const handlers = deps(client("fwd:1.2.3.4"));
    const quoted = await handlers.quoteUrl({ profileId: PROFILE_ID, url: URL_A, requestId: "r1" });
    expect(quoted["ok"]).toBe(true);
    const subject = quoted["subject"] as Record<string, unknown>;
    expect(subject).toMatchObject({ upstream: { url: URL_A }, destinationPayTo: DST_PAY_TO, destinationDecimals: 6, pricing: { upstreamAmount: "5000", fee: "1000", total: "6000" }, disclosures: { refundOnFailure: false, destinationVerifiedByOperator: false }, fundsMoveOnCredential: true });
    const nextStep = quoted["nextStep"] as string;
    for (const fragment of [URL_A, "5000", "1000", "6000", "nothing is refunded", "not verified the destination", "cannot be undone", "does NOT mean unpaid", "application/json object", "paid without data", TOOL_NAMES.purchase]) expect(nextStep).toContain(fragment);
    const quote = quoted["quote"] as QuoteView;
    expect(quote.ownerKey).toBeDefined();
    const purchased = await handlers.purchase({ quoteId: quote.quoteId, requestId: "r1", approval: quote.quoteId, quote, credential: credentialFor(quote.source.offer) });
    expect(purchased).toMatchObject({ ok: true, outcome: "delivered", paymentId: quote.paymentId, result: { untrusted: true, source: "upstream", contentType: "application/json", body: BODY }, proof: { upstreamReceipt: "claimed", onChainFinality: "not_checked" } });
    expect(purchased).not.toHaveProperty("snapshot");
    // status: 既存の引数だけでは見えず、ownerKey を足すと見える。再読取の結果も untrusted で包み、proof を添える。
    expect(await handlers.status({ paymentId: quote.paymentId })).toMatchObject({ found: false });
    const reread = await handlers.status({ paymentId: quote.paymentId, ownerKey: quote.ownerKey });
    expect(reread).toMatchObject({ found: true, projection: { status: "delivered", result: { untrusted: true, source: "upstream", contentType: "application/json", body: BODY } }, proof: { upstreamReceipt: "claimed", onChainFinality: "not_checked" } });
    // 一覧にはプロファイルが出る。
    expect(await handlers.listRoutes()).toMatchObject({ ok: true, dynamic: { enabled: true, profiles: [{ profileId: PROFILE_ID }] } });
  });

  test("MPP 送信のプロファイルの nextStep は cap・見積りの時刻・期限と「配達の保証ではない」を書き、一覧には手数料の決め方が出る", async () => {
    const { client } = await boot(config({ mppOut: true }));
    const handlers = deps(client("fwd:1.2.3.4"));
    outbound.estimateBound = "1500"; // cap 3,000 > 定額 1,000
    const quoted = await handlers.quoteUrl({ profileId: MPP_OUT_PROFILE_ID, url: URL_A, requestId: "m1" });
    expect(quoted["ok"]).toBe(true);
    const quote = quoted["quote"] as QuoteView;
    expect(quote.pricing).toMatchObject({ fee: "3000", total: "8000", maxFee: "3000" });
    const nextStep = quoted["nextStep"] as string;
    for (const fragment of ["gas-cost estimate taken at quote time", "fee cap 3000", `estimated at ${new Date((quote.pricing!["estimate"] as { atMs: number }).atMs).toISOString()}`, "expires at", "not a delivery guarantee", "fee_too_high", "no refund"]) {
      expect(nextStep).toContain(fragment);
    }
    expect((quoted["subject"] as Record<string, unknown>)["disclosures"]).toMatchObject({ routerMayRejectAfterSettle: ["fee_too_high"], feeEstimateIsNotADeliveryGuarantee: true });
    // x402 送信の quote には cap の文は無い。
    const other = await handlers.quoteUrl({ profileId: PROFILE_ID, url: URL_A, requestId: "m2" });
    expect(other["nextStep"] as string).not.toContain("gas-cost estimate");
    const listing = (await handlers.listRoutes()) as { dynamic: { profiles: Record<string, unknown>[] } };
    expect(listing.dynamic.profiles.find((profile) => profile["profileId"] === MPP_OUT_PROFILE_ID)).toMatchObject({ feePolicy: { kind: "gas-indexed", feeMargin: 20_000, maxFeeCeiling: "5000" } });
    expect(listing.dynamic.profiles.find((profile) => profile["profileId"] === PROFILE_ID)).not.toHaveProperty("feePolicy");
  });

  test("既存 tool の互換: 静的 route の quote・purchase・status は既存の引数だけで従来どおり動き、結果の形も変わらない", async () => {
    const { client } = await boot();
    const handlers = deps(client());
    const quoted = await handlers.quote({ routeId: STATIC_ROUTE, requestId: "s1" });
    expect(quoted["ok"]).toBe(true);
    const quote = quoted["quote"] as QuoteView;
    expect(quoted["subject"]).not.toHaveProperty("upstream");
    const purchased = await handlers.purchase({ quoteId: quote.quoteId, requestId: "s1", approval: quote.quoteId });
    expect(purchased).toMatchObject({ ok: true, outcome: "delivered", snapshot: BODY });
    expect(purchased).not.toHaveProperty("proof");
    const status = await handlers.status({ paymentId: quote.paymentId });
    expect(status).toMatchObject({ found: true, projection: { result: BODY } });
    expect(status).not.toHaveProperty("proof");
  });
});

test("送信元の導出: X-Forwarded-For の最後の値 → 接続元 → 固定値。外から来た x-router-source は使わない", () => {
  expect(sourceOfRequest({ "x-forwarded-for": "10.0.0.1, 203.0.113.5", "x-router-source": "spoofed" }, "127.0.0.1")).toBe("fwd:203.0.113.5");
  expect(sourceOfRequest({ "x-forwarded-for": ["10.0.0.1", "203.0.113.9"] }, "127.0.0.1")).toBe("fwd:203.0.113.9");
  expect(sourceOfRequest({ "x-router-source": "spoofed" }, "127.0.0.1")).toBe("addr:127.0.0.1");
  expect(sourceOfRequest({}, undefined)).toBe("unknown");
  expect(sourceOfRequest({ "x-forwarded-for": "a".repeat(65) }, "::1")).toBe("addr:::1");
});
