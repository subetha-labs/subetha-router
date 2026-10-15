/**
 * 自前の facilitator の診断の記録（設計 `docs/rejection-reasons-design.md` §5・§2.1・§13.1、要件 FR-R6・SR-R1〜R5・AC-R5 の facilitator の部分。タスク R-5）。
 * - RPC の失敗の分類（HTTP 429・LimitExceeded・viem の TimeoutError・締め切り・その他の JSON-RPC の code）が `stage:"rpc"` で残り、`cid` が付く。応答は sink の有無で同じ
 * - verify・settle の応答の記録（status・理由の完全一致の分類）。settle の中の SDK の verify の理由
 * - `cid` は Router の側の `diagCorrelationIdOf` と同じ値（同じ authorization）
 * - sink 無し・記録する sink・投げる sink の 3 つで、応答・journal・chain の呼び出しの列が同じ
 * - 実際のファイルの sink（CLI の `main`）: 鍵・token・生の nonce・journal の key・RPC の URL・例外の文言がファイルに無い。drain で書き出して閉じる
 * chain の I/O・journal・時計は注入の fake（網には出ない。loopback の node:http だけ）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpRequestError, LimitExceededRpcError, RpcRequestError, TimeoutError } from "viem";
import { afterEach, describe, expect, test } from "vitest";

import { diagCorrelationIdOf, DIAG_OPS, NOOP_DIAGNOSTICS, validateDiagRecord, withDiagnosticScope, type DiagnosticsSink, type DiagRecord } from "../../src/shared/diagnostics.js";
import { REASON_TABLE_VERSION } from "../../src/shared/payment-reasons.js";
import {
  classifyRpcError,
  cliConfigOf,
  createEvmFacilitator,
  DeadlineExceeded,
  DEFAULT_MAX_SETTLE_GAS,
  diagCidInputOf,
  main,
  observeRpc,
  type ChainIo,
  type FacilitatorJournal,
  type FacilitatorResponse,
  type Hex,
  type JournalRecord,
  type ReceiptView,
  type SetTimer,
  type VerifyResult,
} from "../../tools/evm-facilitator.js";
import { recordingDiagnostics, throwingDiagnostics, type RecordingDiagnostics } from "../fixtures/diagnostics.js";

const RH = "eip155:46630";
/** 表の資産（大文字小文字の混じった値: cid の正規化を確かめる）。 */
const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
const PAYTO = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
const FROM = "0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1";
const SIGNER = "0x54633d372d7316435891EEBBaAB90861F8c1Dadc";
const TOKEN = "diagTOKENcanary_0123456789abcdefABCDEF";
const DUMMY_KEY = `0x${"5a".repeat(32)}`;
const PORT = 8611;
const NOW_MS = 1_800_000_000_000;
const GWEI = 1_000_000_000n;
/** 生の nonce（大文字小文字の混じった値）。診断のファイルに現れてはならない。 */
const NONCE = `0x${"aB".repeat(8)}${"c0".repeat(8)}${"De".repeat(8)}${"f1".repeat(8)}` as Hex;
const SIGNATURE_BYTE = "7c";
/** 例外の文言・URL に入れる印（診断に出てはならない）。 */
const SECRET_URL = "https://rpc.example/v2/SECRETPATHKEY123?apikey=SECRETQUERY456";
const SECRET_MESSAGE = "SECRETMESSAGE789 upstream said no";

function body(o: { nonce?: Hex; validBefore?: number; amount?: string } = {}): Record<string, unknown> {
  const amount = o.amount ?? "10000";
  const requirements = { scheme: "exact", network: RH, asset: USDG, amount, payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: "Global Dollar", version: "1", assetTransferMethod: "eip3009" } };
  const authorization = { from: FROM, to: PAYTO, value: amount, validAfter: "0", validBefore: String(o.validBefore ?? NOW_MS / 1000 + 60), nonce: o.nonce ?? NONCE };
  return { x402Version: 2, paymentPayload: { x402Version: 2, accepted: requirements, payload: { authorization, signature: `0x${SIGNATURE_BYTE.repeat(65)}` } }, paymentRequirements: requirements };
}

/** Router の側と同じ式（`src/shared/diagnostics.ts`）で作った cid。 */
const EXPECTED_CID = diagCorrelationIdOf(RH, USDG, FROM, NONCE);

/** 振る舞いを差し替えられる fake の chain の I/O（呼び出しの列を残す）。 */
interface FakeChain {
  io: ChainIo;
  calls: string[];
  authorizationState: () => Promise<boolean>;
  verify: () => Promise<VerifyResult>;
  estimate: () => Promise<bigint>;
  fees: () => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  send: () => Promise<Hex>;
  wait: () => Promise<ReceiptView | undefined>;
}

