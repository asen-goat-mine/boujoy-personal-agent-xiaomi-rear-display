#!/usr/bin/env python3
"""Install an isolated local speech runtime; never uploads user audio."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import venv

real_python = str(Path(sys.executable).resolve())
if sys.executable != real_python:
    os.execv(real_python, [real_python, str(Path(__file__).resolve()), *sys.argv[1:]])

DISTRIBUTION = json.loads((Path(__file__).resolve().parents[1] / 'distribution.json').read_text())
DEFAULT_DATA = Path.home() / 'Library/Application Support' / DISTRIBUTION['dataDirectoryName']

REVISION = "536b0662742c02347bc0e980a01041f333bce120"
MODEL_SHA = "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671"
parser = argparse.ArgumentParser()
parser.add_argument("--runtime", default=str(Path(os.environ.get("BOUJOY_DATA", DEFAULT_DATA))))
args = parser.parse_args()
os.umask(0o077)
root = Path(args.runtime).resolve() / "build-tools/voice"
root.mkdir(parents=True, exist_ok=True)
env = root / "venv"
venv.EnvBuilder(with_pip=False).create(env)
python = str(env / "bin/python3")
subprocess.run([sys.executable, "-m", "pip", "--python", python, "install", "--disable-pip-version-check", "faster-whisper==1.2.1"], check=True)
model = root / "faster-whisper-small"
model.mkdir(exist_ok=True)
files = {}
for name in ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"]:
    target = model / name
    if target.exists() and name == "model.bin" and hashlib.sha256(target.read_bytes()).hexdigest() != MODEL_SHA:
        raise RuntimeError("Existing model checksum differs; inspect it before replacing")
    if not target.exists():
        temporary = target.with_suffix(target.suffix + ".download")
        url = f"https://huggingface.co/Systran/faster-whisper-small/resolve/{REVISION}/{name}"
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
            output.flush()
            os.fsync(output.fileno())
        if name == "model.bin" and hashlib.sha256(temporary.read_bytes()).hexdigest() != MODEL_SHA:
            raise RuntimeError("Downloaded model checksum differs")
        temporary.replace(target)
    files[name] = {"sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "size": target.stat().st_size}
ffmpeg = shutil.which("ffmpeg")
ffprobe = shutil.which("ffprobe")
if not ffmpeg or not ffprobe:
    raise RuntimeError("This Mac needs ffmpeg and ffprobe in its product runtime")
base = subprocess.check_output([python, "-I", "-c", "import sys;print(sys.base_prefix)"], text=True).strip()
packages = subprocess.check_output([sys.executable, "-m", "pip", "--python", python, "freeze"], text=True).splitlines()
manifest = {"version": 1, "python": python, "pythonBase": base,
            "ffmpeg": str(Path(ffmpeg).resolve()), "ffprobe": str(Path(ffprobe).resolve()),
            "model": str(model), "modelRevision": REVISION,
            "modelFiles": files, "packages": packages, "localOnly": True}
temporary = root / "runtime.json.tmp"
temporary.write_text(json.dumps(manifest, indent=2) + "\n")
temporary.replace(root / "runtime.json")
print(json.dumps({"ready": True, "runtime": str(root), "modelRevision": REVISION, "modelSha256": MODEL_SHA}))
