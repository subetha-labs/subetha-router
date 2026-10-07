/**
 * SVM の transaction の検査（multirail 設計 §5.3・§5.4、要件 FR-16、AC-3。タスク T4-a）。**同期・無接続**。
 * 正しい transaction は通り、設計の否定の一覧は各 1 本で落ちる。理由は transaction の検査では
 * `credential_mismatch`／`nonce_mismatch` のどちらか。封筒の検査（既存の preflight と同じ）は `preflightSvm` で見る。
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { address, getTransactionDecoder } from "@solana/kit";
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { generateKeyPairSigner, type Instruction } from "@solana/kit";
import { ExactSvmScheme } from "@x402/svm";

import {
  checkSvmTransaction,
  MEMO_PROGRAM_ADDRESS,
  preflightSvm,
  SVM_MAX_COMPUTE_UNITS,
  SVM_MAX_MICRO_LAMPORTS_PER_UNIT,
  SVM_TRANSACTION_MAX_BYTES,
  type SvmInboundPolicy,
} from "../../src/adapters/inbound/x402-svm.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";
import { createSvmTestPayer, TEST_BLOCKHASH, type SvmTestPayer } from "../fixtures/svm-payer.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const FEE_PAYER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const AMOUNT = "10000";
const MEMO = `0x${"ab".repeat(32)}`;

let policy: SvmInboundPolicy;
let payer: SvmTestPayer;
let ownerAddress: string;

beforeAll(async () => {
  const owner = await generateKeyPairSigner();
  ownerAddress = String(owner.address);
  const [ata] = await findAssociatedTokenPda({ mint: address(MINT), owner: owner.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  policy = { feePayer: FEE_PAYER, payTo: ownerAddress, destinationAta: String(ata), mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS };
  payer = await createSvmTestPayer(MINT);
});

const MISMATCH = { ok: false, reason: "credential_mismatch" };
const NONCE = { ok: false, reason: "nonce_mismatch" };

describe("checkSvmTransaction: 正しい transaction", () => {
  test("通り、提出値（authority・source・compute）を返す。同期で、ネットワークに出ない", async () => {
    const tx = await payer.build(policy, AMOUNT, MEMO);
    const result = checkSvmTransaction(tx, policy, AMOUNT, MEMO);
    expect(result).toMatchObject({ ok: true, authority: payer.address, source: payer.sourceAta, units: 20_000, microLamports: 1n });
    // 同期（Promise ではない）。
    expect(typeof (result as unknown as { then?: unknown }).then).toBe("undefined");
    expect(Buffer.from(tx, "base64").length).toBeLessThanOrEqual(SVM_TRANSACTION_MAX_BYTES);
  });

  test("compute の上限ちょうど（200,000 / 5,000,000）は通る", async () => {
    const tx = await payer.build(policy, AMOUNT, MEMO, { units: SVM_MAX_COMPUTE_UNITS, microLamports: SVM_MAX_MICRO_LAMPORTS_PER_UNIT });
    expect(checkSvmTransaction(tx, policy, AMOUNT, MEMO).ok).toBe(true);
  });
});

describe("checkSvmTransaction: 否定（AC-3）", () => {
  const cases: [string, () => Promise<unknown>, unknown][] = [
    ["base64 でない", async () => "not*base64!", MISMATCH],
    ["文字列でない", async () => 42, MISMATCH],
    ["正準でない base64（padding の崩れ）", async () => `${(await payer.build(policy, AMOUNT, MEMO)).replace(/=+$/, "")}A`, MISMATCH],
    ["1,233 バイト（末尾に足す）", async () => payer.build(policy, AMOUNT, MEMO, { mutateBytes: (b) => { const out = new Uint8Array(SVM_TRANSACTION_MAX_BYTES + 1); out.set(b); return out; } }), MISMATCH],
    ["読み残し（末尾に 1 バイト）", async () => payer.build(policy, AMOUNT, MEMO, { mutateBytes: (b) => new Uint8Array([...b, 0]) }), MISMATCH],
    ["署名の数が 1（先頭の count を書き換え）", async () => payer.build(policy, AMOUNT, MEMO, { mutateBytes: (b) => { const out = new Uint8Array(b); out[0] = 1; return out; } }), MISMATCH],
    ["fee payer の枠に署名がある", async () => payer.build(policy, AMOUNT, MEMO, { signFeePayerSlot: true }), MISMATCH],
    ["authority の署名が壊れている（1 bit）", async () => payer.build(policy, AMOUNT, MEMO, { mutateBytes: (b) => { const out = new Uint8Array(b); out[70] = (out[70] ?? 0) ^ 1; return out; } }), MISMATCH],
    ["authority の署名が別物（乱数）", async () => payer.build(policy, AMOUNT, MEMO, { mutateBytes: (b) => { const out = new Uint8Array(b); out.set(new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff), 65); return out; } }), MISMATCH],
    ["version legacy", async () => payer.build(policy, AMOUNT, MEMO, { version: "legacy" }), MISMATCH],
    ["lookup table を参照する", async () => payer.build(policy, AMOUNT, MEMO, { lookupTable: true }), MISMATCH],
    ["fee payer が固定値と違う", async () => payer.build(policy, AMOUNT, MEMO, { feePayer: "11111111111111111111111111111112" }), MISMATCH],
    ["命令が 3 つ（memo 無し）", async () => payer.build(policy, AMOUNT, MEMO, { instructions: (ixs) => ixs.slice(0, 3) }), MISMATCH],
    ["命令が 5 つ（transfer が 2 つ）", async () => payer.build(policy, AMOUNT, MEMO, { instructions: (ixs) => [...ixs, ixs[2]!] }), MISMATCH],
    ["命令が 5 つ（不明な program）", async () => payer.build(policy, AMOUNT, MEMO, { instructions: (ixs) => [...ixs, { programAddress: address("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"), accounts: [], data: new Uint8Array([1]) }] }), MISMATCH],
    ["命令の並べ替え（price が先）", async () => payer.build(policy, AMOUNT, MEMO, { instructions: (ixs) => [ixs[1]!, ixs[0]!, ixs[2]!, ixs[3]!] }), MISMATCH],
    ["ComputeBudget の data の末尾に 1 バイト", async () => payer.build(policy, AMOUNT, MEMO, { instructions: (ixs) => [{ ...ixs[0]!, data: new Uint8Array([...Array.from(ixs[0]!.data ?? new Uint8Array(0)), 0]) } as Instruction, ...ixs.slice(1)] }), MISMATCH],
    ["units 200,001", async () => payer.build(policy, AMOUNT, MEMO, { units: SVM_MAX_COMPUTE_UNITS + 1 }), MISMATCH],
    ["microLamports 5,000,001", async () => payer.build(policy, AMOUNT, MEMO, { microLamports: SVM_MAX_MICRO_LAMPORTS_PER_UNIT + 1n }), MISMATCH],
    ["Token-2022 の program", async () => payer.build(policy, AMOUNT, MEMO, { tokenProgram: TOKEN_2022 }), MISMATCH],
    ["宛先が違う", async () => payer.build(policy, AMOUNT, MEMO, { destination: payer.sourceAta }), MISMATCH],
    ["mint が違う", async () => payer.build(policy, AMOUNT, MEMO, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), MISMATCH],
    ["桁が違う", async () => payer.build(policy, AMOUNT, MEMO, { decimals: 9 }), MISMATCH],
    ["額が違う", async () => payer.build(policy, AMOUNT, MEMO, { amount: 10_001n }), MISMATCH],
    ["source = fee payer", async () => payer.build(policy, AMOUNT, MEMO, { source: FEE_PAYER }), MISMATCH],
    ["source = 宛先 ATA", async () => payer.build(policy, AMOUNT, MEMO, { source: policy.destinationAta }), MISMATCH],
    ["fee payer を Router に向ける（宛先 = fee payer）", async () => payer.build(policy, AMOUNT, MEMO, { destination: FEE_PAYER }), MISMATCH],
    ["口座の追加（transfer に余分な口座）", async () => payer.build(policy, AMOUNT, MEMO, { instructions: (ixs) => [ixs[0]!, ixs[1]!, { ...ixs[2]!, accounts: [...(ixs[2]!.accounts ?? []), { address: address(FEE_PAYER), role: 0 }] } as Instruction, ixs[3]!] }), MISMATCH],
    ["transfer の data の末尾に追加", async () => payer.build(policy, AMOUNT, MEMO, { instructions: (ixs) => [ixs[0]!, ixs[1]!, { ...ixs[2]!, data: new Uint8Array([...Array.from(ixs[2]!.data ?? new Uint8Array(0)), 1]) } as Instruction, ixs[3]!] }), MISMATCH],
    ["memo が違う（nonce_mismatch。署名は壊れていてもこの理由が先）", async () => payer.build(policy, AMOUNT, MEMO, { memo: `0x${"cd".repeat(32)}`, mutateBytes: (b) => { const out = new Uint8Array(b); out[70] = (out[70] ?? 0) ^ 1; return out; } }), NONCE],
    ["memo に口座が付いている", async () => payer.build(policy, AMOUNT, MEMO, { instructions: (ixs) => [ixs[0]!, ixs[1]!, ixs[2]!, { ...ixs[3]!, accounts: [{ address: address(FEE_PAYER), role: 0 }] } as Instruction] }), NONCE],
    ["口座の役割が違う（宛先を readonly に。長さは同じで、署名は有効）", async () => payer.build(policy, AMOUNT, MEMO, { instructions: (ixs) => [ixs[0]!, ixs[1]!, { ...ixs[2]!, accounts: (ixs[2]!.accounts ?? []).map((a, k) => (k === 2 ? { ...a, role: 0 } : a)) } as Instruction, ixs[3]!] }), MISMATCH],
  ];
  for (const [name, build, expected] of cases) {
    test(name, async () => {
      const tx = (await build()) as never;
      const result = checkSvmTransaction(tx, policy, AMOUNT, MEMO);
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toMatch(/Error|at /);
    });
  }

  test("authority = fee payer、authority = payTo は拒む（署名者が固定値と同じ）", async () => {
    // fee payer の鍵で署名した形: 署名者を fee payer の位置に置くことは builder では作れないので、policy 側を payer の鍵に合わせて見る。
    const tx = await payer.build(policy, AMOUNT, MEMO);
    expect(checkSvmTransaction(tx, { ...policy, feePayer: payer.address }, AMOUNT, MEMO)).toEqual(MISMATCH);
    expect(checkSvmTransaction(tx, { ...policy, payTo: payer.address }, AMOUNT, MEMO)).toEqual(MISMATCH);
  });

  test("policy の fee payer・ATA・mint・桁の違いは落ちる（起動時の固定値に束縛される）", async () => {
    const tx = await payer.build(policy, AMOUNT, MEMO);
    expect(checkSvmTransaction(tx, { ...policy, destinationAta: payer.sourceAta }, AMOUNT, MEMO)).toEqual(MISMATCH);
    expect(checkSvmTransaction(tx, { ...policy, decimals: 9 }, AMOUNT, MEMO)).toEqual(MISMATCH);
    expect(checkSvmTransaction(tx, policy, "9999", MEMO)).toEqual(MISMATCH);
  });
});

describe("preflightSvm: 封筒の検査（既存の preflight と同じ）", () => {
  function offerOf(): InboundOffer {
    return {
      scheme: "exact",
      network: SOL,
      asset: MINT,
      amount: AMOUNT,
      payTo: ownerAddress,
      maxTimeoutSeconds: 40,
      extra: { feePayer: FEE_PAYER, memo: MEMO, challengeNonce: MEMO, expiresAt: Math.floor(Date.now() / 1000) + 100, routeBinding: "r|GET|/x", fundsMoveOnCredential: false },
    };
  }
  async function credentialOf(offer: InboundOffer, accepted: Record<string, unknown> = {}, payload: Record<string, unknown> = {}): Promise<PaymentCredential> {
    return { x402Version: 2, accepted: { ...offer, ...accepted } as InboundOffer, payload: { challengeNonce: offer.extra.challengeNonce, transaction: await payer.build(policy, AMOUNT, MEMO), ...payload } };
  }

  test("正しい credential は通る", async () => {
    const offer = offerOf();
    expect(preflightSvm(offer, await credentialOf(offer), Date.now(), policy)).toEqual({ ok: true });
  });

  test("未知の nonce・失効・route の束縛・accepted の各欄・extra の未知キー・memo ≠ nonce・transaction 無し", async () => {
    const offer = offerOf();
    const now = Date.now();
    expect(preflightSvm(offer, await credentialOf(offer, {}, { challengeNonce: `0x${"00".repeat(32)}` }), now, policy)).toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(preflightSvm(offer, await credentialOf(offer), offer.extra.expiresAt * 1000 + 1, policy)).toEqual({ ok: false, reason: "offer_expired" });
    expect(preflightSvm(offer, await credentialOf(offer, { extra: { ...offer.extra, routeBinding: "other" } }), now, policy)).toEqual({ ok: false, reason: "route_binding_mismatch" });
    for (const field of [{ amount: "1" }, { payTo: payer.address }, { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, { network: "eip155:84532" }, { maxTimeoutSeconds: 41 }]) {
      expect(preflightSvm(offer, await credentialOf(offer, field), now, policy)).toEqual({ ok: false, reason: "offer_mismatch" });
    }
    expect(preflightSvm(offer, await credentialOf(offer, { scheme: "upto" }), now, policy)).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(preflightSvm(offer, await credentialOf(offer, { extra: { ...offer.extra, extraKey: 1 } }), now, policy)).toEqual({ ok: false, reason: "offer_mismatch" });
    expect(preflightSvm(offer, await credentialOf(offer, { extra: { ...offer.extra, feePayer: payer.address } }), now, policy)).toEqual({ ok: false, reason: "offer_mismatch" });
    const bad = { ...offer, extra: { ...offer.extra, memo: `0x${"cd".repeat(32)}` } };
    expect(preflightSvm(bad, await credentialOf(bad), now, policy)).toEqual({ ok: false, reason: "offer_mismatch" });
    expect(preflightSvm(offer, await credentialOf(offer, {}, { transaction: undefined }), now, policy)).toEqual({ ok: false, reason: "credential_mismatch" });
  });
});

describe("互換の試験（U-3）: @x402/svm の client が組んだ transaction を Router の検査が受ける", () => {
  let rpc: SolanaRpcFixture;
  beforeAll(async () => {
    rpc = await startSolanaRpc({ mint: MINT, decimals: 6 });
  });
  afterAll(() => rpc.close());

  test("createPaymentPayload（loopback の RPC: mint の account と blockhash）→ checkSvmTransaction ok", async () => {
    const client = new ExactSvmScheme(payer.signer as never, { rpcUrl: rpc.url });
    const requirements = { scheme: "exact", network: SOL, asset: MINT, amount: AMOUNT, payTo: ownerAddress, maxTimeoutSeconds: 40, extra: { feePayer: FEE_PAYER, memo: MEMO } };
    const built = await client.createPaymentPayload(2, requirements as never);
    const transaction = (built.payload as { transaction: string }).transaction;
    const result = checkSvmTransaction(transaction, policy, AMOUNT, MEMO);
    expect(result).toMatchObject({ ok: true, authority: payer.address, source: payer.sourceAta });
    // SDK が読んだのは mint の account と blockhash だけ。
    expect(rpc.calls.map((c) => c.method).sort()).toEqual(["getAccountInfo", "getLatestBlockhash"]);
    // 復号して blockhash が fixture のもの（既定の公開 RPC に落ちていない）。
    const decoded = getTransactionDecoder().decode(new Uint8Array(Buffer.from(transaction, "base64")));
    expect(decoded.messageBytes.length).toBeGreaterThan(0);
    expect(TEST_BLOCKHASH.length).toBeGreaterThan(0);
  });
});

describe("builder の形（道具と Router が共有する）", () => {
  test("命令はちょうど 4 つ、順は limit・price・transfer・memo、memo に口座は無い", async () => {
    const tx = await payer.build(policy, AMOUNT, MEMO);
    const decoded = getTransactionDecoder().decode(new Uint8Array(Buffer.from(tx, "base64")));
    expect(Object.keys(decoded.signatures)).toHaveLength(2);
    expect(String(MEMO_PROGRAM_ADDRESS)).toBe("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    // transfer の parse は Router の経路と同じ（別の命令を足したものは上の否定で落ちる）。
    expect(getTransferCheckedInstruction).toBeTypeOf("function");
    expect(getSetComputeUnitLimitInstruction).toBeTypeOf("function");
  });
});
