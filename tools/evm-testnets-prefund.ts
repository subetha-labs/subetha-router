/**
 * 掛け合わせの検証の **事前の入金**（`docs/evm-testnets-x402-design.md` §8.2・§8.5 #3・#5）。**製品コードではない**（運用者の道具。実鍵で送金する）。
 *
 * Router の送信鍵 T8 が払う行列のレグ（新 3 の Provider・Provider B（Tempo）・Arc の Provider）の額 × 1.5 を目標に、T8 の今の残高との差を T7 から入れる。
 * Solana の送信鍵（T6 の Solana payer）は既存の残高で払う（入金しない。§8.2）。
 *
 * - `plan --out <file>`: 読み取りだけ。送金の表（順・network・資産・方法・額）と T7・T8 の残高、検査を `<file>`（JSON）と `.txt` に書き、canonical sha256 を表示する。
 * - `run --plan <file> --plan-sha256 <hex> --evidence-dir <dir>`: hash が一致したときだけ、表の順に 1 件ずつ。**再試行しない**。各送金の前に不変の印（O_EXCL・fsync）を作り、
 *   同じ plan の同じ番号は二度と送らない。失敗・不明で止まる。tx hash を表示・記録する。
 *
 * 方法:
 * - 新 3（rh・arbsep・hyperevm）: T7 は native の gas を持たない（§1.4）ので、T7 が EIP-3009 の authorization に署名し、自前の facilitator の `/settle` に渡す
 *   （gas は facilitator の E-FAC）。facilitator は 1 回の settle を 20,000 以下に限る（`MAX_AMOUNT`）ので **20,000 以下の複数の authorization** に分ける（§8.5 #3）。
 *   requirements は Router の受信 offer と同じ形（表の domain・許された extra の鍵だけ・`accepted` は requirements と同一）。facilitator の検査は緩めない。
 *   facilitator の `EVM_FACILITATOR_PAYTO_ALLOWLIST` に T8 が要る（受信の受取先として既に入っている）。
 * - Arc USDC: T7 の普通の ERC-20 `transfer`（Arc の gas は native の USDC = 同じ資金。手数料の見込みを T7 の必要額に足す）。
 * - Tempo pathUSD: T7 の普通の TIP-20 `transfer`（手数料は fee token の pathUSD。`tools/dyn-mpp-*` と同じ `feeToken`）。
 *
 * env（値は出さない）: `SUBETHA_PAYER_ADDRESS`／`SUBETHA_PAYER_PRIVATE_KEY`（T7。run は鍵が必須）、`SUBETHA_ROUTER_OUTBOUND_ADDRESS`（無ければ `SUBETHA_OUTBOUND_X402_KEY`・
 * `SUBETHA_OUTBOUND_PRIVATE_KEY` から、それも無ければ `SUBETHA_ROUTER_RECEIVER` = T8）、`SUBETHA_EVM_FACILITATOR_URL`（run。token は path）、
 * `EVM_FACILITATOR_RPC_<chainId>`（読み取りの RPC の上書き。Tempo 42431・Arc 5042002 も同じ名前）。
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { KNOWN_NETWORKS, knownAssetOf, knownNetworkOf } from "../src/shared/networks.js";
import { MAX_AMOUNT } from "./evm-facilitator.js";
import {
  argOf,
  ASSET_SYMBOL,
  attemptMarkerStateOf,
  checkPrivateEvidenceDir,
  createAttemptMarker,
  NETWORK_LABEL,
  PlanRefusal,
  planSha256,
  rpcUrlOf,
  Secrets,
  short,
  units,
  viemChainReader,
  writePrivate,
  type ChainReader,
} from "./evm-testnets-e2e.js";
import { TEMPO_FEE_ALLOWANCE } from "./evm-testnets-matrix.js";
import { isMatrixNewChain, MATRIX_RAILS, matrixPairsOf, type MatrixEndpoint } from "./remote-mcp-config.js";

type Env = Readonly<Record<string, string | undefined>>;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const PREFUND_PLAN_KIND = "subetha-evm-testnets-prefund-plan";
export const PREFUND_PLAN_VERSION = 1;
/** 1 回の EIP-3009 の上限（自前 facilitator の `MAX_AMOUNT` と同じ値。facilitator は緩めない）。 */
export const PREFUND_CHUNK_MAX = MAX_AMOUNT;
/** 余裕（目標 = 必要額 × 3/2 の切り上げ）。 */
export const PREFUND_MARGIN_NUM = 3n;
export const PREFUND_MARGIN_DEN = 2n;
/** Arc の送金 1 回の gas の見込み（Arc USDC の 6 桁の単位。native の USDC と同じ資金）。 */
export const ARC_GAS_ALLOWANCE = 10_000n;
/** 入金する端点（T8 が送信で払うもの）。Solana の送信鍵は入金しない。 */
export const PREFUND_ENDPOINTS: readonly MatrixEndpoint[] = Object.freeze(["rh", "arbsep", "hyperevm", "arc", "tempo"]);

