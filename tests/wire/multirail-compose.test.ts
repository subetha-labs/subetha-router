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

import { ConfigError, loadRuntimeConfig, routeBindingOf, type KnownNetwork, type RuntimeConfig } from "../../src/config.js";
import { DynamicChallengeError } from "../../src/adapters/outbound/x402-dynamic.js";
import { composeRails, startRouter, type DynamicTransportHooks, type RouterCapabilities } from "../../src/main.js";
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

interface Fixtures { circle: CircleFacilitator; svm: SvmFacilitator; rpc: SolanaRpcFixture; legacy: VerifyingFacilitator; ports: Map<string, number>; dialed: string[]; stuck: Set<string>; resolve: Map<string, string> }

async function fixtures(): Promise<Fixtures> {
  const circle = await startCircleFacilitator(TLS, HOSTS.circle);
  closers.push(circle.close);
  const svm = await startSvmFacilitator(TLS, SOL, undefined, HOSTS.svm);
  closers.push(svm.close);
  const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, tls: TLS, ata: { address: ata, owner } });
  closers.push(rpc.close);
  const legacy = await startVerifyingFacilitator({ tls: TLS });
  closers.push(legacy.close);
  return { circle, svm, rpc, legacy, ports: new Map([[HOSTS.circle, circle.port], [HOSTS.svm, svm.port], [HOSTS.rpc, rpc.port], [HOSTS.legacy, legacy.port]]), dialed: [], stuck: new Set(), resolve: new Map() };
}

function hooksOf(fx: Fixtures): DynamicTransportHooks {
  return {
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: (hostname, _options, callback) => {
      if (fx.stuck.has(hostname)) return; // 名前解決が永遠に答えない
      callback(null, [{ address: fx.resolve.get(hostname) ?? FIXTURE_PUBLIC_ADDRESS, family: 4 }]);
    },
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

async function configOf(options: { arcPayTo?: string; solPayTo?: string; withLegacy?: boolean; withArcRoute?: boolean; solanaRpc?: string | null; offerSeconds?: number; networks?: readonly KnownNetwork[] } = {}): Promise<{ config: RuntimeConfig; dir: string; env: Record<string, string> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "multirail-compose-"));
  const arcPayTo = options.arcPayTo ?? proof.address;
  const solPayTo = options.solPayTo ?? owner;
  const routes = [...(options.withArcRoute === false ? [] : [route("arc", ARC, ARC_USDC, arcPayTo)]), route("sol", SOL, MINT, solPayTo), ...(options.withLegacy === false ? [] : [route("base", BASE, USDC, BASE_RECEIVER)])];
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
  const env: Record<string, string> = {
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_PRINCIPAL_TOKENS: "judge:public",
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: "https://subetha.other.test",
    ROUTER_X402_INBOUND_FACILITATOR_URL: `https://${HOSTS.legacy}`,
    ...(options.solanaRpc === null ? {} : { ROUTER_SOLANA_RPC_URL: options.solanaRpc ?? `https://${HOSTS.rpc}` }),
    ...(options.offerSeconds === undefined ? {} : { ROUTER_X402_INBOUND_OFFER_SECONDS: String(options.offerSeconds) }),
    ROUTER_CANONICAL_BASE_URL: "https://router.test",
    ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
    ROUTER_HTTP_PORT: "0",
  };
  const config = loadRuntimeConfig(env, (file) => readFileSync(file, "utf8"), { networks: options.networks ?? TEST_NETWORKS });
  return { config, dir, env };
}

