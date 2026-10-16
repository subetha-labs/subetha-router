/**
 * 送信の領収の 7 分類（設計 `docs/rejection-reasons-design.md` §4.3、タスク R-4）。
 *
 * - `receiptClassOf` は `receiptOf` と同じヘッダを同じ順に読み、同じ decoder で分ける。不変条件: `ok` ⇔ `settled`、`payer_mismatch` ⇔ `payer_mismatch`、
 *   それ以外 ⇔ `none`。7 分類 × 2 つのヘッダ（`PAYMENT-RESPONSE`・`X-PAYMENT-RESPONSE`）× 2 つの形（EVM・SVM）と、乱数で作った領収で確かめる
 * - 後回しの処理（`buildDiagRecord`）が、写したヘッダの文字列から同じ分類を書く（hook は decode しない）
 * - 理由の後回しの分類: `PAYMENT-REQUIRED.error`（表にある・無い・欄なし・壊れた・大きすぎ）、`PAYMENT-RESPONSE.errorReason`、既に読んだ本文の理由
 * - 写す欄の数（`DIAG_CAPTURE_FIELD_COUNT`）は固定
 */
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { describe, expect, test } from "vitest";

import { EVM_RECEIPT_FORM, receiptClassOf, receiptOf, SVM_RECEIPT_FORM, type ReceiptForm } from "../../src/adapters/outbound/x402-dynamic.js";
import type { DestinationOffer } from "../../src/ports/outbound.js";
import { buildDiagRecord, DIAG_CAPTURE_FIELD_COUNT, snapshotCapture, type DiagCapture } from "../../src/shared/diagnostics.js";

const EVM_SIGNER = "0x00000000000000000000000000000000000000C0";
const SVM_SIGNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const SVM_OTHER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
const EVM_TX = `0x${"7a".repeat(32)}`;
const SVM_SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const EVM_OFFER: DestinationOffer = { scheme: "exact", network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "1000", payTo: "0x0000000000000000000000000000000000000a11" };
const SVM_OFFER: DestinationOffer = { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amount: "1000", payTo: SVM_OTHER };
const EVM_FORM = EVM_RECEIPT_FORM(EVM_SIGNER);
const SVM_FORM = SVM_RECEIPT_FORM(SVM_SIGNER);

const enc = (receipt: Record<string, unknown>): string => encodePaymentResponseHeader(receipt as never);
const notObject = Buffer.from(JSON.stringify([1, 2]), "utf8").toString("base64");

type Form = "evm" | "svm";
type Class = "absent" | "malformed" | "failed" | "network_mismatch" | "tx_malformed" | "payer_mismatch" | "ok";

