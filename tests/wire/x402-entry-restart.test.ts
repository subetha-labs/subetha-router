/**
 * 標準の x402 クライアント用の入口の再起動（`docs/x402-standard-entry-design.md` §9 T-e、要件 AC-9）。
 * 止める点: 402 を返した後、credential を結び付けた後・verify の前、verify を送った後、settle を送って応答を失った後、settle を記録した後。
 * どの点でも: `payTo` からの対応と結び付きが残る、同じ credential の再送が同じ paymentId の今の状態を返す、違う credential は 409、
 * settle と上流への支払いが 2 回起きない、開示が失われない。配達の成功や確定は要件にしない（前スライスの復旧の規則のまま）。
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { afterEach, expect, test, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

vi.setConfig({ testTimeout: 120_000 });

import { CHAIN_ID, principalHeaders, ROUTE_ID, startExactHarness, statusOf, ZUSDC, type ExactHarness } from "../fixtures/subetha-exact-harness.js";

const started: ExactHarness[] = [];
afterEach(async () => {
  for (const h of started.splice(0)) await h.stopAll();
});
async function boot(options: Parameters<typeof startExactHarness>[0] = {}): Promise<ExactHarness> {
  const h = await startExactHarness(options);
  started.push(h);
  return h;
}
async function waitFor(condition: () => Promise<boolean> | boolean, label: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}
const entryUrl = (h: ExactHarness): string => `${h.router.baseUrl}/x402/v1/routes/${ROUTE_ID}/resource`;
const AUTH_TYPES = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] } as const;
type Accepted = { payTo: `0x${string}`; amount: string; maxTimeoutSeconds: number; extra: { name: string; version: string } } & Record<string, unknown>;

async function challengeOf(h: ExactHarness): Promise<Accepted> {
  const response = await fetch(entryUrl(h), { headers: principalHeaders() });
  expect(response.status).toBe(402);
  const required = JSON.parse(Buffer.from(response.headers.get("payment-required")!, "base64").toString("utf8")) as { accepts: Accepted[] };
  return required.accepts[0]!;
}
/** 標準クライアントと同じ形の credential（validAfter 0、validBefore = now + maxTimeoutSeconds、乱数の nonce）。 */
async function sign(accepted: Accepted, account = privateKeyToAccount(generatePrivateKey())): Promise<{ header: string; validBefore: number }> {
  const validBefore = Math.floor(Date.now() / 1000) + accepted.maxTimeoutSeconds;
  const authorization = { from: account.address, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: String(validBefore), nonce: `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}` };
  const signature = await account.signTypedData({
    domain: { name: accepted.extra.name, version: accepted.extra.version, chainId: CHAIN_ID, verifyingContract: ZUSDC as `0x${string}` },
    types: AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(validBefore) },
  });
  return { header: Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { authorization, signature } }), "utf8").toString("base64"), validBefore };
}
const pay = (h: ExactHarness, header: string) => fetch(entryUrl(h), { headers: { ...principalHeaders(), "PAYMENT-SIGNATURE": header } });
const upstreamPays = async (h: ExactHarness) => ((await (await fetch(`${h.upstream.baseUrl}/calls`)).json()) as { payCalls: number }).payCalls;
const noChallenge = (response: Response): void => {
  expect(response.status).not.toBe(402);
  expect(response.headers.get("payment-required")).toBeNull();
};
/** 再起動の後の共通の確かめ: 違う credential は 409 で facilitator を呼ばない。 */
async function conflictStays(h: ExactHarness, accepted: Accepted): Promise<void> {
  const before = await h.calls();
  const other = await pay(h, (await sign(accepted)).header);
  expect([other.status, ((await other.json()) as Record<string, unknown>)["error"]]).toEqual([409, "credential_conflict"]);
  noChallenge(other);
  const after = await h.calls();
  expect([after.byRoute["verify"], after.byRoute["settle"]]).toEqual([before.byRoute["verify"], before.byRoute["settle"]]);
}

test("402 を返した後で止まる: 対応と開示が残り、その offer は次の GET で再び見せられず、後から届いた最初の credential は普通に買える", async () => {
  const h = await boot();
  const accepted = await challengeOf(h);
  await h.killRouter();
  await h.restartRouter();
  // 次の GET は別の注文（同じ payTo を 2 度見せない）。
  expect((await challengeOf(h)).payTo).not.toBe(accepted.payTo);
  const paid = await pay(h, (await sign(accepted)).header);
  expect(paid.status).toBe(200);
  expect(await upstreamPays(h)).toBe(1);
});

