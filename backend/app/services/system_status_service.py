"""System status panel: the real state of TECHI's own services.

Every value comes from a live source: the database round-trip, the alembic
revision, device heartbeats, the agent package manifest, the in-process worker
registry, the nightly-cleanup audit record and the backup directory. When a
value is not known (e.g. no cleanup since the audit log was introduced), the
tile says so instead of guessing. The browser adds the API latency and the
realtime WebSocket tiles itself.
"""
import json
import logging
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Optional

from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from app.core import worker_health
from app.core.config import settings
from app.core.time import ensure_utc, utcnow
from app.models.audit_log import AuditLog
from app.models.device import Device, DeviceStatus
from app.schemas.system_status import ServiceTile, SystemStatus
from app.services import version_service

logger = logging.getLogger(__name__)

ALEMBIC_INI = Path(__file__).resolve().parents[2] / "alembic.ini"
BACKUP_PATTERN = "postgres-????-??-??_??-??.sql.gz"
# Share of the Windows fleet on the active agent that counts as "synced".
AGENT_SYNC_THRESHOLD = 0.85
# Newest heartbeat older than this, with devices online, means ingest stalled.
HEARTBEAT_STALL = timedelta(minutes=2)
# The nightly jobs run once a day; allow a couple of hours of slack.
NIGHTLY_MAX_AGE = timedelta(hours=26)


def _code_head() -> Optional[str]:
    try:
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        config = Config(str(ALEMBIC_INI))
        config.set_main_option("script_location", str(ALEMBIC_INI.parent / "alembic"))
        return ScriptDirectory.from_config(config).get_current_head()
    except Exception:
        logger.exception("system status: could not read alembic head")
        return None


def database_tile(db: Session) -> ServiceTile:
    try:
        started = time.perf_counter()
        db.execute(text("SELECT 1"))
        latency_ms = round((time.perf_counter() - started) * 1000, 1)
        revision = db.execute(text("SELECT version_num FROM alembic_version")).scalar()
    except Exception as exc:
        logger.exception("system status: database check failed")
        return ServiceTile(key="database", state="down", label="Down", detail="Database not reachable",
                           sub=type(exc).__name__)
    head = _code_head()
    if head is not None and revision != head:
        return ServiceTile(key="database", state="warn", label="Schema", value=latency_ms,
                           detail=f"{latency_ms:g} ms · schema {revision}",
                           sub=f"Code expects {head}: migration pending")
    return ServiceTile(key="database", state="ok", label="Live", value=latency_ms,
                       detail=f"{latency_ms:g} ms · schema {revision}",
                       sub="Schema matches the running code")


def agents_tile(db: Session, now: datetime) -> ServiceTile:
    active = db.query(Device).filter(Device.is_archived.is_(False))
    online = active.filter(Device.status == DeviceStatus.ONLINE).count()
    window = now - timedelta(seconds=settings.HEARTBEAT_TIMEOUT_SECONDS)
    reporting = active.filter(Device.last_seen >= window.replace(tzinfo=None)).count()
    newest = ensure_utc(active.with_entities(func.max(Device.last_seen)).scalar())
    newest_age = (now - newest) if newest else None

    detail = f"{reporting} reporting · last {settings.HEARTBEAT_TIMEOUT_SECONDS // 60} min"
    sub = f"of {online} online" + (f" · last heartbeat {int(newest_age.total_seconds())} s ago" if newest_age is not None else "")
    if online and (newest_age is None or newest_age > HEARTBEAT_STALL):
        return ServiceTile(key="agents", state="down", label="Stalled", detail=detail, sub=sub,
                           value=reporting, total=online)
    return ServiceTile(key="agents", state="ok", label="Live", detail=detail, sub=sub, value=reporting, total=online)


