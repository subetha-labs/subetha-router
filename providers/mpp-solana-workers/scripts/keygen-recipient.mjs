#!/usr/bin/env node
/**
 * 受取 owner の鍵（ed25519 の seed）を作り、**owner が指定した file にだけ**書く（`docs/provider-mpp-solana-workers.md` §2.4）。
 * 標準出力に出すのは公開鍵（= `PAY_TO`）だけ。file は mode 0600、排他的に作る（既存なら書かない）、**リポジトリの中のパスは拒む**。
 * `providers/x402-workers/scripts/keygen-solana.mjs` と同じ形（seed は base58 の 32 バイト）。Provider は受け取るだけなので、この鍵を Worker に置かない。
 *
 *   node scripts/keygen-recipient.mjs <path-to-seed-file-outside-the-repository>
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { getAddressDecoder, getBase58Decoder } from "@solana/kit";

const target = process.argv[2];
if (target === undefined || target === "") {
  process.stderr.write("usage: node scripts/keygen-recipient.mjs <path-to-seed-file-outside-the-repository>\n");
  process.exit(2);
}
/** 実在する最も近い祖先を実パスに直してから残りを足す（symlink でリポジトリの中を指すパスを見抜く）。 */
function canonical(path) {
  const parts = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    parts.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync(current), ...parts);
}
const resolved = canonical(target);
// このパッケージは <repo>/providers/mpp-solana-workers にある: リポジトリの根の下は拒む（根も実パスで）。
const repoRoot = realpathSync(resolve(import.meta.dirname, "..", "..", ".."));
if (resolved === repoRoot || resolved.startsWith(`${repoRoot}${sep}`)) {
  process.stderr.write("refusing to write the seed inside the repository\n");
  process.exit(1);
}
if (existsSync(resolved)) {
  process.stderr.write("refusing to overwrite an existing file\n");
  process.exit(1);
}
mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
const seed = new Uint8Array(randomBytes(32));
const publicKey = getAddressDecoder().decode(ed25519.getPublicKey(seed));
writeFileSync(resolved, `${getBase58Decoder().decode(seed)}\n`, { mode: 0o600, flag: "wx" });
seed.fill(0);
process.stdout.write(`PAY_TO=${publicKey}\n`);
