/**
 * MPP Solana 受信の純粋な検査（`src/adapters/inbound/mpp-solana.ts`。`docs/mpp-solana-design.md` §3.3・§3.4、要件 FR-46・FR-47。タスク M3-a）。
 * transaction は Router と同じ builder で組み、kit の signer で**全署名**する（fee payer = authority = payer）。鍵は毎回の乱数。chain には出ない。
 * 改変の口: 額・桁・mint・宛先・source・Memo（無し／違い／余分）・compute budget（順序・片方・無し・上限超え・重複）・余分な命令・署名 2 つ・署名の破壊・自己支払い・読み残し。
 */
import { describe, expect, test } from "vitest";
import { address, appendTransactionMessageInstructions, compileTransactionMessage, createNoopSigner, createTransactionMessage, generateKeyPairSigner, getBase58Encoder, getCompiledTransactionMessageEncoder, getTransactionDecoder, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, signBytes, signTransactionMessageWithSigners, type Instruction, type KeyPairSigner } from "@solana/kit";
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { Challenge, Credential } from "mppx";

import { buildSvmTransactionMessage, MEMO_PROGRAM_ADDRESS, type SvmMessageParams } from "../../src/adapters/inbound/x402-svm.js";
import { checkMppSolanaTransaction, isSvmPublicKeyString, isSvmSignatureString, mppSolanaPayloadOf, MPP_SOLANA_SCHEME, newExternalId, preflightMppSolana, signerOf, type MppSolanaPolicy } from "../../src/adapters/inbound/mpp-solana.js";
import type { InboundOffer, PaymentCredential } from "../../src/ports/inbound.js";

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);
const BLOCKHASH = "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

async function ataOf(owner: string): Promise<string> {
  return String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
}

interface World { payer: KeyPairSigner; payerAta: string; owner: string; ownerAta: string; policy: MppSolanaPolicy; externalId: string }

async function world(): Promise<World> {
  const payer = await generateKeyPairSigner();
  const ownerKey = await generateKeyPairSigner();
  const owner = String(ownerKey.address);
  const ownerAta = await ataOf(owner);
  return { payer, payerAta: await ataOf(String(payer.address)), owner, ownerAta, policy: { recipient: owner, destinationAta: ownerAta, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM }, externalId: newExternalId() };
}

type Build = Partial<Omit<SvmMessageParams, "authority">> & { readonly instructions?: (base: Instruction[]) => Instruction[] };

/** Router の builder で組み、payer が全署名した wire（bytes）。`instructions` で命令の列を差し替えられる。 */
async function wireOf(w: World, overrides: Build = {}, signers: KeyPairSigner[] = [w.payer]): Promise<Uint8Array> {
  const params: SvmMessageParams = {
    feePayer: String(w.payer.address),
    source: w.payerAta,
    authority: w.payer,
    destination: w.ownerAta,
    mint: MINT,
    amount: 10_000n,
    decimals: 6,
    memo: w.externalId,
    units: 200_000,
    microLamports: 1n,
    blockhash: BLOCKHASH,
    tokenProgram: TOKEN_PROGRAM,
    ...overrides,
  };
  let message = buildSvmTransactionMessage(params) as unknown as Parameters<typeof signTransactionMessageWithSigners>[0];
  if (overrides.instructions !== undefined) {
    const base = (message as unknown as { instructions: Instruction[] }).instructions;
    const rebuilt = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => (signers.length === 1 ? setTransactionMessageFeePayerSigner(w.payer, m) : setTransactionMessageFeePayerSigner(signers[0]!, m)),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions(overrides.instructions!(base), m),
    );
    message = rebuilt as never;
  }
  const signed = await signTransactionMessageWithSigners(message);
  return Uint8Array.from(getTransactionEncoder().encode(signed));
}

