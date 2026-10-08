/**
 * 動的購入の予算と、intent の動的な欄の復元（設計 `docs/dynamic-upstream-design.md` §2.4・§6.2・§6.4、タスク T5）。
 * 実 journal（一時ファイル）を使う。
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { parseRouterConfig, resolveProfile, type BudgetLimits } from "../../src/config.js";
import { Budget, PromotionNotWrittenError, type DynamicReservation } from "../../src/core/budget.js";
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

test("promote: 「1 バイトも書いていない」と断定できる失敗なら、数を進めず、次の promote は通る", async () => {
  const journal = await journalOf();
  const budget = Budget.loadDynamic(limits({ maxPurchases: 1 }), journal);
  await expect(
    budget.promote(reservation(), async () => {
      throw new PromotionNotWrittenError(new Error("identity collision"));
    }),
  ).rejects.toBeInstanceOf(PromotionNotWrittenError);
  expect(budget.purchases).toBe(0);
  expect(budget.blocked).toBeUndefined();
  expect(await budget.promote(reservation(), async () => {})).toEqual({ ok: true });
});

test("promote: 書いた後で失敗した（成否不明の）昇格の後は、以後の昇格を止める。再起動で journal から数え直せる", async () => {
  const journal = await journalOf();
  const budget = Budget.loadDynamic(limits({ maxPurchases: 2 }), journal);
  await expect(
    budget.promote(reservation(), async (frozen) => {
      await journal.append(dynamicCreated(1, frozen));
      throw new Error("lost the acknowledgement");
    }),
  ).rejects.toThrow("lost the acknowledgement");
  // 行は journal にあるが、メモリの数は進んでいない。このまま続けると上限を 1 件超えて使える。
  expect(budget.purchases).toBe(0);
  expect(budget.blocked).toBe("uncertain_write");
  let writes = 0;
  expect(
    await budget.promote(reservation(), async () => {
      writes += 1;
    }),
  ).toEqual({ ok: false, reason: "budget_unavailable" });
  expect(writes).toBe(0);
  // 再起動（journal から数え直す）と、書かれた 1 件が数えられ、昇格が再開できる。
  const rebuilt = Budget.loadDynamic(limits({ maxPurchases: 2 }), journal);
  expect(rebuilt.purchases).toBe(1);
  expect(rebuilt.blocked).toBeUndefined();
  expect(await rebuilt.promote(reservation(), async () => {})).toEqual({ ok: true });
});

test("promote: write に渡るのは検査したのと同じ予約で、呼び出し側が後から書き換えても変わらない", async () => {
  const journal = await journalOf();
  const budget = Budget.loadDynamic(limits(), journal);
  const mutable = { legs: [{ ...USDC, amount: "11000" }, { ...PATHUSD, amount: "10000" }] };
  let seen: DynamicReservation | undefined;
  const pending = budget.promote(mutable, async (frozen) => {
    seen = frozen;
    mutable.legs[0]!.amount = "1";
    expect(() => ((frozen.legs[0] as { amount: string }).amount = "1")).toThrow();
  });
  expect(await pending).toEqual({ ok: true });
  expect(seen).toEqual({ legs: [{ ...USDC, amount: "11000" }, { ...PATHUSD, amount: "10000" }] });
  expect(budget.spentOf(USDC.network, USDC.asset)).toBe("11000");
});

test("promote: 手数料の資産が元本と別なら、別のバケットに数える", async () => {
  const FEE = { network: "eip155:42431", asset: "0xfeetoken" };
  const journal = await journalOf();
  const config = limits({ buckets: [...limits().buckets, { ...FEE, maxTotal: "9000", maxPerPurchase: "5000" }] });
  const budget = Budget.loadDynamic(config, journal);
  const request = { legs: [{ ...USDC, amount: "11000" }, { ...PATHUSD, amount: "10000" }, { ...FEE, amount: "5000" }] };
  expect(await budget.promote(request, async () => {})).toEqual({ ok: true });
  expect(budget.spentOf(PATHUSD.network, PATHUSD.asset)).toBe("10000");
  expect(budget.spentOf(FEE.network, FEE.asset)).toBe("5000");
  // 手数料のバケットだけが尽きる。
  expect(await budget.promote(request, async () => {})).toEqual({ ok: false, reason: "bucket_limit" });
});

test("静的の予算では promote を使えず、write も呼ばれない", async () => {
  const journal = await journalOf();
  const fixed = Budget.load(limits(), journal, async () => {});
  let writes = 0;
  await expect(
    fixed.promote(reservation(), async () => {
      writes += 1;
    }),
  ).rejects.toThrow("dynamic budget");
  expect(writes).toBe(0);
  expect(fixed.purchases).toBe(0);
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
  // 動的 2 件（昇格済み）、静的 1 件。
  await journal.append(dynamicCreated(1, reservation()));
  await journal.append(dynamicCreated(2, reservation("12000", "10000", "5000")));
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

test.each<[string, unknown]>([
  ["予約が無い", undefined],
  ["予約が null", null],
  ["予約が文字列", "legs"],
  ["legs が無い", {}],
  ["legs が空", { legs: [] }],
  ["額が読めない区分がある", { legs: [{ ...USDC, amount: "11000" }, { ...PATHUSD, amount: "oops" }] }],
  ["区分が object でない", { legs: [{ ...USDC, amount: "11000" }, "junk"] }],
  ["network が無い区分", { legs: [{ asset: "0xusdc", amount: "1" }] }],
])("再起動: 予約を信用できない動的の行があれば、件数は数え、以後の昇格を止める（%s）", async (_name, raw) => {
  const journal = await journalOf();
  const broken = dynamicCreated(1, reservation());
  const dynamic = broken.patch["dynamic"] as Record<string, unknown>;
  if (raw === undefined) delete dynamic["reservation"];
  else dynamic["reservation"] = raw;
  await journal.append(broken);
  const budget = Budget.loadDynamic(limits(), journal);
  expect(budget.purchases).toBe(1);
  expect(budget.blocked).toBe("unreadable_reservation");
  let writes = 0;
  expect(
    await budget.promote(reservation(), async () => {
      writes += 1;
    }),
  ).toEqual({ ok: false, reason: "budget_unavailable" });
  expect(writes).toBe(0);
});

test("再起動: dynamic の欄が object でない行も、静的として読み飛ばさずに止める", async () => {
  const journal = await journalOf();
  const broken = dynamicCreated(1, reservation());
  broken.patch["dynamic"] = "yes";
  await journal.append(broken);
  expect(Budget.loadDynamic(limits(), journal).blocked).toBe("unreadable_reservation");
});

test("動的予算は予約行（budget_reserved）を書かない: reserve は使えない", async () => {
  const journal = await journalOf();
  const budget = Budget.loadDynamic(limits(), journal);
  await expect(
    budget.reserve({ paymentId: "p", source: { ...USDC, amount: "1" }, destination: { ...PATHUSD, amount: "1" } }),
  ).rejects.toThrow("only available on the static budget");
  expect(await bytes()).toBe(0);
});

test("journal にある動的の行が予約を持たなければ、intent は実行しない印付きで復元される", async () => {
  const journal = await journalOf();
  await journal.append(dynamicCreated(1, undefined));
  await journal.close();
  const store = await IntentStore.load(await journalOf());
  const intent = store.byPaymentId("pay-1")!;
  expect(intent.dynamicInvalid).toBe(true);
  expect(intent.upstream).toBeUndefined();
  expect(intent.dynamic).toBeUndefined();
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
  ["journal の行なのに予約が無い", (p) => { delete (p["dynamic"] as Record<string, unknown>)["reservation"]; }],
])("intent の復元: 形の違う動的の欄は静的にも動的にもせず、実行しない印を付ける（%s）", (_name, mutate) => {
  const patch = dynamicCreated(1, reservation()).patch;
  mutate(patch);
  expect(dynamicFieldsOf(patch, { requireReservation: true })).toEqual({ dynamicInvalid: true });
});

test("控えの quote（昇格前）は予約を持たなくてよい。journal の行は予約が必須", () => {
  const patch = dynamicCreated(1, undefined).patch;
  expect(dynamicFieldsOf(patch).dynamic?.profileId).toBe("dyn-x402-to-mpp");
  expect(dynamicFieldsOf(patch).dynamicInvalid).toBeUndefined();
  expect(dynamicFieldsOf(patch, { requireReservation: true })).toEqual({ dynamicInvalid: true });
});

test("intent の動的な欄は、追記した直後（再起動の前）にも読める", async () => {
  const store = await IntentStore.load(await journalOf());
  const created = dynamicCreated(1, reservation());
  await store.append(created.paymentId, created.event, created.patch);
  const intent = store.byPaymentId("pay-1")!;
  expect(intent.upstream?.url).toBe("https://provider.test/v1/1");
  expect(intent.dynamic?.reservation).toEqual(reservation());
  expect(store.byQuoteId("q-1")?.dynamic?.ownerKeyHash).toBe(HASH);
});

test("動的の行を含む journal を、動的を知らない読み方（静的の予算と intent 表）で再生できる", async () => {
  const journal = await journalOf();
  await journal.append(dynamicCreated(1, reservation()));
  await journal.append({ paymentId: "pay-1", event: "source_pending", patch: {} });
  await journal.append({ paymentId: "pay-1", event: "source_settled", patch: { txRef: "0xabc" } });
  await journal.close();
  const reopened = await journalOf();
  // 起動できる（途中状態は終端に確定する: `source_settled` は 2026-10-08 の U8-b から `paid_undelivered`／`interrupted_at_restart`。受信の証跡は残る）。静的予算は 0 のまま。
  const store = await IntentStore.load(reopened);
  expect(store.byPaymentId("pay-1")).toMatchObject({ status: "paid_undelivered", terminalReason: "interrupted_at_restart" });
  const fixed = Budget.load(limits(), reopened, async () => {});
  expect(fixed.purchases).toBe(0);
  // 動的予算は、動的を無効にした設定でも数え続けられる。
  expect(Budget.loadDynamic(limits(), reopened).purchases).toBe(1);
});

test("動的を無効にした実際の設定（enabled: false）でも、動的の行を含む journal を再生でき、予算は数え続ける", async () => {
  const journal = await journalOf();
  await journal.append(dynamicCreated(1, reservation()));
  await journal.append({ paymentId: "static-1", event: "created", patch: { quoteId: "sq-1", routeId: "md-static", principalId: "judge", requestId: "s-1", approvalDeadlineMs: 1 } });
  await journal.append({ paymentId: "static-1", event: "budget_reserved", patch: { source: { ...USDC, amount: "7000" }, destination: { ...PATHUSD, amount: "7000" } } });
  await journal.close();

  const PAY_TO = "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2";
  const staticPart = {
    approvalTtlMs: 600_000,
    routes: {
      "md-static": {
        routeId: "md-static",
        canonicalPath: "/v1/routes/md-static/resource",
        rail: "mpp",
        sourceRail: "x402",
        source: { amount: "7000", ...USDC, decimals: 6, payTo: PAY_TO },
        destination: { scheme: "tempo/charge", ...PATHUSD, payTo: PAY_TO },
      },
    },
    budget: limits(),
  };
  const disabled = parseRouterConfig({
    ...staticPart,
    dynamic: {
      enabled: false,
      profiles: {
        "dyn-x402-to-mpp": {
          profileId: "dyn-x402-to-mpp",
          sourceRail: "x402",
          source: { ...USDC, decimals: 6, payTo: PAY_TO },
          rail: "mpp",
          destination: { scheme: "tempo/charge", ...PATHUSD, decimals: 6, feeAsset: PATHUSD.asset, maxFee: "5000" },
          par: true,
          maxUpstreamAmount: "100000",
          fee: { flat: "5000", bps: 0, min: "5000" },
        },
      },
      budget: { maxPurchases: 1, buckets: [{ ...USDC, maxTotal: "100000", maxPerPurchase: "30000" }, { ...PATHUSD, maxTotal: "100000", maxPerPurchase: "30000" }] },
    },
  });
  expect(disabled.dynamic?.enabled).toBe(false);
  // 無効でも、journal の動的 intent がどのプロファイルのものかは解決できる。
  expect(resolveProfile(disabled, "dyn-x402-to-mpp")?.rail).toBe("mpp");

  const reopened = await journalOf();
  const store = await IntentStore.load(reopened);
  expect(store.byPaymentId("pay-1")?.dynamic?.profileId).toBe("dyn-x402-to-mpp");
  const fixed = Budget.load(disabled.budget, reopened, async () => {});
  expect(fixed.purchases).toBe(1);
  expect(fixed.spentOf(USDC.network, USDC.asset)).toBe("7000");
  // 無効の間も動的の消費は保たれる（再び有効にしたとき、上限は続きから効く）。
  const dynamic = Budget.loadDynamic(disabled.dynamic!.budget, reopened);
  expect(dynamic.purchases).toBe(1);
  expect(await dynamic.promote(reservation(), async () => {})).toEqual({ ok: false, reason: "purchase_count_limit" });

  // `dynamic` を持たない設定（この機能を知らない設定）でも、同じ journal で静的の経路は起動できる。
  const plain = parseRouterConfig(staticPart);
  expect(plain.dynamic).toBeUndefined();
  expect(Budget.load(plain.budget, reopened, async () => {}).purchases).toBe(1);
});
