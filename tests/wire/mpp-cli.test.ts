/**
 * 実 main composition 越しの縦貫テスト（T3 / 設計 §10 M6）。
 *
 * 別プロセスで起動した Router に R2（quote）→ R3（購入）→ R4（結果参照）を実 TCP で通す。
 * 受信レールは実 HTTP の facilitator fixture、送信レール B は**公式 mppx**（`Mppx.create` +
 * `tempo.charge`）で loopback fixture と話す。支払い能力は**非署名 spy**（鍵なし・実 RPC なし・
 * 実 broadcast なし）を 1 点だけ注入し、receipt は `synthetic-` ラベル。実決済ではない。
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { startListening, runToExit, type Listening } from "../fixtures/loopback.js";
import { TEMPO_TESTNET_CHAIN_ID } from "../fixtures/mpp-payer-spy.js";

const ROUTE_B = "md-b-eth-snapshot";
const SOURCE_TOKEN = "0x0000000000000000000000000000000000005ce7";
const SOURCE_CHAIN_ID = "11155111";
const SOURCE_NETWORK = `eip155:${SOURCE_CHAIN_ID}`;
const DEST_NETWORK = `eip155:${TEMPO_TESTNET_CHAIN_ID}`;
const DEST_CURRENCY = "0x20c0000000000000000000000000000000000000";
const DEST_RECIPIENT = "0x00000000000000000000000000000000000000b1";
const CANONICAL_BASE_URL = "http://127.0.0.1:8500";
const ALICE = { id: "alice", token: "tok-alice-synthetic" };

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const started: Listening[] = [];

afterEach(async () => {
  while (started.length > 0) {
    await started.pop()?.stop();
  }
});

function principalHeaders(): Record<string, string> {
  return { "x-router-principal": ALICE.id, authorization: `Bearer ${ALICE.token}` };
}

function paymentHeader(offer: unknown): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: offer,
      payload: {
        challengeNonce: (offer as { extra: { challengeNonce: string } }).extra.challengeNonce,
        synthetic: true,
      },
    }),
    "utf8",
  ).toString("base64");
}

interface BHarness {
  router: Listening;
  readonly facilitator: Listening;
  readonly upstream: Listening;
  readonly env: Record<string, string>;
  restartRouter(): Promise<void>;
}

/** レール B だけの実 adapter 構成（`ROUTER_ADAPTER_MODE=real`）で Router を起動する。 */
async function bootB(options: { pay?: string } = {}): Promise<BHarness> {
  await mkdir(runtimeRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(runtimeRoot, "t3-cli-"));
  const configPath = path.join(workDir, "router.config.json");

  const facilitator = await startListening("tests/fixtures/facilitator-server.ts", [
    "--token",
    SOURCE_TOKEN,
    "--chain-id",
    SOURCE_CHAIN_ID,
  ]);
  started.push(facilitator);
  const upstream = await startListening("tests/fixtures/mpp-upstream.ts", [
    "--pay",
    options.pay ?? "ok",
  ]);
  started.push(upstream);

  await writeFile(
    configPath,
    JSON.stringify(
      {
        router: {
          approvalTtlMs: 60_000,
          routes: {
            [ROUTE_B]: {
              routeId: ROUTE_B,
              canonicalPath: `/v1/routes/${ROUTE_B}/resource`,
              // rail 名は routeId → 送信レール解決のための allowlist（core は分岐しない）。
              rail: "mpp",
              source: { amount: "1500", asset: SOURCE_TOKEN, decimals: 6, network: SOURCE_NETWORK },
              destination: {
                scheme: "tempo/charge",
                network: DEST_NETWORK,
                asset: DEST_CURRENCY,
                payTo: DEST_RECIPIENT,
              },
            },
          },
          budget: {
            maxPurchases: 4,
            buckets: [
              { network: SOURCE_NETWORK, asset: SOURCE_TOKEN, maxTotal: "100000", maxPerPurchase: "5000" },
              { network: DEST_NETWORK, asset: DEST_CURRENCY, maxTotal: "100000", maxPerPurchase: "5000" },
            ],
          },
        },
        x402: { upstreams: { [ROUTE_B]: `${upstream.baseUrl}/v1/eth/snapshot` } },
      },
      null,
      2,
    ),
    "utf8",
  );

  const env: Record<string, string> = {
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_JOURNAL_PATH: path.join(workDir, "journal.ndjson"),
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: CANONICAL_BASE_URL,
    ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: facilitator.baseUrl,
  };

  // レール B だけを使う構成なので、注入するのは MPP の支払い能力だけ。
  const router = await startListening("tests/fixtures/router-rails-process.ts", ["--rails", "b"], env);
  started.push(router);

  const harness: BHarness = {
    router,
    facilitator,
    upstream,
    env,
    async restartRouter(): Promise<void> {
      await harness.router.stop();
      harness.router = await startListening(
        "tests/fixtures/router-rails-process.ts",
        ["--rails", "b"],
        env,
      );
      started.push(harness.router);
    },
  };
  return harness;
}

async function payCallsOf(harness: BHarness): Promise<number> {
  const calls = (await (await fetch(`${harness.upstream.baseUrl}/calls`)).json()) as {
    payCalls: number;
  };
  return calls.payCalls;
}

