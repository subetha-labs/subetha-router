import { open } from "../../src/store/keys.js";

/** Exempt only an exact, authenticated AES-GCM envelope at the ledger row's sealed field. */
export function plaintextRows(rows: Record<string, unknown>[], lek: Buffer): Record<string, unknown>[] {
  return rows.map(row => {
    const sealed = row["sealed"];
    if (!sealed || typeof sealed !== "object" || Array.isArray(sealed)) return row;
    if (Object.keys(sealed).sort().join(",") !== "cipher,ciphertext,iv,tag") return row;
    const box = sealed as Record<string, unknown>;
    if (box["cipher"] !== "aes-256-gcm" || typeof box["iv"] !== "string" || typeof box["tag"] !== "string" || typeof box["ciphertext"] !== "string") return row;
    let bytes: Buffer | undefined;
    try {
      bytes = open(lek, { cipher: box["cipher"], iv: box["iv"], tag: box["tag"], ciphertext: box["ciphertext"] }, `${row["ref"]}:${row["state"]}`);
      const { sealed: _, ...plain } = row;
      return plain;
    } catch { return row; }
    finally { bytes?.fill(0); }
  });
}
