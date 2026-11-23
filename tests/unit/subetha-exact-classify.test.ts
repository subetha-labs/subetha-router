/**
 * `subetha-exact` の分類の純粋関数（`docs/subetha-exact-inbound-design.md` §3.3・§3.4 の 6・§3.8 の表 A〜E・D／D′、タスク T-4）。全行を固定する。
 */
import { describe, expect, test } from "vitest";

import {
  classifyComplete,
  classifyCreate,
  classifyReconstruct,
  classifyReleasePost,
  classifyBind,
  classifyReconcile,
  classifySubmit,
  sigSha256Of,
  pairKeyOf,
  parseOrderView,
  requesterDigestOf,
  resourceDigestOf,
  retryAfterMsOf,
  tryDeadlineOf,
  viewMismatchOf,
  waitFits,
  type CallOutcome,
  type CreateExpectation,
  type ReleaseContext,
} from "../../src/adapters/inbound/subetha-exact-classify.js";

const ORDER = `0x${"5a".repeat(32)}`;
const TX = `0x${"7b".repeat(32)}`;
const REQ = `0x${"a1".repeat(32)}`;
const RES = `0x${"b2".repeat(32)}`;
const PAY_TO = "0x7f3bA2c1e5d4F6a7B8c9D0e1F2a3B4c5D6e7F8a9";
const ASSET = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const NOW = 1_800_000_000;

const expected: CreateExpectation = { network: "eip155:84532", asset: ASSET, amount: "2000", requesterDigest: REQ, resourceDigest: RES, domain: { name: "zERC20 USD Coin", version: "1" }, nowSec: NOW, minLeadSeconds: 30 };
function view(overrides: Record<string, unknown> = {}, status: Record<string, unknown> = {}, requirements: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: ORDER,
    existing: false,
    requirements: { scheme: "exact", network: "eip155:84532", asset: ASSET, amount: "2000", payTo: PAY_TO, maxTimeoutSeconds: 150, extra: { name: "zERC20 USD Coin", version: "1" }, ...requirements },
    status: { state: "open", expiresAt: NOW + 300, release: { state: "none" }, ...status },
    binding: { requesterDigest: REQ, resourceDigest: RES },
    ...overrides,
  };
}
const response = (status: number, json: unknown, retryAfter: string | null = null, unreadable = false): CallOutcome => ({ kind: "response", status, json, retryAfter, unreadable });
const threw: CallOutcome = { kind: "threw" };

