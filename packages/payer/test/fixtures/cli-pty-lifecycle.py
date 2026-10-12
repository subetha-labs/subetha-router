"""Pure causal tests: every process/PTY/clock operation is an in-memory fake."""
import contextlib
import errno
import io
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name("cli-pty.py").read_text()
ADDRESS = "0x" + "a" * 40
CFG = {"node": "/synthetic/node", "bin": "/synthetic/bin", "home": "/synthetic/home",
       "passphrase": "synthetic-passphrase"}


class World:
    def __init__(self, chunks, waits):
        self.chunks, self.waits = list(chunks), list(waits)
        self.now = 0
        self.eof = self.reaped = False
        self.closed = self.killed = self.polls = 0
        self.writes = []

    def select(self, readers, _writers, _errors, timeout):
        assert readers in ([], [41])
        assert not (self.eof and readers), "selected EOF stream"
        self.now += timeout
        return (readers if self.chunks else [], [], [])

    def read(self, fd, size):
        assert fd == 41 and not self.eof
        chunk = self.chunks.pop(0)
        if chunk == "EIO":
            self.eof = True
            raise OSError(errno.EIO, "synthetic")
        if not chunk:
            self.eof = True
        return chunk

    def waitpid(self, pid, flags):
        assert pid == 314 and not self.reaped, "wait after reap"
        self.polls += 1
        exited = self.waits.pop(0) if self.waits else self.killed > 0
        if exited == "ECHILD":
            self.reaped = True
            raise ChildProcessError()
        if exited:
            self.reaped = True
            return pid, 0
        assert flags == 1, "unexpected blocking wait"
        return 0, 0

    def kill(self, pid, sig):
        assert pid == 314 and sig == 9 and not self.reaped, "kill after reap"
        self.killed += 1

    def close(self, fd):
        assert fd == 41 and self.closed == 0
        self.closed += 1

    def run(self, cfg=None):
        def forbidden(*_args):
            raise AssertionError("unexpected child exec")

        fake_os = types.SimpleNamespace(WNOHANG=1, read=self.read,
            write=lambda fd, data: self.writes.append((fd, data)),
            waitpid=self.waitpid, kill=self.kill, close=self.close,
            execve=forbidden, _exit=forbidden, waitstatus_to_exitcode=lambda status: status)
        modules = {"os": fake_os, "pty": types.SimpleNamespace(fork=lambda: (314, 41)),
                   "select": types.SimpleNamespace(select=self.select),
                   "time": types.SimpleNamespace(monotonic=lambda: self.now),
                   "signal": types.SimpleNamespace(SIGKILL=9)}
        stdout, stderr = io.StringIO(), io.StringIO()
        failure = None
        with patch.dict("sys.modules", modules), patch("sys.stdin", io.StringIO(json.dumps(CFG if cfg is None else cfg))), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                exec(compile(SOURCE, "cli-pty.py", "exec"), {"__name__": "__main__"})
            except (Exception, SystemExit) as error:
                # Never include an exception value or captured transcript in test diagnostics.
                failure = type(error).__name__
        return stdout.getvalue(), stderr.getvalue(), failure


