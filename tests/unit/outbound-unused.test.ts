/**
 * 断られた支払いの authorization が使われていないことを確かめる道具（`docs/outbound-rejected-unused-check.md` U-4・U-5、AC-3・AC-3b）。
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { authorizationStateCalldata, checkUnused, httpRpc, main, recordedAuthorizationOf, type Rpc } from "../../tools/outbound-unused.js";

const PAYMENT = "pay-1";
const SENT = { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", from: "0x5d78CBD6fFA81a5dBe435ccfC79271a0F6a42274", nonce: `0x${"ab".repeat(32)}`, validBefore: "1795676232" };
const HASH = `0x${"9f".repeat(32)}`;
const row = (event: string, patch: Record<string, unknown>, paymentId = PAYMENT) => JSON.stringify({ seq: 1, paymentId, event, patch });
const JOURNAL = [row("created", {}), row("destination_pending", { attempt: 1 }), row("dest_failed", { outcome: "rejected", reason: "destination_rejected", authorization: SENT })].join("\n");
const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

type Call = { method: string; params: readonly unknown[] };
/** 偽の RPC。`state` は記録の (asset, from, nonce) の組の時だけ返し、それ以外の組は 0（AC-3b）。 */
function fakeRpc(options: { chainId?: string; timestamp?: number; state?: bigint; fail?: string } = {}): { rpc: Rpc; calls: Call[] } {
  const calls: Call[] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push({ method, params });
    if (options.fail === method) throw new Error("boom https://rpc.example/?key=SECRET");
    if (method === "eth_chainId") return options.chainId ?? hex(84532);
    if (method === "eth_getBlockByNumber") return { number: hex(63_765_819), hash: HASH, timestamp: hex(options.timestamp ?? Number(SENT.validBefore) + 100) };
    if (method === "eth_call") {
      const [call, block] = params as [{ to: string; data: string }, unknown];
      const ours = call.to === SENT.asset && call.data === authorizationStateCalldata(SENT.from, SENT.nonce) && JSON.stringify(block) === JSON.stringify({ blockHash: HASH, requireCanonical: true });
      return word(ours ? (options.state ?? 0n) : 0n);
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls };
}

describe("記録の読み取り", () => {
  test("最後の dest_failed の authorization だけ。形違い・他の支払い・欄なしは undefined", () => {
    expect(recordedAuthorizationOf(JOURNAL, PAYMENT)).toEqual(SENT);
    expect(recordedAuthorizationOf(JOURNAL, "other")).toBeUndefined();
    expect(recordedAuthorizationOf([row("dest_failed", { outcome: "rejected" })].join("\n"), PAYMENT)).toBeUndefined();
    for (const bad of [{ nonce: "0x12" }, { validBefore: 1795676232 }, { from: "x" }, { network: "solana:devnet" }, { asset: "0x1" }]) {
      expect(recordedAuthorizationOf(row("dest_failed", { authorization: { ...SENT, ...bad } }), PAYMENT), JSON.stringify(bad)).toBeUndefined();
    }
    // 後の行が勝つ（欄の無い後の行なら undefined）。
    expect(recordedAuthorizationOf(`${JOURNAL}\n${row("dest_failed", { outcome: "rejected" })}`, PAYMENT)).toBeUndefined();
    expect(recordedAuthorizationOf(`not json\n${JOURNAL}`, PAYMENT)).toEqual(SENT);
  });
  test("calldata は selector + from（32 バイトに詰める）+ nonce", () => {
    expect(authorizationStateCalldata(SENT.from, SENT.nonce)).toBe(`0xe94a0102${"0".repeat(24)}5d78cbd6ffa81a5dbe435ccfc79271a0f6a42274${"ab".repeat(32)}`);
  });
});

