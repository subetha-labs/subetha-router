/**
 * 自前の EVM facilitator（`tools/evm-facilitator.ts`。設計 `docs/evm-testnets-x402-design.md` §3.3、AC-E3）。
 * chain の I/O・journal・時計は注入の fake で、網には出ない（loopback の node:http だけ 1 つ）。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toEventSelector } from "viem";
import { afterEach, describe, expect, test } from "vitest";

import {
  acquireFacilitatorLock,
  AUTHORIZATION_USED_TOPIC,
  cliConfigOf,
  createEvmFacilitator,
  facilitatorLockPathOf,
  LOCKED_MESSAGE,
  main,
  MAX_REASON_LENGTH,
  OLD_FORMAT_MESSAGE,
  RAISE_CAP_USAGE,
  runRaiseCap,
  StartupError,
  createFileJournal,
  listenFacilitator,
  parseJournalLine,
  runCli,
  drainStopperOf,
  TRANSFER_TOPIC,
  type JournalFs,
  type SetTimer,
  type AuthorizationUsedLog,
  type ChainIo,
  DEFAULT_MAX_SETTLE_GAS,
  type TransferAuthorizationCall,
  type EvmFacilitator,
  type FacilitatorJournal,
  type FacilitatorResponse,
  type Hex,
  type JournalRecord,
  type ReceiptView,
  type TransferWithAuthorizationArgs,
  type VerifyResult,
} from "../../tools/evm-facilitator.js";

const RH = "eip155:46630";
const SEPOLIA = "eip155:11155111";
const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const PAYTO = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
const OTHER = "0x00000000000000000000000000000000000000aa";
const FROM = "0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1";
const SIGNER = "0x54633d372d7316435891EEBBaAB90861F8c1Dadc";
const TOKEN = "t".repeat(40);
const PORT = 8611;
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
/** block n の時刻 = BASE_TS + n（1 秒の block）。最新は LATEST。 */
const LATEST = 100_000n;
const BASE_TS = NOW_S - Number(LATEST);
const GWEI = 1_000_000_000n;

function nonceOf(i: number): Hex {
  return `0x${i.toString(16).padStart(64, "0")}`;
}
function hashOf(i: number): Hex {
  return `0x${(0xabc000 + i).toString(16).padStart(64, "0")}`;
}
function topicOf(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}
function transferLog(asset: string, from: string, to: string, value: bigint): { address: string; topics: string[]; data: string } {
  return { address: asset, topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)], data: `0x${value.toString(16).padStart(64, "0")}` };
}
function okReceipt(asset: string, to = PAYTO, value = 10_000n, blockNumber = LATEST): ReceiptView {
  return { status: "success", blockNumber, gasUsed: 100_000n, effectiveGasPrice: GWEI, logs: [transferLog(asset, FROM, to, value)] };
}

interface BuildOptions {
  readonly network?: string;
  readonly nonce?: Hex;
  readonly validBefore?: number;
  readonly signatureByte?: string;
  readonly requirements?: (r: Record<string, unknown>) => Record<string, unknown>;
  readonly payload?: (p: Record<string, unknown>) => Record<string, unknown>;
  readonly authorization?: (a: Record<string, unknown>) => Record<string, unknown>;
}

function body(o: BuildOptions = {}): Record<string, unknown> {
  const network = o.network ?? RH;
  const asset = network === SEPOLIA ? SEPOLIA_USDC : USDG;
  const domain = network === SEPOLIA ? { name: "USDC", version: "2" } : { name: "Global Dollar", version: "1" };
  let requirements: Record<string, unknown> = { scheme: "exact", network, asset, amount: "10000", payTo: PAYTO, maxTimeoutSeconds: 60, extra: { ...domain, assetTransferMethod: "eip3009" } };
  if (o.requirements !== undefined) requirements = o.requirements(requirements);
  let authorization: Record<string, unknown> = { from: FROM, to: PAYTO, value: "10000", validAfter: "0", validBefore: String(o.validBefore ?? NOW_S + 60), nonce: o.nonce ?? nonceOf(1) };
  if (o.authorization !== undefined) authorization = o.authorization(authorization);
  let paymentPayload: Record<string, unknown> = { x402Version: 2, accepted: requirements, payload: { authorization, signature: `0x${(o.signatureByte ?? "11").repeat(65)}` } };
  if (o.payload !== undefined) paymentPayload = o.payload(paymentPayload);
  return { x402Version: 2, paymentPayload, paymentRequirements: requirements };
}

interface FakeChain {
  io: ChainIo;
  used: Set<string>;
  usedLogs: Map<string, AuthorizationUsedLog[]>;
  receipts: Map<string, ReceiptView>;
  calls: string[];
  writes: TransferWithAuthorizationArgs[];
  logRanges: Array<[bigint, bigint]>;
  /** 送出の結果（既定は成功の hash）。 */
  send: (args: TransferWithAuthorizationArgs, n: number) => Promise<Hex>;
  /** receipt の待ち（既定は `receipts` から）。 */
  wait: (hash: Hex) => Promise<ReceiptView | undefined>;
  verify: (n: number) => Promise<VerifyResult>;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  /** gas の見積り（既定 100,000）。 */
  estimate: (call: TransferAuthorizationCall) => Promise<bigint>;
  estimates: TransferAuthorizationCall[];
}

function fakeChain(asset: string, gasCap = 10n ** 18n): FakeChain {
  const self: FakeChain = {
    used: new Set(),
    usedLogs: new Map(),
    receipts: new Map(),
    calls: [],
    writes: [],
    logRanges: [],
    send: async (_args, n) => hashOf(n),
    wait: async (hash) => self.receipts.get(hash) ?? okReceipt(asset),
    verify: async () => ({ isValid: true, payer: FROM }),
    fees: { maxFeePerGas: GWEI, maxPriorityFeePerGas: 1n },
    estimate: async () => 100_000n,
    estimates: [],
    io: undefined as unknown as ChainIo,
  };
  const keyOf = (from: string, nonce: string) => `${from.toLowerCase()}|${nonce.toLowerCase()}`;
  self.io = {
    maxLogRange: 500n,
    maxFeePerGas: 10n * GWEI,
    gasCap,
    maxSettleGas: asset === SEPOLIA_USDC ? DEFAULT_MAX_SETTLE_GAS[SEPOLIA]! : DEFAULT_MAX_SETTLE_GAS[RH]!,
    reader: {
      async authorizationState(_asset, from, nonce) {
        self.calls.push("authorizationState");
        return self.used.has(keyOf(from, nonce));
      },
      async blockNumber() {
        self.calls.push("blockNumber");
        return LATEST;
      },
      async blockTimestamp(n) {
        self.calls.push("blockTimestamp");
        return BASE_TS + Number(n);
      },
      async authorizationUsedLogs(_asset, from, nonce, fromBlock, toBlock) {
        self.calls.push("getLogs");
        self.logRanges.push([fromBlock, toBlock]);
        return (self.usedLogs.get(keyOf(from, nonce)) ?? []).filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      },
      async receipt(hash) {
        self.calls.push("receipt");
        return self.receipts.get(hash);
      },
      async waitForReceipt(hash) {
        self.calls.push("waitForReceipt");
        return await self.wait(hash);
      },
      async feesPerGas() {
        self.calls.push("feesPerGas");
        return self.fees;
      },
      async estimateTransferGas(call) {
        self.calls.push("estimateGas");
        self.estimates.push(call);
        return await self.estimate(call);
      },
    },
    writer: {
      address: SIGNER,
      async transferWithAuthorization(args) {
        self.calls.push("write");
        self.writes.push(args);
        return await self.send(args, self.writes.length);
      },
    },
    verify: async () => {
      self.calls.push("sdkVerify");
      return await self.verify(self.calls.filter((c) => c === "sdkVerify").length);
    },
  };
  return self;
}

interface FakeJournal extends FacilitatorJournal {
  records: JournalRecord[];
  /** append の前に呼ぶ（遅い fsync の模擬・失敗）。 */
  before?: (record: JournalRecord) => Promise<void> | void;
}

function fakeJournal(initial: JournalRecord[] = [], events?: string[]): FakeJournal {
  const j: FakeJournal = {
    records: [...initial],
    async load() {
      return [...j.records];
    },
    async append(record) {
      if (j.before !== undefined) await j.before(record);
      j.records.push(record);
      events?.push(`journal:${record.type}`);
    },
  };
  return j;
}

interface Harness {
  f: EvmFacilitator;
  rh: FakeChain;
  sepolia: FakeChain;
  journal: FakeJournal;
  clock: { t: number; now(): number };
  /** 偽の時計を進め、期限の来た timer を発火する。 */
  advance(ms: number): Promise<void>;
  settle(b: unknown, headers?: Record<string, string>): Promise<FacilitatorResponse>;
  verify(b: unknown): Promise<FacilitatorResponse>;
}

