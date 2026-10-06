/**
 * x402 送信の動的経路（設計 `docs/dynamic-upstream-design.md` §3.2〜§3.4、タスク T8。AC-6・AC-14・AC-15・AC-16 の adapter 部分）。
 *
 * 実 TCP / TLS（loopback の fixture）。transport は本番と同じ宛先の判定（loopback を許さない）で、TCP の行き先だけを
 * fixture に向ける。署名は**毎回の乱数の鍵**で実際に行い、できた署名は「EIP-3009 の署名を実際に検証する」facilitator の
 * fixture で確かめる。資金は動かない。
 *
 * 署名の境界の試験は、**SDK（`@x402/evm` の `ExactEvmScheme`）が署名器に渡す typed data を書き換える**ことで行う
 * （下の `vi.mock`。書き換えを指定しなければ SDK は実物のまま）。
 */
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

type TypedData = { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };

const sdk = vi.hoisted(() => ({
  /** SDK が署名器に渡す typed data を書き換える。 */
  tamper: undefined as undefined | ((message: TypedData) => TypedData),
  /** 1 件の支払いの中で、SDK が余分に署名を求める回数。 */
  extraSignatures: 0,
}));

vi.mock("@x402/evm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@x402/evm")>();
  class TamperingScheme extends actual.ExactEvmScheme {
    constructor(signer: { address: `0x${string}`; signTypedData(message: TypedData): Promise<`0x${string}`> }) {
      super({
        address: signer.address,
        async signTypedData(message: TypedData): Promise<`0x${string}`> {
          const signature = await signer.signTypedData(sdk.tamper === undefined ? message : sdk.tamper(message));
          for (let index = 0; index < sdk.extraSignatures; index += 1) await signer.signTypedData(message);
          return signature;
        },
      });
    }
  }
  return { ...actual, ExactEvmScheme: TamperingScheme };
});

import { createX402Outbound } from "../../src/adapters/outbound/x402.js";
import { checkDynamicX402Offer, createRebuildingSigner, DynamicChallengeError, SigningRefusedError } from "../../src/adapters/outbound/x402-dynamic.js";
import type { DynamicProfile } from "../../src/config.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../../src/net/bounded-body.js";
import { createGuardedTransport, TransportError, type TransportEvent } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, OutboundRail } from "../../src/ports/outbound.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { startVerifyingFacilitator } from "../fixtures/dynamic/verifying-facilitator.js";
import { FIXTURE_ASSET, FIXTURE_NETWORK, FIXTURE_PAY_TO, FIXTURE_TX, paidOk, standardAccept, startX402Upstream, type PayResponse, type X402Upstream } from "../fixtures/dynamic/x402-upstream.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const PROFILE_ID = "dyn-mpp-to-x402";
const OPERATOR_PAY_TO = "0x00000000000000000000000000000000000000b0";
const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "mpp",
  source: { network: "eip155:42431", asset: "0x20c0000000000000000000000000000000000000", decimals: 6, payTo: OPERATOR_PAY_TO },
  rail: "x402",
  destination: { scheme: "exact", network: FIXTURE_NETWORK, asset: FIXTURE_ASSET, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "0", bps: 0, min: "0" },
};
const URL_A = "https://provider.test/v1/price?symbol=ETH";
const MIB = 1024 * 1024;

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls();
});
afterAll(() => {
  TLS.cleanup();
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  sdk.tamper = undefined;
  sdk.extraSignatures = 0;
  while (closers.length > 0) await closers.pop()!();
});

interface Harness {
  readonly upstream: X402Upstream;
  readonly rail: OutboundRail;
  readonly address: `0x${string}`;
  /** 元の署名器（実鍵）が受け取った typed data。 */
  readonly signed: TypedData[];
  readonly events: TransportEvent[];
  readonly gate: { admitted: number; released: number };
  quote(): Promise<DestinationOffer>;
  pay(offer: DestinationOffer, url?: string): ReturnType<OutboundRail["pay"]>;
}

