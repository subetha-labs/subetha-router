import path from "node:path";
import { randomBytes } from "node:crypto";
import { privateKeyToAddress } from "viem/accounts";
import { createKeyPairSignerFromPrivateKeyBytes, address as solanaAddress } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { addWallet, createKeysDocument, parseKeysDocument, zero, type KeysDocument } from "../store/keys.js";
import { StoreError } from "../store/fs.js";
import { ARC_RPC, ARC_USDC, BASE_RPC, PATHUSD, SOLANA_RPC, SOLANA_USDC_MINT, TEMPO_RPC, USDC, readConfig, validRpc, type Config } from "../config.js";
import { FailureSummary, WalletSummary } from "../protocol/summary.js";
import { cliRun, daemonRead, invalid, requireTty, withLock, writeDocument, type CliDeps } from "./common.js";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
/** Public, secret-free guidance after `wallet new` (docs/payer-rails-design.md §2.7). */
export const FAUCET_NOTICE = [
  "Fund the keys on the testnets you will pay on (never mainnet):",
  "  USDC on Base Sepolia, Arc testnet and Solana devnet: https://faucet.circle.com",
  "  devnet SOL (the transaction fee when paying over MPP on Solana): https://faucet.solana.com",
  "  pathUSD on Tempo testnet (paying over MPP on Tempo): https://docs.tempo.xyz/docs/quickstart/faucet",
].join("\n");

export interface WalletAddresses { readonly eip155: string; readonly solana?: string }

/** Public addresses from a keys document (never a secret). `eip155` is required; `solana` only in a store that has it. */
export function walletAddresses(text: string): WalletAddresses {
  const doc = parseKeysDocument(text);
  const eip155 = doc.wallets["eip155"]?.address;
  if (!eip155 || !EVM_ADDRESS.test(eip155)) throw new StoreError("wallet_invalid");
  const solana = doc.wallets["solana"]?.address;
  if (solana !== undefined && !SOLANA_ADDRESS.test(solana)) throw new StoreError("wallet_invalid");
  return { eip155, ...(solana === undefined ? {} : { solana }) };
}
/** 0.1.x name: the EVM address only. */
export function walletAddress(text: string): string { return walletAddresses(text).eip155; }

export async function solanaAddressOf(seed: Buffer): Promise<string> {
  if (seed.length !== 32) throw new StoreError("wallet_invalid");
  const signer = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(seed));
  return String(signer.address);
}

/** Bounded JSON-RPC call: public https (or the injected fixture transport), no redirects, 15 s, 4 KiB, id/jsonrpc checked. */
async function rpcCall(rpc: string, method: string, params: unknown[], fetchRpc: typeof fetch): Promise<unknown> {
  const response = await fetchRpc(rpc, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!response.ok || !response.body) throw new StoreError("rpc_failed");
  const reader = response.body.getReader(); let text = "", size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4096) throw new StoreError("rpc_failed"); text += decoder.decode(value, { stream: true }); }
    text += decoder.decode();
  } finally { await reader.cancel(); }
  const json = JSON.parse(text);
  if (json.jsonrpc !== "2.0" || json.id !== 1) throw new StoreError("rpc_failed");
  if (json.error !== undefined) throw new RpcError(json.error);
  return json.result;
}
class RpcError extends Error { constructor(readonly error: unknown) { super("rpc_error"); } }

/** Fixed ERC-20 `balanceOf` via `eth_call`; no wallet/key/signing input. Chain identity is checked before querying the token. */
export async function evmBalance(rpc: string, chainIdHex: string, token: string, address: string, fetchRpc: typeof fetch = fetch): Promise<string> {
  if (!validRpc(rpc) || !EVM_ADDRESS.test(address) || !EVM_ADDRESS.test(token)) throw new StoreError("config_invalid");
  try {
    if (await rpcCall(rpc, "eth_chainId", [], fetchRpc) !== chainIdHex) throw new StoreError("rpc_failed");
    const value = await rpcCall(rpc, "eth_call", [{ to: token, data: "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0") }, "latest"], fetchRpc);
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new StoreError("rpc_failed");
    return BigInt(value).toString();
  } catch { throw new StoreError("rpc_failed"); }
}
/** 0.1.x name: Base Sepolia USDC. */
export function publicBalance(rpc: string, address: string, fetchRpc: typeof fetch = fetch): Promise<string> {
  return evmBalance(rpc, "0x14a34", USDC, address, fetchRpc);
}
/**
 * Solana devnet: lamports (`getBalance`) and devnet USDC base units (`getTokenAccountBalance` of the owner's ATA under the
 * table's token program). A missing ATA is "0" (the RPC answers -32602 for an account that does not exist); any other error fails.
 */
