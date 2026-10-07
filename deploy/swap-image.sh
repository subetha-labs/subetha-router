#!/bin/bash
# 公開の Router のイメージを入れ替える（docs/DEPLOY.md §2c・§6）。root で実行。
#   sudo bash deploy/swap-image.sh subetha-router:b-<sha>
# 前提: 旧コンテナ名 subetha-router が動いている。network subetha-router-net、volume /var/lib/subetha-router、env /etc/subetha-router.env、入口は caddy。
# 方針:
# - 破壊的な操作（入口を閉じる・旧を止める・改名する）の前に、イメージと旧コンテナの ID を確かめる。それまでに失敗しても何も触らない
# - その後の失敗（ERR・INT・TERM）は、名前を占めている新コンテナを消し、旧コンテナを ID で元の名前に戻して起動し、入口を開け直す
# - 検証はすべて致命。待ちは経過時間（$SECONDS）で切り、外部コマンドには上限を付ける
# - ログは固定の形の行しか出さない（鍵・URL を含み得る行は出さない）
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
PUBLIC_WAIT_S=30    # 入口（caddy）を開けた後、公開の /healthz が答えるまでの待ちの上限
RESTORE_WAIT_S=60   # 復旧で旧コンテナの /healthz を待つ経過時間の上限
D="timeout 30 docker"
TS=$(date -u +%Y%m%dT%H%M%SZ)
PREV="$NAME-prev-$TS"
LOGTMP=$(mktemp)

OLD_ID=
INGRESS_CLOSED=0
NEW_ID=
DONE=0

health_ok() { # 入口の /healthz（上限 3 秒）。
  local r
  r=$(curl -sf --max-time 3 "$HEALTH" 2>/dev/null || true)
  [[ "$r" == *'"router":"up"'* ]]
}
running() { # コンテナが動いているか。inspect の失敗は「動いていない」。
  local s
  s=$($D inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)
  [ "$s" = true ]
}
fixed_log_lines() { # 固定の形の行だけ（それ以外は出さない）。
  $D logs "$1" > "$LOGTMP" 2>&1 || true
  grep -oE '"event":"listening","port":[0-9]+' "$LOGTMP" | sed 's/^/child: /' || true
  grep -oE '^subetha-router remote MCP on [0-9.]+:[0-9]+/mcp' "$LOGTMP" || true
  grep -cx 'could not start the Router' "$LOGTMP" | sed 's/^/could-not-start lines: /' || true
}

restore() {
  local rc=$?
  [ "$DONE" = 1 ] && return 0
  trap - ERR INT TERM
  echo "swap failed (rc=$rc): restoring the previous container" >&2
  if [ -z "$OLD_ID" ]; then
    echo "no previous container id recorded: nothing was changed, nothing to restore" >&2
    rm -f "$LOGTMP" /tmp/journal.before; exit 1
  fi
  # 1. 名前 $NAME を占めているのが旧コンテナでなければ消す（作りかけ・落ちた新コンテナ）。
  local holder
  holder=$($D inspect -f '{{.Id}}' "$NAME" 2>/dev/null || true)
  if [ -n "$holder" ] && [ "$holder" != "$OLD_ID" ]; then
    $D rm -f "$holder" >/dev/null 2>&1 || echo "could not remove the replacement $holder (port 8787 may stay taken)" >&2
  fi
  if [ -n "$NEW_ID" ] && [ "$NEW_ID" != "$holder" ]; then $D rm -f "$NEW_ID" >/dev/null 2>&1 || true; fi
  # 2. 旧コンテナ（ID）を元の名前に戻して起動する。
  local oldname
  oldname=$($D inspect -f '{{.Name}}' "$OLD_ID" 2>/dev/null | sed 's#^/##' || true)
  if [ -z "$oldname" ]; then
    echo "the previous container $OLD_ID no longer exists" >&2
  else
    if [ "$oldname" != "$NAME" ]; then $D rename "$OLD_ID" "$NAME" || echo "could not rename $OLD_ID back to $NAME" >&2; fi
    $D start "$OLD_ID" >/dev/null 2>&1 || echo "could not start the previous container $OLD_ID" >&2
    local t0=$SECONDS
    while [ $((SECONDS - t0)) -lt $RESTORE_WAIT_S ]; do health_ok && break; sleep 1; done
    if health_ok && [ "$($D inspect -f '{{.Id}}' "$NAME" 2>/dev/null || true)" = "$OLD_ID" ]; then
      echo "previous container is up as $NAME" >&2
    else
      echo "previous container did not answer /healthz under its name within $RESTORE_WAIT_S s" >&2
    fi
  fi
  # 3. 入口を開け直す（閉じに掛かっていた場合）。
  if [ "$INGRESS_CLOSED" = 1 ]; then timeout 30 systemctl start caddy || echo "could not start caddy" >&2; fi
  $D ps -a --format '{{.Names}} {{.Image}} {{.Status}}' >&2 || true
  rm -f "$LOGTMP" /tmp/journal.before
  exit 1
}