describe("checkMppSolanaTransaction: 正しい形は通る（compute budget の 2 順序・片方・無し）", () => {
  test("limit-first（Router の道具）・price-first（pay-kit の client）・limit だけ・price だけ・無し、すべて通り、観測した値を返す", async () => {
    const w = await world();
    for (const [label, budget, units, price] of [
      ["limit-first", { limit: true, price: true, order: "limit-first" }, 200_000, 1n],
      ["price-first", { limit: true, price: true, order: "price-first" }, 200_000, 1n],
      ["limit only", { limit: true, price: false, order: "limit-first" }, 200_000, undefined],
      ["price only", { limit: false, price: true, order: "limit-first" }, undefined, 1n],
      ["none", { limit: false, price: false, order: "limit-first" }, undefined, undefined],
    ] as const) {
      const bytes = await wireOf(w, { computeBudget: budget });
      const result = checkMppSolanaTransaction(bytes, w.policy, "10000", w.externalId, w.payerAta);
      expect(result, label).toMatchObject({ ok: true, signer: String(w.payer.address), blockhash: BLOCKHASH, units, microLamports: price });
      expect(signerOf(bytes), label).toBe(String(w.payer.address));
      expect(isSvmSignatureString((result as { signature: string }).signature)).toBe(true);
      expect(getBase58Encoder().encode((result as { signature: string }).signature)).toEqual(bytes.subarray(1, 65));
    }
  });
});

