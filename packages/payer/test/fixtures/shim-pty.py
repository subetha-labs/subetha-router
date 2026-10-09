"""Parent-only owned PTY fixture. No GUI, real consent, host process inspection or real HOME."""
import json
import os
import pty
import select
import signal
import sys
import time

node, loader, entry, ref = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, "--disable-sigusr1", "--import", loader, entry])
try:
    requests = [
        "yes\n",
        json.dumps({"jsonrpc": "2.0", "id": 91, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "owned-pty", "version": "1"}}}) + "\n",
        json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n",
        json.dumps({"jsonrpc": "2.0", "id": 92, "method": "tools/call", "params": {"name": "subetha_payer_purchase", "arguments": {"ref": ref}}}) + "\n",
    ]
    for request in requests:
        os.write(fd, request.encode())
    pending = b""
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if not select.select([fd], [], [], 0.2)[0]:
            continue
        pending += os.read(fd, 65536)
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            try:
                response = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if response.get("id") == 92 and "result" in response:
                print(json.dumps(response["result"]))
                sys.exit(0)
    raise RuntimeError("owned_pty_deadline")
finally:
    os.kill(pid, signal.SIGTERM)
    os.waitpid(pid, 0)
    os.close(fd)
