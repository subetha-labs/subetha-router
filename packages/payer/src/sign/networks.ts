/**
 * The networks this payer pays on (docs/payer-rails-design.md SR-R6): the Router's table restricted to the four testnets.
 * The table itself is code (`src/vendor/networks.ts`, byte-identical to the Router's); the mainnet rows exist there for the
 * Router and are never offered, quoted, signed or paid by this payer. Pure helpers only; no key, RPC or I/O.
 */
import { KNOWN_NETWORKS, knownAssetOf, knownNetworkOf, networkFamilyOf, type KnownAsset, type KnownNetwork } from "../vendor/networks.js";

export const BASE_SEPOLIA = "eip155:84532";
export const TEMPO_TESTNET = "eip155:42431";
export const ARC_TESTNET = "eip155:5042002";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const PAYER_NETWORK_IDS: readonly string[] = Object.freeze([BASE_SEPOLIA, TEMPO_TESTNET, ARC_TESTNET, SOLANA_DEVNET]);

/** Testnet rows of the Router's table, in the table's order. Frozen. */
export const PAYER_NETWORKS: readonly KnownNetwork[] = Object.freeze(KNOWN_NETWORKS.filter((entry) => PAYER_NETWORK_IDS.includes(entry.network)));

/** Which key rail of the store signs for a network: `eip155` (secp256k1) or `solana` (ed25519). `undefined` = not a payer network. */
export type KeyRail = "eip155" | "solana";
export function keyRailOf(network: string): KeyRail | undefined {
  if (!PAYER_NETWORK_IDS.includes(network)) return undefined;
  const family = networkFamilyOf(network);
  return family === "evm" ? "eip155" : family === "svm" ? "solana" : undefined;
}

export function payerNetworkOf(network: string): KnownNetwork | undefined {
  return knownNetworkOf(PAYER_NETWORKS, network);
}

export function payerAssetOf(network: string, asset: string): KnownAsset | undefined {
  const entry = payerNetworkOf(network);
  return entry === undefined ? undefined : knownAssetOf(entry, asset);
}

/** Inbound rails the table allows on a payer network (`x402`, `mpp`), or `[]`. */
export function inboundRailsOf(network: string): readonly ("x402" | "mpp")[] {
  return payerNetworkOf(network)?.inbound ?? [];
}
