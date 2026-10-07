/**
 * SVM 送信の offer の検査（送信の設計 §4.2、FR-35・FR-38。タスク U6-a）。**純粋・同期**。
 * §4.2 の各行の肯定と否定: `feePayer`・`payTo` の各不等式、運用者の集合、未知の `extra`（`recentBlockhash`・`assetTransferMethod` 等）、
 * Memo の長さ・制御文字、`decimals`。ATA を要する不等式は `checkSvmOfferAtas`。
 */
import { describe, expect, test } from "vitest";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { MEMO_PROGRAM_ADDRESS } from "../../src/adapters/inbound/x402-svm.js";
import { checkSvmOffer, checkSvmOfferAtas, isSvmPublicKey, isValidSvmMemo, SVM_MEMO_MAX_BYTES, SYSTEM_PROGRAM_ADDRESS, type SvmOutboundScope } from "../../src/adapters/outbound/x402-svm.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ROUTER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const ROUTER_ATA = "6MycWeoQv6kaLCKa4VwAP35tBhzZsFSBKJWH9heAnL6y";
const PROVIDER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
const PROVIDER_ATA = "7pjZnp8kuG7hy7Gav4jG282PovTKnipAYUcT6REA63fN";
const FEE_PAYER = "HTazrCcGEzWPKSKLFtbzszPJYTrFdD6xFHN4rLbwQng5";
const OTHER = "So11111111111111111111111111111111111111112";
const BASE_RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";

const scope: SvmOutboundScope = { network: SOL, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS, routerAddress: ROUTER, routerAta: ROUTER_ATA };
const dynamicScope: SvmOutboundScope = { ...scope, maxUpstreamAmount: "20000" };
/** 運用者の集合: 受信の受取先（Base の 0x、Solana の受取 owner）と送信の署名者（Router の公開鍵）。文字列のまま。 */
const operators = new Set([BASE_RECEIVER, ROUTER, "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1"]);

function offer(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> | undefined = { feePayer: FEE_PAYER }): Record<string, unknown> {
  const base: Record<string, unknown> = { scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: PROVIDER, maxTimeoutSeconds: 120, extra };
  return { ...base, ...overrides };
}

describe("checkSvmOffer: 肯定", () => {
  test("必須の 7 欄だけ、記述の 3 欄付き、maxAmountRequired = amount、memo・decimals 付き——すべて通る", () => {
    expect(checkSvmOffer(offer(), scope, operators)).toBeUndefined();
    expect(checkSvmOffer(offer({ description: "ETH snapshot", mimeType: "application/json", resource: "https://provider.test/v1" }), scope, operators)).toBeUndefined();
    expect(checkSvmOffer(offer({ maxAmountRequired: "10000" }), scope, operators)).toBeUndefined();
    expect(checkSvmOffer(offer({}, { feePayer: FEE_PAYER, memo: "invoice 42", decimals: 6 }), scope, operators)).toBeUndefined();
    // 配列でも集合でも受ける。
    expect(checkSvmOffer(offer(), scope, [...operators])).toBeUndefined();
    // 動的: 上限ちょうどは通る。境界の額 1。
    expect(checkSvmOffer(offer({ amount: "20000" }), dynamicScope, operators)).toBeUndefined();
    expect(checkSvmOffer(offer({ amount: "1" }), dynamicScope, operators)).toBeUndefined();
    expect(checkSvmOffer(offer({ maxTimeoutSeconds: 1 }), scope, operators)).toBeUndefined();
    expect(checkSvmOffer(offer({ maxTimeoutSeconds: 600 }), scope, operators)).toBeUndefined();
  });
});

