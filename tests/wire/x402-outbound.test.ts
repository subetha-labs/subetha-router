/**
 * 送信レール A（x402）の **実 SDK 配線**テスト（T2 / 設計 §4.2）。
 *
 * - 呼ぶのはインストール済みの公式 `@x402/fetch`（`x402Client` / `x402HTTPClient`）と
 *   `@x402/evm`（`ExactEvmScheme`）**そのもの**。wire は v2 の `PAYMENT-REQUIRED` /
 *   `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`。
 * - 相手は別プロセスの loopback fixture、署名側は**非署名 spy**（鍵なし・実決済なし）。
 *   fixture が返す `transaction` は `synthetic-` ラベルで実決済の証拠にならない。
 */

import { getAddress } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { createX402Outbound } from "../../src/adapters/outbound/x402.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer } from "../../src/ports/outbound.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { createForbiddenSignerSpy, createSignerSpy, type SignerSpy } from "../fixtures/x402-signer-spy.js";

const ROUTE_ID = "eth-snapshot";
const NETWORK = "eip155:84532";
const ASSET = "0x000000000000000000000000000000000000de57";
const PAY_TO = "0x0000000000000000000000000000000000000a11";

const running: Listening[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.stop();
  }
});

async function startUpstream(args: readonly string[] = []): Promise<Listening> {
  const fixture = await startListening("tests/fixtures/x402-upstream.ts", ["--port", "0", ...args]);
  running.push(fixture);
  return fixture;
}

function railOf(fixture: Listening, spy: SignerSpy, network = NETWORK) {
  return createX402Outbound({ transport: createGuardedTransport({ allowLoopback: true, report: () => {} }),
    upstreams: { [ROUTE_ID]: `${fixture.baseUrl}/v1/eth/snapshot` },
    capability: spy.capability(network),
  });
}

async function upstreamCalls(fixture: Listening): Promise<{
  challengeCalls: number;
  payCalls: number;
  seenQueries: string[];
  seenPayments: Record<string, unknown>[];
}> {
  const response = await fetch(`${fixture.baseUrl}/calls`);
  return (await response.json()) as never;
}

