import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
/** Independent files survive SIGKILL. Observation is sent only after this fsync returns. */
export function durableEvent(file: string, value: unknown): void {
  const fd = openSync(file, "a", 0o600);
  try { const bytes = Buffer.from(JSON.stringify(value) + "\n"); let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes.subarray(offset)); fsyncSync(fd); } finally { closeSync(fd); }
}
export function events(file: string): any[] { return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; }