describe("checkMppSolanaTransaction: 各欄の変異で落ちる", () => {
  test("額・桁・mint・宛先・source・signerAta の不一致、自己支払い、compute の上限超えと重複、余分な命令、署名の破壊、読み残し、大きすぎる", async () => {
    const w = await world();
    const other = await generateKeyPairSigner();
    const otherAta = await ataOf(String(other.address));
    const limit = (units: number): Instruction => getSetComputeUnitLimitInstruction({ units }) as unknown as Instruction;
    const price = (microLamports: bigint): Instruction => getSetComputeUnitPriceInstruction({ microLamports }) as unknown as Instruction;
    const memoIx = (text: string): Instruction => ({ programAddress: MEMO_PROGRAM_ADDRESS, accounts: [], data: new TextEncoder().encode(text) }) as Instruction;
    const cases: Array<[string, () => Promise<Uint8Array>, string]> = [
      ["額", () => wireOf(w, { amount: 10_001n }), "credential_mismatch"],
      ["桁", () => wireOf(w, { decimals: 5 }), "credential_mismatch"],
      ["mint", () => wireOf(w, { mint: "So11111111111111111111111111111111111111112" }), "credential_mismatch"],
      ["宛先（別の ATA）", () => wireOf(w, { destination: otherAta }), "credential_mismatch"],
      ["source（別の ATA。owner が署名者でない）", () => wireOf(w, { source: otherAta }), "credential_mismatch"],
      ["compute limit > 200,000", () => wireOf(w, { units: 200_001 }), "credential_mismatch"],
      ["compute price > 5,000,000", () => wireOf(w, { microLamports: 5_000_001n }), "credential_mismatch"],
      ["limit が 2 つ（5 命令）", () => wireOf(w, { instructions: (base) => [limit(1), ...base] }), "credential_mismatch"],
      ["price が 2 つ（5 命令）", () => wireOf(w, { instructions: (base) => [price(1n), ...base] }), "credential_mismatch"],
      ["limit が 2 つ（4 命令: price の代わりに）", () => wireOf(w, { instructions: (base) => [base[0]!, limit(1), base[2]!, base[3]!] }), "credential_mismatch"],
      ["price が 2 つ（4 命令: limit の代わりに）", () => wireOf(w, { instructions: (base) => [price(2n), base[1]!, base[2]!, base[3]!] }), "credential_mismatch"],
      ["ATA の作成（idempotent）が compute budget の代わり（4 命令）", () => wireOf(w, { instructions: (base) => [{ programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), accounts: [], data: new Uint8Array([1]) } as Instruction, base[1]!, base[2]!, base[3]!] }), "credential_mismatch"],
      ["ATA の作成（idempotent）を足す（5 命令）", () => wireOf(w, { instructions: (base) => [...base.slice(0, 2), { programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), accounts: [], data: new Uint8Array([1]) } as Instruction, ...base.slice(2)] }), "credential_mismatch"],
      ["余分な命令（Memo が 2 つ）", () => wireOf(w, { instructions: (base) => [...base, memoIx("x")] }), "credential_mismatch"],
      ["Memo が転送の前", () => wireOf(w, { instructions: (base) => [base[0]!, base[1]!, base[3]!, base[2]!] }), "credential_mismatch"],
      ["Memo 無し（3 命令）", () => wireOf(w, { memo: undefined }), "credential_mismatch"],
      ["Memo 違い", () => wireOf(w, { memo: newExternalId() }), "nonce_mismatch"],
      ["Memo に口座", () => wireOf(w, { instructions: (base) => [base[0]!, base[1]!, base[2]!, { ...base[3]!, accounts: [{ address: address(w.owner), role: 0 }] } as Instruction] }), "nonce_mismatch"],
      ["compute budget の未知の命令（discriminator 1）", () => wireOf(w, { instructions: (base) => [{ programAddress: base[0]!.programAddress, accounts: [], data: new Uint8Array([1, 0, 0, 0, 0]) } as Instruction, ...base.slice(1)] }), "credential_mismatch"],
      ["転送が compute budget より前", () => wireOf(w, { instructions: (base) => [base[2]!, base[0]!, base[1]!, base[3]!] }), "credential_mismatch"],
    ];
    for (const [label, build, reason] of cases) {
      const bytes = await build();
      expect(checkMppSolanaTransaction(bytes, w.policy, "10000", w.externalId, w.payerAta), label).toEqual({ ok: false, reason });
    }
    // 自己支払い: 受取 owner が署名者（policy.recipient = 署名者）。
    const self = { ...w.policy, recipient: String(w.payer.address), destinationAta: w.payerAta };
    expect(checkMppSolanaTransaction(await wireOf(w, { destination: w.payerAta }), self, "10000", w.externalId, w.payerAta)).toEqual({ ok: false, reason: "credential_mismatch" });
    // 署名の破壊・読み残し・大きすぎる・空。
    const good = await wireOf(w);
    const broken = Uint8Array.from(good);
    broken[10] = (broken[10] ?? 0) ^ 0x01;
    expect(checkMppSolanaTransaction(broken, w.policy, "10000", w.externalId, w.payerAta)).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(checkMppSolanaTransaction(new Uint8Array([...good, 0]), w.policy, "10000", w.externalId, w.payerAta)).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(checkMppSolanaTransaction(new Uint8Array(1233), w.policy, "10000", w.externalId, w.payerAta)).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(checkMppSolanaTransaction(new Uint8Array(0), w.policy, "10000", w.externalId, w.payerAta)).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(signerOf(new Uint8Array(0))).toBeUndefined();
  });

  /** message の bytes を書き換えて payer が署名し直した wire（欄の検査は通るが、組み直しの比較だけが捕まえる形を作る）。 */
  async function resignedWire(w: World, mutate: (message: Uint8Array) => Uint8Array): Promise<Uint8Array> {
    const good = await wireOf(w);
    const [tx] = getTransactionDecoder().read(good, 0);
    const message = mutate(Uint8Array.from(tx.messageBytes));
    const signature = await signBytes(w.payer.keyPair.privateKey, message);
    return new Uint8Array([1, ...signature, ...message]);
  }

  test("組み直しの比較だけが捕まえる形: header の読取専用の数を変えた message（命令・口座・data は同じ）。lookup table 付き・legacy の version も落ちる", async () => {
    const w = await world();
    // v0 の message: [0] version の印、[1] 署名者の数、[2] 読取専用の署名者、[3] 読取専用の非署名者。mint 等を書込扱いにする = header だけの改変。
    const headerOnly = await resignedWire(w, (m) => { m[3] = (m[3] ?? 1) - 1; return m; });
    expect(checkMppSolanaTransaction(headerOnly, w.policy, "10000", w.externalId, w.payerAta)).toEqual({ ok: false, reason: "credential_mismatch" });
    // 署名は正しい（署名の検査だけなら通る形）: 同じ bytes を payer が署名している。
    const [tamperedTx] = getTransactionDecoder().read(headerOnly, 0);
    expect(tamperedTx.messageBytes.length).toBe((await wireOf(w)).length - 65);
    // lookup table を 1 つ足す（末尾の count 0 を、1 件の table に置き換える）。
    const withLookup = await resignedWire(w, (m) => new Uint8Array([...m.subarray(0, m.length - 1), 1, ...new Uint8Array(32).fill(7), 1, 0, 0]));
    expect(checkMppSolanaTransaction(withLookup, w.policy, "10000", w.externalId, w.payerAta)).toEqual({ ok: false, reason: "credential_mismatch" });
    // version 1（印が 0x81）: kit の decoder が知らない version。
    const versionOne = await resignedWire(w, (m) => { m[0] = 0x81; return m; });
    expect(checkMppSolanaTransaction(versionOne, w.policy, "10000", w.externalId, w.payerAta)).toEqual({ ok: false, reason: "credential_mismatch" });
    // legacy（version の印が無い）message。
    const legacy = pipe(
      createTransactionMessage({ version: "legacy" }),
      (m) => setTransactionMessageFeePayerSigner(w.payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units: 200_000 }), getSetComputeUnitPriceInstruction({ microLamports: 1n }), getTransferCheckedInstruction({ source: address(w.payerAta), mint: address(MINT), destination: address(w.ownerAta), authority: w.payer, amount: 10_000n, decimals: 6 }, { programAddress: TOKEN_PROGRAM_ADDRESS }), { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [], data: new TextEncoder().encode(w.externalId) }], m),
    );
    const legacyWire = Uint8Array.from(getTransactionEncoder().encode(await signTransactionMessageWithSigners(legacy)));
    expect(checkMppSolanaTransaction(legacyWire, w.policy, "10000", w.externalId, w.payerAta)).toEqual({ ok: false, reason: "credential_mismatch" });
  });

  test("署名 2 つ（fee payer が別の鍵 = sponsorship の形）は受けない。署名者の ATA を source にした別の鍵の署名も受けない", async () => {
    const w = await world();
    const feePayer = await generateKeyPairSigner();
    // fee payer = 別の鍵、authority = payer（x402 の形）。署名 2 つ。
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 0n }, m),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getSetComputeUnitLimitInstruction({ units: 200_000 }),
            getSetComputeUnitPriceInstruction({ microLamports: 1n }),
            getTransferCheckedInstruction({ source: address(w.payerAta), mint: address(MINT), destination: address(w.ownerAta), authority: w.payer, amount: 10_000n, decimals: 6 }, { programAddress: TOKEN_PROGRAM_ADDRESS }),
            { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [], data: new TextEncoder().encode(w.externalId) },
          ],
          m,
        ),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const bytes = Uint8Array.from(getTransactionEncoder().encode(signed));
    expect(bytes[0]).toBe(2);
    expect(checkMppSolanaTransaction(bytes, w.policy, "10000", w.externalId, w.payerAta)).toEqual({ ok: false, reason: "credential_mismatch" });
    // 署名者が transfer の authority でない（authority は payer、署名者は別の鍵で fee payer = authority ではない）。
    const noop = createNoopSigner(address(String(w.payer.address)));
    const wrong = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH as never, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstructions([getTransferCheckedInstruction({ source: address(w.payerAta), mint: address(MINT), destination: address(w.ownerAta), authority: noop, amount: 10_000n, decimals: 6 }, { programAddress: TOKEN_PROGRAM_ADDRESS }), { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [], data: new TextEncoder().encode(w.externalId) }], m),
    );
    const partially = await signTransactionMessageWithSigners(wrong as never).catch(() => undefined);
    expect(partially).toBeUndefined(); // noop signer は署名できない = 全署名の transaction が組めない（payer の署名無しには出せない形）
    void setTransactionMessageFeePayer;
    void compileTransactionMessage;
    void getCompiledTransactionMessageEncoder;
  });
});

