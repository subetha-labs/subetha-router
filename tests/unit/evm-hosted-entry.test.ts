/**
 * 入口とコンテナ（`docs/evm-testnets-hosted-design.md` §2.3・§4、FR-H1・FR-H8・SR-H3〜SR-H5、タスク H-4）の純粋な部分:
 * - 計画: EVM testnet 3 つのどれかが有効なら facilitator の子の計画（env の allowlist・URL・network）。Router の子の env は URL と token だけ（gas 鍵は無い）
 * - 全部無効: facilitator の計画は無く、子の env は golden と byte 一致（facilitator の env が親にあっても）
 * - facilitator の journal は公開の入口と受け入れ用の起動で同じ 1 つ（Router の journal は受け入れで別）
 * - 受け入れ用の起動の `--rails` の新しい 6 語
 * - `/supported` の照合（偽の fetch）、試験の口を本番の入口が使わないこと
 * - `deploy/swap-image.sh`: 新しいコンテナの `docker run` が `-p 127.0.0.1:8611:8611` を持つ（静的と、偽の docker での実行）
 * 鍵は固定の合成値。外へは接続しない。
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { acceptanceOptionsOf } from "../../tools/rails-acceptance-run.js";
import { activationFromEnv, activationToEnv, RAILS_ACTIVATION_ENV } from "../../tools/rails-entry.js";
import { EVM_TESTNETS, RAILS_ACTIVATION, RAILS_NONE, type EvmRailsActivation, type RailsActivation } from "../../tools/remote-mcp-config.js";
import {
  EVM_FACILITATOR_PORT,
  EVM_FACILITATOR_PROCESS,
  evmFacilitatorJournalPathOf,
  facilitatorSupportsAll,
  HostPlanError,
  hostPlanOf,
  publicJournalPathOf,
  type HostOptions,
} from "../../tools/remote-mcp.js";

const RECEIVER = "0xF88b0f34B0d76a9f55cec6D015eC1dE849De6405";
const PROVIDER = "0xf8243d93F339807CA9846Aa31155A2B2262D08db";
const FAC_KEY = "0x" + "33".repeat(32);
const TOKEN = "h4-entry-test-token_0123456789abcdefABCDEF";
/** golden と同じ env（`tests/unit/config-golden.test.ts`）。 */
const goldenEnv = { SUBETHA_OUTBOUND_PRIVATE_KEY: "0x" + "11".repeat(32), SUBETHA_ROUTER_RECEIVER: RECEIVER, SUBETHA_MPP_INBOUND_SECRET: "0123456789abcdef0123456789abcdef-golden", SUBETHA_TEMPO_RPC_URL: "https://tempo.example/v1/TOKEN", SUBETHA_ARC_RECEIVER_KEY: "0x" + "22".repeat(32), SUBETHA_SOLANA_RECEIVER: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5", SUBETHA_OUTBOUND_SOLANA_KEY: "2Lo8Y9kVf2iN4z3e5ZQ9k3nQJc7wq6yQx8k2mF9sP4tHc5uW1bX7aN3dR6gT9jK2", SUBETHA_ARC_PROVIDER_PAYTO: "0x719eAEC2Eb4bdDf10460C01832857C86e0BA42f1", SUBETHA_SOLANA_PROVIDER_PAYTO: "GHGd4JUFAKXHd59hzZUtQpB8wYSaWuANVGWwp3sJsg4d", SUBETHA_SOLANA_MPP_PROVIDER_PAYTO: "26jZd97NcGnfszA9UuPydpeHmshGhiYurg8LuMiYBUbc" };
/** facilitator の env（本番の env ファイルの名前）。 */
const facilitatorEnv = {
  SUBETHA_EVM_FACILITATOR_KEY: FAC_KEY,
  SUBETHA_EVM_FACILITATOR_TOKEN: TOKEN,
  SUBETHA_EVM_FACILITATOR_GAS_CAP_46630: "1000000000000000",
  SUBETHA_EVM_FACILITATOR_GAS_CAP_421614: "2000000000000000",
  SUBETHA_EVM_FACILITATOR_GAS_CAP_998: "3000000000000000",
  SUBETHA_EVM_PROVIDER_PAYTO: PROVIDER,
};
const golden = (name: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, "../fixtures/config-golden", `${name}.json`), "utf8"));
const ON = { inbound: true, outbound: true } as const;
const OFF = { inbound: false, outbound: false } as const;
const IN = { inbound: true, outbound: false } as const;
const OUT = { inbound: false, outbound: true } as const;
const withEvm = (activation: RailsActivation, evm: EvmRailsActivation): RailsActivation => ({ ...activation, evm });
const publicOptions = (activation: RailsActivation): HostOptions => ({ activation, bind: "0.0.0.0", port: 8787, journalPath: publicJournalPathOf({}) });

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("計画: EVM testnet のどれかが有効なら facilitator の子（hosted 設計 §4）", () => {
  test("facilitator の子の env は allowlist（写した名前・bind・port 8611・有効な network・payTo の 2 つ・有効な chain の gas の上限・journal）。Router の子には URL だけ", () => {
    const plan = hostPlanOf(publicOptions(withEvm(RAILS_ACTIVATION, { rh: IN, arbsep: OUT, hyperevm: OFF })), { ...goldenEnv, ...facilitatorEnv, SUBETHA_EVM_FACILITATOR_RPC_421614: "https://arb.example/KEY", SUBETHA_EVM_FACILITATOR_RPC_998: "https://hyper.example/unused" });
    expect(plan.facilitator).toBeDefined();
    const facilitator = plan.facilitator!;
    expect(facilitator.script).toBe("tools/evm-facilitator.ts");
    expect(EVM_FACILITATOR_PROCESS).toBe("tools/evm-facilitator.ts");
    expect(facilitator.port).toBe(8611);
    expect(EVM_FACILITATOR_PORT).toBe(8611);
    expect(facilitator.url).toBe(`http://127.0.0.1:8611/${TOKEN}`);
    expect(facilitator.networks).toEqual([EVM_TESTNETS.rh.network, EVM_TESTNETS.arbsep.network]);
    // 完全一致（無効な chain の gas の上限・RPC、ほかの秘密は入らない）。
    expect(facilitator.env).toEqual({
      EVM_FACILITATOR_KEY: FAC_KEY,
      EVM_FACILITATOR_TOKEN: TOKEN,
      EVM_FACILITATOR_BIND: "0.0.0.0",
      EVM_FACILITATOR_PORT: "8611",
      EVM_FACILITATOR_NETWORKS: "eip155:46630,eip155:421614",
      EVM_FACILITATOR_PAYTO_ALLOWLIST: `${RECEIVER},${PROVIDER}`,
      EVM_FACILITATOR_GAS_CAP_46630: "1000000000000000",
      EVM_FACILITATOR_GAS_CAP_421614: "2000000000000000",
      EVM_FACILITATOR_RPC_421614: "https://arb.example/KEY",
      EVM_FACILITATOR_JOURNAL: path.resolve("runtime", "evm-facilitator", "journal.ndjson"),
    });
    // Router の子: facilitator の URL（token を含む）はあるが、gas 鍵・facilitator の env は 1 つも無い（SR-H5）。
    expect(plan.childEnv["SUBETHA_EVM_FACILITATOR_URL"]).toBe(facilitator.url);
    expect(Object.keys(plan.childEnv).filter((name) => /EVM_FACILITATOR_(KEY|TOKEN|GAS_CAP|RPC|JOURNAL)/.test(name))).toEqual([]);
    expect(Object.values(plan.childEnv)).not.toContain(FAC_KEY);
    expect(JSON.stringify(plan.childEnv)).not.toContain(FAC_KEY.slice(2));
    expect(JSON.stringify(plan.config)).not.toContain(FAC_KEY.slice(2));
    // 設定の受信の facilitator も計画の URL（親の env の URL は使わない）。
    expect((plan.config as any).x402.inboundFacilitators[EVM_TESTNETS.rh.network].url).toBe(facilitator.url);
    // 送信の鍵（Router の子）と gas 鍵（facilitator の子）は別の子にだけある。
    expect(Object.values(facilitator.env)).not.toContain(goldenEnv.SUBETHA_OUTBOUND_PRIVATE_KEY);
  });

  test("親の env の SUBETHA_EVM_FACILITATOR_URL は無視する（URL は token と port から作る）。試験の port の口は URL・env・設定に同じ値で入る", () => {
    const env = { ...goldenEnv, ...facilitatorEnv, SUBETHA_EVM_FACILITATOR_URL: `http://127.0.0.1:9999/${"x".repeat(40)}` };
    const plan = hostPlanOf({ ...publicOptions(withEvm(RAILS_NONE, { rh: IN, arbsep: OFF, hyperevm: OFF })), evmFacilitatorPortForTest: 18611 }, env);
    expect(plan.facilitator!.url).toBe(`http://127.0.0.1:18611/${TOKEN}`);
    expect(plan.facilitator!.env["EVM_FACILITATOR_PORT"]).toBe("18611");
    expect(plan.childEnv["SUBETHA_EVM_FACILITATOR_URL"]).toBe(`http://127.0.0.1:18611/${TOKEN}`);
    expect(JSON.stringify(plan.config)).not.toContain("9999");
  });

  test("必須の env（gas 鍵・token・有効な chain の gas の上限・Provider の受取先）のどれが欠けても、token の形が違っても HostPlanError(evm_facilitator)（値は出さない）", () => {
    const activation = withEvm(RAILS_NONE, { rh: IN, arbsep: OFF, hyperevm: OUT });
    const codeOf = (env: Record<string, string | undefined>): string | undefined => {
      try {
        hostPlanOf(publicOptions(activation), env);
        return undefined;
      } catch (error) {
        expect(error).toBeInstanceOf(HostPlanError);
        expect((error as Error).message).not.toContain(FAC_KEY.slice(2));
        expect((error as Error).message).not.toContain(TOKEN);
        return (error as HostPlanError).code;
      }
    };
    const full = { ...goldenEnv, ...facilitatorEnv };
    expect(codeOf(full)).toBeUndefined();
    for (const name of ["SUBETHA_EVM_FACILITATOR_KEY", "SUBETHA_EVM_FACILITATOR_TOKEN", "SUBETHA_EVM_FACILITATOR_GAS_CAP_46630", "SUBETHA_EVM_FACILITATOR_GAS_CAP_998", "SUBETHA_EVM_PROVIDER_PAYTO"]) {
      expect(codeOf({ ...full, [name]: undefined }), name).toBe("evm_facilitator");
      expect(codeOf({ ...full, [name]: "" }), name).toBe("evm_facilitator");
    }
    // 無効な chain（arbsep）の上限は要らない。
    expect(codeOf({ ...full, SUBETHA_EVM_FACILITATOR_GAS_CAP_421614: undefined })).toBeUndefined();
    for (const bad of ["short", "x".repeat(31), `${"x".repeat(40)}/`, `${"x".repeat(40)}?q`, "x".repeat(257)]) {
      expect(codeOf({ ...full, SUBETHA_EVM_FACILITATOR_TOKEN: bad }), bad).toBe("evm_facilitator");
    }
  });

  test("全部無効: facilitator の計画は無く、子の env と設定は golden と byte 一致（facilitator の env・URL が親にあっても読まない）", () => {
    const expected = golden("public");
    for (const activation of [RAILS_ACTIVATION, withEvm(RAILS_ACTIVATION, { rh: OFF, arbsep: OFF, hyperevm: OFF })]) {
      const plan = hostPlanOf({ activation, bind: "127.0.0.1", port: 0, journalPath: "/tmp/golden.ndjson" }, { ...goldenEnv, ...facilitatorEnv, SUBETHA_EVM_FACILITATOR_URL: `http://127.0.0.1:8611/${TOKEN}` });
      expect(plan.facilitator).toBeUndefined();
      expect(plan).not.toHaveProperty("facilitator");
      expect(JSON.stringify(plan.childEnv)).toBe(JSON.stringify(expected.childEnv));
      expect(JSON.stringify(plan.config, null, 2)).toBe(JSON.stringify(expected.config, null, 2));
    }
  });
});

