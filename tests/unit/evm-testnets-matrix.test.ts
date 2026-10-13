/**
 * 掛け合わせの検証（`docs/evm-testnets-x402-design.md` §8・§8.5、タスク §8.3）。網なし（fake の MCP・chain、facilitator は注入の fake の I/O）:
 * - 設定: 30 の `mx-*`（値は表と一致・本番の読み込みを通る）、非行列の設定と公開の golden は不変
 * - 入口: 行列のときだけ子の env に既存レールの能力の env、能力の組み立て
 * - driver: レールごとの照合（署名の前）、Tempo MPP の署名の後の失敗は `funds_possibly_moved` で止まり別の plan でも二度と署名しない、
 *   Solana のレグの照合（owner × mint の差）と `finalized`、`--prefunded` の範囲、資金の表（入金を数えない・共有の Solana アカウント）
 * - prefund: 20,000 以下の分割、plan の hash の束縛、本物の facilitator の核が分割の要求を受ける
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Challenge } from "mppx";
import { getBase58Decoder } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";

import { KNOWN_NETWORKS, knownAssetOf, knownNetworkOf, loadRuntimeConfig } from "../../src/config.js";
import { createEvmFacilitator, type ChainIo, type Hex, type JournalRecord } from "../../tools/evm-facilitator.js";
import { existsSync } from "node:fs";
import {
  createAttemptMarker,
  attemptMarkerPathOf,
  setDirSyncForTest,
  signMarkerIdOf,
  finalityOf,
  planSha256,
  PlanRefusal,
  priorAttemptHold,
  runPurchases,
  Secrets,
  TRANSFER_TOPIC,
  buildPlan,
  type ChainReader,
  type McpCaller,
  type PlanBalance,
  type PurchaseEvidence,
  type ReceiptInfo,
  type SvmTransactionInfo,
} from "../../tools/evm-testnets-e2e.js";
import {
  buildMatrixPlan,
  loadApprovedMatrixPlan,
  matrixChecksOf,
  matrixSignerOf,
  matrixSubjectMismatches,
  runMatrix,
  sameAddress,
  svmTransactionInfoOf,
  associatedTokenAccountOf,
  MatrixLedger,
  svmAtaBalanceOf,
  verifySvmLeg,
  type MatrixDebit,
  type MatrixPlan,
  type MatrixPurchase,
  type MatrixSigner,
} from "../../tools/evm-testnets-matrix.js";
import { buildPrefundPlan, chunksOf, eip3009OfferOf, loadApprovedPrefundPlan, runPrefund, unresolvedPrefunds, type PrefundDeps, type PrefundPlan } from "../../tools/evm-testnets-prefund.js";
import { evmTestnetsCapabilitiesOf } from "../../tools/evm-testnets-router-process.js";
import { evmTestnetsOptionsOf } from "../../tools/evm-testnets-run.js";
import { RAILS_ACTIVATION_ENV } from "../../tools/rails-entry.js";
import { EVM_MATRIX_ACTIVATION, EVM_TESTNET_CHAINS, EVM_TESTNETS, evmTestnetsConfigOf, MATRIX_RAILS, matrixPairsOf, OUTBOUND, RAILS_NONE, UPSTREAM, UPSTREAM_ARC, UPSTREAM_SOL, UPSTREAM_SOL_MPP } from "../../tools/remote-mcp-config.js";
import { EVM_TESTNETS_ROUTER_PROCESS, hostPlanOf, HostPlanError } from "../../tools/remote-mcp.js";
import { createX402Payer } from "../../tools/x402-payer.js";

/* ------------------------------------------------------------------ 定数 */

const T8 = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const E_PROV = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
const E_FAC = "0x54633d372d7316435891EEBBaAB90861F8c1Dadc";
const ARC_PROVIDER = "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1";
const SOL_PROVIDER = "4LrB4peq75FSg9UhSyfhp4onb6GMKgEtC3o3wndgguBc";
const D_PROVIDER = "26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc";
const SOL_RECEIVER = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
/** T6 の Solana payer（クライアントと Router の Solana 送信鍵の兼任。§8.2）。 */
const SOL_PAYER = "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5";
const PAYER_KEY = generatePrivateKey();
const T7 = privateKeyToAccount(PAYER_KEY).address;
const ARC_RECEIVER_KEY = generatePrivateKey();
const ARC_RECEIVER = privateKeyToAccount(ARC_RECEIVER_KEY).address;
const OUTBOUND_KEY = generatePrivateKey();
const FACILITATOR_URL = "http://127.0.0.1:8611/0123456789abcdef-token";
const PROVIDER_URLS = {
  SUBETHA_EVM_PROVIDER_URL_RH: "http://127.0.0.1:8621/v1/eth/snapshot",
  SUBETHA_EVM_PROVIDER_URL_ARBSEP: "http://127.0.0.1:8622/v1/eth/snapshot",
  SUBETHA_EVM_PROVIDER_URL_HYPEREVM: "http://127.0.0.1:8623/v1/eth/snapshot",
};
const SOL_NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const SOL_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_SEED = getBase58Decoder().decode(new Uint8Array(32).fill(7));
const MPP_SECRET = "0123456789abcdef0123456789abcdef-matrix";
const NEW3 = ["rh", "arbsep", "hyperevm"] as const;

const receivers = { arc: ARC_RECEIVER, solana: SOL_RECEIVER };
const providers = { arc: ARC_PROVIDER, solana: SOL_PROVIDER, solanaMpp: D_PROVIDER };
const configEnv = { SUBETHA_EVM_FACILITATOR_URL: FACILITATOR_URL, SUBETHA_EVM_PROVIDER_PAYTO: E_PROV, ...PROVIDER_URLS };
const hostEnv = {
  ...configEnv,
  SUBETHA_OUTBOUND_PRIVATE_KEY: OUTBOUND_KEY,
  SUBETHA_ROUTER_RECEIVER: T8,
  SUBETHA_MPP_INBOUND_SECRET: MPP_SECRET,
  SUBETHA_ARC_RECEIVER_KEY: ARC_RECEIVER_KEY,
  SUBETHA_SOLANA_RECEIVER: SOL_RECEIVER,
  SUBETHA_OUTBOUND_SOLANA_KEY: SOLANA_SEED,
  SUBETHA_ARC_PROVIDER_PAYTO: ARC_PROVIDER,
  SUBETHA_SOLANA_PROVIDER_PAYTO: SOL_PROVIDER,
  SUBETHA_SOLANA_MPP_PROVIDER_PAYTO: D_PROVIDER,
};
const matrixOptions = { activation: RAILS_NONE, bind: "127.0.0.1", port: 0, journalPath: "/tmp/evm-matrix.ndjson", evmTestnets: { chains: EVM_TESTNET_CHAINS, matrix: true as const } };
const driverEnv = {
  SUBETHA_PAYER_ADDRESS: T7,
  SUBETHA_PAYER_SOLANA_ADDRESS: SOL_PAYER,
  SUBETHA_ROUTER_RECEIVER: T8,
  SUBETHA_ARC_RECEIVER_ADDRESS: ARC_RECEIVER,
  SUBETHA_SOLANA_RECEIVER: SOL_RECEIVER,
  SUBETHA_SOLANA_OUTBOUND_ADDRESS: SOL_PAYER,
  EVM_FACILITATOR_ADDRESS: E_FAC,
  SUBETHA_EVM_PROVIDER_PAYTO: E_PROV,
  SUBETHA_ARC_PROVIDER_PAYTO: ARC_PROVIDER,
  SUBETHA_SOLANA_PROVIDER_PAYTO: SOL_PROVIDER,
  SUBETHA_SOLANA_MPP_PROVIDER_PAYTO: D_PROVIDER,
};

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "evm-matrix-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ 設定 */

