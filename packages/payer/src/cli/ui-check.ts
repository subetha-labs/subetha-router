import { z } from "zod";
import { TerminalSecrets } from "../daemon/tty.js";
import { createOsascriptUi } from "../ui/osascript.js";
import { createKeysDocument, unlockKeys, zero } from "../store/keys.js";
import { cliRun, invalid, output, requireTty, type CliDeps } from "./common.js";
const TEXT = 'UI CHECK ONLY — no purchase or signature\nQuote: "test"; backslash: \\; newline follows:\nEnd of fixed test text.';
const Classification = z.union([z.object({ approved: z.literal(true) }).strict(), z.object({ approved: z.literal(false), reason: z.enum(["malformed_response", "cancelled", "timeout", "bad_passphrase", "helper_failed", "approval_unavailable"]) }).strict()]);
export function runUiCheck(args: readonly string[], deps: CliDeps = {}): Promise<number> {
  return cliRun(async () => {
    if (args.length) invalid();
    const tty = deps.tty ?? new TerminalSecrets(); requireTty(tty);
    let pass = await tty.read("Temporary UI-check passphrase (not your wallet passphrase)");
    try {
      // Synthetic empty wallet document in memory only; uses the production verifier KDF.
      const doc = createKeysDocument(pass, {}); pass = "";
      const verify = (value: string) => { try { const keys = unlockKeys(doc, value); zero(keys.kek, keys.lek); return true; } catch { return false; } };
      const ui = deps.uiCheck?.(verify) ?? createOsascriptUi(verify);
      const result = await ui.available() ? Classification.parse(await ui.check(TEXT)) : { approved: false, reason: "approval_unavailable" };
      output(result);
    } finally { pass = ""; }
  });
}