export type PrefundMethod = "eip3009_via_self_hosted_facilitator" | "erc20_transfer";
export interface PrefundTransfer {
  readonly index: number;
  readonly endpoint: MatrixEndpoint;
  readonly network: string;
  readonly networkLabel: string;
  readonly asset: string;
  readonly assetSymbol: string;
  readonly decimals: number;
  readonly method: PrefundMethod;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  readonly gasPayer: string;
}
export interface PrefundNeed {
  readonly endpoint: MatrixEndpoint;
  readonly network: string;
  readonly asset: string;
  readonly legs: number;
  /** T8 が行列で払う額（レグ × 10,000、Tempo は手数料の見込みを足す）。 */
  readonly need: string;
  /** 目標（need × 1.5 の切り上げ）。 */
  readonly target: string;
  readonly routerBalance: string | null;
  /** 入れる額（max(0, target − 今の残高)）。 */
  readonly topUp: string;
}
export interface PrefundCheck {
  readonly role: string;
  readonly address: string;
  readonly network: string;
  readonly asset: string;
  readonly need: string;
  readonly have: string | null;
  readonly ok: boolean;
  readonly note: string;
}
export interface PrefundPlan {
  readonly kind: typeof PREFUND_PLAN_KIND;
  readonly version: typeof PREFUND_PLAN_VERSION;
  readonly createdAt: string;
  readonly payer: string;
  readonly router: string;
  readonly needs: readonly PrefundNeed[];
  readonly transfers: readonly PrefundTransfer[];
  readonly checks: readonly PrefundCheck[];
  readonly allSufficient: boolean;
}

async function addressOfKey(key: string): Promise<string> {
  const { privateKeyToAccount } = await import("viem/accounts");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("a private key env is not a 0x-prefixed 32-byte hex string");
  return privateKeyToAccount(key as `0x${string}`).address;
}

/** T7（払い手）と T8（Router の送信鍵）のアドレス（鍵があれば導くだけ）。 */
export async function prefundAddressesOf(env: Env): Promise<{ payer: string; router: string }> {
  const pick = async (addressEnv: string, keyEnvs: readonly string[]): Promise<string | undefined> => {
    const direct = env[addressEnv];
    if (direct !== undefined && direct !== "") {
      if (!ADDRESS.test(direct)) throw new Error(`${addressEnv} must be an EVM address`);
      return direct;
    }
    for (const keyEnv of keyEnvs) {
      const key = env[keyEnv];
      if (key !== undefined && key !== "") return await addressOfKey(key);
    }
    return undefined;
  };
  const payer = await pick("SUBETHA_PAYER_ADDRESS", ["SUBETHA_PAYER_PRIVATE_KEY"]);
  if (payer === undefined) throw new Error("SUBETHA_PAYER_ADDRESS or SUBETHA_PAYER_PRIVATE_KEY is required");
  const router = (await pick("SUBETHA_ROUTER_OUTBOUND_ADDRESS", ["SUBETHA_OUTBOUND_X402_KEY", "SUBETHA_OUTBOUND_PRIVATE_KEY"])) ?? env["SUBETHA_ROUTER_RECEIVER"];
  if (router === undefined || !ADDRESS.test(router)) throw new Error("the Router's outbound address (SUBETHA_ROUTER_OUTBOUND_ADDRESS / its key / SUBETHA_ROUTER_RECEIVER) is required");
  if (payer.toLowerCase() === router.toLowerCase()) throw new Error("the payer and the Router's outbound key must differ");
  return { payer, router };
}

