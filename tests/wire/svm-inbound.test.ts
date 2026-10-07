/**
 * SVM 受信 adapter（multirail 設計 §5.1・§5.5・§6。FR-19・FR-20。タスク T4-c）。**無課金・Linux で受け入れ**。
 * facilitator は loopback（TLS、プロセス内）で、verify・settle の判定は**本物の `@x402/svm` の facilitator クラス**。
 * transport は本番の方針（loopback 不可・名前解決の fixture・`dialForTest`）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { address, generateKeyPairSigner } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { createX402SvmInbound, isSvmSignature, SVM_DEFAULT_WIRE_TIMEOUT_SECONDS, SVM_RESPONSE_MAX_BYTES, type SvmInboundPolicy } from "../../src/adapters/inbound/x402-svm.js";
import { resolveSvmInboundPolicy } from "../../src/adapters/inbound/x402-svm-startup.js";
import { createGuardedTransport, type GuardedTransport } from "../../src/net/guarded-fetch.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { startSolanaRpc } from "../fixtures/solana-rpc.js";
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

function transportTo(routes: Record<string, number>): GuardedTransport {
  return createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup(), dialForTest: dialTo(routes), dns: { timeoutMs: 3_000, maxInFlight: 4 } });
}

/** 起動時の検査（T4-b）で policy を固定してから adapter を組む（本番と同じ順）。 */
async function boot(extra: Partial<Parameters<typeof createX402SvmInbound>[0]> = {}): Promise<{ fac: SvmFacilitator; rail: ReturnType<typeof createX402SvmInbound>; policy: SvmInboundPolicy; transport: GuardedTransport }> {
  const fac = await startSvmFacilitator(TLS, SOL, undefined, FAC_HOST);
  closers.push(fac.close);
  const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, tls: TLS, ata: { address: ata, owner } });
  closers.push(rpc.close);
  const transport = transportTo({ [FAC_HOST]: fac.port, [RPC_HOST]: rpc.port });
  const policy = await resolveSvmInboundPolicy({ network: SOL, facilitatorUrl: `https://${FAC_HOST}`, rpcUrl: `https://${RPC_HOST}`, payTo: owner, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS, transport });
  const rail = createX402SvmInbound({ facilitatorUrl: `https://${FAC_HOST}`, transport, policy, ...extra });
  // 起動後の要求の回数を数えるために、起動時の分を差し引く基準を持つ。
  return { fac, rail, policy, transport };
}

async function issue(rail: ReturnType<typeof createX402SvmInbound>, amount = "10000"): Promise<InboundOffer> {
  return rail.createOffer({ routeId: ROUTE_ID, amount, asset: MINT, network: SOL, routeBinding: ROUTE_BINDING, nowMs: Date.now() });
}

async function credentialFor(policy: SvmInboundPolicy, offer: InboundOffer, accepted: Record<string, unknown> = {}): Promise<PaymentCredential> {
  return { x402Version: 2, accepted: { ...offer, ...accepted } as InboundOffer, payload: { challengeNonce: offer.extra.challengeNonce, transaction: await payer.build(policy, offer.amount, offer.extra["memo"] as string) } };
}

