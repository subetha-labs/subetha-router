/** Pure owned-file fixture validation only; not CLI/process/Router wire acceptance. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { cliEvidence } from "./cli-evidence.js";
import { rehydrate } from "../../src/daemon/recover.js";
import { projectResult } from "../../src/daemon/purchase.js";
import { openLedger } from "../../src/store/ledger.js";
import { parseKeysDocument, unlockKeys, zero } from "../../src/store/keys.js";
import { realFs } from "../../src/store/fs.js";

test.each(["signed", "unknown"] as const)("saved CLI %s fixture authenticates/reopens and secret scan is causal", state => {
  const e = cliEvidence("http://127.0.0.1:1/mcp", state);
  const doc = parseKeysDocument(readFileSync(path.join(e.store.dir, "keys.json"), "utf8"));
  const keys = unlockKeys(doc, e.store.passphrase), ledger = openLedger(e.file, keys.lek, realFs);
  try {
    const loaded = rehydrate(ledger, { routerUrl: "http://127.0.0.1:1/mcp",
      canonicalResource: { url: e.raw.quote.resource.url, method: "GET" }, address: doc.wallets["eip155"]!.address }, e.store.phrase, projectResult);
    expect(loaded.get(e.ref)?.state).toBe(state);
    expect(loaded.get(e.ref)?.record.paymentId).toBe(e.record.paymentId);
    expect(e.safe([])).toBe(true);
    for (const secret of e.secrets) {
      for (const value of [secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("hex")]) {
        expect(e.safe({ nested: [{ value }] })).toBe(false);
      }
    }
  } finally { ledger.close(); zero(keys.kek, keys.lek); e.store.cleanup(); }
});
