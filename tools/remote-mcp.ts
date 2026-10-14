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

/**
 * facilitator の `/<token>/supported` を loopback で 1 回読み、`networks` が全部（x402 v2・`exact`）載っているか（hosted 設計 §4）。
 * 失敗（接続・期限・redirect・200 以外・大きすぎる・JSON でない・欠け）はすべて `false`（理由・値は返さない）。
 */
export async function facilitatorSupportsAll(url: string, networks: readonly string[], fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${url}/supported`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(SUPPORTED_TIMEOUT_MS) });
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
  return new Promise((resolve) => {
    http.listen(port, bind, () => {
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
   * listening の行を待ち、`/<token>/supported` を 1 回読んで有効な network が全部あることを確かめる。だめなら facilitator を止めて終わる（固定文）。
   */
  let facilitator: Listening | undefined;
  if (plan.facilitator !== undefined) {
    try {
      facilitator = await startListening(overrides.facilitatorScriptForTest ?? plan.facilitator.script, [], { ...(overrides.facilitatorEnvExtraForTest ?? {}), ...plan.facilitator.env }, { listenTimeoutMs: FACILITATOR_LISTEN_TIMEOUT_MS });
    } catch (error) {
      // 固定文のみ（起動失敗の例外は子の出力を丸ごと含む）。原因（lock・gas の上限・RPC など）は facilitator を単体で起動して調べる（固定文の code を出す）。
      void error;
      note("could not start the EVM facilitator");
      process.exit(1);
    }
    if (facilitator.port !== plan.facilitator.port || !(await facilitatorSupportsAll(plan.facilitator.url, plan.facilitator.networks))) {
      await facilitator.stop();
      note("the EVM facilitator did not list every active network at /supported");
      process.exit(1);
    }
    note(`evm facilitator: listening on port ${facilitator.port} (${plan.facilitator.networks.join(",")})`);
  }

  let router: Listening;
  try {
    // 起動待ちは 120 秒: 子の Router は listen の前に Solana の起動時の検査（`/supported`・ATA、各 10 秒まで）、MPP 送信のプロファイルごとの Tempo の probe（各 6 秒まで、最大 3 本）、
    // journal の replay を行う。上限に達すると子は殺され、入口は固定文で止まる。
    router = await startListening(overrides.childScriptForTest ?? plan.childScript, [], { ...(overrides.childEnvExtraForTest ?? {}), ...plan.childEnv, ROUTER_CONFIG_PATH: configPath }, { listenTimeoutMs: 120_000 });
  } catch (error) {
    // 固定文のみ（起動失敗の例外は子プロセスの出力を丸ごと含む）。原因は Router を単体で起動して調べる。
    void error;
    await facilitator?.stop();
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

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    http.close();
    void router.stop();
    void facilitator?.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  /**
   * facilitator があるとき: どちらかの子が落ちたら、もう片方を止めて入口も終わる（hosted 設計 §4。`--restart unless-stopped` がコンテナごと戻す）。
   * 片方だけが動き続ける（facilitator の無い Router・Router の無い facilitator）状態を残さない。
   */
  if (facilitator !== undefined) {
    const running = facilitator;
    const down = (which: string): void => {
      if (stopping) return;
      stopping = true;
      note(`${which} exited: stopping the entry`);
      http.close();
      void Promise.allSettled([router.stop(), running.stop()]).then(() => process.exit(1));
    };
    void running.exited.then(() => down("the EVM facilitator"));
    void router.exited.then(() => down("the Router"));
  }

  const bound = await listenMcp(http, options.bind, options.port);
  note(`subetha-router remote MCP on ${bound.address}:${bound.port}/mcp (inbound payer: the caller's own key)`);
  return { mcpPort: bound.port, mcpAddress: bound.address, routerPort: router.port, journalPath, ...(facilitator === undefined ? {} : { facilitatorPort: facilitator.port }), stop };
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
