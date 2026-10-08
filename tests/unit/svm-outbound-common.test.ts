/**
 * SVM 送信の共有の部品（`src/adapters/outbound/svm-outbound-common.ts`。`docs/mpp-solana-design.md` §4.5・§5.1、タスク M2）。
 * transport は偽物（JSON-RPC の応答を返すだけ。接続しない）。起動時の検査が RPC に出る前に落ちる条件と、残高・blockhash の読み方。
 */
import { describe, expect, test } from "vitest";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { createSvmOutboundCommon } from "../../src/adapters/outbound/svm-outbound-common.js";
import type { GuardedTransport } from "../../src/net/guarded-fetch.js";

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ROUTER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const PROVIDER = "4LrB4peq75FSg9UhSyfhp4onb6GMKgEtC3o3wndgguBc";
const TOKEN_PROGRAM = String(TOKEN_PROGRAM_ADDRESS);

function fakeRpc(reply: (method: string, params: unknown[]) => unknown): { transport: GuardedTransport; calls: { method: string; params: unknown[] }[] } {
  const calls: { method: string; params: unknown[] }[] = [];
  const transport: GuardedTransport = {
    allowLoopback: false,
    boundsDns: true,
    report: () => {},
    fetch: (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      calls.push({ method: body.method, params: body.params });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: reply(body.method, body.params) }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as GuardedTransport["fetch"],
  };
  return { transport, calls };
}

function common(transport: GuardedTransport, destinations: Record<string, { payTo: string; asset: string; scheme: string }>, staticScheme = "exact", operators = new Set<string>()) {
  return createSvmOutboundCommon({ label: "svm test", rpc: { url: "https://rpc.test/", transport }, rpcTimeoutMs: 1_000, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM, routerAddress: ROUTER, operatorAddresses: operators, destinations, staticScheme });
}

