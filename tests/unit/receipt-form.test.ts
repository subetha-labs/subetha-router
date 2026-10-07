/**
 * 送信の結果の表（送信の設計 §5、FR-32。タスク U3 が主担当）: 共有の `receiptOf`／`deliveredBodyOf` を **EVM の form と SVM の form の両方**で、
 * 1 つの表として確かめる。領収は `PAYMENT-RESPONSE`（base64 の JSON）で、`success`・`network` の一致・`transaction` の形・`payer` の形と一致を見る。
 * Base の静的（`x402.ts` の従来の処理）はこの関数を使わない（変えない）。
 */
import { encodePaymentResponseHeader } from "@x402/core/http";
import { describe, expect, test } from "vitest";

import { deliveredBodyOf, EVM_RECEIPT_FORM, paidOutcomeOf, receiptOf, SVM_RECEIPT_FORM, type ReceiptForm } from "../../src/adapters/outbound/x402-dynamic.js";
import type { DestinationOffer } from "../../src/ports/outbound.js";

const EVM_SIGNER = "0x00000000000000000000000000000000000000C0";
const SVM_SIGNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const SVM_OTHER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
const EVM_TX = `0x${"7a".repeat(32)}`;
const SVM_SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const EVM_OFFER: DestinationOffer = { scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "1000", payTo: "0x0000000000000000000000000000000000000a11" };
const SVM_OFFER: DestinationOffer = { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amount: "1000", payTo: SVM_OTHER };
const SVM_FORM: ReceiptForm = SVM_RECEIPT_FORM(SVM_SIGNER);
const EVM_FORM = EVM_RECEIPT_FORM(EVM_SIGNER);

const header = (receipt: Record<string, unknown>): string => encodePaymentResponseHeader(receipt as never);
const response = (receipt: Record<string, unknown> | string | undefined, init: { status?: number; body?: string; contentType?: string } = {}): Response =>
  new Response(init.body === "" ? null : (init.body ?? "{}"), {
    status: init.status ?? 200,
    headers: {
      "content-type": init.contentType ?? "application/json",
      ...(receipt === undefined ? {} : { "PAYMENT-RESPONSE": typeof receipt === "string" ? receipt : header(receipt) }),
    },
  });

