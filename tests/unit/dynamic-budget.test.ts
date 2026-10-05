/**
 * 動的購入の予算と、intent の動的な欄の復元（設計 `docs/dynamic-upstream-design.md` §2.4・§6.2・§6.4、タスク T5）。
 * 実 journal（一時ファイル）を使う。
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import type { BudgetLimits } from "../../src/config.js";
import { Budget, type DynamicReservation } from "../../src/core/budget.js";
import { openJournal, type Journal } from "../../src/core/journal.js";
import { dynamicFieldsOf, IntentStore } from "../../src/core/store.js";

const USDC = { network: "eip155:84532", asset: "0xusdc" };
const PATHUSD = { network: "eip155:42431", asset: "0xpathusd" };
const HASH = `sha256:${"a".repeat(64)}`;

let workDir: string;
let journalPath: string;
const journals: Journal[] = [];

beforeEach(async () => {
  const root = path.resolve("runtime");
  await mkdir(root, { recursive: true });
  workDir = await mkdtemp(path.join(root, "t5-budget-"));
  journalPath = path.join(workDir, "journal.ndjson");
});

afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
});

async function journalOf(): Promise<Journal> {
  const journal = await openJournal({ journalPath });
  journals.push(journal);
  return journal;
}

function limits(overrides: Partial<BudgetLimits> = {}): BudgetLimits {
  return {
    maxPurchases: 10,
    buckets: [
      { ...USDC, maxTotal: "100000", maxPerPurchase: "30000" },
      { ...PATHUSD, maxTotal: "100000", maxPerPurchase: "30000" },
    ],
    ...overrides,
  };
}

/** 受信 11000（USDC）、送信元本 10000 と手数料上限 5000（pathUSD）。 */
function reservation(source = "11000", principal = "10000", fee = "5000"): DynamicReservation {
  return { legs: [{ ...USDC, amount: source }, { ...PATHUSD, amount: principal }, { ...PATHUSD, amount: fee }] };
}

/** 動的購入の `created` 行（昇格したもの）。 */
function dynamicCreated(n: number, legs: DynamicReservation | undefined): { paymentId: string; event: string; patch: Record<string, unknown> } {
  return {
    paymentId: `pay-${n}`,
    event: "created",
    patch: {
      quoteId: `q-${n}`,
      routeId: "dyn-x402-to-mpp",
      principalId: "judge",
      requestId: `req-${n}`,
      source: { amount: "11000", ...USDC },
      destination: { quoted: "10000", ...PATHUSD },
      quoteFingerprint: "sha256:x",
      approvalDeadlineMs: 1,
      upstream: { url: `https://provider.test/v1/${n}`, method: "GET" },
      dynamic: {
        profileId: "dyn-x402-to-mpp",
        profile: { rail: "mpp" },
        pricing: { upstreamAmount: "10000", converted: "10000", fee: "1000", total: "11000" },
        ownerKeyHash: HASH,
        ...(legs === undefined ? {} : { reservation: legs }),
      },
    },
  };
}

async function bytes(): Promise<number> {
  return (await readFile(journalPath, "utf8").catch(() => "")).length;
}

test("promote: 検査が通れば write を 1 回呼び、3 つの区分を各バケットに数える（手数料は feeAsset のバケット）", async () => {
  const journal = await journalOf();
  const budget = Budget.loadDynamic(limits(), journal);
  let writes = 0;
  const result = await budget.promote(reservation(), async () => {
    writes += 1;
    await journal.append(dynamicCreated(1, reservation()));
  });
  expect(result).toEqual({ ok: true });
  expect(writes).toBe(1);
  expect(budget.purchases).toBe(1);
  expect(budget.spentOf(USDC.network, USDC.asset)).toBe("11000");
  // 送信元本 10000 と手数料上限 5000 は同じバケットで合算。
  expect(budget.spentOf(PATHUSD.network, PATHUSD.asset)).toBe("15000");
});

test("promote: 検査が通らなければ write を呼ばず、1 バイトも書かず、数も進まない", async () => {
  const journal = await journalOf();
  const cases: Array<[string, BudgetLimits, DynamicReservation]> = [
    ["purchase_count_limit", limits({ maxPurchases: 0 }), reservation()],
    // 元本 20000 ＋ 手数料 15000 = 35000 > 1 件上限 30000（単独ではどちらも上限内）。
    ["per_purchase_limit", limits(), reservation("11000", "20000", "15000")],
    ["bucket_limit", limits({ buckets: [{ ...USDC, maxTotal: "10999", maxPerPurchase: "30000" }, { ...PATHUSD, maxTotal: "100000", maxPerPurchase: "30000" }] }), reservation()],
    ["bucket_not_allowed", limits({ buckets: [{ ...USDC, maxTotal: "100000", maxPerPurchase: "30000" }] }), reservation()],
    ["invalid_amount", limits(), reservation("-1")],
    ["invalid_amount", limits(), reservation("1e3")],
    ["invalid_amount", limits(), { legs: [] }],
    ["invalid_budget_limit", limits({ buckets: [{ ...USDC, maxTotal: "abc", maxPerPurchase: "30000" }, { ...PATHUSD, maxTotal: "100000", maxPerPurchase: "30000" }] }), reservation()],
  ];
  for (const [reason, config, request] of cases) {
    const budget = Budget.loadDynamic(config, journal);
    let writes = 0;
    const result = await budget.promote(request, async () => {
      writes += 1;
    });
    expect(result, reason).toEqual({ ok: false, reason });
    expect(writes, reason).toBe(0);
    expect(budget.purchases, reason).toBe(0);
  }
  expect(await bytes()).toBe(0);
});