describe("AC-3: 結果", () => {
  test("unused_after_expiry: 確定したブロックの hash で、asset に記録の from・nonce を問い合わせる", async () => {
    const { rpc, calls } = fakeRpc({ state: 0n });
    expect(await checkUnused(JOURNAL, PAYMENT, rpc)).toEqual({ paymentId: PAYMENT, validBefore: SENT.validBefore, blockNumber: 63_765_819, blockHash: HASH, blockTimestamp: Number(SENT.validBefore) + 100, result: "unused_after_expiry" });
    expect(calls.map((c) => c.method)).toEqual(["eth_chainId", "eth_getBlockByNumber", "eth_call"]);
    expect(calls[1]!.params).toEqual(["finalized", false]);
    expect(calls[2]!.params).toEqual([{ to: SENT.asset, data: authorizationStateCalldata(SENT.from, SENT.nonce) }, { blockHash: HASH, requireCanonical: true }]);
  });
  test("AC-3b: 使われた・取り消された（記録の組だけ true）は used_or_canceled。別の組に問い合わせれば false になるので取り違えは落ちる", async () => {
    expect((await checkUnused(JOURNAL, PAYMENT, fakeRpc({ state: 1n }).rpc)).result).toBe("used_or_canceled");
  });
  test("期限の境目: 確定したブロックの時刻が validBefore − 1 は too_early、ちょうどと + 1 は確かめる", async () => {
    const v = Number(SENT.validBefore);
    const early = fakeRpc({ timestamp: v - 1 });
    expect(await checkUnused(JOURNAL, PAYMENT, early.rpc)).toMatchObject({ result: "too_early", blockTimestamp: v - 1 });
    expect(early.calls.map((c) => c.method)).not.toContain("eth_call");
    expect((await checkUnused(JOURNAL, PAYMENT, fakeRpc({ timestamp: v }).rpc)).result).toBe("unused_after_expiry");
    expect((await checkUnused(JOURNAL, PAYMENT, fakeRpc({ timestamp: v + 1 }).rpc)).result).toBe("unused_after_expiry");
  });
  test("no_authorization_recorded は RPC を呼ばない。chain_mismatch は時刻も状態も読まない", async () => {
    const none = fakeRpc();
    expect(await checkUnused(row("dest_failed", { outcome: "rejected" }), PAYMENT, none.rpc)).toEqual({ paymentId: PAYMENT, result: "no_authorization_recorded" });
    expect(none.calls).toEqual([]);
    const other = fakeRpc({ chainId: hex(1) });
    expect((await checkUnused(JOURNAL, PAYMENT, other.rpc)).result).toBe("chain_mismatch");
    expect(other.calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });
  test("rpc_error: 呼び出しの失敗・形違い・2 以上の状態。URL や例外の文は出さない", async () => {
    for (const fail of ["eth_chainId", "eth_getBlockByNumber", "eth_call"]) {
      const report = await checkUnused(JOURNAL, PAYMENT, fakeRpc({ fail }).rpc);
      expect(report.result, fail).toBe("rpc_error");
      expect(JSON.stringify(report)).not.toContain("SECRET");
    }
    expect((await checkUnused(JOURNAL, PAYMENT, fakeRpc({ state: 2n }).rpc)).result).toBe("rpc_error");
    expect((await checkUnused(JOURNAL, PAYMENT, async (m) => (m === "eth_chainId" ? 84532 : null))).result).toBe("rpc_error");
    expect((await checkUnused(JOURNAL, PAYMENT, async (m) => (m === "eth_chainId" ? hex(84532) : { number: "0x1", hash: "0x12", timestamp: "0x1" }))).result).toBe("rpc_error");
  });
});

describe("U-5: RPC の transport と CLI", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function serve(handler: (body: { method: string }, res: import("node:http").ServerResponse) => void): Promise<string> {
    const server = createServer((req, res) => {
      let text = "";
      req.on("data", (c: Buffer) => (text += c.toString()));
      req.on("end", () => handler(JSON.parse(text) as { method: string }, res));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address() as { port: number };
    return `http://127.0.0.1:${String(address.port)}/rpc`;
  }
  test("https だけ。loopback の http は --allow-loopback の時だけ", () => {
    expect(() => httpRpc("http://rpc.example/", true)).toThrow(/https/);
    expect(() => httpRpc("http://127.0.0.1:9/", false)).toThrow(/https/);
    expect(() => httpRpc("http://127.0.0.1:9/", true)).not.toThrow();
    expect(() => httpRpc("https://rpc.example/", false)).not.toThrow();
  });
  test("redirect・64 KiB を越える応答・JSON-RPC の error は失敗", async () => {
    const redirect = await serve((_b, res) => res.writeHead(302, { location: "http://127.0.0.1:1/" }).end());
    await expect(httpRpc(redirect, true)("eth_chainId", [])).rejects.toThrow();
    const big = await serve((_b, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(70_000) })));
    await expect(httpRpc(big, true)("eth_chainId", [])).rejects.toThrow();
    const error = await serve((_b, res) => res.writeHead(200).end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "no" } })));
    await expect(httpRpc(error, true)("eth_chainId", [])).rejects.toThrow();
  });
  test("CLI: 1 行の JSON、unused_after_expiry は 0、too_early は 1、引数が足りなければ 2", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ou-"));
    dirs.push(dir);
    const journal = path.join(dir, "j.ndjson");
    writeFileSync(journal, `${JOURNAL}\n`);
    let timestamp = Number(SENT.validBefore);
    const url = await serve((body, res) => {
      const result = body.method === "eth_chainId" ? hex(84532) : body.method === "eth_getBlockByNumber" ? { number: hex(5), hash: HASH, timestamp: hex(timestamp) } : word(0n);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (out.push(String(chunk)), true));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["--journal", journal, "--payment", PAYMENT, "--rpc", url, "--allow-loopback"])).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ result: "unused_after_expiry", blockNumber: 5 });
    timestamp -= 1;
    expect(await main(["--journal", journal, "--payment", PAYMENT, "--rpc", url, "--allow-loopback"])).toBe(1);
    expect(JSON.parse(out.pop()!)).toMatchObject({ result: "too_early" });
    expect(await main(["--journal", journal, "--payment", PAYMENT])).toBe(2);
    expect(await main(["--journal", journal, "--payment", PAYMENT, "--rpc", url])).toBe(2);
  });
});