class Lifecycle(unittest.TestCase):
    def success(self, world):
        stdout, stderr, failure = world.run()
        self.assertIsNone(failure, "helper failed in deterministic lifecycle")
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout), {"exit": 0, "prompts": 2, "addresses": [ADDRESS]})
        self.assertEqual(world.closed, 1)
        self.assertEqual(world.killed, 0)
        self.assertTrue(world.reaped)
        self.assertTrue(world.eof)
        self.assertEqual(len(world.writes), 2)
        self.assertLess(world.now, 20)

    def test_installed_launcher_is_executed_without_node_flags_or_source_entry(self):
        namespace = {"__name__": "fixture_import"}
        exec(compile(SOURCE, "cli-pty.py", "exec"), namespace)
        cfg = {"installedBin": "/owned/prefix/bin/subetha-payer", "env": {"HOME": "/owned/home", "PATH": "/owned/tools:/usr/bin:/bin"}}
        command, argv, env = namespace["launch_spec"](cfg)
        self.assertEqual(command, cfg["installedBin"])
        self.assertEqual(argv, [cfg["installedBin"], "wallet", "new"])
        self.assertEqual(env, cfg["env"])

    def test_installed_wallet_terminal_has_only_two_prompts(self):
        cfg = {**CFG, "installedBin": "/owned/bin"}
        world = World([b"Passphrase: ", b"\nRepeat passphrase: ", b"\n", b""], [False, False, True])
        stdout, stderr, failure = world.run(cfg)
        self.assertIsNone(failure)
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout), {"exit": 0, "prompts": 2, "addresses": []})
        self.assertTrue(world.reaped and world.eof)

    def test_installed_wallet_rejects_extra_terminal_output(self):
        cfg = {**CFG, "installedBin": "/owned/bin"}
        world = World([b"Passphrase: ", b"\nRepeat passphrase: ", b"\nunexpected\n", b""], [False, False, True])
        stdout, stderr, failure = world.run(cfg)
        self.assertEqual(failure, "SystemExit")
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "owned_pty_error\n")

    def test_eof_before_reap(self):
        self.success(World([b"Passphrase: ", b"Repeat passphrase: ",
                            ("\neip155 " + ADDRESS + "\n").encode(), b""],
                           [False, False, False, False, True]))

    def test_eio_before_reap(self):
        self.success(World([b"Passphrase: ", b"Repeat passphrase: ",
                            ("\neip155 " + ADDRESS + "\n").encode(), "EIO"],
                           [False, False, False, False, True]))

    def test_exit_before_final_output(self):
        self.success(World([b"Passphrase: ", b"Repeat passphrase: ",
                            ("\neip155 " + ADDRESS + "\n").encode(), b""],
                           [False, True]))

    def failure(self, world, classification):
        stdout, stderr, failure = world.run()
        self.assertEqual(failure, "SystemExit")
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, classification + "\n")
        self.assertEqual(world.closed, 1)

    def test_eof_without_exit_waits_until_actual_deadline_then_cleans_owned_child(self):
        world = World([b""], [])
        self.failure(world, "owned_pty_deadline")
        self.assertEqual(world.now, 20)
        self.assertGreater(world.polls, 2)
        self.assertEqual(world.killed, 1)
        self.assertTrue(world.reaped)

    def test_reaped_without_eof_times_out_without_killing_or_reaping_again(self):
        world = World([b"Passphrase: "], [True])
        self.failure(world, "owned_pty_deadline")
        self.assertEqual(world.now, 20)
        self.assertEqual(world.polls, 1)
        self.assertEqual(world.killed, 0)

    def test_secret_in_final_drain_fails_without_transcript(self):
        world = World([b"Passphrase: ", b"Repeat passphrase: ",
                       CFG["passphrase"].encode(), b""], [False, True])
        self.failure(world, "owned_pty_secret_leak")
        self.assertEqual(world.killed, 0)
        self.assertEqual(world.polls, 2)

    def test_lost_child_ownership_never_signals_pid(self):
        world = World([b""], ["ECHILD"])
        self.failure(world, "owned_pty_child_lost")
        self.assertEqual(world.killed, 0)
        self.assertEqual(world.polls, 1)

    def test_operator_command_drains_and_parses_without_returning_prompts(self):
        cfg = {**CFG, "args": ["inspect", "p_aaaaaaaaaaaaa"],
               "interactions": [{"prompt": "Passphrase: ", "answer": CFG["passphrase"]}],
               "secrets": [CFG["passphrase"]]}
        world = World([b"Passphrase: ", b'\n{"ok":true,"inspections":[]}\n', b""], [False, True])
        stdout, stderr, failure = world.run(cfg)
        self.assertIsNone(failure)
        self.assertEqual(stderr, "")
        self.assertEqual(json.loads(stdout), {"exit": 0, "prompts": 1, "addresses": [],
                         "outputs": [{"ok": True, "inspections": []}], "refusals": []})
        self.assertEqual(world.killed, 0)
        self.assertTrue(world.reaped and world.eof)

    def test_encoded_or_json_escaped_secret_never_leaves_helper(self):
        import base64
        secret = 'synthetic"reason\\tail'
        cfg = {**CFG, "args": ["inspect", "p_aaaaaaaaaaaaa"], "interactions": [], "secrets": [secret]}
        for value in [secret, base64.b64encode(secret.encode()).decode(), secret.encode().hex()]:
            world = World([(json.dumps({"reason": value}) + "\n").encode(), b""], [True])
            stdout, stderr, failure = world.run(cfg)
            self.assertEqual(failure, "SystemExit")
            self.assertEqual(stdout, "")
            self.assertEqual(stderr, "owned_pty_secret_leak\n")
            self.assertEqual(world.killed, 0)

    def test_unrecognized_terminal_error_never_returns_transcript(self):
        cfg = {**CFG, "args": ["lock", "reclaim"], "interactions": [], "secrets": []}
        world = World([b"unexpected arbitrary error text\n", b""], [True])
        stdout, stderr, failure = world.run(cfg)
        self.assertEqual(failure, "SystemExit")
        self.assertEqual(stdout, "")
        self.assertEqual(stderr, "owned_pty_error\n")


if __name__ == "__main__":
    unittest.main()