test("promote: write が失敗したら数を進めず、次の promote は通る", async () => {
  const journal = await journalOf();
  const budget = Budget.loadDynamic(limits({ maxPurchases: 1 }), journal);
  await expect(
    budget.promote(reservation(), async () => {
      throw new Error("disk full");
    }),
  ).rejects.toThrow("disk full");
  expect(budget.purchases).toBe(0);
  expect(budget.spentOf(USDC.network, USDC.asset)).toBe("0");
  expect(await budget.promote(reservation(), async () => {})).toEqual({ ok: true });
});

test("promote: 並行する 2 件で枠が 1 つなら、片方だけが書く", async () => {
  const journal = await journalOf();
  const budget = Budget.loadDynamic(limits({ maxPurchases: 1 }), journal);
  const order: string[] = [];
  const write = (name: string, n: number) => async (): Promise<void> => {
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await journal.append(dynamicCreated(n, reservation()));
    order.push(`${name}:end`);
  };
  const [a, b] = await Promise.all([budget.promote(reservation(), write("a", 1)), budget.promote(reservation(), write("b", 2))]);
  expect([a, b]).toEqual([{ ok: true }, { ok: false, reason: "purchase_count_limit" }]);
  // 2 件目の検査は、1 件目の write が終わってから行われる（検査と書き込みが不可分）。
  expect(order).toEqual(["a:start", "a:end"]);
  expect(journal.records.filter((record) => record.event === "created")).toHaveLength(1);
});

test("再起動: 動的予算は `created` 行の予約だけから復元する。静的予算は動的の行を数えず、逆も数えない", async () => {
  const journal = await journalOf();
  // 動的 2 件（昇格済み）、控えから昇格していない形の created 1 件（予約なし）、静的 1 件。
  await journal.append(dynamicCreated(1, reservation()));
  await journal.append(dynamicCreated(2, reservation("12000", "10000", "5000")));
  await journal.append(dynamicCreated(3, undefined));
  await journal.append({ paymentId: "static-1", event: "created", patch: { quoteId: "sq-1", routeId: "md-static", principalId: "judge", requestId: "s-1", approvalDeadlineMs: 1 } });
  await journal.append({ paymentId: "static-1", event: "budget_reserved", patch: { source: { ...USDC, amount: "7000" }, destination: { ...PATHUSD, amount: "7000" } } });
  await journal.close();

  const reopened = await journalOf();
  const dynamic = Budget.loadDynamic(limits(), reopened);
  expect(dynamic.purchases).toBe(2);
  expect(dynamic.spentOf(USDC.network, USDC.asset)).toBe("23000");
  expect(dynamic.spentOf(PATHUSD.network, PATHUSD.asset)).toBe("30000");

  const appended: string[] = [];
  const fixed = Budget.load(limits(), reopened, async (_paymentId, event) => {
    appended.push(event);
  });
  expect(fixed.purchases).toBe(1);
  expect(fixed.spentOf(USDC.network, USDC.asset)).toBe("7000");
  expect(fixed.spentOf(PATHUSD.network, PATHUSD.asset)).toBe("7000");
  expect(appended).toEqual([]);

  // 復元した数の上に、上限が効く（通算は再起動をまたぐ）。
  const tight = Budget.loadDynamic(limits({ maxPurchases: 2 }), reopened);
  expect(await tight.promote(reservation(), async () => {})).toEqual({ ok: false, reason: "purchase_count_limit" });
});

test("再起動: 予約の形が壊れた行は、件数として数える（枠を復活させない）。読めた額だけ足す", async () => {
  const journal = await journalOf();
  const broken = dynamicCreated(1, reservation());
  (broken.patch["dynamic"] as Record<string, unknown>)["reservation"] = { legs: [{ ...USDC, amount: "11000" }, { ...PATHUSD, amount: "oops" }, "junk"] };
  await journal.append(broken);
  const noLegs = dynamicCreated(2, reservation());
  (noLegs.patch["dynamic"] as Record<string, unknown>)["reservation"] = {};
  await journal.append(noLegs);
  const budget = Budget.loadDynamic(limits(), journal);
  expect(budget.purchases).toBe(2);
  expect(budget.spentOf(USDC.network, USDC.asset)).toBe("11000");
  expect(budget.spentOf(PATHUSD.network, PATHUSD.asset)).toBe("0");
});

