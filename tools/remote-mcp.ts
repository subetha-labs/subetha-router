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

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createMcpIngress } from "../src/mcp/ingress.js";
import { buildServer, sourceOfRequest } from "../src/mcp/server.js";
import { startListening, type Listening } from "../tests/fixtures/loopback.js";
import { INBOUND, RAILS_ACTIVATION, routerConfigOf, type RailsActivation, MAINNET_FIRST_ROUTE, mainnetFirstRouteConfigOf, RAILS_NONE } from "./remote-mcp-config.js";
import { railsChildEnvOf, railsOptionsOf } from "./rails-entry.js";

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

export class HostPlanError extends Error {
  readonly code: "env" | "rails" | "config";
  constructor(code: "env" | "rails" | "config") {
    super(code === "env" ? "a required env is missing" : code === "rails" ? "rails receivers could not be derived" : "router config could not be generated");
    this.name = "HostPlanError";
    this.code = code;
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new HostPlanError("env");
  }
  return value;
}

/** ホストの起動の選択肢。公開の入口と受け入れ用の起動（`tools/rails-acceptance-run.ts`）が同じ関数を使う。 */
export interface HostOptions {
  /** 多レールの有効化。公開の入口は定数 `RAILS_ACTIVATION`（G-4 で両方 true）。受け入れ用の起動は `--rails` で渡す。 */
  readonly activation: RailsActivation;
  /** MCP の入口を bind するアドレス（公開は 0.0.0.0、受け入れは 127.0.0.1）。 */
  readonly bind: string;
  readonly port: number;
  /** journal の固定パス（受け入れ用の起動は公開のものと別にする）。 */
  readonly journalPath: string;
  /**
   * mainnet の最初の 1 経路（`docs/mainnet-first-route.md`）: owner の Mac で loopback 限定で起動する mainnet 専用の生成。
   * 指定すると公開の生成は使わず `mainnetFirstRouteConfigOf` の設定と mainnet 用の env になる。公開の入口は渡さない。
   */
  readonly mainnetFirstRoute?: { readonly cid: string };
}

/** 起動の計画（純粋。process に触らない）: Router に渡す設定と、子プロセスの env（`ROUTER_CONFIG_PATH` は起動側が足す）。 */
export interface HostPlan {
  readonly config: Record<string, unknown>;
  readonly childEnv: Readonly<Record<string, string>>;
  readonly journalPath: string;
}

export interface RunningHost {
  readonly mcpPort: number;
  /** 実際に bind したアドレス（`http.address()`）。 */
  readonly mcpAddress: string;
  readonly routerPort: number;
  readonly journalPath: string;
  stop(): void;
}

/** 公開の入口の journal の既定（受け入れ用の起動はこれと別のパスでなければならない）。 */
export function publicJournalPathOf(env: Readonly<Record<string, string | undefined>>): string {
  return env["SUBETHA_JOURNAL_PATH"] ?? path.join(path.resolve("runtime"), "journal.ndjson");
}

/**
 * 起動の計画を作る（純粋関数。試験で確かめる）。**1 つの値 `options.activation`** が、設定生成（`routerConfigOf`）と子プロセスの
 * 能力の env（`railsChildEnvOf` → `SUBETHA_RAILS_ACTIVATION`）の両方を決める。無効なら受取鍵・受取 owner・RPC の env は読まない。
 */
