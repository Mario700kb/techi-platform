#!/bin/bash
# TECHI Remote Support MSI Builder
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(cd "$SCRIPT_DIR/../../remote-support-bridge" && pwd)"
VERSION="${1:-1.4.6}"
VERSION4="${VERSION}.0"
OUTPUT="TECHI-Remote-Support-${VERSION}.msi"
BUILD_COMMIT="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo local)"

if [ ! -f "$SCRIPT_DIR/techi-remote-support-bridge.exe" ]; then
  echo "Building techi-remote-support-bridge.exe v$VERSION..."
  (cd "$BRIDGE_DIR" && GOOS=windows GOARCH=amd64 go build -ldflags="-s -w -X main.version=$VERSION" -trimpath -o "$SCRIPT_DIR/techi-remote-support-bridge.exe" .)
fi

cd "$SCRIPT_DIR"
wix build remote-support.wxs \
  -arch x64 \
  -ext WixToolset.Util.wixext \
  -d "SourceDir=$SCRIPT_DIR" \
  -d "Version=$VERSION4" \
  -d "BuildCommit=$BUILD_COMMIT" \
  -o "$OUTPUT"

echo "Done."
echo "MSI: $SCRIPT_DIR/$OUTPUT"
echo "SHA256:"
sha256sum "$OUTPUT" 2>/dev/null || shasum -a 256 "$OUTPUT"
