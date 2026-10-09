import path from "node:path";
import { TerminalSecrets } from "../daemon/tty.js";
import { StoreError } from "../store/fs.js";
import { unlockKeys, parseKeysDocument, zero } from "../store/keys.js";
import { openLedger } from "../store/ledger.js";
import { createPurchaseCore, type PurchaseCore } from "../daemon/purchase.js";
import { checkInstallSeal, installHashes } from "../daemon/seal.js";
import { Session } from "../daemon/session.js";
import { readConfig } from "../config.js";
import { routerIdentity } from "../router/identity.js";
import { RouterClient } from "../router/client.js";
import { FailureSummary, InspectionSummary, PurchaseRef, PurchaseSummary } from "../protocol/summary.js";
import { walletAddress } from "./wallet.js";
import { cliRun, daemonRead, invalid, output, requireTty, withLock, type CliDeps } from "./common.js";

/** No private wallet decryption, signer or automatic recovery. Only the ledger key is opened. */
async function offline<T>(deps: CliDeps, action: (core: PurchaseCore) => Promise<T>): Promise<T> {
  return withLock(deps, async (r, held) => {
    const config = readConfig(r.dir, r.fs), identity = routerIdentity(config.router.url, config.router.canonicalResource);
    const text = r.fs.readFileSync(path.join(r.dir, "keys.json")).toString("utf8"), doc = parseKeysDocument(text), address = walletAddress(text);
    let pass = await r.tty.read("Passphrase");
    let keys: ReturnType<typeof unlockKeys> | undefined;
    let ledger: ReturnType<typeof openLedger> | undefined;
    const session = new Session(Buffer.alloc(0)); session.close();
    try {
      held(); keys = unlockKeys(doc, pass); zero(keys.kek); pass = "";
      checkInstallSeal(path.join(r.dir, "install.seal"), installHashes(r.installRoot, r.fs), keys.lek, r.fs, held);
      held(); ledger = openLedger(path.join(r.dir, "ledger.ndjson"), keys.lek, r.fs);
      const core = createPurchaseCore({ ledger, session, address, phrase: "", assertHeld: held,
        router: deps.router ?? new RouterClient(new URL(identity.routerUrl)),
        purchase: { routerUrl: identity.routerUrl, canonicalResource: identity.resource,
          ui: { available: async () => false }, signer: { sign: async () => { throw new StoreError("approval_unavailable"); } } },
      });
      return await action(core);
    } finally { pass = ""; ledger?.close(); if (keys) zero(keys.kek, keys.lek); session.close(); }
  });
}
export async function inspectEvidence(ref: string | undefined, deps: CliDeps): Promise<unknown> {
  const live = await daemonRead(deps, "inspect", ref === undefined ? {} : { ref });
  if (live === undefined) requireTty(deps.tty ?? new TerminalSecrets());
  const result = live === undefined ? await offline(deps, core => core.inspect(ref)) : live;
  const failure = FailureSummary.safeParse(result); if (failure.success) throw new StoreError(failure.data.error);
  return InspectionSummary.parse(result);
}
export function runInspect(args: readonly string[], deps: CliDeps = {}): Promise<number> {
  return cliRun(async () => {
    if (args.length < 1 || args.length > 2 || !PurchaseRef.safeParse(args[0]).success || (args.length === 2 && args[1] !== "--close")) invalid();
    const ref = args[0]!;
    if (args[1] !== "--close") { output(await inspectEvidence(ref, deps)); return; }
    const tty = deps.tty ?? new TerminalSecrets();
    // Must precede any disk/client operation; this is a human-only local mutation.
    requireTty(tty);
    await offline(deps, async core => {
      output(InspectionSummary.parse(await core.inspect(ref)));
      let reason = await tty.read("Reason for closing this unknown outcome (funds may have moved)");
      try {
        if (!reason.trim() || reason.length > 512 || /[\x00-\x1f\x7f]/.test(reason)) throw new StoreError("reason_invalid");
        if (await tty.read("Close this ref by operator without retrying payment? (y/N)") !== "y") throw new StoreError("operator_cancelled");
        output(PurchaseSummary.parse(await core.closeByOperator(ref, reason)));
      } finally { reason = ""; }
    });
  });
}