describe("matrix config (§8.3-1)", () => {
  const generated = () => evmTestnetsConfigOf(configEnv, T8, NEW3, { matrix: true, receivers, providers }) as { router: { routes: Record<string, any>; budget: any }; x402: { upstreams: Record<string, string>; inboundFacilitators: Record<string, unknown> } };

  test("30 mx routes: at least one side new, no same new chain, no Base; values equal the rail table and the table of known networks", () => {
    const pairs = matrixPairsOf();
    expect(pairs).toHaveLength(30);
    expect(new Set(pairs.map((p) => p.routeId)).size).toBe(30);
    for (const p of pairs) {
      expect(p.src).not.toBe(p.dst);
      expect(NEW3.includes(p.src as never) || NEW3.includes(p.dst as never)).toBe(true);
    }
    // 新 × 既存 12・既存 × 新 12・新 × 新 6。
    expect(pairs.filter((p) => NEW3.includes(p.src as never) && NEW3.includes(p.dst as never))).toHaveLength(6);
    // 表と一致（network・資産の表記・桁、レールの向き）。
    for (const [endpoint, rail] of Object.entries(MATRIX_RAILS)) {
      const entry = knownNetworkOf(KNOWN_NETWORKS, rail.network)!;
      const known = knownAssetOf(entry, rail.asset)!;
      expect(known.id, endpoint).toBe(rail.asset);
      expect(known.decimals).toBe(rail.decimals);
      expect(entry.inbound).toContain(rail.rail);
      expect(entry.outbound).toContain(rail.rail);
    }
    const doc = generated();
    const mx = Object.keys(doc.router.routes).filter((id) => id.startsWith("mx-"));
    expect(mx).toEqual(pairs.map((p) => p.routeId));
    const sourcePayTo = { rh: T8, arbsep: T8, hyperevm: T8, tempo: T8, arc: ARC_RECEIVER, sol: SOL_RECEIVER, solmpp: SOL_RECEIVER } as const;
    const dest = { rh: [E_PROV, PROVIDER_URLS.SUBETHA_EVM_PROVIDER_URL_RH], arbsep: [E_PROV, PROVIDER_URLS.SUBETHA_EVM_PROVIDER_URL_ARBSEP], hyperevm: [E_PROV, PROVIDER_URLS.SUBETHA_EVM_PROVIDER_URL_HYPEREVM], tempo: [OUTBOUND.payTo, UPSTREAM], arc: [ARC_PROVIDER, UPSTREAM_ARC], sol: [SOL_PROVIDER, UPSTREAM_SOL], solmpp: [D_PROVIDER, UPSTREAM_SOL_MPP] } as const;
    for (const { src, dst, routeId } of pairs) {
      const s = MATRIX_RAILS[src];
      const d = MATRIX_RAILS[dst];
      expect(doc.router.routes[routeId]).toEqual({
        routeId,
        canonicalPath: `/v1/routes/${routeId}/resource`,
        rail: d.rail,
        sourceRail: s.rail,
        source: { amount: "10000", asset: s.asset, decimals: 6, network: s.network, payTo: sourcePayTo[src] },
        destination: { scheme: d.scheme, network: d.network, asset: d.asset, payTo: dest[dst][0] },
      });
      expect(doc.x402.upstreams[routeId]).toBe(dest[dst][1]);
    }
    expect(doc.x402.inboundFacilitators).toEqual({
      ...Object.fromEntries(NEW3.map((c) => [EVM_TESTNETS[c].network, { kind: "x402", url: FACILITATOR_URL }])),
      "eip155:5042002": { kind: "circle", url: "https://api.circle.com/v1/facilitator/x402" },
      [SOL_NET]: { kind: "x402", url: "https://www.x402.org/facilitator" },
    });
  });

  test("the md-* routes stay exactly as in the non-matrix config; budget buckets admit every leg; Ethereum Sepolia is not in the matrix", () => {
    const plain = evmTestnetsConfigOf(configEnv, T8, NEW3) as any;
    const doc = generated();
    for (const [id, route] of Object.entries(plain.router.routes)) expect(doc.router.routes[id]).toEqual(route);
    for (const [id, url] of Object.entries(plain.x402.upstreams)) expect(doc.x402.upstreams[id]).toBe(url);
    expect(Object.keys(doc.router.routes)).toHaveLength(6 + 30);
    expect(JSON.stringify(doc)).not.toContain("11155111");
    // 予算: 各レグの (network, asset) に区分があり 1 件 10,000 が通る。区分ごとのレグ数 × 10,000 ≤ maxTotal。
    const legs = new Map<string, number>();
    for (const route of Object.values(doc.router.routes)) {
      for (const leg of [route.source, route.destination]) legs.set(`${leg.network}|${leg.asset}`, (legs.get(`${leg.network}|${leg.asset}`) ?? 0) + 1);
      // 両レグが同じ区分に落ちる route は無い（1 件の上限 10,000 のまま）。
      expect(`${route.source.network}|${route.source.asset}`).not.toBe(`${route.destination.network}|${route.destination.asset}`);
    }
    for (const [key, count] of legs) {
      const bucket = doc.router.budget.buckets.find((b: any) => `${b.network}|${b.asset}` === key);
      expect(bucket, key).toBeDefined();
      expect(BigInt(bucket.maxPerPurchase)).toBeGreaterThanOrEqual(10_000n);
      expect(BigInt(bucket.maxTotal), key).toBeGreaterThanOrEqual(BigInt(count) * 10_000n);
    }
    expect(doc.router.budget.maxPurchases).toBeGreaterThanOrEqual(36);
    // Sepolia を選んでも行列には入らない（md-* だけ）。
    const withSepolia = evmTestnetsConfigOf({ ...configEnv, SUBETHA_EVM_PROVIDER_URL_SEPOLIA: "http://127.0.0.1:8624/v1/eth/snapshot" }, T8, EVM_TESTNET_CHAINS, { matrix: true, receivers, providers }) as any;
    expect(Object.keys(withSepolia.router.routes).filter((id) => id.includes("sepolia"))).toEqual(["md-x402-eth-snapshot-sepolia", "md-sepolia-eth-snapshot"]);
  });

  test("refuses without all three new chains, malformed receivers/providers, or a provider that is a Router receiver", () => {
    expect(() => evmTestnetsConfigOf(configEnv, T8, ["rh", "arbsep"], { matrix: true, receivers, providers })).toThrow(/rh, arbsep and hyperevm/);
    expect(() => evmTestnetsConfigOf(configEnv, T8, NEW3, { matrix: true, receivers: { ...receivers, solana: SOL_RECEIVER.toLowerCase() }, providers })).toThrow(/solana receiver/);
    expect(() => evmTestnetsConfigOf(configEnv, T8, NEW3, { matrix: true, receivers, providers: { ...providers, solanaMpp: undefined } })).toThrow(/provider \(D\)/);
    expect(() => evmTestnetsConfigOf(configEnv, T8, NEW3, { matrix: true, receivers, providers: { ...providers, arc: ARC_RECEIVER } })).toThrow(/must not be a Router receiver/);
  });
});

/* ------------------------------------------------------------------ 入口・子 */

describe("matrix host plan and child capabilities (§8.3-2, §8.5 #6)", () => {
  test("the child env gains the existing rails' env only in matrix mode; the config loads as production (real + KNOWN_NETWORKS)", () => {
    const plain = hostPlanOf({ ...matrixOptions, evmTestnets: { chains: EVM_TESTNET_CHAINS } }, { ...hostEnv, SUBETHA_EVM_PROVIDER_URL_SEPOLIA: "http://127.0.0.1:8624/v1/eth/snapshot" });
    const plan = hostPlanOf(matrixOptions, { ...hostEnv, SUBETHA_EVM_PROVIDER_URL_SEPOLIA: "http://127.0.0.1:8624/v1/eth/snapshot", SUBETHA_SOLANA_RPC_URL: "https://solana.example/KEY", SUBETHA_TEMPO_RPC_URL: "https://tempo.example/KEY" });
    expect(plan.childScript).toBe(EVM_TESTNETS_ROUTER_PROCESS);
    const added = Object.keys(plan.childEnv).filter((k) => !(k in plain.childEnv)).sort();
    expect(added).toEqual(["ROUTER_MPP_INBOUND_OFFER_SECONDS", "ROUTER_MPP_INBOUND_RPC_URL", "ROUTER_MPP_INBOUND_SECRET", "ROUTER_SOLANA_RPC_URL", "SUBETHA_ARC_RECEIVER_KEY", "SUBETHA_OUTBOUND_MPP_KEY", "SUBETHA_OUTBOUND_SOLANA_KEY", "SUBETHA_SOLANA_RPC_URL", "SUBETHA_TEMPO_RPC_URL"]);
    expect(plan.childEnv[RAILS_ACTIVATION_ENV]).toBe("arc-in,arc-out,solana-in,solana-out,solana-mpp-in,solana-mpp-out");
    expect(plain.childEnv[RAILS_ACTIVATION_ENV]).toBe("");
    expect(plan.childEnv["SUBETHA_OUTBOUND_MPP_KEY"]).toBe(OUTBOUND_KEY);
    // Provider の受取先は子に渡さない（設定の生成だけが読む）。
    expect(Object.keys(plan.childEnv).filter((k) => k.endsWith("_PROVIDER_PAYTO"))).toEqual(["SUBETHA_EVM_PROVIDER_PAYTO"]);
    // 非行列の計画は env を足しても変わらない（行列の env を読まない）。
    const plainWithout = hostPlanOf({ ...matrixOptions, evmTestnets: { chains: EVM_TESTNET_CHAINS } }, { ...configEnv, SUBETHA_EVM_PROVIDER_URL_SEPOLIA: "http://127.0.0.1:8624/v1/eth/snapshot", SUBETHA_OUTBOUND_PRIVATE_KEY: OUTBOUND_KEY, SUBETHA_ROUTER_RECEIVER: T8 });
    expect(plainWithout).toEqual(plain);
    const dir = tempDir();
    const configPath = path.join(dir, "router.config.json");
    writeFileSync(configPath, JSON.stringify(plan.config));
    const loaded = loadRuntimeConfig({ ...plan.childEnv, ROUTER_CONFIG_PATH: configPath, ROUTER_JOURNAL_PATH: path.join(dir, "j.ndjson") }, (file) => readFileSync(file, "utf8"));
    expect(Object.keys(loaded.router.routes)).toHaveLength(8 + 30);
    expect(loaded.real!.mppInboundSecret).toBeDefined();
  });

  test("the child capabilities: Circle proof bound to the Arc source.payTo, Solana and Tempo MPP signers, Arc + new-chain x402 signers, local counterparties unchanged", () => {
    const plan = hostPlanOf(matrixOptions, { ...hostEnv, SUBETHA_EVM_PROVIDER_URL_SEPOLIA: "http://127.0.0.1:8624/v1/eth/snapshot" });
    const capabilities = evmTestnetsCapabilitiesOf(plan.childEnv);
    const arc = capabilities.sellerProofs?.["eip155:5042002"];
    expect(arc?.address).toBe(ARC_RECEIVER);
    const arcRoutes = Object.values((plan.config as any).router.routes).filter((r: any) => r.source.network === "eip155:5042002");
    expect(arcRoutes.length).toBe(3);
    for (const r of arcRoutes as any[]) expect(r.source.payTo).toBe(arc?.address);
    expect(Object.keys(capabilities.svmSigning ?? {})).toEqual([SOL_NET]);
    expect(capabilities.mppTempo).toBeDefined();
    expect(Object.keys(capabilities.evmSigningByNetwork ?? {}).sort()).toEqual(["eip155:5042002", ...EVM_TESTNET_CHAINS.map((c) => EVM_TESTNETS[c].network)].sort());
    expect(capabilities.localCounterparties).toEqual({ origins: ["http://127.0.0.1:8611", "http://127.0.0.1:8621", "http://127.0.0.1:8622", "http://127.0.0.1:8623", "http://127.0.0.1:8624"] });
    // Provider の受取先（D を含む）は運用者（受取先・送信鍵）の外。
    const operators = new Set([T8.toLowerCase(), ARC_RECEIVER.toLowerCase(), SOL_RECEIVER, privateKeyToAccount(OUTBOUND_KEY).address.toLowerCase()]);
    for (const p of [E_PROV, ARC_PROVIDER, SOL_PROVIDER, D_PROVIDER, OUTBOUND.payTo]) expect(operators.has(p.startsWith("0x") ? p.toLowerCase() : p)).toBe(false);
  });

  test("matrix mode refuses without the MPP secret, the receivers or the provider pay-to envs; --matrix sets the option", () => {
    const env = { ...hostEnv, SUBETHA_EVM_PROVIDER_URL_SEPOLIA: "http://127.0.0.1:8624/v1/eth/snapshot" };
    const codeOf = (e: Record<string, string | undefined>) => {
      try {
        hostPlanOf(matrixOptions, e);
      } catch (error) {
        return error instanceof HostPlanError ? error.code : "other";
      }
      return "ok";
    };
    expect(codeOf(env)).toBe("ok");
    expect(codeOf({ ...env, SUBETHA_MPP_INBOUND_SECRET: undefined })).toBe("env");
    expect(codeOf({ ...env, SUBETHA_SOLANA_RECEIVER: undefined })).toBe("rails");
    expect(codeOf({ ...env, SUBETHA_ARC_PROVIDER_PAYTO: undefined })).toBe("config");
    expect(codeOf({ ...env, SUBETHA_SOLANA_MPP_PROVIDER_PAYTO: undefined })).toBe("config");
    const dir = tempDir();
    expect(evmTestnetsOptionsOf({ SUBETHA_EVM_TESTNETS_JOURNAL_PATH: path.join(dir, "j.ndjson") }, ["--matrix"]).evmTestnets.matrix).toBe(true);
    expect(evmTestnetsOptionsOf({ SUBETHA_EVM_TESTNETS_JOURNAL_PATH: path.join(dir, "j.ndjson") }).evmTestnets).not.toHaveProperty("matrix");
    expect(EVM_MATRIX_ACTIVATION).not.toHaveProperty("pairs");
  });
});

