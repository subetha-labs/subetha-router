/**
 * `tools/private-payer.ts --recover --chain`（`docs/zktls-router-thirdparty.md` §10、v1.2.2）の判定と単調性。**lab・Router・ネットワーク不要**:
 * `ChainReader`・Router client・復号を差し替える。何も払わない。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import { chainLegInputsOf, consoleProjectionOf, mergeChainEvidence, readChain, recoverPrivatePayer, rpcChainReader, settlementBoundInReceipt, type ChainEvidence, type ChainReader, type PrivatePayerEvidence } from "../../tools/private-payer.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "payer-chain-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = "0xfCea8a897Af225BD00cf815Bf41966CA6Bf60bF1";
const RECEIVER = "0xcD8eCC44D54d1E7a35b6625f681267ABa4ad47F5";
const SIGNER = "0x8763ce96fface4c7a92d40b049704632785b2b19";
const PROVIDER = "0xb3e7993Ed2FC2C79FFF220620240f298BBa9bF5B";
const NONCE_IN = `0x${"11".repeat(32)}`;
const NONCE_OUT = `0x${"22".repeat(32)}`;
const TOPIC_USED = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
const TOPIC_CANCELED = "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81";
const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const HEAD = { number: 48450000, hash: `0x${"aa".repeat(32)}`, timestamp: 1_792_611_000 };
const topicAddr = (a: string): string => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
const data = (v: bigint): string => `0x${v.toString(16).padStart(64, "0")}`;
const usedLog = (authorizer: string, nonce: string, address = USDC) => ({ address, topics: [TOPIC_USED, topicAddr(authorizer), nonce], data: "0x" });
const transferLog = (from: string, to: string, value: bigint, address = USDC) => ({ address, topics: [TOPIC_TRANSFER, topicAddr(from), topicAddr(to)], data: data(value) });

/** 偽の chain: 状態・ログ・receipt を表で与える。 */
function fakeReader(options: { chainId?: number; head?: typeof HEAD; again?: typeof HEAD; state?: Record<string, boolean>; found?: Record<string, { kind: "used" | "canceled"; txHash: string; block: number; blockHash: string }[]>; receipts?: Record<string, { blockHash: string; logs: { address: string; topics: string[]; data: string }[] } | undefined>; calls?: string[] }): ChainReader {
  const calls = options.calls ?? [];
  const head = options.head ?? HEAD;
  return {
    chainId: async () => options.chainId ?? 84532,
    latestBlock: async () => head,
    blockByNumber: async (n) => {
      calls.push(`block:${n}`);
      // head 以外は timestamp を合成（0.2 s/block。二分探索の相手）。head の読み直しは `again` で差し替えられる。
      if (n === head.number) return options.again ?? head;
      return { number: n, hash: `0x${n.toString(16).padStart(64, "0")}`, timestamp: Math.floor(head.timestamp - (head.number - n) * 0.2) };
    },
    authorizationState: async (_asset, authorizer, nonce, blockHash) => {
      calls.push(`state:${authorizer.toLowerCase()}:${nonce}:${blockHash}`);
      return options.state?.[`${authorizer.toLowerCase()}:${nonce}`] ?? false;
    },
    findAuthorization: async (_asset, authorizer, nonce, from, to) => {
      calls.push(`logs:${from}-${to}`);
      return options.found?.[`${authorizer.toLowerCase()}:${nonce}`] ?? [];
    },
    receiptLogsOf: async (txHash) => {
      calls.push(`receipt:${txHash}`);
      return options.receipts?.[txHash];
    },
  };
}
const TX = `0x${"33".repeat(32)}`;
const inboundLeg = { authorizer: PAYER, authorizerSource: "checkpoint" as const, nonce: NONCE_IN, validBefore: HEAD.timestamp - 100, network: "eip155:84532", asset: USDC, payTo: RECEIVER, amount: 2000n, notBeforeMs: (HEAD.timestamp - 700) * 1000 };
const outboundLeg = { authorizer: SIGNER, authorizerSource: "header" as const, nonce: NONCE_OUT, validBefore: HEAD.timestamp - 100, network: "eip155:84532", asset: USDC, payTo: PROVIDER, amount: 1000n, notBeforeMs: inboundLeg.notBeforeMs };
const settledFixture = { state: { [`${PAYER.toLowerCase()}:${NONCE_IN}`]: true }, found: { [`${PAYER.toLowerCase()}:${NONCE_IN}`]: [{ kind: "used" as const, txHash: TX, block: HEAD.number - 300, blockHash: `0x${"bb".repeat(32)}` }] }, receipts: { [TX]: { blockHash: `0x${"bb".repeat(32)}`, logs: [usedLog(PAYER, NONCE_IN), transferLog(PAYER, RECEIVER, 2000n)] } } };

