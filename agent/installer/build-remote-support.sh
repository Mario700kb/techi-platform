#!/bin/bash
# TECHI Remote Support MSI Builder
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${1:-1.4.7}"
VERSION4="${VERSION}.0"
OUTPUT="TECHI-Remote-Support-${VERSION}.msi"

cd "$SCRIPT_DIR"
wix build remote-support.wxs \
  -arch x64 \
  -d "SourceDir=$SCRIPT_DIR" \
  -d "Version=$VERSION4" \
  -o "$OUTPUT"

echo "Done."
echo "MSI: $SCRIPT_DIR/$OUTPUT"
echo "SHA256:"
sha256sum "$OUTPUT" 2>/dev/null || shasum -a 256 "$OUTPUT"
