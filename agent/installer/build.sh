#!/bin/bash
# TECHI Agent v2.0 MSI Builder (macOS / Linux cross-compile)
# Kërkon: Go 1.21+    →  https://go.dev/dl/
#          WiX v4 via dotnet tool:
#            dotnet tool install --global wix
#            wix extension add WixToolset.Util.wixext
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(dirname "$SCRIPT_DIR")"
VERSION="${1:-$(cat "$AGENT_DIR/VERSION" 2>/dev/null)}"
if [ -z "$VERSION" ]; then
  echo "ERROR: nuk u gjet version. Kaloje si argument ose vendose ne agent/VERSION." >&2
  exit 1
fi
OUTPUT="TECHI-Endpoint-Deployment-${VERSION}.msi"

echo "[1/3] Cross-compiling techi-agent.exe (Windows/amd64) v$VERSION..."
cd "$AGENT_DIR"
GOOS=windows GOARCH=amd64 go build -ldflags="-s -w -X main.AgentVersion=$VERSION" -o "$SCRIPT_DIR/techi-agent.exe" .
echo "      techi-agent.exe built: $(du -h "$SCRIPT_DIR/techi-agent.exe" | cut -f1)"

echo "[2/3] Building MSI with WiX v4..."
cd "$SCRIPT_DIR"
wix build installer.wxs -d "SourceDir=$SCRIPT_DIR" -d "Version=$VERSION" -o "$OUTPUT"

echo "[3/3] Done!"
echo "      MSI: $SCRIPT_DIR/$OUTPUT"
echo "      SHA256:"
sha256sum "$OUTPUT" 2>/dev/null || shasum -a 256 "$OUTPUT"

rm -f "$SCRIPT_DIR/techi-agent.exe"