/* ------------------------------------------------------------------ fake chain・MCP */

const hex64 = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
const pad = (a: string): string => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
function svmSignature(n: number): string {
  const bytes = new Uint8Array(64).fill(9);
  bytes[0] = n % 256;
  bytes[1] = Math.floor(n / 256) % 256;
  return getBase58Decoder().decode(bytes);
}

class MatrixChain implements ChainReader {
  readonly receipts = new Map<string, ReceiptInfo>();
  readonly svm = new Map<string, SvmTransactionInfo>();
  readonly statuses = new Map<string, { confirmationStatus: string | null; err: unknown; slot: number }>();
  balanceOf: (network: string, asset: string | null, owner: string) => bigint = () => 10n ** 24n;
  async tokenBalance(network: string, asset: string, owner: string): Promise<bigint> {
    return this.balanceOf(network, asset, owner);
  }
  async nativeBalance(network: string, owner: string): Promise<bigint> {
    return this.balanceOf(network, null, owner);
  }
  async feeEstimate(): Promise<bigint> {
    return 100_000_000n;
  }
  async receipt(_network: string, hash: string): Promise<ReceiptInfo | undefined> {
    return this.receipts.get(hash.toLowerCase());
  }
  async finalizedBlock(): Promise<bigint | undefined> {
    return 10n ** 9n;
  }
  async svmTransaction(_network: string, signature: string): Promise<SvmTransactionInfo | undefined> {
    return this.svm.get(signature);
  }
  async svmSignatureStatus(_network: string, signature: string) {
    return this.statuses.get(signature);
  }
  async pay(network: string, asset: string, from: string, to: string, value: bigint, ref: string, toOverride?: string): Promise<void> {
    if (network.startsWith("solana:")) {
      const source = await associatedTokenAccountOf(from, asset, TOKEN_PROGRAM);
      const destination = await associatedTokenAccountOf(toOverride ?? to, asset, TOKEN_PROGRAM);
      this.svm.set(ref, {
        ok: true,
        slot: 7,
        tokenBalances: [
          { accountIndex: 1, address: source, preOwner: from, preMint: asset, postOwner: from, postMint: asset, pre: 100_000n, post: 100_000n - value },
          { accountIndex: 2, address: destination, preOwner: toOverride ?? to, preMint: asset, postOwner: toOverride ?? to, postMint: asset, pre: 0n, post: value },
        ],
      });
      this.statuses.set(ref, { confirmationStatus: "confirmed", err: null, slot: 7 });
      return;
    }
    // Tempo の手数料の Transfer（fee manager 宛て）も混ぜる（数えないこと）。
    this.receipts.set(ref.toLowerCase(), {
      status: "success",
      blockNumber: 100n,
      blockHash: hex64(107),
      logs: [
        { address: asset, topics: [TRANSFER_TOPIC, pad(from), pad(toOverride ?? to)], data: `0x${value.toString(16).padStart(64, "0")}` },
        { address: asset, topics: [TRANSFER_TOPIC, pad(from), pad("0xfeec000000000000000000000000000000000000")], data: `0x${(321).toString(16).padStart(64, "0")}` },
      ],
    });
  }
}

const EXPIRES = () => Math.floor(Date.now() / 1000) + 600;
function offerFor(p: MatrixPurchase, quoteId: string): Record<string, unknown> {
  const s = p.source;
  const expiresAt = EXPIRES();
  if (s.scheme === "tempo/charge") {
    const challenge = Challenge.serialize(Challenge.from({ id: quoteId, realm: "r", method: "tempo", intent: "charge", expires: new Date((expiresAt - 1) * 1000).toISOString(), request: { amount: s.amount, currency: s.asset, recipient: s.to, methodDetails: { chainId: 42431 } } } as never) as never);
    return { scheme: s.scheme, network: s.network, asset: s.asset, amount: s.amount, payTo: s.to, maxTimeoutSeconds: 600, extra: { challengeNonce: quoteId, expiresAt, routeBinding: "rb", fundsMoveOnCredential: true, challenge } };
  }
  if (s.scheme === "solana/charge") {
    const challenge = Challenge.serialize(Challenge.from({ id: quoteId, realm: "r", method: "solana", intent: "charge", expires: new Date((expiresAt - 1) * 1000).toISOString(), request: { amount: s.amount, currency: s.asset, recipient: s.to, externalId: "ext-1", methodDetails: { network: "devnet", decimals: 6, tokenProgram: TOKEN_PROGRAM, feePayer: false } } } as never) as never);
    return { scheme: s.scheme, network: s.network, asset: s.asset, amount: s.amount, payTo: s.to, maxTimeoutSeconds: 600, extra: { challengeNonce: quoteId, expiresAt, routeBinding: "rb", fundsMoveOnCredential: true, challenge, externalId: "ext-1", decimals: 6, tokenProgram: TOKEN_PROGRAM } };
  }
  if (s.family === "svm") return { scheme: "exact", network: s.network, asset: s.asset, amount: s.amount, payTo: s.to, maxTimeoutSeconds: 60, extra: { feePayer: SOL_PROVIDER, memo: quoteId, challengeNonce: quoteId, expiresAt, routeBinding: "rb", fundsMoveOnCredential: false } };
  const domain = knownAssetOf(knownNetworkOf(KNOWN_NETWORKS, s.network)!, s.asset)!.domain!;
  return { scheme: "exact", network: s.network, asset: s.asset, amount: s.amount, payTo: s.to, maxTimeoutSeconds: 60, extra: { name: domain.name, version: domain.version, challengeNonce: quoteId, expiresAt, routeBinding: "rb", ...(s.endpoint === "arc" ? { assetTransferMethod: "eip3009" } : {}), fundsMoveOnCredential: false } };
}

interface Behaviour {
  quoteTamper?: (routeId: string, response: Record<string, unknown>) => void;
  purchaseThrows?: (routeId: string) => boolean;
  sourceToOverride?: (routeId: string) => string | undefined;
}
class MatrixMcp implements McpCaller {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly statuses = new Map<string, Record<string, unknown>>();
  #n = 0;
  constructor(private readonly plan: MatrixPlan, private readonly chain: MatrixChain, private readonly behaviour: Behaviour = {}) {}
  async close(): Promise<void> {}
  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }
  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ name, args });
    const routeId = String(args["routeId"] ?? (args["quote"] as { routeId?: string } | undefined)?.routeId ?? "");
    const p = this.plan.purchases.find((x) => x.routeId === routeId);
    if (name === "subetha_router_status") return this.statuses.get(String(args["paymentId"])) ?? { found: false };
    if (p === undefined) throw new Error(`no planned ${routeId}`);
    if (name === "subetha_router_quote") {
      this.#n += 1;
      const quoteId = p.source.scheme === "exact" && p.source.family === "evm" ? hex64(0xabc000 + this.#n) : `mppid${String(this.#n)}`.padEnd(43, "A");
      const paymentId = `pay-${String(this.#n)}`;
      const offer = offerFor(p, quoteId);
      const approval = { required: true, boundTo: quoteId, deadlineMs: Date.now() + 600_000 };
      const quote = { quoteId, paymentId, routeId, source: { amount: p.source.amount, asset: p.source.asset, network: p.source.network, offer }, destination: { quoted: p.destination.amount, asset: p.destination.asset, network: p.destination.network, payTo: p.destination.to, quoteFingerprint: "sha256:00" }, approval };
      const subject = { quoteId, paymentId, routeId, source: { amount: p.source.amount, decimals: 6, asset: p.source.asset, network: p.source.network, expiresAt: 0, offer }, destination: { quoted: p.destination.amount, asset: p.destination.asset, network: p.destination.network }, approval, fundsMoveOnCredential: p.source.rail === "mpp" };
      const response: Record<string, unknown> = { ok: true, quote, subject };
      this.behaviour.quoteTamper?.(routeId, response);
      return response;
    }
    if (name === "subetha_router_purchase") {
      if (this.behaviour.purchaseThrows?.(routeId) === true) throw new Error("timeout");
      const quote = args["quote"] as { paymentId: string };
      const n = Number(quote.paymentId.slice(4));
      const srcRef = p.source.family === "svm" ? svmSignature(1000 + n) : hex64(0x5000 + n);
      const dstRef = p.destination.family === "svm" ? svmSignature(2000 + n) : hex64(0xd000 + n);
      await this.chain.pay(p.source.network, p.source.asset, p.source.from, p.source.to, 10_000n, srcRef, this.behaviour.sourceToOverride?.(routeId));
      await this.chain.pay(p.destination.network, p.destination.asset, p.destination.from, p.destination.to, 10_000n, dstRef);
      const body = { market: "ETH/USDC", data: { priceUsdcPerWeth: "1" } };
      this.statuses.set(quote.paymentId, { found: true, projection: { paymentId: quote.paymentId, routeId, status: "delivered", source: { txRef: srcRef }, destination: { txRef: dstRef }, result: body } });
      return { ok: true, outcome: "delivered", paymentId: quote.paymentId, snapshot: body };
    }
    throw new Error(`unexpected tool ${name}`);
  }
}

function fakeSigner(behaviour: { fail?: (p: MatrixPurchase) => { reason: string; fundsMayHaveMoved: boolean; txRef?: string } | undefined } = {}): MatrixSigner & { calls: string[] } {
  const calls: string[] = [];
  const signer = (async (_quote: unknown, planned: MatrixPurchase) => {
    calls.push(planned.routeId);
    const failure = behaviour.fail?.(planned);
    if (failure !== undefined) return { ok: false as const, ...failure };
    return { ok: true as const, credential: "Y3JlZGVudGlhbC1mb3ItdGVzdHMtb25seQ==", kind: planned.expectedSign, ...(planned.expectedSign === "x402-evm" ? { chainId: Number(planned.source.network.split(":")[1]) } : {}) };
  }) as MatrixSigner & { calls: string[] };
  signer.calls = calls;
  return signer;
}

async function matrixPlan(chain = new MatrixChain()): Promise<MatrixPlan> {
  return buildMatrixPlan(driverEnv, chain, () => new Date("2026-10-13T12:00:00Z"));
}
function runDeps(mcp: McpCaller, chain: ChainReader, sign: MatrixSigner, lines: string[]) {
  let t = 0;
  return { mcp, chain, sign, secrets: Secrets.fromEnv({}), out: (l: string) => lines.push(l), now: () => new Date(Date.now() + 10 * ++t), sleep: async () => {}, receiptWaitMs: 0 };
}
function evidenceOf(dir: string, runDir: string, routeId: string): PurchaseEvidence {
  void dir;
  return JSON.parse(readFileSync(path.join(runDir, "purchases", `${routeId}.json`), "utf8")) as PurchaseEvidence;
}

/* ------------------------------------------------------------------ 照合（§8.5 #2） */

