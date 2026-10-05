/**
 * 動的上流 URL の門（設計 `docs/dynamic-upstream-design.md` §7.3、タスク T4）。
 * 時計を注入する純粋な状態機械。外部には出ない。
 */

import { beforeEach, expect, test } from "vitest";

import { DEFAULT_DYNAMIC_LIMITS, type DynamicLimits } from "../../src/config.js";
import { DynamicGate, type GateLease, type GateResult } from "../../src/core/dynamic-gate.js";

let clock: number;

beforeEach(() => {
  clock = 1_700_000_000_000 - (1_700_000_000_000 % 60_000); // 窓の先頭
});

/** 見たい 1 つの上限だけを小さくし、他は当たらない大きさにする。 */
function gateWith(overrides: Partial<DynamicLimits>, maxKeys?: number): DynamicGate {
  const wide: DynamicLimits = {
    ...DEFAULT_DYNAMIC_LIMITS,
    quotesPerMinuteGlobal: 1000,
    quotesPerMinutePerSource: 1000,
    purchasesPerMinuteGlobal: 1000,
    purchasesPerMinutePerSource: 1000,
    concurrentGlobal: 1000,
    concurrentPerSource: 1000,
    maxOutstandingQuotes: 1000,
    perHostPerMinute: 1000,
    perHostConcurrent: 1000,
    perAddressPerMinute: 1000,
    perAddressConcurrent: 1000,
  };
  return new DynamicGate({ limits: { ...wide, ...overrides }, now: () => clock, ...(maxKeys === undefined ? {} : { maxKeys }) });
}

function leaseOf(result: GateResult): GateLease {
  if (!result.ok) throw new Error(`expected admission, got ${result.reason}`);
  return result.lease;
}

/** 取得してすぐ返す（頻度だけを消費する）。 */
function pass(result: GateResult): void {
  leaseOf(result).release();
}

test("quote の頻度: 全体の上限で止まり、窓が替わると回復する", () => {
  const gate = gateWith({ quotesPerMinuteGlobal: 2 });
  pass(gate.admitQuote("a", 0));
  pass(gate.admitQuote("b", 0));
  expect(gate.admitQuote("c", 0)).toEqual({ ok: false, reason: "rate_global" });
  clock += 59_999;
  expect(gate.admitQuote("c", 0)).toEqual({ ok: false, reason: "rate_global" });
  clock += 1;
  pass(gate.admitQuote("c", 0));
});

test("quote の頻度: 送信元ごとの上限は他の送信元を止めない", () => {
  const gate = gateWith({ quotesPerMinutePerSource: 1 });
  pass(gate.admitQuote("a", 0));
  expect(gate.admitQuote("a", 0)).toEqual({ ok: false, reason: "rate_source" });
  pass(gate.admitQuote("b", 0));
  clock += 60_000;
  pass(gate.admitQuote("a", 0));
});

test("purchase の頻度は quote とは別に数える（全体・送信元ごと）", () => {
  const gate = gateWith({ purchasesPerMinuteGlobal: 2, purchasesPerMinutePerSource: 1, quotesPerMinuteGlobal: 1 });
  pass(gate.admitQuote("a", 0));
  expect(gate.admitQuote("b", 0)).toEqual({ ok: false, reason: "rate_global" });
  // quote が上限でも purchase は通る。
  pass(gate.admitPurchase("a"));
  expect(gate.admitPurchase("a")).toEqual({ ok: false, reason: "rate_source" });
  pass(gate.admitPurchase("b"));
  expect(gate.admitPurchase("c")).toEqual({ ok: false, reason: "rate_global" });
});

test("同時実行: 全体の上限は quote と purchase で共有し、返すと空く", () => {
  const gate = gateWith({ concurrentGlobal: 2 });
  const first = leaseOf(gate.admitQuote("a", 0));
  const second = leaseOf(gate.admitPurchase("b"));
  expect(gate.admitQuote("c", 0)).toEqual({ ok: false, reason: "concurrency_global" });
  expect(gate.admitPurchase("c")).toEqual({ ok: false, reason: "concurrency_global" });
  first.release();
  const third = leaseOf(gate.admitPurchase("c"));
  second.release();
  third.release();
  expect(gate.snapshot().activeGlobal).toBe(0);
});

test("同時実行: 送信元ごとの上限は quote と purchase で共有する", () => {
  const gate = gateWith({ concurrentPerSource: 1 });
  const held = leaseOf(gate.admitPurchase("a"));
  expect(gate.admitQuote("a", 0)).toEqual({ ok: false, reason: "concurrency_source" });
  expect(gate.admitPurchase("a")).toEqual({ ok: false, reason: "concurrency_source" });
  pass(gate.admitQuote("b", 0));
  held.release();
  pass(gate.admitQuote("a", 0));
});

