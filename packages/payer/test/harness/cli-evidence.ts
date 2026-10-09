/** Saved synthetic evidence only. No signer, daemon, lock bypass or network call. */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildRecord, jsonCopy, recordHash } from "../../src/daemon/record.js";
import { realFs } from "../../src/store/fs.js";
import { open as openSealed, parseKeysDocument, unlockKeys, zero } from "../../src/store/keys.js";
import { openLedger } from "../../src/store/ledger.js";
import { fixtureStore } from "./store.js";
import { events } from "./durable.js";
import { h1Quote } from "./router.js";
import { plaintextRows } from "./secrecy.js";
import { containsSecret } from "./secret-cases.js";

export function cliEvidence(routerUrl: string, last: "signed" | "unknown") {
  let key = Buffer.alloc(0);
  const store = fixtureStore(routerUrl, 3_600_000, value => { key = Buffer.from(value); });
  const ref = "p_aaaaaaaaaaaaa", raw = h1Quote();
  const credential = randomBytes(40).toString("base64"), ownerKey = randomBytes(32).toString("hex");
  const challenge = JSON.stringify(raw.quote.source.offer);
  const secrets = [key.toString("hex"), key.toString("base64"), store.passphrase, store.phrase, credential, ownerKey, challenge];
  key.fill(0);
  // Unknown metadata is authenticated inside the quoted envelope. Static quote.ownerKey
  // is deliberately NOT set: production correctly rejects dynamic evidence in this slice.
  const saved = { ...raw, secretFixture: { key: secrets[0], passphrase: store.passphrase, phrase: store.phrase, credential, ownerKey, challenge } };
  const file = path.join(store.dir, "ledger.ndjson");
  const doc = parseKeysDocument(readFileSync(path.join(store.dir, "keys.json"), "utf8"));
  const keys = unlockKeys(doc, store.passphrase);
  const record = buildRecord(saved, { routerUrl, canonicalResource: { url: raw.quote.resource.url, method: "GET" },
    address: doc.wallets["eip155"]!.address, ref, requestId: randomUUID() });
  const ledger = openLedger(file, keys.lek, realFs), hash = recordHash(record);
  try {
    for (const state of ["quoted", "approved", "sign_intent", "signed", "submit_intent", "unknown"]) {
      const data = state === "quoted" ? jsonCopy(record) : state === "approved"
        ? { recordHash: hash, shownAt: Date.now(), uiKind: "native" }
        : state === "unknown" ? { paymentId: record.paymentId } : { recordHash: hash };
      const sealed = state === "quoted" ? saved : state === "signed" ? { credential } : undefined;
      ledger.append({ ref, state, data: jsonCopy(data), ...(sealed ? { sealedPlain: Buffer.from(JSON.stringify(sealed)) } : {}) });
      if (state === last) break;
    }
  } finally { ledger.close(); zero(keys.kek, keys.lek); }
  const rows = () => events(file);
  function withKeys<T>(action: (lek: Buffer) => T): T {
    const opened = unlockKeys(doc, store.passphrase);
    try { return action(opened.lek); } finally { zero(opened.kek, opened.lek); }
  }
  return {
    store, ref, raw, record, secrets, file, rows,
    plainRows: () => withKeys(lek => plaintextRows(rows(), lek)),
    safe(exposed: unknown, extra: string[] = []) {
      // Include parsed values and their serialization so escaped secret strings are checked.
      const plain = withKeys(lek => plaintextRows(rows(), lek));
      return ![...secrets, ...extra].some(secret => containsSecret([exposed, plain, JSON.stringify(plain)], secret));
    },
    hasSealedReason(reason: string) {
      return withKeys(lek => {
        const row = rows().at(-1);
        if (row?.state !== "closed_by_operator" || !row.sealed) return false;
        const bytes = openSealed(lek, row.sealed, `${ref}:closed_by_operator`);
        try { return JSON.parse(bytes.toString("utf8")).reason === reason; } finally { bytes.fill(0); }
      });
    },
  };
}
