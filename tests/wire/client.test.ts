/**
 * T4 wire: 型付き薄いクライアント（`src/client`）を、**実 CLI 越しの Router** に対して確認する。
 *
 * Router・facilitator・上流はいずれも別プロセスの合成 fixture（loopback・無課金・無署名・鍵なし）で、
 * クライアントは署名も credential 生成もしない。credential は**明示承認のあとに呼び出し側が渡す**
 * 既存の値だけを使う。ラベル `T4-fixture-nopay`（実決済ではない）。
 */

import { rm } from "node:fs/promises";

import { afterEach, expect, test } from "vitest";

import {
  createMarketDataProfile,
  reconciliationRecordOf,
  type ProfileRun,
} from "../../examples/chat-market-data-profile.js";
import { createRouterClient } from "../../src/client/index.js";
import type { ApprovalDecision, QuoteView, RouterClient } from "../../src/client/types.js";
import {
  ALICE,
  BOB,
  ROUTE_A,
  callsOf,
  paymentHeader,
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

function clientFor(harness: Harness, principal = ALICE) {
  return createRouterClient({
    baseUrl: harness.router.baseUrl,
    principalId: principal.id,
    token: principal.token,
  });
}

/** 明示承認（人間の判断の代わりにテストが与える値）。自動承認は client 側に無い。 */
function approve(quote: QuoteView): ApprovalDecision {
  return { approved: true, quoteId: quote.quoteId };
}

/** 承認後に呼び出し側が渡す既存 credential（クライアントは作らない）。 */
function credentialFor(quote: QuoteView): string {
  return paymentHeader(quote.source.offer);
}

test("quote は quoteId 束縛の承認要求を返し、トークンを結果に含めない", async () => {
  const harness = await boot();
  const client = clientFor(harness);

  const quote = await client.quote({ routeId: ROUTE_A, requestId: "c-1" });
  expect(quote.ok).toBe(true);
  if (!quote.ok) {
    return;
  }
  expect(quote.quote.routeId).toBe(ROUTE_A);
  expect(quote.quote.approval.required).toBe(true);
  expect(quote.quote.approval.boundTo).toBe(quote.quote.quoteId);
  expect(quote.quote.paymentId).toMatch(/.+/);
  expect(quote.quote.resource.method).toBe("GET");
  // 秘密は結果にも例外にも出さない。
  expect(JSON.stringify(quote)).not.toContain(ALICE.token);
  // 上流 URL も公開しない。
  expect(JSON.stringify(quote)).not.toContain(harness.upstreamA.baseUrl);
});

test("承認が無い/拒否された/対象が違う承認では支払いを開始しない", async () => {
  const harness = await boot();
  const client = clientFor(harness);
  const quoted = await client.quote({ routeId: ROUTE_A, requestId: "c-2" });
  if (!quoted.ok) {
    throw new Error("quote failed");
  }
  const quote = quoted.quote;
  const credential = credentialFor(quote);

  // 明示的な拒否。
  const rejected = await client.execute({
    quote,
    requestId: "c-2",
    approval: { approved: false, reason: "human_declined" },
    credential,
  });
  expect(rejected.outcome).toBe("not_approved");

  // 別 quote への承認（対象変更）。
  const mismatched = await client.execute({
    quote,
    requestId: "c-2",
    approval: { approved: true, quoteId: `${quote.quoteId}-other` },
    credential,
  });
  expect(mismatched.outcome).toBe("approval_mismatch");

  // canonical path を差し替えた quote（承認した口以外では実行しない）。
  const tampered: QuoteView = {
    ...quote,
    resource: { ...quote.resource, url: `${harness.router.baseUrl}/v1/routes/${ROUTE_A}/other` },
  };
  const offPath = await client.execute({
    quote: tampered,
    requestId: "c-2",
    approval: approve(quote),
    credential,
  });
  expect(offPath.outcome).toBe("resource_mismatch");

  // どの経路でも Router には購入要求が届いておらず、両レグとも動いていない。
  expect(await callsOf(harness.facilitator)).toMatchObject({ verifyCalls: 0, settleCalls: 0 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
});

test("承認済みの実行は snapshot と paymentId を返し、再オープンと重複実行で同じ結果になる", async () => {
  const harness = await boot();
  const client = clientFor(harness);
  const quoted = await client.quote({ routeId: ROUTE_A, requestId: "c-3" });
  if (!quoted.ok) {
    throw new Error("quote failed");
  }
  const quote = quoted.quote;

  const executed = await client.execute({
    quote,
    requestId: "c-3",
    approval: approve(quote),
    credential: credentialFor(quote),
  });
  expect(executed.outcome).toBe("delivered");
  if (executed.outcome !== "delivered") {
    return;
  }
  // Router が返した上流 snapshot そのもの（article へ cast せず、擬似 article も作らない）。
  expect(executed.snapshot).toMatchObject({
    providerId: "synthetic-provider-a",
    market: "ETH",
    data: { symbol: "ETH", price: "3000.12" },
  });
  expect(executed.paymentId).toBe(quote.paymentId);

  const status = await client.status(quote.paymentId);
  expect(status.found).toBe(true);
  if (!status.found) {
    return;
  }
  expect(status.projection.status).toBe("delivered");
  expect(status.projection.result).toEqual(executed.snapshot);

  // 同一 client での重複実行（意図的な再実行）でも再購入しない（同じ結果・同じ paymentId）。
  const again = await client.execute({
    quote,
    requestId: "c-3",
    approval: approve(quote),
    credential: credentialFor(quote),
  });
  expect(again.outcome).toBe("delivered");
  if (again.outcome === "delivered") {
    expect(again.paymentId).toBe(quote.paymentId);
    expect(again.snapshot).toEqual(executed.snapshot);
  }
  expect(await callsOf(harness.facilitator)).toMatchObject({ verifyCalls: 1, settleCalls: 1 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });

  // 保存 → 再オープン相当（Router 再起動後の R4）。再起動で待ち受けポートが変わるため、
  // 再オープン側は設定値から改めてクライアントを作る（chat セッション再開と同じ形）。
  // 作り直した client では**参照だけ**ができる（実行は別テストで fail closed を確認）。
  await harness.restartRouter();
  const reopenedClient = clientFor(harness);
  const reopened = await reopenedClient.status(quote.paymentId);
  expect(reopened).toEqual(status);
}, 15_000);

test("他 principal は実行も参照もできず、失敗にトークンが出ない", async () => {
  const harness = await boot();
  const alice = clientFor(harness);
  const bob = clientFor(harness, BOB);
  const quoted = await alice.quote({ routeId: ROUTE_A, requestId: "c-4" });
  if (!quoted.ok) {
    throw new Error("quote failed");
  }
  const quote = quoted.quote;

  // 他 principal の client は Alice の quote を発行していないので、要求を出す前に fail closed。
  const byBob = await bob.execute({
    quote,
    requestId: "c-4",
    approval: approve(quote),
    credential: credentialFor(quote),
  });
  expect(byBob.outcome).toBe("resource_mismatch");
  // 参照は Router 側で拒否される（所有 principal 以外には存在も明かさない）。
  const bobStatus = await bob.status(quote.paymentId);
  expect(bobStatus.found).toBe(false);

  const serialized = JSON.stringify([byBob, bobStatus]);
  expect(serialized).not.toContain(ALICE.token);
  expect(serialized).not.toContain(BOB.token);
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
});

test("unknown と paid_data_unavailable を区別し、どちらも paymentId を読める", async () => {
  const unknownHarness = await boot({ pay: "error" });
  const unknownClient = clientFor(unknownHarness);
  const unknownQuote = await unknownClient.quote({ routeId: ROUTE_A, requestId: "c-5" });
  if (!unknownQuote.ok) {
    throw new Error("quote failed");
  }
  const unknownResult = await unknownClient.execute({
    quote: unknownQuote.quote,
    requestId: "c-5",
    approval: approve(unknownQuote.quote),
    credential: credentialFor(unknownQuote.quote),
  });
  expect(unknownResult.outcome).toBe("unknown");
  expect(unknownResult.paymentId).toBe(unknownQuote.quote.paymentId);

  const paidHarness = await boot({ pay: "paid-no-data" });
  const paidClient = clientFor(paidHarness);
  const paidQuote = await paidClient.quote({ routeId: ROUTE_A, requestId: "c-6" });
  if (!paidQuote.ok) {
    throw new Error("quote failed");
  }
  const paidResult = await paidClient.execute({
    quote: paidQuote.quote,
    requestId: "c-6",
    approval: approve(paidQuote.quote),
    credential: credentialFor(paidQuote.quote),
  });
  expect(paidResult.outcome).toBe("paid_data_unavailable");
  expect(paidResult.paymentId).toBe(paidQuote.quote.paymentId);
  // 自動再購入・自動再承認はしない。
  expect(await callsOf(paidHarness.upstreamA)).toMatchObject({ payCalls: 1 });
}, 15_000);

test("要求は設定した origin に固定され、取得した canonical URL の改変は受理しない", async () => {
  const harness = await boot();
  const client = clientFor(harness);
  const quoted = await client.quote({ routeId: ROUTE_A, requestId: "c-7" });
  if (!quoted.ok) {
    throw new Error("quote failed");
  }
  const quote = quoted.quote;
  // R2 が返す canonical origin（設定値 8500）は client の baseUrl とは別でよい。
  expect(quote.resource.url.startsWith("http://127.0.0.1:8500/")).toBe(true);

  const altered = (url: string): QuoteView => ({
    ...quote,
    resource: { ...quote.resource, url },
  });
  const cases = [
    // 別 origin。
    `http://127.0.0.1:9/v1/routes/${ROUTE_A}/resource`,
    // クエリ追加。
    `${quote.resource.url}?x=1`,
    // フラグメント追加。
    `${quote.resource.url}#x`,
  ];
  for (const url of cases) {
    const result = await client.execute({
      quote: altered(url),
      requestId: "c-7",
      approval: approve(quote),
      credential: credentialFor(quote),
    });
    expect(result.outcome).toBe("resource_mismatch");
  }
  // 改変された quote では 1 度も購入しない。
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });

  // 取得したままの quote（同一承認の意図的な再実行）は安全に成立する。
  const ok = await client.execute({
    quote,
    requestId: "c-7",
    approval: approve(quote),
    credential: credentialFor(quote),
  });
  expect(ok.outcome).toBe("delivered");
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
});

/** 実 Router への往復は残したまま、R3 / R4 の応答だけを壊す注入 fetch。 */
function tamperFetch(
  shouldTamper: (url: string) => boolean,
  transform: (response: Response) => Promise<Response>,
): typeof globalThis.fetch {
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const response = await globalThis.fetch(input, init);
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return shouldTamper(url) ? transform(response) : response;
  };
}

