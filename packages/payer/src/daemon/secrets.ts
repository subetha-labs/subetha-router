import { Credential } from "mppx";
import { record } from "../router/client.js";
import type { JsonValue } from "../store/ledger.js";
import type { RailQuote } from "./record.js";

/** Below this length a string is not treated as a secret by itself: public metadata such as `"0"`, `"to"` or a 6-digit amount would otherwise poison the filter. */
const MIN_SECRET_LENGTH = 32;
/** The payload fields that ARE the payment authority (never public metadata like `authorization.from/to/value/nonce`). */
const SENSITIVE_PAYLOAD_FIELDS = ["signature", "credential", "transaction", "hash"] as const;

function sensitiveStrings(payload: unknown, out: string[]): void {
  if (!record(payload)) return;
  for (const field of SENSITIVE_PAYLOAD_FIELDS) {
    const value = payload[field];
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) out.push(value);
  }
}

/**
 * Secrets inside a credential (docs/payer-rails-design.md SR-R4 / D-2 #6): the envelope itself, and when it decodes as the payer's
 * `{ x402Version, accepted, payload }` JSON, the payment authority in `payload` (the EIP-3009 `signature`, a Solana `transaction`, the
 * inner MPP `credential` wire) and, when that inner wire is an mppx credential, ITS payload's `transaction` / `hash`. Public
 * authorization metadata (`from`, `to`, `value`, `validAfter`, `nonce`, property names) is deliberately NOT a secret: it would reject
 * ordinary paid results (Codex implementation review #2).
 */
export function credentialSecrets(credential: string | undefined): string[] {
  if (!credential) return [];
  const out = [credential];
  let envelope: unknown;
  try { envelope = JSON.parse(Buffer.from(credential, "base64").toString("utf8")); } catch { return out; }
  if (!record(envelope)) return out;
  const payload = envelope["payload"];
  sensitiveStrings(payload, out);
  const inner = record(payload) ? payload["credential"] : undefined;
  if (typeof inner === "string" && inner.startsWith("Payment ")) {
    try {
      const parsed: unknown = Credential.deserialize(inner);
      if (record(parsed)) sensitiveStrings(parsed["payload"], out);
    } catch { /* not an mppx credential: the wire string itself is already excluded */ }
  }
  return out;
}

/** Derived only in memory from the retained quote and this session; never persist this list or phrase. */
export function resultSecrets(raw: JsonValue, credential: string | undefined, phrase: string, txRef?: string): string[] {
  const quote = (raw as { quote: RailQuote }).quote;
  const offer = quote.source.offer;
  // Dynamic quotes carry ownerKey at quote.ownerKey (sealed with the quote; never in a record or summary).
  const ownerKey = (quote as unknown as Record<string, unknown>)["ownerKey"];
  const challenge = (offer.extra as Record<string, unknown>)["challenge"];
  return [...credentialSecrets(credential), phrase, offer.extra.challengeNonce, JSON.stringify(offer),
    typeof challenge === "string" ? challenge : "", typeof ownerKey === "string" ? ownerKey : "", txRef ?? ""].filter(Boolean);
}

/** Inspect decoded JSON strings, including keys, so JSON escaping cannot conceal a secret. */
export function containsResultSecret(body: JsonValue, secrets: readonly string[]): boolean {
  const excluded = secrets.filter(Boolean).flatMap(s => [s, Buffer.from(s).toString("base64"), Buffer.from(s).toString("hex")]);
  const matches = (s: string) => excluded.some(secret => s.includes(secret));
  function visit(value: JsonValue): boolean {
    if (typeof value === "string") return matches(value);
    if (Array.isArray(value)) return value.some(visit);
    return record(value) && Object.entries(value).some(([key, child]) => matches(key) || visit(child as JsonValue));
  }
  return visit(body);
}