async function harness(opts: { journal?: FakeJournal; rh?: FakeChain; sepolia?: FakeChain; start?: boolean } = {}): Promise<Harness> {
  const clock = { t: NOW_MS, now(): number { return this.t; } };
  // 偽の timer: 時計が `at` を過ぎたときだけ発火する（実時間では発火しない）。
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
  const rh = opts.rh ?? fakeChain(USDG);
  const sepolia = opts.sepolia ?? fakeChain(SEPOLIA_USDC);
  const journal = opts.journal ?? fakeJournal();
  const f = createEvmFacilitator({
    networks: [RH, SEPOLIA],
    chains: new Map([
      [RH, rh.io],
      [SEPOLIA, sepolia.io],
    ]),
    journal,
    payToAllowlist: [PAYTO],
    clock,
    timer,
  });
  if (opts.start !== false) await f.start();
  const guard = { token: TOKEN, port: () => PORT };
  const call = (op: string, b: unknown, headers: Record<string, string> = {}) =>
    f.handle({ method: "POST", url: `/${TOKEN}/${op}`, headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json", ...headers }, body: JSON.stringify(b) }, guard);
  return { f, rh, sepolia, journal, clock, advance, settle: (b, h) => call("settle", b, h), verify: (b) => call("verify", b) };
}

/** 支払いの記録だけ（起動が書く `gas_cap_init`・運用者の `gas_cap_raise` を除く）。 */
function payments(j: { records: readonly JournalRecord[] }): JournalRecord[] {
  return j.records.filter((r) => r.type !== "gas_cap_init" && r.type !== "gas_cap_raise");
}
function paymentTypes(j: { records: readonly JournalRecord[] }): string[] {
  return payments(j).map((r) => r.type);
}

/** 保留中の promise の続きを走らせる。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((r) => setImmediate(r));
}

function keyOf(network: string, asset: string, nonce: Hex): string {
  return [network, asset.toLowerCase(), FROM.toLowerCase(), nonce.toLowerCase()].join("|");
}

/** 前段の検査で落ちる要求（どれも SDK・送出に届かない）。 */
const PRECHECK_CASES: ReadonlyArray<readonly [string, BuildOptions]> = [
  ["scheme が exact でない", { requirements: (r) => ({ ...r, scheme: "upto" }) }],
  ["EIP-712 domain の name が表と違う", { requirements: (r) => ({ ...r, extra: { name: "USDG", version: "1" } }) }],
  ["domain の version が表と違う", { requirements: (r) => ({ ...r, extra: { name: "Global Dollar", version: "2" } }) }],
  ["extra に未知の鍵", { requirements: (r) => ({ ...r, extra: { ...(r["extra"] as object), feePayer: "x" } }) }],
  ["assetTransferMethod が permit2", { requirements: (r) => ({ ...r, extra: { name: "Global Dollar", version: "1", assetTransferMethod: "permit2" } }) }],
  ["paymentPayload.extensions", { payload: (p) => ({ ...p, extensions: { eip2612GasSponsoring: {} } }) }],
  ["payload に Permit2 の鍵", { payload: (p) => ({ ...p, payload: { ...(p["payload"] as object), permit2Authorization: {} } }) }],
  ["EIP-6492 の包み（65 バイトでない署名）", { signatureByte: "22".repeat(2) }],
  ["金額 0", { requirements: (r) => ({ ...r, amount: "0" }), authorization: (a) => ({ ...a, value: "0" }) }],
  ["金額が上限超え", { requirements: (r) => ({ ...r, amount: "20001" }), authorization: (a) => ({ ...a, value: "20001" }) }],
  ["金額が正規形でない", { requirements: (r) => ({ ...r, amount: "010000" }) }],
  ["value が amount と違う", { authorization: (a) => ({ ...a, value: "9999" }) }],
  ["authorization.to が payTo と違う", { authorization: (a) => ({ ...a, to: OTHER }) }],
  ["payTo が allowlist の外", { requirements: (r) => ({ ...r, payTo: OTHER }), authorization: (a) => ({ ...a, to: OTHER }) }],
  ["accepted が requirements と違う", { payload: (p) => ({ ...p, accepted: { ...(p["accepted"] as object), maxTimeoutSeconds: 61 } }) }],
  ["validBefore が近すぎる", { validBefore: NOW_S + 5 }],
  ["challengeNonce が extra と違う", { payload: (p) => ({ ...p, payload: { ...(p["payload"] as object), challengeNonce: nonceOf(9) } }) }],
];

/** 手順 1 で落ちる要求（どの authorization か特定できない）。 */
const SHAPE_CASES: ReadonlyArray<readonly [string, unknown]> = [
  ["x402Version が 1", { ...body(), x402Version: 1 }],
  ["network が有効でない", body({ requirements: (r) => ({ ...r, network: "eip155:84532" }) })],
  ["資産が表に無い", body({ requirements: (r) => ({ ...r, asset: OTHER }) })],
  ["authorization の欄が足りない", body({ authorization: (a) => ({ from: a["from"], to: a["to"], value: a["value"], nonce: a["nonce"] }) })],
  ["nonce が bytes32 でない", body({ authorization: (a) => ({ ...a, nonce: "0x12" }) })],
  ["value が文字列の数でない", body({ authorization: (a) => ({ ...a, value: 10000 }) })],
];

describe("前段の検査（AC-E3: 拒否は SDK・RPC を呼ばない）", () => {
  test.each(PRECHECK_CASES)("/verify: %s → 400、SDK・RPC は 0 回", async (_name, o) => {
    const h = await harness();
    const res = await h.verify(body(o));
    expect(res.status).toBe(400);
    expect((res.body as { isValid: boolean }).isValid).toBe(false);
    expect(h.rh.calls).toEqual([]);
  });

  test.each(PRECHECK_CASES)("/settle: %s → 400、SDK・送出は無く、RPC は使用済みの確認（手順 4）だけ", async (_name, o) => {
    const h = await harness();
    const res = await h.settle(body(o));
    expect(res.status).toBe(400);
    // 設計 §3.3: 使用済みの照合（手順 4）は束縛・時間の検査（手順 5）より前。
    expect(h.rh.calls).toEqual(["authorizationState"]);
    expect(payments(h.journal)).toEqual([]);
  });

  test.each(SHAPE_CASES)("手順 1: %s → 400、RPC も 0 回（verify・settle とも）", async (_name, b) => {
    const h = await harness();
    expect((await h.settle(b)).status).toBe(400);
    expect((await h.verify(b)).status).toBe(400);
    expect(h.rh.calls).toEqual([]);
    expect(h.sepolia.calls).toEqual([]);
  });

  test("/verify: 前段を通れば SDK の判定（invalidMessage は返さない）", async () => {
    const h = await harness();
    h.rh.verify = async () => ({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature", invalidMessage: "raw rpc text" } as VerifyResult);
    const res = await h.verify(body());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature", payer: FROM });
    expect(h.rh.calls).toEqual(["sdkVerify"]);
  });

  test("Router の封筒（payload.challengeNonce が extra と一致・scheme/network を補う）は通る", async () => {
    const h = await harness();
    const b = body({
      requirements: (r) => ({ ...r, extra: { name: "Global Dollar", version: "1", challengeNonce: nonceOf(7), expiresAt: NOW_S + 600, routeBinding: "rb", fundsMoveOnCredential: false } }),
      payload: (p) => ({ ...p, scheme: "exact", network: RH, payload: { ...(p["payload"] as object), challengeNonce: nonceOf(7) } }),
    });
    expect((await h.verify(b)).body).toEqual({ isValid: true, payer: FROM });
  });
});

describe("認証・Origin・Host（SR-E3）", () => {
  const guard = { token: TOKEN, port: () => PORT };
  const cases: ReadonlyArray<readonly [string, string, Record<string, string>, number]> = [
    ["token 無し", "/settle", {}, 404],
    ["token 違い", `/${"u".repeat(40)}/settle`, {}, 404],
    ["余分な段", `/${TOKEN}/settle/x`, {}, 404],
    ["query つき", `/${TOKEN}/settle?x=1`, {}, 404],
    ["Origin つき", `/${TOKEN}/settle`, { origin: "http://127.0.0.1:8611" }, 403],
    ["Host が localhost", `/${TOKEN}/settle`, { host: `localhost:${PORT}` }, 403],
    ["Host の port 違い", `/${TOKEN}/settle`, { host: "127.0.0.1:8612" }, 403],
    ["content-type が JSON でない", `/${TOKEN}/settle`, { "content-type": "text/plain" }, 415],
  ];
  test.each(cases)("%s → %i、chain に触れない", async (_name, url, headers, status) => {
    const h = await harness();
    const res = await h.f.handle({ method: "POST", url, headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body()) }, guard);
    expect(res.status).toBe(status);
    expect(h.rh.calls).toEqual([]);
  });

  test("本文 64 KiB 超えは 413", async () => {
    const h = await harness();
    const res = await h.f.handle({ method: "POST", url: `/${TOKEN}/verify`, headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" }, body: `"${"x".repeat(64 * 1024)}"` }, guard);
    expect(res.status).toBe(413);
  });

  test("/supported は有効な network と signer", async () => {
    const h = await harness();
    const res = await h.f.handle({ method: "GET", url: `/${TOKEN}/supported`, headers: { host: `127.0.0.1:${PORT}` }, body: "" }, guard);
    expect(res).toEqual({
      status: 200,
      body: { kinds: [{ x402Version: 2, scheme: "exact", network: RH }, { x402Version: 2, scheme: "exact", network: SEPOLIA }], extensions: [], signers: { "eip155:*": [SIGNER] } },
    });
  });

  test("実際の node:http: 127.0.0.1 に bind し、Host 違い・Origin を拒み、正しい要求に答える", async () => {
    const h = await harness();
    const { server, port } = await listenFacilitator(h.f, TOKEN, 0);
    try {
      expect(server.address()).toMatchObject({ address: "127.0.0.1" });
      const get = (headers: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port, path: `/${TOKEN}/supported`, method: "GET", headers }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end();
        });
      expect(await get({ host: `127.0.0.1:${port}` })).toBe(200);
      expect(await get({ host: `localhost:${port}` })).toBe(403);
      expect(await get({ host: `127.0.0.1:${port}`, origin: "https://evil.example" })).toBe(403);
    } finally {
      server.close();
    }
  });

  test("token が短ければ listen しない", async () => {
    const h = await harness();
    await expect(listenFacilitator(h.f, "short", 0)).rejects.toThrow(/32\+/);
  });
});

describe("合流・指紋・直列・待ち行列・gas", () => {
  test("同じ authorization の同時の 2 要求は 1 回の送出に合流する", async () => {
    const h = await harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.rh.wait = async () => {
      await gate;
      return okReceipt(USDG);
    };
    const a = h.settle(body());
    const b = h.settle(body());
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(ra.status).toBe(200);
    expect(h.rh.writes).toHaveLength(1);
  });

  test("合流した要求は待ち行列の枠を使わない（同じ要求 3 つ + 別の 2 つが全部通る）", async () => {
    const h = await harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.rh.wait = async () => {
      await gate;
      return okReceipt(USDG);
    };
    const same = [h.settle(body()), h.settle(body()), h.settle(body())];
    await new Promise((r) => setTimeout(r, 10));
    const others = [h.settle(body({ nonce: nonceOf(2) })), h.settle(body({ nonce: nonceOf(3) }))];
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect((await Promise.all([...same, ...others])).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(h.rh.writes.map((w) => w.nonce)).toEqual([nonceOf(1), nonceOf(2), nonceOf(3)]);
  });

  test("処理中の同じ nonce で指紋が違えば 5xx（送出は 1 回）", async () => {
    const h = await harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.rh.wait = async () => {
      await gate;
      return okReceipt(USDG);
    };
    const a = h.settle(body());
    await new Promise((r) => setTimeout(r, 10));
    const conflicting = await h.settle(body({ signatureByte: "22" }));
    expect(conflicting.status).toBe(500);
    expect(conflicting.body).toMatchObject({ errorReason: "fingerprint_conflict" });
    release();
    expect((await a).status).toBe(200);
    expect(h.rh.writes).toHaveLength(1);
  });

  test("確定の後: 同じ要求は journal から 200（送出なし）、指紋違いは 5xx", async () => {
    const h = await harness();
    const first = await h.settle(body());
    expect(first.status).toBe(200);
    expect(await h.settle(body())).toEqual(first);
    expect((await h.settle(body({ signatureByte: "33" }))).status).toBe(500);
    expect(h.rh.writes).toHaveLength(1);
  });

  test("network ごとの直列: 同時の settle の送出〜receipt が重ならない", async () => {
    const h = await harness();
    let active = 0;
    let maxActive = 0;
    h.rh.send = async (_a, n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return hashOf(n);
    };
    h.rh.wait = async () => {
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return okReceipt(USDG);
    };
    const results = await Promise.all([h.settle(body({ nonce: nonceOf(1) })), h.settle(body({ nonce: nonceOf(2) })), h.settle(body({ nonce: nonceOf(3) }))]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(h.rh.writes).toHaveLength(3);
    expect(maxActive).toBe(1);
  });

  test("待ち行列は処理中 1 + 待ち 2 まで。4 件目は 503（送出なし）", async () => {
    const h = await harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.rh.wait = async () => {
      await gate;
      return okReceipt(USDG);
    };
    const pending = [1, 2, 3].map((i) => h.settle(body({ nonce: nonceOf(i) })));
    await new Promise((r) => setTimeout(r, 10));
    const fourth = await h.settle(body({ nonce: nonceOf(4) }));
    expect(fourth.status).toBe(503);
    expect(fourth.body).toMatchObject({ errorReason: "queue_full" });
    release();
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(h.rh.writes.map((w) => w.nonce)).toEqual([nonceOf(1), nonceOf(2), nonceOf(3)]);
  });

  test("gas の累計の上限: 1 回目は通り、累計 + 最悪値が上限を超える 2 回目は 400（送出なし）", async () => {
    // 最悪値 = gas 上限 125,000（見積り 100,000 × 1.25）× 1 gwei = 1.25e14。上限 2e14。1 回目の実費 = 100,000 × 1 gwei = 1e14。
    const rh = fakeChain(USDG, 200_000n * GWEI);
    const h = await harness({ rh });
    expect((await h.settle(body({ nonce: nonceOf(1) }))).status).toBe(200);
    expect(h.f.gasSpent(RH)).toBe(100_000n * GWEI);
    const second = await h.settle(body({ nonce: nonceOf(2) }));
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ errorReason: "gas_cap_reached" });
    expect(h.rh.writes).toHaveLength(1);
    expect(h.rh.writes[0]).toMatchObject({ gas: 125_000n, maxFeePerGas: GWEI });
  });

  test("maxFeePerGas の見積りが network の上限を超えれば 400（送出なし）", async () => {
    const h = await harness();
    h.rh.fees = { maxFeePerGas: 11n * GWEI, maxPriorityFeePerGas: 1n };
    expect((await h.settle(body())).body).toMatchObject({ errorReason: "fee_too_high" });
    expect(h.rh.writes).toHaveLength(0);
  });
});

describe("結果の写像（設計 §3.3 の表）", () => {
  test("成功 → 200 { success, transaction, network, payer }。意図の fsync の後に送出し、submitted・settled を残す", async () => {
    const events: string[] = [];
    const journal = fakeJournal([], events);
    const rh = fakeChain(USDG);
    const send = rh.send;
    rh.send = async (a, n) => {
      events.push("write");
      return await send(a, n);
    };
    const h = await harness({ journal, rh });
    const res = await h.settle(body());
    expect(res).toEqual({ status: 200, body: { success: true, transaction: hashOf(1), network: RH, payer: FROM } });
    expect(events.filter((e) => !e.startsWith("journal:gas_cap_"))).toEqual(["journal:submit_intent", "write", "journal:submitted", "journal:settled"]);
    expect(h.rh.writes[0]).toMatchObject({ asset: USDG, from: FROM, to: PAYTO, value: 10_000n, nonce: nonceOf(1) });
  });

  test("送出前の失敗（SDK の verify が無効、chain で未使用）→ 400、送出なし", async () => {
    const h = await harness();
    h.rh.verify = async () => ({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature" });
    const res = await h.settle(body());
    expect(res.status).toBe(400);
    expect(h.rh.writes).toHaveLength(0);
    expect(payments(h.journal)).toEqual([]);
  });

  test("送出後に receipt が期限切れ → 5xx、network は保留（次の settle も 5xx、2 回目の送出なし）", async () => {
    const h = await harness();
    h.rh.wait = async () => undefined;
    const res = await h.settle(body());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(h.f.heldNetworks()).toEqual([RH]);
    const next = await h.settle(body({ nonce: nonceOf(2) }));
    expect(next.status).toBe(503);
    expect(next.body).toMatchObject({ errorReason: "network_held" });
    expect(h.rh.writes).toHaveLength(1);
    // 別の network は動く。
    expect((await h.settle(body({ network: SEPOLIA }))).status).toBe(200);
  });

  test("revert → 5xx（verify は通っていたので不明）、journal に reverted", async () => {
    const h = await harness();
    h.rh.wait = async () => ({ ...okReceipt(USDG), status: "reverted", logs: [] });
    const res = await h.settle(body());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(paymentTypes(h.journal)).toEqual(["submit_intent", "submitted", "reverted"]);
  });

  test("Transfer の不一致（宛先・金額・2 つ）→ 5xx、未解決のまま保留", async () => {
    for (const receipt of [okReceipt(USDG, OTHER), okReceipt(USDG, PAYTO, 9_999n), { ...okReceipt(USDG), logs: [...okReceipt(USDG).logs, ...okReceipt(USDG).logs] }, okReceipt(SEPOLIA_USDC)]) {
      const h = await harness();
      h.rh.wait = async () => receipt;
      const res = await h.settle(body());
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(h.f.heldNetworks()).toEqual([RH]);
      expect(paymentTypes(h.journal)).toEqual(["submit_intent", "submitted"]);
    }
  });

  test("送出の呼び出しが失敗 → 5xx（送出したかもしれない）、保留", async () => {
    const h = await harness();
    h.rh.send = async () => {
      throw new Error("nonce too low");
    };
    const res = await h.settle(body());
    expect(res.status).toBe(500);
    expect(h.f.heldNetworks()).toEqual([RH]);
  });
});

describe("使用済みの authorization（SR-E4）", () => {
  function markUsed(chain: FakeChain, nonce: Hex, txBlock: bigint, hash: Hex, receipt: ReceiptView): void {
    chain.used.add(`${FROM.toLowerCase()}|${nonce.toLowerCase()}`);
    chain.usedLogs.set(`${FROM.toLowerCase()}|${nonce.toLowerCase()}`, [{ transactionHash: hash, blockNumber: txBlock }]);
    chain.receipts.set(hash, receipt);
  }

  test("一致する確定 tx → 200 でその tx。期限の切れた authorization でも 400 にしない。範囲は validAfter〜validBefore で、1 回の幅は小さい", async () => {
    const h = await harness();
    // validBefore = 2 時間前（期限切れ）。使われたのは validBefore の 30 秒前の block。
    const validBefore = NOW_S - 7_200;
    const txBlock = BigInt(validBefore - 30 - BASE_TS);
    markUsed(h.rh, nonceOf(1), txBlock, hashOf(77), okReceipt(USDG, PAYTO, 10_000n, txBlock));
    const res = await h.settle(body({ validBefore }));
    expect(res).toEqual({ status: 200, body: { success: true, transaction: hashOf(77), network: RH, payer: FROM } });
    expect(h.rh.calls).not.toContain("sdkVerify");
    expect(h.rh.writes).toHaveLength(0);
    for (const [from, to] of h.rh.logRanges) {
      expect(to - from + 1n).toBeLessThanOrEqual(500n);
      // validBefore の後の block（時刻 ≥ validBefore）より先は引かない。lookback（1 時間）より前も引かない。
      expect(BASE_TS + Number(to)).toBeLessThanOrEqual(validBefore + 1);
      expect(BASE_TS + Number(from)).toBeGreaterThanOrEqual(validBefore - 3_600 - 200);
    }
  });

  test("使用済みで AuthorizationUsed が見つからない → 5xx", async () => {
    const h = await harness();
    h.rh.used.add(`${FROM.toLowerCase()}|${nonceOf(1)}`);
    const res = await h.settle(body());
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errorReason: "authorization_used_unmatched" });
    expect(h.rh.writes).toHaveLength(0);
  });

  test("使用済みで tx の Transfer が要求と違う（宛先）・revert → 5xx", async () => {
    for (const receipt of [okReceipt(USDG, OTHER, 10_000n, LATEST - 5n), { ...okReceipt(USDG), status: "reverted" as const }]) {
      const h = await harness();
      markUsed(h.rh, nonceOf(1), LATEST - 5n, hashOf(5), receipt);
      expect((await h.settle(body())).status).toBe(500);
    }
  });

  test("verify の失敗と同時に他で使われた → 400 にせず照合（一致すれば 200、無ければ 5xx）", async () => {
    for (const withTx of [true, false]) {
      const h = await harness();
      h.rh.verify = async () => {
        // verify の最中に他の送出で使われた。
        if (withTx) markUsed(h.rh, nonceOf(1), LATEST - 2n, hashOf(9), okReceipt(USDG, PAYTO, 10_000n, LATEST - 2n));
        else h.rh.used.add(`${FROM.toLowerCase()}|${nonceOf(1)}`);
        return { isValid: false, invalidReason: "invalid_exact_evm_nonce_already_used" };
      };
      const res = await h.settle(body());
      expect(res.status).toBe(withTx ? 200 : 500);
      if (withTx) expect(res.body).toMatchObject({ transaction: hashOf(9) });
      expect(h.rh.writes).toHaveLength(0);
    }
  });

  test("RPC が読めなければ 5xx（400 にしない）", async () => {
    const h = await harness();
    h.rh.io.reader.authorizationState = async () => {
      throw new Error("rpc down");
    };
    expect((await h.settle(body())).status).toBe(502);
  });
});

describe("送出の直前の再検査（fsync の後）", () => {
  test("遅い fsync で残り時間が足りなくなれば送出せず aborted_before_send を残して 400", async () => {
    const h = await harness();
    h.journal.before = (record) => {
      // 意図の fsync に 5 秒（速いチェーン: 締め切り 10 秒、送出に要る残り 6 秒）。
      if (record.type === "submit_intent") h.clock.t += 5_000;
    };
    const res = await h.settle(body());
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errorReason: "insufficient_time_before_broadcast" });
    expect(h.rh.calls).not.toContain("write");
    expect(paymentTypes(h.journal)).toEqual(["submit_intent", "aborted_before_send"]);
    expect(h.f.heldNetworks()).toEqual([]);
  });

  test("Ethereum Sepolia: 40 秒の締め切りで 28 秒の残りが要る（fsync で 13 秒 → 送出しない、11 秒 → 送出する）", async () => {
    for (const [delay, sent] of [
      [13_000, false],
      [11_000, true],
    ] as const) {
      const h = await harness();
      h.journal.before = (record) => {
        if (record.type === "submit_intent") h.clock.t += delay;
      };
      const res = await h.settle(body({ network: SEPOLIA, validBefore: NOW_S + 120 }));
      expect(res.status).toBe(sent ? 200 : 400);
      expect(h.sepolia.writes).toHaveLength(sent ? 1 : 0);
    }
  });

  test("fsync の後に validBefore が近づきすぎれば送出しない", async () => {
    const h = await harness();
    h.journal.before = (record) => {
      if (record.type === "submit_intent") h.clock.t += 3_000;
    };
    // validBefore = 今 + 8 秒: 受付時は 6 秒の余裕を満たし、3 秒後は満たさない。
    const res = await h.settle(body({ validBefore: NOW_S + 8 }));
    expect(res.body).toMatchObject({ errorReason: "valid_before_too_soon" });
    expect(h.rh.writes).toHaveLength(0);
  });

  test("呼び出し元の取り消し（接続の切断）は送出しない", async () => {
    const h = await harness();
    const controller = new AbortController();
    h.journal.before = (record) => {
      if (record.type === "submit_intent") controller.abort();
    };
    const res = await h.f.handle(
      { method: "POST", url: `/${TOKEN}/settle`, headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" }, body: JSON.stringify(body()), signal: controller.signal },
      { token: TOKEN, port: () => PORT },
    );
    expect(res.body).toMatchObject({ errorReason: "request_cancelled" });
    expect(h.rh.writes).toHaveLength(0);
  });

  test("aborted_before_send の fsync が失敗すれば 5xx で network を保留", async () => {
    const h = await harness();
    h.journal.before = (record) => {
      if (record.type === "submit_intent") h.clock.t += 5_000;
      if (record.type === "aborted_before_send") throw new Error("EIO");
    };
    expect((await h.settle(body())).status).toBe(500);
    expect(h.f.heldNetworks()).toEqual([RH]);
    expect(h.rh.writes).toHaveLength(0);
  });

  test("意図の fsync が失敗すれば送出せず 5xx", async () => {
    const h = await harness();
    h.journal.before = () => {
      throw new Error("ENOSPC");
    };
    expect((await h.settle(body())).status).toBe(500);
    expect(h.rh.writes).toHaveLength(0);
  });
});

describe("永続の journal と再起動", () => {
  test("submit_intent の後に落ちた process を同じ journal で再起動: その network は保留、2 回目の送出は無い", async () => {
    const journal = fakeJournal();
    const first = await harness({ journal });
    first.rh.send = async () => {
      throw new Error("connection reset after broadcast");
    };
    expect((await first.settle(body())).status).toBe(500);
    expect(paymentTypes(journal)).toEqual(["submit_intent"]);

    // 再起動（chain では未使用のまま: 送出中かもしれないので自動では解かない）。
    const second = await harness({ journal: fakeJournal(journal.records) });
    expect(second.f.heldNetworks()).toEqual([RH]);
    expect((await second.settle(body())).status).toBe(503);
    expect((await second.settle(body({ nonce: nonceOf(2) }))).status).toBe(503);
    expect(second.rh.writes).toHaveLength(0);
    expect((await second.settle(body({ network: SEPOLIA }))).status).toBe(200);
  });

  test("起動時の照合: hash の receipt が一致すれば settled を追記して解き、同じ要求は journal から 200（送出なし）", async () => {
    const journal = fakeJournal();
    const first = await harness({ journal });
    first.rh.wait = async () => undefined; // receipt の期限切れ
    await first.settle(body());
    expect(paymentTypes(journal)).toEqual(["submit_intent", "submitted"]);

    const rh = fakeChain(USDG);
    rh.receipts.set(hashOf(1), okReceipt(USDG));
    const second = await harness({ journal: fakeJournal(journal.records), rh });
    expect(second.f.heldNetworks()).toEqual([]);
    expect(second.journal.records.at(-1)).toMatchObject({ type: "settled", hash: hashOf(1), via: "startup" });
    expect(await second.settle(body())).toEqual({ status: 200, body: { success: true, transaction: hashOf(1), network: RH, payer: FROM } });
    expect(rh.writes).toHaveLength(0);
  });

  test("起動時の照合: hash 無しでも chain で使用済み・一致する tx があれば解ける", async () => {
    const journal = fakeJournal();
    const first = await harness({ journal });
    first.rh.send = async () => {
      throw new Error("timeout");
    };
    await first.settle(body());
    const rh = fakeChain(USDG);
    rh.used.add(`${FROM.toLowerCase()}|${nonceOf(1)}`);
    rh.usedLogs.set(`${FROM.toLowerCase()}|${nonceOf(1)}`, [{ transactionHash: hashOf(4), blockNumber: LATEST - 3n }]);
    rh.receipts.set(hashOf(4), okReceipt(USDG, PAYTO, 10_000n, LATEST - 3n));
    const second = await harness({ journal: fakeJournal(journal.records), rh });
    expect(second.f.heldNetworks()).toEqual([]);
  });

  test("起動時の照合: receipt が無い（pending）なら保留のまま", async () => {
    const journal = fakeJournal();
    const first = await harness({ journal });
    first.rh.wait = async () => undefined;
    await first.settle(body());
    const second = await harness({ journal: fakeJournal(journal.records) });
    expect(second.f.heldNetworks()).toEqual([RH]);
  });

  test("運用者の resolved_by_operator だけが保留を解く（その鍵の settle は 5xx のまま、送出しない）", async () => {
    const journal = fakeJournal();
    const first = await harness({ journal });
    first.rh.send = async () => {
      throw new Error("x");
    };
    await first.settle(body());
    const key = keyOf(RH, USDG, nonceOf(1));
    const records: JournalRecord[] = [...journal.records, { type: "resolved_by_operator", key, reason: "checked explorer: never mined", at: NOW_MS }];
    const second = await harness({ journal: fakeJournal(records) });
    expect(second.f.heldNetworks()).toEqual([]);
    expect((await second.settle(body())).body).toMatchObject({ errorReason: "resolved_by_operator" });
    expect((await second.settle(body({ nonce: nonceOf(2) }))).status).toBe(200);
    expect(second.rh.writes.map((w) => w.nonce)).toEqual([nonceOf(2)]);
  });

  test("journal の行: resolved_by_operator は理由が必須、壊れた行は起動しない", () => {
    expect(() => parseJournalLine(JSON.stringify({ type: "resolved_by_operator", key: "k", reason: " " }), 3)).toThrow(/reason/);
    expect(() => parseJournalLine("{\"type\":\"submit_int", 4)).toThrow(/not JSON/);
    expect(() => parseJournalLine(JSON.stringify({ type: "submitted", key: "k", hash: "0x12" }), 5)).toThrow(/hash/);
  });

  describe("ファイルの journal", () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    });
    test("追記して読み戻せる（0600、1 行 1 記録）", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "evm-fac-"));
      const file = path.join(dir, "sub", "journal.ndjson");
      const j = createFileJournal(file);
      expect(await j.load()).toEqual([]);
      await j.append({ type: "aborted_before_send", key: "k", reason: "r", at: 1 });
      await j.append({ type: "resolved_by_operator", key: "k", reason: "r", at: 2 });
      await j.close();
      expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
      const again = createFileJournal(file);
      expect(await again.load()).toHaveLength(2);
      await again.close();
    });
  });
});

