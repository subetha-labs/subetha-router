/**
 * 掛け合わせの検証の driver（`docs/evm-testnets-x402-design.md` §8・§8.5、owner の依頼 2026-10-13）。**製品コードではない**（運用者の道具）。
 * `tools/evm-testnets-e2e.ts` の `--matrix` から呼ばれる（plan・run。finality・reopen・summary は同じ証跡の形を共有する）。
 *
 * - plan: 30 の `mx-<src>-to-<dst>`（route の条件は専用の設定生成 `evmTestnetsConfigOf(..., { matrix: true })` から）、役割 × レールの資金の表
 *   （**検証した初期残高 − 累計の支出**。入金は数えない。同じアカウントは 1 つにまとめる: Solana のクライアントの鍵 = Router の Solana 送信鍵）。
 * - run（Codex M-2）: plan が `allSufficient` でなければ始めない。初めに各鍵で「今の残高 ≥ plan の初期残高 − この plan で既に試みた支出」を確かめ、
 *   各購入は累計の帳簿（`MatrixLedger`: 初期残高 − 試みた支出。入金は数えない）と今の残高の両方で足りること。署名の前に不変の署名の印（O_EXCL・fsync）。
 *   Solana の残高は払い手の ATA（mint・authority・token program を確かめる）だけ、レグの照合は導出した 2 つの ATA の差と owner・mint の不変。
 * - run: 1 件ずつ、`--prefunded` が必須（行列は Router の送信鍵に事前に入れた資金で払う。外すのは同じ chain の受信の依存だけで、印・保留は残す）。
 *   順序: 保留の検査 → その購入の支出の残高の検査 → 不変の試みの印（O_EXCL・fsync）→ quote → **レールごとの照合**（署名の前）→ `signInvoked` を fsync →
 *   `runSign`（`npm run sign` と同じ振り分け。全レール）→ purchase（1 回）→ status → 両レグの chain の読み取り（EVM は `Transfer`、Solana は owner × mint の残高の差）。
 * - Tempo MPP は **署名で資金が動く**（`tools/sign-run.ts`）。署名を呼んだ後の失敗は全部 `funds_possibly_moved`（tx があれば残す）で止まり、
 *   その route は別の plan でも二度と署名しない（`priorAttemptHold`）。MPP Solana は署名だけ（送出は Router の purchase）。
 *
 * env（値は出さない）: `SUBETHA_PAYER_ADDRESS`／`SUBETHA_PAYER_PRIVATE_KEY`（T7。EVM と Tempo MPP）、`SUBETHA_PAYER_SOLANA_ADDRESS`／`SOLANA_PAYER_PRIVATE_KEY`（T6 の Solana payer。
 * `npm run sign` と同じ名前）、`SOLANA_RPC_URL`（任意、https）、`SUBETHA_ROUTER_RECEIVER`（T8）、`SUBETHA_ARC_RECEIVER_ADDRESS`／`SUBETHA_ARC_RECEIVER_KEY`、
 * `SUBETHA_SOLANA_RECEIVER`、`SUBETHA_SOLANA_OUTBOUND_ADDRESS`／`SUBETHA_OUTBOUND_SOLANA_KEY`、`EVM_FACILITATOR_ADDRESS`／`EVM_FACILITATOR_KEY`、
 * `SUBETHA_EVM_PROVIDER_PAYTO`、`SUBETHA_ARC_PROVIDER_PAYTO`、`SUBETHA_SOLANA_PROVIDER_PAYTO`、`SUBETHA_SOLANA_MPP_PROVIDER_PAYTO`。
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { stableJson } from "../src/core/intent.js";
import { KNOWN_NETWORKS, knownAssetOf, knownNetworkOf } from "../src/shared/networks.js";
import { DEFAULT_MAX_FEE_PER_GAS, DEFAULT_MAX_SETTLE_GAS } from "./evm-facilitator.js";
import {
  addressesOf,
  ASSET_SYMBOL,
  attemptMarkerPathOf,
  attemptMarkerStateOf,
  bodyDigest,
  compactUtc,
  createAttemptMarker,
  createSignMarker,
  deepFreeze,
  DESIGN_GAS_CAPS,
  finalityRuleOf,
  isRecord,
  isTxRefOf,
  journalLinesOf,
  NETWORK_LABEL,
  PlanRefusal,
  planSha256,
  priorAttemptHold,
  quoteRecordOf,
  readAllEvidence,
  readOwnerKey,
  ownerKeyRefOf,
  saveOwnerKey,
  signMarkerIdOf,
  short,
  units,
  verifyLeg,
  viemChainReader,
  withoutBody,
  withStatusDigest,
  writePrivate,
  type ChainReader,
  type FinalityRule,
  type LegEvidence,
  type McpCaller,
  type PlanBalance,
  type PurchaseEvidence,
  type RunReport,
  type Secrets,
  type SvmTransactionInfo,
} from "./evm-testnets-e2e.js";
import { EVM_TESTNETS, evmTestnetsConfigOf, INBOUND, isMatrixNewChain, MATRIX_NEW_CHAINS, MATRIX_RAILS, matrixPairsOf,
  matrixRerunsOf, OUTBOUND, OUTBOUND_X402, UPSTREAM, UPSTREAM_ARC, UPSTREAM_SOL, UPSTREAM_SOL_MPP, UPSTREAM_X402, type MatrixEndpoint, type MatrixNewChain, type MatrixRail } from "./remote-mcp-config.js";
import { checkTempoChallenge } from "./sign-check-tempo.js";
import { runSign, type SignDeps } from "./sign-run.js";
import { checkSvmMppChallenge } from "./svm-mpp-payer.js";

type Env = Readonly<Record<string, string | undefined>>;

export const MATRIX_PLAN_KIND = "subetha-evm-testnets-matrix-plan";
export const MATRIX_PLAN_VERSION = 1;
/**
 * Tempo の送金 1 回の手数料の見込み（pathUSD の最小単位。手数料は fee token = pathUSD で払う）。実測の上限は 79〜706（`docs/dynamic-gas-fee-design.md`）。
 * 資金の表は余裕をみてこの値で数える（実際の額ではない）。
 */
export const TEMPO_FEE_ALLOWANCE = 5_000n;
/** MPP Solana の受信 1 回で payer（fee payer）が払う SOL の見込み（lamports。署名 1 つ 5,000 + 優先手数料の余裕）。 */
export const SOLANA_FEE_ALLOWANCE_LAMPORTS = 20_000n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* ────────────────────────────────────────────────────────────────────────────── plan の型 */

export type ExpectedSign = "x402-evm" | "x402-svm" | "mpp" | "mpp-svm";
/** レグの端点。行列（`mx-*`）は `MatrixEndpoint`、hosted 動的モード（§8.1）は Base Sepolia の x402 も端点になる（`base`）。 */
export type LegEndpoint = MatrixEndpoint | "base";
export interface MatrixLeg {
  readonly endpoint: LegEndpoint;
  readonly rail: "x402" | "mpp";
  readonly scheme: "exact" | "tempo/charge" | "solana/charge";
  readonly family: "evm" | "svm";
  readonly network: string;
  readonly networkLabel: string;
  readonly asset: string;
  readonly assetSymbol: string;
  readonly decimals: number;
  readonly amount: string;
  readonly fromRole: string;
  readonly from: string;
  readonly toRole: string;
  readonly to: string;
  /** 誰が送出し手数料を払うか（表示）。 */
  readonly settledBy: string;
  /** 署名（`runSign`）の時点で資金が動くか（Tempo MPP の受信だけ true）。 */
  readonly fundsMoveAtSign: boolean;
  readonly finalityRule: FinalityRule;
}
export interface MatrixPurchase {
  readonly index: number;
  readonly routeId: string;
  readonly src: LegEndpoint;
  readonly dst: LegEndpoint;
  readonly upstream: string;
  readonly expectedSign: ExpectedSign;
  readonly source: MatrixLeg;
  readonly destination: MatrixLeg;
}
export interface MatrixAddresses {
  readonly payerEvm: string;
  readonly payerSolana: string;
  readonly routerReceiver: string;
  readonly routerOutbound: string;
  readonly arcReceiver: string;
  readonly solanaReceiver: string;
  readonly solanaOutbound: string;
  readonly facilitatorGas: string;
  readonly providerPayTo: string;
  readonly providerB: string;
  readonly arcProvider: string;
  readonly solanaProvider: string;
  readonly solanaMppProvider: string;
}
/** 支出の 1 行（資金の表。順に積む。入金は無い）。 */
export interface MatrixDebit {
  readonly purchase: number;
  readonly routeId: string;
  readonly leg: "source" | "destination";
  readonly role: string;
  readonly address: string;
  readonly network: string;
  readonly kind: "token" | "native";
  readonly asset: string | null;
  readonly amount: string;
  readonly what: string;
}
export interface MatrixCheck {
  readonly role: string;
  readonly address: string;
  readonly network: string;
  readonly kind: "token" | "native";
  readonly asset: string | null;
  readonly need: string;
  readonly have: string | null;
  readonly ok: boolean;
  readonly note: string;
}
export interface MatrixPlan {
  readonly kind: typeof MATRIX_PLAN_KIND;
  readonly version: typeof MATRIX_PLAN_VERSION;
  readonly createdAt: string;
  readonly chains: readonly string[];
  readonly addresses: MatrixAddresses;
  readonly addressSources: Readonly<Record<string, string>>;
  readonly purchases: readonly MatrixPurchase[];
  readonly debits: readonly MatrixDebit[];
  readonly balances: readonly PlanBalance[];
  readonly checks: readonly MatrixCheck[];
  readonly allSufficient: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────── アドレス */

function familyOf(network: string): "evm" | "svm" {
  return network.startsWith("solana:") ? "svm" : "evm";
}
/** アドレスの比較（§8.5 #2）: EVM は大文字小文字を無視、Solana（base58）は完全一致。 */
export function sameAddress(network: string, a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "") return false;
  return familyOf(network) === "svm" ? a === b : a.toLowerCase() === b.toLowerCase();
}
/** 残高の鍵（アドレス × network × 資産）。Solana のアドレスは小文字にしない（base58 は大文字小文字を区別する）。 */
export function matrixBalanceKey(address: string, network: string, asset: string | null): string {
  const svm = familyOf(network) === "svm";
  const a = svm ? address : address.toLowerCase();
  const t = asset === null ? "native" : svm ? asset : asset.toLowerCase();
  return `${a}|${network}|${t}`;
}

async function evmAddressOfKey(key: string): Promise<string> {
  const { privateKeyToAccount } = await import("viem/accounts");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("an EVM private key env is not a 0x-prefixed 32-byte hex string");
  return privateKeyToAccount(key as `0x${string}`).address;
}
async function svmAddressOfKey(key: string): Promise<string> {
  const { svmSignerFromKey } = await import("./svm-payer.js");
  return String((await svmSignerFromKey(key)).address);
}

/** env からアドレスだけを読む（鍵があればアドレスを導く。鍵の値は返さない）。 */
export async function matrixAddressesOf(env: Env): Promise<{ addresses: MatrixAddresses; sources: Record<string, string> }> {
  const { addresses: base, sources } = await addressesOf(env);
  const pick = async (role: string, addressEnv: string, keyEnv: string | undefined, svm: boolean): Promise<string> => {
    const direct = env[addressEnv];
    if (direct !== undefined && direct !== "") {
      if (!(svm ? BASE58 : ADDRESS).test(direct)) throw new Error(`${addressEnv} must be ${svm ? "a base58 Solana address" : "an EVM address"}`);
      sources[role] = addressEnv;
      return direct;
    }
    const key = keyEnv === undefined ? undefined : env[keyEnv];
    if (keyEnv !== undefined && key !== undefined && key !== "") {
      sources[role] = `derived from ${keyEnv}`;
      return svm ? await svmAddressOfKey(key) : await evmAddressOfKey(key);
    }
    throw new Error(`${addressEnv}${keyEnv === undefined ? "" : ` or ${keyEnv}`} is required for the matrix`);
  };
  const payerSolana = await pick("payerSolana", "SUBETHA_PAYER_SOLANA_ADDRESS", "SOLANA_PAYER_PRIVATE_KEY", true);
  const arcReceiver = await pick("arcReceiver", "SUBETHA_ARC_RECEIVER_ADDRESS", "SUBETHA_ARC_RECEIVER_KEY", false);
  const solanaReceiver = await pick("solanaReceiver", "SUBETHA_SOLANA_RECEIVER", undefined, true);
  const solanaOutbound = await pick("solanaOutbound", "SUBETHA_SOLANA_OUTBOUND_ADDRESS", "SUBETHA_OUTBOUND_SOLANA_KEY", true);
  const arcProvider = await pick("arcProvider", "SUBETHA_ARC_PROVIDER_PAYTO", undefined, false);
  const solanaProvider = await pick("solanaProvider", "SUBETHA_SOLANA_PROVIDER_PAYTO", undefined, true);
  const solanaMppProvider = await pick("solanaMppProvider", "SUBETHA_SOLANA_MPP_PROVIDER_PAYTO", undefined, true);
  sources["payerEvm"] = sources["payer"] ?? "";
  sources["providerB"] = "remote-mcp-config OUTBOUND.payTo (Provider B)";
  return {
    addresses: {
      payerEvm: base.payer,
      payerSolana,
      routerReceiver: base.routerReceiver,
      routerOutbound: base.routerOutbound,
      arcReceiver,
      solanaReceiver,
      solanaOutbound,
      facilitatorGas: base.facilitatorGas,
      providerPayTo: base.providerPayTo,
      providerB: OUTBOUND.payTo,
      arcProvider,
      solanaProvider,
      solanaMppProvider,
    },
    sources,
  };
}

/* ────────────────────────────────────────────────────────────────────────────── 購入の並び */

interface RouteTerms {
  readonly rail: string;
  readonly sourceRail: string;
  readonly source: { amount: string; asset: string; decimals: number; network: string; payTo: string };
  readonly destination: { scheme: string; network: string; asset: string; payTo: string };
}