describe("digest（§3.3）", () => {
  test("長さ付きなので (ab,c) と (a,bc) は別。salt が違えば別。resource は束縛から", () => {
    expect(requesterDigestOf("s", "ab", "c")).not.toBe(requesterDigestOf("s", "a", "bc"));
    expect(requesterDigestOf("s", "a", "b")).not.toBe(requesterDigestOf("t", "a", "b"));
    expect(requesterDigestOf("s", "a", "b")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(resourceDigestOf("r|GET|%2Fx")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(pairKeyOf(REQ.toUpperCase(), RES)).toBe(`${REQ}|${RES}`);
  });
});

describe("parseOrderView（読める応答）", () => {
  test("allowlist の欄だけを写し、orderId は小文字。existing が boolean で無い・欄の型違い・hex32 で無い id は読めない", () => {
    const parsed = parseOrderView({ ...view({ orderId: ORDER.toUpperCase().replace("0X", "0x") }), junk: "x" });
    expect(parsed?.orderId).toBe(ORDER);
    expect(parsed).not.toHaveProperty("junk");
    expect(parseOrderView(view({ existing: "true" }))).toBeUndefined();
    expect(parseOrderView(view({ orderId: "0x12" }))).toBeUndefined();
    expect(parseOrderView(view({}, { expiresAt: "soon" }))).toBeUndefined();
    expect(parseOrderView(view({}, {}, { extra: {} }))).toBeUndefined();
    expect(parseOrderView("x")).toBeUndefined();
    expect(parseOrderView(view({ existing: undefined }))?.existing).toBeUndefined();
    expect(parseOrderView(view({}, { release: { state: "authorized", deliveryKey: ORDER, txRef: TX, eventId: `84532:${TX}:0`, afterRelease: "reorged" } }))?.status.release).toEqual({ state: "authorized", deliveryKey: ORDER, txRef: TX, eventId: `84532:${TX}:0`, afterRelease: "reorged" });
  });
});

describe("表 A: 作成", () => {
  test.each<[string, CallOutcome, Record<string, unknown>]>([
    ["transport", threw, { kind: "unavailable", detail: "response_unreadable" }],
    ["503 + Retry-After 12", response(503, { error: "order-creation-busy" }, "12"), { kind: "unavailable", detail: "facilitator_busy", retryAfterMs: 12_000 }],
    ["503 Retry-After 無し → 30 s", response(503, {}), { kind: "unavailable", detail: "facilitator_busy", retryAfterMs: 30_000 }],
    ["429", response(429, {}, "2"), { kind: "unavailable", detail: "rate_limited", retryAfterMs: 2_000 }],
    ["502", response(502, {}), { kind: "unavailable", detail: "facilitator_busy" }],
    ["401", response(401, { error: "unauthorized" }), { kind: "refused", detail: "unauthorized" }],
    ["404", response(404, { error: "unknown" }), { kind: "refused", detail: "unknown_tenant" }],
    ["403", response(403, { error: "amount not allowed by the run policy" }), { kind: "refused", detail: "amount_refused" }],
    ["400", response(400, {}), { kind: "refused", detail: "requirements_mismatch" }],
    ["418", response(418, {}), { kind: "refused", detail: "requirements_mismatch" }],
    ["201 で読めない", response(201, "nope"), { kind: "unavailable", detail: "response_unreadable" }],
    ["201 で existing 無し", response(201, view({ existing: undefined })), { kind: "unavailable", detail: "response_unreadable" }],
    ["204", response(204, undefined), { kind: "unavailable", detail: "response_unreadable" }],
    ["302（transport の失敗にならなかった場合）", response(302, undefined), { kind: "unavailable", detail: "response_unreadable" }],
    ["201 OK", response(201, view()), { kind: "created" }],
    ["200 existing OK", response(200, view({ existing: true })), { kind: "created" }],
  ])("%s", (_name, call, want) => {
    expect(classifyCreate(call, expected)).toMatchObject(want);
  });
  test("読める応答の条件（FR-3）: 1 欄ずつ違えば requirements_mismatch、existing のときは order_reused_*", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["scheme", view({}, {}, { scheme: "upto" })],
      ["network", view({}, {}, { network: "eip155:1" })],
      ["asset", view({}, {}, { asset: `0x${"ee".repeat(20)}` })],
      ["amount", view({}, {}, { amount: "2001" })],
      ["payTo の形", view({}, {}, { payTo: "0x12" })],
      ["name", view({}, {}, { extra: { name: "USDC", version: "1" } })],
      ["version", view({}, {}, { extra: { name: "zERC20 USD Coin", version: "2" } })],
      ["maxTimeoutSeconds 0", view({}, {}, { maxTimeoutSeconds: 0 })],
      ["expiresAt の残りが 29 s", view({}, { expiresAt: NOW + 29 })],
      ["binding requester", view({ binding: { requesterDigest: RES, resourceDigest: RES } })],
      ["binding resource", view({ binding: { requesterDigest: REQ, resourceDigest: REQ } })],
    ];
    for (const [name, v] of cases) expect(classifyCreate(response(201, v), expected), name).toEqual({ kind: "refused", detail: "requirements_mismatch" });
    expect(classifyCreate(response(201, view({}, { expiresAt: NOW + 30 })), expected)).toMatchObject({ kind: "created" });
    // asset の大文字小文字は同一視。
    expect(classifyCreate(response(201, view({}, {}, { asset: ASSET.toLowerCase() })), expected)).toMatchObject({ kind: "created" });
    // existing: 他の id → other_id（最新の created があるとき）、期限 → expired、額・binding → mismatch。
    expect(classifyCreate(response(200, view({ existing: true })), { ...expected, latestCreatedOrderId: `0x${"11".repeat(32)}` })).toEqual({ kind: "refused", detail: "order_reused_other_id" });
    expect(classifyCreate(response(200, view({ existing: true })), { ...expected, latestCreatedOrderId: ORDER.toUpperCase().replace("0X", "0x") })).toMatchObject({ kind: "created" });
    expect(classifyCreate(response(200, view({ existing: true }, { expiresAt: NOW + 10 })), expected)).toEqual({ kind: "refused", detail: "order_reused_expired" });
    expect(classifyCreate(response(200, view({ existing: true }, {}, { amount: "2001" })), expected)).toEqual({ kind: "refused", detail: "order_reused_mismatch" });
    expect(classifyCreate(response(200, view({ existing: true, binding: { requesterDigest: RES, resourceDigest: RES } })), expected)).toEqual({ kind: "refused", detail: "order_reused_mismatch" });
    // 照会（期限を見ない）。
    expect(viewMismatchOf(parseOrderView(view({}, { expiresAt: NOW - 100 }))!, expected, false)).toBeUndefined();
    expect(viewMismatchOf(parseOrderView(view({}, { expiresAt: NOW - 100 }))!, expected, true)).toBe("requirements_mismatch");
  });
});