async function harness(options: { unpaidTimeoutMs?: number; paidTimeoutMs?: number; denyHosts?: readonly string[]; profile?: DynamicProfile } = {}): Promise<Harness> {
  const upstream = await startX402Upstream(TLS);
  closers.push(upstream.close);
  const account = privateKeyToAccount(generatePrivateKey());
  const signed: TypedData[] = [];
  const events: TransportEvent[] = [];
  const gate = { admitted: 0, released: 0 };
  const transport = createGuardedTransport({
    allowLoopback: false,
    report: (event) => events.push(event),
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: publicLookup(),
    dialForTest: dialTo({ "provider.test": upstream.port }),
    maxHeaderSize: DYNAMIC_RESPONSE_LIMITS.maxHeaderBytes,
    dns: { timeoutMs: 2_000, maxInFlight: 16 },
    admit: () => {
      gate.admitted += 1;
      return {
        release: () => {
          gate.released += 1;
        },
      };
    },
  });
  const rail = createX402Outbound({
    upstreams: {},
    transport: createGuardedTransport({ allowLoopback: true, report: () => {} }),
    capability: {
      network: FIXTURE_NETWORK,
      kind: "real-key",
      signer: {
        address: account.address,
        signTypedData: async (message: TypedData) => {
          signed.push(message);
          return account.signTypedData(message as never);
        },
      },
    },
    dynamic: {
      profiles: { [PROFILE_ID]: options.profile ?? PROFILE },
      transport,
      ...(options.denyHosts === undefined ? {} : { denyHosts: options.denyHosts }),
      ...(options.unpaidTimeoutMs === undefined ? {} : { unpaidTimeoutMs: options.unpaidTimeoutMs }),
      ...(options.paidTimeoutMs === undefined ? {} : { paidTimeoutMs: options.paidTimeoutMs }),
    },
  });
  upstream.state.pay = () => paidOk(account.address, { price: 1 });
  return {
    upstream,
    rail,
    address: account.address,
    signed,
    events,
    gate,
    quote: async () => (await rail.readChallenge(PROFILE_ID, { url: URL_A }))[0]!,
    pay: (offer, url = URL_A) => rail.pay({ routeId: PROFILE_ID, offer, paymentId: "p1", attempt: 1, target: { url } }),
  };
}

/** 枠の返却は応答の終わりの後に起きる。少し待ってから数える。 */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

/* ------------------------------------------------------------------ offer の検査（純粋関数） */

describe("offer の検査（設計 §3.3 (i)）", () => {
  const SIGNER = "0x00000000000000000000000000000000000000c0";
  const check = (offer: unknown) => checkDynamicX402Offer(offer, PROFILE, [SIGNER, OPERATOR_PAY_TO]);
  const withExtra = (extra: Record<string, unknown>) => standardAccept({ extra: { name: "USDC", version: "2", ...extra } });
  const without = (key: string) => {
    const offer = standardAccept();
    delete offer[key];
    return offer;
  };

  test.each([
    ["標準の 7 欄と extra.name・version", standardAccept()],
    ["説明だけの欄", standardAccept({ description: "price", mimeType: "application/json", resource: "https://provider.test/v1/price" })],
    ["extra.bazaar", withExtra({ bazaar: { info: { input: {} } } })],
    ["extra.decimals がプロファイルと同じ", withExtra({ decimals: 6 })],
    ["maxAmountRequired が amount と同じ", standardAccept({ maxAmountRequired: "1000" })],
    ["asset の大文字小文字が違う", standardAccept({ asset: FIXTURE_ASSET.toLowerCase() })],
    ["amount が上限ちょうど", standardAccept({ amount: "100000" })],
    ["maxTimeoutSeconds が 1", standardAccept({ maxTimeoutSeconds: 1 })],
    ["maxTimeoutSeconds が 600", standardAccept({ maxTimeoutSeconds: 600 })],
  ])("通る: %s", (_name, offer) => {
    expect(check(offer)).toBeUndefined();
  });

  test.each([
    ["object でない", ["exact"], "not_an_object"],
    ["未知のトップレベルの欄（currency）", standardAccept({ currency: "USDC" }), "unknown_field"],
    ["未知のトップレベルの欄（recipient）", standardAccept({ recipient: FIXTURE_PAY_TO }), "unknown_field"],
    ["maxTimeoutSeconds が無い", without("maxTimeoutSeconds"), "missing_field"],
    ["extra が無い", without("extra"), "missing_field"],
    ["scheme が exact でない", standardAccept({ scheme: "upto" }), "scheme"],
    ["network がプロファイルと違う", standardAccept({ network: "eip155:8453" }), "network"],
    ["asset がプロファイルと違う", standardAccept({ asset: "0x0000000000000000000000000000000000000abc" }), "asset"],
    ["asset がアドレスでない", standardAccept({ asset: "USDC" }), "asset"],
    ["amount が 0", standardAccept({ amount: "0" }), "amount"],
    ["amount に先頭ゼロ", standardAccept({ amount: "01000" }), "amount"],
    ["amount が数値", standardAccept({ amount: 1000 }), "amount"],
    ["amount が指数表記", standardAccept({ amount: "1e3" }), "amount"],
    ["amount が上限超過", standardAccept({ amount: "100001" }), "amount_over_limit"],
    ["payTo がゼロアドレス", standardAccept({ payTo: "0x0000000000000000000000000000000000000000" }), "pay_to"],
    ["payTo が token コントラクト", standardAccept({ payTo: FIXTURE_ASSET.toLowerCase() }), "pay_to"],
    ["payTo が署名者自身", standardAccept({ payTo: SIGNER.toUpperCase().replace("0X", "0x") }), "pay_to"],
    ["payTo が受信の受取先", standardAccept({ payTo: OPERATOR_PAY_TO }), "pay_to"],
    ["payTo がアドレスでない", standardAccept({ payTo: "provider.eth" }), "pay_to"],
    ["maxTimeoutSeconds が 0", standardAccept({ maxTimeoutSeconds: 0 }), "max_timeout"],
    ["maxTimeoutSeconds が 601", standardAccept({ maxTimeoutSeconds: 601 }), "max_timeout"],
    ["maxTimeoutSeconds が小数", standardAccept({ maxTimeoutSeconds: 1.5 }), "max_timeout"],
    ["maxTimeoutSeconds が文字列", standardAccept({ maxTimeoutSeconds: "60" }), "max_timeout"],
    ["extra が配列", standardAccept({ extra: [] }), "extra"],
    ["extra.assetTransferMethod", withExtra({ assetTransferMethod: "permit2" }), "extra"],
    ["extra.paymentFlow", withExtra({ paymentFlow: "deferred" }), "extra"],
    ["extra.feePayer", withExtra({ feePayer: FIXTURE_PAY_TO }), "extra"],
    ["extra.name が無い", standardAccept({ extra: { version: "2" } }), "token_domain"],
    ["extra.name がプロファイルと違う", standardAccept({ extra: { name: "USD Coin", version: "2" } }), "token_domain"],
    ["extra.version がプロファイルと違う", standardAccept({ extra: { name: "USDC", version: "1" } }), "token_domain"],
    ["extra.decimals がプロファイルと違う", withExtra({ decimals: 18 }), "decimals"],
    ["maxAmountRequired が amount と違う", standardAccept({ maxAmountRequired: "999999" }), "max_amount_required"],
    ["description が文字列でない", standardAccept({ description: { text: "x" } }), "descriptive_field"],
    ["resource が文字列でない", standardAccept({ resource: { url: "https://other.test/" } }), "descriptive_field"],
  ])("候補にしない: %s", (_name, offer, reason) => {
    expect(check(offer)).toBe(reason);
  });
});

