/**
 * intent の状態と公開値への写像（設計 §5 / §7）。rail 名で分岐しない。
 */

import { createHash } from "node:crypto";

import type { DestinationOffer } from "../ports/outbound.js";
import type { InboundOffer } from "../ports/inbound.js";

export type InternalStatus =
  | "created"
  | "source_pending"
  | "source_settled"
  | "destination_pending"
  | "destination_submitted"
  | "delivered"
  | "paid_undelivered"
  | "unknown"
  | "source_failed"
  | "dest_failed";

export type PublicStatus =
  | "awaiting_payment"
  | "paid"
  | "delivered"
  | "paid_data_unavailable"
  | "unknown";

/** 送信レグがどう終わったか（公開射影に常に含める）。 */
export type DestinationOutcome = "none" | "not_sent" | "rejected" | "failed" | "unknown" | "paid";

const PUBLIC_STATUS: Readonly<Record<InternalStatus, PublicStatus>> = {
  created: "awaiting_payment",
  source_pending: "awaiting_payment",
  source_failed: "awaiting_payment",
  source_settled: "paid",
  destination_pending: "paid",
  destination_submitted: "paid",
  delivered: "delivered",
  paid_undelivered: "paid_data_unavailable",
  dest_failed: "paid_data_unavailable",
  unknown: "unknown",
};

/** 再起動で変化しない確定済み終了状態。 */
const TERMINAL: ReadonlySet<InternalStatus> = new Set<InternalStatus>([
  "delivered",
  "paid_undelivered",
  "unknown",
  "source_failed",
  "dest_failed",
]);

/**
 * 再起動時に終端へ確定する中断された途中状態。`source_pending`・`destination_pending`・`destination_submitted` は `unknown`。
 * `source_settled`（受信は確定、送信の `destination_pending` を書く前の読み直しの最中）は `paid_undelivered`（未送出）: 含めないと再起動後も
 * 終端にならず、再提出が `paid` を返し続ける（SR-3 SVM レビュー #2、2026-10-08）。受信の証跡は保たれ、送信は始めない。
 */
const INTERRUPTED: ReadonlySet<InternalStatus> = new Set<InternalStatus>([
  "source_pending",
  "source_settled",
  "destination_pending",
  "destination_submitted",
]);

export function toPublicStatus(status: InternalStatus): PublicStatus {
  return PUBLIC_STATUS[status];
}

export function isTerminal(status: InternalStatus): boolean {
  return TERMINAL.has(status);
}

export function isInterrupted(status: InternalStatus): boolean {
  return INTERRUPTED.has(status);
}

export interface IntentSource {
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly offer: InboundOffer;
  readonly txRef?: string;
  readonly outcome?: string;
}

export interface IntentDestination {
  readonly quoted: string;
  readonly asset: string;
  readonly network: string;
  readonly selectedOffer: DestinationOffer;
  readonly attempt: number;
  readonly outcome: DestinationOutcome;
  readonly txRef?: string;
  readonly receiptRef?: string;
}

export interface IntentResult {
  readonly body: unknown;
  readonly contentType: string;
}

/** 動的購入の上流（設計 `docs/dynamic-upstream-design.md` §2.4）。検査済みの URL そのもの。 */
export interface IntentUpstream {
  readonly url: string;
  /** `docs/dynamic-upstream-post-design.md` FR-P2: POST は Router が送る本文（canonical JSON の文字列）とその sha256 を持つ。 */
  readonly method: "GET" | "POST";
  readonly body?: string;
  readonly bodySha256?: string;
}

/** 動的購入の、quote 時に固定した条件。承認対象に出す値はすべてここから組む。 */
export interface IntentDynamic {
  readonly profileId: string;
  /** 適用したプロファイルの写し（表示と、後からの照合のため）。 */
  readonly profile: Readonly<Record<string, unknown>>;
  /** 上流額・換算後・手数料・受信額（すべて base units の 10 進文字列）。 */
  readonly pricing: {
    readonly upstreamAmount: string;
    readonly converted: string;
    readonly fee: string;
    readonly total: string;
    /** MPP 送信だけ: quote が決めた署名時の手数料の上限（cap。`docs/dynamic-gas-fee-design.md` §2）。 */
    readonly maxFee?: string;
    /** MPP 送信だけ: quote 時の見積りの証跡（変えない。§3.1）。 */
    readonly estimate?: { readonly gas: string; readonly maxFeePerGas: string; readonly bound: string; readonly atMs: number };
  };
  /** 持ち主の証明のハッシュ（`sha256:<hex>`）。証明そのものは保存しない。 */
  readonly ownerKeyHash: string;
  /** 昇格（journal への記録）のときに付く予約。控えの段階では無い。 */
  readonly reservation?: { readonly legs: readonly { readonly network: string; readonly asset: string; readonly amount: string }[] };
}

export interface Intent {
  readonly paymentId: string;
  readonly quoteId: string;
  readonly routeId: string;
  /** 所有 principal。他 principal は開始も参照もできない。 */
  readonly principalId: string;
  readonly requestId: string;
  readonly status: InternalStatus;
  readonly source: IntentSource;
  readonly destination: IntentDestination;
  readonly quoteFingerprint: string;
  /**
   * quote 時点の **route 設定**の指紋（FR-17）。`quoteFingerprint` は上流 offer の指紋であり、
   * こちらは**設定側**。両方が必要なのは、守る対象が違うため
   * （上流の提示変化 vs 運用者による設定変更）。
   */
  readonly routeFingerprint?: string;
  /** 指紋欄が存在するが読めない形だった。legacy と区別する（設計 §11.3）。 */
  readonly routeFingerprintInvalid?: boolean;
  /** 動的購入の上流。静的 route の intent には無い。 */
  readonly upstream?: IntentUpstream;
  /** 動的購入の条件。静的 route の intent には無い。 */
  readonly dynamic?: IntentDynamic;
  /** `upstream`／`dynamic` の欄があるのに読めない形だった。**この intent は実行しない。** */
  readonly dynamicInvalid?: boolean;
  /**
   * MPP 送信の記録なのに cap（`pricing.maxFee`・`pricing.estimate`）が無い・形が違う・手数料 < cap。`dynamic` は保たれる
   * （状態の照会・予算の集計は通る）が、**purchase は実行しない**（`docs/dynamic-gas-fee-design.md` §3.2）。
   */
  readonly dynamicCapInvalid?: boolean;
  /** 承認の絶対期限（ミリ秒）。発行 offer の失効時刻で上限を切る。 */
  readonly approvalDeadlineMs: number;
  readonly result?: IntentResult;
  readonly terminalReason?: string;
  readonly updatedAt: string;
}

/** キー順に依存しない安定 JSON（offer の完全一致比較に使う）。 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`);
  return `{${entries.join(",")}}`;
}

/** canonical（キー順非依存）な JSON の sha256。生の offer 内容は持ち回らない。 */
export function fingerprintOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}
