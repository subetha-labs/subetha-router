/**
 * 承認前・回復時の burn の receipt の照合（`docs/zktls-router-burn-sale-hardening.md` FR-H2〜H6）。**lab 不要・外部ネットワーク不要・何も払わない**
 * （RPC は偽の reader か、loopback の JSON-RPC の fixture）。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import { burnRefusalOf, consoleProjectionOf, quotedOutputOf, readBurn, recoverPrivatePayer, rpcBurnReader, runPrivatePayer, selectBurnTransfer, type BurnEvidence, type ChainReader, type PrivatePayerEvidence } from "../../tools/private-payer.js";
import { BLOCK_HASH, fakeBurnReader, TOPIC_TRANSFER, transferLog } from "../fixtures/burn-reader.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "payer-burncheck-"));
const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

const ZUSDC = "0x32c83780bc6Ac14e8A2938d4Fd192d3721ef3D9f";
const OTHER_TOKEN = "0x132CeD517327C2aC5073ACEb9eCF1e7783feCbcF";
const PAY_TO = "0x0d359c3329fb5bf92c950062f61b93fa7b1ed7a1";
const ELSEWHERE = "0x00000000000000000000000000000000000e15e0";
const BURN = `0x${"5a".repeat(32)}`;
const EXPECT = { chainId: 11155111, asset: ZUSDC, payTo: PAY_TO, amount: 2000n, txHash: BURN };
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SUBETHA_INBOUND = { network: "eip155:11155111", asset: ZUSDC, maxTotal: "2000" };
const OUTBOUND = { protocol: "x402" as const, network: "eip155:84532", asset: USDC, payTo: "0xb3e7993Ed2FC2C79FFF220620240f298BBa9bF5B", maxAmount: "1000" };
const BASE = { routerBaseUrl: "http://127.0.0.1:9", principalId: "owner", token: "t", profileId: "priv-subetha", method: "GET" as const, host: "provider.test", path: "/paid", outbound: OUTBOUND, trust: "lab-fixture-ca" as const, connect: "127.0.0.1:9", inbound: SUBETHA_INBOUND };

function fakeLab(): { labDir: string; srsPath: string } {
  const labDir = path.join(tmp, "lab");
  mkdirSync(path.join(labDir, "phase5/runner/target/release"), { recursive: true });
  writeFileSync(path.join(labDir, "phase5/runner/target/release/delivery"), "");
  const srsPath = path.join(tmp, "srs.dat");
  writeFileSync(srsPath, "");
  return { labDir, srsPath };
}
function offer(): Record<string, unknown> {
  return { scheme: "subetha-zerc20", network: "eip155:11155111", asset: ZUSDC, amount: "2000", payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { challengeNonce: `0x${"cd".repeat(32)}`, expiresAt: Math.floor(Date.now() / 1000) + 1800, routeBinding: "b", fundsMoveOnCredential: true, settlementKind: "zerc20-v2-burn-sale" } };
}
/** quote 済みの再開点（Router 無し）。`progress` を足せば承認済み・回復の場面を模す。 */
function seed(out: string, options: { deadlineMs?: number; progress?: Record<string, unknown> } = {}): void {
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const o = offer();
  const quote = { paymentId: "p1", quoteId: "q1", ownerKey: "k", approval: { deadlineMs: options.deadlineMs ?? Date.now() + 1_200_000, boundTo: "q1" }, resource: { url: "http://127.0.0.1:9/v1/private/purchases", method: "POST" }, source: { offer: o }, pricing: { total: "2000" }, private: { inbound: { rail: "subetha", network: o["network"], asset: o["asset"], payTo: o["payTo"], total: "2000", fundsMoveAt: "payer_burn_before_credential" } } };
  const { ownerKey: _o, ...subject } = quote;
  const quoteText = `${JSON.stringify(subject, null, 2)}\n`;
  writeFileSync(path.join(out, "quote.json"), quoteText, { mode: 0o600 });
  writeFileSync(path.join(out, "checkpoint.json"), JSON.stringify({ version: "private-payer-checkpoint-v1", createdAt: new Date().toISOString(), requestId: "r1", quote, quoteFileSha256: createHash("sha256").update(quoteText).digest("hex"), intentSha256: "a".repeat(64), orderId: "0".repeat(64), args: { routerBaseUrl: BASE.routerBaseUrl, principalId: BASE.principalId, profileId: BASE.profileId, method: "GET", host: "provider.test", path: "/paid", outbound: OUTBOUND, inbound: SUBETHA_INBOUND, trust: "lab-fixture-ca" }, progress: { paymentId: "p1", ...(options.progress ?? {}) } }), { mode: 0o600 });
  writeFileSync(path.join(out, "evidence.json"), JSON.stringify({ runId: "r", startedAt: "s", trust: "lab-fixture-ca", synthetic: true, provider: { method: "GET", host: "provider.test", path: "/paid" }, gates: { inbound_settlement: { settled: false, uncertain: true, claimedTxRef: BURN }, outbound_settlement: { issued: false, receipt: false, uncertain: true }, private_delivery: {}, payer_receipt: { ok: false }, finality: { checked: false, note: "n" } } }), { mode: 0o600 });
}
const bytes = (out: string, name: string): string => readFileSync(path.join(out, name), "utf8");

