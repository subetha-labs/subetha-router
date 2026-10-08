#!/usr/bin/env node
/**
 * Solana の受取 owner の鍵（ed25519 の seed）を作り、**owner が指定した file にだけ**書く（`docs/provider-x402-workers.md` §2.4）。
 * 標準出力に出すのは公開鍵（= `PAY_TO`）だけ。file は mode 0600、既存なら上書きしない。鍵の管理は owner。
 *
 *   node scripts/keygen-solana.mjs <path-to-seed-file>
 *
 * seed の形は Router の `wallet:new:solana` と同じ（base58 の 32 バイト）。Provider は受け取るだけなので、この鍵を Worker に置かない。
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { getAddressDecoder, getBase58Decoder } from "@solana/kit";

const target = process.argv[2];
if (target === undefined || target === "") {
  process.stderr.write("usage: node scripts/keygen-solana.mjs <path-to-seed-file>\n");
  process.exit(2);
}
if (existsSync(target)) {
  process.stderr.write("refusing to overwrite an existing file\n");
  process.exit(1);
}
const seed = new Uint8Array(randomBytes(32));
const publicKey = getAddressDecoder().decode(ed25519.getPublicKey(seed));
writeFileSync(target, `${getBase58Decoder().decode(seed)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`PAY_TO=${publicKey}\n`);
