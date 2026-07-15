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
overlay = (ROOT / "remote-support-macos/client-overlay/secure_connect.rs.txt").read_text(encoding="utf-8")
overlay_applier = (ROOT / "scripts/apply_macos_remote_support_about_overlay.py").read_text(encoding="utf-8")
runtime_contract = "\n".join((launcher, darwin, protocol, builder, process_control, preinstall, postinstall, overlay))
combined = runtime_contract + "\n" + overlay_applier
public_handoff = "\n".join((launcher, darwin, protocol))


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
    "--techi-connect-stdin",
    "TECHI_CONNECT_ACCEPTED_V1",
    "techi-secure-connect-stdin-v1",
    "cmd.StdinPipe()",
    "credential.fill(0)",
    "TechiConnect {",
    "send_techi_connect",
    "on_techi_secure_connect",
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

for forbidden in ("?password=", "&password=", "--password", "password="):
    if forbidden.lower() in public_handoff.lower():
        fail(f"credential reaches browser/launcher/bridge handoff: {forbidden}")

if re.search(r"exec\.Command\([^\n]*(password|credential|token)", darwin, re.IGNORECASE):
    fail("password reaches macOS process command construction")
if 'exec.Command(clientPath, "--connect", remoteID, "--techi-connect-stdin")' not in darwin:
    fail("macOS client command is not the approved stdin handoff form")
if "performPeerConfigHandoff" in darwin or 'document["password"]' in darwin:
    fail("macOS bridge still persists a temporary peer credential")
if "?password=" in overlay or "get_uri_prefix" in overlay or "send_url_scheme" in overlay:
    fail("macOS client still formats the credential as a URI")
if 'print("initialLink: $initialLink")' in runtime_contract or 'received: $uri' in runtime_contract:
    fail("credential-bearing internal URI may be logged")
if launcher.count("CFBundleURLSchemes") != 1 or "object(forInfoDictionaryKey:" not in launcher:
    fail("launcher may validate but must not generate URL scheme metadata")

print("macOS remote-support connect security check: PASS")
