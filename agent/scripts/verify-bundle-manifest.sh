#!/usr/bin/env bash
#
# Verify a Remote Support bundle manifest carries NO secret/config file among
# the files it actually bundles.
#
# It scans ONLY the canonical bundled-file list — `.expected_relative_files[].path`
# — never the manifest as a whole. The manifest legitimately carries
# `config_paths_to_preserve` and `never_overwrite_paths` arrays that intentionally
# NAME agent.config.json and *.toml as files to PRESERVE (never bundle); an
# earlier whole-manifest grep false-positived on that preservation contract and
# failed the build. This check must reject a genuinely bundled secret/config file
# while ignoring the preserve metadata and any documentation strings.
#
# Fail-closed: invalid JSON, or a missing/malformed bundled-file list, is a failure.
#
# Usage: verify-bundle-manifest.sh <manifest.json>
set -euo pipefail

man="${1:?usage: verify-bundle-manifest.sh <manifest.json>}"
[ -f "$man" ] || { echo "❌ manifest not found: $man"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "❌ jq is required for manifest verification"; exit 1; }

# 1. Must be valid JSON.
jq -e . "$man" >/dev/null 2>&1 || { echo "❌ manifest is not valid JSON: $man"; exit 1; }

# 2. The canonical bundled-file list must exist, be a non-empty array, and every
#    entry must carry a non-empty string path (fail closed otherwise).
if ! jq -e '
      (.expected_relative_files | type) == "array"
      and ((.expected_relative_files | length) > 0)
      and (all(.expected_relative_files[]; (.path? | type) == "string" and ((.path | length) > 0)))
    ' "$man" >/dev/null 2>&1; then
  echo "❌ manifest .expected_relative_files list is missing or malformed"; exit 1
fi

# 3. Scan ONLY the actually-bundled file paths. Same prohibited patterns as the
#    original check (secret/config/machine-specific material), scoped to the bundle.
bundled_paths="$(jq -r '.expected_relative_files[].path' "$man")" \
  || { echo "❌ could not read bundled file paths from manifest"; exit 1; }

if printf '%s\n' "$bundled_paths" | grep -Eqi '\.toml|id_ed25519|password|config\.json|\.log'; then
  echo "❌ a bundled file path references a secret/config file:"
  printf '%s\n' "$bundled_paths" | grep -Eni '\.toml|id_ed25519|password|config\.json|\.log' >&2
  exit 1
fi

echo "manifest OK: $(printf '%s\n' "$bundled_paths" | grep -c .) bundled files, no secret/config paths"