describe("per-rail subject/plan comparison before signing (§8.5 #2)", () => {
  async function quoteFor(routeId: string, tamper?: (r: Record<string, unknown>) => void) {
    const plan = await matrixPlan();
    const p = plan.purchases.find((x) => x.routeId === routeId)!;
    const mcp = new MatrixMcp(plan, new MatrixChain(), tamper === undefined ? {} : { quoteTamper: (_id, r) => tamper(r) });
    return { p, response: await mcp.call("subetha_router_quote", { routeId, requestId: "r" }) };
  }

  test.each(["mx-rh-to-tempo", "mx-arc-to-rh", "mx-sol-to-arbsep", "mx-tempo-to-hyperevm", "mx-solmpp-to-rh", "mx-rh-to-arbsep"])("a well-formed quote for %s has no mismatches", async (routeId) => {
    const { p, response } = await quoteFor(routeId);
    expect(matrixSubjectMismatches(response, p, Date.now())).toEqual([]);
  });

  test("MPP must say fundsMoveOnCredential true; x402 false", async () => {
    const tempo = await quoteFor("mx-tempo-to-rh", (r) => {
      (r["subject"] as Record<string, unknown>)["fundsMoveOnCredential"] = false;
    });
    expect(matrixSubjectMismatches(tempo.response, tempo.p, Date.now()).join(";")).toMatch(/subject\.fundsMoveOnCredential/);
    const evm = await quoteFor("mx-rh-to-sol", (r) => {
      (r["subject"] as Record<string, unknown>)["fundsMoveOnCredential"] = true;
    });
    expect(matrixSubjectMismatches(evm.response, evm.p, Date.now()).join(";")).toMatch(/subject\.fundsMoveOnCredential/);
  });

  test("Solana addresses compare exactly, EVM addresses case-insensitively", async () => {
    expect(sameAddress(SOL_NET, SOL_RECEIVER, SOL_RECEIVER.toLowerCase())).toBe(false);
    expect(sameAddress("eip155:46630", T8, T8.toLowerCase())).toBe(true);
    const lowerSol = await quoteFor("mx-rh-to-sol", (r) => {
      ((r["quote"] as Record<string, unknown>)["destination"] as Record<string, unknown>)["payTo"] = SOL_PROVIDER.toLowerCase();
    });
    expect(matrixSubjectMismatches(lowerSol.response, lowerSol.p, Date.now()).join(";")).toMatch(/upstream recipient/);
    const lowerEvm = await quoteFor("mx-sol-to-rh", (r) => {
      ((r["quote"] as Record<string, unknown>)["destination"] as Record<string, unknown>)["payTo"] = E_PROV.toLowerCase();
    });
    expect(matrixSubjectMismatches(lowerEvm.response, lowerEvm.p, Date.now())).toEqual([]);
  });

  test("the embedded challenge is bound (amount inside a Tempo challenge; recipient inside a Solana MPP challenge); the scheme and the shown/signed offer identity are bound", async () => {
    const change = (r: Record<string, unknown>, mutate: (offer: Record<string, unknown>) => void) => {
      const offer = structuredClone(((r["quote"] as Record<string, unknown>)["source"] as Record<string, unknown>)["offer"]) as Record<string, unknown>;
      mutate(offer);
      ((r["quote"] as Record<string, unknown>)["source"] as Record<string, unknown>)["offer"] = offer;
      ((r["subject"] as Record<string, unknown>)["source"] as Record<string, unknown>)["offer"] = offer;
    };
    const tempo = await quoteFor("mx-tempo-to-rh", (r) =>
      change(r, (o) => {
        const extra = o["extra"] as Record<string, unknown>;
        extra["challenge"] = Challenge.serialize(Challenge.from({ id: extra["challengeNonce"], realm: "r", method: "tempo", intent: "charge", expires: new Date(Date.now() + 300_000).toISOString(), request: { amount: "20000", currency: o["asset"], recipient: o["payTo"], methodDetails: { chainId: 42431 } } } as never) as never);
      }),
    );
    expect(matrixSubjectMismatches(tempo.response, tempo.p, Date.now()).join(";")).toMatch(/challenge amount differs/);
    const solmpp = await quoteFor("mx-solmpp-to-rh", (r) =>
      change(r, (o) => {
        const extra = o["extra"] as Record<string, unknown>;
        extra["challenge"] = Challenge.serialize(Challenge.from({ id: extra["challengeNonce"], realm: "r", method: "solana", intent: "charge", expires: new Date(Date.now() + 300_000).toISOString(), request: { amount: "10000", currency: SOL_MINT, recipient: SOL_PROVIDER, externalId: "ext-1", methodDetails: { network: "devnet", decimals: 6, tokenProgram: TOKEN_PROGRAM, feePayer: false } } } as never) as never);
      }),
    );
    expect(matrixSubjectMismatches(solmpp.response, solmpp.p, Date.now()).join(";")).toMatch(/recipient differs/);
    const scheme = await quoteFor("mx-solmpp-to-rh", (r) => change(r, (o) => (o["scheme"] = "exact")));
    expect(matrixSubjectMismatches(scheme.response, scheme.p, Date.now()).join(";")).toMatch(/scheme/);
    const split = await quoteFor("mx-sol-to-rh", (r) => {
      const offer = structuredClone(((r["quote"] as Record<string, unknown>)["source"] as Record<string, unknown>)["offer"]) as Record<string, unknown>;
      offer["payTo"] = SOL_PAYER;
      ((r["quote"] as Record<string, unknown>)["source"] as Record<string, unknown>)["offer"] = offer;
    });
    expect(matrixSubjectMismatches(split.response, split.p, Date.now()).join(";")).toMatch(/differs from subject\.source\.offer/);
  });
});

/* ------------------------------------------------------------------ run */

