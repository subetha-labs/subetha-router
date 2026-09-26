/**
 * P5: **MPP 受信 → x402 送信（Provider A）** の縦貫を 1 回通す。**製品コードではない。**
 *
 * これは T8（x402 受信 → MPP 送信）の**逆向き**で、行列の未検証セルを埋める。
 * 主張は対称: **MPP しか持っていない payer が、x402 でしか払えない Provider を使える。**
 *
 * - 受信レグ: payer が **Tempo pathUSD** を MPP で Router に払う。
 *   **payer 自身が broadcast する**ので、この時点で実際に金が動く。
 * - 送信レグ: Router が **Base Sepolia USDC** を x402 で provider-x402 に払う。
 *   facilitator が送信・gas 負担。
 * - 2 レグは独立。交換もブリッジもしない。
 *
 * **既定は dry-run**（scope 検査まで実行して、送金前に止まる）。
 * 実決済は `--settle` を明示したときだけ。
 *
 * usage:
 *   P5_INBOUND_PAYER_KEY=0x...  # MPP で Router に払う側（pathUSD が要る）
 *   P5_ROUTER_KEY=0x...         # Router が Provider A に払う側（Base Sepolia USDC が要る）
 *   tsx tools/p5-mpp-to-x402-e2e.ts [--settle]
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { privateKeyToAccount } from "viem/accounts";

import { startListening } from "../tests/fixtures/loopback.js";
import { createMppPayer, TEMPO_MODERATO_CHAIN_ID } from "./mpp-payer.js";

const ROUTE = "md-x402-eth-snapshot";
const UPSTREAM = "https://provider-x402.subethalabs.com/v1/eth/snapshot";

/** 受信レグ（MPP / Tempo pathUSD）。Router が受け取る。 */
const INBOUND = {
  network: `eip155:${TEMPO_MODERATO_CHAIN_ID}`,
  chainId: TEMPO_MODERATO_CHAIN_ID,
  asset: "0x20c0000000000000000000000000000000000000",
  amount: "10000",
  /** Router の受取先。payer とは別アドレスでなければならない。 */
  payTo: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2",
} as const;

/** 送信レグ（x402 / Base Sepolia USDC）。Provider A が受け取る。 */
const OUTBOUND = {
  network: "eip155:84532",
  chainId: 84532,
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
  maxAmount: 10_000n,
} as const;

const ALICE = { id: "alice", token: "tok-alice-p5" };

