#!/bin/bash
# Replace Amazon Linux 2023's docker 25.x with Docker CE 28.5.2 on the Router host (docs/DEPLOY.md §8b.0).
# Run as root: bash replace-docker.sh. Leaves a recovery directory /root/docker-replace-<utc>/ used by rollback-docker.sh.
# The ingress gate (Caddy) is closed before the Router stops and reopened only after every check passed.
set -euo pipefail
R=${R:-subetha-router}; GATE=${GATE:-caddy.service}; HEALTH=${HEALTH:-http://127.0.0.1:8787/healthz}
CE=28.5.2-1.el9; CTD=2.3.6-1.el9; WANT=28.5.2
KEYFP=060A61C51B558A7F742B77AAC52FEB6B621E9F35            # Docker's RPM signing key (docs.docker.com/engine/install/centos)
B=/root/docker-replace-$(date -u +%Y%m%dT%H%M%SZ)
PHASE=preflight; GATE_WAS=unknown
say() { echo "[$PHASE] $*"; }
phase() { PHASE=$1; echo "$1" > "$B/phase"; sync "$B/phase"; }
hex64() { [[ $1 =~ ^[0-9a-f]{64}$ ]] || { echo "not a 64-hex value: '$1'"; exit 1; }; }
on_exit() { rc=$?; [ "$rc" = 0 ] && exit 0
  echo "FAILED in phase '$PHASE' (exit $rc). Recovery directory: $B. Ingress $GATE was '$GATE_WAS' before and is now '$(systemctl is-active "$GATE" 2>/dev/null || true)'."
  case "$PHASE" in preflight) echo "Nothing was changed except the docker-ce repo file and downloaded packages." ;;
    gate-closed|stopped) echo "Docker was not replaced. Start the Router (docker start $R), check $HEALTH, then: systemctl start $GATE" ;;
    *) echo "Docker replacement started. Do not improvise: run rollback-docker.sh $B (or re-run the failed checks by hand)." ;; esac
  exit "$rc"; }
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ "$(uname -m)" = aarch64 ] || { echo "this procedure was rehearsed on aarch64 only"; exit 1; }
install -d -m 700 "$B"; trap on_exit EXIT; phase preflight

# ---- preflight: nothing here stops or changes the service
for t in docker dnf rpm curl gpg python3 sha256sum cmp df getenforce systemctl; do command -v "$t" >/dev/null || { echo "missing tool: $t"; exit 1; }; done
rpm -q docker containerd runc > "$B/packages.before"
OLD_DOCKER=$(rpm -q docker); OLD_CTD=$(rpm -q containerd); OLD_RUNC=$(rpm -q runc)
case "$OLD_DOCKER" in docker-25.*) ;; *) echo "expected Amazon's docker 25.x, found $OLD_DOCKER"; exit 1 ;; esac
CID=$(docker inspect "$R" --format '{{.Id}}'); hex64 "$CID"
IMG=$(docker inspect "$CID" --format '{{.Image}}'); hex64 "${IMG#sha256:}"
[ "$(docker inspect "$CID" --format '{{.State.Running}}')" = true ] || { echo "$R is not running"; exit 1; }
SRC=$(docker inspect "$CID" --format '{{range .Mounts}}{{if eq .Destination "/app/runtime"}}{{.Source}}{{end}}{{end}}')
[ -n "$SRC" ] && [ -f "$SRC/journal.ndjson" ] || { echo "the journal is not on a host mount at /app/runtime: migrate it first (§8b.3)"; exit 1; }
(umask 077; docker inspect "$CID" > "$B/container.json")          # contains the environment: root-only
printf 'cid=%s\nimage=%s\nimage_ref=%s\njournal_dir=%s\nold_docker=%s\nold_containerd=%s\nold_runc=%s\nselinux=%s\n' \
  "$CID" "$IMG" "$(docker inspect "$CID" --format '{{.Config.Image}}')" "$SRC" "$OLD_DOCKER" "$OLD_CTD" "$OLD_RUNC" "$(getenforce)" > "$B/record"
docker info --format 'security={{.SecurityOptions}} storage={{.Driver}}' >> "$B/record"
AVAIL=$(df --output=avail -k /root | tail -1 | tr -d ' '); [ "$AVAIL" -ge 3145728 ] || { echo "need 3 GiB free under /root, have ${AVAIL} KiB"; exit 1; }
IAVAIL=$(df --output=iavail /var/lib | tail -1 | tr -d ' '); [ "$IAVAIL" -ge 20000 ] || { echo "too few free inodes: $IAVAIL"; exit 1; }
# repository: verify the signing key's fingerprint before trusting it; fixed baseurl (AL2023's $releasever is not 9)
curl -fsS -m 30 https://download.docker.com/linux/centos/gpg -o "$B/docker.gpg"
FP=$(gpg --show-keys --with-colons "$B/docker.gpg" | awk -F: '$1=="fpr"{print $10; exit}')
[ "$FP" = "$KEYFP" ] || { echo "Docker signing key fingerprint mismatch: $FP"; exit 1; }
rpm --import "$B/docker.gpg"
cat > /etc/yum.repos.d/docker-ce.repo <<REPO
[docker-ce-stable]
name=Docker CE Stable (el9)
baseurl=https://download.docker.com/linux/centos/9/\$basearch/stable
enabled=1
gpgcheck=1
gpgkey=file://$B/docker.gpg
REPO
PKGS=("docker-ce-$CE" "docker-ce-cli-$CE" "containerd.io-$CTD")
dnf install -y --downloadonly --allowerasing --setopt=install_weak_deps=False "${PKGS[@]}" > "$B/dnf-download.log"
# keep the packages needed to go back, and a copy of the image that does not depend on /var/lib/docker
install -d -m 700 "$B/old"; (cd "$B/old" && dnf download -q "$OLD_DOCKER" "$OLD_CTD" "$OLD_RUNC")
[ "$(ls "$B/old"/*.rpm | wc -l)" = 3 ] || { echo "could not download the three packages needed for rollback"; exit 1; }
docker save "$IMG" -o "$B/image.tar"; [ -s "$B/image.tar" ]
say "preflight ok: $OLD_DOCKER -> docker-ce-$CE, container ${CID:0:12}, image ${IMG:7:12}, journal $SRC"

