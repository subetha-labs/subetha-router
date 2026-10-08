/**
 * fetch handler（`docs/provider-x402-workers.md` §4 の handler の行）。fetch を差し替え、facilitator と Hyperliquid を模擬する。
 * 402 の形、支払いつきの各段の失敗（402／502／503）、settle が 1 回、成功の 200 と `PAYMENT-RESPONSE`（arc と solana）、
 * 売り手証明を**送られた本文**に対して recover、形違いの payload、byte の上限、cold start の並行、読取の中断、応答に秘密と facilitator の文言が無いこと。
 */
import { describe, expect, test } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { handle, runtimeOf } from "../src/index.js";
import { decodeProof, recoverProof, SOL_FEE_PAYER, SOL_SIGNATURE, solanaTransaction } from "./helpers.js";

const ARC_KEY = generatePrivateKey();
const ARC_ADDRESS = privateKeyToAccount(ARC_KEY).address;
const SOL_OWNER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
const ARC = "eip155:5042002";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const FACILITATOR = "https://facilitator.test/x402";
const DATA = "https://data.test/info";
const RESOURCE = "https://provider-x402-arc.subethalabs.com/v1/eth/snapshot";
const SECRET_TEXT = "FACILITATOR_SECRET_DETAIL_DO_NOT_LEAK";
const BTC_ROW = { markPx: "1", prevDayPx: "1", dayNtlVlm: "1" };
const ETH_ROW = { markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00" };
const HL_META = { universe: [{ name: "BTC" }, { name: "ETH" }] };
const HL = [HL_META, [BTC_ROW, ETH_ROW]];
const SOL_TX = solanaTransaction();

interface Fake {
  readonly calls: { url: string; method: string; body: string | undefined; headers: Record<string, string>; signal: AbortSignal | undefined }[];
  readonly state: {
    supported: "ok" | "slow" | "down" | "other-network" | "no-feepayer";
    data: "ok" | "down" | "malformed" | "huge" | "huge-price" | "stall";
    verify: "ok" | "invalid" | "down" | "registration" | "malformed" | "huge";
    settle: { kind: "ok" | "pending" | "failed" | "down" | "registration" | "malformed" | "wrong-network" | "wrong-payer" };
    payer: string;
  };
  readonly stalledCancels: () => number;
  readonly fetch: typeof fetch;
}

function fakeFetch(network: "arc" | "solana"): Fake {
  const calls: Fake["calls"] = [];
  const state: Fake["state"] = { supported: "ok", data: "ok", verify: "ok", settle: { kind: "ok" }, payer: network === "arc" ? ARC_ADDRESS : SOL_TX.authority };
  let stalledCancels = 0;
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined, headers, signal: init?.signal ?? undefined });
    if (init?.signal?.aborted) throw new Error("aborted");
    if (url === `${FACILITATOR}/supported`) {
      if (state.supported === "down") throw new Error(SECRET_TEXT);
      if (state.supported === "slow") await sleep(300);
      if (state.supported === "other-network") return json(200, { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }] });
      if (state.supported === "no-feepayer") return json(200, { kinds: [{ x402Version: 2, scheme: "exact", network: SOL, extra: {} }] });
      const kind = network === "arc" ? { x402Version: 2, scheme: "exact", network: ARC, extra: { name: "USDC", version: "2" } } : { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: SOL_FEE_PAYER } };
      return json(200, { kinds: [kind] });
    }
    if (url === DATA) {
      if (state.data === "down") throw new Error(SECRET_TEXT);
      if (state.data === "malformed") return json(200, { oops: SECRET_TEXT });
      if (state.data === "huge") {
        // 契約どおりの ETH の行を含むが、全体が 256 KiB を超える応答（content-length 無し）。
        const extra = Array.from({ length: 6_000 }, (_, i) => ({ markPx: "1", prevDayPx: "1", dayNtlVlm: "1", pad: `${i}${"p".repeat(40)}` }));
        return json(200, [{ universe: [...HL_META.universe, ...extra.map((_, i) => ({ name: `X${i}` }))] }, [BTC_ROW, ETH_ROW, ...extra]]);
      }
      if (state.data === "huge-price") return json(200, [HL_META, [BTC_ROW, { markPx: `1${"0".repeat(65 * 1024)}`, prevDayPx: "1", dayNtlVlm: "1" }]]);
      if (state.data === "stall") {
        return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("[")); }, cancel() { stalledCancels += 1; } }), { status: 200 });
      }
      return json(200, HL);
    }
    if (url === `${FACILITATOR}/verify`) {
      if (state.verify === "down") throw new Error(SECRET_TEXT);
      if (state.verify === "registration") return json(403, { errorReason: "registration_required", detail: SECRET_TEXT });
      if (state.verify === "malformed") return json(200, { what: SECRET_TEXT });
      if (state.verify === "huge") return json(200, { isValid: true, pad: "x".repeat(70 * 1024) });
      return json(200, state.verify === "ok" ? { isValid: true, payer: state.payer } : { isValid: false, invalidReason: SECRET_TEXT });
    }
    if (url === `${FACILITATOR}/settle`) {
      const k = state.settle.kind;
      if (k === "down") throw new Error(SECRET_TEXT);
      if (k === "registration") return json(403, { errorReason: "registration_required", detail: SECRET_TEXT });
      if (k === "malformed") return json(200, { what: SECRET_TEXT });
      if (k === "pending") return json(200, { success: false, errorReason: "settlement_pending", transaction: "", network: network === "arc" ? ARC : SOL, detail: SECRET_TEXT });
      if (k === "failed") return json(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: network === "arc" ? ARC : SOL, errorMessage: SECRET_TEXT });
      const tx = network === "arc" ? `0x${"ab".repeat(32)}` : SOL_SIGNATURE;
      const good = { success: true, transaction: tx, network: network === "arc" ? ARC : SOL, payer: state.payer, extra: SECRET_TEXT };
      if (k === "wrong-network") return json(200, { ...good, network: "eip155:84532" });
      if (k === "wrong-payer") return json(200, { ...good, payer: network === "arc" ? "0x00000000000000000000000000000000000000b0" : SOL_FEE_PAYER });
      return json(200, good);
    }
    throw new Error(`unexpected url ${url}`);
  }) as typeof fetch;
  return { calls, state, stalledCancels: () => stalledCancels, fetch: fetchImpl };
}