describe("FR-H3 の 5: selectBurnTransfer（V2 facilitator と同じ選び方）", () => {
  const log = (token: string, to: string, amount: bigint, index: number) => ({ ...(transferLog(token, to, amount, index) as { address: string; topics: string[]; data: string }), logIndex: index });
  test("一致・先の log が別の宛先で後が一致・大小文字・選んだ log の logIndex", () => {
    expect(selectBurnTransfer([log(ZUSDC, PAY_TO, 2000n, 7)], EXPECT)).toEqual({ kind: "transferred", logIndex: 7 });
    expect(selectBurnTransfer([log(ZUSDC, ELSEWHERE, 2000n, 3), log(ZUSDC, PAY_TO, 2000n, 9)], EXPECT)).toEqual({ kind: "transferred", logIndex: 9 });
    expect(selectBurnTransfer([log(ZUSDC.toLowerCase(), PAY_TO.toUpperCase().replace("0X", "0x"), 2000n, 1)], EXPECT)).toEqual({ kind: "transferred", logIndex: 1 });
  });
  test("先の log が同じ宛先で額違い → amount_differs（後に一致があっても探さない・合計しない）", () => {
    expect(selectBurnTransfer([log(ZUSDC, PAY_TO, 1999n, 1), log(ZUSDC, PAY_TO, 2000n, 2)], EXPECT)).toEqual({ kind: "mismatch", reason: "amount_differs" });
    expect(selectBurnTransfer([log(ZUSDC, PAY_TO, 1000n, 1), log(ZUSDC, PAY_TO, 1000n, 2)], EXPECT)).toEqual({ kind: "mismatch", reason: "amount_differs" });
  });
  test("別 token・Transfer 以外の topic・topics の数違い・data 長違いは選ばない → no_transfer_to_pay_to", () => {
    const good = log(ZUSDC, PAY_TO, 2000n, 4);
    expect(selectBurnTransfer([log(OTHER_TOKEN, PAY_TO, 2000n, 1)], EXPECT)).toEqual({ kind: "mismatch", reason: "no_transfer_to_pay_to" });
    expect(selectBurnTransfer([{ ...good, topics: [`0x${"11".repeat(32)}`, ...good.topics.slice(1)] }], EXPECT)).toEqual({ kind: "mismatch", reason: "no_transfer_to_pay_to" });
    expect(selectBurnTransfer([{ ...good, topics: good.topics.slice(0, 2) }], EXPECT)).toEqual({ kind: "mismatch", reason: "no_transfer_to_pay_to" });
    expect(selectBurnTransfer([{ ...good, data: `${good.data}00` }], EXPECT)).toEqual({ kind: "mismatch", reason: "no_transfer_to_pay_to" });
    expect(selectBurnTransfer([], EXPECT)).toEqual({ kind: "mismatch", reason: "no_transfer_to_pay_to" });
  });
});

