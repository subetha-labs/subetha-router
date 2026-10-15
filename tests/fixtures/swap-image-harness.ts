/**
 * `deploy/swap-image.sh` を偽の docker・systemctl・curl・subetha-egress・timeout で実際に走らせる試験の harness（**製品コードではない**）。
 * もとは `tests/unit/evm-hosted-entry.test.ts` の中にあったもの（H-4）を、タスク R-0 の drain の場面と共有するために移した。
 *
 * root のパス（ボリューム・env ファイル・egress の runner）だけを一時ディレクトリに置き換えた写しを走らせる。偽の docker はコンテナを
 * 「名前 running イメージ publish」の 1 行で持ち（publish は作成時の `-p` の値。`start` は変えない = docker と同じ）、受け取った `run` の引数を残す。
 * コンテナの log は `<unix 秒>\t<行>` で持ち、`docker logs --since <unix 秒>` はその時刻以後の行だけを返す（docker と同じく境界を含む）。
 * 偽の `timeout` は引数を記録してから本物の `timeout` を実行する（上限の値を試験が確かめる）。GNU の `stat -c` と `timeout` が要る。
 *
 * 筋（`SCN`）:
 * - `ok`（既定）: 古いコンテナの stop で入口が `drain: complete` を出す。入れ替えは成功
 * - `run_fail`: 新しいコンテナの `run` が daemon のエラー（未確定）
 * - `new_not_running`: 新しいコンテナが起動直後に止まっている
 * - `drain_timeout`: stop の log が `drain: timeout`
 * - `no_drain_line`: stop の log に drain の行が無い（SIGKILL・古いイメージ）
 * - `old_drain_only`: 古い log（今回の停止より前）にだけ `drain: complete` がある
 * - `stop_bound`: stop は daemon 側で終わる（Running=false）が、外側の上限に当たった（rc 124 = 未確定）。その後の復旧で /healthz は戻る
 * - `restore_unconfirmed`: drain が時間切れで、復旧の旧コンテナの `start` が daemon のエラー（復旧を確かめられない）
 * - `stale_same_second`: 停止と同じ秒に、別の起動の id の `drain: complete <other>` だけがある
 * - `clock_back`: 時計が巻き戻った: 今回の停止の行は `--since` より前の時刻で載り、過去の別の起動の `drain: complete <prev>` が未来の時刻で残っている
 * - `no_run_line`: 古いコンテナの log に `entry run:` の行が無い（古いイメージ）
 *
 * 古いコンテナの起動の id は `OLD_RUN_ID`（log の最初に `entry run: <id>`）。stop は（筋が許せば）`drain: complete <id>` を書く。
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const hasTimeout = spawnSync("sh", ["-c", "command -v timeout"]).status === 0;
export const OLD_RUN_ID = "0123456789abcdef";
const OTHER_RUN_ID = "fedcba9876543210";

export interface SwapRun {
  readonly result: SpawnSyncReturns<string>;
  readonly containers: Record<string, string>;
  readonly runArgs: string[];
  readonly calls: string[];
  readonly caddy: string;
  readonly vol: string;
  readonly envFile: string;
}

/** `dirs` に一時ディレクトリを積む（呼び出し側が afterEach で消す）。`timeoutMs`: script の実行の上限（復旧の /healthz の待ち 60 秒を待ち切る筋は長く取る）。 */
export function runSwap(scenario: string, dirs: string[], timeoutMs = 60_000): SwapRun {
  const script = readFileSync("deploy/swap-image.sh", "utf8");
  const realTimeout = spawnSync("sh", ["-c", "command -v timeout"], { encoding: "utf8" }).stdout.trim();
  const dir = mkdtempSync(path.join(tmpdir(), "h4-swap-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  const st = path.join(dir, "st");
  const vol = path.join(dir, "vol");
  for (const d of [bin, path.join(st, "containers"), path.join(st, "logs"), vol]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(st, "containers", "oldid0001"), "subetha-router true subetha-router:b-old 127.0.0.1:8787:8787\n");
  // 古いコンテナの過去の log（今回の停止より前の時刻）。`old_drain_only` だけ、過去の停止の `drain: complete` を持つ。
  const future = Math.floor(Date.now() / 1000) + 100;
  writeFileSync(
    path.join(st, "logs", "oldid0001"),
    [
      ...(scenario === "no_run_line" ? [] : [`1000\tentry run: ${OLD_RUN_ID}`]),
      "1000\tsubetha-router remote MCP on 0.0.0.0:8787/mcp",
      ...(scenario === "old_drain_only" ? [`1001\tdrain: complete ${OLD_RUN_ID}`] : []),
      ...(scenario === "clock_back" ? [`${future}\tdrain: complete ${OTHER_RUN_ID}`] : []),
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(st, "caddy"), "active\n");
  writeFileSync(path.join(st, "calls"), "");
  writeFileSync(path.join(vol, "journal.ndjson"), "line1\nline2\n");
  writeFileSync(path.join(dir, "env"), "");
  const tool = (name: string, body: string): void => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\nST=${JSON.stringify(st)}\nSCN=${JSON.stringify(scenario)}\nRUN=${OLD_RUN_ID}\nOTHER=${OTHER_RUN_ID}\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  tool("timeout", `echo "timeout $*" >> "$ST/calls"\nexec ${JSON.stringify(realTimeout)} "$@"`);
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
  stop) shift; [ "$1" = -t ] && shift 2; id=$1
    read -r n r i p < "$ST/containers/$id"; echo "$n false $i $p" > "$ST/containers/$id"
    now=$(date -u +%s)
    case "$SCN" in
      drain_timeout|restore_unconfirmed) printf '%s\\tdrain: timeout %s\\n' "$now" "$RUN" >> "$ST/logs/$id" ;;
      no_drain_line|old_drain_only) ;;
      stale_same_second) printf '%s\\tdrain: complete %s\\n' "$now" "$OTHER" >> "$ST/logs/$id" ;;
      clock_back) printf '%s\\tdrain: complete %s\\n' "$((now - 100))" "$RUN" >> "$ST/logs/$id" ;;
      stop_bound) printf '%s\\tdrain: complete %s\\n' "$now" "$RUN" >> "$ST/logs/$id"; exit 124 ;;
      *) printf '%s\\tdrain: complete %s\\n' "$now" "$RUN" >> "$ST/logs/$id" ;;
    esac
    echo "$id" ;;
  start) [ -f "$ST/containers/$2" ] || { echo "Error: No such container: $2" >&2; exit 1; }
    [ "$SCN" = restore_unconfirmed ] && [ "$2" = oldid0001 ] && { echo "Error response from daemon: boom" >&2; exit 1; }
    read -r n r i p < "$ST/containers/$2"; echo "$n true $i $p" > "$ST/containers/$2"; echo "$2" ;;
  rename) [ -z "$(cid_of_name "$3")" ] || { echo "Error: name $3 already in use" >&2; exit 1; }
    read -r n r i p < "$ST/containers/$2"; echo "$3 $r $i $p" > "$ST/containers/$2" ;;
  run) printf '%s\\n' "$@" > "$ST/run-args"
    [ "$SCN" = run_fail ] && { echo "docker: Error response from daemon: boom" >&2; exit 125; }
    name=; img=; ports=; while [ $# -gt 0 ]; do case $1 in --name) name=$2; shift;; -p) ports="$ports,$2"; shift;; esac; img=$1; shift; done
    running=true; [ "$SCN" = new_not_running ] && running=false
    echo "$name $running $img \${ports#,}" > "$ST/containers/newid0002"
    now=$(date -u +%s)
    if [ "$SCN" = new_not_running ]; then printf '%s\\tcould not start the Router\\n' "$now" > "$ST/logs/newid0002"
    else printf '%s\\tsubetha-router remote MCP on 0.0.0.0:8787/mcp\\n%s\\trouter: {"event":"listening","port":8788}\\n' "$now" "$now" > "$ST/logs/newid0002"; fi
    echo newid0002 ;;
  logs) shift; since=0; [ "$1" = --since ] && { since=$2; shift 2; }
    [ -f "$ST/logs/$1" ] || exit 0
    while IFS=$'\\t' read -r ts line; do [ "$ts" -ge "$since" ] && printf '%s\\n' "$line"; done < "$ST/logs/$1"; exit 0 ;;
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
  if (!copy.includes(`VOL=${vol}\n`) || /^VOL=\/var\/lib\/|^ENVF=\/etc\/|\/usr\/local\/sbin\//m.test(copy)) throw new Error("the swap script copy still points at root paths");
  writeFileSync(path.join(dir, "swap-image.sh"), copy);
  const result = spawnSync("bash", [path.join(dir, "swap-image.sh"), "subetha-router:b-new"], { env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: dir }, encoding: "utf8", timeout: timeoutMs });
  const containers = Object.fromEntries(readdirSync(path.join(st, "containers")).map((id) => [id, readFileSync(path.join(st, "containers", id), "utf8").trim()]));
  const runArgs = existsSync(path.join(st, "run-args")) ? readFileSync(path.join(st, "run-args"), "utf8").trim().split("\n") : [];
  return { result, containers, runArgs, calls: readFileSync(path.join(st, "calls"), "utf8").trim().split("\n"), caddy: readFileSync(path.join(st, "caddy"), "utf8").trim(), vol, envFile: path.join(dir, "env") };
}
