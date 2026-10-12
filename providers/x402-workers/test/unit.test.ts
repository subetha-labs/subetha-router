/**
 * Provider の純粋関数（`docs/provider-x402-workers.md` §4 の unit の行）: config、売り手証明の往復、snapshot の封筒と制約、領収の表、期限、
 * facilitator client（settle の 1 回の守り、byte の上限、signal での中断）。
 */
import { describe, expect, test } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { configOf, DESCRIPTION, isBase58PublicKey, RESOURCE_PATH, resourceOf, RESOURCES, TABLE } from "../src/config.js";
import { DeadlineError, MIN_REMAINING_BEFORE_SETTLE_MS, RequestDeadline, withSignal, type Stage } from "../src/deadline.js";
import { BoundedFacilitatorClient, readBoundedJson, SettleCalledTwiceError, supportedKindOf } from "../src/facilitator-client.js";
import { checkReceipt, payerOfPayload } from "../src/receipt.js";
import { sellerProofFor, type SellerRequestTypedData } from "../src/seller-proof.js";
import { MAX_ACCEPTED_DEPTH, stableJson, TooDeepError } from "../src/requirements.js";
import { DataUnavailableError, MAX_SNAPSHOT_BYTES, percentOf, serializeSnapshot, snapshotOf, subtractDecimal, truncateToScale } from "../src/snapshot.js";
import { decodeProof, EXPECTED_PROOF, fromBase64, recoverProof, SOL_FEE_PAYER, SOL_SIGNATURE, solanaTransaction } from "./helpers.js";

const ARC_KEY = generatePrivateKey();
const ARC_ADDRESS = privateKeyToAccount(ARC_KEY).address;
const SOL_OWNER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";

/** signal だけの段（時計の経過は signal と同じ）。 */
function stageOf(signal: AbortSignal): Stage {
  return { signal, expired: () => signal.aborted, dispose: () => {} };
}

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

