/**
 * journal から intent 表を再構築し、追記を write-ahead で通す（設計 §5 / §7）。
 * 所有 principal と `(principal, requestId)` → `quoteId` の不変性もここで保持する。
 */

import type { InboundOffer } from "../ports/inbound.js";
import { networkFamilyOf } from "../config.js";
import type { MessageReservation } from "../ports/outbound.js";
import type { DestinationOffer } from "../ports/outbound.js";
import { createHash } from "node:crypto";
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
  readonly dynamicCapInvalid?: boolean;
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
    !validUpstreamRequest(rawUpstream) ||
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
  const cap = capFieldsOf(pricing);
  const dynamic: IntentDynamic = {
    profileId,
    profile,
    pricing: {
      upstreamAmount: pricing["upstreamAmount"] as string,
      converted: pricing["converted"] as string,
      fee: pricing["fee"] as string,
      total: pricing["total"] as string,
      ...(cap === undefined ? {} : cap),
    },
    ownerKeyHash,
    ...(reservation === undefined ? {} : { reservation }),
  };
  /**
   * MPP 送信の記録は cap を持つこと（`docs/dynamic-gas-fee-design.md` §3.2）。無い・形が違う・手数料 < cap なら `dynamicCapInvalid`:
   * `dynamic` は保つ（持ち主の証明・予約・結果はそのまま）が、purchase は実行しない。
   */
  if (profile["rail"] === "mpp") {
    const source = isPlainRecord(patch["source"]) ? patch["source"] : {};
    const sourceOffer = isPlainRecord(source["offer"]) ? source["offer"] : {};
    const destination = isPlainRecord(patch["destination"]) ? patch["destination"] : {};
    const selected = isPlainRecord(destination["selectedOffer"]) ? destination["selectedOffer"] : {};
    const bound = {
      // settle に渡るのは `source.offer` そのもの。写しの `source.amount` ではなく offer の額に結び付ける。
      sourceAmount: String(sourceOffer["amount"]),
      upstreamOfferAmount: String(selected["amount"]),
      requireReservation: options.requireReservation === true,
    };
    /**
     * Solana 宛の MPP の記録は cap を**名乗ってもいけない**（`docs/mpp-solana-design.md` §1.4 (c)）。`capFieldsOf` は形の悪い cap を落として `dynamic.pricing`
     * を組むので、`capCoversFee` には「無い」と見える。正規化の前の**生の欄の有無**で見る（片方だけ・形違いも不可。SR-3 SVM レビュー #1 の指摘）。
     */
    const copiedDestination = isPlainRecord(profile["destination"]) ? profile["destination"] : undefined;
    const copiedNetwork = copiedDestination?.["network"];
    const rawClaimsCap = Object.hasOwn(pricing, "maxFee") || Object.hasOwn(pricing, "estimate");
    const svmWithCap = typeof copiedNetwork === "string" && networkFamilyOf(copiedNetwork) === "svm" && rawClaimsCap;
    if (svmWithCap || !capCoversFee(dynamic, bound)) {
      return { upstream: upstreamRecordOf(rawUpstream), dynamic, dynamicCapInvalid: true };
    }
  }
  return { upstream: upstreamRecordOf(rawUpstream), dynamic };
}

/** `pricing.maxFee`・`pricing.estimate` を形どおりに読む。片方でも形が違えば `undefined`（両方無いのも `undefined`）。 */
function capFieldsOf(pricing: Record<string, unknown>): { maxFee: string; estimate: NonNullable<IntentDynamic["pricing"]["estimate"]> } | undefined {
  const maxFee = pricing["maxFee"];
  const estimate = pricing["estimate"];
  if (typeof maxFee !== "string" || !AMOUNT.test(maxFee) || !isPlainRecord(estimate)) return undefined;
  const { gas, maxFeePerGas, bound, atMs } = estimate;
  if (typeof gas !== "string" || !AMOUNT.test(gas) || typeof maxFeePerGas !== "string" || !AMOUNT.test(maxFeePerGas) || typeof bound !== "string" || !AMOUNT.test(bound)) {
    return undefined;
  }
  if (typeof atMs !== "number" || !Number.isSafeInteger(atMs) || atMs < 0) return undefined;
  return { maxFee, estimate: { gas, maxFeePerGas, bound, atMs } };
}

