/**
 * 本番の入口の process（`tools/remote-router-process.ts`）と受け入れ用の起動（`tools/rails-acceptance-run.ts`）を**別プロセス**で起動する
 * （multirail 設計 §8、タスク T8-b）。鍵は乱数。
 *
 * 本番の process は起動時に Tempo の RPC へ読取の probe を出す（動的の MPP 送信の確認。`docs/dynamic-gas-fee-design.md` §4）ので、
 * **接続の無い試験では listen まで行けない**。ここでは Tempo の RPC を解決しない名前（`.invalid`）に向け、公開の RPC には出さずに、
 * 入口が**どこで止まるか**（多レールの段か、その後の probe か）と出力の固定文・鍵の不在を確かめる。起動の成功（能力の束縛・offer）は
 * `tests/unit/rails-entry.test.ts` がプロセス内の同じ関数で、実際の起動は T10 の G-3 で確かめる。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";

import { runToExit } from "../fixtures/loopback.js";
import { RAILS_ACTIVATION_ENV, SOLANA_OUTBOUND_KEY_ENV } from "../../tools/rails-entry.js";
import { getBase58Decoder } from "@solana/kit";
import { startSolanaRpc } from "../fixtures/solana-rpc.js";
import { ARC_RECEIVER_KEY_ENV } from "../../tools/real-seller-proof-capability.js";
import { INBOUND, ROUTE, ROUTE_ARC, ROUTE_MPP_IN, routerConfigOf } from "../../tools/remote-mcp-config.js";

const runtimeRoot = path.resolve(import.meta.dirname, "../../runtime");
const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
/** 解決しない名前（RFC 2606）。公開の RPC には出さない。 */
const UNRESOLVABLE_RPC = "https://rpc.tempo.invalid/";
const PROBE_FAILED = /the Tempo RPC did not answer a read-only fee estimate at startup/;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function workDir(prefix: string): string {
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = mkdtempSync(path.join(runtimeRoot, prefix));
  dirs.push(dir);
  return dir;
}

/** Router の process の env（ホストが渡すものと同じ形。鍵は乱数、Tempo の RPC は解決しない名前）。 */
function processEnv(dir: string, configPath: string, extra: Record<string, string>): Record<string, string> {
  return {
    SUBETHA_OUTBOUND_MPP_KEY: generatePrivateKey(),
    SUBETHA_OUTBOUND_X402_KEY: generatePrivateKey(),
    SUBETHA_TEMPO_RPC_URL: UNRESOLVABLE_RPC,
    ROUTER_MPP_INBOUND_RPC_URL: UNRESOLVABLE_RPC,
    ROUTER_CONFIG_PATH: configPath,
    ROUTER_JOURNAL_PATH: path.join(dir, "journal.ndjson"),
    ROUTER_HTTP_PORT: "0",
    ROUTER_CANONICAL_BASE_URL: "http://127.0.0.1:8500",
    ROUTER_PRINCIPAL_TOKENS: "judge:public",
    ROUTER_ADAPTER_MODE: "real",
    ROUTER_SUBETHA_FACILITATOR_URL: INBOUND.facilitator,
    ROUTER_X402_INBOUND_FACILITATOR_URL: INBOUND.facilitator,
    ROUTER_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-t8b-process",
    ...extra,
  };
}

