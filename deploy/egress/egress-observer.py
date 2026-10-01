#!/usr/bin/env python3
"""Verification aid for docs/ssrf-egress-design.md: a destination-side observer.

Listens on --port and records every accepted TCP connection and every received line (so a
plain `curl` request and a `tick` stream are both logged), prints each record to stdout, and
serves the records as JSON on --report-port (`GET /?since=<unix time>`) so the verification
runner on the Router host can *check* the evidence instead of asking a human to read a log.
Run it on the Router host (host-side observer) and on another host you control in the VPC
(external observer). It is not part of the policy.
"""
import argparse
import json
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

LOG = []
LOCK = threading.Lock()


def record(kind, addr, data=""):
    row = {"t": time.time(), "kind": kind, "src": addr[0], "sport": addr[1], "data": data}
    with LOCK:
        LOG.append(row)
    print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(row["t"])), kind, addr[0], addr[1], data, flush=True)


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


def serve_tcp(port):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", port))
    s.listen(128)
    while True:
        conn, addr = s.accept()
        record("accept", addr)
        threading.Thread(target=handle, args=(conn, addr), daemon=True).start()


class Report(BaseHTTPRequestHandler):
    def do_GET(self):
        since = float(parse_qs(urlparse(self.path).query).get("since", ["0"])[0])
        with LOCK:
            rows = [r for r in LOG if r["t"] >= since]
        body = json.dumps(rows).encode()
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
    threading.Thread(target=serve_tcp, args=(a.port,), daemon=True).start()
    print(f"egress-observer: observing :{a.port}, reporting on :{a.report_port}", flush=True)
    HTTPServer(("0.0.0.0", a.report_port), Report).serve_forever()


if __name__ == "__main__":
    sys.exit(main())