/**
 * MPP 送信の記録の cap が、**実際に払われる額**に結び付いているか（`docs/dynamic-gas-fee-design.md` §3.2・§3.3）。復元と昇格済みの再開が同じ検査を使う:
 * - `pricing.maxFee`・`pricing.estimate` が形どおり（`capFieldsOf`）で、`fee >= maxFee`
 * - `total = converted + fee`、`converted = upstreamAmount`（MPP 送信は受信と送信の桁が同じ・par なので換算は恒等）、
 *   **実際の受信 offer**の額（呼び出し側が先に払う額。`source.amount` の写しではなく `source.offer.amount`）= `total`、`upstreamAmount` = 選んだ上流 offer の額
 *   （記録の `fee`・`maxFee`・`converted`・`source.amount` を書き換えて、払っていない手数料で大きな cap を通せないように）
 * - 予約があれば、手数料の資産の区分（宛先の network・feeAsset。再開では設定のプロファイルのもの）の合計が `upstreamAmount + maxFee` 以上。
 *   `requireReservation` なら予約が無いのも不可（昇格済み）
 */
export function capCoversFee(
  dynamic: IntentDynamic,
  bound: {
    /** 実際の受信 offer の額（`source.offer.amount`）。 */
    readonly sourceAmount: string;
    readonly upstreamOfferAmount: string;
    readonly requireReservation?: boolean;
    /**
     * 予約の区分を引く宛先（network・feeAsset・asset）。再開では**設定のプロファイル**（指紋で quote 時のものと一致を確かめ済み）を渡す。
     * 省略時は記録のプロファイルの写し（復元。写しは書き換えられ得るので、実行は再開の検査が守る）。
     */
    readonly destination?: { readonly network: string; readonly feeAsset: string | undefined; readonly asset?: string | undefined };
  },
): boolean {
  const pricing = dynamic.pricing as unknown as Record<string, unknown>;
  const copied = dynamic.profile["destination"];
  const copiedNetwork = isPlainRecord(copied) ? copied["network"] : undefined;
  const boundNetwork = bound.destination?.network;
  const network = boundNetwork ?? copiedNetwork;
  if (typeof network !== "string") return false;
  const family = networkFamilyOf(network);
  if (family === undefined) return false;
  // 再開では設定の宛先（bound）と記録の写しの両方が見える。family が食い違う記録は不可（写しを書き換えて Solana の例外に逃げさせない）。
  if (typeof boundNetwork === "string" && typeof copiedNetwork === "string" && networkFamilyOf(copiedNetwork) !== family) return false;
  const { fee, upstreamAmount, converted, total } = dynamic.pricing;
  if (![fee, upstreamAmount, converted, total, bound.sourceAmount, bound.upstreamOfferAmount].every((value) => typeof value === "string" && AMOUNT.test(value))) return false;
  let maxFee: bigint;
  if (family === "svm") {
    // Solana 宛の MPP（`docs/mpp-solana-design.md` §1.4 (c)、FR-44 の明示の例外）: cap を持たない。cap を名乗る記録は core が作らないので不可。
    if (pricing["maxFee"] !== undefined || pricing["estimate"] !== undefined) return false;
    maxFee = 0n;
  } else {
    const cap = capFieldsOf(pricing);
    if (cap === undefined) return false;
    maxFee = BigInt(cap.maxFee);
    if (BigInt(fee) < maxFee) return false;
  }
  if (BigInt(converted) + BigInt(fee) !== BigInt(total)) return false;
  if (BigInt(converted) !== BigInt(upstreamAmount)) return false;
  if (BigInt(bound.sourceAmount) !== BigInt(total) || BigInt(bound.upstreamOfferAmount) !== BigInt(upstreamAmount)) return false;
  if (dynamic.reservation === undefined) {
    return bound.requireReservation !== true;
  }
  // 予約の区分: Tempo は手数料の資産（= 送信資産）で upstreamAmount + maxFee。Solana は送信資産で upstreamAmount（手数料の leg は無い）。
  const asset =
    family === "svm"
      ? bound.destination !== undefined
        ? bound.destination.asset
        : isPlainRecord(copied)
          ? copied["asset"]
          : undefined
      : bound.destination !== undefined
        ? bound.destination.feeAsset
        : isPlainRecord(copied)
          ? copied["feeAsset"]
          : undefined;
  if (typeof asset !== "string") return false;
  // EVM の資産は小文字化して比べ、SVM の mint は大文字小文字を保つ（multirail 設計 §1、FR-4）。
  const sameAsset = (candidate: string): boolean => (family === "svm" ? candidate === asset : candidate.toLowerCase() === asset.toLowerCase());
  let reserved = 0n;
  for (const leg of dynamic.reservation.legs) {
    if (leg.network === network && sameAsset(leg.asset)) reserved += BigInt(leg.amount);
  }
  return reserved >= BigInt(upstreamAmount) + maxFee;
}

