/**
 * `npm run sign` と `subetha-exact` の offer（`docs/subetha-exact-inbound-design.md` §5.5、要件 AC-4、タスク T-1 の分類器の部分）。
 * zUSDC@84532 の `exact` は表の資産単位の上書き（`subetha-exact`）で署名の対象になり、domain 違い・network 違い・20,000 超・`fundsMoveOnCredential: true` は拒む。
 * 鍵には触れない純粋な判定。
 */
import { describe, expect, test } from "vitest";

import { classifyOffer, SIGN_MAX_AMOUNT } from "../../tools/sign-dispatch.js";
import { classifyEvmOffer } from "../../tools/sign-classify-evm.js";
import { SUBETHA_EXACT_MAX_AMOUNT } from "../../src/shared/subetha-exact.js";

const NOW = 1_800_000_000_000;
const EXPIRES = 1_800_000_000 + 120;
const ZUSDC = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const BURN = "0x7f3bA2c1e5d4F6a7B8c9D0e1F2a3B4c5D6e7F8a9";
const ORDER = `0x${"5a".repeat(32)}`;

function offer(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scheme: "exact",
    network: "eip155:84532",
    asset: ZUSDC,
    amount: "2000",
    payTo: BURN,
    maxTimeoutSeconds: 150,
    extra: { name: "zERC20 USD Coin", version: "1", challengeNonce: ORDER, expiresAt: EXPIRES, routeBinding: "z|GET|%2Fv1%2Froutes%2Fz%2Fresource", fundsMoveOnCredential: false, ...extra },
    ...overrides,
  };
}

describe("subetha-exact の offer の分類", () => {
  test("zUSDC@84532 の exact は x402-evm の signer に、表の chainId と domain で届く", () => {
    const dispatch = classifyOffer(offer(), NOW);
    expect(dispatch).toEqual({ kind: "x402-evm", chainId: 84532, domain: { name: "zERC20 USD Coin", version: "1" }, asset: ZUSDC, payTo: BURN, amount: "2000" });
    // EVM だけの分類器（payer が vendor する側）も同じ。
    expect(classifyEvmOffer(offer(), NOW)).toEqual(dispatch);
  });
  test("domain が表と違えば署名しない（facilitator の requirements と表の不一致）", () => {
    expect(classifyOffer(offer({}, { name: "USDC", version: "2" }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/EIP-712 domain does not match the table/) });
    expect(classifyOffer(offer({}, { version: "2" }), NOW)).toMatchObject({ kind: "refuse" });
  });
  test("同じ address でも Sepolia では表に無い（Sepolia の zUSDC は subetha-zerc20 の表の行）", () => {
    expect(classifyOffer(offer({ network: "eip155:11155111" }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/not a known asset/) });
  });
  test("上限は 20,000（route の cap と同じ値）: ちょうどは通り、20,001 は拒む", () => {
    expect(SUBETHA_EXACT_MAX_AMOUNT).toBe(SIGN_MAX_AMOUNT);
    expect(classifyOffer(offer({ amount: "20000" }), NOW)).toMatchObject({ kind: "x402-evm" });
    expect(classifyOffer(offer({ amount: "20001" }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/exceeds the cap/) });
  });
  test("fundsMoveOnCredential: true を名乗る exact は拒む。期限切れも拒む", () => {
    expect(classifyOffer(offer({}, { fundsMoveOnCredential: true }), NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/must not move funds on signing/) });
    expect(classifyOffer(offer(), (EXPIRES + 1) * 1000)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/expired/) });
  });
  test("既存の USDC@84532 の分類は変わらない", () => {
    const usdc = offer({ asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }, { name: "USDC", version: "2" });
    expect(classifyOffer(usdc, NOW)).toMatchObject({ kind: "x402-evm", chainId: 84532, domain: { name: "USDC", version: "2" } });
  });
});
