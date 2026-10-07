/**
 * SVM 受信の settle の応答の後の期限つきの追跡（multirail 設計 §5.8、D-9。タスク T11）。**無課金・Linux で受け入れ**。
 * facilitator は本物の `@x402/svm` の facilitator クラス（fixture の signer で confirm の timeout を再現 = `settlement_pending` と署名）、
 * RPC は loopback の fixture（`getSignatureStatuses` の応答の列）。transport は本番の方針。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { address, generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { createX402SvmInbound, SVM_SETTLE_FOLLOW_UP_DEFAULTS, svmFollowUpRequestTimeoutOf, svmFollowUpSignatureOf, svmSettleFollowUpOf, svmSignatureStatusOf, type SvmInboundPolicy } from "../../src/adapters/inbound/x402-svm.js";
import { startSink } from "../fixtures/circle-facilitator.js";
import { resolveSvmInboundPolicy } from "../../src/adapters/inbound/x402-svm-startup.js";
import { createGuardedTransport, type GuardedTransport } from "../../src/net/guarded-fetch.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import { dialTo, FIXTURE_PUBLIC_ADDRESS, publicLookup } from "../fixtures/dynamic/dial.js";
import { startSolanaRpc, type SolanaRpcFixture, type SolanaRpcState } from "../fixtures/solana-rpc.js";
import { startSvmFacilitator, type SvmFacilitator } from "../fixtures/svm-facilitator.js";
import { createSvmTestPayer, type SvmTestPayer } from "../fixtures/svm-payer.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const FAC_HOST = "facilitator.provider.test";
const RPC_HOST = "rpc.provider.test";
const ROUTE_ID = "md-sol-inbound";
const ROUTE_BINDING = [ROUTE_ID, "GET", `/v1/routes/${ROUTE_ID}/resource`].map(encodeURIComponent).join("|");

let TLS: TlsMaterial;
let owner: string;
let ata: string;
let payer: SvmTestPayer;
beforeAll(async () => {
  TLS = generateTestTls();
  const keypair = await generateKeyPairSigner();
  owner = String(keypair.address);
  ata = String((await findAssociatedTokenPda({ mint: address(MINT), owner: keypair.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
  payer = await createSvmTestPayer(MINT);
});
afterAll(() => TLS.cleanup());

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

function transportTo(routes: Record<string, number>, stuck: ReadonlySet<string> = new Set()): GuardedTransport {
  return createGuardedTransport({
    allowLoopback: false,
    report: () => {},
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: (hostname, options, callback) => {
      if (stuck.has(hostname)) return; // 名前解決が永遠に答えない
      publicLookup()(hostname, options, callback);
    },
    dialForTest: dialTo(routes),
    dns: { timeoutMs: 3_000, maxInFlight: 4 },
  });
}

type Rail = ReturnType<typeof createX402SvmInbound>;
interface Booted { fac: SvmFacilitator; rpc: SolanaRpcFixture; rail: Rail; policy: SvmInboundPolicy; diagnostics: string[] }

/** 起動時の検査で policy を固定してから adapter を組む（本番と同じ順）。追跡の RPC は起動時の検査と同じ transport。 */
type FollowUpOptions = NonNullable<Parameters<typeof createX402SvmInbound>[0]["followUp"]>;

/** 決定的な時計: `sleep` が時計を進める。`jumpOnReadMs` は `clock()` を読むたびに進める量（遅い処理の再現）。 */
function fakeTime(options: { jumpOnReadMs?: number } = {}): { followUp: Pick<FollowUpOptions, "clock" | "sleep">; now: () => number; sleeps: number[] } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    followUp: {
      clock: () => { t += options.jumpOnReadMs ?? 0; return t; },
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
    },
    now: () => t,
    sleeps,
  };
}