test("結び付けた後・verify の前で止まる: 再起動の後、同じ credential の再送が続きを実行して delivered。違う credential は 409。verify・settle・上流は 1 回ずつ", async () => {
  const h = await boot({ skipRouter: true });
  await h.restartRouter({ stopAt: "after_credential_bound" });
  const accepted = await challengeOf(h);
  const credential = await sign(accepted);
  const first = pay(h, credential.header).catch(() => undefined);
  await waitFor(() => existsSync(h.signalPath), "stop point after_credential_bound");
  expect((JSON.parse(await readFile(h.signalPath, "utf8")) as { point: string }).point).toBe("after_credential_bound");
  expect((await h.calls()).byRoute["verify"] ?? 0).toBe(0);
  await h.killRouter();
  await first;
  await rm(h.signalPath);
  await h.restartRouter();
  const bound = (await h.journal()).filter((r) => r.event === "source_credential_bound");
  expect(bound).toHaveLength(1);
  const paymentId = bound[0]!.paymentId;
  // 結び付いた credential の開示が再起動の後も残る（注文の期限ではなく、その credential の validBefore）。
  expect((await statusOf(h, paymentId)).body["source"]).toMatchObject({ mayStillSettleUntil: credential.validBefore, awaitingPaymentDoesNotMeanUnpaid: true });
  await conflictStays(h, accepted);
  const resumed = await pay(h, credential.header);
  expect([resumed.status, resumed.headers.get("x-router-payment-id")]).toEqual([200, paymentId]);
  const calls = await h.calls();
  expect([calls.byRoute["verify"], calls.byRoute["settle"]]).toEqual([1, 1]);
  expect(await upstreamPays(h)).toBe(1);
  expect((await h.journal()).filter((r) => r.event === "source_credential_bound")).toHaveLength(1);
});

test("verify を送った後で止まる／settle の応答を失って止まる: unknown のまま。再送は記録を返し、verify・settle を呼び直さず、上流に払わない", async () => {
  for (const point of ["verify", "settle"] as const) {
    const h = await boot();
    await h.setMode(point, point === "verify" ? "slow:60000" : "timeout");
    const accepted = await challengeOf(h);
    const credential = await sign(accepted);
    const first = pay(h, credential.header).catch(() => undefined);
    await waitFor(async () => ((await h.calls()).byRoute[point] ?? 0) === 1, `fixture ${point} called`);
    await h.killRouter();
    await first;
    await h.setMode(point, point === "verify" ? "ok" : "accepted");
    await h.restartRouter();
    const paymentId = (await h.journal()).find((r) => r.event === "source_credential_bound")!.paymentId;
    const before = await h.calls();
    const resent = await pay(h, credential.header);
    const body = (await resent.json()) as Record<string, unknown>;
    expect([point, resent.status, body["error"], body["paymentId"], body["status"]]).toEqual([point, 409, "payment_unresolved", paymentId, "unknown"]);
    noChallenge(resent);
    expect((body["source"] as Record<string, unknown>)["mayStillSettleUntil"], point).toBe(credential.validBefore);
    await conflictStays(h, accepted);
    const after = await h.calls();
    expect([point, after.byRoute["verify"], after.byRoute["settle"] ?? 0]).toEqual([point, before.byRoute["verify"], before.byRoute["settle"] ?? 0]);
    expect(await upstreamPays(h), point).toBe(0);
    await h.stopAll();
    started.splice(started.indexOf(h), 1);
  }
});

test("settle を記録した後で止まる: 支払いは成立・配達は未完（409 paid_no_data + PAYMENT-RESPONSE）。開示は出さず、settle も上流も呼び直さない", async () => {
  const h = await boot({ skipRouter: true });
  await h.restartRouter({ stopAt: "after_source_settled" });
  const accepted = await challengeOf(h);
  const credential = await sign(accepted);
  const first = pay(h, credential.header).catch(() => undefined);
  await waitFor(() => existsSync(h.signalPath), "stop point after_source_settled");
  await h.killRouter();
  await first;
  await rm(h.signalPath);
  await h.restartRouter();
  const before = await h.calls();
  const resent = await pay(h, credential.header);
  const body = (await resent.json()) as Record<string, unknown>;
  expect([resent.status, body["error"]]).toEqual([409, "paid_no_data"]);
  noChallenge(resent);
  expect(JSON.parse(Buffer.from(resent.headers.get("payment-response")!, "base64").toString("utf8"))).toMatchObject({ success: true, transaction: (body["source"] as { txRef: string }).txRef });
  expect(body["source"]).not.toHaveProperty("mayStillSettleUntil");
  await conflictStays(h, accepted);
  expect((await h.calls()).byRoute["settle"]).toBe(before.byRoute["settle"]);
  expect((await h.calls()).byRoute["settle"]).toBe(1);
  expect(await upstreamPays(h)).toBe(0);
});
