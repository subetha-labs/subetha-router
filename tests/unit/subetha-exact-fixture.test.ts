/**
 * 合成 facilitator 自身が facilitator の契約の表どおりか（`docs/subetha-exact-inbound-design.md` §7、NFR-4、タスク T-3。実装レビュー 2 の #1〜#4 を反映）。
 * 期待値は protocol `68e061b` の source から独立に書く（fixture の仮定を写さない）: `apps/facilitator/src/exact-routes.ts`、`multi/multi-routes.ts`、
 * `packages/zerc20-v2-adapter/src/{burn-sale-backend,exact-settle,tenant-runtime}.ts`。
 * 使い捨ての鍵で実 EIP-3009 の署名を作り、署名優先の経路を実際に通す（鍵は試験の中だけ。資金は無い）。
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { privateKeyToAccount } from "viem/accounts";

import { createX402Payer } from "../../tools/x402-payer.js";
import { createSubethaExactFacilitator, type FacilitatorFixture } from "../fixtures/subetha-exact-facilitator.js";

const PROVIDER = "router-test";
const BEARER = "fixture-provider-token";
const CHAIN_ID = 84532;
const ASSET = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const REQUESTER = `0x${"a1".repeat(32)}`;
const RESOURCE = `0x${"b2".repeat(32)}`;
const OTHER_REQUESTER = `0x${"c3".repeat(32)}`;
const JSON_HEADERS = { "content-type": "application/json" };

let fixture: FacilitatorFixture;
let base: string;
let clock = 1_800_000_000;
const payerKey = generatePrivateKey();
const payer = createX402Payer(payerKey);
const otherPayer = createX402Payer(generatePrivateKey());
/** `validAfter` を指定して署名する（`tools/x402-payer.ts` は 0 に固定するので、未来の validAfter は手で署名する）。 */
async function signedWith(view: Record<string, unknown>, validAfter: number, validBefore: number) {
  const requirements = view["requirements"] as Record<string, unknown>;
  const account = privateKeyToAccount(payerKey);
  const authorization = { from: account.address, to: requirements["payTo"] as `0x${string}`, value: BigInt(requirements["amount"] as string), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce: view["orderId"] as `0x${string}` };
  const signature = await account.signTypedData({
    domain: { name: "zERC20 USD Coin", version: "1", chainId: CHAIN_ID, verifyingContract: ASSET },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });
  return { x402Version: 2, accepted: { ...requirements }, payload: { challengeNonce: view["orderId"], signature, authorization: { from: authorization.from, to: authorization.to, value: authorization.value.toString(), validAfter: String(validAfter), validBefore: String(validBefore), nonce: authorization.nonce } } };
}

async function bootFixture(ttlSeconds = 300): Promise<void> {
  fixture = createSubethaExactFacilitator({ providerId: PROVIDER, bearer: BEARER, chainId: CHAIN_ID, asset: ASSET, domainName: "zERC20 USD Coin", domainVersion: "1", ttlSeconds, now: () => clock });
  base = `${await fixture.listen()}/p/${PROVIDER}`;
}
beforeEach(async () => {
  clock = 1_800_000_000;
  await bootFixture();
});
afterEach(async () => {
  await fixture.close();
});

const auth = { authorization: `Bearer ${BEARER}`, ...JSON_HEADERS };
async function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; root?: boolean; rawHeaders?: Record<string, string> } = {}) {
  const method = init.method ?? "GET";
  const headers = init.rawHeaders ?? { ...auth, ...init.headers };
  const response = await fetch(`${init.root === true ? fixture.baseUrl : base}${path}`, { method, headers, ...(init.body === undefined || method === "GET" ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }) });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, json: json as Record<string, unknown>, text };
}
const createOrder = (amount = "2000", requesterDigest = REQUESTER) => call("/exact/orders", { method: "POST", body: { amount, resourceDigest: RESOURCE, requesterDigest } });
/** Router の `npm run sign` と同じ封筒（`tools/x402-payer.ts`）から facilitator の `paymentPayload` を作る。 */
async function payloadFor(view: Record<string, unknown>, options: { patch?: (offer: Record<string, unknown>) => Record<string, unknown>; signer?: typeof payer; accepted?: (r: Record<string, unknown>) => Record<string, unknown> } = {}) {
  const requirements = view["requirements"] as Record<string, unknown>;
  const status = view["status"] as Record<string, unknown>;
  const patch = options.patch ?? ((o) => o);
  const offer = patch({ ...requirements, extra: { ...(requirements["extra"] as Record<string, unknown>), challengeNonce: view["orderId"], expiresAt: status["expiresAt"], routeBinding: "r" } });
  const credential = JSON.parse(Buffer.from(await (options.signer ?? payer).credentialFor(offer as never, CHAIN_ID), "base64").toString("utf8")) as Record<string, unknown>;
  return { x402Version: 2, accepted: (options.accepted ?? ((r) => r))({ ...requirements }), payload: credential["payload"] };
}
const settleOf = (id: string, paymentPayload: unknown, requesterDigest = REQUESTER, extra: Record<string, unknown> = {}) => call(`/exact/orders/${id}/settle`, { method: "POST", body: { paymentPayload, requesterDigest, resourceDigest: RESOURCE, ...extra } });
const releaseOf = (id: string, requesterDigest = REQUESTER) => call(`/exact/orders/${id}/release`, { method: "POST", body: { requesterDigest } });
const completeOf = (id: string, deliveryKey: string, outcome: string) => call(`/exact/orders/${id}/complete`, { method: "POST", body: { deliveryKey, outcome } });
const statusOf = async (id: string) => (await call(`/exact/orders/${id}`)).json["status"] as Record<string, unknown>;
async function paidOrder(requester = REQUESTER): Promise<{ id: string; view: Record<string, unknown>; tx: string }> {
  const view = (await createOrder("2000", requester)).json;
  const id = view["orderId"] as string;
  const settled = await settleOf(id, await payloadFor(view), requester);
  expect(settled.json["outcome"]).toBe("accepted");
  return { id, view, tx: settled.json["transaction"] as string };
}