describe("facilitator の journal は公開と受け入れで同じ 1 つ（hosted 設計 §2.3・§4）", () => {
  test("公開の journal のディレクトリの evm-facilitator/journal.ndjson。受け入れの Router の journal は別、facilitator の journal は同じ", () => {
    const rails = "rh-in,rh-out,arbsep-in,arbsep-out,hyperevm-in,hyperevm-out";
    for (const extra of [{}, { SUBETHA_JOURNAL_PATH: "/app/runtime/journal.ndjson" }]) {
      const acceptance = acceptanceOptionsOf({ ...extra, SUBETHA_ACCEPTANCE_JOURNAL_PATH: "/app/runtime/acceptance/journal.ndjson" }, ["--rails", rails]);
      const env = { ...goldenEnv, ...facilitatorEnv, ...extra };
      const acceptancePlan = hostPlanOf(acceptance, env);
      const publicPlan = hostPlanOf(publicOptions(acceptance.activation), env);
      expect(acceptancePlan.journalPath).not.toBe(publicPlan.journalPath);
      expect(acceptancePlan.childEnv["ROUTER_JOURNAL_PATH"]).not.toBe(publicPlan.childEnv["ROUTER_JOURNAL_PATH"]);
      const journal = acceptancePlan.facilitator!.env["EVM_FACILITATOR_JOURNAL"];
      expect(journal).toBe(publicPlan.facilitator!.env["EVM_FACILITATOR_JOURNAL"]);
      expect(journal).toBe(evmFacilitatorJournalPathOf(env));
      expect(journal).toBe(path.join(path.dirname(publicJournalPathOf(env)), "evm-facilitator", "journal.ndjson"));
    }
    expect(evmFacilitatorJournalPathOf({ SUBETHA_JOURNAL_PATH: "/app/runtime/journal.ndjson" })).toBe("/app/runtime/evm-facilitator/journal.ndjson");
    // 受け入れの bind（コンテナの外の既定 127.0.0.1）は facilitator も同じ。公開の入口は 0.0.0.0。
    const local = acceptanceOptionsOf({ SUBETHA_ACCEPTANCE_JOURNAL_PATH: "/tmp/acc/journal.ndjson" }, ["--rails", "rh-in"]);
    expect(hostPlanOf(local, { ...goldenEnv, ...facilitatorEnv }).facilitator!.env["EVM_FACILITATOR_BIND"]).toBe("127.0.0.1");
  });
});

