/**
 * 秘匿購入の記録・journal・store（設計 `docs/zktls-router-design.md` §7、要件 FR-Z06・FR-Z25）。
 * `privateFieldsOf` の明示的な復元と `privateInvalid`、`reservePrivateIssuance` の二重一意性（同時・再起動・成否不明）、private_* 行の reduce、再起動の帰結。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { open as openFile } from "node:fs/promises";

import { openJournal, type Journal } from "../../src/core/journal.js";
import { IntentStore, intentFromCreated, privateBindingOf, privateFieldsOf } from "../../src/core/store.js";
import { toPublicStatus } from "../../src/core/intent.js";
import { privateProjectionOf } from "../../src/core/orchestrator.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const golden = (name: string): unknown => JSON.parse(readFileSyncUtf8(path.join(import.meta.dirname, "../fixtures/private/golden", name)));
import { readFileSync } from "node:fs";
function readFileSyncUtf8(file: string): string {
  return readFileSync(file, "utf8");
}

const PROFILE_ID = "priv-x402";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ENVELOPE = {
  version: "phase5-intent-v1",
  order: (golden("post-intent.json") as { order: unknown }).order,
  outbound: { protocol: "x402", network: "eip155:84532", asset: USDC, payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1", maxAmount: "10000" },
  inbound: { network: "eip155:84532", asset: USDC, maxTotal: "20000" },
};
const INTENT_BYTES = Buffer.from(JSON.stringify(ENVELOPE), "utf8");
const INTENT_SHA = createHash("sha256").update(INTENT_BYTES).digest("hex");
const URL = "https://test-server.io/select";
/** 別の正しい intent（公開 GET の骨格。別の order_id）。二重一意性の (b) のため。 */
const ENVELOPE_B = {
  ...ENVELOPE,
  order: { ...(ENVELOPE.order as Record<string, unknown>), order_id: "0".repeat(32) + "b".repeat(32), target: { host: "test-server.io", port: 443, path: "/v1/paid-snapshot" }, request: { framing: "phase5-get-public-v1", method: "GET", content_type: "", body_len: 0, body_commitment_hex: "", executor_header: "", max_executor_value_len: 0 } },
};
const INTENT_B_BYTES = Buffer.from(JSON.stringify(ENVELOPE_B), "utf8");
const INTENT_B_SHA = createHash("sha256").update(INTENT_B_BYTES).digest("hex");
const URL_B = "https://test-server.io/v1/paid-snapshot";
const POLICY = { minCredentialLifetimeMs: 40_000, sessionTimeoutMs: 180_000, attestTimeoutMs: 600_000, retentionMs: 3_600_000 };
const LIMITS = { maxIntentBytes: 2048, maxBundleBytes: 262_144, maxRecordBytes: 65_536 };

