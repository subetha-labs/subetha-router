#!/usr/bin/env python3
"""Verification aid for docs/ssrf-egress-design.md: a destination-side observer.

Binds the observed --port synchronously (a bind failure is fatal, so a unit or runner that
waits for the report endpoint cannot see "ready" while the observed socket is absent), records
every accepted TCP connection and every received line with a monotonic sequence number, prints
each record to stdout, and serves them on --report-port:

    GET /health             -> 200 with the session id while the observed socket is listening, else 503
    GET /?since_seq=<n>     -> {"session": "<start>-<pid>", "pid": n, "listening": bool, "seq_last": n,
                                "backlog": {"supported": bool, "value": int|null, "error": str|null},
                                "rows": [{"seq","t","kind","src","sport","data"}, ...]}

A connection is accepted and recorded under one lock (the socket is polled first, so accept()
never blocks while the lock is held); a report snapshot takes the same lock, so it can never
see a connection that was accepted but not yet recorded. `session` changes whenever the process
restarts; `seq` lets a runner reason with cursors instead of clocks. `backlog` is the kernel's
accept queue for the observed port as reported by `ss` (Linux), with the query status exposed.
Run it on the Router host (host-side observer) and on another host you control in the VPC
(external observer). It is not part of the policy.
"""
import argparse
import json
import os
import select
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

LOG = []
LOCK = threading.Lock()          # guards LOG, STATE and the accept+record critical section
STATE = {"session": "", "pid": os.getpid(), "listening": False, "port": 0, "seq": 0}


def _record_locked(kind, addr, data=""):
    STATE["seq"] += 1
    row = {"seq": STATE["seq"], "t": time.time(), "kind": kind, "src": addr[0], "sport": addr[1], "data": data}
    LOG.append(row)
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(row["t"])), row["seq"], kind, addr[0], addr[1], data, flush=True)


def record(kind, addr, data=""):
    with LOCK:
        _record_locked(kind, addr, data)


def handle(conn, addr):
    with conn:
        conn.settimeout(60)
        buf = b""
        http = False
        try:
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    text = line.decode("utf-8", "replace").rstrip("\r")
                    if text.startswith(("GET ", "HEAD ", "POST ")):
                        http = True
                    if http and text == "":
                        # end of the request headers (all recorded above): answer so curl reports a
                        # status instead of a timeout, then close
                        conn.sendall(b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                        return
                    record("line", addr, text[:200])
        except (socket.timeout, OSError):
            pass


def accept_loop(sock):
    try:
        while True:
            select.select([sock], [], [])
            with LOCK:
                conn, addr = sock.accept()   # ready, so this does not block under the lock
                _record_locked("accept", addr)
            threading.Thread(target=handle, args=(conn, addr), daemon=True).start()
    except OSError as exc:
        with LOCK:
            STATE["listening"] = False
        print(f"egress-observer: accept loop ended: {exc}", flush=True)


def backlog(port):
    """The observed port's accept queue (Recv-Q of the LISTEN socket) via `ss`, with status."""
    try:
        r = subprocess.run(["ss", "-Hltn", f"sport = :{port}"], capture_output=True, text=True, timeout=2)
    except FileNotFoundError:
        return {"supported": False, "value": None, "error": "ss not installed"}
    except Exception as exc:
        return {"supported": False, "value": None, "error": f"ss failed: {exc}"}
    if r.returncode != 0:
        return {"supported": False, "value": None, "error": f"ss exit {r.returncode}: {r.stderr.strip()[:120]}"}
    for line in r.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "LISTEN":
            try:
                return {"supported": True, "value": int(parts[1]), "error": None}
            except ValueError:
                break
    return {"supported": False, "value": None, "error": "ss output not parsed"}


class Report(BaseHTTPRequestHandler):
    def do_GET(self):
        if urlparse(self.path).path == "/health":
            with LOCK:
                ready = STATE["listening"]
            body = (STATE["session"] if ready else "not listening").encode()
            self.send_response(200 if ready else 503)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        q = parse_qs(urlparse(self.path).query)
        since_seq = int(q.get("since_seq", ["0"])[0])
        since = float(q.get("since", ["0"])[0])
        bl = backlog(STATE["port"])
        with LOCK:
            rows = [r for r in LOG if r["seq"] > since_seq and r["t"] >= since]
            body = json.dumps({"session": STATE["session"], "pid": STATE["pid"], "listening": STATE["listening"],
                               "seq_last": STATE["seq"], "backlog": bl, "rows": rows}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=19999, help="observed port (connections and lines are logged)")
    ap.add_argument("--report-port", type=int, default=19998, help="HTTP port serving the log as JSON")
    a = ap.parse_args()
    STATE["session"] = f"{int(time.time())}-{os.getpid()}"
    STATE["port"] = a.port
    sock = socket.socket()
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("0.0.0.0", a.port))
        sock.listen(128)
    except OSError as exc:
        print(f"egress-observer: cannot listen on :{a.port}: {exc}", file=sys.stderr, flush=True)
        return 1
    STATE["listening"] = True
    threading.Thread(target=accept_loop, args=(sock,), daemon=True).start()
    print(f"egress-observer: session {STATE['session']} observing :{a.port}, reporting on :{a.report_port}", flush=True)
    HTTPServer(("0.0.0.0", a.report_port), Report).serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
