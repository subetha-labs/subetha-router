/**
 * fetch handler（`docs/provider-x402-workers.md` §4 の handler の行）。fetch を差し替え、facilitator と Hyperliquid を模擬する。
 * 402 の形、支払いつきの各段の失敗（402／502／503）、settle が 1 回、成功の 200 と `PAYMENT-RESPONSE`、応答に秘密と facilitator の文言が無いこと。
 */
import { describe, expect, test } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { handle, runtimeOf } from "../src/index.js";

const ARC_KEY = generatePrivateKey();
const ARC_ADDRESS = privateKeyToAccount(ARC_KEY).address;
const SOL_OWNER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
const FEE_PAYER = "HTazrCcGEzWPKSKLFtbzszPJYTrFdD6xFHN4rLbwQng5";
const ARC = "eip155:5042002";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const FACILITATOR = "https://facilitator.test/x402";
const DATA = "https://data.test/info";
const RESOURCE = "https://provider-x402-arc.subethalabs.com/v1/eth/snapshot";
const SECRET_TEXT = "FACILITATOR_SECRET_DETAIL_DO_NOT_LEAK";
const HL = [{ universe: [{ name: "BTC" }, { name: "ETH" }] }, [{ markPx: "1", prevDayPx: "1", dayNtlVlm: "1" }, { markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00" }]];

interface Fake {
  readonly calls: { url: string; method: string; body: string | undefined; headers: Record<string, string> }[];
  readonly state: {
    supported: "ok" | "slow" | "down";
    data: "ok" | "down" | "malformed";
    verify: "ok" | "invalid" | "down" | "registration" | "malformed";
    settle: { kind: "ok" | "pending" | "failed" | "down" | "registration" | "malformed" | "wrong-network" | "wrong-payer" | "slow"; delayMs?: number };
  };
  readonly fetch: typeof fetch;
}

function fakeFetch(network: "arc" | "solana"): Fake {
  const calls: Fake["calls"] = [];
  const state: Fake["state"] = { supported: "ok", data: "ok", verify: "ok", settle: { kind: "ok" } };
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined, headers });
    if (init?.signal?.aborted) throw new Error("aborted");
    if (url === `${FACILITATOR}/supported`) {
      if (state.supported === "down") throw new Error(SECRET_TEXT);
      if (state.supported === "slow") await sleep(400);
      const kind = network === "arc" ? { x402Version: 2, scheme: "exact", network: ARC, extra: { name: "USDC", version: "2" } } : { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: FEE_PAYER } };
      return json(200, { kinds: [kind] });
    }
    if (url === DATA) {
      if (state.data === "down") throw new Error(SECRET_TEXT);
      if (state.data === "malformed") return json(200, { oops: SECRET_TEXT });
      return json(200, HL);
    }
    if (url === `${FACILITATOR}/verify`) {
      if (state.verify === "down") throw new Error(SECRET_TEXT);
      if (state.verify === "registration") return json(403, { errorReason: "registration_required", detail: SECRET_TEXT });
      if (state.verify === "malformed") return json(200, { what: SECRET_TEXT });
      return json(200, state.verify === "ok" ? { isValid: true, payer: ARC_ADDRESS } : { isValid: false, invalidReason: SECRET_TEXT });
    }
    if (url === `${FACILITATOR}/settle`) {
      const k = state.settle.kind;
      if (state.settle.delayMs !== undefined) await sleep(state.settle.delayMs);
      if (k === "down") throw new Error(SECRET_TEXT);
      if (k === "registration") return json(403, { errorReason: "registration_required", detail: SECRET_TEXT });
      if (k === "malformed") return json(200, { what: SECRET_TEXT });
      if (k === "pending") return json(200, { success: false, errorReason: "settlement_pending", transaction: "", network: network === "arc" ? ARC : SOL, detail: SECRET_TEXT });
      if (k === "failed") return json(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: network === "arc" ? ARC : SOL, errorMessage: SECRET_TEXT });
      const tx = network === "arc" ? `0x${"ab".repeat(32)}` : "2".repeat(88).slice(0, 87) + "1";
      const good = { success: true, transaction: tx, network: network === "arc" ? ARC : SOL, payer: ARC_ADDRESS, extra: SECRET_TEXT };
      if (k === "wrong-network") return json(200, { ...good, network: "eip155:84532" });
      if (k === "wrong-payer") return json(200, { ...good, payer: "0x00000000000000000000000000000000000000b0" });
      return json(200, good);
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  return { calls, state, fetch: fetchImpl };
}

function arcRuntime(fake: Fake, now?: () => number) {
  return runtimeOf({ PROVIDER_NETWORK: "arc", PAY_TO: ARC_ADDRESS, SELLER_PROOF_KEY: ARC_KEY, FACILITATOR_URL: FACILITATOR, DATA_URL: DATA }, { fetch: fake.fetch, ...(now === undefined ? {} : { now }) });
}

