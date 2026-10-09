import type { DaemonContext } from "../../src/daemon/interfaces.js";
import { createDaemonHandler } from "../../src/daemon/handler.js";
import { recordHash } from "../../src/daemon/record.js";

/** Only this fixture supplies deterministic refs and synthetic consent. Production has no env/argv bypass. */
export function purchaseHandler(context: DaemonContext, event: (name: string) => void, cancel = false) {
  let sequence = 0;
  return createDaemonHandler({ ...context, purchase: { ...context.purchase!,
    generateRef: () => `p_aaaaaaaaaaaa${"acegikmoqsuwy246"[sequence++]}`,
    ui: { available: async () => true, confirm: async record => {
      event("confirm"); return cancel ? { approved: false } : { approved: true, recordHash: recordHash(record), uiKind: "native" };
    } },
    signer: { sign: async () => { event("sign"); return "fixture-credential"; } },
  } });
}