describe("x402 outbound over the installed official SDK", () => {
  it("v2 PAYMENT-REQUIRED を読み、未知の extra フィールドも落とさない", async () => {
    const fixture = await startUpstream();
    const offers = await railOf(fixture, createSignerSpy()).readChallenge(ROUTE_ID);

    expect(offers).toHaveLength(1);
    const offer = offers[0]!;
    expect(offer.scheme).toBe("exact");
    expect(offer.network).toBe(NETWORK);
    expect(offer.asset).toBe(ASSET);
    expect(offer.payTo).toBe(PAY_TO);
    expect(offer.amount).toBe("900");
    // 指紋と再照合の入力になる未知フィールドを保つ。
    expect(offer.extra).toMatchObject({ providerNote: "original", name: "synthetic-usd" });
    expect((offer as unknown as Record<string, unknown>)["maxTimeoutSeconds"]).toBe(120);
  });

  it("承認済み offer で実 SDK が payload を作り、PAYMENT-SIGNATURE を 1 回だけ送る", async () => {
    const fixture = await startUpstream();
    const spy = createSignerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p1", attempt: 1 });

    expect(result.outcome).toBe("paid");
    if (result.outcome !== "paid") {
      return;
    }
    // レシート整合（success / network / transaction）が取れて初めて paid。
    expect(result.txRef).toMatch(/^synthetic-dst-/);
    expect(result.receiptRef).toBeTypeOf("string");
    expect(result.body).toMatchObject({ data: { symbol: "ETH", price: "3000.12" } });

    // 実 SDK が署名境界に渡した引数が承認値と一致している（EIP-3009 exact）。
    expect(spy.calls).toHaveLength(1);
    const signed = spy.calls[0]!;
    expect(signed.primaryType).toBe("TransferWithAuthorization");
    expect(signed.domain["chainId"]).toBe(84_532);
    expect(signed.domain["verifyingContract"]).toBe(getAddress(ASSET));
    expect(signed.message["to"]).toBe(getAddress(PAY_TO));
    expect(signed.message["value"]).toBe(900n);
    expect(signed.message["from"]).toBe(spy.address);

    const calls = await upstreamCalls(fixture);
    // 1 要求につき支払い送信は 1 回だけ。クエリも付けない。
    expect(calls.payCalls).toBe(1);
    expect(calls.seenQueries).toEqual([]);
    // 上流が受け取ったのは v2 payload（`accepted` が承認済み offer と同値）。
    const seen = calls.seenPayments[0]!;
    expect(seen["x402Version"]).toBe(2);
    expect(seen["accepted"]).toMatchObject({ amount: "900", asset: ASSET, payTo: PAY_TO });
  });

  it.each([
    ["amount", "amount"],
    ["maxTimeoutSeconds", "maxTimeoutSeconds"],
    // 未知フィールドだけの変化も検知する（凍結 accepts をそのまま払わない）。
    ["extra-unknown", "extra-unknown"],
  ])("送金直前の challenge が %s で変わっていれば署名も送信もしない", async (_label, field) => {
    // 1 回目の challenge（quote）は元の内容、2 回目（送金直前）で変わる。
    const fixture = await startUpstream(["--change-after", "1", "--change-field", field]);
    const spy = createForbiddenSignerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p2", attempt: 1 });

    expect(result).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    expect(spy.calls).toHaveLength(0);
    expect((await upstreamCalls(fixture)).payCalls).toBe(0);
  });

  it("承認と外れた offer（金額差し替え）では署名側に到達しない", async () => {
    const fixture = await startUpstream();
    const spy = createForbiddenSignerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;
    const tampered: DestinationOffer = { ...offer, amount: "1" };

    const result = await rail.pay({ routeId: ROUTE_ID, offer: tampered, paymentId: "p3", attempt: 1 });

    expect(result).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    expect(spy.calls).toHaveLength(0);
    expect((await upstreamCalls(fixture)).payCalls).toBe(0);
  });

  it("署名能力の network が承認済み offer と違えば署名も送信もしない", async () => {
    const fixture = await startUpstream();
    const spy = createForbiddenSignerSpy();
    const rail = railOf(fixture, spy, "eip155:1");
    const offer = (await railOf(fixture, createSignerSpy()).readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p4", attempt: 1 });

    expect(result).toEqual({ outcome: "not_sent", reason: "destination_signer_network_mismatch" });
    expect(spy.calls).toHaveLength(0);
    expect((await upstreamCalls(fixture)).payCalls).toBe(0);
  });

  it("402 応答では rejected を返し、再署名・再送信をしない", async () => {
    const fixture = await startUpstream(["--pay", "reject"]);
    const spy = createSignerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p5", attempt: 1 });

    expect(result).toEqual({ outcome: "rejected", reason: "destination_rejected" });
    // 署名は 1 回だけ。402 を受けて自動で再支払いしない。
    expect(spy.calls).toHaveLength(1);
    expect((await upstreamCalls(fixture)).payCalls).toBe(1);
  });

  it("HTTP 200 でもレシートが無ければ paid と扱わない", async () => {
    const fixture = await startUpstream(["--pay", "no-receipt"]);
    const rail = railOf(fixture, createSignerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p6", attempt: 1 })).toEqual({
      outcome: "unknown",
      reason: "destination_receipt_unverified",
    });
  });

  it("レシートの network が承認済み offer と違えば paid と扱わない", async () => {
    const fixture = await startUpstream(["--settle-network", "eip155:1"]);
    const rail = railOf(fixture, createSignerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p7", attempt: 1 })).toEqual({
      outcome: "unknown",
      reason: "destination_receipt_unverified",
    });
  });

  it("success:false のレシートは paid と扱わない", async () => {
    const fixture = await startUpstream(["--pay", "settle-failed"]);
    const rail = railOf(fixture, createSignerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p8", attempt: 1 })).toEqual({
      outcome: "unknown",
      reason: "destination_receipt_unverified",
    });
  });

  it("レシートの payer が署名者と違えば paid と扱わない", async () => {
    const fixture = await startUpstream(["--payer", "other"]);
    const spy = createSignerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p13", attempt: 1 })).toEqual({
      outcome: "unknown",
      reason: "destination_receipt_payer_mismatch",
    });
    // 再送も再署名もしない。
    expect(spy.calls).toHaveLength(1);
    expect((await upstreamCalls(fixture)).payCalls).toBe(1);
  });

  it("レシートの payer がアドレスとして不正なら paid と扱わない", async () => {
    const fixture = await startUpstream(["--payer", "malformed"]);
    const rail = railOf(fixture, createSignerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p14", attempt: 1 });
    expect(result.outcome).toBe("unknown");
    expect((await upstreamCalls(fixture)).payCalls).toBe(1);
  });

  it("payer を返さないレシートは network/transaction の整合で受理する", async () => {
    const fixture = await startUpstream(["--payer", "absent"]);
    const rail = railOf(fixture, createSignerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect((await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p15", attempt: 1 })).outcome).toBe(
      "paid",
    );
  });

  it("200 + 正しいレシートでも本文が JSON でなければ delivered にしない", async () => {
    const fixture = await startUpstream(["--pay", "html"]);
    const rail = railOf(fixture, createSignerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p16", attempt: 1 });
    // 決済証跡は保持したまま「データ未取得」として終端する（再送しない）。
    expect(result.outcome).toBe("paid_no_data");
    if (result.outcome === "paid_no_data") {
      expect(result.receiptRef).toBeTypeOf("string");
    }
    expect((await upstreamCalls(fixture)).payCalls).toBe(1);
  });

  it("5xx は unknown（自動再送しない）", async () => {
    const fixture = await startUpstream(["--pay", "error"]);
    const spy = createSignerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p9", attempt: 1 })).toEqual({
      outcome: "unknown",
      reason: "destination_pay_unknown",
    });
    expect((await upstreamCalls(fixture)).payCalls).toBe(1);
  });

  it("接続断は unknown（送金有無不明のまま再送しない）", async () => {
    const fixture = await startUpstream(["--pay", "abort"]);
    const rail = railOf(fixture, createSignerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    expect(await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p10", attempt: 1 })).toEqual({
      outcome: "unknown",
      reason: "destination_pay_unknown",
    });
  });

  it("課金後データなし（502）はレシートがあるときだけ paid_no_data", async () => {
    const fixture = await startUpstream(["--pay", "paid-no-data"]);
    const rail = railOf(fixture, createSignerSpy());
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p11", attempt: 1 });
    expect(result.outcome).toBe("paid_no_data");
    if (result.outcome === "paid_no_data") {
      expect(result.reason).toBe("paid_data_unavailable");
      expect(result.receiptRef).toBeTypeOf("string");
    }
  });

  it("permit2 など T2 で未確認の assetTransferMethod は fail closed（送信しない）", async () => {
    const fixture = await startUpstream(["--atm", "permit2"]);
    const spy = createSignerSpy();
    const rail = railOf(fixture, spy);
    const offer = (await rail.readChallenge(ROUTE_ID))[0]!;

    const result = await rail.pay({ routeId: ROUTE_ID, offer, paymentId: "p12", attempt: 1 });
    expect(result.outcome).toBe("not_sent");
    expect((await upstreamCalls(fixture)).payCalls).toBe(0);
  });

  it("署名しない能力は loopback 以外の上流に向けられない", async () => {
    expect(() =>
      createX402Outbound({ transport: createGuardedTransport({ allowLoopback: true, report: () => {} }),
        upstreams: { [ROUTE_ID]: "https://example.com/v1/eth/snapshot" },
        capability: createSignerSpy().capability(NETWORK),
      }),
    ).toThrow();
  });
});
