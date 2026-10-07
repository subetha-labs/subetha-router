/**
 * 送信レールのポート（設計 §4.2）。相手レグの金額・予算には触れない。
 */

import type { ClientEvmSigner } from "@x402/evm";
import type { Account, Client } from "viem";

/**
 * 送信レール A（x402 / EVM）の**署名能力**。Router はこの中身を持たず、起動時に外から
 * 注入されたものだけを使う（設計 §4.2 の受け皿 B にあたる guarded signer の入口）。
 *
 * - `kind: "real-key"` は実鍵による署名能力。実決済ゲート（B-01）が別途必要。
 * - `kind: "non-signing-fixture"` は**署名しない**試験用 spy（無課金 fixture 専用）。
 *   adapter は loopback 以外の上流へはこの能力を使わない。
 * 能力が無いときは合成レールへ**落とさず** fail closed にする（合成を本番既定にしない）。
 */
/**
 * 送信レール B（MPP / Tempo charge）の**支払い能力**。Router は鍵も RPC 権限も持たず、
 * 起動時に外から注入された account と client だけを公式 `mppx` に渡す。
 *
 * - `kind: "real-key"` は実鍵・実 RPC の能力（実決済ゲートが別途必要）。
 * - `kind: "non-signing-fixture"` は**署名も broadcast もしない**試験用 spy。
 * 能力が無いときは合成レールへ落とさず fail closed にする。
 */
export interface MppTempoCapability {
  /** 支払いチェーン ID（testnet / mainnet を混同しないため明示する）。 */
  readonly chainId: number;
  /** 支払い元 account（viem の account。`address` は receipt 照合に使う）。 */
  readonly account: Account;
  /**
   * チェーン ID から client を返す（実 RPC / 送金権限はこの外側が持つ）。
   * adapter はこの client を 1 支払い 1 送金要求に制限する wrapper で包んで使う。
   */
  readonly getClient: (parameters: { chainId?: number | undefined }) => Client | Promise<Client>;
  /** `push`（client が broadcast）/ `pull`（server が broadcast）。 */
  readonly mode?: "push" | "pull";
  readonly kind: "real-key" | "non-signing-fixture";
  /**
   * 支払い元の残高（base units）を読む。省略可。あるとき、動的購入は受信 settle の前に残高を確かめる
   * （設計 `docs/dynamic-upstream-design.md` §6.6）。読取だけで、署名も送金もしない。
   */
  readonly balanceOf?: (asset: string) => Promise<bigint>;
}

export interface EvmSigningCapability {
  /** CAIP-2 network。承認済み offer の `network` と一致しないと使わない。 */
  readonly network: string;
  /** 公式 `@x402/evm` の `ClientEvmSigner`（`address` + `signTypedData`）。 */
  readonly signer: ClientEvmSigner;
  readonly kind: "real-key" | "non-signing-fixture";
  /** 支払い元の残高（base units）を読む。省略可（上の `MppTempoCapability.balanceOf` と同じ）。 */
  readonly balanceOf?: (asset: string) => Promise<bigint>;
}

export interface DestinationOffer {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * 動的購入の上流（設計 `docs/dynamic-upstream-design.md` §3）。`url` は `parseUpstreamUrl` を通った文字列そのもの。
 * これを受け取った adapter は、起動時に設定された URL ではなく**この URL**に接続する。
 * 動的経路を持たない adapter は、受け取ったら例外にする（静的の URL に黙って落とさない）。
 */
export interface UpstreamTarget {
  readonly url: string;
}

/** 動的経路を持たない adapter に上流の URL が渡された。 */
export class DynamicTargetUnsupportedError extends Error {
  readonly code = "dynamic_target_unsupported";

