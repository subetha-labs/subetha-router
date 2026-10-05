/**
 * journal から intent 表を再構築し、追記を write-ahead で通す（設計 §5 / §7）。
 * 所有 principal と `(principal, requestId)` → `quoteId` の不変性もここで保持する。
 */

import type { InboundOffer } from "../ports/inbound.js";
import type { DestinationOffer } from "../ports/outbound.js";
import {
  isInterrupted,
  type DestinationOutcome,
  type Intent,
  type IntentDynamic,
  type IntentUpstream,
  type InternalStatus,
} from "./intent.js";
import type { Journal } from "./journal.js";

type Patch = Readonly<Record<string, unknown>>;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

function asObject(value: unknown): Patch {
  return typeof value === "object" && value !== null ? (value as Patch) : {};
}

function requestKey(principalId: string, requestId: string): string {
  return `${principalId}\u0000${requestId}`;
}

/** `created` 行から intent を起こす。 */
/**
 * `routeFingerprint` を**生の値から**判定する（設計 §11.3）。
 *
 * `asString` は非文字列に fallback を返す（throw も coerce もしない）ので、
 * **先に生のプロパティの有無と型を見る**。そうしないと
 * 「壊れた値」が「legacy（欄なし）」に化けて**照合を素通りする**。
 */
function routeFingerprintOf(patch: Patch): {
  readonly routeFingerprint?: string;
  readonly routeFingerprintInvalid?: boolean;
} {
  const raw = patch["routeFingerprint"];
  if (raw === undefined) {
    return {}; // legacy: この機能より前に発行された quote
  }
  if (typeof raw === "string" && raw.startsWith("sha256:")) {
    return { routeFingerprint: raw };
  }
  return { routeFingerprintInvalid: true };
}

const AMOUNT = /^(0|[1-9][0-9]{0,29})$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 動的購入の欄を**生の値から**復元する（`routeFingerprintOf` と同じ考え方）。
 *
 * - 両方とも無い → 静的 route の intent（何も足さない）
 * - 両方あって形が正しい → 復元する
 * - **片方だけ・形が違う → `dynamicInvalid`**。静的として扱うと上流 URL の無い動的購入が静的の経路に流れ、
 *   動的として扱うと検査していない値を実行してしまう。どちらにも倒さず、実行しない印を付ける
 */
export function dynamicFieldsOf(
  patch: Patch,
  /** journal の `created` 行（昇格済み）は必ず予約を持つ。控えの quote は持たない。 */
  options: { readonly requireReservation?: boolean } = {},
): {
  readonly upstream?: IntentUpstream;
  readonly dynamic?: IntentDynamic;
  readonly dynamicInvalid?: boolean;
} {
  const rawUpstream = patch["upstream"];
  const rawDynamic = patch["dynamic"];
  if (rawUpstream === undefined && rawDynamic === undefined) {
    return {};
  }
  if (!isPlainRecord(rawUpstream) || !isPlainRecord(rawDynamic)) {
    return { dynamicInvalid: true };
  }
  const pricing = rawDynamic["pricing"];
  const profile = rawDynamic["profile"];
  const ownerKeyHash = rawDynamic["ownerKeyHash"];
  const profileId = rawDynamic["profileId"];
  if (
    typeof rawUpstream["url"] !== "string" ||
    rawUpstream["url"] === "" ||
    rawUpstream["method"] !== "GET" ||
    typeof profileId !== "string" ||
    profileId === "" ||
    !isPlainRecord(profile) ||
    !isPlainRecord(pricing) ||
    typeof ownerKeyHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(ownerKeyHash)
  ) {
    return { dynamicInvalid: true };
  }
  const amounts = ["upstreamAmount", "converted", "fee", "total"] as const;
  if (!amounts.every((key) => typeof pricing[key] === "string" && AMOUNT.test(pricing[key]))) {
    return { dynamicInvalid: true };
  }
  let reservation: IntentDynamic["reservation"];
  const rawReservation = rawDynamic["reservation"];
  if (rawReservation !== undefined) {
    const legs = isPlainRecord(rawReservation) ? rawReservation["legs"] : undefined;
    if (
      !Array.isArray(legs) ||
      legs.length === 0 ||
      !legs.every(
        (leg) =>
          isPlainRecord(leg) &&
          typeof leg["network"] === "string" &&
          typeof leg["asset"] === "string" &&
          typeof leg["amount"] === "string" &&
          AMOUNT.test(leg["amount"]),
      )
    ) {
      return { dynamicInvalid: true };
    }
    reservation = {
      legs: (legs as Record<string, string>[]).map((leg) => ({ network: leg["network"]!, asset: leg["asset"]!, amount: leg["amount"]! })),
    };
  }
  if (options.requireReservation === true && reservation === undefined) {
    // 予約の無い動的購入は journal に存在し得ない（昇格は予約と同じ 1 行）。
    return { dynamicInvalid: true };
  }
  return {
    upstream: { url: rawUpstream["url"], method: "GET" },
    dynamic: {
      profileId,
      profile,
      pricing: {
        upstreamAmount: pricing["upstreamAmount"] as string,
        converted: pricing["converted"] as string,
        fee: pricing["fee"] as string,
        total: pricing["total"] as string,
      },
      ownerKeyHash,
      ...(reservation === undefined ? {} : { reservation }),
    },
  };
}