def agent_versions_tile(db: Session) -> ServiceTile:
    latest = version_service.get_active_version("windows")
    if not latest:
        return ServiceTile(key="agent_versions", state="warn", label="Unknown",
                           detail="No active Windows agent package", sub="Activate one under Agent Packages")
    rows = (
        db.query(Device.agent_version, func.count(Device.id))
        .filter(Device.is_archived.is_(False))
        .filter(or_(Device.platform.is_(None), func.lower(Device.platform) == "windows"))
        .group_by(Device.agent_version)
        .all()
    )
    total = sum(count for _, count in rows)
    current = sum(count for version, count in rows
                  if version_service.compare_versions(version, latest) in ("current", "ahead"))
    share = current / total if total else 1.0
    synced = share >= AGENT_SYNC_THRESHOLD
    return ServiceTile(
        key="agent_versions", state="done" if synced else "warn", label="Synced" if synced else "Rolling out",
        detail=f"{current} / {total} on {latest}", sub=f"{round(share * 100)}% of the Windows fleet",
        value=current, total=total,
    )


def workers_tile(now: datetime) -> ServiceTile:
    workers = worker_health.snapshot(now)
    down = [w for w in workers if w["state"] != "ok"]
    running = len(workers) - len(down)
    items = [{"name": w["label"], "state": w["state"]} for w in workers]
    if down:
        first = down[0]
        why = "stopped" if first["reason"] == "stopped" else "has not ticked on time"
        return ServiceTile(key="workers", state="down", label=f"{running} / {len(workers)}",
                           detail=f"{first['label']} {why}", items=items)
    return ServiceTile(key="workers", state="ok", label=f"{running} / {len(workers)}",
                       detail="All background jobs ticking", items=items)


def cleanup_tile(db: Session, now: datetime) -> ServiceTile:
    since = worker_health.cleanup_running_since()
    if since is not None:
        return ServiceTile(key="cleanup", state="running", label="Running", at=since,
                           detail="Removing old heartbeats, telemetry and events")
    last = (
        db.query(AuditLog).filter(AuditLog.action == "nightly_cleanup")
        .order_by(AuditLog.created_at.desc()).first()
    )
    if last is None:
        return ServiceTile(key="cleanup", state="unknown", label="Pending",
                           detail="No run recorded yet", sub="Runs every night at 03:00 UTC")
    details = json.loads(last.details_json or "{}")
    at = ensure_utc(last.created_at)
    failed = details.get("failed_tasks") or []
    rows = details.get("rows_deleted", 0)
    detail = f"{rows:,} rows removed · {details.get('duration_seconds', 0)} s"
    if failed:
        return ServiceTile(key="cleanup", state="warn", label="Partial", at=at, detail=detail,
                           sub=f"Failed: {', '.join(failed)}")
    if now - at > NIGHTLY_MAX_AGE:
        return ServiceTile(key="cleanup", state="warn", label="Late", at=at, detail=detail,
                           sub="Last run is more than a day old")
    return ServiceTile(key="cleanup", state="done", label="Done", at=at, detail=detail,
                       sub="Heartbeats, telemetry, events, old logs")


def backup_tile(now: datetime) -> ServiceTile:
    directory = Path(settings.BACKUP_DIR)
    if not directory.is_dir():
        return ServiceTile(key="backup", state="unknown", label="No access",
                           detail="Backup folder is not mounted", sub=str(directory))
    dumps = sorted(directory.glob(BACKUP_PATTERN), key=lambda p: p.stat().st_mtime)
    if not dumps:
        return ServiceTile(key="backup", state="down", label="Missing", detail="No verified backup found")
    newest = dumps[-1]
    stat = newest.stat()
    at = datetime.fromtimestamp(stat.st_mtime, tz=now.tzinfo)
    size_mb = round(stat.st_size / 1_000_000)
    # The backup script only renames a dump to postgres-*.sql.gz after gzip -t
    # and a minimum-size check pass, so its presence means it was verified.
    detail = f"{size_mb} MB · verified"
    sub = f"{len(dumps)} daily copies kept"
    if now - at > NIGHTLY_MAX_AGE:
        hours = int((now - at).total_seconds() // 3600)
        return ServiceTile(key="backup", state="warn", label="Late", at=at,
                           detail=f"Last backup {hours} h ago", sub="Check the 03:00 backup cron")
    return ServiceTile(key="backup", state="done", label="Done", at=at, detail=detail, sub=sub)


def system_status(db: Session) -> SystemStatus:
    now = utcnow()
    tiles: List[ServiceTile] = [
        database_tile(db),
        agents_tile(db, now),
        agent_versions_tile(db),
        workers_tile(now),
        cleanup_tile(db, now),
        backup_tile(now),
    ]
    return SystemStatus(checked_at=now, services=tiles)
