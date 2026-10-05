/**
 * 動的上流 URL の門（設計 `docs/dynamic-upstream-design.md` §7.3）。
 *
 * 匿名の相手が**払わずに**起こせる仕事を有界にする。判定は外部接続の**前**に行い、待ち行列は持たない
 * （超過は即拒否）。状態はプロセス内だけで、再起動で消える。
 *
 * - **頻度**は 1 分の固定窓。**同時実行**は取得した枠（lease）を返すまで数える
 * - 1 回の判定は**全部通るか、何も取らないか**（途中まで取った枠を残さない）
 * - 覚えておくキー（送信元・ホスト名・アドレス）の数に上限があり、**超えたら新しいキーは拒否する**
 *   （緩い共通の枠に落とすと、キーを増やすだけで宛先ごとの上限を迂回できてしまう）
 */

import type { DynamicLimits } from "../config.js";

export type GateRejection =
  | "rate_global"
  | "rate_source"
  | "concurrency_global"
  | "concurrency_source"
  | "outstanding_quotes"
  | "rate_host"
  | "concurrency_host"
  | "rate_address"
  | "concurrency_address"
  | "gate_capacity";

/** 取得した枠。`release` は何度呼んでも 1 回分しか返さない。 */
export interface GateLease {
  release(): void;
}

export type GateResult =
  | { readonly ok: true; readonly lease: GateLease }
  | { readonly ok: false; readonly reason: GateRejection };

export interface DynamicGateOptions {
  readonly limits: DynamicLimits;
  /** ミリ秒の時計（試験で注入する）。 */
  readonly now?: () => number;
  /** 種類ごとに覚えておくキーの上限。 */
  readonly maxKeys?: number;
}

const WINDOW_MS = 60_000;

interface Counter {
  window: number;
  count: number;
  active: number;
}

/** キーごとの頻度と同時実行。古い窓で使われていないキーは捨てる。 */
class KeyedCounters {
  readonly #entries = new Map<string, Counter>();
  readonly #maxKeys: number;

  constructor(maxKeys: number) {
    this.#maxKeys = maxKeys;
  }

  #sweep(window: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.window !== window && entry.active === 0) {
        this.#entries.delete(key);
      }
    }
  }

  /** 判定だけ（状態を変えない）。新しいキーが入る余地が無ければ `gate_capacity`。 */
  check(
    keys: readonly string[],
    window: number,
    perMinute: number,
    concurrent: number,
    rateReason: GateRejection,
    concurrencyReason: GateRejection,
  ): GateRejection | undefined {
    let fresh = 0;
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (entry === undefined) {
        fresh += 1;
        continue;
      }
      const count = entry.window === window ? entry.count : 0;
      if (count + 1 > perMinute) return rateReason;
      if (entry.active + 1 > concurrent) return concurrencyReason;
    }
    if (fresh > 0 && this.#entries.size + fresh > this.#maxKeys) {
      this.#sweep(window);
      if (this.#entries.size + fresh > this.#maxKeys) return "gate_capacity";
    }
    return undefined;
  }

  take(keys: readonly string[], window: number): void {
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (entry === undefined) {
        this.#entries.set(key, { window, count: 1, active: 1 });
      } else {
        if (entry.window !== window) {
          entry.window = window;
          entry.count = 0;
        }
        entry.count += 1;
        entry.active += 1;
      }
    }
  }

  give(keys: readonly string[]): void {
    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (entry !== undefined && entry.active > 0) {
        entry.active -= 1;
      }
    }
  }

  activeOf(key: string): number {
    return this.#entries.get(key)?.active ?? 0;
  }

  get size(): number {
    return this.#entries.size;
  }
}

