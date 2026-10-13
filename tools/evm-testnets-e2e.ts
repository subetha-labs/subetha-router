/**
 * EVM testnet 4 つの受け入れの driver（`docs/evm-testnets-x402-design.md` §3.8・§3.9、FR-E7・FR-E8・AC-E7、タスク E-4b）。**製品コードではない**（運用者の道具）。
 *
 * subcommands（鍵・token・credential は stdout にも証跡にも出さない。既知の秘密の値は `[redacted]` に置き換える）:
 * - `plan --chains rh,arbsep,hyperevm,sepolia --out <file>`: env のアドレスだけを読み（鍵があればアドレスを導くだけ）、公開 RPC から残高を読み取り専用で読み、
 *   8 購入（各 chain で受信 → 送信の順）の資金の表・資産ごとの合計・残高の足りるかの検査を `<file>`（JSON）と `<file の拡張子を .txt に>`（表）に書く。
 *   canonical JSON（`stableJson`）の sha256 を表示する。何も署名しない。
 * - `run --plan <file> --plan-sha256 <hex> --mcp-url <url> [--token <env name>] --evidence-dir <dir> [--only <routeId>]
 *   [--router-journal <file>] [--facilitator-journal <file>] [--facilitator-log <file>] [--inbound-confirmation finalized|receipt] [--wait-finalized-seconds <n>]`:
 *   plan の hash が一致しなければ何もしない。1 購入ずつ quote（新しい requestId）→ subject と plan の照合 → `runSign`（`npm run sign` と同じ）→ purchase（同じ requestId、
 *   approval = quoteId）→ status → 2 レグの chain の読み取り。自動の再試行はしない。`delivered` 以外・照合の不一致で run 全体を止める。
 * - `finality --evidence-dir <dir> [--wait-seconds <n>]`: 記録した tx の確定（§3.9）を読み、証跡に追記する（待ち続けない。pending を報告）。
 * - `reopen --evidence-dir <dir> --mcp-url <url> [--token <env name>]`: 全 paymentId の status を読み直し、保存した結果と比べる（Router を同じ journal で再起動した後に）。
 * - `summary --evidence-dir <dir> --out docs/evidence/evm-testnets/e2e-<date>.json`: 秘密・body・journal の行を除いた公開の要約。
 *
 * env（値は出さない）: `SUBETHA_PAYER_ADDRESS` または `SUBETHA_PAYER_PRIVATE_KEY`（run は鍵が必須）、`SUBETHA_ROUTER_RECEIVER`、`SUBETHA_ROUTER_OUTBOUND_ADDRESS`
 * （無ければ `SUBETHA_OUTBOUND_X402_KEY`・`SUBETHA_OUTBOUND_PRIVATE_KEY` から導く。それも無ければ受取先と同じ = T8 の兼任 §3.8）、`EVM_FACILITATOR_ADDRESS`
 * （無ければ `EVM_FACILITATOR_KEY` から）、`SUBETHA_EVM_PROVIDER_PAYTO`、`EVM_FACILITATOR_RPC_<chainId>`（Base Sepolia も `EVM_FACILITATOR_RPC_84532`）、
 * `EVM_FACILITATOR_GAS_CAP_<chainId>`・`EVM_FACILITATOR_MAX_FEE_PER_GAS_<chainId>`（plan の表示。facilitator と同じ名前）。
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { stableJson } from "../src/core/intent.js";
import { KNOWN_NETWORKS, knownAssetOf, knownNetworkOf } from "../src/shared/networks.js";
import { DEFAULT_MAX_FEE_PER_GAS, DEFAULT_MAX_SETTLE_GAS, DEFAULT_RPC_URLS } from "./evm-facilitator.js";
import { EVM_PROVIDER_PAYTO_ENV, EVM_TESTNET_CHAINS, EVM_TESTNETS, evmInboundRouteOf, evmOutboundRouteOf, evmTestnetChainsOf, evmTestnetsConfigOf, INBOUND, type EvmTestnetChain } from "./remote-mcp-config.js";
import { runSign } from "./sign-run.js";

/* ────────────────────────────────────────────────────────────────────────────── 定数 */

export const PLAN_KIND = "subetha-evm-testnets-e2e-plan";
export const PLAN_VERSION = 1;
/** driver の MCP 呼び出しの期限（設計 §3.6）。purchase の期限切れは `unknown` として扱い、再試行しない。 */
export const MCP_CALL_TIMEOUT_MS = 195_000;
export const BASE_SEPOLIA = "eip155:84532";
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
export const BODY_HEAD_CHARS = 200;
/** `Transfer(address,address,uint256)` の topic0。 */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** facilitator の process の gas の累計の上限の既定（設計 §3.8: 各 network で入金額の半分。wei）。env `EVM_FACILITATOR_GAS_CAP_<chainId>` が優先。 */
export const DESIGN_GAS_CAPS: Readonly<Record<string, bigint>> = Object.freeze({
  "eip155:46630": 5_000_000_000_000_000n,
  "eip155:421614": 25_000_000_000_000_000n,
  "eip155:998": 4_000_000_000_000_000n,
  "eip155:11155111": 5_000_000_000_000_000n,
});
const NATIVE_SYMBOL: Readonly<Record<string, string>> = Object.freeze({ "eip155:46630": "ETH", "eip155:421614": "ETH", "eip155:998": "HYPE", "eip155:11155111": "ETH", [BASE_SEPOLIA]: "ETH" });
const ASSET_SYMBOL: Readonly<Record<string, string>> = Object.freeze({ "eip155:46630": "USDG", "eip155:421614": "USDC", "eip155:998": "USDC", "eip155:11155111": "USDC", [BASE_SEPOLIA]: "USDC" });
const NETWORK_LABEL: Readonly<Record<string, string>> = Object.freeze({
  "eip155:46630": "Robinhood Chain testnet",
  "eip155:421614": "Arbitrum Sepolia",
  "eip155:998": "HyperEVM testnet",
  "eip155:11155111": "Ethereum Sepolia",
  [BASE_SEPOLIA]: "Base Sepolia",
});
/** 確定の規則（設計 §3.9）: HyperEVM は receipt（単一 slot の確定）、ほかは block ≤ `finalized`。 */
export function finalityRuleOf(network: string): "finalized_tag" | "receipt" {
  return network === "eip155:998" ? "receipt" : "finalized_tag";
}

/** 秘密を持ち得る env の名前（値を `[redacted]` に置き換える対象）。 */
export const SECRET_ENV_NAMES: readonly string[] = Object.freeze([
  "SUBETHA_PAYER_PRIVATE_KEY",
  "SUBETHA_OUTBOUND_PRIVATE_KEY",
  "SUBETHA_OUTBOUND_X402_KEY",
  "SUBETHA_OUTBOUND_MPP_KEY",
  "EVM_FACILITATOR_KEY",
  "EVM_FACILITATOR_TOKEN",
  "SUBETHA_EVM_FACILITATOR_URL",
  "SUBETHA_MPP_INBOUND_SECRET",
  "SOLANA_PAYER_PRIVATE_KEY",
]);

type Env = Readonly<Record<string, string | undefined>>;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/* ────────────────────────────────────────────────────────────────────────────── 秘密の除去 */

