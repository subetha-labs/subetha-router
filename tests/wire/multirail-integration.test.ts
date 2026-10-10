/**
 * 多レールの統合・回復（multirail タスク T7-c。要件 AC-3〜AC-7、FR-5・FR-6・FR-19）。**無課金・Linux で受け入れ**。
 *
 * **製品の配線（`composeRails` → `createRouterCore` → `startHttpServer`）をそのまま使う**: 本番と同じ構成（Arc は Circle の facilitator と
 * 売り手証明、Solana は SVM の facilitator と起動時の検査、Base Sepolia は env の facilitator、Tempo は MPP）、実鍵（毎回の乱数）、実 SDK、
 * SSRF 防御 A の transport に、試験の差し替え（名前解決と接続先）だけを足す。相手はすべてプロセス内の TLS の fixture。資金は動かない。
 * 呼び出し側は製品の client と、呼び出し側が実際に使う支払いの形（EIP-3009 の署名、SVM の部分署名、MPP の送金）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { address, generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { createRouterClient } from "../../src/client/index.js";
import type { QuoteView, RouterClient } from "../../src/client/types.js";
import { DEFAULT_DYNAMIC_LIMITS, loadRuntimeConfig, type RuntimeConfig } from "../../src/config.js";
import { createRouterCore, type RouterCore } from "../../src/core/orchestrator.js";
import { startHttpServer, type RunningServer } from "../../src/http/app.js";
import { composeRails, dynamicCoreOptionsOf, type DynamicTransportHooks, type RouterCapabilities } from "../../src/main.js";
import type { TransportEvent } from "../../src/net/guarded-fetch.js";
import { createMppPayer } from "../../tools/mpp-payer.js";
import { createRealEvmCapability } from "../../tools/real-evm-capability.js";
import { createRealMppCapability } from "../../tools/real-mpp-capability.js";
import { createRealSvmCapability } from "../../tools/real-svm-capability.js";
import { createX402Payer } from "../../tools/x402-payer.js";
import { startCircleFacilitator, type CircleFacilitator } from "../fixtures/circle-facilitator.js";
import { FIXTURE_PUBLIC_ADDRESS, UnmappedFixtureHostError } from "../fixtures/dynamic/dial.js";
import { MPP_FIXTURE_CHAIN_ID, MPP_FIXTURE_CURRENCY, MPP_FIXTURE_RECIPIENT, startMppUpstream, type MppUpstream } from "../fixtures/dynamic/mpp-upstream.js";
import { startTempoRpc, type TempoRpc } from "../fixtures/dynamic/tempo-rpc.js";
import { startVerifyingFacilitator, type VerifyingFacilitator } from "../fixtures/dynamic/verifying-facilitator.js";
import { FIXTURE_PAY_TO, paidOk, standardAccept, startX402Upstream, type X402Upstream } from "../fixtures/dynamic/x402-upstream.js";
import { TEST_NETWORKS } from "../fixtures/known-networks.js";
import { createTestSellerProof } from "../fixtures/seller-proof-capability.js";
import { startSolanaRpc, type SolanaRpcFixture } from "../fixtures/solana-rpc.js";
import { startSvmFacilitator, type SvmFacilitator } from "../fixtures/svm-facilitator.js";
import { createSvmTestPayer, type SvmPayerBuildOptions } from "../fixtures/svm-payer.js";
import { startSvmUpstream, type SvmUpstream } from "../fixtures/svm-upstream.js";
import { createMppSolanaTestPayer } from "../fixtures/mpp-solana-payer.js";
import { startMppSolanaUpstream, type MppSolanaUpstream } from "../fixtures/mpp-solana-upstream.js";
import type { InboundOffer } from "../../src/ports/inbound.js";
import { generateTestTls, type TlsMaterial } from "../fixtures/tls/generate.js";

vi.setConfig({ testTimeout: 60_000 });

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");

const ARC = "eip155:5042002";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
/** 表にある別の資産（試験の表の合成の資産。Arc と Base Sepolia の両方にある）。権威の欄を変える試験と、同じ資産 id の別 network の区分の試験用。 */
const SHARED_ASSET = "0x000000000000000000000000000000000000beef";
const BASE = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const SOL = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TEMPO = `eip155:${MPP_FIXTURE_CHAIN_ID}`;
const PATHUSD = MPP_FIXTURE_CURRENCY;
const BASE_RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";

/** TLS の fixture の名前（`provider.test` 系は provider の証明書、`other.test` 系は other の証明書）。 */
const HOSTS = { x402: "provider.test", mpp: "mpp.provider.test", circle: "facilitator.provider.test", svm: "static.provider.test", solRpc: "rpc.provider.test", legacy: "facilitator.other.test", tempoRpc: "rpc.other.test", arcProvider: "arc.provider.test", solProvider: "sol.provider.test" , solMppProvider: "solmpp.provider.test" } as const;
const ARC_PROVIDER = "0xAF42CFfe4B35A05098613d962aF43CDc43fBb4Ea";
const ARC_URL = `https://${HOSTS.arcProvider}/v1/price?symbol=ETH`;
const SOL_URL = `https://${HOSTS.solProvider}/v1/price?symbol=ETH`;
const STATIC_ARC_URL = `https://${HOSTS.arcProvider}/v1/static`;
const STATIC_SOL_URL = `https://${HOSTS.solProvider}/v1/static`;
const X402_URL = `https://${HOSTS.x402}/v1/price?symbol=ETH`;
const MPP_URL = `https://${HOSTS.mpp}/v1/price`;
const STATIC_X402_URL = `https://${HOSTS.x402}/v1/static`;
const STATIC_MPP_URL = `https://${HOSTS.mpp}/v1/static`;
/** MPP Solana の Provider D（pay-kit の server の fixture）。 */
const SOLMPP_URL = `https://${HOSTS.solMppProvider}/v1/price?symbol=ETH`;
const STATIC_SOLMPP_URL = `https://${HOSTS.solMppProvider}/v1/static`;

const ROUTES = { arcX402: "arc-x402", arcMpp: "arc-mpp", solX402: "sol-x402", solMpp: "sol-mpp", base: "base", baseArc: "base-arc", tempoSol: "tempo-sol" , solmppX402: "solmpp-x402", solmppMpp: "solmpp-mpp", baseSolmpp: "base-solmpp", tempoSolmpp: "tempo-solmpp" } as const;
const PROFILES = { arcX402: "dyn-arc-to-x402", arcMpp: "dyn-arc-to-mpp", solX402: "dyn-sol-to-x402", solMpp: "dyn-sol-to-mpp", baseMpp: "dyn-x402-to-mpp", tempoX402: "dyn-mpp-to-x402", x402Arc: "dyn-x402-to-arc", mppArc: "dyn-mpp-to-arc", x402Sol: "dyn-x402-to-sol", mppSol: "dyn-mpp-to-sol" , solmppX402: "dyn-solmpp-to-x402", solmppMpp: "dyn-solmpp-to-mpp", solmppArc: "dyn-solmpp-to-arc", solmppSol: "dyn-solmpp-to-sol", x402Solmpp: "dyn-x402-to-solmpp", mppSolmpp: "dyn-mpp-to-solmpp", arcSolmpp: "dyn-arc-to-solmpp", solSolmpp: "dyn-sol-to-solmpp", arcSol: "dyn-arc-to-sol", solArc: "dyn-sol-to-arc" } as const;

