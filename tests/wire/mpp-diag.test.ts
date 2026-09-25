/**
 * MPP challenge の **wire 形**の回帰テスト（もとは一時診断だったものを回帰に変えた）。
 *
 * 押さえるのは 2 点:
 *  - server metadata（reserved `_mppx_scope`）は wire では `meta` ではなく `opaque` に畳まれて
 *    届き、`Challenge.meta()` は wire を通った challenge では `undefined` を返す。
 *  - したがって scope は対称の公式 decoder `PaymentRequest.deserialize` で読む必要がある。
 *    adapter がこの読取をやめると scope 束縛が消えるため、ここで固定する。
 *
 * 実 SDK（`mppx/client` の `Mppx.create` + `tempo.charge`）で 402 を受け、支払い側は非署名 spy。
 */

import { Challenge, PaymentRequest } from "mppx";
import { Mppx, tempo } from "mppx/client";
import { expect, test } from "vitest";

import { startListening } from "../fixtures/loopback.js";
import { createPayerSpy } from "../fixtures/mpp-payer-spy.js";

test("challenge の scope は opaque に畳まれて届く（meta は空）", async () => {
  const fixture = await startListening("tests/fixtures/mpp-upstream.ts", ["--port", "0"]);
  try {
    const capability = createPayerSpy().capability();
    const mppx = Mppx.create({
      methods: [tempo.charge({ account: capability.account, getClient: capability.getClient })],
      polyfill: false,
      maxPaymentRetries: 0,
    });
    const url = `${fixture.baseUrl}/v1/eth/snapshot`;
    const init: RequestInit = { method: "GET" };

    const response = await mppx.rawFetch(url, init);
    expect(response.status).toBe(402);
    // wire の challenge は `Payment` scheme の WWW-Authenticate で届く。
    const header = response.headers.get("WWW-Authenticate") ?? "";
    expect(header.startsWith("Payment ")).toBe(true);
    expect(header).toContain('opaque="');

    const prepared = await mppx.preparePayment(response, { request: init });
    const challenge = prepared.challenge as unknown as Record<string, unknown>;
    // 実 SDK が解析した challenge には meta が無く、opaque だけがある。
    expect(Challenge.meta(prepared.challenge)).toBeUndefined();
    expect(typeof challenge["opaque"]).toBe("string");

    const meta = PaymentRequest.deserialize(challenge["opaque"] as string) as Record<string, unknown>;
    expect(meta["_mppx_scope"]).toBe(`GET ${url}`);
    // 未知フィールドも request に保たれている（承認照合の入力になる）。
    expect((challenge["request"] as Record<string, unknown>)["providerNote"]).toBe("original");
  } finally {
    await fixture.stop();
  }
});
