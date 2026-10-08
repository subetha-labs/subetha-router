/**
 * Provider の純粋関数（`docs/provider-x402-workers.md` §4 の unit の行）: config、売り手証明の往復、snapshot の封筒と制約、領収の表、期限、
 * facilitator client（settle の 1 回の守り、byte の上限、signal での中断）。
 */
import { describe, expect, test } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { configOf, isBase58PublicKey, TABLE } from "../src/config.js";
import { DeadlineError, MIN_REMAINING_BEFORE_SETTLE_MS, RequestDeadline, withSignal } from "../src/deadline.js";
import { BoundedFacilitatorClient, readBoundedJson, SettleCalledTwiceError, supportedKindOf } from "../src/facilitator-client.js";
import { checkReceipt, payerOfPayload } from "../src/receipt.js";
import { sellerProofFor, type SellerRequestTypedData } from "../src/seller-proof.js";
import { DataUnavailableError, MAX_SNAPSHOT_BYTES, percentOf, serializeSnapshot, snapshotOf, subtractDecimal } from "../src/snapshot.js";
import { decodeProof, EXPECTED_PROOF, fromBase64, recoverProof, SOL_FEE_PAYER, SOL_SIGNATURE, solanaTransaction } from "./helpers.js";

const ARC_KEY = generatePrivateKey();
const ARC_ADDRESS = privateKeyToAccount(ARC_KEY).address;
const SOL_OWNER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";

describe("config", () => {
  test("arc: 表の固定値、payTo の形、鍵が要る。solana: 鍵があれば拒む。config に鍵が無い。文言に値が出ない", () => {
    const arc = configOf({ PROVIDER_NETWORK: "arc", PAY_TO: ARC_ADDRESS, SELLER_PROOF_KEY: ARC_KEY });
    expect(arc).toMatchObject({ network: "arc", payTo: ARC_ADDRESS, facilitatorUrl: TABLE.arc.facilitatorUrl, table: { network: "eip155:5042002", amount: "10000" } });
    expect(Object.keys(arc).sort()).toEqual(["dataUrl", "facilitatorUrl", "network", "payTo", "table"]);
    expect(JSON.stringify(arc)).not.toContain(ARC_KEY.slice(2));
    const sol = configOf({ PROVIDER_NETWORK: "solana", PAY_TO: SOL_OWNER });
    expect(sol).toMatchObject({ network: "solana", payTo: SOL_OWNER, facilitatorUrl: TABLE.solana.facilitatorUrl });
    for (const [label, env] of [
      ["network 無し", { PAY_TO: ARC_ADDRESS }],
      ["arc の payTo が base58", { PROVIDER_NETWORK: "arc", PAY_TO: SOL_OWNER, SELLER_PROOF_KEY: ARC_KEY }],
      ["arc の鍵無し", { PROVIDER_NETWORK: "arc", PAY_TO: ARC_ADDRESS }],
      ["arc の鍵の形違い", { PROVIDER_NETWORK: "arc", PAY_TO: ARC_ADDRESS, SELLER_PROOF_KEY: "0xabc" }],
      ["solana に鍵", { PROVIDER_NETWORK: "solana", PAY_TO: SOL_OWNER, SELLER_PROOF_KEY: ARC_KEY }],
      ["solana の payTo が 0x", { PROVIDER_NETWORK: "solana", PAY_TO: ARC_ADDRESS }],
      ["solana の payTo が base58 でも 32 バイトでない", { PROVIDER_NETWORK: "solana", PAY_TO: "1".repeat(44) }],
      ["facilitator が http", { PROVIDER_NETWORK: "solana", PAY_TO: SOL_OWNER, FACILITATOR_URL: "http://facilitator.example/x" }],
    ] as const) {
      let caught: unknown;
      try {
        configOf(env);
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain(ARC_KEY);
      expect((caught as Error).message).not.toContain("0xabc");
    }
    expect(isBase58PublicKey(SOL_OWNER)).toBe(true);
    expect(isBase58PublicKey("1".repeat(44))).toBe(false);
    // 試験用の loopback の facilitator は許す。
    expect(configOf({ PROVIDER_NETWORK: "solana", PAY_TO: SOL_OWNER, FACILITATOR_URL: "http://127.0.0.1:1234/" }).facilitatorUrl).toBe("http://127.0.0.1:1234");
  });
});

describe("売り手証明（Router の fixture と同じ検証。期待値は test/helpers.ts に独立に記す）", () => {
  test("封筒を復号 → EIP-712 で recover → payTo 一致、bodyHash は本文の keccak256、寿命 60 秒、purpose と本文は束縛", async () => {
    const account = privateKeyToAccount(ARC_KEY);
    const now = 1_760_000_000_000;
    const signer = { network: "eip155:5042002", chainId: 5042002, address: account.address, signTypedData: (td: SellerRequestTypedData) => account.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message }), now: () => now };
    const body = JSON.stringify({ x402Version: 2, paymentPayload: { a: 1 }, paymentRequirements: { b: 2 } });
    const envelope = decodeProof(await sellerProofFor(signer, "verify", body));
    expect(Object.keys(envelope).sort()).toEqual(["expiresAt", "issuedAt", "network", "nonce", "payTo", "signature", "version"]);
    expect(envelope.version).toBe(EXPECTED_PROOF.envelopeVersion);
    expect(envelope.issuedAt).toBe(Math.floor(now / 1000));
    expect(envelope.expiresAt).toBe(Math.floor(now / 1000) + EXPECTED_PROOF.lifetimeSeconds);
    expect(envelope.payTo).toBe(account.address);
    expect(envelope.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await recoverProof(envelope, "verify", body)).toBe(account.address.toLowerCase());
    // 別の purpose・別の本文では recover が一致しない（束縛）。
    expect(await recoverProof(envelope, "settle", body)).not.toBe(account.address.toLowerCase());
    expect(await recoverProof(envelope, "verify", `${body} `)).not.toBe(account.address.toLowerCase());
    // nonce は要求ごとに新しい。
    const second = decodeProof(await sellerProofFor(signer, "verify", body));
    expect(second.nonce).not.toBe(envelope.nonce);
  });
});