const SOURCE_ROLE: Readonly<Record<MatrixEndpoint, string>> = { rh: "routerReceiver", arbsep: "routerReceiver", hyperevm: "routerReceiver", tempo: "routerReceiver", arc: "arcReceiver", sol: "solanaReceiver", solmpp: "solanaReceiver" };
const DEST_ROLE: Readonly<Record<MatrixEndpoint, string>> = { rh: "providerPayTo", arbsep: "providerPayTo", hyperevm: "providerPayTo", tempo: "providerB", arc: "arcProvider", sol: "solanaProvider", solmpp: "solanaMppProvider" };
const SOURCE_SETTLED_BY: Readonly<Record<MatrixEndpoint, string>> = {
  rh: "self-hosted facilitator (facilitatorGas pays gas)",
  arbsep: "self-hosted facilitator (facilitatorGas pays gas)",
  hyperevm: "self-hosted facilitator (facilitatorGas pays gas)",
  tempo: "the payer broadcasts AT SIGN (MPP tempo/charge; fee in pathUSD; funds move when signing)",
  arc: "Circle facilitator (its gas)",
  sol: "x402.org facilitator (its fee payer)",
  solmpp: "the Router broadcasts at purchase (MPP solana/charge; the payer's key pays the SOL fee)",
};
const DEST_SETTLED_BY: Readonly<Record<MatrixEndpoint, string>> = {
  rh: "local Provider -> self-hosted facilitator (facilitatorGas pays gas)",
  arbsep: "local Provider -> self-hosted facilitator (facilitatorGas pays gas)",
  hyperevm: "local Provider -> self-hosted facilitator (facilitatorGas pays gas)",
  tempo: "the Router broadcasts (MPP tempo/charge to Provider B; fee in pathUSD from routerOutbound)",
  arc: "Arc Provider's facilitator (Circle, its gas)",
  sol: "Solana Provider's facilitator (its fee payer)",
  solmpp: "Provider D's fee payer (MPP solana/charge, pull)",
};
const SIGN_KIND: Readonly<Record<MatrixEndpoint, ExpectedSign>> = { rh: "x402-evm", arbsep: "x402-evm", hyperevm: "x402-evm", tempo: "mpp", arc: "x402-evm", sol: "x402-svm", solmpp: "mpp-svm" };