describe("FR-H3 の 1〜6: readBurn（fail closed）", () => {
  const read = (options: Parameters<typeof fakeBurnReader>[0]): Promise<BurnEvidence> => readBurn(fakeBurnReader(options), "test", EXPECT, "approve");
  const base = { txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n };
  test("transferred: block・blockHash・logIndex・txRef（小文字）", async () => {
    expect(await read(base)).toMatchObject({ verdict: "transferred", block: 0xb69b88, blockHash: BLOCK_HASH, logIndex: 151, txRef: BURN, rpcHost: "test", at: "approve" });
  });
  test("not_found（receipt が null）、wrong_chain、reorged、reverted（block の照合の後）", async () => {
    expect((await read({ ...base, receipt: null })).verdict).toBe("not_found");
    expect((await read({ ...base, chainId: "0x14a34" })).verdict).toBe("wrong_chain");
    expect((await read({ ...base, blockHash: `0x${"cc".repeat(32)}` })).verdict).toBe("reorged");
    expect((await read({ ...base, status: "0x0", blockHash: `0x${"cc".repeat(32)}` })).verdict).toBe("reorged");
    expect(await read({ ...base, status: "0x0" })).toMatchObject({ verdict: "reverted", block: 0xb69b88 });
  });
  test("mismatch（理由つき）", async () => {
    expect(await read({ ...base, logs: [transferLog(ZUSDC, PAY_TO, 1500n, 2)] })).toMatchObject({ verdict: "mismatch", reason: "amount_differs" });
    expect(await read({ ...base, logs: [transferLog(ZUSDC, ELSEWHERE, 2000n, 2)] })).toMatchObject({ verdict: "mismatch", reason: "no_transfer_to_pay_to" });
  });
  test("unreadable: hash 不一致・status 形違い・blockNumber/blockHash 形違い・logs の形違い・block が null・chainId 形違い。決して transferred/reverted にならない", async () => {
    const receipt = { transactionHash: BURN, status: "0x1", blockNumber: "0xb69b88", blockHash: BLOCK_HASH, logs: [transferLog(ZUSDC, PAY_TO, 2000n, 1)] };
    const cases: [string, Parameters<typeof fakeBurnReader>[0]][] = [
      ["hash", { ...base, receipt: { ...receipt, transactionHash: `0x${"77".repeat(32)}` } }],
      ["status 0x2", { ...base, receipt: { ...receipt, status: "0x2" } }],
      ["status missing", { ...base, receipt: { ...receipt, status: undefined } }],
      ["status number", { ...base, receipt: { ...receipt, status: 1 } }],
      ["blockNumber", { ...base, receipt: { ...receipt, blockNumber: "12" } }],
      ["blockHash", { ...base, receipt: { ...receipt, blockHash: "0x12" } }],
      ["logs not array", { ...base, receipt: { ...receipt, logs: {} } }],
      ["log address", { ...base, receipt: { ...receipt, logs: [{ ...transferLog(ZUSDC, PAY_TO, 2000n, 1), address: "0x1" }] } }],
      ["log topic", { ...base, receipt: { ...receipt, logs: [{ ...transferLog(ZUSDC, PAY_TO, 2000n, 1), topics: [TOPIC_TRANSFER, "0x12"] }] } }],
      ["log data", { ...base, receipt: { ...receipt, logs: [{ ...transferLog(ZUSDC, PAY_TO, 2000n, 1), data: "zz" }] } }],
      ["log index", { ...base, receipt: { ...receipt, logs: [{ ...transferLog(ZUSDC, PAY_TO, 2000n, 1), logIndex: 1 }] } }],
      ["receipt not object", { ...base, receipt: "0x1" }],
      ["chainId", { ...base, chainId: 11155111 }],
      ["blockNumber beyond safe integer", { ...base, receipt: { ...receipt, blockNumber: "0x20000000000001" } }],
      ["logIndex beyond safe integer", { ...base, receipt: { ...receipt, logs: [{ ...transferLog(ZUSDC, PAY_TO, 2000n, 1), logIndex: "0x20000000000001" }] } }],
    ];
    for (const [name, options] of cases) expect((await read(options)).verdict, name).toBe("unreadable");
    const nullBlock = fakeBurnReader(base);
    expect((await readBurn({ ...nullBlock, blockByNumber: async () => null }, "test", EXPECT, "approve")).verdict).toBe("unreadable");
  });
  test("rpc_unavailable: 例外（chainId・receipt・block）", async () => {
    for (const where of ["chainId", "receipt", "block"] as const) expect((await read({ ...base, throws: where })).verdict, where).toBe("rpc_unavailable");
  });
  test("拒否文: すべて「払い直さない」、reverted は払い直しを許さない、amount_differs は資金が届いたと言う", () => {
    const at = { readAt: "x", at: "approve" as const };
    for (const verdict of ["not_found", "reverted", "mismatch", "reorged", "unreadable", "wrong_chain", "rpc_unavailable"] as const) expect(burnRefusalOf({ ...at, verdict }), verdict).toContain("do NOT pay again");
    expect(burnRefusalOf({ ...at, verdict: "reverted" })).toContain("does not authorize a replacement payment");
    expect(burnRefusalOf({ ...at, verdict: "reverted" })).not.toMatch(/you may pay|pay a new transfer/);
    expect(burnRefusalOf({ ...at, verdict: "mismatch", reason: "amount_differs" })).toContain("did reach the burn address");
  });
});