function intentFromCreated(paymentId: string, at: string, patch: Patch): Intent {
  const source = asObject(patch["source"]);
  const destination = asObject(patch["destination"]);
  return {
    paymentId,
    quoteId: asString(patch["quoteId"]),
    routeId: asString(patch["routeId"]),
    principalId: asString(patch["principalId"]),
    requestId: asString(patch["requestId"]),
    status: "created",
    source: {
      amount: asString(source["amount"]),
      asset: asString(source["asset"]),
      network: asString(source["network"]),
      offer: source["offer"] as InboundOffer,
    },
    destination: {
      quoted: asString(destination["quoted"]),
      asset: asString(destination["asset"]),
      network: asString(destination["network"]),
      selectedOffer: destination["selectedOffer"] as DestinationOffer,
      attempt: 0,
      outcome: "none",
    },
    quoteFingerprint: asString(patch["quoteFingerprint"]),
    // **spread ではなく明示的に復元する。** この関数はフィールドを列挙するので、
    // 足し忘れると append 直後に欄が消え、照合が一切効かなくなる（設計 §8.1）。
    ...routeFingerprintOf(patch),
    // 動的購入の欄も明示的に復元する（足し忘れると、上流 URL と条件が消えた intent になる）。
    ...dynamicFieldsOf(patch, { requireReservation: true }),
    approvalDeadlineMs: asNumber(patch["approvalDeadlineMs"]),
    updatedAt: at,
  };
}

/** 1 行を現在の intent に適用する。 */
function reduce(current: Intent, event: string, patch: Patch, at: string): Intent {
  const base = { ...current, updatedAt: at };
  switch (event) {
    case "source_pending":
      return { ...base, status: "source_pending" };
    case "source_settled":
      return {
        ...base,
        status: "source_settled",
        source: { ...current.source, txRef: asString(patch["txRef"]), outcome: "settled" },
      };
    case "source_failed":
      return {
        ...base,
        status: "source_failed",
        source: { ...current.source, outcome: asString(patch["outcome"], "failed") },
        terminalReason: asString(patch["reason"], current.terminalReason ?? ""),
      };
    case "destination_pending":
      return {
        ...base,
        status: "destination_pending",
        destination: { ...current.destination, attempt: asNumber(patch["attempt"], 1) },
      };
    case "destination_submitted":
      return { ...base, status: "destination_submitted" };
    case "delivered":
      return {
        ...base,
        status: "delivered",
        destination: {
          ...current.destination,
          outcome: "paid",
          ...(asString(patch["txRef"]) === "" ? {} : { txRef: asString(patch["txRef"]) }),
          ...(asString(patch["receiptRef"]) === ""
            ? {}
            : { receiptRef: asString(patch["receiptRef"]) }),
        },
        result: { body: patch["body"], contentType: asString(patch["contentType"]) },
      };
    case "paid_undelivered":
      return {
        ...base,
        status: "paid_undelivered",
        destination: {
          ...current.destination,
          outcome: asString(patch["outcome"], "paid") as DestinationOutcome,
          ...(asString(patch["receiptRef"]) === ""
            ? {}
            : { receiptRef: asString(patch["receiptRef"]) }),
        },
        terminalReason: asString(patch["reason"], "paid_data_unavailable"),
      };
    case "dest_failed":
      return {
        ...base,
        status: "dest_failed",
        destination: {
          ...current.destination,
          outcome: asString(patch["outcome"], "failed") as DestinationOutcome,
        },
        terminalReason: asString(patch["reason"], "destination_failed"),
      };
    case "unknown":
      return {
        ...base,
        status: "unknown",
        destination: {
          ...current.destination,
          outcome: asString(patch["outcome"], current.destination.outcome) as DestinationOutcome,
        },
        terminalReason: asString(patch["reason"], "unknown"),
      };
    default:
      // budget レジャー行など intent 状態を持たない行。
      return current;
  }
}

/** 既存の `paymentId` / `quoteId` を再利用しようとした（履歴を上書きしない）。 */
export class IntentCollisionError extends Error {
  readonly code = "payment_id_collision";

