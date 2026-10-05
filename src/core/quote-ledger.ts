/**
 * 未払いの動的 quote の控え（設計 `docs/dynamic-upstream-design.md` §6.1〜§6.3）。
 *
 * 動的 quote は、予算が通って購入を実行する段になるまで journal に書かない（払わない相手に journal を
 * 増やさせないため）。それまでの間、quote を**耐久性のある形で**持つのがこの控え。
 *
 * - `<dir>/<UTC 日付>.ndjson` に append + fsync。行は `quote` と `attempt` の 2 種類
 * - メモリに載せるのは**期限内の quote だけ**。quote の寿命は 24 時間以内に限るので、起動時に読むのは
 *   **当日と前日のファイルだけ**（それより古いファイルに期限内の quote は無い）。行ごとに読み、ファイル全体は持たない
 * - 保持期間（日数）より古いファイルは、起動時と日付の切り替わりに削除する
 * - 1 行の大きさに上限がある（`quote` は 8 KiB、`attempt` は 512 バイト）。超える quote は成立させない
 *
 * 控えは**権威ではない**: 昇格した quote は journal の記録が正で、控えの行は無視する（`isPromoted`）。
 * ここにあるのは「まだ Router が何もしていない quote」だけなので、行を失っても Router の資金は動かない。
 * だから読めない行は起動を止めずに飛ばす（journal は破損で起動を止める。扱いが違うのはこのため）。
 * 飛ばした行の数は `skipped` に出す。
 *
 * 書き手は Router プロセス 1 つ（journal のロックと同じ directory。別のロックは持たない）。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export const MAX_QUOTE_LINE_BYTES = 8 * 1024;
export const MAX_ATTEMPT_LINE_BYTES = 512;

const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;
const DAY_MS = 86_400_000;
/** quote の寿命の上限。これがあるから、起動時に読むのは当日と前日のファイルで足りる。 */
export const MAX_QUOTE_LIFETIME_MS = DAY_MS;

/** 控えに置く quote。`record` は昇格のときに journal の `created` 行になる中身（予約を除く）。 */
export interface LedgerQuote {
  readonly quoteId: string;
  readonly paymentId: string;
  readonly principalId: string;
  readonly requestId: string;
  /** 承認の絶対期限（ミリ秒）。これを過ぎた quote はメモリから落とす。 */
  readonly deadlineMs: number;
  readonly record: Readonly<Record<string, unknown>>;
}

/** 「この quote に credential が提出された」事実（最初の 1 回だけ）。credential そのものは持たない。 */
export interface LedgerAttempt {
  readonly quoteId: string;
  readonly at: string;
  /** 提出された credential の要約（`sha256:<hex>`）。 */
  readonly credentialDigest: string;
}

export class LedgerRecordTooLargeError extends Error {
  readonly code = "ledger_record_too_large";

  constructor(bytes: number, limit: number) {
    super(`quote ledger record is ${bytes} bytes (limit ${limit})`);
    this.name = "LedgerRecordTooLargeError";
  }
}

export class LedgerLifetimeError extends Error {
  readonly code = "ledger_lifetime";

  constructor() {
    super("quote ledger refuses a quote that is already expired or lives longer than 24 hours");
    this.name = "LedgerLifetimeError";
  }
}

export class LedgerDuplicateError extends Error {
  readonly code = "ledger_duplicate";

  constructor() {
    super("quote ledger already holds this quote, payment or request");
    this.name = "LedgerDuplicateError";
  }
}

export interface OpenQuoteLedgerOptions {
  readonly dir: string;
  /** ミリ秒の時計（試験で注入する）。 */
  readonly now?: () => number;
  /** 保持する日数（当日を含めて、これより古い日付のファイルを削除する）。 */
  readonly retentionDays: number;
  /** journal に昇格済みの quote か。昇格済みの行は読み飛ばす（journal が正）。 */
  readonly isPromoted?: (quoteId: string) => boolean;
}

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function requestKey(principalId: string, requestId: string): string {
  return `${principalId}\u0000${requestId}`;
}

/** credential の要約。控えとログには要約だけを残す。 */
export function credentialDigestOf(credential: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(credential) ?? "", "utf8").digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteOf(line: Record<string, unknown>): LedgerQuote | undefined {
  const { quoteId, paymentId, principalId, requestId, deadlineMs, record } = line;
  if (
    typeof quoteId !== "string" ||
    quoteId === "" ||
    typeof paymentId !== "string" ||
    paymentId === "" ||
    typeof principalId !== "string" ||
    typeof requestId !== "string" ||
    typeof deadlineMs !== "number" ||
    !Number.isFinite(deadlineMs) ||
    !isRecord(record)
  ) {
    return undefined;
  }
  return { quoteId, paymentId, principalId, requestId, deadlineMs, record };
}