function fail(reason: string): never {
  process.stderr.write(`p5-mpp-to-x402: STOPPED: ${reason}\n`);
  process.exit(2);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") fail(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const settle = process.argv.includes("--settle");
  const inboundKey = required("P5_INBOUND_PAYER_KEY");
  const routerKey = required("P5_ROUTER_KEY");

  const payer = createMppPayer(inboundKey, {
    chainId: INBOUND.chainId,
    asset: INBOUND.asset,
    payTo: INBOUND.payTo,
    maxAmount: 10_000n,
  });
  const routerAccount = privateKeyToAccount(routerKey as `0x${string}`);

  process.stdout.write(`inbound payer (pays Router in pathUSD): ${payer.address}\n`);
  process.stdout.write(`Router receives at                    : ${INBOUND.payTo}\n`);
  process.stdout.write(`Router pays Provider A from           : ${routerAccount.address}\n`);
  process.stdout.write(`Provider A receives at                : ${OUTBOUND.payTo}\n`);

  if (payer.address.toLowerCase() === INBOUND.payTo.toLowerCase()) {
    fail("inbound payer and Router receiver must differ (self-payment)");
  }

  const work = await mkdtemp(path.join(path.resolve("runtime"), "p5-"));
  const config = {
    router: {
      approvalTtlMs: 180_000,
      routes: {
        [ROUTE]: {
          routeId: ROUTE,
          canonicalPath: `/v1/routes/${ROUTE}/resource`,
          // 送信レール A（x402 / Provider A）。
          rail: "x402",
          // **受信レールを MPP にする。これが P5 の本体。**
          sourceRail: "mpp",
          source: {
            amount: INBOUND.amount,
            asset: INBOUND.asset,
            decimals: 6,
            network: INBOUND.network,
            payTo: INBOUND.payTo,
          },
          destination: {
            scheme: "exact",
            network: OUTBOUND.network,
            asset: OUTBOUND.asset,
            payTo: OUTBOUND.payTo,
          },
        },
      },
      budget: {
        maxPurchases: 2,
        buckets: [
          { network: INBOUND.network, asset: INBOUND.asset, maxTotal: "20000", maxPerPurchase: "10000" },
          { network: OUTBOUND.network, asset: OUTBOUND.asset, maxTotal: "20000", maxPerPurchase: "10000" },
        ],
      },
    },
    x402: { upstreams: { [ROUTE]: UPSTREAM } },
  };
  const configPath = path.join(work, "router.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  // `--rail a` = x402 送信の署名能力を実鍵で注入する。受信レグの鍵は Router に渡さない。
  const router = await startListening("tools/t7-router-process.ts", ["--rail", "a"], {
    T7_PAYER_PRIVATE_KEY: routerKey,
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_JOURNAL_PATH: path.join(work, "journal.ndjson"),
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
    ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
    ROUTER_ADAPTER_MODE: "real",
    // SubEtha 受信は使わないが、real 構成の必須項目なので loopback を渡す。
    ROUTER_SUBETHA_FACILITATOR_URL: "http://127.0.0.1:1",
    ROUTER_MPP_INBOUND_SECRET: required("P5_MPP_INBOUND_SECRET"),
    ROUTER_MPP_INBOUND_OFFER_SECONDS: "600",
  });
  process.stdout.write(`startup: ${router.stdout().trim()}\n`);

  const H = { "x-router-principal": ALICE.id, authorization: `Bearer ${ALICE.token}` };
  // R2 と R3 で**同じ値**を使う（変えると別の購入になる）。
  const requestId = `p5-mpp-x402-${Date.now()}`;
  const quote = (await (
    await fetch(`${router.baseUrl}/v1/quotes`, {
      method: "POST",
      headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ routeId: ROUTE, requestId }),
    })
  ).json()) as Record<string, any>;

  if (quote["quoteId"] === undefined) {
    await router.stop();
    fail(`R2 failed: ${JSON.stringify(quote).slice(0, 400)}`);
  }
  process.stdout.write(`R2 source.rail=${quote["source"].rail} (must be "mpp")\n`);
  process.stdout.write(`R2 destination=${JSON.stringify(quote["destination"])}\n`);

  const offer = quote["source"].offer;
  // 受信レグの scope をコードで強制する（送金前）。
  if (quote["source"].rail !== "mpp") fail(`inbound rail is not mpp: ${quote["source"].rail}`);
  if (offer.network !== INBOUND.network) fail(`inbound network out of scope: ${offer.network}`);
  if (offer.asset.toLowerCase() !== INBOUND.asset.toLowerCase()) fail("inbound asset out of scope");
  if (offer.payTo.toLowerCase() !== INBOUND.payTo.toLowerCase()) fail("inbound payTo out of scope");
  if (BigInt(offer.amount) > 10_000n) fail(`inbound amount exceeds cap: ${offer.amount}`);
  if (BigInt(quote["destination"].quoted) > OUTBOUND.maxAmount) fail("outbound amount exceeds cap");
  process.stdout.write("scope check: OK (both legs within the recorded scope)\n");

  if (!settle) {
    process.stdout.write(
      "dry-run: stopping before any payment. Pass --settle to move real funds.\n",
    );
    await router.stop();
    return;
  }

  // ---- ここから金が動く。受信レグは payer 自身が broadcast する。 ----
  process.stdout.write("paying the inbound leg on Tempo (the payer broadcasts)...\n");
  let credential: string;
  let inboundTx: string;
  try {
    const paid = await payer.payAndCredential(offer);
    credential = paid.credential;
    inboundTx = paid.txRef;
  } catch (error) {
    await router.stop();
    fail(`inbound payment failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
  process.stdout.write(`inbound tx: ${inboundTx}\n`);

  // R3 は **GET /v1/routes/{routeId}/resource**。quoteId・承認・支払いはヘッダで渡す
  // （`POST /v1/purchases` は存在しない。R4 が `GET /v1/purchases/{paymentId}`）。
  const r3 = await fetch(`${router.baseUrl}/v1/routes/${ROUTE}/resource`, {
    headers: {
      ...H,
      "x-router-quote-id": quote["quoteId"],
      "x-router-request-id": requestId,
      "x-router-approval": quote["quoteId"],
      // Router の封筒に mppx credential を入れる（`app.ts:80-94` が要求する形）。
      // `payload.credential` が MPP adapter の読み取り口（`mpp.ts:250`）。
      "x-payment": Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepted: offer,
          payload: { challengeNonce: offer.extra.challengeNonce, credential },
        }),
        "utf8",
      ).toString("base64"),
    },
  });
  const purchase = (await r3.json()) as Record<string, any>;
  process.stdout.write(`R3 status=${r3.status}\n`);
  process.stdout.write(`R3 body: ${JSON.stringify(purchase).slice(0, 300)}\n`);

  // R3 は成功時に **上流のデータそのもの**を 200 で返す（`status` 欄は無い）。
  // 成否は HTTP ステータスで判定する。
  if (r3.status !== 200) {
    fail(
      `R3 failed with ${r3.status}. ` +
        `**受信レグは送金済み** — inbound tx ${inboundTx} をチェーンで確認すること。`,
    );
  }
  // R4 で確定状態と両レグの tx を読む（保存 → 再オープン相当）。
  const paymentId = String(quote["paymentId"]);
  const r4 = await fetch(`${router.baseUrl}/v1/purchases/${paymentId}`, { headers: H });
  const status = (await r4.json()) as Record<string, any>;
  process.stdout.write(`R4: ${JSON.stringify(status).slice(0, 500)}\n`);
  if (status["status"] !== "delivered") {
    fail(`R4 says ${String(status["status"])} (inbound tx ${inboundTx})`);
  }
  await router.stop();
  process.stdout.write("DELIVERED: MPP inbound -> x402 outbound completed.\n");
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "unknown error");
});
