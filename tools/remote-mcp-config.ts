/**
 * 本番の入口（`tools/remote-mcp.ts`）が Router に渡す**設定の生成**。鍵と子プロセスの起動から切り離してある
 * （試験で、どの env を与えても動的機能の有効・無効とプロファイルの構成が変わらないことを確かめる。T13・G-4）。
 * このファイルは Router の SDK に依存しない（試験から import できる）。依存は `@solana/kit` の base58（受取先・Provider の公開鍵の 32 バイトの検査）だけ。
 */
import { getBase58Encoder } from "@solana/kit";


/**
 * 経路 1（既存・変更しない）: **x402 で払って MPP の Provider B に届く**。
 * routeId は既に公開済みなので**改名しない**（審査員の手元の手順が壊れる）。
 */
export const ROUTE = "md-mpp-eth-snapshot";
export const UPSTREAM = "https://provider-mpp.subethalabs.com/v1/eth/snapshot";

/**
 * 経路 2（新規）: **MPP で払って x402 の Provider A に届く**。逆向きの主張。
 * 送信レグに Base Sepolia USDC が要るので、その鍵が無い構成では**登録しない**。
 */
export const ROUTE_MPP_IN = "md-x402-eth-snapshot";
export const UPSTREAM_X402 = "https://provider-x402.subethalabs.com/v1/eth/snapshot";

/** x402 受信（Base Sepolia USDC）。 */
export const INBOUND = {
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "10000",
  facilitator: "https://www.x402.org/facilitator",
} as const;
/** MPP 受信（Tempo pathUSD）。 */
export const INBOUND_MPP = {
  network: "eip155:42431",
  asset: "0x20c0000000000000000000000000000000000000",
  amount: "10000",
} as const;
/** MPP 送信（Provider B）。 */
export const OUTBOUND = {
  network: "eip155:42431",
  asset: "0x20c0000000000000000000000000000000000000",
  payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
} as const;
/** x402 送信（Provider A）。 */
export const OUTBOUND_X402 = {
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1",
} as const;

/* ------------------------------------------------------------------ 多レール（Arc・Solana の受信。multirail 設計 §8、タスク T8-a） */

/**
 * Arc testnet の USDC で払う受信（facilitator は Circle、kind `circle`。表 `KNOWN_NETWORKS` と同じ network・資産）。
 * 受取先は**証明専用の受取鍵の address**（env `SUBETHA_ARC_RECEIVER_KEY` から T8-b の入口が導く。設定には address だけが入る）。
 */
export const INBOUND_ARC = {
  network: "eip155:5042002",
  asset: "0x3600000000000000000000000000000000000000",
  amount: "10000",
  facilitator: { kind: "circle", url: "https://api.circle.com/v1/facilitator/x402" },
} as const;
/**
 * Solana devnet の USDC で払う受信（facilitator は x402.org、kind `x402`、SVM の `exact`）。
 * 受取先は受取 owner の address（鍵はホストに置かない。ATA は運用者が作る。設計 §5.1・T10 G-1）。
 */
export const INBOUND_SOL = {
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  amount: "10000",
  facilitator: { kind: "x402", url: "https://www.x402.org/facilitator" },
} as const;
/** 静的 route（設計 §8・D-6）: Arc USDC → Provider B（MPP）、Solana USDC → Provider A（x402）。 */
export const ROUTE_ARC = "md-mpp-eth-snapshot-arc";
export const ROUTE_SOL = "md-x402-eth-snapshot-sol";

/* ------------------------------------------------------------------ 送信（Arc・Solana の Provider に払う。送信の設計 §6、タスク U5・U9） */

/**
 * Arc の Provider に払う送信（x402、EIP-3009。表 `KNOWN_NETWORKS` と同じ network・資産・domain）。鍵は Base と同じ `SUBETHA_OUTBOUND_X402_KEY`（D-11）。
 * 受取先（Provider の address）は env `SUBETHA_ARC_PROVIDER_PAYTO`（D-10。Provider が立ったら入る）。
 */
export const OUTBOUND_ARC = {
  network: "eip155:5042002",
  asset: "0x3600000000000000000000000000000000000000",
  decimals: 6,
  tokenDomain: { name: "USDC", version: "2" },
} as const;
/** Arc の Provider の URL（D-10。Provider が立つまで空。空なら静的 route は生成しない。動的プロファイルは生成する）。 */
export const UPSTREAM_ARC = "https://provider-x402-arc.subethalabs.com/v1/eth/snapshot";
/** 静的 route（送信の設計 §6.3・D-12）: Base USDC で払って Arc の Provider に届く。 */
export const ROUTE_ARC_OUT = "md-arc-eth-snapshot";
/**
 * Solana の Provider に払う送信（x402 の SVM `exact`。表 `KNOWN_NETWORKS` と同じ network・mint・token program）。鍵は専用の
 * `SUBETHA_OUTBOUND_SOLANA_KEY`（ed25519。`wallet:new:solana` と同じ base58 32 バイトの seed。D-11）。受取先（Provider の owner）は env
 * `SUBETHA_SOLANA_PROVIDER_PAYTO`（D-10。Provider が立ったら入る）。
 */
export const OUTBOUND_SOL = {
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  decimals: 6,
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
} as const;
/** Solana の Provider の URL（D-10。Provider が立つまで空。空なら静的 route は生成しない。動的プロファイルは生成する）。 */
export const UPSTREAM_SOL = "https://provider-x402-sol.subethalabs.com/v1/eth/snapshot";
/** 静的 route（送信の設計 §6.3・D-12 の O-4）: Tempo pathUSD（MPP 受信）で払って Solana の Provider に届く。 */
export const ROUTE_SOL_OUT = "md-sol-eth-snapshot-mpp";

/* ------------------------------------------------------------------ Solana の MPP（受信・送信。`docs/mpp-solana-design.md` §6、タスク M6） */

/**
 * Solana の MPP の Provider D（pay-kit の server。`solana/charge`、pull、**`feePayer: true`** = Provider の fee payer が送出する。Router が発行する受信の challenge は `feePayer: false`）の URL。
 * **G-1″（2026-10-08）**: owner が `providers/mpp-solana-workers/` を Cloudflare Workers に配備（`docs/provider-mpp-solana-workers.md` §9・§10、`docs/DEPLOY.md` §2d）。
 * 空なら静的の送信 route は生成しない（動的プロファイルは生成する）。受取 owner は env `SUBETHA_SOLANA_MPP_PROVIDER_PAYTO`（`solanaMpp.outbound` ∧ URL ≠ "" のときだけ読む。D-10 と同じ規則）。
 * 送信の有効化（`RAILS_ACTIVATION.solanaMpp.outbound`）は G-4″ まで `false` のまま。
 */
export const UPSTREAM_SOL_MPP = "https://provider-mpp-sol.subethalabs.com/v1/eth/snapshot";
/** 静的 route（設計 §6.3）: Solana USDC（MPP）で払って Provider A（x402）に届く。 */
export const ROUTE_SOLMPP_TO_X402 = "md-x402-eth-snapshot-solmpp";
/** 静的 route（設計 §6.3）: Solana USDC（MPP）で払って Provider B（MPP）に届く。 */
export const ROUTE_SOLMPP_TO_MPP = "md-mpp-eth-snapshot-solmpp";
/** 静的 route（設計 §6.3）: Base USDC（x402）で払って Provider D（Solana の MPP）に届く。 */
export const ROUTE_SOLMPP_OUT = "md-solmpp-eth-snapshot";
/** 静的 route（設計 §6.3）: Tempo pathUSD（MPP）で払って Provider D（Solana の MPP）に届く。 */
export const ROUTE_SOLMPP_OUT_MPP = "md-solmpp-eth-snapshot-mpp";
/** MPP Solana の宛先の `scheme`（`src/config.ts` の `MPP_SOLANA_SCHEME` と同じ文字列。このファイルは Router の SDK に依存しない）。 */
const SOLANA_MPP_SCHEME = "solana/charge";

/** 1 つのレールの有効化（方向別。送信の設計 §6.1、FR-30）。 */
export interface RailActivation {
  readonly inbound: boolean;
  readonly outbound: boolean;
}
/**
 * どのレール・どの方向を登録するか。T8-b の入口（公開の process・受け入れ用の起動）と設定生成の**両方**がこの 1 つの値を見る。
 * 受信（`inbound`）は route・プロファイルの source、送信（`outbound`）は destination。独立に切り替えられる（受信有効・送信無効を保てる）。
 */
