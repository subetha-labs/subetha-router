/**
 * P-1a（`docs/agent-payer-tasks.md`）: 出口の要約は strict な schema を通す。余計な欄・例外・秘密を持つ欄は落ちて `internal_error` になる。
 */
import { describe, expect, test } from "vitest";

import { failure, FailureSummary, PurchaseSummary, QuoteSummary, toSummary, WalletSummary } from "../../src/protocol/summary.js";

const SECRET = "0x" + "ab".repeat(32);

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
  nextStep: "Ask the human.",
};

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

  test("an Error object (exception with a message) never serialises: internal_error without the message", () => {
    const error = new Error("secret detail: " + SECRET);
    const out = toSummary(PurchaseSummary, error);
    expect(out).toEqual({ ok: false, error: "internal_error" });
    expect(JSON.stringify(out)).not.toMatch(/secret detail/);
  });

  test("the quote document itself (with offer, challenge, ownerKey) is not a summary", () => {
    const document = { ok: true, ref: "p_abcdefghijk", quote: { source: { offer: { extra: { challenge: "Payment id=x" } } }, ownerKey: "k" }, subject: quote.subject, nextStep: "x" };
    expect(toSummary(QuoteSummary, document)).toEqual({ ok: false, error: "internal_error" });
  });

  test("failure(): fixed codes only; free text in the code becomes internal_error; reason and retryAfterMs are kept when well-formed", () => {
    expect(failure("rate_limited", { retryAfterMs: 60_000, reason: "rate_source" })).toEqual({ ok: false, error: "rate_limited", retryAfterMs: 60_000, reason: "rate_source" });
    expect(failure("Bad Code: " + SECRET)).toEqual({ ok: false, error: "internal_error" });
    expect(failure("quote_failed", { reason: "per purchase limit" })).toEqual({ ok: false, error: "internal_error" });
    expect(FailureSummary.safeParse({ ok: false, error: "x", detail: SECRET }).success).toBe(false);
  });

  test("purchase summary: preview is capped at 512 bytes and the ref has the fixed shape", () => {
    const base = { ok: true, ref: "p_abcdefghijk", state: "result", outcome: "delivered", fundsMoved: "yes", result: { untrusted: true, source: "upstream", contentType: "application/json", preview: "x".repeat(512), bytes: 2048 } };
    expect(toSummary(PurchaseSummary, base)).toMatchObject({ ok: true, state: "result" });
    expect(toSummary(PurchaseSummary, { ...base, result: { ...base.result, preview: "x".repeat(513) } })).toEqual({ ok: false, error: "internal_error" });
    expect(toSummary(PurchaseSummary, { ...base, ref: "p_ABC" })).toEqual({ ok: false, error: "internal_error" });
  });

  test("wallet summary never carries anything but addresses and balances", () => {
    const ok = { ok: true, wallets: [{ rail: "x402", network: "eip155:84532", address: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2", balance: "20000", decimals: 6 }] };
    expect(toSummary(WalletSummary, ok)).toEqual(ok);
    expect(toSummary(WalletSummary, { ok: true, wallets: [{ ...ok.wallets[0], privateKey: SECRET }] })).toEqual({ ok: false, error: "internal_error" });
  });
});
