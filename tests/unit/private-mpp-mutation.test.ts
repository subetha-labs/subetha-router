/**
 * 秘匿購入の Tempo pull: **私的発行の経路そのもの**で、SDK が署名口に渡す transaction の各欄をすり替えると署名しない（署名 0 回・放送 0 回・発行失敗）。
 * `mppx/client` の `tempo.charge` を包み、SDK が渡す account の `signTransaction` の引数を改変する（guard はその後ろで本物の account を守る）。
 */
import { maxUint256, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  tamper: undefined as undefined | ((tx: Record<string, unknown>) => Record<string, unknown>),
}));

vi.mock("mppx/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mppx/client")>();
  return {
    ...actual,
    tempo: {
      ...actual.tempo,
      charge: (parameters: { account: { signTransaction(tx: unknown, options?: unknown): Promise<Hex> } }) => {
        const guard = parameters.account;
        const account = {
          ...guard,
          signTransaction: (tx: unknown, options?: unknown) => guard.signTransaction(sdk.tamper === undefined ? tx : sdk.tamper(tx as Record<string, unknown>), options),
        };
        return actual.tempo.charge({ ...parameters, account } as never);
      },
    },
  };
});

import { Challenge } from "mppx";
import { Mppx, tempo } from "mppx/server";
import { createClient, http as viemHttp } from "viem";
import { tempoModerato } from "viem/tempo/chains";

import { createPrivateMppRail } from "../../src/adapters/outbound/private-mpp.js";
import type { DynamicProfile } from "../../src/config.js";
import { createGuardedTransport, type GuardedTransport } from "../../src/net/guarded-fetch.js";
import type { MppTempoCapability } from "../../src/ports/outbound.js";
import { createRealMppCapability } from "../../tools/real-mpp-capability.js";
import { dialTo, publicLookup } from "../fixtures/dynamic/dial.js";
import { MPP_FIXTURE_CHAIN_ID, MPP_FIXTURE_CURRENCY, MPP_FIXTURE_RECIPIENT } from "../fixtures/dynamic/mpp-upstream.js";
import { startTempoRpc, type TempoRpc } from "../fixtures/dynamic/tempo-rpc.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

const PROFILE_ID = "priv-tempo";
const PROFILE: DynamicProfile = {
  profileId: PROFILE_ID,
  sourceRail: "x402",
  source: { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, payTo: "0x00000000000000000000000000000000000000b0" },
  rail: "mpp",
  destination: { scheme: "tempo/charge", network: `eip155:${MPP_FIXTURE_CHAIN_ID}`, asset: MPP_FIXTURE_CURRENCY, decimals: 6, feeAsset: MPP_FIXTURE_CURRENCY, maxFee: "5000" },
  par: true,
  maxUpstreamAmount: "100000",
  fee: { flat: "1000", bps: 0, min: "1000" },
};
const HOST = "test-server.io";
const URL_POST = `https://${HOST}/select`;
const RPC_HOST = "rpc.other.test";
const OTHER = "0x0000000000000000000000000000000000000bad";

let TLS: TlsMaterial;
beforeAll(() => {
  TLS = generateTestTls({ extraProviderNames: [HOST] });
});
afterAll(() => {
  TLS.cleanup();
});
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  sdk.tamper = undefined;
  while (closers.length > 0) await closers.pop()!();
});

