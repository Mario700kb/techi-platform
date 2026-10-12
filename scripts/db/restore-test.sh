#!/usr/bin/env bash
#
# Restore test: proves the newest nightly dump can be restored, and that what
# comes back matches the live database. A backup that has never been restored
# is a hope, not a backup (PROJECT_STATE: "Restore test has not been performed").
#
# Restores into a throwaway PostgreSQL container with no network, capped CPU
# and memory so the live services keep priority, compares it with the live
# database, then deletes the container and its volume. No data leaves the host.
#
# Usage:  scripts/db/restore-test.sh [dump.sql.gz]
#   default dump: the newest nightly postgres-*.sql.gz in $BACKUP_DIR
# Env:    BACKUP_DIR (/opt/backups/techi), LIVE_CONTAINER (techi-platform-postgres-1),
#         DB_USER (techi), DB_NAME (techi), IMAGE (postgres:15-alpine)
# Exit:   0 restore verified, 1 restore failed or does not match.
#
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/backups/techi}"
LIVE="${LIVE_CONTAINER:-techi-platform-postgres-1}"
DB_USER="${DB_USER:-techi}"
DB_NAME="${DB_NAME:-techi}"
IMAGE="${IMAGE:-postgres:15-alpine}"
NAME="techi-restore-test-$(date +%s)"

DUMP="${1:-$(ls -t "$BACKUP_DIR"/postgres-????-??-??_??-??.sql.gz 2>/dev/null | head -1 || true)}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "❌ no dump found"; exit 1; }

# The restore needs roughly the live database's size on the same disk as the
# live PostgreSQL. A full disk would take production down, so: refuse to
# start without that size plus a margin, and stop the copy if free space
# drops below a floor while it runs.
MARGIN_MB="${MARGIN_MB:-1024}"
FLOOR_MB="${FLOOR_MB:-700}"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
[ -d "$DOCKER_ROOT" ] || DOCKER_ROOT=/
# Fails closed: an unreadable size counts as no space at all.
free_mb() {
  local mb
  mb=$(df -Pm "$DOCKER_ROOT" 2>/dev/null | awk 'NR==2 {print $4}')
  case "$mb" in ''|*[!0-9]*) echo 0 ;; *) echo "$mb" ;; esac
}
live_mb=$(( $(docker exec "$LIVE" psql -U "$DB_USER" -d "$DB_NAME" -tAX -c "select pg_database_size(current_database())") / 1048576 ))
if [ "$(free_mb)" -lt $(( live_mb + MARGIN_MB )) ]; then
  echo "❌ not enough disk: $(free_mb) MB free, need $(( live_mb + MARGIN_MB )) MB (database ${live_mb} MB + ${MARGIN_MB} MB margin)"
  exit 1
fi

WATCHDOG_PID=""
cleanup() {
  [ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null || true
  docker rm -f -v "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

started=$(date +%s)
echo "Restore test of $DUMP ($(du -h "$DUMP" | cut -f1))"
gzip -t "$DUMP" || { echo "❌ gzip integrity check failed"; exit 1; }

docker run -d --name "$NAME" --network none --cpus 0.5 --memory 512m \
  -e POSTGRES_PASSWORD=restore-test-only -e POSTGRES_USER=restore_admin "$IMAGE" >/dev/null
# Ready over TCP, not the socket: the image's entrypoint first runs a
# temporary socket-only server for initialisation and then restarts it, so a
# socket check passes too early and the restore would hit the dying server.
ready=0
for _ in $(seq 1 120); do
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -U restore_admin >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo "❌ restore container did not start"; exit 1; }

( while :; do
    if [ "$(free_mb)" -lt "$FLOOR_MB" ]; then
      echo "❌ free disk fell below ${FLOOR_MB} MB — stopping the restore copy to protect the live database"
      docker rm -f -v "$NAME" >/dev/null 2>&1
      exit 0
    fi
    sleep 2
  done ) &
WATCHDOG_PID=$!
disown "$WATCHDOG_PID" 2>/dev/null || true

# pg_dumpall recreates the roles and the database; ignore "already exists"
# for anything the image created itself, count every other error.
errors=$(gunzip -c "$DUMP" | docker exec -i -e PGPASSWORD=restore-test-only "$NAME" psql -h 127.0.0.1 -U restore_admin -d postgres -q -X 2>&1 \
  | grep -E "^(psql:.*)?ERROR" | grep -vc "already exists" || true)
echo "  restore finished in $(( $(date +%s) - started ))s with $errors error(s)"

# Live: the container's local socket (trusted). Restored copy: TCP with its
# throwaway password, since only the restarted server is reachable there.
q_live() { docker exec "$LIVE" psql -U "$DB_USER" -d "$DB_NAME" -tAX -c "$1"; }
q_restored() { docker exec -e PGPASSWORD=restore-test-only "$NAME" psql -h 127.0.0.1 -U restore_admin -d "$DB_NAME" -tAX -c "$1"; }
tables_sql="select string_agg(table_name, ' ' order by table_name) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"
live_tables=$(q_live "$tables_sql")
restored_tables=$(q_restored "$tables_sql")

fail=0
[ "$errors" -eq 0 ] || { echo "❌ restore reported errors"; fail=1; }
live_version=$(q_live "select version_num from alembic_version")
restored_version=$(q_restored "select version_num from alembic_version")
echo "  alembic: live $live_version, restored $restored_version"
# A dump taken before a later migration legitimately lacks that migration's
# tables; only an identical revision must have an identical table list.
same_revision=0
[ "$live_version" = "$restored_version" ] && same_revision=1
if [ "$live_tables" != "$restored_tables" ]; then
  if [ "$same_revision" -eq 1 ]; then
    echo "❌ table lists differ at the same schema revision"; fail=1
  else
    echo "  note: the dump predates migrations after $restored_version; tables they add are expected to be missing"
  fi
fi

# Configuration tables change rarely: they must match exactly unless edited
# since the dump. Telemetry tables only need to be present and populated.
printf '  %-28s %12s %12s\n' table live restored
for t in $live_tables; do
  live_n=$(q_live "select count(*) from \"$t\"")
  rest_n=$(q_restored "select count(*) from \"$t\"" 2>/dev/null || echo missing)
  flag=""
  case "$t" in
    operators|clients|device_groups|teams|vault_credentials|enrollment_tokens|notification_channels|notification_rules)
      [ "$live_n" = "$rest_n" ] || flag="  ← differs (edited since the dump?)";;
    device_heartbeats|device_telemetry|devices)
      [ "$rest_n" != missing ] && [ "$rest_n" -gt 0 ] || { flag="  ← EMPTY"; fail=1; };;
  esac
  if [ "$rest_n" = missing ]; then
    if [ "$same_revision" -eq 1 ]; then flag="  ← MISSING"; fail=1; else flag="  (added by a later migration)"; fi
  fi
  printf '  %-28s %12s %12s%s\n' "$t" "$live_n" "$rest_n" "$flag"
done

echo "  total time $(( $(date +%s) - started ))s"
if [ "$fail" -eq 0 ]; then
  echo "✅ RESTORE VERIFIED: $DUMP"
else
  echo "❌ RESTORE TEST FAILED: $DUMP"
fi
exit "$fail"