describe("表 B: settle（bind・外部の答え・reconcile）", () => {
  const TX = `0x${"c3".repeat(32)}`;
  const FROM = "0x1111111111111111111111111111111111111111";
  const SIG = `0x${"Ab".repeat(65)}`;
  const local = { from: FROM, nonce: ORDER, sigSha256: sigSha256Of(SIG) };
  const identity = { from: FROM, nonce: ORDER, sigSha256: local.sigSha256 };
  const unknown = { outcome: "unknown", reason: "source_settle_unknown", mayStillSettleUntil: NOW };

  test("sigSha256 は署名の文字列を小文字にしたものの SHA-256（大文字・小文字で変わらない）", () => {
    expect(sigSha256Of(SIG)).toBe(sigSha256Of(SIG.toLowerCase()));
    expect(sigSha256Of(SIG)).toMatch(/^[0-9a-f]{64}$/);
  });
  test("bind: 送ってよいのは 200・ack bound・identity の 3 欄が一致するときだけ", () => {
    expect(classifyBind(response(200, { ack: "bound", identity: { ...identity, from: FROM.toUpperCase().replace("0X", "0x"), nonce: ORDER.toUpperCase().replace("0X", "0x") } }), local)).toEqual({ action: "submit" });
    for (const patch of [{ from: "0x2222222222222222222222222222222222222222" }, { nonce: `0x${"77".repeat(32)}` }, { sigSha256: "0".repeat(64) }]) {
      expect(classifyBind(response(200, { ack: "bound", identity: { ...identity, ...patch } }), local)).toEqual({ action: "stop", ack: "bound" });
    }
    for (const body of [{ ack: "bound" }, { ack: "bound", identity: null }, { ack: "bound", identity: { from: FROM, nonce: ORDER } }, { ack: "bound", identity: { ...identity, sigSha256: 1 } }, { ack: "ok", identity }, { identity }, null, [], "bound"]) {
      expect(classifyBind(response(200, body), local), JSON.stringify(body)).toEqual({ action: "stop", ack: "unknown" });
    }
    for (const status of [201, 400, 401, 403, 404, 425, 429, 500, 503]) expect(classifyBind(response(status, { ack: "bound", identity }), local), String(status)).toEqual({ action: "stop", ack: "unknown" });
    expect(classifyBind(threw, local)).toEqual({ action: "stop", ack: "unknown" });
  });
  test("bind: already-used と 409 は送らず reconcile。409 の code は一覧の値だけ（それ以外は other）", () => {
    expect(classifyBind(response(200, { ack: "already-used", recorded: false, outcome: "pending" }), local)).toEqual({ action: "reconcile", ack: "already-used" });
    expect(classifyBind(response(200, { ack: "already-used", recorded: true, outcome: "accepted", txHash: TX, identity }), local)).toEqual({ action: "reconcile", ack: "already-used" });
    expect(classifyBind(response(200, { ack: "already-used" }), local)).toEqual({ action: "stop", ack: "unknown" });
    expect(classifyBind(response(409, { error: "order-on-other-path" }), local)).toEqual({ action: "reconcile", ack: "refused", code: "order-on-other-path" });
    for (const body of [{ error: "Bearer secret-token-value" }, { error: 7 }, {}, null]) expect(classifyBind(response(409, body), local)).toEqual({ action: "reconcile", ack: "refused", code: "other" });
  });
  test("外部の答え: 待つかどうかだけを決める。はっきり断った（200 success false・4xx）ときだけ待たない", () => {
    expect(classifySubmit(response(200, { success: true, transaction: TX.toUpperCase().replace("0X", "0x") }))).toEqual({ wait: true, success: true, transaction: TX });
    expect(classifySubmit(response(200, { success: true, transaction: "Bearer secret" }))).toEqual({ wait: true, success: true });
    expect(classifySubmit(response(200, { success: false, errorReason: "insufficient_funds", transaction: "" }))).toEqual({ wait: false, success: false });
    for (const status of [400, 402, 404, 429]) expect(classifySubmit(response(status, { success: true }))).toEqual({ wait: false });
    for (const call of [threw, response(500, {}), response(503, { success: false }), response(200, {}), response(200, { success: "true" }), response(200, null), response(200, undefined, null, true), response(302, {})]) expect(classifySubmit(call)).toEqual({ wait: true });
  });
  test("reconcile: settled は accepted・32 バイトの txHash・order.status.exact の一致がそろったときだけ（txRef・eventId は小文字）", () => {
    const order = { status: { exact: { from: FROM.toUpperCase().replace("0X", "0x"), nonce: ORDER, sigSha256: local.sigSha256 } } };
    expect(classifyReconcile(response(200, { outcome: "accepted", txHash: TX.toUpperCase().replace("0X", "0x"), order }), { ...local, nonce: ORDER.toUpperCase().replace("0X", "0x") }, NOW)).toEqual({ result: { outcome: "settled", txRef: TX, eventId: ORDER }, reading: "accepted", response: "ok" });
    // sigSha256 が無い応答は from・nonce だけで照合する（protocol の参考実装と同じ）。
    expect(classifyReconcile(response(200, { outcome: "accepted", txHash: TX, order: { status: { exact: { from: FROM, nonce: ORDER } } } }), local, NOW).result.outcome).toBe("settled");
    const mismatches: unknown[] = [
      { outcome: "accepted", order },
      { outcome: "accepted", txHash: "0x1234", order },
      { outcome: "accepted", txHash: TX },
      { outcome: "accepted", txHash: TX, order: { status: {} } },
      { outcome: "accepted", txHash: TX, order: { status: { exact: { ...order.status.exact, nonce: `0x${"77".repeat(32)}` } } } },
      { outcome: "accepted", txHash: TX, order: { status: { exact: { ...order.status.exact, from: "0x2222222222222222222222222222222222222222" } } } },
      { outcome: "accepted", txHash: TX, order: { status: { exact: { ...order.status.exact, sigSha256: "0".repeat(64) } } } },
    ];
    for (const body of mismatches) expect(classifyReconcile(response(200, body), local, NOW), JSON.stringify(body)).toMatchObject({ result: unknown, reading: "mismatch" });
    expect(classifyReconcile(response(200, { outcome: "accepted", txHash: TX, order }), undefined, NOW)).toMatchObject({ result: unknown, reading: "mismatch" });
  });
  test("reconcile: accepted 以外は全て unknown（rejected にしない）。記録の語は固定", () => {
    for (const outcome of ["pending", "late-paid", "rejected"] as const) expect(classifyReconcile(response(200, { outcome, reason: "closed-expired-unused", txHash: TX }), local, NOW)).toEqual({ result: unknown, reading: outcome, response: "success_false" });
    for (const body of [{ outcome: "Bearer secret" }, { success: true }, {}]) expect(classifyReconcile(response(200, body), local, NOW)).toEqual({ result: unknown, reading: "other", response: "success_false" });
    for (const call of [threw, response(500, { outcome: "accepted" }), response(404, {}), response(503, {})]) expect(classifyReconcile(call, local, NOW)).toEqual({ result: unknown, reading: "unanswered", response: "http_error" });
    for (const body of [null, [], "accepted"]) expect(classifyReconcile(response(200, body), local, NOW)).toEqual({ result: unknown, reading: "unanswered", response: "not_json" });
    expect(classifyReconcile(response(200, { outcome: "pending" }), local, undefined).result).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
  });
});

