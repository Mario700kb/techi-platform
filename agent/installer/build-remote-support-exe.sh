#!/bin/bash
# TECHI Remote Support standalone EXE builder. The EXE embeds the MSI built
# from remote-support.wxs and does not introduce a second payload definition.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${1:-1.4.6}"
VERSION4="${VERSION}.0"
MSI="$SCRIPT_DIR/TECHI-Remote-Support-${VERSION}.msi"
OUTPUT="TECHI-Remote-Support-${VERSION}.exe"

if [ ! -f "$MSI" ]; then
  "$SCRIPT_DIR/build-remote-support.sh" "$VERSION"
fi

cd "$SCRIPT_DIR"
wix build remote-support-bundle.wxs \
  -arch x64 \
  -ext WixToolset.Bal.wixext \
  -d "Version=$VERSION4" \
  -d "MsiPath=$MSI" \
  -o "$OUTPUT"

echo "Done."
echo "EXE: $SCRIPT_DIR/$OUTPUT"
echo "SHA256:"
sha256sum "$OUTPUT" 2>/dev/null || shasum -a 256 "$OUTPUT"
