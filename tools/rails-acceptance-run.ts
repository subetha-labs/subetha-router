/**
 * 多レールの**受け入れ用の起動**（multirail 設計 §8、タスク T8-b、T10 の G-3）。**製品コードではない**。
 *
 * 公開の入口（`tools/remote-mcp.ts`）と**同じ設定生成・同じ Router の process・同じ入口の関数**（`startHost`）を、
 * 多レールの有効化を `true` にして起動する。違いはそれだけ:
 * - 有効化: `--rails arc-in,arc-out,solana-in,solana-out,solana-mpp-in,solana-mpp-out,arc-to-sol,sol-to-arc` の部分集合（既定は x402 の受信の両方 `arc-in,solana-in`。
 *   `arc-to-sol`・`sol-to-arc` は Arc x402 ↔ Solana x402 の動的プロファイルの組で、必要なレールの方向と一緒に指定する。送信の設計 §13）。公開の入口の定数 `RAILS_ACTIVATION` には触らない
 *   （凍結されている。G-4 の後は公開も受信は両方 true、送信は両方 false）
 * - bind: `127.0.0.1`（公開しない。必要なら ssh のトンネルで）、port は `SUBETHA_ACCEPTANCE_PORT`（既定 0 = 使い捨て）
 * - journal: `SUBETHA_ACCEPTANCE_JOURNAL_PATH`（既定 `runtime/acceptance/journal.ndjson`）。公開の journal と同じパスは拒む
 * - EVM testnet 3 つ（hosted 設計 §4・§8.2 の G-3）: `--rails` に `rh-in,rh-out,arbsep-in,arbsep-out,hyperevm-in,hyperevm-out` の部分集合を足すと、公開の入口と同じく
 *   facilitator の子を先に起動する（env は `SUBETHA_EVM_FACILITATOR_*`）。facilitator の journal と lock は **公開と同じ 1 つ**（公開の journal のディレクトリの
 *   `evm-facilitator/`）で、動いている公開の facilitator があれば `flock` で起動しない。port は 8611（コンテナでは `-p 127.0.0.1:8611:8611`）
 * 本番の env（送信の鍵・MPP 受信の秘密・Arc の受取鍵・Solana の受取 owner・RPC）はそのまま読む。鍵・URL の値は出さない。
 *
 * 起動したら stdout に 1 行 `{"event":"listening","port":<MCP>,"routerPort":<Router>,"mode":"acceptance","rails":"arc-in,solana-in"}` を書く（`rails` は有効化の token）。
 *
 * usage: SUBETHA_OUTBOUND_PRIVATE_KEY=0x... SUBETHA_ROUTER_RECEIVER=0x... SUBETHA_ARC_RECEIVER_KEY=0x... SUBETHA_SOLANA_RECEIVER=... \
 *        tsx tools/rails-acceptance-run.ts [--rails arc-in,arc-out,solana-in,solana-mpp-in]
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { activationFromEnv, activationToEnv } from "./rails-entry.js";
import { evmOf, HOSTED_EVM_CHAINS, railActive, type RailsActivation } from "./remote-mcp-config.js";
import { publicJournalPathOf, startHost, type HostOptions, type RunningHost } from "./remote-mcp.js";

export const ACCEPTANCE_PORT_ENV = "SUBETHA_ACCEPTANCE_PORT";
/**
 * bind するアドレス。既定 `127.0.0.1`。コンテナの中で動かし、ホストの loopback だけに port を公開する（`-p 127.0.0.1:8788:8788`）ときは
 * コンテナの中では `0.0.0.0` でなければ届かないので、その 2 つだけを許す（公開しないことはホスト側の port の公開で保つ）。
 */
export const ACCEPTANCE_BIND_ENV = "SUBETHA_ACCEPTANCE_BIND";
const ACCEPTANCE_BINDS = ["127.0.0.1", "0.0.0.0"] as const;
export const ACCEPTANCE_JOURNAL_ENV = "SUBETHA_ACCEPTANCE_JOURNAL_PATH";