# ---- 事前確認（ここまでは何も変えない。失敗しても旧コンテナに触らない）
$D image inspect "$IMG" >/dev/null
OLD_ID=$($D inspect -f '{{.Id}}' "$NAME")
[ -n "$OLD_ID" ]
running "$OLD_ID"
cp "$JP" /tmp/journal.before
BYTES=$(stat -c %s /tmp/journal.before)
echo "journal bytes before: $BYTES"

# ---- ここから失敗は復旧する
trap restore ERR INT TERM

INGRESS_CLOSED=1
timeout 30 systemctl stop caddy
if systemctl is-active --quiet caddy; then echo "caddy still active" >&2; false; fi

$D stop "$OLD_ID" >/dev/null
$D rename "$OLD_ID" "$PREV"

NEW_ID=$($D run -d --name "$NAME" --restart unless-stopped --network "$NET" -p 127.0.0.1:8787:8787 -v "$VOL:/app/runtime" --env-file "$ENVF" "$IMG")
[ -n "$NEW_ID" ]
echo "new container: $NEW_ID"

# 子の Router の listening の行（入口の /healthz は入口の生存。Router の起動はこの行で見る）を経過時間の上限まで待つ。
t0=$SECONDS
LISTENED=0
while [ $((SECONDS - t0)) -lt $LISTEN_WAIT_S ]; do
  if ! running "$NEW_ID"; then echo "new container is not running:" >&2; fixed_log_lines "$NEW_ID" >&2; false; fi
  if health_ok; then
    $D logs "$NEW_ID" > "$LOGTMP" 2>&1 || true
    if grep -q '"event":"listening"' "$LOGTMP"; then LISTENED=1; break; fi
  fi
  sleep 1
done
if [ "$LISTENED" != 1 ]; then echo "the Router child did not report listening within $LISTEN_WAIT_S s:" >&2; fixed_log_lines "$NEW_ID" >&2; false; fi

# 検証（どれも致命）。
cmp -n "$BYTES" /tmp/journal.before "$JP"
echo "journal prefix unchanged"
timeout 60 /usr/local/sbin/subetha-egress check
echo "egress check ok"

# 入口を開け、公開の /healthz を期限内に待つ（応答は変数に取ってから見る）。
timeout 30 systemctl start caddy
t0=$SECONDS
PUBLIC_OK=0
while [ $((SECONDS - t0)) -lt $PUBLIC_WAIT_S ]; do
  R=$(curl -sf --max-time 5 "$PUBLIC_HEALTH" 2>/dev/null || true)
  if [[ "$R" == *'"router":"up"'* ]]; then PUBLIC_OK=1; break; fi
  sleep 1
done
if [ "$PUBLIC_OK" != 1 ]; then echo "public /healthz did not answer within $PUBLIC_WAIT_S s" >&2; false; fi
INGRESS_CLOSED=0
echo "public healthz ok"

DONE=1
trap - ERR INT TERM
rm -f "$LOGTMP" /tmp/journal.before
$D ps -a --format '{{.Names}} {{.Image}} {{.Status}}'
fixed_log_lines "$NEW_ID"
echo "swap ok: $NAME = $IMG, rollback = $PREV ($OLD_ID)"
