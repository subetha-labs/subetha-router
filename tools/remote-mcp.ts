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
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createIngressDrain, createMcpIngress } from "../src/mcp/ingress.js";
import { DRAIN_TIMEOUT_MS } from "../src/shared/drain.js";
import { buildServer, sourceOfRequest } from "../src/mcp/server.js";
import { startListening, type Listening } from "../tests/fixtures/loopback.js";
import { diagnosticsChildEnvOf } from "./router-diagnostics.js";
import { INBOUND, RAILS_ACTIVATION, routerConfigOf, type RailsActivation, MAINNET_FIRST_ROUTE, mainnetFirstRouteConfigOf, RAILS_NONE, EVM_CHAINS_ENV, EVM_FACILITATOR_URL_ENV, EVM_PROVIDER_PAYTO_ENV, EVM_TESTNET_CHAINS, EVM_TESTNETS, evmOf, evmProviderUrlEnvOf, evmTestnetsConfigOf, HOSTED_EVM_CHAINS, type EvmTestnetChain, type HostedEvmChain, EVM_MATRIX_ACTIVATION } from "./remote-mcp-config.js";
import { railsChildEnvOf, railsOptionsOf, railsProvidersOf, railsReceiversOf } from "./rails-entry.js";

function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

export class HostPlanError extends Error {
  readonly code: "env" | "rails" | "config" | "evm_facilitator";
  constructor(code: "env" | "rails" | "config" | "evm_facilitator") {
    super(code === "env" ? "a required env is missing" : code === "rails" ? "rails receivers could not be derived" : code === "evm_facilitator" ? "the EVM facilitator env is incomplete" : "router config could not be generated");
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
  readonly mainnetFirstRoute?: true;
  /**
   * EVM testnet 4 つ（`docs/evm-testnets-x402-design.md` §3.5）: 専用の入口（`tools/evm-testnets-run.ts`）だけが渡す。loopback 限定・専用の設定生成
   * `evmTestnetsConfigOf`・専用の子 process（`tools/evm-testnets-router-process.ts`。`localCounterparties` を渡すのはこの子だけ）。公開の入口は渡さない。
   */
  readonly evmTestnets?: {
    readonly chains: readonly EvmTestnetChain[];
    /**
     * 掛け合わせの検証（設計 §8）: 30 の `mx-*` route を足し、既存レール（Arc・Solana x402・Solana MPP・Tempo MPP）の受信・送信の能力の env を子に渡す。
     * 無ければ今までと同じ計画（設定・子の env とも不変）。
     */
    readonly matrix?: true;
  };
  /**
   * 自前の EVM facilitator の port（hosted 設計 §4。既定 `EVM_FACILITATOR_PORT` = 8611。コンテナの publish・Caddy の宛先と同じ）。
   * **試験だけ**が渡す（固定の 8611 は並列の試験で衝突する）。本番の入口（`start`・`tools/rails-acceptance-run.ts`）は渡さない（静的検査で固定する）。
   */
  readonly evmFacilitatorPortForTest?: number;
}

/** 公開の子 process（既定の plan）。 */
export const PUBLIC_ROUTER_PROCESS = "tools/remote-router-process.ts";
/** EVM testnet の専用の子 process。 */
export const EVM_TESTNETS_ROUTER_PROCESS = "tools/evm-testnets-router-process.ts";

/** 自前の EVM facilitator の子 process（hosted 設計 §0・§4）。 */
export const EVM_FACILITATOR_PROCESS = "tools/evm-facilitator.ts";
/** facilitator の port（コンテナの中。`deploy/swap-image.sh` が host の `127.0.0.1:8611` に publish し、Caddy がそこへ流す）。 */
export const EVM_FACILITATOR_PORT = 8611;
/** `tools/evm-facilitator.ts` の `TOKEN_PATTERN` と同じ形（Router の子の `evmFacilitatorOriginOf` も同じ形だけを受ける）。 */
const EVM_FACILITATOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
/** 本番の env（root 所有 600 の env ファイル）の名前。facilitator の子にだけ、`EVM_FACILITATOR_*` の名前に写して渡す。 */
export const EVM_FACILITATOR_HOST_ENV = Object.freeze({
  key: "SUBETHA_EVM_FACILITATOR_KEY",
  token: "SUBETHA_EVM_FACILITATOR_TOKEN",
  log: "SUBETHA_EVM_FACILITATOR_LOG",
  gasCapPrefix: "SUBETHA_EVM_FACILITATOR_GAS_CAP_",
  rpcPrefix: "SUBETHA_EVM_FACILITATOR_RPC_",
});

/** facilitator の子の計画（純粋）。`url` は Router の子に渡す `http://127.0.0.1:<port>/<token>`（token を含むので出力しない）。 */
export interface EvmFacilitatorPlan {
  readonly script: string;
  readonly env: Readonly<Record<string, string>>;
  readonly port: number;
  readonly url: string;
  /** 有効な chain（受信か送信）の network。`/supported` にすべて載っていなければ Router の子を起動しない。 */
  readonly networks: readonly string[];
}

/** 起動の計画（純粋。process に触らない）: Router に渡す設定と、子プロセスの env（`ROUTER_CONFIG_PATH` は起動側が足す）。 */
export interface HostPlan {
  readonly config: Record<string, unknown>;
  readonly childEnv: Readonly<Record<string, string>>;
  readonly journalPath: string;
  /** 起動する子 process の script（repo の相対パス）。既定は公開の子 `tools/remote-router-process.ts`。 */
  readonly childScript: string;
  /** EVM testnet 3 つのどれか（受信か送信）が有効なときだけ: Router の子より先に起動する facilitator の子（hosted 設計 §4）。 */
  readonly facilitator?: EvmFacilitatorPlan;
}

export interface RunningHost {
  readonly mcpPort: number;
  /** 実際に bind したアドレス（`http.address()`）。 */
  readonly mcpAddress: string;
  readonly routerPort: number;
  readonly journalPath: string;
  /** facilitator の子の port（起動したときだけ）。 */
  readonly facilitatorPort?: number;
  stop(): void;
}

/** 公開の入口の journal の既定（受け入れ用の起動はこれと別のパスでなければならない）。 */
export function publicJournalPathOf(env: Readonly<Record<string, string | undefined>>): string {
  return env["SUBETHA_JOURNAL_PATH"] ?? path.join(path.resolve("runtime"), "journal.ndjson");
}

/**
 * 自前の EVM facilitator の journal（hosted 設計 §2.3・§4）: **公開の journal のディレクトリ**の下の `evm-facilitator/journal.ndjson`（lock はその隣の
 * `facilitator.lock`）。公開の入口と受け入れ用の起動で **同じ 1 つ**（受け入れの Router の journal は別のパスのまま。facilitator は gas 鍵の状態なので分けない）。
 * コンテナでは `/app/runtime/evm-facilitator/journal.ndjson`（ボリューム）。
 */
export function evmFacilitatorJournalPathOf(env: Readonly<Record<string, string | undefined>>): string {
  return path.join(path.dirname(publicJournalPathOf(env)), "evm-facilitator", "journal.ndjson");
}

/**
 * 自前の EVM facilitator の診断の記録（設計 `docs/rejection-reasons-design.md` §2.1、タスク R-5）: journal と同じディレクトリの
 * `diagnostics.ndjson`（コンテナでは `/app/runtime/evm-facilitator/diagnostics.ndjson`）。公開と受け入れで同じ 1 つ（facilitator は 1 つ、lock で同時に 1 つ）。
 * 本番の env の `SUBETHA_DIAGNOSTICS=off` なら `undefined`（facilitator の子に path を渡さない = 記録しない）。
 */
export function evmFacilitatorDiagnosticsPathOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env["SUBETHA_DIAGNOSTICS"] === "off") return undefined;
  return path.join(path.dirname(evmFacilitatorJournalPathOf(env)), "diagnostics.ndjson");
}

