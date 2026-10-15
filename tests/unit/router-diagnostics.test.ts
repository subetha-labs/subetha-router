/**
 * Router の診断の配線（`docs/rejection-reasons-design.md` §2.3・§4.1・§8.2・§12.3・§12.6・D-12、要件 SR-R3・AC-R2・AC-R3、タスク R-2）。
 *
 * - §8.2 の 3 通り（sink 無し・記録する sink・投げる sink）と、壊れた fs の sink で、core の返り値・fake の rail が受けた要求・journal の bytes・
 *   動的の控え・stderr が deepEqual
 * - 記録する sink では、場面ごとに期待する core の段の行が出て、検査を通らない行が 0
 * - AC-R2: ファイルの sink が書けない・上限を超える・壊れた行がある → 結果と journal は (a) と同じ。再起動で journal から同じ status
 * - AC-R3: 昇格の前の動的の verify の失敗は journal・予算・昇格に何も書かず、記録は quoteHash・requestHash・promoted:false
 * - §12.3: push のたびに時計を期限の後まで進める sink でも結果は同じ（記録は期限の判定の前に push されない）
 * - §12.6: 交互に進む 2 つの購入、片方の throw、遅れて届く report の出来事がそれぞれの購入に付く。scope の外の出来事は記録しない（D-12）
 * - `composeRails` の包み: 元の report を先に同じ引数で呼ぶ（stderr は byte 一致）
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { loadRuntimeConfig } from "../../src/config.js";
import { composeRails, closeDiagnosticsWithin, diagnosticReportOf } from "../../src/main.js";
import { formatTransportEvent, TransportError, type TransportEvent } from "../../src/net/guarded-fetch.js";
import { withPurchaseDiagnostics } from "../../src/core/purchase-diagnostics.js";
import { NOOP_DIAGNOSTICS, quoteHashOf, requestHashOf, withDiagnosticScope, type DiagnosticsSink, type DiagRecord } from "../../src/shared/diagnostics.js";
import { createFileDiagnosticsSink } from "../../src/shared/diagnostics-file.js";
import { diagnosticsChildEnvOf, routerDiagnosticsPathOf, routerDiagnosticsSinkOf } from "../../tools/router-diagnostics.js";
import {
  FakeInbound,
  FakeOutbound,
  PRINCIPAL,
  PROFILE_ID,
  runScenario,
  SCENARIOS,
  START_CLOCK,
  STATIC_ROUTE,
  transportFailure,
  uuidOf,
  diagConfig,
  type CallRecord,
  type Scenario,
} from "../fixtures/diag-compare.js";
import { memoryDiagFs, recordingDiagnostics, throwingDiagnostics } from "../fixtures/diagnostics.js";
import { createRouterCore } from "../../src/core/orchestrator.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";

/** 記録を比べやすい形に（時刻・連番は除く）。 */
function summary(records: readonly DiagRecord[]): Array<Record<string, unknown>> {
  return records.map((r) => {
    const out: Record<string, unknown> = { stage: r.stage };
    for (const key of ["outcome", "code", "transport", "op", "promoted", "attempt"] as const) if (r[key] !== undefined) out[key] = r[key];
    return out;
  });
}