export interface RailsActivation {
  readonly arc: RailActivation;
  /** Solana の **x402**（受信: SVM `exact` の facilitator、送信: Router の鍵で SVM `exact`）。 */
  readonly solana: RailActivation;
  /**
   * Solana の **MPP**（受信: `solana/charge` の challenge を Router が発行して送出、送信: Provider D に `solana/charge` で払う。`docs/mpp-solana-design.md` §6.1）。
   * x402 の `solana` とは独立に切り替える。同じ受取 owner・同じ送信鍵・同じ RPC・同じ Solana USDC の予算の区分を共有する。
   */
  readonly solanaMpp: RailActivation;
  /**
   * **組の切り替え**（送信の要件 §11・設計 §13、D-17 の決定 2026-10-09）: Arc x402 ↔ Solana x402 の動的プロファイル `dyn-arc-to-sol`・`dyn-sol-to-arc` を出すか。
   * 無ければ両方 `false`。組だけでは何も動かない（能力・鍵・env はレールの方向で決まり、`railActive` も見ない）。組が `true` で必要なレールの方向が無ければ設定生成は固定文で止まる（FR-41）。
   */
  readonly pairs?: PairsActivation;
  /**
   * EVM testnet 3 つ（Robinhood Chain testnet・Arbitrum Sepolia・HyperEVM testnet）の x402（hosted 設計 `docs/evm-testnets-hosted-design.md` §5、FR-H6）。
   * チェーン × 方向。無ければ全部 `false`（`evmOf`）。受信は自前の facilitator（env `SUBETHA_EVM_FACILITATOR_URL`）、送信は Arc と同じ x402 の送信鍵（D-11）。
   * 出すのは動的プロファイルだけ（静的 route は足さない）。Ethereum Sepolia は対象外。
   */
  readonly evm?: EvmRailsActivation;
}
/** hosted に出す EVM testnet 3 つの短縮名（プロファイル id・内部 env の token の語幹）。値は `EVM_TESTNETS` の同じ名前。 */
export type HostedEvmChain = "rh" | "arbsep" | "hyperevm";
export const HOSTED_EVM_CHAINS: readonly HostedEvmChain[] = Object.freeze(["rh", "arbsep", "hyperevm"]);
/** EVM testnet 3 つの有効化（チェーンごと・方向ごと）。 */
export type EvmRailsActivation = Readonly<Record<HostedEvmChain, RailActivation>>;
/** `evm` の既定（無ければ全部 `false`）。 */
export function evmOf(activation: RailsActivation): EvmRailsActivation {
  return activation.evm ?? EVM_NONE;
}
/** Arc x402 ↔ Solana x402 の組（方向別。内部 env の token は `arc-to-sol`・`sol-to-arc`）。 */
export interface PairsActivation {
  /** `dyn-arc-to-sol`: Arc USDC（x402）で払って Solana の x402 Provider へ。`arc.inbound ∧ solana.outbound` が要る。 */
  readonly arcToSol: boolean;
  /** `dyn-sol-to-arc`: Solana USDC（x402）で払って Arc の x402 Provider へ。`solana.inbound ∧ arc.outbound` が要る。 */
  readonly solToArc: boolean;
}
export const PAIRS_NONE: PairsActivation = Object.freeze({ arcToSol: false, solToArc: false });
/** `pairs` の既定（無ければ両方 `false`）。 */
export function pairsOf(activation: RailsActivation): PairsActivation {
  return activation.pairs ?? PAIRS_NONE;
}
/** 受取先（受信が有効なレールの分だけ要る）。Arc は証明専用の受取鍵の address、Solana は受取 owner の address。 */
export interface RailReceivers {
  readonly arc?: string;
  readonly solana?: string;
}
/** Provider の受取先（送信が有効で静的 route を出すときだけ要る。D-10）。Arc は `0x`、Solana（x402 の Provider と MPP の Provider D）は owner の公開鍵。 */
export interface RailProviders {
  readonly arc?: string;
  readonly solana?: string;
  /** Provider D（Solana の MPP）の受取 owner。`solanaMpp.outbound` ∧ `UPSTREAM_SOL_MPP` ≠ "" のときだけ。 */
  readonly solanaMpp?: string;
}
/** Provider の URL（レールごと。本番は定数 `UPSTREAM_ARC`・`UPSTREAM_SOL`・`UPSTREAM_SOL_MPP`。試験が静的 route の生成を確かめるために差し替えられる）。 */
export interface RailUpstreams {
  readonly arc: string;
  readonly solana: string;
  readonly solanaMpp: string;
}
export const RAIL_UPSTREAMS: RailUpstreams = Object.freeze({ arc: UPSTREAM_ARC, solana: UPSTREAM_SOL, solanaMpp: UPSTREAM_SOL_MPP });
export interface RailsOptions {
  readonly activation: RailsActivation;
  readonly receivers: RailReceivers;
  readonly providers?: RailProviders;
  /** 無ければ `RAIL_UPSTREAMS`（定数）。 */
  readonly upstreams?: RailUpstreams;
}
const RAIL_OFF: RailActivation = Object.freeze({ inbound: false, outbound: false });
/** EVM testnet 3 つがすべて無効（`evm` の既定）。 */
export const EVM_NONE: EvmRailsActivation = Object.freeze({ rh: RAIL_OFF, arbsep: RAIL_OFF, hyperevm: RAIL_OFF });
/**
 * 公開の process の有効化。受信は **2026-10-07 に両方 `true`**（T10 の G-4。`docs/DEPLOY.md` §2c の記録）。
 * 送信は **2026-10-08 に両方 `true`**（UG-A・UG-S の G-4′。`docs/DEPLOY.md` §2c の記録。送信の設計 §6.1）。env からは変えられない。戻すのはここ（イメージを作り直して入れ替える）。
 */
