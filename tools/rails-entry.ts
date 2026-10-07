/**
 * 本番の入口の多レール（Arc・Solana の受信）の**有効化と能力**（multirail 設計 §3・§8、タスク T8-b）。**製品コードではない**（鍵を扱う起動側）。
 *
 * 有効化は 1 つの値 `RailsActivation { arc, solana }` で決まり、**設定生成（`routerConfigOf`）と能力の注入の両方**がこの値を見る:
 * - ホストの入口（`tools/remote-mcp.ts`）は定数 `RAILS_ACTIVATION`（どちらも `false`）を渡し、受取先と子プロセスの env をここで作る
 * - 受け入れ用の起動（`tools/rails-acceptance-run.ts`）は同じ関数に `true` を渡す
 * - Router の process（`tools/remote-router-process.ts`）はホストが渡した内部の env `SUBETHA_RAILS_ACTIVATION` から同じ値を復元し、能力を作る
 *
 * 無効なレールの env（受取鍵・受取 owner・RPC）は**読まない**。鍵の値はエラー・ログに出さない（固定文のみ）。
 * このファイルは import しても何もしない（試験から読める）。
 */
import { DEFAULT_SOLANA_RPC_URL, type RouterCapabilities } from "../src/main.js";
import { createRealEvmCapability } from "./real-evm-capability.js";
import { createRealMppCapability, TEMPO_MODERATO_RPC } from "./real-mpp-capability.js";
import { INBOUND_ARC, type RailReceivers, type RailsActivation, type RailsOptions } from "./remote-mcp-config.js";
import { ARC_RECEIVER_KEY_ENV, createRealSellerProofCapability } from "./real-seller-proof-capability.js";

/** ホスト → Router の process に渡す内部の env。値は `activationToEnv` の形（`"arc,solana"`・`"arc"`・`"solana"`・`""`）。 */
export const RAILS_ACTIVATION_ENV = "SUBETHA_RAILS_ACTIVATION";
/** Solana の受取 owner の address（鍵はホストに置かない。ATA は運用者が作る）。 */
export const SOLANA_RECEIVER_ENV = "SUBETHA_SOLANA_RECEIVER";
/** Solana の JSON-RPC（起動時の ATA の検査だけ）。無ければ公開 devnet の既定。URL は鍵を含み得るのでログに出さない。 */
export const SOLANA_RPC_ENV = "SUBETHA_SOLANA_RPC_URL";

const RAIL_NAMES = ["arc", "solana"] as const;

export function activationToEnv(activation: RailsActivation): string {
  return RAIL_NAMES.filter((rail) => activation[rail] === true).join(",");
}

/** 内部の env から有効化を復元する。空・未設定はどちらも無効。知らない語・重複は起動しない（値は出さない）。 */
export function activationFromEnv(value: string | undefined): RailsActivation {
  if (value === undefined || value === "") return { arc: false, solana: false };
  const seen = new Set<string>();
  for (const token of value.split(",")) {
    const rail = token.trim();
    if (!(RAIL_NAMES as readonly string[]).includes(rail) || seen.has(rail)) {
      throw new Error(`${RAILS_ACTIVATION_ENV} must be a comma-separated subset of "arc,solana" without repeats`);
    }
    seen.add(rail);
  }
  return { arc: seen.has("arc"), solana: seen.has("solana") };
}

/**
 * 受取先。Arc は**証明専用の受取鍵の address**（env の鍵から導く。鍵そのものは保持しない）、Solana は env の受取 owner の address。
 * 無効なレールの env は読まない。
 */
export function railsReceiversOf(activation: RailsActivation, env: Readonly<Record<string, string | undefined>>): RailReceivers {
  const receivers: { arc?: string; solana?: string } = {};
  if (activation.arc) {
    // 鍵の形の検査と address の導出は能力の作成と同じ関数（違う鍵を見ない）。
    receivers.arc = createRealSellerProofCapability(INBOUND_ARC.network, env).address;
  }
  if (activation.solana) {
    const owner = env[SOLANA_RECEIVER_ENV];
    if (owner === undefined || owner === "") {
      throw new Error(`${SOLANA_RECEIVER_ENV} is required when the solana rail is activated`);
    }
    receivers.solana = owner;
  }
  return receivers;
}

/** 設定生成に渡す値（有効化と受取先を 1 つに）。 */
export function railsOptionsOf(activation: RailsActivation, env: Readonly<Record<string, string | undefined>>): RailsOptions {
  return { activation, receivers: railsReceiversOf(activation, env) };
}

export function solanaRpcUrlOf(env: Readonly<Record<string, string | undefined>>): string {
  const value = env[SOLANA_RPC_ENV];
  return value === undefined || value === "" ? DEFAULT_SOLANA_RPC_URL : value;
}

