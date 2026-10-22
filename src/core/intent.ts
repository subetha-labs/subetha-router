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
  | "dest_failed"
  /** 秘匿購入（`docs/zktls-router-design.md` §7.1）: 発行予約 → release → Payer へ引き渡し → record → attest 成立。 */
  | "private_issuance_reserved"
  | "private_released"
  | "private_awaiting_session"
  | "private_recorded"
  | "delivered_private";

export type PublicStatus =
  | "awaiting_payment"
  | "paid"
  | "delivered"
  | "paid_data_unavailable"
  | "unknown"
  /** 秘匿購入だけ。`awaiting_session` = credential を Payer に渡し MPC-TLS セッションを待つ、`attesting` = record があり bundle を待つ。 */
  | "awaiting_session"
  | "attesting"
  | "delivered_private";

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
  private_issuance_reserved: "paid",
  private_released: "paid",
  private_awaiting_session: "awaiting_session",
  private_recorded: "attesting",
  delivered_private: "delivered_private",
};

/** 再起動で変化しない確定済み終了状態。 */
const TERMINAL: ReadonlySet<InternalStatus> = new Set<InternalStatus>([
  "delivered",
  "paid_undelivered",
  "unknown",
  "source_failed",
  "dest_failed",
  "delivered_private",
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
  // 秘匿購入（設計 §7.1 の「再起動」列）: 発行予約の後はすべて `unknown`（credential は再発行しない。要件 FR-Z25）。
  "private_issuance_reserved",
  "private_released",
  "private_awaiting_session",
  "private_recorded",
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
  /** 受信 settle の支払いイベントの識別子（x402 受信: authorization の nonce。秘匿購入の二重一意性 FR-Z06 (b) の材料）。 */
  readonly eventId?: string;
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
  /** 秘匿購入: Provider の領収ヘッダの sha256（原本は認証済みの record にだけ。§3.4）。 */
  readonly receiptSha256?: string;
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

/** 秘匿購入の記録（`docs/zktls-router-design.md` §7.2）。`created` 行の `private` 欄と、以後の private_* 行から組む。 */
export interface IntentPrivate {
  readonly intentSha256: string;
  /** Payer が送った封筒の正確なバイト列（base64）。配布・Verifier の入力に使う。射影には出さない。 */
  readonly intentB64: string;
  readonly orderId: string;
  readonly payerPk: { readonly x: string; readonly y: string };
  readonly target: { readonly host: string; readonly port: 443; readonly path: string };
  readonly method: "GET" | "POST";
  readonly framing: string;
  readonly bodyLen: number;
  readonly bodyCommitmentHex: string;
  readonly executorHeader: string;
  readonly maxExecutorValueLen: number;
  readonly outbound: { readonly protocol: "x402" | "mpp"; readonly network: string; readonly asset: string; readonly payTo: string; readonly maxAmount: string };
  readonly inbound: { readonly network: string; readonly asset: string; readonly maxTotal: string };
  /** 承認した方針の写し（期限はここから導く。設定の変更は指紋で検出する）。 */
  readonly policy: { readonly minCredentialLifetimeMs: number; readonly sessionTimeoutMs: number; readonly attestTimeoutMs: number; readonly retentionMs: number };
  readonly limits: { readonly maxIntentBytes: number; readonly maxBundleBytes: number; readonly maxRecordBytes: number };
  /** `private_issuance_reserved` 行。 */
  readonly reservation?: { readonly intentSha256: string; readonly inboundIdentity: string };
  /** `private_released` 行（credential の値は無い）。 */
  readonly issuance?: { readonly headerName: string; readonly headerSha256: string; readonly expiresAtMs: number; readonly expectedRef?: string; readonly releaseB64: string; readonly sessionBy: number };
  /** `private_handed_over` 行。 */
  readonly handover?: { readonly handedOverAtMs: number; readonly verifierAddress: string };
  /** `private_recorded` 行（record 本体は無い）。 */
  readonly record?: {
    readonly sha256: string;
    readonly bytes: number;
    readonly completedAtMs: number;
    readonly summary: Readonly<Record<string, unknown>>;
    readonly attestBy?: number;
    readonly recordAvailableUntil: number;
    readonly recoveredAtRestart?: boolean;
    readonly late?: boolean;
    readonly expired?: boolean;
  };
  /** attest の耐久結果（`private_attested` または `attest` 付きの `unknown` 行）。 */
  readonly attest?: { readonly bundleSha256: string; readonly result: "delivered_private" | "unknown"; readonly reason?: string };
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
  /** 秘匿購入の記録。無ければ通常の購入。 */
  readonly private?: IntentPrivate;
  /** `private` 欄があるのに読めない形だった。**この intent は実行しない**（状態の照会はできる）。 */
  readonly privateInvalid?: boolean;
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