/** R3 応答だけを壊す client（quote は実 Router から取得する＝発行元はこの client）。 */
function tamperingClient(
  harness: Harness,
  tamper: (response: Response) => Promise<Response>,
  pathPart = "/resource",
): ReturnType<typeof createRouterClient> {
  return createRouterClient({
    baseUrl: harness.router.baseUrl,
    principalId: ALICE.id,
    token: ALICE.token,
    fetch: tamperFetch((url) => url.includes(pathPart), tamper),
  });
}

async function executeWith(
  client: ReturnType<typeof createRouterClient>,
  requestId: string,
): Promise<{ result: Awaited<ReturnType<typeof client.execute>>; quote: QuoteView }> {
  const quoted = await client.quote({ routeId: ROUTE_A, requestId });
  if (!quoted.ok) {
    throw new Error(`quote failed: ${quoted.error}`);
  }
  const quote = quoted.quote;
  const result = await client.execute({
    quote,
    requestId,
    approval: approve(quote),
    credential: credentialFor(quote),
  });
  return { result, quote };
}

test("R3 応答が壊れている/別 paymentId を名乗るときは承認済み ID で unknown を保つ", async () => {
  const harness = await boot();

  // 200 だが本文が JSON として壊れている。
  const corrupt = await executeWith(
    tamperingClient(
      harness,
      async () =>
        new Response("not-json{", { status: 200, headers: { "content-type": "application/json" } }),
    ),
    "c-8a",
  );
  expect(corrupt.result.outcome).toBe("unknown");
  expect(corrupt.result.paymentId).toBe(corrupt.quote.paymentId);

  // 別 paymentId を名乗る 200。
  const otherId = await executeWith(
    tamperingClient(harness, async (response) =>
      new Response(await response.text(), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-router-payment-id": "other-payment-id",
        },
      }),
    ),
    "c-8b",
  );
  expect(otherId.result.outcome).toBe("unknown");
  expect(otherId.result.paymentId).toBe(otherId.quote.paymentId);

  // 壊れた 500 でも承認済み ID を失わない（rejected にしない）。
  const corrupt500 = await executeWith(
    tamperingClient(
      harness,
      async () =>
        new Response("{oops", { status: 500, headers: { "content-type": "application/json" } }),
    ),
    "c-8c",
  );
  expect(corrupt500.result.outcome).toBe("unknown");
  expect(corrupt500.result.paymentId).toBe(corrupt500.quote.paymentId);
}, 20_000);