/** 既知の秘密の値の集合。stdout・証跡に書く前に必ず通す。 */
export class Secrets {
  readonly #values = new Set<string>();
  add(value: string | undefined): void {
    if (value === undefined) return;
    const v = value.trim();
    if (v.length < 8) return;
    this.#values.add(v);
    this.#values.add(v.toLowerCase());
    if (/^0x[0-9a-fA-F]+$/.test(v)) {
      this.#values.add(v.slice(2));
      this.#values.add(v.slice(2).toLowerCase());
    }
    // URL に埋めた token（facilitator の path の接頭辞・RPC の API key）も個別に消す。
    if (/^https?:\/\//.test(v)) {
      try {
        const u = new URL(v);
        for (const part of u.pathname.split("/")) if (part.length >= 16) this.#values.add(part);
        for (const [, q] of u.searchParams) if (q.length >= 16) this.#values.add(q);
      } catch {
        // URL でなければ値そのものだけ。
      }
    }
  }
  static fromEnv(env: Env, extraNames: readonly string[] = []): Secrets {
    const secrets = new Secrets();
    for (const name of [...SECRET_ENV_NAMES, ...extraNames]) secrets.add(env[name]);
    // RPC の上書きは API key を含み得る。
    for (const [name, value] of Object.entries(env)) if (/^EVM_FACILITATOR_RPC_\d+$/.test(name)) secrets.add(value);
    return secrets;
  }
  redact(text: string): string {
    let out = text;
    // 長いものから（部分一致で短いものが先に消して長いものが残らないように）。
    for (const value of [...this.#values].sort((a, b) => b.length - a.length)) {
      if (out.includes(value)) out = out.split(value).join("[redacted]");
    }
    return out;
  }
  /** 試験と最後の検査のため: text に秘密が残っていないか。 */
  leaks(text: string): boolean {
    return [...this.#values].some((value) => text.includes(value));
  }
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;
}

/** directory の fsync（rename・作成を永続にする）。 */
function fsyncDirNode(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** ディレクトリの fsync（試験だけ差し替える。`setDirSyncForTest`）。 */
let fsyncDir: (dir: string) => void = fsyncDirNode;
export function setDirSyncForTest(fn: ((dir: string) => void) | undefined): void {
  fsyncDir = fn ?? fsyncDirNode;
}
/**
 * `dir` から root までの全ディレクトリを深い方から fsync する（Codex I-2 #3）。新しく作った祖先（`attempts` など）の項目も
 * 電源断で失われないように、作ったかどうかによらず毎回。失敗は例外（呼び出し側は購入を始めない）。
 */
function fsyncAncestors(dir: string): void {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    fsyncDir(d);
    if (path.dirname(d) === d) break;
  }
}

/**
 * 証跡を書く（秘密を除いて、0600）。**原子的**: 一時ファイルに書いて fsync → rename → directory の fsync（I-1 #2）。
 * 途中で落ちても、元のファイルは前の内容のまま（切り詰めた状態を残さない）。
 */
function writePrivate(file: string, value: unknown, secrets: Secrets): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const text = secrets.redact(typeof value === "string" ? value : jsonText(value));
  const tmp = `${file}.tmp-${String(process.pid)}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  fsyncAncestors(dir);
}

/**
 * 試みの印（I-1 #2）: 証跡とは別の **不変の** ファイル `<evidenceDir>/attempts/<planSha256>/<routeId>.json`。O_EXCL で作り、書いて fsync、directory も fsync。
 * 既にあれば作らずに `false`（= 既に試みた）。書けなければ例外（呼び出し側は購入を始めない）。
 */
export function attemptMarkerPathOf(evidenceDir: string, planSha: string, routeId: string): string {
  return path.join(evidenceDir, "attempts", planSha, `${routeId}.json`);
}
export function createAttemptMarker(evidenceDir: string, planSha: string, routeId: string, content: Record<string, unknown>): boolean {
  const file = attemptMarkerPathOf(evidenceDir, planSha, routeId);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsyncAncestors(dir);
  let fd: number;
  try {
    fd = openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, jsonText({ kind: "subetha-evm-testnets-e2e-attempt", planSha256: planSha, routeId, ...content }), null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncAncestors(dir);
  return true;
}

/** 印の状態: 無い・読める（同じ plan と route）・読めない（壊れている → 保留）。 */
export function attemptMarkerStateOf(evidenceDir: string, planSha: string, routeId: string): "absent" | "present" | "corrupt" {
  const file = attemptMarkerPathOf(evidenceDir, planSha, routeId);
  if (!existsSync(file)) return "absent";
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return value["kind"] === "subetha-evm-testnets-e2e-attempt" && value["planSha256"] === planSha && value["routeId"] === routeId ? "present" : "corrupt";
  } catch {
    return "corrupt";
  }
}

/** ある route の印（全 plan）。読めない印は `corrupt` に数える。 */
function attemptMarkersForRoute(evidenceDir: string, routeId: string): { planSha: string; state: "present" | "corrupt" }[] {
  const root = path.join(evidenceDir, "attempts");
  if (!existsSync(root)) return [];
  const out: { planSha: string; state: "present" | "corrupt" }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const state = attemptMarkerStateOf(evidenceDir, entry.name, routeId);
    if (state !== "absent") out.push({ planSha: entry.name, state });
  }
  return out;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** plan の canonical な sha256（鍵の順序によらない。`stableJson`）。 */
export function planSha256(plan: unknown): string {
  return sha256Hex(stableJson(plan));
}

/* ────────────────────────────────────────────────────────────────────────────── chain の読み取り（注入できる） */

export interface ReceiptLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}
export interface ReceiptInfo {
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly logs: readonly ReceiptLog[];
}
export interface ChainReader {
  tokenBalance(network: string, asset: string, owner: string): Promise<bigint>;
  nativeBalance(network: string, owner: string): Promise<bigint>;
  /** 今の `maxFeePerGas` の見積もり（wei）。 */
  feeEstimate(network: string): Promise<bigint>;
  receipt(network: string, hash: string): Promise<ReceiptInfo | undefined>;
  /** `finalized` の block 番号。読めなければ undefined。 */
  finalizedBlock(network: string): Promise<bigint | undefined>;
}

/** network の RPC（`EVM_FACILITATOR_RPC_<chainId>`、無ければ facilitator と同じ既定、Base Sepolia は `https://sepolia.base.org`）。 */
export function rpcUrlOf(network: string, env: Env): string {
  const chainId = network.split(":")[1] ?? "";
  const override = env[`EVM_FACILITATOR_RPC_${chainId}`];
  const url = override !== undefined && override !== "" ? override : network === BASE_SEPOLIA ? BASE_SEPOLIA_RPC : DEFAULT_RPC_URLS[network];
  if (url === undefined || !/^https:\/\//.test(url)) throw new Error(`EVM_FACILITATOR_RPC_${chainId} must be an https URL`);
  return url;
}

/** viem の public client（読み取りだけ。鍵は渡さない）。 */
export async function viemChainReader(env: Env): Promise<ChainReader> {
  const viem = await import("viem");
  const erc20 = viem.parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
  const clients = new Map<string, ReturnType<typeof viem.createPublicClient>>();
  const clientOf = (network: string): ReturnType<typeof viem.createPublicClient> => {
    const existing = clients.get(network);
    if (existing !== undefined) return existing;
    const chainId = Number(network.split(":")[1]);
    const rpc = rpcUrlOf(network, env);
    const chain = viem.defineChain({ id: chainId, name: network, nativeCurrency: { name: "native", symbol: NATIVE_SYMBOL[network] ?? "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    // 読み取りだけなので transport の再試行は害が無い（資金は動かない）。
    const client = viem.createPublicClient({ chain, transport: viem.http(rpc, { retryCount: 2, timeout: 15_000 }) });
    clients.set(network, client);
    return client;
  };
  return {
    async tokenBalance(network, asset, owner) {
      return (await clientOf(network).readContract({ address: asset as `0x${string}`, abi: erc20, functionName: "balanceOf", args: [owner as `0x${string}`] })) as bigint;
    },
    async nativeBalance(network, owner) {
      return await clientOf(network).getBalance({ address: owner as `0x${string}` });
    },
    async feeEstimate(network) {
      const client = clientOf(network);
      try {
        const fees = await client.estimateFeesPerGas();
        if (fees.maxFeePerGas !== undefined) return fees.maxFeePerGas;
      } catch {
        // EIP-1559 の見積もりが無い RPC は gasPrice。
      }
      return await client.getGasPrice();
    },
    async receipt(network, hash) {
      try {
        const r = await clientOf(network).getTransactionReceipt({ hash: hash as `0x${string}` });
        return { status: r.status, blockNumber: r.blockNumber, blockHash: r.blockHash, logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })) };
      } catch (error) {
        if (error instanceof Error && /could not be found|not found/i.test(error.message)) return undefined;
        throw error;
      }
    },
    async finalizedBlock(network) {
      try {
        const block = await clientOf(network).getBlock({ blockTag: "finalized" });
        return block.number ?? undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────── plan */

export type Direction = "inbound" | "outbound";
export interface PlanLeg {
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
  readonly facilitator: "self-hosted" | "x402.org";
  readonly gasPayerRole: string;
  /** 自前の facilitator のときだけアドレス。x402.org は自分の鍵（運営の外）。 */
  readonly gasPayer: string | null;
  readonly gasLimitPerSettle: string | null;
  readonly maxFeePerGasCapWei: string | null;
  readonly processGasCapWei: string | null;
}
export interface PlanPurchase {
  readonly index: number;
  readonly chain: EvmTestnetChain;
  readonly direction: Direction;
  readonly routeId: string;
  readonly upstream: string;
  readonly source: PlanLeg;
  readonly destination: PlanLeg;
}
export interface PlanAddresses {
  readonly payer: string;
  readonly routerReceiver: string;
  readonly routerOutbound: string;
  readonly facilitatorGas: string;
  readonly providerPayTo: string;
  readonly providerAPayTo: string;
}
export interface PlanBalance {
  readonly role: string;
  readonly address: string;
  readonly network: string;
  readonly kind: "token" | "native";
  readonly asset: string | null;
  readonly value: string | null;
  readonly error?: string;
}
export interface PlanCheck {
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
export interface PlanNetwork {
  readonly network: string;
  readonly label: string;
  readonly chain: EvmTestnetChain | "base-sepolia";
  readonly rpcOrigin: string;
  readonly asset: string;
  readonly assetSymbol: string;
  readonly decimals: number;
  readonly nativeSymbol: string;
  readonly finalityRule: "finalized_tag" | "receipt";
  readonly estimatedMaxFeePerGasWei: string | null;
}
export interface Plan {
  readonly kind: typeof PLAN_KIND;
  readonly version: typeof PLAN_VERSION;
  readonly createdAt: string;
  readonly chains: readonly EvmTestnetChain[];
  readonly addresses: PlanAddresses;
  readonly addressSources: Readonly<Record<string, string>>;
  readonly networks: readonly PlanNetwork[];
  readonly purchases: readonly PlanPurchase[];
  readonly totals: readonly { readonly role: string; readonly address: string; readonly network: string; readonly asset: string; readonly assetSymbol: string; readonly amount: string; readonly decimals: number }[];
  readonly balances: readonly PlanBalance[];
  readonly checks: readonly PlanCheck[];
  readonly allSufficient: boolean;
}

async function addressOfKey(key: string): Promise<string> {
  const { privateKeyToAccount } = await import("viem/accounts");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("a private key env is not a 0x-prefixed 32-byte hex string");
  return privateKeyToAccount(key as `0x${string}`).address;
}

/** env からアドレスだけを読む（鍵があればアドレスを導く。鍵の値は返さない）。 */
export async function addressesOf(env: Env): Promise<{ addresses: Omit<PlanAddresses, "providerAPayTo">; sources: Record<string, string> }> {
  const sources: Record<string, string> = {};
  const pick = async (role: string, addressEnv: string, keyEnvs: readonly string[]): Promise<string | undefined> => {
    const direct = env[addressEnv];
    if (direct !== undefined && direct !== "") {
      if (!ADDRESS.test(direct)) throw new Error(`${addressEnv} must be an EVM address`);
      sources[role] = addressEnv;
      return direct;
    }
    for (const keyEnv of keyEnvs) {
      const key = env[keyEnv];
      if (key !== undefined && key !== "") {
        sources[role] = `derived from ${keyEnv}`;
        return await addressOfKey(key);
      }
    }
    return undefined;
  };
  const payer = await pick("payer", "SUBETHA_PAYER_ADDRESS", ["SUBETHA_PAYER_PRIVATE_KEY"]);
  if (payer === undefined) throw new Error("SUBETHA_PAYER_ADDRESS or SUBETHA_PAYER_PRIVATE_KEY is required");
  const routerReceiver = env["SUBETHA_ROUTER_RECEIVER"];
  if (routerReceiver === undefined || !ADDRESS.test(routerReceiver)) throw new Error("SUBETHA_ROUTER_RECEIVER must be an EVM address");
  sources["routerReceiver"] = "SUBETHA_ROUTER_RECEIVER";
  let routerOutbound = await pick("routerOutbound", "SUBETHA_ROUTER_OUTBOUND_ADDRESS", ["SUBETHA_OUTBOUND_X402_KEY", "SUBETHA_OUTBOUND_PRIVATE_KEY"]);
  if (routerOutbound === undefined) {
    routerOutbound = routerReceiver;
    sources["routerOutbound"] = "same as SUBETHA_ROUTER_RECEIVER (design §3.8: T8 receives and pays)";
  }
  const facilitatorGas = await pick("facilitatorGas", "EVM_FACILITATOR_ADDRESS", ["EVM_FACILITATOR_KEY"]);
  if (facilitatorGas === undefined) throw new Error("EVM_FACILITATOR_ADDRESS or EVM_FACILITATOR_KEY is required");
  const providerPayTo = env[EVM_PROVIDER_PAYTO_ENV];
  if (providerPayTo === undefined || !ADDRESS.test(providerPayTo)) throw new Error(`${EVM_PROVIDER_PAYTO_ENV} must be an EVM address`);
  sources["providerPayTo"] = EVM_PROVIDER_PAYTO_ENV;
  return { addresses: { payer, routerReceiver, routerOutbound, facilitatorGas, providerPayTo }, sources };
}

interface RouteTerms {
  readonly source: { amount: string; asset: string; decimals: number; network: string; payTo: string };
  readonly destination: { network: string; asset: string; payTo: string };
}

/** 購入の並び（設計 §3.9・依頼: 各 chain で受信 → 送信）。route の条件は **専用の設定生成** `evmTestnetsConfigOf` から取る（plan と Router の設定を 1 つの出所に）。 */
export function purchasesOf(chains: readonly EvmTestnetChain[], addresses: PlanAddresses, env: Env): PlanPurchase[] {
  const placeholderEnv: Record<string, string> = { SUBETHA_EVM_FACILITATOR_URL: "http://127.0.0.1:1/plan-only", [EVM_PROVIDER_PAYTO_ENV]: addresses.providerPayTo };
  for (const chain of chains) placeholderEnv[`SUBETHA_EVM_PROVIDER_URL_${chain.toUpperCase()}`] = `http://127.0.0.1:1/${chain}`;
  const config = evmTestnetsConfigOf(placeholderEnv, addresses.routerReceiver, chains) as { router: { routes: Record<string, RouteTerms> } };
  const routes = config.router.routes;
  const out: PlanPurchase[] = [];
  const gasCapOf = (network: string): bigint => {
    const chainId = network.split(":")[1] ?? "";
    const text = env[`EVM_FACILITATOR_GAS_CAP_${chainId}`];
    return text !== undefined && /^[1-9][0-9]{0,30}$/.test(text) ? BigInt(text) : (DESIGN_GAS_CAPS[network] ?? 0n);
  };
  const maxFeeOf = (network: string): bigint => {
    const chainId = network.split(":")[1] ?? "";
    const text = env[`EVM_FACILITATOR_MAX_FEE_PER_GAS_${chainId}`];
    return text !== undefined && /^[1-9][0-9]{0,30}$/.test(text) ? BigInt(text) : (DEFAULT_MAX_FEE_PER_GAS[network] ?? 1_000_000_000n);
  };
  const maxSettleGasOf = (network: string): bigint => {
    const chainId = network.split(":")[1] ?? "";
    const text = env[`EVM_FACILITATOR_MAX_GAS_${chainId}`];
    return text !== undefined && /^[1-9][0-9]{0,15}$/.test(text) ? BigInt(text) : (DEFAULT_MAX_SETTLE_GAS[network] ?? 200_000n);
  };
  const leg = (network: string, asset: string, decimals: number, amount: string, fromRole: string, from: string, toRole: string, to: string): PlanLeg => {
    const selfHosted = network !== BASE_SEPOLIA;
    return {
      network,
      networkLabel: NETWORK_LABEL[network] ?? network,
      asset,
      assetSymbol: ASSET_SYMBOL[network] ?? "?",
      decimals,
      amount,
      fromRole,
      from,
      toRole,
      to,
      facilitator: selfHosted ? "self-hosted" : "x402.org",
      gasPayerRole: selfHosted ? "facilitatorGas" : "x402.org facilitator (its own key)",
      gasPayer: selfHosted ? addresses.facilitatorGas : null,
      // facilitator は見積もり × 1.25 を送り、この network の上限（`EVM_FACILITATOR_MAX_GAS_<chainId>`、既定 `DEFAULT_MAX_SETTLE_GAS`）を超えれば送らない。資金の表は上限で数える。
      gasLimitPerSettle: selfHosted ? maxSettleGasOf(network).toString() : null,
      maxFeePerGasCapWei: selfHosted ? maxFeeOf(network).toString() : null,
      processGasCapWei: selfHosted ? gasCapOf(network).toString() : null,
    };
  };
  let index = 0;
  for (const chain of chains) {
    for (const direction of ["inbound", "outbound"] as const) {
      const routeId = direction === "inbound" ? evmInboundRouteOf(chain) : evmOutboundRouteOf(chain);
      const route = routes[routeId];
      if (route === undefined) throw new Error(`the generated config has no route ${routeId}`);
      const destDecimals = route.destination.network === BASE_SEPOLIA ? 6 : EVM_TESTNETS[chain].decimals;
      const destRole = direction === "inbound" ? "providerA" : "providerPayTo";
      index += 1;
      out.push({
        index,
        chain,
        direction,
        routeId,
        upstream: direction === "inbound" ? "Provider A (hosted, Base Sepolia x402)" : `${chain} Provider (local wrangler dev --env ${chain})`,
        source: leg(route.source.network, route.source.asset, route.source.decimals, route.source.amount, "payer", addresses.payer, "routerReceiver", route.source.payTo),
        // 送信レグの額は Router の設定では Provider の 402 の値（quote 時）。設計 FR-E5 で 10,000（1:1）。
        destination: leg(route.destination.network, route.destination.asset, destDecimals, route.source.amount, "routerOutbound", addresses.routerOutbound, destRole, route.destination.payTo),
      });
    }
  }
  return out;
}

function balanceKey(address: string, network: string, asset: string | null): string {
  return `${address.toLowerCase()}|${network}|${asset === null ? "native" : asset.toLowerCase()}`;
}

/** 残高の読み取りと検査（純粋でない: reader を呼ぶ）。順に払っていく模擬で、各支払いの時点で払い手が足りるか。 */
export async function buildPlan(chains: readonly EvmTestnetChain[], env: Env, reader: ChainReader, now: () => Date = () => new Date()): Promise<Plan> {
  const { addresses: base, sources } = await addressesOf(env);
  const generated = purchasesOf(chains, { ...base, providerAPayTo: "0x0000000000000000000000000000000000000000" }, env);
  const providerAPayTo = generated.find((p) => p.direction === "inbound")?.destination.to ?? "";
  const addresses: PlanAddresses = { ...base, providerAPayTo };
  sources["providerAPayTo"] = "evmTestnetsConfigOf (Provider A, OUTBOUND_X402.payTo)";
  const purchases = purchasesOf(chains, addresses, env);

  const networkIds = [...chains.map((c) => EVM_TESTNETS[c].network), BASE_SEPOLIA];
  const networks: PlanNetwork[] = [];
  for (const network of networkIds) {
    const chain = (chains.find((c) => EVM_TESTNETS[c].network === network) ?? "base-sepolia") as EvmTestnetChain | "base-sepolia";
    let fee: string | null = null;
    try {
      fee = (await reader.feeEstimate(network)).toString();
    } catch {
      fee = null;
    }
    networks.push({
      network,
      label: NETWORK_LABEL[network] ?? network,
      chain,
      rpcOrigin: new URL(rpcUrlOf(network, env)).origin,
      asset: chain === "base-sepolia" ? INBOUND.asset : EVM_TESTNETS[chain].asset,
      assetSymbol: ASSET_SYMBOL[network] ?? "?",
      decimals: 6,
      nativeSymbol: NATIVE_SYMBOL[network] ?? "ETH",
      finalityRule: finalityRuleOf(network),
      estimatedMaxFeePerGasWei: fee,
    });
  }

  // 残高: 各 network の token と native を、payer・Router（受取・送信）・Provider（C の Provider と Provider A）・facilitator について。
  const roles: { role: string; address: string }[] = [
    { role: "payer", address: addresses.payer },
    { role: "routerReceiver", address: addresses.routerReceiver },
    ...(addresses.routerOutbound.toLowerCase() === addresses.routerReceiver.toLowerCase() ? [] : [{ role: "routerOutbound", address: addresses.routerOutbound }]),
    { role: "providerPayTo", address: addresses.providerPayTo },
    { role: "facilitatorGas", address: addresses.facilitatorGas },
  ];
  const balances: PlanBalance[] = [];
  const read = async (role: string, address: string, network: string, asset: string | null): Promise<void> => {
    try {
      const value = asset === null ? await reader.nativeBalance(network, address) : await reader.tokenBalance(network, asset, address);
      balances.push({ role, address, network, kind: asset === null ? "native" : "token", asset, value: value.toString() });
    } catch {
      balances.push({ role, address, network, kind: asset === null ? "native" : "token", asset, value: null, error: "rpc_read_failed" });
    }
  };
  for (const n of networks) {
    for (const r of roles) {
      if (n.network === BASE_SEPOLIA && r.role === "facilitatorGas") continue; // Base Sepolia の gas は x402.org の鍵。
      if (n.network === BASE_SEPOLIA && r.role === "providerPayTo") continue;
      await read(r.role, r.address, n.network, n.asset);
      await read(r.role, r.address, n.network, null);
    }
  }
  await read("providerA", addresses.providerAPayTo, BASE_SEPOLIA, INBOUND.asset);

  // 合計（払い手 × network × 資産）。
  const totalsMap = new Map<string, { role: string; address: string; network: string; asset: string; assetSymbol: string; amount: bigint; decimals: number }>();
  for (const p of purchases) {
    for (const legValue of [p.source, p.destination]) {
      const key = `${legValue.fromRole}|${legValue.network}|${legValue.asset}`;
      const t = totalsMap.get(key) ?? { role: legValue.fromRole, address: legValue.from, network: legValue.network, asset: legValue.asset, assetSymbol: legValue.assetSymbol, amount: 0n, decimals: legValue.decimals };
      t.amount += BigInt(legValue.amount);
      totalsMap.set(key, t);
    }
  }
  const totals = [...totalsMap.values()].map((t) => ({ ...t, amount: t.amount.toString() }));

  // 検査 1: 順に払う模擬（受信で Router に入った資金を同じ chain の送信に使う §3.8）。
  const running = new Map<string, bigint | null>();
  for (const b of balances) running.set(balanceKey(b.address, b.network, b.asset), b.value === null ? null : BigInt(b.value));
  const checks: PlanCheck[] = [];
  const firstShort = new Map<string, PlanCheck>();
  const needByKey = new Map<string, bigint>();
  for (const p of purchases) {
    for (const legValue of [p.source, p.destination]) {
      const fromKey = balanceKey(legValue.from, legValue.network, legValue.asset);
      const toKey = balanceKey(legValue.to, legValue.network, legValue.asset);
      const amount = BigInt(legValue.amount);
      needByKey.set(fromKey, (needByKey.get(fromKey) ?? 0n) + amount);
      const have = running.get(fromKey);
      if ((have === undefined || have === null || have < amount) && !firstShort.has(fromKey)) {
        firstShort.set(fromKey, {
          role: legValue.fromRole,
          address: legValue.from,
          network: legValue.network,
          kind: "token",
          asset: legValue.asset,
          need: amount.toString(),
          have: have === undefined || have === null ? null : have.toString(),
          ok: false,
          note: `short at purchase #${p.index} ${p.routeId} (${p.direction} ${legValue === p.source ? "source" : "destination"} leg)`,
        });
      }
      running.set(fromKey, have === undefined || have === null ? null : have - amount);
      const toHave = running.get(toKey);
      if (toHave !== undefined && toHave !== null) running.set(toKey, toHave + amount);
    }
  }
  for (const [key, need] of needByKey) {
    const short = firstShort.get(key);
    if (short !== undefined) {
      checks.push(short);
      continue;
    }
    const [address = "", network = "", asset = ""] = key.split("|");
    const b = balances.find((x) => balanceKey(x.address, x.network, x.asset) === key);
    const role = purchases.flatMap((p) => [p.source, p.destination]).find((l) => balanceKey(l.from, l.network, l.asset) === key)?.fromRole ?? "?";
    const fundedByInbound = role === "routerOutbound" || role === "routerReceiver";
    checks.push({
      role,
      address: b?.address ?? address,
      network,
      kind: "token",
      asset: b?.asset ?? asset,
      need: need.toString(),
      have: b?.value ?? null,
      ok: true,
      note: fundedByInbound ? "enough at every step, counting the Router's receipts from earlier purchases in this order (design §3.8)" : "enough at every step",
    });
  }
  // 検査 2: facilitator の gas（各 C で 2 回の settle: 受信の source レグと送信の destination レグ）。
  for (const n of networks) {
    if (n.network === BASE_SEPOLIA) continue;
    const settles = BigInt(purchases.flatMap((p) => [p.source, p.destination]).filter((l) => l.network === n.network && l.facilitator === "self-hosted").length);
    const legSample = purchases.flatMap((p) => [p.source, p.destination]).find((l) => l.network === n.network && l.facilitator === "self-hosted");
    const cap = BigInt(legSample?.processGasCapWei ?? "0");
    const maxFeeCap = BigInt(legSample?.maxFeePerGasCapWei ?? "0");
    const estimate = n.estimatedMaxFeePerGasWei === null ? null : BigInt(n.estimatedMaxFeePerGasWei);
    const gasLimit = BigInt(legSample?.gasLimitPerSettle ?? "0");
    const need = estimate === null ? null : settles * gasLimit * estimate;
    const b = balances.find((x) => x.role === "facilitatorGas" && x.network === n.network && x.kind === "native");
    const have = b?.value === null || b?.value === undefined ? null : BigInt(b.value);
    const ok = need !== null && have !== null && have >= need && need <= cap && estimate !== null && estimate <= maxFeeCap;
    checks.push({
      role: "facilitatorGas",
      address: addresses.facilitatorGas,
      network: n.network,
      kind: "native",
      asset: null,
      need: need === null ? "unknown (fee estimate failed)" : need.toString(),
      have: have === null ? null : have.toString(),
      ok,
      note:
        `${settles.toString()} settles x max gas per settle ${gasLimit.toString()} x estimated maxFeePerGas ${estimate === null ? "?" : estimate.toString()} wei; ` +
        `must be <= process gas cap ${cap.toString()} wei and the estimate <= maxFeePerGas cap ${maxFeeCap.toString()} wei ` +
        `(worst case at the fee cap: ${(settles * gasLimit * maxFeeCap).toString()} wei)`,
    });
  }
  return {
    kind: PLAN_KIND,
    version: PLAN_VERSION,
    createdAt: now().toISOString(),
    chains: [...chains],
    addresses,
    addressSources: sources,
    networks,
    purchases,
    totals,
    balances,
    checks,
    allSufficient: checks.every((c) => c.ok),
  };
}

function units(amount: string, decimals: number): string {
  const v = BigInt(amount);
  const scale = 10n ** BigInt(decimals);
  const frac = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${(v / scale).toString()}${frac === "" ? "" : `.${frac}`}`;
}
function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** 人が読む表（plan の .txt）。 */
export function planText(plan: Plan, sha: string): string {
  const lines: string[] = [];
  lines.push(`EVM testnets E2E plan (design §3.8/§3.9) — created ${plan.createdAt}`);
  lines.push(`plan sha256 (canonical JSON): ${sha}`);
  lines.push("Nothing is signed by `plan`. `run` refuses unless --plan-sha256 equals this hash.");
  lines.push("");
  lines.push("Addresses:");
  for (const [role, address] of Object.entries(plan.addresses)) lines.push(`  ${role.padEnd(15)} ${address}  (${plan.addressSources[role] ?? ""})`);
  lines.push("");
  lines.push("Purchases (one at a time, in this order; outbound on C starts only after the inbound on C was delivered and its source tx is final):");
  lines.push("  #  routeId                          leg   network                  pays → receives                         amount (base units / decimals)  facilitator  gas payer / per-settle gas limit / maxFeePerGas cap / process gas cap");
  for (const p of plan.purchases) {
    for (const [name, l] of [["src", p.source], ["dst", p.destination]] as const) {
      const gas = l.gasPayer === null ? "x402.org facilitator (its own key)" : `${short(l.gasPayer)} / ${l.gasLimitPerSettle ?? ""} / ${l.maxFeePerGasCapWei ?? ""} wei / ${l.processGasCapWei ?? ""} wei`;
      lines.push(
        `  ${String(p.index).padEnd(2)} ${(name === "src" ? p.routeId : "").padEnd(32)} ${name}   ${`${l.networkLabel}`.padEnd(24)} ${`${l.fromRole} ${short(l.from)} → ${l.toRole} ${short(l.to)}`.padEnd(40)} ${`${l.amount} / ${String(l.decimals)} (${units(l.amount, l.decimals)} ${l.assetSymbol})`.padEnd(31)} ${l.facilitator.padEnd(12)} ${gas}`,
      );
    }
    lines.push(`     upstream: ${p.upstream}`);
  }
  lines.push("");
  lines.push("Totals per payer and asset:");
  for (const t of plan.totals) lines.push(`  ${t.role.padEnd(15)} ${short(t.address)}  ${(NETWORK_LABEL[t.network] ?? t.network).padEnd(24)} ${t.assetSymbol} ${t.asset}  ${t.amount} base units (${units(t.amount, t.decimals)})`);
  lines.push("");
  lines.push("Balances (read-only RPC):");
  for (const b of plan.balances) {
    const label = NETWORK_LABEL[b.network] ?? b.network;
    const unit = b.kind === "native" ? (NATIVE_SYMBOL[b.network] ?? "native") : (ASSET_SYMBOL[b.network] ?? "token");
    const value = b.value === null ? `ERROR (${b.error ?? "unknown"})` : b.kind === "native" ? `${units(b.value, 18)} ${unit}` : `${units(b.value, 6)} ${unit}`;
    lines.push(`  ${b.role.padEnd(15)} ${short(b.address)}  ${label.padEnd(24)} ${b.kind.padEnd(6)} ${value}`);
  }
  lines.push("");
  lines.push("Checks:");
  for (const c of plan.checks) {
    lines.push(`  [${c.ok ? "ok" : "SHORT"}] ${c.role.padEnd(15)} ${(NETWORK_LABEL[c.network] ?? c.network).padEnd(24)} ${c.kind.padEnd(6)} need ${c.need} have ${c.have ?? "?"} — ${c.note}`);
  }
  lines.push("");
  lines.push(`All payers sufficient: ${plan.allSufficient ? "yes" : "NO"}`);
  return `${lines.join("\n")}\n`;
}

/** plan を読み、canonical sha256 が一致するときだけ返す。 */
export function loadApprovedPlan(file: string, expectedSha: string): Plan {
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new PlanRefusal("--plan-sha256 must be 64 lowercase hex characters");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PlanRefusal("the plan file is not readable JSON");
  }
  const actual = planSha256(parsed);
  if (actual !== expectedSha) throw new PlanRefusal(`the plan's canonical sha256 is ${actual}, not the approved ${expectedSha}; refusing`);
  const plan = parsed as Plan;
  if (plan.kind !== PLAN_KIND || plan.version !== PLAN_VERSION || !Array.isArray(plan.purchases)) throw new PlanRefusal("not an EVM testnets e2e plan of a known version");
  return plan;
}

export class PlanRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanRefusal";
  }
}

/* ────────────────────────────────────────────────────────────────────────────── MCP（注入できる） */

export interface McpCaller {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Streamable HTTP の MCP client。期限 195 秒、SSE の再接続はしない（隠れた再試行を作らない）。 */
export async function connectMcp(url: string, bearer: string | undefined): Promise<McpCaller> {
  const parsed = new URL(url);
  if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1"))) throw new Error("--mcp-url must be https or http://127.0.0.1");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "evm-testnets-e2e", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(parsed, {
    ...(bearer === undefined ? {} : { requestInit: { headers: { authorization: `Bearer ${bearer}` } } }),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
  });
  await client.connect(transport as never);
  return {
    async call(name, args) {
      const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: MCP_CALL_TIMEOUT_MS })) as { structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] };
      if (r.structuredContent !== undefined) return r.structuredContent;
      const text = r.content?.find((c) => c.type === "text")?.text;
      return text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>);
    },
    async close() {
      await client.close();
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────── 署名（`npm run sign` と同じ `runSign`） */

export type SignResult = { readonly ok: true; readonly credential: string; readonly chainId: number } | { readonly ok: false; readonly reason: string };
export type Signer = (quote: unknown, expectedPayer: string) => Promise<SignResult>;

/** `runSign` に x402 の EVM の payer だけを渡す（MPP・Solana は拒む: この driver の経路は全部 x402 の EIP-3009 で、署名で資金は動かない）。 */
export function runSignSigner(env: Env, nowMs: () => number = Date.now): Signer {
  return async (quote, expectedPayer) => {
    const key = env["SUBETHA_PAYER_PRIVATE_KEY"];
    if (key === undefined || key === "") return { ok: false, reason: "SUBETHA_PAYER_PRIVATE_KEY is not set" };
    const { createX402Payer } = await import("./x402-payer.js");
    const refuse = (): never => {
      throw new Error("only x402 EVM offers are signed by this driver");
    };
    try {
      const outcome = await runSign(quote, {
        nowMs,
        readEvmKey: () => key,
        readSolanaKey: refuse,
        mppPayer: refuse,
        evmPayer: (k) => {
          const payer = createX402Payer(k);
          if (payer.address.toLowerCase() !== expectedPayer.toLowerCase()) throw new Error("the payer key does not belong to the plan's payer address");
          return payer;
        },
        svmPayer: async () => refuse(),
        svmMppPayer: async () => refuse(),
        stderr: () => {},
      });
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      if (outcome.dispatch.kind !== "x402-evm") return { ok: false, reason: "the offer is not an x402 EVM offer" };
      return { ok: true, credential: outcome.stdout.trim(), chainId: outcome.dispatch.chainId };
    } catch (error) {
      // 例外の文言に鍵は入らない（x402-payer・runSign の固定文）。念のため固定文に寄せる。
      const message = error instanceof Error && /payer key does not belong|only x402 EVM/.test(error.message) ? error.message : "signing failed";
      return { ok: false, reason: message };
    }
  };
}

/* ────────────────────────────────────────────────────────────────────────────── 照合 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const lower = (v: unknown): string => (typeof v === "string" ? v.toLowerCase() : "");

/** quote の応答（subject と quote 文書）を plan と照合する。不一致の一覧（空なら一致）。**署名の前に** 呼ぶ。 */
export function subjectMismatches(response: Record<string, unknown>, planned: PlanPurchase, nowMs: number): string[] {
  const problems: string[] = [];
  const subject = response["subject"];
  const quote = response["quote"];
  if (response["ok"] !== true || !isRecord(subject) || !isRecord(quote)) return ["the quote did not succeed or has no subject/quote"];
  const expect = (label: string, actual: unknown, expected: unknown, caseInsensitive = false): void => {
    const same = caseInsensitive ? lower(actual) === lower(expected) && lower(expected) !== "" : actual === expected;
    if (!same) problems.push(`${label}: got ${JSON.stringify(actual)}, plan ${JSON.stringify(expected)}`);
  };
  expect("subject.routeId", subject["routeId"], planned.routeId);
  expect("quote.routeId", quote["routeId"], planned.routeId);
  expect("quote.quoteId = subject.quoteId", quote["quoteId"], subject["quoteId"]);
  if (typeof subject["quoteId"] !== "string" || subject["quoteId"] === "") problems.push("subject.quoteId is missing");
  if (typeof subject["paymentId"] !== "string" || subject["paymentId"] === "") problems.push("subject.paymentId is missing");
  if (quote["upstream"] !== undefined || quote["ownerKey"] !== undefined) problems.push("the quote is dynamic (upstream/ownerKey present); the plan is for static routes");
  const s = isRecord(subject["source"]) ? subject["source"] : {};
  const offer = isRecord(s["offer"]) ? s["offer"] : {};
  const qs = isRecord(quote["source"]) ? quote["source"] : {};
  expect("subject.source.network", s["network"], planned.source.network);
  expect("subject.source.asset", s["asset"], planned.source.asset, true);
  expect("subject.source.amount", s["amount"], planned.source.amount);
  expect("subject.source.decimals", s["decimals"], planned.source.decimals);
  expect("quote.source.network", qs["network"], planned.source.network);
  expect("quote.source.asset", qs["asset"], planned.source.asset, true);
  expect("quote.source.amount", qs["amount"], planned.source.amount);
  // 署名するのは **quote 文書の** offer（`runSign` は `quote.source.offer` を読む。I-1 #1）。subject の offer と canonical に同一であること、そのうえで
  // 署名される側の欄を全部 plan と表に照らす（subject 側も同じ値になる）。
  const signedOffer = isRecord(qs["offer"]) ? qs["offer"] : undefined;
  if (signedOffer === undefined) problems.push("quote.source.offer (the offer that would be signed) is missing");
  else if (stableJson(signedOffer) !== stableJson(offer)) problems.push("quote.source.offer (the offer that would be signed) differs from subject.source.offer (the offer shown for approval)");
  for (const [label, o] of [["subject offer", offer], ["signed offer", signedOffer ?? {}]] as const) {
    expect(`${label}.scheme`, o["scheme"], "exact");
    expect(`${label}.network`, o["network"], planned.source.network);
    expect(`${label}.asset`, o["asset"], planned.source.asset, true);
    expect(`${label}.amount`, o["amount"], planned.source.amount);
    expect(`${label}.payTo (Router receiver)`, o["payTo"], planned.source.to, true);
    const extra = isRecord(o["extra"]) ? o["extra"] : {};
    expect(`${label}.extra.fundsMoveOnCredential`, extra["fundsMoveOnCredential"], false);
    expect(`${label}.extra.challengeNonce = quoteId`, extra["challengeNonce"], subject["quoteId"]);
    const known = knownAssetOf(knownNetworkOf(KNOWN_NETWORKS, planned.source.network) ?? { network: "", family: "evm", inbound: [], outbound: [], assets: [] }, planned.source.asset);
    if (known?.domain === undefined) problems.push(`${label}: the table has no EIP-712 domain for the planned asset`);
    else {
      expect(`${label}.extra.name (table domain)`, extra["name"], known.domain.name);
      expect(`${label}.extra.version (table domain)`, extra["version"], known.domain.version);
    }
  }
  expect("subject.fundsMoveOnCredential", subject["fundsMoveOnCredential"], false);
  const d = isRecord(subject["destination"]) ? subject["destination"] : {};
  const qd = isRecord(quote["destination"]) ? quote["destination"] : {};
  expect("subject.destination.network", d["network"], planned.destination.network);
  expect("subject.destination.asset", d["asset"], planned.destination.asset, true);
  expect("subject.destination.quoted", d["quoted"], planned.destination.amount);
  expect("quote.destination.network", qd["network"], planned.destination.network);
  expect("quote.destination.asset", qd["asset"], planned.destination.asset, true);
  expect("quote.destination.quoted", qd["quoted"], planned.destination.amount);
  expect("quote.destination.payTo (upstream recipient)", qd["payTo"], planned.destination.to, true);
  const approval = isRecord(subject["approval"]) ? subject["approval"] : {};
  const deadline = approval["deadlineMs"];
  if (typeof deadline !== "number" || deadline <= nowMs) problems.push("the quote's approval deadline has passed or is missing");
  return problems;
}

/** receipt の `Transfer` のうち token の contract が `asset` のものを読む。 */
export function transfersOf(receipt: ReceiptInfo, asset: string): { from: string; to: string; value: bigint; logIndex: number }[] {
  const out: { from: string; to: string; value: bigint; logIndex: number }[] = [];
  receipt.logs.forEach((log, logIndex) => {
    if (log.address.toLowerCase() !== asset.toLowerCase()) return;
    if ((log.topics[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) return;
    const fromTopic = log.topics[1];
    const toTopic = log.topics[2];
    if (fromTopic === undefined || toTopic === undefined) return;
    out.push({ from: `0x${fromTopic.slice(-40)}`, to: `0x${toTopic.slice(-40)}`, value: BigInt(log.data === "0x" ? "0" : log.data), logIndex });
  });
  return out;
}

export interface LegEvidence {
  readonly leg: "source" | "destination";
  readonly network: string;
  readonly txHash: string | null;
  readonly receiptStatus: string | null;
  readonly blockNumber: string | null;
  readonly blockHash: string | null;
  readonly token: string;
  readonly transfer: { from: string; to: string; value: string; logIndex: number } | null;
  readonly expected: { from: string; to: string; value: string };
  readonly ok: boolean;
  readonly problem?: string;
}

async function receiptWithin(reader: ChainReader, network: string, hash: string, waitMs: number, sleep: (ms: number) => Promise<void>): Promise<ReceiptInfo | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await reader.receipt(network, hash);
    if (r !== undefined || Date.now() >= deadline) return r;
    await sleep(3_000);
  }
}

/** 1 レグの chain の読み取りと照合（token の contract・from・to・value が quote と一致する `Transfer` がちょうど 1 つ、receipt が成功）。 */
/**
 * 封をされる前の receipt の block hash（ゼロ）。Base Sepolia の公開 RPC は送出の直後に block が封をされる前の receipt（flashblocks の先行の receipt）を
 * block hash ゼロで返すことがある（E-7 で実測、2026-10-13）。記録の hash がゼロなら、確定の判定で「記録と違う（reorg?）」と比べない
 * （tx の receipt・block 番号・`finalized` で判定する）。
 */
export function isUnsealedBlockHash(hash: string): boolean {
  return /^0x0{64}$/i.test(hash);
}

export async function verifyLeg(reader: ChainReader, leg: "source" | "destination", planned: PlanLeg, txHash: unknown, opts: { waitMs: number; sleep: (ms: number) => Promise<void> }): Promise<LegEvidence> {
  const expected = { from: planned.from, to: planned.to, value: planned.amount };
  const base = { leg, network: planned.network, token: planned.asset, expected };
  if (typeof txHash !== "string" || !HASH.test(txHash)) return { ...base, txHash: typeof txHash === "string" ? txHash : null, receiptStatus: null, blockNumber: null, blockHash: null, transfer: null, ok: false, problem: "no transaction hash recorded for this leg" };
  let receipt: ReceiptInfo | undefined;
  try {
    receipt = await receiptWithin(reader, planned.network, txHash, opts.waitMs, opts.sleep);
  } catch {
    return { ...base, txHash, receiptStatus: null, blockNumber: null, blockHash: null, transfer: null, ok: false, problem: "receipt read failed (RPC)" };
  }
  if (receipt === undefined) return { ...base, txHash, receiptStatus: null, blockNumber: null, blockHash: null, transfer: null, ok: false, problem: "no receipt found" };
  const transfers = transfersOf(receipt, planned.asset);
  const matching = transfers.filter((t) => t.from.toLowerCase() === planned.from.toLowerCase() && t.to.toLowerCase() === planned.to.toLowerCase() && t.value === BigInt(planned.amount));
  const shown = matching[0] ?? transfers[0];
  const common = { ...base, txHash, receiptStatus: receipt.status, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, transfer: shown === undefined ? null : { from: shown.from, to: shown.to, value: shown.value.toString(), logIndex: shown.logIndex } };
  if (receipt.status !== "success") return { ...common, ok: false, problem: "receipt status is not success" };
  if (matching.length !== 1) return { ...common, ok: false, problem: transfers.length === 0 ? "no Transfer of the planned token in the receipt" : `Transfer differs from the quote (found ${String(transfers.length)} Transfer(s), ${String(matching.length)} matching from/to/value)` };
  return { ...common, ok: true };
}

/* ────────────────────────────────────────────────────────────────────────────── 確定 */

export interface FinalityResult {
  readonly at: string;
  readonly leg: string;
  readonly network: string;
  readonly txHash: string;
  readonly rule: "finalized_tag" | "receipt";
  readonly final: boolean;
  readonly txBlock: string | null;
  readonly finalizedBlock: string | null;
  readonly note: string;
}

/** 1 tx の確定（設計 §3.9）。block hash が記録と違えば（reorg）final にしない。 */
export async function finalityOf(reader: ChainReader, network: string, txHash: string, recordedBlockHash: string | null, leg: string, now: () => Date = () => new Date()): Promise<FinalityResult> {
  const rule = finalityRuleOf(network);
  const base = { at: now().toISOString(), leg, network, txHash, rule };
  let receipt: ReceiptInfo | undefined;
  try {
    receipt = await reader.receipt(network, txHash);
  } catch {
    return { ...base, final: false, txBlock: null, finalizedBlock: null, note: "receipt read failed (RPC); pending" };
  }
  if (receipt === undefined) return { ...base, final: false, txBlock: null, finalizedBlock: null, note: "no receipt (pending or dropped)" };
  if (receipt.status !== "success") return { ...base, final: false, txBlock: receipt.blockNumber.toString(), finalizedBlock: null, note: "receipt status is not success" };
  if (recordedBlockHash !== null && !isUnsealedBlockHash(recordedBlockHash) && receipt.blockHash.toLowerCase() !== recordedBlockHash.toLowerCase()) return { ...base, final: false, txBlock: receipt.blockNumber.toString(), finalizedBlock: null, note: "block hash differs from the recorded one (reorg?)" };
  if (rule === "receipt") return { ...base, final: true, txBlock: receipt.blockNumber.toString(), finalizedBlock: null, note: "single-slot finality: receipt present (HyperEVM)" };
  const finalized = await reader.finalizedBlock(network);
  if (finalized === undefined) return { ...base, final: false, txBlock: receipt.blockNumber.toString(), finalizedBlock: null, note: "finalized block not readable; pending" };
  const final = receipt.blockNumber <= finalized;
  return { ...base, final, txBlock: receipt.blockNumber.toString(), finalizedBlock: finalized.toString(), note: final ? "tx block <= finalized block" : "tx block > finalized block; pending" };
}

/* ────────────────────────────────────────────────────────────────────────────── 証跡 */

export interface PurchaseEvidence {
  readonly kind: "subetha-evm-testnets-e2e-purchase";
  readonly planSha256: string;
  readonly runId: string;
  readonly index: number;
  readonly chain: EvmTestnetChain;
  readonly direction: Direction;
  readonly routeId: string;
  stage: "started" | "quote_failed" | "stopped_before_signing" | "sign_refused" | "purchase_call_failed" | "purchased" | "verified" | "verification_failed";
  stopReason?: string;
  startedAt: string;
  finishedAt?: string;
  requestId?: string;
  prerequisite?: unknown;
  quoteResponse?: unknown;
  subject?: unknown;
  quoteDestination?: unknown;
  mismatches?: string[];
  paymentId?: string;
  purchase?: unknown;
  outcome?: string;
  status?: unknown;
  body?: { sha256: string; head: string; routerRecordSha256: string | null; matches: boolean };
  legs?: LegEvidence[];
  balancesBefore?: PlanBalance[];
  balancesAfter?: PlanBalance[];
  journal?: { router: unknown[] | string; facilitatorJournal: unknown[] | string; facilitatorLog: unknown[] | string };
  finality?: FinalityResult[];
  reopen?: unknown[];
  timingsMs?: Record<string, number>;
}

/** body の sha256（canonical JSON）と先頭。 */
export function bodyDigest(body: unknown): { sha256: string; head: string } {
  const text = typeof body === "string" ? body : stableJson(body);
  return { sha256: sha256Hex(text), head: text.slice(0, BODY_HEAD_CHARS) };
}

/** 結果の形から body を抜いて digest に置き換える（証跡は先頭 200 字と hash だけ）。 */
function withoutBody(value: unknown, field: string): unknown {
  if (!isRecord(value) || !(field in value)) return value;
  const { [field]: body, ...rest } = value;
  return { ...rest, [`${field}Digest`]: bodyDigest(body) };
}

/** quote の応答から証跡に残す部分（`ownerKey`・`quote` 文書全体は除く。subject と destination だけ）。 */
function quoteRecordOf(response: Record<string, unknown>): { response: unknown; subject: unknown; destination: unknown } {
  const { quote, ...rest } = response;
  const destination = isRecord(quote) ? quote["destination"] : undefined;
  return { response: { ...rest, subject: undefined }, subject: response["subject"], destination };
}

function readLines(file: string | undefined, match: (record: Record<string, unknown>) => boolean): unknown[] | string {
  if (file === undefined) return "not provided";
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "not readable";
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line) as unknown;
      if (isRecord(record) && match(record)) out.push(record);
    } catch {
      // 壊れた行は飛ばす（証跡は読み取りだけ）。
    }
  }
  return out;
}