/* ------------------------------------------------------------------ 未払いの読取 */

describe("未払いの読取", () => {
  test("検査を通る offer だけを上流の順のまま返す（通るものが 2 つ目以降にあっても選べる）", async () => {
    const h = await harness();
    const good = standardAccept({ amount: "5000" });
    const second = standardAccept({ amount: "7000", description: "bulk" });
    h.upstream.state.accepts = [
      { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", asset: "EPjF", amount: "5000", payTo: "9xQe", maxTimeoutSeconds: 60, extra: {} },
      standardAccept({ network: "eip155:8453" }),
      standardAccept({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } }),
      good,
      second,
    ];
    const offers = await h.rail.readChallenge(PROFILE_ID, { url: URL_A });
    expect(offers).toEqual([good, second]);
    expect(h.upstream.seen).toMatchObject({ challenges: 1, payments: [], urls: [URL_A] });
    expect(h.signed).toHaveLength(0);
  });

  test("通る offer が無ければ空（no_matching_offer は core が決める）", async () => {
    const h = await harness();
    h.upstream.state.accepts = [standardAccept({ network: "eip155:8453" })];
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toEqual([]);
  });

  test("ヘッダが権威: 本文の accepts が食い違っていても、返るのはヘッダの offer", async () => {
    const h = await harness();
    h.upstream.state.bodyAccepts = [standardAccept({ payTo: "0x0000000000000000000000000000000000000bad", amount: "1" })];
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toEqual([standardAccept()]);
  });

  test("offer は 16 個まで。17 個は不成立", async () => {
    const h = await harness();
    h.upstream.state.accepts = Array.from({ length: 16 }, (_, index) => standardAccept({ amount: String(1000 + index) }));
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toHaveLength(16);
    h.upstream.state.accepts = Array.from({ length: 17 }, (_, index) => standardAccept({ amount: String(1000 + index) }));
    await expect(h.rail.readChallenge(PROFILE_ID, { url: URL_A })).rejects.toMatchObject({ reason: "too_many_offers" });
  });

  test.each([
    ["resource.url が要求した URL と違う", (u: X402Upstream) => { u.state.resourceUrl = () => "https://provider.test/v1/other"; }, "resource_mismatch"],
    ["x402 v1", (u: X402Upstream) => { u.state.topLevel = { x402Version: 1 }; }, "version"],
    ["accepts が空", (u: X402Upstream) => { u.state.accepts = []; }, "no_offers"],
    ["402 でない", (u: X402Upstream) => { u.state.challengeStatus = 200; }, "status"],
  ] as const)("不成立: %s", async (_name, arrange, reason) => {
    const h = await harness();
    arrange(h.upstream);
    const error = await h.rail.readChallenge(PROFILE_ID, { url: URL_A }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DynamicChallengeError);
    expect((error as DynamicChallengeError).reason).toBe(reason);
  });

  test.each([
    ["https でない", "http://provider.test/v1/price"],
    ["ポートつき", "https://provider.test:8443/v1/price"],
    ["IP リテラル", "https://93.184.216.34/v1/price"],
    ["拒否ホストのサブドメイン", "https://api.denied.test/v1/price"],
  ])("URL の規則を通らないものには接続しない: %s", async (_name, url) => {
    const h = await harness({ denyHosts: ["denied.test"] });
    await expect(h.rail.readChallenge(PROFILE_ID, { url })).rejects.toMatchObject({ reason: "url" });
    expect(h.gate.admitted).toBe(0);
    expect(h.upstream.seen.connections).toBe(0);
  });

  test("リダイレクトに従わない", async () => {
    const h = await harness();
    h.upstream.state.challengeStatus = 302;
    h.upstream.state.challengeHeaders = { location: "https://provider.test/v1/elsewhere" };
    await expect(h.rail.readChallenge(PROFILE_ID, { url: URL_A })).rejects.toBeInstanceOf(Error);
    expect(h.upstream.seen.urls).toEqual([URL_A]);
  });

  test("402 の本文は読まない: 20 MiB を送ろうとする上流でも成立し、送れた量はごく一部", async () => {
    const h = await harness();
    h.upstream.state.challengeStreamBytes = 20 * MIB;
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toEqual([standardAccept()]);
    await settled();
    const stream = h.upstream.seen.streams[0]!;
    expect(stream.completed).toBe(false);
    expect(stream.written).toBeLessThan(4 * MIB);
    expect(h.gate).toEqual({ admitted: 1, released: 1 });
  });

  test("ヘッダの上限（32 KiB）: 超えたら transport の失敗。上限内なら成立", async () => {
    const h = await harness();
    h.upstream.state.challengeHeaders = { "x-pad": "a".repeat(20_000) };
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toHaveLength(1);
    h.upstream.state.challengeHeaders = { "x-pad": "a".repeat(40_000) };
    await expect(h.rail.readChallenge(PROFILE_ID, { url: URL_A })).rejects.toBeInstanceOf(TransportError);
    await settled();
    expect(h.gate.released).toBe(h.gate.admitted);
  });

  test("期限（未払いは既定 5 秒・設定可能）で打ち切り、枠を返す", async () => {
    const h = await harness({ unpaidTimeoutMs: 200 });
    h.upstream.state.challengeDelayMs = 1500;
    const started = Date.now();
    await expect(h.rail.readChallenge(PROFILE_ID, { url: URL_A })).rejects.toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(1000);
    await settled();
    expect(h.gate).toEqual({ admitted: 1, released: 1 });
  });

  test("プロファイルが無い id・x402 送信でないプロファイルは使えない", async () => {
    const h = await harness({ profile: { ...PROFILE, rail: "mpp" } });
    await expect(h.rail.readChallenge(PROFILE_ID, { url: URL_A })).rejects.toThrow("no dynamic x402 profile");
    await expect(h.rail.readChallenge("unknown", { url: URL_A })).rejects.toThrow("no dynamic x402 profile");
    expect(h.upstream.seen.connections).toBe(0);
  });
});