function freshEvidence(overrides: Partial<PrivatePayerEvidence["gates"]> = {}): PrivatePayerEvidence {
  return { runId: "r", startedAt: "s", trust: "mozilla", synthetic: false, provider: { method: "GET", host: "h.test", path: "/p" }, gates: { inbound_settlement: { settled: false, uncertain: true }, outbound_settlement: { issued: false, receipt: false, uncertain: true }, private_delivery: {}, payer_receipt: { ok: false }, finality: { checked: false, note: "n" }, ...overrides } };
}

describe("settlementBoundInReceipt: AuthorizationUsed の直後の Transfer だけが束縛", () => {
  const leg = { asset: USDC, authorizer: PAYER, nonce: NONCE_IN, payTo: RECEIVER, amount: 2000n };
  test("直後の Transfer が authorizer → payTo・額に一致 → true", () => {
    expect(settlementBoundInReceipt([usedLog(PAYER, NONCE_IN), transferLog(PAYER, RECEIVER, 2000n)], leg)).toBe(true);
  });
  test("同じ receipt にあっても直後でない（バッチ: 別 authorization の Transfer が挟まる）→ false", () => {
    expect(settlementBoundInReceipt([usedLog(PAYER, NONCE_IN), usedLog(PAYER, NONCE_OUT), transferLog(PAYER, RECEIVER, 2000n)], leg)).toBe(false);
    expect(settlementBoundInReceipt([usedLog(PAYER, NONCE_IN), transferLog(PAYER, PROVIDER, 2000n), transferLog(PAYER, RECEIVER, 2000n)], leg)).toBe(false);
  });
  test("別 contract のログは無視（挟まっても束縛を壊さず、別 contract の Transfer は数えない）", () => {
    const other = "0x1111111111111111111111111111111111111111";
    expect(settlementBoundInReceipt([usedLog(PAYER, NONCE_IN), transferLog(PAYER, RECEIVER, 2000n, other), transferLog(PAYER, RECEIVER, 2000n)], leg)).toBe(true);
    expect(settlementBoundInReceipt([usedLog(PAYER, NONCE_IN, other), transferLog(PAYER, RECEIVER, 2000n, other)], leg)).toBe(false);
  });
  test("payTo・額・from・nonce が違う → false", () => {
    expect(settlementBoundInReceipt([usedLog(PAYER, NONCE_IN), transferLog(PAYER, PROVIDER, 2000n)], leg)).toBe(false);
    expect(settlementBoundInReceipt([usedLog(PAYER, NONCE_IN), transferLog(PAYER, RECEIVER, 1999n)], leg)).toBe(false);
    expect(settlementBoundInReceipt([usedLog(PAYER, NONCE_IN), transferLog(SIGNER, RECEIVER, 2000n)], leg)).toBe(false);
    expect(settlementBoundInReceipt([usedLog(PAYER, NONCE_OUT), transferLog(PAYER, RECEIVER, 2000n)], leg)).toBe(false);
  });
});

