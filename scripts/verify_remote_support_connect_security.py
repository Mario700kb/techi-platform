#!/usr/bin/env python3
"""Fail CI if secure Remote Support Connect regresses to credential-bearing launch."""

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FILES = [
    ROOT / "agent/installer/remote-support.wxs",
    ROOT / "frontend/src/services/rustdeskLaunch.ts",
    ROOT / "frontend/src/services/remoteSupportConnect.ts",
    ROOT / "backend/app/api/v1/endpoints/remote_support.py",
    ROOT / "remote-support-bridge/protocol.go",
    ROOT / "remote-support-bridge/platform_windows.go",
]


def fail(message: str) -> None:
    print(f"remote-support connect security check failed: {message}", file=sys.stderr)
    raise SystemExit(1)


combined = "\n".join(path.read_text(encoding="utf-8") for path in FILES)
if re.search(r"techiremotesupport://[^\s\"']*[?&]password=", combined, re.IGNORECASE):
    fail("password-bearing custom protocol URI found")

bridge = (ROOT / "remote-support-bridge/platform_windows.go").read_text(encoding="utf-8")
if 'exec.Command(clientPath, "--connect", remoteID, "--techi-connect-stdin")' not in bridge:
    fail("bridge client command is not the expected stdin handoff invocation")
if '"--password"' in bridge:
    fail("bridge constructs a password command-line argument")

wxs = (ROOT / "agent/installer/remote-support.wxs").read_text(encoding="utf-8")
expected_handler = (
    'Value="&quot;[REMOTESUPPORTFOLDER]techi-remote-support-bridge.exe&quot; '
    '&quot;%1&quot;"'
)
if expected_handler not in wxs:
    fail("protocol handler is not registered to the secure bridge")
if "RemoteSupportConnectBridgeExe" not in wxs:
    fail("bridge executable is not packaged")

launcher = (ROOT / "frontend/src/services/rustdeskLaunch.ts").read_text(encoding="utf-8")
if 'parsed.hostname !== "connect"' not in launcher or 'keys.length !== 1' not in launcher:
    fail("frontend does not enforce a token-only protocol URI")

print("remote-support connect security check: PASS")
