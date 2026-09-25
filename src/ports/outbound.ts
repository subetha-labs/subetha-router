/**
 * 送信レールのポート（設計 §4.2）。相手レグの金額・予算には触れない。
 */

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