# ---- close the ingress, then stop the Router
GATE_WAS=$(systemctl is-active "$GATE" || true); echo "gate_was=$GATE_WAS" >> "$B/record"
systemctl stop "$GATE"; [ "$(systemctl is-active "$GATE" || true)" != active ] || { echo "$GATE did not stop"; exit 1; }
phase gate-closed
docker stop -t 60 "$CID" >/dev/null
EXITC=$(docker inspect "$CID" --format '{{.State.ExitCode}}'); OOM=$(docker inspect "$CID" --format '{{.State.OOMKilled}}')
phase stopped
# The exit code is recorded, not trusted: 137 means the 60 s timeout killed it. What decides is the journal itself
# (append-only, one JSON document per line): every line must parse, checked just below.
echo "stop_exit=$EXITC" >> "$B/record"; case "$EXITC" in 0|143) ;; *) say "warning: $R exited with $EXITC; relying on the journal validation" ;; esac
[ "$OOM" = false ] || { echo "$R was OOM-killed"; exit 1; }
python3 - "$SRC/journal.ndjson" <<'PY'
import json,sys
n=0
for line in open(sys.argv[1],encoding="utf-8"):
    if line.strip()=="": continue
    json.loads(line); n+=1
print("journal rows:",n)
PY
cp -p "$SRC/journal.ndjson" "$B/journal.ndjson"; sync "$B/journal.ndjson"; cmp "$SRC/journal.ndjson" "$B/journal.ndjson"
JSUM=$(sha256sum "$SRC/journal.ndjson" | cut -d' ' -f1); hex64 "$JSUM"; echo "journal_sha256=$JSUM" >> "$B/record"; sync "$B/record"

# ---- replace
phase replacing
dnf install -y --allowerasing --setopt=install_weak_deps=False "${PKGS[@]}" > "$B/dnf-install.log"
systemctl enable --now docker
phase replaced
[ "$(rpm -q docker-ce)" = "docker-ce-$CE.aarch64" ]; [ "$(rpm -q docker-ce-cli)" = "docker-ce-cli-$CE.aarch64" ]; [ "$(rpm -q containerd.io)" = "containerd.io-$CTD.aarch64" ]
V=$(docker version --format '{{.Server.Version}}'); [ "$V" = "$WANT" ] || { echo "server is '$V', expected $WANT"; exit 1; }
FB=$(docker info --format '{{.FirewallBackend.Driver}}'); [ "$FB" = iptables ] || { echo "firewall backend is '$FB'"; exit 1; }
LR=$(docker info --format '{{.LiveRestoreEnabled}}'); [ "$LR" = false ] || { echo "live-restore is '$LR'"; exit 1; }
NCID=$(docker inspect "$CID" --format '{{.Id}}'); [ "$NCID" = "$CID" ] || { echo "container $CID is not known to the new daemon"; exit 1; }
NIMG=$(docker inspect "$CID" --format '{{.Image}}'); [ "$NIMG" = "$IMG" ] || { echo "image changed: $NIMG"; exit 1; }
NSUM=$(sha256sum "$SRC/journal.ndjson" | cut -d' ' -f1); hex64 "$NSUM"; [ "$NSUM" = "$JSUM" ] || { echo "the journal changed during the replacement"; exit 1; }
dnf install -y 'dnf-command(versionlock)' > "$B/dnf-versionlock.log"
dnf versionlock add docker-ce docker-ce-cli containerd.io >> "$B/dnf-versionlock.log"
LOCKS=$(dnf versionlock list | grep -cE '^(docker-ce|docker-ce-cli|containerd\.io)-' || true); [ "$LOCKS" = 3 ] || { echo "expected 3 version locks, found $LOCKS"; exit 1; }

# ---- start the Router behind the closed gate, verify, then reopen
phase starting
docker start "$CID" >/dev/null
H=starting; for _ in $(seq 1 75); do H=$(docker inspect "$CID" --format '{{.State.Health.Status}}'); [ "$H" = healthy ] && break; sleep 2; done
[ "$H" = healthy ] || { echo "$R is '$H' after 150 s"; exit 1; }
curl -fsS -m 5 "$HEALTH" >/dev/null
docker exec "$CID" sh -c 'test -r /app/runtime/journal.ndjson && test -w /app/runtime/journal.ndjson'
phase verified
if [ "$GATE_WAS" = active ]; then systemctl start "$GATE"; [ "$(systemctl is-active "$GATE")" = active ]; fi
phase done
echo "docker replaced with $V; $R (${CID:0:12}) is healthy; ingress $GATE is $(systemctl is-active "$GATE" || true). Recovery directory kept: $B"