function arcRuntime(fake: Fake, now?: () => number) {
  return runtimeOf({ PROVIDER_NETWORK: "arc", PAY_TO: ARC_ADDRESS, SELLER_PROOF_KEY: ARC_KEY, FACILITATOR_URL: FACILITATOR, DATA_URL: DATA }, { fetch: fake.fetch, ...(now === undefined ? {} : { now }) });
}

function solRuntime(fake: Fake) {
  return runtimeOf({ PROVIDER_NETWORK: "solana", PAY_TO: SOL_OWNER, FACILITATOR_URL: FACILITATOR, DATA_URL: DATA }, { fetch: fake.fetch });
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

function solPaidRequest(accepted: unknown): Request {
  const payload = { x402Version: 2, resource: { url: RESOURCE }, accepted, payload: { transaction: SOL_TX.transaction } };
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
  // content-length は本文の byte 数と一致する。
  expect(response.headers.get("content-length")).toBe(String(new TextEncoder().encode(text).byteLength));
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("402（未払い）と cold start", () => {
  test("arc: accepts は §2.1 の 1 件、トップレベルは 4 つ、本文は {}、no-store。/supported は isolate で 1 回", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    const { response, required } = await challenge(fake, runtime);
    expect(response.status).toBe(402);
    await noLeak(response);
    expect(await response.json()).toEqual({});
    expect(Object.keys(required).sort()).toEqual(["accepts", "error", "resource", "x402Version"]);
    expect(required.x402Version).toBe(2);
    expect(required.resource).toEqual({ url: RESOURCE, description: "ETH perpetual snapshot (Hyperliquid mark price, 24h change)", mimeType: "application/json" });
    expect(required.accepts).toEqual([{ scheme: "exact", network: ARC, asset: "0x3600000000000000000000000000000000000000", amount: "10000", payTo: ARC_ADDRESS, maxTimeoutSeconds: 30, extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } }]);
    await challenge(fake, runtime);
    expect(facilitatorCalls(fake, "supported")).toHaveLength(1);
    expect(facilitatorCalls(fake, "supported")[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("solana: feePayer は facilitator の /supported から。memo・recentBlockhash は無い", async () => {
    const fake = fakeFetch("solana");
    const { required } = await challenge(fake, solRuntime(fake));
    expect(required.accepts).toEqual([{ scheme: "exact", network: SOL, asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amount: "10000", payTo: SOL_OWNER, maxTimeoutSeconds: 30, extra: { feePayer: SOL_FEE_PAYER } }]);
  });

  test("他の path・method・クエリは 404/405。/supported が落ちている・この network が無い・feePayer が無い → 503 で支払いを受けない（次の要求でやり直す）", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    expect((await handle(new Request("https://provider-x402-arc.subethalabs.com/v1/other"), runtime, { fetch: fake.fetch })).status).toBe(404);
    expect((await handle(new Request(RESOURCE, { method: "POST" }), runtime, { fetch: fake.fetch })).status).toBe(405);
    expect((await handle(new Request(`${RESOURCE}?x=1`), runtime, { fetch: fake.fetch })).status).toBe(404);
    for (const mode of ["down", "other-network"] as const) {
      const down = fakeFetch("arc");
      down.state.supported = mode;
      const runtime2 = arcRuntime(down);
      const r = await handle(paidRequest({}), runtime2, { fetch: down.fetch });
      expect(r.status, mode).toBe(503);
      await noLeak(r);
      expect(await r.json()).toEqual({ error: "facilitator_unavailable" });
      expect(facilitatorCalls(down, "verify")).toHaveLength(0);
      down.state.supported = "ok";
      expect((await handle(new Request(RESOURCE), runtime2, { fetch: down.fetch })).status).toBe(402);
    }
    const sol = fakeFetch("solana");
    sol.state.supported = "no-feepayer";
    const r = await handle(new Request(RESOURCE), solRuntime(sol), { fetch: sol.fetch });
    expect(r.status).toBe(503);
  });

  test("cold start の並行: 同時の要求は 1 本の初期化を待ち、/supported は 1 回、全部が 402", async () => {
    const fake = fakeFetch("arc");
    fake.state.supported = "slow";
    const runtime = arcRuntime(fake);
    const responses = await Promise.all([1, 2, 3].map(() => handle(new Request(RESOURCE), runtime, { fetch: fake.fetch })));
    expect(responses.map((r) => r.status)).toEqual([402, 402, 402]);
    expect(facilitatorCalls(fake, "supported")).toHaveLength(1);
  });
});

describe("支払いつきの GET: 各段の失敗と成功（arc）", () => {
  test("accepted が自分の requirements と一致しなければ 402（facilitator 0 回）。decode できない・形違いの payload も固定の 402", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    const { required } = await challenge(fake, runtime);
    const accepted = required.accepts[0]!;
    const r = await handle(paidRequest({ ...accepted, amount: "9999" }), runtime, { fetch: fake.fetch });
    expect(r.status).toBe(402);
    expect(await r.json()).toEqual({ error: "payment_invalid" });
    expect(r.headers.get("payment-required")).toBeTruthy();
    const malformed: string[] = ["not-base64!!", btoa("null"), btoa("[]"), btoa('"x"'), btoa("{}"), btoa(JSON.stringify({ x402Version: 2 })), btoa(JSON.stringify({ x402Version: 2, accepted: null, payload: {} })), btoa(JSON.stringify({ x402Version: 2, accepted: {}, payload: "p" })), btoa(JSON.stringify({ x402Version: 1, accepted, payload: {} }))];
    for (const header of malformed) {
      const bad = await handle(new Request(RESOURCE, { headers: { "payment-signature": header } }), runtime, { fetch: fake.fetch });
      expect(bad.status, header).toBe(402);
      expect(await bad.json()).toEqual({ error: "payment_invalid" });
    }
    expect(facilitatorCalls(fake, "verify")).toHaveLength(0);
    expect(fake.calls.filter((c) => c.url === DATA)).toHaveLength(0);
  });

  test("データが取れない・形が違う・256 KiB を超える・直列化して 64 KiB を超える → 502 data_unavailable、facilitator は呼ばない", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    const { required } = await challenge(fake, runtime);
    for (const mode of ["down", "malformed", "huge", "huge-price"] as const) {
      fake.state.data = mode;
      const r = await handle(paidRequest(required.accepts[0]), runtime, { fetch: fake.fetch });
      expect(r.status, mode).toBe(502);
      await noLeak(r);
      expect(await r.json()).toEqual({ error: "data_unavailable" });
    }
    expect(facilitatorCalls(fake, "verify")).toHaveLength(0);
    expect(facilitatorCalls(fake, "settle")).toHaveLength(0);
  });

  test("データの本文が途中で止まれば段の期限（2 秒）で reader を cancel し 502、facilitator は呼ばない", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    const { required } = await challenge(fake, runtime);
    fake.state.data = "stall";
    const started = Date.now();
    const r = await handle(paidRequest(required.accepts[0]), runtime, { fetch: fake.fetch });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "data_unavailable" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(fake.stalledCancels()).toBe(1);
    expect(facilitatorCalls(fake, "verify")).toHaveLength(0);
  }, 10_000);

  test("verify: 不正 → 402（固定文）、不達・形違い・64 KiB 超 → 502 facilitator_unavailable、403 registration_required → 502 の固定文。settle 0 回。売り手証明は送った本文に対して recover できる", async () => {
    const fake = fakeFetch("arc");
    const runtime = arcRuntime(fake);
    const { required } = await challenge(fake, runtime);
    const rows: [Fake["state"]["verify"], number, string][] = [["invalid", 402, "payment_invalid"], ["down", 502, "facilitator_unavailable"], ["malformed", 502, "facilitator_unavailable"], ["huge", 502, "facilitator_unavailable"], ["registration", 502, "facilitator_registration_required"]];
    for (const [mode, status, error] of rows) {
      fake.state.verify = mode;
      const r = await handle(paidRequest(required.accepts[0]), runtime, { fetch: fake.fetch });
      expect(r.status, mode).toBe(status);
      await noLeak(r);
      expect(await r.json()).toEqual({ error });
    }
    expect(facilitatorCalls(fake, "settle")).toHaveLength(0);
    const verify = facilitatorCalls(fake, "verify")[0]!;
    expect(verify.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(verify.body!)).toMatchObject({ x402Version: 2, paymentRequirements: required.accepts[0] });
    expect(Object.keys(JSON.parse(verify.body!)).sort()).toEqual(["paymentPayload", "paymentRequirements", "x402Version"]);
    const envelope = decodeProof(verify.headers["facilitator-seller-proof"]!);
    expect(envelope.payTo.toLowerCase()).toBe(ARC_ADDRESS.toLowerCase());
    expect(envelope.network).toBe(ARC);
    expect(envelope.expiresAt - envelope.issuedAt).toBe(60);
    expect(await recoverProof(envelope, "verify", verify.body!)).toBe(ARC_ADDRESS.toLowerCase());
    expect(await recoverProof(envelope, "settle", verify.body!)).not.toBe(ARC_ADDRESS.toLowerCase());
    // 2 つの要求の nonce は違う。
    const second = decodeProof(facilitatorCalls(fake, "verify")[1]!.headers["facilitator-seller-proof"]!);
    expect(second.nonce).not.toBe(envelope.nonce);
  });

  test("settle の表: pending・失敗・不達・形違い・network 違い・別 payer・403 → 502 の固定文、settle は各 1 回。成功 → 200 と PAYMENT-RESPONSE と契約の本文。settle の証明も送った本文に束縛", async () => {
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
    const settle = facilitatorCalls(fake, "settle").at(-1)!;
    const envelope = decodeProof(settle.headers["facilitator-seller-proof"]!);
    expect(await recoverProof(envelope, "settle", settle.body!)).toBe(ARC_ADDRESS.toLowerCase());
    expect(settle.signal).toBeInstanceOf(AbortSignal);
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

describe("支払いつきの GET（solana）", () => {
  test("成功 → 200 と PAYMENT-RESPONSE（payer は transaction の authority）。売り手証明は無い。別 payer・pending → 502", async () => {
    const fake = fakeFetch("solana");
    const runtime = solRuntime(fake);
    const { required } = await challenge(fake, runtime);
    const r = await handle(solPaidRequest(required.accepts[0]), runtime, { fetch: fake.fetch });
    expect(r.status).toBe(200);
    await noLeak(r);
    expect(decodePaymentResponseHeader(r.headers.get("payment-response")!)).toEqual({ success: true, transaction: SOL_SIGNATURE, network: SOL, payer: SOL_TX.authority });
    expect((await r.json()) as Record<string, unknown>).toMatchObject({ payment: { protocol: "x402", network: SOL }, data: { markPx: "2572.5" } });
    const verify = facilitatorCalls(fake, "verify")[0]!;
    expect(verify.headers["facilitator-seller-proof"]).toBeUndefined();
    expect(JSON.parse(verify.body!)).toMatchObject({ paymentRequirements: { extra: { feePayer: SOL_FEE_PAYER } }, paymentPayload: { payload: { transaction: SOL_TX.transaction } } });
    for (const [kind, error] of [["wrong-payer", "receipt_malformed"], ["pending", "settlement_pending"]] as const) {
      fake.state.settle = { kind };
      const bad = await handle(solPaidRequest(required.accepts[0]), runtime, { fetch: fake.fetch });
      expect(bad.status, kind).toBe(502);
      expect(await bad.json()).toEqual({ error });
    }
    expect(facilitatorCalls(fake, "settle")).toHaveLength(3);
    // accepted が一致しなければ 402（facilitator を呼ばない）。
    const before = facilitatorCalls(fake, "verify").length;
    const mismatch = await handle(solPaidRequest({ ...required.accepts[0]!, amount: "9999" }), runtime, { fetch: fake.fetch });
    expect(mismatch.status).toBe(402);
    expect(facilitatorCalls(fake, "verify")).toHaveLength(before);
  });
});
