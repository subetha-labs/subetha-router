/**
 * 既存 chat（`ChatExecutionFactory` の実装者は別オーナー）から Router を呼ぶための公開型。
 *
 * この層は**支払い資格情報を作らない**。credential は明示承認のあとに呼び出し側が渡す既存の値
 * だけを使い、鍵・署名・ブロードキャストには一切触れない。Router の snapshot エンベロープは
 * そのまま渡し、article 型へ cast したり擬似 article を合成したりしない。
 */

export interface RouterClientOptions {
  /** Router の origin（設定値）。要求はこの origin にのみ出す。 */
  readonly baseUrl: string;
  readonly principalId: string;
  /** principal トークン。比較のために Router へ送るだけで、結果・エラーには載せない。 */
  readonly token: string;
  /** 差し替え可能な fetch（既定は `globalThis.fetch`）。 */
  readonly fetch?: typeof globalThis.fetch;
  /** 1 要求の期限（静的 quote・一覧・status）。既定 10 秒。 */
  readonly timeoutMs?: number;
  /**
   * **動的 quote**（`quoteUrl`）の期限。既定 30 秒（`DEFAULT_DYNAMIC_QUOTE_TIMEOUT_MS`）。動的 quote は上流の読取（5 秒）に加え、MPP 送信では
   * ガス代の見積り（6 秒。`docs/dynamic-gas-fee-design.md` §1.2）を含む。優先順位: これ → 明示した `timeoutMs` → 既定（明示した `timeoutMs` は従来どおり効く）。
   */
  readonly quoteTimeoutMs?: number;
  /**
   * **購入**（R3。静的も動的も）の期限。既定 180 秒（`DEFAULT_EXECUTE_TIMEOUT_MS`。multirail 設計 §4.4）。
   * 動的購入は、settle 前の上流の読み直し（5 秒）・MPP 送信の再見積り（6 秒）・受信 verify と settle（10 秒＋最大 50 秒）・送信前の読み直し（5 秒）・
   * 送信（最悪 66 秒。設計 §3.4）を含み、合計で 142 秒ほどになり得る。Arc（Circle）・Solana の静的購入も settle に 40〜50 秒掛かり得る。
   * 短く切ると、Router が支払いを続けているのに `unknown` になる。購入を短く抑えたい呼び出し側はこれを明示する（`timeoutMs` は購入に効かない）。
   */
  readonly executeTimeoutMs?: number;
  /** **試験専用。** 要求の期限の signal を作る関数（既定 `AbortSignal.timeout`）。期限の値を観測するために差し替える。 */
  readonly signalForTest?: (ms: number) => AbortSignal;
  /**
   * **ステートレス運用の明示的な opt-in**（既定 `false`）。
   *
   * 既定では `execute()` は**この client が発行した quote だけ**を実行する
   * （プロセス内の `issued` スナップショットと照合する）。リモート MCP のように
   * quote と purchase が別プロセスになる構成ではこれが必ず失敗するため、
   * **呼び出し側が quote を持ち回る**慣行（payment attaches to calls, not sessions）に合わせる。
   *
   * **緩むのは client 側の補助検査だけ**で、Router 側の拒否面は一切変わらない:
   * `approval !== quoteId`（`orchestrator.ts:392`）、承認期限、発行していない nonce の拒否、
   * offer と設定の照合、at-most-once はすべて core 側に残る。
   * 改竄した quote を持ち込んでも、Router は自分が発行した値しか受け付けない。
   */
  readonly allowUnissuedQuotes?: boolean;
  /** 送信元の識別（`x-router-source`）。MCP 層が要求ごとに導いた値を渡す。省略時は付けない。 */
  readonly source?: string;
}

export interface ResourceRef {
  readonly url: string;
  readonly method: string;
}

/** R1 の allowlist 項目（上流 URL は含まれない）。 */
export interface RouteListing {
  readonly routeId: string;
  readonly resource: ResourceRef;
  readonly source: Readonly<Record<string, unknown>>;
  readonly destination: Readonly<Record<string, unknown>>;
}

/** R2 の quote 文書。`approval.boundTo` が承認対象の `quoteId`。 */
export interface QuoteView {
  readonly quoteId: string;
  readonly paymentId: string;
  readonly routeId: string;
  readonly resource: ResourceRef;
  readonly source: {
    readonly amount: string;
    readonly asset: string;
    readonly network: string;
    readonly payTo?: string;
    readonly expiresAt?: number;
    /** 受信レールの発行 offer。credential は呼び出し側がこれに対して用意する。 */
    readonly offer: unknown;
  } & Readonly<Record<string, unknown>>;
  readonly destination: {
    readonly quoted: string;
    readonly asset: string;
    readonly network: string;
    readonly quoteFingerprint: string;
  } & Readonly<Record<string, unknown>>;
  readonly approval: {
    readonly required: boolean;
    readonly boundTo: string;
    readonly deadlineMs: number;
  };
  /** 動的 quote だけ（設計 §8）。 */
  readonly upstream?: { readonly url: string; readonly method: string };
  readonly pricing?: Readonly<Record<string, unknown>>;
  readonly disclosures?: Readonly<Record<string, unknown>>;
  /** 動的 quote の持ち主の証明。purchase・status で Router に返す。**表示・保存の対象ではない。** */
  readonly ownerKey?: string;
}

