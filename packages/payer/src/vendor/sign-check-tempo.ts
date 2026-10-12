/**
 * Tempo の MPP の challenge の中身の検査（P-0 で `sign-dispatch.ts` から分離。`mppx` に依存するので、EVM だけの分類（`sign-classify-evm.ts`）から切り離す）。
 */

import { Challenge } from "mppx";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tempo の MPP の challenge の中身が offer と一致するか（送金の前。`tools/mpp-payer.ts` も払う直前に同じ判定を呼ぶ）。
 * mppx の client は `request.amount`・`currency`・`recipient` から送金を組むので、封筒の offer（人間が承認した値）と中身の一致を確かめる。HMAC は payer 側では照合できない（秘密は Router の側）。
 */
export function checkTempoChallenge(serialized: string, offer: { amount: string; asset: string; payTo: string; extra: Record<string, unknown> }, chainId: number, nowMs: number): { ok: true } | { ok: false; reason: string } {
  let challenge: unknown;
  try {
    challenge = Challenge.deserialize(serialized);
  } catch {
    return { ok: false, reason: "the MPP offer's challenge cannot be read" };
  }
  if (!isRecord(challenge)) return { ok: false, reason: "the MPP offer's challenge cannot be read" };
  if (challenge["id"] !== offer.extra["challengeNonce"]) return { ok: false, reason: "the challenge id is not the offer's challengeNonce" };
  if (challenge["method"] !== "tempo" || challenge["intent"] !== "charge") return { ok: false, reason: "the challenge is not tempo/charge" };
  const expires = challenge["expires"];
  if (typeof expires === "string") {
    const at = Date.parse(expires);
    if (!Number.isFinite(at) || at <= nowMs) return { ok: false, reason: "the challenge has expired; take a new quote and ask for approval again" };
  }
  const request = challenge["request"];
  if (!isRecord(request)) return { ok: false, reason: "the challenge has no request" };
  if (request["amount"] !== offer.amount) return { ok: false, reason: "the challenge amount differs from the offer" };
  if (typeof request["currency"] !== "string" || request["currency"].toLowerCase() !== offer.asset.toLowerCase()) return { ok: false, reason: "the challenge currency differs from the offer's asset" };
  if (typeof request["recipient"] !== "string" || request["recipient"].toLowerCase() !== offer.payTo.toLowerCase()) return { ok: false, reason: "the challenge recipient differs from the offer's payTo" };
  const details = request["methodDetails"];
  if (!isRecord(details) || details["chainId"] !== chainId) return { ok: false, reason: "the challenge chain differs from the offer's network" };
  // `splits` は mppx の形では `methodDetails` の下（SDK はそこを読む）。request の直下にあっても拒む。
  if ("splits" in request || "splits" in details) return { ok: false, reason: "the challenge carries splits (not supported)" };
  return { ok: true };
}
