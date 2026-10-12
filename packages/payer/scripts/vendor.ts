/**
 * Project-source copies, not third-party vendoring. Origin: this repository's P-0 sources (docs/agent-payer-tasks.md, PR #129)
 * and, since 0.2.0, the full-rail signing tools (docs/payer-rails-design.md §2.1); payer package license: MIT.
 * Only the files below are permitted. Do not add SDK/BUSL code. Generated files stay byte-identical except for the
 * listed local import rewrites (each rewrite must match exactly once).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const payer = new URL("../", import.meta.url);
const repo = new URL("../../", payer);
const destination = new URL("src/vendor/", payer);

const NETWORKS = ['from "../src/shared/networks.js"', 'from "./networks.js"'] as const;
const SVM_MESSAGE = ['from "../src/adapters/inbound/x402-svm.js"', 'from "./svm-message.js"'] as const;
/** `tools/svm-rpc.ts` uses the Router's guarded transport; both net files are vendored next to it (SR-R5: same transport as the Router). */
const NET_BODY = ['from "../src/net/bounded-body.js"', 'from "./bounded-body.js"'] as const;
const NET_FETCH = ['from "../src/net/guarded-fetch.js"', 'from "./guarded-fetch.js"'] as const;

export const VENDORED: readonly { readonly source: string; readonly name: string; readonly rewrites: readonly (readonly [string, string])[] }[] = [
  { source: "src/shared/networks.ts", name: "networks.ts", rewrites: [] },
  { source: "tools/sign-classify-evm.ts", name: "sign-classify-evm.ts", rewrites: [NETWORKS] },
  { source: "tools/x402-payer.ts", name: "x402-payer.ts", rewrites: [] },
  { source: "tools/sign-dispatch.ts", name: "sign-dispatch.ts", rewrites: [NETWORKS] },
  { source: "tools/sign-check-tempo.ts", name: "sign-check-tempo.ts", rewrites: [] },
  { source: "tools/mpp-payer.ts", name: "mpp-payer.ts", rewrites: [] },
  { source: "tools/svm-key.ts", name: "svm-key.ts", rewrites: [] },
  { source: "tools/svm-payer.ts", name: "svm-payer.ts", rewrites: [SVM_MESSAGE] },
  { source: "tools/svm-mpp-payer.ts", name: "svm-mpp-payer.ts", rewrites: [SVM_MESSAGE] },
  { source: "tools/svm-rpc.ts", name: "svm-rpc.ts", rewrites: [NET_BODY, NET_FETCH] },
  { source: "src/shared/svm-message.ts", name: "svm-message.ts", rewrites: [] },
  { source: "src/net/guarded-fetch.ts", name: "guarded-fetch.ts", rewrites: [] },
  { source: "src/net/destination-policy.ts", name: "destination-policy.ts", rewrites: [] },
  { source: "src/net/bounded-body.ts", name: "bounded-body.ts", rewrites: [] },
];

export function rewrite(name: string, text: string, rewrites: readonly (readonly [string, string])[]): string {
  let out = text;
  for (const [from, to] of rewrites) {
    if (out.split(from).length !== 2) throw new Error(`vendor: ${name}: expected exactly one occurrence of ${from}`);
    out = out.replace(from, to);
  }
  return out;
}

// Read and validate all inputs before writing. Resolve paths from this file, not cwd.
const copies = await Promise.all(VENDORED.map(async ({ source, name, rewrites }) => {
  const text = (await readFile(new URL(source, repo))).toString("utf8");
  return { name, bytes: Buffer.from(rewrite(name, text, rewrites)) };
}));
await mkdir(destination, { recursive: true });
for (const { name, bytes } of copies) await writeFile(fileURLToPath(new URL(name, destination)), bytes);
