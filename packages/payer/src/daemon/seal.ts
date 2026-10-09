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

export function checkInstallSeal(file: string, manifest: Record<string, string>, lek: Buffer, fs: StoreFs, assertHeld: () => void): void {
  assertHeld();
  if (fs.existsSync(file)) {
    let plain: Buffer | undefined;
    try {
      const box = Box.parse(JSON.parse(fs.readFileSync(file).toString("utf8")));
      plain = open(lek, box, AAD);
      const previous = Manifest.parse(JSON.parse(plain.toString("utf8")));
      const changed = [...new Set([...Object.keys(previous), ...Object.keys(manifest)])].filter((name) => previous[name] !== manifest[name]).sort();
      if (changed.length) throw new InstallChanged(changed);
    } catch (error) {
      if (error instanceof InstallChanged) throw error;
      throw new StoreError("install_seal_corrupt");
    } finally { plain?.fill(0); }
    return;
  }
  const plain = Buffer.from(JSON.stringify(manifest));
  let ciphertext: string;
  try { ciphertext = JSON.stringify(seal(lek, plain, AAD)); }
  finally { plain.fill(0); }
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
