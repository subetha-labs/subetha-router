#!/bin/bash
# 公開の Router のイメージを入れ替える（docs/DEPLOY.md §2c・§6）。root で実行。
#   sudo bash deploy/swap-image.sh subetha-router:b-<sha>
# 前提: 旧コンテナ名 subetha-router が動いている。network subetha-router-net、volume /var/lib/subetha-router、env /etc/subetha-router.env、入口は caddy。
# 方針:
# - コンテナや入口を変える前に、イメージと旧コンテナの ID を確かめる（それまでの失敗は一時ファイル以外に何も変えない）
# - その後の失敗（ERR・INT・TERM）は復旧する: 名前を占めている新コンテナを消し、旧コンテナを ID で元の名前に戻して起動し、入口を開け直す
# - docker・systemctl の呼び出しには上限（timeout -k）を付ける。上限に当たった操作は daemon 側で続いている可能性があるので、復旧は
#   「不在」と「確認できない」を区別し、上限に当たった stop は完了を待ってから起動し、確認できない操作が残れば **状態不明**（exit 2）として報告する（復旧したとは言わない）
# - 検証はすべて致命。待ちは経過時間（$SECONDS）で切り、最後の要求も残りの予算に収める。ログは固定の形に正準化した断片しか出さない
set -euo pipefail

IMG="${1:?usage: swap-image.sh <image:tag>}"
NAME=subetha-router
NET=subetha-router-net
VOL=/var/lib/subetha-router
ENVF=/etc/subetha-router.env
JP="$VOL/journal.ndjson"
HEALTH=http://127.0.0.1:8787/healthz
PUBLIC_HEALTH=https://router.subethalabs.com/healthz
LISTEN_WAIT_S=180   # 子の Router の起動（Solana の検査 ≤ 20 秒・Tempo の probe ≤ 18 秒・replay）を待つ経過時間の上限。入口の起動待ち 120 秒より長い
PUBLIC_WAIT_S=30    # 入口（caddy）を開けた後、公開の /healthz が答えるまでの経過時間の上限（最後の要求もこの中に収める）
RESTORE_WAIT_S=60   # 復旧で旧コンテナの /healthz を待つ経過時間の上限
STOP_SETTLE_S=30    # 上限に当たった docker stop の完了（daemon の grace 10 秒 + kill）を復旧で待つ上限
TS=$(date -u +%Y%m%dT%H%M%SZ)
PREV="$NAME-prev-$TS"
LOGTMP=$(mktemp)
ERRTMP=$(mktemp)
JBEFORE=$(mktemp)

OLD_ID=
INGRESS_CLOSED=0
STOP_PENDING=0   # docker stop が上限に当たった（daemon 側で続いているかもしれない）
NEW_ID=
DONE=0
UNRESOLVED=0     # 復旧の中で確認できなかった操作があれば 1（最後に「状態不明」と報告する）

d() { timeout -k 5 30 docker "$@"; }
sc() { timeout -k 5 30 systemctl "$@"; }
cleanup_tmp() { rm -f "$LOGTMP" "$ERRTMP" "$JBEFORE"; }
remaining() { # <budget> <t0> <cap> → 残りの秒数（1 以上、cap 以下）
  local r=$(( $1 - (SECONDS - $2) ))
  [ "$r" -gt "$3" ] && r=$3
  [ "$r" -lt 1 ] && r=1
  echo "$r"
}

# inspect の結果を 3 値で返す: 0 = 値を stdout に出した、2 = 不在（No such object）、3 = 確認できない（timeout・その他）。
inspect_or() { # <format> <id-or-name>
  local out rc
  out=$(timeout -k 5 30 docker inspect -f "$1" "$2" 2>"$ERRTMP") && rc=0 || rc=$?
  if [ "$rc" = 0 ]; then printf '%s' "$out"; return 0; fi
  if grep -qi "no such object\|no such container" "$ERRTMP"; then return 2; fi
  return 3
}
health_ok() { # 入口の /healthz。応答は変数に取ってから見る（部分応答・転送の失敗は curl の終了状態で落ちる）。引数は上限の秒数。
  local r
  r=$(curl -sf --max-time "${1:-3}" "$HEALTH" 2>/dev/null) || return 1
  [[ "$r" == *'"router":"up"'* ]]
}
fixed_log_lines() { # 固定の形に正準化した断片だけ（形と桁に上限。それ以外は出さない）。
  d logs "$1" > "$LOGTMP" 2>&1 || { echo "(could not read the container logs)"; return 0; }
  grep -oE '"event":"listening","port":[0-9]{1,5}' "$LOGTMP" | grep -oE '[0-9]{1,5}$' | awk '$1 <= 65535 { print "child listening port=" $1 }' || true
  grep -oE '^subetha-router remote MCP on ([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{1,5}/mcp$' "$LOGTMP" | awk '{ print "ingress bind=" $5 }' || true
  printf 'could-not-start lines: %s\n' "$(grep -cx 'could not start the Router' "$LOGTMP" || true)"
}