async function boot(options: { followUp?: FollowUpOptions; withRpc?: boolean; stuckRpc?: boolean; extraRoutes?: Record<string, number> } = {}): Promise<Booted> {
  const fac = await startSvmFacilitator(TLS, SOL, undefined, FAC_HOST);
  closers.push(fac.close);
  const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, tls: TLS, ata: { address: ata, owner } });
  closers.push(rpc.close);
  const transport = transportTo({ [FAC_HOST]: fac.port, [RPC_HOST]: rpc.port, ...(options.extraRoutes ?? {}) });
  const policy = await resolveSvmInboundPolicy({ network: SOL, facilitatorUrl: `https://${FAC_HOST}`, rpcUrl: `https://${RPC_HOST}`, payTo: owner, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS, transport });
  const diagnostics: string[] = [];
  const rpcTransport = options.stuckRpc === true ? transportTo({ [FAC_HOST]: fac.port, [RPC_HOST]: rpc.port, ...(options.extraRoutes ?? {}) }, new Set([RPC_HOST])) : transport;
  const rail = createX402SvmInbound({
    facilitatorUrl: `https://${FAC_HOST}`,
    transport,
    policy,
    ...(options.withRpc === false ? {} : { rpc: { url: `https://${RPC_HOST}`, transport: rpcTransport } }),
    followUp: options.followUp ?? { totalMs: 1_500, intervalMs: 100 },
    onDiagnostic: (code) => diagnostics.push(code),
  });
  return { fac, rpc, rail, policy, diagnostics };
}

async function issue(rail: Rail): Promise<InboundOffer> {
  return rail.createOffer({ routeId: ROUTE_ID, amount: "10000", asset: MINT, network: SOL, routeBinding: ROUTE_BINDING, nowMs: Date.now() });
}

async function credentialFor(policy: SvmInboundPolicy, offer: InboundOffer): Promise<PaymentCredential> {
  return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, transaction: await payer.build(policy, offer.amount, offer.extra["memo"] as string) } };
}

/** 追跡の RPC の要求（起動時の `getAccountInfo` を除く）。 */
function followUpCalls(rpc: SolanaRpcFixture): { method: string; params: unknown }[] {
  return rpc.calls.filter((c) => c.method !== "getAccountInfo");
}

