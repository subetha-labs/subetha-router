/**
 * Router の子の graceful drain（`docs/rejection-reasons-design.md` §13.3、タスク R-0）を、実 CLI（`src/main.ts`、合成レール・無課金・鍵なし）で確かめる。
 * - 購入の途中で相手（入口）が切っても、購入（settle → 宛先への支払い → journal）が終わるまで drain は待ち、終わってから `router drain: complete`（exit 0）
 * - drain の間の新しい接続は受けない。既存の接続の上の新しい要求は 503 `draining`（core に触れない）
 * - 上限に達したら `router drain: timeout`（exit 1）
 */
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, expect, test } from "vitest";

import { createRequestListener } from "../../src/http/app.js";
import { createDrainGate } from "../../src/shared/drain.js";
import { startListening, type Listening } from "../fixtures/loopback.js";
import { ALICE, ROUTE_A, callsOf, paymentHeader, principalHeaders, requestQuote, startHarness, type Harness } from "../fixtures/router-harness.js";

const started: Harness[] = [];
const extra: Listening[] = [];
afterEach(async () => {
  for (const child of extra.splice(0)) await child.kill("SIGKILL");
  for (const harness of started.splice(0)) {
    await harness.stopAll();
    await rm(harness.workDir, { recursive: true, force: true });
  }
});

async function until(check: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await delay(25);
  }
  return check();
}

async function connectRefused(port: number): Promise<boolean> {
  const socket = net.connect(port, "127.0.0.1");
  try {
    await once(socket, "connect");
    return false;
  } catch {
    return true;
  } finally {
    socket.destroy();
  }
}

