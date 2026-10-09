import path from "node:path";
import { randomBytes } from "node:crypto";
import { privateKeyToAddress } from "viem/accounts";
import { createKeysDocument, parseKeysDocument, zero } from "../store/keys.js";
import { StoreError } from "../store/fs.js";
import { BASE_RPC, USDC, readConfig, validRpc } from "../config.js";
import { FailureSummary, WalletSummary } from "../protocol/summary.js";
import { cliRun, daemonRead, invalid, requireTty, withLock, writeDocument, type CliDeps } from "./common.js";

export function walletAddress(text: string): string {
  const address = parseKeysDocument(text).wallets["eip155"]?.address;
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new StoreError("wallet_invalid");
  return address;
}
/** Fixed eth_call, no wallet/key/signing input. Chain identity is checked before querying USDC. */
export async function publicBalance(rpc: string, address: string, fetchRpc: typeof fetch = fetch): Promise<string> {
  if (!validRpc(rpc) || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new StoreError("config_invalid");
  async function call(method: string, params: unknown[]): Promise<unknown> {
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
    if (json.jsonrpc !== "2.0" || json.id !== 1 || json.error !== undefined) throw new StoreError("rpc_failed");
    return json.result;
  }
  try {
    if (await call("eth_chainId", []) !== "0x14a34") throw new StoreError("rpc_failed");
    const value = await call("eth_call", [{ to: USDC, data: "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0") }, "latest"]);
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new StoreError("rpc_failed");
    return BigInt(value).toString();
  } catch { throw new StoreError("rpc_failed"); }
}
export function runWallet(args: readonly string[], deps: CliDeps = {}): Promise<number> {
  return cliRun(async () => {
    if (args.length !== 1 || !["new", "address", "balance"].includes(args[0]!)) invalid();
    if (args[0] === "new") {
      requireTty(deps.tty ?? new (await import("../daemon/tty.js")).TerminalSecrets());
      await withLock(deps, async (r, held) => {
        // A surviving ledger/seal/config/temp is evidence, not a new wallet directory.
        if (r.fs.readdirSync(r.dir).some(name => name !== "daemon.lock")) throw new StoreError("wallet_exists");
        let pass = "", again = ""; let key: Buffer | undefined;
        try {
          pass = await r.tty.read("Passphrase"); again = await r.tty.read("Repeat passphrase");
          if (pass !== again) throw new StoreError("passphrase_mismatch");
          held(); key = (deps.randomKey ?? (() => randomBytes(32)))();
          if (key.length !== 32) throw new StoreError("wallet_invalid");
          const address = privateKeyToAddress(`0x${key.toString("hex")}`);
          const doc = createKeysDocument(pass, { eip155: { address, secret: key } });
          writeDocument(r.dir, "keys.json", doc, r.fs, held);
          process.stdout.write(address + "\n");
        } finally { pass = ""; again = ""; if (key) zero(key); }
      });
      return;
    }
    let address: string;
    const live = await daemonRead(deps, "wallet", {});
    if (live !== undefined) {
      const fail = FailureSummary.safeParse(live); if (fail.success) throw new StoreError(fail.data.error);
      const summary = WalletSummary.parse(live);
      const wallet = summary.wallets.find(w => w.rail === "x402" && w.network === "eip155:84532");
      if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)) throw new StoreError("wallet_invalid");
      address = wallet.address;
    } else address = await withLock(deps, async r => walletAddress(r.fs.readFileSync(path.join(r.dir, "keys.json")).toString("utf8")));
    if (args[0] === "address") { process.stdout.write(address + "\n"); return; }
    const { resources } = await import("./common.js");
    const r = resources(deps), config = readConfig(r.dir, r.fs);
    const balance = await (deps.balance ?? publicBalance)(config.rpc?.["eip155:84532"] ?? BASE_RPC, address);
    // Keep the same bounded base-unit schema as the daemon wallet Summary.
    WalletSummary.parse({ ok: true, wallets: [{ rail: "x402", network: "eip155:84532", address, balance, decimals: 6 }] });
    process.stdout.write(balance + "\n");
  });
}
