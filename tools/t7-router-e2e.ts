/**
 * T7: **実 Router プロセス**（`src/main.ts`）を実鍵能力で起動し、R1→R2→R3→R4 を通して
 * Provider A から実データを取得する。**製品コードではない**（実鍵を扱う起動側）。
 *
 * 受信レグ（SubEtha）は合成 facilitator（無課金）。実決済は送信レグ A のみ。
 * 決済スコープは `docs/t7-requirements.md` §2。Router の budget bucket でも上限を強制する。
 *
 * usage: T7_PAYER_PRIVATE_KEY=0x... tsx tools/t7-router-e2e.ts
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { startListening } from "../tests/fixtures/loopback.js";

const ROUTE = "md-a-eth-snapshot";
const UPSTREAM = "https://provider-a.subethalabs.com/v1/eth/snapshot";
const SOURCE_TOKEN = "0x0000000000000000000000000000000000005ce7";
const DEST_ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DEST_PAY_TO = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";
const ALICE = { id: "alice", token: "tok-alice-t7" };

async function main(): Promise<void> {
  if (!process.env["T7_PAYER_PRIVATE_KEY"]) {
    process.stderr.write("T7_PAYER_PRIVATE_KEY is not set\n");
    process.exit(2);
  }
  const work = await mkdtemp(path.join(path.resolve("runtime"), "t7-"));
  const facilitator = await startListening("tests/fixtures/facilitator-server.ts", [
    "--token", SOURCE_TOKEN, "--chain-id", "11155111", "--settle", "ok", "--verify", "ok",
  ]);

  const config = {
    router: {
      approvalTtlMs: 120_000,
      routes: {
        [ROUTE]: {
          routeId: ROUTE,
          canonicalPath: `/v1/routes/${ROUTE}/resource`,
          rail: "x402",
          source: { amount: "1500", asset: SOURCE_TOKEN, decimals: 6, network: "eip155:11155111" },
          destination: { scheme: "exact", network: "eip155:84532", asset: DEST_ASSET, payTo: DEST_PAY_TO },
        },
      },
      // 送金上限を Router 側でも強制する（1 回 10000 / 累計 40000 = 残スコープ）。
      budget: {
        maxPurchases: 4,
        buckets: [
          { network: "eip155:11155111", asset: SOURCE_TOKEN, maxTotal: "100000", maxPerPurchase: "5000" },
          { network: "eip155:84532", asset: DEST_ASSET, maxTotal: "40000", maxPerPurchase: "10000" },
        ],
      },
    },
    x402: { upstreams: { [ROUTE]: UPSTREAM } },
  };
  const configPath = path.join(work, "router.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const router = await startListening("tools/t7-router-process.ts", [], {
    T7_PAYER_PRIVATE_KEY: process.env["T7_PAYER_PRIVATE_KEY"]!,
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_JOURNAL_PATH: path.join(work, "journal.ndjson"),
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
    ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: facilitator.baseUrl,
  });
  process.stdout.write(`startup: ${router.stdout().trim()}\n`);

  const H = { "x-router-principal": ALICE.id, authorization: `Bearer ${ALICE.token}` };
  const quote = (await (
    await fetch(`${router.baseUrl}/v1/quotes`, {
      method: "POST",
      headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ routeId: ROUTE, requestId: "t7-e2e-1" }),
    })
  ).json()) as Record<string, any>;
  process.stdout.write(`R2 quoteId=${quote["quoteId"]} destination=${JSON.stringify(quote["destination"])}\n`);

  const offer = quote["source"].offer;
  const credential = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: offer,
      payload: { challengeNonce: offer.extra.challengeNonce, synthetic: true },
    }),
    "utf8",
  ).toString("base64");

  const r3 = await fetch(`${router.baseUrl}/v1/routes/${ROUTE}/resource`, {
    headers: {
      ...H,
      "x-router-quote-id": quote["quoteId"],
      "x-router-request-id": "t7-e2e-1",
      "x-router-approval": quote["quoteId"],
      "x-payment": credential,
    },
  });
  const body = await r3.text();
  process.stdout.write(`R3 status=${r3.status}\nR3 paymentId=${r3.headers.get("x-router-payment-id")}\n`);
  process.stdout.write(`R3 body=${body.slice(0, 700)}\n`);

  const paymentId = String(quote["paymentId"]);
  const r4 = await fetch(`${router.baseUrl}/v1/purchases/${encodeURIComponent(paymentId)}`, { headers: H });
  process.stdout.write(`R4 status=${r4.status}\nR4 body=${(await r4.text()).slice(0, 700)}\n`);

  await router.stop();
  await facilitator.stop();
}

main().catch((error: unknown) => {
  process.stderr.write(`t7-e2e failed: ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exit(1);
});