describe("payload・preflight・externalId", () => {
  function offerOf(w: World, challenge: string, extra: Record<string, unknown> = {}): InboundOffer {
    return { scheme: MPP_SOLANA_SCHEME, network: SOL, asset: MINT, amount: "10000", payTo: w.owner, maxTimeoutSeconds: 600, extra: { challengeNonce: "id-1", expiresAt: Math.floor(Date.now() / 1000) + 600, routeBinding: "r|GET|/x", fundsMoveOnCredential: true, challenge, externalId: w.externalId, decimals: 6, tokenProgram: TOKEN_PROGRAM, ...extra } };
  }
  function wireOfPayload(payload: unknown, id = "id-1"): string {
    const challenge = { id, realm: "r", method: "solana", intent: "charge", request: { amount: "10000", currency: MINT, recipient: "x", externalId: "e", methodDetails: {} }, expires: new Date(Date.now() + 600_000).toISOString() };
    return Credential.serialize({ challenge, payload } as never);
  }

  test("mppSolanaPayloadOf: transaction（正準の base64、1232 バイト以下）と signature（base58 64 バイト）。他は undefined", async () => {
    const w = await world();
    const bytes = await wireOf(w);
    const tx = mppSolanaPayloadOf(wireOfPayload({ type: "transaction", transaction: Buffer.from(bytes).toString("base64") }));
    expect(tx?.type).toBe("transaction");
    expect(Buffer.compare(Buffer.from((tx as { bytes: Uint8Array }).bytes), Buffer.from(bytes))).toBe(0);
    const sig = "5".repeat(87);
    expect(mppSolanaPayloadOf(wireOfPayload({ type: "signature", signature: sig }))).toEqual({ type: "signature", signature: sig });
    expect(mppSolanaPayloadOf(wireOfPayload({ type: "signature", signature: "short" }))).toBeUndefined();
    expect(mppSolanaPayloadOf(wireOfPayload({ type: "transaction", transaction: "not base64!" }))).toBeUndefined();
    expect(mppSolanaPayloadOf(wireOfPayload({ type: "transaction", transaction: Buffer.alloc(1233).toString("base64") }))).toBeUndefined();
    expect(mppSolanaPayloadOf(wireOfPayload({ type: "bundle", bundle: "x" }))).toBeUndefined();
    expect(mppSolanaPayloadOf(wireOfPayload({ type: "transaction" }))).toBeUndefined();
    expect(mppSolanaPayloadOf("not a credential")).toBeUndefined();
    expect(mppSolanaPayloadOf(undefined)).toBeUndefined();
  });

  test("preflightMppSolana: 5 点 + 型と形。構造の検査はしない（壊れた transaction でも形が base64 なら通る = verify で落とす）", async () => {
    const w = await world();
    const bytes = await wireOf(w);
    const wire = wireOfPayload({ type: "transaction", transaction: Buffer.from(bytes).toString("base64") });
    const offer = offerOf(w, wire);
    const credential: PaymentCredential = { x402Version: 2, accepted: offer, payload: { challengeNonce: "id-1", credential: wire } };
    const now = Date.now();
    expect(preflightMppSolana(offer, credential, now)).toEqual({ ok: true });
    expect(preflightMppSolana(offer, { ...credential, payload: { ...credential.payload, challengeNonce: "id-2" } }, now)).toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(preflightMppSolana(offer, credential, (offer.extra.expiresAt + 1) * 1000)).toEqual({ ok: false, reason: "offer_expired" });
    expect(preflightMppSolana(offer, { ...credential, accepted: { ...offer, scheme: "tempo/charge" } }, now)).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(preflightMppSolana(offer, { ...credential, accepted: { ...offer, extra: { ...offer.extra, routeBinding: "other" } } }, now)).toEqual({ ok: false, reason: "route_binding_mismatch" });
    expect(preflightMppSolana(offer, { ...credential, accepted: { ...offer, amount: "9999" } }, now)).toEqual({ ok: false, reason: "offer_mismatch" });
    expect(preflightMppSolana(offer, { ...credential, accepted: { ...offer, extra: { ...offer.extra, extraKey: 1 } } }, now)).toEqual({ ok: false, reason: "offer_mismatch" });
    // wire の中の challenge id が offer の nonce と違う（封筒は合っている）。
    expect(preflightMppSolana(offer, { ...credential, payload: { challengeNonce: "id-1", credential: wireOfPayload({ type: "transaction", transaction: Buffer.from(bytes).toString("base64") }, "id-9") } }, now)).toEqual({ ok: false, reason: "nonce_mismatch" });
    // 型・形。
    expect(preflightMppSolana(offer, { ...credential, payload: { challengeNonce: "id-1", credential: wireOfPayload({ type: "bundle" }) } }, now)).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(preflightMppSolana(offer, { ...credential, payload: { challengeNonce: "id-1", credential: wireOfPayload({ type: "signature", signature: "nope" }) } }, now)).toEqual({ ok: false, reason: "credential_mismatch" });
    // 構造の検査は preflight ではしない: 額の違う transaction でも形が正しければ通る（verify の仕事）。
    const bad = await wireOf(w, { amount: 1n });
    expect(preflightMppSolana(offer, { ...credential, payload: { challengeNonce: "id-1", credential: wireOfPayload({ type: "transaction", transaction: Buffer.from(bad).toString("base64") }) } }, now)).toEqual({ ok: true });
  });

  test("newExternalId: 16 バイトの乱数の base58（毎回違う、Memo の上限の内側）。isSvmPublicKeyString", () => {
    const a = newExternalId();
    const b = newExternalId();
    expect(a).not.toBe(b);
    expect(getBase58Encoder().encode(a).length).toBe(16);
    expect(new TextEncoder().encode(a).byteLength).toBeLessThanOrEqual(24);
    expect(isSvmPublicKeyString("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")).toBe(true);
    expect(isSvmPublicKeyString(a)).toBe(false);
    expect(isSvmPublicKeyString(42)).toBe(false);
    void Challenge;
  });
});
