/**
 * 合成（`src/main.ts`）: network ごとの facilitator と adapter の選択、売り手証明の能力の束縛、拒否ホスト、起動時の検査の呼び出しと回数
 * （multirail 設計 §2・§3・§5.1。FR-1・FR-14・FR-15、SR-2。タスク T7-b）。**無課金・Linux で受け入れ**。
 * fixture は loopback（TLS、プロセス内）、transport は本番の方針（loopback 不可・名前解決の fixture・`dialForTest`）。
 */
import { mkdtemp } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { address, generateKeyPairSigner } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { generatePrivateKey } from "viem/accounts";

import { ConfigError, loadRuntimeConfig, routeBindingOf, type RuntimeConfig } from "../../src/config.js";
import { DynamicChallengeError } from "../../src/adapters/outbound/x402-dynamic.js";
import { composeRails, type DynamicTransportHooks, type RouterCapabilities } from "../../src/main.js";
import type { SellerProofCapability } from "../../src/ports/inbound.js";
import { startCircleFacilitator, type CircleFacilitator } from "../fixtures/circle-facilitator.js";
import { dialTo, FIXTURE_PUBLIC_ADDRESS, UnmappedFixtureHostError } from "../fixtures/dynamic/dial.js";
import { startVerifyingFacilitator, type VerifyingFacilitator } from "../fixtures/dynamic/verifying-facilitator.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";
import { createTestSellerProof } from "../fixtures/seller-proof-capability.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";
import { startSvmFacilitator, type SvmFacilitator } from "../fixtures/svm-facilitator.js";
import { createSvmTestPayer } from "../fixtures/svm-payer.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";
import { createRealEvmCapability } from "../../tools/real-evm-capability.js";
import { createX402Payer } from "../../tools/x402-payer.js";

const ARC = "eip155:5042002";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const BASE = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const HOSTS = { circle: "facilitator.provider.test", svm: "static.provider.test", rpc: "rpc.provider.test", legacy: "facilitator.other.test", upstream: "provider.test" };
const BASE_RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";

let TLS: TlsMaterial;
let owner: string;
let ata: string;
let proof: ReturnType<typeof createTestSellerProof>;
beforeAll(async () => {
  TLS = generateTestTls();
  const keypair = await generateKeyPairSigner();
  owner = String(keypair.address);
  ata = String((await findAssociatedTokenPda({ mint: address(MINT), owner: keypair.address, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
  proof = createTestSellerProof({ network: ARC });
});
afterAll(() => TLS.cleanup());

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

interface Fixtures { circle: CircleFacilitator; svm: SvmFacilitator; rpc: SolanaRpcFixture; legacy: VerifyingFacilitator; ports: Map<string, number>; dialed: string[] }

async function fixtures(): Promise<Fixtures> {
  const circle = await startCircleFacilitator(TLS, HOSTS.circle);
  closers.push(circle.close);
  const svm = await startSvmFacilitator(TLS, SOL, undefined, HOSTS.svm);
  closers.push(svm.close);
  const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, tls: TLS, ata: { address: ata, owner } });
  closers.push(rpc.close);
  const legacy = await startVerifyingFacilitator({ tls: TLS });
  closers.push(legacy.close);
  return { circle, svm, rpc, legacy, ports: new Map([[HOSTS.circle, circle.port], [HOSTS.svm, svm.port], [HOSTS.rpc, rpc.port], [HOSTS.legacy, legacy.port]]), dialed: [] };
}

function hooksOf(fx: Fixtures): DynamicTransportHooks {
  return {
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: (_hostname, _options, callback) => callback(null, [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }]),
    dialForTest: (target) => {
      fx.dialed.push(target.hostname);
      const port = fx.ports.get(target.hostname);
      if (port === undefined) throw new UnmappedFixtureHostError();
      return { host: "127.0.0.1", port };
    },
  };
}

function route(routeId: string, network: string, asset: string, payTo: string): Record<string, unknown> {
  return { routeId, canonicalPath: `/v1/routes/${routeId}/resource`, rail: "x402", sourceRail: "x402", source: { amount: "10000", asset, decimals: 6, network, payTo }, destination: { scheme: "exact", network: BASE, asset: USDC, payTo: "0x0000000000000000000000000000000000000a11" } };
}
function profile(profileId: string, network: string, asset: string, payTo: string): Record<string, unknown> {
  return { profileId, sourceRail: "x402", source: { network, asset, decimals: 6, payTo }, rail: "x402", destination: { scheme: "exact", network: BASE, asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } }, par: true, maxUpstreamAmount: "100000", fee: { flat: "1000", bps: 0, min: "1000" } };
}

