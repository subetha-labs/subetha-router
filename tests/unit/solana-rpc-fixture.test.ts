/**
 * Solana RPC の fixture（`tests/fixtures/solana-rpc.ts`）の送信向けの追加（送信の設計 §7.1、タスク U6-b）:
 * 複数の ATA と残高、`getTokenAccountBalance`（未知の口座は JSON-RPC の error）、従来の単一の `ata` の互換、残高の文字列の精度。
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { startSolanaRpc, uiAmountStringOf, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ATA_A = "7pjZnp8kuG7hy7Gav4jG282PovTKnipAYUcT6REA63fN";
const ATA_B = "6MycWeoQv6kaLCKa4VwAP35tBhzZsFSBKJWH9heAnL6y";
const OWNER_A = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
const OWNER_B = "HTazrCcGEzWPKSKLFtbzszPJYTrFdD6xFHN4rLbwQng5";
const BIG = "9007199254740993"; // 2^53 + 1: Number では表せない

async function rpc(fixture: SolanaRpcFixture, method: string, params: unknown[]): Promise<Record<string, unknown>> {
  const response = await fetch(fixture.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) });
  return (await response.json()) as Record<string, unknown>;
}

describe("uiAmountStringOf: 文字列の算術", () => {
  test("桁・末尾のゼロ・大きな整数", () => {
    expect(uiAmountStringOf("0", 6)).toBe("0");
    expect(uiAmountStringOf("10000", 6)).toBe("0.01");
    expect(uiAmountStringOf("1000000", 6)).toBe("1");
    expect(uiAmountStringOf("1234567", 6)).toBe("1.234567");
    expect(uiAmountStringOf("5", 6)).toBe("0.000005");
    expect(uiAmountStringOf(BIG, 0)).toBe(BIG);
    expect(uiAmountStringOf(BIG, 6)).toBe("9007199254.740993");
    expect(() => uiAmountStringOf("01", 6)).toThrow(/decimal string/);
  });
});

describe("fixture: 複数の ATA と getTokenAccountBalance", () => {
  let fixture: SolanaRpcFixture;
  beforeAll(async () => {
    fixture = await startSolanaRpc({ mint: MINT, decimals: 6, atas: [{ address: ATA_A, owner: OWNER_A, amount: "10000" }, { address: ATA_B, owner: OWNER_B, amount: BIG }] });
  });
  afterAll(async () => {
    await fixture.close();
  });

  test("getTokenAccountBalance: 残高は文字列そのまま（精度を失わない）。未知の口座は JSON-RPC の error", async () => {
    const a = await rpc(fixture, "getTokenAccountBalance", [ATA_A, { commitment: "confirmed" }]);
    expect(a["result"]).toEqual({ context: { slot: 1 }, value: { amount: "10000", decimals: 6, uiAmount: 0.01, uiAmountString: "0.01" } });
    const b = await rpc(fixture, "getTokenAccountBalance", [ATA_B]);
    expect((b["result"] as { value: { amount: string; uiAmountString: string } }).value.amount).toBe(BIG);
    expect((b["result"] as { value: { amount: string; uiAmountString: string } }).value.uiAmountString).toBe("9007199254.740993");
    const unknown = await rpc(fixture, "getTokenAccountBalance", [OWNER_A]);
    expect(unknown["result"]).toBeUndefined();
    expect(unknown["error"]).toMatchObject({ code: -32602 });
    expect(fixture.calls.filter((c) => c.method === "getTokenAccountBalance")).toHaveLength(3);
  });

  test("getAccountInfo: 両方の ATA が jsonParsed で返り、残高も出る。未知は null。state.atas の変更（消す・残高を変える）が効く", async () => {
    const a = await rpc(fixture, "getAccountInfo", [ATA_A, { encoding: "jsonParsed" }]);
    expect(a["result"]).toMatchObject({ value: { data: { parsed: { info: { owner: OWNER_A, mint: MINT, tokenAmount: { amount: "10000", uiAmountString: "0.01" } } } } } });
    const b = await rpc(fixture, "getAccountInfo", [ATA_B, { encoding: "jsonParsed" }]);
    expect(b["result"]).toMatchObject({ value: { data: { parsed: { info: { owner: OWNER_B, tokenAmount: { amount: BIG } } } } } });
    expect((await rpc(fixture, "getAccountInfo", [OWNER_B, { encoding: "jsonParsed" }]))["result"]).toEqual({ context: { slot: 1 }, value: null });
    fixture.state.atas = [{ address: ATA_A, owner: OWNER_A, amount: "0" }];
    expect((await rpc(fixture, "getAccountInfo", [ATA_B, { encoding: "jsonParsed" }]))["result"]).toEqual({ context: { slot: 1 }, value: null });
    expect((await rpc(fixture, "getTokenAccountBalance", [ATA_A]))["result"]).toMatchObject({ value: { amount: "0", uiAmountString: "0" } });
  });
});

describe("fixture: 従来の単一の ata は同じ挙動（base64 も jsonParsed も）", () => {
  test("ata だけ渡すと state.atas に 1 つ入り、既定の残高 0 で返る", async () => {
    const fixture = await startSolanaRpc({ mint: MINT, decimals: 6, ata: { address: ATA_A, owner: OWNER_A } });
    try {
      expect(fixture.state.atas).toEqual([{ address: ATA_A, owner: OWNER_A }]);
      const parsed = await rpc(fixture, "getAccountInfo", [ATA_A, { encoding: "jsonParsed" }]);
      expect(parsed["result"]).toMatchObject({ value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { program: "spl-token", parsed: { type: "account", info: { owner: OWNER_A, mint: MINT, tokenAmount: { amount: "0", uiAmountString: "0" } } } } } });
      const raw = await rpc(fixture, "getAccountInfo", [ATA_A]);
      const data = (raw["result"] as { value: { data: [string, string] } }).value.data;
      expect(data[1]).toBe("base64");
      expect(Buffer.from(data[0], "base64")).toHaveLength(165);
      expect((await rpc(fixture, "getTokenAccountBalance", [ATA_A]))["result"]).toMatchObject({ value: { amount: "0" } });
    } finally {
      await fixture.close();
    }
  });
});
