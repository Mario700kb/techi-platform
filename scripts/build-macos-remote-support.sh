#!/bin/bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(tr -d '[:space:]' < "$ROOT/remote-support-macos/VERSION")
BUILD_VERSION=$(tr -d '[:space:]' < "$ROOT/remote-support-macos/BUILD_VERSION")
BASE_APP=${MACOS_RS_BASE_APP:-/Applications/TECHI Remote Support.app}
OUTPUT_DIR=${MACOS_RS_OUTPUT_DIR:-$ROOT/dist}
ARCH=${MACOS_RS_ARCH:-arm64}
CREATE_DMG=${CREATE_DMG:-$(command -v create-dmg || true)}
APP_NAME="TECHI Remote Support.app"
ARTIFACT_BASE="TECHI-Remote-Support-${VERSION}-darwin-${ARCH}"
DMG_NAME="$ARTIFACT_BASE.dmg"
PKG_NAME="$ARTIFACT_BASE.pkg"
BUILD_COMMIT=$(git -C "$ROOT" rev-parse HEAD)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/techi-rs-macos.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

if [[ "$ARCH" != "arm64" ]]; then
  echo "Only the verified darwin-arm64 base application is supported" >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ ! "$BUILD_VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "Invalid marketing or internal build version" >&2
  exit 1
fi
if [[ ! -d "$BASE_APP" ]]; then
  echo "Base TECHI Remote Support.app not found: $BASE_APP" >&2
  exit 1
fi
if [[ -z "$CREATE_DMG" || ! -x "$CREATE_DMG" ]]; then
  echo "create-dmg is required to build the standard drag-to-Applications image" >&2
  exit 1
fi

PLIST="$BASE_APP/Contents/Info.plist"
if [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST")" != "al.techi.remote-support" ]] ||
   [[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$PLIST")" != "TECHI Remote Support" ]]; then
  echo "Base application identity does not match TECHI Remote Support" >&2
  exit 1
fi
BASE_MARKETING_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")
BASE_EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST")
BASE_KIND=unwrapped
BASE_CLIENT="$BASE_APP/Contents/MacOS/$BASE_EXECUTABLE"
if [[ "$BASE_MARKETING_VERSION" == "$VERSION" ]] &&
   [[ "$(/usr/libexec/PlistBuddy -c 'Print :TECHIConnectBridgeVersion' "$PLIST" 2>/dev/null || true)" == "$VERSION" ]] &&
   [[ -x "$BASE_APP/Contents/MacOS/TECHI Remote Support Client" ]]; then
  BASE_KIND=wrapped
  BASE_CLIENT="$BASE_APP/Contents/MacOS/TECHI Remote Support Client"
elif [[ "$BASE_MARKETING_VERSION" != "1.4.6" ]] ||
     /usr/libexec/PlistBuddy -c 'Print :TECHIConnectBridgeVersion' "$PLIST" >/dev/null 2>&1; then
  echo "Base application must be the canonical 1.4.6 client or verified TECHI $VERSION wrapper" >&2
  exit 1
fi
if ! /usr/bin/lipo -archs "$BASE_CLIENT" | tr ' ' '\n' | grep -qx "$ARCH"; then
  echo "Base application does not contain architecture $ARCH" >&2
  exit 1
fi
ABOUT_AOT="$BASE_APP/Contents/Frameworks/App.framework/Versions/A/App"
ABOUT_MARKER='bundle-metadata:CFBundleShortVersionString+CFBundleVersion'
SECURE_CONNECT_MARKER='techi-secure-connect-stdin-v1'
if ! { [[ -f "$ABOUT_AOT" ]] && /usr/bin/grep -aFq "$ABOUT_MARKER" "$ABOUT_AOT"; } &&
   ! /usr/bin/grep -aFq "$ABOUT_MARKER" "$BASE_CLIENT"; then
  echo "Base application does not contain the macOS About bundle-metadata contract" >&2
  exit 1
fi
if ! /usr/bin/grep -aRFq "$SECURE_CONNECT_MARKER" "$BASE_APP/Contents"; then
  echo "Base application does not contain the secure stdin credential contract" >&2
  exit 1
fi

