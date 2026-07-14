#!/usr/bin/env bash
#
# Self-test for verify-bundle-manifest.sh. Proves the scoped check:
#   - PASSES a manifest whose preserve arrays name *.toml / agent.config.json
#     (config_paths_to_preserve / never_overwrite_paths must NOT trip it).
#   - FAILS when an actually-bundled expected_relative_files entry is a
#     .toml / config.json / password file.
#   - FAILS closed on a missing/malformed bundled-file list or invalid JSON.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
check="$here/verify-bundle-manifest.sh"
data="$here/testdata"
rc=0

expect_pass() {
  if "$check" "$1" >/dev/null 2>&1; then echo "  ok  PASS  $(basename "$1")"
  else echo "  ❌  expected PASS but got FAIL: $(basename "$1")"; rc=1; fi
}
expect_fail() {
  if "$check" "$1" >/dev/null 2>&1; then echo "  ❌  expected FAIL but got PASS: $(basename "$1")"; rc=1
  else echo "  ok  FAIL  $(basename "$1")"; fi
}

echo "▶ verify-bundle-manifest self-test"
expect_pass "$data/manifest-pass.json"                 # preserve arrays name *.toml / agent.config.json
expect_fail "$data/manifest-bundled-toml.json"         # bundles a .toml
expect_fail "$data/manifest-bundled-configjson.json"   # bundles config.json
expect_fail "$data/manifest-bundled-password.json"     # bundles a password file
expect_fail "$data/manifest-missing-list.json"         # fail-closed: no bundled-file list
expect_fail "$data/manifest-malformed.json"            # fail-closed: entries lack a valid path
expect_fail "$data/manifest-notjson.json"              # fail-closed: invalid JSON

if [ "$rc" -eq 0 ]; then echo "✅ verify-bundle-manifest self-test passed"; else echo "❌ verify-bundle-manifest self-test FAILED"; fi
exit "$rc"