test("R3 の paymentId メタが欠落/矛盾しているときは承認済み ID で unknown を保つ", async () => {
  const harness = await boot();

  // 200 なのに Router の paymentId ヘッダが無い（本文の `paymentId` は上流 snapshot の欄であり
  // Router のメタではないので、代わりに使ってはならない）。
  const noHeader = await executeWith(
    tamperingClient(harness, async (response) => {
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ ...body, paymentId: "snapshot-field-not-router-meta" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
    "c-11a",
  );
  expect(noHeader.result.outcome).toBe("unknown");
  expect(noHeader.result.paymentId).toBe(noHeader.quote.paymentId);

  // 正しいヘッダがあれば、本文に別の `paymentId` 欄があっても成立する（本文は解釈しない）。
  let approvedId = "";
  const bodyNoiseClient = createRouterClient({
    baseUrl: harness.router.baseUrl,
    principalId: ALICE.id,
    token: ALICE.token,
    fetch: tamperFetch(
      (url) => url.includes("/resource"),
      async (response) => {
        const body = (await response.json()) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ ...body, paymentId: "snapshot-field-not-router-meta" }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-router-payment-id": approvedId,
            },
          },
        );
      },
    ),
  });
  const quoted = await bodyNoiseClient.quote({ routeId: ROUTE_A, requestId: "c-11b" });
  if (!quoted.ok) {
    throw new Error("quote failed");
  }
  approvedId = quoted.quote.paymentId;
  const bodyNoise = await bodyNoiseClient.execute({
    quote: quoted.quote,
    requestId: "c-11b",
    approval: approve(quoted.quote),
    credential: credentialFor(quoted.quote),
  });
  expect(bodyNoise.outcome).toBe("delivered");
  expect(bodyNoise.paymentId).toBe(quoted.quote.paymentId);
}, 20_000);