/** 30 件の購入（route の条件は専用の設定生成から。plan と Router の設定を 1 つの出所に）。 */
export function matrixPurchasesOf(addresses: MatrixAddresses): MatrixPurchase[] {
  const placeholderEnv: Record<string, string> = { SUBETHA_EVM_FACILITATOR_URL: "http://127.0.0.1:1/plan-only", SUBETHA_EVM_PROVIDER_PAYTO: addresses.providerPayTo, SUBETHA_MATRIX_RERUNS: process.env["SUBETHA_MATRIX_RERUNS"] ?? "" };
  for (const chain of MATRIX_NEW_CHAINS) placeholderEnv[`SUBETHA_EVM_PROVIDER_URL_${chain.toUpperCase()}`] = `http://127.0.0.1:1/${chain}`;
  const config = evmTestnetsConfigOf(placeholderEnv, addresses.routerReceiver, MATRIX_NEW_CHAINS, {
    matrix: true,
    receivers: { arc: addresses.arcReceiver, solana: addresses.solanaReceiver },
    providers: { arc: addresses.arcProvider, solana: addresses.solanaProvider, solanaMpp: addresses.solanaMppProvider },
  }) as { router: { routes: Record<string, RouteTerms> } };
  const byRole = addresses as unknown as Record<string, string>;
  // env `SUBETHA_MATRIX_PLAN_ONLY`（routeId の列）: plan をその route だけにする（再実行の別名を 1 本だけ買うとき。資金の表もその分だけ）。
  const only = (process.env["SUBETHA_MATRIX_PLAN_ONLY"] ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  const pairs = matrixPairsOf(matrixRerunsOf(placeholderEnv)).filter((p) => only.length === 0 || only.includes(p.routeId));
  if (only.length > 0 && pairs.length !== only.length) throw new Error("SUBETHA_MATRIX_PLAN_ONLY names a route that is not in the matrix");
  return pairs.map(({ src, dst, routeId }, i) => {
    const route = config.router.routes[routeId];
    if (route === undefined) throw new Error(`the generated config has no route ${routeId}`);
    const s = MATRIX_RAILS[src];
    const d = MATRIX_RAILS[dst];
    const sourceFromRole = s.family === "svm" ? "payerSolana" : "payerEvm";
    const destFromRole = d.family === "svm" ? "solanaOutbound" : "routerOutbound";
    const leg = (endpoint: MatrixEndpoint, rail: typeof s, network: string, asset: string, decimals: number, fromRole: string, toRole: string, to: string, settledBy: string, fundsMoveAtSign: boolean): MatrixLeg => ({
      endpoint,
      rail: rail.rail,
      scheme: rail.scheme,
      family: rail.family,
      network,
      networkLabel: NETWORK_LABEL[network] ?? network,
      asset,
      assetSymbol: ASSET_SYMBOL[network] ?? "?",
      decimals,
      amount: "10000",
      fromRole,
      from: byRole[fromRole] as string,
      toRole,
      to,
      settledBy,
      fundsMoveAtSign,
      finalityRule: finalityRuleOf(network),
    });
    if (route.source.payTo !== byRole[SOURCE_ROLE[src]]) throw new Error(`${routeId}: the generated source.payTo is not the ${SOURCE_ROLE[src]}`);
    return {
      index: i + 1,
      routeId,
      src,
      dst,
      upstream: isMatrixNewChain(dst) ? `${dst} Provider (local wrangler dev --env ${dst})` : `hosted ${dst === "tempo" ? "Provider B (MPP Tempo)" : dst === "arc" ? "Arc Provider (x402)" : dst === "sol" ? "Solana Provider (x402)" : "Provider D (MPP Solana)"}`,
      expectedSign: SIGN_KIND[src],
      source: leg(src, s, route.source.network, route.source.asset, route.source.decimals, sourceFromRole, SOURCE_ROLE[src], route.source.payTo, SOURCE_SETTLED_BY[src], src === "tempo"),
      // 送信レグの額は Provider の 402（quote 時）。§8.1 で各レグ 10,000（1:1）。
      destination: leg(dst, d, route.destination.network, route.destination.asset, d.decimals, destFromRole, DEST_ROLE[dst], route.destination.payTo, DEST_SETTLED_BY[dst], false),
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────────── 資金の表 */

function bigEnv(env: Env, name: string, fallback: bigint): bigint {
  const text = env[name];
  return text !== undefined && /^[1-9][0-9]{0,30}$/.test(text) ? BigInt(text) : fallback;
}
function chainIdOf(network: string): string {
  return network.split(":")[1] ?? "";
}

/** 支出（順に積む）。facilitator の gas は settle ごとに 上限 gas × 見積もり（無ければ上限の単価）で数える。 */
export function matrixDebitsOf(purchases: readonly MatrixPurchase[], addresses: MatrixAddresses, fees: ReadonlyMap<string, bigint | null>, env: Env): MatrixDebit[] {
  const out: MatrixDebit[] = [];
  for (const p of purchases) {
    for (const legName of ["source", "destination"] as const) {
      const l = p[legName];
      out.push({ purchase: p.index, routeId: p.routeId, leg: legName, role: l.fromRole, address: l.from, network: l.network, kind: "token", asset: l.asset, amount: l.amount, what: `${legName} payment` });
      if (l.endpoint === "tempo") out.push({ purchase: p.index, routeId: p.routeId, leg: legName, role: l.fromRole, address: l.from, network: l.network, kind: "token", asset: l.asset, amount: TEMPO_FEE_ALLOWANCE.toString(), what: "Tempo fee allowance (fee token pathUSD)" });
      if (legName === "source" && l.endpoint === "solmpp") out.push({ purchase: p.index, routeId: p.routeId, leg: legName, role: l.fromRole, address: l.from, network: l.network, kind: "native", asset: null, amount: SOLANA_FEE_ALLOWANCE_LAMPORTS.toString(), what: "SOL fee allowance (the payer is the fee payer)" });
      if (isMatrixNewChain(l.endpoint)) {
        const id = chainIdOf(l.network);
        const maxGas = bigEnv(env, `EVM_FACILITATOR_MAX_GAS_${id}`, DEFAULT_MAX_SETTLE_GAS[l.network] ?? 200_000n);
        const fee = fees.get(l.network) ?? bigEnv(env, `EVM_FACILITATOR_MAX_FEE_PER_GAS_${id}`, DEFAULT_MAX_FEE_PER_GAS[l.network] ?? 1_000_000_000n);
        out.push({ purchase: p.index, routeId: p.routeId, leg: legName, role: "facilitatorGas", address: addresses.facilitatorGas, network: l.network, kind: "native", asset: null, amount: (maxGas * fee).toString(), what: `self-hosted facilitator settle gas (max gas ${maxGas.toString()} x ${fee.toString()} wei)` });
      }
    }
  }
  return out;
}

/** 検査（§8.5 #5）: 鍵ごとに **初期残高 ≥ 累計の支出**。入金は数えない。最初に足りなくなる購入を書く。facilitator の gas は process の上限も見る。 */
export function matrixChecksOf(debits: readonly MatrixDebit[], balances: readonly PlanBalance[], env: Env): MatrixCheck[] {
  const have = new Map<string, bigint | null>();
  for (const b of balances) have.set(matrixBalanceKey(b.address, b.network, b.asset), b.value === null ? null : BigInt(b.value));
  const need = new Map<string, { debit: MatrixDebit; total: bigint; shortAt?: MatrixDebit }>();
  for (const d of debits) {
    const key = matrixBalanceKey(d.address, d.network, d.asset);
    const entry = need.get(key) ?? { debit: d, total: 0n };
    entry.total += BigInt(d.amount);
    const h = have.get(key);
    if (entry.shortAt === undefined && (h === undefined || h === null || h < entry.total)) entry.shortAt = d;
    need.set(key, entry);
  }
  const checks: MatrixCheck[] = [];
  for (const [key, { debit, total, shortAt }] of need) {
    const h = have.get(key);
    let ok = shortAt === undefined;
    let note = ok ? "enough for every planned debit (initial balance minus cumulative debits; incoming payments not counted)" : `short at purchase #${String(shortAt?.purchase)} ${shortAt?.routeId ?? ""} (${shortAt?.what ?? ""})`;
    if (debit.role === "facilitatorGas") {
      const cap = bigEnv(env, `EVM_FACILITATOR_GAS_CAP_${chainIdOf(debit.network)}`, DESIGN_GAS_CAPS[debit.network] ?? 0n);
      if (total > cap) ok = false;
      note += `; process gas cap ${cap.toString()} wei`;
    }
    checks.push({ role: debit.role, address: debit.address, network: debit.network, kind: debit.kind, asset: debit.asset, need: total.toString(), have: h === undefined || h === null ? null : h.toString(), ok, note });
  }
  return checks;
}

/** plan を作る（残高は読み取りだけ）。 */
export async function buildMatrixPlan(env: Env, reader: ChainReader, now: () => Date = () => new Date()): Promise<MatrixPlan> {
  const { addresses, sources } = await matrixAddressesOf(env);
  const purchases = matrixPurchasesOf(addresses);
  const fees = new Map<string, bigint | null>();
  for (const chain of MATRIX_NEW_CHAINS) {
    const network = EVM_TESTNETS[chain].network;
    try {
      fees.set(network, await reader.feeEstimate(network));
    } catch {
      fees.set(network, null);
    }
  }
  const debits = matrixDebitsOf(purchases, addresses, fees, env);
  const balances: PlanBalance[] = [];
  const seen = new Set<string>();
  for (const d of debits) {
    const key = matrixBalanceKey(d.address, d.network, d.asset);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const value = d.asset === null ? await reader.nativeBalance(d.network, d.address) : await reader.tokenBalance(d.network, d.asset, d.address);
      balances.push({ role: d.role, address: d.address, network: d.network, kind: d.kind, asset: d.asset, value: value.toString() });
    } catch {
      balances.push({ role: d.role, address: d.address, network: d.network, kind: d.kind, asset: d.asset, value: null, error: "rpc_read_failed" });
    }
  }
  const checks = matrixChecksOf(debits, balances, env);
  return {
    kind: MATRIX_PLAN_KIND,
    version: MATRIX_PLAN_VERSION,
    createdAt: now().toISOString(),
    chains: [...MATRIX_NEW_CHAINS],
    addresses,
    addressSources: sources,
    purchases,
    debits,
    balances,
    checks,
    allSufficient: checks.every((c) => c.ok),
  };
}

/** 人が読む表。 */
export function matrixPlanText(plan: MatrixPlan, sha: string): string {
  const lines: string[] = [];
  lines.push(`Cross-rail matrix plan (design §8/§8.5) — created ${plan.createdAt}`);
  lines.push(`plan sha256 (canonical JSON): ${sha}`);
  lines.push("Nothing is signed by `plan`. `run --matrix --prefunded` refuses unless --plan-sha256 equals this hash.");
  lines.push("Tempo MPP sources move funds AT SIGN; any failure after signing stops the run as funds_possibly_moved and that route is never re-signed.");
  lines.push("");
  lines.push("Addresses:");
  for (const [role, address] of Object.entries(plan.addresses)) lines.push(`  ${role.padEnd(18)} ${address}  (${plan.addressSources[role] ?? ""})`);
  lines.push("");
  lines.push("Purchases (one at a time, in this order; any non-delivered result stops the run, no retries):");
  for (const p of plan.purchases) {
    lines.push(`  #${String(p.index).padEnd(2)} ${p.routeId}  sign: ${p.expectedSign}  upstream: ${p.upstream}`);
    for (const [name, l] of [["src", p.source], ["dst", p.destination]] as const) {
      lines.push(`       ${name} ${l.rail}/${l.scheme} ${l.networkLabel}: ${l.fromRole} ${short(l.from)} -> ${l.toRole} ${short(l.to)}  ${l.amount} / ${String(l.decimals)} (${units(l.amount, l.decimals)} ${l.assetSymbol}); ${l.settledBy}; finality ${l.finalityRule}`);
    }
  }
  lines.push("");
  lines.push("Funds per role and rail (initial balance vs cumulative debits; incoming payments are not counted):");
  for (const c of plan.checks) {
    const unit = c.kind === "native" ? "native" : (ASSET_SYMBOL[c.network] ?? "token");
    lines.push(`  [${c.ok ? "ok" : "SHORT"}] ${c.role.padEnd(18)} ${short(c.address)}  ${(NETWORK_LABEL[c.network] ?? c.network).padEnd(26)} ${unit.padEnd(8)} need ${c.need} have ${c.have ?? "?"} — ${c.note}`);
  }
  lines.push("");
  lines.push(`All payers sufficient: ${plan.allSufficient ? "yes" : "NO"}`);
  return `${lines.join("\n")}\n`;
}

/** plan を読み、canonical sha256 が一致するときだけ返す。 */
export function loadApprovedMatrixPlan(file: string, expectedSha: string): MatrixPlan {
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new PlanRefusal("--plan-sha256 must be 64 lowercase hex characters");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PlanRefusal("the plan file is not readable JSON");
  }
  const actual = planSha256(parsed);
  if (actual !== expectedSha) throw new PlanRefusal(`the plan's canonical sha256 is ${actual}, not the approved ${expectedSha}; refusing`);
  const plan = parsed as MatrixPlan;
  if (plan.kind !== MATRIX_PLAN_KIND || plan.version !== MATRIX_PLAN_VERSION || !Array.isArray(plan.purchases)) throw new PlanRefusal("not a matrix plan of a known version");
  return plan;
}

/* ────────────────────────────────────────────────────────────────────────────── 照合（署名の前。§8.5 #2） */

/** quote の応答をレールごとに plan と照合する。不一致の一覧（空なら一致）。 */
export function matrixSubjectMismatches(response: Record<string, unknown>, planned: MatrixPurchase, nowMs: number): string[] {
  const problems: string[] = [];
  const subject = response["subject"];
  const quote = response["quote"];
  if (response["ok"] !== true || !isRecord(subject) || !isRecord(quote)) return ["the quote did not succeed or has no subject/quote"];
  const src = planned.source;
  const dst = planned.destination;
  const eq = (label: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected) problems.push(`${label}: got ${JSON.stringify(actual)}, plan ${JSON.stringify(expected)}`);
  };
  const addr = (label: string, network: string, actual: unknown, expected: string): void => {
    if (!sameAddress(network, actual, expected)) problems.push(`${label}: got ${JSON.stringify(actual)}, plan ${JSON.stringify(expected)}`);
  };
  eq("subject.routeId", subject["routeId"], planned.routeId);
  eq("quote.routeId", quote["routeId"], planned.routeId);
  eq("quote.quoteId = subject.quoteId", quote["quoteId"], subject["quoteId"]);
  if (typeof subject["quoteId"] !== "string" || subject["quoteId"] === "") problems.push("subject.quoteId is missing");
  if (typeof subject["paymentId"] !== "string" || subject["paymentId"] === "") problems.push("subject.paymentId is missing");
  if (quote["upstream"] !== undefined || quote["ownerKey"] !== undefined) problems.push("the quote is dynamic (upstream/ownerKey present); the plan is for static routes");
  problems.push(...sourceOfferProblems(subject, quote, src, src.amount, nowMs));
  const d = isRecord(subject["destination"]) ? subject["destination"] : {};
  const qd = isRecord(quote["destination"]) ? quote["destination"] : {};
  eq("subject.destination.network", d["network"], dst.network);
  addr("subject.destination.asset", dst.network, d["asset"], dst.asset);
  eq("subject.destination.quoted", d["quoted"], dst.amount);
  eq("quote.destination.network", qd["network"], dst.network);
  addr("quote.destination.asset", dst.network, qd["asset"], dst.asset);
  eq("quote.destination.quoted", qd["quoted"], dst.amount);
  addr("quote.destination.payTo (upstream recipient)", dst.network, qd["payTo"], dst.to);
  // 承認: subject と、署名する quote 文書の両方（Codex H-5 #1）。required・この quote への束縛・同じ有限の期限・期限の前、がそろわなければ署名しない
  // （subject だけを見ると、期限の切れた quote 文書に Tempo の送金を署名し得る）。
  const approvalProblems = (label: string, value: unknown): number | undefined => {
    if (!isRecord(value)) {
      problems.push(`${label} is missing`);
      return undefined;
    }
    eq(`${label}.required`, value["required"], true);
    eq(`${label}.boundTo = subject.quoteId`, value["boundTo"], subject["quoteId"]);
    const deadline = value["deadlineMs"];
    if (typeof deadline !== "number" || !Number.isFinite(deadline)) {
      problems.push(`${label}.deadlineMs is missing or not a finite number`);
      return undefined;
    }
    if (deadline <= nowMs) problems.push(`${label}.deadlineMs has passed`);
    return deadline;
  };
  const subjectDeadline = approvalProblems("subject.approval", subject["approval"]);
  const quoteDeadline = approvalProblems("quote.approval", quote["approval"]);
  if (subjectDeadline !== undefined && quoteDeadline !== undefined && subjectDeadline !== quoteDeadline) problems.push("quote.approval.deadlineMs differs from subject.approval.deadlineMs");
  return problems;
}

/**
 * 受信のレグ（subject・署名される offer・埋め込みの challenge）の照合（§8.5 #2）。静的の行列と hosted 動的モードで共有する。
 * `amount` は期待する受信額（静的は plan の額、hosted は照合済みの `pricing.total`）。不一致の一覧（空なら一致）。
 */
export function sourceOfferProblems(subject: Record<string, unknown>, quote: Record<string, unknown>, src: MatrixLeg, amount: string, nowMs: number): string[] {
  const problems: string[] = [];
  const eq = (label: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected) problems.push(`${label}: got ${JSON.stringify(actual)}, plan ${JSON.stringify(expected)}`);
  };
  const addr = (label: string, network: string, actual: unknown, expected: string): void => {
    if (!sameAddress(network, actual, expected)) problems.push(`${label}: got ${JSON.stringify(actual)}, plan ${JSON.stringify(expected)}`);
  };
  const s = isRecord(subject["source"]) ? subject["source"] : {};
  const qs = isRecord(quote["source"]) ? quote["source"] : {};
  eq("subject.source.network", s["network"], src.network);
  addr("subject.source.asset", src.network, s["asset"], src.asset);
  eq("subject.source.amount", s["amount"], amount);
  eq("subject.source.decimals", s["decimals"], src.decimals);
  eq("quote.source.network", qs["network"], src.network);
  addr("quote.source.asset", src.network, qs["asset"], src.asset);
  eq("quote.source.amount", qs["amount"], amount);
  const shownOffer = isRecord(s["offer"]) ? s["offer"] : {};
  const signedOffer = isRecord(qs["offer"]) ? qs["offer"] : undefined;
  if (signedOffer === undefined) problems.push("quote.source.offer (the offer that would be signed) is missing");
  else if (stableJson(signedOffer) !== stableJson(shownOffer)) problems.push("quote.source.offer (the offer that would be signed) differs from subject.source.offer (the offer shown for approval)");
  const moves = src.rail === "mpp";
  const entry = knownNetworkOf(KNOWN_NETWORKS, src.network);
  const known = entry === undefined ? undefined : knownAssetOf(entry, src.asset);
  for (const [label, o] of [["subject offer", shownOffer], ["signed offer", signedOffer ?? {}]] as const) {
    eq(`${label}.scheme`, o["scheme"], src.scheme);
    eq(`${label}.network`, o["network"], src.network);
    addr(`${label}.asset`, src.network, o["asset"], src.asset);
    eq(`${label}.amount`, o["amount"], amount);
    addr(`${label}.payTo (Router receiver)`, src.network, o["payTo"], src.to);
    const extra = isRecord(o["extra"]) ? o["extra"] : {};
    eq(`${label}.extra.fundsMoveOnCredential`, extra["fundsMoveOnCredential"], moves);
    eq(`${label}.extra.challengeNonce = quoteId`, extra["challengeNonce"], subject["quoteId"]);
    if (known === undefined) {
      problems.push(`${label}: the planned source asset is not in the table`);
      continue;
    }
    if (src.scheme === "exact" && src.family === "evm") {
      if (known.domain === undefined) problems.push(`${label}: the table has no EIP-712 domain for the planned asset`);
      else {
        eq(`${label}.extra.name (table domain)`, extra["name"], known.domain.name);
        eq(`${label}.extra.version (table domain)`, extra["version"], known.domain.version);
      }
    } else if (src.scheme === "exact") {
      if (typeof extra["feePayer"] !== "string" || extra["feePayer"] === "") problems.push(`${label}.extra.feePayer is missing`);
      if (extra["memo"] !== extra["challengeNonce"]) problems.push(`${label}.extra.memo must be the challengeNonce`);
      for (const k of ["decimals", "tokenProgram", "mint"] as const) {
        const want = k === "decimals" ? known.decimals : k === "tokenProgram" ? known.tokenProgram : known.id;
        if (extra[k] !== undefined && extra[k] !== want) problems.push(`${label}.extra.${k} conflicts with the table`);
      }
    } else {
      // MPP: 中身（challenge）を封筒・表と照合する（SDK は challenge の中身から送金を組む）。
      const challenge = extra["challenge"];
      if (typeof challenge !== "string" || challenge === "") {
        problems.push(`${label}.extra.challenge is missing`);
      } else if (src.scheme === "tempo/charge") {
        const checked = checkTempoChallenge(challenge, { amount: String(o["amount"]), asset: String(o["asset"]), payTo: String(o["payTo"]), extra }, Number(chainIdOf(src.network)), nowMs);
        if (!checked.ok) problems.push(`${label}.extra.challenge: ${checked.reason}`);
      } else {
        if (known.tokenProgram === undefined) problems.push(`${label}: the table has no token program`);
        else {
          const checked = checkSvmMppChallenge(challenge, { amount: String(o["amount"]), payTo: String(o["payTo"]), extra }, { mint: known.id, decimals: known.decimals, tokenProgram: known.tokenProgram }, nowMs);
          if (!checked.ok) problems.push(`${label}.extra.challenge: ${checked.reason}`);
        }
        if (extra["decimals"] !== undefined && extra["decimals"] !== known.decimals) problems.push(`${label}.extra.decimals conflicts with the table`);
        if (extra["tokenProgram"] !== undefined && extra["tokenProgram"] !== known.tokenProgram) problems.push(`${label}.extra.tokenProgram conflicts with the table`);
      }
    }
  }
  eq("subject.fundsMoveOnCredential", subject["fundsMoveOnCredential"], moves);
  return problems;
}

/* ────────────────────────────────────────────────────────────────────────────── 署名（`npm run sign` と同じ `runSign`、全レール） */

export type MatrixSignResult =
  | { readonly ok: true; readonly credential: string; readonly kind: ExpectedSign; readonly chainId?: number; readonly txRef?: string }
  | { readonly ok: false; readonly reason: string; readonly fundsMayHaveMoved: boolean; readonly txRef?: string };
export type MatrixSigner = (quote: unknown, planned: MatrixPurchase) => Promise<MatrixSignResult>;

/** payer の作り方（試験が差し替える）。本番は `runSignMatrixSigner`。 */
export type MatrixPayerFactories = Pick<SignDeps, "mppPayer" | "evmPayer" | "svmPayer" | "svmMppPayer">;

/**
 * `runSign` に全レールの payer を渡す。payer の address が plan の払い手と違えば **署名・送金の前に** 止める（EVM は大文字小文字を無視、Solana は完全一致）。
 * Tempo MPP の payer の `payAndCredential` を呼んだ後の失敗は `fundsMayHaveMoved: true`（tx があれば返す）。
 */
export function matrixSignerOf(env: Env, factories: MatrixPayerFactories, nowMs: () => number = Date.now): MatrixSigner {
  return async (quote, planned) => {
    const evmKey = env["SUBETHA_PAYER_PRIVATE_KEY"];
    const solKey = env["SOLANA_PAYER_PRIVATE_KEY"];
    const rpc = env["SOLANA_RPC_URL"];
    const expectFrom = (address: string): void => {
      if (!sameAddress(planned.source.network, address, planned.source.from)) throw new MatrixSignBlocked("the payer key does not belong to the plan's payer address");
    };
    let paying = false;
    let txRef: string | undefined;
    try {
      const outcome = await runSign(quote, {
        nowMs,
        readEvmKey: () => {
          if (evmKey === undefined || evmKey === "") throw new MatrixSignBlocked("SUBETHA_PAYER_PRIVATE_KEY is not set");
          return evmKey;
        },
        readSolanaKey: () => {
          if (solKey === undefined || solKey === "") throw new MatrixSignBlocked("SOLANA_PAYER_PRIVATE_KEY is not set");
          return solKey;
        },
        ...(rpc === undefined || rpc === "" ? {} : { solanaRpcUrl: rpc }),
        mppPayer: (key, scope) => {
          const payer = factories.mppPayer(key, scope);
          expectFrom(payer.address);
          return {
            address: payer.address,
            async payAndCredential(offer: never) {
              // ここから先は資金が動き得る（Tempo MPP の push）。
              paying = true;
              const result = await payer.payAndCredential(offer);
              txRef = result.txRef;
              return result;
            },
          };
        },
        evmPayer: (key) => {
          const payer = factories.evmPayer(key);
          expectFrom(payer.address);
          return payer;
        },
        svmPayer: async (key, options) => {
          const payer = await factories.svmPayer(key, options);
          expectFrom(payer.address);
          return payer;
        },
        svmMppPayer: async (key, options) => {
          const payer = await factories.svmMppPayer(key, options);
          expectFrom(payer.address);
          return payer;
        },
        stderr: () => {},
      });
      if (!outcome.ok) return { ok: false, reason: outcome.reason, fundsMayHaveMoved: paying, ...(txRef === undefined ? {} : { txRef }) };
      const kind = outcome.dispatch.kind as ExpectedSign;
      return { ok: true, credential: outcome.stdout.trim(), kind, ...(outcome.dispatch.kind === "x402-evm" ? { chainId: outcome.dispatch.chainId } : {}), ...(txRef === undefined ? {} : { txRef }) };
    } catch (error) {
      // 例外の文言に鍵は入らない（固定文）。知らない例外は固定文に寄せる。
      const reason = error instanceof MatrixSignBlocked ? error.message : "signing failed";
      return { ok: false, reason, fundsMayHaveMoved: paying, ...(txRef === undefined ? {} : { txRef }) };
    }
  };
}
class MatrixSignBlocked extends Error {}

/** 本番の payer（`tools/sign-payment.ts` と同じ factory）。 */
export async function runSignMatrixSigner(env: Env): Promise<MatrixSigner> {
  const [{ createMppPayer }, { createX402Payer }, { createSvmPayer }, { createSvmMppPayer }] = await Promise.all([import("./mpp-payer.js"), import("./x402-payer.js"), import("./svm-payer.js"), import("./svm-mpp-payer.js")]);
  return matrixSignerOf(env, {
    mppPayer: (key, scope) => createMppPayer(key, scope),
    evmPayer: (key) => createX402Payer(key),
    svmPayer: (key, options) => createSvmPayer(key, options),
    svmMppPayer: (key, options) => createSvmMppPayer(key, options),
  });
}

/* ────────────────────────────────────────────────────────────────────────────── chain の読み取り（Solana を足す） */

/** Solana の JSON-RPC（読み取りだけ。https、15 秒、再試行なし）。 */
export function svmRpcUrlOf(env: Env): string {
  const url = env["SOLANA_RPC_URL"];
  const chosen = url === undefined || url === "" ? "https://api.devnet.solana.com" : url;
  if (!/^https:\/\//.test(chosen)) throw new Error("SOLANA_RPC_URL must be an https URL");
  return chosen;
}

async function svmRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) throw new Error(`solana rpc http ${String(response.status)}`);
  const json = (await response.json()) as { result?: unknown; error?: unknown };
  if (json.error !== undefined) throw new Error("solana rpc error");
  return json.result;
}

/**
 * `getTransaction`（jsonParsed）の応答を要約する（純粋。試験で確かめる）。アカウントごとに、アドレス（`accountKeys[accountIndex]`。jsonParsed は
 * lookup table のアドレスも並びに含む）と、**前と後の owner・mint を別々に** 残す（後の値で前を上書きしない。Codex M-2 #3）。
 */