/** 場面ごとに期待する行（core の段と、fake の rail が報告した transport の出来事）。 */
const EXPECTED: Readonly<Record<string, Array<Record<string, unknown>>>> = {
  "static-delivered": [
    { stage: "source_verify", outcome: "valid", promoted: true },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "paid", promoted: true, attempt: 1 },
  ],
  "static-verify-invalid": [{ stage: "source_verify", outcome: "invalid", code: "verify_failed", promoted: true }],
  "static-verify-throws": [
    { stage: "transport_event", transport: "upstream_timeout", op: "facilitator_verify", promoted: true },
    { stage: "source_verify", outcome: "threw", code: "source_verify_unavailable", transport: "upstream_timeout", promoted: true },
  ],
  "static-settle-rejected": [
    { stage: "source_verify", outcome: "valid", promoted: true },
    { stage: "source_settle", outcome: "rejected", code: "source_rejected", promoted: true },
  ],
  "static-settle-unknown": [
    { stage: "source_verify", outcome: "valid", promoted: true },
    { stage: "source_settle", outcome: "unknown", code: "source_settle_unknown", promoted: true },
  ],
  "static-settle-throws": [
    { stage: "transport_event", transport: "connect_failed", op: "facilitator_settle", promoted: true },
    { stage: "source_verify", outcome: "valid", promoted: true },
    { stage: "source_settle", outcome: "threw", code: "source_settle_unknown", transport: "connect_failed", promoted: true },
  ],
  "static-dest-rejected": [
    { stage: "source_verify", outcome: "valid", promoted: true },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "rejected", code: "destination_rejected", promoted: true, attempt: 1 },
  ],
  "static-dest-unknown": [
    { stage: "source_verify", outcome: "valid", promoted: true },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "unknown", code: "destination_pay_unknown", promoted: true, attempt: 1 },
  ],
  "static-dest-not-sent": [
    { stage: "source_verify", outcome: "valid", promoted: true },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "not_sent", code: "destination_deadline", promoted: true, attempt: 1 },
  ],
  "static-dest-paid-no-data": [
    { stage: "source_verify", outcome: "valid", promoted: true },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "paid_no_data", code: "paid_data_unavailable", promoted: true, attempt: 1 },
  ],
  "static-dest-throws": [
    { stage: "transport_event", transport: "upstream_timeout", op: "pay", promoted: true, attempt: 1 },
    { stage: "source_verify", outcome: "valid", promoted: true },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "threw", code: "destination_pay_unknown", transport: "upstream_timeout", promoted: true, attempt: 1 },
  ],
  "static-dest-offer-changed": [
    { stage: "source_verify", outcome: "valid", promoted: true },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "not_sent", code: "quote_changed", promoted: true },
  ],
  "dynamic-delivered": [
    { stage: "source_verify", outcome: "valid", promoted: false },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "paid", promoted: true, attempt: 1 },
  ],
  "dynamic-verify-invalid": [{ stage: "source_verify", outcome: "invalid", code: "verify_failed", promoted: false }],
  "dynamic-verify-throws": [
    { stage: "transport_event", transport: "dns_failed", op: "facilitator_verify", promoted: false },
    { stage: "source_verify", outcome: "threw", code: "source_verify_unavailable", transport: "dns_failed", promoted: false },
  ],
  "dynamic-offer-changed": [{ stage: "dynamic_precheck", outcome: "awaiting", code: "offer_changed", promoted: false }],
  "dynamic-settle-rejected": [
    { stage: "source_verify", outcome: "valid", promoted: false },
    { stage: "source_settle", outcome: "rejected", code: "source_rejected", promoted: true },
  ],
  "dynamic-settle-throws": [
    { stage: "transport_event", transport: "aborted", op: "facilitator_settle", promoted: true },
    { stage: "source_verify", outcome: "valid", promoted: false },
    { stage: "source_settle", outcome: "threw", code: "source_settle_unknown", transport: "aborted", promoted: true },
  ],
  "dynamic-dest-rejected": [
    { stage: "source_verify", outcome: "valid", promoted: false },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "rejected", code: "destination_rejected", promoted: true, attempt: 1 },
  ],
  "dynamic-dest-unknown": [
    { stage: "source_verify", outcome: "valid", promoted: false },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "unknown", code: "destination_pay_unknown", promoted: true, attempt: 1 },
  ],
  "dynamic-dest-not-sent": [
    { stage: "source_verify", outcome: "valid", promoted: false },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "not_sent", code: "destination_offer_changed", promoted: true, attempt: 1 },
  ],
  "dynamic-dest-throws": [
    { stage: "transport_event", transport: "transport_failed", op: "pay", promoted: true, attempt: 1 },
    { stage: "source_verify", outcome: "valid", promoted: false },
    { stage: "source_settle", outcome: "settled", promoted: true },
    { stage: "dest_outcome", outcome: "threw", code: "destination_pay_unknown", transport: "transport_failed", promoted: true, attempt: 1 },
  ],
};

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});
function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "router-diag-"));
  tmpDirs.push(dir);
  return dir;
}

/** 書き込みが全部失敗する・永遠に止まる fs の sink（§8.2 の 4）。 */
function brokenFileSinks(): Array<[string, DiagnosticsSink]> {
  const failing = memoryDiagFs();
  failing.openError = Object.assign(new Error("EACCES (test)"), { code: "EACCES" });
  const hanging = memoryDiagFs();
  hanging.hang = true;
  return [
    ["書けない fs", createFileDiagnosticsSink({ path: "/diag/router.ndjson", component: "router", fs: failing.fs })],
    ["止まる fs", createFileDiagnosticsSink({ path: "/diag/router.ndjson", component: "router", fs: hanging.fs })],
  ];
}

describe("§8.2: sink の有無・壊れ方で結果・要求・journal・stderr が変わらない", () => {
  test.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", async (name, scenario) => {
    const none = await runScenario(scenario);
    const recording = recordingDiagnostics();
    const recorded = await runScenario(scenario, { sink: recording });
    const throwing = throwingDiagnostics();
    const thrown = await runScenario(scenario, { sink: throwing });
    const noop = await runScenario(scenario, { sink: NOOP_DIAGNOSTICS });
    expect(recorded).toEqual(none);
    expect(thrown).toEqual(none);
    expect(noop).toEqual(none);
    for (const [, sink] of brokenFileSinks()) expect(await runScenario(scenario, { sink })).toEqual(none);
    // 投げる sink は実際に呼ばれた（握られた）。
    expect(throwing.calls).toBe(EXPECTED[name]!.length);
    // 記録: 検査を通らない行は 0、期待する段の行、全部の行がこの購入に付く。
    expect(recording.rejected()).toBe(0);
    const records = recording.records();
    expect(summary(records)).toEqual(EXPECTED[name]);
    for (const record of records) {
      expect(record.component).toBe("router");
      expect(record.paymentId).toBe(none.paymentId);
      expect(record.quoteHash).toBe(quoteHashOf(none.quoteId!));
      expect(record.routeId).toBe(scenario.kind === "static" ? STATIC_ROUTE : PROFILE_ID);
      if (scenario.kind === "dynamic") expect(record.requestHash).toBe(requestHashOf(PRINCIPAL, `req-${name}`));
      else expect(record.requestHash).toBeUndefined();
      // 生の quoteId（動的では authorization の nonce と同じ値）・requestId はどの行にも無い。
      expect(JSON.stringify(record)).not.toContain(none.quoteId!.slice(2));
      expect(JSON.stringify(record)).not.toContain(`req-${name}`);
    }
    // core の段の行は経過時間を持つ（verify・settle・送信の呼び出しの行。手元の検査の行は持たない）。
    for (const record of records.filter((r) => r.stage !== "transport_event" && r.stage !== "dynamic_precheck" && !(r.stage === "dest_outcome" && r.code === "quote_changed"))) {
      expect(typeof record.elapsedMs).toBe("number");
    }
  });
});

