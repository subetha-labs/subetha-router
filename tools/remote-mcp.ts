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
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildServer } from "../src/mcp/server.js";
import { startListening, type Listening } from "../tests/fixtures/loopback.js";

/**
 * 経路 1（既存・変更しない）: **x402 で払って MPP の Provider B に届く**。
 * routeId は既に公開済みなので**改名しない**（審査員の手元の手順が壊れる）。
 */
const ROUTE = "md-mpp-eth-snapshot";
const UPSTREAM = "https://provider-mpp.subethalabs.com/v1/eth/snapshot";

/**
 * 経路 2（新規）: **MPP で払って x402 の Provider A に届く**。逆向きの主張。
 * 送信レグに Base Sepolia USDC が要るので、その鍵が無い構成では**登録しない**。
 */
const ROUTE_MPP_IN = "md-x402-eth-snapshot";
const UPSTREAM_X402 = "https://provider-x402.subethalabs.com/v1/eth/snapshot";

/** x402 受信（Base Sepolia USDC）。 */
const INBOUND = {
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "10000",
  facilitator: "https://www.x402.org/facilitator",
} as const;
/** MPP 受信（Tempo pathUSD）。 */
const INBOUND_MPP = {
  network: "eip155:42431",
  asset: "0x20c0000000000000000000000000000000000000",
  amount: "10000",
} as const;
/** MPP 送信（Provider B）。 */
const OUTBOUND = {
  network: "eip155:42431",
  asset: "0x20c0000000000000000000000000000000000000",
  payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
} as const;
/** x402 送信（Provider A）。 */
const OUTBOUND_X402 = {
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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
  /**
   * MPP 受信を公開するかどうか。**両方そろって初めて有効**:
   * - `SUBETHA_MPP_INBOUND_SECRET`: challenge の HMAC 束縛鍵（32 バイト以上）
   * - `SUBETHA_OUTBOUND_X402_KEY`: x402 送信（Provider A）に払う鍵。**USDC 残高が要る**
   * 片方だけだと起動が fail closed で止まるので、**両方ある時だけ route を足す**。
   */
  const mppInboundSecret = process.env["SUBETHA_MPP_INBOUND_SECRET"] ?? "";
  /**
   * x402 送信の鍵。**既定は送信レグの鍵を流用**する（同じ運営ウォレットが両レグを払う
   * 構成が普通で、env を 2 本に増やす理由がない）。別ウォレットにしたいときだけ上書きする。
   * どちらにせよ **Base Sepolia USDC の残高が要る**。
   */
  const x402OutboundKey = process.env["SUBETHA_OUTBOUND_X402_KEY"] ?? outboundKey;
  const mppInboundEnabled = mppInboundSecret !== "";
  const port = Number(process.env["PORT"] ?? "8787");

  /**
   * 使い捨ての作業領域。**config と証拠ログだけ**を置く（起動ごとに新しくてよい）。
   * journal は**ここに置かない**（下記）。
   */
  const work = await mkdtemp(path.join(path.resolve("runtime"), "remote-"));
  /**
   * journal は**固定パス**。ここを `work` の下に置くと、`mkdtemp` が起動ごとに
   * 別ディレクトリを作るため**再起動のたびに全記録を見失う**（実測: 過去の paymentId が
   * 4 件とも R4 で 404 になった）。Router 自身は fsync 付き write-ahead で再起動に
   * 耐える設計なので、**壊していたのは起動側のパスの与え方だけ**だった。
   *
   * コンテナで動かす場合は、このディレクトリを**ボリュームとして外に出す**こと
   * （`docs/DEPLOY.md`）。出さないとコンテナ作り直しで消える。
   */
  const journalPath =
    process.env["SUBETHA_JOURNAL_PATH"] ?? path.join(path.resolve("runtime"), "journal.ndjson");
  await mkdir(path.dirname(journalPath), { recursive: true });
  const config = {
    router: {
      /**
       * 承認期限。**実効期限は `min(approvalTtlMs, offerExpiry)`** なので、
       * offer 側（既定 600 秒）より短いとこちらが先に切れる。
       * 人間が承認を挟む運用（収録・審査員のデモ）では、読み上げや確認で数分使うため
       * 5 分だと**承認前に失効する**ことが実測で起きた。既定を offer と揃える。
       */
      approvalTtlMs: Number(process.env["SUBETHA_APPROVAL_TTL_SECONDS"] ?? "600") * 1000,
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
        // 逆向きの経路。鍵と秘密がそろっているときだけ公開する。
        ...(mppInboundEnabled
          ? {
              [ROUTE_MPP_IN]: {
                routeId: ROUTE_MPP_IN,
                canonicalPath: `/v1/routes/${ROUTE_MPP_IN}/resource`,
                rail: "x402",
                sourceRail: "mpp",
                source: {
                  amount: INBOUND_MPP.amount,
                  asset: INBOUND_MPP.asset,
                  decimals: 6,
                  network: INBOUND_MPP.network,
                  payTo: receiver,
                },
                destination: {
                  scheme: "exact",
                  network: OUTBOUND_X402.network,
                  asset: OUTBOUND_X402.asset,
                  payTo: OUTBOUND_X402.payTo,
                },
              },
            }
          : {}),
      },
      // 「予算の続く限り」使えるように大きく取るが、暴走時に止まるようゼロにはしない。
      // bucket は (network, asset) 単位。2 経路は同じ 2 組を向きだけ変えて使うので、
      // この 2 本で両方をカバーする（経路ごとに増やす必要はない）。
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
    // 上流の節は rail に関係なく `x402` という名前（`src/config.ts`）。全 route 分が要る。
    x402: {
      upstreams: {
        [ROUTE]: UPSTREAM,
        ...(mppInboundEnabled ? { [ROUTE_MPP_IN]: UPSTREAM_X402 } : {}),
      },
    },
  };
  const configPath = path.join(work, "router.config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  let router: Listening;
  try {
    router = await startListening("tools/remote-router-process.ts", [], {
      // MPP 送信（Provider B）。既存経路。
      SUBETHA_OUTBOUND_MPP_KEY: outboundKey,
      // x402 送信（Provider A）。MPP 受信経路を出すときだけ要る。
      ...(mppInboundEnabled ? { SUBETHA_OUTBOUND_X402_KEY: x402OutboundKey } : {}),
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_JOURNAL_PATH: journalPath,
      ROUTER_HTTP_PORT: "0",
      ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: INBOUND.facilitator,
      ROUTER_X402_INBOUND_FACILITATOR_URL: INBOUND.facilitator,
      // 受信 offer の有効期間。承認期限は min(approvalTtlMs, offerExpiry) で切られるので、
      // 既定の 120 秒だと**人間が承認する運用では先に切れる**（実測で指摘された）。
      ROUTER_X402_INBOUND_OFFER_SECONDS: process.env["SUBETHA_OFFER_SECONDS"] ?? "600",
      ...(mppInboundEnabled
        ? {
            ROUTER_MPP_INBOUND_SECRET: mppInboundSecret,
            ROUTER_MPP_INBOUND_OFFER_SECONDS: process.env["SUBETHA_OFFER_SECONDS"] ?? "600",
          }
        : {}),
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
