/**
 * Arc の Provider に払う（送信の設計 §3、FR-22・FR-23・FR-27・FR-33、AC-8。タスク U4）。
 *
 * 実 TCP / TLS（loopback の fixture。TCP の行き先だけを fixture に向ける）。署名は**毎回の乱数の鍵**。資金は動かない。
 * - 静的 route（`rebuildSignatures: true`）: 表の domain（USDC/2・chainId 5042002・contract）と承認値だけで typed data を組み直して署名する。SDK の typed data は署名器に届かない
 * - 動的プロファイル `dyn-x402-to-arc`: 既存の動的 x402 の経路が Arc 用の能力で動く
 * - **Base 用の能力は Arc の offer を拒み、Arc 用は Base を拒む**（AC-8 の両方向）
 * - Arc の送信で chain の RPC には出ない（FR-33）: transport の事象は Provider のホストだけ
 * - `extra.assetTransferMethod` は V-6 の結果まで拒否のまま（動的の候補の段階）
 */
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  /** SDK が署名器に渡す typed data を書き換える（組み直しの署名器なら、書き換えは署名器に届かない）。 */
  tamper: undefined as undefined | ((message: TypedDataLike) => TypedDataLike),
  /** adapter が支払いヘッダを符号化している間に走る hook（送出の直前の検査の前）。 */
  duringEncode: undefined as undefined | (() => void),
  /** SDK が返す payload の x402Version を書き換える。 */
  payloadVersion: undefined as undefined | number,
}));
vi.mock("@x402/fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@x402/fetch")>();
  class HookedHttpClient extends actual.x402HTTPClient {
    override async createPaymentPayload(...args: Parameters<InstanceType<typeof actual.x402HTTPClient>["createPaymentPayload"]>): ReturnType<InstanceType<typeof actual.x402HTTPClient>["createPaymentPayload"]> {
      const payload = await super.createPaymentPayload(...args);
      return sdk.payloadVersion === undefined ? payload : { ...payload, x402Version: sdk.payloadVersion };
    }
    override encodePaymentSignatureHeader(payload: Parameters<InstanceType<typeof actual.x402HTTPClient>["encodePaymentSignatureHeader"]>[0]): Record<string, string> {
      sdk.duringEncode?.();
      return super.encodePaymentSignatureHeader(payload);
    }
  }
  return { ...actual, x402HTTPClient: HookedHttpClient };
});
type TypedDataLike = { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
vi.mock("@x402/evm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@x402/evm")>();
  class TamperingScheme extends actual.ExactEvmScheme {
    constructor(signer: { address: `0x${string}`; signTypedData(message: TypedDataLike): Promise<`0x${string}`> }) {
      super({ address: signer.address, signTypedData: async (message: TypedDataLike) => signer.signTypedData(sdk.tamper === undefined ? message : sdk.tamper(message)) });
    }
  }
  return { ...actual, ExactEvmScheme: TamperingScheme };
});

import { createX402Outbound } from "../../src/adapters/outbound/x402.js";
import type { DynamicProfile } from "../../src/config.js";
import { DYNAMIC_RESPONSE_LIMITS } from "../../src/net/bounded-body.js";
import { createGuardedTransport, type TransportEvent } from "../../src/net/guarded-fetch.js";
import type { DestinationOffer, EvmSigningCapability, OutboundRail } from "../../src/ports/outbound.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { FIXTURE_ASSET, FIXTURE_NETWORK, FIXTURE_TX, paidOk, standardAccept, startX402Upstream, type X402Upstream } from "../fixtures/dynamic/x402-upstream.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

type TypedData = { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };

const ARC = "eip155:5042002";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const ARC_PROVIDER = "0xAF42CFfe4B35A05098613d962aF43CDc43fBb4Ea";
const ROUTE = "md-arc-eth-snapshot";
const PROFILE_ID = "dyn-x402-to-arc";
const OPERATOR_PAY_TO = "0x00000000000000000000000000000000000000b0";
const UPSTREAM = "https://provider.test/v1/eth/snapshot";
const URL_A = "https://provider.test/v1/price?symbol=ETH";
const DOMAINS = { [ARC_USDC.toLowerCase()]: { name: "USDC", version: "2" } };
const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "x402",
  source: { network: FIXTURE_NETWORK, asset: FIXTURE_ASSET, decimals: 6, payTo: OPERATOR_PAY_TO },
  rail: "x402",
  destination: { scheme: "exact", network: ARC, asset: ARC_USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "0", bps: 0, min: "0" },
};
const arcAccept = (overrides: Record<string, unknown> = {}) => standardAccept({ network: ARC, asset: ARC_USDC, payTo: ARC_PROVIDER, ...overrides });

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
  sdk.duringEncode = undefined;
  sdk.payloadVersion = undefined;
  while (closers.length > 0) await closers.pop()!();
});

