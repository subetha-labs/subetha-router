/**
 * T1b wire: 実 CLI（`src/main.ts`）を別プロセスで起動し、別プロセスのテストクライアントから
 * 実 TCP で R1→R2→R3→R4 を通す。両レグの相手は別プロセスの合成 fixture
 * （`synthetic`・無課金・無署名・鍵なし）で、実決済の証拠にはならない。
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { runToExit } from "../fixtures/loopback.js";
import {
  ALICE,
  BOB,
  CANONICAL_BASE_URL,
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

async function boot(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const harness = await startHarness(options);
  started.push(harness);
  return harness;
}

function resourceHeaders(
  principal: { id: string; token: string },
  quote: { quoteId: string },
  requestId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...principalHeaders(principal),
    "x-router-quote-id": quote.quoteId,
    "x-router-request-id": requestId,
    "x-router-approval": quote.quoteId,
    ...extra,
  };
}

test("実 CLI 越しに R1→R2→R3→R4 が通り、結果は再起動後も同じ", async () => {
  const harness = await boot();

  const routes = await fetch(`${harness.router.baseUrl}/v1/routes`, {
    headers: principalHeaders(ALICE),
  });
  expect(routes.status).toBe(200);
  const routesBody = (await routes.json()) as { routes: { routeId: string; resource: { url: string } }[] };
  const listed = routesBody.routes.find((route) => route.routeId === ROUTE_A);
  expect(listed?.resource.url).toBe(`${CANONICAL_BASE_URL}/v1/routes/${ROUTE_A}/resource`);
  // 上流 URL も principal トークンも公開しない。
  const routesText = JSON.stringify(routesBody);
  expect(routesText).not.toContain(harness.upstreamA.baseUrl);
  expect(routesText).not.toContain(ALICE.token);

  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  expect(quote.status).toBe(200);
  expect(quote.body.approval.boundTo).toBe(quote.body.quoteId);
  expect(JSON.stringify(quote.body)).not.toContain(harness.upstreamA.baseUrl);

  const delivered = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: resourceHeaders(ALICE, quote.body, "req-1", {
      "x-payment": paymentHeader(quote.body.source.offer),
    }),
  });
  expect(delivered.status).toBe(200);
  const upstreamBody = (await delivered.json()) as { providerId: string; data: { price: string } };
  // R3 は上流 JSON をそのまま返す（支払いメタは R4 側）。
  expect(upstreamBody.providerId).toBe("synthetic-provider-a");
  expect(upstreamBody.data.price).toBe("3000.12");
  expect(Object.keys(upstreamBody)).not.toContain("paymentId");

  // 上流 canonical はクエリ無しの GET のみ。
  const upstreamCalls = await callsOf(harness.upstreamA);
  expect(upstreamCalls["seenQueries"]).toEqual([]);
  expect(upstreamCalls["payCalls"]).toBe(1);

  const status = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(ALICE),
  });
  expect(status.status).toBe(200);
  const projection = (await status.json()) as Record<string, unknown>;
  expect(projection["status"]).toBe("delivered");
  expect(projection["result"]).toEqual(upstreamBody);
  expect((projection["destination"] as Record<string, unknown>)["outcome"]).toBe("paid");

  // 公開射影に秘密・上流 URL・生 journal を出さない。
  const projectionText = JSON.stringify(projection);
  expect(projectionText).not.toContain(harness.upstreamA.baseUrl);
  expect(projectionText).not.toContain(harness.facilitator.baseUrl);
  expect(projectionText).not.toContain(ALICE.token);
  expect(projectionText).not.toContain("seq");

  // 再起動しても同じ status と同じ結果が読める。
  await harness.restartRouter();
  const reopened = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(ALICE),
  });
  expect(reopened.status).toBe(200);
  expect(await reopened.json()).toEqual(projection);

  // 他 principal は参照できない。
  const byOther = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(BOB),
  });
  expect(byOther.status).toBe(404);
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
});

test("上流が課金応答不明なら unknown が durable で、再起動後も再送しない", async () => {
  const harness = await boot({ pay: "error" });
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  expect(quote.status).toBe(200);

  const response = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: resourceHeaders(ALICE, quote.body, "req-1", {
      "x-payment": paymentHeader(quote.body.source.offer),
    }),
  });
  expect(response.status).toBe(500);
  const failure = (await response.json()) as Record<string, unknown>;
  expect(failure["status"]).toBe("unknown");
  expect(failure["paymentId"]).toBe(quote.body.paymentId);

  await harness.restartRouter();
  const status = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(ALICE),
  });
  const projection = (await status.json()) as Record<string, unknown>;
  expect(projection["status"]).toBe("unknown");
  expect(projection["result"]).toBeUndefined();

  // 自動再送も自動再購入もしない。
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
  const journal = await readFile(harness.journalPath, "utf8");
  expect(journal.split("\n").filter((line) => line.includes('"destination_pending"')).length).toBe(1);
});

test("課金成立後にデータが無い上流は paid_data_unavailable で終端し、再購入しない", async () => {
  const harness = await boot({ pay: "paid-no-data" });
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });

  const response = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: resourceHeaders(ALICE, quote.body, "req-1", {
      "x-payment": paymentHeader(quote.body.source.offer),
    }),
  });
  expect(response.status).toBe(502);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body["status"]).toBe("paid_data_unavailable");

  const status = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(ALICE),
  });
  const projection = (await status.json()) as Record<string, unknown>;
  expect(projection["status"]).toBe("paid_data_unavailable");
  expect(projection["result"]).toBeUndefined();
  const destination = projection["destination"] as Record<string, unknown>;
  // 上流が実際にレシートを返したときだけ receiptRef を持つ。
  expect(destination["outcome"]).toBe("paid");
  expect(destination["receiptRef"]).toBe("synthetic-dst-1");
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
});

test("受信 verify が成立しなければ settle も送信レグも始めない", async () => {
  const harness = await boot({ verify: "invalid" });
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });

  const response = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: resourceHeaders(ALICE, quote.body, "req-1", {
      "x-payment": paymentHeader(quote.body.source.offer),
    }),
  });
  expect(response.status).toBe(402);
  expect(((await response.json()) as Record<string, unknown>)["error"]).toBe("verify_failed");

  // verify → settle の順序を飛ばさない。送信レグも始めない（source-before-destination）。
  expect(await callsOf(harness.facilitator)).toMatchObject({ verifyCalls: 1, settleCalls: 0 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });

  const status = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(ALICE),
  });
  const projection = (await status.json()) as Record<string, unknown>;
  // 課金が起きていないので受信未成立のまま。送信レグは**未着手**（`not_sent` ではない）。
  expect(projection["status"]).toBe("awaiting_payment");
  expect((projection["destination"] as Record<string, unknown>)["outcome"]).toBe("none");
  expect((projection["source"] as Record<string, unknown>)["txRef"]).toBeUndefined();
  expect(projection["terminalReason"]).toBe("verify_failed");
});

test("受信 settle が pending なら unknown を保持し、再起動後の同一要求でも再 settle しない", async () => {
  const harness = await boot({ settle: "pending" });
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  const headers = resourceHeaders(ALICE, quote.body, "req-1", {
    "x-payment": paymentHeader(quote.body.source.offer),
  });

  const first = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, { headers });
  expect(first.status).toBe(500);
  expect(((await first.json()) as Record<string, unknown>)["status"]).toBe("unknown");
  // 送金有無が不明なので送信レグへは進まない。
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });

  await harness.restartRouter();
  // 明示的に同一要求を再送しても、再 settle も再購入もしない。
  const repeated = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers,
  });
  expect(repeated.status).toBe(500);
  expect(((await repeated.json()) as Record<string, unknown>)["status"]).toBe("unknown");
  expect(await callsOf(harness.facilitator)).toMatchObject({ settleCalls: 1 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
});

test("再起動後に同一要求を送り直しても再購入せず、durable な結果をそのまま返す", async () => {
  const harness = await boot();
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  const headers = resourceHeaders(ALICE, quote.body, "req-1", {
    "x-payment": paymentHeader(quote.body.source.offer),
  });

  const delivered = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers,
  });
  expect(delivered.status).toBe(200);
  const body = await delivered.json();

  await harness.restartRouter();
  const repeated = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers,
  });
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual(body);
  // 両レグとも再送しない。
  expect(await callsOf(harness.facilitator)).toMatchObject({ settleCalls: 1 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
});

test("受信成立後に上流の提示が変われば支払わず paid_data_unavailable で終端する", async () => {
  // challenge 2 回（R2・settle 直前）までは同じ提示、送金直前の読み直しで変わる。
  const harness = await boot({ changeAfter: "2" });
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });

  const response = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: resourceHeaders(ALICE, quote.body, "req-1", {
      "x-payment": paymentHeader(quote.body.source.offer),
    }),
  });
  expect(response.status).toBe(502);
  const failure = (await response.json()) as Record<string, unknown>;
  expect(failure["terminalReason"]).toBe("quote_changed");

  // 署名も送信もしない。受信は成立済みなので `awaiting_payment` には戻さない。
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
  const status = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(ALICE),
  });
  const projection = (await status.json()) as Record<string, unknown>;
  expect(projection["status"]).toBe("paid_data_unavailable");
  const destination = projection["destination"] as Record<string, unknown>;
  expect(destination["outcome"]).toBe("not_sent");
  // 上流が課金していない以上、レシートを持たない（偽の課金主張を作らない）。
  expect(destination["receiptRef"]).toBeUndefined();
  expect((projection["source"] as Record<string, unknown>)["txRef"]).toBe("synthetic-src-1");
});

test("金額以外のトップレベルフィールドが settle 前に変われば、どちらのレグも始めない", async () => {
  // R2 の 1 回目だけ元の提示。受信 settle 直前の読み直しで `maxTimeoutSeconds` が変わる。
  const harness = await boot({ changeAfter: "1", changeField: "maxTimeoutSeconds" });
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });

  const response = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: resourceHeaders(ALICE, quote.body, "req-1", {
      "x-payment": paymentHeader(quote.body.source.offer),
    }),
  });
  expect(response.status).toBe(409);
  expect(((await response.json()) as Record<string, unknown>)["error"]).toBe("offer_changed");

  // 課金は一切起きていない（受信 settle も送信も呼ばない）。
  expect(await callsOf(harness.facilitator)).toMatchObject({ settleCalls: 0 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });

  const status = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(ALICE),
  });
  const projection = (await status.json()) as Record<string, unknown>;
  expect(projection["status"]).toBe("awaiting_payment");
  expect(projection["terminalReason"]).toBe("offer_changed");
});

test("金額以外のトップレベルフィールドが settle 後に変われば支払わず not_sent で終端する", async () => {
  // 受信 settle 直前までは同じ提示。送金直前の読み直しで `maxTimeoutSeconds` が変わる。
  const harness = await boot({ changeAfter: "2", changeField: "maxTimeoutSeconds" });
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });

  const response = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: resourceHeaders(ALICE, quote.body, "req-1", {
      "x-payment": paymentHeader(quote.body.source.offer),
    }),
  });
  expect(response.status).toBe(502);
  expect(((await response.json()) as Record<string, unknown>)["terminalReason"]).toBe(
    "quote_changed",
  );

  // 受信は成立済み・送信は未実行。レシートは作らない。
  expect(await callsOf(harness.facilitator)).toMatchObject({ settleCalls: 1 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
  const status = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(ALICE),
  });
  const projection = (await status.json()) as Record<string, unknown>;
  const destination = projection["destination"] as Record<string, unknown>;
  expect(projection["status"]).toBe("paid_data_unavailable");
  expect(destination["outcome"]).toBe("not_sent");
  expect(destination["receiptRef"]).toBeUndefined();
});

test("既定（実 adapter）構成は synthetic に落ちず fail closed で起動しない", async () => {
  const harness = await boot();

  const defaultMode = await runToExit("src/main.ts", [], {
    ROUTER_CONFIG_PATH: harness.configPath,
    ROUTER_JOURNAL_PATH: path.join(harness.workDir, "default-mode.ndjson"),
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: CANONICAL_BASE_URL,
    ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
    // ROUTER_ADAPTER_MODE を与えない = 実 adapter 構成。
  });
  expect(defaultMode.code).not.toBe(0);
  expect(defaultMode.stdout).not.toContain('"listening"');
  // この構成には実レールの設定（facilitator URL / x402 上流）が無いので config_invalid で止まる。
  // 「設定は揃っているが署名能力が無い → signer_not_authorized」は tests/wire/x402-cli.test.ts。
  expect(defaultMode.stderr).toContain("config_invalid");
  expect(defaultMode.stderr).toContain("ROUTER_SUBETHA_FACILITATOR_URL");
  expect(defaultMode.stderr).not.toContain(ALICE.token);

  const unknownMode = await runToExit("src/main.ts", [], {
    ROUTER_CONFIG_PATH: harness.configPath,
    ROUTER_JOURNAL_PATH: path.join(harness.workDir, "unknown-mode.ndjson"),
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: CANONICAL_BASE_URL,
    ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
    ROUTER_ADAPTER_MODE: "syntheticish",
  });
  expect(unknownMode.code).not.toBe(0);
  expect(unknownMode.stdout).not.toContain('"listening"');
});