/** Router の journal の該当行（paymentId）、facilitator の journal・log の該当行（tx hash、その key）。 */
export function journalLinesOf(paymentId: string, txHashes: readonly string[], files: { router?: string | undefined; facilitatorJournal?: string | undefined; facilitatorLog?: string | undefined }): { router: unknown[] | string; facilitatorJournal: unknown[] | string; facilitatorLog: unknown[] | string } {
  const hashes = new Set(txHashes.map((h) => h.toLowerCase()));
  const router = readLines(files.router, (r) => r["paymentId"] === paymentId);
  const keys = new Set<string>();
  const hashed = readLines(files.facilitatorJournal, (r) => typeof r["hash"] === "string" && hashes.has(r["hash"].toLowerCase()));
  if (Array.isArray(hashed)) for (const r of hashed) if (isRecord(r) && typeof r["key"] === "string") keys.add(r["key"]);
  const facilitatorJournal = readLines(files.facilitatorJournal, (r) => typeof r["key"] === "string" && keys.has(r["key"]));
  const facilitatorLog = readLines(files.facilitatorLog, (r) => (typeof r["transaction"] === "string" && hashes.has(r["transaction"].toLowerCase())) || (typeof r["key"] === "string" && keys.has(r["key"])));
  return { router, facilitatorJournal, facilitatorLog };
}