/** 7 分類のそれぞれの代表（形ごと）。`null` はヘッダ無し。 */
const CASES: ReadonlyArray<readonly [string, Form, string | null, Class]> = [
  ["EVM: ヘッダ無し", "evm", null, "absent"],
  ["EVM: 空", "evm", "", "absent"],
  ["EVM: base64 でない", "evm", "!!not-base64!!", "malformed"],
  ["EVM: object でない", "evm", notObject, "malformed"],
  ["EVM: success:false", "evm", enc({ success: false, errorReason: "invalid_exact_evm_insufficient_balance", network: EVM_OFFER.network, transaction: "" }), "failed"],
  ["EVM: success が文字列", "evm", enc({ success: "true", network: EVM_OFFER.network, transaction: EVM_TX }), "failed"],
  ["EVM: network 違い", "evm", enc({ success: true, network: "eip155:84532", transaction: EVM_TX }), "network_mismatch"],
  ["EVM: transaction の形違い", "evm", enc({ success: true, network: EVM_OFFER.network, transaction: SVM_SIG }), "tx_malformed"],
  ["EVM: transaction 無し", "evm", enc({ success: true, network: EVM_OFFER.network }), "tx_malformed"],
  ["EVM: payer 違い", "evm", enc({ success: true, network: EVM_OFFER.network, transaction: EVM_TX, payer: "0x00000000000000000000000000000000000000C1" }), "payer_mismatch"],
  ["EVM: payer の形違い", "evm", enc({ success: true, network: EVM_OFFER.network, transaction: EVM_TX, payer: 7 }), "payer_mismatch"],
  ["EVM: 整合（payer 小文字）", "evm", enc({ success: true, network: EVM_OFFER.network, transaction: EVM_TX, payer: EVM_SIGNER.toLowerCase() }), "ok"],
  ["EVM: 整合（payer 無し）", "evm", enc({ success: true, network: EVM_OFFER.network, transaction: EVM_TX }), "ok"],
  ["SVM: ヘッダ無し", "svm", null, "absent"],
  ["SVM: base64 でない", "svm", "%%%", "malformed"],
  ["SVM: success:false", "svm", enc({ success: false, errorReason: "invalid_exact_svm_payload_transaction_simulation_failed", network: SVM_OFFER.network, transaction: "" }), "failed"],
  ["SVM: network 違い", "svm", enc({ success: true, network: EVM_OFFER.network, transaction: SVM_SIG }), "network_mismatch"],
  ["SVM: transaction の形違い（bytes32）", "svm", enc({ success: true, network: SVM_OFFER.network, transaction: EVM_TX }), "tx_malformed"],
  ["SVM: 64 バイトに復号できない", "svm", enc({ success: true, network: SVM_OFFER.network, transaction: "1".repeat(65) }), "tx_malformed"],
  ["SVM: payer 違い", "svm", enc({ success: true, network: SVM_OFFER.network, transaction: SVM_SIG, payer: SVM_OTHER }), "payer_mismatch"],
  ["SVM: payer の大文字小文字", "svm", enc({ success: true, network: SVM_OFFER.network, transaction: SVM_SIG, payer: SVM_SIGNER.toLowerCase() }), "payer_mismatch"],
  ["SVM: 整合", "svm", enc({ success: true, network: SVM_OFFER.network, transaction: SVM_SIG, payer: SVM_SIGNER }), "ok"],
];

const formOf = (form: Form): ReceiptForm => (form === "evm" ? EVM_FORM : SVM_FORM);
const offerFor = (form: Form): DestinationOffer => (form === "evm" ? EVM_OFFER : SVM_OFFER);
const expectedKind = (cls: Class): "settled" | "payer_mismatch" | "none" => (cls === "ok" ? "settled" : cls === "payer_mismatch" ? "payer_mismatch" : "none");

function responseWith(headers: Record<string, string>): Response {
  return new Response("{}", { status: 200, headers });
}

/** 後回しの処理が書く `receipt`（hook と同じ形の写しから）。 */
function deferredClass(header: string | null, form: Form, headerName: "payment-response" | "x-payment-response"): string | undefined {
  const capture: DiagCapture = {
    stage: "dest_pay_request",
    network: offerFor(form).network,
    receiptHeader: header === null ? "none" : headerName,
    receiptForm: form,
    receiptSigner: formOf(form).signerAddress,
    ...(header === null ? {} : { rawReceiptHeader: header }),
  };
  const record = buildDiagRecord({ capture: snapshotCapture(capture).value, scope: undefined, at: 0, seq: 0 }, "router");
  expect(record, "record passes validation").toBeDefined();
  return record?.receipt;
}

