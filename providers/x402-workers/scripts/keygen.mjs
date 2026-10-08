#!/usr/bin/env node
/**
 * Arc の受取鍵（売り手証明の鍵）を作り、**鍵は Workers の secret にだけ**入れる（`docs/provider-x402-workers.md` §2.4）。
 * 標準出力に出すのは address だけ。鍵は wrangler を子 process で起動してその標準入力に書く（端末・ログ・file に残らない）。
 *
 *   node scripts/keygen.mjs --env arc            # wrangler login 済みの端末で。`wrangler secret put SELLER_PROOF_KEY --env arc` を内部で呼ぶ
 *   node scripts/keygen.mjs --env arc --dry-run  # wrangler を呼ばず address だけ出す（鍵は捨てる）
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const env = envIndex === -1 ? undefined : args[envIndex + 1];
const dryRun = args.includes("--dry-run");
if (env !== "arc") {
  process.stderr.write("usage: node scripts/keygen.mjs --env arc [--dry-run]\n");
  process.exit(2);
}

const key = `0x${randomBytes(32).toString("hex")}`;
const address = privateKeyToAccount(key).address;

if (dryRun) {
  process.stdout.write(`${address}\n`);
  process.exit(0);
}

const child = spawn("npx", ["--no-install", "wrangler", "secret", "put", "SELLER_PROOF_KEY", "--env", env], { stdio: ["pipe", "inherit", "inherit"] });
child.stdin.write(`${key}\n`);
child.stdin.end();
child.on("close", (code) => {
  if (code !== 0) {
    process.stderr.write("wrangler secret put failed; the key was not stored anywhere (generate again)\n");
    process.exit(1);
  }
  process.stdout.write(`PAY_TO=${address}\n`);
});
