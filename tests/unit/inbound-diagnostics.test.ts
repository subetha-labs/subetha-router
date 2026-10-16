/**
 * 受信の adapter の診断の記録（設計 `docs/rejection-reasons-design.md` §4.2、§12.2・§12.3・§12.6・§13.1・§15.1 が優先。要件 FR-R2・SR-R1〜R5・
 * AC-R1 の受信の部分。タスク R-3）。
 *
 * - x402 の kind `x402`・`circle`、SVM の verify・settle: 4xx・5xx・JSON でない・形の違う JSON・表にある理由・無い理由・欄なし・型の違う理由・
 *   成功・network 違い・tx の形違い・`upstream_timeout`・`connect_failed`・本文の読み取りの失敗・売り手証明の拒否 → 期待する 1 行（throw は 0 行）
 * - 自由な文字列が残らない（`invalidReason`・`invalidMessage`・`errorReason`・`errorMessage`・URL・例外の文言に canary）
 * - §8.2 の 3 通り（sink 無し・記録する sink・投げる sink）で結果・要求の記録（method・path・本文の hash・header の名前・順序・回数）・
 *   transport の出来事・`onDiagnostic` が同じ
 * - core の中（R-2 の購入の scope）: throw の経路は core の 1 行（`transport`）だけで adapter の行は無く、transport の出来事に `cid` が付く。
 *   購入の結果・journal・要求・stderr が 3 通りで同じ
 * - `cid` は自前の facilitator（R-5）が同じ要求から作る `cid` と同じ（実際の往復）
 * 鍵・署名・送金・外への接続は無い（fake の transport と fake の chain だけ）。
 */
import { createHash } from "node:crypto";

import { getBase58Decoder } from "@solana/kit";
import { describe, expect, test } from "vitest";

import { createX402Inbound, type X402FacilitatorKind } from "../../src/adapters/inbound/x402.js";
import { createX402SvmInbound } from "../../src/adapters/inbound/x402-svm.js";
import { stableJson } from "../../src/core/intent.js";
import { diagnosticReportOf } from "../../src/main.js";
import { formatTransportEvent, TransportError, type GuardedTransport, type TransportCode, type TransportContext, type TransportEvent } from "../../src/net/guarded-fetch.js";
import type { InboundCallContext, InboundOffer, InboundRail, PaymentCredential, SellerProofCapability, SettleResult } from "../../src/ports/inbound.js";
import { diagCorrelationIdOf, DIAG_RECORD_KEYS, type DiagnosticsSink, type DiagRecord } from "../../src/shared/diagnostics.js";
import { REASON_TABLE_VERSION } from "../../src/shared/payment-reasons.js";
import {
  createEvmFacilitator,
  DEFAULT_MAX_SETTLE_GAS,
  diagCidInputOf,
  type ChainIo,
  type FacilitatorJournal,
  type Hex,
  type JournalRecord,
  type SetTimer,
} from "../../tools/evm-facilitator.js";
import { runScenario, STATIC_ROUTE, type Scenario, type ScenarioRun } from "../fixtures/diag-compare.js";
import { recordingDiagnostics, throwingDiagnostics, type RecordingDiagnostics } from "../fixtures/diagnostics.js";

/* ──────────────────────────────────────────────────────────────────────────────
 * 値
 * ────────────────────────────────────────────────────────────────────────────── */

const CANARY = "R3CANARYdiag9f8e7d";
/** facilitator の URL にも canary（記録に URL が出ないこと）。 */
const FACILITATOR_URL = `https://${CANARY.toLowerCase()}host.test/${CANARY}path`;
const ROUTE_ID = "md-diag-inbound";
const ROUTE_BINDING = [ROUTE_ID, "GET", `/v1/routes/${ROUTE_ID}/resource`].map(encodeURIComponent).join("|");
const BASE = "eip155:84532";
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ARC = "eip155:5042002";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SOL_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAY_TO = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
/** 大文字小文字の混じった値（cid の正規化を確かめる）。生の値は記録に現れてはならない。 */
const FROM = "0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1";
const NONCE = `0x${"aB".repeat(8)}${"c0".repeat(8)}${"De".repeat(8)}${"f1".repeat(8)}`;
const SIGNATURE = `0x${"7c".repeat(65)}`;
const EVM_TX = `0x${"ee".repeat(32)}`;
const SVM_SIG = getBase58Decoder().decode(new Uint8Array(64).fill(7));
const SVM_TRANSACTION = `AQ${CANARY}==`;

type Kind = X402FacilitatorKind | "svm";
type Stage = "verify" | "settle";
const KINDS: readonly Kind[] = ["x402", "circle", "svm"];

function networkOf(kind: Kind): string {
  return kind === "svm" ? SOL : kind === "circle" ? ARC : BASE;
}

function offerOf(kind: Kind): InboundOffer {
  const challengeNonce = NONCE.toLowerCase();
  if (kind === "svm") {
    return {
      scheme: "exact",
      network: SOL,
      asset: SOL_MINT,
      amount: "10000",
      payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      maxTimeoutSeconds: 40,
      extra: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", memo: challengeNonce, challengeNonce, expiresAt: 1_900_000_000, routeBinding: ROUTE_BINDING, fundsMoveOnCredential: false },
    };
  }
  return {
    scheme: "exact",
    network: networkOf(kind),
    asset: kind === "circle" ? ARC_USDC : BASE_USDC,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: kind === "circle" ? 30 : 120,
    extra: { name: "USDC", version: "2", challengeNonce, expiresAt: 1_900_000_000, routeBinding: ROUTE_BINDING, fundsMoveOnCredential: false, ...(kind === "circle" ? { assetTransferMethod: "eip3009" } : {}) },
  };
}

function credentialOf(kind: Kind, offer: InboundOffer, authorization: Record<string, unknown> = { from: FROM, to: PAY_TO, value: "10000", validAfter: "0", validBefore: "1900000000", nonce: NONCE }): PaymentCredential {
  if (kind === "svm") return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, transaction: SVM_TRANSACTION } };
  return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, authorization, signature: SIGNATURE } };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * fake の transport（要求の記録・応答の筋書き・transport の失敗）
 * ────────────────────────────────────────────────────────────────────────────── */

