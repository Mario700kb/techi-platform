#!/usr/bin/env bash
#
# Build the native bootstrap + agent Windows artifacts and their identity
# sidecars. Deterministic, no signing performed here (signing is a later,
# explicit step — this script only records signed:false so the release gate can
# refuse unsigned binaries once signing is mandatory).
#
# Output (in $OUT_DIR, default agent/dist/native):
#   techi-bootstrap.exe
#   techi-bootstrap.exe.sha256
#   techi-agent.exe                (byte-identical to the UI/NETLOGON EXE)
#   techi-agent.exe.sha256
#   identity.json                  (filenames, sha256, signed flag, build meta)
#
# Usage: agent/scripts/build-native-bootstrap.sh
set -euo pipefail

AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$AGENT_DIR/dist/native}"
mkdir -p "$OUT_DIR"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

echo "▶ go build techi-bootstrap.exe (windows/amd64)"
( cd "$AGENT_DIR" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
    go build -trimpath -o "$OUT_DIR/techi-bootstrap.exe" ./cmd/techi-bootstrap )

echo "▶ go build techi-agent.exe (windows/amd64)"
( cd "$AGENT_DIR" && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
    go build -trimpath -o "$OUT_DIR/techi-agent.exe" . )

BOOT_SHA="$(sha256_of "$OUT_DIR/techi-bootstrap.exe")"
AGENT_SHA="$(sha256_of "$OUT_DIR/techi-agent.exe")"
printf '%s  techi-bootstrap.exe\n' "$BOOT_SHA" > "$OUT_DIR/techi-bootstrap.exe.sha256"
printf '%s  techi-agent.exe\n' "$AGENT_SHA" > "$OUT_DIR/techi-agent.exe.sha256"

AGENT_VERSION="$(cat "$AGENT_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')"
GIT_COMMIT="$(git -C "$AGENT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

cat > "$OUT_DIR/identity.json" <<JSON
{
  "schema": "techi-native-identity/1",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "git_commit": "$GIT_COMMIT",
  "agent_version": "${AGENT_VERSION:-unknown}",
  "artifacts": [
    {
      "filename": "techi-bootstrap.exe",
      "sha256": "$BOOT_SHA",
      "os": "windows",
      "arch": "amd64",
      "signed": false,
      "authenticode": "not-enforced"
    },
    {
      "filename": "techi-agent.exe",
      "sha256": "$AGENT_SHA",
      "os": "windows",
      "arch": "amd64",
      "signed": false,
      "authenticode": "not-enforced"
    }
  ],
  "distribution": "LAN-local; AV/EDR policies remain applicable",
  "signing_status": "unsigned"
}
JSON

echo "▶ validate the example policy contract with the freshly built bootstrap"
# Cross-check the schema on the host toolchain (linux/mac) build too.
( cd "$AGENT_DIR" && go build -o "$OUT_DIR/.techi-bootstrap-host" ./cmd/techi-bootstrap \
    && "$OUT_DIR/.techi-bootstrap-host" apply-policy \
        --policy "$AGENT_DIR/installer/techi-policy.example.json" --json \
    && rm -f "$OUT_DIR/.techi-bootstrap-host" )

# Release gate scaffold: once signing is mandatory, set REQUIRE_SIGNED=1 to fail
# the build while binaries are unsigned. Do NOT claim signing is implemented.
if [ "${REQUIRE_SIGNED:-0}" = "1" ]; then
  echo "❌ REQUIRE_SIGNED=1 but artifacts are unsigned (signing not yet implemented)"
  exit 3
fi

echo "✅ native bootstrap artifacts in $OUT_DIR"
echo "   bootstrap sha256=$BOOT_SHA"
echo "   agent     sha256=$AGENT_SHA"
