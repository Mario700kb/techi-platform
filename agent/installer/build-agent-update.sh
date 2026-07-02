#!/bin/bash
# TECHI Agent Update Bridge MSI Builder
#
# This builds an MSI that carries only techi-agent.exe and updates the
# TechiAgent service in-place. It intentionally does not uninstall or upgrade
# the older combined endpoint MSI.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION="${1:-$(cat "$AGENT_DIR/VERSION" 2>/dev/null)}"
if [ -z "$VERSION" ]; then
  echo "ERROR: nuk u gjet version. Kaloje si argument ose vendose ne agent/VERSION." >&2
  exit 1
fi
VERSION4="${VERSION}.0"
OUTPUT="TECHI-Agent-Update-${VERSION}.msi"
BUILD_COMMIT="$(git -C "$AGENT_DIR" rev-parse --short HEAD 2>/dev/null || echo local)"
if ! git -C "$AGENT_DIR" diff --quiet 2>/dev/null || ! git -C "$AGENT_DIR" diff --cached --quiet 2>/dev/null; then
  BUILD_COMMIT="${BUILD_COMMIT}-dirty"
fi

echo "[1/4] Updating Windows version metadata to v$VERSION..."
cd "$AGENT_DIR"
python3 - "$VERSION" "$VERSION4" <<'PYEOF'
import json, re, sys
version, version4 = sys.argv[1], sys.argv[2]
major, minor, patch = (version.split(".") + ["0", "0", "0"])[:3]

with open("versioninfo.json") as f:
    data = json.load(f)
data["FixedFileInfo"]["FileVersion"] = {"Major": int(major), "Minor": int(minor), "Patch": int(patch), "Build": 0}
data["FixedFileInfo"]["ProductVersion"] = {"Major": int(major), "Minor": int(minor), "Patch": int(patch), "Build": 0}
data["StringFileInfo"]["FileVersion"] = version4
data["StringFileInfo"]["ProductVersion"] = version4
with open("versioninfo.json", "w") as f:
    json.dump(data, f, indent=4)
    f.write("\n")

with open("techi-agent.manifest") as f:
    manifest = f.read()
manifest = re.sub(r'version="[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"', f'version="{version4}"', manifest)
manifest = re.sub(r"TECHI Platform Endpoint Agent [0-9]+\.[0-9]+\.[0-9]+", f"TECHI Platform Endpoint Agent {version}", manifest)
with open("techi-agent.manifest", "w") as f:
    f.write(manifest)
PYEOF

echo "[2/4] Generating resource.syso..."
command -v goversioninfo >/dev/null 2>&1 || go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest
GOVERSIONINFO="$(command -v goversioninfo || echo "$(go env GOPATH)/bin/goversioninfo")"
"$GOVERSIONINFO" -o resource.syso versioninfo.json

echo "[3/4] Cross-compiling techi-agent.exe (Windows/amd64) v$VERSION..."
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w -X main.AgentVersion=$VERSION" -trimpath -o "$SCRIPT_DIR/techi-agent.exe" .
rm -f resource.syso

echo "[4/4] Building bridge MSI with WiX v7 (BuildCommit=$BUILD_COMMIT)..."
cd "$SCRIPT_DIR"
wix build agent-update.wxs -arch x64 -d "SourceDir=$SCRIPT_DIR" -d "Version=$VERSION4" -d "AgentVersion=$VERSION" -d "BuildCommit=$BUILD_COMMIT" -o "$OUTPUT"

echo "Done."
echo "MSI: $SCRIPT_DIR/$OUTPUT"
echo "SHA256:"
sha256sum "$OUTPUT" 2>/dev/null || shasum -a 256 "$OUTPUT"

rm -f "$SCRIPT_DIR/techi-agent.exe"