type Reply =
  | { readonly status: number; readonly text: string; readonly contentType?: string }
  | { readonly fail: TransportCode }
  | { readonly bodyFails: true; readonly status: number };

interface RequestLog {
  readonly method: string;
  readonly path: string;
  readonly bodyHash: string;
  readonly headerNames: readonly string[];
  readonly operation: string;
}

interface FakeTransport extends GuardedTransport {
  readonly log: RequestLog[];
  /** 送った本文（cid の照合に使う）。 */
  readonly bodies: string[];
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function fakeTransport(reply: (path: string) => Reply | Promise<Reply>, report: (event: TransportEvent) => void): FakeTransport {
  const log: RequestLog[] = [];
  const bodies: string[] = [];
  return {
    log,
    bodies,
    allowLoopback: false,
    boundsDns: true,
    // 本物の transport と同じ: headers の後の失敗（`TransportError` でないもの）は transport_failed の 1 行。
    report: (error: unknown, context: TransportContext) => {
      if (error instanceof TransportError) return;
      report({ code: "transport_failed", operation: context.operation, policy: "test-policy", ...(context.routeId === undefined ? {} : { routeId: context.routeId }) });
    },
    fetch: async (url: string | URL, init: RequestInit | undefined, context: TransportContext): Promise<Response> => {
      const target = new URL(String(url));
      const body = String(init?.body ?? "");
      bodies.push(body);
      log.push({ method: String(init?.method), path: target.pathname, bodyHash: sha(body), headerNames: Object.keys((init?.headers ?? {}) as Record<string, string>).sort(), operation: context.operation });
      const r = await reply(target.pathname);
      if ("fail" in r) {
        // 本物の transport と同じ順: 報告してから投げる。
        report({ code: r.fail, operation: context.operation, policy: "test-policy", ...(context.routeId === undefined ? {} : { routeId: context.routeId }) });
        throw new TransportError(r.fail, context, new Error(`${CANARY} ${FACILITATOR_URL}`));
      }
      if ("bodyFails" in r) {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error(`${CANARY} body read failed`));
          },
        });
        return new Response(stream, { status: r.status, headers: { "content-type": "application/json" } });
      }
      return new Response(r.text, { status: r.status, headers: { "content-type": r.contentType ?? "application/json" } });
    },
  } as FakeTransport;
}

/** 決まった売り手証明（比べられるように乱数を使わない）。`refuse` なら投げる。 */
function fakeProof(refuse: boolean): SellerProofCapability {
  return {
    network: ARC,
    address: PAY_TO,
    proofFor: async (purpose) => {
      if (refuse) throw new Error(`${CANARY} proof refused`);
      return `proof-${purpose}`;
    },
  };
}

interface Built {
  readonly rail: InboundRail;
  readonly transport: FakeTransport;
  readonly onDiagnostic: string[];
  readonly events: string[];
}

interface BuildOptions {
  readonly sink: DiagnosticsSink | undefined;
  readonly reply: (path: string) => Reply | Promise<Reply>;
  readonly refuseProof?: boolean;
  /** SVM の追跡の RPC（無ければ追跡しない）。 */
  readonly rpc?: { readonly transport: GuardedTransport };
  /** transport の報告の先（既定: 運用者の出口の写し＋診断）。 */
  readonly report?: (event: TransportEvent) => void;
}

function build(kind: Kind, options: BuildOptions): Built {
  const events: string[] = [];
  const report = options.report ?? diagnosticReportOf((event) => events.push(formatTransportEvent(event)), options.sink);
  const transport = fakeTransport(options.reply, report);
  const onDiagnostic: string[] = [];
  const diag = options.sink === undefined ? {} : { diagnostics: options.sink };
  let rail: InboundRail;
  if (kind === "svm") {
    rail = createX402SvmInbound({
      facilitatorUrl: FACILITATOR_URL,
      transport,
      policy: { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", destinationAta: "x", mint: SOL_MINT, decimals: 6, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      onDiagnostic: (code) => onDiagnostic.push(code),
      ...(options.rpc === undefined ? {} : { rpc: { url: "https://rpc.solana.test/", transport: options.rpc.transport } }),
      followUp: { totalMs: 1_000, intervalMs: 10, clock: (() => {
        let t = 0;
        return () => (t += 1);
      })(), sleep: async () => {} },
      ...diag,
    });
  } else if (kind === "circle") {
    rail = createX402Inbound({ kind: "circle", sellerProof: fakeProof(options.refuseProof === true), facilitatorUrl: FACILITATOR_URL, payTo: PAY_TO, transport, onDiagnostic: (code) => onDiagnostic.push(code), ...diag });
  } else {
    rail = createX402Inbound({ facilitatorUrl: FACILITATOR_URL, payTo: PAY_TO, transport, ...diag });
  }
  return { rail, transport, onDiagnostic, events };
}

type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly name: string; readonly code: string | undefined };

async function call(rail: InboundRail, stage: Stage, offer: InboundOffer, credential: PaymentCredential): Promise<Outcome> {
  try {
    const value = stage === "verify" ? await rail.verify(offer, credential, { routeId: ROUTE_ID }) : await rail.settle(offer, credential, { routeId: ROUTE_ID });
    return { ok: true, value };
  } catch (error) {
    return { ok: false, name: (error as Error).name, code: (error as { code?: string }).code };
  }
}

const json = (value: unknown): string => JSON.stringify(value);
const strip = (record: DiagRecord): Record<string, unknown> => {
  const { at: _at, seq: _seq, elapsedMs: _elapsed, ...rest } = record as unknown as Record<string, unknown>;
  return rest;
};

function recordsOf(sink: RecordingDiagnostics): DiagRecord[] {
  expect(sink.rejected(), "every pushed capture passes validateDiagRecord").toBe(0);
  return sink.records();
}