async function configOf(options: { arcPayTo?: string; solPayTo?: string; withLegacy?: boolean; solanaRpc?: string | null } = {}): Promise<{ config: RuntimeConfig; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "multirail-compose-"));
  const arcPayTo = options.arcPayTo ?? proof.address;
  const solPayTo = options.solPayTo ?? owner;
  const routes = [route("arc", ARC, ARC_USDC, arcPayTo), route("sol", SOL, MINT, solPayTo), ...(options.withLegacy === false ? [] : [route("base", BASE, USDC, BASE_RECEIVER)])];
  const document = {
    router: {
      approvalTtlMs: 60_000,
      routes: Object.fromEntries(routes.map((r) => [r["routeId"] as string, r])),
      budget: { maxPurchases: 10, buckets: [{ network: ARC, asset: ARC_USDC, maxTotal: "100000", maxPerPurchase: "10000" }, { network: SOL, asset: MINT, maxTotal: "100000", maxPerPurchase: "10000" }, { network: BASE, asset: USDC, maxTotal: "100000", maxPerPurchase: "10000" }] },
      dynamic: {
        enabled: true,
        profiles: { "dyn-arc-to-x402": profile("dyn-arc-to-x402", ARC, ARC_USDC, arcPayTo), "dyn-sol-to-x402": profile("dyn-sol-to-x402", SOL, MINT, solPayTo) },
        budget: { maxPurchases: 10, buckets: [{ network: ARC, asset: ARC_USDC, maxTotal: "100000", maxPerPurchase: "20000" }, { network: SOL, asset: MINT, maxTotal: "100000", maxPerPurchase: "20000" }, { network: BASE, asset: USDC, maxTotal: "100000", maxPerPurchase: "20000" }] },
        denyHosts: [],
      },
    },
    x402: {
      upstreams: Object.fromEntries(routes.map((r) => [r["routeId"] as string, `https://${HOSTS.upstream}/v1/x`])),
      inboundFacilitators: { [ARC]: { kind: "circle", url: `https://${HOSTS.circle}` }, [SOL]: { kind: "x402", url: `https://${HOSTS.svm}` } },
    },
  };
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  const config = loadRuntimeConfig(
    {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha.other.test",
      ROUTER_X402_INBOUND_FACILITATOR_URL: `https://${HOSTS.legacy}`,
      ...(options.solanaRpc === null ? {} : { ROUTER_SOLANA_RPC_URL: options.solanaRpc ?? `https://${HOSTS.rpc}` }),
      ROUTER_CANONICAL_BASE_URL: "https://router.test",
      ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
    },
    (file) => readFileSync(file, "utf8"),
    { networks: TEST_NETWORKS },
  );
  return { config, dir };
}

function capabilitiesOf(fx: Fixtures, sellerProofs: Readonly<Record<string, SellerProofCapability>> | null = { [ARC]: proof.capability }): RouterCapabilities {
  return {
    // 実鍵（乱数）の能力: fixture の能力は上流を loopback に限るので、TLS の fixture の網では実鍵の形を使う（署名はしない試験）。
    evmSigning: createRealEvmCapability(generatePrivateKey()).capability(BASE),
    knownNetworksForTest: TEST_NETWORKS,
    ...(sellerProofs === null ? {} : { sellerProofs }),
    transportHooksForTest: hooksOf(fx),
    dynamicTransportHooksForTest: hooksOf(fx),
  };
}