function createdPatch(overrides: { binding?: string; intentB64?: string; upstream?: unknown; privatePatch?: Record<string, unknown>; omit?: "dynamic" | "upstream" | "private"; quoteId?: string; envelope?: "A" | "B" } = {}): Record<string, unknown> {
  if (overrides.envelope === "B") {
    return {
      ...createdPatch({ ...overrides, envelope: "A" }),
      upstream: { url: URL_B, method: "GET" },
      source: { amount: "11000", asset: USDC, network: "eip155:84532", offer: { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "11000", payTo: "0xrouter", maxTimeoutSeconds: 60, extra: { challengeNonce: overrides.quoteId ?? "0xnonce-1", expiresAt: 1_800_000_060, routeBinding: privateBindingOf(PROFILE_ID, "GET", URL_B, INTENT_B_SHA) } } },
      private: { intentSha256: INTENT_B_SHA, intentB64: INTENT_B_BYTES.toString("base64"), orderId: (ENVELOPE_B.order as { order_id: string }).order_id, method: "GET", framing: "phase5-get-public-v1", bodyLen: 0, bodyCommitmentHex: "", policy: POLICY, limits: LIMITS },
    };
  }
  const binding = overrides.binding ?? privateBindingOf(PROFILE_ID, "POST", URL, INTENT_SHA);
  const patch: Record<string, unknown> = {
    quoteId: overrides.quoteId ?? "0xnonce-1",
    routeId: PROFILE_ID,
    principalId: "alice",
    requestId: "r1",
    source: {
      amount: "11000",
      asset: USDC,
      network: "eip155:84532",
      offer: { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "11000", payTo: "0xrouter", maxTimeoutSeconds: 60, extra: { challengeNonce: overrides.quoteId ?? "0xnonce-1", expiresAt: 1_800_000_060, routeBinding: binding } },
    },
    destination: { quoted: "10000", asset: USDC, network: "eip155:84532", selectedOffer: { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "10000", payTo: "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } } },
    quoteFingerprint: "sha256:" + "0".repeat(64),
    routeFingerprint: "sha256:" + "1".repeat(64),
    approvalDeadlineMs: 1_800_000_050_000,
    upstream: overrides.upstream ?? { url: URL, method: "POST", body: "{}", bodySha256: createHash("sha256").update("{}").digest("hex") },
    dynamic: {
      profileId: PROFILE_ID,
      profile: { profileId: PROFILE_ID, sourceRail: "x402", rail: "x402", source: { network: "eip155:84532", asset: USDC, decimals: 6, payTo: "0xrouter" }, destination: { scheme: "exact", network: "eip155:84532", asset: USDC, decimals: 6 } },
      pricing: { upstreamAmount: "10000", converted: "10000", fee: "1000", total: "11000" },
      ownerKeyHash: "sha256:" + "2".repeat(64),
      reservation: { legs: [{ network: "eip155:84532", asset: USDC, amount: "11000" }] },
    },
    private: {
      intentSha256: INTENT_SHA,
      intentB64: overrides.intentB64 ?? INTENT_BYTES.toString("base64"),
      orderId: (ENVELOPE.order as { order_id: string }).order_id,
      method: "POST",
      framing: "phase5-post-json-canonical-v1",
      bodyLen: 88,
      bodyCommitmentHex: (ENVELOPE.order as { request: { body_commitment_hex: string } }).request.body_commitment_hex,
      policy: POLICY,
      limits: LIMITS,
      ...(overrides.privatePatch ?? {}),
    },
  };
  if (overrides.omit !== undefined) delete patch[overrides.omit];
  return patch;
}

describe("privateFieldsOf（明示的な復元）", () => {
  test("正しい記録は封筒から復元し、方針の写しを持つ", () => {
    const fields = privateFieldsOf(createdPatch());
    expect(fields.privateInvalid).toBeUndefined();
    expect(fields.private).toMatchObject({ intentSha256: INTENT_SHA, orderId: (ENVELOPE.order as { order_id: string }).order_id, method: "POST", bodyLen: 88, target: { host: "test-server.io", port: 443, path: "/select" }, outbound: ENVELOPE.outbound, inbound: ENVELOPE.inbound, policy: POLICY, limits: LIMITS });
    expect(fields.private?.intentB64).toBe(INTENT_BYTES.toString("base64"));
    const intent = intentFromCreated("pay-1", "2026-10-20T00:00:00.000Z", createdPatch());
    expect(intent.private?.intentSha256).toBe(INTENT_SHA);
    expect(intent.dynamic?.profileId).toBe(PROFILE_ID);
  });
  test("private 欄が無ければ何も足さない（既存の記録は不変）", () => {
    expect(privateFieldsOf(createdPatch({ omit: "private" }))).toEqual({});
    const { private: _p, ...rest } = intentFromCreated("pay-1", "t", createdPatch({ omit: "private" }));
    expect(rest.privateInvalid).toBeUndefined();
  });
  test("読めない形は privateInvalid（dynamic は保つ）", () => {
    expect(privateFieldsOf(createdPatch({ omit: "dynamic" }))).toEqual({ privateInvalid: true });
    expect(privateFieldsOf(createdPatch({ omit: "upstream" }))).toEqual({ privateInvalid: true });
    // 封筒の sha が違う
    expect(privateFieldsOf(createdPatch({ privatePatch: { intentSha256: "0".repeat(64) } }))).toEqual({ privateInvalid: true });
    // base64 が正規でない
    expect(privateFieldsOf(createdPatch({ intentB64: INTENT_BYTES.toString("base64") + "\n" }))).toEqual({ privateInvalid: true });
    // 封筒が規則を満たさない（compact でない）
    const pretty = Buffer.from(JSON.stringify(ENVELOPE, null, 1), "utf8");
    expect(privateFieldsOf(createdPatch({ intentB64: pretty.toString("base64"), privatePatch: { intentSha256: createHash("sha256").update(pretty).digest("hex") } }))).toEqual({ privateInvalid: true });
    // 写しが封筒と食い違う
    expect(privateFieldsOf(createdPatch({ privatePatch: { bodyLen: 89 } }))).toEqual({ privateInvalid: true });
    expect(privateFieldsOf(createdPatch({ privatePatch: { method: "GET" } }))).toEqual({ privateInvalid: true });
    // 方針・上限
    expect(privateFieldsOf(createdPatch({ privatePatch: { policy: { ...POLICY, retentionMs: 0 } } }))).toEqual({ privateInvalid: true });
    expect(privateFieldsOf(createdPatch({ privatePatch: { limits: { maxIntentBytes: 2048 } } }))).toEqual({ privateInvalid: true });
    // 探りの形
    expect(privateFieldsOf(createdPatch({ upstream: { url: URL, method: "POST", body: '{"a":1}', bodySha256: createHash("sha256").update('{"a":1}').digest("hex") } }))).toEqual({ privateInvalid: true });
    expect(privateFieldsOf(createdPatch({ upstream: { url: "https://other.test/select", method: "POST", body: "{}", bodySha256: createHash("sha256").update("{}").digest("hex") } }))).toEqual({ privateInvalid: true });
    // 束縛
    expect(privateFieldsOf(createdPatch({ binding: privateBindingOf(PROFILE_ID, "POST", URL, "0".repeat(64)) }))).toEqual({ privateInvalid: true });
    expect(privateFieldsOf(createdPatch({ binding: privateBindingOf("other", "POST", URL, INTENT_SHA) }))).toEqual({ privateInvalid: true });
    expect(privateFieldsOf(createdPatch({ binding: `dynamic|${PROFILE_ID}|POST|${encodeURIComponent(URL)}|sha256:x` }))).toEqual({ privateInvalid: true });
    const invalid = intentFromCreated("pay-1", "t", createdPatch({ privatePatch: { bodyLen: 89 } }));
    expect(invalid.privateInvalid).toBe(true);
    expect(invalid.private).toBeUndefined();
    expect(invalid.dynamic?.profileId).toBe(PROFILE_ID);
  });
});

let workDir: string;
let journalPath: string;
const opened: Journal[] = [];

beforeEach(async () => {
  await mkdir(runtimeRoot, { recursive: true });
  workDir = await mkdtemp(path.join(runtimeRoot, "private-store-"));
  journalPath = path.join(workDir, "journal.ndjson");
});
afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.close();
  await rm(workDir, { recursive: true, force: true });
});

