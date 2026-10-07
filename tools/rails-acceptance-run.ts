/**
 * 多レールの**受け入れ用の起動**（multirail 設計 §8、タスク T8-b、T10 の G-3）。**製品コードではない**。
 *
 * 公開の入口（`tools/remote-mcp.ts`）と**同じ設定生成・同じ Router の process・同じ入口の関数**（`startHost`）を、
 * 多レールの有効化を `true` にして起動する。違いはそれだけ:
 * - 有効化: `--rails arc,solana`（既定は両方）。公開の入口の定数 `RAILS_ACTIVATION` には触らない（凍結されている）
 * - bind: `127.0.0.1`（公開しない。必要なら ssh のトンネルで）、port は `SUBETHA_ACCEPTANCE_PORT`（既定 0 = 使い捨て）
 * - journal: `SUBETHA_ACCEPTANCE_JOURNAL_PATH`（既定 `runtime/acceptance/journal.ndjson`）。公開の journal と同じパスは拒む
 * 本番の env（送信の鍵・MPP 受信の秘密・Arc の受取鍵・Solana の受取 owner・RPC）はそのまま読む。鍵・URL の値は出さない。
 *
 * 起動したら stdout に 1 行 `{"event":"listening","port":<MCP>,"routerPort":<Router>,"mode":"acceptance","rails":"arc,solana"}` を書く。
 *
 * usage: SUBETHA_OUTBOUND_PRIVATE_KEY=0x... SUBETHA_ROUTER_RECEIVER=0x... SUBETHA_ARC_RECEIVER_KEY=0x... SUBETHA_SOLANA_RECEIVER=... \
 *        tsx tools/rails-acceptance-run.ts [--rails arc,solana]
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

import { activationFromEnv, activationToEnv } from "./rails-entry.js";
import { RAILS_ACTIVATION, type RailsActivation } from "./remote-mcp-config.js";
import { publicJournalPathOf, startHost, type HostOptions } from "./remote-mcp.js";

export const ACCEPTANCE_PORT_ENV = "SUBETHA_ACCEPTANCE_PORT";
export const ACCEPTANCE_JOURNAL_ENV = "SUBETHA_ACCEPTANCE_JOURNAL_PATH";

function argOf(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

/** 受け入れ用の起動の選択肢。純粋関数（試験で確かめる）。 */
export function acceptanceOptionsOf(env: Readonly<Record<string, string | undefined>>, argv: readonly string[] = []): HostOptions {
  const activation: RailsActivation = activationFromEnv(argOf(argv, "rails") ?? "arc,solana");
  if (!activation.arc && !activation.solana) {
    throw new Error("--rails must activate at least one of arc, solana");
  }
  const journalPath = path.resolve(env[ACCEPTANCE_JOURNAL_ENV] ?? path.join(path.resolve("runtime"), "acceptance", "journal.ndjson"));
  if (journalPath === path.resolve(publicJournalPathOf(env))) {
    throw new Error("the acceptance journal must not be the public journal");
  }
  const portRaw = env[ACCEPTANCE_PORT_ENV];
  const port = portRaw === undefined || portRaw === "" ? 0 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${ACCEPTANCE_PORT_ENV} must be an integer in 0..65535`);
  }
  // 公開の入口の定数はこの起動でも無効のまま（凍結。ここでは読むだけ）。
  if (RAILS_ACTIVATION.arc || RAILS_ACTIVATION.solana) {
    throw new Error("the public RAILS_ACTIVATION must stay disabled");
  }
  return { activation, bind: "127.0.0.1", port, journalPath };
}

async function main(): Promise<void> {
  let options: HostOptions;
  try {
    options = acceptanceOptionsOf(process.env, process.argv.slice(2));
  } catch {
    process.stderr.write("acceptance options are invalid (check --rails, SUBETHA_ACCEPTANCE_PORT, SUBETHA_ACCEPTANCE_JOURNAL_PATH)\n");
    process.exit(2);
  }
  const host = await startHost(options);
  process.stdout.write(`${JSON.stringify({ event: "listening", port: host.mcpPort, routerPort: host.routerPort, mode: "acceptance", rails: activationToEnv(options.activation) })}\n`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(() => {
    process.stderr.write("could not start the acceptance host\n");
    process.exit(1);
  });
}