let TLS: TlsMaterial;
let owner: string;
let ata: string;
let proof: ReturnType<typeof createTestSellerProof>;
/** Solana の送信の鍵（base58 の seed。乱数）と Router の ATA、Solana の Provider（owner と ATA）。 */
let solKey: string;
let solSigner: ReturnType<typeof createRealSvmCapability>;
let solRouterAta: string;
let solProvider: string;
let solProviderAta: string;
/** MPP Solana の Provider D の受取 owner と ATA。 */
let solMppProviderOwner: string;
let solMppProviderAta: string;
async function ataOf(ownerAddress: string): Promise<string> {
  return String((await findAssociatedTokenPda({ mint: address(MINT), owner: address(ownerAddress), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0]);
}
beforeAll(async () => {
  TLS = generateTestTls();
  const keypair = await generateKeyPairSigner();
  owner = String(keypair.address);
  ata = await ataOf(owner);
  proof = createTestSellerProof({ network: ARC });
  solKey = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
  solSigner = createRealSvmCapability(solKey);
  solRouterAta = await ataOf(solSigner.address);
  solProvider = String((await generateKeyPairSigner()).address);
  solProviderAta = await ataOf(solProvider);
  solMppProviderOwner = String((await generateKeyPairSigner()).address);
  solMppProviderAta = await ataOf(solMppProviderOwner);
});
afterAll(() => TLS.cleanup());

interface Fixtures {
  readonly x402: X402Upstream;
  readonly arcProvider: X402Upstream;
  readonly solProvider: SvmUpstream;
  readonly mpp: MppUpstream;
  readonly circle: CircleFacilitator;
  svm: SvmFacilitator;
  readonly solRpc: SolanaRpcFixture;
  /** pay-kit（payer の client と Provider D の server）が使う RPC の口（平文 http。chain の state は `solRpc` と共有、要求は別に数える）。 */
  readonly solRpcPlain: SolanaRpcFixture;
  readonly solMppProvider: MppSolanaUpstream;
  readonly legacy: VerifyingFacilitator;
  readonly tempoRpc: TempoRpc;
  readonly ports: Map<string, number>;
  readonly dialed: string[];
}

interface Router {
  rpcCallsAtStart: number;
  readonly core: RouterCore;
  readonly server: RunningServer;
  readonly journalPath: string;
  readonly config: RuntimeConfig;
  readonly events: TransportEvent[];
  readonly notes: string[];
  readonly payerAddress: { x402: `0x${string}`; mpp: `0x${string}` };
  client(): RouterClient;
  close(): Promise<void>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  while (closers.length > 0) {
    try {
      await closers.pop()!();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
});

async function startFixtures(): Promise<Fixtures> {
  const tempoRpc = await startTempoRpc({ tls: TLS });
  closers.push(tempoRpc.close);
  const x402 = await startX402Upstream(TLS, HOSTS.x402);
  closers.push(x402.close);
  const mpp = await startMppUpstream(TLS, tempoRpc.plainUrl, HOSTS.mpp);
  closers.push(mpp.close);
  const circle = await startCircleFacilitator(TLS, HOSTS.circle);
  closers.push(circle.close);
  const svm = await startSvmFacilitator(TLS, SOL, undefined, HOSTS.svm);
  closers.push(svm.close);
  // Router の ATA（送信元。残高 1,000,000）・受信の受取 ATA・Solana の Provider の ATA。
  const solRpc = await startSolanaRpc({ mint: MINT, decimals: 6, tls: TLS, atas: [{ address: ata, owner }, { address: solRouterAta, owner: solSigner.address, amount: "1000000" }, { address: solProviderAta, owner: solProvider }, { address: solMppProviderAta, owner: solMppProviderOwner }] });
  closers.push(solRpc.close);
  const solRpcPlain = await startSolanaRpc({ mint: MINT, decimals: 6, shareStateWith: solRpc });
  closers.push(solRpcPlain.close);
  // Provider D（MPP Solana。本物の pay-kit の server、pull、externalId あり）。
  const solMppProvider = await startMppSolanaUpstream({ rpcUrl: solRpcPlain.url, feePayer: true, recipient: solMppProviderOwner, tls: TLS, externalId: "order-m5" });
  closers.push(solMppProvider.close);
  // 名前は provider.test の証明書の SAN（arc.・sol. を fixture に足した。other.test は拒否ホストの接尾辞に当たる）。
  const arcProvider = await startX402Upstream(TLS, HOSTS.arcProvider);
  closers.push(arcProvider.close);
  arcProvider.state.accepts = [standardAccept({ network: ARC, asset: ARC_USDC, payTo: ARC_PROVIDER })];
  const solProviderUpstream = await startSvmUpstream(TLS, { port: svm.port, host: HOSTS.svm, feePayer: svm.feePayer }, { payTo: solProvider }, HOSTS.solProvider);
  closers.push(solProviderUpstream.close);
  const legacy = await startVerifyingFacilitator({ tls: TLS });
  closers.push(legacy.close);
  // 静的 route の MPP 送信は scope つきの challenge だけを候補にする（動的は「あれば照合」）。
  mpp.state.scope = "match";
  const ports = new Map<string, number>([
    [HOSTS.x402, x402.port],
    [HOSTS.mpp, mpp.port],
    [HOSTS.circle, circle.port],
    [HOSTS.svm, svm.port],
    [HOSTS.solRpc, solRpc.port],
    [HOSTS.legacy, legacy.port],
    [HOSTS.tempoRpc, tempoRpc.port],
    [HOSTS.arcProvider, arcProvider.port],
    [HOSTS.solProvider, solProviderUpstream.port],
    [HOSTS.solMppProvider, solMppProvider.port],
  ]);
  return { x402, arcProvider, solProvider: solProviderUpstream, mpp, circle, svm, solRpc, solRpcPlain, solMppProvider, legacy, tempoRpc, ports, dialed: [] };
}

function hooksOf(fixtures: Fixtures): DynamicTransportHooks {
  return {
    interfaces: () => [],
    tls: { ca: [TLS.ca] },
    lookup: (_hostname, _options, callback) => callback(null, [{ address: FIXTURE_PUBLIC_ADDRESS, family: 4 }]),
    dialForTest: (target) => {
      fixtures.dialed.push(target.hostname);
      const port = fixtures.ports.get(target.hostname);
      if (port === undefined) throw new UnmappedFixtureHostError();
      return { host: "127.0.0.1", port };
    },
  };
}

interface RouterOptions {
  readonly dir?: string;
  readonly keys?: { x402: `0x${string}`; mpp: `0x${string}` };
  /** 旧い構成（Base Sepolia・Tempo だけ。Arc・Solana の route・プロファイル・facilitator が無い）。 */
  readonly legacyOnly?: boolean;
  readonly maxPurchases?: number;
  readonly dynamicMaxPurchases?: number;
  /** 静的の予算の区分ごとの通算の上限（`arcAlt`・`baseAlt` は差し替えた資産の区分）。 */
  readonly maxTotal?: Partial<Record<"arc" | "sol" | "base" | "tempo" | "arcAlt" | "baseAlt", string>>;
  /** `arc-x402` の source の資産を差し替える（権威の欄の変更・同じ資産 id の別 network）。 */
  readonly arcSourceAsset?: string;
  /** `base` の source の資産を差し替える（同じ資産 id の別 network）。 */
  readonly baseSourceAsset?: string;
  /** Solana USDC の区分を外す（`bucket_not_allowed` の試験）。 */
  readonly dropSolBucket?: boolean;
  /** Solana USDC の区分の 1 件の上限（既定 20000。D-14 の試験）。静的・動的とも。 */
  readonly solMaxPerPurchase?: string;
  /** Solana 宛の動的プロファイルの `maxUpstreamAmount`（既定 10000。区分の上限を profile より先に当てない試験用）。 */
  readonly solMaxUpstream?: string;
  /** 動的の予算の区分ごとの通算の上限（静的とは別の台帳）。 */
  readonly dynamicMaxTotal?: Partial<Record<"arc" | "sol", string>>;
  /** 旧い区分（Base USDC・Tempo pathUSD）の 1 件の上限（既定 20000。源の区分を先に当てない試験用）。 */
  readonly oldMaxPerPurchase?: string;
}

function staticRoute(routeId: string, source: { network: string; asset: string; payTo: string; rail?: "x402" | "mpp" }, destination: "x402" | "mpp" | "arc" | "sol" | "solmpp"): Record<string, unknown> {
  return {
    routeId,
    canonicalPath: `/v1/routes/${routeId}/resource`,
    rail: destination === "mpp" || destination === "solmpp" ? "mpp" : "x402",
    sourceRail: source.rail ?? "x402",
    source: { amount: "10000", asset: source.asset, decimals: 6, network: source.network, payTo: source.payTo },
    destination:
      destination === "x402"
        ? { scheme: "exact", network: BASE, asset: USDC, payTo: FIXTURE_PAY_TO }
        : destination === "arc"
          ? { scheme: "exact", network: ARC, asset: ARC_USDC, payTo: ARC_PROVIDER }
          : destination === "sol"
            ? { scheme: "exact", network: SOL, asset: MINT, payTo: solProvider }
            : destination === "solmpp"
              ? { scheme: "solana/charge", network: SOL, asset: MINT, payTo: solMppProviderOwner }
              : { scheme: "tempo/charge", network: TEMPO, asset: PATHUSD, payTo: MPP_FIXTURE_RECIPIENT },
  };
}

function profile(profileId: string, source: { rail: "x402" | "mpp"; network: string; asset: string; payTo: string }, destination: "x402" | "mpp" | "arc" | "sol" | "solmpp"): Record<string, unknown> {
  return {
    profileId,
    sourceRail: source.rail,
    source: { network: source.network, asset: source.asset, decimals: 6, payTo: source.payTo },
    rail: destination === "mpp" || destination === "solmpp" ? "mpp" : "x402",
    destination:
      destination === "x402"
        ? { scheme: "exact", network: BASE, asset: USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } }
        : destination === "arc"
          ? { scheme: "exact", network: ARC, asset: ARC_USDC, decimals: 6, tokenDomain: { name: "USDC", version: "2" } }
          : destination === "sol"
            ? { scheme: "exact", network: SOL, asset: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS }
            : destination === "solmpp"
              ? { scheme: "solana/charge", network: SOL, asset: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS }
              : { scheme: "tempo/charge", network: TEMPO, asset: PATHUSD, decimals: 6, feeAsset: PATHUSD, maxFee: "5000", feeMargin: 20_000 },
    par: true,
    maxUpstreamAmount: "10000",
    fee: { flat: "1000", bps: 0, min: "1000" },
  };
}

async function startRouter(fixtures: Fixtures, options: RouterOptions = {}): Promise<Router> {
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = options.dir ?? mkdtempSync(path.join(runtimeRoot, "t7c-multirail-"));
  if (options.dir === undefined) closers.push(async () => rmSync(dir, { recursive: true, force: true }));
  const legacy = options.legacyOnly === true;
  const arc = { network: ARC, asset: options.arcSourceAsset ?? ARC_USDC, payTo: proof.address };
  const sol = { network: SOL, asset: MINT, payTo: owner };
  const base = { network: BASE, asset: options.baseSourceAsset ?? USDC, payTo: BASE_RECEIVER };
  const tempo = { network: TEMPO, asset: PATHUSD, payTo: BASE_RECEIVER, rail: "mpp" as const };
  /** 受信 MPP Solana（受取 owner は x402 Solana 受信と同じ）。 */
  const solMpp = { network: SOL, asset: MINT, payTo: owner, rail: "mpp" as const };
  const routes = [
    ...(legacy
      ? []
      : [
          staticRoute(ROUTES.arcX402, arc, "x402"),
          staticRoute(ROUTES.arcMpp, { ...arc, asset: ARC_USDC }, "mpp"),
          staticRoute(ROUTES.solX402, sol, "x402"),
          staticRoute(ROUTES.solMpp, sol, "mpp"),
          // 送信（D-12）: 静的 O-1 Base → Arc、O-4 Tempo → Solana。
          staticRoute(ROUTES.baseArc, base, "arc"),
          staticRoute(ROUTES.tempoSol, tempo, "sol"),
          // MPP Solana（行列 §7）: 静的 I-1・I-2（受信 MPP Solana）、O-7・O-8（送信 MPP Solana）。
          staticRoute(ROUTES.solmppX402, solMpp, "x402"),
          staticRoute(ROUTES.solmppMpp, solMpp, "mpp"),
          staticRoute(ROUTES.baseSolmpp, base, "solmpp"),
          staticRoute(ROUTES.tempoSolmpp, tempo, "solmpp"),
        ]),
    staticRoute(ROUTES.base, base, "x402"),
  ];
  const upstreamOf = (route: Record<string, unknown>): string => {
    const destination = route["destination"] as { network: string };
    if (route["rail"] === "mpp" && destination.network === SOL) return STATIC_SOLMPP_URL;
    if (route["rail"] === "mpp") return STATIC_MPP_URL;
    if (destination.network === ARC) return STATIC_ARC_URL;
    if (destination.network === SOL) return STATIC_SOL_URL;
    return STATIC_X402_URL;
  };
  const upstreams = Object.fromEntries(routes.map((route) => [route["routeId"] as string, upstreamOf(route)]));
  const bucket = (network: string, asset: string, maxTotal: string, maxPerPurchase: string) => ({ network, asset, maxTotal, maxPerPurchase });
  const newBuckets = (maxPerPurchase: string, totals: { arc?: string; sol?: string } = options.maxTotal ?? {}) => [
    bucket(ARC, ARC_USDC, totals.arc ?? "1000000", maxPerPurchase),
    ...(options.arcSourceAsset === undefined ? [] : [bucket(ARC, options.arcSourceAsset, options.maxTotal?.arcAlt ?? "1000000", maxPerPurchase)]),
    ...(options.dropSolBucket ? [] : [bucket(SOL, MINT, totals.sol ?? "1000000", options.solMaxPerPurchase ?? maxPerPurchase)]),
  ];
  const oldBuckets = (maxPerPurchase: string) => [
    bucket(BASE, USDC, options.maxTotal?.base ?? "1000000", maxPerPurchase),
    ...(options.baseSourceAsset === undefined ? [] : [bucket(BASE, options.baseSourceAsset, options.maxTotal?.baseAlt ?? "1000000", maxPerPurchase)]),
    bucket(TEMPO, PATHUSD, options.maxTotal?.tempo ?? "1000000", maxPerPurchase),
  ];
  const profiles = {
    ...(legacy
      ? {}
      : {
          [PROFILES.arcX402]: profile(PROFILES.arcX402, { rail: "x402", ...arc, asset: ARC_USDC }, "x402"),
          [PROFILES.arcMpp]: profile(PROFILES.arcMpp, { rail: "x402", ...arc, asset: ARC_USDC }, "mpp"),
          [PROFILES.solX402]: profile(PROFILES.solX402, { rail: "x402", ...sol }, "x402"),
          [PROFILES.solMpp]: profile(PROFILES.solMpp, { rail: "x402", ...sol }, "mpp"),
          // 送信（D-12）: 動的 O-1〜O-4。
          [PROFILES.x402Arc]: profile(PROFILES.x402Arc, { rail: "x402", ...base, asset: USDC }, "arc"),
          [PROFILES.mppArc]: profile(PROFILES.mppArc, { ...tempo }, "arc"),
          [PROFILES.x402Sol]: { ...profile(PROFILES.x402Sol, { rail: "x402", ...base, asset: USDC }, "sol"), maxUpstreamAmount: options.solMaxUpstream ?? "10000" },
          [PROFILES.mppSol]: { ...profile(PROFILES.mppSol, { ...tempo }, "sol"), maxUpstreamAmount: options.solMaxUpstream ?? "10000" },
          // MPP Solana（行列 §7）: 動的 I-1〜I-4（受信 MPP Solana）、O-7〜O-10（送信 MPP Solana）。
          [PROFILES.solmppX402]: profile(PROFILES.solmppX402, { ...solMpp }, "x402"),
          [PROFILES.solmppMpp]: profile(PROFILES.solmppMpp, { ...solMpp }, "mpp"),
          [PROFILES.solmppArc]: profile(PROFILES.solmppArc, { ...solMpp }, "arc"),
          [PROFILES.solmppSol]: { ...profile(PROFILES.solmppSol, { ...solMpp }, "sol"), maxUpstreamAmount: options.solMaxUpstream ?? "10000" },
          [PROFILES.x402Solmpp]: profile(PROFILES.x402Solmpp, { rail: "x402", ...base, asset: USDC }, "solmpp"),
          [PROFILES.mppSolmpp]: profile(PROFILES.mppSolmpp, { ...tempo }, "solmpp"),
          [PROFILES.arcSolmpp]: profile(PROFILES.arcSolmpp, { rail: "x402", ...arc, asset: ARC_USDC }, "solmpp"),
          [PROFILES.solSolmpp]: { ...profile(PROFILES.solSolmpp, { rail: "x402", ...sol }, "solmpp"), maxUpstreamAmount: options.solMaxUpstream ?? "10000" },
          // O-5・O-6（送信の要件 §11、D-17 の決定 2026-10-09）: Arc x402 ↔ Solana x402。動的だけ。
          [PROFILES.arcSol]: { ...profile(PROFILES.arcSol, { rail: "x402", ...arc, asset: ARC_USDC }, "sol"), maxUpstreamAmount: options.solMaxUpstream ?? "10000" },
          [PROFILES.solArc]: profile(PROFILES.solArc, { rail: "x402", ...sol }, "arc"),
        }),
    [PROFILES.baseMpp]: profile(PROFILES.baseMpp, { rail: "x402", ...base, asset: USDC }, "mpp"),
    [PROFILES.tempoX402]: profile(PROFILES.tempoX402, { rail: "mpp", network: TEMPO, asset: PATHUSD, payTo: BASE_RECEIVER }, "x402"),
  };
  const document = {
    router: {
      approvalTtlMs: 60_000,
      routes: Object.fromEntries(routes.map((route) => [route["routeId"] as string, route])),
      // 同じ区分に落ちる受信と送信は合算される（Base → Base は 10000 + 1000）ので、1 件の上限は 20000。
      budget: { maxPurchases: options.maxPurchases ?? 50, buckets: [...(legacy ? [] : newBuckets("20000")), ...oldBuckets(options.oldMaxPerPurchase ?? "20000")] },
      dynamic: {
        enabled: true,
        profiles,
        budget: { maxPurchases: options.dynamicMaxPurchases ?? 50, buckets: [...(legacy ? [] : newBuckets("20000", options.dynamicMaxTotal ?? options.maxTotal ?? {})), ...oldBuckets(options.oldMaxPerPurchase ?? "20000")] },
        limits: { ...DEFAULT_DYNAMIC_LIMITS, quotesPerMinuteGlobal: 1000, quotesPerMinutePerSource: 1000, purchasesPerMinuteGlobal: 1000, purchasesPerMinutePerSource: 1000, perHostPerMinute: 1000, perAddressPerMinute: 1000, perAddressConcurrent: 64, perHostConcurrent: 64, concurrentGlobal: 64, concurrentPerSource: 64 },
        denyHosts: [],
      },
    },
    x402: {
      upstreams,
      ...(legacy ? {} : { inboundFacilitators: { [ARC]: { kind: "circle", url: `https://${HOSTS.circle}` }, [SOL]: { kind: "x402", url: `https://${HOSTS.svm}` } } }),
    },
  };
  const configPath = path.join(dir, "router.config.json");
  writeFileSync(configPath, JSON.stringify(document));
  const journalPath = path.join(dir, "journal.ndjson");
  const config = loadRuntimeConfig(
    {
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PRINCIPAL_TOKENS: "judge:public",
      ROUTER_ADAPTER_MODE: "real",
      ROUTER_SUBETHA_FACILITATOR_URL: "https://other.test",
      ROUTER_X402_INBOUND_FACILITATOR_URL: `https://${HOSTS.legacy}`,
      ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-multirail",
      ROUTER_MPP_INBOUND_RPC_URL: `https://${HOSTS.tempoRpc}`,
      ...(legacy ? {} : { ROUTER_SOLANA_RPC_URL: `https://${HOSTS.solRpc}` }),
      ROUTER_CANONICAL_BASE_URL: "https://router.test",
      ROUTER_JOURNAL_PATH: journalPath,
    },
    (file) => readFileSync(file, "utf8"),
    { networks: TEST_NETWORKS },
  );
  const keys = options.keys ?? { x402: generatePrivateKey(), mpp: generatePrivateKey() };
  const evm = createRealEvmCapability(keys.x402);
  const mppCapability = createRealMppCapability(keys.mpp, { rpcUrl: `https://${HOSTS.tempoRpc}` });
  const capabilities: RouterCapabilities = {
    evmSigning: evm.capability(BASE),
    // 送信（D-11）: Arc は Base と同じ鍵、Solana は ed25519 の鍵。
    ...(legacy ? {} : { evmSigningByNetwork: { [ARC]: evm.capability(ARC) }, svmSigning: { [SOL]: solSigner.capability(SOL) } }),
    mppTempo: mppCapability.capability(),
    sellerProofs: { [ARC]: proof.capability },
    knownNetworksForTest: TEST_NETWORKS,
    dependencyUrls: [`https://${HOSTS.tempoRpc}/`],
    dynamicTransportHooksForTest: hooksOf(fixtures),
    transportHooksForTest: hooksOf(fixtures),
  };
  const events: TransportEvent[] = [];
  const notes: string[] = [];
  const rails = composeRails(config, capabilities, (event) => events.push(event), (message) => notes.push(message));
  const dialedBefore = fixtures.dialed.length;
  // 起動時の検査（SVM の `/supported`・ATA）は `startRouter` と同じ順: core を作る前に待つ。
  if (legacy) expect(rails.startup).toBeDefined(); // 実鍵の Tempo の能力は chain id の検査（docs/mainnet-first-route.md FR-M4）を持つ
  else expect(rails.startup).toBeDefined();
  await rails.startup?.();
  await rails.dynamic!.verify();
  // 起動時の接続（SVM の facilitator・Solana RPC・Tempo RPC）は要求ごとの数え方に混ぜない。
  const startupDials = fixtures.dialed.splice(dialedBefore);
  expect(new Set(startupDials)).toEqual(new Set(legacy ? [HOSTS.tempoRpc] : [HOSTS.svm, HOSTS.solRpc, HOSTS.tempoRpc]));
  const core = await createRouterCore({
    journalPath,
    config: config.router,
    inbound: rails.inbound,
    outbound: rails.outbound,
    note: (message) => notes.push(message),
    dynamic: { ledgerDir: path.join(dir, "dynamic-quotes"), ...dynamicCoreOptionsOf(rails.dynamic!, capabilities, config) },
    // 本番の `startRouter` と同じ: journal の消費済み署名を MPP Solana 受信に見せる（`docs/mpp-solana-design.md` §2.3）。
    onStoreLoaded: rails.bindConsumed,
  });
  const server = await startHttpServer({ core, config: config.router, canonicalBaseUrl: "https://router.test", principals: config.principals, host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const router: Router = {
    rpcCallsAtStart: 0,
    core,
    server,
    journalPath,
    config,
    events,
    notes,
    payerAddress: { x402: evm.address, mpp: mppCapability.address },
    client: () => createRouterClient({ baseUrl, principalId: "judge", token: "public", allowUnissuedQuotes: true, source: "judge" }),
    close: async () => {
      await server.close();
      await core.close();
    },
  };
  closers.push(router.close);
  // 上流の有料応答は Router の送信者（運用者の鍵）宛て。
  fixtures.x402.state.pay = () => paidOk(evm.address, { price: 1 });
  fixtures.arcProvider.state.pay = () => paidOk(evm.address, { price: 2 }, ARC);
  // 起動時の RPC（受信の ATA・送信の Router/宛先 ATA）は要求ごとの数え方に混ぜない。
  router.rpcCallsAtStart = fixtures.solRpc.calls.length;
  return router;
}

/** Router を止めて同じ journal で起動し直す（process の再起動の等価。鍵は同じ）。 */
async function restart(fixtures: Fixtures, router: Router, options: RouterOptions): Promise<Router> {
  await router.close();
  closers.splice(closers.indexOf(router.close), 1);
  return startRouter(fixtures, options);
}

type Offer = { amount: string; payTo: string; asset: string; network: string; extra: Record<string, unknown> };

function offerOf(quote: QuoteView): Offer {
  return quote.source.offer as Offer;
}

function encode(envelope: unknown): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

function decode(credential: string): { x402Version: number; accepted: Offer; payload: Record<string, unknown> } {
  return JSON.parse(Buffer.from(credential, "base64").toString("utf8"));
}

/** Solana の credential: 製品の builder で組んだ transaction に authority（乱数の鍵）が部分署名する。改変の口は fixture の payer のもの。 */
async function svmCredential(quote: QuoteView, options: SvmPayerBuildOptions = {}): Promise<string> {
  const offer = offerOf(quote);
  const payer = await createSvmTestPayer(MINT);
  const policy = { feePayer: String(offer.extra["feePayer"]), payTo: owner, destinationAta: ata, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS };
  const transaction = await payer.build(policy, offer.amount, String(offer.extra["memo"]), options);
  return encode({ x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra["challengeNonce"], transaction } });
}

/** 呼び出し側: quote の source の network に応じた credential（EVM は署名だけ、Solana は部分署名だけ、MPP は fixture の RPC に実際に送金）。 */
/** 直近の受信 MPP Solana の credential の取引の署名（Router の `source.txRef` と突き合わせる）。 */
let lastSolMppSignature: string | undefined;
async function credentialFor(fixtures: Fixtures, quote: QuoteView, solMppMode: "transaction" | "signature" = "transaction"): Promise<string> {
  const offer = offerOf(quote);
  if (offer.network === SOL && (offer as unknown as { scheme: string }).scheme === "solana/charge") {
    // 受信 MPP Solana: 本物の pay-kit の client（`transaction` 型 = Router が送出 / `signature` 型 = payer が fixture の RPC に送出済み）。
    const payer = await createMppSolanaTestPayer({ rpcUrl: fixtures.solRpcPlain.url });
    try {
      const credential = await payer.credentialFor(offer as unknown as InboundOffer, solMppMode);
      lastSolMppSignature = payer.lastSignature();
      return encode(credential);
    } finally {
      await payer.close();
    }
  }
  if (offer.network === ARC) return createX402Payer(generatePrivateKey()).credentialFor(offer as never, 5042002);
  if (offer.network === BASE) return createX402Payer(generatePrivateKey()).credentialFor(offer as never, 84532);
  if (offer.network === SOL) return svmCredential(quote);
  const payer = createMppPayer(generatePrivateKey(), { chainId: MPP_FIXTURE_CHAIN_ID, asset: PATHUSD, payTo: BASE_RECEIVER, maxAmount: 1_000_000n }, { rpcUrl: fixtures.tempoRpc.plainUrl });
  const paid = await payer.payAndCredential(offer);
  return encode({ x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra["challengeNonce"], credential: paid.credential } });
}

async function staticQuote(router: Router, routeId: string, requestId: string): Promise<QuoteView> {
  const result = await router.client().quote({ routeId, requestId });
  if (!result.ok) throw new Error(`quote failed: ${result.error}`);
  return result.quote;
}

async function dynamicQuote(router: Router, profileId: string, requestId: string): Promise<QuoteView> {
  const url = profileId.endsWith("-to-solmpp") ? SOLMPP_URL : profileId.endsWith("-to-mpp") ? MPP_URL : profileId.endsWith("-to-arc") ? ARC_URL : profileId.endsWith("-to-sol") ? SOL_URL : X402_URL;
  const result = await router.client().quoteUrl({ profileId, url, requestId });
  if (!result.ok) {
    const direct = await router.core.quote({ principalId: "judge", requestId: `${requestId}-dbg`, routeId: profileId, upstream: { url }, source: "judge" });
    throw new Error(`quote failed: ${result.error} core=${JSON.stringify(direct)}`);
  }
  return result.quote;
}

async function purchase(router: Router, quote: QuoteView, credential: string, requestId: string) {
  return router.client().execute({ quote, requestId, approval: { approved: true, quoteId: quote.quoteId }, credential });
}

/** 受信側（facilitator・RPC）への要求の数。 */
function inboundCalls(fixtures: Fixtures) {
  return {
    circle: { verify: fixtures.circle.seen.verifyCalls, settle: fixtures.circle.seen.settleCalls },
    svm: { verify: fixtures.svm.seen.verifyCalls, settle: fixtures.svm.seen.settleCalls, supported: fixtures.svm.seen.supportedCalls },
    legacy: { verify: fixtures.legacy.calls.verify, settle: fixtures.legacy.calls.settle },
    solRpc: fixtures.solRpc.calls.length,
  };
}

/** 起動時の分を除いた Solana RPC の回数。 */
function solRpcCallsSince(fixtures: Fixtures, router: Router): number {
  return fixtures.solRpc.calls.length - router.rpcCallsAtStart;
}

/** 送信側の数（上流の有料要求、Tempo への送金）。 */
function outboundCalls(fixtures: Fixtures) {
  return { x402Payments: fixtures.x402.seen.payments.length, mppSends: fixtures.tempoRpc.sentRaw.length, mppCredentials: fixtures.mpp.seen.credentials };
}

/** 送信（U8-a）: Arc・Solana の Provider への有料要求の数。 */
function providerPayments(fixtures: Fixtures) {
  return { arcPayments: fixtures.arcProvider.seen.payments.length, solPayments: fixtures.solProvider.seen.paid.length };
}

function journalEventsOf(router: Router, paymentId: string): string[] {
  return readFileSync(router.journalPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { event: string; paymentId?: string })
    .filter((row) => row.paymentId === paymentId)
    .map((row) => row.event);
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > 10_000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/* ------------------------------------------------------------------ AC-1・AC-2 の offline 版 */

describe("本番と同じ構成で、Arc と Solana から x402 と MPP の上流に届く（静的・動的）", () => {
  const matrix: [string, "static" | "dynamic", string, "arc" | "sol", "x402" | "mpp"][] = [
    ["Arc → x402（静的）", "static", ROUTES.arcX402, "arc", "x402"],
    ["Arc → MPP（静的）", "static", ROUTES.arcMpp, "arc", "mpp"],
    ["Solana → x402（静的）", "static", ROUTES.solX402, "sol", "x402"],
    ["Solana → MPP（静的）", "static", ROUTES.solMpp, "sol", "mpp"],
    ["Arc → x402（動的）", "dynamic", PROFILES.arcX402, "arc", "x402"],
    ["Arc → MPP（動的）", "dynamic", PROFILES.arcMpp, "arc", "mpp"],
    ["Solana → x402（動的）", "dynamic", PROFILES.solX402, "sol", "x402"],
    ["Solana → MPP（動的）", "dynamic", PROFILES.solMpp, "sol", "mpp"],
  ];
  test.each(matrix)("%s: delivered。受信は該当の facilitator だけに verify 1・settle 1、送信は 1 回", async (_name, kind, id, source, destination) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = kind === "static" ? await staticQuote(router, id, "r1") : await dynamicQuote(router, id, "r1");
    const offer = offerOf(quote);
    expect(offer.network).toBe(source === "arc" ? ARC : SOL);
    expect(offer.payTo).toBe(source === "arc" ? proof.address : owner);
    if (source === "arc") expect(offer.extra["assetTransferMethod"]).toBe("eip3009");
    else expect(offer.extra["feePayer"]).toBe(fixtures.svm.feePayer);
    expect(quote.source).toMatchObject({ network: offer.network, asset: source === "arc" ? ARC_USDC : MINT, decimals: 6, payTo: offer.payTo });
    const result = await purchase(router, quote, await credentialFor(fixtures, quote), "r1");
    expect(result).toMatchObject({ outcome: "delivered", snapshot: destination === "x402" ? { price: 1 } : { ok: true } });
    const calls = inboundCalls(fixtures);
    expect(calls.circle).toEqual(source === "arc" ? { verify: 1, settle: 1 } : { verify: 0, settle: 0 });
    expect(calls.svm).toEqual(source === "sol" ? { verify: 1, settle: 1, supported: 1 } : { verify: 0, settle: 0, supported: 1 });
    expect(calls.legacy).toEqual({ verify: 0, settle: 0 });
    // 受信の settle の後の追跡は無い（fixture の confirm は ok）: 起動時の分を除いて RPC 0。起動時は x402 受信の ATA 1 ＋ 送信の静的の宛先 ATA（tempo-sol）1 ＋
    // MPP Solana 受信の ATA 1 ＋ MPP Solana 送信の静的の宛先 ATA（base-solmpp・tempo-solmpp）2 = 5。
    expect(solRpcCallsSince(fixtures, router)).toBe(0);
    expect(router.rpcCallsAtStart).toBe(5);
    if (source === "arc") expect(fixtures.circle.seen.proofFailures).toEqual([]);
    expect(outboundCalls(fixtures)).toEqual(destination === "x402" ? { x402Payments: 1, mppSends: 0, mppCredentials: 0 } : { x402Payments: 0, mppSends: 1, mppCredentials: 1 });
    expect(providerPayments(fixtures)).toEqual({ arcPayments: 0, solPayments: 0 });
    // 接続先は fixture の中の該当だけ（facilitator・上流・送信の RPC）。
    const expected = new Set<string>([source === "arc" ? HOSTS.circle : HOSTS.svm, destination === "x402" ? HOSTS.x402 : HOSTS.mpp, ...(destination === "mpp" ? [HOSTS.tempoRpc] : [])]);
    expect(new Set(fixtures.dialed)).toEqual(expected);
    // 結果の保存と再読取（動的は ownerKey つき）。
    const status = await router.client().status(quote.paymentId, quote.ownerKey);
    expect(status).toMatchObject({ found: true, projection: { status: "delivered" } });
    expect(journalEventsOf(router, quote.paymentId).at(-1)).toBe("delivered");
  });
});

/* ------------------------------------------------------------------ MPP Solana（行列 §7、タスク M5） */

describe("MPP Solana の行列（要件 §7）: 受信 MPP Solana（I-1〜I-4）と送信 MPP Solana（O-7〜O-10）が本番と同じ構成で delivered", () => {
  type Source = "solmpp" | "base" | "tempo" | "arc" | "sol";
  type Destination = "x402" | "mpp" | "arc" | "sol" | "solmpp";
  const matrix: [string, "static" | "dynamic", string, Source, Destination, "transaction" | "signature"][] = [
    ["I-1 MPP Solana → x402 Base（静的・transaction 型）", "static", ROUTES.solmppX402, "solmpp", "x402", "transaction"],
    ["I-2 MPP Solana → MPP Tempo（静的・signature 型）", "static", ROUTES.solmppMpp, "solmpp", "mpp", "signature"],
    ["O-7 x402 Base → MPP Solana（静的）", "static", ROUTES.baseSolmpp, "base", "solmpp", "transaction"],
    ["O-8 MPP Tempo → MPP Solana（静的）", "static", ROUTES.tempoSolmpp, "tempo", "solmpp", "transaction"],
    ["I-1 MPP Solana → x402 Base（動的・signature 型）", "dynamic", PROFILES.solmppX402, "solmpp", "x402", "signature"],
    ["I-2 MPP Solana → MPP Tempo（動的・transaction 型）", "dynamic", PROFILES.solmppMpp, "solmpp", "mpp", "transaction"],
    ["I-3 MPP Solana → x402 Arc（動的）", "dynamic", PROFILES.solmppArc, "solmpp", "arc", "transaction"],
    ["I-4 MPP Solana → x402 Solana（動的。同じ USDC の区分を両レグで）", "dynamic", PROFILES.solmppSol, "solmpp", "sol", "transaction"],
    ["O-7 x402 Base → MPP Solana（動的）", "dynamic", PROFILES.x402Solmpp, "base", "solmpp", "transaction"],
    ["O-8 MPP Tempo → MPP Solana（動的）", "dynamic", PROFILES.mppSolmpp, "tempo", "solmpp", "transaction"],
    ["O-9 x402 Arc → MPP Solana（動的）", "dynamic", PROFILES.arcSolmpp, "arc", "solmpp", "transaction"],
    ["O-10 x402 Solana → MPP Solana（動的。同じ USDC の区分を両レグで）", "dynamic", PROFILES.solSolmpp, "sol", "solmpp", "transaction"],
  ];
  test.each(matrix)("%s: delivered。受信は該当のレールだけ、送信は 1 回（MPP Solana は pay-kit の server の本物の検証と共同署名）", async (_name, kind, id, source, destination, mode) => {
    const fixtures = await startFixtures();
    // 受信 MPP Solana（transaction 型）の追跡と pay-kit の server の確定待ち: 1 回目の status で confirmed。
    fixtures.solRpc.state.signatureStatuses = ["confirmed"];
    // I-4・O-10 は同じ区分に源（上流 10,000 + 手数料 1,000）と宛先 10,000 が落ちる = 21,000。1 件の上限をそれに合わせる（通算の試験は下）。
    const router = await startRouter(fixtures, { solMaxPerPurchase: "21000" });
    const quote = kind === "static" ? await staticQuote(router, id, "m1") : await dynamicQuote(router, id, "m1");
    const offer = offerOf(quote);
    const expectedSourceNetwork = { solmpp: SOL, base: BASE, tempo: TEMPO, arc: ARC, sol: SOL }[source];
    expect(offer.network).toBe(expectedSourceNetwork);
    if (source === "solmpp") {
      expect((offer as unknown as { scheme: string }).scheme).toBe("solana/charge");
      expect(offer.payTo).toBe(owner);
      expect(offer.extra["fundsMoveOnCredential"]).toBe(true);
      expect(typeof offer.extra["externalId"]).toBe("string");
    }
    if (destination === "solmpp") expect(quote.destination).toMatchObject({ network: SOL, asset: MINT });
    const sentBefore = fixtures.solRpc.state.sent.length;
    const result = await purchase(router, quote, await credentialFor(fixtures, quote, mode), "m1");
    const expectedBody = destination === "x402" ? { price: 1 } : destination === "arc" ? { price: 2 } : destination === "solmpp" ? { ok: true, source: "mpp-solana-provider" } : destination === "sol" ? { ok: true, source: "svm-provider" } : { ok: true };
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "delivered", snapshot: expectedBody });
    // 受信: MPP Solana は facilitator を使わない（RPC だけ）。chain（fixture）に乗る取引: 受信 1 件（transaction 型は Router の送出、signature 型は payer の送出済み）+ 送信 MPP Solana なら pay-kit の共同署名 1 件。
    const calls = inboundCalls(fixtures);
    if (source === "solmpp") {
      // SVM の facilitator の verify は x402 Solana の **Provider** が送信の検証に使う（I-4）。受信では使わない。
      expect(calls.svm.verify).toBe(destination === "sol" ? 1 : 0);
      expect(calls.circle.verify).toBe(0);
      expect(calls.legacy.verify).toBe(0);
    }
    expect(fixtures.solRpc.state.sent.length).toBe(sentBefore + (source === "solmpp" ? 1 : 0) + (destination === "solmpp" ? 1 : 0));
    // 送信: MPP Solana の Provider D は有料要求 1 件を受け、領収を出した。
    expect(fixtures.solMppProvider.seen.payCalls).toBe(destination === "solmpp" ? 1 : 0);
    expect(fixtures.solMppProvider.seen.receipts).toHaveLength(destination === "solmpp" ? 1 : 0);
    // Router の RPC（SR-M1。pay-kit の口は別に数える）。受信 MPP Solana: transaction 型 = sendTransaction 1 + getSignatureStatuses 1、signature 型 = getTransaction 1（verify）。
    // 送信 MPP Solana: 残高 1（getTokenAccountBalance）+ 動的なら quote の宛先 ATA 1（purchase の読み直しは覚えた存在を使う）+ 送る直前の ATA 1 + blockhash 1 + 領収の getTransaction 1。
    const routerRpc = fixtures.solRpc.calls.slice(router.rpcCallsAtStart).map((c) => c.method).sort();
    const expectedRpc: string[] = [];
    if (source === "solmpp") expectedRpc.push(...(mode === "transaction" ? ["sendTransaction", "getSignatureStatuses"] : ["getTransaction"]));
    if (destination === "solmpp") expectedRpc.push("getTokenAccountBalance", ...(kind === "dynamic" ? ["getAccountInfo"] : []), "getAccountInfo", "getLatestBlockhash", "getTransaction");
    // x402 Solana 送信（既存の adapter。本 PR では変えない）は動的の 402 の読み直しごとに宛先 ATA を読む: quote 1 + purchase の読み直し 2 + 送る直前 1 = 4。
    if (destination === "sol") expectedRpc.push("getTokenAccountBalance", ...(kind === "dynamic" ? ["getAccountInfo", "getAccountInfo", "getAccountInfo"] : []), "getAccountInfo", "getLatestBlockhash");
    if (source === "solmpp" || destination === "solmpp") expect(routerRpc).toEqual(expectedRpc.sort());
    // 結果の保存と再読取（動的は ownerKey つき）。
    const status = await router.client().status(quote.paymentId, quote.ownerKey);
    expect(status).toMatchObject({ found: true, projection: { status: "delivered" } });
    const signature = expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    if (destination === "solmpp") expect(status).toMatchObject({ projection: { destination: { txRef: signature } } });
    // 受信 MPP Solana の txRef は、payer が作った取引の署名そのもの（transaction 型は Router が送出した tx の [0]、signature 型は payer が送出した署名）。
    if (source === "solmpp") expect(status).toMatchObject({ projection: { source: { txRef: lastSolMppSignature } } });
    expect(journalEventsOf(router, quote.paymentId).at(-1)).toBe("delivered");
    // 接続先: 受信 MPP Solana は Solana RPC だけ、送信 MPP Solana は Provider D と Solana RPC。
    if (source === "solmpp") expect(fixtures.dialed).toContain(HOSTS.solRpc);
    if (destination === "solmpp") expect(fixtures.dialed).toContain(HOSTS.solMppProvider);
    if (source === "solmpp" && destination === "x402") expect(new Set(fixtures.dialed)).toEqual(new Set([HOSTS.solRpc, HOSTS.x402]));
    if (source === "base" && destination === "solmpp") expect(new Set(fixtures.dialed)).toEqual(new Set([HOSTS.legacy, HOSTS.solMppProvider, HOSTS.solRpc]));
  });

  test("I-4・O-10: 同じ USDC（Solana）の区分を両レグで使う → 1 件の上限は両レグの合計（源 11,000 + 宛先 10,000 = 21,000: 20,999 で止まり、21,000 ちょうどで届く）、通算も両レグ分（上限 21,000 は 1 件で尽きる）", async () => {
    const fixtures = await startFixtures();
    fixtures.solRpc.state.signatureStatuses = ["confirmed"];
    // 通算: 動的の Solana の区分 21,000 = I-4 の源 11,000（上流 10,000 + 手数料 1,000）+ 宛先 10,000。1 件で使い切る。
    let router = await startRouter(fixtures, { dynamicMaxTotal: { sol: "21000" }, solMaxPerPurchase: "21000" });
    const q1 = await dynamicQuote(router, PROFILES.solmppSol, "b1");
    expect(await purchase(router, q1, await credentialFor(fixtures, q1), "b1")).toMatchObject({ outcome: "delivered" });
    const q2 = await dynamicQuote(router, PROFILES.solSolmpp, "b2");
    expect(await purchase(router, q2, await credentialFor(fixtures, q2), "b2")).toMatchObject({ outcome: "rejected", error: "bucket_limit" });
    expect(fixtures.solMppProvider.seen.payCalls).toBe(0);
    await router.close();
    closers.splice(closers.indexOf(router.close), 1);
    // 1 件の上限: 20,999 では両レグの合計 21,000 が超える（O-10 も I-4 も）。動的は quote の段で見る（dynamic.ts の per_purchase_limit）。
    router = await startRouter(fixtures, { solMaxPerPurchase: "20999" });
    expect(await router.client().quoteUrl({ profileId: PROFILES.solSolmpp, url: SOLMPP_URL, requestId: "b3" })).toMatchObject({ ok: false });
    expect(await router.core.quote({ principalId: "judge", requestId: "b3-core", routeId: PROFILES.solSolmpp, upstream: { url: SOLMPP_URL }, source: "judge" })).toMatchObject({ ok: false, code: "quote_failed", reason: "per_purchase_limit" });
    expect(await router.core.quote({ principalId: "judge", requestId: "b4-core", routeId: PROFILES.solmppSol, upstream: { url: SOL_URL }, source: "judge" })).toMatchObject({ ok: false, code: "quote_failed", reason: "per_purchase_limit" });
    expect(fixtures.solMppProvider.seen.payCalls).toBe(0);
    await router.close();
    closers.splice(closers.indexOf(router.close), 1);
    // 境界: 21,000 ちょうどは届く。
    router = await startRouter(fixtures, { solMaxPerPurchase: "21000" });
    const q5 = await dynamicQuote(router, PROFILES.solSolmpp, "b5");
    expect(await purchase(router, q5, await credentialFor(fixtures, q5), "b5")).toMatchObject({ outcome: "delivered" });
    expect(fixtures.solMppProvider.seen.payCalls).toBe(1);
  });
});

