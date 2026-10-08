/**
 * MPP Solana の受信 adapter と合成（`docs/mpp-solana-design.md` §2.2・§2.3・§3.1・§3.5・§3.6、要件 FR-45・FR-47・FR-48。タスク M3-b）。**無課金・Linux で受け入れ**。
 *
 * - payer は**本物の pay-kit の client**（fixture `mpp-solana-payer.ts`。両型）
 * - challenge の発行・HMAC は Router の mppx 0.11.0（adapter の中）
 * - RPC は loopback の fixture（`getAccountInfo`・`sendTransaction`・`getSignatureStatuses`・`getTransaction`）。transport は本番の方針
 *   （loopback 不可・名前解決の fixture・`dialForTest`）。RPC は平文 http（guarded transport は http を許す。pay-kit の client も同じ fixture を読む）
 * - 追跡の時計は差し替え（経過時間の期限・回数の上限を実時間なしで観測）
 * - 合成: `composeRails` → `createRouterCore`（`onStoreLoaded: rails.bindConsumed`）→ purchase → `delivered`（静的・動的）、§3.6 の静的と動的の写像の違い、
 *   journal の消費済み署名で settle を直接呼ぶ → `rejected`、再起動後も同じ、x402 SVM 受信と同じ宛先の区分の通算
 */
import { mkdtemp } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { address, generateKeyPairSigner } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { generatePrivateKey } from "viem/accounts";
import { Challenge, Credential } from "mppx";

import {
  ConsumedSignaturesHolder,
  createMppSolanaInbound,
  MPP_SOLANA_EVIDENCE_GRACE_MS,
  MPP_SOLANA_FOLLOW_UP_DEFAULTS,
  MPP_SOLANA_RPC_TIMEOUT_MS,
  MPP_SOLANA_SCHEME,
  MPP_SOLANA_SETTLE_DEADLINE_MS,
  mppSolanaPayloadOf,
  type MppSolanaInbound,
} from "../../src/adapters/inbound/mpp-solana.js";
import { loadRuntimeConfig, routeBindingOf, type RuntimeConfig } from "../../src/config.js";
import { createRouterCore, type QuoteOutcome, type RouterCore } from "../../src/core/orchestrator.js";
import { composeRails, type DynamicTransportHooks, type RouterCapabilities } from "../../src/main.js";
import { createGuardedTransport, type GuardedTransport } from "../../src/net/guarded-fetch.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import type { DestinationOffer, OutboundRail, PayRequest, PayResult, UpstreamTarget } from "../../src/ports/outbound.js";
import { dialTo, FIXTURE_PUBLIC_ADDRESS, publicLookup, UnmappedFixtureHostError } from "../fixtures/dynamic/dial.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";
import { createMppSolanaTestPayer, transactionOfWire, type MppSolanaTestPayer } from "../fixtures/mpp-solana-payer.js";
import { signatureOfBase64, startSolanaRpc, type SolanaRpcFixture, type SolanaRpcState } from "../fixtures/solana-rpc.js";
import { startSvmFacilitator } from "../fixtures/svm-facilitator.js";
import { createSvmTestPayer } from "../fixtures/svm-payer.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";
import { createRealEvmCapability } from "../../tools/real-evm-capability.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);
const BASE = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const TEMPO = "eip155:42431";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const RPC_HOST = "rpc.provider.test";
const SVM_FAC_HOST = "static.provider.test";
const SECRET = "mpp-solana-inbound-secret-0123456789abcdef0123456789";
const ROUTE_ID = "md-solmpp-inbound";
const ROUTE_BINDING = [ROUTE_ID, "GET", `/v1/routes/${ROUTE_ID}/resource`].map(encodeURIComponent).join("|");
const SEND_OPTIONS = { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 };

