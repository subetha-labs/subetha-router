import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { containsResultSecret, resultSecrets } from "../../src/daemon/secrets.js";
import { projectResult } from "../../src/daemon/purchase.js";
import { buildRecord, jsonCopy } from "../../src/daemon/record.js";
import { h1Quote } from "../harness/router.js";
import { encodings, encodeSecret, secretBody } from "../harness/secret-cases.js";

for (const encoding of encodings)
for (const location of ["key", "value"] as const) test(`real quote.ownerKey location excluded from projected body: ${encoding}/${location}`, () => {
  const raw = h1Quote(), identity = { routerUrl: "https://fixture.invalid/mcp", canonicalResource: raw.quote.resource as any, address: `0x${"33".repeat(20)}`, ref: "p_aaaaaaaaaaaaa", requestId: randomUUID() };
  const r = buildRecord(raw, identity);
  const key = "synthetic-owner-only-key-0123456789";
  const retained = jsonCopy({ ...raw, quote: { ...raw.quote, ownerKey: key } });
  // Real MCP quoteUrl location, not a new public field or dynamic route authorization.
  expect(() => buildRecord(retained, identity)).toThrow("quote_inconsistent");
  const secrets = resultSecrets(retained, "fixture-credential", 'session"phrase\\safe');
  expect(secrets.includes(key)).toBe(true);
  const response = { ok: true, outcome: "delivered", paymentId: r.paymentId, contentType: "application/json", snapshot: secretBody(encodeSecret(key, encoding), location) };
  expect(() => projectResult(r, response, secrets)).toThrow("response_unreadable");
  const body = { nested: [null, 3, true, { 'ordinary"key\\': "safe value" }] };
  expect(projectResult(r, { ...response, snapshot: body }, secrets).result?.body).toEqual(body);
});

test("decoded strings include deeply nested array values and object keys, with ordinary controls", () => {
  const secret = 'synthetic"phrase\\tail';
  for (const encoding of encodings) for (const location of ["key", "value"] as const) {
    expect(containsResultSecret(jsonCopy(secretBody(encodeSecret(secret, encoding), location)), [secret])).toBe(true);
  }
  expect(containsResultSecret({ array: [null, false, 42, "ordinary"], sealed: "ordinary" }, [secret, ""])).toBe(false);
});