/* ------------------------------------------------------------------ AC-3 */

describe("AC-3: 偽の Solana の credential は preflight で止まり、facilitator・RPC に届かない", () => {
  const rows: [string, (q: QuoteView, p: { sourceAta: string; feePayer: string }) => SvmPayerBuildOptions, string][] = [
    ["別の宛先（payer 自身の ATA）", (_q, p) => ({ destination: p.sourceAta }), "credential_mismatch"],
    ["別の額（+1）", () => ({ amount: 10_001n }), "credential_mismatch"],
    ["別の mint", () => ({ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), "credential_mismatch"],
    ["別の桁（9）", () => ({ decimals: 9 }), "credential_mismatch"],
    // fee payer を Router（受取 owner）に向けた tx: 宛先は正しく、fee payer の欄だけが facilitator の口座ではない。
    ["fee payer を Router に向ける（fee payer = 受取 owner）", () => ({ feePayer: owner }), "credential_mismatch"],
    ["宛先 = fee payer（facilitator の口座）", (_q, p) => ({ destination: p.feePayer }), "credential_mismatch"],
    ["transfer が 2 つ", () => ({ instructions: (ixs) => [...ixs, ixs[2]!] }), "credential_mismatch"],
    // 命令の数は 4 のまま、memo の program だけを別のものにする（数の検査ではなく program の検査に当たる）。
    ["不明な program の命令（4 つのまま、memo の program を差し替え）", () => ({ instructions: (ixs) => [ixs[0]!, ixs[1]!, ixs[2]!, { ...ixs[3]!, programAddress: address("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95") }] }), "credential_mismatch"],
    ["不明な program の命令（5 つ目として追加）", () => ({ instructions: (ixs) => [...ixs, { programAddress: address("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"), accounts: [], data: new Uint8Array([1]) }] }), "credential_mismatch"],
    [
      "memo を書き換えた tx（元の署名のまま）",
      (q) => ({
        mutateBytes: (b) => {
          const out = new Uint8Array(b);
          const at = Buffer.from(out).indexOf(Buffer.from(String(offerOf(q).extra["memo"]), "utf8"));
          if (at < 0) throw new Error("memo not found");
          out.set(Buffer.from(`0x${"cd".repeat(32)}`, "utf8"), at);
          return out;
        },
      }),
      "nonce_mismatch",
    ],
    // lookup table つきの message に authority が正しく署名した tx: 構造だけで落ちる（署名の失敗ではない）。
    ["address lookup table の参照（署名は有効）", () => ({ lookupTable: true }), "credential_mismatch"],
  ];
  test.each(rows)("%s → rejected（%s）。facilitator・RPC への要求 0、接続 0", async (_name, mutate, reason) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await staticQuote(router, ROUTES.solX402, "r1");
    const offer = offerOf(quote);
    const payer = await createSvmTestPayer(MINT);
    const policy = { feePayer: String(offer.extra["feePayer"]), payTo: owner, destinationAta: ata, mint: MINT, decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS };
    const transaction = await payer.build(policy, offer.amount, String(offer.extra["memo"]), mutate(quote, { sourceAta: payer.sourceAta, feePayer: policy.feePayer }));
    const forged = encode({ x402Version: 2, accepted: offer, payload: { challengeNonce: offer.extra["challengeNonce"], transaction } });
    const before = inboundCalls(fixtures);
    const dialed = fixtures.dialed.length;
    expect(await purchase(router, quote, forged, "r1")).toEqual({ outcome: "payment_required", error: reason, paymentId: quote.paymentId });
    expect(inboundCalls(fixtures)).toEqual(before);
    expect(fixtures.dialed.length).toBe(dialed);
    expect(journalEventsOf(router, quote.paymentId)).toEqual(["created"]);
    // 対照: 同じ quote に正しい credential は通る（preflight の拒否は quote を終端にしない）。
    expect((await purchase(router, quote, await svmCredential(quote), "r1")).outcome).toBe("delivered");
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 1, settle: 1, supported: 1 });
  });

  test("再提出: 別の quote（nonce_mismatch）・別の route（route_binding_mismatch）は要求 0。同じ quote の並行は settle 1 回、再起動後も 1 回", async () => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t7c-resubmit-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    let router = await startRouter(fixtures, { dir, keys });
    const a = await staticQuote(router, ROUTES.solX402, "a");
    const b = await staticQuote(router, ROUTES.solX402, "b");
    const c = await staticQuote(router, ROUTES.solMpp, "c");
    const ca = await svmCredential(a);
    const decoded = decode(ca);
    const before = inboundCalls(fixtures);
    // 別の quote（同じ route）: 封筒は B のものにし、transaction は A のまま → memo が B の nonce と違う。
    const intoB = encode({ x402Version: 2, accepted: offerOf(b), payload: { challengeNonce: offerOf(b).extra["challengeNonce"], transaction: decoded.payload["transaction"] } });
    expect(await purchase(router, b, intoB, "b")).toEqual({ outcome: "payment_required", error: "nonce_mismatch", paymentId: b.paymentId });
    // 別の route: nonce は C のもの、accepted は A の offer（別の route の束縛）→ route_binding_mismatch。
    const intoC = encode({ x402Version: 2, accepted: offerOf(a), payload: { challengeNonce: offerOf(c).extra["challengeNonce"], transaction: decoded.payload["transaction"] } });
    expect(await purchase(router, c, intoC, "c")).toEqual({ outcome: "payment_required", error: "route_binding_mismatch", paymentId: c.paymentId });
    expect(inboundCalls(fixtures)).toEqual(before);
    // 同じ quote の並行: どちらも delivered、settle は 1 回（2 本目は既存の結果）。
    const [first, second] = await Promise.all([purchase(router, a, ca, "a"), purchase(router, a, ca, "a")]);
    expect([first.outcome, second.outcome]).toEqual(["delivered", "delivered"]);
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 1, settle: 1, supported: 1 });
    expect(outboundCalls(fixtures).x402Payments).toBe(1);
    // 再起動後の再提出: 既存の結果。settle は増えない（起動時の /supported は 1 回増える）。
    router = await restart(fixtures, router, { dir, keys });
    expect((await purchase(router, a, ca, "a")).outcome).toBe("delivered");
    expect(await purchase(router, b, intoB, "b")).toMatchObject({ outcome: "payment_required", error: "nonce_mismatch" });
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 1, settle: 1, supported: 2 });
    expect(outboundCalls(fixtures).x402Payments).toBe(1);
    expect(journalEventsOf(router, a.paymentId).filter((event) => event === "source_settled")).toHaveLength(1);
  });

  test("昇格前の再試行: 動的 quote の verify が落ちた後、同じ credential で再試行できる（verify 2 回、settle 1 回）", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const quote = await dynamicQuote(router, PROFILES.solX402, "r1");
    const credential = await credentialFor(fixtures, quote);
    fixtures.svm.state.verifyOverride = () => ({ status: 200, body: { isValid: false, invalidReason: "fixture" } });
    expect(await purchase(router, quote, credential, "r1")).toMatchObject({ outcome: "payment_required", error: "verify_failed" });
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 1, settle: 0, supported: 1 });
    expect(await router.client().status(quote.paymentId, quote.ownerKey)).toMatchObject({ found: true, projection: { status: "awaiting_payment" } });
    fixtures.svm.state.verifyOverride = undefined;
    expect((await purchase(router, quote, credential, "r1")).outcome).toBe("delivered");
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 2, settle: 1, supported: 1 });
  });
});

