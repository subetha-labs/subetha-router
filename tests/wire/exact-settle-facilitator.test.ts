/**
 * SubEtha 自前の settle facilitator（`docs/exact-settle-facilitator-{requirements,design}.md`）の wire（AC-9・AC-11・AC-14）:
 * 実 `startRouter` の child に token のファイルを渡し、`settle_pending` のあとに reconcile で成立する購入を、quote の入口と標準の x402 入口で確かめる。
 */
import { readFile, writeFile, mkdtemp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

vi.setConfig({ testTimeout: 90_000 });

import { BEARER, CHAIN_ID, credentialOf, principalHeaders, purchaseOf, quoteOf, ROUTE_ID, startExactHarness, statusOf, ZUSDC, type ExactHarness } from "../fixtures/subetha-exact-harness.js";

const SETTLE_TOKEN = "5e".repeat(32);
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const started: ExactHarness[] = [];
/** 診断の記録の directory（token のファイルも同じ場所にある）。 */
const diagnosticsOf = new Map<ExactHarness, string>();
afterEach(async () => {
  for (const h of started.splice(0)) await h.stopAll();
});
async function boot(): Promise<ExactHarness> {
  await mkdir(runtimeRoot, { recursive: true });
  const dir = await mkdtemp(path.join(runtimeRoot, "sf-token-"));
  const file = path.join(dir, "settle.token");
  await writeFile(file, `${SETTLE_TOKEN}\n`, { mode: 0o600 });
  const h = await startExactHarness({ facilitatorArgs: ["--settle-bearer", SETTLE_TOKEN], env: { ROUTER_SUBETHA_EXACT_SETTLE_TOKEN_FILE: file, SUBETHA_DIAGNOSTICS_PATH: path.join(dir, "diagnostics.ndjson") } });
  diagnosticsOf.set(h, dir);
  started.push(h);
  return h;
}
type Calls = { byRoute: Record<string, number>; byOrder: Record<string, Record<string, number>>; submitWithAuthorization: number; submitWithProviderToken: number; tenantWithSettleToken: number };
const callsOf = async (h: ExactHarness): Promise<Calls> => (await h.calls()) as Calls;
/** Router の作業 directory の全部のファイル（token のファイルを除く）と stderr に、両方の token が無いこと。 */
async function expectNoTokens(h: ExactHarness): Promise<void> {
  let text = h.router.stderr();
  const dir = diagnosticsOf.get(h)!;
  // 診断は非同期に書かれる: settle の段の行が現れるまで待つ（空の記録に「無い」と言わない）。
  let diag = "";
  const until = Date.now() + 10_000;
  while (!diag.includes("source_settle") && Date.now() < until) {
    diag = "";
    for (const name of (await readdir(dir)).filter((n) => n.startsWith("diagnostics"))) diag += await readFile(path.join(dir, name), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(diag).toContain("source_settle");
  text += diag;
  for (const name of await readdir(h.workDir, { recursive: true, withFileTypes: true })) {
    if (name.isFile() && name.name !== "provider.token") text += await readFile(path.join(name.parentPath, name.name), "utf8");
  }
  for (const secret of [BEARER, SETTLE_TOKEN]) expect(text.includes(secret)).toBe(false);
}

test("AC-11・AC-9: quote の入口で settle_pending → reconcile が成立 → delivered。送信 1、token は settle 先だけ。再起動（token なしの構成を含む）のあとも同じ注文に送らない", async () => {
  const h = await boot();
  await h.setMode("submit", "own-paid:settle_pending");
  await h.setMode("reconcile", "pending-first:1");
  const quote = await quoteOf(h, "req-1");
  expect(quote.status).toBe(200);
  const credential = await credentialOf(h, quote.body.source.offer);
  const purchase = await purchaseOf(h, quote.body, "req-1", credential);
  expect(purchase.status).toBe(200);
  expect((await statusOf(h, quote.body.paymentId)).body).toMatchObject({ status: "delivered" });
  const orderId = quote.body.source.offer.extra.challengeNonce;
  const calls = await callsOf(h);
  expect([calls.byOrder[orderId]!["submit"], calls.byOrder[orderId]!["reconcile"]]).toEqual([1, 2]);
  expect([calls.submitWithAuthorization, calls.submitWithProviderToken, calls.tenantWithSettleToken]).toEqual([1, 0, 0]);
  expect((await h.ledger()).find((r) => r.event === "submit" && r.patch["phase"] === "answered")!.patch).toMatchObject({ success: false, reason: "settle_pending" });

  // 成立しなかった注文は unknown。再起動（同じ構成 → token なしの構成）のあとに同じ credential を出しても送らない。
  await h.setMode("submit", "own:settle_not_accepted:blocked");
  const second = await quoteOf(h, "req-2");
  const secondCredential = await credentialOf(h, second.body.source.offer);
  await purchaseOf(h, second.body, "req-2", secondCredential);
  const secondOrder = second.body.source.offer.extra.challengeNonce;
  expect((await statusOf(h, second.body.paymentId)).body).toMatchObject({ status: "unknown" });
  // 送った process 自身の stderr（再起動の前）。成立した購入と、断られた購入の後。
  await expectNoTokens(h);
  await h.setMode("submit", "accepted");
  for (const env of [{}, { ROUTER_SUBETHA_EXACT_SETTLE_TOKEN_FILE: "" }]) {
    await h.restartRouter({ env });
    await purchaseOf(h, second.body, "req-2", secondCredential);
    expect((await callsOf(h)).byOrder[secondOrder]!["submit"]).toBe(1);
    await expectNoTokens(h);
  }
});

test("AC-11: 標準の x402 入口でも settle_pending → 200", async () => {
  const h = await boot();
  await h.setMode("submit", "own-paid:settle_pending");
  await h.setMode("reconcile", "pending-first:1");
  const url = `${h.router.baseUrl}/x402/v1/routes/${ROUTE_ID}/resource`;
  const challenge = await fetch(url, { headers: principalHeaders() });
  expect(challenge.status).toBe(402);
  const accepted = (decodePaymentRequiredHeader(challenge.headers.get("payment-required")!) as unknown as { accepts: Record<string, unknown>[] }).accepts[0]!;
  const account = privateKeyToAccount(generatePrivateKey());
  const extra = accepted["extra"] as { name: string; version: string };
  const authorization = { from: account.address, to: accepted["payTo"] as `0x${string}`, value: String(accepted["amount"]), validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + Number(accepted["maxTimeoutSeconds"])), nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}` };
  const signature = await account.signTypedData({ domain: { name: extra.name, version: extra.version, chainId: CHAIN_ID, verifyingContract: ZUSDC as `0x${string}` }, types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] }, primaryType: "TransferWithAuthorization", message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) } });
  const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { authorization, signature } }), "utf8").toString("base64");
  const paid = await fetch(url, { headers: { ...principalHeaders(), "payment-signature": header } });
  expect(paid.status).toBe(200);
  const calls = await callsOf(h);
  expect([calls.byRoute["submit"], calls.submitWithAuthorization, calls.submitWithProviderToken, calls.tenantWithSettleToken]).toEqual([1, 1, 0, 0]);
  await expectNoTokens(h);
});
