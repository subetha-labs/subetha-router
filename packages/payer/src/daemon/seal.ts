import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { open, seal } from "../store/keys.js";
import { StoreError, type StoreFs } from "../store/fs.js";

const AAD = "subetha-payer/install/v1";
const Box = z.object({ cipher: z.literal("aes-256-gcm"), iv: z.string(), tag: z.string(), ciphertext: z.string() }).strict();
const Manifest = z.record(z.string().regex(/^[a-f0-9]{64}$/));

export class InstallChanged extends StoreError {
  constructor(readonly files: readonly string[]) { super("install_changed"); }
}

export function installHashes(root: string, fs: StoreFs): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (relative: string): void => {
    const file = path.join(root, relative);
    const st = fs.lstatSync(file);
    // npm .bin links are files; directory links would omit/duplicate entire trees. Refuse them.
    if (st.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      if (!target.startsWith(`${fs.realpathSync(root)}${path.sep}`) || !fs.statSync(file).isFile()) throw new StoreError("install_unreadable");
      result[relative] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    } else if (st.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    } else if (st.isFile()) result[relative] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    else throw new StoreError("install_unreadable");
  };
  walk("dist");
  walk("node_modules");
  return result;
}

/** Decrypt and validate a seal file's manifest; any failure is `install_seal_corrupt`. */
export function readSealManifest(file: string, lek: Buffer, fs: StoreFs): Record<string, string> {
  let plain: Buffer | undefined;
  try {
    const box = Box.parse(JSON.parse(fs.readFileSync(file).toString("utf8")));
    plain = open(lek, box, AAD);
    return Manifest.parse(JSON.parse(plain.toString("utf8")));
  } catch { throw new StoreError("install_seal_corrupt"); }
  finally { plain?.fill(0); }
}
/** Encrypted seal file content for a manifest. */
export function sealManifest(lek: Buffer, manifest: Record<string, string>): string {
  const plain = Buffer.from(JSON.stringify(manifest));
  try { return JSON.stringify(seal(lek, plain, AAD)); }
  finally { plain.fill(0); }
}
export interface ManifestDiff { readonly added: string[]; readonly removed: string[]; readonly changed: string[] }
export function diffManifest(previous: Record<string, string>, current: Record<string, string>): ManifestDiff {
  const added = Object.keys(current).filter(name => !(name in previous)).sort();
  const removed = Object.keys(previous).filter(name => !(name in current)).sort();
  const changed = Object.keys(current).filter(name => name in previous && previous[name] !== current[name]).sort();
  return { added, removed, changed };
}

export function checkInstallSeal(file: string, manifest: Record<string, string>, lek: Buffer, fs: StoreFs, assertHeld: () => void): void {
  assertHeld();
  if (fs.existsSync(file)) {
    const previous = readSealManifest(file, lek, fs);
    const changed = [...new Set([...Object.keys(previous), ...Object.keys(manifest)])].filter((name) => previous[name] !== manifest[name]).sort();
    if (changed.length) throw new InstallChanged(changed);
    return;
  }
  const ciphertext = sealManifest(lek, manifest);
  const temp = `${file}.${randomBytes(8).toString("hex")}.new`;
  assertHeld();
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    const bytes = Buffer.from(ciphertext);
    let offset = 0;
    while (offset < bytes.length) {
      assertHeld();
      const wrote = fs.writeSync(fd, bytes.subarray(offset));
      if (wrote <= 0) throw new StoreError("store_write_failed");
      offset += wrote;
    }
    fs.fsyncSync(fd);
    assertHeld();
    fs.linkSync(temp, file); // never overwrite a concurrent seal
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

/**
 * Replace `file` atomically (follow-up FR-F2): exclusive temp file in the same directory ("wx" never follows an
 * existing name or symlink), data written and fsynced, then `rename`, then the directory fsynced. A crash at any
 * point leaves either the previous or the new content at `file`. The write is split in two halves around the
 * `during:<label>-write` point so a crash mid-write is observable; that never touches `file` itself.
 */
export async function replaceFileAtomic(file: string, bytes: Buffer, fs: StoreFs, held: () => void,
  hit: (point: string) => Promise<void> = async () => {}, label = "file"): Promise<void> {
  const temp = `${file}.${randomBytes(8).toString("hex")}.new`;
  held();
  const fd = fs.openSync(temp, "wx", 0o600);
  let renamed = false;
  try {
    try {
      await hit(`before:${label}-write`);
      const half = Math.floor(bytes.length / 2);
      for (const [start, end] of [[0, half], [half, bytes.length]] as const) {
        let offset = start;
        while (offset < end) {
          held();
          const wrote = fs.writeSync(fd, bytes.subarray(offset, end));
          if (wrote <= 0) throw new StoreError("store_write_failed");
          offset += wrote;
        }
        fs.fsyncSync(fd);
        if (start === 0) await hit(`during:${label}-write`);
      }
    } finally { fs.closeSync(fd); }
    await hit(`after:${label}-write`);
    held();
    await hit(`before:${label}-rename`);
    held();
    fs.renameSync(temp, file);
    renamed = true;
    await hit(`after:${label}-rename`);
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (!renamed && fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
