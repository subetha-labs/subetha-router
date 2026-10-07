/**
 * **審査員向けの 1 コマンド起動**。**製品コードではない**（鍵を扱う側）。
 *
 *   claude mcp add subetha-router \
 *     -e SUBETHA_PAYER_PRIVATE_KEY=0x... \
 *     -- npm run --silent demo:mcp
 *
 * これ 1 つで:
 *   1. Router を**このプロセスの子として 1 つだけ**起動する（実レール構成）
 *   2. その Router に接続する MCP サーバを stdio で立てる
 *   3. 受信レグ（x402 / Base Sepolia USDC）の支払い能力を**コードから注入**する
 *
 * **鍵は審査員のもの。** `src/**` は鍵を持たず env からも読まない設計を維持し、
 * ここ（`tools/`）だけが env を読んで能力として注入する。Router は鍵を保持しない。
 *
 * **Router を 2 つ立てない**: journal は `flock(2)` で排他されるので、
 * 既に別の Router が同じ journal を掴んでいれば**起動に失敗する**（二重購入にならない）。
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { evmChainIdOf } from "../src/config.js";
import { main } from "../src/mcp/server.js";
import { startListening, type Listening } from "../tests/fixtures/loopback.js";
import { createX402Payer } from "./x402-payer.js";

/** デモ経路: x402 で払って、MPP でしか払えない Provider を使う。 */
const ROUTE = "md-mpp-eth-snapshot";
const UPSTREAM = "https://provider-mpp.subethalabs.com/v1/eth/snapshot";
const INBOUND = {
  chainId: 84532,
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "10000",
  facilitator: "https://www.x402.org/facilitator",
} as const;
const OUTBOUND = {
  network: "eip155:42431",
  asset: "0x20c0000000000000000000000000000000000000",
  payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
} as const;

function note(message: string): void {
  // stdout は JSON-RPC 専用。診断は必ず stderr。
  process.stderr.write(`${message}\n`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    note(`${name} is required.`);
    process.exit(2);
  }
  return value;
}

async function start(): Promise<void> {
  // 審査員の鍵。受信レグ（Base Sepolia USDC）を払うのに使う。
  const payerKey = required("SUBETHA_PAYER_PRIVATE_KEY");
  // Router が受け取るアドレス。デモ既定はこちらで用意した使い捨てアドレス。
  const receiver = process.env["SUBETHA_ROUTER_RECEIVER"] ?? "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
  // 送信レグ（Tempo）を払う鍵。既定は受信と同じ鍵（デモでは 1 つで足りる）。
  const outboundKey = process.env["SUBETHA_OUTBOUND_PRIVATE_KEY"] ?? payerKey;

  const payer = createX402Payer(payerKey);
  note(`payer: ${payer.address}`);

  const work = await mkdtemp(path.join(path.resolve("runtime"), "demo-"));
  const config = {
    router: {
      approvalTtlMs: 300_000,
      routes: {
        [ROUTE]: {
          routeId: ROUTE,
          canonicalPath: `/v1/routes/${ROUTE}/resource`,
          rail: "mpp",
          sourceRail: "x402",
          source: {
            amount: INBOUND.amount,
            asset: INBOUND.asset,
            decimals: 6,
            network: INBOUND.network,
            payTo: receiver,
          },
          destination: {
            scheme: "tempo/charge",
            network: OUTBOUND.network,
            asset: OUTBOUND.asset,
            payTo: OUTBOUND.payTo,
          },
        },
      },
      /**
       * 支出上限。**「運営の予算が続く限り使える」**ようにしたいので大きく取るが、
       * **ゼロにはしない**: budget は予算管理だけでなく、
       * 再試行ループ等のバグが暴走したときに**残高が尽きる前に止める**安全機構でもある。
       * 既定は運営の残高（約 10^12 base units）に対して十分小さく、かつ実運用で当たらない値。
       */
      budget: {
        maxPurchases: Number(process.env["SUBETHA_MAX_PURCHASES"] ?? "100000"),
        buckets: [
          {
            network: INBOUND.network,
            asset: INBOUND.asset,
            maxTotal: process.env["SUBETHA_INBOUND_MAX_TOTAL"] ?? "1000000000",
            maxPerPurchase: "10000",
          },
          {
            network: OUTBOUND.network,
            asset: OUTBOUND.asset,
            maxTotal: process.env["SUBETHA_OUTBOUND_MAX_TOTAL"] ?? "1000000000",
            maxPerPurchase: "10000",
          },
        ],
      },
    },
    x402: { upstreams: { [ROUTE]: UPSTREAM } },
  };
  const configPath = path.join(work, "router.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  let router: Listening;
  try {
    router = await startListening("tools/t7-router-process.ts", ["--rail", "b"], {
      T7_PAYER_PRIVATE_KEY: outboundKey,
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_JOURNAL_PATH: path.join(work, "journal.ndjson"),
      ROUTER_HTTP_PORT: "0",
      ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
      ROUTER_PRINCIPAL_TOKENS: "judge:demo-token",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: INBOUND.facilitator,
      ROUTER_X402_INBOUND_FACILITATOR_URL: INBOUND.facilitator,
      // 受信 offer の有効期間。承認期限は min(approvalTtlMs, offerExpiry) で切られるので、
      // 既定の 120 秒だと**人間が承認する運用では先に切れる**（実測で指摘された）。
      ROUTER_X402_INBOUND_OFFER_SECONDS: process.env["SUBETHA_OFFER_SECONDS"] ?? "600",
    });
  } catch (error) {
    note(`could not start the Router: ${error instanceof Error ? error.message : "unknown"}`);
    process.exit(1);
  }

  const listening = router.stdout().trim();
  note(`router: ${listening}`);
  // 証拠ラベルは Router 自身の起動行から読ませる（運用者の自己申告にしない）。
  const evidenceFile = path.join(work, "router-listening.log");
  await writeFile(evidenceFile, listening, "utf8");

  process.env["ROUTER_MCP_BASE_URL"] = router.baseUrl;
  process.env["ROUTER_MCP_PRINCIPAL_ID"] = "judge";
  process.env["ROUTER_MCP_TOKEN"] = "demo-token";
  process.env["ROUTER_MCP_ADAPTER_MODE"] = "real";
  process.env["ROUTER_MCP_EVIDENCE_FILE"] = evidenceFile;

  const stop = (): void => {
    void router.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await main({
    payer: {
      address: payer.address,
      // offer の network から chainId を引く。この payer は **INBOUND の chain にだけ**署名する（能力側の chain の方針。
      // Router の preflight が network の改変を拒むとしても、別 chain で有効な署名を作らない）。
      credentialFor: (offer, network) => {
        const chainId = evmChainIdOf(network);
        if (chainId === undefined || chainId !== INBOUND.chainId) throw new Error("offer is not on the configured inbound chain");
        return payer.credentialFor(offer as never, chainId);
      },
    },
  });
}

start().catch((error: unknown) => {
  note(`subetha-router demo failed: ${error instanceof Error ? error.message : "unknown"}`);
  process.exit(1);
});