describe("receiptOf（領収の整合。形ごと）", () => {
  const cases: [string, ReceiptForm, DestinationOffer, Record<string, unknown> | string | undefined, string][] = [
    ["EVM: 整合", EVM_FORM, EVM_OFFER, { success: true, network: EVM_OFFER.network, transaction: EVM_TX, payer: EVM_SIGNER }, "settled"],
    ["EVM: payer 無しでも整合", EVM_FORM, EVM_OFFER, { success: true, network: EVM_OFFER.network, transaction: EVM_TX }, "settled"],
    ["EVM: payer の大文字小文字は同じ", EVM_FORM, EVM_OFFER, { success: true, network: EVM_OFFER.network, transaction: EVM_TX, payer: EVM_SIGNER.toLowerCase() }, "settled"],
    ["EVM: 領収なし", EVM_FORM, EVM_OFFER, undefined, "none"],
    ["EVM: base64 でない", EVM_FORM, EVM_OFFER, "!!not-base64!!", "none"],
    ["EVM: success が偽", EVM_FORM, EVM_OFFER, { success: false, network: EVM_OFFER.network, transaction: EVM_TX }, "none"],
    ["EVM: network 不一致", EVM_FORM, EVM_OFFER, { success: true, network: "eip155:84532", transaction: EVM_TX }, "none"],
    ["EVM: transaction の形違い（base58）", EVM_FORM, EVM_OFFER, { success: true, network: EVM_OFFER.network, transaction: SVM_SIG }, "none"],
    ["EVM: transaction 無し", EVM_FORM, EVM_OFFER, { success: true, network: EVM_OFFER.network }, "none"],
    ["EVM: payer の形違い", EVM_FORM, EVM_OFFER, { success: true, network: EVM_OFFER.network, transaction: EVM_TX, payer: "not-an-address" }, "payer_mismatch"],
    ["EVM: payer 不一致", EVM_FORM, EVM_OFFER, { success: true, network: EVM_OFFER.network, transaction: EVM_TX, payer: "0x00000000000000000000000000000000000000C1" }, "payer_mismatch"],
    ["EVM: success・network が通る前の不整合（transaction 無し）は payer が違っても none", EVM_FORM, EVM_OFFER, { success: true, network: EVM_OFFER.network, payer: "0x00000000000000000000000000000000000000C1" }, "none"],
    ["SVM: 整合", SVM_FORM, SVM_OFFER, { success: true, network: SVM_OFFER.network, transaction: SVM_SIG, payer: SVM_SIGNER }, "settled"],
    ["SVM: payer 無しでも整合", SVM_FORM, SVM_OFFER, { success: true, network: SVM_OFFER.network, transaction: SVM_SIG }, "settled"],
    ["SVM: transaction の形違い（bytes32）", SVM_FORM, SVM_OFFER, { success: true, network: SVM_OFFER.network, transaction: EVM_TX }, "none"],
    ["SVM: payer 不一致（base58 の別のアドレス）", SVM_FORM, SVM_OFFER, { success: true, network: SVM_OFFER.network, transaction: SVM_SIG, payer: SVM_OTHER }, "payer_mismatch"],
    ["SVM: payer の形違い（0x）", SVM_FORM, SVM_OFFER, { success: true, network: SVM_OFFER.network, transaction: SVM_SIG, payer: EVM_SIGNER }, "payer_mismatch"],
    ["SVM: payer は大文字小文字を区別する", SVM_FORM, SVM_OFFER, { success: true, network: SVM_OFFER.network, transaction: SVM_SIG, payer: SVM_SIGNER.toLowerCase() }, "payer_mismatch"],
    ["SVM: network 不一致（EVM の network）", SVM_FORM, SVM_OFFER, { success: true, network: EVM_OFFER.network, transaction: SVM_SIG }, "none"],
    ["SVM: 文字数は範囲内でも 64 バイトに復号できない（65 個の 1 = 65 バイトのゼロ）", SVM_FORM, SVM_OFFER, { success: true, network: SVM_OFFER.network, transaction: "1".repeat(65) }, "none"],
    ["SVM: 63 バイトに復号される署名", SVM_FORM, SVM_OFFER, { success: true, network: SVM_OFFER.network, transaction: "1".repeat(63) }, "none"],
    ["SVM: payer が 32 バイトに復号できない（33 個の 1）", SVM_FORM, { ...SVM_OFFER }, { success: true, network: SVM_OFFER.network, transaction: SVM_SIG, payer: "1".repeat(33) }, "payer_mismatch"],
    ["SVM: 署名者の札が壊れていて payer がそれと一致しても、32 バイトに復号できなければ不一致（復号の検査が独立に効く）", SVM_RECEIPT_FORM("1".repeat(33)), SVM_OFFER, { success: true, network: SVM_OFFER.network, transaction: SVM_SIG, payer: "1".repeat(33) }, "payer_mismatch"],
    ["SVM: success が偽", SVM_FORM, SVM_OFFER, { success: false, network: SVM_OFFER.network, transaction: SVM_SIG }, "none"],
    ["SVM: 領収なし", SVM_FORM, SVM_OFFER, undefined, "none"],
    ["SVM: base64 でない", SVM_FORM, SVM_OFFER, "!!not-base64!!", "none"],
  ];
  test.each(cases)("%s", (_name, form, offer, receipt, kind) => {
    const result = receiptOf(response(receipt), offer, form);
    expect(result.kind).toBe(kind);
    if (result.kind === "settled") {
      expect(result.transaction).toBe((receipt as Record<string, unknown>)["transaction"]);
      expect(result.header).toBe(header(receipt as Record<string, unknown>));
    }
  });
});

describe("deliveredBodyOf（整合した領収つきの 200 の本文）", () => {
  const receipt = { header: "h", transaction: EVM_TX };
  const deps = (reports: unknown[] = []) => ({ maxBodyBytes: 64, report: (error: unknown) => reports.push(error), ctx: { routeId: "r", operation: "pay" } });

  test("JSON object → paid（txRef・receiptRef つき）", async () => {
    const result = await deliveredBodyOf(response(undefined, { body: JSON.stringify({ price: 1 }) }), receipt, deps());
    expect(result).toEqual({ outcome: "paid", body: { price: 1 }, contentType: "application/json", txRef: EVM_TX, receiptRef: "h" });
  });
  test("object でない JSON → paid_no_data（unsupported_response）", async () => {
    expect(await deliveredBodyOf(response(undefined, { body: "[1]" }), receipt, deps())).toEqual({ outcome: "paid_no_data", reason: "unsupported_response", receiptRef: "h" });
  });
  test("application/json でない → paid_no_data（unsupported_response）", async () => {
    expect(await deliveredBodyOf(response(undefined, { body: "hello", contentType: "text/plain" }), receipt, deps())).toEqual({ outcome: "paid_no_data", reason: "unsupported_response", receiptRef: "h" });
  });
  test("大きすぎる → paid_no_data（response_too_large）", async () => {
    expect(await deliveredBodyOf(response(undefined, { body: JSON.stringify({ pad: "x".repeat(200) }) }), receipt, deps())).toEqual({ outcome: "paid_no_data", reason: "response_too_large", receiptRef: "h" });
  });
  test("本文が読めない → paid_no_data（paid_data_unavailable）。transport に報告する", async () => {
    const reports: unknown[] = [];
    const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error("socket reset")); } }), { status: 200, headers: { "content-type": "application/json" } });
    expect(await deliveredBodyOf(broken, receipt, deps(reports))).toEqual({ outcome: "paid_no_data", reason: "paid_data_unavailable", receiptRef: "h" });
    expect(reports).toHaveLength(1);
  });
});

