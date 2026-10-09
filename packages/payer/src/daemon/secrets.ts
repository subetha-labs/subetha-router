import { record } from "../router/client.js";
import type { JsonValue } from "../store/ledger.js";
import type { StaticQuote } from "./record.js";

/** Derived only in memory from the retained quote and this session; never persist this list or phrase. */
export function resultSecrets(raw: JsonValue, credential: string | undefined, phrase: string): string[] {
  const quote = (raw as { quote: StaticQuote }).quote;
  // Root MCP quoteUrl producer/consumer carries ownerKey at quote.ownerKey.
  // Static quote validation still rejects it; this does not enable dynamic purchases.
  const ownerKey = (quote as unknown as Record<string, unknown>)["ownerKey"];
  return [credential ?? "", phrase, quote.source.offer.extra.challengeNonce,
    JSON.stringify(quote.source.offer), typeof ownerKey === "string" ? ownerKey : ""].filter(Boolean);
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