let owner: string;
let ownerAta: string;
beforeAll(async () => {
  const keypair = await generateKeyPairSigner();
  owner = String(keypair.address);
  ownerAta = String((await findAssociatedTokenPda({ mint: address(MINT), owner: keypair.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

function transportTo(routes: Record<string, number>): GuardedTransport {
  return createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], lookup: publicLookup(), dialForTest: dialTo(routes), dns: { timeoutMs: 3_000, maxInFlight: 4 } });
}

/** 決定的な時計: `sleep` が時計を進める。`jumpOnReadMs` は `clock()` を読むたびに進める量（遅い処理の再現）。 */
function fakeTime(options: { jumpOnReadMs?: number } = {}): { clock: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    clock: () => {
      t += options.jumpOnReadMs ?? 0;
      return t;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

type RailOptions = Parameters<typeof createMppSolanaInbound>[0];
interface Booted {
  rpc: SolanaRpcFixture;
  rail: MppSolanaInbound;
  payer: MppSolanaTestPayer;
  holder: ConsumedSignaturesHolder;
  diagnostics: string[];
  time: ReturnType<typeof fakeTime>;
  /** `mark()` 以後の RPC の要求（payer の fixture の要求を除くため）。 */
  mark: () => number;
  since: (mark: number) => { method: string; params: unknown }[];
}

async function boot(options: { bound?: ReadonlySet<string>; unbound?: boolean; skipStartup?: boolean; jumpOnReadMs?: number; extra?: Partial<RailOptions>; atas?: SolanaRpcState["atas"] } = {}): Promise<Booted> {
  const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, ata: { address: ownerAta, owner } });
  closers.push(rpc.close);
  if (options.atas !== undefined) rpc.state.atas = options.atas;
  const payer = await createMppSolanaTestPayer({ rpcUrl: rpc.url });
  closers.push(payer.close);
  const holder = new ConsumedSignaturesHolder();
  if (options.unbound !== true) holder.bind(options.bound ?? new Set());
  const diagnostics: string[] = [];
  const time = fakeTime({ ...(options.jumpOnReadMs === undefined ? {} : { jumpOnReadMs: options.jumpOnReadMs }) });
  const rail = createMppSolanaInbound({
    secretKey: SECRET,
    recipient: owner,
    mint: MINT,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM,
    network: SOL,
    maxTimeoutSeconds: 600,
    rpc: { url: `http://${RPC_HOST}`, transport: transportTo({ [RPC_HOST]: rpc.port }) },
    consumed: holder,
    realm: "router-test",
    clock: time.clock,
    sleep: time.sleep,
    onDiagnostic: (code) => diagnostics.push(code),
    ...options.extra,
  });
  if (options.skipStartup !== true) await rail.startup();
  return { rpc, rail, payer, holder, diagnostics, time, mark: () => rpc.calls.length, since: (mark) => rpc.calls.slice(mark) };
}

async function issue(rail: MppSolanaInbound, overrides: { amount?: string; routeBinding?: string; nowMs?: number } = {}): Promise<InboundOffer> {
  return rail.createOffer({ routeId: ROUTE_ID, amount: overrides.amount ?? "10000", asset: MINT, network: SOL, routeBinding: overrides.routeBinding ?? ROUTE_BINDING, nowMs: overrides.nowMs ?? Date.now() });
}

function wireOf(credential: PaymentCredential): string {
  return credential.payload["credential"] as string;
}

function signatureOfCredential(credential: PaymentCredential): string {
  const payload = mppSolanaPayloadOf(wireOf(credential));
  if (payload === undefined) throw new Error("not a solana credential");
  return payload.type === "signature" ? payload.signature : signatureOfBase64(Buffer.from(payload.bytes).toString("base64"))!;
}

describe("MPP Solana 受信: 起動時の検査（設計 §3.1）", () => {
  it("startup は受取 owner の ATA を getAccountInfo（jsonParsed・confirmed）1 回で確かめる。その前は offer も preflight も出さない（fail closed）", async () => {
    const b = await boot({ skipStartup: true });
    await expect(issue(b.rail)).rejects.toThrow(/startup\(\) has not completed/);
    const premature: InboundOffer = { scheme: MPP_SOLANA_SCHEME, network: SOL, asset: MINT, amount: "10000", payTo: owner, maxTimeoutSeconds: 600, extra: { challengeNonce: "x", expiresAt: Math.floor(Date.now() / 1000) + 60, routeBinding: ROUTE_BINDING } };
    expect(() => b.rail.preflight(premature, { x402Version: 2, accepted: premature, payload: { challengeNonce: "x" } }, Date.now())).toThrow(/startup\(\) has not completed/);
    expect(b.rpc.calls).toEqual([]);
    await b.rail.startup();
    expect(b.rpc.calls).toEqual([{ method: "getAccountInfo", params: [ownerAta, { encoding: "jsonParsed", commitment: "confirmed" }] }]);
    await expect(issue(b.rail)).resolves.toMatchObject({ scheme: MPP_SOLANA_SCHEME });
  });

  it("ATA が無い・owner が違う・mint が違う → startup が落ちる。RPC に届かなくても落ちる", async () => {
    const missing = await boot({ skipStartup: true, atas: [] });
    await expect(missing.rail.startup()).rejects.toThrow(/does not exist/);
    const other = String((await generateKeyPairSigner()).address);
    const wrongOwner = await boot({ skipStartup: true, atas: [{ address: ownerAta, owner: other }] });
    await expect(wrongOwner.rail.startup()).rejects.toThrow(/not owned by the configured payTo/);
    const wrongMint = await boot({ skipStartup: true, atas: [{ address: ownerAta, owner, mint: "So11111111111111111111111111111111111111112" }] });
    await expect(wrongMint.rail.startup()).rejects.toThrow(/mint/);
    const unreachable = await boot({ skipStartup: true });
    await unreachable.rpc.close();
    await expect(unreachable.rail.startup()).rejects.toThrow(/RPC could not be read at startup/);
  });

  it("組み立ての検査: 短い secret・表に無い network・owner でない recipient は作れない", () => {
    const base: RailOptions = { secretKey: SECRET, recipient: owner, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM, network: SOL, maxTimeoutSeconds: 600, rpc: { url: `http://${RPC_HOST}`, transport: transportTo({}) }, consumed: new ConsumedSignaturesHolder() };
    expect(() => createMppSolanaInbound({ ...base, secretKey: "short" })).toThrow(/at least 32 bytes/);
    expect(() => createMppSolanaInbound({ ...base, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })).toThrow(/not in the table/);
    expect(() => createMppSolanaInbound({ ...base, recipient: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2" })).toThrow(/32-byte base58/);
    expect(MPP_SOLANA_SETTLE_DEADLINE_MS).toBe(50_000);
    expect(MPP_SOLANA_FOLLOW_UP_DEFAULTS).toEqual({ totalMs: 30_000, intervalMs: 2_000, maxPolls: 15 });
    expect(MPP_SOLANA_RPC_TIMEOUT_MS).toBe(10_000);
    expect(MPP_SOLANA_EVIDENCE_GRACE_MS).toBe(3_600_000);
  });
});

describe("MPP Solana 受信: offer（設計 §3.2、要件 FR-46）", () => {
  it("offer: solana/charge、payTo は owner、extra に nonce = challenge の id・externalId・直列化した challenge・decimals・tokenProgram・fundsMoveOnCredential true。SDK が束縛した request は offer と一致", async () => {
    const b = await boot();
    const nowMs = Date.now();
    const offer = await issue(b.rail, { nowMs });
    expect(offer).toMatchObject({ scheme: MPP_SOLANA_SCHEME, network: SOL, asset: MINT, amount: "10000", payTo: owner, maxTimeoutSeconds: 600 });
    expect(offer.extra["fundsMoveOnCredential"]).toBe(true);
    expect(offer.extra["decimals"]).toBe(6);
    expect(offer.extra["tokenProgram"]).toBe(TOKEN_PROGRAM);
    expect(offer.extra.expiresAt).toBe(Math.floor((nowMs + 600_000) / 1000));
    expect(offer.extra.routeBinding).toBe(ROUTE_BINDING);
    const externalId = offer.extra["externalId"] as string;
    expect(externalId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{20,24}$/);
    expect(externalId).not.toBe(offer.extra.challengeNonce);
    const challenge = Challenge.deserialize(offer.extra["challenge"] as string) as unknown as { id: string; request: Record<string, unknown>; expires?: string };
    expect(challenge.id).toBe(offer.extra.challengeNonce);
    expect(challenge.request).toEqual({ amount: "10000", currency: MINT, recipient: owner, externalId, methodDetails: { network: "devnet", decimals: 6, tokenProgram: TOKEN_PROGRAM, feePayer: false } });
    // 2 つの offer は nonce も externalId も違う。
    const second = await issue(b.rail);
    expect(second.extra.challengeNonce).not.toBe(offer.extra.challengeNonce);
    expect(second.extra["externalId"]).not.toBe(externalId);
    // RPC は使わない（起動時の検査の 1 回だけ）。
    expect(b.rpc.calls.map((c) => c.method)).toEqual(["getAccountInfo"]);
  });

  it("固定した mint・network 以外には出さない", async () => {
    const b = await boot();
    await expect(b.rail.createOffer({ routeId: ROUTE_ID, amount: "1", asset: "So11111111111111111111111111111111111111112", network: SOL, routeBinding: ROUTE_BINDING, nowMs: Date.now() })).rejects.toThrow(/fixed mint or network/);
    await expect(b.rail.createOffer({ routeId: ROUTE_ID, amount: "1", asset: MINT, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", routeBinding: ROUTE_BINDING, nowMs: Date.now() })).rejects.toThrow(/fixed mint or network/);
  });
});

describe("MPP Solana 受信: transaction 型（pay-kit の client の既定）→ verify → settle（設計 §3.5）", () => {
  it("preflight ok、verify は RPC 無しで valid、settle は sendTransaction 1 回（base64・skipPreflight false・preflightCommitment confirmed・maxRetries 0）→ 追跡 → settled（txRef = 署名）。SDK の broadcast hook は呼ばれない", async () => {
    const b = await boot();
    const offer = await issue(b.rail);
    const credential = await b.payer.credentialFor(offer);
    expect(mppSolanaPayloadOf(wireOf(credential))?.type).toBe("transaction");
    expect(b.rail.preflight(offer, credential, Date.now())).toEqual({ ok: true });
    const mark = b.mark();
    expect(await b.rail.verify(offer, credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
    expect(b.since(mark)).toEqual([]);
    expect(b.rpc.state.sent).toEqual([]);
    b.rpc.state.signatureStatuses = ["confirmed"];
    const result = await b.rail.settle(offer, credential, { routeId: ROUTE_ID });
    const signature = signatureOfCredential(credential);
    expect(result).toEqual({ outcome: "settled", txRef: signature });
    expect(b.since(mark)).toEqual([
      { method: "sendTransaction", params: [transactionOfWire(wireOf(credential)), SEND_OPTIONS] },
      { method: "getSignatureStatuses", params: [[signature], { searchTransactionHistory: true }] },
    ]);
    expect(b.rpc.state.sent).toEqual([transactionOfWire(wireOf(credential))]);
    expect(b.time.sleeps).toEqual([]);
    expect(b.diagnostics).toEqual([]);
  });

  it("verify の拒否面（journal に乗った後。`verify_failed`）: challenge の HMAC 改竄、scope 違い、nonce 違い（別 offer の credential）、Memo 違い（別 offer の transaction を正しい challenge に載せる）、期限切れ", async () => {
    const b = await boot();
    const offer = await issue(b.rail);
    const credential = await b.payer.credentialFor(offer);
    const decoded = Credential.deserialize(wireOf(credential));
    const tamper = (patch: Record<string, unknown>): PaymentCredential => ({ ...credential, payload: { ...credential.payload, credential: Credential.serialize({ ...decoded, challenge: { ...decoded.challenge, request: { ...(decoded.challenge.request as Record<string, unknown>), ...patch } } } as never) } });
    expect(await b.rail.verify(offer, tamper({ amount: "1" }), { routeId: ROUTE_ID })).toEqual({ isValid: false });
    expect(await b.rail.verify(offer, tamper({ recipient: String((await generateKeyPairSigner()).address) }), { routeId: ROUTE_ID })).toEqual({ isValid: false });
    // scope: SDK の validateCredential に渡す scope は offer の routeBinding。
    expect(await b.rail.verify({ ...offer, extra: { ...offer.extra, routeBinding: "other%7CGET%7C%2Fx" } }, credential, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    // nonce: 別の offer の credential。
    const other = await issue(b.rail);
    const otherCredential = await b.payer.credentialFor(other);
    expect(await b.rail.verify(offer, otherCredential, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    // Memo: 正しい challenge（HMAC は通る）に別の offer の transaction（Memo = 別の externalId）。
    const swapped: PaymentCredential = { ...credential, payload: { ...credential.payload, credential: Credential.serialize({ ...decoded, payload: { type: "transaction", transaction: transactionOfWire(wireOf(otherCredential)) } } as never) } };
    expect(await b.rail.verify(offer, swapped, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    // 期限切れ: 1 秒の offer を待ってから。
    const short = await boot({ extra: { maxTimeoutSeconds: 1 } });
    const expiring = await issue(short.rail);
    const expiringCredential = await short.payer.credentialFor(expiring);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await short.rail.verify(expiring, expiringCredential, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    // どれも RPC を使わず、送出していない。
    expect(b.rpc.state.sent).toEqual([]);
    expect(short.rpc.state.sent).toEqual([]);
    expect(b.diagnostics).toEqual([]);
    // 形の違う credential（文字列でない・空）は verify も false。
    expect(await b.rail.verify(offer, { ...credential, payload: { challengeNonce: offer.extra.challengeNonce } }, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    expect(await b.rail.verify(offer, { ...credential, payload: { challengeNonce: offer.extra.challengeNonce, credential: "" } }, { routeId: ROUTE_ID })).toEqual({ isValid: false });
  });

  it("verify の証拠の無い settle（transaction 型）は RPC 無しの同じ検査をする: 別 offer の credential は送出せずに rejected、正しい credential は送出して settled", async () => {
    const b = await boot();
    const offer = await issue(b.rail);
    const other = await issue(b.rail);
    const foreign = await b.payer.credentialFor(other);
    const mark = b.mark();
    expect(await b.rail.settle(offer, foreign, { routeId: ROUTE_ID })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    expect(b.since(mark)).toEqual([]);
    expect(b.rpc.state.sent).toEqual([]);
    const credential = await b.payer.credentialFor(offer);
    b.rpc.state.signatureStatuses = ["confirmed"];
    const mark2 = b.mark();
    expect(await b.rail.settle(offer, credential, { routeId: ROUTE_ID })).toEqual({ outcome: "settled", txRef: signatureOfCredential(credential) });
    expect(b.since(mark2).map((c) => c.method)).toEqual(["sendTransaction", "getSignatureStatuses"]);
  });

  it("verify の証拠は offer 全体と wire に束縛される: 別 offer の nonce の下でも、同じ nonce で額・externalId・routeBinding を変えた写しの下でも使われない（RPC 無しの再検査で rejected）", async () => {
    const b = await boot();
    const offer = await issue(b.rail);
    const credential = await b.payer.credentialFor(offer);
    expect(await b.rail.verify(offer, credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
    const other = await issue(b.rail);
    expect(await b.rail.settle(other, credential, { routeId: ROUTE_ID })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    for (const copy of [{ ...offer, amount: "1" }, { ...offer, extra: { ...offer.extra, externalId: "x" } }, { ...offer, extra: { ...offer.extra, routeBinding: "other%7CGET%7C%2Fx" } }] as InboundOffer[]) {
      expect(await b.rail.verify(offer, credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
      expect(await b.rail.settle(copy, credential, { routeId: ROUTE_ID })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    }
    expect(b.rpc.state.sent).toEqual([]);
    // 証拠は 1 回の settle で使い切る: 同じ credential の 2 回目の settle（transaction 型）は RPC 無しの再検査を経てもう一度送出できる（重複の防御は core の journal）。
    b.rpc.state.signatureStatuses = ["confirmed"];
    expect(await b.rail.verify(offer, credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
    expect(await b.rail.settle(offer, credential, { routeId: ROUTE_ID })).toEqual({ outcome: "settled", txRef: signatureOfCredential(credential) });
    expect(await b.rail.settle(offer, credential, { routeId: ROUTE_ID })).toEqual({ outcome: "settled", txRef: signatureOfCredential(credential) });
    expect(b.rpc.state.sent).toHaveLength(2);
  });
});

describe("MPP Solana 受信: transaction 型の settle の分岐（設計 §3.5 の 2〜4、要件 FR-47）", () => {
  async function paid(b: Booted): Promise<{ offer: InboundOffer; credential: PaymentCredential; signature: string; mark: number }> {
    const offer = await issue(b.rail);
    const credential = await b.payer.credentialFor(offer);
    expect(await b.rail.verify(offer, credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
    return { offer, credential, signature: signatureOfCredential(credential), mark: b.mark() };
  }

  it("送出が JSON-RPC の error → 履歴つきの status を 1 回: 既に confirmed（payer が先に送出していた = AlreadyProcessed）→ settled。追跡はしない", async () => {
    const b = await boot();
    const p = await paid(b);
    b.rpc.state.sendReply = "already-processed";
    b.rpc.state.signatureStatuses = ["confirmed"];
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "settled", txRef: p.signature });
    expect(b.since(p.mark).map((c) => c.method)).toEqual(["sendTransaction", "getSignatureStatuses"]);
    expect(b.since(p.mark)[1]!.params).toEqual([[p.signature], { searchTransactionHistory: true }]);
    expect(b.diagnostics).toEqual(["mpp_solana_send_rejected"]);
    expect(b.time.sleeps).toEqual([]);
  });

  it("送出が error → status が confirmed + err → rejected（source_rejected、診断 tx_failed_on_chain）。追跡はしない", async () => {
    const b = await boot();
    const p = await paid(b);
    b.rpc.state.sendReply = "rpc-error";
    b.rpc.state.signatureStatuses = ["err-confirmed"];
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    expect(b.since(p.mark).map((c) => c.method)).toEqual(["sendTransaction", "getSignatureStatuses"]);
    expect(b.diagnostics).toEqual(["mpp_solana_send_rejected", "mpp_solana_tx_failed_on_chain"]);
  });

  it("送出が error → 1 回の status が processed + err は終端ではない（errTerminalAt: confirmed）→ 追跡へ → confirmed で settled", async () => {
    const b = await boot();
    const p = await paid(b);
    b.rpc.state.sendReply = "rpc-error";
    b.rpc.state.signatureStatuses = ["err", "confirmed"];
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "settled", txRef: p.signature });
    expect(b.since(p.mark).map((c) => c.method)).toEqual(["sendTransaction", "getSignatureStatuses", "getSignatureStatuses"]);
    expect(b.diagnostics).toEqual(["mpp_solana_send_rejected"]);
  });

  it("送出が error → status が null → 追跡へ: 高々 15 回・経過 30 秒（間隔 2 秒）、見えなければ unknown（source_settle_unknown）。status の要求は 1 + 15", async () => {
    const b = await boot();
    const p = await paid(b);
    b.rpc.state.sendReply = "rpc-error";
    b.rpc.state.signatureStatuses = ["null"];
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    const calls = b.since(p.mark);
    expect(calls[0]!.method).toBe("sendTransaction");
    expect(calls.filter((c) => c.method === "getSignatureStatuses")).toHaveLength(16);
    // 追跡の 15 回はどれも履歴つき。
    for (const call of calls.slice(1)) expect(call.params).toEqual([[p.signature], { searchTransactionHistory: true }]);
    expect(b.time.sleeps).toEqual(Array(15).fill(2_000));
    expect(b.diagnostics).toEqual(["mpp_solana_send_rejected"]);
  });

  it("追跡: processed + err は続行し、confirmed + err で rejected（errTerminalAt: confirmed）", async () => {
    const b = await boot();
    const p = await paid(b);
    b.rpc.state.signatureStatuses = ["err", "err", "err-confirmed"];
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    expect(b.since(p.mark).map((c) => c.method)).toEqual(["sendTransaction", "getSignatureStatuses", "getSignatureStatuses", "getSignatureStatuses"]);
    expect(b.time.sleeps).toEqual([2_000, 2_000]);
    expect(b.diagnostics).toEqual(["mpp_solana_tx_failed_on_chain"]);
  });

  it("追跡: processed のまま期限 → unknown。回数は maxPolls で、経過時間は clock で止まる（遅い RPC で 30 秒を先に使い切れば 15 回に満たない）", async () => {
    const b = await boot();
    const p = await paid(b);
    b.rpc.state.signatureStatuses = ["processed"];
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(b.since(p.mark).filter((c) => c.method === "getSignatureStatuses")).toHaveLength(15);
    // 回数の上限を小さく。
    const few = await boot({ extra: { followUp: { maxPolls: 3 } } });
    const q = await paid(few);
    few.rpc.state.signatureStatuses = ["processed"];
    expect(await few.rail.settle(q.offer, q.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(few.since(q.mark).filter((c) => c.method === "getSignatureStatuses")).toHaveLength(3);
    // 回数の上限を大きくしても経過 30 秒で止まる（t = 0, 2, …, 28 の 15 回。追跡の窓は 30 秒で、全体の 50 秒ではない）。
    const many = await boot({ extra: { followUp: { maxPolls: 100 } } });
    const s = await paid(many);
    many.rpc.state.signatureStatuses = ["processed"];
    expect(await many.rail.settle(s.offer, s.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(many.since(s.mark).filter((c) => c.method === "getSignatureStatuses")).toHaveLength(15);
    expect(many.time.sleeps).toEqual(Array(15).fill(2_000));
    // 遅い RPC（clock を読むたびに 5 秒進む）: 経過 30 秒が先に尽きる → 15 回に満たない。
    const slow = await boot({ jumpOnReadMs: 5_000 });
    const r = await paid(slow);
    slow.rpc.state.signatureStatuses = ["processed"];
    expect(await slow.rail.settle(r.offer, r.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    const polls = slow.since(r.mark).filter((c) => c.method === "getSignatureStatuses").length;
    expect(polls).toBeGreaterThan(0);
    expect(polls).toBeLessThan(15);
  });

  it("全体の期限 settleDeadlineMs（既定 50 秒）が追跡の 30 秒より先に来れば、そこで止まる", async () => {
    const b = await boot({ extra: { settleDeadlineMs: 5_000 } });
    const p = await paid(b);
    b.rpc.state.signatureStatuses = ["processed"];
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    // t = 0, 2000, 4000 の 3 回で 5 秒を超える。
    expect(b.since(p.mark).filter((c) => c.method === "getSignatureStatuses")).toHaveLength(3);
  });

  it("送出に応答が無い（要求の期限で切れる）→ 追跡へ: confirmed が見えれば settled（送出は 1 回だけ。再送しない）", async () => {
    const b = await boot({ extra: { rpcTimeoutMs: 300 } });
    const p = await paid(b);
    b.rpc.state.sendReply = "no-response";
    b.rpc.state.signatureStatuses = ["null", "confirmed"];
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "settled", txRef: p.signature });
    expect(b.since(p.mark).map((c) => c.method)).toEqual(["sendTransaction", "getSignatureStatuses", "getSignatureStatuses"]);
    expect(b.rpc.state.sent).toHaveLength(1);
    expect(b.diagnostics).toEqual([]);
  });

  it("1 要求の期限は min(10 秒, 全体の残り): 全体の期限が 300 ms なら、応答の無い送出は 300 ms で切れる（10 秒は待たない）→ unknown", async () => {
    const b = await boot({ extra: { settleDeadlineMs: 300 } });
    const p = await paid(b);
    b.rpc.state.sendReply = "no-response";
    const started = Date.now();
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(b.since(p.mark).filter((c) => c.method === "sendTransaction")).toHaveLength(1);
  }, 15_000);

  it("送出の応答の署名が自分の署名と違う → unknown（追跡しない）", async () => {
    const b = await boot();
    const p = await paid(b);
    b.rpc.state.sendReply = "wrong-signature";
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(b.since(p.mark).map((c) => c.method)).toEqual(["sendTransaction"]);
  });

  it("消費済み（journal の集合）の署名は送出せずに rejected。bind の前に settle を呼ぶと throw（core は source_settle_unknown に写す）。再起動後（新しい adapter に復元した集合を bind）も同じ", async () => {
    const unbound = await boot({ unbound: true });
    const p = await paid(unbound);
    await expect(unbound.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).rejects.toThrow(/not bound yet/);
    expect(unbound.rpc.state.sent).toEqual([]);
    // 消費済み。
    unbound.holder.bind(new Set([p.signature]));
    expect(await unbound.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    expect(unbound.rpc.state.sent).toEqual([]);
    // 集合は生きている（後から増えた署名も見える）。
    const live = new Set<string>();
    const restarted = await boot({ bound: live });
    const q = await paid(restarted);
    live.add(q.signature);
    expect(await restarted.rail.settle(q.offer, q.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    expect(restarted.rpc.state.sent).toEqual([]);
  });

  it("並行 2 件（同じ credential）: adapter は両方を送出する（chain が同じ署名を 1 回だけ受理する）。重複の防御は core の journal（`source_settled` の guarded append）にある", async () => {
    const b = await boot({ bound: new Set() });
    const p = await paid(b);
    b.rpc.state.signatureStatuses = ["confirmed"];
    const [first, second] = await Promise.all([b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID }), b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })]);
    expect(first).toEqual({ outcome: "settled", txRef: p.signature });
    expect(second).toEqual({ outcome: "settled", txRef: p.signature });
    expect(b.rpc.state.sent).toHaveLength(2);
  });
});

describe("MPP Solana 受信: signature 型（payer が送出済み。push）", () => {
  async function pushed(b: Booted): Promise<{ offer: InboundOffer; credential: PaymentCredential; signature: string; mark: number }> {
    const offer = await issue(b.rail);
    const credential = await b.payer.credentialFor(offer, "signature");
    const signature = signatureOfCredential(credential);
    expect(b.rpc.state.transactions.has(signature)).toBe(true);
    return { offer, credential, signature, mark: b.mark() };
  }

  it("verify は getTransaction（base64・confirmed・version 0）を 1 回読んで §3.3 に掛ける。settle は **RPC 無し**で settled（txRef = 署名）: verify の後に chain が読めなくなっても、期限が過ぎても settled のまま", async () => {
    const b = await boot({ bound: new Set() });
    const p = await pushed(b);
    expect(b.rail.preflight(p.offer, p.credential, Date.now())).toEqual({ ok: true });
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
    expect(b.since(p.mark)).toEqual([{ method: "getTransaction", params: [p.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "base64" }] }]);
    const mark = b.mark();
    // verify の後に RPC が transaction を返さなくなり、さらに届かなくなっても、settle は証拠で判定する（payer は送金済み）。
    b.rpc.state.transactions.delete(p.signature);
    await b.rpc.close();
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "settled", txRef: p.signature });
    expect(b.since(mark)).toEqual([]);
    expect(b.rpc.state.sent).toHaveLength(1); // payer の fixture の送出だけ
    expect(b.diagnostics).toEqual([]);
    // 期限の短い offer: verify の後に期限が過ぎても settle は settled（HMAC の再検査をしない）。
    const short = await boot({ bound: new Set(), extra: { maxTimeoutSeconds: 1 } });
    const q = await pushed(short);
    expect(await short.rail.verify(q.offer, q.credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await short.rail.settle(q.offer, q.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "settled", txRef: q.signature });
  });

  it("証拠は数では押し出されない: verify の後に他の purchase の verify が多数あっても、その signature 型の settle は RPC 無しで settled。同じ nonce で欄を変えた写しの下では throw", async () => {
    const b = await boot({ bound: new Set() });
    const p = await pushed(b);
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
    for (let i = 0; i < 40; i += 1) {
      const other = await issue(b.rail);
      expect(await b.rail.verify(other, await b.payer.credentialFor(other), { routeId: ROUTE_ID })).toEqual({ isValid: true });
    }
    await b.rpc.close();
    await expect(b.rail.settle({ ...p.offer, amount: "1" }, p.credential, { routeId: ROUTE_ID })).rejects.toThrow(/without a prior verify/);
    const mark = b.mark();
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "settled", txRef: p.signature });
    expect(b.since(mark)).toEqual([]);
    // 使い切った証拠: もう一度は判定しない。
    await expect(b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).rejects.toThrow(/without a prior verify/);
  }, 30_000);

  it("期限の過ぎた証拠は捨てられる（offer の期限 + 猶予）: 猶予の後の settle は throw。猶予の中なら settled", async () => {
    const b = await boot({ bound: new Set(), extra: { maxTimeoutSeconds: 1, now: () => Date.now() + 1_000 + MPP_SOLANA_EVIDENCE_GRACE_MS + 1_000 } });
    // adapter の `now` を offer の期限 + 猶予の先に置く（verify の時点で既に保持の期限を過ぎている → 次の verify の掃除で消える）。
    const p = await pushed(b);
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
    const other = await issue(b.rail);
    expect(await b.rail.verify(other, await b.payer.credentialFor(other), { routeId: ROUTE_ID })).toEqual({ isValid: true });
    await expect(b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).rejects.toThrow(/without a prior verify/);
  });

  it("verify の証拠の無い settle（signature 型）は判定しない → throw（core は source_settle_unknown）。消費済みなら証拠が無くても rejected（RPC 無し）", async () => {
    const b = await boot({ bound: new Set() });
    const p = await pushed(b);
    const mark = b.mark();
    await expect(b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).rejects.toThrow(/without a prior verify/);
    expect(b.since(mark)).toEqual([]);
    b.holder.bind(new Set([p.signature]));
    expect(await b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    expect(b.since(mark)).toEqual([]);
  });

  it("HMAC は RPC の前: 改竄した signature 型の credential は getTransaction を読まずに invalid。slot の無い・0 の応答は invalid", async () => {
    const b = await boot();
    const p = await pushed(b);
    const decoded = Credential.deserialize(wireOf(p.credential));
    const tampered: PaymentCredential = { ...p.credential, payload: { ...p.credential.payload, credential: Credential.serialize({ ...decoded, challenge: { ...decoded.challenge, request: { ...(decoded.challenge.request as Record<string, unknown>), amount: "1" } } } as never) } };
    expect(await b.rail.verify(p.offer, tampered, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    expect(b.since(p.mark)).toEqual([]);
    const entry = b.rpc.state.transactions.get(p.signature)!;
    b.rpc.state.transactions.set(p.signature, { ...entry, slot: 0 });
    await expect(b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).rejects.toThrow(/expected form/);
    b.rpc.state.transactions.set(p.signature, entry);
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
  });

  it("verify_failed: chain に無い（null）、meta.err、blockTime が無い・発行より前・期限より後、署名と bytes の不一致。期限ちょうどは通る", async () => {
    const b = await boot();
    const p = await pushed(b);
    const entry = b.rpc.state.transactions.get(p.signature)!;
    const issuedAt = p.offer.extra.expiresAt - p.offer.maxTimeoutSeconds;
    b.rpc.state.transactions.delete(p.signature);
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    b.rpc.state.transactions.set(p.signature, { ...entry, err: { InstructionError: [2, "Custom"] } });
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    b.rpc.state.transactions.set(p.signature, { ...entry, blockTime: null });
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    b.rpc.state.transactions.set(p.signature, { ...entry, blockTime: issuedAt - 1 });
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    b.rpc.state.transactions.set(p.signature, { ...entry, blockTime: p.offer.extra.expiresAt + 1 });
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    b.rpc.state.transactions.set(p.signature, { ...entry, blockTime: p.offer.extra.expiresAt });
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
    b.rpc.state.transactions.set(p.signature, { ...entry, blockTime: issuedAt });
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: true });
    // 署名の下に別の transaction（別 offer の、Memo が違う）が居る。
    const other = await issue(b.rail);
    const otherCredential = await b.payer.credentialFor(other);
    b.rpc.state.transactions.set(p.signature, { ...entry, base64: transactionOfWire(wireOf(otherCredential)) });
    expect(await b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).toEqual({ isValid: false });
    // 同じ transaction でも署名の文字列が違えば不一致。
    b.rpc.state.transactions.set(p.signature, entry);
    const decoded = Credential.deserialize(wireOf(p.credential));
    const otherSignature = signatureOfCredential(otherCredential);
    b.rpc.state.transactions.set(otherSignature, entry);
    const mismatched: PaymentCredential = { ...p.credential, payload: { ...p.credential.payload, credential: Credential.serialize({ ...decoded, payload: { type: "signature", signature: otherSignature } } as never) } };
    expect(await b.rail.verify(p.offer, mismatched, { routeId: ROUTE_ID })).toEqual({ isValid: false });
  });

  it("RPC に届かない・形が違う → verify は throw（core は source_verify_unavailable）。settle も throw（source_settle_unknown）。消費済みの署名は rejected", async () => {
    const b = await boot({ bound: new Set() });
    const p = await pushed(b);
    b.rpc.state.reply = "malformed";
    await expect(b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).rejects.toThrow();
    // verify が通っていないので settle は判定しない（throw）。
    await expect(b.rail.settle(p.offer, p.credential, { routeId: ROUTE_ID })).rejects.toThrow(/without a prior verify/);
    b.rpc.state.reply = "ok";
    await b.rpc.close();
    await expect(b.rail.verify(p.offer, p.credential, { routeId: ROUTE_ID })).rejects.toThrow();
    const c = await boot({ bound: new Set() });
    const q = await pushed(c);
    c.holder.bind(new Set([q.signature]));
    expect(await c.rail.settle(q.offer, q.credential, { routeId: ROUTE_ID })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    const unbound = await boot({ unbound: true });
    const r = await pushed(unbound);
    await expect(unbound.rail.settle(r.offer, r.credential, { routeId: ROUTE_ID })).rejects.toThrow(/not bound yet/);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * 合成（`composeRails` → `createRouterCore`。設計 §2.2・§2.3・§3.6）
 * ────────────────────────────────────────────────────────────────────────────── */

class StubOutbound implements OutboundRail {
  payCalls = 0;
  readonly paidFor: PayRequest[] = [];
  async readChallenge(_routeId: string, _target?: UpstreamTarget): Promise<readonly DestinationOffer[]> {
    return [{ scheme: "exact", network: BASE, asset: USDC, amount: "5000", payTo: "0x0000000000000000000000000000000000000a11", extra: { name: "USDC", version: "2" } }];
  }
  async pay(request: PayRequest): Promise<PayResult> {
    this.payCalls += 1;
    this.paidFor.push(request);
    return { outcome: "paid", body: { ok: true }, contentType: "application/json", txRef: `dst-tx-${this.payCalls}` };
  }
}

interface Composed {
  config: RuntimeConfig;
  rails: ReturnType<typeof composeRails>;
  rpc: SolanaRpcFixture;
  payer: MppSolanaTestPayer;
  dir: string;
  dialed: string[];
}

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => TLS.cleanup());

async function compose(options: { withX402Sol?: boolean; maxTotal?: string; solanaRpc?: string } = {}): Promise<Composed> {
  const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, ata: { address: ownerAta, owner } });
  closers.push(rpc.close);
  const payer = await createMppSolanaTestPayer({ rpcUrl: rpc.url });
  closers.push(payer.close);
  const svmFac = options.withX402Sol === true ? await startSvmFacilitator(TLS, SOL, undefined, SVM_FAC_HOST) : undefined;
  if (svmFac !== undefined) closers.push(svmFac.close);
  const dir = await mkdtemp(path.join(tmpdir(), "mpp-solana-compose-"));
  const dest = { scheme: "exact", network: BASE, asset: USDC, payTo: "0x0000000000000000000000000000000000000a11" };
  const routes: Record<string, unknown> = {
    "r-solmpp": { routeId: "r-solmpp", canonicalPath: "/v1/routes/r-solmpp/resource", rail: "x402", sourceRail: "mpp", source: { amount: "10000", asset: MINT, decimals: 6, network: SOL, payTo: owner }, destination: dest },
    "r-tempo": { routeId: "r-tempo", canonicalPath: "/v1/routes/r-tempo/resource", rail: "x402", sourceRail: "mpp", source: { amount: "10000", asset: PATHUSD, decimals: 6, network: TEMPO, payTo: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2" }, destination: dest },
    ...(options.withX402Sol === true ? { "r-sol": { routeId: "r-sol", canonicalPath: "/v1/routes/r-sol/resource", rail: "x402", sourceRail: "x402", source: { amount: "10000", asset: MINT, decimals: 6, network: SOL, payTo: owner }, destination: dest } } : {}),
  };
  // 受信（source）と送信（destination）の両方の区分。SOL/MINT は x402 SVM 受信と MPP Solana 受信が共有する区分（通算の試験は `maxTotal` で絞る）。
  const buckets = [
    { network: BASE, asset: USDC, maxTotal: "100000", maxPerPurchase: "10000" },
    { network: SOL, asset: MINT, maxTotal: options.maxTotal ?? "100000", maxPerPurchase: "10000" },
    { network: TEMPO, asset: PATHUSD, maxTotal: "100000", maxPerPurchase: "10000" },
  ];
  const document = {
    router: {
      approvalTtlMs: 60_000,
      routes,
      budget: { maxPurchases: 10, buckets },
      dynamic: {
        enabled: true,
        profiles: {
          "dyn-solmpp-to-x402": { profileId: "dyn-solmpp-to-x402", sourceRail: "mpp", source: { network: SOL, asset: MINT, decimals: 6, payTo: owner }, rail: "x402", destination: { scheme: "exact", network: BASE, asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } }, par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } },
          "dyn-mpp-to-x402": { profileId: "dyn-mpp-to-x402", sourceRail: "mpp", source: { network: TEMPO, asset: PATHUSD, decimals: 6, payTo: "0x9b10584FE6dEE57E843104D2bAc214C6D507F8a2" }, rail: "x402", destination: { scheme: "exact", network: BASE, asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } }, par: true, maxUpstreamAmount: "10000", fee: { flat: "1000", bps: 0, min: "1000" } },
        },
        budget: { maxPurchases: 10, buckets: [{ network: BASE, asset: USDC, maxTotal: "100000", maxPerPurchase: "20000" }, { network: SOL, asset: MINT, maxTotal: "100000", maxPerPurchase: "20000" }, { network: TEMPO, asset: PATHUSD, maxTotal: "100000", maxPerPurchase: "20000" }] },
        denyHosts: [],
      },
    },
    x402: {
      upstreams: Object.fromEntries(Object.keys(routes).map((routeId) => [routeId, "https://upstream.test/v1/x"])),
      ...(options.withX402Sol === true ? { inboundFacilitators: { [SOL]: { kind: "x402", url: `https://${SVM_FAC_HOST}` } } } : {}),
    },
  };
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  const env: Record<string, string> = {
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_PRINCIPAL_TOKENS: "judge:public",
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha.other.test",
    ROUTER_X402_INBOUND_FACILITATOR_URL: "https://legacy.facilitator.test",
    ROUTER_MPP_INBOUND_SECRET: SECRET,
    ROUTER_SOLANA_RPC_URL: options.solanaRpc ?? `http://${RPC_HOST}`,
    ROUTER_CANONICAL_BASE_URL: "https://router.test",
    ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
    ROUTER_HTTP_PORT: "0",
  };
  const config = loadRuntimeConfig(env, (file) => readFileSync(file, "utf8"), { networks: TEST_NETWORKS });
  const dialed: string[] = [];
  const ports = new Map<string, number>([[RPC_HOST, rpc.port], ...(svmFac === undefined ? [] : [[SVM_FAC_HOST, svmFac.port] as [string, number]])]);
  const hooks: DynamicTransportHooks = {
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: (_hostname, _options, callback) => callback(null, [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }]),
    dialForTest: (target) => {
      dialed.push(target.hostname);
      const port = ports.get(target.hostname);
      if (port === undefined) throw new UnmappedFixtureHostError();
      return { host: "127.0.0.1", port };
    },
  };
  const capabilities: RouterCapabilities = { evmSigning: createRealEvmCapability(generatePrivateKey()).capability(BASE), knownNetworksForTest: TEST_NETWORKS, transportHooksForTest: hooks, dynamicTransportHooksForTest: hooks };
  const rails = composeRails(config, capabilities, () => {}, () => {});
  return { config, rails, rpc, payer, dir, dialed };
}

type OkQuote = Extract<QuoteOutcome, { ok: true }>;
const opened: RouterCore[] = [];
afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.close();
});

async function coreOf(c: Composed, outbound: OutboundRail = new StubOutbound()): Promise<RouterCore> {
  await c.rails.startup!();
  const core = await createRouterCore({ journalPath: c.config.journalPath, config: c.config.router, inbound: c.rails.inbound, outbound, note: () => {}, dynamic: { ledgerDir: path.join(c.dir, "dynamic-quotes") }, onStoreLoaded: c.rails.bindConsumed });
  opened.push(core);
  return core;
}

async function staticQuote(core: RouterCore, routeId: string, requestId: string): Promise<OkQuote> {
  const outcome = await core.quote({ principalId: "judge", requestId, routeId });
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  return outcome as OkQuote;
}

async function dynamicQuote(core: RouterCore, profileId: string, requestId: string): Promise<OkQuote> {
  const outcome = await core.quote({ principalId: "judge", requestId, routeId: profileId, upstream: { url: "https://provider.test/v1/price" }, source: "judge" });
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  return outcome as OkQuote;
}

function purchaseArgs(quote: OkQuote, requestId: string, credential: PaymentCredential) {
  return { principalId: "judge", requestId, quoteId: quote.quoteId, approval: quote.quoteId, credential, ...(quote.ownerKey === undefined ? {} : { ownerKey: quote.ownerKey }), source: "judge" };
}

describe("合成: Solana の MPP 受信（設計 §2.2・§2.3・§3.6）", () => {
  it("静的 route とプロファイルが同じ adapter を共有し、startup は ATA を 1 回だけ読む。Tempo の MPP 受信は今までどおり別の adapter。両型 × 静的・動的の 4 組で source_settled → 送信（stub）で delivered。同じ quote の並行 purchase は core の lock で 1 回の送出", async () => {
    const c = await compose();
    expect(c.rails.startup).toBeDefined();
    const outbound = new StubOutbound();
    const core = await coreOf(c, outbound);
    expect(c.rpc.calls).toEqual([{ method: "getAccountInfo", params: [ownerAta, { encoding: "jsonParsed", commitment: "confirmed" }] }]);
    // 静的: transaction 型。
    c.rpc.state.signatureStatuses = ["confirmed"];
    const q1 = await staticQuote(core, "r-solmpp", "req-1");
    expect(q1.source.offer).toMatchObject({ scheme: MPP_SOLANA_SCHEME, network: SOL, asset: MINT, payTo: owner, amount: "10000" });
    expect(q1.source.offer.extra["fundsMoveOnCredential"]).toBe(true);
    const cred1 = await c.payer.credentialFor(q1.source.offer);
    // 同じ quote・同じ credential の並行 purchase: core の lock で直列、2 件目は同じ結果を返す。送出は 1 回。
    const [p1, p1b] = await Promise.all([core.purchase(purchaseArgs(q1, "req-1", cred1)), core.purchase(purchaseArgs(q1, "req-1", cred1))]);
    expect(p1.status, JSON.stringify(p1)).toBe("delivered");
    expect(p1b.status, JSON.stringify(p1b)).toBe("delivered");
    expect(outbound.payCalls).toBe(1);
    expect(c.rpc.state.sent).toHaveLength(1);
    expect(core.status(q1.paymentId, "judge")?.source.txRef).toBe(signatureOfCredential(cred1));
    // 動的: signature 型（`rejected` → `unknown` の写像はここでは出ない: 成功の経路）。
    const q2 = await dynamicQuote(core, "dyn-solmpp-to-x402", "req-2");
    expect(q2.source.offer).toMatchObject({ scheme: MPP_SOLANA_SCHEME, network: SOL, asset: MINT, payTo: owner });
    const cred2 = await c.payer.credentialFor(q2.source.offer, "signature");
    const p2 = await core.purchase(purchaseArgs(q2, "req-2", cred2));
    expect(p2.status, JSON.stringify(p2)).toBe("delivered");
    expect(outbound.payCalls).toBe(2);
    // Tempo の MPP 受信（別の adapter）: offer は tempo/charge のまま。
    const tempo = await staticQuote(core, "r-tempo", "req-3");
    expect(tempo.source.offer.scheme).toBe("tempo/charge");
    expect(tempo.source.offer.extra["fundsMoveOnCredential"]).toBe(true);
    // 残りの 2 組: 静的 × signature 型、動的 × transaction 型。
    const q5 = await staticQuote(core, "r-solmpp", "req-5");
    const cred5 = await c.payer.credentialFor(q5.source.offer, "signature");
    expect((await core.purchase(purchaseArgs(q5, "req-5", cred5))).status).toBe("delivered");
    const q6 = await dynamicQuote(core, "dyn-solmpp-to-x402", "req-6");
    const cred6 = await c.payer.credentialFor(q6.source.offer);
    expect((await core.purchase(purchaseArgs(q6, "req-6", cred6))).status).toBe("delivered");
    expect(outbound.payCalls).toBe(4);
    // 送出は Router の 2 回（transaction 型）+ payer の fixture の 2 回（signature 型）。
    expect(c.rpc.state.sent).toHaveLength(4);
    // journal の集合: 4 つの署名が消費済み。settle を直接呼ぶと rejected（送出しない。signature 型は RPC も読まない）。
    const mark = c.rpc.calls.length;
    for (const [quote, credential] of [[q1, cred1], [q2, cred2], [q5, cred5], [q6, cred6]] as const) {
      expect(await c.rails.inbound.settle(quote.source.offer, credential, { routeId: quote.routeId })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    }
    expect(c.rpc.calls.slice(mark)).toEqual([]);
    expect(c.rpc.state.sent).toHaveLength(4);
    // 再起動（同じ journal に新しい合成と core）: 復元した集合でも rejected。
    await opened.pop()!.close();
    const again = await compose();
    const rpcAgain = again.rpc;
    const restarted = await createRouterCore({ journalPath: c.config.journalPath, config: again.config.router, inbound: (await (async () => { await again.rails.startup!(); return again.rails.inbound; })()), outbound, note: () => {}, dynamic: { ledgerDir: path.join(c.dir, "dynamic-quotes") }, onStoreLoaded: again.rails.bindConsumed });
    opened.push(restarted);
    expect(restarted.status(q1.paymentId, "judge")?.status).toBe("delivered");
    // 署名は旧 fixture に登録されていた transaction。新 fixture には無いが、消費済みの検査は RPC の前（両型）。
    expect(restarted.status(q5.paymentId, "judge")?.status).toBe("delivered");
    for (const [quote, credential] of [[q1, cred1], [q5, cred5], [q6, cred6], [q2, cred2]] as const) {
      expect(await again.rails.inbound.settle(quote.source.offer, credential, { routeId: quote.routeId })).toEqual({ outcome: "rejected", reason: "source_rejected" });
    }
    expect(rpcAgain.state.sent).toEqual([]);
    expect(rpcAgain.calls.map((call) => call.method)).toEqual(["getAccountInfo"]);
  });

  it("core は settle の直前に offer の期限をもう一度見る: verify の後に期限が過ぎた purchase は settle を呼ばず approval_expired（静的・動的とも。証拠の保持 = 期限 + 猶予 の根拠）", async () => {
    const c = await compose();
    await c.rails.startup!();
    let clock = Date.now();
    // verify の中で時計を offer の期限の先に進める（core の verify と settle の間で遅れた purchase）。
    const inbound = { ...c.rails.inbound, verify: async (offer: InboundOffer, credential: PaymentCredential, context?: { routeId: string }) => { const r = await c.rails.inbound.verify(offer, credential, context); clock = offer.extra.expiresAt * 1000 + 1; return r; } };
    const core = await createRouterCore({ journalPath: c.config.journalPath, config: c.config.router, inbound, outbound: new StubOutbound(), note: () => {}, now: () => clock, dynamic: { ledgerDir: path.join(c.dir, "dynamic-quotes") }, onStoreLoaded: c.rails.bindConsumed });
    opened.push(core);
    const q1 = await staticQuote(core, "r-solmpp", "req-1");
    const cred1 = await c.payer.credentialFor(q1.source.offer, "signature");
    expect(await core.purchase(purchaseArgs(q1, "req-1", cred1))).toMatchObject({ status: "awaiting_payment", code: "approval_expired" });
    clock = Date.now();
    const q2 = await dynamicQuote(core, "dyn-solmpp-to-x402", "req-2");
    const cred2 = await c.payer.credentialFor(q2.source.offer);
    expect(await core.purchase(purchaseArgs(q2, "req-2", cred2))).toMatchObject({ status: "awaiting_payment", code: "approval_expired" });
    // settle は呼ばれていない: 送出は payer の fixture の 1 回（signature 型）だけ。
    expect(c.rpc.state.sent).toHaveLength(1);
  });

  it("core は予約・昇格の追記の後、settle を呼ぶ直前にも期限を見る: 最初の再検査を期限の直前に通り、追記の間に期限が過ぎた purchase は settle を呼ばず approval_expired（静的・動的）", async () => {
    const c = await compose();
    await c.rails.startup!();
    let clock = Date.now();
    let advance = false;
    // verify の中で時計を「期限の 2 ms 前」に置く。予約（静的）／source_pending（動的）の行が journal に現れた後の読みは期限ちょうど:
    // settle 前の 1 回目の再検査は通り、追記の後の 2 回目で止まる。
    // 期限 = min(承認の期限, offer の期限)（core の `approvalDeadlineMs`）。quote の応答から取る。
    let deadlineMs = 0;
    /** 時計が期限を過ぎる合図: journal にこの行（event:paymentId）が現れたら（= 予約／昇格の追記の後）。それまでは期限の 2 ms 前。 */
    let trigger = "";
    const journalHas = (needle: string): boolean => { try { return readFileSync(c.config.journalPath, "utf8").split("\n").some((l) => l !== "" && (JSON.parse(l) as { event: string; paymentId: string }).event === needle.split(":")[0] && (JSON.parse(l) as { paymentId: string }).paymentId === needle.split(":")[1]); } catch { return false; } };
    const inbound = { ...c.rails.inbound, verify: async (offer: InboundOffer, credential: PaymentCredential, context?: { routeId: string }) => { const r = await c.rails.inbound.verify(offer, credential, context); clock = deadlineMs - 2; advance = true; return r; } };
    const core = await createRouterCore({ journalPath: c.config.journalPath, config: c.config.router, inbound, outbound: new StubOutbound(), note: () => {}, now: () => (advance && journalHas(trigger) ? deadlineMs : clock), dynamic: { ledgerDir: path.join(c.dir, "dynamic-quotes") }, onStoreLoaded: c.rails.bindConsumed });
    opened.push(core);
    const journal = () => readFileSync(c.config.journalPath, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { event: string; patch: Record<string, unknown> });
    const q1 = await staticQuote(core, "r-solmpp", "req-1");
    deadlineMs = Math.min(q1.approval.deadlineMs, q1.source.offer.extra.expiresAt * 1000);
    trigger = `budget_reserved:${q1.paymentId}`;
    const cred1 = await c.payer.credentialFor(q1.source.offer, "signature");
    expect(await core.purchase(purchaseArgs(q1, "req-1", cred1))).toMatchObject({ status: "awaiting_payment", code: "approval_expired" });
    // 静的: 予約（budget_reserved）の**後**に source_failed（= 2 回目の再検査で止まった。1 回目なら予約の前で終わる）。
    const staticEvents = journal().map((l) => l.event);
    expect(staticEvents.indexOf("source_failed")).toBeGreaterThan(staticEvents.indexOf("budget_reserved"));
    expect(staticEvents.indexOf("budget_reserved")).toBeGreaterThan(-1);
    advance = false;
    clock = Date.now();
    const q2 = await dynamicQuote(core, "dyn-solmpp-to-x402", "req-2");
    deadlineMs = Math.min(q2.approval.deadlineMs, q2.source.offer.extra.expiresAt * 1000);
    trigger = `source_pending:${q2.paymentId}`;
    const cred2 = await c.payer.credentialFor(q2.source.offer);
    expect(await core.purchase(purchaseArgs(q2, "req-2", cred2))).toMatchObject({ status: "awaiting_payment", code: "approval_expired" });
    // 動的: 昇格（created）と source_pending の**後**に source_failed（1 回目の再検査なら昇格の前で終わり、行は増えない）。
    const dynamicEvents = journal().slice(staticEvents.length).map((l) => l.event);
    expect(dynamicEvents.indexOf("source_pending")).toBeGreaterThan(-1);
    expect(dynamicEvents.indexOf("source_failed")).toBeGreaterThan(dynamicEvents.indexOf("source_pending"));
    // settle は呼ばれていない（送出は payer の fixture の 1 回だけ）。
    expect(c.rpc.state.sent).toHaveLength(1);
    expect(journal().filter((l) => l.event === "source_failed").map((l) => l.patch)).toEqual([{ outcome: "not_sent", reason: "approval_expired" }, { outcome: "not_sent", reason: "approval_expired" }]);
  });

  it("bind の前（`onStoreLoaded` を渡さない core）: verify は通るが settle が throw → 静的の core は unknown（source_settle_unknown）。送出しない", async () => {
    const c = await compose();
    await c.rails.startup!();
    const core = await createRouterCore({ journalPath: c.config.journalPath, config: c.config.router, inbound: c.rails.inbound, outbound: new StubOutbound(), note: () => {}, dynamic: { ledgerDir: path.join(c.dir, "dynamic-quotes") } });
    opened.push(core);
    const q = await staticQuote(core, "r-solmpp", "req-1");
    const cred = await c.payer.credentialFor(q.source.offer);
    const p = await core.purchase(purchaseArgs(q, "req-1", cred));
    expect(p).toMatchObject({ status: "unknown", terminalReason: "source_settle_unknown" });
    expect(c.rpc.state.sent).toEqual([]);
  });

  it("§3.6 の写像: 送出後に confirmed + err（source_rejected）は静的で awaiting_payment（code source_rejected）、動的では unknown。HMAC 改竄は verify_failed（両方とも awaiting_payment。journal に乗るが送出しない）", async () => {
    const c = await compose();
    const core = await coreOf(c);
    c.rpc.state.signatureStatuses = ["err-confirmed"];
    const q1 = await staticQuote(core, "r-solmpp", "req-1");
    const cred1 = await c.payer.credentialFor(q1.source.offer);
    expect(await core.purchase(purchaseArgs(q1, "req-1", cred1))).toMatchObject({ status: "awaiting_payment", code: "source_rejected" });
    const q2 = await dynamicQuote(core, "dyn-solmpp-to-x402", "req-2");
    const cred2 = await c.payer.credentialFor(q2.source.offer);
    expect(await core.purchase(purchaseArgs(q2, "req-2", cred2))).toMatchObject({ status: "unknown", terminalReason: "source_rejected" });
    expect(c.rpc.state.sent).toHaveLength(2);
    // HMAC 改竄 → verify_failed（送出しない）。
    const q3 = await staticQuote(core, "r-solmpp", "req-3");
    const cred3 = await c.payer.credentialFor(q3.source.offer);
    const decoded = Credential.deserialize(wireOf(cred3));
    const tampered: PaymentCredential = { ...cred3, payload: { ...cred3.payload, credential: Credential.serialize({ ...decoded, challenge: { ...decoded.challenge, request: { ...(decoded.challenge.request as Record<string, unknown>), amount: "1" } } } as never) } };
    expect(await core.purchase(purchaseArgs(q3, "req-3", tampered))).toMatchObject({ status: "awaiting_payment", code: "verify_failed" });
    const q4 = await dynamicQuote(core, "dyn-solmpp-to-x402", "req-4");
    const cred4 = await c.payer.credentialFor(q4.source.offer);
    const decoded4 = Credential.deserialize(wireOf(cred4));
    const tampered4: PaymentCredential = { ...cred4, payload: { ...cred4.payload, credential: Credential.serialize({ ...decoded4, challenge: { ...decoded4.challenge, request: { ...(decoded4.challenge.request as Record<string, unknown>), amount: "1" } } } as never) } };
    expect(await core.purchase(purchaseArgs(q4, "req-4", tampered4))).toMatchObject({ status: "awaiting_payment", code: "verify_failed" });
    expect(c.rpc.state.sent).toHaveLength(2);
  });

  it("x402 SVM 受信（r-sol）と MPP Solana 受信（r-solmpp）は同じ受信の区分（Solana devnet USDC）を通算する: 上限 2 件分で 3 件目の purchase は予約で止まる（送出しない）。startup は ATA 2 回（x402 と MPP の adapter が各 1 回）", async () => {
    const c = await compose({ withX402Sol: true, maxTotal: "20000" });
    const core = await coreOf(c);
    expect(c.rpc.calls.map((call) => call.method)).toEqual(["getAccountInfo", "getAccountInfo"]);
    c.rpc.state.signatureStatuses = ["confirmed"];
    const q1 = await staticQuote(core, "r-solmpp", "req-1");
    const cred1 = await c.payer.credentialFor(q1.source.offer);
    expect((await core.purchase(purchaseArgs(q1, "req-1", cred1))).status).toBe("delivered");
    // 上限 20000 = 受信 10000 × 2 件。2 件目は x402 SVM 受信で。
    const q2 = await staticQuote(core, "r-sol", "req-2");
    const svmPayer = await createSvmTestPayer(MINT);
    const policy = { feePayer: String(q2.source.offer.extra["feePayer"]), payTo: owner, destinationAta: ownerAta, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM };
    const cred2: PaymentCredential = { x402Version: 2, accepted: q2.source.offer, payload: { challengeNonce: q2.source.offer.extra.challengeNonce, transaction: await svmPayer.build(policy, q2.source.offer.amount, q2.source.offer.extra["memo"] as string) } };
    expect((await core.purchase(purchaseArgs(q2, "req-2", cred2))).status).toBe("delivered");
    expect(c.rpc.state.sent).toHaveLength(1);
    const q3 = await staticQuote(core, "r-solmpp", "req-3");
    const cred3 = await c.payer.credentialFor(q3.source.offer);
    const third = await core.purchase(purchaseArgs(q3, "req-3", cred3));
    expect(third).toMatchObject({ status: "awaiting_payment", code: "bucket_limit" });
    expect(c.rpc.state.sent).toHaveLength(1);
  });

  it("Tempo と Solana の MPP 受信が混在する構成: Tempo の RPC だけが受信 MPP の chain として拒否ホストに入り、Solana の RPC は Solana の RPC として拒否ホストに入る（dynamic.verify が通る）", async () => {
    const c = await compose({ solanaRpc: "https://sol-rpc.test/" });
    await expect(c.rails.dynamic!.verify()).resolves.toBeUndefined();
    // 拒否ホスト（動的の URL の規則）: Solana の RPC と Tempo の既知の公開 RPC。
    const { DynamicChallengeError } = await import("../../src/adapters/outbound/x402-dynamic.js");
    for (const url of ["https://sol-rpc.test/x", "https://rpc.moderato.tempo.xyz/"]) {
      const error = await c.rails.outbound.readChallenge("dyn-mpp-to-x402", { url }).then(() => undefined, (e: unknown) => e);
      expect(error, url).toBeInstanceOf(DynamicChallengeError);
      expect((error as InstanceType<typeof DynamicChallengeError>).reason, url).toBe("url");
    }
  });
});