describe("readChain: 判定（hash で固定した読取、reorg と不整合は捨てる）", () => {
  test("settled: state true + used ログ + 直後の Transfer。読取は head の hash で、終わりに同じ番号を読み直す", async () => {
    const calls: string[] = [];
    const result = await readChain(fakeReader({ ...settledFixture, calls }), "test", { inbound: inboundLeg });
    expect(result).toMatchObject({ ok: true, chain: { chainId: 84532, block: { number: HEAD.number, hash: HEAD.hash }, inbound: { verdict: "settled", state: "used_or_canceled", txRef: TX, txBlock: HEAD.number - 300, expired: true, authorizerSource: "checkpoint" } } });
    expect(calls.some((c) => c.startsWith(`state:${PAYER.toLowerCase()}:${NONCE_IN}:${HEAD.hash}`))).toBe(true);
    expect(calls.at(-1)).toBe(`block:${HEAD.number}`);
    // 探索区間は timestamp の二分探索から（block 時間を仮定しない）: notBefore = head-700 s → 0.2 s/block で約 3,500 block 前、validBefore = head-100 s → 約 500 block 前。
    const logsCall = calls.find((c) => c.startsWith("logs:"))!;
    const [from, to] = logsCall.slice(5).split("-").map(Number) as [number, number];
    expect(from).toBeGreaterThanOrEqual(HEAD.number - 3500 - 200 - 5);
    expect(from).toBeLessThanOrEqual(HEAD.number - 3500 + 5);
    expect(to).toBeGreaterThanOrEqual(HEAD.number - 500 + 200 - 5);
    expect(to).toBeLessThanOrEqual(HEAD.number - 500 + 200 + 5);
  });
  test("state true + 取消ログだけ → canceled; state true + ログ無し → used_unlocated; Transfer が合わない → used_unlocated", async () => {
    const key = `${PAYER.toLowerCase()}:${NONCE_IN}`;
    const canceled = await readChain(fakeReader({ state: { [key]: true }, found: { [key]: [{ kind: "canceled", txHash: TX, block: 1, blockHash: "0xcc" }] } }), "test", { inbound: inboundLeg });
    expect(canceled).toMatchObject({ ok: true, chain: { inbound: { verdict: "canceled" } } });
    const unlocated = await readChain(fakeReader({ state: { [key]: true } }), "test", { inbound: inboundLeg });
    expect(unlocated).toMatchObject({ ok: true, chain: { inbound: { verdict: "used_unlocated" } } });
    const wrong = await readChain(fakeReader({ ...settledFixture, receipts: { [TX]: { blockHash: `0x${"bb".repeat(32)}`, logs: [usedLog(PAYER, NONCE_IN), transferLog(PAYER, PROVIDER, 2000n)] } } }), "test", { inbound: inboundLeg });
    expect(wrong).toMatchObject({ ok: true, chain: { inbound: { verdict: "used_unlocated" } } });
    const failedTx = await readChain(fakeReader({ ...settledFixture, receipts: { [TX]: undefined } }), "test", { inbound: inboundLeg });
    expect(failedTx).toMatchObject({ ok: true, chain: { inbound: { verdict: "used_unlocated" } } });
  });
  test("unused: 期限後は unused_expired、期限前は unused、期限ちょうど（blockTime == validBefore）は未期限", async () => {
    expect(await readChain(fakeReader({}), "test", { inbound: inboundLeg })).toMatchObject({ ok: true, chain: { inbound: { verdict: "unused_expired", expired: true } } });
    expect(await readChain(fakeReader({}), "test", { inbound: { ...inboundLeg, validBefore: HEAD.timestamp + 100 } })).toMatchObject({ ok: true, chain: { inbound: { verdict: "unused", expired: false } } });
    expect(await readChain(fakeReader({}), "test", { inbound: { ...inboundLeg, validBefore: HEAD.timestamp } })).toMatchObject({ ok: true, chain: { inbound: { verdict: "unused", expired: false } } });
  });
  test("chainId 違い・reorg（読み直した hash が違う）・receipt の blockHash 不一致 → 結果を捨てる（固定語）", async () => {
    expect(await readChain(fakeReader({ chainId: 8453 }), "test", { inbound: inboundLeg })).toEqual({ ok: false, error: "chain_mismatch" });
    expect(await readChain(fakeReader({ again: { ...HEAD, hash: `0x${"dd".repeat(32)}` } }), "test", { inbound: inboundLeg })).toEqual({ ok: false, error: "chain_reorg_detected" });
    const inconsistent = await readChain(fakeReader({ ...settledFixture, receipts: { [TX]: { blockHash: `0x${"ee".repeat(32)}`, logs: settledFixture.receipts[TX]!.logs } } }), "test", { inbound: inboundLeg });
    expect(inconsistent).toEqual({ ok: false, error: "chain_inconsistent" });
  });
  test("送信レグも同じ規則。network が違うレグは読まない（skipped）", async () => {
    const key = `${SIGNER.toLowerCase()}:${NONCE_OUT}`;
    const out = await readChain(fakeReader({ state: { [key]: true }, found: { [key]: [{ kind: "used", txHash: TX, block: 5, blockHash: "0xff" }] }, receipts: { [TX]: { blockHash: "0xff", logs: [usedLog(SIGNER, NONCE_OUT), transferLog(SIGNER, PROVIDER, 1000n)] } } }), "test", { outbound: outboundLeg });
    expect(out).toMatchObject({ ok: true, chain: { outbound: { verdict: "settled", txRef: TX, authorizerSource: "header" } } });
    const skipped = await readChain(fakeReader({}), "test", { outbound: { ...outboundLeg, network: "eip155:8453" } });
    expect(skipped).toMatchObject({ ok: true, chain: { skipped: { outbound: "network" } } });
    if (skipped.ok) expect(skipped.chain.outbound).toBeUndefined();
  });
});