describe("tenant の層（multi-routes.ts）", () => {
  test("Bearer 無し・違い → 401 {error:unauthorized}。知らない tenant → 404 {error:unknown}。hex64 で無い注文 id → どの注文 route でも 404 unknown-order（reconcile も）", async () => {
    expect(await call("/exact/orders", { method: "POST", rawHeaders: JSON_HEADERS, body: {} })).toMatchObject({ status: 401, json: { error: "unauthorized" } });
    expect(await call("/exact/orders", { method: "POST", headers: { authorization: "Bearer nope" }, body: {} })).toMatchObject({ status: 401, json: { error: "unauthorized" } });
    expect(await call("/exact/orders", { method: "POST", headers: { authorization: BEARER }, body: {} })).toMatchObject({ status: 401, json: { error: "unauthorized" } });
    expect(await call(`/p/other/exact/orders/${REQUESTER}`, { root: true })).toMatchObject({ status: 404, json: { error: "unknown" } });
    for (const [method, path] of [["GET", `/exact/orders/${REQUESTER}`], ["POST", `/exact/orders/${REQUESTER}/settle`], ["POST", `/exact/orders/${REQUESTER}/release`], ["POST", `/exact/orders/${REQUESTER}/complete`], ["POST", `/exact/orders/${REQUESTER}/reconcile`]] as const) {
      expect(await call(path, { method, body: {} }), path).toMatchObject({ status: 404, json: { error: "unknown-order" } });
    }
  });
  test("壊れた id は handler の 400（malformed order id／expect …）。壊れた requester digest も 400", async () => {
    expect(await call("/exact/orders/not-hex")).toMatchObject({ status: 400, json: { error: "malformed order id" } });
    expect(await call("/exact/orders/0x12/settle", { method: "POST", body: {} })).toMatchObject({ status: 400, json: { error: "expect { paymentPayload, requesterDigest, resourceDigest }" } });
    expect(await call("/exact/orders/0x12/release", { method: "POST", body: {} })).toMatchObject({ status: 400, json: { error: "expect { requesterDigest }" } });
    expect(await call("/exact/orders/0x12/complete", { method: "POST", body: {} })).toMatchObject({ status: 400, json: { error: "expect { deliveryKey, outcome: 'delivered' | 'failed' }" } });
    expect(await call(`/exact/requesters/nope/orders?resourceDigest=${RESOURCE}`)).toMatchObject({ status: 400, json: { error: "expect requester and resource digests" } });
    expect(await call(`/exact/requesters/${REQUESTER}/orders`)).toMatchObject({ status: 400, json: { error: "expect requester and resource digests" } });
  });
  test("Express の JSON: content-type が application/json で無ければ本文は {}（= 400 expect）、primitive は 400 invalid_json、壊れた JSON も 400、65 536 bytes は通り 65 537 は 413 too_large", async () => {
    const body = JSON.stringify({ amount: "2000", resourceDigest: RESOURCE, requesterDigest: REQUESTER });
    expect(await call("/exact/orders", { method: "POST", rawHeaders: { authorization: `Bearer ${BEARER}`, "content-type": "text/plain" }, body })).toMatchObject({ status: 400, json: { error: "expect { amount: atomic string, resourceDigest: 0x32B, requesterDigest: 0x32B }" } });
    expect(await call("/exact/orders", { method: "POST", body: "42" })).toMatchObject({ status: 400, json: { error: "invalid_json" } });
    expect(await call("/exact/orders", { method: "POST", body: "{not json" })).toMatchObject({ status: 400, json: { error: "invalid_json" } });
    const pad = (n: number) => JSON.stringify({ pad: "x".repeat(n) });
    const exactly = pad(65_536 - JSON.stringify({ pad: "" }).length);
    expect(exactly.length).toBe(65_536);
    expect((await call("/exact/orders", { method: "POST", body: exactly })).status).toBe(400);
    expect(await call("/exact/orders", { method: "POST", body: `${exactly} ` })).toMatchObject({ status: 413, json: { error: "too_large" } });
  });
});