/* ------------------------------------------------------------------ 支払い: 正の対照 */

describe("支払い", () => {
  test("Router が組み直した typed data に 1 回だけ署名し、その署名は EIP-3009 として検証を通る", async () => {
    const h = await harness();
    const facilitator = await startVerifyingFacilitator();
    closers.push(facilitator.close);
    const offer = await h.quote();
    const result = await h.pay(offer);
    expect(result).toMatchObject({ outcome: "paid", body: { price: 1 }, contentType: "application/json", txRef: FIXTURE_TX });

    // 署名器に届いたのは、プロファイルの domain と固定の型定義（`EIP712Domain` を含む）。
    expect(h.signed).toHaveLength(1);
    const typed = h.signed[0]!;
    expect(typed.primaryType).toBe("TransferWithAuthorization");
    expect(typed.domain).toEqual({ name: "USDC", version: "2", chainId: 84532, verifyingContract: FIXTURE_ASSET });
    expect(Object.keys(typed.types).sort()).toEqual(["EIP712Domain", "TransferWithAuthorization"]);
    expect(typed.types["EIP712Domain"]).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);
    expect(typed.message).toMatchObject({ from: h.address, value: 1000n });
    expect(String(typed.message["to"]).toLowerCase()).toBe(FIXTURE_PAY_TO);

    // 上流に届いた支払いは 1 件。`accepted` は保存した offer そのもの。署名は実際に検証を通る。
    expect(h.upstream.seen.payments).toHaveLength(1);
    expect(h.upstream.seen.challenges).toBe(2);
    const payment = h.upstream.seen.payments[0] as { accepted: unknown; extensions?: unknown };
    expect(payment.accepted).toEqual(offer);
    const verdict = await fetch(`${facilitator.baseUrl}/verify`, { method: "POST", body: JSON.stringify({ paymentPayload: payment, paymentRequirements: offer }) });
    expect(await verdict.json()).toEqual({ isValid: true, payer: h.address });
  });

  test("説明だけの欄を持つ offer も払える（欄はそのまま上流に戻る）。上流のトップレベルの欄は戻さない", async () => {
    const h = await harness();
    h.upstream.state.accepts = [standardAccept({ description: "ETH price", mimeType: "application/json", extra: { name: "USDC", version: "2", bazaar: { info: {} }, decimals: 6 } })];
    h.upstream.state.topLevel = { extensions: { bazaar: { info: { secret: "x" } } } };
    const offer = await h.quote();
    expect((await h.pay(offer)).outcome).toBe("paid");
    const payment = h.upstream.seen.payments[0] as { accepted: unknown; extensions?: unknown };
    expect(payment.accepted).toEqual(offer);
    expect(payment.extensions).toBeUndefined();
  });

  test("支払いの URL はクエリまで含めて渡されたもの", async () => {
    const h = await harness();
    const offer = await h.quote();
    await h.pay(offer);
    expect(h.upstream.seen.urls).toEqual([URL_A, URL_A, URL_A]);
  });

  /* ---------------------------------------------------------------- 一致の定義（設計 §3.2・AC-6） */

  test.each([
    ["amount", standardAccept({ amount: "1001" })],
    ["payTo", standardAccept({ payTo: "0x0000000000000000000000000000000000000a12" })],
    ["maxTimeoutSeconds", standardAccept({ maxTimeoutSeconds: 61 })],
    ["asset の綴り", standardAccept({ asset: FIXTURE_ASSET.toLowerCase() })],
    ["説明の欄が増えた", standardAccept({ description: "new" })],
    ["extra に許された欄が増えた", standardAccept({ extra: { name: "USDC", version: "2", decimals: 6 } })],
    ["network（別の chain の offer だけになった）", standardAccept({ network: "eip155:8453" })],
  ])("読み直しで %s が変わっていたら署名しない", async (_name, changed) => {
    const h = await harness();
    const offer = await h.quote();
    h.upstream.state.accepts = [changed];
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_offer_changed" });
    expect(h.signed).toHaveLength(0);
    expect(h.upstream.seen.payments).toHaveLength(0);
  });

  test("読み直しが成立しなければ署名しない（resource の束縛が外れた・402 でなくなった）", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.upstream.state.resourceUrl = () => "https://provider.test/v1/other";
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_challenge_unreadable" });
    h.upstream.state.resourceUrl = (url) => url;
    h.upstream.state.challengeStatus = 200;
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_challenge_unreadable" });
    expect(h.signed).toHaveLength(0);
    expect(h.upstream.seen.payments).toHaveLength(0);
  });

  test("保存した offer がプロファイルの検査を通らなければ、上流がそのとおり提示していても署名しない", async () => {
    const h = await harness();
    const permit2 = standardAccept({ extra: { name: "USDC", version: "2", assetTransferMethod: "permit2" } });
    h.upstream.state.accepts = [permit2];
    expect(await h.pay(permit2 as unknown as DestinationOffer)).toEqual({ outcome: "not_sent", reason: "destination_offer_not_allowed" });
    const overLimit = standardAccept({ amount: "100001" });
    h.upstream.state.accepts = [overLimit];
    expect(await h.pay(overLimit as unknown as DestinationOffer)).toEqual({ outcome: "not_sent", reason: "destination_offer_not_allowed" });
    expect(h.signed).toHaveLength(0);
    // 読み直しにも行かない。
    expect(h.upstream.seen.urls).toEqual([]);
  });

  /* ---------------------------------------------------------------- 署名の境界（AC-16） */

  const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));
  const withMessage = (patch: (message: Record<string, unknown>) => void) => (typed: TypedData): TypedData => {
    const message = { ...typed.message };
    patch(message);
    return { ...typed, message };
  };

  test.each([
    ["types に EIP712Domain を足す", (t: TypedData) => ({ ...t, types: { ...t.types, EIP712Domain: [{ name: "name", type: "string" }] } })],
    ["TransferWithAuthorization の型定義を変える", (t: TypedData) => ({ ...t, types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }] } })],
    ["types に別の型を足す", (t: TypedData) => ({ ...t, types: { ...t.types, Permit: [{ name: "owner", type: "address" }] } })],
    ["primaryType を変える", (t: TypedData) => ({ ...t, primaryType: "Permit" })],
    ["domain.name を変える", (t: TypedData) => ({ ...t, domain: { ...t.domain, name: "USD Coin" } })],
    ["domain.version を変える", (t: TypedData) => ({ ...t, domain: { ...t.domain, version: "1" } })],
    ["domain.chainId を変える", (t: TypedData) => ({ ...t, domain: { ...t.domain, chainId: 8453 } })],
    ["domain.verifyingContract を変える", (t: TypedData) => ({ ...t, domain: { ...t.domain, verifyingContract: "0x0000000000000000000000000000000000000Abc" } })],
    ["domain に salt を足す", (t: TypedData) => ({ ...t, domain: { ...t.domain, salt: `0x${"00".repeat(32)}` } })],
    ["domain から version を外す", (t: TypedData) => ({ ...t, domain: { name: t.domain["name"], chainId: t.domain["chainId"], verifyingContract: t.domain["verifyingContract"] } })],
    ["to を変える", withMessage((m) => { m["to"] = "0x0000000000000000000000000000000000000A12"; })],
    ["value を増やす", withMessage((m) => { m["value"] = 1001n; })],
    ["value を数値にする", withMessage((m) => { m["value"] = 1000; })],
    ["from を変える", withMessage((m) => { m["from"] = "0x0000000000000000000000000000000000000A12"; })],
    ["message に欄を足す", withMessage((m) => { m["spender"] = "0x0000000000000000000000000000000000000A12"; })],
    ["validBefore を上限の先にする", withMessage((m) => { m["validBefore"] = nowSeconds() + 3600n; })],
    ["validBefore を過去にする", withMessage((m) => { m["validBefore"] = nowSeconds() - 1n; })],
    ["validAfter を未来にする", withMessage((m) => { m["validAfter"] = nowSeconds() + 60n; })],
    ["validAfter を文字列にする", withMessage((m) => { m["validAfter"] = "0"; })],
    ["nonce を 32 バイトでなくする", withMessage((m) => { m["nonce"] = "0x1234"; })],
  ])("SDK が %s と、元の署名器は呼ばれず、何も送らない", async (_name, tamper) => {
    const h = await harness();
    const offer = await h.quote();
    sdk.tamper = tamper as (message: TypedData) => TypedData;
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_not_signed" });
    expect(h.signed).toHaveLength(0);
    expect(h.upstream.seen.payments).toHaveLength(0);
  });

  test("1 件の支払いで署名は 1 回だけ: SDK が 2 回目を求めても通さず、何も送らない", async () => {
    const h = await harness();
    const offer = await h.quote();
    sdk.extraSignatures = 1;
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_not_signed" });
    expect(h.signed).toHaveLength(1);
    expect(h.upstream.seen.payments).toHaveLength(0);
  });

  test("署名の境界そのもの: 武装していなければ拒否。有効期間は now+660 秒まで", async () => {
    const calls: TypedData[] = [];
    const NOW = 1_800_000_000_000;
    const account = privateKeyToAccount(generatePrivateKey());
    const guard = createRebuildingSigner({
      signer: { address: account.address, signTypedData: async (message: TypedData) => { calls.push(message); return "0x00"; } },
      profile: PROFILE,
      offer: standardAccept() as unknown as DestinationOffer,
      now: () => NOW,
    });
    const typed = (validBefore: bigint, validAfter = BigInt(NOW / 1000) - 600n): TypedData => ({
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: FIXTURE_ASSET },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: account.address, to: getAddress(FIXTURE_PAY_TO), value: 1000n, validAfter, validBefore, nonce: `0x${"ab".repeat(32)}` },
    });
    const edge = BigInt(NOW / 1000) + 660n;
    await expect(guard.signer.signTypedData(typed(edge))).rejects.toBeInstanceOf(SigningRefusedError);
    guard.arm();
    await expect(guard.signer.signTypedData(typed(edge + 1n))).rejects.toMatchObject({ reason: "destination_signing_validity_out_of_range" });
    guard.arm();
    await expect(guard.signer.signTypedData(typed(BigInt(NOW / 1000)))).rejects.toMatchObject({ reason: "destination_signing_validity_out_of_range" });
    guard.arm();
    await expect(guard.signer.signTypedData(typed(edge, BigInt(NOW / 1000) + 1n))).rejects.toMatchObject({ reason: "destination_signing_validity_out_of_range" });
    expect(calls).toHaveLength(0);
    guard.arm();
    await guard.signer.signTypedData(typed(edge, BigInt(NOW / 1000)));
    expect(calls).toHaveLength(1);
    // 拒否は武装を使い切る（1 回の武装で通るのは 1 回の呼び出しだけ）。
    await expect(guard.signer.signTypedData(typed(edge))).rejects.toMatchObject({ reason: "destination_signer_not_armed" });
    expect(guard.signatures()).toBe(1);
    expect(Object.keys(guard.signer).sort()).toEqual(["address", "signTypedData"]);
  });

  /* ---------------------------------------------------------------- 応答（AC-14・AC-15） */

  const receipt = (payer: string, overrides: Record<string, unknown> = {}) => ({ success: true, network: FIXTURE_NETWORK, transaction: FIXTURE_TX, payer, ...overrides });
  const reply = (payer: string, overrides: Partial<PayResponse>): PayResponse => ({ ...paidOk(payer), ...overrides });
  const paddedObject = (bytes: number) => {
    const empty = JSON.stringify({ pad: "" }).length;
    return JSON.stringify({ pad: "x".repeat(bytes - empty) });
  };

  test.each([
    ["JSON object", (p: string) => reply(p, { body: JSON.stringify({ a: 1 }) }), { outcome: "paid", body: { a: 1 } }],
    ["content-type にパラメータ", (p: string) => reply(p, { contentType: "Application/JSON; charset=utf-8" }), { outcome: "paid" }],
    ["本文が上限（256 KiB）ちょうど", (_p: string) => undefined, { outcome: "paid" }],
    ["text", (p: string) => reply(p, { body: "price is 1", contentType: "text/plain" }), { outcome: "paid_no_data", reason: "unsupported_response" }],
    ["JSON だが content-type が text", (p: string) => reply(p, { contentType: "text/plain" }), { outcome: "paid_no_data", reason: "unsupported_response" }],
    ["JSON の配列", (p: string) => reply(p, { body: "[1,2]" }), { outcome: "paid_no_data", reason: "unsupported_response" }],
    ["JSON の文字列", (p: string) => reply(p, { body: "\"ok\"" }), { outcome: "paid_no_data", reason: "unsupported_response" }],
    ["JSON として読めない", (p: string) => reply(p, { body: "{" }), { outcome: "paid_no_data", reason: "unsupported_response" }],
    ["content-length が上限超過", (_p: string) => undefined, { outcome: "paid_no_data", reason: "response_too_large" }],
    ["200 以外（201）＋整合した receipt", (p: string) => reply(p, { status: 201 }), { outcome: "paid_no_data", reason: "paid_data_unavailable" }],
    ["502＋整合した receipt", (p: string) => reply(p, { status: 502 }), { outcome: "paid_no_data", reason: "paid_data_unavailable" }],
    ["200 で receipt なし", (p: string) => reply(p, { receipt: undefined }), { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["204 で receipt なし", (p: string) => reply(p, { status: 204, body: "", receipt: undefined }), { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt が success: false", (p: string) => reply(p, { receipt: receipt(p, { success: false }) }), { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt の network が違う", (p: string) => reply(p, { receipt: receipt(p, { network: "eip155:8453" }) }), { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt の transaction がハッシュでない", (p: string) => reply(p, { receipt: receipt(p, { transaction: "https://evil.test/tx" }) }), { outcome: "unknown", reason: "destination_receipt_unverified" }],
    ["receipt の payer が別人", (p: string) => reply(p, { receipt: receipt("0x0000000000000000000000000000000000000bad") }), { outcome: "unknown", reason: "destination_receipt_payer_mismatch" }],
    ["402", (p: string) => reply(p, { status: 402, receipt: undefined }), { outcome: "rejected", reason: "destination_rejected" }],
    ["403", (p: string) => reply(p, { status: 403, receipt: undefined }), { outcome: "rejected", reason: "destination_rejected" }],
    ["500", (p: string) => reply(p, { status: 500, receipt: undefined }), { outcome: "unknown", reason: "destination_pay_unknown" }],
    ["502 で receipt なし", (p: string) => reply(p, { status: 502, receipt: undefined }), { outcome: "unknown", reason: "destination_pay_unknown" }],
    ["リダイレクト", (p: string) => reply(p, { status: 302, headers: { location: "https://provider.test/v1/elsewhere" } }), { outcome: "unknown", reason: "destination_pay_unknown" }],
    ["ヘッダが上限超過", (p: string) => reply(p, { headers: { "x-pad": "a".repeat(40_000) } }), { outcome: "unknown", reason: "destination_pay_unknown" }],
  ])("応答が %s", async (name, respond, expected) => {
    const h = await harness();
    const offer = await h.quote();
    const limit = DYNAMIC_RESPONSE_LIMITS.maxPaidBodyBytes;
    h.upstream.state.pay = () =>
      respond(h.address) ??
      (name.includes("ちょうど") ? reply(h.address, { body: paddedObject(limit) }) : reply(h.address, { body: paddedObject(limit + 1) }));
    expect(await h.pay(offer)).toMatchObject(expected);
    // どの終端でも、署名は 1 回・支払いの要求は 1 回（再署名・再送信・リダイレクト先への要求をしない）。
    expect(h.signed).toHaveLength(1);
    expect(h.upstream.seen.payments).toHaveLength(1);
    expect(h.upstream.seen.urls).toEqual([URL_A, URL_A, URL_A]);
    await settled();
    expect(h.gate.released).toBe(h.gate.admitted);
  });

  test("有料本文の上限: 20 MiB を送ろうとする上流でも 256 KiB で中断し、paid_no_data（receipt は残る）", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.upstream.state.pay = () => reply(h.address, { streamBytes: 20 * MIB });
    const result = await h.pay(offer);
    expect(result).toMatchObject({ outcome: "paid_no_data", reason: "response_too_large" });
    expect((result as { receiptRef?: string }).receiptRef).toEqual(expect.any(String));
    await settled();
    const stream = h.upstream.seen.streams[0]!;
    expect(stream.completed).toBe(false);
    expect(stream.written).toBeGreaterThan(DYNAMIC_RESPONSE_LIMITS.maxPaidBodyBytes);
    expect(stream.written).toBeLessThan(4 * MIB);
    expect(h.gate.released).toBe(h.gate.admitted);
  });

  test("receipt を本文より先に判定する: receipt が無ければ本文は読まない", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.upstream.state.pay = () => reply(h.address, { receipt: undefined, streamBytes: 20 * MIB });
    expect(await h.pay(offer)).toEqual({ outcome: "unknown", reason: "destination_receipt_unverified" });
    await settled();
    const stream = h.upstream.seen.streams[0]!;
    expect(stream.completed).toBe(false);
    expect(stream.written).toBeLessThan(4 * MIB);
  });

  test("対応外の content-type の本文は読まない", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.upstream.state.pay = () => reply(h.address, { contentType: "text/html", streamBytes: 20 * MIB });
    expect(await h.pay(offer)).toMatchObject({ outcome: "paid_no_data", reason: "unsupported_response" });
    await settled();
    expect(h.upstream.seen.streams[0]!.completed).toBe(false);
    expect(h.upstream.seen.streams[0]!.written).toBeLessThan(4 * MIB);
  });

  test("ヘッダの上限超過の終端は、未払いでは transport の失敗・支払い後は unknown", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.upstream.state.pay = () => reply(h.address, { headers: { "x-pad": "a".repeat(40_000) } });
    expect(await h.pay(offer)).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    h.upstream.state.challengeHeaders = { "x-pad": "a".repeat(40_000) };
    await expect(h.rail.readChallenge(PROFILE_ID, { url: URL_A })).rejects.toBeInstanceOf(TransportError);
  });

  /* ---------------------------------------------------------------- 期限 */

  test("有料要求の期限で打ち切ると unknown。枠は返る。再送しない", async () => {
    const h = await harness({ paidTimeoutMs: 300 });
    const offer = await h.quote();
    h.upstream.state.pay = () => reply(h.address, { delayMs: 2000 });
    const started = Date.now();
    expect(await h.pay(offer)).toEqual({ outcome: "unknown", reason: "destination_pay_unknown" });
    expect(Date.now() - started).toBeLessThan(1500);
    await settled();
    expect(h.gate).toEqual({ admitted: 3, released: 3 });
    expect(h.upstream.seen.payments).toHaveLength(1);
    expect(h.signed).toHaveLength(1);
  });

  test("receipt を確かめた後に本文が途中で固まったら、期限で打ち切って paid_no_data（receipt は残る・枠は返る・再送しない）", async () => {
    const h = await harness({ paidTimeoutMs: 400 });
    const offer = await h.quote();
    h.upstream.state.pay = () => reply(h.address, { streamBytes: 64 * 1024, stallAfterBytes: 16 * 1024 });
    const started = Date.now();
    const result = await h.pay(offer);
    expect(result).toMatchObject({ outcome: "paid_no_data", reason: "paid_data_unavailable" });
    expect((result as { receiptRef?: string }).receiptRef).toEqual(expect.any(String));
    expect(Date.now() - started).toBeLessThan(2000);
    await settled();
    expect(h.gate).toEqual({ admitted: 3, released: 3 });
    expect(h.upstream.seen.payments).toHaveLength(1);
    expect(h.signed).toHaveLength(1);
  });

  test("receipt を確かめた後に本文の途中で接続が切れたら paid_no_data（receipt は残る・枠は返る・再送しない）", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.upstream.state.pay = () => reply(h.address, { streamBytes: 64 * 1024, resetAfterBytes: 16 * 1024 });
    const result = await h.pay(offer);
    expect(result).toMatchObject({ outcome: "paid_no_data", reason: "paid_data_unavailable" });
    expect((result as { receiptRef?: string }).receiptRef).toEqual(expect.any(String));
    await settled();
    expect(h.gate).toEqual({ admitted: 3, released: 3 });
    expect(h.upstream.seen.payments).toHaveLength(1);
    expect(h.signed).toHaveLength(1);
  });

  test("有料要求の期限は未払いの期限と別: 未払いの期限より遅い応答でも成立する", async () => {
    const h = await harness({ unpaidTimeoutMs: 300, paidTimeoutMs: 5000 });
    const offer = await h.quote();
    h.upstream.state.pay = () => reply(h.address, { delayMs: 900 });
    expect((await h.pay(offer)).outcome).toBe("paid");
  });

  test("既定の有料要求の期限は 5 秒より長い（5.5 秒かかる上流でも成立する）", async () => {
    const h = await harness();
    const offer = await h.quote();
    h.upstream.state.pay = () => reply(h.address, { delayMs: 5500 });
    expect((await h.pay(offer)).outcome).toBe("paid");
  }, 15_000);

  test("署名能力の network がプロファイルと違えば署名しない", async () => {
    const h = await harness({ profile: { ...PROFILE, destination: { ...PROFILE.destination, network: "eip155:8453" } } });
    const offer = standardAccept({ network: "eip155:8453" }) as unknown as DestinationOffer;
    expect(await h.pay(offer)).toEqual({ outcome: "not_sent", reason: "destination_signer_network_mismatch" });
    expect(h.signed).toHaveLength(0);
    expect(h.upstream.seen.urls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ 組み立て */

test("動的経路は loopback を許す transport を受け取らない（起動失敗）", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const loopback = createGuardedTransport({ allowLoopback: true, report: () => {} });
  expect(() =>
    createX402Outbound({
      upstreams: {},
      transport: loopback,
      capability: { network: FIXTURE_NETWORK, kind: "real-key", signer: { address: account.address, signTypedData: async () => "0x00" } },
      dynamic: { profiles: { [PROFILE_ID]: PROFILE }, transport: loopback },
    }),
  ).toThrow("loopback");
  const unbounded = createGuardedTransport({ allowLoopback: false, report: () => {} });
  expect(() =>
    createX402Outbound({
      upstreams: {},
      transport: loopback,
      capability: { network: FIXTURE_NETWORK, kind: "real-key", signer: { address: account.address, signTypedData: async () => "0x00" } },
      dynamic: { profiles: { [PROFILE_ID]: PROFILE }, transport: unbounded },
    }),
  ).toThrow("DNS deadline");
});
