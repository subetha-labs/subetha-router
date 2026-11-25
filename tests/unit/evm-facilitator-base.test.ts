/**
 * Base Sepolia を自前の facilitator で扱う部分（`docs/base-sepolia-facilitator-design.md` §2、AC-B3・B4・B6）。
 * chain の I/O・journal・時計・timer は注入の fake（網には出ない）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  cliConfigOf,
  createEvmFacilitator,
  createFileJournal,
  L1_FEE_RESERVE_WEI,
  l1FeeWeiOf,
  main,
  parseJournalLine,
  RECOVERY_INTERVAL_MS,
  RECOVERY_MAX_ROUNDS,
  TRANSFER_TOPIC,
  type AuthorizationUsedLog,
  type ChainIo,
  type EvmFacilitator,
  type FacilitatorJournal,
  type FacilitatorResponse,
  type Hex,
  type JournalRecord,
  type ReceiptView,
  type SetTimer,
  type TransferWithAuthorizationArgs,
} from "../../tools/evm-facilitator.js";
import { BASE_SEPOLIA_NETWORK, SELF_FACILITATOR_NETWORKS } from "../../src/shared/self-facilitator.js";
import { EVM_TESTNET_NETWORKS } from "../../src/shared/networks.js";

const BASE = "eip155:84532";
const RH = "eip155:46630";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ZUSDC = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F";
const PAYTO = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
const BASE_PROVIDER = "0x901404CCf8A4e61050fc3CAe4A26b05fDc136fE1";
const ROUTER = "0x00000000000000000000000000000000000000cc";
const FROM = "0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1";
const SIGNER = "0x54633d372d7316435891EEBBaAB90861F8c1Dadc" as Hex;
const TOKEN = "t".repeat(40);
const PORT = 8611;
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;
const LATEST = 1_000_000n;
const FEE = 7_000_000n;
const L1 = L1_FEE_RESERVE_WEI[BASE]!;
/** 見積り 88,000 × 1.25 = 110,000。 */
const GAS_LIMIT = 110_000n;
const RESERVE = GAS_LIMIT * FEE + L1;

const nonceOf = (i: number): Hex => `0x${i.toString(16).padStart(64, "0")}`;
const hashOf = (i: number): Hex => `0x${(0xabc000 + i).toString(16).padStart(64, "0")}`;
const topicOf = (a: string): string => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const keyOf = (network: string, asset: string, nonce: Hex): string => [network, asset.toLowerCase(), FROM.toLowerCase(), nonce].join("|");

function receiptOf(o: { asset?: string; to?: string; value?: bigint; l1FeeWei?: bigint; status?: "success" | "reverted" } = {}): ReceiptView {
  const asset = o.asset ?? USDC;
  return {
    status: o.status ?? "success",
    blockNumber: LATEST,
    gasUsed: 86_000n,
    effectiveGasPrice: FEE,
    ...(o.l1FeeWei === undefined ? {} : { l1FeeWei: o.l1FeeWei }),
    logs: [{ address: asset, topics: [TRANSFER_TOPIC, topicOf(FROM), topicOf(o.to ?? BASE_PROVIDER)], data: `0x${(o.value ?? 10_000n).toString(16).padStart(64, "0")}` }],
  };
}

function body(o: { network?: string; asset?: string; nonce?: Hex; payTo?: string; domain?: { name: string; version: string }; extraAccepted?: Record<string, unknown> } = {}): Record<string, unknown> {
  const network = o.network ?? BASE;
  const asset = o.asset ?? (network === BASE ? USDC : USDG);
  const payTo = o.payTo ?? (network === BASE ? BASE_PROVIDER : PAYTO);
  const requirements = { scheme: "exact", network, asset, amount: "10000", payTo, maxTimeoutSeconds: 60, extra: o.domain ?? (network === BASE ? { name: "USDC", version: "2" } : { name: "Global Dollar", version: "1" }) };
  const authorization = { from: FROM, to: payTo, value: "10000", validAfter: "0", validBefore: String(NOW_S + 3_000), nonce: o.nonce ?? nonceOf(1) };
  return { x402Version: 2, paymentPayload: { x402Version: 2, accepted: { ...requirements, ...(o.extraAccepted ?? {}) }, payload: { authorization, signature: `0x${"11".repeat(65)}` } }, paymentRequirements: requirements };
}

interface Chain {
  io: ChainIo;
  calls: string[];
  writes: TransferWithAuthorizationArgs[];
  used: Set<string>;
  usedLogs: AuthorizationUsedLog[];
  receipts: Map<string, ReceiptView>;
  balance: () => Promise<bigint>;
  fee: bigint;
  send: (n: number) => Promise<Hex>;
  wait: (hash: Hex) => Promise<ReceiptView | undefined>;
  check: () => Promise<boolean>;
}

function chain(network: string, o: { gasCap?: bigint; lazy?: boolean } = {}): Chain {
  const c: Chain = {
    calls: [],
    writes: [],
    used: new Set(),
    usedLogs: [],
    receipts: new Map(),
    balance: async () => 10n ** 18n,
    fee: FEE,
    send: async (n) => hashOf(n),
    wait: async (hash) => c.receipts.get(hash) ?? receiptOf(network === BASE ? { l1FeeWei: 11_000_000_000n } : { asset: USDG, to: PAYTO }),
    check: async () => true,
    io: undefined as unknown as ChainIo,
  };
  const log = <T>(name: string, v: T): T => {
    c.calls.push(name);
    return v;
  };
  c.io = {
    maxLogRange: 5_000n,
    maxFeePerGas: 1_000_000_000n,
    gasCap: o.gasCap ?? 10n ** 16n,
    maxSettleGas: 200_000n,
    reader: {
      authorizationState: async (_a, _f, nonce) => log("authorizationState", c.used.has(nonce)),
      blockNumber: async () => log("blockNumber", LATEST),
      // 0.2 秒/block（1 秒に 5 block が同じ時刻）。
      blockTimestamp: async (n) => log("blockTimestamp", NOW_S - Number((LATEST - n) / 5n)),
      authorizationUsedLogs: async (_a, _f, _n, from, to) => log("getLogs", c.usedLogs.filter((l) => l.blockNumber >= from && l.blockNumber <= to)),
      receipt: async (hash) => log("receipt", c.receipts.get(hash)),
      waitForReceipt: async (hash) => {
        c.calls.push("waitForReceipt");
        return await c.wait(hash);
      },
      feesPerGas: async () => log("feesPerGas", { maxFeePerGas: c.fee, maxPriorityFeePerGas: 1n }),
      estimateTransferGas: async () => log("estimateGas", 88_000n),
      nativeBalance: async () => {
        c.calls.push("balance");
        return await c.balance();
      },
    },
    writer: {
      address: SIGNER,
      transferWithAuthorization: async (args) => {
        c.calls.push("write");
        c.writes.push(args);
        return await c.send(c.writes.length);
      },
    },
    verify: async () => {
      c.calls.push("sdkVerify");
      return { isValid: true, payer: FROM };
    },
    ...(o.lazy === true
      ? {
          chainCheck: async () => {
            c.calls.push("chainId");
            return await c.check();
          },
        }
      : {}),
  };
  return c;
}