describe("resources（§11: path → 銘柄と説明）", () => {
  test("2 本の資源。完全一致だけ（末尾 /・大文字・クエリは不一致）。既定の RESOURCE_PATH/DESCRIPTION は ETH", () => {
    expect(RESOURCES.map((r) => r.path)).toEqual(["/v1/eth/snapshot", "/v1/sol/snapshot"]);
    expect(resourceOf("/v1/sol/snapshot")).toEqual({ path: "/v1/sol/snapshot", symbol: "SOL", description: "SOL perpetual snapshot (Hyperliquid mark price, 24h change)" });
    expect(resourceOf("/v1/eth/snapshot")?.symbol).toBe("ETH");
    for (const p of ["/v1/sol/snapshot/", "/V1/SOL/SNAPSHOT", "/v1/sol/snapshot?x=1", "/v1/btc/snapshot", "", "/"]) expect(resourceOf(p), p).toBeUndefined();
    expect(RESOURCE_PATH).toBe("/v1/eth/snapshot");
    expect(DESCRIPTION).toBe("ETH perpetual snapshot (Hyperliquid mark price, 24h change)");
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

  test("§11: symbol SOL は SOL の行から組み、ETH の行は見ない。universe に SOL が無ければ data_unavailable（ETH があっても）", () => {
    const rows = [{ universe: [{ name: "BTC" }, { name: "ETH" }, { name: "SOL" }] }, [{ markPx: "1", prevDayPx: "1", dayNtlVlm: "1" }, { markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "1" }, { markPx: "107.94", prevDayPx: "111.91", dayNtlVlm: "98765.5" }]];
    const snapshot = snapshotOf(rows, "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", () => 1_760_000_000_123, "SOL");
    expect(snapshot.market).toEqual({ kind: "perpetual", symbol: "SOL", quote: "USD" });
    expect(snapshot.data).toEqual({ markPx: "107.94", prevDayPx: "111.91", dayNtlVlm: "98765.5", change24h: { absolute: "-3.97", percent: "-3.54" }, assetIndex: 2 });
    expect(Object.keys(snapshot).sort()).toEqual(["data", "dataSource", "fetchedAt", "market", "payment", "providerId"]);
    expect(snapshotOf(rows, "x").market.symbol).toBe("ETH"); // 既定は ETH のまま
    expect(() => snapshotOf(hl({ markPx: "1", prevDayPx: "1", dayNtlVlm: "1" }), "x", Date.now, "SOL")).toThrow(DataUnavailableError);
    expect(() => snapshotOf([{ universe: [{ name: "SOL" }] }, [{ markPx: "1", prevDayPx: "1", dayNtlVlm: "1" }]], "x", Date.now, "ETH")).toThrow(DataUnavailableError);
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

  test("10 進の算術は文字列のまま: 差は正確、absolute は markPx の桁へ切り詰め、percent は最後に 1 度だけ 0 方向に切り詰め", () => {
    expect(subtractDecimal("2572.5", "2693.6")).toBe("-121.1");
    expect(subtractDecimal("3000.12", "2950.40")).toBe("49.72");
    expect(subtractDecimal("100.0", "0.5")).toBe("99.5");
    expect(subtractDecimal("100", "0.5")).toBe("99.5"); // 差は正確（桁の大きい方）
    expect(subtractDecimal("100", "99.9")).toBe("0.1");
    expect(subtractDecimal("0.000000029", "0.000000019")).toBe("0.000000010");
    expect(truncateToScale("99.5", 0)).toBe("99");
    expect(truncateToScale("-0.1", 0)).toBe("0"); // "-0" にしない
    expect(truncateToScale("-121.16", 1)).toBe("-121.1");
    expect(truncateToScale("5", 2)).toBe("5.00");
    expect(truncateToScale("0.1", 1)).toBe("0.1");
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

  test("桁が違う入力: absolute は markPx の桁、percent は切り詰める前の差から（100 / 99.9 → 0 と 0.10）", () => {
    const mixed = snapshotOf(hl({ markPx: "100", prevDayPx: "99.9", dayNtlVlm: "1" }), "x");
    expect(mixed.data.change24h).toEqual({ absolute: "0", percent: "0.10" });
    const down = snapshotOf(hl({ markPx: "2572", prevDayPx: "2693.6", dayNtlVlm: "1" }), "x");
    expect(down.data.change24h).toEqual({ absolute: "-121", percent: "-4.51" }); // −121.6 / 2693.6 = −4.514…
    const finer = snapshotOf(hl({ markPx: "0.000000029", prevDayPx: "0.00000002", dayNtlVlm: "1" }), "x");
    expect(finer.data.change24h).toEqual({ absolute: "0.000000009", percent: "45.00" });
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

  test("段: 時計で見た経過は timer と独立（timer の配達が遅れていても expired）。dispose で timer を外す。要求の abort は段に伝わる", async () => {
    let now = 1_000_000;
    const d = new RequestDeadline(() => now, 26_000);
    const stage = d.stage(4_000);
    expect(stage.expired()).toBe(false);
    now += 4_000; // 実時間は進んでいない: timer は配達されていないが、時計では段の終わり
    expect(stage.signal.aborted).toBe(false);
    expect(stage.expired()).toBe(true);
    stage.dispose();
    d.release();
    const real = new RequestDeadline(Date.now, 10_000);
    const short = real.stage(30);
    short.dispose();
    await new Promise((r) => setTimeout(r, 80));
    expect(short.signal.aborted).toBe(false); // dispose の後は切れない（timer を外した）
    const whole = new RequestDeadline(Date.now, 40);
    const inner = whole.stage(5_000);
    await new Promise((r) => setTimeout(r, 90));
    expect(inner.signal.aborted).toBe(true); // 要求全体の期限で段も切れる
    expect(inner.expired()).toBe(true);
    inner.dispose();
    whole.release();
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
    const client = new BoundedFacilitatorClient({ url: "https://f.test/x402", stageFor: () => stageOf(AbortSignal.timeout(1_000)), fetch: (async () => { posts += 1; return jsonResponse(200, { success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:5042002" }); }) as typeof fetch });
    await client.settle(payload, requirements);
    await expect(client.settle(payload, requirements)).rejects.toThrow(SettleCalledTwiceError);
    expect(posts).toBe(1);
    expect(client.settleCalls).toBe(2);
  });

  test("署名が段の signal より遅ければ送らない（fetch 0 回）。切れた signal では署名も始めない", async () => {
    let posts = 0;
    let signings = 0;
    const slowSigner = { network: "eip155:5042002", chainId: 5042002, address: ARC_ADDRESS, signTypedData: () => { signings += 1; return new Promise<`0x${string}`>((r) => setTimeout(() => r(`0x${"11".repeat(65)}`), 300)); } };
    const client = new BoundedFacilitatorClient({ url: "https://f.test/x402", signer: slowSigner, stageFor: () => stageOf(AbortSignal.timeout(50)), fetch: (async () => { posts += 1; return jsonResponse(200, { isValid: true }); }) as typeof fetch });
    const started = Date.now();
    await expect(client.verify(payload, requirements)).rejects.toThrow(DeadlineError);
    // signal が切れた時点で reject する（署名の完了 300 ms を待たない）。
    expect(Date.now() - started).toBeLessThan(200);
    await new Promise((r) => setTimeout(r, 350));
    expect(posts).toBe(0);
    expect(signings).toBe(1);
    const dead = new BoundedFacilitatorClient({ url: "https://f.test/x402", signer: slowSigner, stageFor: () => stageOf(AbortSignal.abort()), fetch: (async () => { posts += 1; return jsonResponse(200, { isValid: true }); }) as typeof fetch });
    await expect(dead.settle(payload, requirements)).rejects.toThrow(DeadlineError);
    expect(signings).toBe(1);
    expect(posts).toBe(0);
  });

  test("送出の直前に段の時計を見る: signal が生きていても expired なら送らない。段は終わりに dispose される", async () => {
    let posts = 0;
    let disposed = 0;
    const controller = new AbortController();
    const client = new BoundedFacilitatorClient({
      url: "https://f.test/x402",
      stageFor: () => ({ signal: controller.signal, expired: () => true, dispose: () => { disposed += 1; } }),
      fetch: (async () => { posts += 1; return jsonResponse(200, { isValid: true }); }) as typeof fetch,
    });
    await expect(client.verify(payload, requirements)).rejects.toThrow(DeadlineError);
    expect(posts).toBe(0);
    expect(disposed).toBe(1);
    await expect(client.getSupported()).rejects.toThrow(DeadlineError);
    expect(posts).toBe(0);
    expect(disposed).toBe(2);
    // 署名の後に時計が過ぎた場合も送らない。
    let calls = 0;
    const lateClock = new BoundedFacilitatorClient({
      url: "https://f.test/x402",
      signer: { network: "eip155:5042002", chainId: 5042002, address: ARC_ADDRESS, signTypedData: async () => { calls += 1; return `0x${"11".repeat(65)}`; } },
      stageFor: () => ({ signal: controller.signal, expired: () => calls > 0, dispose: () => {} }),
      fetch: (async () => { posts += 1; return jsonResponse(200, { isValid: true }); }) as typeof fetch,
    });
    await expect(lateClock.verify(payload, requirements)).rejects.toThrow(DeadlineError);
    expect(calls).toBe(1);
    expect(posts).toBe(0);
  });

  test("fetch に段の signal を渡し、切れれば DeadlineError（facilitator_unavailable にしない）", async () => {
    const client = new BoundedFacilitatorClient({
      url: "https://f.test/x402",
      stageFor: () => stageOf(AbortSignal.timeout(50)),
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
    const client = new BoundedFacilitatorClient({ url: "https://f.test/x402", stageFor: () => stageOf(AbortSignal.timeout(1_000)), fetch: (async () => streamed()) as typeof fetch });
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

describe("accepted の直列化", () => {
  test("鍵は昇順、深さは上限まで（深い入れ子は TooDeepError。再帰で落ちない）", () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: "x" }] })).toBe('{"a":[{"c":"x","d":2}],"b":1}');
    let nested: unknown = "leaf";
    for (let i = 0; i < MAX_ACCEPTED_DEPTH + 1; i += 1) nested = { k: nested };
    expect(() => stableJson(nested)).toThrow(TooDeepError);
    let deep: unknown = "leaf";
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(() => stableJson(deep)).toThrow(TooDeepError);
    const ok = { scheme: "exact", extra: { feePayer: "x" } };
    expect(() => stableJson(ok)).not.toThrow();
  });
});
