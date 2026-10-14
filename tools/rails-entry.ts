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
import { KNOWN_NETWORKS, knownNetworkOf } from "../src/shared/networks.js";
import { createRealMppCapability, defaultTempoRpcUrl, TEMPO_MODERATO_CHAIN_ID } from "./real-mpp-capability.js";
import { createRealSvmCapability } from "./real-svm-capability.js";
import { EVM_FACILITATOR_URL_ENV, EVM_TESTNETS, evmOf, HOSTED_EVM_CHAINS, INBOUND_ARC, OUTBOUND_ARC, OUTBOUND_SOL, pairsOf, RAIL_UPSTREAMS, type EvmRailsActivation, type HostedEvmChain, type PairsActivation, type RailProviders, type RailReceivers, type RailsActivation, type RailsOptions, type RailUpstreams } from "./remote-mcp-config.js";
import { ARC_RECEIVER_KEY_ENV, createRealSellerProofCapability } from "./real-seller-proof-capability.js";

/** ホスト → Router の process に渡す内部の env。値は `activationToEnv` の形（`ACTIVATION_TOKENS` の部分集合。空 = すべて無効）。 */
export const RAILS_ACTIVATION_ENV = "SUBETHA_RAILS_ACTIVATION";
/** x402 送信（`evmSigning`）の network（`docs/mainnet-first-route.md` 案 B）。省略時は Base Sepolia。表で x402 の送信を許す EVM の network だけ。 */
export const X402_OUTBOUND_NETWORK_ENV = "SUBETHA_X402_OUTBOUND_NETWORK";
/** Arc の Provider の受取先（送信が有効で静的 route を出すときだけ。D-10）。 */
export const ARC_PROVIDER_ENV = "SUBETHA_ARC_PROVIDER_PAYTO";
/** Solana の Provider の受取先（owner の公開鍵。送信が有効で静的 route を出すときだけ。D-10）。 */
export const SOLANA_PROVIDER_ENV = "SUBETHA_SOLANA_PROVIDER_PAYTO";
/** Provider D（Solana の MPP）の受取 owner（公開鍵。`solanaMpp.outbound` で、Provider D の URL が定数に入ったときだけ読む。`docs/mpp-solana-design.md` §6.2）。 */
export const SOLANA_MPP_PROVIDER_ENV = "SUBETHA_SOLANA_MPP_PROVIDER_PAYTO";
/** Solana の送信の鍵（ed25519 の seed。`wallet:new:solana`）。`solana.outbound ∨ solanaMpp.outbound` のときだけ読む（同じ鍵・同じ能力 1 つ）。 */
export const SOLANA_OUTBOUND_KEY_ENV = "SUBETHA_OUTBOUND_SOLANA_KEY";
/** Solana の受取 owner の address（鍵はホストに置かない。ATA は運用者が作る）。x402 の受信と MPP の受信で同じ値（`solana.inbound ∨ solanaMpp.inbound` で読む）。 */
export const SOLANA_RECEIVER_ENV = "SUBETHA_SOLANA_RECEIVER";
/** Solana の JSON-RPC（起動時の ATA の検査だけ）。無ければ公開 devnet の既定。URL は鍵を含み得るのでログに出さない。 */
export const SOLANA_RPC_ENV = "SUBETHA_SOLANA_RPC_URL";

/** レールの名前と token の語幹（`solanaMpp` の token は `solana-mpp-in`／`solana-mpp-out`。`docs/mpp-solana-design.md` §6.1）。 */
const RAIL_NAMES = [
  ["arc", "arc"],
  ["solana", "solana"],
  ["solanaMpp", "solana-mpp"],
] as const satisfies readonly (readonly [keyof RailsActivation, string])[];
/** 組の token（送信の設計 §13.1）。`RAIL_NAMES` とは別に、末尾に付ける。 */
const PAIR_TOKENS = [
  ["arcToSol", "arc-to-sol"],
  ["solToArc", "sol-to-arc"],
] as const satisfies readonly (readonly [keyof PairsActivation, string])[];
/** EVM testnet 3 つの token（hosted 設計 §5。`<短縮名>-in`・`<短縮名>-out`）。組の後ろに付ける（`evm` が全部 false なら 1 語も出ないので、既存の値は変わらない）。 */
const EVM_TOKENS = HOSTED_EVM_CHAINS.flatMap((chain) => [`${chain}-in`, `${chain}-out`]);
/** 内部 env の token（方向別。送信の設計 §6.1。組の 2 語は §13.1、EVM testnet 3 つの 6 語は hosted 設計 §5）。旧い `arc`・`solana` は受け付けない。 */
const ACTIVATION_TOKENS = ["arc-in", "arc-out", "solana-in", "solana-out", "solana-mpp-in", "solana-mpp-out", "arc-to-sol", "sol-to-arc", ...EVM_TOKENS] as const;
const ACTIVATION_TOKENS_TEXT = ACTIVATION_TOKENS.join(",");