interface FakeJournal extends FacilitatorJournal {
  records: JournalRecord[];
  before?: (record: JournalRecord) => Promise<void> | void;
}
function fakeJournal(initial: readonly JournalRecord[] = []): FakeJournal {
  const j: FakeJournal = {
    records: [...initial],
    load: async () => [...j.records],
    append: async (record) => {
      await j.before?.(record);
      j.records.push(record);
    },
  };
  return j;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await new Promise<void>((r) => setImmediate(r));
}

interface Harness {
  f: EvmFacilitator;
  base: Chain;
  rh: Chain;
  journal: FakeJournal;
  events: Array<Readonly<Record<string, unknown>>>;
  clock: { t: number; now(): number };
  advance(ms: number): Promise<void>;
  settle(b: unknown): Promise<FacilitatorResponse>;
  verify(b: unknown): Promise<FacilitatorResponse>;
  ready(): Promise<FacilitatorResponse>;
  pendingTimers(): number;
}

async function harness(o: { base?: Chain; rh?: Chain; journal?: FakeJournal; networks?: readonly string[] } = {}): Promise<Harness> {
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
    const end = clock.t + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      timers.splice(timers.indexOf(due), 1);
      clock.t = Math.max(clock.t, due.at);
      due.fn();
      await flush();
    }
    clock.t = end;
    await flush();
  };
  const base = o.base ?? chain(BASE);
  const rh = o.rh ?? chain(RH);
  const journal = o.journal ?? fakeJournal();
  const events: Array<Readonly<Record<string, unknown>>> = [];
  const networks = o.networks ?? [RH, BASE];
  const f = createEvmFacilitator({
    networks,
    chains: new Map([[RH, rh.io], [BASE, base.io]]),
    journal,
    payToAllowlist: [ROUTER, PAYTO],
    ...(networks.includes(BASE) ? { payToAllowlistByNetwork: new Map([[BASE, [ROUTER, BASE_PROVIDER]]]) } : {}),
    clock,
    timer,
    log: (e) => void events.push(e),
  });
  await f.start();
  await flush();
  const guard = { token: TOKEN, port: () => PORT };
  const post = (op: string, b: unknown) => f.handle({ method: "POST", url: `/${TOKEN}/${op}`, headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" }, body: JSON.stringify(b) }, guard);
  return {
    f, base, rh, journal, events, clock, advance,
    settle: (b) => post("settle", b),
    verify: (b) => post("verify", b),
    ready: () => f.handle({ method: "GET", url: `/${TOKEN}/ready`, headers: { host: `127.0.0.1:${PORT}` }, body: "" }, guard),
    pendingTimers: () => timers.length,
  };
}

const types = (j: FakeJournal): string[] => j.records.filter((r) => r.type !== "gas_cap_init").map((r) => r.type);
const gasUsed = (j: FakeJournal): string[] => j.records.flatMap((r) => ("gasUsedWei" in r ? [r.gasUsedWei] : []));
const isReady = async (h: Harness): Promise<boolean> => (((await h.ready()).body as { networks: Record<string, { ready: boolean }> }).networks[BASE]!).ready;

/** 空いている loopback の port。 */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** 未解決の意図の行（既定は hash 付き）。 */
function unresolved(i: number, hash?: Hex): JournalRecord[] {
  const key = keyOf(BASE, USDC, nonceOf(i));
  return [
    { type: "submit_intent", key, fingerprint: "sha256:x", network: BASE, asset: USDC, from: FROM, to: BASE_PROVIDER, value: "10000", nonce: nonceOf(i), validAfter: "0", validBefore: String(NOW_S + 3_000), gasReservedWei: RESERVE.toString(), at: 1 },
    ...(hash === undefined ? [] : [{ type: "submitted", key, hash, at: 2 } as const]),
  ];
}
const INIT: JournalRecord[] = [RH, BASE].map((network) => ({ type: "gas_cap_init", network, capWei: (10n ** 16n).toString(), at: 0 }));

describe("network と資産（§2.1）", () => {
  test("SELF_FACILITATOR_NETWORKS は EVM testnet 4 つ + Base Sepolia。EVM_TESTNET_NETWORKS は Base を含まない", () => {
    expect([...SELF_FACILITATOR_NETWORKS].sort()).toEqual([...EVM_TESTNET_NETWORKS, BASE].sort());
    expect(EVM_TESTNET_NETWORKS.has(BASE)).toBe(false);
    expect(BASE_SEPOLIA_NETWORK).toBe(BASE);
  });

  test("Base の USDC を settle し、/supported に載る", async () => {
    const h = await harness();
    expect(await h.settle(body())).toEqual({ status: 200, body: { success: true, transaction: hashOf(1), network: BASE, payer: FROM } });
    expect(types(h.journal)).toEqual(["submit_intent", "submitted", "settled"]);
  });

  test("zUSDC（subetha-exact 専用）は受けない。RPC・SDK・送出 0 回", async () => {
    const h = await harness();
    for (const res of [await h.settle(body({ asset: ZUSDC, domain: { name: "zERC20 USD Coin", version: "1" } })), await h.verify(body({ asset: ZUSDC, domain: { name: "zERC20 USD Coin", version: "1" } }))]) expect(res.status).toBe(400);
    expect(h.base.calls).toEqual([]);
  });

  test("照合: 0.2 秒/block でも締め切りの内の回数で見つかる（窓の端・log の回数の上限）", async () => {
    const h = await harness();
    h.base.used.add(nonceOf(1));
    // 最新から約 55 分前の block（窓 3,600 秒の内側）。
    h.base.usedLogs = [{ transactionHash: hashOf(7), blockNumber: LATEST - 1_000n }];
    h.base.receipts.set(hashOf(7), receiptOf());
    const res = await h.settle(body());
    expect(res.status).toBe(200);
    expect(h.base.calls.filter((c) => c === "getLogs").length).toBeLessThanOrEqual(6);
    expect(h.base.calls.length).toBeLessThan(40);
    expect(h.base.writes).toEqual([]);
  });

  test("照合: 見つからなければ 5xx（getLogs は窓の分だけ）", async () => {
    const h = await harness();
    h.base.used.add(nonceOf(1));
    const b = body();
    (b["paymentPayload"] as { payload: { authorization: Record<string, string> } }).payload.authorization["validBefore"] = String(NOW_S);
    const res = await h.settle(b);
    expect(res.status).toBe(500);
    expect(h.base.calls.filter((c) => c === "getLogs").length).toBeLessThanOrEqual(6);
  });
});

describe("network ごとの allowlist（§2.5）", () => {
  test("Base の Provider の受取先は Base だけ。新 3 の受取先は Base では断る。Router の受取先は両方", async () => {
    const h = await harness();
    expect((await h.settle(body({ network: RH, payTo: BASE_PROVIDER }))).body).toMatchObject({ errorReason: "recipient_not_allowed" });
    expect((await h.settle(body({ payTo: PAYTO }))).body).toMatchObject({ errorReason: "recipient_not_allowed" });
    h.base.wait = async () => receiptOf({ to: ROUTER });
    h.rh.wait = async () => receiptOf({ asset: USDG, to: ROUTER });
    expect((await h.settle(body({ payTo: ROUTER, nonce: nonceOf(3) }))).status).toBe(200);
    expect((await h.settle(body({ network: RH, payTo: ROUTER, nonce: nonceOf(4) }))).status).toBe(200);
  });

  test("有効でない network・空・形違いの一覧は作れない", () => {
    const base = { networks: [RH], chains: new Map([[RH, chain(RH).io]]), journal: fakeJournal(), payToAllowlist: [PAYTO] };
    for (const list of [new Map([[BASE, [PAYTO]]]), new Map([[RH, []]]), new Map([[RH, ["0x12"]]])]) expect(() => createEvmFacilitator({ ...base, payToAllowlistByNetwork: list })).toThrow(/allowlist/);
  });

  test("CLI: EVM_FACILITATOR_PAYTO_ALLOWLIST_<chainId>", () => {
    const env = {
      EVM_FACILITATOR_KEY: `0x${"11".repeat(32)}`, EVM_FACILITATOR_TOKEN: TOKEN, EVM_FACILITATOR_NETWORKS: `${RH},${BASE}`, EVM_FACILITATOR_PAYTO_ALLOWLIST: PAYTO,
      EVM_FACILITATOR_GAS_CAP_46630: "1", EVM_FACILITATOR_GAS_CAP_84532: "2", EVM_FACILITATOR_JOURNAL: "/x/journal.ndjson",
    };
    expect(cliConfigOf(env).payToAllowlistByNetwork.size).toBe(0);
    const c = cliConfigOf({ ...env, EVM_FACILITATOR_PAYTO_ALLOWLIST_84532: `${ROUTER},${BASE_PROVIDER}` });
    expect([...c.payToAllowlistByNetwork]).toEqual([[BASE, [ROUTER, BASE_PROVIDER]]]);
    expect(c.payToAllowlist).toEqual([PAYTO]);
    expect(c.rpcUrls.get(BASE)).toBe("https://base-sepolia-rpc.publicnode.com");
    expect(c.logRanges.get(BASE)).toBe(5_000n);
    for (const bad of [" ,", "0x12", `${ROUTER},zz`]) expect(() => cliConfigOf({ ...env, EVM_FACILITATOR_PAYTO_ALLOWLIST_84532: bad })).toThrow("EVM_FACILITATOR_PAYTO_ALLOWLIST_84532 must list EVM addresses");
  });
});

describe("L1 の手数料（§2.2）", () => {
  test("予約 = L2 の最悪値 + L1 の予約、実費 = L2 + receipt の L1。再起動で同じ累計", async () => {
    const h = await harness();
    await h.settle(body());
    expect(h.journal.records.find((r) => r.type === "submit_intent")).toMatchObject({ gasReservedWei: RESERVE.toString() });
    const actual = 86_000n * FEE + 11_000_000_000n;
    expect(gasUsed(h.journal)).toEqual([actual.toString()]);
    expect(h.f.gasSpent(BASE)).toBe(actual);
    expect((await harness({ journal: fakeJournal(h.journal.records) })).f.gasSpent(BASE)).toBe(actual);
  });

  test("L1 の実費が予約を超えれば実費を数える。欄が無ければ予約を数える（revert も同じ）", async () => {
    const h = await harness();
    h.base.wait = async () => receiptOf({ l1FeeWei: L1 * 5n });
    await h.settle(body());
    expect(h.f.gasSpent(BASE)).toBe(86_000n * FEE + L1 * 5n);
    h.base.wait = async () => receiptOf({ status: "reverted" });
    await h.settle(body({ nonce: nonceOf(2) }));
    expect(h.f.gasSpent(BASE)).toBe(2n * 86_000n * FEE + L1 * 6n);
    expect((await harness({ journal: fakeJournal(h.journal.records) })).f.gasSpent(BASE)).toBe(h.f.gasSpent(BASE));
  });

  test("新 3 は L1 を数えない（receipt に欄があっても今と同じ値）", async () => {
    const h = await harness();
    h.rh.wait = async () => ({ ...receiptOf({ asset: USDG, to: PAYTO }), l1FeeWei: 999n });
    await h.settle(body({ network: RH }));
    expect(h.f.gasSpent(RH)).toBe(86_000n * FEE);
    expect(h.journal.records.find((r) => r.type === "submit_intent")).toMatchObject({ gasReservedWei: (GAS_LIMIT * FEE).toString() });
    expect(h.rh.calls).not.toContain("balance");
  });

  test("累計の上限は L1 の予約を含めて見る（ちょうどは通り、1 wei 足りなければ 400 で送出なし）", async () => {
    const ok = await harness({ base: chain(BASE, { gasCap: RESERVE }) });
    expect((await ok.settle(body())).status).toBe(200);
    const no = await harness({ base: chain(BASE, { gasCap: RESERVE - 1n }) });
    expect((await no.settle(body())).body).toMatchObject({ errorReason: "gas_cap_reached" });
    expect(no.base.writes).toEqual([]);
  });

  test.each([
    [{ l1Fee: "0x2a7c8a5ff" }, 0x2a7c8a5ffn],
    [{ l1Fee: 5n }, 5n],
    [{ l1Fee: "0x0" }, 0n],
    [{}, undefined],
    [{ l1Fee: null }, undefined],
    [{ l1Fee: "11" }, undefined],
    [{ l1Fee: 11 }, undefined],
    [{ l1Fee: -1n }, undefined],
    [{ l1Fee: `0x${"1".repeat(65)}` }, undefined],
    [null, undefined],
  ])("l1FeeWeiOf(%o)", (receipt, expected) => {
    expect(l1FeeWeiOf(receipt)).toBe(expected);
  });
});

describe("残高の検査（§2.3）", () => {
  test("ちょうど予約なら送る。1 wei 足りなければ送らず 400（保留しない・意図を書かない）", async () => {
    const h = await harness();
    h.base.balance = async () => RESERVE - 1n;
    expect((await h.settle(body())).body).toMatchObject({ success: false, errorReason: "gas_balance_low" });
    expect(h.f.heldNetworks()).toEqual([]);
    expect(types(h.journal)).toEqual([]);
    h.base.balance = async () => RESERVE;
    expect((await h.settle(body())).status).toBe(200);
  });

  test.each([
    ["読めない", (c: Chain) => void (c.balance = () => Promise.reject(new Error("rpc")))],
    ["reader が持たない", (c: Chain) => void (c.io = { ...c.io, reader: { ...c.io.reader, nativeBalance: undefined as never } })],
  ])("残高を%sなら送らず 400 gas_balance_unavailable", async (_n, set) => {
    const c = chain(BASE);
    set(c);
    const h = await harness({ base: c });
    expect((await h.settle(body())).body).toMatchObject({ errorReason: "gas_balance_unavailable" });
    expect(c.writes).toEqual([]);
    expect(types(h.journal)).toEqual([]);
  });

  test("残高が足りない間に他で使われていれば 400 にしない", async () => {
    const h = await harness();
    h.base.balance = async () => {
      h.base.used.add(nonceOf(1));
      return 0n;
    };
    expect((await h.settle(body())).status).toBe(500);
    expect(h.base.writes).toEqual([]);
  });
});

describe("準備（/ready・/verify。§2.3）", () => {
  const READY_MIN = 20n * (200_000n * FEE + L1);

  test("/ready は Base だけ。理由・残高・累計を返さない。token・method・path の検査は同じ", async () => {
    const h = await harness();
    expect(await h.ready()).toEqual({ status: 200, body: { networks: { [BASE]: { ready: true } } } });
    const guard = { token: TOKEN, port: () => PORT };
    const host = { host: `127.0.0.1:${PORT}` };
    expect((await h.f.handle({ method: "POST", url: `/${TOKEN}/ready`, headers: host, body: "" }, guard)).status).toBe(405);
    expect((await h.f.handle({ method: "GET", url: `/${"x".repeat(40)}/ready`, headers: host, body: "" }, guard)).status).toBe(404);
    expect((await h.f.handle({ method: "GET", url: `/${TOKEN}/ready?x=1`, headers: host, body: "" }, guard)).status).toBe(404);
    expect((await h.f.handle({ method: "GET", url: `/${TOKEN}/ready`, headers: { host: "evil" }, body: "" }, guard)).status).toBe(403);
  });

  test("Base が無効なら networks は空", async () => {
    const h = await harness({ networks: [RH] });
    expect((await h.ready()).body).toEqual({ networks: {} });
  });

  test("残高・累計・手数料の境界", async () => {
    const at = async (set: (c: Chain) => void, gasCap?: bigint): Promise<boolean> => {
      const c = chain(BASE, gasCap === undefined ? {} : { gasCap });
      set(c);
      return isReady(await harness({ base: c }));
    };
    expect(await at((c) => void (c.balance = async () => READY_MIN))).toBe(true);
    expect(await at((c) => void (c.balance = async () => READY_MIN - 1n))).toBe(false);
    expect(await at(() => {}, READY_MIN)).toBe(true);
    expect(await at(() => {}, READY_MIN - 1n)).toBe(false);
    expect(await at((c) => void (c.fee = 1_000_000_000n), 10n ** 18n)).toBe(true);
    expect(await at((c) => void (c.fee = 1_000_000_001n), 10n ** 18n)).toBe(false);
    expect(await at((c) => void (c.balance = () => Promise.reject(new Error("rpc"))))).toBe(false);
  });

  test("読み取りは 5 秒の控えと 1 本の並行。失敗は控えない。返らない読み取りは 2 秒で準備なし", async () => {
    const h = await harness();
    await Promise.all([isReady(h), isReady(h), isReady(h)]);
    await isReady(h);
    expect(h.base.calls.filter((c) => c === "balance")).toHaveLength(1);
    await h.advance(5_000);
    h.base.balance = () => Promise.reject(new Error("rpc"));
    expect(await isReady(h)).toBe(false);
    h.base.balance = async () => 10n ** 18n;
    expect(await isReady(h)).toBe(true);
    await h.advance(5_000);
    h.base.balance = () => new Promise(() => {});
    const before = h.base.calls.filter((c) => c === "balance").length;
    for (let i = 0; i < 3; i += 1) {
      const slow = isReady(h);
      await flush();
      await h.advance(2_000);
      expect(await slow).toBe(false);
    }
    // 止まった読み取りの間、次の要求は読み取りを重ねない。
    expect(h.base.calls.filter((c) => c === "balance").length).toBe(before + 1);
  });

  test("遅れて返った読み取りは新しい値として使わない（寿命は読み始めから）", async () => {
    const h = await harness();
    let give!: (v: bigint) => void;
    h.base.balance = () => new Promise<bigint>((r) => (give = r));
    const slow = isReady(h);
    await flush();
    await h.advance(2_000);
    expect(await slow).toBe(false);
    await h.advance(4_000);
    give(10n ** 18n);
    await flush();
    h.base.balance = async () => 0n;
    expect(await isReady(h)).toBe(false);
  });

  test("寿命の過ぎた読み取りを待っていた要求も、その値を使わない", async () => {
    const h = await harness();
    let give!: (v: bigint) => void;
    h.base.balance = () => new Promise<bigint>((r) => (give = r));
    const first = isReady(h);
    await flush();
    await h.advance(2_000);
    expect(await first).toBe(false);
    await h.advance(3_000);
    const joined = isReady(h);
    await flush();
    await h.advance(1_000);
    give(10n ** 18n);
    expect(await joined).toBe(false);
  });

  test("控えがあっても、保留になれば直ちに準備なし", async () => {
    const h = await harness();
    expect(await isReady(h)).toBe(true);
    h.base.wait = async () => undefined;
    await h.settle(body());
    expect(await isReady(h)).toBe(false);
    // 保留の間は読まない。
    await h.advance(5_000);
    const calls = h.base.calls.length;
    expect(await isReady(h)).toBe(false);
    expect(h.base.calls.length).toBe(calls);
  });

  test("読んでいる間に保留になれば準備なし", async () => {
    const h = await harness();
    h.base.wait = async () => undefined;
    let give!: () => void;
    h.base.balance = () => new Promise((r) => (give = () => r(10n ** 18n)));
    const reading = isReady(h);
    await flush();
    const first = give;
    const settling = h.settle(body());
    await flush();
    give();
    await settling;
    first();
    expect(h.f.heldNetworks()).toEqual([BASE]);
    expect(await reading).toBe(false);
  });

  test.each([
    ["残高", (c: Chain) => void (c.balance = async () => 0n)],
    ["手数料の上限", (c: Chain) => void (c.fee = 2_000_000_000n)],
  ])("/verify: %sで準備ができていなければ 200 isValid false facilitator_not_ready（SDK を呼ばない）", async (_n, set) => {
    const c = chain(BASE);
    set(c);
    const h = await harness({ base: c });
    expect(await h.verify(body())).toEqual({ status: 200, body: { isValid: false, invalidReason: "facilitator_not_ready", payer: FROM } });
    expect(c.calls).not.toContain("sdkVerify");
  });

  test("/verify: 準備ができていれば今と同じ。新 3 は準備を見ない", async () => {
    const h = await harness();
    expect((await h.verify(body())).body).toEqual({ isValid: true, payer: FROM });
    expect((await h.verify(body({ network: RH }))).body).toEqual({ isValid: true, payer: FROM });
    expect(h.rh.calls).toEqual(["sdkVerify"]);
  });
});

describe("起動の隔離（§2.5）", () => {
  test("chain id の確認が返らない・失敗する間: start は終わり、新 3 は settle できる。Base は 503・verify は断る・ready false、RPC 0 回", async () => {
    for (const check of [() => new Promise<boolean>(() => {}), () => Promise.reject(new Error("down"))]) {
      const base = chain(BASE, { lazy: true });
      base.check = check;
      const h = await harness({ base });
      expect((await h.settle(body({ network: RH }))).status).toBe(200);
      expect(await h.settle(body())).toEqual({ status: 503, body: { success: false, errorReason: "network_unavailable", network: BASE } });
      expect((await h.verify(body())).body).toMatchObject({ isValid: false, invalidReason: "facilitator_not_ready" });
      expect(await isReady(h)).toBe(false);
      expect(new Set(base.calls)).toEqual(new Set(["chainId"]));
    }
  });

  test("失敗の 15 秒後に再試行し、一致すれば使える", async () => {
    const base = chain(BASE, { lazy: true });
    let ok = false;
    base.check = async () => {
      if (!ok) throw new Error("down");
      return true;
    };
    const h = await harness({ base });
    await h.advance(15_000);
    expect((await h.settle(body())).status).toBe(503);
    ok = true;
    await h.advance(15_000);
    expect((await h.settle(body())).status).toBe(200);
  });

  test("返らない確認は 5 秒で打ち切って再試行する", async () => {
    const base = chain(BASE, { lazy: true });
    base.check = () => new Promise<boolean>(() => {});
    const h = await harness({ base });
    await h.advance(21_000);
    expect(base.calls.filter((c) => c === "chainId").length).toBe(2);
  });

  test("別の chain: 使えないまま、再試行しない（後で一致しても）", async () => {
    const base = chain(BASE, { lazy: true });
    base.check = async () => false;
    const h = await harness({ base });
    base.check = async () => true;
    await h.advance(600_000);
    expect(base.calls).toEqual(["chainId"]);
    expect((await h.settle(body())).status).toBe(503);
  });

  test("未解決が多くても start は RPC を読まない（すぐ保留）", async () => {
    const base = chain(BASE, { lazy: true });
    base.check = () => new Promise<boolean>(() => {});
    const h = await harness({ base, journal: fakeJournal([...INIT, ...Array.from({ length: 50 }, (_, i) => unresolved(i + 1, hashOf(i + 1))).flat()]) });
    expect(h.f.heldNetworks()).toEqual([BASE]);
    expect(base.calls).toEqual(["chainId"]);
    expect((await h.settle(body({ network: RH }))).status).toBe(200);
  });

  test("main: Base の RPC に届かなくても listen する（新 3 の I/O は注入）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "evm-fac-base-"));
    const out: string[] = [];
    const base = chain(BASE, { lazy: true });
    base.check = () => Promise.reject(new Error("down"));
    const running = await main(
      {
        EVM_FACILITATOR_KEY: `0x${"11".repeat(32)}`, EVM_FACILITATOR_TOKEN: TOKEN, EVM_FACILITATOR_NETWORKS: `${RH},${BASE}`, EVM_FACILITATOR_PAYTO_ALLOWLIST: PAYTO, EVM_FACILITATOR_PAYTO_ALLOWLIST_84532: ROUTER,
        EVM_FACILITATOR_GAS_CAP_46630: "1000", EVM_FACILITATOR_GAS_CAP_84532: "1000", EVM_FACILITATOR_JOURNAL: path.join(dir, "journal.ndjson"), EVM_FACILITATOR_LOG: path.join(dir, "log.ndjson"), EVM_FACILITATOR_PORT: String(await freePort()),
      },
      { stdout: (t) => void out.push(t), stderr: () => {} },
      { chainIoOf: async (network) => (network === BASE ? base.io : chain(RH).io) },
    );
    try {
      expect(JSON.parse(out[0]!)).toMatchObject({ event: "listening", networks: [RH, BASE] });
    } finally {
      await running.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("保留からの復帰（§2.4）", () => {
  async function heldByTimeout(): Promise<Harness> {
    const h = await harness();
    h.base.wait = async () => undefined;
    expect((await h.settle(body())).body).toMatchObject({ errorReason: "receipt_timeout" });
    expect(h.f.heldNetworks()).toEqual([BASE]);
    return h;
  }

  test("receipt が後から見えれば 15 秒の回で復帰: settled を 1 つ追記、送出は 1 回のまま、同じ要求は journal から 200", async () => {
    const h = await heldByTimeout();
    await h.advance(RECOVERY_INTERVAL_MS);
    expect(h.f.heldNetworks()).toEqual([BASE]);
    h.base.receipts.set(hashOf(1), receiptOf({ l1FeeWei: 7n }));
    await h.advance(RECOVERY_INTERVAL_MS);
    expect(h.f.heldNetworks()).toEqual([]);
    expect(types(h.journal)).toEqual(["submit_intent", "submitted", "settled"]);
    expect(h.f.gasSpent(BASE)).toBe(86_000n * FEE + 7n);
    expect(h.base.writes).toHaveLength(1);
    expect((await h.settle(body())).status).toBe(200);
    expect(h.base.writes).toHaveLength(1);
    await h.advance(600_000);
    expect(types(h.journal)).toEqual(["submit_intent", "submitted", "settled"]);
  });

  test("revert が後から見えれば reverted で復帰（その鍵は 5xx のまま、別の鍵は送れる）", async () => {
    const h = await heldByTimeout();
    h.base.receipts.set(hashOf(1), receiptOf({ status: "reverted" }));
    await h.advance(RECOVERY_INTERVAL_MS);
    expect(h.f.heldNetworks()).toEqual([]);
    expect((await h.settle(body())).body).toMatchObject({ errorReason: "submission_reverted" });
    h.base.wait = async () => receiptOf();
    expect((await h.settle(body({ nonce: nonceOf(2) }))).status).toBe(200);
  });

  test("Transfer の不一致の receipt では復帰しない。確定した transfer_mismatch は試さない", async () => {
    const h = await heldByTimeout();
    h.base.receipts.set(hashOf(1), receiptOf({ to: PAYTO }));
    await h.advance(RECOVERY_INTERVAL_MS * 3);
    expect(h.f.heldNetworks()).toEqual([BASE]);
    expect(types(h.journal)).toEqual(["submit_intent", "submitted"]);

    const m = await harness();
    m.base.wait = async () => receiptOf({ to: PAYTO });
    await m.settle(body());
    expect(m.pendingTimers()).toBe(0);
    expect(m.f.heldNetworks()).toEqual([BASE]);
  });

  test("RPC の失敗では保留のまま。回数は 40 回まで", async () => {
    const h = await heldByTimeout();
    const before = h.base.calls.length;
    h.base.io.reader.receipt = async () => {
      h.base.calls.push("receipt");
      throw new Error("rpc");
    };
    await h.advance(RECOVERY_INTERVAL_MS * (RECOVERY_MAX_ROUNDS + 20));
    expect(h.base.calls.slice(before).filter((c) => c === "receipt")).toHaveLength(RECOVERY_MAX_ROUNDS);
    expect(h.f.heldNetworks()).toEqual([BASE]);
    expect(h.pendingTimers()).toBe(0);
  });

  test("hash の無い保留: 使用済みで一致する tx が見つかれば予約を数えて復帰、未使用なら保留のまま", async () => {
    const h = await harness();
    h.base.send = () => Promise.reject(new Error("rpc"));
    await h.settle(body());
    await h.advance(RECOVERY_INTERVAL_MS);
    expect(h.f.heldNetworks()).toEqual([BASE]);
    h.base.used.add(nonceOf(1));
    h.base.usedLogs = [{ transactionHash: hashOf(9), blockNumber: LATEST }];
    h.base.receipts.set(hashOf(9), receiptOf());
    await h.advance(RECOVERY_INTERVAL_MS);
    expect(h.f.heldNetworks()).toEqual([]);
    expect(h.f.gasSpent(BASE)).toBe(RESERVE);
  });

  test("遅れた送出: 送出が終わるまで照合を始めない。submitted の追記の後に照合し、hash は自分の tx", async () => {
    const h = await harness();
    let resolveSend!: (hash: Hex) => void;
    h.base.send = () => new Promise<Hex>((r) => (resolveSend = r));
    const pending = h.settle(body());
    await flush();
    await h.advance(10_000);
    expect((await pending).body).toMatchObject({ errorReason: "send_outcome_unknown" });
    // 別の hash で使用済みに見えても、終わっていない送出がある間は照合しない。
    h.base.used.add(nonceOf(1));
    h.base.usedLogs = [{ transactionHash: hashOf(9), blockNumber: LATEST }];
    h.base.receipts.set(hashOf(9), receiptOf());
    const calls = h.base.calls.length;
    await h.advance(RECOVERY_INTERVAL_MS * 2);
    expect(h.base.calls.length).toBe(calls);
    h.base.receipts.set(hashOf(1), receiptOf({ l1FeeWei: 3n }));
    resolveSend(hashOf(1));
    await flush();
    await h.advance(RECOVERY_INTERVAL_MS);
    expect(h.f.heldNetworks()).toEqual([]);
    expect(h.journal.records.filter((r) => r.type === "settled")).toMatchObject([{ hash: hashOf(1) }]);
    expect(h.f.gasSpent(BASE)).toBe(86_000n * FEE + 3n);
  });

  test("遅れた fsync: 終端の追記が応答の後に成功した鍵は、次の回で RPC なしに復帰する", async () => {
    const h = await harness();
    let finish!: () => void;
    h.journal.before = (r) => (r.type === "settled" ? new Promise<void>((res) => (finish = res)) : undefined);
    const pending = h.settle(body());
    await flush();
    await h.advance(10_000);
    expect((await pending).body).toMatchObject({ errorReason: "journal_timeout" });
    const calls = h.base.calls.length;
    await h.advance(RECOVERY_INTERVAL_MS);
    expect(h.f.heldNetworks()).toEqual([BASE]);
    finish();
    await flush();
    await h.advance(RECOVERY_INTERVAL_MS);
    expect(h.f.heldNetworks()).toEqual([]);
    expect(h.base.calls.length).toBe(calls);
    expect(types(h.journal)).toEqual(["submit_intent", "submitted", "settled"]);
  });

  test("復帰の終端の追記が止まる: 期限の後も保留のまま、待ち行列は空き、書き終わった次の回で復帰（行は 1 つ）", async () => {
    const h = await heldByTimeout();
    h.base.receipts.set(hashOf(1), receiptOf());
    let finish!: () => void;
    h.journal.before = (r) => (r.type === "settled" ? new Promise<void>((res) => (finish = res)) : undefined);
    await h.advance(RECOVERY_INTERVAL_MS * 4);
    expect(h.f.heldNetworks()).toEqual([BASE]);
    // 残っているのは止まった追記だけ（回は期限で終わり、待ち行列を返した）。
    expect(h.f.drain.outstanding()).toBe(1);
    finish();
    await flush();
    await h.advance(RECOVERY_INTERVAL_MS * 2);
    expect(h.f.heldNetworks()).toEqual([]);
    expect(types(h.journal)).toEqual(["submit_intent", "submitted", "settled"]);
  });

  test.each([
    ["reverted", (h: Harness): void => void (h.base.wait = async () => receiptOf({ status: "reverted" }))],
    ["aborted_before_send", (): void => {}],
  ] as const)("遅れた fsync: %s の追記が期限の後に成功した鍵も、次の回で RPC なしに復帰する", async (type, arrange) => {
    const h = await harness();
    arrange(h);
    let finish!: () => void;
    h.journal.before = async (r) => {
      // aborted の試験: 意図の fsync に 5 秒かかり、送出の直前の残りが足りなくなる。
      if (type === "aborted_before_send" && r.type === "submit_intent") h.clock.t += 5_000;
      if (r.type === type) await new Promise<void>((res) => (finish = res));
    };
    const pending = h.settle(body());
    await flush();
    await h.advance(10_000);
    expect((await pending).status).toBeGreaterThanOrEqual(500);
    expect(h.f.heldNetworks()).toEqual([BASE]);
    expect(h.base.writes).toHaveLength(type === "reverted" ? 1 : 0);
    const calls = h.base.calls.length;
    await h.advance(RECOVERY_INTERVAL_MS);
    expect(h.f.heldNetworks()).toEqual([BASE]);
    finish();
    await flush();
    await h.advance(RECOVERY_INTERVAL_MS);
    expect(h.f.heldNetworks()).toEqual([]);
    expect(h.base.calls.length).toBe(calls);
    expect(types(h.journal).at(-1)).toBe(type);
  });

  test("照合の receipt を待つ間に、ほかの network の追記が失敗: 復帰の追記も解除もしない", async () => {
    const h = await heldByTimeout();
    let give!: () => void;
    h.base.io.reader.receipt = () => new Promise((r) => (give = () => r(receiptOf())));
    await h.advance(RECOVERY_INTERVAL_MS);
    h.journal.before = () => {
      throw new Error("ENOSPC");
    };
    await h.settle(body({ network: RH, nonce: nonceOf(5) }));
    delete h.journal.before;
    give();
    await flush();
    expect(h.f.heldNetworks()).toContain(BASE);
    expect(types(h.journal)).toEqual(["submit_intent", "submitted"]);
  });

  test("復帰の追記を待つ間に、ほかの network の追記が失敗: 解除しない", async () => {
    const h = await heldByTimeout();
    h.base.receipts.set(hashOf(1), receiptOf());
    let finish!: () => void;
    h.journal.before = (r) => {
      if (r.type === "settled") return new Promise<void>((res) => (finish = res));
      throw new Error("ENOSPC");
    };
    await h.advance(RECOVERY_INTERVAL_MS);
    await h.settle(body({ network: RH, nonce: nonceOf(5) }));
    finish();
    await flush();
    await h.advance(RECOVERY_INTERVAL_MS * 3);
    expect(h.f.heldNetworks()).toContain(BASE);
  });

  test("journal の追記が 1 度でも失敗したら、以後は復帰の追記をしない", async () => {
    const h = await heldByTimeout();
    h.journal.before = () => {
      throw new Error("ENOSPC");
    };
    await h.settle(body({ network: RH, nonce: nonceOf(5) }));
    delete h.journal.before;
    h.base.receipts.set(hashOf(1), receiptOf());
    await h.advance(RECOVERY_INTERVAL_MS * 5);
    expect(h.f.heldNetworks()).toContain(BASE);
    expect(types(h.journal)).toEqual(["submit_intent", "submitted"]);
  });

  test("chain id が未確認・不一致の間は照合の RPC・追記・復帰が 0 回。確認の後に復帰する", async () => {
    const base = chain(BASE, { lazy: true });
    let up = false;
    base.check = async () => {
      if (!up) throw new Error("down");
      return true;
    };
    base.receipts.set(hashOf(1), receiptOf());
    const h = await harness({ base, journal: fakeJournal([...INIT, ...unresolved(1, hashOf(1))]) });
    await h.advance(RECOVERY_INTERVAL_MS * (RECOVERY_MAX_ROUNDS + 10));
    expect(new Set(base.calls)).toEqual(new Set(["chainId"]));
    expect(h.f.heldNetworks()).toEqual([BASE]);
    up = true;
    await h.advance(RECOVERY_INTERVAL_MS * 2);
    expect(h.f.heldNetworks()).toEqual([]);

    const other = chain(BASE, { lazy: true });
    other.check = async () => false;
    other.receipts.set(hashOf(1), receiptOf());
    const m = await harness({ base: other, journal: fakeJournal([...INIT, ...unresolved(1, hashOf(1))]) });
    await m.advance(RECOVERY_INTERVAL_MS * 60);
    expect(other.calls).toEqual(["chainId"]);
    expect(types(m.journal)).toEqual(["submit_intent", "submitted"]);
  });

  test("drain: 待っている回は取り消し、始まった回は数えて書き終える。close の後は timer も行も増えない", async () => {
    const h = await heldByTimeout();
    h.f.drain.close();
    expect(h.pendingTimers()).toBe(0);
    h.base.receipts.set(hashOf(1), receiptOf());
    await h.advance(600_000);
    expect(types(h.journal)).toEqual(["submit_intent", "submitted"]);

    const m = await heldByTimeout();
    let release!: () => void;
    m.base.io.reader.receipt = () => new Promise((r) => (release = () => r(receiptOf())));
    await m.advance(RECOVERY_INTERVAL_MS);
    expect(m.f.drain.outstanding()).toBeGreaterThan(0);
    m.f.drain.close();
    const idle = m.f.drain.idle(5_000);
    release();
    expect(await idle).toBe(true);
    expect(types(m.journal)).toEqual(["submit_intent", "submitted", "settled"]);
  });

  test("新 3 の保留は今と同じ（復帰の timer なし）", async () => {
    const h = await harness();
    h.rh.wait = async () => undefined;
    await h.settle(body({ network: RH }));
    expect(h.f.heldNetworks()).toEqual([RH]);
    expect(h.pendingTimers()).toBe(0);
  });

  test("再生: 終端の後の submitted は hash を変えない", async () => {
    const first = await harness();
    await first.settle(body());
    const h = await harness({ journal: fakeJournal([...first.journal.records, { type: "submitted", key: keyOf(BASE, USDC, nonceOf(1)), hash: hashOf(2), at: 4 }]) });
    expect(h.f.heldNetworks()).toEqual([]);
    expect(await h.settle(body())).toMatchObject({ status: 200, body: { transaction: hashOf(1) } });
    expect(h.base.writes).toEqual([]);
  });
});

describe("終了と起動の失敗: journal と lock を放す前に裏の仕事を止めて待つ", () => {
  const envOf = (dir: string, port: string): NodeJS.ProcessEnv => ({
    EVM_FACILITATOR_KEY: `0x${"11".repeat(32)}`, EVM_FACILITATOR_TOKEN: TOKEN, EVM_FACILITATOR_NETWORKS: BASE, EVM_FACILITATOR_PAYTO_ALLOWLIST: ROUTER,
    EVM_FACILITATOR_GAS_CAP_84532: "1000", EVM_FACILITATOR_JOURNAL: path.join(dir, "journal.ndjson"), EVM_FACILITATOR_LOG: path.join(dir, "log.ndjson"), EVM_FACILITATOR_PORT: port,
  });

  test.each([["close()", false], ["listen の失敗", true]] as const)("%s: 始まった chain id の確認が終わってから journal を閉じ、lock を放す。その後に追記は無い", async (_n, failListen) => {
    const dir = mkdtempSync(path.join(tmpdir(), "evm-fac-base-"));
    const order: string[] = [];
    let finishCheck!: () => void;
    const base = chain(BASE, { lazy: true });
    base.check = () => new Promise<boolean>((r) => (finishCheck = () => (order.push("check done"), r(true))));
    const journal = fakeJournal();
    const deps = {
      chainIoOf: async () => base.io,
      lock: () => ({ release: () => void order.push("lock released") }),
      journalOf: () => Object.assign(journal, { close: async () => void order.push("journal closed") }),
    };
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const port = String((blocker.address() as AddressInfo).port);
    try {
      if (failListen) {
        const failed = expect(main(envOf(dir, port), { stdout: () => {}, stderr: () => {} }, deps)).rejects.toThrow("listen_failed");
        await new Promise((r) => setTimeout(r, 100));
        expect(order).toEqual([]);
        finishCheck();
        await failed;
      } else {
        await new Promise<void>((r) => blocker.close(() => r()));
        const running = await main(envOf(dir, port), { stdout: () => {}, stderr: () => {} }, deps);
        const closing = running.close();
        await new Promise((r) => setTimeout(r, 100));
        expect(order).toEqual([]);
        finishCheck();
        await closing;
      }
      expect(order).toEqual(["check done", "journal closed", "lock released"]);
    } finally {
      if (blocker.listening) await new Promise<void>((r) => blocker.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("終わらない裏の仕事があれば、journal も lock も閉じない", () => {
  test.each([["close()", false], ["listen の失敗", true]] as const)("%s: 復帰の照合が終わらない → 上限で戻るが journal・lock は開いたまま。遅れた追記は届く", async (_n, failListen) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dir = mkdtempSync(path.join(tmpdir(), "evm-fac-base-"));
    const order: string[] = [];
    const base = chain(BASE, { lazy: true });
    let give!: () => void;
    let began!: () => void;
    const started = new Promise<void>((r) => (began = r));
    // 復帰の照合の receipt が返らない（照合の期限 8 秒より先に閉じる）。
    base.io.reader.receipt = () => new Promise((r) => {
      give = () => r(receiptOf());
      began();
    });
    const journal = fakeJournal([...INIT.filter((r) => r.type === "gas_cap_init" && r.network === BASE), ...unresolved(1, hashOf(1))]);
    const env: NodeJS.ProcessEnv = {
      EVM_FACILITATOR_KEY: `0x${"11".repeat(32)}`, EVM_FACILITATOR_TOKEN: TOKEN, EVM_FACILITATOR_NETWORKS: BASE, EVM_FACILITATOR_PAYTO_ALLOWLIST: ROUTER,
      EVM_FACILITATOR_GAS_CAP_84532: (10n ** 16n).toString(), EVM_FACILITATOR_JOURNAL: path.join(dir, "journal.ndjson"), EVM_FACILITATOR_LOG: path.join(dir, "log.ndjson"), EVM_FACILITATOR_PORT: "1",
    };
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    env["EVM_FACILITATOR_PORT"] = String((blocker.address() as AddressInfo).port);
    if (!failListen) await new Promise<void>((r) => blocker.close(() => r()));
    let closed!: Promise<unknown>;
    const deps = {
      chainIoOf: async () => base.io, quiesceMsForTest: 500,
      lock: () => ({ release: () => void order.push("lock released") }),
      journalOf: () => Object.assign(journal, { close: async () => void order.push("journal closed") }),
    };
    try {
      if (failListen) {
        // chain id の確認（終わらない）が裏の仕事。
        base.check = () => new Promise<boolean>(() => {});
        closed = expect(main(env, { stdout: () => {}, stderr: () => {} }, deps)).rejects.toThrow("listen_failed");
        for (let i = 0; i < 20; i += 1) await flush();
        await vi.advanceTimersByTimeAsync(600);
        await closed;
        expect(order).toEqual([]);
      } else {
        const running = await main(env, { stdout: () => {}, stderr: () => {} }, deps);
        await flush();
        await vi.advanceTimersByTimeAsync(RECOVERY_INTERVAL_MS);
        await started;
        closed = running.close();
        for (let i = 0; i < 20; i += 1) await flush();
        await vi.advanceTimersByTimeAsync(600);
        await closed;
        expect(order).toEqual([]);
        // 遅れて返った receipt の追記は、開いたままの journal に届く。
        give();
        await flush();
        expect(types(journal)).toEqual(["submit_intent", "submitted", "settled"]);
      }
    } finally {
      vi.useRealTimers();
      if (blocker.listening) await new Promise<void>((r) => blocker.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("戻し（AC-B6）: Base の行を含む journal で、Base 無効の同じ code が起動する", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  test("gas_cap_init・settled・未解決・補充のある journal: 新 3 は動き、journal は書き換わらない（変更前の code は gas_cap_init の Base の行で起動しない）", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "evm-fac-base-"));
    const file = path.join(dir, "journal.ndjson");
    const key = keyOf(BASE, USDC, nonceOf(2));
    const records: JournalRecord[] = [
      ...INIT,
      ...unresolved(1, hashOf(1)),
      ...unresolved(2, hashOf(2)),
      { type: "settled", key, hash: hashOf(2), blockNumber: "1", via: "receipt", gasUsedWei: "5", at: 3 },
      { type: "gas_cap_raise", network: BASE, addWei: "7", reason: "test", at: 4 },
    ];
    const text = records.map((r) => `${JSON.stringify(r)}\n`).join("");
    writeFileSync(file, text, { mode: 0o600 });
    const journal = createFileJournal(file);
    const rh = chain(RH);
    const f = createEvmFacilitator({ networks: [RH], chains: new Map([[RH, rh.io]]), journal, payToAllowlist: [PAYTO], clock: { now: () => NOW_MS } });
    await f.start();
    expect(f.heldNetworks()).toEqual([]);
    const res = await f.handle({ method: "POST", url: `/${TOKEN}/settle`, headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" }, body: JSON.stringify(body({ network: RH })) }, { token: TOKEN, port: () => PORT });
    expect(res.status).toBe(200);
    await journal.close();
    expect(readFileSync(file, "utf8").startsWith(text)).toBe(true);
    expect(() => parseJournalLine(JSON.stringify({ type: "gas_cap_init", network: "eip155:8453", capWei: "1", at: 1 }), 1)).toThrow(/unknown network/);
  });
});
