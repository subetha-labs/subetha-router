/**
 * Codex R-2 #3（タスク R-2）: 診断の sink の `close` の accessor が投げても、Router の子の drain の結果（`router drain: complete`・exit 0 と
 * `router drain: timeout`・exit 1）は変わらない。実 CLI と同じ `startRouter`（合成レール・無課金・鍵なし）を `tests/fixtures/router-drain-child.ts` で起動する。
 */
import http from "node:http";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, test } from "vitest";

import { startListening, type Listening } from "../fixtures/loopback.js";
import { ALICE, ROUTE_A, callsOf, paymentHeader, principalHeaders, startHarness, type Harness } from "../fixtures/router-harness.js";

const started: Harness[] = [];
const extra: Listening[] = [];
afterEach(async () => {
  for (const child of extra.splice(0)) await child.kill("SIGKILL");
  for (const harness of started.splice(0)) {
    await harness.stopAll();
    await rm(harness.workDir, { recursive: true, force: true });
  }
});

async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await delay(25);
  }
  return check();
}

async function childWithBrokenClose(harness: Harness, timeoutMs: string): Promise<Listening> {
  // harness の Router を止めて journal の lock を空け、同じ構成で accessor の投げる sink の子を起動する。
  await harness.router.stop();
  const child = await startListening("tests/fixtures/router-drain-child.ts", [], { ...harness.routerEnv, SUBETHA_TEST_ROUTER_DRAIN_TIMEOUT_MS: timeoutMs, SUBETHA_TEST_DIAG_CLOSE: "accessor-throws" });
  extra.push(child);
  return child;
}

test("進行中の処理が無い drain: close の accessor が投げても router drain: complete（exit 0）", async () => {
  const harness = await startHarness();
  started.push(harness);
  const child = await childWithBrokenClose(harness, "10000");
  const result = await child.stopWithin(15_000);
  expect(result.killed).toBe(false);
  expect(result.code, result.stderrAfter).toBe(0);
  expect(result.stderrAfter.split("\n")).toContain("router drain: complete");
  expect(result.stderrAfter).not.toContain("accessor");
}, 60_000);

test("drain の時間切れ: close の accessor が投げても router drain: timeout（exit 1）", async () => {
  const harness = await startHarness({ settleDelayMs: 4_000 });
  started.push(harness);
  const child = await childWithBrokenClose(harness, "1000");
  const requestId = "r2-drain-broken-close";
  const quote = await fetch(`${child.baseUrl}/v1/quotes`, { method: "POST", headers: { ...principalHeaders(ALICE), "content-type": "application/json" }, body: JSON.stringify({ routeId: ROUTE_A, requestId }) });
  expect(quote.status).toBe(200);
  const body = (await quote.json()) as { quoteId: string; source: { offer: unknown } };
  const request = http.request(`${child.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: { ...principalHeaders(ALICE), "x-router-quote-id": body.quoteId, "x-router-request-id": requestId, "x-router-approval": body.quoteId, "x-payment": paymentHeader(body.source.offer) },
  });
  request.on("error", () => {});
  request.end();
  expect(await until(async () => Number((await callsOf(harness.facilitator))["settleCalls"]) >= 1, 10_000)).toBe(true);
  request.destroy();
  const result = await child.stopWithin(20_000);
  expect(result.killed).toBe(false);
  expect(result.code, result.stderrAfter).toBe(1);
  expect(result.stderrAfter.split("\n")).toContain("router drain: timeout");
  expect(result.stderrAfter).not.toContain("router drain: complete");
  expect(result.stderrAfter).not.toContain("accessor");
  await delay(3_500); // 遅らせた settle が fixture の側で終わるのを待つ。
}, 60_000);
