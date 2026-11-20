/**
 * 購入ライフサイクルの合成（設計 §4 の束縛順序）。
 * core は rail 名で分岐せず、ポート越しにのみ両レールへ触る。
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import {
  authoritativeTermsOf,
  resolveRoute,
  routeBindingOf,
  type RouteConfig,
  type RouterConfig,
} from "../config.js";
import { COMPLETE_TRANSIENT_REASONS, InboundOfferError, OFFER_REFUSAL_DETAILS, OFFER_RETRY_AFTER_MAX_MS, type InboundOffer, type InboundRail, type InboundVerifyResult, type PaymentCredential } from "../ports/inbound.js";
import type { DestinationOffer, OutboundRail } from "../ports/outbound.js";
import { Budget } from "./budget.js";
import { createDynamicCore, ownerKeyMatches, upstreamFieldsOf, upstreamTargetOf, type DynamicCore, type DynamicPricing, type DynamicQuoteFields } from "./dynamic.js";
import { DynamicGate } from "./dynamic-gate.js";
import { QuoteLedger } from "./quote-ledger.js";
import {
  fingerprintOf,
  isTerminal,
  stableJson,
  toPublicStatus,
  type DestinationOutcome,
  type Intent,
  type PublicStatus,
} from "./intent.js";
import { openJournal, type Journal } from "./journal.js";
import { classifyTransportError } from "../net/guarded-fetch.js";
import type { DiagnosticsSink } from "../shared/diagnostics.js";
import { DISABLED_PURCHASE_DIAGNOSTICS, withPurchaseDiagnostics, type PurchaseDiagnostics } from "./purchase-diagnostics.js";
import { createPrivateCore, type AttestOutcome, type HandoverView, type PrivateCore, type PrivateCoreOptions, type PrivateHooksForTest, type PrivateQuoteFields, type RecordOutcome } from "./private.js";
import type { PrivateOutboundRail } from "../ports/private-outbound.js";
import type { VerifierRunner } from "../private/verifier.js";
import { IntentCollisionError, IntentStore } from "./store.js";

export interface QuoteRequest {
  readonly principalId: string;
  readonly requestId: string;
  /** 静的 route の ID、または動的プロファイルの ID（`upstream` があるとき）。 */
  readonly routeId: string;
  /** 動的上流 URL（設計 `docs/dynamic-upstream-design.md` §2.1）。無ければ静的の処理。 */
  readonly upstream?: { readonly url: string; readonly method?: "GET" | "POST"; readonly body?: unknown };
  /** 送信元の識別（門の鍵）。無ければ principal。 */
  readonly source?: string;
}

export interface QuoteDocument {
  readonly quoteId: string;
  readonly paymentId: string;
  readonly routeId: string;
  readonly source: {
    readonly amount: string;
    readonly asset: string;
    readonly network: string;
    readonly offer: InboundOffer;
  };
  readonly destination: {
    readonly quoted: string;
    readonly asset: string;
    readonly network: string;
    /** 承認対象の受取先（動的では呼び出し側が毎回承認する）。 */
    readonly payTo: string;
    readonly quoteFingerprint: string;
  };
  readonly approval: {
    readonly required: true;
    readonly boundTo: string;
    readonly deadlineMs: number;
  };
  /**
   * 閉じた quote（`docs/subetha-exact-inbound-design.md` §4.1、要件 FR-4.5。全 rail）: `created` を離れた quote の再 quote にだけ付く。
   * `status` は公開の状態。core の文書には `source.offer` が残る（in-process の利用者のため）が、**公開の面（HTTP・MCP）は offer を出さない**:
   * 使用済みの quote を署名の対象として再提示しない。
   */
  readonly closed?: true;
  readonly status?: PublicStatus;
  /** 動的 quote だけ。`ownerKey` は**この応答にしか載らない**。 */
  readonly upstream?: DynamicQuoteFields["upstream"];
  readonly dynamic?: DynamicQuoteFields["dynamic"];
  readonly ownerKey?: string;
}

export type QuoteOutcome =
  | ({ readonly ok: true } & QuoteDocument)
  /** `retryAfterMs` は受信 offer の発行が一時的に断られたとき（`source_offer_unavailable`）の **quote の取り直し**の目安（`docs/subetha-exact-inbound-design.md` §4.1）。 */
  | { readonly ok: false; readonly code: string; readonly reason?: string; readonly retryAfterMs?: number };

export interface PurchaseRequest {
  readonly principalId: string;
  readonly requestId: string;
  readonly quoteId: string;
  /** R3 のパスが指す `routeId`。quote の経路と違えば別経路を実行しない。 */
  readonly routeId?: string;
  /** 承認は `quoteId` に束縛される。 */
  readonly approval?: string;
  readonly credential?: PaymentCredential;
  /** 動的 quote の持ち主の証明。静的 route では見ない。 */
  readonly ownerKey?: string;
  readonly source?: string;
}

export interface PurchaseOutcome {
  readonly paymentId?: string;
  readonly status: PublicStatus | "rejected";
  readonly code?: string;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly terminalReason?: string;
  /** 秘匿購入の引き渡し（`status === "awaiting_session"` のときだけ。credential の値を含む: 認証済みの応答にだけ載せる）。 */
  readonly handover?: HandoverView;
  /**
   * 「払われたかもしれない」の開示（`docs/subetha-exact-inbound-design.md` §4.2、要件 FR-4.4）: この quote への標準の署名が Router の外で実行可能でいられる上限
   * （unix 秒）。手元の検査の後は正確な `validBefore`、その前は quote のときの上限。rail が持たない・受信が settle 済みなら欄なし。出すときは
   * `awaitingPaymentDoesNotMeanUnpaid: true` と組で公開する（HTTP・MCP の射影）。
   */
  readonly mayStillSettleUntil?: number;
}

/** 秘匿 quote の文書（`docs/zktls-router-design.md` §2・§2.1）。`ownerKey` はこの応答にしか載らない。 */
export type PrivateQuoteDocument = QuoteDocument & PrivateQuoteFields;
export type PrivateQuoteOutcome = ({ readonly ok: true } & PrivateQuoteDocument) | { readonly ok: false; readonly code: string; readonly reason?: string };

export interface Projection {
  readonly paymentId: string;
  readonly routeId: string;
  readonly status: PublicStatus;
  readonly source: {
    readonly amount: string;
    readonly asset: string;
    readonly network: string;
    readonly txRef?: string;
    /** `PurchaseOutcome.mayStillSettleUntil` と同じ（status の射影）。 */
    readonly mayStillSettleUntil?: number;
  };
  readonly destination: {
    readonly quoted: string;
    readonly asset: string;
    readonly network: string;
    readonly attempt: number;
    readonly outcome: DestinationOutcome;
    readonly txRef?: string;
    readonly receiptRef?: string;
  };
  readonly quoteFingerprint: string;
  readonly terminalReason?: string;
  readonly updatedAt: string;
  readonly result?: unknown;
  /** 動的購入だけ。 */
  readonly upstream?: { readonly url: string; readonly method: "GET" | "POST"; readonly body?: string; readonly bodySha256?: string };
  readonly dynamic?: { readonly profileId: string; readonly pricing: DynamicPricing; readonly fundsMoveOnCredential: boolean; readonly promoted: boolean };
  /** 秘匿購入だけ（`docs/zktls-router-design.md` §7.3、要件 FR-Z04）。credential 値・record 本体・封筒は決して含めない。 */
  readonly private?: PrivateProjection;
}

export interface PrivateProjection {
  readonly intentSha256: string;
  readonly headerSha256?: string;
  readonly outbound: { readonly issued: boolean; readonly expectedRef?: string; readonly receiptSha256?: string };
  readonly verifier?: Readonly<Record<string, unknown>>;
  readonly proof?: { readonly delivery: boolean; readonly requestBinding: boolean; readonly onChainFinality: "not_checked" };
  readonly deadlines: { readonly credentialExpiresAt?: number; readonly sessionBy?: number; readonly attestBy?: number };
  readonly artifacts: { readonly record: "none" | "available" | "expired"; readonly recordAvailableUntil?: number; readonly late?: boolean };
  readonly attest?: { readonly bundleSha256: string; readonly result: "delivered_private" | "unknown"; readonly reason?: string };
  /**
   * proxy 型の購入だけ（増分 v1.5、設計 §8、要件 FR-X13）。`providerAddr` は発行予約の後だけ。開示は常に出す。MPC 型の射影には欄が無い。
   */
  readonly tls?: { readonly mode: "proxy"; readonly providerAddr?: string; readonly disclosures: { readonly routerConnectsToProvider: true; readonly providerSeesRouterAddress: true; readonly trustsRouterProviderPath: true } };
}

