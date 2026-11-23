/**
 * 運用者の確認 `tools/subetha-exact-inspect.ts`（`docs/subetha-exact-inbound-design.md` §8、AC-5、FR-9.2 (d)、タスク T-6）。
 * 一覧の形と閉じた集合、`--remote` は GET と requester の照会だけ（POST 0）、`mismatch` の 3 条件、`--abandon` の行・理由の token・Router 稼働中の拒否（lock）・
 * 前後の byte 比較、敵対的な sentinel（fixture の自由な文が出力に現れず `other` に写る）。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { generatePrivateKey } from "viem/accounts";

import { createSubethaExactInbound, type SubethaExactInbound } from "../../src/adapters/inbound/subetha-exact.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import { abandon, inspect, type InspectLine } from "../../tools/subetha-exact-inspect.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { createSubethaExactFacilitator, type FacilitatorFixture } from "../fixtures/subetha-exact-facilitator.js";

const PROVIDER = "router-test";
const TOKEN = "canary-provider-token-7f3c";
const CHAIN_ID = 84532;
const NETWORK = `eip155:${CHAIN_ID}`;
const ASSET = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const DOMAIN = { name: "zERC20 USD Coin", version: "1" };
const ROUTE_ID = "md-zusdc-exact";
const BINDING = `${ROUTE_ID}|GET|%2Fv1%2Froutes%2F${ROUTE_ID}%2Fresource`;
const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const payer = createX402Payer(generatePrivateKey());

let fixture: FacilitatorFixture;
let workDir: string;
let journalPath: string;
let adapter: SubethaExactInbound | undefined;
const clockMs = 1_800_000_000_000;

async function makeAdapter(): Promise<SubethaExactInbound> {
  const created = createSubethaExactInbound({
    facilitatorUrl: `${fixture.baseUrl}/p/${PROVIDER}`,
    settleFacilitatorUrl: `${fixture.baseUrl}/xfac`,
    token: () => TOKEN,
    transport: createGuardedTransport({ allowLoopback: true, report: () => undefined }),
    asset: { network: NETWORK, id: ASSET, decimals: 6, domain: DOMAIN },
    ledgerDir: path.join(workDir, "subetha-exact"),
    limits: { maxRequestsTotal: 100, maxUnresolved: 10, requestsPerMinute: 60 },
    now: () => clockMs,
    timeouts: { createMs: 2_000, verifyMs: 2_000, settleMs: 2_000, statusMs: 2_000, releaseMs: 2_000, completeMs: 2_000, releaseRetryWaitMs: 30, completeRetryWaitMs: 30 },
  });
  await created.startup();
  adapter = created;
  return created;
}
const request = (requestId: string) => ({ routeId: ROUTE_ID, amount: "2000", asset: ASSET, network: NETWORK, routeBinding: BINDING, nowMs: clockMs, requester: { principalId: "alice", requestId } });
const credentialFor = async (offer: InboundOffer): Promise<PaymentCredential> => JSON.parse(Buffer.from(await payer.credentialFor(offer, CHAIN_ID), "base64").toString("utf8")) as PaymentCredential;
/** core の代わりに journal の行を直接書く（inspect は journal を読むだけ）。 */
let seq = 0;
async function journalRow(paymentId: string, event: string, patch: Record<string, unknown>): Promise<void> {
  seq += 1;
  await writeFile(journalPath, `${JSON.stringify({ seq, at: new Date(clockMs).toISOString(), paymentId, event, patch })}\n`, { flag: "a" });
}
const remoteOptions = () => ({ facilitatorUrl: `${fixture.baseUrl}/p/${PROVIDER}`, settleFacilitatorUrl: `${fixture.baseUrl}/xfac`, token: () => TOKEN, allowLoopback: true });
const attemptLines = (lines: InspectLine[]) => lines.filter((l) => l.kind === "attempt");

