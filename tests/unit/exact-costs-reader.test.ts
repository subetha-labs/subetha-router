/**
 * `/costs` の読み取りの移行（`docs/exact-costs-reader-design.md` A-1〜A-9）。応答は自前の合成（非公開の契約の見本は repo に入れない）。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createExactPricing, settleAcceptingOf } from "../../src/adapters/inbound/exact-pricing.js";
import { createSettleCosts, parseSettleCosts, parseTenantAccepting, type SettleCostsReader } from "../../src/adapters/inbound/settle-costs.js";
import { createSubethaExactInbound, type SubethaExactInbound } from "../../src/adapters/inbound/subetha-exact.js";
import type { GuardedTransport } from "../../src/net/guarded-fetch.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import { InboundOfferError, OFFER_REFUSAL_DETAILS } from "../../src/ports/inbound.js";
import type { ExactPricingConfig } from "../../src/shared/exact-pricing.js";
import { HOSTED_EXACT_PRICING } from "../../tools/remote-mcp-config.js";
import { createSubethaExactFacilitator, defaultCosts, type FacilitatorFixture } from "../fixtures/subetha-exact-facilitator.js";

const ASSET = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const CHAIN_ID = 84532;
const NETWORK = `eip155:${String(CHAIN_ID)}`;
const TENANT = "router-test";
const TOKEN = "fixture-provider-token-0123";
const SETTLE_TOKEN = "5e".repeat(32);
const ROUTE_ID = "md-zusdc-exact";
const PRICING = { ...HOSTED_EXACT_PRICING } as unknown as ExactPricingConfig;
const T0 = 1_800_000_000_000;
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const expected = { chainId: CHAIN_ID, asset: ASSET };
const doc = (patch: Record<string, unknown> = {}, summary: Record<string, unknown> = {}): Record<string, unknown> => {
  const base = defaultCosts(CHAIN_ID, ASSET.toLowerCase(), TENANT);
  return { ...base, ...patch, summary: { ...(base["summary"] as object), ...summary } };
};
const body = (patch: Record<string, unknown> = {}, summary: Record<string, unknown> = {}): string => JSON.stringify(doc(patch, summary));
const entry = (accepting: unknown, extra: Record<string, unknown> = {}) => ({ budget: [{ tenant: TENANT, accepting, ...extra }] });

let fixture: FacilitatorFixture;
let wall = T0;
let monotonic = 0;
const reports: unknown[] = [];
const tick = (ms: number): void => void ((wall += ms), (monotonic += ms));
const calls = (): number => fixture.calls.byRoute["costs"] ?? 0;
const transport = (): GuardedTransport => createGuardedTransport({ allowLoopback: true, report: (e) => reports.push(e) });
const makeReader = (patch: Partial<Parameters<typeof createSettleCosts>[0]> = {}): SettleCostsReader =>
  createSettleCosts({ baseUrl: `${fixture.baseUrl!}/xfac`, token: () => SETTLE_TOKEN, transport: transport(), chainId: CHAIN_ID, asset: ASSET, tenant: TENANT, now: () => wall, monotonicNow: () => monotonic, timeoutMs: 400, ...patch });
const priceWith = (costs: SettleCostsReader) => createExactPricing({ costs, ethPrice: { price: 3_000_000_000n, atMs: wall }, now: () => wall }).price("r", PRICING, "10000");

beforeEach(async () => {
  wall = T0;
  monotonic = 0;
  reports.length = 0;
  fixture = createSubethaExactFacilitator({ providerId: TENANT, bearer: TOKEN, settleBearer: SETTLE_TOKEN, chainId: CHAIN_ID, asset: ASSET, domainName: "zERC20 USD Coin", domainVersion: "1" });
  await fixture.listen();
});
afterEach(async () => {
  await fixture.close();
});

describe("A-1・A-2: 応答の検査", () => {
  test("前の release の形（l1FeeMaxWei と budget が無い）は費用も受付も使えない", () => {
    const old = doc();
    delete (old["summary"] as Record<string, unknown>)["l1FeeMaxWei"];
    delete old["budget"];
    expect(parseSettleCosts(old, expected, 1)).toBeUndefined();
    expect(parseTenantAccepting(old, expected, TENANT)).toBeUndefined();
  });
  test("受付: 理由・数値・余分な欄の有無によらず boolean がそのまま出る", () => {
    for (const accepting of [true, false]) {
      for (const extra of [{}, { reason: "budget" }, { reason: "something_new", remainingHourWei: "0", itemsRemaining: 0, usage: {} }]) {
        expect(parseTenantAccepting(doc(entry(accepting, extra)), expected, TENANT)).toBe(accepting);
      }
      expect(parseTenantAccepting({ ...doc({ budget: [{ tenant: "other", accepting: !accepting }, null, 7, { tenant: TENANT, accepting }] }), usage: {} }, expected, TENANT)).toBe(accepting);
    }
    // 費用が使えない応答でも受付は読める（別々の判定）。
    const noSuccess = doc(entry(false), { successfulItems: 0, allocatedP90Wei: null, l1FeeMaxWei: null });
    expect([parseSettleCosts(noSuccess, expected, 1), parseTenantAccepting(noSuccess, expected, TENANT)]).toEqual([undefined, false]);
  });
  test("受付が不明: 項が無い・2 つ・別の tenant だけ・boolean でない・配列でない・chain か token が違う", () => {
    for (const json of [
      doc({ budget: undefined }), doc({ budget: null }), doc({ budget: {} }), doc({ budget: [] }), doc({ budget: [{ tenant: "other", accepting: true }] }),
      doc({ budget: [{ tenant: TENANT, accepting: true }, { tenant: TENANT, accepting: true }] }),
      ...["true", 1, null, undefined].map((v) => doc(entry(v))),
      { ...doc(entry(true)), chainId: 1 }, { ...doc(entry(true)), token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }, null, [], "x",
    ]) expect(parseTenantAccepting(json, expected, TENANT), JSON.stringify(json)?.slice(-90)).toBeUndefined();
  });
});

describe("A-5・A-6: 読み取りの状態", () => {
  test("n=100 で読む。答えの後 60 秒は、費用が使えない答えでも読まない", async () => {
    let url = "";
    const inner = transport();
    const costs = makeReader({ transport: { ...inner, fetch: ((u: string, ...rest: unknown[]) => ((url = u), (inner.fetch as (...a: unknown[]) => unknown)(u, ...rest))) as unknown as GuardedTransport["fetch"] } });
    fixture.setCosts({ status: 200, body: body({}, { successfulItems: 0 }) });
    expect(await costs.read()).toEqual({ accepting: true });
    expect(url.endsWith("/xfac/costs?n=100")).toBe(true);
    tick(59_999);
    expect(await costs.read()).toEqual({ accepting: true });
    expect(calls()).toBe(1);
    tick(1);
    await costs.read();
    expect(calls()).toBe(2);
  });
  test("true→false、true→不明は、次の答えで直ちに置き換わる", async () => {
    const costs = makeReader();
    expect((await costs.read()).accepting).toBe(true);
    tick(60_000);
    fixture.setCosts({ status: 200, body: body(entry(false)) });
    expect((await costs.read()).accepting).toBe(false);
    tick(60_000);
    fixture.setCosts({ status: 200, body: body({ budget: [] }) });
    const reading = await costs.read();
    expect(reading.accepting).toBeUndefined();
    expect(reading.costs).toBeDefined();
  });
  test("true→失敗: 60 秒ちょうどで不明。費用は 10 分まで残る", async () => {
    const costs = makeReader();
    await costs.read();
    fixture.setCosts({ status: 401, body: "{}" });
    tick(59_999);
    expect((await costs.read()).accepting).toBe(true);
    tick(1);
    const reading = await costs.read();
    expect([reading.accepting, reading.costs !== undefined]).toEqual([undefined, true]);
  });
  test("false→失敗: 10 分未満は false のまま、10 分ちょうどで不明", async () => {
    const costs = makeReader();
    fixture.setCosts({ status: 200, body: body(entry(false)) });
    await costs.read();
    fixture.setCosts({ status: 500 });
    tick(599_999);
    expect((await costs.read()).accepting).toBe(false);
    tick(1);
    expect((await costs.read()).accepting).toBeUndefined();
  });
  test("費用の使えない答えが続いても、前の費用の時刻は進まず 10 分で失効する", async () => {
    const costs = makeReader();
    expect((await costs.read()).costs).toBeDefined();
    fixture.setCosts({ status: 200, body: body({}, { successfulItems: 0 }) });
    for (let i = 0; i < 9; i += 1) {
      tick(60_000);
      expect((await costs.read()).costs, String(i)).toBeDefined();
    }
    tick(60_000);
    expect(await costs.read()).toEqual({ accepting: true });
  });
  test("壁時計の逆行: 経過が正に見えても失効した値は復活せず、読む回数は待ちに従う", async () => {
    const costs = makeReader();
    await costs.read();
    fixture.setCosts({ status: 401, body: "{}" });
    monotonic += 70_000;
    wall += 10_000; // 実際は 70 秒たったのに、壁時計は 10 秒しか進んでいない。
    expect((await costs.read()).accepting).toBeUndefined();
    expect(calls()).toBe(2);
    monotonic += 530_000;
    expect((await costs.read()).costs).toBeUndefined();
    expect(calls()).toBe(3);
    wall = T0 - 3_600_000;
    for (let i = 0; i < 5; i += 1) expect(await costs.read()).toEqual({});
    expect(calls()).toBe(3);
    monotonic += 10_000;
    await costs.read();
    expect(calls()).toBe(4);
  });
  test("壁時計が進んで失効した値は、時計が直っても復活しない（読みに行けない間も）", async () => {
    const costs = makeReader();
    expect(Object.keys(await costs.read()).sort()).toEqual(["accepting", "costs"]);
    wall += 610_000;
    monotonic += 1_000;
    expect(await costs.read()).toEqual({});
    wall -= 608_000;
    monotonic += 1_000;
    expect(await costs.read()).toEqual({});
    expect(calls()).toBe(1);
  });
  test("時間切れの後に遅れて届いた答え・失敗は、新しい状態を変えない", async () => {
    const inner = transport();
    const late: { resolve: (r: Response) => void; reject: (e: Error) => void }[] = [];
    let hold = true;
    const held: GuardedTransport = { ...inner, fetch: ((...args: unknown[]) => (hold ? new Promise((resolve, reject) => late.push({ resolve: resolve as (r: Response) => void, reject })) : (inner.fetch as (...a: unknown[]) => unknown)(...args))) as unknown as GuardedTransport["fetch"] };
    const costs = makeReader({ transport: held, timeoutMs: 40 });
    expect(await costs.read()).toEqual({});
    monotonic += 10_000;
    expect(await costs.read()).toEqual({});
    hold = false;
    monotonic += 10_000;
    expect((await costs.read()).accepting).toBe(true);
    const response = new Response(body(entry(false)), { status: 200 });
    late[0]!.resolve(response);
    late[1]!.reject(new Error("late"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await costs.read()).accepting).toBe(true);
    expect(response.bodyUsed || response.body?.locked === false).toBe(true);
    await expect(response.text()).rejects.toThrow();
  });
  test("読み取りの時間切れの timer は、答え・失敗のどちらの後にも残らない", async () => {
    const TIMEOUT = 4_321;
    for (const answer of [{ status: 200 }, { status: 500 }]) {
      fixture.setCosts(answer);
      const set = vi.spyOn(globalThis, "setTimeout");
      const clear = vi.spyOn(globalThis, "clearTimeout");
      try {
        await makeReader({ timeoutMs: TIMEOUT }).read();
        const handles = set.mock.calls.map((call, i) => [call[1], set.mock.results[i]!.value] as const).filter(([ms]) => ms === TIMEOUT).map(([, handle]) => handle);
        expect(handles).toHaveLength(1);
        expect(clear.mock.calls.map((call) => call[0])).toContain(handles[0]);
      } finally {
        set.mockRestore();
        clear.mockRestore();
      }
    }
  });
  test("遅い 429 の待ちは、返った時から数える", async () => {
    fixture.setCosts({ status: 429, headers: { "retry-after": "1" }, body: "{}", delayMs: 100 });
    const costs = makeReader();
    const started = costs.read();
    monotonic += 3_000;
    expect(await started).toEqual({});
    monotonic += 999;
    await costs.read();
    expect(calls()).toBe(1);
    monotonic += 1;
    await costs.read();
    expect(calls()).toBe(2);
  });
  test("中断に応じない transport（DNS で止まる）・headers が来ない・本文の途中で止まる: 待つ側が終わり、次の読み取りができる", async () => {
    const stuck = http.createServer((req, res) => {
      if (req.url!.startsWith("/body/")) res.writeHead(200, { "content-type": "application/json" }).write("{");
    });
    await new Promise<void>((resolve) => stuck.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${String((stuck.address() as AddressInfo).port)}`;
    const open = (): Promise<number> => new Promise((resolve) => stuck.getConnections((_e, n) => resolve(n)));
    try {
      const never: GuardedTransport = { ...transport(), fetch: (() => new Promise(() => undefined)) as unknown as GuardedTransport["fetch"] };
      for (const patch of [{ transport: never }, { baseUrl: `${base}/headers` }, { baseUrl: `${base}/body` }]) {
        let blocked = true;
        const inner = transport();
        const healthy = `${fixture.baseUrl!}/xfac/costs?n=100`;
        const costs = makeReader({
          timeoutMs: 60,
          ...patch,
          transport: { ...inner, fetch: ((u: string, ...rest: unknown[]) => (blocked ? ((patch.transport ?? inner).fetch as (...a: unknown[]) => unknown)(u, ...rest) : (inner.fetch as (...a: unknown[]) => unknown)(healthy, ...rest))) as unknown as GuardedTransport["fetch"] },
        });
        expect(await Promise.all([costs.read(), costs.read()])).toEqual([{}, {}]);
        // 打ち切った接続は自分で閉じる（後始末の強制終了によらない）。
        for (let i = 0; i < 40 && (await open()) > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(await open()).toBe(0);
        blocked = false;
        monotonic += 10_000;
        expect((await costs.read()).accepting).toBe(true);
      }
    } finally {
      stuck.closeAllConnections();
      await new Promise((resolve) => stuck.close(resolve));
    }
  });
});

describe("A-3・A-6: 式の route", () => {
  test("true だけ売る。false・不明・失敗の 60 秒後は断る（費用が 10 分以内でも）", async () => {
    const costs = makeReader();
    expect((await priceWith(costs)).ok).toBe(true);
    for (const answer of [{ status: 200, body: body(entry(false)) }, { status: 200, body: body({ budget: [] }) }, { status: 200, body: body({ budget: undefined }) }]) {
      tick(60_000);
      fixture.setCosts(answer);
      expect(await priceWith(costs)).toEqual({ ok: false, reason: "pricing_unavailable" });
    }
    tick(60_000);
    fixture.setCosts({ status: 200 });
    expect((await priceWith(costs)).ok).toBe(true);
    fixture.setCosts({ status: 401, body: "{}" });
    tick(60_000);
    expect(await priceWith(costs)).toEqual({ ok: false, reason: "pricing_unavailable" });
  });
  test("60 秒の境目で費用が上がったら、上がった費用で計算する", async () => {
    const costs = makeReader();
    const before = await priceWith(costs);
    fixture.setCosts({ status: 200, body: body({}, { allocatedP90Wei: "1400000000000" }) });
    tick(60_000);
    const after = await priceWith(costs);
    expect(before.ok && after.ok && Number(after.price.settle) > Number(before.price.settle)).toBe(true);
  });
  test("読み取りの間に費用が 10 分を越えたら使わない", async () => {
    const costs = makeReader();
    await costs.read();
    tick(599_990);
    fixture.setCosts({ status: 200, body: body({}, { successfulItems: 0 }), delayMs: 80 });
    const pending = priceWith(costs);
    tick(20);
    expect(await pending).toEqual({ ok: false, reason: "pricing_unavailable" });
  });
});

test("A-8: 受付の確認は固定の route だけ読む。式の route は、価格の後に false に変わっていても読まずに通す", async () => {
  let accepting = true;
  let reads = 0;
  const reader: SettleCostsReader = { read: async () => ((reads += 1), { accepting }) };
  const gate = settleAcceptingOf(reader, [{ routeId: "fixed" }, { routeId: "formula", pricing: PRICING }]);
  accepting = false;
  expect([await gate("formula"), await gate("unknown"), reads]).toEqual([undefined, undefined, 0]);
  expect([await gate("fixed"), reads]).toEqual([false, 1]);
});

describe("A-4・A-5・A-9: 固定の額の route（adapter）", () => {
  let workDir: string;
  let adapter: SubethaExactInbound | undefined;
  beforeEach(async () => {
    workDir = await mkdtemp(path.join(runtimeRoot, "costs-reader-"));
  });
  afterEach(async () => {
    await adapter?.close().catch(() => undefined);
    adapter = undefined;
    await rm(workDir, { recursive: true, force: true });
  });
  async function boot(settleAccepting?: (routeId: string) => Promise<boolean | undefined>, maxUnresolved = 100): Promise<SubethaExactInbound> {
    const created = createSubethaExactInbound({
      facilitatorUrl: `${fixture.baseUrl!}/p/${TENANT}`,
      settleFacilitatorUrl: `${fixture.baseUrl!}/xfac`,
      token: () => TOKEN,
      transport: transport(),
      asset: { network: NETWORK, id: ASSET, decimals: 6, domain: { name: "zERC20 USD Coin", version: "1" } },
      ledgerDir: path.join(workDir, "subetha-exact"),
      limits: { maxRequestsTotal: 1000, maxUnresolved, requestsPerMinute: 1000 },
      ...(settleAccepting === undefined ? {} : { settleAccepting }),
    });
    await created.startup();
    adapter = created;
    return created;
  }
  const request = (requestId: string, extra: Record<string, unknown> = {}) => ({ routeId: ROUTE_ID, amount: "2000", asset: ASSET, network: NETWORK, routeBinding: `${ROUTE_ID}|GET|x`, nowMs: Date.now(), requester: { principalId: "alice", requestId }, ...extra }) as Parameters<SubethaExactInbound["createOffer"]>[0];
  const rows = async (): Promise<number> => (await readFile(path.join(workDir, "subetha-exact", "orders.ndjson"), "utf8").catch(() => "")).split("\n").filter((l) => l !== "").length;
  const refusal = async (run: Promise<unknown>): Promise<unknown> => run.then(() => "offer", (e: unknown) => (e instanceof InboundOfferError ? [e.code, e.detail, e.retryAfterMs] : e));
  const gateOf = (costs: SettleCostsReader) => async (): Promise<boolean | undefined> => (await costs.read()).accepting;

  test("false なら断る: 注文の作成・照会・sweep 0 回、ledger の行 0（未解決の上限に達していても）。標準の入口も同じ。終われば売る", async () => {
    const costs = makeReader();
    const created = await boot(gateOf(costs), 1);
    await created.createOffer(request("first"));
    const before = { ...fixture.calls.byRoute, costs: 0 };
    const ledgerBefore = await rows();
    fixture.setCosts({ status: 200, body: body(entry(false)) });
    tick(60_000);
    for (const extra of [{}, { entry: "x402" }]) expect(await refusal(created.createOffer(request("second", extra)))).toEqual(["source_offer_unavailable", "settle_budget", 60_000]);
    expect({ ...fixture.calls.byRoute, costs: 0 }).toEqual(before);
    expect(await rows()).toBe(ledgerBefore);
    expect(calls()).toBe(2);
    expect(OFFER_REFUSAL_DETAILS.has("settle_budget")).toBe(true);
  });
  test("不明・500・401・時間切れ・例外（false の記憶なし）は今までどおり売る", async () => {
    let n = 0;
    for (const answer of [{ status: 200, body: body({ budget: [] }) }, { status: 500 }, { status: 401, body: "{}" }, { status: 200, delayMs: 300 }]) {
      fixture.setCosts(answer);
      const created = await boot(gateOf(makeReader({ timeoutMs: 100 })));
      expect(await refusal(created.createOffer(request(`r${String((n += 1))}`))), JSON.stringify(answer).slice(0, 40)).toBe("offer");
      await created.close();
    }
    const created = await boot(() => Promise.reject(new Error("boom")));
    expect(await refusal(created.createOffer(request("thrown")))).toBe("offer");
  });
  test("式の route: 価格の後に受付が false に変わっても、決めた価格で注文を作り、もう 1 度は読まない", async () => {
    const costs = makeReader();
    const created = await boot(settleAcceptingOf(costs, [{ routeId: ROUTE_ID, pricing: PRICING }]));
    const priced = await priceWith(costs);
    if (!priced.ok) throw new Error(priced.reason);
    fixture.setCosts({ status: 200, body: body(entry(false)) });
    tick(60_000);
    expect(await created.createOffer(request("priced", { amount: priced.price.total }))).toMatchObject({ amount: priced.price.total });
    expect(calls()).toBe(1);
    // 同じ状態で固定の route なら断る（切り替わっていることの確かめ）。
    await created.close();
    const fixed = await boot(settleAcceptingOf(costs, [{ routeId: ROUTE_ID }]));
    expect(await refusal(fixed.createOffer(request("fixed")))).toEqual(["source_offer_unavailable", "settle_budget", 60_000]);
    expect(calls()).toBe(2);
  });
  test("false の後の失敗は 10 分未満は断り、10 分ちょうどで売る", async () => {
    const costs = makeReader();
    fixture.setCosts({ status: 200, body: body(entry(false)) });
    const created = await boot(gateOf(costs));
    expect(await refusal(created.createOffer(request("a")))).toEqual(["source_offer_unavailable", "settle_budget", 60_000]);
    fixture.setCosts({ status: 401, body: "{}" });
    tick(599_999);
    expect(await refusal(created.createOffer(request("b")))).toEqual(["source_offer_unavailable", "settle_budget", 60_000]);
    tick(1);
    expect(await refusal(created.createOffer(request("c")))).toBe("offer");
  });
  test("無効なら `/costs` を読まない。受付の段に route の id が渡る。止まった読み取りの後も次の注文ができる", async () => {
    const off = await boot();
    await off.createOffer(request("off"));
    expect(calls()).toBe(0);
    await off.close();
    const seen: string[] = [];
    const on = await boot(async (routeId) => void seen.push(routeId) as undefined);
    await on.createOffer(request("on"));
    expect(seen).toEqual([ROUTE_ID]);
    await on.close();
    const never: GuardedTransport = { ...transport(), fetch: (() => new Promise(() => undefined)) as unknown as GuardedTransport["fetch"] };
    const halfOpen = http.createServer((req, res) => {
      if (req.url!.startsWith("/body/")) res.writeHead(200, { "content-type": "application/json" }).write("{");
    });
    await new Promise<void>((resolve) => halfOpen.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${String((halfOpen.address() as AddressInfo).port)}`;
    try {
      for (const [name, patch] of [["dns", { transport: never }], ["headers", { baseUrl: `${base}/headers` }], ["body", { baseUrl: `${base}/body` }]] as const) {
        const stuck = await boot(gateOf(makeReader({ timeoutMs: 50, ...patch })));
        expect(await refusal(stuck.createOffer(request(`${name}-1`))), name).toBe("offer");
        expect(await refusal(stuck.createOffer(request(`${name}-2`))), name).toBe("offer");
        await stuck.close();
      }
    } finally {
      halfOpen.closeAllConnections();
      await new Promise((resolve) => halfOpen.close(resolve));
    }
  });
  test("断った後も、発行済みの offer は自分のものとして扱われる。token・予算の値が通信の記録と断りの文に出ない（支払いまで通す試験は wire）", async () => {
    const costs = makeReader();
    const created = await boot(gateOf(costs));
    const offer = await created.createOffer(request("kept"));
    fixture.setCosts({ status: 200, body: body(entry(false, { remainingHourWei: "987654321987", reason: "budget" })) });
    tick(60_000);
    const error = await created.createOffer(request("no")).then(() => undefined, (e: unknown) => e as Error);
    expect(created.ownsOffer!(offer)).toBe(true);
    expect(created.settleWindowOf!(offer)).toBe(offer.extra.expiresAt);
    for (const secret of [SETTLE_TOKEN, "987654321987"]) expect(JSON.stringify(reports) + String(error) + String(error?.stack)).not.toContain(secret);
  });
});
