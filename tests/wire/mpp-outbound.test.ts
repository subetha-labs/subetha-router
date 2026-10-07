/**
 * 送信レール B（MPP / Tempo charge）の **実 SDK 配線**テスト（T3 / 設計 §10 M6）。
 *
 * - 呼ぶのはインストール済みの公式 `mppx`（`mppx/client` の `Mppx.create` + `tempo.charge`、
 *   `mppx` の `Challenge` / `Credential` / `Receipt`）そのもの。高レベル自動支払いは使わない。
 * - 相手は別プロセスの loopback fixture。支払い側は**非署名 spy**（鍵なし・実 RPC なし・
 *   実 broadcast なし）で、receipt は `synthetic-` ラベル。実決済の証拠にはならない。
 */

import { afterEach, describe, expect, it } from "vitest";

import { createMppOutbound } from "../../src/adapters/outbound/mpp.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer } from "../../src/ports/outbound.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { createPayerSpy, SPY_PAYER_ADDRESS, TEMPO_TESTNET_CHAIN_ID } from "../fixtures/mpp-payer-spy.js";

const ROUTE_ID = "md-b-eth-snapshot";
const CURRENCY = "0x20c0000000000000000000000000000000000000";
const RECIPIENT = "0x00000000000000000000000000000000000000b1";

const running: Listening[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.stop();
  }
});

async function startUpstream(args: readonly string[] = []): Promise<Listening> {
  const fixture = await startListening("tests/fixtures/mpp-upstream.ts", ["--port", "0", ...args]);
  running.push(fixture);
  return fixture;
}

function railOf(fixture: Listening, spy: ReturnType<typeof createPayerSpy>) {
  return createMppOutbound({ transport: createGuardedTransport({ allowLoopback: true, report: () => {} }),
    upstreams: { [ROUTE_ID]: `${fixture.baseUrl}/v1/eth/snapshot` },
    capability: spy.capability(),
  });
}

async function upstreamCalls(fixture: Listening): Promise<{
  challengeCalls: number;
  payCalls: number;
  seenQueries: string[];
  seenCredentials: Record<string, unknown>[];
}> {
  const response = await fetch(`${fixture.baseUrl}/calls`);
  return (await response.json()) as never;
}