describe("§12.3: 記録は期限の判定の前に push されない", () => {
  /** push のたびに時計を承認期限の後まで進める sink（push が期限の判定の前にあれば結果が変わる）。transport の出来事は adapter の中の既存の報告点なので進めない。 */
  test.each(SCENARIOS.filter((s) => !s.name.includes("throws")).map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    const none = await runScenario(scenario);
    let pushes = 0;
    const advanced = await runScenario(scenario, {
      sinkOf: (rails) => ({
        emit(capture) {
          if (capture.stage === "transport_event") return;
          pushes += 1;
          rails.clock.now += 10 * 60_000;
        },
      }),
      // push は購入の終わりなので、status の読み取り（控えの期限を見る）の前に時計を戻す。
      afterPurchase: (rails) => void (rails.clock.now = START_CLOCK),
    });
    expect(advanced).toEqual(none);
    expect(pushes).toBeGreaterThan(0);
  });
});

describe("AC-R2: ファイルの sink の失敗・上限・壊れた行で結果と journal が変わらない、再起動で同じ status", () => {
  const scenarios: Scenario[] = [
    { name: "acr2-static-verify-invalid", kind: "static", restart: true, arrange: (r) => void (r.inbound.verifyImpl = async () => ({ isValid: false })) },
    { name: "acr2-static-delivered", kind: "static", restart: true },
    { name: "acr2-dynamic-dest-unknown", kind: "dynamic", restart: true, arrange: (r) => void (r.outbound.payImpl = async () => ({ outcome: "unknown", reason: "destination_pay_unknown" })) },
  ];
  test.each(scenarios.map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    const none = await runScenario(scenario);
    expect(none.statusAfterRestart).toEqual(none.status);
    // 書けない path（親が普通のファイル → ENOTDIR）。
    const dir = tmpDir();
    writeFileSync(path.join(dir, "not-a-dir"), "x");
    const unwritable = createFileDiagnosticsSink({ path: path.join(dir, "not-a-dir", "diagnostics", "router.ndjson"), component: "router" });
    expect(await runScenario(scenario, { sink: unwritable })).toEqual(none);
    expect(await unwritable.flush({ timeoutMs: 2_000 })).toBe(true);
    expect(unwritable.counters().writeFailed).toBeGreaterThan(0);
    // 上限を超える（1 行 16 バイト・ファイル 64 バイト）。
    const oversizedPath = path.join(tmpDir(), "diagnostics", "router.ndjson");
    const oversized = createFileDiagnosticsSink({ path: oversizedPath, component: "router", limits: { maxLineBytes: 16, maxFileBytes: 64 } });
    expect(await runScenario(scenario, { sink: oversized })).toEqual(none);
    await oversized.flush({ timeoutMs: 2_000 });
    expect(oversized.counters().droppedLineTooLarge).toBeGreaterThan(0);
    // 壊れた行が先にある（読まないので影響しない。新しい行は後ろに足す）。
    const corruptPath = path.join(tmpDir(), "diagnostics", "router.ndjson");
    mkdirSync(path.dirname(corruptPath), { recursive: true, mode: 0o700 });
    writeFileSync(corruptPath, '{"v":1,"broken\n\u0000garbage\n', { mode: 0o600 });
    const corrupt = createFileDiagnosticsSink({ path: corruptPath, component: "router" });
    expect(await runScenario(scenario, { sink: corrupt })).toEqual(none);
    await corrupt.close({ timeoutMs: 2_000 });
    const lines = readFileSync(corruptPath, "utf8").split("\n").filter((l) => l !== "");
    expect(lines.slice(0, 2)).toEqual(['{"v":1,"broken', "\u0000garbage"]);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines.slice(2)) expect(JSON.parse(line).v).toBe(1);
  });
});

describe("AC-R3: 昇格の前の動的の verify の失敗", () => {
  test.each([
    ["isValid:false", (r: { inbound: FakeInbound }): void => void (r.inbound.verifyImpl = async () => ({ isValid: false })), "invalid", "verify_failed"],
    [
      "throw",
      (r: { inbound: FakeInbound }): void =>
        void (r.inbound.verifyImpl = async (): Promise<{ isValid: boolean }> => {
          throw new Error("facilitator https://secret.internal/ down");
        }),
      "threw",
      "source_verify_unavailable",
    ],
  ] as const)("%s: journal・予算・昇格に何も書かず、控えは attempt だけ、記録は quoteHash・requestHash・promoted:false", async (name, arrange, outcome, code) => {
    const recording = recordingDiagnostics();
    const scenario: Scenario = { name: `acr3-${name.replace(/[^a-z]/gi, "")}`, kind: "dynamic", arrange };
    const run = await runScenario(scenario, { sink: recording });
    expect(run.purchase).toEqual({ paymentId: run.paymentId, status: "awaiting_payment", code });
    // journal は空（昇格の `created` も予約も無い）。status は控えから（昇格していない）。
    expect(run.journal).toBe("");
    expect((run.status as { dynamic: { promoted: boolean } }).dynamic.promoted).toBe(false);
    // 控えは quote と attempt の 2 行だけ（予約・昇格の印は無い）。
    const kinds = run.ledger.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>).map((l) => l["kind"] ?? "attempt");
    expect(kinds).toEqual(["quote", "attempt"]);
    expect(run.ledger).not.toContain("promoted");
    // settle・送信は呼ばれない。
    expect(run.calls.map((c) => c.method)).toEqual(["readChallenge", "createOffer", "readChallenge", "verify"]);
    const records = recording.records().filter((r) => r.stage === "source_verify");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome, code, promoted: false, quoteHash: quoteHashOf(run.quoteId!), requestHash: requestHashOf(PRINCIPAL, `req-${scenario.name}`), paymentId: run.paymentId, routeId: PROFILE_ID });
    expect(JSON.stringify(recording.records())).not.toContain("secret.internal");
  });
});

