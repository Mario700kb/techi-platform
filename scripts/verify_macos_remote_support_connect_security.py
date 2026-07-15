#!/usr/bin/env python3

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
launcher = (ROOT / "remote-support-macos/Launcher.swift").read_text(encoding="utf-8")
darwin = (ROOT / "remote-support-bridge/platform_darwin.go").read_text(encoding="utf-8")
protocol = (ROOT / "remote-support-bridge/protocol.go").read_text(encoding="utf-8")
builder = (ROOT / "scripts/build-macos-remote-support.sh").read_text(encoding="utf-8")
process_control = (ROOT / "remote-support-macos/PackageProcessControl.swift").read_text(encoding="utf-8")
preinstall = (ROOT / "remote-support-macos/package-scripts/preinstall").read_text(encoding="utf-8")
postinstall = (ROOT / "remote-support-macos/package-scripts/postinstall").read_text(encoding="utf-8")
combined = "\n".join((launcher, darwin, protocol, builder, process_control, preinstall, postinstall))


def fail(message: str) -> None:
    print(f"macOS Remote Support security check failed: {message}", file=sys.stderr)
    raise SystemExit(1)


required = (
    "Bundle.main.bundleURL.appendingPathComponent",
    "process.standardInput = input",
    "input.fileHandleForWriting.write(data)",
    'arguments: ["--stdin-uri"]',
    "CFBundleURLSchemes:0 string techiremotesupport",
    "CFBundleIdentifier",
    "al.techi.remote-support",
    "performPeerConfigHandoff",
    "restrictFileMode",
    "cleanupStaleHandoffs",
    "--validate-install",
    "BundleOverwriteAction",
    '"upgrade"',
    "verify-registration",
    "restore_previous_app",
    "MACOS_APP_SIGNING_IDENTITY",
    "MACOS_INSTALLER_SIGNING_IDENTITY",
)
for value in required:
    if value not in combined:
        fail(f"missing contract marker: {value}")

for forbidden in (
    "?password=",
    "&password=",
    "--password",
    "password=",
    "osascript",
    "UserDefaults",
    "SecItemAdd",
    "xattr -dr",
    "spctl --master-disable",
    "pkill",
    "killall",
):
    if forbidden.lower() in combined.lower():
        fail(f"forbidden credential or platform behavior: {forbidden}")

if re.search(r"exec\.Command\([^\n]*password", darwin, re.IGNORECASE):
    fail("password reaches macOS process command construction")
if 'exec.Command(clientPath, "--connect", remoteID)' not in darwin:
    fail("macOS client command is not the approved ID-only form")
if launcher.count("CFBundleURLSchemes") != 1 or "object(forInfoDictionaryKey:" not in launcher:
    fail("launcher may validate but must not generate URL scheme metadata")

print("macOS remote-support connect security check: PASS")
