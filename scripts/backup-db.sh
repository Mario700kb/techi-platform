#!/bin/bash
# TECHI Platform — PostgreSQL backup script
# Usage: ./scripts/backup-db.sh
# Recommended cron: 0 3 * * * /opt/techi/techi-platform/scripts/backup-db.sh >> /var/log/techi-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/techi/backups}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/techi/techi-platform/docker-compose.yml}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/techi_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[$(date -Iseconds)] Starting backup..."

docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U "${POSTGRES_USER:-techi}" "${POSTGRES_DB:-techi}" \
    | gzip > "$BACKUP_FILE"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[$(date -Iseconds)] Backup completed: $BACKUP_FILE ($SIZE)"

# Remove backups older than RETENTION_DAYS
REMOVED=$(find "$BACKUP_DIR" -name "techi_*.sql.gz" -mtime +"$RETENTION_DAYS" -print -delete | wc -l)
if [ "$REMOVED" -gt 0 ]; then
    echo "[$(date -Iseconds)] Removed $REMOVED backup(s) older than ${RETENTION_DAYS} days"
fi
