/**
 * EVM testnet 4 つの**専用の子 process**（`docs/evm-testnets-x402-design.md` §3.5）。**製品コードではない**（実鍵を扱う起動側）。
 * 公開の子（`tools/remote-router-process.ts`）と `routerProcessCapabilitiesOf` は変えない。ここはその結果に 2 つだけ足す:
 * - `evmSigningByNetwork`: 選んだ chain の network ぶん、同じ x402 の送信の鍵（`SUBETHA_OUTBOUND_X402_KEY`。Arc と同じ扱い、D-11）
 * - `localCounterparties`: env の facilitator の URL と C の Provider の URL のうち、`http://127.0.0.1:<port>` の origin
 * 起動は `tools/evm-testnets-run.ts` → `startHost` の分岐だけが行う。失敗は固定文（鍵・URL の値は出さない）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reportStartupFailure, startRouter, type RouterCapabilities } from "../src/main.js";
import { ProcessEntryError, routerProcessCapabilitiesOf } from "./rails-entry.js";
import { createRealEvmCapability } from "./real-evm-capability.js";
import { EVM_CHAINS_ENV, EVM_FACILITATOR_URL_ENV, EVM_TESTNETS, evmProviderUrlEnvOf, evmTestnetChainsOf } from "./remote-mcp-config.js";

/** 子の起動が止まる理由（固定文は入口が選ぶ）。 */
export class EvmTestnetsProcessError extends Error {
  readonly code: "outbound_keys" | "chains" | "urls" | "base";
  constructor(code: "outbound_keys" | "chains" | "urls" | "base") {
    super(
      code === "outbound_keys"
        ? "SUBETHA_OUTBOUND_X402_KEY is required for the EVM testnets"
        : code === "chains"
          ? "SUBETHA_EVM_CHAINS must be a comma-separated subset of rh,arbsep,hyperevm,sepolia"
          : code === "urls"
            ? "SUBETHA_EVM_FACILITATOR_URL and SUBETHA_EVM_PROVIDER_URL_<CHAIN> must be absolute URLs"
            : "router process capabilities could not be created",
    );
    this.name = "EvmTestnetsProcessError";
    this.code = code;
  }
}

/** `http://127.0.0.1:<port>` の形の origin だけを返す（ほかは allowlist に入れない: その URL は今の transport のまま）。 */
function localOriginOf(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EvmTestnetsProcessError("urls");
  }
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" ? url.origin : undefined;
}

/**
 * 子が `startRouter` に渡す能力の全部（純粋関数。試験で確かめる）: 公開の子と同じ `routerProcessCapabilitiesOf(env)` に、
 * 選んだ chain の `evmSigningByNetwork` と `localCounterparties` を足す。
 */
export function evmTestnetsCapabilitiesOf(env: Readonly<Record<string, string | undefined>>): RouterCapabilities {
  let base: RouterCapabilities;
  try {
    base = routerProcessCapabilitiesOf(env);
  } catch (error) {
    throw error instanceof ProcessEntryError && error.code === "outbound_keys" ? new EvmTestnetsProcessError("outbound_keys") : new EvmTestnetsProcessError("base");
  }
  const key = env["SUBETHA_OUTBOUND_X402_KEY"];
  if (key === undefined || key === "") throw new EvmTestnetsProcessError("outbound_keys");
  let chains;
  try {
    chains = evmTestnetChainsOf(env[EVM_CHAINS_ENV]);
  } catch {
    throw new EvmTestnetsProcessError("chains");
  }
  const evm = createRealEvmCapability(key);
  const urls = [env[EVM_FACILITATOR_URL_ENV], ...chains.map((chain) => env[evmProviderUrlEnvOf(chain)])];
  if (urls.some((url) => url === undefined || url === "")) throw new EvmTestnetsProcessError("urls");
  const origins = [...new Set(urls.map((url) => localOriginOf(url as string)).filter((origin): origin is string => origin !== undefined))];
  return {
    ...base,
    evmSigningByNetwork: {
      ...(base.evmSigningByNetwork ?? {}),
      ...Object.fromEntries(chains.map((chain) => [EVM_TESTNETS[chain].network, evm.capability(EVM_TESTNETS[chain].network)])),
    },
    localCounterparties: { origins },
  };
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  let capabilities: RouterCapabilities;
  try {
    capabilities = evmTestnetsCapabilitiesOf(process.env);
  } catch (error) {
    // 固定文だけ（例外の文字列に値は入れていないが、知らない例外は文を選ばない）。
    process.stderr.write(`${error instanceof EvmTestnetsProcessError ? error.message : "router process capabilities could not be created"}\n`);
    process.exit(2);
  }
  startRouter(capabilities).catch(reportStartupFailure);
}
