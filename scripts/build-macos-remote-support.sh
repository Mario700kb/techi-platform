#!/bin/bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(tr -d '[:space:]' < "$ROOT/remote-support-macos/VERSION")
BASE_APP=${MACOS_RS_BASE_APP:-/Applications/TECHI Remote Support.app}
OUTPUT_DIR=${MACOS_RS_OUTPUT_DIR:-$ROOT/dist}
ARCH=${MACOS_RS_ARCH:-arm64}
APP_NAME="TECHI Remote Support.app"
ARTIFACT_NAME="TECHI-Remote-Support-${VERSION}-darwin-${ARCH}.dmg"
BUILD_COMMIT=$(git -C "$ROOT" rev-parse HEAD)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/techi-rs-macos.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

if [[ "$ARCH" != "arm64" ]]; then
  echo "Only the verified darwin-arm64 base application is supported" >&2
  exit 1
fi
if [[ ! -d "$BASE_APP" ]]; then
  echo "Base TECHI Remote Support.app not found: $BASE_APP" >&2
  exit 1
fi

PLIST="$BASE_APP/Contents/Info.plist"
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST")" != "al.techi.remote-support" ]] ||
   [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$PLIST")" != "TECHI Remote Support" ]]; then
  echo "Base application identity does not match TECHI Remote Support" >&2
  exit 1
fi
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")" != "1.4.6" ]] ||
   /usr/libexec/PlistBuddy -c 'Print :TECHIConnectBridgeVersion' "$PLIST" >/dev/null 2>&1; then
  echo "Base application must be the canonical unwrapped TECHI Remote Support 1.4.6 app" >&2
  exit 1
fi
BASE_EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST")
if ! lipo -archs "$BASE_APP/Contents/MacOS/$BASE_EXECUTABLE" | tr ' ' '\n' | grep -qx "$ARCH"; then
  echo "Base application does not contain architecture $ARCH" >&2
  exit 1
fi

mkdir -p "$WORK/image" "$OUTPUT_DIR"
ditto "$BASE_APP" "$WORK/image/$APP_NAME"
APP="$WORK/image/$APP_NAME"
APP_PLIST="$APP/Contents/Info.plist"
CLIENT="$APP/Contents/MacOS/TECHI Remote Support Client"
mv "$APP/Contents/MacOS/$BASE_EXECUTABLE" "$CLIENT"
rm -rf "$APP/Contents/_CodeSignature"
mkdir -p "$APP/Contents/Helpers"

(
  cd "$ROOT/remote-support-bridge"
  GOOS=darwin GOARCH="$ARCH" CGO_ENABLED=1 go build \
    -trimpath -ldflags="-s -w -X main.version=$VERSION" \
    -o "$APP/Contents/Helpers/techi-remote-support-bridge" .
)
swiftc -O -whole-module-optimization -framework AppKit \
  -target "${ARCH}-apple-macos12.3" \
  "$ROOT/remote-support-macos/Launcher.swift" \
  -o "$APP/Contents/MacOS/TECHI Remote Support"

/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable TECHI Remote Support" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion 65" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Set :LSMinimumSystemVersion 12.3" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Delete :NSMainNibFile" "$APP_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$APP_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleTypeRole string Viewer" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string al.techi.remote-support.connect" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string techiremotesupport" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :TECHIBuildCommit string $BUILD_COMMIT" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :TECHIConnectBridgeVersion string $VERSION" "$APP_PLIST"
plutil -lint "$APP_PLIST" >/dev/null

SIGNING_STATUS=AD_HOC
if [[ -n "${MACOS_CODESIGN_IDENTITY:-}" ]]; then
  codesign --force --deep --strict --options runtime --timestamp \
    --sign "$MACOS_CODESIGN_IDENTITY" "$APP"
  SIGNING_STATUS=DEVELOPER_ID
else
  codesign --force --deep --strict --sign - "$APP"
fi
codesign --verify --deep --strict "$APP"

ln -s /Applications "$WORK/image/Applications"
DMG="$OUTPUT_DIR/$ARTIFACT_NAME"
rm -f "$DMG"
hdiutil create -quiet -volname "TECHI Remote Support" -srcfolder "$WORK/image" -ov -format UDZO "$DMG"
if [[ "$SIGNING_STATUS" == "DEVELOPER_ID" ]]; then
  codesign --force --timestamp --sign "$MACOS_CODESIGN_IDENTITY" "$DMG"
fi

NOTARIZATION_STATUS=NOT_NOTARIZED
if [[ -n "${MACOS_NOTARY_PROFILE:-}" && "$SIGNING_STATUS" == "DEVELOPER_ID" ]]; then
  xcrun notarytool submit "$DMG" --keychain-profile "$MACOS_NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  NOTARIZATION_STATUS=NOTARIZED
fi

SHA256=$(shasum -a 256 "$DMG" | awk '{print $1}')
BASE_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")
IDENTITY="$OUTPUT_DIR/${ARTIFACT_NAME%.dmg}.identity.json"
python3 - "$IDENTITY" <<PY
import json, sys
identity = {
    "product": "TECHI Remote Support",
    "version": "$VERSION",
    "platform": "darwin-arm64",
    "bundle_identifier": "al.techi.remote-support",
    "url_scheme": "techiremotesupport",
    "source_commit": "$BUILD_COMMIT",
    "base_client_version": "$BASE_VERSION",
    "artifact": "$ARTIFACT_NAME",
    "sha256": "$SHA256",
    "signing_status": "$SIGNING_STATUS",
    "notarization_status": "$NOTARIZATION_STATUS",
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(identity, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY

printf 'ARTIFACT=%s\nSHA256=%s\nSIGNING_STATUS=%s\nNOTARIZATION_STATUS=%s\n' \
  "$DMG" "$SHA256" "$SIGNING_STATUS" "$NOTARIZATION_STATUS"
