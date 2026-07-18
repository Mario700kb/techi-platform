#!/bin/bash
# TECHI Remote Support standalone EXE builder.
#
# The EXE packaging uses Windows IExpress so the wrapper embeds and launches the
# exact MSI built from remote-support.wxs. Run this on Windows or in CI.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${1:-1.4.6}"

if ! command -v pwsh >/dev/null 2>&1 && ! command -v powershell.exe >/dev/null 2>&1; then
  echo "ERROR: standalone EXE packaging requires Windows PowerShell/IExpress." >&2
  exit 1
fi

PS=pwsh
if ! command -v pwsh >/dev/null 2>&1; then
  PS=powershell.exe
fi

"$PS" -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/build-remote-support-exe.ps1" -Version "$VERSION"
