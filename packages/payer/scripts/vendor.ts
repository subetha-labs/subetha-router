/**
 * P-2 project-source copies, not third-party vendoring. Origin: this repository's
 * P-0 sources (docs/agent-payer-tasks.md, PR #129); payer package license: MIT.
 * Only these three files are permitted. Do not add SDK/BUSL or second-slice code.
 * Generated files stay byte-identical except for the one local import rewrite.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const payer = new URL("../", import.meta.url);
const repo = new URL("../../", payer);
const destination = new URL("src/vendor/", payer);
const sources = [
  ["src/shared/networks.ts", "networks.ts"],
  ["tools/sign-classify-evm.ts", "sign-classify-evm.ts"],
  ["tools/x402-payer.ts", "x402-payer.ts"],
] as const;

// Read and validate all inputs before writing. Resolve paths from this file, not cwd.
const copies = await Promise.all(sources.map(async ([source, name]) => {
  let bytes = await readFile(new URL(source, repo));
  if (name === "sign-classify-evm.ts") {
    const text = bytes.toString("utf8");
    const from = 'from "../src/shared/networks.js"';
    if (text.split(from).length !== 2) throw new Error("vendor: expected exactly one networks import");
    bytes = Buffer.from(text.replace(from, 'from "./networks.js"'));
  }
  return { name, bytes };
}));
await mkdir(destination, { recursive: true });
for (const { name, bytes } of copies) await writeFile(fileURLToPath(new URL(name, destination)), bytes);