export function activationToEnv(activation: RailsActivation): string {
  const tokens: string[] = [];
  for (const [rail, stem] of RAIL_NAMES) {
    if (activation[rail].inbound) tokens.push(`${stem}-in`);
    if (activation[rail].outbound) tokens.push(`${stem}-out`);
  }
  const pairs = pairsOf(activation);
  for (const [pair, token] of PAIR_TOKENS) if (pairs[pair]) tokens.push(token);
  const evm = evmOf(activation);
  for (const chain of HOSTED_EVM_CHAINS) {
    if (evm[chain].inbound) tokens.push(`${chain}-in`);
    if (evm[chain].outbound) tokens.push(`${chain}-out`);
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
        throw new Error(`${RAILS_ACTIVATION_ENV} must be a comma-separated subset of "${ACTIVATION_TOKENS_TEXT}" without repeats`);
      }
      seen.add(name);
    }
  }
  const pairs: PairsActivation = { arcToSol: seen.has("arc-to-sol"), solToArc: seen.has("sol-to-arc") };
  const evm = Object.fromEntries(HOSTED_EVM_CHAINS.map((chain) => [chain, { inbound: seen.has(`${chain}-in`), outbound: seen.has(`${chain}-out`) }])) as Record<HostedEvmChain, { inbound: boolean; outbound: boolean }>;
  return {
    arc: { inbound: seen.has("arc-in"), outbound: seen.has("arc-out") },
    solana: { inbound: seen.has("solana-in"), outbound: seen.has("solana-out") },
    solanaMpp: { inbound: seen.has("solana-mpp-in"), outbound: seen.has("solana-mpp-out") },
    // 組は token があるときだけ欄を持つ（無い = 両方 false。`pairsOf`）。
    ...(pairs.arcToSol || pairs.solToArc ? { pairs } : {}),
    // EVM testnet 3 つも token があるときだけ欄を持つ（無い = 全部 false。`evmOf`）。
    ...(EVM_TOKENS.some((token) => seen.has(token)) ? { evm: evm as EvmRailsActivation } : {}),
  };
}

/** 送信が有効な EVM testnet（hosted 設計 §3 の最後: その network の `evmSigningByNetwork` が要る）。 */
export function evmOutboundChainsOf(activation: RailsActivation): readonly HostedEvmChain[] {
  const evm = evmOf(activation);
  return HOSTED_EVM_CHAINS.filter((chain) => evm[chain].outbound);
}

/**
 * 自前の facilitator の URL の形（hosted 設計 §0・§3）: `http://127.0.0.1:<port>/<token>` だけ。port は 1..65535（前ゼロなし）、token は
 * `tools/evm-facilitator.ts` の `TOKEN_PATTERN`（`[A-Za-z0-9_-]{32,256}`。試験が source の一致を確かめる）。末尾の `/`・query・fragment・userinfo・別表記は受けない。
 */
const EVM_FACILITATOR_URL_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/([A-Za-z0-9_-]{32,256})$/;
/** 形が合えば origin（`http://127.0.0.1:<port>`）、合わなければ `undefined`。値は返さない（呼び出し側が固定文で止める）。 */
export function evmFacilitatorOriginOf(raw: string): string | undefined {
  const match = EVM_FACILITATOR_URL_PATTERN.exec(raw);
  if (match === null || Number(match[1]) > 65_535) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // URL として読み直しても同じ文字列（正規化で別の宛先に化けない）。
  return url.href === raw && url.origin === `http://127.0.0.1:${match[1]}` ? url.origin : undefined;
}