interface Harness {
  readonly upstream: X402Upstream;
  readonly rail: OutboundRail;
  readonly address: `0x${string}`;
  readonly signed: TypedData[];
  readonly events: TransportEvent[];
  /** transport が接続しようとしたホスト名（dial の記録。成功した接続も含む）。 */
  readonly dialed: string[];
}

/** `network` の能力で静的 route（Arc 宛）と動的プロファイルを持つ rail。`rebuild` は静的の組み直し。 */
async function harness(options: { network?: string; rebuild?: boolean; operatorAddresses?: readonly string[]; now?: () => number } = {}): Promise<Harness> {
  const upstream = await startX402Upstream(TLS);
  closers.push(upstream.close);
  upstream.state.accepts = [arcAccept()];
  const account = privateKeyToAccount(generatePrivateKey());
  const signed: TypedData[] = [];
  const events: TransportEvent[] = [];
  const dialed: string[] = [];
  const dial = dialTo({ "provider.test": upstream.port });
  const transportOptions = {
    allowLoopback: false,
    report: (event: TransportEvent) => events.push(event),
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: publicLookup(),
    dialForTest: (target: Parameters<typeof dial>[0]) => { dialed.push(target.hostname); return dial(target); },
  };
  const transport = createGuardedTransport(transportOptions);
  const dynamicTransport = createGuardedTransport({ ...transportOptions, maxHeaderSize: DYNAMIC_RESPONSE_LIMITS.maxHeaderBytes, dns: { timeoutMs: 2_000, maxInFlight: 16 } });
  const capability: EvmSigningCapability = {
    network: options.network ?? ARC,
    kind: "real-key",
    signer: {
      address: account.address,
      signTypedData: async (message: TypedData) => {
        signed.push(message);
        return account.signTypedData(message as never);
      },
    },
  };
  const rebuild = options.rebuild ?? true;
  const rail = createX402Outbound({
    upstreams: { [ROUTE]: UPSTREAM },
    transport,
    capability,
    ...(options.now === undefined ? {} : { now: options.now }),
    rebuildSignatures: rebuild,
    ...(rebuild ? { tokenDomains: DOMAINS } : {}),
    ...(options.operatorAddresses === undefined ? {} : { operatorAddresses: options.operatorAddresses }),
    dynamic: { profiles: { [PROFILE_ID]: PROFILE }, transport: dynamicTransport, denyHosts: [] },
  });
  upstream.state.pay = () => paidOk(account.address, { price: 1 }, ARC);
  return { upstream, rail, address: account.address, signed, events, dialed };
}

const pay = (h: Harness, routeId: string, offer: DestinationOffer, url?: string) =>
  h.rail.pay({ routeId, offer, paymentId: "p1", attempt: 1, deadlineMs: Date.now() + 600_000, ...(url === undefined ? {} : { target: { url } }) });

