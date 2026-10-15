/**
 * 診断の記録の共有の部品（`src/shared/diagnostics.ts`。設計 `docs/rejection-reasons-design.md` §2.2・§3・§5.2、§12.1・§12.6・§12.7・§13.1）。
 * - 検査: 許す形は全部通り、知らない鍵・集合の外の値・形の違う文字列は行ごと落ちる
 * - canary: 生の理由・quoteId・requestId・nonce・from・例外の文がどの行にも残らない
 * - `cid` は自前の facilitator の `identify` の `key` と同じ入力・同じ正規化（大文字小文字の混じった値で）
 * - scope: 交互に進む 2 つの購入・throw・遅れて届く callback で、それぞれの購入に正しく付く（積む時点の scope）
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { hexToBytes, keccak256 } from "viem";
import { describe, expect, test } from "vitest";

import type { TransportCode } from "../../src/net/guarded-fetch.js";
import {
  buildDiagRecord,
  currentDiagnosticScope,
  DIAG_BROADCASTS,
  DIAG_CODES,
  DIAG_COUNTER_KEYS,
  DIAG_FACILITATORS,
  DIAG_CAPTURE_FIELD_COUNT,
  DIAG_MAX_STRING_BYTES,
  INVALID,
  localTxRefOf,
  DIAG_NETWORKS,
  DIAG_OPS,
  DIAG_OUTCOMES,
  DIAG_REASON_FIELDS,
  DIAG_REASON_SOURCES,
  DIAG_RECEIPT_HEADERS,
  DIAG_RECEIPTS,
  DIAG_RESPONSES,
  DIAG_RPC_CLASSES,
  DIAG_SIGNER_STAGES,
  DIAG_TRANSPORT_CODES,
  DIAG_TX_REF_CHECKS,
  diagCorrelationIdOf,
  NOOP_DIAGNOSTICS,
  quoteHashOf,
  requestHashOf,
  safeEmit,
  snapshotCapture,
  STAGES_OF_COMPONENT,
  validateDiagRecord,
  withDiagnosticScope,
  zeroCounters,
  type DiagCapture,
  type DiagCidInput,
  type DiagComponent,
  type DiagTransportCode,
} from "../../src/shared/diagnostics.js";
import { classifyReason, REASON_MANIFEST, REASON_TABLE_VERSION } from "../../src/shared/payment-reasons.js";
import {
  createEvmFacilitator,
  DEFAULT_MAX_SETTLE_GAS,
  type ChainIo,
  type FacilitatorJournal,
  type Hex,
  type JournalRecord,
} from "../../tools/evm-facilitator.js";
import { recordingDiagnostics, throwingDiagnostics } from "../fixtures/diagnostics.js";

const PAYMENT_ID = "0b6f3c1e-7f0a-4a52-9a43-0c7d2b8f1e11";
const QUOTE_ID = `0x${"ab".repeat(32)}`;
const HEX16 = /^[0-9a-f]{16}$/;

function base(component: DiagComponent = "router", stage = "source_verify"): Record<string, unknown> {
  return { v: 1, at: "2026-10-15T01:02:03.004Z", seq: 0, component, stage };
}

/** 型の一致（`TransportCode` と診断の 7 つ）。片方が増えればここで型の誤り。 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const transportCodesMatch: Equal<TransportCode, DiagTransportCode> = true;

describe("validateDiagRecord: 許す形", () => {
  test("component ごとの全部の段が通る", () => {
    for (const [component, stages] of Object.entries(STAGES_OF_COMPONENT) as Array<[DiagComponent, readonly string[]]>) {
      for (const stage of stages) {
        const record = component === "sink" ? { ...base(component, stage), counters: zeroCounters() } : base(component, stage);
        expect(validateDiagRecord(record), `${component}/${stage}`).toEqual(record);
      }
    }
  });

  test("閉じた集合の各値が通る", () => {
    const sets: Array<[string, readonly unknown[]]> = [
      ["network", DIAG_NETWORKS],
      ["facilitator", DIAG_FACILITATORS],
      ["op", DIAG_OPS],
      ["transport", DIAG_TRANSPORT_CODES],
      ["response", DIAG_RESPONSES],
      ["receipt", DIAG_RECEIPTS],
      ["receiptHeader", DIAG_RECEIPT_HEADERS],
      ["reasonField", DIAG_REASON_FIELDS],
      ["reasonSource", DIAG_REASON_SOURCES],
      ["outcome", DIAG_OUTCOMES],
      ["code", [...DIAG_CODES]],
      ["rpc", DIAG_RPC_CLASSES],
      ["txRefCheck", DIAG_TX_REF_CHECKS],
      ["broadcast", DIAG_BROADCASTS],
      ["signerStage", DIAG_SIGNER_STAGES],
      ["promoted", [true, false]],
      ["fundsMayHaveMoved", [true, false]],
      ["attempt", [1, 1000]],
      ["httpStatus", [100, 599]],
      ["rpcHttpStatus", [100, 599]],
      ["rpcCode", [-(2 ** 31), -32005, 0, 2 ** 31]],
      ["elapsedMs", [0, 3_600_000]],
      ["bytes", [0, 2 ** 31]],
      ["paymentId", [PAYMENT_ID]],
      ["quoteHash", ["0123456789abcdef"]],
      ["requestHash", ["0123456789abcdef"]],
      ["cid", ["0123456789abcdef"]],
      ["routeId", ["md-mpp-eth-snapshot", "dyn-x402-to-mpp", "a", "A.b_c@d:e-f"]],
      ["txRef", [`0x${"0a".repeat(32)}`]],
    ];
    // txRef・txRefCheck は署名の道具・driver の行だけ（§12.4）。
    const signerOnly = new Set(["txRef", "txRefCheck"]);
    for (const [key, values] of sets) {
      for (const value of values) {
        const record = { ...(signerOnly.has(key) ? base("signer", "sign") : base()), [key]: value };
        expect(validateDiagRecord(record), `${key}=${String(value)}`).toEqual(record);
      }
    }
  });

  test("reason は表の token・absent・malformed・unrecognized で、table と組", () => {
    for (const reason of [...new Set(REASON_MANIFEST.map((e) => e.token)), "absent", "malformed", "unrecognized"]) {
      const record = { ...base(), reason, table: REASON_TABLE_VERSION };
      expect(validateDiagRecord(record), reason).toEqual(record);
    }
  });
});

describe("validateDiagRecord: 拒む形（行ごと捨てる。読み替えない）", () => {
  const cases: Array<[string, unknown]> = [
    ["object でない", "x"],
    ["null", null],
    ["配列", []],
    ["知らない鍵", { ...base(), message: "boom" }],
    ["知らない鍵（quoteId はそのまま残さない）", { ...base(), quoteId: QUOTE_ID }],
    ["知らない鍵（txRefSource は §12.4 で txRefCheck に替えた）", { ...base(), txRefSource: "computed" }],
    ["__proto__ の鍵", JSON.parse(`{"v":1,"at":"2026-10-15T01:02:03.004Z","seq":0,"component":"router","stage":"source_verify","__proto__":{"x":1}}`)],
    ["constructor の鍵", { ...base(), constructor: 1 }],
    ["v が 2", { ...base(), v: 2 }],
    ["at が ISO でない", { ...base(), at: "2026-10-15 01:02:03" }],
    ["seq が負", { ...base(), seq: -1 }],
    ["seq が小数", { ...base(), seq: 1.5 }],
    ["component が集合の外", { ...base(), component: "provider" }],
    ["段が component に合わない", base("facilitator", "source_verify")],
    ["段が集合の外", base("router", "dest_reject_body")],
    ["必須の欠け（stage）", { v: 1, at: "2026-10-15T01:02:03.004Z", seq: 0, component: "router" }],
    ["paymentId の形違い", { ...base(), paymentId: "not a uuid at all, has spaces!!!!!!!" }],
    ["attempt 0", { ...base(), attempt: 0 }],
    ["attempt 1001", { ...base(), attempt: 1001 }],
    ["quoteHash が大文字", { ...base(), quoteHash: "0123456789ABCDEF" }],
    ["cid が 17 hex", { ...base(), cid: "0123456789abcdef0" }],
    ["routeId に空白", { ...base(), routeId: "md mpp" }],
    ["routeId が 97 文字", { ...base(), routeId: "a".repeat(97) }],
    ["network が集合の外", { ...base(), network: "eip155:1" }],
    ["op が集合の外（読み替えは処理の側で、検査は拒む）", { ...base(), op: "fetch" }],
    ["httpStatus 99", { ...base(), httpStatus: 99 }],
    ["httpStatus 600", { ...base(), httpStatus: 600 }],
    ["httpStatus が文字列", { ...base(), httpStatus: "500" }],
    ["transport が集合の外", { ...base(), transport: "tls_failed" }],
    ["reason が自由な文字列", { ...base(), reason: "insufficient funds for 0xabc", table: REASON_TABLE_VERSION }],
    ["reason に table が無い", { ...base(), reason: "absent" }],
    ["table だけ", { ...base(), table: REASON_TABLE_VERSION }],
    ["table の版違い", { ...base(), reason: "absent", table: "r0/x402-2.27.0" }],
    ["outcome が集合の外", { ...base(), outcome: "delivered" }],
    ["code が集合の外", { ...base(), code: "something_else" }],
    ["rpcCode が範囲の外", { ...base(), rpcCode: 2 ** 31 + 1 }],
    ["elapsedMs が小数", { ...base(), elapsedMs: 1.5 }],
    ["elapsedMs が 1 時間超", { ...base(), elapsedMs: 3_600_001 }],
    ["elapsedMs が NaN", { ...base(), elapsedMs: Number.NaN }],
    ["txRef が大文字", { ...base("signer", "sign"), txRef: `0x${"0A".repeat(32)}` }],
    ["txRef が短い", { ...base("signer", "sign"), txRef: "0x1234" }],
    ["txRef が Router の行", { ...base(), txRef: `0x${"0a".repeat(32)}` }],
    ["txRef が facilitator の行", { ...base("facilitator", "rpc"), txRef: `0x${"0a".repeat(32)}` }],
    ["txRefCheck が Router の行", { ...base(), txRefCheck: "match" }],
    ["promoted が文字列", { ...base(), promoted: "true" }],
    ["counters が sink 以外", { ...base(), counters: zeroCounters() }],
    ["sink に counters が無い", base("sink", "counters")],
    ["counters の鍵が足りない", { ...base("sink", "counters"), counters: { written: 1 } }],
    ["counters の知らない鍵", { ...base("sink", "counters"), counters: { ...zeroCounters(), extra: 1 } }],
    ["counters の値が負", { ...base("sink", "counters"), counters: { ...zeroCounters(), written: -1 } }],
  ];
  test.each(cases)("%s", (_name, value) => {
    expect(validateDiagRecord(value)).toBeUndefined();
  });

  test("数の鍵は固定の集合", () => {
    expect(Object.keys(zeroCounters())).toEqual([...DIAG_COUNTER_KEYS]);
  });
});

function entryOf(capture: DiagCapture, scope?: Parameters<typeof withDiagnosticScope>[0], component: Exclude<DiagComponent, "sink"> = "router"): Promise<ReturnType<typeof buildDiagRecord>> {
  const sink = recordingDiagnostics(component);
  const run = async (): Promise<void> => {
    sink.emit(capture);
  };
  return (scope === undefined ? run() : withDiagnosticScope(scope, run)).then(() => buildDiagRecord(sink.entries[0]!, component));
}

describe("buildDiagRecord（後回しの処理）", () => {
  test("network・op・code は集合の外を読み替える", async () => {
    const r = await entryOf({ stage: "transport_event", network: "eip155:1", op: "custom_op", code: "free text code" });
    expect(r).toMatchObject({ network: "unrecognized", op: "other", code: "unrecognized" });
  });

  test("知らない鍵・記録の欄の名前の鍵は写さない（hash・分類を迂回できない。書かれない）", async () => {
    const plain = await entryOf({ stage: "source_verify", httpStatus: 400 });
    expect(plain).toBeDefined();
    for (const extra of [{ message: "x" }, { cid: "0123456789abcdef" }, { quoteHash: "0123456789abcdef" }, { table: REASON_TABLE_VERSION }, { reason: "absent" }, { counters: zeroCounters() }, { seq: 99 }, { v: 2 }, { component: "sink" }]) {
      const r = await entryOf({ stage: "source_verify", httpStatus: 400, ...extra } as unknown as DiagCapture);
      expect(r, JSON.stringify(extra)).toEqual(plain);
    }
  });

  test("知っている欄の型違い（数の欄に文字列・関数・object）は行ごと落ちる", async () => {
    for (const bad of [{ httpStatus: "500" }, { outcome: () => "rejected" }, { code: { toString: () => "verify_failed" } }, { promoted: "true" }, { stage: 1 }, { elapsedMs: 10n }]) {
      expect(await entryOf({ stage: "source_verify", ...bad } as unknown as DiagCapture), String(Object.keys(bad))).toBeUndefined();
    }
  });

  test("集合の外の閉じた値は行ごと落ちる（読み替えない）", async () => {
    expect(await entryOf({ stage: "source_verify", outcome: "delivered" } as unknown as DiagCapture)).toBeUndefined();
    expect(await entryOf({ stage: "source_verify", httpStatus: 42 })).toBeUndefined();
    expect(await entryOf({ stage: "nope" } as unknown as DiagCapture)).toBeUndefined();
  });

  test("rawReason は表で完全一致に分類し table を付ける。大きすぎは malformed", async () => {
    expect(await entryOf({ stage: "source_verify", rawReason: "invalid_exact_evm_insufficient_balance" })).toMatchObject({ reason: "invalid_exact_evm_insufficient_balance", table: REASON_TABLE_VERSION });
    expect(await entryOf({ stage: "source_verify", rawReason: "No matching payment requirements" })).toMatchObject({ reason: "sdk_no_matching_requirements" });
    expect(await entryOf({ stage: "source_verify", rawReason: null })).toMatchObject({ reason: "absent" });
    expect(await entryOf({ stage: "source_verify", rawReason: 42 })).toMatchObject({ reason: "malformed" });
    expect(await entryOf({ stage: "source_verify", rawReason: { nested: "x" } })).toMatchObject({ reason: "malformed" });
    expect(await entryOf({ stage: "source_verify", rawReason: () => "invalid_exact_evm_insufficient_balance" })).toMatchObject({ reason: "malformed" });
    expect(await entryOf({ stage: "source_verify", rawReason: Symbol("x") })).toMatchObject({ reason: "malformed" });
    expect(await entryOf({ stage: "source_verify", rawReason: undefined })).toMatchObject({ reason: "absent" });
    expect(await entryOf({ stage: "source_verify", rawReason: "x".repeat(DIAG_MAX_STRING_BYTES / 2 + 1) })).toMatchObject({ reason: "malformed" });
    expect(await entryOf({ stage: "source_verify", rawReason: "Invalid_exact_evm_insufficient_balance" })).toMatchObject({ reason: "unrecognized" });
    const none = await entryOf({ stage: "source_verify" });
    expect(none).not.toHaveProperty("reason");
    expect(none).not.toHaveProperty("table");
  });

  test("txRef は localTxRefOf（手元で keccak256）の値だけ、signer・driver の行だけ。elapsedMs は整数に丸める", async () => {
    const signed = `0x02${"ab".repeat(100)}` as const;
    const ref = localTxRefOf(signed);
    expect(ref.hash).toBe(keccak256(signed));
    expect(localTxRefOf(hexToBytes(signed)).hash).toBe(ref.hash);
    expect(await entryOf({ stage: "sign", txRef: ref, elapsedMs: 12.6 }, undefined, "signer")).toMatchObject({ txRef: ref.hash, elapsedMs: 13 });
    expect(await entryOf({ stage: "sign", txRef: ref }, undefined, "driver")).toMatchObject({ txRef: ref.hash });
    // Router の行は、正しく作った値でも落ちる
    expect(await entryOf({ stage: "dest_sign", txRef: ref })).toBeUndefined();
    // nonce・鍵の形の値を偽った object・文字列は、signer の行でも落ちる（値は書かれない）
    const nonceShaped = `0x${"c4".repeat(32)}`;
    for (const forged of [{ hash: nonceShaped }, Object.freeze({ hash: nonceShaped }), nonceShaped, { ...ref }]) {
      expect(await entryOf({ stage: "dest_sign", txRef: forged } as unknown as DiagCapture), JSON.stringify(forged)).toBeUndefined();
      expect(await entryOf({ stage: "sign", txRef: forged } as unknown as DiagCapture, undefined, "signer"), JSON.stringify(forged)).toBeUndefined();
    }
    expect(() => localTxRefOf("0x" as `0x${string}`)).toThrow();
    expect(() => localTxRefOf("0xabc" as `0x${string}`)).toThrow();
    expect(() => localTxRefOf(new Uint8Array(0))).toThrow();
  });

  test("scope の quoteId・requestId は hash だけ、cid は capture の rawCid が scope に優先", async () => {
    const scopeCid = { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", from: "0x1111111111111111111111111111111111111111", nonce: `0x${"11".repeat(32)}` };
    const ownCid = { ...scopeCid, nonce: `0x${"22".repeat(32)}` };
    const r = await entryOf({ stage: "source_verify", rawCid: ownCid }, { paymentId: PAYMENT_ID, quoteId: QUOTE_ID, principalId: "principal-1", requestId: "purchase-1", routeId: "md-mpp-eth-snapshot", promoted: true, cidInput: scopeCid });
    expect(r).toMatchObject({
      paymentId: PAYMENT_ID,
      quoteHash: quoteHashOf(QUOTE_ID),
      requestHash: requestHashOf("principal-1", "purchase-1"),
      cid: diagCorrelationIdOf(ownCid.network, ownCid.asset, ownCid.from, ownCid.nonce),
      routeId: "md-mpp-eth-snapshot",
      promoted: true,
    });
    const r2 = await entryOf({ stage: "source_verify" }, { cidInput: scopeCid });
    expect(r2).toMatchObject({ cid: diagCorrelationIdOf(scopeCid.network, scopeCid.asset, scopeCid.from, scopeCid.nonce) });
  });

  test("snapshotCapture は写す（後で呼び出し側の object を変えても変わらない）", () => {
    const cid = { network: "eip155:84532", asset: "0xa", from: "0xb", nonce: "0xc" };
    const capture: { stage: "source_verify"; rawCid: typeof cid; httpStatus: number } = { stage: "source_verify", rawCid: cid, httpStatus: 400 };
    const snap = snapshotCapture(capture);
    cid.nonce = "0xd";
    capture.httpStatus = 500;
    expect(snap.value["httpStatus"]).toBe(400);
    expect((snap.value["rawCid"] as { nonce: string }).nonce).toBe("0xc");
    expect(Object.isFrozen(snap.value)).toBe(true);
  });
});

describe("canary（SR-R1・SR-R2）: 生の値はどの行にも残らない", () => {
  test("理由・quoteId・requestId・principal・nonce・from・例外の文・URL", async () => {
    const canaryReason = "CANARY-reason insufficient funds https://rpc.example/secret?key=abc";
    const canaryNonce = `0x${"c4".repeat(32)}`;
    const canaryFrom = "0xC4C4c4c4C4c4c4c4c4C4c4C4C4c4C4c4C4C4c4c4";
    const canaryRequest = "CANARY-request-id-7f3a";
    const canaryPrincipal = "CANARY-principal-91b2";
    const sink = recordingDiagnostics();
    await withDiagnosticScope({ paymentId: PAYMENT_ID, quoteId: canaryNonce, principalId: canaryPrincipal, requestId: canaryRequest }, async () => {
      sink.emit({ stage: "source_settle", rawReason: canaryReason, rawCid: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", from: canaryFrom, nonce: canaryNonce }, code: canaryReason, op: canaryReason, network: canaryReason });
      sink.emit({ stage: "dest_pay_request", rawReason: "invalid_exact_evm_insufficient_balance", httpStatus: 402 });
      sink.emit({ stage: "dest_pay_request", routeId: canaryReason }); // routeId の形違い → 行ごと落ちる
    });
    const records = sink.records();
    expect(records).toHaveLength(2);
    expect(sink.rejected()).toBe(1);
    const text = records.map((r) => JSON.stringify(r)).join("\n");
    for (const canary of [canaryReason, "CANARY", canaryNonce, canaryNonce.slice(2), canaryFrom, canaryFrom.toLowerCase(), canaryFrom.slice(2).toLowerCase(), canaryRequest, canaryPrincipal, "rpc.example", "secret"]) {
      expect(text.includes(canary), canary).toBe(false);
    }
    // nonce の 16 hex の部分列も（hash の先頭がたまたま一致しないこと）
    expect(text.includes("c4c4c4c4")).toBe(false);
  });
});

describe("hash", () => {
  test("16 hex・domain を分ける・quoteId は大文字小文字を同じに", () => {
    expect(quoteHashOf(QUOTE_ID)).toMatch(HEX16);
    expect(quoteHashOf(QUOTE_ID.toUpperCase().replace("0X", "0x"))).toBe(quoteHashOf(QUOTE_ID));
    expect(requestHashOf("p", "r")).toMatch(HEX16);
    expect(requestHashOf("p", "r")).not.toBe(requestHashOf("p", "r2"));
    const plain = createHash("sha256").update(QUOTE_ID, "utf8").digest("hex").slice(0, 16);
    expect(quoteHashOf(QUOTE_ID)).not.toBe(plain);
    // 既知の値（式を固定する）
    expect(quoteHashOf(QUOTE_ID)).toBe(createHash("sha256").update(`subetha-diag-quote/v1|${QUOTE_ID}`, "utf8").digest("hex").slice(0, 16));
    expect(requestHashOf("p", "r")).toBe(createHash("sha256").update("subetha-diag-req/v1|p|r", "utf8").digest("hex").slice(0, 16));
  });

  test("cid: EVM は asset・from・nonce の大文字小文字を同じに、SVM の asset はそのまま", () => {
    const n = "eip155:46630";
    const lower = diagCorrelationIdOf(n, "0x7e955252e15c84f5768b83c41a71f9eba181802f", "0xfcea8a897af225bd00cf815bf41966ca6bf60bf1", `0x${"ab".repeat(32)}`);
    const mixed = diagCorrelationIdOf(n, "0x7E955252E15c84f5768B83c41a71F9eba181802F", "0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1", `0x${"aB".repeat(32)}`);
    expect(mixed).toBe(lower);
    expect(lower).toMatch(HEX16);
    const sol = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    expect(diagCorrelationIdOf(sol, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", "a", "b")).not.toBe(diagCorrelationIdOf(sol, "4zmmc9srt5ri5x14gagxhahii3gnpaeerypjgzjdncdu", "a", "b"));
    expect(diagCorrelationIdOf(n, "0xa", "0xb", "0xc")).not.toBe(diagCorrelationIdOf("eip155:84532", "0xa", "0xb", "0xc"));
  });
});

describe("cid は自前の facilitator の key と同じ入力（tools/evm-facilitator.ts identify）", () => {
  const RH = "eip155:46630";
  const USDG_MIXED = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
  const PAYTO = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
  const NOW_MS = 1_800_000_000_000;

  function fakeIo(): ChainIo {
    return {
      maxLogRange: 500n,
      maxFeePerGas: 10n * 1_000_000_000n,
      gasCap: 10n ** 18n,
      maxSettleGas: DEFAULT_MAX_SETTLE_GAS[RH]!,
      reader: {
        authorizationState: async () => false,
        blockNumber: async () => 100n,
        blockTimestamp: async () => NOW_MS / 1000,
        authorizationUsedLogs: async () => [],
        receipt: async () => undefined,
        waitForReceipt: async () => undefined,
        feesPerGas: async () => ({ maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
        estimateTransferGas: async () => 100_000n,
      },
      writer: { address: "0x54633d372d7316435891EEBBaAB90861F8c1Dadc", transferWithAuthorization: async () => `0x${"ee".repeat(32)}` as Hex },
      verify: async () => ({ isValid: true }),
    };
  }

  const vectors: Array<[string, string, string]> = [
    ["混じった from・nonce", "0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1", `0x${"aB".repeat(16)}${"Cd".repeat(16)}`],
    ["全部大文字の from・nonce", "0xFCEA8A897AF225BD00CF815BF41966CA6BF60BF1", `0x${"EF".repeat(32)}`],
    ["全部小文字", "0xfcea8a897af225bd00cf815bf41966ca6bf60bf1", `0x${"0f".repeat(32)}`],
  ];

  test.each(vectors)("%s", async (_name, from, nonce) => {
    const records: JournalRecord[] = [];
    const journal: FacilitatorJournal = {
      load: async () => [...records],
      append: async (record) => {
        records.push(record);
      },
    };
    const f = createEvmFacilitator({ networks: [RH], chains: new Map([[RH, fakeIo()]]), journal, payToAllowlist: [PAYTO], clock: { now: () => NOW_MS } });
    await f.start();
    const requirements = { scheme: "exact", network: RH, asset: USDG_MIXED, amount: "10000", payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: "Global Dollar", version: "1", assetTransferMethod: "eip3009" } };
    const authorization = { from, to: PAYTO, value: "10000", validAfter: "0", validBefore: String(NOW_MS / 1000 + 60), nonce };
    const bodyJson = { x402Version: 2, paymentPayload: { x402Version: 2, accepted: requirements, payload: { authorization, signature: `0x${"11".repeat(65)}` } }, paymentRequirements: requirements };
    await f.handle({ method: "POST", url: "/tok/settle", headers: { host: "127.0.0.1:8611", "content-type": "application/json" }, body: JSON.stringify(bodyJson) }, { token: "tok", port: () => 8611 });
    const intent = records.find((r) => r.type === "submit_intent") as (JournalRecord & { key: string }) | undefined;
    expect(intent, "facilitator wrote submit_intent").toBeDefined();
    const fromKey = createHash("sha256").update(`subetha-diag-cid/v1|${intent!.key}`, "utf8").digest("hex").slice(0, 16);
    expect(diagCorrelationIdOf(RH, USDG_MIXED, from, nonce)).toBe(fromKey);
  });
});

describe("scope（AsyncLocalStorage、積む時点の scope）", () => {
  const tickWait = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

  test("交互に進む 2 つの購入・入れ子の段・throw・遅れて届く callback・scope の外", async () => {
    const sink = recordingDiagnostics();
    const lateCallbacks: Array<() => void> = [];
    const purchase = async (paymentId: string, quoteId: string, fail: boolean): Promise<string> =>
      withDiagnosticScope({ paymentId, quoteId, routeId: "md-mpp-eth-snapshot" }, async () => {
        sink.emit({ stage: "source_verify", outcome: "valid" });
        await tickWait(1);
        // 遅れて届く callback（transport の report の形）: 購入が終わった後に呼ばれる
        setTimeout(() => sink.emit({ stage: "transport_event", transport: "upstream_timeout" }), 5);
        // scope の外で登録された callback を購入の中から呼ぶ（その時点の scope が付く）
        lateCallbacks.push(() => sink.emit({ stage: "dest_challenge", code: "status" }));
        await withDiagnosticScope({ attempt: 1 }, async () => {
          await tickWait(1);
          sink.emit({ stage: "dest_outcome", outcome: "rejected" });
          if (fail) throw new Error("purchase threw");
        });
        return paymentId;
      });
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const qa = `0x${"0a".repeat(32)}`;
    const qb = `0x${"0b".repeat(32)}`;
    const results = await Promise.allSettled([purchase(a, qa, false), purchase(b, qb, true)]);
    expect(results[0]).toEqual({ status: "fulfilled", value: a });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    await tickWait(20);
    for (const cb of lateCallbacks) cb(); // ここは scope の外
    sink.emit({ stage: "transport_event", transport: "dns_failed" });
    expect(currentDiagnosticScope()).toBeUndefined();

    const records = sink.records();
    expect(sink.rejected()).toBe(0);
    const of = (id: string | undefined) => records.filter((r) => r.paymentId === id).map((r) => `${r.stage}:${r.attempt ?? "-"}:${r.quoteHash ?? "-"}`).sort();
    expect(of(a)).toEqual([`dest_outcome:1:${quoteHashOf(qa)}`, `source_verify:-:${quoteHashOf(qa)}`, `transport_event:-:${quoteHashOf(qa)}`].sort());
    expect(of(b)).toEqual([`dest_outcome:1:${quoteHashOf(qb)}`, `source_verify:-:${quoteHashOf(qb)}`, `transport_event:-:${quoteHashOf(qb)}`].sort());
    const outside = records.filter((r) => r.paymentId === undefined);
    expect(outside.map((r) => r.stage).sort()).toEqual(["dest_challenge", "dest_challenge", "transport_event"]);
    for (const r of outside) expect(r).not.toHaveProperty("quoteHash");
  });

  test("返り値と例外はそのまま（同期の throw は同期のまま）", async () => {
    await expect(withDiagnosticScope({ paymentId: PAYMENT_ID }, async () => 42)).resolves.toBe(42);
    const error = new Error("x");
    await expect(withDiagnosticScope({}, async () => Promise.reject(error))).rejects.toBe(error);
    expect(() =>
      withDiagnosticScope({}, () => {
        throw error;
      }),
    ).toThrow(error);
  });

  test("大きすぎる scope の文字列は scope に入れない（hash の欄が書かれないだけ）", async () => {
    const sink = recordingDiagnostics();
    await withDiagnosticScope({ quoteId: "q".repeat(DIAG_MAX_STRING_BYTES / 2 + 1), paymentId: PAYMENT_ID }, async () => {
      sink.emit({ stage: "source_verify" });
    });
    const [r] = sink.records();
    expect(r).toMatchObject({ paymentId: PAYMENT_ID });
    expect(r).not.toHaveProperty("quoteHash");
  });
});

describe("safeEmit・NOOP", () => {
  test("build の throw も sink の throw も握る", () => {
    const throwing = throwingDiagnostics();
    expect(() =>
      safeEmit(throwing, () => {
        throw new Error("build");
      }),
    ).not.toThrow();
    expect(() => safeEmit(throwing, () => ({ stage: "source_verify" }))).not.toThrow();
    expect(throwing.calls).toBe(1);
  });
  test("NOOP・undefined は build を呼ばない", () => {
    let built = 0;
    safeEmit(NOOP_DIAGNOSTICS, () => {
      built += 1;
      return { stage: "source_verify" };
    });
    safeEmit(undefined, () => {
      built += 1;
      return { stage: "source_verify" };
    });
    expect(built).toBe(0);
    expect(() => NOOP_DIAGNOSTICS.emit({ stage: "source_verify" })).not.toThrow();
  });
});

describe("classifyReason は完全一致だけ", () => {
  test("前方一致・部分一致・大文字小文字・空白・式で作る文は unrecognized", () => {
    expect(classifyReason("invalid_exact_evm_insufficient_balance")).toBe("invalid_exact_evm_insufficient_balance");
    for (const raw of ["invalid_exact_evm_insufficient", "invalid_exact_evm_insufficient_balance_x", "INVALID_EXACT_EVM_INSUFFICIENT_BALANCE", " invalid_exact_evm_insufficient_balance", "invalid_exact_evm_insufficient_balance\n", "invalid_exact_evm_transaction_failed: execution reverted", "x invalid_exact_evm_insufficient_balance"]) {
      expect(classifyReason(raw), JSON.stringify(raw)).toBe("unrecognized");
    }
    expect(classifyReason(undefined)).toBe("absent");
    expect(classifyReason(null)).toBe("absent");
    expect(classifyReason("")).toBe("malformed");
    expect(classifyReason(0)).toBe("malformed");
    expect(classifyReason(["x"])).toBe("malformed");
  });
});

describe("code の集合は Router の固定の literal を含む（ソースから抜き出す）", () => {
  const read = (file: string): string => readFileSync(file, "utf8");

  test("SAFE_REASONS・SAFE_PREFLIGHT_REASONS", () => {
    const text = read("src/core/orchestrator.ts");
    for (const name of ["SAFE_REASONS", "SAFE_PREFLIGHT_REASONS"]) {
      const block = new RegExp(`const ${name}: ReadonlySet<string> = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(text);
      expect(block, name).not.toBeNull();
      const values = [...block![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
      expect(values.length).toBeGreaterThan(4);
      for (const v of values) expect(DIAG_CODES.has(v), `${name}: ${v}`).toBe(true);
    }
  });

  test("動的の awaiting・rejected の code、not_sent の理由、DynamicChallengeError の理由", () => {
    const dynamic = read("src/core/dynamic.ts");
    for (const m of dynamic.matchAll(/awaiting\("([a-z_]+)"\)/g)) expect(DIAG_CODES.has(m[1]!), m[1]).toBe(true);
    const core = ["dynamic.ts", "orchestrator.ts", "intent.ts"].map((f) => read(`src/core/${f}`)).join("\n");
    for (const m of core.matchAll(/\bcode: "([a-z_]+)"/g)) expect(DIAG_CODES.has(m[1]!), m[1]).toBe(true);
    const outbound = ["x402.ts", "x402-dynamic.ts", "x402-svm.ts", "mpp.ts", "mpp-dynamic.ts", "mpp-solana.ts"].map((f) => read(`src/adapters/outbound/${f}`)).join("\n");
    const notSent = [...outbound.matchAll(/outcome: "not_sent", reason: "([a-z_]+)"/g)].map((m) => m[1]!);
    expect(notSent.length).toBeGreaterThan(5);
    for (const v of notSent) expect(DIAG_CODES.has(v), v).toBe(true);
    const challenge = /class DynamicChallengeError[\s\S]*?readonly reason:([\s\S]*?),\s*\)/.exec(read("src/adapters/outbound/x402-dynamic.ts"));
    const reasons = [...challenge![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(reasons).toHaveLength(9);
    for (const v of reasons) expect(DIAG_CODES.has(v), v).toBe(true);
  });

  test("transport の operation の literal は op の集合にある", () => {
    const files = ["src/adapters/inbound", "src/adapters/outbound", "src/net", "src/core"];
    const text = files.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".ts")).map((f) => read(`${d}/${f}`))).join("\n");
    const ops = new Set([...text.matchAll(/operation: "([a-z_]+)"/g)].map((m) => m[1]!));
    expect(ops.size).toBeGreaterThan(5);
    for (const op of ops) expect((DIAG_OPS as readonly string[]).includes(op), op).toBe(true);
  });

  test("TransportCode の型と一致（型の検査）", () => {
    expect(transportCodesMatch).toBe(true);
  });
});

describe("敵対的な入力: push は固定の欄だけを読み、余分なものを持たない（O(固定)）", () => {
  /** 読み取りを数える proxy（`ownKeys`・列挙が呼ばれたら記録する）。 */
  function counting<T extends object>(target: T): { proxy: T; reads: string[]; enumerated: number } {
    const log = { reads: [] as string[], enumerated: 0 };
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        log.reads.push(String(key));
        return Reflect.get(t, key, receiver);
      },
      has(t, key) {
        log.reads.push(`has:${String(key)}`);
        return Reflect.has(t, key);
      },
      getOwnPropertyDescriptor(t, key) {
        log.reads.push(`own:${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(t, key);
      },
      ownKeys(t) {
        log.enumerated += 1;
        return Reflect.ownKeys(t);
      },
    });
    return { proxy, get reads() { return log.reads; }, get enumerated() { return log.enumerated; } };
  }

  const isRetainable = (v: unknown): boolean => typeof v === "function" || (typeof v === "object" && v !== null && !Object.isFrozen(v));

  test("10 万の余分な欄: 列挙しない・読まない・写さない・量に入らない", () => {
    const plain = snapshotCapture({ stage: "source_verify", httpStatus: 400, rawReason: "invalid_exact_evm_insufficient_balance" });
    const big: Record<string, unknown> = { stage: "source_verify", httpStatus: 400, rawReason: "invalid_exact_evm_insufficient_balance" };
    for (let i = 0; i < 100_000; i += 1) big[`extra${i}`] = i % 2 === 0 ? "x".repeat(100) : i;
    const c = counting(big);
    const snap = snapshotCapture(c.proxy as unknown as DiagCapture);
    expect(c.enumerated).toBe(0);
    expect(c.reads.length).toBeLessThanOrEqual(DIAG_CAPTURE_FIELD_COUNT + 1);
    expect(c.reads.every((k) => !k.includes("extra"))).toBe(true);
    expect(snap).toEqual(plain);
  });

  test("関数・object・getter・proxy の値は持たない（印か primitive だけ）", () => {
    let unknownGetterCalls = 0;
    const closureHeavy = (() => {
      const retained = new Uint8Array(1_000_000);
      return () => retained.length;
    })();
    const capture = Object.defineProperty(
      {
        stage: "source_verify",
        rawReason: closureHeavy,
        code: { toString: () => "verify_failed" },
        outcome: new String("rejected"),
        httpStatus: new Proxy({}, {}),
        rawCid: { network: "eip155:84532", asset: "0xa", from: "0xb", nonce: "0xc", extra: closureHeavy, more: new Uint8Array(10) },
      },
      "zzz",
      { enumerable: true, get: () => ((unknownGetterCalls += 1), "x") },
    ) as unknown as DiagCapture;
    const snap = snapshotCapture(capture);
    expect(unknownGetterCalls).toBe(0);
    expect(snap.value["rawReason"]).toBe(INVALID);
    expect(snap.value["code"]).toBe(INVALID);
    expect(snap.value["outcome"]).toBe(INVALID);
    expect(snap.value["httpStatus"]).toBe(INVALID);
    expect(Object.keys(snap.value).sort()).toEqual(["code", "httpStatus", "outcome", "rawCid", "rawReason", "stage"]);
    expect(snap.value["rawCid"]).toEqual({ network: "eip155:84532", asset: "0xa", from: "0xb", nonce: "0xc" });
    expect(snap.value["rawCid"]).not.toBe((capture as unknown as { rawCid: unknown }).rawCid);
    for (const v of Object.values(snap.value)) expect(isRetainable(v)).toBe(false);
    expect(Object.isFrozen(snap.value)).toBe(true);
  });

  test("rawCid の proxy・型違い: 4 つの欄だけを読み、違えば cid を書かない", async () => {
    const c = counting({ network: "eip155:84532", asset: "0xa", from: "0xb", nonce: "0xc", ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i])) });
    const snap = snapshotCapture({ stage: "source_verify", rawCid: c.proxy as unknown as DiagCidInput });
    expect(c.enumerated).toBe(0);
    expect(c.reads.sort()).toEqual(["asset", "from", "network", "nonce"]);
    expect(Object.keys(snap.value["rawCid"] as object)).toHaveLength(4);
    const r = await entryOf({ stage: "source_verify", rawCid: { network: "eip155:84532", asset: 1, from: "0xb", nonce: "0xc" } as unknown as DiagCidInput });
    expect(r).toBeDefined();
    expect(r).not.toHaveProperty("cid");
  });

  test("scope: 固定の欄・primitive の型だけを持つ。関数・object・余分な欄・proxy の余分な鍵は持たない", async () => {
    const heavy = new Uint8Array(1_000_000);
    const scope = { paymentId: PAYMENT_ID, quoteId: () => heavy, requestId: { big: heavy }, principalId: "p", routeId: 5, promoted: "yes", attempt: 2, cidInput: { network: "eip155:84532", asset: "0xa", from: "0xb", nonce: "0xc", heavy }, extra: heavy, ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, heavy])) };
    const c = counting(scope);
    await withDiagnosticScope(c.proxy as unknown as Parameters<typeof withDiagnosticScope>[0], async () => {
      const current = currentDiagnosticScope()!;
      expect(Object.keys(current).sort()).toEqual(["attempt", "cidInput", "paymentId", "principalId"]);
      expect(current.cidInput).toEqual({ network: "eip155:84532", asset: "0xa", from: "0xb", nonce: "0xc" });
      for (const v of Object.values(current)) expect(isRetainable(v)).toBe(false);
      // 入れ子の scope は前の値を引き継ぎ、型の違う上書きは入れない
      await withDiagnosticScope({ attempt: 3, paymentId: 7 as unknown as string }, async () => {
        expect(currentDiagnosticScope()).toMatchObject({ attempt: 3, principalId: "p" });
        expect(currentDiagnosticScope()).not.toHaveProperty("paymentId");
      });
    });
    expect(c.enumerated).toBe(0);
    expect(c.reads.length).toBeLessThanOrEqual(12);
  });

  test("scope の getter が投げても fn はそのまま動く", async () => {
    const evil = Object.defineProperty({}, "paymentId", { enumerable: true, get() { throw new Error("getter"); } });
    await expect(withDiagnosticScope(evil, async () => 5)).resolves.toBe(5);
  });

  test("push の仕事は欄の数で決まり、余分な欄の数に依らない（時間）", () => {
    const small = { stage: "source_verify", httpStatus: 400 } as DiagCapture;
    const big: Record<string, unknown> = { stage: "source_verify", httpStatus: 400 };
    for (let i = 0; i < 50_000; i += 1) big[`e${i}`] = i;
    const time = (c: DiagCapture): number => {
      const t = performance.now();
      for (let i = 0; i < 500; i += 1) snapshotCapture(c);
      return performance.now() - t;
    };
    time(small);
    time(big as unknown as DiagCapture);
    const a = Math.min(time(small), time(small), time(small));
    const b = Math.min(time(big as unknown as DiagCapture), time(big as unknown as DiagCapture), time(big as unknown as DiagCapture));
    // 列挙すれば 500 × 50,000 回の仕事で桁が違う。読み取りだけなら同じ桁。
    expect(b).toBeLessThan(a * 10 + 5);
  });
});
