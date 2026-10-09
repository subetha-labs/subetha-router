import { reclaimLock } from "../store/lock.js";
import { StoreError } from "../store/fs.js";
import { TerminalSecrets } from "../daemon/tty.js";
import { cliRun, invalid, output, requireTty, resources, type CliDeps } from "./common.js";
export function runLock(args: readonly string[], deps: CliDeps = {}): Promise<number> {
  return cliRun(async () => {
    if (args.length !== 1 || args[0] !== "reclaim") invalid();
    const tty = deps.tty ?? new TerminalSecrets(); requireTty(tty);
    const r = resources(deps);
    if (await tty.read("Confirm no daemon/contender is running; reclaim dead owner lock? (y/N)") !== "y") throw new StoreError("operator_cancelled");
    // Reclaim itself rechecks positive death and identities after human input, under its guard.
    const result = reclaimLock(r.dir, r.lockDeps, true);
    output({ ok: true, removed: result.removed });
  });
}