/** T8 が行列で払う額（端点ごと）。純粋。 */
export function prefundNeedsOf(): { endpoint: MatrixEndpoint; network: string; asset: string; legs: number; need: bigint }[] {
  return PREFUND_ENDPOINTS.map((endpoint) => {
    const legs = matrixPairsOf().filter((p) => p.dst === endpoint).length;
    const rail = MATRIX_RAILS[endpoint];
    const need = BigInt(legs) * 10_000n + (endpoint === "tempo" ? BigInt(legs) * TEMPO_FEE_ALLOWANCE : 0n);
    return { endpoint, network: rail.network, asset: rail.asset, legs, need };
  });
}

/** 額を 20,000 以下の塊に分ける（順に 20,000、最後に残り）。 */
export function chunksOf(amount: bigint, max: bigint = PREFUND_CHUNK_MAX): bigint[] {
  const out: bigint[] = [];
  let left = amount;
  while (left > 0n) {
    const piece = left > max ? max : left;
    out.push(piece);
    left -= piece;
  }
  return out;
}

export async function buildPrefundPlan(env: Env, reader: ChainReader, now: () => Date = () => new Date()): Promise<PrefundPlan> {
  const { payer, router } = await prefundAddressesOf(env);
  const needs: PrefundNeed[] = [];
  const transfers: PrefundTransfer[] = [];
  const checks: PrefundCheck[] = [];
  const read = async (network: string, asset: string, owner: string): Promise<bigint | null> => {
    try {
      return await reader.tokenBalance(network, asset, owner);
    } catch {
      return null;
    }
  };
  for (const n of prefundNeedsOf()) {
    const target = (n.need * PREFUND_MARGIN_NUM + PREFUND_MARGIN_DEN - 1n) / PREFUND_MARGIN_DEN;
    const routerBalance = await read(n.network, n.asset, router);
    // 残高が読めなければ目標の全額を入れる計画にする（足りないよりよい。plan に読めなかったことが残る）。
    const topUp = routerBalance === null ? target : routerBalance >= target ? 0n : target - routerBalance;
    needs.push({ endpoint: n.endpoint, network: n.network, asset: n.asset, legs: n.legs, need: n.need.toString(), target: target.toString(), routerBalance: routerBalance === null ? null : routerBalance.toString(), topUp: topUp.toString() });
    if (topUp === 0n) continue;
    const viaFacilitator = isMatrixNewChain(n.endpoint);
    const pieces = viaFacilitator ? chunksOf(topUp) : [topUp];
    for (const piece of pieces) {
      transfers.push({
        index: transfers.length + 1,
        endpoint: n.endpoint,
        network: n.network,
        networkLabel: NETWORK_LABEL[n.network] ?? n.network,
        asset: n.asset,
        assetSymbol: ASSET_SYMBOL[n.network] ?? "?",
        decimals: 6,
        method: viaFacilitator ? "eip3009_via_self_hosted_facilitator" : "erc20_transfer",
        from: payer,
        to: router,
        amount: piece.toString(),
        gasPayer: viaFacilitator ? "self-hosted facilitator (E-FAC)" : n.endpoint === "arc" ? "payer (T7), Arc native USDC" : "payer (T7), fee token pathUSD",
      });
    }
    // T7 の残高: 入れる額 + 手数料の見込み（Arc は gas、Tempo は fee token）。
    const payerNeed = topUp + (n.endpoint === "arc" ? ARC_GAS_ALLOWANCE : n.endpoint === "tempo" ? TEMPO_FEE_ALLOWANCE : 0n);
    const have = await read(n.network, n.asset, payer);
    checks.push({ role: "payer", address: payer, network: n.network, asset: n.asset, need: payerNeed.toString(), have: have === null ? null : have.toString(), ok: have !== null && have >= payerNeed, note: viaFacilitator ? `${String(pieces.length)} EIP-3009 authorization(s) of <= ${PREFUND_CHUNK_MAX.toString()} each` : n.endpoint === "arc" ? "transfer + gas allowance (Arc gas is native USDC)" : "transfer + fee allowance (fee token pathUSD)" });
  }
  return { kind: PREFUND_PLAN_KIND, version: PREFUND_PLAN_VERSION, createdAt: now().toISOString(), payer, router, needs, transfers, checks, allSufficient: checks.every((c) => c.ok) };
}

