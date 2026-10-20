/**
 * 秘匿購入の MPP（Tempo）pull 送信 adapter（設計 §6.2、要件 FR-Z05・FR-Z08・TR-1）。
 * 実 SDK（mppx 0.11.0 の pull 経路）に偽 RPC（`tempo-rpc.ts`、実際の形の応答）で署名だけさせ、放送 0 回・署名 1 回・RPC は列挙した読取だけであることを数える。
 * 鍵は毎回の乱数（実署名）。資金は動かない。challenge は実 `mppx/server` が発行する。
 */
import { Challenge, Credential, Receipt } from "mppx";
import { Mppx, tempo } from "mppx/server";
import { TxEnvelopeTempo } from "ox/tempo";
import { createClient, encodeFunctionData, http as viemHttp, keccak256, maxUint256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Abis } from "viem/tempo";
import { tempoModerato } from "viem/tempo/chains";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { approvedTransferOf, checkDynamicMppChallenge, checkRawTempoTransfer, comparableMetaOf, createGuardedTempoAccount, TempoSigningRefusedError } from "../../src/adapters/outbound/mpp-dynamic.js";
import { attributionMemoOf, createPrivateMppRail, expectedTransferDataOf, PRIVATE_RPC_READ_METHODS, privateReadOnlyRequestOf } from "../../src/adapters/outbound/private-mpp.js";
import type { DynamicProfile } from "../../src/config.js";
import { createGuardedTransport, type GuardedTransport } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, MppTempoCapability } from "../../src/ports/outbound.js";
import { createRealMppCapability } from "../../tools/real-mpp-capability.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { MPP_FIXTURE_CHAIN_ID, MPP_FIXTURE_CURRENCY, MPP_FIXTURE_RECIPIENT } from "../fixtures/dynamic/mpp-upstream.js";
import { startTempoRpc, type TempoRpc } from "../fixtures/dynamic/tempo-rpc.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const PROFILE_ID = "priv-tempo";
const OPERATOR_PAY_TO = "0x00000000000000000000000000000000000000b0";
const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "x402",
  source: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, payTo: OPERATOR_PAY_TO },
  rail: "mpp",
  destination: { scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: MPP_FIXTURE_CURRENCY, decimals: 6, feeAsset: MPP_FIXTURE_CURRENCY, maxFee: "5000" },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "1000", bps: 0, min: "1000" },
};
const HOST = "test-server.io";
const URL_POST = `https://${HOST}/select`;
const RPC_HOST = "rpc.other.test";
const REALM = HOST;

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls({ extraProviderNames: [HOST] });
});
afterAll(() => {
  TLS.cleanup();
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

/** 実 `mppx/server` の challenge（pull だけ・scope 付き）。 */
async function challengeHeaderOf(rpcUrl: string, options: { modes?: readonly string[]; feePayer?: boolean; scope?: string; amount?: string; meta?: Record<string, unknown>; expiresInMs?: number } = {}): Promise<string> {
  const client = createClient({ chain: { ...tempoModerato, id: MPP_FIXTURE_CHAIN_ID } as never, transport: viemHttp(rpcUrl, { retryCount: 0 }) });
  const server = Mppx.create({
    secretKey: "fixture-secret-0123456789abcdef0123456789abcdef",
    realm: REALM,
    methods: [
      tempo.charge({
        recipient: MPP_FIXTURE_RECIPIENT,
        currency: MPP_FIXTURE_CURRENCY,
        decimals: 0,
        getClient: () => client as never,
        ...(options.modes === undefined ? {} : { supportedModes: options.modes }),
        ...(options.feePayer === true ? { feePayer: privateKeyToAccount(generatePrivateKey()) } : {}),
      } as never),
    ],
  }) as unknown as { challenge: { tempo: { charge(parameters: Record<string, unknown>): Promise<Record<string, unknown>> } } };
  const scope = options.scope ?? `POST ${URL_POST}`;
  const challenge = await server.challenge.tempo.charge({ amount: options.amount ?? "1000", chainId: MPP_FIXTURE_CHAIN_ID, expires: new Date(Date.now() + (options.expiresInMs ?? 600_000)).toISOString(), scope, meta: { _mppx_scope: scope, ...options.meta } });
  return Challenge.serialize(challenge as never);
}

interface Harness {
  readonly rpc: TempoRpc;
  readonly rail: ReturnType<typeof createPrivateMppRail>;
  readonly capability: MppTempoCapability;
  readonly address: `0x${string}`;
  signatures(): number;
  /** 探りの応答（WWW-Authenticate）。 */
  challenge: string;
  readonly probes: { url: string; init: RequestInit | undefined }[];
}

async function harness(): Promise<Harness> {
  const rpc = await startTempoRpc({ tls: TLS });
  closers.push(rpc.close);
  const inner = createGuardedTransport({
    allowLoopback: false,
    report: () => {},
    dns: { timeoutMs: 3_000, maxInFlight: 16 },
    lookup: publicLookup(),
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    dialForTest: dialTo({ [RPC_HOST]: rpc.port }),
  });
  const probes: Harness["probes"] = [];
  const state = { challenge: "" };
  // 探り（上流）は spy で応える。RPC は実 TCP（TLS の fixture）で偽 RPC へ。
  const transport: GuardedTransport = {
    allowLoopback: false,
    boundsDns: true,
    report: inner.report,
    fetch: async (url, init, context) => {
      if (new URL(String(url)).hostname === HOST) {
        probes.push({ url: String(url), init });
        return new Response(JSON.stringify({ title: "Payment Required", status: 402 }), { status: 402, headers: { "content-type": "application/problem+json", "www-authenticate": state.challenge } });
      }
      return inner.fetch(url, init, context);
    },
  };
  const key = generatePrivateKey();
  const real = createRealMppCapability(key, { rpcUrl: `https://${RPC_HOST}`, chainId: MPP_FIXTURE_CHAIN_ID });
  const base = real.capability();
  let signatures = 0;
  const countingAccount = {
    ...base.account,
    signTransaction: async (transaction: unknown, options?: unknown) => {
      signatures += 1;
      return (base.account as unknown as { signTransaction(t: unknown, o?: unknown): Promise<Hex> }).signTransaction(transaction, options);
    },
  };
  const capability: MppTempoCapability = { ...base, account: countingAccount as never };
  const rail = createPrivateMppRail(capability, { profiles: { [PROFILE_ID]: PROFILE }, transport });
  return {
    rpc,
    rail,
    capability,
    address: real.address,
    signatures: () => signatures,
    get challenge() {
      return state.challenge;
    },
    set challenge(value: string) {
      state.challenge = value;
    },
    probes,
  };
}

describe("discover（pull を提供する challenge だけ。FR-Z16・§6.2）", () => {
  test("pull だけの challenge は候補、探りは `{}` の POST で支払いヘッダ無し", async () => {
    const h = await harness();
    h.challenge = await challengeHeaderOf(h.rpc.plainUrl, { modes: ["pull"] });
    const found = await h.rail.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" });
    expect(h.probes).toHaveLength(1);
    expect(h.probes[0]!.init).toMatchObject({ method: "POST", body: "{}" });
    expect(Object.keys((h.probes[0]!.init!.headers as Record<string, string>) ?? {}).map((key) => key.toLowerCase())).not.toContain("authorization");
    expect(found.offers).toHaveLength(1);
    expect(found.offers[0]).toMatchObject({ scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: MPP_FIXTURE_CURRENCY, amount: "1000", payTo: MPP_FIXTURE_RECIPIENT });
  });
  test("push だけ・feePayer・scope 違いは候補外", async () => {
    const h = await harness();
    h.challenge = await challengeHeaderOf(h.rpc.plainUrl, { modes: ["push"] });
    expect((await h.rail.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" })).offers).toEqual([]);
    h.challenge = await challengeHeaderOf(h.rpc.plainUrl, { modes: ["pull"], feePayer: true });
    expect((await h.rail.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" })).offers).toEqual([]);
    h.challenge = await challengeHeaderOf(h.rpc.plainUrl, { modes: ["pull"], scope: `GET ${URL_POST}` });
    expect((await h.rail.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" })).offers).toEqual([]);
    // `checkDynamicMppChallenge` の既定（push・GET）は従来のまま: pull-only は候補外。
    const [parsed] = Challenge.deserializeList(await challengeHeaderOf(h.rpc.plainUrl, { modes: ["pull"], scope: `GET ${URL_POST}` }));
    expect(checkDynamicMppChallenge(parsed, PROFILE, [], URL_POST, Date.now())).toEqual({ ok: false, reason: "pull_only" });
    expect(checkDynamicMppChallenge(parsed, PROFILE, [], URL_POST, Date.now(), { mode: "pull", method: "GET" }).ok).toBe(true);
  });
});

describe("再照合の比較条件（offer の `extra.terms`）: 402 ごとに変わる id・expires・`_mppx_nonce` は条件ではない", () => {
  test("nonce と id・expires だけが違う 2 つの challenge は同じ offer。scope が違えば候補外（受入 live-F-20261021 の `offer_changed` の再現と修正）", async () => {
    const h = await harness();
    const [a] = Challenge.deserializeList(await challengeHeaderOf(h.rpc.plainUrl, { modes: ["pull"], meta: { _mppx_nonce: `0x${"a1".repeat(32)}` } }));
    const [b] = Challenge.deserializeList(await challengeHeaderOf(h.rpc.plainUrl, { modes: ["pull"], meta: { _mppx_nonce: `0x${"b2".repeat(32)}` } }));
    expect((a as unknown as { id: string }).id).not.toBe((b as unknown as { id: string }).id);
    expect((a as unknown as { opaque: string }).opaque).not.toBe((b as unknown as { opaque: string }).opaque);
    const ca = checkDynamicMppChallenge(a, PROFILE, [], URL_POST, Date.now(), { mode: "pull", method: "POST" });
    const cb = checkDynamicMppChallenge(b, PROFILE, [], URL_POST, Date.now(), { mode: "pull", method: "POST" });
    expect(ca.ok && cb.ok, JSON.stringify([ca, cb])).toBe(true);
    if (!ca.ok || !cb.ok) return;
    expect(JSON.stringify(ca.offer)).toBe(JSON.stringify(cb.offer));
    expect(JSON.stringify(ca.offer)).not.toContain("_mppx_nonce");
    expect(JSON.stringify(ca.offer)).toContain("_mppx_scope");
    // 発行時は承認した offer（a）と一致する**新しい** challenge（新しい id・opaque・expires）が選ばれ、credential はその新しい id と opaque を運ぶ（discover → issueCredential の経路）。
    h.challenge = await challengeHeaderOf(h.rpc.plainUrl, { modes: ["pull"], meta: { _mppx_nonce: `0x${"c3".repeat(32)}` }, expiresInMs: 300_000 });
    const found = await h.rail.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" });
    expect(found.offers.map((o) => JSON.stringify(o))).toEqual([JSON.stringify(ca.offer)]);
    const [fresh] = Challenge.deserializeList(h.challenge) as unknown as { id: string; opaque: string; expires: string }[];
    expect(fresh!.id).not.toBe((a as unknown as { id: string }).id);
    expect(fresh!.expires).not.toBe((a as unknown as { expires: string }).expires);
    const issued = await h.rail.issueCredential({ profileId: PROFILE_ID, offer: ca.offer, target: { url: URL_POST, method: "POST", body: "{}" }, challenge: found.challenge, deadlineMs: Date.now() + 60_000, maxFee: "5000" });
    expect(issued.ok, JSON.stringify(issued)).toBe(true);
    if (!issued.ok) return;
    const credential = Credential.deserialize(issued.issued.value) as unknown as { challenge: { id: string; opaque: string }; payload: { signature: Hex } };
    expect(credential.challenge.id).toBe(fresh!.id);
    expect(credential.challenge.opaque).toBe(fresh!.opaque);
    // memo は新しい challenge の id に束縛される。
    const envelope = TxEnvelopeTempo.deserialize(credential.payload.signature as never) as unknown as { calls: { data: Hex }[] };
    expect(envelope.calls[0]!.data.toLowerCase()).toBe(expectedTransferDataOf(MPP_FIXTURE_RECIPIENT, 1000n, attributionMemoOf(fresh!.id, REALM)).toLowerCase());
    const [other] = Challenge.deserializeList(await challengeHeaderOf(h.rpc.plainUrl, { modes: ["pull"], scope: "POST https://provider.test/other", meta: { _mppx_nonce: `0x${"d4".repeat(32)}` } }));
    expect(checkDynamicMppChallenge(other, PROFILE, [], URL_POST, Date.now(), { mode: "pull", method: "POST" })).toEqual({ ok: false, reason: "scope" });
    expect(comparableMetaOf(null)).toBeNull();
    expect(comparableMetaOf({ _mppx_scope: "x", _mppx_nonce: "0x1", other: 1 })).toEqual({ _mppx_scope: "x", other: 1 });
  });
});

describe("issueCredential（署名 1 回・放送 0 回・RPC は列挙した読取だけ）", () => {
  test("pinned SDK の pull 経路で credential を作り、独立検査を通す", async () => {
    const h = await harness();
    h.challenge = await challengeHeaderOf(h.rpc.plainUrl, { modes: ["pull"] });
    const found = await h.rail.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" });
    const offer = found.offers[0]!;
    const methodsBefore = h.rpc.methods.length;
    const result = await h.rail.issueCredential({ profileId: PROFILE_ID, offer, target: { url: URL_POST, method: "POST", body: "{}" }, challenge: found.challenge, deadlineMs: Date.now() + 60_000, maxFee: "5000" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 放送 0・署名 1・RPC は allowlist の中だけ（実際に呼ばれた集合を固定する）。
    expect(h.rpc.sentRaw).toHaveLength(0);
    expect(h.signatures()).toBe(1);
    const called = h.rpc.methods.slice(methodsBefore);
    expect(called.length).toBeGreaterThan(0);
    for (const method of called) expect(PRIVATE_RPC_READ_METHODS.has(method), method).toBe(true);
    expect(called).toContain("eth_getBlockByNumber");
    // credential の形: Authorization: Payment …、payload は署名済み envelope。
    expect(result.issued.name).toBe("Authorization");
    expect(result.issued.value.startsWith("Payment ")).toBe(true);
    const credential = Credential.deserialize(result.issued.value) as unknown as { payload: { type: string; signature: Hex }; challenge: { id: string } };
    expect(credential.payload.type).toBe("transaction");
    const raw = credential.payload.signature;
    expect(result.issued.expectedRef).toBe(keccak256(raw));
    const envelope = TxEnvelopeTempo.deserialize(raw as never) as unknown as { chainId: number; feeToken: string; nonceKey: bigint; validBefore: number; calls: { to: string; data: Hex }[]; from: string };
    expect(envelope.chainId).toBe(MPP_FIXTURE_CHAIN_ID);
    expect(envelope.feeToken.toLowerCase()).toBe(MPP_FIXTURE_CURRENCY.toLowerCase());
    expect(envelope.nonceKey).toBe(maxUint256);
    expect(result.issued.expiresAtMs).toBe(envelope.validBefore * 1000);
    expect(result.issued.expiresAtMs).toBeGreaterThan(Date.now());
    expect(envelope.from.toLowerCase()).toBe(h.address.toLowerCase());
    // calldata は Router が組んだ期待値（challenge に束縛した Attribution memo）と完全一致 = SDK の memo と Router の再実装が一致している。
    expect(envelope.calls).toHaveLength(1);
    expect(envelope.calls[0]!.data.toLowerCase()).toBe(expectedTransferDataOf(MPP_FIXTURE_RECIPIENT, 1000n, attributionMemoOf(credential.challenge.id, REALM)).toLowerCase());
  });
  test("cap が無い・天井超過・再照合で消えた offer は署名 0 回で止まる", async () => {
    const h = await harness();
    h.challenge = await challengeHeaderOf(h.rpc.plainUrl, { modes: ["pull"] });
    const found = await h.rail.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" });
    const offer = found.offers[0]!;
    const target = { url: URL_POST, method: "POST" as const, body: "{}" };
    expect(await h.rail.issueCredential({ profileId: PROFILE_ID, offer, target, challenge: found.challenge, deadlineMs: Date.now() + 60_000 })).toEqual({ ok: false, reason: "destination_fee_cap_invalid", signed: false });
    expect(await h.rail.issueCredential({ profileId: PROFILE_ID, offer, target, challenge: found.challenge, deadlineMs: Date.now() + 60_000, maxFee: "5001" })).toEqual({ ok: false, reason: "destination_fee_cap_invalid", signed: false });
    expect(await h.rail.issueCredential({ profileId: PROFILE_ID, offer: { ...offer, amount: "2000" }, target, challenge: found.challenge, deadlineMs: Date.now() + 60_000, maxFee: "5000" })).toEqual({ ok: false, reason: "destination_offer_changed", signed: false });
    expect(h.signatures()).toBe(0);
    expect(h.rpc.sentRaw).toHaveLength(0);
  });
  test("承認の期限を過ぎていれば署名の前に止まる", async () => {
    const h = await harness();
    h.challenge = await challengeHeaderOf(h.rpc.plainUrl, { modes: ["pull"] });
    const found = await h.rail.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" });
    const result = await h.rail.issueCredential({ profileId: PROFILE_ID, offer: found.offers[0]!, target: { url: URL_POST, method: "POST", body: "{}" }, challenge: found.challenge, deadlineMs: Date.now() - 1, maxFee: "5000" });
    expect(result).toEqual({ ok: false, reason: "destination_deadline", signed: false });
    expect(h.signatures()).toBe(0);
    expect(h.rpc.sentRaw).toHaveLength(0);
  });
});

describe("読取専用の RPC guard（§6.2 1）", () => {
  test("列挙した読取だけを params の JSON 写しで送り、送出・署名・wallet・未知・予算切れは例外", async () => {
    const sent: { method: string; params?: unknown }[] = [];
    let clock = 1000;
    const guard = privateReadOnlyRequestOf(async (method, params) => {
      sent.push({ method, params });
      return "ok";
    }, { now: () => clock, deadlineMs: 2000 });
    const params = ["latest", false];
    expect(await guard({ method: "eth_getBlockByNumber", params })).toBe("ok");
    expect(sent[0]).toEqual({ method: "eth_getBlockByNumber", params: ["latest", false] });
    expect(sent[0]!.params).not.toBe(params);
    for (const method of ["eth_sendRawTransaction", "eth_sendRawTransactionSync", "eth_sendTransaction", "eth_signTransaction", "eth_sign", "personal_sign", "wallet_sendCalls", "tempo_unknown", "eth_getLogs"]) {
      await expect(guard({ method, params: [] })).rejects.toMatchObject({ reason: "private_rpc_method_refused" });
    }
    await expect(guard({ params: [] })).rejects.toBeInstanceOf(TempoSigningRefusedError);
    clock = 2000;
    await expect(guard({ method: "eth_chainId" })).rejects.toMatchObject({ reason: "destination_rpc_budget_exhausted" });
    expect(sent).toHaveLength(1);
  });
});

describe("署名口の calldata の完全一致（expectedData）と raw の再検査", () => {
  const NOW = Date.now();
  const NOW_S = Math.floor(NOW / 1000);
  const memo = attributionMemoOf("challenge-1", REALM);
  const expectedData = expectedTransferDataOf(MPP_FIXTURE_RECIPIENT, 1000n, memo);
  const OFFER: DestinationOffer = { scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: MPP_FIXTURE_CURRENCY, amount: "1000", payTo: MPP_FIXTURE_RECIPIENT };
  function tx(from: string, data: Hex): Record<string, unknown> {
    return { account: { address: from, type: "local" }, chain: { id: MPP_FIXTURE_CHAIN_ID }, calls: [{ to: MPP_FIXTURE_CURRENCY, data }], chainId: MPP_FIXTURE_CHAIN_ID, from, gas: 54_290n, maxFeePerGas: 1_440_000_001n, maxPriorityFeePerGas: 1n, nonce: 0, nonceKey: maxUint256, validBefore: NOW_S + 25, type: "tempo", feeToken: MPP_FIXTURE_CURRENCY };
  }
  test("期待どおりの calldata は署名し、memo・受取先・額が違う calldata は署名しない", async () => {
    const real = privateKeyToAccount(generatePrivateKey());
    const guard = createGuardedTempoAccount({ account: real, profile: PROFILE, offer: OFFER, maxFee: 5000n, baseFee: 600_000_000n, now: () => NOW, expectedData });
    const otherMemo = encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [MPP_FIXTURE_RECIPIENT, 1000n, attributionMemoOf("challenge-2", REALM)] });
    await expect(guard.account.signTransaction(tx(real.address, otherMemo))).rejects.toMatchObject({ reason: "destination_signing_args_mismatch" });
    const plain = encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [MPP_FIXTURE_RECIPIENT, 1000n] });
    const guard2 = createGuardedTempoAccount({ account: real, profile: PROFILE, offer: OFFER, maxFee: 5000n, baseFee: 600_000_000n, now: () => NOW, expectedData });
    await expect(guard2.account.signTransaction(tx(real.address, plain))).rejects.toMatchObject({ reason: "destination_signing_args_mismatch" });
    const guard3 = createGuardedTempoAccount({ account: real, profile: PROFILE, offer: OFFER, maxFee: 5000n, baseFee: 600_000_000n, now: () => NOW, expectedData });
    const raw = await guard3.account.signTransaction(tx(real.address, expectedData));
    expect(guard3.signatures()).toBe(1);
    const approved = approvedTransferOf(PROFILE, OFFER, real.address, 5000n, expectedData);
    expect(() => checkRawTempoTransfer(raw, approved, NOW)).not.toThrow();
    // 別の期待値（別の challenge の memo）に対しては raw の再検査が落ちる。
    expect(() => checkRawTempoTransfer(raw, approvedTransferOf(PROFILE, OFFER, real.address, 5000n, otherMemo), NOW)).toThrow(TempoSigningRefusedError);
    // 従来（expectedData 無し）の検査は受取先と額だけを見るので通る = 既存の push 経路は不変。
    expect(() => checkRawTempoTransfer(raw, approvedTransferOf(PROFILE, OFFER, real.address, 5000n), NOW)).not.toThrow();
  });
});

describe("checkReceipt（Payment-Receipt の reference = 期待 tx）", () => {
  test("status success・method tempo・reference 一致・payer が自分のときだけ ok", async () => {
    const h = await harness();
    const expectedRef = `0x${"ab".repeat(32)}`;
    const issued = { name: "Authorization" as const, value: "Payment x", expiresAtMs: 0, expectedRef };
    const offer: DestinationOffer = { scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: MPP_FIXTURE_CURRENCY, amount: "1000", payTo: MPP_FIXTURE_RECIPIENT };
    const header = (patch: Record<string, unknown>): string => Receipt.serialize({ method: "tempo", status: "success", reference: expectedRef, timestamp: new Date().toISOString(), ...patch } as never);
    const plainHeader = header({});
    expect(h.rail.checkReceipt(plainHeader, offer, issued)).toEqual({ ok: true, txRef: expectedRef, receiptRef: plainHeader });
    expect(h.rail.checkReceipt(header({ payer: `did:pkh:eip155:${MPP_FIXTURE_CHAIN_ID}:${h.address.toLowerCase()}` }), offer, issued)).toMatchObject({ ok: true });
    expect(h.rail.checkReceipt(header({ reference: `0x${"cd".repeat(32)}` }), offer, issued)).toEqual({ ok: false, reason: "destination_receipt_unverified" });
    expect(h.rail.checkReceipt(header({ status: "pending" }), offer, issued)).toEqual({ ok: false, reason: "destination_receipt_unverified" });
    expect(h.rail.checkReceipt(header({ method: "evm" }), offer, issued)).toEqual({ ok: false, reason: "destination_receipt_unverified" });
    expect(h.rail.checkReceipt(header({ payer: "0x" + "9".repeat(40) }), offer, issued)).toEqual({ ok: false, reason: "destination_receipt_payer_mismatch" });
    expect(h.rail.checkReceipt(header({}), offer, { ...issued, expectedRef: undefined } as never)).toEqual({ ok: false, reason: "destination_receipt_unverified" });
    expect(h.rail.checkReceipt("garbage", offer, issued)).toEqual({ ok: false, reason: "destination_receipt_unverified" });
  });
});