export function svmTransactionInfoOf(result: unknown): SvmTransactionInfo | undefined {
  if (!isRecord(result)) return undefined;
  const meta = isRecord(result["meta"]) ? result["meta"] : undefined;
  if (meta === undefined) return undefined;
  const transaction = isRecord(result["transaction"]) ? result["transaction"] : {};
  const message = isRecord(transaction["message"]) ? transaction["message"] : {};
  const keys: (string | null)[] = (Array.isArray(message["accountKeys"]) ? message["accountKeys"] : []).map((k) => (typeof k === "string" ? k : isRecord(k) && typeof k["pubkey"] === "string" ? k["pubkey"] : null));
  const rows = (list: unknown): { accountIndex: number; owner: string; mint: string; amount: bigint }[] =>
    (Array.isArray(list) ? list : []).flatMap((b) => {
      if (!isRecord(b) || typeof b["owner"] !== "string" || typeof b["mint"] !== "string" || typeof b["accountIndex"] !== "number") return [];
      const ui = isRecord(b["uiTokenAmount"]) ? b["uiTokenAmount"] : {};
      return typeof ui["amount"] === "string" && /^[0-9]+$/.test(ui["amount"]) ? [{ accountIndex: b["accountIndex"], owner: b["owner"], mint: b["mint"], amount: BigInt(ui["amount"]) }] : [];
    });
  const pre = rows(meta["preTokenBalances"]);
  const post = rows(meta["postTokenBalances"]);
  const indexes = [...new Set([...pre, ...post].map((r) => r.accountIndex))].sort((a, b) => a - b);
  const tokenBalances = indexes.map((accountIndex) => {
    const a = pre.find((r) => r.accountIndex === accountIndex);
    const b = post.find((r) => r.accountIndex === accountIndex);
    return { accountIndex, address: keys[accountIndex] ?? null, preOwner: a?.owner ?? null, preMint: a?.mint ?? null, postOwner: b?.owner ?? null, postMint: b?.mint ?? null, pre: a?.amount ?? null, post: b?.amount ?? null };
  });
  return { ok: meta["err"] === null, slot: typeof result["slot"] === "number" ? result["slot"] : -1, tokenBalances };
}

/** 表の mint の token program（Solana）。 */
function tokenProgramOf(network: string, mint: string): string {
  const entry = knownNetworkOf(KNOWN_NETWORKS, network);
  const known = entry === undefined ? undefined : knownAssetOf(entry, mint);
  if (known?.tokenProgram === undefined) throw new Error(`the table has no token program for ${mint} on ${network}`);
  return known.tokenProgram;
}
/** owner × mint × token program の ATA（payer が送金に使う口座。`tools/svm-payer.ts`・`tools/svm-mpp-payer.ts` と同じ導出）。 */
export async function associatedTokenAccountOf(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const [{ address }, { findAssociatedTokenPda }] = await Promise.all([import("@solana/kit"), import("@solana-program/token")]);
  const [ata] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(tokenProgram) });
  return String(ata);
}

/**
 * ATA の `getAccountInfo`（jsonParsed）から **使える残高** を読む（純粋。Codex M-2 #4）: 口座が無ければ 0。program が表の token program、
 * mint・authority（owner）が期待どおり、状態が `initialized`（凍結は 0）でなければ例外（残高と数えない）。
 */
export function svmAtaBalanceOf(result: unknown, expected: { owner: string; mint: string; tokenProgram: string }): bigint {
  const value = isRecord(result) ? result["value"] : undefined;
  if (value === null || value === undefined) return 0n;
  if (!isRecord(value) || value["owner"] !== expected.tokenProgram) throw new Error("the source ATA is not owned by the table's token program");
  const data = isRecord(value["data"]) ? value["data"] : {};
  const parsed = isRecord(data["parsed"]) ? data["parsed"] : {};
  const info = isRecord(parsed["info"]) ? parsed["info"] : {};
  if (info["mint"] !== expected.mint || info["owner"] !== expected.owner) throw new Error("the source ATA's mint or authority differs from the plan");
  if (info["state"] !== "initialized") return 0n;
  const amount = isRecord(info["tokenAmount"]) ? info["tokenAmount"]["amount"] : undefined;
  if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) throw new Error("the source ATA's amount is unreadable");
  return BigInt(amount);
}