/** 送信の設計 §5 の表を、送出の後の応答から結果まで**両方の form で**通す（HTTP の状態 × 領収の有無・整合）。 */
describe("paidOutcomeOf（HTTP の状態 × 領収 → 結果。EVM と SVM）", () => {
  const deps = { maxBodyBytes: 64, report: () => {}, ctx: { routeId: "r", operation: "pay" } };
  const forms: [string, ReceiptForm, DestinationOffer, string, string][] = [
    ["EVM", EVM_FORM, EVM_OFFER, EVM_TX, EVM_SIGNER],
    ["SVM", SVM_FORM, SVM_OFFER, SVM_SIG, SVM_SIGNER],
  ];
  for (const [label, form, offer, tx, signer] of forms) {
    const settled = { success: true, network: offer.network, transaction: tx, payer: signer };
    test.each([
      ["整合 ∧ 200 ∧ 本文 → paid", settled, 200, '{"price":1}', { outcome: "paid", body: { price: 1 }, txRef: tx }],
      ["整合 ∧ 200 ∧ 本文が object でない → paid_no_data", settled, 200, "[1]", { outcome: "paid_no_data", reason: "unsupported_response" }],
      ["整合 ∧ 402 → paid_no_data（4xx でも領収があれば支払い済み）", settled, 402, "{}", { outcome: "paid_no_data", reason: "paid_data_unavailable" }],
      ["整合 ∧ 500 → paid_no_data", settled, 500, "{}", { outcome: "paid_no_data", reason: "paid_data_unavailable" }],
      ["整合 ∧ 502 → paid_no_data", settled, 502, "{}", { outcome: "paid_no_data", reason: "paid_data_unavailable" }],
      ["payer だけ違う ∧ 200 → unknown", { ...settled, payer: label === "EVM" ? "0x00000000000000000000000000000000000000C1" : SVM_OTHER }, 200, "{}", { outcome: "unknown", reason: "destination_receipt_payer_mismatch" }],
      ["payer だけ違う ∧ 402 → unknown（rejected にしない）", { ...settled, payer: label === "EVM" ? "0x00000000000000000000000000000000000000C1" : SVM_OTHER }, 402, "{}", { outcome: "unknown", reason: "destination_receipt_payer_mismatch" }],
      ["領収なし ∧ 200 → unknown", undefined, 200, "{}", { outcome: "unknown", reason: "destination_receipt_unverified" }],
      ["領収なし ∧ 204 → unknown", undefined, 204, "", { outcome: "unknown", reason: "destination_receipt_unverified" }],
      ["領収なし ∧ 500 → unknown", undefined, 500, "{}", { outcome: "unknown", reason: "destination_pay_unknown" }],
      ["領収なし ∧ 503 → unknown", undefined, 503, "{}", { outcome: "unknown", reason: "destination_pay_unknown" }],
      ["領収なし ∧ 402 → rejected", undefined, 402, "{}", { outcome: "rejected", reason: "destination_rejected" }],
      ["領収なし ∧ 400 → rejected", undefined, 400, "{}", { outcome: "rejected", reason: "destination_rejected" }],
      ["領収なし ∧ 302 → rejected", undefined, 302, "{}", { outcome: "rejected", reason: "destination_rejected" }],
      ["不整合（network 違い）∧ 200 → unknown（領収なしと同じ）", { ...settled, network: "eip155:1" }, 200, "{}", { outcome: "unknown", reason: "destination_receipt_unverified" }],
      ["不整合（transaction の形違い）∧ 500 → unknown", { ...settled, transaction: "nope" }, 500, "{}", { outcome: "unknown", reason: "destination_pay_unknown" }],
      ["不整合（success が偽）∧ 200 → unknown", { ...settled, success: false }, 200, "{}", { outcome: "unknown", reason: "destination_receipt_unverified" }],
      ["整合 ∧ 200 ∧ 本文が大きすぎる → paid_no_data（response_too_large）", settled, 200, JSON.stringify({ pad: "x".repeat(200) }), { outcome: "paid_no_data", reason: "response_too_large" }],
      ["整合 ∧ 200 ∧ application/json でない → paid_no_data（unsupported_response）", settled, 200, "text", { outcome: "paid_no_data", reason: "unsupported_response" }],
    ])(`${label}: %s`, async (_name, receipt, status, body, expected) => {
      const result = await paidOutcomeOf(response(receipt as Record<string, unknown> | undefined, { status, body, ...(body === "text" ? { contentType: "text/plain" } : {}) }), offer, form, deps);
      expect(result).toMatchObject(expected);
    });

    test(`${label}: 整合 ∧ 200 ∧ 本文が読めない → paid_no_data（paid_data_unavailable）。transport に報告する`, async () => {
      const reports: unknown[] = [];
      const broken = new Response(new ReadableStream({ start(controller) { controller.error(new Error("socket reset")); } }), { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": header(settled) } });
      expect(await paidOutcomeOf(broken, offer, form, { ...deps, report: (error: unknown) => reports.push(error) })).toEqual({ outcome: "paid_no_data", reason: "paid_data_unavailable", receiptRef: header(settled) });
      expect(reports).toHaveLength(1);
    });
  }
});
