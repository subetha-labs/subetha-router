/**
 * T9: **MCP 経由の実決済**を通す検証。**製品コードではない。**
 *
 * 審査員の体験と同じ形:
 *   Claude Code 相当の MCP クライアント ──stdio──> Router の MCP サーバ
 *     ──HTTP(R1-R4)──> 稼働中の Router ──MPP──> provider-mpp
 * 受信レグは **x402 / Base Sepolia USDC の実決済**。
 *
 * usage: T7_PAYER_PRIVATE_KEY=0x... tsx tools/t9-mcp-e2e.ts [--dry-run]
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { startListening } from "../tests/fixtures/loopback.js";

const ROUTE = "md-mpp-eth-snapshot";
const UPSTREAM = "https://provider-mpp.subethalabs.com/v1/eth/snapshot";
const INBOUND = {
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405",
  facilitator: "https://www.x402.org/facilitator",
} as const;
const OUTBOUND = {
  network: "eip155:42431",
  asset: "0x20c0000000000000000000000000000000000000",
  payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
} as const;
const ALICE = { id: "alice", token: "tok-alice-t9" };

function env(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const v = process.env[k];
    if (v !== undefined) base[k] = v;
  }
  return { ...base, ...extra };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const key = process.env["T7_PAYER_PRIVATE_KEY"];
  if (key === undefined || key === "") {
    process.stderr.write("T7_PAYER_PRIVATE_KEY is not set\n");
    process.exit(2);
  }

  const work = await mkdtemp(path.join(path.resolve("runtime"), "t9-"));
  const config = {
    router: {
      approvalTtlMs: 180_000,
      routes: {
        [ROUTE]: {
          routeId: ROUTE,
          canonicalPath: `/v1/routes/${ROUTE}/resource`,
          rail: "mpp",
          sourceRail: "x402",
          source: {
            amount: "10000",
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
          { network: INBOUND.network, asset: INBOUND.asset, maxTotal: "20000", maxPerPurchase: "10000" },
          { network: OUTBOUND.network, asset: OUTBOUND.asset, maxTotal: "20000", maxPerPurchase: "10000" },
        ],
      },
    },
    x402: { upstreams: { [ROUTE]: UPSTREAM } },
  };
  const configPath = path.join(work, "router.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  // 1) Router を起動（MCP サーバは Router を起動しない）。
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
  const listening = router.stdout().trim();
  process.stdout.write(`router: ${listening}\n`);

  // 2) 証拠ラベルは Router 自身の起動行から読ませる（自己申告にしない）。
  const evidenceFile = path.join(work, "router-listening.log");
  await writeFile(evidenceFile, listening, "utf8");

  // 3) MCP サーバを実クライアントから起動して叩く。
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["--no-install", "tsx", "tools/t9-mcp-real.ts"],
    env: env({
      T9_MCP_PAYER_PRIVATE_KEY: key,
      T9_INBOUND_CHAIN_ID: "84532",
      ROUTER_MCP_BASE_URL: router.baseUrl,
      ROUTER_MCP_PRINCIPAL_ID: ALICE.id,
      ROUTER_MCP_TOKEN: ALICE.token,
      ROUTER_MCP_ADAPTER_MODE: "real",
      ROUTER_MCP_EVIDENCE_FILE: evidenceFile,
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "t9-verify", version: "0.1.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  process.stdout.write(`tools: ${tools.tools.map((t) => t.name).join(", ")}\n`);

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      structuredContent?: Record<string, unknown>;
    };
    return r.structuredContent ?? {};
  };

  const quoted = await call("subetha_router_quote", {
    routeId: ROUTE,
    requestId: "t9-mcp-1",
  });
  process.stdout.write(`quote ok=${String(quoted["ok"])}\n`);
  const subject = quoted["subject"] as Record<string, unknown> | undefined;
  if (subject === undefined) {
    process.stdout.write(`quote body=${JSON.stringify(quoted).slice(0, 400)}\n`);
    await client.close();
    await router.stop();
    process.exit(1);
  }
  process.stdout.write(`approval subject=${JSON.stringify(subject)}\n`);
  process.stdout.write(`evidence=${JSON.stringify(quoted["evidence"])}\n`);

  if (dryRun) {
    process.stdout.write("dry-run: stopping before purchase.\n");
    await client.close();
    await router.stop();
    return;
  }

  // 4) 人間が承認した体で purchase（approval に quoteId を渡す）。
  const bought = await call("subetha_router_purchase", {
    quoteId: subject["quoteId"],
    requestId: "t9-mcp-1",
    approval: subject["quoteId"],
  });
  process.stdout.write(`purchase outcome=${String(bought["outcome"])}\n`);
  process.stdout.write(`purchase body=${JSON.stringify(bought).slice(0, 500)}\n`);

  const status = await call("subetha_router_status", {
    paymentId: String(bought["paymentId"] ?? subject["paymentId"]),
  });
  process.stdout.write(`status=${JSON.stringify(status).slice(0, 700)}\n`);

  await client.close();
  await router.stop();
}

main().catch((error: unknown) => {
  process.stderr.write(`t9-mcp-e2e failed: ${error instanceof Error ? error.message : "unknown"}\n`);
  process.exit(1);
});
