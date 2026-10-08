#!/usr/bin/env node
/**
 * fee payer の鍵（ed25519 の seed）を作り、**seed は Worker の secret `FEE_PAYER_KEY` にだけ**入れる（`docs/provider-mpp-solana-workers.md` §2.4）。
 * 標準出力に出すのは公開鍵だけで、**wrangler の upload が成功したときだけ**出す（失敗した鍵に資金を入れない）。
 * seed は wrangler を子 process で起動してその標準入力に書く（端末・ログ・file に残らない）。
 *
 *   node scripts/keygen-fee-payer.mjs            # wrangler login 済みの端末で。`wrangler secret put FEE_PAYER_KEY` を内部で呼ぶ
 *   node scripts/keygen-fee-payer.mjs --dry-run  # wrangler を呼ばず公開鍵だけ出す（seed は捨てる）
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { getAddressDecoder, getBase58Decoder } from "@solana/kit";

const dryRun = process.argv.slice(2).includes("--dry-run");
const seed = new Uint8Array(randomBytes(32));
const publicKey = getAddressDecoder().decode(ed25519.getPublicKey(seed));

if (dryRun) {
  process.stdout.write(`FEE_PAYER_PUBKEY=${publicKey}\n`);
  process.exit(0);
}

const child = spawn("npx", ["--no-install", "wrangler", "secret", "put", "FEE_PAYER_KEY"], { stdio: ["pipe", "inherit", "inherit"] });
child.stdin.write(`${getBase58Decoder().decode(seed)}\n`);
child.stdin.end();
seed.fill(0);
child.on("close", (code) => {
  if (code !== 0) {
    process.stderr.write("wrangler secret put failed; the seed was not stored anywhere (generate again)\n");
    process.exit(1);
  }
  process.stdout.write(`FEE_PAYER_PUBKEY=${publicKey}\n`);
});
