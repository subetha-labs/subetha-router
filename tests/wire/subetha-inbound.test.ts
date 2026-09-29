/**
 * 受信レール（SubEtha）adapter の **実 HTTP** 配線テスト（T2 / 設計 §4.1）。
 * 相手は別プロセスで動くリポジトリ内の合成 facilitator fixture（loopback・無課金・無署名）。
 * 鍵・実資産・実決済は一切使わず、`transaction` は `synthetic-` ラベル付きの無課金値。
 */

import { afterEach, describe, expect, it } from "vitest";

import { createSubethaInbound, SUBETHA_SCHEME } from "../../src/adapters/inbound/subetha.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import { startListening, type Listening } from "../fixtures/loopback.js";

const CHAIN_ID = 11_155_111;
const NETWORK = `eip155:${CHAIN_ID}`;
const TOKEN = "0x0000000000000000000000000000000000005ce7";
const PAY_TO = "0x0000000000000000000000000000000000000a0e";
const ROUTE_BINDING = "eth-snapshot|GET|%2Fv1%2Froutes%2Feth-snapshot%2Fresource";

const running: Listening[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.stop();
  }
});

async function startFacilitator(args: readonly string[] = []): Promise<Listening> {
  const fixture = await startListening("tests/fixtures/facilitator-server.ts", [
    "--port",
    "0",
    "--token",
    TOKEN,
    "--pay-to",
    PAY_TO,
    "--chain-id",
    `${CHAIN_ID}`,
    ...args,
  ]);
  running.push(fixture);
  return fixture;
}

function inboundOf(fixture: Listening) {
  return createSubethaInbound({ facilitatorUrl: fixture.baseUrl });
}

async function issueOffer(fixture: Listening): Promise<InboundOffer> {
  return inboundOf(fixture).createOffer({
    routeId: "eth-snapshot",
    amount: "1000",
    asset: TOKEN,
    network: NETWORK,
    routeBinding: ROUTE_BINDING,
    nowMs: Date.now(),
  });
}

/** 発行 offer と完全一致する（＝ preflight を通る）支払い資格情報。 */
function credentialFor(offer: InboundOffer): PaymentCredential {
  return {
    x402Version: 2,
    accepted: structuredClone(offer),
    payload: { challengeNonce: offer.extra.challengeNonce },
  };
}

async function callCounts(fixture: Listening): Promise<{ verifyCalls: number; settleCalls: number }> {
  const response = await fetch(`${fixture.baseUrl}/calls`);
  return (await response.json()) as { verifyCalls: number; settleCalls: number };
}