describe("FR-H3: 承認の段（latch の前）", () => {
  const lab = fakeLab();
  test("transferred 以外は拒否: latch 無し・再開点と証跡のバイト列不変・refusals.json・文に「払い直さない」", async () => {
    const verdicts: [string, Parameters<typeof fakeBurnReader>[0]][] = [
      ["not_found", { txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n, receipt: null }],
      ["reverted", { txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n, status: "0x0" }],
      ["mismatch", { txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 1999n }],
      ["reorged", { txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n, blockHash: `0x${"cc".repeat(32)}` }],
      ["unreadable", { txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n, receipt: { transactionHash: BURN } }],
      ["wrong_chain", { txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n, chainId: "0x1" }],
      ["rpc_unavailable", { txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n, throws: "receipt" }],
    ];
    for (const [name, options] of verdicts) {
      const out = path.join(tmp, `refuse-${name}`);
      seed(out);
      const before = [bytes(out, "checkpoint.json"), bytes(out, "evidence.json")];
      const lines: string[] = [];
      const run = await runPrivatePayer({ ...BASE, ...lab, burnTxHash: BURN, burnReaderForTest: fakeBurnReader(options), outDir: out, approve: true, log: (l) => lines.push(l) });
      expect(run, name).toMatchObject({ ok: false, stage: "approve" });
      if (!run.ok) expect(run.reason, name).toContain("do NOT pay again");
      expect([bytes(out, "checkpoint.json"), bytes(out, "evidence.json")], name).toEqual(before);
      expect(existsSync(path.join(out, "refusals.json")), name).toBe(true);
      // log は結論だけ（hash・blockHash を出さない）。
      expect(lines.join("\n"), name).not.toContain(BURN);
      expect(lines.join("\n"), name).not.toContain(BLOCK_HASH);
    }
  });
  test("transferred → latch に進み evidence.burn（afterLatch で止める = 署名・purchase 無し）。--burn-precheck off は読まずに skipped_by_operator", async () => {
    const out = path.join(tmp, "ok");
    seed(out);
    const reader = fakeBurnReader({ txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n });
    await expect(runPrivatePayer({ ...BASE, ...lab, burnTxHash: BURN, burnReaderForTest: reader, outDir: out, approve: true, log: () => {}, hooksForTest: { afterLatch: () => { throw new Error("stop"); } } })).rejects.toThrow("stop");
    const evidence = JSON.parse(bytes(out, "evidence.json")) as PrivatePayerEvidence;
    expect(evidence.burn).toMatchObject({ verdict: "transferred", logIndex: 151, block: 0xb69b88, at: "approve" });
    expect((JSON.parse(bytes(out, "checkpoint.json")) as { progress: Record<string, unknown> }).progress).toMatchObject({ purchaseAttempted: true });
    const off = path.join(tmp, "off");
    seed(off);
    const untouched = fakeBurnReader({ txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n, receipt: null });
    await expect(runPrivatePayer({ ...BASE, ...lab, burnTxHash: BURN, burnPrecheck: "off", burnReaderForTest: untouched, outDir: off, approve: true, log: () => {}, hooksForTest: { afterLatch: () => { throw new Error("stop"); } } })).rejects.toThrow("stop");
    expect(untouched.calls.receipt).toBe(0);
    expect((JSON.parse(bytes(off, "evidence.json")) as PrivatePayerEvidence).burn).toMatchObject({ verdict: "skipped_by_operator", txRef: BURN });
  });
  test("照合中に承認期限が過ぎた → 拒否（latch 無し、文は照合を促し払い直しを促さない）。--burn-precheck off でも latch の直前に確かめる", async () => {
    for (const precheck of ["on", "off"] as const) {
      const out = path.join(tmp, `expire-${precheck}`);
      const deadlineMs = Date.now() + 60_000;
      seed(out, { deadlineMs });
      let clock = deadlineMs - 30_000;
      const reader = fakeBurnReader({ txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n });
      // 照合（receipt を読んだ時点）で時計を期限の後へ進める。off では最初の now() の後に進める。
      const slow = { ...reader, receipt: async (h: string) => { clock = deadlineMs + 1; return reader.receipt(h); } };
      let calls = 0;
      const now = (): number => { calls += 1; if (precheck === "off" && calls > 1) clock = deadlineMs + 1; return clock; };
      const before = bytes(out, "checkpoint.json");
      const run = await runPrivatePayer({ ...BASE, ...lab, burnTxHash: BURN, burnPrecheck: precheck, burnReaderForTest: slow, outDir: out, approve: true, now, log: () => {} });
      expect(run, precheck).toMatchObject({ ok: false, stage: "approve" });
      if (!run.ok) {
        expect(run.reason, precheck).toContain("expired during the burn check");
        expect(run.reason, precheck).toContain("never pay again");
        expect(run.reason, precheck).not.toContain("quote again");
      }
      expect(bytes(out, "checkpoint.json"), precheck).toBe(before);
    }
  });
});