describe("Router の process: 有効化の値は内部の env から、能力は同じ値から（別プロセス）", () => {
  test("Arc を有効にすると多レールの段を通り、その後の Tempo の probe で止まる（鍵は出力に出ない）", async () => {
    const dir = workDir("t8b-process-arc-");
    const key = generatePrivateKey();
    const configPath = path.join(dir, "router.config.json");
    writeFileSync(configPath, JSON.stringify(routerConfigOf({}, RECEIVER, true, { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false } }, receivers: { arc: privateKeyToAccount(key).address } })));
    const result = await runToExit("tools/remote-router-process.ts", [], processEnv(dir, configPath, { [RAILS_ACTIVATION_ENV]: "arc-in", [ARC_RECEIVER_KEY_ENV]: key }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toMatch(/rails capabilities could not be created|seller proof capability/);
    expect(result.stderr).toMatch(PROBE_FAILED);
    expect(result.stdout).not.toContain("listening");
    expect(result.stdout + result.stderr).not.toContain(key.slice(2));
    expect(result.stdout + result.stderr).not.toContain("rpc.tempo.invalid");
  }, 30_000);

  test("有効化が空なら鍵の env は読まれない（壊れた鍵があっても多レールの段は通り、probe で止まる）", async () => {
    const dir = workDir("t8b-process-off-");
    const configPath = path.join(dir, "router.config.json");
    writeFileSync(configPath, JSON.stringify(routerConfigOf({}, RECEIVER, true)));
    const result = await runToExit("tools/remote-router-process.ts", [], processEnv(dir, configPath, { [RAILS_ACTIVATION_ENV]: "", [ARC_RECEIVER_KEY_ENV]: "not-a-key" }));
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toMatch(/rails capabilities could not be created/);
    expect(result.stderr).toMatch(PROBE_FAILED);
  }, 30_000);

  test.each([
    ["鍵が無い", (key: string, address: string) => ({ activation: "arc-in", key: undefined, payTo: address, pattern: /rails capabilities could not be created/, secret: key })],
    ["鍵の形が違う", (key: string, address: string) => ({ activation: "arc-in", key: "0xabc", payTo: address, pattern: /rails capabilities could not be created/, secret: key })],
    ["鍵と payTo が違う", (key: string) => ({ activation: "arc-in", key, payTo: privateKeyToAccount(generatePrivateKey()).address, pattern: /seller proof capability is bound to a different network or address/, secret: key })],
    ["有効化の値が壊れている", (key: string, address: string) => ({ activation: "arc,base", key, payTo: address, pattern: /rails capabilities could not be created/, secret: key })],
  ])("%s → 多レールの段で止まる（listen しない、固定文、鍵は出ない、probe に進まない）", async (_name, arrange) => {
    const dir = workDir("t8b-process-refuse-");
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    const { activation, key: envKey, payTo, pattern, secret } = arrange(key, address);
    const configPath = path.join(dir, "router.config.json");
    writeFileSync(configPath, JSON.stringify(routerConfigOf({}, RECEIVER, true, { activation: { arc: { inbound: true, outbound: false }, solana: { inbound: false, outbound: false } }, receivers: { arc: payTo } })));
    const result = await runToExit("tools/remote-router-process.ts", [], processEnv(dir, configPath, { [RAILS_ACTIVATION_ENV]: activation, ...(envKey === undefined ? {} : { [ARC_RECEIVER_KEY_ENV]: envKey }) }));
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("listening");
    expect(result.stderr).toMatch(pattern);
    expect(result.stderr).not.toMatch(PROBE_FAILED);
    expect(result.stdout + result.stderr).not.toContain(secret.slice(2));
  }, 30_000);
});

describe("Router の process: Solana の送信の鍵（U9）", () => {
  test("solana-out で鍵が無い → 固定文 solana_key で止まる（listen しない、probe に進まない、鍵は出ない）。鍵があれば多レールの段を通り Tempo の probe で止まる", async () => {
    const dir = workDir("t8b-process-solout-");
    const configPath = path.join(dir, "router.config.json");
    writeFileSync(configPath, JSON.stringify(routerConfigOf({}, RECEIVER, true, { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: false, outbound: true } }, receivers: {}, providers: {} })));
    const missing = await runToExit("tools/remote-router-process.ts", [], processEnv(dir, configPath, { [RAILS_ACTIVATION_ENV]: "solana-out" }));
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toMatch(/SUBETHA_OUTBOUND_SOLANA_KEY is required and must be a base58 seed/);
    expect(missing.stdout).not.toContain("listening");
    expect(missing.stderr).not.toMatch(PROBE_FAILED);
    const seed = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
    const broken = await runToExit("tools/remote-router-process.ts", [], processEnv(dir, configPath, { [RAILS_ACTIVATION_ENV]: "solana-out", [SOLANA_OUTBOUND_KEY_ENV]: "not-a-seed" }));
    expect(broken.stderr).toMatch(/SUBETHA_OUTBOUND_SOLANA_KEY is required and must be a base58 seed/);
    const withKey = await runToExit("tools/remote-router-process.ts", [], processEnv(dir, configPath, { [RAILS_ACTIVATION_ENV]: "solana-out", [SOLANA_OUTBOUND_KEY_ENV]: seed }));
    expect(withKey.code).not.toBe(0);
    expect(withKey.stderr).not.toMatch(/SUBETHA_OUTBOUND_SOLANA_KEY/);
    expect(withKey.stderr).toMatch(PROBE_FAILED);
    expect(withKey.stdout + withKey.stderr).not.toContain(seed);
  }, 60_000);
});

