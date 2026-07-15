#!/usr/bin/env bash
#
# Deployment Contract Verification — MANDATORY before every production deploy.
# Runs the full build/test gate and exits non-zero on ANY failure, so a broken
# service↔repository contract (or type/build error) stops the deploy.
#
# Usage:  scripts/preflight.sh
# Env:    LOG_DIR (writable dir for backend test logs; defaults to a temp dir)
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
AGENT="$ROOT/agent"
RS_BRIDGE="$ROOT/remote-support-bridge"
: "${LOG_DIR:=$(mktemp -d)}"
export LOG_DIR

# The backend suite is a hard gate. Known failures must be fixed or explicitly
# excluded at the test level; preflight never treats failures as success.
KNOWN_BACKEND_FAILURES=0

fail() { echo ""; echo "❌ PREFLIGHT FAILED: $1"; exit 1; }
step() { echo ""; echo "▶ $1"; }

# Robust pytest failure accounting. pytest is run from the backend dir so `app`
# imports and conftest is found. Collection errors (import/signature) count as
# failures too, and a run that collected NOTHING is itself a failure.
run_pytest() {
  # $1 label, $2 baseline-allowed-failures, $3 logfile, rest: pytest args
  local label="$1"; local baseline="$2"; local logf="$3"; shift 3
  ( cd "$BACKEND" && "$BACKEND/venv/bin/python" -m pytest -q -p no:cacheprovider "$@" ) >"$logf" 2>&1
  local passed failed errors
  passed="$(grep -oE "[0-9]+ passed"  "$logf" | tail -1 | grep -oE "[0-9]+" || echo 0)"
  failed="$(grep -oE "[0-9]+ failed"  "$logf" | tail -1 | grep -oE "[0-9]+" || echo 0)"
  errors="$(grep -oE "[0-9]+ errors?" "$logf" | tail -1 | grep -oE "[0-9]+" || echo 0)"
  echo "  ${passed} passed, ${failed} failed, ${errors} errors (baseline failures: ${baseline})"
  [ "${passed:-0}" -eq 0 ] && { tail -25 "$logf"; fail "$label collected/ran no tests"; }
  [ "${errors:-0}" -gt 0 ] && { grep -E "ERROR|Error" "$logf" | head; fail "$label had collection/errors"; }
  [ "${failed:-0}" -gt "$baseline" ] && { grep FAILED "$logf"; fail "$label: new failures (${failed} > ${baseline})"; }
}

# 0. Single-engine guard — the retired C1–C4 classifiers must never come back.
# Category/platform classification lives ONLY in platform_core/classification.py.
step "Single classification engine guard"
RETIRED_SYMBOLS='_tree_category_case|_platform_class_case|_category_from_os|_category_from_group|_CATEGORY_PLATFORM_PATTERNS|_SERVER_OS_TOKENS'
guard_hits="$(grep -rnE "$RETIRED_SYMBOLS" "$BACKEND/app" 2>/dev/null \
  | grep -v "app/platform_core/classification.py" || true)"
if [ -n "$guard_hits" ]; then
  echo "$guard_hits"
  fail "retired classifier symbol reintroduced outside the Unified Classification Engine"
fi
echo "  OK — one engine (platform_core/classification.py)"

# 1. Contract tests — the hard gate. ZERO tolerance.
step "Backend contract tests (service↔repository interface)"
run_pytest "contract tests" 0 /tmp/preflight_contracts.log \
  tests/test_service_repository_contracts.py tests/test_device_service_filter_contract.py

# 2. Full backend suite (flags OFF) — no NEW failures beyond the known baseline.
step "Backend test suite (flags OFF)"
run_pytest "backend suite (flags off)" "$KNOWN_BACKEND_FAILURES" /tmp/preflight_backend.log tests

# 3. Full backend suite (flags ON) — must match the same baseline.
step "Backend test suite (flags ON)"
FEATURE_PLATFORM_CORE=true FEATURE_LINUX=true FEATURE_VAULT=true FEATURE_TERMINAL=true FEATURE_MIKROTIK=true FEATURE_NOTIFICATIONS=true FEATURE_REPORTING=true \
  run_pytest "backend suite (flags on)" "$KNOWN_BACKEND_FAILURES" /tmp/preflight_backend_on.log tests

# 4. Frontend TypeScript.
step "Frontend TypeScript (tsc --noEmit)"
( cd "$FRONTEND" && npx tsc --noEmit ) || fail "tsc errors"

# 5. Frontend production build.
step "Frontend production build"
( cd "$FRONTEND" && npm run build >/tmp/preflight_fe_build.log 2>&1 ) || { tail -20 /tmp/preflight_fe_build.log; fail "frontend build failed"; }
echo "  build OK"

# 6. Agent builds (Windows reference MUST compile; Linux targets too).
step "Agent go build (windows + linux)"
( cd "$AGENT" && GOOS=windows GOARCH=amd64 go build -o /dev/null . ) || fail "agent windows build failed"
( cd "$AGENT" && GOOS=linux GOARCH=amd64 go build -o /dev/null . ) || fail "agent linux build failed"
( cd "$AGENT" && go test ./... >/tmp/preflight_go.log 2>&1 ) || { tail -20 /tmp/preflight_go.log; fail "agent go test failed"; }
echo "  agent OK"

# 7. Remote Support Connect bridge and credential transport contract.
step "Remote Support Connect bridge security"
( cd "$RS_BRIDGE" && go test ./... ) || fail "remote support bridge tests failed"
( cd "$RS_BRIDGE" && GOOS=windows GOARCH=amd64 go test -c -o /tmp/techi-rs-bridge.test.exe . ) || fail "remote support bridge windows compile failed"
python3 "$ROOT/scripts/verify_remote_support_connect_security.py" || fail "remote support connect security contract failed"
rm -f /tmp/techi-rs-bridge.test.exe
echo "  bridge OK"

echo ""
echo "✅ PREFLIGHT PASSED — local source verification succeeded."
