import type { PurchaseContext } from "../../src/daemon/interfaces.js";
import { recordHash } from "../../src/daemon/record.js";

/** Only this fixture supplies deterministic refs and synthetic consent. Production has no env/argv bypass. */
export function fixturePurchase(base: PurchaseContext, event: (name: string) => void, cancel = false): PurchaseContext {
  let sequence = 0;
  return { ...base,
    generateRef: () => `p_aaaaaaaaaaaa${"acegikmoqsuwy246"[sequence++]}`,
    ui: { available: async () => true, confirm: async record => {
      event("confirm"); return cancel ? { approved: false } : { approved: true, recordHash: recordHash(record), uiKind: "native" };
    } },
    // MPP on Tempo: the real signer sends the transfer and returns its hash; the fixture mirrors that shape only.
    signer: { sign: async (offer) => { event("sign"); const scheme = typeof offer === "object" && offer !== null ? (offer as { scheme?: unknown }).scheme : undefined; return { credential: "fixture-credential", ...(scheme === "tempo/charge" ? { txRef: `0x${"ab".repeat(32)}` } : {}) }; } },
  };
}
