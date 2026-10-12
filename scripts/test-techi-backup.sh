#!/usr/bin/env bash
# Harness for scripts/techi-backup.sh — exercises the three dump outcomes and
# asserts the retention sweep only runs behind a verified dump.
set -uo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX=$(mktemp -d)
BIN="$SANDBOX/bin"; mkdir -p "$BIN"
PASS=0; FAIL=0

# Rewrite the hardcoded /opt/techi source paths onto the sandbox.
sed "s#/opt/techi/#$SANDBOX/opt/techi/#g" "$WT/scripts/techi-backup.sh" > "$SANDBOX/backup.sh"
chmod +x "$SANDBOX/backup.sh"

mkdir -p "$SANDBOX/opt/techi/rustdesk-server/data" "$SANDBOX/opt/techi/techi-platform"
echo key      > "$SANDBOX/opt/techi/rustdesk-server/data/id_ed25519"
echo pub      > "$SANDBOX/opt/techi/rustdesk-server/data/id_ed25519.pub"
echo compose  > "$SANDBOX/opt/techi/rustdesk-server/docker-compose.yml"
echo compose2 > "$SANDBOX/opt/techi/techi-platform/docker-compose.yml"
echo env      > "$SANDBOX/opt/techi/techi-platform/.env"

cat > "$BIN/sha256sum" <<'EOF'
#!/usr/bin/env bash
echo "deadbeef  $1"
EOF
chmod +x "$BIN/sha256sum"

# docker stub: `volume inspect` always misses (vault skipped);
# `exec ... pg_dumpall` behaviour is driven by $MODE.
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  volume) exit 1 ;;
  exec)
    case "${MODE:-ok}" in
      # Incompressible, so the post-gzip size clears the 10 MB floor the way a
      # real ~278 MB dump does.
      ok)        head -c 12000000 /dev/urandom; exit 0 ;;
      fail)      echo "pg_dumpall: could not connect" >&2; exit 1 ;;
      truncated) echo "tiny"; exit 0 ;;
    esac ;;
esac
EOF
chmod +x "$BIN/docker"

run_case() {
  local name="$1" mode="$2"; shift 2
  local dir="$SANDBOX/backups-$name"; mkdir -p "$dir"
  # An 8-day-old backup set: retention must remove it only on success.
  touch -t "$(date -v-8d +%Y%m%d0300 2>/dev/null || date -d '8 days ago' +%Y%m%d0300)" \
        "$dir/postgres-2026-07-21_03-00.sql.gz"
  # Pre-deploy dumps: four 20 days old (the newest three of all must
  # survive regardless), one 2 days old.
  local d
  for d in 20 21 22 23; do
    touch -t "$(date -v-${d}d +%Y%m%d1200 2>/dev/null || date -d "$d days ago" +%Y%m%d1200)" "$dir/pre-old-$d.sql.gz"
  done
  touch -t "$(date -v-2d +%Y%m%d1200 2>/dev/null || date -d '2 days ago' +%Y%m%d1200)" "$dir/pre-recent.sql.gz"
  MODE="$mode" BACKUP_DIR="$dir" PATH="$BIN:$PATH" bash "$SANDBOX/backup.sh" >"$dir/.log" 2>&1
  local rc=$?
  echo "--- $name (exit $rc) ---"
  "$@" "$dir" "$rc" && { echo "  PASS"; PASS=$((PASS+1)); } || { echo "  FAIL"; sed 's/^/    /' "$dir/.log"; FAIL=$((FAIL+1)); }
}

assert_ok() {
  local dir=$1 rc=$2
  [ "$rc" -eq 0 ]                                    || { echo "  exit != 0"; return 1; }
  ls "$dir"/postgres-"$(date +%Y-%m-%d)"*.sql.gz >/dev/null 2>&1 || { echo "  no promoted dump"; return 1; }
  [ ! -e "$dir/postgres-2026-07-21_03-00.sql.gz" ]   || { echo "  old backup survived (retention did not run)"; return 1; }
  ls "$dir"/*.partial >/dev/null 2>&1                && { echo "  .partial left behind"; return 1; }
  ls "$dir"/rustdesk-keys-*.tar.gz >/dev/null 2>&1   || { echo "  rustdesk keys missing"; return 1; }
  # Newest three pre-deploy dumps kept (recent, 20, 21 days); 22 and 23 gone.
  [ -e "$dir/pre-recent.sql.gz" ] && [ -e "$dir/pre-old-20.sql.gz" ] && [ -e "$dir/pre-old-21.sql.gz" ] \
                                                     || { echo "  a protected pre-deploy dump was deleted"; return 1; }
  [ ! -e "$dir/pre-old-22.sql.gz" ] && [ ! -e "$dir/pre-old-23.sql.gz" ] \
                                                     || { echo "  old pre-deploy dumps survived"; return 1; }
  return 0
}

assert_rejected() {
  local dir=$1 rc=$2
  [ "$rc" -ne 0 ]                                     || { echo "  exit should be non-zero"; return 1; }
  ls "$dir"/postgres-"$(date +%Y-%m-%d)"*.sql.gz >/dev/null 2>&1 && { echo "  bad dump was promoted"; return 1; }
  [ -e "$dir/postgres-2026-07-21_03-00.sql.gz" ]      || { echo "  RETENTION DELETED GOOD BACKUP"; return 1; }
  ls "$dir"/*.partial >/dev/null 2>&1                 && { echo "  .partial left behind"; return 1; }
  ls "$dir"/rustdesk-keys-*.tar.gz >/dev/null 2>&1    || { echo "  rustdesk keys missing (aborted too early)"; return 1; }
  [ "$(ls "$dir"/pre-*.sql.gz | wc -l)" -eq 5 ]       || { echo "  pre-deploy dumps deleted without a verified dump"; return 1; }
  return 0
}

run_case happy      ok        assert_ok
run_case dump-fails fail      assert_rejected
run_case truncated  truncated assert_rejected

echo; echo "PASS=$PASS FAIL=$FAIL"
rm -rf "$SANDBOX"
[ "$FAIL" -eq 0 ]
