/** Synthetic values only; test names and assertions never print the secret. */
export const encodings = ["plain", "base64", "hex"] as const;
export function encodeSecret(value: string, encoding: typeof encodings[number]): string {
  return encoding === "plain" ? value : Buffer.from(value).toString(encoding);
}
export function secretBody(value: string, location: "key" | "value") {
  return { nested: [{ items: location === "key" ? { [value]: "ordinary" } : { text: value } }] };
}
export function containsSecret(value: unknown, secret: string): boolean {
  const needles = encodings.map(encoding => encodeSecret(secret, encoding));
  function scan(v: unknown): boolean {
    if (typeof v === "string") return needles.some(s => v.includes(s));
    if (Array.isArray(v)) return v.some(scan);
    return !!v && typeof v === "object" && Object.entries(v).some(([k, child]) => scan(k) || scan(child));
  }
  return scan(value);
}
