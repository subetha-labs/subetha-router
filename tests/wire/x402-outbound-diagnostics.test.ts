/**
 * 送信の adapter の診断（設計 `docs/rejection-reasons-design.md` §4.3・§8.2、§12.2 が優先。タスク R-4）の wire の確かめ。
 *
 * 実 TCP / TLS（loopback の fixture。TCP の行き先だけを fixture に向ける）。署名は乱数の鍵・seed で本当に行う。資金は動かない。
 * - 動的 EVM: 本番と同じ guarded transport と動的の門（`admit`）で、(a) sink 無し・(b) 記録する sink・(c) 投げる sink の結果・門の枠の取得と返却の
 *   回数と順・返却の遅れ・上流が受けた要求の数・断った本文の送られた量が同じ（§8.2。本文は新しく読まない: §12.2）
 * - SVM: 共有の `paidOutcomeOf` の記録（`cid` は書かない）と、challenge の読み直しの失敗（静的は `challenge_invalid`、動的は固定の理由）
 */
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { createX402Outbound } from "../../src/adapters/outbound/x402.js";
import type { DynamicProfile } from "../../src/config.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../../src/net/bounded-body.js";
import { createGuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, PayResult } from "../../src/ports/outbound.js";
import type { DiagnosticsSink, DiagRecord } from "../../src/shared/diagnostics.js";
import { recordingDiagnostics, throwingDiagnostics } from "../fixtures/diagnostics.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { FIXTURE_ASSET, FIXTURE_NETWORK, FIXTURE_TX, startX402Upstream, type PayResponse, type X402Upstream } from "../fixtures/dynamic/x402-upstream.js";
import { harness as svmHarnessIn, requestOf, ROUTE, PROFILE_ID as SVM_PROFILE_ID, URL_A as SVM_URL_A, type Harness as SvmHarness } from "../fixtures/svm-outbound-harness.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const PROFILE_ID = "dyn-mpp-to-x402";
const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "mpp",
  source: { network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" },
  rail: "x402",
  destination: { scheme: "exact", network: FIXTURE_NETWORK, asset: FIXTURE_ASSET, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "0", bps: 0, min: "0" },
};
const URL_A = "https://provider.test/v1/price?symbol=ETH";
const MIB = 1024 * 1024;
const FIXED_KEY = `0x${"5c".repeat(32)}` as const;
const encodeRequired = async (error: string): Promise<string> => (await import("@x402/core/http")).encodePaymentRequiredHeader({ x402Version: 2, resource: { url: URL_A }, accepts: [], error } as never);

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => TLS.cleanup());

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!().catch(() => {});
});

const view = (records: readonly DiagRecord[]): Array<Record<string, unknown>> =>
  records.map((r) => {
    const out: Record<string, unknown> = { stage: r.stage };
    for (const key of ["outcome", "code", "transport", "httpStatus", "receipt", "receiptHeader", "reasonSource", "reason"] as const) if (r[key] !== undefined) out[key] = r[key];
    if (r.cid !== undefined) out["cid"] = "cid";
    return out;
  });

interface GateLog {
  readonly events: string[];
  admitted: number;
  released: number;
  lastReleaseAt: number;
}

async function dynamicHarness(sink: DiagnosticsSink | undefined) {
  const upstream: X402Upstream = await startX402Upstream(TLS);
  closers.push(upstream.close);
  // 3 通りで結果の bytes（領収の payer）を揃えるため、決まった試験用の鍵（資金は無い）。
  const account = privateKeyToAccount(FIXED_KEY);
  const gate: GateLog = { events: [], admitted: 0, released: 0, lastReleaseAt: 0 };
  const transport = createGuardedTransport({
    allowLoopback: false,
    report: () => {},
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: publicLookup(),
    dialForTest: dialTo({ "provider.test": upstream.port }),
    maxHeaderSize: DYNAMIC_RESPONSE_LIMITS.maxHeaderBytes,
    dns: { timeoutMs: 2_000, maxInFlight: 16 },
    admit: (_addresses, context) => {
      gate.admitted += 1;
      gate.events.push(`admit:${context.operation}`);
      return {
        release: () => {
          gate.released += 1;
          gate.lastReleaseAt = performance.now();
          gate.events.push(`release:${context.operation}`);
        },
      };
    },
  });
  const rail = createX402Outbound({
    upstreams: {},
    transport: createGuardedTransport({ allowLoopback: true, report: () => {} }),
    capability: { network: FIXTURE_NETWORK, kind: "real-key", signer: { address: account.address, signTypedData: (message: never) => account.signTypedData(message) } },
    dynamic: { profiles: { [PROFILE_ID]: PROFILE }, transport },
    ...(sink === undefined ? {} : { diagnostics: sink }),
  });
  return { upstream, rail, address: account.address, gate };
}