describe("受け入れ用の起動: --rails の新しい 6 語（hosted 設計 §8.2 の G-3）", () => {
  test("6 語の往復。EVM の語だけでも受け付ける（facilitator を計画する）。既存の語と混ぜられる。知らない語は拒む", () => {
    const all = acceptanceOptionsOf({}, ["--rails", "rh-in,rh-out,arbsep-in,arbsep-out,hyperevm-in,hyperevm-out"]);
    expect(all.activation.evm).toEqual({ rh: ON, arbsep: ON, hyperevm: ON });
    expect(activationToEnv(all.activation)).toBe("rh-in,rh-out,arbsep-in,arbsep-out,hyperevm-in,hyperevm-out");
    expect(activationFromEnv(activationToEnv(all.activation))).toEqual(all.activation);
    for (const token of ["rh-in", "rh-out", "arbsep-in", "arbsep-out", "hyperevm-in", "hyperevm-out"]) {
      const options = acceptanceOptionsOf({}, ["--rails", token]);
      expect(activationToEnv(options.activation)).toBe(token);
      const plan = hostPlanOf(options, { ...goldenEnv, ...facilitatorEnv });
      expect(plan.facilitator, token).toBeDefined();
      expect(plan.childEnv[RAILS_ACTIVATION_ENV]).toBe(token);
    }
    const mixed = acceptanceOptionsOf({}, ["--rails", "arc-in,hyperevm-out"]);
    expect(activationToEnv(mixed.activation)).toBe("arc-in,hyperevm-out");
    for (const bad of ["rh", "sepolia-in", "RH-IN", "rh-in,rh-in", "arc-to-sol"]) {
      expect(() => acceptanceOptionsOf({}, ["--rails", bad]), bad).toThrow();
    }
    // EVM の語が無ければ facilitator は計画しない（今の受け入れと同じ）。
    expect(hostPlanOf(acceptanceOptionsOf({}, ["--rails", "arc-in"]), { ...goldenEnv, ...facilitatorEnv }).facilitator).toBeUndefined();
  });
});

