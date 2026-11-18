"""Trusted launcher: initialize Python first, then irreversibly apply Seatbelt.

Applying a deny-default profile before dyld boots can fail on newer macOS.
No generated Python is evaluated until sandbox_init has returned success.
"""
import ctypes
import json
import os
import resource
import sys

request = json.load(sys.stdin)
sys.stdin.close()
code = request.pop("code")
profile = request.pop("profile")
resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
os.closerange(3, 256)
sandbox = ctypes.CDLL("/usr/lib/libsandbox.dylib")
sandbox.sandbox_init.argtypes = [ctypes.c_char_p, ctypes.c_uint64, ctypes.POINTER(ctypes.c_char_p)]
sandbox.sandbox_init.restype = ctypes.c_int
error = ctypes.c_char_p()
if sandbox.sandbox_init(profile.encode(), 0, ctypes.byref(error)) != 0:
    sys.stderr.write("Local execution sandbox could not be applied.\n")
    sys.exit(78)
# Emit before generated code, and only after the real OS profile was installed.
sys.stdout.write("BOUJOY_SANDBOX_READY\n")
sys.stdout.flush()
namespace = {"__name__": "__main__", "__file__": "<task-python>",
             "INPUTS": request["inputs"], "OUTPUTS": request["outputs"]}
del request, profile, sandbox, error
exec(compile(code, "<task-python>", "exec"), namespace, namespace)