function leaseOf(release: () => void): GateLease {
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      release();
    },
  };
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class DynamicGate {
  readonly #limits: DynamicLimits;
  readonly #now: () => number;
  /** 動的操作（quote・purchase）の同時実行。全体と送信元ごと。 */
  #activeGlobal = 0;
  readonly #sourceActive: KeyedCounters;
  readonly #quoteGlobal: Counter = { window: -1, count: 0, active: 0 };
  readonly #purchaseGlobal: Counter = { window: -1, count: 0, active: 0 };
  readonly #quoteBySource: KeyedCounters;
  readonly #purchaseBySource: KeyedCounters;
  readonly #hosts: KeyedCounters;
  readonly #addresses: KeyedCounters;

  constructor(options: DynamicGateOptions) {
    this.#limits = options.limits;
    this.#now = options.now ?? (() => Date.now());
    const maxKeys = options.maxKeys ?? 10_000;
    this.#sourceActive = new KeyedCounters(maxKeys);
    this.#quoteBySource = new KeyedCounters(maxKeys);
    this.#purchaseBySource = new KeyedCounters(maxKeys);
    this.#hosts = new KeyedCounters(maxKeys);
    this.#addresses = new KeyedCounters(maxKeys);
  }

  #window(): number {
    return Math.floor(this.#now() / WINDOW_MS);
  }

  #operation(
    source: string,
    global: Counter,
    bySource: KeyedCounters,
    perMinuteGlobal: number,
    perMinuteSource: number,
  ): GateResult {
    const window = this.#window();
    const globalCount = global.window === window ? global.count : 0;
    if (globalCount + 1 > perMinuteGlobal) return { ok: false, reason: "rate_global" };
    if (this.#activeGlobal + 1 > this.#limits.concurrentGlobal) return { ok: false, reason: "concurrency_global" };
    // 頻度は `bySource`、同時実行は quote・purchase 共通の `#sourceActive` で数える。
    const rate = bySource.check([source], window, perMinuteSource, Number.MAX_SAFE_INTEGER, "rate_source", "concurrency_source");
    if (rate !== undefined) return { ok: false, reason: rate };
    const concurrency = this.#sourceActive.check(
      [source],
      window,
      Number.MAX_SAFE_INTEGER,
      this.#limits.concurrentPerSource,
      "rate_source",
      "concurrency_source",
    );
    if (concurrency !== undefined) return { ok: false, reason: concurrency };

    // ここから先は失敗しない（全部通った後にだけ状態を変える）。
    if (global.window !== window) {
      global.window = window;
      global.count = 0;
    }
    global.count += 1;
    this.#activeGlobal += 1;
    bySource.take([source], window);
    bySource.give([source]); // 頻度だけを数え、同時実行は `#sourceActive` に持たせる
    this.#sourceActive.take([source], window);
    return {
      ok: true,
      lease: leaseOf(() => {
        this.#activeGlobal -= 1;
        this.#sourceActive.give([source]);
      }),
    };
  }

  /**
   * 動的 quote を 1 件始める。`outstandingQuotes` は期限内の未払い quote の現在数（控えが持つ）。
   * 返った lease は quote の処理が終わったら（成功・失敗・例外のどれでも）1 回返す。
   */
  admitQuote(source: string, outstandingQuotes: number): GateResult {
    if (outstandingQuotes + 1 > this.#limits.maxOutstandingQuotes) {
      return { ok: false, reason: "outstanding_quotes" };
    }
    return this.#operation(
      source,
      this.#quoteGlobal,
      this.#quoteBySource,
      this.#limits.quotesPerMinuteGlobal,
      this.#limits.quotesPerMinutePerSource,
    );
  }

  /**
   * 動的 purchase の試行を 1 件始める。lease は**手順の全体**（preflight から settle・送信まで）を覆い、
   * 終了時に 1 回返す。
   */
  admitPurchase(source: string): GateResult {
    return this.#operation(
      source,
      this.#purchaseGlobal,
      this.#purchaseBySource,
      this.#limits.purchasesPerMinuteGlobal,
      this.#limits.purchasesPerMinutePerSource,
    );
  }

  /** 宛先ホスト名の枠（名前解決の前に取る）。 */
  admitHost(host: string): GateResult {
    const window = this.#window();
    const reason = this.#hosts.check(
      [host],
      window,
      this.#limits.perHostPerMinute,
      this.#limits.perHostConcurrent,
      "rate_host",
      "concurrency_host",
    );
    if (reason !== undefined) return { ok: false, reason };
    this.#hosts.take([host], window);
    return { ok: true, lease: leaseOf(() => this.#hosts.give([host])) };
  }

  /**
   * 検査済みアドレスの枠（接続の前に取る）。**重複を除いた全アドレス**が枠内のときだけ通し、
   * 1 つでも枠が無ければ何も取らない。どのアドレスに接続するかは HTTP クライアントが決めるので、
   * 候補の全部を数える。別名を増やしても同じアドレスなら同じ枠を使う。
   */
  admitAddresses(addresses: readonly string[]): GateResult {
    const keys = distinct(addresses);
    const window = this.#window();
    const reason = this.#addresses.check(
      keys,
      window,
      this.#limits.perAddressPerMinute,
      this.#limits.perAddressConcurrent,
      "rate_address",
      "concurrency_address",
    );
    if (reason !== undefined) return { ok: false, reason };
    this.#addresses.take(keys, window);
    return { ok: true, lease: leaseOf(() => this.#addresses.give(keys)) };
  }

  /** 試験と診断用: 現在の同時実行数と、覚えているキーの数。 */
  snapshot(): {
    readonly activeGlobal: number;
    readonly sources: number;
    readonly hosts: number;
    readonly addresses: number;
  } {
    return {
      activeGlobal: this.#activeGlobal,
      sources: this.#sourceActive.size,
      hosts: this.#hosts.size,
      addresses: this.#addresses.size,
    };
  }

  activeOfSource(source: string): number {
    return this.#sourceActive.activeOf(source);
  }

  activeOfAddress(address: string): number {
    return this.#addresses.activeOf(address);
  }

  activeOfHost(host: string): number {
    return this.#hosts.activeOf(host);
  }
}
