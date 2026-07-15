#!/bin/bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/techi-rs-packaging-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
BASE_APP="$WORK/base/TECHI Remote Support.app"
CONTENTS="$BASE_APP/Contents"
ICONSET="$WORK/AppIcon.iconset"
OUTPUT="$WORK/output"

mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources" "$ICONSET" "$OUTPUT"
/usr/bin/swiftc -O -framework AppKit -target arm64-apple-macos12.3 \
  "$ROOT/remote-support-macos/tests/BaseClient.swift" \
  -o "$CONTENTS/MacOS/TECHI Remote Support"

/usr/bin/python3 - "$CONTENTS/Info.plist" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "wb") as handle:
    plistlib.dump(
        {
            "CFBundleDisplayName": "TECHI Remote Support",
            "CFBundleName": "TECHI Remote Support",
            "CFBundleIdentifier": "al.techi.remote-support",
            "CFBundleShortVersionString": "1.4.6",
            "CFBundleVersion": "64",
            "CFBundleExecutable": "TECHI Remote Support",
            "CFBundleIconFile": "AppIcon",
            "CFBundlePackageType": "APPL",
            "LSMinimumSystemVersion": "12.3",
        },
        handle,
    )
PY

SOURCE_ICON="$ROOT/agent/TECHI-branding-assets/mac-icon.png"
for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
            "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
            "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
  size=${spec%% *}
  name=${spec#* }
  /usr/bin/sips -z "$size" "$size" "$SOURCE_ICON" --out "$ICONSET/$name.png" >/dev/null
done
/usr/bin/iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"
/usr/bin/codesign --force --deep --sign - "$BASE_APP"

MACOS_RS_BASE_APP="$BASE_APP" \
MACOS_RS_OUTPUT_DIR="$OUTPUT" \
MACOS_RS_CREATE_DMG_SKIP_FINDER=1 \
  "$ROOT/scripts/build-macos-remote-support.sh"

"$ROOT/scripts/verify_macos_remote_support_artifacts.py" \
  --dmg "$OUTPUT/TECHI-Remote-Support-1.4.8-darwin-arm64.dmg" \
  --pkg "$OUTPUT/TECHI-Remote-Support-1.4.8-darwin-arm64.pkg"
