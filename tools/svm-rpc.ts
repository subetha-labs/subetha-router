/**
 * payer 側の道具（`tools/svm-payer.ts`・`tools/svm-mpp-payer.ts`）が使う Solana の JSON-RPC の口（SR-M1 の「道具」の分。タスク M6）。**製品コードではない。**
 *
 * Router の adapter と同じ方針で 1 method だけを呼ぶ: **Router の guarded transport**（redirect 無し、名前解決の pinning、**loopback の拒否**）、期限 10 秒、応答 64 KiB の上限、
 * 再試行なし。呼ぶのは `getLatestBlockhash` だけ（mint も残高も読まない。simulate しない。**`sendTransaction` は呼ばない**）。
 *
 * loopback の RPC は既定で拒む。手元の node や試験の fixture に向けるときだけ `allowLoopback: true`（`npm run sign` では env `SOLANA_RPC_ALLOW_LOOPBACK=1`）。
 */
import { getBase58Encoder } from "@solana/kit";

import { readJsonObjectBody } from "../src/net/bounded-body.js";
import { createGuardedTransport } from "../src/net/guarded-fetch.js";

export const SVM_RPC_TIMEOUT_MS = 10_000;
export const SVM_RPC_RESPONSE_MAX_BYTES = 64 * 1024;
/** `npm run sign` が loopback の RPC を許す env（手元の node・試験の fixture 向け）。 */
export const SVM_RPC_ALLOW_LOOPBACK_ENV = "SOLANA_RPC_ALLOW_LOOPBACK";

export interface SvmRpcOptions {
  readonly rpcUrl: string;
  readonly allowLoopback?: boolean;
}

export interface SvmRpc {
  /** `getLatestBlockhash`（confirmed）を 1 回。形が違う・上限超・期限 → throw（鍵の値は文言に入らない）。 */
  latestBlockhash(): Promise<string>;
}

export function createSvmRpc(options: SvmRpcOptions): SvmRpc {
  const transport = createGuardedTransport({ allowLoopback: options.allowLoopback === true, report: () => {}, dns: { timeoutMs: 3_000, maxInFlight: 2 } });
  return {
    async latestBlockhash() {
      const response = await transport.fetch(
        options.rpcUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ commitment: "confirmed" }] }),
          redirect: "error",
          signal: AbortSignal.timeout(SVM_RPC_TIMEOUT_MS),
        },
        { routeId: "sign", operation: "rpc" },
      );
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`the RPC answered HTTP ${response.status}`);
      }
      const read = await readJsonObjectBody(response, SVM_RPC_RESPONSE_MAX_BYTES);
      const json = read.kind === "object" ? (read.body as { result?: { value?: { blockhash?: unknown } } }) : undefined;
      const blockhash = json?.result?.value?.blockhash;
      if (typeof blockhash !== "string" || getBase58Encoder().encode(blockhash).length !== 32) throw new Error("the RPC did not return a blockhash");
      return blockhash;
    },
  };
}
