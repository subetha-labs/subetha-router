/**
 * network・資産の表と、その純粋な helper（multirail 設計 §1、FR-3）。**コードだけ**が権威で、env・設定ファイルからは変えられない。
 * P-0（`docs/agent-payer-tasks.md`）で `src/config.ts` から抽出した。`src/config.ts` は同じ名前を re-export するので既存の import は変わらない。
 * この module は Router の他の部分に依存しない（payer のパッケージが vendor する。設計 `docs/agent-payer-design.md` §3.8）。
 */

/** 受信レグの受取先アドレス形式（EVM）。 */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
/** base58（Bitcoin alphabet）。SVM の公開鍵は 32 バイトで 32〜44 文字。 */
const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * base58 を復号したときのバイト数（Bitcoin alphabet。先頭の `1` は 0 のバイト 1 つずつ）。この module が `@solana/kit` に依存しないための
 * 自前の復号で、結果は `getBase58Encoder().encode(text).length` と同じ（試験 `tests/unit/shared-extraction.test.ts`）。alphabet 外の文字は `undefined`。
 */
export function base58DecodedLength(text: string): number | undefined {
  let value = 0n;
  let leadingZeros = 0;
  let seenNonZero = false;
  for (const ch of text) {
    const digit = BASE58_ALPHABET.indexOf(ch);
    if (digit < 0) return undefined;
    if (!seenNonZero && digit === 0) {
      leadingZeros += 1;
      continue;
    }
    seenNonZero = true;
    value = value * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (value > 0n) {
    value >>= 8n;
    bytes += 1;
  }
  return leadingZeros + bytes;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * network の表（multirail 設計 §1、FR-3）。**コードだけ**が権威で、env・設定ファイルからは変えられない。
 * 本番の入口は `KNOWN_NETWORKS` しか使えない。試験の起動側は `knownNetworksForTest`（`src/main.ts`）で自分の表を渡す。
 * ────────────────────────────────────────────────────────────────────────────── */

export type NetworkFamily = "evm" | "svm";
export type InboundRailName = "x402" | "mpp";
export type OutboundRailName = "x402" | "mpp";
export type X402FacilitatorKind = "x402" | "circle";

/** MPP の Solana charge の scheme（offer・route・プロファイルの `scheme`。Tempo の `tempo/charge` に対応。`docs/mpp-solana-design.md` §3.1）。 */
export const MPP_SOLANA_SCHEME = "solana/charge";

export interface KnownAsset {
  /** EVM: `0x` アドレス（比較は小文字化）。SVM: mint（base58。比較はそのまま）。 */
  readonly id: string;
  readonly decimals: number;
  /** EVM/x402 の EIP-712 domain。x402 で使う資産に必須。 */
  readonly domain?: { readonly name: string; readonly version: string };
  /** SVM の token program。 */
  readonly tokenProgram?: string;
}

export interface KnownNetwork {
  /** CAIP-2。 */
  readonly network: string;
  readonly family: NetworkFamily;
  /** この network で許す受信レール（`sourceRail`）。 */
  readonly inbound: readonly InboundRailName[];
  /** この network で許す送信レール（静的の `rail`・動的の `rail`）。 */
  readonly outbound: readonly OutboundRailName[];
  /** x402 受信の facilitator の種類（受信 x402 を許すときだけ）。 */
  readonly x402Facilitator?: X402FacilitatorKind;
  readonly assets: readonly KnownAsset[];
}

export const KNOWN_NETWORKS: readonly KnownNetwork[] = Object.freeze([
  {
    network: "eip155:84532",
    family: "evm",
    inbound: ["x402"],
    outbound: ["x402"],
    x402Facilitator: "x402",
    assets: [{ id: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, domain: { name: "USDC", version: "2" } }],
  },
  {
    network: "eip155:42431",
    family: "evm",
    inbound: ["mpp"],
    outbound: ["mpp"],
    assets: [{ id: "0x20c0000000000000000000000000000000000000", decimals: 6 }],
  },
  {
    // Arc testnet（Circle）。送信（S-3）は x402（EIP-3009。送信の設計 §3）。
    network: "eip155:5042002",
    family: "evm",
    inbound: ["x402"],
    outbound: ["x402"],
    x402Facilitator: "circle",
    assets: [{ id: "0x3600000000000000000000000000000000000000", decimals: 6, domain: { name: "USDC", version: "2" } }],
  },
  {
    // Solana devnet。送信（S-4）は x402 の SVM `exact`（送信の設計 §4）。MPP（S-5 受信・S-6 送信。`docs/mpp-solana-design.md` §1.1）も受信・送信とも許す。
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    family: "svm",
    inbound: ["x402", "mpp"],
    outbound: ["x402", "mpp"],
    x402Facilitator: "x402",
    assets: [{ id: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }],
  },
  {
    // Base mainnet（`docs/mainnet-first-route.md` §2.1。2026-10-10）。USDC の EIP-712 domain は `USD Coin` / `2`（CoinGecko の 402 と公式の値）。
    // 受信は x402（facilitator kind `x402`: PayAI）、送信は x402（EIP-3009。同じ鍵）。設定生成の既定ではどの route・profile もこの network を使わない。
    network: "eip155:8453",
    family: "evm",
    inbound: ["x402"],
    outbound: ["x402"],
    x402Facilitator: "x402",
    assets: [{ id: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, domain: { name: "USD Coin", version: "2" } }],
  },
  {
    // Tempo mainnet（同上）。USDC.e（Stargate の bridged USDC）。MPP の受信・送信。設定生成の既定では使わない。
    network: "eip155:4217",
    family: "evm",
    inbound: ["mpp"],
    outbound: ["mpp"],
    assets: [{ id: "0x20C000000000000000000000b9537d11c60E8b50", decimals: 6 }],
  },
  /*
   * EVM testnet 4 つ（`docs/evm-testnets-x402-design.md` §1.1。2026-10-13 に公式の一覧と読み取り専用 RPC で確認。証跡 `docs/evidence/evm-testnets/`）。
   * x402 の受信・送信（EIP-3009）。facilitator は公開のものが無い（Robinhood）ので自前（`tools/evm-facilitator.ts`、kind `x402`）。
   * 設定生成の既定ではどの route もこれらを使わない（専用の入口 `tools/evm-testnets-run.ts` だけ）。
   */
  {
    // Robinhood Chain testnet。Paxos の USDG。`version()` を持たない: domain は `DOMAIN_SEPARATOR()` を name・`1`・chainId・address から再計算して一致を確認。EIP-3009 は facet が受ける。
    network: "eip155:46630",
    family: "evm",
    inbound: ["x402"],
    outbound: ["x402"],
    x402Facilitator: "x402",
    assets: [{ id: "0x7E955252E15c84f5768B83c41a71F9eba181802F", decimals: 6, domain: { name: "Global Dollar", version: "1" } }],
  },
  {
    // Arbitrum Sepolia。Circle の USDC（`name()` は `USD Coin`）。
    network: "eip155:421614",
    family: "evm",
    inbound: ["x402"],
    outbound: ["x402"],
    x402Facilitator: "x402",
    assets: [{ id: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", decimals: 6, domain: { name: "USD Coin", version: "2" } }],
  },
  {
    // HyperEVM testnet。Circle の ERC-20 USDC（HyperCore の取引用 USDC ではない）。
    network: "eip155:998",
    family: "evm",
    inbound: ["x402"],
    outbound: ["x402"],
    x402Facilitator: "x402",
    assets: [{ id: "0x2B3370eE501B4a559b57D449569354196457D8Ab", decimals: 6, domain: { name: "USDC", version: "2" } }],
  },
  {
    // Ethereum Sepolia。Circle の USDC。
    network: "eip155:11155111",
    family: "evm",
    inbound: ["x402"],
    outbound: ["x402"],
    x402Facilitator: "x402",
    assets: [{ id: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6, domain: { name: "USDC", version: "2" } }],
  },
]);

/**
 * 上の EVM testnet 4 つ（設計 `docs/evm-testnets-x402-design.md`）。受信の domain と期限（§3.2）・loopback の相手（§3.5）はこの集合の network だけに効く。
 */
export const EVM_TESTNET_NETWORKS: ReadonlySet<string> = Object.freeze(new Set(["eip155:46630", "eip155:421614", "eip155:998", "eip155:11155111"]));

/** 遅いチェーン（block ~12 秒）。期限の表（設計 §3.6）の右の列。 */
const SLOW_EVM_TESTNETS: ReadonlySet<string> = Object.freeze(new Set(["eip155:11155111"]));

/**
 * EVM testnet 4 つの期限（ms。設計 §3.6）。ほかの network には使わない（`undefined`）。
 * - `inboundFacilitatorMs`: Router 受信の facilitator の HTTP 期限（verify と settle）
 * - `outboundPaidMs`: Router 送信の有料要求の期限（Provider の要求全体の外側）
 */
export function evmTestnetDeadlinesOf(network: string): { readonly inboundFacilitatorMs: number; readonly outboundPaidMs: number } | undefined {
  if (!EVM_TESTNET_NETWORKS.has(network)) return undefined;
  return SLOW_EVM_TESTNETS.has(network) ? { inboundFacilitatorMs: 50_000, outboundPaidMs: 75_000 } : { inboundFacilitatorMs: 20_000, outboundPaidMs: 30_000 };
}

/** CAIP-2 の構文そのもの（facilitator の表の鍵に使う。route の network は従来どおり文字列）。 */
const CAIP2_PATTERN = /^(eip155:[1-9][0-9]{0,19}|solana:[1-9A-HJ-NP-Za-km-z]{32})$/;

export function isCaip2Network(network: string): boolean {
  return CAIP2_PATTERN.test(network);
}

/** CAIP-2 の名前空間から族を引く。知らない名前空間は `undefined`（呼び出し側は EVM の規則に落とす: 既存の構成を壊さない）。 */
export function networkFamilyOf(network: string): NetworkFamily | undefined {
  if (network.startsWith("eip155:")) return "evm";
  if (network.startsWith("solana:")) return "svm";
  return undefined;
}

/** `eip155:<id>` の数値 chainId。EVM でなければ `undefined`（呼び出し側は署名を拒む）。 */
export function evmChainIdOf(network: string): number | undefined {
  const match = /^eip155:([1-9][0-9]{0,15})$/.exec(network);
  if (match === null) return undefined;
  const id = Number(match[1]);
  // 安全な整数の外は丸まって別の chainId になるので受けない。
  return Number.isSafeInteger(id) ? id : undefined;
}

/** 資産の比較の鍵。EVM は小文字化、SVM はそのまま（base58 は大文字小文字を区別する）。予算の鍵には使わない（設定の文字列のまま）。 */
export function assetKeyOf(network: string, asset: string): string {
  return networkFamilyOf(network) === "svm" ? asset : asset.toLowerCase();
}

/** 受取先の形。EVM: `0x`＋40 hex。SVM: base58 を decode して 32 バイト（owner の公開鍵。ATA ではない）。 */
export function isWellFormedPayTo(network: string, payTo: string): boolean {
  if (networkFamilyOf(network) === "svm") {
    if (!BASE58_PATTERN.test(payTo)) return false;
    return base58DecodedLength(payTo) === 32;
  }
  return ADDRESS_PATTERN.test(payTo);
}

export function knownNetworkOf(networks: readonly KnownNetwork[], network: string): KnownNetwork | undefined {
  return networks.find((entry) => entry.network === network);
}

export function knownAssetOf(entry: KnownNetwork, asset: string): KnownAsset | undefined {
  const key = assetKeyOf(entry.network, asset);
  return entry.assets.find((known) => assetKeyOf(entry.network, known.id) === key);
}