function okReceipt(): ReceiptView {
  const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
  return {
    status: "success",
    blockNumber: 100n,
    gasUsed: 100_000n,
    effectiveGasPrice: GWEI,
    logs: [{ address: USDG, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", topic(FROM), topic(PAYTO)], data: `0x${(10_000n).toString(16).padStart(64, "0")}` }],
  };
}

function fakeChain(): FakeChain {
  const self: FakeChain = {
    calls: [],
    authorizationState: async () => false,
    verify: async () => ({ isValid: true, payer: FROM }),
    estimate: async () => 100_000n,
    fees: async () => ({ maxFeePerGas: GWEI, maxPriorityFeePerGas: 1n }),
    send: async () => `0x${"ee".repeat(32)}` as Hex,
    wait: async () => okReceipt(),
    io: undefined as unknown as ChainIo,
  };
  self.io = {
    maxLogRange: 500n,
    maxFeePerGas: 10n * GWEI,
    gasCap: 10n ** 18n,
    maxSettleGas: DEFAULT_MAX_SETTLE_GAS[RH]!,
    reader: {
      authorizationState: () => (self.calls.push("authorizationState"), self.authorizationState()),
      blockNumber: async () => (self.calls.push("blockNumber"), 100n),
      blockTimestamp: async (n) => (self.calls.push("blockTimestamp"), NOW_MS / 1000 - 100 + Number(n)),
      authorizationUsedLogs: async () => (self.calls.push("getLogs"), []),
      receipt: async () => (self.calls.push("receipt"), undefined),
      waitForReceipt: () => (self.calls.push("waitForReceipt"), self.wait()),
      feesPerGas: () => (self.calls.push("feesPerGas"), self.fees()),
      estimateTransferGas: () => (self.calls.push("estimateGas"), self.estimate()),
    },
    writer: { address: SIGNER, transferWithAuthorization: () => (self.calls.push("write"), self.send()) },
    verify: () => (self.calls.push("sdkVerify"), self.verify()),
  };
  return self;
}

function fakeJournal(): FacilitatorJournal & { records: JournalRecord[] } {
  const j = {
    records: [] as JournalRecord[],
    load: async () => [...j.records],
    append: async (record: JournalRecord) => {
      j.records.push(record);
    },
  };
  return j;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((r) => setImmediate(r));
}

interface Harness {
  chain: FakeChain;
  journal: ReturnType<typeof fakeJournal>;
  settle(b: unknown): Promise<FacilitatorResponse>;
  verify(b: unknown): Promise<FacilitatorResponse>;
  raw(op: string, text: string, contentType?: string): Promise<FacilitatorResponse>;
  advance(ms: number): Promise<void>;
}

async function harness(diagnostics: DiagnosticsSink | undefined, setup: (chain: FakeChain) => void = () => {}): Promise<Harness> {
  const clock = { t: NOW_MS, now(): number { return this.t; } };
  const timers: Array<{ at: number; fn: () => void }> = [];
  const timer: SetTimer = (fn, ms) => {
    const entry = { at: clock.t + ms, fn };
    timers.push(entry);
    return () => {
      const i = timers.indexOf(entry);
      if (i >= 0) timers.splice(i, 1);
    };
  };
  const advance = async (ms: number): Promise<void> => {
    clock.t += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= clock.t).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await flush();
    }
    await flush();
  };
  const chain = fakeChain();
  setup(chain);
  const journal = fakeJournal();
  const f = createEvmFacilitator({ networks: [RH], chains: new Map([[RH, chain.io]]), journal, payToAllowlist: [PAYTO], clock, timer, ...(diagnostics === undefined ? {} : { diagnostics }) });
  await f.start();
  const guard = { token: TOKEN, port: () => PORT };
  const raw = (op: string, text: string, contentType = "application/json") =>
    f.handle({ method: "POST", url: `/${TOKEN}/${op}`, headers: { host: `127.0.0.1:${PORT}`, "content-type": contentType }, body: text }, guard);
  return { chain, journal, settle: (b) => raw("settle", JSON.stringify(b)), verify: (b) => raw("verify", JSON.stringify(b)), raw, advance };
}