function evidenceFilesOf(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || !existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".json") && path.basename(path.dirname(full)) === "purchases") out.push(full);
    }
  };
  walk(root, 0);
  return out.sort();
}

function readEvidence(file: string): PurchaseEvidence | undefined {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as PurchaseEvidence;
    return value.kind === "subetha-evm-testnets-e2e-purchase" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 全証跡を読む。読めない・形の違うファイルは `unreadable` に（黙って飛ばさない。I-1 #2）。 */
function readAllEvidence(root: string): { evidence: PurchaseEvidence[]; unreadable: string[] } {
  const evidence: PurchaseEvidence[] = [];
  const unreadable: string[] = [];
  for (const file of evidenceFilesOf(root)) {
    const value = readEvidence(file);
    if (value === undefined) unreadable.push(file);
    else evidence.push(value);
  }
  return { evidence, unreadable };
}

/* ────────────────────────────────────────────────────────────────────────────── run */

export interface RunOptions {
  readonly plan: Plan;
  readonly planSha256: string;
  readonly evidenceDir: string;
  readonly only?: string | undefined;
  readonly routerJournal?: string | undefined;
  readonly facilitatorJournal?: string | undefined;
  readonly facilitatorLog?: string | undefined;
  /** 送信の前に要る受信の source tx の状態: `finalized`（既定。設計 §3.8 の「確定」）か `receipt`（成功の receipt と一致する Transfer）。 */
  readonly inboundConfirmation?: "finalized" | "receipt";
  /** `finalized` を待つ上限（秒。既定 1500。越えたら送信を始めずに止まる）。 */
  readonly waitFinalizedSeconds?: number;
}
export interface RunDeps {
  readonly mcp: McpCaller;
  readonly chain: ChainReader;
  readonly sign: Signer;
  readonly secrets: Secrets;
  readonly out: (line: string) => void;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** receipt を待つ上限（ms。既定 60 秒）。 */
  readonly receiptWaitMs?: number;
  readonly requestIdOf?: (routeId: string) => string;
}
export interface RunReport {
  readonly runDir: string;
  readonly completed: readonly string[];
  readonly stopped?: { readonly routeId: string; readonly stage: string; readonly reason: string; readonly paymentId?: string | undefined; readonly status?: unknown };
}

function compactUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "");
}

