/** P-2: local EIP-3009 signing only. Approval/record binding belongs to P-3b. */
import { classifyEvmOffer } from "../vendor/sign-classify-evm.js";
import { createX402Payer, type InboundOfferView } from "../vendor/x402-payer.js";

/**
 * Called internally with the session's decrypted key Buffer. No file/env key
 * lookup, RPC client, broadcast, or account cache. The caller owns the Buffer
 * and zero-fills it at session end. viem requires an immutable hex string: that
 * string cannot be erased and may remain on the heap after this call (U-A15).
 */
export async function sign(offer: unknown, key: Buffer): Promise<string> {
  // The credential builder awaits signing before serializing accepted. Hold one
  // snapshot so caller mutation cannot change the offer between those steps.
  let snapshot: unknown;
  try { snapshot = structuredClone(offer); }
  catch { throw new Error("rail_not_enabled"); }
  const dispatch = classifyEvmOffer(snapshot, Date.now());
  if (dispatch.kind !== "x402-evm" || dispatch.chainId !== 84532) {
    throw new Error("rail_not_enabled");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("invalid_signing_key");
  try {
    // A fresh account closure per signature; nothing retains it after the call.
    return await createX402Payer(`0x${key.toString("hex")}`).credentialFor(snapshot as InboundOfferView, dispatch.chainId);
  } catch {
    // Never pass dependency errors (which may embed inputs) to callers.
    throw new Error("sign_failed");
  }
}
