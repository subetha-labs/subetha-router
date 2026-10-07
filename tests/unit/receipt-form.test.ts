/**
 * 送信の結果の表（送信の設計 §5、FR-32。タスク U3 が主担当）: 共有の `receiptOf`／`deliveredBodyOf` を **EVM の form と SVM の form の両方**で、
 * 1 つの表として確かめる。領収は `PAYMENT-RESPONSE`（base64 の JSON）で、`success`・`network` の一致・`transaction` の形・`payer` の形と一致を見る。
 * Base の静的（`x402.ts` の従来の処理）はこの関数を使わない（変えない）。
 */
import { encodePaymentResponseHeader } from "@x402/core/http";
import { describe, expect, test } from "vitest";

import { deliveredBodyOf, EVM_RECEIPT_FORM, receiptOf, type ReceiptForm } from "../../src/adapters/outbound/x402-dynamic.js";
import type { DestinationOffer } from "../../src/ports/outbound.js";

const EVM_SIGNER = "0x00000000000000000000000000000000000000C0";
const SVM_SIGNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const SVM_OTHER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
const EVM_TX = `0x${"7a".repeat(32)}`;
const SVM_SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const EVM_OFFER: DestinationOffer = { scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "1000", payTo: "0x0000000000000000000000000000000000000a11" };
const SVM_OFFER: DestinationOffer = { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amount: "1000", payTo: SVM_OTHER };
const SVM_FORM: ReceiptForm = { transactionPattern: /^[1-9A-HJ-NP-Za-km-z]{64,88}$/, payerForm: "svm", signerAddress: SVM_SIGNER };
const EVM_FORM = EVM_RECEIPT_FORM(EVM_SIGNER);

const header = (receipt: Record<string, unknown>): string => encodePaymentResponseHeader(receipt as never);
const response = (receipt: Record<string, unknown> | string | undefined, init: { status?: number; body?: string; contentType?: string } = {}): Response =>
  new Response(init.body ?? "{}", {
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