test("502 の明示結果は本文の paymentId が一致して初めて採用する", async () => {
  const harness = await boot({ pay: "paid-no-data" });

  // 502 だが本文に paymentId が無い → 明示結果として採用せず unknown（承認済み ID を保つ）。
  const missing = await executeWith(
    tamperingClient(harness, async (response) => {
      const body = (await response.json()) as Record<string, unknown>;
      const { paymentId: _dropped, ...rest } = body;
      return new Response(JSON.stringify(rest), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }),
    "c-12a",
  );
  expect(missing.result.outcome).toBe("unknown");
  expect(missing.result.paymentId).toBe(missing.quote.paymentId);

  // ヘッダと本文が食い違う 502 も採用しない。
  const conflicting = await executeWith(
    tamperingClient(harness, async (response) =>
      new Response(await response.text(), {
        status: 502,
        headers: {
          "content-type": "application/json",
          "x-router-payment-id": "other-payment-id",
        },
      }),
    ),
    "c-12b",
  );
  expect(conflicting.result.outcome).toBe("unknown");
  expect(conflicting.result.paymentId).toBe(conflicting.quote.paymentId);
}, 20_000);

test("402 の本文が空/壊れている応答は payment_required にせず承認済み ID で unknown", async () => {
  const harness = await boot();

  // 本文が空の 402。
  const empty = await executeWith(
    tamperingClient(
      harness,
      async () =>
        new Response("", { status: 402, headers: { "content-type": "application/json" } }),
    ),
    "c-15a",
  );
  expect(empty.result.outcome).toBe("unknown");
  expect(empty.result.paymentId).toBe(empty.quote.paymentId);
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });

  // 本文が JSON として壊れている 402。
  const broken = await executeWith(
    tamperingClient(
      harness,
      async () =>
        new Response("{nope", { status: 402, headers: { "content-type": "application/json" } }),
    ),
    "c-15b",
  );
  expect(broken.result.outcome).toBe("unknown");
  expect(broken.result.paymentId).toBe(broken.quote.paymentId);
  // 追加の送信はしない（購入は各 requestId で 1 回だけ）。
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 2 });
}, 20_000);