describe("表 C・D・D′: release", () => {
  const context: ReleaseContext = { orderId: ORDER, sourceTxRef: TX, chainId: 84532, requesterDigest: REQ, resourceDigest: RES };
  const ticket = { deliveryKey: ORDER, txRef: TX, eventId: `84532:${TX}:3` };
  test("POST の表", () => {
    expect(classifyReleasePost(response(200, ticket), context)).toEqual({ action: "released", ticket });
    expect(classifyReleasePost(response(200, { ...ticket, deliveryKey: ORDER.toUpperCase().replace("0X", "0x"), txRef: TX.toUpperCase().replace("0X", "0x") }), context)).toEqual({ action: "released", ticket });
    expect(classifyReleasePost(response(200, { ...ticket, txRef: `0x${"00".repeat(32)}` }), context)).toEqual({ action: "unknown" });
    expect(classifyReleasePost(response(200, { ...ticket, eventId: `1:${TX}:0` }), context)).toEqual({ action: "unknown" });
    expect(classifyReleasePost(response(200, { ...ticket, eventId: `84532:${TX}:x` }), context)).toEqual({ action: "unknown" });
    expect(classifyReleasePost(response(200, undefined), context)).toEqual({ action: "unknown" });
    expect(classifyReleasePost(response(425, { error: "not-ready" }), context)).toEqual({ action: "retry" });
    expect(classifyReleasePost(response(409, { error: "already-claimed" }), context)).toEqual({ action: "reconstruct" });
    for (const code of ["incident", "late-after-reinclusion", "already-delivered", "already-failed"]) expect(classifyReleasePost(response(409, { error: code }), context), code).toEqual({ action: "refused" });
    expect(classifyReleasePost(response(403, { error: "requester-mismatch" }), context)).toEqual({ action: "refused" });
    expect(classifyReleasePost(response(404, { error: "unknown-order" }), context)).toEqual({ action: "refused" });
    expect(classifyReleasePost(response(409, { error: "something-else" }), context)).toEqual({ action: "unknown" });
    expect(classifyReleasePost(response(429, {}), context)).toEqual({ action: "probe" });
    expect(classifyReleasePost(response(503, {}), context)).toEqual({ action: "probe" });
    expect(classifyReleasePost(threw, context)).toEqual({ action: "probe" });
    expect(classifyReleasePost(response(401, { error: "unauthorized" }), context)).toEqual({ action: "unknown", note: "unauthorized" });
    expect(classifyReleasePost(response(400, {}), context)).toEqual({ action: "unknown" });
    expect(classifyReleasePost(response(204, undefined), context)).toEqual({ action: "unknown" });
    expect(classifyReleasePost(response(404, { error: "unknown" }), context)).toEqual({ action: "unknown" });
  });
  const authorized = (release: Record<string, unknown> = {}, status: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) =>
    view(overrides, { state: "accepted", release: { state: "authorized", deliveryKey: ORDER, txRef: TX, eventId: `84532:${TX}:3`, ...release }, ...status });
  test("D（already-claimed の後）: 条件が揃えば released、1 欄でも違えば refused、読めない・4xx・5xx・transport は unknown", () => {
    expect(classifyReconstruct(response(200, authorized()), context, "claimed")).toEqual({ action: "released", ticket });
    expect(classifyReconstruct(response(200, authorized({}, { state: "settled" })), context, "claimed")).toEqual({ action: "released", ticket });
    const bad: [string, unknown][] = [
      ["requester", authorized({}, {}, { binding: { requesterDigest: RES, resourceDigest: RES } })],
      ["resource", authorized({}, {}, { binding: { requesterDigest: REQ, resourceDigest: REQ } })],
      ["state open", authorized({}, { state: "open" })],
      ["release none", authorized({ state: "none" })],
      ["release delivered", authorized({ state: "delivered" })],
      ["deliveryKey", authorized({ deliveryKey: `0x${"11".repeat(32)}` })],
      ["txRef", authorized({ txRef: `0x${"11".repeat(32)}` })],
      ["eventId", authorized({ eventId: "nope" })],
      ["afterRelease", authorized({ afterRelease: "reorged" })],
    ];
    for (const [name, v] of bad) expect(classifyReconstruct(response(200, v), context, "claimed"), name).toEqual({ action: "refused" });
    for (const call of [response(200, undefined), response(400, {}), response(401, {}), response(404, { error: "unknown-order" }), response(429, {}), response(503, {}), threw]) {
      expect(classifyReconstruct(call, context, "claimed")).toEqual({ action: "unknown" });
    }
  });
  test("D′（transport の失敗の後）: released は同じ条件、release none は retry、それ以外は unknown（refused にしない）", () => {
    expect(classifyReconstruct(response(200, authorized()), context, "transport")).toEqual({ action: "released", ticket });
    expect(classifyReconstruct(response(200, authorized({ state: "none" })), context, "transport")).toEqual({ action: "retry" });
    expect(classifyReconstruct(response(200, authorized({ txRef: `0x${"11".repeat(32)}` })), context, "transport")).toEqual({ action: "unknown" });
    expect(classifyReconstruct(response(200, authorized({ state: "delivered" })), context, "transport")).toEqual({ action: "unknown" });
    expect(classifyReconstruct(response(500, {}), context, "transport")).toEqual({ action: "unknown" });
  });
});

