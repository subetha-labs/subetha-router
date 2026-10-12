/**
 * R-1 (docs/payer-rails-design.md §2.3, AC-R1): full-rail signing. EVM cases keep real crypto (ported from the Router's
 * tests/unit/sign-dispatch.test.ts); the SVM and MPP cases are ported from tests/unit/sign-run.test.ts with injected fake
 * payers. No RPC, no wallet files, no network: the global fetch is stubbed to throw and the Tempo `fetchFn` is a fake.
 */
import { Challenge } from "mppx";
import { getAddress, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { sign, type SignDeps, type SignPayers } from "../../src/sign/index.js";
import { PAYER_NETWORKS } from "../../src/sign/networks.js";
import { classifyOffer, SIGN_MAX_AMOUNT } from "../../src/vendor/sign-dispatch.js";
import { KNOWN_NETWORKS } from "../../src/vendor/networks.js";

const NOW = 1_800_000_000_000;
const EXPIRES = NOW / 1000 + 600;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const NONCE = `0x${"ab".repeat(32)}`;
const MPP_ID = "aaO_d6Wls64vx4QLbwbzSvgJrMyyp-wf7WsbSKufusE";
const EXTERNAL_ID = "7Xr3bZk9QmWv2aLpN4cE8t";
const TX = `0x${"7e".repeat(32)}`;

function evm(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600,
    extra: { name: "USDC", version: "2", challengeNonce: NONCE, expiresAt: EXPIRES, routeBinding: "synthetic-test", fundsMoveOnCredential: false, ...extra }, ...overrides };
}
function svm(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: OWNER, maxTimeoutSeconds: 40,
    extra: { feePayer: OWNER, memo: NONCE, challengeNonce: NONCE, expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: false, ...extra }, ...overrides };
}
const tempoChallenge = (request: Record<string, unknown> = {}): string =>
  Challenge.serialize(Challenge.from({ id: NONCE, realm: "r", method: "tempo", intent: "charge", expires: new Date((EXPIRES - 1) * 1000).toISOString(),
    request: { amount: "10000", currency: PATHUSD, recipient: RECEIVER, methodDetails: { chainId: 42431 }, ...request } } as never) as never);
function mpp(extra: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return { scheme: "tempo/charge", network: "eip155:42431", asset: PATHUSD, amount: "10000", payTo: RECEIVER, maxTimeoutSeconds: 600,
    extra: { challengeNonce: NONCE, challenge: tempoChallenge(), expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: true, ...extra }, ...overrides };
}
const solanaChallenge = (request: Record<string, unknown> = {}): string =>
  Challenge.serialize(Challenge.from({ id: MPP_ID, realm: "r", method: "solana", intent: "charge", expires: new Date((EXPIRES - 1) * 1000).toISOString(),
    request: { amount: "10000", currency: MINT, recipient: OWNER, externalId: EXTERNAL_ID, methodDetails: { network: "devnet", decimals: 6, tokenProgram: TOKEN_PROGRAM, feePayer: false }, ...request } } as never) as never);
function solmpp(extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) {
  return { scheme: "solana/charge", network: SOL, asset: MINT, amount: "10000", payTo: OWNER, maxTimeoutSeconds: 600,
    extra: { challengeNonce: MPP_ID, expiresAt: EXPIRES, routeBinding: "r", fundsMoveOnCredential: true, challenge: solanaChallenge(request), externalId: EXTERNAL_ID, decimals: 6, tokenProgram: TOKEN_PROGRAM, ...extra } };
}