async function ataOf(owner: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ mint: address(MINT), owner: address(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return String(ata);
}

function ataReply(owner: string) {
  return { context: { slot: 1 }, value: { data: { program: "spl-token", parsed: { type: "account", info: { mint: MINT, owner, state: "initialized", isNative: false, tokenAmount: { amount: "0", decimals: 6, uiAmount: 0, uiAmountString: "0" } } }, space: 165 }, executable: false, lamports: 2_039_280, owner: TOKEN_PROGRAM, rentEpoch: 0, space: 165 } };
}

describe("startup: 静的 route の destination の検査は RPC に出る前", () => {
  test("scheme が adapter のもの（staticScheme）でなければ起動しない。asset 違い・payTo の形違いも。RPC は 0 回", async () => {
    for (const [label, destination, scheme] of [
      ["scheme 違い（x402 に solana/charge）", { payTo: PROVIDER, asset: MINT, scheme: "solana/charge" }, "exact"],
      ["scheme 違い（MPP に exact）", { payTo: PROVIDER, asset: MINT, scheme: "exact" }, "solana/charge"],
      ["asset 違い", { payTo: PROVIDER, asset: "So11111111111111111111111111111111111111112", scheme: "exact" }, "exact"],
      ["payTo の形違い", { payTo: "not-a-key", asset: MINT, scheme: "exact" }, "exact"],
    ] as const) {
      const rpc = fakeRpc(() => null);
      await expect(common(rpc.transport, { r: destination }, scheme).startup(), label).rejects.toThrow(/static route r has a destination this adapter cannot pay/);
      expect(rpc.calls, label).toEqual([]);
    }
  });

  test("Router 自身の ATA に払う route は起動しない。宛先 ATA が無ければ起動しない（getAccountInfo 1 回）", async () => {
    const rpc = fakeRpc(() => null);
    await expect(common(rpc.transport, { self: { payTo: ROUTER, asset: MINT, scheme: "exact" } }).startup()).rejects.toThrow(/pays the Router's own token account/);
    expect(rpc.calls).toEqual([]);
    const missing = fakeRpc(() => ({ context: { slot: 1 }, value: null }));
    await expect(common(missing.transport, { r: { payTo: PROVIDER, asset: MINT, scheme: "exact" } }).startup()).rejects.toThrow(/does not exist or is not the table's ATA/);
    expect(missing.calls.map((c) => c.method)).toEqual(["getAccountInfo"]);
  });

  test("通る: ready() は startup の後だけ、静的 route の ATA が固まり、運用者の集合に Router の ATA と運用者の公開鍵の ATA が足される。MPP の scheme でも同じ部品で通る", async () => {
    const providerAta = await ataOf(PROVIDER);
    const routerAta = await ataOf(ROUTER);
    for (const scheme of ["exact", "solana/charge"]) {
      const rpc = fakeRpc((method, params) => (method === "getAccountInfo" && (params as string[])[0] === providerAta ? ataReply(PROVIDER) : null));
      const OTHER_OPERATOR = "4LrB4peq75FSg9UhSyfhp4onb6GMKgEtC3o3wndgguBd".replace(/d$/, "c"); // 別の運用者（受取 owner の形の公開鍵）
      const operators = new Set<string>([ROUTER, "not-a-key", OTHER_OPERATOR]);
      const c = common(rpc.transport, { r: { payTo: PROVIDER, asset: MINT, scheme } }, scheme, operators);
      expect(() => c.ready()).toThrow(/startup\(\) has not completed/);
      await expect(c.balanceOf("r", MINT)).rejects.toThrow(/startup\(\) has not completed/);
      await c.startup();
      expect(c.ready()).toBe(routerAta);
      expect(c.staticAtaOf("r")).toBe(providerAta);
      expect(operators.has(routerAta)).toBe(true);
      // 集合にある別の運用者の公開鍵の ATA も足される（§2.3 (c)）。導けない文字列はそのまま。
      expect(operators.has(await ataOf(OTHER_OPERATOR))).toBe(true);
      expect(operators.has("not-a-key")).toBe(true);
      expect(operators.size).toBe(5);
      expect(rpc.calls.map((call) => call.method)).toEqual(["getAccountInfo"]);
    }
  });
});

describe("balanceOf と blockhashOf", () => {
  test("balanceOf: 自分の ATA の getTokenAccountBalance 1 回。別の資産・形違いは throw", async () => {
    const providerAta = await ataOf(PROVIDER);
    const routerAta = await ataOf(ROUTER);
    let balance: unknown = { context: { slot: 1 }, value: { amount: "123456", decimals: 6, uiAmount: 0.123456, uiAmountString: "0.123456" } };
    const rpc = fakeRpc((method, params) => (method === "getAccountInfo" ? ((params as string[])[0] === providerAta ? ataReply(PROVIDER) : null) : balance));
    const c = common(rpc.transport, { r: { payTo: PROVIDER, asset: MINT, scheme: "exact" } });
    await c.startup();
    expect(await c.balanceOf("r", MINT)).toBe(123456n);
    expect(rpc.calls.at(-1)).toEqual({ method: "getTokenAccountBalance", params: [routerAta, { commitment: "confirmed" }] });
    await expect(c.balanceOf("r", "So11111111111111111111111111111111111111112")).rejects.toThrow(/different asset/);
    // 桁数の上限は無い（括り出す前と同じ）: 31 桁も通る。
    balance = { context: { slot: 1 }, value: { amount: "1" + "0".repeat(30) } };
    expect(await c.balanceOf("r", MINT)).toBe(10n ** 30n);
    balance = { context: { slot: 1 }, value: { amount: 5 } };
    await expect(c.balanceOf("r", MINT)).rejects.toThrow(/did not return a token balance/);
    balance = { context: { slot: 1 }, value: { amount: "01" } };
    await expect(c.balanceOf("r", MINT)).rejects.toThrow(/did not return a token balance/);
  });

  test("blockhashOf: blockhash と lastValidBlockHeight（数値か 10 進文字列）。形違いは undefined", () => {
    const c = common(fakeRpc(() => null).transport, {});
    expect(c.blockhashOf({ result: { value: { blockhash: ROUTER, lastValidBlockHeight: 1000 } } })).toEqual({ blockhash: ROUTER, lastValidBlockHeight: 1000n });
    expect(c.blockhashOf({ result: { value: { blockhash: ROUTER, lastValidBlockHeight: "1000" } } })).toEqual({ blockhash: ROUTER, lastValidBlockHeight: 1000n });
    expect(c.blockhashOf({ result: { value: { blockhash: "short", lastValidBlockHeight: 1000 } } })).toBeUndefined();
    expect(c.blockhashOf({ result: { value: { blockhash: ROUTER, lastValidBlockHeight: 0 } } })).toBeUndefined();
    expect(c.blockhashOf(undefined)).toBeUndefined();
  });
});