describe("§12.6: 購入の scope の結びつけ", () => {
  test("2 つの購入を交互に進める・片方が throw・遅れて届く report: 出来事はそれぞれの購入に付き、scope の外の出来事は記録しない", async () => {
    const dir = tmpDir();
    const calls: CallRecord[] = [];
    const inbound = new FakeInbound(calls);
    const outbound = new FakeOutbound(calls);
    const recording = recordingDiagnostics();
    const stderr: string[] = [];
    const report = diagnosticReportOf((event) => stderr.push(formatTransportEvent(event)), recording);
    inbound.report = report;
    outbound.report = report;
    // 交差: 1 件目の verify は 2 件目の verify が報告するまで待つ。2 件目は throw。遅れた report は verify が返った後の timer から。
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const late: Array<Promise<void>> = [];
    let n = 0;
    inbound.verifyImpl = async ({ report: rep, context }) => {
      n += 1;
      const mine = n;
      if (mine === 1) {
        rep({ code: "upstream_timeout", operation: "facilitator_verify", policy: "p", routeId: context!.routeId });
        await firstGate;
        rep({ code: "connect_failed", operation: "facilitator_verify", policy: "p", routeId: context!.routeId });
        late.push(new Promise<void>((resolve) => setTimeout(() => (rep({ code: "aborted", operation: "rpc", policy: "p" }), resolve()), 20)));
        return { isValid: false };
      }
      rep({ code: "dns_failed", operation: "facilitator_verify", policy: "p", routeId: context!.routeId });
      releaseFirst();
      throw new TransportError("dns_failed", { operation: "facilitator_verify" });
    };
    let ids = 0;
    const core = await createRouterCore({ journalPath: path.join(dir, "journal.ndjson"), config: diagConfig(), inbound, outbound, now: () => START_CLOCK, nextPaymentId: () => uuidOf((ids += 1)), dynamic: { ledgerDir: path.join(dir, "dq") }, diagnostics: recording });
    try {
      // quote の段の transport の出来事（scope の外）は記録しない。
      outbound.readChallengeImpl = async () => {
        report({ code: "admission_refused", operation: "challenge", policy: "p" });
        return outbound.offers;
      };
      const q1 = await core.quote({ principalId: PRINCIPAL, requestId: "r1", routeId: STATIC_ROUTE });
      const q2 = await core.quote({ principalId: PRINCIPAL, requestId: "r2", routeId: STATIC_ROUTE });
      outbound.readChallengeImpl = undefined;
      if (!q1.ok || !q2.ok) throw new Error("quote failed");
      report({ code: "transport_failed", operation: "other", policy: "p" }); // 試験の top level（scope の外）
      const [o1, o2] = await Promise.all([
        core.purchase({ principalId: PRINCIPAL, requestId: "r1", quoteId: q1.quoteId, approval: q1.quoteId, credential: inbound.credentialFor(q1.source.offer) }),
        core.purchase({ principalId: PRINCIPAL, requestId: "r2", quoteId: q2.quoteId, approval: q2.quoteId, credential: inbound.credentialFor(q2.source.offer) }),
      ]);
      await Promise.all(late);
      expect(o1).toEqual({ paymentId: q1.paymentId, status: "awaiting_payment", code: "verify_failed" });
      expect(o2).toEqual({ paymentId: q2.paymentId, status: "unknown", terminalReason: "source_verify_unavailable" });
      const records = recording.records();
      expect(recording.rejected()).toBe(0);
      const byPayment = (id: string): Array<Record<string, unknown>> => summary(records.filter((r) => r.paymentId === id)).map(({ promoted: _p, ...rest }) => rest);
      expect(byPayment(q1.paymentId)).toEqual([
        { stage: "transport_event", transport: "upstream_timeout", op: "facilitator_verify" },
        { stage: "transport_event", transport: "connect_failed", op: "facilitator_verify" },
        { stage: "source_verify", outcome: "invalid", code: "verify_failed" },
        // 購入の応答の後に届いた出来事も、その購入に付く（AsyncLocalStorage が timer に伝わる）。
        { stage: "transport_event", transport: "aborted", op: "rpc" },
      ]);
      expect(byPayment(q2.paymentId)).toEqual([
        { stage: "transport_event", transport: "dns_failed", op: "facilitator_verify" },
        { stage: "source_verify", outcome: "threw", code: "source_verify_unavailable", transport: "dns_failed" },
      ]);
      // 交差したこと（1 件目の 2 つの出来事の間に 2 件目の出来事）。
      const order = records.map((r) => `${r.paymentId === q1.paymentId ? 1 : 2}:${r.transport ?? r.stage}`);
      expect(order.indexOf("2:dns_failed")).toBeLessThan(order.indexOf("1:connect_failed"));
      // scope の外の出来事（quote の段・top level）は 1 行も無い。stderr には全部出ている（今までどおり）。
      expect(records).toHaveLength(6);
      expect(records.every((r) => r.paymentId !== undefined)).toBe(true);
      expect(stderr.filter((l) => l.includes("admission_refused"))).toHaveLength(2);
      expect(stderr.filter((l) => l.includes("transport_failed"))).toHaveLength(1);
      expect(stderr).toHaveLength(2 + 1 + 4);
    } finally {
      await core.close();
    }
  });

  test("購入の scope: body が throw しても控えた記録は push され、例外はそのまま投げ直す", async () => {
    const recording = recordingDiagnostics();
    const failure = new Error("boom");
    await expect(
      withPurchaseDiagnostics(recording, { paymentId: uuidOf(9), quoteId: "0xabc", routeId: STATIC_ROUTE }, async (diag) => {
        diag.note(() => ({ stage: "source_verify", outcome: "valid" }));
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(summary(recording.records())).toEqual([{ stage: "source_verify", outcome: "valid" }]);
    expect(recording.records()[0]).toMatchObject({ paymentId: uuidOf(9), quoteHash: quoteHashOf("0xabc") });
  });

  test("sink が無効なら scope を作らない（transport の出来事は scope の外のまま）", async () => {
    let seen = "unset";
    await withPurchaseDiagnostics(undefined, { paymentId: uuidOf(1) }, async () => {
      const recording = recordingDiagnostics();
      diagnosticReportOf(() => {}, recording)({ code: "aborted", operation: "rpc", policy: "p" });
      seen = String(recording.entries.length);
    });
    expect(seen).toBe("0");
  });
});

describe("transport の report の包み（composeRails、§2.3 の 2・D-12）", () => {
  let LOOPBACK_CLOSED = "";
  beforeAll(async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    LOOPBACK_CLOSED = `http://127.0.0.1:${port}`;
  });

  function syntheticConfig() {
    const dir = tmpDir();
    const route = {
      routeId: "r-x402",
      canonicalPath: "/v1/routes/r-x402/resource",
      rail: "x402",
      source: { amount: "1500", asset: "0x0000000000000000000000000000000000005ce7", decimals: 6, network: "eip155:11155111" },
      destination: { scheme: "exact", network: "eip155:84532", asset: "0x000000000000000000000000000000000000de57", payTo: "0x0000000000000000000000000000000000000a11" },
    };
    const file = path.join(dir, "router.config.json");
    writeFileSync(
      file,
      JSON.stringify({
        router: { approvalTtlMs: 60_000, routes: { "r-x402": route }, budget: { maxPurchases: 8, buckets: [{ network: "eip155:11155111", asset: route.source.asset, maxTotal: "100000", maxPerPurchase: "5000" }, { network: "eip155:84532", asset: route.destination.asset, maxTotal: "100000", maxPerPurchase: "5000" }] } },
        synthetic: { facilitatorUrl: LOOPBACK_CLOSED, upstreams: { "r-x402": `${LOOPBACK_CLOSED}/v1/eth/snapshot` } },
      }),
    );
    return loadRuntimeConfig({ ROUTER_CONFIG_PATH: file, ROUTER_PRINCIPAL_TOKENS: "a:b", ROUTER_ADAPTER_MODE: "synthetic", ROUTER_SUBETHA_FACILITATOR_URL: LOOPBACK_CLOSED, ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson") }, (f) => readFileSync(f, "utf8"), { networks: TEST_NETWORKS });
  }

  async function failures(diagnostics: DiagnosticsSink | undefined): Promise<{ events: TransportEvent[]; codes: string[] }> {
    const events: TransportEvent[] = [];
    const rails = composeRails(syntheticConfig(), diagnostics === undefined ? {} : { diagnostics }, (event) => events.push(event), () => {});
    const codes: string[] = [];
    const attempt = async (run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
        codes.push("ok");
      } catch (error) {
        codes.push(error instanceof TransportError ? error.code : "other");
      }
    };
    // scope の外（quote の段）と、購入の scope の中。
    await attempt(() => rails.outbound.readChallenge("r-x402"));
    await withDiagnosticScope({ paymentId: uuidOf(5), quoteId: "0x01", routeId: "r-x402", attempt: 2 }, () => attempt(() => rails.outbound.readChallenge("r-x402")));
    return { events, codes };
  }

  test("元の report は同じ引数で同じ回数（stderr は byte 一致）。記録は scope の中の出来事だけ", async () => {
    const plain = await failures(undefined);
    const recording = recordingDiagnostics();
    const recorded = await failures(recording);
    const thrown = await failures(throwingDiagnostics());
    expect(recorded).toEqual(plain);
    expect(thrown).toEqual(plain);
    expect(plain.codes).toEqual(["connect_failed", "connect_failed"]);
    expect(plain.events.map(formatTransportEvent)).toEqual(recorded.events.map(formatTransportEvent));
    const records = recording.records();
    expect(recording.rejected()).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ component: "router", stage: "transport_event", transport: "connect_failed", op: "challenge", paymentId: uuidOf(5), attempt: 2, quoteHash: quoteHashOf("0x01"), routeId: "r-x402" });
  });

  test("sink が無い・NOOP なら元の関数そのもの。元の report が投げれば同じ例外（記録しない）", () => {
    const original = (_event: TransportEvent): void => {};
    expect(diagnosticReportOf(original, undefined)).toBe(original);
    expect(diagnosticReportOf(original, NOOP_DIAGNOSTICS)).toBe(original);
    const recording = recordingDiagnostics();
    const failure = new Error("stderr closed");
    const wrapped = diagnosticReportOf(() => {
      throw failure;
    }, recording);
    expect(() => wrapped({ code: "aborted", operation: "rpc", policy: "p" })).toThrow(failure);
    expect(recording.entries).toHaveLength(0);
  });
});

describe("process の配線（tools/router-diagnostics.ts・tools/remote-router-process.ts・src/main.ts の停止）", () => {
  test("子の env と sink: journal の隣、off なら足さない、env が無ければ sink を作らない", () => {
    expect(routerDiagnosticsPathOf("/app/runtime/journal.ndjson")).toBe("/app/runtime/diagnostics/router.ndjson");
    expect(routerDiagnosticsPathOf("/app/runtime/acceptance/journal.ndjson")).toBe("/app/runtime/acceptance/diagnostics/router.ndjson");
    expect(diagnosticsChildEnvOf("/app/runtime/journal.ndjson", {})).toEqual({ SUBETHA_DIAGNOSTICS_PATH: "/app/runtime/diagnostics/router.ndjson" });
    expect(diagnosticsChildEnvOf("/app/runtime/journal.ndjson", { SUBETHA_DIAGNOSTICS: "off" })).toEqual({});
    expect(routerDiagnosticsSinkOf({})).toBeUndefined();
    expect(routerDiagnosticsSinkOf({ SUBETHA_DIAGNOSTICS_PATH: "" })).toBeUndefined();
    expect(typeof routerDiagnosticsSinkOf({ SUBETHA_DIAGNOSTICS_PATH: "/nonexistent/x.ndjson" })?.emit).toBe("function");
  });

  test("本番の Router の子は env から sink を作って startRouter に渡す（routerProcessCapabilitiesOf は純粋なまま）", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../../tools/remote-router-process.ts"), "utf8");
    expect(source).toMatch(/const diagnostics = routerDiagnosticsSinkOf\(process\.env\);/);
    expect(source).toMatch(/startRouter\(diagnostics === undefined \? capabilities : \{ \.\.\.capabilities, diagnostics \}\)/);
    expect(readFileSync(path.resolve(import.meta.dirname, "../../tools/rails-entry.ts"), "utf8")).not.toMatch(/diagnostics/i);
  });

  test("停止の書き出しは上限つき: 止まる fs でも上限で戻り、close の無い sink・投げる close でも reject しない", async () => {
    const hanging = memoryDiagFs();
    hanging.hang = true;
    const sink = createFileDiagnosticsSink({ path: "/d/router.ndjson", component: "router", fs: hanging.fs });
    sink.emit({ stage: "source_verify", outcome: "valid" });
    const started = performance.now();
    await closeDiagnosticsWithin(sink, 200);
    expect(performance.now() - started).toBeLessThan(1_000);
    await expect(closeDiagnosticsWithin(undefined)).resolves.toBeUndefined();
    await expect(closeDiagnosticsWithin({ emit() {} })).resolves.toBeUndefined();
    await expect(closeDiagnosticsWithin({ emit() {}, close: async () => Promise.reject(new Error("x")) }, 50)).resolves.toBeUndefined();
  });

  test("書けるファイルの sink: 0700 のディレクトリと 0600 のファイル（停止の close で書き出す）", async () => {
    const file = path.join(tmpDir(), "runtime", "diagnostics", "router.ndjson");
    const sink = routerDiagnosticsSinkOf({ SUBETHA_DIAGNOSTICS_PATH: file })!;
    await withDiagnosticScope({ paymentId: uuidOf(3), quoteId: "0x02" }, async () => sink.emit({ stage: "source_verify", outcome: "invalid", code: "verify_failed" }));
    await closeDiagnosticsWithin(sink, 2_000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ component: "router", stage: "source_verify", paymentId: uuidOf(3), quoteHash: quoteHashOf("0x02"), code: "verify_failed" });
    expect(lines.at(-1)).toMatchObject({ component: "sink", stage: "counters" });
  });
});