test("purchase の枠は 1 回の取得で手順全体を覆い、時間が経っても返すまで保持される", () => {
  const gate = gateWith({ concurrentGlobal: 1 });
  const held = leaseOf(gate.admitPurchase("a"));
  clock += 10 * 60_000; // 窓が何度替わっても同時実行は減らない
  expect(gate.admitPurchase("b")).toEqual({ ok: false, reason: "concurrency_global" });
  expect(gate.activeOfSource("a")).toBe(1);
  held.release();
  expect(gate.activeOfSource("a")).toBe(0);
  pass(gate.admitPurchase("b"));
});

test("release は何度呼んでも 1 回分しか返さない", () => {
  const gate = gateWith({ concurrentGlobal: 2, concurrentPerSource: 2 });
  const first = leaseOf(gate.admitQuote("a", 0));
  const second = leaseOf(gate.admitQuote("a", 0));
  first.release();
  first.release();
  first.release();
  expect(gate.snapshot().activeGlobal).toBe(1);
  expect(gate.activeOfSource("a")).toBe(1);
  second.release();
  expect(gate.snapshot().activeGlobal).toBe(0);
  expect(gate.activeOfSource("a")).toBe(0);
});

test("拒否された判定は何も消費しない", () => {
  // 送信元の同時実行で拒否される要求が、全体の頻度や同時実行を使わないこと。
  const gate = gateWith({ concurrentPerSource: 1, quotesPerMinuteGlobal: 2, concurrentGlobal: 2 });
  const held = leaseOf(gate.admitQuote("a", 0));
  for (let i = 0; i < 5; i += 1) {
    expect(gate.admitQuote("a", 0)).toEqual({ ok: false, reason: "concurrency_source" });
  }
  expect(gate.snapshot().activeGlobal).toBe(1);
  // 全体の頻度は 1 件分しか使っていないので、別の送信元はまだ 1 件通る。
  pass(gate.admitQuote("b", 0));
  expect(gate.admitQuote("c", 0)).toEqual({ ok: false, reason: "rate_global" });
  held.release();
});

test("未払い quote の数が上限なら、他の枠を使わずに拒否する", () => {
  const gate = gateWith({ maxOutstandingQuotes: 3, quotesPerMinuteGlobal: 1 });
  expect(gate.admitQuote("a", 3)).toEqual({ ok: false, reason: "outstanding_quotes" });
  expect(gate.snapshot().activeGlobal).toBe(0);
  // 頻度を使っていないので、空きができれば通る。
  pass(gate.admitQuote("a", 2));
});

test("宛先ホスト名: 頻度と同時実行", () => {
  const rate = gateWith({ perHostPerMinute: 2 });
  pass(rate.admitHost("api.example.com"));
  pass(rate.admitHost("api.example.com"));
  expect(rate.admitHost("api.example.com")).toEqual({ ok: false, reason: "rate_host" });
  pass(rate.admitHost("other.example.com"));
  clock += 60_000;
  pass(rate.admitHost("api.example.com"));

  const concurrency = gateWith({ perHostConcurrent: 1 });
  const held = leaseOf(concurrency.admitHost("api.example.com"));
  expect(concurrency.admitHost("api.example.com")).toEqual({ ok: false, reason: "concurrency_host" });
  held.release();
  pass(concurrency.admitHost("api.example.com"));
});

test("宛先アドレス: 別名でも同じアドレスなら同じ枠を使う", () => {
  // ホスト名が違っても、解決後のアドレスが同じなら 1 つの枠。
  const gate = gateWith({ perAddressPerMinute: 2 });
  pass(gate.admitAddresses(["203.0.113.10"]));
  pass(gate.admitAddresses(["203.0.113.10"]));
  expect(gate.admitAddresses(["203.0.113.10"])).toEqual({ ok: false, reason: "rate_address" });
  pass(gate.admitAddresses(["203.0.113.11"]));
});

test("宛先アドレス: 全アドレスに対して不可分。1 つでも枠が無ければ何も取らない", () => {
  const gate = gateWith({ perAddressConcurrent: 1 });
  const held = leaseOf(gate.admitAddresses(["203.0.113.10"]));
  // 2 つのうち片方が埋まっている。もう片方の枠を取ったまま残してはいけない。
  expect(gate.admitAddresses(["203.0.113.11", "203.0.113.10"])).toEqual({ ok: false, reason: "concurrency_address" });
  expect(gate.activeOfAddress("203.0.113.11")).toBe(0);
  const other = leaseOf(gate.admitAddresses(["203.0.113.11"]));
  held.release();
  other.release();
  // 通ったときは全アドレスの枠を取り、返すと全部空く。
  const both = leaseOf(gate.admitAddresses(["203.0.113.10", "203.0.113.11"]));
  expect(gate.activeOfAddress("203.0.113.10")).toBe(1);
  expect(gate.activeOfAddress("203.0.113.11")).toBe(1);
  both.release();
  expect(gate.activeOfAddress("203.0.113.10")).toBe(0);
  expect(gate.activeOfAddress("203.0.113.11")).toBe(0);
});