async function balancesFor(reader: ChainReader, planned: PlanPurchase, plan: Plan): Promise<PlanBalance[]> {
  const out: PlanBalance[] = [];
  const read = async (role: string, address: string, network: string, asset: string | null): Promise<void> => {
    try {
      const value = asset === null ? await reader.nativeBalance(network, address) : await reader.tokenBalance(network, asset, address);
      out.push({ role, address, network, kind: asset === null ? "native" : "token", asset, value: value.toString() });
    } catch {
      out.push({ role, address, network, kind: asset === null ? "native" : "token", asset, value: null, error: "rpc_read_failed" });
    }
  };
  const s = planned.source;
  const d = planned.destination;
  await read("payer", s.from, s.network, s.asset);
  await read("routerReceiver", s.to, s.network, s.asset);
  await read("routerOutbound", d.from, d.network, d.asset);
  await read(d.toRole, d.to, d.network, d.asset);
  const evmNetwork = EVM_TESTNETS[planned.chain].network;
  await read("facilitatorGas", plan.addresses.facilitatorGas, evmNetwork, null);
  return out;
}

/** 送信の前提（設計 §3.8）: 同じ chain の受信が `delivered`・source tx が確定、かつ送信の試み（全 run）の数 < delivered の受信の数（1 つの受信の入金は 1 回の送信だけに数える）。 */
async function outboundPrerequisite(planned: PlanPurchase, opts: RunOptions, deps: RunDeps): Promise<{ ok: true; detail: unknown } | { ok: false; reason: string }> {
  const inboundRoute = evmInboundRouteOf(planned.chain);
  const { evidence: all, unreadable } = readAllEvidence(opts.evidenceDir);
  if (unreadable.length > 0) return { ok: false, reason: `held: unreadable evidence ${unreadable.join(", ")}` };
  const markers = attemptMarkersForRoute(opts.evidenceDir, planned.routeId);
  if (markers.some((m) => m.state === "corrupt")) return { ok: false, reason: `held: unreadable attempt marker for ${planned.routeId}` };
  const deliveredInbound = all.filter((e) => e.routeId === inboundRoute && e.stage === "verified" && e.outcome === "delivered");
  // 送信の試み: 印（不変）と、印の無い古い証跡の和。
  const markedPlans = new Set(markers.map((m) => m.planSha));
  const outboundAttempts = [...markers, ...all.filter((e) => e.routeId === planned.routeId && !markedPlans.has(e.planSha256))];
  if (deliveredInbound.length === 0) return { ok: false, reason: `no delivered and verified inbound ${inboundRoute} in ${opts.evidenceDir}` };
  if (outboundAttempts.length >= deliveredInbound.length) return { ok: false, reason: `${String(outboundAttempts.length)} outbound attempt(s) already use the ${String(deliveredInbound.length)} delivered inbound purchase(s) on ${planned.chain}` };
  const inbound = deliveredInbound[deliveredInbound.length - 1] as PurchaseEvidence;
  const sourceLeg = inbound.legs?.find((l) => l.leg === "source");
  if (sourceLeg === undefined || !sourceLeg.ok || sourceLeg.txHash === null) return { ok: false, reason: "the inbound's source leg is not verified" };
  const mode = opts.inboundConfirmation ?? "finalized";
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  if (mode === "receipt") {
    const again = await verifyLeg(deps.chain, "source", { ...planned.source, network: sourceLeg.network, asset: sourceLeg.token, from: sourceLeg.expected.from, to: sourceLeg.expected.to, amount: sourceLeg.expected.value }, sourceLeg.txHash, { waitMs: 0, sleep });
    if (!again.ok || (sourceLeg.blockHash !== null && !isUnsealedBlockHash(sourceLeg.blockHash) && again.blockHash?.toLowerCase() !== sourceLeg.blockHash.toLowerCase())) return { ok: false, reason: `the inbound source tx is not confirmed again (${again.problem ?? "block hash changed"})` };
    return { ok: true, detail: { inboundPaymentId: inbound.paymentId, mode, sourceTx: sourceLeg.txHash, block: again.blockNumber } };
  }
  const deadline = now().getTime() + (opts.waitFinalizedSeconds ?? 1_500) * 1000;
  for (;;) {
    const result = await finalityOf(deps.chain, sourceLeg.network, sourceLeg.txHash, sourceLeg.blockHash, "inbound source (prerequisite)", now);
    if (result.final) return { ok: true, detail: { inboundPaymentId: inbound.paymentId, mode, finality: result } };
    if (result.note.includes("reorg") || result.note.includes("not success")) return { ok: false, reason: `the inbound source tx is not final: ${result.note}` };
    if (now().getTime() >= deadline) return { ok: false, reason: `the inbound source tx was not final within the wait (${result.note})` };
    deps.out(`  waiting for the inbound source tx on ${planned.chain} to be final (${result.note})`);
    await sleep(20_000);
  }
}