function capabilitiesOf(fx: Fixtures, sellerProofs: Readonly<Record<string, SellerProofCapability>> | null = { [ARC]: proof.capability }, networks: readonly KnownNetwork[] = TEST_NETWORKS): RouterCapabilities {
  return {
    // 実鍵（乱数）の能力: fixture の能力は上流を loopback に限るので、TLS の fixture の網では実鍵の形を使う（署名はしない試験）。
    evmSigning: createRealEvmCapability(generatePrivateKey()).capability(BASE),
    knownNetworksForTest: networks,
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
    // preflight も同じ（起動時の検査が埋まる前は policy が無い）。
    const prematureOffer = { scheme: "exact", network: SOL, asset: MINT, amount: "10000", payTo: owner, maxTimeoutSeconds: 40, extra: { challengeNonce: "0x" + "ab".repeat(32), expiresAt: Math.floor(Date.now() / 1000) + 60, routeBinding: routeBindingOf(config.router.routes["sol"]!), feePayer: "x", memo: "0x" + "ab".repeat(32), fundsMoveOnCredential: false } };
    expect(() => rails.inbound.preflight(prematureOffer, { x402Version: 2, accepted: prematureOffer, payload: { challengeNonce: prematureOffer.extra.challengeNonce } }, Date.now())).toThrow(/startup checks have not run/);
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

    // Base Sepolia の route は env の facilitator（legacy）だけ。
    const baseRoute = config.router.routes["base"]!;
    const baseOffer = await rails.inbound.createOffer({ routeId: "base", amount: "10000", asset: USDC, network: BASE, routeBinding: routeBindingOf(baseRoute), nowMs: Date.now() });
    expect(baseOffer.extra["assetTransferMethod"]).toBeUndefined();
    const baseCredential = JSON.parse(Buffer.from(await createX402Payer(generatePrivateKey()).credentialFor(baseOffer as never, 84532), "base64").toString("utf8"));
    expect(await rails.inbound.verify(baseOffer, baseCredential, { routeId: "base" })).toEqual({ isValid: true });
    expect(fx.legacy.calls.verify).toBe(1);
    expect(fx.circle.seen.verifyCalls).toBe(1);
    expect(fx.svm.seen.verifyCalls).toBe(0);

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

    // 動的プロファイルも同じ選択（offer の束縛からプロファイルを引く）: Solana と Arc の両方。
    const dyn = await rails.inbound.createOffer({ routeId: "dyn-sol-to-x402", amount: "11000", asset: MINT, network: SOL, routeBinding: "dynamic|dyn-sol-to-x402|GET|https%3A%2F%2Fprovider.test%2Fv1%2Fx", nowMs: Date.now() });
    expect(dyn.payTo).toBe(owner);
    expect(await rails.inbound.verify(dyn, await svmCredential(dyn), { routeId: "dyn-sol-to-x402" })).toEqual({ isValid: true });
    expect(fx.svm.seen.verifyCalls).toBe(2);
    const dynArc = await rails.inbound.createOffer({ routeId: "dyn-arc-to-x402", amount: "11000", asset: ARC_USDC, network: ARC, routeBinding: "dynamic|dyn-arc-to-x402|GET|https%3A%2F%2Fprovider.test%2Fv1%2Fx", nowMs: Date.now() });
    const dynArcCredential = JSON.parse(Buffer.from(await createX402Payer(generatePrivateKey()).credentialFor(dynArc as never, 5042002), "base64").toString("utf8"));
    expect(rails.inbound.preflight(dynArc, dynArcCredential, Date.now())).toEqual({ ok: true });
    // プロファイルの Circle 受信は署名を quote に束縛する（nonce を別の値にした authorization は落ちる）。
    const rebound = { ...dynArcCredential, payload: { ...dynArcCredential.payload, authorization: { ...dynArcCredential.payload.authorization, nonce: `0x${"ee".repeat(32)}` } } };
    expect(rails.inbound.preflight(dynArc, rebound, Date.now())).toEqual({ ok: false, reason: "nonce_mismatch" });
    expect(await rails.inbound.verify(dynArc, dynArcCredential, { routeId: "dyn-arc-to-x402" })).toEqual({ isValid: true });
    expect(fx.circle.seen.verifyCalls).toBe(2);
    expect(fx.legacy.calls.verify).toBe(1);
    // quote・purchase 中に /supported・RPC へは出ない。
    expect(fx.svm.seen.supportedCalls).toBe(1);
    expect(fx.rpc.calls).toHaveLength(1);
    // 宛先は表の中の 4 つだけ（名前解決の fixture 以外へ出ていない）。
    expect([...new Set(fx.dialed)].sort()).toEqual([HOSTS.circle, HOSTS.legacy, HOSTS.rpc, HOSTS.svm].sort());
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
    // Arc の静的 route が無く、プロファイルだけが Circle を使う構成でも、能力の欠落・network の不一致はプロファイルで止まる。
    const profilesOnly = await configOf({ withArcRoute: false });
    expect(() => composeRails(profilesOnly.config, capabilitiesOf(fx, null), () => {}, () => {})).toThrow(/dynamic.profiles.dyn-arc-to-x402: a seller proof capability is required/);
    expect(() => composeRails(profilesOnly.config, capabilitiesOf(fx, { [ARC]: otherNetwork }), () => {}, () => {})).toThrow(/dynamic.profiles.dyn-arc-to-x402: the seller proof capability is bound to a different network/);
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

describe("合成: 起動時の検査の否定（T4-b の各行を合成で）と startRouter の境界", () => {
  const negatives: [string, (fx: Fixtures) => void, RegExp][] = [
    ["feePayer が 2 つ", (fx) => { fx.svm.state.kinds = [...fx.svm.state.kinds, { x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: "11111111111111111111111111111112" } }]; }, /more than one feePayer/],
    ["feePayer の形違い", (fx) => { fx.svm.state.kinds = [{ x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: "abc" } }]; }, /well-formed feePayer/],
    ["feePayer = payTo（隔離）", (fx) => { fx.svm.state.kinds = [{ x402Version: 2, scheme: "exact", network: SOL, extra: { feePayer: owner } }]; }, /collides with a fixed account/],
    ["ATA の owner が違う", (fx) => { fx.rpc.state.reply = "ok"; (fx.rpc as unknown as { accountsOverride?: unknown }).accountsOverride = undefined; }, /./],
    ["/supported が 64 KiB 超", (fx) => { fx.svm.state.supportedReply = "huge"; }, /did not return a JSON object/],
    ["RPC が redirect", (fx) => { fx.rpc.state.reply = "redirect"; }, /RPC could not be read/],
    ["/supported の名前解決が止まる", (fx) => { fx.stuck.add(HOSTS.svm); }, /could not be read/],
  ];
  for (const [name, arrange, pattern] of negatives) {
    it(`${name} → startup が ConfigError（core は作られない）`, async () => {
      const fx = await fixtures();
      if (name === "ATA の owner が違う") {
        // owner の違う ATA: RPC fixture を別の owner で立て直す。
        await fx.rpc.close();
        const other = String((await generateKeyPairSigner()).address);
        const rpc = await startSolanaRpc({ mint: MINT, decimals: 6, tls: TLS, ata: { address: ata, owner: other } });
        closers.push(rpc.close);
        fx.ports.set(HOSTS.rpc, rpc.port);
      } else {
        arrange(fx);
      }
      const { config } = await configOf();
      const rails = composeRails(config, capabilitiesOf(fx), () => {}, () => {});
      const started = Date.now();
      await expect(rails.startup!()).rejects.toThrow(name === "ATA の owner が違う" ? /not owned by the configured payTo/ : pattern);
      expect(Date.now() - started).toBeLessThan(8_000);
      // 起動時の検査が通っていないので、SVM の offer は出せない（preflight も同じ）。
      await expect(rails.inbound.createOffer({ routeId: "sol", amount: "10000", asset: MINT, network: SOL, routeBinding: routeBindingOf(config.router.routes["sol"]!), nowMs: Date.now() })).rejects.toThrow(/startup checks have not run/);
    }, 20_000);
  }

  it("startRouter は起動時の検査が失敗すると listen せずに落ちる（journal も server も作らない）", async () => {
    const fx = await fixtures();
    fx.svm.state.kinds = [];
    const { env } = await configOf();
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    const written: string[] = [];
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await expect(startRouter(capabilitiesOf(fx))).rejects.toThrow(/no exact kind/);
    } finally {
      process.stdout.write = originalWrite;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(written.join("")).not.toContain("listening");
    expect(fx.svm.seen.supportedCalls).toBe(1);
  });

  it("Circle の静的 rail: 表の domain・有効期間（env）と wire の分離・診断の転送・名前解決の期限", async () => {
    const fx = await fixtures();
    // 表の Arc の domain を「USD Coin/2」に変えると、要求の extra.name もそれになる（adapter の既定 USDC/2 ではない）。
    const networks: KnownNetwork[] = TEST_NETWORKS.map((n) => (n.network === ARC ? { ...n, assets: n.assets.map((a) => ({ ...a, domain: { name: "USD Coin", version: "2" } })) } : n));
    const { config } = await configOf({ offerSeconds: 600, networks });
    const notes: string[] = [];
    const rails = composeRails(config, capabilitiesOf(fx, { [ARC]: proof.capability }, networks), () => {}, (m) => notes.push(m));
    await rails.startup!();
    const now = Date.now();
    const offer = await rails.inbound.createOffer({ routeId: "arc", amount: "10000", asset: ARC_USDC, network: ARC, routeBinding: routeBindingOf(config.router.routes["arc"]!), nowMs: now });
    expect(offer.maxTimeoutSeconds).toBe(30);
    expect(offer.extra.expiresAt).toBe(Math.floor(now / 1000) + 600);
    expect(offer.extra["name"]).toBe("USD Coin");
    const credential = JSON.parse(Buffer.from(await createX402Payer(generatePrivateKey()).credentialFor(offer as never, 5042002), "base64").toString("utf8"));
    fx.circle.state.settle = "registration-required";
    expect(await rails.inbound.settle(offer, credential, { routeId: "arc" })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(notes).toEqual(["router: facilitator diagnostic facilitator_trial_exhausted (routes.arc)"]);
    expect((fx.circle.seen.lastRequirements as { extra: { name: string } }).extra.name).toBe("USD Coin");
    // 名前解決が止まれば、HTTP の期限（10 秒）を待たずに DNS の期限で失敗する。
    fx.stuck.add(HOSTS.circle);
    const started = Date.now();
    await expect(rails.inbound.verify(offer, credential, { routeId: "arc" })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 30_000);
});

describe("合成: settle の後の追跡（設計 §5.8）は起動時の検査と同じ transport で設定の RPC へ", () => {
  it("confirm の timeout の後、RPC の名前解決が止まっていれば追跡は期限で終わり unknown（接続せず、HTTP の期限を待たない）", async () => {
    const fx = await fixtures();
    const { config } = await configOf();
    const notes: string[] = [];
    const rails = composeRails(config, capabilitiesOf(fx), () => {}, (m) => notes.push(m));
    await rails.startup!();
    const solRoute = config.router.routes["sol"]!;
    const offer = await rails.inbound.createOffer({ routeId: "sol", amount: "10000", asset: MINT, network: SOL, routeBinding: routeBindingOf(solRoute), nowMs: Date.now() });
    const credential = await svmCredential(offer);
    expect(await rails.inbound.verify(offer, credential, { routeId: "sol" })).toEqual({ isValid: true });
    fx.svm.state.confirm = "timeout";
    fx.rpc.state.signatureStatuses = ["confirmed"];
    fx.stuck.add(HOSTS.rpc);
    const rpcDials = fx.dialed.filter((h) => h === HOSTS.rpc).length;
    const started = Date.now();
    expect(await rails.inbound.settle(offer, credential, { routeId: "sol" })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    // 完了の期限 15 秒（既定）の内側で終わる。RPC には接続していない（名前解決で止まる）。
    expect(Date.now() - started).toBeLessThan(17_000);
    expect(fx.dialed.filter((h) => h === HOSTS.rpc)).toHaveLength(rpcDials);
    expect(fx.rpc.calls.filter((c) => c.method === "getSignatureStatuses")).toHaveLength(0);
    expect(notes.filter((n) => n.includes("svm_settle_followed_up"))).toEqual([]);
    // 名前解決が戻れば、同じ構成の次の settle は追跡で settled（診断は route の名で出る）。
    fx.stuck.delete(HOSTS.rpc);
    const offer2 = await rails.inbound.createOffer({ routeId: "sol", amount: "10000", asset: MINT, network: SOL, routeBinding: routeBindingOf(solRoute), nowMs: Date.now() });
    const credential2 = await svmCredential(offer2);
    expect(await rails.inbound.verify(offer2, credential2, { routeId: "sol" })).toEqual({ isValid: true });
    const settled = await rails.inbound.settle(offer2, credential2, { routeId: "sol" });
    expect(settled.outcome).toBe("settled");
    expect(notes).toContain("router: facilitator diagnostic svm_settle_followed_up (routes.sol)");
  }, 40_000);

  it("起動の後に RPC の名前が内部アドレスに解決するようになったら、追跡は接続せず（destination_blocked）、期限で unknown", async () => {
    const fx = await fixtures();
    const { config } = await configOf();
    const events: { code: string; operation?: string }[] = [];
    const rails = composeRails(config, capabilitiesOf(fx), (event) => events.push({ code: event.code, operation: event.operation }), () => {});
    await rails.startup!();
    const solRoute = config.router.routes["sol"]!;
    const offer = await rails.inbound.createOffer({ routeId: "sol", amount: "10000", asset: MINT, network: SOL, routeBinding: routeBindingOf(solRoute), nowMs: Date.now() });
    const credential = await svmCredential(offer);
    expect(await rails.inbound.verify(offer, credential, { routeId: "sol" })).toEqual({ isValid: true });
    fx.svm.state.confirm = "timeout";
    fx.rpc.state.signatureStatuses = ["confirmed"];
    fx.resolve.set(HOSTS.rpc, "10.0.0.5");
    const rpcDials = fx.dialed.filter((h) => h === HOSTS.rpc).length;
    expect(await rails.inbound.settle(offer, credential, { routeId: "sol" })).toEqual({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(fx.dialed.filter((h) => h === HOSTS.rpc)).toHaveLength(rpcDials);
    expect(fx.rpc.calls.filter((c) => c.method === "getSignatureStatuses")).toHaveLength(0);
    expect(events.filter((e) => e.code === "destination_blocked" && e.operation === "svm_settle_follow_up").length).toBeGreaterThanOrEqual(1);
  }, 40_000);
});
