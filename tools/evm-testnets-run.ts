/**
 * EVM testnet 4 つの**専用の入口**（`docs/evm-testnets-x402-design.md` §3.5、タスク E-4）。**製品コードではない。**
 * `tools/rails-acceptance-run.ts` と同じ骨格で、`startHost` の EVM testnet の分岐（専用の設定生成 `evmTestnetsConfigOf`・専用の子
 * `tools/evm-testnets-router-process.ts`）を起動する。公開の入口・hosted には触れない。
 * - chain: `--chains rh,arbsep,hyperevm,sepolia` の部分集合（既定は 4 つとも）
 * - bind: `127.0.0.1` だけ（`SUBETHA_EVM_TESTNETS_BIND`。ほかの値は起動しない）、port は `SUBETHA_EVM_TESTNETS_PORT`（既定 0 = 使い捨て）
 * - journal: `SUBETHA_EVM_TESTNETS_JOURNAL_PATH`（既定 `runtime/evm-testnets/journal.ndjson`）。公開の journal と同じファイルは拒む
 * env（値は出さない）: `SUBETHA_OUTBOUND_PRIVATE_KEY`（または `SUBETHA_OUTBOUND_X402_KEY`）、`SUBETHA_ROUTER_RECEIVER`、`SUBETHA_EVM_FACILITATOR_URL`
 * （token は path の接頭辞）、`SUBETHA_EVM_PROVIDER_URL_<CHAIN>`、`SUBETHA_EVM_PROVIDER_PAYTO`。
 *
 * 起動したら stdout に 1 行 `{"event":"listening","port":<MCP>,"address":"127.0.0.1","routerPort":<Router>,"mode":"evm-testnets","chains":"rh,..."}` を書く。
 *
 * usage: SUBETHA_OUTBOUND_PRIVATE_KEY=0x... SUBETHA_ROUTER_RECEIVER=0x... SUBETHA_EVM_FACILITATOR_URL=http://127.0.0.1:8611/<token> \
 *        SUBETHA_EVM_PROVIDER_URL_RH=http://127.0.0.1:8621/v1/eth/snapshot ... SUBETHA_EVM_PROVIDER_PAYTO=0x... \
 *        tsx tools/evm-testnets-run.ts --chains rh,arbsep,hyperevm,sepolia
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { sameJournal } from "./rails-acceptance-run.js";
import { evmTestnetChainsOf, EVM_TESTNET_CHAINS, type EvmTestnetChain } from "./remote-mcp-config.js";
import { publicJournalPathOf, startHost, type HostOptions, type RunningHost } from "./remote-mcp.js";

export const EVM_TESTNETS_PORT_ENV = "SUBETHA_EVM_TESTNETS_PORT";
export const EVM_TESTNETS_BIND_ENV = "SUBETHA_EVM_TESTNETS_BIND";
export const EVM_TESTNETS_JOURNAL_ENV = "SUBETHA_EVM_TESTNETS_JOURNAL_PATH";

function argOf(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

/** 起動の選択肢（純粋関数。試験で確かめる）。 */
export function evmTestnetsOptionsOf(env: Readonly<Record<string, string | undefined>>, argv: readonly string[] = []): HostOptions & { readonly evmTestnets: { readonly chains: readonly EvmTestnetChain[] } } {
  const chains = evmTestnetChainsOf(argOf(argv, "chains") ?? EVM_TESTNET_CHAINS.join(","));
  const journalPath = path.resolve(env[EVM_TESTNETS_JOURNAL_ENV] ?? path.join(path.resolve("runtime"), "evm-testnets", "journal.ndjson"));
  if (sameJournal(journalPath, publicJournalPathOf(env))) {
    throw new Error("the evm testnets journal must not be the public journal");
  }
  const portRaw = env[EVM_TESTNETS_PORT_ENV];
  const port = portRaw === undefined || portRaw === "" ? 0 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${EVM_TESTNETS_PORT_ENV} must be an integer in 0..65535`);
  }
  const bindRaw = env[EVM_TESTNETS_BIND_ENV];
  const bind = bindRaw === undefined || bindRaw === "" ? "127.0.0.1" : bindRaw;
  if (bind !== "127.0.0.1") {
    throw new Error(`${EVM_TESTNETS_BIND_ENV} must be 127.0.0.1`);
  }
  return { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: false, outbound: false }, solanaMpp: { inbound: false, outbound: false } }, bind, port, journalPath, evmTestnets: { chains } };
}

/** 起動したときに stdout に書く 1 行（純粋関数。鍵・URL は載せない）。 */
export function evmTestnetsAnnouncementOf(host: Pick<RunningHost, "mcpPort" | "mcpAddress" | "routerPort">, chains: readonly EvmTestnetChain[]): string {
  return JSON.stringify({ event: "listening", port: host.mcpPort, address: host.mcpAddress, routerPort: host.routerPort, mode: "evm-testnets", chains: chains.join(",") });
}

async function main(): Promise<void> {
  let options: ReturnType<typeof evmTestnetsOptionsOf>;
  try {
    options = evmTestnetsOptionsOf(process.env, process.argv.slice(2));
  } catch {
    process.stderr.write("evm testnets options are invalid (check --chains, SUBETHA_EVM_TESTNETS_PORT, SUBETHA_EVM_TESTNETS_BIND, SUBETHA_EVM_TESTNETS_JOURNAL_PATH)\n");
    process.exit(2);
  }
  const host = await startHost(options);
  process.stdout.write(`${evmTestnetsAnnouncementOf(host, options.evmTestnets.chains)}\n`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(() => {
    process.stderr.write("could not start the evm testnets host\n");
    process.exit(1);
  });
}