/** Solana の受取 owner が要るか（x402 の受信か MPP の受信。設計 §6.2）。 */
function needsSolanaReceiver(activation: RailsActivation): boolean {
  return activation.solana.inbound || activation.solanaMpp.inbound;
}
/** Solana の送信の鍵が要るか（x402 の送信か MPP の送信。同じ鍵・同じ能力 1 つ。設計 §6.2）。 */
export function needsSolanaOutboundKey(activation: RailsActivation): boolean {
  return activation.solana.outbound || activation.solanaMpp.outbound;
}
/** Solana の RPC が要るか（Solana のどの方向でも）。 */
function usesSolana(activation: RailsActivation): boolean {
  return needsSolanaReceiver(activation) || needsSolanaOutboundKey(activation);
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
  // Solana の受取 owner は x402 の受信と MPP の受信で同じ値（どちらかが有効なら読む。設定生成の述語は別々: `receiverOf` と `solanaMppReceiverOf`）。
  if (needsSolanaReceiver(activation)) {
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
  const providers: { arc?: string; solana?: string; solanaMpp?: string } = {};
  if (activation.arc.outbound && upstreams.arc !== "") {
    const payTo = env[ARC_PROVIDER_ENV];
    if (payTo !== undefined && payTo !== "") providers.arc = payTo;
  }
  if (activation.solana.outbound && upstreams.solana !== "") {
    const payTo = env[SOLANA_PROVIDER_ENV];
    if (payTo !== undefined && payTo !== "") providers.solana = payTo;
  }
  // Provider D（Solana の MPP）: 送信が有効で URL が定数に入ったときだけ（Provider D が立つまで URL は空 → 読まない）。
  if (activation.solanaMpp.outbound && upstreams.solanaMpp !== "") {
    const payTo = env[SOLANA_MPP_PROVIDER_ENV];
    if (payTo !== undefined && payTo !== "") providers.solanaMpp = payTo;
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
    ...(usesSolana(activation) ? { dependencyUrls: [solanaRpcUrlOf(env)] } : {}),
  };
}

/** Router の process の起動が止まる理由（固定文は入口が選ぶ。鍵・URL の値は持たない）。 */
export class ProcessEntryError extends Error {
  readonly code: "outbound_keys" | "rails" | "solana_key" | "x402_network" | "evm_facilitator";
  constructor(code: "outbound_keys" | "rails" | "solana_key" | "x402_network" | "evm_facilitator") {
    super(
      code === "evm_facilitator"
        ? "SUBETHA_EVM_FACILITATOR_URL must be exactly http://127.0.0.1:<port>/<token>"
        : code === "outbound_keys"
        ? "at least one of SUBETHA_OUTBOUND_X402_KEY / SUBETHA_OUTBOUND_MPP_KEY is required"
        : code === "solana_key"
          ? "SUBETHA_OUTBOUND_SOLANA_KEY is required and must be a base58 seed when the solana outbound rail (x402 or MPP) is activated"
          : code === "x402_network"
            ? "SUBETHA_X402_OUTBOUND_NETWORK must be an EVM network with x402 outbound in the table"
            : "rails capabilities could not be created (check SUBETHA_RAILS_ACTIVATION / SUBETHA_ARC_RECEIVER_KEY)",
    );
    this.name = "ProcessEntryError";
    this.code = code;
  }
}

/**
 * Router の process（`tools/remote-router-process.ts`）が `startRouter` に注入する**能力の全部**。純粋関数（process に触らない。試験で確かめる）:
 * 送信の鍵（x402・MPP）、送信 MPP の RPC（依存先）、多レール（内部の env `SUBETHA_RAILS_ACTIVATION` から復元した有効化で `railsCapabilitiesOf`）、
 * EVM testnet 3 つ（hosted 設計 §3 の最後）: 送信が有効な chain の `evmSigningByNetwork`（x402 の送信鍵）、内部の env `SUBETHA_EVM_FACILITATOR_URL` があればその origin だけの `localCounterparties`。
 * 無効なレールの env は読まない。
 */
export function routerProcessCapabilitiesOf(env: Readonly<Record<string, string | undefined>>, now: () => number = Date.now): RouterCapabilities {
  const evmKey = env["SUBETHA_OUTBOUND_X402_KEY"];
  const mppKey = env["SUBETHA_OUTBOUND_MPP_KEY"];
  const mppRpcUrl = env["SUBETHA_TEMPO_RPC_URL"];
  if ((evmKey === undefined || evmKey === "") && (mppKey === undefined || mppKey === "")) {
    throw new ProcessEntryError("outbound_keys");
  }
  const tempoChainId = TEMPO_MODERATO_CHAIN_ID;
  const x402NetworkRaw = env[X402_OUTBOUND_NETWORK_ENV];
  const x402Network = x402NetworkRaw === undefined || x402NetworkRaw === "" ? "eip155:84532" : x402NetworkRaw;
  {
    const entry = knownNetworkOf(KNOWN_NETWORKS, x402Network);
    if (entry === undefined || entry.family !== "evm" || !entry.outbound.includes("x402")) throw new ProcessEntryError("x402_network");
  }
  const tempoRpcUrl = mppRpcUrl === undefined || mppRpcUrl === "" ? defaultTempoRpcUrl(tempoChainId) : mppRpcUrl;
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
  // EVM testnet 3 つの送信（hosted 設計 §3 の最後、D-11）: Arc と同じ鍵を各 network の札で束ねる。鍵が無ければ組めない（fail closed）。
  const evmOutbound = evmOutboundChainsOf(activation);
  if (evmOutbound.length > 0 && (evmKey === undefined || evmKey === "")) {
    throw new ProcessEntryError("outbound_keys");
  }
  // 自前の facilitator（hosted 設計 §3 の最後）: 内部の env があるとき（空文字は無いと同じ。ほかの env と同じ扱い）だけ、その origin 1 つで `localCounterparties`。形が違えば起動しない（値は出さない）。無ければ今と同じ。
  const facilitatorUrl = env[EVM_FACILITATOR_URL_ENV];
  let facilitatorOrigin: string | undefined;
  if (facilitatorUrl !== undefined && facilitatorUrl !== "") {
    facilitatorOrigin = evmFacilitatorOriginOf(facilitatorUrl);
    if (facilitatorOrigin === undefined) throw new ProcessEntryError("evm_facilitator");
  }
  const evm = evmKey === undefined || evmKey === "" ? undefined : createRealEvmCapability(evmKey);
  // Solana の送信（送信の設計 §6.2、D-11。MPP の送信も同じ鍵・同じ能力: `docs/mpp-solana-design.md` §6.2）: 専用の ed25519 の鍵を **`solana.outbound ∨ solanaMpp.outbound` のときだけ**読む。無い・形が違えば起動しない（値は出さない）。
  let svm: ReturnType<typeof createRealSvmCapability> | undefined;
  if (needsSolanaOutboundKey(activation)) {
    const solKey = env[SOLANA_OUTBOUND_KEY_ENV];
    if (solKey === undefined || solKey === "") throw new ProcessEntryError("solana_key");
    try {
      svm = createRealSvmCapability(solKey);
    } catch {
      throw new ProcessEntryError("solana_key");
    }
  }
  return {
    // 動的上流 URL の拒否ホスト（設計 §7.4）: 送信 MPP の RPC と、Solana の起動時の検査の RPC。URL は値ごと渡すが、使うのはホスト名だけ（ログには出ない）。
    dependencyUrls: [tempoRpcUrl, ...(rails.dependencyUrls ?? [])],
    ...(rails.sellerProofs === undefined ? {} : { sellerProofs: rails.sellerProofs }),
    ...(evm === undefined ? {} : { evmSigning: evm.capability(x402Network) }),
    ...(evm !== undefined && (activation.arc.outbound || evmOutbound.length > 0)
      ? {
          evmSigningByNetwork: {
            ...(activation.arc.outbound ? { [OUTBOUND_ARC.network]: evm.capability(OUTBOUND_ARC.network) } : {}),
            ...Object.fromEntries(evmOutbound.map((chain) => [EVM_TESTNETS[chain].network, evm.capability(EVM_TESTNETS[chain].network)])),
          },
        }
      : {}),
    ...(svm === undefined ? {} : { svmSigning: { [OUTBOUND_SOL.network]: svm.capability(OUTBOUND_SOL.network) } }),
    ...(mppKey === undefined || mppKey === "" ? {} : { mppTempo: createRealMppCapability(mppKey, { chainId: tempoChainId, rpcUrl: tempoRpcUrl }).capability() }),
    ...(facilitatorOrigin === undefined ? {} : { localCounterparties: { origins: [facilitatorOrigin] } }),
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
  if (usesSolana(activation)) {
    const rpc = env[SOLANA_RPC_ENV];
    if (rpc !== undefined && rpc !== "") {
      out[SOLANA_RPC_ENV] = rpc;
      out["ROUTER_SOLANA_RPC_URL"] = rpc;
    }
  }
  // Solana の送信の鍵は `solana.outbound ∨ solanaMpp.outbound` のときだけ読んで渡す（無効なら参照もしない）。
  if (needsSolanaOutboundKey(activation)) {
    const key = env[SOLANA_OUTBOUND_KEY_ENV];
    if (key !== undefined && key !== "") out[SOLANA_OUTBOUND_KEY_ENV] = key;
  }
  return out;
}
