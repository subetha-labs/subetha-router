/**
 * SVM 送信の message・wire の検査（送信の設計 §4.5 の 5〜7・10〜11、FR-24・FR-34。タスク U6-a）。**同期・無接続・鍵は乱数の seed**。
 * `checkSvmOutboundMessage` は builder を呼ばない: 正しい message は通り、各欄・構造の変異は落ち、builder を変異させても検査が落ちる。
 * source/destination の相対順が逆になる 2 組の鍵で確かめる（kit の並びの規則を単一の fixture で一般化しない）。
 */
import { beforeAll, describe, expect, test } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { address, getAddressComparator, getAddressDecoder, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder, compileTransactionMessage } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "@solana-program/compute-budget";

import { buildSvmTransactionMessage, MEMO_PROGRAM_ADDRESS, SVM_DEFAULT_COMPUTE_UNITS, SVM_TRANSACTION_MAX_BYTES } from "../../src/adapters/inbound/x402-svm.js";
import {
  assembleSvmWire,
  checkSvmOutboundMessage,
  compileSvmMessage,
  defaultMemoOf,
  expectedOf,
  expectedStaticAccountsOf,
  messageHashOf,
  recheckSvmWire,
  verifySvmSignature,
  type SvmExpected,
  type SvmOutboundScope,
} from "../../src/adapters/outbound/x402-svm.js";

const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const BLOCKHASH = "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD";
const PAYMENT_ID = "11111111-2222-4333-8444-555555555555";

interface Keys {
  readonly routerSeed: Uint8Array;
  readonly router: string;
  readonly routerAta: string;
  readonly provider: string;
  readonly providerAta: string;
  readonly feePayer: string;
  readonly scope: SvmOutboundScope;
  readonly expected: SvmExpected;
}

function keyOf(seed: Uint8Array): string {
  return getAddressDecoder().decode(ed25519.getPublicKey(seed));
}
function seedOf(n: number): Uint8Array {
  return new Uint8Array(32).map((_, i) => (i * 7 + n * 31 + 3) & 0xff);
}