test("宛先アドレス: 同じアドレスが重複していても 1 回しか数えない", () => {
  const gate = gateWith({ perAddressPerMinute: 2, perAddressConcurrent: 1 });
  const held = leaseOf(gate.admitAddresses(["203.0.113.10", "203.0.113.10", "203.0.113.10"]));
  expect(gate.activeOfAddress("203.0.113.10")).toBe(1);
  held.release();
  expect(gate.activeOfAddress("203.0.113.10")).toBe(0);
  pass(gate.admitAddresses(["203.0.113.10"]));
  expect(gate.admitAddresses(["203.0.113.10"])).toEqual({ ok: false, reason: "rate_address" });
});

test("キーの数が上限を超えたら、新しいキーは拒否する（緩い枠に落とさない）", () => {
  const gate = gateWith({}, 2);
  const a = leaseOf(gate.admitHost("a.example"));
  const b = leaseOf(gate.admitHost("b.example"));
  expect(gate.admitHost("c.example")).toEqual({ ok: false, reason: "gate_capacity" });
  // 既に覚えているキーは引き続き使える。
  pass(gate.admitHost("a.example"));
  // 同じ窓の中では、使い終わったキーもまだ頻度を覚えているので空かない。
  a.release();
  expect(gate.admitHost("c.example")).toEqual({ ok: false, reason: "gate_capacity" });
  // 窓が替われば、使われていないキーは捨てられて空く。使用中のキーは残る。
  clock += 60_000;
  pass(gate.admitHost("c.example"));
  expect(gate.admitHost("d.example")).toEqual({ ok: false, reason: "gate_capacity" });
  b.release();
});

test("キーの上限は送信元とアドレスにも効く", () => {
  const sources = gateWith({}, 1);
  pass(sources.admitQuote("a", 0));
  expect(sources.admitQuote("b", 0)).toEqual({ ok: false, reason: "gate_capacity" });
  expect(sources.snapshot().activeGlobal).toBe(0);

  const addresses = gateWith({}, 2);
  pass(addresses.admitAddresses(["203.0.113.10"]));
  // 新しいキーが 2 つ要るが、空きは 1 つ。片方だけ覚えることもしない。
  expect(addresses.admitAddresses(["203.0.113.11", "203.0.113.12"])).toEqual({ ok: false, reason: "gate_capacity" });
  expect(addresses.snapshot().addresses).toBe(1);
});

test("キーの上限は窓をまたいでも超えない（掃除で消えた自分のキーを数え直す）", () => {
  // 前の窓の記録が残っている a・b を含む 3 つを、上限 2 の表に要求する。
  // 掃除は a・b を捨てるので、掃除の前に数えた「新しいキーは 1 つ」をそのまま使うと 3 つ入ってしまう。
  const gate = gateWith({}, 2);
  pass(gate.admitAddresses(["203.0.113.1", "203.0.113.2"]));
  for (let round = 0; round < 3; round += 1) {
    clock += 60_000;
    expect(gate.admitAddresses(["203.0.113.1", "203.0.113.2", "203.0.113.3"])).toEqual({ ok: false, reason: "gate_capacity" });
    expect(gate.snapshot().addresses).toBeLessThanOrEqual(2);
    for (const address of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) expect(gate.activeOfAddress(address)).toBe(0);
    // 上限に収まる要求は通る。
    pass(gate.admitAddresses(["203.0.113.1", "203.0.113.2"]));
    expect(gate.snapshot().addresses).toBe(2);
  }
});

test("未払い quote の上限は進行中の quote も数える（空きが 1 つなら並行する 2 件目は通さない）", () => {
  const gate = gateWith({ maxOutstandingQuotes: 3 });
  // 控えに 2 件。空きは 1 つ。
  const first = leaseOf(gate.admitQuote("a", 2));
  expect(gate.snapshot().pendingQuotes).toBe(1);
  expect(gate.admitQuote("b", 2)).toEqual({ ok: false, reason: "outstanding_quotes" });
  // 1 件目が失敗して控えに入らなければ、空きは戻る。
  first.release();
  expect(gate.snapshot().pendingQuotes).toBe(0);
  const second = leaseOf(gate.admitQuote("b", 2));
  // 2 件目が控えに入った（控えは 3 件）。lease を返す前後どちらでも次は通らない。
  expect(gate.admitQuote("c", 3)).toEqual({ ok: false, reason: "outstanding_quotes" });
  second.release();
  second.release();
  expect(gate.snapshot().pendingQuotes).toBe(0);
  expect(gate.admitQuote("c", 3)).toEqual({ ok: false, reason: "outstanding_quotes" });
  // purchase は未払い quote の上限と無関係。
  pass(gate.admitPurchase("c"));
});

