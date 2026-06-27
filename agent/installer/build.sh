#!/bin/bash
# TECHI Agent MSI Builder (macOS / Linux cross-compile)
# Kërkon: Go 1.21+    →  https://go.dev/dl/
#          goversioninfo: go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest
#          WiX v7 via dotnet tool:
#            dotnet tool install --global wix --version 7.0.0
#            wix eula accept wix7   (kerkohet nje here per OSMF -- https://docs.firegiant.com/wix/osmf/)
#            wix extension add --global WixToolset.UI.wixext/7.0.0
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION="${1:-$(cat "$AGENT_DIR/VERSION" 2>/dev/null)}"
if [ -z "$VERSION" ]; then
  echo "ERROR: nuk u gjet version. Kaloje si argument ose vendose ne agent/VERSION." >&2
  exit 1
fi
VERSION4="${VERSION}.0"
OUTPUT="TECHI-Endpoint-Deployment-${VERSION}.msi"
BUILD_COMMIT="$(git -C "$AGENT_DIR" rev-parse --short HEAD 2>/dev/null || echo local)"
if ! git -C "$AGENT_DIR" diff --quiet 2>/dev/null || ! git -C "$AGENT_DIR" diff --cached --quiet 2>/dev/null; then
  BUILD_COMMIT="${BUILD_COMMIT}-dirty"
fi

echo "[1/5] Updating versioninfo.json + techi-agent.manifest to v$VERSION..."
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

echo "[2/5] Generating resource.syso (goversioninfo)..."
command -v goversioninfo >/dev/null 2>&1 || go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest
GOVERSIONINFO="$(command -v goversioninfo || echo "$(go env GOPATH)/bin/goversioninfo")"
"$GOVERSIONINFO" -o resource.syso versioninfo.json

echo "[3/5] Cross-compiling techi-agent.exe (Windows/amd64) v$VERSION..."
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w -X main.AgentVersion=$VERSION" -trimpath -o "$SCRIPT_DIR/techi-agent.exe" .
rm -f resource.syso

echo "[4/5] Building MSI with WiX v7 (BuildCommit=$BUILD_COMMIT)..."
cd "$SCRIPT_DIR"
wix build installer.wxs -arch x64 -ext WixToolset.UI.wixext -d "SourceDir=$SCRIPT_DIR" -d "Version=$VERSION4" -d "BuildCommit=$BUILD_COMMIT" -o "$OUTPUT"

echo "[5/5] Done!"
echo "      MSI: $SCRIPT_DIR/$OUTPUT"
echo "      SHA256:"
sha256sum "$OUTPUT" 2>/dev/null || shasum -a 256 "$OUTPUT"

rm -f "$SCRIPT_DIR/techi-agent.exe"
