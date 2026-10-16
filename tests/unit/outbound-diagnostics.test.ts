/**
 * 送信の adapter の診断（設計 `docs/rejection-reasons-design.md` §4.3・§8.2、§12.2・§12.3・§13.1・§15.1 が優先。要件 FR-R3・SR-R1〜R5・AC-R1 の送信。タスク R-4）。
 *
 * - 共有の `paidOutcomeOf`（動的 EVM・静的 Arc・SVM）: 402 の `PAYMENT-REQUIRED.error`（表・表に無い・欄なし）、412、`PAYMENT-RESPONSE` の
 *   `success:false`・`errorReason`、network 違い、tx の形違い、payer 違い、5xx、領収の無い 2xx、本文の読み取りの失敗、`X-PAYMENT-RESPONSE`
 * - adapter ごと（動的 EVM・静的 Arc・静的 Base）: 成功（`cid` が facilitator と同じ）、拒否、`not_sent` の各 code、challenge の読み直しの
 *   9 分類と transport、有料の要求の transport の失敗（timeout・接続失敗）。静的 Base は SDK が既に読んだ本文の理由も
 * - §8.2: (a) sink 無し・(b) 記録する sink・(c) 投げる sink で、結果・要求の記録（順・回数・ヘッダの名前）・本文の読み取り・署名の回数・report が同じ
 * - 記録は送出の後・結果を決めた後（§12.3）、断った本文は読まない（§12.2）、canary（ヘッダの値・本文の文字列・URL・例外の message）は記録に現れない
 * 鍵は試験の中の乱数（または決まった試験用の値）。外への接続・送金は無い。
 */
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  /** SDK が返す payload の `x402Version` を書き換える（`destination_payload_mismatch` を起こす）。 */
  payloadVersion: undefined as undefined | number,
}));
vi.mock("@x402/fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@x402/fetch")>();
  class HookedHttpClient extends actual.x402HTTPClient {
    override async createPaymentPayload(...args: Parameters<InstanceType<typeof actual.x402HTTPClient>["createPaymentPayload"]>): ReturnType<InstanceType<typeof actual.x402HTTPClient>["createPaymentPayload"]> {
      const payload = await super.createPaymentPayload(...args);
      return sdk.payloadVersion === undefined ? payload : { ...payload, x402Version: sdk.payloadVersion };
    }
  }
  return { ...actual, x402HTTPClient: HookedHttpClient };
});

import { DynamicChallengeError, EVM_RECEIPT_FORM, paidOutcomeOf } from "../../src/adapters/outbound/x402-dynamic.js";
import type { PayDiagnostics } from "../../src/adapters/outbound/outbound-diagnostics.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../../src/net/bounded-body.js";
import type { DestinationOffer, PayResult } from "../../src/ports/outbound.js";
import { diagCorrelationIdOf, withDiagnosticScope, type DiagCapture, type DiagnosticsSink, type DiagRecord } from "../../src/shared/diagnostics.js";
import { diagCidInputOf } from "../../tools/evm-facilitator.js";
import { recordingDiagnostics, throwingDiagnostics, type RecordingDiagnostics } from "../fixtures/diagnostics.js";
import {
  ARC,
  arcRail,
  BASE,
  baseRail,
  DYNAMIC_URL,
  dynamicRail,
  offerOf,
  okReceipt,
  payReplyResponse,
  transportError,
  OPERATOR_PAY_TO,
  BASE_USDC,
  ARC_USDC,
  type BodyStats,
  type PayReply,
  type RailEnv,
  type RailOptions,
} from "../fixtures/outbound-diag.js";

afterEach(() => {
  sdk.payloadVersion = undefined;
});

const FIXED_KEY = `0x${"4b".repeat(32)}` as const;
const CANARY = "canary-r4";
const required = (error?: unknown, extra: Record<string, unknown> = {}): string =>
  encodePaymentRequiredHeader({ x402Version: 2, resource: { url: "https://provider.test/" }, accepts: [], ...(error === undefined ? {} : { error }), ...extra } as never);