export type QuoteResult =
  | { readonly ok: true; readonly quote: QuoteView }
  /**
   * 失敗。`reason` は Router が返した固定コード（`^[a-z_]{1,64}$` に合うものだけ）、`retryAfterMs` は `Retry-After` ヘッダから
   * （**quote の再試行の目安であって purchase の再試行の許可ではない**）。どちらも無ければ欄ごと無い（H-1、要件 FR-A25）。
   */
  | { readonly ok: false; readonly error: string; readonly status: number; readonly reason?: string; readonly retryAfterMs?: number };

/**
 * 人間の明示承認の結果。**クライアントはこれを自分で作らない**（自動承認をしない）。
 * `quoteId` は承認した quote に束縛され、別 quote には使えない。
 */
export type ApprovalDecision =
  | { readonly approved: true; readonly quoteId: string }
  | { readonly approved: false; readonly reason?: string };

export interface ExecuteInput {
  readonly quote: QuoteView;
  /** R2 と同じ `requestId`。`unknown` のときも作り直さない。 */
  readonly requestId: string;
  readonly approval: ApprovalDecision;
  /** 承認後に呼び出し側が渡す既存の支払い資格情報（base64 の `X-Payment` 値）。 */
  readonly credential: string;
}

/**
 * 実行結果。`unknown` と `paid_data_unavailable` は別物として保つ。
 * 送信の成否が分からない場合も `paymentId` を残し、R4 で突き合わせられるようにする。
 */
export type ExecutionResult =
  | {
      readonly outcome: "delivered";
      readonly paymentId: string;
      /** Router が返した上流 snapshot そのまま（加工・cast しない）。 */
      readonly snapshot: unknown;
      readonly contentType: string;
    }
  | {
      readonly outcome: "paid_data_unavailable";
      readonly paymentId: string;
      readonly terminalReason?: string;
    }
  | { readonly outcome: "unknown"; readonly paymentId: string; readonly reason: string }
  | { readonly outcome: "payment_required"; readonly error: string; readonly paymentId?: string }
  | {
      readonly outcome: "rejected";
      readonly error: string;
      readonly status: number;
      readonly paymentId?: string;
      /** Router が返した固定コード（形式に合うものだけ）。 */
      readonly reason?: string;
    }
  /** 承認が無い／拒否された。Router へ要求を出していない。 */
  | { readonly outcome: "not_approved"; readonly reason: string; readonly paymentId?: string }
  /** 承認が別 quote に向いている。Router へ要求を出していない。 */
  | { readonly outcome: "approval_mismatch"; readonly reason: string; readonly paymentId?: string }
  /** quote の resource が承認した canonical path と違う。Router へ要求を出していない。 */
  | { readonly outcome: "resource_mismatch"; readonly reason: string; readonly paymentId?: string };

/** R4 の公開射影（固定フィールド）。 */
export interface ProjectionView {
  readonly paymentId: string;
  readonly routeId: string;
  readonly status: string;
  readonly source: Readonly<Record<string, unknown>>;
  readonly destination: Readonly<Record<string, unknown>>;
  readonly quoteFingerprint: string;
  readonly terminalReason?: string;
  readonly updatedAt: string;
  /** `delivered` のときだけ現れる上流 snapshot。 */
  readonly result?: unknown;
  /** 動的購入だけ。 */
  readonly upstream?: Readonly<Record<string, unknown>>;
  readonly dynamic?: Readonly<Record<string, unknown>>;
}

export type StatusResult =
  | { readonly found: true; readonly projection: ProjectionView }
  /**
   * 見つからない／受理しない。`reason` は固定コードのみ: `not_found`（404）/ `unauthorized`（401・403 = 動的の `ownerKey` が無い・違う）/
   * `http_error`（他の status）/ `projection_malformed` / `payment_id_mismatch` / `transport_failed`（H-1 で常に付く）。
   */
  | { readonly found: false; readonly status: number; readonly reason: string };

export interface RouterClient {
  /** `dynamic` は Router に動的プロファイルの設定があるときだけ（`enabled` と一覧）。 */
  listRoutes(): Promise<{ readonly ok: boolean; readonly routes: readonly RouteListing[]; readonly dynamic?: Readonly<Record<string, unknown>> }>;
  quote(input: { readonly routeId: string; readonly requestId: string }): Promise<QuoteResult>;
  /** 動的上流 URL の quote（設計 §2.1）。`profileId` はプロファイルの ID。 */
  quoteUrl(input: { readonly profileId: string; readonly url: string; readonly requestId: string }): Promise<QuoteResult>;
  /** 明示承認済みのときだけ R3 を 1 回呼ぶ（再試行・再 quote をしない）。 */
  execute(input: ExecuteInput): Promise<ExecutionResult>;
  /** 動的購入は持ち主の証明（`ownerKey`）が無いと読めない。 */
  status(paymentId: string, ownerKey?: string): Promise<StatusResult>;
}