/**
 * Codex R-2 #1: 診断は adapter の返した object を **読み足さない**。読む回数・順序・値は変更前（main）の判断の経路と同じで、診断はその経路が読んだ local だけを使う。
 * 3 通りの比較はどれも変更後の core なので、ここでは main の意味（どの読み取りの値が journal と応答に入るか）を直に書いて照らす。
 * adapter の結果は Proxy: 予定した欄は読むたびに次の値を返し、main の回数を超えて読めば throw する。全部の読み取りを記録する。
 */
function scripted(target: Record<string, unknown>, plan: Readonly<Record<string, readonly unknown[]>>, log: string[], onRead?: (key: string, n: number) => void): Record<string, unknown> {
  const counts = new Map<string, number>();
  return new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key !== "string") return Reflect.get(obj, key, receiver);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      log.push(key);
      onRead?.(key, n);
      const values = plan[key];
      if (values === undefined) return Reflect.get(obj, key, receiver);
      if (n > values.length) throw new Error(`read #${n} of ${key} is beyond main's reads`);
      return values[n - 1];
    },
  });
}
const readsOf = (log: readonly string[], key: string): number => log.filter((k) => k === key).length;
const journalEventsOf = (journal: string): Array<{ event: string; patch: Record<string, unknown> }> =>
  journal.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { event: string; patch: Record<string, unknown> });