describe("定数", () => {
  test("event の topic0 は viem の値と一致", () => {
    expect(AUTHORIZATION_USED_TOPIC).toBe(toEventSelector("AuthorizationUsed(address,bytes32)"));
    expect(TRANSFER_TOPIC).toBe(toEventSelector("Transfer(address,address,uint256)"));
  });

  test("EVM testnet 以外の network は受けない", () => {
    const c = fakeChain(USDG);
    expect(() => createEvmFacilitator({ networks: ["eip155:84532"], chains: new Map([["eip155:84532", c.io]]), journal: fakeJournal(), payToAllowlist: [PAYTO] })).toThrow(/EVM testnets/);
  });

  test("start の前の要求は 503", async () => {
    const h = await harness({ start: false });
    expect((await h.settle(body())).status).toBe(503);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * Codex I-1 の修正（#1 送出前の 400 は読み直してから、#2 journal の書き込みの締め切り、#3 ディレクトリの fsync、#4 起動の失敗の文言）
 * ────────────────────────────────────────────────────────────────────────────── */

function markUsedOn(chain: FakeChain, withTx: boolean): void {
  const k = `${FROM.toLowerCase()}|${nonceOf(1)}`;
  chain.used.add(k);
  if (withTx) {
    chain.usedLogs.set(k, [{ transactionHash: hashOf(42), blockNumber: LATEST - 2n }]);
    chain.receipts.set(hashOf(42), okReceipt(USDG, PAYTO, 10_000n, LATEST - 2n));
  }
}

/** 手順 4 の後の各 400 の経路で、await の間に他で使われる（state が used に変わる）。 */
const RACE_PATHS: ReadonlyArray<readonly [string, (h: Harness, withTx: boolean) => void]> = [
  [
    "gas の見積りの失敗（gas_estimate_unavailable）",
    (h, withTx) => {
      h.rh.estimate = async () => {
        markUsedOn(h.rh, withTx);
        throw new Error("execution reverted");
      };
    },
  ],
  [
    "gas の見積りが上限超え（gas_limit_too_high）",
    (h, withTx) => {
      h.rh.estimate = async () => {
        markUsedOn(h.rh, withTx);
        return 200_000n;
      };
    },
  ],
  [
    "手数料の見積りの失敗（fee_estimate_unavailable）",
    (h, withTx) => {
      h.rh.io.reader.feesPerGas = async () => {
        markUsedOn(h.rh, withTx);
        throw new Error("rpc down");
      };
    },
  ],
  [
    "手数料が上限超え（fee_too_high）",
    (h, withTx) => {
      h.rh.io.reader.feesPerGas = async () => {
        markUsedOn(h.rh, withTx);
        return { maxFeePerGas: 11n * GWEI, maxPriorityFeePerGas: 1n };
      };
    },
  ],
  [
    "gas の累計の上限（gas_cap_reached）",
    (h, withTx) => {
      // 上限は起動時に journal の `gas_cap_init` で決まる（起動後の env の値は効かない）ので、ここは見積りを上限の上に上げる。
      // 既定の上限 1e18 を超える最悪値 = gas 上限 × maxFeePerGas: 見積り 160,000（→ 200,000）× 1e13 + α。maxFeePerGas の上限も上げる。
      (h.rh.io as { maxFeePerGas: bigint }).maxFeePerGas = 10n ** 14n;
      h.rh.estimate = async () => 160_000n;
      h.rh.io.reader.feesPerGas = async () => {
        markUsedOn(h.rh, withTx);
        return { maxFeePerGas: 10n ** 13n + 1n, maxPriorityFeePerGas: 1n };
      };
    },
  ],
  [
    "fsync の前の時間の検査（insufficient_time_before_broadcast）",
    (h, withTx) => {
      h.rh.io.reader.feesPerGas = async () => {
        markUsedOn(h.rh, withTx);
        h.clock.t += 5_000;
        return { maxFeePerGas: GWEI, maxPriorityFeePerGas: 1n };
      };
    },
  ],
  [
    "fsync の後の再検査（aborted_before_send）",
    (h, withTx) => {
      h.journal.before = (record) => {
        if (record.type === "submit_intent") {
          markUsedOn(h.rh, withTx);
          h.clock.t += 5_000;
        }
      };
    },
  ],
];

describe("I-1 #1: 手順 4 の後の 400 は chain を読み直してから", () => {
  test.each(RACE_PATHS)("%s: その間に一致する tx で使われた → 200 でその tx（送出なし）", async (_name, arrange) => {
    const h = await harness();
    arrange(h, true);
    const res = await h.settle(body());
    expect(res).toEqual({ status: 200, body: { success: true, transaction: hashOf(42), network: RH, payer: FROM } });
    expect(h.rh.writes).toHaveLength(0);
  });

  test.each(RACE_PATHS)("%s: その間に使われたが一致する tx が無い → 5xx（400 にしない）", async (_name, arrange) => {
    const h = await harness();
    arrange(h, false);
    const res = await h.settle(body());
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ errorReason: "authorization_used_unmatched" });
    expect(h.rh.writes).toHaveLength(0);
  });

  test.each(RACE_PATHS)("%s: 読み直しができない → 5xx", async (_name, arrange) => {
    const h = await harness();
    arrange(h, false);
    let reads = 0;
    const original = h.rh.io.reader.authorizationState;
    h.rh.io.reader.authorizationState = async (...args) => {
      reads += 1;
      // 手順 4 の 2 回（受付・待ち行列の後）は通し、その後の読み直しを落とす。
      if (reads > 2) throw new Error("rpc down");
      return await original(...args);
    };
    expect((await h.settle(body())).status).toBe(502);
    expect(h.rh.writes).toHaveLength(0);
  });

  test("fsync の後の読み直しの失敗は network を保留する", async () => {
    const h = await harness();
    h.journal.before = (record) => {
      if (record.type === "submit_intent") {
        h.clock.t += 5_000;
        h.rh.io.reader.authorizationState = async () => {
          throw new Error("rpc down");
        };
      }
    };
    expect((await h.settle(body())).status).toBe(502);
    expect(h.f.heldNetworks()).toEqual([RH]);
    expect(paymentTypes(h.journal)).toEqual(["submit_intent", "aborted_before_send"]);
  });
});

describe("I-1 #2: journal の書き込みは締め切りで打ち切る（偽の時計）", () => {
  function stallOn(h: Harness, type: JournalRecord["type"]): { called: () => boolean; release: () => void } {
    let called = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.journal.before = async (record) => {
      if (record.type === type) {
        called = true;
        await gate;
      }
    };
    return { called: () => called, release };
  }

  test("submit_intent が止まる: 締め切り（10 秒）で 5xx、送出しない、network は保留。後で書き込みが終わっても送出しない", async () => {
    const h = await harness();
    const stall = stallOn(h, "submit_intent");
    let response: FacilitatorResponse | undefined;
    void h.settle(body()).then((r) => (response = r));
    await flush();
    expect(stall.called()).toBe(true);
    await h.advance(9_999);
    expect(response).toBeUndefined();
    await h.advance(1);
    expect(response?.status).toBe(504);
    expect(response?.body).toMatchObject({ errorReason: "journal_timeout" });
    expect(h.f.heldNetworks()).toEqual([RH]);
    stall.release();
    await flush();
    expect(paymentTypes(h.journal)).toEqual(["submit_intent"]);
    expect(h.rh.writes).toHaveLength(0);
    // 遅れて載った意図は未解決（再起動しても保留）。
    const restarted = await harness({ journal: fakeJournal(h.journal.records) });
    expect(restarted.f.heldNetworks()).toEqual([RH]);
  });

  test("送出の後に submitted が止まる: 締め切りで 5xx、network は保留（送出は 1 回だけ）", async () => {
    const h = await harness();
    const stall = stallOn(h, "submitted");
    let response: FacilitatorResponse | undefined;
    void h.settle(body()).then((r) => (response = r));
    await flush();
    expect(stall.called()).toBe(true);
    expect(h.rh.writes).toHaveLength(1);
    await h.advance(10_000);
    expect(response?.status).toBe(504);
    expect(h.f.heldNetworks()).toEqual([RH]);
    expect(h.rh.calls).not.toContain("waitForReceipt");
    // 次の settle は保留で 5xx、送出しない。
    expect((await h.settle(body({ nonce: nonceOf(2) }))).status).toBe(503);
    stall.release();
    await flush();
    expect(h.rh.writes).toHaveLength(1);
  });

  test("receipt の後に settled が止まる: 締め切りで 5xx、network は保留", async () => {
    const h = await harness();
    const stall = stallOn(h, "settled");
    let response: FacilitatorResponse | undefined;
    void h.settle(body()).then((r) => (response = r));
    await flush();
    expect(stall.called()).toBe(true);
    await h.advance(10_000);
    expect(response?.status).toBe(504);
    expect(h.f.heldNetworks()).toEqual([RH]);
    stall.release();
    await flush();
    expect(h.rh.writes).toHaveLength(1);
  });
});

describe("I-1 #3: 新しく作った journal のディレクトリの項目を fsync する", () => {
  function fakeFs(existing: string[]): { fs: JournalFs; calls: string[] } {
    const present = new Set(existing);
    const calls: string[] = [];
    const fs: JournalFs = {
      exists: (t) => present.has(t),
      mkdir: (t) => {
        calls.push(`mkdir ${t}`);
        present.add(t);
      },
      readText: () => undefined,
      openAppend: async (t) => {
        calls.push(`open ${t}`);
        present.add(t);
        return { write: async () => {}, sync: async () => void calls.push(`sync ${t}`), close: async () => {} };
      },
      fsyncDir: async (t) => void calls.push(`fsyncDir ${t}`),
    };
    return { fs, calls };
  }

  test("ファイルと 2 段のディレクトリを作る: ファイルを fsync し、その親・作った各ディレクトリの親を fsync してから load が終わる", async () => {
    const { fs, calls } = fakeFs(["/", "/x"]);
    await createFileJournal("/x/a/b/journal.ndjson", fs).load();
    expect(calls).toEqual(["mkdir /x/a", "mkdir /x/a/b", "open /x/a/b/journal.ndjson", "sync /x/a/b/journal.ndjson", "fsyncDir /x/a/b", "fsyncDir /x/a", "fsyncDir /x", "fsyncDir /"]);
  });

  test("既にあるファイルでも何も作らないが、ファイルと root までのディレクトリは毎回 fsync する（I-2 #5）", async () => {
    const { fs, calls } = fakeFs(["/", "/x", "/x/journal.ndjson"]);
    await createFileJournal("/x/journal.ndjson", fs).load();
    expect(calls).toEqual(["open /x/journal.ndjson", "sync /x/journal.ndjson", "fsyncDir /x", "fsyncDir /"]);
  });

  test("前回の起動がディレクトリの fsync で失敗した後の再起動でも、ディレクトリを fsync してから使う（I-2 #5）", async () => {
    const { fs, calls } = fakeFs(["/", "/x"]);
    const ok = fs.fsyncDir;
    fs.fsyncDir = async () => {
      throw new Error("EIO");
    };
    await expect(createFileJournal("/x/a/journal.ndjson", fs).load()).rejects.toThrow();
    // 1 回目でディレクトリとファイルは作られた（存在する）。2 回目は「既にある」が、fsync を省かない。
    fs.fsyncDir = ok;
    calls.length = 0;
    await createFileJournal("/x/a/journal.ndjson", fs).load();
    expect(calls).toEqual(["open /x/a/journal.ndjson", "sync /x/a/journal.ndjson", "fsyncDir /x/a", "fsyncDir /x", "fsyncDir /"]);
  });

  test("ディレクトリの fsync が失敗すれば load は失敗する（journal を使わない）", async () => {
    const { fs } = fakeFs(["/", "/x"]);
    fs.fsyncDir = async () => {
      throw new Error("EIO");
    };
    await expect(createFileJournal("/x/journal.ndjson", fs).load()).rejects.toThrow();
  });
});

describe("I-1 #4: 起動の失敗は固定の文言だけ（RPC の URL・鍵・token・例外の文言を出さない）", () => {
  const SECRET_KEY = `0x${"5a".repeat(32)}`;
  const SECRET_TOKEN = `tok_${"Q".repeat(40)}`;
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  function envOf(extra: Record<string, string>): NodeJS.ProcessEnv {
    dir = mkdtempSync(path.join(tmpdir(), "evm-fac-cli-"));
    return {
      EVM_FACILITATOR_KEY: SECRET_KEY,
      EVM_FACILITATOR_TOKEN: SECRET_TOKEN,
      EVM_FACILITATOR_NETWORKS: RH,
      EVM_FACILITATOR_PAYTO_ALLOWLIST: PAYTO,
      EVM_FACILITATOR_GAS_CAP_46630: "1000000000000000",
      EVM_FACILITATOR_JOURNAL: path.join(dir, "journal.ndjson"),
      ...extra,
    };
  }

  test("getChainId が失敗する RPC（URL の path・query に秘密）: 出力は固定の code だけ", async () => {
    const out: string[] = [];
    const code = await runCli(envOf({ EVM_FACILITATOR_RPC_46630: "https://127.0.0.1:1/v2/SECRETPATHKEY123?apikey=SECRETQUERY456" }), {
      stdout: (t) => void out.push(t),
      stderr: (t) => void out.push(t),
    });
    expect(code).toBe(1);
    expect(out).toEqual(["evm-facilitator: rpc_check_failed:eip155:46630\n"]);
    const all = out.join("");
    for (const secret of ["SECRETPATHKEY123", "SECRETQUERY456", "127.0.0.1:1", SECRET_KEY, SECRET_TOKEN, "5a5a5a"]) expect(all).not.toContain(secret);
  }, 30_000);

  test("設定の誤りの値は出さない（network の値・RPC の URL）", async () => {
    for (const extra of [{ EVM_FACILITATOR_NETWORKS: "eip155:SECRETNET999" }, { EVM_FACILITATOR_RPC_46630: "http://SECRETHOST.example/k=SECRET789" }]) {
      const out: string[] = [];
      expect(await runCli(envOf(extra), { stdout: (t) => void out.push(t), stderr: (t) => void out.push(t) })).toBe(1);
      const all = out.join("");
      expect(all).toMatch(/^evm-facilitator: EVM_FACILITATOR_[A-Z_0-9]+ must /);
      for (const secret of ["SECRETNET999", "SECRETHOST", "SECRET789", SECRET_KEY, SECRET_TOKEN]) expect(all).not.toContain(secret);
    }
  });
});

describe("gas の上限は見積り × 1.25（Sepolia の out of gas。2026-10-13 の live）", () => {
  test("送出の gas = 見積り × 1.25 の切り上げ。見積りは送出と同じ呼び出し（署名・authorization）", async () => {
    const h = await harness();
    h.rh.estimate = async () => 90_001n;
    expect((await h.settle(body())).status).toBe(200);
    // 90,001 × 1.25 = 112,501.25 → 112,502
    expect(h.rh.writes[0]?.gas).toBe(112_502n);
    const { gas: _gas, maxFeePerGas: _f, maxPriorityFeePerGas: _p, ...sentCall } = h.rh.writes[0]!;
    expect(h.rh.estimates).toEqual([sentCall]);
    // 見積りは verify の後、送出の前。
    expect(h.rh.calls.indexOf("estimateGas")).toBeGreaterThan(h.rh.calls.indexOf("sdkVerify"));
    expect(h.rh.calls.indexOf("estimateGas")).toBeLessThan(h.rh.calls.indexOf("write"));
  });

  test("gas の累計の上限の最悪値も実際に送る gas 上限で数える", async () => {
    // 見積り 160,000 → gas 上限 200,000。最悪値 2e14。上限 1.9e14 なら拒む（旧来の固定値でも同じだが、見積り 100,000 なら通る）。
    const rh = fakeChain(USDG, 190_000n * GWEI);
    const h = await harness({ rh });
    h.rh.estimate = async () => 160_000n;
    expect((await h.settle(body())).body).toMatchObject({ errorReason: "gas_cap_reached" });
    h.rh.estimate = async () => 100_000n;
    expect((await h.settle(body())).status).toBe(200);
  });

  test("見積り × 1.25 が network の上限を超えれば送出しない（未使用を読み直して 400）", async () => {
    const h = await harness();
    // 160,001 × 1.25 = 200,002 > 200,000
    h.rh.estimate = async () => 160_001n;
    const res = await h.settle(body());
    expect(res).toMatchObject({ status: 400, body: { errorReason: "gas_limit_too_high" } });
    expect(h.rh.writes).toHaveLength(0);
    expect(payments(h.journal)).toEqual([]);
    // 手順 4 の 2 回 + 拒む前の読み直し 1 回。
    expect(h.rh.calls.filter((c) => c === "authorizationState")).toHaveLength(3);
    expect(h.rh.calls.lastIndexOf("authorizationState")).toBeGreaterThan(h.rh.calls.indexOf("estimateGas"));
  });

  test("ちょうど上限（見積り 160,000 → 200,000）は送る", async () => {
    const h = await harness();
    h.rh.estimate = async () => 160_000n;
    expect((await h.settle(body())).status).toBe(200);
    expect(h.rh.writes[0]?.gas).toBe(200_000n);
  });

  test("見積りの失敗は送出せず、未使用を読み直して 400", async () => {
    const h = await harness();
    h.rh.estimate = async () => {
      throw new Error("execution reverted");
    };
    const res = await h.settle(body());
    expect(res).toMatchObject({ status: 400, body: { errorReason: "gas_estimate_unavailable" } });
    expect(h.rh.writes).toHaveLength(0);
    expect(h.rh.calls.filter((c) => c === "authorizationState")).toHaveLength(3);
  });

  test("Ethereum Sepolia の既定の上限 400,000 は live の見積り 288,251（× 1.25 = 360,314）を通す", async () => {
    const h = await harness();
    h.sepolia.estimate = async () => 288_251n;
    expect((await h.settle(body({ network: SEPOLIA, validBefore: NOW_S + 120 }))).status).toBe(200);
    expect(h.sepolia.writes[0]?.gas).toBe(360_314n);
    expect(DEFAULT_MAX_SETTLE_GAS[SEPOLIA]).toBe(400_000n);
    // 速いチェーンの既定（200,000）では同じ見積りは拒む。
    h.rh.estimate = async () => 288_251n;
    expect((await h.settle(body())).body).toMatchObject({ errorReason: "gas_limit_too_high" });
  });

  test("送出の後の不明（receipt の期限切れ）の最悪値も送った gas 上限で数える", async () => {
    const h = await harness();
    h.rh.estimate = async () => 100_000n;
    h.rh.wait = async () => undefined;
    await h.settle(body());
    expect(h.f.gasSpent(RH)).toBe(125_000n * GWEI);
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * H-1（hosted 設計 `docs/evm-testnets-hosted-design.md` §2）: bind・gas の累計の永続と補充・単一の実行者の lock
 * ────────────────────────────────────────────────────────────────────────────── */

/** 試験の固定値（鍵の形をしたダミー。資金の無い値で、どこにも送らない）。 */
const DUMMY_KEY = `0x${"5a".repeat(32)}`;
const CAP = 200_000n * GWEI;

function intent(key: string, network: string, gasReservedWei: string | undefined): JournalRecord {
  return {
    type: "submit_intent",
    key,
    fingerprint: "sha256:x",
    network,
    asset: USDG,
    from: FROM,
    to: PAYTO,
    value: "10000",
    nonce: nonceOf(99),
    validAfter: "0",
    validBefore: String(NOW_S + 60),
    ...(gasReservedWei === undefined ? {} : { gasReservedWei }),
    at: NOW_MS,
  } as JournalRecord;
}
function capInit(network: string, capWei: bigint): JournalRecord {
  return { type: "gas_cap_init", network, capWei: capWei.toString(), at: NOW_MS };
}
function capRaise(network: string, addWei: bigint, reason = "funded E-FAC again"): JournalRecord {
  return { type: "gas_cap_raise", network, addWei: addWei.toString(), reason, at: NOW_MS };
}

describe("H-1 §2.1 bind", () => {
  const base = {
    EVM_FACILITATOR_KEY: DUMMY_KEY,
    EVM_FACILITATOR_TOKEN: TOKEN,
    EVM_FACILITATOR_NETWORKS: RH,
    EVM_FACILITATOR_PAYTO_ALLOWLIST: PAYTO,
    EVM_FACILITATOR_GAS_CAP_46630: "1000",
    EVM_FACILITATOR_JOURNAL: "/nonexistent/journal.ndjson",
  };

  test("既定は 127.0.0.1、0.0.0.0 は受ける", () => {
    expect(cliConfigOf(base).bind).toBe("127.0.0.1");
    expect(cliConfigOf({ ...base, EVM_FACILITATOR_BIND: "127.0.0.1" }).bind).toBe("127.0.0.1");
    expect(cliConfigOf({ ...base, EVM_FACILITATOR_BIND: "0.0.0.0" }).bind).toBe("0.0.0.0");
  });

  test.each(["localhost", "::", "::1", "127.0.0.2", "0.0.0.0 ", "", "10.0.0.1"])("EVM_FACILITATOR_BIND=%j は起動しない（固定の文言、値を出さない）", (bind) => {
    let caught: unknown;
    try {
      cliConfigOf({ ...base, EVM_FACILITATOR_BIND: bind });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StartupError);
    expect((caught as Error).message).toBe("EVM_FACILITATOR_BIND must be 127.0.0.1 or 0.0.0.0");
  });

  test("listenFacilitator は 0.0.0.0 に bind できるが、Host の検査は 127.0.0.1:<port> の完全一致のまま", async () => {
    const h = await harness();
    const { server, port, host } = await listenFacilitator(h.f, TOKEN, 0, "0.0.0.0");
    try {
      expect(host).toBe("0.0.0.0");
      expect(server.address()).toMatchObject({ address: "0.0.0.0" });
      const get = (headers: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          const req = httpRequest({ host: "127.0.0.1", port, path: `/${TOKEN}/supported`, method: "GET", headers }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          });
          req.on("error", reject);
          req.end();
        });
      expect(await get({ host: `127.0.0.1:${port}` })).toBe(200);
      expect(await get({ host: `0.0.0.0:${port}` })).toBe(403);
      expect(await get({ host: `localhost:${port}` })).toBe(403);
      expect(await get({ host: `router.subethalabs.com` })).toBe(403);
      expect(await get({ host: `127.0.0.1:${port}`, origin: "https://router.subethalabs.com" })).toBe(403);
    } finally {
      server.close();
    }
  });

  test("listenFacilitator は表に無い bind を拒む", async () => {
    const h = await harness();
    await expect(listenFacilitator(h.f, TOKEN, 0, "::")).rejects.toThrow(/bind address/);
  });
});

describe("H-1 §2.2 gas の累計の永続", () => {
  test("最初の起動: 有効な network ごとに env の上限を gas_cap_init として書いてから start が終わる", async () => {
    const rh = fakeChain(USDG, CAP);
    const sepolia = fakeChain(SEPOLIA_USDC, 7n * CAP);
    const h = await harness({ rh, sepolia });
    expect(h.journal.records).toEqual([
      { type: "gas_cap_init", network: RH, capWei: CAP.toString(), at: NOW_MS },
      { type: "gas_cap_init", network: SEPOLIA, capWei: (7n * CAP).toString(), at: NOW_MS },
    ]);
    expect(h.f.gasCap(RH)).toBe(CAP);
    expect(h.f.gasCap(SEPOLIA)).toBe(7n * CAP);
    expect(h.f.gasSpent(RH)).toBe(0n);
  });

  test("submit_intent に gasReservedWei（gas 上限 × maxFeePerGas）、settled・reverted に gasUsedWei（gasUsed × effectiveGasPrice）", async () => {
    const h = await harness();
    h.rh.wait = async () => ({ ...okReceipt(USDG), gasUsed: 90_000n, effectiveGasPrice: 3n });
    expect((await h.settle(body())).status).toBe(200);
    h.rh.wait = async () => ({ ...okReceipt(USDG), status: "reverted", logs: [], gasUsed: 50_000n, effectiveGasPrice: 7n });
    expect((await h.settle(body({ nonce: nonceOf(2) }))).status).toBe(502);
    const [i1, , s1, i2, , r2] = payments(h.journal) as Array<Record<string, unknown>>;
    expect(i1).toMatchObject({ type: "submit_intent", gasReservedWei: (125_000n * GWEI).toString() });
    expect(s1).toMatchObject({ type: "settled", gasUsedWei: "270000" });
    expect(i2).toMatchObject({ type: "submit_intent", gasReservedWei: (125_000n * GWEI).toString() });
    expect(r2).toMatchObject({ type: "reverted", gasUsedWei: "350000" });
    expect(h.f.gasSpent(RH)).toBe(270_000n + 350_000n);
  });

  test("再生: spent = Σ(settled・reverted の gasUsedWei) + Σ(未解決・運用者の解決の gasReservedWei)、aborted_before_send は 0", async () => {
    const k = (n: number) => keyOf(RH, USDG, nonceOf(100 + n));
    const records: JournalRecord[] = [
      capInit(RH, CAP),
      capInit(SEPOLIA, CAP),
      intent(k(1), RH, "1000"),
      { type: "submitted", key: k(1), hash: hashOf(1), at: NOW_MS },
      { type: "settled", key: k(1), hash: hashOf(1), blockNumber: "1", via: "receipt", gasUsedWei: "7", at: NOW_MS },
      intent(k(2), RH, "2000"),
      { type: "submitted", key: k(2), hash: hashOf(2), at: NOW_MS },
      { type: "reverted", key: k(2), hash: hashOf(2), via: "receipt", gasUsedWei: "11", at: NOW_MS },
      intent(k(3), RH, "13"), // 未解決（hash 無し、chain で未使用 → 保留のまま）
      intent(k(4), RH, "4000"),
      { type: "aborted_before_send", key: k(4), reason: "insufficient_time_before_broadcast", at: NOW_MS },
      intent(k(5), RH, "19"),
      { type: "resolved_by_operator", key: k(5), reason: "checked explorer", at: NOW_MS },
      intent(keyOf(SEPOLIA, SEPOLIA_USDC, nonceOf(6)), SEPOLIA, "23"),
      { type: "aborted_before_send", key: keyOf(SEPOLIA, SEPOLIA_USDC, nonceOf(6)), reason: "request_cancelled", at: NOW_MS },
    ];
    const h = await harness({ journal: fakeJournal(records), rh: fakeChain(USDG, CAP), sepolia: fakeChain(SEPOLIA_USDC, CAP) });
    expect(h.f.gasSpent(RH)).toBe(7n + 11n + 13n + 19n);
    expect(h.f.gasSpent(SEPOLIA)).toBe(0n);
    expect(h.f.heldNetworks()).toEqual([RH]);
    // 既にある gas_cap_init は書き足さない。
    expect(h.journal.records.filter((r) => r.type === "gas_cap_init")).toHaveLength(2);
  });

  test("再起動で上限は戻らない: 累計は journal から復元され、同じ env の上限では次の送出を拒む", async () => {
    // 上限 2e14、1 回目の実費 1e14、2 回目の最悪値 1.25e14 → 累計 + 最悪値 > 上限。
    const journal = fakeJournal();
    const first = await harness({ journal, rh: fakeChain(USDG, CAP) });
    expect((await first.settle(body({ nonce: nonceOf(1) }))).status).toBe(200);
    expect(first.f.gasSpent(RH)).toBe(100_000n * GWEI);
    const second = await harness({ journal: fakeJournal(journal.records), rh: fakeChain(USDG, CAP) });
    expect(second.f.gasSpent(RH)).toBe(100_000n * GWEI);
    expect(second.f.gasCap(RH)).toBe(CAP);
    const res = await second.settle(body({ nonce: nonceOf(2) }));
    expect(res.body).toMatchObject({ errorReason: "gas_cap_reached" });
    expect(second.rh.writes).toHaveLength(0);
  });

  test("未解決の予約も再起動で数える（receipt の期限切れ → 再起動の累計 = 予約）", async () => {
    const journal = fakeJournal();
    const first = await harness({ journal });
    first.rh.wait = async () => undefined;
    await first.settle(body());
    const second = await harness({ journal: fakeJournal(journal.records) });
    expect(second.f.heldNetworks()).toEqual([RH]);
    expect(second.f.gasSpent(RH)).toBe(125_000n * GWEI);
  });

  test("live の累計は同じ journal の再生と一致する（確定・中止・送出の不明・Transfer の不一致・revert）", async () => {
    const journal = fakeJournal();
    const live = await harness({ journal });
    expect((await live.settle(body({ nonce: nonceOf(1) }))).status).toBe(200);
    live.journal.before = (record) => {
      if (record.type === "submit_intent") live.clock.t += 5_000;
    };
    expect((await live.settle(body({ nonce: nonceOf(2) }))).body).toMatchObject({ errorReason: "insufficient_time_before_broadcast" });
    delete live.journal.before;
    live.sepolia.wait = async () => ({ ...okReceipt(SEPOLIA_USDC), status: "reverted", logs: [], gasUsed: 1_234n, effectiveGasPrice: 5n });
    expect((await live.settle(body({ network: SEPOLIA, nonce: nonceOf(3), validBefore: NOW_S + 120 }))).status).toBe(502);
    live.sepolia.wait = async () => okReceipt(SEPOLIA_USDC, OTHER);
    expect((await live.settle(body({ network: SEPOLIA, nonce: nonceOf(4), validBefore: NOW_S + 120 }))).body).toMatchObject({ errorReason: "transfer_mismatch" });
    const liveRh = live.f.gasSpent(RH);
    const liveSepolia = live.f.gasSpent(SEPOLIA);
    // Sepolia: revert の実費 + 不一致の予約（未解決のまま）。
    expect(liveSepolia).toBe(1_234n * 5n + 125_000n * GWEI);
    const replay = await harness({ journal: fakeJournal(journal.records) });
    expect(replay.f.gasSpent(RH)).toBe(liveRh);
    expect(replay.f.gasSpent(SEPOLIA)).toBe(liveSepolia);
  });

  test("有効な上限 = gas_cap_init + Σ gas_cap_raise。補充の後は送出できる", async () => {
    const journal = fakeJournal();
    const first = await harness({ journal, rh: fakeChain(USDG, CAP) });
    expect((await first.settle(body({ nonce: nonceOf(1) }))).status).toBe(200);
    const raised = fakeJournal([...journal.records, capRaise(RH, 20_000n * GWEI), capRaise(RH, 5_000n * GWEI)]);
    const second = await harness({ journal: raised, rh: fakeChain(USDG, CAP) });
    expect(second.f.gasCap(RH)).toBe(CAP + 25_000n * GWEI);
    // 累計 1e14 + 最悪値 1.25e14 = 2.25e14 ≤ 2.25e14。
    expect((await second.settle(body({ nonce: nonceOf(2) }))).status).toBe(200);
    expect(second.rh.writes).toHaveLength(1);
  });

  test("env の上限が journal の gas_cap_init と違えば起動しない（固定の文言、値なし、何も書かない）", async () => {
    const records = [capInit(RH, CAP)];
    const journal = fakeJournal(records);
    const h = await harness({ journal, rh: fakeChain(USDG, CAP + 1n), start: false });
    let caught: unknown;
    try {
      await h.f.start();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(StartupError);
    expect((caught as Error).message).toBe(`gas_cap_env_mismatch:${RH}`);
    for (const v of [CAP, CAP + 1n]) expect((caught as Error).message).not.toContain(v.toString());
    // Sepolia の gas_cap_init も書かない（全部を確かめてから書く）。
    expect(journal.records).toEqual(records);
    // 補充（gas_cap_raise）があっても env は gas_cap_init と比べる（env を有効な上限に合わせても補充にならない）。
    const withRaise = await harness({ journal: fakeJournal([capInit(RH, CAP), capRaise(RH, 1n)]), rh: fakeChain(USDG, CAP + 1n), start: false });
    await expect(withRaise.f.start()).rejects.toThrow(`gas_cap_env_mismatch:${RH}`);
  });

  test("起動時の照合で解いた settled にも gasUsedWei: hash があれば receipt の実費、hash 無し（event から）は予約", async () => {
    // hash あり（receipt の期限切れの後）。
    const j1 = fakeJournal();
    const a = await harness({ journal: j1 });
    a.rh.wait = async () => undefined;
    await a.settle(body());
    const rh1 = fakeChain(USDG);
    rh1.receipts.set(hashOf(1), { ...okReceipt(USDG), gasUsed: 80_000n, effectiveGasPrice: 9n });
    const a2 = await harness({ journal: fakeJournal(j1.records), rh: rh1 });
    expect(a2.journal.records.at(-1)).toMatchObject({ type: "settled", via: "startup", gasUsedWei: "720000" });
    expect(a2.f.gasSpent(RH)).toBe(720_000n);
    // hash 無し（送出の呼び出しが失敗）: AuthorizationUsed から見つけた tx は自分の送出とは限らないので予約を数える。
    const j2 = fakeJournal();
    const b = await harness({ journal: j2 });
    b.rh.send = async () => {
      throw new Error("timeout");
    };
    await b.settle(body());
    const rh2 = fakeChain(USDG);
    rh2.used.add(`${FROM.toLowerCase()}|${nonceOf(1)}`);
    rh2.usedLogs.set(`${FROM.toLowerCase()}|${nonceOf(1)}`, [{ transactionHash: hashOf(4), blockNumber: LATEST - 3n }]);
    rh2.receipts.set(hashOf(4), { ...okReceipt(USDG, PAYTO, 10_000n, LATEST - 3n), gasUsed: 1n, effectiveGasPrice: 1n });
    const b2 = await harness({ journal: fakeJournal(j2.records), rh: rh2 });
    expect(b2.f.heldNetworks()).toEqual([]);
    expect(b2.journal.records.at(-1)).toMatchObject({ type: "settled", via: "startup", gasUsedWei: (125_000n * GWEI).toString() });
    expect(b2.f.gasSpent(RH)).toBe(125_000n * GWEI);
  });

  test("起動の log に network ごとの有効な上限と累計（wei の値だけ）", async () => {
    const events: Array<Readonly<Record<string, unknown>>> = [];
    const rh = fakeChain(USDG, CAP);
    const f = createEvmFacilitator({
      networks: [RH],
      chains: new Map([[RH, rh.io]]),
      journal: fakeJournal([capInit(RH, CAP), capRaise(RH, 5n), intent(keyOf(RH, USDG, nonceOf(1)), RH, "42"), { type: "aborted_before_send", key: keyOf(RH, USDG, nonceOf(1)), reason: "r", at: 1 }, intent(keyOf(RH, USDG, nonceOf(2)), RH, "8"), { type: "resolved_by_operator", key: keyOf(RH, USDG, nonceOf(2)), reason: "r", at: 1 }]),
      payToAllowlist: [PAYTO],
      clock: { now: () => NOW_MS },
      log: (e) => void events.push(e),
    });
    await f.start();
    expect(events.filter((e) => e["event"] === "gas_budget")).toEqual([{ event: "gas_budget", network: RH, capWei: (CAP + 5n).toString(), spentWei: "8" }]);
  });

  describe("旧形式の journal は起動しない（固定の文言）", () => {
    const k = keyOf(RH, USDG, nonceOf(1));
    const cases: ReadonlyArray<readonly [string, JournalRecord[]]> = [
      ["gas_cap_init の無い journal の submit_intent（ローカル版）", [intent(k, RH, "1")]],
      ["gas_cap_init が支払いの後", [intent(k, RH, "1"), capInit(RH, CAP)]],
      ["別の network の gas_cap_init だけ", [capInit(SEPOLIA, CAP), intent(k, RH, "1")]],
      ["submit_intent に gasReservedWei が無い", [capInit(RH, CAP), intent(k, RH, undefined)]],
      ["settled に gasUsedWei が無い", [capInit(RH, CAP), intent(k, RH, "1"), { type: "settled", key: k, hash: hashOf(1), blockNumber: "1", via: "receipt", at: 1 } as unknown as JournalRecord]],
      ["reverted に gasUsedWei が無い", [capInit(RH, CAP), intent(k, RH, "1"), { type: "reverted", key: k, hash: hashOf(1), via: "receipt", at: 1 } as unknown as JournalRecord]],
    ];
    test.each(cases)("%s", async (_name, records) => {
      const journal = fakeJournal(records);
      const h = await harness({ journal, start: false });
      let caught: unknown;
      try {
        await h.f.start();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StartupError);
      expect((caught as Error).message).toBe(OLD_FORMAT_MESSAGE);
      expect(journal.records).toEqual(records);
    });

    test.each([
      ["gas_cap_init が 2 つ", [capInit(RH, CAP), capInit(RH, CAP)]],
      ["gas_cap_init の前の gas_cap_raise", [capRaise(RH, 1n), capInit(RH, CAP)]],
    ] as const)("%s → journal_gas_cap_invalid", async (_name, records) => {
      const h = await harness({ journal: fakeJournal([...records]), start: false });
      await expect(h.f.start()).rejects.toThrow(/^journal_gas_cap_invalid$/);
    });

    test("ファイルの journal: 旧形式の行は load で StartupError（固定の文言）", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "evm-fac-old-"));
      try {
        const file = path.join(dir, "journal.ndjson");
        const old = { ...(intent(k, RH, undefined) as object) };
        writeFileSync(file, `${JSON.stringify(old)}\n`);
        const j = createFileJournal(file);
        await expect(j.load()).rejects.toThrow(OLD_FORMAT_MESSAGE);
        await expect(j.load()).rejects.toBeInstanceOf(StartupError);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("parseJournalLine の新しい欄の検査", () => {
    const line = (o: Record<string, unknown>) => JSON.stringify(o);
    const init = { type: "gas_cap_init", network: RH, capWei: "1000", at: 1 };
    const raise = { type: "gas_cap_raise", network: RH, addWei: "5", reason: "funded again", at: 1 };

    test("正しい gas_cap_init・gas_cap_raise は読める", () => {
      expect(parseJournalLine(line(init), 1)).toEqual(init);
      expect(parseJournalLine(line(raise), 1)).toEqual(raise);
      expect(parseJournalLine(line({ ...raise, reason: "x".repeat(MAX_REASON_LENGTH) }), 1)).toMatchObject({ type: "gas_cap_raise" });
    });

    test.each([
      ["capWei 0", { ...init, capWei: "0" }],
      ["capWei 先頭 0", { ...init, capWei: "01" }],
      ["capWei 指数", { ...init, capWei: "1e18" }],
      ["capWei 数値", { ...init, capWei: 1000 }],
      ["capWei 負", { ...init, capWei: "-1" }],
      ["capWei 79 桁", { ...init, capWei: "1".repeat(79) }],
      ["未知の network", { ...init, network: "eip155:84532" }],
      ["network が無い", { type: "gas_cap_init", capWei: "1", at: 1 }],
      ["余分な欄", { ...init, key: "k" }],
      ["at が無い", { type: "gas_cap_init", network: RH, capWei: "1" }],
      ["at が負", { ...init, at: -1 }],
      ["at が小数", { ...init, at: 1.5 }],
      ["addWei 0", { ...raise, addWei: "0" }],
      ["addWei 空", { ...raise, addWei: "" }],
      ["reason が空", { ...raise, reason: "" }],
      ["reason が空白だけ", { ...raise, reason: "   " }],
      ["reason に改行", { ...raise, reason: "a\nb" }],
      ["reason に制御文字", { ...raise, reason: "a\u0007b" }],
      ["reason に C1 制御文字", { ...raise, reason: "a\u0085b" }],
      ["reason に行の区切り", { ...raise, reason: "a b" }],
      ["reason が長すぎる", { ...raise, reason: "x".repeat(MAX_REASON_LENGTH + 1) }],
      ["reason が文字列でない", { ...raise, reason: 5 }],
      ["reason が無い", { type: "gas_cap_raise", network: RH, addWei: "5", at: 1 }],
    ])("%s → 例外", (_name, o) => {
      expect(() => parseJournalLine(line(o as Record<string, unknown>), 7)).toThrow(/journal line 7/);
    });

    test("submit_intent の gasReservedWei・settled/reverted の gasUsedWei: 無ければ旧形式、正規形の 10 進でなければ例外", () => {
      const si = { ...(intent("k", RH, "125000") as object) } as Record<string, unknown>;
      expect(parseJournalLine(line(si), 1)).toMatchObject({ gasReservedWei: "125000" });
      expect(parseJournalLine(line({ ...si, gasReservedWei: "0" }), 1)).toMatchObject({ gasReservedWei: "0" });
      const { gasReservedWei: _g, ...withoutGas } = si;
      expect(() => parseJournalLine(line(withoutGas), 1)).toThrow(StartupError);
      expect(() => parseJournalLine(line(withoutGas), 1)).toThrow(OLD_FORMAT_MESSAGE);
      for (const bad of ["01", "-1", "1.0", "0x10", 125000, ""]) expect(() => parseJournalLine(line({ ...si, gasReservedWei: bad }), 2)).toThrow(/malformed gasReservedWei/);
      const settled = { type: "settled", key: "k", hash: hashOf(1), blockNumber: "1", via: "receipt", gasUsedWei: "5", at: 1 };
      const reverted = { type: "reverted", key: "k", hash: hashOf(1), via: "receipt", gasUsedWei: "5", at: 1 };
      for (const r of [settled, reverted]) {
        expect(parseJournalLine(line(r), 1)).toEqual(r);
        const { gasUsedWei: _u, ...old } = r;
        expect(() => parseJournalLine(line(old), 1)).toThrow(OLD_FORMAT_MESSAGE);
        expect(() => parseJournalLine(line({ ...r, gasUsedWei: "007" }), 3)).toThrow(/malformed gasUsedWei/);
      }
      // 支払いの記録は key が必須のまま。
      expect(() => parseJournalLine(line({ type: "submitted", hash: hashOf(1), at: 1 }), 4)).toThrow(/not a facilitator record/);
    });

    test("ファイルの journal: 新しい記録を追記して読み戻せる", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "evm-fac-gas-"));
      try {
        const file = path.join(dir, "journal.ndjson");
        const j = createFileJournal(file);
        await j.load();
        const recs = [capInit(RH, CAP), capRaise(RH, 3n), intent("k", RH, "9")];
        for (const r of recs) await j.append(r);
        await j.close();
        const again = createFileJournal(file);
        expect(await again.load()).toEqual(recs);
        await again.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("H-1 §2.2 raise-cap（運用者の補充）", () => {
  let dir: string;
  let file: string;
  const out = () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { stdout, stderr, io: { stdout: (t: string) => void stdout.push(t), stderr: (t: string) => void stderr.push(t) } };
  };
  const writeJournal = (records: JournalRecord[]) => writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  const args = (network = RH, addWei = "5000", reason = "funded E-FAC again (tx on explorer)") => ["--network", network, "--add-wei", addWei, "--reason", reason];
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const setup = () => {
    dir = mkdtempSync(path.join(tmpdir(), "evm-fac-raise-"));
    file = path.join(dir, "journal.ndjson");
  };

  test("gas_cap_raise を fsync で追記し、1 行の JSON（有効な上限）を出す。env は EVM_FACILITATOR_JOURNAL だけを読む", async () => {
    setup();
    writeJournal([capInit(RH, CAP), capInit(SEPOLIA, 9n), capRaise(SEPOLIA, 1n)]);
    const read: string[] = [];
    const env = new Proxy(
      { EVM_FACILITATOR_JOURNAL: file, EVM_FACILITATOR_KEY: DUMMY_KEY, EVM_FACILITATOR_TOKEN: TOKEN },
      {
        get(target, prop, receiver) {
          if (typeof prop === "string") read.push(prop);
          return Reflect.get(target, prop, receiver) as unknown;
        },
      },
    ) as NodeJS.ProcessEnv;
    const o = out();
    expect(await runRaiseCap(args(RH, "5000"), env, o.io, { clock: { now: () => 123 } })).toBe(0);
    expect(o.stderr).toEqual([]);
    expect(o.stdout).toEqual([`${JSON.stringify({ event: "cap_raised", network: RH, addWei: "5000", effectiveCapWei: (CAP + 5000n).toString() })}\n`]);
    expect([...new Set(read)]).toEqual(["EVM_FACILITATOR_JOURNAL"]);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(JSON.parse(lines.at(-1)!)).toEqual({ type: "gas_cap_raise", network: RH, addWei: "5000", reason: "funded E-FAC again (tx on explorer)", at: 123 });
    // 2 回目は前の補充を足した上に足す。
    const o2 = out();
    expect(await runRaiseCap(args(RH, "7"), { EVM_FACILITATOR_JOURNAL: file }, o2.io)).toBe(0);
    expect(JSON.parse(o2.stdout[0]!)).toMatchObject({ effectiveCapWei: (CAP + 5007n).toString() });
    // 別の network の補充は混ざらない。
    const o3 = out();
    expect(await runRaiseCap(args(SEPOLIA, "2"), { EVM_FACILITATOR_JOURNAL: file }, o3.io)).toBe(0);
    expect(JSON.parse(o3.stdout[0]!)).toMatchObject({ network: SEPOLIA, effectiveCapWei: "12" });
    // facilitator の再生は同じ有効な上限になる（env は gas_cap_init と同じ値）。
    const records = readFileSync(file, "utf8").trim().split("\n").map((l, i) => parseJournalLine(l, i + 1));
    const h = await harness({ journal: fakeJournal(records), rh: fakeChain(USDG, CAP), sepolia: fakeChain(SEPOLIA_USDC, 9n) });
    expect(h.f.gasCap(RH)).toBe(CAP + 5007n);
    expect(h.f.gasCap(SEPOLIA)).toBe(12n);
    // lock ファイルは残る（消さない）。
    expect(existsSync(facilitatorLockPathOf(file))).toBe(true);
  });

  const BAD_ARGS: ReadonlyArray<readonly [string, string[]]> = [
    ["引数なし", []],
    ["理由が無い", ["--network", RH, "--add-wei", "5"]],
    ["理由が空", args(RH, "5", "")],
    ["理由が空白だけ", args(RH, "5", "  ")],
    ["理由に改行", args(RH, "5", "a\nb")],
    ["理由に制御文字", args(RH, "5", "a\u001bb")],
    ["理由が長すぎる", args(RH, "5", "x".repeat(MAX_REASON_LENGTH + 1))],
    ["add-wei 0", args(RH, "0")],
    ["add-wei 先頭 0", args(RH, "05")],
    ["add-wei 負", args(RH, "-5")],
    ["add-wei 数でない", args(RH, "abc")],
    ["未知の network", args("eip155:84532")],
    ["同じ flag を 2 回", ["--network", RH, "--network", RH, "--reason", "r"]],
    ["未知の flag", ["--network", RH, "--add-wei", "5", "--why", "r"]],
    ["余分な引数", [...args(), "--force"]],
  ];
  test.each(BAD_ARGS)("引数の誤り（%s）→ exit 1、固定の文言、journal は変わらない", async (_name, a) => {
    setup();
    writeJournal([capInit(RH, CAP)]);
    const before = readFileSync(file, "utf8");
    const o = out();
    expect(await runRaiseCap(a, { EVM_FACILITATOR_JOURNAL: file }, o.io)).toBe(1);
    expect(o.stderr).toEqual([`evm-facilitator: ${RAISE_CAP_USAGE}\n`]);
    expect(o.stdout).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("EVM_FACILITATOR_JOURNAL が無ければ exit 1", async () => {
    setup();
    const o = out();
    expect(await runRaiseCap(args(), {}, o.io)).toBe(1);
    expect(o.stderr).toEqual(["evm-facilitator: EVM_FACILITATOR_JOURNAL must be set\n"]);
  });

  test("その network の gas_cap_init が無い journal・journal が無い → 拒む（journal を作らない）", async () => {
    setup();
    writeJournal([capInit(SEPOLIA, CAP)]);
    const before = readFileSync(file, "utf8");
    const o = out();
    expect(await runRaiseCap(args(RH), { EVM_FACILITATOR_JOURNAL: file }, o.io)).toBe(1);
    expect(o.stderr).toEqual([`evm-facilitator: raise_cap_refused: the journal has no gas_cap_init for ${RH}\n`]);
    expect(readFileSync(file, "utf8")).toBe(before);
    const missing = path.join(dir, "none.ndjson");
    const o2 = out();
    expect(await runRaiseCap(args(RH), { EVM_FACILITATOR_JOURNAL: missing }, o2.io)).toBe(1);
    expect(o2.stderr[0]).toMatch(/^evm-facilitator: raise_cap_refused: /);
    expect(existsSync(missing)).toBe(false);
    const o3 = out();
    expect(await runRaiseCap(args(RH), { EVM_FACILITATOR_JOURNAL: path.join(dir, "nodir", "j.ndjson") }, o3.io)).toBe(1);
    expect(existsSync(path.join(dir, "nodir"))).toBe(false);
  });

  test("旧形式の journal には補充しない", async () => {
    setup();
    writeJournal([intent("k", RH, "1")]);
    const o = out();
    expect(await runRaiseCap(args(RH), { EVM_FACILITATOR_JOURNAL: file }, o.io)).toBe(1);
    expect(o.stderr).toEqual([`evm-facilitator: ${OLD_FORMAT_MESSAGE}\n`]);
  });

  test("lock が持たれている（facilitator が動いている）間は拒む: 実際の flock（同じ process の別の fd）と注入の lock", async () => {
    setup();
    writeJournal([capInit(RH, CAP)]);
    const before = readFileSync(file, "utf8");
    const held = acquireFacilitatorLock(facilitatorLockPathOf(file));
    try {
      const o = out();
      expect(await runRaiseCap(args(), { EVM_FACILITATOR_JOURNAL: file }, o.io)).toBe(1);
      expect(o.stderr).toEqual([`evm-facilitator: ${LOCKED_MESSAGE}\n`]);
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      held.release();
    }
    const o2 = out();
    const fake = () => {
      throw new StartupError(LOCKED_MESSAGE);
    };
    expect(await runRaiseCap(args(), { EVM_FACILITATOR_JOURNAL: file }, o2.io, { lock: fake })).toBe(1);
    expect(o2.stderr).toEqual([`evm-facilitator: ${LOCKED_MESSAGE}\n`]);
    expect(readFileSync(file, "utf8")).toBe(before);
    // 解放の後は通る。
    expect(await runRaiseCap(args(), { EVM_FACILITATOR_JOURNAL: file }, out().io)).toBe(0);
  });
});

describe("H-1 §2.3 単一の実行者の lock", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("lock のパスは journal と同じディレクトリの facilitator.lock", () => {
    expect(facilitatorLockPathOf("/app/runtime/evm-facilitator/journal.ndjson")).toBe("/app/runtime/evm-facilitator/facilitator.lock");
  });

  test.each(["EAGAIN", "EWOULDBLOCK", "EACCES"])("flock の %s は固定の文言で拒む。lock ファイルは消さない", (code) => {
    dir = mkdtempSync(path.join(tmpdir(), "evm-fac-lock-"));
    const lockPath = path.join(dir, "facilitator.lock");
    const flags: string[] = [];
    let caught: unknown;
    try {
      acquireFacilitatorLock(lockPath, (_fd, f) => {
        flags.push(f);
        throw Object.assign(new Error(`${code}: /secret/path`), { code });
      });
    } catch (error) {
      caught = error;
    }
    expect(flags).toEqual(["exnb"]);
    expect(caught).toBeInstanceOf(StartupError);
    expect((caught as Error).message).toBe(LOCKED_MESSAGE);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("flock のその他の失敗・開けない lock は lock_unavailable（下の層の文言を出さない）", () => {
    dir = mkdtempSync(path.join(tmpdir(), "evm-fac-lock-"));
    expect(() =>
      acquireFacilitatorLock(path.join(dir, "facilitator.lock"), () => {
        throw Object.assign(new Error("EIO /secret"), { code: "EIO" });
      }),
    ).toThrow(/^lock_unavailable$/);
    expect(() => acquireFacilitatorLock(path.join(dir, "missing", "facilitator.lock"))).toThrow(/^lock_unavailable$/);
  });

  test("実際の flock: 持っている間は 2 つ目が取れず、解放の後は取れる。中身は切り詰めない", () => {
    dir = mkdtempSync(path.join(tmpdir(), "evm-fac-lock-"));
    const lockPath = path.join(dir, "facilitator.lock");
    writeFileSync(lockPath, "keep");
    const first = acquireFacilitatorLock(lockPath);
    expect(() => acquireFacilitatorLock(lockPath)).toThrow(LOCKED_MESSAGE);
    first.release();
    first.release(); // 2 回目は何もしない
    const second = acquireFacilitatorLock(lockPath);
    second.release();
    expect(readFileSync(lockPath, "utf8")).toBe("keep");
  });

  describe("起動（main）: lock は journal より前、gas_cap_init は listen の前", () => {
    function envOf(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
      return {
        EVM_FACILITATOR_KEY: DUMMY_KEY,
        EVM_FACILITATOR_TOKEN: TOKEN,
        EVM_FACILITATOR_NETWORKS: RH,
        EVM_FACILITATOR_PAYTO_ALLOWLIST: PAYTO,
        EVM_FACILITATOR_GAS_CAP_46630: CAP.toString(),
        EVM_FACILITATOR_JOURNAL: path.join(dir, "evm-facilitator", "journal.ndjson"),
        EVM_FACILITATOR_PORT: "1",
        EVM_FACILITATOR_LOG: path.join(dir, "log.ndjson"),
        ...extra,
      };
    }
    // env の port は 1〜65535（0 の使い捨ては受けない）ので、起動ごとに別の高い port を使う（loopback・0.0.0.0 の bind だけ、外へは出ない）。
    let nextPort = 39_000 + Math.floor(Math.random() * 2_000);
    const portEnv = () => ({ EVM_FACILITATOR_PORT: String((nextPort += 1)) });
    const chainIoOf = (cap: bigint) => async () => fakeChain(USDG, cap).io;

    test("drain（タスク R-0）: listen 中の facilitator の drain は listener を閉じ、journal と lock を閉じて true（同じ lock を別の process が取れる）", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "evm-fac-main-"));
      const journalFile = envOf()["EVM_FACILITATOR_JOURNAL"]!;
      const running = await main(envOf(portEnv()), { stdout: () => {}, stderr: () => {} }, { chainIoOf: chainIoOf(CAP) });
      expect(running.server.listening).toBe(true);
      expect(await running.drain(5_000)).toBe(true);
      expect(running.server.listening).toBe(false);
      acquireFacilitatorLock(facilitatorLockPathOf(journalFile)).release();
    });

    test("最初の起動: gas_cap_init が listening の行より前に journal にあり、bind した host を出す。再起動で env の上限が違えば起動しない", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "evm-fac-main-"));
      const journalFile = envOf()["EVM_FACILITATOR_JOURNAL"]!;
      const lines: string[] = [];
      let journalAtListening = "";
      const running = await main(envOf({ ...portEnv(), EVM_FACILITATOR_BIND: "0.0.0.0" }), {
        stdout: (t) => {
          journalAtListening = readFileSync(journalFile, "utf8");
          lines.push(t);
        },
        stderr: (t) => void lines.push(t),
      }, { chainIoOf: chainIoOf(CAP) });
      try {
        expect(JSON.parse(journalAtListening.trim())).toMatchObject({ type: "gas_cap_init", network: RH, capWei: CAP.toString() });
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toMatchObject({ event: "listening", host: "0.0.0.0", port: running.port, networks: [RH], signer: SIGNER });
        expect(lines[0]).not.toContain(TOKEN);
        // 動いている間は 2 つ目の起動を lock で拒む（journal を読む前）。
        const o: string[] = [];
        expect(await runCli(envOf(portEnv()), { stdout: (t) => void o.push(t), stderr: (t) => void o.push(t) }, { chainIoOf: chainIoOf(CAP) })).toBe(1);
        expect(o).toEqual([`evm-facilitator: ${LOCKED_MESSAGE}\n`]);
        // log に有効な上限と累計（鍵・token なし）。
        let log = "";
        for (let i = 0; i < 50 && !log.includes("gas_budget"); i += 1) {
          await new Promise((r) => setTimeout(r, 20));
          log = existsSync(envOf()["EVM_FACILITATOR_LOG"]!) ? readFileSync(envOf()["EVM_FACILITATOR_LOG"]!, "utf8") : "";
        }
        expect(log).toContain(JSON.stringify({ event: "gas_budget", network: RH, capWei: CAP.toString(), spentWei: "0" }).slice(1, -1));
        for (const secret of [TOKEN, DUMMY_KEY, "5a5a5a"]) expect(log).not.toContain(secret);
      } finally {
        await running.close();
      }
      // 既定の bind は 127.0.0.1。
      const again: string[] = [];
      const second = await main(envOf(portEnv()), { stdout: (t) => void again.push(t), stderr: (t) => void again.push(t) }, { chainIoOf: chainIoOf(CAP) });
      await second.close();
      expect(JSON.parse(again[0]!)).toMatchObject({ event: "listening", host: "127.0.0.1" });
      expect(readFileSync(journalFile, "utf8").trim().split("\n")).toHaveLength(1);
      // env の上限を変えて再起動 → 起動しない（値は出さない）。失敗の後は lock を解く。
      const o: string[] = [];
      expect(await runCli(envOf({ ...portEnv(), EVM_FACILITATOR_GAS_CAP_46630: (CAP * 2n).toString() }), { stdout: (t) => void o.push(t), stderr: (t) => void o.push(t) }, { chainIoOf: chainIoOf(CAP * 2n) })).toBe(1);
      expect(o).toEqual([`evm-facilitator: gas_cap_env_mismatch:${RH}\n`]);
      acquireFacilitatorLock(facilitatorLockPathOf(journalFile)).release();
      expect(readFileSync(journalFile, "utf8").trim().split("\n")).toHaveLength(1);
    }, 30_000);

    test("lock が取れなければ journal を作らず・読まずに起動しない", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "evm-fac-main-"));
      const journalFile = envOf()["EVM_FACILITATOR_JOURNAL"]!;
      const order: string[] = [];
      const o: string[] = [];
      const code = await runCli(envOf(portEnv()), { stdout: (t) => void o.push(t), stderr: (t) => void o.push(t) }, {
        lock: () => {
          order.push(`lock journal-exists=${existsSync(journalFile)}`);
          throw new StartupError(LOCKED_MESSAGE);
        },
        chainIoOf: async () => {
          order.push("chain");
          return fakeChain(USDG, CAP).io;
        },
      });
      expect(code).toBe(1);
      expect(o).toEqual([`evm-facilitator: ${LOCKED_MESSAGE}\n`]);
      expect(order).toEqual(["lock journal-exists=false"]);
      expect(existsSync(journalFile)).toBe(false);
    });

    test("旧形式の journal のファイルでは起動しない（固定の文言）", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "evm-fac-main-"));
      const journalFile = envOf()["EVM_FACILITATOR_JOURNAL"]!;
      await createFileJournal(journalFile).load();
      writeFileSync(journalFile, `${JSON.stringify(intent("k", RH, undefined))}\n`);
      const o: string[] = [];
      expect(await runCli(envOf(portEnv()), { stdout: (t) => void o.push(t), stderr: (t) => void o.push(t) }, { chainIoOf: chainIoOf(CAP) })).toBe(1);
      expect(o).toEqual([`evm-facilitator: ${OLD_FORMAT_MESSAGE}\n`]);
    });
  });

  describe("実際の process（tsx の子）", () => {
    const tsxCli = path.resolve(import.meta.dirname, "../../node_modules/tsx/dist/cli.mjs");
    // tsx の CLI は script を孫の process で動かす（SIGSTOP・SIGKILL が lock を持つ process に届かない）。lock を持つ子は
    // node に tsx の loader を `--import` で載せて直接動かし、signal を送る pid = lock を持つ pid にする。
    const tsxLoader = pathToFileURL(path.resolve(import.meta.dirname, "../../node_modules/tsx/dist/loader.mjs")).href;
    const child = path.resolve(import.meta.dirname, "../fixtures/facilitator-lock-child.ts");
    const facilitatorCli = path.resolve(import.meta.dirname, "../../tools/evm-facilitator.ts");
    const holders: ChildProcess[] = [];
    afterEach(() => {
      for (const p of holders.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    });

    /** 子を起動し、最初の 1 行を待つ（`ACQUIRED` か `LOCKED …`）。 */
    function start(mode: "hold" | "try", lockPath: string): Promise<{ proc: ChildProcess; line: string }> {
      const proc = spawn(process.execPath, ["--import", tsxLoader, child, mode, lockPath], { stdio: ["ignore", "pipe", "pipe"] });
      holders.push(proc);
      return new Promise((resolve, reject) => {
        let buf = "";
        proc.stdout!.on("data", (d: Buffer) => {
          buf += d.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl >= 0) resolve({ proc, line: buf.slice(0, nl) });
        });
        proc.on("error", reject);
        proc.on("exit", () => {
          if (!buf.includes("\n")) reject(new Error(`child exited without output: ${buf}`));
        });
      });
    }
    function exited(proc: ChildProcess): Promise<void> {
      return proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : new Promise((r) => proc.once("exit", () => r()));
    }
    function raiseCapProcess(journal: string): Promise<{ code: number; stdout: string; stderr: string }> {
      return new Promise((resolve) => {
        execFile(process.execPath, [tsxCli, facilitatorCli, "raise-cap", "--network", RH, "--add-wei", "5", "--reason", "funded again"], { env: { EVM_FACILITATOR_JOURNAL: journal } }, (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : -1, stdout, stderr });
        });
      });
    }

    test("同時の 2 起動は 1 つだけ取る。SIGSTOP の holder も持ったまま（奪取なし）、raise-cap も拒む。SIGKILL の後は取れる。lock ファイルは残る", async () => {
      dir = mkdtempSync(path.join(tmpdir(), "evm-fac-proc-"));
      const journal = path.join(dir, "journal.ndjson");
      writeFileSync(journal, `${JSON.stringify(capInit(RH, CAP))}\n`);
      const lockPath = facilitatorLockPathOf(journal);
      const [a, b] = await Promise.all([start("hold", lockPath), start("hold", lockPath)]);
      const lines = [a.line, b.line].sort();
      expect(lines).toEqual(["ACQUIRED", `LOCKED ${LOCKED_MESSAGE}`]);
      const holder = a.line === "ACQUIRED" ? a.proc : b.proc;
      const loser = a.line === "ACQUIRED" ? b.proc : a.proc;
      await exited(loser);
      expect(loser.exitCode).toBe(3);

      // 動いている holder の間: 3 つ目も raise-cap も拒む。
      expect((await start("try", lockPath)).line).toBe(`LOCKED ${LOCKED_MESSAGE}`);
      const before = readFileSync(journal, "utf8");
      const refused = await raiseCapProcess(journal);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toBe(`evm-facilitator: ${LOCKED_MESSAGE}\n`);
      expect(readFileSync(journal, "utf8")).toBe(before);

      // 止めた（SIGSTOP）holder: 第 1 版の設計の奪取の閾値（30 秒）を越えて待っても後継は取れない（heartbeat・奪取が無い。Codex H-1 #1）。
      holder.kill("SIGSTOP");
      await new Promise((r) => setTimeout(r, 31_000));
      expect((await start("try", lockPath)).line).toBe(`LOCKED ${LOCKED_MESSAGE}`);
      expect((await raiseCapProcess(journal)).code).toBe(1);

      // SIGKILL（止まったままでも効く）で kernel が lock を解く。
      holder.kill("SIGKILL");
      await exited(holder);
      expect((await start("try", lockPath)).line).toBe("ACQUIRED");
      expect(existsSync(lockPath)).toBe(true);
      const ok = await raiseCapProcess(journal);
      expect(ok.code).toBe(0);
      expect(JSON.parse(ok.stdout)).toEqual({ event: "cap_raised", network: RH, addWei: "5", effectiveCapWei: (CAP + 5n).toString() });
    }, 90_000);
  });
});

