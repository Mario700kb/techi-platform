#!/usr/bin/env bash
#
# Deployment Split Guard — run ON THE PRODUCTION HOST before/after any deploy.
#
# Guards against the 2026-07-14 incident (see docs/CHANGELOG-SOLUTIONS.md):
# the frontend and backend containers shared one compose project name
# ("techi-platform") but were brought up from two different roots — frontend
# from /root, backend from /opt/techi/techi-platform. A deploy from /opt then
# recreated the backend with /opt's .env, which was missing every FEATURE_*
# flag, silently turning off Reports / Linux / MikroTik / drawers.
#
# This guard fails closed if:
#   1. the running frontend and backend do NOT deploy from the same root, or
#   2. any required platform FEATURE_* flag is not effective in the backend.
#
# Usage:  scripts/deploy-guard.sh
# Env:    BACKEND_CTR, FRONTEND_CTR   (container names; sensible defaults)
#         REQUIRED_FLAGS             (space-separated FEATURE_* to enforce)
set -uo pipefail

BACKEND_CTR="${BACKEND_CTR:-techi-platform-backend-1}"
FRONTEND_CTR="${FRONTEND_CTR:-techi-platform-frontend-1}"
REQUIRED_FLAGS="${REQUIRED_FLAGS:-FEATURE_PLATFORM_CORE FEATURE_LINUX FEATURE_VAULT FEATURE_MIKROTIK FEATURE_REPORTING FEATURE_TERMINAL}"

fail() { echo ""; echo "❌ DEPLOY GUARD FAILED: $*"; exit 1; }
ok()   { echo "✅ $*"; }

command -v docker >/dev/null 2>&1 || fail "docker not found on host"

# --- 1. Single deployment root -------------------------------------------------
WD_LABEL='{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
CF_LABEL='{{index .Config.Labels "com.docker.compose.project.config_files"}}'
be_dir="$(docker inspect "$BACKEND_CTR"  --format "$WD_LABEL" 2>/dev/null)" || fail "backend container '$BACKEND_CTR' not found"
fe_dir="$(docker inspect "$FRONTEND_CTR" --format "$WD_LABEL" 2>/dev/null)" || fail "frontend container '$FRONTEND_CTR' not found"
[ -n "$be_dir" ] || fail "backend container has no compose working_dir label"
[ -n "$fe_dir" ] || fail "frontend container has no compose working_dir label"
if [ "$be_dir" != "$fe_dir" ]; then
  fail "SPLIT ROOT: backend deploys from '$be_dir' but frontend from '$fe_dir' — both services must come from one root/compose file"
fi
ok "single deployment root: $be_dir"

# Same working_dir but different compose files would still be a split stack.
be_cfg="$(docker inspect "$BACKEND_CTR"  --format "$CF_LABEL" 2>/dev/null)"
fe_cfg="$(docker inspect "$FRONTEND_CTR" --format "$CF_LABEL" 2>/dev/null)"
[ -n "$be_cfg" ] || fail "backend container has no compose config_files label"
[ -n "$fe_cfg" ] || fail "frontend container has no compose config_files label"
if [ "$be_cfg" != "$fe_cfg" ]; then
  fail "SPLIT COMPOSE FILE: backend uses '$be_cfg' but frontend uses '$fe_cfg' — both services must come from one compose file"
fi
ok "single compose file: $be_cfg"

# --- 2. Required FEATURE_* flags effective in the backend ----------------------
PY='import sys
from app.platform_core.flags import feature_enabled
off=[f for f in sys.argv[1:] if not feature_enabled(f)]
print("OFF:"+",".join(off) if off else "ALL_ON")'
res="$(docker exec "$BACKEND_CTR" python -c "$PY" $REQUIRED_FLAGS 2>/dev/null)" || fail "could not evaluate feature flags inside '$BACKEND_CTR'"
case "$res" in
  ALL_ON) ok "required platform flags effective: $REQUIRED_FLAGS" ;;
  OFF:*)  fail "platform flags NOT effective -> ${res#OFF:}  (check the backend's effective .env feature configuration)" ;;
  *)      fail "unexpected flag-check result: '$res'" ;;
esac

echo ""
echo "✅ DEPLOY GUARD PASSED"
