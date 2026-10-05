/**
 * 購入ライフサイクルの合成（設計 §4 の束縛順序）。
 * core は rail 名で分岐せず、ポート越しにのみ両レールへ触る。
 */

import { randomUUID } from "node:crypto";

import {
  authoritativeTermsOf,
  resolveRoute,
  routeBindingOf,
  type RouteConfig,
  type RouterConfig,
} from "../config.js";
import type { InboundOffer, InboundRail, PaymentCredential } from "../ports/inbound.js";
import type { DestinationOffer, OutboundRail } from "../ports/outbound.js";
import { Budget } from "./budget.js";
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
import { IntentCollisionError, IntentStore } from "./store.js";

export interface QuoteRequest {
  readonly principalId: string;
  readonly requestId: string;
  readonly routeId: string;
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
    readonly quoteFingerprint: string;
  };
  readonly approval: {
    readonly required: true;
    readonly boundTo: string;
    readonly deadlineMs: number;
  };
}

export type QuoteOutcome =
  | ({ readonly ok: true } & QuoteDocument)
  | { readonly ok: false; readonly code: string; readonly reason?: string };

export interface PurchaseRequest {
  readonly principalId: string;
  readonly requestId: string;
  readonly quoteId: string;
  /** R3 のパスが指す `routeId`。quote の経路と違えば別経路を実行しない。 */
  readonly routeId?: string;
  /** 承認は `quoteId` に束縛される。 */
  readonly approval?: string;
  readonly credential?: PaymentCredential;
}

export interface PurchaseOutcome {
  readonly paymentId?: string;
  readonly status: PublicStatus | "rejected";
  readonly code?: string;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly terminalReason?: string;
}