export const RAILS_ACTIVATION: RailsActivation = Object.freeze({
  arc: Object.freeze({ inbound: true, outbound: true }),
  solana: Object.freeze({ inbound: true, outbound: true }),
  /** Solana の MPP: **2026-10-08 に両方 `true`**（G-4″。owner の決定「両方進めていただきたい」。G-3″ で受信 3 件・送信 3 件が delivered。`docs/DEPLOY.md` §2d）。戻すのはここ（イメージを作り直して入れ替える）。 */
  solanaMpp: Object.freeze({ inbound: true, outbound: true }),
  /** Arc x402 ↔ Solana x402 の組: **2026-10-08 に両方 `true`**（G-4⁗。owner の決定。G-3⁗ で O-5・O-6 を各 1 件 delivered。`docs/DEPLOY.md` §2c-2）。戻すのはここ（イメージを作り直して入れ替える）。 */
  pairs: Object.freeze({ arcToSol: true, solToArc: true }),
  /**
   * EVM testnet 3 つ（Robinhood・Arbitrum Sepolia・HyperEVM）: **2026-10-14 に全部 `true`**（G-4。owner の依頼 2026-10-13・Q-3/Q-4。G-3 で 3 チェーンとも受信・送信が本番の env で delivered:
   * `docs/DEPLOY.md` §2g の記録）。戻すのは `EVM_NONE` に（イメージを作り直して入れ替える）。
   */
  evm: Object.freeze({
    rh: Object.freeze({ inbound: true, outbound: true }),
    arbsep: Object.freeze({ inbound: true, outbound: true }),
    hyperevm: Object.freeze({ inbound: true, outbound: true }),
  }),
});
/** すべて無効（設定生成の既定の引数。有効化は呼び出し側が明示する）。 */
export const RAILS_NONE: RailsActivation = Object.freeze({ arc: RAIL_OFF, solana: RAIL_OFF, solanaMpp: RAIL_OFF });
export const RAILS_DISABLED: RailsOptions = Object.freeze({ activation: RAILS_NONE, receivers: Object.freeze({}) });
/** どれか 1 つでも有効か（受け入れ用の起動の「少なくとも 1 つ」の判定）。 */
export function railActive(activation: RailsActivation): boolean {
  return [activation.arc, activation.solana, activation.solanaMpp].some((rail) => rail.inbound || rail.outbound);
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** base58 で **32 バイトに復号できる**公開鍵か（文字数だけでは決めない: 33 個の 1 は 33 バイト）。 */
function isBase58PublicKey(value: string): boolean {
  if (!BASE58_PATTERN.test(value)) return false;
  try {
    return getBase58Encoder().encode(value).length === 32;
  } catch {
    return false;
  }
}

/** **受信**が有効なレールの受取先を取り出す。無い・形が違うなら起動しない（値は出さない）。送信だけ有効なら読まない。`"solana"` は **x402** の受信（`solana.inbound`）。 */
function receiverOf(rails: RailsOptions, rail: "arc" | "solana"): string | undefined {
  if (!rails.activation[rail].inbound) return undefined;
  const value = rails.receivers[rail];
  const wellFormed = typeof value === "string" && (rail === "arc" ? EVM_ADDRESS.test(value) : isBase58PublicKey(value));
  if (!wellFormed) {
    throw new Error(`the ${rail} rail is activated but its receiver address is missing or malformed`);
  }
  return value;
}
/**
 * Solana の **MPP** 受信の受取 owner（設計 §6.2）: `solanaMpp.inbound` のときだけ、x402 の受信と**同じ値**（`receivers.solana`）を返す。
 * 述語を `receiverOf(rails, "solana")` と分けるのは、受取 owner があるだけで x402 の route（`md-x402-eth-snapshot-sol` と `dyn-sol-to-*`）が出ないようにするため。
 */
function solanaMppReceiverOf(rails: RailsOptions): string | undefined {
  if (!rails.activation.solanaMpp.inbound) return undefined;
  const value = rails.receivers.solana;
  if (typeof value !== "string" || !isBase58PublicKey(value)) {
    throw new Error("the solana mpp rail is activated but its receiver address is missing or malformed");
  }
  return value;
}
/**
 * **送信**が有効で、Provider の URL が定数に入っているときの Provider の受取先（静的 route の `destination.payTo`）。
 * URL が空（Provider が立っていない）なら静的 route を出さないので読まない。URL があるのに受取先が無い・形が違うなら起動しない。
 */
function providerOf(rails: RailsOptions, rail: "arc" | "solana" | "solanaMpp", upstream: string): string | undefined {
  if (!rails.activation[rail].outbound || upstream === "") return undefined;
  const value = rails.providers?.[rail];
  const wellFormed = typeof value === "string" && (rail === "arc" ? EVM_ADDRESS.test(value) : isBase58PublicKey(value));
  if (!wellFormed) {
    throw new Error(`the ${rail === "solanaMpp" ? "solana mpp" : rail} outbound rail is activated with an upstream URL but the provider pay-to address is missing or malformed`);
  }
  return value;
}

/** 本番の公開ホスト名（`docs/DEPLOY.md`）。動的上流 URL の拒否ホストに入れる（自分自身には向けない）。 */
export const PUBLIC_HOSTNAME = "router.subethalabs.com";

/**
 * 動的上流 URL の手数料・上限（G-1。owner が 2026-10-06 に決定。手数料の決め方は `docs/dynamic-gas-fee-design.md`）。
 * - x402 送信（Router にチェーン手数料がかからない）: 定額 1,000（0.001）
 * - MPP 送信（Router が Tempo の手数料を払う）: quote の時点でその送金のガス代（gas × maxFeePerGas）を見積もり、
 *   cap = ceil(bound × feeMargin / 10000)（`feeMargin` 20,000 = 2 倍。仮の値——quote 時と purchase 時の bound を本番で並べてから見直す）、
 *   手数料 = max(定額 1,000, cap)。cap が天井 `maxFee` 50,000（0.05。署名前の上限の実測 79〜706 の約 70 倍）を超える quote は出さない。
 *   呼び出し側が先に払う手数料 ≥ 署名時の上限、を quote ごとに保つ（設計 §2・§3）。
 *   単価は Router が決める（priority 1 wei、`maxFeePerGas = ceil(2.4 × baseFee) + 1`。設計 §8）。
 *   「チェーンが請求する額が署名時の上限以下」という Tempo 側の前提は 2026-10-06 に仕様とノードのソース（v1.16.0）で確立した（設計 §7）。
 */
const DYNAMIC_MAX_FEE_CEILING = "50000";
const DYNAMIC_FEE_MARGIN_BPS = 20_000;
const DYNAMIC_FEE_X402_OUT = { flat: "1000", bps: 0, min: "1000" } as const;
const DYNAMIC_FEE_MPP_OUT = { flat: "1000", bps: 0, min: "1000" } as const;
const DYNAMIC_MAX_UPSTREAM_AMOUNT = "10000";
/**
 * 動的予算の 1 件の上限（`dynamic.budget.buckets[].maxPerPurchase`）。区分は (network, asset) で、1 件の予約は源（上流の上限 + 手数料）と
 * 宛先（上流の上限）の区分ごとの**合算**で見る（`src/core/dynamic.ts` の `perPurchaseLimitOf`、要件 FR-43）。
 * 両レグが別の区分なら片レグの最大 = 11,000（手数料が規則の額のとき。Tempo 宛の MPP は gas の cap が手数料を押し上げ得て、
 * 上流 10,000 のとき cap > 10,000 は 20,000 を超えて `per_purchase_limit`）で、20,000 は余裕。**x402 Solana ↔ MPP Solana の組**（`dyn-solmpp-to-sol`・`dyn-sol-to-solmpp`。行列 I-4・O-10）だけは
 * 両レグが同じ Solana USDC の区分に落ちるので、その区分の上限は両レグの合計 10,000 + 1,000 + 10,000 = 21,000。
 * G-4″ の AC-18（2026-10-08）で、この 2 組の quote が `per_purchase_limit` で止まって見つかった（`docs/DEPLOY.md` §2d）。
 */
const DYNAMIC_MAX_PER_PURCHASE = "20000";
const DYNAMIC_MAX_PER_PURCHASE_SOL = String(
  2n * BigInt(DYNAMIC_MAX_UPSTREAM_AMOUNT) + (BigInt(DYNAMIC_FEE_X402_OUT.flat) > BigInt(DYNAMIC_FEE_MPP_OUT.flat) ? BigInt(DYNAMIC_FEE_X402_OUT.flat) : BigInt(DYNAMIC_FEE_MPP_OUT.flat)),
);

/**
 * MPP 送信のプロファイルを登録するか。**2026-10-06 に `true`**（G-4 の 2 回目、owner の決定「1 も 2 も進めましょう」）。
 * `docs/DEPLOY.md` §2b の条件 6 の前提: 手数料の仕様の確立（`docs/dynamic-gas-fee-design.md` §7、ノード v1.16.0）、Router の単価での testnet の試行の成立（同 §8.5、2026-10-06 09:26Z、
 * Tempo tx `0xd858ac56…bfd2`）、起動時の `eth_fillTransaction` の確認。ノードの版名が変わるか hardfork が有効になったら §7 を読み直す。戻すのはここを `false` に。
 */
const MPP_OUTBOUND_PROFILE_ENABLED = true;

/**
 * 登録する動的プロファイル。1 つも無ければ `undefined`（`dynamic` の節を書かない。空の `profiles` は設定の検証が拒否する）。
 * x402 送信（`dyn-mpp-to-x402`）は MPP 受信の秘密と x402 送信の鍵がそろっているとき（経路 2 と同じ条件）だけ。
 */
export function dynamicProfilesOf(env: Readonly<Record<string, string | undefined>>, receiver: string, mppInboundEnabled: boolean, rails: RailsOptions = RAILS_DISABLED): Record<string, unknown> | undefined {
  void env;
  const arcReceiver = receiverOf(rails, "arc");
  const solReceiver = receiverOf(rails, "solana");
  const solMppReceiver = solanaMppReceiverOf(rails);
  /** 新しいレールの source から x402・MPP の送信へ（par 1:1、手数料は既存の規則）。`sourceRail` は既定 x402（Solana の MPP 受信は `"mpp"`）。 */
  const toMpp = (profileId: string, source: { network: string; asset: string }, payTo: string, sourceRail: "x402" | "mpp" = "x402"): Record<string, unknown> => ({
    profileId,
    sourceRail,
    source: { network: source.network, asset: source.asset, decimals: 6, payTo },
    rail: "mpp",
    destination: { scheme: "tempo/charge", network: OUTBOUND.network, asset: OUTBOUND.asset, decimals: 6, feeAsset: OUTBOUND.asset, maxFee: DYNAMIC_MAX_FEE_CEILING, feeMargin: DYNAMIC_FEE_MARGIN_BPS },
    par: true,
    maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
    fee: DYNAMIC_FEE_MPP_OUT,
  });
  const toX402 = (profileId: string, source: { network: string; asset: string }, payTo: string, sourceRail: "x402" | "mpp" = "x402"): Record<string, unknown> => ({
    profileId,
    sourceRail,
    source: { network: source.network, asset: source.asset, decimals: 6, payTo },
    rail: "x402",
    destination: { scheme: "exact", network: OUTBOUND_X402.network, asset: OUTBOUND_X402.asset, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
    par: true,
    maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
    fee: DYNAMIC_FEE_X402_OUT,
  });
  /** Arc の Provider へ（送信の設計 §6.3・D-12）: Base x402 で払う、Tempo MPP で払う（MPP 受信があるときだけ）。 */
  const toArc = (profileId: string, sourceRail: "x402" | "mpp", source: { network: string; asset: string }, payTo: string = receiver): Record<string, unknown> => ({
    profileId,
    sourceRail,
    source: { network: source.network, asset: source.asset, decimals: 6, payTo },
    rail: "x402",
    destination: { scheme: "exact", network: OUTBOUND_ARC.network, asset: OUTBOUND_ARC.asset, decimals: OUTBOUND_ARC.decimals, tokenDomain: { ...OUTBOUND_ARC.tokenDomain } },
    par: true,
    maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
    fee: DYNAMIC_FEE_X402_OUT,
  });
  /** Solana の Provider へ（送信の設計 §6.3・D-12 の O-3・O-4）: 宛先は表の mint・桁・token program（`tokenDomain` は無い）。 */
  const toSol = (profileId: string, sourceRail: "x402" | "mpp", source: { network: string; asset: string }, payTo: string = receiver): Record<string, unknown> => ({
    profileId,
    sourceRail,
    source: { network: source.network, asset: source.asset, decimals: 6, payTo },
    rail: "x402",
    destination: { scheme: "exact", network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, decimals: OUTBOUND_SOL.decimals, tokenProgram: OUTBOUND_SOL.tokenProgram },
    par: true,
    maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
    fee: DYNAMIC_FEE_X402_OUT,
  });
  /**
   * Solana の MPP の Provider へ（`docs/mpp-solana-design.md` §6.3・§1.4）: 宛先は `solana/charge` と表の mint・桁・token program。**`feeAsset`・`maxFee`・`feeMargin` は無い**
   * （Router はこの送信にチェーン手数料を払わない: Provider の fee payer が送出する。設定の読み込みが 3 欄を禁じる）。手数料は MPP 送信と同じ規則（定額 1,000）。
   */
  const toSolMpp = (profileId: string, sourceRail: "x402" | "mpp", source: { network: string; asset: string }, payTo: string = receiver): Record<string, unknown> => ({
    profileId,
    sourceRail,
    source: { network: source.network, asset: source.asset, decimals: 6, payTo },
    rail: "mpp",
    destination: { scheme: SOLANA_MPP_SCHEME, network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, decimals: OUTBOUND_SOL.decimals, tokenProgram: OUTBOUND_SOL.tokenProgram },
    par: true,
    maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
    fee: DYNAMIC_FEE_MPP_OUT,
  });
  const arcOutbound = rails.activation.arc.outbound;
  const solOutbound = rails.activation.solana.outbound;
  const solMppOutbound = rails.activation.solanaMpp.outbound;
  // Arc x402 ↔ Solana x402 の組（送信の要件 §11 FR-40・FR-41、設計 §13.2）: 組が true なのに必要なレールの方向が無ければ固定文で止まる（黙って出さない、はしない）。
  const pairs = pairsOf(rails.activation);
  if (pairs.arcToSol && (arcReceiver === undefined || !solOutbound)) throw new Error("pair arc-to-sol requires arc.inbound (its receiver) and solana.outbound");
  if (pairs.solToArc && (solReceiver === undefined || !arcOutbound)) throw new Error("pair sol-to-arc requires solana.inbound (its receiver) and arc.outbound");
  const profiles: Record<string, unknown> = {
    // O-5・O-6（D-17 の決定 2026-10-09。動的だけ。宛先は既存の toSol／toArc と同じ表の値、par 1:1、手数料は定額 1,000）。
    ...(pairs.arcToSol ? { "dyn-arc-to-sol": toSol("dyn-arc-to-sol", "x402", INBOUND_ARC, arcReceiver) } : {}),
    ...(pairs.solToArc ? { "dyn-sol-to-arc": toArc("dyn-sol-to-arc", "x402", INBOUND_SOL, solReceiver) } : {}),
    // Solana の MPP 受信から（設計 §6.3）: Base x402 は常に、Tempo MPP は `MPP_OUTBOUND_PROFILE_ENABLED`、Arc・Solana の x402 はそのレールの送信が有効なとき。
    ...(solMppReceiver === undefined
      ? {}
      : {
          "dyn-solmpp-to-x402": toX402("dyn-solmpp-to-x402", INBOUND_SOL, solMppReceiver, "mpp"),
          ...(MPP_OUTBOUND_PROFILE_ENABLED ? { "dyn-solmpp-to-mpp": toMpp("dyn-solmpp-to-mpp", INBOUND_SOL, solMppReceiver, "mpp") } : {}),
          ...(arcOutbound ? { "dyn-solmpp-to-arc": toArc("dyn-solmpp-to-arc", "mpp", INBOUND_SOL, solMppReceiver) } : {}),
          ...(solOutbound ? { "dyn-solmpp-to-sol": toSol("dyn-solmpp-to-sol", "mpp", INBOUND_SOL, solMppReceiver) } : {}),
        }),
    // Solana の MPP の Provider へ（設計 §6.3）: Base x402 は常に、Tempo MPP は MPP 受信があるとき、Arc・Solana の x402 はそのレールの受信が有効なとき。
    ...(solMppOutbound ? { "dyn-x402-to-solmpp": toSolMpp("dyn-x402-to-solmpp", "x402", INBOUND) } : {}),
    ...(solMppOutbound && mppInboundEnabled ? { "dyn-mpp-to-solmpp": toSolMpp("dyn-mpp-to-solmpp", "mpp", INBOUND_MPP) } : {}),
    ...(solMppOutbound && arcReceiver !== undefined ? { "dyn-arc-to-solmpp": toSolMpp("dyn-arc-to-solmpp", "x402", INBOUND_ARC, arcReceiver) } : {}),
    ...(solMppOutbound && solReceiver !== undefined ? { "dyn-sol-to-solmpp": toSolMpp("dyn-sol-to-solmpp", "x402", INBOUND_SOL, solReceiver) } : {}),
    // 多レール（設計 §8）: 受信が有効なレールの分だけ。公開の process は `RAILS_ACTIVATION`（G-4 で受信は両方 true）。
    ...(arcReceiver === undefined ? {} : { "dyn-arc-to-mpp": toMpp("dyn-arc-to-mpp", INBOUND_ARC, arcReceiver), "dyn-arc-to-x402": toX402("dyn-arc-to-x402", INBOUND_ARC, arcReceiver) }),
    ...(solReceiver === undefined ? {} : { "dyn-sol-to-x402": toX402("dyn-sol-to-x402", INBOUND_SOL, solReceiver), "dyn-sol-to-mpp": toMpp("dyn-sol-to-mpp", INBOUND_SOL, solReceiver) }),
    // 送信（Arc の Provider へ。送信の設計 §6.3）: 送信が有効なときだけ。Provider の受取先は要らない（呼び出し側の URL が決める）。
    ...(arcOutbound ? { "dyn-x402-to-arc": toArc("dyn-x402-to-arc", "x402", INBOUND) } : {}),
    ...(arcOutbound && mppInboundEnabled ? { "dyn-mpp-to-arc": toArc("dyn-mpp-to-arc", "mpp", INBOUND_MPP) } : {}),
    // 送信（Solana の Provider へ。送信の設計 §6.3）: 送信が有効なときだけ。公開する組は O-3（Base x402 → Solana）・O-4（Tempo MPP → Solana）。
    ...(solOutbound ? { "dyn-x402-to-sol": toSol("dyn-x402-to-sol", "x402", INBOUND) } : {}),
    ...(solOutbound && mppInboundEnabled ? { "dyn-mpp-to-sol": toSol("dyn-mpp-to-sol", "mpp", INBOUND_MPP) } : {}),
    ...(MPP_OUTBOUND_PROFILE_ENABLED
      ? {
          "dyn-x402-to-mpp": {
            profileId: "dyn-x402-to-mpp",
            sourceRail: "x402",
            source: { network: INBOUND.network, asset: INBOUND.asset, decimals: 6, payTo: receiver },
            rail: "mpp",
            destination: {
              scheme: "tempo/charge",
              network: OUTBOUND.network,
              asset: OUTBOUND.asset,
              decimals: 6,
              feeAsset: OUTBOUND.asset,
              maxFee: DYNAMIC_MAX_FEE_CEILING,
              feeMargin: DYNAMIC_FEE_MARGIN_BPS,
            },
            par: true,
            maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
            fee: DYNAMIC_FEE_MPP_OUT,
          },
        }
      : {}),
    ...(mppInboundEnabled
      ? {
          "dyn-mpp-to-x402": {
            profileId: "dyn-mpp-to-x402",
            sourceRail: "mpp",
            source: { network: INBOUND_MPP.network, asset: INBOUND_MPP.asset, decimals: 6, payTo: receiver },
            rail: "x402",
            destination: { scheme: "exact", network: OUTBOUND_X402.network, asset: OUTBOUND_X402.asset, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
            par: true,
            maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
            fee: DYNAMIC_FEE_X402_OUT,
          },
        }
      : {}),
    // EVM testnet 3 つ（hosted 設計 §5）: 既存の 20 本の後ろに足すだけ（既存の id・値・順は変えない。`evm` が無い・全部 false なら 1 本も出ない）。
    ...evmProfilesOf({ receiver, mppInboundEnabled, arcReceiver, solReceiver, solMppReceiver, arcOutbound, solOutbound, solMppOutbound, evm: evmOf(rails.activation) }, { toX402, toMpp, toArc, toSol, toSolMpp }),
  };
  return Object.keys(profiles).length === 0 ? undefined : profiles;
}

/** 動的プロファイルの源・宛先の端点（hosted 設計 §5）。既存は `x402`（Base）・`mpp`（Tempo）・`arc`・`sol`・`solmpp`、新 3 は短縮名。 */
type ProfileEndpoint = "x402" | "mpp" | "arc" | "sol" | "solmpp" | HostedEvmChain;
type ProfileBuilder = (profileId: string, source: { network: string; asset: string }, payTo: string, sourceRail: "x402" | "mpp") => Record<string, unknown>;
interface ExistingBuilders {
  readonly toX402: (profileId: string, source: { network: string; asset: string }, payTo: string, sourceRail?: "x402" | "mpp") => Record<string, unknown>;
  readonly toMpp: (profileId: string, source: { network: string; asset: string }, payTo: string, sourceRail?: "x402" | "mpp") => Record<string, unknown>;
  readonly toArc: (profileId: string, sourceRail: "x402" | "mpp", source: { network: string; asset: string }, payTo?: string) => Record<string, unknown>;
  readonly toSol: (profileId: string, sourceRail: "x402" | "mpp", source: { network: string; asset: string }, payTo?: string) => Record<string, unknown>;
  readonly toSolMpp: (profileId: string, sourceRail: "x402" | "mpp", source: { network: string; asset: string }, payTo?: string) => Record<string, unknown>;
}
interface EvmProfileInputs {
  readonly receiver: string;
  readonly mppInboundEnabled: boolean;
  readonly arcReceiver: string | undefined;
  readonly solReceiver: string | undefined;
  readonly solMppReceiver: string | undefined;
  readonly arcOutbound: boolean;
  readonly solOutbound: boolean;
  readonly solMppOutbound: boolean;
  readonly evm: EvmRailsActivation;
}

/**
 * EVM testnet 3 つの動的プロファイル（hosted 設計 §5、FR-H5）。源の集合 S × 宛先の集合 D のうち、**どちらかが新 3** で、源と宛先が同じ端点でないもの。
 * - S: `x402`（Base。常に）・`mpp`（Tempo。MPP 受信が有効）・`arc`・`sol`・`solmpp`（各受信が有効 = 受取先がある）・`evm[c].inbound` の c
 * - D: `x402`（Base。常に）・`mpp`（Tempo。`MPP_OUTBOUND_PROFILE_ENABLED`）・`arc`・`sol`・`solmpp`（各送信が有効）・`evm[c].outbound` の c
 * 条件は既存のビルダーが出る条件と同じ（例: Tempo 宛は `MPP_OUTBOUND_PROFILE_ENABLED` だけ、`dyn-x402-to-mpp` と同じ）。
 * 新 3 宛: `rail: "x402"`、`exact`・表の資産と domain、手数料 定額 1,000、上流の上限 10,000、par。新 3 からの既存宛: 既存のビルダーに `sourceRail: "x402"`・受取先 `receiver`。
 * 順は S の順 × D の順（決定的。既存の 20 本の後ろ）。
 */
function evmProfilesOf(inputs: EvmProfileInputs, builders: ExistingBuilders): Record<string, unknown> {
  const { receiver, evm } = inputs;
  const newChains = HOSTED_EVM_CHAINS;
  if (!newChains.some((chain) => evm[chain].inbound || evm[chain].outbound)) return {};
  const isNew = (endpoint: ProfileEndpoint): endpoint is HostedEvmChain => (newChains as readonly string[]).includes(endpoint);
  /** 源: 端点 → (network・資産・受取先・sourceRail)。無効な源は入れない。 */
  const sources: [ProfileEndpoint, { network: string; asset: string }, string, "x402" | "mpp"][] = [
    ["x402", INBOUND, receiver, "x402"],
    ...(inputs.mppInboundEnabled ? [["mpp", INBOUND_MPP, receiver, "mpp"] as [ProfileEndpoint, { network: string; asset: string }, string, "x402" | "mpp"]] : []),
    ...(inputs.arcReceiver === undefined ? [] : [["arc", INBOUND_ARC, inputs.arcReceiver, "x402"] as [ProfileEndpoint, { network: string; asset: string }, string, "x402" | "mpp"]]),
    ...(inputs.solReceiver === undefined ? [] : [["sol", INBOUND_SOL, inputs.solReceiver, "x402"] as [ProfileEndpoint, { network: string; asset: string }, string, "x402" | "mpp"]]),
    ...(inputs.solMppReceiver === undefined ? [] : [["solmpp", INBOUND_SOL, inputs.solMppReceiver, "mpp"] as [ProfileEndpoint, { network: string; asset: string }, string, "x402" | "mpp"]]),
    ...newChains.filter((chain) => evm[chain].inbound).map((chain) => [chain, EVM_TESTNETS[chain], receiver, "x402"] as [ProfileEndpoint, { network: string; asset: string }, string, "x402" | "mpp"]),
  ];
  /** 新 3 宛（hosted 設計 §5）: 表の資産と EIP-712 domain。Router はチェーン手数料を払わない（`maxFee` は無い）。 */
  const toEvm = (chain: HostedEvmChain): ProfileBuilder => (profileId, source, payTo, sourceRail) => ({
    profileId,
    sourceRail,
    source: { network: source.network, asset: source.asset, decimals: 6, payTo },
    rail: "x402",
    destination: { scheme: "exact", network: EVM_TESTNETS[chain].network, asset: EVM_TESTNETS[chain].asset, decimals: 6, tokenDomain: { ...EVM_TESTNETS[chain].domain } },
    par: true,
    maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
    fee: DYNAMIC_FEE_X402_OUT,
  });
  /** 宛先: 端点 → ビルダー。無効な宛先は入れない。既存のビルダーの引数の順の違いはここで揃える。 */
  const destinations: [ProfileEndpoint, ProfileBuilder][] = [
    ["x402", (id, source, payTo, sourceRail) => builders.toX402(id, source, payTo, sourceRail)],
    ...(MPP_OUTBOUND_PROFILE_ENABLED ? [["mpp", (id, source, payTo, sourceRail) => builders.toMpp(id, source, payTo, sourceRail)] as [ProfileEndpoint, ProfileBuilder]] : []),
    ...(inputs.arcOutbound ? [["arc", (id, source, payTo, sourceRail) => builders.toArc(id, sourceRail, source, payTo)] as [ProfileEndpoint, ProfileBuilder]] : []),
    ...(inputs.solOutbound ? [["sol", (id, source, payTo, sourceRail) => builders.toSol(id, sourceRail, source, payTo)] as [ProfileEndpoint, ProfileBuilder]] : []),
    ...(inputs.solMppOutbound ? [["solmpp", (id, source, payTo, sourceRail) => builders.toSolMpp(id, sourceRail, source, payTo)] as [ProfileEndpoint, ProfileBuilder]] : []),
    ...newChains.filter((chain) => evm[chain].outbound).map((chain) => [chain, toEvm(chain)] as [ProfileEndpoint, ProfileBuilder]),
  ];
  const out: Record<string, unknown> = {};
  for (const [s, source, payTo, sourceRail] of sources) {
    for (const [d, build] of destinations) {
      // どちらかが新 3（既存 × 既存は既存の 20 本のまま）、同じ端点どうし（新 × 新の同じチェーン）は除く。
      if (!isNew(s) && !isNew(d)) continue;
      if (s === d) continue;
      const profileId = `dyn-${s}-to-${d}`;
      out[profileId] = build(profileId, source, payTo, sourceRail);
    }
  }
  return out;
}

/**
 * 本番の入口が Router に渡す設定。**鍵と子プロセスの起動から切り離した純粋関数**。動的機能の有効・無効と
 * プロファイルの構成はこの関数と `MPP_OUTBOUND_PROFILE_ENABLED` だけで決まり、env からは変えられない（予算の額・件数と追加の拒否ホストは env）。
 */
export function routerConfigOf(env: Readonly<Record<string, string | undefined>>, receiver: string, mppInboundEnabled: boolean, rails: RailsOptions = RAILS_DISABLED): Record<string, unknown> {
  const arcReceiver = receiverOf(rails, "arc");
  const solReceiver = receiverOf(rails, "solana");
  const upstreamArc = (rails.upstreams ?? RAIL_UPSTREAMS).arc;
  const arcProvider = providerOf(rails, "arc", upstreamArc);
  const arcOutbound = rails.activation.arc.outbound;
  const upstreamSol = (rails.upstreams ?? RAIL_UPSTREAMS).solana;
  // 静的の Solana 送信（O-4）は MPP 受信が源なので、MPP 受信が無い構成では URL があっても出さない（受取先も読まない）。
  const solProvider = mppInboundEnabled ? providerOf(rails, "solana", upstreamSol) : undefined;
  const solOutbound = rails.activation.solana.outbound;
  // Solana の MPP（設計 §6.3）: 受信の受取 owner は x402 と同じ値（別の述語）、Provider D の受取 owner は URL（定数。Provider D が立つまで空）があるときだけ。
  const solMppReceiver = solanaMppReceiverOf(rails);
  const upstreamSolMpp = (rails.upstreams ?? RAIL_UPSTREAMS).solanaMpp;
  const solMppProvider = providerOf(rails, "solanaMpp", upstreamSolMpp);
  const solMppOutbound = rails.activation.solanaMpp.outbound;
  // EVM testnet 3 つ（hosted 設計 §5）: 受信のある chain は自前の facilitator（env）。受信が 1 つでもあって env が無ければ固定文で止まる（値は出さない）。
  const evm = evmOf(rails.activation);
  const evmInbound = HOSTED_EVM_CHAINS.filter((chain) => evm[chain].inbound);
  const evmUsed = HOSTED_EVM_CHAINS.filter((chain) => evm[chain].inbound || evm[chain].outbound);
  const evmFacilitatorUrl = env[EVM_FACILITATOR_URL_ENV];
  if (evmInbound.length > 0 && (evmFacilitatorUrl === undefined || evmFacilitatorUrl === "")) {
    throw new Error(`${EVM_FACILITATOR_URL_ENV} is required when an EVM testnet inbound rail is activated`);
  }
  /**
   * 新しい `(network, asset)` の区分（D-7: 既存と同じ桁。静的は 1 件 10,000、動的は 1 件 20,000）。
   * その network が**受信か送信のどちらか**で有効なら出す（受信と送信は同じ区分に合算する。送信の設計 §6.3、FR-29、D-14）。
   * Solana USDC の区分は x402 と MPP の 4 つの向きが同じ 1 区分（`docs/mpp-solana-design.md` §6.3、FR-43）。
   */
  // Solana USDC の区分だけ別の上限を取れる（動的予算: 両レグが同じ区分に落ちる組がある。`DYNAMIC_MAX_PER_PURCHASE_SOL`）。
  const railBuckets = (maxPerPurchase: string, maxTotal: string, solMaxPerPurchase: string = maxPerPurchase): Record<string, unknown>[] => [
    ...(arcReceiver === undefined && !arcOutbound ? [] : [{ network: INBOUND_ARC.network, asset: INBOUND_ARC.asset, maxTotal, maxPerPurchase }]),
    ...(solReceiver === undefined && !solOutbound && solMppReceiver === undefined && !solMppOutbound
      ? []
      : [{ network: INBOUND_SOL.network, asset: INBOUND_SOL.asset, maxTotal, maxPerPurchase: solMaxPerPurchase }]),
  ];
  const profiles = dynamicProfilesOf(env, receiver, mppInboundEnabled, rails);
  return {
    router: {
      /**
       * 承認期限。**実効期限は `min(approvalTtlMs, offerExpiry)`** なので、
       * offer 側（既定 600 秒）より短いとこちらが先に切れる。
       * 人間が承認を挟む運用（収録・審査員のデモ）では、読み上げや確認で数分使うため
       * 5 分だと**承認前に失効する**ことが実測で起きた。既定を offer と揃える。
       */
      approvalTtlMs: Number(env["SUBETHA_APPROVAL_TTL_SECONDS"] ?? "600") * 1000,
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
        // 多レール（設計 §8・D-6）: Arc USDC → Provider B（MPP）、Solana USDC → Provider A（x402）。有効なレールの分だけ。
        ...(arcReceiver === undefined
          ? {}
          : {
              [ROUTE_ARC]: {
                routeId: ROUTE_ARC,
                canonicalPath: `/v1/routes/${ROUTE_ARC}/resource`,
                rail: "mpp",
                sourceRail: "x402",
                source: { amount: INBOUND_ARC.amount, asset: INBOUND_ARC.asset, decimals: 6, network: INBOUND_ARC.network, payTo: arcReceiver },
                destination: { scheme: "tempo/charge", network: OUTBOUND.network, asset: OUTBOUND.asset, payTo: OUTBOUND.payTo },
              },
            }),
        ...(solReceiver === undefined
          ? {}
          : {
              [ROUTE_SOL]: {
                routeId: ROUTE_SOL,
                canonicalPath: `/v1/routes/${ROUTE_SOL}/resource`,
                rail: "x402",
                sourceRail: "x402",
                source: { amount: INBOUND_SOL.amount, asset: INBOUND_SOL.asset, decimals: 6, network: INBOUND_SOL.network, payTo: solReceiver },
                destination: { scheme: "exact", network: OUTBOUND_X402.network, asset: OUTBOUND_X402.asset, payTo: OUTBOUND_X402.payTo },
              },
            }),
        // 送信（送信の設計 §6.3・D-12）: Base USDC で払って Arc の Provider に届く。Provider の URL と受取先がそろったときだけ。
        ...(arcProvider === undefined
          ? {}
          : {
              [ROUTE_ARC_OUT]: {
                routeId: ROUTE_ARC_OUT,
                canonicalPath: `/v1/routes/${ROUTE_ARC_OUT}/resource`,
                rail: "x402",
                sourceRail: "x402",
                source: { amount: INBOUND.amount, asset: INBOUND.asset, decimals: 6, network: INBOUND.network, payTo: receiver },
                destination: { scheme: "exact", network: OUTBOUND_ARC.network, asset: OUTBOUND_ARC.asset, payTo: arcProvider },
              },
            }),
        // 送信（送信の設計 §6.3・D-12 の O-4）: Tempo pathUSD（MPP 受信）で払って Solana の Provider に届く。MPP 受信があり、Provider の URL と受取先がそろったときだけ。
        ...(solProvider === undefined
          ? {}
          : {
              [ROUTE_SOL_OUT]: {
                routeId: ROUTE_SOL_OUT,
                canonicalPath: `/v1/routes/${ROUTE_SOL_OUT}/resource`,
                rail: "x402",
                sourceRail: "mpp",
                source: { amount: INBOUND_MPP.amount, asset: INBOUND_MPP.asset, decimals: 6, network: INBOUND_MPP.network, payTo: receiver },
                destination: { scheme: "exact", network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, payTo: solProvider },
              },
            }),
        // Solana の MPP 受信（`docs/mpp-solana-design.md` §6.3）: Solana USDC（`solana/charge`、Router が送出）で払って Provider A（x402）・Provider B（MPP）に届く。
        ...(solMppReceiver === undefined
          ? {}
          : {
              [ROUTE_SOLMPP_TO_X402]: {
                routeId: ROUTE_SOLMPP_TO_X402,
                canonicalPath: `/v1/routes/${ROUTE_SOLMPP_TO_X402}/resource`,
                rail: "x402",
                sourceRail: "mpp",
                source: { amount: INBOUND_SOL.amount, asset: INBOUND_SOL.asset, decimals: 6, network: INBOUND_SOL.network, payTo: solMppReceiver },
                destination: { scheme: "exact", network: OUTBOUND_X402.network, asset: OUTBOUND_X402.asset, payTo: OUTBOUND_X402.payTo },
              },
              [ROUTE_SOLMPP_TO_MPP]: {
                routeId: ROUTE_SOLMPP_TO_MPP,
                canonicalPath: `/v1/routes/${ROUTE_SOLMPP_TO_MPP}/resource`,
                rail: "mpp",
                sourceRail: "mpp",
                source: { amount: INBOUND_SOL.amount, asset: INBOUND_SOL.asset, decimals: 6, network: INBOUND_SOL.network, payTo: solMppReceiver },
                destination: { scheme: "tempo/charge", network: OUTBOUND.network, asset: OUTBOUND.asset, payTo: OUTBOUND.payTo },
              },
            }),
        // Solana の MPP 送信（設計 §6.3）: Base USDC（x402）／Tempo pathUSD（MPP 受信があるとき）で払って Provider D（`solana/charge`）に届く。URL（定数）と受取 owner がそろったときだけ。
        ...(solMppProvider === undefined
          ? {}
          : {
              [ROUTE_SOLMPP_OUT]: {
                routeId: ROUTE_SOLMPP_OUT,
                canonicalPath: `/v1/routes/${ROUTE_SOLMPP_OUT}/resource`,
                rail: "mpp",
                sourceRail: "x402",
                source: { amount: INBOUND.amount, asset: INBOUND.asset, decimals: 6, network: INBOUND.network, payTo: receiver },
                destination: { scheme: SOLANA_MPP_SCHEME, network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, payTo: solMppProvider },
              },
              ...(mppInboundEnabled
                ? {
                    [ROUTE_SOLMPP_OUT_MPP]: {
                      routeId: ROUTE_SOLMPP_OUT_MPP,
                      canonicalPath: `/v1/routes/${ROUTE_SOLMPP_OUT_MPP}/resource`,
                      rail: "mpp",
                      sourceRail: "mpp",
                      source: { amount: INBOUND_MPP.amount, asset: INBOUND_MPP.asset, decimals: 6, network: INBOUND_MPP.network, payTo: receiver },
                      destination: { scheme: SOLANA_MPP_SCHEME, network: OUTBOUND_SOL.network, asset: OUTBOUND_SOL.asset, payTo: solMppProvider },
                    },
                  }
                : {}),
            }),
      },
      // 「予算の続く限り」使えるように大きく取るが、暴走時に止まるようゼロにはしない。
      // bucket は (network, asset) 単位。2 経路は同じ 2 組を向きだけ変えて使うので、
      // この 2 本で両方をカバーする（経路ごとに増やす必要はない）。
      budget: {
        maxPurchases: Number(env["SUBETHA_MAX_PURCHASES"] ?? "100000"),
        buckets: [
          {
            network: INBOUND.network,
            asset: INBOUND.asset,
            maxTotal: env["SUBETHA_INBOUND_MAX_TOTAL"] ?? "1000000000",
            maxPerPurchase: "10000",
          },
          {
            network: OUTBOUND.network,
            asset: OUTBOUND.asset,
            maxTotal: env["SUBETHA_OUTBOUND_MAX_TOTAL"] ?? "1000000000",
            maxPerPurchase: "10000",
          },
          ...railBuckets("10000", env["SUBETHA_INBOUND_MAX_TOTAL"] ?? "1000000000"),
        ],
      },
      /**
       * 動的上流 URL（設計 `docs/dynamic-upstream-design.md`）。G-4（owner の決定 2026-10-06）で有効化。
       *
       * **受け入れの記録**（`docs/DEPLOY.md` §2b の条件）:
       * - SSRF 防御 B（egress 制御）: 本番ホスト `subetha-router`（AL2023）での受け入れの結果は `docs/ssrf-egress-design.md` **§27**
       *   （2026-10-05、全検証モードの実測）と **§27.1**（同日の切り替えと切り替え後の確認）。設計は同 §25、レビュー #10 で承認。
       *   2026-10-06 のデプロイ（`b-56265da`）でも `subetha-egress check` は正常
       * - G-2（testnet の実決済、両方向）: `docs/dynamic-upstream-tasks.md` T16 の記録（2026-10-06）
       *
       * - 2026-10-06（1 回目）: x402 送信（`dyn-mpp-to-x402`: Tempo pathUSD で払って x402 の上流に届く）だけ有効にした。
       * - 2026-10-06（2 回目）: MPP 送信（`dyn-x402-to-mpp`: Base Sepolia USDC で払って MPP の上流に届く）も登録（`MPP_OUTBOUND_PROFILE_ENABLED`）。
       *   条件 6: 手数料の仕様の確立（`docs/dynamic-gas-fee-design.md` §7）、Router の単価での testnet の試行（同 §8.5）
       * 値を変える場所はこの関数と `MPP_OUTBOUND_PROFILE_ENABLED` だけ。戻すのも同じ（`enabled: false`／`false`）。
       */
      ...(profiles === undefined
        ? {}
        : {
            dynamic: {
              enabled: true,
              profiles,
              budget: {
                maxPurchases: Number(env["SUBETHA_DYNAMIC_MAX_PURCHASES"] ?? "1000"),
                buckets: [
                  { network: INBOUND.network, asset: INBOUND.asset, maxTotal: env["SUBETHA_DYNAMIC_MAX_TOTAL"] ?? "100000000", maxPerPurchase: DYNAMIC_MAX_PER_PURCHASE },
                  { network: OUTBOUND.network, asset: OUTBOUND.asset, maxTotal: env["SUBETHA_DYNAMIC_MAX_TOTAL"] ?? "100000000", maxPerPurchase: DYNAMIC_MAX_PER_PURCHASE },
                  ...railBuckets(DYNAMIC_MAX_PER_PURCHASE, env["SUBETHA_DYNAMIC_MAX_TOTAL"] ?? "100000000", DYNAMIC_MAX_PER_PURCHASE_SOL),
                  // EVM testnet 3 つ（hosted 設計 §5）: 受信か送信が有効な chain の (network, asset)。1 件 20,000、総額は既存の動的と同じ env。
                  ...evmUsed.map((chain) => ({ network: EVM_TESTNETS[chain].network, asset: EVM_TESTNETS[chain].asset, maxTotal: env["SUBETHA_DYNAMIC_MAX_TOTAL"] ?? "100000000", maxPerPurchase: DYNAMIC_MAX_PER_PURCHASE })),
                ],
              },
              // 自分の公開ホスト名（Caddy の後ろ。canonical は内部の URL なので main.ts はこれを知らない）と、運用者が足すもの。
              denyHosts: [PUBLIC_HOSTNAME, ...(env["SUBETHA_DENY_HOSTS"] ?? "").split(",").map((host) => host.trim().toLowerCase()).filter((host) => host !== "")],
            },
          }),
    },
    // 上流の節は rail に関係なく `x402` という名前（`src/config.ts`）。全 route 分が要る。
    x402: {
      upstreams: {
        [ROUTE]: UPSTREAM,
        ...(mppInboundEnabled ? { [ROUTE_MPP_IN]: UPSTREAM_X402 } : {}),
        ...(arcReceiver === undefined ? {} : { [ROUTE_ARC]: UPSTREAM }),
        ...(solReceiver === undefined ? {} : { [ROUTE_SOL]: UPSTREAM_X402 }),
        ...(arcProvider === undefined ? {} : { [ROUTE_ARC_OUT]: upstreamArc }),
        ...(solProvider === undefined ? {} : { [ROUTE_SOL_OUT]: upstreamSol }),
        // Solana の MPP（設計 §6.3）: 受信 2 本は Provider A・B の URL、送信 2 本は Provider D の URL。
        ...(solMppReceiver === undefined ? {} : { [ROUTE_SOLMPP_TO_X402]: UPSTREAM_X402, [ROUTE_SOLMPP_TO_MPP]: UPSTREAM }),
        ...(solMppProvider === undefined ? {} : { [ROUTE_SOLMPP_OUT]: upstreamSolMpp, ...(mppInboundEnabled ? { [ROUTE_SOLMPP_OUT_MPP]: upstreamSolMpp } : {}) }),
      },
      // network ごとの受信の facilitator（設計 §2）。Base Sepolia は env（`ROUTER_X402_INBOUND_FACILITATOR_URL`）のまま。有効なレールの分だけ。
      // EVM testnet 3 つの受信（hosted 設計 §5）は自前の facilitator（kind `x402`）。HTTP の期限はチェーン別に Router が決める（`evmTestnetDeadlinesOf`。ローカル版 §3.6 の 20 秒）。
      ...(arcReceiver === undefined && solReceiver === undefined && evmInbound.length === 0
        ? {}
        : {
            inboundFacilitators: {
              ...(arcReceiver === undefined ? {} : { [INBOUND_ARC.network]: INBOUND_ARC.facilitator }),
              ...(solReceiver === undefined ? {} : { [INBOUND_SOL.network]: INBOUND_SOL.facilitator }),
              ...Object.fromEntries(evmInbound.map((chain) => [EVM_TESTNETS[chain].network, { kind: "x402", url: evmFacilitatorUrl }])),
            },
          }),
    },
  };
}


/* ------------------------------------------------------------------ mainnet の最初の 1 経路（`docs/mainnet-first-route.md`、2026-10-10、第 4 版 = 案 B） */

/**
 * owner の Mac で loopback 限定で起動する **mainnet 専用**の生成。公開の生成（`routerConfigOf`）には触れない（golden 比較で不変を証明する）。
 * - 受信: Tempo mainnet USDC.e を MPP（`tempo/charge`。Router が challenge を発行し RPC で照合する。facilitator 不要）。受取先は owner の受信 wallet
 * - 送信: Base mainnet USDC を x402 `exact`（EIP-3009、domain `USD Coin`/`2`）で CoinGecko（x402 のみを受ける公式 API）へ。gas は CoinGecko 側の facilitator
 * - 実証は**動的プロファイル** `dyn-mpp-to-x402-mainnet`（caller が CoinGecko の URL をクエリ付きで指定する。静的の上流はクエリを持てず、CoinGecko はクエリ無しだと 422）
 * - 静的 route `md-coingecko-price` は `router.routes` を空にできない規則のための placeholder（クエリ無しの URL。購入しても paid-no-data になり得るので使わない）
 * 値（CoinGecko の受取先・価格・domain）は 2026-10-10 に CoinGecko の 402 から読んだ。受取先が 402 と違えば Router が従来どおり拒む。
 */
export const MAINNET_FIRST_ROUTE = Object.freeze({
  routeId: "md-coingecko-price",
  profileId: "dyn-mpp-to-x402-mainnet",
  inbound: Object.freeze({ network: "eip155:4217", asset: "0x20C000000000000000000000b9537d11c60E8b50", amount: "10000" }),
  outbound: Object.freeze({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x110cdBba7FE6434Ec4CE3464CC523942ad6Fb784", scheme: "exact", tokenDomain: Object.freeze({ name: "USD Coin", version: "2" }) }),
  upstream: "https://pro-api.coingecko.com/api/v3/x402/simple/price",
  tempoChainId: 4217,
  tempoRpcUrl: "https://rpc.tempo.xyz",
  maxPerPurchase: "10000",
  maxTotal: "30000",
  /** 動的の予算: 1 件の予約は上流額 + 手数料（受信側）と上流額（送信側。x402 送信に gas の予約は無い）。既存の動的と同じ `DYNAMIC_MAX_PER_PURCHASE`、`maxTotal` は数件分。 */
  dynamicMaxTotal: "60000",
});
export function mainnetFirstRouteConfigOf(env: Readonly<Record<string, string | undefined>>, receiver: string): Record<string, unknown> {
  const m = MAINNET_FIRST_ROUTE;
  return {
    router: {
      approvalTtlMs: Number(env["SUBETHA_APPROVAL_TTL_SECONDS"] ?? "600") * 1000,
      routes: {
        [m.routeId]: {
          routeId: m.routeId,
          canonicalPath: `/v1/routes/${m.routeId}/resource`,
          rail: "x402",
          sourceRail: "mpp",
          source: { amount: m.inbound.amount, asset: m.inbound.asset, decimals: 6, network: m.inbound.network, payTo: receiver },
          destination: { scheme: m.outbound.scheme, network: m.outbound.network, asset: m.outbound.asset, payTo: m.outbound.payTo },
        },
      },
      budget: {
        maxPurchases: Number(env["SUBETHA_MAX_PURCHASES"] ?? "10"),
        buckets: [
          { network: m.inbound.network, asset: m.inbound.asset, maxTotal: m.maxTotal, maxPerPurchase: m.maxPerPurchase },
          { network: m.outbound.network, asset: m.outbound.asset, maxTotal: m.maxTotal, maxPerPurchase: m.maxPerPurchase },
        ],
      },
      // 動的プロファイル（`dyn-mpp-to-x402` と同じ形で network だけ mainnet）。上流は caller が URL で指定する（CoinGecko のクエリ付き URL）。
      dynamic: {
        enabled: true,
        profiles: {
          [m.profileId]: {
            profileId: m.profileId,
            sourceRail: "mpp",
            source: { network: m.inbound.network, asset: m.inbound.asset, decimals: 6, payTo: receiver },
            rail: "x402",
            destination: { scheme: m.outbound.scheme, network: m.outbound.network, asset: m.outbound.asset, decimals: 6, tokenDomain: m.outbound.tokenDomain },
            par: true,
            fee: DYNAMIC_FEE_X402_OUT,
            maxUpstreamAmount: DYNAMIC_MAX_UPSTREAM_AMOUNT,
          },
        },
        budget: {
          maxPurchases: Number(env["SUBETHA_MAX_PURCHASES"] ?? "10"),
          buckets: [
            { network: m.inbound.network, asset: m.inbound.asset, maxTotal: m.dynamicMaxTotal, maxPerPurchase: DYNAMIC_MAX_PER_PURCHASE },
            { network: m.outbound.network, asset: m.outbound.asset, maxTotal: m.dynamicMaxTotal, maxPerPurchase: DYNAMIC_MAX_PER_PURCHASE },
          ],
        },
        // loopback 限定の起動なので公開ホスト名は無い。運用者が足すものだけ。
        denyHosts: (env["SUBETHA_DENY_HOSTS"] ?? "").split(",").map((host) => host.trim().toLowerCase()).filter((host) => host !== ""),
      },
    },
    x402: {
      upstreams: { [m.routeId]: m.upstream },
    },
  };
}

/* ------------------------------------------------------------------ EVM testnet 4 つの x402 受信・送信（`docs/evm-testnets-x402-design.md` §3.5、2026-10-13） */

/**
 * 4 つの EVM testnet（短縮名 → network・資産・桁・EIP-712 domain）。値は表（`src/shared/networks.ts` の `KNOWN_NETWORKS`）と同じで、
 * 試験が一致を確かめる（このファイルは Router に依存しないので写しを持つ）。資産の文字列は表の id と同じ表記（checksum の大文字小文字のまま。予算の区分の鍵）。
 */
export const EVM_TESTNETS = Object.freeze({
  rh: Object.freeze({ network: "eip155:46630", asset: "0x7E955252E15c84f5768B83c41a71F9eba181802F", decimals: 6, domain: Object.freeze({ name: "Global Dollar", version: "1" }) }),
  arbsep: Object.freeze({ network: "eip155:421614", asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", decimals: 6, domain: Object.freeze({ name: "USD Coin", version: "2" }) }),
  hyperevm: Object.freeze({ network: "eip155:998", asset: "0x2B3370eE501B4a559b57D449569354196457D8Ab", decimals: 6, domain: Object.freeze({ name: "USDC", version: "2" }) }),
  sepolia: Object.freeze({ network: "eip155:11155111", asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6, domain: Object.freeze({ name: "USDC", version: "2" }) }),
});
export type EvmTestnetChain = keyof typeof EVM_TESTNETS;
export const EVM_TESTNET_CHAINS: readonly EvmTestnetChain[] = Object.freeze(["rh", "arbsep", "hyperevm", "sepolia"]);

/** 専用の入口の env（設計 §3.5）。facilitator（自前、token は path の接頭辞）・C の Provider の URL・受取先・選んだ chain。 */
export const EVM_FACILITATOR_URL_ENV = "SUBETHA_EVM_FACILITATOR_URL";
export const EVM_PROVIDER_PAYTO_ENV = "SUBETHA_EVM_PROVIDER_PAYTO";
export const EVM_CHAINS_ENV = "SUBETHA_EVM_CHAINS";
/** C の Provider の URL の env 名（`SUBETHA_EVM_PROVIDER_URL_RH` など。短縮名の大文字）。 */
export function evmProviderUrlEnvOf(chain: EvmTestnetChain): string {
  return `SUBETHA_EVM_PROVIDER_URL_${chain.toUpperCase()}`;
}

/** `rh,arbsep` のような chain の一覧を読む。空・知らない語・重複は拒む（値は出さない）。順は表の順に揃える。 */
export function evmTestnetChainsOf(text: string | undefined): EvmTestnetChain[] {
  if (text === undefined || text.trim() === "") throw new Error("at least one EVM testnet chain is required");
  const seen = new Set<EvmTestnetChain>();
  for (const token of text.split(",")) {
    const name = token.trim();
    if (!(EVM_TESTNET_CHAINS as readonly string[]).includes(name) || seen.has(name as EvmTestnetChain)) {
      throw new Error(`chains must be a comma-separated subset of "${EVM_TESTNET_CHAINS.join(",")}" without repeats`);
    }
    seen.add(name as EvmTestnetChain);
  }
  return EVM_TESTNET_CHAINS.filter((chain) => seen.has(chain));
}

/** 受信 route（C の通貨で払って Provider A に届く）と送信 route（Base Sepolia USDC で払って C の Provider に届く）の id。 */
export function evmInboundRouteOf(chain: EvmTestnetChain): string {
  return `md-x402-eth-snapshot-${chain}`;
}
export function evmOutboundRouteOf(chain: EvmTestnetChain): string {
  return `md-${chain}-eth-snapshot`;
}

/** 予算（設計 §3.7）。 */
export const EVM_TESTNETS_BUDGET = Object.freeze({ maxPurchases: 32, baseSepolia: Object.freeze({ maxPerPurchase: "10000", maxTotal: "200000" }), chain: Object.freeze({ maxPerPurchase: "10000", maxTotal: "50000" }) });

/**
 * EVM testnet の専用の設定生成（設計 §3.5・FR-E5）。公開の生成（`routerConfigOf`）・`RAILS_ACTIVATION` には触れない。各 C について:
 * - 受信 `md-x402-eth-snapshot-<c>`: C の資産 10,000（x402、受取先 `receiver`）→ Provider A（Base Sepolia USDC 10,000、`UPSTREAM_X402`）
 * - 送信 `md-<c>-eth-snapshot`: Base Sepolia USDC 10,000（x402、受取先 `receiver`。facilitator は env `ROUTER_X402_INBOUND_FACILITATOR_URL`）→ C の Provider（C の資産、
 *   受取先 env `SUBETHA_EVM_PROVIDER_PAYTO`、URL env `SUBETHA_EVM_PROVIDER_URL_<C>`）
 * - C の受信の facilitator は `{ kind: "x402", url: env SUBETHA_EVM_FACILITATOR_URL }`
 * env が欠ければ例外（値は出さない）。
 */
export function evmTestnetsConfigOf(env: Readonly<Record<string, string | undefined>>, receiver: string, chains: readonly EvmTestnetChain[], options?: EvmMatrixOptions): Record<string, unknown> {
  if (chains.length === 0 || new Set(chains).size !== chains.length || chains.some((chain) => !(EVM_TESTNET_CHAINS as readonly string[]).includes(chain))) {
    throw new Error("chains must be a non-empty subset of the EVM testnets without repeats");
  }
  const facilitatorUrl = env[EVM_FACILITATOR_URL_ENV];
  if (facilitatorUrl === undefined || facilitatorUrl === "") throw new Error(`${EVM_FACILITATOR_URL_ENV} is required`);
  const providerPayTo = env[EVM_PROVIDER_PAYTO_ENV];
  if (providerPayTo === undefined || !EVM_ADDRESS.test(providerPayTo)) throw new Error(`${EVM_PROVIDER_PAYTO_ENV} must be an EVM address`);
  const providerUrls = Object.fromEntries(
    chains.map((chain) => {
      const url = env[evmProviderUrlEnvOf(chain)];
      if (url === undefined || url === "") throw new Error(`${evmProviderUrlEnvOf(chain)} is required`);
      return [chain, url];
    }),
  ) as Record<EvmTestnetChain, string>;
  const routes: Record<string, unknown> = {};
  const upstreams: Record<string, string> = {};
  const inboundFacilitators: Record<string, unknown> = {};
  for (const chain of chains) {
    const c = EVM_TESTNETS[chain];
    const inboundId = evmInboundRouteOf(chain);
    const outboundId = evmOutboundRouteOf(chain);
    routes[inboundId] = {
      routeId: inboundId,
      canonicalPath: `/v1/routes/${inboundId}/resource`,
      rail: "x402",
      sourceRail: "x402",
      source: { amount: "10000", asset: c.asset, decimals: c.decimals, network: c.network, payTo: receiver },
      destination: { scheme: "exact", network: OUTBOUND_X402.network, asset: OUTBOUND_X402.asset, payTo: OUTBOUND_X402.payTo },
    };
    routes[outboundId] = {
      routeId: outboundId,
      canonicalPath: `/v1/routes/${outboundId}/resource`,
      rail: "x402",
      sourceRail: "x402",
      source: { amount: INBOUND.amount, asset: INBOUND.asset, decimals: 6, network: INBOUND.network, payTo: receiver },
      destination: { scheme: "exact", network: c.network, asset: c.asset, payTo: providerPayTo },
    };
    upstreams[inboundId] = UPSTREAM_X402;
    upstreams[outboundId] = providerUrls[chain];
    inboundFacilitators[c.network] = { kind: "x402", url: facilitatorUrl };
  }
  const budget = EVM_TESTNETS_BUDGET;
  if (options?.matrix === true) {
    return matrixConfigOf(env, receiver, chains, options, { routes, upstreams, inboundFacilitators, providerPayTo, providerUrls });
  }
  return {
    router: {
      // 公開の生成と同じ既定（承認期限は `min(approvalTtlMs, offerExpiry)`）。
      approvalTtlMs: Number(env["SUBETHA_APPROVAL_TTL_SECONDS"] ?? "600") * 1000,
      routes,
      budget: {
        maxPurchases: budget.maxPurchases,
        buckets: [
          { network: INBOUND.network, asset: INBOUND.asset, maxTotal: budget.baseSepolia.maxTotal, maxPerPurchase: budget.baseSepolia.maxPerPurchase },
          ...chains.map((chain) => ({ network: EVM_TESTNETS[chain].network, asset: EVM_TESTNETS[chain].asset, maxTotal: budget.chain.maxTotal, maxPerPurchase: budget.chain.maxPerPurchase })),
        ],
      },
    },
    x402: { upstreams, inboundFacilitators },
  };
}

/* ------------------------------------------------------------------ 掛け合わせの検証（`docs/evm-testnets-x402-design.md` §8、2026-10-13） */

/** 行列の端点。新 3（自前 facilitator・手元の Provider）と既存 4（Base は §7 で済んだので行列に入らない）。 */
export type MatrixNewChain = "rh" | "arbsep" | "hyperevm";
export type MatrixExisting = "tempo" | "arc" | "sol" | "solmpp";
export type MatrixEndpoint = MatrixNewChain | MatrixExisting;
export const MATRIX_NEW_CHAINS: readonly MatrixNewChain[] = Object.freeze(["rh", "arbsep", "hyperevm"]);
export const MATRIX_EXISTING: readonly MatrixExisting[] = Object.freeze(["tempo", "arc", "sol", "solmpp"]);
/** 並び（route の順）: 新 3 → 既存 4。 */
export const MATRIX_ENDPOINTS: readonly MatrixEndpoint[] = Object.freeze([...MATRIX_NEW_CHAINS, ...MATRIX_EXISTING]);

/** 端点のレール（受信でも送信でも同じ）。network・資産・桁は表（`KNOWN_NETWORKS`）と同じ値（試験が確かめる）。 */
export interface MatrixRail {
  readonly rail: "x402" | "mpp";
  readonly scheme: "exact" | "tempo/charge" | "solana/charge";
  readonly family: "evm" | "svm";
  readonly network: string;
  readonly asset: string;
  readonly decimals: number;
}
export const MATRIX_RAILS: Readonly<Record<MatrixEndpoint, MatrixRail>> = Object.freeze({
  rh: Object.freeze({ rail: "x402", scheme: "exact", family: "evm", network: EVM_TESTNETS.rh.network, asset: EVM_TESTNETS.rh.asset, decimals: 6 }),
  arbsep: Object.freeze({ rail: "x402", scheme: "exact", family: "evm", network: EVM_TESTNETS.arbsep.network, asset: EVM_TESTNETS.arbsep.asset, decimals: 6 }),
  hyperevm: Object.freeze({ rail: "x402", scheme: "exact", family: "evm", network: EVM_TESTNETS.hyperevm.network, asset: EVM_TESTNETS.hyperevm.asset, decimals: 6 }),
  tempo: Object.freeze({ rail: "mpp", scheme: "tempo/charge", family: "evm", network: INBOUND_MPP.network, asset: INBOUND_MPP.asset, decimals: 6 }),
  arc: Object.freeze({ rail: "x402", scheme: "exact", family: "evm", network: INBOUND_ARC.network, asset: INBOUND_ARC.asset, decimals: 6 }),
  sol: Object.freeze({ rail: "x402", scheme: "exact", family: "svm", network: INBOUND_SOL.network, asset: INBOUND_SOL.asset, decimals: 6 }),
  solmpp: Object.freeze({ rail: "mpp", scheme: SOLANA_MPP_SCHEME, family: "svm", network: INBOUND_SOL.network, asset: INBOUND_SOL.asset, decimals: 6 }),
}) as Readonly<Record<MatrixEndpoint, MatrixRail>>;

export function matrixRouteOf(src: MatrixEndpoint, dst: MatrixEndpoint): string {
  return `mx-${src}-to-${dst}`;
}
export function isMatrixNewChain(endpoint: string): endpoint is MatrixNewChain {
  return (MATRIX_NEW_CHAINS as readonly string[]).includes(endpoint);
}
/**
 * 30 の組（§8.1）: 受信か送信の少なくとも一方が新 3、同じ端点どうしは除く（新 × 新の同一チェーン）。Base ↔ 新 3 の 6 は §7 の `md-*` で済み（行列に Base は無い）。
 * 既存 × 既存は対象外。順は `MATRIX_ENDPOINTS` の src × dst。
 */
export function matrixPairsOf(reruns: readonly string[] = []): readonly { readonly src: MatrixEndpoint; readonly dst: MatrixEndpoint; readonly routeId: string }[] {
  const out: { src: MatrixEndpoint; dst: MatrixEndpoint; routeId: string }[] = [];
  for (const src of MATRIX_ENDPOINTS) {
    for (const dst of MATRIX_ENDPOINTS) {
      if (src === dst) continue;
      if (!isMatrixNewChain(src) && !isMatrixNewChain(dst)) continue;
      out.push({ src, dst, routeId: matrixRouteOf(src, dst) });
    }
  }
  // 再実行の別名（owner の依頼 2026-10-13: Tempo MPP → HyperEVM の再確認）。資金が署名で動く route は同じ routeId では二度と署名しないので、
  // 同じ組の **新しい** routeId（`-r2`）を足す。指定が無ければ 30 本のまま（既定・試験は不変）。
  for (const pair of reruns) {
    const [src, dst] = pair.split(":");
    const found = out.find((p) => p.src === src && p.dst === dst && p.routeId === matrixRouteOf(p.src, p.dst));
    if (found === undefined) throw new Error("SUBETHA_MATRIX_RERUNS: each entry must be <src>:<dst> of a matrix pair");
    out.push({ src: found.src, dst: found.dst, routeId: `${found.routeId}-r2` });
  }
  return out;
}

/** env `SUBETHA_MATRIX_RERUNS`（`tempo:hyperevm,...`。空なら無し）。 */
export function matrixRerunsOf(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return (env["SUBETHA_MATRIX_RERUNS"] ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
}

/** 行列の有効化（既存レールの受信・送信の全部。組 `pairs` は動的プロファイル用なので無し）。子の能力の env（`SUBETHA_RAILS_ACTIVATION`）と受取先・Provider の読み取りに使う。 */
export const EVM_MATRIX_ACTIVATION: RailsActivation = Object.freeze({
  arc: Object.freeze({ inbound: true, outbound: true }),
  solana: Object.freeze({ inbound: true, outbound: true }),
  solanaMpp: Object.freeze({ inbound: true, outbound: true }),
});

/** 行列の選択肢（§8.3-1）。受取先（Arc の証明専用の受取鍵の address・Solana の受取 owner）と hosted の Provider の受取先は入口が env から導いて渡す。 */
export interface EvmMatrixOptions {
  readonly matrix: true;
  readonly receivers: { readonly arc?: string | undefined; readonly solana?: string | undefined };
  readonly providers: { readonly arc?: string | undefined; readonly solana?: string | undefined; readonly solanaMpp?: string | undefined };
}

/**
 * 行列の予算（§3.7 の区分に足す）。各レグ 10,000。1 件の予約で両レグが同じ区分に落ちる組は行列に無い（Solana x402 ↔ Solana MPP は既存 × 既存で対象外）ので
 * `maxPerPurchase` は 10,000 のまま。`maxTotal` は 1 区分のレグ数 × 10,000 + 失敗の予約の余裕:
 * 新 3 の各資産 14 レグ（`md-*` 2 + 行列 12）→ 200,000、Tempo pathUSD 6 → 100,000、Arc USDC 6 → 100,000、Solana USDC（x402 と MPP の 4 向きが同じ区分）12 → 200,000。
 */
export const EVM_MATRIX_BUDGET = Object.freeze({
  maxPurchases: 80,
  newChain: Object.freeze({ maxPerPurchase: "10000", maxTotal: "200000" }),
  tempo: Object.freeze({ maxPerPurchase: "10000", maxTotal: "100000" }),
  arc: Object.freeze({ maxPerPurchase: "10000", maxTotal: "100000" }),
  solana: Object.freeze({ maxPerPurchase: "10000", maxTotal: "200000" }),
});

function matrixConfigOf(
  env: Readonly<Record<string, string | undefined>>,
  receiver: string,
  chains: readonly EvmTestnetChain[],
  options: EvmMatrixOptions,
  base: { routes: Record<string, unknown>; upstreams: Record<string, string>; inboundFacilitators: Record<string, unknown>; providerPayTo: string; providerUrls: Record<EvmTestnetChain, string> },
): Record<string, unknown> {
  // 行列は新 3 の全部が要る（30 の組を欠けなく出す）。Ethereum Sepolia は行列に入らない（`md-*` は選べば出る）。
  if (!MATRIX_NEW_CHAINS.every((chain) => chains.includes(chain))) throw new Error("the matrix requires the chains rh, arbsep and hyperevm");
  const arcReceiver = options.receivers.arc;
  const solReceiver = options.receivers.solana;
  if (typeof arcReceiver !== "string" || !EVM_ADDRESS.test(arcReceiver)) throw new Error("the matrix requires the arc receiver address");
  if (typeof solReceiver !== "string" || !isBase58PublicKey(solReceiver)) throw new Error("the matrix requires the solana receiver owner");
  const arcProvider = options.providers.arc;
  const solProvider = options.providers.solana;
  const solMppProvider = options.providers.solanaMpp;
  if (typeof arcProvider !== "string" || !EVM_ADDRESS.test(arcProvider)) throw new Error("the matrix requires the arc provider pay-to address");
  if (typeof solProvider !== "string" || !isBase58PublicKey(solProvider)) throw new Error("the matrix requires the solana provider pay-to owner");
  if (typeof solMppProvider !== "string" || !isBase58PublicKey(solMppProvider)) throw new Error("the matrix requires the solana mpp provider (D) pay-to owner");
  // Provider の受取先は運用者の集合（受取先）の外（送信の設計 §2.3。Router も宛先で拒むが、ここで先に止める）。
  const operators = new Set([receiver.toLowerCase(), arcReceiver.toLowerCase(), solReceiver]);
  if ([base.providerPayTo.toLowerCase(), arcProvider.toLowerCase(), solProvider, solMppProvider].some((p) => operators.has(p))) {
    throw new Error("a provider pay-to address must not be a Router receiver");
  }
  const sourcePayTo: Record<MatrixEndpoint, string> = { rh: receiver, arbsep: receiver, hyperevm: receiver, tempo: receiver, arc: arcReceiver, sol: solReceiver, solmpp: solReceiver };
  const destinationOf = (dst: MatrixEndpoint): { payTo: string; upstream: string } => {
    if (isMatrixNewChain(dst)) return { payTo: base.providerPayTo, upstream: base.providerUrls[dst] };
    if (dst === "tempo") return { payTo: OUTBOUND.payTo, upstream: UPSTREAM };
    if (dst === "arc") return { payTo: arcProvider, upstream: UPSTREAM_ARC };
    if (dst === "sol") return { payTo: solProvider, upstream: UPSTREAM_SOL };
    return { payTo: solMppProvider, upstream: UPSTREAM_SOL_MPP };
  };
  const routes: Record<string, unknown> = { ...base.routes };
  const upstreams: Record<string, string> = { ...base.upstreams };
  for (const { src, dst, routeId } of matrixPairsOf(matrixRerunsOf(env))) {
    const s = MATRIX_RAILS[src];
    const d = MATRIX_RAILS[dst];
    const destination = destinationOf(dst);
    routes[routeId] = {
      routeId,
      canonicalPath: `/v1/routes/${routeId}/resource`,
      rail: d.rail,
      sourceRail: s.rail,
      source: { amount: "10000", asset: s.asset, decimals: s.decimals, network: s.network, payTo: sourcePayTo[src] },
      destination: { scheme: d.scheme, network: d.network, asset: d.asset, payTo: destination.payTo },
    };
    upstreams[routeId] = destination.upstream;
  }
  const budget = EVM_TESTNETS_BUDGET;
  const matrixBudget = EVM_MATRIX_BUDGET;
  return {
    router: {
      approvalTtlMs: Number(env["SUBETHA_APPROVAL_TTL_SECONDS"] ?? "600") * 1000,
      routes,
      budget: {
        maxPurchases: matrixBudget.maxPurchases,
        buckets: [
          { network: INBOUND.network, asset: INBOUND.asset, maxTotal: budget.baseSepolia.maxTotal, maxPerPurchase: budget.baseSepolia.maxPerPurchase },
          ...chains.map((chain) => {
            const limits = isMatrixNewChain(chain) ? matrixBudget.newChain : budget.chain;
            return { network: EVM_TESTNETS[chain].network, asset: EVM_TESTNETS[chain].asset, maxTotal: limits.maxTotal, maxPerPurchase: limits.maxPerPurchase };
          }),
          { network: INBOUND_MPP.network, asset: INBOUND_MPP.asset, maxTotal: matrixBudget.tempo.maxTotal, maxPerPurchase: matrixBudget.tempo.maxPerPurchase },
          { network: INBOUND_ARC.network, asset: INBOUND_ARC.asset, maxTotal: matrixBudget.arc.maxTotal, maxPerPurchase: matrixBudget.arc.maxPerPurchase },
          { network: INBOUND_SOL.network, asset: INBOUND_SOL.asset, maxTotal: matrixBudget.solana.maxTotal, maxPerPurchase: matrixBudget.solana.maxPerPurchase },
        ],
      },
    },
    x402: {
      upstreams,
      // 受信の facilitator: 新 3 は自前（上の `md-*` と同じ）、Arc は Circle（kind circle）、Solana x402 は x402.org。Base Sepolia は env のまま。MPP の受信は facilitator を使わない。
      inboundFacilitators: { ...base.inboundFacilitators, [INBOUND_ARC.network]: INBOUND_ARC.facilitator, [INBOUND_SOL.network]: INBOUND_SOL.facilitator },
    },
  };
}
