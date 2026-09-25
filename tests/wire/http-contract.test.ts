/**
 * T1b wire: Router 公開契約の拒否面（設計 §3 / §7）。実 CLI を別プロセスで起動し、
 * 別プロセスのテストクライアントから実 TCP で叩く。合成 fixture は無課金・無署名。
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { runToExit } from "../fixtures/loopback.js";
import {
  ALICE,
  BOB,
  CANONICAL_BASE_URL,
  ROUTE_A,
  ROUTE_B,
  callsOf,
  paymentHeader,
  principalHeaders,
  rawGet,
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

async function journalLines(harness: Harness): Promise<string[]> {
  const text = await readFile(harness.journalPath, "utf8");
  return text.split("\n").filter((line) => line !== "");
}

test("資格情報なしの R3 は既存 offer か quote 指示を返し、journal に何も書かない", async () => {
  const harness = await boot();
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  const before = await journalLines(harness);

  const represented = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: { ...principalHeaders(ALICE), "x-router-quote-id": quote.body.quoteId },
  });
  expect(represented.status).toBe(402);
  const offerBody = (await represented.json()) as { accepts: { extra: { challengeNonce: string } }[] };
  expect(offerBody.accepts).toHaveLength(1);
  expect(offerBody.accepts[0]).toEqual(quote.body.source.offer);

  const instructed = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: principalHeaders(ALICE),
  });
  expect(instructed.status).toBe(402);
  const instruction = (await instructed.json()) as Record<string, unknown>;
  expect(instruction["routeId"]).toBe(ROUTE_A);
  expect(instruction["quoteUrl"]).toContain("/v1/quotes");
  expect(instruction["accepts"]).toEqual([]);

  // 他 principal の quoteId は offer を再提示せず、存在も明かさない。
  const byOther = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`, {
    headers: { ...principalHeaders(BOB), "x-router-quote-id": quote.body.quoteId },
  });
  expect(byOther.status).toBe(402);
  expect(((await byOther.json()) as { accepts: unknown[] }).accepts).toEqual([]);

  // 孤児レコードも課金対象も作らない。
  expect(await journalLines(harness)).toEqual(before);
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
});

test("別経路のパスで R3 を呼んでも他の quote の経路を実行しない", async () => {
  const harness = await boot();
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  const before = await journalLines(harness);

  const mismatched = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_B}/resource`, {
    headers: {
      ...principalHeaders(ALICE),
      "x-router-quote-id": quote.body.quoteId,
      "x-router-request-id": "req-1",
      "x-router-approval": quote.body.quoteId,
      "x-payment": paymentHeader(quote.body.source.offer),
    },
  });
  expect(mismatched.status).toBe(409);
  expect(((await mismatched.json()) as Record<string, unknown>)["error"]).toBe("route_mismatch");

  // どちらの上流にも支払わず、受信 settle も始めない。
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
  expect(await callsOf(harness.upstreamB)).toMatchObject({ payCalls: 0 });
  expect(await callsOf(harness.facilitator)).toMatchObject({ settleCalls: 0 });
  expect(await journalLines(harness)).toEqual(before);
});

test("クエリ付き・非 GET・未認証・不正資格情報は課金レグを開始しない", async () => {
  const harness = await boot();
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  const resourceUrl = `${harness.router.baseUrl}/v1/routes/${ROUTE_A}/resource`;
  const full = {
    ...principalHeaders(ALICE),
    "x-router-quote-id": quote.body.quoteId,
    "x-router-request-id": "req-1",
    "x-router-approval": quote.body.quoteId,
    "x-payment": paymentHeader(quote.body.source.offer),
  };

  // canonical はクエリ不可。
  const withQuery = await fetch(`${resourceUrl}?symbol=ETH`, { headers: full });
  expect(withQuery.status).toBe(400);

  // GET 以外は 405。
  const posted = await fetch(resourceUrl, { method: "POST", headers: full });
  expect(posted.status).toBe(405);
  expect(posted.headers.get("allow")).toBe("GET");

  // allowlist 外の routeId。
  const unknownRoute = await fetch(`${harness.router.baseUrl}/v1/routes/md-x/resource`, {
    headers: principalHeaders(ALICE),
  });
  expect(unknownRoute.status).toBe(404);

  // 未認証・トークン不一致。
  const anonymous = await fetch(resourceUrl);
  expect(anonymous.status).toBe(401);
  const wrongToken = await fetch(resourceUrl, {
    headers: { ...full, authorization: `Bearer ${BOB.token}` },
  });
  expect(wrongToken.status).toBe(401);

  // 所有 principal 以外は開始できない（存在も明かさない）。
  const otherPrincipal = await fetch(resourceUrl, {
    headers: { ...full, ...principalHeaders(BOB) },
  });
  expect(otherPrincipal.status).toBe(404);

  // 承認が quoteId に束縛されていない。
  const noApproval = await fetch(resourceUrl, {
    headers: { ...full, "x-router-approval": "0xnotthisquote" },
  });
  expect(noApproval.status).toBe(400);
  expect(((await noApproval.json()) as Record<string, unknown>)["error"]).toBe("approval_required");

  // 別レールの資格情報。
  const otherRail = await fetch(resourceUrl, {
    headers: {
      ...full,
      "x-payment": paymentHeader({
        ...(quote.body.source.offer as Record<string, unknown>),
        scheme: "exact",
      }),
    },
  });
  expect(otherRail.status).toBe(402);

  // 壊れた資格情報ヘッダ。
  const malformed = await fetch(resourceUrl, { headers: { ...full, "x-payment": "not-base64-json" } });
  expect(malformed.status).toBe(400);

  // admin ダンプは存在しない。
  const dump = await fetch(`${harness.router.baseUrl}/v1/purchases`, {
    headers: principalHeaders(ALICE),
  });
  expect(dump.status).toBe(404);

  expect(await callsOf(harness.facilitator)).toMatchObject({ settleCalls: 0 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
});

test("canonical path の別名では購入口を選べず、課金レグも始まらない", async () => {
  const harness = await boot();
  const quote = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  const before = await journalLines(harness);
  const headers = {
    ...principalHeaders(ALICE),
    "x-router-quote-id": quote.body.quoteId,
    "x-router-request-id": "req-1",
    "x-router-approval": quote.body.quoteId,
    "x-payment": paymentHeader(quote.body.source.offer),
  };

  // R2 が提示した canonical path と**生のリクエストパスが一致**しない限り購入しない。
  expect(quote.body.resource.url).toBe(`${CANONICAL_BASE_URL}/v1/routes/${ROUTE_A}/resource`);
  for (const rawPath of [
    `/v1/routes/${ROUTE_A}/./resource`,
    `/v1/routes/${ROUTE_A}//resource`,
    `/v1/routes/${ROUTE_A}/resource/`,
    `/v1/routes/${ROUTE_A}/../${ROUTE_A}/resource`,
    `//v1/routes/${ROUTE_A}/resource`,
  ]) {
    const aliased = await rawGet(harness, rawPath, headers);
    expect({ rawPath, status: aliased.status }).toEqual({ rawPath, status: 404 });
  }

  expect(await callsOf(harness.facilitator)).toMatchObject({ settleCalls: 0 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
  expect(await journalLines(harness)).toEqual(before);

  // 正規のパスは同じ資格情報でそのまま通る（別名だけを拒否している）。
  const exact = await rawGet(harness, `/v1/routes/${ROUTE_A}/resource`, headers);
  expect(exact.status).toBe(200);
});

test("提供できない canonicalPath の構成は起動時に fail closed で拒否される", async () => {
  const harness = await boot();
  const document = JSON.parse(await readFile(harness.configPath, "utf8")) as {
    router: { routes: Record<string, { canonicalPath: string }> };
  };
  const route = document.router.routes[ROUTE_A];
  expect(route).toBeDefined();
  if (route === undefined) {
    return;
  }
  // 承認対象として提示するのに、実際には購入できないパス。
  route.canonicalPath = "/different";
  const badPath = path.join(harness.workDir, "bad-canonical.config.json");
  await writeFile(badPath, JSON.stringify(document), "utf8");

  const result = await runToExit("src/main.ts", [], {
    ROUTER_CONFIG_PATH: badPath,
    // 起動中の Router と journal ロックを共有しない別ディレクトリ。
    ROUTER_JOURNAL_PATH: path.join(harness.workDir, "bad-canonical", "journal.ndjson"),
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: CANONICAL_BASE_URL,
    ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
    ROUTER_ADAPTER_MODE: "synthetic",
  });
  expect(result.code).not.toBe(0);
  expect(result.stdout).not.toContain('"listening"');
  expect(result.stderr).toContain("config_invalid");
  expect(result.stderr).toContain("canonicalPath");
});

test("同一 (principal, requestId) は quoteId を変えず、別 routeId は 409", async () => {
  const harness = await boot();
  const first = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  const again = await requestQuote(harness, ALICE, { routeId: ROUTE_A, requestId: "req-1" });
  expect(again.status).toBe(200);
  expect(again.body.quoteId).toBe(first.body.quoteId);
  expect(again.body.paymentId).toBe(first.body.paymentId);

  const conflict = await requestQuote(harness, ALICE, { routeId: ROUTE_B, requestId: "req-1" });
  expect(conflict.status).toBe(409);
  expect(conflict.body["error"]).toBe("request_id_conflict");

  const journal = await journalLines(harness);
  expect(journal.filter((line) => line.includes('"created"')).length).toBe(1);
});