async function challenge(fake: Fake, runtime: ReturnType<typeof runtimeOf>): Promise<{ response: Response; required: ReturnType<typeof decodePaymentRequiredHeader> }> {
  const response = await handle(new Request(RESOURCE), runtime, { fetch: fake.fetch });
  const header = response.headers.get("payment-required");
  return { response, required: decodePaymentRequiredHeader(header ?? "") };
}

function paidRequest(accepted: unknown, extra: Record<string, unknown> = {}): Request {
  const payload = { x402Version: 2, resource: { url: RESOURCE }, accepted, payload: { signature: `0x${"11".repeat(65)}`, authorization: { from: ARC_ADDRESS, to: ARC_ADDRESS, value: "10000", validAfter: "0", validBefore: "99999999999", nonce: `0x${"22".repeat(32)}` } }, ...extra };
  return new Request(RESOURCE, { headers: { "payment-signature": encodePaymentSignatureHeader(payload as never) } });
}

function facilitatorCalls(fake: Fake, path: string): Fake["calls"] {
  return fake.calls.filter((c) => c.url === `${FACILITATOR}/${path}`);
}

async function noLeak(response: Response): Promise<void> {
  const text = await response.clone().text();
  expect(text).not.toContain(SECRET_TEXT);
  expect(text).not.toContain(ARC_KEY);
  expect(text).not.toContain(FACILITATOR);
  response.headers.forEach((v) => {
    expect(v).not.toContain(SECRET_TEXT);
    expect(v).not.toContain(ARC_KEY.slice(2));
  });
}

describe("402（未払い）", () => {
  test("arc: accepts は §2.1 の 1 件、トップレベルは 4 つ、本文は {}、no-store。/supported は isolate で 1 回", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    const { response, required } = await challenge(fake, runtime);
    expect(response.status).toBe(402);
    await noLeak(response);
    expect(await response.json()).toEqual({});
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(required).sort()).toEqual(["accepts", "error", "resource", "x402Version"]);
    expect(required.x402Version).toBe(2);
    expect(required.resource).toEqual({ url: RESOURCE, description: "ETH perpetual snapshot (Hyperliquid mark price, 24h change)", mimeType: "application/json" });
    expect(required.accepts).toEqual([{ scheme: "exact", network: ARC, asset: "0x3600000000000000000000000000000000000000", amount: "10000", payTo: ARC_ADDRESS, maxTimeoutSeconds: 30, extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } }]);
    await challenge(fake, runtime);
    expect(facilitatorCalls(fake, "supported")).toHaveLength(1);
  });

  test("solana: feePayer は facilitator の /supported から。memo・recentBlockhash は無い", async () => {
    const fake = fakeFetch("solana");
    const runtime = runtimeOf({ PROVIDER_NETWORK: "solana", PAY_TO: SOL_OWNER, FACILITATOR_URL: FACILITATOR, DATA_URL: DATA }, { fetch: fake.fetch });
    const { required } = await challenge(fake, runtime);
    expect(required.accepts).toEqual([{ scheme: "exact", network: SOL, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amount: "10000", payTo: SOL_OWNER, maxTimeoutSeconds: 30, extra: { feePayer: FEE_PAYER } }]);
  });

  test("他の path・method・クエリは 404/405。/supported が落ちていれば 503 で支払いを受けない（次の要求でやり直す）", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    expect((await handle(new Request("https://provider-x402-arc.subethalabs.com/v1/other"), runtime, { fetch: fake.fetch })).status).toBe(404);
    expect((await handle(new Request(RESOURCE, { method: "POST" }), runtime, { fetch: fake.fetch })).status).toBe(405);
    expect((await handle(new Request(`${RESOURCE}?x=1`), runtime, { fetch: fake.fetch })).status).toBe(404);
    const down = fakeFetch("arc");
    down.state.supported = "down";
    const runtime2 = arcRuntime(down);
    const r = await handle(paidRequest({}), runtime2, { fetch: down.fetch });
    expect(r.status).toBe(503);
    await noLeak(r);
    expect(await r.json()).toEqual({ error: "facilitator_unavailable" });
    expect(facilitatorCalls(down, "verify")).toHaveLength(0);
    down.state.supported = "ok";
    expect((await handle(new Request(RESOURCE), runtime2, { fetch: down.fetch })).status).toBe(402);
  });
});

