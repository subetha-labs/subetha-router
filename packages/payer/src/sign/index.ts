/**
 * Full-rail signing (docs/payer-rails-design.md §2.3, FR-R5..R7). The rail is decided from the offer by the Router's own
 * classifier (vendored `classifyOffer`, restricted to the payer's four testnets); refusal happens BEFORE any key is read.
 * Approval/record binding belongs to the purchase core; this module only turns an approved offer into a credential.
 *
 * | dispatch   | key      | what happens here                                                      |
 * |------------|----------|------------------------------------------------------------------------|
 * | x402-evm   | eip155   | EIP-3009 signature (Base Sepolia / Arc). Nothing moves.                 |
 * | x402-svm   | solana   | one blockhash read (guarded), partial signature. Nothing moves.         |
 * | mpp        | eip155   | **sends the Tempo transfer now** (guarded RPC); `txRef` = its hash.      |
 * | mpp-svm    | solana   | one blockhash read (guarded), fully-signed transaction. Router sends it. |
 *
 * Called internally with the session's decrypted key Buffers. No file/env key lookup, account cache, or broadcast other
 * than the MPP Tempo transfer the design requires. The caller owns the Buffers and zero-fills them at session end. The
 * payers require an immutable hex string: that string cannot be erased and may remain on the heap after this call (U-A15).
 */
import { createMppPayer, type MppPayer, type MppPayerScope } from "../vendor/mpp-payer.js";
import { classifyOffer, SIGN_MAX_AMOUNT } from "../vendor/sign-dispatch.js";
import { createSvmMppPayer, type SvmMppPayer } from "../vendor/svm-mpp-payer.js";
import { createSvmPayer, type SvmPayer, type SvmPayerRpcOptions } from "../vendor/svm-payer.js";
import { createX402Payer, type X402Payer } from "../vendor/x402-payer.js";
import { PAYER_NETWORKS } from "./networks.js";

export interface SignKeys { readonly eip155?: Buffer; readonly solana?: Buffer }
export interface SignResult { readonly credential: string; readonly txRef?: string }

/** Payer factories; production defaults are the vendored tools. Tests inject fakes that never touch a network. */
export interface SignPayers {
  readonly evmPayer: (key: string) => X402Payer;
  readonly mppPayer: (key: string, scope: MppPayerScope, options: { readonly rpcUrl: string; readonly fetchFn: typeof fetch }) => MppPayer;
  readonly svmPayer: (key: string, options: SvmPayerRpcOptions) => Promise<SvmPayer>;
  readonly svmMppPayer: (key: string, options: SvmPayerRpcOptions & { readonly nowMs?: () => number }) => Promise<SvmMppPayer>;
}
export interface SignDeps extends Partial<SignPayers> {
  readonly nowMs?: () => number;
  readonly tempoRpcUrl: string;
  readonly solanaRpcUrl: string;
  /** Guarded transport (`createGuardedFetch`) for the Tempo transfer. Never the global fetch. */
  readonly fetchFn: typeof fetch;
}

const PRODUCTION_PAYERS: SignPayers = { evmPayer: createX402Payer, mppPayer: createMppPayer, svmPayer: createSvmPayer, svmMppPayer: createSvmMppPayer };
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function hexOf(keys: SignKeys, rail: keyof SignKeys): string {
  const key = keys[rail];
  if (key === undefined) throw new Error("rail_not_enabled");
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("invalid_signing_key");
  return `0x${key.toString("hex")}`;
}

/** Same envelope as the Router's `npm run sign`: the mppx wire (`Payment …`) inside the x402 shape, base64. */
function envelope(snapshot: Record<string, unknown>, credential: string): string {
  const extra = snapshot["extra"] as Record<string, unknown> | undefined;
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted: snapshot, payload: { challengeNonce: extra?.["challengeNonce"], credential } }), "utf8").toString("base64");
}

export async function sign(offer: unknown, keys: SignKeys, deps: SignDeps): Promise<SignResult> {
  // The credential builders await signing before serializing accepted. Hold one
  // snapshot so caller mutation cannot change the offer between those steps.
  let snapshot: unknown;
  try { snapshot = structuredClone(offer); }
  catch { throw new Error("rail_not_enabled"); }
  const nowMs = deps.nowMs ?? Date.now;
  // Classification touches no key: table (testnets only), scheme, domain, expiry, cap, challenge contents.
  const dispatch = classifyOffer(snapshot, nowMs(), PAYER_NETWORKS);
  if (dispatch.kind === "refuse") throw new Error("rail_not_enabled");
  const key = hexOf(keys, dispatch.kind === "x402-evm" || dispatch.kind === "mpp" ? "eip155" : "solana");
  const payers = { ...PRODUCTION_PAYERS, ...Object.fromEntries(Object.entries(deps).filter(([name, value]) => name in PRODUCTION_PAYERS && value !== undefined)) } as SignPayers;
  const record = snapshot as Record<string, unknown>;
  try {
    // A fresh account closure per signature; nothing retains it after the call.
    switch (dispatch.kind) {
      case "x402-evm":
        return { credential: await payers.evmPayer(key).credentialFor(record as never, dispatch.chainId) };
      case "x402-svm": {
        const payer = await payers.svmPayer(key, { rpcUrl: deps.solanaRpcUrl });
        return { credential: await payer.credentialFor(record as never, { mint: dispatch.mint, decimals: dispatch.decimals, tokenProgram: dispatch.tokenProgram }) };
      }
      case "mpp": {
        // FUNDS MOVE HERE. The payer re-checks the challenge contents and scope before broadcasting; a throw after that
        // point may still have paid: the purchase core records `unknown` and never retries (SR-R7).
        const payer = payers.mppPayer(key, { chainId: dispatch.chainId, asset: dispatch.asset, payTo: dispatch.payTo, maxAmount: SIGN_MAX_AMOUNT }, { rpcUrl: deps.tempoRpcUrl, fetchFn: deps.fetchFn });
        const paid = await payer.payAndCredential(record as never);
        return { credential: envelope(record, paid.credential), ...(TX_HASH.test(paid.txRef) ? { txRef: paid.txRef } : {}) };
      }
      case "mpp-svm": {
        const payer = await payers.svmMppPayer(key, { rpcUrl: deps.solanaRpcUrl, nowMs });
        return { credential: envelope(record, await payer.credentialFor(record as never, { mint: dispatch.mint, decimals: dispatch.decimals, tokenProgram: dispatch.tokenProgram })) };
      }
    }
  } catch {
    // Never pass dependency errors (which may embed inputs) to callers.
    throw new Error("sign_failed");
  }
}