describe("表 E: complete", () => {
  test.each<[string, CallOutcome, Record<string, unknown>]>([
    ["transport", threw, { action: "retry" }],
    ["429", response(429, {}), { action: "retry" }],
    ["503", response(503, {}), { action: "retry" }],
    ["200 同じ state", response(200, { state: "delivered", completedAt: NOW }), { action: "completed" }],
    ["200 違う state", response(200, { state: "failed", completedAt: NOW }), { action: "unreported", reason: "unavailable" }],
    ["200 読めない", response(200, undefined), { action: "unreported", reason: "unavailable" }],
    ["204", response(204, undefined), { action: "unreported", reason: "unavailable" }],
    ["409 conflicting-outcome", response(409, { error: "conflicting-outcome" }), { action: "unreported", reason: "conflicting_outcome" }],
    ["409 not-authorized", response(409, { error: "not-authorized" }), { action: "unreported", reason: "not_authorized" }],
    ["409 delivery-key-mismatch", response(409, { error: "delivery-key-mismatch" }), { action: "unreported", reason: "delivery_key_mismatch" }],
    ["409 その他", response(409, { error: "weird" }), { action: "unreported", reason: "refused" }],
    ["400", response(400, {}), { action: "unreported", reason: "invalid_request" }],
    ["401", response(401, { error: "unauthorized" }), { action: "unreported", reason: "unauthorized" }],
    ["404 unknown-challenge", response(404, { error: "unknown-challenge" }), { action: "unreported", reason: "unknown_order" }],
    ["404 unknown-order", response(404, { error: "unknown-order" }), { action: "unreported", reason: "unknown_order" }],
    ["404 unknown（tenant 無し）", response(404, { error: "unknown" }), { action: "unreported", reason: "unknown_tenant" }],
    ["404 読めない", response(404, undefined), { action: "unreported", reason: "unknown_tenant" }],
    ["403", response(403, {}), { action: "unreported", reason: "refused" }],
    ["418", response(418, {}), { action: "unreported", reason: "refused" }],
    ["302", response(302, undefined), { action: "unreported", reason: "refused" }],
  ])("%s", (_name, call, want) => {
    expect(classifyComplete(call, "delivered")).toEqual(want);
  });
});