test("動的予算は予約行（budget_reserved）を書かない: reserve は使えない", async () => {
  const journal = await journalOf();
  const budget = Budget.loadDynamic(limits(), journal);
  await expect(
    budget.reserve({ paymentId: "p", source: { ...USDC, amount: "1" }, destination: { ...PATHUSD, amount: "1" } }),
  ).rejects.toThrow("promote");
  expect(await bytes()).toBe(0);
});

test("intent の復元: 動的の欄（upstream・dynamic・予約）が消えずに戻る。静的の intent には付かない", async () => {
  const journal = await journalOf();
  await journal.append(dynamicCreated(1, reservation()));
  await journal.append({ paymentId: "static-1", event: "created", patch: { quoteId: "sq-1", routeId: "md-static", principalId: "judge", requestId: "s-1", approvalDeadlineMs: 1 } });
  await journal.close();
  const store = await IntentStore.load(await journalOf());
  const intent = store.byPaymentId("pay-1")!;
  expect(intent.upstream).toEqual({ url: "https://provider.test/v1/1", method: "GET" });
  expect(intent.dynamic).toEqual({
    profileId: "dyn-x402-to-mpp",
    profile: { rail: "mpp" },
    pricing: { upstreamAmount: "10000", converted: "10000", fee: "1000", total: "11000" },
    ownerKeyHash: HASH,
    reservation: reservation(),
  });
  expect(intent.dynamicInvalid).toBeUndefined();
  const fixed = store.byPaymentId("static-1")!;
  expect("upstream" in fixed).toBe(false);
  expect("dynamic" in fixed).toBe(false);
  expect("dynamicInvalid" in fixed).toBe(false);
});

test.each<[string, (patch: Record<string, unknown>) => void]>([
  ["upstream だけある", (p) => { delete p["dynamic"]; }],
  ["dynamic だけある", (p) => { delete p["upstream"]; }],
  ["url が空", (p) => { p["upstream"] = { url: "", method: "GET" }; }],
  ["method が GET でない", (p) => { p["upstream"] = { url: "https://provider.test/", method: "POST" }; }],
  ["profileId が無い", (p) => { delete (p["dynamic"] as Record<string, unknown>)["profileId"]; }],
  ["profile が配列", (p) => { (p["dynamic"] as Record<string, unknown>)["profile"] = []; }],
  ["pricing の額が数値", (p) => { (p["dynamic"] as Record<string, unknown>)["pricing"] = { upstreamAmount: 10000, converted: "1", fee: "1", total: "1" }; }],
  ["pricing の額が負", (p) => { (p["dynamic"] as Record<string, unknown>)["pricing"] = { upstreamAmount: "-1", converted: "1", fee: "1", total: "1" }; }],
  ["ownerKeyHash の形が違う", (p) => { (p["dynamic"] as Record<string, unknown>)["ownerKeyHash"] = "abc"; }],
  ["予約の legs が空", (p) => { (p["dynamic"] as Record<string, unknown>)["reservation"] = { legs: [] }; }],
  ["予約の額が不正", (p) => { (p["dynamic"] as Record<string, unknown>)["reservation"] = { legs: [{ ...USDC, amount: "1.5" }] }; }],
  ["dynamic が null", (p) => { p["dynamic"] = null; }],
])("intent の復元: 形の違う動的の欄は静的にも動的にもせず、実行しない印を付ける（%s）", (_name, mutate) => {
  const patch = dynamicCreated(1, reservation()).patch;
  mutate(patch);
  expect(dynamicFieldsOf(patch)).toEqual({ dynamicInvalid: true });
});

test("動的の行を含む journal を、動的を知らない読み方（静的の予算と intent 表）で再生できる", async () => {
  const journal = await journalOf();
  await journal.append(dynamicCreated(1, reservation()));
  await journal.append({ paymentId: "pay-1", event: "source_pending", patch: {} });
  await journal.append({ paymentId: "pay-1", event: "source_settled", patch: { txRef: "0xabc" } });
  await journal.close();
  const reopened = await journalOf();
  // 起動できる（途中状態は unknown に確定する）。静的予算は 0 のまま。
  const store = await IntentStore.load(reopened);
  expect(store.byPaymentId("pay-1")?.status).toBe("source_settled");
  const fixed = Budget.load(limits(), reopened, async () => {});
  expect(fixed.purchases).toBe(0);
  // 動的予算は、動的を無効にした設定でも数え続けられる。
  expect(Budget.loadDynamic(limits(), reopened).purchases).toBe(1);
});