export function prefundPlanText(plan: PrefundPlan, sha: string): string {
  const lines: string[] = [];
  lines.push(`Matrix prefund plan (design §8.2/§8.5 #3) — created ${plan.createdAt}`);
  lines.push(`plan sha256 (canonical JSON): ${sha}`);
  lines.push("Nothing is sent by `plan`. `run` refuses unless --plan-sha256 equals this hash; each transfer is sent at most once, no retries.");
  lines.push(`payer (T7) ${plan.payer} -> Router outbound key (T8) ${plan.router}`);
  lines.push("");
  lines.push("Needs (T8 pays these matrix legs; target = need x 1.5; top-up = target - current T8 balance):");
  for (const n of plan.needs) lines.push(`  ${n.endpoint.padEnd(9)} ${(NETWORK_LABEL[n.network] ?? n.network).padEnd(26)} legs ${String(n.legs)} need ${n.need} target ${n.target} T8 has ${n.routerBalance ?? "?"} -> top-up ${n.topUp}`);
  lines.push("");
  lines.push("Transfers (in this order):");
  for (const t of plan.transfers) lines.push(`  #${String(t.index).padEnd(2)} ${t.networkLabel.padEnd(26)} ${t.method.padEnd(36)} ${short(t.from)} -> ${short(t.to)}  ${t.amount} / 6 (${units(t.amount, 6)} ${t.assetSymbol})  gas: ${t.gasPayer}`);
  lines.push("");
  lines.push("Checks:");
  for (const c of plan.checks) lines.push(`  [${c.ok ? "ok" : "SHORT"}] ${c.role} ${short(c.address)} ${(NETWORK_LABEL[c.network] ?? c.network).padEnd(26)} need ${c.need} have ${c.have ?? "?"} — ${c.note}`);
  lines.push(`All sufficient: ${plan.allSufficient ? "yes" : "NO"}`);
  return `${lines.join("\n")}\n`;
}

export function loadApprovedPrefundPlan(file: string, expectedSha: string): PrefundPlan {
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new PlanRefusal("--plan-sha256 must be 64 lowercase hex characters");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PlanRefusal("the plan file is not readable JSON");
  }
  const actual = planSha256(parsed);
  if (actual !== expectedSha) throw new PlanRefusal(`the plan's canonical sha256 is ${actual}, not the approved ${expectedSha}; refusing`);
  const plan = parsed as PrefundPlan;
  if (plan.kind !== PREFUND_PLAN_KIND || plan.version !== PREFUND_PLAN_VERSION || !Array.isArray(plan.transfers)) throw new PlanRefusal("not a prefund plan of a known version");
  return plan;
}

/* ────────────────────────────────────────────────────────────────────────────── run */

/** facilitator の `/settle` に渡す要求（Router の受信 offer と同じ形の requirements と、`npm run sign` と同じ封筒の paymentPayload）。純粋。 */
export function eip3009OfferOf(t: PrefundTransfer, nowSeconds: number, nonce: string): Record<string, unknown> {
  const entry = knownNetworkOf(KNOWN_NETWORKS, t.network);
  const known = entry === undefined ? undefined : knownAssetOf(entry, t.asset);
  if (known?.domain === undefined) throw new Error(`the table has no EIP-712 domain for ${t.network}`);
  // extra は facilitator が許す鍵だけ（name・version・challengeNonce・expiresAt）。入金専用の鍵は足さない（§8.5 #3）。
  return { scheme: "exact", network: t.network, asset: t.asset, amount: t.amount, payTo: t.to, maxTimeoutSeconds: 60, extra: { name: known.domain.name, version: known.domain.version, challengeNonce: nonce, expiresAt: nowSeconds + 60 } };
}