describe("支払いつきの GET: 各段の失敗と成功（arc）", () => {
  test("accepted が自分の requirements と一致しなければ 402（facilitator 0 回）。decode できないヘッダも 402", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    const { required } = await challenge(fake, runtime);
    const accepted = required.accepts[0]!;
    const r = await handle(paidRequest({ ...accepted, amount: "9999" }), runtime, { fetch: fake.fetch });
    expect(r.status).toBe(402);
    expect(await r.json()).toEqual({ error: "payment_invalid" });
    expect(r.headers.get("payment-required")).toBeTruthy();
    expect((await handle(new Request(RESOURCE, { headers: { "payment-signature": "not-base64!!" } }), runtime, { fetch: fake.fetch })).status).toBe(402);
    expect(facilitatorCalls(fake, "verify")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.url === DATA)).toHaveLength(0);
  });

  test("データが取れない・形が違う → 502 data_unavailable、facilitator は呼ばない", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    const { required } = await challenge(fake, runtime);
    for (const mode of ["down", "malformed"] as const) {
      fake.state.data = mode;
      const r = await handle(paidRequest(required.accepts[0]), runtime, { fetch: fake.fetch });
      expect(r.status, mode).toBe(502);
      await noLeak(r);
      expect(await r.json()).toEqual({ error: "data_unavailable" });
    }
    expect(facilitatorCalls(fake, "verify")).toHaveLength(0);
    expect(facilitatorCalls(fake, "settle")).toHaveLength(0);
  });

  test("verify: 不正 → 402（固定文）、不達・形違い → 502 facilitator_unavailable、403 registration_required → 502 の固定文。settle 0 回。売り手証明が付く", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    const { required } = await challenge(fake, runtime);
    const rows: [Fake["state"]["verify"], number, string][] = [["invalid", 402, "payment_invalid"], ["down", 502, "facilitator_unavailable"], ["malformed", 502, "facilitator_unavailable"], ["registration", 502, "facilitator_registration_required"]];
    for (const [mode, status, error] of rows) {
      fake.state.verify = mode;
      const r = await handle(paidRequest(required.accepts[0]), runtime, { fetch: fake.fetch });
      expect(r.status, mode).toBe(status);
      await noLeak(r);
      expect(await r.json()).toEqual({ error });
    }
    expect(facilitatorCalls(fake, "settle")).toHaveLength(0);
    const verify = facilitatorCalls(fake, "verify")[0]!;
    expect(verify.headers["facilitator-seller-proof"]).toBeTruthy();
    expect(JSON.parse(verify.body!)).toMatchObject({ x402Version: 2, paymentRequirements: required.accepts[0] });
    expect(Object.keys(JSON.parse(verify.body!)).sort()).toEqual(["paymentPayload", "paymentRequirements", "x402Version"]);
  });

  test("settle の表: pending・失敗・不達・形違い・network 違い・別 payer・403 → 502 の固定文、settle は各 1 回。成功 → 200 と PAYMENT-RESPONSE と契約の本文", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    const { required } = await challenge(fake, runtime);
    const rows: [Fake["state"]["settle"]["kind"], string][] = [["pending", "settlement_pending"], ["failed", "settle_failed"], ["down", "facilitator_unavailable"], ["malformed", "facilitator_unavailable"], ["wrong-network", "receipt_malformed"], ["wrong-payer", "receipt_malformed"], ["registration", "facilitator_registration_required"]];
    let settles = 0;
    for (const [kind, error] of rows) {
      fake.state.settle = { kind };
      const r = await handle(paidRequest(required.accepts[0]), runtime, { fetch: fake.fetch });
      settles += 1;
      expect(r.status, kind).toBe(502);
      await noLeak(r);
      expect(await r.json()).toEqual({ error });
      expect(r.headers.get("payment-response")).toBeNull();
      expect(facilitatorCalls(fake, "settle"), kind).toHaveLength(settles);
    }
    fake.state.settle = { kind: "ok" };
    const r = await handle(paidRequest(required.accepts[0]), runtime, { fetch: fake.fetch });
    expect(r.status).toBe(200);
    await noLeak(r);
    expect(facilitatorCalls(fake, "settle")).toHaveLength(settles + 1);
    const receipt = decodePaymentResponseHeader(r.headers.get("payment-response")!);
    expect(receipt).toEqual({ success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC, payer: ARC_ADDRESS });
    const body = (await r.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["data", "dataSource", "fetchedAt", "market", "payment", "providerId"]);
    expect(body).toMatchObject({ providerId: "market-data-a", payment: { protocol: "x402", network: ARC }, data: { markPx: "2572.5", change24h: { absolute: "-121.1", percent: "-4.49" }, assetIndex: 1 } });
    expect(r.headers.get("content-type")).toBe("application/json");
    // 順序: data → verify → settle（facilitator の verify の前にデータを取っている）。
    const order = fake.calls.map((c) => c.url).filter((u) => u === DATA || u.startsWith(FACILITATOR)).slice(-3);
    expect(order).toEqual([DATA, `${FACILITATOR}/verify`, `${FACILITATOR}/settle`]);
  });

  test("期限: 残りが 12 秒未満なら settle を呼ばず 503 provider_busy（verify までは通る）", async () => {
    const fake = fakeFetch("arc");
    let now = 1_000_000;
    const runtime = arcRuntime(fake, () => now);
    const { required } = await challenge(fake, runtime);
    // データの後に時計を進める: verify の fetch で 15 秒進める。
    const original = fake.fetch;
    const slowVerify = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${FACILITATOR}/verify`) now += 15_000;
      return original(input, init);
    }) as typeof fetch;
    const r = await handle(paidRequest(required.accepts[0]), runtime, { fetch: slowVerify, now: () => now });
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "provider_busy" });
    expect(facilitatorCalls(fake, "settle")).toHaveLength(0);
  });
});
