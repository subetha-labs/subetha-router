"""Build-only fixed public model download. One attempt/file; bounded streaming."""
import hashlib
import json
import pathlib
import re
import sys
import time
import urllib.request


def validate(manifest):
    if manifest['repo'] != 'nvidia/diffusiongemma-26B-A4B-it-NVFP4' or manifest['revision'] != 'ec4ff3df205028f4e81c954c2227f9312b3ec2ea':
        raise ValueError('model identity')
    files = manifest['files']
    if len(files) != 14 or len({f['path'] for f in files}) != 14:
        raise ValueError('14 distinct files required')
    if not {'.gitattributes', '.quant_summary.txt', 'README.md', 'apache_2.0_license.md'} <= {f['path'] for f in files}:
        raise ValueError('hidden files/license missing')
    for f in files:
        if not re.fullmatch(r'[.A-Za-z0-9_-]+', f['path']) or f['path'] in ('.', '..', '.ready') or not re.fullmatch('[0-9a-f]{64}', f['sha256']) or type(f['size']) is not int or not 0 < f['size'] <= 11_000_000_000:
            raise ValueError('invalid file')
    return files


def download(manifest, destination, opener=urllib.request.urlopen, clock=time.monotonic):
    files = validate(manifest)
    destination = pathlib.Path(destination)
    destination.mkdir(exist_ok=False)
    end = clock() + 1500
    for f in files:
        url = 'https://huggingface.co/' + manifest['repo'] + '/resolve/' + manifest['revision'] + '/' + f['path']
        if clock() >= end:
            raise TimeoutError('model download deadline')
        digest, size = hashlib.sha256(), 0
        with opener(url, timeout=min(60, end-clock())) as response, (destination/f['path']).open('xb') as out:
            while True:
                if clock() >= end:
                    raise TimeoutError('model download deadline')
                data = response.read(min(1024*1024, f['size']-size+1))
                if not data:
                    break
                size += len(data)
                if size > f['size']:
                    raise ValueError('oversize model file')
                digest.update(data)
                out.write(data)
        if size != f['size'] or digest.hexdigest() != f['sha256']:
            raise ValueError('model file verification failed: ' + f['path'])
        (destination/f['path']).chmod(0o444)
    (destination/'.ready').write_text(hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()+'\n')
    (destination/'.ready').chmod(0o444)


if __name__ == '__main__':
    download(json.loads(pathlib.Path(sys.argv[1]).read_text()), sys.argv[2])