/**
 * 計画の購入を 1 つずつ実行する（設計 §3.9）。最初の `delivered` でない結果・不一致・証跡の不足で全体を止める。再試行しない。
 * 同じ plan で既に試みた route は始めない（証跡のファイルが残っていれば、結果によらず）。
 */
export async function runPurchases(opts: RunOptions, deps: RunDeps): Promise<RunReport> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const out = (line: string): void => deps.out(deps.secrets.redact(line));
  const selected = opts.only === undefined ? [...opts.plan.purchases] : opts.plan.purchases.filter((p) => p.routeId === opts.only);
  if (opts.only !== undefined && selected.length !== 1) throw new PlanRefusal(`--only ${opts.only} does not select exactly one planned purchase`);
  const runId = `run-${compactUtc(now())}`;
  const runDir = path.join(opts.evidenceDir, runId);
  const completed: string[] = [];
  const report = (stopped?: RunReport["stopped"]): RunReport => {
    const result: RunReport = { runDir, completed, ...(stopped === undefined ? {} : { stopped }) };
    writePrivate(path.join(runDir, "run.json"), { planSha256: opts.planSha256, only: opts.only ?? null, at: now().toISOString(), ...result }, deps.secrets);
    return result;
  };
  out(`run ${runId}: ${String(selected.length)} purchase(s), plan ${opts.planSha256}`);

  for (const planned of selected) {
    // 読めない証跡・印があれば保留（黙って飛ばすと、落ちた後の購入をもう一度始め得る。I-1 #2）。
    const scanned = readAllEvidence(opts.evidenceDir);
    if (scanned.unreadable.length > 0) {
      out(`HELD ${planned.routeId}: unreadable evidence file(s) ${scanned.unreadable.join(", ")}; an operator must inspect them before any purchase`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: "held: unreadable evidence" });
    }
    // 同じ plan で既に試みた route は始めない（再試行は新しい plan = owner の新しい承認）。印が権威（証跡が消えても残る）。
    const marker = attemptMarkerStateOf(opts.evidenceDir, opts.planSha256, planned.routeId);
    if (marker === "corrupt") {
      out(`HELD ${planned.routeId}: the attempt marker is unreadable (${attemptMarkerPathOf(opts.evidenceDir, opts.planSha256, planned.routeId)}); treated as attempted, an operator must inspect it`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: "held: unreadable attempt marker" });
    }
    if (marker === "present") {
      out(`STOP ${planned.routeId}: already attempted under this plan (attempt marker present); a new attempt needs a new plan and approval`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: "already attempted under this plan" });
    }
    const earlier = scanned.evidence.find((e) => e.planSha256 === opts.planSha256 && e.routeId === planned.routeId);
    if (earlier !== undefined) {
      out(`STOP ${planned.routeId}: already attempted under this plan (${earlier.runId}, stage ${earlier.stage}); a new attempt needs a new plan and approval`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: "already attempted under this plan" });
    }
    let prerequisite: unknown;
    if (planned.direction === "outbound") {
      const pre = await outboundPrerequisite(planned, opts, deps);
      if (!pre.ok) {
        out(`STOP ${planned.routeId}: outbound prerequisite not met: ${pre.reason}`);
        return report({ routeId: planned.routeId, stage: "not_started", reason: pre.reason });
      }
      prerequisite = pre.detail;
    }
    const file = path.join(runDir, "purchases", `${planned.routeId}.json`);
    const evidence: PurchaseEvidence = {
      kind: "subetha-evm-testnets-e2e-purchase",
      planSha256: opts.planSha256,
      runId,
      index: planned.index,
      chain: planned.chain,
      direction: planned.direction,
      routeId: planned.routeId,
      stage: "started",
      startedAt: now().toISOString(),
      ...(prerequisite === undefined ? {} : { prerequisite }),
      timingsMs: {},
    };
    const save = (): void => writePrivate(file, evidence, deps.secrets);
    const stop = (stage: PurchaseEvidence["stage"], reason: string): RunReport => {
      evidence.stage = stage;
      evidence.stopReason = reason;
      evidence.finishedAt = now().toISOString();
      save();
      out(`STOP ${planned.routeId}: ${reason}${evidence.paymentId === undefined ? "" : ` (paymentId ${evidence.paymentId}, status ${JSON.stringify(isRecord(evidence.status) && isRecord(evidence.status["projection"]) ? evidence.status["projection"]["status"] : (evidence.outcome ?? null))})`}`);
      return report({ routeId: planned.routeId, stage, reason, paymentId: evidence.paymentId, status: evidence.status });
    };
    // 試みの印を **不変に** 先に書く（O_EXCL・fsync。署名・quote の前。途中で落ちても同じ plan で再び始めない）。作れなければ始めない。
    let created: boolean;
    try {
      created = createAttemptMarker(opts.evidenceDir, opts.planSha256, planned.routeId, { runId, at: now().toISOString() });
    } catch {
      out(`HELD ${planned.routeId}: could not persist the attempt marker; not starting`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: "held: attempt marker not persisted" });
    }
    if (!created) {
      out(`STOP ${planned.routeId}: already attempted under this plan (attempt marker present); a new attempt needs a new plan and approval`);
      return report({ routeId: planned.routeId, stage: "not_started", reason: "already attempted under this plan" });
    }
    save();
    evidence.balancesBefore = await balancesFor(deps.chain, planned, opts.plan);
    save();

    // 1) quote（新しい requestId）。
    const requestId = deps.requestIdOf?.(planned.routeId) ?? `e2e-${planned.routeId}-${compactUtc(now())}-${randomBytes(3).toString("hex")}`;
    evidence.requestId = requestId;
    out(`#${String(planned.index)} ${planned.routeId}: quote (requestId ${requestId})`);
    let quoted: Record<string, unknown>;
    const t0 = Date.now();
    try {
      quoted = await deps.mcp.call("subetha_router_quote", { routeId: planned.routeId, requestId });
    } catch {
      return stop("quote_failed", "the quote call failed (no payment started)");
    }
    (evidence.timingsMs as Record<string, number>)["quote"] = Date.now() - t0;
    const q = quoteRecordOf(quoted);
    evidence.quoteResponse = q.response;
    evidence.subject = q.subject;
    evidence.quoteDestination = q.destination;
    if (quoted["ok"] !== true) return stop("quote_failed", `quote failed: ${String(quoted["error"] ?? "unknown")}${quoted["reason"] === undefined ? "" : ` / ${String(quoted["reason"])}`} (no payment started)`);

    // 2) subject と plan の照合（署名の前）。照合した quote 文書を **複製して凍結** し、署名と purchase にはその同じ object だけを渡す（I-1 #1）。
    const quoteDoc = deepFreeze(structuredClone(quoted["quote"]));
    quoted = { ...quoted, quote: quoteDoc };
    const mismatches = subjectMismatches(quoted, planned, now().getTime());
    evidence.mismatches = mismatches;
    const subject = quoted["subject"] as Record<string, unknown>;
    evidence.paymentId = String(subject["paymentId"] ?? "");
    if (mismatches.length > 0) return stop("stopped_before_signing", `the quote differs from the plan: ${mismatches.join("; ")}`);

    // 3) 署名（`npm run sign` と同じ `runSign`。x402 の EIP-3009 は署名だけで資金は動かない）。
    const signed = await deps.sign(quoteDoc, planned.source.from);
    if (!signed.ok) return stop("sign_refused", `signing refused: ${signed.reason} (no payment started)`);
    deps.secrets.add(signed.credential);
    const expectedChainId = Number(planned.source.network.split(":")[1]);
    if (signed.chainId !== expectedChainId) return stop("sign_refused", `signed for chain ${String(signed.chainId)}, plan ${String(expectedChainId)} (credential discarded, no payment started)`);

    // 4) purchase（同じ requestId、approval = quoteId）。1 回だけ。
    const quoteId = String(subject["quoteId"]);
    out(`#${String(planned.index)} ${planned.routeId}: purchase (paymentId ${evidence.paymentId})`);
    const t1 = Date.now();
    let purchased: Record<string, unknown>;
    try {
      purchased = await deps.mcp.call("subetha_router_purchase", { quoteId, requestId, approval: quoteId, quote: quoteDoc, credential: signed.credential });
    } catch {
      evidence.outcome = "unknown";
      // 結果が分からない: status を 1 回読んで記録し、止まる（再試行しない）。
      try {
        evidence.status = withStatusDigest(await deps.mcp.call("subetha_router_status", { paymentId: evidence.paymentId }));
      } catch {
        evidence.status = "status call failed";
      }
      return stop("purchase_call_failed", "the purchase call failed or timed out; funds may have moved — not retried");
    }
    (evidence.timingsMs as Record<string, number>)["purchase"] = Date.now() - t1;
    evidence.purchase = withoutBody(purchased, "snapshot");
    evidence.outcome = typeof purchased["outcome"] === "string" ? purchased["outcome"] : "unknown";
    evidence.stage = "purchased";
    save();

    // 5) status（読むだけ）。
    let status: Record<string, unknown> | undefined;
    try {
      status = await deps.mcp.call("subetha_router_status", { paymentId: evidence.paymentId });
      evidence.status = withStatusDigest(status);
    } catch {
      evidence.status = "status call failed";
    }
    save();
    const projection = status !== undefined && isRecord(status["projection"]) ? status["projection"] : undefined;
    if (evidence.outcome !== "delivered" || projection?.["status"] !== "delivered") {
      return stop("purchased", `outcome ${evidence.outcome}, saved status ${JSON.stringify(projection?.["status"] ?? null)}; not delivered — stopping the run without retry`);
    }

    // 6) body の digest と Router の記録との一致。
    const clientDigest = bodyDigest(purchased["snapshot"]);
    const routerRecord = projection["result"];
    const routerSha = routerRecord === undefined ? null : bodyDigest(routerRecord).sha256;
    evidence.body = { sha256: clientDigest.sha256, head: clientDigest.head, routerRecordSha256: routerSha, matches: routerSha === clientDigest.sha256 };

    // 7) 2 レグの chain の読み取り（quote と一致する Transfer）。
    const src = isRecord(projection["source"]) ? projection["source"] : {};
    const dst = isRecord(projection["destination"]) ? projection["destination"] : {};
    const legOpts = { waitMs: deps.receiptWaitMs ?? 60_000, sleep };
    const sourceLeg = await verifyLeg(deps.chain, "source", planned.source, src["txRef"], legOpts);
    const destinationLeg = await verifyLeg(deps.chain, "destination", planned.destination, dst["txRef"], legOpts);
    evidence.legs = [sourceLeg, destinationLeg];
    evidence.journal = journalLinesOf(evidence.paymentId, [sourceLeg.txHash, destinationLeg.txHash].filter((h): h is string => h !== null), { router: opts.routerJournal, facilitatorJournal: opts.facilitatorJournal, facilitatorLog: opts.facilitatorLog });
    evidence.balancesAfter = await balancesFor(deps.chain, planned, opts.plan);
    const legProblems = evidence.legs.filter((l) => !l.ok).map((l) => `${l.leg}: ${l.problem ?? "not ok"}`);
    if (!evidence.body.matches) legProblems.push("the delivered body's sha256 differs from the Router's saved result");
    if (legProblems.length > 0) return stop("verification_failed", `delivered, but the evidence does not match: ${legProblems.join("; ")}`);
    evidence.stage = "verified";
    evidence.finishedAt = now().toISOString();
    save();
    completed.push(planned.routeId);
    out(`#${String(planned.index)} ${planned.routeId}: delivered; source ${sourceLeg.txHash ?? ""} (block ${sourceLeg.blockNumber ?? ""}), destination ${destinationLeg.txHash ?? ""} (block ${destinationLeg.blockNumber ?? ""})`);
  }
  out(`run ${runId}: all ${String(completed.length)} purchase(s) delivered and verified`);
  return report();
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

