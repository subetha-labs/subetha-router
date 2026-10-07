#!/bin/bash
# 公開の Router のイメージを入れ替える（docs/DEPLOY.md §6）。root で実行。失敗したら旧コンテナを戻して入口を開け直す。
#   sudo bash deploy/swap-image.sh subetha-router:b-<sha>
# 前提: 旧コンテナ名 subetha-router が動いている。network subetha-router-net、volume /var/lib/subetha-router、env /etc/subetha-router.env、
# 入口は caddy。journal は入れ替えの前後で先頭バイト列が不変であること（追記だけ）。
set -euo pipefail
IMG="${1:?usage: swap-image.sh <image:tag>}"
NAME=subetha-router
NET=subetha-router-net
VOL=/var/lib/subetha-router
ENVF=/etc/subetha-router.env
JP="$VOL/journal.ndjson"
TS=$(date -u +%Y%m%dT%H%M%SZ)
PREV="$NAME-prev-$TS"
NID=
PHASE=before

restore() {
  # 入れ替えの途中で失敗: 作りかけの新コンテナを消し、旧コンテナを元の名前に戻して起動し、入口を開け直す。
  echo "swap failed in phase $PHASE: restoring $PREV as $NAME" >&2
  if [ -n "$NID" ]; then docker rm -f "$NID" >/dev/null 2>&1 || true; fi
  if docker ps -a --format '{{.Names}}' | grep -qx "$PREV"; then
    docker rename "$PREV" "$NAME" || true
    docker start "$NAME" || true
    for i in $(seq 1 60); do curl -sf http://127.0.0.1:8787/healthz 2>/dev/null | grep -q '"router":"up"' && break; sleep 1; done
  fi
  systemctl start caddy || true
  curl -sf http://127.0.0.1:8787/healthz || true; echo
  exit 1
}

docker image inspect "$IMG" >/dev/null || { echo "image missing: $IMG"; exit 1; }
[ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ] || { echo "$NAME is not running"; exit 1; }
cp "$JP" /tmp/journal.before; BYTES=$(stat -c %s /tmp/journal.before); echo "journal bytes before: $BYTES"

trap restore ERR
PHASE=ingress; systemctl stop caddy
! systemctl is-active --quiet caddy || { echo "caddy still active"; false; }
PHASE=stop; docker stop "$NAME"
docker rename "$NAME" "$PREV"
PHASE=start
NID=$(docker run -d --name "$NAME" --restart unless-stopped --network "$NET" -p 127.0.0.1:8787:8787 -v "$VOL:/app/runtime" --env-file "$ENVF" "$IMG")
echo "new container: $NID"
H=
for i in $(seq 1 150); do
  H=$(curl -sf http://127.0.0.1:8787/healthz 2>/dev/null || true)
  [[ "$H" == *'"router":"up"'* ]] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$NID")" = true ] || { echo "new container exited:"; docker logs "$NID" 2>&1 | grep -v "PRIVATE\|KEY" | tail -20; false; }
  sleep 1
done
[[ "$H" == *'"router":"up"'* ]] || { echo "no healthz within 150 s:"; docker logs "$NID" 2>&1 | grep -v "PRIVATE\|KEY" | tail -20; false; }
# 子の Router が実際に listen した行（入口の /healthz は入口の生存で、Router の起動は起動ログの行で見る）。
docker logs "$NID" 2>&1 | grep -q '"event":"listening"' || { echo "the Router child did not report listening:"; docker logs "$NID" 2>&1 | grep -v "PRIVATE\|KEY" | tail -20; false; }
PHASE=verify
cmp -n "$BYTES" /tmp/journal.before "$JP" && echo "journal prefix unchanged"
rm -f /tmp/journal.before
/usr/local/sbin/subetha-egress check && echo "egress check ok"
trap - ERR
systemctl start caddy
sleep 2
curl -sf https://router.subethalabs.com/healthz && echo
docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}'
docker logs "$NID" 2>&1 | grep -v "PRIVATE\|KEY" | tail -4
echo "swap ok: $NAME = $IMG, rollback = $PREV"