export interface PrefundDeps {
  readonly payerAddress: string;
  /** EIP-3009 の封筒（base64。`tools/x402-payer.ts` の `credentialFor`）。 */
  signAuthorization(offer: Record<string, unknown>, chainId: number): Promise<string>;
  /** facilitator の `/settle` に POST（再試行しない）。 */
  settle(body: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  /** 普通の送金（Arc・Tempo）。tx hash を返す。送出の前に失敗すれば throw。 */
  transfer(t: PrefundTransfer): Promise<string>;
  /** receipt を待つ（無ければ undefined）。 */
  waitReceipt(network: string, hash: string): Promise<"success" | "reverted" | undefined>;
  readonly secrets: Secrets;
  readonly out: (line: string) => void;
  readonly now?: () => Date;
}

export interface PrefundReport {
  readonly done: readonly { index: number; tx: string }[];
  readonly stopped?: { readonly index: number; readonly reason: string; readonly tx?: string | undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 表の順に 1 件ずつ。印（O_EXCL・fsync）を作ってから送る。失敗・不明で止まる。再試行しない。 */
export async function runPrefund(plan: PrefundPlan, sha: string, evidenceDir: string, deps: PrefundDeps): Promise<PrefundReport> {
  const now = deps.now ?? (() => new Date());
  const out = (line: string): void => deps.out(deps.secrets.redact(line));
  if (deps.payerAddress.toLowerCase() !== plan.payer.toLowerCase()) throw new PlanRefusal("the payer key does not belong to the plan's payer address");
  const done: { index: number; tx: string }[] = [];
  const resultFile = (index: number): string => path.join(evidenceDir, "prefund", sha, `transfer-${String(index)}.json`);
  const stop = (index: number, reason: string, tx?: string): PrefundReport => {
    writePrivate(resultFile(index), { index, at: now().toISOString(), stopped: true, reason, tx: tx ?? null }, deps.secrets);
    out(`STOP prefund #${String(index)}: ${reason}${tx === undefined ? "" : ` (tx ${tx})`}`);
    return { done, stopped: { index, reason, tx } };
  };
  for (const t of plan.transfers) {
    const markerId = `prefund-${String(t.index)}`;
    const state = attemptMarkerStateOf(evidenceDir, sha, markerId);
    if (state !== "absent") {
      out(`STOP prefund #${String(t.index)}: already attempted under this plan (${state}); a new transfer needs a new plan`);
      return { done, stopped: { index: t.index, reason: "already attempted under this plan" } };
    }
    let created: boolean;
    try {
      created = createAttemptMarker(evidenceDir, sha, markerId, { at: now().toISOString(), transfer: t });
    } catch {
      out(`HELD prefund #${String(t.index)}: could not persist the attempt marker; not sending`);
      return { done, stopped: { index: t.index, reason: "held: attempt marker not persisted" } };
    }
    if (!created) return { done, stopped: { index: t.index, reason: "already attempted under this plan" } };
    out(`prefund #${String(t.index)}: ${t.method} ${t.amount} ${t.assetSymbol} on ${t.networkLabel} -> ${t.to}`);
    if (t.method === "eip3009_via_self_hosted_facilitator") {
      const offer = eip3009OfferOf(t, Math.floor(now().getTime() / 1000), `0x${randomBytes(32).toString("hex")}`);
      let paymentPayload: Record<string, unknown>;
      try {
        const credential = await deps.signAuthorization(offer, Number(t.network.split(":")[1]));
        paymentPayload = JSON.parse(Buffer.from(credential, "base64").toString("utf8")) as Record<string, unknown>;
      } catch {
        return stop(t.index, "signing the authorization failed (nothing was sent)");
      }
      let response: { status: number; body: unknown };
      try {
        response = await deps.settle({ x402Version: 2, paymentPayload, paymentRequirements: offer });
      } catch {
        return stop(t.index, "the facilitator call failed or timed out; the authorization may have been used — not retried");
      }
      const body = isRecord(response.body) ? response.body : {};
      const tx = typeof body["transaction"] === "string" ? body["transaction"] : undefined;
      if (response.status === 200 && body["success"] === true && tx !== undefined && /^0x[0-9a-fA-F]{64}$/.test(tx)) {
        writePrivate(resultFile(t.index), { index: t.index, at: now().toISOString(), tx, facilitator: body }, deps.secrets);
        done.push({ index: t.index, tx });
        out(`prefund #${String(t.index)}: settled, tx ${tx}`);
        continue;
      }
      if (response.status === 400) return stop(t.index, `the facilitator refused (400: ${String(body["errorReason"] ?? body["error"] ?? "unknown")}); it answers 400 only for an unused authorization it never sent`);
      return stop(t.index, `the facilitator answered ${String(response.status)}; outcome unknown — not retried`, tx);
    }
    let hash: string;
    try {
      hash = await deps.transfer(t);
    } catch {
      return stop(t.index, "the transfer could not be sent or its result is unknown — not retried");
    }
    let receipt: "success" | "reverted" | undefined;
    try {
      receipt = await deps.waitReceipt(t.network, hash);
    } catch {
      receipt = undefined;
    }
    writePrivate(resultFile(t.index), { index: t.index, at: now().toISOString(), tx: hash, receipt: receipt ?? null }, deps.secrets);
    if (receipt !== "success") return stop(t.index, receipt === "reverted" ? "the transfer reverted" : "no receipt within the wait; outcome unknown — not retried", hash);
    done.push({ index: t.index, tx: hash });
    out(`prefund #${String(t.index)}: confirmed, tx ${hash}`);
  }
  out(`prefund: all ${String(done.length)} transfer(s) done`);
  return { done };
}

/** 本番の依存（viem・`tools/x402-payer.ts`・facilitator の HTTP）。 */
async function realDeps(env: Env, secrets: Secrets): Promise<PrefundDeps> {
  const key = env["SUBETHA_PAYER_PRIVATE_KEY"];
  if (key === undefined || key === "") throw new PlanRefusal("SUBETHA_PAYER_PRIVATE_KEY is required for run");
  const facilitator = env["SUBETHA_EVM_FACILITATOR_URL"];
  const viem = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { tempoModerato } = await import("viem/tempo/chains");
  const { createX402Payer } = await import("./x402-payer.js");
  const account = privateKeyToAccount(key as `0x${string}`);
  const payer = createX402Payer(key);
  const erc20 = viem.parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
  const clientOf = (network: string) => {
    const chainId = Number(network.split(":")[1]);
    const rpc = rpcUrlOf(network, env);
    const chain =
      chainId === tempoModerato.id
        ? ({ ...tempoModerato, feeToken: MATRIX_RAILS.tempo.asset } as never)
        : viem.defineChain({ id: chainId, name: network, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    // 送金は再試行しない（transport の再試行を 0 に）。
    return viem.createWalletClient({ account, chain, transport: viem.http(rpc, { retryCount: 0, timeout: 30_000 }) }).extend(viem.publicActions);
  };
  return {
    payerAddress: account.address,
    signAuthorization: (offer, chainId) => payer.credentialFor(offer as never, chainId),
    async settle(body) {
      if (facilitator === undefined || facilitator === "") throw new Error("SUBETHA_EVM_FACILITATOR_URL is required");
      const response = await fetch(`${facilitator.replace(/\/$/, "")}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000), redirect: "error" });
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }
      return { status: response.status, body: parsed };
    },
    async transfer(t) {
      const client = clientOf(t.network);
      const data = viem.encodeFunctionData({ abi: erc20, functionName: "transfer", args: [t.to as `0x${string}`, BigInt(t.amount)] });
      return await client.sendTransaction({ to: t.asset as `0x${string}`, data, ...(t.endpoint === "tempo" ? { feeToken: MATRIX_RAILS.tempo.asset } : {}) } as never);
    },
    async waitReceipt(network, hash) {
      try {
        const receipt = await clientOf(network).waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 90_000, retryCount: 0 });
        return receipt.status;
      } catch {
        return undefined;
      }
    },
    secrets,
    out: (line) => process.stdout.write(`${line}\n`),
  };
}

async function main(argv: readonly string[], env: Env): Promise<number> {
  const secrets = Secrets.fromEnv(env);
  const command = argv[0];
  if (command === "plan") {
    const outFile = argOf(argv, "out");
    if (outFile === undefined) throw new PlanRefusal("--out <file> is required");
    const plan = await buildPrefundPlan(env, await viemChainReader(env));
    const sha = planSha256(plan);
    writePrivate(outFile, plan, secrets);
    const text = prefundPlanText(plan, sha);
    writePrivate(`${outFile.replace(/\.json$/, "")}.txt`, text, secrets);
    process.stdout.write(secrets.redact(text));
    return plan.allSufficient ? 0 : 3;
  }
  if (command === "run") {
    const planFile = argOf(argv, "plan");
    const sha = argOf(argv, "plan-sha256");
    const dir = argOf(argv, "evidence-dir");
    if (planFile === undefined || sha === undefined || dir === undefined) throw new PlanRefusal("run needs --plan, --plan-sha256 and --evidence-dir");
    const plan = loadApprovedPrefundPlan(planFile, sha);
    const report = await runPrefund(plan, sha, checkPrivateEvidenceDir(dir), await realDeps(env, secrets));
    return report.stopped === undefined ? 0 : 1;
  }
  process.stderr.write("usage: tsx tools/evm-testnets-prefund.ts plan --out <file> | run --plan <file> --plan-sha256 <hex> --evidence-dir <dir>\n");
  return 2;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const secrets = Secrets.fromEnv(process.env);
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const message = error instanceof PlanRefusal ? error.message : error instanceof Error ? error.message : "failed";
      process.stderr.write(`evm-testnets-prefund: ${secrets.redact(message)}\n`);
      process.exit(2);
    },
  );
}