describe("注文の作成と再利用（exact-routes.ts / burn-sale-backend.ts）", () => {
  test("201 の orderView: orderId・status（createdAt 無し）・requirements（maxTimeoutSeconds = floor(ttl/2)）・binding。額は BigInt で正規化", async () => {
    const first = await createOrder("002000");
    expect(first.status).toBe(201);
    const view = first.json;
    const status = view["status"] as Record<string, unknown>;
    expect(view).toMatchObject({ existing: false, binding: { requesterDigest: REQUESTER, resourceDigest: RESOURCE } });
    expect(status).toMatchObject({ kind: "zerc20-v2-burn-sale", challengeNonce: view["orderId"], state: "open", amount: "2000", chainId: CHAIN_ID, token: ASSET, expiresAt: clock + 300, receipt: { level: "none" }, release: { policy: "finalized", state: "none", deliveryKey: view["orderId"] }, gate: "awaiting-payment" });
    expect(status).not.toHaveProperty("createdAt");
    expect(status["release"]).not.toHaveProperty("txRef");
    expect(view["requirements"]).toEqual({ scheme: "exact", network: `eip155:${CHAIN_ID}`, asset: ASSET, amount: "2000", payTo: status["saleId"], maxTimeoutSeconds: 150, extra: { name: "zERC20 USD Coin", version: "1" } });
    expect(view["orderId"]).toMatch(/^0x[0-9a-f]{64}$/);
  });
  test("奇数の TTL は floor（301 → 150）", async () => {
    await fixture.close();
    await bootFixture(301);
    expect(((await createOrder()).json["requirements"] as Record<string, unknown>)["maxTimeoutSeconds"]).toBe(150);
  });
  test("同じ (requester, resource) は額が違っても 200 existing で同じ注文（元の額のまま）。別の requester は 201 の別注文。照会は未解決だけ", async () => {
    const view = (await createOrder()).json;
    const again = await createOrder("3000");
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ existing: true, orderId: view["orderId"] });
    expect((again.json["requirements"] as Record<string, unknown>)["amount"]).toBe("2000");
    const other = await createOrder("2000", OTHER_REQUESTER);
    expect(other.status).toBe(201);
    expect(other.json["orderId"]).not.toBe(view["orderId"]);
    expect(fixture.calls.byRoute["create"]).toBe(3);
    const listed = await call(`/exact/requesters/${REQUESTER}/orders?resourceDigest=${RESOURCE}`);
    expect((listed.json["orders"] as Record<string, unknown>[]).map((o) => o["orderId"])).toEqual([view["orderId"]]);
  });
  test("本文の形 400、額の方針 403、busy／paused 503 + Retry-After 30、rate-limited 429、slow:<ms>、lose-response は作ってから切る、existing-mismatch:*", async () => {
    expect(await call("/exact/orders", { method: "POST", body: { amount: 2000, resourceDigest: RESOURCE, requesterDigest: REQUESTER } })).toMatchObject({ status: 400, json: { error: "expect { amount: atomic string, resourceDigest: 0x32B, requesterDigest: 0x32B }" } });
    expect(await createOrder("1000001")).toMatchObject({ status: 403, json: { error: "amount not allowed by the run policy", maxOrderAmount: "1000000" } });
    fixture.setMode("create", "busy");
    const busy = await createOrder();
    expect([busy.status, busy.headers.get("retry-after"), busy.json]).toEqual([503, "30", { error: "order-creation-busy" }]);
    fixture.setMode("create", "paused");
    expect(await createOrder()).toMatchObject({ status: 503, json: { error: "order-creation-paused" } });
    fixture.setMode("create", "rate-limited");
    expect((await createOrder()).status).toBe(429);
    fixture.setMode("create", "slow:150");
    const t0 = Date.now();
    expect((await createOrder()).status).toBe(201);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(fixture.orders.size).toBe(1);
    fixture.setMode("create", "lose-response");
    await expect(createOrder("2000", OTHER_REQUESTER)).rejects.toBeTruthy();
    expect(fixture.orders.size).toBe(2);
    const id = [...fixture.orders.keys()][0]!;
    fixture.setMode("create", "existing-mismatch:amount");
    expect((((await createOrder()).json)["requirements"] as Record<string, unknown>)["amount"]).toBe("2001");
    fixture.setMode("create", "existing-mismatch:id");
    expect((await createOrder()).json["orderId"]).not.toBe(id);
    fixture.setMode("create", "existing-mismatch:expired");
    expect((((await createOrder()).json)["status"] as Record<string, unknown>)["expiresAt"]).toBe(clock - 1);
    fixture.setMode("create", "ok");
    expect(await createOrder()).toMatchObject({ status: 200, json: { existing: true, orderId: id } });
  });
  test("busy-then-create: 503 のあと /_fixture/allocate が試験の createdAt・expiresAt で注文を作り、照会に出る。empty は常に空", async () => {
    fixture.setMode("create", "busy-then-create");
    expect((await createOrder()).status).toBe(503);
    expect(fixture.orders.size).toBe(0);
    const allocated = await call("/_fixture/allocate", { root: true, method: "POST", body: { requesterDigest: REQUESTER, resourceDigest: RESOURCE, createdAt: 1_800_003_600, expiresAt: 1_800_003_900 } });
    expect(allocated.status).toBe(201);
    expect((allocated.json["status"] as Record<string, unknown>)["expiresAt"]).toBe(1_800_003_900);
    expect(fixture.orders.get(allocated.json["orderId"] as string)).toMatchObject({ amount: "2000", createdAt: 1_800_003_600 });
    expect(((await call(`/exact/requesters/${REQUESTER}/orders?resourceDigest=${RESOURCE}`)).json["orders"] as Record<string, unknown>[])[0]?.["orderId"]).toBe(allocated.json["orderId"]);
    fixture.setMode("requesters", "empty");
    expect((await call(`/exact/requesters/${REQUESTER}/orders?resourceDigest=${RESOURCE}`)).json).toEqual({ orders: [] });
  });
});

