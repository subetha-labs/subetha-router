/**
 * Provider の純粋関数（`docs/provider-x402-workers.md` §4 の unit の行）: config、売り手証明の往復、snapshot の封筒と制約、領収の表、期限。
 */
import { describe, expect, test } from "vitest";
import { address, appendTransactionMessageInstruction, compileTransactionMessage, createNoopSigner, createTransactionMessage, getBase64Decoder, getCompiledTransactionMessageEncoder, getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from "@solana/kit";
import { getBase58Decoder } from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { keccak256, recoverTypedDataAddress, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { configOf, TABLE } from "../src/config.js";
import { MIN_REMAINING_BEFORE_SETTLE_MS, RequestDeadline, within } from "../src/deadline.js";
import { checkReceipt, payerOfPayload } from "../src/receipt.js";
import { bodyHashOf, SELLER_PROOF_DOMAIN_NAME, SELLER_PROOF_LIFETIME_SECONDS, SELLER_REQUEST_TYPES, sellerProofFor, type SellerRequestTypedData } from "../src/seller-proof.js";
import { DataUnavailableError, percentOf, snapshotOf, subtractDecimal } from "../src/snapshot.js";

const ARC_KEY = generatePrivateKey();
const ARC_ADDRESS = privateKeyToAccount(ARC_KEY).address;
const SOL_OWNER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";

describe("config", () => {
  test("arc: 表の固定値、payTo の形、鍵が要る。solana: 鍵があれば拒む。文言に値が出ない", () => {
    const arc = configOf({ PROVIDER_NETWORK: "arc", PAY_TO: ARC_ADDRESS, SELLER_PROOF_KEY: ARC_KEY });
    expect(arc).toMatchObject({ network: "arc", payTo: ARC_ADDRESS, facilitatorUrl: TABLE.arc.facilitatorUrl, table: { network: "eip155:5042002", amount: "10000" } });
    expect(arc.sellerProofKey).toBe(ARC_KEY);
    const sol = configOf({ PROVIDER_NETWORK: "solana", PAY_TO: SOL_OWNER });
    expect(sol).toMatchObject({ network: "solana", payTo: SOL_OWNER, sellerProofKey: undefined, facilitatorUrl: TABLE.solana.facilitatorUrl });
    for (const [label, env] of [
      ["network 無し", { PAY_TO: ARC_ADDRESS }],
      ["arc の payTo が base58", { PROVIDER_NETWORK: "arc", PAY_TO: SOL_OWNER, SELLER_PROOF_KEY: ARC_KEY }],
      ["arc の鍵無し", { PROVIDER_NETWORK: "arc", PAY_TO: ARC_ADDRESS }],
      ["arc の鍵の形違い", { PROVIDER_NETWORK: "arc", PAY_TO: ARC_ADDRESS, SELLER_PROOF_KEY: "0xabc" }],
      ["solana に鍵", { PROVIDER_NETWORK: "solana", PAY_TO: SOL_OWNER, SELLER_PROOF_KEY: ARC_KEY }],
      ["solana の payTo が 0x", { PROVIDER_NETWORK: "solana", PAY_TO: ARC_ADDRESS }],
      ["facilitator が http", { PROVIDER_NETWORK: "solana", PAY_TO: SOL_OWNER, FACILITATOR_URL: "http://facilitator.example/x" }],
    ] as const) {
      let caught: unknown;
      try {
        configOf(env);
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain(ARC_KEY);
      expect((caught as Error).message).not.toContain("0xabc");
    }
    // 試験用の loopback の facilitator は許す。
    expect(configOf({ PROVIDER_NETWORK: "solana", PAY_TO: SOL_OWNER, FACILITATOR_URL: "http://127.0.0.1:1234/" }).facilitatorUrl).toBe("http://127.0.0.1:1234");
  });
});

describe("売り手証明（Router の fixture と同じ検証）", () => {
  test("封筒を復号 → EIP-712 で recover → payTo 一致、bodyHash は本文の keccak256、寿命 60 秒、purpose は束縛", async () => {
    const account = privateKeyToAccount(ARC_KEY);
    const now = 1_760_000_000_000;
    const signer = { network: "eip155:5042002", chainId: 5042002, address: account.address, signTypedData: (td: SellerRequestTypedData) => account.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message }), now: () => now };
    const body = JSON.stringify({ x402Version: 2, paymentPayload: { a: 1 }, paymentRequirements: { b: 2 } });
    const header = await sellerProofFor(signer, "verify", body);
    const envelope = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["expiresAt", "issuedAt", "network", "nonce", "payTo", "signature", "version"]);
    expect(envelope["version"]).toBe(1);
    expect(envelope["issuedAt"]).toBe(Math.floor(now / 1000));
    expect(envelope["expiresAt"]).toBe(Math.floor(now / 1000) + SELLER_PROOF_LIFETIME_SECONDS);
    const recovered = await recoverTypedDataAddress({
      domain: { name: SELLER_PROOF_DOMAIN_NAME, version: "1", chainId: 5042002 },
      types: SELLER_REQUEST_TYPES,
      primaryType: "SellerRequest",
      message: { purpose: "verify", method: "POST", bodyHash: keccak256(toBytes(body)), network: "eip155:5042002", payTo: account.address, nonce: envelope["nonce"] as `0x${string}`, issuedAt: BigInt(envelope["issuedAt"] as number), expiresAt: BigInt(envelope["expiresAt"] as number) },
      signature: envelope["signature"] as `0x${string}`,
    });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
    expect(bodyHashOf(body)).toBe(keccak256(toBytes(body)));
    // 別の本文・別の purpose では recover が一致しない（束縛）。
    const other = await recoverTypedDataAddress({
      domain: { name: SELLER_PROOF_DOMAIN_NAME, version: "1", chainId: 5042002 },
      types: SELLER_REQUEST_TYPES,
      primaryType: "SellerRequest",
      message: { purpose: "settle", method: "POST", bodyHash: keccak256(toBytes(body)), network: "eip155:5042002", payTo: account.address, nonce: envelope["nonce"] as `0x${string}`, issuedAt: BigInt(envelope["issuedAt"] as number), expiresAt: BigInt(envelope["expiresAt"] as number) },
      signature: envelope["signature"] as `0x${string}`,
    });
    expect(other.toLowerCase()).not.toBe(account.address.toLowerCase());
    // nonce は要求ごとに新しい。
    const second = JSON.parse(Buffer.from(await sellerProofFor(signer, "verify", body), "base64url").toString("utf8")) as Record<string, unknown>;
    expect(second["nonce"]).not.toBe(envelope["nonce"]);
  });
});

