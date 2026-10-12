/**
 * EVM testnet 4 つ（`docs/evm-testnets-x402-design.md` §3.4・AC-E4）: 表の値（Router の `src/shared/networks.ts` との一致と literal）、
 * env の受け入れと拒否、族による EVM の payer の取り出しと領収の検査、network ごとの期限と窓（§3.6）、
 * **Workers の入口（`export default { fetch }`）そのもの** を fixture の facilitator に向けた未払い 402 → 支払い（試験内の使い捨て鍵で
 * SDK の client が作る EIP-3009 の署名）→ verify/settle → 200 + `PAYMENT-RESPONSE`、既存の `arc`・`solana` が変わらないこと。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { getAddress, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { KNOWN_NETWORKS, EVM_TESTNET_NETWORKS } from "../../../src/shared/networks.js";
import { configOf, requestDeadlineMsOf, TABLE, type ProviderEnv, type ProviderNetwork } from "../src/config.js";
import { DATA_TIMEOUT_MS, INIT_TIMEOUT_MS, MIN_REMAINING_BEFORE_SETTLE_MS, REQUEST_DEADLINE_MS, RequestDeadline, SETTLE_TIMEOUT_MS, VERIFY_TIMEOUT_MS } from "../src/deadline.js";
import { checkReceipt, payerOfPayload } from "../src/receipt.js";
import { handle, runtimeOf } from "../src/index.js";

const NEW_NETWORKS = ["rh", "arbsep", "hyperevm", "sepolia"] as const;
type NewNetwork = (typeof NEW_NETWORKS)[number];
const PAY_TO = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
const TOKEN = "t".repeat(16) + "0123456789abcdef0123";
const FACILITATOR = `http://127.0.0.1:8611/${TOKEN}`;
const DATA = "http://127.0.0.1:8699/info";
const HL = [{ universe: [{ name: "BTC" }, { name: "ETH" }] }, [{ markPx: "1", prevDayPx: "1", dayNtlVlm: "1" }, { markPx: "2572.5", prevDayPx: "2693.6", dayNtlVlm: "123456789.00" }]];

/** 設計 §1.1 の値を literal で（`TABLE` からも Router の表からも読まない: 両方が同じ誤りを持っても気づく）。 */
const EXPECTED: Record<NewNetwork, { network: string; chainId: number; asset: string; name: string; version: string; maxTimeoutSeconds: number; requestMs: number; settleMs: number; minRemainingMs: number }> = {
  rh: { network: "eip155:46630", chainId: 46630, asset: "0x7E955252E15c84f5768B83c41a71F9eba181802F", name: "Global Dollar", version: "1", maxTimeoutSeconds: 60, requestMs: 26_000, settleMs: 20_000, minRemainingMs: 12_000 },
  arbsep: { network: "eip155:421614", chainId: 421614, asset: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", name: "USD Coin", version: "2", maxTimeoutSeconds: 60, requestMs: 26_000, settleMs: 20_000, minRemainingMs: 12_000 },
  hyperevm: { network: "eip155:998", chainId: 998, asset: "0x2B3370eE501B4a559b57D449569354196457D8Ab", name: "USDC", version: "2", maxTimeoutSeconds: 60, requestMs: 26_000, settleMs: 20_000, minRemainingMs: 12_000 },
  sepolia: { network: "eip155:11155111", chainId: 11155111, asset: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", name: "USDC", version: "2", maxTimeoutSeconds: 120, requestMs: 60_000, settleMs: 50_000, minRemainingMs: 44_000 },
};

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function envOf(network: ProviderNetwork, extra: Partial<ProviderEnv> = {}): ProviderEnv {
  return { PROVIDER_NETWORK: network, PAY_TO, FACILITATOR_URL: FACILITATOR, DATA_URL: DATA, ...extra };
}

function errorOf(f: () => unknown): Error | undefined {
  try {
    f();
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

describe("表（§3.4）", () => {
  test("4 行は Router の KNOWN_NETWORKS と一致する（network・資産の id の綴り・decimals・domain・族・x402 の facilitator）", () => {
    for (const name of NEW_NETWORKS) {
      const row = TABLE[name];
      const known = KNOWN_NETWORKS.find((entry) => entry.network === row.network);
      expect(known, name).toBeDefined();
      expect(EVM_TESTNET_NETWORKS.has(row.network), name).toBe(true);
      expect(known!.family).toBe(row.family);
      expect(known!.x402Facilitator).toBe(row.facilitatorKind);
      expect(known!.assets).toHaveLength(1);
      const asset = known!.assets[0]!;
      expect(asset.id, name).toBe(row.asset); // checksum の大文字小文字まで同じ
      expect(asset.decimals).toBe(row.decimals);
      expect(asset.domain).toEqual({ name: row.extra["name"], version: row.extra["version"] });
      expect(`eip155:${row.chainId}`).toBe(row.network);
    }
    // Router の EVM testnet の集合と Provider の 4 行は過不足なく一致する。
    expect(new Set(NEW_NETWORKS.map((n) => TABLE[n].network))).toEqual(new Set(EVM_TESTNET_NETWORKS));
  });

  test("4 行の literal（§1.1・§3.6）と、既存の 2 行は E-3 の前の値のまま（族だけ足した）", () => {
    for (const name of NEW_NETWORKS) {
      const e = EXPECTED[name];
      expect(TABLE[name], name).toEqual({
        network: e.network,
        asset: e.asset,
        decimals: 6,
        amount: "10000",
        extra: { name: e.name, version: e.version, assetTransferMethod: "eip3009" },
        facilitatorUrl: "",
        facilitatorKind: "x402",
        family: "evm",
        chainId: e.chainId,
        deadlines: { requestMs: e.requestMs, initMs: 5_000, dataMs: 2_000, verifyMs: 4_000, settleMs: e.settleMs, minRemainingBeforeSettleMs: e.minRemainingMs },
        maxTimeoutSeconds: e.maxTimeoutSeconds,
      });
    }
    const before = { requestMs: 26_000, initMs: 5_000, dataMs: 2_000, verifyMs: 4_000, settleMs: 20_000, minRemainingBeforeSettleMs: 12_000 };
    // 既存の定数（deadline.ts）は残り、arc・solana の行はその値。
    expect({ requestMs: REQUEST_DEADLINE_MS, initMs: INIT_TIMEOUT_MS, dataMs: DATA_TIMEOUT_MS, verifyMs: VERIFY_TIMEOUT_MS, settleMs: SETTLE_TIMEOUT_MS, minRemainingBeforeSettleMs: MIN_REMAINING_BEFORE_SETTLE_MS }).toEqual(before);
    expect(TABLE.arc).toEqual({ network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", decimals: 6, amount: "10000", extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" }, facilitatorUrl: "https://api.circle.com/v1/facilitator/x402", facilitatorKind: "circle", family: "evm", chainId: 5042002, deadlines: before, maxTimeoutSeconds: 30 });
    expect(TABLE.solana).toEqual({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6, amount: "10000", extra: {}, facilitatorUrl: "https://www.x402.org/facilitator", facilitatorKind: "x402", family: "svm", deadlines: before, maxTimeoutSeconds: 30 });
    // 入口の期限は env の network から（知らない値は既存の 26 秒）。
    expect(requestDeadlineMsOf("sepolia")).toBe(60_000);
    expect(requestDeadlineMsOf("rh")).toBe(26_000);
    expect(requestDeadlineMsOf("arc")).toBe(26_000);
    expect(requestDeadlineMsOf("__proto__")).toBe(26_000);
    expect(requestDeadlineMsOf(undefined)).toBe(26_000);
  });
});

describe("env（§3.4）", () => {
  test("4 network: EVM の PAY_TO・鍵なし・FACILITATOR_URL（token の path つき loopback か https）で受け入れる", () => {
    for (const name of NEW_NETWORKS) {
      const config = configOf({ PROVIDER_NETWORK: name, PAY_TO, FACILITATOR_URL: `${FACILITATOR}/` });
      expect(config).toMatchObject({ network: name, payTo: PAY_TO, facilitatorUrl: FACILITATOR, table: { network: EXPECTED[name].network } });
      expect(configOf({ PROVIDER_NETWORK: name, PAY_TO, FACILITATOR_URL: "https://facilitator.example/x", SELLER_PROOF_KEY: "" }).facilitatorUrl).toBe("https://facilitator.example/x");
      // 鍵が無いので runtime も組める（売り手証明の closure は作らない）。
      expect(() => runtimeOf({ PROVIDER_NETWORK: name, PAY_TO, FACILITATOR_URL: FACILITATOR })).not.toThrow();
    }
  });

  test("4 network の拒否: 鍵が設定されている・FACILITATOR_URL が無い・平文の非 loopback・PAY_TO が base58・知らない network。文言に値が出ない", () => {
    const key = generatePrivateKey();
    for (const name of NEW_NETWORKS) {
      const rows: [string, ProviderEnv, RegExp][] = [
        ["鍵", { PROVIDER_NETWORK: name, PAY_TO, FACILITATOR_URL: FACILITATOR, SELLER_PROOF_KEY: key }, /SELLER_PROOF_KEY must not be set/],
        ["URL 無し", { PROVIDER_NETWORK: name, PAY_TO }, /FACILITATOR_URL is required/],
        ["URL 空", { PROVIDER_NETWORK: name, PAY_TO, FACILITATOR_URL: "" }, /FACILITATOR_URL is required/],
        ["平文", { PROVIDER_NETWORK: name, PAY_TO, FACILITATOR_URL: "http://10.0.0.1:8611/x" }, /FACILITATOR_URL must be https/],
        ["base58", { PROVIDER_NETWORK: name, PAY_TO: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d", FACILITATOR_URL: FACILITATOR }, /PAY_TO/],
        ["短い address", { PROVIDER_NETWORK: name, PAY_TO: "0x1234", FACILITATOR_URL: FACILITATOR }, /PAY_TO/],
      ];
      for (const [label, env, message] of rows) {
        const error = errorOf(() => configOf(env));
        expect(error, `${name} ${label}`).toBeInstanceOf(Error);
        expect(error!.message, `${name} ${label}`).toMatch(message);
        expect(error!.message).not.toContain(key.slice(2));
        expect(error!.message).not.toContain(TOKEN);
      }
      // runtime（入口）も同じ検査で止まる: 鍵があれば closure を作る前に拒む。
      expect(errorOf(() => runtimeOf({ PROVIDER_NETWORK: name, PAY_TO, FACILITATOR_URL: FACILITATOR, SELLER_PROOF_KEY: key }))?.message).toMatch(/must not be set/);
    }
    for (const network of ["base", "eip155:46630", "RH", "__proto__", "toString", "hasOwnProperty"]) {
      expect(errorOf(() => configOf({ PROVIDER_NETWORK: network, PAY_TO, FACILITATOR_URL: FACILITATOR }))?.message, network).toMatch(/PROVIDER_NETWORK must be one of/);
    }
  });

  test("arc・solana は変わらない: arc は鍵が要り、FACILITATOR_URL の既定は Circle、上書きは https か loopback。solana は鍵を拒み既定は x402.org", () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    expect(configOf({ PROVIDER_NETWORK: "arc", PAY_TO: address, SELLER_PROOF_KEY: key }).facilitatorUrl).toBe("https://api.circle.com/v1/facilitator/x402");
    expect(configOf({ PROVIDER_NETWORK: "arc", PAY_TO: address, SELLER_PROOF_KEY: key, FACILITATOR_URL: "http://127.0.0.1:9/x/" }).facilitatorUrl).toBe("http://127.0.0.1:9/x");
    expect(configOf({ PROVIDER_NETWORK: "arc", PAY_TO: address, SELLER_PROOF_KEY: key, FACILITATOR_URL: "https://other.example/f" }).facilitatorUrl).toBe("https://other.example/f");
    expect(errorOf(() => configOf({ PROVIDER_NETWORK: "arc", PAY_TO: address, SELLER_PROOF_KEY: key, FACILITATOR_URL: "http://other.example/f" }))?.message).toBe("FACILITATOR_URL must be https (or loopback http for tests)");
    expect(errorOf(() => configOf({ PROVIDER_NETWORK: "arc", PAY_TO: address }))?.message).toBe("SELLER_PROOF_KEY is required for arc and must be a 0x-prefixed 32-byte hex key");
    const owner = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
    expect(configOf({ PROVIDER_NETWORK: "solana", PAY_TO: owner }).facilitatorUrl).toBe("https://www.x402.org/facilitator");
    expect(errorOf(() => configOf({ PROVIDER_NETWORK: "solana", PAY_TO: owner, SELLER_PROOF_KEY: key }))?.message).toBe("SELLER_PROOF_KEY must not be set for solana");
    // arc の runtime は鍵と PAY_TO の一致を見る（売り手証明の closure を作る）。
    expect(errorOf(() => runtimeOf({ PROVIDER_NETWORK: "arc", PAY_TO, SELLER_PROOF_KEY: key }))?.message).toBe("PAY_TO does not match the address of SELLER_PROOF_KEY");
  });
});

describe("族による payer と領収（receipt.ts）", () => {
  const from = "0x00000000000000000000000000000000000000Aa";
  const payload = { x402Version: 2, accepted: {}, payload: { signature: `0x${"11".repeat(65)}`, authorization: { from, to: PAY_TO, value: "10000", validAfter: "0", validBefore: "1", nonce: `0x${"22".repeat(32)}` } } } as never;
  test("4 network: payer は authorization の from（小文字）、領収は bytes32 の tx と同じ payer だけ", () => {
    for (const name of NEW_NETWORKS) {
      const network = TABLE[name].network;
      expect(payerOfPayload(name, payload), name).toBe(from.toLowerCase());
      const ok = checkReceipt(name, network, payload, { success: true, transaction: `0x${"ab".repeat(32)}`, network, payer: from });
      expect(ok.ok, name).toBe(true);
      if (ok.ok) expect(decodePaymentResponseHeader(ok.header)).toEqual({ success: true, transaction: `0x${"ab".repeat(32)}`, network, payer: from });
      expect(checkReceipt(name, network, payload, { success: true, transaction: `0x${"ab".repeat(32)}`, network })).toMatchObject({ ok: true });
      for (const bad of [
        { success: true, transaction: "5".repeat(88), network, payer: from }, // SVM の signature の形
        { success: true, transaction: `0x${"ab".repeat(32)}`, network, payer: "0x00000000000000000000000000000000000000b0" },
        { success: true, transaction: `0x${"ab".repeat(32)}`, network: TABLE.arc.network, payer: from },
      ]) {
        expect(checkReceipt(name, network, payload, bad), `${name} ${JSON.stringify(bad)}`).toEqual({ ok: false, reason: "receipt_malformed" });
      }
      expect(checkReceipt(name, network, payload, { success: false, errorReason: "settlement_pending" })).toEqual({ ok: false, reason: "settlement_pending" });
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────────
 * fixture の facilitator（自前 facilitator の `/<token>/supported` の形: `kinds`・`extensions`・`signers`）とデータ源。
 * verify/settle は EIP-3009 の署名を **literal の domain**（EXPECTED）で独立に検査する。
 * ────────────────────────────────────────────────────────────────────────────── */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

function fixture(name: NewNetwork, options: { advanceOnVerify?: () => void } = {}) {
  const e = EXPECTED[name];
  const calls: Call[] = [];
  const failures: string[] = [];
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  async function check(body: string | undefined): Promise<{ ok: boolean; from?: string }> {
    const parsed = JSON.parse(body ?? "{}") as { x402Version: number; paymentPayload: { payload: { authorization: Record<string, string>; signature: `0x${string}` }; accepted: unknown }; paymentRequirements: PaymentRequirements };
    const req = parsed.paymentRequirements;
    const auth = parsed.paymentPayload.payload.authorization;
    const sig = parsed.paymentPayload.payload.signature;
    if (parsed.x402Version !== 2 || req.network !== e.network || req.asset !== e.asset || req.payTo !== PAY_TO || req.amount !== "10000" || req.maxTimeoutSeconds !== e.maxTimeoutSeconds) return { ok: false };
    if (JSON.stringify(parsed.paymentPayload.accepted) !== JSON.stringify(req) && !sameJson(parsed.paymentPayload.accepted, req)) return { ok: false };
    if (getAddress(auth["to"]!) !== getAddress(PAY_TO) || auth["value"] !== "10000") return { ok: false };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const validBefore = Number(auth["validBefore"]);
    if (!(validBefore > nowSeconds && validBefore <= nowSeconds + e.maxTimeoutSeconds + 1)) return { ok: false };
    const valid = await verifyTypedData({
      address: auth["from"] as `0x${string}`,
      domain: { name: e.name, version: e.version, chainId: e.chainId, verifyingContract: e.asset as `0x${string}` },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: auth["from"] as `0x${string}`, to: auth["to"] as `0x${string}`, value: BigInt(auth["value"]!), validAfter: BigInt(auth["validAfter"]!), validBefore: BigInt(auth["validBefore"]!), nonce: auth["nonce"] as `0x${string}` },
      signature: sig,
    });
    return valid ? { ok: true, from: auth["from"]! } : { ok: false };
  }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    if (init?.redirect !== "manual" && url.startsWith(FACILITATOR)) failures.push(`redirect ${String(init?.redirect)}`);
    if (url === DATA) return json(200, HL);
    if (url === `${FACILITATOR}/supported` && (init?.method ?? "GET") === "GET") {
      return json(200, { kinds: [{ x402Version: 2, scheme: "exact", network: e.network }], extensions: [], signers: { "eip155:*": ["0x000000000000000000000000000000000000dEaD"] } });
    }
    if (url === `${FACILITATOR}/verify` && init?.method === "POST") {
      options.advanceOnVerify?.();
      const result = await check(body);
      return json(200, result.ok ? { isValid: true, payer: result.from } : { isValid: false, invalidReason: "invalid_signature" });
    }
    if (url === `${FACILITATOR}/settle` && init?.method === "POST") {
      const result = await check(body);
      if (!result.ok) return json(400, { success: false, errorReason: "invalid" });
      return json(200, { success: true, transaction: `0x${"cd".repeat(32)}`, network: e.network, payer: result.from });
    }
    failures.push(`unexpected ${init?.method ?? "GET"} ${url}`);
    return json(404, { error: "not_found" });
  }) as typeof fetch;
  const of = (op: string): Call[] => calls.filter((c) => c.url === `${FACILITATOR}/${op}`);
  return { calls, failures, fetch: fetchImpl, of };
}

function sameJson(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => (Array.isArray(v) ? v.map(norm) : typeof v === "object" && v !== null ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

async function paidHeader(resource: string, accepted: PaymentRequirements, key: `0x${string}` = generatePrivateKey()): Promise<{ header: string; from: string }> {
  const account = privateKeyToAccount(key);
  const scheme = new ExactEvmScheme(account);
  const created = await scheme.createPaymentPayload(2, accepted);
  const payload = { x402Version: 2, resource: { url: resource }, accepted, payload: created.payload };
  return { header: encodePaymentSignatureHeader(payload as never), from: account.address };
}

describe("Workers の入口（export default { fetch }）を通る端から端（AC-E4。fixture の facilitator）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  for (const name of NEW_NETWORKS) {
    test(`${name}: 未払い 402 → 使い捨て鍵の EIP-3009 → verify・settle 各 1 回 → 200 + PAYMENT-RESPONSE。/supported は token の path、売り手証明は無い`, async () => {
      const e = EXPECTED[name];
      const fake = fixture(name);
      vi.stubGlobal("fetch", fake.fetch);
      vi.resetModules();
      const worker = (await import("../src/index.js")).default;
      const env = envOf(name);
      const resource = `https://provider-x402-${name}.local/v1/eth/snapshot`;

      const unpaid = await worker.fetch(new Request(resource), env);
      expect(unpaid.status).toBe(402);
      const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
      expect(required.accepts).toEqual([{ scheme: "exact", network: e.network, asset: e.asset, amount: "10000", payTo: PAY_TO, maxTimeoutSeconds: e.maxTimeoutSeconds, extra: { name: e.name, version: e.version, assetTransferMethod: "eip3009" } }]);
      expect(fake.of("supported")).toHaveLength(1);

      const { header, from } = await paidHeader(resource, required.accepts[0]!);
      const paid = await worker.fetch(new Request(resource, { headers: { "payment-signature": header } }), env);
      expect(paid.status, await paid.clone().text()).toBe(200);
      expect(decodePaymentResponseHeader(paid.headers.get("payment-response")!)).toEqual({ success: true, transaction: `0x${"cd".repeat(32)}`, network: e.network, payer: from });
      expect((await paid.json()) as Record<string, unknown>).toMatchObject({ providerId: "market-data-a", payment: { protocol: "x402", network: e.network }, data: { markPx: "2572.5" } });

      expect(fake.of("supported")).toHaveLength(1);
      expect(fake.of("verify")).toHaveLength(1);
      expect(fake.of("settle")).toHaveLength(1);
      for (const call of [...fake.of("verify"), ...fake.of("settle")]) expect(call.headers["facilitator-seller-proof"]).toBeUndefined();
      expect(fake.failures).toEqual([]);

      // 別の鍵で署名した payload を自分の from と偽る → facilitator の verify が拒む → 402（settle は増えない）。
      const forged = await paidHeader(resource, required.accepts[0]!);
      const decoded = JSON.parse(atob(forged.header)) as { payload: { authorization: { from: string } } };
      decoded.payload.authorization.from = from;
      const rejected = await worker.fetch(new Request(resource, { headers: { "payment-signature": btoa(JSON.stringify(decoded)) } }), env);
      expect(rejected.status).toBe(402);
      expect(fake.of("settle")).toHaveLength(1);
    });
  }

  test("入口の env が不正（鍵が設定された rh・URL 無しの sepolia）→ 全要求 500 固定文、facilitator を呼ばない", async () => {
    for (const env of [envOf("rh", { SELLER_PROOF_KEY: generatePrivateKey() }), { PROVIDER_NETWORK: "sepolia", PAY_TO }]) {
      const fake = fixture("rh");
      vi.stubGlobal("fetch", fake.fetch);
      vi.resetModules();
      const worker = (await import("../src/index.js")).default;
      const r = await worker.fetch(new Request("https://p.local/v1/eth/snapshot"), env);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "misconfigured" });
      expect(fake.calls).toHaveLength(0);
    }
  });
});

describe("network ごとの期限（§3.6）", () => {
  async function run(name: NewNetwork, advanceMs: number): Promise<{ status: number; settles: number; verifies: number }> {
    let now = 1_000_000_000_000;
    const fake = fixture(name, { advanceOnVerify: () => { now += advanceMs; } });
    const runtime = runtimeOf(envOf(name), { fetch: fake.fetch, now: () => now });
    const resource = "https://p.local/v1/eth/snapshot";
    const unpaid = await handle(new Request(resource), runtime, { fetch: fake.fetch, now: () => now });
    const accepted = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "").accepts[0]!;
    const { header } = await paidHeader(resource, accepted);
    const r = await handle(new Request(resource, { headers: { "payment-signature": header } }), runtime, { fetch: fake.fetch, now: () => now });
    return { status: r.status, settles: fake.of("settle").length, verifies: fake.of("verify").length };
  }

  test("速いチェーン（rh）: verify で 15 秒進むと残り 11 秒 < 12 秒 → settle を呼ばず 503", async () => {
    expect(await run("rh", 15_000)).toEqual({ status: 503, settles: 0, verifies: 1 });
    expect(await run("arbsep", 13_000)).toEqual({ status: 200, settles: 1, verifies: 1 });
  });

  test("sepolia: 要求 60 秒・settle に要る残り 44 秒（15 秒進んでも settle する、17 秒なら 503）", async () => {
    expect(await run("sepolia", 15_000)).toEqual({ status: 200, settles: 1, verifies: 1 });
    expect(await run("sepolia", 17_000)).toEqual({ status: 503, settles: 0, verifies: 1 });
  });

  test("settle の段の上限は行の値: sepolia の settle の signal は 20 秒では切れない（RequestDeadline の段の予算）", () => {
    let now = 0;
    const deadline = new RequestDeadline(() => now, TABLE.sepolia.deadlines.requestMs);
    try {
      expect(deadline.budgetFor(TABLE.sepolia.deadlines.settleMs)).toBe(50_000);
      now = 15_000;
      expect(deadline.canSettle(TABLE.sepolia.deadlines.minRemainingBeforeSettleMs)).toBe(true);
      expect(deadline.canSettle()).toBe(true);
      now = 17_000;
      expect(deadline.canSettle(TABLE.sepolia.deadlines.minRemainingBeforeSettleMs)).toBe(false);
      expect(deadline.budgetFor(TABLE.sepolia.deadlines.settleMs)).toBe(43_000);
    } finally {
      deadline.release();
    }
  });
});