beforeEach(async () => {
  workDir = await mkdtemp(path.join(runtimeRoot, "t6-inspect-"));
  journalPath = path.join(workDir, "journal.ndjson");
  seq = 0;
  fixture = createSubethaExactFacilitator({ providerId: PROVIDER, bearer: TOKEN, chainId: CHAIN_ID, asset: ASSET, domainName: DOMAIN.name, domainVersion: DOMAIN.version, ttlSeconds: 300, now: () => Math.floor(clockMs / 1000) });
  await fixture.listen();
});
afterEach(async () => {
  await adapter?.close().catch(() => undefined);
  adapter = undefined;
  await fixture.close();
  await rm(workDir, { recursive: true, force: true });
});

describe("一覧（読取だけ）", () => {
  test("attempt ごとの 1 行（orderId・paymentId・terminal・settle・release・complete・unresolved）と summary。journal が無くても動く。記録は変わらず、facilitator は呼ばれない", async () => {
    await makeAdapter();
    const offer = await adapter!.createOffer(request("a"));
    const credential = await credentialFor(offer);
    const orderId = offer.extra.challengeNonce;
    await journalRow("pay-1", "created", { quoteId: orderId, routeId: ROUTE_ID, principalId: "alice", requestId: "a", source: { amount: "2000", asset: ASSET, network: NETWORK, offer, settleWindow: offer.extra.expiresAt } });
    await journalRow("pay-1", "source_pending", {});
    const settled = await adapter!.settle(offer, credential, { routeId: ROUTE_ID });
    if (settled.outcome !== "settled") throw new Error("settle");
    await journalRow("pay-1", "source_settled", { txRef: settled.txRef });
    const released = await adapter!.release!(offer, { routeId: ROUTE_ID, deadlineMs: clockMs + 60_000, sourceTxRef: settled.txRef });
    if (released.outcome !== "released") throw new Error("release");
    await journalRow("pay-1", "source_released", { deliveryKey: released.deliveryKey, txRef: released.txRef, eventId: released.eventId });
    await journalRow("pay-1", "destination_pending", { attempt: 1 });
    await journalRow("pay-1", "delivered", { body: {}, contentType: "application/json" });
    expect(await adapter!.complete!(offer, orderId, "delivered", { routeId: ROUTE_ID })).toEqual({ outcome: "completed" });
    await journalRow("pay-1", "source_completed", { outcome: "delivered" });
    // 2 つ目: 作成の 503（結果の分からない attempt）。
    fixture.setMode("create", "busy");
    await expect(adapter!.createOffer(request("b"))).rejects.toThrow();
    await adapter!.close();
    const before = { journal: await readFile(journalPath, "utf8"), ledger: await readFile(path.join(workDir, "subetha-exact", "orders.ndjson"), "utf8") };
    const callsBefore = JSON.parse(JSON.stringify(fixture.calls));
    const lines = await inspect({ journalPath, nowSec: Math.floor(clockMs / 1000) });
    const attempts = attemptLines(lines);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ kind: "attempt", orderId, paymentId: "pay-1", routeId: ROUTE_ID, existing: false, settle: "settled", sourceTxRef: settled.txRef, release: "released", complete: "completed", terminal: "delivered", unresolved: false, mismatch: false });
    expect(attempts[0]).not.toHaveProperty("remote");
    expect(attempts[1]).toMatchObject({ kind: "attempt", createFailed: "facilitator_busy", unresolved: true, mismatch: false });
    expect(attempts[1]).not.toHaveProperty("orderId");
    expect(lines.at(-1)).toEqual({ kind: "summary", attempts: 2, unresolved: 1, discovered: 0, mismatches: 0, remote: false });
    // 読取だけ: byte が同じ、facilitator の呼び出しは増えない、出力に token が無い。
    expect(await readFile(journalPath, "utf8")).toBe(before.journal);
    expect(await readFile(path.join(workDir, "subetha-exact", "orders.ndjson"), "utf8")).toBe(before.ledger);
    expect(fixture.calls).toEqual(callsBefore);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    expect(JSON.stringify(lines)).not.toContain(fixture.baseUrl!);
    // journal が無い場所でも動く（attempt は ledger から）。
    const elsewhere = await inspect({ journalPath: path.join(workDir, "nope", "journal.ndjson") });
    expect(elsewhere.at(-1)).toMatchObject({ kind: "summary", attempts: 0 });
  });

  test("--remote: 注文ごとの GET と、注文の分からない attempt の照会だけ（POST 0）。remote の欄は閉じた集合、自由な文は other に写り出力に現れない。mismatch の 3 条件", async () => {
    await makeAdapter();
    // (1) Router が source_failed で remote が accepted（外部の支払い）。
    const a = await adapter!.createOffer(request("a"));
    await journalRow("pay-a", "created", { quoteId: a.extra.challengeNonce, routeId: ROUTE_ID, principalId: "alice", requestId: "a", source: { amount: "2000", asset: ASSET, network: NETWORK, offer: a, settleWindow: a.extra.expiresAt } });
    await journalRow("pay-a", "source_pending", {});
    await journalRow("pay-a", "source_failed", { outcome: "rejected", reason: "verify_failed", mayStillSettleUntil: a.extra.expiresAt - 1 });
    await fetch(`${fixture.baseUrl}/_fixture/orders/${a.extra.challengeNonce}/paid-external`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    // (2) Router に release の行が無く remote が authorized（遠隔の記録の後に落ちた）。
    const b = await adapter!.createOffer(request("b"));
    const bCredential = await credentialFor(b);
    const bSettled = await adapter!.settle(b, bCredential, { routeId: ROUTE_ID });
    if (bSettled.outcome !== "settled") throw new Error("settle b");
    await journalRow("pay-b", "created", { quoteId: b.extra.challengeNonce, routeId: ROUTE_ID, principalId: "alice", requestId: "b", source: { amount: "2000", asset: ASSET, network: NETWORK, offer: b } });
    await journalRow("pay-b", "source_pending", {});
    await journalRow("pay-b", "source_settled", { txRef: bSettled.txRef });
    await journalRow("pay-b", "paid_undelivered", { outcome: "not_sent", reason: "interrupted_at_restart" });
    await fetch(`${fixture.baseUrl}/p/${PROVIDER}/exact/orders/${b.extra.challengeNonce}/release`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ requesterDigest: adapter!.ledger!.attempts().find((x) => x.created?.orderId === b.extra.challengeNonce)!.requesterDigest }) });
    // (3) 注文の分からない attempt に remote の注文がある（遅れた割当）。
    fixture.setMode("create", "busy-then-create");
    await expect(adapter!.createOffer(request("c"))).rejects.toThrow();
    const cAttempt = adapter!.ledger!.attempts().find((x) => x.created === undefined)!;
    fixture.allocate({ requesterDigest: cAttempt.requesterDigest, resourceDigest: cAttempt.resourceDigest });
    // 普通の delivered（mismatch 無し）。
    fixture.setMode("create", "ok");
    const d = await adapter!.createOffer(request("d"));
    await adapter!.settle(d, await credentialFor(d), { routeId: ROUTE_ID });
    await journalRow("pay-d", "created", { quoteId: d.extra.challengeNonce, routeId: ROUTE_ID, principalId: "alice", requestId: "d", source: { amount: "2000", asset: ASSET, network: NETWORK, offer: d } });
    await journalRow("pay-d", "source_settled", { txRef: "0xd" });
    await adapter!.close();
    const callsBefore = JSON.parse(JSON.stringify(fixture.calls)) as { byRoute: Record<string, number> };
    const before = await readFile(path.join(workDir, "subetha-exact", "orders.ndjson"), "utf8");
    // 敵対的な sentinel: 1 つ目の GET は自由な文を含む形違いの state を返す。
    fixture.setMode("status", "raw", { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: a.extra.challengeNonce, existing: false, requirements: { scheme: "exact", network: NETWORK, asset: ASSET, amount: "2000", payTo: a.payTo, maxTimeoutSeconds: 150, extra: DOMAIN }, status: { state: "SENTINEL-free-text https://leak.example", expiresAt: 1, release: { state: "SENTINEL-2", afterRelease: "SENTINEL-3" }, exact: { state: "SENTINEL-4", origin: "SENTINEL-5" } }, binding: { requesterDigest: `0x${"00".repeat(32)}`, resourceDigest: `0x${"00".repeat(32)}` } }) });
    const lines = await inspect({ journalPath, remote: remoteOptions(), nowSec: Math.floor(clockMs / 1000) });
    const text = JSON.stringify(lines);
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain("leak.example");
    expect(text).not.toContain(TOKEN);
    const attempts = attemptLines(lines);
    const byOrder = (id: string) => attempts.find((l) => l["orderId"] === id)!;
    // 1 つ目の GET（a）は sentinel の応答 → other に写る。注文 a はもう一度読まないので remote は other。
    expect(byOrder(a.extra.challengeNonce)["remote"]).toEqual({ state: "other", release: { state: "other", afterRelease: "other" }, exact: { state: "other", origin: "other" } });
    expect(byOrder(b.extra.challengeNonce)).toMatchObject({ terminal: "paid_undelivered", remote: { state: "accepted", release: { state: "authorized" }, exact: { state: "paid", origin: "external-broadcast" } }, mismatch: true });
    expect(attempts.find((l) => l["attemptId"] === cAttempt.attemptId)).toMatchObject({ foundByLookup: true, mismatch: true, unresolved: true });
    expect(byOrder(d.extra.challengeNonce)).toMatchObject({ remote: { state: "accepted", release: { state: "none" } }, mismatch: false });
    // (1) は sentinel で読めなかったので、もう一度（status を戻して）: Router が source_failed で remote が accepted → mismatch。
    fixture.setMode("status", "ok");
    const again = await inspect({ journalPath, remote: remoteOptions(), nowSec: Math.floor(clockMs / 1000) });
    expect(attemptLines(again).find((l) => l["orderId"] === a.extra.challengeNonce)).toMatchObject({ terminal: "source_failed", mayStillSettleUntil: a.extra.expiresAt - 1, remote: { state: "accepted", exact: { origin: "external-broadcast" } }, mismatch: true });
    expect(again.at(-1)).toMatchObject({ kind: "summary", mismatches: 3, remote: true });
    // GET だけ: status は注文ごと、requesters は注文の分からない pair ごと（2 回の inspect で 2 倍）。POST の経路は増えない。
    const after = fixture.calls.byRoute;
    expect(after["status"]).toBe((callsBefore.byRoute["status"] ?? 0) + 2 * 3);
    expect(after["requesters"]).toBe((callsBefore.byRoute["requesters"] ?? 0) + 2);
    for (const route of ["create", "settle", "release", "complete", "verify"]) expect(after[route] ?? 0, route).toBe(callsBefore.byRoute[route] ?? 0);
    expect(await readFile(path.join(workDir, "subetha-exact", "orders.ndjson"), "utf8")).toBe(before);
  });
});