/** EVM（viem）に Solana の読み取りを足した reader。 */
export async function matrixChainReader(env: Env): Promise<ChainReader> {
  const evm = await viemChainReader(env);
  const rpc = svmRpcUrlOf(env);
  return {
    async tokenBalance(network, asset, owner) {
      if (familyOf(network) === "evm") return await evm.tokenBalance(network, asset, owner);
      // 払い手が実際に使う口座（ATA）だけ。ほかの token 口座は数えない（Codex M-2 #4）。
      const tokenProgram = tokenProgramOf(network, asset);
      const ata = await associatedTokenAccountOf(owner, asset, tokenProgram);
      const result = await svmRpc(rpc, "getAccountInfo", [ata, { encoding: "jsonParsed", commitment: "confirmed" }]);
      return svmAtaBalanceOf(result, { owner, mint: asset, tokenProgram });
    },
    async nativeBalance(network, owner) {
      if (familyOf(network) === "evm") return await evm.nativeBalance(network, owner);
      const result = await svmRpc(rpc, "getBalance", [owner, { commitment: "confirmed" }]);
      const value = isRecord(result) ? result["value"] : undefined;
      if (typeof value !== "number") throw new Error("solana getBalance: unexpected form");
      return BigInt(value);
    },
    feeEstimate: (network) => evm.feeEstimate(network),
    receipt: (network, hash) => evm.receipt(network, hash),
    finalizedBlock: (network) => evm.finalizedBlock(network),
    async svmTransaction(_network, signature) {
      const result = await svmRpc(rpc, "getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      return result === null ? undefined : svmTransactionInfoOf(result);
    },
    async svmSignatureStatus(_network, signature) {
      const result = await svmRpc(rpc, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      const value = isRecord(result) && Array.isArray(result["value"]) ? result["value"][0] : undefined;
      if (!isRecord(value)) return undefined;
      return { confirmationStatus: typeof value["confirmationStatus"] === "string" ? value["confirmationStatus"] : null, err: value["err"] ?? null, slot: typeof value["slot"] === "number" ? value["slot"] : -1 };
    },
  };
}

/**
 * Solana のレグの照合（§8.5 #4・Codex M-2 #3）: 署名の形、取引の成功、そして **導出した 2 つの ATA**（from × mint、to × mint、表の token program）が
 * ちょうど −amount と +amount だけ変わり、その 2 口座の owner（authority）・mint が前後とも計画どおり（変わっていない）こと。
 * 口座の新規作成（前が無い）は宛先だけ、前の額 0 として許す。待つのは `waitMs` まで（commitment `confirmed`）。
 */
export async function verifySvmLeg(reader: ChainReader, leg: "source" | "destination", planned: Pick<MatrixLeg, "network" | "asset" | "amount" | "from" | "to">, signature: unknown, opts: { waitMs: number; sleep: (ms: number) => Promise<void> }): Promise<LegEvidence> {
  const expected = { from: planned.from, to: planned.to, value: planned.amount };
  const base = { leg, network: planned.network, token: planned.asset, expected, blockHash: null };
  if (!isTxRefOf(planned.network, signature)) return { ...base, txHash: typeof signature === "string" ? signature : null, receiptStatus: null, blockNumber: null, transfer: null, ok: false, problem: "no Solana signature recorded for this leg" };
  if (reader.svmTransaction === undefined) return { ...base, txHash: signature, receiptStatus: null, blockNumber: null, transfer: null, ok: false, problem: "the chain reader cannot read Solana transactions" };
  let info: SvmTransactionInfo | undefined;
  const deadline = Date.now() + opts.waitMs;
  try {
    for (;;) {
      info = await reader.svmTransaction(planned.network, signature);
      if (info !== undefined || Date.now() >= deadline) break;
      await opts.sleep(3_000);
    }
  } catch {
    return { ...base, txHash: signature, receiptStatus: null, blockNumber: null, transfer: null, ok: false, problem: "transaction read failed (RPC)" };
  }
  if (info === undefined) return { ...base, txHash: signature, receiptStatus: null, blockNumber: null, transfer: null, ok: false, problem: "no transaction found" };
  const tokenProgram = tokenProgramOf(planned.network, planned.asset);
  const sourceAta = await associatedTokenAccountOf(planned.from, planned.asset, tokenProgram);
  const destinationAta = await associatedTokenAccountOf(planned.to, planned.asset, tokenProgram);
  const amount = BigInt(planned.amount);
  const problems: string[] = [];
  const deltaOf = (ata: string, owner: string, side: "source" | "destination"): bigint | undefined => {
    const rows = info!.tokenBalances.filter((b) => b.address === ata);
    if (rows.length !== 1) {
      problems.push(`the ${side} ATA ${ata} ${rows.length === 0 ? "is not among the token balance changes" : "appears more than once"}`);
      return undefined;
    }
    const row = rows[0]!;
    if (row.postOwner !== owner || row.postMint !== planned.asset) problems.push(`the ${side} ATA's owner/mint after the transaction differs from the plan`);
    if (row.pre !== null && (row.preOwner !== owner || row.preMint !== planned.asset)) problems.push(`the ${side} ATA's owner/mint before the transaction differs from the plan`);
    if (row.pre === null && side === "source") problems.push("the source ATA has no balance before the transaction");
    if (row.post === null) {
      problems.push(`the ${side} ATA has no balance after the transaction`);
      return undefined;
    }
    return row.post - (row.pre ?? 0n);
  };
  const fromDelta = deltaOf(sourceAta, planned.from, "source");
  const toDelta = deltaOf(destinationAta, planned.to, "destination");
  const common = { ...base, txHash: signature, receiptStatus: info.ok ? "success" : "failed", blockNumber: String(info.slot), transfer: { from: sourceAta, to: destinationAta, value: (toDelta ?? 0n).toString(), logIndex: -1 } };
  if (!info.ok) return { ...common, ok: false, problem: "the transaction failed (meta.err is set)" };
  if (fromDelta !== undefined && toDelta !== undefined && (toDelta !== amount || fromDelta !== -amount)) problems.push(`token balance changes differ from the quote (destination ATA ${toDelta.toString()}, source ATA ${fromDelta.toString()}, expected ±${amount.toString()} of ${planned.asset})`);
  if (problems.length > 0) return { ...common, ok: false, problem: problems.join("; ") };
  return { ...common, ok: true };
}

/** レグの照合（family で振り分け）。EVM は `Transfer`（Tempo pathUSD も TIP-20 の `Transfer`。手数料の Transfer は fee manager 宛てで数えない）。 */
export async function verifyMatrixLeg(reader: ChainReader, leg: "source" | "destination", planned: MatrixLeg, txRef: unknown, opts: { waitMs: number; sleep: (ms: number) => Promise<void> }): Promise<LegEvidence> {
  return planned.family === "svm" ? await verifySvmLeg(reader, leg, planned, txRef, opts) : await verifyLeg(reader, leg, planned, txRef, opts);
}

/* ────────────────────────────────────────────────────────────────────────────── run */

export interface MatrixRunOptions {
  readonly plan: MatrixPlan;
  readonly planSha256: string;
  readonly evidenceDir: string;
  readonly only?: string | undefined;
  /** 必須（行列は事前の入金で払う。§8.2）。 */
  readonly prefunded: boolean;
  readonly routerJournal?: string | undefined;
  readonly facilitatorJournal?: string | undefined;
  readonly facilitatorLog?: string | undefined;
}
export interface MatrixRunDeps {
  readonly mcp: McpCaller;
  readonly chain: ChainReader;
  readonly sign: MatrixSigner;
  readonly secrets: Secrets;
  readonly out: (line: string) => void;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly receiptWaitMs?: number;
  readonly requestIdOf?: (routeId: string) => string;
}


/** 実行が使う plan の部分（帳簿・残高の検査。静的の行列と hosted 動的モードで共有）。 */
export interface FundedPlan<P extends MatrixPurchase = MatrixPurchase> {
  readonly purchases: readonly P[];
  readonly debits: readonly MatrixDebit[];
  readonly balances: readonly PlanBalance[];
  readonly allSufficient: boolean;
}

/** その購入の支出を今の残高と比べる（足りなければ理由。読めなければ理由）。 */
async function fundsShortfall(reader: ChainReader, plan: Pick<FundedPlan, "debits">, planned: MatrixPurchase): Promise<{ short: string | undefined; balances: PlanBalance[] }> {
  const mine = plan.debits.filter((d) => d.purchase === planned.index);
  const totals = new Map<string, { d: MatrixDebit; total: bigint }>();
  for (const d of mine) {
    const key = matrixBalanceKey(d.address, d.network, d.asset);
    const t = totals.get(key) ?? { d, total: 0n };
    t.total += BigInt(d.amount);
    totals.set(key, t);
  }
  const balances: PlanBalance[] = [];
  for (const { d, total } of totals.values()) {
    let value: bigint;
    try {
      value = d.asset === null ? await reader.nativeBalance(d.network, d.address) : await reader.tokenBalance(d.network, d.asset, d.address);
    } catch {
      return { short: `could not read the ${d.role} balance on ${d.network}`, balances };
    }
    balances.push({ role: d.role, address: d.address, network: d.network, kind: d.kind, asset: d.asset, value: value.toString() });
    if (value < total) return { short: `${d.role} ${d.address} has ${value.toString()} on ${d.network} (${d.asset ?? "native"}), this purchase needs ${total.toString()}`, balances };
  }
  return { short: undefined, balances };
}

/** この plan の 1 件の支出を鍵（アドレス × network × 資産。共有の Solana アカウントは 1 つ）ごとにまとめる。 */
function debitsByKeyOf(plan: Pick<FundedPlan, "debits">, index: number): Map<string, { d: MatrixDebit; total: bigint }> {
  const totals = new Map<string, { d: MatrixDebit; total: bigint }>();
  for (const d of plan.debits) {
    if (d.purchase !== index) continue;
    const key = matrixBalanceKey(d.address, d.network, d.asset);
    const t = totals.get(key) ?? { d, total: 0n };
    t.total += BigInt(d.amount);
    totals.set(key, t);
  }
  return totals;
}

/**
 * 累計の帳簿（Codex M-2 #1）: plan の時点で検証した初期残高から、この plan で **試みた**（印のある）購入の支出を引き続ける。入金は数えない。
 * 純粋（試験で確かめる）。`attempted` は印のある購入の番号。
 */
export class MatrixLedger {
  readonly #initial = new Map<string, bigint>();
  readonly #spent = new Map<string, bigint>();
  constructor(private readonly plan: Pick<FundedPlan, "debits" | "balances">, attempted: Iterable<number>) {
    for (const b of plan.balances) if (b.value !== null) this.#initial.set(matrixBalanceKey(b.address, b.network, b.asset), BigInt(b.value));
    for (const index of attempted) this.charge(index);
  }
  /** 鍵の残り（初期 − 累計）。初期が無ければ undefined。 */
  remaining(key: string): bigint | undefined {
    const initial = this.#initial.get(key);
    return initial === undefined ? undefined : initial - (this.#spent.get(key) ?? 0n);
  }
  /** この購入の支出が残りで足りないなら理由。 */
  shortfall(index: number): string | undefined {
    for (const [key, { d, total }] of debitsByKeyOf(this.plan, index)) {
      const left = this.remaining(key);
      if (left === undefined) return `the plan has no verified initial balance for ${d.role} ${d.address} on ${d.network} (${d.asset ?? "native"})`;
      if (left < total) return `${d.role} ${d.address} on ${d.network} (${d.asset ?? "native"}): ${left.toString()} left of the plan's verified initial balance after earlier attempts, this purchase needs ${total.toString()} (incoming payments are not counted)`;
    }
    return undefined;
  }
  charge(index: number): void {
    for (const [key, { total }] of debitsByKeyOf(this.plan, index)) this.#spent.set(key, (this.#spent.get(key) ?? 0n) + total);
  }
  /** 試みた支出の累計（鍵ごと）。 */
  spentOf(key: string): bigint {
    return this.#spent.get(key) ?? 0n;
  }
}

/**
 * 実行の初め（Codex M-2 #1）: plan が `allSufficient` であること、そして各鍵で **今の残高 ≥ plan の初期残高 − この plan で既に試みた支出**
 * （それより少なければ、plan の外で資金が動いた。始めない）。
 */
async function startCheck(reader: ChainReader, plan: FundedPlan, ledger: MatrixLedger): Promise<string | undefined> {
  if (plan.allSufficient !== true) return "the plan is not allSufficient (fund the payers and make a new plan)";
  for (const b of plan.balances) {
    if (b.value === null) return `the plan has an unreadable initial balance (${b.role} on ${b.network}); make a new plan`;
    const key = matrixBalanceKey(b.address, b.network, b.asset);
    let live: bigint;
    try {
      live = b.asset === null ? await reader.nativeBalance(b.network, b.address) : await reader.tokenBalance(b.network, b.asset, b.address);
    } catch {
      return `could not re-read the ${b.role} balance on ${b.network}`;
    }
    const floor = BigInt(b.value) - ledger.spentOf(key);
    if (live < floor) return `${b.role} ${b.address} on ${b.network} (${b.asset ?? "native"}) has ${live.toString()}, below the plan's initial ${b.value} minus ${ledger.spentOf(key).toString()} already attempted`;
  }
  return undefined;
}

/**
 * 実行のレールに依らない部分は 1 つの手順（`runMatrixLoop`）にし、quote の呼び方・照合・status の引数・body の形・レグの額だけを差し替える。
 * 静的の行列（`subetha_router_quote` + `mx-*`）と hosted 動的モード（`subetha_router_quote_url` + `ownerKey`。設計 hosted §8.1）。
 */
interface RunMode<P extends MatrixPurchase> {
  readonly kind: "matrix" | "hosted-matrix";
  readonly direction: "matrix" | "hosted";
  readonly name: string;
  selects(planned: P, only: string): boolean;
  requestIdOf(planned: P, now: Date): string;
  quote(mcp: McpCaller, planned: P, requestId: string): Promise<Record<string, unknown>>;
  mismatches(quoted: Record<string, unknown>, planned: P, nowMs: number): string[];
  /** 印・帳簿より前の追加の保留（hosted: 同じプロファイルの資金が動く署名を label をまたいで見る）。 */
  extraHold(planned: P, all: readonly PurchaseEvidence[]): string | undefined;
  /** 証跡の初めに足す欄。 */
  annotate(evidence: PurchaseEvidence, planned: P): void;
  /** 照合の後・署名の印の前（hosted: `ownerKey` を私的な置き場に保存）。止める理由か undefined。 */
  beforeSign(quoted: Record<string, unknown>, planned: P, evidence: PurchaseEvidence): string | undefined;
  statusArgs(evidence: PurchaseEvidence): Record<string, unknown>;
  purchaseRecord(purchased: Record<string, unknown>): unknown;
  deliveredBody(purchased: Record<string, unknown>): unknown;
  routerBody(projection: Record<string, unknown>): unknown;
  legsOf(planned: P, quoted: Record<string, unknown>): { source: MatrixLeg; destination: MatrixLeg };
}

const STATIC_MODE: RunMode<MatrixPurchase> = {
  kind: "matrix",
  direction: "matrix",
  name: "matrix run",
  selects: (planned, only) => planned.routeId === only,
  requestIdOf: (planned, now) => `mx-${planned.routeId}-${compactUtc(now)}-${randomBytes(3).toString("hex")}`,
  quote: (mcp, planned, requestId) => mcp.call("subetha_router_quote", { routeId: planned.routeId, requestId }),
  mismatches: (quoted, planned, nowMs) => matrixSubjectMismatches(quoted, planned, nowMs),
  extraHold: () => undefined,
  annotate: () => {},
  beforeSign: () => undefined,
  statusArgs: (evidence) => ({ paymentId: evidence.paymentId }),
  purchaseRecord: (purchased) => withoutBody(purchased, "snapshot"),
  deliveredBody: (purchased) => purchased["snapshot"],
  routerBody: (projection) => projection["result"],
  legsOf: (planned) => ({ source: planned.source, destination: planned.destination }),
};

interface LoopOptions<P extends MatrixPurchase> {
  readonly plan: FundedPlan<P>;
  readonly planSha256: string;
  readonly evidenceDir: string;
  readonly only?: string | undefined;
  readonly routerJournal?: string | undefined;
  readonly facilitatorJournal?: string | undefined;
  readonly facilitatorLog?: string | undefined;
}

/**
 * 30 件を 1 つずつ。最初の `delivered` でない結果・不一致・証跡の不足で全体を止める。再試行しない。
 */
export async function runMatrix(opts: MatrixRunOptions, deps: MatrixRunDeps): Promise<RunReport> {
  if (opts.prefunded !== true) throw new PlanRefusal("the matrix is paid from prefunded Router keys (design §8.2); pass --prefunded after the prefund run");
  return await runMatrixLoop(opts, deps, STATIC_MODE);
}

async function runMatrixLoop<P extends MatrixPurchase>(opts: LoopOptions<P>, deps: MatrixRunDeps, mode: RunMode<P>): Promise<RunReport> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const out = (line: string): void => deps.out(deps.secrets.redact(line));
  const selected = opts.only === undefined ? [...opts.plan.purchases] : opts.plan.purchases.filter((p) => mode.selects(p, opts.only as string));
  if (opts.only !== undefined && selected.length !== 1) throw new PlanRefusal(`--only ${opts.only} does not select exactly one planned purchase`);
  const runId = `run-${compactUtc(now())}`;
  const runDir = path.join(opts.evidenceDir, runId);
  const completed: string[] = [];
  const report = (stopped?: RunReport["stopped"]): RunReport => {
    const result: RunReport = { runDir, completed, ...(stopped === undefined ? {} : { stopped }) };
    writePrivate(path.join(runDir, "run.json"), { kind: mode.kind, planSha256: opts.planSha256, only: opts.only ?? null, at: now().toISOString(), ...result }, deps.secrets);
    return result;
  };
  out(`${mode.name} ${runId}: ${String(selected.length)} purchase(s), plan ${opts.planSha256}${mode.kind === "matrix" ? " (prefunded)" : ""}`);
  // 累計の帳簿: この plan で印のある購入（どの run でも）の支出を先に引く。
  const ledger = new MatrixLedger(opts.plan, opts.plan.purchases.filter((p) => attemptMarkerStateOf(opts.evidenceDir, opts.planSha256, p.routeId) !== "absent").map((p) => p.index));
  const refused = await startCheck(deps.chain, opts.plan, ledger);
  if (refused !== undefined) {
    out(`STOP: ${refused} (nothing was started)`);
    return report({ routeId: selected[0]?.routeId ?? "-", stage: "not_started", reason: `not funded: ${refused}` });
  }

  for (const planned of selected) {
    const scanned = readAllEvidence(opts.evidenceDir);
    if (scanned.unreadable.length > 0) {
      out(`HELD ${planned.routeId}: unreadable evidence file(s) ${scanned.unreadable.join(", ")}; an operator must inspect them before any purchase`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: "held: unreadable evidence" });
    }
    const marker = attemptMarkerStateOf(opts.evidenceDir, opts.planSha256, planned.routeId);
    if (marker === "corrupt") {
      out(`HELD ${planned.routeId}: the attempt marker is unreadable (${attemptMarkerPathOf(opts.evidenceDir, opts.planSha256, planned.routeId)})`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: "held: unreadable attempt marker" });
    }
    if (marker === "present" || scanned.evidence.some((e) => e.planSha256 === opts.planSha256 && e.routeId === planned.routeId)) {
      out(`STOP ${planned.routeId}: already attempted under this plan; a new attempt needs a new plan and approval`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: "already attempted under this plan" });
    }
    const hold = priorAttemptHold(opts.evidenceDir, planned.routeId, opts.planSha256, scanned.evidence) ?? mode.extraHold(planned, scanned.evidence);
    if (hold !== undefined) {
      out(`HELD ${planned.routeId}: ${hold}`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: `held: ${hold}` });
    }
    // 残高（§8.5 #5・M-2 #1）: 累計の帳簿（検証した初期残高 − 試みた支出。入金は数えない）で足り、さらに今の残高でも足りること。足りなければ印を作らずに止まる。
    const cumulative = ledger.shortfall(planned.index);
    if (cumulative !== undefined) {
      out(`STOP ${planned.routeId}: not funded: ${cumulative} (nothing was started)`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: `not funded: ${cumulative}` });
    }
    const funds = await fundsShortfall(deps.chain, opts.plan, planned);
    if (funds.short !== undefined) {
      out(`STOP ${planned.routeId}: not funded: ${funds.short} (nothing was started)`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: `not funded: ${funds.short}` });
    }

    const fundsMoveAtSign = planned.source.fundsMoveAtSign;
    const file = path.join(runDir, "purchases", `${planned.routeId}.json`);
    const evidence: PurchaseEvidence = {
      kind: "subetha-evm-testnets-e2e-purchase",
      planSha256: opts.planSha256,
      runId,
      index: planned.index,
      chain: `${planned.src}-to-${planned.dst}`,
      direction: mode.direction,
      routeId: planned.routeId,
      stage: "started",
      startedAt: now().toISOString(),
      prerequisite: { mode: mode.kind === "matrix" ? "prefunded" : "hosted (the hosted Router's outbound funds are the operator's)", balances: funds.balances },
      fundsMoveAtSign,
      timingsMs: {},
    };
    mode.annotate(evidence, planned);
    const save = (): void => writePrivate(file, evidence, deps.secrets);
    const stop = (stage: PurchaseEvidence["stage"], reason: string): RunReport => {
      evidence.stage = stage;
      evidence.stopReason = reason;
      evidence.finishedAt = now().toISOString();
      save();
      out(`STOP ${planned.routeId}: ${reason}${evidence.paymentId === undefined ? "" : ` (paymentId ${evidence.paymentId})`}`);
      return report({ routeId: planned.routeId, stage, reason, paymentId: evidence.paymentId, status: evidence.status });
    };
    let created: boolean;
    try {
      created = createAttemptMarker(opts.evidenceDir, opts.planSha256, planned.routeId, { runId, at: now().toISOString(), fundsMoveAtSign });
    } catch {
      out(`HELD ${planned.routeId}: could not persist the attempt marker; not starting`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: "held: attempt marker not persisted" });
    }
    if (!created) {
      out(`STOP ${planned.routeId}: already attempted under this plan (attempt marker present)`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: "already attempted under this plan" });
    }
    ledger.charge(planned.index);
    save();

    // 1) quote（新しい requestId）。
    const requestId = deps.requestIdOf?.(planned.routeId) ?? mode.requestIdOf(planned, now());
    evidence.requestId = requestId;
    out(`#${String(planned.index)} ${planned.routeId}: quote (requestId ${requestId})`);
    let quoted: Record<string, unknown>;
    try {
      quoted = await mode.quote(deps.mcp, planned, requestId);
    } catch {
      return stop("quote_failed", "the quote call failed (no payment started)");
    }
    const q = quoteRecordOf(quoted);
    evidence.quoteResponse = q.response;
    evidence.subject = q.subject;
    evidence.quoteDestination = q.destination;
    if (quoted["ok"] !== true) return stop("quote_failed", `quote failed: ${String(quoted["error"] ?? "unknown")}${typeof quoted["reason"] === "string" ? ` (${quoted["reason"]})` : ""} (no payment started)`);

    // 2) レールごとの照合（署名の前。§8.5 #2）。照合した quote 文書を凍結し、署名と purchase にはその同じ object だけを渡す。
    const quoteDoc = deepFreeze(structuredClone(quoted["quote"]));
    quoted = { ...quoted, quote: quoteDoc };
    const mismatches = mode.mismatches(quoted, planned, now().getTime());
    evidence.mismatches = mismatches;
    const subject = quoted["subject"] as Record<string, unknown>;
    evidence.paymentId = String(subject["paymentId"] ?? "");
    if (mismatches.length > 0) return stop("stopped_before_signing", `the quote differs from the plan: ${mismatches.join("; ")}`);
    const unready = mode.beforeSign(quoted, planned, evidence);
    if (unready !== undefined) return stop("stopped_before_signing", `${unready} (not signing, no payment started)`);

    // 3) 署名。呼ぶ前に、不変の署名の印（O_EXCL・fsync）と証跡の `signInvoked`（原子的な書き込み・fsync）を残す（Tempo MPP は署名で資金が動く。§8.5 #1・M-2 #5）。
    try {
      if (!createSignMarker(opts.evidenceDir, opts.planSha256, planned.routeId, { fundsMoveAtSign, runId, at: now().toISOString() })) return stop("stopped_before_signing", "a sign marker already exists for this route under this plan (not signing again)");
    } catch {
      return stop("stopped_before_signing", "could not persist the sign marker; not signing");
    }
    evidence.signInvoked = true;
    save();
    let signed: MatrixSignResult;
    try {
      signed = await deps.sign(quoteDoc, planned);
    } catch {
      signed = { ok: false, reason: "the signer threw", fundsMayHaveMoved: fundsMoveAtSign };
    }
    if (signed.txRef !== undefined) evidence.signTxRef = signed.txRef;
    if (!signed.ok) {
      // Tempo MPP: 署名を呼んだ後の失敗は全部「資金が動いた可能性」（§8.5 #1）。
      if (fundsMoveAtSign || signed.fundsMayHaveMoved) return stop("funds_possibly_moved", `signing failed after a funds-moving signature was invoked (${signed.reason}); funds may have moved${signed.txRef === undefined ? "" : ` (tx ${signed.txRef})`} — not retried, never re-signed`);
      return stop("sign_refused", `signing refused: ${signed.reason} (no payment started)`);
    }
    deps.secrets.add(signed.credential);
    const signProblem =
      signed.kind !== planned.expectedSign
        ? `signed as ${signed.kind}, plan ${planned.expectedSign}`
        : signed.kind === "x402-evm" && signed.chainId !== Number(chainIdOf(planned.source.network))
          ? `signed for chain ${String(signed.chainId)}, plan ${chainIdOf(planned.source.network)}`
          : undefined;
    if (signProblem !== undefined) {
      if (fundsMoveAtSign) return stop("funds_possibly_moved", `${signProblem} after a funds-moving signature; funds may have moved — not retried, never re-signed`);
      return stop("sign_refused", `${signProblem} (credential discarded, no payment started)`);
    }

    // 4) purchase（同じ requestId、approval = quoteId、quote 文書はそのまま）。1 回だけ。
    const quoteId = String(subject["quoteId"]);
    out(`#${String(planned.index)} ${planned.routeId}: purchase (paymentId ${evidence.paymentId})`);
    const t1 = Date.now();
    let purchased: Record<string, unknown>;
    try {
      purchased = await deps.mcp.call("subetha_router_purchase", { quoteId, requestId, approval: quoteId, quote: quoteDoc, credential: signed.credential });
    } catch {
      evidence.outcome = "unknown";
      try {
        evidence.status = withStatusDigest(await deps.mcp.call("subetha_router_status", mode.statusArgs(evidence)));
      } catch {
        evidence.status = "status call failed";
      }
      return stop(fundsMoveAtSign ? "funds_possibly_moved" : "purchase_call_failed", "the purchase call failed or timed out; funds may have moved — not retried");
    }
    (evidence.timingsMs as Record<string, number>)["purchase"] = Date.now() - t1;
    evidence.purchase = mode.purchaseRecord(purchased);
    evidence.outcome = typeof purchased["outcome"] === "string" ? purchased["outcome"] : "unknown";
    evidence.stage = "purchased";
    save();

    // 5) status（読むだけ）。
    let status: Record<string, unknown> | undefined;
    try {
      status = await deps.mcp.call("subetha_router_status", mode.statusArgs(evidence));
      evidence.status = withStatusDigest(status);
    } catch {
      evidence.status = "status call failed";
    }
    save();
    const projection = status !== undefined && isRecord(status["projection"]) ? status["projection"] : undefined;
    if (evidence.outcome !== "delivered" || projection?.["status"] !== "delivered") {
      return stop(fundsMoveAtSign ? "funds_possibly_moved" : "purchased", `outcome ${evidence.outcome}, saved status ${JSON.stringify(projection?.["status"] ?? null)}; not delivered — stopping the run without retry`);
    }

    // 6) body の digest。
    const clientDigest = bodyDigest(mode.deliveredBody(purchased));
    const routerRecord = mode.routerBody(projection);
    const routerSha = routerRecord === undefined ? null : bodyDigest(routerRecord).sha256;
    evidence.body = { sha256: clientDigest.sha256, head: clientDigest.head, routerRecordSha256: routerSha, matches: routerSha === clientDigest.sha256 };

    // 7) 2 レグの chain の読み取り。
    const src = isRecord(projection["source"]) ? projection["source"] : {};
    const dst = isRecord(projection["destination"]) ? projection["destination"] : {};
    const legOpts = { waitMs: deps.receiptWaitMs ?? 60_000, sleep };
    const legs = mode.legsOf(planned, quoted);
    const sourceLeg = await verifyMatrixLeg(deps.chain, "source", legs.source, src["txRef"], legOpts);
    const destinationLeg = await verifyMatrixLeg(deps.chain, "destination", legs.destination, dst["txRef"], legOpts);
    evidence.legs = [sourceLeg, destinationLeg];
    evidence.journal = journalLinesOf(evidence.paymentId, [sourceLeg.txHash, destinationLeg.txHash].filter((h): h is string => h !== null), { router: opts.routerJournal, facilitatorJournal: opts.facilitatorJournal, facilitatorLog: opts.facilitatorLog });
    evidence.balancesAfter = (await fundsShortfall(deps.chain, opts.plan, planned)).balances;
    const legProblems = evidence.legs.filter((l) => !l.ok).map((l) => `${l.leg}: ${l.problem ?? "not ok"}`);
    if (evidence.signTxRef !== undefined && sourceLeg.txHash !== null && evidence.signTxRef.toLowerCase() !== sourceLeg.txHash.toLowerCase()) legProblems.push("the Router's source txRef differs from the transfer the signer sent");
    if (!evidence.body.matches) legProblems.push("the delivered body's sha256 differs from the Router's saved result");
    if (legProblems.length > 0) return stop("verification_failed", `delivered, but the evidence does not match: ${legProblems.join("; ")}`);
    evidence.stage = "verified";
    evidence.finishedAt = now().toISOString();
    save();
    completed.push(planned.routeId);
    out(`#${String(planned.index)} ${planned.routeId}: delivered; source ${sourceLeg.txHash ?? ""}, destination ${destinationLeg.txHash ?? ""}`);
  }
  out(`${mode.name} ${runId}: all ${String(completed.length)} purchase(s) delivered and verified`);
  return report();
}