/** 記録の bytes に自由な文字列・生の値が無いこと（SR-R1・SR-R2）。 */
function expectNoFreeStrings(records: readonly DiagRecord[]): void {
  const text = json(records);
  for (const forbidden of [CANARY, CANARY.toLowerCase(), "host.test", FROM, FROM.toLowerCase(), NONCE, NONCE.toLowerCase(), SIGNATURE, SVM_TRANSACTION, "proof-", PAY_TO]) {
    expect(text.includes(forbidden), `diagnostics must not contain ${forbidden}`).toBe(false);
  }
  for (const record of records) {
    for (const key of Object.keys(record)) expect(DIAG_RECORD_KEYS as readonly string[]).toContain(key);
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * 場面の表（AC-R1 の受信）
 * ────────────────────────────────────────────────────────────────────────────── */

interface Case {
  readonly name: string;
  readonly kinds?: readonly Kind[];
  readonly stage: Stage;
  readonly reply: (kind: Kind) => Reply;
  readonly refuseProof?: boolean;
  /** 期待する結果（sink 無しの今の振る舞い）。 */
  readonly result: (kind: Kind) => Outcome;
  /** 期待する adapter の行（`undefined` は 0 行）。cid・network・facilitator・component・v は共通で足す。 */
  readonly record: ((kind: Kind) => Record<string, unknown>) | undefined;
  readonly requests: number;
}

const reason = (token: string, field: "invalidReason" | "errorReason") => ({ reasonField: field, reasonSource: "facilitator_body", reason: token, table: REASON_TABLE_VERSION });
const verifyToken = (kind: Kind) => (kind === "svm" ? "invalid_exact_svm_payload_missing_fee_payer" : "invalid_exact_evm_insufficient_balance");
const settleToken = (kind: Kind) => (kind === "svm" ? "invalid_exact_svm_transaction_failed" : "invalid_exact_evm_transaction_failed");
const settledTx = (kind: Kind) => (kind === "svm" ? SVM_SIG : EVM_TX);
const unknownSettle: Outcome = { ok: true, value: { outcome: "unknown", reason: "source_settle_unknown" } };
const rejectedSettle: Outcome = { ok: true, value: { outcome: "rejected", reason: "source_rejected" } };
/** kind `x402` の settle は 4xx・`success:false` を `rejected`、ほか（circle・SVM）は要求の後の失敗をすべて `unknown`。 */
const settleFailure = (kind: Kind, x402: Outcome): Outcome => (kind === "x402" ? x402 : unknownSettle);
const invalid: Outcome = { ok: true, value: { isValid: false } };

const CASES: readonly Case[] = [
  // verify
  { name: "verify 4xx（JSON の理由つき）", stage: "verify", reply: (k) => ({ status: 400, text: json({ isValid: false, invalidReason: verifyToken(k), invalidMessage: CANARY }) }), result: () => invalid, record: (k) => ({ stage: "source_verify", httpStatus: 400, response: "http_error", ...reason(verifyToken(k), "invalidReason") }), requests: 1 },
  { name: "verify 5xx（JSON でない本文）", stage: "verify", reply: () => ({ status: 503, text: `${CANARY} upstream broke`, contentType: "text/plain" }), result: () => invalid, record: () => ({ stage: "source_verify", httpStatus: 503, response: "http_error" }), requests: 1 },
  { name: "verify 200 で JSON でない", stage: "verify", reply: () => ({ status: 200, text: `<html>${CANARY}</html>`, contentType: "text/html" }), result: () => invalid, record: () => ({ stage: "source_verify", httpStatus: 200, response: "not_json" }), requests: 1 },
  { name: "verify 200 で形の違う JSON（配列）", stage: "verify", reply: () => ({ status: 200, text: json([CANARY]) }), result: () => invalid, record: () => ({ stage: "source_verify", httpStatus: 200, response: "not_json" }), requests: 1 },
  { name: "verify 表にある理由（invalidMessage は読まない）", stage: "verify", reply: (k) => ({ status: 200, text: json({ isValid: false, invalidReason: verifyToken(k), invalidMessage: CANARY, payer: FROM }) }), result: () => invalid, record: (k) => ({ stage: "source_verify", httpStatus: 200, response: "invalid", ...reason(verifyToken(k), "invalidReason") }), requests: 1 },
  { name: "verify 表に無い理由", stage: "verify", reply: () => ({ status: 200, text: json({ isValid: false, invalidReason: CANARY, invalidMessage: CANARY }) }), result: () => invalid, record: () => ({ stage: "source_verify", httpStatus: 200, response: "invalid", ...reason("unrecognized", "invalidReason") }), requests: 1 },
  { name: "verify 理由の欄なし", stage: "verify", reply: () => ({ status: 200, text: json({ isValid: false }) }), result: () => invalid, record: () => ({ stage: "source_verify", httpStatus: 200, response: "invalid", ...reason("absent", "invalidReason") }), requests: 1 },
  { name: "verify 理由が文字列でない", stage: "verify", reply: () => ({ status: 200, text: json({ isValid: false, invalidReason: { message: CANARY } }) }), result: () => invalid, record: () => ({ stage: "source_verify", httpStatus: 200, response: "invalid", ...reason("malformed", "invalidReason") }), requests: 1 },
  { name: "verify 成功", stage: "verify", reply: () => ({ status: 200, text: json({ isValid: true, payer: FROM }) }), result: () => ({ ok: true, value: { isValid: true } }), record: () => ({ stage: "source_verify", httpStatus: 200, response: "valid", ...reason("absent", "invalidReason") }), requests: 1 },
  { name: "verify upstream_timeout（adapter は記録しない）", stage: "verify", reply: () => ({ fail: "upstream_timeout" }), result: () => ({ ok: false, name: "TransportError", code: "upstream_timeout" }), record: undefined, requests: 1 },
  { name: "verify connect_failed（adapter は記録しない）", stage: "verify", reply: () => ({ fail: "connect_failed" }), result: () => ({ ok: false, name: "TransportError", code: "connect_failed" }), record: undefined, requests: 1 },
  { name: "verify 本文の読み取りの失敗（adapter は記録しない）", stage: "verify", reply: () => ({ bodyFails: true, status: 200 }), result: () => ({ ok: false, name: "Error", code: undefined }), record: undefined, requests: 1 },
  { name: "verify 売り手証明の拒否（要求 0 回）", kinds: ["circle"], stage: "verify", refuseProof: true, reply: () => ({ status: 200, text: json({ isValid: true }) }), result: () => invalid, record: () => ({ stage: "source_verify", response: "proof_refused" }), requests: 0 },
  // settle
  { name: "settle 4xx（JSON の理由つき）", stage: "settle", reply: (k) => ({ status: 400, text: json({ success: false, errorReason: settleToken(k), errorMessage: CANARY }) }), result: (k) => settleFailure(k, rejectedSettle), record: (k) => ({ stage: "source_settle", httpStatus: 400, response: "http_error", ...reason(settleToken(k), "errorReason") }), requests: 1 },
  { name: "settle 5xx（JSON でない本文）", stage: "settle", reply: () => ({ status: 502, text: `${CANARY} bad gateway`, contentType: "text/plain" }), result: () => unknownSettle, record: () => ({ stage: "source_settle", httpStatus: 502, response: "http_error" }), requests: 1 },
  { name: "settle 200 で JSON でない", stage: "settle", reply: () => ({ status: 200, text: `${CANARY}` }), result: () => unknownSettle, record: () => ({ stage: "source_settle", httpStatus: 200, response: "not_json" }), requests: 1 },
  { name: "settle 表にある理由（success:false、errorMessage は読まない）", stage: "settle", reply: (k) => ({ status: 200, text: json({ success: false, errorReason: settleToken(k), errorMessage: CANARY, network: networkOf(k) }) }), result: (k) => settleFailure(k, rejectedSettle), record: (k) => ({ stage: "source_settle", httpStatus: 200, response: "success_false", ...reason(settleToken(k), "errorReason") }), requests: 1 },
  { name: "settle 表に無い理由", stage: "settle", reply: () => ({ status: 200, text: json({ success: false, errorReason: CANARY, errorMessage: CANARY }) }), result: (k) => settleFailure(k, rejectedSettle), record: () => ({ stage: "source_settle", httpStatus: 200, response: "success_false", ...reason("unrecognized", "errorReason") }), requests: 1 },
  { name: "settle 200 で形の違う JSON（配列）", stage: "settle", reply: () => ({ status: 200, text: json([CANARY]) }), result: () => unknownSettle, record: () => ({ stage: "source_settle", httpStatus: 200, response: "not_json" }), requests: 1 },
  { name: "settle 200 で形の違う JSON（数）", stage: "settle", reply: () => ({ status: 200, text: "42" }), result: () => unknownSettle, record: () => ({ stage: "source_settle", httpStatus: 200, response: "not_json" }), requests: 1 },
  { name: "settle 200 で形の違う JSON（文字列）", stage: "settle", reply: () => ({ status: 200, text: json(CANARY) }), result: () => unknownSettle, record: () => ({ stage: "source_settle", httpStatus: 200, response: "not_json" }), requests: 1 },
  { name: "settle 理由が文字列でない", stage: "settle", reply: () => ({ status: 200, text: json({ success: false, errorReason: { message: CANARY } }) }), result: (k) => settleFailure(k, rejectedSettle), record: () => ({ stage: "source_settle", httpStatus: 200, response: "success_false", ...reason("malformed", "errorReason") }), requests: 1 },
  { name: "settle 理由が大きすぎる（R-1 の 8 KiB の上限 → malformed）", stage: "settle", reply: () => ({ status: 200, text: json({ success: false, errorReason: `${CANARY}${"x".repeat(5_000)}` }) }), result: (k) => settleFailure(k, rejectedSettle), record: () => ({ stage: "source_settle", httpStatus: 200, response: "success_false", ...reason("malformed", "errorReason") }), requests: 1 },
  { name: "settle 理由の欄なし", stage: "settle", reply: () => ({ status: 200, text: json({ success: false }) }), result: (k) => settleFailure(k, rejectedSettle), record: () => ({ stage: "source_settle", httpStatus: 200, response: "success_false", ...reason("absent", "errorReason") }), requests: 1 },
  { name: "settle network 違い", stage: "settle", reply: (k) => ({ status: 200, text: json({ success: true, network: "eip155:1", transaction: settledTx(k) }) }), result: () => unknownSettle, record: () => ({ stage: "source_settle", httpStatus: 200, response: "network_mismatch", ...reason("absent", "errorReason") }), requests: 1 },
  { name: "settle tx の形違い", stage: "settle", reply: (k) => ({ status: 200, text: json({ success: true, network: networkOf(k), transaction: k === "x402" ? "" : CANARY }) }), result: () => unknownSettle, record: () => ({ stage: "source_settle", httpStatus: 200, response: "tx_malformed", ...reason("absent", "errorReason") }), requests: 1 },
  { name: "settle 成功", stage: "settle", reply: (k) => ({ status: 200, text: json({ success: true, network: networkOf(k), transaction: settledTx(k), payer: FROM }) }), result: (k) => ({ ok: true, value: { outcome: "settled", txRef: settledTx(k) } }), record: () => ({ stage: "source_settle", httpStatus: 200, response: "ok", ...reason("absent", "errorReason") }), requests: 1 },
  { name: "settle upstream_timeout（adapter は記録しない）", stage: "settle", reply: () => ({ fail: "upstream_timeout" }), result: () => ({ ok: false, name: "TransportError", code: "upstream_timeout" }), record: undefined, requests: 1 },
  { name: "settle connect_failed（adapter は記録しない）", stage: "settle", reply: () => ({ fail: "connect_failed" }), result: () => ({ ok: false, name: "TransportError", code: "connect_failed" }), record: undefined, requests: 1 },
  { name: "settle 本文の読み取りの失敗（adapter は記録しない）", stage: "settle", reply: () => ({ bodyFails: true, status: 200 }), result: () => ({ ok: false, name: "Error", code: undefined }), record: undefined, requests: 1 },
  { name: "settle 売り手証明の拒否（要求 0 回、rejected）", kinds: ["circle"], stage: "settle", refuseProof: true, reply: () => ({ status: 200, text: "{}" }), result: () => rejectedSettle, record: () => ({ stage: "source_settle", response: "proof_refused" }), requests: 0 },
  {
    name: "settle Circle の 403 registration_required（結果は unknown、onDiagnostic も今どおり）",
    kinds: ["circle"],
    stage: "settle",
    reply: () => ({ status: 403, text: json({ error: "forbidden", errorReason: "registration_required", message: CANARY }) }),
    result: () => unknownSettle,
    record: () => ({ stage: "source_settle", httpStatus: 403, response: "http_error", ...reason("registration_required", "errorReason") }),
    requests: 1,
  },
];

const ROWS = CASES.flatMap((c) => (c.kinds ?? KINDS).map((kind) => [`${kind}: ${c.name}`, kind, c] as const));

interface Run {
  readonly outcome: Outcome;
  readonly log: readonly RequestLog[];
  readonly events: readonly string[];
  readonly onDiagnostic: readonly string[];
}

async function runCase(kind: Kind, c: Case, sink: DiagnosticsSink | undefined): Promise<Run & { readonly bodies: readonly string[] }> {
  const built = build(kind, { sink, reply: () => c.reply(kind), ...(c.refuseProof === undefined ? {} : { refuseProof: c.refuseProof }) });
  const offer = offerOf(kind);
  const outcome = await call(built.rail, c.stage, offer, credentialOf(kind, offer));
  return { outcome, log: [...built.transport.log], events: [...built.events], onDiagnostic: [...built.onDiagnostic], bodies: [...built.transport.bodies] };
}

const EXPECTED_EVM_CID = (kind: Kind) => diagCorrelationIdOf(networkOf(kind), kind === "circle" ? ARC_USDC : BASE_USDC, FROM, NONCE);

describe("AC-R1 受信: 段ごとに期待する 1 行と §8.2 の 3 通りの比較", () => {
  test.each(ROWS)("%s", async (_name, kind, c) => {
    const plain = await runCase(kind, c, undefined);
    expect(plain.outcome).toEqual(c.result(kind));
    expect(plain.log).toHaveLength(c.requests);

    const sink = recordingDiagnostics("router");
    const recorded = await runCase(kind, c, sink);
    const throwing = throwingDiagnostics();
    const thrown = await runCase(kind, c, throwing);
    // 結果・要求（method・path・本文の hash・header の名前・順序・回数）・運用者の出口・onDiagnostic が 3 通りで同じ。
    const comparable = (r: Run) => ({ outcome: r.outcome, log: r.log, events: r.events, onDiagnostic: r.onDiagnostic });
    expect(comparable(recorded)).toEqual(comparable(plain));
    expect(comparable(thrown)).toEqual(comparable(plain));
    if (c.name.includes("registration_required")) expect(plain.onDiagnostic).toEqual(["facilitator_trial_exhausted"]);

    const records = recordsOf(sink);
    expectNoFreeStrings(records);
    const adapterRows = records.filter((r) => r.stage === "source_verify" || r.stage === "source_settle");
    const cid = kind === "svm" ? {} : { cid: EXPECTED_EVM_CID(kind) };
    if (c.record === undefined) {
      expect(adapterRows).toEqual([]);
      // throw の経路: transport の出来事だけ（EVM は cid の scope の中なので cid が付く。SVM は scope が無く 0 行）。
      const fail = c.reply(kind);
      if ("fail" in fail || "bodyFails" in fail) {
        const op = c.stage === "verify" ? "facilitator_verify" : "facilitator_settle";
        const transport = "fail" in fail ? fail.fail : "transport_failed";
        expect(records.map(strip)).toEqual(kind === "svm" ? [] : [{ v: 1, component: "router", stage: "transport_event", transport, op, ...cid }]);
      }
      return;
    }
    const facilitator = kind === "svm" ? "x402" : kind;
    expect(adapterRows.map(strip)).toEqual([{ v: 1, component: "router", network: networkOf(kind), facilitator, ...cid, ...c.record(kind) }]);
    expect(records).toHaveLength(1);
    // 経過の時間: 要求を出したときだけ（fetch の前から本文を読み終えるまで）。
    if (c.requests > 0) expect(typeof adapterRows[0]!.elapsedMs).toBe("number");
    else expect(adapterRows[0]!.elapsedMs).toBeUndefined();
    expect(throwing.calls).toBe(c.requests > 0 || c.record !== undefined ? 1 : 0);
  });
});

describe("cid の入力（§5.2・§12.6）", () => {
  test("credential の authorization の形が違えば cid を書かない（記録は残る）、結果・要求は同じ", async () => {
    for (const authorization of [{ from: FROM, nonce: "0x1234" }, { from: "not-an-address", nonce: NONCE }, { nonce: NONCE }, "string"] as const) {
      const sink = recordingDiagnostics("router");
      const runs: Outcome[] = [];
      for (const s of [undefined, sink]) {
        const built = build("x402", { sink: s, reply: () => ({ status: 200, text: json({ isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance" }) }) });
        const offer = offerOf("x402");
        runs.push(await call(built.rail, "verify", offer, credentialOf("x402", offer, authorization as unknown as Record<string, unknown>)));
      }
      expect(runs[1]).toEqual(runs[0]);
      const records = recordsOf(sink);
      expect(records).toHaveLength(1);
      expect(records[0]!.cid).toBeUndefined();
      expect(records[0]!.response).toBe("invalid");
    }
  });

  test.each(["verify", "settle"] as const)("credential の getter が読むたびに違う値・2 回目から投げる: %s の cid は送った bytes の cid（credential を読み直さない）、結果・要求は sink 無しと同じ", async (stage) => {
    const offer = offerOf("x402");
    const NONCE_B = `0x${"0b".repeat(32)}`;
    const variants = [
      // 1 回目は nonce A、2 回目以降は nonce B（Codex R-3 #1 の再現）。
      (reads: number) => ({ from: FROM, nonce: reads === 1 ? NONCE : NONCE_B }),
      // 1 回目は値、2 回目以降は投げる。
      (reads: number) => {
        if (reads > 1) throw new Error(CANARY);
        return { from: FROM, nonce: NONCE };
      },
    ];
    for (const valueAt of variants) {
      const readsOf: number[] = [];
      const hostile = (): PaymentCredential => {
        let reads = 0;
        const payload = { challengeNonce: offer.extra.challengeNonce, signature: SIGNATURE } as Record<string, unknown>;
        Object.defineProperty(payload, "authorization", {
          enumerable: true,
          get() {
            reads += 1;
            readsOf.push(reads);
            return valueAt(reads);
          },
        });
        return { x402Version: 2, accepted: offer, payload: payload as PaymentCredential["payload"] };
      };
      const reply = (): Reply => ({ status: 200, text: json(stage === "verify" ? { isValid: true } : { success: true, network: BASE, transaction: EVM_TX }) });
      const plain = build("x402", { sink: undefined, reply });
      const before = await call(plain.rail, stage, offer, hostile());
      const plainReads = readsOf.length;
      const sink = recordingDiagnostics("router");
      const withSink = build("x402", { sink, reply });
      expect(await call(withSink.rail, stage, offer, hostile())).toEqual(before);
      expect(withSink.transport.log).toEqual(plain.transport.log);
      // credential の読み取りの回数も sink 無しと同じ（直列化の 1 回だけ）。
      expect(readsOf.length - plainReads).toBe(plainReads);
      const input = diagCidInputOf(JSON.parse(withSink.transport.bodies[0]!));
      expect(input).toBeDefined();
      expect(input!.nonce).toBe(NONCE);
      expect(recordsOf(sink).map((r) => r.cid)).toEqual([diagCorrelationIdOf(input!.network, input!.asset, input!.from, input!.nonce)]);
    }
  });

  test("adapter の cid は自前の facilitator の `diagCidInputOf` が送った本文から作る cid と同じ", async () => {
    for (const kind of ["x402", "circle"] as const) {
      for (const stage of ["verify", "settle"] as const) {
        const sink = recordingDiagnostics("router");
        const built = build(kind, { sink, reply: () => ({ status: 200, text: json(stage === "verify" ? { isValid: true } : { success: true, network: networkOf(kind), transaction: EVM_TX }) }) });
        const offer = offerOf(kind);
        await call(built.rail, stage, offer, credentialOf(kind, offer));
        const input = diagCidInputOf(JSON.parse(built.transport.bodies[0]!));
        expect(input).toBeDefined();
        const facilitatorCid = diagCorrelationIdOf(input!.network, input!.asset, input!.from, input!.nonce);
        expect(recordsOf(sink).map((r) => r.cid)).toEqual([facilitatorCid]);
      }
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * 自前の facilitator との実際の往復（R-5 の cid と同じ）
 * ────────────────────────────────────────────────────────────────────────────── */

const RH = "eip155:46630";
const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
const FACILITATOR_TOKEN = "diagTOKENcanary_0123456789abcdefABCDEF";
const PORT = 8611;
const NOW_MS = 1_800_000_000_000;

function fakeChainIo(): ChainIo {
  const GWEI = 1_000_000_000n;
  return {
    maxLogRange: 500n,
    maxFeePerGas: 10n * GWEI,
    gasCap: 10n ** 18n,
    maxSettleGas: DEFAULT_MAX_SETTLE_GAS[RH]!,
    reader: {
      authorizationState: async () => false,
      blockNumber: async () => 100n,
      blockTimestamp: async (n) => NOW_MS / 1000 - 100 + Number(n),
      authorizationUsedLogs: async () => [],
      receipt: async () => undefined,
      waitForReceipt: async () => undefined,
      feesPerGas: async () => ({ maxFeePerGas: GWEI, maxPriorityFeePerGas: 1n }),
      estimateTransferGas: async () => 100_000n,
    },
    writer: { address: "0x54633d372d7316435891EEBBaAB90861F8c1Dadc", transferWithAuthorization: async () => `0x${"ee".repeat(32)}` as Hex },
    // SDK の verify は残高不足を返す（応答は 200 の isValid:false、Router の記録と facilitator の記録が同じ cid で並ぶ）。
    verify: async () => ({ isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance", payer: FROM }),
  } as ChainIo;
}

describe("Router と自前の facilitator の往復（同じ authorization → 同じ cid）", () => {
  test("verify: Router の source_verify と facilitator の verify が同じ cid・同じ reason で並ぶ", async () => {
    const facilitatorSink = recordingDiagnostics("facilitator");
    const journal: FacilitatorJournal & { records: JournalRecord[] } = { records: [], load: async () => [], append: async (r) => void journal.records.push(r) };
    const timer: SetTimer = () => () => {};
    const facilitator = createEvmFacilitator({ networks: [RH], chains: new Map([[RH, fakeChainIo()]]), journal, payToAllowlist: [PAY_TO], clock: { now: () => NOW_MS }, timer, diagnostics: facilitatorSink });
    await facilitator.start();
    const guard = { token: FACILITATOR_TOKEN, port: () => PORT };
    const routerSink = recordingDiagnostics("router");
    const built = build("x402", {
      sink: routerSink,
      reply: async (path) => {
        const response = await facilitator.handle({ method: "POST", url: `/${FACILITATOR_TOKEN}/${path.split("/").pop()}`, headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" }, body: built.transport.bodies.at(-1)! }, guard);
        return { status: response.status, text: JSON.stringify(response.body) };
      },
    });
    const offer: InboundOffer = { ...offerOf("x402"), network: RH, asset: USDG, maxTimeoutSeconds: 60, extra: { ...offerOf("x402").extra, name: "Global Dollar", version: "1" } };
    const credential = credentialOf("x402", offer, { from: FROM, to: PAY_TO, value: "10000", validAfter: "0", validBefore: String(NOW_MS / 1000 + 60), nonce: NONCE });
    expect(await call(built.rail, "verify", offer, credential)).toEqual({ ok: true, value: { isValid: false } });
    const routerRows = recordsOf(routerSink);
    const facilitatorRows = recordsOf(facilitatorSink).filter((r) => r.stage === "verify");
    expect(routerRows).toHaveLength(1);
    expect(facilitatorRows).toHaveLength(1);
    const expectedCid = diagCorrelationIdOf(RH, USDG, FROM, NONCE);
    expect(routerRows[0]!.cid).toBe(expectedCid);
    expect(facilitatorRows[0]!.cid).toBe(expectedCid);
    expect(routerRows[0]!.reason).toBe(facilitatorRows[0]!.reason);
    expect(routerRows[0]!.reason).toBe("invalid_exact_evm_insufficient_balance");
    expect(routerRows[0]).toMatchObject({ stage: "source_verify", httpStatus: facilitatorRows[0]!.httpStatus, response: "invalid", network: RH, facilitator: "x402" });
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * 記録の位置（結果を作った後。SVM は追跡の後）
 * ────────────────────────────────────────────────────────────────────────────── */

describe("記録の位置", () => {
  test("SVM の settle: 署名つきの success:false → 追跡で settled。記録は追跡が終わった後に 1 回（push の時点で RPC の要求が済んでいる）", async () => {
    const rpcLog: string[] = [];
    let rpcAtEmit: number | undefined;
    const rpcTransport = fakeTransport(() => {
      rpcLog.push("getSignatureStatuses");
      return { status: 200, text: json({ jsonrpc: "2.0", id: 1, result: { value: [{ confirmationStatus: "confirmed", err: null }] } }) };
    }, () => {});
    const inner = recordingDiagnostics("router");
    const sink: DiagnosticsSink = {
      emit(capture) {
        rpcAtEmit = rpcLog.length;
        inner.emit(capture);
      },
    };
    const reply: Reply = { status: 200, text: json({ success: false, errorReason: "invalid_exact_svm_transaction_failed", network: SOL, transaction: SVM_SIG }) };
    const plainBuilt = build("svm", { sink: undefined, reply: () => reply, rpc: { transport: rpcTransport } });
    const offer = offerOf("svm");
    const before = await call(plainBuilt.rail, "settle", offer, credentialOf("svm", offer));
    expect(before).toEqual({ ok: true, value: { outcome: "settled", txRef: SVM_SIG } });
    rpcLog.length = 0;
    const built = build("svm", { sink, reply: () => reply, rpc: { transport: rpcTransport } });
    expect(await call(built.rail, "settle", offer, credentialOf("svm", offer))).toEqual(before);
    expect(rpcLog).toEqual(["getSignatureStatuses"]);
    expect(rpcAtEmit).toBe(1);
    expect(recordsOf(inner).map(strip)).toEqual([{ v: 1, component: "router", stage: "source_settle", network: SOL, facilitator: "x402", httpStatus: 200, response: "success_false", ...reason("invalid_exact_svm_transaction_failed", "errorReason") }]);
    expect(built.onDiagnostic).toEqual(["svm_settle_followed_up"]);
    // 投げる sink でも結果・RPC の要求・onDiagnostic は同じ。
    rpcLog.length = 0;
    const throwing = throwingDiagnostics();
    const thrownBuilt = build("svm", { sink: throwing, reply: () => reply, rpc: { transport: rpcTransport } });
    expect(await call(thrownBuilt.rail, "settle", offer, credentialOf("svm", offer))).toEqual(before);
    expect(rpcLog).toEqual(["getSignatureStatuses"]);
    expect(thrownBuilt.transport.log).toEqual(plainBuilt.transport.log);
    expect(thrownBuilt.onDiagnostic).toEqual(plainBuilt.onDiagnostic);
    expect(throwing.calls).toBe(1);
  });

  test("SVM の settle: 追跡が投げても（RPC の失敗の報告が投げる）facilitator の応答の記録は残り、例外は 3 通りで同じ", async () => {
    const reportFailure = new Error("follow-up report failed (test)");
    const rpcLog: string[] = [];
    const rpcTransport = fakeTransport(() => {
      rpcLog.push("getSignatureStatuses");
      return { fail: "upstream_timeout" };
    }, () => {
      throw reportFailure;
    });
    const reply: Reply = { status: 200, text: json({ success: false, errorReason: "invalid_exact_svm_transaction_failed", errorMessage: CANARY, network: SOL, transaction: SVM_SIG }) };
    const offer = offerOf("svm");
    const runWith = async (sink: DiagnosticsSink | undefined) => {
      rpcLog.length = 0;
      const built = build("svm", { sink, reply: () => reply, rpc: { transport: rpcTransport } });
      let caught: unknown;
      let value: unknown;
      try {
        value = await built.rail.settle(offer, credentialOf("svm", offer), { routeId: ROUTE_ID });
      } catch (error) {
        caught = error;
      }
      return { caught, value, log: [...built.transport.log], rpc: [...rpcLog], onDiagnostic: [...built.onDiagnostic], events: [...built.events] };
    };
    const plain = await runWith(undefined);
    // 元の例外がそのまま（同じ object）投げ直される。
    expect(plain.caught).toBe(reportFailure);
    expect(plain.value).toBeUndefined();
    expect(plain.rpc).toEqual(["getSignatureStatuses"]);
    const sink = recordingDiagnostics("router");
    const recorded = await runWith(sink);
    const throwing = throwingDiagnostics();
    const thrown = await runWith(throwing);
    for (const run of [recorded, thrown]) {
      expect(run.caught).toBe(reportFailure);
      expect({ ...run, caught: undefined }).toEqual({ ...plain, caught: undefined });
    }
    const records = recordsOf(sink);
    expectNoFreeStrings(records);
    expect(records.map(strip)).toEqual([{ v: 1, component: "router", stage: "source_settle", network: SOL, facilitator: "x402", httpStatus: 200, response: "success_false", ...reason("invalid_exact_svm_transaction_failed", "errorReason") }]);
    expect(typeof records[0]!.elapsedMs).toBe("number");
    expect(throwing.calls).toBe(1);
  });

  test("push の時点で facilitator の応答は読み終わっている（要求は 1 回、push は 1 回）", async () => {
    for (const kind of KINDS) {
      let requestsAtEmit: number | undefined;
      let transportRef: FakeTransport | undefined;
      const sink: DiagnosticsSink = {
        emit() {
          requestsAtEmit = transportRef?.log.length;
        },
      };
      const built = build(kind, { sink, reply: () => ({ status: 200, text: json({ isValid: false, invalidReason: "x" }) }) });
      transportRef = built.transport;
      const offer = offerOf(kind);
      await call(built.rail, "verify", offer, credentialOf(kind, offer));
      expect(requestsAtEmit).toBe(1);
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * core の中（R-2 の購入の scope）: 実際の adapter を fake の rail の verify・settle に差し込む
 * ────────────────────────────────────────────────────────────────────────────── */

interface CoreCase {
  readonly name: string;
  readonly verify: Reply;
  readonly settle?: Reply;
}

const CORE_CASES: readonly CoreCase[] = [
  { name: "verify upstream_timeout", verify: { fail: "upstream_timeout" } },
  { name: "verify connect_failed", verify: { fail: "connect_failed" } },
  { name: "verify 本文の読み取りの失敗", verify: { bodyFails: true, status: 200 } },
  { name: "verify 4xx の理由", verify: { status: 400, text: json({ isValid: false, invalidReason: "invalid_exact_evm_insufficient_balance", invalidMessage: CANARY }) } },
  { name: "settle upstream_timeout", verify: { status: 200, text: json({ isValid: true }) }, settle: { fail: "upstream_timeout" } },
  { name: "settle success:false", verify: { status: 200, text: json({ isValid: true }) }, settle: { status: 200, text: json({ success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: CANARY }) } },
  { name: "settle 成功", verify: { status: 200, text: json({ isValid: true }) }, settle: { status: 200, text: json({ success: true, network: "eip155:42431", transaction: EVM_TX }) } },
];

function coreScenario(c: CoreCase, sink: DiagnosticsSink | undefined): Scenario {
  return {
    name: `r3-${c.name.replace(/[^a-z0-9]+/gi, "-")}`,
    kind: "static",
    arrange: (r) => {
      // fake の rail の report（`diagnosticReportOf(stderr, sink)`）を実際の adapter の transport に渡す（`composeRails` と同じ包み）。
      const transport = fakeTransport((path) => (path.endsWith("/settle") ? (c.settle ?? { status: 500, text: "" }) : c.verify), r.inbound.report);
      const rail = createX402Inbound({ facilitatorUrl: FACILITATOR_URL, payTo: PAY_TO, transport, ...(sink === undefined ? {} : { diagnostics: sink }) });
      const inbound = r.inbound as unknown as {
        verify: (offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext) => Promise<{ isValid: boolean }>;
        settle: (offer: InboundOffer, credential: PaymentCredential, context?: InboundCallContext) => Promise<SettleResult>;
        credentialFor: (offer: InboundOffer) => PaymentCredential;
      };
      const fetches = (): string => stableJson(transport.log);
      inbound.verify = async (offer, credential, context) => {
        try {
          return await rail.verify(offer, credential, context);
        } finally {
          r.inbound.calls.push({ method: "verify", args: fetches() });
        }
      };
      inbound.settle = async (offer, credential, context) => {
        try {
          return await rail.settle(offer, credential, context);
        } finally {
          r.inbound.calls.push({ method: "settle", args: fetches() });
        }
      };
      inbound.credentialFor = (offer) => ({ x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, authorization: { from: FROM, nonce: NONCE }, signature: SIGNATURE } });
    },
  };
}

const comparableRun = (run: ScenarioRun) => ({ quote: run.quote, purchase: run.purchase, status: run.status, calls: run.calls, journal: run.journal, ledger: run.ledger, stderr: run.stderr });

describe("core の中: throw の経路は core の 1 行だけ・transport の出来事に cid、3 通りで購入・journal・要求・stderr が同じ", () => {
  test.each(CORE_CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const plain = await runScenario(coreScenario(c, undefined));
    const sink = recordingDiagnostics("router");
    const recorded = await runScenario(coreScenario(c, sink), { sink });
    const throwing = throwingDiagnostics();
    const thrown = await runScenario(coreScenario(c, throwing), { sink: throwing });
    expect(comparableRun(recorded)).toEqual(comparableRun(plain));
    expect(comparableRun(thrown)).toEqual(comparableRun(plain));

    const records = recordsOf(sink);
    expectNoFreeStrings(records);
    const cid = diagCorrelationIdOf("eip155:42431", "0x20c0000000000000000000000000000000000000", FROM, NONCE);
    const stage = c.settle === undefined ? "source_verify" : "source_settle";
    const reply = c.settle ?? c.verify;
    const rows = records.filter((r) => r.stage === stage);
    // 全部の行は購入の scope（paymentId・quoteHash・routeId）の中。
    for (const r of records) expect(r).toMatchObject({ paymentId: recorded.paymentId, routeId: STATIC_ROUTE });
    if ("fail" in reply || "bodyFails" in reply) {
      // adapter の行は無く、core の 1 行（transport の分類）だけ。transport の出来事は adapter の cid の scope の中。
      const transport = "fail" in reply ? reply.fail : "transport_failed";
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "threw", transport });
      expect(rows[0]!.httpStatus).toBeUndefined();
      expect(rows[0]!.cid).toBeUndefined();
      const events = records.filter((r) => r.stage === "transport_event");
      expect(events.map((e) => ({ transport: e.transport, cid: e.cid }))).toEqual([{ transport, cid }]);
    } else {
      // adapter の行（cid・httpStatus・response・reason。応答の直後）と core の行（outcome・code。購入の終わり）の 2 つ。
      expect(rows).toHaveLength(2);
      const [adapterRow, coreRow] = rows;
      expect(adapterRow).toMatchObject({ cid, httpStatus: (reply as { status: number }).status, facilitator: "x402", network: "eip155:42431" });
      expect(adapterRow!.response).toBeDefined();
      expect(coreRow!.httpStatus).toBeUndefined();
      expect(coreRow!.outcome).toBeDefined();
    }
  });
});