/** status の応答の `projection.result`（body）を digest に置き換える。 */
function withStatusDigest(status: Record<string, unknown>): unknown {
  if (!isRecord(status["projection"])) return status;
  return { ...status, projection: withoutBody(status["projection"], "result") };
}

/* ────────────────────────────────────────────────────────────────────────────── finality・reopen・summary */

export async function runFinality(evidenceDir: string, reader: ChainReader, secrets: Secrets, out: (line: string) => void, opts: { waitSeconds?: number; now?: () => Date; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ final: number; pending: number }> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now().getTime() + (opts.waitSeconds ?? 0) * 1000;
  for (;;) {
    let final = 0;
    let pending = 0;
    const pendingLines: string[] = [];
    for (const file of evidenceFilesOf(evidenceDir)) {
      const evidence = readEvidence(file);
      if (evidence === undefined) {
        // 黙って飛ばさない（I-1 #2）。確定を読めなかったものとして pending に数える。
        pending += 1;
        pendingLines.push(`  HELD: unreadable evidence ${file}`);
        continue;
      }
      if (evidence.legs === undefined) continue;
      const results: FinalityResult[] = [];
      for (const leg of evidence.legs) {
        if (leg.txHash === null || !HASH.test(leg.txHash)) continue;
        const result = await finalityOf(reader, leg.network, leg.txHash, leg.blockHash, leg.leg, now);
        results.push(result);
        if (result.final) final += 1;
        else {
          pending += 1;
          pendingLines.push(`  pending: ${evidence.routeId} ${leg.leg} ${leg.network} ${leg.txHash} — ${result.note}`);
        }
      }
      evidence.finality = [...(evidence.finality ?? []), ...results];
      writePrivate(file, evidence, secrets);
    }
    if (pending === 0 || now().getTime() >= deadline) {
      for (const line of pendingLines) out(secrets.redact(line));
      out(`finality: ${String(final)} final, ${String(pending)} pending`);
      return { final, pending };
    }
    await sleep(30_000);
  }
}