function argOf(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

function existsAsEntry(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一番深い既存の祖先の実パス＋残り（symlink を辿った正準の形）。先の無い symlink（dangling）も、その先を辿って同じ扱いにする。
 * 起動時の判定であって、起動の後に作られる別名までは見ない（運用者の道具の範囲）。
 */
function canonicalPathOf(target: string, depth = 0): string {
  let current = path.resolve(target);
  const rest: string[] = [];
  while (!existsAsEntry(current)) {
    rest.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    return path.join(realpathSync(current), ...rest);
  } catch {
    // 先の無い symlink: 先を読んで、その位置で同じ判定を続ける（循環は深さで止める）。
    if (depth >= 32) return path.join(current, ...rest);
    const link = readlinkSync(current);
    return canonicalPathOf(path.join(path.resolve(path.dirname(current), link), ...rest), depth + 1);
  }
}

/**
 * 2 つの journal のパスが同じファイルを指すか（文字列の一致だけでなく、symlink を辿った正準の形と、既存なら dev/ino も見る。
 * 別名で同じ journal に 2 つの process が別のロックで書くことを防ぐ）。
 */
export function sameJournal(a: string, b: string): boolean {
  if (canonicalPathOf(a) === canonicalPathOf(b)) return true;
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/** 起動したときに stdout に書く 1 行（純粋関数）。 */
export function announcementOf(host: Pick<RunningHost, "mcpPort" | "mcpAddress" | "routerPort">, activation: RailsActivation): string {
  return JSON.stringify({ event: "listening", port: host.mcpPort, address: host.mcpAddress, routerPort: host.routerPort, mode: "acceptance", rails: activationToEnv(activation) });
}

/** 受け入れ用の起動の選択肢。純粋関数（試験で確かめる）。 */
export function acceptanceOptionsOf(env: Readonly<Record<string, string | undefined>>, argv: readonly string[] = []): HostOptions {
  // 既定は x402 の受信の両方（公開の定数と同じ形）。送信・Solana の MPP の受け入れは `--rails arc-in,arc-out,solana-in,solana-mpp-in` のように語を足す（送信の設計 §6.1、`docs/mpp-solana-design.md` §6.1）。
  const activation: RailsActivation = activationFromEnv(argOf(argv, "rails") ?? "arc-in,solana-in");
  // EVM testnet 3 つの token（`rh-in`・`rh-out`・`arbsep-in`・`arbsep-out`・`hyperevm-in`・`hyperevm-out`。hosted 設計 §4・§8.2 の G-3）も方向に数える。
  // どれかがあれば、公開の入口と同じく facilitator の子を Router の子より先に起動する（journal と lock は公開と同じ 1 つ: `evmFacilitatorJournalPathOf`）。
  const evm = evmOf(activation);
  if (!railActive(activation) && !HOSTED_EVM_CHAINS.some((chain) => evm[chain].inbound || evm[chain].outbound)) {
    throw new Error("--rails must activate at least one of arc-in, arc-out, solana-in, solana-out, solana-mpp-in, solana-mpp-out, rh-in, rh-out, arbsep-in, arbsep-out, hyperevm-in, hyperevm-out (arc-to-sol / sol-to-arc only add the pair profiles)");
  }
  const journalPath = path.resolve(env[ACCEPTANCE_JOURNAL_ENV] ?? path.join(path.resolve("runtime"), "acceptance", "journal.ndjson"));
  if (sameJournal(journalPath, publicJournalPathOf(env))) {
    throw new Error("the acceptance journal must not be the public journal");
  }
  const portRaw = env[ACCEPTANCE_PORT_ENV];
  const port = portRaw === undefined || portRaw === "" ? 0 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${ACCEPTANCE_PORT_ENV} must be an integer in 0..65535`);
  }
  const bindRaw = env[ACCEPTANCE_BIND_ENV];
  const bind = bindRaw === undefined || bindRaw === "" ? "127.0.0.1" : bindRaw;
  if (!(ACCEPTANCE_BINDS as readonly string[]).includes(bind)) {
    throw new Error(`${ACCEPTANCE_BIND_ENV} must be 127.0.0.1 (default) or 0.0.0.0 (only inside a container whose port is published to the host's loopback)`);
  }
  return { activation, bind, port, journalPath };
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
  process.stdout.write(`${announcementOf(host, options.activation)}\n`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(() => {
    process.stderr.write("could not start the acceptance host\n");
    process.exit(1);
  });
}