/** 比べやすい形（時刻・連番・経過は除く）。 */
function view(records: readonly DiagRecord[]): Array<Record<string, unknown>> {
  return records.map((r) => {
    const out: Record<string, unknown> = { stage: r.stage };
    for (const key of ["outcome", "code", "transport", "httpStatus", "receipt", "receiptHeader", "reasonField", "reasonSource", "reason", "op"] as const) if (r[key] !== undefined) out[key] = r[key];
    if (r.cid !== undefined) out["cid"] = "cid";
    return out;
  });
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 共有の paidOutcomeOf（EVM の形。SVM の形は wire の試験）
 * ────────────────────────────────────────────────────────────────────────────── */

const SIGNER = "0x00000000000000000000000000000000000000C0";
const OFFER: DestinationOffer = offerOf(ARC, ARC_USDC);
const FORM = EVM_RECEIPT_FORM(SIGNER);
const CID = { network: ARC, asset: ARC_USDC, from: SIGNER, nonce: `0x${"01".repeat(32)}` };

interface PaidCase {
  readonly name: string;
  readonly reply: Exclude<PayReply, { throws: unknown }>;
  readonly result: Partial<PayResult> & { outcome: PayResult["outcome"] };
  readonly record: Record<string, unknown>;
  /** 本文を読む（整合した 200 だけ）。 */
  readonly reads?: boolean;
}

const PAID_CASES: readonly PaidCase[] = [
  {
    name: "402 + PAYMENT-REQUIRED.error（表にある）",
    reply: { status: 402, paymentRequired: required("invalid_exact_evm_insufficient_balance"), body: JSON.stringify({ error: `${CANARY}-body` }) },
    result: { outcome: "rejected", reason: "destination_rejected" },
    record: { httpStatus: 402, receipt: "absent", receiptHeader: "none", reasonField: "error", reasonSource: "payment_required_header", reason: "invalid_exact_evm_insufficient_balance" },
  },
  {
    name: "402 + PAYMENT-REQUIRED.error（表に無い）",
    reply: { status: 402, paymentRequired: required(`${CANARY}-required`) },
    result: { outcome: "rejected", reason: "destination_rejected" },
    record: { httpStatus: 402, receipt: "absent", receiptHeader: "none", reasonField: "error", reasonSource: "payment_required_header", reason: "unrecognized" },
  },
  {
    name: "402 + PAYMENT-REQUIRED（error の欄なし）",
    reply: { status: 402, paymentRequired: required() },
    result: { outcome: "rejected", reason: "destination_rejected" },
    record: { httpStatus: 402, receipt: "absent", receiptHeader: "none", reasonField: "error", reasonSource: "payment_required_header", reason: "absent" },
  },
  {
    name: "402（PAYMENT-REQUIRED 無し）",
    reply: { status: 402 },
    result: { outcome: "rejected", reason: "destination_rejected" },
    record: { httpStatus: 402, receipt: "absent", receiptHeader: "none" },
  },
  {
    name: "412 + PAYMENT-REQUIRED.error（402 以外の状態でも見る）",
    reply: { status: 412, paymentRequired: required("permit2_allowance_required") },
    result: { outcome: "rejected", reason: "destination_rejected" },
    record: { httpStatus: 412, receipt: "absent", receiptHeader: "none", reasonField: "error", reasonSource: "payment_required_header", reason: "permit2_allowance_required" },
  },
  {
    name: "402 + PAYMENT-RESPONSE success:false（errorReason が PAYMENT-REQUIRED に優先）",
    reply: { status: 402, receipt: { success: false, errorReason: "invalid_exact_evm_transaction_failed", transaction: "", network: ARC }, paymentRequired: required("payment_invalid") },
    result: { outcome: "rejected", reason: "destination_rejected" },
    record: { httpStatus: 402, receipt: "failed", receiptHeader: "payment-response", reasonField: "errorReason", reasonSource: "payment_response_header", reason: "invalid_exact_evm_transaction_failed" },
  },
  {
    name: "402 + PAYMENT-RESPONSE success:false（errorReason が自由な文字列）",
    reply: { status: 402, receipt: { success: false, errorReason: `${CANARY}-error-reason https://${CANARY}.test/x` } },
    result: { outcome: "rejected", reason: "destination_rejected" },
    record: { httpStatus: 402, receipt: "failed", receiptHeader: "payment-response", reasonField: "errorReason", reasonSource: "payment_response_header", reason: "unrecognized" },
  },
  {
    name: "200 + network 違いの領収",
    reply: { status: 200, receipt: okReceipt(BASE) },
    result: { outcome: "unknown", reason: "destination_receipt_unverified" },
    record: { httpStatus: 200, receipt: "network_mismatch", receiptHeader: "payment-response" },
  },
  {
    name: "200 + tx の形違いの領収",
    reply: { status: 200, receipt: { success: true, network: ARC, transaction: `${CANARY}-tx` } },
    result: { outcome: "unknown", reason: "destination_receipt_unverified" },
    record: { httpStatus: 200, receipt: "tx_malformed", receiptHeader: "payment-response" },
  },
  {
    name: "200 + payer 違いの領収（PAYMENT-REQUIRED も写す）",
    reply: { status: 200, receipt: okReceipt(ARC, "0x00000000000000000000000000000000000000C1"), paymentRequired: required("payment_invalid") },
    result: { outcome: "unknown", reason: "destination_receipt_payer_mismatch" },
    record: { httpStatus: 200, receipt: "payer_mismatch", receiptHeader: "payment-response", reasonField: "error", reasonSource: "payment_required_header", reason: "payment_invalid" },
  },
  {
    name: "200 + 壊れた領収（X-PAYMENT-RESPONSE）",
    reply: { status: 200, legacyReceipt: `%%${CANARY}%%` },
    result: { outcome: "unknown", reason: "destination_receipt_unverified" },
    record: { httpStatus: 200, receipt: "malformed", receiptHeader: "x-payment-response" },
  },
  {
    name: "200（領収無し）",
    reply: { status: 200, body: JSON.stringify({ error: `${CANARY}-data` }) },
    result: { outcome: "unknown", reason: "destination_receipt_unverified" },
    record: { httpStatus: 200, receipt: "absent", receiptHeader: "none" },
  },
  {
    name: "500（領収無し）",
    reply: { status: 500, body: JSON.stringify({ error: "facilitator_unavailable" }) },
    result: { outcome: "unknown", reason: "destination_pay_unknown" },
    record: { httpStatus: 500, receipt: "absent", receiptHeader: "none" },
  },
  {
    name: "503 + PAYMENT-REQUIRED.error",
    reply: { status: 503, paymentRequired: required("facilitator_unavailable") },
    result: { outcome: "unknown", reason: "destination_pay_unknown" },
    record: { httpStatus: 503, receipt: "absent", receiptHeader: "none", reasonField: "error", reasonSource: "payment_required_header", reason: "facilitator_unavailable" },
  },
  {
    name: "502 + 整合した領収（PAYMENT-REQUIRED は写さない）",
    reply: { status: 502, receipt: okReceipt(ARC, SIGNER), paymentRequired: required("payment_invalid") },
    result: { outcome: "paid_no_data", reason: "paid_data_unavailable" },
    record: { httpStatus: 502, receipt: "ok", receiptHeader: "payment-response" },
  },
  {
    name: "200 + 整合した領収（本文を読む）",
    reply: { status: 200, receipt: okReceipt(ARC, SIGNER), body: JSON.stringify({ price: 1 }) },
    result: { outcome: "paid", body: { price: 1 } },
    record: { httpStatus: 200, receipt: "ok", receiptHeader: "payment-response" },
    reads: true,
  },
  {
    name: "200 + 整合した領収 + 本文の読み取りの失敗",
    reply: { status: 200, receipt: okReceipt(ARC, SIGNER), body: JSON.stringify({ price: 1 }), failBodyAfterPulls: 0, bodyError: Object.assign(new Error(`${CANARY} body timeout`), { name: "TimeoutError" }) },
    result: { outcome: "paid_no_data", reason: "paid_data_unavailable" },
    record: { httpStatus: 200, receipt: "ok", receiptHeader: "payment-response", transport: "upstream_timeout", code: "paid_data_unavailable" },
    reads: true,
  },
];

async function runPaid(reply: Exclude<PayReply, { throws: unknown }>, sink: DiagnosticsSink | undefined): Promise<{ result: PayResult; body: BodyStats; reports: number }> {
  const body: BodyStats = { pulls: 0, cancelled: false };
  const response = payReplyResponse(reply, body);
  let reports = 0;
  const diagnostics: PayDiagnostics | undefined = sink === undefined ? undefined : { sink, startedAt: 0, cid: CID };
  const result = await paidOutcomeOf(response, OFFER, FORM, { maxBodyBytes: DYNAMIC_RESPONSE_LIMITS.maxPaidBodyBytes, report: () => (reports += 1), ctx: { routeId: "r", operation: "pay" }, diagnostics });
  await new Promise((resolve) => setImmediate(resolve));
  return { result, body: { ...body }, reports };
}

describe("paidOutcomeOf: dest_sign と dest_pay_request（3 通りで結果と本文の読み取りが同じ）", () => {
  test.each(PAID_CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const a = await runPaid(c.reply, undefined);
    const recorder = recordingDiagnostics();
    const b = await runPaid(c.reply, recorder);
    const thrower = throwingDiagnostics();
    const cRun = await runPaid(c.reply, thrower);
    expect(a.result).toMatchObject(c.result);
    expect(b).toEqual(a);
    expect(cRun).toEqual(a);
    expect(thrower.calls).toBe(2);
    // 断った・領収の整合しない応答の本文は 1 バイトも読まない（discardBody だけ。§12.2）。
    if (c.reads !== true) expect(a.body).toEqual({ pulls: 0, cancelled: true });
    expect(recorder.rejected()).toBe(0);
    const records = recorder.records();
    expect(view(records)).toEqual([
      { stage: "dest_sign", outcome: "signed", cid: "cid" },
      { stage: "dest_pay_request", op: "pay", cid: "cid", ...c.record },
    ]);
    expect(records[0]!.cid).toBe(diagCorrelationIdOf(CID.network, CID.asset, CID.from, CID.nonce));
    expect(records[1]!.network).toBe(ARC);
    expect(typeof records[1]!.elapsedMs).toBe("number");
    expect(JSON.stringify(records)).not.toContain(CANARY);
  });

  test("hook はヘッダを decode しない: 写しは文字列の参照だけで、分類は後回しの処理（buildDiagRecord）にある", async () => {
    const captured: DiagCapture[] = [];
    const sink: DiagnosticsSink = { emit: (capture) => void captured.push(capture) };
    await runPaid({ status: 402, paymentRequired: required("payment_invalid"), receipt: { success: false, errorReason: "x" } }, sink);
    const pay = captured.find((c) => c.stage === "dest_pay_request")!;
    expect(pay).not.toHaveProperty("receipt");
    expect(pay).not.toHaveProperty("rawReason");
    expect(typeof pay.rawPaymentRequired).toBe("string");
    expect(typeof pay.rawReceiptHeader).toBe("string");
    expect(pay.receiptHeader).toBe("payment-response");
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * adapter ごと（動的 EVM・静的 Arc・静的 Base）
 * ────────────────────────────────────────────────────────────────────────────── */

type Make = (options?: RailOptions) => RailEnv;
const ADAPTERS: ReadonlyArray<readonly [string, Make, string]> = [
  ["動的 EVM", dynamicRail, BASE],
  ["静的 Arc", arcRail, ARC],
  ["静的 Base", baseRail, BASE],
];

interface Run {
  readonly result: PayResult;
  readonly requests: readonly string[];
  readonly body: BodyStats;
  readonly signatures: number;
  readonly reports: readonly string[];
  readonly payments: readonly unknown[];
}

/** 署名ごとに変わる値（nonce・署名・期限の時刻）を除いた支払い。 */
function normalizedPayment(payment: unknown): unknown {
  return JSON.parse(
    JSON.stringify(payment, (key, value) => (["signature", "nonce", "validAfter", "validBefore"].includes(key) ? "-" : value)),
  );
}

async function runOn(env: RailEnv, act: (env: RailEnv) => Promise<PayResult>): Promise<Run> {
  const result = await act(env);
  await new Promise((resolve) => setImmediate(resolve));
  return { result, requests: [...env.upstream.requests], body: { ...env.upstream.body }, signatures: env.signatures(), reports: [...env.upstream.reports], payments: env.upstream.payments.map(normalizedPayment) };
}

/** §8.2 の 3 通り。記録する sink の記録と、(a) の環境を返す。 */
async function threeWay(make: Make, arrange: (env: RailEnv) => void, act: (env: RailEnv) => Promise<PayResult> = (env) => env.rail.pay(env.request(env.upstream.accepts[0] as unknown as DestinationOffer)), options: RailOptions = {}) {
  const runs: Run[] = [];
  const recorder = recordingDiagnostics();
  const thrower = throwingDiagnostics();
  let first: RailEnv | undefined;
  let recorded: RailEnv | undefined;
  for (const sink of [undefined, recorder, thrower]) {
    const env = make({ privateKey: FIXED_KEY, ...options, ...(sink === undefined ? {} : { diagnostics: sink }) });
    arrange(env);
    runs.push(await runOn(env, act));
    if (sink === undefined) first = env;
    if (sink === recorder) recorded = env;
  }
  expect(runs[1]).toEqual(runs[0]);
  expect(runs[2]).toEqual(runs[0]);
  expect(recorder.rejected()).toBe(0);
  return { run: runs[0]!, records: recorder.records(), recorder, thrower, env: first!, recordedEnv: recorded! };
}

/** facilitator が受け取る本文（Provider は payload を変えずに渡す）から作る cid。 */
function facilitatorCidOf(payment: unknown): string {
  const body = { x402Version: 2, paymentPayload: payment, paymentRequirements: (payment as { accepted: unknown }).accepted };
  const input = diagCidInputOf(body);
  expect(input).toBeDefined();
  return diagCorrelationIdOf(input!.network, input!.asset, input!.from, input!.nonce);
}

describe.each(ADAPTERS)("%s: dest_sign・dest_pay_request", (_label, make, network) => {
  test("成功: signed（cid）と ok の領収。cid は facilitator が同じ authorization から作る値と同じ", async () => {
    const { run, records, recordedEnv } = await threeWay(make, (env) => {
      env.upstream.pay = () => ({ status: 200, receipt: okReceipt(network, env.address), body: JSON.stringify({ price: 1 }) });
    });
    expect(run.result).toMatchObject({ outcome: "paid", body: { price: 1 } });
    expect(view(records)).toEqual([
      { stage: "dest_sign", outcome: "signed", cid: "cid" },
      { stage: "dest_pay_request", op: "pay", httpStatus: 200, receipt: "ok", receiptHeader: "payment-response", cid: "cid" },
    ]);
    const cid = facilitatorCidOf(recordedEnv.upstream.payments[0]);
    expect(records[0]!.cid).toBe(cid);
    expect(records[1]!.cid).toBe(cid);
  });

  test("402 + PAYMENT-REQUIRED.error（表）: rejected、本文は読まない", async () => {
    const { run, records } = await threeWay(make, (env) => {
      env.upstream.pay = () => ({ status: 402, paymentRequired: required("invalid_exact_evm_insufficient_balance"), body: "{}" });
    });
    expect(run.result).toEqual({ outcome: "rejected", reason: "destination_rejected" });
    expect(view(records)[1]).toMatchObject({ httpStatus: 402, receipt: "absent", reasonSource: "payment_required_header", reason: "invalid_exact_evm_insufficient_balance" });
  });

  test("412 + PAYMENT-REQUIRED.error", async () => {
    const { run, records } = await threeWay(make, (env) => {
      env.upstream.pay = () => ({ status: 412, paymentRequired: required("permit2_allowance_required") });
    });
    expect(run.result).toEqual({ outcome: "rejected", reason: "destination_rejected" });
    expect(view(records)[1]).toMatchObject({ httpStatus: 412, reasonSource: "payment_required_header", reason: "permit2_allowance_required" });
  });

  test("PAYMENT-RESPONSE success:false + errorReason", async () => {
    const { records } = await threeWay(make, (env) => {
      env.upstream.pay = () => ({ status: 402, receipt: { success: false, errorReason: "invalid_exact_evm_transaction_failed", transaction: "", network } });
    });
    expect(view(records)[1]).toMatchObject({ receipt: "failed", receiptHeader: "payment-response", reasonField: "errorReason", reasonSource: "payment_response_header", reason: "invalid_exact_evm_transaction_failed" });
  });

  test.each([
    ["network 違い", (env: RailEnv) => okReceipt(network === BASE ? ARC : BASE, env.address), "network_mismatch", "unknown"],
    // 静的 Base の判断は従来どおり「空でない文字列」だけを見る（結果は paid）。診断の分類は共有の形で tx_malformed。
    ["tx の形違い", (env: RailEnv) => ({ success: true, network, transaction: "0x1234", payer: env.address }), "tx_malformed", make === baseRail ? "paid" : "unknown"],
    ["payer 違い", () => okReceipt(network, "0x00000000000000000000000000000000000000C1"), "payer_mismatch", "unknown"],
  ] as const)("200 + %s の領収", async (_name, receiptOf, cls, outcome) => {
    const { run, records } = await threeWay(make, (env) => {
      env.upstream.pay = () => ({ status: 200, receipt: receiptOf(env), body: "{}" });
    });
    expect(run.result.outcome).toBe(outcome);
    expect(view(records)[1]).toMatchObject({ httpStatus: 200, receipt: cls });
  });

  test("5xx と領収の無い 2xx", async () => {
    for (const [status, outcome] of [
      [500, "unknown"],
      [503, "unknown"],
      [200, "unknown"],
      // 静的 Base の判断は従来どおり（200・502・402・5xx 以外の 2xx は rejected）。
      [201, make === baseRail ? "rejected" : "unknown"],
    ] as const) {
      const { run, records } = await threeWay(make, (env) => {
        env.upstream.pay = () => ({ status, body: "{}" });
      });
      expect(run.result.outcome).toBe(outcome);
      expect(view(records)[1]).toMatchObject({ httpStatus: status, receipt: "absent", receiptHeader: "none" });
    }
  });

  test.each([
    ["upstream_timeout"],
    ["connect_failed"],
  ] as const)("有料の要求の transport の失敗（%s）: 結果は unknown のまま、transport と経過", async (code) => {
    const { run, records } = await threeWay(make, (env) => {
      env.upstream.pay = () => ({ throws: transportError(code, "pay") });
    });
    expect(run.result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(view(records)).toEqual([
      { stage: "dest_sign", outcome: "signed", cid: "cid" },
      { stage: "dest_pay_request", op: "pay", transport: code, cid: "cid" },
    ]);
    expect(typeof records[1]!.elapsedMs).toBe("number");
  });

  test("記録は送出の後（応答の headers の後・失敗の後）に積む。署名の直後には積まない（§12.3）", async () => {
    for (const reply of ["ok", "throws"] as const) {
      const events: string[] = [];
      const recorder = recordingDiagnostics();
      const sink: DiagnosticsSink = { emit: (capture) => (events.push(`emit:${capture.stage}`), recorder.emit(capture)) };
      const env = make({ diagnostics: sink });
      env.upstream.pay = () => (reply === "ok" ? { status: 402, paymentRequired: required("payment_invalid") } : { throws: transportError("upstream_timeout", "pay") });
      const original = env.upstream.events.push.bind(env.upstream.events);
      env.upstream.events.push = (...items: string[]) => (events.push(...items), original(...items));
      await env.rail.pay(env.request(env.upstream.accepts[0] as unknown as DestinationOffer));
      const sent = events.indexOf(reply === "ok" ? "pay:headers" : "pay:threw");
      expect(sent).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("emit:dest_sign")).toBeGreaterThan(sent);
      expect(events.indexOf("emit:dest_pay_request")).toBeGreaterThan(events.indexOf("emit:dest_sign"));
    }
  });

  test("購入の scope の中では paymentId・attempt が付く", async () => {
    const recorder = recordingDiagnostics();
    const env = make({ diagnostics: recorder });
    env.upstream.pay = () => ({ status: 402 });
    const request = env.request(env.upstream.accepts[0] as unknown as DestinationOffer);
    await withDiagnosticScope({ paymentId: request.paymentId, attempt: 3 }, () => env.rail.pay(request));
    expect(recorder.records().map((r) => [r.stage, r.paymentId, r.attempt])).toEqual([
      ["dest_sign", request.paymentId, 3],
      ["dest_pay_request", request.paymentId, 3],
    ]);
  });

  test("not_sent: 署名の前は adapter は記録しない（core の dest_outcome）。署名の段は dest_sign の code", async () => {
    // 署名器の network 違い（署名側に触らない）
    let r = await threeWay(make, () => {}, undefined, { signerNetwork: "eip155:1" });
    expect(r.run.result).toEqual({ outcome: "not_sent", reason: "destination_signer_network_mismatch" });
    expect(r.records).toEqual([]);
    // offer が変わった（読み直しで一致しない）
    r = await threeWay(make, (env) => void (env.upstream.accepts = [{ ...env.upstream.accepts[0]!, amount: "1001" }]), (env) => env.rail.pay(env.request(offerOf(network, network === ARC ? ARC_USDC : BASE_USDC))));
    expect(r.run.result).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    expect(r.records).toEqual([]);
    // 運用者への支払い（保存した offer の再検査。動的はプロファイルの受信の受取先、静的は自分の署名者）
    const toOperator = (env: RailEnv): DestinationOffer => offerOf(network, network === ARC ? ARC_USDC : BASE_USDC, { payTo: make === dynamicRail ? OPERATOR_PAY_TO : env.address });
    r = await threeWay(make, (env) => void (env.upstream.accepts = [toOperator(env) as unknown as Record<string, unknown>]), (env) => env.rail.pay(env.request(toOperator(env))));
    expect(r.run.result).toEqual({ outcome: "not_sent", reason: "destination_offer_not_allowed" });
    expect(r.records).toEqual([]);
    // 署名器が失敗した → dest_sign not_sent destination_not_signed（cid 無し）
    r = await threeWay(make, () => {}, undefined, { signerThrows: true });
    expect(r.run.result).toEqual({ outcome: "not_sent", reason: "destination_not_signed" });
    expect(view(r.records)).toEqual([{ stage: "dest_sign", outcome: "not_sent", code: "destination_not_signed" }]);
    // 期限が署名の前に過ぎている → destination_deadline（署名器は呼ばない）
    r = await threeWay(make, () => {}, (env) => env.rail.pay(env.request(env.upstream.accepts[0] as unknown as DestinationOffer, { deadlineMs: env.clock.now - 1 })));
    expect(r.run.result).toEqual({ outcome: "not_sent", reason: "destination_deadline" });
    expect(r.run.signatures).toBe(0);
    expect(view(r.records)).toEqual([{ stage: "dest_sign", outcome: "not_sent", code: "destination_deadline" }]);
    // 署名の後・送出の直前に期限が過ぎる → destination_deadline（cid つき、送出しない）
    r = await threeWay(make, (env) => void (env.clock.afterSign = env.clock.now + 600_000), (env) => env.rail.pay(env.request(env.upstream.accepts[0] as unknown as DestinationOffer)));
    expect(r.run.result).toEqual({ outcome: "not_sent", reason: "destination_deadline" });
    expect(r.run.signatures).toBe(1);
    expect(r.run.requests.filter((line) => line.startsWith("pay "))).toEqual([]);
    expect(view(r.records)).toEqual([{ stage: "dest_sign", outcome: "not_sent", code: "destination_deadline", cid: "cid" }]);
  });

  test("not_sent: SDK の payload が承認と食い違う → destination_payload_mismatch（cid つき）", async () => {
    if (make === baseRail) return; // Base の経路は x402Version を見ない（従来の検査のまま）
    sdk.payloadVersion = 1;
    const r = await threeWay(make, () => {});
    expect(r.run.result).toEqual({ outcome: "not_sent", reason: "destination_payload_mismatch" });
    expect(view(r.records)).toEqual([{ stage: "dest_sign", outcome: "not_sent", code: "destination_payload_mismatch", cid: "cid" }]);
  });

  test("canary（ヘッダの値・本文・URL・例外の message）は記録に現れない", async () => {
    const replies: Array<(env: RailEnv) => PayReply> = [
      () => ({ status: 402, paymentRequired: required(`${CANARY}-required`, { extra: CANARY }), body: JSON.stringify({ error: `${CANARY}-body`, errorReason: CANARY, invalidReason: CANARY }) }),
      () => ({ status: 402, receipt: { success: false, errorReason: `${CANARY}-reason`, errorMessage: CANARY } }),
      (env) => ({ status: 200, receipt: { ...okReceipt(network, env.address), extra: CANARY }, body: JSON.stringify({ error: CANARY }) }),
      () => ({ status: 200, legacyReceipt: `${CANARY}==`, body: CANARY, contentType: "text/plain" }),
      () => ({ throws: transportError("transport_failed", "pay") }),
      () => ({ throws: new Error(`${CANARY} plain failure https://${CANARY}.test/`) }),
    ];
    for (const reply of replies) {
      const { records } = await threeWay(make, (env) => {
        env.upstream.pay = () => reply(env);
      });
      expect(records.length).toBeGreaterThan(0);
      expect(JSON.stringify(records)).not.toContain(CANARY);
      expect(JSON.stringify(records)).not.toContain("provider.test");
    }
  });
});

describe("静的 Base: SDK が既に読んだ本文の理由と processResponse の失敗", () => {
  test("402 + 本文 {error}（PAYMENT-REQUIRED に error が無い）→ response_body の理由", async () => {
    const { run, records } = await threeWay(baseRail, (env) => {
      env.upstream.pay = () => ({ status: 402, paymentRequired: required(), body: JSON.stringify({ error: "payment_invalid" }) });
    });
    expect(run.result).toEqual({ outcome: "rejected", reason: "destination_rejected" });
    expect(view(records)[1]).toMatchObject({ httpStatus: 402, receipt: "absent", reasonField: "error", reasonSource: "response_body", reason: "payment_invalid" });
  });

  test("502 + 本文 {invalidReason}（PAYMENT-REQUIRED 無し）", async () => {
    const { run, records } = await threeWay(baseRail, (env) => {
      env.upstream.pay = () => ({ status: 502, body: JSON.stringify({ invalidReason: "invalid_exact_evm_insufficient_balance", other: CANARY }) });
    });
    expect(run.result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(view(records)[1]).toMatchObject({ httpStatus: 502, reasonField: "invalidReason", reasonSource: "response_body", reason: "invalid_exact_evm_insufficient_balance" });
    expect(JSON.stringify(records)).not.toContain(CANARY);
  });

  test("整合した領収の 200 の本文の error は理由にしない（データ）", async () => {
    const { run, records } = await threeWay(baseRail, (env) => {
      env.upstream.pay = () => ({ status: 200, receipt: okReceipt(BASE, env.address), body: JSON.stringify({ error: "payment_invalid" }) });
    });
    expect(run.result.outcome).toBe("paid");
    expect(view(records)[1]).toEqual({ stage: "dest_pay_request", op: "pay", httpStatus: 200, receipt: "ok", receiptHeader: "payment-response", cid: "cid" });
  });

  test("processResponse の失敗（本文の読み取り）→ unknown のまま、transport", async () => {
    const { run, records } = await threeWay(baseRail, (env) => {
      env.upstream.pay = () => ({ status: 200, receipt: okReceipt(BASE, env.address), body: "{}", failBodyAfterPulls: 0, bodyError: Object.assign(new Error(CANARY), { name: "AbortError" }) });
    });
    expect(run.result).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(view(records)[1]).toMatchObject({ httpStatus: 200, receipt: "ok", transport: "aborted" });
    expect(records[1]!.code).toBeUndefined();
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * challenge の読み直しの失敗（dest_challenge）
 * ────────────────────────────────────────────────────────────────────────────── */

const challengeResponse = (status: number, header?: string): Response => new Response("{}", { status, headers: header === undefined ? {} : { "PAYMENT-REQUIRED": header } });
const requiredWith = (body: Record<string, unknown>): string => encodePaymentRequiredHeader(body as never);

describe("動的 EVM: challenge の読み直しの 9 分類と transport（code は固定の値だけ）", () => {
  const approved = offerOf(BASE, BASE_USDC);
  const accepts = [approved as unknown as Record<string, unknown>];
  const cases: ReadonlyArray<readonly [string, (env: RailEnv) => void, Partial<Parameters<RailEnv["request"]>[1]> | undefined, Record<string, unknown>]> = [
    ["status", (env) => void (env.upstream.challenge = () => challengeResponse(500)), undefined, { code: "status" }],
    ["no_header", (env) => void (env.upstream.challenge = () => challengeResponse(402)), undefined, { code: "no_header" }],
    ["undecodable", (env) => void (env.upstream.challenge = () => challengeResponse(402, `%%${CANARY}%%`)), undefined, { code: "undecodable" }],
    ["version", (env) => void (env.upstream.challenge = (url) => challengeResponse(402, requiredWith({ x402Version: 1, resource: { url }, accepts }))), undefined, { code: "version" }],
    ["no_offers", (env) => void (env.upstream.challenge = (url) => challengeResponse(402, requiredWith({ x402Version: 2, resource: { url }, accepts: [] }))), undefined, { code: "no_offers" }],
    ["too_many_offers", (env) => void (env.upstream.challenge = (url) => challengeResponse(402, requiredWith({ x402Version: 2, resource: { url }, accepts: Array.from({ length: 17 }, () => approved) }))), undefined, { code: "too_many_offers" }],
    ["resource_mismatch", (env) => void (env.upstream.resourceUrl = () => `https://${CANARY}.test/other`), undefined, { code: "resource_mismatch" }],
    ["method", () => {}, { target: { url: DYNAMIC_URL, method: "DELETE" as never } }, { code: "method" }],
    ["url", () => {}, { target: { url: `http://${CANARY}.test/x` } }, { code: "url" }],
    ["transport upstream_timeout", (env) => void (env.upstream.challenge = () => ({ throws: transportError("upstream_timeout", "pay_challenge") })), undefined, { transport: "upstream_timeout" }],
    ["transport connect_failed", (env) => void (env.upstream.challenge = () => ({ throws: transportError("connect_failed", "pay_challenge") })), undefined, { transport: "connect_failed" }],
    ["transport admission_refused", (env) => void (env.upstream.challenge = () => ({ throws: transportError("admission_refused", "pay_challenge") })), undefined, { transport: "admission_refused" }],
  ];
  test.each(cases)("%s", async (_name, arrange, overrides, expected) => {
    const { run, records } = await threeWay(dynamicRail, (env) => {
      env.upstream.accepts = accepts;
      arrange(env);
    }, (env) => env.rail.pay(env.request(approved, overrides)));
    expect(run.result).toEqual({ outcome: "not_sent", reason: "destination_challenge_unreadable" });
    expect(run.signatures).toBe(0);
    expect(view(records)).toEqual([{ stage: "dest_challenge", op: "pay_challenge", ...expected }]);
    expect(typeof records[0]!.elapsedMs).toBe("number");
    expect(JSON.stringify(records)).not.toContain(CANARY);
  });

  test("9 分類は DynamicChallengeError の理由の全部", () => {
    const reasons = ["status", "no_header", "undecodable", "version", "no_offers", "too_many_offers", "resource_mismatch", "method", "url"];
    for (const reason of reasons) expect(new DynamicChallengeError(reason as never).reason).toBe(reason);
    expect(cases.filter(([name]) => !name.startsWith("transport")).map(([name]) => name).sort()).toEqual([...reasons].sort());
  });
});

describe.each([
  ["静的 Arc", arcRail],
  ["静的 Base", baseRail],
] as const)("%s: challenge の読み直しの失敗", (_label, make) => {
  test.each([
    ["状態違い（challenge_invalid）", (env: RailEnv): void => void (env.upstream.challenge = () => challengeResponse(500)), { code: "challenge_invalid" }],
    ["ヘッダ無し（challenge_invalid）", (env: RailEnv): void => void (env.upstream.challenge = () => challengeResponse(402)), { code: "challenge_invalid" }],
    ["resource 違い（challenge_invalid）", (env: RailEnv): void => void (env.upstream.resourceUrl = () => `https://${CANARY}.test/`), { code: "challenge_invalid" }],
    ["transport upstream_timeout", (env: RailEnv): void => void (env.upstream.challenge = () => ({ throws: transportError("upstream_timeout", "pay_challenge") })), { transport: "upstream_timeout" }],
    ["transport connect_failed", (env: RailEnv): void => void (env.upstream.challenge = () => ({ throws: transportError("connect_failed", "pay_challenge") })), { transport: "connect_failed" }],
  ] as const)("%s", async (_name, arrange, expected) => {
    const { run, records } = await threeWay(make, arrange);
    expect(run.result).toEqual({ outcome: "not_sent", reason: "destination_challenge_unreadable" });
    expect(view(records)).toEqual([{ stage: "dest_challenge", op: "pay_challenge", ...expected }]);
    expect(JSON.stringify(records)).not.toContain(CANARY);
  });
});

describe("sink が無い（NOOP）とき hook は何もしない", () => {
  test("NOOP では emit が呼ばれず、時刻も読まない（performance.now の呼び出しが増えない）", async () => {
    const { performance } = await import("node:perf_hooks");
    const env = dynamicRail({ privateKey: FIXED_KEY });
    env.upstream.pay = () => ({ status: 402, paymentRequired: required("payment_invalid") });
    const spy = vi.spyOn(performance, "now");
    await env.rail.pay(env.request(env.upstream.accepts[0] as unknown as DestinationOffer));
    const withoutSink = spy.mock.calls.length;
    spy.mockClear();
    const recorder: RecordingDiagnostics = recordingDiagnostics();
    const env2 = dynamicRail({ privateKey: FIXED_KEY, diagnostics: recorder });
    env2.upstream.pay = () => ({ status: 402, paymentRequired: required("payment_invalid") });
    await env2.rail.pay(env2.request(env2.upstream.accepts[0] as unknown as DestinationOffer));
    expect(spy.mock.calls.length).toBeGreaterThan(withoutSink);
    spy.mockRestore();
    expect(withoutSink).toBe(0);
  });
});
