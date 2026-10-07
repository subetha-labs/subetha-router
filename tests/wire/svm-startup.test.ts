/**
 * SVM 受信の起動時の検査（multirail 設計 §5.1、FR-14・FR-15・FR-18、SR-2。タスク T4-b）。**Linux で受け入れ**（guarded transport の方針）。
 * fixture は loopback（TLS、プロセス内）。transport は本番と同じ方針（loopback 不可・名前解決の fixture・DNS の期限・`dialForTest`）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { address, generateKeyPairSigner } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";

import { ConfigError } from "../../src/config.js";
import { MEMO_PROGRAM_ADDRESS } from "../../src/adapters/inbound/x402-svm.js";
import { assertAtaAccount, assertFeePayerIsolated, feePayerOfSupported, resolveSvmInboundPolicy, SVM_STARTUP_RESPONSE_MAX_BYTES } from "../../src/adapters/inbound/x402-svm-startup.js";
import { createGuardedTransport, type GuardedTransport, type LookupFn } from "../../src/net/guarded-fetch.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";
import { startSvmFacilitator, supportedKind, type SvmFacilitator } from "../fixtures/svm-facilitator.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const FEE_PAYER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const FAC_HOST = "facilitator.provider.test";
const RPC_HOST = "rpc.provider.test";

let TLS: TlsMaterial;
let owner: string;
let ata: string;
beforeAll(async () => {
  TLS = generateTestTls();
  const keypair = await generateKeyPairSigner();
  owner = String(keypair.address);
  ata = String((await findAssociatedTokenPda({ mint: address(MINT), owner: keypair.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
});
afterAll(() => TLS.cleanup());

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function fixtures(options: { ata?: { owner?: string; mint?: string; program?: string } | null } = {}): Promise<{ fac: SvmFacilitator; rpc: SolanaRpcFixture }> {
  const fac = await startSvmFacilitator(TLS, SOL, FEE_PAYER, FAC_HOST);
  closers.push(fac.close);
  const rpc = await startSolanaRpc({
    mint: MINT,
    decimals: 6,
    tls: TLS,
    ...(options.ata === null ? {} : { ata: { address: ata, owner: options.ata?.owner ?? owner, ...(options.ata?.mint === undefined ? {} : { mint: options.ata.mint }), ...(options.ata?.program === undefined ? {} : { program: options.ata.program }) } }),
  });
  closers.push(rpc.close);
  return { fac, rpc };
}

function transportTo(routes: Record<string, number>, options: { lookup?: LookupFn; dnsTimeoutMs?: number } = {}): GuardedTransport {
  return createGuardedTransport({
    allowLoopback: false,
    report: () => {},
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: options.lookup ?? publicLookup(),
    dialForTest: dialTo(routes),
    dns: { timeoutMs: options.dnsTimeoutMs ?? 3_000, maxInFlight: 4 },
  });
}

function inputsOf(fac: SvmFacilitator, rpc: SolanaRpcFixture, extra: Partial<Parameters<typeof resolveSvmInboundPolicy>[0]> = {}) {
  return {
    network: SOL,
    facilitatorUrl: `https://${FAC_HOST}`,
    rpcUrl: `https://${RPC_HOST}`,
    payTo: owner,
    mint: MINT,
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    transport: transportTo({ [FAC_HOST]: fac.port, [RPC_HOST]: rpc.port }),
    ...extra,
  };
}

async function expectConfigError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  expect((caught as Error).message).toMatch(pattern);
  expect((caught as Error).message).not.toContain("SECRET");
}

describe("起動時の検査: 肯定", () => {
  it("/supported から fee payer を 1 つに固定し、ATA を導いて RPC で確かめ、policy を返す。要求は /supported 1 回・RPC 1 回", async () => {
    const { fac, rpc } = await fixtures();
    const policy = await resolveSvmInboundPolicy(inputsOf(fac, rpc));
    expect(policy).toEqual({ feePayer: FEE_PAYER, payTo: owner, destinationAta: ata, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(fac.seen.supportedCalls).toBe(1);
    expect(fac.seen.verifyCalls + fac.seen.settleCalls).toBe(0);
    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0]).toMatchObject({ method: "getAccountInfo", params: [ata, { encoding: "jsonParsed" }] });
    expect(fac.seen.connections).toBe(1);
    expect(rpc.connections()).toBe(1);
  });

  it("/supported に他の network・他の scheme・x402Version 1 の項目が混ざっていても、該当の 1 つだけを使う", async () => {
    const { fac, rpc } = await fixtures();
    fac.state.kinds = [
      { x402Version: 1, scheme: "exact", network: SOL, extra: { feePayer: "11111111111111111111111111111112" } },
      supportedKind("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "11111111111111111111111111111112"),
      { x402Version: 2, scheme: "upto", network: SOL, extra: { feePayer: "11111111111111111111111111111112" } },
      supportedKind(SOL, FEE_PAYER),
      supportedKind(SOL, FEE_PAYER, { smartWalletSupported: true }),
    ];
    expect((await resolveSvmInboundPolicy(inputsOf(fac, rpc))).feePayer).toBe(FEE_PAYER);
  });
});

describe("起動時の検査: /supported の否定（fail closed）", () => {
  it("該当 0 件", async () => {
    const { fac, rpc } = await fixtures();
    fac.state.kinds = [supportedKind("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", FEE_PAYER)];
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /no exact kind/);
    expect(rpc.calls).toHaveLength(0);
  });
  it("feePayer が 2 つ", async () => {
    const { fac, rpc } = await fixtures();
    fac.state.kinds = [supportedKind(SOL, FEE_PAYER), supportedKind(SOL, "11111111111111111111111111111112")];
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /more than one feePayer/);
  });
  it("feePayer が 32 バイトでない・無い", async () => {
    const { fac, rpc } = await fixtures();
    fac.state.kinds = [supportedKind(SOL, "abc")];
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /well-formed feePayer/);
    fac.state.kinds = [{ x402Version: 2, scheme: "exact", network: SOL, extra: {} }];
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /well-formed feePayer/);
  });
  it("feePayer が payTo・ATA・mint・token program・Memo・ComputeBudget のどれかと等しい", async () => {
    const { fac, rpc } = await fixtures();
    for (const collided of [owner, ata, MINT, TOKEN_PROGRAM_ADDRESS, String(MEMO_PROGRAM_ADDRESS), COMPUTE_BUDGET_PROGRAM_ADDRESS]) {
      fac.state.kinds = [supportedKind(SOL, collided)];
      await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /collides with a fixed account/);
    }
    expect(rpc.calls).toHaveLength(0);
    expect(() => assertFeePayerIsolated(FEE_PAYER, { payTo: owner, destinationAta: ata, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })).not.toThrow();
    expect(() => feePayerOfSupported({ kinds: "x" }, SOL)).toThrow(/no kinds/);
  });
  it("JSON でない・500・64 KiB 超・redirect・期限切れ", async () => {
    const { fac, rpc } = await fixtures();
    for (const mode of ["not-json", "error", "huge"] as const) {
      fac.state.supportedReply = mode;
      await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /\/supported (did not return a JSON object|could not be read)/);
    }
    fac.state.supportedReply = "redirect";
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /could not be read/);
    fac.state.supportedReply = "ok";
    fac.state.supportedDelayMs = 1_500;
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc, { timeoutMs: 300 })), /could not be read/);
    expect(rpc.calls).toHaveLength(0);
    expect(SVM_STARTUP_RESPONSE_MAX_BYTES).toBe(64 * 1024);
  });
});

describe("起動時の検査: ATA の否定（fail closed）", () => {
  it("ATA が無い", async () => {
    const { fac, rpc } = await fixtures({ ata: null });
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /does not exist/);
  });
  it("owner が違う", async () => {
    const other = String((await generateKeyPairSigner()).address);
    const { fac, rpc } = await fixtures({ ata: { owner: other } });
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /not owned by the configured payTo/);
  });
  it("mint が違う", async () => {
    const { fac, rpc } = await fixtures({ ata: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } });
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /different mint/);
  });
  it("program が違う（Token-2022）", async () => {
    const { fac, rpc } = await fixtures({ ata: { program: TOKEN_2022 } });
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /not owned by the configured token program/);
  });
  it("RPC が読めない・JSON でない・64 KiB 超・redirect・期限切れ", async () => {
    const { fac, rpc } = await fixtures();
    for (const mode of ["error", "malformed", "huge"] as const) {
      rpc.state.reply = mode;
      await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /could not be read|could not be parsed|does not exist/);
    }
    rpc.state.reply = "redirect";
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc)), /could not be read/);
    rpc.state.reply = "ok";
    rpc.state.delayMs = 1_500;
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc, { timeoutMs: 300 })), /could not be read/);
    expect(() => assertAtaAccount({ result: { value: { owner: TOKEN_PROGRAM_ADDRESS, data: { program: "spl-token", parsed: { type: "mint", info: {} } } } } }, { owner, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })).toThrow(/could not be parsed/);
  });
  it("payTo の形が違えば何も読まない", async () => {
    const { fac, rpc } = await fixtures();
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc, { payTo: "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405" })), /payTo must be a 32-byte base58/);
    expect(fac.seen.supportedCalls).toBe(0);
    expect(rpc.calls).toHaveLength(0);
  });
});

describe("起動時の検査: transport の方針（SR-2。Linux で受け入れ）", () => {
  it("loopback に解決する名前には接続しない（0 接続）", async () => {
    const { fac, rpc } = await fixtures();
    const transport = createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup({ [FAC_HOST]: ["127.0.0.1"] }), dialForTest: dialTo({ [FAC_HOST]: fac.port, [RPC_HOST]: rpc.port }), dns: { timeoutMs: 3_000, maxInFlight: 4 } });
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc, { transport })), /\/supported could not be read/);
    expect(fac.seen.connections).toBe(0);
  });
  it("禁止アドレス（private）に解決する RPC には接続しない", async () => {
    const { fac, rpc } = await fixtures();
    const transport = createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: publicLookup({ [RPC_HOST]: ["10.0.0.5"] }), dialForTest: dialTo({ [FAC_HOST]: fac.port, [RPC_HOST]: rpc.port }), dns: { timeoutMs: 3_000, maxInFlight: 4 } });
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc, { transport })), /RPC could not be read/);
    expect(rpc.connections()).toBe(0);
    expect(fac.seen.supportedCalls).toBe(1);
  });
  it("名前解決が止まれば DNS の期限で失敗する（接続 0）", async () => {
    const { fac, rpc } = await fixtures();
    const stuck: LookupFn = () => {
      /* 永遠に答えない */
    };
    const transport = createGuardedTransport({ allowLoopback: false, report: () => {}, interfaces: () => [], tls: { ca: [TLS.ca] }, lookup: stuck, dialForTest: dialTo({ [FAC_HOST]: fac.port, [RPC_HOST]: rpc.port }), dns: { timeoutMs: 200, maxInFlight: 4 } });
    const started = Date.now();
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc, { transport })), /\/supported could not be read/);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(fac.seen.connections).toBe(0);
  });
  it("redirect の行き先には接続しない（別の listener へ 0 接続）", async () => {
    const { fac, rpc } = await fixtures();
    const sink = await startSvmFacilitator(TLS, SOL, FEE_PAYER, "other.test");
    closers.push(sink.close);
    fac.state.supportedReply = "redirect";
    fac.state.redirectTo = `https://other.test/supported`;
    const transport = transportTo({ [FAC_HOST]: fac.port, [RPC_HOST]: rpc.port, "other.test": sink.port });
    await expectConfigError(resolveSvmInboundPolicy(inputsOf(fac, rpc, { transport })), /could not be read/);
    expect(sink.seen.connections).toBe(0);
  });
});
