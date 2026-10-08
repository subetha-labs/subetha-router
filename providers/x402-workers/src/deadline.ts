/**
 * 要求ごとの 1 つの期限（`docs/provider-x402-workers.md` §2.2）。各段の HTTP の期限は「段の上限」と「残り」の小さい方。
 * settle の前に残りが `MIN_REMAINING_BEFORE_SETTLE_MS` 未満なら settle を呼ばない（送出前なので資金は動かない）。
 */
export const REQUEST_DEADLINE_MS = 26_000;
export const INIT_TIMEOUT_MS = 5_000;
export const DATA_TIMEOUT_MS = 2_000;
export const VERIFY_TIMEOUT_MS = 4_000;
export const SETTLE_TIMEOUT_MS = 20_000;
export const MIN_REMAINING_BEFORE_SETTLE_MS = 12_000;

export class RequestDeadline {
  readonly #endsAt: number;
  readonly #now: () => number;

  constructor(now: () => number = Date.now, totalMs: number = REQUEST_DEADLINE_MS) {
    this.#now = now;
    this.#endsAt = now() + totalMs;
  }

  remainingMs(): number {
    return Math.max(0, this.#endsAt - this.#now());
  }

  /** 段の上限と残りの小さい方（0 なら呼び出し側が段を諦める）。 */
  budgetFor(stageMaxMs: number): number {
    return Math.max(0, Math.min(stageMaxMs, this.remainingMs()));
  }

  canSettle(): boolean {
    return this.remainingMs() >= MIN_REMAINING_BEFORE_SETTLE_MS;
  }
}

/** 期限つきの await（段の予算。0 以下なら即 reject）。 */
export async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  if (ms <= 0) throw new Error("deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline")), ms);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
