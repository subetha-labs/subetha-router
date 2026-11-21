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
  /**
   * quote の要求の識別（`docs/subetha-exact-inbound-design.md` §2、要件 FR-2）。core は静的・動的・秘匿の 3 箇所で渡す。
   * 読むのは `subetha-exact`（facilitator の注文の requester を決定的に導く）だけで、ほかの rail は見ない。
   */
  readonly requester?: { readonly principalId: string; readonly requestId: string };
  /**
   * 標準の x402 クライアント用の入口の offer（`docs/x402-standard-entry-design.md` §3）。読むのは `subetha-exact` だけ。
   * 印の付いた offer は `extra.entry === "x402"` を持ち、買い手が決めた nonce の署名を受ける。
   */
  readonly entry?: "x402";
}

/** verify の結果（`docs/subetha-exact-inbound-design.md` §2）。既存の 2 欄に `mayStillSettleUntil` を足しただけで、既存の実装はそのまま適合する。 */
export interface InboundVerifyResult {
  readonly isValid: boolean;
  readonly fundsMoved?: boolean;
  /**
   * 手元の署名の検査が通った = **実行可能な authorization が存在する**。その `validBefore`（unix 秒）。Router が送らなくても、それを持つ誰かが
   * `validBefore` まで chain に出せる（要件 FR-4.1・FR-4.4 (ii)）。持たない rail は欄なし。
   */
  readonly mayStillSettleUntil?: number;
}

/**
 * release の結果（設計 §2・§3.8 C／D）。`none` は **wrapper が「この rail は release を持たない」と言うときだけ**（下の rail に method が無い）。
 * release を実装する adapter は `none` を返してはならない。
 */
export type ReleaseResult =
  | { readonly outcome: "none" }
  | { readonly outcome: "released"; readonly deliveryKey: string; readonly txRef: string; readonly eventId: string }
  | { readonly outcome: "refused"; readonly reason: "source_release_refused" }
  | { readonly outcome: "unknown"; readonly reason: "source_release_unknown" };

/**
 * complete の報告が届かなかった理由（journal の `source_complete_unreported` に写す固定の token。設計 §2・§3.8 E）。
 * 一時は `unavailable` だけ（起動時の掃き出しが 1 回だけ再試行する）。ほかは恒久（反復で解けない。要件 FR-6）。
 */
export type CompleteUnreportedReason =
  | "conflicting_outcome"
  | "not_authorized"
  | "delivery_key_mismatch"
  | "unknown_order"
  | "unknown_tenant"
  | "unauthorized"
  | "invalid_request"
  | "refused"
  | "unavailable";
export const COMPLETE_TRANSIENT_REASONS: ReadonlySet<CompleteUnreportedReason> = Object.freeze(new Set<CompleteUnreportedReason>(["unavailable"]));
export const COMPLETE_UNREPORTED_REASONS: ReadonlySet<string> = Object.freeze(
  new Set<string>(["conflicting_outcome", "not_authorized", "delivery_key_mismatch", "unknown_order", "unknown_tenant", "unauthorized", "invalid_request", "refused", "unavailable"]),
);

/** complete の結果（設計 §2）。`none` は wrapper だけ（上と同じ）。 */
export type CompleteResult = { readonly outcome: "none" } | { readonly outcome: "completed" } | { readonly outcome: "unreported"; readonly reason: CompleteUnreportedReason };

/** quote の失敗の固定の token（設計 §2）。`unavailable` の 3 つは予約を未解決のまま、`refused` は確定、`limit_*`・`requester_missing`・`ledger_unavailable` は facilitator を呼ばない。 */
export type OfferRefusalDetail =
  | "facilitator_busy"
  | "rate_limited"
  | "response_unreadable"
  | "amount_refused"
  | "unauthorized"
  | "unknown_tenant"
  | "requirements_mismatch"
  | "order_reused_expired"
  | "order_reused_mismatch"
  | "order_reused_other_id"
  | "limit_total"
  | "limit_unresolved"
  | "limit_rate"
  | "limit_concurrency"
  | "requester_missing"
  | "ledger_unavailable"
  | "order_exists"
  | "order_window_short";