test("quote() の入力を await 中に書き換えても、発行時の requestId 束縛が動かない", async () => {
  const harness = await boot();
  const client = clientFor(harness);

  const input = { routeId: ROUTE_A, requestId: "c-16" };
  const pending = client.quote(input);
  // 最初の await より後に書き換える（Router には元の requestId で束縛されている）。
  input.requestId = "c-16-mutated";
  input.routeId = "md-b-eth-snapshot";
  const quoted = await pending;
  if (!quoted.ok) {
    throw new Error("quote failed");
  }
  const quote = quoted.quote;
  expect(quote.routeId).toBe(ROUTE_A);

  // 書き換え後の requestId では実行しない（送信も無い）。
  const mutated = await client.execute({
    quote,
    requestId: "c-16-mutated",
    approval: approve(quote),
    credential: credentialFor(quote),
  });
  expect(mutated.outcome).toBe("resource_mismatch");
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });

  // 発行時の requestId でだけ実行できる。
  const original = await client.execute({
    quote,
    requestId: "c-16",
    approval: approve(quote),
    credential: credentialFor(quote),
  });
  expect(original.outcome).toBe("delivered");
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
}, 15_000);

test("別 client で作り直した quote は実行できず、参照（R4）だけができる", async () => {
  const harness = await boot();
  const client = clientFor(harness);
  const quoted = await client.quote({ routeId: ROUTE_A, requestId: "c-13" });
  if (!quoted.ok) {
    throw new Error("quote failed");
  }
  const quote = quoted.quote;

  // 同一 client での意図的な再実行（再起動前）は安全に成立し、両レグとも 1 回だけ。
  const first = await client.execute({
    quote,
    requestId: "c-13",
    approval: approve(quote),
    credential: credentialFor(quote),
  });
  const replay = await client.execute({
    quote,
    requestId: "c-13",
    approval: approve(quote),
    credential: credentialFor(quote),
  });
  expect(first.outcome).toBe("delivered");
  expect(replay.outcome).toBe("delivered");
  expect(await callsOf(harness.facilitator)).toMatchObject({ verifyCalls: 1, settleCalls: 1 });
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });

  // 別 client（再オープン相当）では参照だけができる。
  const reopened = clientFor(harness);
  const status = await reopened.status(quote.paymentId);
  expect(status.found).toBe(true);
  if (status.found) {
    expect(status.projection.paymentId).toBe(quote.paymentId);
  }

  // 発行していない quote での実行は fail closed（自動 re-quote も再実行もしない）。
  const byOtherClient = await reopened.execute({
    quote,
    requestId: "c-13",
    approval: approve(quote),
    credential: credentialFor(quote),
  });
  expect(byOtherClient.outcome).toBe("resource_mismatch");
  expect(byOtherClient.paymentId).toBe(quote.paymentId);
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
}, 15_000);

