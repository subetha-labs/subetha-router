/**
 * T8 / P4: **x402 受信 → MPP 送信（Provider B）** の縦貫を実チェーンで 1 回通す。
 * **製品コードではない**（実鍵を扱う起動側）。既定の `npm run test` からは呼ばれない。
 *
 * デモの主張そのもの: **x402 しか持っていない payer が、MPP でしか払えない Provider を使える。**
 *
 * - 受信レグ: payer が **Base Sepolia USDC** を x402（EIP-3009）で Router に払う（**実決済**）。
 * - 送信レグ: Router が **Tempo pathUSD** を MPP で provider-mpp に払う（**実決済**、T7 で到達済み）。
 * - 2 レグは独立した支払い。交換もブリッジもしない。
 *
 * スコープをコードで強制し、外れたら**送信前に停止**する。
 *
 * usage: T7_PAYER_PRIVATE_KEY=0x... tsx tools/t8-crossrail-e2e.ts [--dry-run]
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { startListening } from "../tests/fixtures/loopback.js";

const ROUTE = "md-mpp-eth-snapshot";
const UPSTREAM = "https://provider-mpp.subethalabs.com/v1/eth/snapshot";

/** 受信レグ（x402 / Base Sepolia USDC）。 */
const INBOUND = {
  network: "eip155:84532",
  chainId: 84532,
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "10000",
  /** Router の受取先。payer とは別アドレス（自分から自分へ払わない）。 */
  payTo: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405",
  facilitator: "https://www.x402.org/facilitator",
} as const;

/** 送信レグ（MPP / Tempo pathUSD）。 */
const OUTBOUND = {
  network: "eip155:42431",
  asset: "0x20c0000000000000000000000000000000000000",
  payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
  maxAmount: 10_000n,
} as const;

const ALICE = { id: "alice", token: "tok-alice-t8" };