describe("mpp outbound over the installed official mppx client", () => {
  it("402 challenge を実 SDK に解析させ、支払い条件を offer に畳み込む", async () => {
    const fixture = await startUpstream();
    const offers = await railOf(fixture, createPayerSpy()).readChallenge(ROUTE_ID);

    expect(offers).toHaveLength(1);
    const offer = offers[0]!;
    expect(offer.scheme).toBe("tempo/charge");
    expect(offer.network).toBe(`eip155:${TEMPO_TESTNET_CHAIN_ID}`);
    expect(offer.asset).toBe(CURRENCY);
    // wire の atomic amount をそのまま使う（human 価格を二重変換しない）。
    expect(offer.amount).toBe("1200");
    expect(offer.payTo).toBe(RECIPIENT);
    expect(offer.extra?.["scope"]).toBe(`GET ${fixture.baseUrl}/v1/eth/snapshot`);
    // 未知フィールドも条件全文に入る。
    expect(offer.extra?.["terms"]).toContain("providerNote");
  });

  it("発行ごとに id/expires が変わっても同一条件の再読取は同じ offer になる", async () => {
    const fixture = await startUpstream();
    const rail = railOf(fixture, createPayerSpy());
    const first = await rail.readChallenge(ROUTE_ID);
    const second = await rail.readChallenge(ROUTE_ID);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("承認済み offer で credential を 1 回作り、1 回だけ送って receipt を解釈する", async () => {
    const fixture = await startUpstream();
    const spy = createPayerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b1", attempt: 1, deadlineMs: Date.now() + 600_000 });

    expect(result.outcome).toBe("paid");
    if (result.outcome !== "paid") {
      return;
    }
    // receipt は**今回の送金**（credential の取引ハッシュ）に束縛されている。
    // ハッシュ自体は spy が返した合成値で、実 broadcast の結果ではない。
    expect(result.txRef).toBe(spy.txHash);
    expect(result.receiptRef).toBeTypeOf("string");
    // 送金系 RPC は 1 回だけ。
    expect(spy.sendAttempts()).toBe(1);
    expect(result.body).toMatchObject({
      providerId: "synthetic-provider-b",
      data: { symbol: "ETH" },
    });

    const calls = await upstreamCalls(fixture);
    expect(calls.payCalls).toBe(1);
    expect(calls.seenQueries).toEqual([]);
    // 上流が受けたのは公式 SDK が作った credential（challenge が対応している）。
    const credential = calls.seenCredentials[0]!;
    expect((credential["challenge"] as Record<string, unknown>)["method"]).toBe("tempo");
    // 実 SDK は payer を CAIP-10 の DID として載せる（チェーンとアドレスが対応している）。
    expect(String(credential["source"]).toLowerCase()).toBe(
      `did:pkh:eip155:${TEMPO_TESTNET_CHAIN_ID}:${SPY_PAYER_ADDRESS.toLowerCase()}`,
    );
  });

  it.each([
    ["amount", "amount"],
    ["recipient", "recipient"],
    ["unknown", "unknown"],
  ])("送金直前に challenge の %s が変わっていれば credential を作らない", async (_label, field) => {
    const fixture = await startUpstream(["--change-after", "1", "--change-field", field]);
    const spy = createPayerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b2", attempt: 1, deadlineMs: Date.now() + 600_000 });

    expect(result.outcome).toBe("not_sent");
    expect(spy.rpcCalls).toHaveLength(0);
    expect((await upstreamCalls(fixture)).payCalls).toBe(0);
  });

  it("承認と外れた offer（金額差し替え）では支払い能力に到達しない", async () => {
    const fixture = await startUpstream();
    const spy = createPayerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;
    const tampered: DestinationOffer = { ...offer, amount: "1" };

    const result = await rail.pay({ routeId: ROUTE_ID, offer: tampered, paymentId: "b3", attempt: 1, deadlineMs: Date.now() + 600_000 });

    expect(result).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    expect(spy.rpcCalls).toHaveLength(0);
    expect((await upstreamCalls(fixture)).payCalls).toBe(0);
  });

  it("支払いチェーンが能力と違えば credential も送信もしない", async () => {
    const fixture = await startUpstream();
    const spy = createPayerSpy({ chainId: 4217 });
    const rail = createMppOutbound({ transport: createGuardedTransport({ allowLoopback: true, report: () => {} }),
      upstreams: { [ROUTE_ID]: `${fixture.baseUrl}/v1/eth/snapshot` },
      capability: spy.capability(),
    });
    const offer = (await railOf(fixture, createPayerSpy()).readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b4", attempt: 1, deadlineMs: Date.now() + 600_000 })).toEqual({
      outcome: "not_sent",
      reason: "destination_signer_network_mismatch",
    });
    expect((await upstreamCalls(fixture)).payCalls).toBe(0);
  });

  it("支払い能力に触れた後の失敗は unknown を保持する（not_sent と断定しない）", async () => {
    const fixture = await startUpstream();
    const spy = createPayerSpy({ refuse: true });
    const rail = railOf(fixture, spy);
    const offer = (await railOf(fixture, createPayerSpy()).readChallenge(ROUTE_ID))[0]!;

    // push mode では credential 生成の途中で broadcast され得るため、払っていないと断定しない。
    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b5", attempt: 1, deadlineMs: Date.now() + 600_000 })).toEqual({
      outcome: "unknown",
      reason: "destination_pay_unknown",
    });
    // 上流へ credential は送っていない（自動再試行もしない）。
    expect((await upstreamCalls(fixture)).payCalls).toBe(0);
    expect(spy.rpcCalls.length).toBeGreaterThan(0);
  });

  it("課金後データなし（502）は receipt があるときだけ paid_no_data", async () => {
    const fixture = await startUpstream(["--pay", "paid-no-data"]);
    const rail = railOf(fixture, createPayerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b6", attempt: 1, deadlineMs: Date.now() + 600_000 });
    expect(result.outcome).toBe("paid_no_data");
    if (result.outcome === "paid_no_data") {
      expect(result.reason).toBe("paid_data_unavailable");
      expect(result.receiptRef).toBeTypeOf("string");
    }
    expect((await upstreamCalls(fixture)).payCalls).toBe(1);
  });

  it("別取引を指す receipt は paid と扱わない（今回の送金に束縛されない）", async () => {
    const fixture = await startUpstream(["--reference", "wrong"]);
    const rail = railOf(fixture, createPayerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b15", attempt: 1, deadlineMs: Date.now() + 600_000 })).toEqual({
      outcome: "unknown",
      reason: "destination_receipt_unverified",
    });
  });

  it("502 でも別取引を指す receipt なら paid_no_data と扱わない", async () => {
    const fixture = await startUpstream(["--pay", "paid-no-data", "--reference", "wrong"]);
    const rail = railOf(fixture, createPayerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b16", attempt: 1, deadlineMs: Date.now() + 600_000 })).toEqual({
      outcome: "unknown",
      reason: "destination_pay_unknown",
    });
  });

  it("曖昧な送金失敗のあと、内部 fallback による 2 度目の送金要求をしない", async () => {
    const fixture = await startUpstream();
    const spy = createPayerSpy({ ambiguousSend: true });
    const rail = railOf(fixture, spy);
    const offer = (await railOf(fixture, createPayerSpy()).readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b17", attempt: 1, deadlineMs: Date.now() + 600_000 });

    // 成否不明のまま保持し、追加送金も credential 送信もしない。
    expect(result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(spy.sendAttempts()).toBe(1);
    expect((await upstreamCalls(fixture)).payCalls).toBe(0);
  });

  it("decorated client（walletClient 形）でも送金 guard を迂回できない", async () => {
    const fixture = await startUpstream();
    const spy = createPayerSpy({ decorated: true });
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    // 実 SDK の action がそのまま走り、送金は 1 回だけ guard を通る。
    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b18", attempt: 1, deadlineMs: Date.now() + 600_000 });
    expect(result.outcome).toBe("paid");
    expect(spy.sendAttempts()).toBe(1);
  });

  it("decorated client + 曖昧な送金失敗でも 2 度目の送金要求をしない", async () => {
    const fixture = await startUpstream();
    const spy = createPayerSpy({ decorated: true, ambiguousSend: true });
    const rail = railOf(fixture, spy);
    const offer = (await railOf(fixture, createPayerSpy()).readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b19", attempt: 1, deadlineMs: Date.now() + 600_000 })).toEqual({
      outcome: "unknown",
      reason: "destination_pay_unknown",
    });
    expect(spy.sendAttempts()).toBe(1);
    expect((await upstreamCalls(fixture)).payCalls).toBe(0);
  });

  it("pull mode は credential 生成前に fail closed（課金してから未対応に気づかない）", async () => {
    const fixture = await startUpstream();
    const spy = createPayerSpy();
    const rail = createMppOutbound({ transport: createGuardedTransport({ allowLoopback: true, report: () => {} }),
      upstreams: { [ROUTE_ID]: `${fixture.baseUrl}/v1/eth/snapshot` },
      capability: spy.capability({ mode: "pull" }),
    });
    const offer = (await railOf(fixture, createPayerSpy()).readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b20", attempt: 1, deadlineMs: Date.now() + 600_000 })).toEqual({
      outcome: "not_sent",
      reason: "destination_unsupported_mode",
    });
    expect(spy.sendAttempts()).toBe(0);
    expect((await upstreamCalls(fixture)).payCalls).toBe(0);
  });

  it("receipt が無い 200 は paid と扱わない", async () => {
    const fixture = await startUpstream(["--pay", "no-receipt"]);
    const rail = railOf(fixture, createPayerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b7", attempt: 1, deadlineMs: Date.now() + 600_000 })).toEqual({
      outcome: "unknown",
      reason: "destination_receipt_unverified",
    });
  });

  it("別 method を名乗る receipt は paid と扱わない", async () => {
    const fixture = await startUpstream(["--receipt-method", "stripe"]);
    const rail = railOf(fixture, createPayerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b8", attempt: 1, deadlineMs: Date.now() + 600_000 })).toEqual({
      outcome: "unknown",
      reason: "destination_receipt_unverified",
    });
  });

  it("別 payer を名乗る receipt は paid と扱わない", async () => {
    const fixture = await startUpstream([
      "--payer",
      "did:pkh:eip155:42431:0x0000000000000000000000000000000000000777",
    ]);
    const rail = railOf(fixture, createPayerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b9", attempt: 1, deadlineMs: Date.now() + 600_000 })).toEqual({
      outcome: "unknown",
      reason: "destination_receipt_unverified",
    });
  });

  it("200 + 正しい receipt でも本文が JSON でなければ delivered にしない", async () => {
    const fixture = await startUpstream(["--pay", "html"]);
    const rail = railOf(fixture, createPayerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b10", attempt: 1, deadlineMs: Date.now() + 600_000 });
    expect(result.outcome).toBe("paid_no_data");
  });

  it("送信後の 402 は push mode では unknown（払っていないと断定しない・再送もしない）", async () => {
    const fixture = await startUpstream(["--pay", "reject"]);
    const rail = railOf(fixture, createPayerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "b11", attempt: 1, deadlineMs: Date.now() + 600_000 })).toEqual({
      outcome: "unknown",
      reason: "destination_pay_unknown",
    });
    expect((await upstreamCalls(fixture)).payCalls).toBe(1);
  });

  // pull mode（server 側 broadcast）は本 slice の spy RPC では未検証。実行できていないものを
  // 成功扱いしないため、テストも主張も置かない（T3 の残ゲート）。

  it("5xx と接続断は unknown（自動再送しない）", async () => {
    const errorFixture = await startUpstream(["--pay", "error"]);
    const errorRail = railOf(errorFixture, createPayerSpy());
    const errorOffer = (await errorRail.readChallenge(ROUTE_ID))[0]!;
    expect(
      await errorRail.pay({ routeId: ROUTE_ID, offer: errorOffer, paymentId: "b12", attempt: 1, deadlineMs: Date.now() + 600_000 }),
    ).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });

    const abortFixture = await startUpstream(["--pay", "abort"]);
    const abortRail = railOf(abortFixture, createPayerSpy());
    const abortOffer = (await abortRail.readChallenge(ROUTE_ID))[0]!;
    expect(
      await abortRail.pay({ routeId: ROUTE_ID, offer: abortOffer, paymentId: "b13", attempt: 1, deadlineMs: Date.now() + 600_000 }),
    ).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
  });
});
