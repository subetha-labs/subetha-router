import { StoreError } from "../store/fs.js";

export const MAX_TTL_MS = 3_600_000;

/** Owns the original Buffer. No hex conversion here; signing's V8 string residual remains a limitation. */
export class Session {
  private expired = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly deadline: number;
  constructor(private readonly key: Buffer, ttlMs = MAX_TTL_MS, startedAt = Date.now()) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS || !Number.isFinite(startedAt)) {
      key.fill(0);
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
  close(): void {
    this.expired = true;
    this.key.fill(0);
    clearTimeout(this.timer);
  }
}