/** `created` 行（控えの記録も同じ形）から intent を組む。動的の欄は予約が無くても読む側（控え）があるので、呼び出し側が `requireReservation` を決める。 */
export function intentFromCreated(paymentId: string, at: string, patch: Patch, options: { readonly requireReservation?: boolean } = { requireReservation: true }): Intent {
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
    ...dynamicFieldsOf(patch, { requireReservation: options.requireReservation !== false }),
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

/** message の hash（sha256 の小文字 hex 64 文字）。 */
const MESSAGE_HASH_PATTERN = /^[0-9a-f]{64}$/;
/** 署名する message の hash を署名の前に予約する行（送信の設計 §2.5）。intent の状態は変えない。 */
export const MESSAGE_RESERVED_EVENT = "destination_message_reserved";

export class IntentStore {
  readonly #journal: Journal;
  readonly #intents = new Map<string, Intent>();
  readonly #quoteToPayment = new Map<string, string>();
  readonly #requestToQuote = new Map<string, string>();
  /** 予約済みの message の hash（journal から復元。永続）。 */
  readonly #messageHashes = new Set<string>();
  /**
   * 受信で消費した署名（`source_settled` の行の `txRef`。journal から復元、append でも足す。永続）。MPP Solana 受信の replay の防御の層
   * （`docs/mpp-solana-design.md` §2.3、要件 SR-M2）。記録そのものは `source_settled` の行で、別の行は書かない。
   */
  readonly #settledSourceTxRefs = new Set<string>();
  /** 追記の直列化（同一性検査 → append → 反映を不可分にする）。 */
  #queue: Promise<void> = Promise.resolve();

  private constructor(journal: Journal) {
    this.#journal = journal;
    const backing = this.#settledSourceTxRefs;
    const view: ReadonlySet<string> = Object.freeze({
      has: (value: string): boolean => backing.has(value),
      get size(): number {
        return backing.size;
      },
      forEach: (callback: (value: string, value2: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void => {
        for (const value of backing) callback.call(thisArg, value, value, view);
      },
      entries: () => backing.entries(),
      keys: () => backing.keys(),
      values: () => backing.values(),
      [Symbol.iterator]: () => backing.values(),
    }) as unknown as ReadonlySet<string>;
    this.#settledSourceTxRefsView = view;
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
      if (intent.status === "source_settled") {
        // 受信は確定、送信は始めていない（`destination_pending` の前）: 不明ではなく「課金は成立・未送出」の終端。再送も再購入もしない。
        // メモリ上だけの確定にせず、journal にも残す（SR-3 SVM レビュー #2、2026-10-08）。
        await this.append(intent.paymentId, "paid_undelivered", { outcome: "not_sent", reason: "interrupted_at_restart" });
        continue;
      }
      // メモリ上だけの確定にせず、`unknown` を journal にも残す。
      await this.append(intent.paymentId, "unknown", {
        // 送信を始める前（`source_pending`）なら送信の結果はそのまま（未送出）。送信の途中なら不明。
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
    if (event === MESSAGE_RESERVED_EVENT) {
      // 形の壊れた予約の行は無視しない（復元できない予約は「同じ message に二度署名しない」規則を破る）。起動を止める。
      const hash = patch["messageHash"];
      if (typeof hash !== "string" || !MESSAGE_HASH_PATTERN.test(hash)) {
        throw new Error("journal: malformed destination_message_reserved row");
      }
      this.#messageHashes.add(hash);
      return;
    }
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
    if (event === "source_settled") {
      const txRef = patch["txRef"];
      if (typeof txRef === "string" && txRef !== "") this.#settledSourceTxRefs.add(txRef);
    }
  }

  /**
   * 受信で消費した署名の集合（読取だけ。`source_settled` の行から復元・追記で更新）。**裏の Set は渡さない**: 返すのは生きた読取専用の facade
   * （`add`・`delete`・`clear` を持たない）。JavaScript から cast しても journal の行無しに replay の防御を変えられない。
   */
  get settledSourceTxRefs(): ReadonlySet<string> {
    return this.#settledSourceTxRefsView;
  }
  readonly #settledSourceTxRefsView: ReadonlySet<string>;

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

  /**
   * 署名する message の hash を**署名の前に**排他的に予約する（送信の設計 §2.5、FR-37）。同じ `#queue` の中で
   * 未使用の検査 → journal への追記（fsync）→ 索引の更新を不可分に行う。journal に書けなければ `unavailable`（Set にも入れない）。
   * 同じ hash は、別の購入からでも同じ購入からでも `collision`。対象の intent が `destination_pending` でなければ `unavailable`。
   */
  reserveMessage(paymentId: string, messageHash: string): Promise<MessageReservation> {
    const reserved = this.#queue.then(() => this.#reserveLocked(paymentId, messageHash));
    this.#queue = reserved.then(
      () => undefined,
      () => undefined,
    );
    return reserved;
  }

  async #reserveLocked(paymentId: string, messageHash: string): Promise<MessageReservation> {
    if (!MESSAGE_HASH_PATTERN.test(messageHash)) return "unavailable";
    const intent = this.#intents.get(paymentId);
    if (intent === undefined || intent.status !== "destination_pending") return "unavailable";
    if (this.#messageHashes.has(messageHash)) return "collision";
    try {
      // queue の中から公開の `append()` を待たない（自己待機になる）。内部の追記を直接呼ぶ。
      await this.#appendLocked(paymentId, MESSAGE_RESERVED_EVENT, { messageHash });
    } catch {
      return "unavailable";
    }
    return "reserved";
  }

  /** 予約済みの message の hash か（試験と診断のため。予約はこれを見ずに `reserveMessage` で行う）。 */
  hasReservedMessage(messageHash: string): boolean {
    return this.#messageHashes.has(messageHash);
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

/** 記録の `upstream`（`docs/dynamic-upstream-post-design.md` FR-P2）: GET は本文なし、POST は本文（文字列、8 KiB 以内）と一致する sha256。 */
export function validUpstreamRequest(raw: Record<string, unknown>): boolean {
  if (typeof raw["url"] !== "string" || raw["url"] === "") return false;
  if (raw["method"] === "GET") return !Object.hasOwn(raw, "body") && !Object.hasOwn(raw, "bodySha256");
  if (raw["method"] !== "POST") return false;
  const body = raw["body"];
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > 8192) return false;
  return raw["bodySha256"] === createHash("sha256").update(body, "utf8").digest("hex");
}

function upstreamRecordOf(raw: Record<string, unknown>): { url: string; method: "GET" | "POST"; body?: string; bodySha256?: string } {
  return raw["method"] === "POST"
    ? { url: raw["url"] as string, method: "POST", body: raw["body"] as string, bodySha256: raw["bodySha256"] as string }
    : { url: raw["url"] as string, method: "GET" };
}