async function svmCredential(offer: Awaited<ReturnType<ReturnType<typeof composeRails>["inbound"]["createOffer"]>>, payTo = owner) {
  const payer = await createSvmTestPayer(MINT);
  const [dest] = await findAssociatedTokenPda({ mint: address(MINT), owner: address(payTo), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const policy = { feePayer: String(offer.extra["feePayer"]), payTo, destinationAta: String(dest), mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS };
  return { x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra.challengeNonce, transaction: await payer.build(policy, offer.amount, offer.extra["memo"] as string) } };
}

describe("合成: facilitator と adapter の選択（network ごと）", () => {
  it("Arc は Circle の fixture だけ、Solana は SVM の fixture だけ、Base Sepolia は env の facilitator だけに verify が届く。起動時に /supported 1 回・RPC 1 回", async () => {
    const fx = await fixtures();
    const { config } = await configOf();
    const rails = composeRails(config, capabilitiesOf(fx), () => {}, () => {});
    expect(rails.startup).toBeDefined();
    // 起動時の検査の前は SVM の offer を出さない（fail closed）。
    await expect(rails.inbound.createOffer({ routeId: "sol", amount: "10000", asset: MINT, network: SOL, routeBinding: routeBindingOf(config.router.routes["sol"]!), nowMs: Date.now() })).rejects.toThrow(/startup checks have not run/);
    await rails.startup!();
    expect(fx.svm.seen.supportedCalls).toBe(1);
    expect(fx.rpc.calls.map((c) => c.method)).toEqual(["getAccountInfo"]);

    // Arc の route。
    const arcRoute = config.router.routes["arc"]!;
    const arcOffer = await rails.inbound.createOffer({ routeId: "arc", amount: "10000", asset: ARC_USDC, network: ARC, routeBinding: routeBindingOf(arcRoute), nowMs: Date.now() });
    expect(arcOffer.extra["assetTransferMethod"]).toBe("eip3009");
    expect(arcOffer.payTo).toBe(proof.address);
    const arcCredential = JSON.parse(Buffer.from(await createX402Payer(generatePrivateKey()).credentialFor(arcOffer as never, 5042002), "base64").toString("utf8"));
    expect(rails.inbound.preflight(arcOffer, arcCredential, Date.now())).toEqual({ ok: true });
    expect(await rails.inbound.verify(arcOffer, arcCredential, { routeId: "arc" })).toEqual({ isValid: true });
    expect(fx.circle.seen.verifyCalls).toBe(1);
    expect(fx.circle.seen.proofFailures).toEqual([]);
    expect(fx.svm.seen.verifyCalls).toBe(0);
    expect(fx.legacy.calls.verify).toBe(0);

    // Solana の route。
    const solRoute = config.router.routes["sol"]!;
    const solOffer = await rails.inbound.createOffer({ routeId: "sol", amount: "10000", asset: MINT, network: SOL, routeBinding: routeBindingOf(solRoute), nowMs: Date.now() });
    expect(solOffer.payTo).toBe(owner);
    expect(solOffer.extra["feePayer"]).toBe(fx.svm.feePayer);
    const solCredential = await svmCredential(solOffer);
    expect(rails.inbound.preflight(solOffer, solCredential, Date.now())).toEqual({ ok: true });
    expect(await rails.inbound.verify(solOffer, solCredential, { routeId: "sol" })).toEqual({ isValid: true });
    expect(fx.svm.seen.verifyCalls).toBe(1);
    expect(fx.circle.seen.verifyCalls).toBe(1);

    // 動的プロファイルも同じ選択（offer の束縛からプロファイルを引く）。
    const dyn = await rails.inbound.createOffer({ routeId: "dyn-sol-to-x402", amount: "11000", asset: MINT, network: SOL, routeBinding: "dynamic|dyn-sol-to-x402|GET|https%3A%2F%2Fprovider.test%2Fv1%2Fx", nowMs: Date.now() });
    expect(dyn.payTo).toBe(owner);
    await rails.inbound.verify(dyn, await svmCredential(dyn), { routeId: "dyn-sol-to-x402" });
    expect(fx.svm.seen.verifyCalls).toBe(2);
    // quote・purchase 中に /supported・RPC へは出ない。
    expect(fx.svm.seen.supportedCalls).toBe(1);
    expect(fx.rpc.calls).toHaveLength(1);
    // 宛先はすべて表の中（名前解決の fixture 以外へ出ていない）。
    expect(new Set(fx.dialed).size).toBeLessThanOrEqual(4);
  });
});

describe("合成: 売り手証明の能力の束縛（route とプロファイルの両方）", () => {
  it("能力が無い・network が違う・address が payTo と違う → 起動しない", async () => {
    const fx = await fixtures();
    const { config } = await configOf();
    expect(() => composeRails(config, capabilitiesOf(fx, null), () => {}, () => {})).toThrow(ConfigError);
    expect(() => composeRails(config, capabilitiesOf(fx, null), () => {}, () => {})).toThrow(/seller proof capability is required/);
    const otherNetwork: SellerProofCapability = { ...proof.capability, network: BASE, proofFor: proof.capability.proofFor };
    expect(() => composeRails(config, capabilitiesOf(fx, { [ARC]: otherNetwork }), () => {}, () => {})).toThrow(/different network or address/);
    const otherKey = createTestSellerProof({ network: ARC });
    expect(() => composeRails(config, capabilitiesOf(fx, { [ARC]: otherKey.capability }), () => {}, () => {})).toThrow(/different network or address/);
    // プロファイルだけが違う payTo を持つ場合も落ちる。
    const mixed = await configOf({ arcPayTo: proof.address });
    const profileOnly = { ...mixed.config, router: { ...mixed.config.router, dynamic: { ...mixed.config.router.dynamic!, profiles: { ...mixed.config.router.dynamic!.profiles, "dyn-arc-to-x402": { ...mixed.config.router.dynamic!.profiles["dyn-arc-to-x402"]!, source: { ...mixed.config.router.dynamic!.profiles["dyn-arc-to-x402"]!.source, payTo: otherKey.address } } } } } };
    expect(() => composeRails(profileOnly as RuntimeConfig, capabilitiesOf(fx), () => {}, () => {})).toThrow(/dynamic.profiles.dyn-arc-to-x402: the seller proof capability is bound to a different network or address/);
  });
});

describe("合成: 起動時の検査の失敗で起動しない", () => {
  it("/supported に該当が無い → startup が ConfigError。Solana の RPC が読めない → ConfigError", async () => {
    const fx = await fixtures();
    fx.svm.state.kinds = [];
    const { config } = await configOf();
    const rails = composeRails(config, capabilitiesOf(fx), () => {}, () => {});
    await expect(rails.startup!()).rejects.toThrow(/no exact kind/);
    const fx2 = await fixtures();
    fx2.rpc.state.reply = "error";
    const second = await configOf();
    const rails2 = composeRails(second.config, capabilitiesOf(fx2), () => {}, () => {});
    await expect(rails2.startup!()).rejects.toThrow(ConfigError);
  });

  it("ROUTER_SOLANA_RPC_URL が無ければ公開 devnet の RPC が既定（名前解決の fixture の表に無いので接続しない）", async () => {
    const fx = await fixtures();
    const { config } = await configOf({ solanaRpc: null });
    expect(config.real?.solanaRpcUrl).toBeUndefined();
    const rails = composeRails(config, capabilitiesOf(fx), () => {}, () => {});
    await expect(rails.startup!()).rejects.toThrow(/RPC could not be read/);
    expect(fx.dialed).toContain("api.devnet.solana.com");
    expect(fx.rpc.calls).toHaveLength(0);
  });
});

describe("合成: 拒否ホスト", () => {
  it("Circle・x402.org・Solana RPC・env の facilitator のホストは動的の上流 URL に使えない（判定で止まり、接続しない）", async () => {
    const fx = await fixtures();
    const { config } = await configOf();
    const rails = composeRails(config, capabilitiesOf(fx), () => {}, () => {});
    await rails.startup!();
    const dialedBefore = fx.dialed.length;
    for (const host of [HOSTS.circle, HOSTS.svm, HOSTS.rpc, HOSTS.legacy, `sub.${HOSTS.rpc}`]) {
      let caught: unknown;
      try {
        await rails.outbound.readChallenge!("dyn-arc-to-x402", { url: `https://${host}/v1/x` });
      } catch (error) {
        caught = error;
      }
      expect(caught, host).toBeInstanceOf(DynamicChallengeError);
      expect((caught as DynamicChallengeError).reason, host).toBe("url");
    }
    expect(fx.dialed.length).toBe(dialedBefore);
  });
});