  constructor(paymentId: string, quoteId: string) {
    super(`intent identity already in use: paymentId=${paymentId} quoteId=${quoteId}`);
    this.name = "IntentCollisionError";
  }
}

export class IntentStore {
  readonly #journal: Journal;
  readonly #intents = new Map<string, Intent>();
  readonly #quoteToPayment = new Map<string, string>();
  readonly #requestToQuote = new Map<string, string>();
  /** 追記の直列化（同一性検査 → append → 反映を不可分にする）。 */
  #queue: Promise<void> = Promise.resolve();

  private constructor(journal: Journal) {
    this.#journal = journal;
  }

  static async load(journal: Journal): Promise<IntentStore> {
    const store = new IntentStore(journal);
    for (const record of journal.records) {
      store.#applyRecord(record.paymentId, record.event, record.patch, record.at);
    }
    await store.#resolveInterrupted();
    return store;
  }

  /**
   * `source_pending` / `destination_pending` / `destination_submitted` のまま終わった
   * 記録は一律 `unknown` に確定する。送出前に fsync していても、その直後・送出中の
   * クラッシュと区別できないため「未送出」を証明しない。自動再送も自動再 settle もしない。
   */
  async #resolveInterrupted(): Promise<void> {
    const pending = [...this.#intents.values()].filter((intent) => isInterrupted(intent.status));
    for (const intent of pending) {
      // メモリ上だけの確定にせず、`unknown` を journal にも残す。
      await this.append(intent.paymentId, "unknown", {
        outcome: intent.status === "source_pending" ? intent.destination.outcome : "unknown",
        reason: "interrupted_at_restart",
      });
    }
  }

  /** 同じ `paymentId` / `quoteId` を二度使わない（replay でも append でも fail closed）。 */
  #assertFreshIdentity(paymentId: string, quoteId: string): void {
    if (this.#intents.has(paymentId) || this.#quoteToPayment.has(quoteId)) {
      throw new IntentCollisionError(paymentId, quoteId);
    }
  }

  #applyRecord(paymentId: string, event: string, patch: Patch, at: string): void {
    if (event === "created") {
      this.#assertFreshIdentity(paymentId, asString(patch["quoteId"]));
      const intent = intentFromCreated(paymentId, at, patch);
      this.#intents.set(paymentId, intent);
      this.#quoteToPayment.set(intent.quoteId, paymentId);
      this.#requestToQuote.set(requestKey(intent.principalId, intent.requestId), intent.quoteId);
      return;
    }
    const current = this.#intents.get(paymentId);
    if (current === undefined) {
      return;
    }
    this.#intents.set(paymentId, reduce(current, event, patch, at));
  }

  /**
   * journal への追記をこの store に一本化し、単一 mutex で直列化する。
   * 同一性検査と append を不可分にし、メモリへ反映するのは**永続化された行そのもの**
   * （呼び出し側が持つ可変オブジェクトではない）。
   */
  append(paymentId: string, event: string, patch: Patch): Promise<void> {
    const appended = this.#queue.then(() => this.#appendLocked(paymentId, event, patch));
    this.#queue = appended.then(
      () => undefined,
      () => undefined,
    );
    return appended;
  }

  async #appendLocked(paymentId: string, event: string, patch: Patch): Promise<void> {
    // 衝突する `created` は 1 バイトも書かずに拒否する。
    if (event === "created") {
      this.#assertFreshIdentity(paymentId, asString(patch["quoteId"]));
    }
    await this.#journal.append({ paymentId, event, patch });

    // journal が凍結して保持している行を読み戻して適用する。
    const written = this.#journal.records.at(-1);
    if (written === undefined || written.paymentId !== paymentId || written.event !== event) {
      throw new Error("journal record mismatch after append");
    }
    this.#applyRecord(written.paymentId, written.event, written.patch, written.at);
  }

  byPaymentId(paymentId: string): Intent | undefined {
    return this.#intents.get(paymentId);
  }

  byQuoteId(quoteId: string): Intent | undefined {
    const paymentId = this.#quoteToPayment.get(quoteId);
    return paymentId === undefined ? undefined : this.#intents.get(paymentId);
  }

  /** `(principal, requestId)` → `quoteId` は R2 で確定し不変。 */
  quoteIdFor(principalId: string, requestId: string): string | undefined {
    return this.#requestToQuote.get(requestKey(principalId, requestId));
  }

  /** 中断された途中状態を `unknown` へ確定する（再起動時）。 */
  interrupted(): readonly Intent[] {
    return [...this.#intents.values()];
  }

  statusOf(paymentId: string): InternalStatus | undefined {
    return this.#intents.get(paymentId)?.status;
  }
}
