/**
 * 要求ごとの 1 つの期限（`docs/provider-x402-workers.md` §2.2）。各段の HTTP の期限は「段の上限」と「残り」の小さい方で、
 * **AbortSignal として配る**（待つのをやめるだけでなく、署名の後の送出・本文の読取も止める）。settle の前に残りが
 * `MIN_REMAINING_BEFORE_SETTLE_MS` 未満なら settle を呼ばない（送出前なので資金は動かない）。
 */
export const REQUEST_DEADLINE_MS = 26_000;
export const INIT_TIMEOUT_MS = 5_000;
export const DATA_TIMEOUT_MS = 2_000;
export const VERIFY_TIMEOUT_MS = 4_000;
export const SETTLE_TIMEOUT_MS = 20_000;
export const MIN_REMAINING_BEFORE_SETTLE_MS = 12_000;

export class DeadlineError extends Error {
  constructor() {
    super("deadline");
    this.name = "DeadlineError";
  }
}

export class RequestDeadline {
  readonly #endsAt: number;
  readonly #now: () => number;
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;

  constructor(now: () => number = Date.now, totalMs: number = REQUEST_DEADLINE_MS) {
    this.#now = now;
    this.#endsAt = now() + totalMs;
    // 実時間の timer（試験の時計を進めても、実際の fetch は実時間で切れる）。
    this.#timer = setTimeout(() => this.#controller.abort(new DeadlineError()), totalMs);
  }

  /** 要求全体の signal。 */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  remainingMs(): number {
    return Math.max(0, this.#endsAt - this.#now());
  }

  expired(): boolean {
    return this.#controller.signal.aborted || this.remainingMs() <= 0;
  }

  /** 段の上限と残りの小さい方（0 なら呼び出し側が段を諦める）。 */
  budgetFor(stageMaxMs: number): number {
    return Math.max(0, Math.min(stageMaxMs, this.remainingMs()));
  }

  /** 段の signal: 要求全体の abort と、段の予算の timeout のどちらか早い方。予算 0 なら即 abort。 */
  stageSignal(stageMaxMs: number): AbortSignal {
    const budget = this.budgetFor(stageMaxMs);
    if (budget <= 0) return AbortSignal.abort(new DeadlineError());
    return AbortSignal.any([this.#controller.signal, AbortSignal.timeout(budget)]);
  }

  canSettle(): boolean {
    return !this.expired() && this.remainingMs() >= MIN_REMAINING_BEFORE_SETTLE_MS;
  }

  /** 要求の終わりに timer を外す（abort は呼ばない: 既に送った応答に影響しない）。 */
  release(): void {
    clearTimeout(this.#timer);
  }
}

/** signal つきの await: signal が切れたら reject し、仕事の結果を捨てる（仕事そのものの中断は signal を受けた側が行う）。 */
export function withSignal<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new DeadlineError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DeadlineError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(new DeadlineError());
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