describe("graceful drain（タスク R-0）", () => {
  test("送出の結果が期限の後に返る: 応答（send_outcome_unknown）の後も drain は 0 にならず、遅れた hash を journal に書いてから 0。drain の後の要求は 503 draining", async () => {
    const h = await harness();
    let resolveSend!: (hash: Hex) => void;
    h.rh.send = () => new Promise<Hex>((resolve) => (resolveSend = resolve));
    const pending = h.settle(body());
    await flush();
    expect(h.rh.writes).toHaveLength(1);
    // 送出の結果を待つ期限を過ぎる → 要求は返る（送出したかもしれない）。
    await h.advance(600_000);
    const res = await pending;
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).toContain("send_outcome_unknown");
    expect(paymentTypes(h.journal)).toEqual(["submit_intent"]);
    h.f.drain.close();
    // 要求は返ったが、遅れた送出の続きが残っている。
    expect(h.f.drain.outstanding()).toBe(1);
    let idle: boolean | undefined;
    void h.f.drain.idle(10_000).then((value) => (idle = value));
    await flush();
    expect(idle).toBeUndefined();
    // drain の後の要求は断る（送出しない）。
    expect(await h.settle(body({ nonce: nonceOf(2) }))).toEqual({ status: 503, body: { error: "draining" } });
    expect(h.rh.writes).toHaveLength(1);
    // 遅れて hash が返る → journal に書き終えてから 0。
    resolveSend(hashOf(9));
    await flush();
    expect(payments(h.journal).at(-1)).toMatchObject({ type: "submitted", hash: hashOf(9) });
    expect(idle).toBe(true);
    expect(h.f.drain.outstanding()).toBe(0);
  });

  test("締め切りで見捨てた journal の書き込み（journal_timeout の応答の後も続く）も drain の数に入り、書き終えてから 0", async () => {
    const journal = fakeJournal();
    const h = await harness({ journal });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    journal.before = async (record) => {
      if (record.type === "submit_intent") await gate;
    };
    const pending = h.settle(body());
    await flush();
    await h.advance(600_000);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(JSON.stringify(res.body)).toContain("journal_timeout");
    h.f.drain.close();
    expect(h.f.drain.outstanding()).toBe(1);
    let idle: boolean | undefined;
    void h.f.drain.idle(10_000).then((value) => (idle = value));
    await flush();
    expect(idle).toBeUndefined();
    release();
    await flush();
    expect(paymentTypes(journal)).toEqual(["submit_intent"]);
    expect(idle).toBe(true);
    // 送出はしていない（意図の行の書き込みが締め切りに間に合わなかった）。
    expect(h.rh.writes).toHaveLength(0);
  });

  test("進行中の要求が無ければ idle はすぐ true。上限に達すれば false", async () => {
    const h = await harness();
    expect(await h.f.drain.idle(10)).toBe(true);
    h.rh.send = () => new Promise<Hex>(() => {});
    void h.settle(body());
    await flush();
    expect(h.f.drain.outstanding()).toBe(1);
    expect(await h.f.drain.idle(50)).toBe(false);
  });
});

describe("drainStopperOf（タスク R-0: CLI の SIGTERM の handler）", () => {
  test.each([
    [true, "facilitator drain: complete\n", 0],
    [false, "facilitator drain: timeout\n", 1],
  ] as const)("drain の結果 %s → 固定の 1 行と exit code。2 回目の signal は何もしない。上限は渡した値", async (complete, line, code) => {
    const calls: number[] = [];
    const lines: string[] = [];
    const exits: number[] = [];
    const stop = drainStopperOf({ drain: async (ms) => (calls.push(ms), complete) }, 1234, (l) => void lines.push(l), (c) => void exits.push(c));
    stop();
    stop();
    await flush();
    expect(calls).toEqual([1234]);
    expect(lines).toEqual([line]);
    expect(exits).toEqual([code]);
  });

  test("drain が失敗（throw）→ timeout の行と exit 1", async () => {
    const lines: string[] = [];
    const exits: number[] = [];
    drainStopperOf({ drain: async () => Promise.reject(new Error("x")) }, 1, (l) => void lines.push(l), (c) => void exits.push(c))();
    await flush();
    expect(lines).toEqual(["facilitator drain: timeout\n"]);
    expect(exits).toEqual([1]);
  });
});