/* ══════════════════════════════════════════════════════════════════════════════ hosted 動的モード（`docs/evm-testnets-hosted-design.md` §8.1、AC-H4・AC-H5・AC-H7・SR-H7） */

/**
 * hosted Router の 36 の動的プロファイル `dyn-<s>-to-<d>`（設計 hosted §5）。s・d ∈ 下の 8 端点、少なくとも一方が新 3、s ≠ d。
 * **H-3 の設定生成（並行して作業中）を import しない**: この一覧は driver に持ち、id は H-3 の名付けと同じ規則。
 * 端点の名前: `x402` = Base Sepolia USDC（x402）、`mpp` = Tempo pathUSD（MPP `tempo/charge`）、`arc`・`sol`・`solmpp`・新 3（`rh`・`arbsep`・`hyperevm`）。
 */
export type HostedEndpoint = "x402" | "mpp" | "arc" | "sol" | "solmpp" | MatrixNewChain;
export const HOSTED_ENDPOINTS: readonly HostedEndpoint[] = Object.freeze(["x402", "mpp", "arc", "sol", "solmpp", "rh", "arbsep", "hyperevm"]);
export const HOSTED_PLAN_KIND = "subetha-evm-testnets-hosted-matrix-plan";
export const HOSTED_PLAN_VERSION = 1;
/** 動的の上流額（Provider の 402 の額）と x402 送信・Solana MPP 送信の定額の手数料（`tools/remote-mcp-config.ts` の `DYNAMIC_*`）。 */
export const HOSTED_UPSTREAM_AMOUNT = "10000";
export const HOSTED_FIXED_FEE = "1000";
/** Tempo 宛て（手数料 = max(1,000, cap)）の 1 件の源の合計の上限の既定（env `SUBETHA_HOSTED_TEMPO_MAX_TOTAL`）と、その env の上限（区分の 1 件の上限 M = 20,000。設計 hosted §5）。 */
export const HOSTED_TEMPO_MAX_TOTAL_DEFAULT = "11000";
const HOSTED_TEMPO_MAX_TOTAL_LIMIT = 20_000n;
export const HOSTED_ENV = Object.freeze({ mcpUrl: "SUBETHA_HOSTED_MCP_URL", allowLoopback: "SUBETHA_HOSTED_MCP_ALLOW_LOOPBACK", label: "SUBETHA_HOSTED_LABEL", tempoMaxTotal: "SUBETHA_HOSTED_TEMPO_MAX_TOTAL", mppOutbound: "SUBETHA_ROUTER_MPP_OUTBOUND_ADDRESS" });

const HOSTED_LEG_ENDPOINT: Readonly<Record<HostedEndpoint, LegEndpoint>> = Object.freeze({ x402: "base", mpp: "tempo", arc: "arc", sol: "sol", solmpp: "solmpp", rh: "rh", arbsep: "arbsep", hyperevm: "hyperevm" });
const BASE_RAIL = Object.freeze({ rail: "x402", scheme: "exact", family: "evm", network: INBOUND.network, asset: INBOUND.asset, decimals: 6 }) as MatrixRail;
function hostedRailOf(endpoint: HostedEndpoint): MatrixRail {
  return endpoint === "x402" ? BASE_RAIL : MATRIX_RAILS[HOSTED_LEG_ENDPOINT[endpoint] as MatrixEndpoint];
}
export function hostedProfileIdOf(source: HostedEndpoint, destination: HostedEndpoint): string {
  return `dyn-${source}-to-${destination}`;
}
/** 宛先のレールを受ける Provider の URL（AC-H7）。既存のレールは hosted の Provider の定数、新 3 は `provider-x402-<c>.subethalabs.com`（設計 hosted §6）。 */
export function hostedProviderUrlOf(destination: HostedEndpoint): string {
  if (destination === "x402") return UPSTREAM_X402;
  if (destination === "mpp") return UPSTREAM;
  if (destination === "arc") return UPSTREAM_ARC;
  if (destination === "sol") return UPSTREAM_SOL;
  if (destination === "solmpp") return UPSTREAM_SOL_MPP;
  return `https://provider-x402-${destination}.subethalabs.com/v1/eth/snapshot`;
}
/** 36 の組（順は `HOSTED_ENDPOINTS` の源 × 宛先）。 */
export function hostedPairsOf(): readonly { readonly source: HostedEndpoint; readonly destination: HostedEndpoint; readonly profileId: string }[] {
  const out: { source: HostedEndpoint; destination: HostedEndpoint; profileId: string }[] = [];
  for (const source of HOSTED_ENDPOINTS) {
    for (const destination of HOSTED_ENDPOINTS) {
      if (source === destination || (!isMatrixNewChain(source) && !isMatrixNewChain(destination))) continue;
      out.push({ source, destination, profileId: hostedProfileIdOf(source, destination) });
    }
  }
  return out;
}

/** hosted の MCP の URL（env）。https だけ。G-3 の ssh tunnel のときだけ、明示の env で `http://127.0.0.1:<port>` を許す。 */
export function hostedMcpUrlOf(env: Env): string {
  const text = env[HOSTED_ENV.mcpUrl];
  if (text === undefined || text === "") throw new PlanRefusal(`${HOSTED_ENV.mcpUrl} is required in hosted mode`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PlanRefusal(`${HOSTED_ENV.mcpUrl} is not a URL`);
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") throw new PlanRefusal(`${HOSTED_ENV.mcpUrl} must not carry credentials or a fragment`);
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && url.hostname === "127.0.0.1" && env[HOSTED_ENV.allowLoopback] === "1") return url.href;
  throw new PlanRefusal(`${HOSTED_ENV.mcpUrl} must be https (http://127.0.0.1 only with ${HOSTED_ENV.allowLoopback}=1, for the G-3 ssh tunnel)`);
}
/** 受け入れの段の名前（例 `g3`・`g4`）。試みの印と証跡の鍵（`<profileId>@<label>`）に入る。 */
export function hostedLabelOf(env: Env): string {
  const label = env[HOSTED_ENV.label];
  if (label === undefined || !/^[a-z0-9][a-z0-9-]{0,15}$/.test(label)) throw new PlanRefusal(`${HOSTED_ENV.label} is required in hosted mode (lowercase letters, digits and '-', at most 16; e.g. g3 or g4)`);
  return label;
}
/** Tempo 宛ての源の合計の上限（既定 11,000。11,000 以上 20,000 以下）。 */
export function hostedTempoMaxTotalOf(env: Env): string {
  const text = env[HOSTED_ENV.tempoMaxTotal];
  if (text === undefined || text === "") return HOSTED_TEMPO_MAX_TOTAL_DEFAULT;
  if (!/^[1-9][0-9]{0,5}$/.test(text) || BigInt(text) < BigInt(HOSTED_TEMPO_MAX_TOTAL_DEFAULT) || BigInt(text) > HOSTED_TEMPO_MAX_TOTAL_LIMIT) {
    throw new PlanRefusal(`${HOSTED_ENV.tempoMaxTotal} must be an integer from ${HOSTED_TEMPO_MAX_TOTAL_DEFAULT} to ${HOSTED_TEMPO_MAX_TOTAL_LIMIT.toString()}`);
  }
  return text;
}

export interface HostedAddresses extends MatrixAddresses {
  /** hosted Router の Tempo MPP の送信鍵の address（本番の `SUBETHA_OUTBOUND_PRIVATE_KEY`。x402 の送信鍵と別のことがある）。 */
  readonly routerMppOutbound: string;
  /** Provider A の受取先（`OUTBOUND_X402.payTo`）。 */
  readonly providerA: string;
}
export interface HostedExpectation {
  readonly upstreamAmount: string;
  /** 宛先が Tempo（MPP 送信）なら手数料は max(1,000, cap)（`pricing.maxFee`）、ほかは定額 1,000 で `maxFee` は無い。 */
  readonly gasIndexedFee: boolean;
  /** 定額のときの合計（11,000）。gas の cap のときは null（`maxTotal` 以下）。 */
  readonly total: string | null;
  readonly maxTotal: string;
  readonly fundsMoveOnCredential: boolean;
}
export interface HostedPurchase extends MatrixPurchase {
  /** 試みの鍵 `<profileId>@<label>`（印・証跡のファイル名。subject の routeId は `profileId`）。 */
  readonly routeId: string;
  readonly profileId: string;
  readonly url: string;
  readonly pair: { readonly source: HostedEndpoint; readonly destination: HostedEndpoint };
  readonly expected: HostedExpectation;
}
export interface HostedPlan extends FundedPlan<HostedPurchase> {
  readonly kind: typeof HOSTED_PLAN_KIND;
  readonly version: typeof HOSTED_PLAN_VERSION;
  readonly createdAt: string;
  readonly hosted: { readonly mcpUrl: string; readonly label: string; readonly tempoMaxTotal: string; readonly profiles: number };
  readonly addresses: HostedAddresses;
  readonly addressSources: Readonly<Record<string, string>>;
  readonly purchases: readonly HostedPurchase[];
  /** 払い手（クライアント）の支出だけ。実行の帳簿と残高の検査はこれだけを見る。 */
  readonly debits: readonly MatrixDebit[];
  readonly balances: readonly PlanBalance[];
  readonly checks: readonly MatrixCheck[];
  readonly allSufficient: boolean;
  /** hosted Router の送信鍵・facilitator の gas（運用者の資金）。読み取りだけの **情報** で、実行の gate にしない。 */
  readonly operator: { readonly debits: readonly MatrixDebit[]; readonly balances: readonly PlanBalance[]; readonly checks: readonly MatrixCheck[] };
}

const PAYER_ROLES: ReadonlySet<string> = new Set(["payerEvm", "payerSolana"]);