export function hostPlanOf(options: HostOptions, env: Readonly<Record<string, string | undefined>>): HostPlan {
  // 送信レグ（Provider への支払い）は運営の資金。受信レグの鍵はここには無い。
  const outboundKey = required(env, "SUBETHA_OUTBOUND_PRIVATE_KEY");
  const receiver = required(env, "SUBETHA_ROUTER_RECEIVER");
  if (options.mainnetFirstRoute !== undefined) {
    if (options.bind !== "127.0.0.1") throw new HostPlanError("config");
    let config: Record<string, unknown>;
    try {
      config = mainnetFirstRouteConfigOf(env, receiver, options.mainnetFirstRoute.cid);
    } catch {
      throw new HostPlanError("config");
    }
    const childEnv: Record<string, string> = {
      SUBETHA_OUTBOUND_MPP_KEY: outboundKey,
      ROUTER_JOURNAL_PATH: options.journalPath,
      ROUTER_HTTP_PORT: "0",
      ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: INBOUND.facilitator,
      ROUTER_X402_INBOUND_FACILITATOR_URL: INBOUND.facilitator,
      ROUTER_X402_INBOUND_OFFER_SECONDS: env["SUBETHA_OFFER_SECONDS"] ?? "600",
      // Tempo mainnet の能力（`tools/rails-entry.ts` が chain id と RPC を読む）。MPP 受信は無いので `ROUTER_MPP_INBOUND_RPC_URL` は渡さない。
      SUBETHA_TEMPO_CHAIN_ID: String(MAINNET_FIRST_ROUTE.chainId),
      SUBETHA_TEMPO_RPC_URL: env["SUBETHA_TEMPO_MAINNET_RPC_URL"] === undefined || env["SUBETHA_TEMPO_MAINNET_RPC_URL"] === "" ? MAINNET_FIRST_ROUTE.rpcUrl : env["SUBETHA_TEMPO_MAINNET_RPC_URL"],
      ...railsChildEnvOf(RAILS_NONE, env),
    };
    return { config, childEnv, journalPath: options.journalPath };
  }
  let rails;
  try {
    rails = railsOptionsOf(options.activation, env);
  } catch {
    throw new HostPlanError("rails");
  }
  /**
   * MPP 受信を公開するかどうか。**両方そろって初めて有効**:
   * - `SUBETHA_MPP_INBOUND_SECRET`: challenge の HMAC 束縛鍵（32 バイト以上）
   * - `SUBETHA_OUTBOUND_X402_KEY`: x402 送信（Provider A）に払う鍵。**USDC 残高が要る**
   * 片方だけだと起動が fail closed で止まるので、**両方ある時だけ route を足す**。
   */
  const mppInboundSecret = env["SUBETHA_MPP_INBOUND_SECRET"] ?? "";
  /**
   * Solana の MPP 受信（`docs/mpp-solana-design.md` §6.2）は Tempo と同じ HMAC の秘密を使う。**Tempo の MPP 受信が無効でも要る**ので、
   * `solanaMpp.inbound` で秘密が無ければ計画を作らない（子の Router が `ROUTER_MPP_INBOUND_SECRET is required` で止まるより前に、固定文で止める）。
   */
  if (options.activation.solanaMpp.inbound && mppInboundSecret === "") {
    throw new HostPlanError("env");
  }
  /**
   * x402 送信の鍵。**既定は送信レグの鍵を流用**する（同じ運営ウォレットが両レグを払う
   * 構成が普通で、env を 2 本に増やす理由がない）。別ウォレットにしたいときだけ上書きする。
   * どちらにせよ **Base Sepolia USDC の残高が要る**。
   */
  const x402OutboundKey = env["SUBETHA_OUTBOUND_X402_KEY"] ?? outboundKey;
  const mppInboundEnabled = mppInboundSecret !== "";
  const journalPath = options.journalPath;
  let config: Record<string, unknown>;
  try {
    config = routerConfigOf(env, receiver, mppInboundEnabled, rails);
  } catch {
    throw new HostPlanError("config");
  }
  /**
   * x402 送信の鍵が要るか: **生成した設定に x402 の送信（route かプロファイル）があるとき**（送信の設計 §6.2）。
   * 以前は MPP 受信のときだけ渡していて、Arc／Solana 受信 → Base 送信の動的プロファイルに漏れていた（U5 で修正）。
   */
  const needsX402Key = hasX402Outbound(config);
  const childEnv: Record<string, string> = {
      // MPP 送信（Provider B）。既存経路。
      SUBETHA_OUTBOUND_MPP_KEY: outboundKey,
      // x402 送信（Provider A・Arc）。生成した設定が x402 の送信を持つときだけ渡す。
      ...(needsX402Key ? { SUBETHA_OUTBOUND_X402_KEY: x402OutboundKey } : {}),
      ROUTER_JOURNAL_PATH: journalPath,
      ROUTER_HTTP_PORT: "0",
      ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: INBOUND.facilitator,
      // `SUBETHA_X402_INBOUND_FACILITATOR_URL` は受け入れ用（PayAI の settle を Base Sepolia で確かめる。`docs/mainnet-first-route.md` FR-M6）。公開の起動では設定しない。
      ROUTER_X402_INBOUND_FACILITATOR_URL: env["SUBETHA_X402_INBOUND_FACILITATOR_URL"] === undefined || env["SUBETHA_X402_INBOUND_FACILITATOR_URL"] === "" ? INBOUND.facilitator : env["SUBETHA_X402_INBOUND_FACILITATOR_URL"],
      // 受信 offer の有効期間。承認期限は min(approvalTtlMs, offerExpiry) で切られるので、
      // 既定の 120 秒だと**人間が承認する運用では先に切れる**（実測で指摘された）。
      ROUTER_X402_INBOUND_OFFER_SECONDS: env["SUBETHA_OFFER_SECONDS"] ?? "600",
      /**
       * Tempo の RPC（設定があるとき）。子プロセスの env は allowlist 方式（`startListening`）なので、**ここで明示的に渡さないと届かない**。
       * 送信（`tools/remote-router-process.ts` が `SUBETHA_TEMPO_RPC_URL` を読む）と受信の照合（`ROUTER_MPP_INBOUND_RPC_URL`）の両方に同じ値を渡す。
       * 以前は渡していなかったので、設定していても送信は公開 RPC を使っていた（T15 のレビューで発見）。
       */
      ...(env["SUBETHA_TEMPO_RPC_URL"] === undefined || env["SUBETHA_TEMPO_RPC_URL"] === ""
        ? {}
        : { SUBETHA_TEMPO_RPC_URL: env["SUBETHA_TEMPO_RPC_URL"], ROUTER_MPP_INBOUND_RPC_URL: env["SUBETHA_TEMPO_RPC_URL"] }),
      // MPP 受信の秘密: Tempo の MPP 受信か Solana の MPP 受信があるとき（設計 §6.2。上の検査で `solanaMpp.inbound` なら秘密は空でない）。
      ...(mppInboundEnabled || options.activation.solanaMpp.inbound
        ? {
            ROUTER_MPP_INBOUND_SECRET: mppInboundSecret,
            ROUTER_MPP_INBOUND_OFFER_SECONDS: env["SUBETHA_OFFER_SECONDS"] ?? "600",
          }
        : {}),
      // 多レール: 有効化の値と、有効なレールの受取鍵・RPC だけ（`tools/rails-entry.ts`）。
      ...railsChildEnvOf(options.activation, env),
  };
  return { config, childEnv, journalPath };
}