mkdir -p "$WORK/app" "$WORK/dmg-source" "$WORK/pkg-root/Applications" "$WORK/pkg-scripts" "$OUTPUT_DIR"
/usr/bin/ditto "$BASE_APP" "$WORK/app/$APP_NAME"
APP="$WORK/app/$APP_NAME"
APP_PLIST="$APP/Contents/Info.plist"
CLIENT="$APP/Contents/MacOS/TECHI Remote Support Client"
if [[ "$BASE_KIND" == "unwrapped" ]]; then
  mv "$APP/Contents/MacOS/$BASE_EXECUTABLE" "$CLIENT"
else
  rm -f "$APP/Contents/MacOS/$BASE_EXECUTABLE"
fi
rm -rf "$APP/Contents/_CodeSignature"
rm -rf "$APP/Contents/Helpers"
mkdir -p "$APP/Contents/Helpers"

(
  cd "$ROOT/remote-support-bridge"
  GOOS=darwin GOARCH="$ARCH" CGO_ENABLED=1 go build \
    -trimpath -ldflags="-s -w -X main.version=$VERSION" \
    -o "$APP/Contents/Helpers/techi-remote-support-bridge" .
)
/usr/bin/swiftc -O -whole-module-optimization -framework AppKit \
  -target "${ARCH}-apple-macos12.3" \
  "$ROOT/remote-support-macos/Launcher.swift" \
  -o "$APP/Contents/MacOS/TECHI Remote Support"
/usr/bin/swiftc -O -whole-module-optimization -framework AppKit \
  -target "${ARCH}-apple-macos12.3" \
  "$ROOT/remote-support-macos/PackageProcessControl.swift" \
  -o "$WORK/pkg-scripts/package-process-control"

set_plist_value() {
  local key=$1 type=$2 value=$3
  /usr/libexec/PlistBuddy -c "Set :$key $value" "$APP_PLIST" 2>/dev/null ||
    /usr/libexec/PlistBuddy -c "Add :$key $type $value" "$APP_PLIST"
}

set_plist_value CFBundleExecutable string "TECHI Remote Support"
set_plist_value CFBundleDisplayName string "TECHI Remote Support"
set_plist_value CFBundleName string "TECHI Remote Support"
set_plist_value CFBundleIdentifier string "al.techi.remote-support"
set_plist_value CFBundleShortVersionString string "$VERSION"
set_plist_value CFBundleVersion string "$BUILD_VERSION"
set_plist_value LSMinimumSystemVersion string "12.3"
/usr/libexec/PlistBuddy -c "Delete :NSMainNibFile" "$APP_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$APP_PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleTypeRole string Viewer" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string al.techi.remote-support.connect" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$APP_PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string techiremotesupport" "$APP_PLIST"
set_plist_value TECHIBuildCommit string "$BUILD_COMMIT"
set_plist_value TECHIConnectBridgeVersion string "$VERSION"
/usr/bin/plutil -lint "$APP_PLIST" >/dev/null

# Release Rust/Swift binaries can retain compiler diagnostic paths. Replace
# concrete /Users/<builder>/ prefixes at equal byte length before signing; the
# strings remain useful diagnostics without binding the artifact to a Mac.
/usr/bin/python3 - "$APP" <<'PY'
import re
import sys
from pathlib import Path

mach_o_magic = {
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
    b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf",
    b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xce",
}
pattern = re.compile(rb"/Users/[^/\x00]{1,128}/")
for path in Path(sys.argv[1]).rglob("*"):
    if not path.is_file() or path.is_symlink():
        continue
    data = path.read_bytes()
    if data[:4] not in mach_o_magic or not pattern.search(data):
        continue
    def sanitized(match):
        size = len(match.group(0))
        return b"/build/" + (b"_" * (size - len(b"/build/") - 1)) + b"/"
    path.write_bytes(pattern.sub(sanitized, data))
PY

/usr/bin/find "$APP" -type d -exec /bin/chmod 755 {} +
/usr/bin/find "$APP" -type f -perm -u+x -exec /bin/chmod 755 {} +
/usr/bin/find "$APP" -type f ! -perm -u+x -exec /bin/chmod 644 {} +
/usr/bin/xattr -cr "$APP"
if [[ -n "$(/usr/bin/find "$APP" -type l ! -exec test -e {} \; -print -quit)" ]]; then
  echo "Application bundle contains a broken symlink" >&2
  exit 1
fi

APP_SIGNING_STATUS=AD_HOC
if [[ -n "${MACOS_APP_SIGNING_IDENTITY:-}" ]]; then
  /usr/bin/codesign --force --deep --strict --options runtime --timestamp \
    --sign "$MACOS_APP_SIGNING_IDENTITY" "$APP"
  /usr/bin/codesign --force --strict --options runtime --timestamp \
    --sign "$MACOS_APP_SIGNING_IDENTITY" "$WORK/pkg-scripts/package-process-control"
  APP_SIGNING_STATUS=DEVELOPER_ID
