import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { buildRecord, recordHash, assertApproval, render, sanitize } from "../../src/daemon/record.js";
import { h1Quote } from "../harness/router.js";
const identity = () => ({ routerUrl: "https://fixture.invalid/mcp", canonicalResource: { url: "http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource", method: "GET" as const }, address: `0x${"33".repeat(20)}`, ref: "p_aaaaaaaaaaaaa", requestId: randomUUID() });
test("hosted HTTPS transport accepts its separately pinned loopback resource", () => {
  const input = h1Quote();
  input.quote.resource.url = "http://127.0.0.1:8500/v1/routes/md-mpp-eth-snapshot/resource";
  expect(buildRecord(input, { ...identity(), routerUrl: "https://router.subethalabs.com/mcp" }).routerUrl).toBe("https://router.subethalabs.com/mcp");
});
test("immutable complete static H-1 record and deterministic rendering", () => {
  const input = h1Quote(); const r = buildRecord(input, identity());
  expect(r.source.payTo).toBe(input.quote.source.payTo);
  expect(r.destination).toEqual(input.quote.destination);
  expect(r.requestId).toMatch(/^[0-9a-f-]{36}$/);
  const hash = recordHash(r); input.quote.source.offer.amount = "1";
  expect(r.source.amount).toBe("10000"); expect(recordHash(r)).toBe(hash);
  expect(Object.isFrozen(r.source)).toBe(true);
  expect(render(r)).toBe(render(r)); expect(render(r)).not.toContain(input.nextStep);
  expect(sanitize("a\t\u001b\u200b\u202e\u00a0 b\nc")).toBe("ab\nc");
});
// Valid alternatives must pass the same schema first: these test equality, not domain rejection.
const alternatives: [string, string | number][] = [
  ["amount", "10001"], ["payTo", `0x${"44".repeat(20)}`],
  ["expiresAt", Math.floor(Date.now() / 1000) + 180],
  ["challengeNonce", `0x${"cd".repeat(32)}`], ["routeBinding", "different-valid-binding"],
];
for (const [field, value] of alternatives) test(`offer equality rejects valid different ${field}`, () => {
  const input = h1Quote(); const r = buildRecord(input, identity());
  const offer: any = structuredClone(input.quote.source.offer);
  (field in offer ? offer : offer.extra)[field] = value;
  const source = { ...r.source, [field]: value } as typeof r.source;
  const matched = { ...r, source };
  // Positive control proves schema accepts the alternative, and only equality differs.
  expect(() => assertApproval(matched, offer, recordHash(matched), false)).not.toThrow();
  expect(() => assertApproval(r, offer, recordHash(r), false)).toThrow("approval_mismatch");
});
for (const field of ["scheme", "network", "asset", "fundsMoveOnCredential"]) test(`fixed-literal domain rejection: ${field}`, () => {
  const input = h1Quote(); const r = buildRecord(input, identity());
  const offer: any = structuredClone(input.quote.source.offer);
  (field in offer ? offer : offer.extra)[field] = field === "fundsMoveOnCredential" ? true : "other";
  expect(() => assertApproval(r, offer, recordHash(r), false)).toThrow("approval_mismatch");
});
for (const field of ["amount", "payTo", "expiresAt", "challengeNonce", "routeBinding"]) test(`malformed offer rejection: ${field}`, () => {
  const input = h1Quote(); const r = buildRecord(input, identity());
  const offer: any = structuredClone(input.quote.source.offer);
  (field in offer ? offer : offer.extra)[field] = null;
  expect(() => assertApproval(r, offer, recordHash(r), false)).toThrow("approval_mismatch");
});
test("subject mismatch, hash substitution, expiry and session lock fail closed", () => {
  const input = h1Quote(); const r = buildRecord(input, identity());
  expect(() => assertApproval(r, input.quote.source.offer, "0".repeat(64), false)).toThrow("approval_mismatch");
  expect(() => assertApproval(r, input.quote.source.offer, recordHash(r), true)).toThrow("locked");
  expect(() => assertApproval(r, input.quote.source.offer, recordHash(r), false, r.approvalDeadlineMs)).toThrow("approval_expired");
  input.subject.source.amount = "1"; expect(() => buildRecord(input, identity())).toThrow("quote_inconsistent");
});

const mismatches: [string, (v: any) => void][] = [
  ...["quoteId", "paymentId", "routeId", "fundsMoveOnCredential"].map(k => [k, (v: any) => { v.subject[k] = "mismatch"; }] as [string, (v: any) => void]),
  ...["amount", "decimals", "asset", "network", "expiresAt", "offer"].map(k => [`source.${k}`, (v: any) => { v.subject.source[k] = "mismatch"; }] as [string, (v: any) => void]),
  ...["quoted", "asset", "network"].map(k => [`destination.${k}`, (v: any) => { v.subject.destination[k] = "mismatch"; }] as [string, (v: any) => void]),
  ...["required", "boundTo", "deadlineMs"].map(k => [`approval.${k}`, (v: any) => { v.subject.approval = { ...v.subject.approval, [k]: "mismatch" }; }] as [string, (v: any) => void]),
  ["resource", v => { v.subject.resource = { url: "https://wrong.invalid", method: "GET" }; }],
  ["static fees", v => { v.quote.pricing = { upstreamAmount: "1", fee: "1", total: "2" }; }],
  ["destination recipient", v => { v.quote.destination = { ...v.quote.destination, payTo: "bad" }; }],
  ["destination decimals", v => { v.quote.destination = { ...v.quote.destination, decimals: 18 }; }],
  ["destination rail", v => { v.quote.destination = { ...v.quote.destination, rail: "x402" }; }],
  ["destination fingerprint", v => { v.quote.destination = { ...v.quote.destination, quoteFingerprint: "" }; }],
  ["source payTo", v => { v.quote.source.payTo = `0x${"44".repeat(20)}`; }],
  ["deadline beyond offer", v => { v.quote.approval.deadlineMs += 1000; }],
  ["nonce != quoteId", v => { v.quote.quoteId = `0x${"cd".repeat(32)}`; }],
];
for (const [name, change] of mismatches) test(`reject inconsistent ${name}`, () => {
  const v = structuredClone(h1Quote()); change(v);
  expect(() => buildRecord(v, identity())).toThrow("quote_inconsistent");
});
test("configured identity and daemon-only ids are validated", () => {
  for (const change of [{ routerUrl: "https://wrong.invalid/mcp?redirect=1" }, { address: "bad" }, { requestId: "bad" }, { ref: "bad" }]) {
    expect(() => buildRecord(h1Quote(), { ...identity(), ...change })).toThrow("quote_inconsistent");
  }
  const v = h1Quote(); Object.defineProperty(v, "subject", { get() { throw new Error("must not read"); } });
  expect(() => buildRecord(v, identity())).toThrow("quote_inconsistent");
});
test("render sanitizes even hostile record values without adding provider prose", () => {
  const r = buildRecord(h1Quote(), identity());
  const rendered = render({ ...r, routerUrl: "https://fixture.invalid/\u202e\u001b\t", source: { ...r.source, payTo: "a\u200b b" } });
  expect(rendered).not.toMatch(/[\u202e\u001b\t\u200b]/);
  expect(rendered).toContain("Recipient: ab");
});
for (const key of ["rail", "network", "asset", "quoted", "decimals", "payTo", "quoteFingerprint"]) test(`malformed destination ${key} is refused`, () => {
  const input: any = structuredClone(h1Quote()); input.quote.destination[key] = null;
  expect(() => buildRecord(input, identity())).toThrow("quote_inconsistent");
});