export interface Projection {
  readonly paymentId: string;
  readonly routeId: string;
  readonly status: PublicStatus;
  readonly source: {
    readonly amount: string;
    readonly asset: string;
    readonly network: string;
    readonly txRef?: string;
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
}

export interface RouterCore {
  quote(request: QuoteRequest): Promise<QuoteOutcome>;
  purchase(request: PurchaseRequest): Promise<PurchaseOutcome>;
  status(paymentId: string, principalId: string): Projection | undefined;
  /**
   * 資格情報なしの R3 に対して発行済み offer を再提示するための読み取り専用アクセサ。
   * 所有 principal・経路一致・未開始の quote のときだけ返し、**journal には何も書かない**。
   */
  offerFor(quoteId: string, principalId: string, routeId?: string): InboundOffer | undefined;
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
  };
  return projection;
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
      if (existing.routeId !== request.routeId) {
        return { ok: false, code: "request_id_conflict" };
      }
      return { ok: true, ...quoteDocumentOf(existing) };
    }

    // 先に上流を quote（純粋読取・無課金）してから受信 offer を発行する。
    const offers = await options.outbound.readChallenge(route.routeId);
    const selectedOffer = selectOffer(offers, route);
    if (selectedOffer === undefined) {
      return { ok: false, code: "quote_failed", reason: "no_matching_offer" };
    }

    const sourceOffer = await options.inbound.createOffer({
      routeId: route.routeId,
      amount: route.source.amount,
      asset: route.source.asset,
      network: route.source.network,
      routeBinding: routeBindingOf(route),
      nowMs: now(),
    });

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

  async function purchaseLocked(request: PurchaseRequest): Promise<PurchaseOutcome> {
    const intent = store.byQuoteId(request.quoteId);
    if (intent === undefined) {
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
    let stillOffered: boolean;
    try {
      stillOffered = await readAndMatchDestination(intent);
    } catch {
      await store.append(intent.paymentId, "source_failed", {
        outcome: "not_sent",
        reason: "offer_unavailable",
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
      });
      return { paymentId: intent.paymentId, status: "awaiting_payment", code: "offer_changed" };
    }

    await store.append(intent.paymentId, "source_pending", {});

    let verified: { isValid: boolean };
    try {
      verified = await options.inbound.verify(intent.source.offer, credential, { routeId: intent.routeId });
    } catch {
      // 受信レールの応答が取れない以上、課金有無を証明できない。
      await store.append(intent.paymentId, "unknown", {
        outcome: "none",
        reason: "source_verify_unavailable",
      });
      return {
        paymentId: intent.paymentId,
        status: "unknown",
        terminalReason: "source_verify_unavailable",
      };
    }
    if (verified === null || typeof verified !== "object" || verified.isValid !== true) {
      await store.append(intent.paymentId, "source_failed", {
        outcome: "rejected",
        reason: "verify_failed",
      });
      return { paymentId: intent.paymentId, status: "awaiting_payment", code: "verify_failed" };
    }

    // verify 中に時間が経っていても止められるよう、settle 直前に期限を再検査する。
    const beforeSettleMs = now();
    if (
      beforeSettleMs >= intent.approvalDeadlineMs ||
      beforeSettleMs >= intent.source.offer.extra.expiresAt * 1000
    ) {
      await store.append(intent.paymentId, "source_failed", {
        outcome: "not_sent",
        reason: "approval_expired",
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
      await store.append(intent.paymentId, "source_failed", {
        outcome: "not_sent",
        reason: reservation.reason,
      });
      return { paymentId: intent.paymentId, status: "awaiting_payment", code: reservation.reason };
    }

    // 宣言型ではなく実際の値として扱う（相手の振る舞いは型では保証されない）。
    let settled: unknown;
    try {
      settled = await options.inbound.settle(intent.source.offer, credential, { routeId: intent.routeId });
    } catch {
      // 例外・タイムアウトは必ず `unknown`。自動再 settle はしない。
      await store.append(intent.paymentId, "unknown", {
        outcome: "none",
        reason: "source_settle_unknown",
      });
      return {
        paymentId: intent.paymentId,
        status: "unknown",
        terminalReason: "source_settle_unknown",
      };
    }
    // 応答は実行時に検査する（TypeScript の型は相手の振る舞いを保証しない）。
    const outcome = isRecord(settled) ? settled["outcome"] : undefined;
    if (outcome === "rejected") {
      await store.append(intent.paymentId, "source_failed", {
        outcome: "rejected",
        reason: safeReason(isRecord(settled) ? settled["reason"] : undefined, "source_rejected"),
      });
      return {
        paymentId: intent.paymentId,
        status: "awaiting_payment",
        code: safeReason(isRecord(settled) ? settled["reason"] : undefined, "source_rejected"),
      };
    }
    const txRef = isRecord(settled) ? settled["txRef"] : undefined;
    if (outcome === "settled" && typeof txRef === "string" && txRef !== "") {
      await store.append(intent.paymentId, "source_settled", { txRef });
      return deliver(intent.paymentId);
    }

    // `unknown`・契約にない outcome・証跡のない `settled` は一律 `unknown`。
    // 送信レグは開始せず、自動再 settle もしない。
    await store.append(intent.paymentId, "unknown", {
      outcome: "none",
      reason: "source_settle_unknown",
    });
    return {
      paymentId: intent.paymentId,
      status: "unknown",
      terminalReason: "source_settle_unknown",
    };
  }

  /** 受信成立後の送信レグ。write-ahead 予約を fsync してから送出する。 */
  async function deliver(paymentId: string): Promise<PurchaseOutcome> {
    const intent = store.byPaymentId(paymentId);
    if (intent === undefined) {
      return outcomeOf("rejected", "unknown_payment");
    }

    // 送金直前にもう一度上流の現在の challenge を読み直す（手順 4 の後に起きた
    // 変更へのレース対策）。ここで外れたら署名も送信もしない。受信レグは成立済みな
    // ので終了状態は `paid_undelivered`（理由 `quote_changed`）で、再課金も再購入もしない。
    let stillOffered: boolean;
    try {
      stillOffered = await readAndMatchDestination(intent);
    } catch {
      // 受信は成立済み・送信は未実行。再送も再購入もしない終端として確定する。
      await store.append(paymentId, "paid_undelivered", {
        outcome: "not_sent",
        reason: "offer_unavailable",
      });
      return { paymentId, status: "paid_data_unavailable", terminalReason: "offer_unavailable" };
    }
    if (!stillOffered) {
      await store.append(paymentId, "paid_undelivered", {
        outcome: "not_sent",
        reason: "quote_changed",
      });
      return { paymentId, status: "paid_data_unavailable", terminalReason: "quote_changed" };
    }

    const attempt = intent.destination.attempt + 1;
    await store.append(paymentId, "destination_pending", { attempt });

    // 宣言型ではなく実際の値として扱う。
    let result: unknown;
    try {
      result = await options.outbound.pay({
        routeId: intent.routeId,
        offer: intent.destination.selectedOffer,
        paymentId,
        attempt,
      });
    } catch {
      // 送金有無が不明。例外文字列は残さず固定の理由コードだけ記録する。
      await store.append(paymentId, "unknown", {
        outcome: "unknown",
        reason: "destination_pay_unknown",
      });
      return { paymentId, status: "unknown", terminalReason: "destination_pay_unknown" };
    }

    // `null` / `undefined` / 契約にない形も含めて、参照する前に形を検査する。
    const unknownDestination = async (reason: string): Promise<PurchaseOutcome> => {
      await store.append(paymentId, "unknown", { outcome: "unknown", reason });
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
        return { paymentId, status: "paid_data_unavailable", terminalReason: reason };
      }
      case "not_sent":
      case "rejected": {
        const reason = safeReason(result["reason"], "destination_rejected");
        await store.append(paymentId, "dest_failed", {
          outcome: result["outcome"],
          reason,
        });
        return { paymentId, status: "paid_data_unavailable", terminalReason: reason };
      }
      default:
        // `unknown` も契約にない outcome も、送金有無不明として同じ扱いにする。
        return unknownDestination(safeReason(result["reason"], "destination_pay_unknown"));
    }
  }

  /** 送金直前・settle 直前の再照合（凍結した accepts をそのまま使わない）。 */
  async function readAndMatchDestination(intent: Intent): Promise<boolean> {
    const offers = await options.outbound.readChallenge(intent.routeId);
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

  return {
    quote(request: QuoteRequest): Promise<QuoteOutcome> {
      // キューに入る前に入力を切り離す（await 中の呼び出し側の変更を持ち込まない）。
      const input = snapshotInput(request);
      return withKey(`quote\u0000${input.principalId}\u0000${input.requestId}`, () =>
        quoteLocked(input),
      );
    },
    purchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
      const input = snapshotInput(request);
      return withKey(`purchase\u0000${input.quoteId}`, () => purchaseLocked(input));
    },
    status(paymentId: string, principalId: string): Projection | undefined {
      const intent = store.byPaymentId(paymentId);
      if (intent === undefined || intent.principalId !== principalId) {
        return undefined;
      }
      return projectionOf(intent);
    },
    offerFor(quoteId: string, principalId: string, routeId?: string): InboundOffer | undefined {
      const intent = store.byQuoteId(quoteId);
      if (intent === undefined || intent.principalId !== principalId) {
        return undefined;
      }
      if (routeId !== undefined && intent.routeId !== routeId) {
        return undefined;
      }
      // 既にライフサイクルが進んだ quote は再提示しない（二重支払いを誘わない）。
      return intent.status === "created" ? intent.source.offer : undefined;
    },
    async close(): Promise<void> {
      await journal.close();
    },
  };
}