/* ------------------------------------------------------------------ AC-4・FR-19 */

describe("AC-4: 決済の不確かさは耐久的な unknown。再起動後に settle が再発せず、両レグの予約が保たれる", () => {
  type Arrange = (fixtures: Fixtures) => void;
  const solSignature = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uKGMPv5bSDJQd6VaPjjeNn6fzRbLG3SLj5BF8LS";
  const svmRows: [string, Arrange][] = [
    ["応答の喪失（接続を切る）", (fx) => { fx.svm.state.dropSettle = true; }],
    ["network の違う成功応答", (fx) => { fx.svm.state.settleOverride = () => ({ status: 200, body: { success: true, transaction: solSignature, network: "solana:other" } }); }],
    ["識別子の無い成功応答", (fx) => { fx.svm.state.settleOverride = () => ({ status: 200, body: { success: true, network: SOL } }); }],
    ["識別子の形が違う成功応答（EVM の hash）", (fx) => { fx.svm.state.settleOverride = () => ({ status: 200, body: { success: true, transaction: `0x${"ab".repeat(32)}`, network: SOL } }); }],
    ["形の違う応答（壊れた JSON）", (fx) => { fx.svm.state.settleOverride = () => ({ raw: '{"success": true, "transaction": "' }); }],
  ];
  const circleRows: [string, Arrange][] = [
    ["応答の喪失（接続を切る）", (fx) => { fx.circle.state.settle = "drop"; }],
    ["network の違う成功応答", (fx) => { fx.circle.state.settle = "bad-network"; }],
    ["識別子の無い成功応答", (fx) => { fx.circle.state.settle = "no-tx"; }],
    ["識別子の形が違う成功応答", (fx) => { fx.circle.state.settle = "bad-tx"; }],
    ["形の違う応答（壊れた JSON）", (fx) => { fx.circle.state.settle = "malformed"; }],
  ];

  async function expectDurableUnknown(fixtures: Fixtures, source: "arc" | "sol", arrange: Arrange): Promise<void> {
    const dir = mkdtempSync(path.join(runtimeRoot, "t7c-unknown-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    // 区分の上限: 受信の区分は 1 件分、Base の区分は 1 件の送信レグ（1000）＋ 500 だけ。相手の network の区分は 2 件分（再起動の前後で 1 件ずつ通す）。
    const options: RouterOptions = { dir, keys, maxTotal: { arc: source === "arc" ? "10000" : "20000", sol: source === "sol" ? "10000" : "20000", base: "1500" } };
    let router = await startRouter(fixtures, options);
    const routeId = source === "arc" ? ROUTES.arcX402 : ROUTES.solX402;
    const quote = await staticQuote(router, routeId, "u");
    const credential = await credentialFor(fixtures, quote);
    arrange(fixtures);
    expect(await purchase(router, quote, credential, "u")).toEqual({ outcome: "unknown", paymentId: quote.paymentId, reason: "source_settle_unknown" });
    const settleOf = () => (source === "arc" ? inboundCalls(fixtures).circle.settle : inboundCalls(fixtures).svm.settle);
    expect(settleOf()).toBe(1);
    expect(outboundCalls(fixtures)).toEqual({ x402Payments: 0, mppSends: 0, mppCredentials: 0 });
    expect(journalEventsOf(router, quote.paymentId)).toEqual(["created", "source_pending", "budget_reserved", "unknown"]);
    // 再提出しても再 settle しない。
    expect(await purchase(router, quote, credential, "u")).toMatchObject({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(settleOf()).toBe(1);

    const expectReservationsKept = async (): Promise<void> => {
      // 受信の区分（Arc または Solana）は使い切り: 同じ network の別の route は verify まで進んで予約で止まる。settle 0。
      const k = `k-${Date.now()}`;
      const sameSource = await staticQuote(router, source === "arc" ? ROUTES.arcMpp : ROUTES.solMpp, k);
      const settleBefore = settleOf();
      expect(await purchase(router, sameSource, await credentialFor(fixtures, sameSource), k)).toMatchObject({ outcome: "rejected", error: "bucket_limit", status: 429 });
      expect(settleOf()).toBe(settleBefore);
      // 送信の区分（Base Sepolia USDC）も予約済み: Base 宛ての別の購入（1000）が 1500 を超える。
      const o = `o-${Date.now()}`;
      const other = await staticQuote(router, source === "arc" ? ROUTES.solX402 : ROUTES.arcX402, o);
      expect(await purchase(router, other, await credentialFor(fixtures, other), o)).toMatchObject({ outcome: "rejected", error: "bucket_limit", status: 429 });
      // 別の区分（相手の network → Tempo）は通る。
      const f = `f-${Date.now()}`;
      const free = await staticQuote(router, source === "arc" ? ROUTES.solMpp : ROUTES.arcMpp, f);
      expect((await purchase(router, free, await credentialFor(fixtures, free), f)).outcome).toBe("delivered");
    };
    // 不確かな応答の形はもう要らない（以後の settle は本物の応答）。
    fixtures.svm.state.dropSettle = false;
    fixtures.svm.state.settleOverride = undefined;
    fixtures.circle.state.settle = "ok";
    await expectReservationsKept();

    // 再起動後: unknown のまま、settle は再発せず、予約も復元されている。
    router = await restart(fixtures, router, options);
    expect(await router.client().status(quote.paymentId)).toMatchObject({ found: true, projection: { status: "unknown", terminalReason: "source_settle_unknown" } });
    expect(await purchase(router, quote, credential, "u")).toMatchObject({ outcome: "unknown", reason: "source_settle_unknown" });
    expect(settleOf()).toBe(1);
    expect(outboundCalls(fixtures).x402Payments).toBe(0);
    await expectReservationsKept();
    expect(journalEventsOf(router, quote.paymentId)).toEqual(["created", "source_pending", "budget_reserved", "unknown"]);
  }

  test.each(svmRows)("Solana: settle の %s → unknown", async (_name, arrange) => {
    await expectDurableUnknown(await startFixtures(), "sol", arrange);
  });

  test.each(circleRows)("Arc（Circle）: settle の %s → unknown", async (_name, arrange) => {
    await expectDurableUnknown(await startFixtures(), "arc", arrange);
  });

  test("settle の途中の crash（Solana）: 再起動後は interrupted_at_restart の unknown。再提出しても settle は 1 回のまま", async () => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t7c-crash-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    let router = await startRouter(fixtures, { dir, keys, maxTotal: { sol: "10000" } });
    const quote = await staticQuote(router, ROUTES.solX402, "c");
    const credential = await svmCredential(quote);
    // settle の応答を返さないうちに process が落ちたことにする（core を直接呼んで、HTTP の接続を残さない）。
    fixtures.svm.state.settleDelayMs = 20_000;
    const hung = router.core.purchase({ principalId: "judge", requestId: "c", quoteId: quote.quoteId, routeId: quote.routeId, approval: quote.quoteId, credential: decode(credential) as never });
    await until(() => fixtures.svm.seen.settleCalls === 1, "the settle request");
    await router.close();
    closers.splice(closers.indexOf(router.close), 1);
    void hung;
    fixtures.svm.state.settleDelayMs = 0;
    router = await startRouter(fixtures, { dir, keys, maxTotal: { sol: "10000" } });
    expect(await router.client().status(quote.paymentId)).toMatchObject({ found: true, projection: { status: "unknown", terminalReason: "interrupted_at_restart" } });
    expect(await purchase(router, quote, credential, "c")).toMatchObject({ outcome: "unknown", reason: "interrupted_at_restart" });
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 1, settle: 1, supported: 2 });
    expect(outboundCalls(fixtures).x402Payments).toBe(0);
    expect(journalEventsOf(router, quote.paymentId)).toEqual(["created", "source_pending", "budget_reserved", "unknown"]);
    // 予約は保たれている（同じ区分の次の購入は予約で止まる）。
    const next = await staticQuote(router, ROUTES.solMpp, "n");
    expect(await purchase(router, next, await svmCredential(next), "n")).toMatchObject({ outcome: "rejected", error: "bucket_limit", status: 429 });
    expect(inboundCalls(fixtures).svm.settle).toBe(1);
  });

  test("facilitator の fee payer が変わった後の process の再起動: 発行済みの quote の credential は preflight で落ち、facilitator に届かない", async () => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t7c-feepayer-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    let router = await startRouter(fixtures, { dir, keys });
    const quote = await staticQuote(router, ROUTES.solX402, "f");
    const credential = await svmCredential(quote);
    const oldFeePayer = fixtures.svm.feePayer;
    await router.close();
    closers.splice(closers.indexOf(router.close), 1);
    // facilitator が別の fee payer（別の鍵）になった。
    const replaced = await startSvmFacilitator(TLS, SOL, undefined, HOSTS.svm);
    closers.push(replaced.close);
    expect(replaced.feePayer).not.toBe(oldFeePayer);
    fixtures.svm = replaced;
    fixtures.ports.set(HOSTS.svm, replaced.port);
    router = await startRouter(fixtures, { dir, keys });
    expect(await purchase(router, quote, credential, "f")).toEqual({ outcome: "payment_required", error: "credential_mismatch", paymentId: quote.paymentId });
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 0, settle: 0, supported: 1 });
    expect(journalEventsOf(router, quote.paymentId)).toEqual(["created"]);
    // 新しい quote は新しい fee payer で通る。
    const fresh = await staticQuote(router, ROUTES.solX402, "g");
    expect(offerOf(fresh).extra["feePayer"]).toBe(replaced.feePayer);
    expect((await purchase(router, fresh, await svmCredential(fresh), "g")).outcome).toBe("delivered");
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 1, settle: 1, supported: 1 });
  });
});