describe("mergeChainEvidence: 単調な写し", () => {
  const chainOf = (inbound?: ChainEvidence["inbound"], outbound?: ChainEvidence["outbound"]): ChainEvidence => ({ readAt: "t", rpcHost: "test", chainId: 84532, block: { number: 1, hash: "0x01", time: 1 }, ...(inbound === undefined ? {} : { inbound }), ...(outbound === undefined ? {} : { outbound }) });
  const legEv = (verdict: ChainEvidence["inbound"] extends infer T ? (T extends { verdict: infer V } ? V : never) : never, overrides: Partial<NonNullable<ChainEvidence["inbound"]>> = {}): NonNullable<ChainEvidence["inbound"]> => ({ authorizer: PAYER, authorizerSource: "checkpoint", nonce: NONCE_IN, state: verdict === "unused" || verdict === "unused_expired" ? "unused" : "used_or_canceled", verdict, validBefore: 1, expired: verdict !== "unused", ...(verdict === "settled" ? { txRef: TX, txBlock: 1 } : {}), ...overrides });
  test("settled → settled true・chainTxRef・uncertain 解除。txRef があれば chainTxRef は付けない", () => {
    const e = freshEvidence();
    expect(mergeChainEvidence(e, chainOf(legEv("settled")), false)).toEqual([]);
    expect(e.gates.inbound_settlement).toEqual({ settled: true, chain: "settled", chainTxRef: TX });
    const withTx = freshEvidence({ inbound_settlement: { settled: true, txRef: "0xrouter" } });
    mergeChainEvidence(withTx, chainOf(legEv("settled")), true);
    expect(withTx.gates.inbound_settlement).toEqual({ settled: true, txRef: "0xrouter", chain: "settled" });
  });
  test("unused_expired + 終端 → settled false・uncertain 解除。非終端 → uncertain のまま（chain の結論だけ）。unused（期限前）・canceled・used_unlocated → uncertain のまま", () => {
    const terminal = freshEvidence();
    mergeChainEvidence(terminal, chainOf(legEv("unused_expired")), true);
    expect(terminal.gates.inbound_settlement).toEqual({ settled: false, chain: "unused_expired" });
    for (const [verdict, routerTerminal] of [["unused_expired", false], ["unused", true], ["canceled", true], ["used_unlocated", true]] as const) {
      const e = freshEvidence();
      mergeChainEvidence(e, chainOf(legEv(verdict)), routerTerminal);
      expect(e.gates.inbound_settlement, verdict).toEqual({ settled: false, uncertain: true, chain: verdict });
      // 以前の読取で不確実を外していても、未解決の新しい観測は不確実を**戻す**（過去の未使用の観測で今の結果を確定させない）。
      const cleared = freshEvidence({ inbound_settlement: { settled: false, chain: "unused_expired" } });
      mergeChainEvidence(cleared, chainOf(legEv(verdict)), routerTerminal);
      expect(cleared.gates.inbound_settlement, `${verdict} after cleared`).toEqual({ settled: false, uncertain: true, chain: verdict });
      // 提出していない（quote だけ）なら不確実の印は付けない。
      const notAttempted = freshEvidence({ inbound_settlement: { settled: false } });
      mergeChainEvidence(notAttempted, chainOf(legEv(verdict)), routerTerminal, false);
      expect(notAttempted.gates.inbound_settlement, `${verdict} not attempted`).toEqual({ settled: false, chain: verdict });
    }
  });
  test("operator_unverified は診断だけ: unused_expired + 終端でも uncertain のまま、settled でもゲートは settled にしない", () => {
    const e = freshEvidence();
    const notes = mergeChainEvidence(e, chainOf(legEv("unused_expired", { authorizerSource: "operator_unverified" })), true);
    expect(e.gates.inbound_settlement).toEqual({ settled: false, uncertain: true, chain: "unused_expired" });
    expect(notes.some((n) => n.includes("unverified"))).toBe(true);
    const e2 = freshEvidence();
    mergeChainEvidence(e2, chainOf(legEv("settled", { authorizerSource: "operator_unverified" })), true);
    expect(e2.gates.inbound_settlement).toEqual({ settled: false, uncertain: true, chain: "settled" });
  });
  test("確立した事実（txRef 無しの settled = 引き渡し由来、chain 由来の chainTxRef）は矛盾する観測でも不変、矛盾は notes。引き渡し由来の settled に一致する観測は chainTxRef を足す", () => {
    const handover = freshEvidence({ inbound_settlement: { settled: true } });
    const notes = mergeChainEvidence(handover, chainOf(legEv("unused_expired")), true);
    expect(handover.gates.inbound_settlement).toEqual({ settled: true });
    expect(notes.some((n) => n.startsWith("contradiction: inbound"))).toBe(true);
    const enriched = freshEvidence({ inbound_settlement: { settled: true, uncertain: true } });
    mergeChainEvidence(enriched, chainOf(legEv("settled")), false);
    expect(enriched.gates.inbound_settlement).toEqual({ settled: true, chain: "settled", chainTxRef: TX });
    // 次の読取で chain オブジェクトが上書きされても、ゲートの chainTxRef は残る。
    mergeChainEvidence(enriched, chainOf(legEv("used_unlocated")), true);
    expect(enriched.gates.inbound_settlement).toEqual({ settled: true, chain: "settled", chainTxRef: TX });
    const chainDerived = freshEvidence({ outbound_settlement: { issued: true, receipt: false, chain: "settled", chainTxRef: TX } });
    const notes2 = mergeChainEvidence(chainDerived, chainOf(undefined, { ...legEv("unused_expired"), authorizer: SIGNER, authorizerSource: "header", nonce: NONCE_OUT }), true);
    expect(chainDerived.gates.outbound_settlement).toEqual({ issued: true, receipt: false, chain: "settled", chainTxRef: TX });
    expect(notes2.some((n) => n.startsWith("contradiction: outbound"))).toBe(true);
  });
  test("送信: settled は issued true・chainTxRef、receipt は変えない（領収の有無は別）", () => {
    const e = freshEvidence({ outbound_settlement: { issued: true, receipt: false } });
    mergeChainEvidence(e, chainOf(undefined, { ...legEv("settled"), authorizer: SIGNER, authorizerSource: "header", nonce: NONCE_OUT }), true);
    expect(e.gates.outbound_settlement).toEqual({ issued: true, receipt: false, chain: "settled", chainTxRef: TX });
  });
});

