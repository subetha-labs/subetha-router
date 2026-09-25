/**
 * T-11 wire: **R3 の応答バイトを 1 バイトも出す前に**プロセスを落とし、同じ journal で
 * 再起動して R4 が同一 status と同一結果を返すことを確かめる（設計 §11 / §5 の結果所有）。
 *
 * - 「受け取ってから落とす」でも「graceful shutdown」でもない。durable 化（fsync）済みだが
 *   クライアントには何も届いていない、という一点で止めてから SIGKILL する。
 * - バリアは `synthetic` セクションにのみ書ける合成専用シームで、既定（real）では読まれない。
 * - 相手は別プロセスの合成 fixture（`synthetic`・無課金・無署名・鍵なし）。
 */

import { readFile, rm, stat } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";

import {
  ALICE,
  ROUTE_A,
  callsOf,
  paymentHeader,
  principalHeaders,
  requestQuote,
  startHarness,
  type Harness,
} from "../fixtures/router-harness.js";

const started: Harness[] = [];

afterEach(async () => {
  for (const harness of started.splice(0)) {
    await harness.stopAll();
    await rm(harness.workDir, { recursive: true, force: true });
  }
});

/** バリアの合図ファイルが現れるまで待つ（現れなければ失敗させる）。 */
async function waitForBarrier(harness: Harness): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await stat(harness.barrierPath);
      return JSON.parse(await readFile(harness.barrierPath, "utf8")) as Record<string, unknown>;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(
          `crash barrier never reported: ${harness.barrierPath}\n${harness.router.stderr()}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

test("応答バイトを出す前に落ちても、再起動後の R4 が同じ結果を返し再送もしない", async () => {
  const harness = await startHarness({ crashBarrier: true });
  started.push(harness);
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  expect(quote.status).toBe(200);

  const headers = {
    ...principalHeaders(ALICE),
    "x-router-quote-id": quote.body.quoteId,
    "x-router-request-id": "req-1",
    "x-router-approval": quote.body.quoteId,
    "x-payment": paymentHeader(quote.body.source.offer),
  };

  // 応答を待たずに投げる。バリアに到達した時点で、まだ 1 バイトも返っていない。
  const abort = new AbortController();
  let responded = false;
  const inflight = fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers,
    signal: abort.signal,
  })
    .then((response) => {
      responded = true;
      return response.status;
    })
    .catch(() => -1);

  const barrier = await waitForBarrier(harness);
  expect(barrier["paymentId"]).toBe(quote.body.paymentId);
  expect(responded).toBe(false);

  // 両レグは実行済みで、結果は fsync 済み。ここで所有している子だけを SIGKILL する。
  expect(await callsOf(harness.facilitator)).toMatchObject({ settleCalls: 1 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
  await harness.killRouter();
  abort.abort();
  expect(await inflight).toBe(-1);
  expect(responded).toBe(false);

  // 同じ journal で再起動（バリア無し構成）。落ちた側がロックを握ったままなら起動できない。
  await harness.restartRouter();
  const status = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(ALICE),
  });
  expect(status.status).toBe(200);
  const projection = (await status.json()) as Record<string, unknown>;
  expect(projection["status"]).toBe("delivered");
  expect(projection["result"]).toMatchObject({ providerId: "synthetic-provider-a" });
  // 両レグの証跡も durable（クラッシュ前に fsync 済みの内容がそのまま読める）。
  expect(projection["source"]).toMatchObject({ txRef: "synthetic-src-1" });
  expect(projection["destination"]).toMatchObject({
    outcome: "paid",
    attempt: 1,
    txRef: "synthetic-dst-1",
    receiptRef: "synthetic-dst-1",
  });

  // クライアントが同一要求を出し直しても、どちらのレグも再送しない。
  const resubmitted = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers,
  });
  expect(resubmitted.status).toBe(200);
  expect(await resubmitted.json()).toEqual(projection["result"]);
  expect(await callsOf(harness.facilitator)).toMatchObject({ settleCalls: 1 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
  // 起動・バリア待ち・再起動を含むので既定の 5s より長く取る。
}, 40_000);

test("応答前バリアは synthetic 構成にしか無く、通常構成では作動しない", async () => {
  // 同じ harness でもバリアを指定しなければ、R3 はそのまま応答して合図ファイルも作らない。
  const harness = await startHarness();
  started.push(harness);
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });

  const response = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: {
      ...principalHeaders(ALICE),
      "x-router-quote-id": quote.body.quoteId,
      "x-router-request-id": "req-1",
      "x-router-approval": quote.body.quoteId,
      "x-payment": paymentHeader(quote.body.source.offer),
    },
  });
  expect(response.status).toBe(200);
  await expect(stat(harness.barrierPath)).rejects.toThrow();
});