/* ------------------------------------------------------------------ FR-5・FR-6 */

describe("FR-5・FR-6: 旧い journal・権威の欄の変更・予算の区分", () => {
  test("旧い journal（Base Sepolia・Tempo の記録）を新しい構成が読み、identity と予算を保ったまま新しい記録と混在する", async () => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t7c-legacy-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    // 旧い構成: Base Sepolia の静的 route と、Tempo で払う・Base で払う動的プロファイルだけ。
    let router = await startRouter(fixtures, { dir, keys, legacyOnly: true, maxPurchases: 4, dynamicMaxPurchases: 3 });
    const b1 = await staticQuote(router, ROUTES.base, "b1");
    expect((await purchase(router, b1, await credentialFor(fixtures, b1), "b1")).outcome).toBe("delivered");
    const d1 = await dynamicQuote(router, PROFILES.tempoX402, "d1");
    expect((await purchase(router, d1, await credentialFor(fixtures, d1), "d1")).outcome).toBe("delivered");
    const b2 = await staticQuote(router, ROUTES.base, "b2");
    const d2 = await dynamicQuote(router, PROFILES.baseMpp, "d2");
    expect(inboundCalls(fixtures).legacy).toEqual({ verify: 1, settle: 1 });

    // 新しい構成で起動し直す（同じ journal）。
    router = await restart(fixtures, router, { dir, keys, maxPurchases: 4, dynamicMaxPurchases: 3 });
    // 旧い記録の identity: 同じ paymentId で読める。動的は ownerKey が要る。
    expect(await router.client().status(b1.paymentId)).toMatchObject({ found: true, projection: { paymentId: b1.paymentId, status: "delivered" } });
    expect(await router.client().status(d1.paymentId)).toMatchObject({ found: false, status: 404 });
    expect(await router.client().status(d1.paymentId, d1.ownerKey)).toMatchObject({ found: true, projection: { paymentId: d1.paymentId, status: "delivered", dynamic: { promoted: true } } });
    // 控えの quote（旧い構成で発行）は新しい構成でも買える。
    expect((await purchase(router, b2, await credentialFor(fixtures, b2), "b2")).outcome).toBe("delivered");
    expect((await purchase(router, d2, await credentialFor(fixtures, d2), "d2")).outcome).toBe("delivered");
    // 新しい route・プロファイルの購入が旧い記録と混在する。
    const a = await staticQuote(router, ROUTES.arcX402, "a");
    expect((await purchase(router, a, await credentialFor(fixtures, a), "a")).outcome).toBe("delivered");
    const s = await staticQuote(router, ROUTES.solX402, "s");
    expect((await purchase(router, s, await credentialFor(fixtures, s), "s")).outcome).toBe("delivered");
    const ds = await dynamicQuote(router, PROFILES.solX402, "ds");
    expect((await purchase(router, ds, await credentialFor(fixtures, ds), "ds")).outcome).toBe("delivered");
    // 件数の予算は旧い記録を数えている: 静的 4 件（b1・b2・a・s）、動的 3 件（d1・d2・ds）で満杯。
    const over = await staticQuote(router, ROUTES.arcMpp, "over");
    expect(await purchase(router, over, await credentialFor(fixtures, over), "over")).toMatchObject({ outcome: "rejected", error: "purchase_count_limit", status: 429 });
    const dynOver = await dynamicQuote(router, PROFILES.arcX402, "dyn-over");
    expect(await purchase(router, dynOver, await credentialFor(fixtures, dynOver), "dyn-over")).toMatchObject({ outcome: "rejected", error: "purchase_count_limit", status: 429 });
    const calls = inboundCalls(fixtures);
    expect(calls.circle).toEqual({ verify: 3, settle: 1 });
    expect(calls.svm).toEqual({ verify: 2, settle: 2, supported: 1 });
    // Base Sepolia の facilitator: b1・b2 と、Base で払う動的 d2。
    expect(calls.legacy).toEqual({ verify: 3, settle: 3 });
    // 旧い記録は書き換わっていない。
    expect(journalEventsOf(router, b1.paymentId).at(-1)).toBe("delivered");
    expect(journalEventsOf(router, d1.paymentId).at(-1)).toBe("delivered");
  });

  test("権威の欄（route の source の資産）を変えた再起動: 発行済みの quote は quote_changed で止まり、facilitator に届かない", async () => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t7c-authority-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    let router = await startRouter(fixtures, { dir, keys });
    const quote = await staticQuote(router, ROUTES.arcX402, "q");
    const credential = await credentialFor(fixtures, quote);
    router = await restart(fixtures, router, { dir, keys, arcSourceAsset: SHARED_ASSET });
    expect(await purchase(router, quote, credential, "q")).toMatchObject({ outcome: "payment_required", error: "quote_changed" });
    expect(inboundCalls(fixtures).circle).toEqual({ verify: 0, settle: 0 });
    expect(router.notes).toContain("route configuration mismatch (routeId=arc-x402, why=route configuration changed)");
    expect(journalEventsOf(router, quote.paymentId)).toEqual(["created"]);
    // 新しい quote は新しい資産で出て、通る。
    const fresh = await staticQuote(router, ROUTES.arcX402, "q2");
    expect(offerOf(fresh).asset).toBe(SHARED_ASSET);
    expect((await purchase(router, fresh, await credentialFor(fixtures, fresh), "q2")).outcome).toBe("delivered");
  });

  test("予算の通算は再起動で復元される（Solana の区分 20000 = 2 件。再起動をまたいで 3 件目は bucket_limit）", async () => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t7c-budget-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    const options: RouterOptions = { dir, keys, maxTotal: { sol: "20000" } };
    let router = await startRouter(fixtures, options);
    const first = await staticQuote(router, ROUTES.solX402, "1");
    expect((await purchase(router, first, await svmCredential(first), "1")).outcome).toBe("delivered");
    router = await restart(fixtures, router, options);
    const second = await staticQuote(router, ROUTES.solMpp, "2");
    expect((await purchase(router, second, await svmCredential(second), "2")).outcome).toBe("delivered");
    const third = await staticQuote(router, ROUTES.solX402, "3");
    expect(await purchase(router, third, await svmCredential(third), "3")).toMatchObject({ outcome: "rejected", error: "bucket_limit", status: 429 });
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 3, settle: 2, supported: 2 });
    // 動的の予算も同じ（別の通算）: Solana の区分は 20000 で、動的 quote は 2000 ずつ。静的の消費は動的の通算に混ざらない。
    const dyn = await dynamicQuote(router, PROFILES.solX402, "d");
    expect((await purchase(router, dyn, await credentialFor(fixtures, dyn), "d")).outcome).toBe("delivered");
  });

  test("(network, asset) の区分は別: 同じ資産 id でも Arc の消費は Base Sepolia の区分を減らさない（逆も）", async () => {
    const fixtures = await startFixtures();
    // 同じ資産 id が Arc と Base Sepolia の両方にある。各 network の区分は 1 件分。
    const router = await startRouter(fixtures, { arcSourceAsset: SHARED_ASSET, baseSourceAsset: SHARED_ASSET, maxTotal: { arcAlt: "10000", baseAlt: "10000" } });
    const arc = await staticQuote(router, ROUTES.arcX402, "arc");
    expect(offerOf(arc).asset).toBe(SHARED_ASSET);
    expect((await purchase(router, arc, await credentialFor(fixtures, arc), "arc")).outcome).toBe("delivered");
    // Base Sepolia の区分（同じ資産 id）は丸ごと残っている。
    const base = await staticQuote(router, ROUTES.base, "base");
    expect(offerOf(base).asset).toBe(SHARED_ASSET);
    expect((await purchase(router, base, await credentialFor(fixtures, base), "base")).outcome).toBe("delivered");
    // それぞれの区分は使い切り（verify まで進み、予約で止まる。settle は増えない）。
    const arcAgain = await staticQuote(router, ROUTES.arcX402, "arc2");
    expect(await purchase(router, arcAgain, await credentialFor(fixtures, arcAgain), "arc2")).toMatchObject({ outcome: "rejected", error: "bucket_limit", status: 429 });
    const baseAgain = await staticQuote(router, ROUTES.base, "base2");
    expect(await purchase(router, baseAgain, await credentialFor(fixtures, baseAgain), "base2")).toMatchObject({ outcome: "rejected", error: "bucket_limit", status: 429 });
    expect(inboundCalls(fixtures).circle).toEqual({ verify: 2, settle: 1 });
    expect(inboundCalls(fixtures).legacy).toEqual({ verify: 2, settle: 1 });
    expect(outboundCalls(fixtures).x402Payments).toBe(2);
  });
});