export async function solanaBalance(rpc: string, owner: string, fetchRpc: typeof fetch = fetch): Promise<{ readonly sol: string; readonly usdc: string }> {
  if (!validRpc(rpc) || !SOLANA_ADDRESS.test(owner)) throw new StoreError("config_invalid");
  try {
    const [ata] = await findAssociatedTokenPda({ mint: solanaAddress(SOLANA_USDC_MINT), owner: solanaAddress(owner), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const balance = await rpcCall(rpc, "getBalance", [owner, { commitment: "confirmed" }], fetchRpc) as { value?: unknown } | undefined;
    if (typeof balance?.value !== "number" || !Number.isSafeInteger(balance.value) || balance.value < 0) throw new StoreError("rpc_failed");
    let usdc: string;
    try {
      const token = await rpcCall(rpc, "getTokenAccountBalance", [String(ata), { commitment: "confirmed" }], fetchRpc) as { value?: { amount?: unknown } } | undefined;
      const amount = token?.value?.amount;
      if (typeof amount !== "string" || !/^(0|[1-9][0-9]{0,29})$/.test(amount)) throw new StoreError("rpc_failed");
      usdc = amount;
    } catch (error) {
      const code = error instanceof RpcError && typeof error.error === "object" && error.error !== null ? (error.error as { code?: unknown }).code : undefined;
      if (code !== -32602) throw error;
      usdc = "0";
    }
    return { sol: String(balance.value), usdc };
  } catch { throw new StoreError("rpc_failed"); }
}

/** One line per (network, asset); every value is re-validated through the daemon's bounded Summary schema before printing. */
export async function balanceLines(config: Config, wallets: WalletAddresses, fetchRpc: typeof fetch): Promise<string[]> {
  const rpc = config.rpc ?? {};
  const rows = [
    { rail: "x402", network: "eip155:84532", address: wallets.eip155, decimals: 6, balance: await evmBalance(rpc["eip155:84532"] ?? BASE_RPC, "0x14a34", USDC, wallets.eip155, fetchRpc), asset: "USDC" },
    { rail: "x402", network: "eip155:5042002", address: wallets.eip155, decimals: 6, balance: await evmBalance(rpc["eip155:5042002"] ?? ARC_RPC, "0x4cef52", ARC_USDC, wallets.eip155, fetchRpc), asset: "USDC" },
    { rail: "mpp", network: "eip155:42431", address: wallets.eip155, decimals: 6, balance: await evmBalance(rpc["eip155:42431"] ?? TEMPO_RPC, "0xa5bf", PATHUSD, wallets.eip155, fetchRpc), asset: "pathUSD" },
  ];
  if (wallets.solana !== undefined) {
    const solana = await solanaBalance(rpc[SOLANA_DEVNET] ?? SOLANA_RPC, wallets.solana, fetchRpc);
    rows.push({ rail: "x402", network: SOLANA_DEVNET, address: wallets.solana, decimals: 6, balance: solana.usdc, asset: "USDC" });
    rows.push({ rail: "mpp", network: SOLANA_DEVNET, address: wallets.solana, decimals: 9, balance: solana.sol, asset: "SOL" });
  }
  WalletSummary.parse({ ok: true, wallets: rows.map(({ asset: _asset, ...row }) => row) });
  return rows.map(row => `${row.network} ${row.asset} ${row.balance}`);
}

function addressLines(wallets: WalletAddresses): string {
  return `eip155 ${wallets.eip155}\n${wallets.solana === undefined ? "" : `solana ${wallets.solana}\n`}`;
}

export function runWallet(args: readonly string[], deps: CliDeps = {}): Promise<number> {
  return cliRun(async () => {
    const command = args.length === 1 && ["new", "address", "balance"].includes(args[0]!) ? args[0]! : args.length === 2 && args[0] === "add" && args[1] === "solana" ? "add" : invalid();
    if (command === "new") {
      requireTty(deps.tty ?? new (await import("../daemon/tty.js")).TerminalSecrets());
      await withLock(deps, async (r, held) => {
        // A surviving ledger/seal/config/temp is evidence, not a new wallet directory.
        if (r.fs.readdirSync(r.dir).some(name => name !== "daemon.lock")) throw new StoreError("wallet_exists");
        let pass = "", again = ""; let key: Buffer | undefined, seed: Buffer | undefined;
        try {
          pass = await r.tty.read("Passphrase"); again = await r.tty.read("Repeat passphrase");
          if (pass !== again) throw new StoreError("passphrase_mismatch");
          held(); key = (deps.randomKey ?? (() => randomBytes(32)))(); seed = (deps.randomSolanaKey ?? (() => randomBytes(32)))();
          if (key.length !== 32 || seed.length !== 32) throw new StoreError("wallet_invalid");
          const wallets = { eip155: privateKeyToAddress(`0x${key.toString("hex")}`), solana: await solanaAddressOf(seed) };
          const doc = createKeysDocument(pass, { eip155: { address: wallets.eip155, secret: key }, solana: { address: wallets.solana, secret: seed } });
          writeDocument(r.dir, "keys.json", doc, r.fs, held);
          process.stdout.write(addressLines(wallets));
          process.stderr.write(FAUCET_NOTICE + "\n");
        } finally { pass = ""; again = ""; if (key) zero(key); if (seed) zero(seed); }
      });
      return;
    }
    if (command === "add") {
      requireTty(deps.tty ?? new (await import("../daemon/tty.js")).TerminalSecrets());
      await withLock(deps, async (r, held) => {
        const doc: KeysDocument = parseKeysDocument(r.fs.readFileSync(path.join(r.dir, "keys.json")).toString("utf8"));
        if (doc.wallets["solana"] !== undefined) throw new StoreError("wallet_exists");
        let pass = ""; let seed: Buffer | undefined;
        try {
          pass = await r.tty.read("Passphrase");
          held(); seed = (deps.randomSolanaKey ?? (() => randomBytes(32)))();
          if (seed.length !== 32) throw new StoreError("wallet_invalid");
          const address = await solanaAddressOf(seed);
          // Verifier check, same kek, existing entries untouched; the file is replaced atomically under the lock.
          const next = addWallet(doc, pass, "solana", { address, secret: seed });
          writeDocument(r.dir, "keys.json", next, r.fs, held, true);
          process.stdout.write(`solana ${address}\n`);
        } finally { pass = ""; if (seed) zero(seed); }
      });
      return;
    }
    let wallets: WalletAddresses;
    const live = await daemonRead(deps, "wallet", {});
    if (live !== undefined) {
      const fail = FailureSummary.safeParse(live); if (fail.success) throw new StoreError(fail.data.error);
      const summary = WalletSummary.parse(live);
      // The daemon lists one row per payable (rail, network); the key rails are read off the network namespace.
      const eip155 = summary.wallets.find(w => w.network === "eip155:84532")?.address;
      const solana = summary.wallets.find(w => w.network.startsWith("solana:"))?.address;
      if (!eip155 || !EVM_ADDRESS.test(eip155) || (solana !== undefined && !SOLANA_ADDRESS.test(solana))) throw new StoreError("wallet_invalid");
      wallets = { eip155, ...(solana === undefined ? {} : { solana }) };
    } else wallets = await withLock(deps, async r => walletAddresses(r.fs.readFileSync(path.join(r.dir, "keys.json")).toString("utf8")));
    if (command === "address") { process.stdout.write(addressLines(wallets)); return; }
    const { resources } = await import("./common.js");
    const r = resources(deps), config = readConfig(r.dir, r.fs);
    const lines = await balanceLines(config, wallets, deps.fetchRpc ?? fetch);
    process.stdout.write(lines.map(line => line + "\n").join(""));
  });
}
