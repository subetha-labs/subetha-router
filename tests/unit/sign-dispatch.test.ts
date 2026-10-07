/**
 * `npm run sign` の振り分けと署名前の拒否（multirail 設計 §7、SR-7。タスク T5）。鍵に触れない純粋な判定。
 */
import { describe, expect, test } from "vitest";

import { KNOWN_NETWORKS, type KnownNetwork } from "../../src/config.js";
import { classifyOffer, SIGN_MAX_AMOUNT } from "../../tools/sign-dispatch.js";

const NOW = 1_800_000_000_000;
const EXPIRES = 1_800_000_000 + 600;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const NONCE = `0x${"ab".repeat(32)}`;

function evm(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600, extra: { name: "USDC", version: "2", challengeNonce: NONCE, expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: false, ...extra }, ...overrides };
}
function svm(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: OWNER, maxTimeoutSeconds: 40, extra: { feePayer: OWNER, memo: NONCE, challengeNonce: NONCE, expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: false, ...extra }, ...overrides };
}
function mpp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600, extra: { challengeNonce: NONCE, challenge: 'Payment id="x"', expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: true }, ...overrides };
}

describe("classifyOffer: 振り分け", () => {
  test("Base Sepolia の x402 → chainId 84532・domain USDC/2。Arc → 5042002", () => {
    expect(classifyOffer(evm(), NOW)).toEqual({ kind: "x402-evm", chainId: 84532, domain: { name: "USDC", version: "2" }, asset: USDC, payTo: RECEIVER, amount: "10000" });
    expect(classifyOffer(evm({ network: "eip155:5042002", asset: ARC_USDC }, { assetTransferMethod: "eip3009" }), NOW)).toMatchObject({ kind: "x402-evm", chainId: 5042002 });
  });
  test("Solana の x402 → mint・桁・token program は表から", () => {
    expect(classifyOffer(svm(), NOW)).toEqual({ kind: "x402-svm", mint: MINT, decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", payTo: OWNER, feePayer: OWNER, memo: NONCE, amount: "10000" });
  });
  test("MPP は従来どおり（Tempo の tempo/charge）", () => {
    expect(classifyOffer(mpp(), NOW)).toEqual({ kind: "mpp", chainId: 42431, asset: PATHUSD, payTo: RECEIVER, amount: "10000" });
  });
  test("表に token program の無い SVM の資産には署名しない（表の欠けは推測で埋めない）", () => {
    const networks: KnownNetwork[] = KNOWN_NETWORKS.map((n) => (n.family === "svm" ? { ...n, assets: n.assets.map((a) => ({ id: a.id, decimals: a.decimals })) } : n));
    expect(classifyOffer(svm(), NOW, networks)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/no token program/) });
  });
  test("上限は 20,000（ちょうどは通る、20,001 は拒む）", () => {
    expect(SIGN_MAX_AMOUNT).toBe(20_000n);
    expect(classifyOffer(evm({ amount: "20000" }), NOW).kind).toBe("x402-evm");
    expect(classifyOffer(evm({ amount: "20001" }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/exceeds the cap/) });
  });
});

describe("classifyOffer: 署名の前に拒む（SR-7）", () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["表に無い network", evm({ network: "eip155:1" }), /not in the table/],
    ["表に無い資産", evm({ asset: "0x000000000000000000000000000000000000beef" }), /not a known asset/],
    ["domain が表と違う", evm({}, { name: "USD Coin" }), /EIP-712 domain does not match/],
    ["domain の version が違う", evm({}, { version: "3" }), /EIP-712 domain does not match/],
    ["失効", evm({}, { expiresAt: 1_800_000_000 - 1 }), /expired/],
    ["expiresAt 無し", evm({}, { expiresAt: undefined }), /no expiresAt/],
    ["payTo の形違い（EVM）", evm({ payTo: "0x1234" }), /payTo is not a well-formed/],
    ["payTo の形違い（SVM に 0x）", svm({ payTo: RECEIVER }), /payTo is not a well-formed/],
    ["SVM の mint が表と違う", svm({ asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), /not a known asset/],
    ["SVM の feePayer 無し", svm({}, { feePayer: undefined }), /feePayer/],
    ["SVM の memo ≠ nonce", svm({}, { memo: `0x${"cd".repeat(32)}` }), /memo must be the challengeNonce/],
    ["exact で fundsMoveOnCredential true", svm({}, { fundsMoveOnCredential: true }), /must not move funds/],
    ["scheme が不明", evm({ scheme: "upto" }), /neither exact nor tempo/],
    ["MPP を x402 の network に", mpp({ network: "eip155:84532", asset: USDC }), /only accepted on the table's MPP networks/],
    ["x402 を Tempo に", evm({ network: "eip155:42431", asset: PATHUSD }), /not accepted on that network/],
    ["額が整数でない", evm({ amount: "1.5" }), /not a base-unit integer/],
    ["nonce が無い", evm({}, { challengeNonce: undefined }), /challengeNonce/],
    ["nonce の形違い", evm({}, { challengeNonce: "abc" }), /challengeNonce/],
    ["MPP の challenge 無し", mpp({ extra: { challengeNonce: NONCE, expiresAt: EXPIRES } }), /mppx challenge/],
    ["SVM の extra が桁を名乗って表と違う", svm({}, { decimals: 18 }), /decimals conflict/],
    ["SVM の extra が token program を名乗って表と違う", svm({}, { tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }), /token program conflicts/],
    ["SVM の extra が mint を名乗って表と違う", svm({}, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), /mint conflicts/],
    ["offer でない", "x" as unknown as Record<string, unknown>, /no readable/],
  ];
  for (const [name, offer, pattern] of cases) {
    test(name, () => {
      const result = classifyOffer(offer, NOW);
      expect(result.kind).toBe("refuse");
      expect((result as { reason: string }).reason).toMatch(pattern);
    });
  }
});
