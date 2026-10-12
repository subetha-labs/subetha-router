/**
 * Human-readable names for the approval dialog (docs/payer-dialog-v2-design.md §2). A fixed table over the payer's four testnets
 * (`PAYER_NETWORKS`, SR-R6): a network or asset that is not in it is shown as its raw id, never guessed. Pure functions, no I/O.
 */
import { PAYER_NETWORKS } from "../sign/networks.js";
import { sanitize } from "../daemon/record.js";

const NETWORK_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "eip155:84532": "Base Sepolia (testnet)",
  "eip155:42431": "Tempo testnet",
  "eip155:5042002": "Arc testnet",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana devnet",
});
/** Asset names the table itself does not carry (Tempo's pathUSD has no EIP-712 domain). */
const ASSET_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "eip155:42431/0x20c0000000000000000000000000000000000000": "pathUSD",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC",
});

export function networkName(network: string): string {
  return Object.hasOwn(NETWORK_NAMES, network) ? NETWORK_NAMES[network]! : sanitize(network);
}

/** The asset's short name (USDC, pathUSD) when the payer's table knows it; otherwise the raw asset id. */
export function assetName(network: string, asset: string): string {
  // EVM addresses compare case-insensitively (hex); Solana mints are case-sensitive base58 (a case-altered mint is a different id).
  const same = (a: string, b: string) => (a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b);
  const fixedKey = Object.keys(ASSET_NAMES).find((key) => key.startsWith(`${network}/`) && same(key.slice(network.length + 1), asset));
  if (fixedKey !== undefined) return ASSET_NAMES[fixedKey]!;
  const entry = PAYER_NETWORKS.find((n) => n.network === network)?.assets.find((a) => same(a.id, asset));
  return entry?.domain?.name ?? sanitize(asset);
}

/** `x402 (exact)`, `MPP (tempo/charge)`, `MPP (solana/charge)`; the scheme is shown whenever the record carries it. */
export function railName(rail: string, scheme?: string): string {
  const base = rail === "x402" ? "x402" : rail === "mpp" ? "MPP" : sanitize(rail);
  return scheme === undefined ? base : `${base} (${sanitize(scheme)})`;
}

/** Base units → decimal string by exact string placement (no arithmetic, no floats). Non-digit input or decimals outside 0..36 → the sanitized raw string. */
export function formatAmount(baseUnits: string, decimals: number | undefined): string {
  if (!/^\d+$/.test(baseUnits) || decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return sanitize(baseUnits);
  if (decimals === 0) return baseUnits;
  const padded = baseUnits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

/** "0.011 USDC" (plus base units when the asset is unnamed, so the number is never ambiguous). */
export function money(baseUnits: string, decimals: number | undefined, network: string, asset: string): string {
  const name = assetName(network, asset);
  const amount = formatAmount(baseUnits, decimals);
  return amount === baseUnits && decimals !== 0 ? `${sanitize(baseUnits)} base units of ${name}` : `${amount} ${name}`;
}
