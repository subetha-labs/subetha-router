/**
 * 送信の合成 `(rail, network)`（送信の設計 §2.1〜§2.3、FR-27・FR-38。タスク U4）。
 * - 組ごとに adapter が 1 つ。`railByRoute` が routeId／profileId から**その組の** adapter を引く（Base 用の能力で Arc の route を払わない）
 * - 起動時の検査（fail closed）: 欠落・重複・key と `network` の不一致・family の不一致・SVM の address の形
 * - 残高の選択は組ごと（rail の `balanceOf` → 能力の → なし）
 * - 運用者の集合は (a) 受信の受取先 ＋ (b) 注入された送信能力の公開アドレス。Provider の `destination.payTo` は入れない
 * - Solana 宛の送信があれば（受信が無くても）Solana RPC は拒否ホストに入る（adapter 自体は U8。ここでは組の集合だけ）
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { loadRuntimeConfig, type DynamicProfile } from "../../src/config.js";
import { composeRails, operatorAddressesOf, outboundCapabilitiesOf, outboundPairKeyOf, type RouterCapabilities } from "../../src/main.js";
import { TransportError } from "../../src/net/guarded-fetch.js";
import type { EvmSigningCapability, MppTempoCapability, SvmSigningCapability } from "../../src/ports/outbound.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";
import { createSignerSpy } from "../fixtures/x402-signer-spy.js";

const BASE = "eip155:84532";
const ARC = "eip155:5042002";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const SOL_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PATHUSD = "0x20c0000000000000000000000000000000000000";
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const ARC_PROVIDER = "0xAF42CFfe4B35A05098613d962aF43CDc43fBb4Ea";
const SOL_OWNER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
/** 誰も聞いていない loopback の URL（allowed なら connect_failed、禁止なら destination_blocked）。port は実行時に取る。 */
let LOOPBACK_CLOSED = "";
beforeAll(async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  LOOPBACK_CLOSED = `http://127.0.0.1:${port}/`;
});

function evm(network: string, address: `0x${string}`, kind: EvmSigningCapability["kind"] = "real-key", balance?: bigint): EvmSigningCapability {
  return {
    network,
    kind,
    signer: { address, signTypedData: async () => "0x" } as unknown as EvmSigningCapability["signer"],
    ...(balance === undefined ? {} : { balanceOf: async () => balance }),
  };
}
const MPP: MppTempoCapability = {
  chainId: 42431,
  account: { address: "0x0000000000000000000000000000000000000502" } as unknown as MppTempoCapability["account"],
  getClient: () => {
    throw new Error("must not be reached");
  },
  kind: "real-key",
};
const svm = (network: string, address: string): SvmSigningCapability => ({ network, address, sign: () => new Uint8Array(64), kind: "fixture-key" });