function fail(reason: string): never {
  process.stderr.write(`t8-crossrail: STOPPED: ${reason}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const key = process.env["T7_PAYER_PRIVATE_KEY"];
  if (key === undefined || key === "") fail("T7_PAYER_PRIVATE_KEY is not set");
  const payer = privateKeyToAccount(key as `0x${string}`);
  process.stdout.write(`payer (client): ${payer.address}\n`);
  process.stdout.write(`router receives at: ${INBOUND.payTo}\n`);
  if (getAddress(payer.address) === getAddress(INBOUND.payTo)) {
    fail("payer and router receiver must differ (otherwise it is self-payment)");
  }

  const work = await mkdtemp(path.join(path.resolve("runtime"), "t8-"));
  const config = {
    router: {
      approvalTtlMs: 180_000,
      routes: {
        [ROUTE]: {
          routeId: ROUTE,
          canonicalPath: `/v1/routes/${ROUTE}/resource`,
          rail: "mpp",
          // 受信レールを x402 にする（これが P4 の本体）。
          sourceRail: "x402",
          source: {
            amount: INBOUND.amount,
            asset: INBOUND.asset,
            decimals: 6,
            network: INBOUND.network,
            payTo: INBOUND.payTo,
          },
          destination: {
            scheme: "tempo/charge",
            network: OUTBOUND.network,
            asset: OUTBOUND.asset,
            payTo: OUTBOUND.payTo,
          },
        },
      },
      budget: {
        maxPurchases: 2,
        buckets: [
          // 受信レグ（Base Sepolia USDC）。
          { network: INBOUND.network, asset: INBOUND.asset, maxTotal: "20000", maxPerPurchase: "10000" },
          // 送信レグ（Tempo pathUSD）。
          { network: OUTBOUND.network, asset: OUTBOUND.asset, maxTotal: "20000", maxPerPurchase: "10000" },
        ],
      },
    },
    x402: { upstreams: { [ROUTE]: UPSTREAM } },
  };
  const configPath = path.join(work, "router.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const router = await startListening("tools/t7-router-process.ts", ["--rail", "b"], {
    T7_PAYER_PRIVATE_KEY: key,
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_JOURNAL_PATH: path.join(work, "journal.ndjson"),
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
    ROUTER_PRINCIPAL_TOKENS: `${ALICE.id}:${ALICE.token}`,
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: INBOUND.facilitator,
    ROUTER_X402_INBOUND_FACILITATOR_URL: INBOUND.facilitator,
  });
  process.stdout.write(`startup: ${router.stdout().trim()}\n`);

  const H = { "x-router-principal": ALICE.id, authorization: `Bearer ${ALICE.token}` };
  const quote = (await (
    await fetch(`${router.baseUrl}/v1/quotes`, {
      method: "POST",
      headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ routeId: ROUTE, requestId: "t8-crossrail-1" }),
    })
  ).json()) as Record<string, any>;

  if (quote["quoteId"] === undefined) {
    await router.stop();
    fail(`R2 failed: ${JSON.stringify(quote).slice(0, 300)}`);
  }
  process.stdout.write(`R2 source.rail=${quote["source"].rail} (must be "x402")\n`);
  process.stdout.write(`R2 destination=${JSON.stringify(quote["destination"])}\n`);

  const offer = quote["source"].offer;
  // スコープをコードで強制する（受信レグ）。
  if (offer.network !== INBOUND.network) fail(`inbound network out of scope: ${offer.network}`);
  if (offer.asset.toLowerCase() !== INBOUND.asset.toLowerCase()) fail("inbound asset out of scope");
  if (offer.payTo.toLowerCase() !== INBOUND.payTo.toLowerCase()) fail("inbound payTo out of scope");
  if (BigInt(offer.amount) > 10_000n) fail(`inbound amount exceeds cap: ${offer.amount}`);
  if (BigInt(quote["destination"].quoted) > OUTBOUND.maxAmount) fail("outbound amount exceeds cap");
  process.stdout.write("scope check: OK (both legs within the recorded scope)\n");

  if (dryRun) {
    process.stdout.write("dry-run: stopping before any signature or payment.\n");
    await router.stop();
    return;
  }

  // payer が EIP-3009 の TransferWithAuthorization に署名する（受信レグの支払い）。
  const validBefore = offer.extra.expiresAt;
  const authorization = {
    from: getAddress(payer.address),
    to: getAddress(offer.payTo),
    value: BigInt(offer.amount),
    validAfter: 0n,
    validBefore: BigInt(validBefore),
    // EIP-3009 の nonce は bytes32。Router の challengeNonce をそのまま使う
    // （1 offer = 1 authorization。再利用すると同一 nonce の二重使用になる）。
    nonce: offer.extra.challengeNonce as `0x${string}`,
  };
  // EIP-712 domain は **Router が発行した offer.extra から読む**（勝手に決めない）。
  const signature = await payer.signTypedData({
    domain: {
      name: String(offer.extra.name),
      version: String(offer.extra.version),
      chainId: INBOUND.chainId,
      verifyingContract: getAddress(INBOUND.asset),
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  const credential = {
    x402Version: 2,
    accepted: offer,
    payload: {
      challengeNonce: offer.extra.challengeNonce,
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: "0",
        validBefore: String(validBefore),
        nonce: authorization.nonce,
      },
    },
  };

  const r3 = await fetch(`${router.baseUrl}/v1/routes/${ROUTE}/resource`, {
    headers: {
      ...H,
      "x-router-quote-id": quote["quoteId"],
      "x-router-request-id": "t8-crossrail-1",
      "x-router-approval": quote["quoteId"],
      "x-payment": Buffer.from(JSON.stringify(credential), "utf8").toString("base64"),
    },
  });
  process.stdout.write(`R3 status=${r3.status}\n`);
  process.stdout.write(`R3 body=${(await r3.text()).slice(0, 600)}\n`);

  const r4 = await fetch(
    `${router.baseUrl}/v1/purchases/${encodeURIComponent(String(quote["paymentId"]))}`,
    { headers: H },
  );
  process.stdout.write(`R4 body=${(await r4.text()).slice(0, 800)}\n`);

  await router.stop();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `t8-crossrail failed: ${error instanceof Error ? error.message : "unknown"}\n`,
  );
  process.exit(1);
});