/** 有効な（受信か送信の）EVM testnet。 */
function evmUsedChainsOf(activation: RailsActivation): readonly HostedEvmChain[] {
  const evm = evmOf(activation);
  return HOSTED_EVM_CHAINS.filter((chain) => evm[chain].inbound || evm[chain].outbound);
}

/**
 * facilitator の子の計画（hosted 設計 §4）。子の env は allowlist: 本番の env の `SUBETHA_EVM_FACILITATOR_*` を `EVM_FACILITATOR_*` に写したものと、
 * 計画が決める bind・port・network・payTo の allowlist（Router の受取先と新 3 の Provider の受取先）・journal だけ。
 * 必須の env（gas 鍵・token・有効な chain ごとの gas の上限・Provider の受取先）が無い・token の形が違えば `HostPlanError("evm_facilitator")`（値は出さない）。
 * bind は入口と同じ（公開の入口は `0.0.0.0` = コンテナの中で publish に届く。受け入れの起動はその bind: コンテナの外の既定 `127.0.0.1` では facilitator も loopback だけ）。
 */
function evmFacilitatorPlanOf(options: HostOptions, env: Readonly<Record<string, string | undefined>>, receiver: string, chains: readonly HostedEvmChain[]): EvmFacilitatorPlan {
  const present = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") throw new HostPlanError("evm_facilitator");
    return value;
  };
  const key = present(EVM_FACILITATOR_HOST_ENV.key);
  const token = present(EVM_FACILITATOR_HOST_ENV.token);
  if (!EVM_FACILITATOR_TOKEN_PATTERN.test(token)) throw new HostPlanError("evm_facilitator");
  const providerPayTo = present(EVM_PROVIDER_PAYTO_ENV);
  const port = options.evmFacilitatorPortForTest ?? EVM_FACILITATOR_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new HostPlanError("evm_facilitator");
  const networks = chains.map((chain) => EVM_TESTNETS[chain].network);
  const perChain: Record<string, string> = {};
  for (const network of networks) {
    const chainId = network.slice("eip155:".length);
    perChain[`EVM_FACILITATOR_GAS_CAP_${chainId}`] = present(`${EVM_FACILITATOR_HOST_ENV.gasCapPrefix}${chainId}`);
    const rpc = env[`${EVM_FACILITATOR_HOST_ENV.rpcPrefix}${chainId}`];
    if (rpc !== undefined && rpc !== "") perChain[`EVM_FACILITATOR_RPC_${chainId}`] = rpc;
  }
  const log = env[EVM_FACILITATOR_HOST_ENV.log];
  const diagnostics = evmFacilitatorDiagnosticsPathOf(env);
  return {
    script: EVM_FACILITATOR_PROCESS,
    port,
    url: `http://127.0.0.1:${port}/${token}`,
    networks,
    env: {
      EVM_FACILITATOR_KEY: key,
      EVM_FACILITATOR_TOKEN: token,
      EVM_FACILITATOR_BIND: options.bind,
      EVM_FACILITATOR_PORT: String(port),
      EVM_FACILITATOR_NETWORKS: networks.join(","),
      EVM_FACILITATOR_PAYTO_ALLOWLIST: [receiver, providerPayTo].join(","),
      ...perChain,
      EVM_FACILITATOR_JOURNAL: evmFacilitatorJournalPathOf(env),
      ...(log === undefined || log === "" ? {} : { EVM_FACILITATOR_LOG: log }),
      ...(diagnostics === undefined ? {} : { EVM_FACILITATOR_DIAGNOSTICS: diagnostics }),
    },
  };
}

