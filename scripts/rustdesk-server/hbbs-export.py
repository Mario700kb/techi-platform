#!/usr/bin/env python3
"""Copy the ID server's (hbbs) peer database for the platform, every 2 minutes.

The backend reads Remote Support IDs and MachineGuids from it
(backend/app/services/hbbs_sync.py). It gets this copy, mounted read-only,
never hbbs's own data directory, which also holds the server's private key.
SQLite's online backup gives a consistent copy while hbbs keeps writing.

Installed on the host by /etc/cron.d/techi-hbbs-export:
  */2 * * * * root /usr/bin/python3 /opt/techi/techi-platform/scripts/rustdesk-server/hbbs-export.py
"""
import os
import sqlite3
import sys

SOURCE = "/opt/techi/rustdesk-server/data/db_v2.sqlite3"
TARGET_DIR = "/opt/techi/hbbs-export"
TARGET = os.path.join(TARGET_DIR, "db_v2.sqlite3")


def main() -> int:
    if not os.path.exists(SOURCE):
        print(f"hbbs database not found: {SOURCE}", file=sys.stderr)
        return 1
    os.makedirs(TARGET_DIR, mode=0o755, exist_ok=True)
    tmp = TARGET + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    src = sqlite3.connect(f"file:{SOURCE}?mode=ro", uri=True, timeout=10)
    dst = sqlite3.connect(tmp)
    try:
        src.backup(dst)
        dst.execute("PRAGMA journal_mode=DELETE")
    finally:
        dst.close()
        src.close()
    os.chmod(tmp, 0o644)
    os.replace(tmp, TARGET)
    return 0


if __name__ == "__main__":
    sys.exit(main())