describe("rpcChainReader: JSON-RPC の形（偽の fetch。ネットワーク無し）", () => {
  function stubFetch(handler: (method: string, params: unknown[]) => unknown): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { method: string; params: unknown[] };
      const result = handler(body.method, body.params);
      return new Response(JSON.stringify(result instanceof Error ? { jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } } : { jsonrpc: "2.0", id: 1, result }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }
  test("authorizationState は EIP-1898 の blockHash で eth_call し、正準な 0/1 だけを受ける（2 などは形違い = 例外）", async () => {
    const seen: unknown[] = [];
    const restore = stubFetch((method, params) => {
      seen.push([method, params]);
      if (method === "eth_call") {
        const p = params[1] as { blockHash?: string };
        return p.blockHash === "0xabc" ? `0x${"0".repeat(63)}1` : `0x${"0".repeat(63)}2`;
      }
      return new Error("unexpected");
    });
    try {
      const reader = rpcChainReader("https://rpc.test/");
      expect(await reader.authorizationState(USDC, PAYER, NONCE_IN, "0xabc")).toBe(true);
      expect(JSON.stringify(seen[0])).toContain("\"blockHash\":\"0xabc\"");
      await expect(reader.authorizationState(USDC, PAYER, NONCE_IN, "0xdef")).rejects.toThrow("rpc_shape");
    } finally {
      restore();
    }
  });
  test("findAuthorization は 200 block ずつ、used と canceled のログを資産 contract・authorizer・nonce の topics で取り、blockHash を保つ。receiptLogsOf は失敗 tx を undefined に", async () => {
    const ranges: string[] = [];
    const restore = stubFetch((method, params) => {
      if (method === "eth_getLogs") {
        const f = params[0] as { fromBlock: string; toBlock: string; address: string; topics: string[] };
        ranges.push(`${Number(f.fromBlock)}-${Number(f.toBlock)}:${f.topics[0]!.slice(0, 6)}`);
        expect(f.address).toBe(USDC);
        expect(f.topics[1]).toBe(topicAddr(PAYER));
        expect(f.topics[2]).toBe(NONCE_IN);
        return f.topics[0] === TOPIC_USED && Number(f.fromBlock) === 1000 ? [{ transactionHash: TX, blockNumber: "0x3f2", blockHash: "0xbh" }] : [];
      }
      if (method === "eth_getTransactionReceipt") return (params[0] as string) === TX ? { status: "0x1", blockHash: "0xbh", logs: [usedLog(PAYER, NONCE_IN), transferLog(PAYER, RECEIVER, 2000n)] } : { status: "0x0", blockHash: "0xbh", logs: [] };
      return new Error("unexpected");
    });
    try {
      const reader = rpcChainReader("https://rpc.test/");
      const found = await reader.findAuthorization(USDC, PAYER, NONCE_IN, 1000, 1450);
      expect(found).toEqual([{ kind: "used", txHash: TX, block: 1010, blockHash: "0xbh" }]);
      expect(ranges).toEqual(["1000-1199:0x98de", "1000-1199:0x1cdd", "1200-1399:0x98de", "1200-1399:0x1cdd", "1400-1450:0x98de", "1400-1450:0x1cdd"]);
      expect(await reader.receiptLogsOf(TX)).toMatchObject({ blockHash: "0xbh" });
      expect(await reader.receiptLogsOf(`0x${"55".repeat(32)}`)).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe("chainLegInputsOf: 入力の束縛（protocol・資産・network・header の照合・authorizer の出所）", () => {
  function checkpoint(overrides: { offer?: Record<string, unknown>; destination?: Record<string, unknown>; progress?: Record<string, unknown> } = {}): Record<string, unknown> {
    return {
      version: "private-payer-checkpoint-v1",
      createdAt: new Date((HEAD.timestamp - 700) * 1000).toISOString(),
      requestId: "r",
      quote: { paymentId: "p", quoteId: "q", ownerKey: "k", approval: { deadlineMs: 0 }, source: { payTo: RECEIVER, amount: "2000", offer: { scheme: "exact", network: "eip155:84532", asset: USDC, amount: "2000", payTo: RECEIVER, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2", challengeNonce: NONCE_IN, expiresAt: HEAD.timestamp - 100 }, ...overrides.offer } }, destination: { rail: "x402", quoted: "1000", asset: USDC, network: "eip155:84532", payTo: PROVIDER, ...overrides.destination }, pricing: {} },
      quoteFileSha256: "x",
      intentSha256: "y",
      orderId: "z",
      args: { routerBaseUrl: "http://127.0.0.1:9", principalId: "owner", profileId: "p", method: "GET", host: "h.test", path: "/p", outbound: {}, inbound: {}, trust: "mozilla" },
      // purchaseAttempted: 提出済みで結果不明 → 回復は両レグを uncertain にする（その解除を試す）。
      progress: { paymentId: "p", purchaseAttempted: true, payerAddress: PAYER, ...overrides.progress },
    };
  }
  function headerFile(dir: string, auth: Record<string, unknown>): void {
    writeFileSync(path.join(dir, "payment_header.json"), JSON.stringify({ order_id: "z", intent_sha256: "y", name: "PAYMENT-SIGNATURE", value: Buffer.from(JSON.stringify({ x402Version: 2, payload: { authorization: { from: SIGNER, to: PROVIDER, value: "1000", validAfter: "0", validBefore: String(HEAD.timestamp - 100), nonce: NONCE_OUT, ...auth }, signature: "0xsig" } })).toString("base64") }));
  }
  const dir = (name: string): string => {
    const d = path.join(tmp, name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  test("正: 再開点のアドレス（checkpoint）と header（header）", () => {
    const d = dir("ok");
    headerFile(d, {});
    const r = chainLegInputsOf(checkpoint() as never, d, undefined);
    expect(r).toMatchObject({ ok: true, inbound: { authorizer: PAYER, authorizerSource: "checkpoint", nonce: NONCE_IN, payTo: RECEIVER, amount: 2000n, validBefore: HEAD.timestamp - 100 }, outbound: { authorizer: SIGNER, authorizerSource: "header", nonce: NONCE_OUT, payTo: PROVIDER, amount: 1000n } });
  });
  test("古い再開点 + --payer-address → operator_unverified; 再開点と引数の不一致 → 拒否; どちらも無い → 受信を読まない", () => {
    const d = dir("legacy");
    expect(chainLegInputsOf(checkpoint({ progress: { payerAddress: undefined } }) as never, d, PAYER)).toMatchObject({ ok: true, inbound: { authorizerSource: "operator_unverified" } });
    expect(chainLegInputsOf(checkpoint() as never, d, SIGNER)).toEqual({ ok: false, reason: "payer_address_conflict" });
    expect(chainLegInputsOf(checkpoint({ progress: { payerAddress: undefined } }) as never, d, undefined)).toMatchObject({ ok: true, skipped: { inbound: "payer_address_unknown" } });
  });
  test("受信の scheme・network・資産が違う → そのレグを読まない。送信の network・資産が違う、header の to/value 不一致・形違い → 読まない", () => {
    const d = dir("skips");
    headerFile(d, {});
    expect(chainLegInputsOf(checkpoint({ offer: { scheme: "upto" } }) as never, d, undefined)).toMatchObject({ ok: true, skipped: { inbound: "protocol" } });
    expect(chainLegInputsOf(checkpoint({ offer: { network: "eip155:8453" } }) as never, d, undefined)).toMatchObject({ ok: true, skipped: { inbound: "network" } });
    expect(chainLegInputsOf(checkpoint({ offer: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } }) as never, d, undefined)).toMatchObject({ ok: true, skipped: { inbound: "asset" } });
    expect(chainLegInputsOf(checkpoint({ destination: { network: "eip155:8453" } }) as never, d, undefined)).toMatchObject({ ok: true, skipped: { outbound: "network" } });
    expect(chainLegInputsOf(checkpoint({ destination: { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } }) as never, d, undefined)).toMatchObject({ ok: true, skipped: { outbound: "asset" } });
    headerFile(d, { value: "999" });
    expect(chainLegInputsOf(checkpoint() as never, d, undefined)).toMatchObject({ ok: true, skipped: { outbound: "header_mismatch" } });
    headerFile(d, { to: RECEIVER });
    expect(chainLegInputsOf(checkpoint() as never, d, undefined)).toMatchObject({ ok: true, skipped: { outbound: "header_mismatch" } });
    writeFileSync(path.join(d, "payment_header.json"), JSON.stringify({ value: "not-base64-json" }));
    expect(chainLegInputsOf(checkpoint() as never, d, undefined)).toMatchObject({ ok: true, skipped: { outbound: "header_shape" } });
  });

  test("recoverPrivatePayer --chain（Router と復号を差し替え）: 証跡に chain が書かれ、2 回目の回復（--chain 無し）でも残る。stdout 相当の要約に nonce・authorizer・tx hash が無い。RPC 失敗・reorg は証跡不変 + recovery-log", async () => {
    const d = dir("recover");
    writeFileSync(path.join(d, "checkpoint.json"), JSON.stringify(checkpoint()));
    const statusUnknown = { found: true as const, status: 200, projection: { status: "unknown", terminalReason: "source_rejected" } };
    const client = { status: async () => statusUnknown as never, privateRecord: async () => ({ ok: false as const, error: "record_not_available", status: 409 }) };
    const base = { routerBaseUrl: "http://127.0.0.1:9", principalId: "owner", token: "t", outDir: d, clientForTest: client, log: () => {} };
    // 未使用 + 期限後 + 終端 → uncertain 解除（authorizer は再開点由来）。
    const first = await recoverPrivatePayer({ ...base, chain: { readerForTest: fakeReader({}) } });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.evidence.gates.inbound_settlement, JSON.stringify(first.evidence)).toEqual({ settled: false, chain: "unused_expired" });
    expect(first.evidence.chain).toMatchObject({ chainId: 84532, inbound: { verdict: "unused_expired", authorizerSource: "checkpoint" } });
    // 2 回目（--chain 無し）: chain の履歴は残るが、今の結果は今回の読取だけが決めるので不確実の印は戻る。
    const second = await recoverPrivatePayer(base);
    expect(second.ok && second.evidence.chain?.inbound?.verdict).toBe("unused_expired");
    expect(second.ok && second.evidence.gates.inbound_settlement).toEqual({ settled: false, chain: "unused_expired", uncertain: true });
    // 3 回目（--chain あり、reorg 後に used_unlocated）: 不確実のまま、結論は更新。
    const third = await recoverPrivatePayer({ ...base, chain: { readerForTest: fakeReader({ state: { [`${PAYER.toLowerCase()}:${NONCE_IN}`]: true } }) } });
    expect(third.ok && third.evidence.gates.inbound_settlement).toEqual({ settled: false, chain: "used_unlocated", uncertain: true });
    // コンソール向けの射影には nonce・authorizer・tx 参照（txRef/chainTxRef/eventId）が無い（証跡ファイルにはある）。
    const settledRun = await recoverPrivatePayer({ ...base, chain: { readerForTest: fakeReader(settledFixture) } });
    expect(settledRun.ok && settledRun.evidence.gates.inbound_settlement).toMatchObject({ settled: true, chain: "settled", chainTxRef: TX });
    const populated = structuredClone((settledRun as { evidence: PrivatePayerEvidence }).evidence);
    populated.gates.inbound_settlement = { ...populated.gates.inbound_settlement, txRef: `0x${"66".repeat(32)}`, eventId: NONCE_IN };
    populated.gates.outbound_settlement = { ...populated.gates.outbound_settlement, txRef: `0x${"77".repeat(32)}`, chainTxRef: `0x${"88".repeat(32)}` };
    const console = JSON.stringify(consoleProjectionOf(populated));
    for (const secret of [NONCE_IN, PAYER.toLowerCase().slice(2, 12), TX, `0x${"66".repeat(32)}`, `0x${"77".repeat(32)}`, `0x${"88".repeat(32)}`, "chainTxRef", "txRef", "eventId"]) expect(console, secret).not.toContain(secret);
    expect(console).toContain("\"inbound\":\"settled\"");
    expect(JSON.stringify(settledRun)).toContain(TX);
    // RPC 失敗 → 証跡不変、recovery-log。
    // 証跡の事実（gates・chain）は不変（runId 等の起動の印は毎回変わる）。
    const facts = (): string => JSON.stringify((({ gates, chain }) => ({ gates, chain }))(JSON.parse(readFileSync(path.join(d, "evidence.json"), "utf8")) as PrivatePayerEvidence));
    const before = facts();
    const failing: ChainReader = { ...fakeReader({}), latestBlock: async () => { throw new Error("down"); } };
    await recoverPrivatePayer({ ...base, chain: { readerForTest: failing } });
    expect(facts()).toBe(before);
    expect(readFileSync(path.join(d, "recovery-log.json"), "utf8")).toContain("chain_unreadable");
    // reorg → 同じ。
    await recoverPrivatePayer({ ...base, chain: { readerForTest: fakeReader({ again: { ...HEAD, hash: "0x00" } }) } });
    expect(facts()).toBe(before);
    expect(readFileSync(path.join(d, "recovery-log.json"), "utf8")).toContain("chain_reorg_detected");
    // 引き渡し済み（受信は確立）で送信が未解決: 送信の不確実は受信と独立。chain で unused_expired + 終端 → 外れる; 次の回復（--chain 無し）で戻る; 発行だけの status では外れない。
    const d3 = dir("recover-handover");
    writeFileSync(path.join(d3, "checkpoint.json"), JSON.stringify(checkpoint({ progress: { handedOver: true } })));
    headerFile(d3, { validBefore: String(HEAD.timestamp - 100) });
    const issuedOnly = { status: async () => ({ found: true as const, status: 200, projection: { status: "unknown", terminalReason: "private_session_timeout", source: { txRef: `0x${"99".repeat(32)}` }, private: { outbound: { issued: true } } } }) as never, privateRecord: async () => ({ ok: false as const, error: "record_not_available", status: 409 }) };
    const h1 = await recoverPrivatePayer({ ...base, outDir: d3, clientForTest: issuedOnly, chain: { readerForTest: fakeReader({}) } });
    expect(h1.ok && h1.evidence.gates.inbound_settlement).toMatchObject({ settled: true, txRef: `0x${"99".repeat(32)}` });
    expect(h1.ok && h1.evidence.gates.outbound_settlement).toEqual({ issued: true, receipt: false, chain: "unused_expired" });
    const h2 = await recoverPrivatePayer({ ...base, outDir: d3, clientForTest: issuedOnly });
    expect(h2.ok && h2.evidence.gates.outbound_settlement).toEqual({ issued: true, receipt: false, chain: "unused_expired", uncertain: true });
    const h3 = await recoverPrivatePayer({ ...base, outDir: d3, clientForTest: { ...issuedOnly, status: async () => { throw new Error("down"); } } as never, chain: { readerForTest: fakeReader({}) } });
    expect(h3.ok && h3.evidence.gates.outbound_settlement).toEqual({ issued: true, receipt: false, chain: "unused_expired", uncertain: true });
    // Router が読めない（status 不可）+ 期限後 → uncertain のまま。
    const d2 = dir("recover-noroutr");
    writeFileSync(path.join(d2, "checkpoint.json"), JSON.stringify(checkpoint()));
    const down = { status: async () => { throw new Error("down"); }, privateRecord: async () => { throw new Error("down"); } };
    const r2 = await recoverPrivatePayer({ ...base, outDir: d2, clientForTest: down as never, chain: { readerForTest: fakeReader({}) } });
    expect(r2.ok && r2.evidence.gates.inbound_settlement).toMatchObject({ settled: false, chain: "unused_expired" });
    expect(r2.ok && r2.evidence.gates.inbound_settlement.uncertain).toBe(true);
    expect(existsSync(path.join(d2, "payment_header.json"))).toBe(false);
  });
});
