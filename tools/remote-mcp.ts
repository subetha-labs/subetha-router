/**
 * **リモート MCP サーバ**（Streamable HTTP）。**製品コードではない**（鍵を扱う側）。
 *
 *   claude mcp add --transport http subetha-router https://router.subethalabs.com/mcp
 *
 * 審査員は clone も鍵の用意も不要。**支払いは審査員自身が行う**:
 *   審査員 ──①x402 で Router に払う──> Router ──②MPP で Provider に払う──> Provider
 * ①の署名は**審査員の手元**で作られ、Router には署名済み credential だけが届く。
 * **Router は審査員の鍵を持たない**（`src/**` に秘密鍵の参照は 0 件）。
 *
 * ②の送信レグは**運営の資金**。budget で上限を掛ける（ゼロにはしない＝暴走時に止めるため）。
 *
 * 認証は掛けない（誰でも quote を取れる）。**払わなければデータは返らない**ので、
 * タダ乗りはできない。quote 発行だけは無料なので、濫用対策は上限と rate limit に委ねる。
 *
 * usage: SUBETHA_OUTBOUND_PRIVATE_KEY=0x... PORT=8787 tsx tools/remote-mcp.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildServer } from "../src/mcp/server.js";
import { startListening, type Listening } from "../tests/fixtures/loopback.js";

const ROUTE = "md-mpp-eth-snapshot";
const UPSTREAM = "https://provider-mpp.subethalabs.com/v1/eth/snapshot";
const INBOUND = {
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
  // 送信レグ（Provider への支払い）は運営の資金。受信レグの鍵はここには無い。
  const outboundKey = required("SUBETHA_OUTBOUND_PRIVATE_KEY");
  const receiver = required("SUBETHA_ROUTER_RECEIVER");
  const port = Number(process.env["PORT"] ?? "8787");

  const work = await mkdtemp(path.join(path.resolve("runtime"), "remote-"));
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
      // 「予算の続く限り」使えるように大きく取るが、暴走時に止まるようゼロにはしない。
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
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
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

  const evidenceFile = path.join(work, "router-listening.log");
  await writeFile(evidenceFile, listening, "utf8");

  process.env["ROUTER_MCP_BASE_URL"] = router.baseUrl;
  process.env["ROUTER_MCP_PRINCIPAL_ID"] = "judge";
  process.env["ROUTER_MCP_TOKEN"] = "public";
  process.env["ROUTER_MCP_ADAPTER_MODE"] = "real";
  process.env["ROUTER_MCP_EVIDENCE_FILE"] = evidenceFile;

  // **payer は注入しない。** 受信レグは審査員が自分の鍵で払う（Router は鍵を持たない）。
  // ステートレス運用なので **要求ごとに server と transport を作る**
  // （1 つの `McpServer` は同時に複数 transport へ connect できない）。

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", router: "up" }));
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      // ステートレス。セッションを跨いで状態を持たない。
      // リモートはステートレス: 呼び出し側が quote を持ち回る（慣行に合わせる）。
      const mcp = await buildServer({ stateless: true });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: unknown;
      try {
        body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = undefined;
      }
      await transport.handleRequest(req, res, body);
    })().catch((error: unknown) => {
      note(`request failed: ${error instanceof Error ? error.message : "unknown"}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    });
  });

  const stop = (): void => {
    http.close();
    void router.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  http.listen(port, "0.0.0.0", () => {
    note(`subetha-router remote MCP on :${port}/mcp (inbound payer: the caller's own key)`);
  });
}

start().catch((error: unknown) => {
  note(`remote MCP failed: ${error instanceof Error ? error.message : "unknown"}`);
  process.exit(1);
});
