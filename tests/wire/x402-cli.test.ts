/**
 * 実 main composition（`ROUTER_ADAPTER_MODE=real`）越しの縦貫テスト（T2 / 設計 §10 M4・M5）。
 *
 * 別プロセスで起動した Router に、テストプロセスから実 TCP で R2（quote）→ R3（購入）→
 * R4（結果参照）を通す。受信レールは実 HTTP の facilitator fixture、送信レールは**公式
 * x402 SDK**（`@x402/fetch` + `@x402/evm`）で v2 wire を話す loopback fixture。
 * 署名能力は**非署名 spy**を 1 点だけ注入し、鍵・実署名・実決済・有料 API は使わない。
 * ラベルは `T2-fixture-nopay`。
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { startListening, runToExit, type Listening } from "../fixtures/loopback.js";

const ROUTE = "md-a-eth-snapshot";
const SOURCE_TOKEN = "0x0000000000000000000000000000000000005ce7";
const SOURCE_CHAIN_ID = "11155111";
const SOURCE_NETWORK = `eip155:${SOURCE_CHAIN_ID}`;
const DEST_NETWORK = "eip155:84532";
const DEST_ASSET = "0x000000000000000000000000000000000000de57";
const DEST_PAY_TO = "0x0000000000000000000000000000000000000a11";
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
  const credential = {
    x402Version: 2,
    accepted: offer,
    payload: {
      challengeNonce: (offer as { extra: { challengeNonce: string } }).extra.challengeNonce,
      synthetic: true,
    },
  };
  return Buffer.from(JSON.stringify(credential), "utf8").toString("base64");
}

interface RealHarness {
  readonly router: Listening;
  readonly facilitator: Listening;
  readonly upstream: Listening;
  readonly configPath: string;
  readonly env: Record<string, string>;
}

/** 実 adapter モードの構成ファイルと env を書き、fixture 2 本 + Router を起動する。 */
async function bootReal(
  options: { pay?: string; routerScript?: string; withCapability?: boolean } = {},
): Promise<RealHarness> {
  await mkdir(runtimeRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(runtimeRoot, "t2-cli-"));
  const configPath = path.join(workDir, "router.config.json");

  const facilitator = await startListening("tests/fixtures/facilitator-server.ts", [
    "--token",
    SOURCE_TOKEN,
    "--chain-id",
    SOURCE_CHAIN_ID,
  ]);
  started.push(facilitator);
  const upstream = await startListening("tests/fixtures/x402-upstream.ts", [
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
            [ROUTE]: {
              routeId: ROUTE,
              canonicalPath: `/v1/routes/${ROUTE}/resource`,
              rail: "x402",
              source: { amount: "1500", asset: SOURCE_TOKEN, decimals: 6, network: SOURCE_NETWORK },
              destination: {
                scheme: "exact",
                network: DEST_NETWORK,
                asset: DEST_ASSET,
                payTo: DEST_PAY_TO,
              },
            },
          },
          budget: {
            maxPurchases: 4,
            buckets: [
              { network: SOURCE_NETWORK, asset: SOURCE_TOKEN, maxTotal: "100000", maxPerPurchase: "5000" },
              { network: DEST_NETWORK, asset: DEST_ASSET, maxTotal: "100000", maxPerPurchase: "5000" },
            ],
          },
        },
        // 実レール（差し替え可能な設定値のみ。鍵も署名能力も書かない）。
        x402: { upstreams: { [ROUTE]: `${upstream.baseUrl}/v1/eth/snapshot` } },
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
    // 既定（real）。合成レールへは落とさない。
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: facilitator.baseUrl,
  };

  const router = await startListening(
    options.routerScript ?? "tests/fixtures/router-x402-process.ts",
    [],
    env,
  );
  started.push(router);
  return { router, facilitator, upstream, configPath, env };
}

test("実 real composition 越しに R2→R3→R4 が通り、送信レグは公式 SDK の v2 wire を使う", async () => {
  const harness = await bootReal();

  // 起動ログは無課金 fixture ラベルで、実決済を主張しない。
  expect(harness.router.stdout()).toContain("T2-fixture-nopay");
  expect(harness.router.stdout()).toContain('"mode":"real"');

  const quoteResponse = await fetch(`${harness.router.baseUrl}/v1/quotes`, {
    method: "POST",
    headers: { ...principalHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ routeId: ROUTE, requestId: "req-1" }),
  });
  expect(quoteResponse.status).toBe(200);
  const quote = (await quoteResponse.json()) as {
    paymentId: string;
    quoteId: string;
    source: { offer: unknown };
    destination: Record<string, unknown>;
  };
  // 上流 URL は公開しない。
  expect(JSON.stringify(quote)).not.toContain(harness.upstream.baseUrl);
  expect(quote.destination["quoted"]).toBe("900");
  expect(quote.destination["network"]).toBe(DEST_NETWORK);

  const delivered = await fetch(`${harness.router.baseUrl}/v1/routes/${ROUTE}/resource`, {
    headers: {
      ...principalHeaders(),
      "x-router-request-id": "req-1",
      "x-router-quote-id": quote.quoteId,
      "x-router-approval": quote.quoteId,
      "x-payment": paymentHeader(quote.source.offer),
    },
  });
  expect(delivered.status).toBe(200);
  const body = (await delivered.json()) as { data: { price: string } };
  expect(body.data.price).toBe("3000.12");

  // 受信レグ（source）→ 送信レグ（destination）の順で、それぞれ 1 回だけ。
  const facilitatorCalls = (await (await fetch(`${harness.facilitator.baseUrl}/calls`)).json()) as {
    verifyCalls: number;
    settleCalls: number;
  };
  expect(facilitatorCalls).toMatchObject({ verifyCalls: 1, settleCalls: 1 });
  const upstreamCalls = (await (await fetch(`${harness.upstream.baseUrl}/calls`)).json()) as {
    payCalls: number;
    seenQueries: string[];
    seenPayments: Record<string, unknown>[];
  };
  expect(upstreamCalls.payCalls).toBe(1);
  expect(upstreamCalls.seenQueries).toEqual([]);
  // 上流が受けたのは公式 SDK が作った v2 payload（`accepted` は承認済み offer）。
  expect(upstreamCalls.seenPayments[0]?.["x402Version"]).toBe(2);
  expect(upstreamCalls.seenPayments[0]?.["accepted"]).toMatchObject({
    amount: "900",
    asset: DEST_ASSET,
    payTo: DEST_PAY_TO,
  });

  const projectionResponse = await fetch(
    `${harness.router.baseUrl}/v1/purchases/${quote.paymentId}`,
    { headers: principalHeaders() },
  );
  expect(projectionResponse.status).toBe(200);
  const projection = (await projectionResponse.json()) as Record<string, unknown>;
  expect(projection["status"]).toBe("delivered");
  expect(projection["result"]).toEqual(body);
  const destination = projection["destination"] as Record<string, unknown>;
  expect(destination["outcome"]).toBe("paid");
  expect(destination["txRef"]).toMatch(/^synthetic-dst-/);
});

test("署名能力を注入しない既定 CLI は synthetic に落ちず signer_not_authorized で停止する", async () => {
  // fixture 2 本と構成だけ作り、Router は素の CLI（能力注入なし）で起動を試す。
  const harness = await bootReal();
  const result = await runToExit("src/main.ts", [], {
    ...harness.env,
    ROUTER_JOURNAL_PATH: `${harness.env["ROUTER_JOURNAL_PATH"]}.cli`,
  });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("signer_not_authorized");
  // 合成レールへは落ちない。
  expect(result.stdout).not.toContain("listening");
});
