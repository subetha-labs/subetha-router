import { StoreError } from "../store/fs.js";
import type { WalletRail } from "./interfaces.js";

export const MAX_TTL_MS = 3_600_000;

/** The decrypted keys of one unlock: `eip155` (32-byte secp256k1 key) is required, `solana` (32-byte ed25519 seed) optional. */
export interface SessionKeys { readonly eip155: Buffer; readonly solana?: Buffer }

/**
 * Owns the original Buffers (docs/payer-rails-design.md §2.2: a map of key rails). No hex conversion here; signing's V8
 * string residual remains a limitation. `close()` zero-fills every key.
 */
export class Session {
  private expired = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly deadline: number;
  private readonly keys: Map<WalletRail, Buffer>;
  constructor(keys: Buffer | SessionKeys, ttlMs = MAX_TTL_MS, startedAt = Date.now()) {
    this.keys = new Map(Buffer.isBuffer(keys) ? [["eip155", keys]] : Object.entries(keys).filter((entry): entry is [WalletRail, Buffer] => Buffer.isBuffer(entry[1])));
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS || !Number.isFinite(startedAt)) {
      this.zero();
      throw new StoreError("session_invalid");
    }
    this.deadline = startedAt + ttlMs;
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) this.close();
    else {
      this.timer = setTimeout(() => this.close(), Math.min(ttlMs, remaining));
      this.timer.unref();
    }
  }
  get locked(): boolean {
    if (Date.now() >= this.deadline) this.close();
    return this.expired;
  }
  /** Key rails this session holds (never the bytes). */
  get rails(): readonly WalletRail[] { return [...this.keys.keys()]; }
  /** The live key Buffer of a rail, or `undefined` when the store has no such wallet. Zero-filled once the session closes. */
  key(rail: WalletRail): Buffer | undefined { return this.keys.get(rail); }
  private zero(): void { for (const key of this.keys.values()) key.fill(0); }
  close(): void {
    this.expired = true;
    this.zero();
    clearTimeout(this.timer);
  }
}
