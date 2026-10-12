/** SR-R4 / AC-R4b (docs/payer-rails-design.md): MPP secrets (challenge text, inner mppx wire, signed transaction, ownerKey) never pass as results, while ordinary paid bodies do. */
import { Challenge, Credential } from "mppx";
import { generatePrivateKey } from "viem/accounts";
import { expect, test } from "vitest";
import { containsResultSecret, credentialSecrets, resultSecrets } from "../../src/daemon/secrets.js";
import { jsonCopy } from "../../src/daemon/record.js";
import { projectResult } from "../../src/daemon/purchase.js";
import { buildRecord } from "../../src/daemon/record.js";
import { HOSTED_ROUTER_URL } from "../../src/router/identity.js";
import { createX402Payer } from "../../src/vendor/x402-payer.js";
import { railQuote } from "../harness/router.js";

const envelope = (payload: Record<string, unknown>, accepted: unknown) => Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload }), "utf8").toString("base64");
const EVM = `0x${"33".repeat(20)}`, SOLANA = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";

test("credentialSecrets: the envelope, the payment authority in the payload, and the strings inside an inner mppx credential (the signed transaction)", () => {
  const tx = Buffer.from("fully-signed-solana-transaction-bytes-of-realistic-length").toString("base64");
  const challenge = (railQuote("solmpp").quote.source.offer.extra as { challenge: string }).challenge;
  const inner = Credential.serialize({ challenge: Challenge.deserialize(challenge), payload: { type: "transaction", transaction: tx } } as never);
  const credential = envelope({ challengeNonce: "n", credential: inner }, { scheme: "solana/charge" });
  const secrets = credentialSecrets(credential);
  expect(secrets).toContain(credential);
  expect(secrets).toContain(inner);
  expect(secrets).toContain(tx);
  // Not an envelope at all: just the credential itself.
  expect(credentialSecrets("plain")).toEqual(["plain"]);
  expect(credentialSecrets(undefined)).toEqual([]);
});

test("a real EIP-3009 credential: the signature is a secret; its public authorization metadata and property names are not (ordinary paid bodies pass)", async () => {
  const base = railQuote("base"); const offer = base.quote.source.offer as any;
  const credential = await createX402Payer(generatePrivateKey()).credentialFor(offer, 84532);
  const decoded = JSON.parse(Buffer.from(credential, "base64").toString("utf8"));
  const secrets = resultSecrets(jsonCopy(base), credential, "a-phrase");
  expect(secrets).toContain(decoded.payload.signature);
  for (const notSecret of ["0", "to", "from", "value", "validAfter", "validBefore", decoded.payload.authorization.value, decoded.payload.authorization.validAfter]) expect(secrets).not.toContain(notSecret);
  // Realistic paid results are delivered (Codex implementation review #2).
  const r = buildRecord(base, { routerUrl: HOSTED_ROUTER_URL, address: EVM, wallets: { eip155: EVM, solana: SOLANA }, ref: "p_aaaaaaaaaaaaa", requestId: "6d3f1c0e-5b7a-4c2d-9e8f-0a1b2c3d4e5f" });
  // Long PUBLIC values (a 42-char address, a 66-char unrelated tx hash, the payer's own address) are not secrets either (Codex I-2 note).
  const unrelatedHash = `0x${"5e".repeat(32)}`;
  for (const body of [{ value: 123 }, { data: { price: "3000.12", to: "0xabc", from: "0xdef" } }, { fetchedAt: "2026-10-12T10:00:00Z", priceUsdcPerWeth: "3000.000000", disclaimer: "spot reference only" }, { nonce: "0", validAfter: "0", amount: "10000" },
    { settlementTx: unrelatedHash, payer: decoded.payload.authorization.from, recipient: decoded.payload.authorization.to, pool: "0x1234567890abcdef1234567890abcdef12345678" }]) {
    expect(containsResultSecret(body, secrets), JSON.stringify(body)).toBe(false);
    expect(projectResult(r, { ok: true, outcome: "delivered", paymentId: r.paymentId, snapshot: body, contentType: "application/json" }, secrets)).toMatchObject({ outcome: "delivered", result: { body } });
  }
  // The signature itself, however encoded, is still refused.
  for (const encoded of [decoded.payload.signature, Buffer.from(decoded.payload.signature).toString("base64"), Buffer.from(decoded.payload.signature).toString("hex")]) {
    expect(containsResultSecret({ leak: encoded }, secrets)).toBe(true);
    expect(() => projectResult(r, { ok: true, outcome: "delivered", paymentId: r.paymentId, snapshot: { leak: encoded }, contentType: "application/json" }, secrets)).toThrow("response_unreadable");
  }
});

test("resultSecrets covers challenge text, ownerKey and txRef; a body carrying any of them (plain, base64, hex, as a key) is refused", () => {
  const tempo = railQuote("tempo"); const dyn = railQuote("dyn-x402-to-mpp");
  const challenge = (tempo.quote.source.offer.extra as { challenge: string }).challenge;
  const ownerKey = (dyn.quote as { ownerKey: string }).ownerKey;
  const txRef = `0x${"ab".repeat(32)}`;
  const inner = `Payment ${Buffer.from("tempo-wire-of-a-realistic-length-xxxxxxxx").toString("base64")}`;
  const credential = envelope({ challengeNonce: tempo.quote.quoteId, credential: inner }, tempo.quote.source.offer);
  const secrets = [...resultSecrets(jsonCopy(tempo), credential, "phrase", txRef), ...resultSecrets(jsonCopy(dyn), undefined, "phrase")];
  for (const secret of [challenge, ownerKey, txRef, inner, credential, "phrase"]) {
    expect(secrets).toContain(secret);
    for (const encoded of [secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("hex")]) {
      expect(containsResultSecret({ data: { nested: [encoded] } }, secrets), encoded.slice(0, 16)).toBe(true);
      expect(containsResultSecret({ [encoded]: 1 }, secrets), encoded.slice(0, 16)).toBe(true);
    }
  }
  expect(containsResultSecret({ price: "123", list: ["ordinary", { deep: true }] }, secrets)).toBe(false);
});
