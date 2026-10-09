"""Parent-only real CLI/TTY fixture. Owned child only; no GUI or process inventory.
Input is synthetic JSON on stdin. Output is checked JSON/classification, never a transcript.
"""
import errno
import base64
import json
import os
import pty
import select
import signal
import sys
import time


class HelperFailure(Exception):
    pass


def launch_spec(cfg):
    if "installedBin" in cfg:
        # Execute the npm-installed shell launcher unchanged, not node/source/test entry.
        return cfg["installedBin"], [cfg["installedBin"], "wallet", "new"], cfg["env"]
    prefix = ["--import", cfg["loader"]] if "loader" in cfg else []
    return (cfg["node"], [cfg["node"], "--disable-sigusr1", *prefix, cfg["bin"],
                         *cfg.get("args", ["wallet", "new"])],
            {"PATH": "/usr/bin:/bin", "HOME": cfg["home"]})


def run(cfg):
    try:
        pid, fd = pty.fork()
    except OSError:
        raise HelperFailure("owned_pty_launch_error") from None
    if pid == 0:
        try:
            if "installedBin" in cfg:
                # stdout is separate from the controlling terminal/stderr prompts.
                # Parent owns this fresh file and checks exact bytes after child close.
                out = os.open(cfg["stdoutFile"], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.dup2(out, 1)
                os.close(out)
            command, args, env = launch_spec(cfg)
            os.execve(command, args, env)
        except Exception:
            # Do not print exec exceptions into the PTY transcript.
            os._exit(127)

    # This process is the sole reaper. An unreaped child retains its PID, even
    # after exit; once reaped (or ECHILD), that PID must never be signalled again.
    owned = True
    reaped = False
    eof = False
    status = None
    transcript = b""
    interactions = cfg.get("interactions", [
        {"prompt": "Passphrase: ", "answer": cfg.get("passphrase", "")},
        {"prompt": "Repeat passphrase: ", "answer": cfg.get("passphrase", "")},
    ])
    prompts = [item["prompt"].encode() for item in interactions]
    sent = 0
    deadline = time.monotonic() + 20

    def poll():
        nonlocal owned, reaped, status
        try:
            result, observed = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            owned = False
            raise HelperFailure("owned_pty_child_lost") from None
        if result == pid:
            owned = False
            reaped = True
            status = observed

    try:
        while not (eof and reaped):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise HelperFailure("owned_pty_deadline")
            # EOF is independent of waitpid. Empty select bounds the next poll
            # without reselecting a closed stream or extending the deadline.
            if select.select([] if eof else [fd], [], [], min(0.1, remaining))[0]:
                try:
                    chunk = os.read(fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                if not chunk:
                    eof = True
                else:
                    transcript += chunk
                    if len(transcript) > 1_048_576:
                        raise HelperFailure("owned_pty_error")
                    if not reaped and sent < len(prompts) and prompts[sent] in transcript:
                        os.write(fd, interactions[sent]["answer"].encode() + b"\r")
                        sent += 1
            if not reaped:
                poll()
        # Only classify after BOTH the child is reaped and the PTY is drained.
        text = transcript.decode("utf-8").replace("\r", "")
        secrets = cfg.get("secrets", [cfg.get("passphrase", "")])
        def scan(value):
            if isinstance(value, str):
                return any(needle in value for secret in secrets if secret for needle in
                           [secret, base64.b64encode(secret.encode()).decode(), secret.encode().hex()])
            if isinstance(value, list):
                return any(scan(item) for item in value)
            if isinstance(value, dict):
                return any(scan(key) or scan(item) for key, item in value.items())
            return False
        if scan(text):
            raise HelperFailure("owned_pty_secret_leak")
        if os.waitstatus_to_exitcode(status) == 127:
            raise HelperFailure("owned_pty_launch_error")
        addresses = [line for line in text.split("\n") if len(line) == 42 and line.startswith("0x")]
        result = {"exit": os.waitstatus_to_exitcode(status), "prompts": sent, "addresses": addresses}
        if "installedBin" in cfg:
            # Never return a raw terminal transcript. No extra diagnostic text is allowed.
            if text != "Passphrase: \nRepeat passphrase: \n":
                raise HelperFailure("owned_pty_error")
        if "args" in cfg:
            # Return only parsed output and fixed refusals, never the terminal transcript.
            for prompt in prompts:
                text = text.replace(prompt.decode(), "")
            outputs, refusals = [], []
            for line in text.split("\n"):
                if not line:
                    continue
                if line in ["cli_refused: daemon_already_running", "cli_refused: operator_cancelled"]:
                    refusals.append(line)
                else:
                    try:
                        outputs.append(json.loads(line))
                    except (ValueError, TypeError):
                        raise HelperFailure("owned_pty_error") from None
            if scan(outputs):
                raise HelperFailure("owned_pty_secret_leak")
            result.update(outputs=outputs, refusals=refusals)
        return result
    finally:
        primary_failure = sys.exc_info()[0] is not None
        try:
            if owned:
                poll()
                if owned:
                    os.kill(pid, signal.SIGKILL)
                    cleanup_deadline = time.monotonic() + 2
                    while owned:
                        poll()
                        if owned:
                            remaining = cleanup_deadline - time.monotonic()
                            if remaining <= 0:
                                raise HelperFailure("owned_pty_deadline")
                            select.select([], [], [], min(0.1, remaining))
        except Exception:
            if not primary_failure:
                raise
        finally:
            try:
                os.close(fd)
            except Exception:
                if not primary_failure:
                    raise


if __name__ == "__main__":
    try:
        result = run(json.load(sys.stdin))
    except HelperFailure as error:
        sys.stderr.write(str(error) + "\n")
        sys.exit(1)
    except Exception:
        sys.stderr.write("owned_pty_error\n")
        sys.exit(1)
    else:
        print(json.dumps(result))