/** 秘匿購入の射影の欄（§7.3）。復元した `Intent.private` だけから組む（値・record 本体・封筒は出さない）。 */
export function privateProjectionOf(intent: Intent): PrivateProjection | undefined {
  const priv = intent.private;
  if (priv === undefined) return undefined;
  const record = priv.record;
  return {
    intentSha256: priv.intentSha256,
    ...(priv.issuance === undefined ? {} : { headerSha256: priv.issuance.headerSha256 }),
    outbound: { issued: priv.issuance !== undefined, ...(priv.issuance?.expectedRef === undefined ? {} : { expectedRef: priv.issuance.expectedRef }), ...(intent.destination.receiptSha256 === undefined ? {} : { receiptSha256: intent.destination.receiptSha256 }) },
    ...(record === undefined ? {} : { verifier: { ...record.summary } }),
    ...(intent.status === "delivered_private" ? { proof: { delivery: true, requestBinding: priv.method === "POST", onChainFinality: "not_checked" as const } } : {}),
    deadlines: {
      ...(priv.issuance === undefined ? {} : { credentialExpiresAt: priv.issuance.expiresAtMs, sessionBy: priv.issuance.sessionBy }),
      ...(record?.attestBy === undefined ? {} : { attestBy: record.attestBy }),
    },
    artifacts: {
      record: record === undefined ? "none" : record.expired === true ? "expired" : "available",
      ...(record === undefined ? {} : { recordAvailableUntil: record.recordAvailableUntil }),
      ...(record?.late === true ? { late: true } : {}),
    },
    ...(priv.attest === undefined ? {} : { attest: { ...priv.attest } }),
    ...(priv.tlsMode === "proxy"
      ? {
          tls: {
            mode: "proxy" as const,
            ...(priv.reservation?.proxy === undefined ? {} : { providerAddr: priv.reservation.proxy.providerAddr }),
            disclosures: { routerConnectsToProvider: true as const, providerSeesRouterAddress: true as const, trustsRouterProviderPath: true as const },
          },
        }
      : {}),
  };
}

export interface RouterCoreOptions {
  readonly journalPath: string;
  readonly config: RouterConfig;
  readonly inbound: InboundRail;
  readonly outbound: OutboundRail;
  readonly now?: () => number;
  /** 決定的な id 生成（テストはカウンタを注入する）。 */
  readonly nextPaymentId?: () => string;
  /**
   * 運用者向けの固定診断文。**値・URL・ホスト名・秘密は渡さない**
   * （`docs/DEPLOY.md` の「起動ログに URL を出さない」方針に合わせる）。
   * 省略時は何も出さない（core は I/O 先を知らない）。
   */
  readonly note?: (message: string) => void;
  /**
   * 支払い元の残高（base units。送信の設計 §2.6、D-15）。`routeId`（静的）または `profileId`（動的）と送信資産で引く。
   * `undefined` を返せば「その経路に検査なし」。省略時は検査しない。throw・`bigint` でない・不足は「不足」。
   */
  readonly balanceOf?: (id: string, asset: string) => Promise<bigint | undefined>;
  /**
   * 動的上流 URL（`config.dynamic` があるときだけ使う）。控えの置き場所は省略時 `<journal のディレクトリ>/dynamic-quotes`。
   * `balanceOf` は上の `balanceOf` と同じ契約（互換のために残す。両方あれば上が勝つ）。
   */
  readonly dynamic?: {
    readonly ledgerDir?: string;
    readonly gate?: DynamicGate;
    readonly balanceOf?: (profileId: string, asset: string) => Promise<bigint | undefined>;
  };
  /**
   * store の load の直後（budget の load の前、quote／purchase を受ける前）に 1 回呼ぶ。受信 adapter が journal の消費済み署名の集合を
   * 読むための口（`docs/mpp-solana-design.md` §2.3）。読取だけ。省略時は何もしない。
   */
  readonly onStoreLoaded?: (view: { readonly settledSourceTxRefs: ReadonlySet<string> }) => void;
  /**
   * 診断の記録（`docs/rejection-reasons-design.md` §2.3・§4.1、タスク R-2）。省略時は `NOOP`（何もしない）。core は push するだけで、
   * 記録を読まない（journal・応答・判断は sink の有無で同じ）。
   */
  readonly diagnostics?: DiagnosticsSink;
  /**
   * 秘匿購入（`docs/zktls-router-design.md`）。`config.private` と両方があるときだけ口が開く。`trust` は合成が決める（本番 `mozilla`、試験能力だけ `lab-fixture-ca`）。
   */
  readonly private?: {
    readonly rails: Readonly<Record<string, PrivateOutboundRail>>;
    readonly runner: VerifierRunner;
    readonly trust: "mozilla" | "lab-fixture-ca";
    readonly hooksForTest?: PrivateHooksForTest;
    readonly workDir?: string;
    /** proxy 型の宛先の固定（増分 v1.5、設計 §4）。proxy 型のプロファイルがあれば必須。 */
    readonly pinDestination?: PrivateCoreOptions["pinDestination"];
  };
  /**
   * 試験だけの停止点（`docs/subetha-exact-inbound-design.md` §4.6。秘匿購入の `PrivateHooksForTest.stop` と同じ流儀）。実入口（`src/main.ts` の CLI）は渡さない。
   * `before_source_settle` は `source_pending` の行の後・`settle` の呼び出しの前。`after_source_settled` は `deliver()` の release の前、`after_source_released` は
   * `source_released` の行の後・送信の前、`after_terminal` は終端の行の後・complete の報告の前。
   */
  readonly hooksForTest?: { readonly stop?: (point: CoreStopPoint, paymentId: string) => Promise<void> };
}

export type CoreStopPoint = "before_source_settle" | "after_source_settled" | "after_source_released" | "after_terminal";

export interface RouterCore {
  quote(request: QuoteRequest): Promise<QuoteOutcome>;
  purchase(request: PurchaseRequest): Promise<PurchaseOutcome>;
  status(paymentId: string, principalId: string, ownerKey?: string): Projection | undefined;
  /**
   * 資格情報なしの R3 に対して発行済み offer を再提示するための読み取り専用アクセサ。
   * 所有 principal・経路一致・未開始の quote のときだけ返し、**journal には何も書かない**。
   */
  offerFor(quoteId: string, principalId: string, routeId?: string, ownerKey?: string): InboundOffer | undefined;
  /**
   * 資格情報なしの R3（402 の再提示）に添える「払われたかもしれない」の上限（`docs/subetha-exact-inbound-design.md` §4.2 (i)）。`disclosureOf` と同じ優先と範囲。
   * 所有 principal・経路一致のときだけ。journal には何も書かない。持たない rail は `undefined`。
   */
  disclosureFor(quoteId: string, principalId: string, routeId?: string, ownerKey?: string): number | undefined;
  /** 秘匿購入（設計 §2）。設定が無ければ `private_disabled`。 */
  privateQuote(request: { readonly principalId: string; readonly requestId: string; readonly profileId: string; readonly intentB64: string; readonly source?: string }): Promise<PrivateQuoteOutcome>;
  privateAttest(paymentId: string, principalId: string, ownerKey: string | undefined, bundleB64: string): Promise<AttestOutcome>;
  privateRecord(paymentId: string, principalId: string, ownerKey: string | undefined): RecordOutcome;
  close(): Promise<void>;
}

function projectionOf(intent: Intent): Projection {
  const projection: Projection = {
    paymentId: intent.paymentId,
    routeId: intent.routeId,
    status: toPublicStatus(intent.status),
    source: {
      amount: intent.source.amount,
      asset: intent.source.asset,
      network: intent.source.network,
      ...(intent.source.txRef === undefined ? {} : { txRef: intent.source.txRef }),
      ...disclosureOf(intent),
    },
    destination: {
      quoted: intent.destination.quoted,
      asset: intent.destination.asset,
      network: intent.destination.network,
      attempt: intent.destination.attempt,
      outcome: intent.destination.outcome,
      ...(intent.destination.txRef === undefined ? {} : { txRef: intent.destination.txRef }),
      // receiptRef は上流が実際にレシートを返したときだけ現れる。
      ...(intent.destination.receiptRef === undefined
        ? {}
        : { receiptRef: intent.destination.receiptRef }),
    },
    quoteFingerprint: intent.quoteFingerprint,
    ...(intent.terminalReason === undefined ? {} : { terminalReason: intent.terminalReason }),
    updatedAt: intent.updatedAt,
    ...(intent.status === "delivered" && intent.result !== undefined
      ? { result: intent.result.body }
      : {}),
    ...(intent.upstream === undefined || intent.dynamic === undefined
      ? {}
      : {
          upstream: upstreamFieldsOf(intent.upstream),
          dynamic: {
            profileId: intent.dynamic.profileId,
            pricing: intent.dynamic.pricing,
            // MPP と SubEtha（burn-sale。payer が burn を送ってから credential を作る）は credential の時点で資金が動く（v1.3 FR-V5）。
            fundsMoveOnCredential: ["mpp", "subetha"].includes(String((intent.dynamic.profile as { sourceRail?: unknown })["sourceRail"])),
            promoted: intent.dynamic.reservation !== undefined,
          },
        }),
    ...(intent.private === undefined ? {} : { private: privateProjectionOf(intent)! }),
  };
  return projection;
}

