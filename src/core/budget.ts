/**
 * 全購入を通算する単一レジャー（設計 §5）。金額は `(network, asset)` バケットごとに
 * 通算し、異資産の生数値は足さない。件数だけは全体で 1 本のカウンタ。
 */

import type { BudgetLimits } from "../config.js";
import type { Journal } from "./journal.js";

export interface BucketAmount {
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
}

export interface ReservationRequest {
  readonly paymentId: string;
  readonly source: BucketAmount;
  readonly destination: BucketAmount;
}

export type ReservationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * 動的購入の予約（設計 `docs/dynamic-upstream-design.md` §6.2・§6.4）。受信額・送信元本・送信手数料の上限を
 * それぞれの `(network, asset)` のバケットに数える。額 0 の区分（手数料の無いレール）は書かない。
 */
export interface DynamicReservation {
  readonly legs: readonly BucketAmount[];
}

function bucketKey(network: string, asset: string): string {
  return `${network}\u0000${asset}`;
}

/**
 * 10 進の非負整数文字列だけを金額として受け取る。負値・指数表記・小数・空文字は
 * 予約を減らし得るので受け付けない（fail closed）。
 */
function parseAmount(value: string): bigint | undefined {
  if (!/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const amount = BigInt(value);
  return amount > 0n ? amount : undefined;
}

/** 予約行の追記先。journal への書き込みは store に一本化する。 */
export type AppendReservation = (
  paymentId: string,
  event: string,
  patch: Readonly<Record<string, unknown>>,
) => Promise<void>;

export class Budget {
  readonly #limits: BudgetLimits;
  readonly #append: AppendReservation;
  readonly #spent = new Map<string, bigint>();
  #purchases = 0;
  /** 予約は単一 mutex 下で「検査 → 予約行 append+fsync」を不可分に行う。 */
  #queue: Promise<void> = Promise.resolve();

  private constructor(limits: BudgetLimits, append: AppendReservation) {
    this.#limits = limits;
    this.#append = append;
  }

  /**
   * **動的購入の予算**を journal から復元する。数えるのは `created` 行のうち `dynamic.reservation` を持つものだけ
   * （静的の `budget_reserved` は数えない。逆に静的の `load` は `created` を数えない。互いに干渉しない）。
   *
   * 予約と昇格は 1 行なので、「予約はあるが intent が無い」状態が journal に存在しない。
   * 形の壊れた区分は無視せず**その購入を 1 件として数える**（額は読めた分だけ）。枠を復活させる側には倒さない。
   */
  static loadDynamic(limits: BudgetLimits, journal: Journal): Budget {
    const budget = new Budget(limits, async () => {
      throw new Error("the dynamic budget does not append reservation rows; use promote()");
    });
    for (const record of journal.records) {
      if (record.event !== "created") {
        continue;
      }
      const dynamic = record.patch["dynamic"];
      if (typeof dynamic !== "object" || dynamic === null) {
        continue;
      }
      const reservation = (dynamic as Record<string, unknown>)["reservation"];
      if (typeof reservation !== "object" || reservation === null) {
        continue;
      }
      budget.#purchases += 1;
      const legs = (reservation as Record<string, unknown>)["legs"];
      for (const entry of Array.isArray(legs) ? legs : []) {
        if (typeof entry !== "object" || entry === null) {
          continue;
        }
        const { network, asset, amount } = entry as Record<string, unknown>;
        if (typeof network !== "string" || typeof asset !== "string" || typeof amount !== "string") {
          continue;
        }
        const parsed = parseAmount(amount);
        if (parsed !== undefined) {
          budget.#add(network, asset, parsed);
        }
      }
    }
    return budget;
  }

  /**
   * **昇格**: 残枠の検査と、journal への 1 行（`write`）を同じ mutex の中で行う。
   * 検査が通らなければ `write` を呼ばない（1 バイトも書かない）。`write` が失敗したら数を進めない。
   * 並行する 2 件で枠が 1 つなら、片方だけが書く。
   */
  promote(reservation: DynamicReservation, write: () => Promise<void>): Promise<ReservationResult> {
    const promoted = this.#queue.then(() => this.#promoteLocked(reservation, write));
    this.#queue = promoted.then(
      () => undefined,
      () => undefined,
    );
    return promoted;
  }

  async #promoteLocked(reservation: DynamicReservation, write: () => Promise<void>): Promise<ReservationResult> {
    const checked = this.#check(reservation.legs);
    if (!checked.ok) {
      return checked;
    }
    await write();
    this.#purchases += 1;
    for (const entry of checked.requested.values()) {
      this.#add(entry.network, entry.asset, entry.amount);
    }
    return { ok: true };
  }

  /** 残枠の検査だけ（状態を変えない）。同じバケットに落ちる区分は合算する。 */
  #check(
    legs: readonly BucketAmount[],
  ): { readonly ok: true; readonly requested: Map<string, { network: string; asset: string; amount: bigint }> } | { readonly ok: false; readonly reason: string } {
    if (this.#purchases + 1 > this.#limits.maxPurchases) {
      return { ok: false, reason: "purchase_count_limit" };
    }
    const requested = new Map<string, { network: string; asset: string; amount: bigint }>();
    for (const side of legs) {
      const amount = parseAmount(side.amount);
      if (amount === undefined) {
        return { ok: false, reason: "invalid_amount" };
      }
      const key = bucketKey(side.network, side.asset);
      const current = requested.get(key);
      requested.set(key, { network: side.network, asset: side.asset, amount: (current?.amount ?? 0n) + amount });
    }
    if (requested.size === 0) {
      return { ok: false, reason: "invalid_amount" };
    }
    for (const [key, entry] of requested) {
      const bucket = this.#bucketFor(entry.network, entry.asset);
      if (bucket === undefined) {
        return { ok: false, reason: "bucket_not_allowed" };
      }
      const perPurchase = parseAmount(bucket.maxPerPurchase);
      const maxTotal = parseAmount(bucket.maxTotal);
      if (perPurchase === undefined || maxTotal === undefined) {
        return { ok: false, reason: "invalid_budget_limit" };
      }
      if (entry.amount > perPurchase) {
        return { ok: false, reason: "per_purchase_limit" };
      }
      if ((this.#spent.get(key) ?? 0n) + entry.amount > maxTotal) {
        return { ok: false, reason: "bucket_limit" };
      }
    }
    return { ok: true, requested };
  }

  static load(limits: BudgetLimits, journal: Journal, append: AppendReservation): Budget {
    const budget = new Budget(limits, append);
    for (const record of journal.records) {
      if (record.event !== "budget_reserved") {
        continue;
      }
      budget.#purchases += 1;
      for (const side of ["source", "destination"] as const) {
        const entry = record.patch[side];
        if (typeof entry !== "object" || entry === null) {
          continue;
        }
        const { network, asset, amount } = entry as Record<string, unknown>;
        if (typeof network !== "string" || typeof asset !== "string" || typeof amount !== "string") {
          continue;
        }
        const parsed = parseAmount(amount);
        if (parsed !== undefined) {
          budget.#add(network, asset, parsed);
        }
      }
    }
    return budget;
  }

  #add(network: string, asset: string, amount: bigint): void {
    const key = bucketKey(network, asset);
    this.#spent.set(key, (this.#spent.get(key) ?? 0n) + amount);
  }

  #bucketFor(network: string, asset: string) {
    return this.#limits.buckets.find(
      (candidate) => candidate.network === network && candidate.asset === asset,
    );
  }

  reserve(request: ReservationRequest): Promise<ReservationResult> {
    const reserved = this.#queue.then(() => this.#reserveLocked(request));
    this.#queue = reserved.then(
      () => undefined,
      () => undefined,
    );
    return reserved;
  }

  async #reserveLocked(request: ReservationRequest): Promise<ReservationResult> {
    if (this.#purchases + 1 > this.#limits.maxPurchases) {
      return { ok: false, reason: "purchase_count_limit" };
    }

    // 同一 `(network, asset)` に落ちる受信・送信は合算して 1 バケットとして検査する。
    const requested = new Map<string, { network: string; asset: string; amount: bigint }>();
    for (const side of [request.source, request.destination]) {
      const amount = parseAmount(side.amount);
      if (amount === undefined) {
        return { ok: false, reason: "invalid_amount" };
      }
      const key = bucketKey(side.network, side.asset);
      const current = requested.get(key);
      requested.set(key, {
        network: side.network,
        asset: side.asset,
        amount: (current?.amount ?? 0n) + amount,
      });
    }

    for (const [key, entry] of requested) {
      const bucket = this.#bucketFor(entry.network, entry.asset);
      if (bucket === undefined) {
        return { ok: false, reason: "bucket_not_allowed" };
      }
      const perPurchase = parseAmount(bucket.maxPerPurchase);
      const maxTotal = parseAmount(bucket.maxTotal);
      if (perPurchase === undefined || maxTotal === undefined) {
        return { ok: false, reason: "invalid_budget_limit" };
      }
      if (entry.amount > perPurchase) {
        return { ok: false, reason: "per_purchase_limit" };
      }
      if ((this.#spent.get(key) ?? 0n) + entry.amount > maxTotal) {
        return { ok: false, reason: "bucket_limit" };
      }
    }

    // 検査が通った時点で予約行を append + fsync し、それからカウンタを進める。
    await this.#append(request.paymentId, "budget_reserved", {
      source: { ...request.source },
      destination: { ...request.destination },
    });

    this.#purchases += 1;
    for (const entry of requested.values()) {
      this.#add(entry.network, entry.asset, entry.amount);
    }
    return { ok: true };
  }

  get purchases(): number {
    return this.#purchases;
  }

  spentOf(network: string, asset: string): string {
    return (this.#spent.get(bucketKey(network, asset)) ?? 0n).toString();
  }
}
