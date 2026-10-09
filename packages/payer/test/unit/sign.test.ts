/** P-2: EVM cases ported from tests/unit/sign-dispatch.test.ts; no RPC or wallet files. */
import { getAddress, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { sign } from "../../src/sign/index.js";
import { classifyEvmOffer, SIGN_MAX_AMOUNT } from "../../src/vendor/sign-classify-evm.js";

const NOW = 1_800_000_000_000;
const EXPIRES = NOW / 1000 + 600;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RECEIVER = "0x0000000000000000000000000000000000000001";
const NONCE = `0x${"ab".repeat(32)}`;
function evm(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600,
    extra: { name: "USDC", version: "2", challengeNonce: NONCE, expiresAt: EXPIRES, routeBinding: "synthetic-test", fundsMoveOnCredential: false, ...extra }, ...overrides };
}

let key: Buffer;
beforeEach(() => {
  key = Buffer.from(generatePrivateKey().slice(2), "hex");
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in signer tests"); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  key.fill(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("P-2: Base Sepolia local signing", () => {
  test("signs the exact offer with a recoverable EIP-3009 signature, without changing the key", async () => {
    const offer = evm();
    const originalKey = Buffer.from(key);
    try {
      const credential = JSON.parse(Buffer.from(await sign(offer, key), "base64").toString("utf8"));
      const account = privateKeyToAccount(`0x${key.toString("hex")}`);
      expect(credential.x402Version).toBe(2);
      expect(credential.accepted).toEqual(offer);
      expect(credential.payload.challengeNonce).toBe(NONCE);
      expect(credential.payload.authorization).toEqual({ from: account.address, to: RECEIVER, value: "10000", validAfter: "0", validBefore: String(EXPIRES), nonce: NONCE });
      const types = { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ] };
      const domain = { name: "USDC", version: "2", chainId: 84532, verifyingContract: getAddress(USDC) };
      const message = { ...credential.payload.authorization, value: 10000n, validAfter: 0n, validBefore: BigInt(EXPIRES) };
      const signed = { domain, types, primaryType: "TransferWithAuthorization" as const, message, signature: credential.payload.signature };
      expect(await recoverTypedDataAddress(signed)).toBe(account.address);
      // A changed amount, nonce or chain is not the authorization this key signed.
      expect(await recoverTypedDataAddress({ ...signed, message: { ...message, value: 10001n } })).not.toBe(account.address);
      expect(await recoverTypedDataAddress({ ...signed, message: { ...message, nonce: `0x${"cd".repeat(32)}` } })).not.toBe(account.address);
      expect(await recoverTypedDataAddress({ ...signed, domain: { ...domain, chainId: 5042002 } })).not.toBe(account.address);
      expect(key.equals(originalKey)).toBe(true);
    } finally { originalKey.fill(0); }
  });

  test("each call uses its supplied key; no cached account closure", async () => {
    const other = Buffer.from(generatePrivateKey().slice(2), "hex");
    try {
      for (const supplied of [key, other]) {
        const credential = JSON.parse(Buffer.from(await sign(evm(), supplied), "base64").toString("utf8"));
        expect(credential.payload.authorization.from).toBe(privateKeyToAccount(`0x${supplied.toString("hex")}`).address);
      }
    } finally { other.fill(0); }
  });

  test("caller mutation while signing cannot change accepted offer bytes", async () => {
    const offer = evm();
    const expected = structuredClone(offer);
    const pending = sign(offer, key);
    offer.amount = "20000";
    offer.extra.challengeNonce = `0x${"cd".repeat(32)}`;
    const credential = JSON.parse(Buffer.from(await pending, "base64").toString("utf8"));
    expect(credential.accepted).toEqual(expected);
    expect(credential.payload.authorization.value).toBe(expected.amount);
    expect(credential.payload.authorization.nonce).toBe(expected.extra.challengeNonce);
  });

  test("preserves the 20,000 base-unit cap, including its boundary", async () => {
    expect(SIGN_MAX_AMOUNT).toBe(20_000n);
    expect(classifyEvmOffer(evm(), NOW)).toEqual({ kind: "x402-evm", chainId: 84532, domain: { name: "USDC", version: "2" }, asset: USDC, payTo: RECEIVER, amount: "10000" });
    await expect(sign(evm({ amount: "20000" }), key)).resolves.toEqual(expect.any(String));
    await expect(sign(evm({ amount: "20001" }), key)).rejects.toThrow("rail_not_enabled");
  });

  test("Arc passes the shared classifier but is refused by the payer gate", async () => {
    const arc = evm({ network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000" }, { assetTransferMethod: "eip3009" });
    expect(classifyEvmOffer(arc, NOW)).toMatchObject({ kind: "x402-evm", chainId: 5042002 });
    await expect(sign(arc, key)).rejects.toThrow("rail_not_enabled");
    // Gate precedes privateKeyToAccount, even if the supplied key is unusable.
    await expect(sign(arc, Buffer.alloc(0))).rejects.toThrow("rail_not_enabled");
  });

  test.each(["exact", "solana/charge", "tempo/charge"])("refuses unsupported %s offers before touching the key", async (scheme) => {
    const tempo = scheme === "tempo/charge";
    const offer = evm({ scheme, network: tempo ? "eip155:42431" : "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      asset: tempo ? "0x20c0000000000000000000000000000000000000" : "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      payTo: tempo ? RECEIVER : "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" },
    { fundsMoveOnCredential: scheme !== "exact", challenge: 'Payment id="synthetic"', memo: NONCE, feePayer: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" });
    expect(classifyEvmOffer(offer, NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/only x402 EVM/) });
    await expect(sign(offer, Buffer.alloc(0))).rejects.toThrow("rail_not_enabled");
  });

  const rejected: [string, unknown, RegExp][] = [
    ["unknown network", evm({ network: "eip155:1" }), /not in the table/],
    ["unknown asset", evm({ asset: "0x000000000000000000000000000000000000beef" }), /not a known asset/],
    ["domain name", evm({}, { name: "USD Coin" }), /EIP-712 domain does not match/],
    ["domain version", evm({}, { version: "3" }), /EIP-712 domain does not match/],
    ["expired", evm({}, { expiresAt: NOW / 1000 - 1 }), /expired/],
    ["expiry boundary", evm({}, { expiresAt: NOW / 1000 }), /expired/],
    ["missing expiry", evm({}, { expiresAt: undefined }), /no expiresAt/],
    ["invalid expiry", evm({}, { expiresAt: Infinity }), /no expiresAt/],
    ["malformed recipient", evm({ payTo: "0x1234" }), /payTo is not a well-formed/],
    ["funds move at signing", evm({}, { fundsMoveOnCredential: true }), /must not move funds/],
    ["unknown scheme", evm({ scheme: "upto" }), /neither exact nor tempo/],
    ["x402 on Tempo", evm({ network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000" }), /not accepted on that network/],
    ["fractional amount", evm({ amount: "1.5" }), /not a base-unit integer/],
    ["negative amount", evm({ amount: "-1" }), /not a base-unit integer/],
    ["numeric amount", evm({ amount: 10000 }), /not a base-unit integer/],
    ["missing nonce", evm({}, { challengeNonce: undefined }), /challengeNonce/],
    ["bad nonce", evm({}, { challengeNonce: "abc" }), /challengeNonce/],
    ["MPP nonce on exact", evm({}, { challengeNonce: "M8hhq4HKvRwjmpWVozQ7ueKf2WIvNJdUw7PSyZ4nTU0" }), /challengeNonce/],
    ["not an offer", "x", /no readable/],
    ["null", null, /no readable/],
    ["array", [], /no readable/],
  ];
  test.each(rejected)("ported refusal: %s", async (_name, offer, reason) => {
    expect(classifyEvmOffer(offer, NOW)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(reason) });
    await expect(sign(offer, Buffer.alloc(0))).rejects.toThrow("rail_not_enabled");
  });

  test("invalid key errors expose no supplied bytes", async () => {
    await expect(sign(evm(), Buffer.alloc(0))).rejects.toThrow(/^invalid_signing_key$/);
    await expect(sign(evm(), Buffer.alloc(32))).rejects.toThrow(/^sign_failed$/);
  });
});