interface Trace { keys: string[]; calls: string[] }
/** Fake payers record the key they were handed and the scope they were asked for; they never touch a network. */
function fakes(trace: Trace, options: { txRef?: string; throwing?: boolean } = {}): SignPayers {
  const fail = (): never => { throw new Error("dependency failure carrying the key: " + trace.keys.join(",")); };
  return {
    evmPayer: (key) => { trace.keys.push(`evm:${key}`); return { address: "0xEVM", async credentialFor(_offer, chainId) { if (options.throwing) fail(); trace.calls.push(`evm:sign:${chainId}`); return "evm-credential"; } }; },
    mppPayer: (key, scope, rpc) => { trace.keys.push(`mpp:${key}`); return { address: "0xMPP", async payAndCredential() {
      if (options.throwing) fail();
      trace.calls.push(`mpp:pay:${scope.chainId}:${scope.asset}:${scope.payTo}:${scope.maxAmount}:${rpc.rpcUrl}:${typeof rpc.fetchFn}`);
      return { credential: "Payment wire-credential", txRef: options.txRef ?? TX };
    } }; },
    svmPayer: async (key, rpc) => { trace.keys.push(`svm:${key}`); return { address: "SVM", async credentialFor(_offer, scope) { if (options.throwing) fail(); trace.calls.push(`svm:sign:${scope.mint}:${scope.decimals}:${scope.tokenProgram}:${rpc.rpcUrl}`); return "svm-credential"; } }; },
    svmMppPayer: async (key, rpc) => { trace.keys.push(`svm-mpp:${key}`); return { address: "SVMMPP", async credentialFor(_offer, scope) { if (options.throwing) fail(); trace.calls.push(`svm-mpp:sign:${scope.mint}:${scope.decimals}:${scope.tokenProgram}:${rpc.rpcUrl}:${rpc.nowMs?.()}`); return "Payment svm-mpp-wire"; } }; },
  };
}
const fetchFn: typeof fetch = async () => { throw new Error("fetchFn must not be called by fakes"); };
function depsOf(trace: Trace, options: { txRef?: string; throwing?: boolean } = {}): SignDeps {
  return { nowMs: () => NOW, tempoRpcUrl: "https://tempo.example/", solanaRpcUrl: "https://solana.example/", fetchFn, ...fakes(trace, options) };
}
const envelopeOf = (credential: string) => JSON.parse(Buffer.from(credential, "base64").toString("utf8"));

