/**
 * `npm run sign` の振り分けと署名前の拒否（multirail 設計 §7、SR-7。タスク T5）。鍵に触れない純粋な判定。
 */
import { Challenge } from "mppx";
import { describe, expect, test } from "vitest";

import { createMppInbound } from "../../src/adapters/inbound/mpp.js";
import { createMppPayer } from "../../tools/mpp-payer.js";
import { KNOWN_NETWORKS, type KnownNetwork } from "../../src/config.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
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
/** Tempo の challenge（mppx の形。HMAC は照合しない: 道具は秘密を持たない）。`request` の中身が封筒の offer と一致するかを道具が見る。 */
function tempoChallengeOf(request: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): string {
  return Challenge.serialize(
    Challenge.from({
      id: NONCE,
      realm: "router-test",
      method: "tempo",
      intent: "charge",
      expires: new Date((EXPIRES - 1) * 1000).toISOString(),
      request: { amount: "10000", currency: PATHUSD, recipient: RECEIVER, methodDetails: { chainId: 42431 }, ...request },
      ...overrides,
    } as never) as never,
  );
}
function mpp(overrides: Record<string, unknown> = {}, request: Record<string, unknown> = {}, challengeOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600, extra: { challengeNonce: NONCE, challenge: tempoChallengeOf(request, challengeOverrides), expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: true }, ...overrides };
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

