import { StoreError } from "../store/fs.js";
import type { SecretTty } from "./interfaces.js";

/** Raw terminal input: no echo, readline history, subprocess, file, argument or environment secret inlet. */
export class TerminalSecrets implements SecretTty {
  get available(): boolean { return process.stdin.isTTY === true && process.stderr.isTTY === true; }
  async read(label: "Passphrase" | "Security phrase"): Promise<string> {
    if (!this.available) throw new StoreError("no_tty");
    const input = process.stdin;
    const wasRaw = input.isRaw;
    const bytes = Buffer.alloc(4096);
    let size = 0;
    return new Promise<string>((resolve, reject) => {
      const finish = (ok: boolean): void => {
        input.off("data", data);
        input.off("end", cancel);
        input.off("error", cancel);
        process.off("SIGTERM", cancel);
        process.off("SIGINT", cancel);
        input.setRawMode(wasRaw);
        input.pause();
        process.stderr.write("\n");
        const text = ok ? bytes.subarray(0, size).toString("utf8") : "";
        bytes.fill(0);
        if (ok) resolve(text); else reject(new StoreError("tty_cancelled"));
      };
      const cancel = (): void => finish(false);
      const data = (chunk: Buffer): void => {
        for (const byte of chunk) {
          if (byte === 3 || byte === 4) { finish(false); return; }
          if (byte === 13 || byte === 10) { finish(true); return; }
          if (byte === 127 || byte === 8) { if (size) bytes[--size] = 0; continue; }
          if (byte < 32 || size === bytes.length) { finish(false); return; }
          bytes[size++] = byte;
        }
      };
      input.setRawMode(true);
      input.on("data", data);
      input.once("end", cancel);
      input.once("error", cancel);
      process.once("SIGTERM", cancel);
      process.once("SIGINT", cancel);
      process.stderr.write(`${label}: `);
      input.resume();
    });
  }
}