describe("静的 route（組み直しの署名器）", () => {
  test("Arc の Provider が delivered（paid）。typed data は表の domain・chainId 5042002・contract・承認値で、SDK の object は署名器に届かない", async () => {
    const h = await harness();
    const offers = await h.rail.readChallenge(ROUTE);
    expect(offers).toHaveLength(1);
    const result = await pay(h, ROUTE, offers[0]!);
    expect(result).toMatchObject({ outcome: "paid", txRef: FIXTURE_TX, body: { price: 1 } });
    expect(h.signed).toHaveLength(1);
    const typed = h.signed[0]!;
    expect(typed.primaryType).toBe("TransferWithAuthorization");
    expect(typed.domain).toEqual({ name: "USDC", version: "2", chainId: 5042002, verifyingContract: getAddress(ARC_USDC) });
    expect(typed.message).toMatchObject({ from: getAddress(h.address), to: getAddress(ARC_PROVIDER), value: 1000n });
    expect(Object.keys(typed.message).sort()).toEqual(["from", "nonce", "to", "validAfter", "validBefore", "value"]);
    expect(h.upstream.seen.payments).toHaveLength(1);
  });

  test("SDK の typed data の domain の name/version と types を書き換えれば署名しない（組み直しの署名器は表の domain・固定の型と 1 欄ずつ照合する。従来の passthrough は chainId・contract・to・from・value しか見ないので署名してしまう）", async () => {
    const h = await harness();
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    sdk.tamper = (message) => ({ ...message, domain: { ...message.domain, name: "EVIL", version: "9" }, types: { ...message.types, TransferWithAuthorization: [...(message.types["TransferWithAuthorization"] as unknown[]), { name: "extra", type: "uint256" }] } });
    expect(await pay(h, ROUTE, offer)).toMatchObject({ outcome: "not_sent" });
    expect(h.signed).toHaveLength(0);
    expect(h.upstream.seen.payments).toHaveLength(0);
  });

  test("SDK の typed data の宛先・額を書き換えれば署名しない（組み直しの照合）", async () => {
    const h = await harness();
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    sdk.tamper = (message) => ({ ...message, message: { ...message.message, to: "0x0000000000000000000000000000000000000bad", value: 999_999n } });
    expect(await pay(h, ROUTE, offer)).toMatchObject({ outcome: "not_sent" });
    expect(h.signed).toHaveLength(0);
    expect(h.upstream.seen.payments).toHaveLength(0);
  });

  test("FR-33: Arc の送信で接続する先は Provider のホストだけ（chain の RPC には出ない。dial の記録で見る）", async () => {
    const h = await harness();
    expect(await pay(h, ROUTE, (await h.rail.readChallenge(ROUTE))[0]!)).toMatchObject({ outcome: "paid" });
    expect(h.dialed.length).toBeGreaterThanOrEqual(2);
    expect(new Set(h.dialed)).toEqual(new Set(["provider.test"]));
  });

  test("支払いヘッダを符号化している間に期限が切れれば送らない（署名 1・支払い要求 0）", async () => {
    let expired = false;
    const h = await harness({ now: () => (expired ? Date.now() + 10_000_000 : Date.now()) });
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    sdk.duringEncode = () => { expired = true; };
    expect(await pay(h, ROUTE, offer)).toEqual({ outcome: "not_sent", reason: "destination_deadline" });
    expect(h.signed).toHaveLength(1);
    expect(h.upstream.seen.payments).toHaveLength(0);
  });

  test("SDK が返した payload の x402Version が 2 でなければ送らない", async () => {
    const h = await harness();
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    sdk.payloadVersion = 1;
    expect(await pay(h, ROUTE, offer)).toEqual({ outcome: "not_sent", reason: "destination_payload_mismatch" });
    expect(h.upstream.seen.payments).toHaveLength(0);
  });

  test("領収は共有の表: network が Base の領収は Arc の送信では unknown", async () => {
    const h = await harness();
    h.upstream.state.pay = () => paidOk(h.address, { price: 1 }, FIXTURE_NETWORK);
    expect(await pay(h, ROUTE, (await h.rail.readChallenge(ROUTE))[0]!)).toEqual({ outcome: "unknown", reason: "destination_receipt_unverified" });
  });

  test("表に無い資産（domain が引けない）の静的 offer には署名しない", async () => {
    const h = await harness();
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    expect(await pay(h, ROUTE, { ...offer, asset: "0x0000000000000000000000000000000000000abc" })).toMatchObject({ outcome: "not_sent" });
    expect(h.signed).toHaveLength(0);
  });
});