else
  /usr/bin/codesign --force --deep --strict --sign - "$APP"
  /usr/bin/codesign --force --strict --sign - "$WORK/pkg-scripts/package-process-control"
fi
/usr/bin/codesign --verify --deep --strict "$APP"
/usr/bin/codesign --verify --strict "$WORK/pkg-scripts/package-process-control"

APP_NOTARIZATION_STATUS=NOT_NOTARIZED
if [[ -n "${MACOS_NOTARY_PROFILE:-}" && "$APP_SIGNING_STATUS" == "DEVELOPER_ID" ]]; then
  /usr/bin/ditto -c -k --keepParent "$APP" "$WORK/$ARTIFACT_BASE.app.zip"
  /usr/bin/xcrun notarytool submit "$WORK/$ARTIFACT_BASE.app.zip" \
    --keychain-profile "$MACOS_NOTARY_PROFILE" --wait
  /usr/bin/xcrun stapler staple "$APP"
  /usr/bin/xcrun stapler validate "$APP"
  APP_NOTARIZATION_STATUS=NOTARIZED
fi

/usr/bin/ditto "$APP" "$WORK/dmg-source/$APP_NAME"
/usr/bin/ditto "$APP" "$WORK/pkg-root/Applications/$APP_NAME"
cp "$ROOT/remote-support-macos/package-scripts/preinstall" "$WORK/pkg-scripts/preinstall"
cp "$ROOT/remote-support-macos/package-scripts/postinstall" "$WORK/pkg-scripts/postinstall"
chmod 755 "$WORK/pkg-scripts/preinstall" "$WORK/pkg-scripts/postinstall"

/usr/bin/python3 - "$WORK/component.plist" "$WORK/pkg-scripts/package-metadata.plist" "$VERSION" "$BUILD_VERSION" <<'PY'
import plistlib
import sys

component_path, metadata_path, version, build_version = sys.argv[1:]
component = [{
    "RootRelativeBundlePath": "Applications/TECHI Remote Support.app",
    "BundleIsRelocatable": False,
    "BundleIsVersionChecked": False,
    "BundleHasStrictIdentifier": True,
    "BundleOverwriteAction": "upgrade",
}]
with open(component_path, "wb") as handle:
    plistlib.dump(component, handle, sort_keys=True)
with open(metadata_path, "wb") as handle:
    plistlib.dump({"MarketingVersion": version, "BuildVersion": build_version}, handle, sort_keys=True)
PY

COMPONENT_PKG="$WORK/$ARTIFACT_BASE.component.pkg"
UNSIGNED_PKG="$WORK/$ARTIFACT_BASE.unsigned.pkg"
/usr/bin/pkgbuild --root "$WORK/pkg-root" \
  --component-plist "$WORK/component.plist" \
  --scripts "$WORK/pkg-scripts" \
  --ownership recommended \
  --identifier "al.techi.remote-support.pkg" \
  --version "$BUILD_VERSION" \
  --install-location / \
  "$COMPONENT_PKG"
/usr/bin/productbuild --package "$COMPONENT_PKG" "$UNSIGNED_PKG"

PKG="$OUTPUT_DIR/$PKG_NAME"
rm -f "$PKG"
PKG_SIGNING_STATUS=UNSIGNED
if [[ -n "${MACOS_INSTALLER_SIGNING_IDENTITY:-}" ]]; then
  /usr/bin/productsign --sign "$MACOS_INSTALLER_SIGNING_IDENTITY" --timestamp "$UNSIGNED_PKG" "$PKG"
  /usr/sbin/pkgutil --check-signature "$PKG"
  PKG_SIGNING_STATUS=DEVELOPER_ID
else
  mv "$UNSIGNED_PKG" "$PKG"
fi

ICON_FILE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$APP_PLIST" 2>/dev/null || true)
if [[ -n "$ICON_FILE" && "$ICON_FILE" != *.icns ]]; then
  ICON_FILE="$ICON_FILE.icns"