describe("--abandon", () => {
  test("ledger に abandoned の 1 行だけ（理由の token）。知らない attempt・悪い理由・二重は書かない。Router（ledger の lock）が動いていれば locked", async () => {
    await makeAdapter();
    fixture.setMode("create", "busy");
    await expect(adapter!.createOffer(request("a"))).rejects.toThrow();
    const attemptId = adapter!.ledger!.attempts()[0]!.attemptId;
    // Router が動いている（lock あり）。
    expect(await abandon(journalPath, attemptId, "operator_timeout")).toBe("locked");
    await adapter!.close();
    const ledgerFile = path.join(workDir, "subetha-exact", "orders.ndjson");
    const before = await readFile(ledgerFile, "utf8");
    expect(await abandon(journalPath, attemptId, "operator_whatever")).toBe("bad_reason");
    expect(await abandon(journalPath, "deadbeef", "operator_timeout")).toBe("unknown_attempt");
    expect(await readFile(ledgerFile, "utf8")).toBe(before);
    expect(await abandon(journalPath, attemptId, "operator_timeout")).toBe("ok");
    const after = await readFile(ledgerFile, "utf8");
    expect(after.startsWith(before)).toBe(true);
    const added = after.slice(before.length).trim().split("\n");
    expect(added).toHaveLength(1);
    expect(JSON.parse(added[0]!)).toMatchObject({ paymentId: attemptId, event: "abandoned", patch: { by: "operator", reason: "operator_timeout" } });
    expect(await abandon(journalPath, attemptId, "operator_other")).toBe("already");
    const lines = await inspect({ journalPath, nowSec: Math.floor(clockMs / 1000) });
    expect(attemptLines(lines)[0]).toMatchObject({ abandoned: "operator_timeout", unresolved: false });
    // adapter を再び開くと未解決は 0（abandon が効いている）。
    await makeAdapter();
    expect(adapter!.ledger!.unresolvedCount(Math.floor(clockMs / 1000))).toBe(0);
  });
});

