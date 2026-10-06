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

import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createMcpIngress } from "../src/mcp/ingress.js";
import { buildServer, sourceOfRequest } from "../src/mcp/server.js";
import { startListening, type Listening } from "../tests/fixtures/loopback.js";
import { INBOUND, routerConfigOf } from "./remote-mcp-config.js";

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
  const config = routerConfigOf(process.env, receiver, mppInboundEnabled);
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
      // MPP 受信の照合も同じ Tempo の RPC を使う（設定があるとき）。無ければ Router は chain の公開 RPC を使う。
      ...(process.env["SUBETHA_TEMPO_RPC_URL"] === undefined || process.env["SUBETHA_TEMPO_RPC_URL"] === "" ? {} : { ROUTER_MPP_INBOUND_RPC_URL: process.env["SUBETHA_TEMPO_RPC_URL"] }),
      ...(mppInboundEnabled
        ? {
            ROUTER_MPP_INBOUND_SECRET: mppInboundSecret,
            ROUTER_MPP_INBOUND_OFFER_SECONDS: process.env["SUBETHA_OFFER_SECONDS"] ?? "600",
          }
        : {}),
    });
  } catch (error) {
    // 固定文のみ（起動失敗の例外は子プロセスの出力を丸ごと含む）。原因は Router を単体で起動して調べる。
    void error;
    note("could not start the Router");
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

  /**
   * 入口の資源上限（本文 64 KiB・受信 10 秒・同時接続数）は `createMcpIngress` が持つ。
   * 例外の文字列は外にもログにも出さない（固定文のみ）。
   */
  const http = createMcpIngress({
    note,
    handle: async (req: IncomingMessage, res: ServerResponse, body: unknown) => {
      // ステートレス。セッションを跨いで状態を持たない。
      // リモートはステートレス: 呼び出し側が quote を持ち回る（慣行に合わせる）。
      // 送信元は入口が自分で導く（外から来た `x-router-source` は使わない）。
      const mcp = await buildServer({ stateless: true, source: sourceOfRequest(req.headers, req.socket.remoteAddress) });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    },
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

// **このファイルが直接の起動エントリのときだけ**起動する（試験が `routerConfigOf` を import しても起動しない）。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  start().catch(() => {
    // 固定文のみ（例外の文字列は子プロセスの出力や設定の値を含み得る）。
    note("remote MCP failed");
    process.exit(1);
  });
}
