/**
 * 本番の入口の多レール（Arc・Solana の受信）の**有効化と能力**（multirail 設計 §3・§8、タスク T8-b）。**製品コードではない**（鍵を扱う起動側）。
 *
 * 有効化は 1 つの値 `RailsActivation { arc, solana }` で決まり、**設定生成（`routerConfigOf`）と能力の注入の両方**がこの値を見る:
 * - ホストの入口（`tools/remote-mcp.ts`）は定数 `RAILS_ACTIVATION`（G-4 の後は両方 `true`）を渡し、受取先と子プロセスの env をここで作る
 * - 受け入れ用の起動（`tools/rails-acceptance-run.ts`）は同じ関数に `true` を渡す
 * - Router の process（`tools/remote-router-process.ts`）はホストが渡した内部の env `SUBETHA_RAILS_ACTIVATION` から同じ値を復元し、能力を作る
 *
 * 無効なレールの env（受取鍵・受取 owner・RPC）は**読まない**。鍵の値はエラー・ログに出さない（固定文のみ）。
 * このファイルは import しても何もしない（試験から読める）。
 */
import { DEFAULT_SOLANA_RPC_URL, type RouterCapabilities } from "../src/main.js";
import { createRealEvmCapability } from "./real-evm-capability.js";
import { createRealMppCapability, TEMPO_MODERATO_RPC } from "./real-mpp-capability.js";
import { INBOUND_ARC, OUTBOUND_ARC, RAIL_UPSTREAMS, type RailProviders, type RailReceivers, type RailsActivation, type RailsOptions, type RailUpstreams } from "./remote-mcp-config.js";
import { ARC_RECEIVER_KEY_ENV, createRealSellerProofCapability } from "./real-seller-proof-capability.js";

/** ホスト → Router の process に渡す内部の env。値は `activationToEnv` の形（`"arc-in,arc-out,solana-in,solana-out"` の部分集合。空 = すべて無効）。 */
export const RAILS_ACTIVATION_ENV = "SUBETHA_RAILS_ACTIVATION";
/** Arc の Provider の受取先（送信が有効で静的 route を出すときだけ。D-10）。 */
export const ARC_PROVIDER_ENV = "SUBETHA_ARC_PROVIDER_PAYTO";
/** Solana の受取 owner の address（鍵はホストに置かない。ATA は運用者が作る）。 */
export const SOLANA_RECEIVER_ENV = "SUBETHA_SOLANA_RECEIVER";
/** Solana の JSON-RPC（起動時の ATA の検査だけ）。無ければ公開 devnet の既定。URL は鍵を含み得るのでログに出さない。 */
export const SOLANA_RPC_ENV = "SUBETHA_SOLANA_RPC_URL";

const RAIL_NAMES = ["arc", "solana"] as const;
/** 内部 env の token（方向別。送信の設計 §6.1）。旧い `arc`・`solana` は受け付けない。 */
const ACTIVATION_TOKENS = ["arc-in", "arc-out", "solana-in", "solana-out"] as const;

export function activationToEnv(activation: RailsActivation): string {
  const tokens: string[] = [];
  for (const rail of RAIL_NAMES) {
    if (activation[rail].inbound) tokens.push(`${rail}-in`);
    if (activation[rail].outbound) tokens.push(`${rail}-out`);
  }
  return tokens.join(",");
}

/** 内部の env から有効化を復元する。空・未設定はすべて無効。知らない語（旧い `arc`・`solana` を含む）・重複は起動しない（値は出さない）。 */
export function activationFromEnv(value: string | undefined): RailsActivation {
  const seen = new Set<string>();
  if (value !== undefined && value !== "") {
    for (const token of value.split(",")) {
      const name = token.trim();
      if (!(ACTIVATION_TOKENS as readonly string[]).includes(name) || seen.has(name)) {
        throw new Error(`${RAILS_ACTIVATION_ENV} must be a comma-separated subset of "arc-in,arc-out,solana-in,solana-out" without repeats`);
      }
      seen.add(name);
    }
  }
  return {
    arc: { inbound: seen.has("arc-in"), outbound: seen.has("arc-out") },
    solana: { inbound: seen.has("solana-in"), outbound: seen.has("solana-out") },
  };
}

/**
 * 受取先。Arc は**証明専用の受取鍵の address**（env の鍵から導く。鍵そのものは保持しない）、Solana は env の受取 owner の address。
 * 無効なレールの env は読まない。
 */
export function railsReceiversOf(activation: RailsActivation, env: Readonly<Record<string, string | undefined>>): RailReceivers {
  const receivers: { arc?: string; solana?: string } = {};
  // 受取先は**受信**の分だけ（送信だけ有効なレールの受取鍵・受取 owner は読まない）。
  if (activation.arc.inbound) {
    // 鍵の形の検査と address の導出は能力の作成と同じ関数（違う鍵を見ない）。
    receivers.arc = createRealSellerProofCapability(INBOUND_ARC.network, env).address;
  }
  if (activation.solana.inbound) {
    const owner = env[SOLANA_RECEIVER_ENV];
    if (owner === undefined || owner === "") {
      throw new Error(`${SOLANA_RECEIVER_ENV} is required when the solana rail is activated`);
    }
    receivers.solana = owner;
  }
  return receivers;
}

