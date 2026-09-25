/**
 * T-10 wire: 実 CLI に対する**並行 HTTP 要求**（設計 §11 / docs/tasks.md T1）。
 * 直列化そのものは受理済み core の単体テストで確認済みで、本ファイルはそれを
 * **実 TCP 越しの別プロセス要求として**覆う後追いカバレッジ（RED を伴わない）。
 * 相手は別プロセスの合成 fixture（`synthetic`・無課金・無署名・鍵なし）。
 */

import { rm } from "node:fs/promises";
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

async function boot(): Promise<Harness> {
  const harness = await startHarness();
  started.push(harness);
  return harness;
}

interface Delivered {
  readonly status: number;
  readonly body: unknown;
  readonly paymentId: string | null;
}

async function purchase(
  harness: Harness,
  quote: { quoteId: string; source: { offer: unknown } },
  requestId: string,
): Promise<Delivered> {
  const response = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: {
      ...principalHeaders(ALICE),
      "x-router-quote-id": quote.quoteId,
      "x-router-request-id": requestId,
      "x-router-approval": quote.quoteId,
      "x-payment": paymentHeader(quote.source.offer),
    },
  });
  return {
    status: response.status,
    body: await response.json(),
    paymentId: response.headers.get("x-router-payment-id"),
  };
}

test("同一 quote への並行 R3 は受信 settle も送信 pay も 1 回で、同じ結果を返す", async () => {
  const harness = await boot();
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  expect(quote.status).toBe(200);

  // 別プロセスのクライアントから、まったく同じ R3 を同時に 2 本投げる。
  const [first, second] = await Promise.all([
    purchase(harness, quote.body, "req-1"),
    purchase(harness, quote.body, "req-1"),
  ]);

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(second.body).toEqual(first.body);
  expect(second.paymentId).toBe(quote.body.paymentId);
  expect(first.paymentId).toBe(quote.body.paymentId);

  // 購入は 1 回だけ（両レグとも）。
  expect(await callsOf(harness.facilitator)).toMatchObject({ settleCalls: 1 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });

  const status = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(ALICE),
  });
  const projection = (await status.json()) as Record<string, unknown>;
  expect(projection["status"]).toBe("delivered");
  expect(projection["result"]).toEqual(first.body);
  expect((projection["destination"] as Record<string, unknown>)["attempt"]).toBe(1);
});

test("別 quote の並行 R3 は独立した購入として両方とも完了する", async () => {
  const harness = await boot();
  const [firstQuote, secondQuote] = await Promise.all([
    requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" }),
    requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-2" }),
  ]);
  // `(principal, requestId)` が違えば別 quote・別 payment。
  expect(secondQuote.body.quoteId).not.toBe(firstQuote.body.quoteId);
  expect(secondQuote.body.paymentId).not.toBe(firstQuote.body.paymentId);

  const [first, second] = await Promise.all([
    purchase(harness, firstQuote.body, "req-1"),
    purchase(harness, secondQuote.body, "req-2"),
  ]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.paymentId).toBe(firstQuote.body.paymentId);
  expect(second.paymentId).toBe(secondQuote.body.paymentId);

  // 共有予算の下で 2 件とも成立し、レグはそれぞれ 1 回ずつ。
  expect(await callsOf(harness.facilitator)).toMatchObject({ settleCalls: 2 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 2 });

  for (const quote of [firstQuote, secondQuote]) {
    const status = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
      headers: principalHeaders(ALICE),
    });
    const projection = (await status.json()) as Record<string, unknown>;
    expect(projection["status"]).toBe("delivered");
    expect((projection["destination"] as Record<string, unknown>)["attempt"]).toBe(1);
  }
});
