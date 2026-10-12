/**
 * 自前の EVM facilitator（`tools/evm-facilitator.ts`。設計 `docs/evm-testnets-x402-design.md` §3.3、AC-E3）。
 * chain の I/O・journal・時計は注入の fake で、網には出ない（loopback の node:http だけ 1 つ）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { toEventSelector } from "viem";
import { afterEach, describe, expect, test } from "vitest";

import {
  AUTHORIZATION_USED_TOPIC,
  createEvmFacilitator,
  createFileJournal,
  listenFacilitator,
  parseJournalLine,
  runCli,
  TRANSFER_TOPIC,
  type JournalFs,
  type SetTimer,
  type AuthorizationUsedLog,
  type ChainIo,
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
    io: undefined as unknown as ChainIo,
  };
  const keyOf = (from: string, nonce: string) => `${from.toLowerCase()}|${nonce.toLowerCase()}`;
  self.io = {
    maxLogRange: 500n,
    maxFeePerGas: 10n * GWEI,
    gasCap,
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
    expect(h.journal.records).toEqual([]);
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
    // 最悪値 = 200,000 × 1 gwei = 2e14。上限 2.5e14。1 回目の実費 = 100,000 × 1 gwei = 1e14。
    const rh = fakeChain(USDG, 250_000n * GWEI);
    const h = await harness({ rh });
    expect((await h.settle(body({ nonce: nonceOf(1) }))).status).toBe(200);
    expect(h.f.gasSpent(RH)).toBe(100_000n * GWEI);
    const second = await h.settle(body({ nonce: nonceOf(2) }));
    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ errorReason: "gas_cap_reached" });
    expect(h.rh.writes).toHaveLength(1);
    expect(h.rh.writes[0]).toMatchObject({ gas: 200_000n, maxFeePerGas: GWEI });
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
    expect(events).toEqual(["journal:submit_intent", "write", "journal:submitted", "journal:settled"]);
    expect(h.rh.writes[0]).toMatchObject({ asset: USDG, from: FROM, to: PAYTO, value: 10_000n, nonce: nonceOf(1) });
  });

  test("送出前の失敗（SDK の verify が無効、chain で未使用）→ 400、送出なし", async () => {
    const h = await harness();
    h.rh.verify = async () => ({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature" });
    const res = await h.settle(body());
    expect(res.status).toBe(400);
    expect(h.rh.writes).toHaveLength(0);
    expect(h.journal.records).toEqual([]);
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
    expect(h.journal.records.map((r) => r.type)).toEqual(["submit_intent", "submitted", "reverted"]);
  });

  test("Transfer の不一致（宛先・金額・2 つ）→ 5xx、未解決のまま保留", async () => {
    for (const receipt of [okReceipt(USDG, OTHER), okReceipt(USDG, PAYTO, 9_999n), { ...okReceipt(USDG), logs: [...okReceipt(USDG).logs, ...okReceipt(USDG).logs] }, okReceipt(SEPOLIA_USDC)]) {
      const h = await harness();
      h.rh.wait = async () => receipt;
      const res = await h.settle(body());
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(h.f.heldNetworks()).toEqual([RH]);
      expect(h.journal.records.map((r) => r.type)).toEqual(["submit_intent", "submitted"]);
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
    expect(h.journal.records.map((r) => r.type)).toEqual(["submit_intent", "aborted_before_send"]);
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
    expect(journal.records.map((r) => r.type)).toEqual(["submit_intent"]);

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
    expect(journal.records.map((r) => r.type)).toEqual(["submit_intent", "submitted"]);

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
      (h.rh.io as { gasCap: bigint }).gasCap = 1n;
      h.rh.io.reader.feesPerGas = async () => {
        markUsedOn(h.rh, withTx);
        return { maxFeePerGas: GWEI, maxPriorityFeePerGas: 1n };
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
    expect(h.journal.records.map((r) => r.type)).toEqual(["submit_intent", "aborted_before_send"]);
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
    expect(h.journal.records.map((r) => r.type)).toEqual(["submit_intent"]);
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