/**
 * 「払われたかもしれない」の値（`docs/subetha-exact-inbound-design.md` §4.2）。**優先**: 行に書いた正確な `source.mayStillSettleUntil`（手元の検査の後）、無ければ quote のときの
 * 上限 `source.settleWindow`（行を書かない経路・(i′) の前・再起動の後）。上限の方は、受信がまだ settle していない状態（`created`・`source_pending`・`source_failed`、
 * 受信の `txRef` の無い `unknown`）でだけ出す: settle 済みの購入では authorization は消費済みで「まだ払われ得る」は成り立たない（設計の表は失敗の経路だけを挙げる）。
 * 持たない rail の intent には欄が無い。
 */
function disclosureOf(intent: Intent): { readonly mayStillSettleUntil?: number } {
  if (intent.source.mayStillSettleUntil !== undefined) return { mayStillSettleUntil: intent.source.mayStillSettleUntil };
  const window = intent.source.settleWindow;
  if (window === undefined || intent.source.txRef !== undefined) return {};
  return intent.status === "created" || intent.status === "source_pending" || intent.status === "source_failed" || intent.status === "unknown" ? { mayStillSettleUntil: window } : {};
}

function quoteDocumentOf(intent: Intent): QuoteDocument {
  return {
    quoteId: intent.quoteId,
    paymentId: intent.paymentId,
    routeId: intent.routeId,
    source: {
      amount: intent.source.amount,
      asset: intent.source.asset,
      network: intent.source.network,
      offer: intent.source.offer,
    },
    destination: {
      quoted: intent.destination.quoted,
      asset: intent.destination.asset,
      network: intent.destination.network,
      payTo: intent.destination.selectedOffer.payTo,
      quoteFingerprint: intent.quoteFingerprint,
    },
    // 承認期限は quote 時に確定した絶対時刻（journal に永続化した値）。
    approval: { required: true, boundTo: intent.quoteId, deadlineMs: intent.approvalDeadlineMs },
  };
}

