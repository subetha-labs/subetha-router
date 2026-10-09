import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKeysDocument } from "../../src/store/keys.js";

/** Every invocation creates throwaway material. Never reads the invoking user's HOME/store. */
export function fixtureStore(routerUrl = "http://127.0.0.1:1/mcp", ttlMs = 3_600_000) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "p3a-")));
  const dir = path.join(home, ".config", "subetha-payer");
  const installRoot = path.join(home, "install");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(installRoot, "dist"), { recursive: true });
  mkdirSync(path.join(installRoot, "node_modules"), { recursive: true });
  writeFileSync(path.join(installRoot, "dist", "entry.js"), "fixture bytes\n");
  writeFileSync(path.join(installRoot, "node_modules", "dependency.js"), "fixture dependency\n");
  const passphrase = randomBytes(24).toString("base64");
  const phrase = randomBytes(16).toString("hex");
  const key = randomBytes(32);
  try {
    const document = createKeysDocument(passphrase, { eip155: { address: `0x${randomBytes(20).toString("hex")}`, secret: key } });
    writeFileSync(path.join(dir, "keys.json"), JSON.stringify(document), { mode: 0o600 });
  } finally { key.fill(0); }
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, router: { url: routerUrl }, session: { ttlMs } }), { mode: 0o600 });
  return { home, dir, installRoot, passphrase, phrase, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
export type FixtureStore = ReturnType<typeof fixtureStore>;
