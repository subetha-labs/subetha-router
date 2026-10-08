#!/usr/bin/env node
/**
 * challenge の HMAC の秘密（48 バイトの乱数、base64url）を作り、**Worker の secret `MPP_SECRET` にだけ**入れる（stdin 経由。端末・ログ・file に残らない）。
 *
 *   node scripts/secret-new.mjs            # wrangler login 済みの端末で
 *   node scripts/secret-new.mjs --dry-run  # wrangler を呼ばず、長さだけ出す（値は捨てる）
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const dryRun = process.argv.slice(2).includes("--dry-run");
const secret = randomBytes(48).toString("base64url");
if (dryRun) {
  process.stdout.write(`MPP_SECRET: ${secret.length} characters (not stored)\n`);
  process.exit(0);
}
const child = spawn("npx", ["--no-install", "wrangler", "secret", "put", "MPP_SECRET"], { stdio: ["pipe", "inherit", "inherit"] });
child.stdin.write(`${secret}\n`);
child.stdin.end();
child.on("close", (code) => {
  if (code !== 0) {
    process.stderr.write("wrangler secret put failed; the secret was not stored anywhere (generate again)\n");
    process.exit(1);
  }
  process.stdout.write("MPP_SECRET stored\n");
});