/** 設定の許容集合に field 単位で一致する最初の 1 件（推測で選ばない）。 */
function selectOffer(
  offers: readonly DestinationOffer[],
  route: RouteConfig,
): DestinationOffer | undefined {
  return offers.find(
    (offer) =>
      offer.scheme === route.destination.scheme &&
      offer.network === route.destination.network &&
      offer.asset === route.destination.asset &&
      offer.payTo === route.destination.payTo,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** complete の `unreported` の理由の集合（`CompleteUnreportedReason`。journal に写すのはこの固定の token だけ）。 */
const COMPLETE_UNREPORTED_REASON_SET: ReadonlySet<string> = new Set(["conflicting_outcome", "not_authorized", "delivery_key_mismatch", "unknown_order", "unknown_tenant", "unauthorized", "invalid_request", "refused", "unavailable"]);

/**
 * 公開・永続化してよい理由コードの集合。adapter が返す任意の文字列
 * （上流 URL・トークン・例外文字列が混ざり得る）はここを通さない。
 */
const SAFE_REASONS: ReadonlySet<string> = new Set([
  "quote_changed",
  "offer_changed",
  "offer_unavailable",
  "verify_failed",
  "source_rejected",
  "source_settle_unknown",
  "source_verify_unavailable",
  "source_paid_unsettled",
  "destination_rejected",
  "destination_pay_unknown",
  "paid_data_unavailable",
  "interrupted_at_restart",
  "purchase_count_limit",
  "per_purchase_limit",
  "bucket_limit",
  "bucket_not_allowed",
  "invalid_amount",
  "invalid_budget_limit",
  "approval_expired",
  "unsupported_response",
  "response_too_large",
  // 動的 MPP 送信の cap（`docs/dynamic-gas-fee-design.md` §3.4）。
  "destination_fee_cap_invalid",
  "destination_send_refused_before_dispatch",
  // 送信 adapter の未送出の理由（送信の設計 §4.5・§5。固定文字列で、上流の内容は含まない）。journal と状態の射影にそのまま残す。
  "destination_deadline",
  "destination_offer_changed",
  "destination_offer_not_allowed",
  "destination_challenge_unreadable",
  "destination_signer_network_mismatch",
  "destination_reservation_unsupported",
  "destination_ata_missing",
  "destination_blockhash_unavailable",
  "destination_blockhash_stale",
  "destination_memo_invalid",
  "destination_message_mismatch",
  "destination_message_collision",
  "destination_message_record_unavailable",
  "destination_not_signed",
  "destination_payload_mismatch",
  "destination_receipt_unverified",
  "destination_receipt_payer_mismatch",
  // 秘匿購入（`docs/zktls-router-design.md` §7.1。固定文字列で、credential・上流の値は含まない）。
  "private_capacity",
  "private_only_profile",
  "private_disabled",
  "private_unavailable",
  "attest_foreign",
  "private_inbound_identity_missing",
  "private_issuance_duplicate",
  "private_issuance_unknown",
  "private_issue_failed",
  "private_header_invalid",
  "private_credential_lifetime",
  "private_release_unknown",
  "private_verifier_unavailable",
  "private_handover_unknown",
  "private_session_timeout",
  "private_record_unknown",
  "private_attest_timeout",
  // proxy 型（増分 v1.5、要件 FR-X13）。
  "private_proxy_dial_refused",
  "private_proxy_dial_failed",
  "private_proxy_server_name_mismatch",
  "private_proxy_limit",
  "private_attest_invalid",
  "private_receipt_mismatch",
  "private_verify_timeout",
  "interrupted_before_release",
  "interrupted_before_handover",
  "interrupted_after_release",
  // 受信レール `subetha-exact`（`docs/subetha-exact-inbound-design.md` §4.6。固定文字列で、facilitator の文章・URL・token は含まない）。
  "source_offer_unavailable",
  "source_offer_refused",
  "source_release_refused",
  "source_release_unknown",
  "source_complete_unreported",
]);

/** adapter が返してよい preflight 理由。これ以外は固定コードに置き換える。 */
const SAFE_PREFLIGHT_REASONS: ReadonlySet<string> = new Set([
  "nonce_mismatch",
  "offer_expired",
  "offer_mismatch",
  "route_binding_mismatch",
  "credential_mismatch",
]);

/** 呼び出し側の可変入力からネストを含めて切り離す（以後の変更で束縛が動かない）。 */
function snapshotInput<T>(value: T): T {
  return structuredClone(value);
}

function safeReason(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_REASONS.has(value) ? value : fallback;
}

function outcomeOf(status: PublicStatus | "rejected", code?: string): PurchaseOutcome {
  return code === undefined ? { status } : { status, code };
}

export async function createRouterCore(options: RouterCoreOptions): Promise<RouterCore> {
  // 設定は起動時にスナップショットし、以後の呼び出し側の変更で束縛が動かないようにする。
  const config: RouterConfig = structuredClone(options.config);
  const journal: Journal = await openJournal({ journalPath: options.journalPath });
  let store: IntentStore;
  let budget: Budget;
  try {
    store = await IntentStore.load(journal);
    options.onStoreLoaded?.({ settledSourceTxRefs: store.settledSourceTxRefs });
    budget = Budget.load(config.budget, journal, (paymentId, event, patch) =>
      store.append(paymentId, event, patch),
    );
  } catch (error) {
    // 初期化・replay が失敗したらロックと fd を解放してから投げ直す。
    await journal.close();
    throw error;
  }
  const now = options.now ?? (() => Date.now());
  // 既定の id は再起動でリセットされない（カウンタは履歴を上書きし得る）。
  const nextPaymentId = options.nextPaymentId ?? (() => randomUUID());

  /** 動的上流 URL（設定にあるときだけ）。控え・動的予算・門はここで持つ。 */
  let dynamicCore: DynamicCore | undefined;
  let privateCore: PrivateCore | undefined;
  let ledger: QuoteLedger | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  if (config.dynamic !== undefined) {
    try {
      ledger = await QuoteLedger.open({
        dir: options.dynamic?.ledgerDir ?? join(dirname(options.journalPath), "dynamic-quotes"),
        now,
        retentionDays: config.dynamic.limits.ledgerRetentionDays,
        isPromoted: (quoteId) => store.byQuoteId(quoteId) !== undefined,
      });
      const dynamicBudget = Budget.loadDynamic(config.dynamic.budget, journal);
      const gate = options.dynamic?.gate ?? new DynamicGate({ limits: config.dynamic.limits, now });
      // 秘匿購入（設定と依存の両方があるときだけ）。dynamic core の受信レグに依存を渡す。
      if (config.private !== undefined && options.private !== undefined) {
        privateCore = createPrivateCore({
          config,
          store,
          ledger,
          gate,
          inbound: options.inbound,
          rails: options.private.rails,
          runner: options.private.runner,
          trust: options.private.trust,
          now,
          nextPaymentId,
          note: options.note,
          hooksForTest: options.private.hooksForTest,
          ...(options.private.workDir === undefined ? {} : { workDir: options.private.workDir }),
          ...(options.private.pinDestination === undefined ? {} : { pinDestination: options.private.pinDestination }),
        });
      }
      dynamicCore = createDynamicCore({
        config,
        store,
        ledger,
        budget: dynamicBudget,
        gate,
        inbound: options.inbound,
        outbound: options.outbound,
        now,
        nextPaymentId,
        note: options.note,
        balanceOf: options.balanceOf ?? options.dynamic?.balanceOf,
        deliver,
        ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
        ...(privateCore === undefined ? {} : { private: privateCore.dynamicDeps }),
      });
      // 期限切れの控えと古いファイルの定期的な削除（設計 §6.1）。
      const sweeping = ledger;
      sweepTimer = setInterval(() => sweeping.sweep(), 60 * 60 * 1000);
      sweepTimer.unref();
      // 秘匿購入の再構成（起動門の取り消し → 棚卸し → record の回収 → 掃除 → 容量）。公開の前に 1 回。
      await privateCore?.start();
    } catch (error) {
      await ledger?.close();
      await journal.close();
      throw error;
    }
  }

  /** キー単位の直列化。同じ quote / 同じ購入の並行要求を重ねない。 */
  const locks = new Map<string, Promise<void>>();
  function withKey<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const started = previous.then(run, run);
    const settled = started.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    void settled.then(() => {
      if (locks.get(key) === settled) {
        locks.delete(key);
      }
    });
    return started;
  }

  async function quoteLocked(request: QuoteRequest): Promise<QuoteOutcome> {
    const route = resolveRoute(config, request.routeId);
    if (route === undefined) {
      return { ok: false, code: "unknown_route" };
    }

    // `(principal, requestId)` → `quoteId` は確定済みなら不変。
    const existingQuoteId = store.quoteIdFor(request.principalId, request.requestId);
    if (existingQuoteId !== undefined) {
      const existing = store.byQuoteId(existingQuoteId);
      if (existing === undefined) {
        return { ok: false, code: "quote_failed" };
      }
      // 動的 quote は冪等に再取得できない（持ち主の証明が要る）。
      if (existing.routeId !== request.routeId || existing.dynamic !== undefined || existing.dynamicInvalid === true) {
        return { ok: false, code: "request_id_conflict" };
      }
      // `created` のままなら今までどおり同じ文書。離れた後は閉じた quote（FR-4.5: 同じ注文に新しい署名を求めない）。
      return existing.status === "created" ? { ok: true, ...quoteDocumentOf(existing) } : { ok: true, ...quoteDocumentOf(existing), closed: true, status: toPublicStatus(existing.status) };
    }
    if (dynamicCore?.requestInUse(request.principalId, request.requestId) === true) {
      return { ok: false, code: "request_id_conflict" };
    }

    // 先に上流を quote（純粋読取・無課金）してから受信 offer を発行する。
    const offers = await options.outbound.readChallenge(route.routeId);
    const selectedOffer = selectOffer(offers, route);
    if (selectedOffer === undefined) {
      return { ok: false, code: "quote_failed", reason: "no_matching_offer" };
    }

    let sourceOffer: InboundOffer;
    try {
      sourceOffer = await options.inbound.createOffer({
        routeId: route.routeId,
        amount: route.source.amount,
        asset: route.source.asset,
        network: route.source.network,
        routeBinding: routeBindingOf(route),
        nowMs: now(),
        // quote の要求の識別（`subetha-exact` が facilitator の注文の requester を決定的に導く。他の rail は読まない。設計 §4.1）。
        requester: { principalId: request.principalId, requestId: request.requestId },
      });
    } catch (error) {
      // 受信 offer の発行の失敗（資金は動いていない。要件 FR-2.1）: 固定の code・detail だけを写す。型は信用せず、閉じた集合と有限の値で照合する
      // （集合に無い detail は落とし、code は 2 つのどちらか、`retryAfterMs` は正の整数で 1 時間まで）。ほかの例外は今までどおり上へ。
      if (error instanceof InboundOfferError) {
        const code = error.code === "source_offer_refused" ? "source_offer_refused" : "source_offer_unavailable";
        const detail: unknown = error.detail;
        const retry: unknown = error.retryAfterMs;
        return {
          ok: false,
          code,
          ...(typeof detail === "string" && OFFER_REFUSAL_DETAILS.has(detail) ? { reason: detail } : {}),
          ...(typeof retry === "number" && Number.isSafeInteger(retry) && retry > 0 ? { retryAfterMs: Math.min(retry, OFFER_RETRY_AFTER_MAX_MS) } : {}),
        };
      }
      throw error;
    }

    // 発行された offer が設定と食い違うなら quote を成立させない
    // （adapter の型シグネチャを信用せず、実際の値を照合する）。
    const expectedBinding = routeBindingOf(route);
    if (
      sourceOffer.amount !== route.source.amount ||
      sourceOffer.asset !== route.source.asset ||
      sourceOffer.network !== route.source.network ||
      sourceOffer.extra.routeBinding !== expectedBinding
    ) {
      return { ok: false, code: "source_terms_mismatch" };
    }

    // 承認期限は絶対時刻。TTL と発行 offer の失効の早い方で切る。
    const issuedAtMs = now();
    const offerExpiryMs = sourceOffer.extra.expiresAt * 1000;
    const approvalDeadlineMs = Math.min(issuedAtMs + config.approvalTtlMs, offerExpiryMs);

    // 「この offer への標準の署名が実行可能でいられる上限」（設計 §4.2。rail が持つときだけ `created` の行に写し、以後の開示は journal から出す）。
    const settleWindow = settleWindowOf(sourceOffer);
    const paymentId = nextPaymentId();
    try {
      await store.append(paymentId, "created", {
        quoteId: sourceOffer.extra.challengeNonce,
        routeId: route.routeId,
        principalId: request.principalId,
        requestId: request.requestId,
        source: {
          amount: route.source.amount,
          asset: route.source.asset,
          network: route.source.network,
          offer: sourceOffer,
          ...(settleWindow === undefined ? {} : { settleWindow }),
        },
        destination: {
          quoted: selectedOffer.amount,
          asset: selectedOffer.asset,
          network: selectedOffer.network,
          selectedOffer,
        },
        quoteFingerprint: fingerprintOf(selectedOffer),
        // 設定側の指紋（FR-17）。purchase 時に再計算して照合する。
        routeFingerprint: fingerprintOf(authoritativeTermsOf(route)),
        approvalDeadlineMs,
      });
    } catch (error) {
      if (error instanceof IntentCollisionError) {
        return { ok: false, code: error.code };
      }
      throw error;
    }

    const created = store.byPaymentId(paymentId);
    if (created === undefined) {
      return { ok: false, code: "quote_failed" };
    }
    return { ok: true, ...quoteDocumentOf(created) };
  }

  /** rail の同期の問い合わせ（method が無い・結果が正の整数でない → 欄なし。設計 §2 の core の契約）。 */
  function settleWindowOf(offer: InboundOffer): number | undefined {
    if (typeof options.inbound.settleWindowOf !== "function") return undefined;
    let value: unknown;
    try {
      value = options.inbound.settleWindowOf(offer);
    } catch {
      return undefined;
    }
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }

  /** 試験の停止点（設計 §4.6）。実入口は渡さない。 */
  const stop = async (point: CoreStopPoint, paymentId: string): Promise<void> => {
    await options.hooksForTest?.stop?.(point, paymentId);
  };

  /** purchase の応答に「払われたかもしれない」の欄を足す（`disclosureOf` の優先と範囲。応答の status・code は変えない。journal に無い intent はそのまま）。 */
  function withDisclosure<T extends PurchaseOutcome>(outcome: T): T {
    if (outcome.paymentId === undefined) return outcome;
    const intent = store.byPaymentId(outcome.paymentId);
    const disclosure = intent === undefined ? {} : disclosureOf(intent);
    return disclosure.mayStillSettleUntil === undefined ? outcome : { ...outcome, ...disclosure };
  }

  async function purchaseLocked(request: PurchaseRequest): Promise<PurchaseOutcome> {
    return withDisclosure(await purchaseLockedCore(request));
  }

  async function purchaseLockedCore(request: PurchaseRequest): Promise<PurchaseOutcome> {
    const intent = store.byQuoteId(request.quoteId);
    if (intent === undefined) {
      return outcomeOf("rejected", "unknown_quote");
    }
    // 購入の全体の診断の scope（§12.6）。sink が無ければ scope を作らずそのまま動かす。
    return withPurchaseDiagnostics(options.diagnostics, { paymentId: intent.paymentId, quoteId: intent.quoteId, routeId: intent.routeId, promoted: true }, (diag) =>
      purchaseStatic(intent, request, diag),
    );
  }

  async function purchaseStatic(intent: Intent, request: PurchaseRequest, diag: PurchaseDiagnostics): Promise<PurchaseOutcome> {
    // 動的の intent は静的の流れで実行しない（持ち主の証明・昇格の規則が違う）。
    if (intent.dynamic !== undefined || intent.dynamicInvalid === true) {
      return outcomeOf("rejected", "unknown_quote");
    }
    // 所有 principal 以外は開始も参照もできない。
    if (intent.principalId !== request.principalId) {
      return outcomeOf("rejected", "not_owner");
    }
    // R3 のパスが別経路を指していたら、その quote の経路を実行しない
    // （既存ライフサイクルの現在状態も返さない）。
    if (request.routeId !== undefined && request.routeId !== intent.routeId) {
      return outcomeOf("rejected", "route_mismatch");
    }
    // 別 requestId から同じ quote を買い直させない。
    if (intent.requestId !== request.requestId) {
      return outcomeOf("rejected", "request_id_conflict");
    }
    // 既存ライフサイクルがあれば新規購入を開始せず現在状態を返す。
    if (intent.status !== "created") {
      return currentOutcome(intent);
    }
    if (request.approval !== intent.quoteId) {
      return { paymentId: intent.paymentId, status: "rejected", code: "approval_required" };
    }
    /**
     * **設定変更の検出（FR-17）。** 送金前・credential を触る前・上流へ出る前に行う。
     *
     * 既存の照合（`readAndMatchDestination`）は **journal 保存済みの offer** を基準にするので、
     * 運用者が設定の `payTo` を変えても**旧受取先に払えてしまう**。ここで塞ぐ。
     *
     * 公開する理由は既存の `quote_changed` に寄せる（設定が変わったのか上流が変わったのかを
     * 外に出さない）。運用者向けには固定文をログに出す——値・URL・ホスト名は出さない。
     */
    const currentRoute = resolveRoute(config, intent.routeId);
    /**
     * 拒否の判定は**1 本の不等号**で足りる:
     * - 設定が変わった    → 指紋が合わない
     * - legacy（欄なし）  → `undefined !== "sha256:…"` は真
     * - 壊れた値          → store が `undefined` にするので上と同じ
     *
     * 明示的な分岐を重ねないのは、**二重に書くと片方を消してもテストが落ちず、
     * 何がこの性質を守っているのか追えなくなる**ため（sabotage 検証で発見）。
     * `routeFingerprintInvalid` は**判定には使わず、診断の区別だけに使う**。
     */
    const routeMismatch =
      currentRoute === undefined ||
      intent.routeFingerprint !== fingerprintOf(authoritativeTermsOf(currentRoute));
    if (routeMismatch) {
      const why =
        currentRoute === undefined
          ? "route removed"
          : intent.routeFingerprintInvalid === true
            ? "unreadable quote fingerprint"
            : intent.routeFingerprint === undefined
              ? "quote predates this check"
              : "route configuration changed";
      // 固定文のみ。値・URL・ホスト名は出さない（`docs/DEPLOY.md` の方針）。
      options.note?.(`route configuration mismatch (routeId=${intent.routeId}, why=${why})`);
      return {
        paymentId: intent.paymentId,
        status: "awaiting_payment",
        code: "quote_changed",
      };
    }
    // 承認期限は quote 時に確定して journal に載せた絶対時刻。期限と等しい時刻は期限切れ。
    if (intent.approvalDeadlineMs <= 0 || now() >= intent.approvalDeadlineMs) {
      return { paymentId: intent.paymentId, status: "rejected", code: "approval_expired" };
    }
    // 以降はこの不変スナップショットだけを使う（preflight・verify・settle で同一の値）。
    const credential = request.credential;
    // 資格情報なしでは孤児レコードを作らない（journal に何も書かない）。
    if (credential === undefined) {
      return {
        paymentId: intent.paymentId,
        status: toPublicStatus(intent.status),
        code: "payment_required",
      };
    }
    // preflight を持たない adapter では有料ライフサイクルを開始しない。
    if (typeof options.inbound.preflight !== "function") {
      return { paymentId: intent.paymentId, status: "rejected", code: "preflight_unavailable" };
    }
    const preflight = options.inbound.preflight(intent.source.offer, credential, now());
    if (!preflight.ok) {
      // 任意文字列（URL・トークンを含み得る）をそのまま公開しない。
      const code =
        typeof preflight.reason === "string" && SAFE_PREFLIGHT_REASONS.has(preflight.reason)
          ? preflight.reason
          : "preflight_failed";
      return { paymentId: intent.paymentId, status: "rejected", code };
    }

    // 受信 settle の前に上流の現在の offer を読み直して照合する（未課金）。
    // 読み直せない場合もどちらのレグも開始しない。例外の文字列は記録しない
    // （上流 URL・トークン・内部ホスト名が混ざり得るため固定の理由コードだけ残す）。
    /*
     * 「払われたかもしれない」の上限（設計 §4.2 (i′)）: 手元の署名の検査より前に書く終端の行には quote のときの上限を、検査の後の行には正確な `validBefore` を写す。
     * 持たない rail では `undefined` で、行は今までどおり。
     */
    const window = intent.source.settleWindow;
    const windowPatch = window === undefined ? {} : { mayStillSettleUntil: window };
    let stillOffered: boolean;
    try {
      stillOffered = await readAndMatchDestination(intent);
    } catch {
      await store.append(intent.paymentId, "source_failed", {
        outcome: "not_sent",
        reason: "offer_unavailable",
        ...windowPatch,
      });
      return {
        paymentId: intent.paymentId,
        status: "awaiting_payment",
        code: "offer_unavailable",
      };
    }
    if (!stillOffered) {
      await store.append(intent.paymentId, "source_failed", {
        outcome: "not_sent",
        reason: "offer_changed",
        ...windowPatch,
      });
      return { paymentId: intent.paymentId, status: "awaiting_payment", code: "offer_changed" };
    }

    // 残高の事前確認（静的。送信の設計 §2.6、D-15）: 受信の verify の**前**なので資金は動いていない。
    // rail が検査を持たなければ `undefined` で通す。throw・形違い・不足は止める（journal に `source_pending` を書かない）。
    const balanceOf = options.balanceOf ?? options.dynamic?.balanceOf;
    if (balanceOf !== undefined) {
      let enough: boolean;
      try {
        const balance = await balanceOf(intent.routeId, intent.destination.asset);
        enough = balance === undefined ? true : typeof balance === "bigint" && balance >= BigInt(intent.destination.quoted);
      } catch {
        enough = false;
      }
      if (!enough) {
        await store.append(intent.paymentId, "source_failed", { outcome: "not_sent", reason: "operator_funds_unavailable", ...windowPatch });
        return { paymentId: intent.paymentId, status: "awaiting_payment", code: "operator_funds_unavailable" };
      }
    }

    await store.append(intent.paymentId, "source_pending", {});

    let verified: InboundVerifyResult;
    const verifyStartedAt = diag.start();
    try {
      verified = await diag.stage({ promoted: true }, () => options.inbound.verify(intent.source.offer, credential, { routeId: intent.routeId }));
    } catch (error) {
      // 受信レールの応答が取れない以上、課金有無を証明できない。
      await store.append(intent.paymentId, "unknown", {
        outcome: "none",
        reason: "source_verify_unavailable",
        ...windowPatch,
      });
      const elapsedMs = diag.elapsedSince(verifyStartedAt);
      diag.note(() => ({ stage: "source_verify", outcome: "threw", transport: classifyTransportError(error), code: "source_verify_unavailable", ...(elapsedMs === undefined ? {} : { elapsedMs }) }));
      return {
        paymentId: intent.paymentId,
        status: "unknown",
        terminalReason: "source_verify_unavailable",
      };
    }
    const verifyElapsedMs = diag.elapsedSince(verifyStartedAt);
    // 手元の検査の後の正確な上限（設計 §4.2 (ii)）。adapter が返さなければ quote のときの上限（持たない rail では欄なし）。実行時に形を見る。
    const preciseRaw = verified !== null && typeof verified === "object" ? verified.mayStillSettleUntil : undefined;
    const precise = typeof preciseRaw === "number" && Number.isSafeInteger(preciseRaw) && preciseRaw > 0 ? preciseRaw : window;
    const precisePatch = precise === undefined ? {} : { mayStillSettleUntil: precise };
    if (verified === null || typeof verified !== "object" || verified.isValid !== true) {
      await store.append(intent.paymentId, "source_failed", {
        outcome: "rejected",
        reason: "verify_failed",
        ...precisePatch,
      });
      diag.note(() => ({ stage: "source_verify", outcome: "invalid", code: "verify_failed", ...(verifyElapsedMs === undefined ? {} : { elapsedMs: verifyElapsedMs }) }));
      return { paymentId: intent.paymentId, status: "awaiting_payment", code: "verify_failed" };
    }
    // verify の成立の記録も控えるだけ（push は購入の終わり = 下の期限の判定の後。§12.3）。
    diag.note(() => ({ stage: "source_verify", outcome: "valid", ...(verifyElapsedMs === undefined ? {} : { elapsedMs: verifyElapsedMs }) }));

    /**
     * verify が通った credential の資金が**既に動いている**か（adapter の `fundsMoved`、無ければ offer の `fundsMoveOnCredential`）。
     * 動いているなら、ここから settle までの失敗（期限・予約）を `not_sent` = 未払いの公言にしない: 耐久的な `unknown`（`source_paid_unsettled`）。
     */
    const fundsMoved = verified.fundsMoved ?? intent.source.offer.extra["fundsMoveOnCredential"] === true;
    const paidButUnsettled = async (): Promise<PurchaseOutcome> => {
      await store.append(intent.paymentId, "unknown", { outcome: "none", reason: "source_paid_unsettled", ...precisePatch });
      return { paymentId: intent.paymentId, status: "unknown", terminalReason: "source_paid_unsettled" };
    };

    // verify 中に時間が経っていても止められるよう、settle 直前に期限を再検査する。
    const beforeSettleMs = now();
    if (
      beforeSettleMs >= intent.approvalDeadlineMs ||
      beforeSettleMs >= intent.source.offer.extra.expiresAt * 1000
    ) {
      if (fundsMoved) return paidButUnsettled();
      await store.append(intent.paymentId, "source_failed", {
        outcome: "not_sent",
        reason: "approval_expired",
        ...precisePatch,
      });
      return {
        paymentId: intent.paymentId,
        status: "awaiting_payment",
        code: "approval_expired",
      };
    }

    /**
     * 予算予約が成立しない限り受信 settle を開始しない。
     *
     * **予約は verify が成立した後、settle の直前に行う。** 予約は通算で回復しないので、
     * verify より前に置くと、**署名の無効な credential を出すだけで**（preflight は呼び出し側が
     * 写せる項目しか見ない）誰でも払わずに枠を使い切れる。settle を呼び得る経路は必ずここを
     * 通るので、「settle されたのに予約が無い」状態は作らない。期限の再検査より後に置くのは、
     * 期限切れで終わる試行にも枠を使わせないため。
     */
    const reservation = await budget.reserve({
      paymentId: intent.paymentId,
      source: {
        network: intent.source.network,
        asset: intent.source.asset,
        amount: intent.source.amount,
      },
      destination: {
        network: intent.destination.network,
        asset: intent.destination.asset,
        amount: intent.destination.quoted,
      },
    });
    if (!reservation.ok) {
      if (fundsMoved) return paidButUnsettled();
      await store.append(intent.paymentId, "source_failed", {
        outcome: "not_sent",
        reason: reservation.reason,
        ...precisePatch,
      });
      return { paymentId: intent.paymentId, status: "awaiting_payment", code: reservation.reason };
    }
    /**
     * 予約の追記（journal への待ち）の後、settle を呼ぶ**直前**にもう一度期限を見る。予約の追記が長く止まった purchase を期限の後に
     * settle へ進めない（受信 adapter は verify の証拠を offer の期限 + 猶予まで保持する: `docs/mpp-solana-design.md` §3.5。settle が期限の前にしか
     * 呼ばれないことが、その保持の根拠）。予約は戻さない（通算で回復しない: ここで止まる試行は予約を使い切ったまま終わる。保守的な側）。
     */
    const settleAtMs = now();
    if (settleAtMs >= intent.approvalDeadlineMs || settleAtMs >= intent.source.offer.extra.expiresAt * 1000) {
      if (fundsMoved) return paidButUnsettled();
      await store.append(intent.paymentId, "source_failed", { outcome: "not_sent", reason: "approval_expired", ...precisePatch });
      return { paymentId: intent.paymentId, status: "awaiting_payment", code: "approval_expired" };
    }
    await stop("before_source_settle", intent.paymentId);

    // 宣言型ではなく実際の値として扱う（相手の振る舞いは型では保証されない）。
    let settled: unknown;
    const settleStartedAt = diag.start();
    try {
      settled = await diag.stage({ promoted: true }, () => options.inbound.settle(intent.source.offer, credential, { routeId: intent.routeId }));
    } catch (error) {
      // 例外・タイムアウトは必ず `unknown`。自動再 settle はしない。
      await store.append(intent.paymentId, "unknown", {
        outcome: "none",
        reason: "source_settle_unknown",
        ...precisePatch,
      });
      const elapsedMs = diag.elapsedSince(settleStartedAt);
      diag.note(() => ({ stage: "source_settle", outcome: "threw", transport: classifyTransportError(error), code: "source_settle_unknown", ...(elapsedMs === undefined ? {} : { elapsedMs }) }));
      return {
        paymentId: intent.paymentId,
        status: "unknown",
        terminalReason: "source_settle_unknown",
      };
    }
    const settleElapsedMs = diag.elapsedSince(settleStartedAt);
    const settleNote = (outcome: "settled" | "rejected" | "unknown", code?: string): void =>
      diag.note(() => ({ stage: "source_settle", outcome, ...(code === undefined ? {} : { code }), ...(settleElapsedMs === undefined ? {} : { elapsedMs: settleElapsedMs }) }));
    // 応答は実行時に検査する（TypeScript の型は相手の振る舞いを保証しない）。
    const outcome = isRecord(settled) ? settled["outcome"] : undefined;
    if (outcome === "rejected") {
      await store.append(intent.paymentId, "source_failed", {
        outcome: "rejected",
        reason: safeReason(isRecord(settled) ? settled["reason"] : undefined, "source_rejected"),
        ...precisePatch,
      });
      // 返す code は今までどおり append の後にもう一度読んだ値（読む回数・順序は変えない）。診断はその local だけを読む（adapter の値を読み足さない）。
      const rejectedCode = safeReason(isRecord(settled) ? settled["reason"] : undefined, "source_rejected");
      settleNote("rejected", rejectedCode);
      return {
        paymentId: intent.paymentId,
        status: "awaiting_payment",
        code: rejectedCode,
      };
    }
    const txRef = isRecord(settled) ? settled["txRef"] : undefined;
    if (outcome === "settled" && typeof txRef === "string" && txRef !== "") {
      try {
        await store.append(intent.paymentId, "source_settled", { txRef });
      } catch {
        /**
         * 受信は chain 上で settle 済みだが記録できなかった（journal はその後使えない）。別の行を書こうとせず `unknown` を返し、送信は始めない
         * （要件 FR-48 の表。`docs/mpp-solana-design.md` §2.3）。memory の intent は `source_pending` のまま: 再提示は現在の終端、再起動では行の有無で
         * `unknown`（行なし）か `paid_undelivered`（append は成功し fsync だけ失敗 = 行あり）。どちらも再送しない。
         */
        options.note?.(`source_settled could not be journaled (paymentId=${intent.paymentId}); answering unknown`);
        settleNote("settled", "source_settle_unknown");
        return { paymentId: intent.paymentId, status: "unknown", terminalReason: "source_settle_unknown" };
      }
      settleNote("settled");
      return deliver(intent.paymentId, diag);
    }

    // `unknown`・契約にない outcome・証跡のない `settled` は一律 `unknown`。
    // 送信レグは開始せず、自動再 settle もしない。
    await store.append(intent.paymentId, "unknown", {
      outcome: "none",
      reason: "source_settle_unknown",
      ...precisePatch,
    });
    settleNote("unknown", "source_settle_unknown");
    return {
      paymentId: intent.paymentId,
      status: "unknown",
      terminalReason: "source_settle_unknown",
    };
  }

  /** 受信成立後の送信レグ。write-ahead 予約を fsync してから送出する。 */
  async function deliver(paymentId: string, diag: PurchaseDiagnostics = DISABLED_PURCHASE_DIAGNOSTICS): Promise<PurchaseOutcome> {
    const intent = store.byPaymentId(paymentId);
    if (intent === undefined) {
      return outcomeOf("rejected", "unknown_payment");
    }
    /** 送信の段の記録（`dest_outcome`。§4.1）。控えるだけで、push は購入の終わり。 */
    const destNote = (outcome: "paid" | "paid_no_data" | "not_sent" | "rejected" | "unknown" | "threw", code: string | undefined, extra: { readonly attempt?: number; readonly elapsedMs?: number | undefined; readonly error?: unknown } = {}): void =>
      diag.note(() => ({
        stage: "dest_outcome",
        outcome,
        // 送信は受信が成立した後だけ（動的でも昇格の後）。push は購入の scope（動的の昇格の前の値）で行うので、欄で明示する。
        promoted: true,
        ...(code === undefined ? {} : { code }),
        ...(extra.attempt === undefined ? {} : { attempt: extra.attempt }),
        ...(outcome === "threw" ? { transport: classifyTransportError(extra.error) } : {}),
        ...(extra.elapsedMs === undefined ? {} : { elapsedMs: extra.elapsedMs }),
      }));

    // 送金直前にもう一度上流の現在の challenge を読み直す（手順 4 の後に起きた
    // 変更へのレース対策）。ここで外れたら署名も送信もしない。受信レグは成立済みな
    // ので終了状態は `paid_undelivered`（理由 `quote_changed`）で、再課金も再購入もしない。
    // 動的の intent で上流が読めない形なら、送信しない（読めない値で払わない）。秘匿購入の intent は静的・動的の送信レグに**決して**流さない
    // （dispatch は privateCore へ渡す。ここに届くのは到達し得ない経路。未発行なので `paid_undelivered`）。
    if (intent.dynamicInvalid === true || intent.dynamicCapInvalid === true || intent.private !== undefined || intent.privateInvalid === true) {
      await store.append(paymentId, "paid_undelivered", { outcome: "not_sent", reason: "quote_changed" });
      destNote("not_sent", "quote_changed");
      return { paymentId, status: "paid_data_unavailable", terminalReason: "quote_changed" };
    }
    /*
     * facilitator の release（`docs/subetha-exact-inbound-design.md` §4.4、要件 FR-5）: settle の後・上流への支払いの前に 1 回。method を持たない rail（既存の 3 つ）と
     * wrapper の `none`（下の rail が持たない）は今までどおり送信へ。`released` だけが送信へ進み、`refused`・`unknown`・契約にない形は送信しない終端
     * （受信は成立済みなので `paid_undelivered`）。`withKey("purchase\0quoteId")` の中で 1 回だけ。再起動の後は `deliver` に戻らない（FR-7）。
     */
    if (intent.status === "source_settled" && intent.source.release === undefined && typeof options.inbound.release === "function") {
      await stop("after_source_settled", paymentId);
      let result: unknown;
      try {
        result = await options.inbound.release(intent.source.offer, { routeId: intent.routeId, deadlineMs: intent.approvalDeadlineMs, ...(intent.source.txRef === undefined ? {} : { sourceTxRef: intent.source.txRef }) });
      } catch {
        result = { outcome: "unknown", reason: "source_release_unknown" };
      }
      const releaseOutcome = isRecord(result) ? result["outcome"] : undefined;
      const deliveryKey = isRecord(result) ? result["deliveryKey"] : undefined;
      const releaseTxRef = isRecord(result) ? result["txRef"] : undefined;
      const eventId = isRecord(result) ? result["eventId"] : undefined;
      if (releaseOutcome === "none") {
        // wrapper: この rail は release を持たない。
      } else if (
        releaseOutcome === "released" &&
        typeof deliveryKey === "string" && deliveryKey !== "" &&
        typeof releaseTxRef === "string" && releaseTxRef === intent.source.txRef &&
        typeof eventId === "string" && eventId !== ""
      ) {
        await store.append(paymentId, "source_released", { deliveryKey, txRef: releaseTxRef, eventId });
        await stop("after_source_released", paymentId);
      } else {
        const reason = releaseOutcome === "refused" ? "source_release_refused" : "source_release_unknown";
        await store.append(paymentId, "paid_undelivered", { outcome: "not_sent", reason });
        destNote("not_sent", reason);
        await reportComplete(paymentId);
        return { paymentId, status: "paid_data_unavailable", terminalReason: reason };
      }
    }
    let stillOffered: boolean;
    try {
      stillOffered = await readAndMatchDestination(intent);
    } catch {
      // 受信は成立済み・送信は未実行。再送も再購入もしない終端として確定する。
      await store.append(paymentId, "paid_undelivered", {
        outcome: "not_sent",
        reason: "offer_unavailable",
      });
      destNote("not_sent", "offer_unavailable");
      await reportComplete(paymentId);
      return { paymentId, status: "paid_data_unavailable", terminalReason: "offer_unavailable" };
    }
    if (!stillOffered) {
      await store.append(paymentId, "paid_undelivered", {
        outcome: "not_sent",
        reason: "quote_changed",
      });
      destNote("not_sent", "quote_changed");
      await reportComplete(paymentId);
      return { paymentId, status: "paid_data_unavailable", terminalReason: "quote_changed" };
    }

    const attempt = intent.destination.attempt + 1;
    await store.append(paymentId, "destination_pending", { attempt });

    // 宣言型ではなく実際の値として扱う。
    let result: unknown;
    const payStartedAt = diag.start();
    try {
      result = await diag.stage({ attempt, promoted: true }, () => options.outbound.pay({
        routeId: intent.routeId,
        offer: intent.destination.selectedOffer,
        paymentId,
        attempt,
        // 承認の期限（送信の設計 §2.4、FR-36）と、署名する message の hash の予約（§2.5、FR-37）。
        deadlineMs: intent.approvalDeadlineMs,
        reserveMessage: (messageHash) => store.reserveMessage(paymentId, messageHash),
        ...(intent.upstream === undefined ? {} : { target: upstreamTargetOf(intent.upstream) }),
        // 動的 MPP 送信: quote が決めた署名時の上限（cap）。adapter は無ければ送らない。
        ...(intent.dynamic?.pricing.maxFee === undefined ? {} : { maxFee: intent.dynamic.pricing.maxFee }),
      }));
    } catch (error) {
      // 送金有無が不明。例外文字列は残さず固定の理由コードだけ記録する。
      await store.append(paymentId, "unknown", {
        outcome: "unknown",
        reason: "destination_pay_unknown",
      });
      destNote("threw", "destination_pay_unknown", { attempt, elapsedMs: diag.elapsedSince(payStartedAt), error });
      return { paymentId, status: "unknown", terminalReason: "destination_pay_unknown" };
    }
    const payElapsedMs = diag.elapsedSince(payStartedAt);

    // `null` / `undefined` / 契約にない形も含めて、参照する前に形を検査する。
    const unknownDestination = async (reason: string): Promise<PurchaseOutcome> => {
      await store.append(paymentId, "unknown", { outcome: "unknown", reason });
      destNote("unknown", reason, { attempt, elapsedMs: payElapsedMs });
      return { paymentId, status: "unknown", terminalReason: reason };
    };
    if (!isRecord(result)) {
      return unknownDestination("destination_pay_unknown");
    }

    const receiptRef = result["receiptRef"];
    switch (result["outcome"]) {
      case "paid": {
        const contentType = result["contentType"];
        if (typeof contentType !== "string" || contentType === "") {
          // 配信された証跡が揃っていないものを `delivered` にしない。
          return unknownDestination("destination_pay_unknown");
        }
        const txRef = result["txRef"];
        // 上流 body・contentType・evidence を fsync してから応答を返す。
        await store.append(paymentId, "delivered", {
          body: result["body"],
          contentType,
          ...(typeof txRef === "string" && txRef !== "" ? { txRef } : {}),
          ...(typeof receiptRef === "string" && receiptRef !== "" ? { receiptRef } : {}),
        });
        destNote("paid", undefined, { attempt, elapsedMs: payElapsedMs });
        await reportComplete(paymentId);
        // 応答は永続化済みの結果を読み戻す（adapter 所有の可変オブジェクトを返さない）。
        const stored = store.byPaymentId(paymentId);
        return {
          paymentId,
          status: "delivered",
          body: stored?.result?.body,
          contentType: stored?.result?.contentType ?? contentType,
        };
      }
      case "paid_no_data": {
        const reason = safeReason(result["reason"], "paid_data_unavailable");
        await store.append(paymentId, "paid_undelivered", {
          outcome: "paid",
          reason,
          ...(typeof receiptRef === "string" && receiptRef !== "" ? { receiptRef } : {}),
        });
        destNote("paid_no_data", reason, { attempt, elapsedMs: payElapsedMs });
        await reportComplete(paymentId);
        return { paymentId, status: "paid_data_unavailable", terminalReason: reason };
      }
      case "not_sent":
      case "rejected": {
        const reason = safeReason(result["reason"], "destination_rejected");
        // journal に書く outcome は今までどおり append の引数を作る時点の 1 回の読み取り。診断はその local だけを読む（await の後に読み直さない）。
        const failedOutcome = result["outcome"];
        await store.append(paymentId, "dest_failed", {
          outcome: failedOutcome,
          reason,
        });
        destNote(failedOutcome as "not_sent" | "rejected", reason, { attempt, elapsedMs: payElapsedMs });
        await reportComplete(paymentId);
        return { paymentId, status: "paid_data_unavailable", terminalReason: reason };
      }
      default:
        // `unknown` も契約にない outcome も、送金有無不明として同じ扱いにする。
        return unknownDestination(safeReason(result["reason"], "destination_pay_unknown"));
    }
  }

  /**
   * 終端の後の complete の報告（`docs/subetha-exact-inbound-design.md` §4.5、要件 FR-6）。値を返さず、例外も出さない。release の無い intent・報告済み・恒久に断られた
   * intent・`unknown`／進行中では何もしない。報告の行の追記が失敗しても終端の行は fsync 済みなので購入の応答は変えない（固定文の `note` だけ。次の起動の
   * 掃き出しが耐久の証拠から再試行する）。
   */
  async function reportComplete(paymentId: string): Promise<void> {
    const intent = store.byPaymentId(paymentId);
    const release = intent?.source.release;
    if (intent === undefined || release === undefined || release.completed !== undefined) return;
    if (release.unreported !== undefined && !(COMPLETE_TRANSIENT_REASONS as ReadonlySet<string>).has(release.unreported.reason)) return;
    const outcome: "delivered" | "failed" | undefined =
      intent.status === "delivered" ? "delivered" : intent.status === "paid_undelivered" || intent.status === "dest_failed" ? "failed" : undefined;
    if (outcome === undefined) return;
    if (typeof options.inbound.complete !== "function") return;
    try {
      await stop("after_terminal", paymentId);
      let result: unknown;
      try {
        result = await options.inbound.complete(intent.source.offer, release.deliveryKey, outcome, { routeId: intent.routeId });
      } catch {
        result = { outcome: "unreported", reason: "unavailable" };
      }
      const resultOutcome = isRecord(result) ? result["outcome"] : undefined;
      if (resultOutcome === "none") return;
      if (resultOutcome === "completed") {
        await store.append(paymentId, "source_completed", { outcome });
        return;
      }
      const reasonRaw = isRecord(result) && resultOutcome === "unreported" ? result["reason"] : undefined;
      const reason = typeof reasonRaw === "string" && COMPLETE_UNREPORTED_REASON_SET.has(reasonRaw) ? reasonRaw : "unavailable";
      await store.append(paymentId, "source_complete_unreported", { outcome, reason });
    } catch {
      options.note?.(`complete report could not be journaled (paymentId=${paymentId})`);
    }
  }

  /** 起動時の掃き出しの候補（設計 §4.5）: release あり・completed 無し・unreported 無しか一時・状態が終端の 3 つ。起動時に 1 回だけ snapshot する。 */
  const sweepCandidates: readonly Intent[] = store.all().filter((intent) => {
    const release = intent.source.release;
    if (release === undefined || release.completed !== undefined) return false;
    if (release.unreported !== undefined && !(COMPLETE_TRANSIENT_REASONS as ReadonlySet<string>).has(release.unreported.reason)) return false;
    return intent.status === "delivered" || intent.status === "paid_undelivered" || intent.status === "dest_failed";
  });
  let sweepAbort = false;
  const sweep: Promise<void> = (async () => {
    for (const candidate of sweepCandidates) {
      if (sweepAbort) return;
      try {
        await withKey(`purchase\u0000${candidate.quoteId}`, () => reportComplete(candidate.paymentId));
      } catch {
        options.note?.(`startup complete sweep failed (paymentId=${candidate.paymentId})`);
      }
    }
  })();

  /** 送金直前・settle 直前の再照合（凍結した accepts をそのまま使わない）。 */
  async function readAndMatchDestination(intent: Intent): Promise<boolean> {
    const offers = await options.outbound.readChallenge(intent.routeId, intent.upstream === undefined ? undefined : upstreamTargetOf(intent.upstream));
    const target = stableJson(intent.destination.selectedOffer);
    return offers.some((offer) => stableJson(offer) === target);
  }

  function currentOutcome(intent: Intent): PurchaseOutcome {
    const status = toPublicStatus(intent.status);
    return {
      paymentId: intent.paymentId,
      status,
      ...(intent.status === "delivered" && intent.result !== undefined
        ? { body: intent.result.body, contentType: intent.result.contentType }
        : {}),
      ...(intent.terminalReason === undefined ? {} : { terminalReason: intent.terminalReason }),
      ...(isTerminal(intent.status) ? {} : { code: "in_progress" }),
    };
  }

  /** 動的 quote／intent の読取。持ち主の証明が無い・合わないものは存在しないのと同じ。 */
  function readable(intent: Intent | undefined, principalId: string, ownerKey: string | undefined): Intent | undefined {
    if (intent === undefined || intent.principalId !== principalId) {
      return undefined;
    }
    if (intent.dynamic !== undefined || intent.dynamicInvalid === true) {
      if (intent.dynamic === undefined || !ownerKeyMatches(ownerKey, intent.dynamic.ownerKeyHash)) {
        return undefined;
      }
    }
    return intent;
  }

  async function quoteDispatch(input: QuoteRequest): Promise<QuoteOutcome> {
    if (input.upstream === undefined) {
      return quoteLocked(input);
    }
    if (dynamicCore === undefined) {
      return { ok: false, code: "dynamic_disabled" };
    }
    const outcome = await dynamicCore.quote({
      principalId: input.principalId,
      requestId: input.requestId,
      profileId: input.routeId,
      url: input.upstream.url,
      ...(input.upstream.method === undefined ? {} : { method: input.upstream.method }),
      ...(input.upstream.body === undefined ? {} : { body: input.upstream.body }),
      source: input.source ?? input.principalId,
    });
    if (!outcome.ok) {
      return outcome;
    }
    return { ok: true, ...quoteDocumentOf(outcome.intent), ...outcome.fields };
  }

  async function purchaseDispatch(input: PurchaseRequest): Promise<PurchaseOutcome> {
    const intent = store.byQuoteId(input.quoteId);
    // 秘匿購入の記録も `dynamic` 欄を持つので動的の経路へ（記録のメタデータで dispatch。設計 §3.0）。
    const dynamic = intent === undefined ? dynamicCore?.ledgerIntent(input.quoteId) !== undefined : intent.dynamic !== undefined || intent.dynamicInvalid === true || intent.private !== undefined || intent.privateInvalid === true;
    if (!dynamic) {
      return purchaseLocked(input);
    }
    if (dynamicCore === undefined) {
      return outcomeOf("rejected", "unknown_quote");
    }
    const outcome = withDisclosure(await dynamicCore.purchase({ ...input, source: input.source ?? input.principalId }));
    if (outcome.status === "awaiting_session" && outcome.paymentId !== undefined && privateCore !== undefined) {
      const handover = privateCore.takeHandover(outcome.paymentId);
      return handover === undefined ? outcome : { ...outcome, handover };
    }
    return outcome;
  }

  return {
    quote(request: QuoteRequest): Promise<QuoteOutcome> {
      // キューに入る前に入力を切り離す（await 中の呼び出し側の変更を持ち込まない）。
      const input = snapshotInput(request);
      return withKey(`quote\u0000${input.principalId}\u0000${input.requestId}`, () => quoteDispatch(input));
    },
    purchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
      const input = snapshotInput(request);
      return withKey(`purchase\u0000${input.quoteId}`, () => purchaseDispatch(input));
    },
    status(paymentId: string, principalId: string, ownerKey?: string): Projection | undefined {
      const intent = readable(store.byPaymentId(paymentId) ?? dynamicCore?.ledgerIntentByPaymentId(paymentId), principalId, ownerKey);
      return intent === undefined ? undefined : projectionOf(intent);
    },
    offerFor(quoteId: string, principalId: string, routeId?: string, ownerKey?: string): InboundOffer | undefined {
      const intent = readable(store.byQuoteId(quoteId) ?? dynamicCore?.ledgerIntent(quoteId), principalId, ownerKey);
      if (intent === undefined) {
        return undefined;
      }
      if (routeId !== undefined && intent.routeId !== routeId) {
        return undefined;
      }
      // 既にライフサイクルが進んだ quote は再提示しない（二重支払いを誘わない）。cap の無い動的 MPP 送信の記録も
      // 再提示しない（Router が断ると分かっている記録に向けて払わせない。`docs/dynamic-gas-fee-design.md` §3.2）。
      return intent.status === "created" && intent.dynamicCapInvalid !== true ? intent.source.offer : undefined;
    },
    disclosureFor(quoteId: string, principalId: string, routeId?: string, ownerKey?: string): number | undefined {
      const intent = readable(store.byQuoteId(quoteId) ?? dynamicCore?.ledgerIntent(quoteId), principalId, ownerKey);
      if (intent === undefined || (routeId !== undefined && intent.routeId !== routeId)) return undefined;
      return disclosureOf(intent).mayStillSettleUntil;
    },
    async privateQuote(request): Promise<PrivateQuoteOutcome> {
      if (privateCore === undefined) return { ok: false, code: "private_disabled" };
      const input = snapshotInput(request);
      return withKey(`quote\u0000${input.principalId}\u0000${input.requestId}`, async () => {
        if (store.quoteIdFor(input.principalId, input.requestId) !== undefined) return { ok: false, code: "request_id_conflict" };
        const outcome = await privateCore!.quote({ principalId: input.principalId, requestId: input.requestId, profileId: input.profileId, intentB64: input.intentB64, source: input.source ?? input.principalId });
        if (!outcome.ok) return outcome;
        return { ok: true, ...quoteDocumentOf(outcome.intent), ...outcome.fields };
      });
    },
    privateAttest(paymentId, principalId, ownerKey, bundleB64): Promise<AttestOutcome> {
      if (privateCore === undefined) return Promise.resolve({ ok: false, code: "not_found" });
      return privateCore.attest(paymentId, principalId, ownerKey, bundleB64);
    },
    privateRecord(paymentId, principalId, ownerKey): RecordOutcome {
      if (privateCore === undefined) return { ok: false, code: "not_found" };
      return privateCore.record(paymentId, principalId, ownerKey);
    },
    async close(): Promise<void> {
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
      // 起動時の complete の掃き出し（設計 §4.5）: 進行中の 1 件を待ってから journal を閉じる。候補の残りは次の起動。
      sweepAbort = true;
      await sweep;
      await privateCore?.close();
      await ledger?.close();
      await journal.close();
    },
  };
}
