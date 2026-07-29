#!/usr/bin/env bash
# TECHI Platform — nightly backup (DB + RustDesk keys + compose/env + vault key)
# Deployed at /root/techi-backup.sh, cron: 0 3 * * * /root/techi-backup.sh >> /var/log/techi-backup.log 2>&1
#
# pipefail is load-bearing, not stylistic. In `pg_dumpall | gzip`, gzip exits 0
# even when pg_dumpall dies, so without it a failed dump produces a small but
# apparently-valid .sql.gz — and the retention sweep at the bottom then deletes
# the good backups behind it. The dump is therefore written to a temp file,
# integrity-checked, and only promoted to its final name once known good;
# retention never runs unless a verified dump landed this cycle.
set -euo pipefail

DATE=$(date +%Y-%m-%d_%H-%M)
# Overridable so the failure paths can be exercised against a sandbox
# directory; production leaves it at the default (same convention as
# scripts/backup-db.sh).
BACKUP_DIR="${BACKUP_DIR:-/opt/backups/techi}"
# A healthy dump is ~278 MB compressed (2026-07-29). This floor only has to
# catch empty/truncated output, so keep it far below the real size.
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-10485760}"  # 10 MB
mkdir -p "$BACKUP_DIR"

echo "=== TECHI backup $DATE ==="

# ---------------------------------------------------------------- PostgreSQL
DUMP_FINAL="$BACKUP_DIR/postgres-$DATE.sql.gz"
DUMP_TMP="$DUMP_FINAL.partial"
DUMP_OK=0

# `if !` keeps set -e from aborting before the other artifacts are backed up:
# a dead database must not also cost us the RustDesk keys and the vault key.
if ! docker exec techi-platform-postgres-1 pg_dumpall -U techi | gzip > "$DUMP_TMP"; then
  echo "ERROR: pg_dumpall failed — no usable dump this cycle"
elif ! gzip -t "$DUMP_TMP" 2>/dev/null; then
  echo "ERROR: dump failed gzip integrity check"
else
  DUMP_SIZE=$(wc -c < "$DUMP_TMP")
  if [ "$DUMP_SIZE" -lt "$MIN_DUMP_BYTES" ]; then
    echo "ERROR: dump is only ${DUMP_SIZE} bytes (floor ${MIN_DUMP_BYTES}) — treating as failed"
  else
    mv "$DUMP_TMP" "$DUMP_FINAL"
    DUMP_OK=1
    echo "PostgreSQL dump OK ($(du -h "$DUMP_FINAL" | cut -f1))"
  fi
fi
# Never leave a rejected dump where it could later be mistaken for a good one.
rm -f "$DUMP_TMP"

# ---------------------------------------------------------------- RustDesk keys
tar czf "$BACKUP_DIR/rustdesk-keys-$DATE.tar.gz" \
  /opt/techi/rustdesk-server/data/id_ed25519 \
  /opt/techi/rustdesk-server/data/id_ed25519.pub \
  /opt/techi/rustdesk-server/docker-compose.yml

# ------------------------------------------------- TECHI Platform compose/env
tar czf "$BACKUP_DIR/techi-platform-config-$DATE.tar.gz" \
  /opt/techi/techi-platform/docker-compose.yml \
  /opt/techi/techi-platform/.env

# ------------------------------------------------- Credential Vault master key
# Lives in the backend_data volume; losing it makes every vault secret
# unrecoverable — same disaster class as the RustDesk keys above.
# Resolve the volume mountpoint dynamically so a compose recreation can't
# silently point us at a stale path.
VAULT_VOL_DIR=$(docker volume inspect techi-platform_backend_data --format '{{.Mountpoint}}' 2>/dev/null || true)
VAULT_KEY="$VAULT_VOL_DIR/vault_master.key"
if [ -n "$VAULT_VOL_DIR" ] && [ -f "$VAULT_KEY" ]; then
  tar czf "$BACKUP_DIR/vault-key-$DATE.tar.gz" -C "$VAULT_VOL_DIR" vault_master.key
  chmod 600 "$BACKUP_DIR/vault-key-$DATE.tar.gz"
  # Integrity record: checksum of the raw key inside the archive.
  sha256sum "$VAULT_KEY" | awk '{print $1}' > "$BACKUP_DIR/vault-key-$DATE.sha256"
  echo "Vault master key backed up ($(cat "$BACKUP_DIR/vault-key-$DATE.sha256"))"
else
  # A missing key is expected only before the vault is ever initialized.
  echo "WARNING: vault master key not found (vault not initialized yet?) — skipped"
fi

# ---------------------------------------------------------------- Retention
# Keep daily backup sets for 7 days; preserve manual rollback artifacts.
# Gated on DUMP_OK: if tonight produced no verified dump, deleting week-old
# ones would trade a recoverable failure for an unrecoverable one.
if [ "$DUMP_OK" -eq 1 ]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -mtime +7 \( -name 'postgres-????-??-??_??-??.sql.gz' -o -name 'rustdesk-keys-????-??-??_??-??.tar.gz' -o -name 'techi-platform-config-????-??-??_??-??.tar.gz' -o -name 'vault-key-????-??-??_??-??.tar.gz' -o -name 'vault-key-????-??-??_??-??.sha256' \) -delete
else
  echo "WARNING: retention sweep skipped — keeping every existing backup"
fi

echo "Backup completed: $BACKUP_DIR"
[ "$DUMP_OK" -eq 1 ] || { echo "Backup FAILED: no verified PostgreSQL dump"; exit 1; }