/** 記録（検査を通らなかった行は 0 であること）。 */
function recordsOf(sink: RecordingDiagnostics): DiagRecord[] {
  expect(sink.rejected(), "every pushed capture passes validateDiagRecord").toBe(0);
  return sink.records();
}
const strip = (r: DiagRecord): Record<string, unknown> => {
  const { at: _at, seq: _seq, elapsedMs: _e, ...rest } = r as unknown as Record<string, unknown>;
  return rest;
};

const httpError = (status: number) => new HttpRequestError({ url: SECRET_URL, status, body: { method: "eth_call" }, details: SECRET_MESSAGE });
const RPC_FAILURES: ReadonlyArray<readonly [string, () => unknown, Record<string, unknown>]> = [
  ["HTTP 429（HttpRequestError）", () => httpError(429), { rpc: "rate_limited", rpcHttpStatus: 429 }],
  ["LimitExceededRpcError（-32005）", () => new LimitExceededRpcError(new Error(SECRET_MESSAGE)), { rpc: "rate_limited", rpcCode: -32005 }],
  ["viem の TimeoutError", () => new TimeoutError({ body: { method: "eth_call" }, url: SECRET_URL }), { rpc: "timeout" }],
  ["facilitator の DeadlineExceeded", () => new DeadlineExceeded(), { rpc: "timeout", code: "deadline" }],
  ["RpcRequestError（-32000）", () => new RpcRequestError({ body: { method: "eth_call" }, error: { code: -32000, message: SECRET_MESSAGE }, url: SECRET_URL }), { rpc: "other", rpcCode: -32000 }],
  ["ほかの HTTP の失敗（503）", () => httpError(503), { rpc: "other", rpcHttpStatus: 503 }],
  ["code の無い例外", () => new Error(SECRET_MESSAGE), { rpc: "other" }],
];

