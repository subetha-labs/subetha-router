/**
 * 上流が 402 で断った支払いの EIP-3009 の `authorization` が、上流で使われていないことを確かめる（運用者の道具。読むだけ）。
 * `docs/outbound-rejected-unused-check.md` U-4。journal にも chain にも書かない。
 *
 *   npm run outbound:unused -- --journal <path> --payment <paymentId> --rpc <https URL> [--allow-loopback]
 *
 * 結果（1 行の JSON）: `unused_after_expiry`（時刻が validBefore 以上の確定したブロックで未使用 = 上流は受け取っておらず、今後も受け取れない）、
 * `used_or_canceled`（使われたか取り消された。支払いの有無は Transfer で別に確かめる）、`too_early`、`no_authorization_recorded`、`chain_mismatch`、`rpc_error`。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** `authorizationState(address,bytes32)` の selector。 */
export const AUTHORIZATION_STATE_SELECTOR = "0xe94a0102";
const RPC_MAX_BYTES = 64 * 1024;
const RPC_TIMEOUT_MS = 10_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const SECONDS = /^[1-9][0-9]{0,15}$/;
const NETWORK = /^eip155:([1-9][0-9]{0,15})$/;
const QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;

export type UnusedResult = "unused_after_expiry" | "used_or_canceled" | "too_early" | "no_authorization_recorded" | "chain_mismatch" | "rpc_error";
export interface UnusedReport {
  readonly paymentId: string;
  readonly result: UnusedResult;
  readonly validBefore?: string;
  readonly blockNumber?: number;
  readonly blockHash?: string;
  readonly blockTimestamp?: number;
}
export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;

interface Recorded {
  readonly network: string;
  readonly asset: string;
  readonly from: string;
  readonly nonce: string;
  readonly validBefore: string;
}

/** その `paymentId` の最後の `dest_failed` の行の `authorization`（形どおりの時だけ）。 */
export function recordedAuthorizationOf(journalText: string, paymentId: string): Recorded | undefined {
  let found: unknown;
  for (const line of journalText.split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof row !== "object" || row === null) continue;
    const { paymentId: id, event, patch } = row as Record<string, unknown>;
    if (id !== paymentId || event !== "dest_failed") continue;
    found = typeof patch === "object" && patch !== null ? (patch as Record<string, unknown>)["authorization"] : undefined;
  }
  if (typeof found !== "object" || found === null) return undefined;
  const { network, asset, from, nonce, validBefore } = found as Record<string, unknown>;
  if (typeof network !== "string" || !NETWORK.test(network)) return undefined;
  if (typeof asset !== "string" || !ADDRESS.test(asset) || typeof from !== "string" || !ADDRESS.test(from)) return undefined;
  if (typeof nonce !== "string" || !NONCE.test(nonce) || typeof validBefore !== "string" || !SECONDS.test(validBefore)) return undefined;
  return { network, asset, from, nonce, validBefore };
}

/** `authorizationState(from, nonce)` の calldata。 */
export function authorizationStateCalldata(from: string, nonce: string): string {
  return `${AUTHORIZATION_STATE_SELECTOR}${"0".repeat(24)}${from.slice(2).toLowerCase()}${nonce.slice(2).toLowerCase()}`;
}

export async function checkUnused(journalText: string, paymentId: string, rpc: Rpc): Promise<UnusedReport> {
  const recorded = recordedAuthorizationOf(journalText, paymentId);
  if (recorded === undefined) return { paymentId, result: "no_authorization_recorded" };
  const base = { paymentId, validBefore: recorded.validBefore };
  try {
    const chainId = await rpc("eth_chainId", []);
    const expected = BigInt(NETWORK.exec(recorded.network)![1]!);
    if (typeof chainId !== "string" || !QUANTITY.test(chainId)) return { ...base, result: "rpc_error" };
    if (BigInt(chainId) !== expected) return { ...base, result: "chain_mismatch" };
    const block = await rpc("eth_getBlockByNumber", ["finalized", false]);
    if (typeof block !== "object" || block === null) return { ...base, result: "rpc_error" };
    const { number, hash, timestamp } = block as Record<string, unknown>;
    if (typeof number !== "string" || !QUANTITY.test(number) || typeof hash !== "string" || !HASH.test(hash) || typeof timestamp !== "string" || !QUANTITY.test(timestamp)) return { ...base, result: "rpc_error" };
    const at = { blockNumber: Number(BigInt(number)), blockHash: hash, blockTimestamp: Number(BigInt(timestamp)) };
    // EIP-3009: 使えるのは block.timestamp < validBefore の間だけ。確定したブロックの時刻が validBefore 以上なら、もう使えない。
    if (BigInt(timestamp) < BigInt(recorded.validBefore)) return { ...base, ...at, result: "too_early" };
    const word = await rpc("eth_call", [{ to: recorded.asset, data: authorizationStateCalldata(recorded.from, recorded.nonce) }, { blockHash: hash, requireCanonical: true }]);
    if (typeof word !== "string" || !WORD.test(word)) return { ...base, ...at, result: "rpc_error" };
    const state = BigInt(word);
    if (state === 0n) return { ...base, ...at, result: "unused_after_expiry" };
    if (state === 1n) return { ...base, ...at, result: "used_or_canceled" };
    return { ...base, ...at, result: "rpc_error" };
  } catch {
    return { ...base, result: "rpc_error" };
  }
}

/** JSON-RPC の呼び出し（https だけ。redirect は拒否、64 KiB、10 秒。URL・本文は例外に出さない）。 */
export function httpRpc(url: string, allowLoopback: boolean): Rpc {
  const parsed = new URL(url);
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (!(parsed.protocol === "https:" || (allowLoopback && loopback && parsed.protocol === "http:"))) throw new Error("rpc must be an https URL");
  let id = 0;
  return async (method, params) => {
    const response = await fetch(parsed, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method, params }),
      redirect: "error",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (response.status !== 200 || response.body === null) throw new Error("rpc failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RPC_MAX_BYTES) {
        await reader.cancel();
        throw new Error("rpc failed");
      }
      chunks.push(value);
    }
    const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof envelope !== "object" || envelope === null || "error" in envelope || !("result" in envelope)) throw new Error("rpc failed");
    return (envelope as { result: unknown }).result;
  };
}

function argOf(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function main(argv: readonly string[]): Promise<number> {
  const journal = argOf(argv, "--journal");
  const paymentId = argOf(argv, "--payment");
  const rpcUrl = argOf(argv, "--rpc");
  if (journal === undefined || paymentId === undefined || rpcUrl === undefined) {
    process.stderr.write("usage: npm run outbound:unused -- --journal <path> --payment <paymentId> --rpc <https URL> [--allow-loopback]\n");
    return 2;
  }
  let rpc: Rpc;
  try {
    rpc = httpRpc(rpcUrl, argv.includes("--allow-loopback"));
  } catch {
    process.stderr.write("rpc must be an https URL\n");
    return 2;
  }
  const report = await checkUnused(readFileSync(journal, "utf8"), paymentId, rpc);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.result === "unused_after_expiry" || report.result === "used_or_canceled" ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