/**
 * 起動の計画を作る（純粋関数。試験で確かめる）。**1 つの値 `options.activation`** が、設定生成（`routerConfigOf`）と子プロセスの
 * 能力の env（`railsChildEnvOf` → `SUBETHA_RAILS_ACTIVATION`）の両方を決める。無効なら受取鍵・受取 owner・RPC の env は読まない。
 */
export function hostPlanOf(options: HostOptions, env: Readonly<Record<string, string | undefined>>): HostPlan {
  // 送信レグ（Provider への支払い）は運営の資金。受信レグの鍵はここには無い。
  const outboundKey = required(env, "SUBETHA_OUTBOUND_PRIVATE_KEY");
  const receiver = required(env, "SUBETHA_ROUTER_RECEIVER");
  if (options.evmTestnets !== undefined) {
    return options.evmTestnets.matrix === true ? evmMatrixPlanOf(options, env, outboundKey, receiver, options.evmTestnets.chains) : evmTestnetsPlanOf(options, env, outboundKey, receiver, options.evmTestnets.chains);
  }
  if (options.mainnetFirstRoute !== undefined) {
    if (options.bind !== "127.0.0.1") throw new HostPlanError("config");
    // MPP 受信（Tempo mainnet）には challenge の HMAC の秘密が要る（公開の起動と同じ env）。
    const mainnetSecret = env["SUBETHA_MPP_INBOUND_SECRET"] ?? "";
    if (mainnetSecret === "") throw new HostPlanError("env");
    let config: Record<string, unknown>;
    try {
      config = mainnetFirstRouteConfigOf(env, receiver);
    } catch {
      throw new HostPlanError("config");
    }
    const mainnetRpc = env["SUBETHA_TEMPO_MAINNET_RPC_URL"] === undefined || env["SUBETHA_TEMPO_MAINNET_RPC_URL"] === "" ? MAINNET_FIRST_ROUTE.tempoRpcUrl : env["SUBETHA_TEMPO_MAINNET_RPC_URL"];
    const childEnv: Record<string, string> = {
      // x402 送信（Base mainnet）の鍵だけ。MPP 送信は無いので `SUBETHA_OUTBOUND_MPP_KEY` は渡さない。
      SUBETHA_OUTBOUND_X402_KEY: env["SUBETHA_OUTBOUND_X402_KEY"] ?? outboundKey,
      SUBETHA_X402_OUTBOUND_NETWORK: MAINNET_FIRST_ROUTE.outbound.network,
      ROUTER_JOURNAL_PATH: options.journalPath,
      ROUTER_HTTP_PORT: "0",
      ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: INBOUND.facilitator,
      // MPP 受信（Tempo mainnet）: 秘密、照合の RPC、offer の有効期間。
      ROUTER_MPP_INBOUND_SECRET: mainnetSecret,
      ROUTER_MPP_INBOUND_OFFER_SECONDS: env["SUBETHA_OFFER_SECONDS"] ?? "600",
      ROUTER_MPP_INBOUND_RPC_URL: mainnetRpc,
      ...railsChildEnvOf(RAILS_NONE, env),
    };
    return { config, childEnv, journalPath: options.journalPath, childScript: PUBLIC_ROUTER_PROCESS };
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
  /**
   * EVM testnet 3 つ（hosted 設計 §4）: どれかが有効なら facilitator の子を計画し、その URL（`http://127.0.0.1:<port>/<token>`）を設定生成と Router の子に渡す。
   * 親の env の `SUBETHA_EVM_FACILITATOR_URL` は使わない（URL は計画が token と port から作る）。全部無効なら env も計画も今と同じ。
   */
  const evmChains = evmUsedChainsOf(options.activation);
  const facilitator = evmChains.length === 0 ? undefined : evmFacilitatorPlanOf(options, env, receiver, evmChains);
  const configEnv = facilitator === undefined ? env : { ...env, [EVM_FACILITATOR_URL_ENV]: facilitator.url };
  let config: Record<string, unknown>;
  try {
    config = routerConfigOf(configEnv, receiver, mppInboundEnabled, rails);
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
      ROUTER_X402_INBOUND_FACILITATOR_URL: INBOUND.facilitator,
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
      // 自前の facilitator の URL と token だけ（gas 鍵は渡さない。hosted 設計 §4）。子はこの origin だけで `localCounterparties` を作る。
      ...(facilitator === undefined ? {} : { [EVM_FACILITATOR_URL_ENV]: facilitator.url }),
      // 診断の記録のファイル（`docs/rejection-reasons-design.md` §2.1、タスク R-2）: journal の隣。`SUBETHA_DIAGNOSTICS=off` なら足さない。
      ...diagnosticsChildEnvOf(journalPath, env),
  };
  return { config, childEnv, journalPath, childScript: PUBLIC_ROUTER_PROCESS, ...(facilitator === undefined ? {} : { facilitator }) };
}

/**
 * EVM testnet の計画（設計 §3.5）。mainnet の 1 経路と同じ形: loopback の bind だけ、専用の設定生成、子の env は allowlist（x402 の送信の鍵・
 * Base Sepolia の受信の facilitator（x402.org）・real mode が要る SubEtha の facilitator の URL・EVM の facilitator と Provider の URL・Provider の受取先・chain）。
 * MPP の鍵・秘密・多レールの鍵は渡さない（有効化は空）。
 */
function evmTestnetsPlanOf(options: HostOptions, env: Readonly<Record<string, string | undefined>>, outboundKey: string, receiver: string, chains: readonly EvmTestnetChain[]): HostPlan {
  if (options.bind !== "127.0.0.1" || options.mainnetFirstRoute !== undefined) throw new HostPlanError("config");
  if (chains.length === 0 || chains.some((chain) => !EVM_TESTNET_CHAINS.includes(chain))) throw new HostPlanError("config");
  let config: Record<string, unknown>;
  try {
    config = evmTestnetsConfigOf(env, receiver, chains);
  } catch {
    throw new HostPlanError("config");
  }
  // 上の生成が値の存在を確かめている（空なら例外）。
  const evmEnv: Record<string, string> = {
    [EVM_FACILITATOR_URL_ENV]: env[EVM_FACILITATOR_URL_ENV] as string,
    [EVM_PROVIDER_PAYTO_ENV]: env[EVM_PROVIDER_PAYTO_ENV] as string,
    [EVM_CHAINS_ENV]: chains.join(","),
    ...Object.fromEntries(chains.map((chain) => [evmProviderUrlEnvOf(chain), env[evmProviderUrlEnvOf(chain)] as string])),
  };
  const childEnv: Record<string, string> = {
    // x402 の送信（Base Sepolia の Provider A と C の Provider。同じ鍵。D-11）。MPP の送信は無いので `SUBETHA_OUTBOUND_MPP_KEY` は渡さない。
    SUBETHA_OUTBOUND_X402_KEY: env["SUBETHA_OUTBOUND_X402_KEY"] ?? outboundKey,
    ROUTER_JOURNAL_PATH: options.journalPath,
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
    ROUTER_PRINCIPAL_TOKENS: "judge:public",
    ROUTER_ADAPTER_MODE: "real",
    // real mode は SubEtha の facilitator の URL を要求する（SubEtha の route は無い）。Base Sepolia の受信は x402.org（既存）。
    ROUTER_SUBETHA_FACILITATOR_URL: INBOUND.facilitator,
    ROUTER_X402_INBOUND_FACILITATOR_URL: INBOUND.facilitator,
    ROUTER_X402_INBOUND_OFFER_SECONDS: env["SUBETHA_OFFER_SECONDS"] ?? "600",
    ...evmEnv,
    ...railsChildEnvOf(RAILS_NONE, env),
  };
  return { config, childEnv, journalPath: options.journalPath, childScript: EVM_TESTNETS_ROUTER_PROCESS };
}

/**
 * 掛け合わせの検証の計画（設計 §8.3-2・§8.5 #6）。`evmTestnetsPlanOf` の子の env に、行列の既存レールが要るものだけを足す:
 * - 有効化 `EVM_MATRIX_ACTIVATION`（Arc・Solana x402・Solana MPP の受信と送信）を `railsChildEnvOf` で: 内部の `SUBETHA_RAILS_ACTIVATION`、Arc の受取鍵（Circle の売り手証明。
 *   address は設定の `source.payTo` と同じ鍵から導くので、配線の照合と一致する）、Solana の RPC、Solana の送信鍵
 * - MPP 受信（Tempo・Solana）の秘密と offer の有効期間、Tempo の RPC（あれば）
 * - Tempo MPP の送信（Provider B）の鍵 `SUBETHA_OUTBOUND_MPP_KEY`（既定は送信レグの鍵 = T8。公開の分岐と同じ規則）
 * hosted の Provider の受取先（`SUBETHA_ARC_PROVIDER_PAYTO`・`SUBETHA_SOLANA_PROVIDER_PAYTO`・`SUBETHA_SOLANA_MPP_PROVIDER_PAYTO`）は設定の生成だけが読む（子には渡さない）。
 * `localCounterparties` は今のまま（子が facilitator と新 3 の Provider の URL から作る）。
 */
function evmMatrixPlanOf(options: HostOptions, env: Readonly<Record<string, string | undefined>>, outboundKey: string, receiver: string, chains: readonly EvmTestnetChain[]): HostPlan {
  const activation = EVM_MATRIX_ACTIVATION;
  const secret = env["SUBETHA_MPP_INBOUND_SECRET"] ?? "";
  if (secret === "") throw new HostPlanError("env");
  let receivers;
  let providers;
  try {
    receivers = railsReceiversOf(activation, env);
    providers = railsProvidersOf(activation, env);
  } catch {
    throw new HostPlanError("rails");
  }
  let config: Record<string, unknown>;
  try {
    config = evmTestnetsConfigOf(env, receiver, chains, { matrix: true, receivers, providers });
  } catch {
    throw new HostPlanError("config");
  }
  // 非行列の計画（同じ検査・同じ env）の上に足す。設定は行列のものに置き換える。
  const basePlan = evmTestnetsPlanOf(options, env, outboundKey, receiver, chains);
  const tempoRpc = env["SUBETHA_TEMPO_RPC_URL"];
  const childEnv: Record<string, string> = {
    ...basePlan.childEnv,
    SUBETHA_OUTBOUND_MPP_KEY: env["SUBETHA_OUTBOUND_MPP_KEY"] ?? outboundKey,
    ROUTER_MPP_INBOUND_SECRET: secret,
    ROUTER_MPP_INBOUND_OFFER_SECONDS: env["SUBETHA_OFFER_SECONDS"] ?? "600",
    ...(tempoRpc === undefined || tempoRpc === "" ? {} : { SUBETHA_TEMPO_RPC_URL: tempoRpc, ROUTER_MPP_INBOUND_RPC_URL: tempoRpc }),
    ...railsChildEnvOf(activation, env),
  };
  return { config, childEnv, journalPath: options.journalPath, childScript: EVM_TESTNETS_ROUTER_PROCESS };
}

/** 生成した設定に x402 の送信（静的 route の `rail`、動的プロファイルの `rail`）があるか。純粋関数（試験で確かめる）。 */
export function hasX402Outbound(config: Record<string, unknown>): boolean {
  const router = (config["router"] ?? {}) as { routes?: Record<string, { rail?: string }>; dynamic?: { profiles?: Record<string, { rail?: string }> } };
  const routes = Object.values(router.routes ?? {});
  const profiles = Object.values(router.dynamic?.profiles ?? {});
  return [...routes, ...profiles].some((entry) => (entry.rail ?? "x402") === "x402");
}

/** `/supported` の応答の上限（バイト）と期限。 */
const SUPPORTED_MAX_BYTES = 64 * 1024;
const SUPPORTED_TIMEOUT_MS = 10_000;
/** facilitator の listening の行を待つ上限（起動時に chain ごとの RPC で chain id を確かめ、journal を照合する）。 */
const FACILITATOR_LISTEN_TIMEOUT_MS = 60_000;

/** drain の上限（`src/shared/drain.ts`。入口と Router の子で同じ値）。 */
export { DRAIN_TIMEOUT_MS } from "../src/shared/drain.js";

/**
 * facilitator の `/<token>/supported` を loopback で 1 回読み、`networks` が全部（x402 v2・`exact`）載っているか（hosted 設計 §4）。
 * 失敗（接続・期限・redirect・200 以外・大きすぎる・JSON でない・欠け）はすべて `false`（理由・値は返さない）。
 */
export async function facilitatorSupportsAll(url: string, networks: readonly string[], fetchImpl: typeof fetch = fetch, cancel?: AbortSignal): Promise<boolean> {
  try {
    // 期限と、入口の取り消し（signal・子の終了）のどちらでも止まる。
    const timeout = AbortSignal.timeout(SUPPORTED_TIMEOUT_MS);
    const response = await fetchImpl(`${url}/supported`, { method: "GET", redirect: "error", signal: cancel === undefined ? timeout : AbortSignal.any([timeout, cancel]) });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return false;
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > SUPPORTED_MAX_BYTES) return false;
    const body = JSON.parse(text) as { kinds?: unknown };
    if (!Array.isArray(body.kinds)) return false;
    const listed = new Set(
      body.kinds
        .filter((kind): kind is { x402Version: unknown; scheme: unknown; network: unknown } => typeof kind === "object" && kind !== null)
        .filter((kind) => kind.x402Version === 2 && kind.scheme === "exact" && typeof kind.network === "string")
        .map((kind) => kind.network as string),
    );
    return networks.length > 0 && networks.every((network) => listed.has(network));
  } catch {
    return false;
  }
}

