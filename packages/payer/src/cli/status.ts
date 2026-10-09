import { InspectionSummary, PurchaseRef } from "../protocol/summary.js";
import { cliRun, invalid, output, type CliDeps } from "./common.js";
import { inspectEvidence } from "./inspect.js";
export function runStatus(args: readonly string[], deps: CliDeps = {}): Promise<number> {
  return cliRun(async () => {
    if (args.length > 1 || (args.length === 1 && !PurchaseRef.safeParse(args[0]).success)) invalid();
    const result = InspectionSummary.parse(await inspectEvidence(args[0], deps));
    output(args.length ? result.inspections[0]!.summary : { ok: true, purchases: result.inspections.map(item => item.summary) });
  });
}
