#!/usr/bin/env python3
"""Remove redundant historical legacy-heartbeat audit rows.

Dry-run is the default. For each device, the first and latest event older than
the cutoff are retained as evidence; recent and unrelated audit rows are never
touched.
"""

import argparse
from datetime import timedelta

from sqlalchemy import bindparam, text

from app.core.time import utcnow
from app.db.session import SessionLocal


ACTION = "agent_heartbeat_legacy_accepted"


def redundant_ids(db, *, older_than_hours: int) -> list[int]:
    cutoff = utcnow() - timedelta(hours=older_than_hours)
    rows = db.execute(
        text(
            """
            WITH ranked AS (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY entity_id ORDER BY created_at ASC, id ASC
                       ) AS first_rank,
                       row_number() OVER (
                           PARTITION BY entity_id ORDER BY created_at DESC, id DESC
                       ) AS latest_rank
                FROM audit_logs
                WHERE action = :action
                  AND entity_type = 'device'
                  AND entity_id IS NOT NULL
                  AND created_at < :cutoff
            )
            SELECT id FROM ranked
            WHERE first_rank > 1 AND latest_rank > 1
            ORDER BY id
            """
        ),
        {"action": ACTION, "cutoff": cutoff},
    )
    return [int(row[0]) for row in rows]


def cleanup(db, *, older_than_hours: int, execute: bool) -> int:
    ids = redundant_ids(db, older_than_hours=older_than_hours)
    if execute and ids:
        db.execute(
            text("DELETE FROM audit_logs WHERE id IN :ids").bindparams(
                bindparam("ids", expanding=True)
            ),
            {"ids": ids},
        )
        db.commit()
    return len(ids)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--older-than-hours", type=int, default=24)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.older_than_hours < 1:
        parser.error("--older-than-hours must be at least 1")

    db = SessionLocal()
    try:
        count = cleanup(
            db,
            older_than_hours=args.older_than_hours,
            execute=args.execute,
        )
    finally:
        db.close()
    mode = "deleted" if args.execute else "dry-run"
    print(f"mode={mode} action={ACTION} redundant_rows={count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