describe("receiptClassOf の不変条件（7 分類 × 2 つのヘッダ × 2 つの形）", () => {
  const headerNames = [
    ["PAYMENT-RESPONSE", "payment-response"],
    ["X-PAYMENT-RESPONSE", "x-payment-response"],
  ] as const;
  test.each(CASES.flatMap(([name, form, header, cls]) => headerNames.map(([wire, short]) => [`${name}（${wire}）`, form, header, cls, wire, short] as const)))(
    "%s",
    (_name, form, header, cls, wire, short) => {
      const response = responseWith(header === null ? {} : { [wire]: header });
      const result = receiptClassOf(response, offerFor(form), formOf(form));
      expect(result.receipt).toBe(cls);
      expect(receiptOf(response, offerFor(form), formOf(form)).kind).toBe(expectedKind(cls));
      expect(deferredClass(header, form, short)).toBe(cls);
    },
  );

  test("7 つの分類のどれもが表に現れる（形ごとに）", () => {
    for (const form of ["evm", "svm"] as const) {
      const seen = new Set(CASES.filter((c) => c[1] === form).map((c) => c[3]));
      expect([...seen].sort()).toEqual(["absent", "failed", "malformed", "network_mismatch", "ok", "payer_mismatch", "tx_malformed"]);
    }
  });

  test("ヘッダの順: PAYMENT-RESPONSE が null でなければ X-PAYMENT-RESPONSE は見ない（空でも）", () => {
    const ok = enc({ success: true, network: EVM_OFFER.network, transaction: EVM_TX });
    for (const [primary, cls] of [
      ["", "absent"],
      ["!!", "malformed"],
      [enc({ success: false }), "failed"],
    ] as const) {
      const response = responseWith({ "PAYMENT-RESPONSE": primary, "X-PAYMENT-RESPONSE": ok });
      expect(receiptClassOf(response, EVM_OFFER, EVM_FORM).receipt).toBe(cls);
      expect(receiptOf(response, EVM_OFFER, EVM_FORM).kind).toBe("none");
    }
    const legacyOnly = responseWith({ "X-PAYMENT-RESPONSE": ok });
    expect(receiptClassOf(legacyOnly, EVM_OFFER, EVM_FORM).receipt).toBe("ok");
    expect(receiptOf(legacyOnly, EVM_OFFER, EVM_FORM).kind).toBe("settled");
  });

  test("failed の errorReason は生の値を返す（分類は理由の表で後から）", () => {
    const response = responseWith({ "PAYMENT-RESPONSE": enc({ success: false, errorReason: "canary-free-text-1" }) });
    expect(receiptClassOf(response, EVM_OFFER, EVM_FORM)).toEqual({ receipt: "failed", errorReason: "canary-free-text-1" });
    expect(receiptClassOf(responseWith({ "PAYMENT-RESPONSE": enc({ success: false }) }), EVM_OFFER, EVM_FORM)).toEqual({ receipt: "failed", errorReason: undefined });
  });

  test("乱数で作った 3,000 個の領収で不変条件が成り立つ（両方の形・両方のヘッダ）", () => {
    let seed = 0x5eed;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = <T>(values: readonly T[]): T => values[rand(values.length)]!;
    const networks = [EVM_OFFER.network, SVM_OFFER.network, "eip155:84532", undefined, 1];
    const transactions = [EVM_TX, SVM_SIG, "1".repeat(65), "", undefined, 3, `0x${"ab".repeat(31)}`];
    const payers = [undefined, EVM_SIGNER, EVM_SIGNER.toLowerCase(), "0x00000000000000000000000000000000000000C1", SVM_SIGNER, SVM_OTHER, null, 9, "1".repeat(33)];
    const successes = [true, false, "true", undefined, 1];
    for (let i = 0; i < 3_000; i += 1) {
      const form = pick(["evm", "svm"] as const);
      const receipt: Record<string, unknown> = {};
      for (const [key, values] of [
        ["success", successes],
        ["network", networks],
        ["transaction", transactions],
        ["payer", payers],
      ] as const) {
        const value = pick(values as readonly unknown[]);
        if (value !== undefined) receipt[key] = value;
      }
      const header = rand(10) === 0 ? pick(["", "!!", notObject]) : enc(receipt);
      const wire = pick(["PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"] as const);
      const response = responseWith({ [wire]: header });
      const cls = receiptClassOf(response, offerFor(form), formOf(form)).receipt;
      expect(receiptOf(response, offerFor(form), formOf(form)).kind, JSON.stringify({ form, receipt, header })).toBe(expectedKind(cls));
      expect(deferredClass(header, form, wire === "PAYMENT-RESPONSE" ? "payment-response" : "x-payment-response")).toBe(cls);
    }
  });
});

/** 後回しの処理の理由（hook と同じ形の写しから）。 */
function deferredReason(capture: Partial<DiagCapture>): Record<string, unknown> | undefined {
  const record = buildDiagRecord({ capture: snapshotCapture({ stage: "dest_pay_request", ...capture } as DiagCapture).value, scope: undefined, at: 0, seq: 0 }, "router");
  if (record === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of ["receipt", "reasonField", "reasonSource", "reason"] as const) if (record[key] !== undefined) out[key] = record[key];
  return out;
}