/** `OfferRefusalDetail` の閉じた集合（core が公開の面へ写す前に照合する。これ以外の文字列は落とす）。 */
export const OFFER_REFUSAL_DETAILS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    "facilitator_busy", "rate_limited", "response_unreadable", "amount_refused", "unauthorized", "unknown_tenant", "requirements_mismatch",
    "order_reused_expired", "order_reused_mismatch", "order_reused_other_id", "limit_total", "limit_unresolved", "limit_rate", "limit_concurrency",
    "requester_missing", "ledger_unavailable", "order_exists", "order_window_short",
  ]),
);
/** `retryAfterMs` の上限（1 時間。それより長い値は目安として意味が無い）。 */
export const OFFER_RETRY_AFTER_MAX_MS = 3_600_000;

/**
 * quote の失敗（資金は動いていない。要件 FR-2.1）。core は `QuoteOutcome` の `code`・`reason`・`retryAfterMs` に写す。
 * `detail` は固定の token だけ（facilitator の文章・URL・token は載せない）。
 */
export class InboundOfferError extends Error {
  readonly code: "source_offer_unavailable" | "source_offer_refused";
  readonly detail: OfferRefusalDetail;
  readonly retryAfterMs: number | undefined;

  constructor(code: "source_offer_unavailable" | "source_offer_refused", detail: OfferRefusalDetail, retryAfterMs?: number) {
    super(`${code}: ${detail}`);
    this.name = "InboundOfferError";
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/** strict preflight の結果。`ok:false` なら有料ライフサイクルを開始しない。 */
export type PreflightResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type SettleResult =
  /**
   * `eventId`（任意）: 支払いイベントの識別子（x402 受信 = 検証済み payload の authorization `nonce`、小文字）。秘匿購入の二重一意性（FR-Z06 (b)）の材料で、
   * core は `source_settled` の行に写す。返さない rail では秘匿購入が fail closed になる（黙って `txRef` だけに落とさない）。
   */
  | { readonly outcome: "settled"; readonly txRef: string; readonly eventId?: string }
  | { readonly outcome: "rejected"; readonly reason: string }
  /** `mayStillSettleUntil`（任意）: `subetha-exact` の表 B（`docs/subetha-exact-inbound-design.md` §3.8）。core は verify で得た値を使い、この欄は記録と契約のため。 */
  | { readonly outcome: "unknown"; readonly reason: string; readonly mayStillSettleUntil?: number };

/** core が受信操作に添える文脈（運用者向け診断の route 帰属。設計 A §3.5）。`deadlineMs`・`sourceTxRef` は release・complete（`docs/subetha-exact-inbound-design.md` §2）。 */
export interface InboundCallContext {
  readonly routeId: string;
  /** release の再試行の上限（承認期限、ms）。無ければ adapter の既定。 */
  readonly deadlineMs?: number;
  /** settle の `txRef`（release の応答の照合）。 */
  readonly sourceTxRef?: string;
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
  verify(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<InboundVerifyResult>;
  settle(offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext): Promise<SettleResult>;
  /**
   * 同期。credential を見る前でも言える「この offer への標準の署名が実行可能でいられる上限」（unix 秒。要件 FR-4.4 (i)(i′)）。
   * core は quote のときに 1 回呼び、`created` の行に `source.settleWindow` として写す。持たない rail は `undefined`（欄が出ない）。
   */
  settleWindowOf?(offer: InboundOffer): number | undefined;
  /**
   * 手元の署名の検査（`docs/x402-standard-entry-design.md` §4.4 (a)）: credential の署名が offer の domain で `from` のものか。facilitator を呼ばない。
   * 標準入口は、最初の credential を注文に結び付ける前にこれを呼ぶ。持たない rail は標準入口を使えない。`true` だけが「本物」。
   */
  checkSignature?(offer: InboundOffer, credential: PaymentCredential): Promise<boolean>;
  /**
   * 同期。過去に自分が発行した offer か（route の束縛が設定から消えた後でも scheme・network・資産で判定できる rail だけ）。wrapper が束縛で
   * rail を引けないとき、`complete` に限って fallback に使う（設計 §2）。
   */
  ownsOffer?(offer: InboundOffer): boolean;
  /**
   * settle の後・上流への支払いの前に 1 回（設計 §4.4、要件 FR-5）。持たない rail は method を持たない（core は `typeof` で見る）。
   * wrapper は常に定義し、下の rail に無ければ `{ outcome: "none" }`。
   */
  release?(offer: InboundOffer, context: InboundCallContext): Promise<ReleaseResult>;
  /** 終端の後の報告（設計 §4.5、要件 FR-6）。同じ規則。 */
  complete?(offer: InboundOffer, deliveryKey: string, outcome: "delivered" | "failed", context: InboundCallContext): Promise<CompleteResult>;
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