/** hosted の address（鍵があれば address を導くだけ）。Router の送信鍵は hosted のものを明示する（受取先と同じ、の既定を使わない）。 */
export async function hostedAddressesOf(env: Env): Promise<{ addresses: HostedAddresses; sources: Record<string, string> }> {
  const { addresses, sources } = await matrixAddressesOf(env);
  if ((sources["routerOutbound"] ?? "").startsWith("same as")) throw new PlanRefusal("hosted mode needs the hosted Router's x402 outbound address (SUBETHA_ROUTER_OUTBOUND_ADDRESS)");
  let routerMppOutbound = env[HOSTED_ENV.mppOutbound];
  if (routerMppOutbound !== undefined && routerMppOutbound !== "") {
    if (!ADDRESS.test(routerMppOutbound)) throw new PlanRefusal(`${HOSTED_ENV.mppOutbound} must be an EVM address`);
    sources["routerMppOutbound"] = HOSTED_ENV.mppOutbound;
  } else {
    const key = env["SUBETHA_OUTBOUND_MPP_KEY"];
    if (key === undefined || key === "") throw new PlanRefusal(`${HOSTED_ENV.mppOutbound} (the hosted Router's Tempo MPP outbound address) is required in hosted mode`);
    routerMppOutbound = await evmAddressOfKey(key);
    sources["routerMppOutbound"] = "derived from SUBETHA_OUTBOUND_MPP_KEY";
  }
  sources["providerA"] = "remote-mcp-config OUTBOUND_X402.payTo (Provider A)";
  const hosted: HostedAddresses = { ...addresses, routerMppOutbound, providerA: OUTBOUND_X402.payTo };
  // Provider の受取先は Router の受取先と別（送信の設計 §2.3。Router も宛先で拒むが、ここで先に止める）。
  const receivers = [hosted.routerReceiver.toLowerCase(), hosted.arcReceiver.toLowerCase(), hosted.solanaReceiver];
  if ([hosted.providerPayTo.toLowerCase(), hosted.arcProvider.toLowerCase(), hosted.solanaProvider, hosted.solanaMppProvider].some((p) => receivers.includes(p))) throw new PlanRefusal("a provider pay-to address must not be a Router receiver");
  return { addresses: hosted, sources };
}

const HOSTED_SOURCE_ROLE: Readonly<Record<HostedEndpoint, keyof HostedAddresses>> = { x402: "routerReceiver", mpp: "routerReceiver", arc: "arcReceiver", sol: "solanaReceiver", solmpp: "solanaReceiver", rh: "routerReceiver", arbsep: "routerReceiver", hyperevm: "routerReceiver" };
const HOSTED_DEST_FROM_ROLE: Readonly<Record<HostedEndpoint, keyof HostedAddresses>> = { x402: "routerOutbound", mpp: "routerMppOutbound", arc: "routerOutbound", sol: "solanaOutbound", solmpp: "solanaOutbound", rh: "routerOutbound", arbsep: "routerOutbound", hyperevm: "routerOutbound" };
const HOSTED_DEST_ROLE: Readonly<Record<HostedEndpoint, keyof HostedAddresses>> = { x402: "providerA", mpp: "providerB", arc: "arcProvider", sol: "solanaProvider", solmpp: "solanaMppProvider", rh: "providerPayTo", arbsep: "providerPayTo", hyperevm: "providerPayTo" };
const HOSTED_SOURCE_SETTLED_BY: Readonly<Record<HostedEndpoint, string>> = {
  x402: "x402.org facilitator (its gas)",
  mpp: "the payer broadcasts AT SIGN (MPP tempo/charge; fee in pathUSD; funds move when signing)",
  arc: "Circle facilitator (its gas)",
  sol: "x402.org facilitator (its fee payer)",
  solmpp: "the hosted Router broadcasts at purchase (MPP solana/charge; the payer's key pays the SOL fee)",
  rh: "hosted self-hosted facilitator (E-FAC-H pays gas)",
  arbsep: "hosted self-hosted facilitator (E-FAC-H pays gas)",
  hyperevm: "hosted self-hosted facilitator (E-FAC-H pays gas)",
};
const HOSTED_DEST_SETTLED_BY: Readonly<Record<HostedEndpoint, string>> = {
  x402: "Provider A's facilitator (x402.org)",
  mpp: "the hosted Router broadcasts (MPP tempo/charge to Provider B; fee in pathUSD from routerMppOutbound)",
  arc: "Arc Provider's facilitator (Circle)",
  sol: "Solana Provider's facilitator (its fee payer)",
  solmpp: "Provider D's fee payer (MPP solana/charge, pull)",
  rh: "rh Provider -> hosted self-hosted facilitator (E-FAC-H pays gas)",
  arbsep: "arbsep Provider -> hosted self-hosted facilitator (E-FAC-H pays gas)",
  hyperevm: "hyperevm Provider -> hosted self-hosted facilitator (E-FAC-H pays gas)",
};
const HOSTED_SIGN_KIND: Readonly<Record<HostedEndpoint, ExpectedSign>> = { x402: "x402-evm", mpp: "mpp", arc: "x402-evm", sol: "x402-svm", solmpp: "mpp-svm", rh: "x402-evm", arbsep: "x402-evm", hyperevm: "x402-evm" };

/** 36 件の購入（URL・額・受取先）。源のレグの額は定額なら 11,000、Tempo 宛てなら上限（帳簿は最悪の額で数える。照合と chain の照合は quote の `pricing.total`）。 */
export function hostedPurchasesOf(addresses: HostedAddresses, label: string, tempoMaxTotal: string): HostedPurchase[] {
  const byRole = addresses as unknown as Record<string, string>;
  const fixedTotal = (BigInt(HOSTED_UPSTREAM_AMOUNT) + BigInt(HOSTED_FIXED_FEE)).toString();
  return hostedPairsOf().map(({ source, destination, profileId }, i) => {
    const s = hostedRailOf(source);
    const d = hostedRailOf(destination);
    const gasIndexedFee = destination === "mpp";
    const leg = (endpoint: HostedEndpoint, rail: MatrixRail, amount: string, fromRole: string, toRole: string, settledBy: string, fundsMoveAtSign: boolean): MatrixLeg => ({
      endpoint: HOSTED_LEG_ENDPOINT[endpoint],
      rail: rail.rail,
      scheme: rail.scheme,
      family: rail.family,
      network: rail.network,
      networkLabel: NETWORK_LABEL[rail.network] ?? rail.network,
      asset: rail.asset,
      assetSymbol: ASSET_SYMBOL[rail.network] ?? "?",
      decimals: rail.decimals,
      amount,
      fromRole,
      from: byRole[fromRole] as string,
      toRole,
      to: byRole[toRole] as string,
      settledBy,
      fundsMoveAtSign,
      finalityRule: finalityRuleOf(rail.network),
    });
    const url = hostedProviderUrlOf(destination);
    return {
      index: i + 1,
      routeId: `${profileId}@${label}`,
      profileId,
      url,
      pair: { source, destination },
      src: HOSTED_LEG_ENDPOINT[source],
      dst: HOSTED_LEG_ENDPOINT[destination],
      upstream: `${url} (${destination === "x402" ? "Provider A" : destination === "mpp" ? "Provider B" : destination === "arc" ? "Arc Provider" : destination === "sol" ? "Solana Provider" : destination === "solmpp" ? "Provider D" : `${destination} Provider`})`,
      expectedSign: HOSTED_SIGN_KIND[source],
      expected: { upstreamAmount: HOSTED_UPSTREAM_AMOUNT, gasIndexedFee, total: gasIndexedFee ? null : fixedTotal, maxTotal: gasIndexedFee ? tempoMaxTotal : fixedTotal, fundsMoveOnCredential: s.rail === "mpp" },
      source: leg(source, s, gasIndexedFee ? tempoMaxTotal : fixedTotal, s.family === "svm" ? "payerSolana" : "payerEvm", HOSTED_SOURCE_ROLE[source], HOSTED_SOURCE_SETTLED_BY[source], source === "mpp"),
      destination: leg(destination, d, HOSTED_UPSTREAM_AMOUNT, HOSTED_DEST_FROM_ROLE[destination], HOSTED_DEST_ROLE[destination], HOSTED_DEST_SETTLED_BY[destination], false),
    };
  });
}

async function balancesOf(reader: ChainReader, debits: readonly MatrixDebit[]): Promise<PlanBalance[]> {
  const balances: PlanBalance[] = [];
  const seen = new Set<string>();
  for (const d of debits) {
    const key = matrixBalanceKey(d.address, d.network, d.asset);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const value = d.asset === null ? await reader.nativeBalance(d.network, d.address) : await reader.tokenBalance(d.network, d.asset, d.address);
      balances.push({ role: d.role, address: d.address, network: d.network, kind: d.kind, asset: d.asset, value: value.toString() });
    } catch {
      balances.push({ role: d.role, address: d.address, network: d.network, kind: d.kind, asset: d.asset, value: null, error: "rpc_read_failed" });
    }
  }
  return balances;
}

/** hosted の plan（残高は読み取りだけ。払い手の資金は gate、運用者の資金は情報）。何も署名しない・MCP に接続しない。 */
export async function buildHostedPlan(env: Env, reader: ChainReader, now: () => Date = () => new Date()): Promise<HostedPlan> {
  const mcpUrl = hostedMcpUrlOf(env);
  const label = hostedLabelOf(env);
  const tempoMaxTotal = hostedTempoMaxTotalOf(env);
  const { addresses, sources } = await hostedAddressesOf(env);
  const purchases = hostedPurchasesOf(addresses, label, tempoMaxTotal);
  const fees = new Map<string, bigint | null>();
  for (const chain of MATRIX_NEW_CHAINS) {
    const network = EVM_TESTNETS[chain].network;
    try {
      fees.set(network, await reader.feeEstimate(network));
    } catch {
      fees.set(network, null);
    }
  }
  const all = matrixDebitsOf(purchases, addresses, fees, env);
  const debits = all.filter((d) => PAYER_ROLES.has(d.role));
  const operatorDebits = all.filter((d) => !PAYER_ROLES.has(d.role));
  const balances = await balancesOf(reader, debits);
  const operatorBalances = await balancesOf(reader, operatorDebits);
  const checks = matrixChecksOf(debits, balances, env);
  const operatorChecks = matrixChecksOf(operatorDebits, operatorBalances, env).map((c) => ({ ...c, note: `information only (the hosted Router's funds are the operator's; not a gate): ${c.note}` }));
  return {
    kind: HOSTED_PLAN_KIND,
    version: HOSTED_PLAN_VERSION,
    createdAt: now().toISOString(),
    hosted: { mcpUrl, label, tempoMaxTotal, profiles: purchases.length },
    addresses,
    addressSources: sources,
    purchases,
    debits,
    balances,
    checks,
    allSufficient: checks.length > 0 && checks.every((c) => c.ok),
    operator: { debits: operatorDebits, balances: operatorBalances, checks: operatorChecks },
  };
}

/** 人が読む表。 */
export function hostedPlanText(plan: HostedPlan, sha: string): string {
  const lines: string[] = [];
  lines.push(`Hosted dynamic matrix plan (hosted design §8.1) — created ${plan.createdAt}, label ${plan.hosted.label}`);
  lines.push(`plan sha256 (canonical JSON): ${sha}`);
  lines.push(`MCP endpoint: ${plan.hosted.mcpUrl}`);
  lines.push("Nothing is signed by `plan`. `run --hosted` refuses unless --plan-sha256 equals this hash and SUBETHA_HOSTED_MCP_URL equals the endpoint above.");
  lines.push("Each purchase: subetha_router_quote_url with the destination rail's Provider URL; the dynamic subject is compared with the plan BEFORE signing.");
  lines.push("The quote's ownerKey is kept only in the private evidence directory (owner-keys/), never printed and never in the public summary.");
  lines.push("Tempo MPP sources move funds AT SIGN; any failure after signing stops the run as funds_possibly_moved and that profile is never re-signed (any plan, any label) until it is resolved.");
  lines.push(`Amounts: upstream ${HOSTED_UPSTREAM_AMOUNT} + fee ${HOSTED_FIXED_FEE} = ${(BigInt(HOSTED_UPSTREAM_AMOUNT) + BigInt(HOSTED_FIXED_FEE)).toString()}; to Tempo the fee is max(${HOSTED_FIXED_FEE}, cap) and the total must be <= ${plan.hosted.tempoMaxTotal}.`);
  lines.push("");
  lines.push("Addresses:");
  for (const [role, address] of Object.entries(plan.addresses)) lines.push(`  ${role.padEnd(18)} ${address}  (${plan.addressSources[role] ?? ""})`);
  lines.push("");
  lines.push(`Purchases (${String(plan.purchases.length)}, one at a time, in this order; any non-delivered result stops the run, no retries):`);
  for (const p of plan.purchases) {
    lines.push(`  #${String(p.index).padEnd(2)} ${p.profileId}  sign: ${p.expectedSign}  url: ${p.url}`);
    lines.push(`       src ${p.source.rail}/${p.source.scheme} ${p.source.networkLabel}: ${p.source.fromRole} ${short(p.source.from)} -> ${p.source.toRole} ${short(p.source.to)}  ${p.expected.gasIndexedFee ? `<= ${p.source.amount}` : p.source.amount} / ${String(p.source.decimals)} (${units(p.source.amount, p.source.decimals)} ${p.source.assetSymbol}); ${p.source.settledBy}`);
    lines.push(`       dst ${p.destination.rail}/${p.destination.scheme} ${p.destination.networkLabel}: ${p.destination.fromRole} ${short(p.destination.from)} -> ${p.destination.toRole} ${short(p.destination.to)}  ${p.destination.amount} / ${String(p.destination.decimals)}; ${p.destination.settledBy}`);
  }
  lines.push("");
  lines.push("Payer funds (the gate: initial balance vs cumulative debits; incoming payments are not counted):");
  for (const c of plan.checks) lines.push(`  [${c.ok ? "ok" : "SHORT"}] ${c.role.padEnd(18)} ${short(c.address)}  ${(NETWORK_LABEL[c.network] ?? c.network).padEnd(26)} ${(c.kind === "native" ? "native" : (ASSET_SYMBOL[c.network] ?? "token")).padEnd(8)} need ${c.need} have ${c.have ?? "?"} — ${c.note}`);
  lines.push("");
  lines.push("Hosted Router / facilitator funds (information only, not a gate):");
  for (const c of plan.operator.checks) lines.push(`  [${c.ok ? "ok" : "low"}] ${c.role.padEnd(18)} ${short(c.address)}  ${(NETWORK_LABEL[c.network] ?? c.network).padEnd(26)} ${(c.kind === "native" ? "native" : (ASSET_SYMBOL[c.network] ?? "token")).padEnd(8)} need ${c.need} have ${c.have ?? "?"}`);
  lines.push("");
  lines.push(`All payers sufficient: ${plan.allSufficient ? "yes" : "NO"}`);
  return `${lines.join("\n")}\n`;
}

