#!/usr/bin/env python3
"""Verification aid for docs/ssrf-egress-design.md: a destination-side observer.

Binds the observed --port synchronously (a bind failure is fatal, so a unit or runner that
waits for the report endpoint cannot see "ready" while the observed socket is absent), records
every accepted TCP connection and every received line with a monotonic sequence number, prints
each record to stdout, and serves them on --report-port:

    GET /?since_seq=<n>     -> {"session": "<start>-<pid>", "listening": bool, "seq_last": n,
                                "backlog": <pending connections or null>, "rows": [...]}
    GET /health             -> 200 with the session id while the observed socket is listening, else 503

`session` changes whenever the process restarts, so a runner can prove the observer ran
continuously across a measurement; `seq` lets it reason with cursors instead of clocks.
Run it on the Router host (host-side observer) and on another host you control in the VPC
(external observer). It is not part of the policy.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

LOG = []
LOCK = threading.Lock()
STATE = {"session": "", "listening": False, "port": 0, "seq": 0}


def record(kind, addr, data=""):
    with LOCK:
        STATE["seq"] += 1
        row = {"seq": STATE["seq"], "t": time.time(), "kind": kind, "src": addr[0], "sport": addr[1], "data": data}
        LOG.append(row)
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(row["t"])), row["seq"], kind, addr[0], addr[1], data, flush=True)


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
            conn, addr = sock.accept()
            record("accept", addr)
            threading.Thread(target=handle, args=(conn, addr), daemon=True).start()
    except OSError as exc:
        with LOCK:
            STATE["listening"] = False
        print(f"egress-observer: accept loop ended: {exc}", flush=True)


def backlog(port):
    """Connections accepted by the kernel but not yet by accept() (Linux `ss`), else None."""
    try:
        out = subprocess.run(["ss", "-Hltn", f"sport = :{port}"], capture_output=True, text=True, timeout=2).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] == "LISTEN":
                return int(parts[1])
    except Exception:
        return None
    return None


class Report(BaseHTTPRequestHandler):
    def do_GET(self):
        if urlparse(self.path).path == "/health":
            # readiness probe for units and runners: 200 only while the observed socket is listening
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
        with LOCK:
            rows = [r for r in LOG if r["seq"] > since_seq and r["t"] >= since]
            body = json.dumps({"session": STATE["session"], "listening": STATE["listening"],
                               "seq_last": STATE["seq"], "backlog": backlog(STATE["port"]), "rows": rows}).encode()
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