/* ------------------------------------------------------------------ AC-6 */

describe("AC-6: 動的 quote の ownerKey の保護と結果の再読取は新しいレールでも既存どおり", () => {
  test("Solana の動的 quote: ownerKey 無しの status は 404、ありなら delivered の射影。再起動後も同じ", async () => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t7c-owner-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    let router = await startRouter(fixtures, { dir, keys });
    const quote = await dynamicQuote(router, PROFILES.solX402, "o");
    expect(quote.ownerKey).toBeDefined();
    const credential = await credentialFor(fixtures, quote);
    expect((await purchase(router, quote, credential, "o")).outcome).toBe("delivered");
    const { ownerKey: _dropped, ...noKey } = quote;
    const expectProtected = async (): Promise<void> => {
      expect(await router.client().status(quote.paymentId)).toMatchObject({ found: false, status: 404 });
      expect(await router.client().status(quote.paymentId, "not-the-key")).toMatchObject({ found: false, status: 404 });
      expect(await router.client().status(quote.paymentId, quote.ownerKey)).toMatchObject({ found: true, projection: { status: "delivered", dynamic: { promoted: true } } });
      expect(await purchase(router, noKey as QuoteView, credential, "o")).toMatchObject({ outcome: "rejected", error: "unknown_quote", status: 404 });
      expect((await purchase(router, quote, credential, "o")).outcome).toBe("delivered");
    };
    await expectProtected();
    router = await restart(fixtures, router, { dir, keys });
    await expectProtected();
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 1, settle: 1, supported: 2 });
    expect(outboundCalls(fixtures).x402Payments).toBe(1);
  });
});

/* ------------------------------------------------------------------ T11: settle の応答の後の期限つきの追跡（設計 §5.8、D-9） */