export class QuoteLedger {
  readonly #dir: string;
  readonly #now: () => number;
  readonly #retentionDays: number;
  readonly #quotes = new Map<string, LedgerQuote>();
  readonly #byPayment = new Map<string, string>();
  readonly #byRequest = new Map<string, string>();
  readonly #attempts = new Map<string, LedgerAttempt>();
  #handle: FileHandle | undefined;
  #handleDate = "";
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #skipped = 0;
  #linesRead = 0;
  #loaded = 0;

  private constructor(options: OpenQuoteLedgerOptions) {
    this.#dir = options.dir;
    this.#now = options.now ?? (() => Date.now());
    this.#retentionDays = options.retentionDays;
  }

  static async open(options: OpenQuoteLedgerOptions): Promise<QuoteLedger> {
    if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1) {
      throw new Error("quote ledger retentionDays must be a positive integer");
    }
    const ledger = new QuoteLedger(options);
    await mkdir(options.dir, { recursive: true });
    await ledger.#prune();
    await ledger.#load(options.isPromoted ?? (() => false));
    return ledger;
  }

  /** 保持期間内の日付か。 */
  #retained(date: string, nowMs: number): boolean {
    const oldest = dateOf(nowMs - (this.#retentionDays - 1) * DAY_MS);
    return date >= oldest;
  }

  async #files(): Promise<string[]> {
    return (await readdir(this.#dir)).filter((name) => FILE_PATTERN.test(name)).sort();
  }

  /** 保持期間より古い日付のファイルを削除する。 */
  async #prune(): Promise<void> {
    const nowMs = this.#now();
    for (const name of await this.#files()) {
      const date = FILE_PATTERN.exec(name)![1]!;
      if (!this.#retained(date, nowMs)) {
        await unlink(path.join(this.#dir, name)).catch(() => {});
      }
    }
  }

  /**
   * **当日と前日のファイル**を行ごとに読み、**期限内で未昇格の quote** と、その quote への attempt だけをメモリに載せる。
   * 読めない行（途中で切れた最後の行、JSON でない行、形の違う行）は飛ばして数える。
   */
  async #load(isPromoted: (quoteId: string) => boolean): Promise<void> {
    const nowMs = this.#now();
    const attempts: LedgerAttempt[] = [];
    const oldest = dateOf(nowMs - MAX_QUOTE_LIFETIME_MS);
    for (const name of await this.#files()) {
      if (FILE_PATTERN.exec(name)![1]! < oldest) continue;
      const lines = createInterface({ input: createReadStream(path.join(this.#dir, name), { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const raw of lines) {
        if (raw === "") continue;
        this.#linesRead += 1;
        let line: unknown;
        try {
          line = JSON.parse(raw);
        } catch {
          this.#skipped += 1;
          continue;
        }
        if (!isRecord(line)) {
          this.#skipped += 1;
          continue;
        }
        if (line["kind"] === "quote") {
          const quote = quoteOf(line);
          if (quote === undefined) {
            this.#skipped += 1;
            continue;
          }
          if (quote.deadlineMs <= nowMs || isPromoted(quote.quoteId)) continue;
          // 同じ識別子の 2 つ目は載せない（最初のものが正）。
          if (this.#collides(quote)) {
            this.#skipped += 1;
            continue;
          }
          this.#index(quote);
        } else if (line["kind"] === "attempt") {
          const { quoteId, at, credentialDigest } = line;
          if (typeof quoteId !== "string" || typeof at !== "string" || typeof credentialDigest !== "string") {
            this.#skipped += 1;
            continue;
          }
          attempts.push({ quoteId, at, credentialDigest });
        } else {
          this.#skipped += 1;
        }
      }
    }
    this.#loaded = this.#quotes.size;
    for (const attempt of attempts) {
      // 最初の 1 行だけ。メモリに無い（期限切れ・昇格済み）quote の attempt は載せない。
      if (this.#quotes.has(attempt.quoteId) && !this.#attempts.has(attempt.quoteId)) {
        this.#attempts.set(attempt.quoteId, attempt);
      }
    }
  }

  #collides(quote: LedgerQuote): boolean {
    return (
      this.#quotes.has(quote.quoteId) ||
      this.#byPayment.has(quote.paymentId) ||
      this.#byRequest.has(requestKey(quote.principalId, quote.requestId))
    );
  }

  #index(quote: LedgerQuote): void {
    this.#quotes.set(quote.quoteId, quote);
    this.#byPayment.set(quote.paymentId, quote.quoteId);
    this.#byRequest.set(requestKey(quote.principalId, quote.requestId), quote.quoteId);
  }

  #drop(quoteId: string): void {
    const quote = this.#quotes.get(quoteId);
    if (quote === undefined) return;
    this.#quotes.delete(quoteId);
    this.#byPayment.delete(quote.paymentId);
    this.#byRequest.delete(requestKey(quote.principalId, quote.requestId));
    this.#attempts.delete(quoteId);
  }

  /** 期限切れの quote をメモリから落とす。 */
  sweep(): void {
    const nowMs = this.#now();
    for (const [quoteId, quote] of this.#quotes) {
      if (quote.deadlineMs <= nowMs) this.#drop(quoteId);
    }
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 当日のファイルに 1 行を append + fsync する。日付が替わっていたらファイルを替え、古いものを削除する。 */
  async #append(line: string): Promise<void> {
    if (this.#closed) throw new Error("quote ledger is closed");
    const date = dateOf(this.#now());
    if (this.#handle === undefined || this.#handleDate !== date) {
      await this.#handle?.close().catch(() => {});
      this.#handle = await open(path.join(this.#dir, `${date}.ndjson`), "a");
      const rolled = this.#handleDate !== "";
      this.#handleDate = date;
      if (rolled) await this.#prune();
    }
    await this.#handle.appendFile(`${line}\n`, "utf8");
    await this.#handle.sync();
  }

  /**
   * quote を控えに書く。書き終えて（fsync 済み）から戻る。
   * 行が上限を超える・識別子が既にある場合は**何も書かずに**拒否する。
   */
  put(quote: LedgerQuote): Promise<void> {
    return this.#serialize(async () => {
      this.sweep();
      const nowMs = this.#now();
      if (!Number.isFinite(quote.deadlineMs) || quote.deadlineMs <= nowMs || quote.deadlineMs - nowMs > MAX_QUOTE_LIFETIME_MS) {
        throw new LedgerLifetimeError();
      }
      if (this.#collides(quote)) throw new LedgerDuplicateError();
      const line = JSON.stringify({ kind: "quote", at: new Date(this.#now()).toISOString(), ...quote });
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (bytes > MAX_QUOTE_LINE_BYTES) throw new LedgerRecordTooLargeError(bytes, MAX_QUOTE_LINE_BYTES);
      await this.#append(line);
      // メモリに載せるのは、書いた行を読み戻した値（呼び出し側の可変オブジェクトではない）。
      this.#index(quoteOf(JSON.parse(line) as Record<string, unknown>)!);
    });
  }

  /**
   * 「credential が提出された」ことを記録する。**その quote で最初の 1 回だけ**書き、`true` を返す。
   * 2 回目以降・控えに無い quote では何も書かずに `false`。
   */
  recordAttempt(quoteId: string, credentialDigest: string): Promise<boolean> {
    return this.#serialize(async () => {
      if (!this.#quotes.has(quoteId) || this.#attempts.has(quoteId)) return false;
      const attempt: LedgerAttempt = { quoteId, at: new Date(this.#now()).toISOString(), credentialDigest };
      const line = JSON.stringify({ kind: "attempt", ...attempt });
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      if (bytes > MAX_ATTEMPT_LINE_BYTES) throw new LedgerRecordTooLargeError(bytes, MAX_ATTEMPT_LINE_BYTES);
      await this.#append(line);
      this.#attempts.set(quoteId, attempt);
      return true;
    });
  }

  /** 期限内の quote。期限切れ・昇格済み・控えに無いものは `undefined`。 */
  get(quoteId: string): LedgerQuote | undefined {
    const quote = this.#quotes.get(quoteId);
    if (quote === undefined) return undefined;
    if (quote.deadlineMs <= this.#now()) {
      this.#drop(quoteId);
      return undefined;
    }
    return quote;
  }

  byPaymentId(paymentId: string): LedgerQuote | undefined {
    const quoteId = this.#byPayment.get(paymentId);
    return quoteId === undefined ? undefined : this.get(quoteId);
  }

  /** `(principal, requestId)` を使っている期限内の quote。 */
  byRequest(principalId: string, requestId: string): LedgerQuote | undefined {
    const quoteId = this.#byRequest.get(requestKey(principalId, requestId));
    return quoteId === undefined ? undefined : this.get(quoteId);
  }

  attemptOf(quoteId: string): LedgerAttempt | undefined {
    return this.#attempts.get(quoteId);
  }

  /** journal に昇格した quote をメモリから外す（ファイルの行は残る。再起動時は `isPromoted` で読み飛ばす）。 */
  markPromoted(quoteId: string): void {
    this.#drop(quoteId);
  }

  /** 期限内の未払い quote の数（門の上限に使う）。 */
  outstanding(): number {
    this.sweep();
    return this.#quotes.size;
  }

  /** 起動時に読んだ行数、読めずに飛ばした行数、メモリに載せた quote の数（診断用）。 */
  get loadStats(): { readonly linesRead: number; readonly skipped: number; readonly loaded: number } {
    return { linesRead: this.#linesRead, skipped: this.#skipped, loaded: this.#loaded };
  }

  async close(): Promise<void> {
    await this.#queue;
    this.#closed = true;
    await this.#handle?.close().catch(() => {});
    this.#handle = undefined;
  }
}