describe("動的プロファイル dyn-x402-to-arc", () => {
  test("Arc の Provider が paid（既存の動的の経路が Arc 用の能力で動く）", async () => {
    const h = await harness();
    const offer = (await h.rail.readChallenge(PROFILE_ID, { url: URL_A }))[0]!;
    expect(offer).toMatchObject({ network: ARC, asset: ARC_USDC, payTo: ARC_PROVIDER });
    expect(await pay(h, PROFILE_ID, offer, URL_A)).toMatchObject({ outcome: "paid", txRef: FIXTURE_TX });
    expect(h.signed[0]!.domain).toMatchObject({ chainId: 5042002, verifyingContract: getAddress(ARC_USDC) });
  });

  test("extra.assetTransferMethod は \"eip3009\" だけ候補（Circle の受取側が出す値。V-6）: 動的の購入が署名 1 回で delivered。permit2・他の値は候補外、pay の再検査でも not_sent", async () => {
    const h = await harness();
    h.upstream.state.accepts = [arcAccept({ extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" } })];
    const offers = await h.rail.readChallenge(PROFILE_ID, { url: URL_A });
    expect(offers).toHaveLength(1);
    expect(offers[0]!.extra?.["assetTransferMethod"]).toBe("eip3009");
    h.upstream.state.pay = () => paidOk(h.address, { ok: true }, ARC);
    const result = await h.rail.pay({ routeId: PROFILE_ID, offer: offers[0]!, paymentId: "p-eip3009", attempt: 1, deadlineMs: Date.now() + 600_000, target: { url: URL_A } });
    expect(result).toMatchObject({ outcome: "paid" });
    expect(h.signed).toHaveLength(1);
    // 署名した typed data は組み直しの署名器のもの（domain は表、宛先と額は承認値）。
    expect(h.signed[0]!.domain).toMatchObject({ chainId: 5042002, verifyingContract: getAddress(ARC_USDC) });
    expect(h.upstream.seen.payments).toHaveLength(1);
    for (const value of ["permit2", "EIP3009", "", 1]) {
      h.upstream.state.accepts = [arcAccept({ extra: { name: "USDC", version: "2", assetTransferMethod: value } })];
      expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A }), String(value)).toEqual([]);
    }
    // 保存した offer に permit2 が入っていれば pay の再検査で not_sent（署名 0・支払い 0）。
    const tampered = { ...offers[0]!, extra: { ...offers[0]!.extra, assetTransferMethod: "permit2" } };
    expect(await h.rail.pay({ routeId: PROFILE_ID, offer: tampered, paymentId: "p-permit2", attempt: 1, deadlineMs: Date.now() + 600_000, target: { url: URL_A } })).toEqual({ outcome: "not_sent", reason: "destination_offer_not_allowed" });
    expect(h.signed).toHaveLength(1);
    expect(h.upstream.seen.payments).toHaveLength(1);
  });

  test("運用者の集合（合成が注入する）にある受取先は候補に出ない", async () => {
    const h = await harness({ operatorAddresses: [ARC_PROVIDER] });
    expect(await h.rail.readChallenge(PROFILE_ID, { url: URL_A })).toEqual([]);
    expect(await h.rail.readChallenge(ROUTE)).toEqual([]);
  });
});

describe("AC-8: 能力の network の束縛（両方向）", () => {
  test("Base 用の能力（従来の経路）に Arc の offer → not_sent destination_signer_network_mismatch（署名 0）", async () => {
    const h = await harness({ network: FIXTURE_NETWORK, rebuild: false });
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    expect(offer.network).toBe(ARC);
    expect(await pay(h, ROUTE, offer)).toEqual({ outcome: "not_sent", reason: "destination_signer_network_mismatch" });
    expect(h.signed).toHaveLength(0);
    expect(h.upstream.seen.payments).toHaveLength(0);
  });

  test("Arc 用の能力に Base の offer → not_sent destination_signer_network_mismatch（署名 0）", async () => {
    const h = await harness();
    h.upstream.state.accepts = [standardAccept()];
    const offer = (await h.rail.readChallenge(ROUTE))[0]!;
    expect(offer.network).toBe(FIXTURE_NETWORK);
    expect(await pay(h, ROUTE, offer)).toEqual({ outcome: "not_sent", reason: "destination_signer_network_mismatch" });
    expect(h.signed).toHaveLength(0);
  });

  test("Base 以外の EVM で rebuildSignatures を付けずに組ませない（合成の契約）: tokenDomains 無しの rebuild は作れない", () => {
    expect(() => createX402Outbound({ upstreams: {}, transport: createGuardedTransport({ allowLoopback: true, report: () => {} }), capability: { network: ARC, kind: "real-key", signer: { address: "0x0000000000000000000000000000000000000501", signTypedData: async () => "0x" } as never }, rebuildSignatures: true })).toThrow(/token domains/);
  });
});