/** MCP の入口を bind する。実際のアドレスと port を返す（試験で bind を確かめる）。 */
export function listenMcp(http: Server, bind: string, port: number): Promise<{ address: string; port: number }> {
  return new Promise((resolve, reject) => {
    // bind の失敗（port の使用中など）は reject（未処理の 'error' で process を落とさない。入口は片付けてから終わる）。
    const onError = (error: Error): void => reject(error);
    http.once("error", onError);
    http.listen(port, bind, () => {
      http.off("error", onError);
      const address = http.address();
      resolve(typeof address === "object" && address !== null ? { address: address.address, port: address.port } : { address: bind, port });
    });
  });
}

/**
 * `overrides`（`childScriptForTest`・`childEnvExtraForTest`）は**試験専用**（wire 試験が、同じ能力の組み立てに fixture への transport の差し替えだけを足した子を起動する。
 * 足す env は計画の env を上書きしない）。
 * 本番の入口（`start`・`tools/rails-acceptance-run.ts`・`tools/evm-testnets-run.ts`）は渡さない（静的検査で固定する）。
 */
export async function startHost(
  options: HostOptions,
  overrides: {
    readonly childScriptForTest?: string;
    readonly childEnvExtraForTest?: Readonly<Record<string, string>>;
    /** facilitator の子の script と、足す env（計画の env を上書きしない）。試験専用（上と同じ規則）。 */
    readonly facilitatorScriptForTest?: string;
    readonly facilitatorEnvExtraForTest?: Readonly<Record<string, string>>;
    /** drain の上限（ms）。試験専用（上と同じ規則。本番は `DRAIN_TIMEOUT_MS`）。 */
    readonly drainTimeoutMsForTest?: number;
  } = {},
): Promise<RunningHost> {
  let plan: HostPlan;
  try {
    plan = hostPlanOf(options, process.env);
  } catch (error) {
    // 固定文のみ（理由の code で選ぶ。値は出さない）。
    const code = error instanceof HostPlanError ? error.code : undefined;
    note(code === "env" ? "SUBETHA_OUTBOUND_PRIVATE_KEY and SUBETHA_ROUTER_RECEIVER are required." : code === "evm_facilitator" ? "an EVM testnet rail is activated: SUBETHA_EVM_FACILITATOR_KEY, SUBETHA_EVM_FACILITATOR_TOKEN (32+ characters of [A-Za-z0-9_-]), SUBETHA_EVM_FACILITATOR_GAS_CAP_<chainId> for each active chain and SUBETHA_EVM_PROVIDER_PAYTO are required" : options.evmTestnets !== undefined ? "evm testnets config could not be generated (check SUBETHA_EVM_FACILITATOR_URL / SUBETHA_EVM_PROVIDER_URL_<CHAIN> / SUBETHA_EVM_PROVIDER_PAYTO and the loopback bind)" : code === "rails" ? "rails receivers could not be derived (check SUBETHA_ARC_RECEIVER_KEY / SUBETHA_SOLANA_RECEIVER)" : "router config could not be generated (check the rails receivers)");
    process.exit(2);
  }

  /**
   * 子の所有と片付け（H-4 のレビュー）: signal の handler と取り消し（`lifecycle`）は **子を起動する前に** 入れる。
   * - 起動待ちの子（listening の前）は `lifecycle` の abort で止まる（`startListening` が SIGTERM → 5 秒で SIGKILL、終了を待つ）
   * - 起動した子は `owned` に入れ、そのときから終了を見る（facilitator が Router の起動待ちの間に落ちても、その時点で全体を止める）
   * - 起動の後の失敗（`/supported`・Router の起動・証拠の書き込み・MCP の bind）と signal と子の終了は、すべて `shutdown` を通る:
   *   取り消し → 入口を閉じる → 起動待ちと起動済みの子の **終了を待ってから** `process.exit`。facilitator が入口より長く lock を持つことはない
   * - 子を止める順は Router の子 → facilitator（Router の子の進行中の settle が facilitator を使い得る）。facilitator は Router の子の終了の後に止める
   * - 起動の後（`ready`）の signal は先に drain（§13.3・§15.2、タスク R-0）。上限は signal から `DRAIN_TIMEOUT_MS` の 1 つの期限:
   *   (1) 入口の listener を閉じ（新しい接続を受けない。既存の接続の上の新しい要求は 503）、進行中の MCP の要求が 0 になるのを待つ
   *   (2) Router の子に SIGTERM を送り、子の drain（新しい要求を断り、相手が切った購入も含めて進行中の処理の終わりを待つ）と終了を残りの時間まで待つ
   *       （5 秒の SIGKILL ではない。残りが尽きたら SIGKILL）
   *   (3) facilitator に SIGTERM を送り、facilitator の drain（進行中の要求と、応答の後も続く遅れた送出・journal の続き）と終了を残りの時間まで待つ
   *   (4) 最後に固定の 1 行 `drain: complete <id>` か `drain: timeout <id>`（id は起動の最初の `entry run: <id>` と同じ）。complete は (1) が 0 になり、
   *       Router の子が `router drain: complete`、facilitator が `facilitator drain: complete` を出して、どちらも exit 0 で終わったときだけ。それ以外は timeout（exit 1）
   *   待っている間に facilitator が落ちたら今までどおり `shutdown`（両方を止めて exit 1。drain の行は出さない = 静止の証拠にならない）。
   *   (1) の間に Router の子が落ちたときも同じ（facilitator があるとき。無いときは (2) で `drain: timeout`）
   */
  const lifecycle = new AbortController();
  const owned: Listening[] = [];
  const pending = new Set<Promise<unknown>>();
  let http: Server | undefined;
  let shuttingDown = false;
  let ready = false;
  const drain = createIngressDrain();
  const drainTimeoutMs = overrides.drainTimeoutMsForTest ?? DRAIN_TIMEOUT_MS;
  /**
   * この起動の id（タスク R-0。16 hex の乱数）。起動の最初に `entry run: <id>` を出し、drain の最後の行にも同じ id を付ける
   * （`drain: complete <id>`）。`deploy/swap-image.sh` は停止の前に読んだ id と最後の行の id が一致するときだけ静止とみなす
   * （同じ秒の古い行・時計の巻き戻しで別の起動の行を拾わない）。
   */
  const runId = randomBytes(8).toString("hex");
  note(`entry run: ${runId}`);
  /** `finalLine`: 子を止めた後、exit の直前に出す固定の 1 行（drain の結果と起動の id だけ）。 */
  const shutdown = async (code: number, message?: string, finalLine?: "drain: complete" | "drain: timeout"): Promise<never> => {
    if (!shuttingDown) {
      shuttingDown = true;
      if (message !== undefined) note(message);
      lifecycle.abort();
      drain.close();
      http?.close();
      await Promise.allSettled([...pending]);
      // Router の子（後に起動した）を先に、facilitator を後に止める（終了を待ってから次）。
      for (const child of [...owned].reverse()) await child.stop().catch(() => {});
      if (finalLine !== undefined) note(`${finalLine} ${runId}`);
      process.exit(code);
    }
    // 2 回目以降（片付けの途中の別の失敗）は、最初の片付けが終わらせるまで待つ。
    return new Promise<never>(() => {});
  };
  let draining = false;
  /** drain で止める子（その終了は「子が落ちた」として扱わない）。 */
  const expectedExits = new Set<Listening>();
  let routerChild: Listening | undefined;
  let facilitatorChild: Listening | undefined;
  /** 子を残りの時間まで drain させて止める。固定の行 `<label> drain: complete` を SIGTERM の後に出して exit 0 で終わったときだけ true。 */
  const drainChild = async (child: Listening, label: string, deadline: number): Promise<boolean> => {
    expectedExits.add(child);
    const result = await child.stopWithin(deadline - Date.now());
    return !result.killed && result.code === 0 && result.stderrAfter.split("\n").includes(`${label} drain: complete`);
  };
  /** 起動の後の signal: 上の (1)〜(3)。2 回目の signal は何もしない（drain を続ける）。 */
  const drainThenShutdown = async (): Promise<void> => {
    if (draining || shuttingDown) return;
    draining = true;
    const deadline = Date.now() + drainTimeoutMs;
    drain.close();
    http?.close();
    const idle = await drain.idle(drainTimeoutMs);
    // 待っている間に子が落ちて `shutdown` が始まっていれば、ここは何もしない（その片付けが exit する）。
    if (shuttingDown) return;
    if (!idle) {
      await shutdown(1, undefined, "drain: timeout");
      return;
    }
    // Router の子 → facilitator の順に、それぞれ残りの時間まで drain させる（facilitator は Router の子の終了の後: 進行中の settle が使い得る）。
    const routerDrained = routerChild === undefined ? true : await drainChild(routerChild, "router", deadline);
    if (shuttingDown) return;
    const facilitatorDrained = facilitatorChild === undefined ? true : await drainChild(facilitatorChild, "facilitator", deadline);
    if (shuttingDown) return;
    const complete = routerDrained && facilitatorDrained;
    await shutdown(complete ? 0 : 1, undefined, complete ? "drain: complete" : "drain: timeout");
  };
  const onSignal = (): void => void (ready ? drainThenShutdown() : shutdown(0));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  /** 子を起動する（取り消し可能）。起動したらすぐ `owned` に入れて終了を見る（`watch` が true の子）。 */
  const spawnChild = async (script: string, env: Readonly<Record<string, string>>, listenTimeoutMs: number, label: string, watch: boolean): Promise<Listening> => {
    const starting = startListening(script, [], env, { listenTimeoutMs, signal: lifecycle.signal });
    pending.add(starting);
    try {
      const child = await starting;
      owned.push(child);
      if (watch) void child.exited.then(() => (expectedExits.has(child) ? undefined : void shutdown(1, `${label} exited: stopping the entry`)));
      return child;
    } finally {
      pending.delete(starting);
    }
  };
  /** 起動の段の失敗: 取り消し中（signal・子の終了）なら片付けに任せる。そうでなければ固定文で片付けて終わる。 */
  const startupFailed = (message: string): Promise<never> => (shuttingDown ? shutdown(1) : shutdown(1, message));

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
  // 0600: 設定は facilitator の URL（token を含む）を持ち得る。作業領域（`mkdtemp`）は 0700。
  await writeFile(configPath, JSON.stringify(plan.config, null, 2), { encoding: "utf8", mode: 0o600 });

  /**
   * 自前の EVM facilitator（hosted 設計 §4）: Router の子より **先に** 起動する。`startListening` は `node --import tsx <script>` で
   * script 自身を唯一の子にする（tsx の CLI は script を孫で動かし、signal が `flock` を持つ process に届かない）。
   * listening の行を待ち、`/<token>/supported` を 1 回読んで有効な network が全部あることを確かめる。だめなら片付けて終わる（固定文）。
   * 起動した時点から終了を見る（Router の起動待ちの間に落ちれば、Router の起動を取り消して終わる）。
   */
  let facilitator: Listening | undefined;
  if (plan.facilitator !== undefined) {
    try {
      // 固定文のみ（起動失敗の例外は子の出力を丸ごと含む）。原因（lock・gas の上限・RPC など）は facilitator を単体で起動して調べる（固定文の code を出す）。
      facilitator = await spawnChild(overrides.facilitatorScriptForTest ?? plan.facilitator.script, { ...(overrides.facilitatorEnvExtraForTest ?? {}), ...plan.facilitator.env }, FACILITATOR_LISTEN_TIMEOUT_MS, "the EVM facilitator", true);
      facilitatorChild = facilitator;
    } catch {
      return startupFailed("could not start the EVM facilitator");
    }
    if (facilitator.port !== plan.facilitator.port || !(await facilitatorSupportsAll(plan.facilitator.url, plan.facilitator.networks, fetch, lifecycle.signal))) {
      return startupFailed("the EVM facilitator did not list every active network at /supported");
    }
    note(`evm facilitator: listening on port ${facilitator.port} (${plan.facilitator.networks.join(",")})`);
  }

  let router: Listening;
  try {
    // 起動待ちは 120 秒: 子の Router は listen の前に Solana の起動時の検査（`/supported`・ATA、各 10 秒まで）、MPP 送信のプロファイルごとの Tempo の probe（各 6 秒まで、最大 3 本）、
    // journal の replay を行う。上限に達すると子は殺され、入口は固定文で止まる。
    // 終了を見るのは facilitator があるときだけ（無いときは今までと同じ: Router の子が落ちても入口は残る）。
    router = await spawnChild(overrides.childScriptForTest ?? plan.childScript, { ...(overrides.childEnvExtraForTest ?? {}), ...plan.childEnv, ROUTER_CONFIG_PATH: configPath }, 120_000, "the Router", facilitator !== undefined);
  } catch {
    // 固定文のみ（起動失敗の例外は子プロセスの出力を丸ごと含む）。原因は Router を単体で起動して調べる。
    return startupFailed("could not start the Router");
  }
  routerChild = router;
  const listening = router.stdout().trim();
  note(`router: ${listening}`);

  const evidenceFile = path.join(work, "router-listening.log");
  try {
    await writeFile(evidenceFile, listening, "utf8");
  } catch {
    return startupFailed("could not write the Router evidence file");
  }

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
  const ingress = createMcpIngress({
    note,
    drain,
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

  http = ingress;
  // 起動の後の 'error'（bind の後に起きるもの）も未処理にしない: 片付けて終わる。
  ingress.on("error", () => {
    if (ready) void shutdown(1, "the MCP ingress failed");
  });
  let bound: { address: string; port: number };
  try {
    bound = await listenMcp(ingress, options.bind, options.port);
  } catch {
    return startupFailed("could not bind the MCP ingress");
  }
  if (shuttingDown) return shutdown(0);
  ready = true;
  note(`subetha-router remote MCP on ${bound.address}:${bound.port}/mcp (inbound payer: the caller's own key)`);
  return { mcpPort: bound.port, mcpAddress: bound.address, routerPort: router.port, journalPath, ...(facilitator === undefined ? {} : { facilitatorPort: facilitator.port }), stop: () => void shutdown(0) };
}

/** 公開の入口: 多レールは定数 `RAILS_ACTIVATION`（G-4 で両方 true）、0.0.0.0、`PORT`（既定 8787）、journal は固定パス。 */
async function start(): Promise<void> {
  // mainnet の最初の 1 経路（`docs/mainnet-first-route.md`）: env に CID があれば loopback 限定・mainnet 専用で起動する。公開の起動とは排他。
  if (process.env["SUBETHA_MAINNET_FIRST_ROUTE"] === "1") {
    await startHost({
      activation: RAILS_NONE,
      bind: "127.0.0.1",
      port: Number(process.env["PORT"] ?? "8787"),
      journalPath: process.env["SUBETHA_MAINNET_JOURNAL_PATH"] ?? path.join(path.resolve("runtime"), "mainnet-first-route.ndjson"),
      mainnetFirstRoute: true,
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
