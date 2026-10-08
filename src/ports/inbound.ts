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

/** core が受信操作に添える文脈（運用者向け診断の route 帰属。設計 A §3.5）。 */
export interface InboundCallContext {
  readonly routeId: string;
}

export interface InboundRail {
  createOffer(request: CreateOfferRequest): Promise<InboundOffer>;
  /**
   * nonce 既知・未失効・route 束縛一致・発行 offer との完全一致を journal 生成**前**に検査する。
   * この関数を持たない adapter では有料ライフサイクルを開始しない（fail closed）。
   */
  preflight(offer: InboundOffer, credential: PaymentCredential, nowMs: number): PreflightResult;
  /**
   * `fundsMoved`（任意）: この credential の資金が**既に動いた**と adapter が知っているか（MPP Solana の `signature` 型 = payer が送出済み）。
   * 無ければ core は offer の `extra.fundsMoveOnCredential` で判断する。verify の後に settle へ進めない失敗（期限・予約）は、資金が動いた
   * credential では `not_sent`（未払いの公言）にせず `unknown` に写す。
   */
  verify(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<{ isValid: boolean; fundsMoved?: boolean }>;
  settle(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<SettleResult>;
}

/** Circle の facilitator への売り手証明（multirail 設計 §3）。目的は verify・settle だけ。 */
export type SellerProofPurpose = "verify" | "settle";

/**
 * 売り手証明の能力。**`SellerRequest` 型にだけ署名する**（EIP-3009 の authorization や任意の typed data には署名できない）。
 * 時刻・nonce・method は能力の中で決める。`src/` は鍵を持たず、起動側（`tools/`）が作って注入する。
 */
export interface SellerProofCapability {
  /** 束縛された network（CAIP-2）。 */
  readonly network: string;
  /** 受取先（この鍵のアドレス）。route／プロファイルの `source.payTo` と一致しなければ起動しない（合成側）。 */
  readonly address: string;
  /** `Facilitator-Seller-Proof` header の値（base64url の封筒）。拒む・署名できないときは throw。 */
  proofFor(purpose: SellerProofPurpose, bodyHash: string): Promise<string>;
}