describe("subetha inbound over real local HTTP", () => {
  it("発行 offer は challenge の実値と route 束縛を持つ", async () => {
    const fixture = await startFacilitator();
    const offer = await issueOffer(fixture);

    expect(offer.scheme).toBe(SUBETHA_SCHEME);
    expect(offer.network).toBe(NETWORK);
    expect(offer.asset).toBe(TOKEN);
    expect(offer.payTo).toBe(PAY_TO);
    expect(offer.amount).toBe("1000");
    expect(offer.extra.routeBinding).toBe(ROUTE_BINDING);
    expect(offer.extra.challengeNonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("helper/deadline が両方揃っていれば offer に載せる", async () => {
    const fixture = await startFacilitator(["--challenge", "both"]);
    const offer = await issueOffer(fixture);

    expect(typeof offer.extra["helper"]).toBe("string");
    expect(typeof offer.extra["deadline"]).toBe("number");
  });

  it.each([
    ["helper-only", "helper-only"],
    ["deadline-only", "deadline-only"],
    // 片側欠落だけでなく**型違反**でも offer を発行しない（設計 §4.1）。
    ["helper-bad-type", "helper-bad-type"],
    ["deadline-bad-type", "deadline-bad-type"],
    ["fee-bad-type", "fee-bad-type"],
  ])("%s の challenge では offer を発行しない", async (_label, mode) => {
    const fixture = await startFacilitator(["--challenge", mode]);
    await expect(issueOffer(fixture)).rejects.toThrow();
  });

  // core が「isValid!==true で settle へ進まない」ことは既存の lifecycle / http-contract で確認済み。
  // ここで見るのは adapter 自身が verify だけを呼び、settle を呼ばないこと。
  it("verify は isValid:false を返し、adapter 自身は settle を呼ばない", async () => {
    const fixture = await startFacilitator(["--verify", "invalid"]);
    const inbound = inboundOf(fixture);
    const offer = await issueOffer(fixture);
    const credential = credentialFor(offer);

    const verified = await inbound.verify(offer, credential);
    expect(verified.isValid).toBe(false);

    const counts = await callCounts(fixture);
    expect(counts.verifyCalls).toBe(1);
    // verify 呼び出しが settle を副作用として起こさないことを、実 fixture の呼び出し数で見る。
    expect(counts.settleCalls).toBe(0);
  });

  it("verify 成功 → settle 成功で 1 回だけ settle し、実 transaction を返す", async () => {
    const fixture = await startFacilitator();
    const inbound = inboundOf(fixture);
    const offer = await issueOffer(fixture);
    const credential = credentialFor(offer);

    expect(inbound.preflight(offer, credential, Date.now())).toEqual({ ok: true });
    expect(await inbound.verify(offer, credential)).toEqual({ isValid: true });

    const settled = await inbound.settle(offer, credential);
    expect(settled).toEqual({ outcome: "settled", txRef: expect.stringMatching(/^synthetic-src-/) });

    const counts = await callCounts(fixture);
    expect(counts.settleCalls).toBe(1);
  });

  it("settle の 5xx は unknown（自動再 settle をしない）", async () => {
    const fixture = await startFacilitator(["--settle", "error"]);
    const inbound = inboundOf(fixture);
    const offer = await issueOffer(fixture);

    expect(await inbound.settle(offer, credentialFor(offer))).toEqual({
      outcome: "unknown",
      reason: "source_settle_unknown",
    });
    expect((await callCounts(fixture)).settleCalls).toBe(1);
  });

  it("settle の 4xx は rejected", async () => {
    const fixture = await startFacilitator(["--settle", "rejected"]);
    const inbound = inboundOf(fixture);
    const offer = await issueOffer(fixture);

    expect(await inbound.settle(offer, credentialFor(offer))).toEqual({
      outcome: "rejected",
      reason: "source_rejected",
    });
  });

  it("settle の extra.phase=pending は unknown", async () => {
    const fixture = await startFacilitator(["--settle", "pending"]);
    const inbound = inboundOf(fixture);
    const offer = await issueOffer(fixture);

    expect(await inbound.settle(offer, credentialFor(offer))).toEqual({
      outcome: "unknown",
      reason: "source_settle_unknown",
    });
  });

  /**
   * 実 facilitator は burn 未確定を HTTP 200 + `success:false` + `errorReason:"pending_burn"` で
   * 返し、**`extra.phase` を付けない**（`apps/facilitator/src/server.ts:121`）。
   * これを `rejected` に丸めると、未確定の支払いが `awaiting_payment` として確定してしまう。
   */
  it("settle の success:false + errorReason:pending_burn は unknown（rejected にしない）", async () => {
    const fixture = await startFacilitator(["--settle", "pending-burn"]);
    const inbound = inboundOf(fixture);
    const offer = await issueOffer(fixture);

    expect(await inbound.settle(offer, credentialFor(offer))).toEqual({
      outcome: "unknown",
      reason: "source_settle_unknown",
    });
    // 自動再 settle をしない（未確定を確定させようとして叩き直さない）。
    expect((await callCounts(fixture)).settleCalls).toBe(1);
  });

  /** rate limit は「支払いが失敗した」ではない。受領済みの settle でも返り得る。 */
  it("settle の 429 は unknown（rejected にしない）", async () => {
    const fixture = await startFacilitator(["--settle", "rate-limited"]);
    const inbound = inboundOf(fixture);
    const offer = await issueOffer(fixture);

    expect(await inbound.settle(offer, credentialFor(offer))).toEqual({
      outcome: "unknown",
      reason: "source_settle_unknown",
    });
    expect((await callCounts(fixture)).settleCalls).toBe(1);
  });

  /**
   * `state=accepted` は**支払いが成立している**ことを意味する
   * （`packages/zerc20-backend/src/index.ts:1311-1313`、成功時に `1838` で `accepted` になる）。
   * `rejected` に落とすと**課金済みの購入が `awaiting_payment` として再提示される**。
   */
  it("受領済み challenge（state=accepted）への再 settle は unknown（rejected にしない）", async () => {
    const fixture = await startFacilitator(["--settle", "accepted-replay"]);
    const inbound = inboundOf(fixture);
    const offer = await issueOffer(fixture);

    expect(await inbound.settle(offer, credentialFor(offer))).toEqual({
      outcome: "unknown",
      reason: "source_settle_unknown",
    });
  });

  /**
   * **対照**: 200 + `success:false` でも、理由が確定的なら `rejected` のままでなければならない。
   * これが無いと「200 の `success:false` を一律 `unknown` にする」実装が通ってしまう。
   */
  it("settle の 200 + success:false + 確定的な理由は rejected のまま", async () => {
    const fixture = await startFacilitator(["--settle", "rejected-200"]);
    const inbound = inboundOf(fixture);
    const offer = await issueOffer(fixture);

    expect(await inbound.settle(offer, credentialFor(offer))).toEqual({
      outcome: "rejected",
      reason: "source_rejected",
    });
  });

  it("settle 応答の network が発行 offer と違えば settled と扱わない", async () => {
    const fixture = await startFacilitator(["--settle-network", "eip155:1"]);
    const inbound = inboundOf(fixture);
    const offer = await issueOffer(fixture);

    expect(await inbound.settle(offer, credentialFor(offer))).toEqual({
      outcome: "unknown",
      reason: "source_settle_unknown",
    });
  });

  it("接続断（fixture 停止）は例外になり、settled を作らない", async () => {
    const fixture = await startFacilitator();
    const inbound = inboundOf(fixture);
    const offer = await issueOffer(fixture);
    await fixture.stop();

    await expect(inbound.settle(offer, credentialFor(offer))).rejects.toThrow();
  });
});