test("頻度の回復: purchase とアドレスも窓が替わると回復する", () => {
  const gate = gateWith({ purchasesPerMinuteGlobal: 1, perAddressPerMinute: 1 });
  pass(gate.admitPurchase("a"));
  expect(gate.admitPurchase("b")).toEqual({ ok: false, reason: "rate_global" });
  pass(gate.admitAddresses(["203.0.113.10"]));
  expect(gate.admitAddresses(["203.0.113.10"])).toEqual({ ok: false, reason: "rate_address" });
  clock += 60_000;
  pass(gate.admitPurchase("b"));
  pass(gate.admitAddresses(["203.0.113.10"]));
});

test("窓をまたいで持っていた lease を返しても、取り直した同じキーの数は狂わない", () => {
  const gate = gateWith({ perHostConcurrent: 2, perAddressConcurrent: 2 });
  const oldHost = leaseOf(gate.admitHost("h.example"));
  const oldAddress = leaseOf(gate.admitAddresses(["203.0.113.10"]));
  clock += 5 * 60_000;
  const newHost = leaseOf(gate.admitHost("h.example"));
  const newAddress = leaseOf(gate.admitAddresses(["203.0.113.10"]));
  expect(gate.activeOfHost("h.example")).toBe(2);
  expect(gate.activeOfAddress("203.0.113.10")).toBe(2);
  // 古い lease を 2 回返しても、減るのは 1 回分だけ。
  oldHost.release();
  oldHost.release();
  oldAddress.release();
  oldAddress.release();
  expect(gate.activeOfHost("h.example")).toBe(1);
  expect(gate.activeOfAddress("203.0.113.10")).toBe(1);
  newHost.release();
  newAddress.release();
  expect(gate.activeOfHost("h.example")).toBe(0);
  expect(gate.activeOfAddress("203.0.113.10")).toBe(0);
});

test("送信元のキーの上限は quote と purchase のどちらから来ても効き、拒否は何も残さない", () => {
  const gate = gateWith({}, 1);
  const held = leaseOf(gate.admitPurchase("a"));
  expect(gate.admitQuote("b", 0)).toEqual({ ok: false, reason: "gate_capacity" });
  expect(gate.admitPurchase("b")).toEqual({ ok: false, reason: "gate_capacity" });
  expect(gate.snapshot()).toMatchObject({ activeGlobal: 1, pendingQuotes: 0, sources: 1 });
  // 覚えている送信元は quote も通る（表が別でも同じキーなら余地がある）。
  pass(gate.admitQuote("a", 0));
  held.release();
});

test("lease を finally で返せば、成功・失敗・例外のどれでも枠が戻る", async () => {
  const gate = gateWith({ concurrentGlobal: 1 });
  const run = async (body: () => Promise<void>): Promise<void> => {
    const lease = leaseOf(gate.admitPurchase("a"));
    try {
      await body();
    } finally {
      lease.release();
    }
  };
  await run(async () => {});
  expect(gate.snapshot().activeGlobal).toBe(0);
  await expect(run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(gate.snapshot().activeGlobal).toBe(0);
  await run(async () => { await Promise.reject(new Error("handled")).catch(() => {}); });
  expect(gate.snapshot().activeGlobal).toBe(0);
  expect(gate.activeOfSource("a")).toBe(0);
});

test("既定の上限でも、返し忘れが無ければ数は 0 に戻る", () => {
  const gate = new DynamicGate({ limits: DEFAULT_DYNAMIC_LIMITS, now: () => clock });
  const leases: GateLease[] = [];
  for (let i = 0; i < 20; i += 1) {
    for (const result of [gate.admitQuote(`s${i % 4}`, 0), gate.admitPurchase(`s${i % 4}`), gate.admitHost("h.example"), gate.admitAddresses(["203.0.113.10"])]) {
      if (result.ok) leases.push(result.lease);
    }
    clock += 7_000;
  }
  expect(leases.length).toBeGreaterThan(0);
  for (const lease of leases) lease.release();
  expect(gate.snapshot().activeGlobal).toBe(0);
  for (let i = 0; i < 4; i += 1) expect(gate.activeOfSource(`s${i}`)).toBe(0);
  expect(gate.activeOfHost("h.example")).toBe(0);
  expect(gate.activeOfAddress("203.0.113.10")).toBe(0);
});