describe("T11: Solana の settle が settlement_pending（署名つき）でも、追跡で確定すれば delivered", () => {
  test.each([
    ["静的", "static", ROUTES.solX402],
    ["動的", "dynamic", PROFILES.solX402],
  ] as const)("%s: confirm の timeout → RPC の列 [null, confirmed] → delivered。journal は source_settled を経る。追跡は設定の RPC（起動時と同じ transport）へ、診断 1 回。再起動後の再提出は既存の結果", async (_name, kind, id) => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t11-followup-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    let router = await startRouter(fixtures, { dir, keys });
    fixtures.svm.state.confirm = "timeout";
    fixtures.solRpc.state.signatureStatuses = ["null", "confirmed"];
    const quote = kind === "static" ? await staticQuote(router, id, "f") : await dynamicQuote(router, id, "f");
    const credential = await credentialFor(fixtures, quote);
    const dialedBefore = fixtures.dialed.length;
    const result = await purchase(router, quote, credential, "f");
    expect(result.outcome).toBe("delivered");
    // facilitator は settlement_pending と署名を返した。Router は追跡で settled にした（settle は 1 回、再 settle 無し）。
    expect((fixtures.svm.seen.lastSettle as { success: boolean; errorReason: string }).success).toBe(false);
    expect((fixtures.svm.seen.lastSettle as { errorReason: string }).errorReason).toBe("settlement_pending");
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 1, settle: 1, supported: 1 });
    const polls = fixtures.solRpc.calls.filter((c) => c.method === "getSignatureStatuses");
    expect(polls).toHaveLength(2);
    // 起動時の RPC（受信の ATA 1・送信の静的の宛先 ATA 1）の後は追跡の 2 回だけ。
    expect(router.rpcCallsAtStart).toBe(5); // 起動時の ATA の読み（x402 受信 1・tempo-sol 1・MPP Solana 受信 1・base-solmpp/tempo-solmpp 2）
    expect(fixtures.solRpc.calls.slice(router.rpcCallsAtStart).map((c) => c.method)).toEqual(["getSignatureStatuses", "getSignatureStatuses"]);
    expect(fixtures.dialed.slice(dialedBefore)).toContain(HOSTS.solRpc);
    expect(router.notes.filter((n) => n.includes("svm_settle_followed_up"))).toEqual([`router: facilitator diagnostic svm_settle_followed_up (${kind === "static" ? `routes.${id}` : `dynamic.profiles.${id}`})`]);
    const signature = String((fixtures.svm.seen.lastSettle as { transaction: string }).transaction);
    const status = await router.client().status(quote.paymentId, quote.ownerKey);
    expect(status).toMatchObject({ found: true, projection: { status: "delivered", source: { txRef: signature } } });
    const events = journalEventsOf(router, quote.paymentId);
    expect(events).toContain("source_settled");
    expect(events.at(-1)).toBe("delivered");
    expect(outboundCalls(fixtures).x402Payments).toBe(1);
    // 再起動後: 既存の結果。settle も追跡も増えない。
    router = await restart(fixtures, router, { dir, keys });
    expect((await purchase(router, quote, credential, "f")).outcome).toBe("delivered");
    expect(inboundCalls(fixtures).svm.settle).toBe(1);
    expect(fixtures.solRpc.calls.filter((c) => c.method === "getSignatureStatuses")).toHaveLength(2);
    expect(outboundCalls(fixtures).x402Payments).toBe(1);
  });

  test("追跡の途中の再起動（Solana 静的）: 再起動後は interrupted_at_restart の unknown。settle は 1 回のまま、送信 0、予約は保たれる。旧い処理は観測して終わらせる", async () => {
    const fixtures = await startFixtures();
    const dir = mkdtempSync(path.join(runtimeRoot, "t11-crash-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    const keys = { x402: generatePrivateKey(), mpp: generatePrivateKey() };
    let router = await startRouter(fixtures, { dir, keys, maxTotal: { sol: "10000" } });
    fixtures.svm.state.confirm = "timeout";
    // 追跡の最初の RPC が答える前に process が落ちたことにする（core を直接呼び、HTTP の接続を残さない）。
    // 順序を固定する: RPC の応答は barrier で止め、要求を観測 → Router を閉じる → 応答（`err`）を放す → 旧い処理が 1 回で打ち切り、閉じた journal への書き込みで終わるのを待つ。
    fixtures.solRpc.state.signatureStatuses = ["err"];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fixtures.solRpc.state.gate = () => gate;
    const quote = await staticQuote(router, ROUTES.solX402, "c");
    const credential = await svmCredential(quote);
    const hung = router.core.purchase({ principalId: "judge", requestId: "c", quoteId: quote.quoteId, routeId: quote.routeId, approval: quote.quoteId, credential: decode(credential) as never });
    await until(() => fixtures.solRpc.calls.some((c) => c.method === "getSignatureStatuses"), "the follow-up request");
    await router.close();
    closers.splice(closers.indexOf(router.close), 1);
    release();
    // 旧い処理は終わった: 閉じた journal には書けないので失敗する（settled・delivered にはならない）。追跡の要求は 1 回だけ。
    const old = await hung.then((r) => ({ kind: "resolved" as const, status: r.status }), () => ({ kind: "rejected" as const, status: undefined }));
    expect(old).not.toMatchObject({ status: "delivered" });
    expect(old.kind === "rejected" || old.status === "unknown").toBe(true);
    const pollsBeforeRestart = fixtures.solRpc.calls.filter((c) => c.method === "getSignatureStatuses").length;
    expect(pollsBeforeRestart).toBe(1);
    fixtures.solRpc.state.gate = undefined;
    fixtures.solRpc.state.signatureStatuses = ["confirmed"];
    router = await startRouter(fixtures, { dir, keys, maxTotal: { sol: "10000" } });
    expect(await router.client().status(quote.paymentId)).toMatchObject({ found: true, projection: { status: "unknown", terminalReason: "interrupted_at_restart" } });
    expect(await purchase(router, quote, credential, "c")).toMatchObject({ outcome: "unknown", reason: "interrupted_at_restart" });
    expect(inboundCalls(fixtures).svm).toEqual({ verify: 1, settle: 1, supported: 2 });
    expect(outboundCalls(fixtures).x402Payments).toBe(0);
    // 再起動後に追跡の要求は増えない（再 settle も追跡の再開も無い）。
    expect(fixtures.solRpc.calls.filter((c) => c.method === "getSignatureStatuses")).toHaveLength(pollsBeforeRestart);
    // 予約は保たれている（同じ区分の次の購入は予約で止まる）。
    const next = await staticQuote(router, ROUTES.solMpp, "n");
    expect(await purchase(router, next, await svmCredential(next), "n")).toMatchObject({ outcome: "rejected", error: "bucket_limit", status: 429 });
    expect(inboundCalls(fixtures).svm.settle).toBe(1);
  });
});

/* ------------------------------------------------------------------ 送信（U8-a）: 公開する組 D-12 */

describe("送信: 公開する組（静的 O-1 Base → Arc・O-4 Tempo → Solana、動的 O-1〜O-6）が delivered。能力は evmSigningByNetwork[ARC]・svmSigning[SOL]", () => {
  const matrix: [string, "static" | "dynamic", string, "base" | "tempo" | "arc" | "sol", "arc" | "sol"][] = [
    ["Base → Arc（静的 O-1）", "static", ROUTES.baseArc, "base", "arc"],
    ["Tempo → Solana（静的 O-4）", "static", ROUTES.tempoSol, "tempo", "sol"],
    ["Base → Arc（動的 O-1）", "dynamic", PROFILES.x402Arc, "base", "arc"],
    ["Tempo → Arc（動的 O-2）", "dynamic", PROFILES.mppArc, "tempo", "arc"],
    ["Base → Solana（動的 O-3）", "dynamic", PROFILES.x402Sol, "base", "sol"],
    ["Tempo → Solana（動的 O-4）", "dynamic", PROFILES.mppSol, "tempo", "sol"],
    // O-5・O-6（送信の要件 §11 AC-19）: 受信は Arc（Circle）／Solana（x402.org の形の svm fixture）、送信はもう一方の Worker の fixture。
    ["Arc → Solana（動的 O-5）", "dynamic", PROFILES.arcSol, "arc", "sol"],
    ["Solana → Arc（動的 O-6）", "dynamic", PROFILES.solArc, "sol", "arc"],
  ];
  test.each(matrix)("%s: delivered。送信は該当の Provider に 1 回、Solana は署名 1 回で facilitator の verify を通る", async (_name, kind, id, source, destination) => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const signsBefore = solSigner.signCount();
    const quote = kind === "static" ? await staticQuote(router, id, "o1") : await dynamicQuote(router, id, "o1");
    const offer = offerOf(quote);
    expect(offer.network).toBe(source === "base" ? BASE : source === "tempo" ? TEMPO : source === "arc" ? ARC : SOL);
    const result = await purchase(router, quote, await credentialFor(fixtures, quote), "o1");
    expect(result).toMatchObject({ outcome: "delivered", snapshot: destination === "arc" ? { price: 2 } : { ok: true, source: "svm-provider" } });
    const calls = inboundCalls(fixtures);
    // 受信の facilitator は source で決まる（Base は legacy、Arc は Circle、Solana は svm）。svm の verify・settle は Solana 受信（O-6）か Solana 送信（Provider の fixture が svm に verify・settle する）のどちらかで 1。
    expect(calls.circle).toEqual(source === "arc" ? { verify: 1, settle: 1 } : { verify: 0, settle: 0 });
    expect(calls.legacy).toEqual(source === "base" ? { verify: 1, settle: 1 } : { verify: 0, settle: 0 });
    expect(calls.svm).toEqual(source === "sol" || destination === "sol" ? { verify: 1, settle: 1, supported: 1 } : { verify: 0, settle: 0, supported: 1 });
    if (source === "arc") expect(fixtures.circle.seen.proofFailures).toEqual([]);
    // Tempo 受信は呼び出し側が fixture の RPC に送金する（mppSends 1）。送信の MPP は無い。
    expect(outboundCalls(fixtures)).toEqual({ x402Payments: 0, mppSends: source === "tempo" ? 1 : 0, mppCredentials: 0 });
    expect(providerPayments(fixtures)).toEqual(destination === "arc" ? { arcPayments: 1, solPayments: 0 } : { arcPayments: 0, solPayments: 1 });
    expect(solSigner.signCount() - signsBefore).toBe(destination === "sol" ? 1 : 0);
    if (destination === "sol") {
      // Solana の送信の RPC: 残高 1（静的・動的とも D-15）＋ pay の ATA 1・blockhash 1（動的は quote と pay の読み直しの候補の ATA 1 ずつ）。
      const methods = fixtures.solRpc.calls.slice(router.rpcCallsAtStart).map((c) => c.method);
      expect(methods.filter((m) => m === "getTokenAccountBalance")).toHaveLength(1);
      expect(methods.filter((m) => m === "getLatestBlockhash")).toHaveLength(1);
      // 動的: quote の候補 1 ＋ purchase の読み直し 2 回（受信の前と deliver）＋ pay の 3 の再確認 1（設計 §4.3）。静的: pay の 1 だけ。
      expect(methods.filter((m) => m === "getAccountInfo")).toHaveLength(kind === "static" ? 1 : 4);
      expect(new Set(methods)).toEqual(new Set(["getTokenAccountBalance", "getLatestBlockhash", "getAccountInfo"]));
      expect(fixtures.solProvider.seen.paid[0]!.transactionBase64).toBeDefined();
    } else {
      expect(solRpcCallsSince(fixtures, router)).toBe(0);
    }
    // 接続先: 受信（Base は legacy の facilitator、Tempo は tempoRpc、Arc は Circle、Solana は svm）と送信（Provider。Solana は RPC も）。
    const sourceHost = source === "base" ? HOSTS.legacy : source === "tempo" ? HOSTS.tempoRpc : source === "arc" ? HOSTS.circle : HOSTS.svm;
    const expected = new Set<string>([sourceHost, destination === "arc" ? HOSTS.arcProvider : HOSTS.solProvider, ...(destination === "sol" ? [HOSTS.solRpc] : [])]);
    expect(new Set(fixtures.dialed)).toEqual(expected);
    const status = await router.client().status(quote.paymentId, quote.ownerKey);
    expect(status).toMatchObject({ found: true, projection: { status: "delivered" } });
    if (destination === "sol") expect(journalEventsOf(router, quote.paymentId)).toContain("destination_message_reserved");
    expect(journalEventsOf(router, quote.paymentId).at(-1)).toBe("delivered");
  });

  test("startup 前の pay・readChallenge・balanceOf は統合（composeRails の rails）でも throw", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const rails = composeRails(router.config, { evmSigning: createRealEvmCapability(generatePrivateKey()).capability(BASE), evmSigningByNetwork: { [ARC]: createRealEvmCapability(generatePrivateKey()).capability(ARC) }, svmSigning: { [SOL]: solSigner.capability(SOL) }, mppTempo: createRealMppCapability(generatePrivateKey(), { rpcUrl: `https://${HOSTS.tempoRpc}` }).capability(), sellerProofs: { [ARC]: proof.capability }, knownNetworksForTest: TEST_NETWORKS, dependencyUrls: [`https://${HOSTS.tempoRpc}/`], dynamicTransportHooksForTest: hooksOf(fixtures), transportHooksForTest: hooksOf(fixtures) }, () => {}, () => {});
    await expect(rails.outbound.readChallenge(ROUTES.tempoSol)).rejects.toThrow(/startup\(\) has not completed/);
    await expect(rails.outbound.pay({ routeId: ROUTES.tempoSol, offer: { scheme: "exact", network: SOL, asset: MINT, amount: "1", payTo: solProvider }, paymentId: "p", attempt: 1, deadlineMs: Date.now() + 60_000 })).rejects.toThrow(/startup\(\) has not completed/);
    await expect(rails.balanceOf!(ROUTES.tempoSol, MINT)).rejects.toThrow(/startup\(\) has not completed/);
  });
});