describe("checkSvmOffer: 否定（§4.2 の各行）", () => {
  const cases: [string, unknown, SvmOutboundScope, string][] = [
    // 1. 形
    ["object でない", "x", scope, "not_an_object"],
    ["null", null, scope, "not_an_object"],
    ["配列", [offer()], scope, "not_an_object"],
    ["未知の鍵（outputSchema）", offer({ outputSchema: {} }), scope, "unknown_field"],
    ["未知の鍵（mint）", offer({ mint: MINT }), scope, "unknown_field"],
    ["必須の欠け（extra）", (() => { const o = offer(); delete o["extra"]; return o; })(), scope, "missing_field"],
    ["必須の欠け（maxTimeoutSeconds）", (() => { const o = offer(); delete o["maxTimeoutSeconds"]; return o; })(), scope, "missing_field"],
    ["maxAmountRequired が amount と違う", offer({ maxAmountRequired: "10001" }), scope, "max_amount_required"],
    ["記述の欄が文字列でない", offer({ description: 1 }), scope, "descriptive_field"],
    // 2. 固定値
    ["scheme", offer({ scheme: "upto" }), scope, "scheme"],
    ["network（Base）", offer({ network: "eip155:84532" }), scope, "network"],
    ["network（devnet でない Solana）", offer({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), scope, "network"],
    ["asset（別の mint）", offer({ asset: OTHER }), scope, "asset"],
    ["asset（大文字小文字）", offer({ asset: MINT.toLowerCase() }), scope, "asset"],
    // 3. 額
    ["amount 0", offer({ amount: "0" }), scope, "amount"],
    ["amount に先頭の 0", offer({ amount: "010000" }), scope, "amount"],
    ["amount が数値", offer({ amount: 10000 }), scope, "amount"],
    ["amount が小数", offer({ amount: "1.5" }), scope, "amount"],
    ["amount が上限超え（動的）", offer({ amount: "20001" }), dynamicScope, "amount_over_limit"],
    // 4. payTo
    ["payTo が base58 でない", offer({ payTo: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405" }), scope, "pay_to"],
    ["payTo が 32 バイトに復号できない（33 個の 1）", offer({ payTo: "1".repeat(33) }), scope, "pay_to"],
    ["payTo が運用者（Router の公開鍵）", offer({ payTo: ROUTER }), scope, "pay_to"],
    ["payTo が運用者（受信の受取 owner）", offer({ payTo: "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1" }), scope, "pay_to"],
    ["payTo が mint", offer({ payTo: MINT }), scope, "pay_to"],
    ["payTo が token program", offer({ payTo: TOKEN_PROGRAM_ADDRESS }), scope, "pay_to"],
    // 5. maxTimeoutSeconds
    ["maxTimeoutSeconds 0", offer({ maxTimeoutSeconds: 0 }), scope, "max_timeout"],
    ["maxTimeoutSeconds 601", offer({ maxTimeoutSeconds: 601 }), scope, "max_timeout"],
    ["maxTimeoutSeconds 小数", offer({ maxTimeoutSeconds: 1.5 }), scope, "max_timeout"],
    ["maxTimeoutSeconds 文字列", offer({ maxTimeoutSeconds: "120" }), scope, "max_timeout"],
    // 6. extra
    ["extra が object でない", offer({}, "x" as never), scope, "extra"],
    ["extra が null", offer({ extra: null }), scope, "extra"],
    ["extra に recentBlockhash", offer({}, { feePayer: FEE_PAYER, recentBlockhash: "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD" }), scope, "extra"],
    ["extra に lastValidBlockHeight", offer({}, { feePayer: FEE_PAYER, lastValidBlockHeight: 1 }), scope, "extra"],
    ["extra に recentSlot", offer({}, { feePayer: FEE_PAYER, recentSlot: 1 }), scope, "extra"],
    ["extra に lighthouse", offer({}, { feePayer: FEE_PAYER, lighthouse: {} }), scope, "extra"],
    ["extra に assetTransferMethod", offer({}, { feePayer: FEE_PAYER, assetTransferMethod: "transfer" }), scope, "extra"],
    // 7. feePayer
    ["feePayer が無い", offer({}, {}), scope, "fee_payer"],
    ["feePayer が base58 でない", offer({}, { feePayer: "0xabc" }), scope, "fee_payer"],
    ["feePayer が運用者（Base の受取先の文字列）", offer({}, { feePayer: BASE_RECEIVER }), scope, "fee_payer"],
    ["feePayer が Router の公開鍵", offer({}, { feePayer: ROUTER }), scope, "fee_payer"],
    ["feePayer が Router の ATA", offer({}, { feePayer: ROUTER_ATA }), scope, "fee_payer"],
    ["feePayer が payTo", offer({}, { feePayer: PROVIDER }), scope, "fee_payer"],
    ["feePayer が mint", offer({}, { feePayer: MINT }), scope, "fee_payer"],
    ["feePayer が token program", offer({}, { feePayer: TOKEN_PROGRAM_ADDRESS }), scope, "fee_payer"],
    ["feePayer が Memo program", offer({}, { feePayer: String(MEMO_PROGRAM_ADDRESS) }), scope, "fee_payer"],
    ["feePayer が ComputeBudget program", offer({}, { feePayer: String(COMPUTE_BUDGET_PROGRAM_ADDRESS) }), scope, "fee_payer"],
    ["feePayer が System program", offer({}, { feePayer: SYSTEM_PROGRAM_ADDRESS }), scope, "fee_payer"],
    // 8. memo
    ["memo が文字列でない", offer({}, { feePayer: FEE_PAYER, memo: 1 }), scope, "memo"],
    ["memo が空", offer({}, { feePayer: FEE_PAYER, memo: "" }), scope, "memo"],
    ["memo が 257 バイト", offer({}, { feePayer: FEE_PAYER, memo: "a".repeat(257) }), scope, "memo"],
    ["memo が 257 バイト（マルチバイト）", offer({}, { feePayer: FEE_PAYER, memo: "あ".repeat(85) + "ab" }), scope, "memo"],
    ["memo に改行", offer({}, { feePayer: FEE_PAYER, memo: "a\nb" }), scope, "memo"],
    ["memo に NUL", offer({}, { feePayer: FEE_PAYER, memo: "a\u0000b" }), scope, "memo"],
    ["memo に DEL", offer({}, { feePayer: FEE_PAYER, memo: "a\u007fb" }), scope, "memo"],
    // 9. decimals
    ["decimals が違う", offer({}, { feePayer: FEE_PAYER, decimals: 9 }), scope, "decimals"],
    ["decimals が文字列", offer({}, { feePayer: FEE_PAYER, decimals: "6" }), scope, "decimals"],
  ];
  for (const [label, raw, s, reason] of cases) {
    test(`${label} → ${reason}`, () => {
      expect(checkSvmOffer(raw, s, operators)).toBe(reason);
    });
  }

  test("静的（maxUpstreamAmount 無し）は額の上限を見ない", () => {
    expect(checkSvmOffer(offer({ amount: "999999999999" }), scope, operators)).toBeUndefined();
  });
});

describe("checkSvmOfferAtas: ATA を要する不等式（候補の段階で await した後）", () => {
  test("宛先 ATA が Router の ATA → pay_to。feePayer が宛先 ATA → fee_payer。通常は通る", () => {
    const o = offer() as never;
    expect(checkSvmOfferAtas(o, scope, PROVIDER_ATA)).toBeUndefined();
    expect(checkSvmOfferAtas(o, scope, ROUTER_ATA)).toBe("pay_to");
    expect(checkSvmOfferAtas(offer({}, { feePayer: PROVIDER_ATA }) as never, scope, PROVIDER_ATA)).toBe("fee_payer");
  });
});

describe("isSvmPublicKey・isValidSvmMemo", () => {
  test("公開鍵: base58 で 32 バイトに復号できるものだけ（文字数だけでは決めない）", () => {
    expect(isSvmPublicKey(ROUTER)).toBe(true);
    expect(SYSTEM_PROGRAM_ADDRESS).toBe("1".repeat(32));
    expect(isSvmPublicKey("1".repeat(32))).toBe(true); // 32 個の 1 = 32 バイトのゼロ
    expect(isSvmPublicKey("1".repeat(33))).toBe(false); // 33 バイト
    expect(isSvmPublicKey("2".repeat(32))).toBe(false); // 約 24 バイト
    expect(isSvmPublicKey("0OIl")).toBe(false);
    expect(isSvmPublicKey(42)).toBe(false);
  });

  test("Memo: 1..256 バイト、制御文字無し", () => {
    expect(SVM_MEMO_MAX_BYTES).toBe(256);
    expect(isValidSvmMemo("a".repeat(256))).toBe(true);
    expect(isValidSvmMemo("a".repeat(257))).toBe(false);
    expect(isValidSvmMemo("subetha:11111111-2222-4333-8444-555555555555")).toBe(true);
    expect(isValidSvmMemo("tab\there")).toBe(false);
    expect(isValidSvmMemo("")).toBe(false);
  });
});