/** 購入（R3）を始め、facilitator の settle が始まったところで相手の接続を切る。 */
async function purchaseThenDisconnect(harness: Harness, baseUrl: string, requestId: string): Promise<string> {
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId });
  expect(quote.status).toBe(200);
  const request = http.request(`${baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: {
      ...principalHeaders(ALICE),
      "x-router-quote-id": quote.body.quoteId,
      "x-router-request-id": requestId,
      "x-router-approval": quote.body.quoteId,
      "x-payment": paymentHeader(quote.body.source.offer),
    },
  });
  request.on("error", () => {});
  request.end();
  expect(await until(async () => Number((await callsOf(harness.facilitator))["settleCalls"]) >= 1, 10_000)).toBe(true);
  request.destroy();
  return quote.body.paymentId;
}

async function journalEvents(harness: Harness, paymentId: string): Promise<string[]> {
  const text = await readFile(harness.journalPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.includes(paymentId))
    .map((line) => String((JSON.parse(line) as { event?: unknown }).event));
}

test("相手が切った購入が settle の途中でも、drain は購入の終わり（delivered）まで待ってから router drain: complete（exit 0）。drain の間の新しい接続は受けない", async () => {
  const harness = await startHarness({ settleDelayMs: 3_000 });
  started.push(harness);
  const paymentId = await purchaseThenDisconnect(harness, harness.router.baseUrl, "r0-drain-1");
  const stopping = harness.router.stopWithin(30_000);
  let done = false;
  void stopping.then(() => (done = true));
  await delay(700);
  // drain の間: 子は残り（購入を続けている）、新しい接続は受けない。
  expect(done).toBe(false);
  expect(await connectRefused(harness.router.port)).toBe(true);
  const result = await stopping;
  expect(result.killed).toBe(false);
  expect(result.code, result.stderrAfter).toBe(0);
  expect(result.stderrAfter.split("\n")).toContain("router drain: complete");
  // 購入は最後まで進んだ（宛先へ支払い、結果を journal に書いた）。
  const events = await journalEvents(harness, paymentId);
  expect(events).toContain("source_settled");
  expect(events.at(-1)).toBe("delivered");
  expect(Number((await callsOf(harness.upstreamA))["payCalls"])).toBe(1);
}, 60_000);

test("進行中の処理が無ければすぐ router drain: complete（exit 0）", async () => {
  const harness = await startHarness();
  started.push(harness);
  const result = await harness.router.stopWithin(10_000);
  expect(result.code, result.stderrAfter).toBe(0);
  expect(result.stderrAfter.split("\n")).toContain("router drain: complete");
}, 60_000);

test("上限（試験は 1 秒）に達すると router drain: timeout（exit 1。complete は出ない）", async () => {
  const harness = await startHarness({ settleDelayMs: 4_000 });
  started.push(harness);
  // 同じ構成・同じ journal を使う別の Router の子（drain の上限だけ短い）。harness の Router は先に止めて journal の lock を空ける。
  await harness.router.stop();
  const child = await startListening("tests/fixtures/router-drain-child.ts", [], { ...harness.routerEnv, SUBETHA_TEST_ROUTER_DRAIN_TIMEOUT_MS: "1000" });
  extra.push(child);
  const { paymentId, resend } = await purchaseThenDisconnectVia(harness, child, "r0-drain-2");
  const sentAt = Date.now();
  const result = await child.stopWithin(20_000);
  expect(Date.now() - sentAt).toBeGreaterThanOrEqual(900);
  expect(result.killed).toBe(false);
  expect(result.code, result.stderrAfter).toBe(1);
  expect(result.stderrAfter.split("\n")).toContain("router drain: timeout");
  expect(result.stderrAfter).not.toContain("router drain: complete");

  // 回帰（Codex R-0 #3）: drain の時間切れで切られた購入は、同じ journal の再起動の後、既存の中断の状態（`unknown`・`interrupted_at_restart`）で終わる。
  // 再 settle・宛先への支払いはしない（呼び出し側が同じ要求を送り直しても）。
  await delay(3_500); // 遅らせた settle（4 秒）が fixture の側で終わるのを待つ（Router はもう聞いていない）。
  const restarted = await startListening("src/main.ts", [], harness.routerEnv);
  extra.push(restarted);
  const status = await fetch(`${restarted.baseUrl}/v1/purchases/${paymentId}`, { headers: principalHeaders(ALICE) });
  expect(status.status).toBe(200);
  expect(((await status.json()) as { status: string }).status).toBe("unknown");
  const lines = (await readFile(harness.journalPath, "utf8")).split("\n").filter((line) => line.includes(paymentId)).map((line) => JSON.parse(line) as { event: string; patch?: { reason?: string } });
  expect(lines.at(-1)).toMatchObject({ event: "unknown", patch: { reason: "interrupted_at_restart" } });
  expect(lines.map((l) => l.event)).not.toContain("destination_pending");
  expect(await resend(restarted.baseUrl)).not.toBe(200);
  await delay(300);
  expect(Number((await callsOf(harness.facilitator))["settleCalls"])).toBe(1);
  expect(Number((await callsOf(harness.upstreamA))["payCalls"])).toBe(0);
  expect((await readFile(harness.journalPath, "utf8")).split("\n").filter((line) => line.includes(paymentId)).length).toBe(lines.length);
}, 60_000);

async function purchaseThenDisconnectVia(harness: Harness, router: Listening, requestId: string): Promise<{ paymentId: string; resend: (base: string) => Promise<number> }> {
  const quote = await fetch(`${router.baseUrl}/v1/quotes`, {
    method: "POST",
    headers: { ...principalHeaders(ALICE), "content-type": "application/json" },
    body: JSON.stringify({ routeId: ROUTE_A, requestId }),
  });
  expect(quote.status).toBe(200);
  const body = (await quote.json()) as { quoteId: string; paymentId: string; source: { offer: unknown } };
  const headers = { ...principalHeaders(ALICE), "x-router-quote-id": body.quoteId, "x-router-request-id": requestId, "x-router-approval": body.quoteId, "x-payment": paymentHeader(body.source.offer) };
  const request = http.request(`${router.baseUrl}/v1/routes/${ROUTE_A}/resource`, { headers });
  request.on("error", () => {});
  request.end();
  expect(await until(async () => Number((await callsOf(harness.facilitator))["settleCalls"]) >= 1, 10_000)).toBe(true);
  request.destroy();
  // 同じ承認・同じ credential の送り直し（呼び出し側の再試行の再現）。応答の status を返す。
  const resend = async (base: string): Promise<number> => (await fetch(`${base}/v1/routes/${ROUTE_A}/resource`, { headers })).status;
  return { paymentId: body.paymentId, resend };
}

test("drain の後の要求（既存の接続の上）は 503 draining で断り、処理（core）に触れない。drain を渡さなければ今までどおり", async () => {
  let touched = 0;
  const core = new Proxy({}, { get: () => () => ((touched += 1), undefined) });
  const drain = createDrainGate();
  const server = http.createServer(createRequestListener({ drain, core: core as never, config: { routes: {} } as never, canonicalBaseUrl: "http://router.invalid", principals: new Map([["alice", "tok"]]) }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    drain.close();
    const refused = await fetch(`http://127.0.0.1:${port}/v1/quotes`, { method: "POST", headers: { authorization: "Bearer tok", "x-router-principal": "alice", "content-type": "application/json" }, body: "{}" });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("connection")).toBe("close");
    expect(await refused.json()).toEqual({ error: "draining" });
    expect(touched).toBe(0);
    expect(drain.inFlight()).toBe(0);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
