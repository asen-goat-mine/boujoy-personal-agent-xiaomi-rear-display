#!/usr/bin/env python3
"""Prepare the pinned Phone Use client; never installs an APK or pairs a phone."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import urllib.request
import zipfile

DISTRIBUTION = json.loads((Path(__file__).resolve().parents[1] / 'distribution.json').read_text())
DEFAULT_DATA = Path.home() / 'Library/Application Support' / DISTRIBUTION['dataDirectoryName']

VERSION = '1.3.0'
RELEASE = 'https://github.com/nidhoggfgg/PhoneUse/releases/download/v1.3.0/'
CLIENT_ARCHIVE_SHA256 = '53bb193245e6ecaf183ba4234b2aebdb1e897723f877db9bf5170fb695fdc352'
CLIENT_SHA256 = 'e45c8af8d95db1801c851f75b958155eb209c8fa5d4d163de85012f809608540'
APK_SHA256 = 'a01a28e9d2c3f28f5391214e6b920033efdc5f5a203b681ddd6965e9fcde8f1e'

def download(name, digest, limit):
    request = urllib.request.Request(RELEASE + name, headers={'User-Agent': 'Boujoy-Personal-Agent-setup'})
    with urllib.request.urlopen(request, timeout=30) as response:
        value = response.read(limit + 1)
    if len(value) > limit or hashlib.sha256(value).hexdigest() != digest:
        raise RuntimeError('Official release checksum mismatch: ' + name)
    return value

def write_file(file, value):
    temporary = file.with_suffix(file.suffix + '.tmp')
    temporary.write_bytes(value)
    temporary.chmod(0o644)
    os.replace(temporary, file)

def main():
    if sys.version_info < (3, 10):
        raise RuntimeError('Python 3.10+ is required')
    if any(arg != '--include-apk' for arg in sys.argv[1:]):
        raise RuntimeError('Only --include-apk is supported')
    runtime = Path(os.environ.get('BOUJOY_DATA', DEFAULT_DATA))
    folder = runtime / 'tools' / 'phoneuse' / VERSION
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive = zipfile.ZipFile(io.BytesIO(download('phoneuse-mcp-1.3.0.zip', CLIENT_ARCHIVE_SHA256, 1_000_000)))
    client = archive.read('phoneuse-mcp/phoneuse_client.py')
    if hashlib.sha256(client).hexdigest() != CLIENT_SHA256:
        raise RuntimeError('Client checksum mismatch')
    write_file(folder / 'phoneuse_client.py', client)
    write_file(folder / 'LICENSE', archive.read('phoneuse-mcp/LICENSE'))
    if '--include-apk' in sys.argv:
        apk = folder / 'PhoneUse-1.3.0.apk'
        if not apk.exists() or hashlib.sha256(apk.read_bytes()).hexdigest() != APK_SHA256:
            write_file(apk, download(apk.name, APK_SHA256, 30_000_000))
    manifest = {'version': VERSION, 'source': RELEASE,
                'clientSha256': CLIENT_SHA256, 'apkSha256': APK_SHA256,
                'registryPath': str(runtime / 'phone' / 'phoneuse.json')}
    write_file(folder / 'release.json', (json.dumps(manifest, indent=2) + '\n').encode())
    print(json.dumps({'prepared': True, 'version': VERSION, 'client': str(folder / 'phoneuse_client.py'),
                      'apkPrepared': '--include-apk' in sys.argv, 'paired': False}, ensure_ascii=False))

if __name__ == '__main__':
    main()