describe("classifyOffer: MPP（Tempo）の nonce は mppx の challenge の id（T5 からの欠陥の回帰試験。M6）", () => {
  test("実 adapter（createMppInbound）の offer: nonce は base64url 43 文字で、mpp に振り分けられる（M6 の前は「no well-formed challengeNonce」で拒まれ、npm run sign で Tempo の MPP を払えなかった）", async () => {
    const transport = createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], dns: { timeoutMs: 1_000, maxInFlight: 1 } });
    const rail = createMppInbound({ secretKey: "0123456789abcdef0123456789abcdef-sign-dispatch", recipient: RECEIVER, currency: PATHUSD, chainId: 42431, transport, maxTimeoutSeconds: 600 });
    const offer = await rail.createOffer({ routeId: "r", amount: "10000", asset: PATHUSD, network: "eip155:42431", routeBinding: "r%7CGET%7C%2Fx", nowMs: NOW });
    expect(offer.extra.challengeNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(classifyOffer(offer, NOW)).toEqual({ kind: "mpp", chainId: 42431, asset: PATHUSD, payTo: RECEIVER, amount: "10000" });
    // 旧い形（0x の hex）も通る（試験の fixture の形）。x402 は hex だけ。
    const MPP_ID = "M8hhq4HKvRwjmpWVozQ7ueKf2WIvNJdUw7PSyZ4nTU0";
    expect(classifyOffer(mpp({ extra: { challengeNonce: MPP_ID, challenge: tempoChallengeOf({}, { id: MPP_ID }), expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: true } }), NOW).kind).toBe("mpp");
    expect(classifyOffer(mpp(), NOW).kind).toBe("mpp");
    // 実 adapter の offer の challenge を**中身だけ**変えて封筒に載せ直す（HMAC は道具では照合できないので中身の矛盾で拒むしかない）: 額・通貨・受取先・chain・id・期限。
    const decoded = Challenge.deserialize(offer.extra["challenge"] as string) as unknown as { request: Record<string, unknown> };
    const reissue = (request: Record<string, unknown>, top: Record<string, unknown> = {}): Record<string, unknown> => ({ ...offer, extra: { ...offer.extra, challenge: Challenge.serialize({ ...(decoded as unknown as Record<string, unknown>), ...top, request: { ...decoded.request, ...request } } as never) } });
    expect(classifyOffer(reissue({ amount: "20000" }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/challenge amount differs/) });
    expect(classifyOffer(reissue({ currency: USDC }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/challenge currency differs/) });
    expect(classifyOffer(reissue({ recipient: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2" }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/challenge recipient differs/) });
    expect(classifyOffer(reissue({ methodDetails: { chainId: 42429 } }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/challenge chain differs/) });
    expect(classifyOffer(reissue({}, { id: MPP_ID }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/challenge id is not the offer's challengeNonce/) });
    expect(classifyOffer(reissue({}, { expires: new Date(NOW - 1).toISOString() }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/challenge has expired/) });
    expect(classifyOffer(reissue({ splits: [{ recipient: RECEIVER, amount: "1" }] }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/splits/) });
    // 同じ判定を payer（`tools/mpp-payer.ts`）が送金の直前にも行う: 中身が違えば client を作る前に throw（RPC には触れない）。
    const payer = createMppPayer(`0x${"11".repeat(32)}`, { chainId: 42431, asset: PATHUSD, payTo: RECEIVER, maxAmount: 20_000n }, { rpcUrl: "http://127.0.0.1:1" });
    await expect(payer.payAndCredential(reissue({ amount: "20000" }) as never)).rejects.toThrow(/challenge amount differs/);
    await expect(payer.payAndCredential(reissue({ recipient: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2" }) as never)).rejects.toThrow(/challenge recipient differs/);
    expect(classifyOffer(evm({}, { challengeNonce: "M8hhq4HKvRwjmpWVozQ7ueKf2WIvNJdUw7PSyZ4nTU0" }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/challengeNonce/) });
    expect(classifyOffer(svm({}, { challengeNonce: "M8hhq4HKvRwjmpWVozQ7ueKf2WIvNJdUw7PSyZ4nTU0", memo: "M8hhq4HKvRwjmpWVozQ7ueKf2WIvNJdUw7PSyZ4nTU0" }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/challengeNonce/) });
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
    ["MPP の challenge が読めない", mpp({ extra: { challengeNonce: NONCE, challenge: 'Payment id="x"', expiresAt: EXPIRES } }), /challenge cannot be read/],
    ["MPP の challenge の額が封筒と違う", mpp({}, { amount: "20000" }), /challenge amount differs/],
    ["MPP の challenge の chain が違う", mpp({}, { methodDetails: { chainId: 42429 } }), /challenge chain differs/],
    ["MPP の challenge の method が違う", mpp({}, {}, { method: "solana" }), /not tempo\/charge/],
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

/** MPP の Solana（`solana/charge`。`docs/mpp-solana-design.md` §7、FR-49。タスク M6）。challenge は mppx の実物（HMAC は照合しない: 署名側は鍵を持たない）。 */
describe("classifyOffer: MPP の Solana（solana/charge → mpp-svm）", () => {
  const EXTERNAL_ID = "7Xr3bZk9QmWv2aLpN4cE8t";
  /** mppx が生成する形の id（32 バイトの base64url）。 */
  const MPP_ID = "aaO_d6Wls64vx4QLbwbzSvgJrMyyp-wf7WsbSKufusE";
  function challengeOf(request: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
    return Challenge.serialize(
      Challenge.from({
        id: MPP_ID,
        realm: "router-test",
        method: "solana",
        intent: "charge",
        expires: new Date((EXPIRES - 1) * 1000).toISOString(),
        request: { amount: "10000", currency: MINT, recipient: OWNER, externalId: EXTERNAL_ID, methodDetails: { network: "devnet", decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", feePayer: false }, ...request },
        ...overrides,
      } as never) as never,
    );
  }
  function solmpp(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}, challengeOverrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      scheme: "solana/charge",
      network: SOL,
      asset: MINT,
      amount: "10000",
      payTo: OWNER,
      maxTimeoutSeconds: 600,
      extra: { challengeNonce: MPP_ID, expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: true, challenge: challengeOf(request, challengeOverrides), externalId: EXTERNAL_ID, decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", ...extra },
      ...overrides,
    };
  }

  test("Router の offer の形 → mpp-svm（mint・桁・token program は表、externalId は challenge の request）。fundsMoveOnCredential true のまま通る（exact の検査は exact だけ）", () => {
    expect(classifyOffer(solmpp(), NOW)).toEqual({ kind: "mpp-svm", mint: MINT, decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", payTo: OWNER, amount: "10000", externalId: EXTERNAL_ID });
    // 動的 quote の額（上流 10,000 + 手数料 1,000）。
    expect(classifyOffer(solmpp({ amount: "11000" }, {}, { amount: "11000" }), NOW)).toMatchObject({ kind: "mpp-svm", amount: "11000" });
    // extra が桁・token program を名乗らなくても通る（表が権威）。
    expect(classifyOffer(solmpp({}, { decimals: undefined, tokenProgram: undefined }), NOW).kind).toBe("mpp-svm");
  });

  test("表に token program の無い SVM の資産には署名しない", () => {
    const networks: KnownNetwork[] = KNOWN_NETWORKS.map((n) => (n.family === "svm" ? { ...n, assets: n.assets.map((a) => ({ id: a.id, decimals: a.decimals })) } : n));
    expect(classifyOffer(solmpp(), NOW, networks)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/no token program/) });
  });

  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["challenge 無し", solmpp({}, { challenge: undefined }), /does not carry the mppx challenge/],
    ["challenge が空", solmpp({}, { challenge: "" }), /does not carry the mppx challenge/],
    ["challenge が読めない", solmpp({}, { challenge: "Payment not-a-challenge" }), /challenge cannot be read/],
    ["externalId 無し", solmpp({}, { externalId: undefined }), /no usable externalId/],
    ["externalId が 256 バイト超", solmpp({}, { externalId: "x".repeat(257) }), /no usable externalId/],
    ["extra の桁が表と違う", solmpp({}, { decimals: 9 }), /decimals conflict/],
    ["extra の token program が表と違う", solmpp({}, { tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }), /token program conflicts/],
    ["mint が表に無い", solmpp({ asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), /not a known asset/],
    ["network が MPP を許さない（Tempo の network に solana/charge）", solmpp({ network: "eip155:42431", asset: PATHUSD, payTo: RECEIVER }), /only accepted on the table's MPP Solana networks/],
    ["額が上限超", solmpp({ amount: "20001" }, {}, { amount: "20001" }), /exceeds the cap/],
    ["失効（offer）", solmpp({}, { expiresAt: 1_800_000_000 - 1 }), /expired/],
    ["失効（challenge の expires）", solmpp({}, {}, {}, { expires: new Date(NOW - 1000).toISOString() }), /challenge has expired/],
    ["challenge の id が nonce と違う", solmpp({}, {}, {}, { id: `0x${"cd".repeat(32)}` }), /challenge id is not the offer's challengeNonce/],
    ["challenge の額が offer と違う", solmpp({}, {}, { amount: "9999" }), /challenge amount differs/],
    ["challenge の currency が表の mint でない", solmpp({}, {}, { currency: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), /challenge currency is not the table's mint/],
    ["challenge の recipient が payTo と違う", solmpp({}, {}, { recipient: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d" }), /challenge recipient differs/],
    ["challenge の externalId が extra と違う", solmpp({}, {}, { externalId: "other-memo" }), /challenge externalId differs/],
    ["challenge の externalId 無し", solmpp({}, {}, { externalId: undefined }), /challenge has no usable externalId/],
    ["challenge の network が devnet でない", solmpp({}, {}, { methodDetails: { network: "mainnet", decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", feePayer: false } }), /not devnet/],
    ["challenge の桁が表と違う", solmpp({}, {}, { methodDetails: { network: "devnet", decimals: 9, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", feePayer: false } }), /challenge decimals conflict/],
    ["challenge の token program が表と違う", solmpp({}, {}, { methodDetails: { network: "devnet", decimals: 6, tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", feePayer: false } }), /challenge token program conflicts/],
    ["challenge の feePayer が true（push）", solmpp({}, {}, { methodDetails: { network: "devnet", decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", feePayer: true } }), /feePayer must be false/],
    ["challenge の feePayer 無し", solmpp({}, {}, { methodDetails: { network: "devnet", decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } }), /feePayer must be false/],
    ["challenge に splits", solmpp({}, {}, { splits: [{ recipient: OWNER, amount: "1" }] }), /splits/],
    ["challenge に feePayerKey", solmpp({}, {}, { feePayerKey: OWNER }), /fee payer key or a blockhash/],
    ["challenge に recentBlockhash", solmpp({}, {}, { recentBlockhash: "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD" }), /fee payer key or a blockhash/],
    ["challenge の methodDetails に feePayerKey（mppx の置き場）", solmpp({}, {}, { methodDetails: { network: "devnet", decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", feePayer: false, feePayerKey: OWNER } }), /fee payer key or a blockhash/],
    ["challenge の methodDetails に recentBlockhash", solmpp({}, {}, { methodDetails: { network: "devnet", decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", feePayer: false, recentBlockhash: "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD" } }), /fee payer key or a blockhash/],
    ["challenge の method が solana でない", solmpp({}, {}, {}, { method: "tempo" }), /not solana\/charge/],
    ["payTo の形違い（0x）", solmpp({ payTo: RECEIVER }), /payTo is not a well-formed/],
    ["nonce 無し", solmpp({}, { challengeNonce: undefined }), /challengeNonce/],
    ["nonce が mppx の id でも 0x の hex でもない", solmpp({}, { challengeNonce: "short" }, {}, { id: "short" }), /challengeNonce/],
    ["nonce が mppx の id の形だが challenge の id と違う", solmpp({}, { challengeNonce: "bbO_d6Wls64vx4QLbwbzSvgJrMyyp-wf7WsbSKufusE" }), /challenge id is not the offer's challengeNonce/],
  ];
  for (const [name, offer, pattern] of cases) {
    test(`署名の前に拒む: ${name}`, () => {
      const result = classifyOffer(offer, NOW);
      expect(result.kind).toBe("refuse");
      expect((result as { reason: string }).reason).toMatch(pattern);
    });
  }
});