/**
 * Provider の受取先。読むのは**送信が有効で、かつ Provider の URL が空でない**レールの分だけ（静的 route を出すときだけ要る。D-10）。
 * URL が空（Provider が立っていない。今の Arc）なら env に触れない。無ければ欄ごと無し: 有無の判定は設定生成（`providerOf`）が行う。
 */
export function railsProvidersOf(activation: RailsActivation, env: Readonly<Record<string, string | undefined>>, upstreams: RailUpstreams = RAIL_UPSTREAMS): RailProviders {
  const providers: { arc?: string } = {};
  if (activation.arc.outbound && upstreams.arc !== "") {
    const payTo = env[ARC_PROVIDER_ENV];
    if (payTo !== undefined && payTo !== "") providers.arc = payTo;
  }
  return providers;
}

/** 設定生成に渡す値（有効化・受取先・Provider の受取先・Provider の URL を 1 つに。URL は本番では定数）。 */
export function railsOptionsOf(activation: RailsActivation, env: Readonly<Record<string, string | undefined>>, upstreams: RailUpstreams = RAIL_UPSTREAMS): RailsOptions {
  return { activation, receivers: railsReceiversOf(activation, env), providers: railsProvidersOf(activation, env, upstreams), upstreams };
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
    // 売り手証明は Arc の**受信**だけ。Solana の RPC は受信か送信のどちらかで要る（送信の設計 §6.2）。
    ...(activation.arc.inbound ? { sellerProofs: { [INBOUND_ARC.network]: createRealSellerProofCapability(INBOUND_ARC.network, env, now) } } : {}),
    ...(activation.solana.inbound || activation.solana.outbound ? { dependencyUrls: [solanaRpcUrlOf(env)] } : {}),
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
  let activation: RailsActivation;
  let rails: Pick<RouterCapabilities, "sellerProofs" | "dependencyUrls">;
  try {
    activation = activationFromEnv(env[RAILS_ACTIVATION_ENV]);
    rails = railsCapabilitiesOf(activation, env, now);
  } catch {
    throw new ProcessEntryError("rails");
  }
  // Arc の送信（送信の設計 §6.2、D-11）: Base と同じ鍵を Arc の network の札で束ねる。鍵が無ければ Arc の送信は組めない（fail closed）。
  if (activation.arc.outbound && (evmKey === undefined || evmKey === "")) {
    throw new ProcessEntryError("outbound_keys");
  }
  const evm = evmKey === undefined || evmKey === "" ? undefined : createRealEvmCapability(evmKey);
  return {
    // 動的上流 URL の拒否ホスト（設計 §7.4）: 送信 MPP の RPC と、Solana の起動時の検査の RPC。URL は値ごと渡すが、使うのはホスト名だけ（ログには出ない）。
    dependencyUrls: [mppRpcUrl === undefined || mppRpcUrl === "" ? TEMPO_MODERATO_RPC : mppRpcUrl, ...(rails.dependencyUrls ?? [])],
    ...(rails.sellerProofs === undefined ? {} : { sellerProofs: rails.sellerProofs }),
    ...(evm === undefined ? {} : { evmSigning: evm.capability("eip155:84532") }),
    ...(evm !== undefined && activation.arc.outbound ? { evmSigningByNetwork: { [OUTBOUND_ARC.network]: evm.capability(OUTBOUND_ARC.network) } } : {}),
    ...(mppKey === undefined || mppKey === "" ? {} : { mppTempo: createRealMppCapability(mppKey, { ...(mppRpcUrl === undefined || mppRpcUrl === "" ? {} : { rpcUrl: mppRpcUrl }) }).capability() }),
  };
}

/**
 * ホストが Router の process に渡す env（子の env は allowlist 方式なので、ここで明示したものだけが届く）。
 * 有効化の値、Arc の受取鍵（Arc が有効なときだけ）、Solana の RPC（Solana が有効で設定があるときだけ。Router の設定の読み口 `ROUTER_SOLANA_RPC_URL` にも同じ値）。
 */
export function railsChildEnvOf(activation: RailsActivation, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = { [RAILS_ACTIVATION_ENV]: activationToEnv(activation) };
  // 無効なレール・方向の env は**読まない**（渡さないだけでなく、参照もしない）。
  if (activation.arc.inbound) {
    const key = env[ARC_RECEIVER_KEY_ENV];
    if (key !== undefined && key !== "") out[ARC_RECEIVER_KEY_ENV] = key;
  }
  if (activation.solana.inbound || activation.solana.outbound) {
    const rpc = env[SOLANA_RPC_ENV];
    if (rpc !== undefined && rpc !== "") {
      out[SOLANA_RPC_ENV] = rpc;
      out["ROUTER_SOLANA_RPC_URL"] = rpc;
    }
  }
  return out;
}