  constructor() {
    super("this outbound adapter has no dynamic path");
    this.name = "DynamicTargetUnsupportedError";
  }
}

/** message の hash の予約の結果（送信の設計 §2.5、FR-37）。`collision` は同じ message に二度署名しないための拒否。 */
export type MessageReservation = "reserved" | "collision" | "unavailable";

export interface PayRequest {
  readonly routeId: string;
  /** 承認済み `selectedOffer`。凍結した accepts をそのまま渡さない。 */
  readonly offer: DestinationOffer;
  readonly paymentId: string;
  readonly attempt: number;
  /**
   * 承認の絶対期限（ミリ秒。`intent.approvalDeadlineMs`）。adapter は**実際の署名の委譲の直前と送出の直前**に `now < deadlineMs` を見て、
   * 過ぎていれば `not_sent`（送信の設計 §2.4、FR-36）。
   */
  readonly deadlineMs: number;
  /**
   * 署名する message の hash（sha256 の小文字 hex 64 文字）を**署名の前に**排他的に予約する（送信の設計 §2.5、FR-37）。
   * core が journal に束ねて渡す。使うのは SVM の rail だけ。無ければその rail は署名しない（fail closed）。
   */
  readonly reserveMessage?: (messageHash: string) => Promise<MessageReservation>;
  /** 動的購入のときだけ。静的 route では付けない。 */
  readonly target?: UpstreamTarget;
  /**
   * 動的 MPP 送信のときだけ: quote が決めた署名時の手数料の上限（cap。`pricing.maxFee`。`feeAsset` の base units の 10 進文字列）。
   * MPP の動的経路はこれが無ければ送らない。静的・x402 送信では付けない（`docs/dynamic-gas-fee-design.md` §3.4）。
   */
  readonly maxFee?: string;
}

/** quote 時のガス代の見積り（`docs/dynamic-gas-fee-design.md` §1）。すべて 10 進文字列。 */
export interface FeeEstimate {
  readonly gas: string;
  readonly maxFeePerGas: string;
  /** `ceil(gas × maxFeePerGas / 10^12)`（`feeAsset` の base units）。 */
  readonly bound: string;
  /** ノードの `eth_fillTransaction` で埋まったか（対応ノード: 1 回の RPC）。非対応ノードは運用の条件から外す（設計 §4）。 */
  readonly viaFillTransaction: boolean;
}

export type PayResult =
  /** 上流が課金し、データも返した。 */
  | {
      readonly outcome: "paid";
      readonly body: unknown;
      readonly contentType: string;
      readonly txRef?: string;
      readonly receiptRef?: string;
    }
  /** 課金は成立したがデータがない（B の 502 等）。 */
  | { readonly outcome: "paid_no_data"; readonly reason: string; readonly receiptRef?: string }
  /** 送信していない（送金前ガードで中止）。 */
  | { readonly outcome: "not_sent"; readonly reason: string }
  | { readonly outcome: "rejected"; readonly reason: string }
  /** 送金有無が不明。自動再送しない。 */
  | { readonly outcome: "unknown"; readonly reason: string };

/**
 * SVM の送信の署名の能力（送信の設計 §2.1）。署名器が受け取るのは **Router が組んで検査した message の bytes の写しだけ**。
 * 同期（`@noble/curves`）。`address` は base58 32 バイト。
 */
export interface SvmSigningCapability {
  readonly network: string;
  readonly address: string;
  readonly sign: (messageBytes: Uint8Array) => Uint8Array;
  readonly kind: "real-key" | "fixture-key";
}

export interface OutboundRail {
  /** 起動時の非同期の準備（SVM: ATA の導出と静的の宛先の検査）。無い rail は何もしない。 */
  startup?(): Promise<void>;
  /** 支払い元の残高（base units）。持たない rail は未定義（core は「検査なし」と読む）。 */
  balanceOf?(routeId: string, asset: string): Promise<bigint>;
  /** 上流の現在の 402 challenge を読む（純粋読取・無課金）。 */
  readChallenge(routeId: string, target?: UpstreamTarget): Promise<readonly DestinationOffer[]>;
  pay(request: PayRequest): Promise<PayResult>;
  /**
   * 動的 MPP 送信だけ: `offer` への送金のガス代を**署名も送金もせずに**見積もる（読取の RPC だけ）。
   * 失敗は例外（呼び出し側が quote を不成立にする）。
   */
  estimateFee?(routeId: string, offer: DestinationOffer, target: UpstreamTarget): Promise<FeeEstimate>;
}
