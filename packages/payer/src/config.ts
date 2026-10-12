/** Fixed human configuration, shared by CLI and daemon; never sourced from cwd. */
import path from "node:path";
import { z } from "zod";
import { MAX_TTL_MS } from "./daemon/session.js";
import { HOSTED_ROUTER_URL, routerIdentity } from "./router/identity.js";
import { StoreError, type StoreFs } from "./store/fs.js";
export const BASE_RPC = "https://sepolia.base.org/";
/**
 * Public RPC defaults for the other payer networks (docs/payer-rails-design.md FR-R12, §2.7); a `config.json` `rpc` entry overrides
 * each. Spelled in WHATWG-normalized form (trailing `/`) because `validRpc` accepts only already-normalized URLs.
 */
export const TEMPO_RPC = "https://rpc.moderato.tempo.xyz/";
export const SOLANA_RPC = "https://api.devnet.solana.com/";
export const ARC_RPC = "https://rpc.testnet.arc.io/";
/** Assets of the Router's table on the payer's testnets (`src/vendor/networks.ts` is the authority; these are the display/balance constants). */
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const ARC_USDC = "0x3600000000000000000000000000000000000000";
export const PATHUSD = "0x20c0000000000000000000000000000000000000";
export const SOLANA_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export function validRpc(value: string): boolean {
  try {
    const u = new URL(value);
    // Public HTTPS only; no auth, token query, fragments, local/private IPs or URL normalization.
    return u.href === value && u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash &&
      !value.includes("?") && !value.includes("#") && (!u.port || u.port === "443") &&
      /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(u.hostname) && u.hostname.includes(".") &&
      !/^[\d.]+$/.test(u.hostname) && !/(?:^|\.)(localhost|local|internal|test|invalid)$/i.test(u.hostname);
  } catch { return false; }
}
export const Config = z.object({
  version: z.literal(1),
  router: z.object({ url: z.string().url(), canonicalResource: z.object({ url: z.string().url(), method: z.literal("GET") }).strict().optional() }).strict(),
  session: z.object({ ttlMs: z.number().int().min(1).max(MAX_TTL_MS) }).strict().optional(),
  rails: z.tuple([z.literal("x402")]).optional(),
  rpc: z.object({
    "eip155:84532": z.string().refine(validRpc).optional(),
    "eip155:42431": z.string().refine(validRpc).optional(),
    "eip155:5042002": z.string().refine(validRpc).optional(),
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": z.string().refine(validRpc).optional(),
  }).strict().optional(),
}).strict();
export type Config = z.infer<typeof Config>;
export function parseConfig(raw: unknown): Config {
  if (typeof raw === "object" && raw !== null && "version" in raw && raw.version !== 1) throw new StoreError("store_unsupported_version");
  const parsed = Config.safeParse(raw);
  if (!parsed.success) throw new StoreError("config_invalid");
  routerIdentity(parsed.data.router.url, parsed.data.router.canonicalResource);
  return parsed.data;
}
export function readConfig(dir: string, fs: StoreFs): Config {
  const file = path.join(dir, "config.json");
  let raw: unknown = { version: 1, router: { url: HOSTED_ROUTER_URL } };
  if (fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file).toString("utf8")); }
    catch { throw new StoreError("store_corrupt"); }
  }
  return parseConfig(raw);
}
