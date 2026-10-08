/**
 * P-1a（`docs/agent-payer-tasks.md`）: 出口の要約は strict な schema を通す。余計な欄・例外・秘密を持つ欄は落ちて `internal_error` になる。
 * レビュー #1: 許された欄の中も形で検証する（自由文の `nextStep` は enum、アドレス・額・network・桁・URL は形）、preview は UTF-8 バイト、
 * `body` は `includeBody` の別 schema（256 KiB の JSON object）だけ。
 */
import { describe, expect, test } from "vitest";

import { failure, FailureSummary, knownCodeOf, KNOWN_CODES, NEXT_STEPS, PurchaseBodySummary, PurchaseSummary, QuoteSummary, RoutesSummary, toSummary, WalletSummary } from "../../src/protocol/summary.js";

const SECRET = "0x" + "ab".repeat(32);
const CREDENTIAL = Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: SECRET } })).toString("base64");

const quote = {
  ok: true,
  ref: "p_abcdefghijk",
  subject: {
    amount: "10000",
    decimals: 6,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    network: "eip155:84532",
    payTo: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2",
    deadlineMs: 1_800_000_000_000,
    fundsMoveOnCredential: false,
    reaches: { rail: "mpp", network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", quoted: "10000", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1", decimals: 6 },
  },
  nextStep: "approve_then_purchase",
};

const purchase = { ok: true, ref: "p_abcdefghijk", state: "result", outcome: "delivered", fundsMoved: "yes", paymentId: "de503f58-fbab-4a10-8ad5-b78f92a314eb", result: { untrusted: true, source: "upstream", contentType: "application/json", preview: "x".repeat(512), bytes: 2048 } };