/** 生成した設定に x402 の送信（静的 route の `rail`、動的プロファイルの `rail`）があるか。純粋関数（試験で確かめる）。 */
export function hasX402Outbound(config: Record<string, unknown>): boolean {
  const router = (config["router"] ?? {}) as { routes?: Record<string, { rail?: string }>; dynamic?: { profiles?: Record<string, { rail?: string }> } };
  const routes = Object.values(router.routes ?? {});
  const profiles = Object.values(router.dynamic?.profiles ?? {});
  return [...routes, ...profiles].some((entry) => (entry.rail ?? "x402") === "x402");
}

/** MCP の入口を bind する。実際のアドレスと port を返す（試験で bind を確かめる）。 */
export function listenMcp(http: Server, bind: string, port: number): Promise<{ address: string; port: number }> {
  return new Promise((resolve) => {
    http.listen(port, bind, () => {
      const address = http.address();
      resolve(typeof address === "object" && address !== null ? { address: address.address, port: address.port } : { address: bind, port });
    });
  });
}

export async function startHost(options: HostOptions): Promise<RunningHost> {
  let plan: HostPlan;
  try {
    plan = hostPlanOf(options, process.env);
  } catch (error) {
    // 固定文のみ（理由の code で選ぶ。値は出さない）。
    const code = error instanceof HostPlanError ? error.code : undefined;
    note(code === "env" ? "SUBETHA_OUTBOUND_PRIVATE_KEY and SUBETHA_ROUTER_RECEIVER are required." : code === "rails" ? "rails receivers could not be derived (check SUBETHA_ARC_RECEIVER_KEY / SUBETHA_SOLANA_RECEIVER)" : "router config could not be generated (check the rails receivers)");
    process.exit(2);
  }

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
  const journalPath = plan.journalPath;
  await mkdir(path.dirname(journalPath), { recursive: true });
  const configPath = path.join(work, "router.config.json");
  await writeFile(configPath, JSON.stringify(plan.config, null, 2), "utf8");

  let router: Listening;
  try {
    // 起動待ちは 120 秒: 子の Router は listen の前に Solana の起動時の検査（`/supported`・ATA、各 10 秒まで）、MPP 送信のプロファイルごとの Tempo の probe（各 6 秒まで、最大 3 本）、
    // journal の replay を行う。上限に達すると子は殺され、入口は固定文で止まる。
    router = await startListening("tools/remote-router-process.ts", [], { ...plan.childEnv, ROUTER_CONFIG_PATH: configPath }, { listenTimeoutMs: 120_000 });
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
      // SDK 1.32 の型は `exactOptionalPropertyTypes` と合わない（試験と同じ扱い）。値は変えない。
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport as never);
      await transport.handleRequest(req, res, body);
    },
  });

  const stop = (): void => {
    http.close();
    void router.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const bound = await listenMcp(http, options.bind, options.port);
  note(`subetha-router remote MCP on ${bound.address}:${bound.port}/mcp (inbound payer: the caller's own key)`);
  return { mcpPort: bound.port, mcpAddress: bound.address, routerPort: router.port, journalPath, stop };
}

/** 公開の入口: 多レールは定数 `RAILS_ACTIVATION`（G-4 で両方 true）、0.0.0.0、`PORT`（既定 8787）、journal は固定パス。 */
async function start(): Promise<void> {
  // mainnet の最初の 1 経路（`docs/mainnet-first-route.md`）: env に CID があれば loopback 限定・mainnet 専用で起動する。公開の起動とは排他。
  const mainnetCid = process.env["SUBETHA_MAINNET_FIRST_ROUTE_CID"];
  if (mainnetCid !== undefined && mainnetCid !== "") {
    await startHost({
      activation: RAILS_NONE,
      bind: "127.0.0.1",
      port: Number(process.env["PORT"] ?? "8787"),
      journalPath: process.env["SUBETHA_MAINNET_JOURNAL_PATH"] ?? path.join(path.resolve("runtime"), "mainnet-first-route.ndjson"),
      mainnetFirstRoute: { cid: mainnetCid },
    });
    return;
  }
  await startHost({
    activation: RAILS_ACTIVATION,
    bind: "0.0.0.0",
    port: Number(process.env["PORT"] ?? "8787"),
    journalPath: publicJournalPathOf(process.env),
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