/** 最小の JSON-RPC（loopback）: Sepolia の burn の読取（eth_chainId・eth_getTransactionReceipt・eth_getBlockByNumber）か、`base`（Base Sepolia の chain id と latest block）。 */
async function rpcServer(mode: "ok" | "rpc_error" | "null" | "no_result" | "hang" | "base"): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (c: Buffer) => (body += c.toString()));
    request.on("end", () => {
      const { method, id } = JSON.parse(body) as { method: string; id: number };
      hits.push(method);
      const reply = (payload: Record<string, unknown>) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id, ...payload })); };
      if (mode === "hang" && method === "eth_getTransactionReceipt") return; // 応答しない（timeout）
      if (mode === "base") return method === "eth_chainId" ? reply({ result: "0x14a34" }) : reply({ result: { number: "0x3e8", hash: `0x${"ab".repeat(32)}`, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` } });
      if (mode === "rpc_error" && method === "eth_getTransactionReceipt") return reply({ error: { code: -32000, message: "boom" } });
      if (mode === "no_result" && method === "eth_getTransactionReceipt") return reply({});
      if (method === "eth_chainId") return reply({ result: "0xaa36a7" });
      if (method === "eth_getTransactionReceipt") return reply({ result: mode === "null" ? null : { transactionHash: BURN, status: "0x1", blockNumber: "0x10", blockHash: BLOCK_HASH, logs: [transferLog(ZUSDC, PAY_TO, 2000n, 5)] } });
      return reply({ result: { number: "0x10", hash: BLOCK_HASH } });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

describe("FR-H6: 実際の JSON-RPC の reader（loopback の fixture）と RPC の優先順位", () => {  test("--sepolia-rpc-url（options）が env より優先、transferred と rpcHost。JSON-RPC error は rpc_unavailable、null の receipt は not_found", async () => {
    const lab = fakeLab();
    const chosen = await rpcServer("ok");
    const envServer = await rpcServer("ok");
    const previous = process.env["SUBETHA_SEPOLIA_RPC_URL"];
    process.env["SUBETHA_SEPOLIA_RPC_URL"] = envServer.url;
    try {
      const out = path.join(tmp, "rpc-ok");
      seed(out);
      await expect(runPrivatePayer({ ...BASE, ...lab, burnTxHash: BURN, sepoliaRpcUrl: chosen.url, outDir: out, approve: true, log: () => {}, hooksForTest: { afterLatch: () => { throw new Error("stop"); } } })).rejects.toThrow("stop");
      expect(chosen.hits).toEqual(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
      expect(envServer.hits).toEqual([]);
      expect((JSON.parse(bytes(out, "evidence.json")) as PrivatePayerEvidence).burn).toMatchObject({ verdict: "transferred", logIndex: 5, rpcHost: new URL(chosen.url).host });
      // env だけ。
      const out2 = path.join(tmp, "rpc-env");
      seed(out2);
      await expect(runPrivatePayer({ ...BASE, ...lab, burnTxHash: BURN, outDir: out2, approve: true, log: () => {}, hooksForTest: { afterLatch: () => { throw new Error("stop"); } } })).rejects.toThrow("stop");
      expect(envServer.hits.length).toBe(3);
    } finally {
      if (previous === undefined) delete process.env["SUBETHA_SEPOLIA_RPC_URL"];
      else process.env["SUBETHA_SEPOLIA_RPC_URL"] = previous;
    }
    const failing = await rpcServer("rpc_error");
    const nulls = await rpcServer("null");
    const missing = await rpcServer("no_result");
    const hanging = await rpcServer("hang");
    expect((await readBurn(rpcBurnReader(failing.url), "h", EXPECT, "approve")).verdict).toBe("rpc_unavailable");
    expect((await readBurn(rpcBurnReader(nulls.url), "h", EXPECT, "approve")).verdict).toBe("not_found");
    // result の欄が無い応答は null（未 mine）と区別して読めない。
    expect((await readBurn(rpcBurnReader(missing.url), "h", EXPECT, "approve")).verdict).toBe("rpc_unavailable");
    expect((await readBurn(rpcBurnReader(hanging.url, 300), "h", EXPECT, "approve")).verdict).toBe("rpc_unavailable");
  });
  test("壊れた RPC の URL（options・env・recover）は構造化された拒否・観測になる（例外で落ちない）", async () => {
    const lab = fakeLab();
    const out = path.join(tmp, "bad-url");
    seed(out);
    const before = bytes(out, "checkpoint.json");
    const run = await runPrivatePayer({ ...BASE, ...lab, burnTxHash: BURN, sepoliaRpcUrl: "http://[", outDir: out, approve: true, log: () => {} });
    expect(run).toMatchObject({ ok: false, stage: "approve" });
    if (!run.ok) {
      expect(run.reason).toContain("not a valid http(s) URL");
      expect(run.reason).toContain("do NOT pay again");
    }
    expect(bytes(out, "checkpoint.json")).toBe(before);
    expect(existsSync(path.join(out, "refusals.json"))).toBe(true);
    const previous = process.env["SUBETHA_SEPOLIA_RPC_URL"];
    process.env["SUBETHA_SEPOLIA_RPC_URL"] = "ftp://example";
    try {
      const envRun = await runPrivatePayer({ ...BASE, ...lab, burnTxHash: BURN, outDir: out, approve: true, log: () => {} });
      if (!envRun.ok) expect(envRun.reason).toContain("not a valid http(s) URL");
      const rec = path.join(tmp, "bad-url-recover");
      seed(rec, { progress: { purchaseAttempted: true, burnTxHash: BURN } });
      const client = { status: async () => ({ found: false as const, status: 0, reason: "transport_failed" }) as never, privateRecord: async () => ({ ok: false as const, error: "transport_failed", status: 0 }) };
      const head = { number: 1000, hash: `0x${"ab".repeat(32)}`, timestamp: Math.floor(Date.now() / 1000) };
      const r = await recoverPrivatePayer({ routerBaseUrl: BASE.routerBaseUrl, principalId: BASE.principalId, token: "t", outDir: rec, clientForTest: client, log: () => {}, chain: { readerForTest: { chainId: async () => 84532, latestBlock: async () => head, blockByNumber: async () => head, authorizationState: async () => false, findAuthorization: async () => [], receiptLogsOf: async () => undefined } } });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.evidence.burn).toMatchObject({ verdict: "rpc_unavailable", at: "recover" });
    } finally {
      if (previous === undefined) delete process.env["SUBETHA_SEPOLIA_RPC_URL"];
      else process.env["SUBETHA_SEPOLIA_RPC_URL"] = previous;
    }
  });
});

describe("FR-H4・H5: 回復時の burn の観測（決済のゲートは変えない）とコンソールの射影", () => {
  const statusUnknown = { found: true, status: 200, projection: { status: "unknown", terminalReason: "transport_uncertain" } };
  const client = { status: async () => statusUnknown as never, privateRecord: async () => ({ ok: false as const, error: "record_not_available", status: 409 }) };
  const head = { number: 1000, hash: `0x${"ab".repeat(32)}`, timestamp: Math.floor(Date.now() / 1000) };
  const baseReader: ChainReader = { chainId: async () => 84532, latestBlock: async () => head, blockByNumber: async () => head, authorizationState: async () => false, findAuthorization: async () => [], receiptLogsOf: async () => undefined };
  const recover = (out: string, burnReader: ReturnType<typeof fakeBurnReader>) => recoverPrivatePayer({ routerBaseUrl: BASE.routerBaseUrl, principalId: BASE.principalId, token: "t", outDir: out, clientForTest: client, log: () => {}, chain: { readerForTest: baseReader, burnReaderForTest: burnReader } });
  test("transferred でも uncertain は残る、繰り返しの回復で最新に置き換わり前の値は recovery-log に、後の読取が reorged/unreadable/Router 不明でもゲート不変", async () => {
    const out = path.join(tmp, "recover");
    seed(out, { progress: { purchaseAttempted: true, burnTxHash: BURN } });
    const first = await recover(out, fakeBurnReader({ txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.evidence.burn).toMatchObject({ verdict: "transferred", at: "recover", logIndex: 151 });
    expect(first.evidence.gates.inbound_settlement).toMatchObject({ settled: false, uncertain: true, claimedTxRef: BURN });
    expect(first.evidence.gates.inbound_settlement.chain).toBeUndefined();
    expect(first.evidence.chain?.skipped).toMatchObject({ inbound: "protocol" });
    const second = await recover(out, fakeBurnReader({ txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n, blockHash: `0x${"cc".repeat(32)}` }));
    if (second.ok) {
      expect(second.evidence.burn?.verdict).toBe("reorged");
      expect(second.evidence.gates.inbound_settlement).toMatchObject({ settled: false, uncertain: true });
    }
    const third = await recover(out, fakeBurnReader({ txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n, receipt: { transactionHash: BURN } }));
    if (third.ok) expect(third.evidence.burn?.verdict).toBe("unreadable");
    const log = bytes(out, "recovery-log.json");
    expect(log).toContain("transferred");
    expect(log).toContain("reorged");
    expect(log).not.toContain(BURN);
  });
  test("burnTxHash の無い再開点・--chain 無しの回復は burn を読まない", async () => {
    const out = path.join(tmp, "recover-nohash");
    seed(out, { progress: { purchaseAttempted: true } });
    const reader = fakeBurnReader({ txHash: BURN, token: ZUSDC, payTo: PAY_TO, amount: 2000n });
    const r = await recover(out, reader);
    expect(reader.calls.receipt).toBe(0);
    if (r.ok) expect(r.evidence.burn).toBeUndefined();
    const out2 = path.join(tmp, "recover-nochain");
    seed(out2, { progress: { purchaseAttempted: true, burnTxHash: BURN } });
    const r2 = await recoverPrivatePayer({ routerBaseUrl: BASE.routerBaseUrl, principalId: BASE.principalId, token: "t", outDir: out2, clientForTest: client, log: () => {} });
    if (r2.ok) expect(r2.evidence.burn).toBeUndefined();
  });
  test("consoleProjectionOf は burn を {verdict, block} に置き換える（txRef・blockHash・rpcHost を出さない）。ゲートの tx 参照の除去はそのまま", () => {
    const evidence = { runId: "r", startedAt: "s", trust: "mozilla", synthetic: false, provider: { method: "GET", host: "h", path: "/p" }, burn: { verdict: "transferred", txRef: BURN, block: 7, blockHash: BLOCK_HASH, logIndex: 1, readAt: "t", rpcHost: "rpc.example", at: "approve" }, gates: { inbound_settlement: { settled: true, txRef: BURN, claimedTxRef: BURN }, outbound_settlement: { issued: true, receipt: true, txRef: `0x${"99".repeat(32)}` }, private_delivery: {}, payer_receipt: { ok: true }, finality: { checked: false, note: "n" } } } as unknown as PrivatePayerEvidence;
    const projected = consoleProjectionOf(evidence);
    expect(projected["burn"]).toEqual({ verdict: "transferred", block: 7 });
    const text = JSON.stringify(projected);
    for (const secret of [BURN, BLOCK_HASH, "rpc.example", `0x${"99".repeat(32)}`]) expect(text).not.toContain(secret);
  });
});

describe("FR-H2・H5: quote の出力と、CLI の stdout・stderr に burn の hash・blockHash・RPC の URL が出ないこと", () => {
  test("quotedOutputOf: payBy があれば「payBy までに mine」、null なら「払わない」（上位の note も）", () => {
    const deadlineMs = Date.parse("2026-10-23T01:00:00.000Z");
    const quote = { paymentId: "p1", approval: { deadlineMs }, private: { inbound: { payTo: PAY_TO, total: "2000", network: "eip155:11155111", asset: ZUSDC, fundsMoveAt: "payer_burn_before_credential" } } } as never;
    const ok = quotedOutputOf(quote, "/q.json", deadlineMs - 600_000);
    expect(ok).toMatchObject({ stage: "quoted", payFirst: { payBy: "2026-10-23T00:57:00.000Z" } });
    expect(String(ok["note"])).toContain("mined by payFirst.payBy (2026-10-23T00:57:00.000Z)");
    const short = quotedOutputOf(quote, "/q.json", deadlineMs - 60_000);
    expect(short).toMatchObject({ payFirst: { payBy: null } });
    expect(String(short["note"])).toContain("DO NOT PAY");
    expect(String(short["note"])).not.toContain("transfer exactly");
    const x402 = quotedOutputOf({ paymentId: "p2", approval: { deadlineMs }, private: { inbound: { fundsMoveAt: "router_settle_after_credential" } } } as never, "/q.json");
    expect(x402).not.toHaveProperty("payFirst");
  });

  const cli = (args: string[], env: Record<string, string> = {}): Promise<{ status: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, ["--import", "tsx", "tools/private-payer.ts", ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SUBETHA_PAYER_PRIVATE_KEY: "", PRIVATE_PAYER_TOKEN: "t", SUBETHA_SEPOLIA_RPC_URL: "", ...env } }, (error, stdout, stderr) => {
        resolve({ status: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const common = (out: string) => ["--router", BASE.routerBaseUrl, "--principal", "owner", "--profile", "priv-subetha", "--method", "GET", "--host", "provider.test", "--path", "/paid", "--outbound-protocol", "x402", "--outbound-network", OUTBOUND.network, "--outbound-asset", OUTBOUND.asset, "--outbound-pay-to", OUTBOUND.payTo, "--outbound-max-amount", "1000", "--inbound-network", SUBETHA_INBOUND.network, "--inbound-asset", ZUSDC, "--inbound-max-total", "2000", "--trust", "lab-fixture-ca", "--out", out];
  const CANARY_PATH = "/rpc-canary-7f3a9e";
  const assertClean = (name: string, result: { stdout: string; stderr: string }, rpcUrls: readonly string[]): void => {
    for (const stream of [result.stdout, result.stderr]) {
      for (const secret of [BURN, BLOCK_HASH, CANARY_PATH, ...rpcUrls.map((u) => new URL(u).host)]) expect(stream, `${name}: ${secret}`).not.toContain(secret);
    }
  };

  test("approve の拒否・approve（照合が通り purchase の応答喪失）・bypass・recover（Router 不在）の 4 場面", async () => {
    const lab = fakeLab();
    const env = { SUBETHA_ZKTLS_SRS_DAT: lab.srsPath };
    const notMined = await rpcServer("null");
    const mined = await rpcServer("ok");
    const base = await rpcServer("base");
    const refusedOut = path.join(tmp, "cli-refused");
    seed(refusedOut);
    const refused = await cli([...common(refusedOut), "--lab-dir", lab.labDir, "--approve", "--burn-tx-hash", BURN, "--sepolia-rpc-url", `${notMined.url}${CANARY_PATH}`], env);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('burn check {"verdict":"not_found"}');
    expect(refused.stderr).toContain("do NOT pay again");
    assertClean("refused", refused, [notMined.url]);
    const approvedOut = path.join(tmp, "cli-approved");
    seed(approvedOut);
    const approved = await cli([...common(approvedOut), "--lab-dir", lab.labDir, "--approve", "--burn-tx-hash", BURN, "--sepolia-rpc-url", `${mined.url}${CANARY_PATH}`], env);
    expect(approved.status).toBe(1);
    expect(approved.stderr).toContain('"verdict":"transferred"');
    expect(approved.stdout).toContain('"burn":{"verdict":"transferred","block":16}');
    assertClean("approved", approved, [mined.url]);
    expect(bytes(approvedOut, "evidence.json")).toContain(BURN);
    const bypassOut = path.join(tmp, "cli-bypass");
    seed(bypassOut);
    const bypass = await cli([...common(bypassOut), "--lab-dir", lab.labDir, "--approve", "--burn-tx-hash", BURN, "--burn-precheck", "off"], env);
    expect(bypass.stdout).toContain('"burn":{"verdict":"skipped_by_operator"}');
    assertClean("bypass", bypass, []);
    const recovered = await cli(["--recover", "--chain", "--router", BASE.routerBaseUrl, "--principal", "owner", "--out", approvedOut, "--rpc-url", `${base.url}${CANARY_PATH}`, "--sepolia-rpc-url", `${mined.url}${CANARY_PATH}`, "--lab-dir", lab.labDir], env);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(recovered.stderr).toContain('private-payer: burn {"verdict":"transferred","block":16}');
    expect(recovered.stdout).toContain('"burn":{"verdict":"transferred","block":16}');
    // Router 不在でも受信の不確実は残る（burn の観測で外さない）。
    expect(recovered.stdout).toContain('"uncertain":true');
    assertClean("recover", recovered, [mined.url, base.url]);
  }, 120_000);

  test("CLI: --burn-precheck の値・--sepolia-rpc-url の形（approve と recover）は exit 2", async () => {
    const out = path.join(tmp, "cli-validate");
    expect((await cli([...common(out), "--approve", "--burn-tx-hash", BURN, "--burn-precheck", "maybe"])).status).toBe(2);
    expect((await cli([...common(out), "--approve", "--burn-tx-hash", BURN, "--sepolia-rpc-url", "http://["])).status).toBe(2);
    expect((await cli([...common(out), "--approve", "--burn-tx-hash", BURN, "--sepolia-rpc-url", "ftp://x"])).status).toBe(2);
    expect((await cli(["--recover", "--chain", "--router", BASE.routerBaseUrl, "--principal", "owner", "--out", out, "--sepolia-rpc-url", "http://["])).status).toBe(2);
    expect(existsSync(out)).toBe(false);
  }, 60_000);
});