describe("SVM 受信: offer と preflight", () => {
  it("offer: payTo は owner、feePayer と memo（= nonce）、wire 40 秒、有効期間 120 秒、fundsMoveOnCredential false。固定した mint 以外には出さない", async () => {
    const { rail, policy } = await boot();
    const now = Date.now();
    const offer = await rail.createOffer({ routeId: ROUTE_ID, amount: "10000", asset: MINT, network: SOL, routeBinding: ROUTE_BINDING, nowMs: now });
    expect(offer.payTo).toBe(owner);
    expect(offer.extra["feePayer"]).toBe(policy.feePayer);
    expect(offer.extra["memo"]).toBe(offer.extra.challengeNonce);
    expect(offer.extra.challengeNonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(offer.maxTimeoutSeconds).toBe(SVM_DEFAULT_WIRE_TIMEOUT_SECONDS);
    expect(offer.extra.expiresAt).toBe(Math.floor(now / 1000) + 120);
    expect(offer.extra["fundsMoveOnCredential"]).toBe(false);
    await expect(rail.createOffer({ routeId: ROUTE_ID, amount: "1", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", network: SOL, routeBinding: ROUTE_BINDING, nowMs: now })).rejects.toThrow(/fixed mint/);
    const second = await issue(rail);
    expect(second.extra.challengeNonce).not.toBe(offer.extra.challengeNonce);
  });

  it("preflight は同期で、正しい credential を通し、別の quote の transaction は nonce_mismatch", async () => {
    const { rail, policy } = await boot();
    const a = await issue(rail);
    const b = await issue(rail);
    const ca = await credentialFor(policy, a);
    expect(rail.preflight(a, ca, Date.now())).toEqual({ ok: true });
    // a の transaction を b の quote に出す（challengeNonce は b のものに書き換える）。
    expect(rail.preflight(b, { ...ca, accepted: b, payload: { ...ca.payload, challengeNonce: b.extra.challengeNonce } }, Date.now())).toEqual({ ok: false, reason: "nonce_mismatch" });
  });
});

describe("SVM 受信: verify・settle（本物の facilitator の論理）", () => {
  it("verify → settle が通り、txRef は 64 バイトの signature。payload に challengeNonce は無く、requirements は offer から。要求は各 1 回、quote・purchase 中に RPC・/supported へ出ない", async () => {
    const { fac, rail, policy } = await boot();
    const supportedBefore = fac.seen.supportedCalls;
    const offer = await issue(rail);
    const credential = await credentialFor(policy, offer);
    expect(await rail.verify(offer, credential)).toEqual({ isValid: true });
    const settled = await rail.settle(offer, credential);
    expect(settled.outcome).toBe("settled");
    expect(isSvmSignature((settled as { txRef: string }).txRef)).toBe(true);
    expect(fac.seen.verifyCalls).toBe(1);
    expect(fac.seen.settleCalls).toBe(1);
    expect(fac.seen.simulateCalls).toBe(2);
    expect(fac.seen.sendCalls).toBe(1);
    expect(fac.seen.supportedCalls).toBe(supportedBefore);
    const payload = fac.seen.lastPayload as Record<string, unknown>;
    expect(Object.keys(payload["payload"] as Record<string, unknown>)).toEqual(["transaction"]);
    const requirements = fac.seen.lastRequirements as Record<string, unknown>;
    expect(requirements["payTo"]).toBe(owner);
    expect((requirements["extra"] as Record<string, unknown>)["feePayer"]).toBe(policy.feePayer);
    expect((requirements["extra"] as Record<string, unknown>)["memo"]).toBe(offer.extra.challengeNonce);
    expect(requirements["maxTimeoutSeconds"]).toBe(SVM_DEFAULT_WIRE_TIMEOUT_SECONDS);
  });

  it("verify が false（simulate の失敗）なら理由を転送しない", async () => {
    const { fac, rail, policy } = await boot();
    fac.state.simulate = "fail";
    const offer = await issue(rail);
    const verified = await rail.verify(offer, await credentialFor(policy, offer));
    expect(verified).toEqual({ isValid: false });
    expect(JSON.stringify(verified)).not.toContain("SECRET");
    expect((fac.seen.lastVerify as Record<string, unknown>)["isValid"]).toBe(false);
  });

  it("facilitator が memo の違い・fee payer の違いを拒む（Router の検査と同じ向き）", async () => {
    const { fac, rail, policy } = await boot();
    const offer = await issue(rail);
    const wrongMemo = { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, transaction: await payer.build(policy, offer.amount, `0x${"cd".repeat(32)}`) } };
    expect(rail.preflight(offer, wrongMemo, Date.now())).toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(await rail.verify(offer, wrongMemo)).toEqual({ isValid: false });
    expect((fac.seen.lastVerify as Record<string, unknown>)["invalidReason"]).toMatch(/memo/);
  });

  it("fee payer が変わった後（/supported を変えて adapter を作り直す）、発行済みの quote は verify で落ちる（AC-4）", async () => {
    const first = await boot();
    const offer = await issue(first.rail);
    const credential = await credentialFor(first.policy, offer);
    // 新しい facilitator（別の fee payer）に対して同じ offer・credential。
    const second = await boot();
    expect(second.policy.feePayer).not.toBe(first.policy.feePayer);
    expect(second.rail.preflight(offer, credential, Date.now())).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(await second.rail.verify(offer, credential)).toEqual({ isValid: false });
    expect(second.fac.seen.settleCalls).toBe(0);
  });
});

describe("SVM 受信: 決済の結果の表（設計 §6）", () => {
  const rows: [string, (fac: SvmFacilitator) => void][] = [
    ["send の失敗（success false）", (fac) => { fac.state.send = "fail"; }],
    ["chain での失敗（success false）", (fac) => { fac.state.confirm = "onchain-failure"; }],
    ["confirm の timeout（settlement_pending）", (fac) => { fac.state.confirm = "timeout"; }],
    ["HTTP 500（本文は正しい）", (fac) => { fac.state.settleOverride = (body) => ({ status: 500, body }); }],
    ["HTTP 409", (fac) => { fac.state.settleOverride = () => ({ status: 409, body: { error: "conflict" } }); }],
    ["network が違う", (fac) => { fac.state.settleOverride = (body) => ({ status: 200, body: { ...body, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" } }); }],
    ["transaction が signature の形でない", (fac) => { fac.state.settleOverride = (body) => ({ status: 200, body: { ...body, transaction: "0x" + "ab".repeat(32) } }); }],
    ["transaction が無い", (fac) => { fac.state.settleOverride = (body) => { const { transaction: _t, ...rest } = body; return { status: 200, body: rest }; }; }],
    ["JSON でない", (fac) => { fac.state.settleOverride = () => ({ raw: '{"success": true, "transaction": "' }); }],
    ["64 KiB 超（本文は正しい）", (fac) => { fac.state.settleOverride = (body) => ({ raw: JSON.stringify({ ...body, pad: "p".repeat(70 * 1024) }) }); }],
  ];
  for (const [name, arrange] of rows) {
    it(`settle ${name} → unknown（要求 1 回、文字列を転送しない）`, async () => {
      const { fac, rail, policy } = await boot();
      arrange(fac);
      const offer = await issue(rail);
      const settled = await rail.settle(offer, await credentialFor(policy, offer));
      expect(settled).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
      expect(JSON.stringify(settled)).not.toContain("SECRET");
      expect(fac.seen.settleCalls).toBe(1);
    });
  }

  it("payer・extensions が無くても success・network・signature だけで settled。応答の上限は 64 KiB", async () => {
    const { fac, rail, policy } = await boot();
    fac.state.settleOverride = (body) => ({ status: 200, body: { success: body["success"], network: body["network"], transaction: body["transaction"] } });
    const offer = await issue(rail);
    expect((await rail.settle(offer, await credentialFor(policy, offer))).outcome).toBe("settled");
    expect(SVM_RESPONSE_MAX_BYTES).toBe(64 * 1024);
  });

  it("応答が失われる（接続が切れる）と例外（core が unknown にする）", async () => {
    const { fac, rail, policy } = await boot();
    fac.state.dropSettle = true;
    const offer = await issue(rail);
    await expect(rail.settle(offer, await credentialFor(policy, offer))).rejects.toThrow();
    expect(fac.seen.settleCalls).toBe(1);
  });

  it("settle の期限は wire + 10 秒（wire 1 で 12 秒の遅れは期限切れ、wire 5 で 12 秒は settled）", async () => {
    const slow = await boot({ maxTimeoutSeconds: 1 });
    slow.fac.state.settleDelayMs = 12_000;
    const offer = await issue(slow.rail);
    await expect(slow.rail.settle(offer, await credentialFor(slow.policy, offer))).rejects.toThrow();
    const wide = await boot({ maxTimeoutSeconds: 5 });
    wide.fac.state.settleDelayMs = 12_000;
    const offer2 = await issue(wide.rail);
    expect(offer2.maxTimeoutSeconds).toBe(5);
    expect((await wide.rail.settle(offer2, await credentialFor(wide.policy, offer2))).outcome).toBe("settled");
  }, 60_000);

  it("transport: redirect を追わない（行き先へ 0 接続）、loopback に解決する名前には届かない", async () => {
    const { fac, rail, policy, transport } = await boot();
    const sink = await startSvmFacilitator(TLS, SOL, undefined, "other.test");
    closers.push(sink.close);
    fac.state.redirectCalls = true;
    fac.state.redirectTo = "https://other.test/settle";
    void transport;
    const offer = await issue(rail);
    const credential = await credentialFor(policy, offer);
    await expect(rail.verify(offer, credential)).rejects.toThrow();
    await expect(rail.settle(offer, credential)).rejects.toThrow();
    expect(sink.seen.connections).toBe(0);
    const internal = createX402SvmInbound({ facilitatorUrl: `https://${FAC_HOST}`, policy, transport: createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup({ [FAC_HOST]: ["127.0.0.1"] }), dialForTest: dialTo({ [FAC_HOST]: fac.port }), dns: { timeoutMs: 3_000, maxInFlight: 4 } }) });
    const before = fac.seen.connections;
    await expect(internal.verify(offer, credential)).rejects.toMatchObject({ code: "destination_blocked" });
    expect(fac.seen.connections).toBe(before);
  });
});
