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

/** 再起動時に `unknown` へ確定する中断された途中状態。 */
const INTERRUPTED: ReadonlySet<InternalStatus> = new Set<InternalStatus>([
  "source_pending",
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
