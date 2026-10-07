#!/bin/bash
# 公開の Router のイメージを入れ替える（docs/DEPLOY.md §2c・§6）。root で実行。
#   sudo bash deploy/swap-image.sh subetha-router:b-<sha>
# 前提: 旧コンテナ名 subetha-router が動いている。network subetha-router-net、volume /var/lib/subetha-router、env /etc/subetha-router.env、入口は caddy。
# 方針: 検証はすべて致命（途中で失敗したら旧コンテナを ID で戻して起動し、入口を開け直す）。ログは許可した行しか出さない（鍵・URL を含み得る行は出さない）。
set -euo pipefail

IMG="${1:?usage: swap-image.sh <image:tag>}"
NAME=subetha-router
NET=subetha-router-net
VOL=/var/lib/subetha-router
ENVF=/etc/subetha-router.env
JP="$VOL/journal.ndjson"
HEALTH=http://127.0.0.1:8787/healthz
PUBLIC_HEALTH=https://router.subethalabs.com/healthz
LISTEN_WAIT_S=180         # 子の Router の起動（Solana の検査 ≤ 20 秒・Tempo の probe 3 本・replay）を待つ実時間の上限。入口の起動待ち 120 秒より長い
TS=$(date -u +%Y%m%dT%H%M%SZ)
PREV="$NAME-prev-$TS"
LOGTMP=$(mktemp)

# 進行の記録（復旧はこれに従う）。
OLD_ID=
INGRESS_CLOSED=0
NEW_ID=
DONE=0

health_ok() { curl -sf --max-time 3 "$HEALTH" 2>/dev/null | grep -q '"router":"up"'; }
allowed_log_lines() { # 許可した行だけ（子の listening の行、入口の固定文、起動失敗の固定文）。値を含み得る行は出さない。
  docker logs "$1" > "$LOGTMP" 2>&1 || true
  grep -E '"event":"listening"|remote MCP on |could not start the Router|router startup failed|is required' "$LOGTMP" | cut -c1-200 || true
}

restore() {
  local rc=$?
  [ "$DONE" = 1 ] && return 0
  echo "swap failed (rc=$rc): restoring the previous container" >&2
  # 1. 名前 $NAME を占めているのが旧コンテナでなければ消す（作りかけ・落ちた新コンテナ）。
  local holder
  holder=$(docker inspect -f '{{.Id}}' "$NAME" 2>/dev/null || true)
  if [ -n "$holder" ] && [ "$holder" != "$OLD_ID" ]; then docker rm -f "$holder" >/dev/null 2>&1 || echo "could not remove the replacement $holder" >&2; fi
  if [ -n "$NEW_ID" ] && [ "$NEW_ID" != "$holder" ]; then docker rm -f "$NEW_ID" >/dev/null 2>&1 || true; fi
  # 2. 旧コンテナ（ID）を元の名前に戻して起動する。
  if [ -n "$OLD_ID" ]; then
    local oldname
    oldname=$(docker inspect -f '{{.Name}}' "$OLD_ID" 2>/dev/null | sed 's#^/##' || true)
    if [ -n "$oldname" ] && [ "$oldname" != "$NAME" ]; then docker rename "$OLD_ID" "$NAME" || echo "could not rename $OLD_ID back to $NAME" >&2; fi
    docker start "$OLD_ID" >/dev/null 2>&1 || echo "could not start the previous container $OLD_ID" >&2
    local t=0
    while [ $t -lt 60 ]; do health_ok && break; sleep 1; t=$((t + 1)); done
    health_ok && echo "previous container is up" >&2 || echo "previous container did not answer /healthz within 60 s" >&2
  fi
  # 3. 入口を開け直す（閉じていた場合）。
  if [ "$INGRESS_CLOSED" = 1 ]; then systemctl start caddy || echo "could not start caddy" >&2; fi
  docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}' >&2 || true
  rm -f "$LOGTMP" /tmp/journal.before
  exit 1
}
trap restore ERR INT TERM

docker image inspect "$IMG" >/dev/null
OLD_ID=$(docker inspect -f '{{.Id}}' "$NAME")
[ "$(docker inspect -f '{{.State.Running}}' "$OLD_ID")" = true ]
cp "$JP" /tmp/journal.before
BYTES=$(stat -c %s /tmp/journal.before)
echo "journal bytes before: $BYTES"

systemctl stop caddy
INGRESS_CLOSED=1
if systemctl is-active --quiet caddy; then echo "caddy still active" >&2; false; fi

docker stop "$OLD_ID" >/dev/null
docker rename "$OLD_ID" "$PREV"

NEW_ID=$(docker run -d --name "$NAME" --restart unless-stopped --network "$NET" -p 127.0.0.1:8787:8787 -v "$VOL:/app/runtime" --env-file "$ENVF" "$IMG")
echo "new container: $NEW_ID"

# 子の Router の listening の行（入口の /healthz は入口の生存。Router の起動はこの行で見る）と /healthz を実時間の上限まで待つ。
START=$SECONDS
LISTENED=0
while [ $((SECONDS - START)) -lt $LISTEN_WAIT_S ]; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$NEW_ID")" != true ]; then echo "new container exited:" >&2; allowed_log_lines "$NEW_ID" >&2; false; fi
  if health_ok; then
    docker logs "$NEW_ID" > "$LOGTMP" 2>&1 || true
    if grep -q '"event":"listening"' "$LOGTMP"; then LISTENED=1; break; fi
  fi
  sleep 1
done
if [ "$LISTENED" != 1 ]; then echo "the Router child did not report listening within $LISTEN_WAIT_S s:" >&2; allowed_log_lines "$NEW_ID" >&2; false; fi

# 検証（どれも致命）。
cmp -n "$BYTES" /tmp/journal.before "$JP"
echo "journal prefix unchanged"
/usr/local/sbin/subetha-egress check
echo "egress check ok"

systemctl start caddy
INGRESS_CLOSED=0
sleep 2
curl -sf --max-time 5 "$PUBLIC_HEALTH" | grep -q '"router":"up"'
echo "public healthz ok"

DONE=1
trap - ERR INT TERM
rm -f "$LOGTMP" /tmp/journal.before
docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}'
allowed_log_lines "$NEW_ID"
echo "swap ok: $NAME = $IMG, rollback = $PREV ($OLD_ID)"