restore() {
  local rc=$?
  [ "$DONE" = 1 ] && return 0
  trap - ERR INT TERM
  set +e   # 復旧は途中で止まらず、確認できなかった操作を数える
  echo "swap failed (rc=$rc): restoring the previous container" >&2
  if [ -z "$OLD_ID" ]; then
    echo "no previous container id recorded: the containers and the ingress were not changed" >&2
    cleanup_tmp; exit 1
  fi
  # 1. 名前 $NAME を占めているのが旧コンテナでなければ消す（作りかけ・落ちた新コンテナ）。
  local holder hrc
  holder=$(inspect_or '{{.Id}}' "$NAME"); hrc=$?
  if [ "$hrc" = 3 ]; then echo "could not determine who holds the name $NAME (docker did not answer)" >&2; UNRESOLVED=1; holder=; fi
  if [ -n "$holder" ] && [ "$holder" != "$OLD_ID" ]; then
    d rm -f "$holder" >/dev/null 2>&1 || { echo "could not remove the replacement $holder (port 8787 may stay taken)" >&2; UNRESOLVED=1; }
  fi
  if [ -n "$NEW_ID" ] && [ "$NEW_ID" != "$holder" ]; then
    d rm -f "$NEW_ID" >/dev/null 2>&1 || { echo "could not remove the replacement $NEW_ID" >&2; UNRESOLVED=1; }
  fi
  # 2. 旧コンテナ（ID）を元の名前に戻して起動する（名前の照合に失敗しても起動は試みる: 動いていれば何も起きない）。
  local oldname orc
  oldname=$(inspect_or '{{.Name}}' "$OLD_ID"); orc=$?
  if [ "$orc" = 2 ]; then
    echo "the previous container $OLD_ID no longer exists" >&2; UNRESOLVED=1
  else
    [ "$orc" = 3 ] && { echo "could not read the previous container's name (docker did not answer)" >&2; UNRESOLVED=1; }
    oldname=${oldname#/}
    if [ "$oldname" != "$NAME" ]; then d rename "$OLD_ID" "$NAME" || { echo "could not rename $OLD_ID back to $NAME" >&2; UNRESOLVED=1; }; fi
    if [ "$STOP_PENDING" = 1 ]; then
      # 上限に当たった stop は daemon 側で続いているかもしれない。完了（Running=false）を見てから起動する。見えなければ、起動しても後から止められうる → 状態不明。
      local t0=$SECONDS settled=0 st
      while [ $((SECONDS - t0)) -lt $STOP_SETTLE_S ]; do
        st=$(inspect_or '{{.State.Running}}' "$OLD_ID") && [ "$st" = false ] && { settled=1; break; }
        sleep 1
      done
      [ "$settled" = 1 ] || { echo "the timed-out docker stop of $OLD_ID did not settle within $STOP_SETTLE_S s" >&2; UNRESOLVED=1; }
    fi
    d start "$OLD_ID" >/dev/null 2>&1 || { echo "could not start the previous container $OLD_ID" >&2; UNRESOLVED=1; }
    local t0=$SECONDS hok=0
    while [ $((SECONDS - t0)) -lt $RESTORE_WAIT_S ]; do
      if health_ok "$(remaining $RESTORE_WAIT_S "$t0" 3)"; then hok=1; break; fi
      sleep 1
    done
    local now nrc
    now=$(inspect_or '{{.Id}}' "$NAME"); nrc=$?
    if [ "$hok" = 1 ] && [ "$nrc" = 0 ] && [ "$now" = "$OLD_ID" ]; then
      echo "previous container answers /healthz as $NAME" >&2
    else
      echo "previous container did not answer /healthz under its name within $RESTORE_WAIT_S s (or its identity could not be read)" >&2; UNRESOLVED=1
    fi
  fi
  # 3. 入口を開け直す（閉じに掛かっていた場合）。
  if [ "$INGRESS_CLOSED" = 1 ]; then
    sc start caddy || { echo "could not start caddy (or it did not return in time)" >&2; UNRESOLVED=1; }
    timeout -k 5 10 systemctl is-active --quiet caddy || { echo "caddy is not active (or could not be queried)" >&2; UNRESOLVED=1; }
  fi
  d ps -a --format '{{.Names}} {{.Image}} {{.Status}}' >&2 || echo "could not list containers (docker did not answer)" >&2
  cleanup_tmp
  if [ "$UNRESOLVED" = 1 ]; then
    echo "STATE UNKNOWN: at least one recovery step could not be confirmed. Check 'docker ps -a', 'systemctl is-active caddy' and /healthz by hand; a timed-out docker operation may still complete." >&2
    exit 2
  fi
  echo "restored: $NAME = $OLD_ID, ingress reopened" >&2
  exit 1
}

# ---- 事前確認（ここまではコンテナと入口を変えない）
d image inspect "$IMG" >/dev/null
OLD_ID=$(d inspect -f '{{.Id}}' "$NAME")
[ -n "$OLD_ID" ]
[ "$(d inspect -f '{{.State.Running}}' "$OLD_ID")" = true ]
cp "$JP" "$JBEFORE"
BYTES=$(stat -c %s "$JBEFORE")
echo "journal bytes before: $BYTES"

# ---- ここから失敗は復旧する
trap restore ERR INT TERM

INGRESS_CLOSED=1
sc stop caddy
rc=0; timeout -k 5 10 systemctl is-active --quiet caddy || rc=$?
case $rc in
  0) echo "caddy still active" >&2; false ;;
  124|137) echo "could not query caddy (systemctl did not answer)" >&2; false ;;