async function load(): Promise<{ store: IntentStore; journal: Journal }> {
  const journal = await openJournal({ journalPath });
  opened.push(journal);
  const store = await IntentStore.load(journal);
  return { store, journal };
}

async function settled(store: IntentStore, paymentId: string, quoteId: string, eventId = "0xnonce-auth", envelope: "A" | "B" = "A"): Promise<void> {
  await store.append(paymentId, "created", createdPatch({ quoteId, envelope }));
  await store.append(paymentId, "source_pending", {});
  await store.append(paymentId, "source_settled", { txRef: `0xtx-${paymentId}`, eventId });
}

async function events(): Promise<string[]> {
  const text = await readFile(journalPath, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").map((line) => (JSON.parse(line) as { event: string }).event);
}

describe("reservePrivateIssuance（二重一意性 FR-Z06）", () => {
  test("source_settled の private intent にだけ予約でき、intent と受信支払いの両方を消費する。eventId は source_settled から復元される", async () => {
    const { store } = await load();
    await settled(store, "pay-1", "0xq1");
    expect(store.byPaymentId("pay-1")?.source.eventId).toBe("0xnonce-auth");
    const identity = "x402|eip155:84532|0xtx-pay-1|0xnonce-auth";
    expect(await store.reservePrivateIssuance("pay-1", "0".repeat(64), identity)).toBe("unavailable"); // 別の intent の sha
    expect(await store.reservePrivateIssuance("pay-1", INTENT_SHA, identity)).toBe("reserved");
    expect(store.byPaymentId("pay-1")?.status).toBe("private_issuance_reserved");
    expect(store.byPaymentId("pay-1")?.private?.reservation).toEqual({ intentSha256: INTENT_SHA, inboundIdentity: identity });
    expect(store.hasIssuedIntent(INTENT_SHA)).toBe(true);
    expect(store.hasConsumedInbound(identity)).toBe(true);
    // 状態が進んだ後は予約できない
    expect(await store.reservePrivateIssuance("pay-1", INTENT_SHA, identity)).toBe("unavailable");
  });
  test("(a) 同じ intent・別の受信支払い → collision（同時要求も直列化される）", async () => {
    const { store } = await load();
    await settled(store, "pay-1", "0xq1", "0xa");
    await settled(store, "pay-2", "0xq2", "0xb");
    const [first, second] = await Promise.all([
      store.reservePrivateIssuance("pay-1", INTENT_SHA, "x402|eip155:84532|0xtx-pay-1|0xa"),
      store.reservePrivateIssuance("pay-2", INTENT_SHA, "x402|eip155:84532|0xtx-pay-2|0xb"),
    ]);
    expect([first, second].sort()).toEqual(["collision", "reserved"]);
    expect((await events()).filter((event) => event === "private_issuance_reserved")).toHaveLength(1);
  });
  test("(b) 別の正しい intent・同じ受信支払い → collision", async () => {
    const { store } = await load();
    await settled(store, "pay-1", "0xq1", "0xa", "A");
    await settled(store, "pay-2", "0xq2", "0xa", "B");
    expect(store.byPaymentId("pay-2")?.private?.intentSha256).toBe(INTENT_B_SHA);
    expect(await store.reservePrivateIssuance("pay-1", INTENT_SHA, "x402|eip155:84532|0xtx-shared|0xa")).toBe("reserved");
    expect(await store.reservePrivateIssuance("pay-2", INTENT_B_SHA, "x402|eip155:84532|0xtx-shared|0xa")).toBe("collision");
    expect(store.hasIssuedIntent(INTENT_B_SHA)).toBe(false);
    expect(store.byPaymentId("pay-2")?.status).toBe("source_settled");
  });
  test("(c) (a)(b) は再起動の後にも効く", async () => {
    {
      const { store } = await load();
      await settled(store, "pay-1", "0xq1", "0xa", "A");
      expect(await store.reservePrivateIssuance("pay-1", INTENT_SHA, "x402|eip155:84532|0xtx-1|0xa")).toBe("reserved");
    }
    while (opened.length > 0) await opened.pop()!.close();
    const { store } = await load();
    await settled(store, "pay-2", "0xq2", "0xb", "A");
    await settled(store, "pay-3", "0xq3", "0xc", "B");
    expect(await store.reservePrivateIssuance("pay-2", INTENT_SHA, "x402|eip155:84532|0xtx-2|0xb")).toBe("collision");
    expect(await store.reservePrivateIssuance("pay-3", INTENT_B_SHA, "x402|eip155:84532|0xtx-1|0xa")).toBe("collision");
    expect(await store.reservePrivateIssuance("pay-3", INTENT_B_SHA, "x402|eip155:84532|0xtx-3|0xc")).toBe("reserved");
  });
  test("(d) journal の fsync の失敗は unavailable: 集合に入らず、journal は以後の追記を拒む（自動再試行は無い）", async () => {
    const { store } = await load();
    await settled(store, "pay-1", "0xq1", "0xa");
    const probe = await openFile(path.join(workDir, "fsync-probe"), "a");
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const spy = vi.spyOn(proto, "sync").mockRejectedValueOnce(new Error("fsync failed"));
    try {
      expect(await store.reservePrivateIssuance("pay-1", INTENT_SHA, "x402|eip155:84532|0xtx-1|0xa")).toBe("unavailable");
    } finally {
      spy.mockRestore();
    }
    expect(store.hasIssuedIntent(INTENT_SHA)).toBe(false);
    expect(store.hasConsumedInbound("x402|eip155:84532|0xtx-1|0xa")).toBe(false);
    expect(store.byPaymentId("pay-1")?.status).toBe("source_settled");
    // 毒された writer: 以後の追記も拒む（店の側で黙って再試行しない）。
    await expect(store.append("pay-1", "unknown", { outcome: "unknown", reason: "x" })).rejects.toThrow();
  });
  test("予約は再起動をまたいで残り、形の壊れた予約の行は起動を止める", async () => {
    {
      const { store } = await load();
      await settled(store, "pay-1", "0xq1");
      expect(await store.reservePrivateIssuance("pay-1", INTENT_SHA, "x402|eip155:84532|0xtx-pay-1|0xnonce-auth")).toBe("reserved");
    }
    while (opened.length > 0) await opened.pop()!.close();
    const { store, journal } = await load();
    expect(store.hasIssuedIntent(INTENT_SHA)).toBe(true);
    expect(store.hasConsumedInbound("x402|eip155:84532|0xtx-pay-1|0xnonce-auth")).toBe(true);
    // 再起動で終端（interrupted_before_release）になる
    expect(store.byPaymentId("pay-1")?.status).toBe("unknown");
    expect(store.byPaymentId("pay-1")?.terminalReason).toBe("interrupted_before_release");
    expect(store.byPaymentId("pay-1")?.destination.outcome).toBe("unknown");
    await journal.append({ paymentId: "pay-9", event: "private_issuance_reserved", patch: { intentSha256: "nope", inboundIdentity: "" } });
    while (opened.length > 0) await opened.pop()!.close();
    await expect(load()).rejects.toThrow(/malformed private_issuance_reserved/);
  });
});

describe("private_* 行の reduce と再起動の帰結（§7.1）", () => {
  const releasePatch = { headerName: "PAYMENT-SIGNATURE", headerSha256: "a".repeat(64), expiresAtMs: 1_800_000_100_000, releaseB64: Buffer.from("{}").toString("base64"), sessionBy: 1_800_000_200_000 };
  const recordPatch = { recordSha256: "b".repeat(64), recordBytes: 5000, recordCompletedAtMs: 1_800_000_150_000, summary: { trust: "lab-fixture-ca", requestLine: "POST /select HTTP/1.1" }, attestBy: 1_800_000_750_000, recordAvailableUntil: 1_800_003_750_000 };

  test("予約 → release → handover → record → attest 成立で delivered_private、送信レグ paid、射影に値が無い", async () => {
    const { store } = await load();
    await settled(store, "pay-1", "0xq1");
    await store.reservePrivateIssuance("pay-1", INTENT_SHA, "id-1");
    await store.append("pay-1", "private_released", releasePatch);
    let intent = store.byPaymentId("pay-1")!;
    expect(intent.status).toBe("private_released");
    expect(toPublicStatus(intent.status)).toBe("paid");
    expect(intent.destination.outcome).toBe("unknown");
    expect(intent.private?.issuance).toEqual({ ...releasePatch });
    await store.append("pay-1", "private_handed_over", { handedOverAtMs: 1_800_000_010_000, verifierAddress: "127.0.0.1:40001" });
    intent = store.byPaymentId("pay-1")!;
    expect(intent.status).toBe("private_awaiting_session");
    expect(toPublicStatus(intent.status)).toBe("awaiting_session");
    await store.append("pay-1", "private_recorded", recordPatch);
    intent = store.byPaymentId("pay-1")!;
    expect(intent.status).toBe("private_recorded");
    expect(toPublicStatus(intent.status)).toBe("attesting");
    expect(intent.private?.record).toEqual({ sha256: "b".repeat(64), bytes: 5000, completedAtMs: 1_800_000_150_000, summary: recordPatch.summary, attestBy: recordPatch.attestBy, recordAvailableUntil: recordPatch.recordAvailableUntil });
    await store.append("pay-1", "private_attested", { bundleSha256: "c".repeat(64), txRef: "0xdst", receiptRef: "receipt-header", recordSha256: "b".repeat(64), proof: { delivery: true, requestBinding: true } });
    intent = store.byPaymentId("pay-1")!;
    expect(intent.status).toBe("delivered_private");
    expect(toPublicStatus(intent.status)).toBe("delivered_private");
    expect(intent.destination).toMatchObject({ outcome: "paid", txRef: "0xdst", receiptRef: "receipt-header" });
    expect(intent.private?.attest).toEqual({ bundleSha256: "c".repeat(64), result: "delivered_private" });
    const projection = privateProjectionOf(intent)!;
    expect(projection).toEqual({
      intentSha256: INTENT_SHA,
      headerSha256: "a".repeat(64),
      outbound: { issued: true },
      verifier: recordPatch.summary,
      proof: { delivery: true, requestBinding: true, onChainFinality: "not_checked" },
      deadlines: { credentialExpiresAt: releasePatch.expiresAtMs, sessionBy: releasePatch.sessionBy, attestBy: recordPatch.attestBy },
      artifacts: { record: "available", recordAvailableUntil: recordPatch.recordAvailableUntil },
      attest: { bundleSha256: "c".repeat(64), result: "delivered_private" },
    });
    expect(JSON.stringify(projection)).not.toContain(INTENT_BYTES.toString("base64").slice(0, 24));
    await store.append("pay-1", "private_record_expired", {});
    expect(privateProjectionOf(store.byPaymentId("pay-1")!)?.artifacts).toEqual({ record: "expired", recordAvailableUntil: recordPatch.recordAvailableUntil });
    // 終端なので再起動で変わらない
    while (opened.length > 0) await opened.pop()!.close();
    const reopened = await load();
    expect(reopened.store.byPaymentId("pay-1")?.status).toBe("delivered_private");
  });

  test("attest の失敗は unknown に attest の耐久結果を残し、遅い record は状態を変えずに取得の対象だけを足す", async () => {
    const { store } = await load();
    await settled(store, "pay-1", "0xq1");
    await store.reservePrivateIssuance("pay-1", INTENT_SHA, "id-1");
    await store.append("pay-1", "private_released", releasePatch);
    await store.append("pay-1", "private_handed_over", { handedOverAtMs: 1, verifierAddress: "127.0.0.1:1" });
    await store.append("pay-1", "private_recorded", recordPatch);
    await store.append("pay-1", "unknown", { outcome: "unknown", reason: "private_attest_invalid", attest: { bundleSha256: "d".repeat(64) } });
    const intent = store.byPaymentId("pay-1")!;
    expect(intent.status).toBe("unknown");
    expect(intent.terminalReason).toBe("private_attest_invalid");
    expect(intent.private?.attest).toEqual({ bundleSha256: "d".repeat(64), result: "unknown", reason: "private_attest_invalid" });

  });

  test("遅い record・回収の record は終端の状態を変えない", async () => {
    const { store } = await load();
    await settled(store, "pay-1", "0xq1");
    await store.reservePrivateIssuance("pay-1", INTENT_SHA, "id-1");
    await store.append("pay-1", "private_released", releasePatch);
    await store.append("pay-1", "private_handed_over", { handedOverAtMs: 1, verifierAddress: "127.0.0.1:1" });
    await store.append("pay-1", "unknown", { outcome: "unknown", reason: "private_session_timeout" });
    const { attestBy: _a, ...lateRecord } = recordPatch;
    await store.append("pay-1", "private_recorded", { ...lateRecord, late: true, recoveredAtRestart: true });
    const intent = store.byPaymentId("pay-1")!;
    expect(intent.status).toBe("unknown");
    expect(intent.private?.record).toMatchObject({ late: true, recoveredAtRestart: true, sha256: "b".repeat(64) });
    expect(intent.private?.record?.attestBy).toBeUndefined();
    expect(privateProjectionOf(intent)?.artifacts).toEqual({ record: "available", recordAvailableUntil: recordPatch.recordAvailableUntil, late: true });
    expect(privateProjectionOf(intent)?.deadlines).toEqual({ credentialExpiresAt: releasePatch.expiresAtMs, sessionBy: releasePatch.sessionBy });
  });

  test("再起動の帰結: released → interrupted_before_handover、awaiting_session / recorded → interrupted_after_release、settled（予約前）→ paid_undelivered", async () => {
    {
      const { store } = await load();
      await settled(store, "pay-a", "0xqa", "0xa");
      await settled(store, "pay-b", "0xqb", "0xb");
      await settled(store, "pay-c", "0xqc", "0xc");
      await settled(store, "pay-d", "0xqd", "0xd");
      for (const [id, identity] of [["pay-b", "id-b"], ["pay-c", "id-c"], ["pay-d", "id-d"]] as const) {
        // 同じ封筒（同じ sha）の購入が 3 件: 最初の 1 件だけが reserved（intent の一意性）。
        const result = await store.reservePrivateIssuance(id, INTENT_SHA, identity);
        if (id === "pay-b") expect(result).toBe("reserved");
        else expect(result).toBe("collision");
      }
      await store.append("pay-b", "private_released", releasePatch);
    }
    while (opened.length > 0) await opened.pop()!.close();
    const { store } = await load();
    expect(store.byPaymentId("pay-a")).toMatchObject({ status: "paid_undelivered", terminalReason: "interrupted_at_restart", destination: { outcome: "not_sent" } });
    expect(store.byPaymentId("pay-b")).toMatchObject({ status: "unknown", terminalReason: "interrupted_before_handover", destination: { outcome: "unknown" } });
    // collision の 2 件は source_settled のまま再起動 → 予約前なので paid_undelivered（発行は無い）
    expect(store.byPaymentId("pay-c")?.status).toBe("paid_undelivered");
    expect(store.byPaymentId("pay-d")?.status).toBe("paid_undelivered");
    const names = await events();
    expect(names.filter((event) => event === "unknown")).toHaveLength(1);
  });

  test("再起動の帰結: awaiting_session と recorded", async () => {
    {
      const { store } = await load();
      await settled(store, "pay-1", "0xq1");
      await store.reservePrivateIssuance("pay-1", INTENT_SHA, "id-1");
      await store.append("pay-1", "private_released", releasePatch);
      await store.append("pay-1", "private_handed_over", { handedOverAtMs: 1, verifierAddress: "127.0.0.1:1" });
    }
    while (opened.length > 0) await opened.pop()!.close();
    {
      const { store } = await load();
      expect(store.byPaymentId("pay-1")).toMatchObject({ status: "unknown", terminalReason: "interrupted_after_release" });
      expect(store.byPaymentId("pay-1")?.private?.issuance?.sessionBy).toBe(releasePatch.sessionBy);
    }
  });
});