describe("snapshot（契約の形と制約）", () => {
  const hl = (eth: Record<string, unknown>, extra: unknown[] = []) => [{ universe: [{ name: "BTC" }, { name: "ETH" }, ...extra.map((_, i) => ({ name: `X${i}` }))] }, [{ markPx: "1", prevDayPx: "1", dayNtlVlm: "1" }, eth, ...extra]];

  test("ETH の行から契約の封筒を組む（鍵は過不足なく、数値は文字列、assetIndex は index）", () => {
    const snapshot = snapshotOf(hl({ markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00", funding: "0.0000125" }), "eip155:5042002", () => 1_760_000_000_123);
    expect(Object.keys(snapshot).sort()).toEqual(["data", "dataSource", "fetchedAt", "market", "payment", "providerId"]);
    expect(snapshot).toMatchObject({ providerId: "market-data-a", market: { kind: "perpetual", symbol: "ETH", quote: "USD" }, dataSource: { name: "hyperliquid", network: "hyperliquid-mainnet" }, payment: { protocol: "x402", network: "eip155:5042002" } });
    expect(Object.keys(snapshot.data).sort()).toEqual(["assetIndex", "change24h", "dayNtlVlm", "markPx", "prevDayPx"]);
    expect(snapshot.data).toEqual({ markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00", change24h: { absolute: "-121.1", percent: "-4.49" }, assetIndex: 1 });
    expect(snapshot.fetchedAt).toBe(new Date(1_760_000_000_123).toISOString());
    expect(snapshot.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    for (const v of [snapshot.data.markPx, snapshot.data.prevDayPx, snapshot.data.dayNtlVlm, snapshot.data.change24h.absolute, snapshot.data.change24h.percent]) expect(v).toMatch(/^-?\d+(?:\.\d+)?$/);
  });

  test("制約: 正の価格、非負の出来高、ETH が無い・形違い・prev が 0 → data_unavailable", () => {
    for (const [label, eth] of [
      ["markPx が 0", { markPx: "0", prevDayPx: "1", dayNtlVlm: "1" }],
      ["markPx が負", { markPx: "-1", prevDayPx: "1", dayNtlVlm: "1" }],
      ["prevDayPx が 0（percent の分母）", { markPx: "1", prevDayPx: "0", dayNtlVlm: "1" }],
      ["dayNtlVlm が負", { markPx: "1", prevDayPx: "1", dayNtlVlm: "-5" }],
      ["指数表記", { markPx: "1e3", prevDayPx: "1", dayNtlVlm: "1" }],
      ["数値型", { markPx: 1000, prevDayPx: "1", dayNtlVlm: "1" }],
    ] as const) {
      expect(() => snapshotOf(hl(eth as never), "eip155:5042002"), label).toThrow(DataUnavailableError);
    }
    expect(() => snapshotOf([{ universe: [{ name: "BTC" }] }, [{}]], "x")).toThrow(DataUnavailableError);
    expect(() => snapshotOf({}, "x")).toThrow(DataUnavailableError);
  });

  test("10 進の算術は文字列のまま（桁、負、四捨五入）", () => {
    expect(subtractDecimal("2572.5", "2693.6")).toBe("-121.1");
    expect(subtractDecimal("3000.12", "2950.40")).toBe("49.72");
    expect(subtractDecimal("100", "0.5")).toBe("99.5");
    expect(percentOf("49.72", "2950.40")).toBe("1.68");
    expect(percentOf("-121.1", "2693.6")).toBe("-4.49");
    expect(percentOf("0", "10")).toBe("0.00");
    expect(() => percentOf("1", "0")).toThrow(DataUnavailableError);
  });
});

describe("領収の表（§2.2）と payer の同一性", () => {
  const arcPayload = (from: string) => ({ x402Version: 2, resource: { url: "https://p/v1" }, accepted: {}, payload: { signature: "0x", authorization: { from } } }) as never;
  const ARC = "eip155:5042002";

  test("arc: 成功は from と payer の一致まで。pending・失敗・形違い・別 payer は 502 の分類", () => {
    const ok = checkReceipt("arc", ARC, arcPayload(ARC_ADDRESS), { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC, payer: ARC_ADDRESS.toLowerCase() });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(Buffer.from(ok.header, "base64").toString("utf8")).toContain(`"transaction":"0x${"ab".repeat(32)}"`);
    expect(checkReceipt("arc", ARC, arcPayload(ARC_ADDRESS), { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC }).ok).toBe(true);
    const rows: [string, unknown, string][] = [
      ["pending", { success: false, errorReason: "settlement_pending", transaction: "sig" }, "settlement_pending"],
      ["failed", { success: false, errorReason: "insufficient_funds" }, "settle_failed"],
      ["network 違い", { success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:84532" }, "receipt_malformed"],
      ["transaction の形", { success: true, transaction: "0xabc", network: ARC }, "receipt_malformed"],
      ["別の payer", { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC, payer: "0x00000000000000000000000000000000000000b0" }, "receipt_malformed"],
      ["payer の形", { success: true, transaction: `0x${"ab".repeat(32)}`, network: ARC, payer: "nope" }, "receipt_malformed"],
      ["object でない", "ok", "receipt_malformed"],
    ];
    for (const [label, response, reason] of rows) expect(checkReceipt("arc", ARC, arcPayload(ARC_ADDRESS), response), label).toEqual({ ok: false, reason });
  });

  test("solana: payer は transaction の authority（2 番目の static account）と一致。署名は base58 64 バイト", () => {
    const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
    const feePayer = "HTazrCcGEzWPKSKLFtbzszPJYTrFdD6xFHN4rLbwQng5";
    const authoritySeed = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
    const authority = getBase58Decoder().decode(ed25519.getPublicKey(authoritySeed));
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(feePayer), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "7DAVM6c3cj1Y1a2vZkYRgTqZEQezrgQVymKZx8oarbrD" as never, lastValidBlockHeight: 0n }, m),
      (m) => appendTransactionMessageInstruction({ programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [{ address: address(authority), role: 2, signer: createNoopSigner(address(authority)) } as never], data: new Uint8Array([1]) }, m),
    );
    const compiled = getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message));
    const wire = getTransactionEncoder().encode({ messageBytes: compiled as never, signatures: { [feePayer]: null, [authority]: new Uint8Array(64) } as never });
    const transaction = getBase64Decoder().decode(wire);
    const payload = { x402Version: 2, resource: {}, accepted: {}, payload: { transaction } } as never;
    expect(payerOfPayload("solana", payload)).toBe(authority);
    const sig = getBase58Decoder().decode(new Uint8Array(64).fill(7));
    expect(checkReceipt("solana", SOL, payload, { success: true, transaction: sig, network: SOL, payer: authority }).ok).toBe(true);
    expect(checkReceipt("solana", SOL, payload, { success: true, transaction: sig, network: SOL, payer: feePayer })).toEqual({ ok: false, reason: "receipt_malformed" });
    expect(checkReceipt("solana", SOL, payload, { success: true, transaction: "abc", network: SOL })).toEqual({ ok: false, reason: "receipt_malformed" });
    expect(checkReceipt("solana", SOL, payload, { success: false, errorReason: "settlement_pending", transaction: sig, network: SOL })).toEqual({ ok: false, reason: "settlement_pending" });
  });
});

describe("期限", () => {
  test("残りと段の上限の小さい方、settle 前の最小残り", () => {
    let now = 1_000_000;
    const d = new RequestDeadline(() => now, 26_000);
    expect(d.budgetFor(4_000)).toBe(4_000);
    now += 20_000;
    expect(d.remainingMs()).toBe(6_000);
    expect(d.budgetFor(20_000)).toBe(6_000);
    expect(d.canSettle()).toBe(false);
    expect(MIN_REMAINING_BEFORE_SETTLE_MS).toBe(12_000);
    now += 10_000;
    expect(d.budgetFor(4_000)).toBe(0);
  });
});

describe("within（段の予算つきの await）", () => {
  test("予算の内側なら値、超えれば deadline で reject、予算 0 は即 reject", async () => {
    await expect(within(100, Promise.resolve("ok"))).resolves.toBe("ok");
    await expect(within(20, new Promise((r) => setTimeout(() => r("late"), 200)))).rejects.toThrow(/deadline/);
    await expect(within(0, Promise.resolve("never"))).rejects.toThrow(/deadline/);
  });
});