async function settleAfterTimeout(b: Booted, statuses: SolanaRpcState["signatureStatuses"]): Promise<{ result: Awaited<ReturnType<Rail["settle"]>>; elapsedMs: number; signature: string }> {
  b.fac.state.confirm = "timeout";
  b.rpc.state.signatureStatuses = statuses;
  const offer = await issue(b.rail);
  const credential = await credentialFor(b.policy, offer);
  expect(await b.rail.verify(offer, credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
  const started = Date.now();
  const result = await b.rail.settle(offer, credential, { routeId: ROUTE_ID });
  const signature = String((b.fac.seen.lastSettle as { transaction?: unknown })?.transaction);
  return { result, elapsedMs: Date.now() - started, signature };
}

describe("追跡の既定と判定（純粋関数）", () => {
  it("既定は完了の期限 15 秒・間隔 2 秒・要求の期限 10 秒。0 以下は組めない", () => {
    expect(SVM_SETTLE_FOLLOW_UP_DEFAULTS).toEqual({ totalMs: 15_000, intervalMs: 2_000, requestTimeoutMs: 10_000 });
    expect(svmSettleFollowUpOf({})).toEqual({ totalMs: 15_000, intervalMs: 2_000, requestTimeoutMs: 10_000 });
    expect(svmSettleFollowUpOf({ followUp: { totalMs: 1_000, intervalMs: 100 } })).toEqual({ totalMs: 1_000, intervalMs: 100, requestTimeoutMs: 1_000 });
    expect(() => svmSettleFollowUpOf({ followUp: { totalMs: 0 } })).toThrow(/must be positive/);
    expect(() => svmSettleFollowUpOf({ followUp: { intervalMs: -1 } })).toThrow(/must be positive/);
    // 1 要求の期限は「要求ごとの上限（10 秒）」と「完了の期限までの残り」の小さい方（残りが上限より大きくても 10 秒で切る）。
    expect(svmFollowUpRequestTimeoutOf(30_000)).toBe(10_000);
    expect(svmFollowUpRequestTimeoutOf(4_000)).toBe(4_000);
    expect(svmFollowUpRequestTimeoutOf(0)).toBe(0);
    expect(svmFollowUpRequestTimeoutOf(-5)).toBe(0);
    expect(svmFollowUpRequestTimeoutOf(700, 500)).toBe(500);
    // 単調時計の残りは小数: 整数に切り下げる（`AbortSignal.timeout` は整数しか受け付けない。小数のままだと要求が RangeError で全部失敗した）。
    expect(svmFollowUpRequestTimeoutOf(1499.995)).toBe(1499);
    expect(svmFollowUpRequestTimeoutOf(0.5)).toBe(0);
    expect(Number.isInteger(svmFollowUpRequestTimeoutOf(12_345.678))).toBe(true);
  });

  it("追跡に入る条件: JSON object・署名の形・network 一致。HTTP status は見ない", () => {
    const sig = getBase58Decoder().decode(new Uint8Array(64).fill(9));
    expect(svmFollowUpSignatureOf({ success: false, transaction: sig, network: SOL }, { network: SOL })).toBe(sig);
    expect(svmFollowUpSignatureOf({ success: true, transaction: sig, network: SOL }, { network: SOL })).toBe(sig);
    expect(svmFollowUpSignatureOf({ success: false, transaction: "", network: SOL }, { network: SOL })).toBeUndefined();
    expect(svmFollowUpSignatureOf({ success: false, transaction: `0x${"ab".repeat(32)}`, network: SOL }, { network: SOL })).toBeUndefined();
    expect(svmFollowUpSignatureOf({ success: false, transaction: getBase58Decoder().decode(new Uint8Array(63).fill(7)), network: SOL }, { network: SOL })).toBeUndefined();
    expect(svmFollowUpSignatureOf({ success: false, transaction: sig }, { network: SOL })).toBeUndefined();
    expect(svmFollowUpSignatureOf({ success: false, transaction: sig, network: "solana:other" }, { network: SOL })).toBeUndefined();
    expect(svmFollowUpSignatureOf([sig], { network: SOL })).toBeUndefined();
    expect(svmFollowUpSignatureOf("text", { network: SOL })).toBeUndefined();
  });

  it("status の判定: 形の正しい status だけ。err 無しの confirmed/finalized → settled、err あり → failed、それ以外 → pending", () => {
    const wrap = (entry: unknown) => ({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: [entry] } });
    expect(svmSignatureStatusOf(wrap({ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }))).toBe("settled");
    expect(svmSignatureStatusOf(wrap({ slot: 1, confirmations: null, err: null, confirmationStatus: "finalized" }))).toBe("settled");
    expect(svmSignatureStatusOf(wrap({ slot: 1, confirmations: 0, err: null, confirmationStatus: "processed" }))).toBe("pending");
    expect(svmSignatureStatusOf(wrap({ slot: 1, confirmations: 0, err: { InstructionError: [2, "Custom"] }, confirmationStatus: "processed" }))).toBe("failed");
    // err と confirmed の組: err が優先（確定度の検査が変異を隠さない）。
    expect(svmSignatureStatusOf(wrap({ slot: 1, confirmations: 1, err: { InstructionError: [2, "Custom"] }, confirmationStatus: "confirmed" }))).toBe("failed");
    // 形の違う status は pending（failed にしない）。
    expect(svmSignatureStatusOf(wrap({}))).toBe("pending");
    expect(svmSignatureStatusOf(wrap({ confirmationStatus: "confirmed" }))).toBe("pending");
    expect(svmSignatureStatusOf(wrap({ err: null, confirmationStatus: "done" }))).toBe("pending");
    expect(svmSignatureStatusOf(wrap(null))).toBe("pending");
    expect(svmSignatureStatusOf({ result: { value: "x" } })).toBe("pending");
    expect(svmSignatureStatusOf({ error: { code: -32601 } })).toBe("pending");
    expect(svmSignatureStatusOf(undefined)).toBe("pending");
  });
});

describe("追跡（facilitator の confirm の timeout → settlement_pending と署名）", () => {
  it("列 [null, null, confirmed] → settled（txRef = 応答の署名）、要求はちょうど 3、params は固定、診断 1 回", async () => {
    const b = await boot();
    const { result, signature } = await settleAfterTimeout(b, ["null", "null", "confirmed"]);
    expect((b.fac.seen.lastSettle as { success: boolean; errorReason: string }).success).toBe(false);
    expect((b.fac.seen.lastSettle as { errorReason: string }).errorReason).toBe("settlement_pending");
    expect(result).toEqual({ outcome: "settled", txRef: signature });
    const calls = followUpCalls(b.rpc);
    expect(calls.map((c) => c.method)).toEqual(["getSignatureStatuses", "getSignatureStatuses", "getSignatureStatuses"]);
    for (const c of calls) expect(c.params).toEqual([[signature], { searchTransactionHistory: true }]);
    expect(b.diagnostics).toEqual(["svm_settle_followed_up"]);
    expect(b.fac.seen.settleCalls).toBe(1);
  });

  it("finalized が最初から → settled、要求 1 回。処理済み（processed）だけが続く → 完了の期限で unknown、要求は ⌈total/interval⌉+1 以下", async () => {
    const b = await boot();
    const first = await settleAfterTimeout(b, ["finalized"]);
    expect(first.result).toEqual({ outcome: "settled", txRef: first.signature });
    expect(followUpCalls(b.rpc)).toHaveLength(1);
    // 決定的な時計（sleep が時計を進める）: 要求は t = 0・500・1000 の**ちょうど 3 回**、待ちは 500・500・200（残りで切る）、期限で unknown。
    const time = fakeTime();
    const c = await boot({ followUp: { totalMs: 1_200, intervalMs: 500, ...time.followUp } });
    const pending = await settleAfterTimeout(c, ["processed"]);
    expect(pending.result).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(followUpCalls(c.rpc)).toHaveLength(3);
    expect(time.sleeps).toEqual([500, 500, 200]);
    expect(time.now()).toBe(1_200);
    expect(c.diagnostics).toEqual([]);
    // 実時間でも完了の期限の内側で終わる（回数は上限以下）。
    const real = await boot({ followUp: { totalMs: 1_200, intervalMs: 500 } });
    const measured = await settleAfterTimeout(real, ["processed"]);
    expect(measured.result).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(measured.elapsedMs).toBeGreaterThanOrEqual(1_100);
    expect(measured.elapsedMs).toBeLessThan(2_500);
    expect(followUpCalls(real.rpc).length).toBeLessThanOrEqual(Math.ceil(1_200 / 500) + 1);
  });

  it("応答が confirmed でも、読み終えた時点で完了の期限を過ぎていれば settled にしない（要求の期限は取り消しの予約で、続きの時刻は保証しない）", async () => {
    // clock() を読むたびに 700 ms 進む: 要求前の検査 t=700（残り 500）、応答後の検査 t=1400 > 期限 1200 → 打ち切り。
    const time = fakeTime({ jumpOnReadMs: 700 });
    const b = await boot({ followUp: { totalMs: 1_200, intervalMs: 500, ...time.followUp } });
    const { result } = await settleAfterTimeout(b, ["confirmed"]);
    expect(result).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(followUpCalls(b.rpc)).toHaveLength(1);
    expect(b.diagnostics).toEqual([]);
  });

  it("RPC が redirect を返しても追わない（redirect 先には接続 0）→ 期限で unknown", async () => {
    const sink = await startSink(TLS);
    closers.push(sink.close);
    const SINK_HOST = "static.provider.test";
    const b = await boot({ followUp: { totalMs: 500, intervalMs: 100 }, extraRoutes: { [SINK_HOST]: sink.port } });
    b.rpc.state.reply = "redirect";
    b.rpc.state.redirectTo = `https://${SINK_HOST}/`;
    const { result, elapsedMs } = await settleAfterTimeout(b, ["confirmed"]);
    expect(result).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(elapsedMs).toBeLessThan(2_000);
    expect(followUpCalls(b.rpc).length).toBeGreaterThanOrEqual(1);
    expect(sink.connections()).toBe(0);
  });

  it("err（processed・confirmed のどちらと組でも）→ 1 回で打ち切って unknown。形の違う status（{}、err の欄無し）は再度 → [{}, confirmed] は settled", async () => {
    for (const kind of ["err", "err-confirmed"] as const) {
      const b = await boot();
      const { result, elapsedMs } = await settleAfterTimeout(b, [kind]);
      expect(result).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
      expect(followUpCalls(b.rpc)).toHaveLength(1);
      expect(elapsedMs).toBeLessThan(1_000);
    }
    const c = await boot();
    const recovered = await settleAfterTimeout(c, ["empty", "confirmed"]);
    expect(recovered.result).toEqual({ outcome: "settled", txRef: recovered.signature });
    expect(followUpCalls(c.rpc)).toHaveLength(2);
    const d = await boot();
    const noErrKey = await settleAfterTimeout(d, ["no-err-key", "confirmed"]);
    expect(noErrKey.result).toEqual({ outcome: "settled", txRef: noErrKey.signature });
    expect(followUpCalls(d.rpc)).toHaveLength(2);
  });

  it("署名の無い失敗（send の失敗、transaction 空）・形違いの署名・network 無し／違い → 追跡せず unknown（RPC 0）。形どおりの成功 → RPC 0", async () => {
    const sendFail = await boot();
    sendFail.fac.state.send = "fail";
    sendFail.rpc.state.signatureStatuses = ["confirmed"];
    const offer = await issue(sendFail.rail);
    const credential = await credentialFor(sendFail.policy, offer);
    expect(await sendFail.rail.settle(offer, credential, { routeId: ROUTE_ID })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect((sendFail.fac.seen.lastSettle as { transaction: string }).transaction).toBe("");
    expect(followUpCalls(sendFail.rpc)).toHaveLength(0);

    const rows: [string, (body: Record<string, unknown>) => Record<string, unknown>][] = [
      ["base58 でない署名", (body) => ({ ...body, success: false, transaction: `0x${"ab".repeat(32)}` })],
      ["base58 だが 63 バイト", (body) => ({ ...body, success: false, transaction: getBase58Decoder().decode(new Uint8Array(63).fill(7)) })],
      ["network が無い", (body) => { const { network: _n, ...rest } = body; return { ...rest, success: false }; }],
      ["network が違う", (body) => ({ ...body, success: false, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })],
    ];
    for (const [name, mutate] of rows) {
      const b = await boot();
      b.fac.state.confirm = "timeout";
      b.fac.state.settleOverride = (body) => ({ status: 200, body: mutate(body) });
      b.rpc.state.signatureStatuses = ["confirmed"];
      const o = await issue(b.rail);
      const c = await credentialFor(b.policy, o);
      expect(await b.rail.settle(o, c, { routeId: ROUTE_ID }), name).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
      expect(followUpCalls(b.rpc), name).toHaveLength(0);
    }

    const ok = await boot();
    ok.rpc.state.signatureStatuses = ["confirmed"];
    const o = await issue(ok.rail);
    const c = await credentialFor(ok.policy, o);
    const settled = await ok.rail.settle(o, c, { routeId: ROUTE_ID });
    expect(settled.outcome).toBe("settled");
    expect(followUpCalls(ok.rpc)).toHaveLength(0);
    expect(ok.diagnostics).toEqual([]);
  });

  it("署名を含む HTTP 500・400 の失敗も追跡に入る（本文が条件を満たすとき）", async () => {
    for (const status of [500, 400]) {
      const b = await boot();
      b.fac.state.confirm = "timeout";
      b.fac.state.settleOverride = (body) => ({ status, body });
      b.rpc.state.signatureStatuses = ["confirmed"];
      const offer = await issue(b.rail);
      const credential = await credentialFor(b.policy, offer);
      const result = await b.rail.settle(offer, credential, { routeId: ROUTE_ID });
      expect(result, String(status)).toEqual({ outcome: "settled", txRef: (b.fac.seen.lastSettle as { transaction: string }).transaction });
      expect(followUpCalls(b.rpc), String(status)).toHaveLength(1);
    }
  });

  it("RPC の失敗（HTTP 500・JSON でない・64 KiB 超・遅延）は期限の内側で unknown。getSignatureStatuses 以外の method は呼ばない", async () => {
    for (const reply of ["error", "malformed", "huge"] as const) {
      const b = await boot({ followUp: { totalMs: 700, intervalMs: 100 } });
      b.rpc.state.reply = reply;
      const { result, elapsedMs } = await settleAfterTimeout(b, ["confirmed"]);
      expect(result, reply).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
      expect(elapsedMs, reply).toBeLessThan(2_000);
      expect(followUpCalls(b.rpc).length, reply).toBeGreaterThanOrEqual(2);
      expect(new Set(b.rpc.calls.map((c) => c.method))).toEqual(new Set(["getAccountInfo", "getSignatureStatuses"]));
    }
    // 応答が遅い: 1 要求の期限は残り時間で切られ、全体は完了の期限で終わる。
    const slow = await boot({ followUp: { totalMs: 600, intervalMs: 100 } });
    slow.rpc.state.delayMs = 5_000;
    const { result, elapsedMs } = await settleAfterTimeout(slow, ["confirmed"]);
    expect(result).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(elapsedMs).toBeLessThan(1_500);
  }, 30_000);

  it("RPC の名前解決が止まる → DNS の期限（3 秒）か完了の期限の早い方で unknown。rpc を渡さない構成では追跡せず unknown（RPC 0）", async () => {
    const stuck = await boot({ stuckRpc: true, followUp: { totalMs: 1_000, intervalMs: 100 } });
    const { result, elapsedMs } = await settleAfterTimeout(stuck, ["confirmed"]);
    expect(result).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    // 要求の期限（残り時間）が名前解決にも効くので、DNS の期限（3 秒）を待たずに完了の期限（1 秒）で終わる。
    expect(elapsedMs).toBeLessThan(2_000);
    expect(followUpCalls(stuck.rpc)).toHaveLength(0);
    const none = await boot({ withRpc: false });
    const plain = await settleAfterTimeout(none, ["confirmed"]);
    expect(plain.result).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(followUpCalls(none.rpc)).toHaveLength(0);
    expect(plain.elapsedMs).toBeLessThan(1_000);
  }, 20_000);
});