test("R4 は問い合わせた paymentId と一致しない射影を受理しない", async () => {
  const harness = await boot();
  const plain = clientFor(harness);
  const quoted = await plain.quote({ routeId: ROUTE_A, requestId: "c-9" });
  if (!quoted.ok) {
    throw new Error("quote failed");
  }
  const quote = quoted.quote;
  await plain.execute({
    quote,
    requestId: "c-9",
    approval: approve(quote),
    credential: credentialFor(quote),
  });

  const mismatching = createRouterClient({
    baseUrl: harness.router.baseUrl,
    principalId: ALICE.id,
    token: ALICE.token,
    fetch: tamperFetch(
      (url) => url.includes("/v1/purchases/"),
      async (response) => {
        const body = (await response.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...body, paymentId: "other-payment-id" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ),
  });
  const status = await mismatching.status(quote.paymentId);
  expect(status.found).toBe(false);
});

/* ------------------------------------------------------------------------- *
 * 統合例（`examples/chat-market-data-profile.ts`）の経路。**例そのものの証拠**で、
 * 実 chat UI 連携の証拠ではない（consumer 側の実装は別オーナー）。
 * ------------------------------------------------------------------------- */

interface ProfileProbe {
  readonly credentialCalls: number;
  readonly approvalCalls: number;
}

function profileFor(
  harness: Harness,
  decide: (quote: QuoteView) => ApprovalDecision,
  probe: { credentialCalls: number; approvalCalls: number },
  mutate = false,
) {
  return createMarketDataProfile({
    client: clientFor(harness),
    async requestApproval({ quote, summary }) {
      probe.approvalCalls += 1;
      if (mutate) {
        // 承認 UI 側から quote / summary を書き換えようとしても束縛は動かない。
        try {
          (quote as { quoteId: string }).quoteId = "mutated-quote";
          (quote.resource as { url: string }).url = "http://127.0.0.1:9/evil";
          (quote.source as { amount: string }).amount = "1";
          (summary as { paymentId: string }).paymentId = "mutated-payment";
        } catch {
          // frozen なら例外になる。どちらでも束縛は元の値のまま。
        }
      }
      return decide(quote);
    },
    async provideCredential({ quote }) {
      probe.credentialCalls += 1;
      return credentialFor(quote);
    },
  });
}

test("統合例: 人間が拒否すると credential も購入要求も発生しない", async () => {
  const harness = await boot();
  const probe = { credentialCalls: 0, approvalCalls: 0 };
  const profile = profileFor(harness, () => ({ approved: false, reason: "human_declined" }), probe);

  const run = await profile.run({ routeId: ROUTE_A, requestId: "p-1" });
  expect(run.step).toBe("declined");
  expect(probe.approvalCalls).toBe(1);
  expect(probe.credentialCalls).toBe(0);
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
  expect(await callsOf(harness.facilitator)).toMatchObject({ verifyCalls: 0, settleCalls: 0 });
});

test("統合例: 別 quote への承認では credential callback も R3 も呼ばない", async () => {
  const harness = await boot();
  const probe = { credentialCalls: 0, approvalCalls: 0 };
  const profile = profileFor(
    harness,
    (quote) => ({ approved: true, quoteId: `${quote.quoteId}-other` }),
    probe,
  );

  const run = await profile.run({ routeId: ROUTE_A, requestId: "p-2" });
  expect(run.step).toBe("executed");
  if (run.step === "executed") {
    expect(run.result.outcome).toBe("approval_mismatch");
  }
  expect(probe.credentialCalls).toBe(0);
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
});

test("統合例: 承認 callback からの改変は束縛を動かさず、1 回だけ実行される", async () => {
  const harness = await boot();
  const probe = { credentialCalls: 0, approvalCalls: 0 };
  const profile = profileFor(
    harness,
    (quote) => ({ approved: true, quoteId: quote.quoteId }),
    probe,
    true,
  );

  const run = await profile.run({ routeId: ROUTE_A, requestId: "p-3" });
  expect(run.step).toBe("executed");
  if (run.step !== "executed" || run.result.outcome !== "delivered") {
    throw new Error(`unexpected run: ${JSON.stringify(run)}`);
  }
  // 改変後の URL / 金額ではなく、取得した quote の束縛で実行されている。
  expect(run.quote.routeId).toBe(ROUTE_A);
  expect(run.result.snapshot).toMatchObject({ providerId: "synthetic-provider-a" });
  expect(probe.credentialCalls).toBe(1);
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });

  const record = reconciliationRecordOf(run);
  expect(record.paymentId).toBe(run.quote.paymentId);
  expect(record.outcome).toBe("delivered");
}, 15_000);

test("統合例: 承認 → credential → 1 回実行 → 再起動後の reopen が同一結果", async () => {
  const harness = await boot();
  const probe = { credentialCalls: 0, approvalCalls: 0 };
  const profile = profileFor(harness, (quote) => ({ approved: true, quoteId: quote.quoteId }), probe);

  const run: ProfileRun = await profile.run({ routeId: ROUTE_A, requestId: "p-4" });
  if (run.step !== "executed" || run.result.outcome !== "delivered") {
    throw new Error(`unexpected run: ${JSON.stringify(run)}`);
  }
  const paymentId = run.result.paymentId;
  expect(paymentId).toBe(run.quote.paymentId);
  expect(probe.credentialCalls).toBe(1);

  const before = await profile.reopen(paymentId);
  expect(before.found).toBe(true);

  // 保存 → 再オープン（Router 再起動でポートが変わるので、設定値から作り直した profile で読む）。
  await harness.restartRouter();
  const reopenProfile = profileFor(
    harness,
    (quote) => ({ approved: true, quoteId: quote.quoteId }),
    { credentialCalls: 0, approvalCalls: 0 },
  );
  const after = await reopenProfile.reopen(paymentId);
  expect(after).toEqual(before);
  if (after.found) {
    expect(after.projection.paymentId).toBe(paymentId);
    expect(after.projection.result).toEqual(run.result.snapshot);
  }
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
}, 15_000);

test("統合例: unknown は保持され、自動再実行も自動再承認もしない", async () => {
  const harness = await boot({ pay: "error" });
  const probe = { credentialCalls: 0, approvalCalls: 0 };
  const profile = profileFor(harness, (quote) => ({ approved: true, quoteId: quote.quoteId }), probe);

  const run = await profile.run({ routeId: ROUTE_A, requestId: "p-5" });
  if (run.step !== "executed") {
    throw new Error("expected an executed run");
  }
  expect(run.result.outcome).toBe("unknown");
  expect(run.result.paymentId).toBe(run.quote.paymentId);
  expect(reconciliationRecordOf(run)).toMatchObject({
    paymentId: run.quote.paymentId,
    outcome: "unknown",
  });
  // 承認・credential・購入要求はそれぞれ 1 回だけ（自動再試行なし）。
  expect(probe.approvalCalls).toBe(1);
  expect(probe.credentialCalls).toBe(1);
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
}, 15_000);