describe("理由の後回しの分類（§4.3・§12.2）", () => {
  const evm = { network: EVM_OFFER.network, receiptForm: "evm" as const, receiptSigner: EVM_SIGNER, receiptHeader: "none" as const };
  const required = (error?: unknown): string => encodePaymentRequiredHeader({ x402Version: 2, resource: { url: "https://p.test/" }, accepts: [], ...(error === undefined ? {} : { error }) } as never);

  test.each([
    ["表にある値", required("invalid_exact_evm_insufficient_balance"), "invalid_exact_evm_insufficient_balance"],
    ["Worker の値", required("payment_invalid"), "payment_invalid"],
    ["表に無い値", required("canary-not-in-table"), "unrecognized"],
    ["欄なし", required(), "absent"],
    ["文字列でない", required(42), "malformed"],
    ["decode できない", "%%not-base64%%", "malformed"],
    ["object でない", Buffer.from("[1]").toString("base64"), "malformed"],
    ["8 KiB を超える", "A".repeat(5000), "malformed"],
  ])("PAYMENT-REQUIRED: %s", (_name, header, reason) => {
    expect(deferredReason({ ...evm, rawPaymentRequired: header })).toEqual({ receipt: "absent", reasonField: "error", reasonSource: "payment_required_header", reason });
  });

  test("領収が failed なら PAYMENT-RESPONSE の errorReason が優先（PAYMENT-REQUIRED があっても）", () => {
    const failed = enc({ success: false, errorReason: "invalid_exact_evm_transaction_failed" });
    expect(deferredReason({ ...evm, receiptHeader: "payment-response", rawReceiptHeader: failed, rawPaymentRequired: required("payment_invalid") })).toEqual({
      receipt: "failed",
      reasonField: "errorReason",
      reasonSource: "payment_response_header",
      reason: "invalid_exact_evm_transaction_failed",
    });
    expect(deferredReason({ ...evm, receiptHeader: "payment-response", rawReceiptHeader: enc({ success: false, errorReason: "canary-free" }) })).toMatchObject({ reason: "unrecognized" });
    expect(deferredReason({ ...evm, receiptHeader: "payment-response", rawReceiptHeader: enc({ success: false }) })).toMatchObject({ reason: "absent" });
  });

  test("既に読んだ本文の理由: ヘッダに理由が無いときだけ（PAYMENT-REQUIRED に error があればそちら）", () => {
    const body = { reasonField: "error" as const, reasonSource: "response_body" as const, rawReason: "facilitator_unavailable" };
    expect(deferredReason({ ...evm, ...body })).toEqual({ receipt: "absent", reasonField: "error", reasonSource: "response_body", reason: "facilitator_unavailable" });
    expect(deferredReason({ ...evm, ...body, rawPaymentRequired: required() })).toEqual({ receipt: "absent", reasonField: "error", reasonSource: "response_body", reason: "facilitator_unavailable" });
    expect(deferredReason({ ...evm, ...body, rawPaymentRequired: required("payment_invalid") })).toEqual({ receipt: "absent", reasonField: "error", reasonSource: "payment_required_header", reason: "payment_invalid" });
  });

  test("領収のヘッダが 8 KiB を超えたら receipt を書かない（分類しない）。型の違う値は malformed", () => {
    expect(deferredReason({ ...evm, receiptHeader: "payment-response", rawReceiptHeader: "A".repeat(5000) })).toEqual({});
    expect(deferredReason({ ...evm, receiptHeader: "payment-response", rawReceiptHeader: 5 as unknown as string })).toEqual({ receipt: "malformed" });
  });

  test("形の外の receiptForm・署名者だけの写しは行ごと捨てる", () => {
    expect(deferredReason({ ...evm, receiptForm: "tron" as never })).toBeUndefined();
    expect(deferredReason({ network: EVM_OFFER.network, receiptSigner: EVM_SIGNER })).toBeUndefined();
    expect(deferredReason({ network: EVM_OFFER.network, rawReceiptHeader: "x" })).toBeUndefined();
  });

  test("写す欄の数は固定（26 の閉じた欄 + 2 つの領収の入力 + rawReason・rawCid・txRef・rawRpc + 2 つのヘッダの文字列）", () => {
    expect(DIAG_CAPTURE_FIELD_COUNT).toBe(34);
  });
});
