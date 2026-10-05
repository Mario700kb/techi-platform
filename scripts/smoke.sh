#!/usr/bin/env bash
#
# Post-deploy smoke test — run IMMEDIATELY after every production deploy.
# Marks the deployment FAILED (exit 1) if any endpoint returns something
# unexpected. A 500 on ANY endpoint is always a failure.
#
# Usage:  scripts/smoke.sh [BASE_URL] [TOKEN]
#   BASE_URL defaults to http://localhost:8000
#   TOKEN (optional operator JWT): when set, protected endpoints must return 200;
#         when absent, they must return 401 (auth-gated) — NEVER 500.
#
set -uo pipefail

BASE="${1:-http://localhost:8000}"
TOKEN="${2:-}"
FAILED=0

code() {
  # $1 method, $2 path, [extra curl args...]
  local method="$1"; local path="$2"; shift 2
  if [ -n "$TOKEN" ]; then
    curl -s -o /dev/null -w "%{http_code}" -X "$method" -H "Authorization: Bearer $TOKEN" "$BASE$path" "$@"
  else
    curl -s -o /dev/null -w "%{http_code}" -X "$method" "$BASE$path" "$@"
  fi
}

check() {
  # $1 label, $2 actual, $3 expected-when-token, $4 expected-when-no-token
  local label="$1"; local actual="$2"; local want_tok="$3"; local want_anon="$4"
  local want="$want_anon"; [ -n "$TOKEN" ] && want="$want_tok"
  if [ "$actual" = "500" ]; then
    echo "  ❌ $label → 500 (server error)"; FAILED=1; return
  fi
  if [ "$actual" = "$want" ]; then
    echo "  ✅ $label → $actual"
  else
    echo "  ❌ $label → $actual (expected $want)"; FAILED=1
  fi
}

echo "Smoke test against $BASE ${TOKEN:+(authenticated)}"

# /health is always public → 200.
check "/health"                       "$(code GET /health)"                       200 200
# Protected endpoints → 200 with a token, 401 without; NEVER 500.
check "/api/v1/devices/"              "$(code GET /api/v1/devices/)"              200 401
check "/api/v1/platform/features"    "$(code GET /api/v1/platform/features)"     200 401
check "/api/v1/auth/me"              "$(code GET /api/v1/auth/me)"               200 401
check "/api/v1/devices/overview"     "$(code GET /api/v1/devices/overview)"      200 401
check "/api/v1/enrollment-tokens"    "$(code GET /api/v1/enrollment-tokens)"     200 401
check "/api/v1/agent-packages"       "$(code GET /api/v1/agent-packages)"        200 401
check "/api/v1/deployments/recent"  "$(code GET /api/v1/deployments/recent)"  200 401

# Reporting is feature-gated. OFF → 404 is valid; ON → normal auth contract.
reports_code="$(code GET /api/v1/reports/runs)"
if [ "$reports_code" = "500" ]; then
  echo "  ❌ /api/v1/reports/runs → 500 (server error)"; FAILED=1
elif [ -n "$TOKEN" ] && { [ "$reports_code" = "200" ] || [ "$reports_code" = "404" ]; }; then
  echo "  ✅ /api/v1/reports/runs → $reports_code"
elif [ -z "$TOKEN" ] && { [ "$reports_code" = "401" ] || [ "$reports_code" = "404" ]; }; then
  echo "  ✅ /api/v1/reports/runs → $reports_code"
else
  echo "  ❌ /api/v1/reports/runs → $reports_code (unexpected)"; FAILED=1
fi

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "✅ SMOKE PASSED"
  exit 0
else
  echo "❌ DEPLOYMENT FAILED — smoke test detected an unexpected response."
  exit 1
fi