/**
 * 凍結しない（＝ profile 側の防御に頼る）注入 client。`quote()` は複製した**可変**の quote を返し、
 * 必要なら束縛欄を改変する。`execute` / `status` は実 client にそのまま委譲する。
 */
function mutableQuoteClient(
  harness: Harness,
  transform: (quote: QuoteView) => QuoteView = (quote) => quote,
): RouterClient {
  const inner = clientFor(harness);
  return {
    listRoutes: () => inner.listRoutes(),
    async quote(input) {
      const result = await inner.quote(input);
      if (!result.ok) {
        return result;
      }
      return { ok: true, quote: transform(structuredClone(result.quote) as QuoteView) };
    },
    quoteUrl: (input) => inner.quoteUrl(input),
    execute: (input) => inner.execute(input),
    status: (paymentId, ownerKey) => inner.status(paymentId, ownerKey),
  };
}

test("統合例: 呼び出し側が入力 object を後から書き換えても束縛は動かない", async () => {
  const harness = await boot();
  const probe = { credentialCalls: 0, approvalCalls: 0 };
  const profile = profileFor(harness, (quote) => ({ approved: true, quoteId: quote.quoteId }), probe);

  const input = { routeId: ROUTE_A, requestId: "p-6" };
  const pending = profile.run(input);
  // 最初の await より後に書き換えても、既に固定した routeId / requestId で走る。
  input.requestId = "mutated-request";
  input.routeId = "md-b-eth-snapshot";
  const run = await pending;

  if (run.step !== "executed" || run.result.outcome !== "delivered") {
    throw new Error(`unexpected run: ${JSON.stringify(run)}`);
  }
  expect(run.quote.routeId).toBe(ROUTE_A);
  const status = await profile.reopen(run.result.paymentId);
  expect(status.found).toBe(true);
  if (status.found) {
    expect(status.projection.routeId).toBe(ROUTE_A);
  }
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
}, 15_000);

test("統合例: client が凍結しない場合も quote/summary の改変を無効化する", async () => {
  const harness = await boot();
  const probe = { credentialCalls: 0, approvalCalls: 0 };
  const profile = createMarketDataProfile({
    client: mutableQuoteClient(harness),
    async requestApproval({ quote, summary }) {
      probe.approvalCalls += 1;
      // 凍結されていなければここで書き換えが通ってしまう（profile 側の防御を確認する）。
      try {
        (quote.resource as { url: string }).url = `http://127.0.0.1:9/v1/routes/${ROUTE_A}/resource`;
        (quote.source as { amount: string }).amount = "1";
        (summary as { quoteId: string }).quoteId = "mutated";
      } catch {
        // frozen なら例外。どちらでも束縛は元の値のまま。
      }
      return { approved: true, quoteId: quote.quoteId };
    },
    async provideCredential({ quote }) {
      probe.credentialCalls += 1;
      return credentialFor(quote);
    },
  });

  const run = await profile.run({ routeId: ROUTE_A, requestId: "p-7" });
  if (run.step !== "executed") {
    throw new Error(`unexpected run: ${JSON.stringify(run)}`);
  }
  // 改変された URL / 金額では実行されず、取得した束縛のまま成立する。
  expect(run.result.outcome).toBe("delivered");
  expect(probe.credentialCalls).toBe(1);
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
}, 15_000);

test("統合例: boundTo が承認対象と違う quote では credential を取りに行かない", async () => {
  const harness = await boot();
  const probe = { credentialCalls: 0, approvalCalls: 0 };
  const profile = createMarketDataProfile({
    client: mutableQuoteClient(harness, (quote) => ({
      ...quote,
      approval: { ...quote.approval, boundTo: "other-quote-id" },
    })),
    async requestApproval({ quote }) {
      probe.approvalCalls += 1;
      return { approved: true, quoteId: quote.quoteId };
    },
    async provideCredential({ quote }) {
      probe.credentialCalls += 1;
      return credentialFor(quote);
    },
  });

  const run = await profile.run({ routeId: ROUTE_A, requestId: "p-8" });
  if (run.step !== "executed") {
    throw new Error(`unexpected run: ${JSON.stringify(run)}`);
  }
  expect(run.result.outcome).toBe("approval_mismatch");
  expect(probe.credentialCalls).toBe(0);
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 0 });
});