async function quoteOf(harness: BHarness, requestId: string) {
  const response = await fetch(`${harness.router.baseUrl}/v1/quotes`, {
    method: "POST",
    headers: { ...principalHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ routeId: ROUTE_B, requestId }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      paymentId: string;
      quoteId: string;
      source: { offer: unknown };
      destination: Record<string, unknown>;
    },
  };
}

function resourceHeaders(quoteId: string, requestId: string, offer: unknown): Record<string, string> {
  return {
    ...principalHeaders(),
    "x-router-quote-id": quoteId,
    "x-router-request-id": requestId,
    "x-router-approval": quoteId,
    "x-payment": paymentHeader(offer),
  };
}

test("レール B: 実 composition 越しに R2→R3→R4 が通り、再起動後も再購入しない", async () => {
  const harness = await bootB();
  // 起動ログは B の無課金 fixture ラベル（`real` と偽表示しない）。
  expect(harness.router.stdout()).toContain("T3-fixture-nopay");

  const quote = await quoteOf(harness, "req-b-1");
  expect(quote.status).toBe(200);
  expect(quote.body.destination["network"]).toBe(DEST_NETWORK);
  // wire の atomic amount がそのまま quote に出る（二重変換しない）。
  expect(quote.body.destination["quoted"]).toBe("1200");
  expect(JSON.stringify(quote.body)).not.toContain(harness.upstream.baseUrl);

  const delivered = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_B}/resource`, {
    headers: resourceHeaders(quote.body.quoteId, "req-b-1", quote.body.source.offer),
  });
  expect(delivered.status).toBe(200);
  const body = (await delivered.json()) as { providerId: string; data: { price: string } };
  expect(body.providerId).toBe("synthetic-provider-b");
  expect(body.data.price).toBe("3001.45");

  // 受信レグ（verify→settle）が先、送信レグはそのあと 1 回だけ。
  const facilitatorCalls = (await (await fetch(`${harness.facilitator.baseUrl}/calls`)).json()) as {
    verifyCalls: number;
    settleCalls: number;
  };
  expect(facilitatorCalls).toMatchObject({ verifyCalls: 1, settleCalls: 1 });
  const upstreamCalls = (await (await fetch(`${harness.upstream.baseUrl}/calls`)).json()) as {
    payCalls: number;
    seenQueries: string[];
    seenCredentials: Record<string, unknown>[];
  };
  expect(upstreamCalls.payCalls).toBe(1);
  expect(upstreamCalls.seenQueries).toEqual([]);
  // 上流が受けたのは公式 mppx が作った credential。
  expect((upstreamCalls.seenCredentials[0]?.["challenge"] as Record<string, unknown>)["method"]).toBe(
    "tempo",
  );

  const projection = (await (
    await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
      headers: principalHeaders(),
    })
  ).json()) as Record<string, unknown>;
  expect(projection["status"]).toBe("delivered");
  expect(projection["result"]).toEqual(body);
  expect((projection["destination"] as Record<string, unknown>)["outcome"]).toBe("paid");
  expect((projection["destination"] as Record<string, unknown>)["receiptRef"]).toBeTypeOf("string");

  // 再起動しても同じ結果を返し、再購入しない。
  await harness.restartRouter();
  const reopened = await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
    headers: principalHeaders(),
  });
  expect(await reopened.json()).toEqual(projection);
  const sameRequest = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_B}/resource`, {
    headers: resourceHeaders(quote.body.quoteId, "req-b-1", quote.body.source.offer),
  });
  expect(sameRequest.status).toBe(200);
  expect(await payCallsOf(harness)).toBe(1);
  // 別プロセス 3 本の起動と再起動を含むため、既定 5 秒では足りない（有限の余裕を明示する）。
}, 15_000);

test("レール B: 課金後にデータが無い上流は paid_data_unavailable で終端し、再購入しない", async () => {
  const harness = await bootB({ pay: "paid-no-data" });
  const quote = await quoteOf(harness, "req-b-2");

  const response = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE_B}/resource`, {
    headers: resourceHeaders(quote.body.quoteId, "req-b-2", quote.body.source.offer),
  });
  expect(response.status).toBe(502);
  expect(((await response.json()) as Record<string, unknown>)["status"]).toBe(
    "paid_data_unavailable",
  );

  const projection = (await (
    await fetch(`${harness.router.baseUrl}/v1/purchases/${quote.body.paymentId}`, {
      headers: principalHeaders(),
    })
  ).json()) as Record<string, unknown>;
  expect(projection["status"]).toBe("paid_data_unavailable");
  expect(projection["result"]).toBeUndefined();
  const destination = projection["destination"] as Record<string, unknown>;
  // 上流が実際に receipt を返したときだけ receiptRef を持つ。
  expect(destination["receiptRef"]).toBeTypeOf("string");
  expect(await payCallsOf(harness)).toBe(1);
}, 15_000);

test("レール B の経路に支払い能力を注入しない CLI は synthetic に落ちず停止する", async () => {
  const harness = await bootB();
  // A の署名能力だけを注入しても、B 経路の能力が無ければ起動しない。
  const result = await runToExit("tests/fixtures/router-rails-process.ts", ["--rails", "a"], {
    ...harness.env,
    ROUTER_JOURNAL_PATH: `${harness.env["ROUTER_JOURNAL_PATH"]}.a-only`,
  });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("signer_not_authorized");
  expect(result.stdout).not.toContain("listening");
}, 15_000);