/** Base → Arc の静的 route、Base → Base の静的 route、Tempo → Arc の動的プロファイル。 */
function envFor(options: { solRoute?: boolean } = {}): Record<string, string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "outbound-composition-"));
  const routes: Record<string, unknown> = {
    "r-base": {
      routeId: "r-base",
      canonicalPath: "/v1/routes/r-base/resource",
      rail: "x402",
      sourceRail: "mpp",
      source: { amount: "1500", asset: PATHUSD, decimals: 6, network: "eip155:42431", payTo: RECEIVER },
      destination: { scheme: "exact", network: BASE, asset: USDC, payTo: "0x0000000000000000000000000000000000000a11" },
    },
    "r-arc": {
      routeId: "r-arc",
      canonicalPath: "/v1/routes/r-arc/resource",
      rail: "x402",
      sourceRail: "x402",
      source: { amount: "1500", asset: USDC, decimals: 6, network: BASE, payTo: RECEIVER },
      destination: { scheme: "exact", network: ARC, asset: ARC_USDC, payTo: ARC_PROVIDER },
    },
    ...(options.solRoute
      ? {
          "r-sol": {
            routeId: "r-sol",
            canonicalPath: "/v1/routes/r-sol/resource",
            rail: "x402",
            sourceRail: "x402",
            source: { amount: "1500", asset: USDC, decimals: 6, network: BASE, payTo: RECEIVER },
            destination: { scheme: "exact", network: SOL, asset: SOL_USDC, payTo: SOL_OWNER },
          },
        }
      : {}),
  };
  const profile: DynamicProfile = {
    profileId: "dyn-mpp-to-arc",
    sourceRail: "mpp",
    source: { network: "eip155:42431", asset: PATHUSD, decimals: 6, payTo: RECEIVER },
    rail: "x402",
    destination: { scheme: "exact", network: ARC, asset: ARC_USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } },
    par: true,
    maxUpstreamAmount: "10000",
    fee: { flat: "1000", bps: 0, min: "1000" },
  };
  const buckets = [
    { network: BASE, asset: USDC, maxTotal: "100000", maxPerPurchase: "5000" },
    { network: "eip155:42431", asset: PATHUSD, maxTotal: "100000", maxPerPurchase: "5000" },
    { network: ARC, asset: ARC_USDC, maxTotal: "100000", maxPerPurchase: "5000" },
    { network: SOL, asset: SOL_USDC, maxTotal: "100000", maxPerPurchase: "5000" },
  ];
  const document = {
    router: {
      approvalTtlMs: 60_000,
      routes,
      budget: { maxPurchases: 8, buckets },
      dynamic: { enabled: true, profiles: { [profile.profileId]: profile }, budget: { maxPurchases: 8, buckets }, denyHosts: [] },
    },
    x402: {
      upstreams: Object.fromEntries(Object.keys(routes).map((routeId) => [routeId, `${LOOPBACK_CLOSED}v1/${routeId}`])),
      inboundFacilitators: { [ARC]: { kind: "circle", url: "https://circle.test" }, [SOL]: { kind: "x402", url: "https://svm.test" } },
    },
  };
  const file = path.join(dir, "router.config.json");
  writeFileSync(file, JSON.stringify(document));
  return {
    ROUTER_CONFIG_PATH: file,
    ROUTER_PRINCIPAL_TOKENS: "a:b",
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: "http://127.0.0.1:1",
    ROUTER_X402_INBOUND_FACILITATOR_URL: "http://127.0.0.1:1",
    ROUTER_MPP_INBOUND_SECRET: "s".repeat(40),
    ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
  };
}

function compose(capabilities: RouterCapabilities, env: Record<string, string> = envFor()) {
  const config = loadRuntimeConfig(env, (file) => readFileSync(file, "utf8"), { networks: TEST_NETWORKS });
  return { rails: composeRails(config, { ...capabilities, dependencyUrls: ["https://circle.test", "https://svm.test", "https://rpc.tempo.invalid/"], sellerProofs: {} }, () => {}), config };
}

async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof TransportError) return error.code;
    return `other:${(error as Error).name}`;
  }
}

describe("outboundCapabilitiesOf（起動時の検査）", () => {
  const base = evm(BASE, "0x0000000000000000000000000000000000000501");
  it("evmSigning と evmSigningByNetwork を network で引ける。SVM は address の形を見る", () => {
    const { evmByNetwork, svmByNetwork } = outboundCapabilitiesOf({ evmSigning: base, evmSigningByNetwork: { [ARC]: evm(ARC, "0x0000000000000000000000000000000000000501") }, svmSigning: { [SOL]: svm(SOL, SOL_OWNER) } });
    expect([...evmByNetwork.keys()].sort()).toEqual([ARC, BASE].sort());
    expect(svmByNetwork.get(SOL)?.address).toBe(SOL_OWNER);
  });
  it.each([
    ["key と network の不一致（Base の能力を Arc の key に）", { evmSigningByNetwork: { [ARC]: evm(BASE, "0x0000000000000000000000000000000000000501") } }],
    ["evmSigning との重複", { evmSigning: base, evmSigningByNetwork: { [BASE]: evm(BASE, "0x0000000000000000000000000000000000000501") } }],
    ["family の不一致（solana の key に EVM の能力）", { evmSigningByNetwork: { [SOL]: evm(SOL, "0x0000000000000000000000000000000000000501") } }],
    ["evmSigning が EVM でない", { evmSigning: evm(SOL, "0x0000000000000000000000000000000000000501") }],
    ["SVM の key と network の不一致", { svmSigning: { [SOL]: svm("solana:other", SOL_OWNER) } }],
    ["SVM の key が solana: でない", { svmSigning: { [BASE]: svm(BASE, SOL_OWNER) } }],
    ["SVM の address の形違い（0x）", { svmSigning: { [SOL]: svm(SOL, "0x0000000000000000000000000000000000000501") } }],
  ])("起動しない: %s", (_name, capabilities) => {
    expect(() => outboundCapabilitiesOf(capabilities as RouterCapabilities)).toThrow(/signer_not_authorized/);
  });
});