test("統合例: 承認 object を後から書き換えても、承認時点の判断で進む", async () => {
  const harness = await boot();
  let decision: { approved: boolean; quoteId?: string; reason?: string } | undefined;
  const profile = createMarketDataProfile({
    client: clientFor(harness),
    async requestApproval({ quote }) {
      decision = { approved: true, quoteId: quote.quoteId };
      return decision as ApprovalDecision;
    },
    async provideCredential({ quote }) {
      // callback が返した object を後から書き換える（承認の取り消しではない）。
      if (decision !== undefined) {
        decision.approved = false;
        decision.quoteId = "mutated";
      }
      return credentialFor(quote);
    },
  });

  const run = await profile.run({ routeId: ROUTE_A, requestId: "p-9" });
  if (run.step !== "executed") {
    throw new Error(`unexpected run: ${JSON.stringify(run)}`);
  }
  // 承認時点の判断（同一 quote への approve）で 1 回だけ実行される。
  expect(run.result.outcome).toBe("delivered");
  expect(await callsOf(harness.upstreamA)).toMatchObject({ payCalls: 1 });
}, 15_000);

test("通信例外は固定の安全な失敗になり、トークンを外へ出さない", async () => {
  const harness = await boot();
  const throwing = createRouterClient({
    baseUrl: harness.router.baseUrl,
    principalId: ALICE.id,
    token: ALICE.token,
    fetch: async () => {
      // 注入 fetch が秘密を含む例外を投げても、そのまま外へ出さない。
      throw new Error(`synthetic transport failure for token ${ALICE.token}`);
    },
  });

  const routes = await throwing.listRoutes();
  const quoted = await throwing.quote({ routeId: ROUTE_A, requestId: "c-10" });
  const status = await throwing.status("payment-does-not-matter");

  expect(routes.ok).toBe(false);
  expect(quoted.ok).toBe(false);
  expect(status.found).toBe(false);
  const serialized = JSON.stringify([routes, quoted, status]);
  expect(serialized).not.toContain(ALICE.token);
  expect(serialized).not.toContain("synthetic transport failure");

});

/**
 * ステートレス運用（リモート MCP）の opt-in。
 * 既定では**この client が発行した quote だけ**を実行するが、
 * quote と purchase が別プロセスになる構成では呼び出し側が quote を持ち回る必要がある。
 * **緩むのは client 側の補助検査だけ**で、Router 側の拒否面は変わらない。
 */
test("ステートレス opt-in が無ければ、発行していない quote は実行しない", async () => {
  const harness = await startHarness();
  try {
    const issuer = createRouterClient({
      baseUrl: harness.router.baseUrl,
      principalId: ALICE.id,
      token: ALICE.token,
    });
    const quoted = await issuer.quote({ routeId: ROUTE_A, requestId: "stateless-1" });
    expect(quoted.ok).toBe(true);
    if (!quoted.ok) return;
    const offer = (quoted.quote.source as Record<string, unknown>)["offer"];

    // 別 client（quote を発行していない）は既定で拒否される。
    const other = createRouterClient({
      baseUrl: harness.router.baseUrl,
      principalId: ALICE.id,
      token: ALICE.token,
    });
    const refused = await other.execute({
      quote: quoted.quote,
      requestId: "stateless-1",
      approval: { approved: true, quoteId: quoted.quote.quoteId },
      credential: paymentHeader(offer),
    });
    expect(refused.outcome).toBe("resource_mismatch");
    if (refused.outcome === "resource_mismatch") {
      expect(refused.reason).toBe("quote_not_issued_by_client");
    }
    // 拒否された時点で上流課金は起きていない。
    const before = await callsOf(harness.upstreamA);
    expect(before["payCalls"]).toBe(0);

    // opt-in した client なら実行できる（Router 側の束縛は別途効いている）。
    const stateless = createRouterClient({
      baseUrl: harness.router.baseUrl,
      principalId: ALICE.id,
      token: ALICE.token,
      allowUnissuedQuotes: true,
    });
    const allowed = await stateless.execute({
      quote: quoted.quote,
      requestId: "stateless-1",
      approval: { approved: true, quoteId: quoted.quote.quoteId },
      credential: paymentHeader(offer),
    });
    expect(allowed.outcome).toBe("delivered");
  } finally {
    await harness.stopAll();
  }
}, 60_000);