/** 保存した status の結果と読み直した結果の違い（status・両レグの txRef・指紋・終了理由・body の digest・更新時刻）。 */
export function reopenDiffs(saved: unknown, again: Record<string, unknown>): string[] {
  const a = isRecord(saved) && isRecord(saved["projection"]) ? saved["projection"] : undefined;
  const b0 = isRecord(again["projection"]) ? again["projection"] : undefined;
  if (a === undefined || b0 === undefined) return [a === undefined ? "no saved projection" : "no projection on reopen"];
  const b = ("result" in b0 ? withoutBody(b0, "result") : b0) as Record<string, unknown>;
  if (stableJson(a) === stableJson(b)) return [];
  const named = ["status", "routeId", "quoteFingerprint", "terminalReason", "updatedAt", "source", "destination", "resultDigest"].filter((k) => stableJson(a[k]) !== stableJson(b[k])).map((k) => `${k} differs`);
  return named.length > 0 ? named : ["other projection fields differ"];
}

export async function runReopen(evidenceDir: string, mcp: McpCaller, secrets: Secrets, out: (line: string) => void, now: () => Date = () => new Date()): Promise<{ same: number; different: number }> {
  let same = 0;
  let different = 0;
  for (const file of evidenceFilesOf(evidenceDir)) {
    const evidence = readEvidence(file);
    if (evidence === undefined) {
      different += 1;
      out(secrets.redact(`reopen HELD: unreadable evidence ${file}`));
      continue;
    }
    if (evidence.paymentId === undefined || evidence.paymentId === "") continue;
    let again: Record<string, unknown>;
    try {
      again = await mcp.call("subetha_router_status", { paymentId: evidence.paymentId });
    } catch {
      again = { found: false, error: "status call failed" };
    }
    // 保存した証跡は秘密を除いてある。同じ処理を通した形で比べる（body は digest で）。
    const againAsSaved = JSON.parse(secrets.redact(jsonText(withStatusDigest(again)))) as Record<string, unknown>;
    const diffs = reopenDiffs(evidence.status, againAsSaved);
    const entry = { at: now().toISOString(), same: diffs.length === 0, diffs, status: withStatusDigest(again) };
    evidence.reopen = [...(evidence.reopen ?? []), entry];
    writePrivate(file, evidence, secrets);
    if (diffs.length === 0) same += 1;
    else different += 1;
    out(secrets.redact(`reopen ${evidence.routeId} ${evidence.paymentId}: ${diffs.length === 0 ? "same" : `DIFFERENT (${diffs.join(", ")})`}`));
  }
  out(`reopen: ${String(same)} same, ${String(different)} different`);
  return { same, different };
}

/** 公開の要約（秘密・body・journal の行・offer を除く）。書く前に既知の秘密が残っていないことを確かめる。 */
export function summaryOf(evidenceDir: string): Record<string, unknown> {
  const { evidence: all, unreadable } = readAllEvidence(evidenceDir);
  if (unreadable.length > 0) throw new PlanRefusal(`held: unreadable evidence ${unreadable.join(", ")}; not writing a summary that would omit them`);
  const purchases = all
    .map((e) => {
      const subject = isRecord(e.subject) ? e.subject : {};
      const source = isRecord(subject["source"]) ? subject["source"] : {};
      const destination = isRecord(subject["destination"]) ? subject["destination"] : {};
      const qd = isRecord(e.quoteDestination) ? e.quoteDestination : {};
      const projection = isRecord(e.status) && isRecord(e.status["projection"]) ? e.status["projection"] : {};
      const lastFinality = new Map<string, FinalityResult>();
      for (const f of e.finality ?? []) lastFinality.set(`${f.leg}|${f.txHash}`, f);
      const lastReopen = e.reopen?.[e.reopen.length - 1];
      return {
        runId: e.runId,
        planSha256: e.planSha256,
        index: e.index,
        chain: e.chain,
        direction: e.direction,
        routeId: e.routeId,
        stage: e.stage,
        ...(e.stopReason === undefined ? {} : { stopReason: e.stopReason }),
        paymentId: e.paymentId ?? null,
        outcome: e.outcome ?? null,
        savedStatus: projection["status"] ?? null,
        terminalReason: projection["terminalReason"] ?? null,
        quote: {
          source: { network: source["network"], asset: source["asset"], amount: source["amount"], decimals: source["decimals"] },
          destination: { network: destination["network"], asset: destination["asset"], quoted: destination["quoted"], payTo: qd["payTo"] },
          fundsMoveOnCredential: subject["fundsMoveOnCredential"],
        },
        bodySha256: e.body?.sha256 ?? null,
        bodyMatchesRouterRecord: e.body?.matches ?? null,
        legs: (e.legs ?? []).map((l) => {
          const f = l.txHash === null ? undefined : lastFinality.get(`${l.leg}|${l.txHash}`);
          return {
            leg: l.leg,
            network: l.network,
            txHash: l.txHash,
            receiptStatus: l.receiptStatus,
            blockNumber: l.blockNumber,
            token: l.token,
            transfer: l.transfer,
            matchesQuote: l.ok,
            finality: f === undefined ? null : { final: f.final, rule: f.rule, at: f.at, finalizedBlock: f.finalizedBlock },
          };
        }),
        balancesBefore: (e.balancesBefore ?? []).map(({ role, address, network, kind, asset, value }) => ({ role, address, network, kind, asset, value })),
        balancesAfter: (e.balancesAfter ?? []).map(({ role, address, network, kind, asset, value }) => ({ role, address, network, kind, asset, value })),
        reopen: isRecord(lastReopen) ? { at: lastReopen["at"], same: lastReopen["same"] } : null,
        timingsMs: e.timingsMs ?? {},
      };
    });
  return { kind: "subetha-evm-testnets-e2e-summary", design: "docs/evm-testnets-x402-design.md §3.9", purchases };
}

export function writeSummary(evidenceDir: string, outFile: string, secrets: Secrets): Record<string, unknown> {
  const summary = summaryOf(evidenceDir);
  const text = jsonText(summary);
  if (secrets.leaks(text)) throw new Error("the summary would contain a known secret value; refusing to write it");
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, text, "utf8");
  return summary;
}

/* ────────────────────────────────────────────────────────────────────────────── CLI */

function argOf(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

/** 私的な証跡は ignored の `.claude_workflow/local/` の下だけ（公開の場所に body・journal を書かない）。 */
export function checkPrivateEvidenceDir(dir: string): string {
  const resolved = path.resolve(dir);
  if (!resolved.split(path.sep).join("/").includes("/.claude_workflow/local/")) throw new PlanRefusal("--evidence-dir must be under .claude_workflow/local/ (private evidence)");
  return resolved;
}

function bearerOf(argv: readonly string[], env: Env, secrets: Secrets): string | undefined {
  const name = argOf(argv, "token");
  if (name === undefined) return undefined;
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new PlanRefusal("--token takes the NAME of an env variable, not its value");
  const value = env[name];
  if (value === undefined || value === "") throw new PlanRefusal(`${name} is not set`);
  secrets.add(value);
  return value;
}

async function main(argv: readonly string[], env: Env): Promise<number> {
  const command = argv[0];
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const secrets = Secrets.fromEnv(env);
  const safeOut = (line: string): void => out(secrets.redact(line));
  if (command === "plan") {
    const chains = evmTestnetChainsOf(argOf(argv, "chains") ?? EVM_TESTNET_CHAINS.join(","));
    const outFile = argOf(argv, "out");
    if (outFile === undefined) throw new PlanRefusal("--out <file> is required");
    const plan = await buildPlan(chains, env, await viemChainReader(env));
    const sha = planSha256(plan);
    writePrivate(outFile, plan, secrets);
    const textFile = outFile.replace(/\.json$/, "") + ".txt";
    const text = planText(plan, sha);
    writePrivate(textFile, text, secrets);
    safeOut(text);
    safeOut(`plan written to ${outFile} and ${textFile}`);
    return plan.allSufficient ? 0 : 3;
  }
  if (command === "run") {
    const planFile = argOf(argv, "plan");
    const sha = argOf(argv, "plan-sha256");
    const url = argOf(argv, "mcp-url");
    const evidenceArg = argOf(argv, "evidence-dir");
    if (planFile === undefined || sha === undefined || url === undefined || evidenceArg === undefined) throw new PlanRefusal("run needs --plan, --plan-sha256, --mcp-url and --evidence-dir");
    const plan = loadApprovedPlan(planFile, sha);
    const evidenceDir = checkPrivateEvidenceDir(evidenceArg);
    const bearer = bearerOf(argv, env, secrets);
    const confirmation = argOf(argv, "inbound-confirmation") ?? "finalized";
    if (confirmation !== "finalized" && confirmation !== "receipt") throw new PlanRefusal("--inbound-confirmation must be finalized or receipt");
    const wait = argOf(argv, "wait-finalized-seconds");
    const mcp = await connectMcp(url, bearer);
    try {
      const result = await runPurchases(
        {
          plan,
          planSha256: sha,
          evidenceDir,
          only: argOf(argv, "only"),
          routerJournal: argOf(argv, "router-journal"),
          facilitatorJournal: argOf(argv, "facilitator-journal"),
          facilitatorLog: argOf(argv, "facilitator-log"),
          inboundConfirmation: confirmation,
          ...(wait === undefined ? {} : { waitFinalizedSeconds: Number(wait) }),
        },
        { mcp, chain: await viemChainReader(env), sign: runSignSigner(env), secrets, out },
      );
      return result.stopped === undefined ? 0 : 1;
    } finally {
      await mcp.close().catch(() => {});
    }
  }
  if (command === "finality") {
    const dir = argOf(argv, "evidence-dir");
    if (dir === undefined) throw new PlanRefusal("--evidence-dir is required");
    const wait = argOf(argv, "wait-seconds");
    const result = await runFinality(checkPrivateEvidenceDir(dir), await viemChainReader(env), secrets, out, wait === undefined ? {} : { waitSeconds: Number(wait) });
    return result.pending === 0 ? 0 : 3;
  }
  if (command === "reopen") {
    const dir = argOf(argv, "evidence-dir");
    const url = argOf(argv, "mcp-url");
    if (dir === undefined || url === undefined) throw new PlanRefusal("reopen needs --evidence-dir and --mcp-url");
    const mcp = await connectMcp(url, bearerOf(argv, env, secrets));
    try {
      const result = await runReopen(checkPrivateEvidenceDir(dir), mcp, secrets, out);
      return result.different === 0 ? 0 : 1;
    } finally {
      await mcp.close().catch(() => {});
    }
  }
  if (command === "summary") {
    const dir = argOf(argv, "evidence-dir");
    const outFile = argOf(argv, "out");
    if (dir === undefined || outFile === undefined) throw new PlanRefusal("summary needs --evidence-dir and --out");
    writeSummary(path.resolve(dir), outFile, secrets);
    safeOut(`summary written to ${outFile}`);
    return 0;
  }
  process.stderr.write("usage: tsx tools/evm-testnets-e2e.ts plan|run|finality|reopen|summary [options] (see the header of this file)\n");
  return 2;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const secrets = Secrets.fromEnv(process.env);
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error: unknown) => {
      // 固定文か、秘密を除いた文言だけ。
      const message = error instanceof PlanRefusal ? error.message : error instanceof Error ? error.message : "failed";
      process.stderr.write(`evm-testnets-e2e: ${secrets.redact(message)}\n`);
      process.exit(2);
    },
  );
}