describe("matrix run (§8.5 #1, #4, #5)", () => {
  test("refuses without --prefunded", async () => {
    const plan = await matrixPlan();
    const lines: string[] = [];
    await expect(runMatrix({ plan, planSha256: planSha256(plan), evidenceDir: tempDir(), prefunded: false }, runDeps(new MatrixMcp(plan, new MatrixChain()), new MatrixChain(), fakeSigner(), lines))).rejects.toThrow(PlanRefusal);
  });

  test.each(["mx-sol-to-rh", "mx-rh-to-solmpp", "mx-tempo-to-arbsep", "mx-solmpp-to-hyperevm", "mx-arc-to-rh"])("%s: delivered and both legs verified on chain (EVM Transfer / Solana owner x mint deltas)", async (routeId) => {
    const chain = new MatrixChain();
    const plan = await matrixPlan(chain);
    const mcp = new MatrixMcp(plan, chain);
    const signer = fakeSigner();
    const lines: string[] = [];
    const dir = tempDir();
    const report = await runMatrix({ plan, planSha256: planSha256(plan), evidenceDir: dir, prefunded: true, only: routeId }, runDeps(mcp, chain, signer, lines));
    expect(report.stopped, lines.join("\n")).toBeUndefined();
    const evidence = evidenceOf(dir, report.runDir, routeId);
    expect(evidence.stage).toBe("verified");
    expect(evidence.legs?.every((l) => l.ok)).toBe(true);
    expect(evidence.signInvoked).toBe(true);
    expect(evidence.fundsMoveAtSign).toBe(routeId.startsWith("mx-tempo-"));
  });

  test("a Solana leg whose owner delta does not match the quote fails verification", async () => {
    const chain = new MatrixChain();
    const plan = await matrixPlan(chain);
    const mcp = new MatrixMcp(plan, chain, { sourceToOverride: () => SOL_PROVIDER });
    const lines: string[] = [];
    const dir = tempDir();
    const report = await runMatrix({ plan, planSha256: planSha256(plan), evidenceDir: dir, prefunded: true, only: "mx-sol-to-rh" }, runDeps(mcp, chain, fakeSigner(), lines));
    expect(report.stopped?.stage).toBe("verification_failed");
    expect(report.stopped?.reason).toMatch(/destination ATA .* is not among the token balance changes/);
  });

  test("a mismatch stops before signing: no signature, no purchase", async () => {
    const chain = new MatrixChain();
    const plan = await matrixPlan(chain);
    const mcp = new MatrixMcp(plan, chain, { quoteTamper: (_id, r) => (((r["quote"] as Record<string, unknown>)["destination"] as Record<string, unknown>)["payTo"] = T8) });
    const signer = fakeSigner();
    const report = await runMatrix({ plan, planSha256: planSha256(plan), evidenceDir: tempDir(), prefunded: true, only: "mx-tempo-to-rh" }, runDeps(mcp, chain, signer, []));
    expect(report.stopped?.stage).toBe("stopped_before_signing");
    expect(signer.calls).toEqual([]);
    expect(mcp.count("subetha_router_purchase")).toBe(0);
  });

  test("Tempo MPP: a failure after signing was invoked is funds_possibly_moved (tx kept), stops the run, and the route is never re-signed under a new plan", async () => {
    const chain = new MatrixChain();
    const plan = await matrixPlan(chain);
    const mcp = new MatrixMcp(plan, chain);
    const signer = fakeSigner({ fail: (p) => (p.src === "tempo" ? { reason: "rpc dropped after broadcast", fundsMayHaveMoved: false, txRef: hex64(0x7777) } : undefined) });
    const dir = tempDir();
    const lines: string[] = [];
    // tempo の 1 件目まで進む（その前の購入は delivered）。
    const firstTempo = plan.purchases.find((p) => p.src === "tempo")!;
    const report = await runMatrix({ plan, planSha256: planSha256(plan), evidenceDir: dir, prefunded: true }, runDeps(mcp, chain, signer, lines));
    expect(report.stopped?.routeId).toBe(firstTempo.routeId);
    expect(report.stopped?.stage).toBe("funds_possibly_moved");
    expect(signer.calls.filter((id) => id === firstTempo.routeId)).toHaveLength(1);
    expect(mcp.calls.filter((c) => c.name === "subetha_router_purchase" && (c.args["quote"] as { routeId: string }).routeId === firstTempo.routeId)).toHaveLength(0);
    const evidence = evidenceOf(dir, report.runDir, firstTempo.routeId);
    expect(evidence.signTxRef).toBe(hex64(0x7777));
    expect(evidence.signInvoked).toBe(true);
    // 新しい plan（別の hash）でも同じ route は保留（二度と署名しない）。
    const plan2 = { ...plan, createdAt: "2026-10-13T13:00:00.000Z" } as MatrixPlan;
    const signer2 = fakeSigner();
    const report2 = await runMatrix({ plan: plan2, planSha256: planSha256(plan2), evidenceDir: dir, prefunded: true, only: firstTempo.routeId }, runDeps(new MatrixMcp(plan2, chain), chain, signer2, lines));
    expect(report2.stopped?.reason).toMatch(/never re-signed/);
    expect(signer2.calls).toEqual([]);
   }, 60_000);

  test("Tempo MPP: a purchase call that fails is funds_possibly_moved and not retried", async () => {
    const chain = new MatrixChain();
    const plan = await matrixPlan(chain);
    const mcp = new MatrixMcp(plan, chain, { purchaseThrows: (id) => id === "mx-tempo-to-rh" });
    const report = await runMatrix({ plan, planSha256: planSha256(plan), evidenceDir: tempDir(), prefunded: true, only: "mx-tempo-to-rh" }, runDeps(mcp, chain, fakeSigner(), []));
    expect(report.stopped?.stage).toBe("funds_possibly_moved");
    expect(mcp.count("subetha_router_purchase")).toBe(1);
  });

  test("a non-funds-moving signature refusal is sign_refused and does not hold a later plan", async () => {
    const chain = new MatrixChain();
    const plan = await matrixPlan(chain);
    const dir = tempDir();
    const report = await runMatrix({ plan, planSha256: planSha256(plan), evidenceDir: dir, prefunded: true, only: "mx-sol-to-rh" }, runDeps(new MatrixMcp(plan, chain), chain, fakeSigner({ fail: () => ({ reason: "refused", fundsMayHaveMoved: false }) }), []));
    expect(report.stopped?.stage).toBe("sign_refused");
    const plan2 = { ...plan, createdAt: "2026-10-13T13:00:00.000Z" } as MatrixPlan;
    const report2 = await runMatrix({ plan: plan2, planSha256: planSha256(plan2), evidenceDir: dir, prefunded: true, only: "mx-sol-to-rh" }, runDeps(new MatrixMcp(plan2, chain), chain, fakeSigner(), []));
    expect(report2.stopped).toBeUndefined();
  });

  test("not funded: the purchase's debits exceed the current balance → stops before any marker or quote", async () => {
    const chain = new MatrixChain();
    const plan = await matrixPlan(chain);
    chain.balanceOf = (network, asset, owner) => (owner === T8 && network === "eip155:46630" && asset !== null ? 5_000n : 10n ** 24n);
    const mcp = new MatrixMcp(plan, chain);
    const report = await runMatrix({ plan, planSha256: planSha256(plan), evidenceDir: tempDir(), prefunded: true, only: "mx-tempo-to-rh" }, runDeps(mcp, chain, fakeSigner(), []));
    expect(report.stopped?.reason).toMatch(/not funded/);
    expect(mcp.calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ 資金の表（§8.5 #5） */

describe("matrix funds table (§8.5 #5)", () => {
  test("30 purchases; debits never credit incoming payments; the shared Solana account (client = Router outbound) is one balance", async () => {
    const chain = new MatrixChain();
    const plan = await matrixPlan(chain);
    expect(plan.purchases).toHaveLength(30);
    expect(plan.addresses.payerSolana).toBe(plan.addresses.solanaOutbound);
    const solKey = plan.checks.filter((c) => c.network === SOL_NET && c.kind === "token");
    // 1 つの鍵: payerSolana と solanaOutbound の支出の合計（sol・solmpp の受信 6 + sol・solmpp への送信 6 = 12 × 10,000）。
    expect(solKey).toHaveLength(1);
    expect(solKey[0]!.need).toBe("120000");
    // 残高が 110,000 なら足りない（どちらの役割の分も同じ残高から）。
    const debits = plan.debits as MatrixDebit[];
    const balances: PlanBalance[] = plan.balances.map((b) => (b.network === SOL_NET && b.kind === "token" ? { ...b, value: "110000" } : b));
    const short = matrixChecksOf(debits, balances, {}).find((c) => c.network === SOL_NET && c.kind === "token");
    expect(short?.ok).toBe(false);
    // T8 の rh: 受信で 6 × 10,000 入るが数えない。送信 6 × 10,000 = 60,000 が要る。
    const t8rh = plan.checks.find((c) => c.role === "routerOutbound" && c.network === "eip155:46630")!;
    expect(t8rh.need).toBe("60000");
    const rhShort = matrixChecksOf(debits, plan.balances.map((b) => (b.address === T8 && b.network === "eip155:46630" && b.kind === "token" ? { ...b, value: "59999" } : b)), {}).find((c) => c.role === "routerOutbound" && c.network === "eip155:46630");
    expect(rhShort?.ok).toBe(false);
    // Tempo: T8 の送信 3 件 + 手数料の見込み。
    expect(plan.checks.find((c) => c.role === "routerOutbound" && c.network === "eip155:42431")!.need).toBe(String(3 * 10_000 + 3 * 5_000));
  });

  test("the matrix plan's hash binds it", async () => {
    const plan = await matrixPlan();
    const dir = tempDir();
    const file = path.join(dir, "plan.json");
    writeFileSync(file, JSON.stringify(plan));
    const sha = planSha256(plan);
    expect(loadApprovedMatrixPlan(file, sha).purchases).toHaveLength(30);
    const tampered = JSON.parse(readFileSync(file, "utf8")) as MatrixPlan;
    (tampered.purchases[0] as { destination: { to: string } }).destination.to = "0x000000000000000000000000000000000000dEaD";
    writeFileSync(file, JSON.stringify(tampered));
    expect(() => loadApprovedMatrixPlan(file, sha)).toThrow(/not the approved/);
  });
});

/* ------------------------------------------------------------------ Solana の evidence と確定（§8.5 #4） */

describe("Solana evidence and finality (§8.5 #4)", () => {
  test("getTransaction (jsonParsed) is summarised per account: address, pre and post owner/mint kept separately; a failed tx is not ok", () => {
    const info = svmTransactionInfoOf({
      slot: 42,
      transaction: { message: { accountKeys: [{ pubkey: "Fee1111111111111111111111111111111111111111" }, { pubkey: "SrcAta1111111111111111111111111111111111111" }, "DstAta1111111111111111111111111111111111111"] } },
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, mint: SOL_MINT, owner: SOL_PAYER, uiTokenAmount: { amount: "50000" } }],
        postTokenBalances: [
          { accountIndex: 1, mint: SOL_MINT, owner: SOL_PAYER, uiTokenAmount: { amount: "40000" } },
          { accountIndex: 2, mint: SOL_MINT, owner: SOL_RECEIVER, uiTokenAmount: { amount: "10000" } },
        ],
      },
    });
    expect(info).toEqual({
      ok: true,
      slot: 42,
      tokenBalances: [
        { accountIndex: 1, address: "SrcAta1111111111111111111111111111111111111", preOwner: SOL_PAYER, preMint: SOL_MINT, postOwner: SOL_PAYER, postMint: SOL_MINT, pre: 50_000n, post: 40_000n },
        { accountIndex: 2, address: "DstAta1111111111111111111111111111111111111", preOwner: null, preMint: null, postOwner: SOL_RECEIVER, postMint: SOL_MINT, pre: null, post: 10_000n },
      ],
    });
    expect(svmTransactionInfoOf({ slot: 1, meta: { err: { InstructionError: [0, "x"] } } })?.ok).toBe(false);
  });

  test("finality: Solana needs finalized commitment; Tempo and Arc are receipt (instant)", async () => {
    const chain = new MatrixChain();
    const sig = svmSignature(5);
    chain.statuses.set(sig, { confirmationStatus: "confirmed", err: null, slot: 9 });
    expect((await finalityOf(chain, SOL_NET, sig, null, "source")).final).toBe(false);
    chain.statuses.set(sig, { confirmationStatus: "finalized", err: null, slot: 9 });
    const final = await finalityOf(chain, SOL_NET, sig, null, "source");
    expect(final).toMatchObject({ final: true, rule: "finalized_commitment" });
    chain.statuses.set(sig, { confirmationStatus: "finalized", err: { x: 1 }, slot: 9 });
    expect((await finalityOf(chain, SOL_NET, sig, null, "source")).final).toBe(false);
    await chain.pay("eip155:42431", "0x20c0000000000000000000000000000000000000", T7, T8, 10_000n, hex64(1));
    expect(await finalityOf(chain, "eip155:42431", hex64(1), null, "source")).toMatchObject({ final: true, rule: "receipt" });
    await chain.pay("eip155:5042002", "0x3600000000000000000000000000000000000000", T7, ARC_RECEIVER, 10_000n, hex64(2));
    expect(await finalityOf(chain, "eip155:5042002", hex64(2), null, "source")).toMatchObject({ final: true, rule: "receipt" });
  });
});

/* ------------------------------------------------------------------ --prefunded の範囲（§8.5 #5、既存の 8 本の driver） */

describe("--prefunded on the existing driver (§8.5 #5)", () => {
  test("drops only the same-chain inbound dependency; an unresolved attempt under another plan still holds", async () => {
    const chain = new MatrixChain();
    const env = { SUBETHA_PAYER_ADDRESS: T7, SUBETHA_ROUTER_RECEIVER: T8, EVM_FACILITATOR_ADDRESS: E_FAC, SUBETHA_EVM_PROVIDER_PAYTO: E_PROV };
    const plan = await buildPlan(["rh"], env, chain);
    const sha = planSha256(plan);
    const dir = tempDir();
    // 別の plan の未解決の試み（unknown）。
    createAttemptMarker(dir, "f".repeat(64), "md-rh-eth-snapshot", { runId: "old" });
    const evidence: Partial<PurchaseEvidence> = { kind: "subetha-evm-testnets-e2e-purchase", planSha256: "f".repeat(64), runId: "old", routeId: "md-rh-eth-snapshot", stage: "purchase_call_failed", chain: "rh", direction: "outbound", index: 2, startedAt: "x" };
    const runDir = path.join(dir, "run-old", "purchases");
    (await import("node:fs")).mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "md-rh-eth-snapshot.json"), JSON.stringify(evidence));
    const all = [evidence as PurchaseEvidence];
    expect(priorAttemptHold(dir, "md-rh-eth-snapshot", sha, all)).toMatch(/purchase_call_failed/);
    const calls: string[] = [];
    const mcp: McpCaller = { async call(name) { calls.push(name); throw new Error("must not be called"); }, async close() {} };
    const report = await runPurchases({ plan, planSha256: sha, evidenceDir: dir, prefunded: true, only: "md-rh-eth-snapshot" }, { mcp, chain, sign: async () => ({ ok: false, reason: "no" }), secrets: Secrets.fromEnv({}), out: () => {}, sleep: async () => {} });
    expect(report.stopped?.reason).toMatch(/held: .*purchase_call_failed/);
    expect(calls).toEqual([]);
    // 安全に終わった試み（quote の失敗）だけなら保留しない。
    expect(priorAttemptHold(dir, "md-rh-eth-snapshot", sha, [{ ...(evidence as PurchaseEvidence), stage: "quote_failed" }])).toBeUndefined();
  });

  test("without --prefunded the outbound still needs a delivered inbound", async () => {
    const chain = new MatrixChain();
    const env = { SUBETHA_PAYER_ADDRESS: T7, SUBETHA_ROUTER_RECEIVER: T8, EVM_FACILITATOR_ADDRESS: E_FAC, SUBETHA_EVM_PROVIDER_PAYTO: E_PROV };
    const plan = await buildPlan(["rh"], env, chain);
    const mcp: McpCaller = { async call() { throw new Error("must not be called"); }, async close() {} };
    const report = await runPurchases({ plan, planSha256: planSha256(plan), evidenceDir: tempDir(), only: "md-rh-eth-snapshot" }, { mcp, chain, sign: async () => ({ ok: false, reason: "no" }), secrets: Secrets.fromEnv({}), out: () => {}, sleep: async () => {} });
    expect(report.stopped?.reason).toMatch(/no delivered and verified inbound/);
  });
});