describe("/supported の照合（facilitatorSupportsAll）", () => {
  const url = `http://127.0.0.1:8611/${TOKEN}`;
  const answer = (status: number, body: unknown) => (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(`${url}/supported`);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  const kinds = (...networks: string[]) => ({ kinds: networks.map((network) => ({ x402Version: 2, scheme: "exact", network })), extensions: [], signers: {} });
  const networks = ["eip155:46630", "eip155:998"];

  test("有効な network が全部（v2・exact）あれば true。欠け・200 以外・形の違い・JSON でない・大きすぎる・接続の失敗は false", async () => {
    expect(await facilitatorSupportsAll(url, networks, answer(200, kinds("eip155:998", "eip155:46630", "eip155:421614")))).toBe(true);
    expect(await facilitatorSupportsAll(url, networks, answer(200, kinds("eip155:46630")))).toBe(false);
    expect(await facilitatorSupportsAll(url, networks, answer(503, kinds(...networks)))).toBe(false);
    expect(await facilitatorSupportsAll(url, networks, answer(200, { kinds: networks.map((network) => ({ x402Version: 1, scheme: "exact", network })) }))).toBe(false);
    expect(await facilitatorSupportsAll(url, networks, answer(200, { kinds: networks.map((network) => ({ x402Version: 2, scheme: "upto", network })) }))).toBe(false);
    expect(await facilitatorSupportsAll(url, networks, answer(200, { kinds: "eip155:46630,eip155:998" }))).toBe(false);
    expect(await facilitatorSupportsAll(url, networks, answer(200, "not json"))).toBe(false);
    expect(await facilitatorSupportsAll(url, networks, answer(200, { ...kinds(...networks), pad: "x".repeat(70_000) }))).toBe(false);
    expect(await facilitatorSupportsAll(url, [], answer(200, kinds(...networks)))).toBe(false);
    expect(await facilitatorSupportsAll(url, networks, (async () => { throw new TypeError("fetch failed"); }) as typeof fetch)).toBe(false);
  });
});

describe("試験の口と spawn の形（静的）", () => {
  test("本番の入口（tools/**）は facilitator の試験の口・port の口を使わない。facilitator の子は startListening（node --import tsx）で起動する", () => {
    for (const file of readdirSync("tools").filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(path.join("tools", file), "utf8");
      if (file === "remote-mcp.ts") continue;
      expect(source, file).not.toMatch(/facilitatorScriptForTest|facilitatorEnvExtraForTest|evmFacilitatorPortForTest/);
    }
    const entry = readFileSync("tools/remote-mcp.ts", "utf8");
    expect(entry).not.toMatch(/node:child_process|\.bin\/tsx|"tsx",/);
    expect(entry).toMatch(/facilitator = await spawnChild\(overrides\.facilitatorScriptForTest \?\? plan\.facilitator\.script/);
    expect(entry).toMatch(/const starting = startListening\(script, \[\], env, \{ listenTimeoutMs, signal: lifecycle\.signal \}\);/);
    const loopback = readFileSync("tests/fixtures/loopback.ts", "utf8");
    expect(loopback).toMatch(/\["--import", "tsx", path\.join\(repoRoot, script\), \.\.\.args\]/);
  });
});

describe("deploy/swap-image.sh: 新しいコンテナに -p 127.0.0.1:8611:8611（hosted 設計 §4、G-2）", () => {
  const script = readFileSync("deploy/swap-image.sh", "utf8");

  test("静的: docker run は 8787 と 8611 を host の loopback だけに publish する（ほかの publish・0.0.0.0 は無い）", () => {
    const runs = script.split("\n").filter((line) => /^mutate run run /.test(line));
    expect(runs).toHaveLength(1);
    const publishes = [...runs[0]!.matchAll(/-p (\S+)/g)].map((match) => match[1]);
    expect(publishes).toEqual(["127.0.0.1:8787:8787", "127.0.0.1:8611:8611"]);
    expect(script).not.toMatch(/-p (0\.0\.0\.0:)?8611/);
  });

  /**
   * 偽の docker・systemctl・curl・subetha-egress で入れ替えを実際に走らせる（前例の mock の harness を試験に移したもの）。root のパス（ボリューム・env ファイル・
   * egress の runner）だけを一時ディレクトリに置き換えた写しを走らせる。偽の docker はコンテナを「名前 running イメージ publish」の 1 行で持ち
   * （publish は作成時の `-p` の値。`start` は変えない = docker と同じ）、受け取った `run` の引数を残す。GNU の `stat -c` と `timeout` が要る。
   * 筋（`SCN`）: 既定 = 成功、`run_fail` = 新しいコンテナの `run` が daemon のエラー（未確定）、`new_not_running` = 新しいコンテナが起動直後に止まっている。
   */
  const hasTimeout = spawnSync("sh", ["-c", "command -v timeout"]).status === 0;
  function runSwap(scenario: string) {
    const dir = mkdtempSync(path.join(tmpdir(), "h4-swap-"));
    dirs.push(dir);
    const bin = path.join(dir, "bin");
    const st = path.join(dir, "st");
    const vol = path.join(dir, "vol");
    for (const d of [bin, path.join(st, "containers"), vol]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(st, "containers", "oldid0001"), "subetha-router true subetha-router:b-old 127.0.0.1:8787:8787\n");
    writeFileSync(path.join(st, "caddy"), "active\n");
    writeFileSync(path.join(st, "calls"), "");
    writeFileSync(path.join(vol, "journal.ndjson"), "line1\nline2\n");
    writeFileSync(path.join(dir, "env"), "");
    const tool = (name: string, body: string): void => {
      writeFileSync(path.join(bin, name), `#!/bin/bash\nST=${JSON.stringify(st)}\nSCN=${JSON.stringify(scenario)}\n${body}\n`);
      chmodSync(path.join(bin, name), 0o755);
    };
    tool("docker", `
echo "docker $*" >> "$ST/calls"
cid_of_name() { grep -l "^$1 " "$ST/containers"/* 2>/dev/null | head -1 | xargs -n1 basename 2>/dev/null; }
case "$1 $2" in "image inspect") exit 0 ;; esac
case "$1" in
  inspect) fmt=$3; ref=$4
    if [ -f "$ST/containers/$ref" ]; then id=$ref; else id=$(cid_of_name "$ref"); fi
    [ -n "$id" ] || { echo "Error: No such object: $ref" >&2; exit 1; }
    read -r name running image ports < "$ST/containers/$id"
    case "$fmt" in '{{.Id}}') echo "$id" ;; '{{.Name}}') echo "/$name" ;; '{{.State.Running}}') echo "$running" ;; esac ;;
  stop) read -r n r i p < "$ST/containers/$2"; echo "$n false $i $p" > "$ST/containers/$2"; echo "$2" ;;
  start) [ -f "$ST/containers/$2" ] || { echo "Error: No such container: $2" >&2; exit 1; }
    read -r n r i p < "$ST/containers/$2"; echo "$n true $i $p" > "$ST/containers/$2"; echo "$2" ;;
  rename) [ -z "$(cid_of_name "$3")" ] || { echo "Error: name $3 already in use" >&2; exit 1; }
    read -r n r i p < "$ST/containers/$2"; echo "$3 $r $i $p" > "$ST/containers/$2" ;;
  run) printf '%s\\n' "$@" > "$ST/run-args"
    [ "$SCN" = run_fail ] && { echo "docker: Error response from daemon: boom" >&2; exit 125; }
    name=; img=; ports=; while [ $# -gt 0 ]; do case $1 in --name) name=$2; shift;; -p) ports="$ports,$2"; shift;; esac; img=$1; shift; done
    running=true; [ "$SCN" = new_not_running ] && running=false
    echo "$name $running $img \${ports#,}" > "$ST/containers/newid0002"; echo newid0002 ;;
  logs) [ "$SCN" = new_not_running ] && { echo "could not start the Router"; exit 0; }
    printf 'subetha-router remote MCP on 0.0.0.0:8787/mcp\\nrouter: {"event":"listening","port":8788}\\n' ;;
  rm) rm -f "$ST/containers/$3" ;;
  ps) for f in "$ST/containers"/*; do read -r n r i p < "$f"; echo "$n $i running=$r"; done ;;
  *) exit 99 ;;
esac`);
    tool("systemctl", `echo "systemctl $*" >> "$ST/calls"
case "$1" in stop) echo inactive > "$ST/caddy" ;; start) echo active > "$ST/caddy" ;; is-active) [ "$(cat "$ST/caddy")" = active ] ;; esac`);
    tool("curl", `grep -q '^subetha-router true' "$ST/containers"/* 2>/dev/null || exit 7; printf '{"router":"up"}'`);
    tool("subetha-egress", "exit 0");
    // GNU の `stat -c %s <file>` だけ（macOS の stat は形が違う）。
    tool("stat", `[ "$1" = -c ] && [ "$2" = %s ] && { wc -c < "$3" | tr -d ' '; exit 0; }; exec /usr/bin/stat "$@"`);
    const copy = script
      .replace("VOL=/var/lib/subetha-router", `VOL=${vol}`)
      .replace("ENVF=/etc/subetha-router.env", `ENVF=${path.join(dir, "env")}`)
      .replace("/usr/local/sbin/subetha-egress check", "subetha-egress check");
    expect(copy).toContain(`VOL=${vol}\n`);
    expect(copy).not.toMatch(/^VOL=\/var\/lib\/|^ENVF=\/etc\/|\/usr\/local\/sbin\//m);
    writeFileSync(path.join(dir, "swap-image.sh"), copy);
    const result = spawnSync("bash", [path.join(dir, "swap-image.sh"), "subetha-router:b-new"], { env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: dir }, encoding: "utf8", timeout: 60_000 });
    const containers = Object.fromEntries(readdirSync(path.join(st, "containers")).map((id) => [id, readFileSync(path.join(st, "containers", id), "utf8").trim()]));
    const runArgs = existsSync(path.join(st, "run-args")) ? readFileSync(path.join(st, "run-args"), "utf8").trim().split("\n") : [];
    return { result, containers, runArgs, calls: readFileSync(path.join(st, "calls"), "utf8").trim().split("\n"), caddy: readFileSync(path.join(st, "caddy"), "utf8").trim(), vol, envFile: path.join(dir, "env") };
  }

  test.skipIf(!hasTimeout)("偽の docker: 成功の筋で docker run が -p 127.0.0.1:8787:8787 -p 127.0.0.1:8611:8611 を受け、入れ替えは swap ok で終わる", () => {
    const { result, runArgs, containers, vol, envFile } = runSwap("ok");
    expect(result.stdout, result.stderr).toMatch(/swap ok: subetha-router = subetha-router:b-new/);
    expect(result.status).toBe(0);
    const publishes = runArgs.flatMap((arg, index) => (arg === "-p" ? [runArgs[index + 1]] : []));
    expect(publishes).toEqual(["127.0.0.1:8787:8787", "127.0.0.1:8611:8611"]);
    expect(runArgs).toEqual(["run", "-d", "--name", "subetha-router", "--restart", "unless-stopped", "--network", "subetha-router-net", "-p", "127.0.0.1:8787:8787", "-p", "127.0.0.1:8611:8611", "-v", `${vol}:/app/runtime`, "--env-file", envFile, "subetha-router:b-new"]);
    expect(containers["newid0002"]).toBe("subetha-router true subetha-router:b-new 127.0.0.1:8787:8787,127.0.0.1:8611:8611");
    expect(containers["oldid0001"]).toMatch(/^subetha-router-prev-\S+ false subetha-router:b-old 127.0.0.1:8787:8787$/);
  }, 90_000);

  test.skipIf(!hasTimeout)("偽の docker: 復旧の筋（新しいコンテナが起動直後に止まる）→ 新しいコンテナを消し、旧コンテナを元の名前で start（作り直さない = publish は元の 8787 だけ）、入口を開け直して exit 1", () => {
    const { result, containers, calls, caddy } = runSwap("new_not_running");
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/new container is not running/);
    expect(result.stderr).toMatch(/restored: subetha-router = oldid0001, ingress reopened/);
    expect(containers).toEqual({ oldid0001: "subetha-router true subetha-router:b-old 127.0.0.1:8787:8787" });
    // run は新しいコンテナの 1 回だけ（復旧は旧コンテナを ID で戻して start する。publish を付け直さない）。
    expect(calls.filter((c) => c.startsWith("docker run "))).toHaveLength(1);
    expect(calls).toContain("docker rm -f newid0002");
    expect(calls).toContain("docker start oldid0001");
    expect(caddy).toBe("active");
  }, 90_000);

  test.skipIf(!hasTimeout)("偽の docker: 復旧の筋（新しいコンテナの run が daemon のエラー = 未確定）→ 旧コンテナを元の名前・元の 8787 だけで戻し、状態不明（exit 2）と報告する", () => {
    const { result, containers, calls, caddy } = runSwap("run_fail");
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/docker run failed \(rc=125\): its outcome is unconfirmed/);
    expect(result.stderr).toMatch(/previous container answers \/healthz as subetha-router/);
    expect(result.stderr).toMatch(/STATE UNKNOWN/);
    expect(containers).toEqual({ oldid0001: "subetha-router true subetha-router:b-old 127.0.0.1:8787:8787" });
    expect(calls.filter((c) => c.startsWith("docker run "))).toHaveLength(1);
    expect(calls).toContain("docker start oldid0001");
    expect(caddy).toBe("active");
  }, 90_000);
});
