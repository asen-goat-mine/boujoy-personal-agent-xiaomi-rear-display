"""Trusted, separate lifecycle owner; generated code runs only in the child.

fd 3 is a parent lifeline, fd 4 a result-only pipe. Neither reaches the worker.
The worker cannot signal this process or override its wall-clock supervision.
"""
import json
import os
import selectors
import shutil
import signal
import subprocess
import sys
import time

worker = None
termination = None


def cancel(_signal=None, _frame=None):
    global termination
    termination = termination or "cancelled"
    if worker is not None and worker.poll() is None:
        worker.kill()


signal.signal(signal.SIGTERM, cancel)
signal.signal(signal.SIGINT, cancel)
try:
    request = json.load(sys.stdin)
    timeout = min(10.0, max(0.001, request.pop("timeoutMs") / 1000.0))
    bootstrap = os.path.join(os.path.dirname(__file__), "python-bootstrap.py")
    # These are fixed arguments, not a model-supplied command or module path.
    worker = subprocess.Popen([sys.executable, "-I", "-B", "-S", bootstrap],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, close_fds=True)
    worker.stdin.write(json.dumps(request).encode())
    worker.stdin.close()
    del request
    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    selector.register(3, selectors.EVENT_READ, "parent")
    for name, stream in [("stdout", worker.stdout), ("stderr", worker.stderr)]:
        selector.register(stream, selectors.EVENT_READ, name)
    output_bytes = 0
    next_memory_check = 0
    while selector.get_map():
        current = time.monotonic()
        if worker.poll() is None:
            if current >= deadline:
                termination = termination or "timeout"
                worker.kill()
            elif current >= next_memory_check:
                next_memory_check = current + 0.05
                try:
                    rss = subprocess.run(["/bin/ps", "-o", "rss=", "-p", str(worker.pid)],
                                         capture_output=True, timeout=0.5, check=False)
                    if int(rss.stdout.strip() or b"0") > 256 * 1024:
                        termination = termination or "memory_limit"
                        worker.kill()
                except (ValueError, OSError, subprocess.TimeoutExpired):
                    pass
        for key, _ in selector.select(0.05):
            try:
                chunk = os.read(key.fd, 8192)
            except OSError:
                chunk = b""
            if key.data == "parent":
                # EOF on host death or one abort byte are equivalent. The
                # generated worker never inherited this descriptor.
                termination = termination or "cancelled"
                cancel()
                selector.unregister(key.fileobj)
                continue
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            permitted = chunk[:max(0, 65536 - output_bytes)]
            output_bytes += len(chunk)
            try:
                output = sys.stdout.buffer if key.data == "stdout" else sys.stderr.buffer
                output.write(permitted)
                output.flush()
            except BrokenPipeError:
                termination = termination or "cancelled"
                cancel()
            if output_bytes > 65536:
                termination = termination or "output_limit"
                cancel()
        if worker.poll() is not None and all(key.data == "parent" for key in selector.get_map().values()):
            break
    worker.wait()
    result = {"exitCode": worker.returncode, "termination": termination,
              "workerReaped": True}
    try:
        os.write(4, json.dumps(result).encode())
    except OSError:
        pass
finally:
    if worker is not None and worker.poll() is None:
        worker.kill()
        worker.wait()
    if termination == "cancelled":
        directory = os.path.realpath(os.getcwd())
        if os.path.basename(os.path.dirname(directory)) == "code-runs" and os.path.basename(directory).startswith("run-"):
            shutil.rmtree(directory, ignore_errors=True)