/**
 * Router の process が `startRouter` に注入する能力のうち、多レールの分。
 * - Arc: 売り手証明の能力（`sellerProofs[eip155:5042002]`）。配線が route・プロファイルの `source.payTo` と address の一致を確かめる
 * - Solana: 鍵は要らない。起動時の検査の RPC を依存先（拒否ホスト）に入れる（配線は設定の `ROUTER_SOLANA_RPC_URL` からも入れる。両方で保つ）
 */
export function railsCapabilitiesOf(activation: RailsActivation, env: Readonly<Record<string, string | undefined>>, now: () => number = Date.now): Pick<RouterCapabilities, "sellerProofs" | "dependencyUrls"> {
  return {
    ...(activation.arc ? { sellerProofs: { [INBOUND_ARC.network]: createRealSellerProofCapability(INBOUND_ARC.network, env, now) } } : {}),
    ...(activation.solana ? { dependencyUrls: [solanaRpcUrlOf(env)] } : {}),
  };
}

/** Router の process の起動が止まる理由（固定文は入口が選ぶ。鍵・URL の値は持たない）。 */
export class ProcessEntryError extends Error {
  readonly code: "outbound_keys" | "rails";
  constructor(code: "outbound_keys" | "rails") {
    super(code === "outbound_keys" ? "at least one of SUBETHA_OUTBOUND_X402_KEY / SUBETHA_OUTBOUND_MPP_KEY is required" : "rails capabilities could not be created (check SUBETHA_RAILS_ACTIVATION / SUBETHA_ARC_RECEIVER_KEY)");
    this.name = "ProcessEntryError";
    this.code = code;
  }
}

/**
 * Router の process（`tools/remote-router-process.ts`）が `startRouter` に注入する**能力の全部**。純粋関数（process に触らない。試験で確かめる）:
 * 送信の鍵（x402・MPP）、送信 MPP の RPC（依存先）、多レール（内部の env `SUBETHA_RAILS_ACTIVATION` から復元した有効化で `railsCapabilitiesOf`）。
 * 無効なレールの env は読まない。
 */
export function routerProcessCapabilitiesOf(env: Readonly<Record<string, string | undefined>>, now: () => number = Date.now): RouterCapabilities {
  const evmKey = env["SUBETHA_OUTBOUND_X402_KEY"];
  const mppKey = env["SUBETHA_OUTBOUND_MPP_KEY"];
  const mppRpcUrl = env["SUBETHA_TEMPO_RPC_URL"];
  if ((evmKey === undefined || evmKey === "") && (mppKey === undefined || mppKey === "")) {
    throw new ProcessEntryError("outbound_keys");
  }
  let rails: Pick<RouterCapabilities, "sellerProofs" | "dependencyUrls">;
  try {
    rails = railsCapabilitiesOf(activationFromEnv(env[RAILS_ACTIVATION_ENV]), env, now);
  } catch {
    throw new ProcessEntryError("rails");
  }
  return {
    // 動的上流 URL の拒否ホスト（設計 §7.4）: 送信 MPP の RPC と、Solana の起動時の検査の RPC。URL は値ごと渡すが、使うのはホスト名だけ（ログには出ない）。
    dependencyUrls: [mppRpcUrl === undefined || mppRpcUrl === "" ? TEMPO_MODERATO_RPC : mppRpcUrl, ...(rails.dependencyUrls ?? [])],
    ...(rails.sellerProofs === undefined ? {} : { sellerProofs: rails.sellerProofs }),
    ...(evmKey === undefined || evmKey === "" ? {} : { evmSigning: createRealEvmCapability(evmKey).capability("eip155:84532") }),
    ...(mppKey === undefined || mppKey === "" ? {} : { mppTempo: createRealMppCapability(mppKey, { ...(mppRpcUrl === undefined || mppRpcUrl === "" ? {} : { rpcUrl: mppRpcUrl }) }).capability() }),
  };
}

/**
 * ホストが Router の process に渡す env（子の env は allowlist 方式なので、ここで明示したものだけが届く）。
 * 有効化の値、Arc の受取鍵（Arc が有効なときだけ）、Solana の RPC（Solana が有効で設定があるときだけ。Router の設定の読み口 `ROUTER_SOLANA_RPC_URL` にも同じ値）。
 */
export function railsChildEnvOf(activation: RailsActivation, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const key = env[ARC_RECEIVER_KEY_ENV];
  const rpc = env[SOLANA_RPC_ENV];
  return {
    [RAILS_ACTIVATION_ENV]: activationToEnv(activation),
    ...(activation.arc && key !== undefined && key !== "" ? { [ARC_RECEIVER_KEY_ENV]: key } : {}),
    ...(activation.solana && rpc !== undefined && rpc !== "" ? { [SOLANA_RPC_ENV]: rpc, ROUTER_SOLANA_RPC_URL: rpc } : {}),
  };
}
