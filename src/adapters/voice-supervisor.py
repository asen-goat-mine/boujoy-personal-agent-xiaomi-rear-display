"""Lifecycle owner for a trusted local speech worker; fd 3 is host lifeline."""
import json
import os
import selectors
import shutil
import signal
import subprocess
import sys
import time

worker = None
cancelled = False


def stop(_sig=None, _frame=None):
    global cancelled
    cancelled = True
    if worker is not None:
        try:
            os.killpg(worker.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    request = json.load(sys.stdin)
    if cancelled:
        sys.exit(130)
    deadline = time.monotonic() + min(60.0, max(0.01, request["timeout"] / 1000))
    worker = subprocess.Popen(["/usr/bin/sandbox-exec", "-p", request["sandbox"],
                               request["executable"], *request["args"]],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, close_fds=True, start_new_session=True)
    worker.stdin.write(request["input"].encode())
    worker.stdin.close()
    selector = selectors.DefaultSelector()
    selector.register(3, selectors.EVENT_READ, "parent")
    selector.register(worker.stdout, selectors.EVENT_READ, "stdout")
    selector.register(worker.stderr, selectors.EVENT_READ, "stderr")
    size = 0
    while selector.get_map():
        if time.monotonic() >= deadline:
            stop()
        for key, _ in selector.select(0.05):
            chunk = os.read(key.fd, 8192)
            if key.data == "parent":
                stop()
                selector.unregister(key.fileobj)
            elif not chunk:
                selector.unregister(key.fileobj)
            else:
                size += len(chunk)
                if size > request["maxBytes"]:
                    stop()
                else:
                    try:
                        stream = sys.stdout.buffer if key.data == "stdout" else sys.stderr.buffer
                        stream.write(chunk)
                        stream.flush()
                    except BrokenPipeError:
                        stop()
        if worker.poll() is not None and all(k.data == "parent" for k in selector.get_map().values()):
            break
    code = worker.wait()
    sys.exit(130 if cancelled else code if code >= 0 else 128 - code)
finally:
    if worker is not None and worker.poll() is None:
        stop()
        worker.wait()
    if cancelled:
        scratch = os.path.realpath(os.getcwd())
        if os.path.basename(os.path.dirname(scratch)) == "voice-work":
            shutil.rmtree(scratch, ignore_errors=True)