async function harness(): Promise<{ rpc: TempoRpc; rail: ReturnType<typeof createPrivateMppRail>; signatures(): number; challenge: string }> {
  const rpc = await startTempoRpc({ tls: TLS });
  closers.push(rpc.close);
  const inner = createGuardedTransport({ allowLoopback: false, report: () => {}, dns: { timeoutMs: 3_000, maxInFlight: 16 }, lookup: publicLookup(), interfaces: () => [], tls: { ca: [TLS.ca] }, dialForTest: dialTo({ [RPC_HOST]: rpc.port }) });
  const client = createClient({ chain: { ...tempoModerato, id: MPP_FIXTURE_CHAIN_ID } as never, transport: viemHttp(rpc.plainUrl, { retryCount: 0 }) });
  const server = Mppx.create({ secretKey: "fixture-secret-0123456789abcdef0123456789abcdef", realm: HOST, methods: [tempo.charge({ recipient: MPP_FIXTURE_RECIPIENT, currency: MPP_FIXTURE_CURRENCY, decimals: 0, getClient: () => client as never, supportedModes: ["pull"] } as never)] }) as unknown as { challenge: { tempo: { charge(parameters: Record<string, unknown>): Promise<Record<string, unknown>> } } };
  const scope = `POST ${URL_POST}`;
  const challenge = Challenge.serialize((await server.challenge.tempo.charge({ amount: "1000", chainId: MPP_FIXTURE_CHAIN_ID, expires: new Date(Date.now() + 600_000).toISOString(), scope, meta: { _mppx_scope: scope } })) as never);
  const transport: GuardedTransport = {
    allowLoopback: false,
    boundsDns: true,
    report: inner.report,
    fetch: async (url, init, context) => (new URL(String(url)).hostname === HOST ? new Response("{}", { status: 402, headers: { "www-authenticate": challenge } }) : inner.fetch(url, init, context)),
  };
  const base = createRealMppCapability(generatePrivateKey(), { rpcUrl: `https://${RPC_HOST}`, chainId: MPP_FIXTURE_CHAIN_ID }).capability();
  let signatures = 0;
  const capability: MppTempoCapability = {
    ...base,
    account: {
      ...base.account,
      signTransaction: async (transaction: unknown, options?: unknown) => {
        signatures += 1;
        return (base.account as unknown as { signTransaction(t: unknown, o?: unknown): Promise<Hex> }).signTransaction(transaction, options);
      },
    } as never,
  };
  return { rpc, rail: createPrivateMppRail(capability, { profiles: { [PROFILE_ID]: PROFILE }, transport }), signatures: () => signatures, challenge };
}

describe("私的発行の経路での envelope のすり替え", () => {
  test.each<[string, (tx: Record<string, unknown>) => Record<string, unknown>]>([
    ["chainId", (tx) => ({ ...tx, chainId: 1 })],
    ["feeToken が別の資産", (tx) => ({ ...tx, feeToken: OTHER })],
    ["feeToken 無し", (tx) => ({ ...tx, feeToken: undefined })],
    ["calls が 2 件", (tx) => ({ ...tx, calls: [...(tx["calls"] as unknown[]), ...(tx["calls"] as unknown[])] })],
    ["calls の to が別の契約", (tx) => ({ ...tx, calls: [{ ...((tx["calls"] as Record<string, unknown>[])[0] ?? {}), to: OTHER }] })],
    ["calls の data（memo）が違う", (tx) => ({ ...tx, calls: [{ ...((tx["calls"] as Record<string, unknown>[])[0] ?? {}), data: `${String((tx["calls"] as Record<string, unknown>[])[0]?.["data"]).slice(0, -2)}ff` }] })],
    ["calls に value", (tx) => ({ ...tx, calls: [{ ...((tx["calls"] as Record<string, unknown>[])[0] ?? {}), value: 1n }] })],
    ["nonceKey が expiring でない", (tx) => ({ ...tx, nonceKey: 1n })],
    ["validBefore が過去", (tx) => ({ ...tx, validBefore: Math.floor(Date.now() / 1000) - 10 })],
    ["validBefore が遠い未来", (tx) => ({ ...tx, validBefore: Math.floor(Date.now() / 1000) + 3_600 })],
    ["feePayer（sponsored）", (tx) => ({ ...tx, feePayer: true })],
    ["gas が巨大（手数料が cap 超過）", (tx) => ({ ...tx, gas: 50_000_000_000n })],
    ["未知の欄", (tx) => ({ ...tx, authorizationList: [{}] })],
  ])("署名しない: %s", async (_name, tamper) => {
    const h = await harness();
    const found = await h.rail.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" });
    expect(found.offers).toHaveLength(1);
    sdk.tamper = tamper;
    const result = await h.rail.issueCredential({ profileId: PROFILE_ID, offer: found.offers[0]!, target: { url: URL_POST, method: "POST", body: "{}" }, challenge: found.challenge, deadlineMs: Date.now() + 60_000, maxFee: "5000" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.signed).toBe(false);
    expect(h.signatures()).toBe(0);
    expect(h.rpc.sentRaw).toHaveLength(0);
    expect(maxUint256 > 0n).toBe(true);
  });
  test("改変しなければ発行できる（対照）", async () => {
    const h = await harness();
    const found = await h.rail.discover(PROFILE_ID, { url: URL_POST, method: "POST", body: "{}" });
    const result = await h.rail.issueCredential({ profileId: PROFILE_ID, offer: found.offers[0]!, target: { url: URL_POST, method: "POST", body: "{}" }, challenge: found.challenge, deadlineMs: Date.now() + 60_000, maxFee: "5000" });
    expect(result.ok).toBe(true);
    expect(h.signatures()).toBe(1);
    expect(h.rpc.sentRaw).toHaveLength(0);
  });
});