describe("予算（§3.7）", () => {
  test("Retry-After は整数秒だけ、1 回の試行の期限は min(perTry, 残り)、残り 1 秒未満は試行しない、待ちは残りに収まるときだけ", () => {
    expect(retryAfterMsOf("30", 1)).toBe(30_000);
    expect(retryAfterMsOf(" 7 ", 1)).toBe(7_000);
    expect(retryAfterMsOf("Sun, 06 Nov 1994 08:49:37 GMT", 1)).toBe(1);
    expect(retryAfterMsOf("-1", 1)).toBe(1);
    expect(retryAfterMsOf(null, 5)).toBe(5);
    expect(tryDeadlineOf(20_000, NOW + 5_000, NOW)).toBe(5_000);
    expect(tryDeadlineOf(2_000, NOW + 5_000, NOW)).toBe(2_000);
    expect(tryDeadlineOf(2_000, NOW + 999, NOW)).toBeUndefined();
    expect(waitFits(2_000, NOW + 3_000, NOW)).toBe(true);
    expect(waitFits(2_001, NOW + 3_000, NOW)).toBe(false);
  });
});

describe("実装レビュー 3 の #1: afterRelease の有無は型を問わない", () => {
  const context: ReleaseContext = { orderId: ORDER, sourceTxRef: TX, chainId: 84532, requesterDigest: REQ, resourceDigest: RES };
  test.each<[string, unknown]>([["null", null], ["object", {}], ["true", true], ["number", 42], ["array", []]])("afterRelease が %s（文字列で無い）でも「有る」と読み、D は refused、D′ は unknown", (_name, value) => {
    const v = view({}, { state: "accepted", release: { state: "authorized", deliveryKey: ORDER, txRef: TX, eventId: `84532:${TX}:3`, afterRelease: value } });
    expect(parseOrderView(v)?.status.release?.afterRelease).toBe("malformed");
    expect(classifyReconstruct(response(200, v), context, "claimed")).toEqual({ action: "refused" });
    expect(classifyReconstruct(response(200, v), context, "transport")).toEqual({ action: "unknown" });
  });
});