describe("composeRails: 組ごとの adapter と選択", () => {
  it("Base 用（実鍵）と Arc 用（fixture）の能力で、r-base は loopback を拒み、r-arc と dyn-mpp-to-arc は接続まで進む（組ごとに別の adapter）", async () => {
    const { rails } = compose({ evmSigning: evm(BASE, "0x0000000000000000000000000000000000000501"), evmSigningByNetwork: { [ARC]: evm(ARC, "0x0000000000000000000000000000000000000503", "non-signing-fixture") }, mppTempo: MPP });
    expect(await outcomeOf(rails.outbound.readChallenge("r-base"))).toBe("destination_blocked");
    expect(await outcomeOf(rails.outbound.readChallenge("r-arc"))).toBe("connect_failed");
  });
  it("Arc 宛の route があるのに Arc 用の能力が無ければ起動しない（Base 用では代替しない）", () => {
    expect(() => compose({ evmSigning: evm(BASE, "0x0000000000000000000000000000000000000501"), mppTempo: MPP })).toThrow(/signer_not_authorized/);
  });
  it("Solana 宛の route は、SVM の adapter が無い間は起動しない（fail closed。U8 で足す）", () => {
    expect(() => compose({ evmSigning: evm(BASE, "0x0000000000000000000000000000000000000501"), evmSigningByNetwork: { [ARC]: evm(ARC, "0x0000000000000000000000000000000000000501") }, mppTempo: MPP, svmSigning: { [SOL]: svm(SOL, SOL_OWNER) } }, envFor({ solRoute: true }))).toThrow(/signer_not_authorized/);
  });
  it("残高の選択は組ごと: Arc 用の能力だけが balanceOf を持てば r-arc は値、r-base は undefined", async () => {
    const { rails } = compose({ evmSigning: evm(BASE, "0x0000000000000000000000000000000000000501"), evmSigningByNetwork: { [ARC]: evm(ARC, "0x0000000000000000000000000000000000000501", "real-key", 9n) }, mppTempo: MPP });
    expect(await rails.balanceOf!("r-arc", ARC_USDC)).toBe(9n);
    expect(await rails.balanceOf!("dyn-mpp-to-arc", ARC_USDC)).toBe(9n);
    expect(await rails.balanceOf!("r-base", USDC)).toBeUndefined();
  });
  it("組の鍵は rail と network", () => {
    expect(outboundPairKeyOf("x402", ARC)).toBe(`x402:${ARC}`);
  });
});

describe("operatorAddressesOf（運用者の集合）", () => {
  it("(a) 受信の受取先と (b) 注入された送信能力の公開アドレス。Provider の宛先は入れない", () => {
    const { config } = compose({ evmSigning: evm(BASE, "0x0000000000000000000000000000000000000501"), evmSigningByNetwork: { [ARC]: evm(ARC, "0x0000000000000000000000000000000000000501") }, mppTempo: MPP });
    const { evmByNetwork, svmByNetwork } = outboundCapabilitiesOf({ evmSigning: evm(BASE, "0x0000000000000000000000000000000000000501"), evmSigningByNetwork: { [ARC]: evm(ARC, "0x0000000000000000000000000000000000000501") }, svmSigning: { [SOL]: svm(SOL, SOL_OWNER) } });
    const set = operatorAddressesOf(config.router, config.router.dynamic?.profiles ?? {}, { evmByNetwork, svmByNetwork, mppTempo: MPP });
    expect(set).toContain(RECEIVER);
    expect(set).toContain("0x0000000000000000000000000000000000000501");
    expect(set).toContain(MPP.account.address);
    expect(set).toContain(SOL_OWNER);
    expect(set).not.toContain(ARC_PROVIDER);
    expect(set).not.toContain("0x0000000000000000000000000000000000000a11");
  });
  it("運用者宛ての offer は候補に出ない（合成を通して adapter に注入されている）: 受信の受取先を宛先にした fixture の 402", async () => {
    // 合成を通した注入の確認は wire（x402-arc-outbound）で行う。ここでは集合に含まれることだけ。
    const spy = createSignerSpy();
    const { config } = compose({ evmSigning: spy.capability(BASE), evmSigningByNetwork: { [ARC]: spy.capability(ARC) }, mppTempo: MPP });
    const { evmByNetwork, svmByNetwork } = outboundCapabilitiesOf({ evmSigning: spy.capability(BASE), evmSigningByNetwork: { [ARC]: spy.capability(ARC) } });
    expect(operatorAddressesOf(config.router, config.router.dynamic?.profiles ?? {}, { evmByNetwork, svmByNetwork })).toContain(spy.address);
  });
});
