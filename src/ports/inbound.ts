/**
 * 受信レールのポート（設計 §4.1）。core は rail 名で分岐せず、この interface 越しにのみ触る。
 */

export interface InboundOffer {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: Readonly<Record<string, unknown>> & {
    readonly challengeNonce: string;
    readonly expiresAt: number;
    readonly routeBinding: string;
  };
}

/** payer → Router の支払い資格情報。 */
export interface PaymentCredential {
  readonly x402Version: number;
  readonly accepted: InboundOffer;
  readonly payload: Readonly<Record<string, unknown>> & { readonly challengeNonce: string };
}

export interface CreateOfferRequest {
  readonly routeId: string;
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly routeBinding: string;
  readonly nowMs: number;
}

/** strict preflight の結果。`ok:false` なら有料ライフサイクルを開始しない。 */
export type PreflightResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type SettleResult =
  | { readonly outcome: "settled"; readonly txRef: string }
  | { readonly outcome: "rejected"; readonly reason: string }
  | { readonly outcome: "unknown"; readonly reason: string };

export interface InboundRail {
  createOffer(request: CreateOfferRequest): Promise<InboundOffer>;
  /**
   * nonce 既知・未失効・route 束縛一致・発行 offer との完全一致を journal 生成**前**に検査する。
   * この関数を持たない adapter では有料ライフサイクルを開始しない（fail closed）。
   */
  preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult;
  verify(offer: InboundOffer, credential: PaymentCredential): Promise<{ isValid: boolean }>;
  settle(offer: InboundOffer, credential: PaymentCredential): Promise<SettleResult>;
}