describe("Router の process: 静的 Solana route の宛先 ATA（U9）", () => {
  test("静的 route（URL と受取先あり）で宛先 ATA が確かめられなければ process は起動しない（固定文。listen しない、probe に進まない、鍵は出ない）", async () => {
    const dir = workDir("t8b-process-solata-");
    const configPath = path.join(dir, "router.config.json");
    const owner = "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d";
    const document = routerConfigOf({}, RECEIVER, true, { activation: { arc: { inbound: false, outbound: false }, solana: { inbound: false, outbound: true } }, receivers: {}, providers: { solana: owner }, upstreams: { arc: "", solana: "https://provider-sol.test/v1/eth/snapshot" } });
    expect(Object.keys((document["router"] as { routes: Record<string, unknown> }).routes)).toContain("md-sol-eth-snapshot-mpp");
    writeFileSync(configPath, JSON.stringify(document));
    // 宛先の ATA を持たない RPC の fixture（本番の入口の guarded transport は loopback を拒むので、応答に達しない場合も同じ fail closed の経路: ATA を確かめられない → 起動しない）。
    const rpc = await startSolanaRpc({ mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", decimals: 6 });
    try {
      const seed = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32)));
      const result = await runToExit("tools/remote-router-process.ts", [], processEnv(dir, configPath, { [RAILS_ACTIVATION_ENV]: "solana-out", [SOLANA_OUTBOUND_KEY_ENV]: seed, ROUTER_SOLANA_RPC_URL: rpc.url, SUBETHA_SOLANA_RPC_URL: rpc.url }));
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("listening");
      expect(result.stderr).toMatch(/destination token account of static route md-sol-eth-snapshot-mpp does not exist or is not the table's ATA/);
      expect(result.stderr).not.toMatch(PROBE_FAILED);
      expect(result.stdout + result.stderr).not.toContain(seed);
      expect(result.stdout + result.stderr).not.toContain(rpc.url);
    } finally {
      await rpc.close();
    }
  }, 60_000);
});

describe("受け入れ用の起動（tools/rails-acceptance-run.ts）", () => {
  test("Arc だけ有効: 同じ設定生成で activation true の設定を書き、別の journal のディレクトリを作り、同じ process を起動する（probe で止まる）。鍵は出ない", async () => {
    const dir = workDir("t8b-acceptance-");
    const key = generatePrivateKey();
    const journalPath = path.join(dir, "acceptance", "journal.ndjson");
    const before = new Set(readdirSync(runtimeRoot).filter((name) => name.startsWith("remote-")));
    const result = await runToExit("tools/rails-acceptance-run.ts", ["--rails", "arc-in"], {
      SUBETHA_OUTBOUND_PRIVATE_KEY: generatePrivateKey(),
      SUBETHA_ROUTER_RECEIVER: RECEIVER,
      SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-t8b-acceptance",
      SUBETHA_TEMPO_RPC_URL: UNRESOLVABLE_RPC,
      [ARC_RECEIVER_KEY_ENV]: key,
      SUBETHA_ACCEPTANCE_JOURNAL_PATH: journalPath,
      SUBETHA_ACCEPTANCE_PORT: "0",
    });
    const created = readdirSync(runtimeRoot).filter((name) => name.startsWith("remote-") && !before.has(name));
    for (const name of created) dirs.push(path.join(runtimeRoot, name));
    // Router は probe で止まるので、ホストは固定文で終わる（鍵・URL は出ない）。
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("could not start the Router");
    expect(result.stdout).not.toContain("listening");
    expect(result.stdout + result.stderr).not.toContain(key.slice(2));
    expect(result.stdout + result.stderr).not.toContain("rpc.tempo.invalid");
    // 同じ設定生成で、activation true の設定が書かれている（Arc の route・プロファイル、受取先は鍵の address。Solana は無い）。
    expect(created).toHaveLength(1);
    const document = JSON.parse(readFileSync(path.join(runtimeRoot, created[0]!, "router.config.json"), "utf8")) as { router: { routes: Record<string, { source: { payTo: string } }>; dynamic: { profiles: Record<string, unknown> } }; x402: { inboundFacilitators?: Record<string, unknown> } };
    expect(Object.keys(document.router.routes).sort()).toEqual([ROUTE, ROUTE_MPP_IN, ROUTE_ARC].sort());
    expect(document.router.routes[ROUTE_ARC]?.source.payTo).toBe(privateKeyToAccount(key).address);
    expect(Object.keys(document.router.dynamic.profiles).sort()).toEqual(["dyn-arc-to-mpp", "dyn-arc-to-x402", "dyn-mpp-to-x402", "dyn-x402-to-mpp"]);
    expect(Object.keys(document.x402.inboundFacilitators ?? {})).toEqual(["eip155:5042002"]);
    expect(JSON.stringify(document)).not.toContain(key.slice(2));
    // 別の journal: 受け入れ用のディレクトリが作られ、公開の journal には触れていない。
    expect(readdirSync(path.join(dir, "acceptance"))).toBeDefined();
    // 受け入れ用の起動は公開の定数を書き換えない（ソースの上の値は G-4 の両方 true のまま）。
    // 公開の定数（送信の設計 §6.1）: 受信は両方 true（G-4）、送信は両方 false（G-4′ まで）。
    expect(readFileSync("tools/remote-mcp-config.ts", "utf8")).toMatch(/RAILS_ACTIVATION: RailsActivation = Object\.freeze\(\{ arc: Object\.freeze\(\{ inbound: true, outbound: false \}\), solana: Object\.freeze\(\{ inbound: true, outbound: false \}\) \}\)/);
  }, 40_000);
});