const SINKS: Array<[string, () => DiagnosticsSink | undefined]> = [
  ["sink 無し", () => undefined],
  ["記録する sink", () => recordingDiagnostics()],
  ["投げる sink", () => throwingDiagnostics()],
];

describe("Codex R-2 #1: adapter の結果を診断のために読み足さない（main の読み取りの意味のまま）", () => {
  test.each(SINKS)("静的の settle の rejected（状態つきの getter・3 回目で throw）: journal は 1 回目、応答の code は 2 回目の値（%s）", async (_name, sinkOf) => {
    const log: string[] = [];
    const sink = sinkOf();
    const run = await runScenario(
      { name: "r1-settle-getter", kind: "static", arrange: (r) => void (r.inbound.settleImpl = async () => scripted({}, { outcome: ["rejected"], reason: ["verify_failed", "source_rejected"] }, log) as never) },
      { ...(sink === undefined ? {} : { sink }) },
    );
    // main: outcome を 1 回、reason を 2 回（journal の引数・応答の code）。
    expect(readsOf(log, "outcome")).toBe(1);
    expect(readsOf(log, "reason")).toBe(2);
    expect(run.purchase).toEqual({ paymentId: run.paymentId, status: "awaiting_payment", code: "source_rejected" });
    expect(journalEventsOf(run.journal).at(-1)).toMatchObject({ event: "source_failed", patch: { outcome: "rejected", reason: "verify_failed" } });
    if (sink !== undefined && "records" in sink) {
      expect((sink as ReturnType<typeof recordingDiagnostics>).records().find((r) => r.stage === "source_settle")).toMatchObject({ outcome: "rejected", code: "source_rejected" });
    }
  });

  test.each(SINKS)("静的の settle の rejected（journal の await の間に adapter が値を書き換える）: 応答は await の後の 2 回目の読み取り（%s）", async (_name, sinkOf) => {
    const log: string[] = [];
    const sink = sinkOf();
    const values: string[] = [];
    const run = await runScenario(
      {
        name: "r1-settle-mutation",
        kind: "static",
        arrange: (r) =>
          void (r.inbound.settleImpl = async () => {
            const target: Record<string, unknown> = { outcome: "rejected", reason: "verify_failed" };
            return new Proxy(target, {
              get(obj, key) {
                if (typeof key === "string") log.push(key);
                const value = Reflect.get(obj, key);
                if (key === "reason") {
                  values.push(String(value));
                  // 1 回目（journal の引数）の後、journal の書き込み（fsync）を待つ間に書き換える。
                  if (values.length === 1) setImmediate(() => (target["reason"] = "source_rejected"));
                }
                return value;
              },
            }) as never;
          }),
      },
      { ...(sink === undefined ? {} : { sink }) },
    );
    expect(values).toEqual(["verify_failed", "source_rejected"]);
    expect(readsOf(log, "reason")).toBe(2);
    expect(run.purchase).toMatchObject({ status: "awaiting_payment", code: "source_rejected" });
    expect(journalEventsOf(run.journal).at(-1)).toMatchObject({ event: "source_failed", patch: { reason: "verify_failed" } });
  });

  test.each(SINKS)("宛先の rejected（outcome の getter: switch は rejected、journal は not_sent、3 回目で throw）: dest_failed の後に reject しない（%s）", async (_name, sinkOf) => {
    const log: string[] = [];
    const sink = sinkOf();
    const run = await runScenario(
      { name: "r1-dest-getter", kind: "static", arrange: (r) => void (r.outbound.payImpl = async () => scripted({}, { outcome: ["rejected", "not_sent"], reason: ["destination_offer_changed"] }, log) as never) },
      { ...(sink === undefined ? {} : { sink }) },
    );
    // main: receiptRef を 1 回、outcome を 2 回（switch・journal の引数）、reason を 1 回。
    expect(readsOf(log, "outcome")).toBe(2);
    expect(readsOf(log, "reason")).toBe(1);
    expect(readsOf(log, "receiptRef")).toBe(1);
    expect(run.purchase).toEqual({ paymentId: run.paymentId, status: "paid_data_unavailable", terminalReason: "destination_offer_changed" });
    expect(journalEventsOf(run.journal).at(-1)).toMatchObject({ event: "dest_failed", patch: { outcome: "not_sent", reason: "destination_offer_changed" } });
    if (sink !== undefined && "records" in sink) {
      // 診断の outcome は journal に書いた値（読み直した値ではない）。
      expect((sink as ReturnType<typeof recordingDiagnostics>).records().find((r) => r.stage === "dest_outcome")).toMatchObject({ outcome: "not_sent", code: "destination_offer_changed", attempt: 1 });
    }
  });

  test.each(SINKS)("宛先の rejected（journal の await の間に outcome を書き換える）: 読み取りは 2 回のまま、記録は journal の値（%s）", async (_name, sinkOf) => {
    const log: string[] = [];
    const sink = sinkOf();
    const run = await runScenario(
      {
        name: "r1-dest-mutation",
        kind: "static",
        arrange: (r) =>
          void (r.outbound.payImpl = async () => {
            const target: Record<string, unknown> = { outcome: "rejected", reason: "destination_rejected" };
            return scripted(target, {}, log, (key, n) => {
              if (key === "outcome" && n === 2) setImmediate(() => (target["outcome"] = "paid"));
            }) as never;
          }),
      },
      { ...(sink === undefined ? {} : { sink }) },
    );
    expect(readsOf(log, "outcome")).toBe(2);
    expect(run.purchase).toEqual({ paymentId: run.paymentId, status: "paid_data_unavailable", terminalReason: "destination_rejected" });
    expect(journalEventsOf(run.journal).at(-1)).toMatchObject({ event: "dest_failed", patch: { outcome: "rejected", reason: "destination_rejected" } });
    if (sink !== undefined && "records" in sink) {
      expect((sink as ReturnType<typeof recordingDiagnostics>).records().find((r) => r.stage === "dest_outcome")).toMatchObject({ outcome: "rejected" });
    }
  });

  test.each(SINKS)("動的の settle の rejected（状態つきの getter）: reason は 1 回だけ読む（%s）", async (_name, sinkOf) => {
    const log: string[] = [];
    const sink = sinkOf();
    const run = await runScenario(
      { name: "r1-dyn-settle-getter", kind: "dynamic", arrange: (r) => void (r.inbound.settleImpl = async () => scripted({}, { outcome: ["rejected"], reason: ["verify_failed"] }, log) as never) },
      { ...(sink === undefined ? {} : { sink }) },
    );
    // main: outcome 1 回・txRef 1 回・reason 1 回。昇格の後の rejected は unknown（理由は safeSettleReason の値）。
    expect(readsOf(log, "outcome")).toBe(1);
    expect(readsOf(log, "reason")).toBe(1);
    expect(run.purchase).toEqual({ paymentId: run.paymentId, status: "unknown", terminalReason: "verify_failed" });
  });
});