fi
DMG="$OUTPUT_DIR/$DMG_NAME"
rm -f "$DMG"
DMG_ARGS=(
  --volname "TECHI Remote Support"
  --window-size 600 360
  --icon-size 100
  --icon "$APP_NAME" 150 170
  --hide-extension "$APP_NAME"
  --app-drop-link 450 170
  --no-internet-enable
  --format UDZO
)
if [[ "${MACOS_RS_CREATE_DMG_SKIP_FINDER:-0}" == "1" ]]; then
  DMG_ARGS+=(--skip-jenkins)
fi
if [[ -n "$ICON_FILE" && -f "$APP/Contents/Resources/$ICON_FILE" ]]; then
  DMG_ARGS+=(--volicon "$APP/Contents/Resources/$ICON_FILE")
fi
"$CREATE_DMG" "${DMG_ARGS[@]}" "$DMG" "$WORK/dmg-source"

DMG_SIGNING_STATUS=UNSIGNED
if [[ "$APP_SIGNING_STATUS" == "DEVELOPER_ID" ]]; then
  /usr/bin/codesign --force --timestamp --sign "$MACOS_APP_SIGNING_IDENTITY" "$DMG"
  /usr/bin/codesign --verify --strict "$DMG"
  DMG_SIGNING_STATUS=DEVELOPER_ID
fi

DMG_NOTARIZATION_STATUS=NOT_NOTARIZED
PKG_NOTARIZATION_STATUS=NOT_NOTARIZED
if [[ -n "${MACOS_NOTARY_PROFILE:-}" && "$DMG_SIGNING_STATUS" == "DEVELOPER_ID" ]]; then
  /usr/bin/xcrun notarytool submit "$DMG" --keychain-profile "$MACOS_NOTARY_PROFILE" --wait
  /usr/bin/xcrun stapler staple "$DMG"
  /usr/bin/xcrun stapler validate "$DMG"
  DMG_NOTARIZATION_STATUS=NOTARIZED
fi
if [[ -n "${MACOS_NOTARY_PROFILE:-}" && "$PKG_SIGNING_STATUS" == "DEVELOPER_ID" ]]; then
  /usr/bin/xcrun notarytool submit "$PKG" --keychain-profile "$MACOS_NOTARY_PROFILE" --wait
  /usr/bin/xcrun stapler staple "$PKG"
  /usr/bin/xcrun stapler validate "$PKG"
  PKG_NOTARIZATION_STATUS=NOTARIZED
fi

DMG_SHA256=$(shasum -a 256 "$DMG" | awk '{print $1}')
PKG_SHA256=$(shasum -a 256 "$PKG" | awk '{print $1}')
BASE_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")
IDENTITY="$OUTPUT_DIR/$ARTIFACT_BASE.identity.json"
/usr/bin/python3 - "$IDENTITY" <<PY
import json, sys
identity = {
    "product": "TECHI Remote Support",
    "version": "$VERSION",
    "build_version": "$BUILD_VERSION",
    "platform": "darwin-arm64",
    "bundle_identifier": "al.techi.remote-support",
    "url_scheme": "techiremotesupport",
    "source_commit": "$BUILD_COMMIT",
    "base_client_version": "$BASE_VERSION",
    "app_signing_status": "$APP_SIGNING_STATUS",
    "app_notarization_status": "$APP_NOTARIZATION_STATUS",
    "artifacts": {
        "$DMG_NAME": {
            "sha256": "$DMG_SHA256",
            "signing_status": "$DMG_SIGNING_STATUS",
            "notarization_status": "$DMG_NOTARIZATION_STATUS",
        },
        "$PKG_NAME": {
            "sha256": "$PKG_SHA256",
            "signing_status": "$PKG_SIGNING_STATUS",
            "notarization_status": "$PKG_NOTARIZATION_STATUS",
        },
    },
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(identity, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY

printf 'DMG=%s\nDMG_SHA256=%s\nPKG=%s\nPKG_SHA256=%s\nAPP_SIGNING_STATUS=%s\nAPP_NOTARIZATION_STATUS=%s\nDMG_SIGNING_STATUS=%s\nDMG_NOTARIZATION_STATUS=%s\nPKG_SIGNING_STATUS=%s\nPKG_NOTARIZATION_STATUS=%s\n' \
  "$DMG" "$DMG_SHA256" "$PKG" "$PKG_SHA256" \
  "$APP_SIGNING_STATUS" "$APP_NOTARIZATION_STATUS" \
  "$DMG_SIGNING_STATUS" "$DMG_NOTARIZATION_STATUS" \
  "$PKG_SIGNING_STATUS" "$PKG_NOTARIZATION_STATUS"