describe("snapshot（契約の形と制約）", () => {
  const hl = (eth: Record<string, unknown>, extra: unknown[] = []) => [{ universe: [{ name: "BTC" }, { name: "ETH" }, ...extra.map((_, i) => ({ name: `X${i}` }))] }, [{ markPx: "1", prevDayPx: "1", dayNtlVlm: "1" }, eth, ...extra]];

  test("ETH の行から契約の封筒を組む（鍵は過不足なく、数値は文字列、assetIndex は index）", () => {
    const snapshot = snapshotOf(hl({ markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00", funding: "0.0000125" }), "eip155:5042002", () => 1_760_000_000_123);
    expect(Object.keys(snapshot).sort()).toEqual(["data", "dataSource", "fetchedAt", "market", "payment", "providerId"]);
    expect(snapshot).toMatchObject({ providerId: "market-data-a", market: { kind: "perpetual", symbol: "ETH", quote: "USD" }, dataSource: { name: "hyperliquid", network: "hyperliquid-mainnet" }, payment: { protocol: "x402", network: "eip155:5042002" } });
    expect(Object.keys(snapshot.data).sort()).toEqual(["assetIndex", "change24h", "dayNtlVlm", "markPx", "prevDayPx"]);
    expect(snapshot.data).toEqual({ markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00", change24h: { absolute: "-121.1", percent: "-4.49" }, assetIndex: 1 });
    expect(snapshot.fetchedAt).toBe(new Date(1_760_000_000_123).toISOString());
    expect(snapshot.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    for (const v of [snapshot.data.markPx, snapshot.data.prevDayPx, snapshot.data.dayNtlVlm, snapshot.data.change24h.absolute, snapshot.data.change24h.percent]) expect(v).toMatch(/^-?\d+(?:\.\d+)?$/);
    const serialized = serializeSnapshot(snapshot);
    expect(serialized.bytes).toBe(new TextEncoder().encode(serialized.text).byteLength);
    expect(JSON.parse(serialized.text)).toEqual(snapshot);
  });

  test("制約: 正の価格、非負の出来高、ETH が無い・形違い・prev が 0 → data_unavailable", () => {
    for (const [label, eth] of [
      ["markPx が 0", { markPx: "0", prevDayPx: "1", dayNtlVlm: "1" }],
      ["markPx が 0.0", { markPx: "0.0", prevDayPx: "1", dayNtlVlm: "1" }],
      ["markPx が負", { markPx: "-1", prevDayPx: "1", dayNtlVlm: "1" }],
      ["prevDayPx が 0（percent の分母）", { markPx: "1", prevDayPx: "0", dayNtlVlm: "1" }],
      ["dayNtlVlm が負", { markPx: "1", prevDayPx: "1", dayNtlVlm: "-5" }],
      ["指数表記", { markPx: "1e3", prevDayPx: "1", dayNtlVlm: "1" }],
      ["先頭の +", { markPx: "+1", prevDayPx: "1", dayNtlVlm: "1" }],
      [".5", { markPx: ".5", prevDayPx: "1", dayNtlVlm: "1" }],
      ["5.", { markPx: "5.", prevDayPx: "1", dayNtlVlm: "1" }],
      ["数値型", { markPx: 1000, prevDayPx: "1", dayNtlVlm: "1" }],
    ] as const) {
      expect(() => snapshotOf(hl(eth as never), "eip155:5042002"), label).toThrow(DataUnavailableError);
    }
    expect(() => snapshotOf([{ universe: [{ name: "BTC" }] }, [{}]], "x")).toThrow(DataUnavailableError);
    expect(() => snapshotOf([{ universe: [{ name: "ETH" }] }, []], "x")).toThrow(DataUnavailableError);
    expect(() => snapshotOf({}, "x")).toThrow(DataUnavailableError);
    expect(snapshotOf(hl({ markPx: "1", prevDayPx: "1", dayNtlVlm: "0" }), "x").data.dayNtlVlm).toBe("0");
  });

  test("10 進の算術は文字列のまま: absolute は markPx の桁、percent は最後に 1 度だけ 0 方向に切り詰め", () => {
    expect(subtractDecimal("2572.5", "2693.6")).toBe("-121.1");
    expect(subtractDecimal("3000.12", "2950.40")).toBe("49.72");
    expect(subtractDecimal("100.0", "0.5")).toBe("99.5");
    expect(subtractDecimal("100", "0.5")).toBe("99"); // markPx の桁（0）へ切り詰め
    expect(subtractDecimal("0.000000029", "0.000000019")).toBe("0.000000010");
    expect(percentOf("49.72", "2950.40")).toBe("1.68"); // 1.685… → 切り詰め（記録済みの fixture と同じ）
    expect(percentOf("-121.1", "2693.6")).toBe("-4.49"); // −4.4958… → 0 方向
    expect(percentOf("0.000000010", "0.000000019")).toBe("52.63"); // レビューの例（operand を先に丸めない）
    expect(percentOf("1", "3")).toBe("33.33");
    expect(percentOf("-1", "300000")).toBe("0.00"); // −0.0003… → "-0.00" にしない
    expect(percentOf("0", "10")).toBe("0.00");
    expect(percentOf("5", "2.5")).toBe("200.00");
    expect(() => percentOf("1", "0")).toThrow(DataUnavailableError);
    expect(() => percentOf("1", "0.00")).toThrow(DataUnavailableError);
  });

  test("直列化した本文が 64 KiB を超えれば data_unavailable（verify の前）", () => {
    const big = snapshotOf(hl({ markPx: `1${"0".repeat(MAX_SNAPSHOT_BYTES)}`, prevDayPx: "1", dayNtlVlm: "1" }), "x");
    expect(() => serializeSnapshot(big)).toThrow(DataUnavailableError);
    const small = snapshotOf(hl({ markPx: "2", prevDayPx: "1", dayNtlVlm: "1" }), "x");
    expect(serializeSnapshot(small).bytes).toBeLessThan(1024);
  });
});

describe("領収の表（§2.2）と payer の同一性", () => {
  const arcPayload = (from: string) => ({ x402Version: 2, resource: { url: "https://p/v1" }, accepted: {}, payload: { signature: "0x", authorization: { from } } }) as never;
  const ARC = "eip155:5042002";

  test("arc: 成功は from と payer の一致まで。pending・失敗・形違い・別 payer は 502 の分類", () => {
    const ok = checkReceipt("arc", ARC, arcPayload(ARC_ADDRESS), { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC, payer: ARC_ADDRESS.toLowerCase() });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(fromBase64(ok.header)).toContain(`"transaction":"0x${"ab".repeat(32)}"`);
    expect(checkReceipt("arc", ARC, arcPayload(ARC_ADDRESS), { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC }).ok).toBe(true);
    const rows: [string, unknown, string][] = [
      ["pending", { success: false, errorReason: "settlement_pending", transaction: "sig" }, "settlement_pending"],
      ["failed", { success: false, errorReason: "insufficient_funds" }, "settle_failed"],
      ["network 違い", { success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:84532" }, "receipt_malformed"],
      ["transaction の形", { success: true, transaction: "0xabc", network: ARC }, "receipt_malformed"],
      ["別の payer", { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC, payer: "0x00000000000000000000000000000000000000b0" }, "receipt_malformed"],
      ["payer の形", { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC, payer: "nope" }, "receipt_malformed"],
      ["object でない", "ok", "receipt_malformed"],
    ];
    for (const [label, response, reason] of rows) expect(checkReceipt("arc", ARC, arcPayload(ARC_ADDRESS), response), label).toEqual({ ok: false, reason });
    // payload に from が無ければ、payer つきの領収は一致を確かめられないので受けない。
    expect(checkReceipt("arc", ARC, { x402Version: 2, accepted: {}, payload: {} } as never, { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC, payer: ARC_ADDRESS })).toEqual({ ok: false, reason: "receipt_malformed" });
  });

  test("solana: payer は transaction の authority（2 番目の static account）と一致。署名は base58 64 バイト", () => {
    const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    const { transaction, authority } = solanaTransaction();
    const payload = { x402Version: 2, resource: {}, accepted: {}, payload: { transaction } } as never;
    expect(payerOfPayload("solana", payload)).toBe(authority);
    expect(checkReceipt("solana", SOL, payload, { success: true, transaction: SOL_SIGNATURE, network: SOL, payer: authority }).ok).toBe(true);
    expect(checkReceipt("solana", SOL, payload, { success: true, transaction: SOL_SIGNATURE, network: SOL, payer: SOL_FEE_PAYER })).toEqual({ ok: false, reason: "receipt_malformed" });
    expect(checkReceipt("solana", SOL, payload, { success: true, transaction: "abc", network: SOL })).toEqual({ ok: false, reason: "receipt_malformed" });
    expect(checkReceipt("solana", SOL, payload, { success: false, errorReason: "settlement_pending", transaction: SOL_SIGNATURE, network: SOL })).toEqual({ ok: false, reason: "settlement_pending" });
  });
});

describe("期限（要求ごとに 1 つ。段の signal）", () => {
  test("残りと段の上限の小さい方、settle 前の最小残り、予算 0 の段の signal は即 abort", () => {
    let now = 1_000_000;
    const d = new RequestDeadline(() => now, 26_000);
    try {
      expect(d.budgetFor(4_000)).toBe(4_000);
      expect(d.stageSignal(4_000).aborted).toBe(false);
      now += 20_000;
      expect(d.remainingMs()).toBe(6_000);
      expect(d.budgetFor(20_000)).toBe(6_000);
      expect(d.canSettle()).toBe(false);
      expect(MIN_REMAINING_BEFORE_SETTLE_MS).toBe(12_000);
      now += 10_000;
      expect(d.budgetFor(4_000)).toBe(0);
      expect(d.expired()).toBe(true);
      expect(d.stageSignal(4_000).aborted).toBe(true);
    } finally {
      d.release();
    }
  });

  test("段の signal は実時間で切れる（要求全体の timer でも段の予算でも）", async () => {
    const d = new RequestDeadline(Date.now, 60);
    const stage = d.stageSignal(10_000);
    await new Promise((r) => setTimeout(r, 120));
    expect(stage.aborted).toBe(true);
    expect(d.signal.aborted).toBe(true);
    d.release();
    const d2 = new RequestDeadline(Date.now, 10_000);
    const short = d2.stageSignal(30);
    await new Promise((r) => setTimeout(r, 100));
    expect(short.aborted).toBe(true);
    expect(d2.signal.aborted).toBe(false);
    d2.release();
  });

  test("withSignal: 切れていれば即 reject、途中で切れれば reject、値は signal が生きているときだけ", async () => {
    await expect(withSignal(AbortSignal.timeout(1_000), Promise.resolve("ok"))).resolves.toBe("ok");
    await expect(withSignal(AbortSignal.abort(), Promise.resolve("never"))).rejects.toThrow(DeadlineError);
    const controller = new AbortController();
    const pending = withSignal(controller.signal, new Promise<string>((r) => setTimeout(() => r("late"), 500)));
    controller.abort();
    await expect(pending).rejects.toThrow(DeadlineError);
  });
});

describe("facilitator client（自前）", () => {
  const requirements = { scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "10000", payTo: ARC_ADDRESS, maxTimeoutSeconds: 30, extra: {} } as never;
  const payload = { x402Version: 2, resource: { url: "u" }, accepted: requirements, payload: { signature: "0x", authorization: { from: ARC_ADDRESS } } } as never;
  const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("settle は 1 回だけ: 2 回目は送らずに SettleCalledTwiceError", async () => {
    let posts = 0;
    const client = new BoundedFacilitatorClient({ url: "https://f.test/x402", signalFor: () => AbortSignal.timeout(1_000), fetch: (async () => { posts += 1; return jsonResponse(200, { success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:5042002" }); }) as typeof fetch });
    await client.settle(payload, requirements);
    await expect(client.settle(payload, requirements)).rejects.toThrow(SettleCalledTwiceError);
    expect(posts).toBe(1);
    expect(client.settleCalls).toBe(2);
  });

  test("署名が段の signal より遅ければ送らない（fetch 0 回）。切れた signal では署名も始めない", async () => {
    let posts = 0;
    let signings = 0;
    const slowSigner = { network: "eip155:5042002", chainId: 5042002, address: ARC_ADDRESS, signTypedData: () => { signings += 1; return new Promise<`0x${string}`>((r) => setTimeout(() => r(`0x${"11".repeat(65)}`), 300)); } };
    const client = new BoundedFacilitatorClient({ url: "https://f.test/x402", signer: slowSigner, signalFor: () => AbortSignal.timeout(50), fetch: (async () => { posts += 1; return jsonResponse(200, { isValid: true }); }) as typeof fetch });
    const started = Date.now();
    await expect(client.verify(payload, requirements)).rejects.toThrow(DeadlineError);
    // signal が切れた時点で reject する（署名の完了 300 ms を待たない）。
    expect(Date.now() - started).toBeLessThan(200);
    await new Promise((r) => setTimeout(r, 350));
    expect(posts).toBe(0);
    expect(signings).toBe(1);
    const dead = new BoundedFacilitatorClient({ url: "https://f.test/x402", signer: slowSigner, signalFor: () => AbortSignal.abort(), fetch: (async () => { posts += 1; return jsonResponse(200, { isValid: true }); }) as typeof fetch });
    await expect(dead.settle(payload, requirements)).rejects.toThrow(DeadlineError);
    expect(signings).toBe(1);
    expect(posts).toBe(0);
  });

  test("fetch に段の signal を渡し、切れれば DeadlineError（facilitator_unavailable にしない）", async () => {
    const client = new BoundedFacilitatorClient({
      url: "https://f.test/x402",
      signalFor: () => AbortSignal.timeout(50),
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch,
    });
    await expect(client.verify(payload, requirements)).rejects.toThrow(DeadlineError);
  });

  test("本文は byte の上限まで: content-length が超える・流れてくる量が超える → 形違いとして facilitator_unavailable。読取の途中で signal が切れれば reader を cancel", async () => {
    const big = `{"isValid":true,"pad":"${"x".repeat(70 * 1024)}"}`;
    const declared = new Response(big, { status: 200, headers: { "content-length": String(big.length) } });
    expect(await readBoundedJson(declared, 64 * 1024, AbortSignal.timeout(1_000))).toBeUndefined();
    let cancelled = 0;
    const streamed = (): Response => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 80; i += 1) controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        controller.close();
      },
      cancel() { cancelled += 1; },
    }), { status: 200 });
    expect(await readBoundedJson(streamed(), 64 * 1024, AbortSignal.timeout(1_000))).toBeUndefined();
    const client = new BoundedFacilitatorClient({ url: "https://f.test/x402", signalFor: () => AbortSignal.timeout(1_000), fetch: (async () => streamed()) as typeof fetch });
    await expect(client.verify(payload, requirements)).rejects.toThrow(/facilitator_unavailable/);
    // 途中で止まる本文: signal が切れたら reader を cancel し、DeadlineError。
    let stalledCancelled = 0;
    const stalled = new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("{")); }, cancel() { stalledCancelled += 1; } }), { status: 200 });
    await expect(readBoundedJson(stalled, 64 * 1024, AbortSignal.timeout(50))).rejects.toThrow(DeadlineError);
    expect(stalledCancelled).toBe(1);
    expect(cancelled).toBeGreaterThanOrEqual(1);
  });

  test("/supported の kind: この network の exact v2 が要る。Solana は 32 バイトの feePayer が要る", () => {
    const arc = { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:5042002" }] };
    expect(supportedKindOf(arc, "eip155:5042002")).toBeDefined();
    expect(supportedKindOf(arc, "eip155:84532")).toBeUndefined();
    expect(supportedKindOf({ kinds: [{ x402Version: 1, scheme: "exact", network: "eip155:5042002" }] }, "eip155:5042002")).toBeUndefined();
    const sol = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    expect(supportedKindOf({ kinds: [{ x402Version: 2, scheme: "exact", network: sol, extra: { feePayer: SOL_FEE_PAYER } }] }, sol)).toBeDefined();
    expect(supportedKindOf({ kinds: [{ x402Version: 2, scheme: "exact", network: sol }] }, sol)).toBeUndefined();
    expect(supportedKindOf({ kinds: [{ x402Version: 2, scheme: "exact", network: sol, extra: { feePayer: "1".repeat(44) } }] }, sol)).toBeUndefined();
    expect(supportedKindOf("nope", sol)).toBeUndefined();
  });
});