esac

rc=0; d stop "$OLD_ID" >/dev/null || rc=$?
case $rc in
  0) ;;
  124|137) STOP_PENDING=1; echo "docker stop did not return in time" >&2; false ;;
  *) echo "docker stop failed (rc=$rc)" >&2; false ;;
esac
d rename "$OLD_ID" "$PREV"

NEW_ID=$(d run -d --name "$NAME" --restart unless-stopped --network "$NET" -p 127.0.0.1:8787:8787 -v "$VOL:/app/runtime" --env-file "$ENVF" "$IMG")
[ -n "$NEW_ID" ]
echo "new container: $NEW_ID"

# 子の Router の listening の行（入口の /healthz は入口の生存。Router の起動はこの行で見る）を経過時間の上限まで待つ。
t0=$SECONDS
LISTENED=0
while [ $((SECONDS - t0)) -lt $LISTEN_WAIT_S ]; do
  st=$(inspect_or '{{.State.Running}}' "$NEW_ID") && src=0 || src=$?
  if [ "$src" != 0 ] || [ "$st" != true ]; then echo "new container is not running (or could not be inspected):" >&2; fixed_log_lines "$NEW_ID" >&2; false; fi
  if health_ok 3; then
    if d logs "$NEW_ID" > "$LOGTMP" 2>&1 && grep -q '"event":"listening"' "$LOGTMP"; then LISTENED=1; break; fi
  fi
  sleep 1
done
if [ "$LISTENED" != 1 ]; then echo "the Router child did not report listening within $LISTEN_WAIT_S s:" >&2; fixed_log_lines "$NEW_ID" >&2; false; fi

# 検証（どれも致命）。
cmp -n "$BYTES" "$JBEFORE" "$JP"
echo "journal prefix unchanged"
timeout -k 5 60 /usr/local/sbin/subetha-egress check
echo "egress check ok"

# 入口を開け、公開の /healthz を予算内に待つ。start が上限に当たっただけなら、準備待ちの中で見続ける（他の失敗は致命）。
rc=0; sc start caddy || rc=$?
case $rc in
  0) ;;
  124|137) echo "systemctl start caddy did not return in time; waiting for readiness" >&2 ;;
  *) echo "systemctl start caddy failed (rc=$rc)" >&2; false ;;
esac
t0=$SECONDS
PUBLIC_OK=0
while [ $((SECONDS - t0)) -lt $PUBLIC_WAIT_S ]; do
  if R=$(curl -sf --max-time "$(remaining $PUBLIC_WAIT_S "$t0" 5)" "$PUBLIC_HEALTH" 2>/dev/null) && [[ "$R" == *'"router":"up"'* ]]; then PUBLIC_OK=1; break; fi
  sleep 1
done
if [ "$PUBLIC_OK" != 1 ]; then echo "public /healthz did not answer within $PUBLIC_WAIT_S s" >&2; false; fi
INGRESS_CLOSED=0
echo "public healthz ok"

DONE=1
trap - ERR INT TERM
cleanup_tmp
d ps -a --format '{{.Names}} {{.Image}} {{.Status}}' || echo "could not list containers (docker did not answer)" >&2
fixed_log_lines "$NEW_ID"
echo "swap ok: $NAME = $IMG, rollback = $PREV ($OLD_ID)"
