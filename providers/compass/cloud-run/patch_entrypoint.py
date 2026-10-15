"""Bounded transform of the parent-pinned djev entrypoint; no import side effects."""
import hashlib
import json
import pathlib
import sys


def _fail(what):
    raise ValueError('replacement count mismatch: ' + what)


def patch(source, images):
    if hashlib.sha256(source).hexdigest() != images['entrypoint_sha256']:
        raise ValueError('entrypoint hash mismatch')
    if images['compat_policy'] != 'hide':
        raise ValueError('compat policy')
    s = source.decode('utf-8')
    # Cloud Run's driver (580.126.20 observed) rejects the image's forward-compat
    # libcuda (CUDA error 803, trial 2); drop it so the platform driver is used.
    s = s.replace('export LD_LIBRARY_PATH="/usr/local/cuda-13.0/compat:', 'export LD_LIBRARY_PATH="', 1) if s.count('export LD_LIBRARY_PATH="/usr/local/cuda-13.0/compat:') == 1 else _fail('compat prefix')
    def once(old, new):
        nonlocal s
        if s.count(old) != 1:
            raise ValueError('replacement count mismatch')
        s = s.replace(old, new, 1)
    once('"host": "0.0.0.0"', '"host": "127.0.0.1"')
    once('os.environ["TEST_PAGE"] = "1"', 'os.environ["TEST_PAGE"] = "0"')
    once('S.TEST_PAGE = True', 'S.TEST_PAGE = False')
    # Runs after ALL overlay copies, before compileall and the upstream wrapper.
    # Same condition as the working VM UNWRAP (l4-startup.sh): only a file that
    # already has its own try/except is renamed; anything else is left alone.
    unwrap = '''"$PY_BIN" - <<'COMPASS_UNWRAP'
from pathlib import Path
p = Path('/opt/dgemma/structured_server.py')
s = p.read_text() if p.exists() else ''
if 'try:\\n    import pybase64 as base64' in s:
    p.write_text(s.replace('import pybase64 as base64', 'import pybase64 as _pb64; base64 = _pb64'))
    print('[compass-runtime] unwrap=applied')
else:
    print('[compass-runtime] unwrap=not-needed')
COMPASS_UNWRAP
'''
    once('"$PY_BIN" -m compileall', unwrap + '"$PY_BIN" -m compileall')
    guard = '''test ! -e /mnt/gcs/dgemma && test ! -L /mnt/gcs/dgemma
test -f /opt/model/.ready
test ! -e /dev/shm/dgemma && test ! -L /dev/shm/dgemma
ln -s /opt/model /dev/shm/dgemma
test "$(readlink -f /dev/shm/dgemma)" = /opt/model
# Diagnostics only: a missing tool or path is recorded, never fatal.
case ":${LD_LIBRARY_PATH:-}:" in *:/usr/local/nvidia/lib64:*) echo '[compass-runtime] nvidia-ld-path=present';; *) echo '[compass-runtime] nvidia-ld-path=absent';; esac
printf '[compass-runtime] driver=%s\\n' "$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null || echo unavailable)"
printf '[compass-runtime] nvidia-lib64=%s\\n' "$(readlink -f /usr/local/nvidia/lib64 2>/dev/null || echo unavailable)"
{ ldconfig -p 2>/dev/null | awk '/libcuda.so/{print "[compass-runtime]", $0}'; } || echo '[compass-runtime] ldconfig=unavailable'
'''
    once('# 1. Stage small config/tokenizer/processor files immediately', guard + '\n# 1. Stage small config/tokenizer/processor files immediately')
    return s.encode()


if __name__ == '__main__':
    source, images, output = map(pathlib.Path, sys.argv[1:])
    result = patch(source.read_bytes(), json.loads(images.read_text()))
    output.write_bytes(result)
    print(json.dumps({'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'patched_sha256': hashlib.sha256(result).hexdigest()}))