/* ------------------------------------------------------------------ 署名の振り分け（`runSign`、全レール） */

describe("matrix signer (runSign for every rail)", () => {
  test("x402 EVM signs with the plan's payer; a different key is refused before signing", async () => {
    const plan = await matrixPlan();
    const p = plan.purchases.find((x) => x.routeId === "mx-rh-to-tempo")!;
    const mcp = new MatrixMcp(plan, new MatrixChain());
    const response = await mcp.call("subetha_router_quote", { routeId: p.routeId, requestId: "r" });
    const { createMppPayer } = await import("../../tools/mpp-payer.js");
    const factories = { mppPayer: (k: string, s: never) => createMppPayer(k, s), evmPayer: (k: string) => createX402Payer(k), svmPayer: async () => { throw new Error("no"); }, svmMppPayer: async () => { throw new Error("no"); } } as never;
    const ok = await matrixSignerOf({ SUBETHA_PAYER_PRIVATE_KEY: PAYER_KEY }, factories)(response["quote"], p);
    expect(ok).toMatchObject({ ok: true, kind: "x402-evm", chainId: 46630 });
    const wrong = await matrixSignerOf({ SUBETHA_PAYER_PRIVATE_KEY: generatePrivateKey() }, factories)(response["quote"], p);
    expect(wrong).toMatchObject({ ok: false, fundsMayHaveMoved: false, reason: /does not belong/ });
  });

  test("Tempo MPP: a payer that throws after payAndCredential was entered reports fundsMayHaveMoved; a wrong key is refused before paying", async () => {
    const plan = await matrixPlan();
    const p = plan.purchases.find((x) => x.routeId === "mx-tempo-to-rh")!;
    const response = await new MatrixMcp(plan, new MatrixChain()).call("subetha_router_quote", { routeId: p.routeId, requestId: "r" });
    let paid = 0;
    const factories = (address: string) =>
      ({
        mppPayer: () => ({ address, async payAndCredential() { paid += 1; throw new Error("receipt timeout"); } }),
        evmPayer: () => { throw new Error("no"); },
        svmPayer: async () => { throw new Error("no"); },
        svmMppPayer: async () => { throw new Error("no"); },
      }) as never;
    const moved = await matrixSignerOf({ SUBETHA_PAYER_PRIVATE_KEY: PAYER_KEY }, factories(T7))(response["quote"], p);
    expect(moved, JSON.stringify(moved)).toMatchObject({ ok: false, fundsMayHaveMoved: true });
    expect(paid).toBe(1);
    const refused = await matrixSignerOf({ SUBETHA_PAYER_PRIVATE_KEY: PAYER_KEY }, factories("0x000000000000000000000000000000000000dEaD"))(response["quote"], p);
    expect(refused).toMatchObject({ ok: false, fundsMayHaveMoved: false });
    expect(paid).toBe(1);
  });
});

/* ------------------------------------------------------------------ prefund（§8.5 #3） */

class PrefundChain extends MatrixChain {}

async function prefundPlan(t8Balances: Record<string, bigint> = {}): Promise<PrefundPlan> {
  const chain = new PrefundChain();
  chain.balanceOf = (network, _asset, owner) => (owner === T8 ? (t8Balances[network] ?? 0n) : 10n ** 12n);
  return buildPrefundPlan({ SUBETHA_PAYER_ADDRESS: T7, SUBETHA_ROUTER_RECEIVER: T8 }, chain, () => new Date("2026-10-13T12:00:00Z"));
}