describe("Summary: strict output validation", () => {
  test("a well-formed quote summary passes unchanged", () => {
    expect(toSummary(QuoteSummary, quote)).toEqual(quote);
  });

  test("an extra field carrying a secret is not passed through: the whole response becomes internal_error", () => {
    const leaked = { ...quote, privateKey: SECRET };
    const out = toSummary(QuoteSummary, leaked);
    expect(out).toEqual({ ok: false, error: "internal_error" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    const nested = { ...quote, subject: { ...quote.subject, ownerKey: "k".repeat(43) } };
    expect(toSummary(QuoteSummary, nested)).toEqual({ ok: false, error: "internal_error" });
  });

  test("secrets injected into ALLOWED fields are rejected by the field's shape (address, amount, asset, network, url, nextStep)", () => {
    const rows: Record<string, unknown>[] = [
      { ...quote, subject: { ...quote.subject, payTo: SECRET } },
      { ...quote, subject: { ...quote.subject, amount: SECRET } },
      { ...quote, subject: { ...quote.subject, asset: CREDENTIAL } },
      { ...quote, subject: { ...quote.subject, network: `eip155:${SECRET}` } },
      { ...quote, subject: { ...quote.subject, upstreamUrl: `https://u.test/x?k=${SECRET}`.padEnd(2_100, "a") } },
      { ...quote, nextStep: `approve: ${SECRET}` },
      { ...quote, subject: { ...quote.subject, reaches: { ...quote.subject.reaches, payTo: CREDENTIAL } } },
    ];
    for (const row of rows) {
      const out = toSummary(QuoteSummary, row);
      expect(out, JSON.stringify(row).slice(0, 80)).toEqual({ ok: false, error: "internal_error" });
    }
    // 自由文は enum の key だけ。文は NEXT_STEPS で引く。
    expect(Object.keys(NEXT_STEPS)).toContain("approve_then_purchase");
    expect(failure("internal_error", { nextStep: SECRET as never })).toEqual({ ok: false, error: "internal_error" });
    expect(JSON.stringify(failure("rate_limited", { nextStep: "retry_quote_later" }))).not.toContain(SECRET);
  });

  test("an Error object (exception with a message) never serialises: internal_error without the message", () => {
    const error = new Error("secret detail: " + SECRET);
    const out = toSummary(PurchaseSummary, error);
    expect(out).toEqual({ ok: false, error: "internal_error" });
    expect(JSON.stringify(out)).not.toMatch(/secret detail/);
  });

  test("the quote document itself (with offer, challenge, ownerKey) is not a summary", () => {
    const document = { ok: true, ref: "p_abcdefghijk", quote: { source: { offer: { extra: { challenge: "Payment id=x" } } }, ownerKey: "k" }, subject: quote.subject, nextStep: "approve_then_purchase" };
    expect(toSummary(QuoteSummary, document)).toEqual({ ok: false, error: "internal_error" });
  });

  test("failure(): fixed codes only; free text or secrets in the code/reason become internal_error; retryAfterMs is bounded", () => {
    expect(failure("rate_limited", { retryAfterMs: 60_000, reason: "rate_source" })).toEqual({ ok: false, error: "rate_limited", retryAfterMs: 60_000, reason: "rate_source" });
    expect(failure("Bad Code: " + SECRET)).toEqual({ ok: false, error: "internal_error" });
    expect(failure("quote_failed", { reason: "per purchase limit" })).toEqual({ ok: false, error: "internal_error" });
    // 小文字だけの秘密（64 文字）は正規表現を通るが、allowlist に無いので落ちる。
    expect(failure("quote_failed", { reason: SECRET.slice(2) })).toEqual({ ok: false, error: "internal_error" });
    expect(failure("quote_failed", { reason: "a".repeat(40) })).toEqual({ ok: false, error: "internal_error" });
    expect(KNOWN_CODES.has("per_purchase_limit")).toBe(true);
    expect(knownCodeOf("per_purchase_limit")).toBe("per_purchase_limit");
    expect(knownCodeOf("a".repeat(40))).toBe("unknown_code");
    expect(knownCodeOf(SECRET)).toBe("unknown_code");
    expect(failure(knownCodeOf("not_a_router_code_but_lowercase"))).toEqual({ ok: false, error: "unknown_code" });
    expect(failure("rate_limited", { retryAfterMs: 3_600_001 })).toEqual({ ok: false, error: "internal_error" });
    expect(FailureSummary.safeParse({ ok: false, error: "x", detail: SECRET }).success).toBe(false);
  });

  test("purchase summary: preview is capped at 512 UTF-8 bytes (not code units), the ref has the fixed shape, outcome/proof are enums, paymentId is a UUID", () => {
    expect(toSummary(PurchaseSummary, purchase)).toMatchObject({ ok: true, state: "result" });
    expect(toSummary(PurchaseSummary, { ...purchase, result: { ...purchase.result, preview: "x".repeat(513) } })).toEqual({ ok: false, error: "internal_error" });
    expect(toSummary(PurchaseSummary, { ...purchase, result: { ...purchase.result, preview: "あ".repeat(171) } })).toEqual({ ok: false, error: "internal_error" }); // 513 bytes
    expect(toSummary(PurchaseSummary, { ...purchase, result: { ...purchase.result, preview: "あ".repeat(170) } })).toMatchObject({ ok: true }); // 510 bytes
    expect(toSummary(PurchaseSummary, { ...purchase, ref: "p_ABC" })).toEqual({ ok: false, error: "internal_error" });
    expect(toSummary(PurchaseSummary, { ...purchase, outcome: "delivered " + SECRET })).toEqual({ ok: false, error: "internal_error" });
    expect(toSummary(PurchaseSummary, { ...purchase, paymentId: SECRET })).toEqual({ ok: false, error: "internal_error" });
    expect(toSummary(PurchaseSummary, { ...purchase, proof: { upstreamReceipt: SECRET, onChainFinality: "not_checked" } })).toEqual({ ok: false, error: "internal_error" });
  });

  test("the upstream body is rejected by the ordinary purchase summary and accepted only by PurchaseBodySummary when it is a JSON object of at most 256 KiB", () => {
    const withBody = { ...purchase, result: { ...purchase.result, body: { price: 1 } } };
    expect(toSummary(PurchaseSummary, withBody)).toEqual({ ok: false, error: "internal_error" });
    expect(toSummary(PurchaseBodySummary, withBody)).toMatchObject({ ok: true, result: { body: { price: 1 } } });
    expect(toSummary(PurchaseBodySummary, { ...purchase, result: { ...purchase.result, body: [1, 2] } })).toEqual({ ok: false, error: "internal_error" });
    expect(toSummary(PurchaseBodySummary, { ...purchase, result: { ...purchase.result, body: "text" } })).toEqual({ ok: false, error: "internal_error" });
    expect(toSummary(PurchaseBodySummary, { ...purchase, result: { ...purchase.result, body: { big: "x".repeat(262_144) } } })).toEqual({ ok: false, error: "internal_error" });
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(toSummary(PurchaseBodySummary, { ...purchase, result: { ...purchase.result, body: circular } })).toEqual({ ok: false, error: "internal_error" });
    // JSON のデータだけ: Date・toJSON を持つ object・class の instance・NaN・undefined・関数・BigInt は拒む。通ったものは plain な複製（元の object ではない）。
    for (const body of [new Date(), { toJSON: () => [] }, { n: NaN }, { u: undefined }, { f: () => 1 }, { b: 1n }, new (class X { x = 1 })(), { nested: { toJSON: () => "x" } }, Object.create({ inherited: 1 })]) {
      expect(toSummary(PurchaseBodySummary, { ...purchase, result: { ...purchase.result, body } }), String(body)).toEqual({ ok: false, error: "internal_error" });
    }
    const source = { price: 1, nested: { list: [1, "a", null, true], text: "あ" } };
    const out = toSummary(PurchaseBodySummary, { ...purchase, result: { ...purchase.result, body: source } }) as { result: { body: unknown } };
    expect(out.result.body).toEqual(source);
    expect(out.result.body).not.toBe(source);
    // 状態を持つ直列化（2 回目に大きくなる）も、複製を測るので通らない／すり抜けない。
    let calls = 0;
    const stateful = { get big() { calls += 1; return calls === 1 ? "x" : "x".repeat(300_000); } };
    const first = toSummary(PurchaseBodySummary, { ...purchase, result: { ...purchase.result, body: stateful } }) as { ok: boolean; result?: { body: { big: string } } };
    if (first.ok) expect(Buffer.byteLength(JSON.stringify(first.result!.body), "utf8")).toBeLessThanOrEqual(262_144);
  });

  test("wallet and routes summaries: addresses, amounts and ids have shapes; a secret in an allowed field is rejected", () => {
    const ok = { ok: true, wallets: [{ rail: "x402", network: "eip155:84532", address: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2", balance: "20000", decimals: 6 }] };
    expect(toSummary(WalletSummary, ok)).toEqual(ok);
    expect(toSummary(WalletSummary, { ok: true, wallets: [{ ...ok.wallets[0], privateKey: SECRET }] })).toEqual({ ok: false, error: "internal_error" });
    expect(toSummary(WalletSummary, { ok: true, wallets: [{ ...ok.wallets[0], address: SECRET }] })).toEqual({ ok: false, error: "internal_error" });
    expect(toSummary(WalletSummary, { ok: true, wallets: [{ ...ok.wallets[0], balance: CREDENTIAL }] })).toEqual({ ok: false, error: "internal_error" });
    const routes = { ok: true, routes: [{ routeId: "md-mpp-eth-snapshot", kind: "static", pays: { rail: "x402", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "10000", decimals: 6 }, reaches: { rail: "mpp", network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000" }, fundsMoveOnCredential: false, needsSol: false }] };
    expect(toSummary(RoutesSummary, routes)).toEqual(routes);
    expect(toSummary(RoutesSummary, { ok: true, routes: [{ ...routes.routes[0], routeId: `md-${SECRET}` }] })).toEqual({ ok: false, error: "internal_error" });
  });
});