interface DynamicRun {
  readonly result: PayResult;
  readonly gateEvents: readonly string[];
  readonly admitted: number;
  readonly released: number;
  readonly releaseLagMs: number;
  readonly challenges: number;
  readonly payments: number;
  readonly urls: readonly string[];
  readonly streams: ReadonlyArray<{ completed: boolean; small: boolean }>;
}

async function runDynamic(sink: DiagnosticsSink | undefined, respond: (payer: string) => PayResponse): Promise<DynamicRun> {
  const h = await dynamicHarness(sink);
  const offer = (await h.rail.readChallenge(PROFILE_ID, { url: URL_A, method: "GET" }))[0] as DestinationOffer;
  h.upstream.state.pay = () => respond(h.address);
  const result = await h.rail.pay({ routeId: PROFILE_ID, offer, paymentId: "00000000-0000-4000-8000-000000000001", attempt: 1, deadlineMs: Date.now() + 600_000, target: { url: URL_A, method: "GET" } });
  const returnedAt = performance.now();
  // 枠の返却は応答の終わり（読み切る・中断する）の後。少し待ってから数える。
  await new Promise((resolve) => setTimeout(resolve, 150));
  return {
    result,
    gateEvents: [...h.gate.events],
    admitted: h.gate.admitted,
    released: h.gate.released,
    releaseLagMs: Math.max(0, h.gate.lastReleaseAt - returnedAt),
    challenges: h.upstream.seen.challenges,
    payments: h.upstream.seen.payments.length,
    urls: [...h.upstream.seen.urls],
    streams: h.upstream.seen.streams.map((s) => ({ completed: s.completed, small: s.written < 4 * MIB })),
  };
}

