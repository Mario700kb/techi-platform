#!/usr/bin/env bash
set -e

DATE=$(date +%Y-%m-%d_%H-%M)
BACKUP_DIR="/opt/backups/techi"
mkdir -p "$BACKUP_DIR"

echo "=== TECHI backup $DATE ==="

# PostgreSQL dump
docker exec techi-platform-postgres-1 pg_dumpall -U techi | gzip > "$BACKUP_DIR/postgres-$DATE.sql.gz"

# RustDesk keys/config
tar czf "$BACKUP_DIR/rustdesk-keys-$DATE.tar.gz" \
  /opt/techi/rustdesk-server/data/id_ed25519 \
  /opt/techi/rustdesk-server/data/id_ed25519.pub \
  /opt/techi/rustdesk-server/docker-compose.yml

# TECHI Platform compose/env
tar czf "$BACKUP_DIR/techi-platform-config-$DATE.tar.gz" \
  /opt/techi/techi-platform/docker-compose.yml \
  /opt/techi/techi-platform/.env

# Credential Vault master key (Platform Expansion Phase 4).
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

# Keep last 14 days
find "$BACKUP_DIR" -type f -mtime +14 -delete

echo "Backup completed: $BACKUP_DIR"