/** source の ATA < destination の ATA（`sourceFirst`）か、その逆か、になる組を seed から探す。 */
async function keysWhere(sourceFirst: boolean): Promise<Keys> {
  const compare = getAddressComparator();
  for (let n = 1; n < 500; n += 1) {
    const routerSeed = seedOf(n);
    const router = keyOf(routerSeed);
    const provider = keyOf(seedOf(n + 1000));
    const feePayer = keyOf(seedOf(n + 2000));
    const [routerAta] = await findAssociatedTokenPda({ mint: address(MINT), owner: address(router), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [providerAta] = await findAssociatedTokenPda({ mint: address(MINT), owner: address(provider), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    if ((compare(routerAta, providerAta) < 0) !== sourceFirst) continue;
    const scope: SvmOutboundScope = { network: SOL, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS, routerAddress: router, routerAta: String(routerAta) };
    const result = expectedOf({ offer: { scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: provider, extra: { feePayer } } as never, scope, destinationAta: String(providerAta), paymentId: PAYMENT_ID, blockhash: BLOCKHASH, lastValidBlockHeight: 123n });
    if (!result.ok) throw new Error(result.reason);
    return { routerSeed, router, routerAta: String(routerAta), provider, providerAta: String(providerAta), feePayer, scope, expected: result.expected };
  }
  throw new Error("no key set found");
}

let first: Keys;
let second: Keys;
beforeAll(async () => {
  first = await keysWhere(true);
  second = await keysWhere(false);
});

describe("expectedOf: 期待値は原始値だけの凍結した object。Memo の既定と実行時の検査", () => {
  test("offer から取るのは feePayer・amount・memo だけ。他は scope から。凍結", () => {
    const e = first.expected;
    expect(e).toEqual({ feePayer: first.feePayer, source: first.routerAta, authority: first.router, destination: first.providerAta, mint: MINT, amount: 10000n, decimals: 6, memo: defaultMemoOf(PAYMENT_ID), units: SVM_DEFAULT_COMPUTE_UNITS, microLamports: 1n, blockhash: BLOCKHASH, lastValidBlockHeight: 123n, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(Object.isFrozen(e)).toBe(true);
    for (const value of Object.values(e)) expect(["string", "bigint", "number"]).toContain(typeof value);
  });

  test("Memo の既定は subetha:<paymentId>。offer の extra.memo が優先。257 バイト・制御文字・空は destination_memo_invalid（既定にも掛かる）", () => {
    const base = { offer: { scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: first.provider, extra: { feePayer: first.feePayer } }, scope: first.scope, destinationAta: first.providerAta, paymentId: PAYMENT_ID, blockhash: BLOCKHASH, lastValidBlockHeight: 1n };
    expect(defaultMemoOf("p-1")).toBe("subetha:p-1");
    const custom = expectedOf({ ...base, offer: { ...base.offer, extra: { feePayer: first.feePayer, memo: "invoice 42" } } } as never);
    expect(custom).toMatchObject({ ok: true, expected: { memo: "invoice 42" } });
    for (const [label, memo] of [["257 バイト", "a".repeat(257)], ["制御文字", "ab\u0001c"], ["DEL", "ab\u007f"], ["空", ""], ["文字列でない", 42]] as const) {
      expect(expectedOf({ ...base, offer: { ...base.offer, extra: { feePayer: first.feePayer, memo } } } as never), label).toEqual({ ok: false, reason: "destination_memo_invalid" });
    }
    // 既定にも掛かる: paymentId が長すぎれば落ちる。
    expect(expectedOf({ ...base, paymentId: "x".repeat(300) } as never)).toEqual({ ok: false, reason: "destination_memo_invalid" });
    expect(expectedOf({ ...base, paymentId: "p\u0000" } as never)).toEqual({ ok: false, reason: "destination_memo_invalid" });
    // 256 バイトちょうど（マルチバイトも byte で数える）は通る。
    expect(expectedOf({ ...base, offer: { ...base.offer, extra: { feePayer: first.feePayer, memo: "あ".repeat(85) + "a" } } } as never).ok).toBe(true);
    expect(expectedOf({ ...base, offer: { ...base.offer, extra: { feePayer: first.feePayer, memo: "あ".repeat(86) } } } as never)).toEqual({ ok: false, reason: "destination_memo_invalid" });
  });
});

describe("checkSvmOutboundMessage: 正しい message は 2 組の鍵で通る（source/destination の相対順が逆）", () => {
  test("並びが逆の 2 組とも通る。期待値から独立に算出した並びと compile の並びが一致", () => {
    for (const keys of [first, second]) {
      const bytes = compileSvmMessage(keys.expected);
      expect(checkSvmOutboundMessage(bytes, keys.expected)).toEqual({ ok: true });
      const compiled = getCompiledTransactionMessageDecoder().decode(bytes);
      expect(compiled.staticAccounts.map(String)).toEqual([...expectedStaticAccountsOf(keys.expected)]);
    }
    const a = expectedStaticAccountsOf(first.expected);
    const b = expectedStaticAccountsOf(second.expected);
    expect(a.indexOf(first.routerAta) < a.indexOf(first.providerAta)).toBe(true);
    expect(b.indexOf(second.routerAta) < b.indexOf(second.providerAta)).toBe(false);
  });

  test("同期で、builder を呼ばない（builder の変異で検査が落ちる = 検査は builder の再構築ではない）", () => {
    const bytes = compileSvmMessage(first.expected);
    // builder を使わず、別の額で組んだ message を「builder の変異」の代わりにする: 検査は期待値と照合するので落ちる。
    const mutated = compileSvmMessage({ ...first.expected, amount: 10001n });
    expect(checkSvmOutboundMessage(mutated, first.expected)).toEqual({ ok: false, reason: "transfer_value" });
    expect(checkSvmOutboundMessage(bytes, first.expected)).toEqual({ ok: true });
  });
});

describe("checkSvmOutboundMessage: 各欄の変異で落ちる（builder 側で別の値を組む）", () => {
  const fieldCases: [string, (k: Keys) => Partial<SvmExpected>, string][] = [
    ["source", (k) => ({ source: k.providerAta }), "accounts"],
    ["destination", (k) => ({ destination: k.routerAta }), "accounts"],
    ["amount", () => ({ amount: 9999n }), "transfer_value"],
    ["decimals", () => ({ decimals: 9 }), "transfer_value"],
    ["mint", () => ({ mint: "So11111111111111111111111111111111111111112" }), "accounts"],
    ["fee payer", (k) => ({ feePayer: k.provider }), "accounts"],
    ["authority", (k) => ({ authority: k.provider }), "accounts"],
    ["units", () => ({ units: 60_001 }), "compute_limit_value"],
    ["microLamports", () => ({ microLamports: 2n }), "compute_price_value"],
    ["Memo", () => ({ memo: "subetha:other" }), "memo_value"],
    ["blockhash", () => ({ blockhash: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" }), "blockhash"],
    ["token program", () => ({ tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }), "accounts"],
  ];
  for (const [label, mutate, reason] of fieldCases) {
    test(`${label} が違う → ${reason}`, () => {
      for (const keys of [first, second]) {
        const bytes = compileSvmMessage({ ...keys.expected, ...mutate(keys) });
        const result = checkSvmOutboundMessage(bytes, keys.expected);
        expect(result.ok, label).toBe(false);
        if (reason !== "accounts") expect(result).toEqual({ ok: false, reason });
      }
    });
  }
});

/** compile した message を decode → 変異 → encode し直す。 */
function reencode(bytes: Uint8Array, mutate: (c: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>) => unknown): Uint8Array {
  const compiled = structuredClone(getCompiledTransactionMessageDecoder().decode(bytes));
  const next = (mutate(compiled) ?? compiled) as never;
  return Uint8Array.from(getCompiledTransactionMessageEncoder().encode(next));
}

describe("checkSvmOutboundMessage: 構造の変異で落ちる（decode → 書き換え → encode）", () => {
  const structural: [string, (c: any, k: Keys) => unknown, string][] = [
    ["命令の追加（Memo をもう 1 つ）", (c) => { c.instructions.push({ ...c.instructions[3] }); }, "instruction_count"],
    ["命令の削除（price を外す）", (c) => { c.instructions.splice(1, 1); }, "instruction_count"],
    ["命令の入れ替え（limit と price）", (c) => { [c.instructions[0], c.instructions[1]] = [c.instructions[1], c.instructions[0]]; }, "compute_limit"],
    ["命令の入れ替え（transfer と Memo）", (c) => { [c.instructions[2], c.instructions[3]] = [c.instructions[3], c.instructions[2]]; }, "transfer"],
    ["discriminator（limit を 3 に）", (c) => { c.instructions[0].data = Uint8Array.from([3, ...c.instructions[0].data.slice(1)]); }, "compute_limit"],
    ["discriminator（transfer を 3 = Transfer に）", (c) => { c.instructions[2].data = Uint8Array.from([3, ...c.instructions[2].data.slice(1)]); }, "transfer"],
    ["余剰の data（transfer の末尾に 1 バイト）", (c) => { c.instructions[2].data = Uint8Array.from([...c.instructions[2].data, 0]); }, "transfer"],
    ["余剰の data（limit の末尾に 1 バイト）", (c) => { c.instructions[0].data = Uint8Array.from([...c.instructions[0].data, 0]); }, "compute_limit"],
    ["余剰の口座（transfer に 5 つ目）", (c) => { c.instructions[2].accountIndices = [...c.instructions[2].accountIndices, 0]; }, "transfer_accounts"],
    ["余剰の口座（Memo に 1 つ）", (c) => { c.instructions[3].accountIndices = [0]; }, "memo"],
    ["transfer の口座の入れ替え（source と destination）", (c) => { const a = c.instructions[2].accountIndices; c.instructions[2].accountIndices = [a[2], a[1], a[0], a[3]]; }, "transfer_accounts"],
    ["header の署名者数 1", (c) => { c.header.numSignerAccounts = 1; }, "header"],
    ["header の読取署名者 0", (c) => { c.header.numReadonlySignerAccounts = 0; }, "header"],
    ["header の読取非署名者 3", (c) => { c.header.numReadonlyNonSignerAccounts = 3; }, "header"],
    ["余剰の口座（static に 9 つ目）", (c) => { c.staticAccounts.push(address("So11111111111111111111111111111111111111112")); }, "accounts"],
  ];
  for (const [label, mutate, reason] of structural) {
    test(`${label} → ${reason}`, () => {
      for (const keys of [first, second]) {
        const bytes = reencode(compileSvmMessage(keys.expected), (c) => mutate(c, keys));
        expect(checkSvmOutboundMessage(bytes, keys.expected), label).toEqual({ ok: false, reason });
      }
    });
  }

  test("読み残し（末尾に 1 バイト）→ trailing_bytes。切り詰め → undecodable。version legacy → version", () => {
    const bytes = compileSvmMessage(first.expected);
    expect(checkSvmOutboundMessage(new Uint8Array([...bytes, 0]), first.expected)).toEqual({ ok: false, reason: "trailing_bytes" });
    expect(checkSvmOutboundMessage(bytes.subarray(0, bytes.length - 5), first.expected).ok).toBe(false);
    // 先頭の version prefix（0x80）を落とすと legacy として読まれる。
    expect(checkSvmOutboundMessage(bytes.subarray(1), first.expected).ok).toBe(false);
  });
});

describe("messageHashOf・assembleSvmWire・recheckSvmWire", () => {
  function signed(keys: Keys): { snapshot: Uint8Array; signature: Uint8Array; wire: Uint8Array } {
    const snapshot = compileSvmMessage(keys.expected);
    const signature = ed25519.sign(snapshot, keys.routerSeed);
    const wire = assembleSvmWire(snapshot, keys.expected, signature);
    return { snapshot, signature, wire };
  }

  test("hash は sha256 の小文字 hex 64。署名の検証は base58 の公開鍵で", () => {
    const { snapshot, signature } = signed(first);
    expect(messageHashOf(snapshot)).toMatch(/^[0-9a-f]{64}$/);
    expect(messageHashOf(snapshot)).not.toBe(messageHashOf(compileSvmMessage({ ...first.expected, memo: "subetha:x" })));
    expect(verifySvmSignature(signature, snapshot, first.router)).toBe(true);
    expect(verifySvmSignature(signature, snapshot, first.provider)).toBe(false);
    expect(verifySvmSignature(signature.subarray(1), snapshot, first.router)).toBe(false);
  });

  test("wire: 署名 2 つ（[0] 全ゼロ、[1] = 署名）、message は snapshot と byte 一致、≤ 1,232。再検査は 2 組とも通り、受信の第 2 層も通る", () => {
    for (const keys of [first, second]) {
      const { snapshot, signature, wire } = signed(keys);
      expect(wire[0]).toBe(2);
      expect(wire.subarray(1, 65).every((b) => b === 0)).toBe(true);
      expect(Buffer.from(wire.subarray(65, 129))).toEqual(Buffer.from(signature));
      expect(Buffer.from(wire.subarray(129))).toEqual(Buffer.from(snapshot));
      expect(wire.length).toBeLessThanOrEqual(SVM_TRANSACTION_MAX_BYTES);
      expect(recheckSvmWire(wire, snapshot, signature, keys.expected, keys.provider)).toEqual({ ok: true });
    }
  });

  test("再検査の否定: snapshot と違う message・署名の数・[0] が非ゼロ・[1] が壊れている・1,233 バイト・読み残し", () => {
    const { snapshot, signature, wire } = signed(first);
    // 同じ長さで中身が違う snapshot（長さが違えば読み残しとして先に落ちる）。
    const other = compileSvmMessage({ ...first.expected, memo: `subetha:${"x".repeat(PAYMENT_ID.length)}` });
    expect(other.length).toBe(snapshot.length);
    expect(recheckSvmWire(wire, other, signature, first.expected, first.provider)).toEqual({ ok: false, reason: "message_mismatch" });
    // 長さの違う snapshot は読み残しとして落ちる。
    expect(recheckSvmWire(wire, compileSvmMessage({ ...first.expected, memo: "subetha:short" }), signature, first.expected, first.provider)).toEqual({ ok: false, reason: "trailing_bytes" });
    const count1 = Uint8Array.from(wire); count1[0] = 1;
    expect(recheckSvmWire(count1, snapshot, signature, first.expected, first.provider).ok).toBe(false);
    const fee = Uint8Array.from(wire); fee[5] = 1;
    expect(recheckSvmWire(fee, snapshot, signature, first.expected, first.provider)).toEqual({ ok: false, reason: "fee_payer_signature" });
    const broken = Uint8Array.from(wire); broken[70] = (broken[70] ?? 0) ^ 1;
    expect(recheckSvmWire(broken, snapshot, signature, first.expected, first.provider)).toEqual({ ok: false, reason: "signature_mismatch" });
    // 署名は合うが、別の鍵の署名を渡した（snapshot・署名が一致しても ed25519 が落ちる第 2 層）。
    const otherSig = ed25519.sign(snapshot, seedOf(999));
    const otherWire = assembleSvmWire(snapshot, first.expected, otherSig);
    expect(recheckSvmWire(otherWire, snapshot, otherSig, first.expected, first.provider)).toEqual({ ok: false, reason: "second_layer_credential_mismatch" });
    const big = new Uint8Array(SVM_TRANSACTION_MAX_BYTES + 1); big.set(wire);
    expect(recheckSvmWire(big, snapshot, signature, first.expected, first.provider)).toEqual({ ok: false, reason: "too_large" });
    expect(recheckSvmWire(new Uint8Array([...wire, 0]), snapshot, signature, first.expected, first.provider)).toEqual({ ok: false, reason: "trailing_bytes" });
    // policy の payTo が違えば第 2 層で落ちる（authority === payTo の検査）。
    expect(recheckSvmWire(wire, snapshot, signature, first.expected, first.router).ok).toBe(false);
  });
});

describe("buildSvmTransactionMessage の lastValidBlockHeight", () => {
  test("引数に足しても message の bytes は変わらない（lifetime の高さは message に入らない）。省略は 0n", () => {
    const base = { ...first.expected };
    const withHeight = getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(buildSvmTransactionMessage({ ...base, lastValidBlockHeight: 999n })));
    const { lastValidBlockHeight: _omit, ...rest } = base;
    const without = getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(buildSvmTransactionMessage(rest)));
    expect(Buffer.from(withHeight)).toEqual(Buffer.from(without));
    const message = buildSvmTransactionMessage({ ...base, lastValidBlockHeight: 999n });
    expect((message as { lifetimeConstraint?: { lastValidBlockHeight?: bigint } }).lifetimeConstraint?.lastValidBlockHeight).toBe(999n);
  });
});

// 参照だけ（型の確認）。
void COMPUTE_BUDGET_PROGRAM_ADDRESS;
void MEMO_PROGRAM_ADDRESS;

/** Memo 任意・compute budget の形（`docs/mpp-solana-design.md` §5.1、タスク M2）: x402 の既定の bytes は変わらず、MPP Solana の形も同じ部品で組めて検査できる。 */
describe("Memo 任意・compute budget の形（M2）", () => {
  test("memo 無し: 命令 3 つ・readonly non-signer 3・Memo program 無し。検査・署名・wire の再検査（第 2 層も memo 無しの形）が通り、memo の有無が違えば落ちる", () => {
    const expected: SvmExpected = Object.freeze({ ...first.expected, memo: undefined });
    const bytes = compileSvmMessage(expected);
    const compiled = getCompiledTransactionMessageDecoder().decode(bytes) as unknown as { instructions: readonly unknown[]; header: { numReadonlyNonSignerAccounts: number }; staticAccounts: readonly string[] };
    expect(compiled.instructions.length).toBe(3);
    expect(compiled.header.numReadonlyNonSignerAccounts).toBe(3);
    expect(compiled.staticAccounts.map(String)).not.toContain(String(MEMO_PROGRAM_ADDRESS));
    expect(compiled.staticAccounts.map(String)).toEqual([...expectedStaticAccountsOf(expected)]);
    expect(checkSvmOutboundMessage(bytes, expected)).toEqual({ ok: true });
    expect(checkSvmOutboundMessage(compileSvmMessage(first.expected), expected).ok).toBe(false);
    expect(checkSvmOutboundMessage(bytes, first.expected).ok).toBe(false);
    const signature = ed25519.sign(bytes, first.routerSeed);
    expect(verifySvmSignature(signature, bytes, first.router)).toBe(true);
    const wire = assembleSvmWire(bytes, expected, signature);
    expect(recheckSvmWire(wire, bytes, signature, expected, first.provider)).toEqual({ ok: true });
    expect(recheckSvmWire(wire, bytes, signature, first.expected, first.provider).ok).toBe(false);
  });

  test("x402 の bytes は変わらない: 既定の引数と明示の limit-first は同じ bytes。price-first は別の bytes で送信の検査（limit-first 固定）が落ちる。片方だけの compute budget も組める", () => {
    const params = { ...first.expected };
    const encode = (message: ReturnType<typeof buildSvmTransactionMessage>): Uint8Array => Uint8Array.from(getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message)));
    const base = encode(buildSvmTransactionMessage(params));
    expect(Buffer.compare(Buffer.from(base), Buffer.from(compileSvmMessage(first.expected)))).toBe(0);
    const explicit = encode(buildSvmTransactionMessage({ ...params, computeBudget: { limit: true, price: true, order: "limit-first" } }));
    expect(Buffer.compare(Buffer.from(explicit), Buffer.from(base))).toBe(0);
    const priceFirst = encode(buildSvmTransactionMessage({ ...params, computeBudget: { limit: true, price: true, order: "price-first" } }));
    expect(Buffer.compare(Buffer.from(priceFirst), Buffer.from(base))).not.toBe(0);
    expect(checkSvmOutboundMessage(priceFirst, first.expected)).toEqual({ ok: false, reason: "compute_limit" });
    const instructionCount = (bytes: Uint8Array): number => (getCompiledTransactionMessageDecoder().decode(bytes) as unknown as { instructions: readonly unknown[] }).instructions.length;
    const priceOnly = { instructions: { length: instructionCount(encode(buildSvmTransactionMessage({ ...params, computeBudget: { limit: false, price: true, order: "limit-first" } }))) } };
    expect(priceOnly.instructions.length).toBe(3);
    const none = { instructions: { length: instructionCount(encode(buildSvmTransactionMessage({ ...params, memo: undefined, computeBudget: { limit: false, price: false, order: "limit-first" } }))) } };
    expect(none.instructions.length).toBe(1);
  });
});