describe("AC-R5: RPC の失敗の分類（§5.3）", () => {
  test.each(RPC_FAILURES)("settle の authorizationState が %s → rpc の記録（cid・network・分類）と settle の記録。応答は sink 無しと同じ", async (_name, makeError, expected) => {
    const failing = (c: FakeChain) => {
      c.authorizationState = async () => {
        throw makeError();
      };
    };
    const plain = await harness(undefined, failing);
    const before = await plain.settle(body());
    expect(before).toEqual({ status: 502, body: { success: false, errorReason: "rpc_unavailable", network: RH } });
    const sink = recordingDiagnostics("facilitator");
    const h = await harness(sink, failing);
    expect(await h.settle(body())).toEqual(before);
    expect(h.chain.calls).toEqual(plain.chain.calls);
    const records = recordsOf(sink);
    // 同じ例外は 1 回だけ（observeRpc が記録し、呼び出し側の catch は二重に記録しない）。
    const rpc = records.filter((r) => r.stage === "rpc");
    expect(rpc.map(strip)).toEqual([{ v: 1, component: "facilitator", stage: "rpc", cid: EXPECTED_CID, network: RH, op: "authorization_state", ...expected }]);
    const settle = records.filter((r) => r.stage === "settle");
    expect(settle.map(strip)).toEqual([
      { v: 1, component: "facilitator", stage: "settle", cid: EXPECTED_CID, network: RH, httpStatus: 502, response: "success_false", reasonField: "errorReason", reason: "rpc_unavailable", table: REASON_TABLE_VERSION },
    ]);
    expect(typeof settle[0]!.elapsedMs).toBe("number");
    // 記録の順: rpc（失敗の時点）→ settle（応答の後）。
    expect(records.map((r) => r.stage)).toEqual(["rpc", "settle"]);
  });

  test("締め切り（withDeadline）: RPC が返らない → 10 秒で 502、rpc の記録は timeout・code deadline（呼び出し側の catch で初めて見える）", async () => {
    const hang = (c: FakeChain) => {
      c.authorizationState = () => new Promise<boolean>(() => {});
    };
    const run = async (sink: DiagnosticsSink | undefined) => {
      const h = await harness(sink, hang);
      const pending = h.settle(body());
      await flush();
      await h.advance(10_000);
      return await pending;
    };
    const before = await run(undefined);
    expect(before).toEqual({ status: 502, body: { success: false, errorReason: "rpc_unavailable", network: RH } });
    const sink = recordingDiagnostics("facilitator");
    expect(await run(sink)).toEqual(before);
    expect(recordsOf(sink).filter((r) => r.stage === "rpc").map(strip)).toEqual([{ v: 1, component: "facilitator", stage: "rpc", cid: EXPECTED_CID, network: RH, op: "authorization_state", rpc: "timeout", code: "deadline" }]);
  });

  test("送出・receipt・見積り・手数料・SDK の verify の失敗にも rpc の記録（応答は sink 無しと同じ）", async () => {
    const cases: ReadonlyArray<readonly [string, (c: FakeChain) => void, string, Record<string, unknown>]> = [
      ["estimate", (c) => void (c.estimate = async () => Promise.reject(httpError(429))), "estimate_transfer_gas", { rpc: "rate_limited", rpcHttpStatus: 429 }],
      ["fees", (c) => void (c.fees = async () => Promise.reject(new LimitExceededRpcError(new Error("x")))), "fees_per_gas", { rpc: "rate_limited", rpcCode: -32005 }],
      ["send", (c) => void (c.send = async () => Promise.reject(new TimeoutError({ body: {}, url: SECRET_URL }))), "transfer_with_authorization", { rpc: "timeout" }],
      ["receipt", (c) => void (c.wait = async () => Promise.reject(httpError(500))), "wait_for_receipt", { rpc: "other", rpcHttpStatus: 500 }],
      ["sdk verify", (c) => void (c.verify = async () => Promise.reject(new RpcRequestError({ body: {}, error: { code: -32603, message: SECRET_MESSAGE }, url: SECRET_URL }))), "sdk_verify", { rpc: "other", rpcCode: -32603 }],
    ];
    for (const [name, setup, op, expected] of cases) {
      const plain = await harness(undefined, setup);
      const before = await plain.settle(body());
      const sink = recordingDiagnostics("facilitator");
      const h = await harness(sink, setup);
      expect(await h.settle(body()), name).toEqual(before);
      expect(h.journal.records, name).toEqual(plain.journal.records);
      const rpc = recordsOf(sink).filter((r) => r.stage === "rpc").map(strip);
      expect(rpc, name).toEqual([{ v: 1, component: "facilitator", stage: "rpc", cid: EXPECTED_CID, network: RH, op, ...expected }]);
    }
  });

  test("/verify の SDK の verify が投げる → 502 verify_unavailable（今どおり）、rpc の記録 op sdk_verify と verify の記録", async () => {
    const setup = (c: FakeChain) => void (c.verify = async () => Promise.reject(httpError(429)));
    const before = await (await harness(undefined, setup)).verify(body());
    expect(before).toEqual({ status: 502, body: { isValid: false, invalidReason: "verify_unavailable" } });
    const sink = recordingDiagnostics("facilitator");
    expect(await (await harness(sink, setup)).verify(body())).toEqual(before);
    expect(recordsOf(sink).map(strip)).toEqual([
      { v: 1, component: "facilitator", stage: "rpc", cid: EXPECTED_CID, network: RH, op: "sdk_verify", rpc: "rate_limited", rpcHttpStatus: 429 },
      { v: 1, component: "facilitator", stage: "verify", cid: EXPECTED_CID, network: RH, httpStatus: 502, response: "invalid", reasonField: "invalidReason", reason: "verify_unavailable", table: REASON_TABLE_VERSION },
    ]);
  });

  test("classifyRpcError: cause の連鎖を深さ 5 まで辿る（6 段目は見ない）。範囲の外の status・code は写さない", () => {
    const wrap = (inner: unknown, n: number): unknown => {
      let e = inner;
      for (let i = 0; i < n; i += 1) e = new Error("wrapper", { cause: e });
      return e;
    };
    expect(classifyRpcError(wrap(httpError(429), 4))).toEqual({ rpc: "rate_limited", rpcHttpStatus: 429 });
    expect(classifyRpcError(wrap(httpError(429), 5))).toEqual({ rpc: "other" });
    expect(classifyRpcError(wrap(new DeadlineExceeded(), 2))).toEqual({ rpc: "timeout", code: "deadline" });
    expect(classifyRpcError({ code: -32005 })).toEqual({ rpc: "rate_limited", rpcCode: -32005 });
    expect(classifyRpcError({ code: 2 ** 40 })).toEqual({ rpc: "other" });
    expect(classifyRpcError({ code: "ECONNRESET" })).toEqual({ rpc: "other" });
    expect(classifyRpcError(new HttpRequestError({ url: SECRET_URL, status: 999 }))).toEqual({ rpc: "other" });
    expect(classifyRpcError(undefined)).toEqual({ rpc: "other" });
    expect(classifyRpcError("string")).toEqual({ rpc: "other" });
    // 循環する cause でも止まる。
    const loop = new Error("loop") as Error & { cause?: unknown };
    loop.cause = loop;
    expect(classifyRpcError(loop)).toEqual({ rpc: "other" });
  });

  test("classifyRpcError は文言（message・details・shortMessage・metaMessages）を読まない", () => {
    const read: string[] = [];
    const spy = (base: object): object =>
      new Proxy(base, {
        get(target, key, receiver) {
          if (typeof key === "string") read.push(key);
          return Reflect.get(target, key, receiver);
        },
      });
    for (const e of [httpError(429), httpError(503), new RpcRequestError({ body: {}, error: { code: -32000, message: SECRET_MESSAGE }, url: SECRET_URL }), new Error(SECRET_MESSAGE), new TimeoutError({ body: {}, url: SECRET_URL })]) {
      classifyRpcError(spy(new Error("outer", { cause: spy(e) })));
    }
    expect(read.length).toBeGreaterThan(0);
    for (const forbidden of ["message", "details", "shortMessage", "metaMessages", "url", "body", "stack", "toString"]) expect(read, forbidden).not.toContain(forbidden);
  });

  test("observeRpc は同じ promise（同じ値・同じ例外）を返す。同期の throw は記録して同じ例外を投げ直す。NOOP なら包まない", async () => {
    const sink = recordingDiagnostics("facilitator");
    const error = httpError(429);
    const failing = Promise.reject(error);
    const returned = observeRpc(sink, RH, "block_number", () => failing);
    expect(returned).toBe(failing);
    await expect(returned).rejects.toBe(error);
    const ok = Promise.resolve(7n);
    expect(observeRpc(sink, RH, "block_number", () => ok)).toBe(ok);
    const sync = new Error("sync");
    expect(() =>
      observeRpc(sink, RH, "receipt", () => {
        throw sync;
      }),
    ).toThrow(sync);
    const direct = Promise.resolve(1);
    expect(observeRpc(NOOP_DIAGNOSTICS, RH, "receipt", () => direct)).toBe(direct);
    await flush();
    // scope の外の記録は cid なし（起動時の照合と同じ）。
    expect(recordsOf(sink).map(strip)).toEqual([
      { v: 1, component: "facilitator", stage: "rpc", network: RH, op: "block_number", rpc: "rate_limited", rpcHttpStatus: 429 },
      { v: 1, component: "facilitator", stage: "rpc", network: RH, op: "receipt", rpc: "other" },
    ]);
  });

  test("observeRpc の記録は呼び出しの時点の scope の cid（後で失敗しても）", async () => {
    const sink = recordingDiagnostics("facilitator");
    let rejectLater: (e: unknown) => void = () => {};
    const pending = new Promise<bigint>((_, reject) => (rejectLater = reject));
    await withDiagnosticScope({ cidInput: { network: RH, asset: USDG, from: FROM, nonce: NONCE } }, async () => {
      void observeRpc(sink, RH, "block_number", () => pending).catch(() => {});
    });
    rejectLater(httpError(429));
    await flush();
    expect(recordsOf(sink).map((r) => r.cid)).toEqual([EXPECTED_CID]);
  });

  test("rpc の記録の op は DIAG_OPS の集合にある（ソースの literal）", () => {
    const text = readFileSync(path.resolve(import.meta.dirname, "../../tools/evm-facilitator.ts"), "utf8");
    const ops = new Set([...text.matchAll(/(?:observeRpc\([^,]+, [^,]+|noteRpcFailure\([^,]+, [^,]+), "([a-z_]+)"/g)].map((m) => m[1]!));
    expect(ops.size).toBe(14);
    for (const op of ops) expect((DIAG_OPS as readonly string[]).includes(op), op).toBe(true);
  });
});

describe("FR-R6: verify の理由・settle の応答の記録", () => {
  test("/verify: SDK の invalidReason は表で完全一致（表の値・表に無い値・欄なし）", async () => {
    const cases: ReadonlyArray<readonly [VerifyResult, string]> = [
      [{ isValid: false, invalidReason: "invalid_exact_evm_scheme" }, "invalid_exact_evm_scheme"],
      [{ isValid: false, invalidReason: "Invalid_Exact_Evm_Scheme" }, "unrecognized"],
      [{ isValid: false, invalidReason: `${SECRET_MESSAGE} free text` }, "unrecognized"],
      [{ isValid: false }, "absent"],
    ];
    for (const [result, reason] of cases) {
      const sink = recordingDiagnostics("facilitator");
      const h = await harness(sink, (c) => void (c.verify = async () => result));
      const response = await h.verify(body());
      expect(response.status).toBe(200);
      const records = recordsOf(sink).map(strip);
      expect(records, reason).toEqual([
        { v: 1, component: "facilitator", stage: "verify", cid: EXPECTED_CID, network: RH, httpStatus: 200, response: "invalid", reasonField: "invalidReason", reason, table: REASON_TABLE_VERSION },
      ]);
    }
    const sink = recordingDiagnostics("facilitator");
    await (await harness(sink)).verify(body());
    expect(recordsOf(sink).map(strip)).toEqual([{ v: 1, component: "facilitator", stage: "verify", cid: EXPECTED_CID, network: RH, httpStatus: 200, response: "valid" }]);
  });

  test("settle の中の SDK の verify: 応答は今どおり 400 invalid_payment、SDK の理由を stage verify で残す", async () => {
    const setup = (c: FakeChain) => void (c.verify = async () => ({ isValid: false, invalidReason: "invalid_exact_evm_scheme" }));
    const before = await (await harness(undefined, setup)).settle(body());
    expect(before).toEqual({ status: 400, body: { success: false, errorReason: "invalid_payment", network: RH } });
    const sink = recordingDiagnostics("facilitator");
    expect(await (await harness(sink, setup)).settle(body())).toEqual(before);
    expect(recordsOf(sink).map(strip)).toEqual([
      { v: 1, component: "facilitator", stage: "verify", cid: EXPECTED_CID, network: RH, response: "invalid", reasonField: "invalidReason", reason: "invalid_exact_evm_scheme", table: REASON_TABLE_VERSION },
      { v: 1, component: "facilitator", stage: "settle", cid: EXPECTED_CID, network: RH, httpStatus: 400, response: "success_false", reasonField: "errorReason", reason: "invalid_payment", table: REASON_TABLE_VERSION },
    ]);
  });

  test("前段・識別の拒否・本文を読む前の拒否も 1 行（形の外の本文は cid なし）", async () => {
    const sink = recordingDiagnostics("facilitator");
    const h = await harness(sink);
    await h.settle(body({ amount: "20001" }));
    await h.raw("settle", "{not json");
    await h.raw("verify", "{}", "text/plain");
    await h.settle({ x402Version: 2, paymentPayload: { x402Version: 2 }, paymentRequirements: { network: RH, asset: USDG } });
    expect(recordsOf(sink).map(strip)).toEqual([
      { v: 1, component: "facilitator", stage: "settle", cid: EXPECTED_CID, network: RH, httpStatus: 400, response: "success_false", reasonField: "errorReason", reason: "amount_out_of_range", table: REASON_TABLE_VERSION },
      { v: 1, component: "facilitator", stage: "settle", httpStatus: 400, response: "success_false", reasonField: "errorReason", reason: "malformed_request", table: REASON_TABLE_VERSION },
      { v: 1, component: "facilitator", stage: "verify", httpStatus: 415, reasonField: "error", reason: "unsupported_media_type", table: REASON_TABLE_VERSION },
      { v: 1, component: "facilitator", stage: "settle", network: RH, httpStatus: 400, response: "success_false", reasonField: "errorReason", reason: "malformed_payload", table: REASON_TABLE_VERSION },
    ]);
  });

  test("成功の settle: rpc の記録なし、settle の記録 200 ok（理由の欄なし）", async () => {
    const sink = recordingDiagnostics("facilitator");
    const h = await harness(sink);
    const response = await h.settle(body());
    expect(response.status).toBe(200);
    expect(recordsOf(sink).map(strip)).toEqual([{ v: 1, component: "facilitator", stage: "settle", cid: EXPECTED_CID, network: RH, httpStatus: 200, response: "ok" }]);
  });
});

describe("cid（§5.2）", () => {
  test("diagCidInputOf は形どおりの本文だけ。cid は Router の側の diagCorrelationIdOf と同じ値・journal の key の hash と同じ値", async () => {
    expect(diagCidInputOf(body())).toEqual({ network: RH, asset: USDG, from: FROM, nonce: NONCE });
    for (const bad of [null, [], {}, { paymentPayload: {}, paymentRequirements: {} }, body({ nonce: "0x12" as Hex }), { ...body(), paymentRequirements: { network: "x".repeat(100), asset: USDG } }]) {
      expect(diagCidInputOf(bad)).toBeUndefined();
    }
    const sink = recordingDiagnostics("facilitator");
    const h = await harness(sink);
    await h.settle(body());
    const intent = h.journal.records.find((r) => r.type === "submit_intent") as { key: string } | undefined;
    const { createHash } = await import("node:crypto");
    const fromKey = createHash("sha256").update(`subetha-diag-cid/v1|${intent!.key}`, "utf8").digest("hex").slice(0, 16);
    expect(recordsOf(sink)[0]!.cid).toBe(fromKey);
    expect(fromKey).toBe(EXPECTED_CID);
    // Router の側の値（小文字にした入力でも同じ）。
    expect(diagCorrelationIdOf(RH, USDG.toLowerCase(), FROM.toLowerCase(), NONCE.toLowerCase())).toBe(EXPECTED_CID);
  });
});

describe("SR-R3: sink 無し・記録する sink・投げる sink で応答・journal・chain の呼び出しが同じ", () => {
  const scenarios: ReadonlyArray<readonly [string, (c: FakeChain) => void, (h: Harness) => Promise<FacilitatorResponse[]>]> = [
    ["成功と同じ要求の繰り返し", () => {}, async (h) => [await h.settle(body()), await h.settle(body()), await h.verify(body({ nonce: `0x${"01".repeat(32)}` as Hex }))]],
    ["RPC の 429", (c) => void (c.authorizationState = async () => Promise.reject(httpError(429))), async (h) => [await h.settle(body()), await h.verify(body())]],
    ["SDK の無効", (c) => void (c.verify = async () => ({ isValid: false, invalidReason: "invalid_exact_evm_scheme" })), async (h) => [await h.settle(body()), await h.verify(body())]],
    ["送出の失敗（network の保留）", (c) => void (c.send = async () => Promise.reject(httpError(503))), async (h) => [await h.settle(body()), await h.settle(body({ nonce: `0x${"02".repeat(32)}` as Hex }))]],
    ["receipt の期限切れ", (c) => void (c.wait = async () => undefined), async (h) => [await h.settle(body())]],
    ["形の外・前段", () => {}, async (h) => [await h.raw("settle", "{"), await h.settle(body({ amount: "0" })), await h.raw("verify", "{}", "text/plain")]],
    [
      "締め切り",
      (c) => void (c.authorizationState = () => new Promise<boolean>(() => {})),
      async (h) => {
        const pending = h.settle(body());
        await flush();
        await h.advance(10_000);
        return [await pending];
      },
    ],
  ];
  test.each(scenarios)("%s", async (_name, setup, run) => {
    const outcomes = [];
    const throwing = throwingDiagnostics();
    for (const sink of [undefined, recordingDiagnostics("facilitator"), throwing]) {
      const h = await harness(sink, setup);
      const responses = await run(h);
      outcomes.push({ responses, journal: h.journal.records, calls: h.chain.calls });
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[2]).toEqual(outcomes[0]);
    expect(throwing.calls).toBeGreaterThan(0);
  });
});

describe("CLI（main）: EVM_FACILITATOR_DIAGNOSTICS のファイルの sink（§2.1）", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("cliConfigOf は EVM_FACILITATOR_DIAGNOSTICS を読む（空・無しは記録しない）", () => {
    const base = { EVM_FACILITATOR_KEY: DUMMY_KEY, EVM_FACILITATOR_TOKEN: TOKEN, EVM_FACILITATOR_NETWORKS: RH, EVM_FACILITATOR_PAYTO_ALLOWLIST: PAYTO, EVM_FACILITATOR_GAS_CAP_46630: "1000", EVM_FACILITATOR_JOURNAL: "/x/j.ndjson" };
    expect(cliConfigOf({ ...base, EVM_FACILITATOR_DIAGNOSTICS: "/x/diagnostics.ndjson" }).diagnostics).toBe("/x/diagnostics.ndjson");
    expect(cliConfigOf({ ...base, EVM_FACILITATOR_DIAGNOSTICS: "" }).diagnostics).toBeUndefined();
    expect("diagnostics" in cliConfigOf(base)).toBe(false);
  });

  function post(port: number, op: string, payload: unknown): Promise<{ status: number; body: unknown }> {
    const text = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: `/${TOKEN}/${op}`, method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", "content-length": Buffer.byteLength(text) } },
        (res) => {
          let data = "";
          res.on("data", (d: Buffer) => (data += d.toString("utf8")));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
        },
      );
      req.on("error", reject);
      req.end(text);
    });
  }

  test("実際のファイル: 記録が drain で書き出され、鍵・token・生の nonce・from・署名・journal の key・RPC の URL・例外の文言が無い。journal・log とは別のファイル", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "evm-fac-diag-"));
    const diagnosticsFile = path.join(dir, "evm-facilitator", "diagnostics.ndjson");
    const journalFile = path.join(dir, "evm-facilitator", "journal.ndjson");
    const nowS = Math.floor(Date.now() / 1000);
    let n = 0;
    const chainIoOf = async (): Promise<ChainIo> => {
      const c = fakeChain();
      // 1 回目の settle は 429、2 回目は成功（同じ authorization）。verify は SDK の無効。
      c.authorizationState = async () => {
        n += 1;
        if (n === 1) throw httpError(429);
        return false;
      };
      c.verify = async () => ({ isValid: false, invalidReason: "invalid_exact_evm_scheme" });
      return c.io;
    };
    const port = 41_000 + Math.floor(Math.random() * 2_000);
    const running = await main(
      {
        EVM_FACILITATOR_KEY: DUMMY_KEY,
        EVM_FACILITATOR_TOKEN: TOKEN,
        EVM_FACILITATOR_NETWORKS: RH,
        EVM_FACILITATOR_PAYTO_ALLOWLIST: PAYTO,
        EVM_FACILITATOR_GAS_CAP_46630: (10n ** 18n).toString(),
        EVM_FACILITATOR_JOURNAL: journalFile,
        EVM_FACILITATOR_LOG: path.join(dir, "log.ndjson"),
        EVM_FACILITATOR_PORT: String(port),
        EVM_FACILITATOR_DIAGNOSTICS: diagnosticsFile,
      },
      { stdout: () => {}, stderr: () => {} },
      { chainIoOf },
    );
    const payload = body({ validBefore: nowS + 120 });
    const first = await post(running.port, "settle", payload);
    expect(first).toEqual({ status: 502, body: { success: false, errorReason: "rpc_unavailable", network: RH } });
    const second = await post(running.port, "settle", payload);
    expect(second.status).toBe(400);
    expect(await running.drain(5_000)).toBe(true);
    const text = readFileSync(diagnosticsFile, "utf8");
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const line of lines) expect(validateDiagRecord(line), JSON.stringify(line)).toEqual(line);
    const cid = diagCorrelationIdOf(RH, USDG, FROM, NONCE);
    expect(lines.filter((l) => l["component"] === "facilitator").map((l) => [l["stage"], l["op"] ?? l["reason"], l["cid"]])).toEqual([
      ["rpc", "authorization_state", cid],
      ["settle", "rpc_unavailable", cid],
      ["verify", "invalid_exact_evm_scheme", cid],
      ["settle", "invalid_payment", cid],
    ]);
    expect(lines.find((l) => l["stage"] === "rpc")).toMatchObject({ rpc: "rate_limited", rpcHttpStatus: 429, network: RH });
    const journalKey = readFileSync(journalFile, "utf8");
    const canaries = [
      TOKEN,
      DUMMY_KEY.slice(2),
      "5a5a5a",
      NONCE,
      NONCE.slice(2).toLowerCase(),
      NONCE.slice(2),
      FROM.slice(2).toLowerCase(),
      FROM.slice(2),
      SIGNATURE_BYTE.repeat(8),
      `${RH}|${USDG.toLowerCase()}`,
      "SECRETPATHKEY123",
      "SECRETQUERY456",
      "SECRETMESSAGE789",
      "rpc.example",
    ];
    for (const canary of canaries) expect(text, canary).not.toContain(canary);
    // journal・log は今どおり（journal は診断のファイルと別。log は既存の key を含む: §10 Q-D）。
    expect(journalKey).toContain("gas_cap_init");
    expect(path.dirname(diagnosticsFile)).toBe(path.dirname(journalFile));
  }, 30_000);

  test("env が無ければファイルを作らない", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "evm-fac-diag-"));
    const journalFile = path.join(dir, "evm-facilitator", "journal.ndjson");
    const port = 43_100 + Math.floor(Math.random() * 1_000);
    const running = await main(
      { EVM_FACILITATOR_KEY: DUMMY_KEY, EVM_FACILITATOR_TOKEN: TOKEN, EVM_FACILITATOR_NETWORKS: RH, EVM_FACILITATOR_PAYTO_ALLOWLIST: PAYTO, EVM_FACILITATOR_GAS_CAP_46630: "1000000", EVM_FACILITATOR_JOURNAL: journalFile, EVM_FACILITATOR_PORT: String(port), EVM_FACILITATOR_LOG: path.join(dir, "log.ndjson") },
      { stdout: () => {}, stderr: () => {} },
      { chainIoOf: async () => fakeChain().io },
    );
    await post(running.port, "settle", body({ validBefore: Math.floor(Date.now() / 1000) + 120 }));
    expect(await running.drain(5_000)).toBe(true);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(path.dirname(journalFile)).sort()).toEqual(["facilitator.lock", "journal.ndjson"]);
  });
});