describe("実装レビュー 3 の #2・#5", () => {
  test("abandon 済みの attempt も照会し、見つかった注文は discovered の行（foundByLookup）で remote の欄つきで出る。createMs・settleMs・releaseMs・completeMs。Retry-After が 60 秒を超える照会は待たずに諦める", async () => {
    await makeAdapter();
    fixture.setMode("create", "busy-then-create");
    await expect(adapter!.createOffer(request("a"))).rejects.toThrow();
    const attempt = adapter!.ledger!.attempts()[0]!;
    fixture.setMode("create", "ok");
    const b = await adapter!.createOffer(request("b"));
    const bCredential = await credentialFor(b);
    const settled = await adapter!.settle(b, bCredential, { routeId: ROUTE_ID });
    if (settled.outcome !== "settled") throw new Error("settle");
    const released = await adapter!.release!(b, { routeId: ROUTE_ID, deadlineMs: clockMs + 60_000, sourceTxRef: settled.txRef });
    expect(released.outcome).toBe("released");
    await adapter!.complete!(b, b.extra.challengeNonce, "delivered", { routeId: ROUTE_ID });
    await adapter!.close();
    expect(await abandon(journalPath, attempt.attemptId, "operator_facilitator_reset")).toBe("ok");
    // abandon の後に割当が終わる。
    const order = fixture.allocate({ requesterDigest: attempt.requesterDigest, resourceDigest: attempt.resourceDigest });
    const lines = await inspect({ journalPath, remote: remoteOptions(), nowSec: Math.floor(clockMs / 1000) });
    const found = lines.find((l) => l.kind === "discovered" && l["orderId"] === order.orderId)!;
    expect(found).toMatchObject({ kind: "discovered", foundByLookup: true, remote: { state: "open", release: { state: "none" } }, requesterDigest: attempt.requesterDigest });
    expect(attemptLines(lines)[0]).toMatchObject({ abandoned: "operator_facilitator_reset", foundByLookup: true, mismatch: true, unresolved: false });
    expect(attemptLines(lines)[1]).toMatchObject({ createMs: expect.any(Number), settleMs: expect.any(Number), releaseMs: expect.any(Number), completeMs: expect.any(Number) });
    expect(lines.at(-1)).toMatchObject({ kind: "summary", foundByLookup: 1 });
    // Retry-After 120 の 429: 待たない（照会を諦める）。
    fixture.setMode("status", "raw", { status: 429, headers: { "retry-after": "120" }, body: "{}" });
    const t0 = Date.now();
    const again = await inspect({ journalPath, remote: remoteOptions(), nowSec: Math.floor(clockMs / 1000) });
    expect(Date.now() - t0).toBeLessThan(5_000);
    const bLine = attemptLines(again).find((l) => l["orderId"] === b.extra.challengeNonce)!;
    expect(bLine["remote"]).toBe("unavailable");
  });
});
