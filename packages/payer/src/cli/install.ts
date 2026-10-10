/**
 * `subetha-payer install accept` — follow-up FR-F2 (design `docs/agent-payer-followups-design.md` §2).
 *
 * Human-only by intent, not by proof: a TTY is required, but an agent can create a PTY too. The guard is the wallet
 * passphrase. No MCP tool or daemon socket method reaches this code. The wallet key is never decrypted; only the
 * seal key is opened. This does not detect or prevent same-user tampering (T4′): accepting an install you did not
 * verify seals whatever is there.
 */
import path from "node:path";
import { TerminalSecrets } from "../daemon/tty.js";
import { diffManifest, installHashes, readSealManifest, replaceFileAtomic, sealManifest } from "../daemon/seal.js";
import { StoreError } from "../store/fs.js";
import { parseKeysDocument, unlockKeys, zero } from "../store/keys.js";
import { STORE_FILES } from "../store/paths.js";
import { cliRun, invalid, output, requireTty, withLock, type CliDeps } from "./common.js";

export const ACCEPT_WORD = "ACCEPT";
const GUIDANCE = "Accept only an upgrade you started and verified (README: Upgrading). If you did not upgrade, type anything else and stop.";

function installedVersion(root: string, deps: { fs: { readFileSync(file: string): Buffer } }): string {
  try {
    const version = JSON.parse(deps.fs.readFileSync(path.join(root, "package.json")).toString("utf8")).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version : "unknown";
  } catch { return "unknown"; }
}

export function runInstall(args: readonly string[], deps: CliDeps = {}): Promise<number> {
  return cliRun(async () => {
    if (args.length !== 1 || args[0] !== "accept") invalid();
    const tty = deps.tty ?? new TerminalSecrets();
    // Must precede any disk/client operation; this is a human-only local mutation.
    requireTty(tty);
    const hit = async (point: string) => { await deps.faults?.hit(point); };
    await withLock({ ...deps, tty }, async (r, held) => {
      const doc = parseKeysDocument(r.fs.readFileSync(path.join(r.dir, STORE_FILES.keys)).toString("utf8"));
      let pass = await tty.read("Passphrase");
      let lek: Buffer | undefined;
      try {
        held();
        const keys = unlockKeys(doc, pass);
        zero(keys.kek);
        lek = keys.lek;
      } finally { pass = ""; }
      try {
        const sealFile = path.join(r.dir, STORE_FILES.installSeal);
        if (!r.fs.existsSync(sealFile)) throw new StoreError("install_seal_missing");
        const previous = readSealManifest(sealFile, lek, r.fs);
        const current = installHashes(r.installRoot, r.fs);
        const diff = diffManifest(previous, current);
        const version = installedVersion(r.installRoot, r);
        const changed = diff.added.length + diff.removed.length + diff.changed.length;
        if (changed === 0) { output({ ok: true, changed: 0, version }); return; }
        // File names only (JSON-escaped, so control characters cannot act on the terminal).
        process.stderr.write(`Installed @subetha/payer version: ${version}\n`);
        process.stderr.write(`Added: ${JSON.stringify(diff.added)}\nRemoved: ${JSON.stringify(diff.removed)}\nChanged: ${JSON.stringify(diff.changed)}\n`);
        process.stderr.write(`${GUIDANCE}\n`);
        if (await tty.read(`Type ${ACCEPT_WORD} to seal this installation`) !== ACCEPT_WORD) throw new StoreError("operator_cancelled");
        held();
        // Keep the immediately previous seal as evidence. An existing backup already passed ensureStoreDir.
        await hit("before:prev");
        await replaceFileAtomic(path.join(r.dir, STORE_FILES.installSealPrev), r.fs.readFileSync(sealFile), r.fs, held, hit, "prev");
        await hit("after:prev");
        await replaceFileAtomic(sealFile, Buffer.from(sealManifest(lek, current)), r.fs, held, hit, "seal");
        output({ ok: true, changed, version });
      } finally { zero(lek); }
    });
  });
}