/** hosted の plan を読み、canonical sha256 が一致するときだけ返す。 */
export function loadApprovedHostedPlan(file: string, expectedSha: string): HostedPlan {
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new PlanRefusal("--plan-sha256 must be 64 lowercase hex characters");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PlanRefusal("the plan file is not readable JSON");
  }
  const actual = planSha256(parsed);
  if (actual !== expectedSha) throw new PlanRefusal(`the plan's canonical sha256 is ${actual}, not the approved ${expectedSha}; refusing`);
  const plan = parsed as HostedPlan;
  if (plan.kind !== HOSTED_PLAN_KIND || plan.version !== HOSTED_PLAN_VERSION || !Array.isArray(plan.purchases) || !isRecord(plan.hosted)) throw new PlanRefusal("not a hosted matrix plan of a known version");
  return plan;
}

const AMOUNT = /^(0|[1-9][0-9]{0,29})$/;
/** 証跡のファイル名にも使う paymentId の形（Router は UUID）。 */
export const SAFE_PAYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 動的の quote（`subetha_router_quote_url`）を plan と照合する（**署名の前**。AC-H7）。不一致の一覧（空なら一致）。
 * profileId（= subject・quote の `routeId`）、上流 URL（完全一致）・method、源の network・資産・桁・受取先と offer・challenge（静的と同じ照合）、
 * 宛先の network・資産・桁・受取先（`destinationPayTo`）、価格（上流額・換算・手数料・合計、Tempo 宛ての cap と上限）、開示、`fundsMoveOnCredential`、期限、`ownerKey` の有無。
 */
export function hostedSubjectMismatches(response: Record<string, unknown>, planned: HostedPurchase, nowMs: number): string[] {
  const problems: string[] = [];
  const subject = response["subject"];
  const quote = response["quote"];
  if (response["ok"] !== true || !isRecord(subject) || !isRecord(quote)) return ["the quote did not succeed or has no subject/quote"];
  const src = planned.source;
  const dst = planned.destination;
  const exp = planned.expected;
  const eq = (label: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected) problems.push(`${label}: got ${JSON.stringify(actual)}, plan ${JSON.stringify(expected)}`);
  };
  const addr = (label: string, network: string, actual: unknown, expected: string): void => {
    if (!sameAddress(network, actual, expected)) problems.push(`${label}: got ${JSON.stringify(actual)}, plan ${JSON.stringify(expected)}`);
  };
  // プロファイルと quote の同一性。
  eq("subject.routeId (profileId)", subject["routeId"], planned.profileId);
  eq("quote.routeId (profileId)", quote["routeId"], planned.profileId);
  eq("quote.quoteId = subject.quoteId", quote["quoteId"], subject["quoteId"]);
  eq("quote.paymentId = subject.paymentId", quote["paymentId"], subject["paymentId"]);
  if (typeof subject["quoteId"] !== "string" || subject["quoteId"] === "") problems.push("subject.quoteId is missing");
  if (typeof subject["paymentId"] !== "string" || !SAFE_PAYMENT_ID.test(subject["paymentId"])) problems.push("subject.paymentId is missing or not a plain id");
  const ownerKey = quote["ownerKey"];
  if (typeof ownerKey !== "string" || ownerKey.length < 16 || ownerKey.length > 256) problems.push("quote.ownerKey is missing (not a dynamic quote)");
  if (subject["ownerKey"] !== undefined) problems.push("subject carries an ownerKey (it must be only in the quote document)");
  // 上流（呼び出し側の URL）。完全一致、GET、body なし。
  for (const [label, record] of [["subject.upstream", subject["upstream"]], ["quote.upstream", quote["upstream"]]] as const) {
    const up = isRecord(record) ? record : {};
    eq(`${label}.url`, up["url"], planned.url);
    eq(`${label}.method`, up["method"], "GET");
    if (up["body"] !== undefined || up["bodySha256"] !== undefined) problems.push(`${label} carries a body (the plan is GET without a body)`);
  }
  // 価格（subject と quote 文書は同じ値）。
  const pricing = isRecord(subject["pricing"]) ? subject["pricing"] : undefined;
  let total: string = exp.total ?? exp.maxTotal;
  if (pricing === undefined) {
    problems.push("subject.pricing is missing");
  } else {
    if (!isRecord(quote["pricing"]) || stableJson(quote["pricing"]) !== stableJson(pricing)) problems.push("quote.pricing differs from subject.pricing");
    eq("subject.pricing.upstreamAmount", pricing["upstreamAmount"], exp.upstreamAmount);
    eq("subject.pricing.converted (par 1:1)", pricing["converted"], exp.upstreamAmount);
    const fee = pricing["fee"];
    const shownTotal = pricing["total"];
    if (typeof fee !== "string" || !AMOUNT.test(fee) || typeof shownTotal !== "string" || !AMOUNT.test(shownTotal)) {
      problems.push("subject.pricing.fee/total are not base-unit integers");
    } else {
      total = shownTotal;
      if (exp.gasIndexedFee) {
        const maxFee = pricing["maxFee"];
        const estimate = pricing["estimate"];
        if (typeof maxFee !== "string" || !AMOUNT.test(maxFee)) problems.push("subject.pricing.maxFee (the Tempo gas cap) is missing");
        else {
          const want = BigInt(maxFee) > BigInt(HOSTED_FIXED_FEE) ? maxFee : HOSTED_FIXED_FEE;
          eq("subject.pricing.fee = max(1000, maxFee)", fee, want);
        }
        if (!isRecord(estimate) || typeof estimate["atMs"] !== "number") problems.push("subject.pricing.estimate (the gas estimate at quote time) is missing");
      } else {
        if (pricing["maxFee"] !== undefined || pricing["estimate"] !== undefined) problems.push("subject.pricing carries maxFee/estimate on a destination where the Router pays no chain fee");
        eq("subject.pricing.fee", fee, HOSTED_FIXED_FEE);
        eq("subject.pricing.total", shownTotal, exp.total);
      }
      if (BigInt(shownTotal) !== BigInt(typeof pricing["upstreamAmount"] === "string" && AMOUNT.test(pricing["upstreamAmount"]) ? pricing["upstreamAmount"] : "0") + BigInt(fee)) problems.push("subject.pricing.total is not upstreamAmount + fee");
      if (BigInt(shownTotal) > BigInt(exp.maxTotal)) problems.push(`subject.pricing.total ${shownTotal} is above the plan's ceiling ${exp.maxTotal}`);
    }
  }
  // 源（静的と同じ照合: subject・署名される offer・challenge。額は pricing.total）。
  problems.push(...sourceOfferProblems(subject, quote, src, total, nowMs));
  const qs = isRecord(quote["source"]) ? quote["source"] : {};
  addr("quote.source.payTo (Router receiver)", src.network, qs["payTo"], src.to);
  // 宛先。
  const d = isRecord(subject["destination"]) ? subject["destination"] : {};
  const qd = isRecord(quote["destination"]) ? quote["destination"] : {};
  eq("subject.destination.network", d["network"], dst.network);
  addr("subject.destination.asset", dst.network, d["asset"], dst.asset);
  eq("subject.destination.quoted", d["quoted"], exp.upstreamAmount);
  eq("subject.destinationDecimals", subject["destinationDecimals"], dst.decimals);
  addr("subject.destinationPayTo (upstream recipient)", dst.network, subject["destinationPayTo"], dst.to);
  eq("quote.destination.network", qd["network"], dst.network);
  addr("quote.destination.asset", dst.network, qd["asset"], dst.asset);
  eq("quote.destination.quoted", qd["quoted"], exp.upstreamAmount);
  addr("quote.destination.payTo (upstream recipient)", dst.network, qd["payTo"], dst.to);
  // 開示（返金なし・運用者は宛先を確かめていない・資金が動く時点）。
  const disclosures = isRecord(subject["disclosures"]) ? subject["disclosures"] : undefined;
  if (disclosures === undefined) problems.push("subject.disclosures is missing");
  else {
    if (!isRecord(quote["disclosures"]) || stableJson(quote["disclosures"]) !== stableJson(disclosures)) problems.push("quote.disclosures differs from subject.disclosures");
    eq("subject.disclosures.refundOnFailure", disclosures["refundOnFailure"], false);
    eq("subject.disclosures.destinationVerifiedByOperator", disclosures["destinationVerifiedByOperator"], false);
    eq("subject.disclosures.fundsMoveOnCredential", disclosures["fundsMoveOnCredential"], exp.fundsMoveOnCredential);
  }
  eq("subject.fundsMoveOnCredential (expected per source rail)", subject["fundsMoveOnCredential"], exp.fundsMoveOnCredential);
  // 承認: subject と、署名する quote 文書の両方（Codex H-5 #1）。required・この quote への束縛・同じ有限の期限・期限の前、がそろわなければ署名しない
  // （subject だけを見ると、期限の切れた quote 文書に Tempo の送金を署名し得る）。
  const approvalProblems = (label: string, value: unknown): number | undefined => {
    if (!isRecord(value)) {
      problems.push(`${label} is missing`);
      return undefined;
    }
    eq(`${label}.required`, value["required"], true);
    eq(`${label}.boundTo = subject.quoteId`, value["boundTo"], subject["quoteId"]);
    const deadline = value["deadlineMs"];
    if (typeof deadline !== "number" || !Number.isFinite(deadline)) {
      problems.push(`${label}.deadlineMs is missing or not a finite number`);
      return undefined;
    }
    if (deadline <= nowMs) problems.push(`${label}.deadlineMs has passed`);
    return deadline;
  };
  const subjectDeadline = approvalProblems("subject.approval", subject["approval"]);
  const quoteDeadline = approvalProblems("quote.approval", quote["approval"]);
  if (subjectDeadline !== undefined && quoteDeadline !== undefined && subjectDeadline !== quoteDeadline) problems.push("quote.approval.deadlineMs differs from subject.approval.deadlineMs");
  return problems;
}

/**
 * hosted の追加の保留（SR-H7）: Tempo MPP を源とするプロファイルは、**どの plan・どの label でも**、資金が動く署名を呼んだ試みが
 * `verified` で終わっていなければ二度と署名しない（証跡の無い署名の印・読めない印も保留）。`verified` で終わった試みは、別の label（G-3 → G-4）で買ってよい。
 */
export function hostedProfileHold(evidenceDir: string, planned: HostedPurchase, all: readonly PurchaseEvidence[]): string | undefined {
  if (!planned.source.fundsMoveAtSign) return undefined;
  const unresolved = all.find((e) => e.profileId === planned.profileId && e.fundsMoveAtSign === true && e.signInvoked === true && e.stage !== "verified");
  if (unresolved !== undefined) return `${planned.profileId} invoked a funds-moving signature under ${unresolved.routeId} (${unresolved.runId}) that ended at stage ${unresolved.stage}; never re-signed under any plan or label`;
  const root = path.join(evidenceDir, "attempts");
  if (!existsSync(root)) return undefined;
  const prefix = `${planned.profileId}@`;
  const suffix = `${signMarkerIdOf("")}.json`;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of readdirSync(path.join(root, entry.name))) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
      const routeId = name.slice(0, -suffix.length);
      if (!all.some((e) => e.planSha256 === entry.name && e.routeId === routeId && e.stage === "verified")) {
        return `a funds-moving sign marker for ${planned.profileId} (${routeId}, plan ${entry.name}) has no verified evidence; never re-signed under any plan or label`;
      }
    }
  }
  return undefined;
}

/** hosted の実行のモード。`ownerKey` は quote の直後に秘密に入れ（stdout・証跡から消す）、署名の前に私的な置き場へ O_EXCL・fsync で残す。 */
function hostedMode(evidenceDir: string, secrets: Secrets): RunMode<HostedPurchase> {
  const keys = new Map<string, string>();
  const ownerKeyOf = (paymentId: string | undefined): string | undefined => (paymentId === undefined ? undefined : (keys.get(paymentId) ?? readOwnerKey(evidenceDir, paymentId)));
  return {
    kind: "hosted-matrix",
    direction: "hosted",
    name: "hosted matrix run",
    selects: (planned, only) => planned.routeId === only || planned.profileId === only,
    requestIdOf: (planned, now) => `hx-${planned.profileId}-${compactUtc(now)}-${randomBytes(3).toString("hex")}`,
    async quote(mcp, planned, requestId) {
      const quoted = await mcp.call("subetha_router_quote_url", { profileId: planned.profileId, url: planned.url, requestId });
      const doc = quoted["quote"];
      if (isRecord(doc) && typeof doc["ownerKey"] === "string") secrets.add(doc["ownerKey"]);
      return quoted;
    },
    mismatches: (quoted, planned, nowMs) => hostedSubjectMismatches(quoted, planned, nowMs),
    extraHold: (planned, all) => hostedProfileHold(evidenceDir, planned, all),
    annotate(evidence, planned) {
      evidence.profileId = planned.profileId;
      evidence.upstreamUrl = planned.url;
    },
    beforeSign(quoted, planned, evidence) {
      const doc = quoted["quote"] as Record<string, unknown>;
      const ownerKey = doc["ownerKey"] as string;
      const paymentId = evidence.paymentId ?? "";
      try {
        saveOwnerKey(evidenceDir, paymentId, ownerKey, { routeId: planned.routeId, profileId: planned.profileId });
      } catch {
        return "could not persist the quote's ownerKey in the private evidence";
      }
      keys.set(paymentId, ownerKey);
      evidence.ownerKeyRef = ownerKeyRefOf(paymentId);
      return undefined;
    },
    statusArgs(evidence) {
      const ownerKey = ownerKeyOf(evidence.paymentId);
      return { paymentId: evidence.paymentId, ...(ownerKey === undefined ? {} : { ownerKey }) };
    },
    purchaseRecord: (purchased) => {
      const result = purchased["result"];
      return isRecord(result) ? { ...purchased, result: withoutBody(result, "body") } : purchased;
    },
    deliveredBody: (purchased) => (isRecord(purchased["result"]) ? purchased["result"]["body"] : undefined),
    routerBody: (projection) => (isRecord(projection["result"]) ? projection["result"]["body"] : undefined),
    legsOf(planned, quoted) {
      const subject = quoted["subject"] as Record<string, unknown>;
      const pricing = subject["pricing"] as Record<string, unknown>;
      return { source: { ...planned.source, amount: String(pricing["total"]) }, destination: planned.destination };
    },
  };
}

export interface HostedRunOptions extends LoopOptions<HostedPurchase> {
  readonly plan: HostedPlan;
}

/** hosted の 36 件を 1 つずつ（`runMatrix` と同じ順序と保証。事前の入金はしない）。 */
export async function runHostedMatrix(opts: HostedRunOptions, deps: MatrixRunDeps): Promise<RunReport> {
  if (opts.plan.kind !== HOSTED_PLAN_KIND) throw new PlanRefusal("not a hosted matrix plan");
  return await runMatrixLoop(opts, deps, hostedMode(opts.evidenceDir, deps.secrets));
}