describe("Codex R-2 #2: 昇格の後の送信は promoted:true の scope", () => {
  test("昇格の前に始まった動的の購入: 送信の前の読み直しの失敗・遅れて届く callback は promoted:true、昇格の前の読み直しは promoted:false", async () => {
    const recording = recordingDiagnostics();
    const late: Array<Promise<void>> = [];
    const run = await runScenario(
      {
        name: "r2-dyn-deliver-read",
        kind: "dynamic",
        arrange: (r) =>
          void (r.outbound.readChallengeImpl = async (n) => {
            // 1: quote、2: purchase の照合（昇格の前）、3: 送信の前の読み直し（昇格の後）。
            if (n === 2) r.outbound.report({ code: "upstream_timeout", operation: "read_challenge", policy: "p" });
            if (n >= 3) {
              late.push(new Promise<void>((resolve) => setTimeout(() => (r.outbound.report({ code: "aborted", operation: "read_challenge", policy: "p" }), resolve()), 20)));
              throw transportFailure(r.outbound.report, "connect_failed", "read_challenge");
            }
            return r.outbound.offers;
          }),
      },
      { sink: recording },
    );
    await Promise.all(late);
    expect(run.purchase).toEqual({ paymentId: run.paymentId, status: "paid_data_unavailable", terminalReason: "offer_unavailable" });
    expect(recording.rejected()).toBe(0);
    const events = recording.records().filter((r) => r.stage === "transport_event").map((r) => ({ transport: r.transport, promoted: r.promoted, paymentId: r.paymentId }));
    expect(events).toEqual([
      { transport: "upstream_timeout", promoted: false, paymentId: run.paymentId },
      { transport: "connect_failed", promoted: true, paymentId: run.paymentId },
      { transport: "aborted", promoted: true, paymentId: run.paymentId },
    ]);
    expect(summary(recording.records().filter((r) => r.stage === "dest_outcome"))).toEqual([{ stage: "dest_outcome", outcome: "not_sent", code: "offer_unavailable", promoted: true }]);
  });
});

describe("Codex R-2 #3: 停止の close の accessor が投げても reject しない", () => {
  test("close の getter が投げる・同期に投げる・receiver を保つ", async () => {
    const accessor = { emit() {} } as Record<string, unknown>;
    Object.defineProperty(accessor, "close", {
      get() {
        throw new Error("accessor (test)");
      },
    });
    await expect(closeDiagnosticsWithin(accessor as never, 50)).resolves.toBeUndefined();
    await expect(
      closeDiagnosticsWithin(
        {
          emit() {},
          close: () => {
            throw new Error("sync (test)");
          },
        },
        50,
      ),
    ).resolves.toBeUndefined();
    let receiver: unknown;
    const sink = {
      emit() {},
      close(this: unknown) {
        receiver = this;
        return Promise.resolve();
      },
    };
    await closeDiagnosticsWithin(sink, 50);
    expect(receiver).toBe(sink);
  });
});
