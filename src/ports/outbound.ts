/**
 * 送信レールのポート（設計 §4.2）。相手レグの金額・予算には触れない。
 */

import type { ClientEvmSigner } from "@x402/evm";

/**
 * 送信レール A（x402 / EVM）の**署名能力**。Router はこの中身を持たず、起動時に外から
 * 注入されたものだけを使う（設計 §4.2 の受け皿 B にあたる guarded signer の入口）。
 *
 * - `kind: "real-key"` は実鍵による署名能力。実決済ゲート（B-01）が別途必要。
 * - `kind: "non-signing-fixture"` は**署名しない**試験用 spy（無課金 fixture 専用）。
 *   adapter は loopback 以外の上流へはこの能力を使わない。
 * 能力が無いときは合成レールへ**落とさず** fail closed にする（合成を本番既定にしない）。
 */
export interface EvmSigningCapability {
  /** CAIP-2 network。承認済み offer の `network` と一致しないと使わない。 */
  readonly network: string;
  /** 公式 `@x402/evm` の `ClientEvmSigner`（`address` + `signTypedData`）。 */
  readonly signer: ClientEvmSigner;
  readonly kind: "real-key" | "non-signing-fixture";
}

export interface DestinationOffer {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface PayRequest {
  readonly routeId: string;
  /** 承認済み `selectedOffer`。凍結した accepts をそのまま渡さない。 */
  readonly offer: DestinationOffer;
  readonly paymentId: string;
  readonly attempt: number;
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

export interface OutboundRail {
  /** 上流の現在の 402 challenge を読む（純粋読取・無課金）。 */
  readChallenge(routeId: string): Promise<readonly DestinationOffer[]>;
  pay(request: PayRequest): Promise<PayResult>;
}