describe("prefund (§8.5 #3)", () => {
  test("needs × 1.5 minus the current T8 balance; new chains split into EIP-3009 pieces of <= 20,000 via the facilitator; Arc and Tempo are ordinary transfers", async () => {
    expect(chunksOf(90_000n)).toEqual([20_000n, 20_000n, 20_000n, 20_000n, 10_000n]);
    const plan = await prefundPlan({ "eip155:421614": 30_000n, "eip155:998": 100_000n });
    const need = Object.fromEntries(plan.needs.map((n) => [n.endpoint, n]));
    expect(need["rh"]).toMatchObject({ legs: 6, need: "60000", target: "90000", topUp: "90000" });
    expect(need["arbsep"]).toMatchObject({ target: "90000", topUp: "60000" });
    expect(need["hyperevm"]).toMatchObject({ topUp: "0" });
    expect(need["arc"]).toMatchObject({ legs: 3, need: "30000", target: "45000" });
    expect(need["tempo"]).toMatchObject({ legs: 3, need: "45000", target: "67500" });
    for (const t of plan.transfers) {
      expect(t.from).toBe(T7);
      expect(t.to).toBe(T8);
      if (t.method === "eip3009_via_self_hosted_facilitator") expect(BigInt(t.amount)).toBeLessThanOrEqual(20_000n);
    }
    expect(plan.transfers.filter((t) => t.endpoint === "rh").map((t) => t.amount)).toEqual(["20000", "20000", "20000", "20000", "10000"]);
    expect(plan.transfers.filter((t) => t.endpoint === "arbsep").map((t) => t.amount)).toEqual(["20000", "20000", "20000"]);
    expect(plan.transfers.filter((t) => t.endpoint === "hyperevm")).toEqual([]);
    expect(plan.transfers.filter((t) => t.endpoint === "arc").map((t) => [t.method, t.amount])).toEqual([["erc20_transfer", "45000"]]);
    expect(plan.transfers.filter((t) => t.endpoint === "tempo").map((t) => [t.method, t.amount])).toEqual([["erc20_transfer", "67500"]]);
    expect(plan.transfers.map((t) => t.index)).toEqual(plan.transfers.map((_, i) => i + 1));
  });

  test("the real facilitator core accepts a prefund piece unchanged (table domain, allowed extra keys, accepted = requirements) and settles 20,000 to T8", async () => {
    const plan = await prefundPlan();
    const t = plan.transfers.find((x) => x.endpoint === "rh")!;
    const nowMs = 1_800_000_000_000;
    const offer = eip3009OfferOf(t, nowMs / 1000, hex64(0x99));
    const credential = await createX402Payer(PAYER_KEY).credentialFor(offer as never, 46630);
    const paymentPayload = JSON.parse(Buffer.from(credential, "base64").toString("utf8")) as Record<string, unknown>;
    const writes: unknown[] = [];
    const io: ChainIo = {
      maxLogRange: 500n,
      maxFeePerGas: 10n ** 10n,
      gasCap: 10n ** 18n,
      maxSettleGas: 200_000n,
      reader: {
        authorizationState: async () => false,
        blockNumber: async () => 100n,
        blockTimestamp: async (n) => nowMs / 1000 - 100 + Number(n),
        authorizationUsedLogs: async () => [],
        receipt: async () => undefined,
        waitForReceipt: async () => ({ status: "success", blockNumber: 100n, gasUsed: 90_000n, effectiveGasPrice: 1n, logs: [{ address: t.asset, topics: [TRANSFER_TOPIC, pad(T7), pad(T8)], data: `0x${(20_000).toString(16).padStart(64, "0")}` }] }),
        feesPerGas: async () => ({ maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n }),
        estimateTransferGas: async () => 90_000n,
      },
      writer: { address: E_FAC as Hex, transferWithAuthorization: async (args) => { writes.push(args); return hex64(0xfeed) as Hex; } },
      verify: async () => ({ isValid: true, payer: T7 }),
    };
    const records: JournalRecord[] = [];
    const f = createEvmFacilitator({ networks: ["eip155:46630"], chains: new Map([["eip155:46630", io]]), journal: { load: async () => records, append: async (r) => void records.push(r) }, payToAllowlist: [T8], clock: { now: () => nowMs } });
    await f.start();
    const token = "t".repeat(40);
    const response = await f.handle({ method: "POST", url: `/${token}/settle`, headers: { host: "127.0.0.1:8611", "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: offer }) }, { token, port: () => 8611 });
    expect(response).toMatchObject({ status: 200, body: { success: true, transaction: hex64(0xfeed) } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ to: T8, value: 20_000n, from: T7 });
    // T8 が allowlist に無ければ拒む（facilitator は緩めない）。
    const g = createEvmFacilitator({ networks: ["eip155:46630"], chains: new Map([["eip155:46630", io]]), journal: { load: async () => [], append: async () => {} }, payToAllowlist: [E_PROV], clock: { now: () => nowMs } });
    await g.start();
    const refused = await g.handle({ method: "POST", url: `/${token}/settle`, headers: { host: "127.0.0.1:8611", "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: offer }) }, { token, port: () => 8611 });
    expect(refused.status).toBe(400);
  });

  test("run: hash-bound, in order, one marker per transfer (never sent twice), stops without retry on an unknown facilitator answer", async () => {
    const plan = await prefundPlan();
    const sha = planSha256(plan);
    const dir = tempDir();
    const file = path.join(dir, "prefund.json");
    writeFileSync(file, JSON.stringify(plan));
    expect(() => loadApprovedPrefundPlan(file, "0".repeat(64))).toThrow(/not the approved/);
    expect(loadApprovedPrefundPlan(file, sha).transfers).toHaveLength(plan.transfers.length);
    const settles: unknown[] = [];
    const transfers: string[] = [];
    let answer = 200;
    const deps: PrefundDeps = {
      payerAddress: T7,
      signAuthorization: (offer, chainId) => createX402Payer(PAYER_KEY).credentialFor(offer as never, chainId),
      async settle(body) {
        settles.push(body);
        return answer === 200 ? { status: 200, body: { success: true, transaction: hex64(0x1000 + settles.length) } } : { status: answer, body: { error: "x" } };
      },
      async transfer(t) {
        transfers.push(t.endpoint);
        return hex64(0x2000 + transfers.length);
      },
      waitReceipt: async () => "success",
      latestBlock: async () => ({ number: 1n, timestamp: 0 }),
      authorizationUsed: async () => false,
      receiptStatus: async () => undefined,
      secrets: Secrets.fromEnv({}),
      out: () => {},
    };
    const first = await runPrefund(plan, sha, dir, deps);
    expect(first.stopped).toBeUndefined();
    expect(first.done).toHaveLength(plan.transfers.length);
    const facilitatorPieces = plan.transfers.filter((t) => t.method === "eip3009_via_self_hosted_facilitator").length;
    expect(settles).toHaveLength(facilitatorPieces);
    for (const body of settles as { paymentPayload: { accepted: unknown }; paymentRequirements: { extra: Record<string, unknown> } }[]) {
      expect(body.paymentPayload.accepted).toEqual(body.paymentRequirements);
      expect(Object.keys(body.paymentRequirements.extra).sort()).toEqual(["challengeNonce", "expiresAt", "name", "version"]);
    }
    expect(transfers).toEqual(["arc", "tempo"]);
    // 同じ plan をもう一度: 1 件目の印で止まり、何も送らない。
    const again = await runPrefund(plan, sha, dir, deps);
    expect(again.stopped?.reason).toMatch(/already attempted/);
    expect(settles).toHaveLength(facilitatorPieces);
    // 不明（5xx）で止まり、残りは送らない。
    const dir2 = tempDir();
    answer = 503;
    const unknown = await runPrefund(plan, sha, dir2, deps);
    expect(unknown.stopped).toMatchObject({ index: 1 });
    expect(unknown.stopped?.reason).toMatch(/unknown/);
    expect(settles).toHaveLength(facilitatorPieces + 1);
    // 鍵が plan の払い手でなければ何もしない。
    await expect(runPrefund(plan, sha, tempDir(), { ...deps, payerAddress: T8 })).rejects.toThrow(/payer/);
  });
});

/* ------------------------------------------------------------------ Codex M-2 の指摘（#1〜#6） */

describe("M-2 #1: cumulative funding from verified initial balances (no credit for incoming payments)", () => {
  test("a plan that is not allSufficient is refused before anything starts", async () => {
    const chain = new MatrixChain();
    chain.balanceOf = (network, asset, owner) => (owner === T8 && network === "eip155:46630" && asset !== null ? 55_000n : 10n ** 24n);
    const plan = await matrixPlan(chain);
    expect(plan.allSufficient).toBe(false);
    // 実行時には残高が増えている（受信の入金）。それでも始めない。
    chain.balanceOf = () => 10n ** 24n;
    const mcp = new MatrixMcp(plan, chain);
    const report = await runMatrix({ plan, planSha256: planSha256(plan), evidenceDir: tempDir(), prefunded: true }, runDeps(mcp, chain, fakeSigner(), []));
    expect(report.stopped?.reason).toMatch(/not allSufficient/);
    expect(mcp.calls).toEqual([]);
  });

  test("at run start the live balance must be >= the plan's initial minus the spend already attempted under this plan", async () => {
    const chain = new MatrixChain();
    chain.balanceOf = (network, asset, owner) => (owner === T8 && network === "eip155:46630" && asset !== null ? 60_000n : 10n ** 24n);
    const plan = await matrixPlan(chain);
    expect(plan.allSufficient).toBe(true);
    const sha = planSha256(plan);
    const dir = tempDir();
    // 5 件の rh 宛ての購入は既に試みた（印）。残りの床は 60,000 − 50,000 = 10,000。
    const rhDest = plan.purchases.filter((p) => p.dst === "rh");
    for (const p of rhDest.slice(0, 5)) createAttemptMarker(dir, sha, p.routeId, { runId: "earlier" });
    chain.balanceOf = (network, asset, owner) => (owner === T8 && network === "eip155:46630" && asset !== null ? 9_999n : 10n ** 24n);
    const mcp = new MatrixMcp(plan, chain);
    const report = await runMatrix({ plan, planSha256: sha, evidenceDir: dir, prefunded: true, only: rhDest[5]!.routeId }, runDeps(mcp, chain, fakeSigner(), []));
    expect(report.stopped?.reason).toMatch(/below the plan's initial 60000 minus 50000 already attempted/);
    expect(mcp.calls).toEqual([]);
    // 床ちょうどなら始める。
    chain.balanceOf = (network, asset, owner) => (owner === T8 && network === "eip155:46630" && asset !== null ? 10_000n : 10n ** 24n);
    const ok = await runMatrix({ plan, planSha256: sha, evidenceDir: dir, prefunded: true, only: rhDest[5]!.routeId }, runDeps(new MatrixMcp(plan, chain), chain, fakeSigner(), []));
    expect(ok.stopped).toBeUndefined();
  });

  test("the ledger charges every attempted purchase (shared Solana account as one key) and never credits receipts", async () => {
    const plan = await matrixPlan();
    const solDebitors = plan.purchases.filter((p) => p.source.family === "svm" || p.destination.family === "svm");
    expect(solDebitors).toHaveLength(12);
    const tight = { ...plan, balances: plan.balances.map((b) => (b.network === SOL_NET && b.kind === "token" ? { ...b, value: "115000" } : b)) } as MatrixPlan;
    const ledger = new MatrixLedger(tight, solDebitors.slice(0, 11).map((p) => p.index));
    // 11 件で 110,000、残り 5,000 < 10,000（どちらの役割の支出も同じ口座から）。
    expect(ledger.shortfall(solDebitors[11]!.index)).toMatch(/5000 left/);
    expect(new MatrixLedger(tight, solDebitors.slice(0, 10).map((p) => p.index)).shortfall(solDebitors[11]!.index)).toBeUndefined();
  });
});

describe("M-2 #2: prefund unknown outcomes hold across plan hashes until reconciled on chain", () => {
  test("the plan fails when a balance cannot be read (it never requests the full target blindly)", async () => {
    const chain = new PrefundChain();
    chain.balanceOf = () => {
      throw new Error("rpc down");
    };
    await expect(buildPrefundPlan({ SUBETHA_PAYER_ADDRESS: T7, SUBETHA_ROUTER_RECEIVER: T8 }, chain)).rejects.toThrow(/could not read a balance/);
  });

  /** 偽の chain: 最新の block の時刻（秒）と、block ごとの authorizationState。 */
  function prefundDeps(state: { used: boolean; blockTimestamp: number; clock: Date; answer: number; settles: unknown[]; reads: bigint[] }): PrefundDeps {
    return {
      payerAddress: T7,
      signAuthorization: (offer, chainId) => createX402Payer(PAYER_KEY).credentialFor(offer as never, chainId),
      async settle(body) {
        state.settles.push(body);
        return state.answer === 200 ? { status: 200, body: { success: true, transaction: hex64(0x3000 + state.settles.length) } } : { status: state.answer, body: {} };
      },
      transfer: async () => hex64(0x4444),
      waitReceipt: async () => "success",
      latestBlock: async () => ({ number: 4242n, timestamp: state.blockTimestamp }),
      async authorizationUsed(_n, _a, _f, _nonce, blockNumber) {
        state.reads.push(blockNumber);
        return state.used;
      },
      receiptStatus: async () => undefined,
      secrets: Secrets.fromEnv({}),
      out: () => {},
      now: () => state.clock,
    };
  }
  const T0 = Date.parse("2026-10-13T12:00:00Z") / 1000;

  test("a 5xx settle is unknown; a regenerated plan is held until the authorization is used on chain; a plan made before that resolution is then refused as stale (M-3 #3)", async () => {
    const dir = tempDir();
    const st = { used: false, blockTimestamp: T0, clock: new Date("2026-10-13T12:00:00Z"), answer: 503, settles: [] as unknown[], reads: [] as bigint[] };
    const deps = prefundDeps(st);
    const planA = await prefundPlan();
    const a = await runPrefund(planA, planSha256(planA), dir, deps);
    expect(a.stopped?.reason).toMatch(/503/);
    expect(unresolvedPrefunds(dir)).toHaveLength(1);
    const planB = { ...planA, createdAt: "2026-10-13T12:05:00.000Z" } as PrefundPlan;
    st.answer = 200;
    st.clock = new Date("2026-10-13T12:05:30Z");
    const b = await runPrefund(planB, planSha256(planB), dir, deps);
    expect(b.stopped?.reason).toMatch(/held: an earlier prefund to the same/);
    expect(st.settles).toHaveLength(1);
    // chain で使用済み → `used` と確定。plan C はその確定より前に作った（不足額が古い）ので送らない。
    st.used = true;
    const planC = { ...planA, createdAt: "2026-10-13T12:06:00.000Z" } as PrefundPlan;
    st.clock = new Date("2026-10-13T12:07:00Z");
    const c = await runPrefund(planC, planSha256(planC), dir, deps);
    expect(c.reconciled).toEqual([{ planSha: planSha256(planA), index: 1, state: "used" }]);
    expect(c.stopped?.reason).toMatch(/make a fresh plan/);
    expect(c.done).toEqual([]);
    expect(st.settles).toHaveLength(1);
    // 確定の後に作った plan（残高を読み直した新しい hash）は進む。
    const planD = { ...planA, createdAt: "2026-10-13T12:08:00.000Z" } as PrefundPlan;
    st.clock = new Date("2026-10-13T12:08:30Z");
    const d = await runPrefund(planD, planSha256(planD), dir, deps);
    expect(d.stopped).toBeUndefined();
  });

  test("expiry is decided by the chain's block time with authorizationState pinned at that block, never by the local clock (M-3 #2)", async () => {
    const dir = tempDir();
    const st = { used: false, blockTimestamp: T0, clock: new Date("2026-10-13T12:00:00Z"), answer: 503, settles: [] as unknown[], reads: [] as bigint[] };
    const deps = prefundDeps(st);
    const planA = await prefundPlan();
    await runPrefund(planA, planSha256(planA), dir, deps);
    const validBefore = unresolvedPrefunds(dir)[0]!.validBefore!;
    // ローカルの時計は 1 日後でも、chain の block の時刻が validBefore 以下なら未確定のまま。
    st.clock = new Date("2026-10-14T12:00:00Z");
    st.blockTimestamp = validBefore;
    const planB = { ...planA, createdAt: "2026-10-14T12:00:00.000Z" } as PrefundPlan;
    const held = await runPrefund(planB, planSha256(planB), dir, deps);
    expect(held.reconciled?.[0]?.state).toMatch(/still unresolved/);
    expect(held.stopped?.reason).toMatch(/held/);
    expect(st.reads.at(-1)).toBe(4242n);
    // block の時刻が validBefore を越え、その block で未使用 → expired_unused。
    st.blockTimestamp = validBefore + 1;
    const released = await runPrefund({ ...planB, createdAt: "2026-10-14T12:00:01.000Z" } as PrefundPlan, planSha256({ ...planB, createdAt: "2026-10-14T12:00:01.000Z" }), dir, { ...deps, settle: async () => ({ status: 200, body: { success: true, transaction: hex64(0x5555) } }) });
    expect(released.reconciled?.[0]?.state).toBe("expired_unused");
    expect(released.stopped).toBeUndefined();
  });

  test("a marker without a record (crash after broadcast, before the record) holds the target until reconciled on chain; an ERC-20 marker without a tx stays held (M-3 #1)", async () => {
    const dir = tempDir();
    const st = { used: false, blockTimestamp: T0, clock: new Date("2026-10-13T12:00:00Z"), answer: 200, settles: [] as unknown[], reads: [] as bigint[] };
    const deps = prefundDeps(st);
    const old = await prefundPlan();
    const oldSha = planSha256({ ...old, createdAt: "2026-10-13T11:00:00.000Z" });
    const rh = old.transfers.find((t) => t.endpoint === "rh")!;
    const arc = old.transfers.find((t) => t.endpoint === "arc")!;
    createAttemptMarker(dir, oldSha, `prefund-${String(rh.index)}`, { at: "x", transfer: rh, nonce: hex64(0xabc), validBefore: T0 + 60 });
    createAttemptMarker(dir, oldSha, `prefund-${String(arc.index)}`, { at: "x", transfer: arc });
    expect(unresolvedPrefunds(dir).map((u) => u.why)).toEqual([expect.stringMatching(/without a record/), expect.stringMatching(/without a record/)]);
    const plan = await prefundPlan();
    const held = await runPrefund(plan, planSha256(plan), dir, deps);
    expect(held.stopped?.reason).toMatch(/held: an earlier prefund/);
    expect(st.settles).toEqual([]);
    // EIP-3009 は印の nonce で照合できる。chain で使用済み → used（記録を作る）。ERC-20 は tx が無いので保留のまま。
    st.used = true;
    st.clock = new Date("2026-10-13T12:01:00Z");
    const results = await (await import("../../tools/evm-testnets-prefund.js")).reconcilePrefunds(dir, deps);
    expect(results.map((r) => r.state)).toEqual(expect.arrayContaining(["used", expect.stringMatching(/still unresolved/)]));
    expect(unresolvedPrefunds(dir).map((u) => u.transfer?.endpoint)).toEqual(["arc"]);
  });
});

describe("M-2 #3/#4: Solana evidence by derived ATA with fixed identity; funds from the source ATA only", () => {
  async function verifyWith(rows: (src: string, dst: string) => SvmTransactionInfo["tokenBalances"]) {
    const chain = new MatrixChain();
    const sig = svmSignature(77);
    const src = await associatedTokenAccountOf(SOL_PAYER, SOL_MINT, TOKEN_PROGRAM);
    const dst = await associatedTokenAccountOf(SOL_RECEIVER, SOL_MINT, TOKEN_PROGRAM);
    chain.svm.set(sig, { ok: true, slot: 1, tokenBalances: rows(src, dst) });
    return verifySvmLeg(chain, "source", { network: SOL_NET, asset: SOL_MINT, amount: "10000", from: SOL_PAYER, to: SOL_RECEIVER }, sig, { waitMs: 0, sleep: async () => {} });
  }
  const row = (accountIndex: number, address: string, preOwner: string | null, postOwner: string, pre: bigint | null, post: bigint) => ({ accountIndex, address, preOwner, preMint: preOwner === null ? null : SOL_MINT, postOwner, postMint: SOL_MINT, pre, post });

  test("exactly the two derived ATAs change by -amount/+amount with unchanged owner and mint", async () => {
    expect((await verifyWith((src, dst) => [row(1, src, SOL_PAYER, SOL_PAYER, 50_000n, 40_000n), row(2, dst, SOL_RECEIVER, SOL_RECEIVER, 0n, 10_000n)])).ok).toBe(true);
    // 宛先 ATA を同じ取引で作る（前が無い）のは許す。
    expect((await verifyWith((src, dst) => [row(1, src, SOL_PAYER, SOL_PAYER, 50_000n, 40_000n), row(2, dst, null, SOL_RECEIVER, null, 10_000n)])).ok).toBe(true);
  });

  test("a transfer followed by an authority change on the source account is rejected (pre owner is kept, not overwritten by post)", async () => {
    const r = await verifyWith((src, dst) => [row(1, src, SOL_PROVIDER, SOL_PAYER, 50_000n, 40_000n), row(2, dst, SOL_RECEIVER, SOL_RECEIVER, 0n, 10_000n)]);
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/source ATA's owner\/mint before/);
    const r2 = await verifyWith((src, dst) => [row(1, src, SOL_PAYER, SOL_PROVIDER, 50_000n, 40_000n), row(2, dst, SOL_RECEIVER, SOL_RECEIVER, 0n, 10_000n)]);
    expect(r2.problem).toMatch(/source ATA's owner\/mint after/);
  });

  test("a debit from another account owned by the payer (not the derived ATA) does not count", async () => {
    const r = await verifyWith((_src, dst) => [row(1, "Other1111111111111111111111111111111111111111", SOL_PAYER, SOL_PAYER, 50_000n, 40_000n), row(2, dst, SOL_RECEIVER, SOL_RECEIVER, 0n, 10_000n)]);
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/source ATA .* is not among/);
  });

  test("the funds read uses the source ATA: missing → 0, frozen → 0, wrong mint/authority/program → refused", () => {
    const expected = { owner: SOL_PAYER, mint: SOL_MINT, tokenProgram: TOKEN_PROGRAM };
    const account = (info: Record<string, unknown>, owner = TOKEN_PROGRAM) => ({ value: { owner, data: { parsed: { info: { mint: SOL_MINT, owner: SOL_PAYER, state: "initialized", tokenAmount: { amount: "123" }, ...info } } } } });
    expect(svmAtaBalanceOf(account({}), expected)).toBe(123n);
    expect(svmAtaBalanceOf({ value: null }, expected)).toBe(0n);
    expect(svmAtaBalanceOf(account({ state: "frozen" }), expected)).toBe(0n);
    expect(() => svmAtaBalanceOf(account({ mint: "So11111111111111111111111111111111111111112" }), expected)).toThrow(/mint or authority/);
    expect(() => svmAtaBalanceOf(account({ owner: SOL_PROVIDER }), expected)).toThrow(/mint or authority/);
    expect(() => svmAtaBalanceOf(account({}, "11111111111111111111111111111111"), expected)).toThrow(/token program/);
  });
});

describe("M-2 #5/#6: a funds-moving signature is never repeated; marker fsync → signInvoked fsync → sign", () => {
  test("a delivered (verified) Tempo route is held under every later plan", async () => {
    const chain = new MatrixChain();
    const plan = await matrixPlan(chain);
    const dir = tempDir();
    const first = await runMatrix({ plan, planSha256: planSha256(plan), evidenceDir: dir, prefunded: true, only: "mx-tempo-to-rh" }, runDeps(new MatrixMcp(plan, chain), chain, fakeSigner(), []));
    expect(first.stopped).toBeUndefined();
    const plan2 = { ...plan, createdAt: "2026-10-13T13:00:00.000Z" } as MatrixPlan;
    const signer2 = fakeSigner();
    const second = await runMatrix({ plan: plan2, planSha256: planSha256(plan2), evidenceDir: dir, prefunded: true, only: "mx-tempo-to-rh" }, runDeps(new MatrixMcp(plan2, chain), chain, signer2, []));
    expect(second.stopped?.reason).toMatch(/funds-moving signature .*never re-signed/);
    expect(signer2.calls).toEqual([]);
    // 署名で資金が動かないレール（x402 Solana）は verified の後に別の plan で再び買える。
    const okFirst = await runMatrix({ plan, planSha256: planSha256(plan), evidenceDir: dir, prefunded: true, only: "mx-sol-to-rh" }, runDeps(new MatrixMcp(plan, chain), chain, fakeSigner(), []));
    expect(okFirst.stopped).toBeUndefined();
    const okSecond = await runMatrix({ plan: plan2, planSha256: planSha256(plan2), evidenceDir: dir, prefunded: true, only: "mx-sol-to-rh" }, runDeps(new MatrixMcp(plan2, chain), chain, fakeSigner(), []));
    expect(okSecond.stopped).toBeUndefined();
  });

  test("at the moment of signing, the attempt marker and the sign marker exist and their directory was fsynced after each, and the evidence already says signInvoked", async () => {
    const chain = new MatrixChain();
    const plan = await matrixPlan(chain);
    const sha = planSha256(plan);
    const dir = tempDir();
    const events: string[] = [];
    setDirSyncForTest((d) => events.push(`fsync:${d}`));
    try {
      const marker = attemptMarkerPathOf(dir, sha, "mx-tempo-to-rh");
      const signMarker = attemptMarkerPathOf(dir, sha, signMarkerIdOf("mx-tempo-to-rh"));
      const markersDir = path.dirname(marker);
      let checked = false;
      const sign: MatrixSigner = async (_q, planned) => {
        events.push("sign");
        expect(existsSync(marker)).toBe(true);
        expect(existsSync(signMarker)).toBe(true);
        expect(JSON.parse(readFileSync(signMarker, "utf8"))).toMatchObject({ fundsMoveAtSign: true, signFor: "mx-tempo-to-rh" });
        // 印の置き場は 2 回以上 fsync 済み（試みの印・署名の印の各作成の後）。
        expect(events.filter((e) => e === `fsync:${markersDir}`).length).toBeGreaterThanOrEqual(4);
        const evidenceFiles = (await import("node:fs")).readdirSync(dir).filter((f) => f.startsWith("run-"));
        const evidence = JSON.parse(readFileSync(path.join(dir, evidenceFiles[0]!, "purchases", "mx-tempo-to-rh.json"), "utf8")) as PurchaseEvidence;
        expect(evidence.signInvoked).toBe(true);
        checked = true;
        return { ok: true, credential: "Y3JlZA==", kind: planned.expectedSign };
      };
      const report = await runMatrix({ plan, planSha256: sha, evidenceDir: dir, prefunded: true, only: "mx-tempo-to-rh" }, runDeps(new MatrixMcp(plan, chain), chain, sign, []));
      expect(report.stopped).toBeUndefined();
      expect(checked).toBe(true);
      // 順: 署名の印の作成の後の fsync → 証跡の fsync → 署名。
      const signAt = events.indexOf("sign");
      const lastMarkerSyncBeforeSign = events.slice(0, signAt).lastIndexOf(`fsync:${markersDir}`);
      expect(lastMarkerSyncBeforeSign).toBeGreaterThan(-1);
      expect(events.slice(lastMarkerSyncBeforeSign, signAt).some((e) => e.endsWith("/purchases"))).toBe(true);
    } finally {
      setDirSyncForTest(undefined);
    }
  });
});

describe("再実行の別名（SUBETHA_MATRIX_RERUNS）", () => {
  test("既定は 30 本のまま。tempo:hyperevm を指定すると同じ組の mx-tempo-to-hyperevm-r2 が 1 本だけ足される。行列に無い組は拒む", async () => {
    const { matrixPairsOf, matrixRerunsOf } = await import("../../tools/remote-mcp-config.js");
    expect(matrixPairsOf()).toHaveLength(30);
    expect(matrixRerunsOf({})).toEqual([]);
    const pairs = matrixPairsOf(matrixRerunsOf({ SUBETHA_MATRIX_RERUNS: "tempo:hyperevm" }));
    expect(pairs).toHaveLength(31);
    expect(pairs[30]).toEqual({ src: "tempo", dst: "hyperevm", routeId: "mx-tempo-to-hyperevm-r2" });
    expect(() => matrixPairsOf(["tempo:arc"])).toThrow();
    expect(() => matrixPairsOf(["rh:rh"])).toThrow();
  });
});
