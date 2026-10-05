#!/bin/bash
# Go back from Docker CE 28 to the Amazon Linux docker packages recorded by replace-docker.sh (docs/DEPLOY.md §8b.0).
#   bash rollback-docker.sh /root/docker-replace-<utc>              step 1: close ingress, swap packages, then REBOOT
#   bash rollback-docker.sh /root/docker-replace-<utc> --after-reboot   step 2: bring the Router back and verify
# A daemon downgrade is outside Docker's guarantees: step 2 recreates the Router from the saved image and recorded
# configuration if the old daemon does not know the container. It never starts the Router without the journal in place.
set -euo pipefail
B=${1:?recovery directory}; MODE=${2:-}
R=${R:-subetha-router}; GATE=${GATE:-caddy.service}; HEALTH=${HEALTH:-http://127.0.0.1:8787/healthz}
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
[ -f "$B/record" ] && [ -f "$B/container.json" ] && [ -s "$B/image.tar" ] || { echo "$B is not a complete recovery directory"; exit 1; }
get() { local v; v=$(sed -n "s/^$1=//p" "$B/record" | head -1); [ -n "$v" ] || { echo "no '$1' in $B/record"; exit 1; }; echo "$v"; }
CID=$(get cid); IMG=$(get image); SRC=$(get journal_dir); GATE_WAS=$(sed -n 's/^gate_was=//p' "$B/record" | head -1)
if [ "$MODE" != --after-reboot ]; then
  systemctl stop "$GATE" || true; [ "$(systemctl is-active "$GATE" || true)" != active ] || { echo "$GATE did not stop"; exit 1; }
  systemctl disable "$GATE" >/dev/null 2>&1 || true            # stays closed across the reboot; step 2 re-enables it
  if systemctl is-active docker >/dev/null 2>&1; then docker stop -t 60 "$R" >/dev/null 2>&1 || true; fi
  systemctl stop docker.socket docker containerd 2>/dev/null || true
  if rpm -q docker-ce >/dev/null 2>&1; then
    dnf versionlock delete docker-ce docker-ce-cli containerd.io >/dev/null 2>&1 || true     # only these three locks
    dnf remove -y docker-ce docker-ce-cli containerd.io > "$B/rollback-remove.log"
  fi
  rm -f /etc/yum.repos.d/docker-ce.repo
  dnf install -y "$B"/old/*.rpm > "$B/rollback-install.log"
  [ "$(rpm -q docker)" = "$(get old_docker)" ]
  systemctl enable docker >/dev/null
  echo rollback-packages > "$B/phase"; sync "$B/phase"
  echo "packages are back to $(rpm -q docker). REBOOT NOW (clears the newer daemon's network rules), then run: bash $0 $B --after-reboot"
  exit 0
fi
[ "$(sed -n 1p "$B/phase")" = rollback-packages ] || { echo "step 1 has not completed for $B"; exit 1; }
systemctl is-active docker >/dev/null || systemctl start docker
case "$(docker version --format '{{.Server.Version}}')" in 25.*) ;; *) echo "the daemon is not 25.x"; exit 1 ;; esac
[ -f "$SRC/journal.ndjson" ] || { echo "the journal is missing at $SRC: do not start the Router. The stopped-state copy is $B/journal.ndjson (it must not overwrite a newer journal)"; exit 1; }
if KNOWN=$(docker inspect "$CID" --format '{{.Id}}' 2>/dev/null) && [ "$KNOWN" = "$CID" ]; then
  docker start "$CID" >/dev/null; TARGET=$CID
else
  docker image inspect "$IMG" >/dev/null 2>&1 || docker load -i "$B/image.tar" >/dev/null
  [ "$(docker image inspect "$IMG" --format '{{.Id}}')" = "$IMG" ]
  ! docker inspect "$R" >/dev/null 2>&1 || { echo "a different container named $R exists: inspect it by hand"; exit 1; }
  # Rebuild the `docker run` arguments from the recorded configuration (NUL-separated: values may contain spaces).
  (umask 077; python3 - "$B/container.json" "$B/recreate.env" "$B/recreate.args" <<'PY'
import json,sys
c=json.load(open(sys.argv[1]))[0]; hc=c["HostConfig"]; cfg=c["Config"]
open(sys.argv[2],"w").write("".join(e+"\n" for e in cfg["Env"]))
args=["--restart",hc["RestartPolicy"]["Name"] or "no"]
if hc.get("Init"): args.append("--init")
if hc["NetworkMode"] not in ("default","bridge"): args+=["--network",hc["NetworkMode"]]
for port,binds in (hc.get("PortBindings") or {}).items():
    for b in binds or []:
        host=(b.get("HostIp")+":" if b.get("HostIp") else "")+b["HostPort"]
        args+=["-p",host+":"+port]
binds=hc.get("Binds") or []
for b in binds: args+=["-v",b]
for m in c.get("Mounts") or []:
    if m["Type"]=="bind" and not any(x.startswith(m["Source"]+":") for x in binds): args+=["-v",m["Source"]+":"+m["Destination"]]
h=cfg.get("Healthcheck") or {}
test=h.get("Test") or []
if test[:1]==["CMD-SHELL"]: args+=["--health-cmd",test[1]]
elif test[:1]==["CMD"]: sys.exit("exec-form healthcheck is not covered by this procedure")
for key,flag in (("Interval","--health-interval"),("Timeout","--health-timeout"),("StartPeriod","--health-start-period")):
    if h.get(key): args+=[flag,"%dms"%(h[key]//1000000)]
if h.get("Retries"): args+=["--health-retries",str(h["Retries"])]
if cfg.get("Entrypoint"):
    if len(cfg["Entrypoint"])!=1: sys.exit("multi-word entrypoint is not covered by this procedure")
    args+=["--entrypoint",cfg["Entrypoint"][0]]
args.append("--"+"image--")                     # marker: image goes here, then the command
args+=cfg.get("Cmd") or []
open(sys.argv[3],"wb").write(b"".join(a.encode()+b"\0" for a in args))
PY
  )
  mapfile -d '' -t ALL < "$B/recreate.args"
  ARGS=(); CMD=(); seen=0; for a in "${ALL[@]}"; do if [ "$a" = "--image--" ]; then seen=1; elif [ "$seen" = 0 ]; then ARGS+=("$a"); else CMD+=("$a"); fi; done
  [ "$seen" = 1 ]
  printf '%s\n' "${ARGS[@]}" | grep -qx -- "$SRC:/app/runtime" || { echo "the recorded configuration does not mount $SRC at /app/runtime"; exit 1; }
  TARGET=$(docker run -d --name "$R" --env-file "$B/recreate.env" "${ARGS[@]}" "$IMG" "${CMD[@]}")
fi
H=starting; for _ in $(seq 1 75); do H=$(docker inspect "$TARGET" --format '{{.State.Health.Status}}'); [ "$H" = healthy ] && break; sleep 2; done
[ "$H" = healthy ] || { echo "$R is '$H' after 150 s"; exit 1; }
curl -fsS -m 5 "$HEALTH" >/dev/null
docker exec "$TARGET" sh -c 'test -r /app/runtime/journal.ndjson && test -w /app/runtime/journal.ndjson'
if [ "$GATE_WAS" = active ]; then systemctl enable --now "$GATE" >/dev/null; [ "$(systemctl is-active "$GATE")" = active ]; fi
echo rollback-done > "$B/phase"
echo "rolled back to $(rpm -q docker); $R (${TARGET:0:12}) is healthy; ingress $GATE is $(systemctl is-active "$GATE" || true)"