describe("動的 EVM（本番の guarded transport と門）: §8.2 の 3 通り", () => {
  const receiptOk = (payer: string) => ({ success: true, network: FIXTURE_NETWORK, transaction: FIXTURE_TX, payer });
  const scenarios: ReadonlyArray<readonly [string, (required: string) => (payer: string) => PayResponse, Array<Record<string, unknown>>]> = [
    [
      "402 + PAYMENT-REQUIRED.error、断った本文は 20 MiB を流す（読まない）",
      (required) => () => ({ status: 402, body: "", headers: { "PAYMENT-REQUIRED": required }, streamBytes: 20 * MIB }),
      [
        { stage: "dest_sign", outcome: "signed", cid: "cid" },
        { stage: "dest_pay_request", httpStatus: 402, receipt: "absent", receiptHeader: "none", reasonSource: "payment_required_header", reason: "invalid_exact_evm_insufficient_balance", cid: "cid" },
      ],
    ],
    [
      "500 の本文を 20 MiB 流す（読まない）",
      () => () => ({ status: 500, body: "", streamBytes: 20 * MIB }),
      [
        { stage: "dest_sign", outcome: "signed", cid: "cid" },
        { stage: "dest_pay_request", httpStatus: 500, receipt: "absent", receiptHeader: "none", cid: "cid" },
      ],
    ],
    [
      "整合した領収の 200（本文を読む）",
      () => (payer) => ({ status: 200, body: JSON.stringify({ price: 1 }), contentType: "application/json", receipt: receiptOk(payer) }),
      [
        { stage: "dest_sign", outcome: "signed", cid: "cid" },
        { stage: "dest_pay_request", httpStatus: 200, receipt: "ok", receiptHeader: "payment-response", cid: "cid" },
      ],
    ],
    [
      "応答のヘッダが上限を超える（transport の失敗、結果は unknown）",
      () => (payer) => ({ status: 200, body: "{}", receipt: receiptOk(payer), headers: { "x-pad": "a".repeat(40_000) } }),
      [
        { stage: "dest_sign", outcome: "signed", cid: "cid" },
        { stage: "dest_pay_request", transport: "transport_failed", cid: "cid" },
      ],
    ],
  ];

  test.each(scenarios)("%s", async (_name, respondOf, expected) => {
    const required = await encodeRequired("invalid_exact_evm_insufficient_balance");
    const respond = respondOf(required);
    const a = await runDynamic(undefined, respond);
    const recorder = recordingDiagnostics();
    const b = await runDynamic(recorder, respond);
    const thrower = throwingDiagnostics();
    const c = await runDynamic(thrower, respond);
    const comparable = (run: DynamicRun) => ({ ...run, releaseLagMs: undefined });
    expect(comparable(b)).toEqual(comparable(a));
    expect(comparable(c)).toEqual(comparable(a));
    // 門の枠: 取得と返却が同じ回数・同じ順（quote の読み・送金の前の読み・有料の要求の 3 回）、どれも返した。返却は返り値の後 100 ms 以内。
    expect(a.admitted).toBe(3);
    expect(a.released).toBe(a.admitted);
    for (const run of [a, b, c]) expect(run.releaseLagMs).toBeLessThan(100);
    // 断った本文は読み切らない（送られた量はソケットのバッファの分で止まる）。
    for (const stream of a.streams) expect(stream).toEqual({ completed: false, small: true });
    expect(a.payments).toBe(1);
    expect(recorder.rejected()).toBe(0);
    expect(view(recorder.records())).toEqual(expected);
    expect(thrower.calls).toBe(2);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * SVM（共有の paidOutcomeOf、cid は書かない）
 *
 * 1 つの harness（facilitator・RPC・Provider・署名器の seed・transport が同じ）の上に sink だけを替えた 3 つの rail を作り、同じ paymentId・
 * 同じ時計・新しい予約の口で 1 回ずつ払う。ed25519 の署名は決定的なので、PayResult の全体（本文・txRef・receiptRef）と、transport の要求の
 * 記録（順・方法・path・ヘッダの名前・ヘッダの値と本文の hash）と report の呼び出しが 3 通りで同じであることを比べる。
 * ────────────────────────────────────────────────────────────────────────────── */

const SVM_PAYMENT_ID = "11111111-2222-4333-8444-000000000999";

type SvmMode = SvmHarness["upstream"]["state"]["payMode"];

interface SvmRun {
  readonly result: PayResult;
  readonly trace: readonly string[];
  readonly paid: number;
  readonly signs: number;
}

interface SvmScenario {
  readonly mode?: SvmMode;
  readonly dynamic?: boolean;
  /** 払う直前の準備（署名器の mode・hook・challenge の状態）。毎回の run で呼ぶ。 */
  readonly arrange?: (h: SvmHarness, baseNow: number) => void;
}

/** 3 通りで同じ鍵（試験用の決まった seed。資金は無い）。 */
const SVM_SEEDS = { router: new Uint8Array(32).fill(0x31), provider: new Uint8Array(32).fill(0x32), feePayer: new Uint8Array(32).fill(0x33) };

async function runSvmThreeWay(scenario: SvmScenario): Promise<{ runs: SvmRun[]; recorder: ReturnType<typeof recordingDiagnostics>; thrower: ReturnType<typeof throwingDiagnostics> }> {
  const dynamic = scenario.dynamic === true;
  const recorder = recordingDiagnostics();
  const thrower = throwingDiagnostics();
  const baseNow = Date.now();
  const routeId = dynamic ? SVM_PROFILE_ID : ROUTE;
  const target = dynamic ? { url: SVM_URL_A, method: "GET" as const } : undefined;
  const runs: SvmRun[] = [];
  for (const sink of [undefined, recorder, thrower]) {
    // run ごとに新しい fixture（facilitator の二重決済の検査を持ち越さない）。鍵・fee payer・Provider は seed で同じ。
    const h = await svmHarnessIn({ TLS, closers }, { staticRoute: !dynamic, seeds: SVM_SEEDS, ...(sink === undefined ? {} : { diagnostics: sink }) });
    h.clock.now = baseNow;
    h.upstream.state.payMode = scenario.mode ?? "settle";
    h.trace.on = true;
    const offer = (await h.rail.readChallenge(routeId, target))[0]!;
    scenario.arrange?.(h, baseNow);
    const result = await h.rail.pay(requestOf(h, offer, { routeId, paymentId: SVM_PAYMENT_ID, deadlineMs: baseNow + 600_000, ...(target === undefined ? {} : { target }) }));
    // 本文の読み取りの失敗の report などが届くのを待つ。
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.trace.on = false;
    runs.push({ result, trace: [...h.trace.lines], paid: h.upstream.seen.paid.length, signs: h.signer.signCount() });
  }
  return { runs, recorder, thrower };
}

describe("SVM: §8.2 の 3 通り（PayResult の全体・要求の記録・report が同じ）と記録", () => {
  const signed = { stage: "dest_sign", outcome: "signed" };
  const cases: ReadonlyArray<readonly [string, SvmScenario, Partial<PayResult> & { outcome: PayResult["outcome"] }, Array<Record<string, unknown>>]> = [
    ["成功（静的）", {}, { outcome: "paid" }, [signed, { stage: "dest_pay_request", httpStatus: 200, receipt: "ok", receiptHeader: "payment-response" }]],
    ["成功（動的）", { dynamic: true }, { outcome: "paid" }, [signed, { stage: "dest_pay_request", httpStatus: 200, receipt: "ok", receiptHeader: "payment-response" }]],
    ["500", { mode: "status-500" }, { outcome: "unknown", reason: "destination_pay_unknown" }, [signed, { stage: "dest_pay_request", httpStatus: 500, receipt: "absent", receiptHeader: "none" }]],
    ["領収の無い 200", { mode: "no-receipt-200" }, { outcome: "unknown", reason: "destination_receipt_unverified" }, [signed, { stage: "dest_pay_request", httpStatus: 200, receipt: "absent", receiptHeader: "none" }]],
    ["payer 違い", { mode: "payer-mismatch" }, { outcome: "unknown", reason: "destination_receipt_payer_mismatch" }, [signed, { stage: "dest_pay_request", httpStatus: 200, receipt: "payer_mismatch", receiptHeader: "payment-response" }]],
    ["verify の後の 402", { mode: "verify-only" }, { outcome: "rejected", reason: "destination_rejected" }, [signed, { stage: "dest_pay_request", httpStatus: 402, receipt: "absent", receiptHeader: "none" }]],
    ["署名の拒否（署名器が投げる）", { arrange: (h) => void (h.signer.mode = "throw") }, { outcome: "not_sent", reason: "destination_not_signed" }, [{ stage: "dest_sign", outcome: "not_sent", code: "destination_not_signed" }]],
    [
      "payload の食い違い（wire の改変）",
      {
        arrange: (h) =>
          void (h.hooks.wire = (bytes) => {
            const copy = Uint8Array.from(bytes);
            copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 1;
            return copy;
          }),
      },
      { outcome: "not_sent", reason: "destination_payload_mismatch" },
      [{ stage: "dest_sign", outcome: "not_sent", code: "destination_payload_mismatch" }],
    ],
    ["署名の後・送出の前の期限", { arrange: (h, baseNow) => void (h.hooks.afterSign = () => void (h.clock.now = baseNow + 700_000)) }, { outcome: "not_sent", reason: "destination_deadline" }, [{ stage: "dest_sign", outcome: "not_sent", code: "destination_deadline" }]],
    ["有料の要求の transport の失敗（settle の後に接続を切る）", { mode: "drop-after-settle" }, { outcome: "unknown", reason: "destination_pay_unknown" }, [signed, { stage: "dest_pay_request", transport: "transport_failed" }]],
    ["本文の読み取りの失敗（領収の 200 の本文の途中で切る）", { mode: "receipt-then-reset" }, { outcome: "paid_no_data", reason: "paid_data_unavailable" }, [signed, { stage: "dest_pay_request", httpStatus: 200, receipt: "ok", receiptHeader: "payment-response", transport: "transport_failed", code: "paid_data_unavailable" }]],
  ];

  test.each(cases)("%s", async (_name, scenario, result, expected) => {
    const { runs, recorder, thrower } = await runSvmThreeWay(scenario);
    const [a, b, c] = runs as [SvmRun, SvmRun, SvmRun];
    expect(a.result).toMatchObject(result);
    // 比べる PayResult は全体（本文・txRef・receiptRef を含む）。
    if (a.result.outcome === "paid") expect(a.result).toMatchObject({ body: expect.anything(), txRef: expect.any(String), receiptRef: expect.any(String) });
    if (a.result.outcome === "paid_no_data") expect(a.result).toMatchObject({ receiptRef: expect.any(String) });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.trace.length).toBeGreaterThan(0);
    expect(recorder.rejected()).toBe(0);
    const records = recorder.records();
    expect(view(records)).toEqual(expected);
    for (const r of records) expect(r.cid).toBeUndefined();
    expect(thrower.calls).toBe(expected.length);
  });

  test.each([
    ["静的（読み取りの失敗は challenge_invalid）", false, { code: "challenge_invalid" }],
    ["動的（固定の理由 status）", true, { code: "status" }],
  ] as const)("challenge の読み直しの失敗: %s（3 通りで同じ）", async (_name, dynamic, expected) => {
    const { runs, recorder } = await runSvmThreeWay({ dynamic, arrange: (h) => void (h.upstream.state.challengeStatus = 500) });
    const [a, b, c] = runs as [SvmRun, SvmRun, SvmRun];
    expect(a.result).toEqual({ outcome: "not_sent", reason: "destination_challenge_unreadable" });
    expect(a.paid).toBe(0);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(view(recorder.records())).toEqual([{ stage: "dest_challenge", ...expected }]);
  });
});