describe("送信: 残高の hook（D-15。Solana の実配線）", () => {
  test("静的: Router の ATA の残高が額より少ない → awaiting_payment operator_funds_unavailable、受信の verify 0・署名 0。RPC が落ちていても同じ。足りれば delivered", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const signsBefore = solSigner.signCount();
    const quote = await staticQuote(router, ROUTES.tempoSol, "b1");
    const credential = await credentialFor(fixtures, quote);
    const tempoRequestsAfterCredential = fixtures.tempoRpc.http.requests;
    fixtures.solRpc.state.atas = fixtures.solRpc.state.atas.map((a) => (a.address === solRouterAta ? { ...a, amount: "9999" } : a));
    const short = await purchase(router, quote, credential, "b1");
    // Router は awaiting_payment / operator_funds_unavailable（journal は source_failed、source_pending 無し。受信の verify は呼ばれない）。
    expect(await router.client().status(quote.paymentId, quote.ownerKey)).toMatchObject({ found: true, projection: { status: "awaiting_payment" } });
    expect(journalEventsOf(router, quote.paymentId)).toEqual(["created", "source_failed"]);
    expect(readFileSync(router.journalPath, "utf8")).toContain("\"operator_funds_unavailable\"");
    expect(short.outcome).not.toBe("delivered");
    expect(solSigner.signCount() - signsBefore).toBe(0);
    expect(fixtures.solProvider.seen.paid).toHaveLength(0);
    // 受信は Tempo の MPP: verify は chain の読取なので、credential の後に Tempo RPC への要求が増えていないことが「verify 前に止めた」証拠。
    expect(fixtures.tempoRpc.http.requests).toBe(tempoRequestsAfterCredential);
    // RPC が落ちていても同じ（throw は不足と同じ扱い）: 届かず、署名 0。
    fixtures.solRpc.state.reply = "rpc-error";
    expect((await purchase(router, quote, credential, "b1")).outcome).not.toBe("delivered");
    expect(solSigner.signCount() - signsBefore).toBe(0);
    expect(journalEventsOf(router, quote.paymentId)).not.toContain("source_pending");
    fixtures.solRpc.state.reply = "ok";
    // 足りれば届く（新しい quote と credential。MPP 受信の credential は 1 回の送金に結びつく）。
    fixtures.solRpc.state.atas = fixtures.solRpc.state.atas.map((a) => (a.address === solRouterAta ? { ...a, amount: "10000" } : a));
    const enough = await staticQuote(router, ROUTES.tempoSol, "b1b");
    expect(await purchase(router, enough, await credentialFor(fixtures, enough), "b1b")).toMatchObject({ outcome: "delivered" });
    expect(solSigner.signCount() - signsBefore).toBe(1);
  });

  test("動的: 残高不足 → awaiting_payment operator_funds_unavailable（既存の動的の挙動が SVM の rail の balanceOf に繋がる）", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures);
    const signsBefore = solSigner.signCount();
    const quote = await dynamicQuote(router, PROFILES.x402Sol, "b2");
    const credential = await credentialFor(fixtures, quote);
    fixtures.solRpc.state.atas = fixtures.solRpc.state.atas.map((a) => (a.address === solRouterAta ? { ...a, amount: "1" } : a));
    const short = await purchase(router, quote, credential, "b2");
    expect(short.outcome).not.toBe("delivered");
    // 動的は昇格前なので journal には無い（台帳の quote だけ）。状態の射影で見る。
    expect(await router.client().status(quote.paymentId, quote.ownerKey)).toMatchObject({ found: true, projection: { status: "awaiting_payment" } });
    expect(solSigner.signCount() - signsBefore).toBe(0);
    expect(fixtures.solProvider.seen.paid).toHaveLength(0);
    // 受信（Base の x402）の verify・settle は呼ばれていない。
    expect(inboundCalls(fixtures).legacy).toEqual({ verify: 0, settle: 0 });
    // 残高の RPC だけが落ちる（他の method は答える）→ 同じく operator_funds_unavailable。
    fixtures.solRpc.state.atas = fixtures.solRpc.state.atas.map((a) => (a.address === solRouterAta ? { ...a, amount: "1000000" } : a));
    fixtures.solRpc.state.failMethods = ["getTokenAccountBalance"];
    const quote2 = await dynamicQuote(router, PROFILES.x402Sol, "b3");
    expect((await purchase(router, quote2, await credentialFor(fixtures, quote2), "b3")).outcome).not.toBe("delivered");
    expect(await router.client().status(quote2.paymentId, quote2.ownerKey)).toMatchObject({ found: true, projection: { status: "awaiting_payment" } });
    expect(inboundCalls(fixtures).legacy).toEqual({ verify: 0, settle: 0 });
    expect(solSigner.signCount() - signsBefore).toBe(0);
    expect(fixtures.solProvider.seen.paid).toHaveLength(0);
    // 復旧すれば届く。
    fixtures.solRpc.state.failMethods = [];
    const quote3 = await dynamicQuote(router, PROFILES.x402Sol, "b4");
    expect(await purchase(router, quote3, await credentialFor(fixtures, quote3), "b4")).toMatchObject({ outcome: "delivered" });
    expect(solSigner.signCount() - signsBefore).toBe(1);
  });
});

describe("送信: 予算（FR-29・D-14）。受信と送信は同じ (network, asset) の区分に合算、静的と動的は別の台帳、区分の無い組は bucket_not_allowed", () => {
  test("Solana USDC の区分 20,000: Solana 受信の購入（10,000）と Solana 送信の購入（10,000）が順に同じ区分を使い、3 件目は bucket_limit", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures, { maxTotal: { sol: "20000" } });
    const signsBefore = solSigner.signCount();
    const inboundQuote = await staticQuote(router, ROUTES.solX402, "g1");
    expect(await purchase(router, inboundQuote, await credentialFor(fixtures, inboundQuote), "g1")).toMatchObject({ outcome: "delivered" });
    const outboundQuote = await staticQuote(router, ROUTES.tempoSol, "g2");
    expect(await purchase(router, outboundQuote, await credentialFor(fixtures, outboundQuote), "g2")).toMatchObject({ outcome: "delivered" });
    // 3 件目は購入で区分の上限（どちらの向きでも）。受信の verify は呼ばれるが settle は無い（既存の予算の試験と同じ）。
    // Tempo の受信は push（credential の時点で payer が送金済み = `fundsMoveOnCredential`）: verify の後に予約が通らない失敗は未払いの公言（bucket_limit）にせず、
    // 耐久的な unknown（source_paid_unsettled）。x402 の受信（g4）はまだ資金が動いていないので bucket_limit のまま。
    const q3 = await staticQuote(router, ROUTES.tempoSol, "g3");
    expect(await purchase(router, q3, await credentialFor(fixtures, q3), "g3")).toMatchObject({ outcome: "unknown", reason: "source_paid_unsettled" });
    const q4 = await staticQuote(router, ROUTES.solX402, "g4");
    expect(await purchase(router, q4, await credentialFor(fixtures, q4), "g4")).toMatchObject({ outcome: "rejected", error: "bucket_limit", status: 429 });
    expect(fixtures.solProvider.seen.paid).toHaveLength(1);
    expect(solSigner.signCount() - signsBefore).toBe(1);
  });

  test("Arc USDC の区分 11,000: Arc 受信の購入（arc-x402、源 10,000）と Arc 送信の購入（base-arc、宛先 1,000 = Provider の offer）が順に同じ区分を使い、3 件目は bucket_limit（D-14。受信→送信の構成そのものは範囲外）", async () => {
    const fixtures = await startFixtures();
    // 合算 10,000 + 1,000 = 11,000 ちょうど。3 件目はどちらの向き（+1,000 / +10,000）でも超える。
    const router = await startRouter(fixtures, { maxTotal: { arc: "11000" } });
    const inboundQuote = await staticQuote(router, ROUTES.arcX402, "a1");
    expect(await purchase(router, inboundQuote, await credentialFor(fixtures, inboundQuote), "a1")).toMatchObject({ outcome: "delivered" });
    const outboundQuote = await staticQuote(router, ROUTES.baseArc, "a2");
    expect(await purchase(router, outboundQuote, await credentialFor(fixtures, outboundQuote), "a2")).toMatchObject({ outcome: "delivered" });
    expect(providerPayments(fixtures).arcPayments).toBe(1);
    const q3 = await staticQuote(router, ROUTES.baseArc, "a3");
    expect(await purchase(router, q3, await credentialFor(fixtures, q3), "a3")).toMatchObject({ outcome: "rejected", error: "bucket_limit", status: 429 });
    const q4 = await staticQuote(router, ROUTES.arcX402, "a4");
    expect(await purchase(router, q4, await credentialFor(fixtures, q4), "a4")).toMatchObject({ outcome: "rejected", error: "bucket_limit", status: 429 });
    expect(providerPayments(fixtures).arcPayments).toBe(1);
  });

  test("動的の台帳でも合算: Solana 受信の動的（dyn-sol-to-x402、源 2,000）と Solana 送信の動的（dyn-x402-to-sol、宛先 10,000）が同じ区分（上限 12,000）を使い、3 件目は不成立", async () => {
    const fixtures = await startFixtures();
    // dyn-sol-to-x402 の源は上流 1,000 ＋ 手数料 1,000 = 2,000（Solana USDC）。送信の dyn-x402-to-sol の宛先は 10,000。合計 12,000 を上限に。
    const router = await startRouter(fixtures, { dynamicMaxTotal: { sol: "12000" } });
    const d1 = await dynamicQuote(router, PROFILES.solX402, "e1");
    expect(offerOf(d1).amount).toBe("2000");
    expect(await purchase(router, d1, await credentialFor(fixtures, d1), "e1")).toMatchObject({ outcome: "delivered" });
    const d2 = await dynamicQuote(router, PROFILES.x402Sol, "e2");
    expect(await purchase(router, d2, await credentialFor(fixtures, d2), "e2")).toMatchObject({ outcome: "delivered" });
    expect(providerPayments(fixtures).solPayments).toBe(1);
    // 3 件目（どちらの向きでも）は購入で通算の上限（動的の予算は購入の予約で見る）。
    const d3 = await dynamicQuote(router, PROFILES.x402Sol, "e3");
    expect(await purchase(router, d3, await credentialFor(fixtures, d3), "e3")).toMatchObject({ outcome: "rejected", error: "bucket_limit" });
    const d4 = await dynamicQuote(router, PROFILES.solX402, "e4");
    expect(await purchase(router, d4, await credentialFor(fixtures, d4), "e4")).toMatchObject({ outcome: "rejected", error: "bucket_limit" });
    expect(providerPayments(fixtures).solPayments).toBe(1);
  });

  test("静的と動的は別の台帳: 静的の Solana の区分を使い切っても動的の Solana 送信は通る", async () => {
    const fixtures = await startFixtures();
    const router = await startRouter(fixtures, { maxTotal: { sol: "10000" } });
    const q1 = await staticQuote(router, ROUTES.tempoSol, "h1");
    expect(await purchase(router, q1, await credentialFor(fixtures, q1), "h1")).toMatchObject({ outcome: "delivered" });
    const q2 = await staticQuote(router, ROUTES.tempoSol, "h2");
    // Tempo の受信は push: 予約の失敗は unknown（source_paid_unsettled）。予約は取られていないので動的の送信（h3）は通る。
    expect(await purchase(router, q2, await credentialFor(fixtures, q2), "h2")).toMatchObject({ outcome: "unknown", reason: "source_paid_unsettled" });
    const q3 = await dynamicQuote(router, PROFILES.x402Sol, "h3");
    expect(await purchase(router, q3, await credentialFor(fixtures, q3), "h3")).toMatchObject({ outcome: "delivered" });
  });

  test("D-14 の 1 件の上限: 静的は上限 9,999 で購入が per_purchase_limit、10,000 ちょうどで届く。動的は profile の上限を広げても区分の上限 20,000 で止まり、20,000 ちょうどは届く", async () => {
    const fixtures = await startFixtures();
    // 静的: Solana の区分の 1 件の上限を 9,999 に。tempo-sol の送信の 10,000 が超える → purchase で per_purchase_limit。
    let router = await startRouter(fixtures, { solMaxPerPurchase: "9999" });
    const q1 = await staticQuote(router, ROUTES.tempoSol, "i0");
    // Tempo の受信は push: verify の後の予約の失敗（1 件の上限）は unknown（source_paid_unsettled）。送信は始まらない。
    expect(await purchase(router, q1, await credentialFor(fixtures, q1), "i0")).toMatchObject({ outcome: "unknown", reason: "source_paid_unsettled" });
    expect(fixtures.solProvider.seen.paid).toHaveLength(0);
    await router.close();
    closers.splice(closers.indexOf(router.close), 1);
    // 境界: 10,000 ちょうどは届く。
    router = await startRouter(fixtures, { solMaxPerPurchase: "10000" });
    const q2 = await staticQuote(router, ROUTES.tempoSol, "i0b");
    expect(await purchase(router, q2, await credentialFor(fixtures, q2), "i0b")).toMatchObject({ outcome: "delivered" });
    await router.close();
    closers.splice(closers.indexOf(router.close), 1);
    // 動的: Solana の区分の 1 件の上限は既定の 20,000、profile の上限は 30,000 なので 20,001 は profile を通る。源（Base USDC = 上流 + 手数料 1,000）の区分の上限は
    // 30,000 に広げて先に当たらないようにする。止めるのは宛先の区分の上限（動的は quote の段で見る: dynamic.ts）。
    router = await startRouter(fixtures, { solMaxUpstream: "30000", oldMaxPerPurchase: "30000" });
    fixtures.solProvider.state.amount = "20001";
    expect(await router.client().quoteUrl({ profileId: PROFILES.x402Sol, url: SOL_URL, requestId: "i1" })).toMatchObject({ ok: false });
    // 境界: 20,000 ちょうどは quote も購入も通る（Router の ATA の残高は 1,000,000）。
    fixtures.solProvider.state.amount = "20000";
    const q3 = await dynamicQuote(router, PROFILES.x402Sol, "i1b");
    expect(await purchase(router, q3, await credentialFor(fixtures, q3), "i1b")).toMatchObject({ outcome: "delivered" });
    fixtures.solProvider.state.amount = "10000";
    await router.close();
    closers.splice(closers.indexOf(router.close), 1);
    const noBucket = await startRouter(fixtures, { dropSolBucket: true });
    const paidBefore = fixtures.solProvider.seen.paid.length;
    const q5 = await staticQuote(noBucket, ROUTES.tempoSol, "i2");
    // Tempo の受信は push: verify の後に区分が無くて予約できない失敗も unknown（source_paid_unsettled）。
    expect(await purchase(noBucket, q5, await credentialFor(fixtures, q5), "i2")).toMatchObject({ outcome: "unknown", reason: "source_paid_unsettled" });
    // 動的は quote の段で不成立（client には一般の quote_failed として見える。core の理由は `bucket_not_allowed`: dynamic.ts）。
    expect(await noBucket.client().quoteUrl({ profileId: PROFILES.x402Sol, url: SOL_URL, requestId: "i3" })).toMatchObject({ ok: false });
    expect(fixtures.solProvider.seen.paid).toHaveLength(paidBefore);
  });
});