describe("公開 verify（署名が先。multi-routes.ts:310）", () => {
  const fixed = { isValid: false, invalidReason: "invalid_payment" };
  test("署名の無い・壊れた payload、知らない tenant、正しい署名でも知らない注文、accepted の same の各欄の違い、paymentRequirements の違い → 固定本文。正しい署名で isValid + payer", async () => {
    const view = (await createOrder()).json;
    expect((await call("/exact/verify", { method: "POST", rawHeaders: JSON_HEADERS, body: { paymentPayload: { payload: { authorization: {}, signature: "0x00" } } } })).json).toEqual(fixed);
    expect((await call("/exact/verify", { method: "POST", rawHeaders: JSON_HEADERS, body: {} })).json).toEqual({ isValid: false, invalidReason: "invalid_request" });
    const good = await payloadFor(view);
    expect((await call("/exact/verify", { method: "POST", rawHeaders: JSON_HEADERS, body: { paymentPayload: good } })).json).toEqual({ isValid: true, payer: payer.address });
    expect((await call(`/p/other/exact/verify`, { root: true, method: "POST", body: { paymentPayload: good } })).json).toEqual(fixed);
    const unknownOrder = await payloadFor(view, { patch: (o) => ({ ...o, payTo: `0x${"dd".repeat(20)}` }), accepted: (r) => ({ ...r, payTo: `0x${"dd".repeat(20)}` }) });
    expect((await call("/exact/verify", { method: "POST", body: { paymentPayload: unknownOrder } })).json).toEqual(fixed);
    for (const [name, change] of [
      ["scheme", (r: Record<string, unknown>) => ({ ...r, scheme: "upto" })],
      ["network", (r: Record<string, unknown>) => ({ ...r, network: "eip155:1" })],
      ["asset", (r: Record<string, unknown>) => ({ ...r, asset: `0x${"ee".repeat(20)}` })],
      ["amount", (r: Record<string, unknown>) => ({ ...r, amount: "1" })],
      ["maxTimeoutSeconds", (r: Record<string, unknown>) => ({ ...r, maxTimeoutSeconds: 151 })],
      ["extra.name", (r: Record<string, unknown>) => ({ ...r, extra: { ...(r["extra"] as object), name: "USDC" } })],
      ["extra.version", (r: Record<string, unknown>) => ({ ...r, extra: { ...(r["extra"] as object), version: "2" } })],
    ] as const) {
      const mismatched = await payloadFor(view, { accepted: change });
      expect((await call("/exact/verify", { method: "POST", body: { paymentPayload: mismatched } })).json, name).toEqual(fixed);
    }
    expect((await call("/exact/verify", { method: "POST", body: { paymentPayload: good, paymentRequirements: { ...(view["requirements"] as object), amount: "1" } } })).json).toEqual(fixed);
    const lowerAsset = await payloadFor(view, { accepted: (r) => ({ ...r, asset: String(r["asset"]).toLowerCase() }) });
    expect((await call("/exact/verify", { method: "POST", body: { paymentPayload: lowerAsset } })).json).toMatchObject({ isValid: true });
  });
  test("SDK の検査: validBefore < now + 6 → invalidReason。注文の状態は見ない（accepted の後も isValid）。invalid・slow のモード", async () => {
    const view = (await createOrder()).json;
    const soon = await payloadFor(view, { patch: (o) => ({ ...o, extra: { ...(o["extra"] as object), expiresAt: clock + 5 } }) });
    expect((await call("/exact/verify", { method: "POST", body: { paymentPayload: soon } })).json).toEqual({ isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_valid_before", payer: payer.address });
    const good = await payloadFor(view);
    expect((await settleOf(view["orderId"] as string, good)).json["outcome"]).toBe("accepted");
    expect((await call("/exact/verify", { method: "POST", body: { paymentPayload: good } })).json).toEqual({ isValid: true, payer: payer.address });
    fixture.setMode("verify", "invalid");
    expect((await call("/exact/verify", { method: "POST", body: { paymentPayload: good } })).json).toEqual({ isValid: false, invalidReason: "insufficient_funds", payer: payer.address });
    fixture.setMode("verify", "slow:120");
    const t0 = Date.now();
    expect((await call("/exact/verify", { method: "POST", body: { paymentPayload: good } })).json).toMatchObject({ isValid: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });
});

describe("settle（exact-routes.ts の route + exact-settle.ts の #settleOnce + burn-sale-backend.ts の reserveExact）", () => {
  test("route の検査: 400、binding 違い 403、別の注文への payload 409。locate の失敗は orderId 無し、以降の失敗は orderId 付き。予約の検査の code", async () => {
    const view = (await createOrder()).json;
    const id = view["orderId"] as string;
    const good = await payloadFor(view);
    expect(await settleOf(id, good, "nope")).toMatchObject({ status: 400 });
    expect(await settleOf(id, good, OTHER_REQUESTER)).toMatchObject({ status: 403, json: { error: "order is bound to another requester or resource" } });
    const otherPay = JSON.parse(JSON.stringify(good)) as { payload: { authorization: { to: string } } };
    otherPay.payload.authorization.to = `0x${"dd".repeat(20)}`;
    expect(await settleOf(id, otherPay)).toMatchObject({ status: 409, json: { error: "payload pays another order" } });
    const malformed = JSON.parse(JSON.stringify(good)) as { payload: { authorization: Record<string, unknown> } };
    malformed.payload.authorization["value"] = 2000;
    const m = await settleOf(id, malformed);
    expect(m.json).toMatchObject({ success: false, errorReason: "malformed-authorization", transaction: "", network: `eip155:${CHAIN_ID}`, outcome: "rejected" });
    expect(m.json).not.toHaveProperty("orderId");
    expect(m.json["order"]).toMatchObject({ orderId: id });
    expect((await settleOf(id, { ...good, accepted: { ...(good.accepted as object), amount: "1" } })).json).toMatchObject({ errorReason: "accepted-requirements-mismatch", outcome: "rejected" });
    expect((await settleOf(id, good, REQUESTER, { paymentRequirements: { ...(view["requirements"] as object), amount: "1" } })).json).toMatchObject({ errorReason: "requirements-mismatch" });
    // 署名の壊れ → invalid-signature（verify → reconcile の順。orderId・payer 付き、記録無し）。
    const broken = JSON.parse(JSON.stringify(good)) as { payload: { signature: string } };
    broken.payload.signature = `0x${"00".repeat(65)}`;
    expect((await settleOf(id, broken)).json).toMatchObject({ success: false, errorReason: "invalid-signature", outcome: "rejected", orderId: id, payer: payer.address });
    expect(fixture.orders.get(id)?.exact).toBeUndefined();
    // reserveExact: validBefore が注文の期限より後 → valid-before-after-order-expiry（記録無し）。
    const beyond = await payloadFor(view, { patch: (o) => ({ ...o, extra: { ...(o["extra"] as object), expiresAt: clock + 400 } }) });
    expect((await settleOf(id, beyond)).json).toMatchObject({ errorReason: "valid-before-after-order-expiry", outcome: "rejected", orderId: id });
    expect(fixture.orders.get(id)?.exact).toBeUndefined();
    // 期限の後の注文（署名は SDK の検査に通る）→ order-expired。
    clock += 301;
    const late = await payloadFor(view, { patch: (o) => ({ ...o, extra: { ...(o["extra"] as object), expiresAt: clock + 400 } }) });
    expect((await settleOf(id, late)).json).toMatchObject({ errorReason: "order-expired", outcome: "rejected", orderId: id });
    clock -= 301;
    // SDK の validBefore の検査に落ちる未使用の署名（注文に合う）→ observed のまま pending。
    const soon = await payloadFor(view, { patch: (o) => ({ ...o, extra: { ...(o["extra"] as object), expiresAt: clock + 5 } }) });
    expect((await settleOf(id, soon)).json).toMatchObject({ errorReason: "settlement_pending", outcome: "pending", orderId: id });
    expect(fixture.orders.get(id)?.exact).toMatchObject({ state: "observed" });
    expect(fixture.orders.get(id)?.state).toBe("open");
  });
  test("accepted: success・transaction（64 hex）・payer・outcome・orderId・order（state accepted、exact paid/facilitator、gate ready）、eventId 無し。同じ authorization の再提示は同じ transaction、別の authorization は conflicting-authorization", async () => {
    const view = (await createOrder()).json;
    const id = view["orderId"] as string;
    const good = await payloadFor(view);
    const settled = await settleOf(id, good);
    expect(settled.status).toBe(200);
    expect(settled.json).toMatchObject({ success: true, outcome: "accepted", orderId: id, payer: payer.address, network: `eip155:${CHAIN_ID}` });
    expect(settled.json["transaction"]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(settled.json).not.toHaveProperty("eventId");
    expect((settled.json["order"] as Record<string, unknown>)["status"]).toMatchObject({ state: "accepted", gate: "ready", exact: { state: "paid", origin: "facilitator", from: payer.address, nonce: id }, receipt: { level: "final" } });
    const replay = await settleOf(id, good);
    expect(replay.json).toMatchObject({ success: true, outcome: "accepted", transaction: settled.json["transaction"] });
    const other = await payloadFor(view, { signer: otherPayer });
    expect((await settleOf(id, other)).json).toMatchObject({ success: false, errorReason: "conflicting-authorization", outcome: "rejected", orderId: id });
    expect(fixture.orders.get(id)?.exact?.from).toBe(payer.address);
    expect(fixture.orders.get(id)?.exact?.txHash).toBe(settled.json["transaction"]);
    expect(fixture.calls.byOrder[id]).toMatchObject({ settle: 3 });
  });
  test("モード: pending（同じ authorization の再提示も pending）、late-paid、rejected:<code>（orderId 付き）、error、unreadable、timeout、lose-response（記録してから切る）", async () => {
    const view = (await createOrder()).json;
    const id = view["orderId"] as string;
    const good = await payloadFor(view);
    fixture.setMode("settle", "rejected:send-limit-reached");
    expect((await settleOf(id, good)).json).toMatchObject({ success: false, errorReason: "send-limit-reached", outcome: "rejected", orderId: id, payer: payer.address });
    fixture.setMode("settle", "error");
    expect((await settleOf(id, good)).status).toBe(500);
    fixture.setMode("settle", "unreadable");
    expect((await settleOf(id, good)).json).toBeUndefined();
    fixture.setMode("settle", "timeout");
    const controller = new AbortController();
    const hanging = fetch(`${base}/exact/orders/${id}/settle`, { method: "POST", headers: auth, body: JSON.stringify({ paymentPayload: good, requesterDigest: REQUESTER, resourceDigest: RESOURCE }), signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(hanging).rejects.toBeTruthy();
    fixture.setMode("settle", "pending");
    expect((await settleOf(id, good)).json).toMatchObject({ success: false, errorReason: "settlement_pending", outcome: "pending", orderId: id });
    fixture.setMode("settle", "accepted");
    expect((await settleOf(id, good)).json).toMatchObject({ outcome: "pending" });
    const second = (await createOrder("2000", OTHER_REQUESTER)).json;
    const sid = second["orderId"] as string;
    fixture.setMode("settle", "lose-response");
    await expect(settleOf(sid, await payloadFor(second), OTHER_REQUESTER)).rejects.toBeTruthy();
    expect(fixture.orders.get(sid)?.state).toBe("accepted");
    fixture.setMode("settle", "late-paid");
    const third = (await createOrder("2000", `0x${"04".repeat(32)}`)).json;
    const r = await settleOf(third["orderId"] as string, await payloadFor(third), `0x${"04".repeat(32)}`);
    expect(r.json).toMatchObject({ success: false, errorReason: "late-paid", outcome: "late-paid" });
    expect((r.json["order"] as Record<string, unknown>)["status"]).toMatchObject({ state: "late-paid", gate: "late-paid" });
  });
});

describe("release（receipt mode）と complete", () => {
  test("未払いは 425、requester 違い 403、1 回だけ 200 {deliveryKey, txRef, eventId}、2 回目は 409 already-claimed。state は accepted のまま、policy は exact-receipt、gate は claimed。complete の冪等と 409、完了後の gate と照会", async () => {
    const view = (await createOrder()).json;
    const id = view["orderId"] as string;
    expect(await releaseOf(id)).toMatchObject({ status: 425, json: { error: "not-ready" } });
    expect(await completeOf(id, id, "delivered")).toMatchObject({ status: 409, json: { error: "not-authorized" } });
    const { tx } = await paidOrder();
    expect(await releaseOf(id, OTHER_REQUESTER)).toMatchObject({ status: 403, json: { error: "requester-mismatch" } });
    const released = await releaseOf(id);
    expect(released.status).toBe(200);
    expect(released.json).toEqual({ deliveryKey: id, txRef: tx, eventId: `${CHAIN_ID}:${tx}:0` });
    expect(await releaseOf(id)).toMatchObject({ status: 409, json: { error: "already-claimed" } });
    const status = await statusOf(id);
    expect(status).toMatchObject({ state: "accepted", gate: "claimed", release: { policy: "exact-receipt", state: "authorized", deliveryKey: id, txRef: tx, eventId: released.json["eventId"] } });
    expect(status["release"]).not.toHaveProperty("afterRelease");
    expect(await completeOf(id, `0x${"77".repeat(32)}`, "delivered")).toMatchObject({ status: 409, json: { error: "delivery-key-mismatch" } });
    const done = await completeOf(id, id, "delivered");
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ state: "delivered", completedAt: clock });
    expect(await completeOf(id, id, "delivered")).toMatchObject({ status: 200, json: done.json });
    expect(await completeOf(id, id, "failed")).toMatchObject({ status: 409, json: { error: "conflicting-outcome" } });
    expect(await releaseOf(id)).toMatchObject({ status: 409, json: { error: "already-delivered" } });
    expect(await statusOf(id)).toMatchObject({ gate: "delivered", release: { state: "delivered", completedAt: clock } });
    expect((await call(`/exact/requesters/${REQUESTER}/orders?resourceDigest=${RESOURCE}`)).json).toEqual({ orders: [] });
    expect((await createOrder()).status).toBe(201);
    expect(await completeOf(id, id, "nope")).toMatchObject({ status: 400 });
  });
  test("release のモード: not-ready-once → ok、not-ready-always、incident、lose-response（記録してから切る）、claimed-before（最初の呼び出しが already-claimed で view は authorized）、error-once、rate-limited-once", async () => {
    const a = await paidOrder();
    fixture.setMode("release", "not-ready-once");
    expect((await releaseOf(a.id)).status).toBe(425);
    expect((await releaseOf(a.id)).status).toBe(200);
    const b = await paidOrder(`0x${"01".repeat(32)}`);
    const relB = () => releaseOf(b.id, `0x${"01".repeat(32)}`);
    fixture.setMode("release", "not-ready-always");
    expect((await relB()).status).toBe(425);
    expect((await relB()).status).toBe(425);
    fixture.setMode("release", "incident");
    expect(await relB()).toMatchObject({ status: 409, json: { error: "incident" } });
    fixture.setMode("release", "lose-response");
    await expect(relB()).rejects.toBeTruthy();
    expect(fixture.orders.get(b.id)?.release).toMatchObject({ deliveryKey: b.id, mode: "exact-receipt" });
    fixture.setMode("release", "ok");
    expect(await relB()).toMatchObject({ status: 409, json: { error: "already-claimed" } });
    const c = await paidOrder(`0x${"02".repeat(32)}`);
    fixture.setMode("release", "claimed-before");
    expect(await releaseOf(c.id, `0x${"02".repeat(32)}`)).toMatchObject({ status: 409, json: { error: "already-claimed" } });
    expect(await statusOf(c.id)).toMatchObject({ state: "accepted", release: { state: "authorized", deliveryKey: c.id, txRef: c.tx } });
    const d = await paidOrder(`0x${"03".repeat(32)}`);
    fixture.setMode("release", "error-once");
    expect((await releaseOf(d.id, `0x${"03".repeat(32)}`)).status).toBe(500);
    expect((await releaseOf(d.id, `0x${"03".repeat(32)}`)).status).toBe(200);
    const e = await paidOrder(`0x${"04".repeat(32)}`);
    fixture.setMode("release", "rate-limited-once");
    const limited = await releaseOf(e.id, `0x${"04".repeat(32)}`);
    expect([limited.status, limited.headers.get("retry-after")]).toEqual([429, "1"]);
    expect((await releaseOf(e.id, `0x${"04".repeat(32)}`)).status).toBe(200);
  });
  test("paid-external は accepted・external-broadcast で release できる。status のモード: corrupt:<field>（7 欄）、after-release:reorged、error、rate-limited。complete のモード: preset、lose-response と -once、error-once、unreadable", async () => {
    const view = (await createOrder()).json;
    const id = view["orderId"] as string;
    await call(`/_fixture/orders/${id}/paid-external`, { root: true, method: "POST", body: {} });
    expect(await statusOf(id)).toMatchObject({ state: "accepted", gate: "ready", exact: { origin: "external-broadcast" } });
    expect((await releaseOf(id)).status).toBe(200);
    const read = async () => (await call(`/exact/orders/${id}`)).json;
    const clean = await read();
    const field = (v: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], v);
    for (const [mode, path] of [["corrupt:binding.requesterDigest", "binding.requesterDigest"], ["corrupt:binding.resourceDigest", "binding.resourceDigest"], ["corrupt:release.deliveryKey", "status.release.deliveryKey"], ["corrupt:release.txRef", "status.release.txRef"], ["corrupt:release.eventId", "status.release.eventId"], ["corrupt:release.state", "status.release.state"], ["corrupt:state", "status.state"]] as const) {
      fixture.setMode("status", mode);
      const corrupted = await read();
      expect(field(corrupted, path), mode).not.toEqual(field(clean, path));
      const strip = (v: Record<string, unknown>) => { const c = JSON.parse(JSON.stringify(v)) as Record<string, unknown>; const keys = path.split("."); let o: Record<string, unknown> = c; for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>; delete o[keys.at(-1)!]; return c; };
      expect(strip(corrupted)).toEqual(strip(clean));
    }
    fixture.setMode("status", "after-release:reorged");
    expect(field(await read(), "status.release.afterRelease")).toBe("reorged");
    fixture.setMode("status", "error");
    expect((await call(`/exact/orders/${id}`)).status).toBe(500);
    fixture.setMode("status", "rate-limited");
    expect((await call(`/exact/orders/${id}`)).status).toBe(429);
    fixture.setMode("status", "ok");
    fixture.setMode("complete", "preset:failed");
    expect(await completeOf(id, id, "delivered")).toMatchObject({ status: 409, json: { error: "conflicting-outcome" } });
    expect(await completeOf(id, id, "failed")).toMatchObject({ status: 200, json: { state: "failed" } });
    expect(await statusOf(id)).toMatchObject({ gate: "failed", release: { state: "failed" } });
    const other = (await createOrder("2000", `0x${"05".repeat(32)}`)).json;
    const oid = other["orderId"] as string;
    await call(`/_fixture/orders/${oid}/paid-external`, { root: true, method: "POST", body: {} });
    await releaseOf(oid, `0x${"05".repeat(32)}`);
    fixture.setMode("complete", "lose-response");
    await expect(completeOf(oid, oid, "delivered")).rejects.toBeTruthy();
    await expect(completeOf(oid, oid, "delivered")).rejects.toBeTruthy();
    expect(fixture.orders.get(oid)?.release?.completed?.outcome).toBe("delivered");
    fixture.setMode("complete", "lose-response-once");
    await expect(completeOf(oid, oid, "delivered")).rejects.toBeTruthy();
    expect((await completeOf(oid, oid, "delivered")).status).toBe(200);
    fixture.setMode("complete", "error-once");
    expect((await completeOf(oid, oid, "delivered")).status).toBe(500);
    expect((await completeOf(oid, oid, "delivered")).status).toBe(200);
    fixture.setMode("complete", "unreadable");
    expect((await completeOf(oid, oid, "delivered")).json).toBeUndefined();
  });
  test("任意の注入: raw（次の 1 回だけ）、huge-body、redirect、stall-body は経路を問わない。観測の口", async () => {
    const view = (await createOrder()).json;
    const id = view["orderId"] as string;
    fixture.setMode("status", "raw", { status: 418, headers: { "x-fixture": "1" }, body: "teapot" });
    const raw = await call(`/exact/orders/${id}`);
    expect([raw.status, raw.headers.get("x-fixture"), raw.text]).toEqual([418, "1", "teapot"]);
    expect((await call(`/exact/orders/${id}`)).status).toBe(200);
    fixture.setMode("create", "huge-body");
    expect((await createOrder()).text.length).toBeGreaterThan(70 * 1024);
    fixture.setMode("requesters", "redirect");
    const redirect = await fetch(`${base}/exact/requesters/${REQUESTER}/orders?resourceDigest=${RESOURCE}`, { headers: auth, redirect: "manual" });
    expect([redirect.status, redirect.headers.get("location")]).toEqual([302, "http://127.0.0.1:9/elsewhere"]);
    fixture.setMode("complete", "stall-body");
    const controller = new AbortController();
    const stalled = fetch(`${base}/exact/orders/${id}/complete`, { method: "POST", headers: auth, body: "{}", signal: controller.signal }).then((r) => r.text());
    setTimeout(() => controller.abort(), 200);
    await expect(stalled).rejects.toBeTruthy();
    const calls = await call("/_fixture/calls", { root: true });
    expect(calls.json["byRoute"]).toMatchObject({ create: 2, status: 2, requesters: 1, complete: 1 });
    expect((await call(`/_fixture/orders/${id}`, { root: true })).json).toMatchObject({ orderId: id, state: "open" });
  });
});

describe("CLI の形", () => {
  test("--mode <route>=<mode> を起動時に受け、listening の行を出す", async () => {
    const { startListening } = await import("../fixtures/loopback.js");
    const child = await startListening("tests/fixtures/subetha-exact-facilitator.ts", ["--provider-id", "cli-tenant", "--bearer", "cli-token", "--ttl-seconds", "120", "--mode", "create=busy"]);
    try {
      expect(child.stdout()).toContain('"role":"subetha-exact-facilitator"');
      const r = await fetch(`${child.baseUrl}/p/cli-tenant/exact/orders`, { method: "POST", headers: { authorization: "Bearer cli-token", "content-type": "application/json" }, body: JSON.stringify({ amount: "2000", resourceDigest: RESOURCE, requesterDigest: REQUESTER }) });
      expect(r.status).toBe(503);
    } finally {
      await child.stop();
    }
  });
});

describe("実装レビュー 3 の #3: reconcile と Express の JSON の上限", () => {
  test("SDK の検査に落ちた未使用の署名は observed のまま pending（同じ署名の再提示も pending、別の署名は conflicting、release は 425）。既に払われた同じ署名は SDK の検査に落ちても accepted（reconcile）。署名が壊れていれば invalid-signature", async () => {
    const view = (await createOrder()).json;
    const id = view["orderId"] as string;
    // value 違い（署名は正しい）→ 注文に合わないので記録せず rejected（authorization-does-not-match-order）。
    const wrongValue = await payloadFor(view, { patch: (o) => ({ ...o, amount: "1999" }) });
    expect((await settleOf(id, wrongValue)).json).toMatchObject({ success: false, errorReason: "authorization-does-not-match-order", outcome: "rejected", orderId: id, payer: payer.address });
    expect(fixture.orders.get(id)?.exact).toBeUndefined();
    // 期限の近い署名（注文に合う）→ observed + pending。observed だけでは release は 425。同じ署名の再提示は pending のまま。
    const near = await payloadFor(view, { patch: (o) => ({ ...o, extra: { ...(o["extra"] as object), expiresAt: clock + 5 } }) });
    expect((await settleOf(id, near)).json).toMatchObject({ success: false, errorReason: "settlement_pending", outcome: "pending", orderId: id, payer: payer.address });
    expect(fixture.orders.get(id)?.exact).toMatchObject({ state: "observed" });
    expect(await releaseOf(id)).toMatchObject({ status: 425, json: { error: "not-ready" } });
    expect((await settleOf(id, near)).json).toMatchObject({ outcome: "pending", errorReason: "settlement_pending" });
    const other = await payloadFor(view, { signer: otherPayer });
    expect((await settleOf(id, other)).json).toMatchObject({ errorReason: "conflicting-authorization", outcome: "rejected" });
    // 昇格の成功: validAfter が未来の有効な署名 → observed + pending。時間が経って fresh verify が通れば送られて accepted（同じ注文・同じ authorization）。
    const v2 = (await createOrder("2000", OTHER_REQUESTER)).json;
    const v2id = v2["orderId"] as string;
    const future = await signedWith(v2, clock + 100, clock + 290);
    expect((await settleOf(v2id, future, OTHER_REQUESTER)).json).toMatchObject({ errorReason: "settlement_pending", outcome: "pending", orderId: v2id });
    expect(fixture.orders.get(v2id)?.exact).toMatchObject({ state: "observed", validAfter: String(clock + 100) });
    clock += 150;
    const promoted = await settleOf(v2id, future, OTHER_REQUESTER);
    expect(promoted.json).toMatchObject({ success: true, outcome: "accepted", orderId: v2id, payer: payer.address });
    expect(fixture.orders.get(v2id)?.exact).toMatchObject({ state: "paid", origin: "facilitator", validAfter: String(clock - 50) });
    clock -= 150;
    // 昇格の拒否: observed のまま注文の期限を過ぎると、fresh verify が通っても送らず reconcile（pending）。証拠は残る。
    const v4 = (await createOrder("2000", `0x${"07".repeat(32)}`)).json;
    const v4id = v4["orderId"] as string;
    const lateFuture = await signedWith(v4, clock + 100, clock + 290);
    expect((await settleOf(v4id, lateFuture, `0x${"07".repeat(32)}`)).json).toMatchObject({ outcome: "pending" });
    clock += 301;
    // validBefore（clock+290 の元の値）は now + 6 を下回るので SDK に落ち → reconcile（同じ identity）→ pending のまま。
    expect((await settleOf(v4id, lateFuture, `0x${"07".repeat(32)}`)).json).toMatchObject({ outcome: "pending", errorReason: "settlement_pending" });
    expect(fixture.orders.get(v4id)?.exact).toMatchObject({ state: "observed" });
    clock -= 301;
    // 署名を壊した再提示（同じ from・nonce）は reconcile で pending（identity は from + nonce）。別の identity なら invalid-signature。
    const corrupted = JSON.parse(JSON.stringify(lateFuture)) as { payload: { signature: string; authorization: Record<string, string> } };
    corrupted.payload.signature = `0x${"00".repeat(65)}`;
    expect((await settleOf(v4id, corrupted, `0x${"07".repeat(32)}`)).json).toMatchObject({ outcome: "pending", errorReason: "settlement_pending" });
    corrupted.payload.authorization["from"] = otherPayer.address;
    expect((await settleOf(v4id, corrupted, `0x${"07".repeat(32)}`)).json).toMatchObject({ errorReason: "invalid-signature", outcome: "rejected" });
    // 払われた注文に、同じ署名を期限の後（SDK の validBefore の検査に落ちる時刻）に再提示 → accepted（reconcile）。
    const v3 = (await createOrder("2000", `0x${"06".repeat(32)}`)).json;
    const good = await payloadFor(v3);
    const settled = await settleOf(v3["orderId"] as string, good, `0x${"06".repeat(32)}`);
    expect(settled.json["outcome"]).toBe("accepted");
    clock += 299;
    expect((await settleOf(v3["orderId"] as string, good, `0x${"06".repeat(32)}`)).json).toMatchObject({ outcome: "accepted", transaction: settled.json["transaction"] });
    clock -= 299;
  });
  test("JSON で無い content-type の大きな本文は 413 にならず（Express は読まない）400 expect。gate: observed だけなら awaiting-payment のまま", async () => {
    const big = JSON.stringify({ pad: "x".repeat(70 * 1024) });
    expect(await call("/exact/orders", { method: "POST", rawHeaders: { authorization: `Bearer ${BEARER}`, "content-type": "text/plain" }, body: big })).toMatchObject({ status: 400, json: { error: "expect { amount: atomic string, resourceDigest: 0x32B, requesterDigest: 0x32B }" } });
    const view = (await createOrder()).json;
    const id = view["orderId"] as string;
    await settleOf(id, await payloadFor(view, { patch: (o) => ({ ...o, extra: { ...(o["extra"] as object), expiresAt: clock + 5 } }) }));
    expect(await statusOf(id)).toMatchObject({ state: "open", gate: "awaiting-payment", exact: { state: "observed" } });
  });
});