let key: Buffer, seed: Buffer;
let keys: { eip155: Buffer; solana: Buffer };
beforeEach(() => {
  key = Buffer.from(generatePrivateKey().slice(2), "hex");
  seed = Buffer.alloc(32, 0x5a);
  keys = { eip155: key, solana: seed };
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in signer tests"); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  key.fill(0); seed.fill(0);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
/** Production payers for the EVM rail (real EIP-3009 crypto, no network); everything else fake so nothing dials out. */
function realEvm(): SignDeps {
  const trace: Trace = { keys: [], calls: [] };
  const { evmPayer: _evm, ...rest } = fakes(trace);
  return { nowMs: () => NOW, tempoRpcUrl: "https://tempo.example/", solanaRpcUrl: "https://solana.example/", fetchFn, ...rest };
}

describe("PAYER_NETWORKS", () => {
  test("is the Router's table restricted to the four testnets, in order; the mainnet rows are gone", () => {
    expect(PAYER_NETWORKS.map((n) => n.network)).toEqual(["eip155:84532", "eip155:42431", "eip155:5042002", SOL]);
    expect(KNOWN_NETWORKS.map((n) => n.network)).toContain("eip155:8453");
    for (const entry of PAYER_NETWORKS) expect(KNOWN_NETWORKS).toContain(entry);
  });
});

describe("x402 EVM: Base Sepolia and Arc local signing (real crypto)", () => {
  test("signs the exact offer with a recoverable EIP-3009 signature, without changing the key; no txRef", async () => {
    const offer = evm();
    const originalKey = Buffer.from(key);
    try {
      const result = await sign(offer, keys, realEvm());
      expect(Object.keys(result)).toEqual(["credential"]);
      const credential = envelopeOf(result.credential);
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

  test("Arc testnet signs under chainId 5042002 with the table's domain (0.2.0 enables it; 0.1.x refused it)", async () => {
    const arc = evm({ network: "eip155:5042002", asset: ARC_USDC }, { assetTransferMethod: "eip3009" });
    const credential = envelopeOf((await sign(arc, keys, realEvm())).credential);
    const account = privateKeyToAccount(`0x${key.toString("hex")}`);
    const domain = { name: "USDC", version: "2", chainId: 5042002, verifyingContract: getAddress(ARC_USDC) };
    const types = { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] };
    const message = { ...credential.payload.authorization, value: 10000n, validAfter: 0n, validBefore: BigInt(EXPIRES) };
    expect(await recoverTypedDataAddress({ domain, types, primaryType: "TransferWithAuthorization", message, signature: credential.payload.signature })).toBe(account.address);
    expect(await recoverTypedDataAddress({ domain: { ...domain, chainId: 84532 }, types, primaryType: "TransferWithAuthorization", message, signature: credential.payload.signature })).not.toBe(account.address);
  });

  test("each call uses its supplied key; no cached account closure", async () => {
    const other = Buffer.from(generatePrivateKey().slice(2), "hex");
    try {
      for (const supplied of [key, other]) {
        const credential = envelopeOf((await sign(evm(), { eip155: supplied }, realEvm())).credential);
        expect(credential.payload.authorization.from).toBe(privateKeyToAccount(`0x${supplied.toString("hex")}`).address);
      }
    } finally { other.fill(0); }
  });

  test("caller mutation while signing cannot change accepted offer bytes", async () => {
    const offer = evm();
    const expected = structuredClone(offer);
    const pending = sign(offer, keys, realEvm());
    offer.amount = "20000";
    offer.extra.challengeNonce = `0x${"cd".repeat(32)}`;
    const credential = envelopeOf((await pending).credential);
    expect(credential.accepted).toEqual(expected);
    expect(credential.payload.authorization.value).toBe(expected.amount);
    expect(credential.payload.authorization.nonce).toBe(expected.extra.challengeNonce);
  });

  test("preserves the 20,000 base-unit cap, including its boundary", async () => {
    expect(SIGN_MAX_AMOUNT).toBe(20_000n);
    expect(classifyOffer(evm(), NOW, PAYER_NETWORKS)).toEqual({ kind: "x402-evm", chainId: 84532, domain: { name: "USDC", version: "2" }, asset: USDC, payTo: RECEIVER, amount: "10000" });
    await expect(sign(evm({ amount: "20000" }), keys, realEvm())).resolves.toEqual({ credential: expect.any(String) });
    await expect(sign(evm({ amount: "20001" }), keys, realEvm())).rejects.toThrow("rail_not_enabled");
  });

  test("invalid key errors expose no supplied bytes; a missing key rail is rail_not_enabled", async () => {
    await expect(sign(evm(), { eip155: Buffer.alloc(0) }, realEvm())).rejects.toThrow(/^invalid_signing_key$/);
    await expect(sign(evm(), { eip155: Buffer.alloc(32) }, realEvm())).rejects.toThrow(/^sign_failed$/);
    await expect(sign(evm(), { solana: seed }, realEvm())).rejects.toThrow(/^rail_not_enabled$/);
    await expect(sign(evm(), {}, realEvm())).rejects.toThrow(/^rail_not_enabled$/);
  });
});

describe("dispatch by offer (fake payers): which key, which scope, which envelope", () => {
  test("Base Sepolia 10,000 and 11,000 (a dynamic quote's amount) reach the EVM payer with chainId 84532; Arc with 5042002; only the eip155 key", async () => {
    for (const [offer, chainId] of [[evm(), 84532], [evm({ amount: "11000" }), 84532], [evm({ network: "eip155:5042002", asset: ARC_USDC }, { assetTransferMethod: "eip3009" }), 5042002]] as const) {
      const trace: Trace = { keys: [], calls: [] };
      expect(await sign(offer, keys, depsOf(trace))).toEqual({ credential: "evm-credential" });
      expect(trace.keys).toEqual([`evm:0x${key.toString("hex")}`]);
      expect(trace.calls).toEqual([`evm:sign:${chainId}`]);
    }
  });

  test("Solana x402 reaches the svm payer with the table's mint, decimals, token program and the configured RPC; only the solana key; credential as-is", async () => {
    const trace: Trace = { keys: [], calls: [] };
    expect(await sign(svm(), keys, depsOf(trace))).toEqual({ credential: "svm-credential" });
    expect(trace.keys).toEqual([`svm:0x${seed.toString("hex")}`]);
    expect(trace.calls).toEqual([`svm:sign:${MINT}:6:${TOKEN_PROGRAM}:https://solana.example/`]);
  });

  test("MPP Tempo: pays through the mpp payer (cap 20,000 in scope, configured RPC, the guarded fetchFn), wraps the wire in the x402 envelope and returns txRef", async () => {
    const trace: Trace = { keys: [], calls: [] };
    const offer = mpp();
    const result = await sign(offer, keys, depsOf(trace));
    expect(trace.keys).toEqual([`mpp:0x${key.toString("hex")}`]);
    expect(trace.calls).toEqual([`mpp:pay:42431:${PATHUSD}:${RECEIVER}:20000:https://tempo.example/:function`]);
    expect(result.txRef).toBe(TX);
    expect(envelopeOf(result.credential)).toEqual({ x402Version: 2, accepted: offer, payload: { challengeNonce: NONCE, credential: "Payment wire-credential" } });
  });

  test("MPP Tempo: an unreadable tx hash is omitted rather than invented", async () => {
    const trace: Trace = { keys: [], calls: [] };
    const result = await sign(mpp(), keys, depsOf(trace, { txRef: "" }));
    expect(Object.keys(result)).toEqual(["credential"]);
  });

  test("MPP Solana: only the solana key, svm-mpp payer with the table's scope, the configured RPC and the clock; same envelope; no txRef", async () => {
    const trace: Trace = { keys: [], calls: [] };
    const offer = solmpp();
    const result = await sign(offer, keys, depsOf(trace));
    expect(trace.keys).toEqual([`svm-mpp:0x${seed.toString("hex")}`]);
    expect(trace.calls).toEqual([`svm-mpp:sign:${MINT}:6:${TOKEN_PROGRAM}:https://solana.example/:${NOW}`]);
    expect(Object.keys(result)).toEqual(["credential"]);
    expect(envelopeOf(result.credential)).toEqual({ x402Version: 2, accepted: offer, payload: { challengeNonce: MPP_ID, credential: "Payment svm-mpp-wire" } });
  });

  test("txRef is returned for the Tempo MPP rail only", async () => {
    for (const offer of [evm(), svm(), solmpp()]) {
      const trace: Trace = { keys: [], calls: [] };
      expect("txRef" in await sign(offer, keys, depsOf(trace))).toBe(false);
    }
    expect("txRef" in await sign(mpp(), keys, depsOf({ keys: [], calls: [] }))).toBe(true);
  });

  test("a Solana offer with no solana key in the store is rail_not_enabled, before any payer is built", async () => {
    for (const offer of [svm(), solmpp()]) {
      const trace: Trace = { keys: [], calls: [] };
      await expect(sign(offer, { eip155: key }, depsOf(trace))).rejects.toThrow(/^rail_not_enabled$/);
      expect(trace.keys).toEqual([]);
    }
  });

  test("dependency failures become sign_failed without their message (the key is never in the thrown error)", async () => {
    for (const offer of [evm(), svm(), mpp(), solmpp()]) {
      const trace: Trace = { keys: [], calls: [] };
      let caught: unknown;
      try { await sign(offer, keys, depsOf(trace, { throwing: true })); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("sign_failed");
      expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain(key.toString("hex"));
    }
  });

  test("the default clock is Date.now when nowMs is absent", async () => {
    const trace: Trace = { keys: [], calls: [] };
    const { nowMs: _now, ...rest } = depsOf(trace);
    expect(await sign(evm(), keys, rest)).toEqual({ credential: "evm-credential" });
    vi.spyOn(Date, "now").mockReturnValue((EXPIRES + 1) * 1000);
    await expect(sign(evm(), keys, rest)).rejects.toThrow("rail_not_enabled");
  });
});

describe("refusals happen before any key is used (SR-R1, SR-R6)", () => {
  const refused: [string, unknown, RegExp][] = [
    ["Base mainnet x402 (in the Router's table, not the payer's)", evm({ network: "eip155:8453", asset: BASE_MAINNET_USDC }, { name: "USD Coin" }), /not in the table/],
    ["Tempo mainnet MPP (in the Router's table, not the payer's)", mpp({}, { network: "eip155:4217", asset: "0x20C000000000000000000000b9537d11c60E8b50" }), /not in the table/],
    ["unknown network", evm({ network: "eip155:1" }), /not in the table/],
    ["unknown asset", evm({ asset: "0x000000000000000000000000000000000000beef" }), /not a known asset/],
    ["domain name", evm({}, { name: "USD Coin" }), /EIP-712 domain does not match/],
    ["domain version", evm({}, { version: "3" }), /EIP-712 domain does not match/],
    ["expired", evm({}, { expiresAt: NOW / 1000 - 1 }), /expired/],
    ["expiry boundary", evm({}, { expiresAt: NOW / 1000 }), /expired/],
    ["missing expiry", evm({}, { expiresAt: undefined }), /no expiresAt/],
    ["invalid expiry", evm({}, { expiresAt: Infinity }), /no expiresAt/],
    ["malformed recipient", evm({ payTo: "0x1234" }), /payTo is not a well-formed/],
    ["funds move at signing on exact", evm({}, { fundsMoveOnCredential: true }), /must not move funds/],
    ["unknown scheme", evm({ scheme: "upto" }), /neither exact nor tempo/],
    ["x402 on Tempo", evm({ network: "eip155:42431", asset: PATHUSD }), /not accepted on that network/],
    ["MPP on an x402 network", mpp({}, { network: "eip155:84532", asset: USDC }), /only accepted on the table's MPP networks/],
    ["fractional amount", evm({ amount: "1.5" }), /not a base-unit integer/],
    ["negative amount", evm({ amount: "-1" }), /not a base-unit integer/],
    ["numeric amount", evm({ amount: 10000 }), /not a base-unit integer/],
    ["over the cap", evm({ amount: "20001" }), /exceeds the cap/],
    ["missing nonce", evm({}, { challengeNonce: undefined }), /challengeNonce/],
    ["bad nonce", evm({}, { challengeNonce: "abc" }), /challengeNonce/],
    ["MPP nonce on exact", evm({}, { challengeNonce: "M8hhq4HKvRwjmpWVozQ7ueKf2WIvNJdUw7PSyZ4nTU0" }), /challengeNonce/],
    ["MPP without the challenge", mpp({ challenge: undefined }), /does not carry the mppx challenge/],
    ["MPP challenge amount differs from the envelope", mpp({ challenge: tempoChallenge({ amount: "20000" }) }), /challenge amount differs/],
    ["MPP challenge chain differs", mpp({ challenge: tempoChallenge({ methodDetails: { chainId: 42429 } }) }), /challenge chain differs/],
    ["SVM payTo as 0x", svm({ payTo: RECEIVER }), /payTo is not a well-formed/],
    ["SVM mint not in the table", svm({ asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), /not a known asset/],
    ["SVM without feePayer", svm({}, { feePayer: undefined }), /feePayer/],
    ["SVM memo is not the nonce", svm({}, { memo: `0x${"cd".repeat(32)}` }), /memo must be the challengeNonce/],
    ["SVM decimals conflict with the table", svm({}, { decimals: 18 }), /decimals conflict/],
    ["SVM token program conflicts with the table", svm({}, { tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }), /token program conflicts/],
    ["MPP Solana without the challenge", solmpp({ challenge: undefined }), /does not carry the mppx challenge/],
    ["MPP Solana challenge amount differs", solmpp({}, { amount: "9999" }), /challenge amount differs/],
    ["MPP Solana challenge feePayer true", solmpp({}, { methodDetails: { network: "devnet", decimals: 6, tokenProgram: TOKEN_PROGRAM, feePayer: true } }), /feePayer must be false/],
    ["MPP Solana challenge not devnet", solmpp({}, { methodDetails: { network: "mainnet", decimals: 6, tokenProgram: TOKEN_PROGRAM, feePayer: false } }), /not devnet/],
    ["MPP Solana expired", solmpp({ expiresAt: 1 }), /expired/],
    ["MPP Solana without externalId", solmpp({ externalId: undefined }), /no usable externalId/],
    ["MPP Solana on Tempo's network", solmpp({}, {}) && { ...solmpp(), network: "eip155:42431", asset: PATHUSD, payTo: RECEIVER }, /only accepted on the table's MPP Solana networks/],
    ["not an offer", "x", /no readable/],
    ["null", null, /no readable/],
    ["array", [], /no readable/],
  ];
  test.each(refused)("ported refusal: %s", async (_name, offer, reason) => {
    expect(classifyOffer(offer, NOW, PAYER_NETWORKS)).toMatchObject({ kind: "refuse", reason: expect.stringMatching(reason) });
    const trace: Trace = { keys: [], calls: [] };
    // Even unusable keys are never read: the gate precedes key validation and payer construction.
    await expect(sign(offer, { eip155: Buffer.alloc(0), solana: Buffer.alloc(0) }, depsOf(trace))).rejects.toThrow(/^rail_not_enabled$/);
    expect(trace.keys).toEqual([]);
    expect(trace.calls).toEqual([]);
  });

  test("the mainnet offers the Router's own classifier accepts are refused here (AC-R1)", () => {
    const base = evm({ network: "eip155:8453", asset: BASE_MAINNET_USDC }, { name: "USD Coin" });
    expect(classifyOffer(base, NOW, KNOWN_NETWORKS)).toMatchObject({ kind: "x402-evm", chainId: 8453 });
    expect(classifyOffer(base, NOW, PAYER_NETWORKS)).toMatchObject({ kind: "refuse" });
  });

  test("an offer that cannot be snapshotted is refused without reading a key", async () => {
    const trace: Trace = { keys: [], calls: [] };
    await expect(sign({ ...evm(), fn: () => 1 }, keys, depsOf(trace))).rejects.toThrow(/^rail_not_enabled$/);
    expect(trace.keys).toEqual([]);
  });
});
